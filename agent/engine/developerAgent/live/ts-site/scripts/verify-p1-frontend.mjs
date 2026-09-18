// scripts/verify-p1-frontend.mjs —— ts-site P1 · 前端页面验收（TestAgent 侧，Developer 禁碰）
//
//   血泪教训 A（smoke-e2e/T4）：views/router 可能是死代码——build 照样绿。
//   血泪教训 B（本轮）：**只看状态码等于没验收**。
//     `res.send("OK")` / `res.send("Login page placeholder")` / 一个空 div
//     都能回 200。所以状态码只当入口，页面必须同时过三道真的检查：
//
//     ① 真 HTTP（vite preview 起的真服务）→ shell 结构：非空 HTML、html/body、
//        前端挂载点、引用到**实际 dist 产物文件**、body 去掉 script 后还有内容；
//        并显式拒绝 OK / hello / placeholder / coming soon 这类占位页。
//     ② 真实构建产物（dist/**/*.js，浏览器真正执行的那份）→ 每页的结构组必须
//        在产物里成立：登录页要有账号框 + 密码框 + 提交按钮 + 登录文案；项目页要有
//        列表容器 + 创建入口 + 数据渲染（/api/projects）+ 状态文案。
//        要求**几组独立结构同时成立**——含某个字符串不算过。
//     ③ 源码可达性（原有能力保留）→ router 真 use 上、路由登记、视图存在且真发 fetch。
//
//   用法：node ../scripts/verify-p1-frontend.mjs   （cwd = frontend）
//
//   一个必须如实说明的冲突（不是绕过）：
//     ts-site P1 的契约里只有 projects，router 里**没有** /login。所以登录页的结构
//     契约按"路由是否声明"决定是否执行：声明了就必须过，没声明就跳过并**打印跳过原因**。
//     既不假装检查过，也不凭空要求一个契约外的页面。判据本身（账号框/密码框/提交按钮/
//     登录文案）已经写死在下面，一旦契约加了 auth，这段检查立刻生效。
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================
// 纯函数区：页面结构判据（不碰 fs / 不碰 process，可被零 LLM 单测直接钉）
//   返回**问题清单**而不是直接退出：机器证据要能说清"缺哪一组结构"，
//   也让同一份判据既能在本脚本里用，也能在测试里用。
// ============================================================

const asAlt = (list) => list.map((r) => (r instanceof RegExp ? r : new RegExp(r, "i")));

/** 页面种类 → 必须成立的若干"结构组"；每组给多个等价写法，任选其一命中即可 */
export const PAGE_CONTRACTS = {
    home: {
        label: "首页 /",
        groups: [
            ["导航或页头", asAlt([/<\s*nav[\s>]/i, /role\s*=\s*["']navigation["']/i, /["'`]nav["'`]/, /class\s*=\s*["'][^"']*(header|navbar|nav-|topbar|app-shell|layout)/i])],
            ["页面主体", asAlt([/<\s*main[\s>]/i, /["'`]main["'`]/, /(首页|Home|CrewForge|欢迎)/i])],
            ["可识别内容区块", asAlt([/(hero|banner|jumbotron)/i, /class\s*=\s*["'][^"']*(card|panel|section|container|grid|list)/i, /(card|panel|section)/i])],
        ],
    },
    login: {
        label: "登录页 /login",
        groups: [
            ["账号输入框", asAlt([/<\s*input[^>]+type\s*=\s*["'](text|email)["']/i, /type\s*:\s*["'](text|email)["']/i, /(username|userName|email|用户名|邮箱|账号)/i])],
            ["密码输入框", asAlt([/type\s*=\s*["']password["']/i, /type\s*:\s*["']password["']/i, /(password|密码|passwd|pwd)/i])],
            ["提交 / 登录按钮", asAlt([/type\s*=\s*["']submit["']/i, /<\s*button[\s\S]{0,80}(登录|登\s*录|Login|Sign\s*in)/i, /(handleLogin|onSubmit|signIn|doLogin|登录)/i])],
            ["登录相关文案", asAlt([/(登录|Login|Sign\s*in|欢迎回来|欢迎登录)/i])],
        ],
    },
    projects: {
        label: "项目页 /projects",
        groups: [
            ["项目列表容器", asAlt([/<\s*(ul|table|ol)[\s>]/i, /["'`](ul|table)["'`]/, /class\s*=\s*["'][^"']*(list|grid|cards|projects)/i, /(project-list|projects-list|projectList|list-container)/i])],
            ["创建入口（表单 / 按钮 / 输入）", asAlt([/<\s*form[\s>]/i, /["'`]form["'`]/, /<\s*(input|button)[\s>]/i, /(创建|新增|新建|add|create|save)/i])],
            ["数据渲染（真打接口）", asAlt([/\/api\/projects/, /(fetchProjects|loadProjects|getProjects)/])],
            ["状态文案（加载 / 空态 / 标题）", asAlt([/(加载中|loading|暂无|空|empty|No\s+projects)/i, /(项目|Projects)/i])],
        ],
    },
    projectDetail: {
        label: "项目详情 /projects/:slug",
        groups: [
            ["按 slug 取数", asAlt([/\/api\/projects\/\$\{/, /\/api\/projects\/["'`]\s*\+/, /route\.params\.slug/, /params\.slug/])],
            ["详情字段渲染", asAlt([/(title|description|slug|tags|visible)/i])],
            ["状态文案", asAlt([/(加载中|loading|不存在|未找到|not\s*found|404)/i])],
        ],
    },
};

/**
 * 占位文案判据——**只对可见文本生效**。
 *   为什么不看整份 HTML：`<input placeholder="新项目标题">` 是正常业务属性，
 *   把整个 HTML 一起扫会把真页面误杀。visibleText() 已经把属性剥掉了，
 *   所以"可见文本里出现 placeholder / coming soon / TODO"必然是占位页。
 *   同理 TRIVIAL_RE 只在整页可见文本恰好是一个占位词时才成立。
 */
const PLACEHOLDER_TEXT_RE = /(lorem ipsum|coming soon|under construction|placeholder|to be implemented|nothing here yet|敬请期待|待实现|占位页)/i;
const TRIVIAL_RE = /^(ok|okay|hello|hi|hey|test|placeholder|coming soon|todo|pong)[.!。！\s]*$/i;

/** 去掉标签与内联脚本/样式，只留人眼能看到的文本 */
export function visibleText(html) {
    return String(html)
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * 真 HTTP 响应的 shell 结构判据。
 * @param html 响应体原文
 * @param route 路由（只进证据文本）
 * @param assetNames dist 里的产物文件名（用于确认页面真的引了构建产物）
 * @returns 问题清单（空 = 通过）
 */
export function shellProblems(html, route, assetNames = []) {
    const out = [];
    if (typeof html !== "string" || html.trim().length === 0) {
        out.push(`GET ${route} 返回空响应体`);
        return out;
    }
    if (html.trim().length < 60) {
        out.push(`GET ${route} 响应体只有 ${html.length}B，不足以构成页面：${JSON.stringify(html.slice(0, 120))}`);
    }
    const text = visibleText(html);
    if (TRIVIAL_RE.test(text)) {
        out.push(`GET ${route} 是占位页（可见文本 = ${JSON.stringify(text.slice(0, 80))}）——OK/hello/placeholder 不算页面`);
    }
    if (PLACEHOLDER_TEXT_RE.test(text)) out.push(`GET ${route} 可见文本含占位文案：${JSON.stringify(text.slice(0, 120))}`);
    if (!/<\s*html[\s>]/i.test(html)) out.push(`GET ${route} 不是 HTML 文档（缺 <html>）：${html.slice(0, 160)}`);
    if (!/<\s*body[\s>]/i.test(html)) out.push(`GET ${route} 缺 <body>`);
    if (!/id\s*=\s*["']app["']/.test(html)) out.push(`GET ${route} 缺前端挂载点 <div id="app">`);
    if (!/<\s*script[^>]+src=/i.test(html)) out.push(`GET ${route} 没引用任何构建产物 js——页面不会有内容`);
    // "空壳"的判据要分清两种空：
    //   · 合法 SPA shell：挂载点为空是**正常**的（Vue 之后往里挂），但必须引用**真实存在的**
    //     产物脚本 —— 产物本身还要过页面结构契约（② 那一段），所以不是"空着就算过"；
    //   · 假空壳：body 里既没有可见内容、也没有任何脚本 —— 纯 <div> 就是没实现。
    const bodyAt = html.search(/<\s*body[\s>]/i);
    const bodyText = bodyAt >= 0 ? visibleText(html.slice(bodyAt)) : "";
    const hasScript = /<\s*script\b/i.test(html);
    if (bodyAt >= 0 && bodyText.length < 5 && !hasScript) {
        out.push(`GET ${route} 的 body 既没有可见内容也没有脚本——纯空 div，等于没实现`);
    }
    // 必须引用到**真实存在**的产物文件，而不是手写一段假 HTML
    if (assetNames.length > 0 && !assetNames.some((f) => html.includes(path.basename(f)))) {
        out.push(`GET ${route} 的 HTML 没有引用实际 dist 产物文件——可能是手写的假页面`);
    }
    return out;
}

/**
 * 结构组判据：对给定 haystack 逐组要求命中，全中才算过。
 * @returns 问题清单（空 = 通过）
 */
export function pageStructureProblems(kind, haystack, where) {
    const contract = PAGE_CONTRACTS[kind];
    if (!contract) return [`未知页面种类 ${kind}`];
    const missing = [];
    for (const [name, alts] of contract.groups) {
        if (!alts.some((re) => re.test(haystack))) missing.push(name);
    }
    if (missing.length === 0) return [];
    return [
        `${contract.label}：${where} 里缺结构 [${missing.join("、")}]`
        + `（要求 ${contract.groups.length} 组独立结构全部成立，含某个字符串不算过）`,
    ];
}

// ============================================================
// 入口守卫：作为脚本跑才执行验收；被测试 import 时只取纯函数
// ============================================================

const isEntry = (() => {
    try {
        const self = fileURLToPath(import.meta.url);
        const argv1 = process.argv[1];
        if (!argv1) return false;
        return path.resolve(argv1) === path.resolve(self)
            || path.basename(argv1) === path.basename(self);
    } catch { return false; }
})();

async function main() {
    const t0 = Date.now();
    const die = (msg) => {
        console.error(`[verify-p1-frontend] FAIL: ${msg} (+${Date.now() - t0}ms)`);
        process.exit(1);
    };
    const read = (p) => { try { return readFileSync(p, "utf8"); } catch { die(`读不到 ${p}`); } };
    const failIf = (problems, where) => { if (problems.length > 0) die(problems.join("；")); };

    // 每轮随机深链 slug：固定值会让"只认某个固定 slug"的特殊分支蒙混过关
    const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    const probeSlug = `probe-${nonce}`;

    // ---------- ① 构建产物 ----------
    if (!existsSync("dist/index.html")) die("dist/index.html 不存在——前端没构建过？");
    const distFiles = readdirSync("dist", { recursive: true }).map(String);
    const jsFiles = distFiles.filter((f) => /\.js$/.test(f));
    if (jsFiles.length === 0) die(`dist/ 里没有 js 产物：${distFiles.slice(0, 20).join(", ")}`);
    const shellHtml = read("dist/index.html");
    if (!/id\s*=\s*["']app["']/.test(shellHtml)) die('dist/index.html 缺挂载点 <div id="app">');
    if (!/type\s*=\s*["']module["']|\.js/.test(shellHtml)) die("dist/index.html 没引到构建产物 js");
    console.log(`[verify-p1-frontend] dist 产物 OK（${distFiles.length} 个文件，其中 js ${jsFiles.length} 个）`);

    /** 真实构建产物全文（浏览器真正执行的那份；排除 sourcemap） */
    const assetFiles = jsFiles.filter((f) => !f.endsWith(".map"));
    const assetText = assetFiles
        .map((f) => { try { return readFileSync(path.join("dist", f), "utf8"); } catch { return ""; } })
        .join("\n");
    if (assetText.trim().length < 200) die("dist 里的 js 产物内容过短——像是空壳产物");

    // ---------- ③ 静态可达性（原有能力保留） ----------
    const main = read("src/main.ts");
    if (!/from\s+['"]\.\/router/.test(main)) die("main.ts 没有 import router");
    if (!/\.use\(\s*router\s*\)/.test(main)) die("main.ts 没有 app.use(router)——router 是死代码");
    const routerFile = existsSync("src/router/index.ts") ? "src/router/index.ts"
        : (existsSync("src/router.ts") ? "src/router.ts" : null);
    if (!routerFile) die("缺 src/router/index.ts 或 src/router.ts");
    const router = read(routerFile);
    if (!/createWebHistory/.test(router)) die("router 缺 createWebHistory");
    for (const p of ["/projects", "/projects/:slug"]) {
        if (!router.includes(p)) die(`router 缺路由 ${p}`);
    }
    const declaredPaths = [...router.matchAll(/path\s*:\s*['"`]([^'"`]+)['"`]/g)].map((m) => m[1]);
    const hasRoute = (p) => declaredPaths.includes(p);

    const viewsDir = existsSync("src/views") ? "src/views" : null;
    if (!viewsDir) die("缺 src/views/ 目录");
    const viewFiles = readdirSync(viewsDir).map(String);
    if (!viewFiles.some((f) => /Project/i.test(f))) die(`views/ 里找不到项目相关视图：${viewFiles.join(", ")}`);
    const viewAll = viewFiles.map((f) => read(`${viewsDir}/${f}`)).join("\n");
    if (!/fetch\(\s*[`'"]\/api\/projects/.test(viewAll)) die("视图里没有 fetch('/api/projects…')——列表页可能是静态假数据");
    const pkg = read("package.json");
    if (!/"vue-router"/.test(pkg)) die("package.json 没声明 vue-router 依赖");
    if (!existsSync("node_modules/vue-router")) die("node_modules 里没有 vue-router——pnpm install 没跑");
    console.log("[verify-p1-frontend] router/视图/依赖可达性 OK");

    // ---------- ② 页面结构契约：产物 + 源码 双 haystack ----------
    // 产物这份更硬：它是浏览器真正执行的东西，源码写得再漂亮没编译进去就是白写。
    const sourceText = [viewAll, router, main].join("\n");
    for (const kind of ["home", "projects", "projectDetail"]) {
        failIf(pageStructureProblems(kind, assetText, "dist 构建产物"), kind);
        failIf(pageStructureProblems(kind, sourceText, "src 源码"), kind);
    }
    console.log("[verify-p1-frontend] 首页 / 项目页 / 详情页 结构契约 OK（产物 + 源码 双份成立）");

    if (hasRoute("/login")) {
        failIf(pageStructureProblems("login", assetText, "dist 构建产物"), "login");
        failIf(pageStructureProblems("login", sourceText, "src 源码"), "login");
        console.log("[verify-p1-frontend] 登录页结构契约 OK（router 已声明 /login）");
    } else {
        console.log("[verify-p1-frontend] 跳过登录页结构检查：router 未声明 /login（本阶段契约无 auth 模块）——不假装检查过");
    }

    // ---------- 真起 vite preview 打 HTTP ----------
    const PORT = 19100 + (process.pid % 800);
    const viteBin = existsSync("node_modules/vite/bin/vite.js") ? "node_modules/vite/bin/vite.js" : null;
    if (!viteBin) die("node_modules/vite/bin/vite.js 不存在——依赖没装");
    const proc = spawn(process.execPath, [viteBin, "preview", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"], {
        stdio: ["ignore", "pipe", "pipe"], env: process.env,
    });
    let log = "";
    proc.stdout.on("data", (b) => { log += b; });
    proc.stderr.on("data", (b) => { log += b; });
    let killedOnce = false;
    const cleanup = () => {
        if (killedOnce) return;
        killedOnce = true;
        try { proc.stdout?.destroy(); proc.stderr?.destroy(); } catch { /* ok */ }
        try { proc.kill("SIGKILL"); } catch { /* 已退出 */ }
    };
    process.on("exit", cleanup);

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const deadline = Date.now() + 40_000;
    let ready = false;
    while (Date.now() < deadline) {
        if (proc.exitCode !== null) die(`preview 进程提前退出 exit=${proc.exitCode}\n${log.slice(-2000)}`);
        try {
            const res = await fetch(`http://127.0.0.1:${PORT}/`);
            if (res.status === 200) { ready = true; break; }
        } catch { /* 还没起来 */ }
        await sleep(1000);
    }
    if (!ready) die(`40s 内 vite preview 未就绪\n${log.slice(-2000)}`);

    for (const p of ["/", "/projects", `/projects/${probeSlug}`]) {
        const res = await fetch(`http://127.0.0.1:${PORT}${p}`);
        const html = await res.text();
        if (res.status !== 200) die(`GET ${p} 应 200（SPA 回退），实际 ${res.status}：${html.slice(0, 200)}`);
        failIf(shellProblems(html, p, assetFiles), p);
        console.log(`[verify-p1-frontend] GET ${p} → 200 + shell 结构 OK`);
    }

    cleanup();
    // Windows libuv 竞态：刚 kill 完子进程就 process.exit 会触发 async.c 断言（127）。
    // 先让事件循环把子进程退出回调跑完，再退。
    await sleep(800);
    console.log(`[verify-p1-frontend] 全绿 (+${Date.now() - t0}ms)`);
    process.exit(0);
}

if (isEntry) await main();
