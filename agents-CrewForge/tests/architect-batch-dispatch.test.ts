// ============================================================
// tests/architect-batch-dispatch.test.ts —— 两阶段派发（蓝图先行 + 按工作项逐批）
//
//   被测：architectTaskBuilder.dispatchArchitectTaskBatched
//   （用户解耦测试第二项"架构师会不会按批次产出"的派发面）。
//   拆解逻辑本身在 developerAgent/architectAgent.ts（已 24 用例测绿），
//   这里测的是**接线**：发送顺序、逐批落盘、断点重放零重烧、幂等账本、
//   失败作废三件套（停发后续批 + cancel_task + manager 报告）。
//
//   零真机：LLM 用脚本化 Fake（照抄 architectAgent.test.ts 的 scriptedLlm 风格），
//   需求文本是本地字面量，DB 完全不碰（需求读取留在 architect.ts 接线层）。
// ============================================================

import { afterAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TransferStation } from "../Hub";
import { parseInbound } from "../developerAgent/protocol";
import type {
    ArchitectBatch, ArchitectTask, CancelTask, InboundMessage,
} from "../developerAgent/protocol";
import type { DeveloperLlm } from "../developerAgent/graph";
import {
    blueprintDispatchKeyOf, batchDispatchKeyOf,
    createMemoryDispatchRegistry, dispatchArchitectTaskBatched,
} from "../architectTaskBuilder";
import type { ArchEvent } from "../architectTaskBuilder";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cf-bdispatch-"));
afterAll(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 2 }); } catch { /* Windows 占用 */ }
});

const REQ = "做一个便签管理小工具：可新增、查看、删除便签。前后端分离。";

// ---------- fixtures：蓝图 + 四个工作项的批次（形状抄 architectAgent.test.ts） ----------

/** 合法蓝图：ArchitectTaskSchema 严格 12 字段；COMPILE 底线覆盖两个 allowedRoots */
const BLUEPRINT = {
    type: "architect_task",
    projectId: "p1", taskId: "t1",
    requirementSnapshot: { goal: "便签管理" },
    stackProfile: { frontend: "vue3+vite", backend: "node+express", database: "sqlite" },
    domainModel: { entity: "Note(id,title,content)" },
    contract: {
        version: "1",
        endpoints: [{ method: "GET", path: "/api/notes", purpose: "列表" }],
    },
    foundationPlan: {
        dirs: ["backend", "frontend"],
        workItems: [
            { id: "w1", kind: "foundation", title: "搭骨架" },
            { id: "w2", kind: "backend", title: "便签接口" },
            { id: "w3", kind: "frontend", title: "便签页面" },
            { id: "w4", kind: "pre-test", title: "自检" },
        ],
    },
    allowedRoots: ["backend", "frontend"],
    forbiddenPaths: [],
    acceptanceChecks: [
        { id: "ac-1", kind: "COMPILE", target: "backend" },
        { id: "ac-2", kind: "COMPILE", target: "frontend" },
    ],
    developerInstructions: "按顺序做",
};

function mkBatch(itemId: string, checks: unknown[] = []): string {
    return JSON.stringify({
        type: "architect_batch", projectId: "p1", taskId: "t1",
        itemId, detail: `工作项 ${itemId} 的详规：分层 routes/service/db，对接 GET /api/notes`,
        checks,
    });
}
/** 命中蓝图 endpoints 的 CONTRACT 判据（w2/w3 是业务项：批必须带 ≥1 条判据） */
const AC_GET = { id: "ac-3", kind: "CONTRACT", method: "GET", path: "/api/notes", expectedStatus: 200 };
const AC_GET_2 = { id: "ac-4", kind: "CONTRACT", method: "GET", path: "/api/notes", expectedStatus: 200 };

/** 完整一轮的脚本输出：蓝图 → w1（骨架）→ w2（后端）→ w3（前端）→ w4（自检） */
function fullRun(): string[] {
    return [
        JSON.stringify(BLUEPRINT),
        mkBatch("w1"),
        mkBatch("w2", [AC_GET]),
        mkBatch("w3", [AC_GET_2]),
        mkBatch("w4"),
    ];
}

/** 脚本化 Fake LLM（同 architectAgent.test.ts 的 scriptedLlm） */
function scriptedLlm(decisions: unknown[]) {
    let calls = 0;
    const llm: DeveloperLlm = {
        id: "fake",
        calls: () => calls,
        async next() {
            calls++;
            return decisions[Math.min(calls - 1, decisions.length - 1)];
        },
    };
    return { llm, count: () => calls };
}

function newStation(): TransferStation {
    return new TransferStation({}, {});
}

/** developer 收件箱 → 逐条 parseInbound（任何一条非法都直接把错误抛给测试失败信息） */
function devInbox(station: TransferStation): InboundMessage[] {
    return (station.teams["developer"]?.inbox ?? []).map((m) => {
        const parsed = parseInbound(m.content);
        if (!parsed.ok) throw new Error(`developer 收件箱有消息过不了 parseInbound：${parsed.error}`);
        return parsed.message;
    });
}
function mgrInbox(station: TransferStation): Record<string, unknown>[] {
    return (station.teams["manager"]?.inbox ?? []).map((m) => JSON.parse(m.content) as Record<string, unknown>);
}

let seq = 0;
const nextLedger = (): string => path.join(tmp, `disp-${seq++}.db`);

// ============================================================
describe("两阶段派发 / 正常链路", () => {
    it("1. 蓝图先于一切批次；批次严格按 workItems 顺序（w1→w4）", async () => {
        const station = newStation();
        const { llm } = scriptedLlm(fullRun());
        const out = await dispatchArchitectTaskBatched({
            station, requirement: REQ, projectId: "p1", taskId: "t1", llm,
            taskDir: path.join(tmp, "t1-dir"), ledgerPath: nextLedger(),
        });
        expect(out.ok).toBe(true);
        expect(out.stage).toBe("done");

        const msgs = devInbox(station);
        expect(msgs.length).toBe(5);                                  // 1 蓝图 + 4 批
        expect(msgs[0]!.type).toBe("architect_task");
        expect(msgs.slice(1).map((m) => (m as ArchitectBatch).itemId)).toEqual(["w1", "w2", "w3", "w4"]);
        expect(out.batches.length).toBe(4);
    });

    it("2. 三消息身份逐字一致（projectId/taskId），发送方 architect 接收方 developer", async () => {
        const station = newStation();
        const { llm } = scriptedLlm(fullRun());
        const out = await dispatchArchitectTaskBatched({
            station, requirement: REQ, projectId: "p1", taskId: "t1", llm,
            taskDir: path.join(tmp, "t2-dir"), ledgerPath: nextLedger(),
        });
        expect(out.ok).toBe(true);
        const ids = devInbox(station).map((m) => `${m.projectId}/${m.taskId}`);
        expect(new Set(ids).size).toBe(1);
        expect(ids[0]).toBe("p1/t1");
        const inbox = station.teams["developer"]!.inbox;
        expect(inbox.every((m) => m.sender === "architect" && m.receiver === "developer")).toBe(true);
    });

    it("3. 每条消息（蓝图+各批）都过 parseInbound —— devInbox 已经逐条断言，这里查批次内容", async () => {
        const station = newStation();
        const { llm } = scriptedLlm(fullRun());
        await dispatchArchitectTaskBatched({
            station, requirement: REQ, projectId: "p1", taskId: "t1", llm,
            taskDir: path.join(tmp, "t3-dir"), ledgerPath: nextLedger(),
        });
        const batches = devInbox(station).slice(1) as ArchitectBatch[];
        expect(batches.every((b) => b.detail.length > 0)).toBe(true);
        // 业务项（backend/frontend）批带判据；foundation/pre-test 允许空
        expect(batches.find((b) => b.itemId === "w2")!.checks.length).toBe(1);
        expect(batches.find((b) => b.itemId === "w1")!.checks.length).toBe(0);
    });

    it("4. 逐批即时落盘：blueprint.json + batch-{itemId}.json，内容与发出的消息一致", async () => {
        const dir = path.join(tmp, "t4-dir");
        const station = newStation();
        const { llm } = scriptedLlm(fullRun());
        const out = await dispatchArchitectTaskBatched({
            station, requirement: REQ, projectId: "p1", taskId: "t1", llm,
            taskDir: dir, ledgerPath: nextLedger(),
        });
        expect(out.ok).toBe(true);
        expect(fs.existsSync(path.join(dir, "blueprint.json"))).toBe(true);
        for (const id of ["w1", "w2", "w3", "w4"]) {
            expect(fs.existsSync(path.join(dir, `batch-${id}.json`))).toBe(true);
        }
        const bp = JSON.parse(fs.readFileSync(path.join(dir, "blueprint.json"), "utf-8")) as ArchitectTask;
        const b2 = JSON.parse(fs.readFileSync(path.join(dir, "batch-w2.json"), "utf-8")) as ArchitectBatch;
        expect(devInbox(station)[0]).toEqual(bp);                     // 盘上=发出的同一份
        expect(b2.itemId).toBe("w2");
    });
});

// ============================================================
describe("两阶段派发 / 重放与幂等", () => {
    it("5. 断点重放零重烧：文件在 → 第二次运行一次 LLM 都不调，消息照常发满", async () => {
        const dir = path.join(tmp, "t5-dir");
        // 第一轮：完整跑，产生落盘
        const s1 = newStation();
        const r1 = scriptedLlm(fullRun());
        const out1 = await dispatchArchitectTaskBatched({
            station: s1, requirement: REQ, projectId: "p1", taskId: "t1", llm: r1.llm,
            taskDir: dir, ledgerPath: nextLedger(),
        });
        expect(out1.ok).toBe(true);
        expect(r1.count()).toBe(5);                                   // 蓝图1 + 批4

        // 第二轮：同一 taskDir，全新 LLM/账本/station —— 全靠磁盘重放
        const s2 = newStation();
        const r2 = scriptedLlm(["绝不该被调用"]);
        const out2 = await dispatchArchitectTaskBatched({
            station: s2, requirement: REQ, projectId: "p1", taskId: "t1", llm: r2.llm,
            taskDir: dir, ledgerPath: nextLedger(),
        });
        expect(out2.ok).toBe(true);
        expect(out2.stage).toBe("done");
        expect(r2.count()).toBe(0);                                   // ★ 零重烧
        expect(devInbox(s2).map((m) => m.type)).toEqual([            // 新接收方收满 5 条
            "architect_task", "architect_batch", "architect_batch", "architect_batch", "architect_batch",
        ]);
        expect(out2.deduped).toEqual([]);                             // 新账本，不是去重发出去的
    });

    it("6. 幂等账本防重发：蓝图+每批分别记账，同内容重跑一条都不再发", async () => {
        const registry = createMemoryDispatchRegistry();
        const s1 = newStation();
        const out1 = await dispatchArchitectTaskBatched({
            station: s1, requirement: REQ, projectId: "p1", taskId: "t1",
            llm: scriptedLlm(fullRun()).llm,
            taskDir: path.join(tmp, "t6-dir"), registry,
        });
        expect(out1.ok).toBe(true);
        expect(s1.teams["developer"]!.inbox.length).toBe(5);

        // 第二轮：无落盘目录（重新走 LLM），但同内容 → 同键 → 全部去重
        const s2 = newStation();
        const out2 = await dispatchArchitectTaskBatched({
            station: s2, requirement: REQ, projectId: "p1", taskId: "t1",
            llm: scriptedLlm(fullRun()).llm,
            registry,
        });
        expect(out2.ok).toBe(true);
        expect(out2.deduped).toEqual(["blueprint", "w1", "w2", "w3", "w4"]);
        expect(s2.teams["developer"]?.inbox.length ?? 0).toBe(0);    // ★ 一条都没重发
    });

    it("7. 幂等键：内容寻址——同内容同键；批内容变（模型重拆）键变 → 允许重发", () => {
        const bp = (parseInbound(JSON.stringify(BLUEPRINT)) as { ok: true; message: ArchitectTask }).message;
        const b1 = (parseInbound(mkBatch("w2", [AC_GET])) as { ok: true; message: ArchitectBatch }).message;
        const b2 = (parseInbound(mkBatch("w2", [{ ...AC_GET, expectedStatus: 201 }])) as { ok: true; message: ArchitectBatch }).message;
        expect(blueprintDispatchKeyOf("t1", bp)).toBe(blueprintDispatchKeyOf("t1", JSON.parse(JSON.stringify(bp))));
        expect(batchDispatchKeyOf("t1", b1)).toBe(batchDispatchKeyOf("t1", JSON.parse(JSON.stringify(b1))));
        expect(batchDispatchKeyOf("t1", b1)).not.toBe(batchDispatchKeyOf("t1", b2));
        expect(blueprintDispatchKeyOf("t1", bp)).not.toBe(batchDispatchKeyOf("t1", b1));
    });
});

// ============================================================
describe("两阶段派发 / 失败语义（整次作废）", () => {
    it("8. 某批 3 连拒 → 停发后续批 + cancel_task + manager 报告", async () => {
        const station = newStation();
        // 蓝图✓、w1✓，w2 连拒 3 次（"垃圾输出"抠不出 JSON → 走满 maxAttempts 抛错）
        const { llm, count } = scriptedLlm([
            JSON.stringify(BLUEPRINT), mkBatch("w1"), "垃圾", "垃圾", "垃圾",
        ]);
        const events: ArchEvent[] = [];
        const out = await dispatchArchitectTaskBatched({
            station, requirement: REQ, projectId: "p1", taskId: "t1", llm,
            taskDir: path.join(tmp, "t8-dir"), ledgerPath: nextLedger(),
            onEvent: (e) => events.push(e),
        });
        expect(out.ok).toBe(false);
        expect(out.stage).toBe("batch");
        expect(out.failedItemId).toBe("w2");
        expect(out.cancelled).toBe(true);
        expect(count()).toBe(5);                                      // 1+1+3：w3/w4 没被烧
        // 落盘只到 w1：w2 没产出，w3/w4 没派发
        expect(fs.existsSync(path.join(tmp, "t8-dir", "batch-w2.json"))).toBe(false);

        const msgs = devInbox(station);
        expect(msgs.map((m) => m.type)).toEqual(["architect_task", "architect_batch", "cancel_task"]);
        const cancel = msgs[2] as CancelTask;
        expect(cancel.projectId).toBe("p1");
        expect(cancel.taskId).toBe("t1");
        expect(cancel.reason).toContain("w2");
        expect(msgs.length).toBe(3);                                  // ★ 后续批被刹住

        const mgr = mgrInbox(station);
        expect(mgr.length).toBe(1);
        expect(mgr[0]!["type"]).toBe("architect_dispatch_failed");
        expect(mgr[0]!["failedItemId"]).toBe("w2");
        expect(mgr[0]!["stage"]).toBe("batch");
        expect(events.map((e) => e.type)).toContain("dispatch_cancelled");
        expect(events.map((e) => e.type)).toContain("dispatch_failed");
    });

    it("9. 蓝图 3 连拒 → 什么都没发（不发 cancel：没有东西可作废），只向 manager 报告", async () => {
        const station = newStation();
        const { llm, count } = scriptedLlm(["垃圾", "垃圾", "垃圾"]);
        const out = await dispatchArchitectTaskBatched({
            station, requirement: REQ, projectId: "p1", taskId: "t1", llm,
            taskDir: path.join(tmp, "t9-dir"), ledgerPath: nextLedger(),
        });
        expect(out.ok).toBe(false);
        expect(out.stage).toBe("blueprint");
        expect(out.cancelled).toBe(false);
        expect(count()).toBe(3);
        expect(station.teams["developer"]?.inbox.length ?? 0).toBe(0);  // developer 零消息
        const mgr = mgrInbox(station);
        expect(mgr.length).toBe(1);
        expect(mgr[0]!["type"]).toBe("architect_dispatch_failed");
        expect(mgr[0]!["stage"]).toBe("blueprint");
    });

    it("10. 需求原文为空 → 不起 LLM 直接失败（不猜需求）", async () => {
        const station = newStation();
        const { llm, count } = scriptedLlm(fullRun());
        const out = await dispatchArchitectTaskBatched({
            station, requirement: "   ", projectId: "p1", taskId: "t1", llm,
            taskDir: path.join(tmp, "t10-dir"), ledgerPath: nextLedger(),
        });
        expect(out.ok).toBe(false);
        expect(out.stage).toBe("blueprint");
        expect(count()).toBe(0);
        expect(station.teams["developer"]?.inbox.length ?? 0).toBe(0);
    });
});
