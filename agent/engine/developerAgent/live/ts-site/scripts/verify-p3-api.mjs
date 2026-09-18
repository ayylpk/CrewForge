// scripts/verify-p3-api.mjs —— ts-site P3 · 日记+搜索+统计验收（TestAgent 侧，Developer 禁碰）
//   自带种子数据（独立 DB），断言本期契约。
//   用法：node ../scripts/verify-p3-api.mjs   （cwd = backend）
import { rmSync } from "node:fs";
import { spawn } from "node:child_process";

const t0 = Date.now();
const die = (msg) => {
    console.error(`[verify-p3-api] FAIL: ${msg} (+${Date.now() - t0}ms)`);
    process.exit(1);
};

const DB = `./data/verify-p3-${process.pid}.db`;
const UP = `./data/verify-uploads-p3-${process.pid}`;
const clean = () => {
    for (const s of ["", "-wal", "-shm"]) { try { rmSync(DB + s, { force: true }); } catch { /* ok */ } }
    try { rmSync(UP, { recursive: true, force: true }); } catch { /* ok */ }
};
clean();

const PORT = 18700 + (process.pid % 200);
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
const hit = async (p, init) => {
    const res = await fetch(`http://127.0.0.1:${PORT}${p}`, init);
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* 交给断言 */ }
    return { status: res.status, json, text };
};
const J = (o) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(o) });
// 用法：{ method: "POST", ...J(obj) }——fetch 默认 GET，GET 带 body 会被 undici 直接抛错
const PJ = (o) => ({ method: "POST", ...J(o) });
const UJ = (o) => ({ method: "PUT", ...J(o) });

const deadline = Date.now() + 60_000;
let up = false;
while (Date.now() < deadline) {
    if (proc.exitCode !== null) die(`服务提前退出 exit=${proc.exitCode}\n${log.slice(-3000)}`);
    try { const r = await hit("/api/health"); if (r.status === 200 && r.json?.ok === true) { up = true; break; } } catch { /* no */ }
    await sleep(1500);
}
if (!up) die(`60s health 未就绪\n${log.slice(-3000)}`);
console.log(`[verify-p3-api] health OK (+${Date.now() - t0}ms)`);

// ========== 日记 ==========
const dBad1 = await hit("/api/diaries", PJ({ title: "缺正文" }));
if (dBad1.status !== 400) die(`POST 缺 content 应 400，实际 ${dBad1.status}`);
const dBad2 = await hit("/api/diaries", PJ({ title: "  ", content: "x" }));
if (dBad2.status !== 400) die(`POST 空白 title 应 400，实际 ${dBad2.status}`);

const dia = await hit("/api/diaries", PJ({ title: "验收日记·needle3", content: "ts-site 第三期验收正文", tags: ["e2e"], mood: "🙂" }));
if (dia.status !== 201) die(`POST 日记应 201，实际 ${dia.status}：${dia.text.slice(0, 400)}`);
const dj = dia.json;
if (typeof dj?.id !== "number" || !Array.isArray(dj.tags) || dj.mood !== "🙂" || typeof dj.createdAt !== "string") {
    die(`DiaryDto 形状异常：${dia.text.slice(0, 400)}`);
}
console.log(`[verify-p3-api] 日记 POST → 201 id=${dj.id}`);

const dList = await hit("/api/diaries");
if (dList.status !== 200 || !Array.isArray(dList.json) || !dList.json.some((x) => x.id === dj.id)) die(`日记列表找不到：${dList.text.slice(0, 300)}`);
const now = new Date();
const y = now.getUTCFullYear(), m = now.getUTCMonth() + 1;
const dYm = await hit(`/api/diaries?year=${y}&month=${m}`);
if (dYm.status !== 200 || !Array.isArray(dYm.json) || !dYm.json.some((x) => x.id === dj.id)) die(`按当前 UTC 年月(${y}-${m})过滤应命中：${dYm.text.slice(0, 300)}`);
const dOld = await hit("/api/diaries?year=1999&month=1");
if (dOld.status !== 200 || !Array.isArray(dOld.json) || dOld.json.some((x) => x.id === dj.id)) die(`1999-01 过滤不该命中新日记：${dOld.text.slice(0, 300)}`);
const dOnlyYear = await hit(`/api/diaries?year=${y}`);
if (dOnlyYear.status !== 200 || !Array.isArray(dOnlyYear.json) || !dOnlyYear.json.some((x) => x.id === dj.id)) die("只给 year 也应过滤生效并命中");
const dBogus = await hit("/api/diaries?year=abc");
if (dBogus.status !== 400) die(`year 非法应 400，实际 ${dBogus.status}`);
console.log(`[verify-p3-api] 列表 + 年月过滤（含只给year/非法400）OK`);

const dUpd = await hit(`/api/diaries/${dj.id}`, UJ({ title: "验收日记·needle3（改）", content: "改过的正文", mood: null }));
if (dUpd.status !== 200 || dUpd.json?.title !== "验收日记·needle3（改）") die(`PUT 日记异常 ${dUpd.status}：${dUpd.text.slice(0, 300)}`);
const d404 = await hit("/api/diaries/999999");
if (d404.status !== 404) die(`GET 不存在日记应 404，实际 ${d404.status}`);
const dDel404 = await hit("/api/diaries/999999", { method: "DELETE" });
if (dDel404.status !== 404) die(`DELETE 不存在应 404，实际 ${dDel404.status}`);
console.log(`[verify-p3-api] PUT + 404 分支 OK`);

// ========== 搜索（先造三类各一发命中） ==========
const pj = await hit("/api/projects", PJ({ title: "needle3 项目", slug: "needle3-proj", description: "给搜索验收用的项目" }));
if (pj.status !== 201) die(`搜索种子：建项目失败 ${pj.status}：${pj.text.slice(0, 300)}`);
const fd = new FormData();
fd.append("file", new Blob([Buffer.from("needle3 file body")]), "needle3-doc.txt");
const fu = await fetch(`http://127.0.0.1:${PORT}/api/files`, { method: "POST", body: fd });
if (fu.status !== 201) die(`搜索种子：上传失败 ${fu.status}`);

const sHit = await hit("/api/search?q=needle3");
if (sHit.status !== 200) die(`GET /api/search 应 200，实际 ${sHit.status}：${sHit.text.slice(0, 300)}`);
const sr = sHit.json;
if (!sr || !Array.isArray(sr.projects) || !Array.isArray(sr.diaries) || !Array.isArray(sr.files)) die(`search 响应缺三组数组：${sHit.text.slice(0, 400)}`);
if (!sr.projects.some((x) => x.slug === "needle3-proj")) die(`search.projects 未命中 needle3：${JSON.stringify(sr.projects).slice(0, 300)}`);
if (!sr.diaries.some((x) => x.title.includes("needle3"))) die("search.diaries 未命中");
if (!sr.files.some((x) => x.name === "needle3-doc.txt")) die("search.files 未命中");
const sMiss = await hit("/api/search?q=zzz-不存在-xqq");
if (sMiss.status !== 200 || sMiss.json?.projects?.length !== 0 || sMiss.json?.diaries?.length !== 0 || sMiss.json?.files?.length !== 0) {
    die(`无匹配应三组全空：${sMiss.text.slice(0, 300)}`);
}
const sNoQ = await hit("/api/search");
if (sNoQ.status !== 400) die(`缺 q 应 400，实际 ${sNoQ.status}`);
const sWild = await hit(`/api/search?q=${encodeURIComponent("%zzz")}`);
if (sWild.status !== 200 || sWild.json?.projects?.length !== 0) die(`% 通配符应被转义（0 命中），实际 ${sWild.text.slice(0, 200)}`);
console.log(`[verify-p3-api] 搜索三组命中 + 空结果 + 400 + 通配转义 OK`);

// ========== 统计 ==========
const st1 = await hit("/api/stats");
if (st1.status !== 200) die(`GET /api/stats 应 200，实际 ${st1.status}`);
const st = st1.json;
for (const k of ["projects", "diaries", "files", "repos", "visits"]) {
    if (typeof st?.[k] !== "number") die(`stats.${k} 应为数字：${st1.text.slice(0, 300)}`);
}
if (st.projects < 1 || st.diaries < 1 || st.files < 1) die(`刚造了种子，计数却为 0：${JSON.stringify(st)}`);
if (st.repos < 1) die(`repos 计数应 ≥1（hello-world 存在）：${JSON.stringify(st)}`);
const st2 = await hit("/api/stats");
if (st2.json.visits <= st.visits) die(`visits 应逐请求递增：${st.visits} → ${st2.json.visits}`);
console.log(`[verify-p3-api] stats 计数 + visits 递增 OK（${JSON.stringify(st)}）`);

// 删掉日记验证 204
const dDel = await hit(`/api/diaries/${dj.id}`, { method: "DELETE" });
if (dDel.status !== 204) die(`DELETE 日记应 204，实际 ${dDel.status}`);

killOnce();
clean();
await sleep(800); // Windows libuv 退出竞态（9/13 P2 实弹 exit=9）
console.log(`[verify-p3-api] 全绿 (+${Date.now() - t0}ms)`);
process.exit(0);
