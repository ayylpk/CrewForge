// ============================================================
// tests/consult-protocol.test.ts —— 召唤工位协议（层 B）的形状与**越权闸**
//
//   守住的东西：
//     ① 请求/回复能原样往返（Hub 上是 JSON 字符串，单测也喂对象）；
//     ② amendment 是**封闭白名单**：白名单外的 kind 整体拒；
//     ③ kind 与签发方必须匹配（架构师不能签"判据澄清"、维护者不能签"计划修订"）；
//     ④ 身份字段缺失一律拒（没有 consultId 就无从配对——那种"回复到了但配不上"的
//        断链是最难查的一类）；
//     ⑤ consultId 确定性可复现（同 (taskId, seq) 永远同一个 id，重放才对得上）。
// ============================================================

import { describe, expect, it } from "bun:test";
import {
    AMENDMENT_ISSUERS, AMENDMENT_KINDS, CONSULT_DRIVER, CONSULT_EVENTS, CONSULT_ROLES,
    CONSULT_STATION_NAMES,
    amendmentIssuersOf, isAmendmentAllowedFor, isConsultRole, newConsultId,
    parseConsultReply, parseConsultRequest,
} from "../../consult";
import type { ConsultReply, ConsultRequest } from "../../consult";

const req: ConsultRequest = {
    type: "consult_request",
    projectId: "p1", taskId: "p1-t1", consultId: "consult-p1-t1-1",
    from: "developer", to: "architect",
    question: "w3 的批次里少了鉴权，是不是计划漏了？",
    focus: ["w3", "backend/src/middleware"],
    evidence: { note: "构建通过但 /api/admin 无鉴权" },
};

const reply: ConsultReply = {
    type: "consult_reply",
    projectId: "p1", taskId: "p1-t1", consultId: "consult-p1-t1-1",
    from: "architect",
    answer: "蓝图 w3 只覆盖了 CRUD；鉴权属于 w4。",
    amendment: { kind: "batch_resend", detail: "重发 w3 批次并附上鉴权说明", payload: { itemId: "w3" } },
    confidence: "high",
    costLlmCalls: 1,
    refused: null,
};

describe("consult / 请求往返", () => {
    it("合法请求：对象与 JSON 字符串两种形态都能过", () => {
        const a = parseConsultRequest(req);
        expect(a.ok).toBe(true);
        expect(a.ok && a.value).toEqual(req);
        const b = parseConsultRequest(JSON.stringify(req));
        expect(b.ok).toBe(true);
        expect(b.ok && b.value.question).toBe(req.question);
    });

    it("缺身份字段 → 逐条给出原因（不猜、不静默）", () => {
        const noId = parseConsultRequest({ ...req, consultId: "" });
        expect(noId.ok).toBe(false);
        expect(noId.ok ? [] : noId.reasons.join("；")).toContain("consultId");
        const noProject = parseConsultRequest({ ...req, projectId: undefined });
        expect(noProject.ok).toBe(false);
        const noType = parseConsultRequest({ ...req, type: "consult" });
        expect(noType.ok).toBe(false);
    });

    it("from 必须是司机：工位之间不许走这条通道，自己问自己也拒", () => {
        const fromStation = parseConsultRequest({ ...req, from: "maintainer" });
        expect(fromStation.ok).toBe(false);
        expect(fromStation.ok ? "" : fromStation.reasons.join("；")).toContain("司机");
        const selfAsk = parseConsultRequest({ ...req, from: "developer", to: "developer" });
        expect(selfAsk.ok).toBe(false);
    });

    it("to 只能是被召唤的四个工位", () => {
        expect(CONSULT_ROLES).toEqual(["architect", "pm", "test-core", "maintainer"]);
        expect(isConsultRole("architect")).toBe(true);
        expect(isConsultRole("architect-advisor")).toBe(false);   // 顾问不是工位（两条通道别混）
        expect(parseConsultRequest({ ...req, to: "merger" }).ok).toBe(false);
    });

    it("工位角色 → Hub 座位名：pm 的座位一直是 manager（部署事实写在协议里一处）", () => {
        expect(CONSULT_STATION_NAMES["pm"]).toBe("manager");
        expect(CONSULT_STATION_NAMES["test-core"]).toBe("test-core");
        expect(CONSULT_DRIVER).toBe("developer");
    });

    it("事件名逐字冻结（写 Ledger 时用的是这些常量）", () => {
        expect(CONSULT_EVENTS.requested).toBe("consult_requested");
        expect(CONSULT_EVENTS.replied).toBe("consult_replied");
        expect(CONSULT_EVENTS.timeout).toBe("consult_timeout");
        expect(CONSULT_EVENTS.refused).toBe("consult_refused");
    });
});

describe("consult / 回复与越权闸", () => {
    it("合法回复往返（含 amendment）", () => {
        const a = parseConsultReply(reply);
        expect(a.ok).toBe(true);
        expect(a.ok && a.value).toEqual(reply);
        const b = parseConsultReply(JSON.stringify(reply));
        expect(b.ok).toBe(true);
    });

    it("未知 kind 整体拒绝（封闭白名单）", () => {
        const bad = { ...reply, amendment: { kind: "free_pass", detail: "直接判过" } };
        const r = parseConsultReply(bad);
        expect(r.ok).toBe(false);
        expect(r.ok ? "" : r.reasons.join("；")).toContain("kind");
        expect(AMENDMENT_KINDS.length).toBe(5);
        expect(isAmendmentAllowedFor("test-core", "free_pass")).toBe(false);
    });

    it("kind 与签发方不匹配 → 拒绝（越权），并指出谁才有资格签", () => {
        const mismatch = { ...reply, from: "maintainer" as const };   // 维护者签 plan_revision/batch_resend = 越权
        const r = parseConsultReply(mismatch);
        expect(r.ok).toBe(false);
        const why = r.ok ? "" : r.reasons.join("；");
        expect(why).toContain("越权");
        expect(why).toContain("architect");

        const crit = {
            ...reply, from: "pm" as const,
            amendment: { kind: "criterion_clarification", detail: "判据 ac-3 其实是 409" },
        };
        expect(parseConsultReply(crit).ok).toBe(false);
    });

    it("越权闸的封闭表：每个 kind 只认它自己的签发方", () => {
        expect(isAmendmentAllowedFor("architect", "plan_revision")).toBe(true);
        expect(isAmendmentAllowedFor("architect", "batch_resend")).toBe(true);
        expect(isAmendmentAllowedFor("test-core", "criterion_clarification")).toBe(true);
        expect(isAmendmentAllowedFor("pm", "requirement_clarification")).toBe(true);
        expect(isAmendmentAllowedFor("maintainer", "acceptance_note")).toBe(true);
        expect(isAmendmentAllowedFor("test-core", "acceptance_note")).toBe(true);
        // 反向：拿别人的职权一律 false
        expect(isAmendmentAllowedFor("architect", "criterion_clarification")).toBe(false);
        expect(isAmendmentAllowedFor("pm", "plan_revision")).toBe(false);
        expect(isAmendmentAllowedFor("maintainer", "batch_resend")).toBe(false);
        expect(isAmendmentAllowedFor("developer", "plan_revision")).toBe(false);
        expect(amendmentIssuersOf("plan_revision")).toEqual(["architect"]);
        expect(Object.keys(AMENDMENT_ISSUERS).sort()).toEqual([...AMENDMENT_KINDS].sort());
    });

    it("缺字段/坏形状的回复 → 拒绝（司机不会拿一条残缺断言去改行为）", () => {
        expect(parseConsultReply({ ...reply, consultId: "" }).ok).toBe(false);
        expect(parseConsultReply({ ...reply, confidence: "very-high" }).ok).toBe(false);
        expect(parseConsultReply({ ...reply, costLlmCalls: -1 }).ok).toBe(false);
        expect(parseConsultReply("这不是 JSON").ok).toBe(false);
        // 多余字段整体拒（strictObject：权威字段/自造字段进不来）
        expect(parseConsultReply({ ...reply, status: "done" }).ok).toBe(false);
    });

    it("refused 回复仍是一条合法回复（拒绝也要能配对、能被审计）", () => {
        const refused = { ...reply, amendment: null, answer: "投递错误", refused: "本工位是 test-core", confidence: "low" as const, costLlmCalls: 0 };
        const r = parseConsultReply(refused);
        expect(r.ok).toBe(true);
        expect(r.ok && r.value.refused).toBe("本工位是 test-core");
    });
});

describe("consult / consultId", () => {
    it("确定性：同 (taskId, seq) 永远同一个 id（重放才对得上）", () => {
        expect(newConsultId("p1-t1", 3)).toBe("consult-p1-t1-3");
        expect(newConsultId("p1-t1", 2 + 1)).toBe(newConsultId("p1-t1", 3));
        expect(newConsultId("p1-t1", 3)).not.toBe(newConsultId("p1-t2", 3));
        expect(newConsultId("p1-t1", 3)).not.toBe(newConsultId("p1-t1", 4));
    });

    it("非法序号收敛到 1；taskId 里的怪异字符被消毒（它会被拼进日志/文件名语义）", () => {
        expect(newConsultId("t", 0)).toBe("consult-t-1");
        expect(newConsultId("t", Number.NaN)).toBe("consult-t-1");
        expect(newConsultId("a/b\\c:d", 2)).toBe("consult-a_b_c_d-2");
    });
});
