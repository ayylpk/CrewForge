// tests/architectAgent.test.ts —— architectAgent 的零 LLM 单测（Fake LLM，全程不联网）
//
//   被测链路：decompose(需求文本) → LLM 吐 JSON → 五道校验链
//     ① extractJson 抠包 → ② 权威字段闸 → ③ zod 形状 → ④ 业务硬闸 → ⑤ parseInbound 终验
//   Fake 策略照抄 fake-loop.test.ts 的 scripted 风格：预置 decisions 按调用次序吐出，
//   并记录每次 next 收到的 task 文本（断言"被拒原因喂回重试"的反馈环）。
import { describe, expect, it } from "bun:test";
import { createArchitectAgent } from "../architectAgent";
import { parseInbound } from "../protocol";
import type { DeveloperLlm } from "../graph";

/** 需求原文 fixture：一句话小项目，够所有校验链吃 */
const REQ = "做一个便签管理小工具：可新增、查看、删除便签。";

/**
 * 合法任务包 fixture——能一口气过全部五道校验链。
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

/**
 * 照抄型 Fake：从 prompt 里抠出 projectId/taskId 并"照抄"进任务包——
 * 模拟真实模型行为（身份是架构师从 prompt 抄进 JSON 的，agent 不做强行覆盖）。
 */
function echoIdentityLlm() {
    let calls = 0;
    const llm: DeveloperLlm = {
        id: "fake-echo",
        calls: () => calls,
        async next(input) {
            calls++;
            const p = /projectId:\s*(\S+)/.exec(input.task)?.[1] ?? "p1";
            const t = /taskId:\s*(\S+)/.exec(input.task)?.[1] ?? "t1";
            return JSON.stringify({ ...VALID_TASK, projectId: p, taskId: t });
        },
    };
    return { llm, count: () => calls };
}

describe("architectAgent / 零 LLM 校验链", () => {
    it("一次成功：合法 JSON 直接通过，attempts=1、rejections 空", async () => {
        const fake = scriptedLlm([JSON.stringify(VALID_TASK)]);
        const agent = createArchitectAgent({ llm: fake.llm });
        const result = await agent.decompose({ requirement: REQ });

        expect(fake.count()).toBe(1);
        expect(result.attempts).toBe(1);
        expect(result.rejections).toEqual([]);
        // 关键字段逐个对（不是整对象 toEqual——zod parse 会补 looseObject 之外的无关差异）
        expect(result.task.type).toBe("architect_task");
        expect(result.task.projectId).toBe("p1");
        expect(result.task.taskId).toBe("t1");
        expect(result.task.requirementSnapshot.goal).toBe("便签管理");
        expect(result.task.stackProfile.backend).toBe("node+express");
        expect(result.task.foundationPlan.dirs).toEqual(["backend", "frontend"]);
        expect(result.task.foundationPlan.workItems?.length).toBe(4);
        expect(result.task.acceptanceChecks.length).toBe(1);
        expect(result.task.allowedRoots).toEqual(["backend", "frontend"]);
        expect(result.task.developerInstructions).toBe("按顺序做");
    });

    it("反馈环：空 acceptanceChecks 被业务闸拒 → 被拒原因进第二次 prompt → 第二次成功", async () => {
        // 第 1 次：schema 层合法但验收判据为空 → 业务硬闸拒
        const fake = scriptedLlm([{ ...VALID_TASK, acceptanceChecks: [] }, VALID_TASK]);
        const agent = createArchitectAgent({ llm: fake.llm });
        const result = await agent.decompose({ requirement: REQ });

        expect(fake.count()).toBe(2);
        expect(result.attempts).toBe(2);
        expect(result.rejections.length).toBe(1);
        expect(result.rejections[0]).toContain("acceptanceChecks 不能为空");
        // ★ 反馈环证据：第二次 prompt 必须带上第一次被拒的原因摘要 + 修正指令 + 原始需求
        expect(fake.tasks[1]).toContain("acceptanceChecks 不能为空");
        expect(fake.tasks[1]).toContain("必须修正");
        expect(fake.tasks[1]).toContain(REQ);
    });

    it("重试耗尽：maxAttempts=2 两次都吐非 JSON → 抛错含最后一次原因，且不超发", async () => {
        const fake = scriptedLlm(["完全不是 JSON 的输出", "还是不是 JSON"]);
        const agent = createArchitectAgent({ llm: fake.llm, maxAttempts: 2 });
        // 最后一次拒绝原因 = "输出里找不到合法 JSON 对象……" → 错误信息含 "JSON"
        await expect(agent.decompose({ requirement: REQ })).rejects.toThrow("JSON");
        expect(fake.count()).toBe(2); // 恰好两次，不多烧
    });

    it("runner 兼容终验：成功产物过 parseInbound 同链路 → ok=true", async () => {
        const fake = scriptedLlm([JSON.stringify(VALID_TASK)]);
        const agent = createArchitectAgent({ llm: fake.llm });
        const result = await agent.decompose({ requirement: REQ });

        const inbound = parseInbound(JSON.stringify(result.task));
        if (!inbound.ok) throw new Error(`runner 入站校验意外失败：${inbound.error}`);
        expect(inbound.message.type).toBe("architect_task");
    });

    it("权威字段拦截：requirementSnapshot 里夹带 done → 闸先于 zod 拒收 → 反馈后自愈", async () => {
        // 顶层加 done 会被严格 z.object 直接拒（测不到闸的优先级），
        // 所以塞进 looseObject 的 requirementSnapshot：zod 放行、authority 闸必须先拦。
        const fake = scriptedLlm([
            { ...VALID_TASK, requirementSnapshot: { goal: "x", done: true } },
            VALID_TASK,
        ]);
        const agent = createArchitectAgent({ llm: fake.llm });
        const result = await agent.decompose({ requirement: REQ });

        expect(result.attempts).toBe(2);
        expect(result.rejections[0]).toContain("权威字段");
        expect(result.rejections[0]).toContain("requirementSnapshot.done"); // 指名道姓到路径
        expect(fake.tasks[1]).toContain("权威字段"); // 拒因同样喂回了第二轮
    });

    it("围栏/叙述里的 JSON 能抠出：```json 围栏 + 前后叙述文字 → 一次成功", async () => {
        const fake = scriptedLlm(["架构师分析如下：\n```json\n" + JSON.stringify(VALID_TASK) + "\n```"]);
        const agent = createArchitectAgent({ llm: fake.llm });
        const result = await agent.decompose({ requirement: REQ });

        expect(fake.count()).toBe(1);
        expect(result.attempts).toBe(1);
        expect(result.task.taskId).toBe("t1");
    });

    it("身份缺省注入：不传 → p1/t1；传了 → 用传入值（身份经 prompt 传递、模型照抄）", async () => {
        // ① 不传身份：prompt 注入缺省 p1/t1
        const d = echoIdentityLlm();
        const r1 = await createArchitectAgent({ llm: d.llm }).decompose({ requirement: REQ });
        expect(r1.task.projectId).toBe("p1");
        expect(r1.task.taskId).toBe("t1");

        // ② 显式传入：身份出现在 prompt 里并被照抄进任务包
        const c = echoIdentityLlm();
        const r2 = await createArchitectAgent({ llm: c.llm })
            .decompose({ requirement: REQ, projectId: "p2", taskId: "t9" });
        expect(r2.task.projectId).toBe("p2");
        expect(r2.task.taskId).toBe("t9");
    });

    it("空需求 fail fast：空串/纯空白直接拒绝，一次 LLM 都不调", async () => {
        const fake = scriptedLlm([JSON.stringify(VALID_TASK)]);
        const agent = createArchitectAgent({ llm: fake.llm });
        await expect(agent.decompose({ requirement: "" })).rejects.toThrow("需求文本为空");
        await expect(agent.decompose({ requirement: "   \n\t  " })).rejects.toThrow("需求文本为空");
        expect(fake.count()).toBe(0);
    });
});
