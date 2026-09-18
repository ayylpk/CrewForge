// ============================================================
// live/runner.ts —— 「模拟架构师 + 兼任 TestAgent」的单任务实弹驱动
//
//   背景（9/12）：CrewForge 旧流水线的架构师正确率拉胯，本 runner 不走
//   GraphFactory/旧 Hub 注册——**人+Claude 手写 architect_task 任务包**，
//   直推 developerAgent；developerAgent 发 test_request 后，由本 runner
//   真跑验收命令、按 protocol 的信任链回推 test_passed / test_failure。
//
//   消息环（与 index.ts 的公开接口对齐）：
//     run(task) ── waiting_test ─→ 读 ledger.getTestWait()
//        ↑                              │ 真跑 acceptanceChecks（verifier.ts）
//        │  ready/blocked/failed        ▼
//     resumeFromTestMessage(test_passed | test_failure)
//
//   ── 执行模式（2026-09-13 定稿）──
//     --sandbox soft    → { mode:"soft", backend:"local" }：**本机执行**，受约束但**不是隔离**
//     --sandbox strict  → 默认严格模式：没有真实隔离后端就返回 SANDBOX_UNAVAILABLE
//     不传              → strict（**绝不**默认放开宿主机命令）
//
//   ⚠️ soft 模式的真实边界（也说给读报告的人听）：
//     · 子进程仍然拥有宿主机用户权限；
//     · cwd 限制不是安全隔离，子进程理论上能读项目外文件；
//     · 项目外写入只能检测 + 轮询打断，不能绝对阻止；
//     · 网络访问无法强制隔离；
//     · Windows 进程树终止用 taskkill，属于 best-effort；
//     · 仅用于本机开发与真实 LLM 冒烟，**不得**用于生产运行不受信生成代码。
//
//   用法（两种输入，二选一）：
//     ① 手写任务包（历史形态）：
//       bun run developerAgent/live/runner.ts \
//         --task developerAgent/live/mysite/T1-foundation.json \
//         --project F:\code\project\CrewForge\.runs\developer-local\live-1 \
//         --sandbox soft --reset
//     ② ★ 需求原文（9/15 接线：架构师进 runner）：
//       bun run developerAgent/live/runner.ts \
//         --requirement developerAgent/live/p7-requirement.md \
//         --project F:\code\project\CrewForge\.runs\developer-local\p7 \
//         --run-id p7 --sandbox soft --reset
//       runner 先调架构师 Agent 现场拆解（需求→ArchitectTask，含校验/重试反馈环），
//       拆出的包落盘到 .runs/developer-local/_tasks/<runId>.json（审计+可复跑凭据），
//       然后走与 ① 完全相同的执行链——PM 只给需求，不再手写 JSON。
//     可选：--run-id <id>（默认取 --project 的末级目录名，或 live-1）
//           --project-id/--task-id（仅 --requirement 模式；缺省 runId/t1）
//   退出码：ready=0；blocked/failed/rejected=1。
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { createDeveloperAgent } from "../index";
import { createRealLlm } from "../realLlm";
import type { SummaryRequest } from "../contextBudget";
import { assembleTask, createArchitectAgent } from "../architectAgent";
import {
    batchFileNameOf, createArchitectCheckpoint, deliveredCheckIdsOf, pendingCheckpointWork,
    rebuildArchitectCheckpointFromParts, restoreArchitectCheckpoint,
    saveArchitectCheckpoint, saveRequirementHash,
} from "../architectCheckpoint";
import type { ArchitectCheckpoint } from "../architectCheckpoint";
// 9/15 实弹补：runner 此前没加载仓库 .env，shell 里若继承着别的 ANTHROPIC_* 值
// （如 Claude Code 自己的中转站），createRealLlm 的 env 兜底会拿到错误端点——
// 实测 404 Model "qwen3.8-flash" is not supported。以仓库 .env 为准（CLI 同款做法）。
import { loadDotEnv } from "../dotenv";
import { parseInbound } from "../protocol";
import type { ArchitectTask, TestFailure, TestPassed } from "../protocol";
import type { DeveloperState } from "../state";
import { hashOf } from "../ledger";
import type { SandboxConfig } from "../tools/processSandbox";
import { categoryOf, failureSignatureOf, runAcceptanceChecks, verdictKindOf } from "./verifier";

// ---------- 参数 ----------

const argv = process.argv.slice(2);
function argOf(flag: string): string | null {
    const i = argv.indexOf(flag);
    if (i < 0) return null;
    const value = argv[i + 1];
    return value ?? null;
}

const USAGE = [
    "用法（--task 与 --requirement 二选一）:",
    "  bun run developerAgent/live/runner.ts --task <architect_task.json> [--project <dir>] [--sandbox soft|strict] [--run-id <id>] [--reset]",
    "  bun run developerAgent/live/runner.ts --requirement <需求.md> [--project <dir>] [--sandbox soft|strict] [--run-id <id>] [--project-id <id>] [--task-id <id>] [--reset]",
    "",
    "  --task         手写任务包：直接执行（历史形态）",
    "  --requirement  需求原文：先由架构师 Agent 现场拆解成任务包，再走同一执行链",
    "  --sandbox soft    本机受约束执行（realIsolation=false，仅开发/冒烟）",
    "  --sandbox strict  默认：没有真实隔离后端就不执行命令（blocked）",
    "  --max-wall-minutes <n>  墙钟硬闸：超过 n 分钟强制收手（默认关闭；B1）",
].join("\n");

const taskFile = argOf("--task");
const requirementFile = argOf("--requirement");
if (!taskFile && !requirementFile) {
    console.error(USAGE);
    process.exit(2);
}
if (taskFile && requirementFile) {
    console.error(`--task 与 --requirement 只能给一个（两个都给=输入源不明确）\n\n${USAGE}`);
    process.exit(2);
}
let requirementPath: string | null = null;
if (requirementFile) {
    requirementPath = path.resolve(requirementFile);
    if (!fs.existsSync(requirementPath)) {
        console.error(`需求文件不存在：${requirementPath}\n\n${USAGE}`);
        process.exit(2);
    }
}
let taskFilePath = taskFile ? path.resolve(taskFile) : "";
loadDotEnv();   // 进点第一件事：以仓库 .env 为准（覆盖 shell 继承的 ANTHROPIC_*）

const AGENT_DIR = import.meta.dir.replace(/[/\\]live$/, "");          // developerAgent/
// ⚠️ 9/18 目录重构：引擎从 <仓库>/agents-CrewForge 移到 <仓库>/agent/engine（深了一层）。
//    这两个"往上找"必须各多退一级 —— 少退一级时 REPO_ROOT 会指到 <仓库>/agent，
//    而下面的路径闸门正是拿它当"控制平面"边界：指错了等于把仓库的其余部分划进禁区/或漏出禁区。
const REPO_ROOT = path.resolve(AGENT_DIR, "..", "..");                // agent/engine/
const CREWFORGE_ROOT = path.resolve(REPO_ROOT, "..", "..");           // 仓库根
const RUNS_ROOT = path.join(CREWFORGE_ROOT, "agent", ".runs", "developer-local");

// ---------- 沙箱模式（不传就是 strict，绝不默认放开宿主命令） ----------

const rawSandboxArg = argOf("--sandbox");
if (rawSandboxArg !== null && rawSandboxArg !== "soft" && rawSandboxArg !== "strict") {
    console.error(`--sandbox 只支持 soft | strict，收到：${rawSandboxArg}\n\n${USAGE}`);
    process.exit(2);
}
const SANDBOX_MODE: "soft" | "strict" = rawSandboxArg === "soft" ? "soft" : "strict";
const sandboxConfig: Partial<SandboxConfig> = SANDBOX_MODE === "soft"
    ? { mode: "soft", backend: "local" }      // 本机执行：受约束，不是隔离
    : { mode: "strict", backend: "none" };    // 没有真实后端 → SANDBOX_UNAVAILABLE

// ---------- 项目目录：必须是独立目录，禁止直接跑在仓库根 ----------

const explicitProject = argOf("--project");
const runId = argOf("--run-id") ?? (explicitProject ? path.basename(path.resolve(explicitProject)) : "live-1");
const projectDir = path.resolve(explicitProject ?? path.join(RUNS_ROOT, runId));

function within(parent: string, child: string): boolean {
    const rel = path.relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** 拒绝把真实任务跑在会污染仓库/控制平面的位置 */
function assertIsolatedProjectDir(dir: string): void {
    const problems: string[] = [];
    if (dir === CREWFORGE_ROOT) problems.push("不能直接使用 CrewForge 仓库根目录");
    if (within(REPO_ROOT, dir)) problems.push("不能落在 CrewForge 控制平面（agents-CrewForge/）内");
    if (within(dir, REPO_ROOT)) problems.push("不能使用 CrewForge 仓库的祖先目录");
    if (dir === path.parse(dir).root) problems.push("不能使用盘符根目录");
    if (problems.length > 0) {
        console.error(`[runner] 项目目录不合格：${dir}\n  - ${problems.join("\n  - ")}`);
        console.error(`[runner] 请使用独立目录，例如：${path.join(RUNS_ROOT, runId)}`);
        process.exit(2);
    }
    if (!within(RUNS_ROOT, dir)) {
        console.warn(`[runner] ⚠️ 项目目录不在推荐根目录内（${RUNS_ROOT}），请确认这是有意的：${dir}`);
    }
}
assertIsolatedProjectDir(projectDir);

// ---------- 任务包（两种输入源二选一，参数段已校验） ----------
//
//   ① --task：手写任务包 JSON——先过 protocol 校验，架构师手不抖也不行；
//   ② --requirement：需求原文——先由架构师 Agent 现场拆解（五道校验链 +
//      被拒反馈环 + 重试都在 architectAgent 内完成，产物已过 parseInbound），
//      包落盘到 _tasks/ 留审计与复跑凭据，再走与 ① 完全相同的执行链。
//      ★ 9/15 接线：PM 的输入只剩需求原文，机器字段全部由架构师产生。

function loadTaskFromFile(filePath: string): ArchitectTask {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const parsed = parseInbound(raw);
    if (!parsed.ok || parsed.message.type !== "architect_task") {
        console.error(`任务包不合法：${(parsed as { error?: string }).error ?? "不是 architect_task"}`);
        process.exit(2);
    }
    return parsed.message as ArchitectTask;
}

/**
 * 需求原文 → 架构师拆解 → 任务包（落盘留证）。
 * LLM 配置与 architect-cli 一致：maxTokens 32768、timeoutMs 1350s（9/16 按用户指令
 * 从 900s ×1.5——p7 实弹 w4 单发 509s、w5 撞 900s 直接作废整次）。
 * 蓝图与每批**生成即落盘**，外加一份 checkpoint：拆解中途断掉可续跑，不从头重烧。
 * 这里**不依赖惰性 llm**——要拆解就必须有凭据，拿不到就是 fail fast，不静默降级。
 */
async function decomposeRequirement(reqPath: string): Promise<{ task: ArchitectTask; outFile: string }> {
    const requirement = fs.readFileSync(reqPath, "utf-8").trim();
    if (!requirement) {
        console.error(`需求文件是空的：${reqPath}`);
        process.exit(2);
    }
    const projectId = argOf("--project-id") ?? runId;
    const taskId = argOf("--task-id") ?? "t1";

    console.log("======== 架构师拆解（需求原文 → 任务包） ========");
    console.log(`[architect] 需求文件：${reqPath}（${requirement.length} 字符）`);
    console.log(`[architect] 身份：projectId=${projectId} taskId=${taskId}`);

    let architectLlm: ReturnType<typeof createRealLlm>;
    try {
        let seq = 0;
        architectLlm = createRealLlm({
            maxTokens: 32768,
            timeoutMs: 1_350_000, // 9/16 用户指令 ×1.5（与 architect-cli 同源同值）
            onCall: (i) => {
                seq++;
                const extra = i.attempts > 1 ? ` [${i.escalated ? "升档" : "重试"}×${i.attempts}]` : "";
                console.log(`[architect-llm#${seq}] ${i.latencyMs}ms in=${i.inputTokens} out=${i.outputTokens}${extra}`);
            },
        });
    } catch (e) {
        console.error(`[architect] LLM 凭据不可用（--requirement 模式必须有可用 LLM）：${(e as Error).message}`);
        process.exit(2);
    }

    const outFile = path.join(RUNS_ROOT, "_tasks", `${runId}.json`);
    const checkpointFile = path.join(RUNS_ROOT, "_tasks", `${runId}.checkpoint.json`);
    const partsDir = path.join(RUNS_ROOT, "_tasks", `${runId}-parts`);
    fs.mkdirSync(partsDir, { recursive: true });
    // --reset = 从头拆。只删档案不够：_parts 里的中间产物还在，重建能把旧蓝图接回来
    const reset = argv.includes("--reset");
    if (reset) {
        try { fs.rmSync(checkpointFile); } catch { /* 不存在=正常 */ }
    }
    const t0 = Date.now();
    try {
        const agent = createArchitectAgent({ llm: architectLlm });
        // 续跑优先级：档案 > 用 _parts 中间产物重建 > 从蓝图重拆。
        //   · 档案权威（自带需求指纹）；_parts 重建兜"档案功能上线前的历史运行"——
        //     那种运行中间产物齐全却没有档案，按"只认档案"会被判成从没拆过、整份白烧；
        //   · 两者都没有才是真首次运行。
        const warn = (reason: string): void => console.warn(`[architect] ⚠️ ${reason}`);
        let checkpoint: ArchitectCheckpoint;
        const restored = restoreArchitectCheckpoint(checkpointFile, requirement, projectId, taskId, warn);
        const resumed = restored
            ?? (reset ? null : rebuildArchitectCheckpointFromParts(partsDir, requirement, projectId, taskId, warn));
        if (resumed) {
            checkpoint = resumed;
            if (restored) {
                console.log(`[architect] checkpoint 恢复：已完成 ${checkpoint.batches.length} 个批次，跳过已完成工作`);
            } else {
                // 重建出来的档案立刻落盘：下次运行走权威档案，不再依赖 _parts 兜底
                saveArchitectCheckpoint(checkpointFile, checkpoint);
                console.log(`[architect] 从 _parts 重建档案：已完成 ${checkpoint.batches.length} 个批次，不重烧`);
            }
        } else {
            const bp = await agent.decomposeBlueprint({ requirement, projectId, taskId });
            checkpoint = createArchitectCheckpoint(requirement, bp.task);
            fs.writeFileSync(path.join(partsDir, "blueprint.json"), JSON.stringify(bp.task, null, 2), "utf8");
            saveRequirementHash(partsDir, requirement);
            saveArchitectCheckpoint(checkpointFile, checkpoint);
        }
        // delivered 必须逐字重建上次的判据清单（少一条就漏放重复 id），pending 即本次要拆的切片
        const delivered = deliveredCheckIdsOf(checkpoint);
        const pending = pendingCheckpointWork(checkpoint);
        console.log(`[architect] 待拆工作项 ${pending.length} 个：${pending.map((w) => w.id).join(", ") || "(无，直接装配)"}`);
        for (const item of pending) {
            const b = await agent.decomposeBatch({ requirement, blueprint: checkpoint.blueprint, item, deliveredCheckIds: delivered, projectId, taskId });
            checkpoint = createArchitectCheckpoint(requirement, checkpoint.blueprint, [...checkpoint.batches, b.batch]);
            delivered.push(...b.batch.checks.map((c) => c.id));
            fs.writeFileSync(path.join(partsDir, batchFileNameOf(item.id)), JSON.stringify(b.batch, null, 2), "utf8");
            saveArchitectCheckpoint(checkpointFile, checkpoint);
            console.log(`[architect] 批次 ${item.id} 完成：判据 +${b.batch.checks.length}`);
        }
        const task = assembleTask(checkpoint.blueprint, checkpoint.batches);
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.writeFileSync(outFile, JSON.stringify(task, null, 2), "utf8");
        console.log(`[architect] ✅ 两阶段拆解完成：${((Date.now() - t0) / 1000).toFixed(1)}s`);
        return { task, outFile };
    } catch (e) {
        // 拆解全败（格式/校验/网络）：原文进 stderr，任务不发车——归因在架构师，不在开发
        console.error(`[architect] 拆解失败（任务不发车）：${(e as Error).message}`);
        process.exit(2);
    }
    throw new Error("unreachable");
}

let task: ArchitectTask;
if (requirementPath) {
    const r = await decomposeRequirement(requirementPath);
    task = r.task;
    taskFilePath = r.outFile;
} else {
    task = loadTaskFromFile(taskFilePath);
}

// ---------- TestAgent 身份（代码配置，不来自消息内容） ----------

const TEST_AGENT_NAME = "mysite-testagent";
/** 等待-回测的最大轮数：修复预算（maxRepairAttempts）在图内还有自己一道闸 */
const MAX_TEST_ROUNDS = 8;

// ---------- 路径与文件布局 ----------

const ledgerPath = path.join(RUNS_ROOT, "_ledger", `${runId}.db`);
const reportDir = path.join(RUNS_ROOT, "_reports");
const startedAt = Date.now();

if (argv.includes("--reset")) {
    for (const suffix of ["", "-wal", "-shm"]) {
        try { fs.rmSync(ledgerPath + suffix); } catch { /* 不存在=正常 */ }
    }
    console.log(`[runner] --reset：已删除 Ledger ${path.basename(ledgerPath)}`);
}
fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
fs.mkdirSync(projectDir, { recursive: true });
fs.mkdirSync(reportDir, { recursive: true });

// ---------- 装配 ----------

let llmSeq = 0;

/**
 * 惰性真实 LLM：**只有真的要调模型时才校验凭据**。
 * 这样 `--sandbox strict` 的"缺隔离后端 → blocked"路径不依赖 API Key 是否配好，
 * 谁都能复现"默认不执行本机命令"这件事（也不会因为没配 key 就看不到沙箱横幅）。
 */
let realLlm: ReturnType<typeof createRealLlm> | null = null;
/** 惰性建真实客户端（抽成一处：压缩摘要口必须拿到**同一个**客户端，见下面的 summarize） */
const ensureRealLlm = (): ReturnType<typeof createRealLlm> => (realLlm ??= createRealLlm({
    onCall: (i) => {
        llmSeq++;
        // 9/15 批 C：attempts>1 时标注是重试还是升档，并附缓存命中——
        // 否则 r5 复盘时"这一步为什么贵"没有线索（in/out 只是合计）。
        const extra = i.attempts > 1 ? ` [${i.escalated ? "升档" : "重试"}×${i.attempts}]` : "";
        const cache = i.cacheReadTokens > 0 ? ` cache=${i.cacheReadTokens}` : "";
        console.log(`[llm#${llmSeq}] ${i.latencyMs}ms in=${i.inputTokens} out=${i.outputTokens}${cache}${extra} → ${i.rawText.slice(0, 160).replace(/\s+/g, " ")}`);
    },
}));
const lazyLlm = {
    id: "real-lazy",
    calls: () => realLlm?.calls() ?? 0,
    next: async (input: Parameters<ReturnType<typeof createRealLlm>["next"]>[0]) =>
        ensureRealLlm().next(input),
    // ★ 9/17 压缩摘要口：与 next 同一个客户端。没有这一口时引擎越过阻塞线只会去问人，
    //   **不会**有任何自动压缩——所以真实运行必须给（见 graph 的 DeveloperLlm.summarize）。
    summarize: async (request: SummaryRequest) => ensureRealLlm().summarize!(request),
};

// 可选：加大单轮工具循环的步数上限（9/13 实弹：铺文件型任务 12 步会在
// 工作完成前撞进本地预检门禁）。不传 = 引擎默认（12），不改变任何默认语义。
const rawMaxSteps = argOf("--max-steps");
const maxStepsPerLoop = rawMaxSteps !== null && Number.isInteger(Number(rawMaxSteps)) && Number(rawMaxSteps) > 0
    ? Number(rawMaxSteps) : undefined;

// 预算随任务包走（9/15 实弹教训）：p0-r2 五工作项整包撞死在缺省 40 上（w1 做完、
// w2 开工即耗尽）。缺省改为**从任务包规模推导**：每工作项 25 次（单工作项任务
// 实测 12~21 调）+ 整站预检/修复余量 20，向上取整到 5 的倍数——架构师拆多少活，
// 预算就按体量给，不再靠一个写死的 40 猜。显式 --max-llm-calls 仍最高优先。
// 这道闸的角色是保险丝：正常干活碰不到（P1 88 步失控那次的教训是"闸不能没有"，
// 不是"闸要扣死"），只在真异常时刹车。
const rawMaxLlmCalls = argOf("--max-llm-calls");
const derivedMaxLlmCalls = Math.ceil(
    (((task.foundationPlan.workItems?.length ?? 1) * 25) + 20) / 5,
) * 5;
const maxLlmCalls = rawMaxLlmCalls !== null && Number.isInteger(Number(rawMaxLlmCalls)) && Number(rawMaxLlmCalls) > 0
    ? Number(rawMaxLlmCalls) : derivedMaxLlmCalls;

const handle = createDeveloperAgent({
    projectId: task.projectId,
    taskId: task.taskId,
    projectDir,
    // 入口授权 = 任务声明；receiveTask 会取交集，任务包想扩权也扩不动
    allowedRoots: task.allowedRoots,
    ledgerPath,
    runId,
    trustedTestAgents: [TEST_AGENT_NAME],
    // 真网络环境：连续 2 次 LLM 失败当一步失败消化，第 3 次连续失败才让任务死
    llmErrorTolerance: 2,
    // ★ 执行模式：soft = 本机受约束执行（不是隔离）；strict = 没有后端就不跑命令
    sandbox: sandboxConfig,
    // 预算随任务包走（显式 --max-llm-calls 可覆盖，见上面的推导）
    maxLlmCalls,
    ...(maxStepsPerLoop !== undefined ? { maxStepsPerLoop } : {}),
    llm: lazyLlm,
});

const caps = handle.sandboxCapabilities();

// ---------- 崩溃/中断也要清理遗留进程（规格三.5） ----------

let shuttingDown = false;
async function emergencyCleanup(signal: string, exitCode: number): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
        const killed = await handle.workspace.cleanupAllProcesses();
        console.error(`\n[runner] 收到 ${signal}：已清理 ${killed} 个遗留进程`);
    } catch (e) {
        console.error(`\n[runner] 收到 ${signal}：清理进程失败 ${(e as Error).message}`);
    }
    try { handle.ledger.appendEvent("runner_signal_cleanup", { signal, at: Date.now() }); } catch { /* 账本可能已关 */ }
    try { handle.ledger.close(); } catch { /* 已关 */ }
    process.exit(exitCode);
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    try {
        process.on(signal, () => { void emergencyCleanup(signal, 130); });
    } catch { /* 平台不支持该信号：忽略 */ }
}

// ---------- 启动横幅：把隔离程度写在最显眼的地方 ----------

console.log("================ CrewForge Developer 实弹运行 ================");
console.log(`[runner] project=${task.projectId} task=${task.taskId} runId=${runId}`);
console.log(`[runner] 预算 maxLlmCalls=${maxLlmCalls}` + (rawMaxLlmCalls !== null ? "（显式指定）" : "（按任务包规模推导）"));
console.log(`[runner] taskFile=${taskFilePath}`);
console.log(`[runner] projectDir=${projectDir}`);
console.log(`[runner] ledger=${ledgerPath}`);
console.log("[sandbox] --------------------------------");
console.log(`[sandbox] mode          = ${caps.mode}`);
console.log(`[sandbox] backend       = ${caps.backend}`);
console.log(`[sandbox] realIsolation = ${caps.realIsolation}`);
console.log(`[sandbox] softIsolation = ${caps.softIsolation}`);
console.log(`[sandbox] reasons       = ${caps.reasons.join("；")}`);
if (caps.boundaries.length > 0) {
    console.log("[sandbox] boundaries:");
    for (const b of caps.boundaries) console.log(`  - ${b}`);
}
console.log("[sandbox] limitations:");
for (const l of caps.limitations) console.log(`  - ${l}`);
if (!caps.realIsolation && !caps.softIsolation) {
    console.log("[sandbox] ⛔ 没有任何隔离边界 → 命令不会被本机执行，任务将直接 blocked（SANDBOX_UNAVAILABLE）");
} else if (caps.softIsolation) {
    console.log("[sandbox] ⚠️ 本模式**不是安全隔离**：子进程持有宿主机用户权限，可读项目外文件；");
    console.log("[sandbox] ⚠️ 项目外写入只能检测+轮询打断；网络无法强制隔离；进程树终止 best-effort。");
    console.log("[sandbox] ⚠️ 仅用于本机开发与真实 LLM 冒烟，禁止用于生产运行不受信生成代码。");
}
console.log("=============================================================");

// ---------- 运行报告（soft 模式的限制必须落在报告里） ----------

interface RunReport {
    runId: string;
    projectId: string;
    taskId: string;
    taskFile: string;
    projectDir: string;
    ledgerPath: string;
    sandbox: {
        mode: string;
        backend: string;
        realIsolation: boolean;
        softIsolation: boolean;
        reasons: string[];
        boundaries: string[];
        limitations: string[];
        networkPolicy: { allowHosts: string[]; allowExternal: boolean };
        timeouts: Record<string, number>;
    };
    declaration: string;
    result: {
        status: string;
        testRounds: number;
        llmCallsCompleted: number;
        llmCallsPlanned: number;
        toolCalls: number;
        repairs: number;
        changedFiles: string[];
        error: string | null;
        checkpoint: string;
        activeProcesses: number;
        durationMs: number;
    };
    violations: { code: string; target: string; message: string }[];
    processes: { kind: string; processId: string | null; pid: number | null; command: string; args: string[] }[];
    startedAt: number;
    finishedAt: number;
}

function writeReport(state: DeveloperState, rounds: number, snap: ReturnType<typeof handle.inspectTaskState>): string {
    const report: RunReport = {
        runId, projectId: task.projectId, taskId: task.taskId,
        taskFile: taskFilePath,
        projectDir, ledgerPath,
        sandbox: {
            mode: caps.mode, backend: caps.backend,
            realIsolation: caps.realIsolation, softIsolation: caps.softIsolation,
            reasons: caps.reasons, boundaries: caps.boundaries, limitations: caps.limitations,
            networkPolicy: caps.networkPolicy,
            timeouts: caps.timeouts as unknown as Record<string, number>,
        },
        declaration: caps.realIsolation
            ? "本次运行使用真实隔离后端。"
            : caps.softIsolation
                ? "⚠️ 本次运行使用本机 soft 模式：realIsolation=false，softIsolation=true，backend=local。"
                  + "这是「受约束的本机执行」，**不是安全隔离**；禁止用于生产运行不受信生成代码。"
                : "⛔ 本次运行没有任何隔离边界，命令未在本机执行（SANDBOX_UNAVAILABLE）。",
        result: {
            status: state.status,
            testRounds: rounds,
            llmCallsCompleted: state.llmCallsCompleted,
            llmCallsPlanned: state.llmCallsPlanned,
            toolCalls: state.toolCalls,
            repairs: state.repairAttempts,
            changedFiles: state.changedFiles,
            error: state.error,
            checkpoint: snap.lastCheckpoint ? `${snap.lastCheckpoint.node}/${snap.lastCheckpoint.phase}` : "-",
            activeProcesses: snap.activeProcesses,
            durationMs: Date.now() - startedAt,
        },
        violations: handle.ledger.listViolations().map((v) => ({ code: v.code, target: v.target, message: v.message })),
        processes: handle.ledger.listProcessEvents().map((p) => ({
            kind: p.kind, processId: p.processId, pid: p.pid, command: p.command, args: p.args,
        })),
        startedAt, finishedAt: Date.now(),
    };
    const jsonPath = path.join(reportDir, `${runId}-${new Date(startedAt).toISOString().replace(/[:.]/g, "-")}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf-8");
    const mdLines = [
        `# Developer 实弹运行报告（${runId}）`,
        "",
        `- task：\`${task.projectId}/${task.taskId}\``,
        `- 项目目录：\`${projectDir}\``,
        `- 状态：**${state.status}**（测试轮数 ${rounds}，修复 ${state.repairAttempts}，LLM ${state.llmCallsCompleted}/${state.llmCallsPlanned}，工具 ${state.toolCalls}）`,
        `- 改动文件：${state.changedFiles.length} 个`,
        ...(state.error ? [`- error：${state.error}`] : []),
        "",
        "## 隔离程度（这一节不许省略）",
        "",
        `- sandbox mode = \`${caps.mode}\``,
        `- sandbox backend = \`${caps.backend}\``,
        `- **realIsolation = ${caps.realIsolation}**`,
        `- **softIsolation = ${caps.softIsolation}**`,
        "",
        report.declaration,
        "",
        "### 边界",
        ...(caps.boundaries.length > 0 ? caps.boundaries.map((b) => `- ${b}`) : ["- （无）"]),
        "",
        "### 限制",
        ...caps.limitations.map((l) => `- ${l}`),
        "",
        `### 违规记录（${report.violations.length}）`,
        ...(report.violations.length > 0 ? report.violations.map((v) => `- [${v.code}] ${v.message}`) : ["- 无"]),
        "",
        `### 进程事件（${report.processes.length}）`,
        ...(report.processes.length > 0
            ? report.processes.map((p) => `- ${p.kind} pid=${p.pid ?? "-"} ${p.command} ${p.args.join(" ")}`)
            : ["- 无"]),
        "",
    ];
    fs.writeFileSync(jsonPath.replace(/\.json$/, ".md"), mdLines.join("\n"), "utf-8");
    return jsonPath;
}

// ---------- B1：墙钟硬闸（可选，pi AbortSignal 同族）----------
//
//   迭代闸（MAX_TEST_ROUNDS / maxStepsPerLoop）与预算闸（maxLlmCalls）之外再加一道**墙钟**：
//   单次 LLM 调用可能很慢（p7 实弹单发 509s），纯计数闸下"少数几次超长调用"仍能把整次运行拖很久。
//   到点直接 emergencyCleanup（清进程 + 关账本 + 退出码 1），不靠提示词自觉。
//   默认**关闭**（不传 --max-wall-minutes 即零行为变化）；给了正数才启用。
const rawWallMinutes = argOf("--max-wall-minutes");
const wallMinutes = rawWallMinutes !== null && Number.isFinite(Number(rawWallMinutes)) && Number(rawWallMinutes) > 0
    ? Number(rawWallMinutes) : 0;
const wallTimer = wallMinutes > 0
    ? setTimeout(() => {
        console.error(`\n[runner] ⏱ 墙钟到点（${wallMinutes} 分钟）——强制收手（B1 硬闸）`);
        void emergencyCleanup("wall-clock", 1);
    }, wallMinutes * 60_000)
    : null;
if (wallMinutes > 0) console.log(`[runner] 墙钟上限 ${wallMinutes} 分钟（超出即强制收手）`);

// ---------- 消息环主循环 ----------

let state = await handle.run({ task });
let rounds = 0;

while (state.status === "waiting_test") {
    if (++rounds > MAX_TEST_ROUNDS) {
        console.error(`[runner] 等待-回测超过 ${MAX_TEST_ROUNDS} 轮，强制收手（防环失控）`);
        break;
    }
    const wait = handle.ledger.getTestWait();
    if (!wait) {
        console.error("[runner] waiting_test 但 Ledger 没有等待窗口——异常，收手");
        break;
    }

    console.log(`\n===== 第 ${rounds} 轮外部验证（correlation=${wait.correlationId}） =====`);
    const verdict = await runAcceptanceChecks(projectDir, task.acceptanceChecks, wait.acceptanceHash);
    const kind = verdictKindOf(verdict);
    if (verdict.skipped.length > 0) {
        // 跳过不是通过：如实打出来，免得后面把"没人执行的判据"读成绿灯
        console.warn(`[runner] ⏭ 本轮有 ${verdict.skipped.length} 项验收未执行（不计入通过判据）：`
            + verdict.skipped.map((s) => `${s.checkId}(${s.kind})`).join(", "));
    }

    // ★ skipped 非空 → 结论只能是 blocked_unverified：禁止 test_passed。
    //   停在循环外先说清楚原因，再交给 Developer 落 blocked（不冒充 verified）。
    if (kind === "blocked_unverified") {
        const detail = `本轮验收有 ${verdict.skipped.length} 项未执行（`
            + verdict.skipped.map((s) => `${s.checkId}/${s.kind}`).join(", ")
            + `），已执行的 ${verdict.results.length} 项中无失败；`
            + "但未执行的判据不能算通过 → 不许 test_passed";
        state = await handle.blockUnverified({ reason: detail, skipped: verdict.skipped });
        console.error(`[test-agent] ⛔ ${detail}`);
        break;
    }

    const messageId = `msg-${hashOf({ r: rounds, c: wait.correlationId, t: Date.now() })}`;
    let msg: TestPassed | TestFailure;
    if (kind === "test_passed") {
        msg = {
            type: "test_passed",
            messageId,
            correlationId: wait.correlationId,
            projectId: task.projectId,
            taskId: task.taskId,
            runId,
            evidence: verdict.evidence,
            verifiedBy: TEST_AGENT_NAME,
            acceptanceHash: wait.acceptanceHash,
        };
        console.log(`[test-agent] 全部 ${verdict.evidence.length} 项通过（无跳过） → test_passed`);
    } else {
        // kind === "test_failure"：有真实失败，firstFailure 必然存在
        const f = verdict.firstFailure;
        if (!f) throw new Error("内部不一致：结论是 test_failure 但没有失败项");
        msg = {
            type: "test_failure",
            messageId,
            correlationId: wait.correlationId,
            runId,
            acceptanceHash: wait.acceptanceHash,
            projectId: task.projectId,
            taskId: task.taskId,
            category: categoryOf(f.check),
            command: f.command,
            args: f.args,
            cwd: f.cwd,
            exitCode: f.exitCode,
            stdout: f.stdout.slice(0, 64_000),
            stderr: f.stderr.slice(0, 64_000),
            affectedFiles: Array.isArray((f.check as unknown as { affectedFiles?: unknown[] }).affectedFiles)
                ? (f.check as unknown as { affectedFiles: unknown[] }).affectedFiles.map(String) : [],
            failureSignature: failureSignatureOf(f),
        };
        console.log(`[test-agent] ${f.check.id} 失败（${msg.category}, exit=${String(f.exitCode)}）→ test_failure sig=${msg.failureSignature}`);
    }

    const resumed = await handle.resumeFromTestMessage(msg, TEST_AGENT_NAME);
    if (resumed === "rejected") {
        console.error("[runner] 测试消息被拒绝（信任链/过期/串线）——查 Ledger inbound_rejected 事件");
        break;
    }
    state = resumed;
}

// ---------- 终局摘要 + 清理 + 报告 ----------

const snap = handle.inspectTaskState();
console.log("\n===== 结果 =====");
console.log(`status=${state.status} 测试轮数=${rounds} llmCalls=${state.llmCallsCompleted}/${state.llmCallsPlanned} toolCalls=${state.toolCalls} repairs=${state.repairAttempts}`);
console.log(`changedFiles(${state.changedFiles.length}): ${state.changedFiles.slice(0, 40).join(", ")}`);
if (state.error) console.log(`error: ${state.error}`);
console.log(`checkpoint: ${snap.lastCheckpoint ? `${snap.lastCheckpoint.node}/${snap.lastCheckpoint.phase}` : "-"}`);
console.log(`sandbox: mode=${caps.mode} backend=${caps.backend} realIsolation=${caps.realIsolation} softIsolation=${caps.softIsolation}`);

// ★ 先写报告（此时还没关账本），再清理进程 + 关账本
const jsonPath = writeReport(state, rounds, snap);
console.log(`\n[runner] 运行报告：${jsonPath}`);
console.log(`[runner] 运行报告（Markdown）：${jsonPath.replace(/\.json$/, ".md")}`);

// 规格三.5：任务完成 / 失败 / 取消 / 崩溃恢复后都必须清理遗留进程。
// shutdown() 会先 cleanupAllProcesses() 再关账本；这里 await 它，不留后台进程。
await handle.shutdown();
console.log("[runner] 已清理遗留进程并关闭 Ledger");
if (wallTimer) clearTimeout(wallTimer);

process.exit(state.status === "ready" ? 0 : 1);
