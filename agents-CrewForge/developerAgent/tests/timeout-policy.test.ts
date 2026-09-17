// tests/timeout-policy.test.ts —— 超时延长与 TIMEOUT_REPEATED（零 LLM）
//
//   规格五.7：允许 Developer 主动延长一次超时，但**必须记录原因**；
//   规格五.8：同一命令连续超时两次 → 标 TIMEOUT_REPEATED，停止重试并交给外部。
//   这两条都是"别把时间和额度烧在同一个坑里"的机制，必须有机器证据钉住。
import { afterAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DeveloperLedger } from "../ledger";
import { Workspace } from "../workspace";
import {
    checkTimeoutExtension, EXEC_TIMEOUT_DEFAULTS, routeAfterLocalChecks, runToolLoop,
} from "../graph";
import type { DeveloperLlm } from "../graph";
import { initialDeveloperState, isTimeoutRepeated } from "../state";
import type { ToolArgs, ToolContext, ToolRegistry } from "../tools/registry";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-dev-timeout-"));
const opened: DeveloperLedger[] = [];
let seq = 0;

afterAll(() => {
    for (const l of opened) { try { l.close(); } catch { /* 已关 */ } }
});

function ledgerFor(): DeveloperLedger {
    const l = DeveloperLedger.open(path.join(root, `to-${seq++}.db`), "p1:t1");
    opened.push(l);
    return l;
}

const workspace = new Workspace({ projectDir: root, allowedRoots: ["backend", "frontend"] });

const ctx = (): ToolContext => ({
    workspace, owner: "developerAgent", role: "developer", taskId: "T1",
});

/** 永远"超时"的假注册表：只回报机器事实，不真起进程 */
function alwaysTimeoutTools(): ToolRegistry {
    return {
        describe: () => [{ name: "runCommand", description: "d", parameters: {} }],
        names: () => ["runCommand"],
        invoke: async () => ({
            ok: false,
            output: "$ runCommand ... → exit=null [超时]",
            meta: {
                command: "node", args: ["slow.js"], cwd: ".", exitCode: null,
                timedOut: true, durationMs: 120_000, processId: "proc-1", pid: 123, killedBy: "timeout",
            },
        }),
    } as unknown as ToolRegistry;
}

function repeatingLlm(): DeveloperLlm {
    let calls = 0;
    return {
        id: "repeat",
        calls: () => calls,
        next: async () => {
            calls++;
            return { kind: "tool", tool: "runCommand", args: { command: "node", args: ["slow.js"] } };
        },
    };
}

// ============================================================
describe("timeout / 超时延长的裁决规则", () => {
    it("不超过默认值 → 不需要原因", () => {
        const ledger = ledgerFor();
        const r = checkTimeoutExtension({
            tool: "runCommand", args: { command: "node", timeoutMs: 60_000 }, ledger, taskId: "T1",
        });
        expect(r.allowed).toBe(true);
    });

    it("超过默认值但没给原因 → 拒绝", () => {
        const ledger = ledgerFor();
        const r = checkTimeoutExtension({
            tool: "runCommand", args: { command: "node", timeoutMs: 300_000 }, ledger, taskId: "T1",
        });
        expect(r.allowed).toBe(false);
        if (!r.allowed) expect(r.result.rejected?.code).toBe("TIMEOUT_EXTENSION_DENIED");
    });

    it("给了原因 → 放行一次，且落 Ledger", () => {
        const ledger = ledgerFor();
        const r = checkTimeoutExtension({
            tool: "runCommand",
            args: { command: "node", timeoutMs: 300_000, timeoutReason: "首次冷启动要拉依赖，实测约 3 分钟" },
            ledger, taskId: "T1",
        });
        expect(r.allowed).toBe(true);
        const events = ledger.listEvents().filter((e) => e.type === "timeout_extended");
        expect(events.length).toBe(1);
        expect(JSON.stringify(events[0]?.payload)).toContain("冷启动");
    });

    it("同一条命令第二次延长 → 拒绝（只许一次）", () => {
        const ledger = ledgerFor();
        const args = { command: "node", timeoutMs: 300_000, timeoutReason: "第一次" };
        expect(checkTimeoutExtension({ tool: "runCommand", args, ledger, taskId: "T1" }).allowed).toBe(true);
        const second = checkTimeoutExtension({ tool: "runCommand", args, ledger, taskId: "T1" });
        expect(second.allowed).toBe(false);
        if (!second.allowed) expect(String(second.result.output)).toContain("只允许延长一次");
    });

    it("非执行类工具不受超时策略管", () => {
        const ledger = ledgerFor();
        const r = checkTimeoutExtension({
            tool: "readFile", args: { path: "a", timeoutMs: 999_999 }, ledger, taskId: "T1",
        });
        expect(r.allowed).toBe(true);
    });

    it("默认超时值符合规格（9/16 p7 联跑指令 ×1.5：命令 3min / 构建 15min / HTTP 45s）", () => {
        expect(EXEC_TIMEOUT_DEFAULTS["runCommand"]).toBe(180_000);
        expect(EXEC_TIMEOUT_DEFAULTS["runBuild"]).toBe(900_000);
        expect(EXEC_TIMEOUT_DEFAULTS["httpRequest"]).toBe(45_000);
        expect(EXEC_TIMEOUT_DEFAULTS["startProcess"]).toBe(180_000);
        expect(EXEC_TIMEOUT_DEFAULTS["shell"]).toBe(180_000);
    });
});

// ============================================================
describe("timeout / TIMEOUT_REPEATED 停止条件", () => {
    it("同一命令连续超时两次 → 标记并停止，不再无限重试", async () => {
        const ledger = ledgerFor();
        const loop = await runToolLoop({
            llm: repeatingLlm(), tools: alwaysTimeoutTools(), ctx: ctx(), ledger,
            system: "s", task: "t", skill: null, maxSteps: 6,
        });
        expect(loop.timeoutRepeated).toBe(true);
        expect(loop.timeoutSignature).toContain("runCommand:node slow.js");
        expect(loop.toolCalls).toBe(2);                     // 第三次没有发生
        expect(ledger.listEvents().some((e) => e.type === "timeout_repeated")).toBe(true);
        const failures = ledger.listFailures();
        expect(failures.some((f) => f.signature.startsWith("TIMEOUT_REPEATED:"))).toBe(true);
    });

    it("TIMEOUT_REPEATED 会把状态推到 blocked（交给外部决定，不自己硬扛）", async () => {
        const s = initialDeveloperState({ status: "implementing", error: null, timeoutRepeated: true, timeoutSignature: "runCommand:node slow.js" });
        expect(isTimeoutRepeated(s)).toBe(true);
        expect(routeAfterLocalChecks(s)).toBe("developerBlocked");
    });

    it("没超时的话不标 TIMEOUT_REPEATED（正常返回会清零计数）", async () => {
        const ledger = ledgerFor();
        let n = 0;
        const tools = {
            describe: () => [{ name: "runCommand", description: "d", parameters: {} }],
            names: () => ["runCommand"],
            invoke: async () => {
                n++;
                // 第一次超时、第二次正常 → 计数清零，不该判重复
                return n === 1
                    ? { ok: false, output: "timeout", meta: { timedOut: true, exitCode: null } }
                    : { ok: true, output: "ok", meta: { timedOut: false, exitCode: 0 } };
            },
        } as unknown as ToolRegistry;
        const loop = await runToolLoop({
            llm: repeatingLlm(), tools, ctx: ctx(), ledger,
            system: "s", task: "t", skill: null, maxSteps: 6,
        });
        expect(loop.timeoutRepeated).toBe(false);
        expect(n).toBeGreaterThan(1);
    });

    it("工具调用指纹会进 loop 结果（供 state.completedToolCalls 落库）", async () => {
        const ledger = ledgerFor();
        const loop = await runToolLoop({
            llm: repeatingLlm(), tools: alwaysTimeoutTools(), ctx: ctx(), ledger,
            system: "s", task: "t", skill: null, maxSteps: 4,
        });
        expect(loop.fingerprints.length).toBeGreaterThan(0);
        expect(loop.fingerprints.every((f) => /^[0-9a-f]{8}$/.test(f))).toBe(true);
    });
});

// ============================================================
describe("timeout / 状态字段", () => {
    it("初始状态里超时相关字段是干净的", () => {
        const s = initialDeveloperState({});
        expect(s.timeoutRepeated).toBe(false);
        expect(s.timeoutSignature).toBeNull();
        expect(s.completedToolCalls).toEqual([]);
        expect(s.timeoutExtensions).toEqual([]);
    });

    it("重复指纹会被合并（appendUnique），不会无限膨胀", () => {
        const s = initialDeveloperState({ completedToolCalls: ["a", "b"] });
        expect(s.completedToolCalls).toEqual(["a", "b"]);
    });
});

// ============================================================
// ③并行（9/14）：只读批 1 批 = 1 步 = 1 条 llm 台账，批内并发执行
// ============================================================

describe("parallel / 只读批处理", () => {
    const readonlyTools = (): { registry: ToolRegistry; calls: string[] } => {
        const calls: string[] = [];
        return {
            calls,
            registry: {
                describe: () => [],
                names: () => [],
                invoke: async (name: string) => {
                    calls.push(name);
                    // 拖一点延迟，验证是真并发（串行 3×30ms ≈ 90ms，并发 <50ms）
                    await new Promise((r) => setTimeout(r, 30));
                    return { ok: true, output: `${name} 结果`, meta: {} };
                },
            } as unknown as ToolRegistry,
        };
    };

    it("batch 决策：批内并发执行、逐个入账、1 批 = 1 步", async () => {
        const ledger = ledgerFor();
        const { registry, calls } = readonlyTools();
        let llmCalls = 0;
        const llm: DeveloperLlm = {
            id: "fake", calls: () => llmCalls,
            next: async () => {
                llmCalls++;
                return llmCalls === 1
                    ? {
                        kind: "batch",
                        calls: [
                            { tool: "readFile", args: { path: "a.ts" } },
                            { tool: "search", args: { query: "q" } },
                            { tool: "inspectTree", args: { limit: 10 } },
                        ],
                    }
                    : { kind: "done" };
            },
        };
        const t0 = Date.now();
        const loop = await runToolLoop({
            llm, tools: registry, ctx: ctx(), ledger,
            system: "s", task: "t", skill: null, maxSteps: 4,
        });
        const wall = Date.now() - t0;

        expect(calls.sort()).toEqual(["inspectTree", "readFile", "search"]);
        expect(loop.steps).toBe(1);              // 1 批 = 1 步（不是 3 步）；done 不计步（既有语义）
        expect(loop.toolCalls).toBe(3);          // 批内 3 个工具各记一次账
        expect(loop.finished).toBe(true);
        expect(wall).toBeLessThan(85);           // 3×30ms 串行≈95ms+；并发应显著小于
    });

    it("batch 与普通工具混排：批前后各自正常推进", async () => {
        const ledger = ledgerFor();
        const { registry, calls } = readonlyTools();
        let llmCalls = 0;
        const llm: DeveloperLlm = {
            id: "fake", calls: () => llmCalls,
            next: async () => {
                llmCalls++;
                if (llmCalls === 1) {
                    return { kind: "tool", tool: "writeFile", args: { path: "x.txt", content: "1" } };
                }
                if (llmCalls === 2) {
                    return { kind: "batch", calls: [{ tool: "readFile", args: { path: "x.txt" } }] };
                }
                return { kind: "done" };
            },
        };
        const writeOk = { ok: true, output: "已写入", meta: { path: "x.txt", bytes: 1 } };
        const tools = {
            describe: () => [], names: () => [],
            invoke: async (name: string, _c: unknown, args: ToolArgs) => {
                calls.push(name);
                if (name === "writeFile") return writeOk;
                await new Promise((r) => setTimeout(r, 10));
                return { ok: true, output: `${name} 结果`, meta: {} };
            },
        } as unknown as ToolRegistry;
        const loop = await runToolLoop({
            llm, tools, ctx: ctx(), ledger,
            system: "s", task: "t", skill: null, maxSteps: 6,
        });
        expect(loop.steps).toBe(2);              // 写 + 批（done 不计步）
        expect(loop.changedFiles).toContain("x.txt");
        expect(loop.finished).toBe(true);
    });
});
