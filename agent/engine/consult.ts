// ============================================================
// consult.ts —— 「召唤工位」协议（层 B：从只读顾问升级到**有职权的工位**）
//
//   背景（与 developerAgent/tools/readonlySubAgent.ts 的 advisor 层配对）：
//     层 A（已有）：司机（developer）在循环里可以召唤 architect-advisor /
//       acceptance-advisor —— 它们只给**意见**，改动永远由司机落笔。
//     层 B（本文件）：司机可以召唤**真工位**（architect / pm / test-core /
//       maintainer），被召唤的工位对**它自己拥有的产物**有职权：
//         架构师可以修订计划 / 重发批次；测试可以澄清判据；PM 可以澄清需求；
//         维护者可以出验收/搁置说明。
//
//   铁律（与全仓一致，不是本文件自创）：
//     ① 工位**永远不写生成项目的代码**——写盘/执行是司机独有的权限
//        （registry.ts PRIVILEGED_TOOLS：只有角色 developer 能写盘 / 执行 / 起进程）；
//     ② 消息里只有**身份与问题**，不搬数据真相：任务包/判据/计划的权威副本
//        仍在 sys_task / 任务包 / _tasks 落盘里。把整份计划塞进消息 = 制造第二份真相，
//        两边一旦漂移，谁也说不清哪份算数（protocol.ts 头注释同一条规矩）。
//
//   为什么 amendment 必须是**封闭白名单 + 出票方绑定**：
//     "谁有权改哪件东西"如果只是一个约定，模型一句"我以架构师身份决定改成…"就能越权。
//     所以 kind 是 z.enum（不在白名单里的种类整体拒绝），且每个 kind 只允许
//     **一个**工位签发（AMENDMENT_ISSUERS），签发方与 kind 不匹配 → 解析期即拒
//     （parseConsultReply 的越权闸）。这与 registry.ts 把角色闸写在代码里、而不是
//     写在提示词里，是同一个手法。
// ============================================================

import { z } from "zod";

// ============================================================
// 参与者（谁在说话）
// ============================================================

/**
 * 四个**工位**角色。刻意不含 "developer"：
 *   · 工位 = 有职权、可被召唤、可签发 amendment 的一方；
 *   · developer（司机）= 发起方，它没有 amendment 签发权（它本来就拥有写盘权，
 *     但它**不能替工位说话**——司机自签的"计划已修订"没有任何效力）。
 */
export const CONSULT_ROLES = ["architect", "pm", "test-core", "maintainer"] as const;
export type ConsultRole = (typeof CONSULT_ROLES)[number];

export function isConsultRole(value: unknown): value is ConsultRole {
    return typeof value === "string" && (CONSULT_ROLES as readonly string[]).includes(value);
}

export const ConsultRoleSchema = z.enum(CONSULT_ROLES);

/** 司机在协议里的身份（from 字段的合法值之一） */
export const CONSULT_DRIVER = "developer";
export type ConsultDriver = typeof CONSULT_DRIVER;

export const CONSULT_PARTICIPANTS = [CONSULT_DRIVER, ...CONSULT_ROLES] as const;
export type ConsultParticipant = (typeof CONSULT_PARTICIPANTS)[number];
export const ConsultParticipantSchema = z.enum(CONSULT_PARTICIPANTS);

/**
 * 工位角色 → Hub 注册名。
 *   为什么要有这张表：角色名是**语义**（pm = 项目经理），Hub 座位名是**部署事实**
 *   （projectRunner 里 PM 的收件箱一直是 "manager"，architectTaskBuilder 失败上报
 *   默认也发给 "manager"）。把它写在一处，免得每个调用点各拼一次字符串——
 *   拼错一个字母的消息会静默躺进一个没人消费的空箱（9/2 阶段1：工位缺席 = 死等）。
 */
export const CONSULT_STATION_NAMES: Record<ConsultRole, string> = {
    architect: "architect",
    pm: "manager",
    "test-core": "test-core",
    maintainer: "maintainer",
};

// ============================================================
// 请求（司机 → 工位）
// ============================================================

export const ConsultRequestSchema = z.strictObject({
    type: z.literal("consult_request"),
    projectId: z.string().min(1),
    taskId: z.string().min(1),
    /** 一次召唤的唯一 id（newConsultId 生成，可复现——幂等/去重的锚点） */
    consultId: z.string().min(1),
    /** 发起方（本部署里恒为 "developer"） */
    from: ConsultParticipantSchema,
    /** 被召唤的工位；被召唤方必须**只回答发给自己的请求** */
    to: ConsultRoleSchema,
    question: z.string().min(1),
    /** 想让它重点看的东西（项目内相对路径 / 判据 id / 工作项 id），不是数据载体 */
    focus: z.array(z.string()).optional(),
    /**
     * 发起方附的证据（命令输出摘要等）。
     * ★ 这是**发起方声明**，不是机器证据——机器证据的权威口径在 TestAgent 回传
     *   的 evidence（protocol.ts VerificationEvidence），这里只做问题背景。
     */
    evidence: z.record(z.string(), z.unknown()).optional(),
});
export type ConsultRequest = z.infer<typeof ConsultRequestSchema>;

// ============================================================
// 修订（工位对自己产物的**职权动作**）
// ============================================================

export const AMENDMENT_KINDS = [
    "plan_revision",              // 修订计划（架构师）
    "batch_resend",               // 重发批次（架构师）
    "criterion_clarification",    // 澄清验收判据（测试）
    "requirement_clarification",  // 澄清需求（PM）
    "acceptance_note",            // 验收/搁置说明（维护者，或测试）
] as const;
export type AmendmentKind = (typeof AMENDMENT_KINDS)[number];

export const AmendmentKindSchema = z.enum(AMENDMENT_KINDS);

/**
 * kind → 唯一有资格签发它的工位（封闭表，不是提示词里的君子协定）。
 *   · plan_revision / batch_resend 只能是架构师——计划与批次是它冻结的产物；
 *   · criterion_clarification 只能是测试——判据的语义解释权在判定方；
 *   · requirement_clarification 只能是 PM——需求原文的解释权在 PM；
 *   · acceptance_note 归维护者（记账/收敛方），测试也可签发（同一件产物：验收结论的注脚）。
 */
export const AMENDMENT_ISSUERS: Record<AmendmentKind, readonly ConsultRole[]> = {
    plan_revision: ["architect"],
    batch_resend: ["architect"],
    criterion_clarification: ["test-core"],
    requirement_clarification: ["pm"],
    acceptance_note: ["maintainer", "test-core"],
};

/** 越权闸的唯一判据（协议解析、工位应答、测试三处共用同一份实现） */
export function isAmendmentAllowedFor(role: ConsultRole | string, kind: AmendmentKind | string): boolean {
    const issuers = (AMENDMENT_ISSUERS as Record<string, readonly ConsultRole[] | undefined>)[kind];
    if (!issuers) return false;                                  // 白名单外的 kind 一律不许
    return issuers.includes(role as ConsultRole);
}

/** 谁有资格签这类修订（拒绝话术里要写清"该找哪个工位"，不能只说"不行"） */
export function amendmentIssuersOf(kind: AmendmentKind | string): readonly ConsultRole[] {
    return (AMENDMENT_ISSUERS as Record<string, readonly ConsultRole[] | undefined>)[kind] ?? [];
}

export const ConsultAmendmentSchema = z.strictObject({
    kind: AmendmentKindSchema,
    /** 人可读的修订说明（进司机上下文，必须能自解释） */
    detail: z.string().min(1),
    /**
     * 结构化载荷（如 {itemId:"w3"} / {checkId:"ac-2"}）。
     * ★ 只允许**指路**（id、路径、澄清文本），不允许承载"计划全文"——
     *   数据真相在任务包/_tasks 里，消息里塞全文等于制造第二份真相。
     */
    payload: z.record(z.string(), z.unknown()).optional(),
});
export type ConsultAmendment = z.infer<typeof ConsultAmendmentSchema>;

// ============================================================
// 回复（工位 → 司机）
// ============================================================

export const ConsultReplySchema = z.strictObject({
    type: z.literal("consult_reply"),
    projectId: z.string().min(1),
    taskId: z.string().min(1),
    /** 原样回带，司机按 (consultId, projectId, taskId) 三元组配对 */
    consultId: z.string().min(1),
    /** 签发方 = 被召唤的工位（**不是**请求里的 to 的复读，而是应答者的自称） */
    from: ConsultRoleSchema,
    answer: z.string(),
    /** null/缺省 = 只有意见，没有任何职权动作生效 */
    amendment: ConsultAmendmentSchema.nullable().optional(),
    confidence: z.enum(["high", "medium", "low"]),
    /** 本次应答真实消耗的 LLM 调用数（0 或 1；司机把它计入自己的 LLM 台账） */
    costLlmCalls: z.number().int().min(0),
    /** 非空 = 这次没给答案（投递错误/越权/内部异常），司机必须看见原因，不许静默 */
    refused: z.string().nullable().optional(),
});
export type ConsultReply = z.infer<typeof ConsultReplySchema>;

// ============================================================
// 解析（口径与 developerAgent/protocol.ts 的 parseInbound 一致：
//       非法消息**拒绝**并给出逐条原因，绝不猜测、绝不静默吞）
// ============================================================

export type ConsultParseResult<T> =
    | { ok: true; value: T }
    | { ok: false; reasons: string[] };

function zodReasons(error: z.ZodError): string[] {
    return error.issues.map((i) => `${i.path.join(".") || "$"}: ${i.message}`);
}

/** JSON 字符串或对象都能吃（Hub 的 content 是字符串，单测直接喂对象） */
function asObject(raw: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; reasons: string[] } {
    let value: unknown = raw;
    if (typeof raw === "string") {
        try { value = JSON.parse(raw); } catch { return { ok: false, reasons: ["不是合法 JSON"] }; }
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { ok: false, reasons: ["消息不是对象"] };
    }
    return { ok: true, value: value as Record<string, unknown> };
}

export function parseConsultRequest(raw: unknown): ConsultParseResult<ConsultRequest> {
    const obj = asObject(raw);
    if (!obj.ok) return obj;
    const parsed = ConsultRequestSchema.safeParse(obj.value);
    if (!parsed.success) return { ok: false, reasons: zodReasons(parsed.error) };
    const req = parsed.data;
    const reasons: string[] = [];
    // 自己问自己 = 协议层就拦（工位不会给自己派活，放进去只会在应答侧变成一句更含糊的拒绝）
    if (req.from === req.to) reasons.push(`from 与 to 相同（${req.to}）：召唤必须有明确的两端`);
    if (req.from !== CONSULT_DRIVER) {
        reasons.push(`from 必须是司机「${CONSULT_DRIVER}」，实际是「${req.from}」——工位之间不走这条通道`);
    }
    return reasons.length > 0 ? { ok: false, reasons } : { ok: true, value: req };
}

/**
 * 回复解析 = 结构校验 + **越权闸**。
 *   越权闸放在这里而不是只放在工位里：司机收到任何来源的回复都要过同一道闸，
 *   否则一个写着 kind:"plan_revision" 而 from:"maintainer" 的包照样能进司机上下文。
 */
export function parseConsultReply(raw: unknown): ConsultParseResult<ConsultReply> {
    const obj = asObject(raw);
    if (!obj.ok) return obj;
    const parsed = ConsultReplySchema.safeParse(obj.value);
    if (!parsed.success) return { ok: false, reasons: zodReasons(parsed.error) };
    const reply = parsed.data;
    const reasons: string[] = [];
    const amendment = reply.amendment ?? null;
    if (amendment && !isAmendmentAllowedFor(reply.from, amendment.kind)) {
        const issuers = amendmentIssuersOf(amendment.kind);
        reasons.push(
            `越权修订：工位「${reply.from}」无权签发 ${amendment.kind}`
            + `（该 kind 的签发方是 ${issuers.join(" / ") || "无人"}）`,
        );
    }
    return reasons.length > 0 ? { ok: false, reasons } : { ok: true, value: reply };
}

// ============================================================
// 事件名（写 Ledger 时逐字使用这些常量——字符串散落各处的老问题不再重演）
// ============================================================

export const CONSULT_EVENTS = {
    requested: "consult_requested",
    replied: "consult_replied",
    timeout: "consult_timeout",
    refused: "consult_refused",
    /** 重放命中（同一 consultId / 同一问题再来一次）→ 复用已有回复，不重复烧 LLM */
    replayed: "consult_replayed",
} as const;

// ============================================================
// consultId
// ============================================================

/**
 * 确定性 consultId（幂等友好的锚点）。
 *
 *   为什么不带时间戳/随机数：同一个 (taskId, seq) 必须永远得到同一个 id——
 *   崩溃重放、同一条工具调用重试时，司机与工位两侧算出的 id 要能对上，
 *   否则"同一次召唤"会被当成两次（重发一条消息 = 再烧一次工位 LLM）。
 *   序号由调用方按"本次召唤是第几次"这一事实给出（司机侧用咨询计数器的下一次值）。
 */
export function newConsultId(taskId: string, seq: number): string {
    const n = Number.isFinite(seq) && seq > 0 ? Math.floor(seq) : 1;
    // taskId 消毒：它会被拼进日志/文件名语义里，不允许夹带路径分隔符等怪异字符
    const safe = String(taskId ?? "").replace(/[^A-Za-z0-9._-]/g, "_");
    return `consult-${safe}-${n}`;
}
