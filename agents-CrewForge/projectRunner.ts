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
import { getProjectAgents, getProjectNodes, getEdges, getProjectConfirmMode, getProjectRequirement, getProjectPlan, updateProjectField } from "./Node";
import { type Questioner } from "./GraphFactory";
import { pickQuestioner } from "./confirm";
import { closeTaskBridge, getTasksByProject, type Task } from "./task";   // 出口保险：退出前冲干净在途 sys_task 写（9/3 run10 T4 竞态）
import { archiveProjectDir } from "./runEnv";
import { refreshSettings } from "./settings";


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

/** plan 形状校验（阶段 2 续跑用）：网页手填的 dev_plan 可能不对版，phases 非空且每阶段有数字 phase+name 才可用 */
function usablePhases(plan: unknown): any[] | null {
    const phases = (plan as any)?.phases;
    if (!Array.isArray(phases) || phases.length === 0) return null;
    const ok = phases.every((p: any) => Number.isInteger(Number(p?.phase)) && typeof p?.name === "string" && p.name);
    return ok ? phases : null;
}

/**
 * 断点续跑定位：第一个"没做完"的阶段下标。
 * 阶段完成 = sys_task 里该 phase 有行且每行都是定论（done 通过 / failed 放弃或待重做）。
 * ⚠️ failed 算定论是刻意的：failed→返工是**进程内** merger/maintainer 阶梯的事，跨进程重启后
 *    bridgeTasks 只吃 todo 不吃 failed——若把它算未完成，对账器会无限重拆死循环；
 *    人想把 failed 捡回来就在看板点重跑（变 todo），前端"开工"按钮再拉进程自然复活。
 * 返回 phases.length 表示全部完成；无行阶段=没拆过任务，从这里开工。
 */
export async function findResumeIndex(projectId: number, phases: any[]): Promise<number> {
    const tasks = await getTasksByProject(projectId);
    const byPhase = new Map<number, Task[]>();
    for (const t of tasks) {
        if (t.phase_id == null) continue;
        (byPhase.get(t.phase_id) ?? byPhase.set(t.phase_id, []).get(t.phase_id)!).push(t);
    }
    for (let i = 0; i < phases.length; i++) {
        const rows = byPhase.get(Number(phases[i].phase)) ?? [];
        if (rows.length === 0 || rows.some((r) => r.status !== "done" && r.status !== "failed")) return i;
    }
    return phases.length;
}

/**
 * 逐阶段下发架构师，等到每个阶段的 phase_request（阶段边界信号）。
 * 返回 "done"=全部阶段收工；"boundary"=在阶段边界主动收工（EXIT_AT_PHASE_BOUNDARY=1，
 * Java 对账器会拉下一个进程从续跑点接着干——9/2 拍板"按阶段起进程"，断点续跑白送）。
 */
async function drivePhases(
    station: TransferStation,
    projectId: number,
    plan: unknown,
    phases: any[],
    startIdx: number,
    exitAtBoundary: boolean,
): Promise<"done" | "boundary"> {
    for (let i = startIdx; i < phases.length; i++) {
        const isLast = i === phases.length - 1;
        station.sendMessage("manager", "architect", JSON.stringify({ type: "phase_plan", plan, phase: phases[i], projectId }));
        console.log(`[runner] → 架构师：阶段 ${phases[i].phase}「${phases[i].name}」`);
        // 收阶段边界：maintainer 发 phase_done → 架构师发 phase_request 给 manager —— runner 代为响应
        const req = await station.waitForMessage("manager");
        const data = req ? JSON.parse(req.content) : null;
        console.log(`[runner] 收到架构师请求：${data?.type ?? "?"}（阶段 ${data?.phase ?? "?"}）`);
        if (!isLast && exitAtBoundary) {
            console.log(`[runner] 阶段 ${phases[i].phase} 收口，按阶段边界退出（等 Java 对账续拉）`);
            return "boundary";
        }
    }
    return "done";
}

/** 项目级主流程：建团队 → 有 plan 直接开工（续跑），没有才 PM 对话 → 逐阶段下发 → 终态落库 */
export async function runProject(projectId: number, questioner: Questioner): Promise<void> {
    // 按阶段起进程模式（Java spawn 注入；手工跑默认关=旧行为单进程跑完全部阶段）
    const exitAtBoundary = process.env.EXIT_AT_PHASE_BOUNDARY === "1";
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
        // 配置错重拉也没用，直接终态，不留给对账器空转（阶段 2 孤儿回收配套）
        await updateProjectField(projectId, { status: "failed" }).catch(() => {});
        process.exit(2);
    }

    // 2. plan 来源二选一：DB 已有 dev_plan → 跳过 PM 对话直接开工（网页"确认方案→开工"零终端链路）；
    //    没有 → 图版 Manager 多轮对话直到定稿（终端手工跑的首轮路径）
    const dbPlan = (await getProjectPlan(projectId)).plan;
    let plan: unknown = dbPlan;
    let phases = usablePhases(dbPlan);
    if (!phases) {
        plan = null;   // 校验不过的脏 dev_plan 不带进对话路径
        for (const manager of managers) {
            const thread = `project-${projectId}`;
            // ★ B2 需求注入：PM 对话是纯 messages 上下文——先把库里需求作为开场白喂进去。
            //   缺这步，全绿灯模式对着空气喊"定稿"，PM 按契约拒绝空功能清单（9/2 阶段1验收实锤）。
            const requirement = await getProjectRequirement(projectId);
            if (!requirement) console.warn("[runner] ⚠️ 项目 description/clarified_req 均为空——PM 无法提炼功能，请先在网页端填写需求");
            const seed = requirement ? [new HumanMessage(`【项目需求】\n${requirement}`)] : [];
            let state: any = await manager.run({ messages: seed, projectId }, thread, questioner);
            // 读取项目确认模式：全绿灯(0) 或 Java spawn（AUTO_CONFIRM=1，无终端）→ 自动定稿
            // ⚠️ 只看 confirmMode 的话混合(1)模式在子进程里会拿 "y" 当对话输入空转 30 轮（A9 根治）
            let confirmMode = 0;
            try { confirmMode = await getProjectConfirmMode(projectId); } catch { /* 默认 0 */ }
            const isAuto = confirmMode === 0 || process.env.AUTO_CONFIRM === "1";
            if (isAuto) console.log(`[runner] 自动推进模式（confirmMode=${confirmMode}${process.env.AUTO_CONFIRM === "1" ? " + AUTO_CONFIRM" : ""}），无需人工确认`);

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

            plan = state?.plan;
            phases = usablePhases(plan);
            if (phases) break;
            console.log("[runner] 需求未产出 plan（用户未定稿），试下一个项目经理");
        }
        if (!phases) {
            if (managers.length === 0) console.log("[runner] 项目未配置项目经理成员，且库里无 dev_plan——无法开工");
            await updateProjectField(projectId, { status: "failed" }).catch(() => {});
            return;
        }
        // 阶段流转前把定稿 plan 写库（saveDevPlan 是 manager 图内行为；对话路径走到这说明库里还没有）
        console.log(`[runner] PM 定稿，${phases.length} 个阶段`);
    } else {
        console.log(`[runner] 检测到库中 dev_plan（${phases.length} 个阶段），跳过 PM 对话直接开工`);
    }

    // 3. 续跑点判定（阶段完成=sys_task 该 phase 全 done）；全新开工先清场（F15 拍板：旧树归档不覆盖）
    const startIdx = await findResumeIndex(projectId, phases);
    if (startIdx === 0 && (await getTasksByProject(projectId)).length === 0) {
        const moved = archiveProjectDir(projectId);
        if (moved) console.log(`[runner] 全新开工，旧产物树已归档 → ${moved}`);
    }
    if (startIdx >= phases.length) {
        console.log("[runner] 全部阶段均已完成（无待办任务），直接收尾 status=done");
        await updateProjectField(projectId, { status: "done" });
        return;
    }
    if (startIdx > 0) console.log(`[runner] 断点续跑：跳过已完成阶段前 ${startIdx} 个，从阶段 ${phases[startIdx]!.phase}「${phases[startIdx]!.name}」继续`);

    // 4. 逐阶段下发（边界行为见 drivePhases）
    const outcome = await drivePhases(station, projectId, plan, phases, startIdx, exitAtBoundary);
    if (outcome === "done") {
        await updateProjectField(projectId, { status: "done" });
        console.log("[runner] 全阶段完成 → status=done 已落库");
    }
    console.log("[runner] 流程结束");
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
  // 配置层先热身后开跑：sys_settings 进缓存（30s 心跳刷新，设置页改动半分钟内生效；读失败静默走内置）
  await refreshSettings(true);
  setInterval(() => { void refreshSettings(true); }, 30_000).unref();
  // 提问器按进程身份分流（阶段 3）：AUTO_CONFIRM→自动 y；Java 管理进程→Web 问答卡；手工终端→stdin
  runProject(projectId, pickQuestioner(projectId))
    .then(async () => {
      console.log("[runner] 流程结束，冲刷 sys_task 桥后退出");
      await closeTaskBridge();   // 等在途写落完（3s 上限兜底），再 exit
      process.exit(0);
    })
    .catch(async (e) => {
      console.error("[runner] 进程异常退出:", e);
      await closeTaskBridge().catch(() => {});
      process.exit(1);
    });
}
