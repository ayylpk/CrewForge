// ============================================================
// live/architect-cli.ts —— 自包含架构师 Agent 的命令行试跑入口（两阶段：蓝图→逐项批次）
//
//   背景（9/15；当晚升级）：architectAgent.ts 把"需求原文 → ArchitectTask"自动化了，
//   本 CLI 给它一个可独立试跑的入口——不用起 runner/Hub，直接 `--file` 喂一份
//   需求 markdown。一步整包在 p7 中型项目上撞了输出体量墙（~22 接口整包 480s 自掐），
//   现在走两阶段：decomposeBlueprint 冻结全局 → 按蓝图顺序逐项 decomposeBatch
//   → assembleTask 装配出 runner --task 能直接吃的完整任务包（同链路证据在
//   assembleTask/各生成器内部的 parseInbound 终验里，不是"应该兼容"）。
//
//   用法：
//     bun live/architect-cli.ts --file <需求文件.md> [--project-id p1] [--task-id t1] [--out task.json]
//
//     · --file         必填：需求原文文本文件（唯一业务输入），缺了打印用法退出；
//     · --project-id   任务包身份，缺省 p1；
//     · --task-id      任务包身份，缺省 t1；
//     · --out          **最终装配包**输出路径（相对 cwd），缺省 architect-task.json。
//                      蓝图与逐批中间产物写在 <out 所在目录>/_parts/（blueprint.json、
//                      batch-<itemId>.json）——单项拆成了什么样，不重跑也能人查。
//
//   任一阶段（蓝图或某一批）重试耗尽全拒 → 整次失败退出（与管线"第 i 项 3 次
//   全拒整次作废"同一语义；调试工具不做静默降级）。
//
//   env：ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / DEVELOPER_LLM_MODEL
//   （与 runner 同源：loadDotEnv 以仓库 .env 为准，覆盖 shell 继承值）。
//   退出码：成功=0；用法/文件错误=2；拆解失败（LLM/校验全拒）=1。
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { loadDotEnv } from "../dotenv";
import { assembleTask, createArchitectAgent } from "../architectAgent";
import type { ArchitectBatch } from "../protocol";
import { createRealLlm } from "../realLlm";

// 以仓库 .env 为准（覆盖 shell 继承的 CC 环境变量），与 runner/probe 家族同一做法
loadDotEnv();

// ---------- 参数（照 runner.ts 的 argOf 模式） ----------

const argv = process.argv.slice(2);
function argOf(flag: string): string | null {
    const i = argv.indexOf(flag);
    if (i < 0) return null;
    const value = argv[i + 1];
    return value ?? null;
}

const USAGE = [
    "用法: bun live/architect-cli.ts --file <需求文件.md> [--project-id p1] [--task-id t1] [--out task.json]",
    "",
    "  --file         必填：需求原文文本文件（唯一业务输入）",
    "  --project-id   任务包 projectId，缺省 p1",
    "  --task-id      任务包 taskId，缺省 t1",
    "  --out          最终任务包输出路径（相对 cwd），缺省 architect-task.json；",
    "                 蓝图/批次中间产物写在 <out 所在目录>/_parts/",
].join("\n");

const reqFile = argOf("--file");
if (!reqFile) {
    console.error(USAGE);
    process.exit(2);
}
const requirementPath = path.resolve(reqFile);
if (!fs.existsSync(requirementPath)) {
    console.error(`需求文件不存在：${requirementPath}\n\n${USAGE}`);
    process.exit(2);
}
const requirement = fs.readFileSync(requirementPath, "utf-8").trim();
if (!requirement) {
    console.error(`需求文件是空的：${requirementPath}`);
    process.exit(2);
}

const projectId = argOf("--project-id") ?? "p1";
const taskId = argOf("--task-id") ?? "t1";
// --out 相对 cwd 解析；缺省 architect-task.json
const outPath = path.resolve(argOf("--out") ?? "architect-task.json");

// ---------- 两阶段拆解 + 人读报告 ----------

try {
    // maxTokens 32768 / timeoutMs 900s：标定自一步整包时代（8192 实测被 max_tokens
    // 截断；p7 整包 480s 自掐）。两阶段把每次调用的输出体量都砍小了（蓝图省掉逐接口
    // 判据，批次只剩 detail+本项判据），但契约全量仍在蓝图一次里——沿用同一档，
    // 不为新链路重新踩一遍截断坑。
    let seq = 0;
    const agent = createArchitectAgent({
        llm: createRealLlm({
            maxTokens: 32768, timeoutMs: 900_000,
            onCall: (i) => {
                seq++;
                const extra = i.attempts > 1 ? ` [${i.escalated ? "升档" : "重试"}×${i.attempts}]` : "";
                console.log(`[architect-llm#${seq}] ${i.latencyMs}ms in=${i.inputTokens} out=${i.outputTokens}${extra}`);
            },
        }),
    });

    console.log(`[architect-cli] 两阶段拆解开始：projectId=${projectId} taskId=${taskId}`);
    console.log(`[architect-cli] 需求文件：${requirementPath}（${requirement.length} 字符）`);

    // ---- 阶段 1：蓝图（全局一次冻结）----
    const tBlueprint = Date.now();
    const bp = await agent.decomposeBlueprint({ requirement, projectId, taskId });
    const blueprint = bp.task;
    const items = blueprint.foundationPlan.workItems ?? [];
    console.log(`[architect-cli] 蓝图完成：工作项 ${items.length} 个，全局底线判据 ${blueprint.acceptanceChecks.length} 条（${((Date.now() - tBlueprint) / 1000).toFixed(1)}s，尝试 ${bp.attempts} 次）`);
    for (const r of bp.rejections) console.log(`  · 蓝图被拒：${r}`);

    // 中间产物即时落盘：崩了/重跑不重烧 LLM，也方便逐批人查
    const partsDir = path.join(path.dirname(outPath), "_parts");
    fs.mkdirSync(partsDir, { recursive: true });
    fs.writeFileSync(path.join(partsDir, "blueprint.json"), JSON.stringify(blueprint, null, 2), "utf-8");

    // ---- 阶段 2：按蓝图顺序逐项细化（顺序即执行序，与管线推送序一致）----
    // delivered = 已交付判据 id 滚动清单（蓝图底线起步，每批追加）：撞车的批在生成侧就被拒
    const delivered: string[] = blueprint.acceptanceChecks.map((c) => c.id);
    const batches: ArchitectBatch[] = [];
    const report: { id: string; kind: string; attempts: number; checks: number; secs: number; rejections: string[] }[] = [];
    for (const item of items) {
        const t0 = Date.now();
        const b = await agent.decomposeBatch({ requirement, blueprint, item, deliveredCheckIds: delivered, projectId, taskId });
        batches.push(b.batch);
        delivered.push(...b.batch.checks.map((c) => c.id));
        report.push({
            id: item.id, kind: item.kind ?? "?", attempts: b.attempts,
            checks: b.batch.checks.length, secs: (Date.now() - t0) / 1000, rejections: b.rejections,
        });
        fs.writeFileSync(path.join(partsDir, `batch-${item.id}.json`), JSON.stringify(b.batch, null, 2), "utf-8");
        console.log(`[architect-cli] 批次 ${item.id} 完成：判据 +${b.batch.checks.length}（尝试 ${b.attempts} 次）`);
    }

    // ---- 装配：确定性合并（不再碰 LLM），产物与 runner --task 完全同链路 ----
    const task = assembleTask(blueprint, batches);
    fs.writeFileSync(outPath, JSON.stringify(task, null, 2), "utf-8");

    console.log("\n===== 架构师拆解报告（蓝图→逐项批次） =====");
    console.log(`蓝图：尝试 ${bp.attempts} 次，底线判据 ${blueprint.acceptanceChecks.length} 条，工作项 ${items.length} 个`);

    console.log("\n工作项 | kind       | 尝试 | 判据 | 耗时");
    for (const row of report) {
        console.log(`  ${row.id.padEnd(4)} | ${String(row.kind).padEnd(9)} | ${String(row.attempts).padStart(2)}   | ${String(row.checks).padStart(2)}   | ${row.secs.toFixed(1)}s`);
        for (const r of row.rejections) console.log(`      ↳ 被拒：${r}`);
    }
    const totalAttempts = bp.attempts + report.reduce((n, r) => n + r.attempts, 0);
    console.log(`\nLLM 调用合计（含被拒重试）：${totalAttempts}`);

    console.log(`\n验收判据：${task.acceptanceChecks.length} 条（底线 + 各批，重复 id 已按先到保留）`);
    console.log(`  ids: ${task.acceptanceChecks.map((c) => c.id).join(", ")}`);

    console.log(`\nallowedRoots: ${task.allowedRoots.length > 0 ? task.allowedRoots.join(", ") : "(空)"}`);
    console.log(`forbiddenPaths: ${task.forbiddenPaths.length > 0 ? task.forbiddenPaths.join(", ") : "(空)"}`);

    console.log(`\n[architect-cli] 任务包已写出：${outPath}`);
    console.log(`[architect-cli] 中间产物（蓝图/逐批）：${partsDir}`);
} catch (e) {
    // 蓝图/任一批次全拒 / env 缺失 / 网络失败都在这里收口：错误原文进 stderr，非零退出
    console.error(`[architect-cli] 拆解失败：${(e as Error).message}`);
    process.exit(1);
}
