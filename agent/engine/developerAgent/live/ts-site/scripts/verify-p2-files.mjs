// scripts/verify-p2-files.mjs —— ts-site P2 · 文件存储验收（TestAgent 侧，Developer 禁碰）
//   用法：node ../scripts/verify-p2-files.mjs   （cwd = backend）
import { rmSync } from "node:fs";
import { spawn } from "node:child_process";

const t0 = Date.now();
const die = (msg) => {
    console.error(`[verify-p2-files] FAIL: ${msg} (+${Date.now() - t0}ms)`);
    process.exit(1);
};

const DB = `./data/verify-p2-files-${process.pid}.db`;
const UP = `./data/verify-uploads-${process.pid}`;
const clean = () => {
    for (const s of ["", "-wal", "-shm"]) { try { rmSync(DB + s, { force: true }); } catch { /* ok */ } }
    try { rmSync(UP, { recursive: true, force: true }); } catch { /* ok */ }
};
clean();

const PORT = 18500 + (process.pid % 400);
const proc = spawn(process.execPath, ["dist/index.js"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(PORT), DB_FILE: DB, UPLOAD_DIR: UP },
});
let log = "";
proc.stdout.on("data", (b) => { log += b; });
proc.stderr.on("data", (b) => { log += b; });
let killedOnce = false;
const killOnce = () => {
    if (killedOnce) return;
    killedOnce = true;
    try { proc.stdout?.destroy(); proc.stderr?.destroy(); } catch { /* ok */ }
    try { proc.kill("SIGKILL"); } catch { /* 已退 */ }
};
process.on("exit", () => { killOnce(); clean(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deadline = Date.now() + 60_000;
let up = false;
while (Date.now() < deadline) {
    if (proc.exitCode !== null) die(`服务提前退出 exit=${proc.exitCode}\n${log.slice(-3000)}`);
    try {
        const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
        if (res.status === 200) { up = true; break; }
    } catch { /* no */ }
    await sleep(1500);
}
if (!up) die(`60s health 未就绪\n${log.slice(-3000)}`);
const base = `http://127.0.0.1:${PORT}`;

// ① 上传（ASCII 名 + 中文名各一发）
const contentA = "ts-site 文件存储验收。\n第二行内容。\n";
const bufA = Buffer.from(contentA, "utf8");
const fdA = new FormData();
fdA.append("file", new Blob([bufA], { type: "text/plain" }), "verify-note.txt");
const rA = await fetch(`${base}/api/files`, { method: "POST", body: fdA });
const tA = await rA.text();
if (rA.status !== 201) die(`上传应 201，实际 ${rA.status}：${tA.slice(0, 400)}`);
const jA = JSON.parse(tA);
if (typeof jA.id !== "number") die(`响应缺数字 id：${tA.slice(0, 300)}`);
if (jA.name !== "verify-note.txt") die(`name 回显不符：${tA.slice(0, 300)}`);
if (jA.size !== bufA.length) die(`size 应为 ${bufA.length}，实际 ${jA.size}`);
if (typeof jA.uploadedAt !== "string") die("缺 uploadedAt");
if ("stored_name" in jA || "storedName" in jA) die(`响应泄露盘上文件名：${tA.slice(0, 300)}`);
console.log(`[verify-p2-files] 上传 ASCII → 201 id=${jA.id} size=${jA.size}`);

const fdC = new FormData();
fdC.append("file", new Blob([Buffer.from("中文文件名测试", "utf8")], { type: "text/plain" }), "验收文档.txt");
const rC = await fetch(`${base}/api/files`, { method: "POST", body: fdC });
if (rC.status === 201) {
    const jC = JSON.parse(await rC.text());
    if (jC.name !== "验收文档.txt") console.log(`[verify-p2-files] ⚠ 中文名回显=${JSON.stringify(jC.name)}（latin1→utf8 未处理，记为不足不判死）`);
    else console.log(`[verify-p2-files] 中文名 latin1 转码 OK`);
    var cnId = jC.id;
} else {
    console.log(`[verify-p2-files] ⚠ 中文名上传返回 ${rC.status}（不判死，记入不足）`);
}

// ② 列表
const list = await fetch(`${base}/api/files`);
const arr = await list.json();
if (list.status !== 200 || !Array.isArray(arr)) die(`列表应 200+数组，实际 ${list.status}`);
if (!arr.some((f) => f.id === jA.id)) die("列表找不到刚传的文件");
console.log(`[verify-p2-files] 列表 OK（${arr.length} 项）`);

// ③ 下载：字节一致 + 头
const dl = await fetch(`${base}/api/files/${jA.id}/download`);
if (dl.status !== 200) die(`下载应 200，实际 ${dl.status}`);
const dlBuf = Buffer.from(await dl.arrayBuffer());
if (Buffer.compare(dlBuf, bufA) !== 0) die(`下载字节与上传不一致（${dlBuf.length} vs ${bufA.length}）`);
const cd = dl.headers.get("content-disposition") ?? "";
if (!/attachment/i.test(cd)) die(`缺 content-disposition attachment：${cd}`);
console.log(`[verify-p2-files] 下载字节级一致 + attachment 头 OK`);

// ④ 校验与缺失分支
const fdEmpty = new FormData();
fdEmpty.append("note", "no-file-here");
const rEmpty = await fetch(`${base}/api/files`, { method: "POST", body: fdEmpty });
if (rEmpty.status !== 400) die(`缺 file 字段应 400，实际 ${rEmpty.status}`);
const dl404 = await fetch(`${base}/api/files/999999/download`);
if (dl404.status !== 404) die(`下载不存在 id 应 404，实际 ${dl404.status}`);
const del404 = await fetch(`${base}/api/files/999999`, { method: "DELETE" });
if (del404.status !== 404) die(`删除不存在 id 应 404，实际 ${del404.status}`);
console.log(`[verify-p2-files] 400 + 404×2 OK`);

// ⑤ 删除后 404
const del = await fetch(`${base}/api/files/${jA.id}`, { method: "DELETE" });
if (del.status !== 204) die(`DELETE 应 204，实际 ${del.status}`);
const gone = await fetch(`${base}/api/files/${jA.id}/download`);
if (gone.status !== 404) die(`删除后下载应 404，实际 ${gone.status}`);
console.log(`[verify-p2-files] DELETE → 204 + 重查 404 OK`);

killOnce();
clean();
await sleep(800); // Windows libuv 退出竞态（9/13 P2 实弹 exit=9）
console.log(`[verify-p2-files] 全绿 (+${Date.now() - t0}ms)`);
process.exit(0);
