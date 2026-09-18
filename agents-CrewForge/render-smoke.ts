// ============================================================
// render-smoke.ts —— T6 测试强化冒烟（9/8，确定性层零 LLM 零起服）
//
//   卡面狗考金标准的机器层兑现：F5 四坑各造一个可机检形态 → 全被拦：
//     ①白屏 → judgeDom 判空（渲染审的纯函数半边；口径在 visibleText.ts，"只有标题"也判白屏）
//     ②坏引用（不存在导出名）→ 机械编译复核（T1 引擎复用）
//     ③路由指空 → 同上
//     ④风格分裂 → scanHardcodedHex 超限
//   另覆盖：enforceChecklistConsistency（假通过机器改判/缺项补记）、renderTestReport、
//           renderCheckFrontend 无前端目录=skip 旁路（不起真服务）。
//   跑法：bun run render-smoke.ts
//   注（9/18）：判白屏的规则本体已收敛到 visibleText.ts（renderGate.judgeDom 只是适配层），
//           用例更多的那份在 developerAgent/tests/render-gate.test.ts（含一次真 headless Edge 跑）。
// ============================================================

import { judgeDom, renderCheckFrontend, closeRenderGates } from "./renderGate";
import { enforceChecklistConsistency, renderTestReport, scanHardcodedHex, CHECKLIST_ITEMS } from "./testEngineer";
import { checkFile, buildKnown } from "./checkers";
import type { Verdict, CheckItem } from "./testEngineer";

let pass = 0, fail = 0;
function ok(cond: boolean, label: string, extra = "") {
    if (cond) { pass++; console.log(`  ✓ ${label}`); }
    else { fail++; console.log(`  ✗ ${label} ${extra}`); }
}

async function main() {
    console.log("=== ① judgeDom：坑①白屏当场毙 ===");
    const white = judgeDom(`<!DOCTYPE html><html><head><title>x</title></head><body><div id="app"></div></body></html>`);
    ok(white.blank === true, "空挂载点=白屏（F5① 的运行时形态）", JSON.stringify(white));
    const rows = Array.from({ length: 30 }, (_, i) => `<li class="i${i}">row ${i}</li>`).join("");
    const rich = judgeDom(`<!DOCTYPE html><html><head><title>打卡应用</title></head><body><div id="app"><h1>今日打卡</h1><ul>${rows}</ul><script>var a=1</script><style>.i0{}</style></div></body></html>`);
    ok(rich.blank === false && rich.title === "打卡应用", "正常渲染放行+抓标题", JSON.stringify(rich));
    ok(rich.elCount === 30 + 7, "script/style 内容不算元素（计数口径：html/head/title/body/div/h1/ul+30li）", `elCount=${rich.elCount}`);
    ok(judgeDom("<html><body><p>" + "短".repeat(300) + "</p></body></html>").blank === true,
        "元素稀疏即使文本长也判空（阈值取或——真 vue 页面不可能只有 3 个元素）");
    ok(judgeDom("<html><body></body></html>").blank === true, "空 body=白屏");

    // 9/18 修正：老 judgeDom 的"可见文本"是「去标签剩下的字」，于是 <head> 里的 <title> 也算字——
    // 白屏页只要标题够长就能把 textLen 顶过 24 字阈值、被判"有内容"（实测旧口径 textLen=54 / blank=false）。
    // 规则本体搬去了 visibleText.ts（harness 早就在 eval/harness/checks.ts:477 点名过这个坑）。
    const titleOnly = judgeDom(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">`
        + `<meta name="theme-color" content="#0052d9"><title>${"待办清单管理系统".repeat(3)}</title>`
        + `<link rel="icon" href="/favicon.ico"><link rel="stylesheet" href="/a.css"><link rel="modulepreload" href="/a.js"></head>`
        + `<body><noscript><p>请启用 JavaScript 后使用</p></noscript><div id="app"></div></body></html>`);
    ok(titleOnly.blank === true && titleOnly.textLen === 0,
        "★ 只有标题的白屏页=白屏（标题/noscript 都不算可见文本）", JSON.stringify(titleOnly));
    ok(titleOnly.title === "待办清单管理系统".repeat(3), "标题仍作证据抓出来（判定与证据分离）");
    const rendered = judgeDom(`<html><head><title>x</title></head><body><div id="app"><h1>今日打卡</h1><ul>${rows}</ul></div></body></html>`);
    ok(rendered.blank === false && rendered.mountEmpty === false && rendered.textLen > 24,
        "渲染出文字的页面放行（挂载点非空，别把有内容的判成白屏）", JSON.stringify(rendered));

    console.log("=== ② 坑②③：机械编译复核（T1 引擎复用，纸审糊弄不过） ===");
    const known = buildKnown(null, new Map<string, string>([
        ["frontend/src/api/auth.ts", `export function login() { return 1 }`],
    ]), []);
    ok((await checkFile("frontend/src/page.vue", `<script setup>\nimport { logout } from "./api/auth";\n</script>\n<template><div/></template>`, known)).length > 0, "坑②形态：不存在的导出名被机械拦截");
    const emptyKnown = buildKnown(null, new Map(), []);
    ok((await checkFile("frontend/src/router/index.ts", `const r = [{ component: () => import("./views/Ghost.vue") }]`, emptyKnown)).length > 0, "坑③形态：路由指空被机械拦截");

    console.log("=== ③ 坑④：硬编码色扫描 ===");
    const hexFiles = [
        { filePath: "frontend/src/views/Login.vue", content: `<style>.a{color:#0a1128;background:#111}.b{color:#0a1128}.c{color:#0a1128}.d{color:#0a1128}.e{color:#0a1128}.f{color:#0a1128}</style>` },
    ];
    ok(scanHardcodedHex(hexFiles).verdict === "fail", "6 处硬编码色 → fail（F5④ 的机检形态）");
    ok(scanHardcodedHex([{ filePath: "frontend/src/views/A.vue", content: `<style>.a{color:#0a1128;background:#111}</style>` }]).verdict === "pass", "2 处 ≤5 → pass");
    ok(scanHardcodedHex([{ filePath: "frontend/src/styles/td-theme.css", content: `:root{--td-brand-color:#00d4ff;--x:#111111;--y:#222222;--z:#333333;--w:#444444;--v:#555555;--u:#666666}` }]).verdict === "pass",
        "td-theme.css（token 本体）豁免");
    ok(scanHardcodedHex([{ filePath: "frontend/src/views/B.vue", content: `<style>.a{color:var(--td-brand-color)}.b{color:#0a1128}</style>` }]).verdict === "pass", "--td-* 变量引用行不计");

    console.log("=== ④ 清单一致性：假通过机器改判 ===");
    const fakePass: Verdict = { pass: true, blame: "backend", backendIssues: [], frontendIssues: [] };
    const redChecks: CheckItem[] = [
        { item: "接口联通", verdict: "fail", evidence: "前端取 res.data.list，后端返回 {code,data:{items}}" },
        { item: "三态覆盖", verdict: "pass", evidence: "有空态" },
    ];
    const forced = enforceChecklistConsistency(fakePass, redChecks);
    ok(forced.verdict.pass === false && forced.verdict.blame === "both", "checks 有 fail 而报 pass → 强制改判 both");
    ok(forced.verdict.frontendIssues.join("").includes("接口联通"), "改判理由进 issues");
    const names = forced.checks.map(c => c.item);
    ok(CHECKLIST_ITEMS.every(name => names.includes(name)) && forced.checks.length === CHECKLIST_ITEMS.length, "六项缺位机器补记 skip（清单化不靠模型自觉）", names.join(","));

    console.log("=== ⑤ 报告与旁路 ===");
    const report = renderTestReport("T1+T1-F GET /api/x", 1, forced.verdict, forced.checks,
        [{ item: "机械-编译复核", verdict: "pass", evidence: "全部文件过编译" }]);
    ok(report.includes("# 测试报告") && report.includes("机械-编译复核") && report.includes("接口联通") && report.includes("- [ ]"),
        "报告含结论+机器段+清单段（- [ ] 勾格）");
    const skip = await renderCheckFrontend(987_654, "smoke-no-frontend");   // 不存在的项目 → 无 frontend 目录
    ok(skip.status === "skip" && (skip.reason ?? "").includes("frontend"), "无前端目录=skip 带理由（旁路，不装死）", JSON.stringify(skip));
    await closeRenderGates();   // 清 memo 的 null-promise，进程干净退出

    console.log(`\n=== 汇总：${pass} 绿 / ${fail} 红 ===`);
    if (fail > 0) process.exit(1);
}

main().catch(e => { console.error("冒烟脚本自身炸了:", e); process.exit(2); });
