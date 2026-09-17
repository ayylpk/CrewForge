// ============================================================
// tests/consult-stations.test.ts —— 四个工位**真的会答**（层 B 的工位侧接线）
//
//   这一层是"接力变召唤"的落点：以前 PM/架构师/测试/维护者只在流水线的固定位置
//   出现一次（发完批/收完工就退出），中途司机问不到任何人；现在召唤请求进各工位
//   自己的消息分发口，工位用**自己持有的事实**作答，并在自己的产物上行使职权。
//
//   覆盖：maintainer（确定性应答 + 发错人也给明确拒绝）、test-core（判据 id 事实 +
//        签发判据澄清 → 下一次召唤能看见它）、architect（确定性应答不编事实 +
//        按召唤**真的重发批次**）。
//   PM 的接线点在 projectRunner.drivePhases（Manager 没有自己的消息循环），
//   它的 ownContext/amend 走 DB，**不在本文件覆盖范围**（零 DB 测试约定）。
//
//   全程零 LLM、零网络：LLM 端口一律注脚本化 fake；确定性路径不注。
// ============================================================

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { roles, TransferStation } from "../Hub";
import { Maintainer, type TaskLedgerSink } from "../maintainer";
import { TestEngineer } from "../testEngineer";
import { Architect } from "../architect";
import { newConsultId } from "../consult";
import type { ConsultReply, ConsultRequest, ConsultRole } from "../consult";

// ---------- 工位夹具 ----------

const noopSink: TaskLedgerSink = { setExtStatus: async () => { /* 零 DB：只验证召唤链路 */ } };

/** 一个干净的站点 + 一张"司机"座位（回信落点） */
function makeStation() {
    const station = new TransferStation({}, {});
    station.register("developer", roles.unknown);
    return station;
}

/** 投一条召唤请求，等工位回信（非 consult_reply 的消息一并收下，供调用方断言副作用） */
async function consultRound(
    station: TransferStation, seat: ConsultRole | string, payload: unknown, timeoutMs = 4_000,
): Promise<{ reply: ConsultReply; others: Record<string, any>[] }> {
    station.sendMessage("developer", String(seat), JSON.stringify(payload));
    const others: Record<string, any>[] = [];
    // 单一在途等待（single-flight）：Hub 收件箱只有一条队列，两次并发 waitForMessage
    // 会在同一条消息上一起醒来、其中一个 shift 到 undefined——测试夹具不重演这个坑。
    let pending: Promise<{ content: string } | null> | null = null;
    const take = (): Promise<{ content: string } | null> => {
        if (!pending) {
            pending = station.waitForMessage("developer").then((m) => { pending = null; return m; });
        }
        return pending;
    };
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const m = await Promise.race([
            take(),
            new Promise<null>((res) => setTimeout(() => res(null), 100)),
        ]);
        if (!m) continue;      // 没消息：在途等待继续存活，下一次接着用
        station.markDone("developer");
        let data: Record<string, any> | null = null;
        try { data = JSON.parse(m.content) as Record<string, any>; } catch { data = null; }
        if (!data) continue;
        if (data["type"] === "consult_reply") return { reply: data as unknown as ConsultReply, others };
        others.push(data);
    }
    throw new Error(`工位「${seat}」未在 ${timeoutMs}ms 内应答`);
}

const ask = (over: Partial<ConsultRequest> = {}): ConsultRequest => ({
    type: "consult_request",
    projectId: "99001-p1-project", taskId: "99001-p1", consultId: newConsultId("99001-p1", 1),
    from: "developer", to: "maintainer",
    question: "这批里哪些任务已经定论了？",
    ...over,
});

// ---------- maintainer ----------

describe("层 B / maintainer 会被召唤", () => {
    it("确定性应答：只复述收敛事实，且说清不持有判据/代码", async () => {
        const station = makeStation();
        const maintainer = new Maintainer(station, noopSink);
        void maintainer.start();
        const { reply } = await consultRound(station, "maintainer", ask());
        expect(reply.from).toBe("maintainer");
        expect(reply.confidence).toBe("low");
        expect(reply.refused).toBeNull();
        expect(reply.costLlmCalls).toBe(0);
        expect(reply.amendment).toBeNull();                 // 无 LLM 不签发修订（不越权）
        expect(reply.answer).toContain("维护者当前持有的收敛状态");
        expect(reply.answer).toContain("不持有的信息");
        expect(reply.answer).toContain("本阶段是否已声明 final：否");
    });

    it("发错人的请求（to=architect 投到 maintainer）→ 明确拒绝，而不是静默吞掉", async () => {
        const station = makeStation();
        const maintainer = new Maintainer(station, noopSink);
        void maintainer.start();
        const { reply } = await consultRound(station, "maintainer", ask({ to: "architect" }));
        expect(reply.refused).not.toBeNull();
        expect(reply.refused ?? "").toContain("投递错误");
        expect(reply.from).toBe("maintainer");
    });

    it("搁置说明只作为意见（本工位零 LLM，没有判断能力就不签职权动作）", async () => {
        const station = makeStation();
        const maintainer = new Maintainer(station, noopSink);
        void maintainer.start();
        const { reply } = await consultRound(station, "maintainer", ask({
            question: "t9 这个失败项能不能作为搁置项接受（acceptance_note）？",
        }));
        expect(reply.amendment).toBeNull();
        expect(reply.answer).toContain("不签发任何修订");
    });
});

// ---------- test-core ----------

describe("层 B / test-core 会被召唤并真的澄清判据", () => {
    it("判据 id 是它持有的事实：ownContext 里逐条列出", async () => {
        const station = makeStation();
        const checks = [{ id: "ac-1" }, { id: "ac-2" }, { id: "ac-3" }];
        const test = new TestEngineer("test-core", station, [], {
            verifier: async () => { throw new Error("本测试不跑验收"); },
            taskChecks: () => checks,
        });
        void test.start();
        const { reply } = await consultRound(station, "test-core", ask({ to: "test-core", question: "本任务的判据有哪些？" }));
        expect(reply.from).toBe("test-core");
        expect(reply.answer).toContain("ac-1、ac-2、ac-3");
        expect(reply.answer).toContain("判定权在独立 TestAgent");   // 判定权不在它手上，它自己说清
    });

    it("签发 criterion_clarification → 修订进它自己的产物（下一次召唤看得见）", async () => {
        const station = makeStation();
        let llmCalls = 0;
        const test = new TestEngineer("test-core", station, [], {
            verifier: async () => { throw new Error("本测试不跑验收"); },
            taskChecks: () => [{ id: "ac-3" }],
            // 脚本化 LLM（两次调用两种行为）：第一次提议一条它**有权**签发的修订，
            // 第二次只"读自己的上下文"作答——用第二问证明修订**真的落进了它的产物**。
            consultLlm: async (prompt) => {
                llmCalls++;
                if (llmCalls === 1) {
                    expect(prompt).toContain("ac-3");      // 问题真的进了提示词
                    return JSON.stringify({
                        answer: "ac-3 的语义是「重复下单返回 409」。",
                        amendment: { kind: "criterion_clarification", detail: "ac-3 期望状态码 409", payload: { checkId: "ac-3" } },
                        confidence: "high", refused: null,
                    });
                }
                return JSON.stringify({
                    answer: prompt.includes("ac-3 期望状态码 409")
                        ? "我记录的澄清是：ac-3 期望状态码 409"
                        : "（我这边没有澄清记录）",
                    amendment: null, confidence: "medium", refused: null,
                });
            },
        });
        void test.start();
        const first = await consultRound(station, "test-core", ask({ to: "test-core", question: "ac-3 期望什么状态码？" }));
        expect(first.reply.amendment?.kind).toBe("criterion_clarification");
        expect(first.reply.answer).toContain("[修订已生效]");
        expect(first.reply.costLlmCalls).toBe(1);
        // ★ 职权落在**它自己的产物**上：再问一次，澄清已经在它持有的事实里
        const second = await consultRound(station, "test-core", ask({
            to: "test-core", consultId: newConsultId("99001-p1", 2), question: "你记过哪些澄清？",
        }));
        expect(second.reply.answer).toContain("我记录的澄清是：ac-3 期望状态码 409");
    });
});

// ---------- architect ----------

describe("层 B / architect 会被召唤（含真的重发批次）", () => {
    const PID = 99001;
    const TASK_ID = "99001-p1";
    const oldProjectId = process.env.PROJECT_ID;
    const runsRoot = path.resolve(process.cwd(), "runs");
    const taskDir = path.join(runsRoot, `p${PID}`, "_tasks", TASK_ID);

    beforeAll(() => {
        process.env.PROJECT_ID = String(PID);
        // 复刻派发节点落盘的产物：蓝图 + 一批已经拆好的批次
        fs.mkdirSync(taskDir, { recursive: true });
        fs.writeFileSync(path.join(taskDir, "blueprint.json"), JSON.stringify({
            type: "architect_task", projectId: String(PID), taskId: TASK_ID,
            requirementSnapshot: { goal: "便签管理" },
            stackProfile: { frontend: "vue3", backend: "express" },
            domainModel: { entity: "note" },
            contract: { version: "1", endpoints: [] },
            foundationPlan: { dirs: ["backend", "frontend"], workItems: [{ id: "w1", kind: "foundation" }, { id: "w2", kind: "frontend" }] },
            allowedRoots: ["backend", "frontend"], forbiddenPaths: [],
            acceptanceChecks: [{ id: "ac-1" }], developerInstructions: "",
        }), "utf-8");
        fs.writeFileSync(path.join(taskDir, "batch-w1.json"), JSON.stringify({
            type: "architect_batch", projectId: String(PID), taskId: TASK_ID,
            itemId: "w1", detail: "先搭骨架", checks: [{ id: "ac-1" }],
        }), "utf-8");
    });

    afterAll(() => {
        if (oldProjectId === undefined) delete process.env.PROJECT_ID;
        else process.env.PROJECT_ID = oldProjectId;
        fs.rmSync(path.join(runsRoot, `p${PID}`), { recursive: true, force: true });
    });

    it("确定性应答：读不到就如实说读不到（不编蓝图的形状）", async () => {
        const station = makeStation();
        const architect = new Architect(station, undefined as never, undefined as never, { deterministicOnly: true });
        void architect.start();
        const { reply } = await consultRound(station, "architect", ask({
            to: "architect", taskId: "99001-p1", projectId: String(PID), question: "工作项顺序是什么？",
        }));
        expect(reply.from).toBe("architect");
        expect(reply.answer).toContain("w1(foundation) → w2(frontend)");
        expect(reply.answer).toContain("尚未交付");
        expect(reply.amendment).toBeNull();
    });

    it("批次重发是**真动作**：按召唤把待发批次重新推给司机（并报 amendment 已生效）", async () => {
        const station = makeStation();
        const architect = new Architect(station, undefined as never, undefined as never, {
            consultLlm: async () => JSON.stringify({
                answer: "w1 的批次还没发出去，我现在重发一次。",
                amendment: { kind: "batch_resend", detail: "重发 w1 批次", payload: { itemId: "w1" } },
                confidence: "high", refused: null,
            }),
        });
        void architect.start();
        const { reply, others } = await consultRound(station, "architect", ask({
            to: "architect", taskId: TASK_ID, projectId: String(PID), question: "w1 的批次发出去了吗？重发一次。",
        }));
        expect(reply.amendment?.kind).toBe("batch_resend");
        expect(reply.answer).toContain("[修订已生效]");
        // ★ 副作用的真凭据：司机座位上真的收到了一条 architect_batch（不是"我以为它发了"）
        const batchMsg = others.find((m) => m["type"] === "architect_batch");
        expect(batchMsg).toBeDefined();
        expect(batchMsg?.["itemId"]).toBe("w1");
        expect(batchMsg?.["taskId"]).toBe(TASK_ID);
    });

    it("批次文件不存在时退回：不假装已重发（未生效要说得明白）", async () => {
        const station = makeStation();
        const architect = new Architect(station, undefined as never, undefined as never, {
            consultLlm: async () => JSON.stringify({
                answer: "我重发 w2。",
                amendment: { kind: "batch_resend", detail: "重发 w2 批次", payload: { itemId: "w2" } },
                confidence: "high", refused: null,
            }),
        });
        void architect.start();
        const { reply, others } = await consultRound(station, "architect", ask({
            to: "architect", taskId: TASK_ID, projectId: String(PID), question: "重发 w2 批次。",
        }));
        expect(reply.amendment).toBeNull();
        expect(reply.answer).toContain("[修订未生效]");
        expect(others.some((m) => m["type"] === "architect_batch")).toBe(false);
    });

    it("越权 kind（架构师签判据澄清）→ 丢弃修订，只留意见", async () => {
        const station = makeStation();
        const architect = new Architect(station, undefined as never, undefined as never, {
            consultLlm: async () => JSON.stringify({
                answer: "我顺手把判据也澄清了",
                amendment: { kind: "criterion_clarification", detail: "ac-1 应该是 201" },
                confidence: "medium", refused: null,
            }),
        });
        void architect.start();
        const { reply } = await consultRound(station, "architect", ask({
            to: "architect", taskId: TASK_ID, projectId: String(PID), question: "ac-1 是什么语义？",
        }));
        expect(reply.amendment).toBeNull();
        expect(reply.answer).toContain("[越权修订已丢弃]");
        expect(reply.answer).toContain("test-core");
    });
});
