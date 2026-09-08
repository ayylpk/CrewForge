import { ChatDeepSeek } from "@langchain/deepseek"
import { ChatOpenAI } from "@langchain/openai"
import { parseTools, toDeclarations } from "./tools"
import { runtimeSettings } from "./settings"

// provider 注册表（cc-switch 式极简）：deepseek 保留因它吃 thinking 参数，其余一切
// OpenAI 兼容端点（Ollama/vLLM/各中转/Claude 兼容代理）由 openai 一肩挑——指哪打哪。
const MAPS: Record<string, any> = { "deepseek": initDeepSeek, "openai": initOpenAI };
enum MODE { thinking, no_thinking };

function parseMode(thinking: boolean): MODE {
    if (thinking) {
        return MODE.thinking;
    }

    return MODE.no_thinking;
}

function parseModel(provider: string): any {
    const initFn = MAPS[provider];
    if (!initFn) {
        throw new Error(`未知 provider "${provider}"（已注册：${Object.keys(MAPS).join("、")}）`);
    }
    return initFn;
}

function initDeepSeek(mode: MODE, data: any): ChatDeepSeek {

    const tools = parseTools(data.tools);
    // 设置页配了 key 就用它；没配则构造参数省略，langchain 内部回退 .env DEEPSEEK_API_KEY
    const key = data.apiKey ? { apiKey: data.apiKey } : {};

    if (mode == MODE.thinking) {
        return new ChatDeepSeek({
            model: data.model,
            thinking: { type: "enabled" },
            reasoning_effort: data.reasoning_effort,
            ...key,
        } as any);
    }

    const res = new ChatDeepSeek({
        model: data.model,
        temperature: data.temperature,
        maxTokens: data.maxTokens,
        timeout: data.timeout,
        topP: data.top_p,
        tools: toDeclarations(tools),
        thinking: { type: "disabled" },
        ...key,
    } as any)

    return res;
}

// OpenAI 兼容通用初始化：baseURL 指本地 Ollama 或任意中转即生效（阶段 2 验收"换 Ollama url 即指本地"）。
// apiKey：设置页有值用设置页，否则退回 .env DEEPSEEK_API_KEY（Ollama 本地可给个占位）。
function initOpenAI(mode: MODE, data: any): ChatOpenAI {
    const tools = parseTools(data.tools);
    return new ChatOpenAI({
        model: data.model,
        apiKey: data.apiKey || process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY || "not-needed",
        ...(data.baseURL ? { configuration: { baseURL: data.baseURL } } : {}),
        temperature: data.temperature,
        maxTokens: data.maxTokens,
        timeout: data.timeout,
        // OpenAI SDK 的 topP 键名与 deepseek 不同（用 topP 非 top_p），这里显式映射
        ...(data.top_p != null ? { topP: data.top_p } : {}),
        tools: toDeclarations(tools),
    } as any);
}

/**
 * 用 sys_settings（cc-switch 设置页写入的单行表）覆盖节点 JSON 里的模型三件套。
 * 优先级 sys_settings > 节点自带 JSON > .env（initXxx 内部兜底）。
 * 读不到配置（表空/未启动/DB 挂）→ 原样返回内置行为，绝不让引擎因配置层挂掉——旁路原则。
 */
function applyRuntime(data: any, role?: string, rt = runtimeSettings()): any {
    if (!rt) return data;                       // 还没读到 sys_settings：维持内置（旁路）

    const merged = { ...data };
    // 模型名：设置页一旦填了就全局覆盖
    if (rt.modelName) merged.model = rt.modelName;
    // T3 分层：pro 档角色且配了 pro 模型名 → 再顶一层（pro 名没配=退回全局名，不报错——渐进启用）
    const tier = resolveRoleTier(role, rt.roleModels);
    if (tier === "pro" && rt.modelPro) merged.model = rt.modelPro;
    // provider 判定：kind=openai 或填了自定义 url → 走 OpenAI 兼容；否则 deepseek 原生
    if (rt.modelKind === "openai" || (rt.modelUrl && rt.modelUrl.trim())) {
        merged.provider = "openai";
        if (rt.modelUrl) merged.baseURL = rt.modelUrl;
    } else {
        merged.provider = "deepseek";
    }
    // key：设置页有则带上（initOpenAI 用它；deepseek 分支下 langchain 仍读 .env，故仅 openai 注入到入参）
    if (rt.apiKey) merged.apiKey = rt.apiKey;
    return merged;
}

// ============================================================
// T3 模型分层双档（9/8）：角色 → 档位 → 模型名
//   sys_settings：model_pro（pro 档模型名，空=不启用分层）+ role_models（角色→档位 JSON 串，
//   VARCHAR 存文本防 F6 JSON 列 parse 三番坑；坏 JSON 回落内置表，旁路不炸）
//   内置档位表（卡面 9/3 拍板）：贵的器官（架构师/测试/前端）用 pro，便宜的（后端/伪代码/PM/契约）用 flash
//   预算（demo 档 pro×3 角色/轮 粗估 ¥8~20；省钱档全 flash ¥2~4——live 双档各跑一轮后校准进 README）
// ============================================================

export type RoleTier = "pro" | "flash";

export const DEFAULT_ROLE_TIERS: Record<string, RoleTier> = {
    architect: "pro", test: "pro", frontend: "pro",
    backend: "flash", pseudo: "flash", manager: "flash", contracts: "flash",
};

/** 角色 → 档位：sys_settings.role_models(JSON) > 内置表 > flash。role 缺省（DB 自定义节点没接线路）= null=不分层 */
export function resolveRoleTier(role: string | undefined | null, rawRoleModels: string | null): RoleTier | null {
    if (!role) return null;
    if (rawRoleModels) {
        try {
            const m = JSON.parse(rawRoleModels);
            if (m && typeof m === "object" && !Array.isArray(m)) {
                const v = (m as Record<string, unknown>)[role];
                if (v === "pro" || v === "flash") return v;
            }
        } catch { /* 坏 JSON=没配，回落内置表 */ }
    }
    return DEFAULT_ROLE_TIERS[role] ?? "flash";
}

/** 节点 JSON + 角色 → 生效配置对象（纯函数，导出供 role-tier-smoke 注入假 settings 验证） */
export function resolveModelConfig(Json: string, role?: string, rt = runtimeSettings()): any {
    return applyRuntime(JSON.parse(Json), role, rt);
}

/**
 * 统一模型入口。role=T3 分层角色名（architect/backend/frontend/pseudo/test/manager/contracts）；
 * 不传=全局名覆盖（老行为）。档位解析纯代码零 LLM（[[crewforge-code-over-tools]]）。
 */
export function initModels(Json: string, role?: string) {

    const data = applyRuntime(JSON.parse(Json), role);
    const mode = parseMode(data.thinking);
    const init = parseModel(data.provider ?? "deepseek");

    return init(mode, data);
}
