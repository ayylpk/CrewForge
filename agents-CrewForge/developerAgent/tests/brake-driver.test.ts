// tests/brake-driver.test.ts —— 刹车的**驱动环集成**：到检查点就静默问人、按答案继续或保状态退出
//
//   纯函数边界在 brake.test.ts 里钉；这里证明的是**老板最在意的三件事**：
//     (a) 人答「继续」→ 驱动环**真的又跑起来了**，账本有 brake_extended（加时不是空话）；
//     (b) 没人答 → 运行**结束但不判死**：不 abortRun、不落 blocked/failed，
//         task_state 留在 waiting_human（非终态、可续跑），账本有 brake_paused + 完整进展报告；
//     (c) ★ 最要紧的那条：**下一次拉起来**用同一份账本、问**同一道题**（题号幂等），
//         人停机期间答过的答案被**消费掉**，工作接着干下去。
//         这就是老板说的"任务信息保留，下次可以继续接着拉起来进程"。
//
//   另外钉住：
//     · 无人值守（AUTO_CONFIRM=1）模式下撞到天花板才自保收口（Web 跑法没有这条死路）；
//     · 问不出去（问答器抛异常）也走保状态退出，**绝不崩、绝不判死**；
//     · 到检查点时**一次消息都不再消费**（先停手问人，不边问边烧钱）。
//
//   假 handle 只实现驱动环要用到的几件事（ledger / serveOnce / blockUnverified / abortRun /
//   inspectTaskState / shutdown），假问答器按脚本作答——**零 LLM、零网络、零浏览器**。
import { afterAll, afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { DeveloperLedger } from "../ledger";
import {
    brakeOptions, brakeQuestion, checkBrake, findBrakePause, grantBrakeExtension, parseBrakeAnswer,
    resolveBrakePolicy, type BrakePolicy, type BrakeQuestioner, type BrakeStatus,
} from "../brake";
import {
    brakeCheckpoint, brakeFinalized, buildBriefFor, driveToTerminal, isBrakeStopRequested,
    lastBrakePause, requestBrakeStop, resetBrakeStopForTest, resumeBriefText, summaryOf,
    taskWithBrief, waitForBrakeStop, type BrakeRound,
} from "../../developerTeamRunner";
import { RESUME_BRIEF_CLIP } from "../brake";
import type { DeveloperAgentHandle, DeveloperState } from "../index";
import { cleanupTempDirsAfterTests, tmpDir } from "./_tmp";

/**
 * 临时目录走 `_tmp.ts` 的登记式清理（**这个文件原先是个漏点**：`mkdtempSync` 直接建在
 * %TEMP% 根下、只靠 `process.on("exit")` 收尾——而 `bun test` 里 exit/beforeExit 钩子
 * **永不执行**，于是每跑一次就漏 1.8MB 的 `cf-dev-brake-*`）。
 *   ⚠️ 清理顺序不能反：先关账本（这些用例建真 sqlite，开着库删树在 Windows 上必 EBUSY），
 *   再交给 `_tmp.ts` 删树（带重试/退避/大超时）。bun 的钩子按注册顺序跑，
 *   所以 `cleanupTempDirsAfterTests()` 必须写在下面那个 `afterAll` **之后**。
 */
const root = tmpDir("cf-dev-brake");
const opened: DeveloperLedger[] = [];
let seq = 0;

afterEach(() => { resetBrakeStopForTest(); });

function ledgerFor(name?: string): DeveloperLedger {
    const l = DeveloperLedger.open(path.join(root, `${name ?? `brake-${seq++}`}.db`), "p1:t1");
    opened.push(l);
    return l;
}

// ⚠️ 顺序敏感（见文件头说明）：先关账本 → 再让 _tmp.ts 删树。两行不能再颠倒。
afterAll(() => {
    for (const l of opened) { try { l.close(); } catch { /* 已关 */ } }
});
cleanupTempDirsAfterTests();

/** 时长夹具（分钟 → 毫秒；checkBrake 吃的是 elapsedMs） */
const mins = (n: number): number => n * 60_000;

/**
 * 造一个 policy：默认档（SOFT 120 分钟 / 400 调）+ 指定的已跑时长 + 指定等待窗口。
 *   · unattended 默认 false（Web/手工跑法）——**没有天花板**，越过它也只是继续问人；
 *   · waitMs 给很短（测试里不真等 30 分钟）。
 */
function cfgPolicy(opts: {
    elapsedMinutes: number; waitMs?: number; unattended?: boolean;
    hardWallMinutes?: number; maxLlmCalls?: number;
}): BrakePolicy {
    const p = resolveBrakePolicy({}, Date.now() - mins(opts.elapsedMinutes));
    return {
        ...p,
        hardWallMs: mins(opts.hardWallMinutes ?? 180),
        waitMs: opts.waitMs ?? 60,
        ...(opts.unattended !== undefined ? { unattended: opts.unattended } : {}),
        ...(opts.maxLlmCalls !== undefined ? { maxLlmCalls: opts.maxLlmCalls, initialMaxLlmCalls: opts.maxLlmCalls } : {}),
    };
}

/** 已过 SOFT（120 分钟）的夹具：到检查点，该问人了 */
const expiredPolicy = (waitMs = 60): BrakePolicy => cfgPolicy({ elapsedMinutes: 121, waitMs });

/** 墙钟很远的夹具（只有调用数闸可能触发） */
const freshPolicy = (maxLlmCalls: number): BrakePolicy => cfgPolicy({ elapsedMinutes: 1, maxLlmCalls });

interface ScriptedQuestioner extends BrakeQuestioner {
    asked: () => { questionId: string }[];
}

/**
 * 脚本化假问答器：
 *   · `answers` 非空 → 按序作答（用完最后一个就一直重复它）；
 *   · `answers` 为空 → "一直在轮询"（永不 resolve），即 Web 跑法里没人点气泡卡 →
 *     askBrakeQuietly 会在 waitMs 后安静超时；
 *   · `throwOnce` → 指定次序的那一次抛异常（模拟 Java 不可达）。
 */
function fakeQuestioner(answers: string[] = [], opts: { throwOnce?: number } = {}): ScriptedQuestioner {
    let i = 0;
    const asked: { questionId: string }[] = [];
    return {
        asked: () => asked,
        ask: (q) => {
            asked.push({ questionId: q.questionId });
            const n = i++;
            if (opts.throwOnce !== undefined && n === opts.throwOnce) {
                return Promise.reject(new Error("Java 不可达（假件）"));
            }
            if (answers.length === 0) return new Promise<string>(() => { /* 永远等一下去 */ });
            const a = answers[Math.min(n, answers.length - 1)];
            return Promise.resolve(a ?? "");
        },
    };
}

interface Stub {
    handle: DeveloperAgentHandle;
    ledger: DeveloperLedger;
    /** serveOnce 被调了几次（= 又消费了一条消息） */
    served: () => number;
    /** blockUnverified 被调了几次（保状态退出路径上必须是 0） */
    blockedUnverified: () => number;
    /** abortRun 收到的原因（null = 从未调用） */
    aborted: () => string | null;
    state: DeveloperState;
}

/**
 * 假 handle：serveOnce 每次"像图一样"把 llmCallsCompleted 往账本里推 +1，
 * 并返回一个非终态快照——模拟"图一直在干活、但进度已经追上检查点"的形态。
 */
function stub(cfg: {
    status?: string;
    llmCalls?: number;
    callsPerServe?: number;
    workItems?: { id: string; kind: string; done: boolean; arrived: boolean }[];
    changedFiles?: string[];
    /** 第 N 次 serveOnce 之后把账本落成 ready（模拟图自己走到终态） */
    stopAfter?: number;
    ledger?: DeveloperLedger;
} = {}): Stub {
    const ledger = cfg.ledger ?? ledgerFor();
    let calls = cfg.llmCalls ?? 0;
    const perServe = cfg.callsPerServe ?? 1;
    const workItems = cfg.workItems ?? [
        { id: "w1", kind: "backend", done: true, arrived: true },
        { id: "w2", kind: "frontend", done: false, arrived: true },
    ];
    const changedFiles = cfg.changedFiles ?? ["backend/src/A.java"];
    let served = 0;
    let aborted: string | null = null;
    let blockedUnverified = 0;
    const persist = (status: string): void => {
        ledger.saveState({
            taskId: "t1", status,
            repairAttempts: 0, failureSignatures: [], changedFiles, llmCalls: calls,
        });
    };
    if (cfg.llmCalls !== undefined) persist(cfg.status ?? "implementing");
    const state = {
        taskId: "t1", runId: "t1", status: cfg.status ?? "implementing",
        llmCallsCompleted: calls, llmCallsPlanned: 0, toolCalls: 0, repairAttempts: 0,
        changedFiles, workItems, completedWorkItems: workItems.filter((w) => w.done).map((w) => w.id),
        arrivedItems: workItems.map((w) => w.id), acceptanceChecks: [], failureSignatures: [],
        correlationId: null, testDeadlineAt: null, human: null,
    } as unknown as DeveloperState;
    const handle = {
        ledger,
        serveOnce: async (): Promise<DeveloperState> => {
            served++;
            calls += perServe;
            if (cfg.stopAfter !== undefined && served >= cfg.stopAfter) {
                persist("ready");
                return { ...state, status: "ready" } as DeveloperState;
            }
            persist("implementing");
            return state;
        },
        blockUnverified: async (): Promise<DeveloperState> => { blockedUnverified++; return state; },
        abortRun: async (reason: string): Promise<DeveloperState> => {
            aborted = reason;
            persist("blocked");
            ledger.appendEvent("run_aborted", { reason });
            return { ...state, status: "blocked", error: `[ABORTED] ${reason}` } as DeveloperState;
        },
        inspectTaskState: () => ({
            taskId: "t1", runKey: ledger.runKey, status: "implementing",
            correlationId: null, testDeadlineAt: null, testWaitOverdue: false,
            repairAttempts: 0, failureSignatures: [], changedFiles,
            llmCallsPlanned: 0, llmCallsCompleted: calls, toolCalls: 3, subagentCalls: 0,
            workItems, lastCheckpoint: null, activeProcesses: 0,
            sandbox: { mode: "soft", backend: "local", realIsolation: false, softIsolation: true },
        }),
        shutdown: async (): Promise<void> => { /* 假件：无进程可清 */ },
        close: (): void => { /* 假件：无句柄可关 */ },
    } as unknown as DeveloperAgentHandle;
    return {
        handle, ledger, served: () => served,
        blockedUnverified: () => blockedUnverified, aborted: () => aborted, state,
    };
}

const newRound = (n = 1): BrakeRound => ({ n });

// ============================================================
// (a) 到检查点只返回"该问人了"——不 abort、不落终态
// ============================================================
describe("驱动环·到检查点只是问人（不是判死）", () => {
    it("★ 越过 SOFT → 返回 ask（一次消息都不再消费），**绝不 abortRun、绝不落下终态**", async () => {
        const s = stub({ llmCalls: 147 });
        const out = await driveToTerminal(s.handle, expiredPolicy(), 400, newRound());
        expect(out.kind).toBe("ask");
        if (out.kind !== "ask") throw new Error("unreachable");
        expect(out.status.reason).toBe("wall_clock");
        expect(s.served()).toBe(0);                       // ★ 先停手问人，不边问边烧钱
        expect(s.aborted()).toBeNull();                   // ★ 不杀
        expect(s.ledger.loadState()?.status).toBe("implementing");   // ★ 不是 blocked/failed
    });

    it("★ Web/手工跑法越过 CF_HARD_WALL_MINUTES 也**不 hard**（不杀了）", async () => {
        const s = stub({ llmCalls: 147 });
        const policy = cfgPolicy({ elapsedMinutes: 400, hardWallMinutes: 180 });   // 天花板 180，已跑 400
        const out = await driveToTerminal(s.handle, policy, 400, newRound());
        expect(out.kind).toBe("ask");
        if (out.kind !== "ask") throw new Error("unreachable");
        expect(out.status.hard).toBe(false);
        expect(s.aborted()).toBeNull();
    });

    it("终态仍在账本里 → 先认终态（问人不许把已有结论改写成「超时」）", async () => {
        const s = stub({ status: "ready", llmCalls: 0 });
        const ask = fakeQuestioner(["1"]);
        const out = await driveToTerminal(s.handle, expiredPolicy(), 400, newRound());
        expect(out.kind).toBe("terminal");
        expect(s.served()).toBe(0);
        expect(ask.asked().length).toBe(0);                  // 有结论就不打扰人
    });

    it("墙钟没到 + 额度没用完 → 正常消费消息（闸门不是「一律停」的误伤器）", async () => {
        const s = stub({ stopAfter: 3 });
        const out = await driveToTerminal(s.handle, freshPolicy(400), 400, newRound());
        expect(out.kind).toBe("terminal");
        expect(s.served()).toBe(3);
    });
});

// ============================================================
// (a) 人答"继续" → 加时 → 驱动环真的又跑起来
// ============================================================
describe("驱动环·(a) 人答继续 → 加时 → **接着驱动**", () => {
    it("★ 核心：答「1 继续」→ 加时前移期限 → 驱动环再跑一轮，账本落 brake_extended", async () => {
        const s = stub({ llmCalls: 147, stopAfter: 1 });
        const ask = fakeQuestioner(["1"]);
        const policy = expiredPolicy();
        const round = newRound();

        // 第一轮：到检查点
        const first = await driveToTerminal(s.handle, policy, 400, round);
        expect(first.kind).toBe("ask");
        if (first.kind !== "ask") throw new Error("unreachable");
        // 问 + 静默等（人答了"继续"）→ "continue"
        const step = await brakeCheckpoint(s.handle, first.status, policy, 400, ask, round);
        expect(step).toBe("continue");
        expect(policy.extensionsUsed).toBe(1);

        // ★ 加时之后**再驱动一轮**：这次图走到了终态
        const second = await driveToTerminal(s.handle, policy, 400, round);
        expect(second.kind).toBe("terminal");                // ★ 接着开工了，不是"刹车收口"
        expect(s.served()).toBe(1);                          // 加了时之后又消费了一条
        expect(s.aborted()).toBeNull();                      // 全程没有 abort

        // 账本证据
        const ev = s.ledger.listEvents().find((e) => e.type === "brake_extended");
        expect(ev).toBeDefined();
        const payload = ev!.payload as Record<string, unknown>;
        expect(payload["questionId"]).toBe("brake-t1-1");    // 题号确定
        expect(payload["round"]).toBe(1);
        expect(payload["addMinutes"]).toBe(policy.extendMinutes);
        expect(payload["index"]).toBe(1);
        expect(Number(payload["deadlineAt"])).toBeGreaterThan(Date.now());   // ★ 新期限在未来
        expect(String(payload["answer"])).toContain("extend");
        expect(ask.asked().length).toBe(1);
        // 问人这一步也留了痕
        expect(s.ledger.listEvents().some((e) => e.type === "wall_clock_exceeded")).toBe(true);
    });

    it("题面带**真数字**（人不能从「超时了」做决定）：账目、等待窗口、不答会怎样，都在题里", async () => {
        const s = stub({ llmCalls: 147, stopAfter: 1 });
        const ask = fakeQuestioner(["1"]);
        const policy = expiredPolicy(30 * 60_000);
        const round = newRound();
        const first = await driveToTerminal(s.handle, policy, 400, round);
        if (first.kind !== "ask") throw new Error("unreachable");
        // 题的形状由同参数的 brakeQuestion 直接验证（假问答器拿到的就是它）
        const q = brakeQuestion(first.status, summaryOf(s.handle, first.status, policy, 400), 1);
        expect(q.questionId).toBe("brake-t1-1");
        expect(q.prompt).toContain("【账目】");
        expect(q.prompt).toContain("121.0 分钟/120.0 分钟");
        expect(q.prompt).toContain("147/400 调");
        expect(q.prompt).toContain("工作项：1/2 完成");
        expect(q.prompt).toContain("剩余 1/2 个工作项（w2）");
        expect(q.prompt).toContain("停手等你 30 分钟");
        expect(q.prompt).toContain("零模型调用、零写盘");
        expect(q.prompt).toContain("加时 30 分钟接着干");
        // 真问答器确实收到了这道题（问了一次）
        await brakeCheckpoint(s.handle, first.status, policy, 400, ask, round);
        expect(ask.asked()[0]?.questionId).toBe("brake-t1-1");
    });

    it("人答「y」（AUTO_CONFIRM=1 与默认答案）→ 也走继续这条路", async () => {
        const s = stub({ llmCalls: 147, stopAfter: 1 });
        const policy = expiredPolicy();
        const round = newRound();
        const first = await driveToTerminal(s.handle, policy, 400, round);
        if (first.kind !== "ask") throw new Error("unreachable");
        expect(await brakeCheckpoint(s.handle, first.status, policy, 400, fakeQuestioner(["y"]), round)).toBe("continue");
        expect(s.ledger.listEvents().some((e) => e.type === "brake_extended")).toBe(true);
        expect(parseBrakeAnswer("y").action).toBe("extend");
    });

    it("人答自由文本 → 继续，原话落账本 brake_guidance（人的指示是新的输入）", async () => {
        const s = stub({ llmCalls: 147, stopAfter: 1 });
        const policy = expiredPolicy();
        const round = newRound();
        const first = await driveToTerminal(s.handle, policy, 400, round);
        if (first.kind !== "ask") throw new Error("unreachable");
        await brakeCheckpoint(s.handle, first.status, policy, 400, fakeQuestioner(["先把登录页跑通再说"]), round);
        const ev = s.ledger.listEvents().find((e) => e.type === "brake_guidance");
        expect(ev).toBeDefined();
        expect((ev!.payload as { text: string }).text).toBe("先把登录页跑通再说");
    });

    it("可反复加时（**没有次数上限**）：每一跳都记一次 brake_extended，题号逐跳递增", async () => {
        const s = stub({ llmCalls: 147 });
        const policy = expiredPolicy();
        const round = newRound();
        const ask = fakeQuestioner(["1"]);
        for (let i = 1; i <= 3; i++) {
            const out = await driveToTerminal(s.handle, policy, 400, round);
            expect(out.kind).toBe("ask");
            if (out.kind !== "ask") throw new Error("unreachable");
            expect(await brakeCheckpoint(s.handle, out.status, policy, 400, ask, round)).toBe("continue");
            // 让墙钟再越一次点：把期限按"已经跑过头"的方式收回（等价于又跑满了这一跳）
            policy.startedAt -= mins(31);
            expect(checkBrake(policy, { callsCompleted: 147, elapsedMs: Date.now() - policy.startedAt }).tripped).toBe(true);
        }
        expect(policy.extensionsUsed).toBe(3);
        expect(round.n).toBe(4);                              // 已经问过 3 次，下一次是第 4 道题
        const ids = s.ledger.listEvents()
            .filter((e) => e.type === "brake_extended")
            .map((e) => (e.payload as { questionId: string }).questionId);
        expect(ids).toEqual(["brake-t1-1", "brake-t1-2", "brake-t1-3"]);
    });
});

// ============================================================
// (b) 没人答 → 保状态退出（不判死）+ (c) 下次拉起来消费答案继续
// ============================================================
describe("驱动环·(b) 等不到确认 → 保状态退出（任务信息保留，不判死）", () => {
    it("★ 不 abortRun / 不 blockUnverified / 不落 blocked：状态留 waiting_human，账本落 brake_paused + 进展报告", async () => {
        // 每一轮用例用**独立账本文件**（下一条用例要拿同一份账本"重新拉起进程"）
        const ledger = ledgerFor("paused-resume");
        const s = stub({ llmCalls: 147, ledger });
        const policy = expiredPolicy(80);
        const round = newRound();
        const silent = fakeQuestioner([]);                    // 永远不答（Web 气泡卡没人点）

        const out = await driveToTerminal(s.handle, policy, 400, round);
        expect(out.kind).toBe("ask");
        if (out.kind !== "ask") throw new Error("unreachable");

        const t0 = Date.now();
        const step = await brakeCheckpoint(s.handle, out.status, policy, 400, silent, round);
        expect(step).toBe("paused");                          // ★ 不是 "stopped"、更不是抛错
        expect(Date.now() - t0).toBeGreaterThanOrEqual(70);   // 真的等满了窗口（安静地等）
        expect(Date.now() - t0).toBeLessThan(3_000);

        // ① 不判死：这条路径上**一次都没有** abort / blockUnverified
        expect(s.aborted()).toBeNull();
        expect(s.blockedUnverified()).toBe(0);
        // ② 非终态、可续跑：复用 waiting_human（不是 blocked/failed/cancelled）
        const snap = s.ledger.loadState();
        expect(snap?.status).toBe("waiting_human");
        expect(["blocked", "failed", "cancelled"]).not.toContain(snap?.status ?? "");
        // ③ 账本留下 brake_paused + 完整进展报告（下次拉起来靠它）
        const paused = s.ledger.listEvents().find((e) => e.type === "brake_paused");
        expect(paused).toBeDefined();
        const pl = paused!.payload as Record<string, unknown>;
        expect(pl["questionId"]).toBe("brake-t1-1");
        expect(pl["round"]).toBe(1);
        expect(String(pl["text"])).toContain("【已完成】工作项 1/2");
        expect(String(pl["text"])).toContain("【还差什么】1/2 个工作项未完成：w2");
        expect(String(pl["text"])).toContain("【证据】");
        expect(pl["changedFiles"]).toBe(1);
        expect(pl["callsCompleted"]).toBe(147);
        expect(String(pl["reason"])).toBe("wall_clock");
        // ④ 题**没有**被清掉：账本里还留着这道题的题号（下次问同一道）
        expect(s.ledger.listEvents().some((e) => e.type === "run_aborted")).toBe(false);
        // ⑤ 进程收工信号已置位（projectRunner 靠它干净退出）
        expect(isBrakeStopRequested()).toBe(true);
    });

    it("★ (c) 下一次拉起来：同一份账本 + **同一道题**，人停机期间答的答案被消费 → 接着干", async () => {
        // ===== 第 1 次运行：等不到人 → 保状态退出 =====
        const ledger = ledgerFor("resume-work");
        const run1 = stub({ llmCalls: 147, ledger });
        const policy1 = expiredPolicy(60);
        const round1 = newRound();
        const first = await driveToTerminal(run1.handle, policy1, 400, round1);
        if (first.kind !== "ask") throw new Error("unreachable");
        expect(await brakeCheckpoint(run1.handle, first.status, policy1, 400, fakeQuestioner([]), round1)).toBe("paused");
        expect(ledger.loadState()?.status).toBe("waiting_human");
        const pausedEv = ledger.listEvents().find((e) => e.type === "brake_paused")!;
        const pausedQ = (pausedEv.payload as { questionId: string }).questionId;
        expect(pausedQ).toBe("brake-t1-1");

        // ===== 第 2 次运行（"下次把进程重新拉起来"）：同一份账本，人已经答过"继续" =====
        resetBrakeStopForTest();                              // 新进程 = 新的收工信号
        const run2 = stub({ llmCalls: 147, stopAfter: 1, ledger });
        const policy2 = cfgPolicy({ elapsedMinutes: 121, waitMs: 60 });
        const resume = lastBrakePause(run2.handle);           // ★ 从 brake_paused 恢复轮次
        expect(resume).toEqual({ round: 1, questionId: "brake-t1-1" });
        const round2 = newRound(resume!.round);

        const out2 = await driveToTerminal(run2.handle, policy2, 400, round2);
        expect(out2.kind).toBe("ask");
        if (out2.kind !== "ask") throw new Error("unreachable");
        // 人在停机期间答的答案：第二次问的是**同一道题**（题号幂等，HttpQuestioner 直接取到答案）
        const answeredOffline = fakeQuestioner(["1"]);
        expect(await brakeCheckpoint(run2.handle, out2.status, policy2, 400, answeredOffline, round2)).toBe("continue");
        expect(answeredOffline.asked()[0]?.questionId).toBe(pausedQ);   // ★ 同一个题号

        // 消费了那个答案 → 加时 → 驱动环继续，并且走到了终态
        const after = await driveToTerminal(run2.handle, policy2, 400, round2);
        expect(after.kind).toBe("terminal");                  // ★ 工作接着干下去了
        expect(run2.served()).toBe(1);
        expect(policy2.extensionsUsed).toBe(1);

        // 账本：同一道题被加时（题号与停机时那道题一致）
        const ext = ledger.listEvents().filter((e) => e.type === "brake_extended");
        expect(ext.length).toBe(1);
        expect((ext[0]!.payload as { questionId: string }).questionId).toBe(pausedQ);
        // 全程没有 abort、没有 blocked
        expect(run2.aborted()).toBeNull();
        expect(ledger.loadState()?.status).not.toBe("blocked");
    });

    it("问不出去（Java 不可达）→ 一样是**保状态退出**，绝不崩、绝不判死", async () => {
        const ledger = ledgerFor("ask-failed");
        const s = stub({ llmCalls: 147, ledger });
        const policy = expiredPolicy(60);
        const round = newRound();
        const out = await driveToTerminal(s.handle, policy, 400, round);
        if (out.kind !== "ask") throw new Error("unreachable");
        // throwOnce=0 → 第一次 ask 直接抛（不是超时）
        const step = await brakeCheckpoint(s.handle, out.status, policy, 400, fakeQuestioner([], { throwOnce: 0 }), round);
        expect(step).toBe("paused");
        const paused = ledger.listEvents().find((e) => e.type === "brake_paused")!;
        expect(String((paused.payload as { askFailed: string }).askFailed)).toContain("Java 不可达");
        expect(ledger.loadState()?.status).toBe("waiting_human");
        expect(s.aborted()).toBeNull();
    });

    it("问答器根本没装配（null）→ 同一条路：保状态退出", async () => {
        const ledger = ledgerFor("no-questioner");
        const s = stub({ llmCalls: 147, ledger });
        const policy = expiredPolicy(60);
        const round = newRound();
        const out = await driveToTerminal(s.handle, policy, 400, round);
        if (out.kind !== "ask") throw new Error("unreachable");
        expect(await brakeCheckpoint(s.handle, out.status, policy, 400, null, round)).toBe("paused");
        const paused = ledger.listEvents().find((e) => e.type === "brake_paused")!;
        expect(String((paused.payload as { askFailed: string }).askFailed)).toContain("问答器未装配");
        expect(s.aborted()).toBeNull();
    });
});

// ============================================================
// 人的另两个答案 + 无人值守天花板（唯一会收口的两条路）
// ============================================================
// ============================================================
// 进程收工信号：projectRunner.drivePhases 靠它从"无限等下一条 phase_request"里醒过来
// ============================================================
describe("驱动环·保状态退出时**进程真的会收工**（不然又会被外层超时杀掉）", () => {
    it("★ 没人答 → requestBrakeStop() 把 waitForBrakeStop() 唤醒（drivePhases 的 race 靠这条）", async () => {
        resetBrakeStopForTest();
        expect(isBrakeStopRequested()).toBe(false);
        let woke = false;
        const waiting = waitForBrakeStop().then(() => { woke = true; });
        expect(woke).toBe(false);                      // 还没人叫停：一直等着（等价于 drivePhases 的死等）
        // 保状态退出路径会调用它（pauseBrake 的最后一步）
        const s = stub({ llmCalls: 147 });
        const policy = expiredPolicy(60);
        const round = newRound();
        const out = await driveToTerminal(s.handle, policy, 400, round);
        if (out.kind !== "ask") throw new Error("unreachable");
        expect(await brakeCheckpoint(s.handle, out.status, policy, 400, null, round)).toBe("paused");
        await waiting;                                 // 唤醒后 drivePhases 就能 return "paused" 干净退出
        expect(woke).toBe(true);
        expect(isBrakeStopRequested()).toBe(true);
    });

    it("信号幂等：第二次请求返回 false（多圈/多任务不会重复触发收工）", () => {
        resetBrakeStopForTest();
        expect(requestBrakeStop()).toBe(true);       // 第一次：真的触发了
        expect(requestBrakeStop()).toBe(false);      // 之后：已是"该收工"，不重复
        expect(isBrakeStopRequested()).toBe(true);
        resetBrakeStopForTest();
        expect(isBrakeStopRequested()).toBe(false);
    });
});

// ============================================================
// 老板口径：**保留决策，不保留原始对话**
//   preserve = 计划/进度 + 验收基线 + 人的答案与指引 + 幂等/记账状态 + 暂停记录
//   不保留 = 原始 transcript（由 renderTask 每轮重渲染任务书；
//            人给了新指令后旧对话的假设反而是错的）
// 替换物 = resume brief（几行、有界、从账本生成），续跑时拼进 DeveloperInstructions
// ============================================================
describe("保留决策·(a) 暂停→重启：状态、基线、计数、幂等缓存都活下来", () => {
    it("★ 已完成一次的工具调用在续跑时**不再执行**（幂等缓存跨暂停/跨运行生效）", async () => {
        const ledger = ledgerFor("preserve-cache");
        const key = "writeFile:backend/src/A.java:deadbeef";
        // 暂停之前的运行：确实执行过一次（首次 → true）
        expect(ledger.recordToolCallOnce(key, "writeFile", true, "ok", { path: "backend/src/A.java" })).toBe(true);
        const before = ledger.loadState();

        // 暂停（账本与缓存都不动）
        const s = stub({ llmCalls: before?.llmCalls ?? 0, ledger });
        const policy = expiredPolicy(60);
        const round = newRound();
        const out = await driveToTerminal(s.handle, policy, 400, round);
        if (out.kind !== "ask") throw new Error("unreachable");
        expect(await brakeCheckpoint(s.handle, out.status, policy, 400, null, round)).toBe("paused");
        expect(ledger.loadState()?.status).toBe("waiting_human");
        // ★ 缓存没有因为暂停被清掉（同一个 db 文件、同一张 completed_tool_call 表）
        expect(ledger.cachedToolCall(key)).not.toBeNull();
        expect(ledger.recordToolCallOnce(key, "writeFile", true, "ok", {})).toBe(false);   // ← 不再执行

        // ===== 下次把进程重新拉起来（同一份账本文件）=====
        resetBrakeStopForTest();
        const ledger2 = DeveloperLedger.open(path.join(root, "preserve-cache.db"), "p1:t1");
        opened.push(ledger2);
        const cached = ledger2.cachedToolCall(key);
        expect(cached).not.toBeNull();                                     // ★ 缓存活着
        expect(cached!.toolName).toBe("writeFile");
        expect(ledger2.recordToolCallOnce(key, "writeFile", true, "ok", {})).toBe(false); // ★ 幂等：不重做
        // 计数与改动文件也在快照里活下来（task_state 的 llm_calls / changed_files_json）
        // 注：本用例的 stub 没写 llmCalls（before 为 null），所以只断言"重启后快照仍可读"这一条硬事实；
        //     计数跨暂停的具体数值由下一条「基线」用例与 runner 的 saveState 载荷覆盖。
        expect(ledger2.loadState()).not.toBeNull();
        expect(ledger2.loadState()?.taskId).toBe("t1");
        expect(ledger2.loadState()?.changedFiles).toEqual(["backend/src/A.java"]);
    });

    it("★ 验收判据基线（acceptance_criteria_status）跨暂停活着：下一轮不会退化成「首次预演」", async () => {
        const ledger = ledgerFor("preserve-baseline");
        // 上一次预演的结果（回归冻结基线）：2 绿 1 红
        ledger.appendEvent("acceptance_criteria_status", { status: { c1: "pass", c2: "pass", c3: "fail" } });
        const s = stub({ llmCalls: 147, ledger });
        const policy = expiredPolicy(60);
        const round = newRound();
        const out = await driveToTerminal(s.handle, policy, 400, round);
        if (out.kind !== "ask") throw new Error("unreachable");
        const status = out.status;
        const summary = summaryOf(s.handle, status, policy, 400);
        expect(summary.checksGreen).toBe(2);                       // 暂停这一刻的读数
        expect(summary.checksTotal).toBe(3);
        expect(await brakeCheckpoint(s.handle, status, policy, 400, null, round)).toBe("paused");
        // 暂停事件里钉住了基线（下一轮即使没有别的读数，也知道上次绿了几条）
        const paused = ledger.listEvents().find((e) => e.type === "brake_paused")!;
        const p = paused.payload as Record<string, unknown>;
        expect(p["checksGreen"]).toBe(2);
        expect(p["checksTotal"]).toBe(3);
        // 重启后基线仍然可读（graph.ts:1484 的 acceptanceMemory 就是从这里读的）
        const { acceptanceGreen } = await import("../brake");
        expect(acceptanceGreen(ledger.listEvents())).toEqual({ green: 2, total: 3 });
    });

    it("暂停记录里带**最近几次工具调用的短摘要**（保留决策、不放对话正文）", async () => {
        const ledger = ledgerFor("preserve-digest");
        ledger.recordToolCall({
            taskId: "t1", toolName: "writeFile", argumentsHash: "h1", resultHash: "r1",
            startedAt: 1, finishedAt: 2, exitCode: 0, changedFiles: ["backend/src/A.java"], ok: true,
        });
        ledger.recordToolCall({
            taskId: "t1", toolName: "runBuild", argumentsHash: "h2", resultHash: "r2",
            startedAt: 3, finishedAt: 4, exitCode: 1, changedFiles: [], ok: false,
        });
        const s = stub({ llmCalls: 147, ledger });
        const policy = expiredPolicy(60);
        const round = newRound();
        const out = await driveToTerminal(s.handle, policy, 400, round);
        if (out.kind !== "ask") throw new Error("unreachable");
        expect(await brakeCheckpoint(s.handle, out.status, policy, 400, null, round)).toBe("paused");
        const p = ledger.listEvents().find((e) => e.type === "brake_paused")!.payload as Record<string, unknown>;
        const digest = p["toolDigest"] as string[];
        expect(digest.length).toBe(2);
        expect(digest[0]).toContain("writeFile");
        expect(digest[0]).toContain("改了 1 文件");
        expect(digest[1]).toContain("✗ runBuild");
        // 摘要里**没有**参数/输出正文（那是 rawLogPath 的活，不是模型上下文）
        expect(JSON.stringify(digest)).not.toContain("h1");
        expect(JSON.stringify(digest)).not.toContain("r1");
    });
});

describe("保留决策·(c) resume brief：拼进任务书的那几行（从账本生成，无 transcript）", () => {
    it("★ 续跑时把 brief 拼进 DeveloperInstructions（任务书 {{developerInstructions}} 的落点）", async () => {
        const ledger = ledgerFor("brief-inject");
        // 造出"暂停过、人答过、有自由文本指引"的现场：
        // 先问一次（无人在场 → 暂停，这是账本里那条 brake_paused），
        // 再让"重新拉起来"的第二次问拿到人停机期间给的**自由文本**（非关键词 → extend + guidance）
        const s = stub({ llmCalls: 147, ledger });
        const policy = expiredPolicy(60);
        const round = newRound();
        const out = await driveToTerminal(s.handle, policy, 400, round);
        if (out.kind !== "ask") throw new Error("unreachable");
        expect(await brakeCheckpoint(s.handle, out.status, policy, 400, null, round)).toBe("paused");
        const out2 = await driveToTerminal(s.handle, policy, 400, round);
        if (out2.kind !== "ask") throw new Error("unreachable");
        expect(await brakeCheckpoint(s.handle, out2.status, policy, 400,
            fakeQuestioner(["顺手把 README 补一下，我回头再看"]), round)).toBe("continue");

        const brief = buildBriefFor(s.handle);
        expect(brief).not.toBeNull();
        const text = resumeBriefText(brief);
        expect(text).toContain("【续跑简报】");
        expect(text).toContain("人的指令（原文）");                 // 人的答案原文
        expect(text).toContain("顺手把 README 补一下，我回头再看");    // ← 指引原文在
        expect(text).toContain("w2");                              // ← 剩余工作项 id 在
        expect(text).toContain("不要重做已经记成 completed 的写操作");
        // 拼进任务副本（不改原 task 对象），必然随 {{developerInstructions}} 进任务书
        const task = { developerInstructions: "基础指令", taskId: "t1" } as unknown as Parameters<typeof taskWithBrief>[0];
        const merged = taskWithBrief(task, brief);
        expect(merged.developerInstructions).toContain("基础指令");
        expect(merged.developerInstructions).toContain("【续跑简报】");
        expect(task.developerInstructions).toBe("基础指令");        // 原对象未被改（纯函数）
        // brief 有界：一小把行
        expect(text.split("\n").length).toBeLessThanOrEqual(12);
        expect(text.length).toBeLessThanOrEqual(RESUME_BRIEF_CLIP + 40);
    });

    it("没有暂停记录 → 不注入（首跑/普通崩溃续跑零扰动）", () => {
        const ledger = ledgerFor("brief-none");
        const s = stub({ llmCalls: 0, ledger });
        expect(buildBriefFor(s.handle)).toBeNull();
        expect(resumeBriefText(buildBriefFor(s.handle))).toBe("");
        const task = { developerInstructions: "基础指令" } as unknown as Parameters<typeof taskWithBrief>[0];
        expect(taskWithBrief(task, null).developerInstructions).toBe("基础指令");
    });

    it("★ 「没人答」暂停后的 brief 说清是等满窗口停的（不是「没问出去」）", async () => {
        const ledger = ledgerFor("brief-roundtrip");
        const s = stub({ llmCalls: 147, ledger });
        const policy = expiredPolicy(80);                     // 很短的静默窗口
        const round = newRound();
        const out = await driveToTerminal(s.handle, policy, 400, round);
        if (out.kind !== "ask") throw new Error("unreachable");
        // 真的"一直在轮询、没人点"的问答器 → 等满窗口后暂停
        expect(await brakeCheckpoint(s.handle, out.status, policy, 400, fakeQuestioner([]), round)).toBe("paused");
        const brief = buildBriefFor(s.handle);
        expect(brief).not.toBeNull();
        expect(brief!.continuation).toBe(1);
        const text = resumeBriefText(brief);
        expect(text).toContain("上次为什么停");
        expect(text).toContain("静默等了");                    // 是"等满窗口"，不是"问不出去"
        expect(text).not.toContain("没能问出去");
        // 暂停记录本身是锚点：题号 + 轮次都在里面（下次问同一道）
        const pause = findBrakePause(ledger.listEvents());
        expect(pause?.questionId).toBe("brake-t1-1");
        expect(pause?.round).toBe(1);
    });
});

// ============================================================
// (d) 暂停路径绝不写 blocked/failed，也绝不 abortRun
// ============================================================
describe("保留决策·(d) 暂停路径不判死", () => {
    it("★ 整个暂停路径：没有 run_aborted / blocked / failed 事件，也没有任何终态写法", async () => {
        const ledger = ledgerFor("no-death");
        const s = stub({ llmCalls: 147, ledger });
        const policy = expiredPolicy(60);
        const round = newRound();
        const out = await driveToTerminal(s.handle, policy, 400, round);
        if (out.kind !== "ask") throw new Error("unreachable");
        expect(await brakeCheckpoint(s.handle, out.status, policy, 400, null, round)).toBe("paused");
        const types = ledger.listEvents().map((e) => e.type);
        expect(types).toContain("brake_paused");
        expect(types).not.toContain("run_aborted");
        expect(types).not.toContain("blocked_unverified");
        expect(types).not.toContain("agent_shutdown");
        const status = ledger.loadState()?.status ?? "";
        expect(["blocked", "failed", "cancelled", "ready"]).not.toContain(status);
        expect(status).toBe("waiting_human");
        expect(s.aborted()).toBeNull();
        expect(s.blockedUnverified()).toBe(0);
    });
});
// ============================================================
// 人的另两个答案 + 无人值守天花板（唯一会收口的两条路）
// ============================================================
describe("驱动环·收口只发生在两种情况下", () => {
    it("人答「2 按现状收口」→ stopped（由调用方收口并交进展报告）", async () => {
        const ledger = ledgerFor("finalize");
        const s = stub({ llmCalls: 147, ledger });
        const policy = expiredPolicy(60);
        const round = newRound();
        const out = await driveToTerminal(s.handle, policy, 400, round);
        if (out.kind !== "ask") throw new Error("unreachable");
        expect(await brakeCheckpoint(s.handle, out.status, policy, 400, fakeQuestioner(["2"]), round)).toBe("stopped");
        const ev = ledger.listEvents().find((e) => e.type === "brake_user_finalize");
        expect(ev).toBeDefined();
        expect(String((ev!.payload as { reason: string }).reason)).toContain("finalize");
        expect(ledger.loadState()?.status).not.toBe("waiting_human");   // 人明确收口，不是暂停
    });

    it("人答「3 立刻停止」/「别继续了」→ stopped", async () => {
        for (const answer of ["3", "别继续了"]) {
            const ledger = ledgerFor();
            const s = stub({ llmCalls: 147, ledger });
            const policy = expiredPolicy(60);
            const round = newRound();
            const out = await driveToTerminal(s.handle, policy, 400, round);
            if (out.kind !== "ask") throw new Error("unreachable");
            expect(await brakeCheckpoint(s.handle, out.status, policy, 400, fakeQuestioner([answer]), round)).toBe("stopped");
            expect(ledger.listEvents().some((e) => e.type === "brake_user_stopped")).toBe(true);
        }
    });

    it("★ 无人值守（AUTO_CONFIRM=1）撞到天花板 → stopped（自保收口；Web 跑法永远拿不到）", async () => {
        const s = stub({ llmCalls: 147 });
        const policy = cfgPolicy({ elapsedMinutes: 200, hardWallMinutes: 180, unattended: true });
        const out = await driveToTerminal(s.handle, policy, 400, newRound());
        expect(out.kind).toBe("stopped");
        if (out.kind !== "stopped") throw new Error("unreachable");
        expect(out.status.hard).toBe(true);
        expect(out.verdict).toContain("无人值守天花板");
        expect(s.aborted()).toBeNull();                       // 收口由调用方负责，这里仍不 abort
    });

    it("brakeFinalized：先写账本事件 + 进展报告，再 abortRun；终态 blocked，绝不 ready", async () => {
        const s = stub({ llmCalls: 147 });
        s.ledger.appendEvent("acceptance_criteria_status", { status: { c1: "pass", c2: "pass", c3: "fail" } });
        const before = s.ledger.listEvents().length;
        const policy = cfgPolicy({ elapsedMinutes: 121 });
        const status: BrakeStatus = checkBrake(policy, { callsCompleted: 147, elapsedMs: mins(121) });
        await brakeFinalized(s.handle, status, "人确认收口", policy, 400, {
            calls: 150, input: 900, output: 300, escalations: 1,
        });
        const events = s.ledger.listEvents().slice(before);
        expect(events.find((e) => e.type === "wall_clock_exceeded")).toBeDefined();   // 留痕先于收口
        expect(events.findIndex((e) => e.type === "wall_clock_exceeded"))
            .toBeLessThan(events.findIndex((e) => e.type === "run_aborted"));
        const report = events.find((e) => e.type === "brake_progress_report");
        expect(report).toBeDefined();
        const text = (report!.payload as { text: string }).text;
        expect(text).toContain("【已完成】");
        expect(text).toContain("【还差什么】1/2 个工作项未完成：w2");
        expect((report!.payload as { checksGreen: number }).checksGreen).toBe(2);
        // 报告进 developer_blocked.reason（库里的 sys_task.error_msg 就是它）
        const reason = s.aborted();
        expect(reason).toContain("[BRAKE:wall_clock]");
        expect(reason).toContain("人确认收口");
        expect(reason).toContain("147/400 调");
        expect(s.ledger.loadState()?.status).toBe("blocked");       // 这条路上才允许 blocked
    });

    it("grantBrakeExtension 只改期限与计数（不碰 hard）：这就是「不杀」在数据上的形状", () => {
        const p = cfgPolicy({ elapsedMinutes: 121, hardWallMinutes: 180 });
        const hardBefore = p.hardWallMs;
        grantBrakeExtension(p);
        expect(p.hardWallMs).toBe(hardBefore);
        expect(p.extensionsUsed).toBe(1);
        expect(p.deadlineAt).toBeGreaterThan(Date.now());
    });
});
