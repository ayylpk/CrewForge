// scripts/verify-p2-frontend.mjs —— ts-site P2 · 前端页面验收（TestAgent 侧，Developer 禁碰）
//   用法：node ../scripts/verify-p2-frontend.mjs   （cwd = frontend）
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";

const t0 = Date.now();
const die = (msg) => {
    console.error(`[verify-p2-frontend] FAIL: ${msg} (+${Date.now() - t0}ms)`);
    process.exit(1);
};
const read = (p) => { try { return readFileSync(p, "utf8"); } catch { die(`读不到 ${p}`); } };

// ① 产物与 P1 回归挂载点
if (!existsSync("dist/index.html")) die("dist/index.html 不存在");
const homeHtml = read("dist/index.html");
if (!/id=["']app["']/.test(homeHtml)) die("dist/index.html 缺挂载点");
console.log("[verify-p2-frontend] dist OK");

// ② 路由可达 + 视图真调 API
const routerFile = existsSync("src/router/index.ts") ? "src/router/index.ts" : (existsSync("src/router.ts") ? "src/router.ts" : null);
if (!routerFile) die("缺 router 文件");
const router = read(routerFile);
for (const p of ["/projects", "/repos", "/files"]) {
    if (!router.includes(p)) die(`router 缺路由 ${p}`);
}
const viewFiles = readdirSync("src/views").map(String);
const need = { Repos: /repos/i, Files: /file/i };
for (const k of Object.keys(need)) {
    if (!viewFiles.some((f) => need[k].test(f))) die(`views/ 缺 ${k} 相关视图：${viewFiles.join(",")}`);
}
const all = viewFiles.map((f) => read(`src/views/${f}`)).join("\n");
if (!/fetch\(\s*[`'"]\/api\/repos/.test(all)) die("没有视图 fetch /api/repos");
if (!/fetch\(\s*[`'"]\/api\/files|fetch\(\s*[`'"]\$\{[^}]*\}\/api\/files|\/api\/files/.test(all)) die("没有视图引用 /api/files");
if (!/FormData/.test(all)) die("Files 视图缺 FormData——上传多半没真做");
console.log(`[verify-p2-frontend] router + 视图引用 OK（views: ${viewFiles.join(",")}）`);

// ③ preview 深链
const PORT = 19300 + (process.pid % 600);
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
for (const p of ["/", "/repos", "/files", "/projects"]) {
    const res = await fetch(`http://127.0.0.1:${PORT}${p}`);
    const html = await res.text();
    if (res.status !== 200 || !/id=["']app["']/.test(html)) die(`GET ${p} 应 200+挂载点，实际 ${res.status}`);
    console.log(`[verify-p2-frontend] GET ${p} → 200`);
}
killOnce();
await sleep(800); // Windows libuv 竞态：kill 后立即 exit 会触发 async.c 断言（127）
console.log(`[verify-p2-frontend] 全绿 (+${Date.now() - t0}ms)`);
process.exit(0);
