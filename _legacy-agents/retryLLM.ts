// retryLLM.ts — 结构化 LLM 调用：校验失败时带错误反馈重试
// 模型（尤其 flash 系列）偶发输出不合规 JSON/不符合 schema；只重复同一 prompt 重试，
// 模型往往会犯同样的错。把上一次的校验错误拼进重试 prompt，让模型自纠错，重试成功率显著提高。
// 成本：正常路径（首次即成功）零额外调用；只有失败才多花一次。
import { llmWithTimeout } from "./Hub.ts";

export async function retryLLM<T>(
    label: string,
    timeoutMs: number,
    attempts: number,
    call: (feedback: string, signal?: AbortSignal) => Promise<T>,
): Promise<T> {
    let feedback = "";
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await llmWithTimeout(
                signal => call(feedback, signal),
                timeoutMs,
                label,
            );
        } catch (error) {
            const message = (error as Error).message;
            console.log(`${label} LLM 失败（第 ${attempt} 次）：${message.slice(0, 100)}`);
            if (attempt === attempts) throw error;
            feedback =
                `\n\n## 上次输出校验失败，必须根据以下错误修正后重新输出（只输出合法 JSON，不要 Markdown 或说明）\n` +
                message.slice(0, 400);
        }
    }
    throw new Error(`${label} 重试耗尽`);
}
