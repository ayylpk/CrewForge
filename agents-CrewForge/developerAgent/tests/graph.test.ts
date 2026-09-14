// tests/graph.test.ts —— 图结构固定、路由纯函数、默认路径不碰旧控制平面（零 LLM）
import { afterAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildDeveloperGraph, coerceDecision, routeAfterImplement, routeAfterLocalChecks, routeAfterTestResult } from "../graph";
import type { MessagePort } from "../graph";
import { DeveloperLedger } from "../ledger";
import { Workspace } from "../workspace";
import { createDeveloperToolRegistry } from "../tools/registry";
import { initialDeveloperState } from "../state";
import type { DeveloperState } from "../state";
import type { TestFailure } from "../protocol";

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-dev-graph-"));
const ledger = DeveloperLedger.open(path.join(projectDir, "ledger.db"), "p:t");
const workspace = new Workspace({ projectDir, allowedRoots: ["frontend", "backend"] });

afterAll(() => { ledger.close(); fs.rmSync(projectDir, { recursive: true, force: true }); });

const stubPort: MessagePort = {
    send: () => "wake",
    receive: async () => ({ status: "invalid", error: "stub", sender: null }),
};

const stubLlm = {
    id: "stub",
    calls: () => 0,
    next: async () => ({ kind: "done" }),
};

function compileGraph() {
    return buildDeveloperGraph({
        workspace, tools: createDeveloperToolRegistry(), ledger, port: stubPort, llm: stubLlm,
        configuredAllowedRoots: ["frontend", "backend"],
    });
}

const failure = (sig: string): TestFailure => ({
    type: "test_failure",
    messageId: `msg-${sig}`, correlationId: "corr-1", runId: "run-1", acceptanceHash: "acc-1",
    projectId: "p", taskId: "t", category: "COMPILE",
    command: "npm", args: [], cwd: "frontend", exitCode: 1,
    stdout: "", stderr: "", affectedFiles: [], failureSignature: sig,
});

describe("graph / 结构写死", () => {
    it("节点集合固定为规格定义的 10 个", () => {
        const compiled = compileGraph() as unknown as {
            nodes?: Record<string, unknown>;
            getGraph?: () => { nodes: Record<string, unknown> };
        };
        const raw = compiled.nodes ?? compiled.getGraph?.().nodes ?? {};
        const names = Object.keys(raw).sort();
        // __start__ 是 LangGraph 自带的入口节点，不参与业务
        expect(names).toEqual([
            "__start__",
            "bootstrapOrImplement", "developerBlocked", "developerReady", "handleTestResult",
            "inspectProject", "loadContext", "receiveTask", "repair", "requestTest", "runLocalChecks",
        ]);
    });

    it("源码里所有 addNode / addConditionalEdges 都是字面量（外部数据无法增删节点）", () => {
        const src = fs.readFileSync(path.join(import.meta.dir, "..", "graph.ts"), "utf-8");
        expect(/addNode\(\s*"/.test(src)).toBe(true);
        // addNode( 后面必须是引号（字面量），出现标识符就说明可能来自外部
        expect(/addNode\(\s*[^"\s]/.test(src)).toBe(false);
        expect(/addConditionalEdges\([\s\S]*?\[\s*"/.test(src)).toBe(true);
        // 禁止任何动态注册入口
        expect(/registerNode|addNodes\(|fromConfig|fromDatabase/.test(src)).toBe(false);
    });
});

describe("graph / 路由", () => {
    it("还有工作项没做完 → 继续推进工作项（不是去修整站 build 的红）", () => {
        const s = initialDeveloperState({
            status: "implementing",
            workItems: [{ id: "w1", kind: "foundation" }, { id: "w2", kind: "frontend" }],
            completedWorkItems: ["w1"],              // w2 还没做
        });
        expect(routeAfterImplement(s)).toBe("continueWorkItems");
        // 工作项都做完了 → 才跑整站预检
        expect(routeAfterImplement(initialDeveloperState({
            status: "implementing",
            workItems: [{ id: "w1", kind: "foundation" }],
            completedWorkItems: ["w1"],
        }))).toBe("runLocalChecks");
    });

    it("没有工作项（旧任务包）→ 直接进预检，行为与改动前一致", () => {
        const s = initialDeveloperState({ status: "implementing", workItems: [] });
        expect(routeAfterImplement(s)).toBe("runLocalChecks");
    });

    it("预算/超时是硬闸：预占不到额度就不开工，交给预检后收口成 blocked", () => {
        const base = {
            workItems: [
                { id: "w1", kind: "foundation" as const },
                { id: "w2", kind: "frontend" as const },
            ],
            completedWorkItems: ["w1"],
        };
        // 预算用满 → 不推进（否则会预占不到额度空转）
        expect(routeAfterImplement(initialDeveloperState({
            ...base, status: "implementing", llmCallsCompleted: 40, llmCallsPlanned: 40,
        }), 40)).toBe("runLocalChecks");
        // 预占已到上限 → 同样不推进
        expect(routeAfterImplement(initialDeveloperState({
            ...base, status: "implementing", llmCallsPlanned: 40,
        }), 40)).toBe("runLocalChecks");
        // 超时重复 → 停手
        expect(routeAfterImplement(initialDeveloperState({
            ...base, status: "implementing", timeoutRepeated: true,
        }))).toBe("runLocalChecks");
    });

    it("恢复路径兜底：runLocalChecks 带着未完成工作项时，回 loadContext 推进（不是 repair）", () => {
        const s = initialDeveloperState({
            status: "implementing", error: "frontend build 失败",
            workItems: [{ id: "w1", kind: "foundation" }, { id: "w2", kind: "frontend" }],
            completedWorkItems: ["w1"],
        });
        expect(routeAfterLocalChecks(s)).toBe("continueWorkItems");
    });

    it("本地检查通过 → requestTest", () => {
        const s = initialDeveloperState({ status: "implementing", error: null });
        expect(routeAfterLocalChecks(s)).toBe("requestTest");
    });

    it("本地检查失败且还有额度 → repair", () => {
        const s = initialDeveloperState({ status: "implementing", error: "frontend build 失败", repairAttempts: 0, maxRepairAttempts: 2 });
        expect(routeAfterLocalChecks(s)).toBe("repair");
    });

    it("本地检查失败且额度耗尽 → developerBlocked", () => {
        const s = initialDeveloperState({ status: "implementing", error: "frontend build 失败", repairAttempts: 2, maxRepairAttempts: 2 });
        expect(routeAfterLocalChecks(s)).toBe("developerBlocked");
    });

    it("预算超限 → developerBlocked", () => {
        const s = initialDeveloperState({ status: "implementing", error: null, llmCallsCompleted: 99 });
        expect(routeAfterLocalChecks(s, 40)).toBe("developerBlocked");
    });

    it("test_passed → developerReady", () => {
        const s = initialDeveloperState({ status: "testing", messages: [{ type: "test_passed" }] });
        expect(routeAfterTestResult(s)).toBe("developerReady");
    });

    it("test_failure（首次）→ repair", () => {
        const s = initialDeveloperState({
            status: "testing", messages: [{ type: "test_failure" }],
            lastTestFailure: failure("s1"), failureSignatures: [],
        });
        expect(routeAfterTestResult(s)).toBe("repair");
    });

    it("同一 failureSignature 再来 → developerBlocked（不许原样重试）", () => {
        const s = initialDeveloperState({
            status: "testing", messages: [{ type: "test_failure" }],
            lastTestFailure: failure("s1"), failureSignatures: ["s1"],
        });
        expect(routeAfterTestResult(s)).toBe("developerBlocked");
    });

    it("修复次数耗尽 → developerBlocked", () => {
        const s = initialDeveloperState({
            status: "testing", messages: [{ type: "test_failure" }],
            lastTestFailure: failure("s2"), failureSignatures: ["s1"],
            repairAttempts: 2, maxRepairAttempts: 2,
        });
        expect(routeAfterTestResult(s)).toBe("developerBlocked");
    });

    it("没有测试结果就想 ready → developerBlocked", () => {
        const s = initialDeveloperState({ status: "testing", messages: [] });
        expect(routeAfterTestResult(s)).toBe("developerBlocked");
    });
});

describe("graph / 决策解析", () => {
    it("接受对象与 JSON 字符串两种形态", () => {
        expect(coerceDecision({ kind: "tool", tool: "readFile", args: { path: "a" } })?.call?.tool).toBe("readFile");
        expect(coerceDecision('{"kind":"done"}')?.kind).toBe("done");
    });

    it("形状不对返回 null", () => {
        expect(coerceDecision({ kind: "tool" })).toBe(null);
        expect(coerceDecision("not json")).toBe(null);
        expect(coerceDecision(42)).toBe(null);
    });
});

describe("graph / 默认路径不依赖旧控制平面", () => {
    const dir = path.join(import.meta.dir, "..");

    function allTs(root: string): string[] {
        const out: string[] = [];
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
            if (entry.name === "node_modules") continue;
            const p = path.join(root, entry.name);
            if (entry.isDirectory()) out.push(...allTs(p));
            else if (entry.name.endsWith(".ts")) out.push(p);
        }
        return out;
    }

    it("没有任何文件 import GraphFactory / merger / maintainer / 旧 Engineer", () => {
        for (const file of allTs(dir)) {
            const src = fs.readFileSync(file, "utf-8");
            const bad = /^\s*import[^;]*from\s+["'][^"']*(GraphFactory|merger|maintainer|backendEngineer|frontendEngineer)["']/m;
            expect(bad.test(src)).toBe(false);
        }
    });

    it("没有引入任何 MCP 适配器", () => {
        for (const file of allTs(dir)) {
            const src = fs.readFileSync(file, "utf-8");
            expect(/from\s+["'][^"']*mcp[^"']*["']/i.test(src)).toBe(false);
        }
    });

    it("也没有引入 engine2 流水线（本模块自包含）", () => {
        for (const file of allTs(dir)) {
            const src = fs.readFileSync(file, "utf-8");
            expect(/from\s+["'][^"']*engine2/.test(src)).toBe(false);
        }
    });
});
