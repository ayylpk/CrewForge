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
//   续跑（9/16）：蓝图与每批**生成即落盘**，外加一份 _parts/checkpoint.json
//   （蓝图 + 已完成批次前缀）。不带 --reset 再跑一遍：档案在、且需求内容与身份
//   （projectId/taskId）都没变 → 跳过已完成批次，只从第一个缺失批次继续。
//   档案不可复用（需求改过 / 换过身份 / 文件损坏）→ 记一行原因后**当首次运行重拆**，
//   不会因为"上次留下过一份档案"把这次掐死；--reset 显式丢弃档案从头来。
//
//   任一阶段（蓝图或某一批）重试耗尽全拒 → 整次失败退出（与管线"第 i 项 3 次
//   全拒整次作废"同一语义；调试工具不做静默降级）。注意失败退出 ≠ 前功尽弃：
//   已完成的批次都在 checkpoint 里，重跑即从断点续，不重新烧那几发。
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
import {
    batchFileNameOf, createArchitectCheckpoint, deliveredCheckIdsOf, pendingCheckpointWork,
    rebuildArchitectCheckpointFromParts, restoreArchitectCheckpoint,
    saveArchitectCheckpoint, saveRequirementHash, type ArchitectCheckpoint,
} from "../architectCheckpoint";

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
    "用法: bun live/architect-cli.ts --file <需求文件.md> [--project-id p1] [--task-id t1] [--out task.json] [--reset]",
    "",
    "  --file         必填：需求原文文本文件（唯一业务输入）",
    "  --project-id   任务包 projectId，缺省 p1",
    "  --task-id      任务包 taskId，缺省 t1",
    "  --out          最终任务包输出路径（相对 cwd），缺省 architect-task.json；",
    "                 蓝图/批次中间产物写在 <out 所在目录>/_parts/",
    "  --checkpoint   续跑档案路径，缺省 <out 所在目录>/_parts/checkpoint.json",
    "  --reset        丢弃续跑档案，从蓝图重新拆；不带则跳过已完成批次续跑",
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
const checkpointPath = path.resolve(argOf("--checkpoint") ?? path.join(path.dirname(outPath), "_parts", "checkpoint.json"));
// --reset = 从头拆。只删档案不够：_parts 里的中间产物还在，重建能把旧蓝图接回来
const reset = argv.includes("--reset");
if (reset) {
    try { fs.rmSync(checkpointPath); } catch { /* 不存在=正常 */ }
}
// 中间产物目录（blueprint.json / batch-*.json / 需求指纹）：重建续跑档案时要从这里读，
// 所以提前建好——原来它在蓝图阶段之后才声明，重建就够不着了
const partsDir = path.join(path.dirname(outPath), "_parts");
fs.mkdirSync(partsDir, { recursive: true });

// ---------- 两阶段拆解 + 人读报告 ----------

try {
    // maxTokens 32768 / timeoutMs 900s：标定自一步整包时代（8192 实测被 max_tokens
    // 截断；p7 整包 480s 自掐）。两阶段把每次调用的输出体量都砍小了（蓝图省掉逐接口
    // 判据，批次只剩 detail+本项判据），但契约全量仍在蓝图一次里——沿用同一档，
    // 不为新链路重新踩一遍截断坑。
    // 9/16 p7 实弹：w4 单发 509s、w5 撞 900s 超时整次作废（中型项目批次输出可达 14k token）
    // ——用户指令全部超时 ×1.5：900s → 1350s。
    let seq = 0;
    const agent = createArchitectAgent({
        llm: createRealLlm({
            maxTokens: 32768, timeoutMs: 1_350_000,
            onCall: (i) => {
                seq++;
                const extra = i.attempts > 1 ? ` [${i.escalated ? "升档" : "重试"}×${i.attempts}]` : "";
                console.log(`[architect-llm#${seq}] ${i.latencyMs}ms in=${i.inputTokens} out=${i.outputTokens}${extra}`);
            },
        }),
    });

    console.log(`[architect-cli] 两阶段拆解开始：projectId=${projectId} taskId=${taskId}`);
    console.log(`[architect-cli] 需求文件：${requirementPath}（${requirement.length} 字符）`);

    // ---- 阶段 1：蓝图（全局一次冻结；档案 > _parts 重建 > 重拆）----
    let checkpoint: ArchitectCheckpoint;
    let blueprint: import("../protocol").ArchitectTask;
    let blueprintAttempts = 0;
    let blueprintRejections: string[] = [];
    const tBlueprint = Date.now();
    const warn = (reason: string): void => console.warn(`[architect-cli] ⚠️ ${reason}`);
    const restored = restoreArchitectCheckpoint(checkpointPath, requirement, projectId, taskId, warn);
    const resumed = restored
        ?? (reset ? null : rebuildArchitectCheckpointFromParts(partsDir, requirement, projectId, taskId, warn));
    if (resumed) {
        checkpoint = resumed;
        blueprint = checkpoint.blueprint;
        if (restored) {
            console.log(`[architect-cli] checkpoint 恢复：已完成 ${checkpoint.batches.length} 个批次，跳过蓝图重算`);
        } else {
            saveArchitectCheckpoint(checkpointPath, checkpoint);
            console.log(`[architect-cli] 从 _parts 重建档案：已完成 ${checkpoint.batches.length} 个批次，跳过蓝图重算`);
        }
    } else {
        const bp = await agent.decomposeBlueprint({ requirement, projectId, taskId });
        blueprint = bp.task;
        blueprintAttempts = bp.attempts;
        blueprintRejections = bp.rejections;
        checkpoint = createArchitectCheckpoint(requirement, blueprint);
    }
    const items = blueprint.foundationPlan.workItems ?? [];
    // 恢复来的蓝图没花本次的时间与尝试次数——照原样印"0 次 / 0.0s"会让人以为拆解秒过
    const bpNote = resumed
        ? "checkpoint 恢复，本次未重算"
        : `${((Date.now() - tBlueprint) / 1000).toFixed(1)}s，尝试 ${blueprintAttempts} 次`;
    console.log(`[architect-cli] 蓝图完成：工作项 ${items.length} 个，全局底线判据 ${blueprint.acceptanceChecks.length} 条（${bpNote}）`);
    for (const r of blueprintRejections) console.log(`  · 蓝图被拒：${r}`);

    // 中间产物即时落盘：崩了/重跑不重烧 LLM，也方便逐批人查
    fs.writeFileSync(path.join(partsDir, "blueprint.json"), JSON.stringify(blueprint, null, 2), "utf-8");
    saveRequirementHash(partsDir, requirement);
    saveArchitectCheckpoint(checkpointPath, checkpoint);

    // ---- 阶段 2：按蓝图顺序逐项细化（顺序即执行序，与管线推送序一致）----
    // delivered = 已交付判据 id 滚动清单（蓝图底线起步，每批追加）：撞车的批在生成侧就被拒。
    // 续跑时它必须逐字重建上次的清单——少一条，重复 id 就会静默溜过撞车闸。
    const delivered: string[] = deliveredCheckIdsOf(checkpoint);
    const batches: ArchitectBatch[] = [...checkpoint.batches];
    const pending = pendingCheckpointWork(checkpoint);
    console.log(`[architect-cli] 待拆工作项 ${pending.length} 个：${pending.map((w) => w.id).join(", ") || "(无，直接装配)"}`);
    const report: { id: string; kind: string; attempts: number; checks: number; secs: number; rejections: string[] }[] = [];
    for (const item of pending) {
        const t0 = Date.now();
        const b = await agent.decomposeBatch({ requirement, blueprint, item, deliveredCheckIds: delivered, projectId, taskId });
        batches.push(b.batch);
        delivered.push(...b.batch.checks.map((c) => c.id));
        report.push({
            id: item.id, kind: item.kind ?? "?", attempts: b.attempts,
            checks: b.batch.checks.length, secs: (Date.now() - t0) / 1000, rejections: b.rejections,
        });
        fs.writeFileSync(path.join(partsDir, batchFileNameOf(item.id)), JSON.stringify(b.batch, null, 2), "utf-8");
        checkpoint = createArchitectCheckpoint(requirement, blueprint, batches);
        saveArchitectCheckpoint(checkpointPath, checkpoint);
        console.log(`[architect-cli] 批次 ${item.id} 完成：判据 +${b.batch.checks.length}（尝试 ${b.attempts} 次）`);
    }

    // ---- 装配：确定性合并（不再碰 LLM），产物与 runner --task 完全同链路 ----
    const task = assembleTask(blueprint, batches);
    fs.writeFileSync(outPath, JSON.stringify(task, null, 2), "utf-8");

    console.log("\n===== 架构师拆解报告（蓝图→逐项批次） =====");
    console.log(`蓝图：尝试 ${blueprintAttempts} 次，底线判据 ${blueprint.acceptanceChecks.length} 条，工作项 ${items.length} 个`);

    console.log("\n工作项 | kind       | 尝试 | 判据 | 耗时");
    for (const row of report) {
        console.log(`  ${row.id.padEnd(4)} | ${String(row.kind).padEnd(9)} | ${String(row.attempts).padStart(2)}   | ${String(row.checks).padStart(2)}   | ${row.secs.toFixed(1)}s`);
        for (const r of row.rejections) console.log(`      ↳ 被拒：${r}`);
    }
    const totalAttempts = blueprintAttempts + report.reduce((n, r) => n + r.attempts, 0);
    console.log(`\n本次运行的 LLM 调用合计（含被拒重试；checkpoint 恢复的批次不计）：${totalAttempts}`);

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
