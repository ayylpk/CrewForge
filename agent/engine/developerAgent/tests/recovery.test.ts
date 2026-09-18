// tests/recovery.test.ts —— 三类崩溃恢复（规格四 / 五）
//   · 开发中途崩溃   → 恢复不重复执行已完成的写盘
//   · 等待测试期间重启 → 从 handleTestResult 恢复，不重跑开发与构建
//   · 修复中途崩溃   → 恢复不重复写盘
import { afterAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildDeveloperGraph } from "../graph";
import type { DeveloperLlm, MessagePort } from "../graph";
import { DeveloperLedger } from "../ledger";
import { Workspace } from "../workspace";
import { initialDeveloperState } from "../state";
import type { DeveloperState } from "../state";
import { acceptanceHashOf } from "../protocol";
import type { ArchitectTask, InboundMessage, TestFailure } from "../protocol";
import type { ToolRegistry } from "../tools/registry";

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-dev-recovery-"));
// 同 fake-loop：门禁跳过不存在目录，把两个根建出来让 runBuild 假实现可达
fs.mkdirSync(path.join(projectDir, "backend"), { recursive: true });
fs.mkdirSync(path.join(projectDir, "frontend"), { recursive: true });
const workspace = new Workspace({ projectDir, allowedRoots: ["backend", "frontend"] });
const opened: DeveloperLedger[] = [];
let seq = 0;

afterAll(() => {
    for (const l of opened) l.close();
    fs.rmSync(projectDir, { recursive: true, force: true });
});

function freshLedger(): DeveloperLedger {
    const l = DeveloperLedger.open(path.join(projectDir, `rec-${seq++}.db`), "p1:t1:default");
    opened.push(l);
    return l;
}

const RUN_ID = "run-1";
const CORRELATION = "corr-1";
const TEST_SENDER = "test-core";
const ACCEPTANCE = acceptanceHashOf([]);

const task: ArchitectTask = {
    type: "architect_task", projectId: "p1", taskId: "t1",
    requirementSnapshot: { goal: "恢复测试用最小任务" },
    stackProfile: { frontend: "vue3", backend: "spring-boot" },
    domainModel: { entity: "note" },
    contract: { version: "1", endpoints: [] },
    foundationPlan: { dirs: ["backend", "frontend"] },
    allowedRoots: ["backend", "frontend"], forbiddenPaths: [],
    acceptanceChecks: [], developerInstructions: "",
};

function startState(): DeveloperState {
    return initialDeveloperState({
        projectId: "p1", taskId: "t1", runId: RUN_ID, projectDir,
        allowedRoots: ["backend", "frontend"], correlationId: CORRELATION,
        messages: [task],
    });
}

const pass: InboundMessage = {
    type: "test_passed", messageId: "m1", correlationId: CORRELATION, runId: RUN_ID,
    projectId: "p1", taskId: "t1", acceptanceHash: ACCEPTANCE,
    evidence: [{
        checkId: "k", command: "npm", args: [], cwd: "", exitCode: 0,
        startedAt: 1, finishedAt: 2, inputHash: "i", stdoutHash: "o", stderrHash: "e",
    }],
    verifiedBy: TEST_SENDER,
};

const failMsg: InboundMessage = {
    type: "test_failure", messageId: "m2", correlationId: CORRELATION, runId: RUN_ID,
    acceptanceHash: ACCEPTANCE, projectId: "p1", taskId: "t1", category: "COMPILE",
    command: "npm", args: [], cwd: "", exitCode: 1, stdout: "", stderr: "",
    affectedFiles: [], failureSignature: "sig-1",
};

const WRITE = { kind: "tool", tool: "writeFile", args: { path: "backend/src/A.java", content: "class A{}" } };
const EDIT = { kind: "tool", tool: "editFile", args: { path: "backend/src/A.java", find: "A", replace: "B" } };
const DONE = { kind: "done" };

function scripted(decisions: unknown[]): DeveloperLlm {
    let i = 0;
    let calls = 0;
    return {
        id: "fake", calls: () => calls,
        next: async () => {
            calls++;
            const d = decisions[Math.min(i, decisions.length - 1)];
            i++;
            return d ?? DONE;
        },
    };
}

/** 在第 crashAt 次调用时抛错，模拟进程被杀 */
function crashingLlm(decisions: unknown[], crashAt: number): DeveloperLlm {
    let i = 0;
    let calls = 0;
    return {
        id: "crash", calls: () => calls,
        next: async () => {
            calls++;
            if (calls >= crashAt) throw new Error("模拟进程崩溃");
            const d = decisions[Math.min(i, decisions.length - 1)];
            i++;
            return d ?? DONE;
        },
    };
}

function toolsSpy(calls: string[]): ToolRegistry {
    return {
        describe: () => [],
        names: () => [],
        invoke: async (name: string, _c: unknown, args: Record<string, unknown>) => {
            calls.push(name);
            if (name === "inspectTree") return { ok: true, output: "共 1 个文件：\nbackend/src/A.java", meta: { total: 1 } };
            if (name === "runBuild") return { ok: true, output: "exit=0", meta: { exitCode: 0 } };
            if (name === "writeFile" || name === "editFile") {
                return { ok: true, output: `已写入 ${String(args["path"])}`, meta: { path: String(args["path"]), bytes: 5 } };
            }
            return { ok: true, output: "ok" };
        },
    } as unknown as ToolRegistry;
}

const noPort: MessagePort = {
    send: () => "wake",
    receive: async () => ({ status: "invalid", error: "无消息", sender: null }),
};

function build(ledger: DeveloperLedger, llm: DeveloperLlm, tools: ToolRegistry) {
    return buildDeveloperGraph({
        workspace, tools, ledger, port: noPort, llm,
        trustedTestAgents: [TEST_SENDER],
    });
}

const countOf = (calls: string[], name: string): number => calls.filter((c) => c === name).length;

describe("恢复 / 开发中途崩溃", () => {
    it("恢复时不重复执行已完成的写盘（靠 completed_tool_call 缓存）", async () => {
        const ledger = freshLedger();
        const calls: string[] = [];
        const tools = toolsSpy(calls);

        // 第一次：写完一个文件后崩
        const g1 = build(ledger, crashingLlm([WRITE, DONE], 2), tools);
        await g1.invoke(startState()).catch(() => { /* 预期崩溃 */ });
        expect(countOf(calls, "writeFile")).toBe(1);

        const cp = ledger.latestCheckpoint();
        expect(cp).not.toBeNull();

        // 恢复：同样的决策走一遍 —— 应命中缓存，不再真的执行
        const g2 = build(ledger, scripted([WRITE, DONE]), tools);
        const final = await g2.invoke({
            ...startState(),
            status: (cp?.status ?? "inspecting") as DeveloperState["status"],
            resumeFrom: cp?.resumeNode ?? null,
        }) as DeveloperState;

        expect(countOf(calls, "writeFile")).toBe(1);      // ★ 没有第二次
        expect(final.status).toBe("waiting_test");        // 跑完开发并发出测试请求
    });

    it("checkpoint 记录了恢复入口与上下文指纹", async () => {
        const ledger = freshLedger();
        const tools = toolsSpy([]);
        const g1 = build(ledger, crashingLlm([WRITE, DONE], 2), tools);
        await g1.invoke(startState()).catch(() => {});
        const cp = ledger.latestCheckpoint();
        expect(cp?.resumeNode).toBeTruthy();
        expect(cp?.status).toBeTruthy();
    });
});

describe("恢复 / 等待测试期间重启", () => {
    it("从 handleTestResult 恢复：不重跑开发与构建，直接 ready", async () => {
        const ledger = freshLedger();
        const calls: string[] = [];
        const tools = toolsSpy(calls);

        const g1 = build(ledger, scripted([WRITE, DONE]), tools);
        const s1 = await g1.invoke(startState()) as DeveloperState;
        expect(s1.status).toBe("waiting_test");
        const callsAfterDev = calls.length;
        expect(callsAfterDev).toBeGreaterThan(0);

        // 进程重启：新建 graph（模拟新进程），从 checkpoint 指定的入口恢复
        const g2 = build(ledger, scripted([DONE]), tools);
        const s2 = await g2.invoke({
            ...s1, status: "waiting_test", resumeFrom: "handleTestResult",
            messages: [...s1.messages, pass],
        }) as DeveloperState;

        expect(s2.status).toBe("ready");
        expect(calls.length).toBe(callsAfterDev);   // ★ 恢复期间零工具调用：没重跑构建
    });
});

describe("恢复 / 修复中途崩溃", () => {
    it("修复中断后恢复，不重复写盘", async () => {
        const ledger = freshLedger();
        const calls: string[] = [];
        const tools = toolsSpy(calls);

        // 阶段一：开发到 waiting_test
        const g1 = build(ledger, scripted([WRITE, DONE]), tools);
        const s1 = await g1.invoke(startState()) as DeveloperState;
        expect(s1.status).toBe("waiting_test");

        // 阶段二：塞失败进修复，修一次后崩
        const g2 = build(ledger, crashingLlm([EDIT, DONE], 2), tools);
        await g2.invoke({
            ...s1, resumeFrom: "handleTestResult", messages: [...s1.messages, failMsg],
            lastTestFailure: failMsg as TestFailure,
        }).catch(() => { /* 预期崩溃 */ });
        expect(countOf(calls, "editFile")).toBe(1);

        // 阶段三：恢复，同样决策再走一遍 —— 命中缓存
        const cp = ledger.latestCheckpoint();
        const g3 = build(ledger, scripted([EDIT, DONE]), tools);
        const s3 = await g3.invoke({
            ...startState(),
            status: (cp?.status ?? "testing") as DeveloperState["status"],
            repairAttempts: 1,
            lastTestFailure: failMsg as TestFailure,
            resumeFrom: cp?.resumeNode ?? null,
        }) as DeveloperState;

        expect(countOf(calls, "editFile")).toBe(1);   // ★ 仍未重复
        expect(s3.status).toBe("waiting_test");       // 确实跑到了下一次请求测试，不是静默失败
    });
});
