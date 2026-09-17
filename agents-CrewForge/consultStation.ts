// ============================================================
// consultStation.ts —— 工位侧的「被召唤」应答器（四个工位共用这一份）
//
//   分工：
//     · 司机侧（developerAgent/index.ts）负责**怎么把请求送到、怎么等回复**；
//     · 本文件负责**收到请求之后怎么答**——被召唤的工位在这里把自己的
//       ownContext()（它此刻真正持有的产物）与司机的问题拼成一个**有界**提示词，
//       要么交给注入的 LLM，要么做**只复述不推断**的确定性回答。
//
//   三条结构性保证（都写在代码里，不写在提示词里）：
//     ① **永不抛**：任何内部异常都收敛成一条 refused 回复——司机永远拿得到一个
//        可据以行动的结果，而不是一个把整轮工具循环打死的异常（askHuman 同款口径）；
//     ② **不编事实**：没有 LLM 时只把 ownContext 原文（有界截断 + 明示省略）交回去，
//        并把"本工位此刻不知道"写清楚——沉默不许被读成"没问题"；
//     ③ **不给越权**：amendment 必须过 isAmendmentAllowedFor，且必须有 amend 通道
//        才算生效；没有通道就只当**意见**转述，回复文本里明说"未落任何改动"。
//
//   为什么工位拿不到写盘能力：ConsultContext 里根本没有 workspace / 写文件 / 执行
//   成员——不是"约定不要写"，而是**接口上没有那个口**（与 readonlySubAgent.ts 的
//   "子 Agent 运行环境里没有写入口"是同一个手法；写盘永远只有司机有）。
// ============================================================

import {
    CONSULT_DRIVER, amendmentIssuersOf, isAmendmentAllowedFor, isConsultRole, parseConsultRequest,
} from "./consult";
import type { ConsultAmendment, ConsultReply, ConsultRequest, ConsultRole } from "./consult";

/** 司机附的证据进提示词的上限（发起方声明，只是问题背景，不必全文） */
export const CONSULT_EVIDENCE_MAX_CHARS = 2_000;

/**
 * ownContext 进提示词的默认预算（字符）。
 *   对齐 graph.ts 的 MODEL_ARG_FIELD_LIMIT=4096：一次召唤占的上下文不该比一次
 *   普通工具调用更大——否则"召唤"会变成另一条把窗口顶爆的喂料环（9/15 批 B 立过案）。
 */
export const CONSULT_CONTEXT_BUDGET_CHARS = 4_096;

/** 硬上限：调用方给再大也不越过它（4000 是**默认**，1.2 万是**天花板**） */
export const CONSULT_CONTEXT_MAX_CHARS = 12_000;

/** 回复正文进司机上下文的上限（超出显式截断，不静默砍尾——与 clipForModel 同口径） */
export const CONSULT_ANSWER_MAX_CHARS = 8_000;

/** 超预算时的显式省略标记（模型/审计都能看出这里少了东西） */
export function truncationMarker(omitted: number): string {
    return `\n⋯[本段超预算，已省略 ${omitted} 字符；需要全文请直接读该工位自己的产物]⋯\n`;
}

/** 有界截断：超限时保留头部 + **明示**省略量（绝不静默砍尾） */
export function boundContextText(text: string, budget: number): { text: string; truncated: boolean; omitted: number } {
    const s = String(text ?? "");
    if (s.length <= budget) return { text: s, truncated: false, omitted: 0 };
    const omitted = s.length - budget;
    return { text: s.slice(0, budget) + truncationMarker(omitted), truncated: true, omitted };
}

/**
 * 工位接口——这是**工位能做的一切**。
 *   ownContext()：它此刻真正持有的东西（蓝图/批次、判据、需求原文、收敛状态…），
 *                 由各工位自己实现，必须是**事实**而不是总结。
 *   llm?        ：可选注入（超时/重试由调用方负责，与 readonlySubAgent 的 LLM 端口同约定）；
 *                 不注入 = 确定性回答（confidence: "low"，并明说没有 LLM）。
 *   amend?      ：**只有真正拥有该产物的工位才允许注入**。没注入 = 本部署里该工位
 *                 只有建议权（amendment 只作为意见转述，绝不假装已生效）。
 *   maxContextChars?：本工位愿意暴露的上下文预算（缺省 CONSULT_CONTEXT_BUDGET_CHARS）。
 * ★ 接口里**没有** workspace / writeFile / runCommand / send 任何一格：
 *   工位永远不写生成项目的代码，这一条靠"没有那个口"成立，而不是靠自觉。
 */
export interface ConsultContext {
    role: ConsultRole;
    /** 本工位服务的项目；空串 = 不持该维度（不构成拒绝理由，见 handleConsultRequest 的身份闸） */
    projectId: string;
    /** 本工位绑定的任务；空串 = 不绑定单一任务（如架构师服务整个阶段） */
    taskId: string;
    ownContext(): Promise<string>;
    llm?(prompt: string): Promise<string>;
    amend?(a: ConsultAmendment): Promise<boolean>;
    maxContextChars?: number;
}

/**
 * 能力自述（给测试与审计看的**代码事实**，不是承诺）。
 *   canSendHub: false 指的是**本应答器**不会往 Hub 发东西——回信是由工位自己的
 *   消息循环发出的（且只寄给 CONSULT_DRIVER 司机）：工位不能主动广播、不能点名
 *   给别人发消息、也不能改别人的产物。这条区分很要紧：不然"工位能发消息"
 *   会被读成"工位可以把指令塞进流水线的任何一端"。
 */
export function consultCapabilities(): {
    canWriteGeneratedProject: false; canExecute: false; canSendHub: false;
    canMutateTaskPackage: false; canIssueAmendmentWithoutOwner: false;
    roles: readonly ConsultRole[];
} {
    return {
        canWriteGeneratedProject: false,
        canExecute: false,
        canSendHub: false,
        canMutateTaskPackage: false,
        canIssueAmendmentWithoutOwner: false,
        roles: ["architect", "pm", "test-core", "maintainer"],
    };
}

// ============================================================
// 角色口径（代码常量——不新增用户可编辑 Prompt，与 SUBAGENT_ROLE_PROMPTS 同规矩）
// ============================================================

export const CONSULT_ROLE_PROMPTS: Record<ConsultRole, string> = {
    architect: [
        "你是架构师工位，被司机（developer）在施工中途召唤。你**拥有**这个阶段的技术栈、",
        "目录/工作项计划（蓝图）与批次（architect_batch）——你可以修订计划、重发批次，",
        "但你不能写生成项目的代码，也不能替司机改任何文件。",
        "回答时只讲你**拥有的事实**：工作项清单与顺序、已交付批次、判据 id、技术栈约束；",
        "拿不准的进 answer 里明说'这一点我需要看 X'，不要猜。",
    ].join(" "),
    pm: [
        "你是项目经理工位（PM），被司机在施工中途召唤。你**拥有**需求原文与阶段计划——",
        "需求有歧义时，你有权给出澄清（requirement_clarification）；",
        "但你不能改代码、不能改架构师的技术栈选择、不能宣布验收通过。",
        "回答必须落在需求原文与已澄清内容上：原文里没写的，就说'需求未写明'，绝不替用户发明需求。",
    ].join(" "),
    "test-core": [
        "你是测试工位（test-core），被司机在施工中途召唤。你**拥有**验收判据的语义解释权——",
        "哪条判据要求什么、某个状态码/字段是不是判据的本意，你有权澄清（criterion_clarification）。",
        "你**没有**判定权：通过/不通过只能来自独立 TestAgent 的机器证据，你不得口头宣布通过，",
        "也不得改判据本身（改判据=改考试题）。判据原文不在你手上时，如实说你手上只有哪些 id。",
    ].join(" "),
    maintainer: [
        "你是维护者工位（maintainer），被司机在施工中途召唤。你**拥有**收敛与记账口径——",
        "哪些任务已定论、哪些失败被搁置、阶段何时算完成；你可以出验收/搁置说明（acceptance_note）。",
        "你不能改代码、不能改判据、不能替测试宣布通过。回答只讲你手上真实的记账状态，",
        "没有的状态就说'未收到'，不要推测流水线里别人干了什么。",
    ].join(" "),
};

/**
 * 输出协议：只允许一个 JSON 对象。
 *   为什么必须结构化：司机要**机器可用**地知道"这次有没有生效的修订"，
 *   而自然语言里的一句"我已修订"是不可核验的——它与"我以为它改了"只差一个人。
 */
export const CONSULT_OUTPUT_PROTOCOL = [
    "# 输出协议（最高优先级）",
    "只输出一个 JSON 对象，形状固定为：",
    '{"answer":"<基于你持有的事实作答；不确定的明说不确定>",',
    ' "amendment":{"kind":"plan_revision|batch_resend|criterion_clarification|requirement_clarification|acceptance_note",',
    '"detail":"<修订内容>","payload":{}} 或 null,',
    '"confidence":"high|medium|low","refused":null 或 "<拒绝回答的原因>"}',
    "禁止出现任何其他字段；没有职权动作时 amendment 必须是 null。",
    "不要输出 Markdown 代码块以外的解释文字。",
].join("\n");

// ============================================================
// LLM 输出的结构化提取（拿不准就退回原文，绝不猜）
// ============================================================

export interface StationOutput {
    answer: string;
    amendment: ConsultAmendment | null;
    confidence: "high" | "medium" | "low";
    refused: string | null;
    /** true = 模型输出不是约定 JSON，answer 是**原文转述**（没有提取到任何修订） */
    rawFallback: boolean;
}

/** 从文本里找出所有能 JSON.parse 的平衡花括号片段（模型爱把 JSON 包在话里） */
function jsonObjectsIn(text: string, limit = 4): unknown[] {
    const out: unknown[] = [];
    for (let i = 0; i < text.length && out.length < limit; i++) {
        if (text[i] !== "{") continue;
        let depth = 0;
        let inStr = false;
        let esc = false;
        let j = i;
        for (; j < text.length; j++) {
            const ch = text[j]!;
            if (inStr) {
                if (esc) esc = false;
                else if (ch === "\\") esc = true;
                else if (ch === '"') inStr = false;
                continue;
            }
            if (ch === '"') { inStr = true; continue; }
            if (ch === "{") depth++;
            else if (ch === "}") { depth--; if (depth === 0) { j++; break; } }
        }
        const slice = text.slice(i, j);
        try { out.push(JSON.parse(slice)); } catch { /* 不是 JSON 片段：跳过 */ }
        i = j - 1;
    }
    return out;
}

function asAmendment(value: unknown): ConsultAmendment | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const v = value as Record<string, unknown>;
    const kind = typeof v["kind"] === "string" ? v["kind"] : "";
    const detail = typeof v["detail"] === "string" ? v["detail"] : "";
    if (!kind || !detail) return null;
    const payload = v["payload"];
    return {
        kind: kind as ConsultAmendment["kind"],
        detail,
        ...(payload && typeof payload === "object" && !Array.isArray(payload)
            ? { payload: payload as Record<string, unknown> }
            : {}),
    };
}

/** 模型输出 → 结构化回答；认不出来就退回"原文转述 + 低置信 + 无修订" */
export function parseStationOutput(raw: string): StationOutput {
    const text = String(raw ?? "");
    for (const candidate of jsonObjectsIn(text)) {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
        const o = candidate as Record<string, unknown>;
        if (typeof o["answer"] !== "string") continue;
        const confidence = o["confidence"] === "high" || o["confidence"] === "medium" || o["confidence"] === "low"
            ? o["confidence"]
            : "low";
        const refused = typeof o["refused"] === "string" && o["refused"] ? o["refused"] : null;
        return {
            answer: o["answer"],
            amendment: asAmendment(o["amendment"]),
            confidence,
            refused,
            rawFallback: false,
        };
    }
    return {
        answer: text.trim(),
        amendment: null,
        confidence: "low",
        refused: null,
        rawFallback: true,
    };
}

// ============================================================
// 应答主入口
// ============================================================

function text(v: unknown): string {
    return typeof v === "string" ? v.trim() : v === undefined || v === null ? "" : String(v);
}

/** 回复构造的唯一出口（形状由协议决定，这里不重复发明字段） */
function buildReply(o: {
    projectId: string; taskId: string; consultId: string; from: ConsultRole;
    answer: string; amendment?: ConsultAmendment | null; confidence: "high" | "medium" | "low";
    costLlmCalls: number; refused?: string | null;
}): ConsultReply {
    const bounded = boundContextText(o.answer, CONSULT_ANSWER_MAX_CHARS).text;
    return {
        type: "consult_reply",
        projectId: o.projectId,
        taskId: o.taskId,
        consultId: o.consultId,
        from: o.from,
        answer: bounded,
        amendment: o.amendment ?? null,
        confidence: o.confidence,
        costLlmCalls: o.costLlmCalls,
        refused: o.refused ?? null,
    };
}

/**
 * 处理一条召唤请求。**永不抛**——任何内部异常都变成一条 refused 回复。
 *
 *   闸的顺序（每一道都给出**具体**理由，不做"我不知道所以拒答"）：
 *     ① 结构：走 parseConsultRequest（非法形状/from 不是司机 → refused，附逐条原因）；
 *     ② 投递：req.to 必须等于本工位角色——错了就如实说"你发错人了"，**绝不静默丢**；
 *     ③ 身份：只在**双方都持有**该维度时才比（工位持有的项目/任务为空 = 不持该维度，
 *        不构成拒绝理由。比如架构师服务整个阶段、不绑定单一 taskId——因为"我不认识它"
 *        而拒答，会让正确的召唤也失败）；
 *     ④ 作答：有 LLM 走一次有界调用；没有 LLM 只复述 ownContext（低置信、不推断）；
 *     ⑤ 修订：越权/无通道 → 只当意见；有通道 → amend() 并如实记录是否生效。
 */
export async function handleConsultRequest(req: ConsultRequest, ctx: ConsultContext): Promise<ConsultReply> {
    // 运行期入参可能是**没解析过的裸对象**（工位消息循环直接喂 data），ctx 的字段也可能是
    // 带副作用的 getter——所以连"我是谁"都要防御式取，取值本身不许把异常抛出去。
    const rawReq = (req ?? {}) as unknown as Record<string, unknown>;
    const safeRole = (): ConsultRole => {
        try { if (isConsultRole(ctx?.role)) return ctx.role; } catch { /* 取不到，往下走 */ }
        const to = rawReq["to"];
        // 连自己是谁都取不到时的最后兜底：用**请求声明的接收方**当自称——
        // 它比"随便编一个工位名"更接近事实（且 answer 里写清了这是内部异常）。
        return isConsultRole(to) ? to : "maintainer";
    };
    const safeText = (f: () => unknown): string => {
        try { return text(f()); } catch { return ""; }
    };

    const fallback = {
        projectId: text(rawReq["projectId"]) || safeText(() => ctx.projectId),
        taskId: text(rawReq["taskId"]) || safeText(() => ctx.taskId),
        consultId: text(rawReq["consultId"]) || "(missing-consultId)",
    };
    const refuse = (why: string, extra?: Partial<{ projectId: string; taskId: string; consultId: string; costLlmCalls: number }>): ConsultReply =>
        buildReply({
            projectId: extra?.projectId ?? fallback.projectId,
            taskId: extra?.taskId ?? fallback.taskId,
            consultId: extra?.consultId ?? fallback.consultId,
            from: safeRole(),
            answer: why,
            confidence: "low",
            costLlmCalls: extra?.costLlmCalls ?? 0,
            refused: why,
        });

    try {
        // ---- ① 结构 ----
        const parsed = parseConsultRequest(rawReq);
        if (!parsed.ok) return refuse(`召唤请求不合法，已拒绝并原样带回原因：${parsed.reasons.join("；")}`);
        const q = parsed.value;
        const ids = { projectId: q.projectId, taskId: q.taskId, consultId: q.consultId };

        // ---- ② 投递 ----
        if (q.to !== ctx.role) {
            return refuse(
                `投递错误：本工位是「${ctx.role}」，这条 consult_request 指定的接收方是「${q.to}」——`
                + "我没有替你转发（转发的消息会带着我的身份骗过接收方），请把它发给正确的工位。",
                ids,
            );
        }

        // ---- ③ 身份（只在双方都持有该维度时比）----
        const mismatches: string[] = [];
        if (ctx.projectId && q.projectId !== ctx.projectId) mismatches.push(`projectId（请求 ${q.projectId} ≠ 本工位 ${ctx.projectId}）`);
        if (ctx.taskId && q.taskId !== ctx.taskId) mismatches.push(`taskId（请求 ${q.taskId} ≠ 本工位 ${ctx.taskId}）`);
        if (mismatches.length > 0) {
            return refuse(`身份不符：${mismatches.join("；")}——本工位不做跨项目/跨任务的回答，请核对召唤目标。`, ids);
        }

        // ---- ④ 作答 ----
        const budget = Math.min(ctx.maxContextChars ?? CONSULT_CONTEXT_BUDGET_CHARS, CONSULT_CONTEXT_MAX_CHARS);
        let own = "";
        try {
            own = String((await ctx.ownContext()) ?? "");
        } catch (e) {
            return refuse(
                `本工位无法读出自己持有的产物（ownContext 抛错：${String((e as Error).message ?? e)}）——`
                + "拿不到事实就不作答，避免给你一段听起来像真的猜测。",
                ids,
            );
        }
        const bounded = boundContextText(own, budget);
        const focus = (q.focus ?? []).map((s) => String(s).trim()).filter(Boolean);

        let answer: string;
        let amendment: ConsultAmendment | null = null;
        let confidence: "high" | "medium" | "low" = "low";
        let refused: string | null = null;
        let cost = 0;
        const notes: string[] = [];

        if (!ctx.llm) {
            // ---- 确定性路径：只复述，不推断 ----
            answer = [
                `【本工位（${ctx.role}）本次没有 LLM 可用】以下回答**只由本工位当前持有的产物**得出：`,
                "没有推断、没有补全、没有「按常理应该是」；如果你问的事情不在下面这段里，那就是本工位此刻不知道。",
                "",
                `你问：${q.question}`,
                ...(focus.length > 0 ? [`你点名要我看：${focus.join("、")}`] : []),
                "",
                own.trim()
                    ? `本工位当前持有的产物（预算 ${budget} 字符${bounded.truncated ? `，已省略 ${bounded.omitted} 字符` : ""}）：\n${bounded.text}`
                    : "本工位当前**没有任何可回答的产物**（ownContext 为空）——请把我的沉默当成「我没有依据」，而不是「没问题」。",
                "",
                "（确定性作答不签发任何修订：没有判断能力却签发职权动作，正是越权的形状。）",
            ].join("\n");
            confidence = "low";
        } else {
            const prompt = buildConsultPrompt({
                role: ctx.role, q, ownText: bounded.text, budget, truncated: bounded.truncated, omitted: bounded.omitted,
            });
            let out = "";
            try {
                // 一次有界调用：超时/重试由调用方（工位）负责，这里只管一次
                out = String((await ctx.llm(prompt)) ?? "");
                cost = 1;
            } catch (e) {
                // LLM 这条线断了 ≠ 工位死了：如实说，别假装答过（askHuman 的失败口径同款）
                return refuse(
                    `本工位的 LLM 调用失败（已消耗 ${1} 次调用额度）：${String((e as Error).message ?? e)}——`
                    + "本次没有任何结论产出，请按最保守路径自行继续。",
                    { ...ids, costLlmCalls: 1 },
                );
            }
            const parsedOut = parseStationOutput(out);
            answer = parsedOut.answer.trim() || "（本工位没有给出正文）";
            confidence = parsedOut.confidence;
            refused = parsedOut.refused;
            if (parsedOut.rawFallback) {
                notes.push("（工位返回不是约定 JSON：按原文转述，未提取到任何修订）");
            }
            const proposed = parsedOut.amendment;

            // ---- ⑤ 修订（越权 / 无通道 → 只当意见）----
            if (proposed) {
                if (!isAmendmentAllowedFor(ctx.role, proposed.kind)) {
                    const issuers = amendmentIssuersOf(proposed.kind);
                    notes.push(
                        `[越权修订已丢弃] 工位「${ctx.role}」无权签发 ${proposed.kind}`
                        + `（签发方：${issuers.join(" / ") || "无人"}）——未落任何改动。`,
                    );
                } else if (!ctx.amend) {
                    notes.push(
                        `[仅建议权] 本部署里「${ctx.role}」没有 amend 通道：${proposed.kind} 只作为**建议**转述，`
                        + `未落任何改动（要生效需要由拥有该产物的工位自己执行）。建议内容：${proposed.detail}`,
                    );
                } else {
                    let applied = false;
                    try {
                        applied = (await ctx.amend(proposed)) === true;
                    } catch (e) {
                        notes.push(`[修订执行异常] ${proposed.kind} 在落地方抛错：${String((e as Error).message ?? e)}——按**未生效**处理。`);
                    }
                    if (applied) {
                        amendment = proposed;
                        notes.push(`[修订已生效] ${proposed.kind}：${proposed.detail}`);
                    } else {
                        notes.push(`[修订未生效] ${proposed.kind} 被本工位退回/无法执行（amend 返回 false）——请按原状继续，不要按这条建议改行为。`);
                    }
                }
            }
        }

        const finalAnswer = notes.length > 0 ? `${answer}\n\n${notes.join("\n")}` : answer;
        return buildReply({
            ...ids, from: ctx.role, answer: finalAnswer, amendment, confidence, costLlmCalls: cost, refused,
        });
    } catch (e) {
        // 兜底：**永不抛**。司机必须永远拿到一条能据以行动的回答。
        return refuse(`工位处理召唤时内部异常：${String((e as Error).message ?? e)}——本次没有结论，请自行决策并写明假设。`);
    }
}

/** 提示词组装（有界 + 明示截断）：工位看到的就是"我持有的产物 + 司机的问题" */
function buildConsultPrompt(o: {
    role: ConsultRole; q: ConsultRequest;
    ownText: string; budget: number; truncated: boolean; omitted: number;
}): string {
    const { q } = o;
    const focus = (q.focus ?? []).map((s) => String(s).trim()).filter(Boolean);
    const evidence = q.evidence && Object.keys(q.evidence).length > 0
        ? boundContextText(JSON.stringify(q.evidence, null, 2), CONSULT_EVIDENCE_MAX_CHARS).text
        : "（未附证据）";
    return [
        CONSULT_ROLE_PROMPTS[o.role],
        "",
        "# 召唤身份（原样回带，不要改写）",
        `projectId=${q.projectId} taskId=${q.taskId} consultId=${q.consultId} 召唤者=${q.from}`,
        "",
        "# 司机的问题",
        q.question,
        ...(focus.length > 0 ? ["", "# 它点名要你看的（focus）", ...focus.map((f) => `- ${f}`)] : []),
        "",
        "# 司机附的证据（**发起方声明，未经机器核验**——不要把它当成已验证事实）",
        evidence,
        "",
        `# 你自己当前持有的产物（**唯一可引用的事实来源**；预算 ${o.budget} 字符`
        + `${o.truncated ? `，已显式省略 ${o.omitted} 字符` : ""}）`,
        o.ownText.trim() || "（本工位此刻没有任何可引用的产物——那就如实说你手上是空的）",
        "",
        CONSULT_OUTPUT_PROTOCOL,
        "★ 不允许编造：产物里没有的事实，answer 里必须明说「我手上没有这条信息」。",
    ].join("\n");
}
