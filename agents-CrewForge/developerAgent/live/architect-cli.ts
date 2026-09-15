// ============================================================
// live/architect-cli.ts —— 自包含架构师 Agent 的命令行单测入口
//
//   背景（9/15）：architectAgent.ts 把"需求原文 → ArchitectTask"自动化了，
//   本 CLI 给它一个可独立试跑的入口——不用起 runner/Hub，直接
//   `--file` 喂一份需求 markdown，产物就是 runner --task 能直接吃的任务包。
//
//   用法：
//     bun live/architect-cli.ts --file <需求文件.md> [--project-id p1] [--task-id t1] [--out task.json]
//
//     · --file         必填：需求原文文本文件（唯一业务输入），缺了打印用法退出；
//     · --project-id   任务包身份，缺省 p1；
//     · --task-id      任务包身份，缺省 t1；
//     · --out          任务包输出路径（相对 cwd），缺省 architect-task.json。
//
//   env：ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / DEVELOPER_LLM_MODEL
//   （与 runner 同源：loadDotEnv 以仓库 .env 为准，覆盖 shell 继承值）。
//   退出码：成功=0；用法/文件错误=2；拆解失败（LLM/校验全拒）=1。
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { loadDotEnv } from "../dotenv";
import { createArchitectAgent } from "../architectAgent";
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
    "  --out          任务包输出路径（相对 cwd），缺省 architect-task.json",
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

// ---------- 拆解 + 人读报告 ----------

try {
    // maxTokens 抬到 32768：架构师一次吐**整包**（contract+workItems+验收全字段），
    // 输出量远大于 Developer 的单步决策——8192 实测被 max_tokens 截断（stop=max_tokens
    // → 文本为空 → extractJson 抠不到 → 三次全拒）。截断的决策不可信，只能从源头抬。
    // timeoutMs 抬到 900s：整包输出实测 ~85s/次（5.5K token，小项目 p0）；
    // p7 中型项目（~22 接口/七表）首跑在 480s 处被自己的 AbortSignal 掐断
    // （错文"The operation timed out"=Bun 对 AbortSignal.timeout 的措辞，不是网关拒）——
    // 输出体量大几倍，按 token 生成时间线性外推留 2 倍余量。
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

    console.log(`[architect-cli] 拆解开始：projectId=${projectId} taskId=${taskId}`);
    console.log(`[architect-cli] 需求文件：${requirementPath}（${requirement.length} 字符）`);

    const result = await agent.decompose({ requirement, projectId, taskId });
    const task = result.task;

    // 产物与 runner --task 完全同链路（decompose 内部已过 parseInbound 终验）
    fs.writeFileSync(outPath, JSON.stringify(task, null, 2), "utf-8");

    console.log("\n===== 架构师拆解报告 =====");
    console.log(`尝试次数：${result.attempts}`);
    if (result.rejections.length > 0) {
        console.log(`被拒原因（${result.rejections.length} 次，成功前）：`);
        for (const r of result.rejections) console.log(`  - ${r}`);
    } else {
        console.log("被拒原因：无（一次通过）");
    }

    const items = task.foundationPlan.workItems ?? [];
    console.log(`\n工作项（${items.length}）：`);
    for (const w of items) console.log(`  - ${w.id} / ${w.kind} / ${w.title ?? "(无标题)"}`);

    console.log(`\n验收判据：${task.acceptanceChecks.length} 条`);
    console.log(`  ids: ${task.acceptanceChecks.map((c) => c.id).join(", ")}`);

    console.log(`\nallowedRoots: ${task.allowedRoots.length > 0 ? task.allowedRoots.join(", ") : "(空)"}`);
    console.log(`forbiddenPaths: ${task.forbiddenPaths.length > 0 ? task.forbiddenPaths.join(", ") : "(空)"}`);

    console.log(`\n[architect-cli] 任务包已写出：${outPath}`);
} catch (e) {
    // decompose 全拒 / env 缺失 / 网络失败都在这里收口：错误原文进 stderr，非零退出
    console.error(`[architect-cli] 拆解失败：${(e as Error).message}`);
    process.exit(1);
}
