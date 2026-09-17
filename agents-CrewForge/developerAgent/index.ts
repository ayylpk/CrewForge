// ============================================================
// index.ts —— developerAgent 对外入口
//
//   装配关系（一眼可读）：
//     Workspace（唯一写盘闸门）
//        ↓ 注入
//     ToolRegistry（核心 10 + 扩展 9 = 19 个工具只能从这里调）
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
// 问人（9/17）：问答器三分流（Web / stdin / 自动）复用确认门那套，不另造通道
import { pickQuestioner } from "../confirm";
import { HubAdapter } from "./hubAdapter";
import type { ReceiveResult } from "./hubAdapter";
import { DeveloperLedger, ensureDir, hashOf } from "./ledger";
import { buildDeveloperGraph } from "./graph";
import type { DeveloperGraphDeps, DeveloperLlm, DeveloperTargets } from "./graph";
// 上下文压缩接线（9/17）：模型名从客户端 id 反解（见那里的注释：env 可能是另一套配置）
import { modelNameFromLlmId, resolveWiredContextWindow } from "./contextCompaction";
import type { ContextBudgetOption } from "./contextCompaction";
import type { ContextWindowSpec } from "./contextBudget";
// ★ 档位与模型名的**唯一真相**在 models.ts（T3 分档：sys_settings.role_models + 内置表；
//   pro 档模型名 `deepseek-v4-pro[1m]` 与 flash 档差一个数量级）。这里只借用这两样：
import { resolveRoleTier } from "../models";
import type { RoleTier } from "../models";
// 运行时设置（sys_settings 单行表，30s TTL 热重载）。读不到/列没建 → 回落下一步，绝不抛。
import { runtimeSettings } from "../settings";
import type { RtSettings } from "../settings";
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
// 召唤真工位（9/17 拓扑升级·层 B）：协议 + 事件名 + 工位座位名表
import { CONSULT_EVENTS, CONSULT_STATION_NAMES, newConsultId, parseConsultReply } from "../consult";
import type { ConsultReply, ConsultRequest, ConsultRole } from "../consult";

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
    /**
     * 整轮墙钟的绝对截止时刻（团队线 developerTeamRunner 注入，见 developerAgent/brake.ts）。
     * 只用于**夹等待窗口**（请求验收的 deadlineAt 不许晚于整轮墙钟）；不传 = 零行为变化。
     */
    wallClockDeadlineAt?: number;
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
    /**
     * 召唤工位（层 B）的等待时限（毫秒）。默认 90s，**硬夹到 ≤240s**——
     * 240s 是 LLM 普通调用的超时口径（subagentTimeoutMs 的上限同源），
     * 一次召唤不该比一次主调用等得更久。
     *
     *   为什么要时限：工位可能根本没起（消息躺进没人消费的空箱，9/2 阶段1 血泪）。
     *   超时后司机**降级**（返回 null + consult_timeout 事件）而不是挂起——
     *   "等一个永远不会来的回复"是我们明确不许出现的死法。
     */
    consultTimeoutMs?: number;
    /**
     * ★ 9/17 上下文压缩接线的可配项（Claude Code 的压缩机制）。
     *   不传 = 用默认推导（模型名从 `llm.id` 反解 → `sys_settings.model_name/model_pro` →
     *   env；档位走 `resolveRoleTier(role, sys_settings.role_models)`；窗口走
     *   `sys_settings.context_window[_pro]` → 模型名 [1m] → env → 产品默认 256K）——
     *   **引擎默认就是接线的**，因为"防越窗"不是可选功能。
     *   传值只用于覆盖：角色/档位/模型名，以及"这次不接线"（disabled）。
     */
    contextBudget?: ContextBudgetOption & {
        disabled?: boolean;
        /** 本工位在 T3 档位表里的角色名（backend/frontend/…）；缺省按 DEVELOPER_ROLE_NAME 解析 */
        role?: string;
    };
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
        /**
         * 召唤工位（层 B）读数：发起/答复/超时/被拒/重放次数 + 工位替司机烧掉的
         * LLM 调用数（已计入 llm_call_* 台账）、当前等待时限毫秒。
         */
        consult: {
            requested: number; replied: number; timedOut: number;
            refused: number; replayed: number; llmCalls: number; timeoutMs: number;
        };
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
    /**
     * 层 B（9/17）召唤工位的端口——graph 内 consultStation 工具用的就是它。
     * 为什么要出现在 handle 上：① **可测**（工具循环在模型手里，测试无法直接驱动它，
     * 而"等回复/停车/超时/幂等"这些语义必须被钉住）；② **可编排**（外部 driver
     * 也能问工位，不必绕过模型）。返回 null = 超时降级，**永不抛**。
     * `consultId` 是**显式重放口**：传同一个 id（崩溃重放/重试）会命中历史回复而不重发。
     */
    consultStation(req: {
        role: ConsultRole; question: string; focus?: string[]; consultId?: string;
    }): Promise<ConsultReply | null>;
    close(): void;
}

const DEFAULT_COMMANDS: string[] = [];

/**
 * ★ 把"这一档、这个模型"的上下文窗口解析成 spec——**整条链路只解析这一次**。
 *
 *   为什么必须在装配处解析（而不是在压缩闸内部）：档位要靠 `models.ts` 的
 *   `resolveRoleTier(role, sys_settings.role_models)` + 内置档位表才算得出，而"这个工位是
 *   backend 还是 frontend"只有装配处知道。两处各解析一次 ⇒ 同一个任务可能对"用 1M 还是 256K
 *   算阈值"给出两个答案，那是最难查的一类不一致（数字对不上但没人报错）。
 *
 *   解析优先级（与 `resolveContextWindow` 一致，见 contextCompaction.ts §1）：
 *     ① `sys_settings.context_window_pro`（**仅 pro 档**）→ source: settings-tier
 *     ② `sys_settings.context_window`（全局基准）      → source: settings
 *     ③ 模型名自带 `[1m]`（模型名本身就是声明）        → source: model-suffix
 *     ④ env `CF_CONTEXT_WINDOW_TOKENS`（运维逃生口）   → source: env
 *     ⑤ 产品默认 256_000 + **一行告警** + degraded=true → source: unset-default
 *
 *   模型名怎么定（顺序有意，与 `models.ts:80-99` 的 applyRuntime 合并约定对齐）：
 *     实际在用的客户端（`llm.id`，realLlm 的 id 里带模型名）→ `sys_settings.model_name`
 *     （pro 档再顶一层 `model_pro`）→ env `DEVELOPER_LLM_MODEL`。
 *     ⚠️ 实际客户端排在最前：`dotenv.ts` 的实测教训是"env 可能指向另一套配置"，而按**配置里
 *     写的**模型算窗口、实际却用另一个模型跑，等于凭空假设一个更大的窗口 ⇒ 压缩触发过晚 ⇒
 *     越窗 400（正是这套机制存在的理由）。宁可按实际模型算，也不按"应该用的"算。
 *
 *   安全降级（owner 要求"列还没建时不许抛"）：`runtimeSettings()` 为 null（库没起/表空/
 *   30s 缓存还没填）或窗口列缺失 → `contextWindow/contextWindowPro` 都是 null →
 *   直接落 ③④⑤ 步；**本函数不查库、不 await、不抛异常**（刷新由 runner 的心跳负责）。
 */
export function resolveDeveloperContextWindow(o: {
    /** 实际在用的 LLM 客户端 id（`real:<model>@<baseUrl>[:tools]`） */
    llmId: string;
    /** 本工位在 T3 档位表里的角色名；缺省 "developer" */
    role?: string;
    /** 显式档位（覆盖 role 推导）；null = 明确不分层 */
    tier?: RoleTier | null;
    /** 显式模型名（覆盖一切推导；测试与特例用） */
    model?: string;
    /** 运行时设置（缺省取 `runtimeSettings()`；测试注入假值） */
    rt?: RtSettings | null;
    /** env 注入（测试用） */
    env?: Record<string, string | undefined>;
    /** 告警出口（缺省 console.warn） */
    warn?: (line: string) => void;
}): ContextWindowSpec {
    const rt = o.rt === undefined ? runtimeSettings() : o.rt;
    const role = o.role ?? "developer";
    const tier = o.tier !== undefined ? o.tier : resolveRoleTier(role, rt?.roleModels ?? null);
    // 与 models.ts applyRuntime 同序：全局 model_name 覆盖 → pro 档再顶一层 model_pro
    const configuredModel = tier === "pro" && rt?.modelPro ? rt.modelPro : (rt?.modelName ?? null);
    const env = o.env ?? process.env;
    const model = o.model ?? modelNameFromLlmId(o.llmId) ?? configuredModel ?? env["DEVELOPER_LLM_MODEL"] ?? "";

    return resolveWiredContextWindow({
        model,
        tier,
        settingsWindowTokens: rt?.contextWindow,        // 没读到/列没建 = null = 没配
        settingsWindowProTokens: rt?.contextWindowPro,
        ...(o.env ? { env: o.env } : {}),
        ...(o.warn ? { warn: o.warn } : {}),
    });
}

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

    // 问人（9/17）：问答器三分流（Web / stdin / 自动），
    // 同时供两处使用——模型主动求助（askHuman 工具 → ctx.askHuman）与
    // 保险丝强制升级（escalate 节点 → 外层 invokeWithHuman）。同一条通道、同一套语义。
    const questioner = pickQuestioner(Number(o.projectId));
    // questionId 用 "ask-<taskId>-<序号>"：HttpQuestioner 建题幂等，崩溃续跑不会给人重复塞单子。
    let askSeq = 0;
    const askHumanPort = (req: { question: string; options?: string[] }): Promise<string> =>
        questioner.ask({
            questionId: `ask-${o.taskId}-${++askSeq}`,
            prompt: req.question,
            options: req.options,
        });

    // ============================================================
    // 召唤真工位（9/17 拓扑升级·层 B）—— 司机侧端口
    //
    //   层 A（tools/readonlySubAgent.ts 的 architect-advisor / acceptance-advisor）
    //   只能给**意见**：顾问说"契约与实现不一致"，这句话在流程里没有任何效力。
    //   本端口把问题送回**拥有那件产物**的工位（architect / pm / test-core /
    //   maintainer），拿回意见**或已生效的修订**——补的正是"换脑断层"缺的那一半。
    //
    //   四件事必须在这一处做对（它们都是"曾经真的把流程搞死"的形状）：
    //     ① **不挂起**：超时返回 null + consult_timeout 事件，司机降级为自行决策、
    //        写明假设。工位没起 = 消息躺进没人消费的空箱（9/2 阶段1 血泪），
    //        这里绝不允许"等一个永远不会来的回复"。
    //     ② **不丢消息**：等待回复期间收到的其它消息（架构师批次/测试结果）
    //        进**停车队列**（与 fitsCurrentStatus 的停车同一队列、同一语义），
    //        serveOnce 之后照旧能取到——因为等回复而吞掉一条 architect_batch，
    //        就是把分批管线当场掐死。
    //     ③ **不重复烧**：同一 consultId / 同一问题再来一次 → 复用 Ledger 里的回复，
    //        不重发、不再烧工位 LLM（崩溃重放时最容易踩）。
    //     ④ **不越权**：回复要过 parseConsultReply 的越权闸（kind 与签发方必须匹配），
    //        自称的工位必须等于请求目标——冒名回复整条丢弃。
    // ============================================================

    /** 等待时限：默认 90s，硬夹到 240s（与子 Agent 的 240s 上限同源口径） */
    const CONSULT_TIMEOUT_DEFAULT_MS = 90_000;
    const CONSULT_TIMEOUT_MAX_MS = 240_000;
    const consultTimeoutMs = Math.min(o.consultTimeoutMs ?? CONSULT_TIMEOUT_DEFAULT_MS, CONSULT_TIMEOUT_MAX_MS);

    /**
     * **单一在途收件**（single-flight）。
     *   Hub 的收件箱只有一条队列，两个并发的 waitForMessage 会在同一条消息上一起醒来，
     *   其中一个 shift 到 undefined（收件箱是唯一事实来源，wait 只负责唤醒）——
     *   那条消息既没被消费也没被记账，markDone 却照跑，pendingCount 直接失衡。
     *   所以召唤等待与 serveOnce 共用这**同一个**在途 receive：永远只有一个。
     */
    let inflightReceive: Promise<ReceiveResult> | null = null;
    const receiveOnce = (): Promise<ReceiveResult> => {
        if (!inflightReceive) {
            inflightReceive = adapter.receive().then(
                (r) => { inflightReceive = null; return r; },
                (e) => { inflightReceive = null; throw e; },
            );
        }
        return inflightReceive;
    };

    /** 等到 deadline 或等到一条消息，先到为准（超时定时器是契约本体，结束时 clearTimeout） */
    const raceReceive = async (deadline: number): Promise<{ kind: "reply"; res: ReceiveResult } | { kind: "timeout" }> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                receiveOnce().then((res) => ({ kind: "reply" as const, res })),
                new Promise<{ kind: "timeout" }>((resolve) => {
                    timer = setTimeout(
                        () => resolve({ kind: "timeout" }),
                        Math.max(0, deadline - Date.now()),
                    );
                }),
            ]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    };

    /** consultId 计数器初值来自 Ledger：崩溃重启后不从头数，id 不会与上一轮撞车 */
    let consultSeq = ledger.listEvents().filter((e) => e.type === CONSULT_EVENTS.requested).length;

    /** 历史回复查找：同一 consultId **或**同一问题内容 → 复用（幂等，不重复计费） */
    const priorConsultReply = (consultId: string, contentKey: string): ConsultReply | null => {
        for (const ev of ledger.listEvents().reverse()) {
            if (ev.type !== CONSULT_EVENTS.replied) continue;
            const p = ev.payload as { consultId?: unknown; contentKey?: unknown; reply?: unknown } | null;
            if (!p) continue;
            const sameId = String(p.consultId ?? "") === consultId;
            const sameContent = contentKey !== "" && String(p.contentKey ?? "") === contentKey;
            if (!sameId && !sameContent) continue;
            const parsed = parseConsultReply(p.reply);
            if (parsed.ok) return parsed.value;
        }
        return null;
    };

    /**
     * 工位的 LLM 消耗计入**司机的台账**（与 runToolLoop / 子 Agent 同一口径：
     * 预占 + 完成各一条事件）。不记的话，一次召唤烧掉的额度在预算表上凭空消失——
     * 正是"花了钱却查不到钱花在哪"的形状。
     */
    const chargeConsultCalls = (reply: ConsultReply, consultId: string): void => {
        const n = Number.isFinite(reply.costLlmCalls) ? Math.max(0, Math.floor(reply.costLlmCalls)) : 0;
        for (let i = 0; i < n; i++) {
            ledger.appendEvent("llm_call_planned", { taskId: o.taskId, kind: "consult", consultId, role: reply.from });
            ledger.appendEvent("llm_call_completed", { taskId: o.taskId, kind: "consult", consultId, role: reply.from });
        }
    };

    /**
     * 端口本体。`consultId` 是可选的**显式重放口**：正常调用由内容+计数器生成；
     * 显式传同一个 id（重放/重试）时命中历史回复 → 直接复用，不重复烧 LLM。
     */
    const consultPort = async (req: {
        role: ConsultRole; question: string; focus?: string[]; consultId?: string;
    }): Promise<ConsultReply | null> => {
        const role = req?.role;
        const question = String(req?.question ?? "").trim();
        const focus = (req?.focus ?? []).map((s) => String(s).trim()).filter(Boolean);
        const target = role ? CONSULT_STATION_NAMES[role] : undefined;
        if (!target || !question) {
            const reason = !target ? `未知工位「${String(role)}」` : "question 为空";
            ledger.appendEvent(CONSULT_EVENTS.refused, { reason, where: "developer_port" });
            return null;
        }
        const contentKey = hashOf({ projectId: o.projectId, taskId: o.taskId, role, question, focus });
        const consultId = req?.consultId ?? newConsultId(o.taskId, ++consultSeq);

        // ③ 幂等：重放命中 → 原样复用，**不再发一次、不再烧一次**
        const cached = priorConsultReply(consultId, contentKey);
        if (cached) {
            ledger.appendEvent(CONSULT_EVENTS.replayed, {
                projectId: o.projectId, taskId: o.taskId, consultId: cached.consultId, contentKey, role,
                note: "同一 consultId / 同一问题已答过：复用历史回复，未再消耗工位 LLM",
            });
            return cached;
        }

        const request: ConsultRequest = {
            type: "consult_request",
            projectId: o.projectId, taskId: o.taskId, consultId,
            from: "developer", to: role, question,
            ...(focus.length > 0 ? { focus } : {}),
            // ★ 不带 evidence：协议里的 evidence 是"发起方声明的背景"，机器证据的权威口径
            //   在 TestAgent 回传里（protocol.ts）；工具侧把模型自报的背景拼进 question 正文，
            //   并显式标注"未经机器核验"——模型手写的东西不许冒充机器证据。
        };

        ledger.appendEvent(CONSULT_EVENTS.requested, {
            projectId: o.projectId, taskId: o.taskId, consultId, contentKey, role, target,
            question, focus, timeoutMs: consultTimeoutMs,
        });

        try {
            adapter.send(target, request);
        } catch (e) {
            const reason = `发送失败：${String((e as Error).message ?? e)}`;
            ledger.appendEvent(CONSULT_EVENTS.refused, {
                projectId: o.projectId, taskId: o.taskId, consultId, role, target, reason,
            });
            return null;
        }

        const deadline = Math.min(
            Date.now() + consultTimeoutMs,
            // 墙钟夹：整轮墙钟到点后**不许**再用"等工位"把进程拖住（与 waitTestTimeoutMs 同一口径）
            o.wallClockDeadlineAt ?? Number.POSITIVE_INFINITY,
        );
        for (; ;) {
            const got = await raceReceive(deadline);
            if (got.kind === "timeout") {
                // ① 降级，不挂起。事件名逐字为 consult_timeout（对账/看板据此判"工位缺席"）
                ledger.appendEvent(CONSULT_EVENTS.timeout, {
                    projectId: o.projectId, taskId: o.taskId, consultId, role, target,
                    waitedMs: consultTimeoutMs,
                    note: "工位未在时限内回复：司机降级为自行决策并写明假设（不挂起、不自动重试）",
                });
                // ★ 在途收件**不能就这么算了**：超时之后才到的消息（架构师批次 / 测试结果 /
                //   迟到的召唤回复）如果落进这个"已经没人等的 promise"，就等于
                //   "因为问了一次工位而丢了一条流水线消息"——比问不到答案严重得多。
                //   所以给**仍然在途**的那次收件挂一个迟到处理器：到了就进停车队列，
                //   serveOnce 之后照旧取得到。（没有在途收件时什么都不用做：
                //   消息还躺在 Hub 收件箱里，下一次 receive 自然会拿到。）
                if (inflightReceive) {
                    void receiveOnce().then((late) => {
                        if (!late || late.status !== "message") return;
                        parked.push({ message: late.message, sender: late.sender });
                        ledger.appendEvent("message_parked", {
                            type: late.message.type, sender: late.sender,
                            reason: "consult_late_after_timeout", consultId,
                        });
                    }).catch(() => { /* 收件本身出错：下一次 serveOnce 会重新发起 */ });
                }
                return null;
            }
            const res = got.res;
            if (res.status !== "message") continue;   // invalid / duplicate：不消费内容，继续等
            const msg = res.message;
            const isAwaited = msg.type === "consult_reply"
                && msg.consultId === consultId
                && msg.projectId === o.projectId
                && msg.taskId === o.taskId;
            if (isAwaited) {
                // ④ 越权闸/形状闸：不因为是"给我的"就免检
                const parsed = parseConsultReply(msg);
                if (!parsed.ok) {
                    ledger.appendEvent(CONSULT_EVENTS.refused, {
                        projectId: o.projectId, taskId: o.taskId, consultId, from: res.sender,
                        reasons: parsed.reasons, note: "回复未过越权/形状闸：整条丢弃，继续等待正确的回复",
                    });
                    continue;
                }
                const reply = parsed.value;
                if (reply.from !== role) {
                    ledger.appendEvent(CONSULT_EVENTS.refused, {
                        projectId: o.projectId, taskId: o.taskId, consultId,
                        from: reply.from, expected: role, sender: res.sender,
                        note: "回复自称的工位与请求目标不一致（冒名/串站）：丢弃并继续等",
                    });
                    continue;
                }
                ledger.appendEvent(CONSULT_EVENTS.replied, {
                    projectId: o.projectId, taskId: o.taskId, consultId, contentKey, role, target,
                    sender: res.sender, confidence: reply.confidence, costLlmCalls: reply.costLlmCalls,
                    amendmentKind: reply.amendment?.kind ?? null, refused: reply.refused ?? null,
                    // 回复本体落库：既供审计回看，也是"重放不重复烧"的唯一数据源
                    reply,
                });
                chargeConsultCalls(reply, consultId);
                if (reply.refused) {
                    ledger.appendEvent(CONSULT_EVENTS.refused, {
                        projectId: o.projectId, taskId: o.taskId, consultId, from: reply.from,
                        reason: reply.refused, note: "工位明确拒绝了这次召唤（回复已原样交给司机）",
                    });
                }
                return reply;
            }
            // ② 不是这次等待的回复 → **停车**（与 fitsCurrentStatus 同一个队列、同一语义），
            //    serveOnce 之后照旧取得到。等待回复绝不能吃掉架构师批次/测试结果。
            parked.push({ message: msg, sender: res.sender });
            ledger.appendEvent("message_parked", {
                type: msg.type, sender: res.sender, reason: "consult_wait", consultId,
            });
        }
    };

    // ★ 9/17 上下文压缩接线（Claude Code 机制，取代已退役的 pruneHistory）。
    //   窗口**在这里解析一次**，随 deps 一路传到 `autoCompactIfNeeded`——闸内不再重算：
    //   两处各算一个窗口必然出现"哪个说了算"的自相矛盾（模型名与档位谁先、settings 与 env 谁压）。
    //   档位与模型名都走本仓库的**唯一真相**：`models.ts` 的 resolveRoleTier + 档位合并约定。
    const devContextWindow = o.contextBudget?.disabled === true
        ? null
        : resolveDeveloperContextWindow({
            llmId: o.llm.id,
            ...(o.contextBudget?.role !== undefined ? { role: o.contextBudget.role } : {}),
            ...(o.contextBudget?.tier !== undefined ? { tier: o.contextBudget.tier } : {}),
            ...(o.contextBudget?.model !== undefined ? { model: o.contextBudget.model } : {}),
        });

    const graph = buildDeveloperGraph({
        workspace,
        tools,
        ledger,
        port: adapter,
        llm: o.llm,
        analyzer,
        askHuman: askHumanPort,
        // 摘要口取 o.llm.summarize：**必须与主循环同一个 llm**（同端点/同凭据/同观测）；
        // 包装器没实现它 = 引擎没有摘要能力 → 越窗只会问人（如实降级，不假装压过）。
        ...(devContextWindow ? {
            contextBudget: {
                window: devContextWindow,
                model: devContextWindow.model,
                ...(o.contextBudget?.summarize ? { summarize: o.contextBudget.summarize } : {}),
                ...(o.contextBudget?.readFileState ? { readFileState: o.contextBudget.readFileState } : {}),
                ...(o.contextBudget?.readFile ? { readFile: o.contextBudget.readFile } : {}),
                // 原始台账路径会出现在摘要消息正文里（cc 的 getTranscriptPath）：模型能据此
                // 知道"完整历史在这台机器的哪个文件里"，而不是凭空回忆
                getTranscriptPath: o.contextBudget?.getTranscriptPath ?? (() => o.ledgerPath),
            },
        } : {}),
        // 召唤真工位（9/17 层 B）：与 askHuman 同款「注入即可用、不注入即默认拒绝」
        consultStation: consultPort,
        ...(o.targets ? { targets: o.targets } : {}),
        ...(o.maxLlmCalls !== undefined ? { maxLlmCalls: o.maxLlmCalls } : {}),
        ...(o.maxStepsPerLoop !== undefined ? { maxStepsPerLoop: o.maxStepsPerLoop } : {}),
        ...(o.waitTestTimeoutMs !== undefined ? { waitTestTimeoutMs: o.waitTestTimeoutMs } : {}),
        ...(o.wallClockDeadlineAt !== undefined ? { wallClockDeadlineAt: o.wallClockDeadlineAt } : {}),
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

    // ============================================================
    // 带问人的 invoke（9/17）
    //
    //   图内**不阻塞**：保险丝触发时 escalate 节点把问题写进 state.human 后出图。
    //   这里负责"问 → 回填 humanAnswer → 继续 invoke"，直到图不再要问了为止。
    //   这正是 architect/manager 那条 confirm 门（GraphFactory.runWithInteraction）的通用化，
    //   区别是它现在也接在 developer 线上——**这是"卡住即死"变成"卡住问人"的唯一接口**。
    //
    //   问答器三分流复用既有 pickQuestioner（confirm.ts）：
    //     · Web 管理进程（EXIT_AT_PHASE_BOUNDARY=1）→ HttpQuestioner：问题落 sys_confirm，
    //       看板弹气泡卡，轮询取答（这条链路实弹验证过 3 阶段 10 问 10 答）
    //     · 手工终端 → CliQuestioner 真 stdin
    //     · AUTO_CONFIRM=1 → 自动 y（只影响"问人"，验收判据零让步）
    //   问不出去（Java 不可达等）不当作整轮失败：如实记事件，按答案空串走
    //   escalate 的默认路径（continue，且次数有界）——不静默、也不假装人答过。
    // ============================================================
    const MAX_HUMAN_ROUNDS_PER_INVOKE = 8;   // 兜底：防"问-答-又问"打成死循环（escalate 自身也已限次数）
    const invokeWithHuman = async (
        input: DeveloperState,
        where: string,
    ): Promise<DeveloperState> => {
        let state = await graph.invoke(input, { recursionLimit }) as DeveloperState;
        let rounds = 0;
        while (state.human && rounds++ < MAX_HUMAN_ROUNDS_PER_INVOKE) {
            const question = state.human;
            ledger.appendEvent("human_question_asked", {
                where, questionId: question.questionId, prompt: question.prompt, options: question.options ?? [],
            });
            let answer = "";
            try {
                answer = await questioner.ask(question);
            } catch (e) {
                ledger.appendEvent("human_question_failed", {
                    where, questionId: question.questionId, error: String((e as Error).message ?? e),
                });
            }
            ledger.appendEvent("human_answer_received", { where, questionId: question.questionId, answer });
            // 复活：把人的答案作为新输入带回去。整份 state 原样传入（input 只初始化一次，
            // 不会被 append 型 reducer 重复追加）；humanAnswer 是 escalate 节点消费的信号。
            state = await graph.invoke(
                initialDeveloperState({ ...state, humanAnswer: answer }),
                { recursionLimit },
            ) as DeveloperState;
        }
        return state;
    };

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
            const finalState = await invokeWithHuman(initial, "run");
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
     *
     * ★ 收件走 receiveOnce（单一在途）：召唤工位（层 B）在等待回复时用的是**同一个**
     *   在途 receive——两个并发 waitForMessage 会在同一条消息上一起醒来、其中一个拿到
     *   undefined，消息就"既没被消费也没被记账"地消失了。
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
            const res: ReceiveResult = await receiveOnce();
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
            const finalState = await invokeWithHuman(resumed, "resume_from_test");
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
            const finalState = await invokeWithHuman(resumed, "resume_with_batch");
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

    /**
     * 召唤工位（层 B）的统计：全部从 Ledger 事件算（**不另建内存计数器**——
     * 进程重启后统计跟着重来，就会和台账对不上，而台账才是真相）。
     * llmCalls 数的是 llm_call_planned(kind=consult)：证明工位的消耗**真的进了**司机台账。
     */
    const inspectConsultStats = () => {
        let requested = 0, replied = 0, timedOut = 0, refused = 0, replayed = 0, llmCalls = 0;
        for (const ev of ledger.listEvents()) {
            if (ev.type === CONSULT_EVENTS.requested) requested++;
            else if (ev.type === CONSULT_EVENTS.replied) replied++;
            else if (ev.type === CONSULT_EVENTS.timeout) timedOut++;
            else if (ev.type === CONSULT_EVENTS.refused) refused++;
            else if (ev.type === CONSULT_EVENTS.replayed) replayed++;
            else if (ev.type === "llm_call_planned"
                && (ev.payload as { kind?: unknown } | null)?.kind === "consult") llmCalls++;
        }
        return { requested, replied, timedOut, refused, replayed, llmCalls, timeoutMs: consultTimeoutMs };
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
            /**
             * 召唤工位（层 B）的只读视图：发起/答复/超时/被拒的次数，
             * 以及**工位替司机烧掉的 LLM 调用数**（它已经计入 llm_call_* 台账，
             * 这里给看板一个不用翻事件的直接读数：召唤不是免费的）。
             */
            consult: inspectConsultStats(),
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
        /** 层 B：召唤工位（与 graph 内工具同一份实现，见 consultPort） */
        consultStation: (req) => consultPort(req),
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
