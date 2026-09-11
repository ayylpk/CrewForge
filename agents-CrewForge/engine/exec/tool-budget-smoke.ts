// ============================================================
// tool-budget-smoke.ts —— 工具循环预算化回归（C-4，零 LLM）
//
//   治的病（runs/p9 实锤）：单文件连续十余轮 grep 全未命中 → 轮次耗尽 → 文件判失败 →
//   整阶段 0 产出。本冒烟固化新行为：
//     ① 连续未命中 → 第 2 次起下发"停止查证、立即交付"话术
//     ② 临近预算尽头 → 下发"预算告警/预算保护"，只读工具被机械拒绝
//     ③ **宽限轮**：常规轮用尽后仍有一轮只许交付（把"必然失败"换回"可能成功"）
//     ④ exitReason 明确区分 landed / exhausted / gave_up（调用方据此退单发老路）
// ============================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cftoolbudget-"));
process.env.RUNS_ROOT = TMP;
process.env.PROJECT_ID = "907";
fs.mkdirSync(path.join(TMP, "p907"), { recursive: true });

const { runToolFileJob } = await import("../../fileTools");
type Ctx = import("../../fileTools").ToolExecCtx;

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string): void {
    if (cond) { pass++; console.log(`  ✓ ${msg}`); }
    else { fail++; console.log(`  ✗ ${msg}`); }
}

function freshCtx(): Ctx {
    return { pid: 907, written: new Map(), planned: [], landed: null };
}
function tc(name: string, args: Record<string, unknown>, id: string) {
    return { name, args, id, type: "tool_call" };
}
function aim(tool_calls: any[], content = "") {
    return { content, tool_calls };
}
function joinText(msgs: any[]): string {
    return msgs.map(m => {
        const c = m?.content;
        return typeof c === "string" ? c : JSON.stringify(c ?? "");
    }).join("\n");
}

// ---------- ① 无进展循环 → 强制交付（宽限轮救回产出） ----------
console.log("=== ① 无进展循环 → 宽限轮强制交付 ===");
{
    const ctx = freshCtx();
    let sawStopHint = false, sawBudgetHint = false, sawGraceHint = false, grepMisses = 0;
    const r = await runToolFileJob({
        system: "s", targetFile: "m.ts", ctx, maxRounds: 5, timeoutMs: 5_000, label: "budget-a",
        round: async (msgs) => {
            const text = joinText(msgs);
            if (text.includes("停止查证")) sawStopHint = true;
            if (text.includes("预算告警")) sawBudgetHint = true;
            if (text.includes("最后一次机会")) sawGraceHint = true;
            // ★ 关键：预算硬令是**提前**下发的（不是等被拒才知道），模型据此在当轮就交付
            if (text.includes("只允许 write/edit") || text.includes("最后一次机会")) {
                return aim([tc("write", { path: "m.ts", content: "export const m = 1;" }, "w1")]);
            }
            grepMisses++;
            return aim([tc("grep", { pattern: `no-such-symbol-${grepMisses}` }, `g${grepMisses}`)]);
        },
    });
    ok(r === "export const m = 1;", "★ 宽限轮救回：无进展循环最终仍产出文件（旧行为=判失败）");
    ok(fs.existsSync(path.join(TMP, "p907", "m.ts")), "文件已落盘");
    ok(sawStopHint, "第 2 次未命中即下发『停止查证』话术（旧话术是『换个关键词』）");
    ok(sawBudgetHint, "预算告警提前下发（模型当轮即可交付，不必先被拒）");
    ok(!sawGraceHint, "本例在常规轮内已交付，未动用到宽限轮（成本更省）");
    ok(ctx.exitReason === "landed", `exitReason=landed（实际 ${ctx.exitReason}）`);
}

// ---------- ①b 硬令后仍拖延 → 宽限轮兜底 ----------
console.log("=== ①b 拖延到宽限轮 ===");
{
    const ctx = freshCtx();
    let grace = false;
    const r = await runToolFileJob({
        system: "s", targetFile: "g.ts", ctx, maxRounds: 2, timeoutMs: 5_000, label: "budget-a2",
        round: async (msgs) => {
            const text = joinText(msgs);
            if (text.includes("最后一次机会")) grace = true;
            // 即使被下硬令也继续查证（模拟不听话的弱模型）→ 只有宽限轮才交付
            if (grace) return aim([tc("write", { path: "g.ts", content: "export const g = 1;" }, "w")]);
            return aim([tc("grep", { pattern: "y" }, "g")]);
        },
    });
    ok(grace, "用完常规轮后进入宽限轮并下发硬令");
    ok(r === "export const g = 1;", "★ 宽限轮确实把产出救回来");
}

// ---------- ② 永不交付 → exhausted（调用方退老路） ----------
console.log("=== ② 永不交付 ===");
{
    const ctx = freshCtx();
    const r = await runToolFileJob({
        system: "s", targetFile: "n.ts", ctx, maxRounds: 3, timeoutMs: 5_000, label: "budget-b",
        round: async () => aim([tc("grep", { pattern: "x" }, "g")]),
    });
    ok(r === null, "轮次耗尽返回 null");
    ok(ctx.exitReason === "exhausted", `★ exitReason=exhausted（实际 ${ctx.exitReason}）——调用方据此退单发老路`);
    ok(!fs.existsSync(path.join(TMP, "p907", "n.ts")), "未落盘（不写坏文件）");
}

// ---------- ③ 预算保护：末轮只读工具被机械拒绝（直接单测工具层，可观测） ----------
console.log("=== ③ 预算保护：只读工具被机械拒绝 ===");
{
    const ctx = freshCtx();
    ctx.deliveryOnly = true;
    const { executeFileTool } = await import("../../fileTools");
    const ls = await executeFileTool(ctx, "r.ts", "ls", {});
    const gr = await executeFileTool(ctx, "r.ts", "grep", { pattern: "x" });
    const rd = await executeFileTool(ctx, "r.ts", "read", { path: "r.ts" });
    ok(!ls.ok && ls.result.includes("预算保护"), "ls 被拒且原因写明『预算保护』");
    ok(!gr.ok && gr.result.includes("预算保护"), "grep 被拒");
    ok(!rd.ok && rd.result.includes("预算保护"), "read 被拒");
    const wr = await executeFileTool(ctx, "r.ts", "write", { path: "r.ts", content: "export const r = 1;" });
    ok(wr.ok && ctx.exitReason === undefined, "同一状态下 write 仍放行（不会把交付也堵死）");
}

// ---------- ④ 正常交付 ----------
console.log("=== ④ 正常路径 ===");
{
    const ctx = freshCtx();
    const r = await runToolFileJob({
        system: "s", targetFile: "q.ts", ctx, maxRounds: 3, timeoutMs: 5_000, label: "budget-d",
        round: async () => aim([tc("write", { path: "q.ts", content: "export const q = 1;" }, "w")]),
    });
    ok(r === "export const q = 1;" && ctx.exitReason === "landed", "首轮交付即终止（exitReason=landed）");
}

// ---------- ⑤ 白卷 ×2 → gave_up ----------
console.log("=== ⑤ 只用嘴交付 ===");
{
    const ctx = freshCtx();
    const r = await runToolFileJob({
        system: "s", targetFile: "z.ts", ctx, maxRounds: 4, timeoutMs: 5_000, label: "budget-e",
        round: async () => aim([], "我已经完成了这个文件"),
    });
    ok(r === null && ctx.exitReason === "gave_up", `★ 两次白卷 → exitReason=gave_up（实际 ${ctx.exitReason}）`);
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 清理失败无妨 */ }
console.log(`\n[tool-budget-smoke] 通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
