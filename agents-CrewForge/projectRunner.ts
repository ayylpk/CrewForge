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
import { Manager } from "./manager";
import { Architect } from "./architect";
import { TestEngineer, TEST_CORE_NAME } from "./testEngineer";
import { Maintainer } from "./maintainer";
import { startDeveloperLine, makeTesterDeps } from "./developerTeamRunner";
import { getProjectAgents, getProjectNodes, getEdges, getProjectConfirmMode, getProjectRequirement, getProjectPlan, updateProjectField } from "./Node";
import { type Questioner } from "./GraphFactory";
import { pickQuestioner } from "./confirm";
import { closeTaskBridge, getTasksByProject, type Task } from "./task";   // 出口保险：退出前冲干净在途 sys_task 写（9/3 run10 T4 竞态）
import { closeRenderGates } from "./renderGate";                           // T6 出口保险：整树杀渲染审的 vite 进程链
import { archiveProjectDir } from "./runEnv";
import { projectDir } from "./runEnv";
import { refreshSettings } from "./settings";
import { PhaseRequestMessageSchema } from "./messageProtocol";


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
        let data: any = null;
        while (!data) {
            const req = await station.waitForMessage("manager");
            if (!req || req.sender !== "architect") {
                console.warn(`[runner] 拒绝阶段消息：发送方应为 architect，实际为 ${req?.sender ?? "?"}`);
                if (req) station.markDone("manager");
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
    // ★ engine2 feature flag（阶段 2 定稿）：权威 = sys_project.pipeline_version（逐项目 DB 字段）。
    //   · 默认 legacy——未改字段的项目行为与从前逐字节一致；
    //   · engine2 项目只能启动 Engine2（env 不允许静默回退，CF_ENGINE=legacy 直接拒绝启动）；
    //   · legacy 项目可用 CF_ENGINE=engine2 显式手工启用（测试用）。
    {
        const { decidePipelineForProject, runProjectWithEngine2, Engine2StartRejected } = await import("./engine2/projectAdapter");
        let decision;
        try {
            decision = await decidePipelineForProject(projectId);
        } catch (e) {
            if (e instanceof Engine2StartRejected) {
                console.error(`[runner] engine2 拒绝启动：${e.message}`);
                await updateProjectField(projectId, { status: "failed" }).catch(() => {});
                return;
            }
            throw e;
        }
        console.log(`[runner] pipeline 判定：${decision.version}（${decision.why}）`);
        if (decision.use) {
            try {
                const outcome = await runProjectWithEngine2(projectId);
                // 落库只写**程序判定出来的真实结论**（绝不为了让看板好看而改状态）
                console.log(`[runner] engine2 结束：runId=${outcome.runId}（${outcome.resumed ? "续跑" : "新跑"}） 终态=${outcome.status} done=${outcome.done}`);
                for (const u of outcome.unmet) console.log(`[runner]   · 未满足：${u}`);
                console.log(`[runner] 运行报告：${outcome.stateFile}`);
                return;
            } catch (e) {
                if (e instanceof Engine2StartRejected) {
                    console.error(`[runner] engine2 拒绝启动：${e.message}`);
                    await updateProjectField(projectId, { status: "failed" }).catch(() => {});
                    return;
                }
                throw e;
            }
        }
        // decision.use === false → 继续走旧系统（legacy 项目默认路径）
    }

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
    console.log("[runner] 流程结束");
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
