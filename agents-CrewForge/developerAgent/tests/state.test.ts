// tests/state.test.ts —— 状态机与判定纪律（纯函数，零 LLM）
import { describe, expect, it } from "bun:test";
import {
    assertStatusTransition, canGoReady, canTransitionStatus, initialDeveloperState,
    isBudgetExceeded, isRepairExhausted, isRepeatedFailure, lastInboundType,
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
});
