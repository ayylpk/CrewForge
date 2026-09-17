// ============================================================
// tools/consultStation.ts —— 司机**召唤真工位**（层 B：从"要意见"到"要职权"）
//
//   与 tools/delegateReadonly.ts（层 A：只读顾问）是一对，但性质不同：
//     · delegateReadonly：召唤 explorer/debugger/architect-advisor/acceptance-advisor，
//       拿回的是**分析意见**——改动永远由司机落笔；
//     · consultStation（本工具）：把问题送到**真工位**（architect / pm / test-core /
//       maintainer）手上，它们对自己拥有的产物有职权：架构师可以修订计划/重发批次、
//       测试可以澄清判据、PM 可以澄清需求、维护者可以出验收/搁置说明。
//
//   为什么需要它（"换脑断层"的另一半）：
//     接力式流水线里，工位各出现一次就退出（发完批/收完工），中途司机只能自己猜；
//     层 A 的顾问能"提醒"，但提醒没有职权——顾问说"契约与实现不一致"、
//     司机说"那改契约"，这句话在流程里**没有任何效力**。层 B 把这件事收回工位自己手里：
//     谁拥有那件产物，谁才有权改它；司机负责把它召唤回来问，并执行自己的那部分（写代码）。
//
//   边界（默认拒绝，与 askHuman 同款）：
//     · ctx 里没有 consultStation 端口（只读子 Agent / Test 侧工具盒）→ 直接拒绝；
//     · role 不在四个工位白名单里 / question 为空 → 拒绝；
//     · 召唤超时（端口返回 null）→ **不当作整轮失败**：如实告诉模型"这条线断了，
//       自己决策并写明假设"，绝不让工具循环挂死；
//     · 模型自报的 evidence 只当**发起方声明**进问题正文，不写进协议的 evidence 字段——
//       协议里的 evidence 是"给别人看的问题背景"，模型手写的东西不许冒充机器证据
//       （graph.ts 里 delegateReadonly 的 args.evidence 剥离是同一手法）。
// ============================================================

import { CONSULT_STATION_NAMES, CONSULT_ROLES, isConsultRole } from "../../consult";
import type { ConsultRole } from "../../consult";
import { str, strList } from "./registry";
import type { ToolContext, ToolResult, ToolSpec } from "./registry";

/** 模型自报证据进问题正文的上限（它是背景，不是证据；多写只会挤掉真正的问题） */
const DECLARED_EVIDENCE_MAX_CHARS = 1_200;

function renderDeclaredEvidence(evidence: unknown): string {
    if (evidence === undefined || evidence === null) return "";
    let body: string;
    if (typeof evidence === "string") body = evidence;
    else {
        try { body = JSON.stringify(evidence, null, 2); } catch { return ""; }
    }
    if (!body.trim()) return "";
    const clipped = body.length > DECLARED_EVIDENCE_MAX_CHARS
        ? `${body.slice(0, DECLARED_EVIDENCE_MAX_CHARS)}…[已截断 ${body.length - DECLARED_EVIDENCE_MAX_CHARS} 字符]`
        : body;
    return `\n\n【发起方声明（未经机器核验，仅供定位问题；不要当成已验证事实）】\n${clipped}`;
}

export const consultStationTool: ToolSpec = {
    name: "consultStation",
    description:
    "召唤一个**真工位**（不是顾问）来回答你手上的问题，并拿到它对**自己产物**的职权动作："
    + "architect=计划/批次的所有者（可修订计划、重发批次）；pm=需求的所有者（可澄清需求）；"
    + "test-core=验收判据的语义所有者（可澄清判据，但不可宣布通过）；"
    + "maintainer=收敛记账方（可出验收/搁置说明）。"
    + "什么时候用：① 你判断缺口在**上游**（计划/需求/判据本身有问题），改代码治不了；"
    + "② 契约与需求互相矛盾，你不想自己发明解释；③ 你已经两次被同一件事挡住。"
    + "拿回来的东西分两类：**意见**（你参考）与**修订**（已在工位侧生效，你必须按新的来）。"
    + "注意：工位**不会替你写代码**——写盘与执行永远是你的活。",
    parameters: {
        role: {
            type: "string", required: true,
            description: `要召唤的工位，取值：${CONSULT_ROLES.join(" / ")}`,
        },
        question: {
            type: "string", required: true,
            description: "要问的问题：写清【我在做什么】【卡在哪】【你手上哪件产物决定这件事】【需要你明确回答什么】",
        },
        focus: {
            type: "array", required: false,
            description: "要对方重点看的东西（项目内相对路径 / 判据 id / 工作项 id），例如 [\"frontend/src/router/index.ts\",\"ac-3\"]",
        },
        evidence: {
            type: "object", required: false,
            description: "你掌握的相关上下文（命令输出摘要、报错、已试过的做法）；只作问题背景，不会被当成机器证据",
        },
    },
    async run(ctx: ToolContext, args): Promise<ToolResult> {
        const rawRole = str(args, "role").trim();
        if (!rawRole) return { ok: false, output: `role 不能为空（取值：${CONSULT_ROLES.join(" / ")}）` };
        // 工位白名单在代码里：模型写 "architect-advisor" 之类的顾问名会拿到明确的拒绝，
        // 而不是被静默降级成"随便找个人问问"。
        if (!isConsultRole(rawRole)) {
            return {
                ok: false,
                output: `未知工位「${rawRole}」：可召唤的工位是 ${CONSULT_ROLES.join(" / ")}`
                    + "（只读顾问请用 delegateReadonly，两者职责不同：顾问只能给意见，工位有职权）。",
                meta: { code: "CONSULT_UNKNOWN_ROLE" },
            };
        }
        const role: ConsultRole = rawRole;
        const question = str(args, "question").trim();
        if (!question) return { ok: false, output: "question 不能为空（写清卡点与你要的答复）" };

        if (!ctx.consultStation) {
            // 默认拒绝：只读子 Agent / Test 侧工具盒没有这个端口，一律拒绝（不静默降级成"自己编"
            return {
                ok: false,
                output: "当前角色没有召唤工位的权限（consultStation 端口未注入）："
                    + "请自行决策，并在输出里写明你的假设与依据。",
                meta: { code: "CONSULT_UNAVAILABLE" },
            };
        }

        const focus = strList(args, "focus").map((s) => s.trim()).filter(Boolean).slice(0, 20);
        const fullQuestion = question + renderDeclaredEvidence(args["evidence"]);

        try {
            const reply = await ctx.consultStation({
                role,
                question: fullQuestion,
                ...(focus.length > 0 ? { focus } : {}),
            });
            if (!reply) {
                // 超时/没有回复：**降级**而不是失败——整轮任务不该因为一次召唤没回而报废
                return {
                    ok: false,
                    output: `召唤「${role}」超时（工位没有在时限内回复）：这条线本次不可用。`
                        + "请按最保守的假设自行继续，并在最终输出里写明你假设了什么、依据是什么——"
                        + "不要因为没人回答就把这件事当成已确认。",
                    meta: { code: "CONSULT_TIMEOUT", role, target: CONSULT_STATION_NAMES[role] },
                };
            }
            const lines = [
                `【工位「${reply.from}」的回复】confidence=${reply.confidence} costLlmCalls=${reply.costLlmCalls} consultId=${reply.consultId}`,
                reply.answer,
            ];
            if (reply.amendment) {
                lines.push(`【已生效的修订】${reply.amendment.kind}：${reply.amendment.detail}`
                    + "（这是**工位对其自身产物**的职权动作，已生效；你接下来的工作必须按它来）");
                if (reply.amendment.payload) {
                    lines.push(`修订载荷：${JSON.stringify(reply.amendment.payload)}`);
                }
            }
            if (reply.refused) lines.push(`【工位拒绝了这次召唤】${reply.refused}`);
            return {
                ok: true,
                output: lines.join("\n"),
                meta: {
                    role, target: CONSULT_STATION_NAMES[role], consultId: reply.consultId,
                    confidence: reply.confidence, costLlmCalls: reply.costLlmCalls,
                    amendment: reply.amendment ?? null, refused: reply.refused ?? null,
                },
            };
        } catch (e) {
            // 通道本身坏了 ≠ 整轮失败：如实报错，让模型自己决定下一步
            return {
                ok: false,
                output: `召唤失败（工位通道不可用）：${String((e as Error).message ?? e)}。请自行决策并写明假设。`,
                meta: { code: "CONSULT_FAILED", role },
            };
        }
    },
};
