// ============================================================
// pm-ui-smoke.ts —— T5 PM 三问·UI 决策冒烟（9/8，确定性层零 LLM）
//
//   覆盖：①normalizeUiProfile 机读核验（形状/硬约束/去重/截断/defaulted）
//         ②parsePMResponseText 对 ui 的提取（done+ui 同体、最后一个有效优先、无 ui=旁路进回炉）
//         ③assembleContracts 消费 uiProfile（亲答/默认值两种标注；无 uiProfile 不加行）
//   pmNode 的"补写一轮→兜底 defaulted"分支是 LLM 交互态，归 live 首轮观察日志行。
//   跑法：bun run pm-ui-smoke.ts
// ============================================================

import { normalizeUiProfile, parsePMResponseText } from "./manager";
import { assembleContracts } from "./contracts";
import type { Plan } from "./common";

let pass = 0, fail = 0;
function ok(cond: boolean, label: string, extra = "") {
    if (cond) { pass++; console.log(`  ✓ ${label}`); }
    else { fail++; console.log(`  ✗ ${label} ${extra}`); }
}

const basePlan = (uiProfile?: Partial<Plan["uiProfile"]>): Plan => ({
    project: "习惯打卡应用",
    features: [], mvp_scope: ["登录"], risks: [],
    phases: [{ phase: 1, name: "地基", goal: "登录+打卡", features: ["登录"], dependencies: [], relative_effort: "小", risk: "低" }],
    ...(uiProfile ? { uiProfile: uiProfile as Plan["uiProfile"] } : {}),
});

function main() {
    console.log("=== ① normalizeUiProfile 机读核验 ===");
    ok(!!normalizeUiProfile({ web: true, pages: ["登录", "主页"], style: "深蓝科技感" }), "完整亲答形状通过");
    ok(!!normalizeUiProfile({ web: false, pages: [], style: "无所谓" }), "不做前端+空页面合法（①答否）");
    ok(normalizeUiProfile({ web: true, pages: [], style: "s" }) === null, "要前端却零页面=没真回答①→null 回炉");
    ok(normalizeUiProfile({ web: "true", pages: ["a"], style: "s" }) === null, "web 非布尔→null（LLM 手滑不放行）");
    ok(normalizeUiProfile({ web: true, pages: ["a"], style: "  " }) === null, "style 空白→null");
    ok(normalizeUiProfile(null) === null && normalizeUiProfile("ui") === null, "非对象→null");
    const dedup = normalizeUiProfile({ web: true, pages: ["登录", "登录", " 主页 ", ""], style: "s" });
    ok(dedup !== null && dedup.pages.join(",") === "登录,主页", "pages 去重+trim+剔空", JSON.stringify(dedup?.pages));
    const capped = normalizeUiProfile({ web: true, pages: Array.from({ length: 30 }, (_, i) => `页${i}`), style: "s" });
    ok(capped !== null && capped.pages.length === 20, "pages 截断 ≤20");
    ok(normalizeUiProfile({ web: true, pages: ["a"], style: "s", default: true })?.defaulted === true, "default:true → defaulted");
    const long = normalizeUiProfile({ web: true, pages: ["a"], style: "x".repeat(300) });
    ok(long !== null && long.style.length === 120, "style 截 120（防长文糊契约）");

    console.log("=== ② parsePMResponseText 对 ui 的提取 ===");
    const p1 = parsePMResponseText('好的，我理解了。复述一下……\n{"done":true,"ui":{"web":true,"pages":["登录","统计"],"style":"深蓝科技感"}}');
    ok(p1.done === true && p1.ui !== null && p1.ui.pages.join(",") === "登录,统计" && p1.ui.style === "深蓝科技感", "定稿行 done+ui 同体解析");
    const p2 = parsePMResponseText('继续追问……{"features":[{"name":"打卡","description":"d","priority":"高","acceptance":"a"}]}');
    ok(p2.done === false && p2.ui === null && p2.newFunctions.length === 1, "普通轮：features 照收、ui 为 null（回炉分支的入口条件）");
    const p3 = parsePMResponseText('{"ui":{"web":true,"pages":["旧"],"style":"旧"}}\n修正：\n{"done":true,"ui":{"web":false,"pages":[],"style":"只要API"}}');
    ok(p3.ui !== null && p3.ui.web === false && p3.ui.style === "只要API", "多个 ui 对象：最后一个有效优先");
    const p4 = parsePMResponseText('{"done":true} 还有杂七杂八 { } 的花括号');
    ok(p4.done === true && p4.ui === null, "只回 done 没带 ui → ui=null（触发代码补写轮）");

    console.log("=== ③ assembleContracts 消费 uiProfile ===");
    const withUi = assembleContracts(1, basePlan({ web: true, pages: ["登录"], style: "深蓝科技感", defaulted: false }), null);
    ok(withUi.includes("界面决策（PM 访谈）") && withUi.includes("深蓝科技感") && withUi.includes("用户亲答，不得违背"),
        "亲答值进契约头部");
    const defaultedUi = assembleContracts(1, basePlan({ web: true, pages: [], style: "默认：跟随工程地基藏青主题（UI 三问未采集到用户偏好）", defaulted: true }), null);
    ok(defaultedUi.includes("默认值，未经用户亲答"), "默认值在契约显著标注（有异议走确认门）");
    const noUi = assembleContracts(1, basePlan(), null);
    ok(!noUi.includes("界面决策"), "无 uiProfile 不加行（T5 前老 plan 兼容）");

    console.log(`\n=== 汇总：${pass} 绿 / ${fail} 红 ===`);
    if (fail > 0) process.exit(1);
}

main();
