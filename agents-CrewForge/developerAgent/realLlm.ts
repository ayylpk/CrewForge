// ============================================================
// realLlm.ts —— 真实 LLM 适配器（DeveloperLlm 接口的生产实现）
//
// 定位：graph.ts 的 runToolLoop 只认 DeveloperLlm 接口（Java 类比：接口 vs 实现类，
//   测试注 Fake 实现，生产注本文件实现）。本适配器把接口的"下一步决策"语义
//   翻译成一次 Anthropic Messages API 调用。
//
// ★ 9/14 升级：原生 tool_use（参考 pi 的 agent-loop 设计，非搬运）
//   · 旧协议：工具描述 JSON.stringify 成文本塞进 user 消息，模型用文本吐 JSON，
//     再用 extractJson() 括号扫描器抠出来 —— 这是"用文本模拟 function calling"，
//     模型要额外做编解码体操，格式崩了还要 coerceDecision 兜底、max_tokens 抬到 8192。
//   · 新协议：工具走 API 原生 tools 字段（模型训练时的形态），响应直接收 tool_use 块。
//     一次调用 = 一个决策 = 一条 llm_call_planned 台账；9/14 ③并行：一轮多个 tool_use
//     且全为只读时打包成 batch（仍是一条台账，批内并发执行），混入非只读则降级取第一个。
//   · 完成信号：不再靠模型手写 {"kind":"done"}，而是"本轮没有调用任何工具" ——
//     这是模型的自然行为（想干活就调工具，干完就没得调），比文本约定更抗格式崩。
//   · 保底：DEVELOPER_LLM_NATIVE_TOOLS=0 或 nativeTools:false 一键退回旧文本协议。
//
// 设计约束（对齐 README 阶段 6）：
//   · 一次 next() = 一个决策（= 一条 llm_call_planned 台账）。**不等于**一次 HTTP 请求：
//     9/15 批 C 起，瞬时故障（429/5xx/网络抖动）在 next() 内部退避重试；max_tokens 截断
//     会一次性升档重发。两者都不改变"一步一账"的记账语义——预占/对账发生在
//     runToolLoop 的**步**粒度（graph.ts:671 planned++），同一步内部多发几次请求
//     只是这一步的真实成本，不会让台账多记一笔。需要防的是**跨步重试**，那才记账错位。
//   · 解析不了把原文交回，coerceDecision 兜底判定，失败按一步计费（规格九）。
//
// 配置来源（env，由 .env 提供）：
//   ANTHROPIC_BASE_URL    端点（不带 /v1）
//   ANTHROPIC_AUTH_TOKEN  Bearer token
//   DEVELOPER_LLM_MODEL   模型名，缺省 qwen3.8-flash
//   DEVELOPER_LLM_NATIVE_TOOLS=0  退回 JSON 文本协议（缺省 = 用原生 tool_use）
// ============================================================

import type { DeveloperLlm } from "./graph";

export interface RealLlmOptions {
    /** 端点，默认取 process.env.ANTHROPIC_BASE_URL */
    baseUrl?: string;
    /** Bearer token，默认取 process.env.ANTHROPIC_AUTH_TOKEN */
    authToken?: string;
    /** 模型名，默认取 process.env.DEVELOPER_LLM_MODEL，再缺省 qwen3.8-flash */
    model?: string;
    /** 单次回复 token 上限 */
    maxTokens?: number;
    /**
     * 单次请求超时（毫秒）。9/15 批 C 起它**兼任这一步的重试总预算**：
     * 退避等待若会让本步总时长越过这个值，就不重试了，直接抛错给上层按步容错。
     * 效果是"这一步最坏花单次超时的两倍时间"，且超时类失败天然不会被重试（详见 send）。
     */
    timeoutMs?: number;
    /**
     * 是否使用原生 tool_use（缺省 true，可用 env DEVELOPER_LLM_NATIVE_TOOLS=0 关闭）。
     * 关闭后回到"工具描述进文本、模型吐 JSON"的旧协议，行为与 9/14 前完全一致。
     */
    nativeTools?: boolean;
    /**
     * 瞬时故障（429/5xx/网络抖动）在同一次 next() 内的退避重试次数上限。
     * 缺省 RETRY_MAX_RETRIES；传 0 = 关闭内部重试（行为退回 9/15 前：一次失败即抛，
     * 由 graph 的 llmErrorStreak 兜底）。**不改记账语义**：重试发生在"一步"内部。
     */
    maxRetries?: number;
    /**
     * 退避首档（毫秒）。缺省 RETRY_INITIAL_DELAY_MS=500（dsh/cc 同款）。
     * 做成可配是为了**测试能把它压到 1ms**——集成用例不该真等 1.5 秒；
     * dsh 的 initialDelayMs 同样是可配置项（`retry-policy.ts:26`）。
     */
    retryInitialDelayMs?: number;
    /**
     * stop_reason=max_tokens（输出被截断）时是否升档重发一次。
     * 缺省 true。**仅当调用方没显式传 maxTokens 时生效**——显式给了上限就是明确意图，
     * 不该被适配器偷偷突破（对齐 cc `query.ts:1199-1201` 的 `maxOutputTokensOverride === undefined` 守卫）。
     */
    escalateOnMaxTokens?: boolean;
    /** 每次调用后的观测钩子（trace/统计用，不参与决策） */
    onCall?: (info: {
        seq: number;
        latencyMs: number;
        inputTokens: number;
        outputTokens: number;
        stopReason: string;
        rawText: string;
        /** 本次决策来自原生 tool_use 还是文本协议（观测用） */
        mode: "native" | "text";
        /** 命中提示缓存的输入 token（Anthropic 协议字段，读到就报，读不到为 0） */
        cacheReadTokens: number;
        /** 本次写入提示缓存的输入 token（同上） */
        cacheCreationTokens: number;
        /** 这一步实际发了几次 HTTP 请求（重试/升档会 >1；调用方 = 1 次 next()） */
        attempts: number;
        /** 这一步是否发生过 max_tokens 升档重发（与"瞬时故障重试"区分开，r5 观测要分开看） */
        escalated: boolean;
    }) => void;
}

/** Anthropic /v1/messages 的最小响应形状（只声明我们用到的字段） */
interface MessagesResponse {
    content?: { type: string; text?: string; id?: string; name?: string; input?: unknown }[];
    stop_reason?: string;
    usage?: {
        input_tokens?: number;
        output_tokens?: number;
        /** 提示缓存命中/写入的输入 token（9/15 批 C：只读出来记账，不参与请求构造） */
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
    };
}

// ============================================================
// 原生 tool_use：工具描述转换（ToolParamSpec → Anthropic JSON Schema）
// ============================================================

/** registry.ts 的 ToolParamSpec 的结构形状（结构化声明，不引入硬依赖） */
export interface ToolParamSpecLike {
    type: string;
    required: boolean;
    description: string;
}

/** ToolRegistry.describe() 产出的工具描述 */
export interface ToolDescriptorLike {
    name: string;
    description: string;
    parameters: Record<string, ToolParamSpecLike>;
}

/**
 * 把我们的工具描述转成 Anthropic 原生 tools 数组。
 * 机械转换，无智能：type 直传（string/number/boolean/array/object 都是合法 JSON Schema 类型），
 * required 取并集，description 原样带过去。
 */
export function toAnthropicTools(tools: ToolDescriptorLike[]): unknown[] {
    return tools.map((t) => {
        const properties: Record<string, { type: string; description: string }> = {};
        const required: string[] = [];
        for (const [key, spec] of Object.entries(t.parameters ?? {})) {
            properties[key] = { type: spec.type || "string", description: spec.description ?? "" };
            if (spec.required) required.push(key);
        }
        return {
            name: t.name,
            description: t.description ?? "",
            input_schema: { type: "object", properties, required },
        };
    });
}

/**
 * Anthropic 响应 → 决策对象（保持与 coerceDecision 的扁平协议一致）。
 *
 * 规则（按优先级）：
 *   ① 有 tool_use 块 →
 *      · 恰好一个 → {kind:'tool', tool, args, note}
 *      · 多个 → 全是只读工具（inspectTree/readFile/search/gitDiff）时打包成
 *        {kind:'batch', calls:[...]}（③并行：一次并发执行，省往返）；
 *        只要混进任何一个非只读工具 → 整包降级只取第一个，note 留警告
 *        （"写/执行一轮一个"的记账语义是结构保证，不能靠模型自觉）；
 *   ② 没工具 + stop_reason=max_tokens → 返回原文（截断的决策不可信，
 *      交给 coerceDecision 判失败，按一步计费——与旧协议同语义）
 *   ③ 没工具 + 正常结束 → {kind:'done', note:文本}
 *      （模型"不再调用工具"就是自然完成信号）
 */
export function fromAnthropicContent(
    content: MessagesResponse["content"],
    stopReason: string,
): unknown {
    const blocks = content ?? [];
    const text = blocks
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("")
        .trim();

    const toolUses = blocks.filter((b) => b.type === "tool_use" && typeof b.name === "string");

    if (toolUses.length > 0) {
        const toCall = (name: string, input: unknown) => ({
            tool: name,
            args: input && typeof input === "object" && !Array.isArray(input)
                ? input as Record<string, unknown>
                : {},
        });
        if (toolUses.length === 1) {
            const b = toolUses[0]!;
            return { kind: "tool", ...toCall(b.name as string, b.input), note: text };
        }
        // 多个 tool_use：只读批处理，否则降级取第一个（警告留痕）
        if (toolUses.every((b) => typeof b.name === "string" && READONLY_BATCH_TOOLS.has(b.name))) {
            return { kind: "batch", calls: toolUses.map((b) => toCall(b.name as string, b.input)), note: text };
        }
        const first = toolUses[0]!;
        return {
            kind: "tool", ...toCall(first.name as string, first.input),
            note: `${text} [警告：本轮收到 ${toolUses.length} 个 tool_use 且含非只读工具，只执行第一个]`,
        };
    }

    if (stopReason === "max_tokens") {
        // 截断：决策不可信。返回原文，让 coerceDecision 判 null → 按一步失败计费。
        return text || "(输出被 max_tokens 截断，无文本)";
    }

    return { kind: "done", note: text };
}

/** 允许一次并发的只读工具白名单（与 tools/registry.ts READONLY_TOOL_NAMES 同源语义） */
const READONLY_BATCH_TOOLS: ReadonlySet<string> = new Set([
    "inspectTree", "readFile", "search", "gitDiff",
]);

// ============================================================
// 旧协议（文本 JSON 决策）—— 保底路径，行为与 9/14 前一致
// ============================================================

/**
 * 输出协议：拼在 system 尾部，约束模型每轮只回一个 JSON 决策。
 * ⚠️ 形状必须与 graph.ts coerceDecision 一致：**扁平结构**（tool/args 在顶层），
 * 不是嵌套在 call 里——9/12 冒烟第一跑就是被这里的嵌套写法坑死的（Fake 全是扁平所以没暴露）。
 */
const DECISION_PROTOCOL = `
# 输出协议（最高优先级，覆盖其他格式偏好）
你每一次回复只输出一个 JSON 对象，不要 markdown 代码块、不要任何多余文字。形状二选一：
{"kind":"tool","tool":"<工具名>","args":{...},"note":"<一句话说明>"}
{"kind":"done","note":"<为什么本轮工作完成>"}`;

/** 原生模式下的协议说明（工具走 API 原生字段，这里只讲"怎么表达完成"） */
const NATIVE_PROTOCOL = `
# 输出协议（最高优先级，覆盖其他格式偏好）
你有原生工具可用。规则：
1. 要执行动作时，**直接调用工具**，不要用文字描述你要调用什么；
2. 允许一次调用**多个只读工具**（inspectTree / readFile / search / gitDiff）——
   比如同时读多个文件、又搜又读，一并发出来更快；
   **写盘、执行命令、子 Agent 每轮仍然最多一个**；
3. 当本轮工作确实完成、无需再调用任何工具时，直接用文字说明完成情况即可——
   不调用工具 就是完成信号；
4. 不要为了"确认"而重复调用已经成功过的工具。`;

/**
 * 从模型文本里抠出 JSON 对象：整串直解 → 逐个平衡括号扫描候选对象。
 * 扫描感知字符串/转义（"{}" 在字符串里不算嵌套），叙述文字里混的花括号、
 * 多个候选对象、围栏输出都能处理；返回**第一个可解析**的对象，全失败返回 null。
 */
export function extractJson(text: string): unknown {
    const t = text.trim();
    try { return JSON.parse(t); } catch { /* 继续扫 */ }

    // 剥掉 ```/```json 围栏后再扫（围栏本身就是干扰字符）
    const body = t.startsWith("```") ? t.replace(/```/g, "") : t;

    for (let i = body.indexOf("{"); i >= 0; i = body.indexOf("{", i + 1)) {
        let depth = 0;
        let inStr = false;
        let esc = false;
        for (let j = i; j < body.length; j++) {
            const ch = body[j];
            if (inStr) {
                if (esc) esc = false;
                else if (ch === "\\") esc = true;
                else if (ch === '"') inStr = false;
                continue;
            }
            if (ch === '"') inStr = true;
            else if (ch === "{") depth++;
            else if (ch === "}") {
                depth--;
                if (depth === 0) {
                    // 候选对象 [i..j]：能解析就是它；不能就继续找下一个 "{" 起点
                    try { return JSON.parse(body.slice(i, j + 1)); } catch { break; }
                }
            }
        }
    }
    return null;
}

// ============================================================
// 适配器主体
// ============================================================

// ---------- 9/15 批 C：重试退避 / 升档（纯函数，与模型无关） ----------

/**
 * 可重试的 HTTP 状态码。
 * 判定表对齐 cc `claude-code-source/src/services/api/withRetry.ts:696-786`（shouldRetry）：
 *   408 请求超时 / 409 锁冲突 / 429 限流 / >=500 服务端错误 → 可重试；
 *   400（请求本身不合法）/ 401 / 403（凭证不对）/ 404（端点或模型名错）→ **不重试**：
 *   这类错重发一百次还是同一个错，只会把失败拖慢。
 * 网络层异常（fetch 直接 reject：连接重置 / DNS 失败 / 超时中止）由调用点兜底，一律可重试
 * （cc 同款：`APIConnectionError → true`）。
 */
export function isRetryableStatus(status: number): boolean {
    return status === 408 || status === 409 || status === 429 || status >= 500;
}

/** 退避首档（毫秒）；对齐 dsh `llm/llm/src/retry-policy.ts:15` 与 cc `withRetry.ts:55` 的 500 */
export const RETRY_INITIAL_DELAY_MS = 500;
/** 单次退避上限；dsh `retry-policy.ts:16` 是 10s，我们取 8s（乘数只有 ×2、档数少，够用且更保守） */
export const RETRY_MAX_DELAY_MS = 8_000;
/** 对称抖动比例；对齐 dsh `retry-policy.ts:17`（cc 是只加不减的 25%，dsh 双侧更均匀，我们跟 dsh） */
export const RETRY_JITTER_RATIO = 0.1;
/** 瞬时故障重试次数上限（首次之后最多再发 2 次，共 3 次请求）。 */
export const RETRY_MAX_RETRIES = 2;
/** 服务端 `Retry-After` 的采纳上限；对齐 opencode `session/retry.ts:29` 的 30_000（防服务端给个 3600 把任务挂死） */
export const RETRY_AFTER_MAX_MS = 30_000;
/** max_tokens 截断后的升档值。cc `utils/context.ts:24-25` 是 8000→64000；
 *  我们 8192→32768，因为 32768 是本仓库真机跑过的档位（`live/architect-cli.ts:78`） */
export const ESCALATED_MAX_TOKENS = 32_768;

/**
 * 第 retry 次重试前的等待毫秒数（retry 从 1 起算）。
 * 公式对齐 dsh `llm/llm-retry/src/index.ts:61-63`：指数退避 × **对称**抖动——
 *   exponential = min(initial × 2^(retry-1), max)
 *   jitter      = 1 − r + 2r·random()        → 落在 [1−r, 1+r] 双侧
 *   return min(exponential × jitter, max)
 * 对称（可早可晚）避免"同批请求整点重放"；末位再兜一次上限，保证最坏情况可控。
 * random 可注入 → 测试用固定序列断言边界，生产用 Math.random。
 */
export function retryDelayMs(
    retry: number,
    random: () => number = Math.random,
    initialDelayMs: number = RETRY_INITIAL_DELAY_MS,
): number {
    const exponent = Math.min(Math.max(retry - 1, 0), 16);   // 防爆指数（dsh 同款 clamp）
    const exponential = Math.min(initialDelayMs * 2 ** exponent, RETRY_MAX_DELAY_MS);
    const jitter = 1 - RETRY_JITTER_RATIO + 2 * RETRY_JITTER_RATIO * random();
    return Math.min(exponential * jitter, RETRY_MAX_DELAY_MS);
}

/**
 * 解析 `Retry-After` 响应头（RFC 7231：秒数或 HTTP-date），解析不出返回 null。
 * 读头不写语义、纯协议层，与模型无关。
 */
export function parseRetryAfterMs(headers: Headers): number | null {
    const raw = headers.get("retry-after");
    if (!raw) return null;
    const secs = Number(raw.trim());
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, RETRY_AFTER_MAX_MS);
    const at = Date.parse(raw);
    if (!Number.isNaN(at)) return Math.min(Math.max(at - Date.now(), 0), RETRY_AFTER_MAX_MS);
    return null;
}

/** 退避等待（不参与任何超时口径：超时是"单次请求"的，退避是"两次请求之间"的） */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createRealLlm(opts: RealLlmOptions = {}): DeveloperLlm {
    const baseUrl = (opts.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? "").replace(/\/+$/, "");
    const authToken = opts.authToken ?? process.env.ANTHROPIC_AUTH_TOKEN ?? "";
    const model = opts.model ?? process.env.DEVELOPER_LLM_MODEL ?? "qwen3.8-flash";
    // 9/12 T1 实弹教训：qwen3.8-flash 会先吐大段分析文字再出 JSON，2048 经常死在
    // JSON 之前（stop=max_tokens → 决策丢失 → 白烧 45s/次）。抬到 8192 留足推理余量。
    const maxTokens = opts.maxTokens ?? 8192;
    // T3b 实弹教训：偶发一次 >120s 的慢响应会把整个任务打死（见 graph.ts 的配套修复），
    // 超时抬到 240s；再配合 runToolLoop 的单步容错，慢不再等于死。
    const timeoutMs = opts.timeoutMs ?? 240_000;
    // 原生 tool_use 开关：显式选项优先，其次 env，缺省开。
    const native = opts.nativeTools ?? (process.env.DEVELOPER_LLM_NATIVE_TOOLS !== "0");
    // 9/15 批 C：瞬时故障重试次数 / max_tokens 升档开关（可关，缺省开）。
    const maxRetries = opts.maxRetries ?? RETRY_MAX_RETRIES;
    const escalateOnMaxTokens = opts.escalateOnMaxTokens ?? true;
    const retryInitialDelayMs = opts.retryInitialDelayMs ?? RETRY_INITIAL_DELAY_MS;

    if (!baseUrl) throw new Error("realLlm：缺 ANTHROPIC_BASE_URL（端点未配置）");
    if (!authToken) throw new Error("realLlm：缺 ANTHROPIC_AUTH_TOKEN（token 未配置）");

    let calls = 0;

    return {
        id: `real:${model}@${baseUrl}${native ? ":tools" : ":json"}`,

        calls: () => calls,

        async next(input) {
            calls++;
            const startedAt = Date.now();

            const tools = (input.tools ?? []) as ToolDescriptorLike[];

            // 上下文一律拼进一条 user 消息（不做多轮 messages 回放：
            // 决策历史以 JSON 形式整体塞给模型，无状态可重放）。
            // 原生模式下工具走 tools 字段，不再往文本里塞工具清单（省 token、免二义）；
            // 旧模式保持原样（工具清单进文本）。
            const user = [
                `## 任务\n${input.task}`,
                input.skill ? `## 当前技能指引\n${input.skill}` : "",
                !native && tools.length > 0 ? `## 可用工具\n${JSON.stringify(tools, null, 0)}` : "",
                `## 已执行步骤（按时间顺序，最后一条是上一步结果）\n${JSON.stringify(input.history)}`,
                native
                    ? `请根据以上信息，给出下一步动作（要动手就调用工具；全部完成就直接说明）。`
                    : `请根据以上信息，给出下一步动作。只输出一个 JSON 对象。`,
            ].filter(Boolean).join("\n\n");

            const systemText = input.system + "\n" + (native ? NATIVE_PROTOCOL : DECISION_PROTOCOL);

            /**
             * 单次 HTTP 尝试（不含重试）。不抛错，把"能不能重试"和"服务端要求的等待"
             * 一并带出来交给重试环决策——分类逻辑与发送逻辑分开，才好单测。
             */
            const postOnce = async (cap: number): Promise<
                | { ok: true; data: MessagesResponse }
                | { ok: false; error: Error; retryable: boolean; retryAfterMs: number | null }
            > => {
                const body: Record<string, unknown> = {
                    model,
                    max_tokens: cap,
                    system: systemText,
                    messages: [{ role: "user", content: user }],
                };
                if (native && tools.length > 0) {
                    body["tools"] = toAnthropicTools(tools);
                    // ③并行：放开 disable_parallel_tool_use。记账语义由两道结构保证——
                    //   · fromAnthropicContent 把"多 tool_use"收窄为【全只读批 or 降级取一】；
                    //   · graph 的 runToolLoop 把一个 batch 当**一步**记账（1 次 API 调用
                    //     仍然只对应一条 llm_call_planned 台账），批内并发执行。
                    // 混入非只读工具的批次会在解析层降级，"写/执行一轮一个"不受影响。
                    body["tool_choice"] = { type: "auto" };
                }
                try {
                    const res = await fetch(`${baseUrl}/v1/messages`, {
                        method: "POST",
                        headers: {
                            "content-type": "application/json",
                            "authorization": `Bearer ${authToken}`,
                            "anthropic-version": "2023-06-01",
                        },
                        body: JSON.stringify(body),
                        signal: AbortSignal.timeout(timeoutMs),
                    });
                    if (!res.ok) {
                        // 抛错前先读 body：把网关错误原文带出来，方便定位（限流/余额/模型名错）
                        const errBody = await res.text().catch(() => "");
                        return {
                            ok: false,
                            error: new Error(`realLlm：HTTP ${res.status} ${errBody.slice(0, 500)}`),
                            retryable: isRetryableStatus(res.status),
                            retryAfterMs: parseRetryAfterMs(res.headers),
                        };
                    }
                    return { ok: true, data: await res.json() as MessagesResponse };
                } catch (e) {
                    // 网络层异常（连接重置 / DNS 失败 / 超时中止）和畸形响应体：一律可重试
                    // （cc 同款：APIConnectionError → true；dsh 同款：TRANSPORT / TIMEOUT 在名单里）。
                    // 唯一例外由下面的总预算兜住——超时已经烧掉整整一个 timeoutMs，重试没预算了。
                    return { ok: false, error: e as Error, retryable: true, retryAfterMs: null };
                }
            };

            /**
             * 带退避重试的发送：**同一步内部**最多再发 maxRetries 次。
             * 总时长预算 = 单次 timeoutMs，即"这一步最多花单次超时的两倍时间"。
             * 有意为之的推论：**超时类失败不会被重试**——第一次就烧掉 240s 时，
             * 再等一拍就越预算，立刻把错误交回 graph 层走它的按步容错；
             * 免得一个步骤卡成十几分钟（T3b 教训：慢 ≠ 死，但慢到底会拖死整个任务）。
             */
            const send = async (cap: number): Promise<{ data: MessagesResponse; attempts: number }> => {
                let lastError = new Error("realLlm：未知失败（没有产生任何错误对象）");
                let attempts = 0;
                for (let i = 0; ; i++) {
                    attempts++;
                    const r = await postOnce(cap);
                    if (r.ok) return { data: r.data, attempts };
                    lastError = r.error;
                    if (!r.retryable || i >= maxRetries) break;
                    const waitMs = r.retryAfterMs ?? retryDelayMs(i + 1, Math.random, retryInitialDelayMs);
                    // 越预算 → 不试了（`>=`：服务端给 retry-after:0 又恰好卡着预算时
                    // 也不能再试——那一发最多再等一个 timeoutMs，白等）
                    if (Date.now() - startedAt + waitMs >= timeoutMs) break;
                    await sleep(waitMs);
                }
                throw lastError;
            };

            // 重试/升档会发多次请求，账要合起来报：onCall 每次 next() **只报一次**，
            // attempts 说明背后实际发了几发，token 数值是这一步的真实总消耗（计费口径）。
            let attemptsTotal = 0;
            let inputTokens = 0;
            let outputTokens = 0;
            let cacheReadTokens = 0;
            let cacheCreationTokens = 0;
            const accumulate = (d: MessagesResponse): void => {
                inputTokens += d.usage?.input_tokens ?? 0;
                outputTokens += d.usage?.output_tokens ?? 0;
                cacheReadTokens += d.usage?.cache_read_input_tokens ?? 0;
                cacheCreationTokens += d.usage?.cache_creation_input_tokens ?? 0;
            };

            let sent = await send(maxTokens);
            attemptsTotal += sent.attempts;
            accumulate(sent.data);
            let escalated = false;

            // 9/15 批 C：max_tokens 截断 → 升档重发同一份请求（cc utils/context.ts:24-25
            // 的 8000→64000 同款结构；cc 那边只升一次，我们也只升一次，不反复抬价）。
            // 守卫对齐 cc query.ts:1199-1201 的 maxOutputTokensOverride === undefined：
            // 调用方**显式**给了 maxTokens 就是明确意图，适配器不擅自突破。
            //
            // 注意这里**有意**不走上面的时长预算：它不是"赌这次能成"的重试，而是对
            // 已知条件的确定性补救——截断说明模型的推理就是塞不进 8192，原样重发一百次
            // 还是截断（graph 层下一轮也用同一个上限，会一直失败）。不补这一下，
            // "模型话多"就变成永久性失败；补了最多多花一次请求。
            if (sent.data.stop_reason === "max_tokens" && escalateOnMaxTokens && opts.maxTokens === undefined) {
                escalated = true;
                sent = await send(ESCALATED_MAX_TOKENS);
                attemptsTotal += sent.attempts;
                accumulate(sent.data);
            }

            const data = sent.data;
            const rawText = (data.content ?? [])
                .filter((b) => b.type === "text" && b.text)
                .map((b) => b.text)
                .join("");

            opts.onCall?.({
                seq: calls,
                latencyMs: Date.now() - startedAt,   // 一步的总墙钟（含退避等待与升档重发）
                inputTokens,
                outputTokens,
                stopReason: data.stop_reason ?? "?",
                rawText,
                mode: native ? "native" : "text",
                cacheReadTokens,
                cacheCreationTokens,
                attempts: attemptsTotal,
                escalated,
            });

            // 原生模式：tool_use 块直接出决策；旧模式：文本抠 JSON。
            // 两条路都可能返回"原文"，交给 coerceDecision 兜底判失败（按一步计费）。
            return native
                ? fromAnthropicContent(data.content, data.stop_reason ?? "")
                : (extractJson(rawText) ?? rawText);
        },
    };
}
