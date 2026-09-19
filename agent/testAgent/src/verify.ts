// ============================================================
// src/verify.ts —— 只读验收模式（--verify）：独立验证器，不是开发工具
//
//   与 --auto 的分工（9/13 结构定稿）：
//     --auto  = 桌面端本地修复循环（调 LLM、可改代码），**不进服务端裁判链**；
//     --verify = 按 request.json 里**明确给出**的验收项重新执行，产机器证据。
//
//   两段式（本轮新增第二段，边界不许混）：
//     第一段 · 机械验收：跑命令，verdict **只**由 exitCode / evidence / skipped 算。
//       本文件不 import 任何模型链（main/models/tool 一个都不碰）——机械段零 LLM 是
//       结构性成立的，不是靠"key 恰好没配"。
//     第二段 · 语义审查（src/review.ts）：机械段跑完之后，把**全部**机器证据连同项目
//       文件树 / 关键源码 / HTTP 页面响应交给审查模型，找出机械脚本看不出的问题
//       （占位页面、内存冒充持久化、把验收固定值抄进代码、吞异常……）。
//       审查段**只读、无工具**，且它的结论由 `decideReview` 的纯函数裁决：
//         · 审查不能生成 pass——通过必须同时满足 机械 pass + 审查可用 + 审查 pass + 高置信 + 无阻断项；
//         · 任一 critical/major 发现都阻断；
//         · LLM 抛错 / 超时 / 输出不合契约 → LLM_REVIEW_UNAVAILABLE，绝不当 pass；
//         · 库层默认**不开**审查（enabled 缺省 false），CLI 才默认开——所以单测与
//           机械路径永远不会偷偷联网。
//     最终结论放在 `outcome`；`verdict` 永远是机械 verdict 的原文，两者不许互相顶替。
//
//   本文件自身的四条铁律，全部是代码约束、不靠自觉：
//     ① 不 import 任何模型链——机械段零 LLM 结构性成立（审查段在 review.ts 里）；
//     ② 无 edit/write：整个模块只 fs.read 与 spawn，目标项目由调用方传 projectDir；
//     ③ 不猜测试命令：check 没给 command 就记 skipped（→ blocked_unverified），
//        绝不"看起来像 npm 项目就跑 npm test"；
//     ④ stdout 只有一份最终 JSON，运行日志全走 stderr——CI/适配器可以裸读 stdout。
//
//   判定规则（裁决第四节，逐字对齐）：
//     pass               = 所有验收项真实执行且 exitCode=0，且 skipped 为空
//     fail               = 任意真实验收项 exitCode 非 0（含超时 exitCode=null）
//     blocked_unverified = 任意验收项未执行（命令不存在/目录不存在/越界/cwd 非法）
//     error              = 输入非法、身份字段缺失或验收列表为空
//   优先级：fail > blocked_unverified（有真实失败证据就先给 Developer 修；
//   skipped 仍然原样出现在结果里，适配器据此可另行处置）。
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { collectReviewContext, decideReview, extractPageProbes, runLlmReview } from "./review";
import type {
    LlmReview, PageProbe, ReviewFinding, ReviewLlm, ReviewOutcome, TokenUsage,
} from "./review";

// ---------- 输入/输出契约（与 CrewForge testAgentAdapter 逐字段对齐） ----------

export interface VerifyCheck {
    id: string;
    /** 失败分类提示（COMPILE/BOOT/MIGRATION/CONTRACT/RENDER/ENV…），仅透传进证据 */
    category?: string;
    /** 执行命令。没给 = 不猜 = skipped */
    command?: string;
    args?: string[];
    /** 相对 projectDir 的工作目录；越界（跳出 projectDir）一律拒绝 */
    cwd?: string;
    timeoutMs?: number;
    affectedFiles?: string[];
}

export interface VerifyRequest {
    type: "test_request";
    projectId: string;
    taskId: string;
    runId: string;
    correlationId: string;
    acceptanceHash: string;
    projectDir: string;
    acceptanceChecks: VerifyCheck[];
    /** 任务包/契约里已知的**验收固定值**：源码里出现即"抄答案当种子"。
     *  只用来追加怀疑，不能用它放行任何东西。 */
    acceptanceLiterals?: string[];
    /** 该项目的契约是否要求持久化存储。缺省 true（检测器本身很保守，不会见数组就报） */
    requiresPersistence?: boolean;
}

export interface VerifyEvidence {
    checkId: string;
    category: string;
    command: string;
    args: string[];
    cwd: string;
    /** 未正常退出（超时/被杀）为 null——null ≠ 0，按 fail 处理 */
    exitCode: number | null;
    startedAt: number;
    finishedAt: number;
    durationMs: number;
    timedOut: boolean;
    stdout: string;
    stderr: string;
}

export interface VerifySkipped {
    checkId: string;
    reason: string;
}

export type VerifyVerdict = "pass" | "fail" | "blocked_unverified" | "error";

export interface VerifyResult {
    /** **机械** verdict：只由 exitCode / evidence / skipped 算。审查层永远改不动它 */
    verdict: VerifyVerdict;
    projectId: string;
    taskId: string;
    runId: string;
    correlationId: string;
    acceptanceHash: string;
    evidence: VerifyEvidence[];
    skipped: VerifySkipped[];
    failure: VerifyEvidence | null;
    /** 所有真实执行但失败的判据；不能只把第一条红项传给上游。 */
    allFailures: VerifyEvidence[];
    /** 仅 error 时有值：输入哪里非法 */
    error?: string;

    // ---------- 语义审查（第二段）----------
    /** 机械 verdict 的显式别名，便于消费方一眼分清"哪段算出来的" */
    mechanicalVerdict: VerifyVerdict;
    /** 机械 verdict 只由代码算；这一项是**最终**能不能放行 */
    outcome: ReviewOutcome;
    outcomeReason: string;
    llmReview: LlmReview | null;
    /** 确定性预扫信号（全量，不截断） */
    reviewSignals: ReviewFinding[];
    /** critical/major 发现（非空即阻断）——机械红单与语义发现都算在一起 */
    blockingFindings: ReviewFinding[];
    reviewStatus: "ok" | "LLM_REVIEW_UNAVAILABLE" | "disabled";
    reviewReason: string | null;
    /** 审查审计（供上游落 Ledger）：promptHash / evidenceHash / model / duration / tokenUsage */
    reviewAudit: {
        model: string; promptHash: string; evidenceHash: string;
        durationMs: number; tokenUsage: TokenUsage | null;
    } | null;
}

/** 审查段的可注入选项（库层默认不开；CLI 才默认开） */
export interface VerifyReviewOptions {
    enabled?: boolean;
    llm?: ReviewLlm;
    timeoutMs?: number;
    log?: (line: string) => void;
}

export interface VerifyOptions {
    review?: VerifyReviewOptions;
    /** 仅测试用：直接给出页面探测，跳过启发式抽取 */
    pages?: PageProbe[];
}

const OUT_CAP = 64_000;
const DEFAULT_TIMEOUT_MS = 600_000;

/** 日志只准走 stderr——stdout 是对 CI 的"单 JSON"契约 */
function log(line: string): void {
    process.stderr.write(`[verify] ${line}\n`);
}

const IDENTITY_FIELDS = ["projectId", "taskId", "runId", "correlationId", "acceptanceHash"] as const;

function emptyResult(raw: unknown): VerifyResult {
    const r = (raw ?? {}) as Record<string, unknown>;
    const pick = (k: string): string => (typeof r[k] === "string" ? (r[k] as string) : "");
    return {
        verdict: "error",
        projectId: pick("projectId"), taskId: pick("taskId"), runId: pick("runId"),
        correlationId: pick("correlationId"), acceptanceHash: pick("acceptanceHash"),
        evidence: [], skipped: [], failure: null,
        allFailures: [],
        mechanicalVerdict: "error",
        outcome: "error",
        outcomeReason: "输入非法——结论不可信，审查不改变这一点",
        llmReview: null, reviewSignals: [], blockingFindings: [],
        reviewStatus: "disabled", reviewReason: null, reviewAudit: null,
    };
}

/** Windows 无 shell 的 Bun.spawn 不认 npm 系包装与 .cmd/.bat——执行机制补齐，不算"猜命令" */
function spawnArgv(command: string, args: string[]): string[] {
    if (process.platform !== "win32") return [command, ...args];
    const isWrapper = /^(npm|npx|pnpm|yarn|tsc|vite)$/i.test(command);
    const isScript = /\.(cmd|bat)$/i.test(command);
    return isWrapper || isScript ? ["cmd", "/c", command, ...args] : [command, ...args];
}

/**
 * 命令存在性探测（"命令不存在 → blocked_unverified，不是 fail"的地基）：
 * Windows 上 Bun.spawn 对不存在的裸命令**不抛错**，会退出码 1 收场——不先查
 * 就会把"没人执行"谎报成"执行了且失败"，判定规则就假了。所以显式查 PATH。
 */
function commandExists(command: string, argv0: string): boolean {
    if (argv0 !== command) return true; // cmd /c 包装：cmd.exe 必然在（npm 不存在时由 cmd 报"不是内部或外部命令"→ stderr 兜底判断见 runOne）
    if (command.includes("/") || command.includes("\\") || path.isAbsolute(command)) {
        try { return fs.existsSync(command); } catch { return false; }
    }
    if (!/^[^/\\]+$/.test(command)) return true; // 带相对路径段的按 existsSync 之外一律放行给 spawn
    const exts = process.platform === "win32"
        ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").map((s) => s.toLowerCase())
        : [""];
    const hasExt = process.platform === "win32" && /\.(exe|cmd|bat|com)$/i.test(command);
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
        if (!dir) continue;
        for (const ext of exts) {
            try { if (fs.existsSync(path.join(dir, hasExt ? command : command + ext))) return true; }
            catch { /* 坏 PATH 项跳过 */ }
        }
    }
    return false;
}

/** cwd 守卫：必须落在 projectDir 内（含根目录本身）且真实存在 */
function guardedCwd(projectDir: string, cwdRel: string): { abs: string } | { bad: string } {
    const abs = path.resolve(projectDir, cwdRel);
    const rel = path.relative(path.resolve(projectDir), abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return { bad: `cwd 越界（${cwdRel} 跳出 projectDir）` };
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return { bad: `目录不存在（${cwdRel}）` };
    return { abs };
}

async function runOne(projectDir: string, c: VerifyCheck): Promise<VerifyEvidence | VerifySkipped> {
    const cwdRel = typeof c.cwd === "string" && c.cwd ? c.cwd : ".";
    const guard = guardedCwd(projectDir, cwdRel);
    if ("bad" in guard) return { checkId: c.id, reason: guard.bad };
    if (typeof c.command !== "string" || !c.command.trim()) {
        return { checkId: c.id, reason: "未给出 command——verify 不猜测试命令" };
    }

    const timeoutMs = Number.isFinite(c.timeoutMs) && (c.timeoutMs as number) > 0
        ? (c.timeoutMs as number) : DEFAULT_TIMEOUT_MS;
    const startedAt = Date.now();
    let timedOut = false;

    const argv = spawnArgv(c.command, Array.isArray(c.args) ? c.args.map(String) : []);
    if (!commandExists(c.command, argv[0]!)) {
        return { checkId: c.id, reason: `命令不存在（PATH 中找不到 ${c.command}）` };
    }
    let proc: ReturnType<typeof Bun.spawn>;
    try {
        proc = Bun.spawn(argv, {
            cwd: guard.abs, stdout: "pipe", stderr: "pipe", env: { ...process.env },
        });
    } catch (e) {
        // 命令不可执行 = 没跑成 = 未执行（skipped→blocked_unverified），不是代码有罪
        return { checkId: c.id, reason: `命令无法启动：${(e as Error).message}` };
    }

    const timer = setTimeout(() => { timedOut = true; try { proc.kill(); } catch { /* 已退 */ } }, timeoutMs);
    const [outRaw, errRaw] = await Promise.all([
        new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
        new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    ]);
    let exitCode: number | null = timedOut ? null : await proc.exited;
    clearTimeout(timer);
    if (timedOut) {
        try { proc.kill(9); } catch { /* 已退 */ }
    }
    // cmd /c 包装下命令不存在的兜底识别（"npm 没装"≠"测试失败"，别谎报成执行有罪）
    if (!timedOut && (exitCode ?? 0) !== 0 && argv[0] === "cmd"
        && /不是内部或外部命令|is not recognized|无法将/i.test(errRaw)) {
        return { checkId: c.id, reason: `命令不存在（cmd 报告）：${c.command}` };
    }
    const finishedAt = Date.now();
    const cap = (s: string): string => (s.length > OUT_CAP ? `${s.slice(0, OUT_CAP)}\n…[截断，原长 ${s.length}]` : s);

    log(`${exitCode === 0 && !timedOut ? "✅" : "❌"} ${c.id}: ${c.command} exit=${String(exitCode)}${timedOut ? "（超时）" : ""} ${finishedAt - startedAt}ms`);
    return {
        checkId: c.id,
        category: typeof c.category === "string" && c.category ? c.category : "COMMAND",
        command: c.command,
        args: Array.isArray(c.args) ? c.args.map(String) : [],
        cwd: cwdRel,
        exitCode,
        startedAt, finishedAt, durationMs: finishedAt - startedAt,
        timedOut,
        stdout: cap(outRaw), stderr: cap(errRaw),
    };
}

/**
 * 验收主流程。入参故意收 unknown：任何形状问题都在内部消化成 verdict=error，
 * 不向调用方抛异常——stdout 单 JSON 的契约高于一切。
 */
export async function runVerify(raw: unknown, opts: VerifyOptions = {}): Promise<VerifyResult> {
    const result = emptyResult(raw);

    // ── 输入合法性（error 出口）──
    const problems: string[] = [];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) problems.push("request 不是对象");
    else {
        const r = raw as Record<string, unknown>;
        if (r["type"] !== "test_request") problems.push(`type 必须是 test_request（收到 ${String(r["type"])})`);
        for (const f of IDENTITY_FIELDS) {
            if (typeof r[f] !== "string" || !(r[f] as string).trim()) problems.push(`身份字段缺失：${f}`);
        }
        if (typeof r["projectDir"] !== "string" || !r["projectDir"]) problems.push("projectDir 缺失");
        else if (!fs.existsSync(r["projectDir"]) || !fs.statSync(r["projectDir"]).isDirectory())
            problems.push(`projectDir 不存在：${r["projectDir"]}`);
        const checks = r["acceptanceChecks"];
        if (!Array.isArray(checks) || checks.length === 0) problems.push("acceptanceChecks 为空——没有判据就没有验收");
        else checks.forEach((c, i) => {
            const cc = c as { id?: unknown };
            if (!cc || typeof cc.id !== "string" || !cc.id.trim()) problems.push(`acceptanceChecks[${i}] 缺 id`);
            // 重复 id 不拦：按声明顺序全跑，证据各归各条
        });
    }
    if (problems.length > 0) {
        result.error = `输入非法：${problems.join("；")}`;
        log(`⛔ ${result.error}`);
        return result;
    }

    const req = raw as unknown as VerifyRequest;
    const evidence: VerifyEvidence[] = [];
    const skipped: VerifySkipped[] = [];
    for (const c of req.acceptanceChecks) {
        const one = await runOne(req.projectDir, c);
        if ("reason" in one) {
            skipped.push(one);
            log(`⏭ ${one.checkId} 未执行：${one.reason}`);
        } else evidence.push(one);
    }

    const failure = evidence.find((e) => e.exitCode !== 0) ?? null;
    result.evidence = evidence;
    result.skipped = skipped;
    result.failure = failure;
    result.allFailures = evidence.filter((e) => e.exitCode !== 0);
    // ── 机械 verdict：**只看** exitCode / evidence / skipped。审查段在这之后才跑 ──
    result.verdict = failure ? "fail" : skipped.length > 0 ? "blocked_unverified" : "pass";
    result.mechanicalVerdict = result.verdict;
    if (result.verdict === "pass") log(`✅ 全部 ${evidence.length} 项真实执行且 exit=0，skipped=0 → 机械 pass`);

    // blocked_unverified 不进审查：根本没有可审查的执行结果。
    // 输入非法走 emptyResult()，verdict="error" 在进函数前就已返回；机械失败 fail **要**进审查
    // ——两边的问题一起给 Developer。
    if (result.verdict === "blocked_unverified") {
        result.outcome = result.verdict;
        result.outcomeReason = "有判据没被执行——未验证不等于通过";
        return result;
    }

    await reviewPhase(req, result, opts);
    return result;
}

/** 第二段：语义审查。只读上下文 + 可注入模型；结论由 decideReview 纯函数算。 */
async function reviewPhase(req: VerifyRequest, result: VerifyResult, opts: VerifyOptions): Promise<void> {
    const ro = opts.review ?? {};
    const pages = opts.pages ?? extractPageProbes(result.evidence);

    const ctx = collectReviewContext({
        projectDir: req.projectDir,
        mechanical: {
            verdict: result.verdict, evidence: result.evidence,
            skipped: result.skipped, allFailures: result.allFailures,
        },
        pages,
        acceptanceLiterals: Array.isArray(req.acceptanceLiterals) ? req.acceptanceLiterals : [],
        requiresPersistence: req.requiresPersistence !== false,
    });
    const audit = await runLlmReview(ctx, ro);

    result.llmReview = audit.review;
    result.reviewSignals = audit.signals;
    result.reviewStatus = audit.status;
    result.reviewReason = audit.reason;
    result.reviewAudit = {
        model: audit.model, promptHash: audit.promptHash, evidenceHash: audit.evidenceHash,
        durationMs: audit.durationMs, tokenUsage: audit.tokenUsage,
    };

    const decision = decideReview(result.verdict, audit);
    result.outcome = decision.outcome;
    result.outcomeReason = decision.reason;
    result.blockingFindings = decision.blocking;
    log(`🧭 outcome=${decision.outcome}（机械 ${result.verdict}；审查 ${audit.status}；`
        + `阻断项 ${decision.blocking.length}；预扫 ${audit.signals.length}）—— ${decision.reason}`);
}

/** 退出码映射：机械 pass=0；fail/blocked_unverified=1；error=2（结论不可信） */
export function verifyExitCode(v: VerifyVerdict): number {
    return v === "pass" ? 0 : v === "error" ? 2 : 1;
}
