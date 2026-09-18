// scripts/verify-p2-repos.mjs —— ts-site P2 · 源码浏览（repos）验收（TestAgent 侧，Developer 禁碰）
//   用法：node ../scripts/verify-p2-repos.mjs   （cwd = backend）
import { rmSync } from "node:fs";
import { spawn } from "node:child_process";

const t0 = Date.now();
const die = (msg) => {
    console.error(`[verify-p2-repos] FAIL: ${msg} (+${Date.now() - t0}ms)`);
    process.exit(1);
};

const DB = `./data/verify-p2-repos-${process.pid}.db`;
for (const s of ["", "-wal", "-shm"]) { try { rmSync(DB + s, { force: true }); } catch { /* ok */ } }
const PORT = 18300 + (process.pid % 600);
const proc = spawn(process.execPath, ["dist/index.js"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(PORT), DB_FILE: DB },
});
let log = "";
proc.stdout.on("data", (b) => { log += b; });
proc.stderr.on("data", (b) => { log += b; });
let killedOnce = false;
const cleanup = () => {
    if (killedOnce) return;
    killedOnce = true;
    try { proc.stdout?.destroy(); proc.stderr?.destroy(); } catch { /* ok */ }
    try { proc.kill("SIGKILL"); } catch { /* 已退 */ }
    for (const s of ["", "-wal", "-shm"]) { try { rmSync(DB + s, { force: true }); } catch { /* ok */ } }
};
process.on("exit", cleanup);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hit = async (p) => {
    const res = await fetch(`http://127.0.0.1:${PORT}${p}`);
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* 交给断言 */ }
    return { status: res.status, json, text };
};

const deadline = Date.now() + 60_000;
let up = false;
while (Date.now() < deadline) {
    if (proc.exitCode !== null) die(`服务提前退出 exit=${proc.exitCode}\n${log.slice(-3000)}`);
    try { const r = await hit("/api/health"); if (r.status === 200 && r.json?.ok === true) { up = true; break; } } catch { /* no */ }
    await sleep(1500);
}
if (!up) die(`60s health 未就绪\n${log.slice(-3000)}`);

// ① 仓库列表含示例 hello-world
const repos = await hit("/api/repos");
if (repos.status !== 200 || !Array.isArray(repos.json)) die(`GET /api/repos 应 200+数组，实际 ${repos.status}：${repos.text.slice(0, 300)}`);
const hw = repos.json.find((r) => r.name === "hello-world");
if (!hw) die(`仓库列表缺 hello-world：${repos.text.slice(0, 300)}`);
if (typeof hw.fileCount !== "number" || hw.fileCount < 3) die(`hello-world fileCount 应 ≥3，实际 ${JSON.stringify(hw)}`);
console.log(`[verify-p2-repos] repos list OK（hello-world fileCount=${hw.fileCount}）`);

// ② 文件树结构
const tree = await hit("/api/repos/hello-world/tree");
if (tree.status !== 200) die(`tree 应 200，实际 ${tree.status}：${tree.text.slice(0, 300)}`);
const root = Array.isArray(tree.json) ? tree.json : (tree.json.children ?? []);
if (!Array.isArray(root) || root.length === 0) die(`tree 根层应为非空数组：${tree.text.slice(0, 300)}`);
const readme = root.find((n) => n.name === "README.md" && n.type === "file");
if (!readme) die(`tree 根层缺 README.md 文件节点：${tree.text.slice(0, 400)}`);
const srcDir = root.find((n) => n.name === "src" && n.type === "dir");
if (!srcDir) die(`tree 根层缺 src 目录节点：${tree.text.slice(0, 400)}`);
const srcFiles = (srcDir.children ?? []).map((c) => c.name);
for (const f of ["main.ts", "util.ts"]) {
    if (!srcFiles.includes(f)) die(`src/ 里缺 ${f}，实际：${srcFiles.join(",")}`);
}
// path 字段用斜杠相对路径
const mainNode = (srcDir.children ?? []).find((c) => c.name === "main.ts");
if (!/src\/main\.ts$/.test(String(mainNode?.path))) die(`main.ts 的 path 字段应为 src/main.ts，实际 ${mainNode?.path}`);
console.log(`[verify-p2-repos] tree 结构 OK`);

// ③ 文件内容
const f1 = await hit("/api/repos/hello-world/file?path=README.md");
if (f1.status !== 200) die(`读 README.md 应 200，实际 ${f1.status}：${f1.text.slice(0, 300)}`);
if (typeof f1.json?.content !== "string" || f1.json.content.trim().length === 0) die("README.md content 为空");
if (f1.json?.path !== "README.md") die(`file 响应 path 字段应为 README.md，实际 ${JSON.stringify(f1.json?.path)}`);
const f2 = await hit(`/api/repos/hello-world/file?path=${encodeURIComponent("src/util.ts")}`);
if (f2.status !== 200 || typeof f2.json?.content !== "string") die(`读 src/util.ts 异常 ${f2.status}`);
console.log(`[verify-p2-repos] 文件内容读取 OK`);

// ④ 越权与缺失分支
const trav = await hit(`/api/repos/hello-world/file?path=${encodeURIComponent("../package.json")}`);
if (trav.status !== 400) die(`path 含 .. 应 400，实际 ${trav.status}`);
const abs = await hit(`/api/repos/hello-world/file?path=${encodeURIComponent("C:/Windows/win.ini")}`);
if (abs.status !== 400) die(`绝对路径应 400，实际 ${abs.status}`);
const noFile = await hit("/api/repos/hello-world/file?path=nope.txt");
if (noFile.status !== 404) die(`不存在的路径应 404，实际 ${noFile.status}`);
const noRepo = await hit("/api/repos/no-such-repo/tree");
if (noRepo.status !== 404) die(`不存在仓库 tree 应 404，实际 ${noRepo.status}`);
const badName = await hit("/api/repos/..%2f..%2fetc/tree");
if (badName.status !== 404 && badName.status !== 400) die(`仓库名注入应 400/404，实际 ${badName.status}`);
console.log(`[verify-p2-repos] 路径防护 OK（400/400/404/404）`);

cleanup();
await sleep(800); // Windows libuv 退出竞态（9/13 P2 实弹 exit=9）
console.log(`[verify-p2-repos] 全绿 (+${Date.now() - t0}ms)`);
process.exit(0);
