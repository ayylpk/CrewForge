// ============================================================
// tdesign-smoke.ts —— TDesign 集成冒烟（9/5 下午主线，验收脚本常备）
//
//   覆盖三块（对齐 bridge-smoke.ts 的先例：断言 + 汇总 + 非零退出码）：
//     ① 纯函数：normalizeName / extractUsedComponents / parseDesignComponents /
//               isRealDoc / findHallucinated（含通道挂旁路）/ buildDocsBlock
//     ② MCP live：批量拉真组件+假组件 → 真=有 api、幻觉="组件不存在"、二查走缓存
//     ③ 架构师地基兜底：enforceTdesignFoundation 依赖合并 + theme 补写（不碰非前端包）
//
//   跑法：bun run tdesign-smoke.ts（需要网络：MCP 数据运行时拉 tdesign.gtimg.com）
// ============================================================

import {
    normalizeName, isRealDoc, extractUsedComponents, findHallucinated,
    fetchComponentDocs, buildDocsBlock, TDESIGN_WHITELIST,
} from "./tdesignMcp";
import { parseDesignComponents } from "./frontendEngineer";
import { enforceTdesignFoundation, ensureRequestFoundation } from "./architect";
import { REQUEST_WRAPPER_PATH, REQUEST_WRAPPER_CODE } from "./common";
import { closeTdesignMcp } from "./tdesignMcp";

let pass = 0, fail = 0;
function ok(cond: boolean, label: string, extra = "") {
    if (cond) { pass++; console.log(`  ✓ ${label}`); }
    else { fail++; console.log(`  ✗ ${label} ${extra}`); }
}

async function main() {
    console.log("=== ① 纯函数 ===");
    ok(normalizeName("<t-date-picker>") === "date-picker", "normalizeName 剥壳");
    ok(normalizeName("t-Button") === "button", "normalizeName 大小写");
    ok(normalizeName("input_number") === "input-number", "normalizeName 下划线转连字符");

    const sfc = `<template><t-form><t-input v-model="a"/><t-select/><div><t-date-picker/></div></template>`;
    const used = extractUsedComponents(sfc).sort();
    ok(used.join(",") === "date-picker,form,input,select", "extractUsedComponents 扫描去重", `got=${used}`);

    const design = "结构：登录卡片……\n【组件清单】<t-form>、<t-input>、<t-button>、<t-ttt>\n交互：……";
    const comps = parseDesignComponents(design);
    ok(comps.join(",") === "form,input,button", "parseDesignComponents 白名单过滤（剔掉 t-ttt）", `got=${comps}`);
    ok(parseDesignComponents(null).length === 0 && parseDesignComponents("没有清单").length === 0, "parseDesignComponents 缺行容忍");

    ok(isRealDoc('{"api":"### Button Props..."}') && !isRealDoc("组件不存在") && !isRealDoc(""), "isRealDoc 判型");
    const docs = { button: '{"api":"xxx ".repeat(10)}', ghost: "组件不存在" };
    docs.button = JSON.stringify({ api: "x".repeat(100) });
    ok(findHallucinated(["button", "ghost", "never-fetched"], docs).join(",") === "ghost,never-fetched",
        "findHallucinated：幻觉+未核验都拦");
    ok(findHallucinated(["whatever"], null).length === 0, "findHallucinated：通道挂=放行（旁路）");
    ok(buildDocsBlock(["button", "ghost"], docs).includes("### <t-button>")
        && !buildDocsBlock(["button", "ghost"], docs).includes("ghost"), "buildDocsBlock 只拼真文档");

    console.log("=== ② MCP live（起 stdio 真查） ===");
    const fetched = await fetchComponentDocs(["t-form", "input", "dialog", "ttablex"]);
    ok(fetched !== null && fetched !== undefined, "通道可用（非 null）");
    if (fetched) {
        ok(isRealDoc(fetched["form"]) && isRealDoc(fetched["input"]), "真组件有文档");
        ok(fetched["ttablex"] === "组件不存在", "幻觉组件=『组件不存在』", `got=${fetched["ttablex"]}`);
        const block = buildDocsBlock(["form", "input"], fetched);
        ok(block.includes("Form Props") || block.includes("Input Props"), "文档段含真实 API 表", `len=${block.length}`);
        console.log(`  （文档段体量 ${block.length} 字符 / 3 组件）`);
        const ts = Date.now();
        await fetchComponentDocs(["form", "input", "dialog", "ttablex"]);   // 全缓存命中
        ok(Date.now() - ts < 50, "二次查询走进程内缓存（<50ms）", `${Date.now() - ts}ms`);
    }

    console.log("=== ③ enforceTdesignFoundation（架构师地基兜底） ===");
    const files = [
        { path: "frontend/package.json", content: JSON.stringify({ dependencies: { vue: "^3.5.0" }, devDependencies: { vite: "^7.0.0" } }) },
        { path: "package.json", content: JSON.stringify({ dependencies: { express: "^5.0.0" } }) },        // 后端 Node：不该被注入
        { path: "src/main/resources/application.yml", content: "server:\n  port: 8080" },
    ];
    enforceTdesignFoundation(files);
    const fe = JSON.parse(files[0]?.content ?? "{}");
    ok(!!fe.dependencies["tdesign-vue-next"] && !!fe.devDependencies["unplugin-vue-components"] && fe.dependencies.vue === "^3.5.0",
        "前端 package.json：注入 tdesign + 保留原依赖");
    ok(!JSON.parse(files[1]?.content ?? "{}").dependencies["tdesign-vue-next"], "后端 package.json 不误伤");
    ok(files.some(f => f.path.endsWith("td-theme.css") && f.content.includes("--td-brand-color")),
        "无 theme 文件时补写 --td-* 主题");

    console.log("=== ③b ensureRequestFoundation（p2 修①：请求封装代码保底） ===");
    // 无前端形态：不掺和
    const backOnly = [{ path: "backend/app.py", content: "print(1)" }];
    ensureRequestFoundation(backOnly);
    ok(backOnly.length === 1, "纯后端批：不补 request 封装");
    // 有前端无封装：补契约标准路径 + package.json 合并 axios（保留原依赖）
    const fe2 = [
        { path: "frontend/package.json", content: JSON.stringify({ dependencies: { vue: "^3.5.0" } }) },
        { path: "frontend/src/views/Home.vue", content: "<template><div/></template>" },
    ];
    ensureRequestFoundation(fe2);
    const reqFile = fe2.find(f => f.path === REQUEST_WRAPPER_PATH);
    ok(!!reqFile && reqFile.content === REQUEST_WRAPPER_CODE,
        "补写 frontend/src/utils/request.ts（内容与前端 prompt 严格同源）");
    const pkg2 = JSON.parse(fe2[0]?.content ?? "{}");
    ok(!!pkg2.dependencies.axios && pkg2.dependencies.vue === "^3.5.0", "axios 合并进前端包且原依赖不丢");
    // LLM 已自写标准封装：不重复、不覆盖
    const own = [
        { path: "frontend/src/views/A.vue", content: "<template><div/></template>" },
        { path: "frontend/src/utils/request.ts", content: "// own\nexport default 1;" },
    ];
    ensureRequestFoundation(own);
    ok(own.length === 2 && own[1]?.content === "// own\nexport default 1;", "标准封装在场：不动（幂等）");
    // LLM 另起炉灶（p2 现场 services/api.js）：仍补标准文件——幽灵致命、重复只是瑕疵
    const drifted = [{ path: "frontend/src/services/api.js", content: "export default {};" }];
    ensureRequestFoundation(drifted);
    ok(drifted.length === 2 && drifted[1]?.path === REQUEST_WRAPPER_PATH, "services/api.js 漂移：补标准件共存");
    // web/ 形态前端根：封装落在 web/src/utils/request.ts（不硬写 frontend）
    const web = [{ path: "web/src/App.vue", content: "<template><div/></template>" }];
    ensureRequestFoundation(web);
    ok(!!web.find(f => f.path === "web/src/utils/request.ts"), "web/ 前端根：路径跟着前端根走");

    ok(TDESIGN_WHITELIST.length <= 30 && TDESIGN_WHITELIST.length >= 28, `白名单规模 ${TDESIGN_WHITELIST.length} ≤30`);

    await closeTdesignMcp();
    console.log(`\n[结果] ${pass} 通过 / ${fail} 失败`);
    process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error("冒烟异常:", e); process.exit(1); });
