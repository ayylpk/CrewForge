// ============================================================
// run.ts —— 通用命令执行（exec 层，零 LLM）
//
//   三条硬要求（都由实测踩出来）：
//     ① **进程树杀**：Windows 上 mvnw/vite 会 fork 子进程，只杀父进程会留孤儿占住端口，
//        下一次验证就会以"端口被占用"的形式误判成 ENV，进而死循环（taskkill /T /F）
//     ② 日志留档：判定只能来自"命令 + 退出码"，原始日志是审计材料
//     ③ 超时必须有结论：超时=失败类之一，不许静默挂死
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export interface RunResult {
    cmd: string;
    exitCode: number;
    output: string;
    durationMs: number;
    timedOut: boolean;
    logFile: string | null;
    spawnError?: string;
}

export interface RunOpts {
    cwd: string;
    timeoutMs?: number;
    env?: Record<string, string>;
    /** 日志留档目录；给了就写 <label>.log */
    logDir?: string;
    label?: string;
}

/** 子进程树强杀：Windows 用 taskkill /T /F；其它平台用 SIGKILL 进程组 */
export function killTree(pid: number | undefined): void {
    if (!pid) return;
    try {
        if (process.platform === "win32") {
            spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        } else {
            process.kill(-pid, "SIGKILL");
        }
    } catch { /* 进程可能已退出 */ }
}

/**
 * 跑一条命令并等它结束。**不抛异常**——一切结果（含超时/找不到命令）都变成返回值，
 * 由调用方按失败类分流（不变量 1：判定来自命令 + 退出码）。
 */
export function runCommand(cmd: string, args: string[], opts: RunOpts): Promise<RunResult> {
    const t0 = Date.now();
    const label = opts.label ?? path.basename(cmd);
    return new Promise<RunResult>(resolve => {
        let child: ReturnType<typeof spawn>;
        try {
            child = spawn(cmd, args, {
                cwd: opts.cwd,
                env: { ...process.env, ...(opts.env ?? {}) },
                windowsHide: true,
                detached: process.platform !== "win32",   // 非 Windows 起进程组，便于整树杀
            });
        } catch (e) {
            resolve({ cmd: `${cmd} ${args.join(" ")}`, exitCode: -1, output: "", durationMs: 0, timedOut: false, logFile: null, spawnError: String((e as Error).message ?? e) });
            return;
        }
        let out = "";
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            killTree(child.pid);
        }, opts.timeoutMs ?? 600_000);

        child.stdout?.on("data", (d: Buffer) => { out += d.toString("utf-8"); });
        child.stderr?.on("data", (d: Buffer) => { out += d.toString("utf-8"); });
        child.on("error", (e: Error) => {
            clearTimeout(timer);
            resolve({ cmd: `${cmd} ${args.join(" ")}`, exitCode: -1, output: out, durationMs: Date.now() - t0, timedOut, logFile: writeLog(), spawnError: e.message });
        });
        child.on("close", (code: number | null) => {
            clearTimeout(timer);
            if (timedOut) killTree(child.pid);       // 收尾再杀一次，防 fork 出的子进程漏网
            resolve({
                cmd: `${cmd} ${args.join(" ")}`,
                exitCode: code ?? (timedOut ? 124 : -1),
                output: out,
                durationMs: Date.now() - t0,
                timedOut,
                logFile: writeLog(),
            });
        });

        function writeLog(): string | null {
            if (!opts.logDir) return null;
            try {
                fs.mkdirSync(opts.logDir, { recursive: true });
                const p = path.join(opts.logDir, `${label.replace(/[^\w.-]+/g, "_")}.log`);
                fs.writeFileSync(p, `# ${cmd} ${args.join(" ")}\ncwd=${opts.cwd}\n\n${out}`, "utf-8");
                return p;
            } catch { return null; }
        }
    });
}

/** 命令是否存在（探测用） */
export function commandExists(cmd: string): boolean {
    try {
        const r = require("node:child_process").spawnSync(cmd, ["--version"], { stdio: "ignore", timeout: 8000 });
        return r.status === 0 || r.status === 1;      // 有些工具 --version 返回 1
    } catch { return false; }
}
