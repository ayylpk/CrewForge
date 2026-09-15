// ============================================================
// live/dryrun-ledger.ts —— 任务包「起飞前」的自检（零 LLM、零网络）
//
//   发车前要回答三个问题（军令状第 8 条的口径：出问题的成本是整轮预算）：
//     ① 任务包本身过不过 protocol 校验？
//     ② 15 条判据里，有多少能机械翻译成可执行命令？翻译不出来的为什么？
//     ③ 汇总说明它到底在验什么（人工扫一眼有没有"看着绿其实是空的"判据）？
//
//   跑法：bun run developerAgent/live/dryrun-ledger.ts
//   退出码：0=可以发车；1=有判据翻译不出来（发车就是白烧预算）。
// ============================================================

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseInbound } from "../protocol";
import type { ArchitectTask } from "../protocol";
import { prepareCheck } from "./verifier";
import { budgetText } from "../realLlm";

const taskPath = path.resolve(process.argv[2] ?? path.join(import.meta.dir, "ledger-task.json"));
const raw = JSON.parse(fs.readFileSync(taskPath, "utf-8"));
const parsed = parseInbound(raw);
if (!parsed.ok || parsed.message.type !== "architect_task") {
    console.error(`❌ 任务包不合法：${(parsed as { error?: string }).error ?? "不是 architect_task"}`);
    process.exit(1);
}
const task = parsed.message as ArchitectTask;
console.log(`✅ 任务包合法：${task.projectId}/${task.taskId}`);
console.log(`   工作项 ${task.foundationPlan.workItems?.length ?? 0} 个 / 判据 ${task.acceptanceChecks.length} 条 / 允许根 ${task.allowedRoots.join(", ")}`);

// 预算推导（与 runner 同一公式）
const derived = Math.ceil((((task.foundationPlan.workItems?.length ?? 1) * 25) + 20) / 5) * 5;
console.log(`   推导预算 maxLlmCalls=${derived}`);
console.log(`   预算文案（90% 处）：${budgetText({ used: Math.floor(derived * 0.9), total: derived }).replace(/\n/g, " | ").slice(0, 140)}`);

// 用一个假项目目录做翻译演练：只要能解析出命令/探针，就说明判据形状是机器可执行的
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cf-dryrun-"));
fs.mkdirSync(path.join(tmp, "backend"), { recursive: true });
fs.mkdirSync(path.join(tmp, "frontend"), { recursive: true });
fs.writeFileSync(path.join(tmp, "backend", "package.json"), JSON.stringify({ scripts: { build: "tsc", dev: "node dist/index.js" } }));
fs.writeFileSync(path.join(tmp, "frontend", "package.json"), JSON.stringify({ scripts: { build: "vue-tsc -b && vite build" } }));

let executable = 0, skipped = 0;
const skipReasons: string[] = [];
for (const c of task.acceptanceChecks) {
    const p = prepareCheck(tmp, c as never);
    const id = String((c as Record<string, unknown>)["id"]);
    const kind = String((c as Record<string, unknown>)["kind"] ?? "COMMAND");
    if (p.exec) {
        executable++;
        // 只打摘要：显式命令可能很长（探针的 JSON 参数）
        const cmd = `${p.exec.command} ${p.exec.args.join(" ")}`;
        console.log(`  ✅ ${id} [${kind}] ${cmd.length > 110 ? `${cmd.slice(0, 110)}…` : cmd}  (by=${p.exec.resolvedBy})`);
    } else {
        skipped++;
        skipReasons.push(`${id}: ${p.skipReason}`);
        console.log(`  ⏭ ${id} [${kind}] ${p.skipReason}`);
    }
}
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n可执行 ${executable} / 跳过 ${skipped} / 共 ${task.acceptanceChecks.length}`);

// 断言强度体检：CONTRACT 里有没有"只验状态码、正文什么都不验"的弱判据
const weak: string[] = [];
for (const c of task.acceptanceChecks) {
    const r = c as Record<string, unknown>;
    if (r["kind"] !== "CONTRACT") continue;
    const hasStructured = Array.isArray(r["assertJson"]) && (r["assertJson"] as unknown[]).length > 0;
    const hasContains = typeof r["expectBodyContains"] === "string";
    // 4xx/5xx 的负向判据只看状态码是合理的（400 本身就是结论）
    const status = Number(r["expectedStatus"] ?? 200);
    if (!hasStructured && !hasContains && status < 400) {
        weak.push(`${String(r["id"])}：${String(r["method"])} ${String(r["path"])} 只断言状态码 ${status}，正文没有任何断言`);
    }
}
console.log(weak.length === 0
    ? "✅ 断言强度体检：所有 2xx 判据都带了正文断言（无「只验状态码」的弱判据）"
    : `⚠️ 弱判据 ${weak.length} 条：\n  ${weak.join("\n  ")}`);

if (skipped > 0) {
    console.log("\n❌ 有判据翻译不出来，发车会白烧预算：");
    for (const s of skipReasons) console.log(`  · ${s}`);
    process.exit(1);
}
console.log("\n✅ 起飞前自检通过：所有判据都可机械执行。");
process.exit(0);
