// ============================================================
// contextCompaction.ts —— contextBudget.ts（Claude Code 压缩机制移植）接进 runToolLoop 的接线壳
//
//   为什么单独一层（而不是把逻辑塞进 graph.ts）：
//     · contextBudget.ts 是**逐行移植**的机制（量 / 压 / 保留 / 回灌 / 阈值），它不知道
//       CrewForge 的扁平 history、不知道本仓库的台账事件名、更不知道问人站；
//     · 这一层只做三件事：**喂进去（适配）、判一下（纯函数）、记账（台账）**。
//     · runToolLoop 里只有**一处**调用它（发车前），任何路径都绕不过去——这与它取代的
//       pruneHistory 同款理由：那是 history 唯一被送出去的地方，在那里设闸就没有侧门。
//
//   ★ 被取代的 pruneHistory（9/15 批 B 的字符折叠）**已退役**，理由不是审美：
//     ① 语义冲突：它**原地改 history 中部**（把老条目的 output 换成一段标记）。每折一次，
//        前缀中间就变一段 → 前面所有内容的最长公共前缀全线失效 → 整条 prompt 重算。
//        r5 实测 22 次折叠 = 22 次全量重算（`cache=39936 → 10240`），是 r5 比 r4 慢 5 分钟的
//        直接原因之一（这段证据原本就写在 graph.ts 的常量注释里）。
//        新机制的语义是**整份替换**（cc query.ts:535 `messagesForQuery = buildPostCompactMessages(result)`）：
//        压缩产出"边界标记 + 摘要 + 保留段"这一份**全新的稳定前缀**，并回报 prefixVersion。
//        两种语义并存必然打架——旧折叠会在新前缀背后继续改中部，"稳定前缀"根本不稳，
//        缓存照样重算，两次代价都白付。
//     ② 口径冲突：旧折叠量的是**字符**（HISTORY_BUDGET_CHARS=96_000），新机制量的是 **token**
//        （cc 点名的 CANONICAL 口径 tokenCountWithEstimation）。96_000 字符 ≈ 24K token，
//        在 256K 窗口上是"没到该压的时候" —— 两个坐标系并存时谁先响谁说了算，
//        台账里的数据将无法解释（这正是要退役它、而不是"两个都留着更安全"的原因）。
//
//   ⚠️ 微压缩（时间触发那条）**默认关闭**，本层不替使用者打开：
//     cc 的 timeBasedMCConfig 默认 `enabled:false`，且 microCompact.ts:288-292 的源码注释
//     写明外部构建本来就不做微压缩（"no compaction happens here; autocompact handles
//     context pressure instead"）。移植默认值一字未改 → 要开是**配置决定**：
//     `setTimeBasedMCConfig({ enabled: true })`（或 CF_TENGU_SLATE_HERON）。
//     本层一次都没有碰过它。
//
// ============================================================

import {
    applyCompactionToHistory,
    autoCompactIfNeeded,
    calculateTokenWarningState,
    compactEventPayload,
    getAutoCompactThreshold,
    getBlockingLimit,
    getEffectiveContextWindowSize,
    historyToMessages,
    resolveContextWindow,
    tokenCountWithEstimation,
} from "./contextBudget";
import type {
    AutoCompactTrackingState, CompactHost, ContextWindowSourceKind, ContextWindowSpec, EnvLike,
    RecompactionInfo, RoleTier, SummaryRequest, SummaryResponse,
} from "./contextBudget";

// ============================================================
// §1 窗口基准（**产品接线面**）——引擎今天读什么，以后该读什么
// ============================================================

/**
 * ★ 窗口基准的**唯一事实源**是 `contextBudget.resolveContextWindow()`，
 *   它内部的"没配就用产品默认"这一档（`DEFAULT_CONTEXT_WINDOW_TOKENS = 256_000`，
 *   owner 2026-09-17 拍板，`source:"unset-default"` + degraded + 一行告警）**不在本层重复**。
 *
 *   为什么这个数不能是"一个写死的窗口"：**本部署的窗口是用户填的，而且分档**——
 *   本仓库 `.env` 跑两档：pro 档模型名 `deepseek-v4-pro[1m]` → 1_000_000（模型名自带声明）、
 *   flash 档 `deepseek-v4-flash` → 名字里没有任何窗口信息、只能靠配置。两档差一个数量级，
 *   这正是 owner 决策的原话。所有求值都走 `resolveContextWindow`，本层只负责把
 *   "设置值 + 档位"这两个输入凑齐（见下面的设置契约）。
 *
 *   ⚠️ 风险（模块里已写明，这里再说一次因为它是**操作说明**不是免责声明）：
 *     阈值是窗口的比例 ⇒ 假设**偏大** = 压缩触发过晚 = 一路发到越窗 400；假设偏小只是压得勤。
 *     所以：① `degraded=true` 时本层把告警原文**写进台账**（`context_window_resolved`）——
 *     假设可见，不是偷偷假设；② 填了 `sys_settings.context_window` / 设了
 *     `CF_CONTEXT_WINDOW_TOKENS` 才能关掉 degraded；③ 要"封顶"而不改声明，用
 *     `CLAUDE_CODE_AUTO_COMPACT_WINDOW`（取 min 的闸，任何情况下都生效）。
 */

/**
 * 【设置契约】窗口该怎么读进来（**已落地，见 `developerAgent/index.ts` 的
 * `resolveDeveloperContextWindow`**；DB 两列与设置页 UI 仍是另一件事，见 §1 的说明）
 *
 *   本仓库的运行时设置读取器是 `settings.ts`（sys_settings 单行表，30s TTL 热刷新，
 *   `sys_settings > .env > 内置默认` 的优先级是 v2 拍板的；读不到只 warn、按 .env 继续跑，
 *   配置层是**可观测/可调节层**，不是控制层）。三段各就各位：
 *
 *   ① 表结构（**还没建**，`ALTER TABLE` + 设置页是另一件事）：`sys_settings` 加两列
 *        `context_window        INT NULL`   ← 用户填的**全局基准**（该模型真实最大输入 token）
 *        `context_window_pro    INT NULL`   ← pro 档专用覆盖（与 model_pro 同款"可空=不启用"）
 *      列可空是刻意的：**空 = 没配**，与"配了 0"必须能分开（`resolveContextWindow` 对
 *      `null / "" / "128k"` 这类垃圾值一律当"没配"，在函数内部解析，调用方**不要先转型**——
 *      先转型会把垃圾静默变成 0/NaN）。
 *      **列还没建的那一天也是这条路径**：`readContextWindowColumns(row)`（settings.ts 的纯函数）
 *      对缺列/空值一律给 null → 直接落到 ③④⑤ 步，绝不抛（有单测钉着）。
 *   ② `settings.ts` 的 `RtSettings`：`contextWindow` / `contextWindowPro`（`number | null`），
 *      由 `refreshSettings()` 一处读完（`readContextWindowColumns` 做 `Number(x) || null` 口径），
 *      30 秒热生效，与其它设置同一条路径、同一个旁路原则。
 *   ③ 档位（tier）：`models.ts` 是唯一真相——`resolveRoleTier(role, rt.roleModels)`
 *      + 内置表（architect/test/frontend=pro，backend/pseudo/manager/contracts=flash）。
 *      ⚠️ 同一个 developerAgent 可能以**不同档位**跑（backend=flash / frontend=pro），
 *      所以 tier 由**装配处**解析（`DeveloperAgentOptions.contextBudget.role` 可覆盖角色）。
 *
 *   优先级（`resolveContextWindow` 已实现，全部在模块里，本层不重复实现）：
 *     ① context_window_pro（pro 档）→ settings-tier
 *     ② context_window（全局）      → settings
 *     ③ 模型名自带 [1m]            → model-suffix（1_000_000）
 *     ④ CF_CONTEXT_WINDOW_TOKENS   → env（运维逃生口）
 *     ⑤ 产品默认 256_000           → unset-default（degraded=true，会告警+台账留痕）
 *
 *   ⚠️ 装配处解析好的 spec 请通过 `ContextBudgetOption.window` 传进来（**解析一次**）：
 *   本函数只服务"没有装配处"的调用点（单测、旧调用点），不要在闸内再解析一遍。
 */
export function resolveWiredContextWindow(input: {
    model: string;
    tier?: RoleTier | null;
    /** sys_settings.context_window（管道未做时缺省 = 没配） */
    settingsWindowTokens?: unknown;
    /** sys_settings.context_window_pro（管道未做时缺省 = 没配） */
    settingsWindowProTokens?: unknown;
    env?: EnvLike;
    warn?: (line: string) => void;
}): ContextWindowSpec {
    return resolveContextWindow({
        model: input.model,
        tier: input.tier ?? null,
        contextWindowTokens: input.settingsWindowTokens,
        contextWindowProTokens: input.settingsWindowProTokens,
        env: input.env ?? process.env,
        ...(input.warn ? { warn: input.warn } : {}),
    });
}

/**
 * 从 LLM 客户端的 id 里取模型名（realLlm 的 id 形如 `real:<model>@<baseUrl>:tools`）。
 *
 *   为什么要从**客户端**取而不是只读 env：`dotenv.ts` 的实测教训——调用方可能显式传了
 *   端点/模型（`createRealLlm({ baseUrl, model })`），此时 env 兜底拿到的是**另一套**配置，
 *   按 env 算窗口就会算错（同一个模型按错误的窗口推阈值）。客户端 id 是"实际在用的那个模型"
 *   的第一手证据；取不到（Fake / 包装器）再退回 env。
 */
export function modelNameFromLlmId(id: string | undefined | null): string | null {
    const m = /^real:([^@]+)@/.exec((id ?? "").trim());
    return m?.[1]?.trim() || null;
}

// ============================================================
// §2 判定（纯函数，零 LLM，可单测）
// ============================================================

/** 一次判定只有三种结果（第三种是"不许发"） */
export type ContextAction =
    | "send"       // 可以发这一条请求
    | "compact"    // 先压缩，再发
    | "blocked";   // **不许发**：越了阻塞线且压不动/压完仍越线 → 交给问人站

/**
 * 发车前该干什么（cc 的判定顺序：先看要不要自动压缩，再看越没越阻塞线）。
 *
 *   · `isAboveAutoCompactThreshold` 是**从窗口推出来的**（`eff − eff×13_000/180_000`，
 *     200_000 窗口上逐位等于 cc 的 167_000），不是常数——换窗口它会跟着变；
 *   · 没有摘要口（`canSummarize=false`）时"压"这个动作不存在，只能看第二条线：
 *     越过 `blockingLimit` 就**不许发**（硬发就是越窗 400；截断更是丢决策，
 *     两者都不是"省一点"的问题，是把这一步做成假动作）；
 *   · 两条线都没越 → 照发（绝大多数轮次）。
 */
export function planContextAction(o: {
    used: number;
    window: ContextWindowSpec;
    canSummarize: boolean;
}): ContextAction {
    const w = calculateTokenWarningState(o.used, o.window);
    if (w.isAboveAutoCompactThreshold && o.canSummarize) return "compact";
    if (w.isAtBlockingLimit) return "blocked";
    return "send";
}

/**
 * 这条请求**现在能不能发出去**（cc 的 blockingLimit 语义）。
 * 越线就不再发——这是"越窗 400"的唯一确定性防线（撞 400 的那一步是纯浪费：
 * 请求已计费、决策没拿到、历史还得多塞一条错误）。
 */
export function canSendLlmRequest(used: number, window: ContextWindowSpec): boolean {
    return !calculateTokenWarningState(used, window).isAtBlockingLimit;
}

/** blocked 时给模型/人看的**一行**诊断（进台账、进 state.contextBlocked、进问人题的"我判断的问题"） */
export function contextBlockedDetail(used: number, window: ContextWindowSpec): string {
    const w = calculateTokenWarningState(used, window);
    const src = window.degraded ? `${window.source}（**未配置，是假设值**）` : window.source;
    return `CONTEXT_OVERFLOW：本轮上下文已用 ≈${used} token，越过阻塞线 ${getBlockingLimit(window)}`
        + `（压缩后仍在线上 ⇒ 压不动了）。`
        + `模型 ${window.model || "未指定"}；窗口 ${window.contextWindowTokens} token（来源 ${src}）；`
        + `生效窗口 ${getEffectiveContextWindowSize(window)}，自动压缩线 ${getAutoCompactThreshold(window)}，`
        + `剩余 ${w.percentLeft}%。这一条请求**不发**——硬发就是越窗 400，截断就是丢决策。`;
}

// ============================================================
// §3 台账（事件名与字段）
// ============================================================

export const CONTEXT_EVENTS = {
    /** cc 的 `tengu_compact` 对应物：一次**真实**压缩一行（行数 = 前缀版本号） */
    compacted: "context_compacted",
    /** 熔断器状态：**必须持久化**，否则续跑丢掉"连续失败几次"，3 次熔断形同虚设 */
    tracking: "autocompact_tracking",
    /** 压缩尝试失败（熔断器 +1）——cc 用 logError，本仓库没有全局 logger，就落台账 */
    compactionFailed: "context_compaction_failed",
    /** 请求越了阻塞线、压缩救不回来：**不发**，交给问人站 */
    requestBlocked: "context_request_blocked",
    /** 窗口解析结果（含 degraded 告警原文）：把"假设"留在台账里，别只留在进程日志 */
    windowResolved: "context_window_resolved",
    /** 护栏自身出错（fail-open，但大声留痕——护栏是保护层，不是判据，不该把任务打死） */
    guardFailed: "context_guard_failed",
} as const;

/** 主线程 querySource（cc 的 'repl_main_thread'）：runPostCompactCleanup 只对主线程清模块级状态 */
export const MAIN_THREAD_QUERY_SOURCE = "repl_main_thread";
/** 摘要子调用的 querySource（cc 的 'compact'）：它**也占 LLM 预算**，必须单列一笔 */
export const COMPACT_QUERY_SOURCE = "compact" as const;

/**
 * ★ 窗口**出处**（owner 规格：台账必须能回答"这一轮是在真实窗口上算的，还是在猜的"）。
 *
 *   字段名是**固定的五个**：`contextWindowTokens / source / degraded / tier / model`。
 *   为什么非要成对出现而不是散落在各处：`degraded: true` 的那一轮，它的
 *   `autoCompactThreshold` / `preCompactTokenCount` **不能**与"已配置窗口"的轮次对比——
 *   底数不同，数字不可比。事后复盘（"r5 为什么没压、s6 为什么压了两次"）第一件事
 *   就是分辨这一次的线是**事实**还是**假设**；少一个字段这条链就断了。
 *   落在每一条上下文事件上（压缩/熔断器/失败/阻塞/告警）——单看某一条也能定位。
 */
export interface WindowProvenance {
    /** 本次生效的窗口基准（token） */
    contextWindowTokens: number;
    /** 这个数是哪来的：settings-tier / settings / model-suffix / env / unset-default */
    source: ContextWindowSourceKind;
    /** true = 用户没配，用的是产品默认（**这一轮的阈值是猜的**） */
    degraded: boolean;
    /** 档位（pro/flash；null = 该角色不分层） */
    tier: RoleTier | null;
    /** 该档位生效的模型名（模型名自带 [1m] 时，窗口就是它声明的） */
    model: string;
}

/** 从窗口解析结果里取出那五个字段（唯一出处，避免各处各写一份、字段名跑偏） */
export function windowProvenance(window: ContextWindowSpec): WindowProvenance {
    return {
        contextWindowTokens: window.contextWindowTokens,
        source: window.source,
        degraded: window.degraded,
        tier: window.tier,
        model: window.model,
    };
}

/**
 * 台账里能读的结构（**结构化依赖**：生产是 DeveloperLedger，测试可以给内存实现，
 * 不必为了跑一次判定去开 sqlite 库；DeveloperLedger 天然满足它）。
 */
export interface ContextLedger {
    appendEvent(type: string, payload: unknown): void;
    listEvents(): { type: string; payload: unknown; at: number }[];
}

/**
 * **前缀版本号** = 台账里 `context_compacted` 的条数。
 *
 *   为什么这么定义（而不是进程内计数器）：压缩换掉的是"模型看到的整份前缀"，
 *   这件事必须**跨 resume 可复原**——续跑的新进程没有内存里的计数器，
 *   但它有台账。于是"版本号变了" ⟺ "真实压缩发生过一次"，两边永远同源。
 *   一次真实压缩恰好 +1；判定为"不用压"的轮次一格都不动（没有事件就没有版本变化）。
 */
export function contextPrefixVersion(ledger: ContextLedger): number {
    return ledger.listEvents().filter((e) => e.type === CONTEXT_EVENTS.compacted).length;
}

/** 空白的熔断器状态 */
export function newAutoCompactTracking(): AutoCompactTrackingState {
    return { compacted: false, turnCounter: 0, turnId: "" };
}

/**
 * ★ 从台账**读回**熔断器状态（续跑必须走这条）。
 *
 *   源码为什么要有这个状态（autoCompact.ts:51-60）：连续失败到达上限（3）后**放弃压缩**，
 *   因为那说明"压缩这条路在这个会话上根本走不通"。源码注释记了统计依据：
 *   1,279 个会话连续失败 50+ 次、最多的失败了 3,272 次——不熔断就是无限烧。
 *   ⚠️ 如果只把它放在进程内存里，**每次 resume 都从 0 开始**，撞死循环的任务会被
 *   反复救起来再撞死（我们的续跑入口很多：waiting_test / waiting_item / waiting_human /
 *   崩溃恢复）。所以它必须落台账、必须在这里读回来。
 */
export function readAutoCompactTracking(ledger: ContextLedger): AutoCompactTrackingState | null {
    const rows = ledger.listEvents().filter((e) => e.type === CONTEXT_EVENTS.tracking);
    const last = rows.at(-1);
    const p = last?.payload;
    if (!p || typeof p !== "object") return null;
    const r = p as Record<string, unknown>;
    return {
        compacted: r["compacted"] === true,
        turnCounter: typeof r["turnCounter"] === "number" ? r["turnCounter"] : 0,
        turnId: typeof r["turnId"] === "string" ? r["turnId"] : "",
        ...(typeof r["consecutiveFailures"] === "number"
            ? { consecutiveFailures: r["consecutiveFailures"] } : {}),
    };
}

// ============================================================
// §4 接线面：一次"发车前判定"的全部输入与输出
// ============================================================

/** 接线的可配项（runToolLoop 的一个选项；**不传 = 完全不接线**，存量行为逐字节不变） */
export interface ContextBudgetOption {
    /**
     * ★ **已经解析好的**窗口基准（装配处解析一次，本层不再重复解析）。
     *   为什么要有这一口：档位要靠 `models.ts` 的 `resolveRoleTier` + `sys_settings.role_models`
     *   才算得出（同一个 developerAgent 可能以 backend=flash / frontend=pro 跑），
     *   而那是**装配处**的知识；在这里再解析一次就会出现"两处各算一个窗口"的自相矛盾
     *   （模型名与档位谁先谁后、settings 与 env 谁压谁，两个地方迟早写不一样）。
     *   给了它就**以它为准**（`source`/`degraded`/`tier`/`model` 也照它落台账）。
     */
    window?: ContextWindowSpec;
    /** 该档位生效的模型名（`window` 缺省时才用于本层解析） */
    model: string;
    /** 档位；由装配处按工位给（见 §1 契约③）。不传 = 不分层 */
    tier?: RoleTier | null;
    /** sys_settings.context_window（`window` 缺省时才用；装配处已解析时这里是记录用） */
    settingsWindowTokens?: unknown;
    /** sys_settings.context_window_pro（同上） */
    settingsWindowProTokens?: unknown;
    /**
     * 摘要口（cc 的 compact 调用）：**必须走真实 LLM 客户端**（生产由 index.ts 注入
     * 与主循环**同一个** llm 的 summarize，见 realLlm.ts 的 createRealLlmSummarizer）。
     * 不注入 = 引擎没有摘要能力：压不了，越阻塞线就只会去问人（不假装压过）。
     */
    summarize?: (request: SummaryRequest) => Promise<SummaryResponse>;
    /** 会出现在摘要消息正文里的原始台账/日志路径（cc 的 getTranscriptPath） */
    getTranscriptPath?: () => string;
    /** 压缩后回灌用的"最近读过的文件"表（**压缩时会被清空**，源码同款语义） */
    readFileState?: Record<string, { content: string; timestamp: number }>;
    /** 读盘端口；不注入 = 不回灌任何文件 */
    readFile?: (path: string) => Promise<string | null>;
    /** 跨轮携带的熔断器状态；缺省从台账读回（readAutoCompactTracking） */
    tracking?: AutoCompactTrackingState;
    /** env 注入（测试用；缺省 process.env） */
    env?: EnvLike;
    /** 告警出口（缺省 console.warn）；本层同时把告警原文写进台账 */
    warn?: (line: string) => void;
}

export interface ContextGuardInput extends ContextBudgetOption {
    /** 扁平 history（runToolLoop 的那一份） */
    history: readonly unknown[];
    ledger: ContextLedger;
    taskId: string;
    /**
     * 本轮 loop 内的轮号（写进 tracking.turnCounter）。
     * 【如实说明】跨 loop 的**绝对**轮号本仓库没有单一真相（每次进节点都是一轮新 loop），
     * 所以这里只报 loop 内轮号，不编一个"全局第几轮"出来骗台账。
     */
    turnCounter: number;
    /**
     * 预占一次 LLM 额度（摘要调用同样要花额度）。返回 false = 没额度 → 本次不压缩。
     * 传进来的原因：**预占的账在 runToolLoop 手里**（planned/budget/台账三者必须一致），
     * 这里不许自己偷偷加一次调用。
     */
    charge?: () => boolean;
    /**
     * 还**有没有**额度做这次摘要调用（预检，不预占）。
     *   为什么不靠 charge 失败来表态：没额度不是"压缩坏了"。若把它当压缩失败，
     *   熔断器（连续 3 次放弃）会被预算问题顶爆，等真有额度时压缩已经不试了——
     *   这是两件毫不相干的事被混成一件。所以先问一句，没额度就**根本不尝试压缩**。
     */
    canCharge?: () => boolean;
}

export interface ContextGuardOutcome {
    /** true = **不许发**这一条请求（调用方必须去问人，不许硬发、不许截断） */
    blocked: boolean;
    /** blocked 时给模型/人看的一行诊断 */
    detail: string | null;
    /** 本次生效的窗口基准（含 provenance：source/degraded） */
    window: ContextWindowSpec;
    /** 判定用的 token 用量（压缩发生后是**压缩后**的量） */
    used: number;
    /** 压缩前后的判定（台账/告警/测试都用它） */
    warning: ReturnType<typeof calculateTokenWarningState>;
    /** 本次是否**真的**压缩了（true ⟺ prefixVersion +1） */
    compacted: boolean;
    /** 台账里的前缀版本号（= context_compacted 行数；无压缩则与进来时相同） */
    prefixVersion: number;
    /** 熔断器状态（调用方不必自己存；压缩/失败时本层已落台账） */
    tracking: AutoCompactTrackingState;
    /** 压缩后的扁平 history（未压缩 = 原样同一份） */
    history: readonly unknown[];
    /** 摘要调用次数（要计进 loop 的 llmCallsPlanned / llmCallsCompleted：它真的花了额度） */
    summaryCalls: { attempted: number; completed: number };
    /** 护栏内部错误（fail-open 时非 null；已落台账，绝不影响主流程） */
    error: string | null;
}

/**
 * ★ 发车前那一次调用：量 → 判 → （必要时）压 → 再判 → 落台账。
 *
 *   顺序上刻意放在 runToolLoop 的**预占额度之前**：
 *     ① 压缩自己也要花一次调用（摘要），"预占"必须由调用方统一做（见 charge）；
 *     ② 判定为 blocked 的那一轮**根本不该预占**——没发出去的请求不是已发起的请求，
 *        预占了会让 state.llmCallsPlanned 凭空多一格（崩溃恢复时会读出来当事实用）。
 *
 *   失败语义（明确写出来，不是顺手 catch）：
 *     · 压缩失败（摘要报错/超时/空摘要）**不打死任务**：autoCompactIfNeeded 内部 catch
 *       并累加熔断器，这里只是把结果记账。压缩是**保护层**，不是判据。
 *     · 护栏自身出错（量/适配崩溃）→ fail-open：按"未接线"处理（存量行为），
 *       但落 context_guard_failed 大声留痕。理由同 settings.ts 的旁路原则：
 *       可观测/保护层坏了不该让主流程停摆——但也绝不静默。
 */
export async function runContextGuard(input: ContextGuardInput): Promise<ContextGuardOutcome> {
    const env = input.env ?? process.env;
    let warnLine: string | null = null;
    // ★ 装配处已经解析好就直接用它（**解析一次**，见 ContextBudgetOption.window 的注释）；
    //   否则本层退化成自己解析（存量调用点/单测走这条）。
    const window = input.window ?? resolveWiredContextWindow({
        model: input.model,
        tier: input.tier ?? null,
        settingsWindowTokens: input.settingsWindowTokens,
        settingsWindowProTokens: input.settingsWindowProTokens,
        env,
        warn: (line) => {
            warnLine = line;
            (input.warn ?? ((l: string) => console.warn(l)))(line);
        },
    });

    const provenance = windowProvenance(window);
    const tracking = input.tracking ?? readAutoCompactTracking(input.ledger) ?? newAutoCompactTracking();
    const summaryCalls = { attempted: 0, completed: 0 };
    let prefixVersion = contextPrefixVersion(input.ledger);
    let history: readonly unknown[] = input.history;
    let error: string | null = null;

    // 窗口是**假设**时（degraded）把告警原文留在台账里——"假设可见"是这条链路的红线
    if (window.degraded && warnLine !== null) {
        input.ledger.appendEvent(CONTEXT_EVENTS.windowResolved, {
            taskId: input.taskId, ...provenance, warning: warnLine,
        });
    }

    try {
        const canSummarize = input.summarize !== undefined
            && (input.canCharge ? input.canCharge() : true);
        const firstMessages = historyToMessages(history);
        let used = tokenCountWithEstimation(firstMessages);
        let warning = calculateTokenWarningState(used, window);

        const action = planContextAction({ used, window, canSummarize });
        let compacted = false;

        if (action === "compact" && input.summarize !== undefined) {
            const summarize = input.summarize;
            const host: CompactHost = {
                // 【记账】摘要调用是一次**真实** LLM 调用：
                //   · 先 charge（额度由调用方预占，没额度就不压——绝不偷偷超支）；
                //   · attempted/completed 两个计数回给调用方，计入 llmCallsPlanned/Completed。
                summarize: async (request: SummaryRequest): Promise<SummaryResponse> => {
                    if (input.charge && input.charge() === false) {
                        throw new Error("CONTEXT_COMPACT_NO_BUDGET：没有可用额度，本轮不做摘要调用");
                    }
                    summaryCalls.attempted++;
                    const res = await summarize(request);
                    summaryCalls.completed++;
                    return res;
                },
                ...(input.getTranscriptPath ? { getTranscriptPath: input.getTranscriptPath } : {}),
                ...(input.readFileState ? { readFileState: input.readFileState } : {}),
                ...(input.readFile ? { readFile: input.readFile } : {}),
            };

            const r = await autoCompactIfNeeded(
                firstMessages, host, window, MAIN_THREAD_QUERY_SOURCE, tracking,
            );

            if (r.wasCompacted && r.compactionResult) {
                const result = r.compactionResult;
                // ★ 先抓**压缩前**的 tracking 快照：recompactionInfo 问的是"上一次压缩是谁、
                //   隔了几轮"，而下面马上就要把 tracking 覆盖成本次的（谁先谁后写反了，
                //   台账里 previousCompactTurnId 就会变成"本次自己"，链式判定全废）。
                const prevCompacted = tracking.compacted === true;
                const prevTurnId = tracking.turnId;
                const prevTurnCounter = tracking.turnCounter ?? -1;

                // ★ 整份替换（**绝不改中部**）：buildPostCompactMessages 的顺序就是
                //   "压缩后模型看到什么"的全部定义（边界 → 摘要 → 保留段 → 附件 → hooks）。
                const applied = applyCompactionToHistory(history, result);
                history = applied.history;
                compacted = true;
                prefixVersion = contextPrefixVersion(input.ledger) + 1;

                tracking.compacted = true;
                tracking.turnCounter = 0;                     // 压缩即"新一轮"（cc 同款）
                tracking.turnId = result.boundaryMarker.uuid;
                tracking.consecutiveFailures = 0;

                // 与 autoCompactIfNeeded 内部用的是**同一个公式**（autoCompact.ts:296-302），
                // 只是取值时机在覆盖之前 —— 两边算出来必须一致，否则台账与机制会互相矛盾。
                const recompactionInfo: RecompactionInfo = {
                    isRecompactionInChain: prevCompacted,
                    turnsSincePreviousCompact: prevTurnCounter,
                    previousCompactTurnId: prevTurnId,
                    autoCompactThreshold: getAutoCompactThreshold(window),
                    querySource: MAIN_THREAD_QUERY_SOURCE,
                };
                input.ledger.appendEvent(CONTEXT_EVENTS.compacted, {
                    ...compactEventPayload(result, {
                        isAutoCompact: true, recompactionInfo,
                        querySource: MAIN_THREAD_QUERY_SOURCE,
                    }),
                    taskId: input.taskId,
                    /** 前缀版本号（= 台账里本事件的行数）：这就是"前缀换了第几版" */
                    prefixVersion,
                    /** 压缩一次的身份证（= 边界标记 uuid）：台账行与 history 里的边界一一对应 */
                    compactionId: result.boundaryMarker.uuid,
                    // ★ owner 规格：窗口出处五个字段（真实 vs 假设，事后可审）
                    ...provenance,
                    summaryCalls: summaryCalls.attempted,
                });
                input.ledger.appendEvent(CONTEXT_EVENTS.tracking, {
                    taskId: input.taskId,
                    compacted: true,
                    turnCounter: tracking.turnCounter,
                    turnId: tracking.turnId,
                    consecutiveFailures: 0,
                    prefixVersion,
                    ...provenance,
                });
            } else if (r.consecutiveFailures !== undefined) {
                // 压缩失败：熔断器 +1 并**落台账**（跨 resume 不许清零，见 readAutoCompactTracking）
                tracking.consecutiveFailures = r.consecutiveFailures;
                input.ledger.appendEvent(CONTEXT_EVENTS.tracking, {
                    taskId: input.taskId,
                    compacted: tracking.compacted,
                    turnCounter: input.turnCounter,
                    turnId: tracking.turnId,
                    consecutiveFailures: r.consecutiveFailures,
                    prefixVersion,
                    ...provenance,
                });
                input.ledger.appendEvent(CONTEXT_EVENTS.compactionFailed, {
                    taskId: input.taskId,
                    consecutiveFailures: r.consecutiveFailures,
                    summaryCalls: summaryCalls.attempted,
                    ...provenance,
                    note: "摘要调用失败（压缩没做成）——熔断器已累加；到达上限后不再尝试压缩，"
                        + "越阻塞线就直接问人（不硬发、不截断）",
                });
            }

            // 再量一次：判定"还能不能发"必须用**压缩后**的口径
            const afterMessages = historyToMessages(history);
            used = tokenCountWithEstimation(afterMessages);
            warning = calculateTokenWarningState(used, window);
        }

        // 最终一问：**现在这条请求能不能发**。三种来源统一成这一个出口——
        //   · 没压缩且 action==="blocked"（没有摘要口 / 熔断器已放弃）→ 仍在阻塞线上；
        //   · 压了但压完仍在阻塞线上（压不动了）→ 同上；
        //   · 压完掉到线下 → 照发。
        const stillBlocked = !canSendLlmRequest(used, window);
        let detail: string | null = null;
        if (stillBlocked) {
            detail = contextBlockedDetail(used, window);
            input.ledger.appendEvent(CONTEXT_EVENTS.requestBlocked, {
                taskId: input.taskId,
                used,
                blockingLimit: getBlockingLimit(window),
                threshold: getAutoCompactThreshold(window),
                effectiveWindow: getEffectiveContextWindowSize(window),
                // ★ owner 规格：阻塞事件同样带窗口出处（"这次是压不动，还是窗口本来就猜小了"）
                ...provenance,
                compactedThisRound: compacted,
                consecutiveFailures: tracking.consecutiveFailures ?? 0,
                detail,
                note: "越了阻塞线：**不硬发、不截断**，交问人站（state.contextBlocked → escalate）",
            });
        }

        return {
            blocked: stillBlocked, detail, window, used, warning,
            compacted, prefixVersion, tracking, history,
            summaryCalls, error: null,
        };
    } catch (e) {
        error = (e as Error).message;
        input.ledger.appendEvent(CONTEXT_EVENTS.guardFailed, {
            taskId: input.taskId, error,
            note: "上下文护栏自身出错 → 按未接线处理（fail-open，存量行为），但留下痕迹"
                + "（同 settings.ts 的旁路原则：保护层坏了不该让主流程停摆，也绝不静默）",
        });
        return {
            blocked: false, detail: null, window, used: 0,
            warning: calculateTokenWarningState(0, window),
            compacted: false, prefixVersion, tracking, history,
            summaryCalls, error,
        };
    }
}
