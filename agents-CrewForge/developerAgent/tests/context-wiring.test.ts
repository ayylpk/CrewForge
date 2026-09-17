// tests/context-wiring.test.ts —— 上下文压缩**接线**的验收（9/17，零 LLM 零网络）
//
//   被验的东西（都是接线，不是机制本身——机制在 context-budget.test.ts 里钉着）：
//     · 发车前的判定：阈值是**从窗口推出来的**，不是常数（换窗口翻转判定）；
//     · 压实了就是**整份替换**（边界 + 摘要），前缀版本号**每次真实压缩恰好 +1**，
//       没压的轮次一格都不动；
//     · 台账两行：context_compacted（含 preCompactTokenCount / autoCompactThreshold /
//       willRetriggerNextTurn / prefixVersion）与 autocompact_tracking（熔断器）；
//     · 熔断器**跨 resume 从台账读回**（3 次连续失败之后不再尝试压缩）；
//     · 越阻塞线：**不发**这一条请求，也不截断，改走既有问人站 → waiting_human；
//     · 摘要调用**真的花额度**（预占记账，querySource:'compact'）。
//
//   摘要口一律是**桩**：真实实现（realLlm.createRealLlmSummarizer）只在生产用，
//   测试里连 fetch 都不会被调到（本文件不 import realLlm 的构造路径）。
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import path from "node:path";
import { buildDeveloperGraph, clipArgsForModel, clipForModel, runToolLoop } from "../graph";
import type { DeveloperLlm, MessagePort } from "../graph";
import { DeveloperLedger } from "../ledger";
import { Workspace } from "../workspace";
import type { ToolArgs, ToolContext, ToolRegistry } from "../tools/registry";
import { initialDeveloperState } from "../state";
import type { DeveloperState } from "../state";
import type { ArchitectTask } from "../protocol";
import { resolveDeveloperContextWindow } from "../index";
import { probeEnvironment } from "../envProbe";
import { readContextWindowColumns } from "../../settings";
import {
    CONTEXT_EVENTS, contextPrefixVersion, modelNameFromLlmId, planContextAction,
    readAutoCompactTracking, resolveWiredContextWindow, runContextGuard, windowProvenance,
} from "../contextCompaction";
import type { ContextLedger } from "../contextCompaction";
import {
    MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES, applyCompactionToHistory, createCompactBoundaryMessage,
    findLastCompactBoundaryIndex, getAutoCompactThreshold, getBlockingLimit,
    getMessagesAfterCompactBoundary, historyToMessages, isCompactBoundaryMessage,
    resetContextWindowWarnings, tokenCountWithEstimation,
} from "../contextBudget";
import type { CompactionResult, UserMessage } from "../contextBudget";
import { cleanupTempDirsAfterTests, tmpDir } from "./_tmp";

const root = tmpDir("cf-dev-ctxwire");
const opened: DeveloperLedger[] = [];
let dbSeq = 0;

/**
 * 图路径的 inspectProject 会先做一次**环境自省**（本机工具探测 + 一次 3s 超时的 npm registry
 * ping，`envProbe.ts` 的既有行为）。跑图的用例因此天然要付这笔时间——实测 4.3~5.1s，
 * 刚好压在 bun 默认的 5s 用例超时上，机器一忙就翻车（本文件先前的两次超时就是这么来的）。
 * 这里在 `beforeAll`（显式放宽钩子超时）**先把探针跑掉**：探针自带 60s 记忆，
 * 于是真正要验的断言跑在缓存上，而不是把"引擎自省有多慢"算进压缩接线的验收里。
 */
beforeAll(async () => { await probeEnvironment(); }, { timeout: 90_000 });

// 先关账本，再删树（顺序不能反：开着 sqlite 删树在 Windows 上是 EBUSY，见 _tmp.ts 文件头实测）。
afterAll(() => {
    for (const l of opened) { try { l.close(); } catch { /* 已关 */ } }
});
cleanupTempDirsAfterTests();

function ledgerFor(): DeveloperLedger {
    const l = DeveloperLedger.open(path.join(root, `ctx-${dbSeq++}.db`), `p1:t1:ctx${dbSeq}`);
    opened.push(l);
    return l;
}

/** 内存台账：只验"判定 + 记账"的用例用它（不必为一次判定开 sqlite） */
function memLedger(): ContextLedger & { events: { type: string; payload: unknown }[] } {
    const events: { type: string; payload: unknown }[] = [];
    return {
        events,
        appendEvent: (type, payload) => { events.push({ type, payload }); },
        listEvents: () => events.map((e, i) => ({ type: e.type, payload: e.payload, at: i })),
    };
}

const workspace = new Workspace({ projectDir: root, allowedRoots: ["backend", "frontend"] });
const ctx = (): ToolContext => ({
    workspace, owner: "developerAgent", role: "developer", taskId: "T1",
});

/** 一条与 runToolLoop 内部**同形**的工具结果条目（用同一套裁剪函数，免得两处口径跑偏） */
function entryOf(tool: string, args: ToolArgs, output: string): unknown {
    return {
        tool, args: clipArgsForModel(args), ok: true,
        output: clipForModel({ tool, output }), rejected: null,
    };
}

/** 一条"大"工具结果（裁剪后 ≈ 5.1K 字符 ≈ 1.3K token） */
const BIG = "x".repeat(60_000);

/** k 条大条目之后的**真实用量**（口径与接线用的 tokenCountWithEstimation 完全一致） */
function usageAfter(k: number): number {
    const entries = Array.from({ length: k }, (_, i) => entryOf("readFile", { path: `f${i}.ts` }, BIG));
    return tokenCountWithEstimation(historyToMessages(entries));
}

/**
 * ★ **反解窗口**：找一个窗口 W，使"k 条之后越线"而"k−1 条之后不越线"。
 *   为什么要反解而不是把阈值写死：阈值必须**从窗口推出来**（这是机制的要点），
 *   写死一个窗口等于把测试和常数绑在一起——别人动了裁剪上限，测试就变成假绿/假红。
 *   反解出来的是"第 k 条之后必然压实一次"这件事本身。
 */
function windowCrossingAt(before: number, after: number): number {
    for (let w = 8_000; w <= 400_000; w += 2) {
        const t = getAutoCompactThreshold(resolveWiredContextWindow({
            model: "cross", settingsWindowTokens: w, env: {},
        }));
        if (t > before && t <= after) return w;
    }
    throw new Error("找不到满足条件的窗口（前提失效：请检查 clipForModel 的裁剪上限是否被改动）");
}

/** 永远调工具（带不同参数，避开重复调用提醒）的 Fake：让 loop 跑满 maxSteps */
function loopLlm(captured: unknown[][]): DeveloperLlm {
    let calls = 0;
    return {
        id: "loop-fake",
        calls: () => calls,
        next: async (input) => {
            calls++;
            captured.push(input.history.map((h) => h));
            return { kind: "tool", tool: "readFile", args: { path: `f${calls}.ts` } };
        },
    };
}

/** 每次都吐一大段结果的 Fake 工具盒（绝不真读盘/真跑命令） */
function bigOutputTools(): ToolRegistry {
    return {
        describe: () => [{ name: "readFile", description: "d", parameters: {} }],
        names: () => ["readFile"],
        invoke: async () => ({ ok: true, output: BIG }),
    } as unknown as ToolRegistry;
}

/** 压缩摘要桩：记下调用次数，返回一段可辨认的摘要（**不发任何网络请求**） */
function summaryStub(o: { usage?: { input_tokens: number; output_tokens: number } } = {}) {
    const calls: string[] = [];
    const summarize = async (req: { systemPrompt: string[] }): Promise<{ text: string; usage: { input_tokens: number; output_tokens: number } }> => {
        calls.push(req.systemPrompt.join(""));
        return {
            text: "<analysis>草稿不进上下文</analysis><summary>已经做完 A、B；下一步 C</summary>",
            usage: o.usage ?? { input_tokens: 1234, output_tokens: 567 },
        };
    };
    return { summarize, calls };
}

// ============================================================
describe("接线 / 窗口解析与判定（纯函数，零 LLM）", () => {
    it("★ 阈值是从窗口推出来的：200K 窗口逐位等于 cc 的 167_000，换窗口就换线", () => {
        const cc200k = resolveWiredContextWindow({ model: "m", settingsWindowTokens: 200_000, env: {} });
        expect(getAutoCompactThreshold(cc200k)).toBe(167_000);      // eff 180_000 − 13_000（对拍锚点）
        expect(getBlockingLimit(cc200k)).toBe(177_000);             // eff − 3_000
        const small = resolveWiredContextWindow({ model: "m", settingsWindowTokens: 32_000, env: {} });
        expect(getAutoCompactThreshold(small)).not.toBe(167_000);   // 不是常数
        expect(getAutoCompactThreshold(small)).toBeLessThan(167_000);
        // 判定在线两侧翻转（阈值本身不是"大概齐"）
        const t = getAutoCompactThreshold(cc200k);
        expect(planContextAction({ used: t - 1, window: cc200k, canSummarize: true })).toBe("send");
        expect(planContextAction({ used: t, window: cc200k, canSummarize: true })).toBe("compact");
        // 没有摘要口时"压"这个动作不存在 → 越过阻塞线只能 blocked
        expect(planContextAction({ used: getBlockingLimit(cc200k), window: cc200k, canSummarize: false }))
            .toBe("blocked");
    });

    it("窗口优先级：设置值 > [1m] 模型名 > env > 产品默认（未配置时 degraded + 台账留痕）", () => {
        expect(resolveWiredContextWindow({
            model: "m", settingsWindowTokens: 40_000, env: { CF_CONTEXT_WINDOW_TOKENS: "999" },
        }).source).toBe("settings");
        expect(resolveWiredContextWindow({
            model: "deepseek-v4-pro[1m]", env: { CF_CONTEXT_WINDOW_TOKENS: "999" },
        })).toMatchObject({ contextWindowTokens: 1_000_000, source: "model-suffix" });
        expect(resolveWiredContextWindow({
            model: "m", env: { CF_CONTEXT_WINDOW_TOKENS: "12345" },
        })).toMatchObject({ contextWindowTokens: 12_345, source: "env" });
        // pro 档专用覆盖只在 tier==="pro" 时看
        expect(resolveWiredContextWindow({
            model: "m", tier: "pro", settingsWindowTokens: 40_000, settingsWindowProTokens: 900_000, env: {},
        })).toMatchObject({ contextWindowTokens: 900_000, source: "settings-tier" });
    });

    it("★ 未配置 → 产品默认 256K + degraded，且**告警原文进台账**（假设必须可见）", async () => {
        const ledger = memLedger();
        const out = await runContextGuard({
            history: [], ledger, taskId: "T1", turnCounter: 0,
            model: "未配置窗口的探针模型", env: {}, warn: () => { /* 静音，断言台账 */ },
        });
        expect(out.window.contextWindowTokens).toBe(256_000);
        expect(out.window.source).toBe("unset-default");
        expect(out.window.degraded).toBe(true);
        const rows = ledger.events.filter((e) => e.type === CONTEXT_EVENTS.windowResolved);
        expect(rows.length).toBe(1);
        expect(String((rows[0]?.payload as { warning?: string }).warning)).toContain("上下文窗口未配置");
    });

    it("从客户端 id 反解模型名（env 可能是另一套配置，dotenv.ts 的教训）", () => {
        expect(modelNameFromLlmId("real:deepseek-v4-pro[1m]@https://api.deepseek.com/anthropic:tools"))
            .toBe("deepseek-v4-pro[1m]");
        expect(modelNameFromLlmId("real-lazy")).toBeNull();       // 包装器：认不出就退回 env
        expect(modelNameFromLlmId("fake-hub-runner")).toBeNull();
    });
});

// ============================================================
describe("接线 / 设置读入（sys_settings 两列）与装配处一次解析", () => {
    it("★ 列**还没建**时读列为 null 且不抛（回落到下一步解析，绝不静默变 0）", () => {
        // 这一条就是 owner 点名的"迁移未跑"路径：SELECT * 拿到的行里根本没有这两列
        const rowWithoutColumns = { model_name: "deepseek-v4-flash", role_models: null };
        const r = readContextWindowColumns(rowWithoutColumns);
        expect(r.contextWindow).toBeNull();
        expect(r.contextWindowPro).toBeNull();
        // 空表/读不到（rows[0] 为 undefined）同样安全
        expect(readContextWindowColumns(undefined)).toEqual({ contextWindow: null, contextWindowPro: null });
        expect(readContextWindowColumns(null)).toEqual({ contextWindow: null, contextWindowPro: null });
        // 空串 / "0" / 垃圾串 → 一律"没配"（不猜数字；坏数据当没配比猜一个数安全）
        expect(readContextWindowColumns({ context_window: "", context_window_pro: 0 }).contextWindow).toBeNull();
        expect(readContextWindowColumns({ context_window: "128k" }).contextWindow).toBeNull();
        expect(readContextWindowColumns({ context_window: "abc" }).contextWindowPro).toBeNull();
        // 正常值：数字与数字串都收（与同文件其它数值列的 `Number(x) || null` 口径一致）
        expect(readContextWindowColumns({ context_window: 200_000, context_window_pro: "1000000" }))
            .toEqual({ contextWindow: 200_000, contextWindowPro: 1_000_000 });
    });

    it("★ 列没建 → 解析落到下一步：模型名 [1m] 仍然生效，最后才是产品默认 256K", () => {
        const rtMissing = {
            modelName: null, modelPro: null, roleModels: null, modelUrl: null, apiKey: null,
            modelKind: "deepseek", javaBaseUrl: "", confirmTimeoutMin: 30, smokeBuild: false,
            llmConcurrency: 6, stationSlots: 5, toolMode: false,
            // 关键：两列读不到 = null（列还没建的那一天就是这个形状）
            contextWindow: null, contextWindowPro: null,
        };
        const missing = readContextWindowColumns({});                 // 真的没有列
        expect(missing.contextWindow).toBeNull();
        // ① 列没建 + pro 档模型名自带 [1m] → 1M（不因为"没配窗口"就退 256K）
        const pro = resolveWiredContextWindow({
            model: "deepseek-v4-pro[1m]", tier: "pro", env: {},
            settingsWindowTokens: missing.contextWindow,
            settingsWindowProTokens: missing.contextWindowPro,
        });
        expect(pro).toMatchObject({ contextWindowTokens: 1_000_000, source: "model-suffix" });
        expect(pro.degraded).toBe(false);
        // ② 列没建 + 名字里没有窗口信息 + env 也没设 → 产品默认 256K + degraded
        const unset = resolveWiredContextWindow({
            model: "deepseek-v4-flash", tier: "flash", env: {},
            settingsWindowTokens: missing.contextWindow,
            settingsWindowProTokens: missing.contextWindowPro,
            warn: () => { /* 静音（同一个 key 只喊一次，喊了也不影响判定） */ },
        });
        expect(unset).toMatchObject({ contextWindowTokens: 256_000, source: "unset-default", degraded: true });
        // ③ 列建好且填了值 → 用填的（degraded 关掉）
        const configured = resolveWiredContextWindow({
            model: "deepseek-v4-flash", tier: "flash", env: {},
            settingsWindowTokens: 128_000, settingsWindowProTokens: null,
        });
        expect(configured).toMatchObject({ contextWindowTokens: 128_000, source: "settings", degraded: false });
        expect(rtMissing.contextWindow).toBeNull();                    // 记录：上面那份假 rt 确实是"没配"
    });

    it("★ 装配处一次解析：档位由 resolveRoleTier 给，pro 档用 model_pro 顶名（1M 声明生效）", () => {
        const base = {
            modelName: "deepseek-v4-flash", modelPro: "deepseek-v4-pro[1m]", roleModels: null,
            modelUrl: null, apiKey: null, modelKind: "deepseek", javaBaseUrl: "", confirmTimeoutMin: 30,
            smokeBuild: false, llmConcurrency: 6, stationSlots: 5, toolMode: false,
            contextWindow: null, contextWindowPro: null,
        };
        // frontend 在内置档位表里是 pro → 模型名取 model_pro（自带 [1m]）→ 1M 窗口
        const pro = resolveDeveloperContextWindow({
            llmId: "fake-wrapper", role: "frontend", rt: base, env: {}, warn: () => { /* 静音 */ },
        });
        expect(pro).toMatchObject({
            contextWindowTokens: 1_000_000, source: "model-suffix", tier: "pro",
            model: "deepseek-v4-pro[1m]", degraded: false,
        });
        // backend 是 flash → 退回全局 model_name → 名字里没有窗口信息 → 产品默认 256K + degraded
        const flash = resolveDeveloperContextWindow({
            llmId: "fake-wrapper", role: "backend", rt: base, env: {}, warn: () => { /* 静音 */ },
        });
        expect(flash).toMatchObject({
            contextWindowTokens: 256_000, source: "unset-default", tier: "flash",
            model: "deepseek-v4-flash", degraded: true,
        });
        // 设置里填了真值 → 直接用它（tier 覆盖口也照走）
        const configured = resolveDeveloperContextWindow({
            llmId: "fake-wrapper", role: "backend", rt: { ...base, contextWindow: 96_000 }, env: {},
        });
        expect(configured).toMatchObject({ contextWindowTokens: 96_000, source: "settings", degraded: false });
        const proOverride = resolveDeveloperContextWindow({
            llmId: "fake-wrapper", role: "frontend", rt: { ...base, contextWindowPro: 512_000 }, env: {},
        });
        expect(proOverride).toMatchObject({ contextWindowTokens: 512_000, source: "settings-tier" });
        // rt=null（库里还没读到）→ 全回落：llm.id 认不出 → env → 产品默认；**不抛**
        const noRt = resolveDeveloperContextWindow({
            llmId: "fake-wrapper", rt: null, env: { DEVELOPER_LLM_MODEL: "deepseek-v4-flash" }, warn: () => { /* 静音 */ },
        });
        expect(noRt).toMatchObject({ contextWindowTokens: 256_000, source: "unset-default", degraded: true });
        // 实际客户端排最前：设置里写着 pro 名，但真在用的是 flash 客户端 → 按**实际**算（宁小不大）
        const actual = resolveDeveloperContextWindow({
            llmId: "real:deepseek-v4-flash@https://api.deepseek.com/anthropic:tools",
            role: "frontend", rt: base, env: {}, warn: () => { /* 静音 */ },
        });
        expect(actual.model).toBe("deepseek-v4-flash");
        expect(actual.contextWindowTokens).toBe(256_000);              // 不是 1M
    });
});

// ============================================================
describe("接线 / runToolLoop 里的压缩（阈值、整份替换、前缀版本）", () => {
    it("★ 越过阈值就压实一次；压实后 history 是**整份替换**（只剩边界 + 摘要）", async () => {
        const before4 = usageAfter(4);
        const after5 = usageAfter(5);
        const window = windowCrossingAt(before4, after5);
        const ledger = ledgerFor();
        const captured: unknown[][] = [];
        const stub = summaryStub();

        const loop = await runToolLoop({
            llm: loopLlm(captured), tools: bigOutputTools(), ctx: ctx(), ledger,
            system: "s", task: "t", skill: null, maxSteps: 6,
            contextBudget: { model: "cross", settingsWindowTokens: window, env: {}, summarize: stub.summarize },
        });

        // ① 判定确实发生（前提可见：第 5 条之后越线，第 4 条之后不越线）
        expect(loop.steps).toBe(6);
        expect(tokenCountWithEstimation(historyToMessages(captured[4] ?? []))).toBe(before4);
        expect(loop.context.compactions).toBe(1);
        expect(loop.context.prefixVersion).toBe(1);
        expect(stub.calls.length).toBe(1);

        // ② **整份替换**：压实那一轮的请求里，旧条目一条不剩，只有边界 + 摘要
        const sent = captured[5] ?? [];
        expect(sent.length).toBe(2);
        const head = sent[0] as Record<string, unknown>;
        const digest = sent[1] as Record<string, unknown>;
        expect(head["type"]).toBe("system");
        expect(head["subtype"]).toBe("compact_boundary");
        expect(digest["type"]).toBe("compaction_summary");
        expect(String(digest["text"])).toContain("已经做完 A、B");
        // 摘要是**回灌给模型**的那一段（cc 的 getCompactUserSummaryMessage 抬头）
        expect(String(digest["text"])).toContain("This session is being continued");
        // 旧的大条目（5 条 × 1.3K token）一条都不在
        expect(sent.some((e) => String((e as Record<string, unknown>)["output"] ?? "").includes("xxx"))).toBe(false);

        // ③ 台账：context_compacted 一行，字段齐（自检清单点名的那三个）
        const rows = ledger.listEvents().filter((e) => e.type === CONTEXT_EVENTS.compacted);
        expect(rows.length).toBe(1);
        const p = rows[0]?.payload as Record<string, unknown>;
        expect(p["preCompactTokenCount"]).toBeGreaterThanOrEqual(Number(p["autoCompactThreshold"]));
        expect(p["willRetriggerNextTurn"]).toBe(false);
        expect(p["prefixVersion"]).toBe(1);
        expect(p["compactionId"]).toBe(head["uuid"]);
        expect(contextPrefixVersion(ledger)).toBe(1);
        // ④ ★ 窗口出处五个字段（owner 规格）：真实 vs 假设，事后必须可审
        expect(p["contextWindowTokens"]).toBe(window);
        expect(p["source"]).toBe("settings");
        expect(p["degraded"]).toBe(false);
        expect(p["tier"]).toBeNull();                       // 这一轮没分层（未传 tier）
        expect(p["model"]).toBe("cross");
    });

    it("★ 没越线就不压：大窗口下同一个 loop 一次都不压，前缀版本为 0（无操作轮不改动）", async () => {
        const ledger = ledgerFor();
        const captured: unknown[][] = [];
        const stub = summaryStub();
        const loop = await runToolLoop({
            llm: loopLlm(captured), tools: bigOutputTools(), ctx: ctx(), ledger,
            system: "s", task: "t", skill: null, maxSteps: 6,
            contextBudget: { model: "m", settingsWindowTokens: 1_000_000, env: {}, summarize: stub.summarize },
        });
        expect(loop.context.compactions).toBe(0);
        expect(loop.context.prefixVersion).toBe(0);
        expect(stub.calls.length).toBe(0);                       // 一次摘要调用都没发生
        expect(ledger.listEvents().some((e) => e.type === CONTEXT_EVENTS.compacted)).toBe(false);
        expect(contextPrefixVersion(ledger)).toBe(0);
        // 历史照旧**逐条累积**（前 5 轮各留一条结果，没有被"顺手折一下"）
        expect((captured[5] ?? []).length).toBe(5);
    });

    it("★ 一次真实压缩 = 版本号 +1：版本号 ≡ 压缩次数 ≡ 台账行数（绝不虚增、无操作轮不动）", async () => {
        const window = windowCrossingAt(usageAfter(4), usageAfter(5));
        const ledger = ledgerFor();
        const captured: unknown[][] = [];
        const stub = summaryStub();
        const loop = await runToolLoop({
            llm: loopLlm(captured), tools: bigOutputTools(), ctx: ctx(), ledger,
            system: "s", task: "t", skill: null, maxSteps: 12,
            contextBudget: { model: "cross", settingsWindowTokens: window, env: {}, summarize: stub.summarize },
        });
        // 版本号是台账里 context_compacted 的行数（= 跨 resume 可复原的定义），
        // 三者必须**恒等**：压缩了几次、摘要调用了几次、台账写了几行。
        const rows = ledger.listEvents().filter((e) => e.type === CONTEXT_EVENTS.compacted).length;
        expect(loop.context.compactions).toBeGreaterThanOrEqual(1);
        expect(stub.calls.length).toBe(loop.context.compactions);
        expect(loop.context.prefixVersion).toBe(loop.context.compactions);
        expect(contextPrefixVersion(ledger)).toBe(loop.context.compactions);
        expect(rows).toBe(loop.context.compactions);
        // 每个版本号在台账里只出现一次（不存在"同一版写两行"或"跳号"）
        const versions = ledger.listEvents()
            .filter((e) => e.type === CONTEXT_EVENTS.compacted)
            .map((e) => (e.payload as { prefixVersion?: number }).prefixVersion);
        expect(versions).toEqual(Array.from({ length: versions.length }, (_, i) => i + 1));
    });

    it("不接线（不传 contextBudget）= 连量都不量：行为与接线前逐字节一致", async () => {
        const ledger = ledgerFor();
        const captured: unknown[][] = [];
        const loop = await runToolLoop({
            llm: loopLlm(captured), tools: bigOutputTools(), ctx: ctx(), ledger,
            system: "s", task: "t", skill: null, maxSteps: 3,
        });
        expect(loop.context).toEqual({ compactions: 0, prefixVersion: 0, tracking: null, blocked: null });
        expect(ledger.listEvents().some((e) => e.type.startsWith("context_"))).toBe(false);
    });

    it("★ 压缩产物**能被读回**：边界找得到、摘要正文算进用量（否则链式压缩会断档/少算）", () => {
        const boundary = createCompactBoundaryMessage("auto", 12_345, undefined, undefined, 3, { uuid: "B-1" });
        const summary: UserMessage = {
            type: "user", uuid: "S-1", timestamp: "T0", isCompactSummary: true, isVisibleInTranscriptOnly: true,
            message: { content: "This session is being continued from a previous conversation.\n\nSummary:\n做完了 X" },
        };
        const result: CompactionResult = {
            boundaryMarker: boundary, summaryMessages: [summary], attachments: [], hookResults: [],
            preCompactTokenCount: 12_345,
        };
        const before = [entryOf("readFile", { path: "old.ts" }, BIG)];
        const applied = applyCompactionToHistory(before, result);
        const back = historyToMessages(applied.history);

        expect(back.length).toBe(2);
        expect(isCompactBoundaryMessage(back[0]!)).toBe(true);
        expect((back[1] as UserMessage).isCompactSummary).toBe(true);
        // 边界能被找到 → 下一次压缩只把"最后一道边界之后"当活的对话（cc 的切分语义）
        expect(findLastCompactBoundaryIndex(back)).toBe(0);
        expect(getMessagesAfterCompactBoundary(back).length).toBe(2);
        // 摘要正文**算进用量**（否则每次压缩后都少算一份摘要 ⇒ 压缩触发偏晚）
        expect(tokenCountWithEstimation(back)).toBeGreaterThan(10);
        const blocks = (back[1] as UserMessage).message.content as { type: string; text?: string }[];
        expect(blocks[0]?.text).toContain("做完了 X");
    });
});

// ============================================================
describe("接线 / 窗口出处落台账（真实 vs 假设，事后可审）", () => {
    /** 那五个字段（owner 规格点名的就是这五个名字） */
    const PROVENANCE_FIELDS = ["contextWindowTokens", "source", "degraded", "tier", "model"] as const;
    const bigHistory = (): unknown[] =>
        Array.from({ length: 40 }, (_, i) => entryOf("readFile", { path: `prov${i}.ts` }, BIG));

    it("★ context_compacted 与 autocompact_tracking **都**带那五个字段（配好的窗口 = 事实）", async () => {
        const ledger = memLedger();
        const stub = summaryStub();
        const out = await runContextGuard({
            history: bigHistory(), ledger, taskId: "T1", turnCounter: 0,
            model: "deepseek-v4-flash", tier: "flash", settingsWindowTokens: 32_000, env: {},
            summarize: stub.summarize,
        });
        expect(out.compacted).toBe(true);
        for (const type of [CONTEXT_EVENTS.compacted, CONTEXT_EVENTS.tracking]) {
            const row = ledger.events.find((e) => e.type === type)?.payload as Record<string, unknown>;
            expect(row).toBeDefined();
            for (const f of PROVENANCE_FIELDS) expect(f in row).toBe(true);
            expect(row["contextWindowTokens"]).toBe(32_000);
            expect(row["source"]).toBe("settings");
            expect(row["degraded"]).toBe(false);
            expect(row["tier"]).toBe("flash");
            expect(row["model"]).toBe("deepseek-v4-flash");
        }
    });

    it("★ 没配窗口的那一轮：degraded=true + unset-default，台账明说「阈值是猜的」", async () => {
        resetContextWindowWarnings();                       // 保证这一轮真的会喊出那行告警
        const ledger = memLedger();
        const stub = summaryStub();
        const probe = `未配置窗口探针-${dbSeq}`;              // 每次跑用一个新 key（告警按 (tier,model) 只喊一次）
        // 没配窗口 ⇒ 阈值按**产品默认 256K** 算（≈219K token）。历史要按**算出来的**条数造，
        // 不写死：否则默认值一变，这条测试就从"验台账"退化成"验常数"。
        const unsetSpec = resolveWiredContextWindow({ model: probe, env: {}, warn: () => { /* 静音 */ } });
        expect(unsetSpec.source).toBe("unset-default");
        const perEntry = tokenCountWithEstimation(historyToMessages([entryOf("readFile", { path: "x.ts" }, BIG)]));
        const need = Math.ceil((getAutoCompactThreshold(unsetSpec) + 5_000) / perEntry) + 1;
        const history = Array.from({ length: need }, (_, i) => entryOf("readFile", { path: `prov${i}.ts` }, BIG));
        // 前提：确实越线（算出来的，不是猜的）
        expect(tokenCountWithEstimation(historyToMessages(history)))
            .toBeGreaterThan(getAutoCompactThreshold(unsetSpec));      // 前提：确实越线
        // 上面那次 unsetSpec 解析已经把"这个 key 的告警"用掉了，所以闸内不会再调用 warn。
        // 这里**再清一次**记忆，让闸内那一轮真的喊出告警——否则台账里不会有告警原文，
        // 而"告警可见"是这条链路的红线，测试会变成假绿（断言写着"可见"却什么都没查）。
        resetContextWindowWarnings();

        const out = await runContextGuard({
            history, ledger, taskId: "T1", turnCounter: 0,
            model: probe, tier: null, env: {}, summarize: stub.summarize, warn: () => { /* 静音内容，只看台账 */ },
        });
        expect(out.compacted).toBe(true);
        const compactedRow = ledger.events
            .find((e) => e.type === CONTEXT_EVENTS.compacted)?.payload as Record<string, unknown>;
        expect(compactedRow["contextWindowTokens"]).toBe(256_000);   // 产品默认
        expect(compactedRow["source"]).toBe("unset-default");
        expect(compactedRow["degraded"]).toBe(true);                 // ★ 与"已配置窗口"的轮次**不可比**
        expect(compactedRow["model"]).toBe(probe);
        // 告警原文也留在台账里（"假设可见"是这条链路的红线），字段与压缩行同一套
        const resolved = ledger.events
            .find((e) => e.type === CONTEXT_EVENTS.windowResolved)?.payload as Record<string, unknown>;
        expect(resolved).toBeDefined();
        for (const f of PROVENANCE_FIELDS) expect(f in resolved).toBe(true);
        expect(resolved["degraded"]).toBe(true);
        expect(String(resolved["warning"])).toContain("上下文窗口未配置");
    });

    it("★ 压缩失败的那一行也要能分辨底数（熔断器行同样带出处）", async () => {
        const ledger = memLedger();
        const failing = async (): Promise<{ text: string }> => {
            throw new Error("模拟摘要失败");
        };
        const out = await runContextGuard({
            history: bigHistory(), ledger, taskId: "T1", turnCounter: 0,
            model: "m", tier: "pro", settingsWindowTokens: 40_000, settingsWindowProTokens: 64_000, env: {},
            summarize: failing,
        });
        expect(out.compacted).toBe(false);
        const trackingRow = ledger.events
            .filter((e) => e.type === CONTEXT_EVENTS.tracking).at(-1)?.payload as Record<string, unknown>;
        expect(trackingRow["consecutiveFailures"]).toBe(1);
        expect(trackingRow["contextWindowTokens"]).toBe(64_000);     // pro 档覆盖生效
        expect(trackingRow["source"]).toBe("settings-tier");
        expect(trackingRow["degraded"]).toBe(false);
        expect(trackingRow["tier"]).toBe("pro");
        const failedRow = ledger.events
            .find((e) => e.type === CONTEXT_EVENTS.compactionFailed)?.payload as Record<string, unknown>;
        expect(failedRow["contextWindowTokens"]).toBe(64_000);
        expect(failedRow["degraded"]).toBe(false);
    });

    it("windowProvenance：五个字段就是 spec 的五个出处（唯一出处函数）", () => {
        const spec = resolveWiredContextWindow({ model: "m", tier: "flash", settingsWindowTokens: 128_000, env: {} });
        expect(windowProvenance(spec)).toEqual({
            contextWindowTokens: 128_000, source: "settings", degraded: false, tier: "flash", model: "m",
        });
    });
});

// ============================================================
describe("接线 / 预算记账（摘要调用真的花额度）", () => {
    it("★ 摘要调用计入 llmCallsPlanned/Completed，且台账里带 querySource:'compact'", async () => {
        const window = windowCrossingAt(usageAfter(4), usageAfter(5));
        const ledger = ledgerFor();
        const captured: unknown[][] = [];
        const stub = summaryStub({ usage: { input_tokens: 1234, output_tokens: 567 } });
        const loop = await runToolLoop({
            llm: loopLlm(captured), tools: bigOutputTools(), ctx: ctx(), ledger,
            system: "s", task: "t", skill: null, maxSteps: 6,
            contextBudget: { model: "cross", settingsWindowTokens: window, env: {}, summarize: stub.summarize },
        });
        // 6 轮决策 + 1 次摘要 = 7 次真实调用（预占与完成都对得上）
        expect(loop.llmCallsPlanned).toBe(7);
        expect(loop.llmCallsCompleted).toBe(7);
        const planned = ledger.listEvents().filter((e) => e.type === "llm_call_planned");
        expect(planned.length).toBe(7);
        const compactRows = planned.filter((e) => (e.payload as { querySource?: string }).querySource === "compact");
        expect(compactRows.length).toBe(1);                       // 摘要那一笔单独可辨
        // 摘要调用的 token 也进了压缩事件（计费口径）
        const p = ledger.listEvents().find((e) => e.type === CONTEXT_EVENTS.compacted)?.payload as Record<string, unknown>;
        expect(p["compactionInputTokens"]).toBe(1234);
        expect(p["compactionOutputTokens"]).toBe(567);
        expect(p["compactionTotalTokens"]).toBe(1801);
        // 请求形状：摘要调用用的是 cc 的 system 提示词（不是 developer 的 system prompt）
        expect(stub.calls[0]).toContain("summarizing conversations");
    });

    it("★ 额度不够时**不压**：一次判定都不发起摘要调用（如实降级，绝不偷偷超支）", async () => {
        const ledger = memLedger();
        const stub = summaryStub();
        let charged = 0;
        const out = await runContextGuard({
            history: Array.from({ length: 30 }, (_, i) => entryOf("readFile", { path: `b${i}.ts` }, BIG)),
            ledger, taskId: "T1", turnCounter: 0,
            model: "m", settingsWindowTokens: 32_000, env: {},
            summarize: stub.summarize,
            canCharge: () => false,                     // 没有可用额度
            charge: () => { charged++; return false; },
        });
        expect(stub.calls.length).toBe(0);              // 没有摘要调用
        expect(charged).toBe(0);                        // 也没有"先占后失败"的假动作
        expect(out.compacted).toBe(false);
        expect(out.summaryCalls.attempted).toBe(0);
    });

    it("★ 摘要调用花掉的那格额度进预占：额度刚好够它时，本轮**不再发主请求**", async () => {
        const window = windowCrossingAt(usageAfter(4), usageAfter(5));
        const ledger = ledgerFor();
        const captured: unknown[][] = [];
        const stub = summaryStub();
        const loop = await runToolLoop({
            llm: loopLlm(captured), tools: bigOutputTools(), ctx: ctx(), ledger,
            system: "s", task: "t", skill: null, maxSteps: 6, llmBudget: 6,
            contextBudget: { model: "cross", settingsWindowTokens: window, env: {}, summarize: stub.summarize },
        });
        // 5 轮决策 + 1 次摘要 = 6 格全部用掉 → 第 6 轮的主请求没额度，如实收工
        expect(loop.llmCallsPlanned).toBe(6);
        expect(stub.calls.length).toBe(1);
        expect(loop.context.compactions).toBe(1);
        expect(loop.budgetStopped).toBe(true);
        expect(captured.length).toBe(5);
        const planned = ledger.listEvents().filter((e) => e.type === "llm_call_planned");
        expect(planned.length).toBe(6);
        expect(planned.filter((e) => (e.payload as { querySource?: string }).querySource === "compact").length)
            .toBe(1);
    });
});

// ============================================================
describe("接线 / 熔断器跨 resume（台账是唯一真相）", () => {
    it("★ 连续失败 3 次后不再尝试压缩——**续跑（新的一次判定）照样不再试**", async () => {
        const ledger = ledgerFor();
        let thrown = 0;
        const failing = async (): Promise<{ text: string }> => {
            thrown++;
            throw new Error("模拟摘要调用失败（网络/网关）");
        };
        const bigHistory = Array.from({ length: 40 }, (_, i) =>
            entryOf("readFile", { path: `big${i}.ts` }, BIG));

        // 三次独立的"一次判定"（每次都是新进程里的新调用，模拟 3 次 resume）
        for (let i = 0; i < MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES; i++) {
            const out = await runContextGuard({
                history: bigHistory, ledger, taskId: "T1", turnCounter: i,
                model: "m", settingsWindowTokens: 32_000, env: {}, summarize: failing,
            });
            expect(out.compacted).toBe(false);
            expect(out.tracking.consecutiveFailures).toBe(i + 1);
        }
        expect(thrown).toBe(MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES);
        // 熔断器落台账，**读回来还在**（这就是"续跑不许清零"的凭据）
        const back = readAutoCompactTracking(ledger);
        expect(back?.consecutiveFailures).toBe(MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES);
        // 第 4 次判定：熔断器生效——**一次摘要调用都不再发生**
        const out4 = await runContextGuard({
            history: bigHistory, ledger, taskId: "T1", turnCounter: 9,
            model: "m", settingsWindowTokens: 32_000, env: {}, summarize: failing,
        });
        expect(thrown).toBe(MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES);
        expect(out4.compacted).toBe(false);
        // 越了阻塞线 → 不许发：交给问人站（不是硬发、不是截断）
        expect(out4.blocked).toBe(true);
        expect(out4.detail).toContain("CONTEXT_OVERFLOW");
        expect(ledger.listEvents().some((e) => e.type === CONTEXT_EVENTS.requestBlocked)).toBe(true);
    });

    it("★ 续跑场景（台账里已有 3 次失败）：新起一轮 loop **不再尝试压缩**，直接按越窗处理", async () => {
        const ledger = ledgerFor();
        // 模拟"上一个进程里连续失败 3 次"留下的台账（这就是 resume 之后唯一能读到的东西）
        for (let i = 1; i <= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES; i++) {
            ledger.appendEvent(CONTEXT_EVENTS.tracking, {
                taskId: "T1", compacted: false, turnCounter: i, turnId: "", consecutiveFailures: i,
            });
        }
        const captured: unknown[][] = [];
        const stub = summaryStub();
        const loop = await runToolLoop({
            llm: loopLlm(captured), tools: bigOutputTools(), ctx: ctx(), ledger,
            system: "s", task: "t", skill: null, maxSteps: 6,
            contextBudget: { model: "m", settingsWindowTokens: 12_000, env: {}, summarize: stub.summarize },
        });
        expect(stub.calls.length).toBe(0);                 // 熔断器生效：一次都没试（← resume 不许清零）
        expect(loop.context.compactions).toBe(0);
        expect(loop.context.blocked).not.toBeNull();       // 压不动 → 不发，交问人
        // 每一轮真的发出去的请求都记了账，而 blocked 那一轮**没有**白占额度
        expect(loop.steps).toBeGreaterThan(0);
        expect(loop.llmCallsPlanned).toBe(loop.steps);
        expect(captured.length).toBe(loop.steps);
        expect(readAutoCompactTracking(ledger)?.consecutiveFailures)
            .toBe(MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES);   // 读回来还是 3
    });

    it("成功压缩后熔断器**清零**并落台账（下一轮从头算）", async () => {
        const ledger = ledgerFor();
        let failures = 0;
        const sometimes = async (): Promise<{ text: string }> => {
            failures++;
            if (failures === 1) throw new Error("第一次失败");
            return { text: "第二次成功" };
        };
        const bigHistory = Array.from({ length: 40 }, (_, i) =>
            entryOf("readFile", { path: `big${i}.ts` }, BIG));
        const first = await runContextGuard({
            history: bigHistory, ledger, taskId: "T1", turnCounter: 0,
            model: "m", settingsWindowTokens: 32_000, env: {}, summarize: sometimes,
        });
        expect(first.compacted).toBe(false);
        expect(readAutoCompactTracking(ledger)?.consecutiveFailures).toBe(1);
        const second = await runContextGuard({
            history: bigHistory, ledger, taskId: "T1", turnCounter: 1,
            model: "m", settingsWindowTokens: 32_000, env: {}, summarize: sometimes,
        });
        expect(second.compacted).toBe(true);
        expect(second.tracking.compacted).toBe(true);
        expect(second.tracking.consecutiveFailures).toBe(0);
        expect(readAutoCompactTracking(ledger)?.consecutiveFailures).toBe(0);
        // tracking 行里同时带着"上次压缩是哪一次"（turnId = 边界 uuid），供 recompaction 判定
        expect(lastCompactionId(ledger)).not.toBe("");
        expect(readAutoCompactTracking(ledger)?.turnId).toBe(lastCompactionId(ledger));
    });
});

/** 台账里最后一次压缩的 compactionId（= 边界标记 uuid） */
function lastCompactionId(ledger: ContextLedger): string {
    const rows = ledger.listEvents().filter((e) => e.type === CONTEXT_EVENTS.compacted);
    return String((rows.at(-1)?.payload as { compactionId?: string })?.compactionId ?? "");
}

// ============================================================
describe("接线 / 越阻塞线 → 不发、不截断，走既有问人站", () => {
    it("★ 越阻塞线的那一轮**不发请求**，只落台账（blocked 由节点转成问人）", async () => {
        const ledger = ledgerFor();
        const captured: unknown[][] = [];
        const llm = loopLlm(captured);
        const loop = await runToolLoop({
            llm, tools: bigOutputTools(), ctx: ctx(), ledger,
            system: "s", task: "t", skill: null, maxSteps: 6,
            // 极小窗口 + **没有摘要口**（Fake 客户端天然没有 summarize）：
            // 第一条结果进来就越线，且压不动 → 只能问人
            contextBudget: { model: "tiny", settingsWindowTokens: 1, env: {} },
        });
        expect(loop.context.blocked).not.toBeNull();
        expect(loop.context.blocked?.detail).toContain("CONTEXT_OVERFLOW");
        expect(loop.context.blocked?.detail).toContain("这一条请求**不发**");
        expect(llm.calls()).toBe(1);                               // ★ 越窗那条请求没有发出去
        // 也没有"截断历史凑合发"这种事：history 里没有任何折叠/裁剪痕迹
        expect(captured.length).toBe(1);
        const rows = ledger.listEvents().filter((e) => e.type === CONTEXT_EVENTS.requestBlocked);
        expect(rows.length).toBe(1);
        const p = rows[0]?.payload as Record<string, unknown>;
        expect(p["blockingLimit"]).toBe(getBlockingLimit(loop.context.blocked!.window));
        expect(p["compactedThisRound"]).toBe(false);
        expect(ledger.listEvents().some((e) => e.type === "history_folded")).toBe(false);   // 旧折叠已退役
    });

    it("★ 图里跑一遍：越窗 → state.contextBlocked → escalate 组题 → waiting_human", async () => {
        const ledger = ledgerFor();
        let calls = 0;
        const llm: DeveloperLlm = {
            id: "tiny-fake",
            calls: () => calls,
            next: async () => { calls++; return { kind: "tool", tool: "readFile", args: { path: "a.ts" } }; },
        };
        const tools = {
            describe: () => [{ name: "readFile", description: "d", parameters: {} }],
            names: () => ["readFile"],
            invoke: async () => ({ ok: true, output: "ok" }),
        } as unknown as ToolRegistry;
        const port: MessagePort = {
            send: () => "wake",
            receive: async () => ({ status: "invalid", error: "无消息", sender: null }),
        };
        const graph = buildDeveloperGraph({
            workspace, tools, ledger, port, llm, trustedTestAgents: ["test-core"],
            // 极小窗口 → 第一轮之后必然越阻塞线，且没有摘要口
            contextBudget: { model: "tiny", settingsWindowTokens: 1, env: {} },
        });
        const final = await graph.invoke(initialDeveloperState({
            projectId: "p1", taskId: "t1", runId: "r1", projectDir: root,
            allowedRoots: ["backend", "frontend"], messages: [taskFixture()],
        })) as DeveloperState;

        expect(final.status).toBe("waiting_human");                 // 既有问人态，不是终态
        expect(final.human).not.toBeNull();
        expect(final.human?.questionId).toContain("CONTEXT_OVERFLOW");
        // 四段模板：人拿到的是"能决策的问题"，不是一句"失败了"
        expect(final.human?.prompt ?? "").toContain("我在做什么");
        expect(final.human?.prompt ?? "").toContain("我试过什么");
        expect(final.human?.prompt ?? "").toContain("我判断的问题");
        expect(final.human?.prompt ?? "").toContain("需要你决定什么");
        expect(final.contextBlocked).toContain("CONTEXT_OVERFLOW");
        const events = ledger.listEvents().map((e) => e.type);
        expect(events).toContain(CONTEXT_EVENTS.requestBlocked);
        expect(events).toContain("escalation_asked");

        // 驱动侧（index.invokeWithHuman 的同款形状）：回填 humanAnswer 复活。
        //   ★ 答案是**被消费**的（escalationsUsed+1、标记清空后重新判定）：
        //     窗口没变，所以下一轮还会再撞同一条线、再问一次——这是如实行为，
        //     真正的解法是填对窗口（人在答案里说"停"就直接收口）。
        const resumed = await graph.invoke(
            initialDeveloperState({ ...final, humanAnswer: "1" }),
        ) as DeveloperState;
        expect(resumed.escalationsUsed).toBe(1);
        expect(ledger.listEvents().some((e) => e.type === "escalation_answered")).toBe(true);
        expect(resumed.human).not.toBeNull();                       // 墙还在 → 又问了一次（有界：maxEscalations）
    });

    it("人判停 → 收口成 blocked（越窗标记一并清掉，不留悬空字段）", async () => {
        const ledger = ledgerFor();
        const llm: DeveloperLlm = {
            id: "tiny-fake-2",
            calls: () => 1,
            next: async () => ({ kind: "tool", tool: "readFile", args: { path: "a.ts" } }),
        };
        const tools = {
            describe: () => [{ name: "readFile", description: "d", parameters: {} }],
            names: () => ["readFile"],
            invoke: async () => ({ ok: true, output: "ok" }),
        } as unknown as ToolRegistry;
        const port: MessagePort = {
            send: () => "wake",
            receive: async () => ({ status: "invalid", error: "无消息", sender: null }),
        };
        const graph = buildDeveloperGraph({
            workspace, tools, ledger, port, llm, trustedTestAgents: ["test-core"],
            contextBudget: { model: "tiny", settingsWindowTokens: 1, env: {} },
        });
        const asked = await graph.invoke(initialDeveloperState({
            projectId: "p1", taskId: "t1", runId: "r2", projectDir: root,
            allowedRoots: ["backend", "frontend"], messages: [taskFixture()],
        })) as DeveloperState;
        expect(asked.status).toBe("waiting_human");
        const stopped = await graph.invoke(
            initialDeveloperState({ ...asked, humanAnswer: "停止：按现状收尾" }),
        ) as DeveloperState;
        expect(stopped.status).toBe("blocked");
        expect(stopped.human).toBeNull();
        expect(stopped.contextBlocked).toBeNull();
    });

    it("纯函数层：越线判定只看窗口（同一用量，小窗口 blocked、大窗口 send）", () => {
        const used = 50_000;
        const tiny = resolveWiredContextWindow({ model: "m", settingsWindowTokens: 40_000, env: {} });
        const huge = resolveWiredContextWindow({ model: "m", settingsWindowTokens: 1_000_000, env: {} });
        expect(planContextAction({ used, window: tiny, canSummarize: false })).toBe("blocked");
        expect(planContextAction({ used, window: huge, canSummarize: false })).toBe("send");
        // 有摘要口时先压，而不是直接 blocked
        expect(planContextAction({ used, window: tiny, canSummarize: true })).toBe("compact");
    });
});

// ============================================================
// 图测试用的最小任务包
// ============================================================
function taskFixture(): ArchitectTask {
    return {
        type: "architect_task", projectId: "p1", taskId: "t1",
        requirementSnapshot: { goal: "接线验收" },
        stackProfile: { frontend: "vue3", backend: "spring-boot" },
        domainModel: { entity: "note", table: "note", fields: [] },
        contract: { version: "1", endpoints: [] },
        foundationPlan: { dirs: ["backend"], workItems: [{ id: "w1", kind: "backend" }] },
        allowedRoots: ["backend", "frontend"],
        forbiddenPaths: [],
        acceptanceChecks: [],
        developerInstructions: "按计划实现",
    };
}
