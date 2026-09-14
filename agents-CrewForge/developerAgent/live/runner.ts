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
//   用法：
//     bun run developerAgent/live/runner.ts \
//       --task developerAgent/live/mysite/T1-foundation.json \
//       --project F:\code\project\CrewForge\.runs\developer-local\live-1 \
//       --sandbox soft --reset
//     可选：--run-id <id>（默认取 --project 的末级目录名，或 live-1）
//   退出码：ready=0；blocked/failed/rejected=1。
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { createDeveloperAgent } from "../index";
import { createRealLlm } from "../realLlm";
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
    "用法: bun run developerAgent/live/runner.ts --task <architect_task.json> [--project <dir>] [--sandbox soft|strict] [--run-id <id>] [--reset]",
    "",
    "  --sandbox soft    本机受约束执行（realIsolation=false，仅开发/冒烟）",
    "  --sandbox strict  默认：没有真实隔离后端就不执行命令（blocked）",
].join("\n");

const taskFile = argOf("--task");
if (!taskFile) {
    console.error(USAGE);
    process.exit(2);
}
const taskFilePath = path.resolve(taskFile);
loadDotEnv();   // 进点第一件事：以仓库 .env 为准（覆盖 shell 继承的 ANTHROPIC_*）

const AGENT_DIR = import.meta.dir.replace(/[/\\]live$/, "");          // developerAgent/
const REPO_ROOT = path.resolve(AGENT_DIR, "..");                      // agents-CrewForge/
const CREWFORGE_ROOT = path.resolve(REPO_ROOT, "..");                 // 仓库根
const RUNS_ROOT = path.join(CREWFORGE_ROOT, ".runs", "developer-local");

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

// ---------- 任务包：先过 protocol 校验，架构师手不抖也不行 ----------

const raw = JSON.parse(fs.readFileSync(taskFilePath, "utf-8"));
const parsed = parseInbound(raw);
if (!parsed.ok || parsed.message.type !== "architect_task") {
    console.error(`任务包不合法：${(parsed as { error?: string }).error ?? "不是 architect_task"}`);
    process.exit(2);
}
const task = parsed.message as ArchitectTask;

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
const lazyLlm = {
    id: "real-lazy",
    calls: () => realLlm?.calls() ?? 0,
    next: async (input: Parameters<ReturnType<typeof createRealLlm>["next"]>[0]) => {
        if (!realLlm) {
            realLlm = createRealLlm({
                onCall: (i) => {
                    llmSeq++;
                    console.log(`[llm#${llmSeq}] ${i.latencyMs}ms in=${i.inputTokens} out=${i.outputTokens} → ${i.rawText.slice(0, 160).replace(/\s+/g, " ")}`);
                },
            });
        }
        return realLlm.next(input);
    },
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

process.exit(state.status === "ready" ? 0 : 1);
