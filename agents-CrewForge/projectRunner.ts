// ============================================================
// projectRunner.ts —— 项目级编排入口
//
//   main 入口：项目 id → 读成员（sys_project_agent JOIN sys_agent 带出角色）
//   → 按角色分派构造（图版读项目节点拼图；消息版读节点 prompt）
//   → 启动消息版团队 → Manager 对话确认需求 → 桥接 phase_plan 逐阶段下发架构师
//
//   角色（中文 label）→ 类（9/15 名册换代）：
//     项目经理 → Manager（图版：项目节点 + 池边 → stitch → runWithInteraction）
//     架构师   → Architect（消息版 + 拆分图，收 phase_plan；hub 模式两阶段派发
//                architect_task 蓝图 + 逐批 architect_batch 直派 developer）
//     开发     → developerAgent（"developer"，单开发流分批消费；替换原
//                后端开发/前端开发/Merger 三工位，装配见 developerTeamRunner.ts）
//     测试     → TestEngineer（"test-core"：吃 developer 的 test_request，
//                经外部 TestAgent --verify 出机器证据，回 test_passed/test_failure）
//     维护     → Maintainer（纯逻辑收敛，无 LLM 无节点；收 developer 三终态记 sys_task）
//   Maintainer 是系统内置单例，无论项目成员如何配置都注册（流水线必需）。
// ============================================================

import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import fs from "node:fs";
import { finalGate, type FinalGateResult } from "./engine/run/finalGate";
import { finalizeProject } from "./engine/run/completion";
import { StructuredOutputFailure } from "./llm";
import { TransferStation, roles } from "./Hub";
import type { BaseAgent } from "./BaseAgent";
import { Manager, createLlmPmDeps } from "./manager";
import { Architect } from "./architect";
import { TestEngineer, TEST_CORE_NAME } from "./testEngineer";
import { Maintainer } from "./maintainer";
import { startDeveloperLine, makeTesterDeps, waitForBrakeStop } from "./developerTeamRunner";
import { getProjectAgents, getProjectNodes, getEdges, getProjectConfirmMode, getProjectRequirement, getProjectPlan, readProjectFile, updateProjectField, upsertProjectFile } from "./Node";
import { type Questioner } from "./GraphFactory";
import { pickQuestioner } from "./confirm";
import { closeTaskBridge, getTasksByProject, type Task } from "./task";   // 出口保险：退出前冲干净在途 sys_task 写（9/3 run10 T4 竞态）
import { closeRenderGates } from "./renderGate";                           // T6 出口保险：整树杀渲染审的 vite 进程链
import { archiveProjectDir } from "./runEnv";
import { projectDir } from "./runEnv";
import { refreshSettings } from "./settings";
import { PhaseRequestMessageSchema } from "./messageProtocol";
// 召唤工位（9/17 拓扑升级·层 B）：PM 侧的应答器（接线点说明见 answerPmConsult 注释）
import { handleConsultRequest } from "./consultStation";
import type { ConsultContext } from "./consultStation";
import { CONSULT_DRIVER, parseConsultRequest } from "./consult";
import type { ConsultRequest } from "./consult";


export interface TeamBundle {
    station: TransferStation;
    messageAgents: BaseAgent[];
    managers: Manager[];
}

/**
 * 固定核心团队；数据库成员只提供配置，不再决定核心角色是否存在或复制实例。
 * ★ 9/15 名册换代：后端开发+前端开发+Merger 三个工位被 developerAgent **整体替换**
 *   （单开发流分批消费蓝图，见 developerTeamRunner.ts 头注释）。
 *   projectId 用于 test-core 的验收依赖注入（判据从 _tasks 落盘读回）；
 *   不传 = 纯装配测试场景（无注入，test-core 收到 test_request 会大声缺配置）。
 *   developer 座位不在 messageAgents 里（它不是 BaseAgent），由 startDeveloperLine 占。
 */
export function createCoreTeam(
    station: TransferStation = new TransferStation({}, {}),
    projectId?: number,
    configured?: { manager?: Manager; architect?: Architect; test?: TestEngineer },
): TeamBundle {
    const managers = [configured?.manager ?? new Manager()];
    const messageAgents: BaseAgent[] = [
        new Maintainer(station),
        configured?.architect ?? new Architect(station),
        configured?.test ?? new TestEngineer(TEST_CORE_NAME, station, [],
            projectId != null ? makeTesterDeps(projectId) : {}),
    ];
    return { station, messageAgents, managers };
}

/** 读项目成员 → 按角色分派构造（Merger/Maintainer 系统内置无条件注册） */
export async function buildTeam(
    projectId: number,
    station: TransferStation = new TransferStation({}, {}),
): Promise<TeamBundle> {
    const members = await getProjectAgents(projectId);
    let manager: Manager | undefined;
    let architect: Architect | undefined;
    let test: TestEngineer | undefined;

    for (const m of members) {
        const nodes = await getProjectNodes(projectId, m.agentId);
        switch (m.role) {
            case "项目经理":
                if (!manager) manager = await Manager.fromProject(projectId, m.agentId);
                console.log(`[runner] 项目经理 ${m.name}：图版，节点 ${nodes.length} 个`);
                break;
            case "架构师":
                // 节点/边缺一 → 整体退内置 DEFAULT_NODES/DEFAULT_EDGES（构造器默认参）——
                // 半套 DB 配置（有边无节点）会让 stitch 编译崩死（9/2 验收：软删遗留池边撞库实锤）
                {
                    const edges = await getEdges(m.agentId);
                    if (!architect) architect = nodes.length > 0 && edges.length > 0
                        ? new Architect(station, nodes, edges)
                        : new Architect(station);
                }
                console.log(`[runner] 架构师 ${m.name}：消息+拆分图，${nodes.length > 0 ? `DB 配置（节点 ${nodes.length} 个）` : "内置默认图"}`);
                break;
            case "后端开发":
            case "前端开发":
                // 9/15 换代：这两个工位由 developerAgent（"developer"）整体替换，
                // 成员的 DB 节点配置不再有人消费（看板数据留着无妨，等 DB 侧一并定夺）
                console.log(`[runner] ${m.role} ${m.name}：已由 developerAgent 取代，本进程不构造`);
                break;
            case "测试":
                if (!test) test = new TestEngineer(TEST_CORE_NAME, station, nodes, makeTesterDeps(projectId));
                console.log(`[runner] 测试 ${m.name}：判定（developer 线：吃 test_request 回 test_*），节点 ${nodes.length} 个`);
                break;
            case "维护":
                // Maintainer 已作为系统内置注册，成员里的"维护"不重复实例化
                console.log(`[runner] 维护 ${m.name}：使用系统内置 Maintainer（纯逻辑收敛）`);
                break;
            default:
                console.log(`[runner] 角色「${m.role}」无实现类，跳过：${m.name}`);
        }
    }
    return createCoreTeam(station, projectId, { manager, architect, test });
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
 * 层 B（9/17）召唤工位 —— **PM 侧应答器**。
 *
 *   为什么写在这里而不是 manager.ts：Manager 不是 BaseAgent，它没有消息循环
 *   （`run()` 走 GraphFactory 的 runWithInteraction，由调用方喂输入）。
 *   PM 座位上的收件箱一直由 drivePhases 这个循环代收（phase_request 就在这里被接走），
 *   所以"PM 被召唤"的唯一合法接线点也是这里——**接线在消息被分派的地方**，
 *   而不是硬塞进一个没有循环的类里（那只会变成一个永不触发的死代码）。
 *
 *   它拥有什么（ownContext）：需求原文（sys_project.description + clarified_req）
 *     与正在驱动的阶段计划（dev_plan）。这两件正是 PM 的产物，也是它能澄清的东西。
 *   它能签发什么（amend）：只有 requirement_clarification
 *     —— 落 `sys_project_file` 的 `_pm/requirement-clarifications.md`（**不是**改写
 *     clarified_req：那一列是 JSON.stringify({features})，往里塞散文会当场打断
 *     所有读它的人——saveClarifiedReq/assemblePmPlan 都按 JSON 解）。
 *
 *   不抛：任何异常都变成一条 refused 回复（handleConsultRequest 的契约），
 *   司机的召唤**永远不会把 runner 主流程打死**。
 */
async function answerPmConsult(
    station: TransferStation, projectId: number, plan: unknown, phases: any[], content: string,
    llm?: (prompt: string) => Promise<string>,
): Promise<void> {
    let raw: unknown = content;
    try { raw = JSON.parse(content); } catch { /* 非 JSON：交给协议解析器给逐条原因 */ }
    const parsed = parseConsultRequest(raw);
    const fallbackTaskId = (raw as { taskId?: unknown })?.taskId;
    const ctx: ConsultContext = {
        role: "pm",
        projectId: String(projectId),
        // PM 不绑定单一任务（一个阶段一个 taskId，PM 服务整条流水）→ 空 = "不持该维度"
        taskId: "",
        ownContext: async () => {
            let requirement = "";
            try { requirement = await getProjectRequirement(projectId); }
            catch (e) { requirement = `（需求原文读取失败：${(e as Error).message}）`; }
            const clar = await readRequirementClarifications(projectId);
            return [
                "# 项目经理（PM）当前持有的产物",
                `- 需求原文（sys_project.description + clarified_req）长度：${requirement.length}`,
                requirement ? `- 需求原文（截断 2500 字符）：\n${requirement.slice(0, 2500)}` : "- 需求原文：**为空**（本工位手上没有需求，不能替你发明）",
                `- 正在驱动的阶段计划（dev_plan）：${plan ? JSON.stringify(plan).slice(0, 1500) : "（无）"}`,
                `- 阶段清单：${phases.map((p) => `p${p?.phase}「${p?.name}」`).join("、") || "（无）"}`,
                `- 已落盘的需求澄清（${clar.length} 条，位于 sys_project_file 的 ${PM_CLARIFICATION_FILE}）：`
                + (clar.length ? `\n${clar.map((c) => `  · ${c}`).join("\n")}` : "（无）"),
                "- 不持有的信息：判据的语义与执行（测试）、计划与批次的拆解（架构师）、生成项目的代码（司机）。",
            ].join("\n");
        },
        // LLM 端口：PM 本来就有模型（对话/细化/规划走同一批，见 createLlmPmDeps）。
        // 接上它，PM 才能真的澄清需求；接不上（无 key/构造失败）就退回确定性复述——
        // 应答器在两种模式下都不会编事实（没有 LLM 时它会明说"我没有 LLM 可用"）。
        ...(llm ? { llm } : {}),
        amend: async (a) => {
            if (a.kind !== "requirement_clarification") return false;   // 越权 kind 一律退回
            const existing = await readRequirementClarifications(projectId);
            const line = `${new Date().toISOString()} ${a.detail}`;
            try {
                await upsertProjectFile(projectId, PM_CLARIFICATION_FILE, `${[...existing, line].join("\n")}\n`);
            } catch (e) {
                console.warn(`[runner] 需求澄清落盘失败（按未生效处理）：${(e as Error).message}`);
                return false;
            }
            console.log(`[runner] 层 B：PM 已记录需求澄清 —— ${a.detail.slice(0, 200)}`);
            return true;
        },
    };
    const req = (parsed.ok ? parsed.value : raw) as ConsultRequest;
    const reply = await handleConsultRequest(req, ctx);
    // 回信目标恒为司机（协议只允许司机发起）
    station.sendMessage("manager", CONSULT_DRIVER, JSON.stringify(reply));
    console.log(`[runner] PM 应答召唤 ${reply.consultId}（confidence=${reply.confidence}`
        + `${reply.refused ? "，已拒绝" : ""}${reply.amendment ? `，已签发 ${reply.amendment.kind}` : ""}`
        + `，taskId=${String(fallbackTaskId ?? "")}）`);
}

/** 召唤请求的内容判据（不解析发送方，避免把合法召唤当成"发送方不对"静默 markDone 掉） */
function isConsultRequestContent(content: string): boolean {
    try {
        return (JSON.parse(content) as { type?: unknown })?.type === "consult_request";
    } catch {
        return false;
    }
}

/** 需求澄清的落盘位置（sys_project_file 逻辑路径，不是磁盘文件——不落进生成项目） */
const PM_CLARIFICATION_FILE = "_pm/requirement-clarifications.md";

/**
 * PM 的召唤 LLM 端口（懒构造，只构造一次）。
 *   · 走 createLlmPmDeps() 的 chat：与 PM 对话/细化/规划**同一个模型档位**，
 *     不另造一条没人验证过的模型配置；
 *   · 构造失败（无 key/配置坏）→ 返回 undefined，PM 退回确定性复述（明说没有 LLM），
 *     绝不假装答过；
 *   · 注意 chat 自带 120s 超时，而司机默认只等 90s（consultTimeoutMs）——
 *     真耗时的召唤会以"超时降级"收场（司机自行继续 + 留 consult_timeout），
 *     要它等更久就上调 consultTimeoutMs，别在这里偷偷改超时口径。
 */
let pmConsultLlmCache: ((prompt: string) => Promise<string>) | null | undefined;
function pmConsultLlm(): ((prompt: string) => Promise<string>) | undefined {
    if (pmConsultLlmCache === undefined) {
        try {
            const deps = createLlmPmDeps();
            pmConsultLlmCache = async (prompt: string) => deps.chat([new HumanMessage(prompt)]);
        } catch (e) {
            console.warn(`[runner] PM 召唤端口构造失败，退回确定性复述：${(e as Error).message}`);
            pmConsultLlmCache = null;
        }
    }
    return pmConsultLlmCache ?? undefined;
}

async function readRequirementClarifications(projectId: number): Promise<string[]> {
    try {
        const text = await readProjectFile(projectId, PM_CLARIFICATION_FILE);
        return (text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    } catch {
        return [];   // 读不到 = 没有澄清（首次运行），不是错误
    }
}

/**
 * 逐阶段下发架构师，等到每个阶段的 phase_request（阶段边界信号）。
 * 返回 "done"=全部阶段收工；"boundary"=在阶段边界主动收工（EXIT_AT_PHASE_BOUNDARY=1，
 * Java 对账器会拉下一个进程从续跑点接着干——9/2 拍板"按阶段起进程"，断点续跑白送）；
 * "paused"=开发线在**刹车检查点**等不到人确认（任务已留在 waiting_human、账本可续跑），
 * 本进程必须干净退出——**这正是老板要的"没确认就终止进程、任务信息保留、下次接着拉起来"**。
 * 不加这一条的话，本循环会一直等下一条 phase_request，最后被外层 --timeout-min 杀掉：
 * 那正是 s4/s4c/s4d/s5b 的死法（进程被杀，连死因都没留下）。
 */
async function drivePhases(
    station: TransferStation,
    projectId: number,
    plan: unknown,
    phases: any[],
    startIdx: number,
    exitAtBoundary: boolean,
): Promise<"done" | "boundary" | "paused" | "terminal"> {
    for (let i = startIdx; i < phases.length; i++) {
        const isLast = i === phases.length - 1;
        station.sendMessage("manager", "architect", JSON.stringify({ type: "phase_plan", plan, phase: phases[i], projectId }));
        console.log(`[runner] → 架构师：阶段 ${phases[i].phase}「${phases[i].name}」`);
        // 收阶段边界：maintainer 发 phase_done → 架构师发 phase_request 给 manager —— runner 代为响应
        let data: any = null;
        while (!data) {
            // ★ 刹车暂停信号：开发线等不到人确认时会 requestBrakeStop()，这里必须能**醒过来**，
            //   否则 waitForMessage 死等 → 外层超时杀进程（任务状态缺失、死因缺失）。
            const raced = await Promise.race([
                station.waitForMessage("manager").then((m) => ({ kind: "msg" as const, m })),
                waitForBrakeStop().then((r) => ({ kind: "stop" as const, r })),
            ]);
            if (raced.kind === "stop") {
                // ★ 9/18：终结态要跟"暂停"分开——一个是"人还没答、状态留着可续跑"，
                //   一个是"开发线已判 blocked/failed、下游根本不会再有 phase_request"。
                //   原先两者都走 paused 分支，而终态**从不**调 requestBrakeStop()，
                //   于是这里死等到被人 kill（实测 2961 秒），期间还空烧一个核。
                if (raced.r === "terminal") {
                    console.log("[runner] ⛔ 开发线已判终态（blocked/failed）：本阶段不会再有 phase_request，"
                        + "进程干净退出（任务状态已落库，Java 对账器下次重新拉进程续跑）");
                    return "terminal";
                }
                console.log("[runner] 🌙 刹车检查点等不到人确认：开发线已保状态（waiting_human），本进程干净退出，"
                    + "Java 对账器下次重新拉进程续跑（题号不变，人答过就消费）");
                return "paused";
            }
            const req = raced.m;
            if (!req) { station.markDone("manager"); continue; }
            // ★ 层 B（9/17）召唤工位：PM 的收件箱**在这里**被消费（Manager 不是 BaseAgent，
            //   没有自己的消息循环——PM 座位上的进出全由本函数代收，见文件头角色表）。
            //   所以"PM 能不能被召唤"的接线点就在这里，而不是在 manager.ts 里。
            //   判据用**内容**（consult_request）而不是发送方：先解析再决定，避免把
            //   一条合法召唤当成"发送方不对"静默 markDone 掉（消息一旦 markDone 就没了）。
            if (isConsultRequestContent(req.content)) {
                station.markDone("manager");
                await answerPmConsult(station, projectId, plan, phases, req.content, pmConsultLlm());
                continue;   // 召唤不改变阶段边界状态：继续等真正的 phase_request
            }
            if (req.sender !== "architect") {
                console.warn(`[runner] 拒绝阶段消息：发送方应为 architect，实际为 ${req.sender}`);
                station.markDone("manager");
                continue;
            }
            let raw: unknown;
            try { raw = JSON.parse(req.content); } catch { raw = null; }
            const parsed = PhaseRequestMessageSchema.safeParse(raw);
            if (!parsed.success || parsed.data.phase !== Number(phases[i]!.phase)) {
                console.warn(`[runner] 拒绝过期/错误 phase_request：${req.content}`);
                station.markDone("manager");
                continue;
            }
            data = parsed.data;
            station.markDone("manager");
        }
        console.log(`[runner] 收到架构师请求：${data.type}（阶段 ${data.phase}）`);
        if (!isLast && exitAtBoundary) {
            console.log(`[runner] 阶段 ${phases[i].phase} 收口，按阶段边界退出（等 Java 对账续拉）`);
            return "boundary";
        }
    }
    return "done";
}

/** 项目级主流程：建团队 → 有 plan 直接开工（续跑），没有才 PM 对话 → 逐阶段下发 → 终态落库 */
export async function runProject(projectId: number, questioner: Questioner): Promise<void> {
    // 9/15：engine2（确定性流水线实验线）已拔除——其 36 个文件从未进 git、真库 6 个项目全是 legacy，
    //   原 feature-flag 入口只制造了"已 push 代码 import 未提交模块"的 clone 即崩，故整段删除。

    // 按阶段起进程模式（Java spawn 注入；手工跑默认关=旧行为单进程跑完全部阶段）
    const exitAtBoundary = process.env.EXIT_AT_PHASE_BOUNDARY === "1";
    const { station, messageAgents, managers } = await buildTeam(projectId);

    // 1. 消息版团队常驻：start() 内含 while(true) 消息循环**永不 resolve**，必须 fire-and-forget
    //    （9/2 阶段1验收逮到的真 bug：await 会把主流程卡死在 PM 对话之前，零 LLM 请求）
    for (const a of messageAgents) {
        void a.start().catch((e) => console.error("[runner] agent 消息循环异常退出:", e));
    }

    // ★ developerAgent 装配线（9/15 替换前后端开发）：占 "developer" 座位 + 永动消费
    //   architect_task/批（消息全走 Hub 原语，见 developerTeamRunner.ts 头注释）
    startDeveloperLine(station, projectId);

    // ★ fail-fast：必需角色缺席=消息投进 Hub 惰性空箱、无人消费，waitForMessage 死等
    //   （9/2 阶段1验收血泪：项目1 没配架构师成员，流水线静默挂死零日志）
    const need: { label: string; ok: () => boolean }[] = [
        { label: "架构师", ok: () => !!station.status["architect"] },
        { label: "测试", ok: () => Object.values(station.status).some((s) => s.role === roles.testEngineer) },
        { label: "维护", ok: () => !!station.status["maintainer"] },
        // developer 座位由 startDeveloperLine 预占（9/15 替换前后端开发）；缺席=派发进空箱死等
        { label: "开发(developerAgent)", ok: () => !!station.status["developer"] },
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
                // PM 这一轮说的话：既打日志，也当确认门题面（见下面 ask 的 prompt）
                const pmText = reply
                    ? (typeof reply.content === "string" ? reply.content : JSON.stringify(reply.content))
                    : "";
                if (pmText) console.log(`\n[PM] ${pmText}`);
                // 全绿灯模式：自动输入"定稿"跳过 PM 对话
                if (isAuto) {
                    console.log("[runner] 全绿灯模式：自动定稿");
                    state = await manager.run({ messages: [new HumanMessage("定稿")], projectId }, thread, questioner);
                    turns++;
                    continue;
                }
                const userInput = await questioner.ask({
                    questionId: `pm-${projectId}-${turns}`,
                    // ⚠️ 题面必须是 PM 的原话：Web 上人看到的就是这一句。
                    //    9/18 修「对话没连接」——原先这里写死一句过场话
                    //    "（输入下一句需求；输入 定稿 结束需求确认）"，PM 真正问的问题
                    //    只被上面 console.log 打进引擎日志、从没进过确认门。
                    //    于是 sys_confirm 里躺着一句固定提示，网页上永远看不到 PM 问了什么。
                    prompt: pmText || "（输入下一句需求；输入 定稿 结束需求确认）",
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
        console.log("[runner] 全部阶段均无待办任务——**不直接落 done**，仍要过交付关与终态判据");
        const gate = await runFinalGate(projectId, plan);
        await settleProject(projectId, gate);
        return;
    }
    if (startIdx > 0) console.log(`[runner] 断点续跑：跳过已完成阶段前 ${startIdx} 个，从阶段 ${phases[startIdx]!.phase}「${phases[startIdx]!.name}」继续`);

    // 4. 逐阶段下发（边界行为见 drivePhases）
    const outcome = await drivePhases(station, projectId, plan, phases, startIdx, exitAtBoundary);
    if (outcome === "done") {
        // ★ 交付关（9/10）+ 终态判据（阶段 1 提交 1）：项目"完成"必须等于"验证通过"，
        //   且 done 还要求任务数>0、产物数>0、无 failed 任务（阶段 0 的 s3 就是 6/8 failed 仍落 done）。
        const gate = await runFinalGate(projectId, plan);
        await settleProject(projectId, gate);
    }
    // ★ 9/18：开发线已判终态（blocked/failed）——本项目到此为止，**必须显式收口**。
    //   原先这里没有分支：status 停在 executing，Java 对账器按"executing + 无活进程"一轮轮
    //   重拉进程（每轮第一件事就是读回 ledger 的终态、立刻再终结），既刷日志也不产生任何东西。
    //   收口走 settleOnFailure：finalGateStatus=failed + verified=false + 写失败报告，
    //   与"进程异常退出"同一口径——**未验证就不许当通过**。
    if (outcome === "terminal") {
        // ★ 9/18：收口前先给"在途的终态消息"一个有界的消费机会。
        //   终态消息是发给架构师 + 抄送 maintainer 的，而**记账（sys_task 失败行）在
        //   maintainer 那条异步消息循环里**。这里立刻 return → 外层 process.exit(0)，
        //   就可能把还没被调度的记账腰斩（实测：任务行停在 todo、error_msg 为空）。
        //   有界等待（2s 上限）+ 只等在途队列排空，不改变任何判定语义。
        //   （工位名与 developerTeamRunner 的 MAINTAINER_NAME/ARCHITECT_NAME 一致；那边没导出，
        //    这里按 projectRunner 既有习惯用字面量——本文件别处也是 "manager"/"architect" 字面量）
        await waitQueuesDrained(station, ["maintainer", "architect"], 2000);
        await settleOnFailure(projectId, new Error("开发线已判终态（blocked/failed）：本阶段不会再有后续推进，项目按未验证收口"));
        console.log("[runner] 流程结束（开发线终态，已按未验证收口）");
        return;
    }
    // ★ paused（刹车检查点等不到人）：**不动项目终态、不落 blocked/failed**。
    //   任务信息留在 developer 账本里（waiting_human + brake_paused），题号不变；
    //   sys_project.status 保持 executing，Java 对账器"executing + 无活进程"就会重新拉进程续跑。
    //   这正是老板要的"没确认就终止进程、任务信息保留、下次接着拉起来"。
    console.log(`[runner] 流程结束（${outcome === "paused" ? "刹车暂停，等对账器续拉" : outcome}）`);
}

/**
 * 等这些工位把**在途消息**消费完（有界）。
 *
 *   为什么需要它（9/18 实测）：开发线判终态后，收口路径会立刻走到 `process.exit(0)`，
 *   而"终态 → sys_task 记账"是 maintainer 那条**异步消息循环**里干的活——
 *   进程先退出就把写腰斩了（现场：任务行停在 todo、error_msg 为空，项目状态却是 failed）。
 *   这里只等"队列排空"，不改判定、不阻塞业务；到点就走（上限几百毫秒的正常情况）。
 */
async function waitQueuesDrained(
    station: TransferStation, names: readonly string[], budgetMs: number,
): Promise<void> {
    const t0 = Date.now();
    while (Date.now() - t0 < budgetMs && names.some((n) => station.hasQueued(n))) {
        await new Promise((r) => setTimeout(r, 25));
    }
    const left = names.filter((n) => station.hasQueued(n));
    if (left.length > 0) {
        console.warn(`[runner] ⚠ ${left.join("、")} 的在途消息在 ${budgetMs}ms 内没消费完——`
            + "按「不阻塞收口」继续（记账可能缺失，但不许因此把进程吊住）");
    }
}

/**
 * 唯一收尾：交付关结论 → decideProjectStatus → 落库 + 完成报告。
 * 历史病：skipped_unverified 仍写 done；交付关异常返回 done；无待办阶段直接 done。
 */
async function settleProject(projectId: number, gate: FinalGateResult): Promise<void> {
    const fin = await finalizeProject({
        projectId,
        projectDir: projectDir(projectId),
        finalGateStatus: gate.status,
        verified: gate.verified,
        requiredAssertionsPassed: gate.verified,
    });
    console.log(`[runner] 终态判定：status=${fin.status}（任务 ${fin.input.taskCount} / 产物 ${fin.input.artifactCount} / failed 任务 ${fin.input.failedTaskCount} / 交付关 ${gate.status} / verified=${gate.verified}）`);
    for (const r of fin.reasons) console.log(`[runner]   · ${r}`);
    if (gate.reportFile) console.log(`[runner]   验证报告：${gate.reportFile}`);
    if (fin.reportFile) console.log(`[runner]   完成报告：${fin.reportFile}`);
    if (fin.status === "done") console.log(`[runner] ✅ 项目完成且已验证：${gate.summary}`);
    else if (fin.status === "blocked") console.warn(`[runner] ⛔ 未验证完成 → status=blocked（未验证 ≠ 通过）：${gate.summary}`);
    else console.error(`[runner] ❌ 未通过 → status=failed：${gate.summary}`);
}

/**
 * 异常收尾：任何未捕获异常都必须在**进程退出前**把项目收敛到显式终态。
 * 阶段 0 的 s2：architectPlan 解析失败 → 异常冒泡 → 进程退出 → 项目永远停在 planning。
 */
async function settleOnFailure(projectId: number, e: unknown): Promise<void> {
    const err = e as (Error & { failure?: { category?: string; error?: string; attempts?: number; raw?: string } });
    const isStructured = e instanceof StructuredOutputFailure || err?.name === "StructuredOutputFailure" || err?.failure != null;
    const detail = isStructured && err.failure
        ? { kind: `LLM_${err.failure.category ?? "OUTPUT_PARSE"}`, message: err.failure.error ?? err.message, attempts: err.failure.attempts, raw: err.failure.raw }
        : { kind: "RUN_EXCEPTION", message: String(err?.message ?? e) };
    try {
        const fin = await finalizeProject({
            projectId,
            projectDir: projectDir(projectId),
            finalGateStatus: "failed",
            verified: false,
            requiredAssertionsPassed: false,
            failureDetail: detail,
        });
        console.error(`[runner] 异常收尾：status=${fin.status}（${fin.reasons.join("；")}）`);
        if (fin.reportFile) console.error(`[runner] 失败报告：${fin.reportFile}`);
    } catch (e2) {
        console.error("[runner] 异常收尾失败，兜底写 failed:", (e2 as Error).message);
        await updateProjectField(projectId, { status: "failed" }).catch(() => { /* 已尽力 */ });
    }
}

/**
 * 交付关：读产物树里的验收 IR（architect 每阶段落盘）+ 任务清单 → finalGate。
 * 全程 try 包住：交付关自身异常不得让 runner 崩（但要显式标注未验证）。
 */
async function runFinalGate(projectId: number, plan: unknown): Promise<FinalGateResult> {
    try {
        const dir = projectDir(projectId);
        const verifyDir = dir + "/_verify";
        let acceptanceFiles: string[] = [];
        try {
            acceptanceFiles = fs.readdirSync(verifyDir)
                .filter(f => /^acceptance-p\d+\.json$/i.test(f))
                .map(f => verifyDir + "/" + f);
        } catch { acceptanceFiles = []; }

        const rows = await getTasksByProject(projectId);
        const tasks = rows.map(r => ({
            id: r.task_id_ext ?? String(r.id),
            layer: (r.layer === "frontend" ? "frontend" : "backend") as "backend" | "frontend",
            method: "",
            path: "",
            title: r.title ?? "",
        }));

        // 技术选型从 .architect-state.json 读回（bootstrap 落盘的那份）
        let stack: unknown = null;
        try {
            const f = dir + "/.architect-state.json";
            if (fs.existsSync(f)) stack = JSON.parse(fs.readFileSync(f, "utf-8"))?.stack ?? null;
        } catch { /* 读不到=按默认基线 */ }

        const result = await finalGate({
            projectDir: dir,
            tasks,
            acceptanceFiles,
            stack,
            skip: process.env.SKIP_RUN_VERIFY === "1",
            // ★ 阶段 1：Docker 不可用时用宿主 MySQL + 本机 JVM 验证（报告会如实标注"宿主验证"）
            dbMode: (process.env.CF_VERIFY_DB_MODE as "docker" | "host" | "auto" | undefined) ?? "auto",
        });
        console.log(`[runner] 交付关：验收 IR ${acceptanceFiles.length} 份 / 任务 ${tasks.length} 条 → ${result.summary}`);
        return result;
    } catch (e) {
        console.warn("[runner] 交付关异常（按**失败**处理，绝不返回 done）:", (e as Error).message);
        return { status: "failed", verified: false, summary: `交付关异常：${(e as Error).message.slice(0, 120)}`, reportFile: null };
    }
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
  // p3 翻车修（9/9）：argv 选了项目但 runEnv 全家（writeWorkspace/projectDir/currentProjectId）只认
  // env PROJECT_ID——Java spawn 会注入，手工跑漏注入=地基 18 文件全部"缺少 PROJECT_ID"写盘失败。
  // currentProjectId 是调用时现读，这里回填即全链生效（RUNS_ROOT 是模块期定格，仍需命令行前给）
  process.env.PROJECT_ID ??= String(projectId);

  console.log(`[runner] 启动项目 ${projectId}...`);
  // 配置层先热身后开跑：sys_settings 进缓存（30s 心跳刷新，设置页改动半分钟内生效；读失败静默走内置）
  await refreshSettings(true);
  setInterval(() => { void refreshSettings(true); }, 30_000).unref();
  // 提问器按进程身份分流（阶段 3）：AUTO_CONFIRM→自动 y；Java 管理进程→Web 问答卡；手工终端→stdin
  runProject(projectId, pickQuestioner(projectId))
    .then(async () => {
      console.log("[runner] 流程结束，冲刷 sys_task 桥后退出");
      await closeTaskBridge();   // 等在途写落完（3s 上限兜底），再 exit
      await closeRenderGates();  // T6：整树杀渲染审 vite 进程链，没起过则空操作
      process.exit(0);
    })
    .catch(async (e) => {
      console.error("[runner] 进程异常退出:", e);
      // ★ 阶段 1 提交 1：退出前必须把项目收敛到显式终态（阶段 0 的 s2 停在 planning 的根因）
      await settleOnFailure(projectId, e);
      await closeTaskBridge().catch(() => {});
      await closeRenderGates().catch(() => {});
      process.exit(1);
    });
}
