// ============================================================
// stack-profile-smoke.ts —— 技术栈描述符与组件闸回归（零 LLM）
//
//   治的病（9/10 实测）：四条组件库规约常量全是死代码、幻觉闸是空实现——
//   模型拿不到规约、依赖被强装、校验空转。
//
//   本冒烟固化三件事：
//     ① 规约由 StackProfile **按栈**生成（换栈只换描述符）—— 同一段代码在 Vue+Element 与 Vue+TDesign
//        下必须给出相反的组件判定，证明它没有硬编码 Element Plus
//     ② 组件闸宁漏不误杀：越库标签拒、自定义标签放行
//     ③ 死代码回归：源码里不得再出现那四条常量与空转闸
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { PROJECT_BASELINE, resolveProjectBaseline, type ProjectBaseline } from "../../baseline";
import { resolveStackProfile, componentRulesOf, listStacks, SPRING_VUE, GENERIC_STACK } from "./profile";
import { findComponentTagIssues, shouldScanComponentTags } from "./components";

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string): void {
    if (cond) { pass++; console.log(`  ✓ ${msg}`); }
    else { fail++; console.log(`  ✗ ${msg}`); }
}

const ELEMENT_BASE: ProjectBaseline = PROJECT_BASELINE;
const TDESIGN_BASE: ProjectBaseline = {
    ...PROJECT_BASELINE,
    frontend: { ...PROJECT_BASELINE.frontend, ui: "TDesign Vue Next" },
};
const SVELTE_GO: ProjectBaseline = {
    ...PROJECT_BASELINE,
    frontend: { ...PROJECT_BASELINE.frontend, framework: "Svelte", ui: "Skeleton" },
    backend: { ...PROJECT_BASELINE.backend, framework: "Gin", language: "Go 1.22", orm: "GORM" },
};

console.log("=== ① 栈解析 ===");
{
    ok(resolveStackProfile(ELEMENT_BASE).id === "spring-vue", "Vue+Spring 命中 spring-vue");
    ok(resolveStackProfile(ELEMENT_BASE).verified === true, "spring-vue 标记为已验证（有编译/启动/契约测试）");
    const generic = resolveStackProfile(SVELTE_GO);
    ok(generic.id === GENERIC_STACK.id && generic.verified === false, "★ 未登记栈（Svelte+Gin）落到 GENERIC 且 verified=false");
    ok(generic.uiRule(SVELTE_GO).includes("未验证") || generic.uiRule(SVELTE_GO).includes("没有对应验证器"),
        "★ GENERIC 规约显式声明『无验证器、不保证可构建』——不许静默降级");
    const list = listStacks();
    ok(list.some(s => s.id === "spring-vue" && s.verified) && list.some(s => !s.verified), "栈清单如实标注已验证/未验证");
    ok(resolveStackProfile() === SPRING_VUE, "无参调用按项目默认基线解析");
}

console.log("=== ② 规约随栈变化（证明没硬编码 Element Plus） ===");
{
    const elRule = SPRING_VUE.uiRule(ELEMENT_BASE);
    ok(elRule.includes("Element Plus") && elRule.includes("el-*"), "Element 基线：规约指向 el-*");
    ok(elRule.includes("TDesign"), "Element 基线：明示禁止 TDesign");
    ok(elRule.includes(PROJECT_BASELINE.frontend.requestPath), "规约钉死唯一请求封装路径");
    ok(elRule.includes("--cf-*"), "规约钉死样式变量前缀");

    const tdRule = SPRING_VUE.uiRule(TDESIGN_BASE);
    ok(tdRule.includes("TDesign") && tdRule.includes("t-*"), "★ TDesign 基线：同一份描述符生成 t-* 规约");
    ok(tdRule.includes("Element Plus"), "★ TDesign 基线：此时禁止 Element Plus（与上面相反）");
}

console.log("=== ③ 组件规则推导 ===");
{
    const el = componentRulesOf(ELEMENT_BASE);
    ok(el.allowedPrefixes.join() === "el-", "Element 基线允许前缀 = el-");
    ok(el.forbidden.some(f => f.prefix === "t-" && f.name.includes("TDesign")), "禁止清单含 TDesign");
    const td = componentRulesOf(TDESIGN_BASE);
    ok(td.allowedPrefixes.join() === "t-" && td.forbidden.some(f => f.prefix === "el-"), "TDesign 基线：允许/禁止互换");
    const svelte = componentRulesOf(SVELTE_GO);
    ok(svelte.allowedPrefixes.length === 0, "非 Vue 家族：不做标签前缀校验（React/Svelte 无标签前缀约定）");
}

console.log("=== ④ 组件闸（宁漏不误杀） ===");
{
    const el = componentRulesOf(ELEMENT_BASE);
    ok(findComponentTagIssues(`<template><el-button>点</el-button></template>`, el).length === 0, "本栈组件放行");
    ok(findComponentTagIssues(`<template><div><span>x</span></div></template>`, el).length === 0, "原生 HTML 放行（div/span 非连字符标签）");
    ok(findComponentTagIssues(`<template><my-widget/></template>`, el).length === 0, "★ 未知前缀（自定义组件）放行——不误杀");
    const t = findComponentTagIssues(`<template><t-form><t-input/></t-form></template>`, el);
    ok(t.length >= 1 && t[0]!.includes("TDesign"), `★ 越库组件被拒：${t[0]}`);
    const a = findComponentTagIssues(`<template><a-table/></template>`, el);
    ok(a.length === 1 && a[0]!.includes("Ant Design Vue"), "另一库组件被拒");
    ok(findComponentTagIssues(`<t-form/>`, componentRulesOf(TDESIGN_BASE)).length === 0, "★ 同一条标签在 TDesign 栈下放行（判定随栈）");
    ok(findComponentTagIssues(`<el-button/>`, componentRulesOf(TDESIGN_BASE)).length === 1, "★ 反例：el-* 在 TDesign 栈下被拒");
    ok(shouldScanComponentTags("frontend/src/views/A.vue") && shouldScanComponentTags("x.tsx") && !shouldScanComponentTags("a.java"), "只扫前端模板类文件");
}

console.log("=== ⑤ 死代码与空转闸回归 ===");
{
    const src = fs.readFileSync(path.join(import.meta.dir, "../../frontendEngineer.ts"), "utf-8");
    for (const dead of ["FRONTEND_DESIGN_RULE", "FRONTEND_FILE_RULE", "FRONTEND_STACK_DESIGN_RULE", "FRONTEND_STACK_FILE_RULE", "TDESIGN_WHITELIST_TAGS"]) {
        ok(!src.includes(dead), `死常量已移除：${dead}`);
    }
    ok(!src.includes("extraGate: async () => []"), "★ 空转的组件闸已移除");
    ok(src.includes("findComponentTagIssues"), "组件闸已接回（栈驱动判据）");
    ok(src.includes("stackContextOf"), "规约改为按任务技术栈生成");
}

console.log(`\n[stack-profile-smoke] 通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
