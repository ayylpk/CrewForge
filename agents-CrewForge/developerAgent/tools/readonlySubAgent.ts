// ============================================================
// tools/readonlySubAgent.ts —— 只读子 Agent 统一接口（Explorer / Debugger / UI Reviewer）
//
//   定位（规格三~九）：
//     Developer 主 Agent 遇到复杂问题时，可以调用**一个**最合适的只读子 Agent；
//     子 Agent 只做分析、返回结构化建议；写盘与决策永远留在主 Agent。
//
//   结构性的做不到（不是提示词自觉）：
//     · 子 Agent 的运行环境里只有一个 ReadonlyToolbox（白名单：inspectTree /
//       readFile / search / gitDiff）+ 请求本身 —— 它拿不到 Workspace 的写入口、
//       拿不到 Hub 端口、拿不到 Ledger 句柄、更拿不到 DeveloperState；
//     · 返回值必须过**严格 Schema**（未知键一律拒绝）：
//       权威字段（status / done / verified / passed / exitCode / budget …）
//       根本不在 schema 键位里，返回了就整体拒（规格三.6 + 十.13）；
//     · 分析结果里的 evidence 条目只允许 {path, line?, detail}——
//       引用 exitCode 只能来自**请求里的机器证据**（框架注入），模型写的会被
//       当作"未核验声明"，且绝不允许作为结果字段返回（规格三·注意）。
//
//   去重与快照绑定（规格六）：
//     · 同一 (taskId, failureSignature) 最多真实执行一次 —— 记账在 Ledger 的
//       subagent_call 表（INSERT OR IGNORE），崩溃恢复后依然有效；
//     · 调用时记下当时的文件快照 hash；快照变了，旧结果只作"参考"（stale 标记），
//       不能直接复用；
//     · 失败/超时不自动重试（占名额不归还）。
//
//   本阶段零 LLM（规格一.10）：三个角色的默认分析器是**确定性只读分析**
//   （复用 testAssistant.ts 的只读工具盒与检索套路）。将来接真实模型时注入
//   subagentLlm 即可，接口与校验不变。
// ============================================================

import { z } from "zod";
import { canonicalJson } from "../protocol";
import { hashOf, type DeveloperLedger } from "../ledger";
import type { Workspace } from "../workspace";
import type { ToolArgs, ToolRegistry } from "./registry";
import { READONLY_TOOL_NAMES } from "./registry";
import { createReadonlyToolbox, type ReadonlyToolbox } from "./testAssistant";

// ============================================================
// 角色与请求 / 结果类型（规格三）
// ============================================================

export type ReadonlySubAgentRole =
    | "explorer" | "debugger" | "ui-reviewer"
    // ★ 9/17 拓扑升级（多 agent 保留版）：把"接力棒工位"变成"可召唤的专家"。
    //   以前 PM/架构师/测试/维护者只在流水线的固定位置出现一次（发批→消费→退出→Java 再拉起），
    //   中间失忆（"换脑断层"），模型判断力不累积。现在司机（developer）在自己循环里
    //   **随时**可以召唤这两种顾问：架构审（结构性缺口）与验收审（会不会 404/白屏）。
    //   团队一个工位没删——只是从"接力"改成"召唤"，这才是 Claude Code 的多 agent 形状。
    | "architect-advisor" | "acceptance-advisor";

export const READONLY_SUBAGENT_ROLES: readonly ReadonlySubAgentRole[] = [
    "explorer", "debugger", "ui-reviewer", "architect-advisor", "acceptance-advisor",
];

/**
 * 子 Agent 唯一能碰的工具——就是全局只读白名单，一个不多（规格七）。
 * ★ 用函数而不是 `const X = READONLY_TOOL_NAMES`：registry → delegateReadonly →
 *   本模块 → registry 是条循环链，模块加载期直接引用会在初始化完成前取值炸 ReferenceError。
 */
export function subagentToolNames(): readonly string[] {
    return READONLY_TOOL_NAMES;
}

/** 请求里的机器证据：由主 Agent 侧（框架）注入，来自 TestAgent 的原始回传 */
const RequestEvidenceSchema = z.looseObject({
    category: z.string().optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    exitCode: z.number().int().nullable().optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    affectedFiles: z.array(z.string()).optional(),
    failureSignature: z.string().optional(),
});
export type ReadonlySubAgentEvidenceInput = z.infer<typeof RequestEvidenceSchema>;

/** 统一请求接口（规格三）。role 非法 / question 为空 → 直接拒绝，不跑分析。 */
export const ReadonlySubAgentRequestSchema = z.object({
    role: z.enum(["explorer", "debugger", "ui-reviewer", "architect-advisor", "acceptance-advisor"]),
    question: z.string().min(1),
    paths: z.array(z.string()).optional(),
    evidence: RequestEvidenceSchema.optional(),
});
export type ReadonlySubAgentRequest = z.infer<typeof ReadonlySubAgentRequestSchema>;

/**
 * 结构化结果（规格三）。
 * ★ 两层都 strict：未知键一律拒绝 ——
 *   顶层出现 status/done/verified/passed/exitCode/budget 等权威字段 → 整体拒绝；
 *   evidence 条目里出现 exitCode/checkId/stdoutHash 等机器验证字段 → 同样拒绝
 *   （子 Agent 的 evidence 只是"分析引用"，绝不是 TestPassed 那种机器证据）。
 */
const ResultEvidenceSchema = z.strictObject({
    path: z.string().min(1),
    line: z.number().int().positive().optional(),
    detail: z.string().min(1),
});

export const ReadonlySubAgentResultSchema = z.strictObject({
    role: z.enum(["explorer", "debugger", "ui-reviewer", "architect-advisor", "acceptance-advisor"]),
    ok: z.boolean(),
    rootCause: z.string(),
    evidence: z.array(ResultEvidenceSchema),
    recommendedChanges: z.array(z.string()),
    risks: z.array(z.string()),
    confidence: z.enum(["high", "medium", "low"]),
    cannotVerify: z.array(z.string()),
    readonly: z.literal(true),
});
export type ReadonlySubAgentResult = z.infer<typeof ReadonlySubAgentResultSchema>;

/** 结果里绝不允许出现的权威字段（对应 AUTHORITY_FIELDS；evidence 允许但形状已被 strict 锁死） */
export const SUBAGENT_FORBIDDEN_RESULT_FIELDS: readonly string[] = [
    "status", "done", "verified", "passed", "exitCode", "budget",
];

/**
 * 校验 + 收口一个候选结果（规格三.1/3.3/3.4/3.6）：
 *   ① readonly 由程序固定为 true（不看输入怎么写）；
 *   ② role 由框架固定为请求的 role（防止串角）；
 *   ③ 严格 Schema 校验；非法就拒绝——**非法返回绝不进主 Agent Prompt**。
 */
export function finalizeReadonlySubAgentResult(
    role: ReadonlySubAgentRole, raw: unknown,
): { ok: true; result: ReadonlySubAgentResult } | { ok: false; error: string } {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return { ok: false, error: "子 Agent 返回值不是对象" };
    }
    const forced = { ...(raw as Record<string, unknown>), role, readonly: true };
    const parsed = ReadonlySubAgentResultSchema.safeParse(forced);
    if (!parsed.success) {
        const why = parsed.error.issues
            .map((i) => `${i.path.join(".") || "$"}: ${i.message}`)
            .join("; ");
        return { ok: false, error: `Schema 校验失败：${why}` };
    }
    return { ok: true, result: parsed.data };
}

/** 结构化的失败壳（规格三.5）：超时/失败不抛裸异常，返回同 Schema 形状的 ok:false */
export function subagentFailureStruct(
    role: ReadonlySubAgentRole, reason: string,
): ReadonlySubAgentResult {
    return {
        role,
        ok: false,
        rootCause: `（子 Agent 未能完成分析：${reason}）`,
        evidence: [],
        recommendedChanges: [],
        risks: [],
        confidence: "low",
        cannotVerify: [`本次分析没有产出任何可信结论（${reason}），全部待主 Agent 自行核实`],
        readonly: true,
    };
}

/** 结果过长时截断（规格九.5）。返回截断后的结果 + 是否截断（原文由调用方落 Ledger）。 */
const CAPS = {
    rootCause: 1200, evidenceItems: 15, evidenceDetail: 500,
    changes: 10, changeLen: 400, risks: 10, riskLen: 200,
    cannot: 10, cannotLen: 200,
} as const;

function clip(s: string, n: number): { text: string; cut: boolean } {
    return s.length > n ? { text: `${s.slice(0, n)}…[已截断]`, cut: true } : { text: s, cut: false };
}

export function truncateReadonlyResult(r: ReadonlySubAgentResult): { result: ReadonlySubAgentResult; truncated: boolean } {
    let cut = false;
    const c1 = clip(r.rootCause, CAPS.rootCause); cut = cut || c1.cut;
    const ev = r.evidence.slice(0, CAPS.evidenceItems); cut = cut || ev.length !== r.evidence.length;
    const evidence = ev.map((e) => {
        const c = clip(e.detail, CAPS.evidenceDetail); cut = cut || c.cut;
        return { ...e, detail: c.text };
    });
    const rc = r.recommendedChanges.slice(0, CAPS.changes); cut = cut || rc.length !== r.recommendedChanges.length;
    const recommendedChanges = rc.map((s) => { const c = clip(s, CAPS.changeLen); cut = cut || c.cut; return c.text; });
    const rk = r.risks.slice(0, CAPS.risks); cut = cut || rk.length !== r.risks.length;
    const risks = rk.map((s) => { const c = clip(s, CAPS.riskLen); cut = cut || c.cut; return c.text; });
    const ck = r.cannotVerify.slice(0, CAPS.cannot); cut = cut || ck.length !== r.cannotVerify.length;
    const cannotVerify = ck.map((s) => { const c = clip(s, CAPS.cannotLen); cut = cut || c.cut; return c.text; });
    return { result: { ...r, rootCause: c1.text, evidence, recommendedChanges, risks, cannotVerify }, truncated: cut };
}

// ============================================================
// 角色边界说明（代码常量——**不新增用户可编辑 Prompt**，规格一.8 / 八）
//   注入 LLM 时作为 system 提示；确定性模式下作为分析器的自检口径。
// ============================================================

export const SUBAGENT_ROLE_PROMPTS: Record<ReadonlySubAgentRole, string> = {
    explorer: [
        "你是只读 Explorer：只分析目录结构、工程文件（package.json/pom.xml/pyproject.toml 等）、",
        "已有路由/入口/配置、任务涉及的文件、可能缺失的基础文件。",
        "不得：设计新业务；修改技术栈；改变 Contract；输出完整代码文件。",
        "你的分析没有执行能力：看不到运行时行为，看到的一律标来源，拿不准的进 cannotVerify。",
    ].join(" "),
    debugger: [
        "你是只读 Debugger：只分析编译/启动/HTTP 失败证据（stdout/stderr/exitCode/失败签名）、",
        "相关源文件，找出可能的字段、路由、配置或依赖不一致。",
        "输出：最可能根因、证据文件与行号、建议修改位置、风险、无法确认的部分。",
        "★ 不得把推测写成确定事实——根因必须是证据原文的引用或明确标注的假设；",
        "  exitCode 等机器事实只能引用请求注入的机器证据，不得自造。",
    ].join(" "),
    "ui-reviewer": [
        "你是只读 UI Reviewer：只静态分析页面结构、路由登记、空页面、loading/empty/error/success 状态、",
        "组件库接入、Element Plus / TDesign 是否混用、响应式布局、视觉层级、白屏可能。",
        "不得：修改 Vue 文件；改 Contract；宣布页面通过；用静态文件推断 HTTP 已通过。",
        "渲染与白屏的**真实**行为需要运行证据，你只能给静态线索，其余进 cannotVerify。",
    ].join(" "),
    "architect-advisor": [
        "你是只读架构顾问（Architect Advisor）：被司机在中途召唤，回答**结构性**问题——",
        "目录/工程文件是否齐、路由与入口是否登记、数据库迁移文件是否有人用、契约文件是否在位、",
        "需求与技术栈是否自洽（例如需求要求嵌入式数据库却选了需要外部服务的库）。",
        "不得：改技术栈（那是架构师的决定）；改 Contract；替司机写代码；宣布计划已完成。",
        "你的价值是**在司机跑偏之前叫停**：只报结构缺口与矛盾，逐条给文件证据。",
    ].join(" "),
    "acceptance-advisor": [
        "你是只读验收顾问（Acceptance Advisor）：被司机在中途召唤，预判「这套东西拿去验收会挂在哪」。",
        "只做静态预判：接口清单（HTTP 方法与路径）是否真的注册了、涉及的状态码分支",
        "（409 冲突 / 201 创建 / 200 关闭这类语义）有没有对应实现、前端路由与页面是否接得上。",
        "不得：跑服务、发 HTTP、宣布验收通过；也不得替司机改代码。",
        "★ 你**没有执行权**，所以状态码的真实行为只能给「实现是否存在」的静态线索，其余进 cannotVerify。",
    ].join(" "),
};

/** 输出协议（LLM 驱动时拼在角色提示之后）：只允许返回结构化结果。
 *  导出给未来的生产适配器使用（本阶段零 LLM，不接真实模型）。 */
export const SUBAGENT_OUTPUT_PROTOCOL = [
    "# 输出协议（最高优先级）",
    "只输出一个 JSON 对象，形状固定为：",
    '{"ok":true,"rootCause":"<根因或引用证据>","evidence":[{"path":"<文件>","line":<可选行号>,"detail":"<引用>"}],',
    '"recommendedChanges":["<建议，不是动作>"],"risks":["<风险>"],"confidence":"high|medium|low","cannotVerify":["<无法确认项>"]}',
    "禁止出现任何其他字段（status/done/verified/passed/exitCode/budget 等一律不许出现）。",
    "readonly 字段由程序固定，你不需要也不能写。",
].join("\n");

// ============================================================
// 能力自述（给测试和审计用的代码事实，不是承诺）
// ============================================================

export function subagentCapabilities(): {
    canWrite: false; canExecute: false; canEmitTestPassed: false; canMutateState: false;
    canSendHub: false; canWriteLedger: false; tools: readonly string[];
} {
    return {
        canWrite: false, canExecute: false, canEmitTestPassed: false, canMutateState: false,
        canSendHub: false, canWriteLedger: false,
        tools: subagentToolNames(),
    };
}

// ============================================================
// LLM 端口（可选注入；本阶段零 LLM，不注入就是确定性分析）
// ============================================================

export interface ReadonlySubAgentLlmInput {
    role: ReadonlySubAgentRole;
    question: string;
    /** 机器证据（框架注入，只读引用） */
    evidence: ReadonlySubAgentEvidenceInput | undefined;
    /** 只读上下文摘要（由确定性检索先行收集，控制 token） */
    contextBrief: string;
}

/** Java 类比：这是接口，测试注 Fake，生产才注真实模型适配器 */
export interface ReadonlySubAgentLlm {
    readonly id: string;
    calls(): number;
    analyze(input: ReadonlySubAgentLlmInput): Promise<unknown>;
}

// ============================================================
// 派发器（规格五 / 六 / 九：时机闸门、去重、快照绑定、入账、超时、截断、预算）
// ============================================================

/** Ledger 事件类型（规格六.3） */
export const SUBAGENT_EVENTS = {
    requested: "subagent_requested",
    completed: "subagent_completed",
    failed: "subagent_failed",
    truncated: "subagent_truncated",
} as const;

/** 默认超时 120s（≤ 主 Agent 普通调用超时，规格九.3）；上限硬夹到 240s */
export const SUBAGENT_TIMEOUT_DEFAULT_MS = 120_000;
export const SUBAGENT_TIMEOUT_MAX_MS = 240_000;
/** 每任务子 Agent 调用硬上限（成本闸，规格九.1/9.2 的工程化落点） */
export const SUBAGENT_MAX_CALLS_DEFAULT = 3;

export interface SubagentOutcome {
    /** true = 主 Agent 可以拿 result 作为本次分析；false = 拒绝/失败（result 是失败壳或旧参考） */
    ok: boolean;
    result: ReadonlySubAgentResult;
    /** 本次调用绑定的失败签名（来自机器证据，或由 question 派生） */
    signature: string;
    /** 本次调用时的文件快照 hash（规格五.4） */
    snapshotHash: string;
    /** 复用历史结果（同一 signature 不重复调用，规格六.2/九.6） */
    reused?: boolean;
    /** 复用且快照已变化 → 只能作参考，不得直接复用（规格六.5，测试十.16） */
    stale?: boolean;
    /** 机器可读原因码 */
    code?: SubagentCode;
    message?: string;
    /** 本次是否真实消耗了一次子 Agent LLM 调用（预算同步用，规格九.1） */
    llmCallsPlanned: number;
    llmCallsCompleted: number;
}

export type SubagentCode =
    | "SUBAGENT_NOT_WIRED"        // 未接线（如实拒绝，不假装有结果）
    | "SUBAGENT_INVALID_REQUEST"  // role/question 非法
    | "SUBAGENT_DUPLICATE_SIGNATURE" // 同一 failureSignature 已调用过 → 不重复烧
    | "SUBAGENT_BUDGET_EXCEEDED"  // 达到每任务调用上限（规格九.8 交给主 Agent 正常预算流程）
    | "SUBAGENT_TIMEOUT"          // 超时 → 结构化失败（规格三.5/十.19）
    | "SUBAGENT_INVALID_RESULT"   // 返回没过 Schema → 拒绝进 Prompt（规格三.4/十.12/十.13）
    | "SUBAGENT_ANALYZER_FAILED"; // 分析器抛错 → 结构化失败

export type ReadonlySubAgentCall = (req: ReadonlySubAgentRequest) => Promise<SubagentOutcome>;

export interface ReadonlySubAgentDeps {
    workspace: Workspace;
    tools: ToolRegistry;
    ledger: DeveloperLedger;
    /** LLM 驱动（可选）。不注入 = 确定性零 LLM 分析。 */
    subagentLlm?: ReadonlySubAgentLlm;
    timeoutMs?: number;
    maxCallsPerTask?: number;
    /** 仅测试注入：替换/加码角色分析器（如模拟超时挂起、坏输出） */
    runners?: Partial<Record<ReadonlySubAgentRole, (box: ReadonlyToolbox, req: ReadonlySubAgentRequest) => Promise<unknown>>>;
}

/**
 * 构建子 Agent 派发器。返回的函数由**主 Agent 侧**（graph 注入到 ToolContext）调用：
 * 它负责闸门、去重、快照绑定、入账、超时、截断；分析器本体只见 box + req。
 */
export function createReadonlySubAgentDispatcher(deps: ReadonlySubAgentDeps) {
    const timeoutMs = Math.min(deps.timeoutMs ?? SUBAGENT_TIMEOUT_DEFAULT_MS, SUBAGENT_TIMEOUT_MAX_MS);
    const maxCalls = deps.maxCallsPerTask ?? SUBAGENT_MAX_CALLS_DEFAULT;

    /** taskId 由主 Agent 的 state 传入（子 Agent 永远看不到 state 本身） */
    return async function invoke(
        taskId: string,
        req: ReadonlySubAgentRequest,
        /** 框架注入的机器证据（TestAgent 原样回传）；优先级高于模型自述 */
        machineEvidence?: ReadonlySubAgentEvidenceInput,
    ): Promise<SubagentOutcome> {
        // ---- ① 请求合法性（非法 → 不跑任何分析，也不烧去重名额） ----
        const checked = ReadonlySubAgentRequestSchema.safeParse(req);
        if (!checked.success) {
            const why = checked.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
            deps.ledger.appendEvent(SUBAGENT_EVENTS.failed, { taskId, code: "SUBAGENT_INVALID_REQUEST", why });
            return {
                ok: false, code: "SUBAGENT_INVALID_REQUEST", message: `请求非法：${why}`,
                result: subagentFailureStruct("explorer", `请求非法（${why}）`),
                signature: "(invalid)", snapshotHash: "", llmCallsPlanned: 0, llmCallsCompleted: 0,
            };
        }
        const request = checked.data;
        // 机器证据只认框架注入的：模型传的自述证据会被标注"未经机器核验"
        const evidence: ReadonlySubAgentEvidenceInput | undefined = machineEvidence
            ? { ...request.evidence, ...machineEvidence }
            : request.evidence;

        // ---- ② 签名与快照绑定（规格六.4） ----
        const signature = (evidence?.failureSignature ?? "").trim()
            || hashOf({ role: request.role, question: request.question });
        const snapshotHash = deps.workspace.sourceSnapshot().hash;
        const llmUsed = deps.subagentLlm !== undefined && !deps.runners?.[request.role];

        // ---- ③ 成本闸（规格九：达到上限不再调用，主 Agent 走正常预算流程） ----
        if (deps.ledger.subagentCallCount() >= maxCalls) {
            deps.ledger.appendEvent(SUBAGENT_EVENTS.failed, {
                taskId, role: request.role, signature, code: "SUBAGENT_BUDGET_EXCEEDED",
            });
            return {
                ok: false, code: "SUBAGENT_BUDGET_EXCEEDED",
                message: `本任务子 Agent 调用已达上限（${maxCalls} 次），不再调用`,
                result: subagentFailureStruct(request.role, "达到子 Agent 调用上限"),
                signature, snapshotHash, llmCallsPlanned: 0, llmCallsCompleted: 0,
            };
        }

        // ---- ④ 去重（规格六.2：同一 failureSignature 最多一次；十.14/十.15） ----
        // claimSubagentCall 用 INSERT OR IGNORE 原子占位：抢不到 = 已经调过（含崩溃前调的）。
        const claimed = deps.ledger.claimSubagentCall({
            taskId, signature, role: request.role, snapshotHash,
        });
        if (!claimed) {
            const prior = deps.ledger.subagentCall(taskId, signature);
            const stale = !!prior && prior.snapshotHash !== snapshotHash;
            const reused = prior?.status === "done" && prior.result
                ? finalizeReadonlySubAgentResult(request.role, prior.result)
                : null;
            deps.ledger.appendEvent(SUBAGENT_EVENTS.requested, {
                taskId, role: request.role, signature, snapshotHash, dedup: true, stale,
            });
            if (prior && prior.status === "done" && reused?.ok) {
                deps.ledger.appendEvent(SUBAGENT_EVENTS.completed, {
                    taskId, role: request.role, signature, reused: true, stale,
                });
                return {
                    ok: !stale, reused: true, stale,
                    code: stale ? "SUBAGENT_DUPLICATE_SIGNATURE" : undefined,
                    message: stale
                        ? "同一 failureSignature 只调用一次；文件快照已变化，旧分析只能作参考，不能直接复用"
                        : "同一 failureSignature 只调用一次；返回此前分析结果",
                    result: reused.result, signature, snapshotHash,
                    llmCallsPlanned: 0, llmCallsCompleted: 0,
                };
            }
            // 之前调过但没成功（failed/timeout/损坏）→ 不自动重试（规格九.4）
            deps.ledger.appendEvent(SUBAGENT_EVENTS.failed, {
                taskId, role: request.role, signature, code: "SUBAGENT_DUPLICATE_SIGNATURE",
                priorStatus: prior?.status ?? "unknown",
            });
            return {
                ok: false, code: "SUBAGENT_DUPLICATE_SIGNATURE",
                message: `同一 failureSignature 已调用过子 Agent（上次状态：${prior?.status ?? "?"}），不重复调用、不自动重试`,
                result: subagentFailureStruct(request.role, "该签名已有调用记录"),
                signature, snapshotHash, llmCallsPlanned: 0, llmCallsCompleted: 0,
            };
        }

        deps.ledger.appendEvent(SUBAGENT_EVENTS.requested, {
            taskId, role: request.role, signature, snapshotHash,
            mode: deps.subagentLlm ? "llm" : "deterministic",
        });

        // ---- ⑤ 真实执行（只读工具盒在这里构建——分析器只拿得到它，别的都拿不到） ----
        const box = createReadonlyToolbox({
            workspace: deps.workspace, tools: deps.tools, taskId,
            owner: `subagent:${request.role}`, role: "readonly_subagent",
        });
        if (llmUsed) {
            // LLM 驱动：预占记账（崩溃不漏账，与 runToolLoop 同口径）
            deps.ledger.appendEvent("llm_call_planned", { taskId, kind: "subagent", signature });
        }

        let raw: unknown;
        try {
            raw = await runWithTimeout(request.role, box, request, evidence, deps, timeoutMs);
        } catch (e) {
            const reason = e === TIMEOUT_SENTINEL ? "timeout" : `analyzer_error`;
            const code: SubagentCode = e === TIMEOUT_SENTINEL ? "SUBAGENT_TIMEOUT" : "SUBAGENT_ANALYZER_FAILED";
            deps.ledger.settleSubagentCall({ taskId, signature, status: reason === "timeout" ? "timeout" : "failed", result: null });
            deps.ledger.appendEvent(SUBAGENT_EVENTS.failed, {
                taskId, role: request.role, signature, code,
                error: e === TIMEOUT_SENTINEL ? `超过 ${timeoutMs}ms` : (e as Error).message,
            });
            return {
                ok: false, code,
                message: e === TIMEOUT_SENTINEL
                    ? `子 Agent 超时（>${timeoutMs}ms），不自动重试`
                    : `子 Agent 分析器异常：${(e as Error).message}`,
                result: subagentFailureStruct(request.role, e === TIMEOUT_SENTINEL ? "超时" : "分析器异常"),
                signature, snapshotHash,
                llmCallsPlanned: llmUsed ? 1 : 0, llmCallsCompleted: 0,
            };
        }
        if (llmUsed) {
            deps.ledger.appendEvent("llm_call_completed", { taskId, kind: "subagent", signature });
        }

        // ---- ⑥ Schema 校验（非法返回绝不进主 Agent Prompt，规格三.4） ----
        const fin = finalizeReadonlySubAgentResult(request.role, raw);
        if (!fin.ok) {
            deps.ledger.settleSubagentCall({ taskId, signature, status: "failed", result: null });
            deps.ledger.appendEvent(SUBAGENT_EVENTS.failed, {
                taskId, role: request.role, signature, code: "SUBAGENT_INVALID_RESULT",
                error: fin.error,
                // 原始输出不进 Prompt；只落 Ledger 供审计回看
                rawPreview: typeof raw === "string" ? raw.slice(0, 4000) : canonicalJson(raw).slice(0, 4000),
            });
            return {
                ok: false, code: "SUBAGENT_INVALID_RESULT",
                // zod 细节只进 Ledger（上面的 failed 事件）；给模型的话术保持通用——
                // 报错文本本身也可能夹带原始输出的键名，一律不许回流到 Prompt（规格三.4）。
                message: "子 Agent 返回未通过 Schema 校验，已拒收；细节见 Ledger subagent_failed 事件",
                result: subagentFailureStruct(request.role, "返回未通过 Schema 校验（细节见 Ledger subagent_failed 事件）"),
                signature, snapshotHash,
                llmCallsPlanned: llmUsed ? 1 : 0, llmCallsCompleted: llmUsed ? 1 : 0,
            };
        }

        // ---- ⑦ 截断 + 入账（规格九.5） ----
        const { result, truncated } = truncateReadonlyResult(fin.result);
        if (truncated) {
            deps.ledger.appendEvent(SUBAGENT_EVENTS.truncated, {
                taskId, role: request.role, signature, raw: canonicalJson(fin.result).slice(0, 20_000),
            });
        }
        deps.ledger.settleSubagentCall({ taskId, signature, status: "done", result });
        deps.ledger.appendEvent(SUBAGENT_EVENTS.completed, {
            taskId, role: request.role, signature, snapshotHash,
            analysisOk: result.ok, confidence: result.confidence, truncated,
        });
        return {
            ok: true, result, signature, snapshotHash,
            llmCallsPlanned: llmUsed ? 1 : 0, llmCallsCompleted: llmUsed ? 1 : 0,
        };
    };
}

// ============================================================
// 超时执行（规格三.5 / 九.3 / 九.4：不抛裸异常、不自动重试）
// ============================================================

const TIMEOUT_SENTINEL = Symbol("subagent-timeout");

async function runWithTimeout(
    role: ReadonlySubAgentRole,
    box: ReadonlyToolbox,
    req: ReadonlySubAgentRequest,
    evidence: ReadonlySubAgentEvidenceInput | undefined,
    deps: ReadonlySubAgentDeps,
    timeoutMs: number,
): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = (async (): Promise<unknown> => {
        const custom = deps.runners?.[role];
        if (custom) return custom(box, req);          // 测试注入通道
        const brief = await buildContextBrief(role, box, req, evidence);
        if (deps.subagentLlm) {
            // LLM 驱动：把只读证据摘要交给模型，拿回候选结果（随后统一过 Schema）
            return deps.subagentLlm.analyze({ role, question: req.question, evidence, contextBrief: brief.text });
        }
        // 默认：确定性零 LLM 分析
        return brief.result;
    })();
    try {
        return await Promise.race([
            work,
            new Promise<never>((_, reject) => {
                // ★ 不要 unref 这个定时器：它是超时契约的实现本体。
                //   结束时 finally 里 clearTimeout，不会把测试/进程拖住。
                timer = setTimeout(() => reject(TIMEOUT_SENTINEL), timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

// ============================================================
// 只读证据收集（三个角色共用；每一步都只走白名单工具）
// ============================================================

interface Ev { path: string; line?: number; detail: string }

interface RoleBrief {
    /** 给 LLM 的上下文摘要（也进审计） */
    text: string;
    /** 确定性模式下直接组装出的结构化结果 */
    result: ReadonlySubAgentResult;
}

function parseHit(hit: string): Ev {
    const m = /^(.+?):(\d+):\s*(.*)$/.exec(hit);
    if (!m) return { path: "(检索输出)", detail: hit.slice(0, 300) };
    return { path: m[1]!, line: Number(m[2]), detail: m[3]!.slice(0, 300) };
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function briefRead(box: ReadonlyToolbox, p: string, maxBytes = 4000): Promise<string | null> {
    const r = await box.invoke("readFile", { path: p, maxBytes });
    return r.ok ? r.output : null;
}

async function briefSearch(box: ReadonlyToolbox, pattern: string, maxResults = 8): Promise<string[]> {
    const r = await box.invoke("search", { pattern, maxResults });
    if (!r.ok || r.output.startsWith("无命中")) return [];
    return r.output.split(/\r?\n/).filter(Boolean);
}

async function briefTree(box: ReadonlyToolbox): Promise<string[]> {
    const r = await box.invoke("inspectTree", { limit: 200 });
    if (!r.ok) return [];
    return r.output.split(/\r?\n/).slice(1).map((l) => l.trim()).filter(Boolean);
}

function evidenceFromMachine(ev: ReadonlySubAgentEvidenceInput | undefined, selfDeclared: boolean): string[] {
    if (!ev) return [];
    const src = selfDeclared ? "（发起方声明，未经机器核验）" : "（机器证据）";
    const lines: string[] = [`## 机器证据${src}`];
    if (ev.category) lines.push(`- category: ${ev.category}`);
    if (ev.command) lines.push(`- command: ${ev.command} ${(ev.args ?? []).join(" ")} @ ${ev.cwd ?? "."} → exit=${String(ev.exitCode ?? null)}`);
    if (ev.failureSignature) lines.push(`- failureSignature: ${ev.failureSignature}`);
    if (ev.affectedFiles?.length) lines.push(`- affectedFiles: ${ev.affectedFiles.join(", ")}`);
    if (ev.stdout) lines.push(`- stdout(截断): ${ev.stdout.slice(0, 1500)}`);
    if (ev.stderr) lines.push(`- stderr(截断): ${ev.stderr.slice(0, 1500)}`);
    return lines;
}

/** 按角色收集只读证据，产出（LLM 摘要 + 确定性结果） */
async function buildContextBrief(
    role: ReadonlySubAgentRole, box: ReadonlyToolbox,
    req: ReadonlySubAgentRequest, evidence: ReadonlySubAgentEvidenceInput | undefined,
): Promise<RoleBrief> {
    const files = await briefTree(box);
    switch (role) {
        case "explorer": return briefExplorer(box, req, files);
        case "debugger": return briefDebugger(box, req, evidence, files);
        case "ui-reviewer": return briefUiReviewer(box, req, files);
        case "architect-advisor": return briefArchitectAdvisor(box, req, files);
        case "acceptance-advisor": return briefAcceptanceAdvisor(box, req, files);
    }
}

// ---------- 架构顾问：结构性缺口（司机跑偏之前叫停） ----------

async function briefArchitectAdvisor(
    box: ReadonlyToolbox, req: ReadonlySubAgentRequest, files: string[],
): Promise<RoleBrief> {
    const evidence: Ev[] = [];
    const changes: string[] = [];
    const risks: string[] = [];
    const cannotVerify: string[] = [];

    // ① 工程文件：没有工程入口 = 踩在沙子上（编译/构建门立刻挂）
    const engFiles = files.filter((f) => ENGINEERING_FILES.includes(f.split("/").pop() ?? ""));
    for (const f of engFiles.slice(0, 6)) {
        evidence.push({ path: f, detail: "工程文件在位" });
    }
    if (engFiles.length === 0) {
        changes.push("没有任何可识别的工程文件（package.json / pom.xml / pyproject.toml…）：先落工程骨架再写业务，否则构建门必挂");
    }

    // ② 路由登记：契约里有页面但 router 表为空 → / 白屏（R6 事故的形状）
    const routerHits = await briefSearch(box, "path:\\s*['\"`]/", 8);
    const routerFile = files.find((f) => /router[\/\\](index\.)?(ts|js)$/.test(f)) ?? files.find((f) => /router\.(ts|js)$/.test(f)) ?? null;
    if (!routerFile) {
        changes.push("没有路由文件（frontend/src/router/index.ts 一类）：若契约要求多页面，/ 会白屏");
    } else if (routerHits.length === 0) {
        evidence.push({ path: routerFile, detail: "路由文件存在，但没有任何 path: 登记 —— / 白屏" });
        changes.push("在路由表里登记真实页面路由，并把首页同时注册到 path: \"/\"");
    } else {
        evidence.push(parseHit(routerHits[0]!));
    }

    // ③ 迁移文件：写了 DDL 却没人应用 → 表不存在 → 一片 500（R8 事故的形状）
    const ddlFile = files.find((f) => /(^|\/)(ddl|schema|init)\.sql$/.test(f)) ?? null;
    if (ddlFile) {
        const applied = await briefSearch(box, "init\\.sql|ddl\\.sql|schema\\.sql|readFileSync\\(.*\\.sql", 6);
        if (applied.length === 0) {
            evidence.push({ path: ddlFile, detail: "存在 DDL 文件，但全项目找不到任何引用它的地方（启动流程没接）" });
            changes.push("把 DDL 接进启动流程（或改用 ORM 自动建表），否则建表语句从不执行、接口全 500");
        } else {
            evidence.push(parseHit(applied[0]!));
        }
    }

    // ④ 契约文件在位性（契约是上下游的共同真相，缺了就是各写各的）
    const contractFile = files.find((f) => /CONTRACTS\.md$/i.test(f)) ?? null;
    if (!contractFile) {
        risks.push("没有找到 CONTRACTS.md：上下游对接口形状的共同约定缺失，容易出现前后端各写一套");
    }

    return {
        text: [
            `# Architect Advisor 只读摘要\n问题：${req.question}`,
            `工程文件 ${engFiles.length} 个；路由文件 ${routerFile ?? "（缺）"}；DDL ${ddlFile ?? "（无）"}；契约 ${contractFile ?? "（缺）"}`,
            ...evidence.map((e) => `- ${e.path}${e.line ? `:${e.line}` : ""} — ${e.detail}`),
        ].join("\n"),
        result: {
            role: "architect-advisor", ok: true,
            rootCause: evidence.length > 0
                ? `结构性线索 ${evidence.length} 条（工程入口 / 路由登记 / 迁移接入 / 契约在位，逐条见 evidence）`
                : "未发现结构性缺口（不代表设计正确——架构取舍仍需人判断）",
            evidence: evidence.slice(0, 15),
            recommendedChanges: changes.slice(0, 10),
            risks: [...risks, "本角色不做架构取舍决策：技术栈/目录约定属于架构师与人的判断，不在这里改"],
            confidence: evidence.length > 2 ? "medium" : "low",
            cannotVerify: [
                "「结构」是否**符合需求意图**（需需求原文 + 人的判断）",
                "接口真实行为 / 状态码语义（无执行权，不发 HTTP）",
                "构建是否真的通过（子 Agent 不跑 build）",
            ],
            readonly: true,
        },
    };
}

// ---------- 验收顾问：预判"拿去验收会挂在哪" ----------

async function briefAcceptanceAdvisor(
    box: ReadonlyToolbox, req: ReadonlySubAgentRequest, files: string[],
): Promise<RoleBrief> {
    const evidence: Ev[] = [];
    const changes: string[] = [];
    const risks: string[] = [];

    // ① 接口清单（静态）：后端到底注册了哪些方法+路径
    const routeHits = await briefSearch(box, "\\.(get|post|put|patch|delete)\\s*\\(", 16);
    const endpointHits = await briefSearch(box, "app\\.(get|post|put|patch|delete)|router\\.(get|post|put|patch|delete)|@(Get|Post|Put|Patch|Delete)Mapping|@RequestMapping", 16);
    const all = [...new Set([...routeHits, ...endpointHits])];
    for (const h of all.slice(0, 10)) evidence.push(parseHit(h));
    if (all.length === 0) {
        changes.push("静态检索不到任何 HTTP 接口注册：验收的接口断言会全部 404 —— 先确认后端入口与路由挂载方式");
    }

    // ② 状态码分支：409/201 这类语义断言是验收的重灾区
    const conflictHits = await briefSearch(box, "409|conflict|already|重复|已存在", 8);
    if (conflictHits.length === 0) {
        risks.push("找不到任何 409/冲突类分支：若判据要求「重复操作返回 409」，这条一定会挂（s5b 的 booking.* 就是这么全挂的）");
    } else {
        evidence.push(parseHit(conflictHits[0]!));
    }

    // ③ 前端是否接得上（有页面但没接口 / 有接口但没页面，都是验收挂点）
    const routerHits = await briefSearch(box, "path:\\s*['\"`]/", 8);
    if (all.length > 0 && routerHits.length === 0) {
        risks.push("有后端接口但前端没有任何路由登记：页面渲染判据会挂（/ 白屏）");
    }

    return {
        text: [
            `# Acceptance Advisor 只读摘要\n问题：${req.question}`,
            `静态接口命中 ${all.length} 处；409 类分支 ${conflictHits.length} 处；前端路由登记 ${routerHits.length} 处`,
            ...evidence.map((e) => `- ${e.path}${e.line ? `:${e.line}` : ""} — ${e.detail}`),
        ].join("\n"),
        result: {
            role: "acceptance-advisor", ok: true,
            rootCause: all.length > 0
                ? `静态接口清单 ${all.length} 处（含路由注册与状态码分支线索，逐条见 evidence）——拿去验收前请按判据逐条对账`
                : "静态检索不到接口注册，验收接口断言大概率全部 404",
            evidence: evidence.slice(0, 15),
            recommendedChanges: changes.slice(0, 10),
            risks: [...risks, "本角色**不执行**任何 HTTP：状态码的真实返回值只能由 runAcceptance / TestAgent 给证据"],
            confidence: all.length > 0 ? "medium" : "low",
            cannotVerify: [
                "真实响应状态码与响应体字段（无执行权，不发请求）",
                "鉴权/会话相关行为（需要跑起来的服务）",
                "并发与冲突在运行时是否真的互斥",
            ],
            readonly: true,
        },
    };
}

// ---------- Explorer：目录 / 工程文件 / 入口 / 缺失基础 ----------

const ENGINEERING_FILES = [
    "package.json", "pom.xml", "build.gradle", "build.gradle.kts", "pyproject.toml",
    "requirements.txt", "go.mod", "tsconfig.json", "vite.config.ts", "application.yml",
    "application.properties", "index.html",
];

async function briefExplorer(
    box: ReadonlyToolbox, req: ReadonlySubAgentRequest, files: string[],
): Promise<RoleBrief> {
    const evidence: Ev[] = [];
    const changes: string[] = [];
    const lines: string[] = [`# Explorer 只读摘要`, `问题：${req.question}`, `文件总数（截断至200）：${files.length}`];

    const engFiles = files.filter((f) => ENGINEERING_FILES.includes(f.split("/").pop() ?? ""));
    for (const f of engFiles.slice(0, 6)) {
        const content = await briefRead(box, f, 4000);
        if (content === null) continue;
        evidence.push({ path: f, detail: content.replace(/\s+/g, " ").slice(0, 200) });
        lines.push(`## ${f}\n${content.slice(0, 1200)}`);
    }
    if (engFiles.length === 0) {
        changes.push("工程根与 frontend/backend 里没有可识别的工程文件（package.json/pom.xml/…），核对 foundationPlan 是否尚未落骨架");
    }
    const entryHits = await briefSearch(
        box, "createApp|@SpringBootApplication|createServer|public static void main|func main", 10,
    );
    for (const h of entryHits) evidence.push(parseHit(h));
    if (entryHits.length === 0) {
        changes.push("未发现入口特征（createApp / @SpringBootApplication / createServer…），确认应用入口文件是否存在");
    }
    const hinted = (req.paths ?? []).slice(0, 5);
    for (const p of hinted) {
        const content = await briefRead(box, p, 4000);
        if (content === null) {
            evidence.push({ path: p, detail: "指定文件读取失败（可能不存在或在 allowedRoots 之外）" });
        } else {
            evidence.push({ path: p, detail: content.replace(/\s+/g, " ").slice(0, 200) });
        }
    }

    const confidence = evidence.length >= 3 ? "medium" : "low";
    return {
        text: lines.join("\n"),
        result: {
            role: "explorer", ok: true,
            rootCause: files.length === 0
                ? "生成项目当前没有可追踪的源码文件（空目录或全部被跳过）"
                : `项目静态概览：${files.length} 个文件；工程文件 ${engFiles.length} 个；入口命中 ${entryHits.length} 处`,
            evidence: evidence.slice(0, 15),
            recommendedChanges: changes.slice(0, 8),
            risks: ["这是静态只读摘要：不改变技术栈、不设计新业务、不输出完整代码文件"],
            confidence,
            cannotVerify: [
                "依赖能否真实安装 / 版本是否兼容（子 Agent 无执行权）",
                "运行时行为与接口是否真的可用（需 Developer 跑命令或 TestAgent 验收）",
            ],
            readonly: true,
        },
    };
}

// ---------- Debugger：机器证据 → 引用根因 + 文件行号线索 ----------

const FILE_LINE_RE = /([A-Za-z0-9_\-./\\]+\.(?:java|kt|kts|ts|tsx|js|jsx|vue|py|go|xml|yml|yaml|json|sql|html))[:\s]+(?:line\s+)?(\d+)/gi;
const ERROR_LINE_RE = /\b(error|errors|fatal|exception|cannot |unresolved|failed|FAIL|no such module|undefined is not)\b/i;

const CATEGORY_HINTS: Record<string, string> = {
    COMPILE: "优先核对报错行附近的类型/导入/依赖声明；找不到符号时先确认定义文件是否在 allowedRoots 内",
    BOOT: "优先核对端口占用、配置键、Bean/依赖注入与启动顺序",
    MIGRATION: "优先核对建表语句字段类型与库连接配置",
    CONTRACT: "优先核对路径 / 方法 / 请求体 / 状态码与 Contract 的差异",
    RENDER: "优先核对路由登记、组件导出、字段名前后端一致性",
    ENV: "多为环境缺失（依赖未装 / 命令不存在），不是代码问题——如实上报，别硬修",
};

async function briefDebugger(
    box: ReadonlyToolbox, req: ReadonlySubAgentRequest,
    evidenceIn: ReadonlySubAgentEvidenceInput | undefined, files: string[],
): Promise<RoleBrief> {
    const evidence: Ev[] = [];
    const changes: string[] = [];
    const machineLines = evidenceFromMachine(evidenceIn, false);
    const rawErrorText = [evidenceIn?.stdout ?? "", evidenceIn?.stderr ?? ""].join("\n");

    // ① 错误原文逐字引用（最多 6 条）——这是"表面根因"的唯一合法来源
    const quoted = rawErrorText.split(/\r?\n/)
        .map((l) => l.trim()).filter((l) => l && ERROR_LINE_RE.test(l)).slice(0, 6);
    for (const q of quoted) evidence.push({ path: "stderr/stdout（机器证据原文）", detail: q.slice(0, 300) });

    // ② 错误文本里指名的 file:line —— 先只读验证文件在不在
    const known = new Set(files.map((f) => f.replace(/\\/g, "/")));
    const pointers: { path: string; line: number }[] = [];
    let m: RegExpExecArray | null;
    FILE_LINE_RE.lastIndex = 0;
    while ((m = FILE_LINE_RE.exec(rawErrorText)) !== null && pointers.length < 8) {
        const p = (m[1] ?? "").replace(/\\/g, "/").replace(/^\.\/+/, "");
        const ln = Number(m[2]);
        const hit = [...known].find((f) => f === p || f.endsWith(`/${p}`) || p.endsWith(f));
        if (hit && Number.isFinite(ln)) pointers.push({ path: hit, line: ln });
    }
    for (const pt of pointers) {
        const content = await briefRead(box, pt.path, 4000);
        if (content === null) continue;
        const at = content.split(/\r?\n/)[pt.line - 1];
        evidence.push({
            path: pt.path, line: pt.line,
            detail: at !== undefined ? `当前内容第 ${pt.line} 行：${at.trim().slice(0, 240)}` : `文件存在但读不到第 ${pt.line} 行（可能已变化）`,
        });
        changes.push(`打开 ${pt.path}:${pt.line} 对照错误原文核对（先读现状，再决定改法）`);
    }

    // ③ affectedFiles 逐个只读确认
    for (const f of (evidenceIn?.affectedFiles ?? []).slice(0, 5)) {
        const r = await box.invoke("readFile", { path: f, maxBytes: 2000 });
        if (!r.ok) evidence.push({ path: f, detail: `affectedFile 读取失败：${r.output.slice(0, 160)}` });
    }

    const cannotVerify: string[] = [
        "修复后能否变绿——子 Agent 无执行权，必须由 Developer 重跑同一条失败命令验证",
        "运行时行为（端口、外部依赖、真实 HTTP 响应）",
    ];
    if (pointers.length === 0) cannotVerify.push("错误文本没有指到可验证的文件行——以下线索不构成确定根因");

    const category = evidenceIn?.category ?? "";
    if (CATEGORY_HINTS[category]) changes.push(CATEGORY_HINTS[category]!);

    const confidence = pointers.length > 0 && quoted.length > 0 ? "medium" : "low";
    return {
        text: [...machineLines, ...evidence.map((e) => `- ${e.path}${e.line ? `:${e.line}` : ""} — ${e.detail}`)].join("\n"),
        result: {
            role: "debugger", ok: true,
            rootCause: quoted.length > 0
                ? `证据表面原因（逐字引用，不是推测）：「${quoted[0]!.slice(0, 240)}」；定位到 ${pointers.length} 个文件行号线索`
                : "（所给机器证据里没有可解析的错误行，无法确定表面原因——不做猜测性结论）",
            evidence: evidence.slice(0, 15),
            recommendedChanges: changes.slice(0, 10),
            risks: ["以上是静态证据分析；任何'可能/优先核对'都是线索而非结论，改法由 Developer 决定"],
            confidence,
            cannotVerify,
            readonly: true,
        },
    };
}

// ---------- UI Reviewer：路由登记 / 空页 / 状态 / UI 库混用 / 白屏线索 ----------

async function briefUiReviewer(
    box: ReadonlyToolbox, req: ReadonlySubAgentRequest, files: string[],
): Promise<RoleBrief> {
    const evidence: Ev[] = [];
    const changes: string[] = [];
    const risks: string[] = [];
    const feFiles = files.filter((f) => f.startsWith("frontend/"));
    const views = feFiles.filter((f) => /\/(views|pages)\//.test(f) && /\.(vue|tsx|jsx)$/.test(f));
    // 路由文件两种写法都要认：src/router/index.ts（目录式）与 src/router.ts（单文件式）
    const routerFile = feFiles.find((f) => /\.(ts|js)$/.test(f)
        && (/(^|\/)(router|routes)\/[^/]+\.(ts|js)$/.test(f) || /(^|\/)(router|routes)\.(ts|js)$/.test(f))) ?? null;

    let routerText = "";
    if (routerFile) {
        routerText = (await briefRead(box, routerFile, 8000)) ?? "";
        evidence.push({ path: routerFile, detail: `路由文件 ${routerText.length} 字节（已读入比对）` });
    } else if (views.length > 0) {
        evidence.push({ path: "frontend/src", detail: "存在页面文件但未发现 router/routes 文件——页面可能没挂上路由（白屏风险）" });
        changes.push("补建路由登记，并确认 App.vue 里有 <router-view/> 出口");
    }

    if (routerText) {
        // ① 路由指向的文件是否真实存在
        const compRe = /import\(\s*["'`]([^"'`]+)["'`]\s*\)|from\s+["'`]([^"'`]*(?:views|pages)[^"'`]*)["'`]/g;
        let mm: RegExpExecArray | null;
        let checkedRoutes = 0;
        while ((mm = compRe.exec(routerText)) !== null && checkedRoutes < 10) {
            const rawRef = mm[1] ?? mm[2] ?? "";
            // 相对引用（../views/X.vue、./X）统一按后缀在项目文件里找——
            // 找不到对应文件是典型的白屏根因线索。
            const suffix = rawRef.replace(/^(@\/|\.\/|\.\.\/)+/, "");
            const hit = files.find((f) => f === suffix || f.endsWith(`/${suffix}`)
                || f.endsWith(`/${suffix}.vue`) || f.endsWith(`/${suffix}.tsx`));
            if (!hit) {
                evidence.push({ path: routerFile ?? "router", detail: `路由引用 ${rawRef} 找不到对应文件——典型白屏根因` });
                checkedRoutes++;
            }
        }
        // ② views 里有没有没登记的页面
        for (const v of views.slice(0, 12)) {
            const base = v.split("/").pop()!.replace(/\.(vue|tsx|jsx)$/, "");
            if (!routerText.includes(base)) {
                evidence.push({ path: v, detail: "页面文件未出现在路由里（可能没挂路由）" });
            }
        }
    }

    // ③ 空壳页面 + 状态覆盖
    for (const v of views.slice(0, 6)) {
        const content = await briefRead(box, v, 4000);
        if (content === null) continue;
        const tpl = /<template>([\s\S]*)<\/template>/.exec(content);
        if (tpl && tpl[1]!.trim().length < 25) {
            evidence.push({ path: v, detail: "模板接近空壳（只有容器没有内容）——build 能过但页面没东西" });
            changes.push(`${v}：补真实业务内容，别停在演示壳`);
        }
        if (!/loading|empty|error|success/i.test(content)) {
            changes.push(`${v}：未见 loading / empty / error / success 状态处理`);
        }
    }

    // ④ UI 库混用检查
    const epHits = await briefSearch(box, escapeRegExp("@element-plus"), 4);
    const tdHits = await briefSearch(box, "tdesign(-vue-next|-vue)?", 4);
    if (epHits.length > 0 && tdHits.length > 0) {
        risks.push("Element Plus 与 TDesign 同时被引用——违反单一 UI 库约定，主题与组件行为会互相打架");
        evidence.push({ path: epHits[0]!.split(":")[0]!, detail: `EP 命中；TDesign 也命中：${tdHits[0]!.slice(0, 120)}` });
        changes.push("按选定基线统一组件库，清掉另一家的 import 与全局注册");
    }

    // ⑤ 挂载入口
    const mainTs = feFiles.find((f) => /src\/main\.(ts|js)$/.test(f));
    if (!mainTs && feFiles.length > 0) {
        evidence.push({ path: "frontend/src/main.ts", detail: "未找到挂载入口——index.html 存在也照样白屏" });
    }

    return {
        text: [
            `# UI Reviewer 只读摘要\n问题：${req.question}`,
            `页面文件 ${views.length} 个；路由文件 ${routerFile ?? "（缺）"}`,
            ...evidence.map((e) => `- ${e.path}${e.line ? `:${e.line}` : ""} — ${e.detail}`),
        ].join("\n"),
        result: {
            role: "ui-reviewer", ok: true,
            rootCause: evidence.length > 0
                ? `静态线索汇总：${evidence.length} 条（路由登记/页面内容/状态处理/UI 库各占其几，逐条见 evidence）`
                : "未发现值得警示的前端静态线索（不代表渲染正确——那需要运行证据）",
            evidence: evidence.slice(0, 15),
            recommendedChanges: changes.slice(0, 10),
            risks: [...risks, "白屏判定只能给'可能性'：子 Agent 不跑 build、不发 HTTP、不看截图"],
            confidence: evidence.length > 2 ? "medium" : "low",
            cannotVerify: [
                "页面实际渲染 / 真实白屏行为（需 Developer 起服务 + httpRequest，或 TestAgent 验收）",
                "视觉层级与响应式效果是否符合设计要求（静态代码看不出来）",
                "接口数据是否真的可用（无执行权，不推断 HTTP）",
            ],
            readonly: true,
        },
    };
}

// ============================================================
// LLM 输出的宽容入口：把模型/注入分析器的产物转成候选对象（仅解析，不校验）
//   —— 给生产适配器用；校验永远在 finalizeReadonlySubAgentResult 那一刀。
// ============================================================

export function coerceReadonlyRequest(args: ToolArgs): ReadonlySubAgentRequest {
    const role = String(args["role"] ?? "").trim() as ReadonlySubAgentRole;
    const question = String(args["question"] ?? "").trim();
    const paths = Array.isArray(args["paths"]) ? (args["paths"] as unknown[]).map(String) : undefined;
    const ev = args["evidence"];
    const evidence = ev && typeof ev === "object" && !Array.isArray(ev)
        ? (ev as ReadonlySubAgentEvidenceInput)
        : undefined;
    return { role, question, ...(paths ? { paths } : {}), ...(evidence ? { evidence } : {}) };
}
