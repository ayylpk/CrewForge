// ============================================================
// compile-gate-smoke.ts —— T1 编译自修闸门冒烟（9/8，验收卡面第①②层）
//
//   覆盖三块（对齐 bridge-smoke / tdesign-smoke 先例：断言+汇总+非零退出码）：
//     ① RED：坏码必拒——F5 四坑的编译期可检变体各造一样（SFC 结构塌/引用不存在的导出名/引用到空/py 语法错）
//     ② GREEN：好码零误杀——正常 SFC、bare 包、@别名、export* 转发、import type、
//        计划内未生成文件、多行 import、未认识格式(.java/.yml/.md) 全须放行（宁漏不误杀：误杀=白烧一轮 60~300s LLM）
//     ③ LOOP：模拟工位自修环——首轮注入坏文件被打回（报错原文进 feedback、截 600 字）、二轮修复变绿、
//        三轮耗尽判失败——纯 stub 零 LLM，接线逻辑与 backend/frontendEngineer.generateFile 同构
//     ⑤ p2 复盘修②③（9/9）：文件树注入（list/formatFileTree/fileTreePrompt）+ 打回附候选（导出名/路径相似）
//
//   诚实边界（不装）：F5① 的 h('router-view') 白屏与 F5④ 风格分裂在 T1 属"语法合法"类，
//   归 T6 渲染审 / T2 契约管——本卡用其编译期可检的同类变体（SFC 结构错）占位，映射写死在下面注释里。
//   卡面第③层 live 验收（跑一轮 p1 全树零编译错）等环境热了随首轮开工一起做。
// ============================================================

import { buildKnown, checkFile, checkBatch, gateFeedback, formatFileTree, fileTreePrompt } from "./checkers";

let pass = 0, fail = 0;
function ok(cond: boolean, label: string, extra = "") {
    if (cond) { pass++; console.log(`  ✓ ${label}`); }
    else { fail++; console.log(`  ✗ ${label} ${extra}`); }
}

/** 已知文件集（纯内存场景）：extra=内容已知的文件，planned=排定路径（存在但未生成） */
function knownFor(extra: Record<string, string>, planned: string[] = []) {
    const m = new Map(Object.entries(extra));
    return buildKnown(null, m, planned);
}

async function main() {
    // ============================================================
    console.log("=== ① RED：坏码必拒（F5 四坑变体各一） ===");

    // 坑②变体：interface 当值导入 ESM 报 does not provide export —— 同族"引了目标里没有的名字"
    const authKnown = knownFor({ "frontend/src/api/auth.ts": `export function login() { return 1; }\nexport default { login };\nexport interface Session { id: string }` });
    const p2 = await checkFile("frontend/src/api/user.ts",
        `import { fetchUser } from "./auth";\nexport function go() { return fetchUser(); }`, authKnown);
    ok(p2.some(s => s.includes("fetchUser") && s.includes("./auth")), "坑②变体：不存在的导出名被打回", JSON.stringify(p2));

    // 坑③：路由懒加载指向从未生成的 .vue —— 引用到空
    const p3 = await checkFile("frontend/src/router/index.ts",
        `const routes = [{ path: "/space", component: () => import("../views/SessionSpace.vue") }];\nexport default routes;`,
        knownFor({}));
    ok(p3.some(s => s.includes("SessionSpace.vue") && s.includes("不存在")), "坑③：动态 import 引用到空被打回", JSON.stringify(p3));

    // 坑①变体：白屏事故在编译期的同族——SFC 模板结构塌（标签不闭合）
    const p1 = await checkFile("frontend/src/views/Bad.vue",
        `<template>\n  <div>\n    <span>hello\n  </div>\n</template>\n<script setup lang="ts">\nconst x = 1\n</script>`, knownFor({}));
    ok(p1.length > 0, "坑①变体：模板标签不闭合被打回", JSON.stringify(p1));

    // checkPy 主路：py 括号不闭合（有 python 走真 py_compile，无 python 走配平退化——两路都必须红）
    const p4 = await checkFile("backend/app/routers/todo.py",
        `def create(item: str):\n    return {"item": item  # 少个括号`, knownFor({}));
    ok(p4.length > 0 && /py_compile|括号|配平|闭合/.test(p4.join("")), "py 语法错被打回（py_compile/配平双路）", JSON.stringify(p4));

    // 附加红样：ts 纯语法炸 + JSON 塌 + css 引用到空
    ok((await checkFile("backend/x.ts", `function f( {`, knownFor({}))).length > 0, "esbuild 语法闸：ts 残缺被打回");
    ok((await checkFile("frontend/package.json", `{"name": ,}`, knownFor({}))).length > 0, "JSON parse 闸被打回");
    ok((await checkFile("frontend/src/main.ts", `import "./styles/missing.css";\nconsole.log(1);`, knownFor({}))).length > 0, "副作用 import 引用到空也被打回");

    // ============================================================
    console.log("=== ② GREEN：好码零误杀 ===");

    // 正常 SFC：script setup + 已知兄弟文件 + bare 包 + .vue 组件（隐式默认导出，不核名）
    const goodKnown = knownFor({
        "frontend/src/utils/request.ts": `const request = { get: () => null };\nexport default request;`,
        "frontend/src/views/LoginView.vue": `<template><div>login</div></template>`,
        "frontend/src/styles/theme.css": `body { margin: 0 }`,
    });
    const goodSfc = `<script setup lang="ts">\nimport { ref } from "vue";\nimport request from "../utils/request";\nimport LoginView from "./LoginView.vue";\nimport "../styles/theme.css";\nconst x = ref(0);\nrequest.get();\n</script>\n<template>\n  <div><LoginView /><t-button v-if="x">{{ x }}</t-button></div>\n</template>\n<style scoped>.a { color: red }</style>`;
    ok((await checkFile("frontend/src/views/Home.vue", goodSfc, goodKnown)).length === 0, "正常 .vue（多 import 形态）放行");

    // 多行 import（大括号内换行不能触发垃圾子句降级——实际降级也只是放行，验证核名仍生效）
    const multiLine = `import {\n  login,\n} from "./auth";\nlogin();`;
    ok((await checkFile("frontend/src/api/main.ts", multiLine, authKnown)).length === 0, "多行 import + 存在的导出名放行");
    const multiLineBad = `import {\n  nope,\n} from "./auth";\nnope();`;
    ok((await checkFile("frontend/src/api/main.ts", multiLineBad, authKnown)).length > 0, "多行 import 的坏导出名仍被拒");

    // 拿不准一律放行：export* 转发 / import type / 命名空间 / as 别名 / 计划内未生成
    const skipKnown = knownFor(
        { "frontend/src/t1.ts": `export * from "./t2";`, "frontend/src/t1b.ts": `export interface Ghost { a: string }` },
        ["frontend/src/future.ts"]);
    ok((await checkFile("frontend/src/a.ts", `import { whatever } from "./t1";\nwhatever();`, skipKnown)).length === 0, "export * 转发：跳过名核验放行");
    ok((await checkFile("frontend/src/b.ts", `import type { Ghost } from "./t1b";\nlet g: Ghost;\nvoid g;`, skipKnown)).length === 0, "import type 不核名");
    ok((await checkFile("frontend/src/c.ts", `import * as ns from "./t1";\nns.x();`, skipKnown)).length === 0, "命名空间导入放行");
    ok((await checkFile("frontend/src/d.ts", `import { login as doLogin } from "./auth";\ndoLogin();`, knownFor({
        "frontend/src/auth.ts": `export function login() {}`,
    }) )).length === 0, "as 别名按本文件用到的名校验：正确别名放行");
    ok((await checkFile("frontend/src/e.ts", `import { notYetKnown } from "./future";\nnotYetKnown();`, skipKnown)).length === 0, "计划内未生成文件：存在性过、内容未知跳名核验");

    // 坑②原版场景（interface 有定义但被当值导入）：闸门不当判官（值/类型使用判定太深）——记录边界，不误杀也不假拒
    ok((await checkFile("frontend/src/api/f.ts", `import { Session } from "./auth";\nconst s: Session = { id: "1" };\nvoid s;`, authKnown)).length === 0,
        "interface 被命名导入（类型位使用）：不误杀（F5② 全量归 T6 运行时审，诚实边界）");

    // 认识不了的全家放行：.java/.yml/.md/.scss/.html
    for (const f of ["backend/App.java", "docker-compose.yml", "README.md", "frontend/src/a.scss", "public/index.html"]) {
        ok((await checkFile(f, "whatever {{{ broken???", knownFor({}))).length === 0, `未认识格式放行：${f}`);
    }

    // py 好码（f-string 带括号 + 注释带干扰 + 三引号 docstring）
    const pyGood = `"""doc (unbalanced in docstring]\n"""\ndef greet(name: str):\n    msg = f"hi {name} ({len(name)})"  # ) 干扰注释\n    return {"m": msg}`;
    ok((await checkFile("backend/app/main.py", pyGood, knownFor({}))).length === 0, "py 好码放行（f-string/注释/三引号干扰项）");

    // ============================================================
    console.log("=== ③ 自修环模拟（stub 替代 LLM，同构 generateFile 接线） ===");

    const vuePath = "frontend/src/views/Login.vue";
    const loopKnown = knownFor({});
    const badVue = `<template>\n  <div><span>oops\n</template>`;
    const fixedVue = `<template>\n  <div><span>ok</span></div>\n</template>\n<script setup lang="ts">\nconst a = 1\n</script>`;

    // 复刻工位骨架：attempt≤3，闸门红→gateFeedback 续轮；耗尽→null（文件失败走返工）
    async function simulate(attempts: (string | null)[]) {
        let feedback = "", calls = 0;
        for (let attempt = 1; attempt <= 3; attempt++) {
            calls++;
            const code = attempts[attempt - 1];
            if (!code) return { result: null, calls, feedback };   // 模拟提取失败
            const problems = await checkFile(vuePath, code, loopKnown);
            if (problems.length > 0) {
                if (attempt < 3) { feedback = gateFeedback(attempt, problems); continue; }
                return { result: null, calls, feedback };
            }
            return { result: code, calls, feedback };
        }
        return { result: null, calls, feedback };
    }

    const first = await simulate([badVue, fixedVue]);
    ok(first.result === fixedVue && first.calls === 2, "首轮坏文件被打回，二轮自修后绿", `result=${!!first.result} calls=${first.calls}`);
    ok(first.feedback.includes("编译闸门打回") && first.feedback.includes("第 1 次"), "打回话术带轮次");
    ok(first.feedback.length <= 660, `feedback 截断 ≤600 字+话术头（p2 修③ 400→600，实测 ${first.feedback.length} 字符）`);

    const exhausted = await simulate([badVue, badVue, badVue]);
    ok(exhausted.result === null && exhausted.calls === 3, "打回耗尽：判文件失败（宁失败不交坏码）");

    // ============================================================
    console.log("=== ④ bootstrap 批校验（批内互引） ===");
    const disk = knownFor({});
    const batchGood = await checkBatch([
        { path: "frontend/src/main.ts", content: `import App from "./App.vue";\nconsole.log(App);` },
        { path: "frontend/src/App.vue", content: `<template><div>app</div></template>` },
        { path: "frontend/package.json", content: `{"name":"fe","dependencies":{"vue":"^3"}}` },
    ], disk);
    ok(batchGood.size === 0, "地基批内互引（main→App.vue）全绿放行", JSON.stringify([...batchGood]));
    const batchBad = await checkBatch([
        { path: "frontend/src/main.ts", content: `import App from "./App.vue";\nconsole.log(App);` },   // App.vue 不在批里
    ], disk);
    ok(batchBad.size === 1 && (batchBad.get("frontend/src/main.ts") ?? []).join("").includes("App.vue"),
        "地基批引用缺失被打回（retryStructured 会截 400 字喂回）", JSON.stringify([...batchBad]));

    // ============================================================
    console.log("=== ⑤ p2 复盘修②③（9/9）：文件树注入 + 打回附候选 ===");

    // list()：内存层展示保原始大小写、排序；匹配仍大小写不敏感（normRel 归一）
    const caseKnown = knownFor({
        "frontend/src/Utils/MyRequest.ts": `const r = {}; export default r;`,
        "frontend/src/views/Login.vue": `<template><div/></template>`,
    });
    const listed = caseKnown.list();
    ok(listed.length === 2 && listed.includes("frontend/src/Utils/MyRequest.ts"), "list() 保原始大小写", JSON.stringify(listed));
    ok(listed[0] === "frontend/src/Utils/MyRequest.ts" && listed[1] === "frontend/src/views/Login.vue", "list() 按路径排序", JSON.stringify(listed));
    ok(caseKnown.has("frontend/src/utils/myrequest.ts"), "匹配仍大小写不敏感（归一化没破）");

    // 文件树注入：空树旁路；cap 溢出如实标注
    ok(fileTreePrompt(knownFor({})) === "", "空 known：树段整段省略（旁路，不污染 prompt）");
    const many = new Map<string, string>();
    for (let i = 0; i < 85; i++) many.set(`src/f${i}.ts`, "export default 1;");
    const tree85 = formatFileTree(buildKnown(null, many));
    ok(tree85.includes("共 85 个文件") && tree85.includes("其余 5 个略"), "cap=80 溢出省略标注", tree85.slice(-40));
    const tp = fileTreePrompt(knownFor({ "x.ts": "export default 1;" }));
    ok(tp.includes("项目文件树") && tp.includes("x.ts") && tp.includes("不得发明该路径"), "fileTreePrompt 段头+规矩齐");

    // 修③候选·导出名命中：getUsers 真身在 services/api.js，ghost 路径指 utils/request
    const candKnown = knownFor({
        "frontend/src/services/api.js": `const api = { get: () => null };\nexport function getUsers() { return [] }\nexport default api;`,
        "frontend/src/router/index.js": `export default [];`,
    });
    const candProblems = await checkFile("frontend/src/views/UserList.vue",
        `<script setup>\nimport { getUsers } from "../utils/request";\nconst u = getUsers();\n</script>\n<template><div>{{ u }}</div></template>`, candKnown);
    const candJoined = candProblems.join("；");
    ok(candJoined.includes("候选") && candJoined.includes("../services/api.js") && candJoined.includes("getUsers"),
        "打回带候选：导出名命中 + 从当前文件算好的相对 spec", candJoined.slice(0, 180));

    // 修③候选·路径名相似：../middleware/verify（单数）→ 真身 middlewares/verify（复数，p2 杂散打回同款）
    const simKnown = knownFor({ "backend/src/middlewares/verify.ts": `export default function verify() {}` });
    const simProblems = await checkFile("backend/src/routes/user.ts", `import v from "../middleware/verify";\nexport const w = v;`, simKnown);
    ok(simProblems.join("；").includes("../middlewares/verify.ts"), "路径名相似候选：单复数漂移被逮住", simProblems.join("；").slice(0, 180));

    // 修③底线：无候选不硬凑（宁漏不误带）——报错文案维持原样
    const noneKnown = knownFor({ "frontend/src/main.ts": `console.log(1);` });
    const noneProblems = await checkFile("frontend/src/views/X.vue",
        `<script setup>\nimport { magic } from "../utils/unicorn";\n</script>\n<template><div/></template>`, noneKnown);
    const noneJoined = noneProblems.join("；");
    ok(noneJoined.includes("不存在") && !noneJoined.includes("候选"), "凑不出候选：只报原错，不硬带（宁漏不误带）", noneJoined.slice(0, 140));

    // default-only import 不算导出信号（人人都有 default，带出来是噪音）
    const noiseKnown = knownFor({ "backend/app.js": `export default {};` });
    const noiseProblems = await checkFile("backend/index.js", `import cfg from "./config";\nconsole.log(cfg);`, noiseKnown);
    ok(!noiseProblems.join("；").includes("候选"), "default 导出不进候选（防人人都是候选的噪音）", noiseProblems.join("；").slice(0, 120));

    // ============================================================
    console.log(`\n=== 汇总：${pass} 绿 / ${fail} 红 ===`);
    if (fail > 0) process.exit(1);
}

main().catch(e => { console.error("冒烟脚本自身炸了:", e); process.exit(2); });
