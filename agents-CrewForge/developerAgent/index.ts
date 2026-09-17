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
import { initialDeveloperState, isTestWaitExpired, nextUnarrivedWorkItem } from "./state";
import type { DeveloperState, DeveloperStatus } from "./state";
import {
    ArchitectBatchSchema, acceptanceHashOf, deriveWorkItems,
    validateTestFailure, validateTestPassed,
} from "./protocol";
import type { AcceptanceCheck, ArchitectBatch, ArchitectTask, InboundMessage, TestTrustContext } from "./protocol";

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
    /**
     * 终态抄送站（9/15 团队线）：developer_blocked/developer_failed 除按 targets 路由外
     * 另投此站一份——团队线里 sys_task 记账/收敛在 maintainer，而默认 targets 只回 architect。
     * 不传 = 旧行为（hub-runner / 存量测试逐字节不变）。
     */
    copyTerminalsTo?: string;
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
    /**
     * 分批模式（9/15「拆出一个推一个」）：true = 蓝图先行、架构师逐工作项推批，
     * 有未达项时图停 in waitBatch（waiting_item）不送检。
     * 默认 false = 存量一步整包链路（--task / hub-runner / 旧任务包）逐字节不变。
     */
    batched?: boolean;
}

export interface DeveloperAgentHandle {
    readonly adapter: HubAdapter;
    readonly workspace: Workspace;
    readonly ledger: DeveloperLedger;
    readonly tools: ToolRegistry;
    /** 跑一个 ArchitectTask 到终态（或从 Ledger 恢复后的终态）；等价于 acceptArchitectTask */
    run(input: { task: ArchitectTask }): Promise<DeveloperState>;
    /**
     * 规格十一接入接口：接收架构师任务（含 schema 与身份校验）。
     * seedBatches（9/15 分批）= 蓝图之后**已到批**的重播种（首跑必含 w1，否则 w1 裸跑；
     * 崩溃重放则把 `_tasks/` 里已落盘的批次全量重喂）。校验不过直接 throw——绝不静默丢。
     */
    acceptArchitectTask(task: ArchitectTask, seedBatches?: ArchitectBatch[]): Promise<DeveloperState>;
    /** 阻塞从 Hub 收一条消息并按类型驱动（architect_task / architect_batch / test_*；见 serveOnce 注释） */
    serveOnce(): Promise<DeveloperState | "rejected" | null>;
    /** 测试消息到达后的恢复入口（校验信任链后从 handleTestResult 继续） */
    resumeFromTestMessage(msg: InboundMessage, sender: string): Promise<DeveloperState | "rejected">;
    /**
     * 分批模式（9/15）：架构师批次到达的恢复入口（仿 resumeFromTestMessage 的闸门序列：
     * 快照存在 → status=waiting_item → 消息是 architect_batch → 身份对上 → **严格在序**
     * （itemId 必须是首个未达项）。通过后从 acceptBatch 节点复活，不重跑已完成阶段。
     */
    resumeWithBatch(msg: InboundMessage): Promise<DeveloperState | "rejected">;
    /**
     * 整次作废（9/15）：某批连拒三次等场景由驱动方调它收口——仿 blockUnverified：
     * 终态幂等、清进程、留痕 run_aborted、落 blocked 并发 developer_blocked。故意做钝：
     * 不判断 reason，作废与否是调用方（runner / Orchestrator）的权威决定。
     */
    abortRun(reason: string): Promise<DeveloperState>;
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
        /** arrived（9/15 分批）：该项批次是否已到——等批看板与 runner 驱动循环都读它 */
        workItems: { id: string; kind: string; done: boolean; arrived: boolean }[];
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

/**
 * 验收判据按 id 去重、**先到者胜**（9/15 分批）：种子合并与崩溃重放共用的唯一口径，
 * 与 graph.ts 的 mergeArchitectBatch 语义一致——同一批喂两遍 = 喂一遍（幂等），
 * hash 才不会在重放后漂移（TestPassed 的 acceptanceHash 核对依赖这个稳定性）。
 */
function dedupeChecksById(checks: AcceptanceCheck[]): AcceptanceCheck[] {
    const out: AcceptanceCheck[] = [];
    const seen = new Set<string>();
    for (const c of checks) {
        const id = String((c as { id?: unknown }).id ?? "");
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(c);
    }
    return out;
}

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
    const adapter = new HubAdapter({
        station, ledger, trustedTestAgents: o.trustedTestAgents ?? [],
        ...(o.copyTerminalsTo ? { copyTerminalsTo: o.copyTerminalsTo } : {}),
    });

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

    const acceptArchitectTask = async (
        task: ArchitectTask, seedBatches?: ArchitectBatch[],
    ): Promise<DeveloperState> => {
        // ★ 种子批校验（9/15 分批，计划点名的"w1 不许裸跑"修复 + 崩溃重放入口）：
        //   发生在任何副作用之前，校验不过直接 throw——绝不静默丢（"我以为传了、其实没传"
        //   是最难查的一类断链，与 protocol 里 detail 必须显式入 schema 同一道理）。
        //   闸都在代码侧：形状走 ArchitectBatchSchema；身份对齐蓝图；itemId ∈ 蓝图工作项；
        //   **严格沿蓝图序推进（pos===k）**——乱序 / 重复 / 跳批一个都进不来（前缀闭合，
        //   这正是 resumeWithBatch 在序闸立法过的同一件事的种子版）。
        const seeds = seedBatches ?? [];
        const seedMsgs: ArchitectBatch[] = [];
        if (seeds.length > 0) {
            const blueprintIds = deriveWorkItems(task.foundationPlan ?? null).map((w) => w.id);
            for (let k = 0; k < seeds.length; k++) {
                const parsed = ArchitectBatchSchema.safeParse(seeds[k]);
                if (!parsed.success) {
                    throw new Error(`种子批 #${k} 不是合法 architect_batch：${parsed.error.message}`);
                }
                const b = parsed.data;
                if (b.projectId !== task.projectId || b.taskId !== task.taskId) {
                    throw new Error(
                        `种子批 #${k} 身份与蓝图不匹配：批 ${b.projectId}/${b.taskId}，`
                        + `蓝图 ${task.projectId}/${task.taskId}`,
                    );
                }
                const pos = blueprintIds.indexOf(b.itemId);
                if (pos < 0) {
                    throw new Error(`种子批 #${k} 的 itemId 不在蓝图工作项里：${b.itemId}`);
                }
                if (pos !== k) {
                    throw new Error(
                        `种子批 #${k} 不按蓝图顺序推进：期望 ${blueprintIds[k]}，实际 ${b.itemId}`
                        + "（乱序 / 重复 / 跳批一律拒绝）",
                    );
                }
                seedMsgs.push(b);
            }
        }
        // 种子合并进任务副本（与图内 acceptBatch 节点同一套"按 id 去重、先到者胜"语义）：
        // 蓝图项带上 detail、全局底线判据在前、竖切判据按批序跟进。旧链路（无种子）逐字节不变。
        const batched = (o.batched ?? false) || seedMsgs.length > 0;
        const runTask: ArchitectTask = seedMsgs.length > 0
            ? {
                ...task,
                foundationPlan: {
                    ...(task.foundationPlan ?? { dirs: [] }),
                    workItems: deriveWorkItems(task.foundationPlan ?? null).map((w) => {
                        const hit = seedMsgs.find((s) => s.itemId === w.id);
                        return hit ? { ...w, detail: hit.detail } : w;
                    }),
                },
                acceptanceChecks: dedupeChecksById([
                    ...(task.acceptanceChecks ?? []),
                    ...seedMsgs.flatMap((s) => s.checks ?? []),
                ]),
            }
            : task;

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

        // 分批模式的蓝图字段预填（batched=false 时整段短路，旧链路逐字节不变）：
        // 崩溃重放的 resumeFrom 可能是 receiveTask 之后的节点（那时 receiveTask 不会重跑，
        // workItems / acceptanceChecks 就只能靠这里预填）；receiveTask 若照常跑，
        // 覆盖的是同一份合并后的值——幂等，零扰动。
        const batchedBlueprint = deriveWorkItems(runTask.foundationPlan ?? null);
        const initial = initialDeveloperState({
            projectId: runTask.projectId,
            taskId: runTask.taskId,
            runId,
            projectDir: o.projectDir,
            allowedRoots: runTask.allowedRoots,
            requirementSnapshot: runTask.requirementSnapshot,
            stackProfile: runTask.stackProfile,
            domainModel: runTask.domainModel,
            contract: runTask.contract,
            foundationPlan: runTask.foundationPlan,
            developerInstructions: runTask.developerInstructions,
            messages: [runTask],
            repairAttempts: prior?.repairAttempts ?? 0,
            failureSignatures: prior?.failureSignatures ?? [],
            changedFiles: prior?.changedFiles ?? [],
            llmCallsCompleted: prior?.llmCalls ?? 0,
            maxRepairAttempts: o.maxRepairAttempts ?? 2,
            status: "received",
            // 崩溃恢复：有 checkpoint 就从它记录的下一节点接着跑（不重跑已完成阶段）。
            // 例外——带种子的分批重放：种子 = "蓝图 + 已到批"全量输入，必须从 receiveTask
            // 整体重入；若沿用 cp.resumeNode（如 acceptBatch），消息里没有可收割的批次，
            // 只会命中 acceptBatch 防御分支原地回等待态，永远续不起来。重复写盘由
            // Ledger 指纹缓存挡（恢复语义与旧链路同一套）。
            resumeFrom: seedMsgs.length > 0 ? null : (cp?.resumeNode ?? null),
            correlationId: cp?.correlationId ?? null,
            ...(batched ? {
                batched: true,
                arrivedItems: seedMsgs.map((b) => b.itemId),
                workItems: batchedBlueprint,
                acceptanceChecks: runTask.acceptanceChecks ?? [],
                acceptanceHash: acceptanceHashOf(runTask.acceptanceChecks ?? []),
                currentWorkItemId: batchedBlueprint[0]?.id ?? null,
            } : {}),
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

    /**
     * 状态窗口判决（9/15 Hub 流式分发的坑）：架构师连续推批、开发状态在
     * waiting_item ↔ waiting_test 之间切换——waiting_test 时吃到 architect_batch，
     * resumeWithBatch 的闸门会拒绝并且**消息被幂等账本烧掉**（重发也算重复），
     * 流就死了。所以 serveOnce 吃消息前先看当前状态：
     * "属于以后窗口"的进停车队列（parked），到窗口再取用。
     * 这里只判状态窗口；itemId 在序性/身份/过期等判决**仍在各 resume 闸门手里**
     * （单一事实源不搬动，停车不改变任何闸门语义）。
     */
    /** 停放队列：形状合法但状态窗口未到的消息（handle 生命周期=一个任务，队列至多几批深） */
    const parked: { message: InboundMessage; sender: string }[] = [];

    const fitsCurrentStatus = (msg: InboundMessage): boolean => {
        const st = ledger.loadState()?.status ?? null;
        if (msg.type === "architect_task") {
            // 新任务只在没接活或上一任务已定论时可入（本 handle 生命周期=一任务，
            // 跨任务由驱动方重建 handle；这里放行到闸门去吃明确的拒绝）
            return st === null || st === "ready" || st === "blocked" || st === "failed";
        }
        if (msg.type === "architect_batch") return st === "waiting_item";
        if (msg.type === "test_passed" || msg.type === "test_failure") return st === "waiting_test";
        if (msg.type === "cancel_task") {
            // 有在途运行才有可停之物；没接活/已定论直接放行到 ignored 留痕（终态幂等）
            return st !== null && st !== "ready" && st !== "blocked" && st !== "failed";
        }
        return true;   // repair_requested / resume_task：不拦，直接落 ignored_message 留痕
    };

    /** 路由表（serveOnce 的"到窗即办"半部）：类型 → 驱动入口，判决在各方闸门内部 */
    const dispatchMessage = async (
        msg: InboundMessage, sender: string,
    ): Promise<DeveloperState | "rejected" | null> => {
        if (msg.type === "architect_task") return acceptArchitectTask(msg);
        if (msg.type === "architect_batch") return resumeWithBatch(msg);
        if (msg.type === "test_passed" || msg.type === "test_failure") {
            return resumeFromTestMessage(msg, sender);
        }
        if (msg.type === "cancel_task") {
            // 架构师作废（批次 3 连拒整次作废时经 Hub 送达）→ 停在半途的运行收口
            ledger.appendEvent("cancel_accepted", { projectId: msg.projectId, reason: msg.reason ?? null });
            return abortRun(`ARCHITECT_CANCELLED: ${msg.reason ?? `${msg.projectId} 未给原因`}`);
        }
        ledger.appendEvent("ignored_message", { type: msg.type });
        return null;
    };

    /**
     * 从 Hub 收一条消息并驱动图（9/15 分批管线：架构师↔开发**全部过消息总线**）。
     * 停车队列见 fitsCurrentStatus；返回 "rejected" = 消息形状合法但驱动闸门拒绝
     * （乱序批、伪造 sender、过期测试结果）——驱动方必须看见它并收口，
     * 不能吞掉继续等（下一条消息救不了当前停摆）。
     */
    const serveOnce = async (): Promise<DeveloperState | "rejected" | null> => {
        for (; ;) {
            // 每轮从头扫一遍停放队列找"到窗"的（findIndex 保 FIFO：同类型批次的
            // 相对序=入队序，前序批未到窗时后面的同样被跳过——顺序判决仍在 resumeWithBatch）
            const i = parked.findIndex((h) => fitsCurrentStatus(h.message));
            if (i >= 0) {
                const held = parked.splice(i, 1)[0]!;   // i 来自 findIndex，必有元素
                return dispatchMessage(held.message, held.sender);
            }
            const res: ReceiveResult = await adapter.receive();
            if (res.status !== "message") return null;   // invalid/duplicate：不消费内容，等下一条
            if (!fitsCurrentStatus(res.message)) {
                // 只进队列不打烧：receive 的幂等键已记 seen——同一条重投本来就该按
                // duplicate 拦，停放的是**新消息**，不存在"重发救活"的语义损失
                parked.push({ message: res.message, sender: res.sender });
                ledger.appendEvent("message_parked", { type: res.message.type, sender: res.sender });
                continue;   // 新消息入队后重扫一遍（也许正好让别的到窗——成本 O(n)，n≤批数）
            }
            return dispatchMessage(res.message, res.sender);
        }
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

    /**
     * 分批模式（9/15）：架构师批次到达的恢复入口——resumeFromTestMessage 的镜像闸门：
     *   ① 必须有任务快照且 status=waiting_item（其他状态不接受批，防止拿批乱推状态）；
     *   ② 消息必须是 architect_batch 且身份对上（协议只管形状，这里管投递合法性）；
     *   ③ **严格在序**：itemId 必须等于首个未达项——乱序 / 跳批拒绝（9/15 拍板②）；
     *     **已到重投例外**（9/16 p20 补）：批到过后又被原样推一遍 = 重复确认，
     *     留 batch_duplicate_ignored 原地返回——acceptBatch 合并本就幂等，
     *     把它判成协议异常会连累整次跑作废（信封种子批与拆分流各发一次 w1 的惨案）。
     *     （前缀闭合仍由该闸维护：被忽略的重投不产生任何状态移动。）
     * 通过后与测试恢复同一个重注入形状：消息进 messages、从 acceptBatch 节点复活，
     * 不重跑已完成阶段；判据合并与 hash 重算全在图内 acceptBatch 节点做。
     */
    const resumeWithBatch = async (msg: InboundMessage): Promise<DeveloperState | "rejected"> => {
        const prior = ledger.loadState();
        if (!prior) {
            ledger.appendEvent("batch_rejected", { reason: "没有任务快照" });
            return "rejected";
        }
        if (prior.status !== "waiting_item") {
            // 特别地，waiting_test 之后不接受批：送过检 acceptanceHash 必须冻结
            ledger.appendEvent("batch_rejected", {
                reason: `当前状态 ${prior.status} 不接受批次`, itemId: "itemId" in msg ? msg.itemId : null,
            });
            return "rejected";
        }
        if (msg.type !== "architect_batch") {
            ledger.appendEvent("batch_rejected", { reason: `不是架构师批次消息：${msg.type}` });
            return "rejected";
        }
        if (msg.projectId !== o.projectId || msg.taskId !== o.taskId) {
            ledger.appendEvent("batch_rejected", {
                reason: `身份不匹配：入口 ${o.projectId}/${o.taskId}，批次 ${msg.projectId}/${msg.taskId}`,
            });
            return "rejected";
        }
        // 已到重投（itemId 已进 arrived/completed）：幂等忽略，不进乱序闸、不作废。
        // 放在身份闸之后、在序闸之前——只有"形状与身份都对"的批才配被忽略。
        if (current.arrivedItems.includes(msg.itemId)
            || current.completedWorkItems.includes(msg.itemId)) {
            ledger.appendEvent("batch_duplicate_ignored", { itemId: msg.itemId });
            return current;
        }
        const expected = nextUnarrivedWorkItem(current);
        if (msg.itemId !== (expected?.id ?? "")) {
            ledger.appendEvent("batch_rejected", {
                reason: `乱序投递拒绝：期望 ${expected?.id ?? "（无未达项）"}，实际 ${msg.itemId}`,
                itemId: msg.itemId,
            });
            return "rejected";
        }
        ledger.appendEvent("batch_applied", { itemId: msg.itemId, checks: msg.checks.length });
        const resumed = initialDeveloperState({
            ...current,
            status: "waiting_item",
            resumeFrom: "acceptBatch",
            messages: [msg],
        });
        current = resumed;
        try {
            const finalState = await graph.invoke(resumed, { recursionLimit }) as DeveloperState;
            current = finalState;
            persist(finalState);
            return finalState;
        } catch (e) {
            const error = (e as Error).message ?? String(e);
            ledger.appendEvent("resume_failed", { error, phase: "batch" });
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

    /**
     * 整次作废（9/15 分批，计划拍板"第 i 项 3 次重试全拒 → 整次作废"）：
     * 驱动方（runner）在批次连拒后停发新批、等当前 invoke 到 END，然后调它收口——
     * 终态 blocked + developer_blocked 报告 + run_aborted 留痕 + 清进程，全仿 blockUnverified。
     * 故意做钝：不看 reason 的内容，作废与否是外部权威决定，这里只负责把它落得干干净净。
     */
    const abortRun = async (reason: string): Promise<DeveloperState> => {
        const prior = ledger.loadState();
        if (prior && (prior.status === "ready" || prior.status === "blocked"
            || prior.status === "failed" || prior.status === "cancelled")) {
            ledger.appendEvent("abort_run_ignored_terminal", { status: prior.status });
            return { ...current, status: prior.status as DeveloperStatus };
        }
        const error = `[ABORTED] ${reason}`;
        ledger.appendEvent("run_aborted", { reason });
        ledger.clearTestWait();
        const killed = await workspace.cleanupTaskProcesses(o.taskId, "cleanup");
        ledger.appendEvent("task_processes_cleaned", { count: killed, phase: "run_aborted" });
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
        const arrived = current.arrivedItems;
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
                arrived: arrived.includes(w.id),   // 分批看板：批到没到（计划风险#2 的廉价补强）
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
        resumeWithBatch,
        cancelTask,
        blockUnverified,
        abortRun,
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
