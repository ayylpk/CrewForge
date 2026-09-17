// ============================================================
// escalation.ts —— 求助（human-in-the-loop）的确定性内核
//
//   设计要点（为什么这么做）：
//   1. **求助不是模型的心情，是代码判定的结果。** 所以触发条件是纯函数
//      （shouldEscalate），对着一组可观测事实求值：同指纹连续 N 轮 / 预算墙钟耗尽 /
//      缺环境 / 破坏性操作 / 需求歧义。模型可以主动问（askHuman 工具），
//      但**该问的时候一定会问**，这条由代码保证，不赌模型自觉。
//   2. **问出来的必须是"人能决策的问题"**。历史教训：`developerBlocked` 只会
//      上报一句"失败"，人拿到这句话做不了任何决定，只能重跑。所以组题模板固定四段：
//      我在做什么 / 我试过什么 / 我判断的问题 / 需要你决定什么（给选项）。
//   3. **答案是新的输入，不是终点。** 解析成 continue / narrow / stop 三个动作，
//      让图继续跑（或按人指定的方向收尾），并把人的自由文本当作指引带进上下文。
//   4. **有界**：MAX_ESCALATIONS_PER_TASK 兜底，问人也救不回来的就如实收尾——
//      问人是能力，不是无限续命。
//   5. 本模块刻意**不 import 上层 GraphFactory**（那里有 HumanQuestion/Questioner），
//      只定义一个结构兼容的类型，避免 developerAgent → 父目录 的循环依赖。
// ============================================================

/** 与 GraphFactory.HumanQuestion 结构兼容（不 import，防循环依赖） */
export interface EscalationQuestion {
    questionId: string;
    prompt: string;
    options?: string[];
}

/** 求助原因：代码判定，枚举即策略清单 */
export type AskReason =
    | "SAME_FAILURE_LOOP"      // 同一失败指纹连续 N 轮，打转
    | "BUDGET_EXHAUSTED"       // 预算/墙钟耗尽而计划未完成
    | "NEEDS_ENV"              // 缺密钥/端口被占/DB 凭据等环境问题
    | "DESTRUCTIVE_ACTION"     // 破坏性不可逆操作，需人授权
    | "SPEC_AMBIGUITY"         // 需求歧义与实现冲突，需产品判断
    | "CONTEXT_OVERFLOW"       // 上下文越窗：这一轮请求**发不出去**（压缩也救不回来）
    | "UNFINISHED_PLAN";       // 保险丝全过但计划单元仍未完成

/** 三个动作：继续 / 降级 / 停止。顺序即默认序——**第一个选项是安全默认**
 *  （AUTO_CONFIRM / 超时无人应答时取它，所以它必须是"最不坏"的那一步）。 */
export const ESCALATION_OPTIONS = [
    "继续：重置保险丝，再给一轮修复预算",
    "降级：缩小交付范围，先交能跑通的部分",
    "停止：按现状收尾并如实上报未完成项",
] as const;

export type EscalationAction = "continue" | "narrow" | "stop";

export interface EscalationDecision {
    action: EscalationAction;
    /** 人给的原始答案（审计用） */
    raw: string;
    /** 判定依据（"命中选项2的『降级』关键词" / "无法解析，按安全默认继续"） */
    note: string;
    /** 人的自由文本指示（非空时带进上下文，作为新的输入） */
    guidance: string | null;
}

/** 一组可观测事实——由 graph/index 侧组装，本模块只做判定，不读全局状态 */
export interface EscalationSnapshot {
    taskId: string;
    status: string;
    /** 当前工作项（没有就 null） */
    workItem?: string | null;
    /** 最近一次失败/阻塞原因（结构化文本） */
    lastError?: string | null;
    /** 失败指纹历史（同指纹连续次数由调用方算好传进来，避免本模块依赖具体实现） */
    sameFailureStreak?: number;
    /** 同指纹连续多少轮算打转 */
    sameFailureLimit?: number;
    budgetExhausted?: boolean;
    wallClockExhausted?: boolean;
    /** 环境类缺口的机器可读描述（如 "缺 ANTHROPIC_AUTH_TOKEN" / "端口 3000 被占"） */
    envGaps?: string[];
    /** 破坏性操作描述（需授权才做） */
    destructive?: string | null;
    /** 需求歧义描述 */
    ambiguity?: string | null;
    /**
     * ★ 上下文越窗（9/17 接线 contextBudget）：非空 = 这一轮的 LLM 请求**发不出去**
     *   （压缩跑过了仍越阻塞线 / 没有摘要口）。由 graph 从 state.contextBlocked 带进来。
     */
    contextOverflow?: string | null;
    /** 计划单元未完成数（>0 表示计划没走完） */
    unfinishedUnits?: number;
    /** 本轮任务已问过几次 */
    escalationsUsed?: number;
    maxEscalations?: number;
}

export interface EscalationTrigger {
    reason: AskReason;
    /** 一句话诊断（进"我判断的问题"段） */
    diagnosis: string;
    /** 我试过什么（逐条，进"我试过什么"段） */
    tried: string[];
}

/** 每任务最多问几次（问人也救不回来的就如实收尾——问人是能力，不是无限续命） */
export const MAX_ESCALATIONS_PER_TASK = 2;
/** 同指纹连续几轮判定为"打转" */
export const SAME_FAILURE_LIMIT = 3;

/**
 * 代码强制的升级判定：按优先级取第一个命中的原因。
 * 顺序有意为之——环境/授权类问题排在打转之前（缺密钥导致的重试，问人能一句话解决，
 * 继续重试只会烧钱）；预算耗尽排最后（它是"该不该继续投入"的商业决定，不是技术故障）。
 */
export function shouldEscalate(s: EscalationSnapshot): EscalationTrigger | null {
    const used = s.escalationsUsed ?? 0;
    if (used >= (s.maxEscalations ?? MAX_ESCALATIONS_PER_TASK)) return null;  // 问够了，不再打扰人

    // ★ 越窗阻塞排第一（9/17）：它是**最急**的一类——请求根本发不出去，任何"再试一次"
    //   都是白费（重试只会再撞同一条线），而且它是**人的一句话就能解决**的：
    //   换个窗口配置 / 拆小任务 / 收窄范围。放在环境缺口之前是因为"消息发不出去"时，
    //   连"缺密钥"这种诊断都送不出去；先让人知道"卡在上下文"更有用。
    if (s.contextOverflow) {
        return {
            reason: "CONTEXT_OVERFLOW",
            diagnosis: `${s.contextOverflow}`
                + `——重试没有意义：压缩已经跑过一轮，压下来的量还不够（或这台部署没接摘要口）`,
            tried: [
                "按 Claude Code 同款机制跑了一遍上下文压缩（整份替换成 边界+摘要+保留段）",
                "压缩后重新量了 token，仍在阻塞线之上",
                s.lastError ? `最近一次失败：${trunc(s.lastError, 600)}` : "本轮没有其它失败证据",
            ],
        };
    }
    if (s.envGaps && s.envGaps.length > 0) {
        return {
            reason: "NEEDS_ENV",
            diagnosis: `环境缺口：${s.envGaps.join("；")}——这类问题我无法靠改代码解决`,
            tried: ["重试过失败的命令", "检查过项目内配置文件"],
        };
    }
    if (s.destructive) {
        return {
            reason: "DESTRUCTIVE_ACTION",
            diagnosis: `需要授权的破坏性操作：${s.destructive}——不可逆，我不擅自执行`,
            tried: ["寻找过非破坏性的替代路径"],
        };
    }
    if (s.ambiguity) {
        return {
            reason: "SPEC_AMBIGUITY",
            diagnosis: `需求歧义：${s.ambiguity}——两种理解都能自洽，取决于你的意图`,
            tried: ["按需求原文最直接的读法实现过", "保留了两处实现的可能位置"],
        };
    }
    const streak = s.sameFailureStreak ?? 0;
    const limit = s.sameFailureLimit ?? SAME_FAILURE_LIMIT;
    if (streak >= limit) {
        return {
            reason: "SAME_FAILURE_LOOP",
            diagnosis: `同一个失败连续 ${streak} 轮没有变化（指纹未变）——我判断这不是"再多试几次"能解决的`,
            tried: [
                `对同一判据修复了 ${streak} 轮`,
                s.lastError ? `最近一次失败：${trunc(s.lastError, 600)}` : "最近一次失败：见台账",
            ],
        };
    }
    if ((s.unfinishedUnits ?? 0) > 0 && (s.budgetExhausted || s.wallClockExhausted)) {
        return {
            reason: "BUDGET_EXHAUSTED",
            diagnosis: s.wallClockExhausted
                ? `墙钟预算耗尽，但计划还有 ${s.unfinishedUnits} 个单元没完成`
                : `调用预算耗尽，但计划还有 ${s.unfinishedUnits} 个单元没完成`,
            tried: ["按计划顺序推进到预算上限", "把已完成的单元全部留在了工作区（未回滚）"],
        };
    }
    if ((s.unfinishedUnits ?? 0) > 0 && (s.sameFailureStreak ?? 0) >= 1 && s.status === "blocked") {
        return {
            reason: "UNFINISHED_PLAN",
            diagnosis: `计划还有 ${s.unfinishedUnits} 个单元未完成，而保险丝已触发`,
            tried: ["走到阻塞前的最后一次尝试见台账 lastError"],
        };
    }
    return null;
}

function trunc(s: string, n: number): string {
    return s.length > n ? `${s.slice(0, n)}…（截断，完整见台账）` : s;
}

/**
 * 组题：固定四段模板，保证人收到的是**能决策的问题**而不是一句"我失败了"。
 * questionId 带 taskId + 原因 + 第几次，天然幂等（HttpQuestioner 建题幂等，
 * 崩溃续跑不会给人重复塞单子）。
 */
export function buildEscalationQuestion(t: EscalationTrigger, s: EscalationSnapshot): EscalationQuestion {
    const used = (s.escalationsUsed ?? 0) + 1;
    const what = `任务 ${s.taskId}${s.workItem ? `｜工作项 ${s.workItem}` : ""}｜当前状态 ${s.status}`;
    const tried = t.tried.length > 0 ? t.tried.map((x, i) => `  ${i + 1}. ${x}`).join("\n") : "  （无）";
    const decisions = ESCALATION_OPTIONS.map((o, i) => `  ${i + 1}) ${o}`).join("\n");
    const prompt = [
        `【我在做什么】${what}`,
        `【我试过什么】`,
        tried,
        `【我判断的问题】${t.diagnosis}`,
        `【需要你决定什么】（第 ${used} 次求助）`,
        decisions,
        `直接回复序号或文字都可以；若你有别的判断，写下来，我照办。`,
    ].join("\n");
    return {
        questionId: `esc-${s.taskId}-${t.reason}-${used}`,
        prompt,
        options: [...ESCALATION_OPTIONS],
    };
}

/** 选项关键词表：确定性解析，不猜语义（宁保守不激进） */
const ACTION_KEYWORDS: { action: EscalationAction; words: string[] }[] = [
    { action: "stop", words: ["停止", "停下", "中止", "收尾", "结束", "别做了", "不用了", "别继续", "不要继续", "别再", "stop", "abort", "quit", "halt"] },
    { action: "narrow", words: ["降级", "缩小", "缩减", "砍", "先交", "范围", "narrow", "reduce", "scope", "partial"] },
    { action: "continue", words: ["继续", "接着", "再试", "重试", "go on", "continue", "retry", "keep going", "proceed"] },
];

/**
 * 否定式优先闸（实测 bug 修复）：
 *   "别继续做了，停" 会被 continue 的"继续"命中 → 判成 continue。
 *   人说"别继续"却还在干，是比"多问一次"严重得多的错误（方向反了），
 *   所以凡是「否定词 + 继续类动词」的组合，一律先判 stop。
 */
const NEGATED_CONTINUE = /(别|不要|不用|不必|无需|先别|停止|中止)[^。！？，,]{0,6}(继续|接着|再试|重试|做|干)/;

/**
 * 答案 → 动作。规则（有序，先匹配 stop，再 narrow，再 continue）：
 *   · 空 / "y" / "yes" / "是" → continue（AUTO_CONFIRM 与超时默认走这条，
 *     与"选项1=安全默认"一致，且次数有界，不会无限续命）
 *   · 选项序号 "1"/"2"/"3" → 对应动作
 *   · 否定式（"别继续做了"）→ stop（**先于**关键词表判定）
 *   · 关键词命中 → 对应动作
 *   · 其余非空文本 → 视为"人的指示"，动作 conservative 取 continue，文本进 guidance
 */
export function parseEscalationAnswer(answer: string): EscalationDecision {
    const raw = (answer ?? "").trim();
    if (raw === "" || /^(y|yes|是|ok|好的)$/i.test(raw)) {
        return { action: "continue", raw, note: "自动/默认应答 → 按安全默认（继续，次数有界）", guidance: null };
    }
    const idx = raw.match(/^([123])[).、．\s]?$/);
    if (idx) {
        const n = Number(idx[1]);
        const action: EscalationAction = n === 1 ? "continue" : n === 2 ? "narrow" : "stop";
        return { action, raw, note: `命中选项序号 ${n}`, guidance: null };
    }
    if (NEGATED_CONTINUE.test(raw)) {
        return { action: "stop", raw, note: "否定式（别继续/不要继续 等）→ stop", guidance: null };
    }
    for (const row of ACTION_KEYWORDS) {
        if (row.words.some(w => raw.toLowerCase().includes(w.toLowerCase()))) {
            return { action: row.action, raw, note: `命中「${row.action}」关键词`, guidance: null };
        }
    }
    return {
        action: "continue", raw,
        note: "未命中选项/关键词 → 当作人的自由指示处理，按 continue 继续并把原话带进上下文",
        guidance: raw,
    };
}

/** 汇总一行（进台账/上报），便于事后审计"为什么问了人、人怎么答的" */
export function describeEscalation(t: EscalationTrigger, q: EscalationQuestion, d: EscalationDecision): string {
    return `求助[${t.reason}] ${q.questionId} → 人答「${trunc(d.raw, 80)}」 ⇒ ${d.action}（${d.note}）`;
}
