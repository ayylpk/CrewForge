// ============================================================
// fileTools.ts —— T7b 工位文件工具（read/write/edit）+ 工具循环（9/8）
//
//   用户拍板范围：只有 backend/frontend 两个开发工位用；目的=读写更准、修错更省
//   （修一个报错从"整文件重吐"降级为"edit 补一段"）。架构师/PM/测试不碰。
//
//   核心规矩：
//     ① write/edit 是**唯一交付通道**——内容先过闸门（T1 编译 + 前端幻觉闸，由调用方注入），
//       绿了才落盘；红了错误原文作为**工具结果**喂回模型（"自修"的终形态：不用重吐整文件）
//     ② 文件级互斥锁：同一路径的 read-modify-write 串行（不同路径照常并行）——
//       双工位互踩（§5-P2）的泛化治理；edit 在锁内重读当前盘上内容再替换（防踩最新版）
//     ③ 循环终止=机械判定：目标文件成功落地即结束（不依赖模型说"我做完了"）
//     ④ 旁路：tool_mode 关 / 端点不支持工具 / 循环异常 → 调用方退回单发老路
//       （[[crewforge-code-over-tools]]：闸刀/计数/终止全代码，LLM 只在工具上使手艺）
// ============================================================

import fs from "node:fs";
import { SystemMessage, ToolMessage, HumanMessage } from "@langchain/core/messages";
import { checkFile, buildKnown, type GateKnown } from "./checkers";
import { writeWorkspace } from "./common";
import { projectDir } from "./runEnv";
import { invokeWithTimeout } from "./llm";

/** 工具执行上下文：一次文件作业（一个目标文件）的共享状态 */
export interface ToolExecCtx {
    pid: number | null;
    written: Map<string, string>;    // 本任务内存层（生成一个补一个，read 优先看这里）
    planned: string[];               // 任务文件清单（import 存在性核验用）
    /** 前端注入的额外闸门（TDesign 幻觉核验）；返回错误短句列表 */
    extraGate?: (filePath: string, content: string) => Promise<string[]>;
    /** p3 修④（9/9）：技术基线禁用包清单（从契约解析），随 write/edit 过闸 */
    banned?: string[];
    landed: string | null;           // 目标文件成功落盘后的最终内容（机械终止信号）
}

/** 给模型看的五件套声明（JSON Schema 手拼——OpenAI function-calling 通用形状，deepseek/openai 两路都吃）
 *  p3 复盘扩具（9/9）：三件套的短板=没眼睛——模型只能按精确路径猜世界。加 ls（目录树）+ grep（全树搜） */
export const FILE_TOOLS = [
    {
        name: "read", code: "",
        description: "读取项目产物树中的一个已有文件全文（≤20k 字符）。需要看契约/路由/兄弟文件的真实内容时用；不要凭想象引用。",
        parameters: {
            type: "object",
            properties: { path: { type: "string", description: "项目相对路径，如 frontend/src/utils/request.ts" } },
            required: ["path"],
        },
    },
    {
        name: "ls", code: "",
        description: "列出项目文件树（可按目录前缀过滤，如 \"backend/src\"）。写代码前先看清楚盘上有什么，不要发明路径。",
        parameters: {
            type: "object",
            properties: { prefix: { type: "string", description: "可选：目录/路径前缀过滤，空则列全树（上限 200 条）" } },
            required: [],
        },
    },
    {
        name: "grep", code: "",
        description: "在全树源码里搜一段文本（不区分大小写，子串匹配），返回 路径:行号:内容 列表（≤30 条，每行截 120 字符）。查\"这个函数/接口/字段哪里定义的、别人怎么调的\"用它。",
        parameters: {
            type: "object",
            properties: { pattern: { type: "string", description: "要搜的字面文本" } },
            required: ["pattern"],
        },
    },
    {
        name: "write", code: "",
        description: "整文件写入目标文件（创建或完整覆盖）。内容会先过编译校验：不通过则拒绝落盘并把错误返回给你。只有 write 成功返回才算交付。",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "必须是本次任务的目标文件路径" },
                content: { type: "string", description: "文件完整内容（不是片段，不含 Markdown 围栏）" },
            },
            required: ["path", "content"],
        },
    },
    {
        name: "edit", code: "",
        description: "对已存在文件做精确小补丁：把 old_text 一次性替换成 new_text（必须在文件中唯一，除非 replace_all=true）。常用于修复闸门报出的那一处错误，省整文件重写的 token。替换结果同样过校验，不过则不落盘。",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string" },
                old_text: { type: "string", description: "要替换的原文片段（逐字一致，含缩进）" },
                new_text: { type: "string" },
                replace_all: { type: "boolean", description: "多处相同片段时设 true" },
            },
            required: ["path", "old_text", "new_text"],
        },
    },
];

/** 工具循环的 system 尾协议（追加在工位既有提示词之后） */
export const TOOL_PROTOCOL = `
## 文件工具协议（本轮交付唯一通道）
- 五个工具：ls / grep / read（查证，全树只读）+ write（整文件交付）/ edit（小补丁，只限目标文件）。
- 动笔前先查证：拿不准盘上有什么就 ls；要引用别人的文件先 grep/read 看清真实路径与导出，禁止凭想象 import。
- write/edit 成功返回 = 文件已编译校验通过并落盘，这就是完成；不要再输出解释文本。
- 收到「闸门拒绝」的工具结果：优先 edit 只改报错处；结构性问题才 write 重写。
- 除目标文件外禁止 write/edit 任何其他文件（引擎件 router/main/app.js 连 read 也只读不改）。`;

// ---------- 文件级互斥锁（同路径串行，不同路径并行） ----------

const chains = new Map<string, Promise<unknown>>();
export function withPathLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const tail = chains.get(key) ?? Promise.resolve();
    const run = tail.then(fn, fn);                                   // 上游失败不截断链
    const swallow = run.then(() => {}, () => {});                    // 链尾吞错误，防 unhandled
    chains.set(key, swallow);
    void swallow.then(() => { if (chains.get(key) === swallow) chains.delete(key); });   // 排空即清理，防 Map 长胖
    return run;
}

// ---------- 工具执行器（纯代码：沙箱路径 + 闸门 + 落盘 + 锁） ----------

/** 统一结果形态：ok=false 时 result 是给模型看的错因（工具不抛异常——异常也变材料） */
export interface ToolOutcome { ok: boolean; result: string }

function fileKnownView(ctx: ToolExecCtx): GateKnown {
    const root = ctx.pid != null ? projectDir(ctx.pid) : null;
    return buildKnown(root, ctx.written, ctx.planned);
}

function readViaCtx(ctx: ToolExecCtx, path: string): string | null {
    if (ctx.written.has(path)) return ctx.written.get(path)!;
    if (ctx.pid == null) return null;
    // 沙箱（9/9 补洞）：write 侧一直有 writeWorkspace/safeRealPath 挡逃逸，读口原先裸奔——
    // ../ 上跳或绝对路径能摸到产物树外（别的项目/.env）。内存层查过再拦，盘上层只许树内路径
    const clean = path.replace(/\\/g, "/");
    if (clean.startsWith("/") || /^[a-zA-Z]:/.test(clean) || clean.split("/").includes("..")) return null;
    try {
        const full = projectDir(ctx.pid) + "/" + clean;
        return fs.existsSync(full) ? fs.readFileSync(full, "utf-8") : null;
    } catch { return null; }
}

/** 过闸门（T1 编译 + p3 修④技术基线禁用包 + 调用方附加闸）；返回错误列表，空=绿 */
async function gateContent(ctx: ToolExecCtx, path: string, content: string): Promise<string[]> {
    const problems = await checkFile(path, content, fileKnownView(ctx), ctx.banned);
    if (ctx.extraGate) problems.push(...await ctx.extraGate(path, content));
    return problems;
}

export async function executeFileTool(ctx: ToolExecCtx, targetFile: string, name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    const path = String(args.path ?? "").trim().replace(/\\/g, "/");
    // ls/grep 的 schema 里没有 path 参数（一个吃 prefix 一个吃 pattern），统一闸不许罩它们——
    // p4 实战血案（9/9）：185 次"空 path 拒"全是误伤，模型按 schema 正确调用却被反复打回，烧光轮次击毙 6 个文件
    if (!path && name !== "ls" && name !== "grep") return { ok: false, result: "path 不能为空" };

    if (name === "read") {
        const content = readViaCtx(ctx, path);
        if (content == null) return { ok: false, result: `文件不存在：${path}（先 ls/grep 查证盘上有什么，别引用没登记的文件）` };
        return { ok: true, result: content.length > 20_000 ? content.slice(0, 20_000) + "\n…（截断）" : content };
    }

    if (name === "ls") {
        // prefix 缺省时认 path（模型常把目录填进 path——顺着它，别打回）
        const prefix = String(args.prefix ?? path ?? "").trim().replace(/\\/g, "/").toLowerCase();
        const all = fileKnownView(ctx).list();
        const hit = (prefix ? all.filter(p => p.toLowerCase().startsWith(prefix)) : all).slice(0, 200);
        return { ok: hit.length > 0, result: hit.length ? hit.join("\n") : "（没有匹配的文件）" };
    }

    if (name === "grep") {
        const pattern = String(args.pattern ?? "").trim();
        if (!pattern) return { ok: false, result: "pattern 不能为空" };
        const known = fileKnownView(ctx);
        const needle = pattern.toLowerCase();
        const pool = known.list().filter(p => /\.(ts|tsx|js|jsx|mjs|vue|json|md|sql|html|yml|yaml|css|prisma)$/i.test(p));
        const hits: string[] = [];
        let scanned = 0;
        for (const p of pool) {
            if (hits.length >= 30 || scanned >= 400) break;            // 双上限：命中 30 行或扫 400 文件即收
            const src = known.read(p);
            if (!src) continue;
            scanned++;
            if (!src.toLowerCase().includes(needle)) continue;
            const rows = src.split(/\r?\n/);
            for (let i = 0; i < rows.length && hits.length < 30; i++) {
                if (rows[i]!.toLowerCase().includes(needle)) hits.push(`${p}:${i + 1}: ${rows[i]!.trim().slice(0, 120)}`);
            }
        }
        return { ok: hits.length > 0, result: hits.length ? hits.join("\n") : `没搜到「${pattern}」（换个关键词，或先 ls 看树）` };
    }

    if (name === "write") {
        const content = String(args.content ?? "");
        if (!content.trim()) return { ok: false, result: "content 为空：write 要整文件完整内容" };
        if (path !== targetFile) return { ok: false, result: `越界：你只负责 ${targetFile}，不许写 ${path}（登记制铁律）` };
        const problems = await gateContent(ctx, path, content);
        if (problems.length > 0) return { ok: false, result: `闸门拒绝（未落盘）：${problems.join("；").slice(0, 600)}\n用 edit 修对应位置，或修正后重新 write。` };
        return withPathLock(path, async () => {
            writeWorkspace(path, content);
            ctx.written.set(path, content);
            if (path === targetFile) ctx.landed = content;
            return { ok: true, result: `已落盘 ${path}（${content.length} 字符，编译校验通过）` };
        });
    }

    if (name === "edit") {
        const oldText = String(args.old_text ?? "");
        const newText = String(args.new_text ?? "");
        const replaceAll = args.replace_all === true;
        if (!oldText) return { ok: false, result: "old_text 为空：edit 需要逐字一致的锚点片段" };
        if (path !== targetFile) return { ok: false, result: `越界：你只负责 ${targetFile}，不许改 ${path}` };
        return withPathLock(path, async () => {
            // 锁内重读当前盘上/内存内容——补丁永远打在最新版上（防排队期间被人抢写）
            const current = readViaCtx(ctx, path);
            if (current == null) return { ok: false, result: `文件不存在：${path}（新文件请直接 write 整文件）` };
            const hits = current.split(oldText).length - 1;
            if (hits === 0) return { ok: false, result: `old_text 在 ${path} 中找不到（锚点必须逐字一致含缩进；先 read 拿现状再 edit）` };
            if (hits > 1 && !replaceAll) return { ok: false, result: `old_text 在 ${path} 出现 ${hits} 处不唯一：加长锚点上下文，或明确 replace_all=true` };
            const patched = replaceAll ? current.split(oldText).join(newText) : current.replace(oldText, () => newText);
            const problems = await gateContent(ctx, path, patched);
            if (problems.length > 0) return { ok: false, result: `闸门拒绝（补丁未落盘）：${problems.join("；").slice(0, 600)}` };
            writeWorkspace(path, patched);
            ctx.written.set(path, patched);
            if (path === targetFile) ctx.landed = patched;
            return { ok: true, result: `已修补并落盘 ${path}（1 处，校验通过）` };
        });
    }

    return { ok: false, result: `未知工具 ${name}（只有 read/ls/grep/write/edit）` };
}

// ---------- 工具循环骨架（终止=机械判定） ----------

export interface ToolJobOpts {
    system: string;                    // 工位提示词+契约+任务+文件上下文（调用方拼好，老路同源）
    targetFile: string;
    ctx: ToolExecCtx;
    maxRounds: number;                 // 单文件在制轮次（替代老路的 attempt 名额）
    timeoutMs: number;                 // 每轮调用超时（llm 总闸内计时）
    label: string;
    /** 轮执行器注入：默认走真模型；冒烟塞假模型脚本 */
    round?: (messages: any[], sig: AbortSignal) => Promise<any>;
    /** 真模型的 invoke（带工具声明）由调用方给（models 构造器已吃 tools 声明） */
    invoke?: (messages: any[], sig: AbortSignal) => Promise<any>;
}

/**
 * 一个目标文件的工具作业循环。返回 landed 内容（成功）或 null（轮次耗尽/模型放弃）。
 * 抛异常=端点不支持工具/网络炸——调用方捕获后退老路（tool_mode 旁路的落点）。
 */
export async function runToolFileJob(opts: ToolJobOpts): Promise<string | null> {
    const messages: any[] = [new SystemMessage(opts.system)];
    let nudges = 0;
    for (let round = 1; round <= opts.maxRounds; round++) {
        const res = await invokeWithTimeout(`${opts.label} 工具轮${round}`, opts.timeoutMs, sig =>
            opts.round ? opts.round(messages, sig) : (opts.invoke?.(messages, sig) ?? Promise.reject(new Error("工具循环缺 invoke/round"))));
        messages.push(res);
        const calls: any[] = res?.tool_calls ?? [];
        for (const tc of calls) {
            const out = await executeFileTool(opts.ctx, opts.targetFile, String(tc.name ?? ""), (tc.args ?? {}) as Record<string, unknown>);
            messages.push(new ToolMessage({ content: out.result.slice(0, 4000), tool_call_id: String(tc.id ?? tc.name ?? round) }));
            if (!out.ok) console.log(`[fileTools] ${opts.targetFile} 工具 ${tc.name} 红：${out.result.slice(0, 120)}`);
        }
        if (opts.ctx.landed != null) return opts.ctx.landed;        // 机械终止：落地=完成
        if (calls.length === 0) {
            // 模型交白卷（只说话不调工具）：一次提醒，再犯判失败——不让它用嘴交付
            if (++nudges > 1) return null;
            messages.push(new HumanMessage("目标文件尚未通过 write/edit 落盘。请调用工具交付（write 整文件，或 edit 修补丁），文本回复不算完成。"));
        }
    }
    return null;   // 轮次耗尽：调用方按文件失败走既有返工链
}
