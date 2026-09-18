// scripts/verify-t6.mjs —— 端到端总闸（零 LLM，TestAgent 手工跑）
// 真链路：Spring Boot(8180) ← vite preview 的 /api 代理 ← 浏览器同源视角
// 前置：backend/target 有 jar；frontend 已 npm run build（本脚本自己起 preview）
import { readdirSync } from "node:fs";
import { spawn } from "node:child_process";

const t0 = Date.now();
const die = (msg) => { console.error(`[verify-t6] FAIL: ${msg} (+${Date.now() - t0}ms)`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const jars = readdirSync("../backend/target").filter((f) => f.endsWith(".jar") && !f.includes("sources") && !f.includes("original"));
if (jars.length === 0) die("backend/target 没有 jar——先构建");
const BACK = 8180;
const FRONT = 4321;

const back = spawn("java", ["-jar", `../backend/target/${jars[0]}`,
    `--server.port=${BACK}`,
    "--spring.datasource.url=jdbc:h2:file:./data/verify-t6;MODE=MySQL",
    "--spring.jpa.hibernate.ddl-auto=create-drop",
], { cwd: "../backend", stdio: ["ignore", "pipe", "pipe"] });
// 用当前 node 直启 vite bin：不走 shell 就不留孤儿（shell:true 杀的是 cmd.exe，
// vite 的 node 孙进程会活着占端口——9/13 实弹踩过两次）
const front = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "preview",
    "--port", String(FRONT), "--strictPort"], {
    cwd: ".", stdio: ["ignore", "pipe", "pipe"],
});
const killAll = () => { for (const p of [back, front]) { try { p.kill("SIGKILL"); } catch { /* gone */ } } };
process.on("exit", killAll);
let backLog = "";
back.stdout.on("data", (b) => { backLog += b; }); back.stderr.on("data", (b) => { backLog += b; });
let frontLog = "";
front.stdout.on("data", (b) => { frontLog += b; }); front.stderr.on("data", (b) => { frontLog += b; });

// ① 后端直连就绪
let deadline = Date.now() + 90_000;
let ok = false;
while (Date.now() < deadline) {
    if (back.exitCode !== null) die(`后端退出 ${back.exitCode}\n${backLog.slice(-2500)}`);
    try { const r = await fetch(`http://127.0.0.1:${BACK}/api/health`); if (r.status === 200) { ok = true; break; } } catch { /* up */ }
    await sleep(2000);
}
if (!ok) die("后端 90s 未就绪");
console.log(`[verify-t6] 后端 :${BACK} 就绪`);

// ② 前端 preview 静态页
deadline = Date.now() + 30_000;
ok = false;
while (Date.now() < deadline) {
    if (front.exitCode !== null) die(`preview 退出 ${front.exitCode}\n${frontLog.slice(-1500)}`);
    try {
        const r = await fetch(`http://localhost:${FRONT}/`);
        if (r.status === 200 && /mysite|小站/i.test(await r.text())) { ok = true; break; }
    } catch { /* up */ }
    await sleep(1000);
}
if (!ok) die(`preview 30s 未就绪或首页 title 不含 mysite\n${frontLog.slice(-1500)}`);
console.log(`[verify-t6] 前端 preview :${FRONT} 就绪（首页 HTML ✓）`);

// ③ 走前端同源代理打 API（这才叫端到端）
const O = `http://localhost:${FRONT}`;
let r = await fetch(`${O}/api/health`);
if (r.status !== 200) die(`代理 /api/health → ${r.status}`);
r = await fetch(`${O}/api/projects`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "e2e-project", techStack: "Java,Vue3", sortOrder: 99 }),
});
if (r.status !== 201) die(`代理 POST /api/projects → ${r.status}`);
const pj = await r.json();
r = await fetch(`${O}/api/projects`);
const list = await r.json();
if (!list.some((x) => x.id === pj.id)) die("代理 GET 列表缺新条目");
console.log(`[verify-t6] 代理读写 projects ✓ (id=${pj.id})`);

r = await fetch(`${O}/api/diaries`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "e2e 日记", content: "全链路打通", tags: ["里程碑"] }),
});
if (r.status !== 201) die(`代理 POST /api/diaries → ${r.status}`);
r = await fetch(`${O}/api/diaries`);
if (!Array.isArray(await r.json())) die("代理 GET /api/diaries 非数组");
console.log(`[verify-t6] 代理读写 diaries ✓`);

r = await fetch(`${O}/api/files`);
if (r.status !== 200) die(`代理 GET /api/files → ${r.status}`);
console.log(`[verify-t6] 代理 files 列表 ✓`);

// ④ SPA fallback：深链接也应由前端接管（返回 HTML 而非 404/500）
r = await fetch(`${O}/diary`);
if (r.status !== 200 || !/<(html|div|script)/i.test(await r.text())) die("SPA 深链接 /diary 未回 HTML");
console.log(`[verify-t6] SPA fallback ✓`);

killAll();
console.log(`[verify-t6] 端到端全链路绿 (+${Date.now() - t0}ms)`);
process.exit(0);
