// scripts/verify-t2.mjs —— T2 验收：真起 jar，打一轮 projects CRUD
//
// TestAgent 侧脚本（架构师编写，Developer 禁碰）：
//   ① 找 backend/target/*.jar → java -jar 起在随机端口
//   ② 轮询 /api/health 直到 200（90s 超时）
//   ③ POST→GET列表→GET详情→PUT→DELETE→GET应404 全链路断言
//   ④ 杀进程；任一断言失败 exit≠0，stdout 即证据
// 用法：node verify-t2.mjs  （cwd=backend，相对路径 target/、../scripts 均可用）
import { readdirSync } from "node:fs";
import { spawn } from "node:child_process";

const t0 = Date.now();
const die = (msg) => { console.error(`[verify-t2] FAIL: ${msg} (+${Date.now() - t0}ms)`); process.exit(1); };

// ① 找 jar（排除 sources/original）
const target = "target";
let jars = [];
try {
    jars = readdirSync(target).filter((f) => f.endsWith(".jar") && !f.includes("sources") && !f.includes("original"));
} catch { die(`${target}/ 不存在——backend 没构建过？先跑 mvnw package`); }
if (jars.length === 0) die("target/ 里没有 jar");
const jar = `${target}/${jars[0]}`;
console.log(`[verify-t2] jar=${jar}`);

// ② 起进程：随机端口 + 独立临时 H2 文件（data/verify-t2）避免污染
const PORT = 18000 + (process.pid % 2000);
const proc = spawn("java", ["-jar", jar,
    `--server.port=${PORT}`,
    "--spring.datasource.url=jdbc:h2:file:./data/verify-t2;MODE=MySQL",
    "--spring.jpa.hibernate.ddl-auto=create-drop",
], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
let bootLog = "";
proc.stdout.on("data", (b) => { bootLog += b; });
proc.stderr.on("data", (b) => { bootLog += b; });

const cleanup = () => { try { proc.kill("SIGKILL"); } catch { /* 已退出 */ } };
process.on("exit", cleanup);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (p, init) => {
    const res = await fetch(`http://127.0.0.1:${PORT}${p}`, init);
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* 非 JSON 留给断言判 */ }
    return { status: res.status, json, text };
};

// ③ 轮询 health（90s）
const deadline = Date.now() + 90_000;
let up = false;
while (Date.now() < deadline) {
    if (proc.exitCode !== null) die(`服务进程提前退出 exit=${proc.exitCode}\n${bootLog.slice(-3000)}`);
    try {
        const r = await get("/api/health");
        if (r.status === 200 && r.json?.ok === true) { up = true; break; }
    } catch { /* 还没起来 */ }
    await sleep(2000);
}
if (!up) die(`90s 内 /api/health 未就绪\n${bootLog.slice(-3000)}`);
console.log(`[verify-t2] health OK (+${Date.now() - t0}ms)`);

// ④ CRUD 全链路
const B = "/api/projects";
const body = (o) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(o) });

const created = await get(B, { method: "POST", ...body({ name: "verify-proj", description: "e2e", techStack: "Java,Vue3", sortOrder: 1 }) });
if (created.status !== 201) die(`POST 应 201，实际 ${created.status}：${created.text.slice(0, 300)}`);
const id = created.json?.id;
if (typeof id !== "number") die(`POST 响应缺 id：${created.text.slice(0, 300)}`);
if (typeof created.json?.createdAt !== "string" || !created.json.createdAt) die(`POST 响应缺 createdAt：${created.text.slice(0, 300)}`);
if (created.json?.name !== "verify-proj") die(`POST 回显 name 不符：${created.text.slice(0, 300)}`);
console.log(`[verify-t2] POST → 201 id=${id}`);

const list = await get(B);
if (list.status !== 200 || !Array.isArray(list.json)) die(`GET list 应 200+数组，实际 ${list.status}：${list.text.slice(0, 300)}`);
if (!list.json.some((p) => p.id === id)) die("GET list 找不到刚建的项目");
console.log(`[verify-t2] LIST → 200 含新项目`);

const one = await get(`${B}/${id}`);
if (one.status !== 200 || one.json?.id !== id) die(`GET detail 异常 ${one.status}：${one.text.slice(0, 300)}`);

const upd = await get(`${B}/${id}`, { method: "PUT", ...body({ name: "verify-proj-2", description: "upd", sortOrder: 2 }) });
if (upd.status !== 200 || upd.json?.name !== "verify-proj-2") die(`PUT 异常 ${upd.status}：${upd.text.slice(0, 300)}`);
console.log(`[verify-t2] PUT → 200 已改名`);

const del = await get(`${B}/${id}`, { method: "DELETE" });
if (del.status !== 204) die(`DELETE 应 204，实际 ${del.status}`);
const gone = await get(`${B}/${id}`);
if (gone.status !== 404) die(`删除后 GET 应 404，实际 ${gone.status}`);
console.log(`[verify-t2] DELETE → 204，重查 → 404`);

const bad = await get(B, { method: "POST", ...body({ description: "缺 name" }) });
if (bad.status !== 400) die(`POST 缺 name 应 400，实际 ${bad.status}`);
console.log(`[verify-t2] 校验: 缺 name → 400`);

cleanup();
console.log(`[verify-t2] 全链路绿 (+${Date.now() - t0}ms)`);
process.exit(0);
