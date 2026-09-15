// ============================================================
// live/verifier.ts —— 我（模拟架构师）兼任的 TestAgent：真跑验收命令
//
//   铁律对齐：done / verified 只能由**外部**测试判定——所以这个文件刻意
//   不复用 developerAgent 的 workspace/工具层，直接 Bun.spawn 独立执行，
//   跟 Developer 跑构建是两条互不污染的通道（Developer 自跑的 runBuild
//   只是"自检"，这里的结果才是 test_passed / test_failure 的证据）。
//
//   acceptanceCheck 两种形状（任务包声明，runner 与 TestAgent 共读）：
//   ① 显式命令（手写 fixture、历史任务包）——行为与以前完全一致：
//        { id, command, args?, cwd?, timeoutMs?, category?, affectedFiles? }
//   ② **意图**（architectTaskBuilder 机械生成，不预写任何框架命令）：
//        { id, kind:"COMPILE",  target:"backend", expected:"exitCode=0" }
//        { id, kind:"CONTRACT", method:"POST", path:"/api/notes", expectedStatus:201 }
//      → COMPILE 的命令由**工程文件**解析（mvnw / gradlew / package.json / pyproject / go.mod），
//        不是按框架写死；
//      → CONTRACT 本仓库还没有通用 HTTP 执行器，**登记为 skipped 而不是判失败**：
//        既不能让"没人执行的判据"冒充通过，也不能让一个悬空判据毒死整轮验收。
//        ★ 但 skipped 非空时**本轮结论只能是 blocked_unverified**（见 verdictKindOf）：
//          「编译过了、HTTP 没人跑」不等于通过，不许发 test_passed。
//   category ∈ COMPILE | BOOT | MIGRATION | CONTRACT | RENDER | ENV（protocol 的枚举）
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { hashOf } from "../ledger";
import type { AcceptanceCheck, TestFailureCategory, VerificationEvidence } from "../protocol";
import { resolveProjectCommand as resolveGenericCommand } from "../tools/projectCommands";
import { suggestServeCommand } from "../../contractProbeCore";
import type { ServeSpec } from "../../contractProbeCore";

/**
 * 契约探针 CLI 的绝对路径（本文件在 developerAgent/live/，CLI 在 agents-CrewForge/ 根）。
 * verifier 与 hub-runner 都指向**同一个**文件——执行逻辑只有一份（contractProbeCore）。
 */
const PROBE_CLI = path.resolve(import.meta.dir, "..", "..", "httpContractProbe.ts");

/**
 * 决定"怎么把被测服务跑起来"。判定顺序（全是机械规则，不猜）：
 *   ① 判据自己声明的 serveCommand/serveArgs（最可信：任务包 / 架构师知道服务怎么起）；
 *   ② 工程文件探测：serveCwd/package.json 的 dev → start（suggestServeCommand）；
 *   ③ 都拿不到 → null（调用方如实 skip，不许编命令）。
 */
function resolveServeSpec(
    projectDir: string,
    c: {
        serveCommand?: unknown; serveArgs?: unknown; serveCwd?: unknown; portEnv?: unknown;
        healthPath?: unknown; bootWaitMs?: unknown; resetPaths?: unknown;
        method?: unknown; path?: unknown; expectedStatus?: unknown; body?: unknown;
        expectBodyContains?: unknown; assertJson?: unknown; auth?: unknown; setup?: unknown; headers?: unknown;
    },
): ServeSpec | null {
    const cwd = typeof c.serveCwd === "string" && c.serveCwd ? c.serveCwd : "backend";
    const common = {
        cwd,
        portEnv: typeof c.portEnv === "string" && c.portEnv ? c.portEnv : "PORT",
        healthPath: typeof c.healthPath === "string" && c.healthPath ? c.healthPath : "/",
        bootWaitMs: typeof c.bootWaitMs === "number" ? c.bootWaitMs : 30_000,
        // 干净起点：判据声明了要清哪些数据文件就清（"测试前清空数据库"从此是机械动作，不是一句空话）
        ...(Array.isArray(c.resetPaths) ? { resetPaths: (c.resetPaths as unknown[]).map(String) } : {}),
    };
    if (typeof c.serveCommand === "string" && c.serveCommand) {
        return {
            command: c.serveCommand,
            args: Array.isArray(c.serveArgs) ? (c.serveArgs as unknown[]).map(String) : [],
            why: "declared-serveCommand",
            ...common,
        };
    }
    const guessed = suggestServeCommand(path.join(projectDir, cwd));
    if (guessed) return { command: guessed.command, args: guessed.args, why: guessed.why, ...common };
    return null;
}

export interface CheckExec {
    check: AcceptanceCheck & { id: string };
    /** 实际执行的命令（显式声明的，或按工程文件解析出来的） */
    command: string;
    args: string[];
    /** 命令从哪来：declared | maven-wrapper | gradle-wrapper | package.json.scripts.* | … */
    resolvedBy: string;
    cwd: string;
    startedAt: number;
    finishedAt: number;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    durationMs: number;
}

export interface SkippedCheck {
    checkId: string;
    kind: string;
    reason: string;
}

export interface Verdict {
    /** 全部检查的机器证据（TestPassed 消息用） */
    evidence: VerificationEvidence[];
    /** 第一个失败的执行事实（TestFailure 消息用）；全绿为 null */
    firstFailure: CheckExec | null;
    results: CheckExec[];
    /** 没有执行的验收项（意图式 CONTRACT / 找不到工程入口）——如实报，不冒充通过 */
    skipped: SkippedCheck[];
}

/**
 * 本轮结论的**唯一**取舍点（纯函数，方便测试钉住）：
 *
 *   · 有失败 → test_failure（失败本来就不是通过，且要进修复回路）
 *   · 没失败但**有跳过** → blocked_unverified（★ 不许 test_passed）
 *   · 没失败也没跳过 → test_passed
 *
 * 第二条是关键：跳过的判据**没有执行**，拿它当绿灯等于凭空宣布通过。
 * 所以「编译过了、HTTP 没人跑」这种情况必须是 blocked_unverified，不是 verified。
 */
export type VerdictKind = "test_passed" | "test_failure" | "blocked_unverified";

export function verdictKindOf(v: Verdict): VerdictKind {
    if (v.firstFailure) return "test_failure";
    if (v.skipped.length > 0) return "blocked_unverified";
    return "test_passed";
}

/** 一条验收项的可执行形态；exec=null 表示"当前无法机械执行" */
interface PreparedCheck {
    check: AcceptanceCheck & { id: string };
    exec: { command: string; args: string[]; cwd: string; resolvedBy: string } | null;
    skipKind: string;
    skipReason: string;
}

/** 把声明/意图统一成"要么可执行，要么如实说清为什么不能执行" */
export function prepareCheck(projectDir: string, check: AcceptanceCheck & { id: string }): PreparedCheck {
    const c = check as unknown as {
        command?: unknown; args?: unknown; cwd?: unknown;
        kind?: unknown; target?: unknown; method?: unknown; path?: unknown;
        expectedStatus?: unknown; body?: unknown; expectBodyContains?: unknown;
        assertJson?: unknown; auth?: unknown; setup?: unknown; headers?: unknown;
        serveCommand?: unknown; serveArgs?: unknown; serveCwd?: unknown; portEnv?: unknown;
        healthPath?: unknown; bootWaitMs?: unknown; resetPaths?: unknown;
    };
    const skipKind = typeof c.kind === "string" ? c.kind : "UNKNOWN";

    // ① 显式命令：原样执行（历史行为完全不变）
    if (typeof c.command === "string" && c.command) {
        const args = Array.isArray(c.args) ? (c.args as unknown[]).map(String) : [];
        return {
            check,
            exec: { command: c.command, args, cwd: String(c.cwd ?? "."), resolvedBy: "declared" },
            skipKind, skipReason: "",
        };
    }

    // ② 意图：COMPILE 按工程文件解析命令
    if (skipKind === "COMPILE") {
        const target = String(c.target ?? ".");
        const dirAbs = path.join(projectDir, target);
        const resolved = resolveGenericCommand(dirAbs);
        if (resolved) {
            return {
                check,
                exec: { command: resolved.command, args: resolved.args, cwd: target, resolvedBy: resolved.detectedBy },
                skipKind, skipReason: "",
            };
        }
        return {
            check, exec: null, skipKind,
            skipReason: `目录 ${target} 里找不到通用工程入口（mvnw / gradlew / package.json / pyproject.toml / requirements.txt / go.mod）——不猜命令`,
        };
    }

    // ③ 意图：CONTRACT → 翻译成契约探针命令（9/15 下沉：执行核已进 contractProbeCore，
    //    Developer 侧同名工具与这里**同一份执行逻辑**，两条路径从此行为一致）。
    //
    //   以前这里登记为 skipped，直接后果是 r5 的 8/10 判据无人执行 →
    //   verdictKindOf 必然返回 blocked_unverified → 任务**永远拿不到 ready**。
    //   现在翻译成显式命令，让验收站真跑。
    //
    //   serve 规格从哪来：项目里探（package.json 的 dev/start），探不到就**如实 skip**
    //   （不猜命令是底线）；显式声明了 serveCommand 的优先用它。
    if (skipKind === "CONTRACT") {
        const p = typeof c.path === "string" && c.path ? c.path : null;
        if (!p) {
            return { check, exec: null, skipKind, skipReason: "CONTRACT 判据缺 path，无法翻译成探针命令" };
        }
        const serve = resolveServeSpec(projectDir, c);
        if (!serve) {
            return {
                check, exec: null, skipKind,
                skipReason: `找不到起服务的方式（${String(c.serveCwd ?? "backend")}/package.json 无 dev/start 脚本，`
                    + `判据也没声明 serveCommand）——不猜命令（${String(c.method ?? "?")} ${p}）`,
            };
        }
        const serveJson = JSON.stringify({ ...serve, cwd: "." });
        const intentJson = JSON.stringify({
            method: String(c.method ?? "GET").toUpperCase(),
            path: p,
            expectedStatus: typeof c.expectedStatus === "number" ? c.expectedStatus : 200,
            ...(c.body !== undefined ? { body: c.body } : {}),
            ...(typeof c.expectBodyContains === "string" ? { expectBodyContains: c.expectBodyContains } : {}),
            // 结构化断言（过滤/隔离/汇总类语义）：与 Developer 侧同形状透传
            ...(Array.isArray(c.assertJson) ? { assertJson: c.assertJson } : {}),
            ...(c.auth ? { auth: c.auth } : {}),
            // 前置步骤（播数据/取变量）：与 Developer 侧 runAcceptance 走同一份执行逻辑
            ...(Array.isArray(c.setup) ? { setup: c.setup } : {}),
            // 自定义请求头（通用能力：多身份判据靠它表达；引擎不解释头语义）
            ...(c.headers && typeof c.headers === "object" ? { headers: c.headers } : {}),
        });
        return {
            check,
            exec: {
                command: "bun",
                args: ["run", PROBE_CLI, "--serve", serveJson, "--intent", intentJson],
                cwd: serve.cwd,
                resolvedBy: `contract-probe(${serve.why})`,
            },
            skipKind, skipReason: "",
        };
    }

    return { check, exec: null, skipKind, skipReason: `无法机械执行的验收项形状（kind=${skipKind}）` };
}

/** 单条验收：独立 spawn 执行，Windows 的 .cmd/.bat 经 cmd /c（与 workspace.exec 同逻辑） */
async function runPrepared(projectDir: string, p: PreparedCheck): Promise<CheckExec> {
    const exec = p.exec!;
    const timeoutMs = Number((p.check as unknown as { timeoutMs?: unknown }).timeoutMs ?? 600_000);
    const cwdAbs = path.join(projectDir, exec.cwd);
    // 与 workspace.exec 同一坑同一修法：cmd 不搜当前目录，cwd 下有同名 .cmd 就补 ".\"
    const isWin = process.platform === "win32";
    const bare = /\.(cmd|bat)$/i.test(exec.command) && !exec.command.includes("\\") && !exec.command.includes("/");
    const resolved = isWin && bare && fs.existsSync(path.join(cwdAbs, exec.command))
        ? `.\\${exec.command}` : exec.command;
    const argv = isWin && /\.(cmd|bat)$/i.test(resolved)
        ? ["cmd", "/c", resolved, ...exec.args]
        : [exec.command, ...exec.args];

    const startedAt = Date.now();
    let timedOut = false;
    const proc = Bun.spawn(argv, {
        cwd: cwdAbs,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
    });
    const timer = setTimeout(() => { timedOut = true; proc.kill(); }, timeoutMs);

    const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    clearTimeout(timer);
    const finishedAt = Date.now();

    return {
        check: p.check, command: exec.command, args: exec.args, resolvedBy: exec.resolvedBy,
        cwd: exec.cwd, startedAt, finishedAt,
        exitCode: timedOut ? null : exitCode,
        stdout, stderr, timedOut, durationMs: finishedAt - startedAt,
    };
}

/** 按任务包声明顺序全部跑完；返回证据 + 首个失败 + 被跳过的项 */
export async function runAcceptanceChecks(
    projectDir: string, checks: AcceptanceCheck[], acceptanceHash: string,
): Promise<Verdict> {
    const results: CheckExec[] = [];
    const skipped: SkippedCheck[] = [];

    for (const c of checks) {
        const id = String((c as unknown as { id?: unknown }).id ?? "?");
        const prepared = prepareCheck(projectDir, c as AcceptanceCheck & { id: string });
        if (!prepared.exec) {
            skipped.push({ checkId: id, kind: prepared.skipKind, reason: prepared.skipReason });
            console.warn(`[test-agent] ⏭ ${id} 跳过：${prepared.skipReason}`);
            continue;
        }
        console.log(`[test-agent] ▶ ${id}: ${prepared.exec.command} ${prepared.exec.args.join(" ")}  (cwd=${prepared.exec.cwd}, by=${prepared.exec.resolvedBy})`);
        const r = await runPrepared(projectDir, prepared);
        const mark = r.exitCode === 0 && !r.timedOut ? "✅" : "❌";
        console.log(`[test-agent] ${mark} ${id} exit=${String(r.exitCode)} ${r.durationMs}ms${r.timedOut ? " [超时]" : ""}`);
        results.push(r);
        // 短路：首个失败即定论，后面的重构建不白跑（修复回路更快也更省）
        if (r.exitCode !== 0 || r.timedOut) break;
    }

    const evidence: VerificationEvidence[] = results.map((r) => ({
        checkId: r.check.id,
        command: r.command,
        args: r.args,
        cwd: r.cwd,
        exitCode: r.exitCode ?? -1,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        inputHash: hashOf({ acceptanceHash, checkId: r.check.id, command: r.command, cwd: r.cwd }),
        stdoutHash: hashOf(r.stdout),
        stderrHash: hashOf(r.stderr),
    }));

    return {
        evidence,
        firstFailure: results.find((r) => r.exitCode !== 0 || r.timedOut) ?? null,
        results,
        skipped,
    };
}

/** 失败分类：显式 category 优先，其次意图的 kind；缺省 COMPILE */
export function categoryOf(check: AcceptanceCheck): TestFailureCategory {
    const c = check as { category?: string; kind?: string };
    for (const k of [c.category, c.kind]) {
        if (k === "COMPILE" || k === "BOOT" || k === "MIGRATION" || k === "CONTRACT" || k === "RENDER" || k === "ENV") return k;
    }
    return "COMPILE";
}

/** 失败签名：同类同错必须得到同一个值（重复失败自动停止靠它） */
export function failureSignatureOf(r: CheckExec): string {
    const err = `${r.stderr}\n${r.stdout}`
        .split(/\r?\n/)
        .filter((l) => /error|fail|cannot|未找|错误/i.test(l))
        .slice(0, 8)
        .join("\n");
    return hashOf({ checkId: r.check.id, exit: r.exitCode, err });
}
