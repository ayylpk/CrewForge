// ============================================================
// graph.ts —— Developer 的 LangGraph 图（**写死**，不可从外部增删）
//
//   节点（固定，顺序即规格）：
//     receiveTask → inspectProject → loadContext → bootstrapOrImplement
//     → runLocalChecks → requestTest → handleTestResult → repair → requestTest → developerReady
//     分批模式（9/15）追加一对暂停/复活节点：
//     bootstrapOrImplement/runLocalChecks → waitBatch →(END，等 architect_batch)→ acceptBatch → loadContext
//   条件分支（真分支全列举，任何外部输入都无法增删）：
//     bootstrapOrImplement → loadContext | runLocalChecks | waitBatch
//     runLocalChecks       → requestTest | repair | developerBlocked | waitBatch
//     handleTestResult     → repair | developerReady | developerBlocked
//     acceptBatch          → loadContext | END（收不到批的防御分支）
//
//   硬约束：
//     · 禁止从数据库/用户输入/配置文件动态添加节点或边；
//     · 禁止使用 GraphFactory 与旧 merger / backendEngineer / frontendEngineer 流程；
//     · LangGraph 只是 Developer **内部**循环，不是 CrewForge 的全局状态真相；
//       Hub 是外部通信层，Ledger 是持久化真相。
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { END, START, StateGraph } from "@langchain/langgraph";
import {
    DeveloperAnnotation, assertStatusTransition, canGoReady, canReserveLlmCall, hasPendingWorkItem,
    isBudgetExceeded, isRepairExhausted, isRepeatedFailure, isStalled, isTimeoutRepeated,
    lastInboundType, nextArrivedWorkItem, nextUnarrivedWorkItem, nextWorkItem, pickSkillForState,
} from "./state";
import type { DeveloperState, DeveloperStatus } from "./state";
import {
    acceptanceHashOf, assertNoAuthorityFields, deriveWorkItems, skillForWorkItem,
    validateTestFailure, validateTestPassed,
} from "./protocol";
import type {
    AcceptanceCheck, ArchitectBatch, ArchitectTask,
    OutboundMessage, TestFailure, TestTrustContext, WorkItemKind,
} from "./protocol";
import type { ReceiveResult } from "./hubAdapter";
import { hashOf, type DeveloperLedger } from "./ledger";
// 脚手架候选（9/15）：stackProfile → 官方脚手架候选清单，空项目初始化加速用
import { scaffoldHintFor } from "./scaffold";
import type { ToolArgs, ToolContext, ToolResult, ToolRegistry } from "./tools/registry";
import { DEVELOPER_ROLE_NAME, READONLY_TOOL_NAMES, WRITE_TOOLS, str, strList } from "./tools/registry";
import type { Workspace } from "./workspace";
import { createReadonlySubAgentDispatcher } from "./tools/readonlySubAgent";
import type { ReadonlySubAgentEvidenceInput, ReadonlySubAgentLlm } from "./tools/readonlySubAgent";

// ============================================================
// 命令指纹与超时策略（规格五）
// ============================================================

/** 会在隔离环境里跑东西的工具——超时策略按它分类 */
export const EXEC_TOOL_NAMES: ReadonlySet<string> = new Set([
    "runCommand", "runBuild", "shell", "httpRequest", "startProcess",
]);

/**
 * 指纹里必须带"当前文件快照"的工具。
 * 只给**结果由项目内容决定**的命令（编译/检查/自定义脚本）——
 * 文件没变就别重复跑同一条构建（规格五.4）。
 */
export const SNAPSHOT_KEYED_TOOLS: ReadonlySet<string> = new Set([
    "runCommand", "runBuild", "shell",
]);

/**
 * 永不缓存的工具。理由很直接：
 *   · httpRequest 缓存 = 不再发真实请求 = 伪造验证结果；
 *   · startProcess 缓存 = 服务根本没起；
 *   · readProcess / stopProcess 缓存 = 读不到新增日志 / 停不掉进程；
 *   · delegateReadonly 缓存 = 把**旧快照下**的子 Agent 分析冻成"新鲜结果"——
 *     子 Agent 结果的新鲜度由 subagent_call 表按 (taskId, signature, snapshotHash)
 *     管理（规格六.5），工具层泛型缓存会绕过 staleness 判断，绝不允许。
 */
export const NEVER_CACHE_TOOLS: ReadonlySet<string> = new Set([
    "httpRequest", "startProcess", "readProcess", "stopProcess", "delegateReadonly",
]);

/** 默认超时（规格五.6）：普通命令 2 分钟 / 构建 10 分钟 / 服务 2 分钟 / HTTP 30 秒 */
export const EXEC_TIMEOUT_DEFAULTS: Record<string, number> = {
    runCommand: 120_000,
    shell: 120_000,
    runBuild: 600_000,
    startProcess: 120_000,
    httpRequest: 30_000,
};

/** 人可读的命令签名（TIMEOUT_REPEATED 留痕与对外上报都用它） */
export function commandSignature(tool: string, args: ToolArgs): string {
    const command = str(args, "command") || str(args, "target") || str(args, "url");
    const argv = strList(args, "args").join(" ");
    const cwd = str(args, "cwd");
    return `${tool}:${command}${argv ? ` ${argv}` : ""}${cwd ? ` @${cwd}` : ""}`;
}

/**
 * 工具调用指纹（规格五.2）：
 *   非执行工具 → 工具 + 参数 + taskId（与既有恢复语义完全一致）；
 *   执行工具   → 工具 + command + args + cwd + 当前文件快照。
 */
export function toolCallFingerprint(o: {
    tool: string;
    args: ToolArgs;
    taskId: string;
    snapshotHash?: string;
}): string {
    if (SNAPSHOT_KEYED_TOOLS.has(o.tool)) {
        return hashOf({
            kind: "exec",
            tool: o.tool,
            taskId: o.taskId,
            command: str(o.args, "command"),
            args: strList(o.args, "args"),
            cwd: str(o.args, "cwd"),
            target: str(o.args, "target"),
            url: str(o.args, "url"),
            snapshot: o.snapshotHash ?? "",
        });
    }
    return hashOf({ tool: o.tool, args: o.args, taskId: o.taskId });
}

/** 执行类工具返回的原始证据（原样进 history，编译/启动错误不允许只留摘要） */
export function execEvidence(meta: Record<string, unknown> | undefined): Record<string, unknown> | null {
    if (!meta) return null;
    const keys = [
        "command", "args", "cwd", "exitCode", "timedOut", "durationMs",
        "truncated", "rawOutputPath", "processId", "pid", "killedBy", "killMethod",
        "snapshotBefore", "snapshotAfter", "violations", "envRemoved",
        // ★ 隔离程度是证据的一部分：模型不该把 soft 当"已经隔离好了"
        "realIsolation", "softIsolation", "sandboxMode", "sandboxBackend",
    ];
    const out: Record<string, unknown> = {};
    for (const k of keys) if (meta[k] !== undefined) out[k] = meta[k];
    // ★ 规格四.4：stdout / stderr 的**原文**必须进模型上下文。
    //   只给一句"exit=1"等于把编译错误的根因藏起来，模型只能猜。
    for (const k of ["stdout", "stderr"] as const) {
        const v = meta[k];
        if (typeof v === "string" && v) {
            out[k] = clipForModel({
                tool: "exec", output: v,
                meta: { rawOutputPath: meta["rawOutputPath"] },
            });
        }
    }
    return Object.keys(out).length > 0 ? out : null;
}

// ============================================================
// 工具结果进模型上下文的裁剪（9/15 截断改造）
//
//   旧行为：`output.slice(0, 4000)` —— **静默砍尾**。编译错误的根因（洋葱芯）常在
//   输出尾部，模型看不到就只能重读/重跑，这是 r4 里读重复的一个喂料环。
//
//   四家参考实现（pi / opencode / dsh / claude-code）的一致做法：
//     · 保留头（+尾），绝不静默；明示省略了多少字符；
//     · 给"怎么拿到完整内容"的出路（落盘路径 / offset 续读）。
//   参数对齐 dsh tool-result-pruner：触发 8192 字符，头 4096 + 尾 1024；
//   有 rawOutputPath（执行类工具落盘的全文）时优先给路径，读类工具提示 offset 续读。
// ============================================================

/** 单条工具结果进入模型上下文的上限（字符）；<= 上限原样返回 */
export const MODEL_OUTPUT_LIMIT = 8192;
/** 超限时保留的头部字符数 */
export const MODEL_OUTPUT_HEAD = 4096;
/** 超限时保留的尾部字符数（编译错误的洋葱芯常在这） */
export const MODEL_OUTPUT_TAIL = 1024;

export function clipForModel(o: {
    tool: string;
    output: string;
    meta?: Record<string, unknown> | undefined;
}): string {
    const text = o.output;
    if (text.length <= MODEL_OUTPUT_LIMIT) return text;
    const head = text.slice(0, MODEL_OUTPUT_HEAD);
    const tail = text.slice(-MODEL_OUTPUT_TAIL);
    const omitted = text.length - MODEL_OUTPUT_HEAD - MODEL_OUTPUT_TAIL;
    const raw = typeof o.meta?.["rawOutputPath"] === "string" ? o.meta["rawOutputPath"] : null;
    const hint = raw
        ? `完整输出见 ${raw}`
        : o.tool === "readFile"
            ? "可用 readFile 加 offset（起始行）/limit（行数）继续读取"
            : `原文共 ${text.length} 字符`;
    return `${head}\n\n⋯[中段省略 ${omitted} 字符；${hint}]⋯\n\n${tail}`;
}

/** 单个字符串参数（典型：writeFile 的整文件正文）进模型上下文的上限（字符） */
export const MODEL_ARG_FIELD_LIMIT = 4096;

/**
 * 参数字段裁剪（9/15 批 B）。
 *
 *   缺口：批 A 只给 **结果**（output）加了护栏，**参数**（args）侧此前是**完全没有上限**的
 *   上下文入口。一次 writeFile 的 args.content 就是整个文件正文，它会被
 *   realLlm 的 JSON.stringify(history) 带进**后续每一轮** prompt，而同一轮的
 *   result 里只有"已写入"几个字——几十 KB 进上下文换不来任何新信息，
 *   文件就在磁盘上，模型要读随时 readFile。
 *
 *   做法与 clipForModel 同口径（头尾保留 + 明示省略，不静默），
 *   只裁**超长的字符串字段**；路径 / 命令 / 行号这类短参数原样不动。
 */
export function clipArgsForModel(args: ToolArgs): ToolArgs {
    const out: ToolArgs = {};
    for (const [key, value] of Object.entries(args ?? {})) {
        if (typeof value !== "string" || value.length <= MODEL_ARG_FIELD_LIMIT) {
            out[key] = value;
            continue;
        }
        const half = Math.floor(MODEL_ARG_FIELD_LIMIT / 2);
        const omitted = value.length - half * 2;
        // 防幻觉的关键一句：**调用本身是按完整参数执行的**，被省略的只是"记录里的一段正文"。
        // 不写清楚，模型可能以为"文件只写了一半"而重写整个文件（越压越错）。
        out[key] = `${value.slice(0, half)}\n`
            + `⋯[该参数中段省略 ${omitted} 字符（仅本条记录省略）；调用已按**完整**参数执行，`
            + `文件内容以磁盘为准，需要请 readFile]⋯\n${value.slice(-half)}`;
    }
    return out;
}

// ============================================================
// 历史总量护栏（9/15 批 B）—— 防越窗的确定性压缩，**不是**记忆/摘要
//
//   为什么需要：history 单条有 clipForModel 封顶 8192，但**总量无上限**。
//   条数由 maxSteps 决定（可配，实弹里用到过 30），30 × 8192 ≈ 245K 字符，
//   足够顶爆任何 128K 窗口的模型。越窗 = API 400 = 这一步白烧，连败几次任务就死了。
//
//   口径（对齐四家参考的**确定性层**，零 LLM、零额外请求）：
//     · 触发看**总量字符**——量的就是 realLlm 真正 stringify 发出去的那一份，不估不猜；
//     · 最近 HISTORY_PROTECT_CHARS 个字符**永不折叠**（模型手头的工作集不许被抽走，
//       这是 dsh/opencode/cc 三家共同的红线：cc 原话是"清空全部结果会让模型失去全部工作上下文"）；
//     · 从**最老**的条目开始折，**一旦降到预算内立刻停手**（最小干预；
//       opencode 甚至要求"省下的量不够多就不折"，同一个意思——防过度压缩）；
//     · 被折条目**保留 tool + 参数摘要 + ok**：模型仍知道"我做过什么、成没成"，
//       只是拿不到旧输出的正文——这样它不会误以为"没查过"而重跑，也不会凭空脑补结果；
//     · 折叠**幂等**（打 folded 标记，重复扫描不二次切割）且**明示**（绝不静默）。
//
//   为什么不上 LLM 摘要：那要多一次 API 调用 + 一段延迟，而墙钟 97.8% 本来就在等 LLM。
//   确定性折叠零成本零延迟，先把"越窗"这个硬故障堵上；摘要层等真机数据证明不够再谈。
// ============================================================

/** 历史总字符预算；超过就从最老的条目开始折叠 */
export const HISTORY_BUDGET_CHARS = 96_000;

/**
 * 折叠目标线（9/15 批 E 修正）：超预算时**折到预算的这个比例**，而不是"降到预算即停"。
 *
 *   为什么改：r5 实测 22 次折叠事件，绝大多数只折 1-2 条（"省 662""省 736"）——
 *   最小干预的代价是**折得又碎又勤**，而每次折叠都改动历史前缀 →
 *   整个 prompt 的前缀缓存全线重算（铁证：`cache=39936 → 10240`）。
 *   22 次折叠 = 22 次全量重算，这是 r5 比 r4 慢 5 分钟的直接原因之一。
 *
 *   折到 70% 意味着"一次多折一些，换来更长的免折窗口"：
 *   设每次折叠后距下次触发要再涨 30% 预算（约 2.9 万字符），折叠频率至少减半。
 *   代价是模型更早失去一些老条目的细节——但它们本来就已经被折过一轮了。
 */
export const HISTORY_FOLD_TARGET_RATIO = 0.7;
/** 最近这段字符数永不折叠（从最新一条往回累计；约 4 条满额工具结果） */
export const HISTORY_PROTECT_CHARS = 32_768;
/** 折叠后放在 output 位置的标记文案（模型看得到，明示这里被移除过） */
export const HISTORY_FOLDED_NOTE =
    "[历史折叠] 本条工具结果已从上下文移除（工具名与参数摘要保留）。"
    + "该调用**已经按原样执行过**，改动已落盘——不要因此重做一遍；"
    + "需要这条结果的内容请重新调用该工具，或直接读文件核对。";

export interface HistoryPruneResult {
    /** 本次折叠的条目数 */
    folded: number;
    charsBefore: number;
    charsAfter: number;
}

/** 一条 history 条目的字符数（= realLlm 真正发出去的 JSON 形态） */
function historyEntryChars(entry: unknown): number {
    try { return JSON.stringify(entry)?.length ?? 0; } catch { return 0; }
}

/** 折叠条目里单个字符串参数的保留上限（比 clipArgsForModel 更狠——这里连"记录"都不留全） */
const FOLDED_ARG_FIELD_LIMIT = 200;

/**
 * 折后保留的参数摘要：**逐字段**处理，只压大块字符串。
 *
 *   不能把整个 args 换成一个摘要串——`path` 这类**定位信息**必须原样留住，
 *   否则模型折叠后连"我写过哪个文件 / 在哪个目录跑的"都不知道，
 *   一知半解比不知道更危险（会去猜、去重做）。压掉的只有正文本身。
 */
function foldArgsDigest(args: unknown): unknown {
    if (!args || typeof args !== "object") return args ?? {};
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
        out[key] = typeof value === "string" && value.length > FOLDED_ARG_FIELD_LIMIT
            ? `${value.slice(0, FOLDED_ARG_FIELD_LIMIT)}…（原 ${value.length} 字符，已省略）`
            : value;
    }
    return out;
}

/**
 * 历史总量护栏：超预算时把**最老**的工具结果条目折成骨架（原地修改 history）。
 *
 *   只折"带 tool 字段"的条目——error / reminder 这类小条目承载的是**指令语义**
 *   （比如重复调用提醒），折掉会把刹车片一起拆了，而且它们本来就不占地方。
 */
export function pruneHistory(history: unknown[], o?: {
    budgetChars?: number;
    protectChars?: number;
    /** 折叠目标线比例（缺省 0.7）；显式传 1 即恢复"降到预算即停"的旧行为（测试兼容） */
    foldTargetRatio?: number;
}): HistoryPruneResult {
    const budget = o?.budgetChars ?? HISTORY_BUDGET_CHARS;
    const protect = o?.protectChars ?? HISTORY_PROTECT_CHARS;
    // 折到 target 而不是 budget：一次多折些，换更长的免折窗口（见常量注释）
    const ratio = o?.foldTargetRatio ?? HISTORY_FOLD_TARGET_RATIO;
    const target = Math.max(0, Math.floor(budget * Math.min(1, Math.max(0.1, ratio))));

    let total = 0;
    for (const e of history) total += historyEntryChars(e);
    if (total <= budget) return { folded: 0, charsBefore: total, charsAfter: total };

    // 保护窗：从最新一条往回累计，累计量没超 protect 的条目全部进保护区
    let protectedFrom = history.length;
    let acc = 0;
    for (let i = history.length - 1; i >= 0; i--) {
        acc += historyEntryChars(history[i]);
        if (acc > protect) break;
        protectedFrom = i;
    }

    let folded = 0;
    let chars = total;
    for (let i = 0; i < protectedFrom && chars > target; i++) {
        const raw = history[i];
        if (!raw || typeof raw !== "object") continue;
        const entry = raw as Record<string, unknown>;
        if (typeof entry["tool"] !== "string") continue;      // 只折工具结果
        if (entry["folded"] === true) continue;               // 幂等：已折过的不再动
        const before = historyEntryChars(entry);
        history[i] = {
            tool: entry["tool"],
            args: foldArgsDigest(entry["args"]),
            ok: entry["ok"] === true,
            output: HISTORY_FOLDED_NOTE,
            folded: true,
        };
        chars -= before - historyEntryChars(history[i]);
        folded++;
    }
    return { folded, charsBefore: total, charsAfter: chars };
}

/**
 * 重复调用提醒（9/15 加，参考 dsh repeat-tool-reminder）。
 *
 *   dsh 的语义：参数深度排序后规范化成链、连续计数、命中阈值 [3,5,8] 时注入
 *   **软提醒**（advisory——只提醒，不拦截）。r3 的"12 步墙死循环"（每 loop 重新
 *   勘察→没写完被掐→新 loop 重来）就是缺这个软刹车：模型没有"我在原地打转"的信号。
 *
 *   实现要点：
 *     · 键 = 工具名 + 参数（对象键**深度排序**后 stringify——属性顺序不同视为同一次）；
 *     · 任何一次不同的调用都会重置计数器（连续语义）；
 *     · 阈值命中时往 history 尾部追加一条 reminder（不进 authorities、不占 LLM 台账）。
 */
const REPEAT_REMINDER_THRESHOLDS: readonly number[] = [3, 5, 8];

/** 参数规范化键：对象键递归排序后 JSON（属性顺序不敏感） */
export function canonicalArgsKey(args: ToolArgs): string {
    const sort = (v: unknown): unknown => {
        if (Array.isArray(v)) return v.map(sort);
        if (v && typeof v === "object") {
            const o = v as Record<string, unknown>;
            const out: Record<string, unknown> = {};
            for (const k of Object.keys(o).sort()) out[k] = sort(o[k]);
            return out;
        }
        return v;
    };
    return JSON.stringify(sort(args ?? {}));
}

export function repeatReminderText(tool: string, args: ToolArgs, streak: number): string {
    const detail = streak >= 5 ? `（参数：${JSON.stringify(args).slice(0, 500)}）` : "";
    return `[重复调用提醒] 你已连续 ${streak} 次以相同参数调用「${tool}」${detail}。`
        + "如果这条路走不通，请换一种做法（改参数 / 换工具 / 先读证据再动手），不要原样重复。";
}

/**
 * 超时延长的唯一裁决点（规格五.7）。
 *   ① 只有执行类工具能延长；
 *   ② 必须 `timeoutReason` 非空；
 *   ③ **同一条命令只许延长一次**（按 fingerprint 记账，落 Ledger）。
 */
export function checkTimeoutExtension(o: {
    tool: string; args: ToolArgs; ledger: DeveloperLedger; taskId: string;
}): { allowed: true; record?: { fingerprint: string; reason: string } } | { allowed: false; result: ToolResult } {
    const def = EXEC_TIMEOUT_DEFAULTS[o.tool];
    const requested = typeof o.args["timeoutMs"] === "number" ? o.args["timeoutMs"] as number : Number.NaN;
    if (def === undefined || !Number.isFinite(requested) || requested <= def) return { allowed: true };

    const { timeoutMs: _t, timeoutReason: _r, ...restArgs } = o.args;
    const fingerprint = hashOf({ ext: o.tool, args: restArgs, taskId: o.taskId });
    const reason = str(o.args, "timeoutReason").trim();

    if (!reason) {
        return {
            allowed: false,
            result: {
                ok: false,
                output: `拒绝：把 ${o.tool} 的超时从 ${def}ms 延长到 ${requested}ms 必须给出 timeoutReason（延长原因要能被审计）`,
                rejected: {
                    code: "TIMEOUT_EXTENSION_DENIED", target: o.tool,
                    message: "延长超时未说明原因",
                },
            },
        };
    }
    if (!o.ledger.recordTimeoutExtension(fingerprint, reason)) {
        return {
            allowed: false,
            result: {
                ok: false,
                output: `拒绝：同一条命令只允许延长一次超时（fingerprint=${fingerprint}，此前已延长）`,
                rejected: {
                    code: "TIMEOUT_EXTENSION_DENIED", target: o.tool,
                    message: "该命令已延长过一次超时",
                },
            },
        };
    }
    o.ledger.appendEvent("timeout_extended", { tool: o.tool, fingerprint, reason, from: def, to: requested });
    return { allowed: true, record: { fingerprint, reason } };
}

/**
 * 带指纹缓存的工具调用（规格五.3）。
 * runToolLoop 与 runLocalChecks 共用这一份实现，免得两处缓存口径不一致。
 *
 * ★ 9/15 修（只读缓存快照 bug，r4 实弹立案）：
 *   指纹缓存干了两件事，对只读工具**第二件有害**：
 *     ① 崩溃恢复的"已完成的副作用不重放"——对写/执行工具是安全保证，保留；
 *     ② 同 run 内的"结果复用"——对只读工具省的是毫秒（readFile 实测 0.004s），
 *        换来的是**模型拿旧快照做决策**：r4 里 103 次 readFile 只有 19 个不同参数，
 *        84 次命中旧缓存，模型发现内容与磁盘不一致后被迫用 shell/node -e 绕过核实
 *        （20 次），并自述"readFile 有缓存复用，需要核实"（llm#127/#128）。
 *   四家参考实现（pi / opencode / dsh / claude-code）的读工具**一律真读**，无结果缓存层。
 *   所以：只读工具（READONLY_TOOL_NAMES）直接从缓存面摘除——不查表、不写表、真读。
 *   写/执行工具的缓存语义不变（快照键控保证正确性）。
 */
export async function invokeWithFingerprintCache(o: {
    tools: ToolRegistry;
    ctx: ToolContext;
    ledger: DeveloperLedger;
    tool: string;
    args: ToolArgs;
    /** 预取的文件快照哈希（执行类工具用；不传则内部取一次） */
    snapshotHash?: string;
}): Promise<{
    result: ToolResult;
    fingerprint: string;
    cached: boolean;
    timeoutExtension?: { fingerprint: string; reason: string };
}> {
    const needsSnapshot = SNAPSHOT_KEYED_TOOLS.has(o.tool);
    const snapshotHash = needsSnapshot
        ? (o.snapshotHash ?? o.ctx.workspace.sourceSnapshot().hash)
        : undefined;
    const fingerprint = toolCallFingerprint({
        tool: o.tool, args: o.args, taskId: o.ctx.taskId,
        ...(snapshotHash !== undefined ? { snapshotHash } : {}),
    });

    // ★ 只读工具永不复用旧结果：新鲜度 > 毫秒级节省。指纹仍算出来（记账/去重统计用），
    //   只是不参与缓存命中判定，也不写入 completed_tool_call。
    const isReadonly = READONLY_TOOL_NAMES.includes(o.tool);
    const cacheable = !isReadonly && !NEVER_CACHE_TOOLS.has(o.tool);
    if (cacheable) {
        const hit = o.ledger.cachedToolCall(fingerprint);
        if (hit) {
            o.ledger.appendEvent("tool_call_reused", {
                tool: o.tool, fingerprint, reason: "同一文件快照下的重复成功检查",
            });
            return {
                cached: true,
                fingerprint,
                result: {
                    ok: hit.ok,
                    output: `${hit.output}\n[缓存复用] 文件快照未变化，本次没有重复执行（fingerprint=${fingerprint}）`,
                    ...(hit.meta && typeof hit.meta === "object"
                        ? { meta: hit.meta as Record<string, unknown> }
                        : {}),
                },
            };
        }
    }

    // 真要跑了才裁决超时延长（缓存命中不算"跑"）
    const gate = checkTimeoutExtension({
        tool: o.tool, args: o.args, ledger: o.ledger, taskId: o.ctx.taskId,
    });
    if (!gate.allowed) return { result: gate.result, fingerprint, cached: false };

    const result = await o.tools.invoke(o.tool, o.ctx, o.args);
    // ★ 只有**真的跑出结果**的执行才值得缓存。
    //   被超时杀掉 / 因越界被杀的命令没有结果可复用——缓存它会让下一轮"秒回一个超时"，
    //   既掩盖了"这条命令其实一直没跑成功"，也让 TIMEOUT_REPEATED 的计数失去意义。
    const worthCaching = cacheable
        && result.meta?.["timedOut"] !== true
        && result.meta?.["killedBy"] !== "violation";
    if (worthCaching) {
        o.ledger.recordToolCallOnce(fingerprint, o.tool, result.ok, result.output, result.meta);
    } else if (cacheable) {
        o.ledger.appendEvent("tool_call_not_cached", {
            tool: o.tool, fingerprint,
            reason: String(result.meta?.["timedOut"] === true ? "命令超时，无结果可复用" : "命令因越界被终止"),
        });
    }
    return {
        result, fingerprint, cached: false,
        ...(gate.record ? { timeoutExtension: gate.record } : {}),
    };
}

// ============================================================
// LLM 边界：一次只决策**下一步**动作，禁止一次吐整个项目
// ============================================================

export interface LlmToolCall {
    tool: string;
    args: Record<string, unknown>;
    note?: string;
}

export interface LlmDecision {
    kind: "tool" | "done" | "batch";
    call?: LlmToolCall;
    /** kind:'batch' 时的只读工具并发批（1 批 = 1 步 = 1 条 llm_call 台账） */
    batch?: LlmToolCall[];
    note?: string;
}

export interface DeveloperLlm {
    readonly id: string;
    /** 真实调用计数（Fake 也计数，便于断言"没有重复烧修复"） */
    calls(): number;
    /** 给定上下文，给出下一步动作；返回值是 unknown，形状校验在本文件内完成 */
    next(input: {
        system: string;
        task: string;
        skill: string | null;
        history: unknown[];
        tools: unknown[];
        /**
         * 预算可见性（9/15 批 E）。**必填**：模型必须能看见自己还剩几步，
         * 否则就会出现 r5 那种"打完 145 调都没发出 test_request"的死法——
         * 不是它不想收尾，是它根本不知道预算要见底了。
         */
        budget: { used: number; total: number };
    }): Promise<unknown>;
}

/** 模型输出 → 决策（形状不对返回 null，由调用方当一步失败处理） */
export function coerceDecision(raw: unknown): LlmDecision | null {
    let v: unknown = raw;
    if (typeof v === "string") {
        try { v = JSON.parse(v); } catch { return null; }
    }
    if (!v || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    const kind = o["kind"];
    if (kind === "done") return { kind: "done", note: str(o, "note") };
    if (kind === "tool") {
        const tool = str(o, "tool");
        if (!tool) return null;
        const rawArgs = o["args"];
        const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
            ? rawArgs as Record<string, unknown>
            : {};
        return { kind: "tool", call: { tool, args, note: str(o, "note") } };
    }
    // ③并行只读批：kind:'batch' + calls[]（fromAnthropicContent 保证全只读才打包）。
    // 防线不止一道：这里再按白名单过滤一遍——混进非只读的批整包判 null（按一步失败计费），
    // 不许靠"上游应该已经挡了"。
    if (kind === "batch") {
        const rawCalls = o["calls"];
        if (!Array.isArray(rawCalls) || rawCalls.length === 0) return null;
        const calls: LlmToolCall[] = [];
        for (const c of rawCalls) {
            if (!c || typeof c !== "object") return null;
            const cc = c as Record<string, unknown>;
            const tool = str(cc, "tool");
            if (!tool || !READONLY_TOOL_NAMES.includes(tool)) return null;
            const rawArgs = cc["args"];
            const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
                ? rawArgs as Record<string, unknown>
                : {};
            calls.push({ tool, args, note: str(cc, "note") });
        }
        return { kind: "batch", batch: calls, note: str(o, "note") };
    }
    return null;
}

// ============================================================
// 工具调用循环（规格第十节）：每轮记录 argumentsHash / resultHash / 退出码 / 改动文件
// ============================================================

export interface ToolLoopResult {
    steps: number;
    /** 已**发起**的 LLM 请求数（= 预占数）；崩溃时它会大于 completed */
    llmCallsPlanned: number;
    /** 已**拿到结果**的请求数 */
    llmCallsCompleted: number;
    /** 工具调用次数 */
    toolCalls: number;
    changedFiles: string[];
    finished: boolean;
    /** 因额度耗尽而提前收工 */
    budgetStopped: boolean;
    /** 规格五.8：同一命令连续超时两次 → 停下来交给外部决定 */
    timeoutRepeated: boolean;
    /** 触发重复超时的命令签名 */
    timeoutSignature: string | null;
    /** 本轮用过的工具调用指纹（进 state.completedToolCalls） */
    fingerprints: string[];
    /** 被批准的语义化超时延长记录 */
    timeoutExtensions: { fingerprint: string; reason: string }[];
    transcript: { tool: string; ok: boolean; output: string }[];
}

export async function runToolLoop(o: {
    llm: DeveloperLlm;
    tools: ToolRegistry;
    ctx: ToolContext;
    ledger: DeveloperLedger;
    system: string;
    task: string;
    skill: string | null;
    maxSteps?: number;
    /** 本轮还允许发起的 LLM 请求数（预占上限）；缺省 = 不限 */
    llmBudget?: number;
    /**
     * LLM 连续失败可容忍次数：第 n+1 次连续失败才向上抛。
     * 缺省 0=一次失败立即抛（规格原语义，崩溃恢复测试钉着这个行为）；
     * 真实网络环境（live runner）建议 2：超时/抖动当一步失败，别打死整个任务。
     */
    llmErrorTolerance?: number;
    /** 写盘工具**真正执行**成功后立即回调（规格四.3：写盘后马上落一次 checkpoint） */
    onWrite?: (info: { tool: string; path: string | null }) => void;
    /**
     * 子 Agent 是否为 LLM 驱动（graph 按接线情况传入）。
     * true 时每一次**新发起**的结构化子 Agent 调用先占一格 LLM 预算（规格九.1）；
     * 去重复用 / 确定性分析不占。
     */
    subagentUsesLlm?: boolean;
}): Promise<ToolLoopResult> {
    const toolDefs = o.tools.describe();
    const history: unknown[] = [];
    const transcript: { tool: string; ok: boolean; output: string }[] = [];
    const changedFiles: string[] = [];
    const fingerprints: string[] = [];
    const timeoutExtensions: { fingerprint: string; reason: string }[] = [];
    const maxSteps = o.maxSteps ?? 12;
    const budget = o.llmBudget ?? Number.POSITIVE_INFINITY;
    const errorTolerance = o.llmErrorTolerance ?? 0;

    let steps = 0;
    let planned = 0;
    let completed = 0;
    let toolCalls = 0;
    let finished = false;
    let budgetStopped = false;
    let llmErrorStreak = 0;
    let timeoutRepeated = false;
    let timeoutSignature: string | null = null;
    /** 同一命令签名的连续超时次数（成功一次就清零） */
    const timeoutCounts = new Map<string, number>();
    /** 规格六.1：一次工具循环最多调用一个子 Agent */
    let subagentInvokedInLoop = false;
    /** 重复调用链（9/15 软提醒）：连续相同键的计数，任何不同的调用把它重置为 1 */
    let repeatKey: string | null = null;
    let repeatStreak = 0;
    /**
     * 记账一次调用并产出（可能的）重复提醒文本。
     * 口径对齐 dsh repeat-tool-reminder：连续计数、参数规范化、命中阈值 [3,5,8] 时
     * 返回一条**软提醒**（只提醒不拦截——拦不拦由模型自己判断，引擎不替它决定）。
     */
    const noteRepeat = (tool: string, args: ToolArgs): string | null => {
        const key = `${tool} ${canonicalArgsKey(args)}`;
        if (key === repeatKey) repeatStreak++;
        else { repeatKey = key; repeatStreak = 1; }
        if (!REPEAT_REMINDER_THRESHOLDS.includes(repeatStreak)) return null;
        o.ledger.appendEvent("repeat_tool_reminder", {
            taskId: o.ctx.taskId, tool, streak: repeatStreak,
        });
        return repeatReminderText(tool, args, repeatStreak);
    };

    while (steps < maxSteps) {
        // ★ 预占额度：先扣再发。崩在请求中途时，planned 已经落账，不会漏计这次调用。
        if (planned + 1 > budget) { budgetStopped = true; break; }
        planned++;
        o.ledger.appendEvent("llm_call_planned", { taskId: o.ctx.taskId, seq: planned });

        // ★ 9/15 批 B：发车前过一遍总量护栏（纯字符计数、零 LLM、零延迟）。
        //   放在这里而不是 push 之后，是因为这是 history **唯一**被送出去的地方——
        //   在这一处设闸，就没有任何路径能绕过它（连错误路径 push 进去的条目也一并受管）。
        const prune = pruneHistory(history);
        if (prune.folded > 0) {
            o.ledger.appendEvent("history_folded", {
                taskId: o.ctx.taskId, seq: planned + 1, folded: prune.folded,
                charsBefore: prune.charsBefore, charsAfter: prune.charsAfter,
            });
        }

        let raw: unknown;
        try {
            raw = await o.llm.next({
                system: o.system, task: o.task, skill: o.skill,
                history, tools: toolDefs,
                // 预算可见性：模型每轮都能看到"已用/总量"，自己决定何时收尾送检。
                // 放在渲染的最末尾（history 之后）→ 稳定段逐字节不变 → 前缀缓存不受影响。
                budget: { used: planned - 1, total: budget },
            });
        } catch (e) {
            // 9/13 T3b 实弹修复：一次超时/网络抖动曾把整个任务打死（failed 还会短路重跑）。
            // 现在按"这一步失败"处理：错误进 history 让模型下一轮自行继续；
            // 连续 3 次才升级成真错误（额度已预占、steps 已计数，不会白转）。
            llmErrorStreak++;
            o.ledger.appendEvent("llm_call_failed", {
                taskId: o.ctx.taskId, seq: planned, streak: llmErrorStreak,
                error: (e as Error).message,
            });
            if (llmErrorStreak > errorTolerance) throw e;
            history.push({ error: `LLM 请求失败：${(e as Error).message}。下一步照常给出决策。` });
            steps++;
            continue;
        }
        completed++;
        llmErrorStreak = 0;
        o.ledger.appendEvent("llm_call_completed", { taskId: o.ctx.taskId, seq: planned });

        // 模型不得输出权威字段（done / verified / status / evidence ...）。
        // ★ 唯一的参数豁免：delegateReadonly 的 args.evidence —— 它只是"分析线索"的
        //   传输字段，不是验收证据；权威口径是**框架注入**（machineEvidenceOf 取
        //   state.lastTestFailure），模型手写的会被剥离并替换，伪造 exitCode 走不通。
        //   剥离之后再过一遍完整权威检查，其余字段一视同仁。
        const preDecision = coerceDecision(raw);
        if (preDecision?.kind === "tool" && preDecision.call?.tool === "delegateReadonly"
            && str(preDecision.call.args, "role").trim() !== "" && "evidence" in preDecision.call.args) {
            delete preDecision.call.args["evidence"];
            o.ledger.appendEvent("subagent_evidence_stripped", {
                taskId: o.ctx.taskId,
                note: "模型手写的 evidence 不予采信；机器证据由框架从 lastTestFailure 注入",
            });
            assertNoAuthorityFields("developer.toolLoop", { kind: "tool", call: preDecision.call });
        } else {
            assertNoAuthorityFields("developer.toolLoop", raw);
        }

        const decision = preDecision;
        if (!decision) {
            // 解析失败**也计费**（规格九）：这次请求已经花掉了
            history.push({ error: "无法解析模型决策（需要 {kind:'tool'|'done'}）" });
            steps++;
            continue;
        }
        if (decision.kind === "done") {
            finished = true;
            break;
        }

        // ③并行只读批：1 批 = 1 步 = 1 条 llm_call 台账，批内并发执行后逐个入账。
        // 只到这一步的必然已过两道白名单（fromAnthropicContent + coerceDecision）。
        if (decision.kind === "batch" && decision.batch && decision.batch.length > 0) {
            const batch = decision.batch;
            const started = batch.map(() => Date.now());
            const settled = await Promise.all(batch.map((c, i) =>
                invokeWithFingerprintCache({
                    tools: o.tools, ctx: o.ctx, ledger: o.ledger, tool: c.tool, args: c.args,
                }).then((r) => ({ i, c, r })),
            ));
            for (const { i, c, r: sr } of settled) {
                const result = sr.result;
                if (!fingerprints.includes(sr.fingerprint)) fingerprints.push(sr.fingerprint);
                const exitCode = typeof result.meta?.["exitCode"] === "number"
                    ? result.meta["exitCode"] as number : null;
                o.ledger.recordToolCall({
                    taskId: o.ctx.taskId, toolName: c.tool, argumentsHash: sr.fingerprint,
                    resultHash: hashOf(result.output), startedAt: started[i]!,
                    finishedAt: Date.now(), exitCode,
                    changedFiles: typeof result.meta?.["path"] === "string"
                        ? [result.meta["path"] as string] : [],
                    ok: result.ok,
                });
                toolCalls++;
                transcript.push({ tool: c.tool, ok: result.ok, output: result.output.slice(0, 2000) });
                // ★ 9/15 截断改造：头尾保留+明示省略（不再静默 slice(0,4000)）
                // ★ 批 B 补 args 侧护栏：writeFile 的整文件正文以前会随每次 stringify 进上下文
                history.push({
                    tool: c.tool, args: clipArgsForModel(c.args), ok: result.ok,
                    output: clipForModel({ tool: c.tool, output: result.output, meta: result.meta }),
                    rejected: result.rejected ?? null,
                });
                const batchReminder = noteRepeat(c.tool, c.args);
                if (batchReminder) history.push({ reminder: batchReminder });
            }
            steps++;
            continue;
        }

        const call = decision.call;
        if (!call) { steps++; continue; }

        // ★ 结构化子 Agent 调用的循环级闸门（规格五 / 六.1 / 九）：
        //   · 一次工具循环最多调用一个子 Agent（六.1）；
        //   · LLM 驱动的子 Agent 占一格 LLM 预算，额度不够就干脆不发（九.1/9.8）。
        //   （同一 failureSignature 只调一次在派发器里按 Ledger 记账，跨循环也有效。）
        if (call.tool === "delegateReadonly" && str(call.args, "role").trim() !== "") {
            let denyReason: string | null = null;
            let denyCode = "";
            if (subagentInvokedInLoop) {
                denyReason = "本轮已调用过一个子 Agent：一次最多调用一个（先消化上一条分析，再决定下一步）";
                denyCode = "SUBAGENT_ONCE_PER_LOOP";
            } else if (o.subagentUsesLlm && planned + 1 > budget) {
                denyReason = "LLM 预算已达上限，本轮不再发起子 Agent 调用";
                denyCode = "SUBAGENT_BUDGET_EXCEEDED";
            }
            if (denyReason) {
                o.ledger.appendEvent("subagent_failed", {
                    taskId: o.ctx.taskId, code: denyCode, reason: denyReason, stage: "tool_loop_gate",
                });
                history.push({
                    tool: call.tool, args: call.args, ok: false, output: denyReason,
                    rejected: { code: denyCode, target: call.tool, message: denyReason },
                });
                transcript.push({ tool: call.tool, ok: false, output: denyReason });
                steps++;
                continue;
            }
        }

        const startedAt = Date.now();
        const sr = await invokeWithFingerprintCache({
            tools: o.tools, ctx: o.ctx, ledger: o.ledger, tool: call.tool, args: call.args,
        });
        const result = sr.result;
        // ★ 子 Agent 记账：本轮已用掉一次子 Agent 名额；LLM 消耗并入总预算（规格六.1 / 九.1）。
        if (result.meta?.["subagent"] === true) {
            subagentInvokedInLoop = true;
            const sPlan = typeof result.meta["llmCallsPlanned"] === "number" ? result.meta["llmCallsPlanned"] as number : 0;
            const sDone = typeof result.meta["llmCallsCompleted"] === "number" ? result.meta["llmCallsCompleted"] as number : 0;
            planned += sPlan;
            completed += sDone;
        }
        if (!fingerprints.includes(sr.fingerprint)) fingerprints.push(sr.fingerprint);
        if (sr.timeoutExtension && !timeoutExtensions.some((x) => x.fingerprint === sr.timeoutExtension!.fingerprint)) {
            timeoutExtensions.push(sr.timeoutExtension);
        }
        const finishedAt = Date.now();
        const resultHash = hashOf(result.output);
        const exitCode = typeof result.meta?.["exitCode"] === "number" ? result.meta["exitCode"] as number : null;
        const touched = typeof result.meta?.["path"] === "string" ? [result.meta["path"] as string] : [];
        if (result.ok) {
            for (const f of touched) if (!changedFiles.includes(f)) changedFiles.push(f);
        }

        o.ledger.recordToolCall({
            taskId: o.ctx.taskId, toolName: call.tool, argumentsHash: sr.fingerprint, resultHash,
            startedAt, finishedAt, exitCode, changedFiles: touched, ok: result.ok,
        });
        toolCalls++;
        // 规格四.3：写盘工具**刚刚真的动了磁盘** → 立刻落一条 checkpoint，
        // 这样"写完文件后被 kill"时恢复点就已经包含这次写盘。
        if (!sr.cached && result.ok && WRITE_TOOLS.has(call.tool)) {
            const written = typeof result.meta?.["path"] === "string" ? result.meta["path"] : null;
            o.onWrite?.({ tool: call.tool, path: written });
        }

        // ★ 规格五.8：同一条命令连续超时两次 → 标记 TIMEOUT_REPEATED 并停手。
        //   连续的意义：中间只要有一条命令正常返回，计数就清零。
        if (EXEC_TOOL_NAMES.has(call.tool)) {
            const sig = commandSignature(call.tool, call.args);
            if (result.meta?.["timedOut"] === true) {
                const n = (timeoutCounts.get(sig) ?? 0) + 1;
                timeoutCounts.set(sig, n);
                if (n >= 2) {
                    timeoutRepeated = true;
                    timeoutSignature = sig;
                    o.ledger.appendEvent("timeout_repeated", { tool: call.tool, signature: sig, count: n });
                    o.ledger.recordFailure({
                        taskId: o.ctx.taskId, attempt: n,
                        signature: `TIMEOUT_REPEATED:${sig}`, category: "BOOT",
                        detail: `同一命令连续超时 ${n} 次，停止重试，交给 TestAgent / Orchestrator 决定下一步`,
                        at: Date.now(),
                    });
                    transcript.push({ tool: call.tool, ok: false, output: `[TIMEOUT_REPEATED] ${sig}` });
                    steps++;
                    break;
                }
            } else {
                timeoutCounts.set(sig, 0);
            }
        }

        transcript.push({ tool: call.tool, ok: result.ok, output: result.output.slice(0, 2000) });
        const evidence = execEvidence(result.meta);
        // ★ 9/15 截断改造：头尾保留+明示省略（不再静默 slice(0,4000)）。
        //   有 rawOutputPath（执行类落盘全文）时给路径，readFile 提示 offset 续读。
        history.push({
            tool: call.tool, args: clipArgsForModel(call.args), ok: result.ok,
            output: clipForModel({ tool: call.tool, output: result.output, meta: result.meta }),
            rejected: result.rejected ?? null,
            ...(evidence ? { evidence } : {}),
        });
        // ★ 9/15 重复调用软提醒（参考 dsh repeat-tool-reminder）：只提醒，不拦截
        const reminder = noteRepeat(call.tool, call.args);
        if (reminder) history.push({ reminder });
        steps++;
    }

    return {
        steps, llmCallsPlanned: planned, llmCallsCompleted: completed, toolCalls,
        changedFiles, finished, budgetStopped, timeoutRepeated, timeoutSignature,
        fingerprints, timeoutExtensions, transcript,
    };
}

// ============================================================
// 依赖与端口
// ============================================================

/** Hub 收发端口（生产用 HubAdapter；测试注入脚本化 Fake） */
export interface MessagePort {
    send(target: string, message: OutboundMessage): unknown;
    receive(): Promise<ReceiveResult>;
}

export interface DeveloperTargets {
    architect: string;
    test: string;
    maintainer: string;
}

export interface DeveloperGraphDeps {
    workspace: Workspace;
    tools: ToolRegistry;
    ledger: DeveloperLedger;
    port: MessagePort;
    llm: DeveloperLlm;
    targets?: Partial<DeveloperTargets>;
    /**
     * 受信的独立 TestAgent 名字（**代码配置**，不来自消息）。
     * 不在名单里的发送者发来的 test_passed / test_failure 一律拒绝。默认空 = 谁也不信。
     */
    trustedTestAgents?: readonly string[];
    /** 只读子 Agent（旧文本通道，可选；未接入时 delegateReadonly 会如实拒绝） */
    analyzer?: (req: { question: string; paths?: string[] }) => Promise<string>;
    /**
     * 结构化只读子 Agent 的 LLM 驱动（可选；不注入 = 确定性零 LLM 分析）。
     * 注入后每次新发起的子 Agent 调用计入 LLM 预算（规格九.1）。
     */
    subagentLlm?: ReadonlySubAgentLlm;
    /** 子 Agent 超时上限（默认 120s，硬夹到 ≤240s=主 Agent 普通调用超时，规格九.3） */
    subagentTimeoutMs?: number;
    /** 每任务子 Agent 调用上限（成本闸，默认 3；同一 failureSignature 恒为 1 次） */
    maxSubagentCalls?: number;
    /** 仅测试用：注入/替换角色分析器（模拟挂起、坏输出等） */
    subagentRunners?: Parameters<typeof createReadonlySubAgentDispatcher>[0]["runners"];
    maxStepsPerLoop?: number;
    maxLlmCalls?: number;
    /** 入口配置的授权根：任务声明只能在其中收窄，**不能扩大** */
    configuredAllowedRoots?: readonly string[];
    /** 等待 TestAgent 结果的时限（毫秒）；过期到达的消息一律拒绝。默认 15 分钟 */
    waitTestTimeoutMs?: number;
    /** LLM 连续失败容忍次数（透传给 runToolLoop；0/缺省=规格原语义，一次失败即抛） */
    llmErrorTolerance?: number;
    /** 仅测试用：覆盖 prompts/skills 目录读取 */
    readTextFile?: (absPath: string) => string;
}

const DEFAULT_TARGETS: DeveloperTargets = {
    architect: "architect",
    test: "testEngineer",
    maintainer: "maintainer",
};

import { NO_BUILD_ENTRY } from "./tools/projectCommands";

const PROMPTS_DIR = path.resolve(import.meta.dir, "prompts");
const SKILLS_DIR = path.resolve(import.meta.dir, "skills");

/** 反规格投机 Skill 的名字（强制注入，不由 workItem 决定） */
export const ANTI_SPEC_GAMING_SKILL = "anti-spec-gaming";

/**
 * 注入标记。测试与审计都认它：
 * 谁改了名字、改了拼接顺序、或把这段 Skill 挪到 task.md 里，anti-spec-gaming.test.ts 立刻红。
 */
export const ANTI_SPEC_GAMING_MARKER = `--- ${ANTI_SPEC_GAMING_SKILL} (mandatory) ---`;

/**
 * 组装 Developer 的 system prompt = 固定规则（system.md）+ **无条件**追加的反投机 Skill。
 *
 *   为什么必须是纯函数：规格要求"每一轮 LLM 输入都带这段规则，且不能被用户 /
 *   数据库 / 任务包覆盖"。靠内联模板字符串是"约定"，靠这个函数 + 单测才是"约束"。
 */
export function composeDeveloperSystemPrompt(baseSystem: string, antiSpecGaming: string): string {
    return `${baseSystem}\n\n${ANTI_SPEC_GAMING_MARKER}\n${antiSpecGaming}`;
}

function defaultRead(absPath: string): string {
    try { return fs.readFileSync(absPath, "utf-8"); } catch { return ""; }
}

/** 修复提示词只关心"能读到的发现"，不关心权威类型——所以收结构子集，单测可直接喂数据 */
export interface ReviewFindingLike {
    severity: string;
    category: string;
    title: string;
    evidence: string[];
    recommendation: string;
}

export interface ReviewInputLike {
    reviewSignals?: readonly ReviewFindingLike[];
    llmReview?: { reviewVerdict: string; confidence: string; findings: readonly ReviewFindingLike[] } | null;
    reviewStatus?: string;
    reviewReason?: string | null;
}

/**
 * 把 TestAgent 的两个来源（确定性预扫信号 + LLM findings）渲染成修复提示词里的一段。
 *
 *   铁律：**全量**。不做 slice、不按严重度过滤、不"总结成三条"——
 *   上游明确要求"findings 必须返回全部发现，不能只返回第一条"。
 *   顺序上把阻断项（critical/major）排在前面，方便 Developer 先修要命的。
 */
export function renderReviewFindings(f: ReviewInputLike | null): string {
    if (!f) return "（本轮没有 TestAgent 失败证据）";
    const all = [...(f.reviewSignals ?? []), ...(f.llmReview?.findings ?? [])];
    if (all.length === 0) {
        if (f.reviewStatus === "LLM_REVIEW_UNAVAILABLE") {
            return `（语义审查不可用：${f.reviewReason ?? "未给原因"}——这不是代码问题，按上面的机械证据处理）`;
        }
        if (f.reviewStatus === "disabled") {
            return "（本轮未启用语义审查——只有机械证据；别把「没审查」当成「没问题」）";
        }
        return "（语义审查未发现额外问题）";
    }
    const rank = (s: string): number => (s === "critical" ? 0 : s === "major" ? 1 : 2);
    const ordered = [...all].sort((a, b) => rank(a.severity) - rank(b.severity));
    return ordered.map((x, i) =>
        `#${i + 1} [${x.severity}/${x.category}] ${x.title}\n`
        + `   证据：${x.evidence.length > 0 ? x.evidence.join("  |  ") : "（未给证据）"}\n`
        + `   建议：${x.recommendation}`,
    ).join("\n");
}

// ============================================================
// 路由（纯函数，零 LLM，可单测）
// ============================================================

export type LocalCheckRoute = "requestTest" | "repair" | "developerBlocked" | "continueWorkItems" | "waitBatch";
export type TestResultRoute = "repair" | "developerReady" | "developerBlocked";

/** 授权路径的规范化比较形式 */
function normRoot(p: string): string {
    return p.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
}

/**
 * 授权范围取交集（规格八）：最终允许范围 = 入口配置 ∩ 任务声明。
 * 任务**只能收窄**，不能靠 architect_task 给自己扩权。
 */
export function intersectRoots(configured: readonly string[], requested: readonly string[]): string[] {
    const allow = new Set(configured.map(normRoot));
    const out: string[] = [];
    for (const raw of requested) {
        const r = normRoot(raw);
        if (allow.has(r) && !out.includes(r)) out.push(r);
    }
    return out;
}

export function routeAfterLocalChecks(state: DeveloperState, maxLlmCalls = 40): LocalCheckRoute {
    if (isBudgetExceeded(state, maxLlmCalls)) return "developerBlocked";
    // 规格五.8：同一命令连续超时两次 → 不再自己重试，交给外部决定
    if (isTimeoutRepeated(state)) return "developerBlocked";
    // ★ 工作项推进优先于修复：本地预检跑的是**整站** build，而工作项是**分阶段**的。
    //   骨架阶段（w1）刚落地时整站 build 必红——那个红不代表"代码写错了"，
    //   只代表"后面的工作项还没做"。这时该继续推进工作项，而不是去修一个尚未实现的模块。
    //   常规路径由 routeAfterImplement 在进入本节点**之前**分流；这里是恢复路径的兜底
    //   （旧 checkpoint 的 resumeNode 可能直接指向 runLocalChecks，带着未完成的工作项）。
    //   预算是硬闸：预占不到额度就不开工，交给下面的 isBudgetExceeded 收口成 blocked。
    if (hasPendingWorkItem(state) && canReserveLlmCall(state, maxLlmCalls)) return "continueWorkItems";
    // ★ 分批总闸（9/15，计划里点名的头号洞）：判据是**随批到达**的，只要还有未达项，
    //   现在这份 acceptanceChecks 就是残缺的——"无 error 就 requestTest" 会把半份验收
    //   送出去（静默欠验收）；带 error 进 repair 也不对（修的不是代码缺陷，是"批没到"）。
    //   放 :1089 之后：有已到未完项且额度够时照常推进（上面已拦），到这里的都是
    //   "没活可干但拆解流还开着"的形态 → 等批。budget/timeout 硬闸仍在最前面先收口。
    if (state.batched && nextUnarrivedWorkItem(state) !== null) return "waitBatch";
    if (!state.error) return "requestTest";
    if (isRepairExhausted(state)) return "developerBlocked";
    // 规格六：上一轮修了但一个文件都没动 → 再修也是原地打转
    if (isStalled(state)) return "developerBlocked";
    return "repair";
}

export type ImplementRoute = "continueWorkItems" | "runLocalChecks" | "waitBatch";

/**
 * 实现节点的**动态**出口（规格七：工作项驱动）。
 *
 * 为什么不能像原来那样写死 `bootstrapOrImplement → runLocalChecks`：
 * 本地预检跑的是**整站** build，而工作项是**分阶段**的。w1 只搭骨架，整站 build 必红——
 * 那个红不代表"写错了"，只代表"后面的工作项还没做"。原结构下一旦进 repair 就再也回不来
 * （repair 的唯一出口是 runLocalChecks），w2…wN 永远轮不到。P1 五车 88 步、71 次工具调用
 * 耗在 repair 里，根因就是这条写死的边。
 *
 * 新语义：**工作项全做完，才跑整站预检**。
 *   · 还有没做完的工作项 + 还有额度 → continueWorkItems（回 loadContext 重挑技能、推进下一项）；
 *   · 预算/超时是硬闸，先拦——此时不推进工作项，交给 runLocalChecks 后的路由收口成 blocked。
 *
 * 分批模式（9/15）在此之上加一层"批到没到"的判断，判定序固定为
 * **budget → timeout → 已到未完项 → 未达项 → 预检**：
 *   · 有已到批的 pending 项且能预占 → continueWorkItems（与旧链路同义——投递严格有序，
 *     resumeWithBatch 的在序闸保证已到集前缀闭合，"已到 pending"与"有未达"不会互相抢）；
 *   · 没批可用但拆解流还开着（存在未达项）→ waitBatch：本项做完≠全站做完，
 *     既不能拿没 detail 的项裸跑，更不能提前送检；
 *   · 预占不到额度**也不许**绕过 waitBatch 落到 runLocalChecks——那是判据未齐送检的侧门。
 * batched=false 时上面这条 if 短路不进，legacy 分支逐字节不变（金标准：tests/graph.test.ts）。
 */
export function routeAfterImplement(state: DeveloperState, maxLlmCalls = 40): ImplementRoute {
    if (isBudgetExceeded(state, maxLlmCalls)) return "runLocalChecks";
    if (isTimeoutRepeated(state)) return "runLocalChecks";
    if (state.batched) {
        if (nextArrivedWorkItem(state) !== null && canReserveLlmCall(state, maxLlmCalls)) return "continueWorkItems";
        if (nextUnarrivedWorkItem(state) !== null) return "waitBatch";
        return "runLocalChecks";
    }
    if (hasPendingWorkItem(state) && canReserveLlmCall(state, maxLlmCalls)) return "continueWorkItems";
    return "runLocalChecks";
}

export function routeAfterTestResult(state: DeveloperState, maxLlmCalls = 40): TestResultRoute {
    const inbound = lastInboundType(state);
    if (inbound === "test_passed") {
        return canGoReady(state) ? "developerReady" : "developerBlocked";
    }
    if (inbound === "test_failure") {
        if (isBudgetExceeded(state, maxLlmCalls)) return "developerBlocked";
        if (isRepeatedFailure(state)) return "developerBlocked";
        if (isRepairExhausted(state)) return "developerBlocked";
        if (isStalled(state)) return "developerBlocked";
        return "repair";
    }
    return "developerBlocked";
}

/**
 * 批次合并（纯函数，acceptBatch 节点与单测共用）——分批模式的数据面。
 *
 *   · detail 只落到目标项（lastWrite 语义：整表返回，别的项一字不动）；
 *   · checks 按 id 去重、**先到者胜**：蓝图的底线判据在前、批次的竖切判据在后，
 *     顺序稳定 → acceptanceHash 稳定；崩溃重放同一批两遍 = 合并一遍（幂等）。
 *   · 这里**不碰** arrivedItems——那是节点的事（reducer 只吃增量）。
 */
export function mergeArchitectBatch(
    state: Pick<DeveloperState, "workItems" | "acceptanceChecks">,
    msg: ArchitectBatch,
): { workItems: DeveloperState["workItems"]; acceptanceChecks: AcceptanceCheck[]; acceptanceHash: string } {
    const workItems = state.workItems.map((w) =>
        w.id === msg.itemId ? { ...w, detail: msg.detail } : w);
    const acceptanceChecks: AcceptanceCheck[] = [];
    const seen = new Set<string>();
    for (const c of [...state.acceptanceChecks, ...msg.checks]) {
        const id = String((c as { id?: unknown }).id ?? "");
        if (seen.has(id)) continue;
        seen.add(id);
        acceptanceChecks.push(c);
    }
    return { workItems, acceptanceChecks, acceptanceHash: acceptanceHashOf(acceptanceChecks) };
}

// ============================================================
// 图构造
// ============================================================

export function buildDeveloperGraph(deps: DeveloperGraphDeps) {
    const targets: DeveloperTargets = { ...DEFAULT_TARGETS, ...(deps.targets ?? {}) };
    /** 受信 TestAgent 名单来自代码配置；默认空 = 谁也不信（安全默认） */
    const trustedTestAgents: readonly string[] = deps.trustedTestAgents ?? [];
    const readText = deps.readTextFile ?? defaultRead;
    const maxLlmCalls = deps.maxLlmCalls ?? 40;
    const maxSteps = deps.maxStepsPerLoop ?? 12;
    const waitTestTimeoutMs = deps.waitTestTimeoutMs ?? 15 * 60_000;

    const send = (target: string, message: OutboundMessage): void => {
        try { deps.port.send(target, message); }
        catch { deps.ledger.appendEvent("send_failed", { target, type: message.type }); }
    };

    /** 强制走迁移表：不允许节点悄悄跳到某个状态 */
    const next = (
        state: DeveloperState, to: DeveloperStatus, patch: Partial<DeveloperState> = {},
    ): Partial<DeveloperState> => {
        assertStatusTransition(state.status, to);
        return { ...patch, status: to };
    };

    // ---------- 只读子 Agent 派发器（tools/readonlySubAgent.ts） ----------
    // ★ 结构收口：分析器运行环境里只有只读工具盒（createReadonlyToolbox 复用同一套白名单），
    //   Workspace 写入口 / Hub / Ledger / DeveloperState 全都不在它手里；
    //   子 Agent 结果的记账（去重、快照绑定、三事件）由这个**主 Agent 侧**的派发器完成。
    const dispatchSubagent = createReadonlySubAgentDispatcher({
        workspace: deps.workspace,
        tools: deps.tools,
        ledger: deps.ledger,
        ...(deps.subagentLlm ? { subagentLlm: deps.subagentLlm } : {}),
        ...(deps.subagentTimeoutMs !== undefined ? { timeoutMs: deps.subagentTimeoutMs } : {}),
        ...(deps.maxSubagentCalls !== undefined ? { maxCallsPerTask: deps.maxSubagentCalls } : {}),
        ...(deps.subagentRunners ? { runners: deps.subagentRunners } : {}),
    });
    /** TestAgent 的机器证据由框架注入给子 Agent——模型自己写的 evidence 只当"未核验声明" */
    const machineEvidenceOf = (state: DeveloperState): ReadonlySubAgentEvidenceInput | undefined => {
        const f = state.lastTestFailure;
        if (!f) return undefined;
        return {
            category: f.category, command: f.command, args: f.args, cwd: f.cwd,
            exitCode: f.exitCode, stdout: f.stdout, stderr: f.stderr,
            affectedFiles: f.affectedFiles, failureSignature: f.failureSignature,
        };
    };

    const ctxOf = (state: DeveloperState): ToolContext => ({
        workspace: deps.workspace,
        owner: "developerAgent",
        role: DEVELOPER_ROLE_NAME,
        taskId: state.taskId,
        // 验收预演（runAcceptance）的两块输入：项目根 + 任务包判据。
        // 只有引擎知道判据原文，模型不该从 history 里回忆——这里如实注入。
        projectDirAbs: state.projectDir,
        acceptanceChecks: state.acceptanceChecks ?? [],
        ...(deps.analyzer ? { analyzer: deps.analyzer } : {}),
        // 主 Agent 唯一能调用子 Agent 的通道；子 Agent 拿不到这个 ctx 本身
        subagent: (req) => dispatchSubagent(state.taskId, req, machineEvidenceOf(state)),
    });

    /**
     * 强制 Skill 的内容：读不到就让**构建**失败，绝不静默降级成"没有规则"。
     *
     *   这是"不允许覆盖 / 不允许剥离"的落点：
     *     · 用户改不了文件（该目录不在任何可写面里）；
     *     · 数据库 / 任务包 / developerInstructions 只能进 task，碰不到 system；
     *     · readTextFile 这个测试注入口若被用来把它读空，构建期直接抛错。
     */
    const forcedSkill = ((): string => {
        const text = readText(path.join(SKILLS_DIR, `${ANTI_SPEC_GAMING_SKILL}.md`));
        if (!text.trim()) {
            throw new Error(
                `强制 Skill 读取失败：skills/${ANTI_SPEC_GAMING_SKILL}.md 为空或不可读。`
                + "反规格投机规则必须无条件注入每轮 system prompt，不允许被静默剥离——请恢复该文件。",
            );
        }
        return text;
    })();

    /** 系统提示词**只能**从这两个文件读，不接受任何入参覆盖 */
    const systemPrompt = (): string =>
        composeDeveloperSystemPrompt(readText(path.join(PROMPTS_DIR, "system.md")), forcedSkill);

    const readSkill = (name: string): string => readText(path.join(SKILLS_DIR, `${name}.md`));

    /**
     * Skill 组合（②技能通用化）：主技能 + 按**层**追加的通用件。
     *
     * 设计口径（9/14 修）：
     *   · 主技能按 workItem.kind 选（WORK_ITEM_SKILL，代码表），**与技术栈无关**——
     *     技能里不再出现 Vue / Spring / pom.xml 这类具体栈名词，栈信息由
     *     StackProfile 走任务模板进入上下文，技能只讲方法；
     *   · 视觉设计指导是**独立的一层**：写前端（或任何有用户界面的活）时追加，
     *     它只增加设计上下文，不改变工具权限、不改变验收规则；
     *   · 曾用 `name !== "frontend-development"` 硬编码判断——那等于把"前端=Vue"
     *     写死在引擎里，换成 React/原生/Django 模板就静默失效。现在按 **kind** 派发。
     */
    const readSkillBundle = (name: string, kind: WorkItemKind | null): string => {
        const primary = readSkill(name);
        // 有用户界面的工作项才追加视觉指导；纯后端/数据库/自检不追加（少烧上下文）
        const wantsDesign = kind === "frontend";
        if (!wantsDesign) return primary;
        return `${primary}\n\n--- frontend-design ---\n${readSkill("frontend-design")}`;
    };

    const fillTemplate = (tpl: string, vars: Record<string, string>): string =>
        tpl.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => vars[key] ?? "");

    const renderTask = (state: DeveloperState, skillName: string, tree: string): string => {
        const tpl = readText(path.join(PROMPTS_DIR, "task.md"));
        const item = state.workItems.find((w) => w.id === state.currentWorkItemId) ?? null;
        const caps = deps.workspace.sandboxCapabilities;
        return fillTemplate(tpl, {
            projectId: state.projectId,
            taskId: state.taskId,
            projectDir: state.projectDir,
            allowedRoots: state.allowedRoots.join(", "),
            requirementSnapshot: JSON.stringify(state.requirementSnapshot ?? null),
            stackProfile: JSON.stringify(state.stackProfile ?? null),
            domainModel: JSON.stringify(state.domainModel ?? null),
            contract: JSON.stringify(state.contract ?? null),
            // foundationPlan 里的 workItems 也是清单副本 → 同规则剥 detail（防同一份详规重复计费）
            foundationPlan: JSON.stringify(state.foundationPlan
                ? { ...state.foundationPlan, workItems: (state.foundationPlan.workItems ?? []).map((w) => ({ ...w, detail: undefined })) }
                : null),
            // ★ 架构师下发的验收要点必须真的进提示词（此前这里是硬编码的 []）
            acceptanceChecks: JSON.stringify(state.acceptanceChecks ?? []),
            // 分批模式（9/15）：清单**剥掉 detail**——每项详规是成百上千字的批次正文，
            // 清单只需要让模型知道"后面还有哪些项"；详规只在做到该项时随 currentWorkItem
            // 进提示词（一次一项，防整包时代那面输出体量墙换个位置在输入侧重演）。
            workItems: JSON.stringify((state.workItems ?? []).map((w) => ({ ...w, detail: undefined }))),
            currentWorkItem: JSON.stringify(item),
            developerInstructions: state.developerInstructions,
            // 官方脚手架候选（9/15）：空项目初始化加速用。栈名只进数据表不进技能；
            // 无候选（未收录栈/无 stackProfile）时是空串，不产生空节、零扰动。
            scaffoldHint: scaffoldHintFor(state.stackProfile),
            // 视觉指导按**工作项 kind** 派发（不是按栈名硬编码）：见 readSkillBundle
            activeSkill: readSkillBundle(skillName, item?.kind ?? null),
            currentTree: tree,
            // ★ 工具清单与执行边界：让模型知道"能跑什么命令、边界在哪"，
            //   而不是靠它猜；边界本身仍在代码里强制。
            toolCatalog: deps.tools.describe().map((t) => `- ${t.name}：${t.description}`).join("\n"),
            capabilities: JSON.stringify({
                sandbox: {
                    mode: caps.mode, backend: caps.backend,
                    realIsolation: caps.realIsolation, softIsolation: caps.softIsolation,
                    boundaries: caps.boundaries, limitations: caps.limitations,
                    networkPolicy: caps.networkPolicy, timeouts: caps.timeouts,
                },
                commands: "命令种类不限（编译器 / 包管理器 / 脚本 / HTTP / 本地服务都可以）",
            }, null, 2),
        });
    };

    const renderRepair = (state: DeveloperState): string => {
        const tpl = readText(path.join(PROMPTS_DIR, "repair.md"));
        const f = state.lastTestFailure;
        // 规格四.5：TestAgent 回来的错误不能只留摘要——这里给足原文，
        // 真超长时也只是截断（并注明），不做"总结成一句人话"这种信息有损处理。
        const RAW_LIMIT = 20_000;
        const clip = (s: string): string => (s.length > RAW_LIMIT
            ? `${s.slice(0, RAW_LIMIT)}\n…[已截断，原文共 ${s.length} 字符]`
            : s);
        // 9/13 两连败教训：**本地预检门禁**失败时 lastTestFailure 为空，
        // 修复模板不能再交白卷——门禁的 error（命令+exit+输出尾部）就是可行动的现场。
        const localGate = !f && !!state.error;
        return fillTemplate(tpl, {
            category: f?.category ?? (localGate ? "COMPILE" : ""),
            command: f?.command ?? (localGate ? "runBuild（本地预检门禁）" : ""),
            args: (f?.args ?? []).join(" "),
            cwd: f?.cwd ?? (localGate ? "frontend / backend（见下方现场）" : ""),
            exitCode: f ? String(f.exitCode) : "",
            failureSignature: f?.failureSignature ?? "",
            affectedFiles: (f?.affectedFiles ?? []).join(", "),
            stdout: clip(f?.stdout ?? (state.error ?? "")),
            stderr: clip(f?.stderr ?? ""),
            allFailures: clip(JSON.stringify(f?.allFailures ?? [], null, 2)),
            // ★ 机械证据（机器产物）与语义审查发现：缺一件，Developer 就只能在信息不全时瞎修
            mechanicalEvidence: clip(JSON.stringify(f?.mechanicalEvidence ?? [], null, 2)),
            reviewFindings: renderReviewFindings(f),
            failureOrigin: f?.origin ?? (localGate ? "local-gate" : "mechanical"),
            reviewStatus: f?.reviewStatus ?? (f ? "disabled" : "n/a"),
            reviewVerdict: f?.llmReview?.reviewVerdict
                ?? (f?.reviewStatus === "LLM_REVIEW_UNAVAILABLE" ? "不可用（未出结论）" : "未审查"),
            reviewConfidence: f?.llmReview?.confidence ?? "-",
        });
    };

    const findArchitectTask = (messages: unknown[]): ArchitectTask | null => {
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i] as { type?: string } | undefined;
            if (m && m.type === "architect_task") return m as unknown as ArchitectTask;
        }
        return null;
    };

    // Skill 调度已搬到 state.ts 的 pickSkillForState()（纯函数、可单测）：
    // 由**结构化工作项**决定，不再看"目录是否为空"。

    // ---------- 节点级 checkpoint（规格四） ----------

    /** 每个节点正常结束后该去哪（作 checkpoint 的 resumeNode；崩溃后从这里接着跑） */
    const NEXT_NODE: Record<string, string> = {
        receiveTask: "inspectProject",
        inspectProject: "loadContext",
        loadContext: "bootstrapOrImplement",
        // 实现节点的真实出口是动态的（可能回 loadContext 推进工作项），
        // 但 checkpoint 只能记一个静态入口：崩在这里就回 bootstrapOrImplement 重跑——
        // 写盘有 completed_tool_call 缓存兜着，不会重复落盘；而 runLocalChecks 会正确分流
        // （工作项没做完就再次回 loadContext），所以从哪条边都收敛。
        bootstrapOrImplement: "bootstrapOrImplement",
        // 预检之后可能回 loadContext（兜底分流），但那是**同一个 run 内**的推进；
        // 崩溃恢复时更该走正常的送检路径——还有工作项的话 routeAfterLocalChecks 会再送回来。
        runLocalChecks: "requestTest",
        requestTest: "handleTestResult",     // 等测试回复的恢复入口
        handleTestResult: "developerReady",
        // 分批（9/15）：等批的恢复入口是收批；收批后正常回上下文重渲染
        waitBatch: "acceptBatch",
        acceptBatch: "loadContext",
        repair: "runLocalChecks",
        developerReady: "developerReady",
        developerBlocked: "developerBlocked",
    };

    const writeCheckpoint = (
        state: DeveloperState, nodeName: string, phase: "enter" | "exit",
        status: string, resumeNode: string | null, patch: Partial<DeveloperState> = {},
    ): void => {
        deps.ledger.writeCheckpoint({
            taskId: state.taskId, node: nodeName, phase, status, resumeNode,
            correlationId: patch.correlationId ?? state.correlationId,
            // 任务上下文指纹 = 验收输入指纹：任务包变了就不能拿旧 checkpoint 续跑
            contextHash: patch.acceptanceHash ?? state.acceptanceHash,
            changedFiles: patch.changedFiles ?? state.changedFiles,
            failureSignatures: patch.failureSignatures ?? state.failureSignatures,
            repairAttempts: patch.repairAttempts ?? state.repairAttempts,
            stalledRepairs: patch.stalledRepairs ?? state.stalledRepairs,
            llmCallsPlanned: patch.llmCallsPlanned ?? state.llmCallsPlanned,
            llmCallsCompleted: patch.llmCallsCompleted ?? state.llmCallsCompleted,
            toolCalls: patch.toolCalls ?? state.toolCalls,
        });
    };

    /** 统一给节点套上「进入前写一条 + 成功后写一条」，不用每个节点手写 */
    const withCheckpoint = (
        name: string,
        fn: (state: DeveloperState) => Promise<Partial<DeveloperState>>,
    ): ((state: DeveloperState) => Promise<Partial<DeveloperState>>) =>
        async (state: DeveloperState) => {
            writeCheckpoint(state, name, "enter", state.status, name);
            const patch = await fn(state);
            writeCheckpoint(state, name, "exit", patch.status ?? state.status, NEXT_NODE[name] ?? name, patch);
            return patch;
        };

    // ---------- 节点 ----------

    const receiveTask = async (state: DeveloperState): Promise<Partial<DeveloperState>> => {
        deps.ledger.enterNode("receiveTask", state.status);
        const task = findArchitectTask(state.messages);
        if (!task) {
            deps.ledger.exitNode("receiveTask", "failed", { reason: "未找到 architect_task" });
            return { status: "failed", error: "receiveTask：消息里没有 architect_task" };
        }
        deps.ledger.exitNode("receiveTask", "inspecting");
        send(targets.architect, {
            type: "developer_started", projectId: task.projectId, taskId: task.taskId, at: Date.now(),
        });
        // 授权收窄：任务声明只能在入口配置范围内取交集（规格八）
        const configured = deps.configuredAllowedRoots ?? state.allowedRoots;
        const effectiveRoots = intersectRoots(configured, task.allowedRoots);
        if (effectiveRoots.length !== task.allowedRoots.length) {
            deps.ledger.appendEvent("allowed_roots_narrowed", {
                configured, requested: task.allowedRoots, effective: effectiveRoots,
            });
        }

        // 结构化工作项（规格七）：优先用任务包声明的；旧任务包只有 dirs 时按映射表推导，
        // 并记一条事件让"推导过"这件事可见——绝不用"目录空不空"猜 Skill。
        const declared = task.foundationPlan?.workItems ?? [];
        const workItems = deriveWorkItems(task.foundationPlan ?? null);
        if (declared.length === 0 && workItems.length > 0) {
            deps.ledger.appendEvent("workitems_derived", {
                fromDirs: task.foundationPlan?.dirs ?? [], derived: workItems.map((w) => w.kind),
            });
        }

        return next(state, "inspecting", {
            projectId: task.projectId,      //项目id
            taskId: task.taskId,            //任务id
            allowedRoots: effectiveRoots,    //允许操作的目录（= 入口配置 ∩ 任务声明，只能收窄）
            requirementSnapshot: task.requirementSnapshot,  //需求快照
            stackProfile: task.stackProfile,    //技术栈
            domainModel: task.domainModel,      //领域模型
            contract: task.contract,    //接口契约
            foundationPlan: task.foundationPlan,    //基础目录计划
            developerInstructions: task.developerInstructions,      //补充说明
            acceptanceChecks: task.acceptanceChecks ?? [],          //验收检查：进 state 才算数
            acceptanceHash: acceptanceHashOf(task.acceptanceChecks ?? []),
            workItems,                                              //结构化工作项：Skill 由它决定
            currentWorkItemId: workItems[0]?.id ?? null,
        });
    };

    const inspectProject = async (state: DeveloperState): Promise<Partial<DeveloperState>> => {
        deps.ledger.enterNode("inspectProject", state.status);
        // withMeta：要的是文件**元数据**（path/size/hash/language），不是全文——
        // 全文会撑爆 state，也没必要：需要内容时再用 readFile 读。
        const res = await deps.tools.invoke("inspectTree", ctxOf(state), { limit: 300, withMeta: true });
        const tree = res.ok ? res.output : "(无法读取文件树)";
        const files = Array.isArray(res.meta?.["files"]) ? res.meta["files"] as DeveloperState["currentFiles"] : [];
        deps.ledger.exitNode("inspectProject", "inspecting", {
            files: res.meta?.["total"] ?? files.length, indexed: files.length,
        });
        return next(state, "inspecting", {
            messages: [{ type: "project_tree", text: tree }],
            currentFiles: files,          // ★ 元数据进 state（Skill 调度与改动判断都用它）
            activeSkill: "inspect-project",
        });
    };

    const loadContext = async (state: DeveloperState): Promise<Partial<DeveloperState>> => {
        deps.ledger.enterNode("loadContext", state.status);
        // ★ 工作项推进回环：loadContext 有两条入边——
        //   ① 初次进入（receiveTask→inspectProject→loadContext）：status 是 inspecting；
        //   ② 工作项推进（bootstrapOrImplement→loadContext）：status 已是 implementing。
        //   迁移表里 implementing→inspecting 不合法（状态不许往回退），所以回环时保持 implementing。
        const back = state.status === "implementing";
        const treeMsg = [...state.messages].reverse().find(
            (m) => (m as { type?: string })?.type === "project_tree",
        ) as { text?: string } | undefined;
        // 初次进入用 inspectProject 刚抓的树；回环时必须**重抓**——
        // 上一次的树是开工前拍的，看不到前一工作项刚写的文件，拿它渲染任务会误导模型。
        // 重抓同时刷新 currentFiles 元数据（只读、确定性，不进 LLM 预算）。
        let tree = treeMsg?.text ?? "";
        let refreshedFiles: DeveloperState["currentFiles"] | null = null;
        if (back) {
            const res = await deps.tools.invoke("inspectTree", ctxOf(state), { limit: 300, withMeta: true });
            tree = res.ok ? res.output : "(无法读取文件树)";
            refreshedFiles = Array.isArray(res.meta?.["files"])
                ? res.meta["files"] as DeveloperState["currentFiles"]
                : [];
        }
        // 规格七：Skill 由**结构化工作项**决定（下一个未完成的工作项）
        const skillName = pickSkillForState(state);
        deps.ledger.exitNode("loadContext", "inspecting", {
            skill: skillName, workItem: state.currentWorkItemId ?? null, refreshedTree: back,
        });
        return next(state, back ? "implementing" : "inspecting", {
            activeSkill: skillName,
            ...(refreshedFiles ? { currentFiles: refreshedFiles } : {}),
            messages: [{ type: "context", system: systemPrompt(), task: renderTask(state, skillName, tree) }],
        });
    };

    const bootstrapOrImplement = async (state: DeveloperState): Promise<Partial<DeveloperState>> => {
        deps.ledger.enterNode("bootstrapOrImplement", state.status);
        const skillName = state.activeSkill ?? pickSkillForState(state);
        const item = state.workItems.find((w) => w.id === state.currentWorkItemId) ?? null;
        const ctxMsg = [...state.messages].reverse().find(
            (m) => (m as { type?: string })?.type === "context",
        ) as { system?: string; task?: string } | undefined;

        // 规格四.3：写盘工具每次真的落盘成功后立刻补一条 checkpoint。
        // （计数类字段仍以节点退出时的 checkpoint 为准，这里补的是"已经动过哪些文件"）
        const writtenSoFar: string[] = [];
        const onWrite = ({ path: written }: { tool: string; path: string | null }): void => {
            if (written && !writtenSoFar.includes(written)) writtenSoFar.push(written);
            writeCheckpoint(state, "bootstrapOrImplement", "exit", "implementing", "bootstrapOrImplement", {
                changedFiles: [...state.changedFiles, ...writtenSoFar],
            });
        };

        const loop = await runToolLoop({
            llm: deps.llm, tools: deps.tools, ctx: ctxOf(state), ledger: deps.ledger,
            system: ctxMsg?.system ?? systemPrompt(),
            task: ctxMsg?.task ?? renderTask(state, skillName, ""),
            skill: readSkillBundle(skillName, item?.kind ?? null),
            maxSteps,
            llmBudget: Math.max(0, maxLlmCalls - state.llmCallsPlanned),
            llmErrorTolerance: deps.llmErrorTolerance,
            onWrite,
            subagentUsesLlm: deps.subagentLlm !== undefined,
        });
        deps.ledger.exitNode("bootstrapOrImplement", "implementing", {
            steps: loop.steps, changed: loop.changedFiles.length, budgetStopped: loop.budgetStopped,
        });
        send(targets.architect, {
            type: "developer_progress", projectId: state.projectId, taskId: state.taskId,
            stage: skillName, note: `${loop.steps} 步 / 改动 ${loop.changedFiles.length} 个文件`,
        });

        // 工作项完成登记：模型自己说 done 且不是被预算掐断 → 这个工作项算做完。
        // 判断依据是"执行结果"，不是"目录里有没有文件"。
        const doneItems = item && loop.finished && !loop.budgetStopped ? [item.id] : [];
        const completedNow = [...state.completedWorkItems, ...doneItems];
        const remaining = state.workItems.find((w) => !completedNow.includes(w.id)) ?? null;

        return next(state, "implementing", {
            llmCallsPlanned: state.llmCallsPlanned + loop.llmCallsPlanned,
            llmCallsCompleted: state.llmCallsCompleted + loop.llmCallsCompleted,
            toolCalls: state.toolCalls + loop.toolCalls,
            changedFiles: loop.changedFiles,
            completedWorkItems: doneItems,
            // 规格五.1/5.8：工具调用指纹与超时状态进 state
            completedToolCalls: loop.fingerprints,
            timeoutRepeated: loop.timeoutRepeated,
            timeoutSignature: loop.timeoutSignature,
            currentWorkItemId: remaining?.id ?? null,
            error: loop.timeoutRepeated ? `TIMEOUT_REPEATED ${loop.timeoutSignature ?? ""}` : state.error,
            messages: [{
                type: "implement_summary", steps: loop.steps, changedFiles: loop.changedFiles,
                finished: loop.finished, workItem: item?.kind ?? null,
                timeoutRepeated: loop.timeoutRepeated, timeoutExtensions: loop.timeoutExtensions,
            }],
        });
    };

    /**
     * 本地自检（9/13 去 Maven 硬编码）：
     *   · 按任务 allowedRoots 遍历 frontend / backend——任务没有某层就跳过，不报错；
     *   · 构建命令由 runBuild → resolveProjectCommand **按工程文件**识别
     *     （mvnw / gradlew / package.json / pyproject / go.mod），引擎不再假设后端是 Java；
     *   · 找不到入口 = NO_BUILD_ENTRY —— 不是编译错误（不进修复回路烧预算），
     *     也**绝不是通过**：记入 state.localChecksUnverified，Ledger / progress /
     *     test_request 三处如实带出，最终 ready 仍只能由外部 TestAgent 的 test_passed 决定。
     */
    const runLocalChecks = async (state: DeveloperState): Promise<Partial<DeveloperState>> => {
        deps.ledger.enterNode("runLocalChecks", state.status);
        const problems: string[] = [];
        const noBuildEntry: string[] = [];
        const ctx = ctxOf(state);
        // 规格五.4：文件没变化就别重复跑相同 build。
        // 快照取一次，两个 target 共用——同一时刻的项目状态只有一个。
        const snapshotHash = deps.workspace.sourceSnapshot().hash;
        const roots = new Set((state.allowedRoots ?? []).map((r) => String(r).replace(/\\/g, "/").replace(/\/+$/, "")));
        const results: { target: string; r: ToolResult; fingerprint: string; skipped?: string }[] = [];
        for (const target of ["frontend", "backend"] as const) {
            if (!roots.has(target)) continue;                        // 任务没声明这一层 → 跳过
            const dirAbs = path.join(state.projectDir, target);
            if (!fs.existsSync(dirAbs)) continue;                    // 目录不存在 → 跳过（不是错误）
            const { result, fingerprint } = await invokeWithFingerprintCache({
                tools: deps.tools, ctx, ledger: deps.ledger,
                tool: "runBuild", args: { target }, snapshotHash,
            });
            results.push({ target, r: result, fingerprint });
            if (result.meta?.["code"] === NO_BUILD_ENTRY) {
                noBuildEntry.push(target);
                deps.ledger.appendEvent("local_check_no_build_entry", {
                    target, code: NO_BUILD_ENTRY,
                    message: "目录中没有可识别的通用工程入口——计为未验证，不是编译错误，也不算通过",
                });
                continue;                                            // 不进编译修复回路
            }
            if (!result.ok) {
                // 真实失败必须带证据（9/13 教训：空证据把 Developer 拖进无解排查）
                const tail = String(result.output ?? "").slice(-1200);
                problems.push(`${target} build 失败（exit=${String(result.meta?.["exitCode"])}）：${tail}`);
            }
        }
        const error = problems.length > 0 ? problems.join("；") : null;
        if (noBuildEntry.length > 0) {
            send(targets.architect, {
                type: "developer_progress", projectId: state.projectId, taskId: state.taskId,
                stage: "local_checks",
                note: `本地预检：${noBuildEntry.join("、")} 没有可识别的工程构建入口（NO_BUILD_ENTRY）——未验证，送检时如实标注`,
            });
        }
        deps.ledger.exitNode("runLocalChecks", error ? "failed" : "ok", {
            error,
            noBuildEntry,
            detectedBy: results.map((x) => x.r.meta?.["detectedBy"] ?? null),
            fingerprints: results.map((x) => x.fingerprint),
            reused: results.map((x) => x.r.output.includes("[缓存复用]")),
        });
        // 自检阶段对应 workItem.kind = pre-test → verification Skill
        return next(state, "implementing", {
            error, activeSkill: skillForWorkItem("pre-test"),
            localChecksUnverified: noBuildEntry,
            completedToolCalls: results.map((x) => x.fingerprint),
        });
    };

    /**
     * 发出 test_request 后**立即退出图**（规格三）：
     * 存状态 → 进 waiting_test → 本次 invoke 正常结束。
     * 绝不在节点里 while 等外部 Agent；TestAgent 回话后由入口校验 correlationId 再恢复。
     */
    const requestTest = async (state: DeveloperState): Promise<Partial<DeveloperState>> => {
        deps.ledger.enterNode("requestTest", state.status);
        // 关联 id：本次测试请求的标识；恢复时靠它分辨"这条消息是不是给这次请求的"
        const correlationId = state.correlationId
            ?? `${state.runId}:${state.taskId}:${Date.now().toString(36)}`;
        // 规格三.10：等待有截止时刻。过这个点到达的结果一律按过期拒绝，
        // "判 blocked"的动作由外部 scheduler / 入口做（图不在这里睡等）。
        const deadlineAt = Date.now() + waitTestTimeoutMs;
        deps.ledger.openTestWait({
            correlationId, acceptanceHash: state.acceptanceHash, deadlineAt,
        });

        const unverified = state.localChecksUnverified ?? [];
        send(targets.test, {
            type: "test_request", projectId: state.projectId, taskId: state.taskId,
            correlationId, acceptanceHash: state.acceptanceHash,
            deadlineAt, targets: ["frontend", "backend"],
            reason: state.error
                ?? (unverified.length > 0
                    ? `本地检查通过（但 ${unverified.join("、")} 无工程构建入口，NO_BUILD_ENTRY=未验证，请外部验收覆盖构建项），请求正式验证`
                    : "本地检查通过，请求正式验证"),
        });

        deps.ledger.exitNode("requestTest", "waiting_test", { correlationId, deadlineAt });
        return next(state, "waiting_test", {
            correlationId, testDeadlineAt: deadlineAt, resumeFrom: "handleTestResult",
        });
    };

    /**
     * 测试结果处理（规格三）：这是**恢复入口**——TestAgent 消息到达后，
     * 入口把消息塞进 state.messages，从本节点重新 invoke，不重跑开发与构建。
     */
    const handleTestResult = async (state: DeveloperState): Promise<Partial<DeveloperState>> => {
        deps.ledger.enterNode("handleTestResult", state.status);
        const inbound = lastInboundType(state);
        let failure: TestFailure | null = null;
        if (inbound === "test_failure") {
            for (let i = state.messages.length - 1; i >= 0; i--) {
                const m = state.messages[i] as { type?: string } | undefined;
                if (m?.type === "test_failure") { failure = m as unknown as TestFailure; break; }
            }
        }
        // 等待窗口关闭：结果已经拿到（无论 pass / fail），这条 correlationId 的等待结束了
        deps.ledger.clearTestWait();
        deps.ledger.exitNode("handleTestResult", "testing", { inbound });
        // 只做判定输入的准备；"能不能修 / 能不能 ready"由后面的条件边算
        return next(state, "testing", { resumeFrom: null, lastTestFailure: failure, testDeadlineAt: null });
    };

    /**
     * 分批模式的"等批"出口（9/15）——requestTest→END 的 waiting_test 同型复刻：
     * 当前项做完了、但架构师还有项没推过来 → 本次 invoke 正常结束，**不睡等、不裸跑、不送检**。
     * 等批**没有截止时刻**（与测试等待的关键差异）：批次是自家 runner 主动拆的活，
     * 真到不了批由外部作废路径收口（index.abortRun），图不自己猜超时。
     * resumeFrom=acceptBatch：批次消息到达后由入口塞进 messages、从这里复活（零重放开发）。
     */
    const waitBatch = async (state: DeveloperState): Promise<Partial<DeveloperState>> => {
        deps.ledger.enterNode("waitBatch", state.status);
        const waitingFor = nextUnarrivedWorkItem(state)?.id ?? null;
        deps.ledger.exitNode("waitBatch", "waiting_item", { waitingFor });
        return next(state, "waiting_item", { resumeFrom: "acceptBatch" });
    };

    /**
     * 分批模式的"收批"入口（9/15）：外部驱动把 architect_batch 塞进 state.messages，
     * 图从本节点复活——handleTestResult 的"收割回 END"同型（倒扫 messages 尾取最新，
     * 消息本体 reducer 已存过，这里**只收割不再追加**）。三条铁律：
     *   ① 合并幂等：崩溃重放会把同一批再喂一遍（runner 重播种），arrivedItems 已含即
     *      no-op 续跑；checks 按 id 去重先到者胜，双保险（mergeArchitectBatch）；
     *   ② 只回 implementing 轨道：waiting_item→implementing 是迁移表里唯一的续工合法行，
     *      想直达 testing/ready 在这里就会被 assertStatusTransition 拦死；
     *   ③ 防御：收不到批次消息就原地回等待态——绝不 failed（错投递不是数据损坏）。
     */
    const acceptBatch = async (state: DeveloperState): Promise<Partial<DeveloperState>> => {
        deps.ledger.enterNode("acceptBatch", state.status);
        let msg: ArchitectBatch | null = null;
        for (let i = state.messages.length - 1; i >= 0; i--) {
            const m = state.messages[i] as { type?: string } | undefined;
            if (m?.type === "architect_batch") { msg = m as unknown as ArchitectBatch; break; }
        }
        if (!msg) {
            // 没有可收割的批（例如拿错 resumeFrom 重进）：原地回等待态等下一次投递
            deps.ledger.exitNode("acceptBatch", "waiting_item", { reason: "messages 里没有 architect_batch 可收割" });
            return next(state, "waiting_item", { resumeFrom: "acceptBatch" });
        }
        if (state.arrivedItems.includes(msg.itemId)) {
            // 重放幂等：这批已收过 → 数据一并不动，只把状态机放回工作轨道
            const keep = nextArrivedWorkItem(state) ?? nextWorkItem(state);
            deps.ledger.exitNode("acceptBatch", "implementing", { itemId: msg.itemId, replayed: true });
            return next(state, "implementing", {
                resumeFrom: "loadContext", currentWorkItemId: keep?.id ?? null,
            });
        }
        const merged = mergeArchitectBatch(state, msg);
        // 当前项指向"最早已到未完项"；理论上必有（刚到批的项就是它），nextWorkItem 只是兜底
        const view = {
            workItems: merged.workItems,
            completedWorkItems: state.completedWorkItems,
            arrivedItems: [...state.arrivedItems, msg.itemId],
        };
        const target = nextArrivedWorkItem(view) ?? nextWorkItem(view);
        deps.ledger.exitNode("acceptBatch", "implementing", {
            itemId: msg.itemId, checks: merged.acceptanceChecks.length,
            acceptanceHash: merged.acceptanceHash,
        });
        // hash 变动必然发生在任何 test_wait 打开之前（A5 不变量）：waiting_item 到不了 requestTest，
        // 送检前所有批必须先到齐（routeAfterLocalChecks 的未达闸）。
        return next(state, "implementing", {
            ...merged,
            // appendUnique reducer 只吃增量：重复投递也污染不了（幂等已在上面拦下）
            arrivedItems: [msg.itemId],
            currentWorkItemId: target?.id ?? null,
            resumeFrom: "loadContext",
        });
    };

    const repair = async (state: DeveloperState): Promise<Partial<DeveloperState>> => {
        deps.ledger.enterNode("repair", state.status);
        const failure: TestFailure | null = state.lastTestFailure;
        const attempt = state.repairAttempts + 1;
        const signature = failure?.failureSignature ?? hashOf(state.error ?? "local-check-failed");
        const category = failure?.category ?? "COMPILE";

        send(targets.architect, {
            type: "repair_started", projectId: state.projectId, taskId: state.taskId,
            failureSignature: signature, attempt,
        });

        const tree = "";
        const loop = await runToolLoop({
            llm: deps.llm, tools: deps.tools, ctx: ctxOf(state), ledger: deps.ledger,
            system: systemPrompt(),
            task: renderRepair(state),
            skill: readSkill("debugging"),
            maxSteps,
            llmBudget: Math.max(0, maxLlmCalls - state.llmCallsPlanned),
            llmErrorTolerance: deps.llmErrorTolerance,
            subagentUsesLlm: deps.subagentLlm !== undefined,
        });

        deps.ledger.recordFailure({
            taskId: state.taskId, attempt, signature, category,
            detail: failure ? `${failure.command} ${failure.args.join(" ")} → exit=${String(failure.exitCode)}` : (state.error ?? ""),
            at: Date.now(),
        });
        // 规格六：同一签名且相关文件**没有变化** → 下一轮应立即停止，不许原地重试
        const stalled = loop.changedFiles.length === 0;
        deps.ledger.exitNode("repair", "repairing", {
            attempt, changed: loop.changedFiles.length, stalled,
        });

        send(targets.architect, {
            type: "repair_finished", projectId: state.projectId, taskId: state.taskId,
            failureSignature: signature, changedFiles: loop.changedFiles,
        });

        return next(state, "repairing", {
            repairAttempts: attempt,
            stalledRepairs: stalled ? state.stalledRepairs + 1 : 0,
            llmCallsPlanned: state.llmCallsPlanned + loop.llmCallsPlanned,
            llmCallsCompleted: state.llmCallsCompleted + loop.llmCallsCompleted,
            toolCalls: state.toolCalls + loop.toolCalls,
            changedFiles: loop.changedFiles,
            failureSignatures: [signature],
            completedToolCalls: loop.fingerprints,
            timeoutRepeated: loop.timeoutRepeated,
            timeoutSignature: loop.timeoutSignature,
            error: null,
            messages: [{
                type: "repair_summary", attempt, signature, changedFiles: loop.changedFiles, tree, stalled,
                timeoutRepeated: loop.timeoutRepeated, timeoutExtensions: loop.timeoutExtensions,
            }],
        });
    };

    const developerReady = async (state: DeveloperState): Promise<Partial<DeveloperState>> => {
        deps.ledger.enterNode("developerReady", state.status);
        if (!canGoReady(state)) {
            // 代码层再拦一道：没有 TestPassed 证据就不许 ready
            deps.ledger.exitNode("developerReady", "blocked", { reason: "缺少 TestPassed 证据" });
            return next(state, "blocked", { error: "ready 条件不满足：缺少 TestPassed 证据" });
        }
        send(targets.maintainer, {
            type: "developer_ready", projectId: state.projectId, taskId: state.taskId,
            changedFiles: state.changedFiles,
            summary: `改动 ${state.changedFiles.length} 个文件，修复 ${state.repairAttempts} 次`,
        });
        deps.ledger.exitNode("developerReady", "ready");
        return next(state, "ready");
    };

    const developerBlocked = async (state: DeveloperState): Promise<Partial<DeveloperState>> => {
        deps.ledger.enterNode("developerBlocked", state.status);
        const fallback = state.timeoutRepeated
            ? `TIMEOUT_REPEATED：命令「${state.timeoutSignature ?? "?"}」连续超时两次，已停止重试`
            : "已达停止条件（重复失败 / 修复次数耗尽 / 预算超限）";
        const reason = state.error ?? fallback;
        send(targets.architect, {
            type: "developer_blocked", projectId: state.projectId, taskId: state.taskId,
            reason, failureSignature: state.lastTestFailure?.failureSignature ?? null,
        });
        deps.ledger.exitNode("developerBlocked", "blocked", {
            reason, timeoutRepeated: state.timeoutRepeated, timeoutSignature: state.timeoutSignature,
        });
        return state.status === "blocked"
            ? { error: reason }
            : next(state, "blocked", { error: reason });
    };

    // ---------- 装配（结构写死；任何外部输入都无法增删节点或边） ----------

    return new StateGraph(DeveloperAnnotation)
        .addNode("receiveTask", withCheckpoint("receiveTask", receiveTask))
        .addNode("inspectProject", withCheckpoint("inspectProject", inspectProject))
        .addNode("loadContext", withCheckpoint("loadContext", loadContext))
        .addNode("bootstrapOrImplement", withCheckpoint("bootstrapOrImplement", bootstrapOrImplement))
        .addNode("runLocalChecks", withCheckpoint("runLocalChecks", runLocalChecks))
        .addNode("requestTest", withCheckpoint("requestTest", requestTest))
        .addNode("handleTestResult", withCheckpoint("handleTestResult", handleTestResult))
        // 分批模式（9/15）的暂停/复活对：waitBatch 出 END 等架构师推批，acceptBatch 收批续跑
        .addNode("waitBatch", withCheckpoint("waitBatch", waitBatch))
        .addNode("acceptBatch", withCheckpoint("acceptBatch", acceptBatch))
        .addNode("repair", withCheckpoint("repair", repair))
        .addNode("developerReady", withCheckpoint("developerReady", developerReady))
        .addNode("developerBlocked", withCheckpoint("developerBlocked", developerBlocked))
        // 入口按状态分派（规格三 + 9/15 分批）：全新任务从 receiveTask 开始；
        // waiting_test（收到测试回复）、waiting_item（收到架构师批次）或显式 resumeFrom
        // （崩溃恢复）从指定节点继续。允许列表覆盖全部节点——checkpoint 的 resumeNode
        // 可能是其中任何一个。
        .addConditionalEdges(START, (s: DeveloperState) =>
            s.resumeFrom ?? (s.status === "waiting_test" ? "handleTestResult"
                : s.status === "waiting_item" ? "acceptBatch" : "receiveTask"),
            [
                "receiveTask", "inspectProject", "loadContext", "bootstrapOrImplement",
                "runLocalChecks", "requestTest", "handleTestResult", "repair",
                "developerReady", "developerBlocked", "waitBatch", "acceptBatch",
            ])
        .addEdge("receiveTask", "inspectProject")
        .addEdge("inspectProject", "loadContext")
        .addEdge("loadContext", "bootstrapOrImplement")
        // 实现节点的出口是**动态**的：还有工作项没做完 → 回 loadContext 推进下一项；
        // 全做完（或预算/超时收紧）→ 才跑整站本地预检。见 routeAfterImplement 的注释。
        .addConditionalEdges("bootstrapOrImplement", (s: DeveloperState) => routeAfterImplement(s, maxLlmCalls), {
            continueWorkItems: "loadContext",
            runLocalChecks: "runLocalChecks",
            waitBatch: "waitBatch",          // 分批：批没到，本项做完就出图（不裸跑下一项）
        })
        // ★ 路径名 → 真实节点：数组型 pathMap 只接受**真实节点名**，
        //   而 "loadContext" 恰好就是真实节点名，所以这里数组写法也能过；
        //   仍用对象写法显式声明，避免"路由名必须等于节点名"这个隐含耦合。
        .addConditionalEdges("runLocalChecks", (s: DeveloperState) => routeAfterLocalChecks(s, maxLlmCalls), {
            requestTest: "requestTest",
            repair: "repair",
            developerBlocked: "developerBlocked",
            continueWorkItems: "loadContext",
            waitBatch: "waitBatch",          // ★ 判据未齐绝不送检/绝不 repair——先等批
        })
        // requestTest 发完就退出本次 invoke（不等外部）；下次由 handleTestResult 入口恢复
        .addEdge("requestTest", END)
        // waitBatch 同理：出图即本次结束，批次到达由入口（index.resumeWithBatch）复活
        .addEdge("waitBatch", END)
        // 收批后正常回 loadContext（重渲染含 detail 的任务书）；防御分支（status 仍
        // waiting_item = 没收到批）直接出图——让它穿 loadContext 会撞上
        // waiting_item→inspecting 的非法迁移，把"错投递"炸成 failed，违反防御语义。
        .addConditionalEdges("acceptBatch", (s: DeveloperState) =>
            s.status === "waiting_item" ? END : "loadContext", [END, "loadContext"])
        .addConditionalEdges("handleTestResult", (s: DeveloperState) => routeAfterTestResult(s, maxLlmCalls), [
            "repair", "developerReady", "developerBlocked",
        ])
        .addEdge("repair", "runLocalChecks")
        .addEdge("developerReady", END)
        .addEdge("developerBlocked", END)
        .compile();
}
