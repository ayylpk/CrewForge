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
//   · 一次 next() = 一次 HTTP 请求 = 一个决策。不做多轮对话，不做内部重试——
//     重试/预算由 graph 的 llmBudget + Ledger 预占计数统一管，这里再重试会双记账。
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
    /** 单次请求超时（毫秒）；超时=抛错，由上层按一步失败处理 */
    timeoutMs?: number;
    /**
     * 是否使用原生 tool_use（缺省 true，可用 env DEVELOPER_LLM_NATIVE_TOOLS=0 关闭）。
     * 关闭后回到"工具描述进文本、模型吐 JSON"的旧协议，行为与 9/14 前完全一致。
     */
    nativeTools?: boolean;
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
    }) => void;
}

/** Anthropic /v1/messages 的最小响应形状（只声明我们用到的字段） */
interface MessagesResponse {
    content?: { type: string; text?: string; id?: string; name?: string; input?: unknown }[];
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
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

            const body: Record<string, unknown> = {
                model,
                max_tokens: maxTokens,
                system: input.system + "\n" + (native ? NATIVE_PROTOCOL : DECISION_PROTOCOL),
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
                throw new Error(`realLlm：HTTP ${res.status} ${errBody.slice(0, 500)}`);
            }

            const data = await res.json() as MessagesResponse;
            const rawText = (data.content ?? [])
                .filter((b) => b.type === "text" && b.text)
                .map((b) => b.text)
                .join("");

            opts.onCall?.({
                seq: calls,
                latencyMs: Date.now() - startedAt,
                inputTokens: data.usage?.input_tokens ?? 0,
                outputTokens: data.usage?.output_tokens ?? 0,
                stopReason: data.stop_reason ?? "?",
                rawText,
                mode: native ? "native" : "text",
            });

            // 原生模式：tool_use 块直接出决策；旧模式：文本抠 JSON。
            // 两条路都可能返回"原文"，交给 coerceDecision 兜底判失败（按一步计费）。
            return native
                ? fromAnthropicContent(data.content, data.stop_reason ?? "")
                : (extractJson(rawText) ?? rawText);
        },
    };
}
