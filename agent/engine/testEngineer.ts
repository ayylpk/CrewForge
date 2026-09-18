// ============================================================
// testEngineer.ts —— 测试工程师 "test-core" · 改线版（9/15）
//
//   【改线日期与原因】9/15：旧线（吃 merger 的 pair_ready → 机械预检/机械三查/
//   LLM 六项硬清单纸审 → 发 task_passed/task_failed/task_rejected/revision）整体作废。
//   原因：developer 线（developerAgent）自带修复循环（repair），测试方唯一职责
//   变成「用独立 TestAgent 出真话报告」——旧升级返工链（1/2 次 revision、
//   3 次回炉 architect、6 次上报 maintainer）不再存在，计数护栏一并撤销。
//
//   【新线】消息形状逐字对齐 developerAgent/protocol.ts（冻结契约，我方是生产方）：
//     developer ──test_request──▶ test-core（本类，register("test-core", roles.testEngineer)）
//     test-core ──注入的 verifier（默认走 testAgentAdapter → 外部 testAgent --verify）──▶
//     test-core ──test_passed / test_failure──▶ developer（唯一消费者）
//
//   【三道自我校验（回错包/超窗 = 不发并留痕）】
//     ① correlationId：结果必须原样回带本轮请求的身份五字段，对不上 = verifier 回错包，拒发；
//     ② acceptanceHash：从注入的任务包判据（taskChecks，与 developer 端同一份数组）本地
//        算 acceptanceHashOf 对请求——不同源的结果发过去也必被信任链拒，宁可不发只留痕；
//     ③ deadlineAt：到达即超窗 → 连 verify 都不烧；verify 回来才超窗 → 主动弃发
//        （developer 对超窗到达的结果一律拒，硬发只会污染它的 Ledger）。
//        过期语义与 developer 端 isTestWaitExpired 同口径（now > deadlineAt 才算过期）。
//
//   【幂等】同轮票（correlationId|acceptanceHash|deadlineAt 三元组）只处理一次——
//   Hub 重投/双发不会重复烧 verify、不会重复发结果。新一轮送检的 deadlineAt/hash 必变，
//   不会被这里的去重误杀。
//
//   【unverified / needs_human】不冒充 pass/fail（testAgentAdapter 三铁律的下游）：
//   不给 developer 发结果；配了 deps.orchestrator 就按 v2_verdict 形状通知编排站
//   （与 hub-runner stationLoop 同款语义），没配则只在本机日志留痕。
//
//   【主线要注入什么】见 TestEngineerDeps 逐字段注释 + 报告。merger/maintainer/
//   projectRunner 旧线适配归 lane D，不在本文件职责内。
//
//   文件末尾保留一段【旧线遗留导出】：render-smoke / role-prompt-smoke 还在引用
//   （纯函数零副作用），lane D 拆旧线时一并删。
// ============================================================

import { BaseAgent } from "./BaseAgent";
import { roles, type TransferStation } from "./Hub";
import type { Node } from "./Node";
import {
    acceptanceHashOf, TestFailureSchema, TestPassedSchema,
    type TestFailure, type TestPassed, type TestRequest,
} from "./developerAgent/protocol";
import { DEVELOPER_NAME } from "./developerAgent/hubAdapter";
import {
    runTestAgentVerify,
    type AdapterVerifyCheck, type TestAgentAdapterOptions, type VerifyAdapterOutcome,
} from "./testAgentAdapter";
// 召唤工位（9/17 拓扑升级·层 B）：司机中途召唤测试工位时，它**拥有判据的语义解释权**
//   （criterion_clarification）——但**没有判定权**：通过/不通过只能来自独立 TestAgent
//   的机器证据（本文件头注释的"三道自我校验"就是这条的代码落点）。
import { handleConsultRequest } from "./consultStation";
import type { ConsultContext } from "./consultStation";
import { CONSULT_DRIVER } from "./consult";
import type { ConsultRequest } from "./consult";

/** developer 端 trustedTestAgents 将配成 ["test-core"]——注册名是信任链的一部分，不许改 */
export const TEST_CORE_NAME = "test-core";

// ============================================================
// 注入缝：验收执行面（测试注 fake，主线注真身）
// ============================================================

/** 一轮送检的全量输入——agent 把三道闸都过了才交到 verifier 手上 */
export interface VerifyRoundRequest {
    projectId: string;
    taskId: string;
    /** 与 createDeveloperAgent 的 runId 一致（缺省同 taskId，与 hub-runner 现行默认一致） */
    runId: string;
    correlationId: string;
    acceptanceHash: string;
    /** 本轮截止时刻（epoch ms）——agent 已按它做过超窗判定，verifier 可参考但不必自校 */
    deadlineAt: number;
    /** 请求圈定的被测面（developer 现在固定给 ["frontend","backend"]，透传） */
    targets: string[];
    reason: string;
    /** 被测项目目录（来自 deps.projectDirOf） */
    projectDir: string;
    /** verify 能跑的显式命令判据（来自 deps.resolveChecks，hub-runner resolveChecks 同款翻译规则） */
    checks: AdapterVerifyCheck[];
}

/** 验收执行面：产 testAgentAdapter 同款结构化结局，永不要求它「保过」 */
export type TestVerifier = (req: VerifyRoundRequest) => Promise<VerifyAdapterOutcome>;

export interface TestEngineerDeps {
    /**
     * 验收执行面注入。缺省 = 真实现：runTestAgentVerify → 外部 testAgent --verify。
     * 抛异常 = 装配层问题（缺 projectDir/resolveChecks 时真实现会大声抛），
     * agent 只留痕不代发——绝不伪造任何结论。
     */
    verifier?: TestVerifier;
    /**
     * 判据来源①（给 verify 跑）：任务包 → 显式命令判据数组。
     * 主线喂 hub-runner 里那个 resolveChecks()（architect_task.acceptanceChecks 的
     * COMPILE/CONTRACT 意图翻译 + cfg.serve/cfg.extraChecks），逐字可搬。
     */
    resolveChecks?: (req: TestRequest) => AdapterVerifyCheck[] | Promise<AdapterVerifyCheck[]>;
    /**
     * 判据来源②（给 hash 自检）：**developer 端算 acceptanceHash 的同一份原始数组**
     * （整包 = task.acceptanceChecks；分批模式 = 蓝图+已到批合并后的那份，见 index.ts
     * acceptanceHashOf(runTask.acceptanceChecks)）。不是 resolveChecks 的产物——形状不同。
     * 不提供则 hash 自检跳过（developer 端信任链仍是兜底，但本地早停的意义就没了）。
     */
    taskChecks?: (req: TestRequest) => unknown[] | null | Promise<unknown[] | null>;
    /** 被测项目绝对路径（主线 = RUNS_ROOT/<projectId>-1 那套） */
    projectDirOf?: (req: TestRequest) => string;
    /** runId 解析器；缺省 = req.taskId */
    runIdOf?: (req: TestRequest) => string;
    /** 时钟（测试缝）；缺省 = Date.now */
    now?: () => number;
    /** 留痕回调（主线接 Ledger/运行报告）；缺省 = console.log */
    log?: (line: string) => void;
    /** 结果回送目标；缺省 = DEVELOPER_NAME("developer") */
    developerName?: string;
    /** unverified/needs_human 的通知站（如 "v2-orchestrator"）；缺省 = 不通知只留痕 */
    orchestrator?: string;
    /** 真实现透传给 runTestAgentVerify 的选项（testAgentDir/env/reviewMode/timeoutMs…） */
    adapterOptions?: TestAgentAdapterOptions;
    /**
     * 召唤工位（层 B，9/17）的 LLM 端口：被司机召唤时用它组织回答（可选）。
     *   ★ 不注入 = 确定性回答：只复述本工位**真实持有**的东西（判据 id、上一轮送检票、
     *     已记录的判据澄清），confidence 恒为 "low" 并明说没有 LLM——绝不编事实。
     *   ★ 这个端口与验收判定无关：它只是"回答问题"的能力，判据的通过/不通过
     *     永远只能来自下面 verifier 的机器证据（本文件头注释第 3 段）。
     */
    consultLlm?: (prompt: string) => Promise<string>;
}

/** 默认真实现：薄适配器在外跑 testAgent --verify（崩溃/超时/身份不符都会落成结构化 ENV 失败） */
function buildDefaultVerifier(adapterOptions?: TestAgentAdapterOptions, log?: (line: string) => void): TestVerifier {
    return (r) => runTestAgentVerify({
        projectId: r.projectId, taskId: r.taskId, runId: r.runId,
        correlationId: r.correlationId, acceptanceHash: r.acceptanceHash,
        projectDir: r.projectDir, acceptanceChecks: r.checks,
    }, { ...(adapterOptions ?? {}), ...(log ? { log } : {}) });
}

// ============================================================
// TestEngineer —— test-core（消息驱动，无 LLM：判定权在独立 TestAgent，本类只搬运+核验+发报）
// ============================================================

/** 身份五字段（与 testAgentAdapter 的 IDENTITY_FIELDS 同口径）——回包核对用 */
const IDENTITY_FIELDS = ["projectId", "taskId", "runId", "correlationId", "acceptanceHash"] as const;

export class TestEngineer extends BaseAgent {
    private readonly deps: TestEngineerDeps;
    private readonly developerName: string;
    private readonly now: () => number;
    /** 已处理过的轮票（correlationId|acceptanceHash|deadlineAt）→ 幂等去重 */
    private readonly seen = new Set<string>();
    /**
     * 召唤工位（层 B）：本工位**拥有**的产物 = 判据的语义澄清。
     *   键 = `${taskId}:${checkId}`（判据 id 是全局判据空间里的名字，带上 taskId 更保险）。
     *   记录之后：① 进 ownContext（下一次召唤就能看到）；② 随 test_request 的处理日志留痕。
     *   ★ 它**不会**改变判据本身（改判据=改考试题）：澄清是给司机看的实现口径，
     *     判据原文仍然是 developer 侧算 acceptanceHash 的那一份——两边不同源必然被拒。
     */
    private readonly criterionClarifications = new Map<string, { detail: string; at: number }>();
    /** 最近一轮送检的票面（ownContext 的事实来源之一） */
    private lastRound: { projectId: string; taskId: string; correlationId: string; acceptanceHash: string; deadlineAt: number } | null = null;

    /**
     * @param name 注册名——必须是 "test-core"（信任链约定，见 TEST_CORE_NAME）
     * @param _nodes 旧线「测试判定」prompt 节点参数；新线判定权在独立 TestAgent，仅保构造签名兼容
     * @param deps   注入面（verifier/判据来源/时钟/留痕回调），主线与测试都从这里进来
     */
    constructor(name: string, station: TransferStation, _nodes: Node[] = [], deps: TestEngineerDeps = {}) {
        super(name, roles.testEngineer, station);
        this.deps = deps;
        this.developerName = deps.developerName ?? DEVELOPER_NAME;
        this.now = deps.now ?? Date.now;
        this.on("test_request", { fromNames: [this.developerName] }, (ctx) => this.handleTestRequest(ctx.data));
        // 召唤工位（9/17 层 B）：司机中途把问题送进来。
        //   ★ 不按 fromNames 过滤：发错人的请求也要拿到一条**明确拒绝**的回复
        //     （投递闸在 handleConsultRequest 里），静默躺在收件箱里是最坏的形状。
        this.on("consult_request", ({ data }) => this.answerConsult(data as unknown as ConsultRequest));
    }

    /**
     * 召唤应答（层 B）：ownContext = 本工位真实持有的判据/轮票/澄清；
     * amend = 只有 criterion_clarification 一种（AMENDMENT_ISSUERS 里 test-core 的职权）。
     */
    private async answerConsult(req: ConsultRequest): Promise<void> {
        const reply = await handleConsultRequest(req, this.buildConsultContext(req));
        this.send(CONSULT_DRIVER, reply as unknown as Record<string, unknown>);
        this.log(`应答召唤 ${reply.consultId}（confidence=${reply.confidence}`
            + `${reply.refused ? "，已拒绝" : ""}${reply.amendment ? `，已签发 ${reply.amendment.kind}` : ""}）`);
    }

    private buildConsultContext(req: ConsultRequest): ConsultContext {
        return {
            role: "test-core",
            // 本工位按**最近一轮送检票**认身份：没送过检就是"不持该维度"（空串），
            // 不构成拒绝理由——但那时的回答也必然只能说"我还没收到任何送检"。
            projectId: this.lastRound?.projectId ?? "",
            taskId: this.lastRound?.taskId ?? "",
            // 判据清单按**本次召唤点名的那件任务**去读（召唤里带了 taskId 就够读）；
            // 没有送检记录也不妨碍"我能报出这个任务的判据 id"——事实就是事实。
            ownContext: async () => this.renderOwnContext({
                projectId: this.lastRound?.projectId
                    || (typeof req?.projectId === "string" ? req.projectId : ""),
                taskId: this.lastRound?.taskId
                    || (typeof req?.taskId === "string" ? req.taskId : ""),
            }),
            ...(this.deps.consultLlm ? { llm: this.deps.consultLlm } : {}),
            amend: async (a) => {
                if (a.kind !== "criterion_clarification") return false;   // 越权 kind 一律退回（不改任何状态）
                const checkId = typeof a.payload?.["checkId"] === "string" ? String(a.payload["checkId"]) : "";
                const key = `${this.lastRound?.taskId || (typeof req?.taskId === "string" ? req.taskId : "") || "任务未知"}:${checkId || "(未指名判据)"}`;
                this.criterionClarifications.set(key, { detail: a.detail, at: this.now() });
                this.log(`已记录判据澄清 ${key}：${a.detail.slice(0, 200)}`);
                return true;
            },
        };
    }

    /** 本工位持有的事实（判据 id / 送检票 / 已澄清项），没有任何推测与判定 */
    private async renderOwnContext(scope: { projectId: string; taskId: string }): Promise<string> {
        const round = this.lastRound;
        let checks: string;
        if (!this.deps.taskChecks) {
            checks = "（未注入 deps.taskChecks：本工位看不到判据清单）";
        } else if (!scope.taskId) {
            checks = "（不知道要读哪个任务的判据：召唤里没带 taskId，本进程也还没收到送检）";
        } else {
            try {
                const list = await this.deps.taskChecks({
                    type: "test_request", projectId: scope.projectId, taskId: scope.taskId,
                    correlationId: round?.correlationId ?? "", acceptanceHash: round?.acceptanceHash ?? "",
                    deadlineAt: round?.deadlineAt ?? 0, targets: [], reason: "",
                });
                checks = list
                    ? list.map((c) => String((c as { id?: unknown })?.id ?? "?")).join("、") || "（判据数组为空）"
                    : "（taskChecks 返回 null：本任务没有可读的判据清单）";
            } catch (e) {
                checks = `（读判据失败：${(e as Error).message}）`;
            }
        }
        const clar = [...this.criterionClarifications.entries()];
        return [
            "# 测试工位当前持有的事实",
            `- 最近一轮送检票：${round ? `${round.projectId}/${round.taskId} corr=${round.correlationId} hash=${round.acceptanceHash} deadlineAt=${round.deadlineAt}` : "（本次进程内还没有收到任何 test_request）"}`,
            `- 已处理轮票数：${this.seen.size}`,
            `- ${scope.taskId ? `任务 ${scope.taskId} 的` : "本任务"}判据 id：${checks}`,
            `- 已记录的判据澄清（${clar.length}）：${clar.map(([k, v]) => `${k} → ${v.detail}`).join("；") || "（无）"}`,
            "- 不持有的信息：任何**通过/不通过**结论（判定权在独立 TestAgent 的机器证据）；",
            "- 也不持有：生成项目的代码（司机）、计划与批次（架构师）、需求原文（PM）。",
        ].join("\n");
    }

    private log(line: string): void {
        const text = `[${this.name}] ${line}`;
        if (this.deps.log) this.deps.log(text); else console.log(text);
    }

    // ---------- 入站：test_request ----------

    /** 收口所有闸后的一轮验收。永不抛：闸不过 = 留痕不发，verifier 出错 = 留痕不发。 */
    private async handleTestRequest(raw: Record<string, any>): Promise<void> {
        const req = this.parseRequest(raw);
        if (!req) return;
        // 层 B：记下本轮机票，ownContext（被召唤时的事实来源）读它——不记的话，
        // 被召唤时只能说"我不记得有送检"，而那句话对司机毫无用处。
        this.lastRound = {
            projectId: req.projectId, taskId: req.taskId, correlationId: req.correlationId,
            acceptanceHash: req.acceptanceHash, deadlineAt: req.deadlineAt,
        };
        // 层 B：已签发过的判据澄清随本轮送检一起留痕（它是**实现口径**，不是判据本身——
        // 判据原文仍以 developer 侧算 acceptanceHash 的那一份为准，改它必然不同源）
        const clar = [...this.criterionClarifications.entries()];
        if (clar.length > 0) {
            this.log(`本轮生效的判据澄清 ${clar.length} 条（来自司机召唤）：${clar.map(([k]) => k).join("、")}`);
        }
        this.log(`收到 test_request：${req.projectId}/${req.taskId} corr=${req.correlationId.slice(0, 12)}… hash=${req.acceptanceHash.slice(0, 8)}…（reason: ${req.reason.slice(0, 80) || "未给"}）`);

        // 幂等：同轮票只处理一次（Hub 重投/双发不重复烧 verify、不重复发结果）
        const ticket = `${req.correlationId}|${req.acceptanceHash}|${req.deadlineAt}`;
        if (this.seen.has(ticket)) {
            this.log(`重复 test_request（corr=${req.correlationId.slice(0, 12)}…）→ 幂等忽略，不重验不重发`);
            return;
        }
        this.seen.add(ticket);

        // 闸①（到达即超窗）：连 verify 都不烧——结果到 developer 手上也只剩一个「拒」字
        if (this.now() > req.deadlineAt) {
            this.log(`⛔ test_request 到达即超窗（now=${this.now()} > deadlineAt=${req.deadlineAt}）→ 主动放弃，不送检`);
            return;
        }

        // 闸②（hash 同源自检）：本地从任务包算一遍，对不上 = 两边判据不是同一份，发了也白发
        if (this.deps.taskChecks) {
            let localHash: string | null = null;
            try {
                const taskChecks = await this.deps.taskChecks(req);
                if (taskChecks != null) localHash = acceptanceHashOf(taskChecks);
            } catch (e) {
                this.log(`⛔ 读取任务包判据失败：${(e as Error).message} → 判据不可信，拒发`);
                return;
            }
            if (localHash != null && localHash !== req.acceptanceHash) {
                this.log(`⛔ acceptanceHash 不符（本地任务包=${localHash}… ≠ 请求=${req.acceptanceHash}…）→ 判据不同源，拒发`);
                return;
            }
        } else {
            this.log("提示：未注入 deps.taskChecks，acceptanceHash 本地自检跳过（兜底只剩 developer 端信任链）");
        }

        // 组装轮请求（resolveChecks/projectDirOf 缺失 → 真实现会在适配器内大声抛，落下方 catch）
        let round: VerifyRoundRequest;
        try {
            round = {
                projectId: req.projectId, taskId: req.taskId,
                runId: this.deps.runIdOf ? this.deps.runIdOf(req) : req.taskId,
                correlationId: req.correlationId, acceptanceHash: req.acceptanceHash,
                deadlineAt: req.deadlineAt, targets: req.targets, reason: req.reason,
                projectDir: this.deps.projectDirOf ? this.deps.projectDirOf(req) : "",
                checks: this.deps.resolveChecks ? await this.deps.resolveChecks(req) : [],
            };
        } catch (e) {
            this.log(`⛔ 组装验收输入失败（大概率 resolveChecks/projectDirOf 未注入）：${(e as Error).message} → 不送检`);
            return;
        }

        // 执行面（注入缝）：默认真实现 = testAgentAdapter → 外部 testAgent --verify
        const verifier = this.deps.verifier ?? buildDefaultVerifier(this.deps.adapterOptions, (l) => this.log(l));
        let out: VerifyAdapterOutcome;
        try {
            out = await verifier(round);
        } catch (e) {
            this.log(`⛔ verifier 抛错：${(e as Error).message} → 本轮没有可信结果，不发（developer 端超窗止损自然收口）`);
            return;
        }

        // 闸③（回来才超窗）：主动放弃并留痕，别硬发
        if (this.now() > req.deadlineAt) {
            this.log(`⛔ 验收结果回来时已超窗（kind=${out.kind}，now=${this.now()} > deadlineAt=${req.deadlineAt}）→ 弃发留痕`);
            return;
        }

        switch (out.kind) {
            case "test_passed":
                this.deliver(out.message, req, round.runId);
                break;
            case "test_failure":
                this.deliver(out.message, req, round.runId);
                break;
            case "unverified":
                // 不伪装成失败也不伪装成通过：developer 端 blockUnverified 的语义归编排层落
                this.log(`⏸ ${out.result.skipped.length} 项判据未执行 → 不发结果，交编排层定 blocked_unverified`);
                this.notifyOrchestrator(out.kind, req, { skipped: out.result.skipped });
                break;
            case "needs_human":
                this.log(`🙋 需要人工确认（不是 developer 能修的代码问题）：${out.reasons.join("；").slice(0, 300)}`);
                this.notifyOrchestrator(out.kind, req, {
                    reasons: out.reasons,
                    reviewStatus: out.result.reviewStatus ?? "disabled",
                    reviewReason: out.result.reviewReason ?? null,
                    llmReview: out.result.llmReview ?? null,
                    reviewSignals: out.result.reviewSignals ?? [],
                    mechanicalVerdict: out.result.mechanicalVerdict ?? out.result.verdict,
                });
                break;
        }
    }

    /** 入站结构收口：test_request 的必填身份字段缺一律丢（correlationId 都没有时无从回话） */
    private parseRequest(raw: Record<string, any>): TestRequest | null {
        const s = (v: unknown): string => (typeof v === "string" ? v : "");
        const missing: string[] = [];
        const projectId = s(raw.projectId); if (!projectId) missing.push("projectId");
        const taskId = s(raw.taskId); if (!taskId) missing.push("taskId");
        const correlationId = s(raw.correlationId); if (!correlationId) missing.push("correlationId");
        const acceptanceHash = s(raw.acceptanceHash); if (!acceptanceHash) missing.push("acceptanceHash");
        const deadlineAt = typeof raw.deadlineAt === "number" && Number.isFinite(raw.deadlineAt) ? raw.deadlineAt as number : NaN;
        if (!Number.isFinite(deadlineAt)) missing.push("deadlineAt");
        if (missing.length > 0) {
            this.log(`⛔ 入站 test_request 必填字段缺失（${missing.join("、")}）→ 丢弃（无从回话，developer 端超窗止损自然收口）`);
            return null;
        }
        return {
            type: "test_request", projectId, taskId, correlationId, acceptanceHash, deadlineAt,
            targets: Array.isArray(raw.targets) ? (raw.targets as unknown[]).map(String) : [],
            reason: s(raw.reason),
        };
    }

    // ---------- 出站：test_passed / test_failure ----------

    /** 闸①的发送侧半段（回错包核对）+ 形状核对（逐字过 developer 的 schema），全过才发 */
    private deliver(message: TestPassed | TestFailure, req: TestRequest, runId: string): void {
        const want: Record<(typeof IDENTITY_FIELDS)[number], string> = {
            projectId: req.projectId, taskId: req.taskId, runId,
            correlationId: req.correlationId, acceptanceHash: req.acceptanceHash,
        };
        const mismatches = IDENTITY_FIELDS.filter((f) => (message[f] as string) !== want[f]);
        if (mismatches.length > 0) {
            this.log(`⛔ verifier 回错包：${mismatches.map((f) => `${f}(${String(message[f])}≠${want[f]})`).join("；")} → 拒发`);
            return;
        }
        // verifiedBy 改成本机注册名：developer 信任链按 Hub sender 实名核（["test-core"]），
        // 消息里再自报一个别的名字只会误导审计。
        const payload: TestPassed | TestFailure =
            message.type === "test_passed" ? { ...message, verifiedBy: this.name } : message;
        const schema = payload.type === "test_passed" ? TestPassedSchema : TestFailureSchema;
        const parsed = schema.safeParse(payload);
        if (!parsed.success) {
            const why = parsed.error.issues.map((i) => `${i.path.join(".") || "$"}: ${i.message}`).join("; ");
            this.log(`⛔ ${payload.type} 不过 developer 契约 schema → 拒发：${why.slice(0, 300)}`);
            return;
        }
        this.send(this.developerName, payload as Record<string, any>);
        const extra = payload.type === "test_passed"
            ? `机器证据 ${(payload as TestPassed).evidence.length} 项`
            : `${payload.category} exit=${String((payload as TestFailure).exitCode)} 红单 ${(payload as TestFailure).allFailures?.length ?? 0} 条`;
        this.log(`→ ${this.developerName} ${payload.type}（corr=${req.correlationId.slice(0, 12)}…，${extra}）`);
    }

    /** 非结果类结局的通知位（v2_verdict 形状与 hub-runner stationLoop 同款，归编排层消费） */
    private notifyOrchestrator(kind: "unverified" | "needs_human", req: TestRequest, detail: Record<string, any>): void {
        const orch = this.deps.orchestrator;
        if (!orch) {
            this.log(`（未注入 deps.orchestrator，${kind} 通知仅本机留痕）`);
            return;
        }
        this.send(orch, { type: "v2_verdict", kind, correlationId: req.correlationId, ...detail });
        this.log(`v2_verdict(${kind}) → ${orch}`);
    }
}

// ============================================================
// 【旧线遗留导出】—— T6 机械三查/纸审时代的纯函数与类型。
//   新线（test-core）不引用；render-smoke.ts / role-prompt-smoke.ts 还在 import，
//   lane D 拆 merger↔测试旧线时连同这两个 smoke 一并移除。在此之前保持逐字不变。
// ============================================================

/** 旧线判定结论（归责制） */
export interface Verdict {
    pass: boolean;
    blame: "backend" | "frontend" | "both";
    backendIssues: string[];
    frontendIssues: string[];
}

/** 旧线清单条目（LLM 纸审六项 + 机器三项同构合并） */
export interface CheckItem {
    item: string;
    verdict: "pass" | "fail" | "skip";
    evidence: string;
}

/** 旧线 LLM 必须逐项交代的六件事 */
export const CHECKLIST_ITEMS = ["路由指向存在", "import 可解析", "三态覆盖", "契约遵从", "接口联通", "验收落实"] as const;

/** 旧线纸审提示词（role-prompt-smoke 引用） */
export const test_prompt: string = `
# 角色
你是 CrewForge 项目的测试-清单判定 Agent。你只通过阅读任务契约和代码判断实现是否满足要求，不执行代码，也不替开发者做设计。

## 输入
1. 后端任务（method/path/入参/返回/验收标准）+ 后端产出代码
2. 前端任务（页面/交互/调用的接口/验收标准）+ 前端产出代码
3. 项目契约（文件归属/路由登记/视觉 token）+ 机器证据（编译/色值/渲染已由机械完成并通过）

## 六项硬清单（逐项给 verdict，不许合并、不许省略；evidence 必须引用文件与具体行为）
1. 路由指向存在——router 的每个 component 路径可在 files/契约页面清单里对上真实文件。
2. import 可解析——本地 import 的目标文件存在且导出对应名字（跨任务引用的组件/工具不悬空）。
3. 三态覆盖——页面至少具备空态与错误态处理（loading 加分不强制；只有"一把梭渲染"=fail）。
4. 契约遵从——文件归属/路由登记/共享模块复用符合契约：没重写别人的 router/main/request，没重复造轮子，颜色走 --td-* 变量。
5. 接口联通——前端调用的 method/path/请求字段/响应字段与后端一字不差（字段改名、漏包 code/data 都算 fail）。
6. 验收落实——后端与前端 acceptance 逐条对证；给不出证据的条目按 fail 报。

## 与机器证据的关系
编译级错误、硬编码色超限、渲染白屏已由机械预检处理（到你手里说明机器全绿）。
你不得用纸审推翻机器结论；但你看到机器查不到的问题（逻辑矛盾/契约违背/字段错位），必须判 fail——宁可错杀一次返工，不可放过一个假通过。

## 输出
只输出合法 JSON，不要 Markdown、解释或额外字段：
{
  "pass": true/false,
  "blame": "backend"|"frontend"|"both",
  "backendIssues": ["具体问题：位置+期望+实际"],
  "frontendIssues": ["具体问题：位置+期望+实际"],
  "checks": [ { "item": "六项之一（原样复制）", "verdict": "pass|fail|skip", "evidence": "引用性证据" } ]
}

## 归责
- 谁错了归谁：只后端问题→"backend"；只前端→"frontend"；两边→"both"；匹配问题归出错侧。
- blame 与 issues 自洽："backend" 则 backendIssues 非空且 frontendIssues 空；"both" 两边非空。
- pass=true 时 issues 留空数组、blame 填 "backend" 占位、checks 六项全 pass。
- pass=false 时每条 issue 写清位置/期望/实际，具体到开发 Agent 可直接修改。
`;

/** 契约铁律「硬编码色 ≤5」机械化：数 .vue/.css 里的 hex 色值（td-theme.css 是 token 本体，豁免） */
export function scanHardcodedHex(files: { filePath: string; content: string }[]): CheckItem {
    let count = 0;
    const where = new Set<string>();
    for (const f of files) {
        if (!/\.(vue|css|scss)$/i.test(f.filePath)) continue;
        if (/td-theme\.css$/i.test(f.filePath)) continue;
        for (const line of f.content.split(/\r?\n/)) {
            if (line.includes("--td-")) continue;   // 变量定义/引用行不算硬编码
            const hits = line.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g);
            if (hits) { count += hits.length; where.add(f.filePath); }
        }
    }
    const evidence = count > 5
        ? `发现 ${count} 处硬编码色值（上限 5）：${[...where].join("、")}`
        : `硬编码色值 ${count} 处（≤5 合规）`;
    return { item: "机械-硬编码色扫描", verdict: count > 5 ? "fail" : "pass", evidence };
}

/** 清单一致性强制（代码兜底非 prompt 祈祷）：checks 有 fail 而 pass=true → 改判；六项缺位机器补记 */
export function enforceChecklistConsistency(verdict: Verdict, llmChecks: CheckItem[]): { verdict: Verdict; checks: CheckItem[] } {
    const merged = [...llmChecks];
    for (const name of CHECKLIST_ITEMS) {
        if (!merged.some(c => c.item === name)) {
            merged.push({ item: name, verdict: "skip", evidence: "模型未输出该项（T6 清单强制补记）" });
        }
    }
    const out = { ...verdict };
    if (!verdict.pass) return { verdict: out, checks: merged };
    const failed = merged.filter(c => c.verdict === "fail");
    if (failed.length > 0) {
        const issue = `清单存在 fail 项但模型报 pass（机器改判）：${failed.map(f => `${f.item}——${f.evidence.slice(0, 100)}`).join("；")}`;
        out.pass = false;
        // fail 项没给归责侧的，两边都打回——宁可多返工一轮，不放过假通过
        out.blame = "both";
        out.backendIssues = [...verdict.backendIssues, issue];
        out.frontendIssues = [...verdict.frontendIssues, issue];
    }
    return { verdict: out, checks: merged };
}

/** 旧线测试报告 md（留档 runs/pN/_test-report/） */
export function renderTestReport(label: string, phase: number, verdict: Verdict, checks: CheckItem[], mech: CheckItem[]): string {
    const all = [...mech, ...checks];
    return [
        `# 测试报告 ${label}（阶段 ${phase}）`,
        `- 结论：${verdict.pass ? "通过" : "未通过"}｜归责：${verdict.blame}`,
        ...verdict.backendIssues.map(i => `- 后端：${i}`),
        ...verdict.frontendIssues.map(i => `- 前端：${i}`),
        "",
        "## 清单逐项",
        ...all.map(c => `- [${c.verdict === "pass" ? "x" : c.verdict === "fail" ? " " : "~"}] ${c.item}：${c.evidence}`),
        "",
    ].join("\n");
}
