// ============================================================
// index.ts —— developerAgent 对外入口
//
//   装配关系（一眼可读）：
//     Workspace（唯一写盘闸门）
//        ↓ 注入
//     ToolRegistry（11 个工具只能从这里调）
//        ↓ 注入
//     DeveloperGraph（LangGraph 图，结构写死）—— 内部跑 LLM 工具循环
//        ↑↓
//     HubAdapter（外部通信；重复投递幂等）
//        ↑↓
//     DeveloperLedger（持久化状态真相；崩溃恢复从这里读）
//
//   本文件不做业务判断，只负责把上面几件接起来 + 异常收尾。
// ============================================================

import path from "node:path";
import { TransferStation } from "../Hub";
import { HubAdapter } from "./hubAdapter";
import type { ReceiveResult } from "./hubAdapter";
import { DeveloperLedger, ensureDir } from "./ledger";
import { buildDeveloperGraph } from "./graph";
import type { DeveloperGraphDeps, DeveloperLlm, DeveloperTargets } from "./graph";
import { createFullDeveloperToolRegistry } from "./tools/registry";
import type { ToolRegistry } from "./tools/registry";
import type { SandboxCapabilities, SandboxConfig } from "./tools/processSandbox";
import { createReadonlyTestAssistant } from "./tools/testAssistant";
import type { ReadonlySubAgentLlm } from "./tools/readonlySubAgent";
import { Workspace } from "./workspace";
import { initialDeveloperState, isTestWaitExpired } from "./state";
import type { DeveloperState, DeveloperStatus } from "./state";
import { validateTestFailure, validateTestPassed } from "./protocol";
import type { ArchitectTask, InboundMessage, TestTrustContext } from "./protocol";

export interface DeveloperAgentOptions {
    projectId: string;
    taskId: string;
    /** 生成项目根（allowedRoots 相对它解析） */
    projectDir: string;
    allowedRoots: string[];
    /** Ledger 落盘路径（一般放在 runs 目录下） */
    ledgerPath: string;
    llm: DeveloperLlm;
    /** 本次运行的唯一 id（参与 runKey）；不传用 "default" */
    runId?: string;
    /** 受信的独立 TestAgent 名字（**代码配置**）；不传 = 谁也不信 */
    trustedTestAgents?: readonly string[];
    /** 不传则新建一个独立 TransferStation（模块自测用） */
    station?: TransferStation;
    forbiddenPaths?: string[];
    /**
     * 命令白名单 —— **部署环境安全策略**，不是 Developer 的默认限制。
     * 不传 = 不限命令种类；传了就是部署方明确要求收窄（命中返回 DEPLOYMENT_COMMAND_DENIED）。
     */
    commandAllowlist?: string[];
    /**
     * 沙箱配置。默认 strict + backend=none = 本机没有隔离后端 → 直接 blocked，
     * **不会**静默降级成宿主机裸跑（规格三）。
     * 仅测试可显式 `{ mode: "soft" }`；生产请配 `{ backend: "docker", docker: { image } }`。
     */
    sandbox?: Partial<SandboxConfig>;
    targets?: Partial<DeveloperTargets>;
    maxLlmCalls?: number;
    maxStepsPerLoop?: number;
    /** 修复轮数上限（来自可信代码配置，不来自任务包或用户文本） */
    maxRepairAttempts?: number;
    /** 等待 TestAgent 结果的时限（毫秒）；过期后到达的结果一律拒绝。默认 15 分钟 */
    waitTestTimeoutMs?: number;
    /** LLM 连续失败容忍次数（真实网络建议 2）；缺省 0=规格原语义，一次失败即整任务 failed */
    llmErrorTolerance?: number;
    /** 只读分析器注入点；不传时默认接**只读 Test Assistant**（tools/testAssistant.ts） */
    analyzer?: DeveloperGraphDeps["analyzer"];
    /** 结构化只读子 Agent 的 LLM 驱动（不传 = 确定性零 LLM 分析，规格一.10） */
    subagentLlm?: ReadonlySubAgentLlm;
    /** 子 Agent 调用超时（默认 120s，硬夹到 ≤240s，规格九.3） */
    subagentTimeoutMs?: number;
    /** 每任务子 Agent 调用上限（默认 3；同一 failureSignature 恒为 1，规格九.2） */
    maxSubagentCalls?: number;
}

export interface DeveloperAgentHandle {
    readonly adapter: HubAdapter;
    readonly workspace: Workspace;
    readonly ledger: DeveloperLedger;
    readonly tools: ToolRegistry;
    /** 跑一个 ArchitectTask 到终态（或从 Ledger 恢复后的终态）；等价于 acceptArchitectTask */
    run(input: { task: ArchitectTask }): Promise<DeveloperState>;
    /** 规格十一接入接口：接收架构师任务（含 schema 与身份校验） */
    acceptArchitectTask(task: ArchitectTask): Promise<DeveloperState>;
    /** 阻塞从 Hub 收一条消息，是 architect_task 就执行（供接入旧 Hub 时驱动） */
    serveOnce(): Promise<DeveloperState | null>;
    /** 测试消息到达后的恢复入口（校验信任链后从 handleTestResult 继续） */
    resumeFromTestMessage(msg: InboundMessage, sender: string): Promise<DeveloperState | "rejected">;
    /** 规格十一接入接口：显式取消任务（任何非终态都可取消；终态幂等返回） */
    cancelTask(reason?: string): Promise<DeveloperState>;
    /**
     * 验收没跑完（存在 skipped 判据）→ 落 blocked_unverified，**不发 test_passed**。
     * status=blocked，error 前缀 `[BLOCKED_UNVERIFIED]`，Ledger 落 blocked_unverified 事件。
     */
    blockUnverified(detail: {
        reason: string;
        skipped?: { checkId: string; kind: string; reason: string }[];
    }): Promise<DeveloperState>;
    /** 规格十一接入接口：只读查看当前任务状态（供看板 / 外部 scheduler 判断是否超时） */
    inspectTaskState(): {
        taskId: string; runKey: string; status: string;
        correlationId: string | null;
        testDeadlineAt: number | null;
        testWaitOverdue: boolean;
        repairAttempts: number; failureSignatures: string[]; changedFiles: string[];
        llmCallsPlanned: number; llmCallsCompleted: number; toolCalls: number;
        subagentCalls: number;
        workItems: { id: string; kind: string; done: boolean }[];
        lastCheckpoint: { node: string; phase: string; resumeNode: string | null } | null;
        activeProcesses: number;
        sandbox: { mode: string; backend: string; realIsolation: boolean; softIsolation: boolean };
    };
    /** 只读沙箱能力视图（Orchestrator 据此判断"这套环境能不能真的干活"） */
    sandboxCapabilities(): SandboxCapabilities;
    /** 异步收尾：清掉全部遗留进程再关账本 */
    shutdown(): Promise<void>;
    close(): void;
}

const DEFAULT_COMMANDS: string[] = [];

export function createDeveloperAgent(o: DeveloperAgentOptions): DeveloperAgentHandle {
    ensureDir(path.dirname(o.ledgerPath));

    // runId 参与 runKey（规格八）：同一个 Ledger 文件里不同 run 不会互相混记；
    // 不传时为固定值，保证「同一任务的再次调用」仍能读到上次的恢复快照。
    const runId = o.runId ?? "default";
    const runKey = `${o.projectId}:${o.taskId}:${runId}`;
    const ledger = DeveloperLedger.open(o.ledgerPath, runKey);

    // 命令白名单不再是 Developer 的默认拒绝条件（规格二.1）：
    // 不传 = 空数组 = 不限命令种类。传了才当部署级安全策略用。
    const workspace = new Workspace({
        projectDir: o.projectDir,
        allowedRoots: o.allowedRoots,
        ...(o.forbiddenPaths ? { forbiddenPaths: o.forbiddenPaths } : {}),
        ledgerPath: o.ledgerPath,
        // Ledger 不进文件快照（宿主自己也在写），改用"只降不升"的完整性探针
        ledgerIntegrity: () => ledger.integrityCounters(),
        commandAllowlist: o.commandAllowlist ?? DEFAULT_COMMANDS,
        ...(o.sandbox ? { sandbox: o.sandbox } : {}),
    }, (record) => ledger.appendEvent("write_audit", record), {
        // 规格五.9：进程的启动 / 轮询 / 停止都必须落 Ledger（专用表，便于对账）
        onProcessEvent: (ev) => ledger.recordProcessEvent({
            kind: ev.kind,
            taskId: String(ev.payload["taskId"] ?? o.taskId),
            processId: typeof ev.payload["processId"] === "string" ? ev.payload["processId"] : null,
            pid: typeof ev.payload["pid"] === "number" ? ev.payload["pid"] : null,
            command: typeof ev.payload["command"] === "string" ? ev.payload["command"] : "",
            args: Array.isArray(ev.payload["args"]) ? ev.payload["args"] as string[] : [],
            detail: ev.payload,
        }),
        onViolation: (v) => ledger.recordViolation({
            code: v.code, target: v.target, message: v.message,
            taskId: o.taskId, at: Date.now(),
        }),
    });

    const tools = createFullDeveloperToolRegistry();
    const station = o.station ?? new TransferStation({}, {});
    const adapter = new HubAdapter({ station, ledger, trustedTestAgents: o.trustedTestAgents ?? [] });

    // 默认接**只读 Test Assistant**：能搜索、能读文件、能分析编译日志，
    // 但写盘工具 / 任意命令 / TestPassed / State 它在代码层就摸不到（tools/testAssistant.ts）。
    const analyzer = o.analyzer ?? createReadonlyTestAssistant({
        workspace, tools, taskId: o.taskId,
    });

    const graph = buildDeveloperGraph({
        workspace,
        tools,
        ledger,
        port: adapter,
        llm: o.llm,
        analyzer,
        ...(o.targets ? { targets: o.targets } : {}),
        ...(o.maxLlmCalls !== undefined ? { maxLlmCalls: o.maxLlmCalls } : {}),
        ...(o.maxStepsPerLoop !== undefined ? { maxStepsPerLoop: o.maxStepsPerLoop } : {}),
        ...(o.waitTestTimeoutMs !== undefined ? { waitTestTimeoutMs: o.waitTestTimeoutMs } : {}),
        ...(o.llmErrorTolerance !== undefined ? { llmErrorTolerance: o.llmErrorTolerance } : {}),
        ...(o.subagentLlm ? { subagentLlm: o.subagentLlm } : {}),
        ...(o.subagentTimeoutMs !== undefined ? { subagentTimeoutMs: o.subagentTimeoutMs } : {}),
        ...(o.maxSubagentCalls !== undefined ? { maxSubagentCalls: o.maxSubagentCalls } : {}),
        configuredAllowedRoots: o.allowedRoots,
        trustedTestAgents: o.trustedTestAgents ?? [],
    });

    // ★ 图的**跳转**上限：LangGraph 默认 25 跳，超了直接抛异常（整任务 failed）。
    //   数的是**节点之间的跳转**，与 maxStepsPerLoop（节点内部 LLM 轮数）是两回事——
    //   88 次 LLM 调用可能只对应十几次跳转。
    //   修好工作项推进后跳数会真的上去（5 个工作项 ≈ 3 + 5×2 + 1 + 4×2 ≈ 22 跳），
    //   25 贴得太紧，所以按 maxLlmCalls 推导：每轮 LLM 调用最多对应几跳，留出余量。
    //   真正的安全闸仍是 maxLlmCalls / llmBudget / isRepairExhausted，这个值只是别误伤。
    const recursionLimit = (o.maxLlmCalls ?? 40) * 3 + 20;

    /** 崩溃恢复：终态任务直接短路返回，绝不重跑已完成阶段 */
    const snapshot = ledger.loadState();
    if (snapshot && (snapshot.status === "ready" || snapshot.status === "blocked" || snapshot.status === "failed")) {
        ledger.appendEvent("resume_terminal", { status: snapshot.status });
    }

    let current: DeveloperState = initialDeveloperState({
        projectId: o.projectId,
        taskId: o.taskId,
        runId,
        projectDir: o.projectDir,
        allowedRoots: o.allowedRoots,
        ...(snapshot ? {
            repairAttempts: snapshot.repairAttempts,
            failureSignatures: snapshot.failureSignatures,
            changedFiles: snapshot.changedFiles,
            llmCallsCompleted: snapshot.llmCalls,
        } : {}),
    });

    const persist = (s: DeveloperState): void => {
        ledger.saveState({
            taskId: s.taskId, status: s.status,
            repairAttempts: s.repairAttempts,
            failureSignatures: s.failureSignatures,
            changedFiles: s.changedFiles,
            llmCalls: s.llmCallsCompleted,
        });
    };

    const acceptArchitectTask = async (task: ArchitectTask): Promise<DeveloperState> => {
        // ★ 身份校验（规格八）：任务必须与入口配置同一身份，否则拒绝执行
        if (task.projectId !== o.projectId || task.taskId !== o.taskId) {
            const why = `身份不匹配：入口 ${o.projectId}/${o.taskId}，任务 ${task.projectId}/${task.taskId}`;
            ledger.appendEvent("identity_mismatch", {
                expected: `${o.projectId}/${o.taskId}`, got: `${task.projectId}/${task.taskId}`,
            });
            adapter.send(o.targets?.architect ?? "architect", {
                type: "developer_failed", projectId: o.projectId, taskId: o.taskId, error: why,
            });
            const rejected: DeveloperState = { ...current, status: "failed", error: why };
            current = rejected;
            persist(rejected);
            return rejected;
        }

        // 终态短路：已完成（ready/blocked/failed/cancelled）的任务不重跑
        const prior = ledger.loadState();
        if (prior && (prior.status === "ready" || prior.status === "blocked"
            || prior.status === "failed" || prior.status === "cancelled")) {
            ledger.appendEvent("skip_completed_task", { status: prior.status });
            return {
                ...current,
                status: prior.status as DeveloperStatus,
                repairAttempts: prior.repairAttempts,
                failureSignatures: prior.failureSignatures,
                changedFiles: prior.changedFiles,
                llmCallsCompleted: prior.llmCalls,
            };
        }

        const cp = ledger.latestCheckpoint();

        // ★ 规格三：没有隔离后端就**不执行**。
        //   严格模式下本机既没有容器也没有显式 soft 授权 → 不给 LLM 任何机会，
        //   直接 blocked 并上报 SANDBOX_UNAVAILABLE（绝不在宿主机裸跑任意命令）。
        const caps = workspace.sandboxCapabilities;
        if (!caps.realIsolation && !caps.softIsolation) {
            const reason = `[SANDBOX_UNAVAILABLE] 没有可用的隔离后端（mode=${caps.mode}, backend=${caps.backend}）：`
                + caps.reasons.join("；");
            ledger.appendEvent("sandbox_unavailable", {
                mode: caps.mode, backend: caps.backend, reasons: caps.reasons,
            });
            adapter.send(o.targets?.architect ?? "architect", {
                type: "developer_failed", projectId: task.projectId, taskId: task.taskId, error: reason,
            });
            const blocked: DeveloperState = {
                ...current, status: "blocked", error: reason,
            };
            current = blocked;
            persist(blocked);
            return blocked;
        }
        if (caps.softIsolation) {
            // soft 是显式选择，但必须留痕：它不是隔离，别被读成"已经隔好了"
            ledger.appendEvent("sandbox_soft_mode", {
                mode: caps.mode, backend: caps.backend, limitations: caps.limitations,
            });
        }

        const initial = initialDeveloperState({
            projectId: task.projectId,
            taskId: task.taskId,
            runId,
            projectDir: o.projectDir,
            allowedRoots: task.allowedRoots,
            requirementSnapshot: task.requirementSnapshot,
            stackProfile: task.stackProfile,
            domainModel: task.domainModel,
            contract: task.contract,
            foundationPlan: task.foundationPlan,
            developerInstructions: task.developerInstructions,
            messages: [task],
            repairAttempts: prior?.repairAttempts ?? 0,
            failureSignatures: prior?.failureSignatures ?? [],
            changedFiles: prior?.changedFiles ?? [],
            llmCallsCompleted: prior?.llmCalls ?? 0,
            maxRepairAttempts: o.maxRepairAttempts ?? 2,
            status: "received",
            // 崩溃恢复：有 checkpoint 就从它记录的下一节点接着跑（不重跑已完成阶段）
            resumeFrom: cp?.resumeNode ?? null,
            correlationId: cp?.correlationId ?? null,
        });

        ledger.appendEvent("run_start", { projectId: task.projectId, taskId: task.taskId });
        // 本任务每次真正开跑前先清一次遗留进程：崩溃重启后端口不会被上个进程占着
        const stale = await workspace.cleanupTaskProcesses(o.taskId);
        if (stale > 0) {
            ledger.appendEvent("task_processes_cleaned", { count: stale, phase: "run_start" });
        }
        try {
            const finalState = await graph.invoke(initial, { recursionLimit }) as DeveloperState;
            current = finalState;
            persist(finalState);
            ledger.appendEvent("run_end", { status: finalState.status });
            return finalState;
        } catch (e) {
            const error = (e as Error).message ?? String(e);
            adapter.send(o.targets?.architect ?? "architect", {
                type: "developer_failed", projectId: task.projectId, taskId: task.taskId, error,
            });
            ledger.appendEvent("run_failed", { error });
            const failed: DeveloperState = { ...initial, status: "failed", error };
            current = failed;
            persist(failed);
            return failed;
        } finally {
            ledger.appendEvent("run_finally", {
                llmCallsPlanned: current.llmCallsPlanned,
                llmCallsCompleted: current.llmCallsCompleted,
                status: current.status,
            });
            // 规格三.9：任务结束（无论 ready / blocked / failed）都要清掉长驻进程
            const killed = await workspace.cleanupTaskProcesses(o.taskId);
            ledger.appendEvent("task_processes_cleaned", { count: killed, phase: "run_finally" });
        }
    };

    const serveOnce = async (): Promise<DeveloperState | null> => {
        const res: ReceiveResult = await adapter.receive();
        if (res.status !== "message") return null;
        if (res.message.type !== "architect_task") {
            ledger.appendEvent("ignored_message", { type: res.message.type });
            return null;
        }
        return acceptArchitectTask(res.message);
    };

    /**
     * 测试消息到达后的恢复入口（规格三 / 十一）：
     * 校验 sender + 身份 + correlationId + acceptanceHash，通过后从 handleTestResult 恢复，
     * **不重跑开发与构建**。
     */
    const resumeFromTestMessage = async (
        msg: InboundMessage, sender: string,
    ): Promise<DeveloperState | "rejected"> => {
        const prior = ledger.loadState();
        const cp = ledger.latestCheckpoint();

        if (!prior) {
            ledger.appendEvent("resume_rejected", { reason: "没有任务快照" });
            return "rejected";
        }
        if (prior.status !== "waiting_test") {
            ledger.appendEvent("resume_rejected", { reason: `当前状态 ${prior.status} 不接受测试消息` });
            return "rejected";
        }
        if (msg.type !== "test_passed" && msg.type !== "test_failure") {
            ledger.appendEvent("resume_rejected", { reason: `不是测试结果消息：${msg.type}` });
            return "rejected";
        }

        // 等待窗口是权威来源（requestTest 落库的）；checkpoint 只是兜底
        const wait = ledger.getTestWait();
        const correlationId = wait?.correlationId ?? cp?.correlationId ?? current.correlationId ?? "";
        const acceptanceHash = wait?.acceptanceHash ?? cp?.contextHash ?? "";
        const deadlineAt = wait?.deadlineAt ?? current.testDeadlineAt ?? null;

        // 规格三.10：超过截止时刻到达的测试消息一律拒绝（外部 scheduler 可据此判 blocked）
        if (deadlineAt !== null && isTestWaitExpired({ testDeadlineAt: deadlineAt })) {
            ledger.appendEvent("resume_rejected", {
                reason: "测试等待已过期", from: sender, deadlineAt, now: Date.now(),
            });
            return "rejected";
        }

        const trust: TestTrustContext = {
            trustedSenders: o.trustedTestAgents ?? [],
            projectId: o.projectId,
            taskId: o.taskId,
            runId,
            correlationId,
            acceptanceHash,
        };
        const verdict = msg.type === "test_passed"
            ? validateTestPassed(msg, sender, trust)
            : validateTestFailure(msg, sender, trust);
        if (!verdict.ok) {
            ledger.appendEvent("resume_rejected", { type: msg.type, from: sender, reasons: verdict.reasons });
            return "rejected";
        }

        const resumed = initialDeveloperState({
            ...current,
            status: "waiting_test",
            correlationId,
            resumeFrom: "handleTestResult",
            messages: [msg],
        });
        ledger.appendEvent("resume_from_test", { type: msg.type, from: sender, correlationId });
        current = resumed;
        try {
            const finalState = await graph.invoke(resumed, { recursionLimit }) as DeveloperState;
            // 等待窗口关闭——但**仅当本次恢复没有又开一个新窗口**。9/12 T2 实弹 bug：
            // test_failure → handleTestResult 清窗 → repair → runLocalChecks → requestTest
            // 重新 openTestWait 后图才返回；这里无条件 clear 会把新一轮的窗口抹掉，
            // 外部 TestAgent 再回消息就永远"没有等待窗口"被拒。
            if (finalState.status !== "waiting_test") {
                ledger.clearTestWait();
            }
            current = finalState;
            persist(finalState);
            return finalState;
        } catch (e) {
            const error = (e as Error).message ?? String(e);
            ledger.appendEvent("resume_failed", { error });
            const failed: DeveloperState = { ...resumed, status: "failed", error };
            current = failed;
            persist(failed);
            return failed;
        }
    };

    /** 规格十一：显式取消。任何非终态都可取消；终态幂等返回原状态 */
    const cancelTask = async (reason = "外部取消"): Promise<DeveloperState> => {
        const prior = ledger.loadState();
        if (prior && (prior.status === "ready" || prior.status === "blocked"
            || prior.status === "failed" || prior.status === "cancelled")) {
            ledger.appendEvent("cancel_ignored_terminal", { status: prior.status });
            return { ...current, status: prior.status as DeveloperStatus };
        }
        const from = prior?.status ?? current.status;
        ledger.appendEvent("task_cancelled", { from, reason });
        ledger.clearTestWait();
        // 取消也要清进程，否则服务会一直挂在后台占端口（规格三.9）
        const killed = await workspace.cleanupTaskProcesses(o.taskId, "cleanup");
        ledger.appendEvent("task_processes_cleaned", { count: killed, phase: "cancel" });
        const cancelled: DeveloperState = { ...current, status: "cancelled", error: reason };
        adapter.send(o.targets?.architect ?? "architect", {
            type: "developer_failed", projectId: o.projectId, taskId: o.taskId,
            error: `任务已取消：${reason}`,
        });
        current = cancelled;
        persist(cancelled);
        return cancelled;
    };

    /**
     * 验收未执行完 → 落 blocked_unverified。
     *
     * 用途：外部 TestAgent 跑完一轮，如果有验收项**根本没被执行**（如意图式 CONTRACT
     * 没有执行器），那这一轮既不是通过、也不是"被测代码失败"——不许发 test_passed，
     * 也不该走 test_failure 修复回路（没证据可修）。唯一诚实的落点就是这个。
     * 终态（ready/blocked/failed/cancelled）幂等返回，不覆盖既有结论。
     */
    const blockUnverified = async (detail: {
        reason: string;
        skipped?: { checkId: string; kind: string; reason: string }[];
    }): Promise<DeveloperState> => {
        const prior = ledger.loadState();
        if (prior && (prior.status === "ready" || prior.status === "blocked"
            || prior.status === "failed" || prior.status === "cancelled")) {
            ledger.appendEvent("block_unverified_ignored_terminal", { status: prior.status });
            return { ...current, status: prior.status as DeveloperStatus };
        }
        const skipped = detail.skipped ?? [];
        const error = `[BLOCKED_UNVERIFIED] ${detail.reason}`;
        ledger.appendEvent("blocked_unverified", {
            reason: detail.reason,
            skipped: skipped.map((s) => ({ checkId: s.checkId, kind: s.kind })),
            acceptedAsVerified: false,
        });
        ledger.clearTestWait();
        const killed = await workspace.cleanupTaskProcesses(o.taskId, "cleanup");
        ledger.appendEvent("task_processes_cleaned", { count: killed, phase: "blocked_unverified" });
        adapter.send(o.targets?.architect ?? "architect", {
            type: "developer_blocked", projectId: o.projectId, taskId: o.taskId,
            reason: error, failureSignature: null,
        });
        const blocked: DeveloperState = { ...current, status: "blocked", error };
        current = blocked;
        persist(blocked);
        return blocked;
    };

    /** 规格十一：只读视图。外部 scheduler 用 testWaitOverdue 决定是否判 blocked */
    const inspectTaskState = () => {
        const wait = ledger.getTestWait();
        const cp = ledger.latestCheckpoint();
        const snap = ledger.loadState();
        const status = snap?.status ?? current.status;
        const deadlineAt = wait?.deadlineAt ?? current.testDeadlineAt;
        const doneItems = current.completedWorkItems;
        return {
            taskId: o.taskId,
            runKey: ledger.runKey,
            status,
            correlationId: wait?.correlationId ?? current.correlationId,
            testDeadlineAt: deadlineAt,
            testWaitOverdue: deadlineAt !== null && isTestWaitExpired({ testDeadlineAt: deadlineAt }),
            repairAttempts: snap?.repairAttempts ?? current.repairAttempts,
            failureSignatures: snap?.failureSignatures ?? current.failureSignatures,
            changedFiles: snap?.changedFiles ?? current.changedFiles,
            llmCallsPlanned: current.llmCallsPlanned,
            llmCallsCompleted: current.llmCallsCompleted,
            toolCalls: current.toolCalls,
            /** 已发起的只读子 Agent 调用数（含失败/超时——占名额不归还，成本可见） */
            subagentCalls: ledger.subagentCallCount(),
            workItems: current.workItems.map((w) => ({
                id: w.id, kind: w.kind, done: doneItems.includes(w.id),
            })),
            lastCheckpoint: cp ? { node: cp.node, phase: cp.phase, resumeNode: cp.resumeNode } : null,
            activeProcesses: workspace.sandbox.activeCount(o.taskId),
            sandbox: {
                mode: workspace.sandboxCapabilities.mode,
                backend: workspace.sandboxCapabilities.backend,
                realIsolation: workspace.sandboxCapabilities.realIsolation,
                softIsolation: workspace.sandboxCapabilities.softIsolation,
            },
        };
    };

    return {
        adapter, workspace, ledger, tools,
        run: ({ task }) => acceptArchitectTask(task),
        acceptArchitectTask,
        serveOnce,
        resumeFromTestMessage,
        cancelTask,
        blockUnverified,
        inspectTaskState,
        /** 只读沙箱能力视图：外部（Orchestrator / 看板）据此判断"能不能真的干活" */
        sandboxCapabilities: () => workspace.sandboxCapabilities,
        /** 异步收尾：清掉全部遗留进程再关账本 */
        shutdown: async () => {
            const killed = await workspace.cleanupAllProcesses();
            ledger.appendEvent("agent_shutdown", { killedProcesses: killed });
            ledger.close();
        },
        close: () => {
            // 同步接口保险起见仍然清一次（fire-and-forget）；要确定性请在退出前 await shutdown()
            void workspace.cleanupAllProcesses();
            ledger.close();
        },
    };
}

export { HubAdapter, DEVELOPER_NAME } from "./hubAdapter";
export { Workspace, WorkspaceViolation } from "./workspace";
export { DeveloperLedger } from "./ledger";
export { buildDeveloperGraph, runToolLoop } from "./graph";
export type { DeveloperLlm, DeveloperState };
// 只读子 Agent 统一接口（分析建议层——写盘与决策永远在 Developer 主 Agent）
export {
    READONLY_SUBAGENT_ROLES, createReadonlySubAgentDispatcher,
    finalizeReadonlySubAgentResult, subagentFailureStruct, subagentCapabilities,
} from "./tools/readonlySubAgent";
export type {
    ReadonlySubAgentRole, ReadonlySubAgentRequest, ReadonlySubAgentResult, SubagentOutcome,
    ReadonlySubAgentLlm,
} from "./tools/readonlySubAgent";
