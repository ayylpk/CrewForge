// ============================================================
// tests/pm-output.test.ts —— PM 内容产面的零 LLM 零 DB 全链路测试
//   （解耦测试第一项："PM 是否会产出项目内容"）
//
//   三个外部能力（chat/refine/plan）与提问（askUser）全部 fake 注入：
//   不碰网络、不碰 MySQL、不碰 Hub/LangGraph——generatePmContent 是纯函数面。
//   覆盖：
//     ① 对话→澄清需求：文档结构断言（renderClarifiedReqMarkdown）
//     ② phase_plan 载荷形状过 architect 消费端字段（PhasePlanMessageSchema + 按名过滤非空）
//     ③ 多阶段计划顺序稳定 + 确定性复跑
//     ④ 缺输入报错显式（空需求/坏 projectId/定稿零功能/无人可问/细化空/规划缺字段）
//     ⑤ 产出可序列化往返
//     ⑥ UI 三问未采集：补写轮 → 机械兜底 defaulted
//     ⑦ 全绿灯单轮定稿（无提问者也能收敛）
// ============================================================

import { describe, expect, it } from "bun:test";
import type { BaseMessage } from "@langchain/core/messages";
import {
    generatePmContent, renderClarifiedReqMarkdown, toPhasePlanPayloads,
    PM_FEATURES_REPAIR_PROMPT, PM_UI_REPAIR_PROMPT,
} from "../manager";
import type { FunctionItem, PmContentDeps, PmContentResult, PlanCore, typeOfTasks } from "../manager";
import { PhasePlanMessageSchema } from "../messageProtocol";

// ---------- fixtures：充当「PM 的 LLM 回复」「细化/规划的模型输出」 ----------

const CORE: PlanCore = {
    project: "便签应用",
    phases: [
        { phase: 1, name: "地基", goal: "登录与工程框架", features: ["用户登录"], dependencies: [], relative_effort: "中", risk: "高" },
        { phase: 2, name: "便签业务", goal: "便签增删改查", features: ["便签列表"], dependencies: ["地基"], relative_effort: "小", risk: "低" },
        { phase: 3, name: "打磨", goal: "体验优化与部署", features: ["便签列表"], dependencies: ["便签业务"], relative_effort: "小", risk: "低" },
    ],
    mvp_scope: ["用户登录", "便签列表"],
    risks: ["多用户数据越权"],
};

const ROUND1 = '明白了：便签应用要先登录、再看自己的列表。第一功能确认吗？\n{"features":[{"name":"用户登录","description":"账号密码注册登录","priority":"高","acceptance":"错误密码登录失败并提示"}]}';
const ROUND2 = '{"features":[{"name":"便签列表","description":"展示当前用户全部便签","priority":"中","acceptance":"列表只返回本人便签"}],"done":true,"ui":{"web":true,"pages":["登录","主页"],"style":"深蓝科技感"}}';

/** 细化 fake：保持功能名一一对应（生产契约：不合并、不拆分）。
 *  对话面 FunctionItem 类型只有 name/description，但 LLM JSON 实际携带 priority/acceptance
 *  （parsePMResponseText 原样 spread 进 clarifiedReq）——这里按运行时形状取回。 */
function fakeRefine(functions: FunctionItem[]): typeOfTasks[] {
    return functions.map((f) => {
        const src = f as FunctionItem & Partial<typeOfTasks>;
        return { name: src.name, description: `细化：${src.description}`, priority: src.priority ?? "中", acceptance: src.acceptance ?? "可验证" };
    });
}

function makeDeps(
    replies: string[],
    opts: { answers?: string[]; tasks?: (f: FunctionItem[]) => typeOfTasks[]; core?: unknown } = {},
) {
    const calls = {
        chats: 0,
        refineInputs: [] as FunctionItem[][],
        planInputs: [] as typeOfTasks[][],
        seen: [] as BaseMessage[][],   // 每次 chat 收到的完整消息（验证系统提示词/种子需求/补齐指令）
    };
    const queue = [...(opts.answers ?? [])];
    const deps: PmContentDeps = {
        chat: async (msgs) => {
            calls.seen.push(msgs);
            const text = replies[calls.chats];
            calls.chats += 1;
            if (text === undefined) throw new Error("fake chat：脚本回复用完");
            return text;
        },
        refine: async (functions) => { calls.refineInputs.push(functions); return (opts.tasks ?? fakeRefine)(functions); },
        plan: async (tasks) => { calls.planInputs.push(tasks); return (opts.core ?? CORE) as PlanCore; },
        log: () => { /* 测试静音 */ },
    };
    if (opts.answers) {
        deps.askUser = async () => {
            const a = queue.shift();
            if (a === undefined) throw new Error("fake askUser：脚本答案用完（产面不应再问）");
            return a;
        };
    }
    return { deps, calls };
}

const happyPath = async (): Promise<{ r: PmContentResult; calls: ReturnType<typeof makeDeps>["calls"] }> => {
    const { deps, calls } = makeDeps([ROUND1, ROUND2], { answers: ["都确认，定稿"] });
    const r = await generatePmContent(
        { requirement: "做一个多用户便签应用：用户注册登录后，可查看和管理自己的便签", projectId: 7 },
        deps,
    );
    return { r, calls };
};

// ============================================================

describe("PM 内容产面（generatePmContent，零 LLM 零 DB）", () => {

    it("① 对话 → 澄清需求：定稿产出结构化文档，规则齐活", async () => {
        const { r, calls } = await happyPath();
        expect(r.done).toBe(true);
        expect(r.turns).toBe(2);
        expect(r.projectId).toBe(7);

        // 全对话累积的确认功能进 clarified_req（DB 列同构）；refine 定稿时一次性拿全量
        expect(r.clarifiedReq.features.map((f) => f.name)).toEqual(["用户登录", "便签列表"]);
        expect(calls.refineInputs[0]?.map((f) => f.name)).toEqual(["用户登录", "便签列表"]);

        // plan.features 机械继承细化 tasks（LLM 不经手功能清单，同 plannerNode 约定）
        expect(r.plan.features.map((t) => t.description)).toEqual([
            "细化：账号密码注册登录", "细化：展示当前用户全部便签",
        ]);

        // UI 决策来自定稿轮原话（非兜底）
        expect(r.uiProfile.style).toBe("深蓝科技感");
        expect(r.uiProfile.defaulted).toBe(false);

        // 对话消息面：首轮 = 系统提示词 + 【项目需求】种子；用户答案在第二轮请求里
        const first = calls.seen[0]!;
        expect(String(first[0]?.content)).toContain("项目经理");
        expect(String(first[1]?.content)).toContain("【项目需求】");
        expect(String(calls.seen[1]?.at(-1)?.content)).toContain("都确认，定稿");   // 第二轮请求末尾=用户答案

        // 澄清需求文档结构（pm-cli clarified-req.md 同一渲染函数）
        const md = renderClarifiedReqMarkdown(r);
        expect(md).toContain("# 澄清需求 — 便签应用");
        expect(md).toContain("## UI 决策");
        expect(md).toContain("- Web 前端：要");
        expect(md).toContain("- 风格愿望：深蓝科技感");
        expect(md).toContain("### 1. 用户登录（优先级：高）");
        expect(md).toContain("- 验收：错误密码登录失败并提示");
        expect(md).toContain("## 阶段规划（3 个阶段，按执行顺序）");
        expect(md).toContain("### 阶段 2：便签业务");
        expect(md).toContain("- 依赖：地基");
        expect(md).toContain("## MVP 范围");
        expect(md).toContain("多用户数据越权");
    });

    it("② phase_plan 载荷过架构师消费端字段（messageProtocol 校验 + 按名过滤非空）", async () => {
        const { r } = await happyPath();
        expect(r.phasePlans.length).toBe(r.plan.phases.length);
        for (const p of r.phasePlans) {
            // Hub 传的是 JSON 字符串：序列化 → 反序列化 → 协议校验（runner drivePhases 的消息体形状）
            const wire = JSON.parse(JSON.stringify(p));
            const parsed = PhasePlanMessageSchema.safeParse(wire);
            expect(parsed.success).toBe(true);
            expect((parsed.data as any).phase.phase).toBe(p.phase.phase);
            expect((parsed.data as any).projectId).toBe(7);

            // architect.ts runPhaseSplit 消费姿势：plan.features 按 phase.features 名过滤——必须有名可对
            const kept = p.plan.features.filter((f) => p.phase.features.includes(f.name));
            expect(kept.length).toBeGreaterThan(0);

            // planItem 机器字段齐全（看板/续跑读回用）
            expect(typeof p.phase.goal).toBe("string");
            expect(Array.isArray(p.phase.dependencies)).toBe(true);
            expect(typeof p.phase.relative_effort).toBe("string");
        }
        // T5：UI 风格只挂阶段 1（机械注入），其余阶段不带
        expect(r.plan.phases[0]!.uiStyle).toContain("深蓝科技感");
        expect(r.plan.phases[0]!.uiStyle).toContain("登录、主页");
        expect(r.plan.phases[1]!.uiStyle).toBeUndefined();
    });

    it("③ 多阶段计划顺序稳定 + 同输入复跑逐字节一致", async () => {
        const { r } = await happyPath();
        expect(r.phasePlans.map((p) => p.phase.phase)).toEqual([1, 2, 3]);
        expect(r.phasePlans.map((p) => p.phase.name)).toEqual(["地基", "便签业务", "打磨"]);
        expect(toPhasePlanPayloads(r.plan, 7)).toEqual(r.phasePlans);

        // 再跑一遍相同脚本：plan/文档/载荷完全确定（无时间戳、无随机）
        const again = await happyPath();
        expect(JSON.stringify(again.r.plan)).toBe(JSON.stringify(r.plan));
        expect(renderClarifiedReqMarkdown(again.r)).toBe(renderClarifiedReqMarkdown(r));
    });

    it("④ 缺输入显式报错：每种坏输入都点名，不产半成品", async () => {
        // 需求原文为空
        await expect(generatePmContent({ requirement: "   ", projectId: 1 }, makeDeps([]).deps))
            .rejects.toThrow(/需求原文为空/);
        // projectId 非正整数
        await expect(generatePmContent({ requirement: "有需求", projectId: 0 }, makeDeps([]).deps))
            .rejects.toThrow(/projectId 必须是正整数/);
        // 未定稿且没有提问者 → 不静默空转
        await expect(generatePmContent({ requirement: "有需求", projectId: 1 }, makeDeps(["我先问一句：给谁用？"]).deps))
            .rejects.toThrow(/未提供提问者/);
        // 定稿零功能：补齐轮（共享文案常量）仍救不回 → 显式异常
        const noFeat = makeDeps(['{"done":true}', '{"done":true}']);
        await expect(generatePmContent({ requirement: "有需求", projectId: 1 }, noFeat.deps))
            .rejects.toThrow(/缺少功能清单/);
        expect(noFeat.calls.chats).toBe(2);   // 一轮定稿 + 一轮补齐
        expect(String(noFeat.calls.seen[1]?.at(-1)?.content)).toBe(PM_FEATURES_REPAIR_PROMPT);
        // 细化返回空 tasks
        const emptyTasks = makeDeps([ROUND2], { tasks: () => [] });
        await expect(generatePmContent({ requirement: "有需求", projectId: 1 }, emptyTasks.deps))
            .rejects.toThrow(/细化返回空/);
        // 规划 phases 为空
        const noPhases = makeDeps([ROUND2], { core: { project: "x", phases: [], mvp_scope: [], risks: [] } });
        await expect(generatePmContent({ requirement: "有需求", projectId: 1 }, noPhases.deps))
            .rejects.toThrow(/phases 为空/);
        // 阶段缺 name
        const badPhase = makeDeps([ROUND2], { core: { project: "x", phases: [{ phase: 1, goal: "g", features: [] }], mvp_scope: [], risks: [] } });
        await expect(generatePmContent({ requirement: "有需求", projectId: 1 }, badPhase.deps))
            .rejects.toThrow(/阶段 #1 缺 phase 号或 name/);
    });

    it("⑤ 产出可序列化往返（落库/过 Hub 都是 JSON 字符串，必须无损）", async () => {
        const { r } = await happyPath();
        const round = (v: unknown) => JSON.parse(JSON.stringify(v));
        expect(round(r.plan)).toEqual(r.plan);
        expect(round(r.clarifiedReq)).toEqual(r.clarifiedReq);
        expect(round(r.phasePlans)).toEqual(r.phasePlans);
        expect(round(r.uiProfile)).toEqual(r.uiProfile);
        // dev_plan 列形态可被续跑读回校验（usablePhases 同款机器判据）
        const planAgain = round(r.plan);
        expect(planAgain.phases.every((p: any) => Number.isInteger(Number(p.phase)) && typeof p.name === "string" && p.name)).toBe(true);
    });

    it("⑥ UI 三问没问到：补写一轮仍缺 → 机械兜底 defaulted 全程可见", async () => {
        const { deps, calls } = makeDeps(
            [ROUND1, '{"features":[{"name":"便签列表","description":"列便签","priority":"中","acceptance":"只看得到自己的"}],"done":true}', "我去补问：①②③还没答"],
            { answers: ["功能就这两个，定稿"] },
        );
        const r = await generatePmContent({ requirement: "便签应用", projectId: 3 }, deps);
        expect(calls.chats).toBe(3);   // 两轮对话 + 一轮 UI 补写
        expect(String(calls.seen[2]?.at(-1)?.content)).toBe(PM_UI_REPAIR_PROMPT);
        expect(r.uiProfile.defaulted).toBe(true);
        expect(r.uiProfile.web).toBe(true);
        expect(r.plan.uiProfile?.defaulted).toBe(true);
        expect(r.plan.phases[0]!.uiStyle).toContain("【默认值：UI 三问未获用户亲答】");
        // 兜底不吞功能：clarified/细化照常
        expect(r.clarifiedReq.features.length).toBe(2);
        expect(r.plan.features.length).toBe(2);
    });

    it("⑦ 全绿灯单轮定稿：features+done+ui 一条回复带齐，无需提问者", async () => {
        const GREEN = '{"features":[{"name":"登录","description":"账密登录","priority":"高","acceptance":"发 token"},{"name":"列表","description":"我的便签","priority":"中","acceptance":"只看本人"}],"done":true,"ui":{"web":true,"pages":["登录","主页"],"style":"白色简洁"}}';
        const { deps, calls } = makeDeps([GREEN]);
        const r = await generatePmContent({ requirement: "极简便签应用", projectId: 1 }, deps);
        expect(r.turns).toBe(1);
        expect(calls.chats).toBe(1);               // 契约齐 → 没有补齐/补写轮
        expect(r.clarifiedReq.features.length).toBe(2);
        expect(r.phasePlans.map((p) => p.phase.phase)).toEqual([1, 2, 3]);
        expect(r.uiProfile.style).toBe("白色简洁");
    });

    it("⑧ 补齐轮救活：定稿零功能 → 按指令补出清单 → 正常出全套产物", async () => {
        const { deps, calls } = makeDeps([
            '{"done":true}',
            '{"features":[{"name":"打卡","description":"每日打卡","priority":"高","acceptance":"一天一次"}],"done":true,"ui":{"web":false,"pages":[],"style":"不要前端"}}',
        ]);
        const r = await generatePmContent({ requirement: "习惯打卡应用", projectId: 9 }, deps);
        expect(calls.chats).toBe(2);
        expect(r.clarifiedReq.features.map((f) => f.name)).toEqual(["打卡"]);
        expect(r.uiProfile.web).toBe(false);
        expect(r.plan.phases[0]!.uiStyle).toContain("无前端，仅后端/API");
        expect(renderClarifiedReqMarkdown(r)).toContain("- Web 前端：不要");
    });
});
