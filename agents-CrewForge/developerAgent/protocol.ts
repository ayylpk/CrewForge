// ============================================================
// protocol.ts —— Hub 消息类型与运行时校验
//
//   入站（Developer 接收）：
//     architect_task / test_failure / test_passed / repair_requested / cancel_task / resume_task
//   出站（Developer 发送）：
//     developer_started / developer_progress / test_request / repair_started /
//     repair_finished / developer_ready / developer_blocked / developer_failed
//
//   非法消息一律**拒绝**（不猜测、不静默吞掉），由调用方写进 Ledger。
//   这里的校验只做结构；权限与状态迁移分别在 workspace.ts / state.ts。
// ============================================================

import { z } from "zod";
import { hashOf } from "./ledger";

// ============================================================
// 入站消息
// ============================================================

export const TestFailureCategorySchema = z.enum(["COMPILE", "BOOT", "MIGRATION", "CONTRACT", "RENDER", "ENV"]);
export type TestFailureCategory = z.infer<typeof TestFailureCategorySchema>;

/**
 * 独立 TestAgent 交回的**机器证据**：一条检查一条。
 * 必须带执行事实（命令 / 退出码 / 起止时间 / 各段 hash），不能是自然语言结论——
 * 这就是「任意 Hub 发送者都能伪造通过」这个漏洞的封堵点。
 */
export const VerificationEvidenceSchema = z.object({
    checkId: z.string().min(1),
    command: z.string().min(1),
    args: z.array(z.string()),
    cwd: z.string(),
    exitCode: z.number().int(),
    startedAt: z.number().int(),
    finishedAt: z.number().int(),
    inputHash: z.string().min(1),
    stdoutHash: z.string().min(1),
    stderrHash: z.string().min(1),
});
export type VerificationEvidence = z.infer<typeof VerificationEvidenceSchema>;

/**
 * 同一轮验收中除主失败外的全部失败证据（用于避免逐条揭示红项）。
 *
 *   证据字段必须和主失败同口径：Developer 拿到红单要能直接判断"这条是编译红了
 *   还是启动超时了"。所以执行事实（timedOut / 起止时间 / 耗时）原样带着走——
 *   压缩成"checkId + stderr"会丢掉超时这一类最关键的线索。
 *   除 failureSignature 外全部可选：旧发送方只给基础字段时仍然兼容。
 */
export const AdditionalFailureSchema = z.object({
    checkId: z.string().min(1), category: TestFailureCategorySchema,
    command: z.string(), args: z.array(z.string()), cwd: z.string(),
    exitCode: z.number().nullable(), stdout: z.string(), stderr: z.string(),
    failureSignature: z.string().min(1),
    /** 超时被杀 → true（exitCode=null）。旧消息可缺省 */
    timedOut: z.boolean().optional(),
    startedAt: z.number().int().optional(),
    finishedAt: z.number().int().optional(),
    durationMs: z.number().optional(),
});
export type AdditionalFailure = z.infer<typeof AdditionalFailureSchema>;

// ============================================================
// 语义审查（TestAgent 第二段）在 Developer 侧的类型
//
//   为什么这些要进协议：Developer 修的不只是"命令退了个非 0"——它还要修
//   "页面是占位、数据只在内存、把验收固定值抄进代码"这类**机械脚本看不出来**的问题。
//   审查发现必须结构化地到手上，且**全量**，不能压成一句话。
// ============================================================

export const ReviewSeveritySchema = z.enum(["critical", "major", "minor"]);
/** 审查类别（与 TestAgent src/review.ts 一一对应） */
export const REVIEW_CATEGORIES = ["PLACEHOLDER", "PERSISTENCE", "SPEC_GAMING", "UI", "CONTRACT", "OTHER"] as const;
export const ReviewCategorySchema = z.enum(REVIEW_CATEGORIES);

export const ReviewFindingSchema = z.object({
    severity: ReviewSeveritySchema,
    category: ReviewCategorySchema,
    title: z.string().min(1),
    /** 文件行号 / 机器输出 / HTTP 响应——没有证据的猜测不该出现在这里 */
    evidence: z.array(z.string()),
    recommendation: z.string(),
});
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

export const LlmReviewSchema = z.object({
    reviewVerdict: z.enum(["pass", "fail", "uncertain"]),
    findings: z.array(ReviewFindingSchema),
    confidence: z.enum(["high", "medium", "low"]),
});
export type LlmReview = z.infer<typeof LlmReviewSchema>;

/** 机械证据（显式标注"机器产物"）：与 allFailures 同源，但独立成字段便于消费方区分来源 */
export const MechanicalEvidenceSchema = z.object({
    checkId: z.string().min(1),
    category: TestFailureCategorySchema,
    command: z.string(),
    args: z.array(z.string()),
    cwd: z.string(),
    exitCode: z.number().nullable(),
    timedOut: z.boolean(),
    startedAt: z.number().int(),
    finishedAt: z.number().int(),
    durationMs: z.number(),
    stdout: z.string(),
    stderr: z.string(),
    failureSignature: z.string().min(1),
});
export type MechanicalEvidence = z.infer<typeof MechanicalEvidenceSchema>;

/** 审查审计：落 Ledger 用（谁审、审的什么、审了多久、烧了多少 token） */
export const ReviewAuditSchema = z.object({
    model: z.string(),
    promptHash: z.string().min(1),
    evidenceHash: z.string().min(1),
    durationMs: z.number(),
    tokenUsage: z.object({
        inputTokens: z.number(), outputTokens: z.number(), totalTokens: z.number(),
    }).nullable(),
});
export type ReviewAudit = z.infer<typeof ReviewAuditSchema>;

/** TestAgent 的失败证据：**原样**回传，不允许只给自然语言摘要 */
export const TestFailureSchema = z.object({
    type: z.literal("test_failure"),    // 固定字面量，区分消息类型
    messageId: z.string().min(1),       // 消息唯一标识
    correlationId: z.string().min(1),   // 关联 ID，串联同一任务链路
    runId: z.string().min(1),           // 本次运行的唯一标识
    acceptanceHash: z.string().min(1),  // 验收标准哈希
    projectId: z.string().min(1),       // 项目标识
    taskId: z.string().min(1),          // 任务标识
    category: TestFailureCategorySchema, // 失败分类
    command: z.string(),                // 执行的命令
    args: z.array(z.string()),          // 命令参数
    cwd: z.string(),                    // 工作目录
    exitCode: z.number().nullable(),    // 退出码，未跑起来为 null
    stdout: z.string(),                 // 标准输出，原样回传
    stderr: z.string(),                 // 标准错误，原样回传
    affectedFiles: z.array(z.string()), // 受影响文件列表
    failureSignature: z.string().min(1),// 失败签名，用于去重
    /** 本轮其它失败；可选以兼容旧 TestAgent，存在时必须是同一轮真实证据 */
    allFailures: z.array(AdditionalFailureSchema).optional(),
    /** 失败来源：命令退出码，还是语义审查判定。缺省按 mechanical（兼容旧消息） */
    origin: z.enum(["mechanical", "llm_review"]).optional(),
    /** true = 需要人工确认（审查不可用/不确定），不是交给 Developer 去修的代码问题 */
    needsHuman: z.boolean().optional(),
    /** 机械证据（机器产物，非模型生成） */
    mechanicalEvidence: z.array(MechanicalEvidenceSchema).optional(),
    /** 语义审查结论（含 findings 全量）；null/缺省 = 审查不可用 */
    llmReview: LlmReviewSchema.nullable().optional(),
    /** 确定性预扫信号（带证据的怀疑） */
    reviewSignals: z.array(ReviewFindingSchema).optional(),
    reviewStatus: z.enum(["ok", "LLM_REVIEW_UNAVAILABLE", "disabled"]).optional(),
    reviewReason: z.string().nullable().optional(),
    reviewAudit: ReviewAuditSchema.nullable().optional(),
    /** 阻断性发现的标题（便于日志与去重） */
    blockingFindingTitles: z.array(z.string()).optional(),
});
export type TestFailure = z.infer<typeof TestFailureSchema>;

// ============================================================
// 架构师任务包里的**结构化业务输入**（规格八.7：不再用 unknown）
//
//   为什么必须是「有形状」的：unknown 意味着下游只能靠 JSON.stringify 猜，
//   workItems 这种东西一旦没有 schema，Skill 调度就只能退回"看目录空不空"猜——
//   这正是规格七点名要修的问题。
//   `.passthrough()`：已知字段必须有，业务方额外补充的字段保留（不静默丢弃）。
// ============================================================

/** 需求快照：用户到底要做什么 */
export const RequirementSnapshotSchema = z.looseObject({
    goal: z.string().min(1),
});
export type RequirementSnapshot = z.infer<typeof RequirementSnapshotSchema>;

/** 技术栈：由架构师选定，Developer 不得自换 */
export const StackProfileSchema = z.looseObject({
    frontend: z.string().min(1),
    backend: z.string().min(1),
    database: z.string().min(1).optional(),
});
export type StackProfile = z.infer<typeof StackProfileSchema>;

/** 领域模型：实体 / 表 / 字段的权威定义，防止模型自创表名 */
export const DomainModelSchema = z.looseObject({
    entity: z.string().min(1),
});
export type DomainModel = z.infer<typeof DomainModelSchema>;

/** 接口契约：端点清单与期望状态码 */
export const ContractSchema = z.looseObject({
    version: z.string().min(1),
    endpoints: z.array(z.unknown()),
});
export type Contract = z.infer<typeof ContractSchema>;

/** 验收检查项：TestAgent 与 Developer 必须对同一份内容算出同一个 acceptanceHash */
export const AcceptanceCheckSchema = z.looseObject({
    id: z.string().min(1),
});
export type AcceptanceCheck = z.infer<typeof AcceptanceCheckSchema>;

/**
 * 结构化工作项（规格七）：Skill 由**它**决定，不由"目录是否为空"猜。
 *   inspect → 看现状 / foundation → 搭基础骨架 / backend·frontend·database → 写业务
 *   failure → 排错 / pre-test → 送检前自检
 */
export const WorkItemKindSchema = z.enum([
    "inspect", "foundation", "backend", "frontend", "database", "failure", "pre-test",
]);
export type WorkItemKind = z.infer<typeof WorkItemKindSchema>;

export const WorkItemSchema = z.object({
    id: z.string().min(1),
    kind: WorkItemKindSchema,
    title: z.string().optional(),
    /** 该工作项涉及的项目内路径，供 Skill 与自检定位 */
    paths: z.array(z.string()).optional(),
});
export type WorkItem = z.infer<typeof WorkItemSchema>;

/** workItem.kind → 该阶段加载的 Skill（一一对应，代码维护） */
export const WORK_ITEM_SKILL: Record<WorkItemKind, string> = {
    inspect: "inspect-project",
    foundation: "bootstrap-project",
    backend: "backend-development",
    frontend: "frontend-development",
    database: "database-development",
    failure: "debugging",
    "pre-test": "verification",
};

export function skillForWorkItem(kind: WorkItemKind): string {
    return WORK_ITEM_SKILL[kind];
}

/** 基础目录计划：目录 + 结构化工作项 */
export const FoundationPlanSchema = z.looseObject({
    dirs: z.array(z.string()),
    workItems: z.array(WorkItemSchema).optional(),
});
export type FoundationPlan = z.infer<typeof FoundationPlanSchema>;

/**
 * 兼容旧任务包：`foundationPlan.dirs` 里只写了目录名时的**确定性**推导。
 * 这不是"猜"——映射表写死在代码里，且会记一条 Ledger 事件让它可见。
 */
export function deriveWorkItems(plan: FoundationPlan | null): WorkItem[] {
    if (!plan) return [];
    const explicit = plan.workItems ?? [];
    if (explicit.length > 0) return explicit;
    const kinds: WorkItemKind[] = [];
    for (const dir of plan.dirs) {
        const d = dir.replace(/\\/g, "/").toLowerCase();
        const kind: WorkItemKind | null =
            d.includes("back") ? "backend"
                : d.includes("front") || d.includes("web") || d.includes("ui") ? "frontend"
                    : d.includes("db") || d.includes("sql") || d.includes("database") || d.includes("migration") ? "database"
                        : d.includes("docs") || d.includes("test") ? null
                            : "foundation";
        if (kind && !kinds.includes(kind)) kinds.push(kind);
    }
    return kinds.map((kind) => ({ id: `derived-${kind}`, kind }));
}

/**
 * 架构师下发的任务包 —— Developer 工作所需的**完整且唯一**输入。
 *
 *   三类信息（讲这个结构时按这三类说）：
 *     ① 身份：projectId / taskId —— 所有出站消息、Ledger 记录、审计条目都靠它们对上号；
 *     ② 权限：allowedRoots（写盘范围，**只能收窄**：最终生效 = 入口配置 ∩ 任务声明，
 *        交集运算在 graph.ts 的 intersectRoots）/ forbiddenPaths（在入口配置之上只能加不能减）；
 *     ③ 干活要看的资料：requirementSnapshot / stackProfile / domainModel / contract /
 *        foundationPlan / acceptanceChecks / developerInstructions —— 全部由代码拼进
 *        prompt 模板，它们只决定"模型知道什么"，不决定"模型能写哪"。
 *
 *   铁律：
 *     · 这个包里**没有**权威字段（done / verified / status / evidence……），
 *       权威判定永远不在模型侧，只在外部 TestAgent 与 Orchestrator；
 *     · 业务输入全部走明确 schema（规格八.7），不再用 unknown —— 没有 workItems 的
 *       schema，Skill 调度就只能退回"看目录空不空"猜；
 *     · 模型收到的是**只读快照**，改不了它，也没有任何字段能扩大自己的权限。
 */
export const ArchitectTaskSchema = z.object({
    type: z.literal("architect_task"),                 // 固定字面量，区分消息类型
    projectId: z.string().min(1),                      // 项目标识
    taskId: z.string().min(1),                         // 任务标识
    requirementSnapshot: RequirementSnapshotSchema,    // 需求快照，本次任务要达成的目标
    stackProfile: StackProfileSchema,                  // 技术栈画像，框架/语言/工具链约定
    domainModel: DomainModelSchema,                    // 领域模型，核心实体与关系
    contract: ContractSchema,                          // 接口契约，模块间约定
    foundationPlan: FoundationPlanSchema,              // 基础设施计划，项目骨架与依赖
    allowedRoots: z.array(z.string()),                 // 允许操作的根目录白名单
    forbiddenPaths: z.array(z.string()),               // 禁止触碰的路径黑名单
    acceptanceChecks: z.array(AcceptanceCheckSchema),  // 验收检查项列表
    developerInstructions: z.string(),                 // 给 Developer Agent 的额外指令
});
export type ArchitectTask = z.infer<typeof ArchitectTaskSchema>;

/**
 * 测试通过：**必须带真实机器证据**，并带足身份字段供接收方逐项核对。
 * 光有 evidence 不够——还得能证明「这条消息确实是受信 TestAgent 针对本次任务发的」。
 */
export const TestPassedSchema = z.object({
    type: z.literal("test_passed"),
    messageId: z.string().min(1),
    correlationId: z.string().min(1),
    projectId: z.string().min(1),
    taskId: z.string().min(1),
    runId: z.string().min(1),
    evidence: z.array(VerificationEvidenceSchema).min(1),
    verifiedBy: z.string().min(1),
    acceptanceHash: z.string().min(1),
});
export type TestPassed = z.infer<typeof TestPassedSchema>;

export const RepairRequestedSchema = z.object({
    type: z.literal("repair_requested"),
    projectId: z.string().min(1),
    taskId: z.string().min(1),
    reason: z.string(),
});
export type RepairRequested = z.infer<typeof RepairRequestedSchema>;

export const CancelTaskSchema = z.object({
    type: z.literal("cancel_task"),
    projectId: z.string().min(1),
    taskId: z.string().optional(),
    reason: z.string().optional(),
});
export type CancelTask = z.infer<typeof CancelTaskSchema>;

export const ResumeTaskSchema = z.object({
    type: z.literal("resume_task"),
    projectId: z.string().min(1),
    taskId: z.string().min(1),
});
export type ResumeTask = z.infer<typeof ResumeTaskSchema>;

const INBOUND_SCHEMAS = [
    ArchitectTaskSchema, TestFailureSchema, TestPassedSchema,
    RepairRequestedSchema, CancelTaskSchema, ResumeTaskSchema,
] as const;

export type InboundMessage = ArchitectTask | TestFailure | TestPassed | RepairRequested | CancelTask | ResumeTask;

export type ParseResult =
    | { ok: true; message: InboundMessage }
    | { ok: false; error: string; raw: unknown };

/** 边界解析：JSON 字符串或对象都能吃；结构不符即拒绝 */
export function parseInbound(raw: unknown): ParseResult {
    let value: unknown = raw;
    if (typeof raw === "string") {
        try { value = JSON.parse(raw); } catch { return { ok: false, error: "不是合法 JSON", raw }; }
    }
    if (!value || typeof value !== "object") return { ok: false, error: "消息不是对象", raw };
    const type = (value as { type?: unknown }).type;
    if (typeof type !== "string") return { ok: false, error: "缺少 type 字段", raw };

    for (const schema of INBOUND_SCHEMAS) {
        const literal = schema.shape.type as z.ZodLiteral<string>;
        if (literal.value !== type) continue;
        const parsed = schema.safeParse(value);
        if (!parsed.success) {
            const why = parsed.error.issues.map((i) => `${i.path.join(".") || "$"}: ${i.message}`).join("; ");
            return { ok: false, error: `字段不合法（${type}）：${why}`, raw };
        }
        return { ok: true, message: parsed.data as InboundMessage };
    }
    return { ok: false, error: `未知消息类型：${type}`, raw };
}

// ============================================================
// 出站消息（Developer → 外部）
// ============================================================

export interface DeveloperStarted { type: "developer_started"; projectId: string; taskId: string; at: number }
export interface DeveloperProgress { type: "developer_progress"; projectId: string; taskId: string; stage: string; note: string }
export interface TestRequest {
    type: "test_request";
    projectId: string;
    taskId: string;
    /** 本轮关联 id：TestAgent 必须把它原样带回，接收方据此判断消息是否属于本次请求 */
    correlationId: string;
    /** 当前验收输入的指纹：TestAgent 必须回同一个值，否则视为拿旧结论糊弄 */
    acceptanceHash: string;
    /** 等待截止时刻（epoch ms）：超时后到达的结果视为过期（规格三.10） */
    deadlineAt: number;
    targets: string[];
    reason: string;
}
export interface RepairStarted { type: "repair_started"; projectId: string; taskId: string; failureSignature: string; attempt: number }
export interface RepairFinished { type: "repair_finished"; projectId: string; taskId: string; failureSignature: string; changedFiles: string[] }
export interface DeveloperReady { type: "developer_ready"; projectId: string; taskId: string; changedFiles: string[]; summary: string }
export interface DeveloperBlocked { type: "developer_blocked"; projectId: string; taskId: string; reason: string; failureSignature: string | null }
export interface DeveloperFailed { type: "developer_failed"; projectId: string; taskId: string; error: string }

export type OutboundMessage =
    | DeveloperStarted | DeveloperProgress | TestRequest | RepairStarted
    | RepairFinished | DeveloperReady | DeveloperBlocked | DeveloperFailed;

export const OUTBOUND_TYPES = [
    "developer_started", "developer_progress", "test_request", "repair_started",
    "repair_finished", "developer_ready", "developer_blocked", "developer_failed",
] as const;

// ============================================================
// 权威字段禁令：这些词只能由程序产生，模型输出里出现即拦
//   （对齐 engine2/types.ts 的同类机制，规模按本模块需要裁剪）
// ============================================================

export const AUTHORITY_FIELDS = [
    "done", "verified", "passed", "exitCode", "evidence", "failureCategory", "budget", "status",
] as const;

export function findAuthorityFields(value: unknown, at = "$"): string[] {
    const hits: string[] = [];
    const walk = (node: unknown, path: string): void => {
        if (node == null || typeof node !== "object") return;
        if (Array.isArray(node)) {
            node.forEach((item, i) => walk(item, `${path}[${i}]`));
            return;
        }
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
            const lower = k.toLowerCase();
            // 两侧都要小写再比：AUTHORITY_FIELDS 里有 camelCase 项（exitCode / failureCategory），
            // 只把 key 转小写的话这两项**永远匹配不上**——等于禁令形同虚设（9/13 被测试逮到）。
            if ((AUTHORITY_FIELDS as readonly string[]).some((f) => f.toLowerCase() === lower)) hits.push(`${path}.${k}`);
            walk(v, `${path}.${k}`);
        }
    };
    walk(value, at);
    return hits;
}

export class AuthorityFieldViolation extends Error {
    readonly fields: string[];
    constructor(step: string, fields: string[]) {
        super(`${step}：模型输出出现权威字段（只能由程序产生）：${fields.join("、")}`);
        this.name = "AuthorityFieldViolation";
        this.fields = fields;
    }
}

/** 每轮 LLM 出口都要过这里：先禁权威字段，再交给调用方做形状校验 */
export function assertNoAuthorityFields(step: string, value: unknown): void {
    const fields = findAuthorityFields(value);
    if (fields.length > 0) throw new AuthorityFieldViolation(step, fields);
}

// ============================================================
// 验收输入指纹 + TestAgent 信任校验
//
//   为什么要这层：TestPassed 光有 evidence 还不够——任何往 Hub 里塞消息的人
//   都能编一份 evidence 出来。所以还要三件事一起成立：
//     ① 发送方在**代码配置**的受信名单里（名单不来自消息）；
//     ② 身份字段（projectId/taskId/runId/correlationId）与当前等待的任务逐项相等；
//     ③ acceptanceHash 与当前验收输入一致（防止拿旧版本的通过结论糊弄）。
//   任何一条不满足 → 拒绝，并把原因写进 Ledger。
// ============================================================

/** 规范化 JSON：递归排序对象键，保证同一份语义永远得到同一个字符串 */
export function canonicalJson(value: unknown): string {
    const walk = (node: unknown): unknown => {
        if (node === null || typeof node !== "object") return node;
        if (Array.isArray(node)) return node.map(walk);
        const obj = node as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(obj).sort()) out[key] = walk(obj[key]);
        return out;
    };
    return JSON.stringify(walk(value) ?? null);
}

/**
 * 验收输入指纹。Developer 与 TestAgent 必须对**同一份 acceptanceChecks**
 * 算出同一个 hash，否则 pass 一律拒绝。
 */
export function acceptanceHashOf(acceptanceChecks: unknown): string {
    return hashOf(canonicalJson(acceptanceChecks));
}

export interface TestTrustContext {
    /** 受信的独立 TestAgent 名字（来自代码配置，绝不来自消息内容） */
    trustedSenders: readonly string[];
    projectId: string;
    taskId: string;
    runId: string;
    correlationId: string;
    acceptanceHash: string;
}

export interface TrustVerdict {
    ok: boolean;
    reasons: string[];
}

function checkIdentity(
    msg: { projectId: string; taskId: string; runId: string; correlationId: string; acceptanceHash: string },
    sender: string,
    ctx: TestTrustContext,
): string[] {
    const why: string[] = [];
    if (!ctx.trustedSenders.includes(sender)) {
        why.push(`发送方「${sender}」不在受信 TestAgent 名单（${ctx.trustedSenders.join(", ") || "空"}）`);
    }
    if (msg.projectId !== ctx.projectId) why.push(`projectId 不匹配（${msg.projectId} ≠ ${ctx.projectId}）`);
    if (msg.taskId !== ctx.taskId) why.push(`taskId 不匹配（${msg.taskId} ≠ ${ctx.taskId}）`);
    if (msg.runId !== ctx.runId) why.push(`runId 不匹配（${msg.runId} ≠ ${ctx.runId}）`);
    if (msg.correlationId !== ctx.correlationId) why.push("correlationId 不匹配（过期或串线消息）");
    if (msg.acceptanceHash !== ctx.acceptanceHash) why.push("acceptanceHash 不匹配（验收输入已变）");
    return why;
}

/** 全部条件满足才算通过；任何一条不满足，原因都要能落到 Ledger */
export function validateTestPassed(msg: TestPassed, sender: string, ctx: TestTrustContext): TrustVerdict {
    const reasons = checkIdentity(msg, sender, ctx);
    if (msg.evidence.length === 0) reasons.push("evidence 为空");
    msg.evidence.forEach((e, i) => {
        if (e.exitCode !== 0) reasons.push(`evidence[${i}](${e.checkId}) exitCode=${e.exitCode} ≠ 0`);
        if (e.finishedAt < e.startedAt) reasons.push(`evidence[${i}](${e.checkId}) 起止时间倒挂`);
    });
    return { ok: reasons.length === 0, reasons };
}

export function validateTestFailure(msg: TestFailure, sender: string, ctx: TestTrustContext): TrustVerdict {
    const reasons = checkIdentity(msg, sender, ctx);
    return { ok: reasons.length === 0, reasons };
}
