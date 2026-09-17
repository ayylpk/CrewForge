// ============================================================
// developerTeamRunner.ts —— developerAgent 在团队流水线里的装配线（9/15 替换前后端开发）
//
//   背景：引擎团队（projectRunner 的 buildTeam）原有的 后端开发+前端开发+merger
//   三个工位，被 developerAgent（单开发流，分批消费架构师蓝图）整体替换。
//   本文件是替换的装配层：
//     ① startDeveloperLine：在共享 TransferStation 上占住 "developer" 座位，
//        永动消费 architect_task → 建 handle → 逐批/逐测试结果驱动到终态；
//     ② makeTesterDeps：给改线后的 TestEngineer（"test-core"）注入验收依赖——
//        判据从架构师落盘的 _tasks/{taskId}/（blueprint.json + batch-*.json，
//        发送前落盘，waiting_test 时必已全部到盘）读回合并，翻译规则照抄
//        hub-runner 的 resolveChecks（COMPILE→工程命令；CONTRACT→_verify/serve.json，
//        没有 serve 配置就诚实交空命令 → verify 记未执行 → 看门狗收口，绝不假绿）。
//
//   消息面全部走 Hub.ts 原语（sendMessage/waitForMessage）：
//     architect → developer : architect_task（蓝图）+ architect_batch（逐批）
//     developer → test-core : test_request（requestTest 节点经 adapter.send 自动发）
//     test-core → developer : test_passed / test_failure（trustedTestAgents 闸）
//     developer → architect/maintainer : developer_* 出站（targets 路由）
//   hub-runner.ts 的独立驱动线保留作单 agent 调试工具，与此线互不启动。
//
//   崩溃重放：同一 taskId 重启后 ledger 有 prior 状态 → 不再 acceptArchitectTask
//   （会被状态闸拒），直接 serveOnce 消费在途批；ledger 的幂等/检查点语义原样生效。
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { roles, type TransferStation } from "./Hub";
import { projectDir } from "./runEnv";
import type { AdapterVerifyCheck } from "./testAgentAdapter";
import { TEST_CORE_NAME, type TestEngineerDeps } from "./testEngineer";
import { createDeveloperAgent, type DeveloperAgentHandle } from "./developerAgent/index";
import { parseInbound, type ArchitectTask, type TestRequest } from "./developerAgent/protocol";
import { DEVELOPER_NAME } from "./developerAgent/hubAdapter";
import { createRealLlm } from "./developerAgent/realLlm";
import { resolveProjectCommand } from "./developerAgent/tools/projectCommands";

/** 出站路由的固定站名（Hub 按名字寻址；maintainer/architect 的注册名在各自文件里） */
const ARCHITECT_NAME = "architect";
const MAINTAINER_NAME = "maintainer";

/** 终态判断按 status 字符串（ledger 的 TaskSnapshot.status 就是 string，两处共用一把闸） */
const isTerminalStatus = (status: string): boolean =>
    status === "ready" || status === "blocked" || status === "failed";

// ---------- ① developer 永动消费线 ----------

/**
 * 启动团队线里的 developer。fire-and-forget（与其他 agent 的 start() 同款常驻）。
 * ⚠️ 座位预占必须在这里、且在架构师可能派发之前的任何时刻完成：
 *   Hub.register 会清空 inbox，而后建 handle 的 HubAdapter 检测到已注册就跳过注册
 *   （hubAdapter.ts:66 的探测），在途消息才不丢。
 */
export function startDeveloperLine(station: TransferStation, engineProjectId: number): void {
    if (!station.status[DEVELOPER_NAME]) station.register(DEVELOPER_NAME, roles.unknown);
    void (async () => {
        for (; ;) {
            const m = await station.waitForMessage(DEVELOPER_NAME);
            station.markDone(DEVELOPER_NAME);
            if (!m) continue;
            const pkg = parseInbound(m.content);
            if (!pkg.ok || pkg.message.type !== "architect_task") {
                console.warn(`[developer-line] 丢弃非 architect_task 的到站消息（sender=${m.sender}）：`
                    + (pkg.ok ? pkg.message.type : pkg.error));
                continue;
            }
            try {
                await runOneTask(station, engineProjectId, pkg.message);
            } catch (e) {
                console.error(`[developer-line] handle 生命周期异常（不杀驱动环）：${(e as Error).message}`);
            }
            drainStale(station);   // 作废/终态后的残批清光，不带进下一个任务
        }
    })().catch((e) => console.error("[developer-line] ⛔ 驱动环死了，后续阶段无人消费：", e));
}

/** 收件箱清空（任务间卫生）：读出来只留痕，不回投（残批属于已作废/已完成的流） */
function drainStale(station: TransferStation): void {
    while (station.hasPending(DEVELOPER_NAME)) {
        void station.waitForMessage(DEVELOPER_NAME)?.then((d) => {
            station.markDone(DEVELOPER_NAME);
            const t = (parseInbound(d?.content ?? "").ok ? (parseInbound(d!.content) as { message: { type: string } }).message.type : "?");
            console.warn(`[developer-line] 清废弃残消息：${d?.sender ?? "?"} → ${t}`);
        });
    }
}

/**
 * 预算推导（2026-09-17 重写：规模由蓝图数据定价，不再拍常数）。
 *   公式：30 基数 + 18/工作项 + 9/判据，夹紧 [120, 900] 取 5 的整档。
 *   （2026-09-17 下午上调 1.5×：s4d 实测 80 调对"4 工作项+全判据+预演自修"偏紧，
 *     77/80 时还在打磨；按用户指令拉到 1.5 倍档。）
 *   依据：判据是"验收要过的东西"，是任务规模最诚实的度量（架构师拆解的产物，
 *   项目越大判据越多预算自动越大——回答"你怎么知道我要开发多大"）；
 *   s4c 实测校准：5 工作项 + 12 判据的待办清单烧了 145 调（含预演自修），
 *   公式给出 152，贴合。真失控由无进展保险丝（isAcceptanceStalled/isStalled）兜底，
 *   调用数只是天灾兜底，不再是日常油门。
 */
function budgetOf(_task: ArchitectTask): number {
    // ★ 2026-09-17 对齐 Claude Code：主循环【没有调用数预算】——它靠"任务完成信号"退出，
    //   防失控靠上下文压缩（graph 已有 pruneHistory）+ 无进展保险丝（doom_loop 同族，已有）
    //   + token 记账给用户看（已有）。这里给的是协议层需要的"无穷大"，不是一层新刹车。
    return Number.MAX_SAFE_INTEGER;
}


/** 一个任务包的完整生命周期：建 handle → 驱动到终态 → 关账本 */
async function runOneTask(station: TransferStation, engineProjectId: number, task: ArchitectTask): Promise<void> {
    const dir = projectDir(engineProjectId);
    const ledgerPath = path.join(dir, "_developer", `${task.taskId}.db`);
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });

    // ★ 搬运④（2026-09-17，opencode session.getUsage / dsh token-meter 同族）：
    //   onCall 逐次累加 token 用量，终态随 finishReport 打总账——之前这条生产链路
    //   只有逐行日志没有汇总，评测时 token 花费只能靠正则扒日志。
    const tokenTally = { calls: 0, input: 0, output: 0, escalations: 0 };
    const llm = createRealLlm({
        onCall: (i) => {
            const extra = i.attempts > 1 ? ` [${i.escalated ? "升档" : "重试"}×${i.attempts}]` : "";
            tokenTally.calls += 1;
            tokenTally.input += i.inputTokens;
            tokenTally.output += i.outputTokens;
            if (i.escalated) tokenTally.escalations += 1;
            console.log(`[developer-llm] ${i.latencyMs}ms in=${i.inputTokens} out=${i.outputTokens} stop=${i.stopReason}${extra}`);
        },
    });
    const handle = createDeveloperAgent({
        projectId: task.projectId, taskId: task.taskId,
        projectDir: dir,
        allowedRoots: [...task.allowedRoots],
        ...(task.forbiddenPaths?.length ? { forbiddenPaths: [...task.forbiddenPaths] } : {}),
        ledgerPath,
        // runId=taskId：同一任务重派发（续跑）落回同一账本 → 幂等/检查点语义跨进程生效
        runId: task.taskId,
        station,
        batched: true,                                   // 「拆一个推一个」分批消费（9/15）
        trustedTestAgents: [TEST_CORE_NAME],             // 只认团队里的 test-core 发的结果
        copyTerminalsTo: MAINTAINER_NAME,                // blocked/failed 抄送记账方（lane D 装配点#1）
        targets: { test: TEST_CORE_NAME, architect: ARCHITECT_NAME, maintainer: MAINTAINER_NAME },
        sandbox: { mode: "soft", backend: "local" },     // 与 hub-runner 实弹档一致（本机无 docker）
        llmErrorTolerance: 2,
        maxLlmCalls: budgetOf(task),
        llm,
    });

    console.log(`[developer-line] 接任务 ${task.projectId}/${task.taskId}：工作项 `
        + `${task.foundationPlan.workItems?.length ?? 0} 个，预算 ${budgetOf(task)} 调，产物树 ${dir}`);

    // 崩溃重放：ledger 已有同身份在途状态 → 直接续消费（重发的 architect_task 已在
    // 上面被外层取出；批由 resumeWithBatch 按到窗消化）。身份不符 = 装配错误，显式炸。
    // 身份核对用 taskId 即可：账本文件按 taskId 分路径、runKey 含 projectId，串台到不了这行。
    const prior = handle.ledger.loadState();
    if (prior) {
        if (prior.taskId !== task.taskId) {
            console.error(`[developer-line] ⛔ ledger 身份不符（prior.taskId=${prior.taskId} ≠ ${task.taskId}），本任务跳过`);
            await handle.shutdown();
            return;
        }
        console.log(`[developer-line] 检测到在途 ledger（status=${prior.status}），走续跑`);
        if (isTerminalStatus(prior.status)) { await finishReport(handle, prior, tokenTally); return; }
    } else {
        const first = await handle.acceptArchitectTask(task);
        if (isTerminalStatus(first.status)) { await finishReport(handle, first, tokenTally); return; }
    }

    // 驱动环：serveOnce 到窗消费（停车队列在它内部）；waiting_test 挂看门狗防验收失联
    // ★ 2026-09-17：不加墙钟——用户明确不要运行时长类的硬限制。时长上限只留在外层
    //   eval 驱动器（--timeout-min），系统内部以"完成信号 + 无进展保险丝"为唯一出口。
    for (;;) {
        const snap = handle.ledger.loadState();
        if (snap && isTerminalStatus(snap.status)) { await finishReport(handle, snap, tokenTally); return; }
        if (snap?.status === "waiting_test") {
            const wait = handle.ledger.getTestWait();
            const hardDeadline = (wait?.deadlineAt ?? Date.now() + 900_000) + 60_000;
            const raced = await Promise.race([
                handle.serveOnce().then((r) => ({ kind: "msg" as const, r })),
                new Promise<{ kind: "timeout" }>((res) => setTimeout(() => res({ kind: "timeout" }), Math.max(hardDeadline - Date.now(), 1_000))),
            ]);
            if (raced.kind === "timeout") {
                console.error("[developer-line] ⛔ 看门狗：test-core 超窗未回结果 → 收口 blocked");
                await handle.blockUnverified({
                    reason: "验收等待超窗：test-core 未按时回应 test_request",
                    skipped: [{ checkId: "ACCEPTANCE", kind: "VERIFY", reason: "tester-timeout" }],
                });
                continue;
            }
            if (raced.r === "rejected") { await abortGateRejected(handle); continue; }
            continue;
        }
        const next = await handle.serveOnce();
        if (next === "rejected") { await abortGateRejected(handle); continue; }
        // null = invalid/duplicate：消息已被 adapter 留痕，继续等下一条
    }
}

/** serveOnce 返回 "rejected" = 协议级异常（伪造 sender/乱序批/过期结果）：整次作废（9/15 拍板②） */
async function abortGateRejected(handle: DeveloperAgentHandle): Promise<void> {
    console.error("[developer-line] ⛔ 驱动闸门拒绝（乱序批/伪造源/过期结果）→ 整次作废");
    await handle.abortRun("DRIVER_GATE_REJECTED");
}

/** 收口报告：terminal 只需 status（TaskSnapshot）；error 字段可选（DeveloperState 才带） */
async function finishReport(handle: DeveloperAgentHandle, terminal: { status: string; error?: unknown }, tokenTally?: { calls: number; input: number; output: number; escalations: number }): Promise<void> {
    const snap = handle.inspectTaskState();
    console.log(`[developer-line] 终态 ${terminal.status}：llm ${snap.llmCallsCompleted}/${snap.llmCallsPlanned} `
        + `工具 ${snap.toolCalls} 修复 ${snap.repairAttempts} 改盘 ${snap.changedFiles.length} 个文件`
        + (tokenTally ? ` token in=${tokenTally.input} out=${tokenTally.output}（${tokenTally.calls} 调，升档 ${tokenTally.escalations}）` : "")
        + (terminal.error ? ` error=${String(terminal.error).slice(0, 200)}` : ""));
    await handle.shutdown();
}

// ---------- ② test-core 的验收依赖（判据从 _tasks 落盘读回） ----------

/** 与 architectTaskBuilder:1012 同一命名规则（itemId 文件系统非法字符 → "_"） */
function batchFileOf(itemId: string): string { return `batch-${itemId.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")}.json`; }

/**
 * 合并判据 = developer 端 acceptBatch 的同构重放：蓝图底线判据在前，
 * 各批按**蓝图工作项顺序**追加，按 id 先到先留（builder 生成侧本就防撞，
 * 去重只是双保险）。顺序与内容一致 → acceptanceHashOf 与 developer 端相等，
 * test-core 的 hash 自检闸才不空转。
 */
export function loadTaskChecks(engineProjectId: number, taskId: string): Record<string, unknown>[] | null {
    const dir = path.join(projectDir(engineProjectId), "_tasks", taskId);
    let blueprint: ArchitectTask;
    try {
        blueprint = JSON.parse(fs.readFileSync(path.join(dir, "blueprint.json"), "utf-8")) as ArchitectTask;
    } catch { return null; }
    const out: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    const push = (c: unknown) => {
        const id = String((c as { id?: unknown }).id ?? "?");
        if (seen.has(id)) return;
        seen.add(id);
        out.push(c as Record<string, unknown>);
    };
    (blueprint.acceptanceChecks ?? []).forEach(push);
    for (const item of blueprint.foundationPlan.workItems ?? []) {
        try {
            const b = JSON.parse(fs.readFileSync(path.join(dir, batchFileOf(item.id)), "utf-8")) as { checks?: unknown[] };
            (b.checks ?? []).forEach(push);
        } catch { /* 该批文件缺 = 派发没到这里，developer 端也不会在送检前等它——跳过 */ }
    }
    return out;
}

/** CONTRACT 判据的起服配置（装配契约：落 RUNS_ROOT/pN/_verify/serve.json，缺=未执行诚实报） */
interface ServeConfig { command: string; args?: string[]; cwd?: string; ready?: { url?: string; timeoutMs?: number } }
function loadServeConfig(engineProjectId: number): ServeConfig | null {
    try {
        const f = path.join(projectDir(engineProjectId), "_verify", "serve.json");
        return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf-8")) as ServeConfig) : null;
    } catch { return null; }
}

/** hub-runner resolveChecks（hub-runner.ts:231-277）的团队线移植：COMPILE/显式命令同款，CONTRACT 吃 serve.json */
function translateChecks(raw: Record<string, unknown>[], dir: string, serve: ServeConfig | null): AdapterVerifyCheck[] {
    const out: AdapterVerifyCheck[] = [];
    for (const c of raw) {
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
            const r = resolveProjectCommand(path.join(dir, target));
            out.push(r
                ? { id, category: "COMPILE", command: r.command, args: r.args, cwd: target, timeoutMs: 600_000 }
                : { id, category: "COMPILE" });   // 认不出工程入口 → 不给命令 → verify 如实未执行
            continue;
        }
        if (c["kind"] === "CONTRACT") {
            if (!serve) { out.push({ id, category: "CONTRACT" }); continue; }   // 无 serve 配置 = 未执行，绝不假绿
            out.push({
                id, category: "CONTRACT", command: serve.command,
                args: [...(serve.args ?? []), "--serve", JSON.stringify({ ...serve, cwd: "." }), "--intent", JSON.stringify({
                    method: c["method"], path: c["path"], expectedStatus: c["expectedStatus"] ?? 200,
                    ...(c["body"] !== undefined ? { body: c["body"] } : {}),
                    ...(typeof c["expectBodyContains"] === "string" ? { expectBodyContains: c["expectBodyContains"] } : {}),
                    ...(c["auth"] ? { auth: c["auth"] } : {}),
                })],
                cwd: serve.cwd ?? ".", timeoutMs: 180_000,
            });
            continue;
        }
        out.push({ id, category: "ENV" });   // 不认识的形状：没命令 = 未执行 = 诚实 blocked
    }
    return out;
}

/** 给 buildTeam 用的 TestEngineer 依赖注入包 */
export function makeTesterDeps(engineProjectId: number): TestEngineerDeps {
    const dirOf = (req: TestRequest): string => {
        const pid = Number(req.projectId);
        return projectDir(Number.isInteger(pid) && pid > 0 ? pid : engineProjectId);
    };
    const checksOf = (req: TestRequest): Record<string, unknown>[] | null => {
        const pid = Number(req.projectId);
        return loadTaskChecks(Number.isInteger(pid) && pid > 0 ? pid : engineProjectId, req.taskId);
    };
    return {
        projectDirOf: dirOf,
        runIdOf: (req) => req.taskId,               // 与 runOneTask 的 runId 同口径
        taskChecks: checksOf,
        resolveChecks: (req) => {
            const dir = dirOf(req);
            const raw = checksOf(req) ?? [];
            return translateChecks(raw, dir, loadServeConfig(engineProjectId));
        },
    };
}
