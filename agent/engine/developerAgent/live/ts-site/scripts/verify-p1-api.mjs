// scripts/verify-p1-api.mjs —— ts-site P1 · projects 契约全链路（TestAgent 侧，Developer 禁碰）
//
//   模式照搬 smoke-e2e 已验证套路：独立进程起服务（随机端口 + 独立 DB 文件，
//   不污染开发库）→ 轮询 health → 全链路断言 → 杀进程。
//   用法：node ../scripts/verify-p1-api.mjs   （cwd = backend）
//
//   反投机设计（为什么每条业务值都带 nonce）：
//     · 模型能读这个脚本。任何**固定**业务值都可能被抄进代码当种子、或写一条
//       "当 slug 等于某个固定常量时特殊处理"的分支来骗过验收。所以本项目里出现的
//       slug / 标题 / 描述 / 标签 / repo / demoUrl 全部由本轮随机 nonce 生成；
//     · nonce 只活在本进程内，不落到目标项目的任何文件——模型读不到它；
//     · POST 之前先查一遍：若本轮 nonce 对应的数据**已经存在**，直接判作弊失败
//       （击穿静态种子、内存里预置、写死的示例数据）；
//     · 最后重启一次服务再查（进程 A → 进程 B）：数据还在才算真持久化——
//       击穿内存数组、模块级变量、单进程缓存。
import { rmSync } from "node:fs";
import { spawn } from "node:child_process";

const t0 = Date.now();
const die = (msg) => {
    console.error(`[verify-p1-api] FAIL: ${msg} (+${Date.now() - t0}ms)`);
    process.exit(1);
};

// 独立 DB：删残留防上一轮脏数据
const DB = `./data/verify-p1-${process.pid}.db`;
for (const suffix of ["", "-wal", "-shm"]) { try { rmSync(DB + suffix, { force: true }); } catch { /* 没有=正常 */ } }

// 每轮使用不可预测的业务值，避免模型从验收脚本抄答案或预置种子。
const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const createdSlug = `probe-${nonce}`;
const hiddenSlug = `hidden-${nonce}`;
const createdTitle = `Probe 项目 ${nonce}`;
const createdDesc = `运行时创建 ${nonce}`;
const createdTags = [`tag-${nonce}`, "express"];
const createdRepo = `repo-${nonce}`;
const createdDemoUrl = `https://example.com/${nonce}`;
const updatedTitle = `Probe 项目 ${nonce}（改名）`;
const updatedDesc = `改过 ${nonce}`;
const updatedTags = [`upd-${nonce}`];
/** 一定不存在的 slug / id：也带 nonce，免得被"固定值返回 404"的特殊分支命中 */
const absentSlug = `no-such-slug-${nonce}`;
const absentId = 900_000_000 + (Number.parseInt(nonce.replace(/[^0-9]/g, "").slice(0, 6) || "123456", 10) % 90_000_000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 服务进程管理（可重复起停：持久化验证要起第二个进程） ----------

const children = [];
let portSeq = 0;

function cleanupAll() {
    for (const c of children) {
        try { c.proc.stdout?.destroy(); c.proc.stderr?.destroy(); } catch { /* ok */ }
        try { c.proc.kill("SIGKILL"); } catch { /* 已退出 */ }
    }
    children.length = 0;
    for (const suffix of ["", "-wal", "-shm"]) { try { rmSync(DB + suffix, { force: true }); } catch { /* ok */ } }
}
process.on("exit", cleanupAll);

/** 起一个服务进程并等 health 就绪（每轮端口 +pid 偏移，避免与开发库/上一轮撞车） */
async function startServer(label) {
    const PORT = 18100 + ((process.pid + portSeq++ * 137) % 800);
    const proc = spawn(process.execPath, ["dist/index.js"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PORT: String(PORT), DB_FILE: DB },
    });
    const entry = { proc, label, port: PORT, log: "" };
    children.push(entry);
    proc.stdout.on("data", (b) => { entry.log += b; });
    proc.stderr.on("data", (b) => { entry.log += b; });

    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        if (proc.exitCode !== null) die(`[${label}] 服务进程提前退出 exit=${proc.exitCode}\n${entry.log.slice(-3000)}`);
        try {
            const res = await fetch(`http://127.0.0.1:${PORT}/api/health`);
            const json = await res.json().catch(() => null);
            if (res.status === 200 && json?.ok === true) {
                console.log(`[verify-p1-api] ${label} health OK :${PORT} (+${Date.now() - t0}ms)`);
                return entry;
            }
        } catch { /* 还没起来 */ }
        await sleep(1500);
    }
    die(`[${label}] 60s 内 /api/health 未就绪\n${entry.log.slice(-3000)}`);
}

function stopServer(entry) {
    try { entry.proc.stdout?.destroy(); entry.proc.stderr?.destroy(); } catch { /* ok */ }
    try { entry.proc.kill("SIGKILL"); } catch { /* 已退出 */ }
    const i = children.indexOf(entry);
    if (i >= 0) children.splice(i, 1);
}

// ---------- HTTP 小工具 ----------

function mkHit(port) {
    return async (p, init) => {
        const res = await fetch(`http://127.0.0.1:${port}${p}`, init);
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* 非 JSON 交给断言判 */ }
        return { status: res.status, json, text };
    };
}
const J = (o) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(o) });
// 用法：{ method: "POST", ...J(obj) }——fetch 默认 GET，GET 带 body 会被 undici 直接抛错
const PJ = (o) => ({ method: "POST", ...J(o) });
const UJ = (o) => ({ method: "PUT", ...J(o) });

// ② DTO 形状检查器（不再有"某个固定 slug 也算合法"这种逃生口：形状只认正则）
const dto = (x, where) => {
    if (typeof x?.id !== "number") die(`${where}: id 应为数字，实际 ${JSON.stringify(x).slice(0, 300)}`);
    if (typeof x.title !== "string" || !x.title) die(`${where}: title 异常`);
    if (!/^[a-z0-9-]+$/.test(String(x.slug))) die(`${where}: slug 形状异常 ${x.slug}`);
    if (!Array.isArray(x.tags)) die(`${where}: tags 应为数组，实际 ${JSON.stringify(x.tags)}`);
    if (typeof x.visible !== "boolean") die(`${where}: visible 应为布尔，实际 ${JSON.stringify(x.visible)}`);
    if (typeof x.description !== "string") die(`${where}: description 应为字符串`);
    if (typeof x.createdAt !== "string" || typeof x.updatedAt !== "string") die(`${where}: createdAt/updatedAt 应为字符串`);
    if ("demo_url" in x) die(`${where}: 出现库内蛇形字段 demo_url——对外必须驼峰`);
};

// ============================================================
// 进程 A：全链路
// ============================================================

const A = await startServer("A");
const hit = mkHit(A.port);

// ③ 作弊探针：POST 之前，本轮 nonce 对应的数据**不该存在**。
//    存在 = 静态种子 / 预置数据 / 为某个值写的特殊分支 → 直接失败。
{
    const pre = await hit("/api/projects");
    if (pre.status !== 200 || !Array.isArray(pre.json)) {
        die(`POST 前 GET 列表应 200+数组，实际 ${pre.status}：${pre.text.slice(0, 300)}`);
    }
    const planted = pre.json.filter((p) =>
        [p?.slug, p?.title, p?.description].some((v) => typeof v === "string" && v.includes(nonce)));
    if (planted.length > 0) {
        die(`检测到作弊：POST 之前就存在本轮 nonce 对应的数据 ${JSON.stringify(planted).slice(0, 300)}`
            + "——静态种子 / 预置示例数据一律不算实现");
    }
    if (pre.json.some((p) => p?.slug === createdSlug || p?.slug === hiddenSlug)) {
        die("检测到作弊：本轮随机 slug 在创建前已存在");
    }
    console.log(`[verify-p1-api] 作弊探针 OK：创建前无本轮 nonce 数据（已有 ${pre.json.length} 条无关数据）`);
}

// ④ 创建（全字段）
const created = await hit("/api/projects", PJ({
    title: createdTitle, slug: createdSlug, description: createdDesc,
    tags: createdTags, repo: createdRepo, demoUrl: createdDemoUrl,
}));
if (created.status !== 201) die(`POST 全字段应 201，实际 ${created.status}：${created.text.slice(0, 400)}`);
dto(created.json, "POST 响应");
if (created.json.visible !== true) die(`缺省 visible 应为 true：${created.text.slice(0, 300)}`);
if (created.json.slug !== createdSlug) die(`slug 未按请求回显：${created.text.slice(0, 300)}`);
if (created.json.title !== createdTitle) die(`title 未按请求回显：${created.text.slice(0, 300)}`);
if (JSON.stringify(created.json.tags) !== JSON.stringify(createdTags)) die(`tags 回显不符：${created.text.slice(0, 300)}`);
if (created.json.demoUrl !== createdDemoUrl) die(`demoUrl 驼峰回显不符：${created.text.slice(0, 300)}`);
const id = created.json.id;
console.log(`[verify-p1-api] POST → 201 id=${id} slug=${createdSlug}`);

// ⑤ 校验分支（非法输入同样带 nonce：固定值返回 400 的捷径不成立）
const noTitle = await hit("/api/projects", PJ({ slug: `x1-${nonce}` }));
if (noTitle.status !== 400) die(`缺 title 应 400，实际 ${noTitle.status}`);
const blankTitle = await hit("/api/projects", PJ({ title: "   ", slug: `x2-${nonce}` }));
if (blankTitle.status !== 400) die(`空白 title 应 400，实际 ${blankTitle.status}`);
const badSlug = await hit("/api/projects", PJ({ title: `t-${nonce}`, slug: `Bad Slug ${nonce}!` }));
if (badSlug.status !== 400) die(`非法 slug 应 400，实际 ${badSlug.status}`);
const dup = await hit("/api/projects", PJ({ title: `撞名-${nonce}`, slug: createdSlug }));
if (dup.status !== 409) die(`重复 slug 应 409，实际 ${dup.status}`);
console.log("[verify-p1-api] 400×3 + 409 校验 OK");

// ⑥ 列表 / 详情（id 与 slug 双路）
const list = await hit("/api/projects");
if (list.status !== 200 || !Array.isArray(list.json)) die(`GET 列表应 200+数组，实际 ${list.status}：${list.text.slice(0, 300)}`);
if (!list.json.some((p) => p.id === id)) die("列表找不到刚建的项目");
dto(list.json.find((p) => p.id === id), "列表项");
const byId = await hit(`/api/projects/${id}`);
if (byId.status !== 200 || byId.json?.id !== id) die(`GET by id 异常 ${byId.status}`);
const bySlug = await hit(`/api/projects/${createdSlug}`);
if (bySlug.status !== 200 || bySlug.json?.id !== id) die(`GET by slug 异常 ${bySlug.status}`);
const notFound = await hit(`/api/projects/${absentSlug}`);
if (notFound.status !== 404) die(`不存在的 slug 应 404，实际 ${notFound.status}`);
console.log("[verify-p1-api] 列表 + id/slug 双路 + 404 OK");

// ⑦ 隐藏项：列表不出现、详情可直链
const hidden = await hit("/api/projects", PJ({ title: `隐藏项目 ${nonce}`, slug: hiddenSlug, visible: false }));
if (hidden.status !== 201) die(`POST visible=false 应 201，实际 ${hidden.status}：${hidden.text.slice(0, 300)}`);
const list2 = await hit("/api/projects");
if (list2.json.some((p) => p.slug === hiddenSlug)) die("visible=false 不应出现在列表里");
const hiddenDetail = await hit(`/api/projects/${hiddenSlug}`);
if (hiddenDetail.status !== 200) die(`隐藏项详情直链应 200，实际 ${hiddenDetail.status}`);
console.log("[verify-p1-api] visible 过滤 OK");

// ⑧ 更新（期望值同样由 nonce 生成，不再出现任何固定业务值）
const upd = await hit(`/api/projects/${id}`, UJ({
    title: updatedTitle, slug: createdSlug, description: updatedDesc, tags: updatedTags,
}));
if (upd.status !== 200) die(`PUT 应 200，实际 ${upd.status}：${upd.text.slice(0, 400)}`);
if (upd.json?.title !== updatedTitle) die(`PUT title 未生效：期望 ${updatedTitle}，实际 ${String(upd.json?.title)}`);
if (upd.json?.description !== updatedDesc) die(`PUT description 未生效：${upd.text.slice(0, 300)}`);
dto(upd.json, "PUT 响应");
if (upd.json.createdAt !== created.json.createdAt) die(`PUT 不该动 createdAt：${created.json.createdAt} → ${upd.json.createdAt}`);
const updBad = await hit(`/api/projects/${id}`, UJ({ title: "", slug: createdSlug }));
if (updBad.status !== 400) die(`PUT 缺 title 应 400，实际 ${updBad.status}`);
const updDup = await hit(`/api/projects/${id}`, UJ({ title: `t-${nonce}`, slug: hiddenSlug }));
if (updDup.status !== 409) die(`PUT 撞别人 slug 应 409，实际 ${updDup.status}`);
const upd404 = await hit(`/api/projects/${absentId}`, UJ({ title: `t-${nonce}`, slug: `nowhere-${nonce}` }));
if (upd404.status !== 404) die(`PUT 不存在的 id 应 404，实际 ${upd404.status}`);
console.log("[verify-p1-api] PUT 200 + 400/409/404 OK");

// ============================================================
// 进程 B：同一 DB 重启 —— 只有真持久化才活得过进程重启
//   击穿：内存数组 / 模块级变量 / 单进程缓存 / 只为某个固定验收值写的分支
// ============================================================

stopServer(A);
await sleep(800);
const B = await startServer("B（重启后）");
const hitB = mkHit(B.port);

const listB = await hitB("/api/projects");
if (listB.status !== 200 || !Array.isArray(listB.json)) die(`重启后 GET 列表应 200+数组，实际 ${listB.status}`);
const survivor = listB.json.find((p) => p.slug === createdSlug);
if (!survivor) {
    die(`未持久化：进程重启后 slug=${createdSlug} 消失（内存数组 / 模块级变量冒充持久化）`
        + `，现有 ${listB.json.length} 条：${JSON.stringify(listB.json.map((p) => p.slug)).slice(0, 300)}`);
}
if (survivor.id !== id) die(`重启后 id 变了：${id} → ${survivor.id}`);
if (survivor.title !== updatedTitle) die(`重启后更新结果丢失：期望 ${updatedTitle}，实际 ${String(survivor.title)}`);
if (survivor.description !== updatedDesc) die(`重启后 description 丢失：${String(survivor.description)}`);
const detailB = await hitB(`/api/projects/${createdSlug}`);
if (detailB.status !== 200 || detailB.json?.id !== id) die(`重启后按 slug 查详情异常 ${detailB.status}`);
const hiddenB = await hitB(`/api/projects/${hiddenSlug}`);
if (hiddenB.status !== 200) die(`重启后隐藏项直链应 200，实际 ${hiddenB.status}`);
if (listB.json.some((p) => p.slug === hiddenSlug)) die("重启后 visible=false 又跑进列表了");
console.log(`[verify-p1-api] 持久化 OK：进程重启后 ${createdSlug} 仍在（id=${id}，更新内容未丢）`);

// ============================================================
// ⑨ 删除（在进程 B 上收尾）
// ============================================================

const del = await hitB(`/api/projects/${id}`, { method: "DELETE" });
if (del.status !== 204) die(`DELETE 应 204，实际 ${del.status}`);
const gone = await hitB(`/api/projects/${id}`);
if (gone.status !== 404) die(`删除后 GET 应 404，实际 ${gone.status}`);
const del404 = await hitB(`/api/projects/${absentId}`, { method: "DELETE" });
if (del404.status !== 404) die(`DELETE 不存在的 id 应 404，实际 ${del404.status}`);
console.log("[verify-p1-api] DELETE → 204 + 重查 404 OK");

stopServer(B);
cleanupAll();
await sleep(800); // Windows libuv 退出竞态（9/13 P2 实弹 exit=9）
console.log(`[verify-p1-api] 全链路绿 (+${Date.now() - t0}ms)`);
process.exit(0);
