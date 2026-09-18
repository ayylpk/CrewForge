// ============================================================
// contextBudget.ts —— Claude Code 上下文压缩机制的移植
//
//   ★ 目标是**机制一致**，不是逐行照抄。下面这张表是验收口径：
//     每一项都能"指着源码的哪一段 + 指着本文件的哪一段"对上，机制才算合上。
//
//   ┌─ 机制必合项 ────────────────────┬─ 源码 ──────────────────────────┬─ 本文件 ──┐
//   │ ① 什么时候压（量的是什么）      │ utils/tokens.ts:226-261         │ §3        │
//   │   tokenCountWithEstimation：     │ （CANONICAL 口径）+          │ §12       │
//   │   最后一次 API 响应的 usage      │ autoCompact.ts:93-145,        │           │
//   │   （input+cache_create+cache_    │ 160-239                       │           │
//   │   read+output）＋其后新增的估算；│                               │           │
//   │   与 threshold 比，>= 即触发     │                               │           │
//   │ ② 压什么                         │ microCompact.ts:41-50,        │ §5        │
//   │   微压缩只碰白名单工具的          │ 456-492；compact.ts:445-491   │ §9        │
//   │   tool_result（保留最近 N 条）；  │                               │           │
//   │   宏压缩把边界之后的整段对话      │                               │           │
//   │   交给摘要调用（tools 关、        │                               │           │
//   │   thinking 关、系统提示词固定）   │                               │           │
//   │ ③ 保留什么 / 丢什么 / 什么顺序   │ compact.ts:330-338；          │ §9        │
//   │   preserve：边界标记→摘要→保留段  │ sessionMemoryCompact.ts:       │ §10       │
//   │   →附件→hooks；丢：被摘要覆盖的   │ 324-397, 232-314              │           │
//   │   那一段；保留段按 minTokens/     │                               │           │
//   │   minTextBlockMessages/maxTokens  │                               │           │
//   │   三闸切片且不许劈开 tool 配对    │                               │           │
//   │ ④ 边界怎么表示                   │ utils/messages.ts:4530-4555,  │ §7        │
//   │   system 消息 subtype=           │ 4608-4657                     │           │
//   │   'compact_boundary' +           │                               │           │
//   │   compactMetadata{trigger,       │                               │           │
//   │   preTokens}；"最后一道边界之后   │                               │           │
//   │   才是活的对话"是切分语义         │                               │           │
//   │ ⑤ 摘要怎么回灌                   │ prompt.ts:337-373；           │ §8        │
//   │   一条 isCompactSummary 的 user  │ compact.ts:613-624；          │ §9        │
//   │   消息，抬头是"续上一次被截断的   │ compact.ts:330-338            │           │
//   │   会话"＋格式化后的摘要；自动压缩 │                               │           │
//   │   再追加"接着干、别寒暄"          │                               │           │
//   └─────────────────────────────────┴───────────────────────────────┴───────────┘
//
//   可以随宿主变（**有意偏离，已逐条列在 contextBudget.wiring.md 的适配清单里**）：
//     · 阈值里的**窗口输入**（contextWindowSource：`[1m]` 后缀 / CF_CONTEXT_WINDOW_TOKENS /
//       cc 的 200_000 常数兜底）——公式不变，只换输入，并且返回 provenance 让人看得出
//       这个数是事实还是假设；
//     · 名字/文件布局/签名/代码风格；
//     · 摘要提示词的措辞（本移植**照抄**了 cc 的原文，属"可以改但没必要改"）；
//     · cc 专有而本宿主没有的东西（交互 UI、slash 命令、客户端内部结构）→ 取最近等价物或省略。
//
//   不许发生：换一套机制；或者在源码读不到的地方**悄悄**近似。
//   读不到的地方逐条写在同目录 `contextBudget.wiring.md` §4（哪个文件、读不到什么、
//   用了什么等价物、为什么），代码里对应位置也有 `【缺口】` 标记。
// ============================================================

// ============================================================
// 章节 ↔ 源码文件对照
//
//     services/tokenEstimation.ts     → §1
//     utils/context.ts                → §2
//     utils/tokens.ts                 → §3
//     services/compact/timeBasedMCConfig.ts → §4
//     services/compact/microCompact.ts      → §5
//     services/compact/grouping.ts          → §6
//     utils/messages.ts（压缩相关）          → §7
//     services/compact/prompt.ts            → §8（逐字提示词）
//     services/compact/compact.ts           → §9
//     services/compact/sessionMemoryCompact.ts → §10
//     services/compact/apiMicrocompact.ts   → §11
//     services/compact/autoCompact.ts       → §12
//     services/compact/postCompactCleanup.ts→ §13
//     （本仓库新增的接线壳，唯一的非移植部分）→ §0 / §14
// ============================================================

import { randomUUID } from "node:crypto";

// ============================================================
// §0 类型与适配层（【适配】—— cc 的 Message 形状 vs CrewForge 的扁平 history）
//
//   cc 的对话是 `Message[]`：{type:'user'|'assistant'|'system'|'attachment', ...}，
//   assistant 的 content 里有 tool_use 块（带 id），user 的 content 里有配对的
//   tool_result 块（带 tool_use_id）。压缩的全部算法都建立在这套形状上
//   （collectCompactableToolIds 靠 tool_use.id 配对、adjustIndexToPreserveAPIInvariants
//   靠 tool_use/tool_result 配对不劈开、buildPostCompactMessages 靠 message.uuid 串链）。
//
//   CrewForge 的 `runToolLoop` 里是一个**扁平**数组：
//     { tool, args, ok, output, rejected?, evidence? } | { error } | { reminder }
//   没有 id、没有 role、没有配对。所以必须先适配成 cc 形状，压缩才谈得上移植。
//   【适配】adapter 是双向的、可逆的（toolUseId 用下标确定性生成），
//   并且**不改变任何压缩算法**——算法看到的就是 cc 的形状。
// ============================================================

export type Usage = {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
};

export type TextBlock = { type: "text"; text: string };
export type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };
export type ToolResultBlock = {
    type: "tool_result";
    tool_use_id: string;
    content: string | ContentBlock[];
    is_error?: boolean;
};
export type ThinkingBlock = { type: "thinking"; thinking: string };
export type RedactedThinkingBlock = { type: "redacted_thinking"; data: string };
/** 【适配】cc 的 ImageBlockParam / DocumentBlockParam；本仓库目前不产生，但 stripImagesFromMessages
 *  是照抄过来的，保留类型才能让那段逻辑原样成立（将来接图片/PDF 时不用改压缩器）。 */
export type ImageBlock = { type: "image"; source?: unknown };
export type DocumentBlock = { type: "document"; source?: unknown };
export type ContentBlock =
    | TextBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock | RedactedThinkingBlock
    | ImageBlock | DocumentBlock;

export type UserMessage = {
    type: "user";
    uuid: string;
    timestamp: string;
    message: { content: string | ContentBlock[] };
    isMeta?: boolean;
    isCompactSummary?: boolean;
    isVisibleInTranscriptOnly?: boolean;
    /** 【适配】cc 的来源标记（snip 用）；CrewForge 不用，留字段是为了形状一致 */
    origin?: { kind: string };
};
export type AssistantMessage = {
    type: "assistant";
    uuid: string;
    timestamp: string;
    message: { id: string; model?: string; content: ContentBlock[]; usage?: Usage };
    isApiErrorMessage?: boolean;
};
export type AttachmentMessage = {
    type: "attachment";
    uuid: string;
    timestamp: string;
    attachment: { type: string; [k: string]: unknown };
};
/** ← utils/messages.ts:4537-4555 createCompactBoundaryMessage 的返回形状 */
export type SystemCompactBoundaryMessage = {
    type: "system";
    subtype: "compact_boundary";
    content: "Conversation compacted";
    isMeta: false;
    timestamp: string;
    uuid: string;
    level: "info";
    compactMetadata: {
        trigger: "manual" | "auto";
        preTokens: number;
        userContext?: string;
        messagesSummarized?: number;
        preCompactDiscoveredTools?: string[];
        preservedSegment?: { headUuid: string; anchorUuid: string; tailUuid: string };
    };
    logicalParentUuid?: string;
};
/** ← utils/messages.ts:4557-4583 createMicrocompactBoundaryMessage 的返回形状 */
export type SystemMicrocompactBoundaryMessage = {
    type: "system";
    subtype: "microcompact_boundary";
    content: "Context microcompacted";
    isMeta: false;
    timestamp: string;
    uuid: string;
    level: "info";
    microcompactMetadata: {
        trigger: "auto";
        preTokens: number;
        tokensSaved: number;
        compactedToolIds: string[];
        clearedAttachmentUUIDs: string[];
    };
};
export type SystemMessage = SystemCompactBoundaryMessage | SystemMicrocompactBoundaryMessage;
export type Message =
    | UserMessage | AssistantMessage | AttachmentMessage | SystemMessage;

/** 【适配】把 cc 松散类型收窄成具体变体的判断函数（源码靠 TS 判别联合，这里靠显式判断） */
export function isAssistantMessage(m: Message): m is AssistantMessage {
    return m.type === "assistant";
}
export function isUserMessage(m: Message): m is UserMessage {
    return m.type === "user";
}
/** ← utils/messages.ts:4608-4612 */
export function isCompactBoundaryMessage(m: Message): m is SystemCompactBoundaryMessage {
    return m.type === "system" && m.subtype === "compact_boundary";
}
export function isMicrocompactBoundaryMessage(m: Message): m is SystemMicrocompactBoundaryMessage {
    return m.type === "system" && m.subtype === "microcompact_boundary";
}

/**
 * 【适配】CrewForge 扁平 history 条目 → cc 的 (assistant tool_use, user tool_result) 对。
 *
 *   一个 CrewForge 条目 `{tool, args, ok, output}` 在 cc 里对应**两条**消息：
 *     ① assistant[id=<agentMessageId>] content=[{type:'tool_use', id:<toolUseId>, name, input}]
 *     ② user          content=[{type:'tool_result', tool_use_id:<toolUseId>, content, is_error}]
 *   这正是 cc 的 query loop 产生的形状（utils/tokens.ts:214-224 的注释描述了它）。
 *
 *   `{error}` / `{reminder}` 条目在 cc 里对应 `isMeta: true` 的 user 文本消息
 *   （cc 用 createUserMessage({content, isMeta:true}) 注入这类指令）。
 *
 *   id 生成：`toolUseId = 'tu-<下标>'`、`agentMessageId = 'msg-<下标>'`。
 *   【适配】cc 用 randomUUID；这里用下标是为了**确定性**（测试要能重放），
 *   功能等价（只要求"同一个 tool_use 的 id 与其 tool_result 的 tool_use_id 相等"）。
 */
export interface HistoryAdapterOptions {
    /** 文件名/工具名 → 供 READ 类工具识别（post-compact 文件回灌用） */
    readToolName?: string;
}

export function historyToMessages(
    history: readonly unknown[],
    _opts: HistoryAdapterOptions = {},
): Message[] {
    const out: Message[] = [];
    const ts = new Date(0).toISOString();      // 【适配】占位时间戳，压缩算法不读它
    for (let i = 0; i < history.length; i++) {
        const raw = history[i];
        const e = (raw !== null && typeof raw === "object" && !Array.isArray(raw))
            ? raw as Record<string, unknown>
            : null;
        if (!e) continue;

        if (typeof e["error"] === "string") {
            out.push({
                type: "user", uuid: `u-err-${i}`, timestamp: ts, isMeta: true,
                message: { content: [{ type: "text", text: e["error"] }] },
            });
            continue;
        }
        if (typeof e["reminder"] === "string") {
            out.push({
                type: "user", uuid: `u-rem-${i}`, timestamp: ts, isMeta: true,
                message: { content: [{ type: "text", text: e["reminder"] }] },
            });
            continue;
        }
        // ★ 【接线补口·9/17】压缩产物两种条目的**回读**（写方在 §14 的 applyCompactionToHistory）。
        //   它往扁平 history 里放两样东西：边界标记（system / compact_boundary）与摘要
        //   （{type:"compaction_summary", text}）。这两样是"压缩后模型看到什么"的一部分，
        //   必须能被本函数读回来，否则接线后有三个真实后果：
        //     ① 量 token 时**漏掉摘要正文**（摘要最多 20K token）⇒ 少算 ⇒ 压缩触发偏晚
        //        ——正是这套机制要防的那个故障；
        //     ② findLastCompactBoundaryIndex 找不到边界 ⇒ 下一次压缩把"边界之前"的
        //        死消息也当成活的对话交给摘要调用（getMessagesAfterCompactBoundary 的语义失效）；
        //     ③ 链式压缩丢掉上一份摘要 ⇒ 模型记忆断档（两次压缩间隔久了必现）。
        //   方向是**单向**补：messagesToHistory 不产出这两种条目（由压缩壳自己放），
        //   所以 §14 的 history 里不会出现"边界/摘要各来两份"。
        if (e["type"] === "compaction_summary" && typeof e["text"] === "string") {
            out.push({
                type: "user", uuid: `s-${i}`, timestamp: ts,
                message: { content: [{ type: "text", text: e["text"] }] },
                isCompactSummary: true,
                isVisibleInTranscriptOnly: true,
            });
            continue;
        }
        if (e["type"] === "system" && e["subtype"] === "compact_boundary") {
            out.push(raw as SystemCompactBoundaryMessage);   // 形状本来就是 cc 的边界消息，原样回读
            continue;
        }
        if (typeof e["tool"] !== "string") continue;   // type:'context' 等 ≠ 对话消息，见 §14 说明

        const toolUseId = `tu-${i}`;
        const args = e["args"] ?? {};
        out.push({
            type: "assistant", uuid: `a-${i}`, timestamp: ts,
            message: {
                id: `msg-${i}`,
                content: [{ type: "tool_use", id: toolUseId, name: e["tool"], input: args }],
            },
        });
        const output = typeof e["output"] === "string" ? e["output"] : "";
        const content: ContentBlock[] = [{ type: "text", text: output }];
        out.push({
            type: "user", uuid: `r-${i}`, timestamp: ts,
            message: {
                content: [{
                    type: "tool_result", tool_use_id: toolUseId,
                    content, is_error: e["ok"] !== true,
                }],
            },
        });
    }
    return out;
}

/** 【适配】cc 形状 → 回填给 realLlm 的渲染层（把 tool_use/tool_result 对重新压成扁平条目） */
export function messagesToHistory(messages: readonly Message[]): unknown[] {
    const out: unknown[] = [];
    const pendingToolUse = new Map<string, { name: string; input: unknown }>();
    for (const m of messages) {
        if (m.type === "assistant" && Array.isArray(m.message.content)) {
            for (const b of m.message.content) {
                if (b.type === "tool_use") pendingToolUse.set(b.id, { name: b.name, input: b.input });
            }
            continue;
        }
        if (m.type === "user" && Array.isArray(m.message.content)) {
            for (const b of m.message.content) {
                if (b.type === "tool_result") {
                    const tu = pendingToolUse.get(b.tool_use_id);
                    out.push({
                        tool: tu?.name ?? "?",
                        args: tu?.input ?? {},
                        ok: b.is_error !== true,
                        output: typeof b.content === "string"
                            ? b.content
                            : b.content.map((c) => (c.type === "text" ? c.text : "")).join(""),
                        rejected: null,
                    });
                } else if (b.type === "text" && m.isMeta) {
                    out.push({ error: b.text });
                }
            }
        }
    }
    return out;
}

// ============================================================
// §1 services/tokenEstimation.ts（逐函数移植）
// ============================================================

/** ← tokenEstimation.ts:203-208 */
export function roughTokenCountEstimation(content: string, bytesPerToken = 4): number {
    return Math.round(content.length / bytesPerToken);
}

/** ← tokenEstimation.ts:215-224 */
export function bytesPerTokenForFileType(fileExtension: string): number {
    switch (fileExtension) {
        case "json":
        case "jsonl":
        case "jsonc":
            return 2;
        default:
            return 4;
    }
}

/** ← tokenEstimation.ts:234-242 */
export function roughTokenCountEstimationForFileType(content: string, fileExtension: string): number {
    return roughTokenCountEstimation(content, bytesPerTokenForFileType(fileExtension));
}

/** 【适配】cc 的 jsonStringify 来自 utils/slowOperations.ts（内部是 JSON.stringify 的缓存版） */
export function jsonStringify(v: unknown): string {
    try {
        return JSON.stringify(v) ?? "";
    } catch {
        return "";
    }
}

/** ← tokenEstimation.ts:327-339 */
export function roughTokenCountEstimationForMessages(
    messages: readonly { type: string; message?: { content?: unknown }; attachment?: unknown }[],
): number {
    let totalTokens = 0;
    for (const message of messages) totalTokens += roughTokenCountEstimationForMessage(message);
    return totalTokens;
}

/** ← tokenEstimation.ts:341-369 */
export function roughTokenCountEstimationForMessage(message: {
    type: string;
    message?: { content?: unknown };
    attachment?: unknown;
}): number {
    if ((message.type === "assistant" || message.type === "user") && message.message?.content) {
        return roughTokenCountEstimationForContent(
            message.message.content as string | ContentBlock[] | undefined,
        );
    }
    if (message.type === "attachment" && message.attachment) {
        // 【适配】cc 走 normalizeAttachmentForAPI 把 attachment 展开成 user 消息；
        // 本仓库的 attachment 是纯数据，直接按序列化长度估（口径与 catch-all 一致）。
        return roughTokenCountEstimation(jsonStringify(message.attachment));
    }
    return 0;
}

/** ← tokenEstimation.ts:371-389 */
function roughTokenCountEstimationForContent(content: string | ContentBlock[] | undefined): number {
    if (!content) return 0;
    if (typeof content === "string") return roughTokenCountEstimation(content);
    let totalTokens = 0;
    for (const block of content) totalTokens += roughTokenCountEstimationForBlock(block);
    return totalTokens;
}

/** ← tokenEstimation.ts:391-435 */
function roughTokenCountEstimationForBlock(block: ContentBlock): number {
    if (block.type === "text") return roughTokenCountEstimation(block.text);
    if (block.type === "tool_result") return roughTokenCountEstimationForContent(block.content);
    if (block.type === "tool_use") {
        return roughTokenCountEstimation(block.name + jsonStringify(block.input ?? {}));
    }
    if (block.type === "thinking") return roughTokenCountEstimation(block.thinking);
    if (block.type === "redacted_thinking") return roughTokenCountEstimation(block.data);
    return roughTokenCountEstimation(jsonStringify(block));
}

// ============================================================
// §2 utils/context.ts + services/api/claude.ts 的模型窗口/输出上限
// ============================================================

/** ← context.ts:9 */
export const MODEL_CONTEXT_WINDOW_DEFAULT = 200_000;
/** ← context.ts:12 */
export const COMPACT_MAX_OUTPUT_TOKENS = 20_000;
/** ← context.ts:15-16 */
const MAX_OUTPUT_TOKENS_DEFAULT = 32_000;
const MAX_OUTPUT_TOKENS_UPPER_LIMIT = 64_000;
/** ← context.ts:24-25 */
export const CAPPED_DEFAULT_MAX_TOKENS = 8_000;
export const ESCALATED_MAX_TOKENS = 64_000;

/** ← context.ts:31-33 */
export function is1mContextDisabled(): boolean {
    return isEnvTruthy(process.env["CLAUDE_CODE_DISABLE_1M_CONTEXT"]);
}
/** ← context.ts:35-40 */
export function has1mContext(model: string): boolean {
    if (is1mContextDisabled()) return false;
    return /\[1m\]/i.test(model);
}
/**
 * ← context.ts:43-49。cc 判的是自家 sonnet-4/opus-4-6；
 * 【适配】本仓库跑的是 `.env` 的 `DEVELOPER_LLM_MODEL`（deepseek-v4-*），
 * 名称不在 cc 的表里，所以 `modelSupports1M` 对它们是 false——
 * 与 cc 的**外部**行为一致（1M 只对自家模型自动开，其他要靠 `[1m]` 后缀）。
 */
export function modelSupports1M(model: string): boolean {
    if (is1mContextDisabled()) return false;
    const canonical = model.toLowerCase();
    return canonical.includes("claude-sonnet-4") || canonical.includes("opus-4-6");
}

/**
 * ★ 部署口径的窗口事实（**宿主适配点之一**）。
 *
 *   ⚠️ 这是**低层**入口（env / `[1m]` 后缀 / cc 常数），给 `getCcExactThresholds`
 *   这样的保真对拍用。**生产路径请用 §12.1 的 `resolveContextWindow()`**——
 *   它在此之上加了"用户配置的基准 + 分档覆盖 + 未配置时的默认值 + 告警"，也就是产品的接线面。
 *
 *   机制上"什么时候压缩"是 `eff − eff×13/180` 这条**公式**（见 §12 开头），
 *   与模型无关；公式的输入——**这台部署上模型真有多大的窗口**——才是随宿主变的。
 *   cc 的输入来自它自己的 `getModelCapability()` 服务端能力表（本仓库没有），
 *   退路是它的常数 `MODEL_CONTEXT_WINDOW_DEFAULT = 200_000`。
 *
 *   本层只处理"没有用户配置时怎么退化"：
 *     `[1m]` 后缀 → 1_000_000（cc 同款，本仓库 `.env` 的 pro 档正是 `deepseek-v4-pro[1m]`）
 *     `CF_CONTEXT_WINDOW_TOKENS` → 运维逃生口（**任何情况下都生效**，
 *        取代 cc 那个只对 `USER_TYPE=ant` 生效的 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`）
 *     都没有 → 退回 cc 的 200_000 常数，但 {@link contextWindowSource} 会如实报 "default"。
 */
export function contextWindowSource(model: string, env: EnvLike = process.env): {
    window: number;
    source: "env" | "1m-suffix" | "default";
} {
    // 顺序与 §12.1 的 resolveContextWindow **保持一致**（`[1m]` 在 env 之前）。
    // 不一致会造成自相矛盾：同一个 `deepseek-v4-pro[1m]` 在 getContextWindowForModel 里
    // 认 env、在 getEffectiveContextWindowSize 里认名字，于是"窗口"和"有效窗口"对不上。
    // 模型名来自 sys_settings（比 .env 高一级），要封顶请用 CLAUDE_CODE_AUTO_COMPACT_WINDOW。
    if (has1mContext(model)) return { window: 1_000_000, source: "1m-suffix" };
    const declared = env["CF_CONTEXT_WINDOW_TOKENS"];
    if (declared) {
        const n = parseInt(declared, 10);
        if (!Number.isNaN(n) && n > 0) return { window: n, source: "env" };
    }
    return { window: MODEL_CONTEXT_WINDOW_DEFAULT, source: "default" };
}

/** 【适配】cc 的 EnvLike 形参（便于测试注入，不读真实 process.env 时用） */
export type EnvLike = Record<string, string | undefined>;

/** ← context.ts:51-98（保留 1M beta 与默认值两支；事实入口见 contextWindowSource 注释） */
export function getContextWindowForModel(model: string, betas?: string[]): number {
    // cc 的 ant-only 覆盖：本仓库保留它的名字，行为不变
    if (process.env["USER_TYPE"] === "ant" && process.env["CLAUDE_CODE_MAX_CONTEXT_TOKENS"]) {
        const override = parseInt(process.env["CLAUDE_CODE_MAX_CONTEXT_TOKENS"]!, 10);
        if (!isNaN(override) && override > 0) return override;
    }
    // 【适配】宿主事实入口（取代 cc 的 getModelCapability 服务端能力表）
    const host = contextWindowSource(model);
    if (host.source === "env") return host.window;
    if (host.source === "1m-suffix") return host.window;
    if (betas?.includes("context-1m-2025-08-07") && modelSupports1M(model)) return 1_000_000;
    return MODEL_CONTEXT_WINDOW_DEFAULT;
}

/**
 * ← context.ts:149-210。cc 的按模型名分档表原样保留（换成别家模型时落到 else 档：
 * default 32_000 / upper 64_000，与源码一致）。
 */
export function getModelMaxOutputTokens(model: string): { default: number; upperLimit: number } {
    let defaultTokens: number;
    let upperLimit: number;
    // 容错：spec 可能是调用方手工拼的（model 缺省/undefined），不能让一个缺字段把整条
    // 压缩路径打崩——认不出来就走 else 档，与"未知模型"同一条路。
    const m = String(model ?? "").toLowerCase();

    if (m.includes("opus-4-6")) { defaultTokens = 64_000; upperLimit = 128_000; }
    else if (m.includes("sonnet-4-6")) { defaultTokens = 32_000; upperLimit = 128_000; }
    else if (m.includes("opus-4-5") || m.includes("sonnet-4") || m.includes("haiku-4")) {
        defaultTokens = 32_000; upperLimit = 64_000;
    } else if (m.includes("opus-4-1") || m.includes("opus-4")) { defaultTokens = 32_000; upperLimit = 32_000; }
    else if (m.includes("claude-3-opus")) { defaultTokens = 4_096; upperLimit = 4_096; }
    else if (m.includes("claude-3-sonnet")) { defaultTokens = 8_192; upperLimit = 8_192; }
    else if (m.includes("claude-3-haiku")) { defaultTokens = 4_096; upperLimit = 4_096; }
    else if (m.includes("3-5-sonnet") || m.includes("3-5-haiku")) { defaultTokens = 8_192; upperLimit = 8_192; }
    else if (m.includes("3-7-sonnet")) { defaultTokens = 32_000; upperLimit = 64_000; }
    else { defaultTokens = MAX_OUTPUT_TOKENS_DEFAULT; upperLimit = MAX_OUTPUT_TOKENS_UPPER_LIMIT; }

    return { default: defaultTokens, upperLimit };
}

/** ← claude.ts:3394-3397。`tengu_otk_slot_v1` 的 3P 默认值是 **false**。 */
function isMaxTokensCapEnabled(): boolean {
    return getFeatureValue_CACHED_MAY_BE_STALE("tengu_otk_slot_v1", false);
}

/**
 * ← claude.ts:3399-3419。
 *   ⚠️ 这个数直接影响 auto-compact 阈值（getEffectiveContextWindowSize 取
 *   min(它, 20_000)）：cap 关（3P 默认）→ min(32_000,20_000)=20_000；
 *   cap 开 → min(8_000,20_000)=8_000。
 */
export function getMaxOutputTokensForModel(model: string): number {
    const maxOutputTokens = getModelMaxOutputTokens(model);
    const defaultTokens = isMaxTokensCapEnabled()
        ? Math.min(maxOutputTokens.default, CAPPED_DEFAULT_MAX_TOKENS)
        : maxOutputTokens.default;
    // ← validateBoundedIntEnvVar('CLAUDE_CODE_MAX_OUTPUT_TOKENS', ...) 的内联等价
    const raw = process.env["CLAUDE_CODE_MAX_OUTPUT_TOKENS"];
    if (raw) {
        const n = parseInt(raw, 10);
        if (!Number.isNaN(n) && n > 0) return Math.min(n, maxOutputTokens.upperLimit);
    }
    return defaultTokens;
}

/** ← utils/envUtils.ts:isEnvTruthy */
export function isEnvTruthy(v: string | undefined): boolean {
    if (!v) return false;
    const s = v.toLowerCase().trim();
    return s === "1" || s === "true" || s === "yes" || s === "on";
}

// ============================================================
// §3 utils/tokens.ts（逐函数移植）
// ============================================================

/** 【适配】cc 的 SYNTHETIC_MODEL / SYNTHETIC_MESSAGES 用于识别内部合成消息 */
export const SYNTHETIC_MODEL = "<synthetic>";
export const SYNTHETIC_MESSAGES: ReadonlySet<string> = new Set(["Prompt is too long"]);

/** ← tokens.ts:7-20 */
export function getTokenUsage(message: Message | undefined): Usage | undefined {
    if (message?.type !== "assistant") return undefined;
    const inner = message.message;
    if (!("usage" in inner) || !inner.usage) return undefined;
    const first = inner.content[0];
    if (first?.type === "text" && SYNTHETIC_MESSAGES.has(first.text)) return undefined;
    if (inner.model === SYNTHETIC_MODEL) return undefined;
    return inner.usage;
}

/** ← tokens.ts:46-53 */
export function getTokenCountFromUsage(usage: Usage): number {
    return usage.input_tokens
        + (usage.cache_creation_input_tokens ?? 0)
        + (usage.cache_read_input_tokens ?? 0)
        + usage.output_tokens;
}

/** ← tokens.ts:55-66 */
export function tokenCountFromLastAPIResponse(messages: readonly Message[]): number {
    let i = messages.length - 1;
    while (i >= 0) {
        const message = messages[i];
        const usage = getTokenUsage(message);
        if (usage) return getTokenCountFromUsage(usage);
        i--;
    }
    return 0;
}

/** ← tokens.ts:28-37 */
function getAssistantMessageId(message: Message | undefined): string | undefined {
    if (message?.type !== "assistant") return undefined;
    if (message.message.model === SYNTHETIC_MODEL) return undefined;
    return message.message.id || undefined;
}

/**
 * ← tokens.ts:226-261（**CANONICAL 的上下文尺寸口径**）。
 *   最后一条 API 响应的 usage（input + cache_creation + cache_read + output）
 *   ＋ 其后新增消息的粗糙估算。cc 的注释点名它是"检查阈值（autocompact、
 *   session memory）时**唯一**该用的函数"。
 */
export function tokenCountWithEstimation(messages: readonly Message[]): number {
    let i = messages.length - 1;
    while (i >= 0) {
        const message = messages[i];
        const usage = message ? getTokenUsage(message) : undefined;
        if (message && usage) {
            const responseId = getAssistantMessageId(message);
            if (responseId) {
                let j = i - 1;
                while (j >= 0) {
                    const prior = messages[j];
                    const priorId = prior ? getAssistantMessageId(prior) : undefined;
                    if (priorId === responseId) i = j;
                    else if (priorId !== undefined) break;
                    j--;
                }
            }
            return getTokenCountFromUsage(usage)
                + roughTokenCountEstimationForMessages(messages.slice(i + 1));
        }
        i--;
    }
    return roughTokenCountEstimationForMessages(messages);
}

// ============================================================
// §4 services/compact/timeBasedMCConfig.ts
// ============================================================

/** ← timeBasedMCConfig.ts:18-28 */
export type TimeBasedMCConfig = {
    enabled: boolean;
    gapThresholdMinutes: number;
    keepRecent: number;
};

/** ← timeBasedMCConfig.ts:30-34（原样：**默认关闭**） */
export const TIME_BASED_MC_CONFIG_DEFAULTS: TimeBasedMCConfig = {
    enabled: false,
    gapThresholdMinutes: 60,
    keepRecent: 5,
};

let timeBasedMCConfig: TimeBasedMCConfig = { ...TIME_BASED_MC_CONFIG_DEFAULTS };

/**
 * ← timeBasedMCConfig.ts:36-43。
 *   【适配】cc 从 GrowthBook 读 `tengu_slate_heron`；本仓库没有 GrowthBook，
 *   改成进程内可变配置 + `CF_TENGU_SLATE_HERON` 环境变量覆盖（JSON）。
 *   **默认值一字未改**（enabled 仍是 false —— 移植不等于替使用者打开开关）。
 */
export function getTimeBasedMCConfig(): TimeBasedMCConfig {
    const raw = process.env["CF_TENGU_SLATE_HERON"];
    if (raw) {
        try {
            const parsed = JSON.parse(raw) as Partial<TimeBasedMCConfig>;
            return {
                enabled: parsed.enabled ?? timeBasedMCConfig.enabled,
                gapThresholdMinutes: parsed.gapThresholdMinutes ?? timeBasedMCConfig.gapThresholdMinutes,
                keepRecent: parsed.keepRecent ?? timeBasedMCConfig.keepRecent,
            };
        } catch { /* 垃圾配置回落到已设置值，不抛 */ }
    }
    return { ...timeBasedMCConfig };
}

/** 【适配】GrowthBook 的写入端（`setSessionMemoryCompactConfig` 的同款形状） */
export function setTimeBasedMCConfig(config: Partial<TimeBasedMCConfig>): void {
    timeBasedMCConfig = { ...timeBasedMCConfig, ...config };
}
export function resetTimeBasedMCConfig(): void {
    timeBasedMCConfig = { ...TIME_BASED_MC_CONFIG_DEFAULTS };
}

/** 【适配】cc 的 `feature()` 编译期开关。本仓库没有 bun:bundle 的 feature 系统，
 *  这里用一张常量表给出**外部构建**的取值（CrewForge 是外部消费者）。 */
export function feature(name: string): boolean {
    return FEATURE_FLAGS_EXTERNAL[name] === true;
}
/** cc excluded-strings.txt 里被 DCE 掉的 ant-only 能力：外部构建一律 false */
export const FEATURE_FLAGS_EXTERNAL: Readonly<Record<string, boolean>> = {
    CACHED_MICROCOMPACT: false,
    REACTIVE_COMPACT: false,
    CONTEXT_COLLAPSE: false,
    PROMPT_CACHE_BREAK_DETECTION: false,
    HISTORY_SNIP: false,
    PROACTIVE: false,
    KAIROS: false,
    EXPERIMENTAL_SKILL_SEARCH: false,
    COMMIT_ATTRIBUTION: false,
    CACHED_MC_CACHE_EDITS: false,
};

/** 【适配】GrowthBook `getFeatureValue_CACHED_MAY_BE_STALE` 的替身：默认值直传 */
export function getFeatureValue_CACHED_MAY_BE_STALE<T>(_key: string, fallback: T): T {
    return fallback;
}

// ============================================================
// §5 services/compact/microCompact.ts
// ============================================================

/** ← microCompact.ts:36（与 toolResultStorage.ts:34 的 TOOL_RESULT_CLEARED_MESSAGE 同值） */
export const TIME_BASED_MC_CLEARED_MESSAGE = "[Old tool result content cleared]";
/** ← microCompact.ts:38 */
const IMAGE_MAX_TOKEN_SIZE = 2000;

// ← microCompact.ts:5-11 的工具名常量（取值见各 prompt.ts / toolName.ts）
export const FILE_READ_TOOL_NAME = "Read";
export const FILE_WRITE_TOOL_NAME = "Write";
export const FILE_EDIT_TOOL_NAME = "Edit";
export const NOTEBOOK_EDIT_TOOL_NAME = "NotebookEdit";
export const GREP_TOOL_NAME = "Grep";
export const GLOB_TOOL_NAME = "Glob";
export const WEB_SEARCH_TOOL_NAME = "WebSearch";
export const WEB_FETCH_TOOL_NAME = "WebFetch";
/** ← shellToolUtils.ts:6（BASH_TOOL_NAME='Bash' / POWERSHELL_TOOL_NAME='PowerShell'） */
export const SHELL_TOOL_NAMES: string[] = ["Bash", "PowerShell"];

/** ← microCompact.ts:41-50（一字未改；上面那组常量就是源码引用的那些） */
export const COMPACTABLE_TOOLS: ReadonlySet<string> = new Set<string>([
    FILE_READ_TOOL_NAME,
    ...SHELL_TOOL_NAMES,
    GREP_TOOL_NAME,
    GLOB_TOOL_NAME,
    WEB_SEARCH_TOOL_NAME,
    WEB_FETCH_TOOL_NAME,
    FILE_EDIT_TOOL_NAME,
    FILE_WRITE_TOOL_NAME,
]);

/**
 * 【适配】CrewForge 的工具名与 cc 不同名。
 *   这是一张**纯改名表**，值域与 COMPACTABLE_TOOLS 一一对应，不改任何策略：
 *     inspectTree→Glob, readFile→Read, search→Grep, runCommand/runBuild/shell→Bash,
 *     httpRequest→WebFetch, writeFile→Write, editFile→Edit, mkdir→Write
 *   （与 developerAgent/tools/registry.ts:91 的 WRITE_TOOLS / graph.ts:87 的
 *   EXEC_TOOL_NAMES 对齐。）
 */
export const CF_TOOL_NAME_ALIASES: Readonly<Record<string, string>> = {
    inspectTree: GLOB_TOOL_NAME,
    readFile: FILE_READ_TOOL_NAME,
    search: GREP_TOOL_NAME,
    runCommand: "Bash",
    runBuild: "Bash",
    shell: "Bash",
    startProcess: "Bash",
    httpRequest: WEB_FETCH_TOOL_NAME,
    writeFile: FILE_WRITE_TOOL_NAME,
    editFile: FILE_EDIT_TOOL_NAME,
    mkdir: FILE_WRITE_TOOL_NAME,
    runAcceptance: "Bash",
};
export function canonicalToolName(tool: string): string {
    return CF_TOOL_NAME_ALIASES[tool] ?? tool;
}

/** ← microCompact.ts:137-157 */
export function calculateToolResultTokens(block: ToolResultBlock): number {
    if (!block.content) return 0;
    if (typeof block.content === "string") return roughTokenCountEstimation(block.content);
    return block.content.reduce((sum, item) => {
        if (item.type === "text") return sum + roughTokenCountEstimation(item.text);
        return sum + IMAGE_MAX_TOKEN_SIZE;   // image / document
    }, 0);
}

/**
 * ← microCompact.ts:164-205（同一口径：**按 block 类型分别计**，最后 ×4/3 保守加价）。
 *   与 §1 的 roughTokenCountEstimationForMessages 是两个不同的函数，
 *   源码里也是两个（sessionMemoryCompact 用的是这一个）。
 */
export function estimateMessageTokens(messages: readonly Message[]): number {
    let totalTokens = 0;
    for (const message of messages) {
        if (message.type !== "user" && message.type !== "assistant") continue;
        if (!Array.isArray(message.message.content)) continue;
        for (const block of message.message.content) {
            if (block.type === "text") totalTokens += roughTokenCountEstimation(block.text);
            else if (block.type === "tool_result") totalTokens += calculateToolResultTokens(block);
            else if (block.type === "thinking") totalTokens += roughTokenCountEstimation(block.thinking);
            else if (block.type === "redacted_thinking") totalTokens += roughTokenCountEstimation(block.data);
            else if (block.type === "tool_use") {
                totalTokens += roughTokenCountEstimation(block.name + jsonStringify(block.input ?? {}));
            } else totalTokens += roughTokenCountEstimation(jsonStringify(block));
        }
    }
    return Math.ceil(totalTokens * (4 / 3));
}

/** ← microCompact.ts:226-241 */
function collectCompactableToolIds(messages: readonly Message[]): string[] {
    const ids: string[] = [];
    for (const message of messages) {
        if (message.type === "assistant" && Array.isArray(message.message.content)) {
            for (const block of message.message.content) {
                if (block.type === "tool_use" && COMPACTABLE_TOOLS.has(block.name)) ids.push(block.id);
            }
        }
    }
    return ids;
}

/**
 * ← microCompact.ts:249-251（前缀匹配，源码注释点名它修了一个 latent bug）
 * 【适配】cc 的 querySource 是字符串（'repl_main_thread:outputStyle:x'）；
 * 本仓库传 `"repl_main_thread"` 或 undefined 即可。
 */
export function isMainThreadSource(querySource: string | undefined): boolean {
    return !querySource || querySource.startsWith("repl_main_thread");
}

/** ← microCompact.ts:422-444 */
export function evaluateTimeBasedTrigger(
    messages: readonly Message[],
    querySource: string | undefined,
    nowMs: number = Date.now(),
): { gapMinutes: number; config: TimeBasedMCConfig } | null {
    const config = getTimeBasedMCConfig();
    if (!config.enabled || !querySource || !isMainThreadSource(querySource)) return null;
    const lastAssistant = messages.findLast(isAssistantMessage);
    if (!lastAssistant) return null;
    const gapMinutes = (nowMs - new Date(lastAssistant.timestamp).getTime()) / 60_000;
    if (!Number.isFinite(gapMinutes) || gapMinutes < config.gapThresholdMinutes) return null;
    return { gapMinutes, config };
}

/** 【适配】源码用 Array.prototype.findLast（lib ESNext 已有，直接用原生实现以便类型收窄） */

/** ← microCompact.ts:446-530（逐行移植：keepRecent 下限 1、时间戳文案、tokensSaved 归零则不触发） */
function maybeTimeBasedMicrocompact(
    messages: Message[],
    querySource: string | undefined,
    nowMs: number,
): { messages: Message[]; tokensSaved: number; cleared: number; kept: number } | null {
    const trigger = evaluateTimeBasedTrigger(messages, querySource, nowMs);
    if (!trigger) return null;
    const { config } = trigger;

    const compactableIds = collectCompactableToolIds(messages);

    // Floor at 1: slice(-0) returns the full array (paradoxically keeps
    // everything), and clearing ALL results leaves the model with zero working
    // context. Neither degenerate is sensible — always keep at least the last.
    const keepRecent = Math.max(1, config.keepRecent);
    const keepSet = new Set(compactableIds.slice(-keepRecent));
    const clearSet = new Set(compactableIds.filter((id) => !keepSet.has(id)));

    if (clearSet.size === 0) return null;

    let tokensSaved = 0;
    const result: Message[] = messages.map((message) => {
        if (message.type !== "user" || !Array.isArray(message.message.content)) return message;
        let touched = false;
        const newContent = message.message.content.map((block) => {
            if (
                block.type === "tool_result"
                && clearSet.has(block.tool_use_id)
                && block.content !== TIME_BASED_MC_CLEARED_MESSAGE
            ) {
                tokensSaved += calculateToolResultTokens(block);
                touched = true;
                return { ...block, content: TIME_BASED_MC_CLEARED_MESSAGE };
            }
            return block;
        });
        if (!touched) return message;
        return { ...message, message: { ...message.message, content: newContent } };
    });

    if (tokensSaved === 0) return null;
    return { messages: result, tokensSaved, cleared: clearSet.size, kept: keepSet.size };
}

/** ← microCompact.ts:215-220 */
export type MicrocompactResult = {
    messages: Message[];
    compactionInfo?: {
        pendingCacheEdits?: PendingCacheEdits;
    };
};

/** ← microCompact.ts:207-213 */
export type PendingCacheEdits = {
    trigger: "auto";
    deletedToolIds: string[];
    baselineCacheDeletedTokens: number;
};

/**
 * ← microCompact.ts:88-118 + 130-135。cached MC 的模块级状态。
 *
 *   ⚠️ **不可移植的部分**：cc 的 `services/compact/cachedMicrocompact.ts`
 *   （CachedMCState / getCachedMCConfig / registerToolResult / getToolResultsToDelete /
 *   createCacheEditsBlock / isCachedMicrocompactEnabled / isModelSupportedForCacheEditing）
 *   **不在本 checkout 里**（只被 `await import('./cachedMicrocompact.js')` 动态引用，
 *   文件本身不存在，属 ant-only 内部模块）。因此**触发/保留阈值无法读出**，
 *   本移植**不编造任何数字**：这些值必须由调用方注入（见 setCachedMicrocompactConfig），
 *   未注入时 cachedMicrocompactPath 直接返回 null（= cc 在外部构建里的行为）。
 */
export type CachedMCState = {
    registeredTools: Set<string>;
    toolOrder: string[];
    deletedRefs: Set<string>;
    pinnedEdits: { userMessageIndex: number; block: unknown }[];
};
export type CachedMCConfig = {
    /** 【未知】cc 的 getCachedMCConfig() 从 GrowthBook 读，源码不在 checkout 里 */
    triggerThreshold: number;
    keepRecent: number;
};
export function createCachedMCState(): CachedMCState {
    return { registeredTools: new Set(), toolOrder: [], deletedRefs: new Set(), pinnedEdits: [] };
}
let cachedMCState: CachedMCState | null = null;
let cachedMCConfig: CachedMCConfig | null = null;
let pendingCacheEdits: PendingCacheEdits | null = null;

/** 【适配】cachedMicrocompact.ts 缺席 → 配置改为注入；**不提供默认数字** */
export function setCachedMicrocompactConfig(config: CachedMCConfig | null): void {
    cachedMCConfig = config;
}
export function getCachedMCConfig(): CachedMCConfig | null {
    return cachedMCConfig;
}
export function getCachedMCState(): CachedMCState {
    if (!cachedMCState) cachedMCState = createCachedMCState();
    return cachedMCState;
}
export function resetMicrocompactState(): void {
    if (cachedMCState) {
        cachedMCState.registeredTools.clear();
        cachedMCState.toolOrder.length = 0;
        cachedMCState.deletedRefs.clear();
        cachedMCState.pinnedEdits.length = 0;
    }
    pendingCacheEdits = null;
}
export function consumePendingCacheEdits(): PendingCacheEdits | null {
    const e = pendingCacheEdits;
    pendingCacheEdits = null;
    return e;
}
export function getPinnedCacheEdits(): { userMessageIndex: number; block: unknown }[] {
    return cachedMCState ? cachedMCState.pinnedEdits : [];
}
export function pinCacheEdits(userMessageIndex: number, block: unknown): void {
    if (cachedMCState) cachedMCState.pinnedEdits.push({ userMessageIndex, block });
}
export function markToolsSentToAPIState(): void {
    if (cachedMCState) cachedMCState.registeredTools.clear();
}

/**
 * ← microCompact.ts:253-293（**逐行移植，含它的分支顺序与短路**）。
 *
 *   三条路径，按源码顺序：
 *     ① 时间触发路径**先跑并短路**（cc 注释：缓存已冷，反正要重写整个前缀，
 *        不如先把老结果清掉，少重写一点）；命中时 cached MC 被跳过。
 *     ② cached MC（cache-editing，只在 CACHED_MICROCOMPACT + 模型支持 + 主线程时）；
 *     ③ 兜底：**什么也不做**（源码原话："Legacy microcompact path removed …
 *        For contexts where cached microcompact is not available (external builds,
 *        non-ant users, unsupported models, sub-agents), no compaction happens here;
 *        autocompact handles context pressure instead."）。
 *
 *   ★ 因此：**忠实移植的微压缩在默认配置下是一个 no-op**。
 *     真正的逐条清空只在 time-based 路径上，而它的默认 enabled 是 false（§4）。
 */
export function microcompactMessages(
    messages: Message[],
    querySource?: string,
    opts: {
        nowMs?: number;
        /** 【适配】cached MC 的可用性（模型是否支持 cache editing）由调用方判定 */
        cachedMicrocompactAvailable?: boolean;
        isMainThread?: boolean;
    } = {},
): MicrocompactResult {
    clearCompactWarningSuppression();

    const timeBasedResult = maybeTimeBasedMicrocompact(
        messages, querySource, opts.nowMs ?? Date.now(),
    );
    if (timeBasedResult) {
        suppressCompactWarning();
        // cc 在这里 resetMicrocompactState() + notifyCacheDeletion(querySource)：
        // 我们刚改了 prompt 内容 → 告诉缓存折断检测器"这次下降是我们自己造成的"。
        resetMicrocompactState();
        return {
            messages: timeBasedResult.messages,
            compactionInfo: {
                pendingCacheEdits: {
                    trigger: "auto",
                    deletedToolIds: [],
                    baselineCacheDeletedTokens: 0,
                },
            },
        };
    }

    if (feature("CACHED_MICROCOMPACT")) {
        const supported = opts.cachedMicrocompactAvailable ?? false;
        const mainThread = opts.isMainThread ?? true;
        if (supported && mainThread) {
            return cachedMicrocompactPath(messages, querySource);
        }
    }

    return { messages };
}

/**
 * ← microCompact.ts:305-399 的**编排骨架**（内部函数体不可移植，见 CachedMCState 注释）。
 *   cc 的关键语义留了下来：
 *     · **不改本地消息内容**（cache_reference / cache_edits 在 API 层加）；
 *     · 用 count-based 的 trigger/keep 阈值（值由注入配置给）；
 *     · 返回 `pendingCacheEdits`，并取最后一条 assistant 的
 *       `cache_deleted_input_tokens` 当基线；
 *     · 边界消息**延后到 API 响应之后**再插（用服务端真值而不是客户端估算）。
 */
function cachedMicrocompactPath(
    messages: Message[],
    _querySource: string | undefined,
): MicrocompactResult {
    const config = getCachedMCConfig();
    if (!config) return { messages };     // 【适配】配置缺席 → 等价于 cc 外部构建：不压
    const state = getCachedMCState();

    const compactableToolIds = collectCompactableToolIds(messages);
    for (const id of compactableToolIds) {
        if (!state.registeredTools.has(id)) {
            state.registeredTools.add(id);
            state.toolOrder.push(id);
        }
    }

    // 【近似】cc 的 getToolResultsToDelete() 内部逻辑不可读（模块缺席）。
    // 这里按它**注释里写明的语义**实现：超过 triggerThreshold 条之后，
    // 只保留最近 keepRecent 条，其余进删除集。
    const activeIds = state.toolOrder.filter((id) => !state.deletedRefs.has(id));
    if (activeIds.length <= config.triggerThreshold) return { messages };
    const keep = new Set(activeIds.slice(-Math.max(1, config.keepRecent)));
    const toolsToDelete = activeIds.filter((id) => !keep.has(id));
    if (toolsToDelete.length === 0) return { messages };
    for (const id of toolsToDelete) state.deletedRefs.add(id);

    const lastAsst = messages.findLast(isAssistantMessage);
    const baseline = lastAsst
        ? ((lastAsst.message.usage as unknown as Record<string, number | undefined> | undefined)
            ?.["cache_deleted_input_tokens"] ?? 0)
        : 0;

    pendingCacheEdits = { trigger: "auto", deletedToolIds: toolsToDelete, baselineCacheDeletedTokens: baseline };
    suppressCompactWarning();
    // cc 同步：notifyCacheDeletion(querySource)（PROMPT_CACHE_BREAK_DETECTION 开启时）
    return { messages, compactionInfo: { pendingCacheEdits } };
}

/** ← compactWarningState.ts:8-17（cc 用 state/store，这里就是两个布尔） */
let compactWarningSuppressed = false;
export function suppressCompactWarning(): void { compactWarningSuppressed = true; }
export function clearCompactWarningSuppression(): void { compactWarningSuppressed = false; }
export function isCompactWarningSuppressed(): boolean { return compactWarningSuppressed; }

// ============================================================
// §6 services/compact/grouping.ts（逐行移植）
// ============================================================

/**
 * ← grouping.ts:22-63。
 *   按 **API round** 分组：出现新的 assistant `message.id` 就是边界。
 *   源码注释明确说了它**不**追踪未闭合的 tool_use（"would only do work when the
 *   conversation is malformed … and in that case it pins the gate shut forever"），
 *   配对修复交给 fork 的 ensureToolResultPairing。
 */
export function groupMessagesByApiRound(messages: readonly Message[]): Message[][] {
    const groups: Message[][] = [];
    let current: Message[] = [];
    let lastAssistantId: string | undefined;

    for (const msg of messages) {
        if (msg.type === "assistant" && msg.message.id !== lastAssistantId && current.length > 0) {
            groups.push(current);
            current = [msg];
        } else {
            current.push(msg);
        }
        if (msg.type === "assistant") lastAssistantId = msg.message.id;
    }
    if (current.length > 0) groups.push(current);
    return groups;
}

// ============================================================
// §7 utils/messages.ts（压缩相关部分，逐行移植）
// ============================================================

/** ← messages.ts:4530-4555 */
export function createCompactBoundaryMessage(
    trigger: "manual" | "auto",
    preTokens: number,
    lastPreCompactMessageUuid?: string,
    userContext?: string,
    messagesSummarized?: number,
    ids: { uuid?: string; timestamp?: string } = {},
): SystemCompactBoundaryMessage {
    return {
        type: "system",
        subtype: "compact_boundary",
        content: "Conversation compacted",
        isMeta: false,
        // 【适配】cc 用 new Date().toISOString()/randomUUID()；允许注入以便测试可重放
        timestamp: ids.timestamp ?? new Date().toISOString(),
        uuid: ids.uuid ?? randomUUID(),
        level: "info",
        compactMetadata: { trigger, preTokens, userContext, messagesSummarized },
        ...(lastPreCompactMessageUuid && { logicalParentUuid: lastPreCompactMessageUuid }),
    };
}

/** ← messages.ts:4557-4583（含源码那句 logForDebugging：`[microcompact] saved ~N tokens …`） */
export function createMicrocompactBoundaryMessage(
    trigger: "auto",
    preTokens: number,
    tokensSaved: number,
    compactedToolIds: string[],
    clearedAttachmentUUIDs: string[],
    ids: { uuid?: string; timestamp?: string } = {},
): SystemMicrocompactBoundaryMessage {
    return {
        type: "system",
        subtype: "microcompact_boundary",
        content: "Context microcompacted",
        isMeta: false,
        timestamp: ids.timestamp ?? new Date().toISOString(),
        uuid: ids.uuid ?? randomUUID(),
        level: "info",
        microcompactMetadata: {
            trigger, preTokens, tokensSaved, compactedToolIds, clearedAttachmentUUIDs,
        },
    };
}

/** ← messages.ts:4618-4629 */
export function findLastCompactBoundaryIndex(messages: readonly Message[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message && isCompactBoundaryMessage(message)) return i;
    }
    return -1;
}

/**
 * ← messages.ts:4643-4657（HISTORY_SNIP 的分支在本仓库的 feature 表里恒 false，故省略，
 *   语义与 cc 外部构建一致："returns messages from the last compact boundary onward
 *   (including the boundary). If no boundary exists, returns all messages."）。
 */
export function getMessagesAfterCompactBoundary(
    messages: readonly Message[],
    _options?: { includeSnipped?: boolean },
): Message[] {
    const boundaryIndex = findLastCompactBoundaryIndex(messages);
    return boundaryIndex === -1 ? [...messages] : messages.slice(boundaryIndex);
}

// ============================================================
// §8 services/compact/prompt.ts —— **逐字照抄**（提示词原文，一个字符都没改）
// ============================================================

/** ← prompt.ts:19-26 */
export const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`;

/** ← prompt.ts:31-44 */
export const DETAILED_ANALYSIS_INSTRUCTION_BASE = `Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Chronologically analyze each message and section of the conversation. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.`;

/** ← prompt.ts:46-59 */
export const DETAILED_ANALYSIS_INSTRUCTION_PARTIAL = `Before providing your final summary, wrap your analysis in <analysis> tags to organize your thoughts and ensure you've covered all necessary points. In your analysis process:

1. Analyze the recent messages chronologically. For each section thoroughly identify:
   - The user's explicit requests and intents
   - Your approach to addressing the user's requests
   - Key decisions, technical concepts and code patterns
   - Specific details like:
     - file names
     - full code snippets
     - function signatures
     - file edits
   - Errors that you ran into and how you fixed them
   - Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
2. Double-check for technical accuracy and completeness, addressing each required element thoroughly.`;

/** ← prompt.ts:61-143（BASE_COMPACT_PROMPT，原样；`${...}` 是源码里的模板变量，已内联） */
export const BASE_COMPACT_PROMPT = `Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.
This summary should be thorough in capturing technical details, code patterns, and architectural decisions that would be essential for continuing development work without losing context.

${DETAILED_ANALYSIS_INSTRUCTION_BASE}

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Pay special attention to the most recent messages and include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List all errors that you ran into, and how you fixed them. Pay special attention to specific user feedback that you received, especially if the user told you to do something differently.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results. These are critical for understanding the users' feedback and changing intent.
7. Pending Tasks: Outline any pending tasks that you have explicitly been asked to work on.
8. Current Work: Describe in detail precisely what was being worked on immediately before this summary request, paying special attention to the most recent messages from both user and assistant. Include file names and code snippets where applicable.
9. Optional Next Step: List the next step that you will take that is related to the most recent work you were doing. IMPORTANT: ensure that this step is DIRECTLY in line with the user's most recent explicit requests, and the task you were working on immediately before this summary request. If your last task was concluded, then only list next steps if they are explicitly in line with the users request. Do not start on tangential requests or really old requests that were already completed without confirming with the user first.
                       If there is a next step, include direct quotes from the most recent conversation showing exactly what task you were working on and where you left off. This should be verbatim to ensure there's no drift in task interpretation.

Here's an example of how your output should be structured:

<example>
<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]
   - [...]

3. Files and Code Sections:
   - [File Name 1]
      - [Summary of why this file is important]
      - [Summary of the changes made to this file, if any]
      - [Important Code Snippet]
   - [File Name 2]
      - [Important Code Snippet]
   - [...]

4. Errors and fixes:
    - [Detailed description of error 1]:
      - [How you fixed the error]
      - [User feedback on the error if any]
    - [...]

5. Problem Solving:
   [Description of solved problems and ongoing troubleshooting]

6. All user messages: 
    - [Detailed non tool use user message]
    - [...]

7. Pending Tasks:
   - [Task 1]
   - [Task 2]
   - [...]

8. Current Work:
   [Precise description of current work]

9. Optional Next Step:
   [Optional Next step to take]

</summary>
</example>

Please provide your summary based on the conversation so far, following this structure and ensuring precision and thoroughness in your response. 

There may be additional summarization instructions provided in the included context. If so, remember to follow these instructions when creating the above summary. Examples of instructions include:
<example>
## Compact Instructions
When summarizing the conversation focus on typescript code changes and also remember the mistakes you made and how you fixed them.
</example>

<example>
# Summary instructions
When you are using compact - please focus on test output and code changes. Include file reads verbatim.
</example>
`;

/** ← prompt.ts:145-204（PARTIAL_COMPACT_PROMPT） */
export const PARTIAL_COMPACT_PROMPT = `Your task is to create a detailed summary of the RECENT portion of the conversation — the messages that follow earlier retained context. The earlier messages are being kept intact and do NOT need to be summarized. Focus your summary on what was discussed, learned, and accomplished in the recent messages only.

${DETAILED_ANALYSIS_INSTRUCTION_PARTIAL}

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents from the recent messages
2. Key Technical Concepts: List important technical concepts, technologies, and frameworks discussed recently.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List errors encountered and how they were fixed.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages from the recent portion that are not tool results.
7. Pending Tasks: Outline any pending tasks from the recent messages.
8. Current Work: Describe precisely what was being worked on immediately before this summary request.
9. Optional Next Step: List the next step related to the most recent work. Include direct quotes from the most recent conversation.

Here's an example of how your output should be structured:

<example>
<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]

3. Files and Code Sections:
   - [File Name 1]
      - [Summary of why this file is important]
      - [Important Code Snippet]

4. Errors and fixes:
    - [Error description]:
      - [How you fixed it]

5. Problem Solving:
   [Description]

6. All user messages:
    - [Detailed non tool use user message]

7. Pending Tasks:
   - [Task 1]

8. Current Work:
   [Precise description of current work]

9. Optional Next Step:
   [Optional Next step to take]

</summary>
</example>

Please provide your summary based on the RECENT messages only (after the retained earlier context), following this structure and ensuring precision and thoroughness in your response.
`;

/** ← prompt.ts:208-267（PARTIAL_COMPACT_UP_TO_PROMPT，第 8/9 节改名） */
export const PARTIAL_COMPACT_UP_TO_PROMPT = `Your task is to create a detailed summary of this conversation. This summary will be placed at the start of a continuing session; newer messages that build on this context will follow after your summary (you do not see them here). Summarize thoroughly so that someone reading only your summary and then the newer messages can fully understand what happened and continue the work.

${DETAILED_ANALYSIS_INSTRUCTION_BASE}

Your summary should include the following sections:

1. Primary Request and Intent: Capture all of the user's explicit requests and intents in detail
2. Key Technical Concepts: List all important technical concepts, technologies, and frameworks discussed.
3. Files and Code Sections: Enumerate specific files and code sections examined, modified, or created. Include full code snippets where applicable and include a summary of why this file read or edit is important.
4. Errors and fixes: List errors encountered and how they were fixed.
5. Problem Solving: Document problems solved and any ongoing troubleshooting efforts.
6. All user messages: List ALL user messages that are not tool results.
7. Pending Tasks: Outline any pending tasks.
8. Work Completed: Describe what was accomplished by the end of this portion.
9. Context for Continuing Work: Summarize any context, decisions, or state that would be needed to understand and continue the work in subsequent messages.

Here's an example of how your output should be structured:

<example>
<analysis>
[Your thought process, ensuring all points are covered thoroughly and accurately]
</analysis>

<summary>
1. Primary Request and Intent:
   [Detailed description]

2. Key Technical Concepts:
   - [Concept 1]
   - [Concept 2]

3. Files and Code Sections:
   - [File Name 1]
      - [Summary of why this file is important]
      - [Important Code Snippet]

4. Errors and fixes:
    - [Error description]:
      - [How you fixed it]

5. Problem Solving:
   [Description]

6. All user messages:
    - [Detailed non tool use user message]

7. Pending Tasks:
   - [Task 1]

8. Work Completed:
   [Description of what was accomplished]

9. Context for Continuing Work:
   [Key context, decisions, or state needed to continue the work]

</summary>
</example>

Please provide your summary following this structure, ensuring precision and thoroughness in your response.
`;

/** ← prompt.ts:269-272 */
export const NO_TOOLS_TRAILER =
    "\n\nREMINDER: Do NOT call any tools. Respond with plain text only — "
    + "an <analysis> block followed by a <summary> block. "
    + "Tool calls will be rejected and you will fail the task.";

export type PartialCompactDirection = "from" | "up_to";

/** ← prompt.ts:274-291 */
export function getPartialCompactPrompt(
    customInstructions?: string,
    direction: PartialCompactDirection = "from",
): string {
    const template = direction === "up_to" ? PARTIAL_COMPACT_UP_TO_PROMPT : PARTIAL_COMPACT_PROMPT;
    let prompt = NO_TOOLS_PREAMBLE + template;
    if (customInstructions && customInstructions.trim() !== "") {
        prompt += `\n\nAdditional Instructions:\n${customInstructions}`;
    }
    prompt += NO_TOOLS_TRAILER;
    return prompt;
}

/** ← prompt.ts:293-303 */
export function getCompactPrompt(customInstructions?: string): string {
    let prompt = NO_TOOLS_PREAMBLE + BASE_COMPACT_PROMPT;
    if (customInstructions && customInstructions.trim() !== "") {
        prompt += `\n\nAdditional Instructions:\n${customInstructions}`;
    }
    prompt += NO_TOOLS_TRAILER;
    return prompt;
}

/** ← prompt.ts:311-335（<analysis> 草稿被剥掉、<summary> 换成 `Summary:` 抬头） */
export function formatCompactSummary(summary: string): string {
    let formattedSummary = summary;
    formattedSummary = formattedSummary.replace(/<analysis>[\s\S]*?<\/analysis>/, "");
    const summaryMatch = formattedSummary.match(/<summary>([\s\S]*?)<\/summary>/);
    if (summaryMatch) {
        const content = summaryMatch[1] || "";
        formattedSummary = formattedSummary.replace(
            /<summary>[\s\S]*?<\/summary>/,
            `Summary:\n${content.trim()}`,
        );
    }
    formattedSummary = formattedSummary.replace(/\n\n+/g, "\n\n");
    return formattedSummary.trim();
}

/**
 * ← prompt.ts:337-373。
 *   **摘要就是这样被回灌进下一轮请求的**：一条 `user` 消息，开头是
 *   "This session is being continued from a previous conversation that ran out of context."，
 *   随后是格式化后的摘要，再按需追加 transcript 路径 / "Recent messages are preserved
 *   verbatim." / 自动压缩专用的 "Continue the conversation from where it left off …"。
 */
export function getCompactUserSummaryMessage(
    summary: string,
    suppressFollowUpQuestions?: boolean,
    transcriptPath?: string,
    recentMessagesPreserved?: boolean,
): string {
    const formattedSummary = formatCompactSummary(summary);

    let baseSummary = `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.

${formattedSummary}`;

    if (transcriptPath) {
        baseSummary += `\n\nIf you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: ${transcriptPath}`;
    }
    if (recentMessagesPreserved) {
        baseSummary += `\n\nRecent messages are preserved verbatim.`;
    }
    if (suppressFollowUpQuestions) {
        const continuation = `${baseSummary}
Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with "I'll continue" or similar. Pick up the last task as if the break never happened.`;
        // 【适配】cc 这里还有 PROACTIVE/KAIROS 的 proactiveModule.isProactiveActive()
        // 分支；本仓库的 feature 表里两者恒 false（外部构建），故该分支不可达、省略。
        return continuation;
    }
    return baseSummary;
}

// ============================================================
// §9 services/compact/compact.ts
// ============================================================

/** ← compact.ts:122-131 */
export const POST_COMPACT_MAX_FILES_TO_RESTORE = 5;
export const POST_COMPACT_TOKEN_BUDGET = 50_000;
export const POST_COMPACT_MAX_TOKENS_PER_FILE = 5_000;
export const POST_COMPACT_MAX_TOKENS_PER_SKILL = 5_000;
export const POST_COMPACT_SKILLS_TOKEN_BUDGET = 25_000;
const MAX_COMPACT_STREAMING_RETRIES = 2;

/** ← compact.ts:225-228 */
export const ERROR_MESSAGE_NOT_ENOUGH_MESSAGES = "Not enough messages to compact.";
const MAX_PTL_RETRIES = 3;
const PTL_RETRY_MARKER = "[earlier conversation truncated for compaction retry]";

/** ← compact.ts:293-297 */
export const ERROR_MESSAGE_PROMPT_TOO_LONG =
    "Conversation too long. Press esc twice to go up a few messages and try again.";
export const ERROR_MESSAGE_USER_ABORT = "API Error: Request was aborted.";
export const ERROR_MESSAGE_INCOMPLETE_RESPONSE =
    "Compaction interrupted · This may be due to network issues — please try again.";

/** ← services/api/errors.ts:62 */
export const PROMPT_TOO_LONG_ERROR_MESSAGE = "Prompt is too long";

/** ← compact.ts:299-310 */
export interface CompactionResult {
    boundaryMarker: SystemCompactBoundaryMessage;
    summaryMessages: UserMessage[];
    attachments: AttachmentMessage[];
    hookResults: Message[];
    messagesToKeep?: Message[];
    userDisplayMessage?: string;
    preCompactTokenCount?: number;
    postCompactTokenCount?: number;
    truePostCompactTokenCount?: number;
    compactionUsage?: Usage;
}

/** ← compact.ts:317-323 */
export type RecompactionInfo = {
    isRecompactionInChain: boolean;
    turnsSincePreviousCompact: number;
    previousCompactTurnId?: string;
    autoCompactThreshold: number;
    querySource?: string;
};

/** ← compact.ts:330-338（**顺序是这个函数存在的全部理由**） */
export function buildPostCompactMessages(result: CompactionResult): Message[] {
    return [
        result.boundaryMarker,
        ...result.summaryMessages,
        ...(result.messagesToKeep ?? []),
        ...result.attachments,
        ...result.hookResults,
    ];
}

/** ← compact.ts:349-367 */
export function annotateBoundaryWithPreservedSegment(
    boundary: SystemCompactBoundaryMessage,
    anchorUuid: string,
    messagesToKeep: readonly Message[] | undefined,
): SystemCompactBoundaryMessage {
    const keep = messagesToKeep ?? [];
    if (keep.length === 0) return boundary;
    return {
        ...boundary,
        compactMetadata: {
            ...boundary.compactMetadata,
            preservedSegment: {
                headUuid: keep[0]!.uuid,
                anchorUuid,
                tailUuid: keep.at(-1)!.uuid,
            },
        },
    };
}

/** ← compact.ts:374-381 */
export function mergeHookInstructions(
    userInstructions: string | undefined,
    hookInstructions: string | undefined,
): string | undefined {
    if (!hookInstructions) return userInstructions || undefined;
    if (!userInstructions) return hookInstructions;
    return `${userInstructions}\n\n${hookInstructions}`;
}

/** ← compact.ts:145-200（图片/文档换成 `[image]` / `[document]`，tool_result 内嵌的也换） */
export function stripImagesFromMessages(messages: readonly Message[]): Message[] {
    return messages.map((message) => {
        if (message.type !== "user") return message;
        const content = message.message.content;
        if (!Array.isArray(content)) return message;

        let hasMediaBlock = false;
        const newContent = content.flatMap((block): ContentBlock[] => {
            if (block.type === "image") {
                hasMediaBlock = true;
                return [{ type: "text" as const, text: "[image]" }];
            }
            if (block.type === "document") {
                hasMediaBlock = true;
                return [{ type: "text" as const, text: "[document]" }];
            }
            // Also strip images/documents nested inside tool_result content arrays
            if (block.type === "tool_result" && Array.isArray(block.content)) {
                let toolHasMedia = false;
                const newToolContent = block.content.map((item): ContentBlock => {
                    if (item.type === "image") {
                        toolHasMedia = true;
                        return { type: "text" as const, text: "[image]" };
                    }
                    if (item.type === "document") {
                        toolHasMedia = true;
                        return { type: "text" as const, text: "[document]" };
                    }
                    return item;
                });
                if (toolHasMedia) {
                    hasMediaBlock = true;
                    return [{ ...block, content: newToolContent }];
                }
            }
            return [block];
        });

        if (!hasMediaBlock) return message;
        return { ...message, message: { ...message.message, content: newContent } };
    });
}

/** ← compact.ts:211-223（EXPERIMENTAL_SKILL_SEARCH 外部恒 false → 恒等） */
export function stripReinjectedAttachments(messages: readonly Message[]): Message[] {
    if (feature("EXPERIMENTAL_SKILL_SEARCH")) {
        return messages.filter((m) => !(m.type === "attachment" && (
            m.attachment.type === "skill_discovery" || m.attachment.type === "skill_listing")));
    }
    return [...messages];
}

/**
 * ← compact.ts:243-291（逐行移植：strip 自家 marker → 按 API round 分组 →
 *   按 tokenGap 或 20% 丢组 → 至少留一组 → 若首条成了 assistant 就补一条 isMeta user marker）。
 *   【适配】getPromptTooLongTokenGap（errors.ts:104+）读的是错误的 errorDetails；
 *   本仓库没有该结构，故 tokenGap 参数由调用方直接给出（undefined → 走 20% 兜底，
 *   与源码 "Falls back to dropping 20% of groups when the gap is unparseable" 一致）。
 */
export function truncateHeadForPTLRetry(
    messages: readonly Message[],
    tokenGap: number | undefined,
    ids: { uuid?: string; timestamp?: string } = {},
): Message[] | null {
    const first = messages[0];
    const input = first && first.type === "user" && first.isMeta
        && first.message.content === PTL_RETRY_MARKER
        ? messages.slice(1)
        : messages;

    const groups = groupMessagesByApiRound(input);
    if (groups.length < 2) return null;

    let dropCount: number;
    if (tokenGap !== undefined) {
        let acc = 0;
        dropCount = 0;
        for (const g of groups) {
            acc += roughTokenCountEstimationForMessages(g);
            dropCount++;
            if (acc >= tokenGap) break;
        }
    } else {
        dropCount = Math.max(1, Math.floor(groups.length * 0.2));
    }

    dropCount = Math.min(dropCount, groups.length - 1);
    if (dropCount < 1) return null;

    const sliced = groups.slice(dropCount).flat();
    if (sliced[0]?.type === "assistant") {
        return [
            {
                type: "user",
                uuid: ids.uuid ?? randomUUID(),
                timestamp: ids.timestamp ?? new Date().toISOString(),
                isMeta: true,
                message: { content: PTL_RETRY_MARKER },
            },
            ...sliced,
        ];
    }
    return sliced;
}

/** ← compact.ts:1610-1655（Read 工具读过的文件路径集合，跳过未变更 stub 的那些） */
export function collectReadToolFilePaths(messages: readonly Message[]): Set<string> {
    const stubIds = new Set<string>();
    for (const message of messages) {
        if (message.type !== "user" || !Array.isArray(message.message.content)) continue;
        for (const block of message.message.content) {
            if (block.type === "tool_result" && typeof block.content === "string"
                && block.content.startsWith(FILE_UNCHANGED_STUB)) {
                stubIds.add(block.tool_use_id);
            }
        }
    }
    const paths = new Set<string>();
    for (const message of messages) {
        if (message.type !== "assistant" || !Array.isArray(message.message.content)) continue;
        for (const block of message.message.content) {
            if (block.type !== "tool_use" || block.name !== FILE_READ_TOOL_NAME) continue;
            if (stubIds.has(block.id)) continue;
            const input = block.input;
            if (input && typeof input === "object" && "file_path" in input
                && typeof (input as { file_path?: unknown }).file_path === "string") {
                paths.add((input as { file_path: string }).file_path);
            }
        }
    }
    return paths;
}

/** ← FileReadTool/prompt.ts 的 FILE_UNCHANGED_STUB（首行；cc 用 startsWith 判） */
export const FILE_UNCHANGED_STUB = "<file_unchanged>";

/** 【适配】cc 的 expandPath（utils/path.ts）在 Windows 下是相对 cwd 的 resolve；等价实现 */
export function expandPath(p: string, baseDir = process.cwd()): string {
    if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\") || p.startsWith("/")) return p;
    return `${baseDir.replace(/[\\/]+$/, "")}\\${p}`;
}

/** ← compact.ts:1415-1464（最近读过的文件被重新灌回去；受 maxFiles 与 POST_COMPACT_TOKEN_BUDGET 双约束） */
export async function createPostCompactFileAttachments(
    readFileState: Record<string, { content: string; timestamp: number }>,
    readFile: (path: string) => Promise<string | null>,
    maxFiles: number,
    preservedMessages: readonly Message[] = [],
): Promise<AttachmentMessage[]> {
    const preservedReadPaths = collectReadToolFilePaths(preservedMessages);
    const recentFiles = Object.entries(readFileState)
        .map(([filename, state]) => ({ filename, ...state }))
        .filter((file) => !preservedReadPaths.has(expandPath(file.filename)))
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, maxFiles);

    const results: (AttachmentMessage | null)[] = [];
    for (const file of recentFiles) {
        const content = await readFile(file.filename).catch(() => null);
        if (content === null) { results.push(null); continue; }
        // 【适配】cc 走 generateFileAttachment（FileReadTool + 文件类型识别 + 分块）；
        // 本仓库的 readFile 端口直接给正文，故用同一条 token 上限截断。
        const clipped = truncateToTokens(content, POST_COMPACT_MAX_TOKENS_PER_FILE);
        results.push({
            type: "attachment",
            uuid: randomUUID(),
            timestamp: new Date().toISOString(),
            attachment: { type: "file", filename: file.filename, content: clipped },
        });
    }

    let usedTokens = 0;
    return results.filter((result): result is AttachmentMessage => {
        if (result === null) return false;
        const attachmentTokens = roughTokenCountEstimation(jsonStringify(result));
        if (usedTokens + attachmentTokens <= POST_COMPACT_TOKEN_BUDGET) {
            usedTokens += attachmentTokens;
            return true;
        }
        return false;
    });
}

/** ← compact.ts:1666-1672 */
function truncateToTokens(content: string, maxTokens: number): string {
    const maxChars = maxTokens * 4;      // roughTokenCountEstimation 用 length/4
    if (content.length <= maxChars) return content;
    return `${content.slice(0, maxChars)}\n\n[truncated]`;
}

/** ← compact.ts:1657-1664 */
export const SKILL_TRUNCATION_MARKER = "\n[... skill truncated for length ...]";

// ---------- 摘要请求的构造（← compact.ts:1292-1326 的**请求参数**部分） ----------

export interface SummaryRequest {
    messages: Message[];
    systemPrompt: string[];
    thinkingConfig: { type: "disabled" };
    tools: string[];
    model: string;
    maxOutputTokensOverride: number;
    querySource: "compact";
    toolChoice: undefined;
}

/**
 * ← compact.ts:1292-1326。**请求怎么造的**这一半照搬（system 提示词、thinking 关、
 * tools 只剩读文件、maxOutputTokensOverride = min(COMPACT_MAX_OUTPUT_TOKENS,
 * getMaxOutputTokensForModel(model))、querySource 'compact'）；
 * **怎么发出去**那一半由宿主注入（见 CompactHost.summarize）。
 */
export function buildSummaryRequest(input: {
    messages: readonly Message[];
    summaryRequest: UserMessage;
    model: string;
    /** 【适配】工具搜索是 ant-only；外部构建的 tools 恒为 [FileReadTool] */
    toolSearchEnabled?: boolean;
}): SummaryRequest {
    return {
        messages: normalizeMessagesForAPI(
            stripImagesFromMessages(
                stripReinjectedAttachments([
                    ...getMessagesAfterCompactBoundary(input.messages),
                    input.summaryRequest,
                ]),
            ),
        ),
        systemPrompt: ["You are a helpful AI assistant tasked with summarizing conversations."],
        thinkingConfig: { type: "disabled" as const },
        tools: input.toolSearchEnabled
            ? [FILE_READ_TOOL_NAME, "ToolSearch"]
            : [FILE_READ_TOOL_NAME],
        model: input.model,
        maxOutputTokensOverride: Math.min(
            COMPACT_MAX_OUTPUT_TOKENS,
            getMaxOutputTokensForModel(input.model),
        ),
        querySource: "compact",
        toolChoice: undefined,
    };
}

/**
 * 【适配·部分移植】cc 的 `normalizeMessagesForAPI`（utils/messages.ts）是 1000+ 行的
 * API 层函数（合并同 message.id 的分块、剥 system、补 tool 配对、处理 attachment …）。
 * 这里只移植压缩**真正依赖**的那部分语义，并且写在明面上：
 *   · **丢掉 system 消息**（边界标记就是 system，源码注释 messages.ts:4641
 *     明确写了 "The boundary itself is a system message and will be filtered by
 *     normalizeMessagesForAPI"）；
 *   · **丢掉 attachment 消息**（cc 由 attachment 展开逻辑另处理）；
 *   · 其余保持原顺序原内容（不合并 message.id —— 本移植的适配层每条 assistant
 *     只有一个块，不存在 cc 那种流式分块，故合并是 no-op）。
 * 这是本移植里**最大的一处近似**，已记入适配清单。
 */
export function normalizeMessagesForAPI(messages: readonly Message[]): Message[] {
    return messages.filter((m) => m.type !== "system" && m.type !== "attachment");
}

// ---------- 摘要调用的宿主端口（【适配】cc 用 runForkedAgent / queryModelWithStreaming） ----------

export interface SummaryResponse {
    text: string | null;
    usage?: Usage;
    /** 【适配】cc 用 isApiErrorMessage 区分"摘要失败"与"摘要内容" */
    isApiErrorMessage?: boolean;
}

export interface CompactHost {
    /** 【适配】cc 的 forked agent / streaming 调用；本仓库注入 DeveloperLlm 或 Fake */
    summarize(request: SummaryRequest): Promise<SummaryResponse>;
    /** 【适配】cc 的 getTranscriptPath() */
    getTranscriptPath?: () => string;
    /** 【适配】cc 的 readFileState → 文件回灌；不注入 = 不回灌任何文件 */
    readFileState?: Record<string, { content: string; timestamp: number }>;
    readFile?: (path: string) => Promise<string | null>;
    /** 【适配】cc 的 executePreCompactHooks / processSessionStartHooks */
    preCompactHooks?: (input: { trigger: "auto" | "manual"; customInstructions: string | null })
        => Promise<{ newCustomInstructions?: string; userDisplayMessage?: string }>;
    sessionStartHooks?: (source: "compact") => Promise<Message[]>;
    ids?: { uuid?: () => string; timestamp?: () => string };
}

function hostUuid(host: CompactHost): string {
    return host.ids?.uuid ? host.ids.uuid() : randomUUID();
}
function hostTimestamp(host: CompactHost): string {
    return host.ids?.timestamp ? host.ids.timestamp() : new Date().toISOString();
}

export interface CompactConversationOptions {
    model: string;
    suppressFollowUpQuestions: boolean;
    customInstructions?: string;
    isAutoCompact?: boolean;
    recompactionInfo?: RecompactionInfo;
    /** 【适配】cc 的 isToolSearchEnabled（ant-only）；缺省 false = 外部构建分支 */
    toolSearchEnabled?: boolean;
}

/**
 * ← compact.ts:387-763。**逐段移植**，只把三件事换成端口调用：
 *   摘要生成（runForkedAgent/流式）、文件回灌的读盘、hooks。
 *   其余全部保持源码顺序与语义：
 *     notEnoughMessages 检查 → preCompactTokenCount → PreCompact hooks →
 *     PTL 重试环（≤3 次，truncateHeadForPTLRetry）→ 空摘要/API 错误抛错 →
 *     **清空 readFileState** → 并发造文件/技能/计划附件 → SessionStart hooks →
 *     边界标记 + 摘要消息 → tengu_compact 事件 → PostCompact hooks → 返回 CompactionResult。
 */
export async function compactConversation(
    messages: readonly Message[],
    host: CompactHost,
    opts: CompactConversationOptions,
): Promise<CompactionResult> {
    if (messages.length === 0) throw new Error(ERROR_MESSAGE_NOT_ENOUGH_MESSAGES);

    const preCompactTokenCount = tokenCountWithEstimation(messages);

    const hookResult = host.preCompactHooks
        ? await host.preCompactHooks({
            trigger: opts.isAutoCompact ? "auto" : "manual",
            customInstructions: opts.customInstructions ?? null,
        })
        : {};
    const customInstructions = mergeHookInstructions(
        opts.customInstructions, hookResult.newCustomInstructions,
    );

    const compactPrompt = getCompactPrompt(customInstructions);
    const summaryRequest: UserMessage = {
        type: "user",
        uuid: hostUuid(host),
        timestamp: hostTimestamp(host),
        message: { content: compactPrompt },
    };

    let messagesToSummarize: readonly Message[] = messages;
    let summaryResponse: SummaryResponse | null = null;
    let summary: string | null = null;
    let ptlAttempts = 0;

    // ← compact.ts:450-491（PTL 重试环）
    for (;;) {
        summaryResponse = await host.summarize(buildSummaryRequest({
            messages: messagesToSummarize,
            summaryRequest,
            model: opts.model,
            toolSearchEnabled: opts.toolSearchEnabled,
        }));
        summary = summaryResponse.text;
        if (!summary || !summary.startsWith(PROMPT_TOO_LONG_ERROR_MESSAGE)) break;

        ptlAttempts++;
        const truncated = ptlAttempts <= MAX_PTL_RETRIES
            ? truncateHeadForPTLRetry(messagesToSummarize, undefined)
            : null;
        if (!truncated) throw new Error(ERROR_MESSAGE_PROMPT_TOO_LONG);
        messagesToSummarize = truncated;
    }

    if (!summary) {
        throw new Error(
            "Failed to generate conversation summary - response did not contain valid text content",
        );
    }
    if (summaryResponse?.isApiErrorMessage) throw new Error(summary);

    // ← compact.ts:517-522：**清空文件读缓存**（压缩后必须重新 Read 才能 Edit）
    if (host.readFileState) {
        for (const k of Object.keys(host.readFileState)) delete host.readFileState[k];
    }

    // ← compact.ts:531-585：压缩后回灌
    const postCompactFileAttachments: AttachmentMessage[] = host.readFile
        ? await createPostCompactFileAttachments(
            host.readFileState ?? {}, host.readFile,
            POST_COMPACT_MAX_FILES_TO_RESTORE, messages,
        )
        : [];

    const hookMessages = host.sessionStartHooks ? await host.sessionStartHooks("compact") : [];

    // ← compact.ts:598-611
    const boundaryMarker = createCompactBoundaryMessage(
        opts.isAutoCompact ? "auto" : "manual",
        preCompactTokenCount ?? 0,
        messages.at(-1)?.uuid,
        undefined, undefined,
        { uuid: hostUuid(host), timestamp: hostTimestamp(host) },
    );

    // ← compact.ts:613-624（**摘要就是这样回到下一轮**：一条 isCompactSummary 的 user 消息）
    const transcriptPath = host.getTranscriptPath ? host.getTranscriptPath() : undefined;
    const summaryMessages: UserMessage[] = [{
        type: "user",
        uuid: hostUuid(host),
        timestamp: hostTimestamp(host),
        message: {
            content: getCompactUserSummaryMessage(
                summary, opts.suppressFollowUpQuestions, transcriptPath,
            ),
        },
        isCompactSummary: true,
        // 【适配·说明】cc 源码注释在 MessageSelector/VirtualMessageList 里：
        // 这个标记只影响 **UI 渲染**（不要把摘要当用户气泡显示），
        // 消息本身照常发给模型（normalizeMessagesForAPI 不因它过滤）。
        isVisibleInTranscriptOnly: true,
    }];

    // ← compact.ts:629-642
    //   cc: `tokenCountFromLastAPIResponse([summaryResponse])` —— 取的就是那次摘要调用的
    //   usage 合计（源码注释点名：这是"压缩 API 调用"的总用量，**不是**压缩后上下文的大小）。
    //   【适配】本移植的摘要端口返回 {text, usage} 而不是 AssistantMessage，
    //   所以这里直接用同一个公式 getTokenCountFromUsage(usage)，不走消息扫描。
    const compactionUsage = summaryResponse?.usage;
    const compactionCallTotalTokens = compactionUsage ? getTokenCountFromUsage(compactionUsage) : 0;
    const truePostCompactTokenCount = roughTokenCountEstimationForMessages([
        boundaryMarker, ...summaryMessages, ...postCompactFileAttachments, ...hookMessages,
    ]);

    return {
        boundaryMarker,
        summaryMessages,
        attachments: postCompactFileAttachments,
        hookResults: hookMessages,
        userDisplayMessage: hookResult.userDisplayMessage,
        preCompactTokenCount,
        postCompactTokenCount: compactionCallTotalTokens,
        truePostCompactTokenCount,
        compactionUsage,
    };
}

/**
 * ← compact.ts:650-695 的 `tengu_compact` 事件字段（去掉 cc 专有的 queryChainId /
 * analyzeContext 遥测）。**这就是要进台账的那条记录**。
 */
export interface CompactEventPayload {
    preCompactTokenCount: number;
    postCompactTokenCount: number;
    truePostCompactTokenCount: number;
    autoCompactThreshold: number;
    willRetriggerNextTurn: boolean;
    isAutoCompact: boolean;
    querySource: string;
    isRecompactionInChain: boolean;
    turnsSincePreviousCompact: number;
    previousCompactTurnId: string;
    compactionInputTokens: number | undefined;
    compactionOutputTokens: number | undefined;
    compactionCacheReadTokens: number;
    compactionCacheCreationTokens: number;
    compactionTotalTokens: number;
}

export function compactEventPayload(
    result: CompactionResult,
    opts: { isAutoCompact: boolean; recompactionInfo?: RecompactionInfo; querySource?: string },
): CompactEventPayload {
    const u = result.compactionUsage;
    const truePost = result.truePostCompactTokenCount ?? 0;
    const threshold = opts.recompactionInfo?.autoCompactThreshold ?? -1;
    return {
        preCompactTokenCount: result.preCompactTokenCount ?? 0,
        postCompactTokenCount: result.postCompactTokenCount ?? 0,
        truePostCompactTokenCount: truePost,
        autoCompactThreshold: threshold,
        willRetriggerNextTurn: opts.recompactionInfo !== undefined && truePost >= threshold,
        isAutoCompact: opts.isAutoCompact,
        querySource: opts.recompactionInfo?.querySource ?? opts.querySource ?? "unknown",
        isRecompactionInChain: opts.recompactionInfo?.isRecompactionInChain ?? false,
        turnsSincePreviousCompact: opts.recompactionInfo?.turnsSincePreviousCompact ?? -1,
        previousCompactTurnId: opts.recompactionInfo?.previousCompactTurnId ?? "",
        compactionInputTokens: u?.input_tokens,
        compactionOutputTokens: u?.output_tokens,
        compactionCacheReadTokens: u?.cache_read_input_tokens ?? 0,
        compactionCacheCreationTokens: u?.cache_creation_input_tokens ?? 0,
        compactionTotalTokens: u
            ? u.input_tokens + (u.cache_creation_input_tokens ?? 0)
              + (u.cache_read_input_tokens ?? 0) + u.output_tokens
            : 0,
    };
}

// ============================================================
// §10 services/compact/sessionMemoryCompact.ts
// ============================================================

/** ← sessionMemoryCompact.ts:47-54 */
export type SessionMemoryCompactConfig = {
    minTokens: number;
    minTextBlockMessages: number;
    maxTokens: number;
};

/** ← sessionMemoryCompact.ts:57-61（原样） */
export const DEFAULT_SM_COMPACT_CONFIG: SessionMemoryCompactConfig = {
    minTokens: 10_000,
    minTextBlockMessages: 5,
    maxTokens: 40_000,
};

let smCompactConfig: SessionMemoryCompactConfig = { ...DEFAULT_SM_COMPACT_CONFIG };
/** ← sessionMemoryCompact.ts:86-88 */
export function getSessionMemoryCompactConfig(): SessionMemoryCompactConfig {
    return { ...smCompactConfig };
}
/** ← sessionMemoryCompact.ts:74-81 */
export function setSessionMemoryCompactConfig(config: Partial<SessionMemoryCompactConfig>): void {
    smCompactConfig = { ...smCompactConfig, ...config };
}
/** ← sessionMemoryCompact.ts:93-96 */
export function resetSessionMemoryCompactConfig(): void {
    smCompactConfig = { ...DEFAULT_SM_COMPACT_CONFIG };
}

/** ← sessionMemoryCompact.ts:135-150 */
export function hasTextBlocks(message: Message): boolean {
    if (message.type === "assistant") {
        return message.message.content.some((block) => block.type === "text");
    }
    if (message.type === "user") {
        const content = message.message.content;
        if (typeof content === "string") return content.length > 0;
        if (Array.isArray(content)) return content.some((block) => block.type === "text");
    }
    return false;
}

/** ← sessionMemoryCompact.ts:155-169 */
function getToolResultIds(message: Message): string[] {
    if (message.type !== "user") return [];
    const content = message.message.content;
    if (!Array.isArray(content)) return [];
    const ids: string[] = [];
    for (const block of content) if (block.type === "tool_result") ids.push(block.tool_use_id);
    return ids;
}

/** ← sessionMemoryCompact.ts:172-186 */
function hasToolUseWithIds(message: Message, toolUseIds: ReadonlySet<string>): boolean {
    if (message.type !== "assistant") return false;
    const content = message.message.content;
    if (!Array.isArray(content)) return false;
    return content.some((block) => block.type === "tool_use" && toolUseIds.has(block.id));
}

/** ← sessionMemoryCompact.ts:232-314（工具对/thinking 块不许被切开的修正） */
export function adjustIndexToPreserveAPIInvariants(
    messages: readonly Message[],
    startIndex: number,
): number {
    if (startIndex <= 0 || startIndex >= messages.length) return startIndex;

    let adjustedIndex = startIndex;

    const allToolResultIds: string[] = [];
    for (let i = startIndex; i < messages.length; i++) {
        allToolResultIds.push(...getToolResultIds(messages[i]!));
    }

    if (allToolResultIds.length > 0) {
        const toolUseIdsInKeptRange = new Set<string>();
        for (let i = adjustedIndex; i < messages.length; i++) {
            const msg = messages[i]!;
            if (msg.type === "assistant" && Array.isArray(msg.message.content)) {
                for (const block of msg.message.content) {
                    if (block.type === "tool_use") toolUseIdsInKeptRange.add(block.id);
                }
            }
        }
        const neededToolUseIds = new Set(
            allToolResultIds.filter((id) => !toolUseIdsInKeptRange.has(id)),
        );
        for (let i = adjustedIndex - 1; i >= 0 && neededToolUseIds.size > 0; i--) {
            const message = messages[i]!;
            if (hasToolUseWithIds(message, neededToolUseIds)) {
                adjustedIndex = i;
                if (message.type === "assistant" && Array.isArray(message.message.content)) {
                    for (const block of message.message.content) {
                        if (block.type === "tool_use" && neededToolUseIds.has(block.id)) {
                            neededToolUseIds.delete(block.id);
                        }
                    }
                }
            }
        }
    }

    const messageIdsInKeptRange = new Set<string>();
    for (let i = adjustedIndex; i < messages.length; i++) {
        const msg = messages[i]!;
        if (msg.type === "assistant" && msg.message.id) messageIdsInKeptRange.add(msg.message.id);
    }
    for (let i = adjustedIndex - 1; i >= 0; i--) {
        const message = messages[i]!;
        if (message.type === "assistant" && message.message.id
            && messageIdsInKeptRange.has(message.message.id)) {
            adjustedIndex = i;
        }
    }

    return adjustedIndex;
}

/** ← sessionMemoryCompact.ts:324-397（minTokens / minTextBlockMessages / maxTokens 三闸 + 边界地板） */
export function calculateMessagesToKeepIndex(
    messages: readonly Message[],
    lastSummarizedIndex: number,
): number {
    if (messages.length === 0) return 0;
    const config = getSessionMemoryCompactConfig();

    let startIndex = lastSummarizedIndex >= 0 ? lastSummarizedIndex + 1 : messages.length;

    let totalTokens = 0;
    let textBlockMessageCount = 0;
    for (let i = startIndex; i < messages.length; i++) {
        const msg = messages[i]!;
        totalTokens += estimateMessageTokens([msg]);
        if (hasTextBlocks(msg)) textBlockMessageCount++;
    }

    if (totalTokens >= config.maxTokens) {
        return adjustIndexToPreserveAPIInvariants(messages, startIndex);
    }
    if (totalTokens >= config.minTokens && textBlockMessageCount >= config.minTextBlockMessages) {
        return adjustIndexToPreserveAPIInvariants(messages, startIndex);
    }

    let floor = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (isCompactBoundaryMessage(messages[i]!)) { floor = i + 1; break; }
    }
    for (let i = startIndex - 1; i >= floor; i--) {
        const msg = messages[i]!;
        totalTokens += estimateMessageTokens([msg]);
        if (hasTextBlocks(msg)) textBlockMessageCount++;
        startIndex = i;
        if (totalTokens >= config.maxTokens) break;
        if (totalTokens >= config.minTokens && textBlockMessageCount >= config.minTextBlockMessages) break;
    }

    return adjustIndexToPreserveAPIInvariants(messages, startIndex);
}

/** ← sessionMemoryCompact.ts:403-432 */
export function shouldUseSessionMemoryCompaction(): boolean {
    if (isEnvTruthy(process.env["ENABLE_CLAUDE_CODE_SM_COMPACT"])) return true;
    if (isEnvTruthy(process.env["DISABLE_CLAUDE_CODE_SM_COMPACT"])) return false;
    // 【适配】cc 读两个 GrowthBook 开关（tengu_session_memory 与 tengu_sm_compact），
    // 两者的默认都是 **false** → 外部环境下恒不启用。这里保留同样的默认。
    return false;
}

/** ← SessionMemory/prompts.ts:8-9, 11-41（模板原文） */
export const MAX_SECTION_LENGTH = 2000;
export const MAX_TOTAL_SESSION_MEMORY_TOKENS = 12_000;
export const DEFAULT_SESSION_MEMORY_TEMPLATE = `
# Session Title
_A short and distinctive 5-10 word descriptive title for the session. Super info dense, no filler_

# Current State
_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._

# Task specification
_What did the user ask to build? Any design decisions or other explanatory context_

# Files and Functions
_What are the important files? In short, what do they contain and why are they relevant?_

# Workflow
_What bash commands are usually run and in what order? How to interpret their output if not obvious?_

# Errors & Corrections
_Errors encountered and how they were fixed. What did the user correct? What approaches failed and should not be tried again?_

# Codebase and System Documentation
_What are the important system components? How do they work/fit together?_

# Learnings
_What has worked well? What has not? What to avoid? Do not duplicate items from other sections_

# Key results
_If the user asked a specific output such as an answer to a question, a table, or other document, repeat the exact result here_

# Worklog
_Step by step, what was attempted, done? Very terse summary for each step_
`;

/** ← SessionMemory/prompts.ts:220-224 */
export function isSessionMemoryEmpty(content: string): boolean {
    return content.trim() === DEFAULT_SESSION_MEMORY_TEMPLATE.trim();
}

/** ← SessionMemory/prompts.ts:256-324（逐行移植，含 `[... section truncated for length ...]`） */
export function truncateSessionMemoryForCompact(content: string): {
    truncatedContent: string;
    wasTruncated: boolean;
} {
    const lines = content.split("\n");
    const maxCharsPerSection = MAX_SECTION_LENGTH * 4;
    const outputLines: string[] = [];
    let currentSectionLines: string[] = [];
    let currentSectionHeader = "";
    let wasTruncated = false;

    const flush = (header: string, sectionLines: string[]) => {
        if (!header) return { lines: sectionLines, truncated: false };
        const sectionContent = sectionLines.join("\n");
        if (sectionContent.length <= maxCharsPerSection) {
            return { lines: [header, ...sectionLines], truncated: false };
        }
        let charCount = 0;
        const keptLines: string[] = [header];
        for (const line of sectionLines) {
            if (charCount + line.length + 1 > maxCharsPerSection) break;
            keptLines.push(line);
            charCount += line.length + 1;
        }
        keptLines.push("\n[... section truncated for length ...]");
        return { lines: keptLines, truncated: true };
    };

    for (const line of lines) {
        if (line.startsWith("# ")) {
            const r = flush(currentSectionHeader, currentSectionLines);
            outputLines.push(...r.lines);
            wasTruncated = wasTruncated || r.truncated;
            currentSectionHeader = line;
            currentSectionLines = [];
        } else {
            currentSectionLines.push(line);
        }
    }
    const r = flush(currentSectionHeader, currentSectionLines);
    outputLines.push(...r.lines);
    wasTruncated = wasTruncated || r.truncated;

    return { truncatedContent: outputLines.join("\n"), wasTruncated };
}

/**
 * ← sessionMemoryCompact.ts:514-630。
 *   【适配】cc 从 SessionMemory 子系统读三样东西：`getSessionMemoryContent()`、
 *   `getLastSummarizedMessageId()`、`waitForSessionMemoryExtraction()`。
 *   本仓库没有那个子系统（它是后台笔记提取器 + 磁盘 markdown），所以
 *   前两样改成**参数注入**，第三样（等提取完成）不适用、去掉。
 *   其余（边界标记、摘要包装、messagesToKeep 过滤旧 boundary、阈值复检）全部照搬。
 */
export function trySessionMemoryCompaction(
    messages: readonly Message[],
    input: {
        sessionMemory: string | null;
        lastSummarizedMessageId?: string | null;
        transcriptPath?: string;
        /** 【适配】cc 还会跑 SessionStart hooks；本仓库注入 */
        sessionStartHooks?: () => Promise<Message[]>;
        ids?: { uuid?: string; timestamp?: string };
    },
    autoCompactThreshold?: number,
): CompactionResult | null {
    if (!shouldUseSessionMemoryCompaction()) return null;

    const sessionMemory = input.sessionMemory;
    if (!sessionMemory) return null;
    if (isSessionMemoryEmpty(sessionMemory)) return null;

    const lastSummarizedMessageId = input.lastSummarizedMessageId ?? null;
    let lastSummarizedIndex: number;
    if (lastSummarizedMessageId) {
        lastSummarizedIndex = messages.findIndex((msg) => msg.uuid === lastSummarizedMessageId);
        if (lastSummarizedIndex === -1) return null;
    } else {
        lastSummarizedIndex = messages.length - 1;
    }

    const startIndex = calculateMessagesToKeepIndex(messages, lastSummarizedIndex);
    // 过滤掉旧的 compact boundary（否则 REPL 剪枝会二次触发，把新边界和摘要一起丢掉）
    const messagesToKeep = messages.slice(startIndex).filter((m) => !isCompactBoundaryMessage(m));

    const preCompactTokenCount = tokenCountFromLastAPIResponse(messages);
    const boundaryMarker = createCompactBoundaryMessage(
        "auto", preCompactTokenCount, messages[messages.length - 1]?.uuid,
        undefined, undefined, input.ids,
    );

    const { truncatedContent, wasTruncated } = truncateSessionMemoryForCompact(sessionMemory);
    let summaryContent = getCompactUserSummaryMessage(
        truncatedContent, true, input.transcriptPath, true,
    );
    if (wasTruncated) {
        summaryContent += `\n\nSome session memory sections were truncated for length. The full session memory can be viewed at: ${input.transcriptPath ?? "(unknown)"}`;
    }

    const summaryMessages: UserMessage[] = [{
        type: "user",
        uuid: input.ids?.uuid ?? randomUUID(),
        timestamp: input.ids?.timestamp ?? new Date().toISOString(),
        message: { content: summaryContent },
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
    }];

    const result: CompactionResult = {
        boundaryMarker: annotateBoundaryWithPreservedSegment(
            boundaryMarker, summaryMessages[summaryMessages.length - 1]!.uuid, messagesToKeep,
        ),
        summaryMessages,
        attachments: [],
        hookResults: [],
        messagesToKeep,
        preCompactTokenCount,
        postCompactTokenCount: estimateMessageTokens(summaryMessages),
        truePostCompactTokenCount: estimateMessageTokens(summaryMessages),
    };

    const postCompactMessages = buildPostCompactMessages(result);
    const postCompactTokenCount = estimateMessageTokens(postCompactMessages);
    if (autoCompactThreshold !== undefined && postCompactTokenCount >= autoCompactThreshold) {
        return null;
    }
    return { ...result, postCompactTokenCount, truePostCompactTokenCount: postCompactTokenCount };
}

// ============================================================
// §11 services/compact/apiMicrocompact.ts
// ============================================================

/** ← apiMicrocompact.ts:16-17 */
const DEFAULT_MAX_INPUT_TOKENS = 180_000;
const DEFAULT_TARGET_INPUT_TOKENS = 40_000;

/** ← apiMicrocompact.ts:19-32 */
const TOOLS_CLEARABLE_RESULTS: string[] = [
    ...SHELL_TOOL_NAMES, GLOB_TOOL_NAME, GREP_TOOL_NAME,
    FILE_READ_TOOL_NAME, WEB_FETCH_TOOL_NAME, WEB_SEARCH_TOOL_NAME,
];
const TOOLS_CLEARABLE_USES: string[] = [
    FILE_EDIT_TOOL_NAME, FILE_WRITE_TOOL_NAME, NOTEBOOK_EDIT_TOOL_NAME,
];

/** ← apiMicrocompact.ts:35-61 */
export type ContextEditStrategy =
    | {
        type: "clear_tool_uses_20250919";
        trigger?: { type: "input_tokens"; value: number };
        keep?: { type: "tool_uses"; value: number };
        clear_tool_inputs?: boolean | string[];
        exclude_tools?: string[];
        clear_at_least?: { type: "input_tokens"; value: number };
    }
    | { type: "clear_thinking_20251015"; keep: { type: "thinking_turns"; value: number } | "all" };
export type ContextManagementConfig = { edits: ContextEditStrategy[] };

/**
 * ← apiMicrocompact.ts:64-153（逐行移植）。
 *   【适配】cc 用它往请求体里塞 `context_management.edits`（服务端清 tool results）。
 *   本仓库的端点（DeepSeek 的 Anthropic 兼容层）**不支持** context_management，
 *   所以这个函数只移植**构造逻辑**，是否真的发出去由调用方决定（默认不发）。
 *   注意源码的门：`USER_TYPE !== 'ant'` 时 tool-clearing 策略直接不生成
 *   （→ 外部构建只可能拿到 clear_thinking 策略），这支逻辑原样保留。
 */
export function getAPIContextManagement(options?: {
    hasThinking?: boolean;
    isRedactThinkingActive?: boolean;
    clearAllThinking?: boolean;
}): ContextManagementConfig | undefined {
    const {
        hasThinking = false,
        isRedactThinkingActive = false,
        clearAllThinking = false,
    } = options ?? {};

    const strategies: ContextEditStrategy[] = [];

    if (hasThinking && !isRedactThinkingActive) {
        strategies.push({
            type: "clear_thinking_20251015",
            keep: clearAllThinking ? { type: "thinking_turns", value: 1 } : "all",
        });
    }

    if (process.env["USER_TYPE"] !== "ant") {
        return strategies.length > 0 ? { edits: strategies } : undefined;
    }

    const useClearToolResults = isEnvTruthy(process.env["USE_API_CLEAR_TOOL_RESULTS"]);
    const useClearToolUses = isEnvTruthy(process.env["USE_API_CLEAR_TOOL_USES"]);
    if (!useClearToolResults && !useClearToolUses) {
        return strategies.length > 0 ? { edits: strategies } : undefined;
    }

    const triggerThreshold = process.env["API_MAX_INPUT_TOKENS"]
        ? parseInt(process.env["API_MAX_INPUT_TOKENS"]!, 10) : DEFAULT_MAX_INPUT_TOKENS;
    const keepTarget = process.env["API_TARGET_INPUT_TOKENS"]
        ? parseInt(process.env["API_TARGET_INPUT_TOKENS"]!, 10) : DEFAULT_TARGET_INPUT_TOKENS;

    if (useClearToolResults) {
        strategies.push({
            type: "clear_tool_uses_20250919",
            trigger: { type: "input_tokens", value: triggerThreshold },
            clear_at_least: { type: "input_tokens", value: triggerThreshold - keepTarget },
            clear_tool_inputs: TOOLS_CLEARABLE_RESULTS,
        });
    }
    if (useClearToolUses) {
        strategies.push({
            type: "clear_tool_uses_20250919",
            trigger: { type: "input_tokens", value: triggerThreshold },
            clear_at_least: { type: "input_tokens", value: triggerThreshold - keepTarget },
            exclude_tools: TOOLS_CLEARABLE_USES,
        });
    }
    return strategies.length > 0 ? { edits: strategies } : undefined;
}

// ============================================================
// §12 services/compact/autoCompact.ts（触发判定）
//
//   ★ 基准 = **用户配置的上下文窗口**，不是常量。
//
//   cc 的判定是"拿一个数去和一条线比"（autoCompact.ts:119-120, 233-238）：
//     比的是 tokenCountWithEstimation（§3），线是
//       eff = 窗口 − min(模型最大输出, 20_000)              （:33-49）
//       线  = eff − 13_000                                  （:72-76）
//       预警/报错 = 线 − 20_000；阻塞线 = eff − 3_000        （:113-117, :123-124）
//   四个扣减量在源码里都是**绝对值**，隐含"窗口 200_000"这个前提
//   （200_000 − 20_000 = 180_000，减 13_000 得 167_000）。
//
//   ★ 本产品把窗口做成**用户输入**（MySQL sys_settings，见 §12.1 的接线说明），
//     于是窗口可能是 32K，也可能是 1M。绝对值扣减在小窗口上会退化：
//     窗口 32_000 时 32_000 − 20_000 − 13_000 = **−1_000**，
//     线变成负数 ⇒ 每一轮都判定"该压缩" ⇒ 压缩抖动。
//     所以这里把四个绝对值**按源码自己的标定窗口折算成比例**（分母就是
//     200_000 − 20_000 = 180_000，即 cc 那三个常数原本标定的 eff），
//     公式**形状一字不改**，只把"减多少"从绝对数换成同一比例的数：
//       eff = 窗口 − min(模型最大输出, 20_000)
//       线  = eff − floor(eff × 13_000/180_000)
//       预警/报错 = 线 − floor(eff × 20_000/180_000)
//       阻塞线 = eff − floor(eff × 3_000/180_000)
//     在 200_000 的窗口上这三条**逐位等于 cc**（167_000 / 147_000 / 177_000，
//     有回归测试与 cc 的绝对原式对拍），换个窗口则整体等比缩放。
//
//   ★ 这也是源码里**本来就有的那条路**：CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
//     （:79-88）走的就是"eff × 百分比"，再与绝对式取 min。
//     本模块保留该覆盖口，只是把**默认**从绝对式换成了同源的比例式。
//     （属宿主适配，已列入 contextBudget.wiring.md 的适配清单 A23。）
// ============================================================

/** ← autoCompact.ts:28-30（与 §2 的 COMPACT_MAX_OUTPUT_TOKENS 同值，源码里也是两个文件各写一份） */
export const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;

/** ← autoCompact.ts:62-65（**四个缓冲常量，原样**——它们就是下面那些比例分子的来源） */
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000;
export const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000;
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000;

/**
 * cc 那几个绝对值**标定在哪个 eff 上**：200_000 − min(32_000, 20_000) = 180_000。
 * 这就是比例的分母——不是新发明的数，是从源码自己的窗口前提里读出来的。
 */
export const CC_REFERENCE_EFFECTIVE_WINDOW = 180_000;
export const AUTOCOMPACT_BUFFER_FRACTION = {
    num: AUTOCOMPACT_BUFFER_TOKENS, den: CC_REFERENCE_EFFECTIVE_WINDOW,
} as const;
export const WARNING_BUFFER_FRACTION = {
    num: WARNING_THRESHOLD_BUFFER_TOKENS, den: CC_REFERENCE_EFFECTIVE_WINDOW,
} as const;
/** 与 WARNING 同值（源码里也是两个常量各写一份），分开定义以便将来各自变化 */
export const ERROR_BUFFER_FRACTION = {
    num: ERROR_THRESHOLD_BUFFER_TOKENS, den: CC_REFERENCE_EFFECTIVE_WINDOW,
} as const;
export const BLOCKING_BUFFER_FRACTION = {
    num: MANUAL_COMPACT_BUFFER_TOKENS, den: CC_REFERENCE_EFFECTIVE_WINDOW,
} as const;

/** 比例式扣减。**先乘后除**，整数运算范围内精确（180_000 上正好得 13_000，不差 1）。 */
export function ratioBuffer(effectiveWindow: number, f: { num: number; den: number }): number {
    return Math.floor((effectiveWindow * f.num) / f.den);
}

// ---------- §12.1 窗口基准：用户输入 + 分档覆盖 ----------

/** 档位（与 models.ts:109 的 RoleTier 同构） */
export type RoleTier = "pro" | "flash";

/** 这个窗口数是**哪来的**——台账与告警都靠它分辨"事实"与"假设" */
export type ContextWindowSourceKind =
    | "settings-tier"          // sys_settings.context_window_pro（pro 档专用覆盖）
    | "settings"               // sys_settings.context_window（用户填的基准）
    | "env"                    // CF_CONTEXT_WINDOW_TOKENS（运维逃生口）
    | "model-suffix"           // 模型名自带 [1m] → 1M（模型名本身就是声明）
    | "unset-default";         // 用户没配 → 产品默认 256K（degraded=true，会告警）

export interface ContextWindowSpec {
    /** 基准：模型能吃下的最大输入 token。**阈值全是它的比例** */
    contextWindowTokens: number;
    /**
     * `contextWindowTokens` 的**只读别名**（两个字段永远同值）。
     *   存在的理由：`developerAgent/contextCompaction.ts`（接线层，另一位作者）按
     *   `window.contextTokens` 取值。与其让两边的字段名打架、或者让它去猜，
     *   不如由本模块同时提供两个名字——**规范名是 `contextWindowTokens`**（owner 规格里的写法），
     *   `contextTokens` 是兼容别名。手工构造 spec 时只填任意一个也能跑（`asWindowSpec` 会补齐）。
     */
    contextTokens: number;
    source: ContextWindowSourceKind;
    /** true = 用户还没配，用的是默认值（要告警、要在台账留痕） */
    degraded: boolean;
    /** 该档位生效的模型名（models.ts resolveModelConfig 的产物） */
    model: string;
    /** 档位；null = 该角色不分层 */
    tier: RoleTier | null;
}

/**
 * ★ 用户**没配**窗口时用的默认基准：256_000（256K，owner 拍板「没填时按照256K默认」）。
 *
 *   ★ 为什么必须有一个默认、且为什么这个默认**只能是兜底**（owner 的原话与理由）：
 *     本仓库跑的是**双档模型**：pro 档模型名 `deepseek-v4-pro[1m]`（自带 1M 声明）、
 *     flash 档 `deepseek-v4-flash`（名字里没有任何窗口信息），两档差**一个数量级**。
 *     所以"一个写死的窗口"从机制上就是错的——它必然对其中一档错得离谱。
 *     256_000 只是"用户还没在设置页填之前"的兜底；**真正的答案是按档配置**
 *     （`sys_settings.context_window` 全局基准 + `context_window_pro` pro 档覆盖，
 *     经 `resolveContextWindow` 的 ①② 两条优先级生效）。
 *     换句话说：看到 `source: "unset-default"` 就等于看到"这个部署还没配好"，
 *     它是**待办**，不是设定。
 *
 *   它怎么参与计算：和用户填的值走**同一套**百分比阈值（§12 开头那条比例式），
 *   所以换掉这个常数就等于整体平移四道线，没有第二处需要改。
 *
 *   ★ 这个方向的风险**必须说清**（诚实记录，不粉饰）：
 *     这个数是**大于** cc 自己的标定窗口 200_000 的。而 "窗口 − min(最大输出,20_000)" 之后
 *     再按比例上收，意味着**假设得偏大 ⇒ 线偏高 ⇒ 压缩触发偏晚**；如果这台部署上模型
 *     的真实窗口比 256K 小，压缩就会在该压的时候没压，一路发到越窗
 *     （400 / 决策丢失 → 白烧一轮，历史实测 45s/次）——正是这套机制存在的理由。
 *     之所以仍然接受这个默认：产品要求"没配就走 256K"，且**告警 + degraded 标记**
 *     让"这一轮是在默认值上跑的"永远可见；真正安全的做法只有一个：在设置页填真实值。
 *     想临时收紧（不需要改库）可以用 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` —— 那是个取 min 的闸。
 *
 *   为什么必须有这个默认而不是"没配就不压"：没配就不压等于把越窗保护整个关掉，
 *   那是把故障从"可能压得不准"换成"一定越窗"。给一个默认值 + 让它可见，是更小的一步。
 */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 256_000;

/** 【兼容别名】旧名（128_000 那版）保留一版，避免接线中途出现 import 不到 */
export const CONSERVATIVE_CONTEXT_WINDOW_TOKENS = DEFAULT_CONTEXT_WINDOW_TOKENS;

export interface ResolveContextWindowInput {
    /**
     * `sys_settings.context_window`（用户填的基准，token）。
     * 类型是 `unknown` 而不是 `number`：值直接来自 MySQL 行（mysql2 给的是 any，
     * 空列是 null、坏数据可能是 "128k" 这种串），解析与"垃圾当没配"由本函数负责，
     * **调用方不需要也不应该先转型**（先转型就会把垃圾静默变成 0/NaN）。
     */
    contextWindowTokens?: unknown;
    /** `sys_settings.context_window_pro`（pro 档覆盖，token）。只在 tier==="pro" 时看 */
    contextWindowProTokens?: unknown;
    /** 【别名】`contextWindowTokens` 的另一种写法，同义（兼容接线层） */
    contextTokens?: unknown;
    /** 【别名】`contextWindowProTokens` 的另一种写法，同义（兼容接线层） */
    contextTokensPro?: unknown;
    /** 该档位生效的模型名（`models.ts` 的 resolveModelConfig 产物） */
    model?: string | null;
    /** 档位（`models.ts` 的 resolveRoleTier 产物） */
    tier?: RoleTier | null;
    env?: EnvLike;
    /** 告警出口；缺省 console.warn。同一个 (tier, model) 只喊一次 */
    warn?: (line: string) => void;
}

function parsePositiveTokens(v: unknown): number | null {
    if (typeof v === "number") return Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
    if (typeof v === "string") {
        const t = v.trim();
        if (t === "") return null;
        const n = Number(t);
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
    }
    return null;
}

const warnedWindowKeys = new Set<string>();

/**
 * 解析"这一档、这个模型"的窗口基准。**优先级 = 产品自己的配置优先级**
 * （`settings.ts:7` 拍板：`sys_settings > .env > 内置默认`）：
 *
 *   ① `context_window_pro`（仅 pro 档；与 `model_pro` 空则退回全局名的约定一致，:15）
 *   ② `context_window`（用户填的全局基准）
 *   ③ 模型名自带 `[1m]` → 1_000_000
 *   ④ `CF_CONTEXT_WINDOW_TOKENS`（运维逃生口，不改库也能临时定住）
 *   ⑤ 产品默认 256_000 + 一行告警 + `degraded: true`
 *
 *   ③ 排在 ④ 前面是有意的：**模型名也是 sys_settings 里的值**（`model_name` /
 *   `model_pro`），用户写了 `[1m]` 就是声明了 1M；运维要用 .env 压住它，
 *   该用的是 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`（那是个**取 min 的闸**，
 *   在 `getEffectiveContextWindowSize` 里，任何情况下都生效）——
 *   "声明"和"封顶"是两件事，别用同一个旋钮。
 *   反过来说：如果让 ④ 压过 ③，同一个 `deepseek-v4-pro[1m]` 会算出两个不同的窗口
 *   （`getContextWindowForModel` 认名字、`getEffectiveContextWindowSize` 认 env），
 *   那是自相矛盾，不是灵活性。
 */
export function resolveContextWindow(input: ResolveContextWindowInput = {}): ContextWindowSpec {
    const env = input.env ?? process.env;
    const model = (input.model ?? "").trim();
    const tier = input.tier ?? null;
    // 别名入参：`contextTokens` 与 `contextWindowTokens` 同义（兼容接线层的写法）
    const declaredGlobal = input.contextWindowTokens ?? input.contextTokens;

    const proOverride = tier === "pro"
        ? parsePositiveTokens(input.contextWindowProTokens ?? input.contextTokensPro)
        : null;
    if (proOverride !== null) {
        return specOf(proOverride, "settings-tier", false, model, tier);
    }
    const global = parsePositiveTokens(declaredGlobal);
    if (global !== null) {
        return specOf(global, "settings", false, model, tier);
    }
    if (/\[1m\]/i.test(model)) {
        return specOf(1_000_000, "model-suffix", false, model, tier);
    }
    const fromEnv = parsePositiveTokens(env["CF_CONTEXT_WINDOW_TOKENS"]);
    if (fromEnv !== null) {
        return specOf(fromEnv, "env", false, model, tier);
    }

    const spec = specOf(DEFAULT_CONTEXT_WINDOW_TOKENS, "unset-default", true, model, tier);
    const key = `${tier ?? "-"}::${model || "-"}`;
    if (!warnedWindowKeys.has(key)) {
        warnedWindowKeys.add(key);
        const line = `[contextBudget] 上下文窗口未配置（sys_settings.context_window 为空）：`
            + `按**产品默认** ${DEFAULT_CONTEXT_WINDOW_TOKENS} token 计算压缩阈值`
            + `（模型 ${model || "未指定"} / 档位 ${tier ?? "不分层"}）。`
            + `这个默认值大于多数模型的真实窗口也没准，若本机模型窗口更小，`
            + `压缩会触发过晚 → 越窗 400 / 决策丢失（白烧一轮）。`
            + `请在设置页填「上下文窗口」= 该模型真实的最大输入 token`
            + `（sys_settings.context_window / context_window_pro）。`;
        (input.warn ?? defaultWarn)(line);
    }
    return spec;
}

/** 构造 spec 的**唯一**出口：两个同义字段（`contextWindowTokens` / `contextTokens`）在这里一次补齐 */
function specOf(
    tokens: number,
    source: ContextWindowSourceKind,
    degraded: boolean,
    model: string,
    tier: RoleTier | null,
): ContextWindowSpec {
    return { contextWindowTokens: tokens, contextTokens: tokens, source, degraded, model, tier };
}

function defaultWarn(line: string): void {
    console.warn(line);
}

/** 【适配】测试/接线用：清掉"已告警过"的记忆（否则同一个 key 只喊一次） */
export function resetContextWindowWarnings(): void {
    warnedWindowKeys.clear();
}

/**
 * 把入参统一成 {@link ContextWindowSpec}：
 *   · 字符串（"模型名"简写）→ 走 `resolveContextWindow` 解析（旧调用点平滑过渡）；
 *   · 手工构造的 spec → **补齐两个同义字段**（只填 `contextTokens` 或只填
 *     `contextWindowTokens` 都能用，避免"少填一个字段就静默变 0"）。
 */
export function asWindowSpec(x: string | ContextWindowSpec): ContextWindowSpec {
    if (typeof x === "string") return resolveContextWindow({ model: x });
    const v = x.contextWindowTokens ?? x.contextTokens;
    if (v === x.contextWindowTokens && v === x.contextTokens) return x;
    return { ...x, contextWindowTokens: v, contextTokens: v };
}

/** ← autoCompact.ts:51-60 */
export type AutoCompactTrackingState = {
    compacted: boolean;
    turnCounter: number;
    turnId: string;
    consecutiveFailures?: number;
};

/** ← autoCompact.ts:67-70（BQ 2026-03-10：1,279 个会话连续失败 50+ 次，最多 3,272 次） */
export const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3;

/**
 * ← autoCompact.ts:33-49。
 *   输出预留照源码取 `min(模型最大输出, 20_000)`；**多一道宿主守卫**：
 *   预留不许吃掉半个窗口（窗口 ≤ 40_000 时若不夹，eff 会变成 0 或负数，
 *   后面的比例式就失去了分母）。守卫是三处【适配】之一，见适配清单 A24。
 */
export function getEffectiveContextWindowSize(windowOrModel: string | ContextWindowSpec): number {
    const spec = asWindowSpec(windowOrModel);
    const reservedTokensForSummary = Math.min(
        Math.min(getMaxOutputTokensForModel(spec.model), MAX_OUTPUT_TOKENS_FOR_SUMMARY),
        Math.floor(spec.contextWindowTokens / 2),
    );
    let contextWindow = spec.contextWindowTokens;

    // cc 的运维闸：CLAUDE_CODE_AUTO_COMPACT_WINDOW 取 min（:40-46）
    const autoCompactWindow = process.env["CLAUDE_CODE_AUTO_COMPACT_WINDOW"];
    if (autoCompactWindow) {
        const parsed = parseInt(autoCompactWindow, 10);
        if (!isNaN(parsed) && parsed > 0) contextWindow = Math.min(contextWindow, parsed);
    }
    return Math.max(1, contextWindow - reservedTokensForSummary);
}

/**
 * ← autoCompact.ts:72-91。线的算法见本章开头的推导：绝对缓冲折算成比例，
 * 于是**任何**窗口都不会算出负数；200_000 窗口上逐位等于 cc 的 167_000。
 * 保留源码的百分比覆盖口 `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`（取更小的那个）。
 */
export function getAutoCompactThreshold(windowOrModel: string | ContextWindowSpec): number {
    const effectiveContextWindow = getEffectiveContextWindowSize(windowOrModel);
    const autocompactThreshold =
        effectiveContextWindow - ratioBuffer(effectiveContextWindow, AUTOCOMPACT_BUFFER_FRACTION);

    const envPercent = process.env["CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"];
    if (envPercent) {
        const parsed = parseFloat(envPercent);
        if (!isNaN(parsed) && parsed > 0 && parsed <= 100) {
            const percentageThreshold = Math.floor(effectiveContextWindow * (parsed / 100));
            return Math.min(percentageThreshold, autocompactThreshold);
        }
    }
    return autocompactThreshold;
}

/**
 * **保真锚点**：cc 的绝对原式（:33-91, :113-124），只用于对拍。
 *   它把窗口当作 cc 自己的 200_000 前提；本模块的默认路径不经过它。
 *   测试用它在 200_000 窗口上验证"比例式 ≡ 绝对式"，保证折算没有走样。
 */
export function getCcExactThresholds(model: string): {
    effectiveWindow: number;
    autocompactThreshold: number;
    warningThreshold: number;
    errorThreshold: number;
    blockingLimit: number;
} {
    const effectiveWindow = getContextWindowForModel(model)
        - Math.min(getMaxOutputTokensForModel(model), MAX_OUTPUT_TOKENS_FOR_SUMMARY);
    const autocompactThreshold = effectiveWindow - AUTOCOMPACT_BUFFER_TOKENS;
    return {
        effectiveWindow,
        autocompactThreshold,
        warningThreshold: autocompactThreshold - WARNING_THRESHOLD_BUFFER_TOKENS,
        errorThreshold: autocompactThreshold - ERROR_THRESHOLD_BUFFER_TOKENS,
        blockingLimit: effectiveWindow - MANUAL_COMPACT_BUFFER_TOKENS,
    };
}

/**
 * 阻塞线（cc 的 `blockingLimit` = `eff − floor(eff×3_000/180_000)`）：越线的请求**不许发**。
 *
 *   【适配·接线需要】源码里这个值是在 `calculateTokenWarningState` 内部算完就丢的
 *   （只返回布尔），但**接线方要把它写进台账/告警/问人的题面**（"用了多少 / 线在哪"），
 *   所以这里把它提成一个导出函数：`calculateTokenWarningState` 也改成调它，
 *   于是"判定用的线"与"报出来的线"**同一个来源**，不会各算一份（本仓库吃过"四处同源"的亏）。
 *   保留 cc 的运维覆盖口 `CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE`（有效则直接顶掉）。
 */
export function getBlockingLimit(windowOrModel: string | ContextWindowSpec): number {
    const effectiveWindow = getEffectiveContextWindowSize(windowOrModel);
    const defaultBlockingLimit =
        effectiveWindow - ratioBuffer(effectiveWindow, BLOCKING_BUFFER_FRACTION);
    const blockingLimitOverride = process.env["CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE"];
    const parsedOverride = blockingLimitOverride ? parseInt(blockingLimitOverride, 10) : NaN;
    return !isNaN(parsedOverride) && parsedOverride > 0 ? parsedOverride : defaultBlockingLimit;
}

/** ← autoCompact.ts:93-145（四道线全部走同一套比例式扣减） */
export function calculateTokenWarningState(
    tokenUsage: number,
    windowOrModel: string | ContextWindowSpec,
): {
    percentLeft: number;
    isAboveWarningThreshold: boolean;
    isAboveErrorThreshold: boolean;
    isAboveAutoCompactThreshold: boolean;
    isAtBlockingLimit: boolean;
} {
    const autoCompactThreshold = getAutoCompactThreshold(windowOrModel);
    const effectiveWindow = getEffectiveContextWindowSize(windowOrModel);
    const threshold = isAutoCompactEnabled()
        ? autoCompactThreshold
        : effectiveWindow;

    const percentLeft = Math.max(
        0, Math.round(((threshold - tokenUsage) / Math.max(1, threshold)) * 100),
    );

    const warningThreshold =
        threshold - ratioBuffer(effectiveWindow, WARNING_BUFFER_FRACTION);
    const errorThreshold =
        threshold - ratioBuffer(effectiveWindow, ERROR_BUFFER_FRACTION);
    const isAboveWarningThreshold = tokenUsage >= warningThreshold;
    const isAboveErrorThreshold = tokenUsage >= errorThreshold;
    const isAboveAutoCompactThreshold =
        isAutoCompactEnabled() && tokenUsage >= autoCompactThreshold;

    const blockingLimit = getBlockingLimit(windowOrModel);
    const isAtBlockingLimit = tokenUsage >= blockingLimit;

    return {
        percentLeft, isAboveWarningThreshold, isAboveErrorThreshold,
        isAboveAutoCompactThreshold, isAtBlockingLimit,
    };
}

/** 【适配】cc 读全局 config 的 autoCompactEnabled；本仓库用 env，默认 true */
let userAutoCompactEnabled = true;
export function setAutoCompactEnabled(enabled: boolean): void { userAutoCompactEnabled = enabled; }

/** ← autoCompact.ts:147-158 */
export function isAutoCompactEnabled(): boolean {
    if (isEnvTruthy(process.env["DISABLE_COMPACT"])) return false;
    if (isEnvTruthy(process.env["DISABLE_AUTO_COMPACT"])) return false;
    return userAutoCompactEnabled;
}

/**
 * ← autoCompact.ts:160-239（含全部递归守卫与门控，逐行移植）。
 *   【适配】querySource / snipTokensFreed 都是 cc 的内部概念：
 *     · 'session_memory' / 'compact' 两条守卫是"forked agent 会死锁"，本移植保留
 *       （调用方在摘要子调用里要传 querySource: 'compact'）；
 *     · CONTEXT_COLLAPSE / REACTIVE_COMPACT 在本仓库的 feature 表里恒 false，
 *       对应分支不可达（源码本身也用 feature() 包着）；
 *     · snipTokensFreed 保留形参（HISTORY_SNIP 恒 false 时恒为 0）。
 */
export async function shouldAutoCompact(
    messages: readonly Message[],
    windowOrModel: string | ContextWindowSpec,
    querySource?: string,
    snipTokensFreed = 0,
): Promise<boolean> {
    if (querySource === "session_memory" || querySource === "compact") return false;
    if (!isAutoCompactEnabled()) return false;

    const tokenCount = tokenCountWithEstimation(messages) - snipTokensFreed;
    const { isAboveAutoCompactThreshold } = calculateTokenWarningState(tokenCount, windowOrModel);
    return isAboveAutoCompactThreshold;
}

/**
 * ← autoCompact.ts:241-351（逐段移植）。
 *   顺序是源码的秩序：DISABLE_COMPACT 短路 → **熔断器**（连续失败 ≥3 次直接放弃）
 *   → shouldAutoCompact → 先试 **session memory 压缩** → 失败才走
 *   compactConversation → catch 里累加 consecutiveFailures。
 */
export async function autoCompactIfNeeded(
    messages: readonly Message[],
    host: CompactHost,
    windowOrModel: string | ContextWindowSpec,
    querySource?: string,
    tracking?: AutoCompactTrackingState,
    snipTokensFreed?: number,
    sessionMemory?: { content: string | null; lastSummarizedMessageId?: string | null },
): Promise<{ wasCompacted: boolean; compactionResult?: CompactionResult; consecutiveFailures?: number }> {
    if (isEnvTruthy(process.env["DISABLE_COMPACT"])) return { wasCompacted: false };

    // Circuit breaker
    if (
        tracking?.consecutiveFailures !== undefined
        && tracking.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
    ) {
        return { wasCompacted: false };
    }

    const windowSpec = asWindowSpec(windowOrModel);
    const shouldCompact = await shouldAutoCompact(messages, windowSpec, querySource, snipTokensFreed);
    if (!shouldCompact) return { wasCompacted: false };

    const recompactionInfo: RecompactionInfo = {
        isRecompactionInChain: tracking?.compacted === true,
        turnsSincePreviousCompact: tracking?.turnCounter ?? -1,
        previousCompactTurnId: tracking?.turnId,
        autoCompactThreshold: getAutoCompactThreshold(windowSpec),
        querySource,
    };

    // EXPERIMENT: Try session memory compaction first
    const sessionMemoryResult = sessionMemory
        ? trySessionMemoryCompaction(messages, {
            sessionMemory: sessionMemory.content,
            lastSummarizedMessageId: sessionMemory.lastSummarizedMessageId,
            transcriptPath: host.getTranscriptPath ? host.getTranscriptPath() : undefined,
            ...(host.sessionStartHooks ? { sessionStartHooks: () => host.sessionStartHooks!("compact") } : {}),
        }, recompactionInfo.autoCompactThreshold)
        : null;
    if (sessionMemoryResult) {
        runPostCompactCleanup(querySource);
        return { wasCompacted: true, compactionResult: sessionMemoryResult };
    }

    try {
        const compactionResult = await compactConversation(messages, host, {
            model: windowSpec.model,
            suppressFollowUpQuestions: true,
            isAutoCompact: true,
            recompactionInfo,
        });
        runPostCompactCleanup(querySource);
        return { wasCompacted: true, compactionResult, consecutiveFailures: 0 };
    } catch (error) {
        if ((error as Error).message !== ERROR_MESSAGE_USER_ABORT) {
            // 【适配】cc 的 logError → 本仓库没有全局 logger，交给调用方从返回值判断
        }
        const prevFailures = tracking?.consecutiveFailures ?? 0;
        const nextFailures = prevFailures + 1;
        return { wasCompacted: false, consecutiveFailures: nextFailures };
    }
}

// ============================================================
// §13 services/compact/postCompactCleanup.ts
// ============================================================

/**
 * ← postCompactCleanup.ts:31-77。
 *   【适配】cc 清的是它自己的一堆进程内缓存（systemPromptSections / memory files /
 *   classifier approvals / speculative checks / beta tracing / session messages cache）。
 *   本仓库对应的只有两处：`readFileState`（在 compactConversation 里清，见 §9）与
 *   microcompact 的模块级状态。其余在 CrewForge 里没有对应物 → 不写空壳调用，
 *   直接在这里列明（免得后来人以为漏了）。
 *   保留的语义：**子 agent（agent:*）压缩不许清主线程模块级状态**。
 */
export function runPostCompactCleanup(querySource?: string): void {
    const isMainThreadCompact =
        querySource === undefined
        || querySource.startsWith("repl_main_thread")
        || querySource === "sdk";
    if (isMainThreadCompact) {
        resetMicrocompactState();
    }
}

// ============================================================
// §14 CrewForge 接线壳（**唯一的非移植部分**，仅做适配，不含任何新策略）
// ============================================================

/**
 * 把一次 auto-compact 的产物落到 CrewForge 的扁平 history 上。
 *   cc 的对应动作是 `messagesForQuery = buildPostCompactMessages(result)`
 *   （query.ts:535 / :1153）——**整体替换**，从不 splice 中部。
 *   这里做的一样是整体替换，只是把 cc 形状再转回扁平条目。
 */
export function applyCompactionToHistory(
    history: readonly unknown[],
    result: CompactionResult,
): { history: unknown[]; messages: Message[] } {
    const messages = buildPostCompactMessages(result);
    const kept = messagesToHistory(messages);
    // 边界标记与摘要消息本身要保留在 history 里（模型下一轮看得到"这里被压缩过"）
    const summaryOf = (m: Message): string => {
        if (m.type !== "user") return "";
        const c = m.message.content;
        return typeof c === "string"
            ? c
            : c.map((b) => (b.type === "text" ? b.text : "")).join("");
    };
    const digestish = messages
        .filter((m): m is UserMessage => m.type === "user" && m.isCompactSummary === true)
        .map((m) => ({ type: "compaction_summary", text: summaryOf(m) }));
    const boundary = messages.filter(isCompactBoundaryMessage);
    return {
        history: [...boundary, ...digestish, ...kept],
        messages,
    };
}

/** 【适配】给 realLlm/UI 的一行人类可读描述（cc 有 TokenWarning.tsx 显示 percentLeft） */
export function describeTokenWarning(tokenUsage: number, model: string): string {
    const s = calculateTokenWarningState(tokenUsage, model);
    if (s.isAtBlockingLimit) return `Context at blocking limit (${s.percentLeft}% remaining)`;
    if (s.isAboveErrorThreshold) return `Context low (${s.percentLeft}% remaining)`;
    if (s.isAboveWarningThreshold) return `Context approaching limit (${s.percentLeft}% remaining)`;
    return `Context OK (${s.percentLeft}% remaining)`;
}
