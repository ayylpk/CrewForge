// tests/protocol.test.ts —— 消息类型与运行时校验
import { describe, expect, it } from "bun:test";
import { assertNoAuthorityFields, findAuthorityFields, parseInbound } from "../protocol";

const architectTask = {
    type: "architect_task",
    projectId: "p1",
    taskId: "t1",
    requirementSnapshot: { goal: "便签管理" },
    stackProfile: { frontend: "vue3", backend: "spring-boot" },
    domainModel: { entity: "note" },
    contract: { version: "1", endpoints: [] },
    foundationPlan: { dirs: ["backend", "frontend"] },
    allowedRoots: ["frontend", "backend"],
    forbiddenPaths: [],
    acceptanceChecks: [],
    developerInstructions: "按计划实现",
};

describe("protocol / 入站校验", () => {
    it("test_failure 可携带同一轮全部失败证据，兼容旧消息", () => {
        const parsed = parseInbound(JSON.stringify({
            type: "test_failure", messageId: "m-all", correlationId: "c1", runId: "r1",
            acceptanceHash: "a1", projectId: "p", taskId: "t", category: "CONTRACT",
            command: "node", args: ["probe"], cwd: ".", exitCode: 1, stdout: "", stderr: "bad",
            affectedFiles: [], failureSignature: "sig-main",
            allFailures: [{ checkId: "http:GET:/login", category: "CONTRACT", command: "node", args: ["probe"], cwd: ".", exitCode: 1, stdout: "", stderr: "bad", failureSignature: "sig-main" }],
        }));
        expect(parsed.ok).toBe(true);
    });
    it("旧消息只有 failure、没有 allFailures → 仍然兼容（字段可选，不强制旧发送方升级）", () => {
        const parsed = parseInbound({
            type: "test_failure", messageId: "m-legacy", correlationId: "c1", runId: "r1",
            acceptanceHash: "a1", projectId: "p", taskId: "t", category: "COMPILE",
            command: "npm", args: ["run", "build"], cwd: "frontend", exitCode: 1,
            stdout: "", stderr: "TS2304", affectedFiles: [], failureSignature: "sig-legacy",
        });
        expect(parsed.ok).toBe(true);
        if (parsed.ok && parsed.message.type === "test_failure") {
            expect(parsed.message.failureSignature).toBe("sig-legacy");
            expect(parsed.message.allFailures).toBeUndefined();
        }
    });
    it("合法 architect_task 能解析", () => {
        const r = parseInbound(architectTask);
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.message.type).toBe("architect_task");
    });

    it("JSON 字符串形式也能解析（Hub 里传的就是字符串）", () => {
        const r = parseInbound(JSON.stringify(architectTask));
        expect(r.ok).toBe(true);
    });

    it("缺必填字段被拒绝", () => {
        const bad: Record<string, unknown> = { ...architectTask };
        delete bad["allowedRoots"];
        const r = parseInbound(bad);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain("allowedRoots");
    });

    it("未知消息类型被拒绝", () => {
        const r = parseInbound({ type: "unknown_type" });
        expect(r.ok).toBe(false);
    });

    it("非 JSON 字符串被拒绝", () => {
        expect(parseInbound("hello").ok).toBe(false);
    });

    it("test_failure 原样保留 stderr / failureSignature（不许只给摘要）", () => {
        const r = parseInbound({
            type: "test_failure",
            messageId: "m1", correlationId: "c1", runId: "r1", acceptanceHash: "a1",
            projectId: "p", taskId: "t", category: "COMPILE",
            command: "npm", args: ["run", "build"], cwd: "frontend", exitCode: 1,
            stdout: "out", stderr: "ERR TS2304: Cannot find name 'foo'",
            affectedFiles: ["frontend/src/App.vue"], failureSignature: "sig-1",
        });
        expect(r.ok).toBe(true);
        if (r.ok && r.message.type === "test_failure") {
            expect(r.message.stderr).toBe("ERR TS2304: Cannot find name 'foo'");
            expect(r.message.failureSignature).toBe("sig-1");
            expect(r.message.exitCode).toBe(1);
            expect(r.message.correlationId).toBe("c1");
        }
    });

    it("test_failure 缺身份字段被拒绝（光有内容不够）", () => {
        const r = parseInbound({
            type: "test_failure", projectId: "p", taskId: "t", category: "COMPILE",
            command: "npm", args: [], cwd: ".", exitCode: 1, stdout: "", stderr: "",
            affectedFiles: [], failureSignature: "s",
        });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain("correlationId");
    });

    it("category 不在六类里被拒绝", () => {
        const r = parseInbound({
            type: "test_failure",
            messageId: "m1", correlationId: "c1", runId: "r1", acceptanceHash: "a1",
            projectId: "p", taskId: "t", category: "WHATEVER",
            command: "x", args: [], cwd: ".", exitCode: 1, stdout: "", stderr: "",
            affectedFiles: [], failureSignature: "s",
        });
        expect(r.ok).toBe(false);
    });

    it("test_passed 的证据必须是结构化机器证据（糊弄的字符串不认）", () => {
        const base = {
            type: "test_passed", messageId: "m1", correlationId: "c1", runId: "r1",
            projectId: "p", taskId: "t", verifiedBy: "test-core", acceptanceHash: "a1",
        };
        const ev = (exitCode: number) => ({
            checkId: "k1", command: "npm", args: ["test"], cwd: "frontend",
            exitCode, startedAt: 1, finishedAt: 2,
            inputHash: "i", stdoutHash: "o", stderrHash: "e",
        });
        // 空证据 / 结构不对 → 直接拒绝
        expect(parseInbound({ ...base, evidence: [] }).ok).toBe(false);
        expect(parseInbound({ ...base, evidence: [{ cmd: "npm test", exitCode: 0 }] }).ok).toBe(false);
        expect(parseInbound({ ...base, evidence: ["ok"] }).ok).toBe(false);
        // 结构合法即通过 schema；exitCode !== 0 由**信任校验**拒绝（不是形状问题）
        expect(parseInbound({ ...base, evidence: [ev(0)] }).ok).toBe(true);
        expect(parseInbound({ ...base, evidence: [ev(1)] }).ok).toBe(true);
    });

    it("cancel_task / resume_task 能识别", () => {
        expect(parseInbound({ type: "cancel_task", projectId: "p" }).ok).toBe(true);
        expect(parseInbound({ type: "resume_task", projectId: "p", taskId: "t" }).ok).toBe(true);
    });
});

describe("protocol / 权威字段禁令", () => {
    it("能扫出嵌套的权威字段", () => {
        const hits = findAuthorityFields({ a: { verified: true }, b: [{ done: false }] });
        expect(hits.length).toBe(2);
    });

    it("出现权威字段即抛错", () => {
        expect(() => assertNoAuthorityFields("t", { status: "ready" })).toThrow();
        expect(() => assertNoAuthorityFields("t", { hello: "world" })).not.toThrow();
    });
});
