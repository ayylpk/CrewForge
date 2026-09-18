// ============================================================
// eval/harness/runPipeline.ts —— 驱动【当前旧系统】跑一个项目（零改写控制流）
//
//   只做三件事：注入环境变量 → 起 bun projectRunner.ts <projectId> → 落 stdout/stderr/退出码。
//   不 patch 任何引擎代码；失败就是失败，超时就写超时。
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { killTree, tail } from "./exec";
import { readProjectState } from "./provision";
import type { PipelineRunRecord } from "./types";

export interface RunPipelineOpts {
    projectId: number;
    agentsDir: string;
    runsRoot: string;
    logDir: string;
    timeoutMs: number;
    bunCmd: string;
    label: string;
    /** ★ 阶段 1：冻结场景规格文件（expected.json）—— 引擎的验收 IR 从这里生成，不再用内置默认码 */
    acceptanceSpec?: string | null;
    /** ★ 阶段 1：数据库落库方式（host=宿主 MySQL 验证） */
    verifyDbMode?: "docker" | "host" | "auto";
}

function parseVerifyReport(file: string): { outcome: string | null; summary: string | null } {
    try {
        const text = fs.readFileSync(file, "utf-8");
        const outcome = /^- 结论：(.+)$/m.exec(text)?.[1]?.trim() ?? null;
        const summary = /^- 摘要：(.+)$/m.exec(text)?.[1]?.trim() ?? null;
        return { outcome, summary };
    } catch { return { outcome: null, summary: null }; }
}

export async function runPipeline(o: RunPipelineOpts): Promise<PipelineRunRecord> {
    fs.mkdirSync(o.logDir, { recursive: true });
    const stdoutFile = path.join(o.logDir, "pipeline.stdout.log");
    const stderrFile = path.join(o.logDir, "pipeline.stderr.log");
    const startedAt = new Date().toISOString();
    const t0 = Date.now();

    const args = ["run", "projectRunner.ts", String(o.projectId)];
    const command = `${o.bunCmd} ${args.join(" ")}`;
    fs.writeFileSync(stdoutFile, `# ${command}\ncwd=${o.agentsDir}\nstartedAt=${startedAt}\n# env: PROJECT_ID=${o.projectId} AUTO_CONFIRM=1 RUNS_ROOT=${o.runsRoot} CF_ACCEPTANCE_SPEC=${o.acceptanceSpec ?? "(none)"} CF_VERIFY_DB_MODE=${o.verifyDbMode ?? "(default)"}\n\n`, "utf-8");
    fs.writeFileSync(stderrFile, `# ${command}\ncwd=${o.agentsDir}\nstartedAt=${startedAt}\n\n`, "utf-8");

    const outStream = fs.createWriteStream(stdoutFile, { flags: "a" });
    const errStream = fs.createWriteStream(stderrFile, { flags: "a" });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = spawn(o.bunCmd, args, {
        cwd: o.agentsDir,
        windowsHide: true,
        env: {
            ...process.env,
            PROJECT_ID: String(o.projectId),
            AUTO_CONFIRM: "1",
            RUNS_ROOT: o.runsRoot,
            ...(o.acceptanceSpec ? { CF_ACCEPTANCE_SPEC: o.acceptanceSpec } : {}),
            ...(o.verifyDbMode ? { CF_VERIFY_DB_MODE: o.verifyDbMode } : {}),
        },
    });

    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, o.timeoutMs);

    const exitCode: number | null = await new Promise(resolve => {
        child.stdout?.on("data", (d: Buffer) => { stdout += d.toString("utf-8"); outStream.write(d); });
        child.stderr?.on("data", (d: Buffer) => { stderr += d.toString("utf-8"); errStream.write(d); });
        child.on("error", (e: Error) => { stderr += `\n[harness] spawn error: ${e.message}\n`; resolve(-1); });
        child.on("close", (code: number | null) => resolve(code ?? (timedOut ? 124 : -1)));
    });
    clearTimeout(timer);
    if (timedOut) killTree(child.pid);
    outStream.end(); errStream.end();

    const finishedAt = new Date().toISOString();
    const projectDir = path.join(o.runsRoot, `p${o.projectId}`);
    const reportFile = path.join(projectDir, "_verify", "run-report.md");
    const vr = fs.existsSync(reportFile) ? parseVerifyReport(reportFile) : { outcome: null, summary: null };

    let state: Awaited<ReturnType<typeof readProjectState>> | null = null;
    try { state = await readProjectState(o.projectId); } catch { state = null; }

    return {
        projectId: o.projectId,
        command,
        cwd: o.agentsDir,
        startedAt,
        finishedAt,
        durationMs: Date.now() - t0,
        exitCode,
        timedOut,
        termination: timedOut ? "timeout" : null,
        stdoutFile,
        stderrFile,
        stdoutBytes: Buffer.byteLength(stdout, "utf-8"),
        stdoutTail: tail(stdout, 25, 3000),
        stderrTail: tail(stderr, 15, 2000),
        retries: null,
        tokenUsage: {
            available: false,
            note: "旧系统运行路径未统计 token（sys_settings 无 token 计数、日志不含 usage 字段）——本字段如实置空，不编造 0",
            promptTokens: null, completionTokens: null, totalTokens: null,
        },
        dbFinalStatus: state?.status ?? null,
        dbTasks: state?.tasks ?? { total: 0, done: 0, failed: 0, todo: 0, running: 0 },
        verifyReportFile: fs.existsSync(reportFile) ? reportFile : null,
        verifyOutcome: vr.outcome,
        verifySummary: vr.summary,
    };
}

/**
 * 人工终止后重建 pipeline 记录。
 * 用途：长跑场景在"失败居多、必须止损"时被人工杀掉——此时进程没有自然退出，
 * 但**已经产生的日志与落库状态**仍是可复核的证据。本函数把现场如实转成记录：
 * exitCode=null、termination=manual（绝不假装它是 pass 或 fail 的判定来源）。
 */
export async function adoptPipelineRecord(o: {
    projectId: number; agentsDir: string; runsRoot: string; logDir: string; bunCmd: string; reason: string;
}): Promise<PipelineRunRecord> {
    const stdoutFile = path.join(o.logDir, "pipeline.stdout.log");
    const stderrFile = path.join(o.logDir, "pipeline.stderr.log");
    const readSafe = (p: string) => { try { return fs.readFileSync(p, "utf-8"); } catch { return ""; } };
    const stdout = readSafe(stdoutFile);
    const stderr = readSafe(stderrFile);

    const startedAt = /^startedAt=(.+)$/m.exec(stdout)?.[1]?.trim() ?? new Date().toISOString();
    const finishedAt = new Date().toISOString();
    const durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
    const marker = `\n\n## [harness] 人工终止：${o.reason}\n## 终止时间=${finishedAt}；本记录 exitCode=null（进程未自然退出），termination=manual\n`;
    try { fs.appendFileSync(stdoutFile, marker, "utf-8"); } catch { /* ignore */ }
    try { fs.appendFileSync(stderrFile, marker, "utf-8"); } catch { /* ignore */ }

    const projectDir = path.join(o.runsRoot, `p${o.projectId}`);
    const reportFile = path.join(projectDir, "_verify", "run-report.md");
    const vr = fs.existsSync(reportFile) ? parseVerifyReport(reportFile) : { outcome: null, summary: null };
    let state: Awaited<ReturnType<typeof readProjectState>> | null = null;
    try { state = await readProjectState(o.projectId); } catch { state = null; }

    return {
        projectId: o.projectId,
        command: `${o.bunCmd} run projectRunner.ts ${o.projectId}（人工终止）`,
        cwd: o.agentsDir,
        startedAt,
        finishedAt,
        durationMs,
        exitCode: null,
        timedOut: false,
        termination: "manual",
        stdoutFile, stderrFile,
        stdoutBytes: Buffer.byteLength(stdout, "utf-8"),
        stdoutTail: tail(stdout, 25, 3000),
        stderrTail: tail(stderr, 15, 2000),
        retries: null,
        tokenUsage: {
            available: false,
            note: "旧系统运行路径未统计 token；本轮为人工终止，记录到此为止——不编造数字",
            promptTokens: null, completionTokens: null, totalTokens: null,
        },
        dbFinalStatus: state?.status ?? null,
        dbTasks: state?.tasks ?? { total: 0, done: 0, failed: 0, todo: 0, running: 0 },
        verifyReportFile: fs.existsSync(reportFile) ? reportFile : null,
        verifyOutcome: vr.outcome,
        verifySummary: vr.summary,
    };
}

/** 统计旧系统在日志里的"重试/返工"痕迹（机器信号：日志行计数，不参与判定，只作观测） */export function countRetrySignals(stdoutFile: string): { revisions: number; failures: number; note: string } {
    try {
        const text = fs.readFileSync(stdoutFile, "utf-8");
        const revisions = (text.match(/revision/gi) ?? []).length;
        const failures = (text.match(/\[FAIL\]|测试未通过|失败/g) ?? []).length;
        return { revisions, failures, note: "基于日志关键词的观测计数（非判定依据）" };
    } catch {
        return { revisions: 0, failures: 0, note: "日志不可读" };
    }
}
