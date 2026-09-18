// ============================================================
// promptPrefix.ts —— 提示词装配（C-1：前缀稳定化，纯函数零 LLM）
//
//   为什么需要它：
//     DeepSeek/OpenAI 系上下文缓存是**前缀命中**（相同前缀按缓存价计费）。只要前缀里混进
//     任何易变内容（时间戳、随机 id、随写盘增长的文件树），后续调用就全部退化为全价，
//     而且这种退化**静默无声**。此处把顺序钉死在一个地方，并用指纹做回归断言。
//
//   纪律：
//     · 稳定段（角色/基线/契约/文件树快照/工具协议）按固定顺序拼接，同任务内逐字节一致
//     · **易变段一律只能追加在稳定段之后**（任务 JSON、目标文件路径、已写文件、反馈）
//     · 稳定段里禁止出现：时间戳、UUID、随机数、随进度增长的内容（文件树必须是快照）
// ============================================================

export interface StableSections {
    /** 工位角色提示词（内置或用户追加后的最终文本） */
    role: string;
    /** 技术基线块 */
    baseline?: string;
    /** 项目契约（CONTRACTS 注入块） */
    contract?: string;
    /** 文件树快照（★ C-3：整任务只算一次，不随写盘增长） */
    fileTree?: string;
    /** 工具协议（工具模式才有；老路为空） */
    toolProtocol?: string;
}

/** 固定装配顺序（改动此数组=改变缓存命中面，必须同步更新 prompt-prefix-smoke 的期望） */
export const STABLE_ORDER = ["role", "baseline", "contract", "fileTree", "toolProtocol"] as const;

/** 稳定前缀：定序拼接，空段跳过（不留多余分隔符，保证字节级确定） */
export function buildStablePrefix(s: StableSections): string {
    return STABLE_ORDER
        .map(k => (s[k] ?? "").trim())
        .filter(x => x.length > 0)
        .join("\n\n");
}

/** 易变段：追加在稳定前缀之后，顺序由调用方给定（任务 → 文件 → 已有内容 → 反馈） */
export function buildVolatileSection(parts: (string | undefined | null)[]): string {
    return parts.map(p => (p ?? "").trimEnd()).filter(p => p.length > 0).join("");
}

/** 完整提示词 = 稳定前缀 + 易变段 */
export function assemblePrompt(stable: StableSections, volatileParts: (string | undefined | null)[]): string {
    return buildStablePrefix(stable) + buildVolatileSection(volatileParts);
}

/**
 * 前缀指纹（FNV-1a 32bit，十六进制）——用于：
 *   · 冒烟断言"同族调用前缀一致"
 *   · 跑批时打日志，事后可核"缓存本该命中却没命中"的批次
 */
export function fingerprint(text: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
}

/** 稳定段卫生检查：命中任一模式即视为"易变内容混入稳定段"（返回原因，空数组=干净） */
const VOLATILE_LEAK_PATTERNS: [RegExp, string][] = [
    [/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "ISO 时间戳"],
    [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i, "UUID"],
    [/\b\d{10,13}\b/, "毫秒时间戳"],
    [/[0-9a-f]{32,}/i, "长随机串/哈希"],
];
export function findVolatileLeak(stableText: string): string[] {
    return VOLATILE_LEAK_PATTERNS.filter(([re]) => re.test(stableText)).map(([, why]) => why);
}
