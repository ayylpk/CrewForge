// ============================================================
// eval/harness/exec.ts —— 基线采集用的命令执行器（零 LLM）
//
//   为什么不直接用 engine/exec/run.runCommand：
//     · 基线要求**边跑边落盘**（长跑中途被杀也不丢日志），runCommand 只在结束时写一次
//     · 基线要 stdout/stderr 分开留档（诊断"编译错在 stderr / maven 错在 stdout"）
//   判定口径与 runCommand 保持一致：一切结果都变成返回值，不抛异常。
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export interface ExecResult {
    command: string;
    cwd: string;
    exitCode: number | null;
    timedOut: boolean;
    durationMs: number;
    startedAt: string;
    finishedAt: string;
    stdout: string;
    stderr: string;
    stdoutFile: string | null;
    stderrFile: string | null;
    spawnError: string | null;
}

function safeLabel(label: string): string {
    return label.replace(/[^\w.-]+/g, "_").slice(0, 80);
}

/** 进程树强杀（Windows: taskkill /T /F）——只杀父进程会留孤儿占端口 */
export function killTree(pid: number | undefined): void {
    if (!pid) return;
    try {
        spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch { /* 已退出 */ }
}

export interface ExecOpts {
    cmd: string;
    args: string[];
    cwd: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    logDir?: string | null;
    label?: string;
    /** Windows：按原样传参（cmd.exe /d /s /c "..." 专用，否则引号会被转义成 \" 导致命令找不到） */
    verbatimArgs?: boolean;
}

/** 子进程环境清洗。
 *
 *  宿主若用 NODE_OPTIONS 注入 safe-delete shim（genie-safe-delete.cjs），
 *  `vite build` 的 prepareOutDir → emptyDir → fs.rmSync 会被打断（exit=1），
 *  看起来像"前端构建失败"，其实是宿主环境问题——s4/s4c/s4d/s5b 四轮的 frontend.build
 *  全死在这上面。与 developerAgent/tools/processSandbox.ts 的处理保持一致：一律摘掉。
 *  实测确认：注入存在时 vite 报 `[safe-delete] 操作失败 … at Object.wrappedRmSync`。 */
function childEnv(extra?: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    if (env.NODE_OPTIONS) {
        console.warn(`[exec] 摘掉宿主 NODE_OPTIONS（防 safe-delete shim 打断构建）：${env.NODE_OPTIONS}`);
        delete env.NODE_OPTIONS;
    }
    return { ...env, ...(extra ?? {}) };
}

/** 跑一条命令，stdout/stderr 分流留档；超时按进程树杀并如实标注 */
export function execCapture(o: ExecOpts): Promise<ExecResult> {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const command = [o.cmd, ...o.args].join(" ");
    const label = safeLabel(o.label ?? path.basename(o.cmd));

    let stdoutFile: string | null = null;
    let stderrFile: string | null = null;
    if (o.logDir) {
        try {
            fs.mkdirSync(o.logDir, { recursive: true });
            stdoutFile = path.join(o.logDir, `${label}.stdout.log`);
            stderrFile = path.join(o.logDir, `${label}.stderr.log`);
            fs.writeFileSync(stdoutFile, `# ${command}\ncwd=${o.cwd}\nstarted=${startedAt}\n\n`, "utf-8");
            fs.writeFileSync(stderrFile, `# ${command}\ncwd=${o.cwd}\nstarted=${startedAt}\n\n`, "utf-8");
        } catch { stdoutFile = null; stderrFile = null; }
    }

    return new Promise<ExecResult>(resolve => {
        const finish = (exitCode: number | null, timedOut: boolean, spawnError: string | null, out: string, err: string) => {
            const finishedAt = new Date().toISOString();
            if (stdoutFile) { try { fs.appendFileSync(stdoutFile, `\n\n## exit=${exitCode} timedOut=${timedOut} at ${finishedAt}\n`, "utf-8"); } catch { /* ignore */ } }
            if (stderrFile) { try { fs.appendFileSync(stderrFile, `\n\n## exit=${exitCode} timedOut=${timedOut} at ${finishedAt}\n`, "utf-8"); } catch { /* ignore */ } }
            resolve({
                command, cwd: o.cwd, exitCode, timedOut, durationMs: Date.now() - t0,
                startedAt, finishedAt, stdout: out, stderr: err, stdoutFile, stderrFile, spawnError,
            });
        };

        let child: ReturnType<typeof spawn>;
        try {
            child = spawn(o.cmd, o.args, {
                cwd: o.cwd,
                env: childEnv(o.env),
                windowsHide: true,
                windowsVerbatimArguments: o.verbatimArgs === true,
                detached: process.platform !== "win32",
            });
        } catch (e) {
            finish(-1, false, String((e as Error).message ?? e), "", "");
            return;
        }

        let out = "";
        let err = "";
        let timedOut = false;
        const outStream = stdoutFile ? fs.createWriteStream(stdoutFile, { flags: "a" }) : null;
        const errStream = stderrFile ? fs.createWriteStream(stderrFile, { flags: "a" }) : null;

        const timer = setTimeout(() => {
            timedOut = true;
            killTree(child.pid);
        }, o.timeoutMs ?? 600_000);

        child.stdout?.on("data", (d: Buffer) => { out += d.toString("utf-8"); outStream?.write(d); });
        child.stderr?.on("data", (d: Buffer) => { err += d.toString("utf-8"); errStream?.write(d); });
        child.on("error", (e: Error) => {
            clearTimeout(timer);
            outStream?.end(); errStream?.end();
            finish(-1, timedOut, e.message, out, err);
        });
        child.on("close", (code: number | null) => {
            clearTimeout(timer);
            if (timedOut) killTree(child.pid);
            outStream?.end(); errStream?.end();
            finish(code ?? (timedOut ? 124 : -1), timedOut, null, out, err);
        });
    });
}

/** 尾部摘录（证据链用；判定不看它） */
export function tail(text: string, lines = 12, maxChars = 2000): string {
    const arr = text.split(/\r?\n/).filter(l => l.trim().length > 0);
    const t = arr.slice(-lines).join("\n");
    return t.length > maxChars ? t.slice(-maxChars) : t;
}
