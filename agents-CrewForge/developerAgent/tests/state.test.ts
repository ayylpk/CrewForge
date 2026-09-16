// tests/state.test.ts —— 状态机与判定纪律（纯函数，零 LLM）
import { describe, expect, it } from "bun:test";
import {
    ACCEPTANCE_STALL_LIMIT, assertStatusTransition, canGoReady, canTransitionStatus, initialDeveloperState,
    isAcceptanceStalled, isBudgetExceeded, isRepairExhausted, isRepeatedFailure, lastInboundType,
    nextArrivedWorkItem, nextUnarrivedWorkItem, nextWorkItem,
} from "../state";
import type { TestFailure } from "../protocol";

const failure = (sig: string): TestFailure => ({
    type: "test_failure",
    messageId: `msg-${sig}`, correlationId: "corr-1", runId: "run-1", acceptanceHash: "acc-1",
    projectId: "p", taskId: "t", category: "COMPILE",
    command: "npm", args: [], cwd: "frontend", exitCode: 1,
    stdout: "", stderr: "", affectedFiles: [], failureSignature: sig,
});

describe("state / 迁移表", () => {
    it("ready 只能从 testing 到达", () => {
        expect(canTransitionStatus("testing", "ready")).toBe(true);
        expect(canTransitionStatus("received", "ready")).toBe(false);
        expect(canTransitionStatus("inspecting", "ready")).toBe(false);
        expect(canTransitionStatus("implementing", "ready")).toBe(false);
        expect(canTransitionStatus("repairing", "ready")).toBe(false);
    });

    it("非法迁移抛错（不能悄悄跳到 ready）", () => {
        expect(() => assertStatusTransition("received", "ready")).toThrow();
        expect(() => assertStatusTransition("testing", "ready")).not.toThrow();
    });

    it("ready / blocked / failed 都是终态", () => {
        for (const to of ["received", "inspecting", "implementing", "testing"] as const) {
            expect(canTransitionStatus("ready", to)).toBe(false);
            expect(canTransitionStatus("blocked", to)).toBe(false);
            expect(canTransitionStatus("failed", to)).toBe(false);
        }
    });

    it("repair 之后回到 implementing（repair → runLocalChecks）", () => {
        expect(canTransitionStatus("repairing", "implementing")).toBe(true);
    });
});

describe("state / canGoReady（TestPassed 才是唯一入口）", () => {
    it("最后一条入站是 test_passed 才允许", () => {
        expect(canGoReady({ status: "testing", lastTestFailure: null, messages: [{ type: "test_passed" }] })).toBe(true);
        expect(canGoReady({ status: "testing", lastTestFailure: null, messages: [{ type: "test_failure" }] })).toBe(false);
        expect(canGoReady({ status: "testing", lastTestFailure: null, messages: [] })).toBe(false);
    });

    it("还有未消化的失败时不能 ready", () => {
        expect(canGoReady({
            status: "testing", lastTestFailure: failure("s1"), messages: [{ type: "test_passed" }],
        })).toBe(false);
    });

    it("状态不在 testing 时不能 ready", () => {
        expect(canGoReady({ status: "implementing", lastTestFailure: null, messages: [{ type: "test_passed" }] })).toBe(false);
        expect(canGoReady({ status: "repairing", lastTestFailure: null, messages: [{ type: "test_passed" }] })).toBe(false);
    });
});

describe("state / 停止条件", () => {
    it("同一 failureSignature 再次出现 = 重复", () => {
        expect(isRepeatedFailure({ failureSignatures: ["s1"], lastTestFailure: failure("s1") })).toBe(true);
        expect(isRepeatedFailure({ failureSignatures: ["s1"], lastTestFailure: failure("s2") })).toBe(false);
        expect(isRepeatedFailure({ failureSignatures: [], lastTestFailure: failure("s1") })).toBe(false);
    });

    it("修复次数耗尽", () => {
        expect(isRepairExhausted({ repairAttempts: 2, maxRepairAttempts: 2 })).toBe(true);
        expect(isRepairExhausted({ repairAttempts: 1, maxRepairAttempts: 2 })).toBe(false);
    });

    it("预算超限（规格九：用 >= 语义，达到上限即不得再发起）", () => {
        expect(isBudgetExceeded({ llmCallsCompleted: 41 }, 40)).toBe(true);
        expect(isBudgetExceeded({ llmCallsCompleted: 40 }, 40)).toBe(true);
        expect(isBudgetExceeded({ llmCallsCompleted: 39 }, 40)).toBe(false);
    });

    it("lastInboundType 取最后一条带 type 的消息", () => {
        expect(lastInboundType({ messages: [{ type: "a" }, { type: "b" }] })).toBe("b");
        expect(lastInboundType({ messages: [{ nope: 1 }] })).toBe(null);
    });
});

describe("state / 初始状态", () => {
    it("默认 status=received，修复上限 2", () => {
        const s = initialDeveloperState({ taskId: "t1" });
        expect(s.status).toBe("received");
        expect(s.maxRepairAttempts).toBe(2);
        expect(s.messages).toEqual([]);
    });

    it("分批模式默认关：batched=false、arrivedItems=[]（存量任务包零扰动）", () => {
        const s = initialDeveloperState({ taskId: "t1" });
        expect(s.batched).toBe(false);
        expect(s.arrivedItems).toEqual([]);
    });
});

// ============================================================
// 分批拆解（9/15）：waiting_item 状态 + 到齐判定的纯函数
//   语义：batched=true 时，工作项"没做完"不够，还要"批次已到"才能开工；
//   有未达项 = 流还开着，任何路由都不许走到 requestTest（判据未齐送检=静默欠验收）。
// ============================================================

describe("state / waiting_item 迁移", () => {
    it("implementing ⇄ waiting_item 合法；waiting_item 可收口 blocked", () => {
        expect(canTransitionStatus("implementing", "waiting_item")).toBe(true);
        expect(canTransitionStatus("waiting_item", "implementing")).toBe(true);
        expect(canTransitionStatus("waiting_item", "blocked")).toBe(true);
    });

    it("waiting_item 不得直达 ready/testing；waiting_test 不得跳 waiting_item（送检后判据必须冻结）", () => {
        expect(canTransitionStatus("waiting_item", "ready")).toBe(false);
        expect(canTransitionStatus("waiting_item", "testing")).toBe(false);
        expect(canTransitionStatus("waiting_test", "waiting_item")).toBe(false);
        expect(canTransitionStatus("repairing", "waiting_item")).toBe(false);
    });
});

describe("state / 批次到齐纯函数", () => {
    const items = [
        { id: "w1", kind: "foundation" as const },
        { id: "w2", kind: "backend" as const },
        { id: "w3", kind: "frontend" as const },
    ];
    const s = (completed: string[], arrived: string[]) =>
        ({ workItems: items, completedWorkItems: completed, arrivedItems: arrived });

    it("nextArrivedWorkItem：顺序取『未完且已达』的第一项", () => {
        expect(nextArrivedWorkItem(s(["w1"], ["w1", "w2"]))?.id).toBe("w2");
        // w2 未完但批次未到 → 没有可达项（不能替它开工，也不能跳序做 w3）
        expect(nextArrivedWorkItem(s(["w1"], ["w1"]))).toBeNull();
        expect(nextArrivedWorkItem(s(["w1", "w2", "w3"], ["w1", "w2", "w3"]))).toBeNull();
    });

    it("nextUnarrivedWorkItem：顺序取『未完且未达』的第一项（流关闭判定的依据）", () => {
        expect(nextUnarrivedWorkItem(s(["w1"], ["w1", "w3"]))?.id).toBe("w2");
        expect(nextUnarrivedWorkItem(s([], ["w1", "w2", "w3"]))).toBeNull();
        expect(nextUnarrivedWorkItem(s(["w1", "w2"], ["w1", "w2"]))?.id).toBe("w3");
    });

    it("旧 nextWorkItem 语义不变：不看 arrivedItems（batched=false 的存量链路零扰动）", () => {
        expect(nextWorkItem(s(["w1"], []))?.id).toBe("w2");
    });
});

// ============================================================
// B2：验收预演「无进展」判定（治模型自调 runAcceptance 空转——p7 的 23 次空转）
describe("B2 验收无进展：isAcceptanceStalled（连续零变化才停，不是单次）", () => {
    it("阈值语义：连续 < LIMIT 不停，达到 LIMIT 才停", () => {
        expect(isAcceptanceStalled({ acceptanceStallCount: 0 })).toBe(false);
        expect(isAcceptanceStalled({ acceptanceStallCount: ACCEPTANCE_STALL_LIMIT - 1 })).toBe(false);
        expect(isAcceptanceStalled({ acceptanceStallCount: ACCEPTANCE_STALL_LIMIT })).toBe(true);
        expect(isAcceptanceStalled({ acceptanceStallCount: ACCEPTANCE_STALL_LIMIT + 5 })).toBe(true);
    });

    it("默认初始状态就是不停（存量状态零扰动）", () => {
        expect(isAcceptanceStalled(initialDeveloperState({}))).toBe(false);
    });
});
