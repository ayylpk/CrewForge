// tests/fake-loop.test.ts —— Fake LLM 驱动的端到端：开发 → 测试 → 修复（零 LLM、零真实模型）
import { afterAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildDeveloperGraph } from "../graph";
import type { DeveloperLlm, MessagePort } from "../graph";
import { DeveloperLedger } from "../ledger";
import { Workspace } from "../workspace";
import { createDeveloperToolRegistry } from "../tools/registry";
import type { ToolArgs, ToolContext, ToolRegistry } from "../tools/registry";
import { initialDeveloperState } from "../state";
import type { DeveloperState } from "../state";
import { acceptanceHashOf } from "../protocol";
import type { ArchitectTask, InboundMessage, OutboundMessage, TestFailure } from "../protocol";
import { createDeveloperAgent } from "../index";

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-dev-loop-"));
// 9/13：本地自检门禁会跳过不存在的目录（allowedRoots+存在性双闸）——
// 这里把 backend/frontend 建出来，runBuild 假实现才会被调到。
fs.mkdirSync(path.join(projectDir, "backend"), { recursive: true });
fs.mkdirSync(path.join(projectDir, "frontend"), { recursive: true });
const workspace = new Workspace({ projectDir, allowedRoots: ["backend", "frontend"] });
const opened: DeveloperLedger[] = [];
let dbSeq = 0;

afterAll(() => {
    for (const l of opened) l.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
});

function freshLedger(): DeveloperLedger {
    const l = DeveloperLedger.open(path.join(projectDir, `loop-${dbSeq++}.db`), "p1:t1");
    opened.push(l);
    return l;
}

const task: ArchitectTask = {
    type: "architect_task", projectId: "p1", taskId: "t1",
    requirementSnapshot: { goal: "便签管理" },
    stackProfile: { frontend: "vue3", backend: "spring-boot" },
    domainModel: { entity: "note", table: "note", fields: [] },
    contract: { version: "1", endpoints: [] },
    foundationPlan: { dirs: ["backend", "frontend"] },
    allowedRoots: ["backend", "frontend"],
    forbiddenPaths: [],
    acceptanceChecks: [],
    developerInstructions: "按计划实现",
};

function scriptedLlm(decisions: unknown[]): { llm: DeveloperLlm; count: () => number } {
    let i = 0;
    let calls = 0;
    return {
        llm: {
            id: "fake-llm",
            calls: () => calls,
            async next() {
                calls++;
                const d = decisions[Math.min(i, decisions.length - 1)];
                i++;
                return d ?? { kind: "done" };
            },
        },
        count: () => calls,
    };
}

function fakeTools(buildOk = true): { tools: ToolRegistry; invoked: string[] } {
    const invoked: string[] = [];
    const tools = {
        describe: () => [],
        names: () => [],
        async invoke(name: string, _ctx: ToolContext, args: ToolArgs) {
            invoked.push(name);
            if (name === "inspectTree") return { ok: true, output: "共 1 个文件：\nbackend/src/A.java", meta: { total: 1 } };
            if (name === "runBuild") {
                return buildOk
                    ? { ok: true, output: "[build] exit=0", meta: { exitCode: 0 } }
                    : { ok: false, output: "[build] exit=1 编译错误", meta: { exitCode: 1 } };
            }
            if (name === "writeFile" || name === "editFile") {
                return { ok: true, output: `已写入 ${String(args["path"])}`, meta: { path: String(args["path"]), bytes: 10 } };
            }
            return { ok: true, output: "ok" };
        },
    } as unknown as ToolRegistry;
    return { tools, invoked };
}

/** 假端口：send 收集出站；receive 依次吐预置入站消息（必须带 sender——信任校验要看它） */
function fakePort(inbound: InboundMessage[], sender = "test-core"): { port: MessagePort; sent: OutboundMessage[] } {
    const sent: OutboundMessage[] = [];
    const queue = [...inbound];
    return {
        sent,
        port: {
            send: (_t, m) => { sent.push(m); return "wake"; },
            receive: async () => {
                const m = queue.shift();
                return m
                    ? { status: "message" as const, message: m, sender }
                    : { status: "invalid" as const, error: "队列已空", sender: null };
            },
        },
    };
}

/** 受信 TestAgent 的固定身份，与 runGraph 注入的 state 对齐 */
const TEST_SENDER = "test-core";
const CORRELATION = "corr-1";
const RUN_ID = "run-1";
/** task fixture 的 acceptanceChecks 是空数组，指纹由它算出 */
const ACCEPTANCE = acceptanceHashOf([]);

const failure = (sig: string): TestFailure => ({
    type: "test_failure",
    messageId: `msg-${sig}`, correlationId: CORRELATION, runId: RUN_ID, acceptanceHash: ACCEPTANCE,
    projectId: "p1", taskId: "t1", category: "COMPILE",
    command: "npm", args: ["run", "build"], cwd: "frontend", exitCode: 1,
    stdout: "vite build", stderr: "TS2304: Cannot find name 'foo'",
    affectedFiles: ["frontend/src/App.vue"], failureSignature: sig,
});

const passed: InboundMessage = {
    type: "test_passed",
    messageId: "msg-pass", correlationId: CORRELATION, runId: RUN_ID,
    projectId: "p1", taskId: "t1", acceptanceHash: ACCEPTANCE,
    evidence: [
        {
            checkId: "frontend-build", command: "npm", args: ["run", "build"], cwd: "frontend",
            exitCode: 0, startedAt: 1, finishedAt: 2, inputHash: "i1", stdoutHash: "o1", stderrHash: "e1",
        },
        {
            checkId: "backend-build", command: "mvnw", args: ["package"], cwd: "backend",
            exitCode: 0, startedAt: 3, finishedAt: 4, inputHash: "i2", stdoutHash: "o2", stderrHash: "e2",
        },
    ],
    verifiedBy: TEST_SENDER,
};

const WRITE_THEN_DONE = [
    { kind: "tool", tool: "writeFile", args: { path: "backend/src/A.java", content: "class A{}" } },
    { kind: "done" },
];
const FIX_THEN_DONE = [
    { kind: "tool", tool: "editFile", args: { path: "frontend/src/App.vue", find: "foo", replace: "bar" } },
    { kind: "done" },
];

async function runGraph(o: {
    decisions: unknown[];
    inbound: InboundMessage[];
    buildOk?: boolean;
    patch?: Partial<DeveloperState>;
    /** 覆盖入站消息的发送方（用于验证信任链） */
    sender?: string;
}) {
    const { llm, count } = scriptedLlm(o.decisions);
    const { tools } = fakeTools(o.buildOk ?? true);
    const { port, sent } = fakePort(o.inbound, o.sender ?? TEST_SENDER);
    const ledger = freshLedger();
    const graph = buildDeveloperGraph({
        workspace, tools, ledger, port, llm,
        trustedTestAgents: [TEST_SENDER],
    });
    const start = initialDeveloperState({
        projectId: "p1", taskId: "t1", runId: RUN_ID, projectDir,
        allowedRoots: ["backend", "frontend"],
        correlationId: CORRELATION,
        messages: [task],
        ...(o.patch ?? {}),
    });

    // ★ 规格三：图不再同步等待——一次 invoke 跑到 waiting_test 就正常结束。
    //   测试回复到达后由入口从 handleTestResult 恢复（这里模拟入口的分段驱动）。
    let state = await graph.invoke(start) as DeveloperState;
    const queue = [...o.inbound];
    let rounds = 0;
    while (state.status === "waiting_test" && queue.length > 0 && rounds < 10) {
        rounds++;
        const msg = queue.shift();
        if (!msg) break;
        state = await graph.invoke({
            ...state,
            messages: [...state.messages, msg],
            resumeFrom: "handleTestResult",
        }) as DeveloperState;
    }
    return { final: state, sent, llmCalls: count(), ledger };
}

describe("fake-loop / 正常路径", () => {
    it("architect_task → 写文件 → 本地检查 → test_passed → developer_ready", async () => {
        const { final, sent } = await runGraph({ decisions: WRITE_THEN_DONE, inbound: [passed] });
        expect(final.status).toBe("ready");
        const types = sent.map((s) => s.type);
        expect(types).toContain("developer_started");
        expect(types).toContain("test_request");
        expect(types).toContain("developer_ready");
        expect(final.changedFiles).toContain("backend/src/A.java");
    });

    it("恢复入口的信任闸：非等待态 / 无快照一律拒绝（只有独立 TestAgent 能推进 ready）", async () => {
        const ledgerPath = path.join(projectDir, `trust-${dbSeq++}.db`);
        const agent = createDeveloperAgent({
            projectId: "p1", taskId: "t1", projectDir,
            allowedRoots: ["backend", "frontend"],
            ledgerPath,
            llm: scriptedLlm(WRITE_THEN_DONE).llm,
            trustedTestAgents: [TEST_SENDER],
        });
        // ① 没有任何任务快照 → 拒绝
        expect(await agent.resumeFromTestMessage(passed, TEST_SENDER)).toBe("rejected");
        // ② 有快照但不在 waiting_test → 拒绝（避免拿测试消息乱推状态）
        agent.ledger.saveState({
            taskId: "t1", status: "implementing", repairAttempts: 0,
            failureSignatures: [], changedFiles: [], llmCalls: 0,
        });
        expect(await agent.resumeFromTestMessage(passed, "attacker")).toBe("rejected");
        expect(await agent.resumeFromTestMessage(passed, TEST_SENDER)).toBe("rejected");
        agent.close();
    });

    it("ready 会落 Ledger（节点事件与工具调用都有记录）", async () => {
        const { ledger } = await runGraph({ decisions: WRITE_THEN_DONE, inbound: [passed] });
        const nodes = ledger.listNodeEvents().map((e) => e.node);
        expect(nodes).toContain("receiveTask");
        expect(nodes).toContain("developerReady");
        expect(ledger.listToolCalls().length).toBeGreaterThan(0);
        // developerReady 是 exit 事件（任务级快照由 index.ts 落库，图本身只写事件）
        expect(ledger.listNodeEvents().some((e) => e.node === "developerReady" && e.phase === "exit")).toBe(true);
    });
});

describe("fake-loop / 修复回路", () => {
    it("test_failure → 修复 → 复测通过 → ready", async () => {
        const { final, sent } = await runGraph({
            decisions: [...WRITE_THEN_DONE, ...FIX_THEN_DONE],
            inbound: [failure("sig-1"), passed],
        });
        expect(final.status).toBe("ready");
        expect(final.repairAttempts).toBe(1);
        const types = sent.map((s) => s.type);
        expect(types).toContain("repair_started");
        expect(types).toContain("repair_finished");
        expect(final.failureSignatures).toContain("sig-1");
    });

    it("失败证据进了 Ledger", async () => {
        const { ledger } = await runGraph({
            decisions: [...WRITE_THEN_DONE, ...FIX_THEN_DONE],
            inbound: [failure("sig-1"), passed],
        });
        const failures = ledger.listFailures();
        expect(failures.length).toBe(1);
        expect(failures[0]?.signature).toBe("sig-1");
        expect(failures[0]?.category).toBe("COMPILE");
    });

    it("重复 failureSignature → 停止，不重复烧修复", async () => {
        const { final, sent, llmCalls } = await runGraph({
            decisions: [...WRITE_THEN_DONE, ...FIX_THEN_DONE, ...FIX_THEN_DONE],
            inbound: [failure("sig-1"), failure("sig-1")],
        });
        expect(final.status).toBe("blocked");
        expect(final.repairAttempts).toBe(1);          // 只修了一次
        expect(llmCalls).toBeLessThanOrEqual(6);       // 第二次失败没有驱动新的修复循环
        expect(sent.map((s) => s.type)).toContain("developer_blocked");
    });

    it("超过最大修复次数 → blocked", async () => {
        const { final } = await runGraph({
            decisions: [...WRITE_THEN_DONE, ...FIX_THEN_DONE, ...FIX_THEN_DONE],
            inbound: [failure("s1"), failure("s2"), failure("s3")],
        });
        expect(final.status).toBe("blocked");
        expect(final.repairAttempts).toBe(2);          // maxRepairAttempts 默认 2
    });
});

describe("fake-loop / 本地检查与异常输入", () => {
    it("本地构建失败且没有修复额度 → blocked", async () => {
        const { final } = await runGraph({
            decisions: WRITE_THEN_DONE,
            inbound: [passed],
            buildOk: false,
            patch: { maxRepairAttempts: 0 },
        });
        expect(final.status).toBe("blocked");
    });

    it("没有测试回复时不阻塞、不空转——停在 waiting_test 等入口恢复（规格三）", async () => {
        const { final } = await runGraph({ decisions: WRITE_THEN_DONE, inbound: [] });
        expect(final.status).toBe("waiting_test");
    });
});

describe("fake-loop / 崩溃恢复（index 入口）", () => {
    it("终态任务不会重跑（Ledger 里已是 ready → 直接短路返回）", async () => {
        const ledgerPath = path.join(projectDir, `resume-${dbSeq++}.db`);
        // 先跑一遍到 ready
        const first = createDeveloperAgent({
            projectId: "p1", taskId: "t1", projectDir, allowedRoots: ["backend", "frontend"],
            ledgerPath,
            llm: scriptedLlm(WRITE_THEN_DONE).llm,
        });
        // 预置一条 test_passed，模拟外部测试结果已到达
        first.adapter.send("architect", { type: "developer_started", projectId: "p1", taskId: "t1", at: Date.now() });
        const initial = initialDeveloperState({
            projectId: "p1", taskId: "t1", projectDir, allowedRoots: ["backend", "frontend"], messages: [task],
        });
        expect(initial.status).toBe("received");

        // 直接把 Ledger 标成终态（模拟"上次进程跑完 ready 后崩溃/重启"）
        first.ledger.saveState({
            taskId: "t1", status: "ready", repairAttempts: 1,
            failureSignatures: ["sig-1"], changedFiles: ["backend/src/A.java"], llmCalls: 3,
        });
        first.close();

        // 重新建一个 agent（= 进程重启），run 应当短路，不再调 LLM
        const llm2 = scriptedLlm(WRITE_THEN_DONE);
        const second = createDeveloperAgent({
            projectId: "p1", taskId: "t1", projectDir, allowedRoots: ["backend", "frontend"],
            ledgerPath, llm: llm2.llm,
        });
        const state = await second.run({ task });
        expect(state.status).toBe("ready");
        expect(llm2.count()).toBe(0);                  // 没有重复执行已完成阶段
        expect(second.ledger.listEvents().some((e) => e.type === "skip_completed_task")).toBe(true);
        second.close();
    });
});
