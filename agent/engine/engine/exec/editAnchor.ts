// ============================================================
// editAnchor.ts —— 编辑锚点失配的结构化恢复（纯函数，零 LLM）
//
//   缺口（当前实现）：edit 的 old_text 逐字找不到就只报错，模型只能反复重试整文件重写——
//   既贵又容易改错地方。对标行业做法，这里补两级结构化降级：
//
//     ① **归一化窗口匹配**：逐行 trim 后比较整段锚点；仅在**唯一命中**时采用（多处命中一律拒绝，
//        宁可让模型重新锚定，也不要在错的地方落刀）。命中时如实告知"按忽略缩进命中，第 N 行"。
//     ② **相似位置候选**：都失败时给出最相似的前 3 个位置（行号 + 片段），把"重试"变成"照着改"。
//
//   纪律：归一化匹配**不改变**替换语义（仍然整体替换该窗口），且必须通过调用方的闸门校验后才落盘。
// ============================================================

export interface NormalizedMatch {
    /** 命中窗口在原文件中的字符区间 [start, end) */
    start: number;
    end: number;
    /** 起始行号（1-based），用于告知与日志 */
    line: number;
    /** 窗口覆盖的行数 */
    lines: number;
}

export interface AnchorCandidate {
    line: number;
    /** 该位置附近的原文片段（截断） */
    snippet: string;
    /** 行匹配比例 0~1 */
    score: number;
}

interface LineInfo { text: string; start: number; end: number }

function splitLines(src: string): LineInfo[] {
    const out: LineInfo[] = [];
    let start = 0;
    for (let i = 0; i <= src.length; i++) {
        if (i === src.length || src[i] === "\n") {
            out.push({ text: src.slice(start, i), start, end: i });
            start = i + 1;
        }
    }
    return out;
}

/**
 * 归一化窗口匹配：把锚点与文件都按行 trim 后比较，返回**唯一**命中窗口；0 处或多处都返回 null。
 * 特意要求"整段全部行都匹配"（而不是子集），避免把无关代码块当成锚点。
 */
export function findNormalizedWindow(current: string, oldText: string): NormalizedMatch | null {
    const target = oldText.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    if (target.length === 0) return null;
    const lines = splitLines(current);
    const hits: NormalizedMatch[] = [];
    for (let i = 0; i + target.length <= lines.length; i++) {
        let all = true;
        for (let k = 0; k < target.length; k++) {
            if ((lines[i + k]?.text ?? "").trim() !== target[k]) { all = false; break; }
        }
        if (!all) continue;
        hits.push({ start: lines[i]!.start, end: lines[i + target.length - 1]!.end, line: i + 1, lines: target.length });
        if (hits.length > 1) return null;          // ★ 多处命中一律拒绝（防改错地方）
    }
    return hits[0] ?? null;
}

/** 相似位置候选：按"锚点行在该处出现的比例"排序，供模型照着重新锚定 */
export function findAnchorCandidates(current: string, oldText: string, top = 3): AnchorCandidate[] {
    const target = oldText.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    if (target.length === 0) return [];
    const lines = splitLines(current);
    const first = target[0]!;
    const scored: AnchorCandidate[] = [];
    for (let i = 0; i < lines.length; i++) {
        const text = (lines[i]?.text ?? "").trim();
        if (!text && !first) continue;
        // 以"锚点首行"为锚，算该窗口内命中行占比（窗口不足则按实际行数算）
        if (!text.includes(first) && !first.includes(text)) continue;
        let matched = 0;
        const span = Math.min(target.length, lines.length - i);
        for (let k = 0; k < span; k++) {
            const line = (lines[i + k]?.text ?? "").trim();
            if (target.includes(line)) matched++;
        }
        const score = span > 0 ? matched / target.length : 0;
        if (score <= 0) continue;
        scored.push({
            line: i + 1,
            snippet: lines.slice(i, i + Math.min(3, lines.length - i)).map(l => l.text.trim()).join(" ⏎ ").slice(0, 120),
            score,
        });
    }
    return scored.sort((a, b) => b.score - a.score || a.line - b.line).slice(0, top);
}

/** 候选渲染成给模型看的一段话（可直接拼进工具结果） */
export function renderAnchorCandidates(cands: AnchorCandidate[]): string {
    if (cands.length === 0) return "未找到相似位置：请先 read 该文件，用现状原文作为锚点。";
    return "最相似的位置（行号 + 原文片段，请据此重新写 old_text）：\n"
        + cands.map(c => `  第 ${c.line} 行（匹配度 ${(c.score * 100).toFixed(0)}%）：${c.snippet}`).join("\n");
}
