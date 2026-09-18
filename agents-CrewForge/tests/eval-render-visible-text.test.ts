// ============================================================
// tests/eval-render-visible-text.test.ts —— eval 渲染尺子的"可见文本"口径（零 LLM、零浏览器、零起服）
//
//   ── 修的假通过（一手实测，数字在下面用例里可复现）──
//   eval/harness/checks.ts 原先这样算"可见文本"：
//       bodyMatch ? bodyMatch[1] : dom   →  剥 <script>/<style>  →  删标签  →  塌缩空白
//   「去掉标签剩下的就是文本」在 <noscript>/<template>/注释/<head> 上不成立：那些字人眼一个也看不见，
//   却全被当成"渲染出来的内容"。实测那两条反例（同样是"SPA 从未挂载 → 用户看到白屏"的页面）：
//       · body 里只有 <noscript>请启用 JavaScript 后使用本应用</noscript>
//             旧口径 text.length = 21 ≥ minTextLength 10 → body.textLength 假通过；
//       · <noscript> 里恰好有"待办"与一个 <input> 时，旧口径**三条断言全过** → 整条渲染检查假通过。
//   本文件把两个方向都钉住：
//     · 假通过方向：<noscript> / <template> / HTML 注释 / 纯 <title> 页面必须 FAIL，理由点名踩了哪条规则；
//     · 不能误伤方向：**真实产物 dump**（基线里 textLength=53 那一页）必须仍然 PASS，而且
//       断言 path / op / detail / 证据里的字数与 eval/baseline/runs/*/result.json 逐字一致。
//
//   证据来源：
//     ① 真 dump：   eval/baseline/runs/s4d-todo-lite/logs/page.home-edge.stdout.log（harness 留的原始 dump）
//                   eval/baseline/runs/s4-todo-lite/logs/page.home-edge.stdout.log（真白屏那一页）
//     ② 真断言：   eval/scenarios/s4d-todo-lite/expected.json 的 renderAssertions（tracked）
//     ③ 真基线结论：eval/baseline/runs/{s4d,s4}-todo-lite/result.json
//     ⚠️ eval/baseline/ 是 .gitignore 掉的**本地评测产物**（.gitignore:68）。文件不在就**诚实跳**，
//        不假装测过（与 tests/eval-exec-npm-cache.test.ts 处理 npm 缺失同一姿势）；夹具那几条永远会跑。
//
//   浏览器一次都不拉（不会像今晚那样在桌面上弹真窗口）：判定纯函数直接喂 dump 字符串，
//   端到端那条用一个"伪浏览器"（.cmd/.sh 回放一份 DOM）走完 harness 的 checkRender 全流程。
// ============================================================

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { checkRender, evaluateRenderDom } from "../eval/harness/checks";
import type { CheckResult, JsonAssertionResult, ScenarioRenderAssertion } from "../eval/harness/types";
import { cleanupTempDirsAfterTests, tmpDir } from "../developerAgent/tests/_tmp";

const EVAL_DIR = path.join(import.meta.dir, "..", "eval");
const RUNS_DIR = path.join(EVAL_DIR, "baseline", "runs");

// ---------- 真实数据的读取 ----------

/** harness 的 dump 日志 = 3 行头（命令/cwd/started）+ 空行 + DOM + 空行 + `## exit=…` 尾 */
function dumpFromLog(logFile: string): string {
    const lines = fs.readFileSync(logFile, "utf-8").split(/\r?\n/);
    const start = lines.findIndex(l => l.startsWith("<!DOCTYPE") || l.startsWith("<html"));
    if (start < 0) throw new Error(`${logFile} 里没有 DOM`);
    const end = lines.findIndex((l, i) => i > start && l.startsWith("## exit="));
    return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

const runLog = (runId: string): string => path.join(RUNS_DIR, runId, "logs", "page.home-edge.stdout.log");
const hasRun = (runId: string): boolean =>
    fs.existsSync(runLog(runId)) && fs.existsSync(path.join(RUNS_DIR, runId, "result.json"));

/** 真产物 dump 是否在场（不在场 → 相关用例诚实跳过，夹具用例照跑） */
const HAS_S4D = hasRun("s4d-todo-lite");
const HAS_S4_BLANK = hasRun("s4-todo-lite");
/** 真产物 dump：Vue 真把待办清单渲染进了 #app（基线 textLength=53）——只在这些用例里读盘 */
const s4dDom = (): string => dumpFromLog(runLog("s4d-todo-lite"));
/** 真白屏 dump：`<div id="app"></div>`，body 里一个字没有（基线 textLength=0） */
const s4BlankDom = (): string => dumpFromLog(runLog("s4-todo-lite"));

function baselineRenderCheck(runId: string): CheckResult {
    const file = path.join(RUNS_DIR, runId, "result.json");
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as { checks: CheckResult[] };
    const c = parsed.checks.find(x => x.kind === "render");
    if (!c) throw new Error(`${file} 里没有 render 检查`);
    return c;
}

function scenarioRenderAssertion(scenarioId: string): ScenarioRenderAssertion {
    const file = path.join(EVAL_DIR, "scenarios", scenarioId, "expected.json");
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as { renderAssertions: ScenarioRenderAssertion[] };
    const a = parsed.renderAssertions[0];
    if (!a) throw new Error(`${file} 没有 renderAssertions[0]`);
    return a;
}

/** 真场景断言：s4d-todo-lite 的 page.home（mustContainText:["待办"] / mustContainHtml:["<input"] / min 10） */
const S4D = scenarioRenderAssertion("s4d-todo-lite");
const S4D_PATHS = ["body.textLength", "text.contains(待办)", "html.contains(<input)"];

/** 基线里**所有**留了原始 dump 的轮次（每轮有自己的断言配置与 result.json 记录）——真数据，不是夹具 */
function runsWithDump(): string[] {
    if (!fs.existsSync(RUNS_DIR)) return [];
    return fs.readdirSync(RUNS_DIR)
        .filter(id => hasRun(id) && fs.existsSync(path.join(EVAL_DIR, "scenarios", id, "expected.json")))
        .sort();
}

// ---------- 旧口径（修之前 checks.ts 里的原样拷贝）----------
//
// ⚠️ 不是生产代码：唯一用途是钉住"旧口径会放行白屏 / 会被注释和脚本骗过"。生产判定走 evaluateRenderDom。
function legacyCheck(dom: string, a: ScenarioRenderAssertion): JsonAssertionResult[] {
    const bodyMatch = /<body[^>]*>([\s\S]*)<\/body>/i.exec(dom);
    const body = bodyMatch ? bodyMatch[1]! : dom;
    const text = body.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const out: JsonAssertionResult[] = [
        { path: "body.textLength", op: "gte", ok: text.length >= a.minTextLength, detail: `body 可见文本 ${text.length} 字（阈值 ${a.minTextLength}）` },
    ];
    for (const t of a.mustContainText) out.push({ path: `text.contains(${t})`, op: "contains", ok: text.includes(t), detail: text.includes(t) ? "命中" : "未命中" });
    for (const h of a.mustContainHtml) out.push({ path: `html.contains(${h})`, op: "contains", ok: dom.includes(h), detail: dom.includes(h) ? "命中" : "未命中" });
    return out;
}

const oldPasses = (checks: JsonAssertionResult[]): boolean => checks.every(x => x.ok);
const paths = (checks: JsonAssertionResult[]): string[] => checks.map(x => x.path);
function byPath(checks: JsonAssertionResult[], p: string): JsonAssertionResult {
    const c = checks.find(x => x.path === p);
    if (!c) throw new Error(`没有这条断言：${p}`);
    return c;
}

// ---------- 夹具（DOM 字符串，不起浏览器）----------

/** 反例 A（实测量到的那一页）：body 里只有 <noscript> 提示语，SPA 从未挂载 → 用户看到白屏 */
const NOSCRIPT_DOM = `<!DOCTYPE html><html lang="zh-CN"><head>`
    + `<meta charset="UTF-8"><title>CrewForge 应用</title>`
    + `<script type="module" crossorigin src="/assets/index.js"></script>`
    + `<link rel="stylesheet" href="/assets/index.css"></head>`
    + `<body><div id="app"></div>`
    + `<noscript>请启用 JavaScript 后使用本应用</noscript>`
    + `</body></html>`;

/** 反例 B：同一页，但 <noscript> 里那些字恰好能骗过 s4d 的三条断言（旧口径三条全过 = 整条渲染检查假通过） */
const NOSCRIPT_FULL_DOM = NOSCRIPT_DOM.replace(
    `<noscript>请启用 JavaScript 后使用本应用</noscript>`,
    `<noscript>待办清单需要 JavaScript：请启用后使用本应用<input type="text" name="title"></noscript>`,
);

/** 只要 <title> 的页面（老洞的另一种形态：标题不是渲染出来的内容） */
const TITLE_ONLY_DOM = `<!DOCTYPE html><html><head><title>便签应用 —— 一个很长的标题（演示环境）</title></head><body></body></html>`;

/**
 * 正文里只有一条注释：注释里的字不是人眼能看见的内容。
 * 实测：注释里**含 ">"** 时，删标签的 `<[^>]+>` 只吃掉 "<!-- … >" 这一截，剩下的
 * "待办清单请稍候 -->" 被当成 **11 个可见字** → textLength(≥10) 与 contains(待办) 双双假通过。
 * （注释里**不含** ">" 时旧口径会把整条注释连 "-->" 一起当标签吃掉 —— 那是运气，不是规则。）
 */
const COMMENT_ONLY_DOM = `<!DOCTYPE html><html><body><div id="app"></div><!-- 加载中 > 待办清单请稍候 --></body></html>`;

/** 对照组：注释里不含 ">" —— 旧口径靠正则巧合吃掉它（0 字），新口径靠规则排除（也是 0 字） */
const COMMENT_NO_GT_DOM = `<!DOCTYPE html><html><body><div id="app"></div><!-- 待办清单加载中请稍候 --></body></html>`;

/** 注释里夹着标签：旧口径搜的是整篇原始 DOM，注释里的 `<input` 也能骗过 html.contains */
const COMMENT_TAG_DOM = `<!DOCTYPE html><html><body><div id="app"></div><!-- 注释掉的输入框 <input type="text"> --></body></html>`;

/** 正文里只有 <template>（模板内容不渲染，但旧口径把里面的字和标签都算数） */
const TEMPLATE_ONLY_DOM = `<!DOCTYPE html><html><body><div id="app"></div><template><li>待办：买牛奶</li><input type="text"></template></body></html>`;

/** `<input` 只出现在内联脚本的源码里（页面并没有输入框） */
const SCRIPT_INPUT_DOM = `<!DOCTYPE html><html><body><div id="app"></div>`
    + `<script>document.title = "待办"; var tpl = '<input type="text" name="title">';</script></body></html>`;

/** 真渲染出来的页面（同一个壳 + #app 里 53 个字，用来证明"不是把尺子拧紧了"） */
const RENDERED_DOM = `<!DOCTYPE html><html lang="zh-CN"><head>`
    + `<meta charset="UTF-8"><title>待办清单</title>`
    + `<script type="module" crossorigin src="/assets/index.js"></script></head>`
    + `<body><div id="app"><main><header><h1>待办清单</h1>`
    + `<p>共 0 条，未完成 0 条</p></header>`
    + `<form><input type="text" name="title" placeholder="输入待办事项"><button>添加</button></form>`
    + `<p>待办列表加载失败，请确认服务已启动</p><p>还没有待办，先添加一条吧。</p>`
    + `</main></div></body></html>`;

// ============================================================
// 1. 假通过方向：<noscript> / 注释 / <template> / 纯标题都不许当"渲染出来的内容"
// ============================================================

describe("旧口径的假通过：看不见的字被当成了可见文本", () => {
    test("★ 实测那条反例：只有 <noscript> 提示语的白屏页，旧口径 textLength=21 ≥ 10（body.textLength 假通过）", () => {
        const len = byPath(legacyCheck(NOSCRIPT_DOM, S4D), "body.textLength");
        expect(len.ok).toBe(true);                                   // ← 旧口径放行
        expect(len.detail).toBe("body 可见文本 21 字（阈值 10）");
    });

    test("★ 更狠的形态：<noscript> 里塞满能骗过 s4d 三条断言的字 → 旧口径**整条渲染检查通过**", () => {
        const legacy = legacyCheck(NOSCRIPT_FULL_DOM, S4D);
        expect(paths(legacy)).toEqual(S4D_PATHS);
        expect(oldPasses(legacy)).toBe(true);                        // ← 旧口径：白屏 = 通过
    });

    test("新口径：同一页 body.textLength 失败，理由点名「人眼看不到的字不算」（含 <noscript>）", () => {
        const v = evaluateRenderDom(S4D, NOSCRIPT_DOM);
        expect(v.text).toBe("");                                     // 一个字都没有
        const a = byPath(v.checks, "body.textLength");
        expect(a.ok).toBe(false);
        expect(a.detail).toContain("body 可见文本 0 字（阈值 10）");
        expect(a.detail).toContain("<noscript>");
        expect(a.detail).toContain("visibleText.ts");
        expect(oldPasses(v.checks)).toBe(false);
    });

    test("新口径：<noscript> 里塞满待办/输入框也骗不过任何一条断言", () => {
        const legacy = legacyCheck(NOSCRIPT_FULL_DOM, S4D);
        const now = evaluateRenderDom(S4D, NOSCRIPT_FULL_DOM);
        expect(oldPasses(legacy)).toBe(true);                        // 旧：三条全过
        expect(paths(now.checks)).toEqual(S4D_PATHS);                // 新：path 一条不多一条不少
        expect(now.text).toBe("");
        expect(now.checks.every(x => x.ok)).toBe(false);
        expect(byPath(now.checks, "text.contains(待办)").ok).toBe(false);
        expect(byPath(now.checks, "html.contains(<input)").detail).toContain("body 可见标记");
    });

    test("纯 <title> 页面（老洞的另一种形态）：标题不进可见文本，也不满足任何断言", () => {
        const now = evaluateRenderDom(S4D, TITLE_ONLY_DOM);
        expect(now.text).toBe("");
        expect(now.checks.every(x => x.ok)).toBe(false);
        expect(byPath(legacyCheck(TITLE_ONLY_DOM, S4D), "body.textLength").ok).toBe(false);   // 只取 body 这一步当年已挡住标题
    });
});

// ============================================================
// 2. 同类洞：注释 / <template> / 脚本源码 / head 里的字与标签
// ============================================================

describe("text.contains / html.contains 的同类洞", () => {
    test("只有一条注释的正文：注释里那 11 个字在旧口径里顶过阈值（textLength/contains 都假通过）", () => {
        const legacy = legacyCheck(COMMENT_ONLY_DOM, S4D);
        expect(byPath(legacy, "body.textLength").detail).toBe("body 可见文本 11 字（阈值 10）");
        expect(byPath(legacy, "body.textLength").ok).toBe(true);              // ← 旧口径：注释算字
        expect(byPath(legacy, "text.contains(待办)").ok).toBe(true);           // ← 旧口径：注释里的"待办"算命中
        const now = evaluateRenderDom(S4D, COMMENT_ONLY_DOM);
        expect(now.text).toBe("");
        expect(now.checks.every(x => x.ok)).toBe(false);
        // 对照组：注释里不含 ">" 时旧口径是**巧合**吃掉的（0 字）；新口径靠规则，也是 0 字
        expect(byPath(legacyCheck(COMMENT_NO_GT_DOM, S4D), "body.textLength").detail).toBe("body 可见文本 0 字（阈值 10）");
        expect(evaluateRenderDom(S4D, COMMENT_NO_GT_DOM).text).toBe("");
    });

    test("注释里夹着标签：旧口径的 html.contains(<input) 被注释骗过，新口径不认", () => {
        expect(byPath(legacyCheck(COMMENT_TAG_DOM, S4D), "html.contains(<input)").ok).toBe(true);   // ← 搜的是整篇原始 DOM
        const now = evaluateRenderDom(S4D, COMMENT_TAG_DOM);
        expect(now.markup).not.toContain("<input");
        expect(byPath(now.checks, "html.contains(<input)").ok).toBe(false);
    });

    test("只有 <template> 的正文：模板里的字与标签都不算数（旧口径的 contains 被骗过）", () => {
        const legacy = legacyCheck(TEMPLATE_ONLY_DOM, S4D);
        expect(byPath(legacy, "text.contains(待办)").ok).toBe(true);           // ← 旧口径：模板里的"待办"算命中
        expect(byPath(legacy, "html.contains(<input)").ok).toBe(true);         // ← 旧口径：模板里的 <input 算命中
        const now = evaluateRenderDom(S4D, TEMPLATE_ONLY_DOM);
        expect(now.text).toBe("");
        expect(now.checks.every(x => x.ok)).toBe(false);
    });

    test("「<input」只出现在内联脚本源码里 → 新口径 html.contains 不再命中", () => {
        expect(SCRIPT_INPUT_DOM.includes("<input")).toBe(true);               // 旧口径：dom.includes("<input") 直接命中
        expect(byPath(legacyCheck(SCRIPT_INPUT_DOM, S4D), "html.contains(<input)").ok).toBe(true);
        const now = evaluateRenderDom(S4D, SCRIPT_INPUT_DOM);
        expect(now.markup).not.toContain("<input");
        expect(byPath(now.checks, "html.contains(<input)").ok).toBe(false);
        expect(byPath(now.checks, "html.contains(<input)").detail).toContain("body 可见标记");
        expect(byPath(now.checks, "text.contains(待办)").ok).toBe(false);      // 脚本里的"待办"也不是字
    });

    test("head 里的标记不算：<title>/<meta> 里的字符串满足不了 html.contains", () => {
        const dom = `<!DOCTYPE html><html><head><title>待办</title><meta name="x" content="<input"></head><body><div id="app"></div></body></html>`;
        const now = evaluateRenderDom(S4D, dom);
        expect(byPath(now.checks, "html.contains(<input)").ok).toBe(false);
        expect(byPath(now.checks, "text.contains(待办)").ok).toBe(false);
    });

    test("实体解码后的字照样能命中（页面真的显示了「待办 & 已完成」）", () => {
        const dom = `<!DOCTYPE html><html><body><div id="app"><p>待办 &amp; 已完成，共 12 条记录待确认</p><input></div></body></html>`;
        const a: ScenarioRenderAssertion = { id: "page.x", route: "/", mustContainText: ["待办 & 已完成"], mustContainHtml: ["<input"], minTextLength: 5 };
        const v = evaluateRenderDom(a, dom);
        expect(v.text).toBe("待办 & 已完成，共 12 条记录待确认");
        expect(v.checks.every(x => x.ok)).toBe(true);
    });
});

// ============================================================
// 3. 不能误伤方向：真渲染出来的页面必须仍然通过
// ============================================================

describe("真渲染出来的页面必须仍然通过（修的是洞，不是把尺子拧紧）", () => {
    test("合成页面：同一个壳 + #app 里 53 个字 → 三条断言全过", () => {
        const legacy = legacyCheck(RENDERED_DOM, S4D);
        const now = evaluateRenderDom(S4D, RENDERED_DOM);
        expect(oldPasses(legacy)).toBe(true);
        expect(now.checks.every(x => x.ok)).toBe(true);
        expect(now.text.length).toBe(53);                                    // 与真实产物同一段文字
        expect(byPath(now.checks, "body.textLength").detail).toBe(byPath(legacy, "body.textLength").detail);
        expect(now.text).toContain("还没有待办，先添加一条吧。");
        expect(now.text).not.toContain("placeholder");                       // 属性值不是"字"
    });

    test.skipIf(!HAS_S4D)("★ 真产物 dump（s4d-todo-lite，基线 textLength=53）→ 三条断言全过", () => {
        const v = evaluateRenderDom(S4D, s4dDom());
        expect(v.checks.every(x => x.ok)).toBe(true);
        expect(v.text.length).toBe(53);
        expect(v.text).toContain("待办清单");
        expect(v.text).not.toContain("title");
        expect(v.markup).toContain("<input");
        expect(v.markup).not.toContain("assets/index-");                     // head 的 script/link 不在搜索范围里
    });

    test.skipIf(!HAS_S4D)("★ 与基线 result.json 逐条一致：path / op / ok / detail 全同（报告消费者按 path 取值）", () => {
        const baseline = baselineRenderCheck("s4d-todo-lite");
        expect(baseline.status).toBe("pass");                                // 基线：这一页当初就是 pass
        const v = evaluateRenderDom(S4D, s4dDom());
        expect(v.checks).toEqual(baseline.jsonAssertions);
        expect(paths(v.checks)).toEqual(S4D_PATHS);
        expect(byPath(v.checks, "body.textLength").detail).toBe("body 可见文本 53 字（阈值 10）");
        expect(byPath(v.checks, "text.contains(待办)").detail).toBe("命中");
        expect(byPath(v.checks, "html.contains(<input)").detail).toBe("命中");
    });

    test.skipIf(!HAS_S4D)("★ 证据里的文本行与基线一字不差（`文本(head 400)=…`）", () => {
        const v = evaluateRenderDom(S4D, s4dDom());
        expect(baselineRenderCheck("s4d-todo-lite").evidence)
            .toContain(`\n文本(head 400)=${v.text.slice(0, 400)}\n`);
    });

    test.skipIf(!HAS_S4_BLANK)("真白屏 dump（s4-todo-lite：空 #app）在新口径下仍然 FAIL，逐条 ok 与基线一致", () => {
        const baseline = baselineRenderCheck("s4-todo-lite");
        expect(baseline.status).toBe("fail");
        const now = evaluateRenderDom(S4D, s4BlankDom());
        expect(now.text).toBe("");
        expect(paths(now.checks)).toEqual(paths(baseline.jsonAssertions));
        expect(now.checks.map(x => x.ok)).toEqual(baseline.jsonAssertions.map(x => x.ok));
        // 失败那条同一句话打头；后面多的一句"哪条规则"是本次唯一新增的措辞（只在失败路径）
        expect(byPath(now.checks, "body.textLength").detail)
            .toStartWith(byPath(baseline.jsonAssertions, "body.textLength").detail);
    });

    test.skipIf(runsWithDump().length === 0)("★ 基线里每一份真 dump 都被重新判一遍：逐条 ok 与历史记录完全一致", () => {
        const rows = runsWithDump().map(run => {
            const a = scenarioRenderAssertion(run);
            const now = evaluateRenderDom(a, dumpFromLog(runLog(run)));
            const base = baselineRenderCheck(run);
            return { run, nowPaths: paths(now.checks), basePaths: paths(base.jsonAssertions), nowOk: now.checks.map(x => x.ok), baseOk: base.jsonAssertions.map(x => x.ok) };
        });
        expect(rows.length).toBeGreaterThan(0);
        for (const r of rows) {
            // 把轮次名带进断言对象里：失败时 diff 直接点名是哪一轮
            expect({ run: r.run, paths: r.nowPaths, ok: r.nowOk }).toEqual({ run: r.run, paths: r.basePaths, ok: r.baseOk });
        }
        // 样本里既有"有内容"也有"白屏"：说明这套对比不是一边倒
        expect(rows.some(r => r.nowOk.every(Boolean))).toBe(true);
        expect(rows.some(r => !r.nowOk.every(Boolean))).toBe(true);
    });
});

// ============================================================
// 4. 端到端：用"伪浏览器"回放 DOM，跑一遍 harness 真正的 checkRender
//    （真起静态服、真 spawn、真判定、真落日志；只把浏览器换成回放 → 不弹窗、不花钱）
// ============================================================

const WIN = process.platform === "win32";

/** 造一个可执行的"伪浏览器"：忽略参数，把 dumpFile 的内容原样吐到 stdout（Edge --dump-dom 的行为） */
function writeFakeBrowser(dir: string, dumpFile: string): string {
    if (WIN) {
        const exe = path.join(dir, "fake-edge.cmd");
        fs.writeFileSync(exe, `@echo off\r\ntype "${dumpFile}"\r\n`, "utf-8");
        return exe;
    }
    const exe = path.join(dir, "fake-edge.sh");
    fs.writeFileSync(exe, `#!/bin/sh\ncat "${dumpFile}"\n`, "utf-8");
    fs.chmodSync(exe, 0o755);
    return exe;
}

/** 造一个"前端构建产物"目录（checkRender 只要求 dist/index.html 在） */
function distWith(tag: string, indexHtml: string): string {
    const dir = path.join(tmpDir(tag), "dist");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), indexHtml, "utf-8");
    return dir;
}

/** 回放一份 DOM 跑完整条 checkRender（返回检查结果；dump 与 dist 都是夹具） */
async function renderWithReplay(tag: string, dom: string): Promise<CheckResult> {
    const root = tmpDir(tag);
    const dumpFile = path.join(root, "dump.html");
    fs.writeFileSync(dumpFile, dom, "utf-8");
    return checkRender(S4D, distWith(`${tag}-dist`, dom), path.join(root, "logs"), writeFakeBrowser(root, dumpFile));
}

describe("端到端：checkRender 在 <noscript> 白屏页上判 fail（不再是 pass）", () => {
    test("★ status=fail，detail 点名失败断言 + 口径规则（报告里能看出为什么）", async () => {
        const c = await renderWithReplay("cf-rendercheck-noscript", NOSCRIPT_FULL_DOM);
        expect(c.status).toBe("fail");
        expect(c.exitCode).toBe(0);                                          // 浏览器退出码 0（不是环境问题）
        expect(c.jsonAssertions.map(x => x.path)).toEqual(S4D_PATHS);
        expect(c.jsonAssertions.every(x => x.ok)).toBe(false);
        expect(c.detail).toContain("页面渲染未达标");
        expect(c.detail).toContain("body.textLength");
        expect(c.detail).toContain("<noscript>");                            // ← 为什么失败：哪些字不算数
        expect(c.detail).not.toContain("页面渲染通过");
    });

    test("证据格式没变：`edge exit=` / `url=` / `DOM(head 800)=` / `文本(head 400)=` 四段都在，且文本为空", async () => {
        const c = await renderWithReplay("cf-rendercheck-evidence", NOSCRIPT_FULL_DOM);
        expect(c.evidence).toStartWith("edge exit=0\nurl=http://127.0.0.1:");
        expect(c.evidence).toContain("\nDOM(head 800)=<!DOCTYPE html>");
        expect(c.evidence).toContain("\n文本(head 400)=\n");
        expect(c.evidence).toContain("\n--- edge stderr tail ---\n");
        expect(c.logFile).not.toBeNull();                                    // 原始 dump 照旧落盘
        expect(fs.existsSync(c.logFile!)).toBe(true);
    });

    test.skipIf(!HAS_S4D)("★ 真产物 dump 回放 → status=pass，detail 与基线一字不差", async () => {
        const dom = s4dDom();
        const expectedText = evaluateRenderDom(S4D, dom).text;
        const c = await renderWithReplay("cf-rendercheck-real", dom);
        expect(c.status).toBe("pass");
        expect(c.detail).toBe("页面渲染通过：文本 53 字，命中 1 个文案断言");
        expect(c.jsonAssertions).toEqual(baselineRenderCheck("s4d-todo-lite").jsonAssertions);
        expect(c.evidence).toContain(`\n文本(head 400)=${expectedText.slice(0, 400)}\n`);
    });
});

cleanupTempDirsAfterTests();
