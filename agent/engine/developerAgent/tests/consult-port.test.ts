// ============================================================
// tests/consult-port.test.ts —— 司机侧召唤端口（层 B 的另一半：真的把问题送出去、等回来）
//
//   守住的东西（每一条都对应一种"会把流程搞死"的坏形状）：
//     ① 配对：回复必须 consultId + projectId + taskId 三元组全中才算我的答复；
//     ② **不丢消息**：等待期间收到的其它消息进停车队列，serveOnce 之后照旧取得到
//        （等回复时吞掉一条 architect_batch = 把分批管线当场掐死）；
//     ③ **不挂起**：工位不回（没起/睡着）→ 硬超时返回 null + consult_timeout 事件，
//        司机降级自行继续；
//     ④ **不重复烧**：同一 consultId / 同一问题再来一次 → 复用历史回复，
//        工位那边只会收到一条 consult_request；
//     ⑤ **不越权**：冒名/越权回复整条丢弃，继续等正确的（不是拿它当答案）；
//     ⑥ 成本可见：工位替司机烧的 LLM 调用**进司机台账**（inspectTaskState().consult.llmCalls）。
//
//   全程零 LLM、零网络：工位这一侧是**真 TransferStation + 手写应答器**。
// ============================================================

import { afterAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { roles, TransferStation } from "../../Hub";
import { createDeveloperAgent } from "../index";
import type { DeveloperAgentHandle } from "../index";
import type { DeveloperLlm } from "../graph";
import { createDeveloperProcessRegistry } from "../tools/registry";
import type { ToolContext } from "../tools/registry";
import { Workspace } from "../workspace";
import { CONSULT_EVENTS } from "../../consult";
import type { ConsultReply, ConsultRequest, ConsultRole } from "../../consult";

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-consult-port-"));
let seq = 0;
const opened: DeveloperAgentHandle[] = [];

afterAll(() => {
    for (const h of opened) { try { h.close(); } catch { /* 已关 */ } }
    fs.rmSync(projectDir, { recursive: true, force: true });
});

const neverLlm: DeveloperLlm = {
    id: "never-called",
    calls: () => 0,
    next: async () => { throw new Error("召唤测试不应触发司机 LLM"); },
};

interface StationHarness {
    station: TransferStation;
    /** 工位真实收到的 consult_request（用来断言"没有重发/没有第二次烧"） */
    received: ConsultRequest[];
    /** 交给回信函数：给 null = 不回（模拟工位没起/睡着） */
    heard(handler: (req: ConsultRequest) => ConsultReply | null | Promise<ConsultReply | null>): void;
    /** 手动往司机收件箱塞一条消息（模拟"等回复期间到了别的消息"） */
    pushToDeveloper(payload: unknown, sender?: string): void;
}

/** 起一个"假工位"：真 Hub 座位 + 真消息循环，只有判断是脚本化的 */
function makeStation(name: string, role: (typeof roles)[keyof typeof roles]): StationHarness {
    const station = new TransferStation({}, {});
    station.register(name, role);
    const received: ConsultRequest[] = [];
    // 用对象属性而不是裸 let：闭包里读它时不会被 TS 的窄化判成 never
    const box: { handler: ((req: ConsultRequest) => ConsultReply | null | Promise<ConsultReply | null>) | null } = { handler: null };
    void (async () => {
        for (; ;) {
            const m = await station.waitForMessage(name);
            if (!m) { station.markDone(name); continue; }
            let data: ConsultRequest | null = null;
            try { data = JSON.parse(m.content) as ConsultRequest; } catch { data = null; }
            if (data && data.type === "consult_request") {
                received.push(data);
                const reply = box.handler ? await box.handler(data) : null;
                if (reply) station.sendMessage(name, data.from, JSON.stringify(reply));
            }
            station.markDone(name);
        }
    })();
    return {
        station,
        received,
        heard: (h) => { box.handler = h; },
        pushToDeveloper: (payload, sender = "test-core") => {
            station.sendMessage(sender, "developer", typeof payload === "string" ? payload : JSON.stringify(payload));
        },
    };
}

function makeAgent(station: TransferStation, over: { consultTimeoutMs?: number } = {}): DeveloperAgentHandle {
    const handle = createDeveloperAgent({
        projectId: "p1", taskId: "p1-t1",
        projectDir,
        allowedRoots: ["frontend", "backend"],
        ledgerPath: path.join(projectDir, `consult-${seq++}.db`),
        llm: neverLlm,
        station,
        sandbox: { mode: "soft", backend: "local" },
        ...(over.consultTimeoutMs !== undefined ? { consultTimeoutMs: over.consultTimeoutMs } : {}),
    });
    opened.push(handle);
    return handle;
}

const replyOf = (req: ConsultRequest, over: Partial<ConsultReply> = {}): ConsultReply => ({
    type: "consult_reply",
    projectId: req.projectId, taskId: req.taskId, consultId: req.consultId,
    from: req.to,
    answer: "蓝图 w3 只管 CRUD，鉴权在 w4。",
    amendment: null, confidence: "medium", costLlmCalls: 0, refused: null,
    ...over,
});

const eventTypes = (h: DeveloperAgentHandle): string[] => h.ledger.listEvents().map((e) => e.type);
const payloadsOf = (h: DeveloperAgentHandle, type: string): Record<string, unknown>[] =>
    h.ledger.listEvents().filter((e) => e.type === type).map((e) => e.payload as Record<string, unknown>);

describe("consult 端口 / 正常往返", () => {
    it("工位回话 → 按三元组配对成功，Ledger 留 requested + replied", async () => {
        const st = makeStation("architect", roles.architect);
        const handle = makeAgent(st.station);
        st.heard((req) => replyOf(req, { from: "architect", confidence: "high" }));
        const reply = await handle.consultStation({ role: "architect", question: "w3 是否漏了鉴权？", focus: ["w3"] });
        expect(reply).not.toBeNull();
        expect(reply?.from).toBe("architect");
        expect(reply?.answer).toContain("鉴权在 w4");
        expect(st.received.length).toBe(1);
        expect(st.received[0]?.to).toBe("architect");         // 送到的是 Hub 座位名
        expect(st.received[0]?.projectId).toBe("p1");
        expect(st.received[0]?.focus).toEqual(["w3"]);
        expect(eventTypes(handle)).toContain(CONSULT_EVENTS.requested);
        expect(eventTypes(handle)).toContain(CONSULT_EVENTS.replied);
        expect(eventTypes(handle)).not.toContain(CONSULT_EVENTS.timeout);
    });

    it("pm 的 Hub 座位是 manager（协议里的座位名表真的生效）", async () => {
        const st = makeStation("manager", roles.manager);
        const handle = makeAgent(st.station);
        st.heard((req) => replyOf(req, { from: "pm", answer: "需求原文没写并发上限。" }));
        const reply = await handle.consultStation({ role: "pm", question: "并发上限是多少？" });
        expect(reply?.from).toBe("pm");
        expect(st.received.length).toBe(1);
    });
});

describe("consult 端口 / 不丢消息（停车而不是吞掉）", () => {
    it("等待期间到达的**非本次答复** → 停车，serveOnce 之后照旧取得到", async () => {
        const st = makeStation("architect", roles.architect);
        const handle = makeAgent(st.station);
        st.heard(async (req) => {
            // ① 先塞一条"别人的消息"（repair_requested：serveOnce 会当 ignored 留痕，
            //    不进图、不需要 LLM——正好用来证明"它没被吞掉"）
            st.pushToDeveloper({ type: "repair_requested", projectId: "p1", taskId: "p1-t1", reason: "顺手看看" }, "merchant");
            // ② 再塞一条**别的 consultId** 的回复（不属于本次等待）
            st.pushToDeveloper(replyOf({ ...req, consultId: "consult-别人-9" }, { answer: "旧回复" }));
            await Bun.sleep(10);
            return replyOf(req, { answer: "本次的正确回复" });
        });
        const reply = await handle.consultStation({ role: "architect", question: "w3 是否漏了鉴权？" });
        expect(reply?.answer).toContain("本次的正确回复");
        // 停车事件留痕（看得见"我停了两条"）
        const parked = payloadsOf(handle, "message_parked").filter((p) => p["reason"] === "consult_wait");
        expect(parked.length).toBeGreaterThanOrEqual(2);
        // ★ 关键断言：停车的东西**还在**——serveOnce 能把 repair_requested 取出来办掉
        const served = await handle.serveOnce();
        expect(served).toBeNull();      // repair_requested 的落点是 ignored_message（留痕，不驱动图）
        expect(eventTypes(handle)).toContain("ignored_message");
        const ignored = payloadsOf(handle, "ignored_message");
        expect(ignored.some((p) => p["type"] === "repair_requested")).toBe(true);
    });
});

describe("consult 端口 / 超时降级（绝不挂起）", () => {
    it("工位不回 → null + consult_timeout 事件，且在时限内返回", async () => {
        const st = makeStation("maintainer", roles.maintainer);
        const handle = makeAgent(st.station, { consultTimeoutMs: 60 });
        st.heard(() => null);      // 工位收得到、就是不回（= 睡着了/没实现）
        const t0 = Date.now();
        const reply = await handle.consultStation({ role: "maintainer", question: "这批哪几个算定论了？" });
        const cost = Date.now() - t0;
        expect(reply).toBeNull();
        expect(cost).toBeLessThan(3_000);
        const timeouts = payloadsOf(handle, CONSULT_EVENTS.timeout);
        expect(timeouts.length).toBe(1);
        expect(timeouts[0]?.["role"]).toBe("maintainer");
        expect(String(timeouts[0]?.["note"] ?? "")).toContain("降级");
        // 司机侧可见：本次召唤超时了一次
        expect(handle.inspectTaskState().consult.timedOut).toBe(1);
    });

    it("等待时限被硬夹到 ≤240s（超长配置不至于把一轮拖死）", () => {
        const st = makeStation("maintainer", roles.maintainer);
        const handle = makeAgent(st.station, { consultTimeoutMs: 9_999_999 });
        expect(handle.inspectTaskState().consult.timeoutMs).toBe(240_000);
    });

    it("超时之后才到的消息也不会被吞掉：进停车队列，serveOnce 仍能办掉", async () => {
        const st = makeStation("maintainer", roles.maintainer);
        const handle = makeAgent(st.station, { consultTimeoutMs: 60 });
        st.heard(() => null);          // 工位就是不回
        expect(await handle.consultStation({ role: "maintainer", question: "这批哪几个算定论了？" })).toBeNull();
        // 迟到消息（超时之后才到）：一条 repair_requested
        st.pushToDeveloper({ type: "repair_requested", projectId: "p1", taskId: "p1-t1", reason: "迟到" }, "merchant");
        await Bun.sleep(80);
        const parked = payloadsOf(handle, "message_parked").filter((p) => p["reason"] === "consult_late_after_timeout");
        expect(parked.length).toBe(1);
        // 停车不是丢：serveOnce 还能把它取出来办（repair_requested 落 ignored_message 留痕）
        await handle.serveOnce();
        expect(payloadsOf(handle, "ignored_message").some((p) => p["type"] === "repair_requested")).toBe(true);
    });
});

describe("consult 端口 / 重放不重复烧", () => {
    it("同一问题第二次召唤 → 复用历史回复，工位只收到一条请求", async () => {
        const st = makeStation("test-core", roles.testEngineer);
        const handle = makeAgent(st.station);
        st.heard((req) => replyOf(req, { from: "test-core", answer: "ac-3 期望 409", costLlmCalls: 1 }));
        const first = await handle.consultStation({ role: "test-core", question: "ac-3 是 409 吗？" });
        expect(first).not.toBeNull();
        const second = await handle.consultStation({ role: "test-core", question: "ac-3 是 409 吗？" });
        expect(second?.consultId).toBe(first?.consultId);
        expect(second?.answer).toBe(first?.answer);
        expect(st.received.length).toBe(1);                       // 没有第二个请求
        expect(payloadsOf(handle, CONSULT_EVENTS.replayed).length).toBe(1);
        // 计费只发生一次（工位那次 1 调）
        expect(handle.inspectTaskState().consult.llmCalls).toBe(1);
    });

    it("显式重发同一个 consultId（崩溃重放形状）→ 一样复用，不二次计费", async () => {
        const st = makeStation("test-core", roles.testEngineer);
        const handle = makeAgent(st.station);
        st.heard((req) => replyOf(req, { from: "test-core", costLlmCalls: 1 }));
        const first = await handle.consultStation({ role: "test-core", question: "判据 ac-3 的语义？" });
        expect(first).not.toBeNull();
        const again = await handle.consultStation({
            role: "test-core", question: "判据 ac-3 的语义？",
            ...(first?.consultId ? { consultId: first.consultId } : {}),
        });
        expect(again?.consultId).toBe(first?.consultId);
        expect(st.received.length).toBe(1);
        expect(handle.inspectTaskState().consult.llmCalls).toBe(1);
        expect(handle.inspectTaskState().consult.replayed).toBe(1);
    });
});

describe("consult 端口 / 越权与冒名", () => {
    it("越权回复（维护者签计划修订）→ 整条丢弃 + consult_refused，并继续等到正确答案", async () => {
        const st = makeStation("architect", roles.architect);
        const handle = makeAgent(st.station, { consultTimeoutMs: 2_000 });
        st.heard(async (req) => {
            st.pushToDeveloper(replyOf(req, {
                from: "maintainer", answer: "我替你改了计划",
                amendment: { kind: "plan_revision", detail: "删掉 w4" },
            }), "maintainer");
            await Bun.sleep(10);
            return replyOf(req, { from: "architect", answer: "正确答复" });
        });
        const reply = await handle.consultStation({ role: "architect", question: "计划要不要改？" });
        expect(reply?.answer).toBe("正确答复");
        const refused = payloadsOf(handle, CONSULT_EVENTS.refused);
        expect(refused.some((p) => String(p["note"] ?? "").includes("越权"))).toBe(true);
    });

    it("冒名回复（自称工位与请求目标不符）→ 丢弃并继续等", async () => {
        const st = makeStation("architect", roles.architect);
        const handle = makeAgent(st.station, { consultTimeoutMs: 2_000 });
        st.heard(async (req) => {
            st.pushToDeveloper(replyOf(req, { from: "maintainer", answer: "我是维护者，我替他答" }), "maintainer");
            await Bun.sleep(10);
            return replyOf(req, { from: "architect", answer: "本尊答复" });
        });
        const reply = await handle.consultStation({ role: "architect", question: "w3 是否漏了鉴权？" });
        expect(reply?.answer).toBe("本尊答复");
        expect(payloadsOf(handle, CONSULT_EVENTS.refused).some((p) => String(p["note"] ?? "").includes("冒名"))).toBe(true);
    });

    it("工位明确拒绝（refused）→ 回复照样交给司机，并留 consult_refused 事件", async () => {
        // 注意座位名：请求发给 role="pm" 时，Hub 上等消息的是 "manager" 这个座位
        // （CONSULT_STATION_NAMES）——发错座位就是"坐等一个没人消费的空箱"。
        const st = makeStation("manager", roles.manager);
        const handle = makeAgent(st.station);
        st.heard((req) => replyOf(req, { from: "pm", answer: "这不是我能定的", refused: "需求问题请找 PM 澄清原文", confidence: "low" }));
        const reply = await handle.consultStation({ role: "pm", question: "技术栈选哪个？" });
        expect(reply?.from).toBe("pm");
        expect(reply?.refused).toContain("需求问题请找 PM");
        expect(payloadsOf(handle, CONSULT_EVENTS.refused).length).toBe(1);
    });
});

describe("consult 端口 / 预算记账", () => {
    it("costLlmCalls 进司机台账：llm_call_planned/completed 各一条（kind=consult）", async () => {
        const st = makeStation("architect", roles.architect);
        const handle = makeAgent(st.station);
        st.heard((req) => replyOf(req, { from: "architect", costLlmCalls: 1, confidence: "high" }));
        const reply = await handle.consultStation({ role: "architect", question: "技术栈的技术选型理由是什么？" });
        expect(reply?.costLlmCalls).toBe(1);
        const planned = handle.ledger.listEvents()
            .filter((e) => e.type === "llm_call_planned" && (e.payload as { kind?: string })?.kind === "consult");
        const completed = handle.ledger.listEvents()
            .filter((e) => e.type === "llm_call_completed" && (e.payload as { kind?: string })?.kind === "consult");
        expect(planned.length).toBe(1);
        expect(completed.length).toBe(1);
        expect(handle.inspectTaskState().consult).toMatchObject({ requested: 1, replied: 1, llmCalls: 1 });
    });

    it("确定性回答（costLlmCalls=0）不产生任何 LLM 台账——没花的钱不许记成花了", async () => {
        const st = makeStation("maintainer", roles.maintainer);
        const handle = makeAgent(st.station);
        st.heard((req) => replyOf(req, { from: "maintainer", costLlmCalls: 0 }));
        await handle.consultStation({ role: "maintainer", question: "哪几个任务定论了？" });
        expect(handle.inspectTaskState().consult.llmCalls).toBe(0);
    });
});

describe("consultStation 工具 / 默认拒绝与可用路径", () => {
    const registry = createDeveloperProcessRegistry();
    const ws = new Workspace({ projectDir, allowedRoots: ["frontend"], });
    const baseCtx: ToolContext = { workspace: ws, owner: "developerAgent", role: "developer", taskId: "p1-t1" };

    it("端口未注入 → 默认拒绝（只读子 Agent / Test 侧工具盒拿不到召唤权）", async () => {
        const r = await registry.invoke("consultStation", baseCtx, { role: "architect", question: "计划对吗？" });
        expect(r.ok).toBe(false);
        expect(r.meta?.["code"]).toBe("CONSULT_UNAVAILABLE");
    });

    it("未知工位 / 空问题 → 拒绝（顾问名不会被静默当成工位）", async () => {
        const withPort: ToolContext = {
            ...baseCtx, consultStation: async () => null,
        };
        const badRole = await registry.invoke("consultStation", withPort, { role: "architect-advisor", question: "看看" });
        expect(badRole.ok).toBe(false);
        expect(badRole.meta?.["code"]).toBe("CONSULT_UNKNOWN_ROLE");
        const noQuestion = await registry.invoke("consultStation", withPort, { role: "architect" });
        expect(noQuestion.ok).toBe(false);
    });

    it("超时（端口返回 null）→ 工具如实报「这条线断了」，模型自己决策，而不是整轮失败", async () => {
        const withPort: ToolContext = { ...baseCtx, consultStation: async () => null };
        const r = await registry.invoke("consultStation", withPort, { role: "architect", question: "计划对吗？" });
        expect(r.ok).toBe(false);
        expect(r.meta?.["code"]).toBe("CONSULT_TIMEOUT");
        expect(r.output).toContain("自行继续");
    });

    it("有回复 → 意见与**已生效修订**分开呈现（模型能分清哪句要照做）", async () => {
        const withPort: ToolContext = {
            ...baseCtx,
            consultStation: async (req) => ({
                type: "consult_reply", projectId: "p1", taskId: "p1-t1", consultId: "c-1",
                from: req.role, answer: "w3 的鉴权在 w4。",
                amendment: { kind: "batch_resend", detail: "重发 w3 批次" },
                confidence: "high", costLlmCalls: 1, refused: null,
            }),
        };
        const r = await registry.invoke("consultStation", withPort, {
            role: "architect", question: "计划里 w3 少了鉴权？", focus: ["w3"], evidence: { note: "构建通过但无鉴权" },
        });
        expect(r.ok).toBe(true);
        expect(r.output).toContain("已生效的修订");
        expect(r.output).toContain("batch_resend");
        expect(r.meta?.["confidence"]).toBe("high");
        expect(r.meta?.["costLlmCalls"]).toBe(1);
    });

    it("模型自报的 evidence 只当「发起方声明」进问题正文，不写进协议的 evidence 字段", async () => {
        let seen: ConsultRequest | null = null;
        const withPort: ToolContext = {
            ...baseCtx,
            consultStation: async (req) => {
                seen = req as unknown as ConsultRequest;
                return null;
            },
        };
        await registry.invoke("consultStation", withPort, {
            role: "test-core", question: "ac-3 是 409 吗？", evidence: { exitCode: 1, stderr: "boom" },
        });
        expect(seen).not.toBeNull();
        expect((seen as unknown as { evidence?: unknown }).evidence).toBeUndefined();
        expect((seen as unknown as { question: string }).question).toContain("未经机器核验");
        expect((seen as unknown as { question: string }).question).toContain("boom");
    });
});
