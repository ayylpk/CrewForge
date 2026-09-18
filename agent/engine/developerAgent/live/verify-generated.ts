// ============================================================
// live/verify-generated.ts —— 对**已生成的项目**独立跑一遍验收站
//
//   用途：runner 被中途停掉后，代码写得对不对是可以直接测的——
//   不必重跑整轮 LLM。本脚本复用 live/verifier.ts（与正式验收同一份），
//   把任务包里的 acceptanceChecks 全部真跑。
//
//   跑法：bun run developerAgent/live/verify-generated.ts <task.json> <projectDir>
//   退出码：0=全绿；1=有失败（逐条打现场）。
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { parseInbound } from "../protocol";
import type { ArchitectTask } from "../protocol";
import { acceptanceHashOf } from "../protocol";
import { runAcceptanceChecks, verdictKindOf } from "./verifier";

const taskFile = process.argv[2];
const projectDir = process.argv[3];
if (!taskFile || !projectDir) {
    console.error("用法: bun run developerAgent/live/verify-generated.ts <task.json> <projectDir>");
    process.exit(2);
}

const parsed = parseInbound(JSON.parse(fs.readFileSync(path.resolve(taskFile), "utf-8")));
if (!parsed.ok || parsed.message.type !== "architect_task") {
    console.error("任务包不合法");
    process.exit(2);
}
const task = parsed.message as ArchitectTask;

console.log(`[verify-generated] 项目：${path.resolve(projectDir)}`);
console.log(`[verify-generated] 判据 ${task.acceptanceChecks.length} 条，开始真跑……\n`);

const started = Date.now();
const v = await runAcceptanceChecks(
    path.resolve(projectDir),
    task.acceptanceChecks,
    acceptanceHashOf(task.acceptanceChecks),
);
const kind = verdictKindOf(v);
const seconds = ((Date.now() - started) / 1000).toFixed(1);

console.log(`\n================ 验收结果 ================`);
for (const r of v.results) {
    const mark = r.exitCode === 0 && !r.timedOut ? "✅" : "❌";
    console.log(`${mark} ${r.check.id}  ${r.command} ${r.args.join(" ").slice(0, 80)}  exit=${String(r.exitCode)} ${r.durationMs}ms`);
    if (r.exitCode !== 0 || r.timedOut) {
        console.log(`--- ${r.check.id} stdout 尾部 ---\n${r.stdout.slice(-1_500)}`);
        if (r.stderr.trim()) console.log(`--- ${r.check.id} stderr 尾部 ---\n${r.stderr.slice(-1_500)}`);
    }
}
if (v.skipped.length > 0) {
    console.log(`\n跳过的判据 ${v.skipped.length} 条：`);
    for (const s of v.skipped) console.log(`  ⏭ ${s.checkId}（${s.kind}）：${s.reason}`);
}

const passed = v.results.filter((r) => r.exitCode === 0 && !r.timedOut).length;
console.log(`\n结论：${kind}   通过 ${passed} / 执行 ${v.results.length} / 跳过 ${v.skipped.length}   耗时 ${seconds}s`);
process.exit(kind === "test_passed" ? 0 : 1);
