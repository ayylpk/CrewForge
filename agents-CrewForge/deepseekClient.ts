import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { requestJson } from "./httpClient.ts";

interface DirectDeepSeekOptions {
    model: string;
    timeout?: number;
    thinking?: { type: string };
    baseUrl?: string;
    // Kept for source compatibility with existing Agent constructors. The
    // production path now uses the owned undici Client below.
    configuration?: { fetch?: typeof fetch };
}

interface InvokeOptions {
    signal?: AbortSignal;
}

interface JsonSchema<T> {
    parse(value: unknown): T;
}

function messageRole(message: BaseMessage): "system" | "user" | "assistant" {
    const type = message.getType();
    if (type === "system") return "system";
    if (type === "ai") return "assistant";
    return "user";
}

function textContent(content: BaseMessage["content"]): string {
    return typeof content === "string" ? content : JSON.stringify(content);
}

function parseJsonContent(content: string): unknown {
    try {
        return JSON.parse(content);
    } catch {
        const start = content.indexOf("{");
        if (start < 0) throw new Error("模型没有返回 JSON 对象");

        let depth = 0;
        for (let index = start; index < content.length; index++) {
            if (content[index] === "{") depth++;
            else if (content[index] === "}") {
                depth--;
                if (depth === 0) return JSON.parse(content.slice(start, index + 1));
            }
        }
        throw new Error("模型返回的 JSON 不完整");
    }
}

export class DirectChatDeepSeek {
    private readonly model: string;
    private readonly thinking?: { type: string };
    private readonly origin: string;
    private readonly timeoutMs: number;

    constructor(options: DirectDeepSeekOptions) {
        this.model = options.model;
        this.thinking = options.thinking;
        this.origin = new URL(options.baseUrl ?? "https://api.deepseek.com").origin;
        this.timeoutMs = options.timeout ?? 120_000;
    }

    async invoke(messages: BaseMessage[], options: InvokeOptions = {}): Promise<AIMessage> {
        const content = await this.request(messages, options, false);
        return new AIMessage(content);
    }

    withStructuredOutput<T>(schema: JsonSchema<T>, _options?: unknown): { invoke: (messages: BaseMessage[], options?: InvokeOptions) => Promise<T> } {
        return {
            invoke: async (messages, options = {}) => schema.parse(parseJsonContent(await this.request(messages, options, true))),
        };
    }

    private async request(messages: BaseMessage[], options: InvokeOptions, jsonMode: boolean): Promise<string> {
        const apiKey = process.env.DEEPSEEK_API_KEY;
        if (!apiKey) throw new Error("未设置 DEEPSEEK_API_KEY");

        const response = await requestJson<{
            choices?: Array<{ message?: { content?: string } }>;
            error?: { message?: string };
        }>(this.origin, "/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: this.model,
                messages: messages.map(message => ({ role: messageRole(message), content: textContent(message.content) })),
                ...(this.thinking ? { thinking: this.thinking } : {}),
                ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
            }),
            timeoutMs: this.timeoutMs,
            signal: options.signal,
        });

        const payload = response.body;
        if (response.statusCode < 200 || response.statusCode >= 300) {
            throw new Error(`DeepSeek HTTP ${response.statusCode}: ${payload.error?.message ?? "未知错误"}`);
        }

        const content = payload.choices?.[0]?.message?.content;
        if (typeof content !== "string" || content.length === 0) throw new Error("DeepSeek 响应缺少 choices[0].message.content");
        return content;
    }
}
