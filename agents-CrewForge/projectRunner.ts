// ============================================================
// projectRunner.ts —— 项目级编排入口
//
//   main 入口：项目 id → 读成员（sys_project_agent JOIN sys_agent 带出角色）
//   → 按角色分派构造（图版读项目节点拼图；消息版读节点 prompt）
//   → 启动消息版团队 → Manager 对话确认需求 → 桥接 phase_plan 逐阶段下发架构师
//
//   角色（中文 label）→ 类：
//     项目经理 → Manager（图版：项目节点 + 池边 → stitch → runWithInteraction）
//     架构师   → Architect（消息版 + 拆分图，收 phase_plan）
//     后端开发 → BackendEngineer（流水线：节点「伪代码/代码实现」prompt）
//     前端开发 → FrontendEngineer（流水线：节点「页面设计/代码实现」prompt）
//     测试     → TestEngineer（判定：节点「测试判定」prompt）
//     维护     → Maintainer（纯逻辑收敛，无 LLM 无节点）
//   Merger/Maintainer 是系统内置单例，无论项目成员如何配置都注册（流水线必需）。
// ============================================================

import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { TransferStation, roles } from "./Hub";
import type { BaseAgent } from "./BaseAgent";
import { Manager } from "./manager";
import { Architect } from "./architect";
import { Merger } from "./merger";
import { BackendEngineer } from "./backendEngineer";
import { FrontendEngineer } from "./frontendEngineer";
import { TestEngineer } from "./testEngineer";
import { Maintainer } from "./maintainer";
import { getProjectAgents, getProjectNodes, getEdges, getProjectConfirmMode, getProjectRequirement } from "./Node";
import { CliQuestioner, type Questioner } from "./GraphFactory";


export interface TeamBundle {
    station: TransferStation;
    messageAgents: BaseAgent[];
    managers: Manager[];
}

/** 读项目成员 → 按角色分派构造（Merger/Maintainer 系统内置无条件注册） */
export async function buildTeam(
    projectId: number,
    station: TransferStation = new TransferStation({}, {}),
): Promise<TeamBundle> {
    const members = await getProjectAgents(projectId);
    const messageAgents: BaseAgent[] = [];
    const managers: Manager[] = [];

    // 系统内置单例：合并配对 + 收敛完成（流水线必需，不依赖项目成员配置）
    messageAgents.push(new Merger(station));
    messageAgents.push(new Maintainer(station));

    for (const m of members) {
        const nodes = await getProjectNodes(projectId, m.agentId);
        switch (m.role) {
            case "项目经理":
                managers.push(await Manager.fromProject(projectId, m.agentId));
                console.log(`[runner] 项目经理 ${m.name}：图版，节点 ${nodes.length} 个`);
                break;
            case "架构师":
                // 节点/边缺一 → 整体退内置 DEFAULT_NODES/DEFAULT_EDGES（构造器默认参）——
                // 半套 DB 配置（有边无节点）会让 stitch 编译崩死（9/2 验收：软删遗留池边撞库实锤）
                {
                    const edges = await getEdges(m.agentId);
                    messageAgents.push(nodes.length > 0 && edges.length > 0
                        ? new Architect(station, nodes, edges)
                        : new Architect(station));
                }
                console.log(`[runner] 架构师 ${m.name}：消息+拆分图，${nodes.length > 0 ? `DB 配置（节点 ${nodes.length} 个）` : "内置默认图"}`);
                break;
            case "后端开发":
                messageAgents.push(new BackendEngineer(`backend-${m.agentId}`, station, nodes));
                console.log(`[runner] 后端开发 ${m.name}：流水线，节点 ${nodes.length} 个`);
                break;
            case "前端开发":
                messageAgents.push(new FrontendEngineer(`frontend-${m.agentId}`, station, nodes));
                console.log(`[runner] 前端开发 ${m.name}：流水线，节点 ${nodes.length} 个`);
                break;
            case "测试":
                messageAgents.push(new TestEngineer(`test-${m.agentId}`, station, nodes));
                console.log(`[runner] 测试 ${m.name}：判定，节点 ${nodes.length} 个`);
                break;
            case "维护":
                // Maintainer 已作为系统内置注册，成员里的"维护"不重复实例化
                console.log(`[runner] 维护 ${m.name}：使用系统内置 Maintainer（纯逻辑收敛）`);
                break;
            default:
                console.log(`[runner] 角色「${m.role}」无实现类，跳过：${m.name}`);
        }
    }
    return { station, messageAgents, managers };
}

/** 项目级主流程：建团队 → 消息版常驻 → PM 多轮对话定稿 → 逐阶段下发架构师 → 等待收敛 */
export async function runProject(projectId: number, questioner: Questioner): Promise<void> {
    const { station, messageAgents, managers } = await buildTeam(projectId);

    // 1. 消息版团队常驻：start() 内含 while(true) 消息循环**永不 resolve**，必须 fire-and-forget
    //    （9/2 阶段1验收逮到的真 bug：await 会把主流程卡死在 PM 对话之前，零 LLM 请求）
    for (const a of messageAgents) {
        void a.start().catch((e) => console.error("[runner] agent 消息循环异常退出:", e));
    }

    // ★ fail-fast：必需角色缺席=消息投进 Hub 惰性空箱、无人消费，waitForMessage 死等
    //   （9/2 阶段1验收血泪：项目1 没配架构师成员，流水线静默挂死零日志）
    const need: { label: string; ok: () => boolean }[] = [
        { label: "架构师", ok: () => !!station.status["architect"] },
        { label: "测试", ok: () => Object.values(station.status).some((s) => s.role === roles.testEngineer) },
        { label: "后端开发", ok: () => Object.values(station.status).some((s) => s.role === roles.backendEngineer) },
        { label: "前端开发", ok: () => Object.values(station.status).some((s) => s.role === roles.frontendEngineer) },
    ];
    const missing = need.filter((n) => !n.ok()).map((n) => n.label);
    if (missing.length > 0) {
        console.error(`[runner] ⚠️ 团队缺席「${missing.join("、")}」——请先到团队视图配齐成员再开工（本轮中止，不空烧 LLM）`);
        process.exit(2);
    }

    // 2. 图版 Manager：PM 多轮对话直到需求定稿（flag=true）
    //    注意：同 thread 下 messages 由 reducer 追加，每轮只传"用户新输入"，不传全量（避免重复）
    for (const manager of managers) {
        const thread = `project-${projectId}`;
        // ★ B2 需求注入：PM 对话是纯 messages 上下文——先把库里需求作为开场白喂进去。
        //   缺这步，全绿灯模式对着空气喊"定稿"，PM 按契约拒绝空功能清单（9/2 阶段1验收实锤）。
        const requirement = await getProjectRequirement(projectId);
        if (!requirement) console.warn("[runner] ⚠️ 项目 description/clarified_req 均为空——PM 无法提炼功能，请先在网页端填写需求");
        const seed = requirement ? [new HumanMessage(`【项目需求】\n${requirement}`)] : [];
        let state: any = await manager.run({ messages: seed, projectId }, thread, questioner);
        // 读取项目确认模式：全绿灯(0) → 一次都不确认，自动定稿
        let confirmMode = 0;
        try { confirmMode = await getProjectConfirmMode(projectId); } catch { /* 默认 0 */ }
        const isAuto = confirmMode === 0;
        if (isAuto) console.log("[runner] 全绿灯模式：自动推进，无需人工确认");

        let turns = 0;
        while (!state?.flag && turns < 30) {
            const reply = state?.messages?.at(-1);
            if (reply) {
                const text = typeof reply.content === "string" ? reply.content : JSON.stringify(reply.content);
                console.log(`\n[PM] ${text}`);
            }
            // 全绿灯模式：自动输入"定稿"跳过 PM 对话
            if (isAuto) {
                console.log("[runner] 全绿灯模式：自动定稿");
                state = await manager.run({ messages: [new HumanMessage("定稿")], projectId }, thread, questioner);
                turns++;
                continue;
            }
            const userInput = await questioner.ask({
                questionId: `pm-${projectId}-${turns}`,
                prompt: "（输入下一句需求；输入 定稿 结束需求确认）",
                options: ["定稿"],
            });
            state = await manager.run({ messages: [new HumanMessage(userInput)], projectId }, thread, questioner);
            turns++;
        }
        if (turns >= 30) console.log("[runner] PM 对话轮次超限，中止");

        const plan = state?.plan;
        if (!plan || !Array.isArray(plan.phases) || plan.phases.length === 0) {
            console.log("[runner] 需求未产出 plan（用户未定稿），流程结束");
            continue;
        }

        // 3. ★ 阶段流转：逐阶段发 phase_plan 给架构师，等 phase_request 再发下一阶段
        //    （architect 收 maintainer 的 phase_done 后发 phase_request 给 manager —— runner 代为响应）
        const phases: any[] = plan.phases;
        for (let i = 0; i < phases.length; i++) {
            station.sendMessage("manager", "architect", JSON.stringify({ type: "phase_plan", plan, phase: phases[i], projectId }));
            console.log(`[runner] → 架构师：阶段 ${phases[i].phase}「${phases[i].name}」`);
            if (i < phases.length - 1) {
                const req = await station.waitForMessage("manager");
                const data = req ? JSON.parse(req.content) : null;
                console.log(`[runner] 收到架构师请求：${data?.type ?? "?"}（阶段 ${data?.phase ?? "?"}）`);
            }
        }
        // 4. 最后一个阶段：再收一次 phase_request（或阶段完成），确认流水线走完
        const last = await station.waitForMessage("manager");
        const lastData = last ? JSON.parse(last.content) : null;
        console.log(`[runner] 流水线完成：${lastData?.type ?? "无后续请求"}`);
    }

    console.log("[runner] 流程结束（Ctrl+C 退出）");
}

// ---------- CLI 入口（沙箱：命令行或 Java spawn 直接启动） ----------
// 用法：bun run projectRunner.ts 5    或    PROJECT_ID=5 bun run projectRunner.ts
if (import.meta.main) {
  const fromArgv = Number(process.argv[2]);
  const projectId = Number.isInteger(fromArgv) && fromArgv > 0
    ? fromArgv
    : Number(process.env.PROJECT_ID);

  if (!projectId || !Number.isInteger(projectId) || projectId <= 0) {
    console.error("用法: bun run projectRunner.ts {projectId}（或设置环境变量 PROJECT_ID）");
    process.exit(1);
  }

  console.log(`[runner] 启动项目 ${projectId}...`);
  runProject(projectId, new CliQuestioner())
    .then(() => {
      console.log("[runner] 流程结束，进程退出");
      process.exit(0);
    })
    .catch((e) => {
      console.error("[runner] 进程异常退出:", e);
      process.exit(1);
    });
}
