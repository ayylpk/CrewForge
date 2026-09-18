// ============================================================
// testAgentAdapter.ts —— Developer ↔ F:\code\agent\testAgent --verify 的薄适配器
//
//   9/13 结构定稿（用户裁决）：
//     DeveloperAgent   = 唯一写盘（开发、自检、修复）；
//     testAgent --verify = 只读独立验收（零 LLM、不写目标项目、不猜命令）；
//     testAgent --auto   = 桌面端本地自修复工具，**不进服务端裁判链**；
//     本适配器 = 中间那段接线：序列化请求 → spawn → 读回单 JSON →
//     五字段身份核对 → 转换成 test_passed / test_failure。
//
//   三条铁律（代码保证，不靠自觉）：
//     ① 绝不伪造通过：test_passed 只在 verify 亲口 verdict=pass、
//        且适配器独立复核「证据全部 exitCode=0、skipped 为空、条数对得上」之后才发；
//        任何一环不满足就降级成结构化失败。
//     ② 崩溃/解析失败/身份不符 → 一律发 ENV 类 test_failure（带真实 stderr 与退出码），
//        绝不静默、绝不替 Developer 判"通过"，也绝不把没执行的判据算成跑过。
//     ③ blocked_unverified 不伪装成失败也不伪装成通过：原样回传给调用方，
//        由调用方（hub-runner）走 handle.blockUnverified 落诚实终态。
//
//   验收规则本身不经过任何 LLM——acceptanceChecks 是**显式命令**，谁生成谁负责；
//   本层只搬运与核验，不发明判据。
// ============================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashOf } from "./developerAgent/ledger";
import {
    REVIEW_CATEGORIES,
    type AdditionalFailure, type MechanicalEvidence, type ReviewFinding,
    type TestFailure, type TestFailureCategory, type TestPassed, type VerificationEvidence,
} from "./developerAgent/protocol";

/** verify 身份在 Developer 受信名单里的名字（hub-runner 注册工位与 trustedTestAgents 必须用同一个） */
export const VERIFY_AGENT_NAME = "testagent-verify";

// ---------- 与 testAgent/src/verify.ts 对齐的契约镜像（跨仓不 import，字段逐一对应） ----------

export interface AdapterVerifyCheck {
    id: string;
    category?: string;
    command?: string;
    args?: string[];
    cwd?: string;
    timeoutMs?: number;
    affectedFiles?: string[];
}

export interface AdapterVerifyRequest {
    projectId: string;
    taskId: string;
    runId: string;
    correlationId: string;
    acceptanceHash: string;
    projectDir: string;
    acceptanceChecks: AdapterVerifyCheck[];
    /** 任务包/契约里已知的验收固定值：源码里出现即"抄答案当种子"。只加怀疑，不放行 */
    acceptanceLiterals?: string[];
    /** 契约是否要求持久化存储（缺省 true） */
    requiresPersistence?: boolean;
}

export interface AdapterVerifyEvidence {
    checkId: string;
    category: string;
    command: string;
    args: string[];
    cwd: string;
    exitCode: number | null;
    startedAt: number;
    finishedAt: number;
    durationMs: number;
    timedOut: boolean;
    stdout: string;
    stderr: string;
}

export interface AdapterVerifyResult {
    verdict: "pass" | "fail" | "blocked_unverified" | "error";
    projectId: string;
    taskId: string;
    runId: string;
    correlationId: string;
    acceptanceHash: string;
    evidence: AdapterVerifyEvidence[];
    skipped: { checkId: string; reason: string }[];
    failure: AdapterVerifyEvidence | null;
    allFailures?: AdapterVerifyEvidence[];
    error?: string;
    // ---------- 语义审查（第二段）；旧版 verify 不带这些字段，全部可选 ----------
    mechanicalVerdict?: "pass" | "fail" | "blocked_unverified" | "error";
    /** 最终结论：只有它等于 pass 才可能产出 test_passed */
    outcome?: "pass" | "fail" | "uncertain" | "llm_unavailable" | "blocked_unverified" | "error";
    outcomeReason?: string;
    llmReview?: AdapterLlmReview | null;
    reviewSignals?: AdapterReviewFinding[];
    blockingFindings?: AdapterReviewFinding[];
    reviewStatus?: "ok" | "LLM_REVIEW_UNAVAILABLE" | "disabled";
    reviewReason?: string | null;
    reviewAudit?: AdapterReviewAudit | null;
}

export interface AdapterReviewFinding {
    severity: "critical" | "major" | "minor";
    category: string;
    title: string;
    evidence: string[];
    recommendation: string;
}

export interface AdapterLlmReview {
    reviewVerdict: "pass" | "fail" | "uncertain";
    findings: AdapterReviewFinding[];
    confidence: "high" | "medium" | "low";
}

export interface AdapterReviewAudit {
    model: string;
    promptHash: string;
    evidenceHash: string;
    durationMs: number;
    tokenUsage: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
}

// ---------- 适配器选项与结果 ----------

export interface TestAgentAdapterOptions {
    /** testAgent 仓库位置。默认 env TESTAGENT_DIR，再缺省本机路径 */
    testAgentDir?: string;
    bunPath?: string;
    /** 看门狗总超时；默认 = Σ check.timeoutMs(缺省 600s) + 120s 余量 */
    timeoutMs?: number;
    /** 临时 request.json 的落盘目录，默认 os.tmpdir() */
    tmpDir?: string;
    /** spawn env；默认继承 process.env */
    env?: Record<string, string | undefined>;
    /**
     * 语义审查开关：默认 "on"（真实链必须过语义闸）。
     * "off" 会加 --no-llm-review —— 只跑机械段，此时**永远不会**产出 test_passed，
     * 只会落成 needs_human。所以它不能当"放行开关"用。
     */
    reviewMode?: "on" | "off";
    /** 审查模型看门狗；默认透传给 testAgent（其默认 120s） */
    reviewTimeoutMs?: number;
    log?: (line: string) => void;
}

export type VerifyAdapterOutcome =
    | { kind: "test_passed"; message: TestPassed; result: AdapterVerifyResult }
    | { kind: "test_failure"; message: TestFailure; result: AdapterVerifyResult | null; reasons: string[] }
    | { kind: "unverified"; result: AdapterVerifyResult }
    /** 需要人工确认：审查不可用 / 审查不确定。既不是通过，也不是给 Developer 修的代码问题 */
    | { kind: "needs_human"; reasons: string[]; result: AdapterVerifyResult };

/**
 * 审查审计 → Ledger 事件载荷（要求 19）。
 *
 *   抽成纯函数是为了**可验证**：装配器（live/hub-runner）只负责把它丢进 Ledger，
 *   而"审计字段到底齐全没有"这件事必须能被零 LLM 单测钉住——否则"落 Ledger"就只是句口号。
 *   findings 全量带上（预扫与模型各自标 origin），阻断项单独列一份便于事后检索。
 */
export function buildReviewLedgerPayload(
    r: AdapterVerifyResult,
    ids: { correlationId: string; taskId: string },
): Record<string, unknown> {
    return {
        correlationId: ids.correlationId,
        taskId: ids.taskId,
        reviewStatus: r.reviewStatus ?? "disabled",
        reviewReason: r.reviewReason ?? null,
        model: r.reviewAudit?.model ?? null,
        promptHash: r.reviewAudit?.promptHash ?? null,
        evidenceHash: r.reviewAudit?.evidenceHash ?? null,
        durationMs: r.reviewAudit?.durationMs ?? null,
        tokenUsage: r.reviewAudit?.tokenUsage ?? null,
        findingCount: (r.llmReview?.findings.length ?? 0) + (r.reviewSignals?.length ?? 0),
        findings: [
            ...(r.reviewSignals ?? []).map((f) => ({ ...f, origin: "prescan" })),
            ...(r.llmReview?.findings ?? []).map((f) => ({ ...f, origin: "llm" })),
        ],
        blocking: collectBlockingFindings(r).map((f) => `${f.severity}/${f.category} ${f.title}`),
        outcome: r.outcome ?? null,
        mechanicalVerdict: r.mechanicalVerdict ?? r.verdict,
    };
}

/** 把这些严重度视为阻断项 */
export const BLOCKING_SEVERITIES: readonly string[] = ["critical", "major"];

/** 机械化证据摘要（与 allFailures 同源；显式标注"这段是机器产物，不是模型编的"） */
function mechEvidenceOf(e: AdapterVerifyEvidence): MechanicalEvidence {
    return {
        checkId: e.checkId,
        category: (CATEGORIES.includes(e.category) ? e.category : "ENV") as TestFailureCategory,
        command: e.command, args: e.args, cwd: e.cwd, exitCode: e.exitCode,
        timedOut: e.timedOut === true,
        startedAt: e.startedAt, finishedAt: e.finishedAt, durationMs: e.durationMs,
        stdout: cap(e.stdout), stderr: cap(e.stderr),
        failureSignature: hashOf({ checkId: e.checkId, exit: e.exitCode, timedOut: e.timedOut === true }),
    };
}

function clipFinding(f: AdapterReviewFinding): ReviewFinding {
    return {
        severity: f.severity,
        category: ((REVIEW_CATEGORIES as readonly string[]).includes(f.category) ? f.category : "OTHER") as ReviewFinding["category"],
        title: f.title,
        evidence: (f.evidence ?? []).map((e) => cap(String(e))),
        recommendation: f.recommendation,
    };
}

/** 把审查发现渲染成 Developer 能直读的文本（全量，不截成一条） */
export function renderFindings(findings: ReviewFinding[]): string {
    if (findings.length === 0) return "（无）";
    return findings.map((f, i) =>
        `#${i + 1} [${f.severity}/${f.category}] ${f.title}\n`
        + `   证据：${f.evidence.length > 0 ? f.evidence.join("  |  ") : "（未给证据）"}\n`
        + `   建议：${f.recommendation}`,
    ).join("\n");
}

/**
 * 三件套一起下发：**机械证据** + **全部失败**（allFailures 在调用处填）+ **LLM 审查**。
 * 缺任何一件，Developer 就只能在信息不全的情况下瞎修。
 */
function reviewAttachments(result: AdapterVerifyResult) {
    const signals = (result.reviewSignals ?? []).map(clipFinding);
    const llmFindings = (result.llmReview?.findings ?? []).map(clipFinding);
    return {
        mechanicalEvidence: result.evidence.map(mechEvidenceOf),
        llmReview: result.llmReview
            ? {
                reviewVerdict: result.llmReview.reviewVerdict,
                findings: llmFindings,
                confidence: result.llmReview.confidence,
            }
            : null,
        reviewSignals: signals,
        reviewStatus: result.reviewStatus ?? ("disabled" as const),
        reviewReason: result.reviewReason ?? null,
        reviewAudit: result.reviewAudit ?? null,
        blockingFindingTitles: collectBlockingFindings(result).map((f) => `${f.severity}/${f.category} ${f.title}`),
    };
}

/**
 * 语义闸：机械绿之后还要过这一关。返回非空 = 不能发 test_passed，且不该当失败去修。
 *   规则与 verify 侧 decideReview 同源，这里是**独立复核**——不轻信 verify 自报的 outcome。
 *   参数收结构化子集而不是整个 AdapterVerifyResult：这样它也能被单测直接喂数据。
 */
export function semanticGateReasons(result: {
    reviewStatus?: "ok" | "LLM_REVIEW_UNAVAILABLE" | "disabled";
    reviewReason?: string | null;
    llmReview?: AdapterLlmReview | null;
    reviewSignals?: AdapterReviewFinding[];
    blockingFindings?: AdapterReviewFinding[];
    outcome?: string;
    outcomeReason?: string;
}): string[] {
    const out: string[] = [];
    const status = result.reviewStatus ?? "disabled";
    const review = result.llmReview ?? null;
    const blocking = collectBlockingFindings(result);
    if (blocking.length > 0) out.push(`存在 ${blocking.length} 条阻断性发现（critical/major）`);
    if (status === "disabled") out.push("语义审查未启用——没有审查就不算通过");
    else if (status === "LLM_REVIEW_UNAVAILABLE") out.push(`语义审查不可用：${result.reviewReason ?? "未给原因"}`);
    else if (!review) out.push("reviewStatus=ok 却没带 llmReview——输出自相矛盾，不可信");
    else {
        if (review.reviewVerdict !== "pass") out.push(`审查结论为 ${review.reviewVerdict}，不是 pass`);
        if (review.confidence === "low") out.push("审查置信度 low，证据不足");
    }
    if (typeof result.outcome === "string" && result.outcome !== "pass") {
        out.push(`verify 自报 outcome=${result.outcome}（${result.outcomeReason ?? "未给原因"}）`);
    }
    return out;
}

/** 收集阻断性发现（预扫 + 模型），去重后返回 */
export function collectBlockingFindings(result: {
    reviewSignals?: AdapterReviewFinding[];
    blockingFindings?: AdapterReviewFinding[];
    llmReview?: AdapterLlmReview | null;
}): AdapterReviewFinding[] {
    const all = [
        ...(result.blockingFindings ?? []),
        ...(result.reviewSignals ?? []),
        ...(result.llmReview?.findings ?? []),
    ];
    const seen = new Set<string>();
    const out: AdapterReviewFinding[] = [];
    for (const f of all) {
        if (!f || !BLOCKING_SEVERITIES.includes(f.severity)) continue;
        const key = `${f.severity}|${f.category}|${f.title}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(f);
    }
    return out;
}

/**
 * 语义失败转成的 test_failure。
 *   注意两处刻意设计：
 *     · `origin: "llm_review"` —— 告诉 Developer 这不是命令退出码，别去重跑那条"命令"；
 *     · `failureSignature` 只由 findings（severity/category/title）算 —— 同一批发现
 *       重复出现会被引擎的重复失败闸认出，不会无限烧修复预算。
 */
function reviewFailureMessage(
    req: AdapterVerifyRequest,
    result: AdapterVerifyResult,
    attachments: ReturnType<typeof reviewAttachments>,
    blocking: AdapterReviewFinding[],
): TestFailure {
    const top = blocking[0]!;
    const signature = hashOf({ review: true, items: blocking.map((f) => `${f.severity}|${f.category}|${f.title}`) });
    const all = [...(result.reviewSignals ?? []), ...(result.llmReview?.findings ?? [])].map(clipFinding);
    return {
        type: "test_failure",
        messageId: `msg-${hashOf({ c: req.correlationId, r: signature, t: Date.now() })}`,
        correlationId: req.correlationId,
        runId: req.runId,
        acceptanceHash: req.acceptanceHash,
        projectId: req.projectId,
        taskId: req.taskId,
        category: (CATEGORIES.includes(top.category) ? top.category : "CONTRACT") as TestFailureCategory,
        origin: "llm_review",
        command: "(semantic-review)",
        args: [],
        cwd: ".",
        exitCode: 1,
        stdout: cap(renderFindings(all)),
        stderr: cap(
            "机械验收全部通过（exitCode 均为 0），但语义审查判定不通过。\n"
            + "这不是某条命令的退出码——请按下面的发现改代码，然后重跑 mechanicalEvidence 里的验收命令。\n"
            + `阻断项：\n${blocking.map((f) => `- [${f.severity}/${f.category}] ${f.title}`).join("\n")}`,
        ),
        affectedFiles: [],
        failureSignature: signature,
        allFailures: [],
        needsHuman: false,
        ...attachments,
    };
}

const IDENTITY_FIELDS = ["projectId", "taskId", "runId", "correlationId", "acceptanceHash"] as const;
const CATEGORIES: readonly string[] = ["COMPILE", "BOOT", "MIGRATION", "CONTRACT", "RENDER", "ENV"];
const OUT_CAP = 64_000;
const DEFAULT_CHECK_TIMEOUT_MS = 600_000;

function cap(s: string): string {
    return s.length > OUT_CAP ? `${s.slice(0, OUT_CAP)}\n…[适配器截断，原长 ${s.length}]` : s;
}

/** 与 live/verifier.ts failureSignatureOf 同一行过滤规则：跨轮/跨来源签名可互相识别 */
function signatureOf(f: { checkId: string; exitCode: number | null; stdout: string; stderr: string }): string {
    const err = `${f.stderr}\n${f.stdout}`
        .split(/\r?\n/)
        .filter((l) => /error|fail|cannot|未找|错误/i.test(l))
        .slice(0, 8)
        .join("\n");
    return hashOf({ checkId: f.checkId, exit: f.exitCode, err });
}

/** 主入口：跑一轮独立验收并把结果转换成 Developer 协议消息。永不抛异常（结构化失败兜底）。 */
export async function runTestAgentVerify(
    req: AdapterVerifyRequest,
    opts: TestAgentAdapterOptions = {},
): Promise<VerifyAdapterOutcome> {
    const log = opts.log ?? (() => { /* 默认静音，调用方给 log 才有输出 */ });
    const miss = IDENTITY_FIELDS.filter((f) => !String(req[f] ?? "").trim());
    if (miss.length > 0 || !req.projectDir || req.acceptanceChecks.length === 0) {
        // 这是调用方（装配层）的编程错误，发不出可信消息——大声抛，别让坏请求进链
        throw new Error(`testAgentAdapter：请求本身不完整（缺 ${[...miss, ...(req.acceptanceChecks.length ? [] : ["acceptanceChecks"])].join("、")}）——装配层问题，不派发`);
    }

    // ★ 9/18：testAgent 已从仓外（F:/code/agent/testAgent）**搬进本仓** `testAgent/`。
    //   优先级：显式 opts > 环境变量 > 仓库内默认位置——默认值改成相对本仓解析，
    //   这样 clone 下来就自带裁判（不再依赖某台机器上的绝对路径）。
    const testAgentDir = opts.testAgentDir ?? process.env.TESTAGENT_DIR
        ?? path.resolve(import.meta.dir, "..", "testAgent");
    const bunPath = opts.bunPath ?? "bun";
    const indexTs = path.join(testAgentDir, "index.ts");
    // 看门狗要盖住两段：机械命令的总时长 + 语义审查（默认最多 180s）
    const reviewBudgetMs = opts.reviewMode === "off" ? 0 : (opts.reviewTimeoutMs ?? 180_000);
    const totalMs = opts.timeoutMs
        ?? req.acceptanceChecks.reduce((s, c) => s + (Number(c.timeoutMs) || DEFAULT_CHECK_TIMEOUT_MS), 0) + 120_000 + reviewBudgetMs;

    const envFailure = (reasons: string[], exitCode: number | null, stdout = "", stderr = ""): VerifyAdapterOutcome => ({
        kind: "test_failure",
        reasons,
        result: null,
        message: {
            type: "test_failure",
            messageId: `msg-${hashOf({ c: req.correlationId, r: reasons.join("|"), t: Date.now() })}`,
            correlationId: req.correlationId,
            runId: req.runId,
            acceptanceHash: req.acceptanceHash,
            projectId: req.projectId,
            taskId: req.taskId,
            category: "ENV" as TestFailureCategory,
            command: `${bunPath} run ${indexTs} --verify`,
            args: ["--input", "<request.json>"],
            cwd: testAgentDir,
            exitCode,
            stdout: cap(stdout),
            stderr: cap(stderr || reasons.join("\n")),
            affectedFiles: [],
            // 签名只用稳定信息（不含时间戳）——同一环境故障第 2 次出现会被引擎的重复失败闸拦住
            failureSignature: hashOf({ env: true, reasons: reasons.map((r) => r.slice(0, 200)) }),
        },
    });

    // 1) 请求落盘（临时 JSON，跑完即删）
    const tmpDir = opts.tmpDir ?? os.tmpdir();
    const reqFile = path.join(tmpDir, `verify-req-${String(req.correlationId).replace(/[^\w.-]/g, "_")}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.json`);
    let proc: ReturnType<typeof Bun.spawn> | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
        fs.mkdirSync(tmpDir, { recursive: true });
        fs.writeFileSync(reqFile, JSON.stringify({
            type: "test_request",
            projectId: req.projectId, taskId: req.taskId, runId: req.runId,
            correlationId: req.correlationId, acceptanceHash: req.acceptanceHash,
            projectDir: req.projectDir, acceptanceChecks: req.acceptanceChecks,
            // 只加"怀疑来源"，不参与放行判定
            ...(Array.isArray(req.acceptanceLiterals) && req.acceptanceLiterals.length > 0
                ? { acceptanceLiterals: req.acceptanceLiterals } : {}),
            ...(req.requiresPersistence !== undefined ? { requiresPersistence: req.requiresPersistence } : {}),
        }, null, 2), "utf-8");

        // 2) spawn 独立验收进程（--auto 永不出现在这里）
        const argv = [bunPath, "run", indexTs, "--verify", "--input", reqFile];
        if (opts.reviewMode === "off") argv.push("--no-llm-review");
        if (opts.reviewTimeoutMs !== undefined && opts.reviewMode !== "off") {
            argv.push("--review-timeout-ms", String(opts.reviewTimeoutMs));
        }
        try {
            proc = Bun.spawn(argv, {
                stdout: "pipe", stderr: "pipe",
                env: (opts.env ?? process.env) as Record<string, string>,
            });
        } catch (e) {
            return envFailure([`验收进程无法启动：${(e as Error).message}`], null);
        }
        const killTimer = new Promise<"timeout">((res) => {
            // 注意：**不能 unref**——9/13 子 Agent 超时测试的实测教训：
            // 事件循环里只剩这个 timer 时，unref 的 timer 永远不触发，race 挂死。
            timer = setTimeout(() => { res("timeout"); }, totalMs);
        });
        const exitP = proc.exited.then((code) => ({ code } as const));
        const raced = await Promise.race([exitP, killTimer]);
        if (raced === "timeout") {
            try { proc.kill(); } catch { /* 已退 */ }
            await Bun.sleep(300);
            try { proc.kill(9); } catch { /* 已退 */ }
            return envFailure([`验收进程超过 ${totalMs}ms 未完成，已终止（看门狗）`], null);
        }
        const [stdout, stderr] = await Promise.all([
            new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
            new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
        ]);
        log(`[adapter] verify 进程退出 code=${raced.code}（stdout ${stdout.length}B / stderr ${stderr.length}B）`);

        // 3) stdout 必须是一份合法 JSON——不是就是协议故障，没有第二种解释
        let result: AdapterVerifyResult;
        try {
            result = JSON.parse(stdout.trim()) as AdapterVerifyResult;
            if (!result || typeof result !== "object" || typeof result.verdict !== "string") throw new Error("缺 verdict");
        } catch (e) {
            return envFailure(
                [`验收输出不是合法 JSON（${(e as Error).message}）`, `进程退出码 ${String(raced.code)}`],
                raced.code, stdout, stderr,
            );
        }

        // 4) 五字段身份核对：任何一项对不上 = 串线/伪造，拒收并结构化失败
        const mismatches = IDENTITY_FIELDS.filter((f) => result[f] !== req[f]);
        if (mismatches.length > 0) {
            return envFailure(
                [`身份核对失败：${mismatches.map((f) => `${f}(${String(result[f])}≠${req[f]})`).join("；")}`],
                raced.code, stdout, stderr,
            );
        }

        // 5) 分支映射
        if (result.verdict === "blocked_unverified") {
            log(`[adapter] ⏸ ${result.skipped.length} 项判据未执行 → unverified（交给装配器落 blocked_unverified，不冒充 pass/fail）`);
            return { kind: "unverified", result };
        }
        if (result.verdict === "error") {
            return envFailure([`verify 判输入非法：${result.error ?? "未给原因"}`], raced.code, stdout, stderr);
        }

        // 三件套：机械证据 + 全部失败 + LLM 审查 —— Developer 一次看全，不许只给第一条
        const attachments = reviewAttachments(result);
        const blocking = collectBlockingFindings(result);

        if (result.verdict === "fail") {
            const f = result.failure;
            if (!f) return envFailure(["verdict=fail 却没带 failure 证据——不可信"], raced.code, stdout, stderr);
            const orig = req.acceptanceChecks.find((c) => c.id === f.checkId);
            // allFailures 原样搬运：verify 亲口报的红单优先，缺了才从 evidence 回算
            // （旧版 verify 只给 evidence 时同样可用）。执行事实一个字段都不许丢——
            // Developer 要靠 timedOut / 起止时间区分"编译红了"和"启动超时了"。
            const failing = Array.isArray(result.allFailures) && result.allFailures.length > 0
                ? result.allFailures
                : result.evidence.filter((e) => e.exitCode !== 0);
            const message: TestFailure = {
                type: "test_failure",
                messageId: `msg-${hashOf({ c: req.correlationId, e: f.checkId, t: Date.now() })}`,
                correlationId: req.correlationId,
                runId: req.runId,
                acceptanceHash: req.acceptanceHash,
                projectId: req.projectId,
                taskId: req.taskId,
                category: (CATEGORIES.includes(f.category) ? f.category : "COMPILE") as TestFailureCategory,
                command: f.command,
                args: f.args,
                cwd: f.cwd,
                exitCode: f.exitCode,
                stdout: cap(f.stdout),
                stderr: cap(f.stderr),
                affectedFiles: orig?.affectedFiles ?? [],
                failureSignature: signatureOf(f),
                origin: "mechanical" as const,
                needsHuman: false,
                allFailures: failing.map((e) => ({
                    checkId: e.checkId,
                    category: (CATEGORIES.includes(e.category) ? e.category : "ENV") as TestFailureCategory,
                    command: e.command, args: e.args, cwd: e.cwd, exitCode: e.exitCode,
                    stdout: cap(e.stdout), stderr: cap(e.stderr), failureSignature: signatureOf(e),
                    timedOut: e.timedOut === true,
                    startedAt: e.startedAt,
                    finishedAt: e.finishedAt,
                    durationMs: e.durationMs,
                } satisfies AdditionalFailure)),
                ...attachments,
            };
            log(`[adapter] ❌ ${f.checkId}（exit=${String(f.exitCode)}）→ test_failure sig=${message.failureSignature.slice(0, 8)}`
                + `；红单 ${message.allFailures!.length} 条；审查 findings ${(message.llmReview?.findings.length ?? 0) + (message.reviewSignals?.length ?? 0)} 条`
                + `；阻断 ${blocking.length} 条`);
            return {
                kind: "test_failure", message, result,
                reasons: [
                    `判据 ${f.checkId} 真实执行失败（exit=${String(f.exitCode)}${f.timedOut ? "，超时" : ""}）`,
                    ...(blocking.length > 0 ? [`另有 ${blocking.length} 条语义阻断项`] : []),
                ],
            };
        }
        if (result.verdict === "pass") {
            // ① 机械复核：口说无凭，逐条看证据（绝不伪造通过）
            const checksN = req.acceptanceChecks.length;
            const reasons: string[] = [];
            if (result.skipped.length > 0) reasons.push(`pass 却有 ${result.skipped.length} 项 skipped`);
            if (result.evidence.length !== checksN) reasons.push(`证据 ${result.evidence.length} 条 ≠ 判据 ${checksN} 条`);
            const nonZero = result.evidence.filter((e) => e.exitCode !== 0);
            if (nonZero.length > 0) reasons.push(`证据里有非零退出码：${nonZero.map((e) => `${e.checkId}=${String(e.exitCode)}`).join("、")}`);
            // 自相矛盾：自称通过却带着红单。红单不是装饰，是真实执行结果——
            // 有红项就不可能是 pass。伪造 allFailures 也别想换来 test_passed。
            const forged = Array.isArray(result.allFailures) ? result.allFailures : [];
            if (forged.length > 0) reasons.push(`pass 却带着 ${forged.length} 条 allFailures（${forged.map((e) => e.checkId).join("、")}）——自相矛盾`);
            if (reasons.length > 0) {
                return envFailure([`pass 结论未通过适配器复核：${reasons.join("；")}`], raced.code, stdout, stderr);
            }
            // ② 没有机器证据就没有通过：证据条数必须与判据一一对上（上面已比过条数）
            if (result.evidence.length === 0) {
                return envFailure(["pass 却没有 evidence——没有机器证据就不存在 test_passed"], raced.code, stdout, stderr);
            }

            // ③ 语义闸（本轮新增）：机械绿不等于可以放行。
            //    · 有 critical/major 发现 → 结构化失败，逼 Developer 真修；
            //    · 审查不可用 / 不确定 / 低置信 → 需要人工确认，绝不当 pass；
            //    · 只有 outcome 亲口等于 pass（机械 pass + 审查 ok + pass + 高置信 + 无阻断）才发 test_passed。
            if (blocking.length > 0) {
                const message = reviewFailureMessage(req, result, attachments, blocking);
                log(`[adapter] 🚫 机械绿但语义审查报 ${blocking.length} 条阻断项 → test_failure sig=${message.failureSignature.slice(0, 8)}`);
                return {
                    kind: "test_failure", message, result,
                    reasons: [`语义审查报 ${blocking.length} 条阻断项`, ...blocking.map((f) => `${f.severity}/${f.category} ${f.title}`)],
                };
            }
            const gate = semanticGateReasons(result);
            if (gate.length > 0) {
                log(`[adapter] 🙋 机械绿但语义闸未过 → needs_human：${gate.join("；")}`);
                return { kind: "needs_human", reasons: gate, result };
            }

            const evidence: VerificationEvidence[] = result.evidence.map((e) => ({
                checkId: e.checkId,
                command: e.command,
                args: e.args,
                cwd: e.cwd,
                exitCode: 0,
                startedAt: e.startedAt,
                finishedAt: e.finishedAt,
                inputHash: hashOf({ acceptanceHash: req.acceptanceHash, checkId: e.checkId, command: e.command, cwd: e.cwd }),
                stdoutHash: hashOf(e.stdout),
                stderrHash: hashOf(e.stderr),
            }));
            const message: TestPassed = {
                type: "test_passed",
                messageId: `msg-${hashOf({ c: req.correlationId, t: Date.now() })}`,
                correlationId: req.correlationId,
                projectId: req.projectId,
                taskId: req.taskId,
                runId: req.runId,
                evidence,
                verifiedBy: VERIFY_AGENT_NAME,
                acceptanceHash: req.acceptanceHash,
            };
            log(`[adapter] ✅ ${evidence.length} 项机械全绿 + 语义审查通过 → test_passed`
                + `（model=${result.reviewAudit?.model ?? "?"}，findings ${result.llmReview?.findings.length ?? 0}）`);
            return { kind: "test_passed", message, result };
        }
        return envFailure([`未知 verdict：${result.verdict}`], raced.code, stdout, stderr);
    } catch (e) {
        return envFailure([`适配器异常：${(e as Error).message}`], proc?.exitCode ?? null);
    } finally {
        if (timer) clearTimeout(timer);
        try { fs.rmSync(reqFile, { force: true }); } catch { /* 临时文件清不掉不拦路 */ }
    }
}
