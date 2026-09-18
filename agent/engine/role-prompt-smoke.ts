// role-prompt-smoke.ts - 核心角色 prompt 基线冒烟（零 LLM）
import { plan_prompt, stack_prompt, base_prompt, bootstrap_prompt, api_prompt } from "./architect";
import { design_prompt, file_prompt } from "./frontendEngineer";
import { skeleton_prompt, pseudo_prompt } from "./backendEngineer";
import { test_prompt } from "./testEngineer";
import { pm_system_prompt } from "./manager";
import { baselinePromptBlock, resolveProjectBaseline } from "./baseline";

let pass = 0;
let fail = 0;
function ok(value: boolean, label: string, detail = "") {
    if (value) { pass++; console.log(`  ✓ ${label}`); }
    else { fail++; console.log(`  ✗ ${label}${detail ? ` → ${detail}` : ""}`); }
}

const implementationPrompts = [
    plan_prompt, stack_prompt, base_prompt, bootstrap_prompt, api_prompt,
    design_prompt, file_prompt, skeleton_prompt, pseudo_prompt, test_prompt,
];

for (const [index, prompt] of implementationPrompts.entries()) {
    ok(!/技术栈固定|数据库固定|只能在 Vue 3|只能在 Spring Boot/i.test(prompt), `角色 prompt ${index + 1} 不把默认栈写成固定限制`);
    ok(!/TDesign|tdesign|Express|express-session/i.test(prompt), `角色 prompt ${index + 1} 不携带旧栈约束`);
}

ok(!/TDesign|tdesign/i.test(pm_system_prompt), "PM prompt 不再把旧组件库写成核心约束");
const selected = resolveProjectBaseline({ techniques: {
    frontend: { framework: "React 19", ui: "Ant Design", build: "Vite" },
    backend: { framework: "FastAPI", language: "Python 3.12", orm: "SQLAlchemy" },
    database: { type: "PostgreSQL 16", why: "关系数据" },
} });
const dynamic = baselinePromptBlock(selected);
ok(dynamic.includes("React 19") && dynamic.includes("FastAPI") && dynamic.includes("PostgreSQL 16"), "最终选型可注入下游基线 prompt");
console.log(`\n=== 汇总：${pass} 绿 / ${fail} 红 ===`);
if (fail > 0) process.exit(1);
