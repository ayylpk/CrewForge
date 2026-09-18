// scripts/verify-t3b.mjs —— T3b 验收：真起 jar，打 files 上传/列表/下载/删除全链路
// 覆盖：中文文件名、二进制字节保真、storedName 不外泄、删除后 404、DTO 字段形状
import { readdirSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";

const t0 = Date.now();
const die = (msg) => { console.error(`[verify-t3b] FAIL: ${msg} (+${Date.now() - t0}ms)`); process.exit(1); };

let jars = [];
try {
    jars = readdirSync("target").filter((f) => f.endsWith(".jar") && !f.includes("sources") && !f.includes("original"));
} catch { die("target/ 不存在——先构建"); }
if (jars.length === 0) die("target/ 没有 jar");
const jar = `target/${jars[0]}`;

const PORT = 18000 + (process.pid % 2000);
const proc = spawn("java", ["-jar", jar,
    `--server.port=${PORT}`,
    "--spring.datasource.url=jdbc:h2:file:./data/verify-t3b;MODE=MySQL",
    "--spring.jpa.hibernate.ddl-auto=create-drop",
], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
let bootLog = "";
proc.stdout.on("data", (b) => { bootLog += b; });
proc.stderr.on("data", (b) => { bootLog += b; });
const cleanup = () => { try { proc.kill("SIGKILL"); } catch { /* gone */ } };
process.on("exit", cleanup);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const deadline = Date.now() + 90_000;
let up = false;
while (Date.now() < deadline) {
    if (proc.exitCode !== null) die(`进程提前退出 exit=${proc.exitCode}\n${bootLog.slice(-3000)}`);
    try {
        const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
        if (r.status === 200) { up = true; break; }
    } catch { /* starting */ }
    await sleep(2000);
}
if (!up) die(`90s 未就绪\n${bootLog.slice(-3000)}`);
console.log(`[verify-t3b] health OK (+${Date.now() - t0}ms)`);

const B = `http://127.0.0.1:${PORT}/api/files`;
// 伪 PNG 头 + 随机体：字节保真比对的基准
const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(2048, 0x5a)]);
const fd = new FormData();
fd.append("file", new Blob([bytes], { type: "image/png" }), "测试图片.png");

// ① 上传
let res = await fetch(B, { method: "POST", body: fd });
let dto = await res.json().catch(() => null);
if (res.status !== 201) die(`POST upload 应 201，实际 ${res.status}：${JSON.stringify(dto)}`);
if (dto?.filename !== "测试图片.png") die(`filename 回显不符：${dto?.filename}`);
if (dto?.size !== bytes.length) die(`size 不符：${dto?.size} ≠ ${bytes.length}`);
if (dto?.contentType !== "image/png") die(`contentType 不符：${dto?.contentType}`);
if ("storedName" in (dto ?? {}) || "stored_name" in (dto ?? {})) die("DTO 泄漏 storedName！");
const id = dto?.id;
if (typeof id !== "number") die(`缺 id：${JSON.stringify(dto)}`);
if (typeof dto?.uploadedAt !== "string" || !dto.uploadedAt) die(`缺 uploadedAt：${JSON.stringify(dto)}`);
console.log(`[verify-t3b] UPLOAD → 201 id=${id} 中文名保真`);

// ② 列表
res = await fetch(B);
const list = await res.json();
if (res.status !== 200 || !Array.isArray(list) || !list.some((f) => f.id === id)) die(`列表缺条目：${JSON.stringify(list)}`);

// ③ 下载字节保真
res = await fetch(`${B}/${id}/download`);
if (res.status !== 200) die(`download 应 200：${res.status}`);
const got = Buffer.from(await res.arrayBuffer());
if (!got.equals(bytes)) die(`下载字节不一致（len ${got.length} vs ${bytes.length}）`);
const cd = res.headers.get("content-disposition") ?? "";
if (!/attachment/i.test(cd)) die(`Content-Disposition 非 attachment：${cd}`);
console.log(`[verify-t3b] DOWNLOAD → 200 字节保真（${got.length}B）`);

// ④ 删除 → 记录 404 + 磁盘文件数回落
const uploadCount = () => (existsSync("uploads") ? readdirSync("uploads").length : -1);
const before = uploadCount();
if (before < 0) die("uploads/ 目录不存在（应在启动或首次上传时创建）");
if (before < 1) die(`uploads/ 里没有文件（count=${before}）`);
res = await fetch(`${B}/${id}`, { method: "DELETE" });
if (res.status !== 204) die(`DELETE 应 204：${res.status}`);
const after = uploadCount();
if (after !== before - 1) die(`删一条磁盘应少一个文件：${before} → ${after}`);
res = await fetch(`${B}/${id}/download`);
if (res.status !== 404) die(`删除后 download 应 404：${res.status}`);
res = await fetch(`${B}/${id}`, { method: "DELETE" });
if (res.status !== 404) die(`重复 DELETE 应 404：${res.status}`);
console.log(`[verify-t3b] DELETE → 204，磁盘同步清理，重查 404`);

// ⑤ 不存在 id 的下载 404
res = await fetch(`${B}/999999/download`);
if (res.status !== 404) die(`不存在 id download 应 404：${res.status}`);

// ⑥ 无 file 字段的上传 → 4xx（400 或 415 都算拦下）
res = await fetch(B, { method: "POST", body: new FormData() });
if (res.status < 400) die(`空上传应 4xx，实际 ${res.status}`);
console.log(`[verify-t3b] 空上传 → ${res.status} 拦截 OK`);

cleanup();
console.log(`[verify-t3b] 全链路绿 (+${Date.now() - t0}ms)`);
process.exit(0);
