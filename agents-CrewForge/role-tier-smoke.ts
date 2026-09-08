// ============================================================
// role-tier-smoke.ts —— T3 模型分层冒烟（9/8，确定性层零 LLM 零 DB）
//
//   核心底线（优先级最高的断言）：**不配置=行为与 T3 前逐字节一致**（旁路原则）。
//   覆盖：①resolveRoleTier（内置表/自定义覆盖/坏 JSON/坏值/未知角色/无角色）
//         ②resolveModelConfig（settings=null 原样、全局名、pro 顶名、pro 缺名退回、
//           档位自定义、openai provider 判定与 key 注入——阶段 2 行为的回归位）
//   跑法：bun run role-tier-smoke.ts
// ============================================================

import { resolveRoleTier, resolveModelConfig, DEFAULT_ROLE_TIERS } from "./models";
import type { RtSettings } from "./settings";

let pass = 0, fail = 0;
function ok(cond: boolean, label: string, extra = "") {
    if (cond) { pass++; console.log(`  ✓ ${label}`); }
    else { fail++; console.log(`  ✗ ${label} ${extra}`); }
}

/** 造一份全字段 settings（防 RtSettings 加字段时这里静默漏） */
function rt(over: Partial<RtSettings> = {}): RtSettings {
    return {
        modelName: null, modelPro: null, roleModels: null, modelUrl: null, apiKey: null,
        modelKind: "deepseek", javaBaseUrl: "http://localhost:8080", confirmTimeoutMin: 30, smokeBuild: false,
        ...over,
    };
}

const BUILTIN = JSON.stringify({ provider: "deepseek", model: "deepseek-v4-flash", temperature: 0.1, thinking: false });

function main() {
    console.log("=== ① resolveRoleTier ===");
    ok(resolveRoleTier(undefined, null) === null, "无角色=不分层（DB 自定义节点老行为）");
    ok(resolveRoleTier("architect", null) === "pro" && resolveRoleTier("test", null) === "pro" && resolveRoleTier("frontend", null) === "pro",
        "内置表：架构师/测试/前端 pro");
    ok(resolveRoleTier("backend", null) === "flash" && resolveRoleTier("pseudo", null) === "flash" && resolveRoleTier("manager", null) === "flash",
        "内置表：后端/伪代码/PM flash");
    ok(resolveRoleTier("contracts", null) === "flash", "contracts 新角色有默认档");
    ok(resolveRoleTier("hub-unknown-role", null) === "flash", "未知角色回落 flash（不给脏值发贵的钱）");
    ok(resolveRoleTier("backend", '{"backend":"pro"}') === "pro", "settings 覆盖内置表");
    ok(resolveRoleTier("architect", '{"architect":"ultra"}') === "pro", "非法档位值忽略，回落内置");
    ok(resolveRoleTier("test", "{坏 JSON") === "pro", "坏 JSON=没配（旁路不炸）");
    ok(Object.keys(DEFAULT_ROLE_TIERS).length === 7, "档位表 7 角色（六器官+契约）");

    console.log("=== ② resolveModelConfig（旁路底线+分层生效） ===");
    const base = JSON.parse(BUILTIN);
    ok(JSON.stringify(resolveModelConfig(BUILTIN, undefined, null)) === JSON.stringify(base), "settings 没读到：原样返回（=T3 前行为）");
    ok(JSON.stringify(resolveModelConfig(BUILTIN, "test", null)) === JSON.stringify(base), "同上，带 role 也不变（没配置=零影响）");

    const global = resolveModelConfig(BUILTIN, "test", rt({ modelName: "qwen3-flash" }));
    ok(global.model === "qwen3-flash", "全局名覆盖所有角色（阶段 2 行为回归位）");

    const tiered = resolveModelConfig(BUILTIN, "test", rt({ modelName: "flash名", modelPro: "pro名" }));
    ok(tiered.model === "pro名", "pro 角色吃 modelPro");
    const cheap = resolveModelConfig(BUILTIN, "backend", rt({ modelName: "flash名", modelPro: "pro名" }));
    ok(cheap.model === "flash名", "flash 角色走全局名（不被 pro 污染）");
    const noProName = resolveModelConfig(BUILTIN, "test", rt({ modelName: "flash名" }));
    ok(noProName.model === "flash名", "pro 名没配=退回全局名，不报错（渐进启用）");

    const custom = resolveModelConfig(BUILTIN, "backend", rt({ modelName: "f", modelPro: "p", roleModels: '{"backend":"pro"}' }));
    ok(custom.model === "p", "role_models 自定义：backend 升 pro 也认");

    // provider 三态（阶段 2 cc-switch 回归位，分层不破坏它）
    const openai = resolveModelConfig(BUILTIN, "test", rt({ modelKind: "openai", modelUrl: "http://localhost:11434/v1", apiKey: "sk-x", modelName: "m" }));
    ok(openai.provider === "openai" && openai.baseURL === "http://localhost:11434/v1" && openai.apiKey === "sk-x", "openai 兼容：url/key 注入不变");
    const urlOnly = resolveModelConfig(BUILTIN, undefined, rt({ modelUrl: "http://x/v1" }));
    ok(urlOnly.provider === "openai", "只填 url 也判 openai（阶段 2 口径不变）");
    // 只配 modelPro 不配全局名：pro 角色吃 pro 名，flash 角色保持内置名——分层可独立启用
    ok(resolveModelConfig(BUILTIN, "test", rt({ modelPro: "p" })).model === "p", "只配 modelPro：pro 角色生效");
    ok(resolveModelConfig(BUILTIN, "backend", rt({ modelPro: "p" })).model === "deepseek-v4-flash", "只配 modelPro：flash 角色不碰（保持内置）");

    console.log(`\n=== 汇总：${pass} 绿 / ${fail} 红 ===`);
    if (fail > 0) process.exit(1);
}

main();
