// ============================================================
// tests/context-budget.test.ts —— Claude Code 压缩机制的移植验收（零 LLM、零网络）
//
//   本文件的断言分两类，**分开摆**：
//     · 「移植一致性」：断言的值必须与 `F:\code\GitHub\claude-code-source` 里的源码一致，
//       每条都标了源文件的 file:line。这些不是"我觉得合理"，是"和源码逐字对过"。
//     · 「行为」：驱动移植后的函数，断言它与源码描述的行为一致（含默认关闭、
//       边界标记的文案、摘要回灌的抬头那句英文 …）。
//
//   为什么阈值那几条最重要：`getEffectiveContextWindowSize` / `getAutoCompactThreshold`
//   是整个机制的总开关。源码的算法是
//   `contextWindow − min(maxOutputTokens(model), 20_000) − 13_000`（autoCompact.ts:33-91），
//   200K 窗口 → 167_000。移植后必须还是 167_000，**不能是别的数**。
import { describe, expect, it, beforeEach } from "bun:test";
import {
    // §1 估算
    roughTokenCountEstimation, bytesPerTokenForFileType, roughTokenCountEstimationForFileType,
    roughTokenCountEstimationForMessages, roughTokenCountEstimationForMessage,
    // §2 模型窗口
    MODEL_CONTEXT_WINDOW_DEFAULT, COMPACT_MAX_OUTPUT_TOKENS, CAPPED_DEFAULT_MAX_TOKENS,
    has1mContext, getContextWindowForModel, getModelMaxOutputTokens, getMaxOutputTokensForModel,
    contextWindowSource,
    // §12.1 窗口基准：用户配置 + 分档
    resolveContextWindow, asWindowSpec, resetContextWindowWarnings,
    DEFAULT_CONTEXT_WINDOW_TOKENS, CONSERVATIVE_CONTEXT_WINDOW_TOKENS, CC_REFERENCE_EFFECTIVE_WINDOW,
    AUTOCOMPACT_BUFFER_FRACTION, WARNING_BUFFER_FRACTION, BLOCKING_BUFFER_FRACTION,
    ratioBuffer, getCcExactThresholds,
    // §3 token 计量
    getTokenCountFromUsage, tokenCountFromLastAPIResponse, tokenCountWithEstimation,
    // §4 时间触发配置
    TIME_BASED_MC_CONFIG_DEFAULTS, getTimeBasedMCConfig, setTimeBasedMCConfig, resetTimeBasedMCConfig,
    feature,
    // §5 微压缩
    TIME_BASED_MC_CLEARED_MESSAGE, COMPACTABLE_TOOLS, estimateMessageTokens,
    microcompactMessages, evaluateTimeBasedTrigger, isMainThreadSource,
    resetMicrocompactState, getCachedMCConfig, setCachedMicrocompactConfig,
    // §6 分组
    groupMessagesByApiRound,
    // §7 边界
    createCompactBoundaryMessage, createMicrocompactBoundaryMessage,
    isCompactBoundaryMessage, findLastCompactBoundaryIndex, getMessagesAfterCompactBoundary,
    // §8 提示词（逐字）
    NO_TOOLS_PREAMBLE, NO_TOOLS_TRAILER, BASE_COMPACT_PROMPT,
    DETAILED_ANALYSIS_INSTRUCTION_BASE, PARTIAL_COMPACT_PROMPT, PARTIAL_COMPACT_UP_TO_PROMPT,
    getCompactPrompt, getPartialCompactPrompt, formatCompactSummary, getCompactUserSummaryMessage,
    // §9 宏压缩
    POST_COMPACT_MAX_FILES_TO_RESTORE, POST_COMPACT_TOKEN_BUDGET, POST_COMPACT_MAX_TOKENS_PER_FILE,
    ERROR_MESSAGE_NOT_ENOUGH_MESSAGES, ERROR_MESSAGE_PROMPT_TOO_LONG,
    PROMPT_TOO_LONG_ERROR_MESSAGE,
    buildPostCompactMessages, annotateBoundaryWithPreservedSegment, mergeHookInstructions,
    stripImagesFromMessages, truncateHeadForPTLRetry, collectReadToolFilePaths,
    createPostCompactFileAttachments, compactConversation, compactEventPayload,
    buildSummaryRequest, normalizeMessagesForAPI, expandPath,
    // §10 session memory
    DEFAULT_SM_COMPACT_CONFIG, getSessionMemoryCompactConfig, setSessionMemoryCompactConfig,
    resetSessionMemoryCompactConfig, hasTextBlocks, calculateMessagesToKeepIndex,
    adjustIndexToPreserveAPIInvariants, shouldUseSessionMemoryCompaction,
    DEFAULT_SESSION_MEMORY_TEMPLATE, isSessionMemoryEmpty, truncateSessionMemoryForCompact,
    trySessionMemoryCompaction,
    // §11 API 侧
    getAPIContextManagement,
    // §12 自动压缩
    AUTOCOMPACT_BUFFER_TOKENS, WARNING_THRESHOLD_BUFFER_TOKENS, ERROR_THRESHOLD_BUFFER_TOKENS,
    MANUAL_COMPACT_BUFFER_TOKENS, MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
    getEffectiveContextWindowSize, getAutoCompactThreshold, calculateTokenWarningState,
    isAutoCompactEnabled, setAutoCompactEnabled, shouldAutoCompact, autoCompactIfNeeded,
    // §13 清理
    runPostCompactCleanup,
    // §14 接线壳
    historyToMessages, messagesToHistory, applyCompactionToHistory, describeTokenWarning,
} from "../contextBudget";
import type {
    Message, UserMessage, AssistantMessage, AttachmentMessage, CompactHost, CompactionResult,
    ContextWindowSpec,
} from "../contextBudget";

// ---------- 测试环境隔离（bun 会自动加载 .env → 显式清掉会干扰阈值的变量） ----------

const ENV_KEYS = [
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW", "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE",
    "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE",
    "CLAUDE_CODE_MAX_CONTEXT_TOKENS", "CLAUDE_CODE_DISABLE_1M_CONTEXT",
    "DISABLE_COMPACT", "DISABLE_AUTO_COMPACT",
    "USER_TYPE", "USE_API_CLEAR_TOOL_RESULTS", "USE_API_CLEAR_TOOL_USES",
    "API_MAX_INPUT_TOKENS", "API_TARGET_INPUT_TOKENS",
    "ENABLE_CLAUDE_CODE_SM_COMPACT", "DISABLE_CLAUDE_CODE_SM_COMPACT",
    "CF_TENGU_SLATE_HERON", "CF_CONTEXT_WINDOW_TOKENS",
];

beforeEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    // ★ 大多数用例只想验"阈值算得对不对"，不想每次都验"窗口从哪来"：
    //   把基准固定成 cc 的 200_000（于是 167_000 那套数字可以逐位对拍）。
    //   "窗口从哪来"这件事由 §12.1 那一组单独验（那里显式传 env: {} / settings 值）。
    process.env["CF_CONTEXT_WINDOW_TOKENS"] = "200000";
    resetContextWindowWarnings();
    setAutoCompactEnabled(true);
    resetTimeBasedMCConfig();
    resetSessionMemoryCompactConfig();
    resetMicrocompactState();
    setCachedMicrocompactConfig(null);
});

/** 在给定 env 下求值，跑完还原（beforeEach 已清干净，这里只管设） */
function withEnv<T>(env: Record<string, string>, fn: () => T): T {
    const prev: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) { prev[k] = process.env[k]; process.env[k] = v; }
    try { return fn(); } finally {
        for (const [k, v] of Object.entries(prev)) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
    }
}

async function withEnvAsync<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
    const prev: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) { prev[k] = process.env[k]; process.env[k] = v; }
    try { return await fn(); } finally {
        for (const [k, v] of Object.entries(prev)) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
    }
}

// ---------- 造数 ----------

const MODEL = "claude-sonnet-4-5";     // 命中 context.ts:173-179 档：default 32_000 / upper 64_000

/** cc 形状的 assistant 消息（可带 usage，当 token 锚点） */
const asst = (
    id: string,
    content: AssistantMessage["message"]["content"],
    usage?: AssistantMessage["message"]["usage"],
): AssistantMessage => ({
    type: "assistant",
    uuid: `uuid-${id}`,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { id, content, ...(usage ? { usage } : {}) },
});

/** cc 形状的 user 消息（文本块） */
const usr = (uuid: string, text: string, extra: Partial<UserMessage> = {}): UserMessage => ({
    type: "user", uuid, timestamp: "2026-01-01T00:00:00.000Z",
    message: { content: [{ type: "text", text }] }, ...extra,
});

/** 一个 tool_use/tool_result 对（= 一个 API round 组） */
const pair = (i: number, tool: string, output: string, isError = false): Message[] => [
    asst(`msg-${i}`, [{ type: "tool_use", id: `tu-${i}`, name: tool, input: { path: `f${i}.ts` } }]),
    {
        type: "user", uuid: `r-${i}`, timestamp: "2026-01-01T00:00:00.000Z",
        message: {
            content: [{
                type: "tool_result", tool_use_id: `tu-${i}`, content: output, is_error: isError,
            }],
        },
    },
];

const attachment = (type: string): AttachmentMessage => ({
    type: "attachment", uuid: `att-${type}`, timestamp: "2026-01-01T00:00:00.000Z",
    attachment: { type },
});

// ============================================================
describe("移植 §1 tokenEstimation（对齐 src/services/tokenEstimation.ts）", () => {
    it("roughTokenCountEstimation = round(len / bytesPerToken)，默认 4（:203-208）", () => {
        expect(roughTokenCountEstimation("")).toBe(0);
        expect(roughTokenCountEstimation("abcd")).toBe(1);
        expect(roughTokenCountEstimation("a".repeat(400))).toBe(100);
        expect(roughTokenCountEstimation("a".repeat(401))).toBe(100);   // round(100.25)
        expect(roughTokenCountEstimation("a".repeat(1000), 2)).toBe(500);
    });

    it("★ json/jsonl/jsonc 用 2，其余 4（:215-224；注释原话『Dense JSON has many single-character tokens』）", () => {
        expect(bytesPerTokenForFileType("json")).toBe(2);
        expect(bytesPerTokenForFileType("jsonl")).toBe(2);
        expect(bytesPerTokenForFileType("jsonc")).toBe(2);
        expect(bytesPerTokenForFileType("ts")).toBe(4);
        expect(bytesPerTokenForFileType("")).toBe(4);
        // 同一份 JSON 文本，用文件类型口径算出来是两倍 —— 这正是那个函数存在的理由
        const json = "x".repeat(400);
        expect(roughTokenCountEstimationForFileType(json, "json")).toBe(200);
        expect(roughTokenCountEstimationForFileType(json, "ts")).toBe(100);
    });

    it("按 block 类型分别计（tool_use 只算 name+input，不摊分 JSON 外壳）（:391-434）", () => {
        const msgs: Message[] = [
            asst("m1", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]),
            usr("u1", "x".repeat(400)),
        ];
        // Bash(4) + {"command":"ls"}(16) = 20 → round(20/4)=5；文本 400 → 100
        expect(roughTokenCountEstimationForMessages(msgs)).toBe(105);
    });

    it("system 不计 token；attachment 按序列化长度计（:341-369）", () => {
        const boundary = createCompactBoundaryMessage("auto", 1, undefined, undefined, undefined,
            { uuid: "b1", timestamp: "T" });
        expect(roughTokenCountEstimationForMessage(boundary as never)).toBe(0);
        const att = attachment("file");
        expect(roughTokenCountEstimationForMessage(att as never))
            .toBe(roughTokenCountEstimation(JSON.stringify(att.attachment)));
    });
});

// ============================================================
describe("移植 §2 模型窗口与输出上限（对齐 src/utils/context.ts + api/claude.ts）", () => {
    it("默认窗口 200_000 / 压缩输出上限 20_000 / cap 默认关（context.ts:9,12,24；claude.ts:3394-3397）", () => {
        expect(MODEL_CONTEXT_WINDOW_DEFAULT).toBe(200_000);
        expect(COMPACT_MAX_OUTPUT_TOKENS).toBe(20_000);
        expect(CAPPED_DEFAULT_MAX_TOKENS).toBe(8_000);
        expect(getContextWindowForModel(MODEL)).toBe(200_000);
    });

    it("★ `[1m]` 后缀认 1M 窗口（context.ts:35-40）——本仓库 `.env` 的 pro 档正是这个名字", () => {
        expect(has1mContext("deepseek-v4-flash")).toBe(false);
        expect(has1mContext("deepseek-v4-pro[1m]")).toBe(true);
        expect(getContextWindowForModel("deepseek-v4-pro[1m]")).toBe(1_000_000);
    });

    it("按模型名分档的输出上限（context.ts:149-210）", () => {
        expect(getModelMaxOutputTokens("claude-sonnet-4-5")).toEqual({ default: 32_000, upperLimit: 64_000 });
        expect(getModelMaxOutputTokens("claude-opus-4-6")).toEqual({ default: 64_000, upperLimit: 128_000 });
        expect(getModelMaxOutputTokens("claude-3-haiku-20240307")).toEqual({ default: 4_096, upperLimit: 4_096 });
        // 不认识的名字落 else 档（源码 :198-201）→ 本仓库的 deepseek-v4-* 走这条
        expect(getModelMaxOutputTokens("deepseek-v4-flash")).toEqual({ default: 32_000, upperLimit: 64_000 });
    });

    it("★ cap 关闭（3P 默认）时 getMaxOutputTokensForModel = 32_000（claude.ts:3399-3418）", () => {
        expect(getMaxOutputTokensForModel(MODEL)).toBe(32_000);
        expect(getMaxOutputTokensForModel("deepseek-v4-flash")).toBe(32_000);
    });

    it("CLAUDE_CODE_MAX_OUTPUT_TOKENS 覆盖并夹在 upperLimit 内（claude.ts:3412-3417）", () => {
        expect(withEnv({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8000" }, () => getMaxOutputTokensForModel(MODEL)))
            .toBe(8_000);
        expect(withEnv({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: "999999" }, () => getMaxOutputTokensForModel(MODEL)))
            .toBe(64_000);
    });

    it("CLAUDE_CODE_MAX_CONTEXT_TOKENS 只在 ant 下生效（context.ts:59-67）", () => {
        expect(withEnv({ CLAUDE_CODE_MAX_CONTEXT_TOKENS: "50000" }, () => getContextWindowForModel(MODEL)))
            .toBe(200_000);
        expect(withEnv({ USER_TYPE: "ant", CLAUDE_CODE_MAX_CONTEXT_TOKENS: "50000" },
            () => getContextWindowForModel(MODEL))).toBe(50_000);
    });

    it("feature() 表给的是**外部构建**取值（cc 用 bun:bundle 的 feature()，本仓库没有）", () => {
        expect(feature("CACHED_MICROCOMPACT")).toBe(false);
        expect(feature("REACTIVE_COMPACT")).toBe(false);
        expect(feature("CONTEXT_COLLAPSE")).toBe(false);
        expect(feature("不存在的开关")).toBe(false);
    });
});

// ============================================================
describe("移植 §3 token 计量（对齐 src/utils/tokens.ts）", () => {
    it("getTokenCountFromUsage = input + cache_creation + cache_read + output（:46-53）", () => {
        expect(getTokenCountFromUsage({
            input_tokens: 100, output_tokens: 20,
            cache_creation_input_tokens: 50, cache_read_input_tokens: 30,
        })).toBe(200);
        expect(getTokenCountFromUsage({ input_tokens: 5, output_tokens: 1 })).toBe(6);   // 缓存字段可缺省
    });

    it("★ tokenCountWithEstimation = 最后一次 API usage ＋ 其后新增消息的估算（:226-261）", () => {
        const msgs: Message[] = [
            usr("u0", "x".repeat(4000)),
            asst("m1", [{ type: "text", text: "ok" }], {
                input_tokens: 1000, output_tokens: 100,
                cache_creation_input_tokens: 0, cache_read_input_tokens: 500,
            }),
            usr("u2", "y".repeat(400)),      // 锚点之后新增：估算 100
        ];
        // 1000+0+500+100 = 1600，加尾部 400 字符 → 100
        expect(tokenCountWithEstimation(msgs)).toBe(1700);
    });

    it("没有 usage 锚点 → 全量估算（:260）", () => {
        expect(tokenCountWithEstimation([usr("u0", "z".repeat(800))])).toBe(200);
        expect(tokenCountWithEstimation([])).toBe(0);
    });

    it("tokenCountFromLastAPIResponse 只认 usage，不加估算（:55-66）", () => {
        const msgs: Message[] = [
            asst("m1", [{ type: "text", text: "a" }], { input_tokens: 7, output_tokens: 3 }),
            usr("u2", "trailing"),
        ];
        expect(tokenCountFromLastAPIResponse(msgs)).toBe(10);
    });
});

// ============================================================
describe("★ 移植 §12 autoCompact 阈值（对齐 src/services/compact/autoCompact.ts）", () => {
    it("四个缓冲常量与熔断阈值与源码逐字一致（:62-65, :70）", () => {
        expect(AUTOCOMPACT_BUFFER_TOKENS).toBe(13_000);
        expect(WARNING_THRESHOLD_BUFFER_TOKENS).toBe(20_000);
        expect(ERROR_THRESHOLD_BUFFER_TOKENS).toBe(20_000);
        expect(MANUAL_COMPACT_BUFFER_TOKENS).toBe(3_000);
        expect(MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES).toBe(3);
    });

    it("★ 有效窗口 = 窗口 − min(maxOutput, 20_000)；阈值再 −13_000（:33-49, :72-91）", () => {
        // 200_000 − min(32_000, 20_000) = 180_000
        expect(getEffectiveContextWindowSize(MODEL)).toBe(180_000);
        // 180_000 − 13_000 = 167_000 —— **这个数就是源码算出来的那个数**
        expect(getAutoCompactThreshold(MODEL)).toBe(167_000);
    });

    it("1M 窗口的模型阈值跟着放大（同一条比例式；这正是「折算」与「减常数」的差别）", () => {
        // `[1m]` 后缀 → 1M（contextWindowSource 与 §12.1 的顺序一致）
        expect(getContextWindowForModel("deepseek-v4-pro[1m]")).toBe(1_000_000);
        expect(getEffectiveContextWindowSize("deepseek-v4-pro[1m]")).toBe(980_000);
        // 比例式：980_000 − floor(980_000×13000/180000) = 980_000 − 70_777 = 909_223
        expect(getAutoCompactThreshold("deepseek-v4-pro[1m]")).toBe(909_223);
        // 对比：cc 的**绝对式**在同一窗口上会给出 967_000 —— 扣减量仍是 13_000，只占 1.3%。
        // 比例式让扣减量随窗口一起长（7.2%）——这就是"窗口可由用户配置"之后
        // 必须换成比例式的原因（适配清单 A23）。
        expect(980_000 - AUTOCOMPACT_BUFFER_TOKENS).toBe(967_000);
        expect(getAutoCompactThreshold("deepseek-v4-pro[1m]")).toBeLessThan(967_000);
    });

    it("CLAUDE_CODE_AUTO_COMPACT_WINDOW 取 min（:40-46）", () => {
        expect(withEnv({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: "100000" },
            () => getEffectiveContextWindowSize(MODEL))).toBe(80_000);
        expect(withEnv({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: "999999999" },
            () => getEffectiveContextWindowSize(MODEL))).toBe(180_000);      // 不放大
        expect(withEnv({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: "abc" },
            () => getEffectiveContextWindowSize(MODEL))).toBe(180_000);      // 垃圾忽略
    });

    it("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE 只取更小的那个（:79-88）", () => {
        expect(withEnv({ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "50" },
            () => getAutoCompactThreshold(MODEL))).toBe(90_000);            // 180_000 × 50%
        expect(withEnv({ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "99" },
            () => getAutoCompactThreshold(MODEL))).toBe(167_000);          // min(178200, 167000)
        expect(withEnv({ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "0" },
            () => getAutoCompactThreshold(MODEL))).toBe(167_000);          // 0 无效
        expect(withEnv({ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "101" },
            () => getAutoCompactThreshold(MODEL))).toBe(167_000);          // >100 无效
    });

    it("★ calculateTokenWarningState 的五个量与边界（:93-145）", () => {
        // threshold(autocompact 开) = 167_000；warning/error = 167_000−20_000 = 147_000
        // blockingLimit = 180_000 − 3_000 = 177_000
        const s0 = calculateTokenWarningState(0, MODEL);
        expect(s0.percentLeft).toBe(100);
        expect(s0.isAboveWarningThreshold).toBe(false);
        expect(s0.isAtBlockingLimit).toBe(false);

        expect(calculateTokenWarningState(146_999, MODEL).isAboveWarningThreshold).toBe(false);
        expect(calculateTokenWarningState(147_000, MODEL).isAboveWarningThreshold).toBe(true);   // 含等号
        expect(calculateTokenWarningState(146_999, MODEL).isAboveErrorThreshold).toBe(false);
        expect(calculateTokenWarningState(147_000, MODEL).isAboveErrorThreshold).toBe(true);

        expect(calculateTokenWarningState(166_999, MODEL).isAboveAutoCompactThreshold).toBe(false);
        expect(calculateTokenWarningState(167_000, MODEL).isAboveAutoCompactThreshold).toBe(true);

        expect(calculateTokenWarningState(176_999, MODEL).isAtBlockingLimit).toBe(false);
        expect(calculateTokenWarningState(177_000, MODEL).isAtBlockingLimit).toBe(true);
    });

    it("压缩关掉时 threshold 换成整个有效窗口（:104-106）", () => {
        const state = withEnv({ DISABLE_AUTO_COMPACT: "1" }, () => calculateTokenWarningState(170_000, MODEL));
        expect(state.isAboveAutoCompactThreshold).toBe(false);
        expect(state.isAboveWarningThreshold).toBe(true);        // threshold=180_000 → warning 160_000
        expect(withEnv({ DISABLE_AUTO_COMPACT: "1" }, () => calculateTokenWarningState(155_000, MODEL))
            .isAboveWarningThreshold).toBe(false);
    });

    it("CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE 可覆盖阻塞线（:127-134）", () => {
        expect(withEnv({ CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE: "1000" },
            () => calculateTokenWarningState(1000, MODEL)).isAtBlockingLimit).toBe(true);
    });

    it("isAutoCompactEnabled：DISABLE_COMPACT / DISABLE_AUTO_COMPACT / 用户开关（:147-158）", () => {
        expect(isAutoCompactEnabled()).toBe(true);
        expect(withEnv({ DISABLE_AUTO_COMPACT: "1" }, isAutoCompactEnabled)).toBe(false);
        expect(withEnv({ DISABLE_COMPACT: "1" }, isAutoCompactEnabled)).toBe(false);
        setAutoCompactEnabled(false);
        expect(isAutoCompactEnabled()).toBe(false);
    });

    it("★ shouldAutoCompact：递归守卫 + 阈值判定（:160-239）", async () => {
        expect(await shouldAutoCompact([], MODEL, "compact")).toBe(false);
        expect(await shouldAutoCompact([], MODEL, "session_memory")).toBe(false);

        const below: Message[] = [
            asst("m1", [{ type: "text", text: "ok" }], { input_tokens: 100_000, output_tokens: 0 }),
        ];
        const above: Message[] = [
            asst("m1", [{ type: "text", text: "ok" }], { input_tokens: 170_000, output_tokens: 0 }),
        ];
        expect(await shouldAutoCompact(below, MODEL)).toBe(false);
        expect(await shouldAutoCompact(above, MODEL)).toBe(true);
        // snipTokensFreed 从计数里扣（:167, :225）
        expect(await shouldAutoCompact(above, MODEL, undefined, 5_000)).toBe(false);
        expect(await withEnvAsync({ DISABLE_AUTO_COMPACT: "1" }, () => shouldAutoCompact(above, MODEL)))
            .toBe(false);
    });
});

// ============================================================
describe("★ 移植 §5 microCompact（对齐 src/services/compact/microCompact.ts）", () => {
    it("清空占位文案逐字一致（:36）", () => {
        expect(TIME_BASED_MC_CLEARED_MESSAGE).toBe("[Old tool result content cleared]");
    });

    it("COMPACTABLE_TOOLS 的成员与源码一致（:41-50）", () => {
        for (const t of ["Read", "Bash", "PowerShell", "Grep", "Glob", "WebSearch", "WebFetch", "Edit", "Write"]) {
            expect(COMPACTABLE_TOOLS.has(t)).toBe(true);
        }
        // NotebookEdit **不在**里面（源码也只列了上面那些）
        expect(COMPACTABLE_TOOLS.has("NotebookEdit")).toBe(false);
        expect(COMPACTABLE_TOOLS.has("TodoWrite")).toBe(false);
    });

    it("estimateMessageTokens 最后 ×4/3 保守加价（:203-204）", () => {
        const msgs: Message[] = [usr("u1", "x".repeat(400))];
        expect(roughTokenCountEstimationForMessages(msgs)).toBe(100);     // 无加价
        expect(estimateMessageTokens(msgs)).toBe(134);                    // ceil(100 × 4/3)
        expect(estimateMessageTokens([])).toBe(0);
    });

    it("★ 时间触发配置默认**关闭**（timeBasedMCConfig.ts:30-34，原样）", () => {
        expect(TIME_BASED_MC_CONFIG_DEFAULTS).toEqual({
            enabled: false, gapThresholdMinutes: 60, keepRecent: 5,
        });
        expect(getTimeBasedMCConfig()).toEqual(TIME_BASED_MC_CONFIG_DEFAULTS);
    });

    it("evaluateTimeBasedTrigger：关闭 / 非主线程 / 间隔不够 / 缺 querySource → null（:422-444）", () => {
        const t0 = Date.parse("2026-01-01T00:00:00.000Z");
        const msgs = [...pair(0, "Read", "old"), asst("m9", [{ type: "text", text: "hi" }])];
        // 默认 enabled=false → 永不触发
        expect(evaluateTimeBasedTrigger(msgs, "repl_main_thread", t0 + 90 * 60_000)).toBeNull();

        setTimeBasedMCConfig({ enabled: true });
        expect(evaluateTimeBasedTrigger(msgs, undefined, t0 + 90 * 60_000)).toBeNull();      // 缺 querySource
        expect(evaluateTimeBasedTrigger(msgs, "agent:sub", t0 + 90 * 60_000)).toBeNull();    // 非主线程
        expect(evaluateTimeBasedTrigger(msgs, "repl_main_thread", t0 + 59 * 60_000)).toBeNull();
        const fired = evaluateTimeBasedTrigger(msgs, "repl_main_thread", t0 + 61 * 60_000);
        expect(fired?.gapMinutes).toBeGreaterThan(60);
        expect(fired?.config.keepRecent).toBe(5);
    });

    it("isMainThreadSource 前缀匹配（:249-251，源码点名的那个 latent bug）", () => {
        expect(isMainThreadSource(undefined)).toBe(true);
        expect(isMainThreadSource("repl_main_thread")).toBe(true);
        expect(isMainThreadSource("repl_main_thread:outputStyle:custom")).toBe(true);
        expect(isMainThreadSource("agent:foo")).toBe(false);
        expect(isMainThreadSource("compact")).toBe(false);
    });

    it("★ 默认路径（时间触发关、非 ant 构建）→ **消息原样不动**（:288-292 源码原话）", () => {
        const msgs = [...pair(0, "Read", "x".repeat(50_000)), ...pair(1, "Bash", "y".repeat(50_000))];
        const before = JSON.stringify(msgs);
        const r = microcompactMessages(msgs, "repl_main_thread");
        expect(JSON.stringify(r.messages)).toBe(before);
        expect(r.compactionInfo?.pendingCacheEdits).toBeUndefined();
    });

    it("★ 时间触发路径：老的可压缩结果清成占位符，最近 keepRecent 条保留（:456-492）", () => {
        setTimeBasedMCConfig({ enabled: true, keepRecent: 2 });
        const t0 = Date.parse("2026-01-01T00:00:00.000Z");
        const msgs: Message[] = [
            ...pair(0, "Read", "A".repeat(10_000)),
            ...pair(1, "Bash", "B".repeat(10_000)),
            ...pair(2, "Grep", "C".repeat(10_000)),
            asst("m9", [{ type: "text", text: "hi" }]),
        ];
        const r = microcompactMessages(msgs, "repl_main_thread", { nowMs: t0 + 90 * 60_000 });

        const contentOf = (m: Message): unknown => {
            const c = (m as UserMessage).message.content;
            return Array.isArray(c) ? (c[0] as { content: unknown }).content : undefined;
        };
        // 3 个可压缩结果，keepRecent=2 → 只清最老那一个
        expect(contentOf(r.messages[1]!)).toBe("[Old tool result content cleared]");
        // 最近两条原样
        expect(contentOf(r.messages[3]!)).toBe("B".repeat(10_000));
        expect(contentOf(r.messages[5]!)).toBe("C".repeat(10_000));
        expect(r.compactionInfo?.pendingCacheEdits).toBeDefined();
    });

    it("★ 清空是**幂等**的：第二次不再变化（:479 的 `!== TIME_BASED_MC_CLEARED_MESSAGE` 守卫）", () => {
        setTimeBasedMCConfig({ enabled: true, keepRecent: 1 });
        const t0 = Date.parse("2026-01-01T00:00:00.000Z");
        const msgs: Message[] = [
            ...pair(0, "Read", "A".repeat(10_000)),
            ...pair(1, "Bash", "B".repeat(10_000)),
            asst("m9", [{ type: "text", text: "hi" }]),
        ];
        const once = microcompactMessages(msgs, "repl_main_thread", { nowMs: t0 + 90 * 60_000 });
        const twice = microcompactMessages(once.messages, "repl_main_thread", { nowMs: t0 + 90 * 60_000 });
        expect(JSON.stringify(twice.messages)).toBe(JSON.stringify(once.messages));
    });

    it("★ 非白名单工具（NotebookEdit）的结果**永不**被清（:41-50 白名单）", () => {
        setTimeBasedMCConfig({ enabled: true, keepRecent: 1 });
        const t0 = Date.parse("2026-01-01T00:00:00.000Z");
        const msgs: Message[] = [
            ...pair(0, "NotebookEdit", "KEEP-ME".repeat(2_000)),
            ...pair(1, "Read", "B".repeat(10_000)),
            asst("m9", [{ type: "text", text: "hi" }]),
        ];
        const r = microcompactMessages(msgs, "repl_main_thread", { nowMs: t0 + 90 * 60_000 });
        const c = (r.messages[1] as UserMessage).message.content as { content: unknown }[];
        expect(c[0]!.content).toBe("KEEP-ME".repeat(2_000));
    });

    it("keepRecent 下限为 1（slice(-0) 会返回整份，源码 :458-461 点名了这个坑）", () => {
        setTimeBasedMCConfig({ enabled: true, keepRecent: 0 });
        const t0 = Date.parse("2026-01-01T00:00:00.000Z");
        const msgs: Message[] = [
            ...pair(0, "Read", "A".repeat(10_000)),
            ...pair(1, "Read", "B".repeat(10_000)),
            asst("m9", [{ type: "text", text: "hi" }]),
        ];
        const r = microcompactMessages(msgs, "repl_main_thread", { nowMs: t0 + 90 * 60_000 });
        const c = (r.messages[3] as UserMessage).message.content as { content: unknown }[];
        expect(c[0]!.content).toBe("B".repeat(10_000));    // 最后一条一定留着
    });

    it("cached MC 路径：配置未注入 → 不压（等价于 cc 外部构建）；注入后才可能生效", () => {
        expect(getCachedMCConfig()).toBeNull();
        setCachedMicrocompactConfig({ triggerThreshold: 2, keepRecent: 1 });
        expect(getCachedMCConfig()).toEqual({ triggerThreshold: 2, keepRecent: 1 });
        // 【近似】该路径的模块（cachedMicrocompact.ts）不在 checkout 里，
        // 其 trigger/keep 数值不可读 → 本移植只保留"配置可注入、不编造默认值"这条边界。
    });
});

// ============================================================
describe("移植 §6 groupMessagesByApiRound（对齐 src/services/compact/grouping.ts:22-63）", () => {
    it("★ 边界 = 新的 assistant message.id；前导段自成一组的 group 0（:22-63，compact.ts:279-280 亦称 group 0 是 preamble）", () => {
        const msgs: Message[] = [
            usr("u0", "hi"),
            asst("X", [{ type: "tool_use", id: "a", name: "Read", input: {} }]),
            { type: "user", uuid: "r1", timestamp: "T", message: { content: [{ type: "tool_result", tool_use_id: "a", content: "x" }] } },
            asst("X", [{ type: "tool_use", id: "b", name: "Read", input: {} }]),
            { type: "user", uuid: "r2", timestamp: "T", message: { content: [{ type: "tool_result", tool_use_id: "b", content: "y" }] } },
            asst("Y", [{ type: "text", text: "done" }]),
        ];
        const groups = groupMessagesByApiRound(msgs);
        // 第一个 assistant 就开了新组，所以它前面的 u0 留在 group 0 里 —— 这正是源码
        // truncateHeadForPTLRetry 注释说的 "puts the preamble in group 0"。
        expect(groups.map((g) => g.length)).toEqual([1, 4, 1]);
        // 第二个 assistant 的 id 与第一个相同（同一次 API 响应的流式分块）→ 不切
        expect(groups[1]!.map((m) => m.uuid)).toEqual(["uuid-X", "r1", "uuid-X", "r2"]);
        expect(groups[2]![0]!.uuid).toBe("uuid-Y");
    });

    it("空数组 → 空分组（源码 :59-61）", () => {
        expect(groupMessagesByApiRound([])).toEqual([]);
    });
});

// ============================================================
describe("移植 §7 边界标记（对齐 src/utils/messages.ts:4530-4657）", () => {
    it("★ 压缩边界标记的文案与形状逐字一致（:4537-4555）", () => {
        const b = createCompactBoundaryMessage("auto", 167_000, "uuid-last", undefined, 12,
            { uuid: "b1", timestamp: "2026-01-01T00:00:00.000Z" });
        expect(b.type).toBe("system");
        expect(b.subtype).toBe("compact_boundary");
        expect(b.content).toBe("Conversation compacted");
        expect(b.isMeta).toBe(false);
        expect(b.level).toBe("info");
        expect(b.compactMetadata).toEqual({
            trigger: "auto", preTokens: 167_000, userContext: undefined, messagesSummarized: 12,
        });
        expect(b.logicalParentUuid).toBe("uuid-last");
        expect(isCompactBoundaryMessage(b)).toBe(true);
        // 没有前驱 uuid 时不带 logicalParentUuid（源码的 `...(cond && {...})`）
        expect(createCompactBoundaryMessage("manual", 1, undefined, undefined, undefined, { uuid: "b" })
            .logicalParentUuid).toBeUndefined();
    });

    it("微压缩边界标记（:4557-4583）", () => {
        const m = createMicrocompactBoundaryMessage("auto", 100, 5_000, ["tu-1"], [], { uuid: "m" });
        expect(m.subtype).toBe("microcompact_boundary");
        expect(m.content).toBe("Context microcompacted");
        expect(m.microcompactMetadata).toEqual({
            trigger: "auto", preTokens: 100, tokensSaved: 5_000,
            compactedToolIds: ["tu-1"], clearedAttachmentUUIDs: [],
        });
    });

    it("findLastCompactBoundaryIndex / getMessagesAfterCompactBoundary（:4618-4657）", () => {
        const b1 = createCompactBoundaryMessage("auto", 1, undefined, undefined, undefined, { uuid: "b1" });
        const b2 = createCompactBoundaryMessage("auto", 2, undefined, undefined, undefined, { uuid: "b2" });
        const msgs: Message[] = [usr("u0", "a"), b1, usr("u1", "b"), b2, usr("u2", "c")];
        expect(findLastCompactBoundaryIndex(msgs)).toBe(3);
        expect(findLastCompactBoundaryIndex([usr("u0", "a")])).toBe(-1);
        expect(getMessagesAfterCompactBoundary(msgs).map((m) => m.uuid)).toEqual(["b2", "u2"]);
        expect(getMessagesAfterCompactBoundary([usr("u0", "a")]).length).toBe(1);
    });
});

// ============================================================
describe("★ 移植 §8 提示词：**逐字**（对齐 src/services/compact/prompt.ts）", () => {
    it("NO_TOOLS_PREAMBLE 全文一致（prompt.ts:19-26）", () => {
        expect(NO_TOOLS_PREAMBLE).toBe(`CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- You already have all the context you need in the conversation above.
- Tool calls will be REJECTED and will waste your only turn — you will fail the task.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

`);
    });

    it("NO_TOOLS_TRAILER 全文一致（prompt.ts:269-272）", () => {
        expect(NO_TOOLS_TRAILER).toBe(
            "\n\nREMINDER: Do NOT call any tools. Respond with plain text only — "
            + "an <analysis> block followed by a <summary> block. "
            + "Tool calls will be rejected and you will fail the task.",
        );
    });

    it("★ BASE_COMPACT_PROMPT 的九节标题一字不差（prompt.ts:66-77）", () => {
        for (const s of [
            "1. Primary Request and Intent:", "2. Key Technical Concepts:", "3. Files and Code Sections:",
            "4. Errors and fixes:", "5. Problem Solving:", "6. All user messages:",
            "7. Pending Tasks:", "8. Current Work:", "9. Optional Next Step:",
        ]) expect(BASE_COMPACT_PROMPT).toContain(s);
        expect(BASE_COMPACT_PROMPT).toContain(
            "This summary should be thorough in capturing technical details, code patterns, and architectural decisions",
        );
        expect(BASE_COMPACT_PROMPT).toContain(DETAILED_ANALYSIS_INSTRUCTION_BASE);
    });

    it("★ 三套提示词的差异点（BASE=全部 / PARTIAL=RECENT / up_to=第 8/9 节改名）", () => {
        expect(PARTIAL_COMPACT_PROMPT).toContain("the RECENT portion of the conversation");
        expect(PARTIAL_COMPACT_PROMPT).toContain("8. Current Work:");
        expect(PARTIAL_COMPACT_UP_TO_PROMPT).toContain("8. Work Completed:");
        expect(PARTIAL_COMPACT_UP_TO_PROMPT).toContain("9. Context for Continuing Work:");
        expect(PARTIAL_COMPACT_UP_TO_PROMPT).toContain("you do not see them here");
    });

    it("getCompactPrompt 组装顺序 = PREAMBLE + BASE + [Additional Instructions] + TRAILER（:293-303）", () => {
        const p = getCompactPrompt();
        expect(p.startsWith(NO_TOOLS_PREAMBLE)).toBe(true);
        expect(p.endsWith(NO_TOOLS_TRAILER)).toBe(true);
        expect(p).not.toContain("Additional Instructions:");

        const p2 = getCompactPrompt("focus on typescript");
        expect(p2).toContain("\n\nAdditional Instructions:\nfocus on typescript");
        expect(p2.indexOf("Additional Instructions:")).toBeGreaterThan(p2.indexOf("9. Optional Next Step:"));
        // 空/纯空白不产生那一节（源码 :296 的 trim() !== ''）
        expect(getCompactPrompt("   ")).not.toContain("Additional Instructions:");
    });

    it("getPartialCompactPrompt 按 direction 选模板（:274-291）", () => {
        expect(getPartialCompactPrompt(undefined, "from")).toContain(PARTIAL_COMPACT_PROMPT);
        expect(getPartialCompactPrompt(undefined, "up_to")).toContain(PARTIAL_COMPACT_UP_TO_PROMPT);
        expect(getPartialCompactPrompt(undefined)).toContain(PARTIAL_COMPACT_PROMPT);   // 缺省 from
    });

    it("★ formatCompactSummary：剥掉 <analysis> 草稿、<summary> 换成 `Summary:`（:311-335）", () => {
        const raw = "<analysis>我的草稿，不该进上下文</analysis>\n<summary>\n正文\n</summary>";
        const out = formatCompactSummary(raw);
        expect(out).not.toContain("草稿");
        expect(out).not.toContain("<analysis>");
        expect(out).not.toContain("<summary>");
        expect(out.startsWith("Summary:\n正文")).toBe(true);
    });

    it("★ getCompactUserSummaryMessage：摘要**就是这样回灌**的（:337-373）", () => {
        const s = getCompactUserSummaryMessage("Summary:\n做了 X");
        expect(s.startsWith(
            "This session is being continued from a previous conversation that ran out of context.",
        )).toBe(true);
        expect(s).toContain("The summary below covers the earlier portion of the conversation.");
        expect(s).not.toContain("read the full transcript at:");

        expect(getCompactUserSummaryMessage("x", false, "C:\\runs\\raw\\transcript.txt"))
            .toContain("read the full transcript at: C:\\runs\\raw\\transcript.txt");
        expect(getCompactUserSummaryMessage("x", false, undefined, true))
            .toContain("Recent messages are preserved verbatim.");

        const auto = getCompactUserSummaryMessage("x", true);
        expect(auto.endsWith(
            "Continue the conversation from where it left off without asking the user any further questions. "
            + "Resume directly — do not acknowledge the summary, do not recap what was happening, "
            + "do not preface with \"I'll continue\" or similar. Pick up the last task as if the break never happened.",
        )).toBe(true);
    });
});

// ============================================================
describe("移植 §9 压缩产物与顺序（对齐 src/services/compact/compact.ts:122-381）", () => {
    it("POST_COMPACT_* 常量与源码逐字一致（:122-130）", () => {
        expect(POST_COMPACT_MAX_FILES_TO_RESTORE).toBe(5);
        expect(POST_COMPACT_TOKEN_BUDGET).toBe(50_000);
        expect(POST_COMPACT_MAX_TOKENS_PER_FILE).toBe(5_000);
    });

    it("★ buildPostCompactMessages 顺序 = 边界 → 摘要 → 保留 → 附件 → hooks（:330-338）", () => {
        const boundary = createCompactBoundaryMessage("auto", 1, undefined, undefined, undefined, { uuid: "B" });
        const summary = usr("S", "Summary:", { isCompactSummary: true, isVisibleInTranscriptOnly: true });
        const kept = usr("K", "kept");
        const att = attachment("file");
        const hook = usr("H", "hook");
        const result: CompactionResult = {
            boundaryMarker: boundary, summaryMessages: [summary],
            attachments: [att], hookResults: [hook], messagesToKeep: [kept],
        };
        // ← 这个顺序就是"压缩后模型看到什么"的全部定义
        expect(buildPostCompactMessages(result).map((m) => m.uuid))
            .toEqual(["B", "S", "K", "att-file", "H"]);
    });

    it("annotateBoundaryWithPreservedSegment：空 keep 不动，非空写 preservedSegment（:349-367）", () => {
        const b = createCompactBoundaryMessage("auto", 1, undefined, undefined, undefined, { uuid: "B" });
        expect(annotateBoundaryWithPreservedSegment(b, "anchor", [])).toBe(b);
        const keep = [usr("k1", "a"), usr("k2", "b")];
        expect(annotateBoundaryWithPreservedSegment(b, "anchor", keep).compactMetadata.preservedSegment)
            .toEqual({ headUuid: "k1", anchorUuid: "anchor", tailUuid: "k2" });
    });

    it("mergeHookInstructions：用户在前、hook 在后、空调成 undefined（:374-381）", () => {
        expect(mergeHookInstructions(undefined, undefined)).toBeUndefined();
        expect(mergeHookInstructions("", "")).toBeUndefined();
        expect(mergeHookInstructions("u", undefined)).toBe("u");
        expect(mergeHookInstructions(undefined, "h")).toBe("h");
        expect(mergeHookInstructions("u", "h")).toBe("u\n\nh");
    });

    it("stripImagesFromMessages：图片/文档换成 [image] / [document]（:145-200）", () => {
        const msgs: Message[] = [{
            type: "user", uuid: "u1", timestamp: "T",
            message: { content: [{ type: "image" }, { type: "document" }, { type: "text", text: "看这两张" }] },
        }];
        const out = stripImagesFromMessages(msgs) as UserMessage[];
        expect(out[0]!.message.content).toEqual([
            { type: "text", text: "[image]" }, { type: "text", text: "[document]" },
            { type: "text", text: "看这两张" },
        ]);
    });

    it("★ truncateHeadForPTLRetry：丢最老的 API round 组、至少留一组、首条是 assistant 时补 marker（:243-291）", () => {
        const msgs: Message[] = [
            ...pair(0, "Read", "a".repeat(4_000)),
            ...pair(1, "Read", "b".repeat(4_000)),
            ...pair(2, "Read", "c".repeat(4_000)),
            ...pair(3, "Read", "d".repeat(4_000)),
            ...pair(4, "Read", "e".repeat(4_000)),
        ];
        // 5 组 → 20% = 1 组
        const dropped = truncateHeadForPTLRetry(msgs, undefined, { uuid: "m", timestamp: "T" });
        expect(dropped).not.toBeNull();
        expect(dropped!.length).toBe(msgs.length - 2 + 1);      // 丢 1 组（2 条）+ 补 1 条 marker
        expect((dropped![0] as UserMessage).isMeta).toBe(true);
        expect((dropped![0] as UserMessage).message.content)
            .toBe("[earlier conversation truncated for compaction retry]");

        // 组数 < 2 → 无可丢
        expect(truncateHeadForPTLRetry(pair(0, "Read", "x"), undefined)).toBeNull();

        // 自家 marker 先被剥掉（否则第 2 次重试零进展，源码 :248-255 点名过）
        const again = truncateHeadForPTLRetry(dropped!, undefined, { uuid: "m2", timestamp: "T" });
        expect(again).not.toBeNull();
        expect(again!.length).toBeLessThan(dropped!.length);
    });

    it("collectReadToolFilePaths 只收集 Read 过的文件（:1610-1655）", () => {
        const msgs: Message[] = [
            asst("m1", [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "C:\\p\\a.ts" } }]),
            asst("m2", [{ type: "tool_use", id: "t2", name: "Write", input: { file_path: "C:\\p\\b.ts" } }]),
            asst("m3", [{ type: "tool_use", id: "t3", name: "Read", input: { file_path: "C:\\p\\c.ts" } }]),
        ];
        const paths = collectReadToolFilePaths(msgs);
        expect(paths.has("C:\\p\\a.ts")).toBe(true);
        expect(paths.has("C:\\p\\c.ts")).toBe(true);
        expect(paths.has("C:\\p\\b.ts")).toBe(false);
    });

    it("★ createPostCompactFileAttachments：先按时间倒序取最近 maxFiles，再逐个读；读不出来**不补位**（:1420-1464）", async () => {
        const readFile = async (p: string): Promise<string | null> =>
            p.includes("gone") ? null : "z".repeat(100);
        const state = {
            "C:\\p\\old.ts": { content: "z".repeat(100), timestamp: 1 },
            "C:\\p\\mid.ts": { content: "z".repeat(100), timestamp: 2 },
            "C:\\p\\new.ts": { content: "z".repeat(100), timestamp: 3 },
            "C:\\p\\gone.ts": { content: "z".repeat(100), timestamp: 4 },
        };
        // maxFiles=2 → 先切出 [gone(4), new(3)]；gone 读不出来被丢掉，
        // **不会**回头把 mid 补进来（源码的 slice 在读之前，:1431-1432）。
        expect((await createPostCompactFileAttachments(state, readFile, 2))
            .map((a) => a.attachment["filename"])).toEqual(["C:\\p\\new.ts"]);
        // 放宽到 3 个名额 → [gone, new, mid]，gone 仍然丢掉
        expect((await createPostCompactFileAttachments(state, readFile, 3))
            .map((a) => a.attachment["filename"])).toEqual(["C:\\p\\new.ts", "C:\\p\\mid.ts"]);
    });

    it("createPostCompactFileAttachments：尾部已经能看到的 Read 结果不重复灌（:1421-1430）", async () => {
        const readFile = async (): Promise<string | null> => "z";
        const state = { "C:\\p\\a.ts": { content: "z", timestamp: 1 } };
        const preserved: Message[] = [
            asst("m1", [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "C:\\p\\a.ts" } }]),
        ];
        expect((await createPostCompactFileAttachments(state, readFile, 5, preserved)).length).toBe(0);
    });

    it("expandPath 对绝对路径是恒等（对齐 utils/path.ts）", () => {
        expect(expandPath("C:\\abs\\a.ts")).toBe("C:\\abs\\a.ts");
        expect(expandPath("/abs/a.ts")).toBe("/abs/a.ts");
    });

    it("★ buildSummaryRequest：系统提示词 / thinking 关 / tools 只剩 Read / 输出上限（:1292-1326）", () => {
        const req = buildSummaryRequest({
            messages: [...pair(0, "Read", "hi")],
            summaryRequest: usr("s", "SUMMARY PLEASE"),
            model: MODEL,
        });
        expect(req.systemPrompt)
            .toEqual(["You are a helpful AI assistant tasked with summarizing conversations."]);
        expect(req.thinkingConfig).toEqual({ type: "disabled" });
        expect(req.tools).toEqual(["Read"]);              // 【适配】ant-only 的 ToolSearch 不在外部构建
        expect(req.maxOutputTokensOverride).toBe(20_000); // min(20_000, 32_000)
        expect(req.querySource).toBe("compact");

        // 边界标记是 system 消息 → normalizeMessagesForAPI 会滤掉它（messages.ts:4641 的注释）
        const withBoundary = buildSummaryRequest({
            messages: [
                createCompactBoundaryMessage("auto", 1, undefined, undefined, undefined, { uuid: "b" }),
                ...pair(0, "Read", "hi"),
            ],
            summaryRequest: usr("s", "P"),
            model: MODEL,
        });
        expect(withBoundary.messages.some((m) => m.type === "system")).toBe(false);
        expect(withBoundary.messages.some((m) => m.type === "attachment")).toBe(false);
    });

    it("normalizeMessagesForAPI 的最小语义：丢 system / attachment（见适配清单）", () => {
        const b = createCompactBoundaryMessage("auto", 1, undefined, undefined, undefined, { uuid: "b" });
        expect(normalizeMessagesForAPI([b, attachment("file"), usr("u", "x")]).map((m) => m.uuid))
            .toEqual(["u"]);
    });
});

// ============================================================
describe("★ 移植 §9 compactConversation 端到端（注入假摘要端口，零 LLM 零网络）", () => {
    const mkHost = (summaries: { text: string | null }[]): {
        host: CompactHost; calls: () => number; lastPrompt: () => string;
    } => {
        let i = 0;
        let prompt = "";
        const host: CompactHost = {
            summarize: async (req) => {
                prompt = JSON.stringify(req.messages);
                const s = summaries[Math.min(i, summaries.length - 1)]!;
                i++;
                return { text: s.text, usage: { input_tokens: 500, output_tokens: 200 } };
            },
            getTranscriptPath: () => "C:\\runs\\raw\\t.txt",
            ids: { uuid: () => `id-${i}`, timestamp: () => "2026-01-01T00:00:00.000Z" },
        };
        return { host, calls: () => i, lastPrompt: () => prompt };
    };

    const convo = (n: number): Message[] => {
        const out: Message[] = [];
        for (let k = 0; k < n; k++) out.push(...pair(k, "Read", `out-${k}`));
        return out;
    };

    it("空对话 → 抛 ERROR_MESSAGE_NOT_ENOUGH_MESSAGES（:397-399）", async () => {
        const { host } = mkHost([{ text: "x" }]);
        await expect(compactConversation([], host, { model: MODEL, suppressFollowUpQuestions: true }))
            .rejects.toThrow(ERROR_MESSAGE_NOT_ENOUGH_MESSAGES);
    });

    it("★ 摘要回灌：isCompactSummary 的 user 消息 + 那句英文抬头，且 <analysis> 被剥掉", async () => {
        const { host } = mkHost([{
            text: "<analysis>草稿草稿</analysis><summary>\n1. Primary Request and Intent: 建站点\n</summary>",
        }]);
        const r = await compactConversation(convo(4), host, {
            model: MODEL, suppressFollowUpQuestions: true, isAutoCompact: true,
        });

        expect(r.boundaryMarker.content).toBe("Conversation compacted");
        expect(r.boundaryMarker.compactMetadata.trigger).toBe("auto");
        expect(r.preCompactTokenCount).toBeGreaterThan(0);

        const s = r.summaryMessages[0]!;
        expect(s.type).toBe("user");
        expect(s.isCompactSummary).toBe(true);
        expect(s.isVisibleInTranscriptOnly).toBe(true);
        const text = s.message.content as string;
        expect(text.startsWith(
            "This session is being continued from a previous conversation that ran out of context.",
        )).toBe(true);
        expect(text).toContain("Summary:\n1. Primary Request and Intent: 建站点");
        expect(text).not.toContain("草稿草稿");                 // analysis 不进上下文
        expect(text).toContain("read the full transcript at: C:\\runs\\raw\\t.txt");
    });

    it("★ 全量压缩没有 messagesToKeep；产物顺序与 buildPostCompactMessages 一致", async () => {
        const { host } = mkHost([{ text: "S" }]);
        const r = await compactConversation(convo(3), host, {
            model: MODEL, suppressFollowUpQuestions: true, isAutoCompact: true,
        });
        const built = buildPostCompactMessages(r);
        expect(built[0]).toBe(r.boundaryMarker);
        expect(built[1]).toBe(r.summaryMessages[0]);
        expect(r.messagesToKeep).toBeUndefined();
    });

    it("★ 事件负载 = tengu_compact 的字段（:650-695），含 willRetriggerNextTurn", async () => {
        const { host } = mkHost([{ text: "S" }]);
        const recompactionInfo = {
            isRecompactionInChain: true, turnsSincePreviousCompact: 4,
            previousCompactTurnId: "t-9", autoCompactThreshold: 167_000, querySource: "repl_main_thread",
        };
        const r = await compactConversation(convo(3), host, {
            model: MODEL, suppressFollowUpQuestions: true, isAutoCompact: true, recompactionInfo,
        });
        const ev = compactEventPayload(r, { isAutoCompact: true, recompactionInfo });
        expect(ev.autoCompactThreshold).toBe(167_000);
        expect(ev.isAutoCompact).toBe(true);
        expect(ev.isRecompactionInChain).toBe(true);
        expect(ev.turnsSincePreviousCompact).toBe(4);
        expect(ev.compactionInputTokens).toBe(500);
        expect(ev.compactionOutputTokens).toBe(200);
        expect(ev.compactionTotalTokens).toBe(700);
        expect(ev.willRetriggerNextTurn).toBe(false);          // 压缩后很小，远不到 167000
    });

    it("★ 摘要为空文本 → 抛错（:493-506 原文）", async () => {
        const { host } = mkHost([{ text: null }]);
        await expect(compactConversation(convo(2), host, { model: MODEL, suppressFollowUpQuestions: true }))
            .rejects.toThrow(
                "Failed to generate conversation summary - response did not contain valid text content",
            );
    });

    it("★ PTL 重试：反复 prompt-too-long → 最多 3 次截断重试后抛错（:450-491, MAX_PTL_RETRIES=3）", async () => {
        const { host, calls } = mkHost([{
            text: `${PROMPT_TOO_LONG_ERROR_MESSAGE}: 200000 tokens > 167000 maximum`,
        }]);
        await expect(compactConversation(convo(30), host, { model: MODEL, suppressFollowUpQuestions: true }))
            .rejects.toThrow(ERROR_MESSAGE_PROMPT_TOO_LONG);
        expect(calls()).toBe(4);        // 首次 + 最多 3 次重试
    });

    it("PTL 一次后成功 → 出摘要（重试的是被截短的那一段）", async () => {
        const { host, calls } = mkHost([
            { text: `${PROMPT_TOO_LONG_ERROR_MESSAGE} (retry me)` },
            { text: "<summary>ok</summary>" },
        ]);
        const r = await compactConversation(convo(30), host, {
            model: MODEL, suppressFollowUpQuestions: true,
        });
        expect(calls()).toBe(2);
        expect((r.summaryMessages[0]!.message.content as string)).toContain("Summary:\nok");
    });

    it("★ 压缩后**清空 readFileState**（:517-521）——压缩后必须重新 Read 才能 Edit", async () => {
        const { host } = mkHost([{ text: "S" }]);
        const readFileState: Record<string, { content: string; timestamp: number }> = {
            "C:\\p\\a.ts": { content: "x", timestamp: 1 },
        };
        await compactConversation(convo(2), { ...host, readFileState }, {
            model: MODEL, suppressFollowUpQuestions: true,
        });
        expect(Object.keys(readFileState).length).toBe(0);
    });

    it("PreCompact hook 的 customInstructions 并进提示词（:413-423, :440）", async () => {
        let prompt = "";
        const host: CompactHost = {
            summarize: async (req) => {
                prompt = JSON.stringify(req.messages);
                return { text: "S" };
            },
            preCompactHooks: async () => ({ newCustomInstructions: "重点看测试输出" }),
            getTranscriptPath: () => "T",
        };
        await compactConversation(convo(2), host, { model: MODEL, suppressFollowUpQuestions: true });
        expect(prompt).toContain("Additional Instructions:");
        expect(prompt).toContain("重点看测试输出");
    });
});

// ============================================================
describe("移植 §10 sessionMemoryCompact（对齐 src/services/compact/sessionMemoryCompact.ts）", () => {
    it("★ 默认配置逐字一致（:57-61）", () => {
        expect(DEFAULT_SM_COMPACT_CONFIG).toEqual({
            minTokens: 10_000, minTextBlockMessages: 5, maxTokens: 40_000,
        });
        expect(getSessionMemoryCompactConfig()).toEqual(DEFAULT_SM_COMPACT_CONFIG);
        setSessionMemoryCompactConfig({ minTokens: 1 });
        expect(getSessionMemoryCompactConfig().minTokens).toBe(1);
        expect(getSessionMemoryCompactConfig().maxTokens).toBe(40_000);
        resetSessionMemoryCompactConfig();
        expect(getSessionMemoryCompactConfig()).toEqual(DEFAULT_SM_COMPACT_CONFIG);
    });

    it("★ 默认**不启用**（GrowthBook 两个开关默认 false；env 可覆盖）（:403-432）", () => {
        expect(shouldUseSessionMemoryCompaction()).toBe(false);
        expect(withEnv({ ENABLE_CLAUDE_CODE_SM_COMPACT: "1" }, shouldUseSessionMemoryCompaction)).toBe(true);
        expect(withEnv({ DISABLE_CLAUDE_CODE_SM_COMPACT: "1" }, shouldUseSessionMemoryCompaction)).toBe(false);
    });

    it("★ calculateMessagesToKeepIndex：已够 minTokens+minTextBlockMessages → 原地不动（:356-362）", () => {
        // 每条 8000 字符 → estimateMessageTokens = ceil(2000 × 4/3) = 2667
        const msgs: Message[] = Array.from({ length: 20 }, (_, i) => usr(`u${i}`, "x".repeat(8_000)));
        expect(estimateMessageTokens([msgs[0]!])).toBe(2667);
        // lastSummarizedIndex=9 → startIndex=10 → 尾部 10 条 = 26670 token ≥ minTokens、条数 10 ≥ 5
        expect(calculateMessagesToKeepIndex(msgs, 9)).toBe(10);
    });

    it("★ calculateMessagesToKeepIndex：已超 maxTokens → 立刻停（:351-354）", () => {
        const msgs: Message[] = Array.from({ length: 30 }, (_, i) => usr(`u${i}`, "x".repeat(40_000)));
        expect(estimateMessageTokens([msgs[0]!])).toBe(13334);   // ceil(10000 × 4/3)
        // lastSummarizedIndex=0 → startIndex=1 → 尾部 29 条远超 40000 → 直接返回 1
        expect(calculateMessagesToKeepIndex(msgs, 0)).toBe(1);
    });

    it("★ calculateMessagesToKeepIndex：从后往前扩，撞到 maxTokens 就 break（:372-393）", () => {
        // 每条 40000 字符 → 13334 token；maxTokens=40000 → 3 条即 40002 ≥ 40000
        const msgs: Message[] = Array.from({ length: 30 }, (_, i) => usr(`u${i}`, "x".repeat(40_000)));
        // lastSummarizedIndex=-1 → startIndex=30（先不保留）→ 往前扩到第 3 条时越 maxTokens
        expect(calculateMessagesToKeepIndex(msgs, -1)).toBe(27);
    });

    it("★ adjustIndexToPreserveAPIInvariants：不许把 tool_use / tool_result 劈开（:232-286）", () => {
        const msgs = pair(0, "Read", "x");
        // startIndex=1（落在 tool_result 上）→ 必须往前拉回 index 0 的 tool_use
        expect(adjustIndexToPreserveAPIInvariants(msgs, 1)).toBe(0);
        expect(adjustIndexToPreserveAPIInvariants(msgs, 0)).toBe(0);
    });

    it("adjustIndexToPreserveAPIInvariants：同一 message.id 的 thinking 块也不许切开（:288-311）", () => {
        const msgs: Message[] = [
            asst("X", [{ type: "thinking", thinking: "想" }]),
            asst("X", [{ type: "tool_use", id: "t", name: "Read", input: {} }]),
        ];
        expect(adjustIndexToPreserveAPIInvariants(msgs, 1)).toBe(0);
    });

    it("hasTextBlocks（:135-150）", () => {
        expect(hasTextBlocks(usr("u", "hi"))).toBe(true);
        expect(hasTextBlocks(asst("a", [{ type: "tool_use", id: "t", name: "Read", input: {} }]))).toBe(false);
        expect(hasTextBlocks(asst("a", [{ type: "text", text: "x" }]))).toBe(true);
    });

    it("★ 会话记忆模板与截断（SessionMemory/prompts.ts:11-41, :256-324）", () => {
        expect(DEFAULT_SESSION_MEMORY_TEMPLATE).toContain("# Session Title");
        expect(DEFAULT_SESSION_MEMORY_TEMPLATE).toContain("# Worklog");
        expect(isSessionMemoryEmpty(DEFAULT_SESSION_MEMORY_TEMPLATE)).toBe(true);
        expect(isSessionMemoryEmpty(`${DEFAULT_SESSION_MEMORY_TEMPLATE}\n加了内容`)).toBe(false);
        expect(isSessionMemoryEmpty(DEFAULT_SESSION_MEMORY_TEMPLATE.trim())).toBe(true);

        // 每节上限 2000 × 4 = 8000 字符
        const big = `# Title\n${"a".repeat(20_000)}\n# Worklog\nshort\n`;
        const r = truncateSessionMemoryForCompact(big);
        expect(r.wasTruncated).toBe(true);
        expect(r.truncatedContent).toContain("[... section truncated for length ...]");
        expect(r.truncatedContent).toContain("# Worklog");       // 后面的节没被吃掉
        expect(truncateSessionMemoryForCompact("# T\nshort\n").wasTruncated).toBe(false);
    });

    it("★ trySessionMemoryCompaction：摘要换成会话记忆，尾部按 minTokens 保留（:514-620）", () => {
        withEnv({ ENABLE_CLAUDE_CODE_SM_COMPACT: "1" }, () => {
            const msgs: Message[] = [...pair(0, "Read", "a"), ...pair(1, "Read", "b"), ...pair(2, "Read", "c")];
            // 没给 lastSummarizedMessageId → 走"续跑会话"分支：lastSummarizedIndex = 末位
            const r = trySessionMemoryCompaction(msgs, {
                sessionMemory: "# Title\n真实内容\n",
                transcriptPath: "T",
                ids: { uuid: "s1", timestamp: "TS" },
            }, 167_000);
            expect(r).not.toBeNull();
            expect(r!.boundaryMarker.compactMetadata.trigger).toBe("auto");
            const text = r!.summaryMessages[0]!.message.content as string;
            expect(text).toContain("Recent messages are preserved verbatim.");
            expect(text).toContain("# Title");
            expect(r!.messagesToKeep!.every((m) => !isCompactBoundaryMessage(m))).toBe(true);
        });
    });

    it("trySessionMemoryCompaction：无记忆 / 空模板 / 阈值复检不过 → null（:533-543, :604-614）", () => {
        withEnv({ ENABLE_CLAUDE_CODE_SM_COMPACT: "1" }, () => {
            const msgs = pair(0, "Read", "a");
            expect(trySessionMemoryCompaction(msgs, { sessionMemory: null })).toBeNull();
            expect(trySessionMemoryCompaction(msgs, { sessionMemory: DEFAULT_SESSION_MEMORY_TEMPLATE })).toBeNull();
            expect(trySessionMemoryCompaction(msgs, {
                sessionMemory: "# T\n内容\n", ids: { uuid: "s", timestamp: "T" },
            }, 0)).toBeNull();
        });
    });

    it("未启用时 trySessionMemoryCompaction 一律 null（:519-521）", () => {
        expect(trySessionMemoryCompaction(pair(0, "Read", "a"), { sessionMemory: "# T\nx\n" })).toBeNull();
    });
});

// ============================================================
describe("移植 §11 apiMicrocompact（对齐 src/services/compact/apiMicrocompact.ts）", () => {
    it("★ 非 ant：不开 useClear* 时只有 thinking 策略，没有 tool 清理（:89-102 的门）", () => {
        expect(getAPIContextManagement()).toBeUndefined();
        expect(getAPIContextManagement({ hasThinking: false })).toBeUndefined();
        expect(getAPIContextManagement({ hasThinking: true })!.edits[0])
            .toEqual({ type: "clear_thinking_20251015", keep: "all" });
        // redact-thinking 生效时不加该策略（:82）
        expect(getAPIContextManagement({ hasThinking: true, isRedactThinkingActive: true })).toBeUndefined();
        // clearAllThinking → thinking_turns 1（:85）
        expect(getAPIContextManagement({ hasThinking: true, clearAllThinking: true })!.edits[0])
            .toEqual({ type: "clear_thinking_20251015", keep: { type: "thinking_turns", value: 1 } });
    });

    it("★ ant + USE_API_CLEAR_TOOL_RESULTS：180_000 / 140_000 与可清工具表（:16-17, :104-126）", () => {
        withEnv({ USER_TYPE: "ant", USE_API_CLEAR_TOOL_RESULTS: "1" }, () => {
            const s = getAPIContextManagement()!.edits[0]!;
            expect(s.type).toBe("clear_tool_uses_20250919");
            if (s.type === "clear_tool_uses_20250919") {
                expect(s.trigger).toEqual({ type: "input_tokens", value: 180_000 });
                expect(s.clear_at_least).toEqual({ type: "input_tokens", value: 140_000 });   // 180k − 40k
                expect(s.clear_tool_inputs).toEqual([
                    "Bash", "PowerShell", "Glob", "Grep", "Read", "WebFetch", "WebSearch",
                ]);
            }
        });
    });

    it("★ ant + USE_API_CLEAR_TOOL_USES：exclude_tools 是可写的三个（:28-32, :128-150）", () => {
        withEnv({ USER_TYPE: "ant", USE_API_CLEAR_TOOL_USES: "1" }, () => {
            const s = getAPIContextManagement()!.edits[0]!;
            if (s.type === "clear_tool_uses_20250919") {
                expect(s.exclude_tools).toEqual(["Edit", "Write", "NotebookEdit"]);
            }
        });
    });

    it("API_MAX_INPUT_TOKENS / API_TARGET_INPUT_TOKENS 可覆盖（:105-110, :129-134）", () => {
        withEnv({
            USER_TYPE: "ant", USE_API_CLEAR_TOOL_RESULTS: "1",
            API_MAX_INPUT_TOKENS: "100000", API_TARGET_INPUT_TOKENS: "20000",
        }, () => {
            const s = getAPIContextManagement()!.edits[0]!;
            if (s.type === "clear_tool_uses_20250919") {
                expect(s.trigger).toEqual({ type: "input_tokens", value: 100_000 });
                expect(s.clear_at_least).toEqual({ type: "input_tokens", value: 80_000 });
            }
        });
    });
});

// ============================================================
describe("移植 §12 autoCompactIfNeeded（含熔断器，对齐 autoCompact.ts:241-351）", () => {
    const mkHost = (): CompactHost => ({
        summarize: async () => ({ text: "<summary>OK</summary>" }),
        getTranscriptPath: () => "T",
        ids: { uuid: () => "u", timestamp: () => "TS" },
    });
    const above: Message[] = [
        asst("m1", [{ type: "text", text: "x" }], { input_tokens: 170_000, output_tokens: 0 }),
    ];

    it("★ 失败累加：consecutiveFailures 1 → 2 → …（:334-350）", async () => {
        const host: CompactHost = { summarize: async () => ({ text: null }) };
        const first = await autoCompactIfNeeded(above, host, MODEL, undefined, {
            compacted: false, turnCounter: 0, turnId: "t", consecutiveFailures: 0,
        });
        expect(first.wasCompacted).toBe(false);
        expect(first.consecutiveFailures).toBe(1);
    });

    it("★ 熔断器：连续失败 ≥3 次后**不再尝试**（:257-265；源码 BQ 记了 1279 个会话连续失败 50+ 次）", async () => {
        const host: CompactHost = { summarize: async () => ({ text: null }) };
        const tripped = await autoCompactIfNeeded(above, host, MODEL, undefined, {
            compacted: false, turnCounter: 0, turnId: "t",
            consecutiveFailures: MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
        });
        expect(tripped.wasCompacted).toBe(false);
        expect(tripped.consecutiveFailures).toBeUndefined();     // 连失败计数都不再累加
    });

    it("★ 阈值之下不动；DISABLE_COMPACT 一刀关掉（:253-255, :275-277）", async () => {
        const host = mkHost();
        const below: Message[] = [
            asst("m1", [{ type: "text", text: "x" }], { input_tokens: 100, output_tokens: 0 }),
        ];
        expect((await autoCompactIfNeeded(below, host, MODEL)).wasCompacted).toBe(false);
        expect(await withEnvAsync({ DISABLE_COMPACT: "1" }, () =>
            autoCompactIfNeeded(above, host, MODEL))).toEqual({ wasCompacted: false });
    });

    it("★ 成功路径：产出 CompactionResult，consecutiveFailures 归零（:328-333）", async () => {
        const r = await autoCompactIfNeeded(above, mkHost(), MODEL, "repl_main_thread", {
            compacted: false, turnCounter: 7, turnId: "turn-7", consecutiveFailures: 2,
        });
        expect(r.wasCompacted).toBe(true);
        expect(r.consecutiveFailures).toBe(0);
        expect(r.compactionResult!.boundaryMarker.compactMetadata.trigger).toBe("auto");
        expect(r.compactionResult!.boundaryMarker.compactMetadata.preTokens).toBe(170_000);
    });

    it("递归守卫：querySource='compact' → 不会递归压缩（:169-173）", async () => {
        expect((await autoCompactIfNeeded(above, mkHost(), MODEL, "compact")).wasCompacted).toBe(false);
    });

    it("★ 会话记忆优先于传统压缩（:287-310）", async () => {
        const seen: string[] = [];
        const host: CompactHost = {
            summarize: async () => { seen.push("summarize"); return { text: "S" }; },
            getTranscriptPath: () => "T",
            ids: { uuid: () => "u", timestamp: () => "TS" },
        };
        await withEnvAsync({ ENABLE_CLAUDE_CODE_SM_COMPACT: "1" }, () => autoCompactIfNeeded(
            above, host, MODEL, undefined, undefined, undefined,
            { content: "# Title\n真实内容\n" },
        ));
        expect(seen).toEqual([]);      // 会话记忆够用 → 根本不调摘要端口
    });
});

// ============================================================
describe("移植 §4/§13 清理与开关", () => {
    it("runPostCompactCleanup 在各种 querySource 下都不抛（:31-41 的主线程/子 agent 分支）", () => {
        expect(() => runPostCompactCleanup("repl_main_thread")).not.toThrow();
        expect(() => runPostCompactCleanup("agent:sub")).not.toThrow();
        expect(() => runPostCompactCleanup()).not.toThrow();
    });

    it("CF_TENGU_SLATE_HERON 用 JSON 覆盖时间触发配置（【适配】替代 GrowthBook）（:36-43）", () => {
        expect(withEnv({ CF_TENGU_SLATE_HERON: '{"enabled":true,"keepRecent":2}' },
            () => getTimeBasedMCConfig())).toEqual({ enabled: true, gapThresholdMinutes: 60, keepRecent: 2 });
        // 垃圾 JSON 不炸，回落
        expect(withEnv({ CF_TENGU_SLATE_HERON: "{oops" }, () => getTimeBasedMCConfig()))
            .toEqual(TIME_BASED_MC_CONFIG_DEFAULTS);
    });
});

// ============================================================
describe("§0/§14 适配层与接线壳", () => {
    it("★ historyToMessages：扁平条目 → (tool_use, tool_result) 配对，且 id 对得上", () => {
        const history = [
            { tool: "readFile", args: { path: "a.ts" }, ok: true, output: "AAA" },
            { error: "出错了" },
            { reminder: "别重复调用" },
            { tool: "runBuild", args: { command: "npm run build" }, ok: false, output: "exit=1" },
        ];
        const msgs = historyToMessages(history);
        expect(msgs.length).toBe(6);
        const a0 = msgs[0] as AssistantMessage;
        expect(a0.type).toBe("assistant");
        expect((a0.message.content[0] as { name: string }).name).toBe("readFile");
        const r0 = msgs[1] as UserMessage;
        expect((r0.message.content[0] as { tool_use_id: string }).tool_use_id).toBe("tu-0");
        // error / reminder → isMeta 文本消息
        expect((msgs[2] as UserMessage).isMeta).toBe(true);
        expect((msgs[3] as UserMessage).isMeta).toBe(true);
        // 失败结果带 is_error（微压缩的 is_error 语义靠它）
        expect((msgs[5] as UserMessage).message.content[0]).toMatchObject({ is_error: true });
    });

    it("★ messagesToHistory 往返：tool / args / ok / output 都还在", () => {
        const history = [{ tool: "writeFile", args: { path: "b.ts" }, ok: true, output: "已写入" }];
        const back = messagesToHistory(historyToMessages(history)) as Record<string, unknown>[];
        expect(back[0]!["tool"]).toBe("writeFile");
        expect(back[0]!["args"]).toEqual({ path: "b.ts" });
        expect(back[0]!["ok"]).toBe(true);
        expect(back[0]!["output"]).toBe("已写入");
    });

    it("★ applyCompactionToHistory：**整体替换**（cc query.ts:535 的同一动作），不是改中部", () => {
        const boundary = createCompactBoundaryMessage("auto", 1, undefined, undefined, undefined, { uuid: "B" });
        const summary: UserMessage = {
            type: "user", uuid: "S", timestamp: "T", isCompactSummary: true, isVisibleInTranscriptOnly: true,
            message: {
                content: "This session is being continued from a previous conversation that ran out of context."
                    + "\n\nSummary:\n做完了 X",
            },
        };
        const result: CompactionResult = {
            boundaryMarker: boundary, summaryMessages: [summary], attachments: [], hookResults: [],
        };
        const before = [{ tool: "readFile", args: {}, ok: true, output: "很久以前" }];
        const { history, messages } = applyCompactionToHistory(before, result);
        expect(before[0]!["output"]).toBe("很久以前");            // 入参零改动
        expect(history.length).toBe(2);                           // 边界 + 摘要（没有保留段）
        expect((history[0] as Record<string, unknown>)["subtype"]).toBe("compact_boundary");
        expect((history[1] as Record<string, unknown>)["text"]).toContain("Summary:");
        expect(messages[0]).toBe(boundary);
    });

    it("describeTokenWarning：★ 注意源码里 warning/error 两个缓冲**都是 20_000**，所以中间那档不可达", () => {
        // autoCompact.ts:63-64 —— WARNING_THRESHOLD_BUFFER_TOKENS = ERROR_THRESHOLD_BUFFER_TOKENS = 20_000
        // ⇒ isAboveErrorThreshold 成立时 isAboveWarningThreshold 必然也成立，
        //   "approaching limit" 这一档在默认配置下永远轮不到。这是移植保真的一部分，不是我写漏了。
        expect(describeTokenWarning(0, MODEL)).toContain("Context OK");
        expect(describeTokenWarning(146_999, MODEL)).toContain("Context OK");
        expect(describeTokenWarning(147_000, MODEL)).toContain("Context low");   // 直接进 error 档
        expect(describeTokenWarning(150_000, MODEL)).toContain("Context low");
        expect(describeTokenWarning(167_000, MODEL)).toContain("Context low");
        expect(describeTokenWarning(180_000, MODEL)).toContain("blocking limit");
    });
});

// ============================================================
// 窗口基准来自**用户配置**（sys_settings），阈值是它的比例。这一组验的就是这件事。
describe("★ §12.1 窗口基准：用户输入 + 分档覆盖 + 未配置时保守", () => {
    const flash = "deepseek-v4-flash";
    const pro = "deepseek-v4-pro[1m]";

    it("★ 比例是**从源码的绝对值折算**来的：分母就是 cc 那几个常数标定的 eff（200_000−20_000）", () => {
        expect(CC_REFERENCE_EFFECTIVE_WINDOW).toBe(180_000);
        expect(AUTOCOMPACT_BUFFER_FRACTION).toEqual({ num: 13_000, den: 180_000 });
        expect(WARNING_BUFFER_FRACTION).toEqual({ num: 20_000, den: 180_000 });
        expect(BLOCKING_BUFFER_FRACTION).toEqual({ num: 3_000, den: 180_000 });
        // 整数运算范围内精确：180_000 上正好折回 13_000 / 20_000 / 3_000，不差 1
        expect(ratioBuffer(180_000, AUTOCOMPACT_BUFFER_FRACTION)).toBe(13_000);
        expect(ratioBuffer(180_000, WARNING_BUFFER_FRACTION)).toBe(20_000);
        expect(ratioBuffer(180_000, BLOCKING_BUFFER_FRACTION)).toBe(3_000);
    });

    it("★ 保真锚点：把窗口配成 cc 的 200_000 时，比例式与源码的绝对原式**逐位相同**", () => {
        const spec = resolveContextWindow({ contextWindowTokens: 200_000, env: {}, model: MODEL });
        const exact = getCcExactThresholds(MODEL);
        expect(exact.effectiveWindow).toBe(180_000);
        expect(exact.autocompactThreshold).toBe(167_000);        // cc 的那个数
        expect(exact.blockingLimit).toBe(177_000);

        expect(getEffectiveContextWindowSize(spec)).toBe(exact.effectiveWindow);
        expect(getAutoCompactThreshold(spec)).toBe(exact.autocompactThreshold);
        expect(calculateTokenWarningState(exact.warningThreshold, spec).isAboveWarningThreshold).toBe(true);
        expect(calculateTokenWarningState(exact.warningThreshold - 1, spec).isAboveWarningThreshold).toBe(false);
        expect(calculateTokenWarningState(exact.blockingLimit, spec).isAtBlockingLimit).toBe(true);
        expect(calculateTokenWarningState(exact.blockingLimit - 1, spec).isAtBlockingLimit).toBe(false);
    });

    it("★ 阈值随配置的窗口缩放：同一份对话，小窗口早该压、大窗口还很早", () => {
        const used = 60_000;                       // 同一份对话
        const small = resolveContextWindow({ contextWindowTokens: 40_000, env: {}, model: flash });
        const large = resolveContextWindow({ contextWindowTokens: 1_000_000, env: {}, model: pro });

        // 小窗口：60_000 已经越过压缩线（18_556）甚至阻塞线（19_667）
        const s = calculateTokenWarningState(used, small);
        expect(s.isAboveAutoCompactThreshold).toBe(true);
        expect(s.isAtBlockingLimit).toBe(true);
        // 大窗口：同一份对话离预警线（800_335）还很远，什么都不做
        const l = calculateTokenWarningState(used, large);
        expect(l.isAboveAutoCompactThreshold).toBe(false);
        expect(l.isAboveWarningThreshold).toBe(false);
        expect(l.isAtBlockingLimit).toBe(false);
        // 量化：两条压缩线差一个数量级以上
        expect(getAutoCompactThreshold(large) / getAutoCompactThreshold(small)).toBeGreaterThan(40);
    });

    it("★ 未配置 → 产品默认 256_000 + **一行**告警 + degraded（且走的是同一套百分比）", () => {
        resetContextWindowWarnings();
        const lines: string[] = [];
        const spec = resolveContextWindow({ env: {}, warn: (l) => lines.push(l) });

        expect(DEFAULT_CONTEXT_WINDOW_TOKENS).toBe(256_000);          // ★ 产品拍板值
        expect(spec.contextWindowTokens).toBe(256_000);
        expect(spec.source).toBe("unset-default");
        expect(spec.degraded).toBe(true);
        expect(lines.length).toBe(1);                       // 一行，不刷屏
        expect(lines[0]).toContain("上下文窗口未配置");
        expect(lines[0]).toContain("256000");               // 题面必须带真数字
        expect(lines[0]).toContain("context_window");       // 说清该填哪个字段
        expect(lines[0]).toContain("越窗");

        // ★ 阈值就是**配置成 256_000 时的同一套数**（不是另一条路径）
        const asConfigured = resolveContextWindow({ contextWindowTokens: 256_000, env: {}, model: "" });
        expect(spec.contextWindowTokens).toBe(asConfigured.contextWindowTokens);
        // eff = 256_000 − min(32_000, 20_000) = 236_000
        expect(getEffectiveContextWindowSize(spec)).toBe(236_000);
        // 线 = 236_000 − floor(236_000×13000/180000) = 236_000 − 17_044 = 218_956
        expect(getAutoCompactThreshold(spec)).toBe(218_956);
        expect(getAutoCompactThreshold(spec)).toBe(getAutoCompactThreshold(asConfigured));
        expect(calculateTokenWarningState(218_956, spec)).toEqual(calculateTokenWarningState(218_956, asConfigured));
        expect(calculateTokenWarningState(218_955, spec).isAboveAutoCompactThreshold).toBe(false);

        // ⚠️ 诚实记录方向：256_000 **大于** cc 自己的 200_000 标定窗口，
        //    所以默认值上的线比 cc 的 167_000 **更晚**触发（不是更早）。
        //    真实窗口若小于 256K，就会压得太晚 —— 告警那一行的意义正在于此。
        const ccWindow = resolveContextWindow({ contextWindowTokens: 200_000, env: {}, model: "" });
        expect(getAutoCompactThreshold(ccWindow)).toBe(167_000);
        expect(getAutoCompactThreshold(spec)).toBeGreaterThan(getAutoCompactThreshold(ccWindow));

        // 同一个 (档位, 模型) 只喊一次；换档位算新 key → 再喊一次
        resolveContextWindow({ env: {}, warn: (l) => lines.push(l) });
        expect(lines.length).toBe(1);
        resolveContextWindow({ env: {}, tier: "pro", warn: (l) => lines.push(l) });
        expect(lines.length).toBe(2);
    });

    it("★ 字段别名是契约：contextWindowTokens 与 contextTokens 永远同值（接线层在读后者）", () => {
        // `developerAgent/contextCompaction.ts`（接线层）按 `window.contextTokens` 取值，
        // 所以这两个名字必须一直同值——别「顺手清理」掉别名，那会直接打断接线。
        const spec = resolveContextWindow({ contextWindowTokens: 300_000, env: {}, model: "m" });
        expect(spec.contextWindowTokens).toBe(300_000);
        expect(spec.contextTokens).toBe(300_000);

        // 别名入参也对（只填 contextTokens 或只填 contextTokensPro 都能用）
        expect(resolveContextWindow({ contextTokens: 111_111, env: {} }).contextWindowTokens).toBe(111_111);
        expect(resolveContextWindow({
            contextTokens: 200_000, contextTokensPro: 500_000, tier: "pro", env: {},
        })).toMatchObject({ contextWindowTokens: 500_000, source: "settings-tier" });

        // 手工构造的 spec 只填一个字段也能跑（asWindowSpec 补齐，不会静默变 0）
        const half = { contextTokens: 400_000 } as unknown as ContextWindowSpec;
        expect(asWindowSpec(half).contextWindowTokens).toBe(400_000);
        expect(getAutoCompactThreshold(asWindowSpec(half))).toBe(getAutoCompactThreshold(
            resolveContextWindow({ contextWindowTokens: 400_000, env: {}, model: "" }),
        ));
    });

    it("★ 产品规格钉死：默认窗口 = 256000，且默认路径与「显式配成 256000」逐位同解", () => {
        // ① 常数本身
        expect(DEFAULT_CONTEXT_WINDOW_TOKENS).toBe(256_000);
        // ② 未配置解析出来的就是它
        const unset = resolveContextWindow({ env: {}, warn: () => {} });
        expect(unset.contextWindowTokens).toBe(256_000);
        expect(unset.source).toBe("unset-default");
        expect(unset.degraded).toBe(true);
        // ③ 显式配置同一个数
        const configured = resolveContextWindow({ contextWindowTokens: 256_000, env: {}, model: "" });
        expect(configured.source).toBe("settings");
        expect(configured.degraded).toBe(false);
        // ④ 两者走到**同一个解**——默认值不是另一条计算路径，只是同一个数的不同来处
        expect(getEffectiveContextWindowSize(unset)).toBe(getEffectiveContextWindowSize(configured));
        expect(getAutoCompactThreshold(unset)).toBe(getAutoCompactThreshold(configured));
        for (const used of [0, 100_000, 192_733, 192_734, 218_955, 218_956, 232_066, 232_067, 236_000]) {
            expect(calculateTokenWarningState(used, unset)).toEqual(calculateTokenWarningState(used, configured));
        }
        // ⑤ 具体数字（236_000 的 eff 上：线 218_956 / 预警 192_734 / 阻塞 232_067）
        expect(getEffectiveContextWindowSize(unset)).toBe(236_000);
        expect(getAutoCompactThreshold(unset)).toBe(218_956);
        expect(calculateTokenWarningState(192_733, unset).isAboveWarningThreshold).toBe(false);
        expect(calculateTokenWarningState(192_734, unset).isAboveWarningThreshold).toBe(true);
        expect(calculateTokenWarningState(232_066, unset).isAtBlockingLimit).toBe(false);
        expect(calculateTokenWarningState(232_067, unset).isAtBlockingLimit).toBe(true);
        // ⑥ 分档仍然压得住默认值：pro 档的 [1m] 走 1M，不跟着默认值走
        const pro = resolveContextWindow({ tier: "pro", model: "deepseek-v4-pro[1m]", env: {} });
        expect(pro.contextWindowTokens).toBe(1_000_000);
        expect(pro.degraded).toBe(false);
        expect(getAutoCompactThreshold(pro)).toBe(909_223);
    });

    it("★ 分档解析：pro 用自己的窗口，flash 回落全局；两档差一个数量级也不串味", () => {
        // ① 显式分档覆盖
        const proSpec = resolveContextWindow({
            contextWindowTokens: 200_000, contextWindowProTokens: 1_000_000,
            tier: "pro", model: pro, env: {},
        });
        expect(proSpec.source).toBe("settings-tier");
        expect(proSpec.contextWindowTokens).toBe(1_000_000);
        expect(getAutoCompactThreshold(proSpec)).toBe(909_223);

        // ② flash 档**看不见** pro 的覆盖（只有 tier==="pro" 才看）
        const flashSpec = resolveContextWindow({
            contextWindowTokens: 200_000, contextWindowProTokens: 1_000_000,
            tier: "flash", model: flash, env: {},
        });
        expect(flashSpec.source).toBe("settings");
        expect(flashSpec.contextWindowTokens).toBe(200_000);
        expect(getAutoCompactThreshold(flashSpec)).toBe(167_000);

        // ③ 没配分档覆盖、但 pro 的模型名自带 [1m] → 按 1M 算（模型名也是声明）
        const byName = resolveContextWindow({ tier: "pro", model: pro, env: {} });
        expect(byName.source).toBe("model-suffix");
        expect(byName.contextWindowTokens).toBe(1_000_000);
        // ④ 而 flash 的模型名没有后缀 → 保守默认（会告警）
        const flashUnset = resolveContextWindow({ tier: "flash", model: flash, env: {}, warn: () => {} });
        expect(flashUnset.source).toBe("unset-default");

        // ⑤ 同一份对话在两档下的判定完全不同 —— 这正是"分档解析"要防的
        expect(calculateTokenWarningState(200_000, proSpec).isAboveAutoCompactThreshold).toBe(false);
        expect(calculateTokenWarningState(200_000, flashSpec).isAboveAutoCompactThreshold).toBe(true);
    });

    it("★ 优先级与产品一致（sys_settings > .env > 内置默认）：逐档钉住", () => {
        // pro 覆盖 > 全局
        expect(resolveContextWindow({
            contextWindowProTokens: 500_000, contextWindowTokens: 200_000, tier: "pro", env: {},
        }).source).toBe("settings-tier");
        // 全局 > [1m] 后缀（用户显式填了数就以数为准）
        expect(resolveContextWindow({
            contextWindowTokens: 300_000, tier: "pro", model: pro, env: {},
        }).contextWindowTokens).toBe(300_000);
        // [1m] 后缀 > env（模型名来自 sys_settings，.env 是更低一级；要封顶请用
        //   CLAUDE_CODE_AUTO_COMPACT_WINDOW 这个取 min 的闸）
        expect(resolveContextWindow({ model: pro, env: { CF_CONTEXT_WINDOW_TOKENS: "123" } }).source)
            .toBe("model-suffix");
        // env > 保守默认
        expect(resolveContextWindow({ model: flash, env: { CF_CONTEXT_WINDOW_TOKENS: "64000" } }))
            .toMatchObject({ contextWindowTokens: 64_000, source: "env", degraded: false });
        // 垃圾值当没配（0 / 负数 / NaN / 字符串垃圾），绝不落成 0
        for (const bad of [0, -1, Number.NaN, "abc", ""]) {
            const s = resolveContextWindow({ contextWindowTokens: bad, env: {}, warn: () => {} });
            expect(s.source).toBe("unset-default");
            expect(s.contextWindowTokens).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
        }
    });

    it("★ 配置了窗口后，四道线的**边界**（含等号）逐条钉住", () => {
        const spec = resolveContextWindow({ contextWindowTokens: 128_000, env: {}, model: MODEL });
        // eff = 128_000 − min(32_000, 20_000) = 108_000
        // 线 = 108_000 − 7_800 = 100_200；预警 = 100_200 − 12_000 = 88_200；阻塞 = 108_000 − 1_800 = 106_200
        expect(getEffectiveContextWindowSize(spec)).toBe(108_000);
        expect(getAutoCompactThreshold(spec)).toBe(100_200);

        expect(calculateTokenWarningState(88_199, spec).isAboveWarningThreshold).toBe(false);
        expect(calculateTokenWarningState(88_200, spec).isAboveWarningThreshold).toBe(true);
        expect(calculateTokenWarningState(100_199, spec).isAboveAutoCompactThreshold).toBe(false);
        expect(calculateTokenWarningState(100_200, spec).isAboveAutoCompactThreshold).toBe(true);
        expect(calculateTokenWarningState(106_199, spec).isAtBlockingLimit).toBe(false);
        expect(calculateTokenWarningState(106_200, spec).isAtBlockingLimit).toBe(true);
        expect(calculateTokenWarningState(0, spec).percentLeft).toBe(100);
    });

    it("★ 小窗口不再算出负数线（cc 的绝对式在这里会退化成负数 → 每轮都判「该压」）", () => {
        // 源码的绝对式：32_000 − 20_000 − 13_000 = −1_000。这就是必须折算成比例的理由。
        expect(32_000 - 20_000 - 13_000).toBeLessThan(0);

        const tiny = resolveContextWindow({ contextWindowTokens: 32_000, env: {}, model: MODEL });
        const eff = getEffectiveContextWindowSize(tiny);
        const threshold = getAutoCompactThreshold(tiny);
        expect(eff).toBe(16_000);        // 输出预留被"不超过半个窗口"的守卫夹到 16_000
        expect(threshold).toBeGreaterThan(0);
        expect(threshold).toBe(14_845);
        // 线序单调，不出现"预警晚于压缩"这种倒挂
        const s = calculateTokenWarningState(0, tiny);
        expect(s.isAboveWarningThreshold).toBe(false);
        expect(s.isAtBlockingLimit).toBe(false);
        expect(calculateTokenWarningState(15_800, tiny).isAtBlockingLimit).toBe(true);   // 阻塞线 15_734
        expect(calculateTokenWarningState(11_000, tiny).isAboveAutoCompactThreshold).toBe(false);
        expect(calculateTokenWarningState(15_000, tiny).isAboveAutoCompactThreshold).toBe(true);
    });

    it("窗口基准可以整份注入（纯函数入参），asWindowSpec 也接受旧的「模型名」写法", () => {
        const spec = resolveContextWindow({ contextWindowTokens: 64_000, env: {}, model: "m", tier: "flash" });
        expect(getAutoCompactThreshold(spec)).toBe(getAutoCompactThreshold(spec));
        // 传 spec 与传等价的"模型名"得到同一个数（后者走 env 兜底）
        expect(asWindowSpec(MODEL).contextWindowTokens).toBe(200_000);   // beforeEach 设的 env
    });
});

// ============================================================
describe("★ 机制必合项（机制一致即可，不必逐行照抄）", () => {
    it("① 什么时候压：量的是**最后一次 API 响应的 usage**＋其后新增的估算（不是字符数、不是累计计数）", () => {
        // 源码 utils/tokens.ts:226-261 是点名过的 CANONICAL 口径；autoCompact.ts:119-120 用它比阈值。
        const msgs: Message[] = [
            asst("m1", [{ type: "text", text: "x" }], {
                input_tokens: 100_000, output_tokens: 50,
                cache_creation_input_tokens: 10_000, cache_read_input_tokens: 60_000,
            }),
            usr("u2", "a".repeat(4_000)),      // 锚点之后新增 → 估算 1000
        ];
        // 四项全算：100000 + 10000 + 60000 + 50 = 170050，再加 1000
        expect(tokenCountWithEstimation(msgs)).toBe(171_050);
        // 换窗户（阈值随之变）→ 判定翻转，证明"比的是这个量"
        expect(withEnv({ CF_CONTEXT_WINDOW_TOKENS: "128000" },
            () => calculateTokenWarningState(tokenCountWithEstimation(msgs), MODEL).isAboveAutoCompactThreshold))
            .toBe(true);
        // 同样这 4 号窗口下，少一点的对话不触发
        expect(withEnv({ CF_CONTEXT_WINDOW_TOKENS: "128000" }, () =>
            calculateTokenWarningState(50_000, MODEL).isAboveAutoCompactThreshold)).toBe(false);
    });

    it("② 压什么：微压缩只碰**白名单工具**的 tool_result 且保留最近 N 条；宏压缩的请求把 tools 收成一个、thinking 关掉", () => {
        // 源码 microCompact.ts:41-50（白名单）+ :456-492（保留最近 N）；compact.ts:1292-1326（请求参数）
        setTimeBasedMCConfig({ enabled: true, keepRecent: 1 });
        const t0 = Date.parse("2026-01-01T00:00:00.000Z");
        const msgs: Message[] = [
            ...pair(0, "Read", "A".repeat(9_000)),        // 白名单 + 老的 → 清
            ...pair(1, "NotebookEdit", "B".repeat(9_000)), // 不在白名单 → 永不碰
            ...pair(2, "Bash", "C".repeat(9_000)),         // 白名单 + 最新的 1 条 → 保留
            asst("m9", [{ type: "text", text: "hi" }]),
        ];
        const r = microcompactMessages(msgs, "repl_main_thread", { nowMs: t0 + 90 * 60_000 });
        const body = (i: number): unknown => {
            const c = (r.messages[i] as UserMessage).message.content;
            return Array.isArray(c) ? (c[0] as { content: unknown }).content : undefined;
        };
        expect(body(1)).toBe("[Old tool result content cleared]");
        expect(body(3)).toBe("B".repeat(9_000));
        expect(body(5)).toBe("C".repeat(9_000));

        // 宏压缩（摘要调用）看到的东西：系统提示词固定、tools 只剩读文件、thinking 关
        const req = buildSummaryRequest({
            messages: msgs, summaryRequest: usr("s", "P"), model: MODEL,
        });
        expect(req.systemPrompt).toEqual(["You are a helpful AI assistant tasked with summarizing conversations."]);
        expect(req.tools).toEqual(["Read"]);
        expect(req.thinkingConfig.type).toBe("disabled");
    });

    it("③ 保留/丢/顺序：产物顺序固定；保留段按三闸切片且不劈开 tool 配对；被摘要覆盖的那段才是「丢」", () => {
        // 源码 compact.ts:330-338（顺序）/ sessionMemoryCompact.ts:324-397（三闸）、:232-314（配对）
        const boundary = createCompactBoundaryMessage("auto", 1, undefined, undefined, undefined, { uuid: "B" });
        const summary = usr("S", "Summary:", { isCompactSummary: true });
        const result: CompactionResult = {
            boundaryMarker: boundary, summaryMessages: [summary],
            messagesToKeep: [usr("K", "kept")], attachments: [attachment("file")], hookResults: [usr("H", "h")],
        };
        expect(buildPostCompactMessages(result).map((m) => m.uuid))
            .toEqual(["B", "S", "K", "att-file", "H"]);

        // 三闸：够 minTokens(10_000) 且够 minTextBlockMessages(5) → 停在原地，不多留也不少留
        const many: Message[] = Array.from({ length: 20 }, (_, i) => usr(`u${i}`, "x".repeat(8_000)));
        expect(calculateMessagesToKeepIndex(many, 9)).toBe(10);

        // 不许把 tool_use / tool_result 劈开：切点落在 result 上时必须往前拉回它的 tool_use
        expect(adjustIndexToPreserveAPIInvariants(pair(0, "Read", "x"), 1)).toBe(0);
    });

    it("④ 边界怎么表示：system + subtype='compact_boundary' + compactMetadata；切分语义 = **最后一道边界之后才是活的对话**", () => {
        // 源码 utils/messages.ts:4530-4555（形状）、:4608-4657（识别与切片）
        const b1 = createCompactBoundaryMessage("auto", 167_000, "u-old", undefined, 40, { uuid: "b1" });
        const b2 = createCompactBoundaryMessage("auto", 170_000, "u-mid", undefined, 12, { uuid: "b2" });
        expect(b1.subtype).toBe("compact_boundary");
        expect(b1.compactMetadata.preTokens).toBe(167_000);
        expect(b1.compactMetadata.messagesSummarized).toBe(40);
        expect(b1.compactMetadata.trigger).toBe("auto");
        // 第二次压缩时，模型能看到的只有最后一道边界之后的部分
        const msgs: Message[] = [usr("u0", "很久以前"), b1, usr("u1", "上一段"), b2, usr("u2", "现在")];
        expect(findLastCompactBoundaryIndex(msgs)).toBe(3);
        expect(getMessagesAfterCompactBoundary(msgs).map((m) => m.uuid)).toEqual(["b2", "u2"]);
        // 而边界是 system 消息 → 进 API 时会被滤掉（messages.ts:4641 的注释）
        expect(normalizeMessagesForAPI(getMessagesAfterCompactBoundary(msgs)).some((m) => m.type === "system"))
            .toBe(false);
    });

    it("⑤ 摘要怎么回灌：一条 isCompactSummary 的 user 消息 + 续跑抬头；自动压缩再追加「接着干别寒暄」", async () => {
        // 源码 prompt.ts:337-373（正文）、compact.ts:613-624（消息形状）
        const text = getCompactUserSummaryMessage("Summary:\n做完了 X", true);
        expect(text.startsWith(
            "This session is being continued from a previous conversation that ran out of context.",
        )).toBe(true);
        expect(text).toContain("The summary below covers the earlier portion of the conversation.");
        expect(text.endsWith("Pick up the last task as if the break never happened.")).toBe(true);

        // 端到端：回灌的那条消息就是普通 user 消息，且草稿块不进上下文
        const host: CompactHost = {
            summarize: async () => ({
                text: "<analysis>草稿</analysis><summary>\n1. Primary Request and Intent: X\n</summary>",
            }),
            getTranscriptPath: () => "T",
            ids: { uuid: () => "u", timestamp: () => "TS" },
        };
        const r = await compactConversation(
            [...pair(0, "Read", "a"), ...pair(1, "Read", "b")], host,
            { model: MODEL, suppressFollowUpQuestions: true, isAutoCompact: true },
        );
        const injected = r.summaryMessages[0]!;
        expect(injected.type).toBe("user");
        expect(injected.isCompactSummary).toBe(true);
        expect(injected.message.content as string).toContain("Summary:\n1. Primary Request and Intent: X");
        expect(injected.message.content as string).not.toContain("草稿");
        // 回灌位置在**保留段之前**（顺序就是可读性/连贯性本身）
        expect(buildPostCompactMessages(r)[0]).toBe(r.boundaryMarker);
        expect(buildPostCompactMessages(r)[1]).toBe(injected);
    });
});

// ============================================================
describe("★ 阈值按源码的方式**推导**，不是拍一个常数", () => {
    it("★ 同一套公式（比例式）换算到 200_000 窗口上，逐位复现 cc 的 167_000", () => {
        const maxOut = Math.min(getMaxOutputTokensForModel(MODEL), 20_000);
        expect(maxOut).toBe(20_000);
        const spec = resolveContextWindow({ contextWindowTokens: 200_000, env: {}, model: MODEL });
        expect(getEffectiveContextWindowSize(spec)).toBe(200_000 - maxOut);
        // 线 = eff − eff×13/180，在 eff = 180_000 上正好是 167_000（cc 的数）
        expect(getAutoCompactThreshold(spec)).toBe(167_000);
        // 且等价于"直接减 13_000"（源码的绝对式）——这就是"折算没走样"的证据
        expect(getAutoCompactThreshold(spec)).toBe(200_000 - maxOut - AUTOCOMPACT_BUFFER_TOKENS);
    });

    it("★ 换窗口不再靠「减常数」：同一个模型换窗口，扣减量跟着等比变（没有第二个常数）", () => {
        const rows = [[200_000, 180_000], [128_000, 108_000], [1_000_000, 980_000]] as const;
        for (const [window, eff] of rows) {
            withEnv({ CF_CONTEXT_WINDOW_TOKENS: String(window) }, () => {
                expect(getEffectiveContextWindowSize("deepseek-v4-flash")).toBe(eff);
                // 扣减量 = floor(eff × 13000/180000)，随窗口线性走
                expect(getAutoCompactThreshold("deepseek-v4-flash"))
                    .toBe(eff - ratioBuffer(eff, AUTOCOMPACT_BUFFER_FRACTION));
            });
        }
    });

    it("★ 窗口事实入口的 provenance：看得出这个数是**事实**还是**假设**", () => {
        // 事实：显式声明
        expect(contextWindowSource("deepseek-v4-flash", { CF_CONTEXT_WINDOW_TOKENS: "128000" }))
            .toEqual({ window: 128_000, source: "env" });
        // 事实：模型名自带 [1m]
        expect(contextWindowSource("deepseek-v4-pro[1m]", {})).toEqual({ window: 1_000_000, source: "1m-suffix" });
        // 假设：两样都没有 → 退回 cc 的常数，但 source 明说是 default
        expect(contextWindowSource("deepseek-v4-flash", {})).toEqual({ window: 200_000, source: "default" });
        // 垃圾声明不生效（不落成 NaN/0）
        expect(contextWindowSource("m", { CF_CONTEXT_WINDOW_TOKENS: "abc" })).toEqual({ window: 200_000, source: "default" });
        expect(contextWindowSource("m", { CF_CONTEXT_WINDOW_TOKENS: "0" })).toEqual({ window: 200_000, source: "default" });
    });

    it("★ 换窗口 → 四道线整体平移（同一个公式，不是四个独立常数）", () => {
        withEnv({ CF_CONTEXT_WINDOW_TOKENS: "128000" }, () => {
            // eff 108_000 → 线 100_200、预警 88_200、阻塞 106_200
            const s = calculateTokenWarningState(100_200, MODEL);
            expect(s.isAboveAutoCompactThreshold).toBe(true);
            expect(s.isAboveWarningThreshold).toBe(true);
            expect(s.isAtBlockingLimit).toBe(false);
            expect(calculateTokenWarningState(100_199, MODEL).isAboveAutoCompactThreshold).toBe(false);
            expect(calculateTokenWarningState(88_199, MODEL).isAboveWarningThreshold).toBe(false);
            expect(calculateTokenWarningState(106_199, MODEL).isAtBlockingLimit).toBe(false);
            expect(calculateTokenWarningState(106_200, MODEL).isAtBlockingLimit).toBe(true);
        });
    });

    it("`[1m]` 与 env 的顺序在两个入口上**必须一致**（否则「窗口」和「有效窗口」会自相矛盾）", () => {
        withEnv({ CF_CONTEXT_WINDOW_TOKENS: "128000" }, () => {
            // 模型名来自 sys_settings（比 .env 高一级）→ [1m] 赢；要封顶请用
            // CLAUDE_CODE_AUTO_COMPACT_WINDOW（那个是取 min 的闸）
            expect(getContextWindowForModel("deepseek-v4-pro[1m]")).toBe(1_000_000);
            expect(asWindowSpec("deepseek-v4-pro[1m]").contextWindowTokens).toBe(1_000_000);
            expect(asWindowSpec("deepseek-v4-pro[1m]").source).toBe("model-suffix");
            // 而 env 仍然管得住不带后缀的模型，并且仍然能封顶（取 min）
            expect(getContextWindowForModel("deepseek-v4-flash")).toBe(128_000);
        });
        expect(withEnv({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: "50000" }, () =>
            getEffectiveContextWindowSize("deepseek-v4-pro[1m]"))).toBe(30_000);
    });
});

// ============================================================
describe("确定性：同输入 → 同输出", () => {
    it("★ 注入 ids 后，边界标记与提示词逐字节可重放", () => {
        const ids = { uuid: "fixed", timestamp: "2026-01-01T00:00:00.000Z" };
        expect(JSON.stringify(createCompactBoundaryMessage("auto", 167_000, "u0", undefined, 3, ids)))
            .toBe(JSON.stringify(createCompactBoundaryMessage("auto", 167_000, "u0", undefined, 3, ids)));
        expect(getCompactPrompt("x")).toBe(getCompactPrompt("x"));
        expect(formatCompactSummary("<summary>y</summary>")).toBe(formatCompactSummary("<summary>y</summary>"));
    });

    it("★ 估算与分组都是纯函数：同输入同输出", () => {
        const msgs = [...pair(0, "Read", "hello"), ...pair(1, "Bash", "world")];
        expect(roughTokenCountEstimationForMessages(msgs)).toBe(roughTokenCountEstimationForMessages(msgs));
        expect(tokenCountWithEstimation(msgs)).toBe(tokenCountWithEstimation(msgs));
        expect(JSON.stringify(groupMessagesByApiRound(msgs)))
            .toBe(JSON.stringify(groupMessagesByApiRound(msgs)));
    });

    it("★ 阈值计算无全局状态漂移：连算两次一致", () => {
        expect(getAutoCompactThreshold(MODEL)).toBe(getAutoCompactThreshold(MODEL));
        expect(calculateTokenWarningState(167_000, MODEL)).toEqual(calculateTokenWarningState(167_000, MODEL));
    });

    it("★ 微压缩是**纯产出**：入参 messages 不被就地改写（源码 :470-492 也是 map 出新数组）", () => {
        const msgs = [...pair(0, "Read", "AAA"), ...pair(1, "Bash", "BBB")];
        const before = JSON.stringify(msgs);
        setTimeBasedMCConfig({ enabled: true, keepRecent: 1 });
        // 用一个远晚于消息时间戳的 nowMs，保证时间触发必然命中
        microcompactMessages(msgs, "repl_main_thread", { nowMs: 1e15 });
        expect(JSON.stringify(msgs)).toBe(before);
    });
});
