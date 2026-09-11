// ============================================================
// contextBudget.ts —— 上下文预算与优先级裁剪（纯函数，零 LLM）
//
//   为什么要它：
//     ① **成本**：每一轮 prompt 的易变段里塞着"本任务其他文件全文/现有文件全文/磁盘树"，
//        这些内容 token 占比最大、价值最低；DeepSeek 缓存只按前缀命中，易变段的膨胀是纯支出。
//     ② **质量**：prompt 过长会把关键指令挤到注意力外围（契约/纪律/返工意见被淹没）。
//
//   纪律：**绝不静默丢弃**。裁剪必须显式标注，并返回 dropped/truncated 供日志与报告引用。
//   essential 段永不裁剪；其余按优先级降序填充，装不下的软段截断（带标注）或整体丢弃。
// ============================================================

export interface ContextPiece {
    name: string;
    text: string;
    /** 数值越大越先保留 */
    priority: number;
    /** true = 不可丢、不可截（契约/返工意见/纪律/任务契约） */
    essential?: boolean;
    /** 允许截断（默认 true）；false = 装不下就整段丢 */
    truncatable?: boolean;
}

export interface ContextFitResult {
    text: string;
    /** 被整体丢弃的段名 */
    dropped: string[];
    /** 被截断的段名 */
    truncated: string[];
    /** 实际字符数 */
    chars: number;
    budgetChars: number;
}

const TRUNCATE_MARK = "\n…（本节按上下文预算截断，完整内容见项目文件）";

/**
 * 按预算装配上下文。
 * 顺序：先放 essential（按输入顺序，保证稳定性），再按 priority 降序放其余段。
 * 输出顺序 = 输入顺序（保证同一输入下输出逐字节稳定 → 缓存友好）。
 */
export function fitContext(pieces: ContextPiece[], budgetChars: number): ContextFitResult {
    const clean = pieces.map(p => ({ ...p, text: (p.text ?? "").trim() })).filter(p => p.text.length > 0);
    const essential = clean.filter(p => p.essential);
    const optional = clean.filter(p => !p.essential);
    const essentialChars = essential.reduce((n, p) => n + p.text.length, 0);

    // essential 自己就超预算：如实告知（不静默），但**不裁 essential**——宁可超预算也不丢判据材料
    const remaining = Math.max(0, budgetChars - essentialChars);

    const sorted = [...optional].sort((a, b) => b.priority - a.priority);
    const keep = new Map<string, string>();
    const dropped: string[] = [];
    const truncated: string[] = [];
    let used = 0;
    for (const p of sorted) {
        if (used + p.text.length <= remaining) {
            keep.set(p.name, p.text);
            used += p.text.length;
            continue;
        }
        const left = remaining - used;
        const canTruncate = p.truncatable !== false;
        if (canTruncate && left > 400) {            // 少于 400 字不值得留半截
            keep.set(p.name, p.text.slice(0, left) + TRUNCATE_MARK);
            truncated.push(p.name);
            used = remaining;
        } else {
            dropped.push(p.name);
        }
    }

    const text = clean
        .map(p => (p.essential ? p.text : keep.get(p.name)))
        .filter((x): x is string => typeof x === "string" && x.length > 0)
        .join("");

    return { text, dropped, truncated, chars: text.length, budgetChars };
}

/** 预算默认值：约 6~8k token 的中文混合内容（易变段） */
export const DEFAULT_CONTEXT_BUDGET = 24_000;

/** 一行可读摘要（进日志/报告，便于回答"这次为什么变慢了/贵了"） */
export function describeFit(r: ContextFitResult): string {
    const parts = [`易变段 ${r.chars}/${r.budgetChars} 字符`];
    if (r.truncated.length) parts.push(`截断 ${r.truncated.join("、")}`);
    if (r.dropped.length) parts.push(`丢弃 ${r.dropped.join("、")}`);
    return parts.join("；");
}
