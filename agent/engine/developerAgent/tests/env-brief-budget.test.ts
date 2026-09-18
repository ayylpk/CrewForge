// ============================================================
// tests/env-brief-budget.test.ts —— 环境简报的**预算**与**接线**（9/17 修 flake 的验收，零 LLM）
//
//   被验的东西（都是"配料不许变成咽喉"这条口径，机制本身在 envProbe.test.ts 里钉着）：
//     ① 等待预算：探针迟迟不回 → **到点就回退**，一条断言都不许等下去
//        （实测依据：冷探测空载 4s、满负载 10.4s；此前 inspectProject 直接 await 它，
//         于是 bun 用例的 5s 上限被打爆，且"哪个用例翻车"每次都不一样）；
//     ② 回退不撒谎：没探到就写明"这一轮没探到"，**不许**写成"这台机器什么都没有"
//        （谎报会让模型毫无必要地手写整个工程）；有上一次结果就沿用，并标明"不是本轮现探的"；
//     ③ 来源诚实：fresh / memo 必须分得清——"探测花了 0ms"不能被读成"探测很快"；
//     ④ 接线没断：探针在预算内返回时，**简报必须真的出现在任务书里**
//        （这是"不拿 flake 换能力"的那一半：简报是能力，不是装饰）。
// ============================================================
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import path from "node:path";
import {
    ENV_BRIEF_BUDGET_MS, buildDeveloperGraph, envBriefNotProbedText, envBriefReusedNote, refreshEnvBrief,
} from "../graph";
import type { DeveloperLlm, MessagePort } from "../graph";
import { DeveloperLedger } from "../ledger";
import { Workspace } from "../workspace";
import { initialDeveloperState } from "../state";
import type { DeveloperState } from "../state";
import type { ToolArgs, ToolContext, ToolRegistry } from "../tools/registry";
import type { ArchitectTask } from "../protocol";
import { probeEnvironment } from "../envProbe";
import type { EnvProbe, ProbeOutcome } from "../envProbe";
import { cleanupTempDirsAfterTests, tmpDir } from "./_tmp";

const projectDir = tmpDir("cf-envbrief");
const opened: DeveloperLedger[] = [];
let dbSeq = 0;

/**
 * 跑图的用例会经过 inspectProject 的刷新。这里**先把探针的 60s 记忆焐热**（钩子显式放宽
 * 超时），于是"简报能不能进任务书"验的是**接线**，而不是"这台机器今天探测有多慢"
 * （后者是负载变量，不是契约）。缓存命中是 0ms，图那一侧远远落在 2s 预算之内。
 */
beforeAll(async () => { await probeEnvironment(); }, { timeout: 120_000 });

afterAll(() => {
    for (const l of opened) { try { l.close(); } catch { /* 已关 */ } }
});
cleanupTempDirsAfterTests();

function fakeProbe(over: Partial<EnvProbe> = {}): EnvProbe {
    return {
        probedAt: "2025-09-15T00:00:00.000Z",
        platform: "win32 x64",
        tools: [{ name: "node", available: true, version: "24.8.0", path: "C:\\fake\\node.exe" }],
        network: { npmRegistry: true, note: "registry 可达（HTTP 200，120ms）" },
        ports: [{ port: 5173, free: true }],
        notes: [],
        ...over,
    };
}

// ============================================================
// 一、等待预算：到点就回退（不抛、不重试、不阻塞这一轮）
// ============================================================

describe("环境简报 / 等待预算", () => {
    it("探针迟迟不回 → 到点立刻回退；等了 ~预算，绝不等到底（30s 的探针只等 60ms）", async () => {
        const budgetMs = 60;
        // 一个"永不返回"的探针：模拟机器被压满、18 个子进程都还没回来
        const t0 = Date.now();
        const out = await refreshEnvBrief({ budgetMs, probe: () => new Promise<ProbeOutcome>(() => {}) });
        const elapsed = Date.now() - t0;

        expect(out.timedOut).toBe(true);
        expect(out.waitedMs).toBeGreaterThanOrEqual(budgetMs - 5);
        expect(elapsed).toBeLessThan(budgetMs + 900);        // ★ 关键：没有"等到底"
        expect(out.text.length).toBeGreaterThan(0);          // 永不空（空 = 能力被悄悄丢掉）

        // 回退只有两种合法形态，各自都要**写明**来源；两种都不许把"没探到"说成"没有"
        if (out.source === "not-probed") {
            expect(out.text).toContain("本轮未完成");
            expect(out.text).toContain(`${budgetMs}ms`);
            expect(out.text).toContain("不是");
        } else {
            expect(out.source).toBe("last-brief");
            expect(out.text).toContain("沿用上一次");
        }
    }, 20_000);

    it("默认预算是 2000ms（远小于 bun 用例的 5s 上限，也远小于冷探测实测的 4~10.4s）", () => {
        expect(ENV_BRIEF_BUDGET_MS).toBe(2000);
        expect(ENV_BRIEF_BUDGET_MS).toBeLessThan(5000);
    });

    it("没探到时的替代文本：明确「没探到 ≠ 没有」，且不许出现「什么都没装」式的断言", () => {
        const text = envBriefNotProbedText(2000);
        expect(text).toContain("环境自检");
        expect(text).toContain("2000ms");
        expect(text).toContain("不是");
        expect(text).toContain("probeEnv");                   // 给出"想确认就单点查"的出路
        // ★ 不许把"没探到"写成**事实断言**：这两句是 renderEnvBrief 里真有简报时才会给的结论，
        //   回退文本里出现它们 = 谎报"本机离线 / 什么都没装"（会让模型毫无必要地手写整个工程）。
        expect(text).not.toContain("离线（registry 不可达）");
        expect(text).not.toContain("包管理器缺失");
        // 沿用上次的抬头也要说清"不是本轮现探的"
        expect(envBriefReusedNote(2000)).toContain("沿用上一次");
    });
});

// ============================================================
// 二、来源诚实：fresh / memo 分得清（台账据此记账，见 inspectProject）
// ============================================================

describe("环境简报 / 来源诚实", () => {
    it("真探到 → fresh；命中 60s 记忆 → memo（两者的 waitedMs 都不该被误读）", async () => {
        const fresh = await refreshEnvBrief({
            budgetMs: 5000,
            probe: async () => ({ probe: fakeProbe(), memoHit: false }),
        });
        expect(fresh.timedOut).toBe(false);
        expect(fresh.source).toBe("fresh");
        expect(fresh.text).toContain("环境自检");

        const memo = await refreshEnvBrief({
            budgetMs: 5000,
            probe: async () => ({ probe: fakeProbe(), memoHit: true }),
        });
        expect(memo.timedOut).toBe(false);
        expect(memo.source).toBe("memo");                     // ★ 不把"命中记忆"记成"探测很快"
        expect(memo.text).toContain("环境自检");
    });

    it("探针报错 → 不抛（兜底成 failed 或沿用上次），绝不编造工具清单", async () => {
        const out = await refreshEnvBrief({
            budgetMs: 5000,
            probe: async () => { throw new Error("spawn EPERM"); },
        });
        expect(out.timedOut).toBe(false);
        expect(["failed", "last-brief"]).toContain(out.source);
        expect(out.text.length).toBeGreaterThan(0);
    });
});

// ============================================================
// 三、接线没断：简报真的进了任务书（不拿 flake 换能力）
// ============================================================

const task: ArchitectTask = {
    type: "architect_task", projectId: "p1", taskId: "t1",
    requirementSnapshot: { goal: "便签管理" },
    stackProfile: { frontend: "vue3", backend: "express" },
    domainModel: { entity: "note", table: "note", fields: [] },
    contract: { version: "1", endpoints: [] },
    foundationPlan: { dirs: ["backend", "frontend"] },
    allowedRoots: ["backend", "frontend"], forbiddenPaths: [],
    acceptanceChecks: [], developerInstructions: "按计划实现",
};

function fakeTools(): ToolRegistry {
    return {
        describe: () => [], names: () => [],
        invoke: async (name: string, _ctx: ToolContext, _args: ToolArgs) => {
            if (name === "inspectTree") return { ok: true, output: "共 1 个文件", meta: { total: 1 } };
            return { ok: true, output: "ok" };
        },
    } as unknown as ToolRegistry;
}

describe("环境简报 / 进任务书", () => {
    it("探针在预算内返回（命中记忆）→ 任务书里真的带上了简报，且台账记 source=memo", async () => {
        const ledger = DeveloperLedger.open(path.join(projectDir, `brief-${dbSeq++}.db`), "p1:t1");
        opened.push(ledger);
        const tasks: string[] = [];
        const llm: DeveloperLlm = {
            id: "capture",
            calls: () => tasks.length,
            next: async (input) => { tasks.push(input.task); return { kind: "done" }; },
        };
        const port: MessagePort = {
            send: () => "wake",
            receive: async () => ({ status: "invalid", error: "无消息", sender: null }),
        };
        const graph = buildDeveloperGraph({
            workspace: new Workspace({ projectDir, allowedRoots: ["backend", "frontend"] }),
            tools: fakeTools(), ledger, port, llm, trustedTestAgents: ["test-core"],
        });
        const final = await graph.invoke(initialDeveloperState({
            projectId: "p1", taskId: "t1", runId: "r1", projectDir,
            allowedRoots: ["backend", "frontend"], messages: [task],
        })) as DeveloperState;

        expect(final.status).not.toBe("failed");
        expect(tasks.length).toBeGreaterThan(0);
        // ★ renderEnvBrief 的固定小节名：只有**真的拿到简报**才会出现
        expect(tasks[0]).toContain("**脚手架可行性**");
        expect(tasks[0]).toContain("**构建与验证可行性**");

        // 台账：诚实区分"这轮真探了"与"这轮用了记忆"
        const events = ledger.listEvents();
        const probed = events.find((e) => e.type === "env_probed");
        expect(probed).toBeDefined();
        const payload = probed?.payload as { source?: string; waitedMs?: number } | undefined;
        expect(["fresh", "memo"]).toContain(String(payload?.source));
        expect(typeof payload?.waitedMs).toBe("number");
    }, 60_000);
});
