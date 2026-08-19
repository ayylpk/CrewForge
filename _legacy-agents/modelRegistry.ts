import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DirectChatDeepSeek } from "./deepseekClient.ts";
import { LangChainDeepSeek } from "./langchainClient.ts";

export type ModelProfileName = "planning" | "backend" | "frontend" | "review";

// 模型客户端统一接口：invoke / withStructuredOutput（DirectChatDeepSeek 与 LangChainDeepSeek 都满足）
export interface ModelClient {
    invoke(messages: import("@langchain/core/messages").BaseMessage[], options?: { signal?: AbortSignal }):
        Promise<import("@langchain/core/messages").AIMessage>;
    withStructuredOutput<T>(schema: { parse(value: unknown): T }, options?: unknown): {
        invoke(messages: import("@langchain/core/messages").BaseMessage[], options?: { signal?: AbortSignal }): Promise<T>;
    };
}

interface ModelProfileConfig {
    provider: "deepseek";
    model: string;
    apiKeyEnv: string;
    temperature?: number;
    thinking?: "disabled";
    clientTimeoutMs: number;
    requestTimeoutMs: number;
}

interface ModelsFile {
    profiles: Record<ModelProfileName, ModelProfileConfig>;
}

function findConfigPath(): string {
    const candidates = [
        process.env.CREWFORGE_MODELS_FILE,
        path.resolve(process.cwd(), "models.json"),
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), "models.json"),
    ].filter((candidate): candidate is string => Boolean(candidate));

    const configPath = candidates.find(candidate => fs.existsSync(candidate));
    if (!configPath) {
        throw new Error(`找不到模型配置文件。已检查：${candidates.join("、")}`);
    }
    return configPath;
}

function readConfig(): ModelsFile {
    const configPath = findConfigPath();
    let parsed: unknown;
    try {
        parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (error) {
        throw new Error(`模型配置文件无法解析：${configPath}；${(error as Error).message}`);
    }

    if (!parsed || typeof parsed !== "object" || !("profiles" in parsed)) {
        throw new Error(`模型配置文件缺少 profiles：${configPath}`);
    }

    const profiles = (parsed as { profiles?: unknown }).profiles;
    const required: ModelProfileName[] = ["planning", "backend", "frontend", "review"];
    if (!profiles || typeof profiles !== "object" || required.some(name => !(name in profiles))) {
        throw new Error("模型配置必须包含 planning、backend、frontend、review 四个 profile");
    }

    for (const name of required) {
        const profile = (profiles as Record<string, ModelProfileConfig>)[name];
        if (profile.provider !== "deepseek" || !profile.model || !profile.apiKeyEnv) {
            throw new Error(`模型 profile ${name} 配置不完整`);
        }
        if (!process.env[profile.apiKeyEnv]) {
            throw new Error(`模型 profile ${name} 所需环境变量未设置：${profile.apiKeyEnv}`);
        }
        if (!Number.isFinite(profile.clientTimeoutMs) || profile.clientTimeoutMs <= 0 ||
            !Number.isFinite(profile.requestTimeoutMs) || profile.requestTimeoutMs <= 0) {
            throw new Error(`模型 profile ${name} 的超时配置必须为正数`);
        }
    }

    return { profiles: profiles as Record<ModelProfileName, ModelProfileConfig> };
}

class ModelRegistry {
    private readonly configs: ModelsFile;
    private readonly clients = new Map<ModelProfileName, ModelClient>();

    constructor() {
        this.configs = readConfig();

        // 默认 impl=langchain（LangChain ChatDeepSeek 自带请求，bun/node 通用）；
        // 设 CREWFORGE_LLM_IMPL=direct 切回自研 undici 直连（每请求独立 Client）。
        const impl = process.env.CREWFORGE_LLM_IMPL === "direct" ? "direct" : "langchain";

        // 启动时一次性创建本流水线的全部模型客户端；不在 Agent 节点中临时创建。
        for (const name of ["planning", "backend", "frontend", "review"] as const) {
            const config = this.configs.profiles[name];
            const options: Record<string, unknown> = {
                model: config.model,
                apiKey: process.env[config.apiKeyEnv],
                temperature: config.temperature,
                timeout: config.clientTimeoutMs,
                // 测试/复现用：CREWFORGE_LLM_BASE_URL 指向本地 mock 服务时覆盖默认端点
                ...(process.env.CREWFORGE_LLM_BASE_URL ? { baseUrl: process.env.CREWFORGE_LLM_BASE_URL } : {}),
            };
            if (config.thinking) options.thinking = { type: config.thinking };
            const client: ModelClient = impl === "langchain"
                ? new LangChainDeepSeek(options as Parameters<typeof LangChainDeepSeek.prototype.constructor>[0])
                : new DirectChatDeepSeek(options as {
                    model: string;
                    apiKey?: string;
                    temperature?: number;
                    timeout?: number;
                    thinking?: { type: string };
                    baseUrl?: string;
                });
            this.clients.set(name, client);
        }

        console.log(`[models] 已加载 ${this.clients.size} 个模型 profile（impl=${impl}）：${[...this.clients.keys()].join("、")}`);
    }

    get(name: ModelProfileName): ModelClient {
        const client = this.clients.get(name);
        if (!client) throw new Error(`未注册模型 profile：${name}`);
        return client;
    }

    requestTimeout(name: ModelProfileName): number {
        return this.configs.profiles[name].requestTimeoutMs;
    }
}

export const modelRegistry = new ModelRegistry();
export const getModel = (name: ModelProfileName): ModelClient => modelRegistry.get(name);
export const getModelRequestTimeout = (name: ModelProfileName): number => modelRegistry.requestTimeout(name);
