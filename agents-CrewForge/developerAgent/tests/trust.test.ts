// tests/trust.test.ts —— TestPassed 信任链、验收指纹、授权收窄（规格二 / 八 / 十二）
import { describe, expect, it } from "bun:test";
import {
    acceptanceHashOf, canonicalJson, validateTestFailure, validateTestPassed,
} from "../protocol";
import type { TestFailure, TestPassed, TestTrustContext } from "../protocol";
import { intersectRoots } from "../graph";

const ev = (exitCode = 0) => ({
    checkId: "k1", command: "npm", args: ["run", "build"], cwd: "frontend",
    exitCode, startedAt: 1, finishedAt: 2, inputHash: "i", stdoutHash: "o", stderrHash: "e",
});

const ctx: TestTrustContext = {
    trustedSenders: ["test-core"],
    projectId: "p1", taskId: "t1", runId: "r1",
    correlationId: "c1", acceptanceHash: "a1",
};

const pass = (patch: Partial<TestPassed> = {}): TestPassed => ({
    type: "test_passed", messageId: "m1", correlationId: "c1", runId: "r1",
    projectId: "p1", taskId: "t1", evidence: [ev(0)],
    verifiedBy: "test-core", acceptanceHash: "a1",
    ...patch,
});

const fail = (patch: Partial<TestFailure> = {}): TestFailure => ({
    type: "test_failure", messageId: "m1", correlationId: "c1", runId: "r1", acceptanceHash: "a1",
    projectId: "p1", taskId: "t1", category: "COMPILE",
    command: "npm", args: [], cwd: ".", exitCode: 1, stdout: "", stderr: "",
    affectedFiles: [], failureSignature: "s1",
    ...patch,
});

describe("trust / 全部匹配才放行", () => {
    it("受信 TestAgent + 身份 + 指纹 + 证据全对 → 通过", () => {
        const v = validateTestPassed(pass(), "test-core", ctx);
        expect(v.ok).toBe(true);
        expect(v.reasons).toEqual([]);
    });
});

describe("trust / TestPassed 的每一条拒绝路径", () => {
    it("① 非 TestAgent 发送 → 拒绝", () => {
        const v = validateTestPassed(pass(), "pm", ctx);
        expect(v.ok).toBe(false);
        expect(v.reasons.join("；")).toContain("受信");
    });

    it("② evidence 里 exitCode 非 0 → 拒绝", () => {
        const v = validateTestPassed(pass({ evidence: [ev(1)] }), "test-core", ctx);
        expect(v.ok).toBe(false);
        expect(v.reasons.join("；")).toContain("exitCode");
    });

    it("③ 起止时间倒挂 → 拒绝", () => {
        const bad = { ...ev(0), startedAt: 100, finishedAt: 1 };
        const v = validateTestPassed(pass({ evidence: [bad] }), "test-core", ctx);
        expect(v.ok).toBe(false);
        expect(v.reasons.join("；")).toContain("倒挂");
    });

    it("④ projectId / taskId / runId 不匹配 → 拒绝", () => {
        expect(validateTestPassed(pass({ projectId: "other" }), "test-core", ctx).ok).toBe(false);
        expect(validateTestPassed(pass({ taskId: "other" }), "test-core", ctx).ok).toBe(false);
        expect(validateTestPassed(pass({ runId: "other" }), "test-core", ctx).ok).toBe(false);
    });

    it("⑤ correlationId 不匹配（过期/串线消息）→ 拒绝", () => {
        const v = validateTestPassed(pass({ correlationId: "expired" }), "test-core", ctx);
        expect(v.ok).toBe(false);
        expect(v.reasons.join("；")).toContain("correlationId");
    });

    it("⑥ acceptanceHash 不匹配（拿旧结论糊弄）→ 拒绝", () => {
        const v = validateTestPassed(pass({ acceptanceHash: "old" }), "test-core", ctx);
        expect(v.ok).toBe(false);
        expect(v.reasons.join("；")).toContain("acceptanceHash");
    });

    it("⑦ 名单为空 = 谁也不信（安全默认）", () => {
        expect(validateTestPassed(pass(), "test-core", { ...ctx, trustedSenders: [] }).ok).toBe(false);
    });
});

describe("trust / TestFailure 受同一套信任约束", () => {
    it("受信发送者 + 匹配身份 → 通过", () => {
        expect(validateTestFailure(fail(), "test-core", ctx).ok).toBe(true);
    });

    it("非受信发送者 / 指纹不符 → 拒绝", () => {
        expect(validateTestFailure(fail(), "someone-else", ctx).ok).toBe(false);
        expect(validateTestFailure(fail({ acceptanceHash: "old" }), "test-core", ctx).ok).toBe(false);
        expect(validateTestFailure(fail({ correlationId: "old" }), "test-core", ctx).ok).toBe(false);
    });
});

describe("trust / 验收指纹（acceptanceHash）", () => {
    it("键顺序不同但语义相同 → 同一个 hash", () => {
        expect(acceptanceHashOf([{ a: 1, b: { x: 1, y: 2 } }]))
            .toBe(acceptanceHashOf([{ b: { y: 2, x: 1 }, a: 1 }]));
    });

    it("内容变了 → hash 必变", () => {
        expect(acceptanceHashOf([{ a: 1 }])).not.toBe(acceptanceHashOf([{ a: 2 }]));
        expect(acceptanceHashOf([])).not.toBe(acceptanceHashOf([{ a: 1 }]));
    });

    it("canonicalJson 递归排序对象键", () => {
        expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    });
});

describe("trust / 授权收窄（ArchitectTask 不能扩权）", () => {
    it("只能取交集", () => {
        expect(intersectRoots(["frontend", "backend"], ["backend"])).toEqual(["backend"]);
    });

    it("任务越权请求的目录被丢弃", () => {
        expect(intersectRoots(["frontend"], ["frontend", "docs", "agents-CrewForge", "/"]))
            .toEqual(["frontend"]);
    });

    it("任务不声明任何目录 → 交集为空（等于写不了东西）", () => {
        expect(intersectRoots(["frontend", "backend"], [])).toEqual([]);
    });

    it("路径写法差异被规范化后再比", () => {
        expect(intersectRoots(["./frontend/"], ["frontend"])).toEqual(["frontend"]);
        expect(intersectRoots(["frontend"], ["frontend\\"])).toEqual(["frontend"]);
    });
});
