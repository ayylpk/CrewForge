// ============================================================
// brake.ts —— 团队开发线的**外层刹车**（墙钟 + 调用数），纯函数、可单测
//
//   为什么需要它（2026-09-17 评测血账）：
//     developerTeamRunner 原先把预算设成 Number.MAX_SAFE_INTEGER（对齐 Claude Code
//     "主循环没有调用数预算"的口径），且明确写明"不加墙钟"。团队线于是**一道内部刹车都没有**：
//     内部只有"完成信号 + 无进展保险丝"（超时/重复失败/停滞/孤儿回收），这些保险丝全要求
//     "模型给出可判定的信号"才触发；模型只要一直在正常地换花样干活（每次都不重复失败），
//     整条线就能一直跑下去。实测代价：
//       · eval-s4-run.log 3608s、eval-s4c/s4d-run.log 5409s、eval-s5b-run.log 7209s，
//         四次都是被**外层** eval 驱动器的 --timeout-min 杀掉的，sys_project.status 停在
//         executing —— 60~120 分钟真实 LLM 花费，收尾时既没有结论也没有死因。
//
//   ★★ 2026-09-17 三改（老板最终口径，本文件的最终形态）：**不杀，参照 Claude Code**。
//     老板的原话：
//       「不杀了，就参考 claudecode，一直进行下去，然后如果到阈值了，静默一段时间等待确认，
//         如果没有确认我们就把进程终止，任务信息保留，下次可以继续接着拉起来进程。」
//     所以现在的形状是**检查点 + 静默等待 + 保状态退出**，三句话：
//       ① **没有总量上限、没有"杀任务"语义**：到阈值不是死点，是**检查点**。
//          这条路径上永不调 abortRun、永不落 blocked/failed。
//       ② **到阈值 → 组题问人 → 静默等待**（默认 30 分钟，CF_BRAKE_WAIT_MINUTES）：
//          等待期间**零模型调用、零写盘、零干活**，只有轮询在跑（Questioner.ask 内部就是轮询；
//          Web 跑法读 sys_confirm 行）。题面里带全账目（见 brakeQuestion），人才能决策。
//       ③ **等不到确认 → 干净地终止进程，但任务信息保留**：
//          先落账本事件 brake_paused（含完整进展报告），把任务留在**非终态、可续跑**的
//          waiting_human，**不清题**；题号是确定性的（brake-<taskId>-<n>），
//          所以**下次拉起来会重新问同一道题**——人在停机期间答过就消费那个答案接着干。
//         这正是 Java 对账器的模型：进程干净退出 + 状态保留 + status=executing → 对账器重新拉进程续跑。
//
//   ★ 无人值守（AUTO_CONFIRM=1，评测台就是这么跑的）是**唯一的例外**，必须不被打断：
//     pickQuestioner 自动答 "y"（= 选项 1 继续），所以不会卡在等人上；这条路仍由
//     **CF_HARD_WALL_MINUTES**（可选天花板）兜底——到天花板就自己收口，免得把评测台跑挂。
//     Web/手工跑法**不看这个天花板**：它们走"静默等待 → 保状态退出"，人不在 ≠ 任务失败。
//
//   与既有机制的关系（复用，不另起一套）：
//     · 调用数闸复用 state.ts 的 isBudgetExceeded 口径（>= 即到顶，达到上限不得再发请求）；
//     · 墙钟是**外层兜底**，取代不了 timeout-repeated / isStalled / isAcceptanceStalled /
//       isRepeatedFailure 这几道内层保险丝——它们是"定位到具体病灶"的闸，此闸只保证"有终点"。
//     · 组的题、答的解析**照抄 escalation.ts 的确定性口径**（四段模板 / 选项1=安全默认 /
//       否定式优先判 stop / 自由文本进 guidance），不另发明一套问答协议。
//     · 状态复用 state.ts 的 waiting_human（9/17 加的"暂停问人"态，**不是终态**），不新造终态。
//
//   默认值选择（都有据可查）：
//     · 墙钟 SOFT 120 分钟（6 次实测里最长的 s5b 是 7209s ≈ 120 分钟——正好是"活干完了、
//       到点该问人了"的量级；老板要求"让它能跑完"，所以从 45 抬到 120）；
//     · 静默等待 30 分钟（与 Java 侧确认门 30 分钟无人应答判 auto_passed 的口径同源，
//       见 confirm.ts 头注释——两端都是半小时，人回来之前进程不烧钱也不动手）；
//     · 调用数 400（实测最大 147 调的 ~2.7 倍）；天花板夹到 720 分钟 / 4000 调（只防手滑）。
//
//   ⚠️ 量纲约定（踩过一次，写在这里防下次）：maxWallMs / hardWallMs 都是**时长**
//     （"能跑多久"），因为 checkBrake 拿到的是 elapsedMs（now - startedAt）；
//     "绝对时刻"是 deadlineAt（= startedAt + maxWallMs）。两者混用会让闸永远不触发。
// ============================================================

import { isBudgetExceeded } from "./state";

/**
 * 题目的类型：**与 GraphFactory.HumanQuestion 结构兼容**，但**刻意不 import 它**。
 *   `graph.test.ts:319` 有一道架构闸：developerAgent 目录下任何文件都不许 import GraphFactory
 *   （旧控制平面必须留在门外），而这道闸是纯正则，**连 type-only import 也不算数**（实测踩过）。
 *   所以照 escalation.ts:21 的老办法：只定义结构兼容的本地类型，不引入任何旧符号。
 */
export interface BrakeQuestion {
    questionId: string;
    prompt: string;
    options?: string[];
}

/** 问答器接口（与 GraphFactory.Questioner 结构兼容；runner 负责注入实现） */
export interface BrakeQuestioner {
    ask(q: BrakeQuestion): Promise<string>;
}

/** 墙钟 SOFT（检查点/提问点）默认 120 分钟：到点问人，不再就地判死（s5b 实测 7209s 同量级） */
export const DEFAULT_MAX_WALL_MINUTES = 120;
/** 墙钟硬上限 720 分钟（ops 可放宽，但不许把闸配成摆设） */
export const MAX_WALL_MINUTES_CAP = 720;
/** LLM 调用数默认 400（实测最大 147 调的 ~2.7 倍：够大而不失控） */
export const DEFAULT_MAX_LLM_CALLS = 400;
/** 调用数硬上限 4000（比实测高一个数量级，只防手滑） */
export const MAX_LLM_CALLS_CAP = 4000;
/** 静默等待确认的默认窗口 30 分钟（与 Java 确认门的 30 分钟无人应答口径同源） */
export const DEFAULT_WAIT_MINUTES = 30;
/** 静默等待窗口硬上限 24 小时（只防手滑把"等"写成"永远等"） */
export const MAX_WAIT_MINUTES_CAP = 24 * 60;
/** 无人值守模式下加时一次给多少分钟（"y" 不是无限续命，仍受天花板约束） */
export const DEFAULT_EXTEND_MINUTES = 30;

/**
 * 环境变量名（沿用仓内 CF_ 前缀惯例，见 architect.ts:670 / projectRunner.ts:406）。
 * 环境读数只发生在这里的**入口解析**，不往图里深挖——图只收解析好的数字（见 dsh 同族
 * 的"依赖显式注入"口径：读 env 的地方越少，测试越好钉死）。
 */
export const ENV_MAX_WALL_MINUTES = "CF_MAX_WALL_MINUTES";
export const ENV_MAX_LLM_CALLS = "CF_MAX_LLM_CALLS";
/** 静默等待确认的窗口（分钟） */
export const ENV_WAIT_MINUTES = "CF_BRAKE_WAIT_MINUTES";
/** 无人值守模式的绝对天花板（可选）：不配就按 SOFT + 一跳加时算 */
export const ENV_HARD_WALL_MINUTES = "CF_HARD_WALL_MINUTES";
/** 无人值守模式每次"y"给多少分钟 */
export const ENV_EXTEND_MINUTES = "CF_BRAKE_EXTEND_MINUTES";
/** 无人值守模式的判定旋钮（评测台注入；本文件只读它做**测试可注入**的判定） */
export const ENV_AUTO_CONFIRM = "AUTO_CONFIRM";

/**
 * 闸门配置（已解析、已夹紧、已定格；deadlineAt 是绝对时刻，下游只做减法）。
 *
 *   ★ 两级阈值的角色已经完全变了（三改）：
 *     · SOFT（maxWallMs / maxLlmCalls）：**检查点**。到点就问人，人答继续就前移期限接着干
 *       （不是死点，也不设"最多问几次"的硬上限——参照 Claude Code，一直进行下去）。
 *     · HARD（hardWallMs / hardLlmCalls）：**只在无人值守（AUTO_CONFIRM=1）模式下启用**的兜底。
 *       Web/手工跑法到它不会死：走到天花板就"静默等待 → 等不到就保状态退出"。
 *   加时是**就地前移 SOFT**（deadlineAt 跟着动），所以驱动环每转一圈都要重新读它，
 *   绝不许在环外缓存——缓存了就等于"加了时却还在按旧点刹车"。
 */
export interface BrakePolicy {
    /** 单次运行的墙钟 SOFT 上限（毫秒**时长**，检查点） */
    maxWallMs: number;
    /** 单次运行的 LLM 调用数 SOFT 上限（检查点） */
    maxLlmCalls: number;
    /**
     * **配置出来的初始调用预算**（只有 resolveBrakePolicy 会写，加时不动它）。
     *   为什么要留一份：handle 的 maxLlmCalls 是按它算的（budgetOf 取 min），
     *   而 maxLlmCalls 会随加时增长——不留初始值就分不清"图被自己的预算卡住"还是"闸门在放行"。
     */
    initialMaxLlmCalls: number;
    /** 墙钟到点的绝对时刻（= startedAt + maxWallMs，含已加时；下游只做减法） */
    deadlineAt: number;
    /** 本次运行的起点（用于算 elapsed；与 deadlineAt 同源，不吃两次 Date.now()） */
    startedAt: number;
    /** 墙钟绝对天花板（毫秒**时长**；≥ maxWallMs。仅无人值守模式生效） */
    hardWallMs: number;
    /** 调用数绝对天花板（跨不过去；≥ maxLlmCalls。仅无人值守模式生效） */
    hardLlmCalls: number;
    /** 静默等待确认的窗口（毫秒）。等不到就保状态退出，等的过程零模型调用、零写盘 */
    waitMs: number;
    /** 无人值守模式下"y"一次给多少分钟 */
    extendMinutes: number;
    /** 本次运行已经用掉的加时次数（账本续跑时从事件数重建） */
    extensionsUsed: number;
    /** 是否无人值守（AUTO_CONFIRM=1）：只有它为真时，HARD 天花板才生效 */
    unattended: boolean;
    /** 配置来源，只用于日志/账本（"为什么这个数是这个数"） */
    source: { wallMinutes: number; fromEnv: string[] };
}

/** 到点原因：只有这两个出口，报告里据此说清"是谁到点了"（是否撞天花板看 BrakeStatus.hard） */
export type BrakeReason = "wall_clock" | "llm_budget";

export interface BrakeStatus {
    tripped: boolean;
    reason: BrakeReason | null;
    elapsedMs: number;
    maxWallMs: number;
    callsCompleted: number;
    maxLlmCalls: number;
    /** 到了**无人值守天花板**（true 时不许再问人/再等，直接收口——只可能出现在 AUTO_CONFIRM 模式） */
    hard: boolean;
}

/** 本次运行的允许量（调用数闸的读数口径；由 runner 把 handle 预算与闸门预算取 min 传进来） */
export interface BrakeUsage {
    callsCompleted: number;
    elapsedMs: number;
    /** 到哪个调用数算到顶（默认 = policy.maxLlmCalls；两次到顶之间由调用方重新取 min） */
    callsAllowance?: number;
}

/**
 * 正数解析：**非法值回落到默认**，绝不变成 0/NaN。
 *   0/NaN 落到闸门上是灾难性的（0 分钟 = 一开工就判超时，NaN 比较全 false = 闸永远不触发），
 *   所以这里只认"有限且 > 0"的数；小数向下取整（"45.9 分钟"按 45 算，宁可早停不晚停）。
 */
export function parsePositiveNumberEnv(raw: string | undefined, fallback: number): number {
    if (raw === undefined) return fallback;
    const n = Number(raw.trim());
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.floor(n);
}

/** 夹到 [1, cap]：0/NaN/负数一律落到 1（闸门可以很紧，但绝不允许变成"无闸"或"立刻炸"） */
function clampPositive(n: number, cap: number): number {
    if (!Number.isFinite(n)) return cap;
    return Math.min(Math.max(Math.floor(n), 1), cap);
}

/** 是否无人值守（AUTO_CONFIRM=1）：只有这条路用得上绝对天花板 */
export function isUnattended(env: Record<string, string | undefined> = process.env): boolean {
    return env[ENV_AUTO_CONFIRM] === "1";
}

/**
 * 解析本次运行的闸门配置（**唯一的 env 读取点**）。
 *   两个 SOFT 上限都默认开启：团队线此前"没有任何闸"，所以这里默认 ON 才是修复；
 *   想放宽的人用 env 显式放宽（且仍受天花板约束），而不是把闸关掉。
 */
export function resolveBrakePolicy(
    env: Record<string, string | undefined> = process.env,
    now: number = Date.now(),
): BrakePolicy {
    const fromEnv: string[] = [];
    const knobs = [
        ENV_MAX_WALL_MINUTES, ENV_MAX_LLM_CALLS, ENV_WAIT_MINUTES,
        ENV_HARD_WALL_MINUTES, ENV_EXTEND_MINUTES,
    ];
    for (const name of knobs) if (env[name] !== undefined) fromEnv.push(name);

    const wallMinutes = clampPositive(
        parsePositiveNumberEnv(env[ENV_MAX_WALL_MINUTES], DEFAULT_MAX_WALL_MINUTES), MAX_WALL_MINUTES_CAP);
    const maxLlmCalls = clampPositive(
        parsePositiveNumberEnv(env[ENV_MAX_LLM_CALLS], DEFAULT_MAX_LLM_CALLS), MAX_LLM_CALLS_CAP);
    const waitMinutes = clampPositive(
        parsePositiveNumberEnv(env[ENV_WAIT_MINUTES], DEFAULT_WAIT_MINUTES), MAX_WAIT_MINUTES_CAP);
    const extendMinutes = clampPositive(
        parsePositiveNumberEnv(env[ENV_EXTEND_MINUTES], DEFAULT_EXTEND_MINUTES), MAX_WALL_MINUTES_CAP);
    const maxWallMs = wallMinutes * 60_000;
    // 天花板必须**不低于** SOFT：env 写小了就等于把 SOFT 抬到天花板（宁可早收口，也不许倒挂）。
    // 两个都是**时长**（见文件头的量纲约定）。
    const hardWallMinutes = Math.max(wallMinutes, clampPositive(
        parsePositiveNumberEnv(env[ENV_HARD_WALL_MINUTES], wallMinutes + extendMinutes),
        MAX_WALL_MINUTES_CAP));
    const hardWallMs = hardWallMinutes * 60_000;
    const hardLlmCalls = clampPositive(maxLlmCalls * 2, MAX_LLM_CALLS_CAP);
    return {
        maxWallMs, maxLlmCalls,
        initialMaxLlmCalls: maxLlmCalls,
        startedAt: now,
        deadlineAt: now + maxWallMs,
        hardWallMs, hardLlmCalls,
        waitMs: waitMinutes * 60_000,
        extendMinutes,
        extensionsUsed: 0,
        unattended: isUnattended(env),
        source: { wallMinutes, fromEnv },
    };
}

/**
 * 还差多久到墙钟 SOFT（毫秒，≥0）：**给下游的窗口定界用**。
 *   例：waiting_test 的等待窗口不许活得比墙钟还久（graph 的 requestTest 用它夹 waitTestTimeoutMs）——
 *   否则刹车到点时那条等待还挂在账本上，人读起来像"系统在等测试"，其实是"整轮已经超时了"。
 */
export function remainingWallMs(policy: BrakePolicy, now: number = Date.now()): number {
    return Math.max(0, policy.deadlineAt - now);
}

/**
 * 闸门判定（纯函数，驱动环每个循环头调用一次）。**它只回答"现在该不该问人"，不回答"该不该死"**。
 *
 *   · 顺序固定 墙钟 → 调用数（两者同时到顶时先报墙钟：时间不可逆，
 *     也是外层杀进程走的那条路，报它更有助于人对账）。
 *   · 墙钟：`elapsed >= maxWallMs` —— **到点即算到点**（与 isBudgetExceeded 的 ">=" 口径同族：
 *     上限是"可用的量"，不是"允许再多跑一点"）。边界语义由 brake.test.ts 钉死。
 *   · hard 只在**无人值守**（policy.unattended）时可能为真：Web/手工跑法即使越过天花板，
 *     也只是"再问一次/静默等待"，不是死点（老板口径：不杀了）。
 *   · elapsed 为负（时钟被调过）时夹到 0：宁可少算时长，也不许把闸门判成"已超时"而误杀。
 */
export function checkBrake(policy: BrakePolicy, used: BrakeUsage): BrakeStatus {
    const elapsedMs = Math.max(0, used.elapsedMs);
    const callsCompleted = Math.max(0, used.callsCompleted);
    const allowance = used.callsAllowance ?? policy.maxLlmCalls;
    const base = {
        elapsedMs, maxWallMs: policy.maxWallMs,
        callsCompleted, maxLlmCalls: allowance,
    };
    const hardWall = policy.unattended && elapsedMs >= policy.hardWallMs;
    const hardCalls = policy.unattended && isBudgetExceeded({ llmCallsCompleted: callsCompleted }, policy.hardLlmCalls);
    if (elapsedMs >= policy.maxWallMs) {
        return { ...base, tripped: true, reason: "wall_clock", hard: hardWall || hardCalls };
    }
    if (isBudgetExceeded({ llmCallsCompleted: callsCompleted }, allowance)) {
        return { ...base, tripped: true, reason: "llm_budget", hard: hardWall || hardCalls };
    }
    return { ...base, tripped: false, reason: null, hard: false };
}

/**
 * 就地加时（**唯一**能前移期限的地方）。
 *   返回的 index 供账本用（第几次加时）。注意它改的是 policy 本身：
 *   驱动环下一圈的 checkBrake 读到的就是新期限——
 *   "和用户对话之后才继续开工"能成立，全靠这一点。
 */
export function grantBrakeExtension(policy: BrakePolicy, now: number = Date.now()): { index: number } {
    policy.extensionsUsed += 1;
    policy.maxWallMs += policy.extendMinutes * 60_000;
    policy.deadlineAt = now + policy.extendMinutes * 60_000;   // ★ 从"现在"起算，不是从旧期限起算
    return { index: policy.extensionsUsed };
}

/** 账本事件名（eval 报告与对账器 grep 这两个字面量；不要改字面量） */
export function brakeEventName(reason: BrakeReason): "wall_clock_exceeded" | "llm_budget_exceeded" {
    return reason === "wall_clock" ? "wall_clock_exceeded" : "llm_budget_exceeded";
}

/** 毫秒 → "45.3 分钟"（日志与死因文本共用，免得两处各写一套格式化） */
export function formatElapsed(elapsedMs: number): string {
    return `${(Math.max(0, elapsedMs) / 60_000).toFixed(1)} 分钟`;
}

/** 毫秒**时长**（不是时刻）→ "180 分钟"：天花板这类"绝对量"读起来不该带小数点 */
export function formatMinutes(ms: number): string {
    return `${Math.round(Math.max(0, ms) / 60_000)} 分钟`;
}

/** 到点原因的短名（日志/账本里的 reason 字段） */
export function brakeReasonLabel(reason: BrakeReason): string {
    return reason === "wall_clock" ? "墙钟" : "调用数";
}

/**
 * 一句话到点说明（进账本 / 报告 / 日志）。形如：
 *   `[BRAKE:wall_clock] 墙钟到点（已跑 121.0/120.0 分钟，LLM 147/400 调）`
 *   语义是"**到点了**"不是"死了"：驱动环会先问人、再静默等待，人答继续就前移期限接着跑。
 */
export function brakeReasonText(status: BrakeStatus): string {
    if (!status.tripped || !status.reason) return "";
    if (status.reason === "wall_clock") {
        return `[BRAKE:wall_clock] 墙钟到点（已跑 ${formatElapsed(status.elapsedMs)}`
            + `/${formatElapsed(status.maxWallMs)}，LLM ${status.callsCompleted}/${status.maxLlmCalls} 调）`;
    }
    return `[BRAKE:llm_budget] LLM 调用数到顶（已用 ${status.callsCompleted}/${status.maxLlmCalls} 调`
        + `，墙钟 ${formatElapsed(status.elapsedMs)}/${formatElapsed(status.maxWallMs)}）`;
}

/**
 * 一行可 grep 的日志：
 *   `⏱ [BRAKE] wall_clock 到点：跑了 121.0/120.0 分钟，LLM 147/400 调；已改 7 个文件，未完成 2/5 工作项（w3, w4）`
 */
export function brakeLogLine(status: BrakeStatus, undone: {
    changedFiles: number;
    workItemsTotal: number;
    workItemsDone: number;
    remaining: string[];
}): string {
    if (!status.tripped || !status.reason) return "";
    const icon = status.reason === "wall_clock" ? "⏱" : "🧮";
    const head = status.reason === "wall_clock"
        ? `${icon} [BRAKE] wall_clock 到点：跑了 ${formatElapsed(status.elapsedMs)}/${formatElapsed(status.maxWallMs)}`
        : `${icon} [BRAKE] llm_budget 到顶：用了 ${status.callsCompleted}/${status.maxLlmCalls} 调`
            + `（跑了 ${formatElapsed(status.elapsedMs)}/${formatElapsed(status.maxWallMs)}）`;
    const cap = status.hard ? "｜**无人值守天花板**" : "";
    const tail = undone.remaining.length > 0
        ? `未完成 ${undone.workItemsTotal - undone.workItemsDone}/${undone.workItemsTotal} 个工作项（${undone.remaining.slice(0, 6).join(", ")}）`
        : "工作项已全部完成（停在了验收/收口前）";
    return `${head}${cap}；已改 ${undone.changedFiles} 个文件，${tail}`;
}

// ============================================================
//  检查点：带真数字的题 + 答案解析（纯函数，零 IO）
// ============================================================

/**
 * 三个动作：继续 / 按现状收口 / 立刻停止。
 *   **顺序即默认序**——第一个选项是安全默认（AUTO_CONFIRM=1 与 Java 侧超时 auto_passed 都取它）。
 *   与 escalation.ts 的 ESCALATION_OPTIONS 同款口径：选项 1 必须是最不坏的那一步。
 *   选项文本里的分钟数走 brakeOptions()（跟随 CF_BRAKE_EXTEND_MINUTES，不许在题面里写死）。
 */
export const BRAKE_OPTIONS = [
    `继续：加时 ${DEFAULT_EXTEND_MINUTES} 分钟接着干（默认）`,
    "按现状收口：不再开工，交进展报告（做了什么/还差什么/证据）",
    "立刻停止：现在就停，别再动了",
] as const;

/** 选项表（分钟数跟随配置；人看到的数字必须和账本里加的数字是同一个） */
export function brakeOptions(extendMinutes: number): string[] {
    return [
        `继续：加时 ${extendMinutes} 分钟接着干（默认）`,
        BRAKE_OPTIONS[1],
        BRAKE_OPTIONS[2],
    ];
}

export type BrakeAction = "extend" | "finalize" | "stop";

export interface BrakeDecision {
    action: BrakeAction;
    /** 人给的原始答案（审计用） */
    raw: string;
    /** 判定依据（"命中选项 2 的『收口』关键词" / "无法解析，按安全默认继续"） */
    note: string;
    /** 人的自由文本指示（非空时带进上下文，作为新的输入） */
    guidance: string | null;
}

// 关键词命中表。命中顺序：**先 stop，再 finalize，最后 extend**（宁停不乱干）。
//
//   ⚠️ 为什么 extend 不能排在前面（实测 bug，照抄 escalation.ts 的教训）：
//     "不用了"（stop）里含"用"、"终止"里含"止"、"别继续了"里含"继续"——
//     只要 extend 的关键词先命中，人说的"不干了"就会被读成"接着干"，方向反了。
//     所以顺序是硬约定，改这一行等于改安全语义。
const BRAKE_KEYWORDS: { action: BrakeAction; words: string[] }[] = [
    { action: "stop", words: ["停止", "停下", "中止", "终止", "叫停", "别做了", "不用了", "不要了", "别继续", "不要继续", "别再", "算了", "停", "stop", "abort", "quit", "halt"] },
    { action: "finalize", words: ["收口", "收尾", "交付", "按现状", "现状", "结项", "封版", "别再开工", "finalize", "wrap up", "deliver"] },
    { action: "extend", words: ["继续", "加时", "延长", "接着", "再给", "续", "go on", "continue", "extend", "keep going", "proceed"] },
];

/**
 * 否定式优先闸（照抄 escalation.ts 的实测 bug 修复）：
 *   "别继续做了，停" 会被 extend 的"继续"命中 → 判成继续。
 *   人说"别继续"却还在干，是比"多问一次"严重得多的错误（方向反了），
 *   所以凡是「否定词 + 继续类动词」的组合，一律先判 stop。
 *   例：`别继续了` / `不要继续加班` 都必须是 stop。
 */
const NEGATED_EXTEND = /(别|不要|不用|不必|无需|先别|停止|中止)[^。！？，,]{0,6}(继续|接着|再给|延长|加时|做|干)/;

/**
 * 答案 → 动作。规则（有序）：
 *   · 空 / "y" / "yes" / "是" → extend（AUTO_CONFIRM=1 与"超时无人应答取选项 1"都走这条，
 *     与"选项1=安全默认"一致；无人值守模式仍受 CF_HARD_WALL_MINUTES 兜底）
 *   · "1"/"2"/"3"（可带 ) . 、 等）→ extend / finalize / stop
 *   · 否定式（"别继续了"）→ stop（**先于**关键词表判定）
 *   · 关键词命中 → 对应动作（先 stop，再 finalize，最后 extend）
 *   · 其余非空文本 → 继续并把原话当指引（"和用户对话之后才继续开工"就是走这条）
 */
export function parseBrakeAnswer(answer: string): BrakeDecision {
    const raw = (answer ?? "").trim();
    if (raw === "" || /^(y|yes|是|ok|好的)$/i.test(raw)) {
        return { action: "extend", raw, note: "自动/默认应答 → 按安全默认继续（无人值守仍受天花板兜底）", guidance: null };
    }
    const idx = raw.match(/^([123])[).、．\s]?$/);
    if (idx) {
        const n = Number(idx[1]);
        const action: BrakeAction = n === 1 ? "extend" : n === 2 ? "finalize" : "stop";
        return { action, raw, note: `命中选项序号 ${n}`, guidance: null };
    }
    if (NEGATED_EXTEND.test(raw)) {
        return { action: "stop", raw, note: "否定式（别继续/不要继续 等）→ stop", guidance: null };
    }
    // 顺序即安全语义：stop → finalize → extend（见 BRAKE_KEYWORDS 头的实测 bug 说明）
    for (const row of BRAKE_KEYWORDS) {
        if (row.words.some((w) => raw.toLowerCase().includes(w.toLowerCase()))) {
            return { action: row.action, raw, note: `命中「${row.action}」关键词`, guidance: null };
        }
    }
    return {
        action: "extend", raw,
        note: "未命中选项/关键词 → 当作人的自由指示，继续并把原话带进上下文",
        guidance: raw,
    };
}

/** 决策一行摘要（进账本，事后可审计"为什么继续了、人怎么答的"） */
export function describeBrakeDecision(d: BrakeDecision): string {
    return `人答「${d.raw.slice(0, 80)}」 ⇒ ${d.action}（${d.note}）`;
}

/**
 * 进展报告的数字（**组装在 brake.ts、取材在 runner**：本模块仍是纯函数，不读 IO）。
 *   为什么要这么多数字：老板的血账是"收尾时既没有结论也没有死因"，人拿着
 *   "超时了"三个字做不了任何决定——继续？收口？还是叫停？必须给得出账。
 *   这份数字既进题面（人决策用），也进 brake_paused（下次拉起来时人看得到现场）。
 */
export interface BrakeSummary {
    taskId: string;
    status: string;
    /** 到点读数 */
    elapsedMs: number;
    /** 墙钟 SOFT 上限（检查点；加时后会前移） */
    maxWallMs: number;
    /** 墙钟天花板（**时长**口径，与 policy.hardWallMs 同源；仅无人值守模式生效） */
    hardWallMs: number;
    callsCompleted: number;
    /** 本次允许到几调（handle 预算与闸门预算取 min） */
    callsAllowance: number;
    hardCalls: number;
    changedFiles: number;
    workItemsDone: number;
    workItemsTotal: number;
    /** 还没做完的工作项 id */
    remaining: string[];
    toolCalls: number;
    repairAttempts: number;
    /** 验收判据当前的绿/总数（账本里没有读数时为 null——诚实交空，不编数） */
    checksGreen: number | null;
    checksTotal: number | null;
    /** 最近一次失败/阻塞原因（没有就 null） */
    lastError: string | null;
    /** 已加时次数（账本重建） */
    extensionsUsed: number;
    /** 静默等待窗口（毫秒）——题面里要告诉人"我等你多久" */
    waitMs: number;
    /** 无人值守（AUTO_CONFIRM=1）时给多少分钟 */
    extendMinutes: number;
}

/** 存进账本与报告的文本上限（error_msg 是库里的列，不能无限长） */
export const BRAKE_REPORT_CLIP = 1500;

function clip(text: string, max = BRAKE_REPORT_CLIP): string {
    return text.length > max ? `${text.slice(0, max)}…（截断，完整见账本）` : text;
}

/**
 * 从账本事件里取**验收判据的绿/总数**（廉价的账本读，不跑任何测试）。
 *   取最近一条 acceptance_criteria_status（graph.ts:1496 落的那种），
 *   没有就返回 null —— 诚实交空，绝不编一个好看的数字。
 */
export function acceptanceGreen(events: { type: string; payload: unknown }[]): { green: number; total: number } | null {
    for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i];
        if (!ev || ev.type !== "acceptance_criteria_status") continue;
        const status = (ev.payload as { status?: unknown } | null)?.status;
        if (!status || typeof status !== "object") return null;
        const values = Object.values(status as Record<string, unknown>);
        if (values.length === 0) return null;
        return { green: values.filter((v) => v === "pass").length, total: values.length };
    }
    return null;
}

/** 从账本事件里取**最近一次失败/阻塞原因**（报告里"为什么停"的那一句） */
export function lastFailureReason(events: { type: string; payload: unknown }[]): string | null {
    for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i];
        if (!ev) continue;
        if (ev.type !== "test_failure" && ev.type !== "blocked_unverified"
            && ev.type !== "repair_exhausted" && ev.type !== "developer_failed") continue;
        const p = ev.payload as { reason?: unknown; error?: unknown; detail?: unknown } | null;
        const text = p?.reason ?? p?.error ?? p?.detail;
        if (typeof text === "string" && text.trim() !== "") return text.trim();
    }
    return null;
}

/**
 * 从账本事件重建**加时次数**（崩溃/停机续跑时，policy 是新的，次数得从账本捞回来）。
 *   只认成功加时的那条事件（brake_extended），不认"问失败"之类——次数是账本的事实。
 */
export function countExtensions(events: { type: string }[]): number {
    let n = 0;
    for (const ev of events) if (ev?.type === "brake_extended") n++;
    return n;
}

// ============================================================
//  跨进程保留：**保留决策，不保留原始对话**
// ============================================================
//
//   ★ 老板口径（2026-09-17）：
//     「保留的是**决策**，不是原始对话。」
//   为什么这在本引擎里站得住（对着代码核过）：
//     · 每个工作项跑的是**独立的工具循环**，任务书由 renderTask 从 state 字段**重渲染**
//       （graph.ts:1574 `renderTask(state, skillName, tree)` 用 state.workItems /
//        acceptanceChecks / foundationPlan / developerInstructions 拼 task.md 模板）；
//     · 也就是说：原始 transcript 既不是必需的（下一轮本来就会重渲染任务书），
//       也不该留（它会跟既有的 5 层上下文剪枝和 prefix-cache 稳定化打架，而且人给了
//       "降级范围"这类新指令之后，旧对话里的假设**已经错了**）。
//     · 原始 LLM 日志本来就有磁盘出口（rawLogPath）——那是给人取证用的，不是模型上下文，不动它。
//
//   所以真正要跨进程活下来的东西只有下面这些（每一条都有明确的载体）：
//     ① 计划与进度：workItems 由架构师**重派发**的蓝图恢复，completed/deferred 由引擎从
//        蓝图与账本重建（不受暂停影响）；
//     ② 验收判据基线：state.ts 的 acceptanceMemory 从**账本事件** acceptance_criteria_status
//        读回（graph.ts:1484-1497）——这是"回归冻结"的基线，丢了下一轮就退化成"首次预演"；
//     ③ 人的答案与指引：题号（幂等 brake-<taskId>-<n>）+ 答案 + 自由文本 guidance，
//        由本文件的账本事件承载（brake_paused / brake_extended / brake_guidance）；
//     ④ 幂等/记账状态：completed_tool_call 缓存（ledger.ts:213 recordToolCallOnce，按 runKey）
//        + changedFiles / failureSignatures / llmCalls / repairAttempts（task_state 快照）；
//     ⑤ 暂停记录：brake_paused（完整进展报告 + 最近几次工具调用的短摘要），
//        给续跑一个"我从哪停下来"的锚点。
//
//   ★ 替transcript的那份东西 = **resume brief**（见 resumeBriefText）：几行、有界、从账本生成，
//     在续跑时拼进 DeveloperInstructions（task.md:33 的 {{developerInstructions}} 占位符）
//     → 因此它**必然出现在任务书/提示材料里**，而且不携带任何过时的对话假设。

/** 账本事件的只读形状（本模块不认识 Ledger 类，只吃 listEvents 的形状） */
export interface BrakeLedgerEvent { type: string; payload: unknown }

/** brake_paused 记录（跨进程保留的"我从哪停下来"的锚点） */
export interface BrakePauseRecord {
    questionId: string;
    round: number;
    reason: BrakeReason | null;
    /** 提问本身失败时的原因（Java 不可达 / 问答器未装配），null = 只是没人答 */
    askFailed: string | null;
    /** 静默等了多少毫秒 */
    waitedMs: number | null;
    /** 已加时次数 */
    extensionsUsed: number;
    /** 进展报告全文（进 developer_blocked/日志/续跑摘要） */
    text: string;
    changedFiles: number;
    callsCompleted: number;
    remaining: string[];
    workItemsDone: number;
    workItemsTotal: number;
    lastError: string | null;
    checksGreen: number | null;
    checksTotal: number | null;
}

function num(v: unknown): number | null {
    return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 从账本取**最近一条 brake_paused**（没有 = 这次不是"暂停后续跑"） */
export function findBrakePause(events: BrakeLedgerEvent[]): BrakePauseRecord | null {
    for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i];
        if (!ev || ev.type !== "brake_paused") continue;
        const p = ev.payload as Record<string, unknown> | null;
        if (!p) continue;
        const questionId = typeof p["questionId"] === "string" ? p["questionId"] : "";
        const round = num(p["round"]);
        if (questionId === "" || round === null || round < 1) return null;
        const reason = p["reason"] === "wall_clock" || p["reason"] === "llm_budget" ? p["reason"] : null;
        return {
            questionId, round, reason,
            askFailed: typeof p["askFailed"] === "string" ? p["askFailed"] : null,
            waitedMs: num(p["waitedMs"]),
            extensionsUsed: num(p["extensionsUsed"]) ?? 0,
            text: typeof p["text"] === "string" ? p["text"] : "",
            changedFiles: num(p["changedFiles"]) ?? 0,
            callsCompleted: num(p["callsCompleted"]) ?? 0,
            remaining: Array.isArray(p["remainingWorkItems"]) ? (p["remainingWorkItems"] as unknown[]).map(String) : [],
            workItemsDone: num(p["workItemsDone"]) ?? 0,
            workItemsTotal: num(p["workItemsTotal"]) ?? 0,
            lastError: typeof p["lastError"] === "string" ? p["lastError"] : null,
            checksGreen: num(p["checksGreen"]),
            checksTotal: num(p["checksTotal"]),
        };
    }
    return null;
}

/** 从账本取**人的答案/指引**（第④⑤类保留物里最容易被忽略、但最不能丢的一块） */
export function findHumanInputs(events: BrakeLedgerEvent[]): {
    /** 最近一次人答的原文（brake_extended / brake_user_* 里的 answer） */
    lastAnswer: string | null;
    /** 人的自由文本指引（brake_guidance.text，可能多条，按发生顺序） */
    guidance: string[];
} {
    let lastAnswer: string | null = null;
    const guidance: string[] = [];
    for (const ev of events) {
        if (!ev) continue;
        const p = ev.payload as Record<string, unknown> | null;
        if (ev.type === "brake_guidance") {
            const t = p?.["text"];
            if (typeof t === "string" && t.trim() !== "") guidance.push(t.trim());
        } else if (ev.type === "brake_extended" || ev.type === "brake_user_stopped" || ev.type === "brake_user_finalize") {
            const a = p?.["answer"];
            if (typeof a === "string" && a.trim() !== "") lastAnswer = a.trim();
        }
    }
    return { lastAnswer, guidance };
}

/** resume brief 的形状（拼进任务书的那几行；由账本生成，不碰 transcript） */
export interface ResumeBrief {
    /** 第几次续跑（1 = 第一次从暂停里拉起来） */
    continuation: number;
    lines: string[];
}

/** resume brief 的长度上限（一小把行，别把任务书撑爆） */
export const RESUME_BRIEF_CLIP = 1200;

/**
 * 组装 **resume brief**：替掉"原始对话"的那份紧凑材料。
 *   只吃账本 + 当前进度，不读任何 transcript；内容刻意小、稳定、不含过时假设。
 *   返回 null = 这次不是暂停后续跑（首跑/普通崩溃续跑不注入，零扰动）。
 */
export function resumeBrief(input: {
    events: BrakeLedgerEvent[];
    /** 本次运行时还剩下的工作项 id（引擎自己算好的，见 runner 的 remaining 推导） */
    remaining: string[];
    workItemsDone: number;
    workItemsTotal: number;
    /** 无账本读数时的兜底（账本里没有验收读数时用） */
    checksGreen: number | null;
    checksTotal: number | null;
}): ResumeBrief | null {
    const pause = findBrakePause(input.events);
    if (!pause) return null;
    const human = findHumanInputs(input.events);
    const green = pause.checksGreen ?? input.checksGreen;
    const total = pause.checksTotal ?? input.checksTotal;
    const done = Math.max(input.workItemsDone, pause.workItemsDone);
    const itemTotal = Math.max(input.workItemsTotal, pause.workItemsTotal);
    const remaining = input.remaining.length > 0 ? input.remaining : pause.remaining;
    const stopped = pause.askFailed
        ? `上一次没问出去（${pause.askFailed}）`
        : `上一次静默等了 ${formatMinutes(pause.waitedMs ?? 0)} 没人确认`;
    const lines = [
        `【续跑简报】（第 ${pause.extensionsUsed + 1} 次续跑；本段是代码从账本生成的决策摘要，**不是**对话记录）`,
        `- 上次为什么停：${stopped}${pause.reason ? `｜到点原因 ${brakeReasonLabel(pause.reason)}` : ""}`
            + `｜题号 ${pause.questionId}`,
        `- 人的指令（原文）：${human.lastAnswer ? `「${human.lastAnswer}」` : "（停机期间没有人回答，本轮继续等）"}`,
        ...(human.guidance.length > 0
            ? [`- 人的自由文本指引（照办）：${human.guidance.slice(-3).join("；")}`]
            : []),
        `- 进度：工作项 ${done}/${itemTotal} 完成`
            + `，剩余 ${remaining.length > 0 ? remaining.slice(0, 12).join(", ") : "（无）"}`,
        `- ⚠️ **不要重做已经记成 completed 的写操作**：幂等缓存（completed_tool_call）会拦，`
            + `重复执行只会浪费预算并可能覆盖已验收的产物`,
        green === null || total === null
            ? `- 上次验收：账本里没有读数（下一轮按首次预演处理）`
            : `- 上次验收：${green}/${total} 判据绿（这是**回归冻结基线**，别把已经绿的搞红）`,
        ...(pause.lastError ? [`- 上次的失败：${pause.lastError.slice(0, 200)}`] : []),
    ];
    return { continuation: pause.extensionsUsed + 1, lines: clip(lines.join("\n"), RESUME_BRIEF_CLIP).split("\n") };
}

/** resume brief 的纯文本（直接拼进 DeveloperInstructions；没有暂停记录时返回 ""） */
export function resumeBriefText(brief: ResumeBrief | null): string {
    return brief ? brief.lines.join("\n") : "";
}

/**
 * 从账本取**最近几次工具调用的短摘要**（brake_paused 里那几行，给续跑一个"从哪停下"的锚点）。
 *   只吃 events（tool_call_summary 由 runner 在暂停时写入），不做任何 IO。
 */
export function recentToolDigest(events: BrakeLedgerEvent[]): string[] {
    for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i];
        if (!ev || ev.type !== "brake_paused") continue;
        const d = (ev.payload as Record<string, unknown> | null)?.["toolDigest"];
        if (Array.isArray(d)) return d.map(String).slice(0, 5);
        return [];
    }
    return [];
}

/** 确定性题号：`brake-<taskId>-<n>`（与 confirm.ts 的建题幂等配套：同号不重复建题） */
export function brakeQuestionId(taskId: string, n: number): string {
    return `brake-${taskId}-${n}`;
}

/**
 * 组题：**必须带真数字**——人拿到的不是"超时了"，而是"跑了多久/还剩几个工作项/几调"。
 *   模板照抄 escalation.ts 的四段（我在做什么 / 我试过什么 / 我判断的问题 / 需要你决定什么），
 *   只是把"我试过什么"换成"账目"（这类问题要的正是账，不是心路）。
 *   题号**确定性**（brake-<taskId>-<n>）：下一次拉起来会重新问同一道题，
 *   人在停机期间答过就消费那个答案（HttpQuestioner 建题幂等 + 轮询取答，见 confirm.ts）。
 */
export function brakeQuestion(
    status: BrakeStatus,
    s: BrakeSummary,
    n: number,
    options: readonly string[] = brakeOptions(s.extendMinutes),
): BrakeQuestion {
    const checks = s.checksTotal === null || s.checksGreen === null
        ? "验收判据：账本里没有读数（还没开跑验收）"
        : `验收判据：${s.checksGreen}/${s.checksTotal} 绿`;
    const left = s.remaining.length > 0
        ? `剩余 ${s.remaining.length}/${s.workItemsTotal} 个工作项（${s.remaining.slice(0, 8).join(", ")}）`
        : "工作项已全部完成（停在验收/收口前）";
    const decisions = options.map((o, i) => `  ${i + 1}) ${o}`).join("\n");
    const prompt = [
        `【我在做什么】任务 ${s.taskId}｜当前状态 ${s.status}｜已改 ${s.changedFiles} 个文件`,
        `【账目】`,
        `  · 墙钟：${formatElapsed(status.elapsedMs)}/${formatElapsed(status.maxWallMs)}`
            + `（无人值守天花板 ${formatMinutes(s.hardWallMs)}）`,
        `  · LLM：${s.callsCompleted}/${s.callsAllowance} 调（天花板 ${s.hardCalls} 调）`,
        `  · 工作项：${s.workItemsDone}/${s.workItemsTotal} 完成；${left}`,
        `  · 工具调用 ${s.toolCalls} 次｜修复尝试 ${s.repairAttempts} 次｜${checks}`,
        `【我判断的问题】${brakeReasonLabel(status.reason ?? "wall_clock")}到点了（第 ${n} 次检查点）`
            + `：${s.lastError ? `最近一次失败：${s.lastError.slice(0, 300)}` : "当前没有未处理的失败"}`,
        `  到点不等于判死：我在这里**停手等你 ${formatMinutes(s.waitMs)}**（这段时间零模型调用、零写盘）。`,
        `  你说继续，我就加时 ${s.extendMinutes} 分钟接着干；你一直不答，我就干净地退出进程、`
            + `把任务原样留在 ${s.taskId} 的账本里，下次拉起来接着干。`,
        `【需要你决定什么】`,
        decisions,
        `直接回复序号或文字都可以；若你有别的判断，写下来，我照办。`,
    ].join("\n");
    return { questionId: brakeQuestionId(s.taskId, n), prompt, options: [...options] };
}

/**
 * 进展报告（进账本 brake_paused / brake_progress_report，也进最终收口的报告）。
 *   人问"为什么停"时看到的是它：**做了什么 / 还差什么 / 证据**，不是一句"失败"。
 */
export function buildProgressReport(status: BrakeStatus, s: BrakeSummary, verdict: string): {
    reason: string;
    text: string;
    payload: Record<string, unknown>;
} {
    const left = s.remaining.length > 0
        ? `${s.remaining.length}/${s.workItemsTotal} 个工作项未完成：${s.remaining.slice(0, 12).join(", ")}`
        : "工作项已全部完成（剩余风险在验收/收口环节）";
    const checks = s.checksTotal === null || s.checksGreen === null
        ? "验收判据无读数"
        : `${s.checksGreen}/${s.checksTotal} 绿`;
    const reason = clip(`${brakeReasonText(status)}｜${verdict}`);
    const details = clip([
        `【已完成】工作项 ${s.workItemsDone}/${s.workItemsTotal}｜改动 ${s.changedFiles} 个文件`
            + `｜工具调用 ${s.toolCalls} 次｜修复尝试 ${s.repairAttempts} 次｜验收 ${checks}`,
        `【还差什么】${left}`,
        `【为什么停】${s.lastError ? s.lastError.slice(0, 400) : "没有未处理的失败；就是账目到点了"}`,
        `【证据】账本（brake_paused / brake_extended / acceptance_criteria_status 事件）＋工作区改动（未回滚）`,
        `【消耗】墙钟 ${formatElapsed(status.elapsedMs)}/${formatElapsed(status.maxWallMs)}`
            + `（无人值守天花板 ${formatMinutes(s.hardWallMs)}）｜LLM ${s.callsCompleted}/${s.callsAllowance} 调`
            + `（天花板 ${s.hardCalls} 调）｜加时 ${s.extensionsUsed} 次`,
    ].join("\n"));
    return {
        reason,
        text: `${reason}\n${details}`,
        payload: {
            reason: status.reason, hard: status.hard, verdict,
            elapsedMs: status.elapsedMs, maxWallMs: status.maxWallMs, hardWallMs: s.hardWallMs,
            callsCompleted: s.callsCompleted, callsAllowance: s.callsAllowance, hardCalls: s.hardCalls,
            workItemsDone: s.workItemsDone, workItemsTotal: s.workItemsTotal, remainingWorkItems: s.remaining,
            changedFiles: s.changedFiles, toolCalls: s.toolCalls, repairAttempts: s.repairAttempts,
            checksGreen: s.checksGreen, checksTotal: s.checksTotal,
            extensionsUsed: s.extensionsUsed, lastError: s.lastError,
        },
    };
}

// ============================================================
//  静默等待：问出去，然后**安静地**等（零模型调用、零写盘、零干活）
// ============================================================

/** 等待结果：拿到答案 / 等到窗口结束都没等到 */
export interface BrakeAskResult {
    answer: string | null;
    /** true = 静默窗口内没有人确认（调用方据此走"保状态退出"） */
    timedOut: boolean;
    waitedMs: number;
}

/**
 * 问人 + 静默等待：把题交给问答器（它内部就是轮询：Web 跑法读 sys_confirm 行、
 * CLI 读 stdin、AUTO_CONFIRM 立刻返 "y"），最多等 `waitMs`。
 *
 *   ★ **安静**的含义（老板口径"静默一段时间等待确认"）：
 *     这段时间里**不发任何模型请求、不写盘、不干活**——只有一个 sleep/轮询在跑。
 *     所以本函数刻意不接任何"顺手做点事"的钩子。
 *   ★ 超时语义：等不到答案**不是错误**，是"人不在"；调用方必须走"保状态退出"，
 *     绝不据此判 blocked/failed（老板：不杀了）。
 */
export async function askBrakeQuietly(
    question: BrakeQuestion,
    asker: BrakeQuestioner,
    waitMs: number,
): Promise<BrakeAskResult> {
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), Math.max(0, waitMs));
    });
    try {
        const raced = await Promise.race([
            asker.ask(question).then((answer) => ({ timedOut: false as const, answer })),
            timeout,
        ]);
        const waitedMs = Date.now() - startedAt;
        if (raced.timedOut) return { answer: null, timedOut: true, waitedMs };
        return { answer: raced.answer ?? "", timedOut: false, waitedMs };
    } finally {
        if (timer) clearTimeout(timer);
    }
}

// ============================================================
//  一行一条状态迁移日志（老板要求：ask / 继续 / 暂停 / 收口 各一条，清清楚楚）
// ============================================================

/** 到点问人：`⏱ [BRAKE] 到点 → 问人（第 N 次检查点，题号 brake-t1-1，静默等你 30 分钟）` */
export function brakeAskLogLine(status: BrakeStatus, question: BrakeQuestion, waitMs: number): string {
    return `⏱ [BRAKE] ${brakeReasonLabel(status.reason ?? "wall_clock")}到点 → 问人：`
        + `${brakeReasonText(status)}；题号 ${question.questionId}，静默等确认 ${formatMinutes(waitMs)}`
        + `（零模型调用、零写盘）`;
}

/** 人答继续：`▶ [BRAKE] 人答继续 → 加时 30 分钟，新期限 ...，接着开工` */
export function brakeResumedLogLine(status: BrakeStatus, policy: BrakePolicy, decision: BrakeDecision, now: number): string {
    return `▶ [BRAKE] 人答「${decision.raw.slice(0, 60)}」 ⇒ 继续（第 ${policy.extensionsUsed} 次加时）：`
        + `+${policy.extendMinutes} 分钟，新期限 ${new Date(policy.deadlineAt).toISOString()}`
        + `（还有 ${formatElapsed(Math.max(0, policy.deadlineAt - now))}），接着开工`;
}

/** 等不到确认：`🌙 [BRAKE] 静默等满 30 分钟没人确认 → 保状态退出（任务留在 waiting_human，下次拉起来接着干）` */
export function brakePausedLogLine(waitedMs: number, question: BrakeQuestion, reportText: string): string {
    return `🌙 [BRAKE] 静默等满 ${formatElapsed(waitedMs)} 没人确认 → **保状态退出**：`
        + `任务留在 waiting_human（题号 ${question.questionId} 不清，下次拉起来问同一道题），`
        + `进展报告已落账本 brake_paused；${reportText.split("\n")[0] ?? ""}`;
}

/** 收口：`🧱 [BRAKE] 收口：...（无人值守天花板 / 人选择收口）` */
export function brakeFinalizedLogLine(status: BrakeStatus, verdict: string): string {
    return `🧱 [BRAKE] 收口：${verdict}（${brakeReasonText(status)}）`;
}
