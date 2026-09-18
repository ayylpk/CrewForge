// ============================================================
// regression.ts —— 回归冻结（"自己解决问题"的地基之一）
//
//   要治的病（s4 实录，2026-09-17）：
//     「末发 LLM 升档×2 批量改盘 17 文件，把**已经通过的 create** 也改挂（回归）」
//   即：修复动作本身把先前已经通过的东西弄坏了，而**没有任何东西守着已通过项**——
//   下一轮预演只会报"现在有多少条失败"，模型看不出"这几条是我刚弄坏的"。
//   于是它会去重新实现本来就对了的东西，或者干脆换方向，越修越乱。
//
//   本模块做的事（纯函数，零 LLM 可单测）：
//     上一次预演的逐条状态 vs 这一次的逐条状态 → 分出三类：
//       · regressed  ：上次通过、这次失败 ← **回归**，必须点名，并提示"先看你这轮改了什么"
//       · fixed      ：上次失败、这次通过 ← 进展（要如实肯定，防止模型以为没进展而乱换方向）
//       · stillFailing：两次都失败        ← 老问题（按原有修复回路处理）
//
//   点名的价值：模型拿到的是"**你刚刚弄坏了这 2 条**"，而不是"有 3 条失败"——
//   前者把它引向自己的改动（可修），后者引向重写（危险）。
// ============================================================

/** 单条判据在一次预演中的状态 */
export type CriteriaStatus = "pass" | "fail" | "unevaluable";

/** 一次预演的逐条状态快照 */
export type CriteriaMap = Record<string, CriteriaStatus>;

export interface CriteriaDiff {
    /** 首次预演（没有上一次可比）→ 不做回归判定，避免拿"什么都没有"当基线误报 */
    firstRun: boolean;
    /** 上次通过、这次失败：**回归**（修复动作弄坏了已通过项） */
    regressed: string[];
    /** 上次失败、这次通过：进展 */
    fixed: string[];
    /** 两次都失败：老问题 */
    stillFailing: string[];
    /** 这次新出现、上次没见过的判据（不算回归） */
    appeared: string[];
    /** 上次有、这次消失的判据（判据被改/被删——架构师侧的事，不是代码回归） */
    disappeared: string[];
}

/** 逐条比对。prev 为 null = 首次预演（不算回归）。 */
export function diffCriteria(prev: CriteriaMap | null, next: CriteriaMap): CriteriaDiff {
    if (!prev) {
        return {
            firstRun: true,
            regressed: [], fixed: [],
            stillFailing: Object.keys(next).filter((k) => next[k] === "fail"),
            appeared: Object.keys(next), disappeared: [],
        };
    }
    const regressed: string[] = [];
    const fixed: string[] = [];
    const stillFailing: string[] = [];
    const appeared: string[] = [];
    const disappeared: string[] = [];
    for (const [id, status] of Object.entries(next)) {
        const before = prev[id];
        if (before === undefined) { appeared.push(id); continue; }
        if (before === "pass" && status !== "pass") regressed.push(id);
        else if (before !== "pass" && status === "pass") fixed.push(id);
        else if (status === "fail") stillFailing.push(id);
    }
    for (const id of Object.keys(prev)) {
        if (!(id in next)) disappeared.push(id);
    }
    return { firstRun: false, regressed, fixed, stillFailing, appeared, disappeared };
}

/**
 * 渲染给模型的回归警示块。只在真有回归时返回非空——
 * 制造噪音会让模型对提示脱敏（"又有警告"），所以宁可少说。
 */
export function renderRegressionWarning(d: CriteriaDiff): string {
    if (d.firstRun || d.regressed.length === 0) return "";
    return [
        "",
        `🚨 回归警告（${d.regressed.length} 条）：这些判据**上一轮是通过的，现在挂了** —— ${d.regressed.join(", ")}`,
        "   这几乎一定是**你这一轮改动**造成的，不是「本来就没做」。处理口径：",
        "   1) 先回看本轮改了哪些文件（gitDiff 看差异），把改动与这几条判据对上；",
        "   2) 优先**回退或收窄**这次改动，把已通过项恢复通过，再继续做别的；",
        "   3) 不要重写这些判据对应的功能——它们本来是好的。",
    ].join("\n");
}

/** 一行摘要（进台账/日志，便于事后审计"哪一轮弄坏了什么"） */
export function summarizeCriteriaDiff(d: CriteriaDiff): string {
    if (d.firstRun) return `首次预演：失败 ${d.stillFailing.length} / 共 ${d.appeared.length}`;
    const parts = [
        `回归 ${d.regressed.length}${d.regressed.length ? `（${d.regressed.join(",")}）` : ""}`,
        `新修好 ${d.fixed.length}`,
        `仍在失败 ${d.stillFailing.length}`,
    ];
    if (d.appeared.length) parts.push(`新增判据 ${d.appeared.length}`);
    if (d.disappeared.length) parts.push(`判据消失 ${d.disappeared.length}`);
    return parts.join("；");
}
