// tests/batched-pipeline.test.ts —— 分批流水（9/15「拆出一个推一个」）的图级 + 入口级测试
//
//   覆盖两段（零 LLM、零真实模型）：
//     · 图级：waitBatch 出 END 带 resumeFrom=acceptBatch；acceptBatch 合并（checks 按 id
//       去重、hash 重算、同批重放两遍=合并一遍即幂等）；renderTask 的 detail 剥列表留当前项；
//       batched=false 金标准守卫（永不产出 waitBatch / waiting_item）。
//     · 入口级：acceptArchitectTask 种子批校验（乱序/重复/未知 itemId 直接 throw，不静默丢）；
//       resumeWithBatch 闸门序列；崩溃重放（同 Ledger 重开 handle → 种子重放 → 续跑到送检，
//       已完成项的写盘不重做）。仿 fake-loop.test.ts:151-191 的驱动副本与 recovery.test.ts 的夹具。
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
import type { ArchitectBatch, ArchitectTask, OutboundMessage } from "../protocol";
import { createDeveloperAgent } from "../index";
import type { DeveloperAgentHandle } from "../index";

// ============================================================
// 共享夹具
// ============================================================

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-dev-batched-"));
fs.mkdirSync(path.join(projectDir, "backend"), { recursive: true });
fs.mkdirSync(path.join(projectDir, "frontend"), { recursive: true });
const workspace = new Workspace({ projectDir, allowedRoots: ["backend", "frontend"] });
const opened: DeveloperLedger[] = [];
/** 入口级 handle：it 中途断言失败会跳过 shutdown()，sqlite 句柄漏在场上 → Windows rmSync EBUSY。
 *  全部登记，afterAll 统一先关句柄再删目录（参照 live/runner.ts --reset 段的 EBUSY 容错）。 */
const openedHandles: DeveloperAgentHandle[] = [];
let dbSeq = 0;

afterAll(async () => {
    for (const a of openedHandles) { try { a.close(); } catch { /* 已 shutdown，双关无害 */ } }
    for (const l of opened) { try { l.close(); } catch { /* 同上 */ } }
    // sqlite 句柄释放有延迟：重试三轮，仍失败只留警告（临时目录归系统回收，
    // 清理噪音不该翻掉测试结论）
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            fs.rmSync(projectDir, { recursive: true, force: true });
            break;
        } catch {
            await new Promise((r) => setTimeout(r, 250));
        }
    }
});

function freshLedger(): DeveloperLedger {
    const l = DeveloperLedger.open(path.join(projectDir, `batched-${dbSeq++}.db`), "p1:t1");
    opened.push(l);
    return l;
}

/** 蓝图：两个工作项（w1 后端 / w2 前端）+ 全局底线判据。detail 一律由批次带入。 */
function blueprintTask(over: Partial<ArchitectTask> = {}): ArchitectTask {
    return {
        type: "architect_task", projectId: "p1", taskId: "t1",
        requirementSnapshot: { goal: "分批流水测试" },
        stackProfile: { frontend: "vue3", backend: "spring-boot" },
        domainModel: { entity: "note", table: "note", fields: [] },
        contract: { version: "1", endpoints: [] },
        foundationPlan: {
            dirs: ["backend", "frontend"],
            workItems: [
                { id: "w1", kind: "backend", title: "后端接口" },
                { id: "w2", kind: "frontend", title: "前端页面" },
            ],
        },
        allowedRoots: ["backend", "frontend"],
        forbiddenPaths: [],
        acceptanceChecks: [{ id: "c-global", kind: "COMPILE" }],
        developerInstructions: "按计划实现",
        ...over,
    };
}

/** detail 串带可 grep 的标记（renderTask 剥列表/留当前项的断言靠它） */
const D1 = "D1-w1-详规-α";
const D2 = "D2-w2-详规-β";
const seedW1 = (over: Partial<ArchitectBatch> = {}): ArchitectBatch => ({
    type: "architect_batch", projectId: "p1", taskId: "t1", itemId: "w1",
    detail: D1, checks: [{ id: "c-w1", kind: "CONTRACT" }], ...over,
});
const batchW2 = (over: Partial<ArchitectBatch> = {}): ArchitectBatch => ({
    type: "architect_batch", projectId: "p1", taskId: "t1", itemId: "w2",
    detail: D2, checks: [{ id: "c-w2", kind: "COMPILE" }], ...over,
});

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

function collectingPort(): { port: MessagePort; sent: OutboundMessage[] } {
    const sent: OutboundMessage[] = [];
    return {
        sent,
        port: {
            send: (_t, m) => { sent.push(m); return "wake"; },
            receive: async () => ({ status: "invalid" as const, error: "分批测试不吃入站队列", sender: null }),
        },
    };
}

const WRITE_THEN_DONE = [
    { kind: "tool", tool: "writeFile", args: { path: "backend/src/A.java", content: "class A{}" } },
    { kind: "done" },
];

// ============================================================
// 图级：waitBatch / acceptBatch 状态机
// ============================================================

function makeBatchedGraph(decisions: unknown[]) {
    const { llm, count } = scriptedLlm(decisions);
    const { tools, invoked } = fakeTools(true);
    const { port, sent } = collectingPort();
    const ledger = freshLedger();
    const graph = buildDeveloperGraph({
        workspace, tools, ledger, port, llm,
        configuredAllowedRoots: ["backend", "frontend"],
        trustedTestAgents: ["test-core"],
    });
    return { graph, count, invoked, sent, ledger };
}

/**
 * 中途起跑的 batched 状态：w1 已到批未完、w2 未达。
 * 从 bootstrapOrImplement 起跑（receiveTask 已过，种子效果在 state 里直接摆好），
 * 与真实流程「架构师推 w1 → 开发做 w1」的状态形状一致。
 */
function midRunState(over: Partial<DeveloperState> = {}): DeveloperState {
    return initialDeveloperState({
        projectId: "p1", taskId: "t1", runId: "run-1", projectDir,
        allowedRoots: ["backend", "frontend"],
        status: "implementing", resumeFrom: "bootstrapOrImplement",
        batched: true,
        workItems: [
            { id: "w1", kind: "backend", detail: D1 },
            { id: "w2", kind: "frontend" },
        ],
        arrivedItems: ["w1"],
        completedWorkItems: [],
        currentWorkItemId: "w1",
        acceptanceChecks: [{ id: "c-global", kind: "COMPILE" }],
        acceptanceHash: acceptanceHashOf([{ id: "c-global", kind: "COMPILE" }]),
        messages: [blueprintTask()],
        ...over,
    });
}

describe("分批流水 / 图级状态机", () => {
    it("w1 做完且 w2 未达 → 停 waiting_item（不是送检）；补批后 w2 跑完 → 流关闭 → 本地预检 → 送检", async () => {
        const g = makeBatchedGraph(WRITE_THEN_DONE);
        const s1 = await g.graph.invoke(midRunState()) as DeveloperState;
        // ★ 头号断言：等批不是等测——判据没齐，test_request 一个都不许发
        expect(s1.status).toBe("waiting_item");
        expect(s1.resumeFrom).toBe("acceptBatch");
        expect(s1.currentWorkItemId).toBe("w2");        // 落盘前先指向下一项（acceptBatch 会校正）
        expect(g.sent.map((m) => m.type)).not.toContain("test_request");

        const s2 = await g.graph.invoke({
            ...s1, messages: [...s1.messages, batchW2()], resumeFrom: "acceptBatch",
        }) as DeveloperState;
        expect(s2.status).toBe("waiting_test");         // 全部到达并做完才走到送检
        expect(s2.completedWorkItems).toEqual(["w1", "w2"]);
        expect(s2.arrivedItems).toEqual(["w1", "w2"]);
        expect(g.invoked).toContain("runBuild");        // 流关闭判定生效：跑了整站预检
        const req = g.sent.find((m) => m.type === "test_request") as { acceptanceHash?: string };
        // A5 不变量：hash 变动永远发生在任何 test_wait 打开之前
        expect(req.acceptanceHash).toBe(s2.acceptanceHash);
    });

    it("acceptBatch 合并：detail 进 workItems、checks 蓝图在前批次在后、hash 重算且与预计算一致", async () => {
        const g = makeBatchedGraph(WRITE_THEN_DONE);
        const s1 = await g.graph.invoke(midRunState()) as DeveloperState;
        const s2 = await g.graph.invoke({
            ...s1, messages: [...s1.messages, batchW2()], resumeFrom: "acceptBatch",
        }) as DeveloperState;
        const w2 = s2.workItems.find((w) => w.id === "w2");
        expect(w2?.detail).toBe(D2);                    // 主规格进来了，且没长到别人身上
        expect(s2.workItems.find((w) => w.id === "w1")?.detail).toBe(D1);
        expect(s2.acceptanceChecks.map((c) => c.id)).toEqual(["c-global", "c-w2"]);
        expect(s2.acceptanceHash).toBe(acceptanceHashOf([
            { id: "c-global", kind: "COMPILE" }, { id: "c-w2", kind: "COMPILE" },
        ]));
        expect(s2.acceptanceHash).not.toBe(acceptanceHashOf([{ id: "c-global", kind: "COMPILE" }]));
    });

    it("acceptBatch 幂等：崩溃重放把同一批再喂一遍 → 判据不加条、hash 不变（= 合并一遍）", async () => {
        const g = makeBatchedGraph(WRITE_THEN_DONE);
        const s1 = await g.graph.invoke(midRunState()) as DeveloperState;
        // 模拟「合并已发生、还没做 w2 就崩了」：replay 时 arrivedItems 已含 w2、数据已并好，
        // 但驱动面把批次消息又重投了一遍（messages 是 append 语义，reducer 早就留着它）。
        const replayed = {
            ...s1,
            arrivedItems: ["w1", "w2"],
            workItems: s1.workItems.map((w) => (w.id === "w2" ? { ...w, detail: D2 } : w)),
            acceptanceChecks: [{ id: "c-global", kind: "COMPILE" }, { id: "c-w2", kind: "COMPILE" }],
            acceptanceHash: acceptanceHashOf([
                { id: "c-global", kind: "COMPILE" }, { id: "c-w2", kind: "COMPILE" },
            ]),
        };
        const s2 = await g.graph.invoke({
            ...replayed, messages: [...replayed.messages, batchW2()], resumeFrom: "acceptBatch",
        }) as DeveloperState;
        expect(s2.status).toBe("waiting_test");
        expect(s2.acceptanceChecks.map((c) => c.id)).toEqual(["c-global", "c-w2"]); // ★ 没有第三条
        expect(s2.arrivedItems).toEqual(["w1", "w2"]);                              // appendUnique 去重
        // 与干净路径（上一条 it）逐字段对齐：同输入两份合并结果一致 = 幂等
        const g2 = makeBatchedGraph(WRITE_THEN_DONE);
        const clean1 = await g2.graph.invoke(midRunState()) as DeveloperState;
        const clean2 = await g2.graph.invoke({
            ...clean1, messages: [...clean1.messages, batchW2()], resumeFrom: "acceptBatch",
        }) as DeveloperState;
        expect(s2.acceptanceHash).toBe(clean2.acceptanceHash);
    });

    it("acceptBatch 防御：没有批次消息可收 → 原地回等待态（绝不 failed、零 LLM）", async () => {
        const g = makeBatchedGraph(WRITE_THEN_DONE);
        const waiting = midRunState({
            status: "waiting_item", resumeFrom: "acceptBatch",
            completedWorkItems: ["w1"], currentWorkItemId: "w2",
        });
        const s = await g.graph.invoke(waiting) as DeveloperState;
        expect(s.status).toBe("waiting_item");
        expect(s.error).toBeNull();
        expect(s.resumeFrom).toBe("acceptBatch");
        expect(g.count()).toBe(0);                      // 一次模型调用都不该发生
        expect(g.sent.map((m) => m.type)).not.toContain("test_request");
    });

    it("renderTask：detail 只进当前工作项，工作项清单里剥掉（防提示膨胀）", async () => {
        const g = makeBatchedGraph(WRITE_THEN_DONE);
        const s1 = await g.graph.invoke(midRunState()) as DeveloperState;
        const s2 = await g.graph.invoke({
            ...s1, messages: [...s1.messages, batchW2()], resumeFrom: "acceptBatch",
        }) as DeveloperState;
        const ctx = [...s2.messages].reverse().find(
            (m) => (m as { type?: string })?.type === "context",
        ) as { task?: string } | undefined;
        expect(ctx?.task).toBeDefined();
        const taskText = ctx?.task ?? "";
        expect(taskText).toContain(D2);                 // 当前项带主规格
        const list = taskText.slice(taskText.indexOf("工作项清单"), taskText.indexOf("当前工作项"));
        expect(list).not.toContain(D2);                 // ★ 清单段里没有详规
        expect(list).not.toContain(D1);
        expect(taskText).toContain("\"w2\"");
    });

    it("金标准守卫：batched=false 走完整链路也不会产生 waiting_item（旧链路零扰动）", async () => {
        // 路由级 + 状态级双重：legacy 连 arrivedItems 的语义都不该沾
        const legacy = midRunState({
            batched: false, arrivedItems: [], currentWorkItemId: "w2", completedWorkItems: ["w1"],
            resumeFrom: "bootstrapOrImplement",
        });
        const g = makeBatchedGraph(WRITE_THEN_DONE);
        const s = await g.graph.invoke(legacy) as DeveloperState;
        expect(s.status).toBe("waiting_test");          // 直接推进 w2 → 预检 → 送检，没有等批
        expect(s.arrivedItems).toEqual([]);             // 字段原样没动
    });
});

// ============================================================
// 入口级：seedBatches 校验 / resumeWithBatch / 崩溃重放 / abortRun
//   仿 recovery.test.ts + fake-loop「崩溃恢复（index 入口）」的夹具写法。
// ============================================================

function nextLedgerPath(): string {
    return path.join(projectDir, `handle-${dbSeq++}.db`);
}

function makeAgent(ledgerPath: string, llm: DeveloperLlm, extra: Record<string, unknown> = {}) {
    const agent = createDeveloperAgent({
        projectId: "p1", taskId: "t1", projectDir,
        allowedRoots: ["backend", "frontend"],
        ledgerPath, llm,
        // soft 授权 = 显式测试选择（留痕断言在 soft-mode.test.ts，这里不重复）
        sandbox: { mode: "soft", backend: "local" },
        ...extra,
    });
    openedHandles.push(agent);   // it 失败也不留活句柄（afterAll 统一收口）
    return agent;
}

describe("分批流水 / 种子批校验（acceptArchitectTask 第二参）", () => {
    it("未知 itemId / 跳批 / 重复 / 身份不符 / 类型不符 → 一律 throw，且不落 run_start", async () => {
        const agent = makeAgent(nextLedgerPath(), scriptedLlm([]).llm);
        const task = blueprintTask();
        await expect(agent.acceptArchitectTask(task, [{ ...seedW1(), itemId: "w99" }]))
            .rejects.toThrow(/w99/);                       // itemId ∉ 蓝图
        await expect(agent.acceptArchitectTask(task, [batchW2()]))
            .rejects.toThrow(/w1/);                        // 跳过 w1（乱序前缀不成立）
        await expect(agent.acceptArchitectTask(task, [seedW1(), { ...seedW1(), itemId: "w1" }]))
            .rejects.toThrow(/w1/);                        // 同一项推两遍
        await expect(agent.acceptArchitectTask(task, [{ ...seedW1(), projectId: "evil" }]))
            .rejects.toThrow(/身份/);
        await expect(agent.acceptArchitectTask(task, [{ ...seedW1(), type: "test_passed" } as unknown as ArchitectBatch]))
            .rejects.toThrow(/architect_batch/);
        // throw 发生在任何执行副作用之前：账本里连 run_start 都不该有
        expect(agent.ledger.listEvents().some((e) => e.type === "run_start")).toBe(false);
        await agent.shutdown();
    });
});

describe("分批流水 / resumeWithBatch", () => {
    it("happy path：w1 跑到等批 → 重复推 w1 幂等忽略 → 推 w2 批 → 合并推进到送检", async () => {
        const ledgerPath = nextLedgerPath();
        const agent = makeAgent(ledgerPath, scriptedLlm(WRITE_THEN_DONE).llm, { runId: "run-b" });
        const s1 = await agent.acceptArchitectTask(blueprintTask(), [seedW1()]);
        expect(s1.status).toBe("waiting_item");
        expect(agent.inspectTaskState().workItems).toEqual([
            { id: "w1", kind: "backend", done: true, arrived: true },
            { id: "w2", kind: "frontend", done: false, arrived: false },
        ]);

        // 重复批（w1 已到甚至已做完，还被再推一遍）→ 幂等忽略：原地返回状态，不作废。
        //   9/16 p20 首跑惨案：信封种子批已含 w1，拆分流又照发一遍 w1，
        //   旧闸把「已到项重投」判成乱序 → DRIVER_GATE_REJECTED 整次作废。
        const dup = await agent.resumeWithBatch(seedW1());
        if (dup === "rejected") throw new Error("已到批次重复投递不该判乱序");
        expect(dup.status).toBe("waiting_item");
        expect(agent.ledger.listEvents().some((e) => e.type === "batch_duplicate_ignored")).toBe(true);
        expect(agent.ledger.listEvents().some((e) => e.type === "batch_rejected")).toBe(false);
        // 真乱序照拒：w9 从未到、也不是首个未达项（9/15 拍板②零容忍不变）
        expect(await agent.resumeWithBatch(seedW1({ itemId: "w9" }))).toBe("rejected");
        expect(agent.ledger.listEvents().some((e) => e.type === "batch_rejected")).toBe(true);

        const s2 = await agent.resumeWithBatch(batchW2());
        if (s2 === "rejected") throw new Error("按序批次不该被拒");
        expect(s2.status).toBe("waiting_test");
        expect(s2.arrivedItems).toEqual(["w1", "w2"]);
        expect(s2.acceptanceChecks.map((c) => c.id)).toEqual(["c-global", "c-w1", "c-w2"]);
        expect(s2.acceptanceHash).toBe(acceptanceHashOf(s2.acceptanceChecks));
        const applied = agent.ledger.listEvents().filter((e) => e.type === "batch_applied");
        expect(applied.length).toBe(1);
        expect(JSON.stringify(applied[0]?.payload)).toContain("w2");
        expect(agent.inspectTaskState().workItems[1]).toEqual({ id: "w2", kind: "frontend", done: true, arrived: true });

        // 已送检（waiting_test）再喂批 → 状态闸拒（acceptanceHash 送检后必须冻结）
        expect(await agent.resumeWithBatch(batchW2())).toBe("rejected");
        await agent.shutdown();
    });

    it("闸门序列：无快照 / 非 waiting_item / 身份不符 一律 rejected 并留 batch_rejected", async () => {
        const agent = makeAgent(nextLedgerPath(), scriptedLlm([]).llm);
        // ① 没有任何任务快照
        expect(await agent.resumeWithBatch(batchW2())).toBe("rejected");
        // ② 有快照但不在 waiting_item（拿批乱推状态）
        agent.ledger.saveState({
            taskId: "t1", status: "implementing", repairAttempts: 0,
            failureSignatures: [], changedFiles: [], llmCalls: 0,
        });
        expect(await agent.resumeWithBatch(batchW2())).toBe("rejected");
        // ③ 状态对了但身份不对
        agent.ledger.saveState({
            taskId: "t1", status: "waiting_item", repairAttempts: 0,
            failureSignatures: [], changedFiles: [], llmCalls: 0,
        });
        expect(await agent.resumeWithBatch({ ...batchW2(), projectId: "evil" })).toBe("rejected");
        const rejects = agent.ledger.listEvents().filter((e) => e.type === "batch_rejected");
        expect(rejects.length).toBe(3);                   // ①无快照 ②状态不对 ③身份不对
        await agent.shutdown();
    });

    it("abortRun：等批点整次作废 → blocked + run_aborted 留痕 + 终态幂等", async () => {
        const agent = makeAgent(nextLedgerPath(), scriptedLlm(WRITE_THEN_DONE).llm, { runId: "run-x" });
        const s1 = await agent.acceptArchitectTask(blueprintTask(), [seedW1()]);
        expect(s1.status).toBe("waiting_item");
        const s2 = await agent.abortRun("ARCHITECT_BATCH_FAILED:w2");
        expect(s2.status).toBe("blocked");
        expect(String(s2.error)).toContain("ARCHITECT_BATCH_FAILED:w2");
        expect(agent.ledger.listEvents().some((e) => e.type === "run_aborted")).toBe(true);
        // 终态幂等：再 abort 不覆盖既有结论
        const s3 = await agent.abortRun("再来一次");
        expect(s3.status).toBe("blocked");
        expect(String(s3.error)).toContain("ARCHITECT_BATCH_FAILED");
        await agent.shutdown();
    });
});

describe("分批流水 / 崩溃重放（同 Ledger 重开 handle）", () => {
    it("种子重放 w1+w2 → 从 receiveTask 续推到送检；已完成项 w1 的写盘不重做", async () => {
        const ledgerPath = nextLedgerPath();
        const first = makeAgent(ledgerPath, scriptedLlm(WRITE_THEN_DONE).llm, { runId: "run-r" });
        const s1 = await first.acceptArchitectTask(blueprintTask(), [seedW1()]);
        expect(s1.status).toBe("waiting_item");           // 崩在这里：w1 已做完、w2 的批已落盘未消费
        const javaFile = path.join(projectDir, "backend", "src", "A.java");
        expect(fs.existsSync(javaFile)).toBe(true);       // 真写盘发生了（soft 沙箱）
        const mtimeBefore = fs.statSync(javaFile).mtimeMs;
        // write_audit 只在工具真落盘时记（缓存命中直接返回，压根不进工具），
        // 拿它当"写盘没重做"的记账证据；tool_call 行缓存命中也会补记，不能用它判。
        const auditsBefore = first.ledger.listEvents().filter((e) => e.type === "write_audit").length;
        expect(auditsBefore).toBeGreaterThan(0);
        await first.shutdown();                           // = 进程重启边界

        // 新 handle（= 新进程）：蓝图 + 已落盘批次全量重播种
        const second = makeAgent(ledgerPath, scriptedLlm(WRITE_THEN_DONE).llm, { runId: "run-r" });
        const s2 = await second.acceptArchitectTask(blueprintTask(), [seedW1(), batchW2()]);
        expect(s2.status).toBe("waiting_test");           // 越过了上次的停止点（w2 也做完并送检）
        expect(s2.completedWorkItems).toEqual(["w1", "w2"]);
        expect(s2.arrivedItems).toEqual(["w1", "w2"]);
        // ★ 不重做已完成的写盘：文件没被二次写过（mtime 不变 + 缓存复用留痕）
        expect(fs.statSync(javaFile).mtimeMs).toBe(mtimeBefore);
        expect(second.ledger.listEvents().some((e) => e.type === "tool_call_reused")).toBe(true);
        expect(second.ledger.listEvents().filter((e) => e.type === "write_audit").length).toBe(auditsBefore);
        // 种子合并：w1/w2 的详规与判据在重放里都齐了（w1 不会裸跑）
        expect(s2.workItems.find((w) => w.id === "w1")?.detail).toBe(D1);
        expect(s2.acceptanceChecks.map((c) => c.id)).toEqual(["c-global", "c-w1", "c-w2"]);
        await second.shutdown();
    }, 60_000);
});
