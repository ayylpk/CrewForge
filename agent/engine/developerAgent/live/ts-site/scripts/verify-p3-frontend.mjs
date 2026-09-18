// scripts/verify-p3-frontend.mjs —— ts-site P3 · 全站收官验收（TestAgent 侧，Developer 禁碰）
//   要求六条路由齐 + P1/P2 页面不丢 + preview 深链全 200。
//   用法：node ../scripts/verify-p3-frontend.mjs   （cwd = frontend）
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";

const t0 = Date.now();
const die = (msg) => {
    console.error(`[verify-p3-frontend] FAIL: ${msg} (+${Date.now() - t0}ms)`);
    process.exit(1);
};
const read = (p) => { try { return readFileSync(p, "utf8"); } catch { die(`读不到 ${p}`); } };

// ① 产物
if (!existsSync("dist/index.html")) die("dist/index.html 不存在");
if (!/id=["']app["']/.test(read("dist/index.html"))) die("dist/index.html 缺挂载点");
console.log("[verify-p3-frontend] dist OK");

// ② 六条路由一条不能少
const routerFile = existsSync("src/router/index.ts") ? "src/router/index.ts" : (existsSync("src/router.ts") ? "src/router.ts" : null);
if (!routerFile) die("缺 router 文件");
const router = read(routerFile);
for (const p of ["/projects", "/repos", "/files", "/diary", "/about", "/search"]) {
    if (!router.includes(p)) die(`router 缺路由 ${p}`);
}
console.log(`[verify-p3-frontend] 六条路由 OK`);

// ③ 视图与调用真实性
const views = readdirSync("src/views").map(String);
for (const need of [/Diary/i, /About/i, /Search/i]) {
    if (!views.some((f) => need.test(f))) die(`views/ 缺 ${need} 视图：${views.join(",")}`);
}
const all = views.map((f) => read(`src/views/${f}`)).join("\n");
if (!/\/api\/diaries/.test(all)) die("没有视图引用 /api/diaries");
if (!/\/api\/search/.test(all)) die("没有视图引用 /api/search");
const app = read("src/App.vue");
if (!/input|search/i.test(app) && !/Search/i.test(router)) die("App.vue 找不到搜索框入口");
console.log(`[verify-p3-frontend] 视图与 API 引用 OK（views: ${views.join(",")}）`);

// ④ preview 全站深链
const PORT = 19500 + (process.pid % 400);
if (!existsSync("node_modules/vite/bin/vite.js")) die("vite 不存在——依赖没装");
const proc = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "preview", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"], {
    stdio: ["ignore", "pipe", "pipe"], env: process.env,
});
let log = "";
proc.stdout.on("data", (b) => { log += b; });
proc.stderr.on("data", (b) => { log += b; });
let killedOnce = false;
const killOnce = () => { if (killedOnce) return; killedOnce = true; try { proc.stdout?.destroy(); proc.stderr?.destroy(); } catch { /* ok */ } try { proc.kill("SIGKILL"); } catch { /* 已退 */ } };
process.on("exit", killOnce);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deadline = Date.now() + 40_000;
let ready = false;
while (Date.now() < deadline) {
    if (proc.exitCode !== null) die(`preview 提前退出 exit=${proc.exitCode}\n${log.slice(-2000)}`);
    try { const res = await fetch(`http://127.0.0.1:${PORT}/`); if (res.status === 200) { ready = true; break; } } catch { /* no */ }
    await sleep(1000);
}
if (!ready) die(`40s preview 未就绪\n${log.slice(-2000)}`);
for (const p of ["/", "/projects", "/repos", "/files", "/diary", "/about", "/search?q=test"]) {
    const res = await fetch(`http://127.0.0.1:${PORT}${p}`);
    const html = await res.text();
    if (res.status !== 200 || !/id=["']app["']/.test(html)) die(`GET ${p} 应 200+挂载点，实际 ${res.status}`);
    console.log(`[verify-p3-frontend] GET ${p} → 200`);
}
killOnce();
await sleep(800); // Windows libuv 竞态：kill 后立即 exit 会触发 async.c 断言（127）
console.log(`[verify-p3-frontend] 全绿 (+${Date.now() - t0}ms)`);
process.exit(0);
