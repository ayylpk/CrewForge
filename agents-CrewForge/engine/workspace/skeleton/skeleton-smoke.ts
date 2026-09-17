// ============================================================
// skeleton-smoke.ts —— 引擎骨架直出自测（零 LLM、零网络、纯内存断言）
//
//   钉死的病根（每条断言都对应一次真实翻车）：
//     ① 路径漂移：骨架路径集合必须**恰好**是登记的那一批，不缺不多（runs/p1 四套目录约定）
//     ② 入口缺失：index.html 的 #app 与 /src/main.ts 必须与 main.ts 的 mount("#app") 对得上（runs/p9）
//     ③ 构建/依赖不可信：package.json 必须可解析且有 build；pom.xml 必须是 Spring Boot 3 + Java 17 + MyBatis-Plus + MySQL
//     ④ ★ 数据库配置硬编码：application.yml 只能有 ${SPRING_DATASOURCE_*}，不许有任何字面量地址/账号/口令回落
//     ⑤ ★ schema.sql 必须真执行：spring.sql.init.mode=always + classpath:schema.sql
//     ⑥ ★ 路由铁律：主页面必须同时注册到自己的 path 和 "/"，否则 "/" 是空 router-view 白屏
//     ⑦ ★ DDL 归一化：CREATE DATABASE / USE 剥掉、CREATE TABLE 补 IF NOT EXISTS、幂等
//
//   运行：bun run engine/workspace/skeleton/skeleton-smoke.ts
// ============================================================

import { ENGINE_OWNED_PATHS, SKELETON_PATHS, normalizeDdl, renderSkeleton } from "./springVueMysql";
import type { SkeletonFile } from "./springVueMysql";

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string): void {
    if (cond) { pass++; console.log(`  ✓ ${msg}`); }
    else { fail++; console.log(`  ✗ ${msg}`); }
}
function note(msg: string): void { console.log(`  ~ ${msg}`); }

/** 归一化：小写 + 正斜杠（与写盘纪律同一条口径） */
function normPath(p: string): string {
    return (p ?? "").replace(/\\/g, "/").replace(/^\.\/+/, "").toLowerCase();
}

/** 规格逐条列出的骨架路径（前端 9 + 后端 4 = 13 条；规格文字里写作"12 个路径"，按下表为准） */
const EXPECTED_PATHS: string[] = [
    "frontend/index.html",
    "frontend/package.json",
    "frontend/vite.config.ts",
    "frontend/tsconfig.json",
    "frontend/src/main.ts",
    "frontend/src/App.vue",
    "frontend/src/style.css",
    "frontend/src/router/index.ts",
    "frontend/src/utils/request.ts",
    "backend/pom.xml",
    "backend/src/main/java/com/crewforge/Application.java",
    "backend/src/main/resources/application.yml",
    "backend/src/main/resources/schema.sql",
];

/** 架构师风格的 DDL 原文：含建库/切库、字符串里的分号、中文注释、`;;` */
const DDL = [
    "-- 建库与切库：库名由连接串决定，必须被 normalizeDdl 剥掉",
    "CREATE DATABASE `note_db` DEFAULT CHARACTER SET utf8mb4;",
    "USE `note_db`;",
    "",
    "-- 笔记表",
    "create table `note` (",
    "  `id` BIGINT NOT NULL AUTO_INCREMENT,",
    "  `title` VARCHAR(200) NOT NULL COMMENT '标题; 这里的分号在字符串里，不算语句分隔符',",
    "  `body` TEXT NULL,",
    "  PRIMARY KEY (`id`)",
    ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;",
    ";;",
].join("\n");

const FILES: SkeletonFile[] = renderSkeleton({
    appName: "note-app",
    title: "笔记应用",
    ddl: DDL,
    routes: [
        { path: "/note/list", component: "views/NoteList.vue" },
        { path: "/note/create", component: "views/NoteCreate.vue", name: "note-create" },
    ],
    primaryRoute: "/note/list",
});

const byPath = new Map<string, string>(FILES.map(f => [f.path, f.content]));
function content(path: string): string { return byPath.get(path) ?? ""; }

/** 从 router 源码里抠出某个 path 注册的 component（拿不到返回空串） */
function componentOf(routerSource: string, path: string): string {
    const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`path:\\s*"${escaped}"[^}]*import\\("([^"]+)"\\)`).exec(routerSource);
    return m?.[1] ?? "";
}

console.log("=== ① 路径集合：恰好这批，不缺不多 ===");
{
    const got = FILES.map(f => normPath(f.path)).sort();
    const expect = EXPECTED_PATHS.map(normPath).sort();
    ok(got.length === expect.length, `路径条数一致（期望 ${expect.length}，实际 ${got.length}）`);
    const onlyInGot = got.filter(p => !expect.includes(p));
    const onlyInExpect = expect.filter(p => !got.includes(p));
    ok(onlyInGot.length === 0 && onlyInExpect.length === 0,
        `★ 路径集合完全一致（多出：${onlyInGot.join("|") || "无"}；缺失：${onlyInExpect.join("|") || "无"}）`);
    ok(FILES.every(f => !f.path.includes("\\") && !f.path.startsWith("./") && !f.path.startsWith("/")),
        "路径形态规范（相对路径 + 正斜杠；Application.java 保留真实大小写——Java 类名必须与文件名一致）");
    ok(FILES.every(f => f.owner === "engine"), "所有件 owner=engine（骨架由引擎拥有）");
    ok(new Set(got).size === got.length, "无重复路径");
    ok(new Set(SKELETON_PATHS.map(normPath)).size === expect.length && expect.every(p => SKELETON_PATHS.map(normPath).includes(p)),
        "导出的 SKELETON_PATHS 与规格清单同源");
    ok(FILES.every(f => f.content.trim().length > 0), "每个骨架件都不是空文件");
}

console.log("=== ② 前端入口：index.html / main.ts / App.vue ===");
{
    const html = content("frontend/index.html");
    ok(html.includes('<div id="app">'), 'index.html 含 <div id="app">');
    ok(html.includes('src="/src/main.ts"'), 'index.html 含 src="/src/main.ts"');
    ok(html.includes("<title>笔记应用</title>"), "title 用传入的 o.title");
    const main = content("frontend/src/main.ts");
    ok(main.includes('mount("#app")'), 'main.ts mount("#app") 与 index.html 的挂载点一致');
    ok(main.includes('./style.css') || main.includes('"./style.css"'), "main.ts 导入 ./style.css");
    ok(/app\.use\(router\)/.test(main), "main.ts use(router)");
    ok(/app\.use\(ElementPlus\)/.test(main), "main.ts use(ElementPlus)");
    ok(content("frontend/src/App.vue").trim() === "<template>\n  <router-view />\n</template>", "App.vue 只含 <template><router-view /></template>");
    ok(content("frontend/src/style.css").includes("--cf-"), "style.css 定义 --cf-* 设计 token（业务样式引用它）");
}

console.log("=== ③ 构建文件：package.json / vite.config.ts / tsconfig.json ===");
{
    const raw = content("frontend/package.json");
    let pkg: { name?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
    let parsed = false;
    try { pkg = JSON.parse(raw) as typeof pkg; parsed = true; } catch { parsed = false; }
    ok(parsed, "package.json 可 JSON.parse");
    ok(pkg.scripts?.build === "vite build", `scripts.build 存在且为 vite build（${pkg.scripts?.build ?? "缺失"}）`);
    ok(pkg.scripts?.dev === "vite" && pkg.scripts?.preview === "vite preview", "scripts.dev / scripts.preview 就位");
    ok(pkg.name === "note-app", `package.json name 用 o.appName（${pkg.name ?? "缺失"}）`);
    ok(!!pkg.dependencies?.vue && !!pkg.dependencies?.["vue-router"] && !!pkg.dependencies?.["element-plus"] && !!pkg.dependencies?.axios,
        "dependencies: vue / vue-router / element-plus / axios");
    ok(!!pkg.devDependencies?.vite && !!pkg.devDependencies?.["@vitejs/plugin-vue"] && !!pkg.devDependencies?.typescript && !!pkg.devDependencies?.["vue-tsc"],
        "devDependencies: vite / @vitejs/plugin-vue / typescript / vue-tsc");

    const vite = content("frontend/vite.config.ts");
    ok(vite.includes("@vitejs/plugin-vue"), "vite.config.ts 用 @vitejs/plugin-vue");
    ok(/port:\s*5173/.test(vite), "dev server 端口 5173");
    ok(vite.includes('"/api"') && vite.includes("http://127.0.0.1:8080"), "/api 代理到 http://127.0.0.1:8080");

    let tsconfig: { compilerOptions?: Record<string, unknown>; include?: string[] } = {};
    let tsParsed = false;
    try { tsconfig = JSON.parse(content("frontend/tsconfig.json")) as typeof tsconfig; tsParsed = true; } catch { tsParsed = false; }
    ok(tsParsed, "tsconfig.json 可 JSON.parse（最小可构建配置）");
    ok(!!tsconfig.compilerOptions && (tsconfig.include ?? []).some(i => i.includes("src/")), "tsconfig 覆盖 src/（含 .vue）");
}

console.log("=== ④ 后端构建与基础包：pom.xml / Application.java ===");
{
    const pom = content("backend/pom.xml");
    ok(pom.includes("spring-boot-starter-parent"), "pom 继承 spring-boot-starter-parent");
    ok(/<artifactId>spring-boot-starter-parent<\/artifactId>\s*<version>3\./.test(pom), "Spring Boot 父版本是 3.x");
    ok(pom.includes("mybatis-plus"), "pom 含 mybatis-plus（spring-boot3 starter）");
    ok(pom.includes("mysql-connector"), "pom 含 mysql-connector");
    ok(/<java\.version>17<\/java\.version>/.test(pom), "java.version = 17");
    ok(pom.includes("spring-boot-maven-plugin"), "配置 spring-boot-maven-plugin");
    ok(pom.includes("spring-boot-starter-web") && pom.includes("spring-boot-starter-validation") && pom.includes("spring-boot-starter-test"),
        "web / validation / test 依赖齐备");
    ok(!/lombok/i.test(pom) && !/<groupId>org\.projectlombok<\/groupId>/.test(pom), "★ 不引入 Lombok（依赖与文案都不出现）");

    const app = content("backend/src/main/java/com/crewforge/Application.java");
    ok(app.startsWith("package com.crewforge;"), "Application.java 在基础包 com.crewforge");
    ok(app.includes("@SpringBootApplication"), "标了 @SpringBootApplication");
    ok(app.includes('@MapperScan("com.crewforge.**.mapper")'), "@MapperScan 覆盖 com.crewforge.**.mapper");
    ok(/public static void main\(String\[\] args\)/.test(app) && app.includes("SpringApplication.run(Application.class, args)"), "main 启动入口就位");
}

console.log("=== ⑤ application.yml：schema.sql 真执行 + 数据库配置只来自环境变量 ===");
{
    const yml = content("backend/src/main/resources/application.yml");
    ok(/port:\s*\$\{SERVER_PORT:8080\}/.test(yml), "server.port 走 ${SERVER_PORT:8080}");
    ok(/context-path:\s*\/api/.test(yml), "server.servlet.context-path: /api（整条 API 前缀在此，控制器不再写 /api）");
    ok(/application:\s*\n\s*name:\s*"note-app"/.test(yml), "spring.application.name 用 o.appName");

    const sqlInit = /  sql:\n    init:\n(?:      #.*\n)*      mode: always\n      schema-locations: classpath:schema\.sql\n/.test(yml);
    ok(/mode:\s*always/.test(yml), "含 spring.sql.init.mode 且值为 always");
    ok(/schema-locations:\s*classpath:schema\.sql/.test(yml), "含 schema-locations 且指向 classpath:schema.sql");
    ok(sqlInit, "★ mode/schema-locations 确实在 spring.sql.init 下（不是写在别处空转）");

    ok(/map-underscore-to-camel-case:\s*true/.test(yml), "mybatis-plus map-underscore-to-camel-case: true");
    ok(/type-aliases-package:\s*com\.crewforge/.test(yml), "mybatis-plus type-aliases-package: com.crewforge");

    ok(yml.includes("${SPRING_DATASOURCE_URL}") && yml.includes("${SPRING_DATASOURCE_USERNAME}") && yml.includes("${SPRING_DATASOURCE_PASSWORD}"),
        "三个 SPRING_DATASOURCE_* 环境变量占位都在");
    ok(!/jdbc:mysql/i.test(yml), "★ 不出现硬编码 jdbc:mysql 地址");
    ok(!/spring\.datasource\.url\s*:\s*jdbc/i.test(yml), "★ 不出现 spring.datasource.url: jdbc 字面量");
    ok(!/\$\{SPRING_DATASOURCE_(URL|USERNAME|PASSWORD):/.test(yml), "★ 三个占位都没有 ':默认值' 回落");
    ok(/^\s*url:\s*\$\{SPRING_DATASOURCE_URL\}\s*$/m.test(yml), "★ url 只来自环境变量（没有字面量地址）");
    ok(/^\s*username:\s*\$\{SPRING_DATASOURCE_USERNAME\}\s*$/m.test(yml), "★ username 只来自环境变量（没有字面量账号）");
    ok(/^\s*password:\s*\$\{SPRING_DATASOURCE_PASSWORD\}\s*$/m.test(yml), "★ password 只来自环境变量（没有字面量口令）");
    ok(!/\broot\b/i.test(yml), "★ 不出现 root 之类默认账号");
}

console.log("=== ⑥ 路由铁律：主页面同时注册到自己的 path 与 \"/\" ===");
{
    const router = content("frontend/src/router/index.ts");
    ok(router.includes('createRouter({ history: createWebHistory(), routes })'), "createRouter({ history: createWebHistory(), routes })");
    ok(router.includes('"/note/list"'), "主页面自己的 path 已注册：/note/list");
    ok(router.includes('"/note/create"'), "契约里其余路由也登记了：/note/create");
    ok(router.includes('"/"'), '★ 主页面同时注册到 "/"');
    ok(componentOf(router, "/note/list") === componentOf(router, "/") && componentOf(router, "/") !== "",
        `★ "/" 与主页面指向同一 component（${componentOf(router, "/") || "未解析到"}）`);
    ok(componentOf(router, "/note/list") === "../views/NoteList.vue", "component 按 frontend/src 相对路径机械生成");
    ok((router.match(/\{ path: "\/", /g) ?? []).length === 1, '"/" 只注册一次（重复 path 会让 vue-router 丢弃后注册者）');
}

console.log('=== ⑦ request 封装：成功码 200 是冻结需求 + token 头 ===');
{
    const req = content("frontend/src/utils/request.ts");
    ok(/baseURL:\s*"\/api"/.test(req), 'baseURL 为 "/api"');
    ok(/export const SUCCESS_CODE = 200;/.test(req), "成功码写成常量 SUCCESS_CODE = 200");
    ok(/body\.code !== SUCCESS_CODE/.test(req), "响应拦截器在 code !== SUCCESS_CODE（即 200）时 reject");
    ok(req.includes("冻结需求"), "常量旁注明来源：冻结需求（不是引擎默认值）");
    ok(/localStorage\.getItem\(TOKEN_KEY\)/.test(req), "请求拦截器从 localStorage 取 token（无 token 不加头）");
    ok(/config\.headers\.Authorization = `Bearer \$\{token\}`/.test(req), "有 token 时放进 Authorization: Bearer <token>");
    ok(req.includes("export default request;"), "默认导出 axios 实例（契约桩 import request 依赖它）");
}

console.log("=== ⑧ DDL 归一化：剥建库/切库、补 IF NOT EXISTS ===");
{
    const sql = content("backend/src/main/resources/schema.sql");
    ok(!/CREATE DATABASE/i.test(sql), "★ schema.sql 里没有 CREATE DATABASE（库由连接串决定）");
    ok(!/^\s*USE\s/im.test(sql), "★ schema.sql 里没有 USE（库由连接串决定）");
    ok(/CREATE TABLE IF NOT EXISTS/.test(sql), "★ CREATE TABLE 统一补成 CREATE TABLE IF NOT EXISTS");
    ok(/CREATE TABLE IF NOT EXISTS `note`/.test(sql), "表名与列定义原样保留");
    ok(sql.includes("标题; 这里的分号在字符串里"), "字符串里的分号没被当成语句分隔符");
    ok(!/;;/.test(sql), "`;;` 与空语句已清理");
    ok(sql.endsWith("\n"), "文件以换行结尾（可直接写盘）");
    ok(normalizeDdl(DDL) === sql, "schema.sql 内容就是 normalizeDdl(o.ddl)");
    ok(normalizeDdl(normalizeDdl(DDL)) === normalizeDdl(DDL), "★ normalizeDdl 幂等（同一输入反复调用结果一致）");
    ok(normalizeDdl(normalizeDdl(normalizeDdl(DDL))) === normalizeDdl(DDL), "连续三次调用仍一致");
    ok(normalizeDdl("") === normalizeDdl(null) && normalizeDdl(null).includes("本阶段无表结构"),
        "ddl 为空 → 输出一行占位注释（说明本阶段无表结构），且不返回空文件");
    ok(renderSkeleton({ appName: "x", title: "x", routes: [], ddl: null }).find(f => f.path.endsWith("schema.sql"))?.content.includes("本阶段无表结构") === true,
        "无 DDL 时骨架里的 schema.sql 仍是占位注释文件");
    ok(normalizeDdl("CREATE TABLE IF NOT EXISTS `t` (id INT);") === normalizeDdl("create   table `t` (id INT);"),
        "已补过 IF NOT EXISTS 的与未补的归一结果一致（大小写/多空白）");
    ok(!/IF NOT EXISTS\s+IF NOT EXISTS/i.test(normalizeDdl(DDL)), "★ 不会重复补 IF NOT EXISTS（正则回退陷阱的回归钉子）");
    ok(normalizeDdl("-- 只有注释，没有语句").startsWith("-- 只有注释"), "纯注释 DDL 原样保留（不补分号、不丢注释）");
}

console.log("=== ⑨ ENGINE_OWNED_PATHS：覆盖骨架全部路径 + 历史引擎件 ===");
{
    const owned = ENGINE_OWNED_PATHS.map(normPath);
    const missing = EXPECTED_PATHS.map(normPath).filter(p => !owned.includes(p));
    ok(missing.length === 0, `★ 覆盖骨架全部 ${EXPECTED_PATHS.length} 条路径（缺失：${missing.join("|") || "无"}）`);
    ok(owned.includes("backend/src/app.js"), "含历史引擎件 backend/src/app.js");
    ok(owned.includes("frontend/src/style.css"), "含历史引擎件 frontend/src/style.css");
    ok(owned.every(p => p === p.toLowerCase() && !p.includes("\\")), "路径全部归一化（小写 + 正斜杠）");
    ok(ENGINE_OWNED_PATHS.length === new Set(owned).size, "无重复项");
}

console.log("=== ⑩ 边界：空路由契约 / primaryRoute 异常 / requestPath 覆盖 ===");
{
    // 空路由：必须可运行不报错，但要在 console 上 warn 一句
    const warns: string[] = [];
    const realWarn = console.warn;
    console.warn = ((...args: unknown[]) => { warns.push(args.map(a => String(a)).join(" ")); }) as typeof console.warn;
    let emptyRouter = "";
    let threw = false;
    try {
        const files = renderSkeleton({ appName: "empty-app", title: "空", routes: [], primaryRoute: "/nope" });
        emptyRouter = files.find(f => f.path === "frontend/src/router/index.ts")?.content ?? "";
        ok(files.length === EXPECTED_PATHS.length, "空路由契约仍产出全部骨架件（不报错）");
    } catch (e) {
        threw = true;
        note(`空路由抛错：${(e as Error).message}`);
    } finally {
        console.warn = realWarn;
    }
    ok(!threw, "★ routes 为空：renderSkeleton 不抛错");
    ok(warns.length > 0, `★ routes 为空：console 上有 warn（${warns[0] ?? ""}）`);
    ok(/const routes: RouteRecordRaw\[\] = \[/.test(emptyRouter) && !/\{ path:/.test(emptyRouter), "空路由生成的是空 routes 数组（不是坏语法）");

    // primaryRoute 不在契约里：回退第一条并 warn，"/" 仍必须是真实路由
    const warns2: string[] = [];
    console.warn = ((...args: unknown[]) => { warns2.push(args.map(a => String(a)).join(" ")); }) as typeof console.warn;
    let fallbackRouter = "";
    try {
        fallbackRouter = renderSkeleton({
            appName: "fb-app",
            title: "回退",
            routes: [{ path: "/a", component: "views/A.vue" }],
            primaryRoute: "/not-registered",
        }).find(f => f.path === "frontend/src/router/index.ts")?.content ?? "";
    } finally {
        console.warn = realWarn;
    }
    ok(warns2.length > 0, "primaryRoute 不在契约里 → warn");
    ok(fallbackRouter.includes('"/"') && componentOf(fallbackRouter, "/").endsWith("views/A.vue"),
        '★ 回退后 "/" 仍指向真实 component（不会白屏）');

    // requestPath 覆盖：只替换请求封装那一条，其余路径不动
    const custom = renderSkeleton({ appName: "x", title: "x", routes: [], requestPath: "frontend/src/api/http.ts" });
    ok(custom.length === EXPECTED_PATHS.length && custom.some(f => f.path === "frontend/src/api/http.ts") && !custom.some(f => f.path === "frontend/src/utils/request.ts"),
        "requestPath 覆盖后只替换请求封装那一条");
}

console.log(`\n[skeleton-smoke] 通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
