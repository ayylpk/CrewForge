// ============================================================
// foundation-smoke.ts —— p3 复盘手术（S1~S5 机械执法件）冒烟（9/9）
//
//   覆盖：①enforceEngineFoundation：入口件剔除/模板补位/backend 路径归一/依赖合并/Fastify 防御
//         ②tidyExecTasks：引擎件剔除 + 跨任务文件去重让渡 + 技术基线注入
//         ③bannedDependencyList：SQLite 栈推禁用包（正反例）
//         ④registerRoutes：模板创建 → 机械登记 → 幂等（tmp 沙箱，DB 指向不存在库=落空旁路）
//         ⑤pairIntegrationCheck：字面量比对三态（红/绿/拿不准放行）
//   ⚠️ 家法同 t7b-smoke：先立 env 再动态 import（runEnv 的 RUNS_ROOT 模块期定格）
//   跑法：bun run foundation-smoke.ts
// ============================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "crew-fdn-"));
process.env.RUNS_ROOT = TMP;
process.env.PROJECT_ID = "908";
process.env.DB_NAME = "crewforge_smoke_no_such_db";   // writeWorkspace 的落库 upsert 连不上只 warn（旁路实证，不污染真库）

const {
    enforceEngineFoundation, tidyExecTasks, bannedDependencyList,
    registerRoutes, pairIntegrationCheck, rebaseBackendPath, isEngineOwned,
    canonicalizeRoot, ROUTER_INDEX_TS, ENGINE_OWNED,
} = await import("./foundation");

let pass = 0, fail = 0;
function ok(cond: boolean, label: string, extra = "") {
    if (cond) { pass++; console.log(`  ✓ ${label}`); }
    else { fail++; console.log(`  ✗ ${label} ${extra}`); }
}
const task = (id: string, layer: "backend" | "frontend", files: string[], description = "d"): any =>
    ({ id, layer, files, description, method: "GET", path: "/api/x", title: id, parameters: [], acceptance: "a" });

async function main() {
    console.log("=== ① enforceEngineFoundation（bootstrap 整形） ===");
    const batch = [
        { path: "frontend/package.json", content: JSON.stringify({ dependencies: { vue: "^3.5.0" } }) },
        { path: "backend/pom.xml", content: "<project></project>" },
        { path: "frontend/src/main.ts", content: "// 模型自产，应被剔除" },              // 撞引擎件 → 让位模板
        { path: "backend/controllers/auth.js", content: "module.exports = {};" },       // 归一 → backend/src/controllers
        { path: "backend/routers/auth.js", content: "module.exports = {};" },           // 归一 → backend/src/routers
    ];
    enforceEngineFoundation(batch);
    ok(!batch.some(f => f.path === "frontend/src/main.ts" && f.content.includes("模型自产")), "模型自产入口件被剔除");
    ok(!!batch.find(f => f.path === "frontend/src/main.ts" && f.content.includes("createApp")), "引擎 main.ts 模板补位");
    ok(!!batch.find(f => f.path === "frontend/src/App.vue") && !!batch.find(f => f.path === "frontend/src/router/index.ts"), "App.vue + router 模板补位");
    ok(!batch.some(f => f.path === "backend/src/app.js"), "Spring Boot 后端不注入 Express app.js");
    ok(!!batch.find(f => f.path === "backend/src/controllers/auth.js") && !!batch.find(f => f.path === "backend/src/routers/auth.js"), "backend 路径归一到 src/ 下");
    const fePkg = JSON.parse(batch.find(f => f.path === "frontend/package.json")!.content);
    ok(!!fePkg.dependencies["vue-router"], "前端包合并 vue-router");
    ok(!!fePkg.dependencies["element-plus"], "前端包合并 Element Plus");
    // Node 后端文件不再被当成 CrewForge 的默认地基
    const fas = [
        { path: "backend/package.json", content: JSON.stringify({ dependencies: { fastify: "^4" } }) },
        { path: "backend/routes/x.js", content: "" },
    ];
    enforceEngineFoundation(fas);
    ok(!fas.some(f => f.path === "backend/src/app.js") && !!fas.find(f => f.path === "backend/src/routes/x.js"), "Node 后端批：不注入 Express 模板，归一仍生效");
    ok(isEngineOwned("frontend/src/router/index.ts") && !isEngineOwned("backend/src/app.js") && !isEngineOwned("frontend/src/views/A.vue"), "引擎件名单判定");
    ok(!isEngineOwned("backend/src/app.ts") && !isEngineOwned("backend/src/server.ts"), "Spring Boot 不误判 Node 入口");
    ok(rebaseBackendPath("backend/models/A.js") === "backend/src/models/A.js" && rebaseBackendPath("backend/src/x.js") === "backend/src/x.js", "rebase 幂等");
    ok(ENGINE_OWNED.length === 4, "引擎拥有件 = 4");
    // 根 src/ 歪树（p3 二轮实锤：模型把后端写在工程根 src/，backend/ 规则罩不住）
    const skew = [
        { path: "frontend/package.json", content: JSON.stringify({ dependencies: { vue: "^3", vite: "^7" } }) },
        { path: "frontend/index.html", content: "<html><body></body></html>" },
        { path: "src/app.ts", content: "// Nest 姿势歪入口" },
        { path: "src/routes/index.ts", content: "// 歪树路由" },
    ];
    enforceEngineFoundation(skew);
    ok(!!skew.find(f => f.path === "backend/src/routes/index.ts"), "根 src/** 收编进 backend/src/**");
    ok(!skew.find(f => f.path === "backend/src/app.ts") && !skew.find(f => f.path === "backend/src/app.js"), "后端歪入口不注入 Express 模板");
    ok(!!skew.find(f => f.path === "frontend/index.html"), "非歪件不误伤");

    // 根名一统（p4 首战补刀，9/9）：模型爱用 server/、web/ 当工程根，引擎模板锚定 frontend/+backend/
    console.log("--- canonicalizeRoot（根名方言归一） ---");
    ok(canonicalizeRoot("server/src/config/redis.ts") === "backend/src/config/redis.ts", "server/ → backend/");
    ok(canonicalizeRoot("web/src/views/Login.vue") === "frontend/src/views/Login.vue", "web/ → frontend/");
    ok(canonicalizeRoot("client/pages/a.vue") === "frontend/pages/a.vue", "client/ → frontend/");
    ok(canonicalizeRoot("ui/x.ts") === "frontend/x.ts", "ui/ → frontend/");
    ok(canonicalizeRoot("backend/src/app.js") === "backend/src/app.js", "已规范名不动（幂等）");
    ok(canonicalizeRoot("frontend/src/views/Observers.vue") === "frontend/src/views/Observers.vue", "observe* 不误伤（前缀撞词防御）");
    ok(canonicalizeRoot("myserver/app.js") === "myserver/app.js", "server 作后缀不误伤（词边界）");
    ok(canonicalizeRoot("feedback/x.ts") === "feedback/x.ts", "feed 开头不误伤");
    ok(canonicalizeRoot("web") === "web" && canonicalizeRoot("server") === "server", "裸根名无斜杠不动（不误改成 frontend/backend）");
    ok(canonicalizeRoot("WEB/x.ts") === "frontend/x.ts", "大小写不敏感");
    ok(canonicalizeRoot("server\\a\\b.ts") === "backend/a/b.ts", "反斜杠先归一再改根");
    // 端到端：rebaseBackendPath 已内建 canonicalizeRoot，server/ 根的路径归一也走通
    ok(rebaseBackendPath("server/models/Account.js") === "backend/src/models/Account.js", "server/ 根经 rebase 落到 backend/src/");
    // enforceEngineFoundation 端到端：web/+server/ 混批 → 归一到 frontend/+backend/ 且模板补位
    const dialect = [
        { path: "web/src/main.ts", content: "// 模型自产 web 根入口，应先归一再剔除" },
        { path: "server/routes/auth.js", content: "module.exports = {};" },
    ];
    enforceEngineFoundation(dialect);
    ok(dialect.some(f => f.path === "frontend/src/main.ts" && f.content.includes("createApp")), "web/src/main.ts 归一后让位引擎模板");
    ok(dialect.some(f => f.path === "backend/src/routers/auth.js" || f.path === "backend/src/routes/auth.js"), "server/routes 归一到 backend/src/");
    ok(!dialect.some(f => /^(web|server)[\\/]/.test(f.path)), "整形后批内不再有 web/、server/ 根残留");

    console.log("=== ② tidyExecTasks（拆分整风） ===");
    const tasks = [
        task("T1", "backend", ["backend/routers/a.js", "backend/models/Account.js"]),
        task("T1-F", "frontend", ["frontend/src/views/A.vue", "frontend/src/main.ts", "frontend/src/router/index.ts"]),
        task("T2", "backend", ["backend/models/Account.js", "backend/routers/b.js"]),
    ];
    const tidied = tidyExecTasks(tasks, { techniques: { database: { type: "SQLite" }, middleware: [] } });
    ok(!tidied[1]!.files.some(f => /main\.ts|router\/index/.test(f)), "引擎件从任务 files 剔除（main/router 模型不再碰）");
    ok(tidied[0]!.files.join() === "backend/src/routers/a.js,backend/src/models/Account.js", "任务路径同步归一", tidied[0]!.files.join());
    ok(tidied[2]!.files.join() === "backend/src/routers/b.js", "T2 的共享模型 Account.js 让渡给 T1（S3 去重）", tidied[2]!.files.join());
    ok(tidied[2]!.description.includes("只 import") && tidied[2]!.description.includes("T1"), "让渡注记进 description");
    ok(tidied[0]!.description.includes("技术基线") && tidied[0]!.description.includes("mysql2"), "【技术基线】硬约束段机械注入");

    console.log("=== ③ bannedDependencyList ===");
    ok(bannedDependencyList({ techniques: { database: { type: "SQLite" }, middleware: [{ name: "express-session" }] } }).includes("mysql2"), "SQLite 栈禁 mysql2");
    ok(!bannedDependencyList({ techniques: { database: { type: "MySQL" } } }).includes("mysql2"), "MySQL 栈不禁 mysql2");
    ok(bannedDependencyList({ x: "redis session store" }).includes("redis") === false, "中间件点名 Redis → 不禁 redis（栈内自洽优先）");
    ok(bannedDependencyList(null).length === 0, "无栈信息（契约降级）：无从判断，不误禁");
    ok(bannedDependencyList({ a: 1 }).includes("redis"), "有栈但没提 Redis：禁 Redis 全家（需求漂移防御）");
    ok(rebaseBackendPath("backend/package.json") === "backend/package.json", "backend 根平铺件不动（package.json 留在安装根，冒烟逮出的真 bug）");

    console.log("=== ④ registerRoutes（路由机械登记，tmp 沙箱） ===");
    const contractMd = "# 契约\n## 页面清单\n- /login → frontend/src/views/Login.vue（登记任务 T1-F）\n- (组件) → frontend/src/components/X.vue（登记任务 T1-F）\n";
    const ftask = task("T1-F", "frontend", ["frontend/src/views/Login.vue"]);
    const n1 = await registerRoutes(908, ftask, contractMd);
    const routerFile = path.join(TMP, "p908", "frontend/src/router/index.ts");
    const rtxt = fs.existsSync(routerFile) ? fs.readFileSync(routerFile, "utf-8") : "";
    ok(n1 === 1 && rtxt.includes('path: "/login"') && rtxt.includes('import("../views/Login.vue")'), "无中生长出路由表并登记 1 条", rtxt.slice(0, 80));
    ok(rtxt.includes("// {{ROUTES}}"), "登记缝保留");
    const n2 = await registerRoutes(908, ftask, contractMd);
    ok(n2 === 0 && fs.existsSync(routerFile), "重复登记幂等（同 view 不再追加）");
    ok((await registerRoutes(908, task("T9", "backend", ["x.js"]), contractMd)) === 0, "后端任务=零操作");
    ok((await registerRoutes(null, ftask, contractMd)) === 0, "无 pid=旁路零操作");

    console.log("=== ⑤ pairIntegrationCheck（集成预检三态） ===");
    const back = task("T1", "backend", ["backend/src/routers/auth.js"]);
    back.description = "包含接口：\n- POST /api/admin/login（登录）\n- GET /api/admin/me（自身信息）";
    const front = task("T1-F", "frontend", ["frontend/src/api/adminAuth.js"]);
    const goodBack = ["router.post('/api/admin/login', fn)\nrouter.get('/api/admin/me', fn)"];
    const goodFront = ["request.post('/admin/login', data)\nrequest.get('/admin/me')"];
    ok(pairIntegrationCheck(back, front, goodBack, goodFront).length === 0, "契约/路由/调用三方咬合=绿（baseURL 前缀归一）");
    const missBack = pairIntegrationCheck(back, front, ["router.post('/api/admin/login', fn)"], goodFront);
    ok(missBack.length === 1 && missBack[0]!.includes("GET /api/admin/me") && missBack[0]!.includes("后端未实现"), "后端缺实现点名接口", JSON.stringify(missBack));
    const ghostFront = pairIntegrationCheck(back, front, goodBack, [...goodFront, "request.delete('/admin/nuke')"]);
    ok(ghostFront.some(p => p.includes("前端调用") && p.includes("DELETE /api/admin/nuke")), "前端发明接口点名", JSON.stringify(ghostFront));
    ok(pairIntegrationCheck(back, front, ["const app = express() // 没有字面量路由"], []).length === 0, "提取不到=放行（宁漏不误杀）");
    ok(pairIntegrationCheck(back, front, ["app.get('port', () => 1)"], []).length === 0, "app.get('port') 配置读取不误判成路由");
    // ${id} 模板段与 {id} 参数段归一互认
    ok(pairIntegrationCheck(
        task("T", "backend", []), front,
        ["router.delete('/api/articles/:id', fn)"],
        ["request.delete(`/articles/${articleId}`)"],
    ).length === 0, ":id 与 ${id} 归一互认（DELETE /api/articles/:id）");

    console.log(`\n=== 汇总：${pass} 绿 / ${fail} 红 ===`);
    await new Promise(r => setTimeout(r, 300));    // 等 writeWorkspace 的落库 warn 落完（连不上=warn 旁路）
    fs.rmSync(TMP, { recursive: true, force: true });
    if (fail > 0) process.exit(1);
    process.exit(0);
}

main().catch(e => { console.error("冒烟脚本自身炸了:", e); process.exit(2); });
