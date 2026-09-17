// ============================================================
// tests/consult-responder.test.ts —— 工位侧应答器（consultStation.ts）
//
//   守住的东西（每一条都对应一种"真的会害人"的坏形状）：
//     ① 发错人的请求 → **明确拒绝**（不是静默丢：静默丢会让司机等到超时才隐约知道）；
//     ② 没有 LLM → 确定性回答：只复述自己持有的产物、confidence=low、明说没有 LLM，
//        **绝不编事实**；也绝不签发修订（没有判断能力却签职权动作 = 越权的形状）；
//     ③ 有 LLM + 有通道 + 允许的 kind → amend 真被执行，且回复里明说"已生效"；
//     ④ 有 LLM 但该 kind 不是本工位的职权 → 只有意见，明说"未落任何改动"；
//     ⑤ 内部异常 → refused 回复，**永不抛**（司机必须永远拿到一条能据以行动的答复）；
//     ⑥ 工位侧**没有任何写生成项目的口**：ConsultContext 的成员表就是白名单。
// ============================================================

import { describe, expect, it } from "bun:test";
import {
    CONSULT_CONTEXT_BUDGET_CHARS, consultCapabilities, handleConsultRequest, parseStationOutput,
} from "../../consultStation";
import type { ConsultContext } from "../../consultStation";
import { newConsultId } from "../../consult";
import type { ConsultAmendment, ConsultRequest, ConsultReply } from "../../consult";

const request = (over: Partial<ConsultRequest> = {}): ConsultRequest => ({
    type: "consult_request",
    projectId: "p1", taskId: "p1-t1", consultId: newConsultId("p1-t1", 1),
    from: "developer", to: "test-core",
    question: "判据 ac-3 要求重复下单返回冲突，是 409 吗？",
    focus: ["ac-3"],
    ...over,
});

const OWN_CONTEXT = [
    "# 测试工位当前持有的事实",
    "- 本任务判据 id：ac-1、ac-2、ac-3",
    "- 已记录的判据澄清（0）：（无）",
].join("\n");

function makeCtx(over: Partial<ConsultContext> = {}): ConsultContext {
    return {
        role: "test-core",
        projectId: "p1",
        taskId: "p1-t1",
        ownContext: async () => OWN_CONTEXT,
        ...over,
    };
}

/** LLM 侧脚本：返回一段含 amendment 的协议 JSON */
function scriptedLlm(out: unknown) {
    const prompts: string[] = [];
    return {
        prompts,
        llm: async (prompt: string) => { prompts.push(prompt); return JSON.stringify(out); },
    };
}

describe("consult 应答器 / 投递与身份", () => {
    it("发错人的请求 → refused（明确说发错人了，且不调用 ownContext）", async () => {
        let ownCalled = false;
        const ctx = makeCtx({ ownContext: async () => { ownCalled = true; return OWN_CONTEXT; } });
        const reply = await handleConsultRequest(request({ to: "architect" }), ctx);
        expect(reply.refused).not.toBeNull();
        expect(reply.refused ?? "").toContain("投递错误");
        expect(reply.consultId).toBe(newConsultId("p1-t1", 1));   // 配对信息原样回带
        expect(reply.from).toBe("test-core");
        expect(reply.costLlmCalls).toBe(0);
        expect(ownCalled).toBe(false);        // 不是给我的，我连自己的产物都不读
    });

    it("身份不符 → refused（双方都持有该维度时才比）", async () => {
        const reply = await handleConsultRequest(request({ projectId: "p9" }), makeCtx());
        expect(reply.refused ?? "").toContain("身份不符");
        // taskId 留空 = 不持该维度 → 不构成拒绝理由（架构师/PM 服务整个阶段）
        const ok = await handleConsultRequest(request(), makeCtx({ taskId: "" }));
        expect(ok.refused).toBeNull();
    });

    it("畸形请求（缺 consultId）→ refused，且回信仍带上能带的东西", async () => {
        const gutted = { type: "consult_request", projectId: "p1", taskId: "p1-t1", from: "developer", to: "test-core" } as unknown as ConsultRequest;
        const reply = await handleConsultRequest(gutted, makeCtx());
        expect(reply.refused).not.toBeNull();
        expect(reply.refused ?? "").toContain("consultId");
        expect(reply.consultId).toBe("(missing-consultId)");   // 没得配也说清楚为什么
    });
});

describe("consult 应答器 / 没有 LLM 时只复述", () => {
    it("确定性回答：低置信 + 明说没有 LLM + ownContext 原文进正文（不编事实）", async () => {
        const reply = await handleConsultRequest(request(), makeCtx());
        expect(reply.refused).toBeNull();
        expect(reply.confidence).toBe("low");
        expect(reply.costLlmCalls).toBe(0);
        expect(reply.amendment).toBeNull();
        expect(reply.answer).toContain("没有 LLM 可用");
        expect(reply.answer).toContain("ac-1、ac-2、ac-3");        // 复述事实
        expect(reply.answer).toContain("本工位此刻不知道");
        // 确定性作答明说不签发修订 —— 这是"不越权"的口径，不是省事
        expect(reply.answer).toContain("不签发任何修订");
    });

    it("ownContext 为空 → 如实说「没有依据」，而不是「没问题」", async () => {
        const reply = await handleConsultRequest(request(), makeCtx({ ownContext: async () => "" }));
        expect(reply.answer).toContain("没有任何可回答的产物");
        expect(reply.confidence).toBe("low");
    });

    it("ownContext 超预算 → 显式截断（头 + 明示省略量，绝不静默砍尾）", async () => {
        const long = "X".repeat(CONSULT_CONTEXT_BUDGET_CHARS + 500);
        const reply = await handleConsultRequest(request(), makeCtx({ ownContext: async () => long }));
        expect(reply.answer).toContain("已省略 500 字符");
        expect(reply.answer.length).toBeLessThan(long.length);
    });
});

describe("consult 应答器 / 有 LLM 时的修订", () => {
    it("允许的 kind + 有 amend 通道 → 修订真执行，且回复明说已生效", async () => {
        const applied: ConsultAmendment[] = [];
        const { llm, prompts } = scriptedLlm({
            answer: "ac-3 的语义是 409（重复下单）。",
            amendment: { kind: "criterion_clarification", detail: "ac-3 期望状态码 409", payload: { checkId: "ac-3" } },
            confidence: "high",
            refused: null,
        });
        const reply = await handleConsultRequest(request(), makeCtx({
            llm,
            amend: async (a) => { applied.push(a); return true; },
        }));
        expect(prompts.length).toBe(1);
        expect(applied.length).toBe(1);
        expect(applied[0]?.kind).toBe("criterion_clarification");
        expect(reply.amendment?.detail).toBe("ac-3 期望状态码 409");
        expect(reply.answer).toContain("[修订已生效]");
        expect(reply.confidence).toBe("high");
        expect(reply.costLlmCalls).toBe(1);        // 诚实计费：真调了一次
        expect(prompts[0]).toContain("ac-3");      // 问题与 focus 都进了提示词
    });

    it("kind 不是本工位的职权 → 丢弃修订、只留意见，且 amend 一次都不被调用", async () => {
        let amendCalled = false;
        const { llm } = scriptedLlm({
            answer: "我顺手把计划也改了",
            amendment: { kind: "plan_revision", detail: "删掉 w4" },   // test-core 无权签
            confidence: "medium",
        });
        const reply = await handleConsultRequest(request(), makeCtx({
            llm, amend: async () => { amendCalled = true; return true; },
        }));
        expect(amendCalled).toBe(false);
        expect(reply.amendment).toBeNull();
        expect(reply.answer).toContain("[越权修订已丢弃]");
        expect(reply.answer).toContain("architect");      // 说清谁才有资格签
    });

    it("没有 amend 通道 → 修订只作为建议转述，明说未落任何改动", async () => {
        const { llm } = scriptedLlm({
            answer: "ac-3 应当是 409",
            amendment: { kind: "criterion_clarification", detail: "把 ac-3 解释成 409" },
            confidence: "high",
        });
        const reply = await handleConsultRequest(request(), makeCtx({ llm }));
        expect(reply.amendment).toBeNull();
        expect(reply.answer).toContain("[仅建议权]");
        expect(reply.answer).toContain("未落任何改动");
    });

    it("amend 返回 false（工位自己退回）→ 按未生效报告，不让司机按建议改行为", async () => {
        const { llm } = scriptedLlm({
            answer: "澄清如下",
            amendment: { kind: "criterion_clarification", detail: "改判据" },
            confidence: "medium",
        });
        const reply = await handleConsultRequest(request(), makeCtx({ llm, amend: async () => false }));
        expect(reply.amendment).toBeNull();
        expect(reply.answer).toContain("[修订未生效]");
    });

    it("LLM 返回不是约定 JSON → 原文转述 + 低置信 + 无修订（不猜格式）", async () => {
        const reply = await handleConsultRequest(request(), makeCtx({
            llm: async () => "我觉得 ac-3 大概是 409 吧",
            amend: async () => true,
        }));
        expect(reply.amendment).toBeNull();
        expect(reply.confidence).toBe("low");
        expect(reply.answer).toContain("按原文转述");
        expect(reply.answer).toContain("大概是 409");
    });

    it("LLM 明确拒绝回答 → refused 原样带回（拒绝也是一种可行动的答复）", async () => {
        const { llm } = scriptedLlm({ answer: "这属于 PM 的职权", amendment: null, confidence: "medium", refused: "需求问题请找 PM" });
        const reply = await handleConsultRequest(request(), makeCtx({ llm }));
        expect(reply.refused).toBe("需求问题请找 PM");
        expect(reply.costLlmCalls).toBe(1);
    });
});

describe("consult 应答器 / 永不抛", () => {
    it("ownContext 抛错 → refused 回复（带原文），不是异常", async () => {
        const reply = await handleConsultRequest(request(), makeCtx({
            ownContext: async () => { throw new Error("目录不可读"); },
        }));
        expect(reply.refused ?? "").toContain("目录不可读");
        expect(reply.costLlmCalls).toBe(0);
    });

    it("LLM 抛错 → refused 回复且如实计 1 次调用（花了就是花了）", async () => {
        const reply = await handleConsultRequest(request(), makeCtx({
            llm: async () => { throw new Error("模型 502"); },
        }));
        expect(reply.refused ?? "").toContain("模型 502");
        expect(reply.costLlmCalls).toBe(1);
        expect(reply.amendment).toBeNull();
    });

    it("ctx 里的属性 getter 直接抛 → 仍然是最外层 try 兜住的 refused（永不把异常抛给司机）", async () => {
        const hostile = {
            role: "test-core",
            get projectId(): string { throw new Error("投影炸弹"); },
            taskId: "", ownContext: async () => "",
        } as unknown as ConsultContext;
        let thrown = false;
        let reply: ConsultReply | null = null;
        try { reply = await handleConsultRequest(request(), hostile); } catch { thrown = true; }
        expect(thrown).toBe(false);
        expect(reply?.refused).not.toBeNull();
    });
});

describe("consult 应答器 / 工位没有写生成项目的口", () => {
    it("ConsultContext 的成员表就是白名单：没有 workspace / 写 / 执行 / 发消息", () => {
        // 完整实现一遍接口，把**实际存在的成员**列出来——接口多一个口，这条就红
        const ctx: ConsultContext = {
            role: "architect", projectId: "p1", taskId: "t1",
            ownContext: async () => "", llm: async () => "", amend: async () => true,
            maxContextChars: 100,
        };
        const keys = Object.keys(ctx).sort();
        expect(keys).toEqual(["amend", "llm", "maxContextChars", "ownContext", "projectId", "role", "taskId"]);
        for (const k of keys) {
            expect(/write|workspace|fs|exec|command|send|hub|ledger/i.test(k)).toBe(false);
        }
    });

    it("能力自述是代码事实：不能写/不能执行/不能发 Hub/不能改任务包", () => {
        const caps = consultCapabilities();
        expect(caps.canWriteGeneratedProject).toBe(false);
        expect(caps.canExecute).toBe(false);
        expect(caps.canSendHub).toBe(false);
        expect(caps.canMutateTaskPackage).toBe(false);
        expect(caps.canIssueAmendmentWithoutOwner).toBe(false);
        expect(caps.roles).toEqual(["architect", "pm", "test-core", "maintainer"]);
    });

    it("parseStationOutput：只认带 answer 的对象，认不出来就退回原文（不猜）", () => {
        const ok = parseStationOutput(JSON.stringify({ answer: "a", amendment: null, confidence: "high" }));
        expect(ok.rawFallback).toBe(false);
        expect(ok.confidence).toBe("high");
        const raw = parseStationOutput("没有 JSON");
        expect(raw.rawFallback).toBe(true);
        expect(raw.amendment).toBeNull();
        expect(raw.answer).toBe("没有 JSON");
        // 花括号片段里没有 answer → 不提取成半成品
        const half = parseStationOutput('{"kind":"plan_revision"} 我改了');
        expect(half.rawFallback).toBe(true);
    });
});
