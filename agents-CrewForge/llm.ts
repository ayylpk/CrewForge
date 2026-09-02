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

/** 带超时的模型调用：超时先 abort 底层请求，再以明确错误拒绝（不是只挂个 race 就完事） */
export async function invokeWithTimeout<T>(
    label: string,
    ms: number,
    fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
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
}

/** 结构化输出失败带反馈重试：把上次校验错误拼进下次 prompt，让模型自纠错 */
export async function retryStructured<T>(
    label: string,
    call: (feedback: string, signal?: AbortSignal) => Promise<T>,
    opts?: { timeoutMs?: number; retries?: number },
): Promise<T> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const retries = opts?.retries ?? DEFAULT_RETRIES;
    let feedback = "";
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await invokeWithTimeout(label, timeoutMs, sig => call(feedback, sig));
        } catch (error) {
            const message = (error as Error).message;
            console.log(`${label} LLM 失败（第 ${attempt} 次）：${message.slice(0, 100)}`);
            if (attempt === retries) throw error;
            feedback =
                `\n\n## 上次输出校验失败，必须根据以下错误修正后重新输出（只输出合法 JSON，不要 Markdown 或说明）\n` +
                message.slice(0, 400);
        }
    }
    throw new Error(`${label} 重试耗尽`);
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
