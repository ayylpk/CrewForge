// ============================================================
// llm.ts —— LLM 调用统一封装（模板用，够用即可）
//
// 优化（本会话经验沉淀）：
//   1. invokeWithTimeout —— 所有模型调用带超时 + AbortSignal 取消（防止请求永久挂起）
//   2. retryStructured —— 结构化输出失败带错误反馈重试（模型自纠错，正常路径零额外调用）
//   3. DEFAULT_TIMEOUT_MS / DEFAULT_RETRIES —— 统一的超时/重试旋钮
// ============================================================

import { SystemMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { initModels } from "./models";
import { gate } from "./concurrency";

/** 默认模型配置（没有 DEEPSEEK_API_KEY 环境变量时用不了，模板不管） */
export const DEFAULT_MODEL_JSON = JSON.stringify({
    provider: "deepseek",
    model: "deepseek-v4-flash",
    temperature: 0.7,
    thinking: false,
});

/** 单次模型调用的超时上限（毫秒）。超时后 abort 底层请求，防止永久挂起
 *  9/2 实测：deepseek-v4-flash jsonMode 大 prompt 单次响应体要流 60~120s，180s 会误杀触发静默重试 → 放宽到 300s */
export const DEFAULT_TIMEOUT_MS = 300_000;

/** 结构化输出失败重试次数（含首次） */
export const DEFAULT_RETRIES = 3;

/** 简单调用：返回模型文本回复（不做结构化解析） */
export async function callLLM(
    prompt: string,
    opts?: { model?: string; human?: string; timeoutMs?: number },
): Promise<string> {
    const model = initModels(opts?.model || DEFAULT_MODEL_JSON);
    const messages: BaseMessage[] = [new SystemMessage(prompt)];
    if (opts?.human) messages.push(new HumanMessage(opts.human));
    const res = await invokeWithTimeout<BaseMessage>("LLM", opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS, sig => model.invoke(messages, { signal: sig }));
    return typeof res.content === "string" ? res.content : JSON.stringify(res.content);
}

/** 带超时的模型调用：超时先 abort 底层请求，再以明确错误拒绝（不是只挂个 race 就完事）。
 *  T7a（9/8）：全仓所有 LLM 调用都收口在这——最外层端点总闸（gate "llm"）就挂这里，
 *  一个改道管住架构师/PM/四阶段工位/测试全部角色。**排队时间不吃调用超时**：
 *  先 acquire 再开表（否则闸口排队会被误判成"模型慢"掐死，重蹈 9/2 超时误杀冤案的覆辙）。 */
export async function invokeWithTimeout<T>(
    label: string,
    ms: number,
    fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
    await gate("llm").acquire();
    try {
        const ctrl = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                ctrl.abort();
                reject(new Error(`${label} 超时 ${Math.round(ms / 1000)}s，已取消请求`));
            }, ms);
        });
        try {
            return await Promise.race([fn(ctrl.signal), timeout]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    } finally {
        gate("llm").release();
    }
}

/** 结构化输出失败的机器分类（不许把解析失败伪装成"需求不完整"） */
export type StructuredFailureCategory = "SPEC" | "OUTPUT_PARSE" | "TIMEOUT" | "TOOL";

export interface StructuredFailure {
    category: StructuredFailureCategory;
    /** 最后一次的错误原文（截断保存，进失败报告） */
    error: string;
    /** 模型原始输出（能拿到就留档；拿不到为 undefined） */
    raw: string | undefined;
    attempts: number;
    label: string;
}

/** 统一结构化调用结果：★ 失败是**返回值**，不是异常（阶段 1 提交 1） */
export type StructuredCallResult<T> =
    | { ok: true; value: T; attempts: number }
    | { ok: false; failure: StructuredFailure };

/** 类型化的结构化失败异常：冒泡到 runner 时必须被转成显式终态，不许让进程裸退 */
export class StructuredOutputFailure extends Error {
    readonly failure: StructuredFailure;
    constructor(f: StructuredFailure) {
        super(`[${f.category}] ${f.label} 结构化输出失败（${f.attempts} 次）：${f.error.slice(0, 200)}`);
        this.name = "StructuredOutputFailure";
        this.failure = f;
    }
}

export function classifyStructuredError(message: string): StructuredFailureCategory {
    if (/Failed to parse|OUTPUT_PARSING_FAILURE|Unexpected token|JSON Parse|SyntaxError/i.test(message)) return "OUTPUT_PARSE";
    if (/超时|timed? ?out|aborted|AbortError/i.test(message)) return "TIMEOUT";
    return "TOOL";
}

/**
 * 结构化调用（**永不抛**）：有界重试 + 第二次换策略（缩小输出）+ 结构化失败结果。
 *
 *   规矩（阶段 1）：
 *     · 第 1 次失败：原 schema 重试，把错误原文喂回去；
 *     · 第 2 次失败：**改策略**——要求缩小输出（最小字段 / 数组 ≤2 项 / 字符串 ≤80 字）；
 *     · 达到上限：返回 { ok:false, failure }，由调用方决定终态（绝不裸抛）。
 */
export async function retryStructuredResult<T>(
    label: string,
    call: (feedback: string, signal?: AbortSignal) => Promise<T>,
    opts?: { timeoutMs?: number; retries?: number },
): Promise<StructuredCallResult<T>> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const retries = Math.max(1, opts?.retries ?? DEFAULT_RETRIES);
    let feedback = "";
    let lastError = "";
    let lastRaw: string | undefined;
    let lastCategory: StructuredFailureCategory = "TOOL";

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const value = await invokeWithTimeout(label, timeoutMs, sig => call(feedback, sig));
            return { ok: true, value, attempts: attempt };
        } catch (error) {
            const message = (error as Error)?.message ?? String(error);
            const raw = (error as { llmOutput?: unknown })?.llmOutput;
            lastError = message;
            if (typeof raw === "string" && raw.length > 0) lastRaw = raw.slice(0, 4000);
            lastCategory = classifyStructuredError(message);
            console.warn(`${label} LLM 失败（第 ${attempt}/${retries} 次，${lastCategory}）：${message.slice(0, 140)}`);
            if (attempt >= retries) break;
            feedback = attempt === 1
                ? `\n\n## 上次输出校验失败，必须根据以下错误修正后重新输出（只输出合法 JSON，不要 Markdown 或说明）\n${message.slice(0, 400)}`
                : `\n\n## 连续两次校验失败：**改为缩小输出**——只填最小必需字段，数组最多 2 项，每个字符串不超过 80 字，不要嵌套不必要的对象，不要任何解释文字。上次错误：\n${message.slice(0, 400)}`;
        }
    }
    return {
        ok: false,
        failure: { category: lastCategory, error: lastError.slice(0, 2000), raw: lastRaw, attempts: retries, label },
    };
}

/** 结构化输出失败带反馈重试（**会抛** StructuredOutputFailure）：保留给已有调用点，语义不变 */
export async function retryStructured<T>(
    label: string,
    call: (feedback: string, signal?: AbortSignal) => Promise<T>,
    opts?: { timeoutMs?: number; retries?: number },
): Promise<T> {
    const res = await retryStructuredResult<T>(label, call, opts);
    if (!res.ok) throw new StructuredOutputFailure(res.failure);
    return res.value;
}

/** 从回复文本里抠出合法 JSON（模型常把 JSON 夹在文字里） */
export function extractJson(content: unknown): any {
    const text = typeof content === "string" ? content : JSON.stringify(content ?? "");
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("模型未返回 JSON");
    return JSON.parse(text.slice(start, end + 1));
}

/** 解析 JSON 数组字符串（tools 子步骤清单等） */
export function parseJsonArray(json: string | null | undefined): any[] {
    if (!json) return [];
    try {
        const parsed = JSON.parse(json);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}
