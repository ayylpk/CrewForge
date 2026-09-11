// ============================================================
// edit-anchor-smoke.ts —— 编辑锚点结构化降级自测（零 LLM）
//
//   背景：edit 逐字失配就报错，会逼模型整文件重写（贵 + 易改错地方）。
//   本冒烟固化两级降级，且**接线到 executeFileTool**（防"写了没接线的死代码"）：
//     ① 归一化窗口匹配：忽略缩进/行尾空白，**仅唯一命中**时采用（多处命中一律拒绝）
//     ② 相似位置候选：都失配时给行号+片段，把"重试"变成"照着改"
//     ③ 多处命中且未声明 replace_all → 拒绝（不许瞎改）
// ============================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cfanchor-"));
process.env.RUNS_ROOT = TMP;
process.env.PROJECT_ID = "911";
fs.mkdirSync(path.join(TMP, "p911"), { recursive: true });

const { executeFileTool } = await import("../../fileTools");
const { findNormalizedWindow, findAnchorCandidates, renderAnchorCandidates } = await import("./editAnchor");
type Ctx = import("../../fileTools").ToolExecCtx;

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string): void {
    if (cond) { pass++; console.log(`  ✓ ${msg}`); }
    else { fail++; console.log(`  ✗ ${msg}`); }
}
function freshCtx(file: string, content: string): Ctx {
    const ctx: Ctx = { pid: 911, written: new Map([[file, content]]), planned: [file], landed: null };
    return ctx;
}

const SRC = [
    "public class Demo {",
    "    public int a() {",
    "        int x = 1;",
    "        return x;",
    "    }",
    "}",
].join("\n");

console.log("=== ① 归一化窗口匹配 ===");
{
    const win = findNormalizedWindow(SRC, "public int a() {\nint x = 1;\nreturn x;\n}");   // 缩进全丢
    ok(win != null && win.line === 2 && win.lines === 4, `忽略缩进后唯一命中（第 ${win?.line} 行起 ${win?.lines} 行）`);
    const exact = findNormalizedWindow(SRC, "int x = 1;");
    ok(exact != null && exact.line === 3, "逐字子串也能命中（第 3 行）");

    const twice = ["a", "b", "same();", "c", "same();"].join("\n");
    ok(findNormalizedWindow(twice, "same();") === null, "★ 多处命中 → 返回 null（拒绝，不许瞎改）");
    ok(findNormalizedWindow(SRC, "not in this file at all") === null, "完全不含 → null");
    ok(findNormalizedWindow(SRC, "   ") === null, "空锚点 → null");
}

console.log("=== ② 相似位置候选 ===");
{
    const src = [
        "function alpha() {",
        "  const total = computeTotal(items);",
        "  return total;",
        "}",
        "function beta() {",
        "  const total = computeTotal(others);",
        "}",
    ].join("\n");
    const cands = findAnchorCandidates(src, "const total = computeTotal(items);\n  return total;");
    ok(cands.length > 0, `给出候选 ${cands.length} 个`);
    ok(cands[0]!.line === 2, `最佳候选指向第 2 行（实际第 ${cands[0]!.line} 行）`);
    ok(cands[0]!.score > 0.5, `匹配度可读：${(cands[0]!.score * 100).toFixed(0)}%`);
    ok(renderAnchorCandidates(cands).includes("第 2 行"), "候选渲染含行号");
    ok(renderAnchorCandidates([]).includes("先 read"), "无候选时提示先 read");
}

console.log("=== ③ 接线到 executeFileTool ===");
{
    // ① 缩进失配 → 归一化命中并落盘，且**如实告知**
    const file = "backend/src/main/java/com/demo/Demo.java";
    const ctx = freshCtx(file, SRC);
    const r1 = await executeFileTool(ctx, file, "edit", {
        path: file,
        old_text: "public int a() {\nint x = 1;\nreturn x;\n}",     // 去掉缩进
        new_text: "public int a() {\n    int x = 42;\n    return x;\n}",
    });
    ok(r1.ok, `★ 缩进失配仍能修好（${r1.result.slice(0, 60)}）`);
    ok(r1.result.includes("归一化命中"), "★ 如实告知用了归一化匹配（不偷偷改）");
    ok((ctx.written.get(file) ?? "").includes("int x = 42;"), "补丁已生效");

    // ② 完全失配 → 拒绝 + 给候选
    const ctx2 = freshCtx(file, SRC);
    const r2 = await executeFileTool(ctx2, file, "edit", { path: file, old_text: "totallyDifferent();\nreturn null;", new_text: "x" });
    ok(!r2.ok && r2.result.includes("找不到"), "完全失配被拒");
    ok(/(第 \d+ 行|先 read)/.test(r2.result), `★ 拒绝时给出可照抄的线索：${r2.result.split("\n")[1]?.slice(0, 60)}`);

    // ③ 连续失配第二次 → 明确要求先 read
    const r3 = await executeFileTool(ctx2, file, "edit", { path: file, old_text: "stillNothing();", new_text: "x" });
    ok(!r3.ok && r3.result.includes("连续失配"), "★ 连续失配升级话术（先 read 再改，别猜锚点）");

    // ④ 多处命中且未声明 replace_all → 拒绝
    const dup = "same();\nother();\nsame();";
    const ctx4 = freshCtx("a/B.ts", dup);
    const r4 = await executeFileTool(ctx4, "a/B.ts", "edit", { path: "a/B.ts", old_text: "same();", new_text: "changed();" });
    ok(!r4.ok && r4.result.includes("不唯一"), "多点锚点被拒（要求加长锚点或 replace_all）");
    const r5 = await executeFileTool(ctx4, "a/B.ts", "edit", { path: "a/B.ts", old_text: "same();", new_text: "changed();", replace_all: true });
    ok(r5.ok && r5.result.includes("替换 2 处"), `显式 replace_all 才允许多点替换（${r5.result.slice(0, 40)}）`);
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 清理失败无妨 */ }
console.log(`\n[edit-anchor-smoke] 通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
