// ============================================================
// t7b-smoke.ts —— T7b 工位文件工具冒烟（9/8，假模型脚本驱动，零真 LLM）
//
//   覆盖：①executeFileTool 三工具语义：write 过闸落盘/红不落、edit 锚点唯一性/锁内重读、read 截断与不存在+沙箱（../与绝对路径被拒，9/9 补洞）
//         ②越界写（非目标文件）与 extraGate（幻觉闸搬家）拒绝路径
//         ③withPathLock 同路径严格串行
//         ④runToolFileJob 工具循环：红→edit 修→落地即终止（机械判定）、白卷提醒一次再犯判负、轮次耗尽 null
//   产物落系统临时目录（RUNS_ROOT+PROJECT_ID 假身份），writeWorkspace 的 DB upsert 落空只 warn（旁路实锤）。
//   跑法：bun run t7b-smoke.ts
// ============================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ⚠️ 先立环境变量再动态 import——runEnv 的 RUNS_ROOT 是模块加载期定死的（静态 import 提前的话会写到引擎 runs/ 去）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "crew-t7b-"));
process.env.RUNS_ROOT = TMP;
process.env.PROJECT_ID = "907";

const { executeFileTool, runToolFileJob, withPathLock } = await import("./fileTools");
const { pool } = await import("./db");
type ToolExecCtx = import("./fileTools").ToolExecCtx;

let pass = 0, fail = 0;
function ok(cond: boolean, label: string, extra = "") {
    if (cond) { pass++; console.log(`  ✓ ${label}`); }
    else { fail++; console.log(`  ✗ ${label} ${extra}`); }
}
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function freshCtx(extraGate?: ToolExecCtx["extraGate"]): ToolExecCtx {
    return { pid: 907, written: new Map(), planned: [], extraGate, landed: null };
}
const landedOnDisk = (p: string) => fs.existsSync(path.join(TMP, "p907", p));

async function main() {
    console.log("=== ① write：过闸落盘 / 红不落 ===");
    const ctx = freshCtx();
    const bad = await executeFileTool(ctx, "a.ts", "write", { path: "a.ts", content: "function f( {" });
    ok(bad.ok === false && !landedOnDisk("a.ts") && bad.result.includes("闸门拒绝"), "坏码 write 被拒且未落盘", bad.result.slice(0, 80));
    const good = await executeFileTool(ctx, "a.ts", "write", { path: "a.ts", content: "export const a = 1;" });
    ok(good.ok === true && landedOnDisk("a.ts") && ctx.landed === "export const a = 1;", "好码 write 落盘+landed 置位");
    const cross = await executeFileTool(ctx, "a.ts", "write", { path: "b.ts", content: "export const b = 2;" });
    ok(cross.ok === false && !landedOnDisk("b.ts") && cross.result.includes("越界"), "写别人的文件被拒（登记制在工具层的兑现）");

    console.log("=== ② edit：锚点语义 + 锁内重读（每个子测试独立文件，不串扰） ===");
    const e1 = freshCtx();
    await executeFileTool(e1, "e1.ts", "write", { path: "e1.ts", content: "export const a = 1;" });
    const miss = await executeFileTool(e1, "e1.ts", "edit", { path: "e1.ts", old_text: "不存在的锚点", new_text: "x" });
    ok(miss.ok === false && miss.result.includes("找不到"), "old_text 不命中 → 报错不落盘");
    const hit = await executeFileTool(e1, "e1.ts", "edit", { path: "e1.ts", old_text: "a = 1", new_text: "a = 2" });
    ok(hit.ok === true && fs.readFileSync(path.join(TMP, "p907", "e1.ts"), "utf-8") === "export const a = 2;",
        "edit 唯一锚点→补丁落盘（锁内重读最新版）");

    const e2 = freshCtx();
    await executeFileTool(e2, "e2.ts", "write", { path: "e2.ts", content: "const p = 1;\nconsole.log(p);\nconsole.log(p);" });
    const notUnique = await executeFileTool(e2, "e2.ts", "edit", { path: "e2.ts", old_text: "console.log(p);", new_text: "log2();" });
    ok(notUnique.ok === false && notUnique.result.includes("不唯一"), "多处命中且没开 replace_all → 拒");
    const all = await executeFileTool(e2, "e2.ts", "edit", { path: "e2.ts", old_text: "console.log(p);", new_text: "log2();", replace_all: true });
    const allTxt = fs.readFileSync(path.join(TMP, "p907", "e2.ts"), "utf-8");
    ok(all.ok === true && allTxt.split("log2();").length - 1 === 2 && !allTxt.includes("console.log"),
        "replace_all=true 两处全替换落盘", allTxt);

    const e3 = freshCtx();
    await executeFileTool(e3, "e3.ts", "write", { path: "e3.ts", content: "export const k = 1;" });
    const editBad = await executeFileTool(e3, "e3.ts", "edit", { path: "e3.ts", old_text: "k = 1", new_text: "{ = 1" });
    ok(editBad.ok === false && fs.readFileSync(path.join(TMP, "p907", "e3.ts"), "utf-8").includes("k = 1"),
        "edit 结果过不了闸 → 补丁不落盘（原文件完好）");

    console.log("=== ③ read + extraGate ===");
    const readMiss = await executeFileTool(e1, "e1.ts", "read", { path: "nowhere.ts" });
    ok(readMiss.ok === false && readMiss.result.includes("不存在"), "read 缺失文件=错误材料回给模型");
    const readHit = await executeFileTool(e1, "e1.ts", "read", { path: "e1.ts" });
    ok(readHit.ok === true && readHit.result.includes("export const"), "read 命中返内容", readHit.result.slice(0, 40));
    // 9/9 补洞：读口沙箱——写口一直有 safeRealPath 挡逃逸，读口原先裸奔（../ 上跳能摸产物树外）
    const readEsc = await executeFileTool(e1, "e1.ts", "read", { path: "../../../Windows/win.ini" });
    ok(readEsc.ok === false, "read 沙箱：../ 上跳被拒", readEsc.result.slice(0, 60));
    const readAbs = await executeFileTool(e1, "e1.ts", "read", { path: "/etc/passwd" });
    ok(readAbs.ok === false, "read 沙箱：绝对路径被拒", readAbs.result.slice(0, 60));
    const ghostGateCtx = freshCtx(async (_fp, code) => (code.includes("<t-ghost") ? ["TDesign 不存在组件：<t-ghost>"] : []));
    const vueBad = await executeFileTool(ghostGateCtx, "V.vue", "write", { path: "V.vue", content: "<template><t-ghost></t-ghost></template>" });
    ok(vueBad.ok === false && vueBad.result.includes("t-ghost") && !landedOnDisk("V.vue"),
        "幻觉闸搬进 extraGate：红=不落盘错因回给模型", JSON.stringify(vueBad.result?.slice?.(0, 80) ?? vueBad));

    console.log("=== ④ withPathLock 同路径串行 ===");
    const seq: string[] = [];
    const job = async (tag: string, hold: number) => withPathLock("k", async () => { seq.push(tag + "↑"); await sleep(hold); seq.push(tag + "↓"); });
    await Promise.all([job("A", 30), job("B", 5), job("C", 5)]);
    ok(seq.join("") === "A↑A↓B↑B↓C↑C↓", "同 key 严格排队（A 慢不串 B/C）", seq.join(""));
    const other = withPathLock("other", async () => "并行不受阻");
    ok((await other) === "并行不受阻", "不同 key 不互相等");

    console.log("=== ⑤ runToolFileJob 循环（假模型脚本） ===");
    const aim = (toolCalls: any[], text = "") => ({ content: text, tool_calls: toolCalls });
    const tc = (name: string, args: any, id: string) => ({ name, args, id });

    // a) 坏 write → 看错 → 好 write：两轮落地
    const ctxA = freshCtx();
    let histSeen = 0;
    const roundsA = [
      aim([tc("write", { path: "s.ts", content: "const {" }, "t1")]),
      aim([tc("write", { path: "s.ts", content: "export const ok = 1;" }, "t2")]),
    ];
    const ra = await runToolFileJob({
        system: "s", targetFile: "s.ts", ctx: ctxA, maxRounds: 4, timeoutMs: 5_000, label: "smoke-a",
        round: async (msgs) => { histSeen = msgs.length; return roundsA.shift()!; },
    });
    ok(ra === "export const ok = 1;" && landedOnDisk("s.ts"), "红→修→落地即终止（机械终止信号）", String(ra));
    ok(histSeen >= 3, "工具结果（ToolMessage）回进了对话", `hist=${histSeen}`);

    // b) 白卷一次→提醒→交付
    const ctxB = freshCtx();
    let n = 0;
    const rb = await runToolFileJob({
        system: "s", targetFile: "n.ts", ctx: ctxB, maxRounds: 4, timeoutMs: 5_000, label: "smoke-b",
        round: async () => { n++; return n === 1 ? aim([], "我觉得这文件很简单……") : aim([tc("write", { path: "n.ts", content: "export const n = 1;" }, "t1")]); },
    });
    ok(rb !== null && n === 2, "只用嘴交付被提醒一次后接受工具路径", `n=${n}`);

    // c) 连吃白卷 → null（老路判失败）
    const ctxC = freshCtx();
    const rc = await runToolFileJob({
        system: "s", targetFile: "m.ts", ctx: ctxC, maxRounds: 4, timeoutMs: 5_000, label: "smoke-c",
        round: async () => aim([], "口头完成×2"),
    });
    ok(rc === null && !landedOnDisk("m.ts"), "两次白卷=判负（不靠模型自封完成）");

    // d) 轮次耗尽：一直坏 write
    const ctxD = freshCtx();
    const rd = await runToolFileJob({
        system: "s", targetFile: "d.ts", ctx: ctxD, maxRounds: 3, timeoutMs: 5_000, label: "smoke-d",
        round: async () => aim([tc("write", { path: "d.ts", content: "const {" }, "t")]),
    });
    ok(rd === null && !landedOnDisk("d.ts"), "轮次耗尽 null（调用方按文件失败走返工）");

    // e) 假模型抛异常 → 冒泡给调用方（toolModeDead 降级路径的触发器）
    let threw = false;
    try {
        await runToolFileJob({ system: "s", targetFile: "e.ts", ctx: freshCtx(), maxRounds: 2, timeoutMs: 5_000, label: "smoke-e",
            round: async () => { throw new Error("端点不支持 tools"); } });
    } catch { threw = true; }
    ok(threw, "异常冒泡（工位 catch 后本进程退老路）");

    console.log(`\n=== 汇总：${pass} 绿 / ${fail} 红 ===`);
    await sleep(300);                          // 让 writeWorkspace 的 DB upsert 旁路 warn 落完
    await pool.end().catch(() => {});          // 无库环境：冲掉连接尝试，干净退出
    fs.rmSync(TMP, { recursive: true, force: true });
    if (fail > 0) process.exit(1);
}

main().catch(e => { console.error("冒烟脚本自身炸了:", e); process.exit(2); });
