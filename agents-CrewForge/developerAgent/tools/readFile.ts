// tools/readFile.ts —— 读取生成项目内的文件内容
// 只读；读取范围限 projectDir 内（不给控制平面留读口）。
//
// ★ 9/15 截断改造：加 offset / limit 参数（按行续读，含行号）。
//   动因：结果进模型上下文会被 clipForModel 头尾裁剪（8192 字符），
//   模型需要一条"从哪继续读"的出路——原来只有 maxBytes 字节口径的整读，
//   被裁后只能整文件重读一遍（r4 里 103 次 readFile 的贡献因素之一）。
//   offset/limit 与 maxBytes 互斥优先：给了 offset 或 limit 就走行模式。
//
// ★ 9/18 去重改造（搬运④，见 tools/readDedup.ts）：同一 (路径, 读取形状) 且文件
//   mtime/字节数都没变 → 只回 stub，正文不重发。动因是实测：那一轮 s1-crud-min
//   299 次工具调用里 readFile 占 235 次（79%）、writeFile 只有 9 次——
//   "读 → 撑大上下文 → 压缩 → 看不见了 → 再读"的自喂循环把预算烧光了。
//   要正文时带 force:true 强制重读（上下文被压缩挤掉时的逃生门）。
import { num, str } from "./registry";
import type { ToolContext, ToolResult, ToolSpec } from "./registry";
import { markObserved } from "./observedFiles";
import {
    readUnchangedText, rememberRead, shouldAnswerUnchanged, signatureKey,
    type ReadSignature,
} from "./readDedup";

const DEFAULT_MAX_BYTES = 256 * 1024;

export const readFileTool: ToolSpec = {
    name: "readFile",
    description:
        "读取生成项目内的文件内容（相对项目根路径）；可用 offset/limit 按行续读（结果带行号）。"
        + "同一文件同一范围且未改动过时只回一行提示（正文不重发）——需要正文请带 force:true",
    parameters: {
        path: { type: "string", required: true, description: "相对项目根的路径" },
        offset: { type: "number", required: false, description: "起始行号（1 起）；给出即按行读取，结果带行号" },
        limit: { type: "number", required: false, description: "读取行数；省略 = 读到文件末尾" },
        maxBytes: { type: "number", required: false, description: `最多读取字节数（整读模式），默认 ${DEFAULT_MAX_BYTES}` },
        force: { type: "boolean", required: false, description: "true = 无视去重，强制回正文（上下文被压缩挤掉后再看一遍用）" },
    },
    async run(ctx: ToolContext, args): Promise<ToolResult> {
        const target = str(args, "path");
        if (!target) return { ok: false, output: "path 不能为空" };
        const force = args["force"] === true;

        // 行模式：offset/limit 任一给出即触发（offset 缺省为 1）
        const hasOffset = args["offset"] !== undefined;
        const hasLimit = args["limit"] !== undefined;
        const lineMode = hasOffset || hasLimit;

        // 读取形状：形状不同 = 内容不同，绝不能互相顶替
        const sig: ReadSignature = lineMode
            ? {
                mode: "lines",
                maxBytes: null,
                offset: hasOffset ? num(args, "offset", 1) : 1,
                limit: hasLimit ? num(args, "limit", 0) : null,
            }
            : { mode: "full", maxBytes: num(args, "maxBytes", DEFAULT_MAX_BYTES), offset: null, limit: null };
        const sigKey = signatureKey(sig);

        // 先拿元数据（stat 失败 = 文件不存在/读不出去，交给下面真的读一遍去报错，不在这里吞掉）
        let mtimeMs: number | null = null;
        let bytesNow = 0;
        try {
            const st = ctx.workspace.stat(target);
            mtimeMs = st.mtimeMs;
            bytesNow = st.size;
        } catch { /* 拿不到元数据就不去重，走完整读取 */ }

        // ★ 去重命中：正文不重发，直接把"内容还在上文里"告诉模型（claude-code file_unchanged 同款）
        if (!force && mtimeMs !== null
            && shouldAnswerUnchanged({ taskId: ctx.taskId, owner: ctx.owner, path: target, sigKey, mtimeMs, bytes: bytesNow })) {
            // 命中也是"看过这个文件"——先读后改闸照旧放行
            markObserved(ctx.taskId, ctx.owner, target);
            // 去重命中记账（只读工具的返回不进 completed_tool_call，不记这里就量不到效果）
            ctx.note?.("read_dedup_hit", { path: target, sigKey });
            return {
                ok: true,
                output: readUnchangedText(target),
                meta: { path: target, unchanged: true, forceAvailable: true },
            };
        }

        if (lineMode) {
            const r = ctx.workspace.readLines(
                target,
                hasOffset ? num(args, "offset", 1) : 1,
                hasLimit ? num(args, "limit", 0) : undefined,
            );
            const more = r.startLine > r.totalLines
                ? `（offset=${r.startLine} 超出文件末尾：共 ${r.totalLines} 行）`
                : r.endLine < r.totalLines
                    ? `\n…（共 ${r.totalLines} 行；续读：offset=${r.endLine + 1}）`
                    : `\n…（共 ${r.totalLines} 行，已到末尾）`;
            // ★ 搬运③：行模式读取同样计入"已观察"（读到多少算多少，与 claude-code 的
            //   isPartialView 语义相反——这里放宽，避免续读场景反复拒写）
            markObserved(ctx.taskId, ctx.owner, r.path);
            rememberRead({
                taskId: ctx.taskId, owner: ctx.owner, path: target, sigKey,
                mtimeMs: mtimeMs ?? ctx.workspace.stat(target).mtimeMs,
                bytes: bytesNow || ctx.workspace.stat(target).size,
            });
            return {
                ok: true,
                output: `${r.content}${more}`,
                meta: {
                    path: r.path, startLine: r.startLine, endLine: r.endLine,
                    totalLines: r.totalLines, lineMode: true,
                },
            };
        }

        const r = ctx.workspace.readText(target, num(args, "maxBytes", DEFAULT_MAX_BYTES));
        // ★ 搬运③：成功读取 = 该文件进入本任务的"已观察"表（writeFile 先读后改闸的数据源）
        markObserved(ctx.taskId, ctx.owner, r.path);
        rememberRead({
            taskId: ctx.taskId, owner: ctx.owner, path: target, sigKey,
            mtimeMs: mtimeMs ?? ctx.workspace.stat(target).mtimeMs,
            bytes: bytesNow || ctx.workspace.stat(target).size,
        });
        const output = r.truncated
            ? `${r.content}\n…（已截断；文件共 ${r.bytes} 字节）`
            : r.content;
        return { ok: true, output, meta: { path: r.path, bytes: r.bytes, truncated: r.truncated } };
    },
};
