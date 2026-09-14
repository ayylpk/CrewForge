// ============================================================
// live/hub-runner.ts —— ts-site-v2 实弹装配器（正式链，一条直线）
//
//   和旧 runner.ts 的三处不同（9/13 裁决定稿）：
//     ① 任务不再手喂全量 JSON：语义包 → parseArchitectSemantics →
//        buildArchitectTaskFromPlan → dispatchArchitectTask 走**正式派发链**
//        （机械字段、权威字段扫描、功能对账、幂等账本全走真流程）；
//     ② 消息真的过 Hub：Developer 经 hubAdapter 收发；test_request 由本装配器
//        里的验收站订阅，验收交给 F:\code\agent\testAgent --verify（经薄适配器
//        testAgentAdapter 转换），runner 兼任 TestAgent 的历史到此终结；
//     ③ 止损量化：发车前预算校验，发车后按四条红线盯（详见 monitor 段）。
//
//   用法：
//     bun run developerAgent/live/hub-runner.ts --config developerAgent/live/ts-site-v2/V1.json [--fake-llm] [--preplace <dir>] [--reset] [--project-dir <dir>]
//
//   退出码：ready=0；blocked/failed/止损=1；装配/校验未过=2（任务根本不发）。
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { TransferStation } from "../../Hub";
import {
    parseArchitectSemantics, buildArchitectTaskFromPlan, dispatchArchitectTask, openDispatchRegistry,
    type ArchitectSemantics, type PmPlanLike,
} from "../../architectTaskBuilder";
import {
    runTestAgentVerify, VERIFY_AGENT_NAME, buildReviewLedgerPayload, type AdapterVerifyCheck,
} from "../../testAgentAdapter";
import { createDeveloperAgent } from "../index";
import { createRealLlm } from "../realLlm";
import { loadDotEnv } from "../dotenv";
import { DEVELOPER_NAME } from "../hubAdapter";
import { ensureDir } from "../ledger";
import type { ArchitectTask } from "../protocol";
import { resolveProjectCommand } from "../tools/projectCommands";
import type { DeveloperLlm } from "../graph";

// 以仓库 .env 为准（覆盖 shell 继承的 CC 环境变量，否则会打到错误端点）
loadDotEnv();

// ---------- 参数 ----------

const argv = process.argv.slice(2);
const argOf = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 ? (argv[i + 1] ?? null) : null;
};
const configPath = argOf("--config");
if (!configPath) {
    console.error("用法: bun run developerAgent/live/hub-runner.ts --config <phase.json> [--fake-llm] [--preplace <dir>] [--reset]");
    process.exit(2);
}
const FAKE = argv.includes("--fake-llm");
const RESET = argv.includes("--reset");
const PREPLACE = argOf("--preplace");

const CFG_FILE = path.resolve(configPath);
interface PhaseConfig {
    projectId: string;
    phase: number;
    pmPlan: PmPlanLike;
    semantics: unknown;
    budget: { files: number; installSteps?: number; buildSteps?: number; selfCheckSteps?: number; rounds?: number };
    serve: { command: string; args: string[]; cwd: string; portEnv?: string; bootWaitMs?: number; healthPath?: string };
    extraChecks?: { id: string; command: string; args?: string[]; cwd?: string; category?: string; timeoutMs?: number }[];
    maxStepsPerLoop?: number;
    maxLlmCalls?: number;
    /** 修复轮数上限：由任务配置显式决定，默认沿用 DeveloperAgent 默认值 */
    maxRepairAttempts?: number;
    /** 任务改动范围（剔除装配器默认值里本任务不涉及的目录，如 P1-A 无前端）；缺省=["frontend","backend"] */
    allowedRoots?: string[];
}
const cfg = JSON.parse(fs.readFileSync(CFG_FILE, "utf-8")) as PhaseConfig;

const AGENT_DIR = import.meta.dir.replace(/[/\\]live$/, "");
const REPO_ROOT = path.resolve(AGENT_DIR, "..");
const CREWFORGE_ROOT = path.resolve(REPO_ROOT, "..");
const RUNS_ROOT = path.join(CREWFORGE_ROOT, ".runs", "developer-local");
const PROBE = path.join(REPO_ROOT, "httpContractProbe.ts");
const ORCH = "v2-orchestrator";

const projectId = cfg.projectId;
const taskId = `${projectId}-p${cfg.phase}`;
const runId = argOf("--run-id") ?? `${projectId}-p${cfg.phase}`;
const projectDir = path.resolve(argOf("--project-dir") ?? path.join(RUNS_ROOT, `${projectId}-1`));
const ledgerPath = path.join(RUNS_ROOT, "_ledger", `${runId}.db`);
const dispatchDb = path.join(RUNS_ROOT, "_architect", `${runId}.db`);
const reportDir = path.join(RUNS_ROOT, "_reports");
const startedAt = Date.now();

function say(line: string): void { console.log(`[hub-runner] ${line}`); }

// ---------- ① 装配校验：双校验 + 步数预算（不过就修包，任务根本不发） ----------

const semParsed = parseArchitectSemantics(cfg.semantics);
if (!semParsed.ok) {
    console.error(`[hub-runner] ⛔ 语义包没过 parseArchitectSemantics：${semParsed.code}\n  - ${semParsed.issues.join("\n  - ")}`);
    process.exit(2);
}
const built = buildArchitectTaskFromPlan({
    pmPlan: cfg.pmPlan, semantics: semParsed.value as ArchitectSemantics,
    projectId, phase: cfg.phase,
    // 幽灵判据修复（9/13 P1-A 实弹）：范围里声明了才派生 COMPILE 判据，
    // 不声明=按默认前后端。只收紧、不放松任何真实验收。
    ...(Array.isArray(cfg.allowedRoots) && cfg.allowedRoots.length > 0 ? { allowedRoots: cfg.allowedRoots } : {}),
});
if (!built.ok || !built.task || !built.packageHash) {
    console.error(`[hub-runner] ⛔ 装配失败：${built.code ?? "UNKNOWN"}\n  - ${built.issues.join("\n  - ")}`);
    process.exit(2);
}
const task: ArchitectTask = built.task;
{ // 预算公式（任务书原样）：文件数×1 + install×2 + build×2 + 自检 ≤ maxSteps×轮数
    const maxSteps = cfg.maxStepsPerLoop ?? 12;
    const rounds = cfg.budget.rounds ?? 2;
    const needed = cfg.budget.files * 1 + (cfg.budget.installSteps ?? 2) * 2
        + (cfg.budget.buildSteps ?? 2) * 2 + (cfg.budget.selfCheckSteps ?? 2);
    const allowed = maxSteps * rounds;
    say(`预算校验：need=${needed}（files=${cfg.budget.files}） ≤ allowed=${allowed}（maxSteps=${maxSteps}×rounds=${rounds}） → ${needed <= allowed ? "✅" : "⛔"}`);
    if (needed > allowed) {
        console.error(`[hub-runner] ⛔ 步数预算不够：${needed} > ${allowed}。加大 maxStepsPerLoop/rounds 或砍本阶段范围，改包重发（不许绕过）`);
        process.exit(2);
    }
}
say(`任务装配 OK：${task.taskId} packageHash=${built.packageHash.slice(0, 8)}… 判据 ${task.acceptanceChecks.length} 项（+探针 ${cfg.extraChecks?.length ?? 0}）`);

// ---------- 目录与 --reset ----------

if (RESET) {
    for (const f of [ledgerPath, dispatchDb]) for (const suffix of ["", "-wal", "-shm"]) {
        try { fs.rmSync(f + suffix); } catch { /* 不存在=正常 */ }
    }
    say("--reset：已清 Ledger 与派发幂等账本（项目文件保留=增量续跑）");
}
ensureDir(path.dirname(ledgerPath));
fs.mkdirSync(projectDir, { recursive: true });
fs.mkdirSync(reportDir, { recursive: true });
if (PREPLACE) {
    const src = path.resolve(PREPLACE);
    const copy = (d: string): void => {
        for (const f of fs.readdirSync(d, { withFileTypes: true })) {
            const s = path.join(d, f.name);
            const t = path.join(projectDir, path.relative(src, s).replace(/\\/g, "/"));
            if (f.isDirectory()) { fs.mkdirSync(t, { recursive: true }); copy(s); }
            else fs.copyFileSync(s, t);
        }
    };
    copy(src);
    say(`--preplace：桩项目已拷入 ${projectDir}（冒烟专用）`);
}

// ---------- ② LLM：真模型 or 冒烟脚本假 ----------

const tokenTally = { calls: 0, input: 0, output: 0, maxTokensCuts: 0 };
let realLlm: ReturnType<typeof createRealLlm> | null = null;
const progress = { writes: 0, streak: 0 }; // 止损①：连续 5 次无写盘且无有效工具决策

const llm: DeveloperLlm = FAKE
    ? {
        id: "fake-hub-runner",
        calls: () => tokenTally.calls,
        async next() {
            tokenTally.calls++;
            // 冒烟假手：只说"本轮做完了"，把活推给验收环（写盘判据全靠 --preplace 桩）
            return { kind: "done", note: "冒烟：桩项目已就位，直接送检" };
        },
    }
    : {
        id: "real-lazy",
        calls: () => realLlm?.calls() ?? 0,
        async next(input) {
            if (!realLlm) {
                realLlm = createRealLlm({
                    onCall: (i) => {
                        tokenTally.calls++; tokenTally.input += i.inputTokens; tokenTally.output += i.outputTokens;
                        if (i.stopReason === "max_tokens") tokenTally.maxTokensCuts++;
                        say(`[llm#${tokenTally.calls}] ${i.latencyMs}ms in=${i.inputTokens} out=${i.outputTokens} stop=${i.stopReason}`);
                    },
                });
            }
            const raw = await realLlm.next(input);
            // 止损①：连续 5 次 LLM 调用无 changedFiles 增长且无有效工具决策 → 空转 kill。
            // 写盘看 write_audit 事件（Ledger 实时流），决策看输出里有没有"写/执行类"工具调用。
            try {
                const writes = handle.ledger.listEvents().filter((e) => e.type === "write_audit").length;
                const txt = typeof raw === "string" ? raw : JSON.stringify(raw ?? "");
                // 进展的口径（9/13 增量误杀后修正）：写盘增长 / 工具决策 / **合法 done 决策**都算前进。
                // done=节点收尾状态机推进——存量项目上"看一眼就说做完了"是正确行为不是空转；
                // 真正的空转特征（顶格散文/解析失败/同码重build）由 streak、监控 R2 与引擎预算闸兜住。
                const forwardDecision = /"kind"\s*:\s*"(tool|done)"/.test(txt);
                if (writes > progress.writes || forwardDecision) progress.streak = 0;
                else progress.streak++;
                progress.writes = Math.max(progress.writes, writes);
                if (progress.streak >= 5) {
                    console.error("[hub-runner] ⛔ 止损：连续 5 次 LLM 调用无 changedFiles、无有效工具产出");
                    await finish("spin-kill", null);
                }
            } catch { /* 监控自身出错不拦任务，让引擎预算闸自己收敛 */ }
            return raw;
        },
    };

// ---------- ③ 装配：Hub + Developer + 验收站 ----------

const station = new TransferStation({}, {});
const handle = createDeveloperAgent({
    projectId, taskId, projectDir,
    allowedRoots: [...task.allowedRoots],
    ledgerPath, runId,
    trustedTestAgents: [VERIFY_AGENT_NAME],
    targets: { test: VERIFY_AGENT_NAME, architect: ORCH, maintainer: ORCH },
    station,
    sandbox: { mode: "soft", backend: "local" },
    llmErrorTolerance: 2,
    ...(cfg.maxStepsPerLoop !== undefined ? { maxStepsPerLoop: cfg.maxStepsPerLoop } : {}),
    ...(cfg.maxLlmCalls !== undefined ? { maxLlmCalls: cfg.maxLlmCalls } : {}),
    ...(cfg.maxRepairAttempts !== undefined ? { maxRepairAttempts: cfg.maxRepairAttempts } : {}),
    llm,
});

const sigCount = new Map<string, number>(); // 止损②：同一失败签名第 2 次出现

/** 任务包判据（COMPILE/CONTRACT 意图或显式命令）→ verify 能跑的显式命令判据。翻译是机械规则，不猜。 */
function resolveChecks(): AdapterVerifyCheck[] {
    const out: AdapterVerifyCheck[] = [];
    for (const raw of task.acceptanceChecks) {
        const c = raw as Record<string, unknown>;
        const id = String(c["id"] ?? "?");
        if (typeof c["command"] === "string") {
            out.push({
                id, category: typeof c["category"] === "string" ? c["category"] : "COMPILE",
                command: c["command"], args: Array.isArray(c["args"]) ? c["args"].map(String) : [],
                cwd: typeof c["cwd"] === "string" ? c["cwd"] : ".",
                timeoutMs: typeof c["timeoutMs"] === "number" ? c["timeoutMs"] : undefined,
            });
            continue;
        }
        if (c["kind"] === "COMPILE") {
            const target = String(c["target"] ?? ".");
            const r = resolveProjectCommand(path.join(projectDir, target));
            out.push(r
                ? { id, category: "COMPILE", command: r.command, args: r.args, cwd: target, timeoutMs: 600_000 }
                : { id, category: "COMPILE" }); // 认不出工程入口 → 不给命令 → verify 如实 skipped（blocked_unverified）
            continue;
        }
        if (c["kind"] === "CONTRACT") {
            const { cwd: _drop, ...serveRest } = cfg.serve; // 检查本身在 serve.cwd 起，探针里不再嵌套
            out.push({
                id, category: "CONTRACT", command: "bun",
                args: ["run", PROBE, "--serve", JSON.stringify({ ...serveRest, cwd: "." }), "--intent", JSON.stringify({
                    method: c["method"], path: c["path"], expectedStatus: c["expectedStatus"] ?? 200,
                    ...(c["body"] !== undefined ? { body: c["body"] } : {}),
                    ...(typeof c["expectBodyContains"] === "string" ? { expectBodyContains: c["expectBodyContains"] } : {}),
                    ...(c["auth"] ? { auth: c["auth"] } : {}),
                })],
                cwd: cfg.serve.cwd, timeoutMs: 180_000,
            });
            continue;
        }
        out.push({ id, category: "ENV" }); // 不认识的形状：没命令 = 未执行 = 诚实 blocked
    }
    for (const p of cfg.extraChecks ?? []) {
        out.push({
            id: p.id, category: p.category ?? "ENV", command: p.command,
            args: (p.args ?? []).map((a) => String(a).replace(/\{projectDir\}/g, projectDir).replace(/\{root\}/g, AGENT_DIR)),
            cwd: p.cwd ?? ".", timeoutMs: p.timeoutMs,
        });
    }
    return out;
}

let stopStation = false;
const verifyRounds: { at: number; kind: string; detail: string }[] = [];

async function stationLoop(): Promise<void> {
    if (!station.status[VERIFY_AGENT_NAME]) station.register(VERIFY_AGENT_NAME, 4 /* roles.testEngineer */);
    while (!stopStation) {
        const msg = await station.waitForMessage(VERIFY_AGENT_NAME);
        try {
            const req = JSON.parse(msg?.content ?? "{}") as Record<string, unknown>;
            if (req["type"] !== "test_request") continue;
            say(`[station] 收到 test_request corr=${String(req["correlationId"]).slice(0, 12)}… → spawn testAgent --verify`);
            const out = await runTestAgentVerify({
                projectId: String(req["projectId"]), taskId: String(req["taskId"]), runId,
                correlationId: String(req["correlationId"]), acceptanceHash: String(req["acceptanceHash"]),
                projectDir, acceptanceChecks: resolveChecks(),
            }, { log: (l) => say(l) });
            // 审查审计先落 Ledger（要求 19）：谁审、审的什么、审了多久、烧了多少 token、发现了什么。
            // 无论最终 verdict 是什么都记——"没发现"同样是证据。
            // test_failure 分支的 result 可能是 null（环境类结构化失败，根本没跑到审查），这时不记。
            const r = out.result ?? null;
            if (r) {
                handle.ledger.appendEvent("llm_review", buildReviewLedgerPayload(r, {
                    correlationId: String(req["correlationId"]),
                    taskId: String(req["taskId"]),
                }));
            }
            if (out.kind === "unverified") {
                verifyRounds.push({ at: Date.now(), kind: "unverified", detail: JSON.stringify(out.result.skipped).slice(0, 500) });
                station.sendMessage(VERIFY_AGENT_NAME, ORCH, JSON.stringify({
                    type: "v2_verdict", kind: "unverified", correlationId: req["correlationId"],
                    skipped: out.result.skipped,
                }));
            } else if (out.kind === "needs_human") {
                // 审查不可用 / 审查不确定：既不能放行，也不是给 Developer 修的代码问题——
                // 交给编排层/人工确认，绝不静默当成 pass。
                verifyRounds.push({ at: Date.now(), kind: "needs_human", detail: out.reasons.join("；").slice(0, 500) });
                say(`[station] 🙋 需要人工确认：${out.reasons.join("；")}`);
                station.sendMessage(VERIFY_AGENT_NAME, ORCH, JSON.stringify({
                    type: "v2_verdict", kind: "needs_human", correlationId: req["correlationId"],
                    reasons: out.reasons,
                    reviewStatus: out.result.reviewStatus ?? "disabled",
                    reviewReason: out.result.reviewReason ?? null,
                    llmReview: out.result.llmReview ?? null,
                    reviewSignals: out.result.reviewSignals ?? [],
                    mechanicalVerdict: out.result.mechanicalVerdict ?? out.result.verdict,
                }));
            } else {
                const m = out.message;
                if (out.kind === "test_failure") {
                    const failure = m as Extract<typeof m, { type: "test_failure" }>;
                    verifyRounds.push({
                        at: Date.now(), kind: out.kind,
                        detail: `${failure.origin ?? "mechanical"} ${failure.category} ${failure.command} exit=${String(failure.exitCode)}`
                            + ` 红单${failure.allFailures?.length ?? 0}条 阻断${failure.blockingFindingTitles?.length ?? 0}条`,
                    });
                    const sig = failure.failureSignature;
                    const n = (sigCount.get(sig) ?? 0) + 1;
                    sigCount.set(sig, n);
                    if (n >= 2) say(`[止损] 同一失败签名第 ${n} 次出现：${sig.slice(0, 8)}…`);
                } else {
                    const passed = m as Extract<typeof m, { type: "test_passed" }>;
                    verifyRounds.push({ at: Date.now(), kind: out.kind, detail: `${passed.evidence.length} 项证据（含语义审查通过）` });
                }
                station.sendMessage(VERIFY_AGENT_NAME, DEVELOPER_NAME, JSON.stringify(m));
            }
        } catch (e) {
            say(`[station] ⚠️ 处理异常：${(e as Error).message}`);
        } finally {
            station.markDone(VERIFY_AGENT_NAME);
        }
    }
}
const stationTask = stationLoop();

// ---------- ④ 派发（正式链）+ 主循环 ----------

const owned = openDispatchRegistry(dispatchDb);
let dispatchOutcome;
try {
    dispatchOutcome = dispatchArchitectTask({
        station, task, packageHash: built.packageHash,
        sender: "architect", receiver: DEVELOPER_NAME,
        isDuplicate: owned.registry.isDuplicate,
        markDispatched: (key) => owned.registry.markDispatched(key),
    });
} finally { owned.close(); }
if (!dispatchOutcome.dispatched) {
    console.error(`[hub-runner] ⛔ 派发被拒：${dispatchOutcome.reason}（同包同账本 = 幂等拦截；要重发用 --reset）`);
    process.exit(2);
}
say(`已派发 architect_task → developer（key=${dispatchOutcome.key.slice(0, 20)}…）`);

let shuttingDown = false;
async function finish(label: string, state: { status: string } | null): Promise<never> {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    stopStation = true;
    say(`收尾（${label}）status=${state?.status ?? "-"}`);
    const snap = handle.inspectTaskState();
    const report = {
        runId, projectId, taskId, config: CFG_FILE, projectDir, ledgerPath,
        packageHash: built.packageHash,
        result: {
            status: state?.status ?? "unknown", label,
            llmCalls: snap.llmCallsCompleted, planned: snap.llmCallsPlanned,
            toolCalls: snap.toolCalls, repairs: snap.repairAttempts,
            changedFiles: snap.changedFiles, error: (state as { error?: string | null } | null)?.error ?? null,
            durationMs: Date.now() - startedAt,
        },
        tokens: tokenTally,
        verifyRounds,
        signatureCounts: [...sigCount.entries()].map(([s, n]) => ({ s: s.slice(0, 12), n })),
        sandbox: handle.sandboxCapabilities(),
    };
    const jsonPath = path.join(reportDir, `${runId}-${new Date(startedAt).toISOString().replace(/[:.]/g, "-")}.json`);
    try { fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf-8"); say(`运行报告：${jsonPath}`); } catch { /* 报告失败不拦收尾 */ }
    try { await handle.shutdown(); } catch { /* 账本可能已关 */ }
    process.exit(state?.status === "ready" ? 0 : 1);
}
for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => { void finish(`signal-${sig}`, handle.inspectTaskState() as never); });
}

let state = await handle.serveOnce();
if (!state) {
    console.error("[hub-runner] ⛔ serveOnce 没吃到 architect_task（Hub 环没通）");
    await finish("no-task", null);
}

const MAX_TEST_ROUNDS = 8;
let rounds = 0;
while (state && state.status === "waiting_test") {
    if (++rounds > MAX_TEST_ROUNDS) { console.error("[hub-runner] 等待-回测超 8 轮，收手"); break; }
    const wait = handle.ledger.getTestWait();
    const hardDeadline = (wait?.deadlineAt ?? Date.now() + 900_000) + 60_000;
    // 止损④：test_request 发出后 15 分钟无结果回包 = 验收空转 → kill
    while (true) {
        if (station.hasPending(ORCH)) {
            const m = await station.waitForMessage(ORCH);
            station.markDone(ORCH);
            const v = JSON.parse(m?.content ?? "{}") as Record<string, unknown>;
            if (v["kind"] === "unverified") {
                const skipped = (v["skipped"] ?? []) as { checkId: string; reason: string }[];
                state = await handle.blockUnverified({
                    reason: `独立验收有 ${skipped.length} 项判据未执行：${skipped.map((s) => `${s.checkId}(${s.reason})`).join("；").slice(0, 800)}`,
                    skipped: skipped.map((s) => ({ checkId: s.checkId, kind: "VERIFY", reason: s.reason })),
                });
                break;
            }
            continue;
        }
        if (handle.adapter.hasPending()) {
            const res = await handle.adapter.receive();
            if (res.status === "message") {
                const resumed = await handle.resumeFromTestMessage(res.message, res.sender);
                if (resumed === "rejected") {
                    console.error("[hub-runner] 测试消息被信任链拒绝，停");
                    await finish("rejected", state);
                } else {
                    state = resumed;
                }
                break;
            }
            if (res.status === "invalid") console.error(`[hub-runner] 入站被拒：${res.error}`);
            continue;
        }
        if (Date.now() > hardDeadline) { console.error("[hub-runner] ⛔ 止损：等待验收结果超窗（空转）"); await finish("test-wait-timeout", state); }
        await Bun.sleep(500);
    }
}

// ---------- ⑤ 终局 ----------

if (!state) await finish("no-state", null);
if (state === null) throw new Error("unreachable: finish(no-state) exits the process");
const snap = handle.inspectTaskState();
console.log("\n===== 结果 =====");
console.log(`status=${state.status} 测试轮数=${rounds} llmCalls=${state.llmCallsCompleted}/${state.llmCallsPlanned} toolCalls=${state.toolCalls} repairs=${state.repairAttempts}`);
console.log(`tokens in=${tokenTally.input} out=${tokenTally.output} maxTokens顶格=${tokenTally.maxTokensCuts}`);
console.log(`changedFiles(${state.changedFiles.length})`);
if (state.error) console.log(`error: ${state.error}`);
await finish("terminal", state);
export {}; // 满足模块语义；本文件是入口脚本
