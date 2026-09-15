// ============================================================
// state.ts —— Developer 的 LangGraph State 与状态迁移规则
//
//   分工（铁律）：
//     · LangGraph State 只是**图内**的执行上下文，不是持久化真相；
//     · 持久化状态真相是 Ledger（崩溃恢复从 Ledger 来）；
//     · Agent 不能自己把 status 写成 ready —— 迁移表 + canGoReady() 在代码里强制，
//       不信模型自述、也不靠 prompt 自觉。
// ============================================================

import { Annotation } from "@langchain/langgraph";
import { skillForWorkItem } from "./protocol";
import type {
    AcceptanceCheck, Contract, DomainModel, FoundationPlan, RequirementSnapshot,
    StackProfile, TestFailure, WorkItem,
} from "./protocol";

export type DeveloperStatus =
    | "received"      // 收到 architect_task
    | "inspecting"    // 看目录、读上下文
    | "implementing"  // 搭基础 / 写业务 / 本地检查
    | "testing"       // 已发出 test_request
    | "waiting_test"  // 已落库、等外部 TestAgent 消息恢复（**不在节点里阻塞**）
    | "waiting_item"  // 分批模式：等架构师推送下一个工作项批次（同样**不阻塞**，END 后由外部复活）
    | "repairing"     // 按失败证据修复
    | "ready"         // 唯一入口：受信 TestAgent 的 TestPassed + 真实机器证据
    | "blocked"       // 重复失败 / 修复次数耗尽 / 预算超限 / 环境缺失
    | "failed"        // 未捕获异常收尾
    | "cancelled";    // 被显式取消

/** 文件元数据（**只存元信息，不存全文**）：Skill 调度与改动判断都用它 */
export interface FileMeta {
    path: string;
    size: number;
    hash: string;
    language: string;
}

export interface DeveloperState {
    projectId: string;
    taskId: string;
    /** 本次运行的唯一 id：runKey 由它参与构成，防止不同 run 混进同一个账本 */
    runId: string;
    projectDir: string;
    allowedRoots: string[];
    /** 已发出 test_request 时用的关联 id；恢复时用它核对 TestAgent 消息 */
    correlationId: string | null;
    /** 测试等待的截止时刻（epoch ms）；超过它到达的结果视为过期（规格三.10） */
    testDeadlineAt: number | null;
    /** 恢复入口：从哪个节点接着跑（null = 全新任务，从 receiveTask 开始） */
    resumeFrom: string | null;
    requirementSnapshot: RequirementSnapshot | null;
    stackProfile: StackProfile | null;
    domainModel: DomainModel | null;
    contract: Contract | null;
    foundationPlan: FoundationPlan | null;
    developerInstructions: string;
    /** 架构师下发的验收检查——TestPassed 的 acceptanceHash 由它算出 */
    acceptanceChecks: AcceptanceCheck[];
    acceptanceHash: string;
    /** 结构化工作项：决定当前该加载哪个 Skill（不再靠"目录空不空"猜） */
    workItems: WorkItem[];
    /** 已完成的工作项 id（由 bootstrapOrImplement 在一个工作项做完时登记） */
    completedWorkItems: string[];
    /** 当前正在做的工作项 id */
    currentWorkItemId: string | null;
    /** 分批模式（9/15）：蓝图先行、架构师逐工作项推批；false = 存量一步整包链路 */
    batched: boolean;
    /** 已到批的工作项 id（工作项**开工**的前置条件——判据/详规随批到达） */
    arrivedItems: string[];
    /** 已完成的工具调用指纹（= 工具 + command + args + cwd + 当前文件快照） */
    completedToolCalls: string[];
    /** 已批准过超时延长的调用指纹（规格五.7：同一条命令只许延长一次） */
    timeoutExtensions: string[];
    /** 同一命令连续超时两次 → true（规格五.8：标 TIMEOUT_REPEATED 停下来交给外部） */
    timeoutRepeated: boolean;
    /** 触发 TIMEOUT_REPEATED 的命令签名（用于留痕与对外上报） */
    timeoutSignature: string | null;
    currentFiles: FileMeta[];
    activeSkill: string | null;
    messages: unknown[];
    lastTestFailure: TestFailure | null;
    changedFiles: string[];
    failureSignatures: string[];
    repairAttempts: number;
    maxRepairAttempts: number;
    /** 连续「修了一轮但一个文件都没动」的次数；≥1 即停止（同签名 + 文件无变化不许原地重试） */
    stalledRepairs: number;
    /** 本地预检报 NO_BUILD_ENTRY 的目标（如 backend）：**未验证**——不算通过、不触发编译修复，送检时如实标注 */
    localChecksUnverified: string[];
    /** 已**预占**的 LLM 调用次数：请求发出前先加，崩溃也不会漏账 */
    llmCallsPlanned: number;
    /** 已**拿到结果**的 LLM 调用次数 */
    llmCallsCompleted: number;
    /** 工具调用次数 */
    toolCalls: number;
    status: DeveloperStatus;
    error: string | null;
}

// ---------- LangGraph State 定义 ----------

const lastWrite = <T>(_prev: T, next: T): T => next;
const append = <T>(prev: T[], next: T[]): T[] => [...prev, ...next];
const appendUnique = (prev: string[], next: string[]): string[] => [...new Set([...prev, ...next])];

export const DeveloperAnnotation = Annotation.Root({
    projectId: Annotation<string>({ reducer: lastWrite, default: () => "" }),
    taskId: Annotation<string>({ reducer: lastWrite, default: () => "" }),
    runId: Annotation<string>({ reducer: lastWrite, default: () => "" }),
    projectDir: Annotation<string>({ reducer: lastWrite, default: () => "" }),
    allowedRoots: Annotation<string[]>({ reducer: lastWrite, default: () => [] }),
    correlationId: Annotation<string | null>({ reducer: lastWrite, default: () => null }),
    testDeadlineAt: Annotation<number | null>({ reducer: lastWrite, default: () => null }),
    resumeFrom: Annotation<string | null>({ reducer: lastWrite, default: () => null }),
    requirementSnapshot: Annotation<RequirementSnapshot | null>({ reducer: lastWrite, default: () => null }),
    stackProfile: Annotation<StackProfile | null>({ reducer: lastWrite, default: () => null }),
    domainModel: Annotation<DomainModel | null>({ reducer: lastWrite, default: () => null }),
    contract: Annotation<Contract | null>({ reducer: lastWrite, default: () => null }),
    foundationPlan: Annotation<FoundationPlan | null>({ reducer: lastWrite, default: () => null }),
    developerInstructions: Annotation<string>({ reducer: lastWrite, default: () => "" }),
    acceptanceChecks: Annotation<AcceptanceCheck[]>({ reducer: lastWrite, default: () => [] }),
    acceptanceHash: Annotation<string>({ reducer: lastWrite, default: () => "" }),
    workItems: Annotation<WorkItem[]>({ reducer: lastWrite, default: () => [] }),
    completedWorkItems: Annotation<string[]>({ reducer: appendUnique, default: () => [] }),
    batched: Annotation<boolean>({ reducer: lastWrite, default: () => false }),
    arrivedItems: Annotation<string[]>({ reducer: appendUnique, default: () => [] }),
    completedToolCalls: Annotation<string[]>({ reducer: appendUnique, default: () => [] }),
    timeoutExtensions: Annotation<string[]>({ reducer: appendUnique, default: () => [] }),
    timeoutRepeated: Annotation<boolean>({ reducer: lastWrite, default: () => false }),
    timeoutSignature: Annotation<string | null>({ reducer: lastWrite, default: () => null }),
    currentWorkItemId: Annotation<string | null>({ reducer: lastWrite, default: () => null }),
    currentFiles: Annotation<FileMeta[]>({ reducer: lastWrite, default: () => [] }),
    activeSkill: Annotation<string | null>({ reducer: lastWrite, default: () => null }),
    messages: Annotation<unknown[]>({ reducer: append, default: () => [] }),
    lastTestFailure: Annotation<TestFailure | null>({ reducer: lastWrite, default: () => null }),
    changedFiles: Annotation<string[]>({ reducer: appendUnique, default: () => [] }),
    failureSignatures: Annotation<string[]>({ reducer: appendUnique, default: () => [] }),
    repairAttempts: Annotation<number>({ reducer: lastWrite, default: () => 0 }),
    maxRepairAttempts: Annotation<number>({ reducer: lastWrite, default: () => 2 }),
    stalledRepairs: Annotation<number>({ reducer: lastWrite, default: () => 0 }),
    localChecksUnverified: Annotation<string[]>({ reducer: lastWrite, default: () => [] }),
    llmCallsPlanned: Annotation<number>({ reducer: lastWrite, default: () => 0 }),
    llmCallsCompleted: Annotation<number>({ reducer: lastWrite, default: () => 0 }),
    toolCalls: Annotation<number>({ reducer: lastWrite, default: () => 0 }),
    status: Annotation<DeveloperStatus>({ reducer: lastWrite, default: () => "received" }),
    error: Annotation<string | null>({ reducer: lastWrite, default: () => null }),
});

/** 供 index.ts / 测试构造初始状态 */
export function initialDeveloperState(patch: Partial<DeveloperState>): DeveloperState {
    return {
        projectId: "", taskId: "", runId: "", projectDir: "", allowedRoots: [],
        correlationId: null, testDeadlineAt: null, resumeFrom: null,
        requirementSnapshot: null, stackProfile: null, domainModel: null,
        contract: null, foundationPlan: null, developerInstructions: "",
        acceptanceChecks: [], acceptanceHash: "", workItems: [],
        completedWorkItems: [], completedToolCalls: [], timeoutExtensions: [],
        batched: false, arrivedItems: [],
        timeoutRepeated: false, timeoutSignature: null,
        currentWorkItemId: null,
        currentFiles: [], activeSkill: null, messages: [], lastTestFailure: null,
        changedFiles: [], failureSignatures: [], repairAttempts: 0,
        maxRepairAttempts: 2, stalledRepairs: 0, localChecksUnverified: [],
        llmCallsPlanned: 0, llmCallsCompleted: 0, toolCalls: 0,
        status: "received", error: null,
        ...patch,
    };
}

// ============================================================
// 状态迁移表（纯函数；改这张表 = 改语义，必须同步改测试）
//   · ready 是终态，且**只能从 testing 到达**——保证"没测过就不可能 ready"
//   · blocked / failed 是终态，不允许从里面悄悄爬出来
// ============================================================

export const STATUS_TRANSITIONS: Record<DeveloperStatus, DeveloperStatus[]> = {
    received: ["inspecting", "blocked", "failed", "cancelled"],
    inspecting: ["implementing", "blocked", "failed", "cancelled"],
    implementing: ["implementing", "testing", "waiting_test", "waiting_item", "repairing", "blocked", "failed", "cancelled"],
    testing: ["testing", "waiting_test", "repairing", "ready", "blocked", "failed", "cancelled"],
    waiting_test: ["testing", "repairing", "ready", "blocked", "failed", "cancelled"],
    // waiting_item 只能回 implementing 继续干活或收口终态；**不得**直达 testing/ready——
    // 判据没到齐就没有"送检"这回事（routeAfterLocalChecks 的未达闸是同一件事的另一半）。
    // waiting_test → waiting_item 也被禁：一旦送过检，acceptanceHash 必须冻结。
    waiting_item: ["implementing", "blocked", "failed", "cancelled"],
    repairing: ["implementing", "testing", "waiting_test", "blocked", "failed", "cancelled"],
    ready: [],
    blocked: [],
    failed: [],
    cancelled: [],
};

export function canTransitionStatus(from: DeveloperStatus, to: DeveloperStatus): boolean {
    if (from === to) return true;
    return (STATUS_TRANSITIONS[from] ?? []).includes(to);
}

/** 非法迁移直接抛错（不允许"悄悄跳到 ready"） */
export function assertStatusTransition(from: DeveloperStatus, to: DeveloperStatus): void {
    if (!canTransitionStatus(from, to)) {
        throw new Error(`非法 Developer 状态迁移：${from} → ${to}`);
    }
}

// ============================================================
// 判定纪律（全部纯函数，便于零 LLM 单测）
// ============================================================

/** 取最后一条带 type 的入站消息类型 */
export function lastInboundType(state: Pick<DeveloperState, "messages">): string | null {
    const msgs = state.messages;
    for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m && typeof m === "object" && typeof (m as { type?: unknown }).type === "string") {
            return (m as { type: string }).type;
        }
    }
    return null;
}

/**
 * ready 的唯一合法入口。
 * 三个条件缺一不可：状态在 testing、没有未消化的失败、最后一条入站消息是 test_passed。
 * ——这就是"TestPassed 后才允许 developer_ready"与"Developer 不能自行 ready"的代码实现。
 */
export function canGoReady(
    state: Pick<DeveloperState, "status" | "lastTestFailure" | "messages">,
): boolean {
    return state.status === "testing"
        && state.lastTestFailure === null
        && lastInboundType(state) === "test_passed";
}

/** 同一 failureSignature 之前出现过 → 重复，停止，不许原样重试 */
export function isRepeatedFailure(
    state: Pick<DeveloperState, "failureSignatures" | "lastTestFailure">,
): boolean {
    const sig = state.lastTestFailure?.failureSignature ?? null;
    if (!sig) return false;
    return state.failureSignatures.includes(sig);
}

/** 修复次数耗尽 */
export function isRepairExhausted(state: Pick<DeveloperState, "repairAttempts" | "maxRepairAttempts">): boolean {
    return state.repairAttempts >= state.maxRepairAttempts;
}

/** 上一轮"修了但没动任何文件" → 停止（同签名 + 无变化，再修也是原地打转） */
export function isStalled(state: Pick<DeveloperState, "stalledRepairs">): boolean {
    return state.stalledRepairs >= 1;
}

/**
 * 同一命令连续超时两次（规格五.8）。
 * 语义是"这条路已经走不通了"——继续重试只会再烧一个超时窗口，
 * 所以停下来标 TIMEOUT_REPEATED，把决定权交给 TestAgent / Orchestrator。
 */
export function isTimeoutRepeated(state: Pick<DeveloperState, "timeoutRepeated">): boolean {
    return state.timeoutRepeated === true;
}

/**
 * 预算是否已超（规格九：用 **>=**，不是 >）。
 * 语义是「达到上限即不得再发起请求」——上限是可用额度，不是"允许再多跑一次"。
 */
export function isBudgetExceeded(state: Pick<DeveloperState, "llmCallsCompleted">, maxLlmCalls: number): boolean {
    return state.llmCallsCompleted >= maxLlmCalls;
}

/** 还能不能再预占一次 LLM 调用：调用前先问，预占不到就根本别发请求 */
export function canReserveLlmCall(state: Pick<DeveloperState, "llmCallsPlanned">, maxLlmCalls: number): boolean {
    return state.llmCallsPlanned + 1 <= maxLlmCalls;
}

// ============================================================
// Skill 调度（规格七）：由**结构化工作项**决定，不看"目录空不空"
// ============================================================

/** 下一个还没做完的工作项（按架构师给的顺序） */
export function nextWorkItem(
    state: Pick<DeveloperState, "workItems" | "completedWorkItems">,
): WorkItem | null {
    for (const item of state.workItems) {
        if (!state.completedWorkItems.includes(item.id)) return item;
    }
    return null;
}

/**
 * 还有没有**没做过**的工作项（= 不是"当前这项"，而是"后面还没轮到的"）。
 *
 * 为什么需要它：本地预检（runLocalChecks）跑的是**整站** build，而工作项是**分阶段**的。
 * 骨架阶段（w1）刚落地时，前端只有 package.json / index.html，整站 build 必然红——
 * 但那个红不代表"代码写错了"，只代表"后面的工作项还没做"。
 * 这时正确的动作是**继续推进工作项**，而不是进 repair 去修一个尚未实现的模块。
 */
export function hasPendingWorkItem(
    state: Pick<DeveloperState, "workItems" | "completedWorkItems">,
): boolean {
    return nextWorkItem(state) !== null;
}

/**
 * 分批模式（9/15）：下一个「未完**且**已到批」的工作项。
 * 顺序仍是架构师给的序——后项先到批也不许提前（"顺序即执行序"是蓝图的立法）；
 * 全部未完项都没到批 → null，交给路由去 waitBatch 等架构师。
 */
export function nextArrivedWorkItem(
    state: Pick<DeveloperState, "workItems" | "completedWorkItems" | "arrivedItems">,
): WorkItem | null {
    for (const item of state.workItems) {
        if (!state.completedWorkItems.includes(item.id) && state.arrivedItems.includes(item.id)) return item;
    }
    return null;
}

/**
 * 下一个「未完**且未**到批」的工作项——非 null 即"拆解流还开着"。
 * 这是分批模式的总闸：所有通往 requestTest 的路（含恢复兜底）都必须先看它一眼，
 * 否则判据未齐就送检 = 静默欠验收（routeAfterLocalChecks:1090 那个洞的封堵点）。
 */
export function nextUnarrivedWorkItem(
    state: Pick<DeveloperState, "workItems" | "completedWorkItems" | "arrivedItems">,
): WorkItem | null {
    for (const item of state.workItems) {
        if (!state.completedWorkItems.includes(item.id) && !state.arrivedItems.includes(item.id)) return item;
    }
    return null;
}

/**
 * 当前该加载哪个 Skill —— 纯函数、可单测。
 *   ① 有未完成工作项 → 按该工作项的 kind 映射；
 *   ② 工作项全做完 → pre-test（自检/送检前）；
 *   ③ 任务包没给任何工作项 → foundation（代码级默认：从搭基础开始）。
 */
export function pickSkillForState(
    state: Pick<DeveloperState, "workItems" | "completedWorkItems">,
): string {
    const item = nextWorkItem(state);
    if (item) return skillForWorkItem(item.kind);
    if (state.workItems.length === 0) return skillForWorkItem("foundation");
    return skillForWorkItem("pre-test");
}

/** 测试等待是否已过期：过期后到达的测试消息一律拒绝（规格三.10） */
export function isTestWaitExpired(
    state: Pick<DeveloperState, "testDeadlineAt">, now = Date.now(),
): boolean {
    return state.testDeadlineAt !== null && now > state.testDeadlineAt;
}
