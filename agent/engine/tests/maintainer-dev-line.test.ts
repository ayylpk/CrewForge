// ============================================================
// tests/maintainer-dev-line.test.ts —— 维护工程师接 developer 新链路（零 LLM 零 DB）
//
//   fake station：真 TransferStation（纯内存 Hub，无网络无库）
//   fake sink：注入 TaskLedgerSink，sys_task 写入面只记调用不发 SQL
//
//   覆盖：三终态各自记账 / 终态重投幂等 / 矛盾终态只认第一个 /
//        declared+终态混合收敛触发 phase_done 恰好一次 / 未收敛不触发 /
//        blocked 带 failureSignature 透传进死因 / 旧 task_passed 路径仍工作（回滚保险）
// ============================================================

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { roles, TransferStation } from "../Hub";
import { Maintainer, type TaskLedgerSink } from "../maintainer";

/** sys_task 写入面的调用记录（等价于"该发生的 UPDATE"清单） */
interface SinkCall {
    pid: number;
    extId: string;
    status: string;
    errorMsg?: string;
    phaseId?: number | null;
}

/** 一个 harness = 一个干净的 maintainer 工位（阶段状态互不串台） */
function makeHarness() {
    const calls: SinkCall[] = [];
    const sink: TaskLedgerSink = {
        async setExtStatus(pid, extId, status, errorMsg, phaseId) {
            calls.push({ pid, extId, status, errorMsg, phaseId });
        },
    };
    const station = new TransferStation({}, {});
    station.register("architect-as", roles.architect);   // tasks_declared 按角色过滤，假架构师要有真角色
    const maintainer = new Maintainer(station, sink);
    void maintainer.start();   // 消息循环（纯内存，测试结束进程退出即回收）

    /** 投一条消息并等到 handler 真正跑完（markDone 排在 await 之后，pendingCount 归零=记账/收敛已发生） */
    async function deliver(from: string, payload: Record<string, unknown>): Promise<void> {
        station.sendMessage(from, "maintainer", JSON.stringify(payload));
        for (let i = 0; i < 400; i++) {
            if ((station.status["maintainer"]?.pendingCount ?? 0) === 0) return;
            await Bun.sleep(5);
        }
        throw new Error(`maintainer 收件箱未在时限内清空：${payload.type}`);
    }

    /** 架构师收件箱里收到的 phase_done（maintainer→architect 的收敛证据） */
    function phaseDonelist(): any[] {
        return (station.teams["architect"]?.inbox ?? [])
            .map(m => JSON.parse(m.content))
            .filter(c => c.type === "phase_done");
    }

    return { calls, station, deliver, phaseDonelist };
}

beforeAll(() => {
    // currentProjectId() 读 env——给个假项目号，让 sys_task 桥的写路径真的走起来（落到 fake sink）
    process.env.PROJECT_ID = "777";
});
afterAll(() => {
    delete process.env.PROJECT_ID;
});

describe("maintainer ← developer 终态（新链路记账）", () => {
    it("developer_ready → sys_task done（无 final 声明则不发 phase_done）", async () => {
        const h = makeHarness();
        await h.deliver("developer", {
            type: "developer_ready", projectId: "777", taskId: "777-p1",
            changedFiles: ["backend/src/main/java/Note.java", "frontend/src/views/Note.vue"],
            summary: "改动 2 个文件，修复 1 次",
        });
        expect(h.calls).toEqual([
            { pid: 777, extId: "777-p1", status: "done", errorMsg: undefined, phaseId: 0 },
        ]);
        expect(h.phaseDonelist().length).toBe(0);   // 定论有了，但架构师还没 final——不许收尾
    });

    it("developer_blocked → sys_task failed + reason 进 error_msg", async () => {
        const h = makeHarness();
        await h.deliver("developer", {
            type: "developer_blocked", projectId: "777", taskId: "777-p2",
            reason: "已达停止条件（重复失败 / 修复次数耗尽 / 预算超限）", failureSignature: null,
        });
        expect(h.calls.length).toBe(1);
        expect(h.calls[0]!.extId).toBe("777-p2");
        expect(h.calls[0]!.status).toBe("failed");
        expect(h.calls[0]!.errorMsg).toContain("已达停止条件");
    });

    it("developer_failed → sys_task failed + error 原文进 error_msg", async () => {
        const h = makeHarness();
        await h.deliver("developer", {
            type: "developer_failed", projectId: "777", taskId: "777-p3",
            error: "run 崩溃：workspace 丢失",
        });
        expect(h.calls.length).toBe(1);
        expect(h.calls[0]!.status).toBe("failed");
        expect(h.calls[0]!.errorMsg).toBe("run 崩溃：workspace 丢失");
    });

    it("blocked 带 failureSignature → 透传进死因文本", async () => {
        const h = makeHarness();
        await h.deliver("developer", {
            type: "developer_blocked", projectId: "777", taskId: "777-p4",
            reason: "TIMEOUT_REPEATED：命令「bun run build」连续超时两次，已停止重试",
            failureSignature: "sig-timeout-42",
        });
        expect(h.calls[0]!.errorMsg).toContain("TIMEOUT_REPEATED");
        expect(h.calls[0]!.errorMsg).toContain("failureSignature=sig-timeout-42");
    });

    it("同一终态重投幂等：只记一次账；矛盾终态（ready 后到 blocked）也只认第一个", async () => {
        const h = makeHarness();
        const ready = { type: "developer_ready", projectId: "777", taskId: "777-p5", changedFiles: [], summary: "ok" };
        await h.deliver("developer", ready);
        await h.deliver("developer", ready);   // 逐字节重投
        await h.deliver("developer", {
            type: "developer_blocked", projectId: "777", taskId: "777-p5",
            reason: "迟到的矛盾终态", failureSignature: null,
        });
        const mine = h.calls.filter(c => c.extId === "777-p5");
        expect(mine.length).toBe(1);
        expect(mine[0]!.status).toBe("done");   // 终态保护：done 不回退
    });

    it("declared+终态混合收敛：全部定论且 final → phase_done 恰好一次（重复投递不再触发）", async () => {
        const h = makeHarness();
        // 新形状：架构师按 developer taskId（flow 粒度）声明；phase 由声明携带 → 记账按 (project,phase,ext) 定位
        await h.deliver("architect-as", { type: "tasks_declared", phase: 6, pairIds: ["777-p6"], final: false });
        await h.deliver("developer", {
            type: "developer_ready", projectId: "777", taskId: "777-p6", changedFiles: ["a.ts"], summary: "改动 1 个文件",
        });
        expect(h.phaseDonelist().length).toBe(0);   // 未 final：不收敛
        await h.deliver("architect-as", { type: "tasks_declared", phase: 6, pairIds: [], final: true });
        const done1 = h.phaseDonelist();
        expect(done1.length).toBe(1);
        expect(done1[0]).toMatchObject({ phase: 6, failed: [] });
        expect(h.calls[0]).toMatchObject({ extId: "777-p6", status: "done", phaseId: 6 });
        // 重投终态 + 再收一条无主终态：都不得二次触发
        await h.deliver("developer", { type: "developer_failed", projectId: "777", taskId: "777-p6", error: "迟到" });
        expect(h.phaseDonelist().length).toBe(1);
    });

    it("未收敛不触发：declared 里还有没定论的 id", async () => {
        const h = makeHarness();
        await h.deliver("architect-as", { type: "tasks_declared", phase: 7, pairIds: ["A", "B"], final: true });
        await h.deliver("developer", { type: "developer_ready", projectId: "777", taskId: "A", changedFiles: [], summary: "" });
        expect(h.phaseDonelist().length).toBe(0);
    });

    it("developer 终态失败 → 进 phase_done 的 failed 清单（architect 侧语义不变）", async () => {
        const h = makeHarness();
        await h.deliver("architect-as", { type: "tasks_declared", phase: 8, pairIds: ["777-p8"], final: true });
        await h.deliver("developer", {
            type: "developer_blocked", projectId: "777", taskId: "777-p8",
            reason: "预算超限", failureSignature: "sig-9",
        });
        const done = h.phaseDonelist();
        expect(done.length).toBe(1);
        expect(done[0].failed).toEqual([
            { pairId: "777-p8", task: { id: "777-p8", method: "", path: "" }, issues: ["预算超限（failureSignature=sig-9）"], attempts: 1 },
        ]);
    });

    it("旧 task_passed 路径仍工作（回滚保险）：pair 两端 done + final 收敛触发 phase_done", async () => {
        const h = makeHarness();
        h.station.register("test-core", roles.testEngineer);   // 旧路径按角色过滤
        await h.deliver("architect-as", { type: "tasks_declared", phase: 9, pairIds: ["T1"], final: true });
        await h.deliver("test-core", {
            type: "task_passed", phase: 9,
            pair: { back: { id: "T1" }, front: { id: "T1-F" } },
        });
        expect(h.calls.map(c => [c.extId, c.status, c.phaseId])).toEqual([
            ["T1", "done", 9],
            ["T1-F", "done", 9],
        ]);
        expect(h.phaseDonelist().length).toBe(1);
    });
});
