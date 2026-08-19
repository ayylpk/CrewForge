// langchainClient.ts — LangChain ChatDeepSeek 包装（实验用组合：bun/node + langchain 自带请求）
// 与 DirectChatDeepSeek 保持相同表面（invoke / withStructuredOutput），
// 由 modelRegistry 根据 CREWFORGE_LLM_IMPL=langchain 选用。
import { ChatDeepSeek } from "@langchain/deepseek";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";

export class LangChainDeepSeek {
    private readonly model: ChatDeepSeek;

    constructor(options: {
        model: string;
        apiKey?: string;
        temperature?: number;
        timeout?: number;
        thinking?: { type: string };
        baseUrl?: string;
    }) {
        const config: Record<string, unknown> = {
            model: options.model,
            apiKey: options.apiKey ?? process.env.DEEPSEEK_API_KEY ?? "",
            temperature: options.temperature,
            timeout: options.timeout,
        };
        // repro-hub-timeout.ts 里的旧用法：thinking 直接透传（DeepSeek 非标准字段，SDK 类型没声明）
        if (options.thinking) config.thinking = options.thinking;
        // mock 覆盖：ChatDeepSeek 的 OpenAI 兼容配置里指定 baseURL
        if (options.baseUrl) config.configuration = { baseURL: options.baseUrl };
        this.model = new ChatDeepSeek(config as never);
    }

    async invoke(messages: BaseMessage[], options: { signal?: AbortSignal } = {}): Promise<AIMessage> {
        const response = await this.model.invoke(messages, { signal: options.signal });
        return response instanceof AIMessage ? response : new AIMessage(response.content);
    }

    withStructuredOutput<T>(schema: { parse(value: unknown): T }, options?: unknown): {
        invoke: (messages: BaseMessage[], options?: { signal?: AbortSignal }) => Promise<T>;
    } {
        // options 必须原样转发：流水线传 { method: "jsonMode", name: "..." }，
        // 不转发会走默认 functionCalling（deepseek-v4-flash 不支持 tool_choice，实测 invalid_request_error）
        const structured = this.model.withStructuredOutput(schema as never, options as never);
        return {
            invoke: async (messages, options = {}) =>
                (await structured.invoke(messages, { signal: options.signal })) as T,
        };
    }
}
