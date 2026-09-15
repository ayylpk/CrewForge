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

// ============================================================
// 分批拆解（9/15 拍板"拆出一个推送一个"）：architect_batch 入站消息
//   · 蓝图仍是 architect_task（全局字段一次冻结，contract 全量在蓝图里）；
//   · 每个工作项的详规与判据走 architect_batch，逐项推送；
//   · 注意：**没有** architect_close 这类"流关闭"消息——批次到齐的判定是
//     代码侧 arrivedItems ⊇ workItems ids（协议层不留可被模型伪造的收尾键）。
// ============================================================

describe("protocol / architect_batch 批次消息", () => {
    const validBatch = {
        type: "architect_batch",
        projectId: "p1",
        taskId: "t1",
        itemId: "w2",
        detail: "实现任务 CRUD：路由→服务→仓储三层，错误统一 {code,msg} 外壳",
        checks: [
            { id: "ac-11", kind: "CONTRACT", method: "POST", path: "/api/tasks", expectedStatus: 201, body: { title: "t" } },
        ],
    };

    it("合法批次能解析，字段原样保留", () => {
        const r = parseInbound(JSON.stringify(validBatch));
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.message.type).toBe("architect_batch");
            const b = r.message as { itemId: string; detail: string; checks: unknown[] };
            expect(b.itemId).toBe("w2");
            expect(b.checks.length).toBe(1);
        }
    });

    it("缺 itemId / detail 空串 → 拒绝（批次必须指到项、必须带详规）", () => {
        expect(parseInbound({ ...validBatch, itemId: undefined }).ok).toBe(false);
        expect(parseInbound({ ...validBatch, detail: "" }).ok).toBe(false);
    });

    it("checks 里的判据缺 id → 拒绝（AcceptanceCheck 的 id 是唯一锚点，撞车去重靠它）", () => {
        const r = parseInbound({ ...validBatch, checks: [{ kind: "CONTRACT" }] });
        expect(r.ok).toBe(false);
    });

    it("checks 允许为空数组（inspect/foundation/pre-test 这类无外显产物项，业务闸门在 architectAgent 侧按 kind 拦）", () => {
        expect(parseInbound({ ...validBatch, itemId: "w1", checks: [] }).ok).toBe(true);
    });

    it("detail 里可以出现 done/status 等字样（权威字段闸扫的是 JSON 键，不是值里的英文单词）", () => {
        const r = parseInbound({ ...validBatch, detail: "CRUD 完成后前端列表应显示 done=false 的新任务" });
        expect(r.ok).toBe(true);
    });

    it("workItems 里的 detail 字段能通过 architect_task（strict z.object 会剥离未知键，必须先入 schema）", () => {
        const t = {
            ...architectTask,
            foundationPlan: { dirs: ["backend"], workItems: [{ id: "w1", kind: "foundation", detail: "搭骨架：目录+工程文件+入口" }] },
        };
        const r = parseInbound(t);
        expect(r.ok).toBe(true);
        if (r.ok) {
            const items = (r.message as { foundationPlan: { workItems: { detail?: string }[] } }).foundationPlan.workItems;
            expect(items[0]?.detail).toBe("搭骨架：目录+工程文件+入口");
        }
    });
});
