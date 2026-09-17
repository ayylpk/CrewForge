// ============================================================
// developerTeamRunner.ts —— developerAgent 在团队流水线里的装配线（9/15 替换前后端开发）
//
//   背景：引擎团队（projectRunner 的 buildTeam）原有的 后端开发+前端开发+merger
//   三个工位，被 developerAgent（单开发流，分批消费架构师蓝图）整体替换。
//   本文件是替换的装配层：
//     ① startDeveloperLine：在共享 TransferStation 上占住 "developer" 座位，
//        永动消费 architect_task → 建 handle → 逐批/逐测试结果驱动到终态；
//     ② makeTesterDeps：给改线后的 TestEngineer（"test-core"）注入验收依赖——
//        判据从架构师落盘的 _tasks/{taskId}/（blueprint.json + batch-*.json，
//        发送前落盘，waiting_test 时必已全部到盘）读回合并，翻译规则照抄
//        hub-runner 的 resolveChecks（COMPILE→工程命令；CONTRACT→_verify/serve.json，
//        没有 serve 配置就诚实交空命令 → verify 记未执行 → 看门狗收口，绝不假绿）。
//
//   消息面全部走 Hub.ts 原语（sendMessage/waitForMessage）：
//     architect → developer : architect_task（蓝图）+ architect_batch（逐批）
//     developer → test-core : test_request（requestTest 节点经 adapter.send 自动发）
//     test-core → developer : test_passed / test_failure（trustedTestAgents 闸）
//     developer → architect/maintainer : developer_* 出站（targets 路由）
//   hub-runner.ts 的独立驱动线保留作单 agent 调试工具，与此线互不启动。
//
//   崩溃重放：同一 taskId 重启后 ledger 有 prior 状态 → 不再 acceptArchitectTask
//   （会被状态闸拒），直接 serveOnce 消费在途批；ledger 的幂等/检查点语义原样生效。
//
//   ★ 2026-09-17 刹车第二次改造（老板口径）：
//     "不是杀死进程，而是有了和用户对话的时间，可能是和用户对话之后才继续开工。"
//     到点（SOFT）→ **问人**（题面带账目）→ 人说继续就加时接着驱动；
//     人说收口/停下就按现状收口并交**进展报告**；加时次数用满或撞到天花板才自己收口。
//     细节与血账见 developerAgent/brake.ts 头注释。
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { roles, type TransferStation } from "./Hub";
import { projectDir } from "./runEnv";
import { javaBaseUrl } from "./settings";
import type { AdapterVerifyCheck } from "./testAgentAdapter";
import { TEST_CORE_NAME, type TestEngineerDeps } from "./testEngineer";
import { createDeveloperAgent, type DeveloperAgentHandle } from "./developerAgent/index";
import { parseInbound, type ArchitectTask, type TestRequest } from "./developerAgent/protocol";
import { DEVELOPER_NAME } from "./developerAgent/hubAdapter";
import { createRealLlm } from "./developerAgent/realLlm";
import { resolveProjectCommand } from "./developerAgent/tools/projectCommands";
import {
    acceptanceGreen, askBrakeQuietly, brakeAskLogLine, brakeEventName, brakeFinalizedLogLine,
    brakeLogLine, brakePausedLogLine, brakeQuestion, brakeQuestionId, brakeReasonText,
    brakeResumedLogLine, buildProgressReport, checkBrake, countExtensions, describeBrakeDecision,
    findBrakePause, grantBrakeExtension, lastFailureReason, parseBrakeAnswer, resolveBrakePolicy,
    resumeBrief, resumeBriefText,
    type BrakeDecision, type BrakePolicy, type BrakeQuestion, type BrakeQuestioner,
    type BrakeStatus, type BrakeSummary, type ResumeBrief,
} from "./developerAgent/brake";

/**
 * 给测试与外部读 resume brief 文本用（runner 的这条链路是唯一会把 brief 拼进任务书的地方）
 */
export { resumeBriefText };

/** 出站路由的固定站名（Hub 按名字寻址；maintainer/architect 的注册名在各自文件里） */
const ARCHITECT_NAME = "architect";
const MAINTAINER_NAME = "maintainer";

/** 终态判断按 status 字符串（ledger 的 TaskSnapshot.status 就是 string，两处共用一把闸） */
const isTerminalStatus = (status: string): boolean =>
    status === "ready" || status === "blocked" || status === "failed";

// ---------- 保状态退出信号（三改：等不到确认时让**进程**干净落地） ----------

/**
 * 刹车暂停信号：等不到人确认时，开发线把任务留在 waiting_human（非终态），
 * 然后**必须让进程干净退出**——否则 projectRunner.drivePhases 会一直等下一条 phase_request，
 * 最后被外层 --timeout-min 杀掉（那正是 s4/s4c/s4d/s5b 的死法：进程被杀，死因都没了）。
 * 这里用模块级 promise 把"该收工了"的信号从开发线传出去，projectRunner 拿它 race 掉那个无限等待。
 * Java 对账器的模型正是这样：进程干净退出 + 状态保留 + status=executing → 重新拉进程续跑。
 */
let brakeStopRequested = false;
let brakeStopResolve: (() => void) | null = null;
let brakeStopPromise: Promise<void> | null = null;

/** 请求进程收工（等不到确认时由刹车路径调用；幂等，只生效一次） */
export function requestBrakeStop(): boolean {
    if (brakeStopRequested) return false;
    brakeStopRequested = true;
    brakeStopResolve?.();
    brakeStopResolve = null;
    return true;
}

/** 进程是否被要求收工（projectRunner / 测试可查） */
export function isBrakeStopRequested(): boolean {
    return brakeStopRequested;
}

/**
 * 等"该收工了"的信号（projectRunner.drivePhases 用它 race 掉 waitForMessage）。
 *   ⚠️ 惰性建 promise：只在真的有人等时才创建，避免每条消费线都挂一个常驻 promise。
 */
export function waitForBrakeStop(): Promise<void> {
    if (brakeStopRequested) return Promise.resolve();
    if (!brakeStopPromise) {
        brakeStopPromise = new Promise<void>((resolve) => { brakeStopResolve = resolve; });
    }
    return brakeStopPromise;
}

/** 仅供测试：清掉信号（同一进程里跑多轮用例时需要） */
export function resetBrakeStopForTest(): void {
    brakeStopRequested = false;
    brakeStopResolve = null;
    brakeStopPromise = null;
}

// ---------- ① developer 永动消费线 ----------

/**
 * 启动团队线里的 developer。fire-and-forget（与其他 agent 的 start() 同款常驻）。
 * ⚠️ 座位预占必须在这里、且在架构师可能派发之前的任何时刻完成：
 *   Hub.register 会清空 inbox，而后建 handle 的 HubAdapter 检测到已注册就跳过注册
 *   （hubAdapter.ts:66 的探测），在途消息才不丢。
 */
export function startDeveloperLine(station: TransferStation, engineProjectId: number): void {
    if (!station.status[DEVELOPER_NAME]) station.register(DEVELOPER_NAME, roles.unknown);
    void (async () => {
        for (; ;) {
            if (isBrakeStopRequested()) return;   // ★ 保状态退出的收工点：不再消费新任务，让进程干净落地
            const m = await station.waitForMessage(DEVELOPER_NAME);
            station.markDone(DEVELOPER_NAME);
            if (!m) continue;
            const pkg = parseInbound(m.content);
            if (!pkg.ok || pkg.message.type !== "architect_task") {
                console.warn(`[developer-line] 丢弃非 architect_task 的到站消息（sender=${m.sender}）：`
                    + (pkg.ok ? pkg.message.type : pkg.error));
                continue;
            }
            try {
                const keepGoing = await runOneTask(station, engineProjectId, pkg.message);
                // ★ 刹车等不到确认 → 任务已留在 waiting_human（非终态、可续跑），开发线就此收工；
                //   进程由 projectRunner 干净退出，Java 对账器下次重新拉起来接着干。
                if (!keepGoing) {
                    console.error("[developer-line] 🌙 刹车保状态退出：开发线收工，任务留在账本可续跑");
                    return;
                }
            } catch (e) {
                console.error(`[developer-line] handle 生命周期异常（不杀驱动环）：${(e as Error).message}`);
            }
            drainStale(station);   // 作废/终态后的残批清光，不带进下一个任务
        }
    })().catch((e) => console.error("[developer-line] ⛔ 驱动环死了，后续阶段无人消费：", e));
}

/** 收件箱清空（任务间卫生）：读出来只留痕，不回投（残批属于已作废/已完成的流） */
function drainStale(station: TransferStation): void {
    while (station.hasPending(DEVELOPER_NAME)) {
        void station.waitForMessage(DEVELOPER_NAME)?.then((d) => {
            station.markDone(DEVELOPER_NAME);
            const t = (parseInbound(d?.content ?? "").ok ? (parseInbound(d!.content) as { message: { type: string } }).message.type : "?");
            console.warn(`[developer-line] 清废弃残消息：${d?.sender ?? "?"} → ${t}`);
        });
    }
}

/**
 * 预算推导（2026-09-17 二次重写：**有限**，不再是 MAX_SAFE_INTEGER）。
 *
 *   上一版写的是 Number.MAX_SAFE_INTEGER（对齐 Claude Code"主循环没有调用数预算"的口径），
 *   代价已经付过了：团队线因此一道内部刹车都没有——内层的超时/重复失败/停滞/孤儿回收
 *   全都要"模型给出可判定的信号"才触发，模型一直正常地换花样干活就永远不触发。
 *   eval-s4（3608s）/ s4c（5409s）/ s4d（5409s）/ s5b（7209s）四次全是被**外层**
 *   eval 驱动器 --timeout-min 杀掉的，sys_project.status 停在 executing：60~120 分钟
 *   真实 LLM 花费，收尾时既没有结论也没有死因（s4c/s4d 被杀时 HTTP 判据已经 6/6 全绿）。
 *
 *   现在的定价（三档取最小，全部有限）：
 *     ① 数据档：30 基数 + 18/工作项 + 9/判据，夹紧 [120, 900]——判据是"验收要过的东西"，
 *        是任务规模最诚实的度量（架构师拆解的产物，项目越大自动越宽）；
 *     ② 运维档：CF_MAX_LLM_CALLS（brake.ts，默认 400，硬夹 ≤4000）；
 *     ③ 取 min：数据档算出来比运维档还宽时，以运维档为准（否则"规模大"就变成"成本无上限"）。
 *   校准：s4c（5 工作项 + 12 判据，含预演自修）实测 145~147 调，公式给 152，当时贴着上限；
 *   运维档 400 ≈ 该量的 2.7 倍，日常不误伤，同时给成本一个真上限。
 *   真失控仍由无进展保险丝（isAcceptanceStalled/isStalled/isRepeatedFailure）先兜——
 *   本闸是**天灾兜底**，不是日常油门。
 */
function budgetOf(task: ArchitectTask, policy: BrakePolicy): number {
    const items = task.foundationPlan.workItems?.length ?? 0;
    const checks = task.acceptanceChecks?.length ?? 0;
    const derived = Math.min(900, Math.max(120, 30 + 18 * items + 9 * checks));
    return Math.min(derived, policy.initialMaxLlmCalls);
}

/**
 * 驱动环的**调用数读数口径**：handle 的预算与闸门预算取 min。
 *
 *   加时会把 policy.maxLlmCalls 往前推 +200，但 handle 的 maxLlmCalls 是**创建时定格**的
 *   （图内部的 llmCallsPlanned，改它要动 graph.ts，而另一个 agent 正在改那两个文件——接口面不许踩）。
 *   所以两边的口径必须分清：
 *     · **允许量 allowance** = min(handle 预算, policy 上限)——"到哪个数算到点"，加时后重新取 min；
 *     · **天花板 hardLlmCalls** 是绝对的，不受 policy 增长影响（防加时把天花板自己也推走）。
 *   实测影响：默认档下调用数加时只在"数据档比运维档宽"的任务上真正生效（300 调以上的大任务），
 *   小任务本来就在规划范围内跑完——这不是漏洞，是"handle 预算已经卡住"的如实反映。
 */
function callAllowance(policy: BrakePolicy, llmBudget: number): number {
    return Math.min(llmBudget, policy.maxLlmCalls);
}

/**
 * 刹车问答器：**故意不 import confirm.ts / GraphFactory**。
 *
 *   为什么自带一份实现（不是抄近路）：
 *     · `developerAgent/tests/graph.test.ts:319` 有一道架构闸——**developerAgent 目录下任何文件
 *       都不许 import GraphFactory**（旧控制平面必须留在门外）。从 confirm.ts 取 pickQuestioner
 *       会连带把 GraphFactory 拉进来，闸当场变红（实测踩过）。
 *     · 所以这里按 confirm.ts:78 的三分流口径自带一份，形态与 GraphFactory.Questioner 结构兼容
 *       （同一套 ask(q) 签名），不引入任何旧控制平面的符号。
 *     · 三种形态：
 *         AUTO_CONFIRM=1           → CLI 版自动答 "y"（CI/演示；解析后 = 选项 1「加时继续」）
 *         EXIT_AT_PHASE_BOUNDARY=1 → HTTP 版：问题落 sys_confirm，等浏览器点出来（Web 管理的跑法）
 *         都没有（手工终端跑）      → CLI 版真 stdin 交互
 *     · 题面里的数字全部来自 brakeQuestion（带账目），所以人做的是"能决策的决定"。
 *     · 题目的类型用 brake.ts 的 BrakeQuestion / BrakeQuestioner（同样不 import GraphFactory）。
 */
const CONFIRM_ASK_PATH = "/api/confirm/engine/ask";
const CONFIRM_ANSWER_PATH = "/api/confirm/engine/answer";
/** 轮询间隔（与 confirm.ts 的 CONFIRM_POLL_MS 同源，默认 4s） */
const CONFIRM_POLL_MS = Number(process.env.CONFIRM_POLL_MS ?? 4000);

/** 刹车问答器工厂：拿不到（环境异常）返回 null，驱动环按"提问失败"处理，绝不崩 */
function makeBrakeQuestioner(projectId: number): BrakeQuestioner | null {
    try {
        if (process.env.EXIT_AT_PHASE_BOUNDARY === "1" && process.env.AUTO_CONFIRM !== "1") {
            return httpBrakeQuestioner(projectId);
        }
        return cliBrakeQuestioner();
    } catch (e) {
        console.error(`[developer-line] ⚠ 问答器装配失败（按提问失败处理）：${(e as Error).message}`);
        return null;
    }
}

/** CLI 版：AUTO_CONFIRM=1 直接答 "y"（= 选项 1 加时继续）；否则读 stdin */
function cliBrakeQuestioner(): BrakeQuestioner {
    return {
        ask: (q) => {
            if (process.env.AUTO_CONFIRM === "1") return Promise.resolve("y");
            return new Promise<string>((resolve) => {
                const hint = q.options ? `（${q.options.join(" / ")}）` : "";
                process.stdout.write(`${q.prompt}${hint} `);
                process.stdin.once("data", (buf) => resolve(String(buf).trim()));
            });
        },
    };
}

/**
 * HTTP 版：问题落 sys_confirm（幂等建题）→ 轮询取终局。
 *   与 confirm.ts:21 的 HttpQuestioner 同口径：**本端只管等**，超时无人应答由 Java 侧
 *   lazy 判 auto_passed（默认答案 = 选项第一项 = "加时继续"），确定性逻辑不赌两端时间同步。
 *   轮询期间的网络抖动只记一条 warn 继续等（题在库里，进程活着答案迟早回来）。
 */
function httpBrakeQuestioner(projectId: number): BrakeQuestioner {
    return {
        ask: async (q) => {
            const base = javaBaseUrl();
            const body = JSON.stringify({
                questionId: q.questionId, projectId,
                node: "developer",                       // 展示/审计字段：这道题是开发线问的
                question: q.prompt, options: q.options ?? [],
            });
            const askRes = await fetch(`${base}${CONFIRM_ASK_PATH}`, {
                method: "POST", headers: { "Content-Type": "application/json" }, body,
            });
            const askJson = await askRes.json().catch(() => null) as { code?: number; msg?: string } | null;
            if (!askRes.ok || askJson?.code !== 1) {
                throw new Error(`刹车建题失败: HTTP ${askRes.status} ${askJson?.msg ?? ""}`);
            }
            for (; ;) {
                await new Promise((r) => setTimeout(r, CONFIRM_POLL_MS));
                let d: { status?: string; reply?: string | null } | null = null;
                try {
                    const r = await fetch(`${base}${CONFIRM_ANSWER_PATH}/${q.questionId}`);
                    d = ((await r.json()) as { data?: { status?: string; reply?: string | null } })?.data ?? null;
                } catch (e) {
                    console.warn(`[confirm] 刹车题轮询异常（继续等）:`, (e as Error).message);
                    continue;
                }
                if (d?.status === "answered") {
                    console.log(`[confirm] ${q.questionId} 人已答：${d.reply}`);
                    return d.reply ?? "";
                }
                if (d?.status === "auto_passed") {
                    console.warn(`[confirm] ${q.questionId} 超时无应答，按默认答案（选项 1）继续：${d.reply}`);
                    return d.reply ?? "";
                }
            }
        },
    };
}

/** 一个任务包的完整生命周期：建 handle → 驱动到终态 → 关账本 */
async function runOneTask(station: TransferStation, engineProjectId: number, task: ArchitectTask): Promise<boolean> {
    const dir = projectDir(engineProjectId);
    const ledgerPath = path.join(dir, "_developer", `${task.taskId}.db`);
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });

    // ★ 搬运④（2026-09-17，opencode session.getUsage / dsh token-meter 同族）：
    //   onCall 逐次累加 token 用量，终态随 finishReport 打总账——之前这条生产链路
    //   只有逐行日志没有汇总，评测时 token 花费只能靠正则扒日志。
    const tokenTally = { calls: 0, input: 0, output: 0, escalations: 0 };
    const llm = createRealLlm({
        onCall: (i) => {
            const extra = i.attempts > 1 ? ` [${i.escalated ? "升档" : "重试"}×${i.attempts}]` : "";
            tokenTally.calls += 1;
            tokenTally.input += i.inputTokens;
            tokenTally.output += i.outputTokens;
            if (i.escalated) tokenTally.escalations += 1;
            console.log(`[developer-llm] ${i.latencyMs}ms in=${i.inputTokens} out=${i.outputTokens} stop=${i.stopReason}${extra}`);
        },
    });
    // ★ 闸门在**建 handle 之前**定格：policy 里的 deadlineAt 是绝对时刻，
    //   从这一刻起算墙钟；handle 创建/首跑的花销都算在预算里（不许在预算外偷跑）。
    //   加时改的是 policy 的 SOFT 阈值（deadlineAt 前移）——驱动环每圈重读，不缓存。
    const policy = resolveBrakePolicy();
    const llmBudget = budgetOf(task, policy);
    const handle = createDeveloperAgent({
        projectId: task.projectId, taskId: task.taskId,
        projectDir: dir,
        allowedRoots: [...task.allowedRoots],
        ...(task.forbiddenPaths?.length ? { forbiddenPaths: [...task.forbiddenPaths] } : {}),
        ledgerPath,
        // runId=taskId：同一任务重派发（续跑）落回同一账本 → 幂等/检查点语义跨进程生效
        runId: task.taskId,
        station,
        batched: true,                                   // 「拆一个推一个」分批消费（9/15）
        trustedTestAgents: [TEST_CORE_NAME],             // 只认团队里的 test-core 发的结果
        copyTerminalsTo: MAINTAINER_NAME,                // blocked/failed 抄送记账方（lane D 装配点#1）
        targets: { test: TEST_CORE_NAME, architect: ARCHITECT_NAME, maintainer: MAINTAINER_NAME },
        sandbox: { mode: "soft", backend: "local" },     // 与 hub-runner 实弹档一致（本机无 docker）
        llmErrorTolerance: 2,
        maxLlmCalls: llmBudget,
        // 墙钟是**依赖**不是 env 深读：等待窗口（waiting_test）不许活得比整轮墙钟还久，
        // 否则刹车到点时账本上还挂着一条"正在等测试"的窗口，读起来像系统在等，其实整轮已超时。
        wallClockDeadlineAt: policy.deadlineAt,
        llm,
    });

    console.log(`[developer-line] 接任务 ${task.projectId}/${task.taskId}：工作项 `
        + `${task.foundationPlan.workItems?.length ?? 0} 个，预算 ${llmBudget} 调，`
        + `墙钟 ${policy.source.wallMinutes} 分钟（${brakeSourceNote(policy)}），产物树 ${dir}`);

    // ★★ 跨进程保留（老板口径：**保留决策，不保留原始对话**）：
    //   暂停之后被重新拉起来时，把账本里那些"决策"重新变成任务书里的一小段 **resume brief**，
    //   拼进 DeveloperInstructions（task.md:33 的 {{developerInstructions}} 占位符 →
    //   必然出现在任务书/提示材料里）。它**不含任何 transcript**，只有：
    //   第几次续跑 / 上次为什么停 / 人的指令原文 / 工作项剩余 id / 别重做已完成写操作 /
    //   上次几条判据绿。原始对话照旧不跨进程保留（renderTask 每轮重渲染任务书，见 brake.ts 头注释）。
    const brief = buildBriefFor(handle);
    if (brief) {
        console.log(`[developer-line] ${resumeBriefText(brief).split("\n")[0]}`
            + `（题号 ${lastBrakePause(handle)?.questionId ?? "?"}）`);
        handle.ledger.appendEvent("brake_resumed", {
            continuation: brief.continuation,
            questionId: lastBrakePause(handle)?.questionId ?? null,
            brief: resumeBriefText(brief),
        });
    }

    // 崩溃重放：ledger 已有同身份在途状态 → 直接续消费（重发的 architect_task 已在
    // 上面被外层取出；批由 resumeWithBatch 按到窗消化）。身份不符 = 装配错误，显式炸。
    // 身份核对用 taskId 即可：账本文件按 taskId 分路径、runKey 含 projectId，串台到不了这行。
    const prior = handle.ledger.loadState();
    if (prior) {
        if (prior.taskId !== task.taskId) {
            console.error(`[developer-line] ⛔ ledger 身份不符（prior.taskId=${prior.taskId} ≠ ${task.taskId}），本任务跳过`);
            await handle.shutdown();
            return true;
        }
        console.log(`[developer-line] 检测到在途 ledger（status=${prior.status}），走续跑`);
        if (isTerminalStatus(prior.status)) { await finishReport(handle, prior, tokenTally); return true; }
    } else {
        const first = await handle.acceptArchitectTask(taskWithBrief(task, brief));
        if (isTerminalStatus(first.status)) { await finishReport(handle, first, tokenTally); return true; }
    }

    // ★ 检查点循环（三改）：到阈值 → 问人 → 静默等 → 按答案继续 / 收口 / 干等没人就保状态退出。
    //   policy 与 round 都是**可变**的：加时就地前移期限，下一圈重新判闸（绝不缓存期限）。
    //   round 在"重新拉起进程"时从刹车暂停事件里恢复——同一次检查点必须问同一个题号。
    const askHuman = makeBrakeQuestioner(taskProjectId(task, engineProjectId));
    const resume = lastBrakePause(handle);
    const round: BrakeRound = { n: resume?.round ?? 1 };

    for (; ;) {
        const outcome = await driveToTerminal(handle, policy, llmBudget, round);
        if (outcome.kind === "terminal") { await finishReport(handle, outcome.state, tokenTally); return true; }
        // 无人值守天花板：自己收口（只可能出现在 AUTO_CONFIRM=1 那条路上）
        if (outcome.kind === "stopped") {
            await brakeFinalized(handle, outcome.status, outcome.verdict, policy, llmBudget, tokenTally);
            return true;
        }
        // 到点该问人：问出去 → 静默等 → 按答案决定下一步
        const next = await brakeCheckpoint(handle, outcome.status, policy, llmBudget, askHuman, round);
        if (next === "continue") continue;                       // ★ 人答继续 → 加时后接着驱动
        if (next === "stopped") {
            await brakeFinalized(handle, lastStatus(round), "人确认收口/停止", policy, llmBudget, tokenTally);
            return true;
        }
        // next === "paused"：静默等满没人确认 → 保状态退出（**不 abort、不落 blocked**）
        return false;
    }
}

/** driveToTerminal 最近一次到点读数（收口报告要用它；避免再判一次闸） */
function lastStatus(round: BrakeRound): BrakeStatus {
    return round.last ?? {
        tripped: true, reason: "wall_clock", elapsedMs: 0, maxWallMs: 0,
        callsCompleted: 0, maxLlmCalls: 0, hard: false,
    };
}

/** 问答器的 projectId：任务自带的优先（与 handle 同源），没有就用引擎项目号兜底 */
function taskProjectId(task: ArchitectTask, engineProjectId: number): number {
    const pid = Number(task.projectId);
    return Number.isInteger(pid) && pid > 0 ? pid : engineProjectId;
}

/** 日志里一句话交代闸门是哪来的（默认档 / env 改过哪个旋钮），对账时不用去猜 */
function brakeSourceNote(policy: BrakePolicy): string {
    return policy.source.fromEnv.length > 0 ? `来自 ${policy.source.fromEnv.join("+")}` : "默认档";
}

/**
 * 驱动环：serveOnce 到窗消费（停车队列在它内部）；waiting_test 挂看门狗防验收失联。
 *
 *   ★ 2026-09-17 二次修复：本环**每转一圈先过一道闸**（developerAgent/brake.ts）。
 *     上一版这里写的是"不加墙钟、以完成信号 + 无进展保险丝为唯一出口"，代价见 brake.ts 头注释：
 *     eval-s4/s4c/s4d/s5b 四次实跑 3608~7209s 全被外层杀死、status 停在 executing、
 *     零结论零死因。闸门是**额外**的外层边界，内层的超时/重复失败/停滞/孤儿回收一概不动。
 *
 *   ★★ 三次改造（老板最终口径："不杀了，就参考 claudecode"）：
 *     **到阈值不是死点，是检查点**。本函数只负责"判到点"和"停下来"，三件事都不做：
 *     不 abort、不落 blocked/failed、不判死。它返回三种结果：
 *       · terminal —— 图自己走到终态（正常收工）；
 *       · ask      —— 到检查点，该问人了（调用方去问 + 静默等；人答继续就回来接着驱动）；
 *       · stopped  —— **只有无人值守（AUTO_CONFIRM=1）撞到天花板**才走这条：自己收口，
 *                     免得把评测台跑挂。Web/手工跑法永远拿不到 stopped。
 *     提问失败、等不到人，都由调用方处理成"保状态退出"（任务留在 waiting_human 可续跑），
 *     绝不是"任务失败"——这正是 s4/s4c/s4d/s5b 被外层杀掉之后缺的那条路。
 *
 *   ★ "继续开工"能成立的两个前提（改动时别破坏）：
 *     ① 每一圈**重新读** policy（checkBrake 吃的是 policy 现值，期限没有在环外缓存）；
 *     ② 停手发生在**任何清理/收口之前**（serveOnce 只消费消息，abortRun/shutdown 都还没调）。
 *
 *   拆成独立导出函数是为了可测：单测用假 handle 就能证明
 *   "到点只是返回 ask"（既不 abort 也不落终态），不需要任何真实 LLM 调用。
 */
export async function driveToTerminal(
    handle: DeveloperAgentHandle,
    policy: BrakePolicy,
    llmBudget: number,
    round: BrakeRound,
): Promise<
    | { kind: "terminal"; state: { status: string; error?: unknown } }
    | { kind: "ask"; status: BrakeStatus }
    | { kind: "stopped"; status: BrakeStatus; verdict: string }
> {
    for (; ;) {
        const snap = handle.ledger.loadState();
        if (snap && isTerminalStatus(snap.status)) return { kind: "terminal", state: snap };
        // 检查点判定在**每次可能烧钱的动作之前**：到点就地返回 ask，不再 serveOnce、不再等消息
        const status = checkBrake(policy, {
            callsCompleted: snap?.llmCalls ?? 0,   // TaskSnapshot 的字段名是 llmCalls（= 状态里的 llmCallsCompleted）
            elapsedMs: Date.now() - policy.startedAt,
            callsAllowance: callAllowance(policy, llmBudget),
        });
        round.last = status;
        if (status.tripped) {
            // 无人值守天花板 → 自己收口（这条路上人不在，等也白等，不能让评测台挂住）
            if (status.hard) {
                return { kind: "stopped", status, verdict: "撞到无人值守天花板（AUTO_CONFIRM 模式下自保收口）" };
            }
            // 同一轮检查点只问一次：问过了就交给调用方（问过的那些都返回 ask，由调用方推进 round）
            return { kind: "ask", status };
        }
        if (snap?.status === "waiting_test") {
            const wait = handle.ledger.getTestWait();
            const hardDeadline = (wait?.deadlineAt ?? Date.now() + 900_000) + 60_000;
            const raced = await Promise.race([
                handle.serveOnce().then((r) => ({ kind: "msg" as const, r })),
                new Promise<{ kind: "timeout" }>((res) => setTimeout(() => res({ kind: "timeout" }), Math.max(Math.min(hardDeadline, policy.deadlineAt) - Date.now(), 1_000))),
            ]);
            if (raced.kind === "timeout") {
                console.error("[developer-line] ⛔ 看门狗：test-core 超窗未回结果 → 收口 blocked");
                await handle.blockUnverified({
                    reason: "验收等待超窗：test-core 未按时回应 test_request",
                    skipped: [{ checkId: "ACCEPTANCE", kind: "VERIFY", reason: "tester-timeout" }],
                });
                continue;
            }
            if (raced.r === "rejected") { await abortGateRejected(handle); continue; }
            continue;
        }
        const next = await handle.serveOnce();
        if (next === "rejected") { await abortGateRejected(handle); continue; }
        // null = invalid/duplicate：消息已被 adapter 留痕，继续等下一条
    }
}

/**
 * 检查点的轮次状态（跨"重新拉起进程"保持同一个题号；一次运行内可变）。
 *   只用 n：一次运行里"到点 → brakeCheckpoint"是**一一对应**的（问完要么 continue 接着跑、
 *   要么 stopped、要么 paused 直接退出），所以不存在"同一轮重复问"的中间态，不需要额外标志位。
 */
export interface BrakeRound {
    /** 第几次检查点（题号 brake-<taskId>-<n>） */
    n: number;
    /** 最近一次到点读数（报告要用） */
    last?: BrakeStatus;
    /** 本轮实际问出去的题号（审计/日志用） */
    lastQuestionId?: string;
}

/** 从账本恢复"上次刹车暂停时的轮次"（下次拉起来要问**同一个题号** → 幂等消费人已给的答案） */
export function lastBrakePause(handle: DeveloperAgentHandle): { round: number; questionId: string } | null {
    const events = handle.ledger.listEvents();
    for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i];
        if (!ev || ev.type !== "brake_paused") continue;
        const p = ev.payload as { round?: unknown; questionId?: unknown } | null;
        const round = Number(p?.round);
        const questionId = typeof p?.questionId === "string" ? p.questionId : "";
        if (Number.isInteger(round) && round > 0) return { round, questionId };
        return null;
    }
    return null;
}

/** 提问/答案/暂停三种推进结果 */
export type BrakeStep = "continue" | "stopped" | "paused";

/**
 * 检查点：**问人 → 静默等 → 按答案决定**（这是"和用户对话之后才继续开工"的落点）。
 *
 *   ① 组一道带真数字的题（brakeQuestion），题号确定：brake-<taskId>-<轮次>；
 *   ② 静默等待（askBrakeQuietly）：窗口内零模型调用、零写盘；
 *   ③ 按答案：
 *        · 继续 → grantBrakeExtension 前移期限，**返回 "continue" 让驱动环接着跑**；
 *        · 收口/停止 → 落账本事件，返回 "stopped"（由调用方按现状收口并交进展报告）；
 *        · 没人确认 → pauseBrake：落 brake_paused + 状态留 waiting_human（**不 abort、不落终态**），
 *          请求进程收工，返回 "paused"；
 *        · 问不出去（问答器没装配 / 抛异常）→ 同样走 pauseBrake，但事件里写明失败原因。
 *
 *   导出是为了可测：单测用假 handle + 假问答器就能钉住
 *   "答继续→前移期限接着跑 / 没人答→保状态退出（不 abort、不落 blocked）"这两条关键语义。
 */
export async function brakeCheckpoint(
    handle: DeveloperAgentHandle,
    status: BrakeStatus,
    policy: BrakePolicy,
    llmBudget: number,
    askHuman: BrakeQuestioner | null,
    round: BrakeRound,
): Promise<BrakeStep> {
    const summary = summaryOf(handle, status, policy, llmBudget);
    // ★ 题号幂等：暂停后重新拉起来，**必须问同一道题**——人可能在停机期间已经答了
    //   （HttpQuestioner 建题幂等 + 轮询取答；confirm.ts:24 的 ask 就是"建题 → 取终局"）。
    //   只有"已经因为这道题加过时"（brake_extended 落过账）才换下一道题，否则会既消费旧答案又立刻又问。
    const decisionBefore = pickQuestionId(handle, round);
    round.n = decisionBefore.round;
    const question = brakeQuestion(status, summary, round.n);
    round.lastQuestionId = question.questionId;
    handle.ledger.appendEvent(brakeEventName(status.reason ?? "wall_clock"), {
        reason: status.reason, questionId: question.questionId, round: round.n,
        ...summaryPayload(summary),
        detail: brakeReasonText(status),
    });
    console.error(brakeAskLogLine(status, question, policy.waitMs));

    if (!askHuman) {
        return pauseBrake(handle, status, policy, round, question, summary, "问答器未装配");
    }
    let result;
    try {
        result = await askBrakeQuietly(question, askHuman, policy.waitMs);
    } catch (e) {
        return pauseBrake(handle, status, policy, round, question, summary, (e as Error)?.message ?? String(e));
    }

    // ★ 静默等满没人确认 → 保状态退出（任务信息保留，下次拉起来问同一道题）
    if (result.timedOut) {
        return pauseBrake(handle, status, policy, round, question, summary, null, result.waitedMs);
    }

    const decision = parseBrakeAnswer(result.answer ?? "");
    if (decision.action === "extend") {
        if (decision.guidance) {
            handle.ledger.appendEvent("brake_guidance", {
                text: decision.guidance.slice(0, 1000), questionId: question.questionId,
            });
        }
        const now = Date.now();
        const grant = grantBrakeExtension(policy, now);
        handle.ledger.appendEvent("brake_extended", {
            questionId: question.questionId, round: round.n, index: grant.index,
            addMinutes: policy.extendMinutes, deadlineAt: policy.deadlineAt,
            answer: describeBrakeDecision(decision), ...summaryPayload(summary),
        });
        console.error(brakeResumedLogLine(status, policy, decision, now));
        round.n += 1;                 // 这道题已经用掉了，下一次检查点是新的一道题
        return "continue";
    }
    handle.ledger.appendEvent(decision.action === "stop" ? "brake_user_stopped" : "brake_user_finalize", {
        questionId: question.questionId, round: round.n,
        reason: describeBrakeDecision(decision), extensionsUsed: policy.extensionsUsed,
    });
    return "stopped";
}

/**
 * 决定这次该问哪一道题（**题号幂等的核心**）。
 *   · 账本里没有 brake_paused → 全新检查点：题号 = 已加时次数 + 1；
 *   · 有 brake_paused 且这道题**还没被消费过**（没有对应 round 的 brake_extended）→
 *     重问**同一道题**（人停机期间答过的答案会被 ask 直接取到）；
 *   · 那道题的答案已经被消费过（加时落过账、但出口前又到点）→ 换下一道，
 *     免得把同一个答案消费两次。
 */
export function pickQuestionId(
    handle: DeveloperAgentHandle,
    round: BrakeRound,
): { round: number; questionId: string } {
    const events = handle.ledger.listEvents();
    const extensions = countExtensions(events);
    const pause = findBrakePause(events);
    const taskId = summaryTaskId(handle);
    if (pause && extensions === pause.extensionsUsed) {
        return { round: pause.round, questionId: brakeQuestionId(taskId, pause.round) };
    }
    const n = Math.max(round.n, extensions + 1);
    return { round: n, questionId: brakeQuestionId(taskId, n) };
}

/** 账本里的 taskId（没有就退回只读视图） */
function summaryTaskId(handle: DeveloperAgentHandle): string {
    return handle.ledger.loadState()?.taskId ?? handle.inspectTaskState().taskId;
}

/**
 * 保状态退出（**不杀任务**）：先落进展报告，再把任务留在 waiting_human，最后请求进程收工。
 *
 *   顺序是刻意的（外层随时可能杀进程，先写原因再说）：
 *     ① brake_paused（含完整进展报告 + 题号 + 轮次）—— 下次拉起来靠它恢复同一道题；
 *     ② task_state = waiting_human（**非终态**、可续跑；不碰 blocked/failed）；
 *     ③ requestBrakeStop() —— 让 projectRunner 干净退出（Java 对账器下次重新拉进程）。
 *   ⚠️ 这里**绝对不调 abortRun / blockUnverified**：老板口径是"不杀了，任务信息保留"。
 */
/**
 * 从账本 + 当前进度组装 resume brief（这次不是暂停后续跑 → 返回 null，零扰动）。
 *   纯函数在 brake.ts（resumeBrief），这里只负责"取材"：进度取 handle 的只读视图，
 *   验收绿数取账本里最近一条 acceptance_criteria_status。
 */
export function buildBriefFor(handle: DeveloperAgentHandle): ResumeBrief | null {
    const events = handle.ledger.listEvents();
    if (!findBrakePause(events)) return null;
    const snap = handle.inspectTaskState();
    const remaining = snap.workItems.filter((w) => !w.done).map((w) => w.id);
    const checks = acceptanceGreen(events);
    return resumeBrief({
        events, remaining,
        workItemsDone: snap.workItems.length - remaining.length,
        workItemsTotal: snap.workItems.length,
        checksGreen: checks?.green ?? null,
        checksTotal: checks?.total ?? null,
    });
}

/**
 * 把 resume brief 拼进任务副本的 DeveloperInstructions（**不改调用方的 task 对象**）。
 *   走这条路的原因：任务书是 graph.ts:1599 `state.developerInstructions + blueprintCoverageOf(state)`
 *   渲染进 task.md 的 {{developerInstructions}}，而 developerInstructions 来自
 *   `acceptArchitectTask(task).developerInstructions`（index.ts:750）。
 *   我不能改 graph/index，所以从**入参侧**注入——这正是"替换 transcript 的那份材料"的落点。
 */
export function taskWithBrief(task: ArchitectTask, brief: ResumeBrief | null): ArchitectTask {
    if (!brief) return task;
    const text = resumeBriefText(brief);
    return { ...task, developerInstructions: `${task.developerInstructions}\n\n${text}` };
}

function pauseBrake(
    handle: DeveloperAgentHandle,
    status: BrakeStatus,
    policy: BrakePolicy,
    round: BrakeRound,
    question: BrakeQuestion,
    summary: BrakeSummary,
    askFailed: string | null,
    waitedMs?: number,
): BrakeStep {
    const report = buildProgressReport(status, summary, askFailed
        ? `静默等待没能问出去（${askFailed}）→ 保状态退出`
        : `静默等满 ${formatWait(waitedMs ?? policy.waitMs)} 没人确认 → 保状态退出`);
    handle.ledger.appendEvent("brake_paused", {
        questionId: question.questionId, round: round.n,
        reason: status.reason, askFailed, waitedMs: waitedMs ?? null,
        waitMs: policy.waitMs, extensionsUsed: policy.extensionsUsed,
        // ★ 保留决策（不是对话）：最近几次工具调用的**短摘要**，给续跑一个"我从哪停下来"的锚点。
        //   只取工具名 + 成败 + 摘要（不放参数正文/输出正文——那是 rawLogPath 的活，不是模型上下文）。
        toolDigest: recentToolDigestOf(handle),
        // ★ 验收判据基线也钉在暂停记录里（下一轮即使没有别的读数，也知道上次绿了几条）
        checksGreen: summary.checksGreen, checksTotal: summary.checksTotal,
        text: report.text, ...report.payload,
    });
    // ★ 非终态、可续跑：复用 state.ts 的 waiting_human（9/17 加的"暂停问人"态），不新造状态
    const snap = handle.ledger.loadState();
    handle.ledger.saveState({
        taskId: qTaskId(handle, snap),
        status: "waiting_human",
        repairAttempts: snap?.repairAttempts ?? 0,
        failureSignatures: snap?.failureSignatures ?? [],
        changedFiles: snap?.changedFiles ?? [],
        llmCalls: snap?.llmCalls ?? 0,
    });
    console.error(brakePausedLogLine(waitedMs ?? policy.waitMs, question, report.text));
    requestBrakeStop();               // 让进程干净落地（drivePhases 的无限等待靠这个解除）
    return "paused";
}

/** 账本里的 taskId（saveState 必须带；取不到就用 handle 的只读视图） */
function qTaskId(handle: DeveloperAgentHandle, snap: { taskId?: string } | null): string {
    if (snap?.taskId) return snap.taskId;
    return handle.inspectTaskState().taskId;
}

/**
 * 最近几次工具调用的**短摘要**（进 brake_paused 的 toolDigest）。
 *   取材：ledger 的 `tool_call` 表（每次调用的工具名/成败/改动文件），**不碰输出正文**。
 *   用途：续跑时人一眼看到"上次干到哪一步"；也是"我保留了决策、没保留对话"的具体形状。
 */
function recentToolDigestOf(handle: DeveloperAgentHandle): string[] {
    try {
        return handle.ledger.listToolCalls().slice(-5).map((c) =>
            `${c.ok ? "✓" : "✗"} ${c.toolName}${c.changedFiles.length > 0 ? `（改了 ${c.changedFiles.length} 文件）` : ""}`);
    } catch {
        return [];   // 账本读不动不该拖垮暂停路径（宁可少一条摘要，也要把状态保住）
    }
}

/** 静默窗口的人话（"30 分钟"/"45 秒"——测试里窗口很短，日志别写成"0.0 分钟"） */
function formatWait(ms: number): string {
    return ms >= 60_000 ? `${Math.round(ms / 60_000)} 分钟` : `${Math.round(ms / 1000)} 秒`;
}

/** 摘要的公共字段（进账本载荷，便于对账器直接读，不用自己算） */
function summaryPayload(s: BrakeSummary): Record<string, unknown> {
    return {
        elapsedMs: s.elapsedMs, maxWallMs: s.maxWallMs, hardWallMs: s.hardWallMs,
        callsCompleted: s.callsCompleted, callsAllowance: s.callsAllowance, hardCalls: s.hardCalls,
        changedFiles: s.changedFiles, workItemsDone: s.workItemsDone, workItemsTotal: s.workItemsTotal,
        remainingWorkItems: s.remaining, toolCalls: s.toolCalls, repairAttempts: s.repairAttempts,
        checksGreen: s.checksGreen, checksTotal: s.checksTotal, lastError: s.lastError,
    };
}

/**
 * 进展报告的数字来源：**handle 的只读视图 + 一次廉价的账本读**。
 *   验收判据的绿数从账本最近一条 acceptance_criteria_status 数出来（graph.ts:1496 落的），
 *   取不到就是 null——**诚实交空，绝不编一个好看的数字**。
 */
export function summaryOf(
    handle: DeveloperAgentHandle,
    status: BrakeStatus,
    policy: BrakePolicy,
    llmBudget: number,
): BrakeSummary {
    const snap = handle.inspectTaskState();
    const remaining = snap.workItems.filter((w) => !w.done).map((w) => w.id);
    const events = handle.ledger.listEvents();
    const checks = acceptanceGreen(events);
    return {
        taskId: snap.taskId, status: snap.status,
        elapsedMs: status.elapsedMs, maxWallMs: status.maxWallMs, hardWallMs: policy.hardWallMs,
        callsCompleted: Math.max(status.callsCompleted, snap.llmCallsCompleted),
        callsAllowance: callAllowance(policy, llmBudget), hardCalls: policy.hardLlmCalls,
        changedFiles: snap.changedFiles.length,
        workItemsDone: snap.workItems.length - remaining.length,
        workItemsTotal: snap.workItems.length,
        remaining,
        toolCalls: snap.toolCalls, repairAttempts: snap.repairAttempts,
        checksGreen: checks?.green ?? null, checksTotal: checks?.total ?? null,
        lastError: lastFailureReason(events),
        extensionsUsed: Math.max(policy.extensionsUsed, countExtensions(events)),
        waitMs: policy.waitMs, extendMinutes: policy.extendMinutes,
    };
}

/**
 * 收口（**只在两种情况下发生**：人明确说收口/停止，或无人值守撞到天花板）。
 *   普通 Web/手工跑法等不到人**不会走到这里**——那条路是 pauseBrake（保状态退出）。
 *
 *   顺序刻意的：账本事件（wall_clock_exceeded / brake_progress_report）先落，
 *   **进展报告**写进 developer_blocked.reason（→ 库里的 sys_task.error_msg），
 *   然后才 abortRun。外层 eval 驱动器随时可能因为自己的 --timeout-min 杀进程，
 *   先把原因写进账本，被杀也不会只剩一个 executing。
 *   导出是为了可测：单测用假 handle + 真 Ledger 就能钉住"先留痕、后收口"的顺序与载荷。
 */
export async function brakeFinalized(
    handle: DeveloperAgentHandle,
    status: BrakeStatus,
    verdict: string,
    policy: BrakePolicy,
    llmBudget: number,
    tokenTally: { calls: number; input: number; output: number; escalations: number },
): Promise<void> {
    const s = summaryOf(handle, status, policy, llmBudget);
    const report = buildProgressReport(status, s, verdict);
    /**
     * ★ 进 developer_blocked.reason 的文本（→ 库里的 sys_task.error_msg）**自己带全数字**：
     *   人打开 sys_task 看到的第一眼就该是"跑了多久 / 用了多少调 / 改了几个文件 / 还差几个工作项"，
     *   而不是"失败了"三个字（老板的原话：收口要交东西，人才知道下一步是加时、改范围还是叫停）。
     *   完整版（含【证据】段）落在账本的 brake_progress_report 里，这里放摘要 + 指路。
     */
    const reason = [
        `${brakeReasonText(status)}｜${verdict}`,
        `进展：工作项 ${s.workItemsDone}/${s.workItemsTotal} 完成`
            + `，剩 ${s.remaining.length > 0 ? s.remaining.slice(0, 8).join(", ") : "（无）"}`
            + `；改动 ${s.changedFiles} 个文件，工具调用 ${s.toolCalls} 次，修复尝试 ${s.repairAttempts} 次`,
        `${s.checksTotal === null ? "验收判据无读数" : `验收 ${s.checksGreen}/${s.checksTotal} 绿`}`
            + `；加时 ${s.extensionsUsed} 次`,
        `最近失败：${s.lastError ? s.lastError.slice(0, 300) : "无（就是账目到点了）"}`,
        `完整进展报告见账本事件 brake_progress_report`,
    ].join("；");
    console.error(brakeLogLine(status, {
        changedFiles: s.changedFiles,
        workItemsTotal: s.workItemsTotal,
        workItemsDone: s.workItemsDone,
        remaining: s.remaining,
    }));
    console.error(brakeFinalizedLogLine(status, verdict));
    // 账本事件：eval 报告与对账器 grep 的就是这两个名字（brake.brakeEventName 是唯一出处）
    handle.ledger.appendEvent(brakeEventName(status.reason ?? "wall_clock"), {
        reason: status.reason, ...summaryPayload(s),
        tokenIn: tokenTally.input, tokenOut: tokenTally.output,
        detail: report.reason,
    });
    // 进展报告单独落一条：eval 报告只要 grep `brake_progress_report` 就能拿到全文
    handle.ledger.appendEvent("brake_progress_report", {
        ...report.payload, text: report.text, reason,
        tokenIn: tokenTally.input, tokenOut: tokenTally.output,
    });
    const terminal = await handle.abortRun(reason);
    await finishReport(handle, terminal, tokenTally);
}

/** serveOnce 返回 "rejected" = 协议级异常（伪造 sender/乱序批/过期结果）：整次作废（9/15 拍板②） */
async function abortGateRejected(handle: DeveloperAgentHandle): Promise<void> {
    console.error("[developer-line] ⛔ 驱动闸门拒绝（乱序批/伪造源/过期结果）→ 整次作废");
    await handle.abortRun("DRIVER_GATE_REJECTED");
}

/** 收口报告：terminal 只需 status（TaskSnapshot）；error 字段可选（DeveloperState 才带） */
async function finishReport(handle: DeveloperAgentHandle, terminal: { status: string; error?: unknown }, tokenTally?: { calls: number; input: number; output: number; escalations: number }): Promise<void> {
    const snap = handle.inspectTaskState();
    console.log(`[developer-line] 终态 ${terminal.status}：llm ${snap.llmCallsCompleted}/${snap.llmCallsPlanned} `
        + `工具 ${snap.toolCalls} 修复 ${snap.repairAttempts} 改盘 ${snap.changedFiles.length} 个文件`
        + (tokenTally ? ` token in=${tokenTally.input} out=${tokenTally.output}（${tokenTally.calls} 调，升档 ${tokenTally.escalations}）` : "")
        + (terminal.error ? ` error=${String(terminal.error).slice(0, 200)}` : ""));
    await handle.shutdown();
}

// ---------- ② test-core 的验收依赖（判据从 _tasks 落盘读回） ----------

/** 与 architectTaskBuilder:1012 同一命名规则（itemId 文件系统非法字符 → "_"） */
function batchFileOf(itemId: string): string { return `batch-${itemId.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")}.json`; }

/**
 * 合并判据 = developer 端 acceptBatch 的同构重放：蓝图底线判据在前，
 * 各批按**蓝图工作项顺序**追加，按 id 先到先留（builder 生成侧本就防撞，
 * 去重只是双保险）。顺序与内容一致 → acceptanceHashOf 与 developer 端相等，
 * test-core 的 hash 自检闸才不空转。
 */
export function loadTaskChecks(engineProjectId: number, taskId: string): Record<string, unknown>[] | null {
    const dir = path.join(projectDir(engineProjectId), "_tasks", taskId);
    let blueprint: ArchitectTask;
    try {
        blueprint = JSON.parse(fs.readFileSync(path.join(dir, "blueprint.json"), "utf-8")) as ArchitectTask;
    } catch { return null; }
    const out: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    const push = (c: unknown) => {
        const id = String((c as { id?: unknown }).id ?? "?");
        if (seen.has(id)) return;
        seen.add(id);
        out.push(c as Record<string, unknown>);
    };
    (blueprint.acceptanceChecks ?? []).forEach(push);
    for (const item of blueprint.foundationPlan.workItems ?? []) {
        try {
            const b = JSON.parse(fs.readFileSync(path.join(dir, batchFileOf(item.id)), "utf-8")) as { checks?: unknown[] };
            (b.checks ?? []).forEach(push);
        } catch { /* 该批文件缺 = 派发没到这里，developer 端也不会在送检前等它——跳过 */ }
    }
    return out;
}

/** CONTRACT 判据的起服配置（装配契约：落 RUNS_ROOT/pN/_verify/serve.json，缺=未执行诚实报） */
interface ServeConfig { command: string; args?: string[]; cwd?: string; ready?: { url?: string; timeoutMs?: number } }
function loadServeConfig(engineProjectId: number): ServeConfig | null {
    try {
        const f = path.join(projectDir(engineProjectId), "_verify", "serve.json");
        return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf-8")) as ServeConfig) : null;
    } catch { return null; }
}

/** hub-runner resolveChecks（hub-runner.ts:231-277）的团队线移植：COMPILE/显式命令同款，CONTRACT 吃 serve.json */
function translateChecks(raw: Record<string, unknown>[], dir: string, serve: ServeConfig | null): AdapterVerifyCheck[] {
    const out: AdapterVerifyCheck[] = [];
    for (const c of raw) {
        const id = String(c["id"] ?? "?");
        if (typeof c["command"] === "string") {
            out.push({
                id, category: typeof c["category"] === "string" ? c["category"] : "COMPILE",
                command: c["command"], args: Array.isArray(c["args"]) ? c["args"].map(String) : [],
                cwd: typeof c["cwd"] === "string" ? c["cwd"] : ".",
                timeoutMs: typeof c["timeoutMs"] === "number" ? c["timeoutMs"] : undefined,
            });
            continue;
        }
        if (c["kind"] === "COMPILE") {
            const target = String(c["target"] ?? ".");
            const r = resolveProjectCommand(path.join(dir, target));
            out.push(r
                ? { id, category: "COMPILE", command: r.command, args: r.args, cwd: target, timeoutMs: 600_000 }
                : { id, category: "COMPILE" });   // 认不出工程入口 → 不给命令 → verify 如实未执行
            continue;
        }
        if (c["kind"] === "CONTRACT") {
            if (!serve) { out.push({ id, category: "CONTRACT" }); continue; }   // 无 serve 配置 = 未执行，绝不假绿
            out.push({
                id, category: "CONTRACT", command: serve.command,
                args: [...(serve.args ?? []), "--serve", JSON.stringify({ ...serve, cwd: "." }), "--intent", JSON.stringify({
                    method: c["method"], path: c["path"], expectedStatus: c["expectedStatus"] ?? 200,
                    ...(c["body"] !== undefined ? { body: c["body"] } : {}),
                    ...(typeof c["expectBodyContains"] === "string" ? { expectBodyContains: c["expectBodyContains"] } : {}),
                    ...(c["auth"] ? { auth: c["auth"] } : {}),
                })],
                cwd: serve.cwd ?? ".", timeoutMs: 180_000,
            });
            continue;
        }
        out.push({ id, category: "ENV" });   // 不认识的形状：没命令 = 未执行 = 诚实 blocked
    }
    return out;
}

/** 给 buildTeam 用的 TestEngineer 依赖注入包 */
export function makeTesterDeps(engineProjectId: number): TestEngineerDeps {
    const dirOf = (req: TestRequest): string => {
        const pid = Number(req.projectId);
        return projectDir(Number.isInteger(pid) && pid > 0 ? pid : engineProjectId);
    };
    const checksOf = (req: TestRequest): Record<string, unknown>[] | null => {
        const pid = Number(req.projectId);
        return loadTaskChecks(Number.isInteger(pid) && pid > 0 ? pid : engineProjectId, req.taskId);
    };
    return {
        projectDirOf: dirOf,
        runIdOf: (req) => req.taskId,               // 与 runOneTask 的 runId 同口径
        taskChecks: checksOf,
        resolveChecks: (req) => {
            const dir = dirOf(req);
            const raw = checksOf(req) ?? [];
            return translateChecks(raw, dir, loadServeConfig(engineProjectId));
        },
    };
}
