// scripts/verify-t3a.mjs —— T3a 验收：真起 jar，打 diary 全链路 + 年月过滤 + tags 数组往返
import { readdirSync } from "node:fs";
import { spawn } from "node:child_process";

const t0 = Date.now();
const die = (msg) => { console.error(`[verify-t3a] FAIL: ${msg} (+${Date.now() - t0}ms)`); process.exit(1); };

let jars = [];
try {
    jars = readdirSync("target").filter((f) => f.endsWith(".jar") && !f.includes("sources") && !f.includes("original"));
} catch { die("target/ 不存在——先构建"); }
if (jars.length === 0) die("target/ 里没有 jar");
const jar = `target/${jars[0]}`;

const PORT = 18000 + (process.pid % 2000);
const proc = spawn("java", ["-jar", jar,
    `--server.port=${PORT}`,
    "--spring.datasource.url=jdbc:h2:file:./data/verify-t3a;MODE=MySQL",
    "--spring.jpa.hibernate.ddl-auto=create-drop",
], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
let bootLog = "";
proc.stdout.on("data", (b) => { bootLog += b; });
proc.stderr.on("data", (b) => { bootLog += b; });
const cleanup = () => { try { proc.kill("SIGKILL"); } catch { /* gone */ } };
process.on("exit", cleanup);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (p, init) => {
    const res = await fetch(`http://127.0.0.1:${PORT}${p}`, init);
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* 交给断言 */ }
    return { status: res.status, json, text };
};
const body = (o) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(o) });

const deadline = Date.now() + 90_000;
let up = false;
while (Date.now() < deadline) {
    if (proc.exitCode !== null) die(`进程提前退出 exit=${proc.exitCode}\n${bootLog.slice(-3000)}`);
    try { const r = await get("/api/health"); if (r.status === 200) { up = true; break; } } catch { /* up */ }
    await sleep(2000);
}
if (!up) die(`90s 未就绪\n${bootLog.slice(-3000)}`);
console.log(`[verify-t3a] health OK (+${Date.now() - t0}ms)`);

const B = "/api/diaries";

// POST 正常：tags 数组进，数组出
const now = new Date();
const Y = now.getFullYear(); const M = now.getMonth() + 1;
const created = await get(B, { method: "POST", ...body({ title: "第一天", content: "正文\n第二行", mood: "happy", tags: ["生活", "编程"] }) });
if (created.status !== 201) die(`POST 应 201，实际 ${created.status}：${created.text.slice(0, 300)}`);
const d = created.json;
if (typeof d?.id !== "number") die("缺 id");
if (!Array.isArray(d?.tags) || d.tags.join(",") !== "生活,编程") die(`tags 数组往返失败：${JSON.stringify(d?.tags)}`);
if (d?.mood !== "happy" || d?.title !== "第一天") die(`回显不符：${created.text.slice(0, 300)}`);
console.log(`[verify-t3a] POST → 201 id=${d.id} tags 往返 OK`);

// 校验：缺 title / 缺 content / title 空白
for (const bad of [{ content: "没标题" }, { title: "没正文" }, { title: "   ", content: "x" }]) {
    const r = await get(B, { method: "POST", ...body(bad) });
    if (r.status !== 400) die(`POST ${JSON.stringify(bad)} 应 400，实际 ${r.status}`);
}
console.log(`[verify-t3a] 校验三种缺失 → 400`);

// 再来一条无 tags 的：应返回 []
const noTags = await get(B, { method: "POST", ...body({ title: "无标签", content: "x" }) });
if (noTags.status !== 201 || !Array.isArray(noTags.json?.tags) || noTags.json.tags.length !== 0) {
    die(`无 tags 应返回 []：${noTags.status} ${noTags.text.slice(0, 200)}`);
}

// 列表 desc：第一条应是"无标签"（后插入的在前——若都同秒创建则按 id desc 兜底，查 title 集合即可）
const list = await get(B);
if (list.status !== 200 || !Array.isArray(list.json) || list.json.length !== 2) die(`列表应 2 条：${list.status} ${list.text.slice(0, 200)}`);
// 码点排序："无"(U+65E0) < "第"(U+7B2C)——9/13 曾把期望写反错杀模型一轮
const titles = list.json.map((x) => x.title).sort().join("|");
if (titles !== "无标签|第一天") die(`列表标题集合不符：${titles}`);
console.log(`[verify-t3a] LIST → 2 条`);

// 年月过滤：当月 2 条；乱月 0 条
const inMonth = await get(`${B}?year=${Y}&month=${M}`);
if (inMonth.status !== 200 || inMonth.json?.length !== 2) die(`当月应 2 条：${inMonth.text.slice(0, 200)}`);
const offMonth = await get(`${B}?year=1999&month=1`);
if (offMonth.status !== 200 || !Array.isArray(offMonth.json) || offMonth.json.length !== 0) die(`1999-01 应空数组：${offMonth.text.slice(0, 200)}`);
console.log(`[verify-t3a] 年月过滤 → 2/0`);

// 详情 / 更新 / 删除 / 404
const one = await get(`${B}/${d.id}`);
if (one.status !== 200 || one.json?.content !== "正文\n第二行") die(`详情 content 不符（注意换行保真）：${one.text.slice(0, 200)}`);
const upd = await get(`${B}/${d.id}`, { method: "PUT", ...body({ title: "改过的", content: "新正文", tags: ["改"] }) });
if (upd.status !== 200 || upd.json?.title !== "改过的" || upd.json?.tags?.join("") !== "改") die(`PUT 不符：${upd.text.slice(0, 200)}`);
const del = await get(`${B}/${d.id}`, { method: "DELETE" });
if (del.status !== 204) die(`DELETE 应 204：${del.status}`);
const gone = await get(`${B}/${d.id}`);
if (gone.status !== 404) die(`删除后应 404：${gone.status}`);
const del404 = await get(`${B}/999999`, { method: "DELETE" });
if (del404.status !== 404) die(`删不存在应 404：${del404.status}`);
console.log(`[verify-t3a] 详情/PUT/DELETE/404 全对`);

cleanup();
console.log(`[verify-t3a] 全链路绿 (+${Date.now() - t0}ms)`);
process.exit(0);
