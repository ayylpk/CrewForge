// tests/architectAgent.test.ts —— architectAgent 的零 LLM 单测（Fake LLM，全程不联网）
//
//   被测链路（9/15 晚两阶段升级后；9/16 清理掉一步整包的 decompose）：
//   · 校验-重试环（信封拆包 / 抠 JSON / 权威字段闸 / 反馈环 / 传输错自愈）——
//     蓝图与批次共用同一段骨架，用例挂在蓝图阶段上；
//   · decomposeBlueprint()——闸门链 = 通用校验链 + "每个 allowedRoots ≥1 条 COMPILE 底线"；
//   · decomposeBatch()——ArchitectBatchSchema + 业务闸（业务项判据≥1 / id 撞车 /
//     CONTRACT 必须命中蓝图 endpoints）+ 代码强制身份；
//   · assembleTask()——纯函数装配：前缀序校验、detail 入位、判据按序合并 id 去重。
//   Fake 策略照抄 fake-loop.test.ts 的 scripted 风格：预置 decisions 按调用次序吐出，
//   并记录每次 next 收到的 task 文本（断言"被拒原因喂回重试"的反馈环）。
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleTask, createArchitectAgent, placeholderGateGaps } from "../architectAgent";
import { ArchitectBatchSchema, ArchitectTaskSchema, parseInbound } from "../protocol";
import type { ArchitectBatch, ArchitectTask, WorkItem } from "../protocol";
import type { DeveloperLlm } from "../graph";

/** 需求原文 fixture：一句话小项目，够所有校验链吃 */
const REQ = "做一个便签管理小工具：可新增、查看、删除便签。";

/**
 * 蓝图 fixture 的底座：能一口气过形状闸的任务包。
 * ⚠️ ArchitectTaskSchema 是严格 z.object：顶层 12 个字段一个不能多一个不能少；
 * workItems.kind 只能取七种枚举值。
 */
const VALID_TASK = {
    type: "architect_task",
    projectId: "p1", taskId: "t1",
    requirementSnapshot: { goal: "便签管理" },
    stackProfile: { frontend: "vue3+vite", backend: "node+express", database: "sqlite" },
    domainModel: { entity: "Note(id,title,content)" },
    contract: {
        version: "1",
        endpoints: [{ method: "GET", path: "/api/notes", purpose: "列表", response: "便签数组" }],
    },
    foundationPlan: {
        dirs: ["backend", "frontend"],
        workItems: [
            { id: "w1", kind: "foundation", title: "搭骨架" },
            { id: "w2", kind: "backend", title: "便签接口" },
            { id: "w3", kind: "frontend", title: "便签页面" },
            { id: "w4", kind: "pre-test", title: "自检" },
        ],
    },
    allowedRoots: ["backend", "frontend"],
    forbiddenPaths: [],
    acceptanceChecks: [{ id: "ac-1", kind: "COMPILE", target: "backend" }],
    developerInstructions: "按顺序做",
};

/**
 * 合法蓝图 fixture——在 VALID_TASK 基础上补齐蓝图底线闸：
 * allowedRoots 的每个根（backend/frontend）都要有一条 COMPILE。
 */
const VALID_BLUEPRINT = {
    ...VALID_TASK,
    acceptanceChecks: [
        { id: "ac-1", kind: "COMPILE", target: "backend" },
        { id: "ac-2", kind: "COMPILE", target: "frontend" },
    ],
};

/** 蓝图强类型版（assembleTask / decomposeBatch 的入参要 ArchitectTask） */
function parsedBlueprint(): ArchitectTask {
    return ArchitectTaskSchema.parse(VALID_BLUEPRINT);
}

/** 取蓝图第 n 个工作项（typed；noUncheckedIndexedAccess 下省得每处挂两个 !） */
function workItemOf(bp: ArchitectTask, n: number): WorkItem {
    return bp.foundationPlan.workItems![n]!;
}

/** 命中蓝图 contract.endpoints 的合法判据（GET /api/notes） */
const AC_NOTES = { id: "ac-3", kind: "CONTRACT", method: "GET", path: "/api/notes", expectedStatus: 200, expected: "便签数组" };

/** 批次 fixture 构造器（默认身份 p1/t1、detail 非空、checks 空——用例各改各的） */
function mkBatch(o: Partial<ArchitectBatch> & Pick<ArchitectBatch, "itemId">): ArchitectBatch {
    return ArchitectBatchSchema.parse({
        type: "architect_batch", projectId: "p1", taskId: "t1",
        detail: "分层 routes/service/db；对接 GET /api/notes",
        checks: [], ...o,
    });
}

/** Fake LLM（scripted 风格）：按次序吐 decisions（越界时钉在最后一个），并录下每次收到的 task 文本 */
function scriptedLlm(decisions: unknown[]) {
    let calls = 0;
    const tasks: string[] = []; // 每次 next 收到的 task 文本（断言反馈环用）
    const llm: DeveloperLlm = {
        id: "fake",
        calls: () => calls,
        async next(input) {
            calls++;
            tasks.push(input.task);
            const d = decisions[Math.min(calls - 1, decisions.length - 1)];
            return d;
        },
    };
    return { llm, tasks, count: () => calls };
}

describe("architectAgent / 校验-重试环（蓝图与批次共用同一段骨架，用例挂在蓝图侧）", () => {
    it("重试耗尽：maxAttempts=2 两次都吐非 JSON → 抛错含最后一次原因，且不超发", async () => {
        const fake = scriptedLlm(["完全不是 JSON 的输出", "还是不是 JSON"]);
        const agent = createArchitectAgent({ llm: fake.llm, maxAttempts: 2 });
        // 最后一次拒绝原因 = "输出里找不到合法 JSON 对象……" → 错误信息含 "JSON"
        await expect(agent.decomposeBlueprint({ requirement: REQ })).rejects.toThrow("JSON");
        expect(fake.count()).toBe(2); // 恰好两次，不多烧
    });

    it("调用层自愈：第 1 次 LLM 调用抛传输错（中转超时）→ 第 2 次成功，不再裸穿整次作废", async () => {
        // 9/16 p20 第三跑死因：w6 批拆解撞 "The operation timed out."，
        // generateValidated 的裸 await 让传输错直接穿出「3 连拒」环（它只兜内容拒绝）
        // → dispatch_cancelled 整次作废。传输错必须和内容拒绝一样进重试环。
        let calls = 0;
        const llm: DeveloperLlm = {
            id: "fake-flaky",
            calls: () => calls,
            async next() {
                calls++;
                if (calls === 1) throw new Error("The operation timed out.");
                return JSON.stringify(VALID_BLUEPRINT);
            },
        };
        const result = await createArchitectAgent({ llm }).decomposeBlueprint({ requirement: REQ });
        expect(calls).toBe(2);
        expect(result.attempts).toBe(2);
        expect(result.rejections[0]).toContain("The operation timed out."); // 拒因留痕可上报
    });

    it("调用层耗尽：传输错连吃 maxAttempts 次 → 抛「全部被拒」含最后原因，不超发", async () => {
        let calls = 0;
        const llm: DeveloperLlm = {
            id: "fake-dead",
            calls: () => calls,
            async next() { calls++; throw new Error("boom"); },
        };
        const agent = createArchitectAgent({ llm, maxAttempts: 2 });
        await expect(agent.decomposeBlueprint({ requirement: REQ })).rejects.toThrow("全部被拒");
        expect(calls).toBe(2);
    });

    it("权威字段拦截：requirementSnapshot 里夹带 done → 闸先于 zod 拒收 → 反馈后自愈", async () => {
        // 顶层加 done 会被严格 z.object 直接拒（测不到闸的优先级），
        // 所以塞进 looseObject 的 requirementSnapshot：zod 放行、authority 闸必须先拦。
        const fake = scriptedLlm([
            { ...VALID_BLUEPRINT, requirementSnapshot: { goal: "x", done: true } },
            VALID_BLUEPRINT,
        ]);
        const agent = createArchitectAgent({ llm: fake.llm });
        const result = await agent.decomposeBlueprint({ requirement: REQ });

        expect(result.attempts).toBe(2);
        expect(result.rejections[0]).toContain("权威字段");
        expect(result.rejections[0]).toContain("requirementSnapshot.done"); // 指名道姓到路径
        expect(fake.tasks[1]).toContain("权威字段"); // 拒因同样喂回了第二轮
    });

    it("围栏/叙述里的 JSON 能抠出：```json 围栏 + 前后叙述文字 → 一次成功", async () => {
        const fake = scriptedLlm(["架构师分析如下：\n```json\n" + JSON.stringify(VALID_BLUEPRINT) + "\n```"]);
        const agent = createArchitectAgent({ llm: fake.llm });
        const result = await agent.decomposeBlueprint({ requirement: REQ });

        expect(fake.count()).toBe(1);
        expect(result.attempts).toBe(1);
        expect(result.task.taskId).toBe("t1");
    });

    it("空需求 fail fast：空串/纯空白直接拒绝，一次 LLM 都不调", async () => {
        const fake = scriptedLlm([JSON.stringify(VALID_BLUEPRINT)]);
        const agent = createArchitectAgent({ llm: fake.llm });
        await expect(agent.decomposeBlueprint({ requirement: "" })).rejects.toThrow("需求文本为空");
        await expect(agent.decomposeBlueprint({ requirement: "   \n\t  " })).rejects.toThrow("需求文本为空");
        expect(fake.count()).toBe(0);
    });
});

describe("architectAgent / decomposeBlueprint（蓝图阶段）", () => {
    it("一次成功：底线判据齐全的蓝图通过，attempts=1、产物过 parseInbound", async () => {
        const fake = scriptedLlm([JSON.stringify(VALID_BLUEPRINT)]);
        const agent = createArchitectAgent({ llm: fake.llm });
        const r = await agent.decomposeBlueprint({ requirement: REQ });

        expect(fake.count()).toBe(1);
        expect(r.attempts).toBe(1);
        expect(r.rejections).toEqual([]);
        expect(r.task.projectId).toBe("p1");
        expect(r.task.taskId).toBe("t1");
        expect(r.task.acceptanceChecks.length).toBe(2); // 全局底线：backend+frontend 各 1 条 COMPILE
        expect(r.task.foundationPlan.workItems?.length).toBe(4);
        expect(parseInbound(JSON.stringify(r.task)).ok).toBe(true);
        // user 文本：需求原文 + 身份都在
        expect(fake.tasks[0]).toContain(REQ);
        expect(fake.tasks[0]).toContain("projectId: p1");
    });

    it("空判据蓝图被拒 → 反馈自愈（与 decompose 同款底线：一条都没有=没法验收）", async () => {
        const fake = scriptedLlm([{ ...VALID_BLUEPRINT, acceptanceChecks: [] }, VALID_BLUEPRINT]);
        const agent = createArchitectAgent({ llm: fake.llm });
        const r = await agent.decomposeBlueprint({ requirement: REQ });

        expect(r.attempts).toBe(2);
        expect(r.rejections[0]).toContain("acceptanceChecks 不能为空");
        expect(fake.tasks[1]).toContain("acceptanceChecks 不能为空");
        expect(fake.tasks[1]).toContain("必须修正");
    });

    it("COMPILE 底线闸：allowedRoots 的 frontend 没有底线判据 → 拒且点名缺的根", async () => {
        // 只给 backend 一条底线 → 蓝图底线闸必须拦，且点名缺的是哪个根
        const fake = scriptedLlm([
            { ...VALID_BLUEPRINT, acceptanceChecks: [{ id: "ac-1", kind: "COMPILE", target: "backend" }] },
            VALID_BLUEPRINT,
        ]);
        const agent = createArchitectAgent({ llm: fake.llm });
        const r = await agent.decomposeBlueprint({ requirement: REQ });

        expect(r.attempts).toBe(2);
        expect(r.rejections[0]).toContain("COMPILE");
        expect(r.rejections[0]).toContain("frontend"); // 精确点名：缺的是哪个根
        expect(fake.tasks[1]).toContain("frontend");   // 拒因喂回
    });

    it("身份强制覆盖：模型乱写 projectId/taskId 也被盖成入参（code-over-tools）", async () => {
        const fake = scriptedLlm([JSON.stringify({ ...VALID_BLUEPRINT, projectId: "evil-p", taskId: "evil-t" })]);
        const agent = createArchitectAgent({ llm: fake.llm });
        const r = await agent.decomposeBlueprint({ requirement: REQ, projectId: "px", taskId: "py" });

        expect(r.task.projectId).toBe("px");
        expect(r.task.taskId).toBe("py");
    });
});

describe("architectAgent / decomposeBatch（批次阶段）", () => {
    it("一次成功：backend 项带合法 CONTRACT 判据 → attempts=1，产物过 parseInbound", async () => {
        const bp = parsedBlueprint();
        const w2 = workItemOf(bp, 1);
        const fake = scriptedLlm([mkBatch({ itemId: "w2", checks: [AC_NOTES] })]);
        const agent = createArchitectAgent({ llm: fake.llm });
        const r = await agent.decomposeBatch({
            requirement: REQ, blueprint: bp, item: w2, deliveredCheckIds: ["ac-1", "ac-2"],
        });

        expect(fake.count()).toBe(1);
        expect(r.attempts).toBe(1);
        expect(r.batch.itemId).toBe("w2");
        expect(r.batch.checks.length).toBe(1);
        expect(r.batch.detail).toContain("GET /api/notes");
        expect(parseInbound(JSON.stringify(r.batch)).ok).toBe(true);
    });

    it("backend 项零判据 → 拒（无判据的批=该项没被验收）→ 反馈自愈", async () => {
        const bp = parsedBlueprint();
        const w2 = workItemOf(bp, 1);
        const fake = scriptedLlm([
            mkBatch({ itemId: "w2", checks: [] }),
            mkBatch({ itemId: "w2", checks: [AC_NOTES] }),
        ]);
        const agent = createArchitectAgent({ llm: fake.llm });
        const r = await agent.decomposeBatch({
            requirement: REQ, blueprint: bp, item: w2, deliveredCheckIds: ["ac-1", "ac-2"],
        });

        expect(r.attempts).toBe(2);
        expect(r.rejections[0]).toContain("checks 不能为空");
        expect(fake.tasks[1]).toContain("该项没被验收"); // 拒因喂回时带解释
    });

    it("inspect 项零判据放行（无外显产物项允许 checks=0）", async () => {
        const bp = parsedBlueprint();
        const wInspect: WorkItem = { id: "w0", kind: "inspect", title: "看现状" };
        const fake = scriptedLlm([mkBatch({ itemId: "w0", checks: [] })]);
        const agent = createArchitectAgent({ llm: fake.llm });
        const r = await agent.decomposeBatch({
            requirement: REQ, blueprint: bp, item: wInspect, deliveredCheckIds: [],
        });

        expect(r.attempts).toBe(1);
        expect(r.batch.checks).toEqual([]);
        expect(r.batch.itemId).toBe("w0");
    });

    it("已交付判据撞车：ac-1 重复交付 → 整批拒且点名 id 与唯一性规矩", async () => {
        const bp = parsedBlueprint();
        const w2 = workItemOf(bp, 1);
        const fake = scriptedLlm([
            mkBatch({ itemId: "w2", checks: [{ ...AC_NOTES, id: "ac-1" }] }),
            mkBatch({ itemId: "w2", checks: [AC_NOTES] }),
        ]);
        const agent = createArchitectAgent({ llm: fake.llm });
        const r = await agent.decomposeBatch({
            requirement: REQ, blueprint: bp, item: w2, deliveredCheckIds: ["ac-1", "ac-2"],
        });

        expect(r.attempts).toBe(2);
        expect(r.rejections[0]).toContain("ac-1");
        expect(r.rejections[0]).toContain("已在前面交付");
        expect(r.rejections[0]).toContain("全局唯一");
    });

    it("CONTRACT 判据 (method,path) 没命中蓝图 endpoints → 拒并列出跑偏项", async () => {
        const bp = parsedBlueprint();
        const w2 = workItemOf(bp, 1);
        const ghost = { id: "ac-9", kind: "CONTRACT", method: "GET", path: "/api/ghost", expectedStatus: 200 };
        const fake = scriptedLlm([
            mkBatch({ itemId: "w2", checks: [ghost] }),
            mkBatch({ itemId: "w2", checks: [AC_NOTES] }),
        ]);
        const agent = createArchitectAgent({ llm: fake.llm });
        const r = await agent.decomposeBatch({
            requirement: REQ, blueprint: bp, item: w2, deliveredCheckIds: ["ac-1", "ac-2"],
        });

        expect(r.attempts).toBe(2);
        expect(r.rejections[0]).toContain("/api/ghost"); //  offenders 逐条列出
        expect(r.rejections[0]).toContain("endpoints");
    });

    it("端点闸=真 router 形状：占位符名任意/查询串剥掉/具体实例命中（9/16 p20 误杀补刀）", async () => {
        // p20 第四跑死因：蓝图模板 GET /api/tasks/{id}，批次判据写 GET /api/tasks/999999、
        // 占位符叫 {pid}/{tid}、或带 ?projectId= 查询串——语义全对，裸字符串闸 3 连拒整次作废。
        const bp = ArchitectTaskSchema.parse({
            ...VALID_BLUEPRINT,
            contract: {
                version: "1",
                endpoints: [
                    { method: "GET", path: "/api/notes/{id}" },
                    { method: "POST", path: "/api/notes" },
                ],
            },
        });
        const w2 = workItemOf(bp, 1);
        const okChecks = [
            // 占位符换名（端点闸只认"分段形状"、不认名字）；A2 要求它由本条 setup 抽出来
            { id: "v-1", kind: "CONTRACT", method: "GET", path: "/api/notes/{nid}", expectedStatus: 200,
              setup: [{ method: "POST", path: "/api/notes", expectedStatus: 201, extract: { name: "nid", from: "data.id" } }] },
            { id: "v-2", kind: "CONTRACT", method: "GET", path: "/api/notes/999999?expand=1", expectedStatus: 200 }, // 具体实例+查询串
            { id: "v-3", kind: "CONTRACT", method: "POST", path: "/api/notes/", expectedStatus: 201 },             // 尾斜杠
        ];
        const fake = scriptedLlm([mkBatch({ itemId: "w2", checks: okChecks })]);
        const r = await createArchitectAgent({ llm: fake.llm })
            .decomposeBatch({ requirement: REQ, blueprint: bp, item: w2, deliveredCheckIds: [] });
        expect(r.attempts).toBe(1); // 全命中：一次都不该拒

        // 对穿：凭空多一段/少一段仍然必须拒（闸没被放宽成摆设）
        const bad = scriptedLlm([
            mkBatch({ itemId: "w2", checks: [{ id: "v-9", kind: "CONTRACT", method: "GET", path: "/api/notes/1/2", expectedStatus: 200 }] }),
            mkBatch({ itemId: "w2", checks: okChecks }),
        ]);
        const r2 = await createArchitectAgent({ llm: bad.llm })
            .decomposeBatch({ requirement: REQ, blueprint: bp, item: w2, deliveredCheckIds: [] });
        expect(r2.attempts).toBe(2);
        expect(r2.rejections[0]).toContain("/api/notes/1/2");
    });

    it("批次身份：模型谎报 itemId/projectId 也被代码盖成入参（镜像蓝图纪律）", async () => {
        const bp = parsedBlueprint();
        const w2 = workItemOf(bp, 1);
        const fake = scriptedLlm([{
            type: "architect_batch", projectId: "evil-p", taskId: "evil-t",
            itemId: "w99", // 谎报：既不是入参项也不是蓝图序
            detail: "d", checks: [AC_NOTES],
        }]);
        const agent = createArchitectAgent({ llm: fake.llm });
        const r = await agent.decomposeBatch({
            requirement: REQ, blueprint: bp, item: w2, deliveredCheckIds: ["ac-1", "ac-2"],
            projectId: "px", taskId: "py",
        });

        expect(r.batch.itemId).toBe("w2"); // 以入参工作项为准
        expect(r.batch.projectId).toBe("px");
        expect(r.batch.taskId).toBe("py");
    });

    it("detail 为空 → zod 形状闸拒（min(1)），拒因指到 detail 路径", async () => {
        const bp = parsedBlueprint();
        const w2 = workItemOf(bp, 1);
        // 注意：mkBatch 自带 schema 校验，空 detail 进不了 fixture——直接喂原始对象
        const fake = scriptedLlm([
            { type: "architect_batch", projectId: "p1", taskId: "t1", itemId: "w2", detail: "", checks: [AC_NOTES] },
            mkBatch({ itemId: "w2", checks: [AC_NOTES] }),
        ]);
        const agent = createArchitectAgent({ llm: fake.llm });
        const r = await agent.decomposeBatch({
            requirement: REQ, blueprint: bp, item: w2, deliveredCheckIds: ["ac-1", "ac-2"],
        });

        expect(r.attempts).toBe(2);
        expect(r.rejections[0]).toContain("批次形状不对");
        expect(r.rejections[0]).toContain("detail");
    });

    it("批次 prompt 组装：蓝图 JSON + 目标工作项 + 已交付 id 清单全在 user 文本里", async () => {
        const bp = parsedBlueprint();
        const w2 = workItemOf(bp, 1);
        const fake = scriptedLlm([mkBatch({ itemId: "w2", checks: [AC_NOTES] })]);
        const agent = createArchitectAgent({ llm: fake.llm });
        await agent.decomposeBatch({
            requirement: REQ, blueprint: bp, item: w2, deliveredCheckIds: ["ac-1", "ac-2"],
        });

        const user = fake.tasks[0];
        expect(user).toContain(REQ);
        expect(user).toContain(JSON.stringify(bp, null, 2));        // 蓝图全文（跨项一致性之锚）
        expect(user).toContain(JSON.stringify(w2, null, 2));        // 目标工作项
        expect(user).toContain("ac-1");                             // 已交付判据清单
        expect(user).toContain("ac-2");
        expect(user).toContain("禁止增删工作项");                    // 边界话术在位
    });
});

describe("architectAgent / assembleTask（确定性装配）", () => {
    it("全批装配：detail 入位、判据按蓝图→批次顺序合并、重复 id 首个赢、不污染入参", () => {
        const bp = parsedBlueprint();
        const before = JSON.stringify(bp);
        const task = assembleTask(bp, [
            mkBatch({ itemId: "w1", detail: "D1", checks: [] }),
            mkBatch({ itemId: "w2", detail: "D2", checks: [AC_NOTES] }),
            mkBatch({ itemId: "w3", detail: "D3", checks: [
                { id: "ac-1", kind: "COMPILE", target: "backend" }, // 撞蓝图底线 → first-wins 丢弃
                { id: "ac-4", kind: "CONTRACT", method: "POST", path: "/api/notes", expectedStatus: 201 },
            ] }),
            mkBatch({ itemId: "w4", detail: "D4", checks: [] }),
        ]);

        expect(task.foundationPlan.workItems!.map((w) => w.detail)).toEqual(["D1", "D2", "D3", "D4"]);
        expect(task.acceptanceChecks.map((c) => c.id)).toEqual(["ac-1", "ac-2", "ac-3", "ac-4"]);
        expect(parseInbound(JSON.stringify(task)).ok).toBe(true); // 它是 architect_task，同链路
        expect(JSON.stringify(bp)).toBe(before);                  // 纯函数：入参原封不动
    });

    it("批次顺序违反蓝图前缀 → 抛错点名期望项（跳批/重批/超批都是链路 bug）", () => {
        const bp = parsedBlueprint();
        // 跳批：第一批就该是 w1
        expect(() => assembleTask(bp, [mkBatch({ itemId: "w2" })])).toThrow("w1");
        // 重批：w1 之后期望 w2，又来个 w1
        expect(() => assembleTask(bp, [mkBatch({ itemId: "w1" }), mkBatch({ itemId: "w1" })])).toThrow("w2");
        // 超批：蓝图只有 4 项
        expect(() => assembleTask(bp, [
            mkBatch({ itemId: "w1" }), mkBatch({ itemId: "w2" }),
            mkBatch({ itemId: "w3" }), mkBatch({ itemId: "w4" }),
            mkBatch({ itemId: "w5" }),
        ])).toThrow("已到末尾");
        // 身份串账
        expect(() => assembleTask(bp, [mkBatch({ itemId: "w1", projectId: "other-p" })])).toThrow("身份");
    });

    it("空前缀合法：只回蓝图（判据=底线、无 detail），产物过 parseInbound", () => {
        const bp = parsedBlueprint();
        const task = assembleTask(bp, []);
        expect(task.acceptanceChecks.map((c) => c.id)).toEqual(["ac-1", "ac-2"]);
        expect(task.foundationPlan.workItems!.every((w) => w.detail === undefined)).toBe(true);
        expect(parseInbound(JSON.stringify(task)).ok).toBe(true);
    });
});

describe("architectAgent / 提示词 fail-fast", () => {
    it("promptDir 注入坏目录：缺文件/空文件都在 createArchitectAgent 抛错并点名文件，一次 LLM 都不调", () => {
        const fake = scriptedLlm([JSON.stringify(VALID_BLUEPRINT)]);
        const dir = mkdtempSync(join(tmpdir(), "arch-prompts-"));
        const write = (name: string, text: string) => writeFileSync(join(dir, name), text, "utf-8");

        // ① 空目录：第一个要读的文件（architect-blueprint.md）就 ENOENT
        expect(() => createArchitectAgent({ llm: fake.llm, promptDir: dir })).toThrow("architect-blueprint.md");
        // ② 蓝图提示词有、_check-shape.md 是空白 → fail fast 且点名共享文件
        write("architect-blueprint.md", "y");
        write("_check-shape.md", "   \n");
        expect(() => createArchitectAgent({ llm: fake.llm, promptDir: dir })).toThrow("_check-shape.md");
        // ③ 共享节补上，只剩批次提示词文件没部署 → 构造期就抛，不留"跑到第二批才发现"的后患
        write("_check-shape.md", "z");
        expect(() => createArchitectAgent({ llm: fake.llm, promptDir: dir })).toThrow("architect-batch.md");
        expect(fake.count()).toBe(0);
    });
});

// ============================================================
// A2 生成期占位符闸：引用未由 setup 抽取的 {var} → 该批被拒（喂回原话重出）
//   治 p7 那 13 条（path 用 {id}、setup 抽成 {tid}）——生成期拦下，不留给执行期伪装成 404。
describe("A2 生成期占位符闸：placeholderGateGaps", () => {
    it("path 引用未抽取的 {id} → 出闸（含变量对照：缺 id、抽的是 pid）", () => {
        const gaps = placeholderGateGaps([
            {
                id: "ac-30", kind: "CONTRACT", method: "POST", path: "/api/projects/{id}/tasks",
                setup: [{ method: "POST", path: "/api/projects", extract: { name: "pid", from: "data.id" } }],
            },
        ]);
        expect(gaps.length).toBe(1);
        expect(gaps[0]).toContain("ac-30");
        expect(gaps[0]).toContain("{id}");
        expect(gaps[0]).toContain("{pid}");
    });

    it("setup 已声明用到的变量 → 放行；非 CONTRACT 判据不参与闸", () => {
        expect(placeholderGateGaps([
            {
                id: "ok", kind: "CONTRACT", method: "GET", path: "/api/tasks/{tid}",
                setup: [{ method: "POST", path: "/api/tasks", extract: { name: "tid", from: "id" } }],
            },
            // 命令类判据没有占位符概念 → 一律放行（哪怕正文里有 `{whatever}` 这种字面量）
            { id: "c1", kind: "COMPILE", command: "npm", args: ["run", "build"] },
            { id: "c2", command: "echo {whatever}" },
        ])).toEqual([]);
    });

    it("与 A1 同一判定：空 setup + path 带占位符 → 出闸（不误放）", () => {
        const gaps = placeholderGateGaps([{ id: "x", kind: "CONTRACT", method: "GET", path: "/api/x/{rid}" }]);
        expect(gaps.length).toBe(1);
        expect(gaps[0]).toContain("没有任何 setup 抽取变量");
    });
});
