// ============================================================
// tools/processManager.ts —— 长驻进程的登记、增量读取与进程树终止
//
//   为什么单独一个文件：Developer 现在是「Claude Code 式」的开发者，可以
//   起本地服务、轮询日志、再停掉。这类**跨工具调用**的进程状态不属于任何
//   单次工具调用，必须有唯一归属地——否则 startProcess 起的东西没人能停。
//
//   本文件负责：
//     · 进程登记（processId / taskId / pid / 状态 / 退出码）
//     · stdout/stderr 的**增量**读取（缓冲区 + 游标，不是每次重跑命令）
//     · 输出上限与截断（超限时原始输出落盘，返回保存位置）
//     · 进程树终止（POSIX 用进程组；Windows 用 taskkill /T，失败降级为 kill(pid)）
//     · maxProcessCount 限制与按任务清理（任务完成 / 取消 / 崩溃恢复）
//
//   ⚠️ 本文件**不负责**隔离。路径、环境、网络、保护路径的边界在
//      processSandbox.ts；这里只做进程生命周期管理。
// ============================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 进程被终止的原因（机器可读，进 Ledger） */
export type KillReason = "none" | "timeout" | "violation" | "stop" | "cleanup";
/** 实际用到的终止手段——Windows 上拿不到 Job Object，只能"尽力杀树" */
export type KillMethod = "none" | "process-group" | "taskkill" | "pid";

export type ProcessStatus = "running" | "exited" | "failed" | "killed";

export interface ProcessEvent {
    kind: "started" | "polled" | "stopped" | "exited" | "cleaned";
    processId: string;
    taskId: string;
    command: string;
    args: string[];
    pid: number | null;
    detail?: Record<string, unknown>;
}

export interface ManagedProcess {
    processId: string;
    taskId: string;
    command: string;
    args: string[];
    cwdAbs: string;
    /** 展示用（相对 projectDir） */
    cwd: string;
    pid: number;
    startedAt: number;
    status: ProcessStatus;
    exitCode: number | null;
    killedBy: KillReason;
    killMethod: KillMethod;
    /** 已被读走的总字节游标 */
    stdout: string;
    stderr: string;
    stdoutBytes: number;
    stderrBytes: number;
    truncated: boolean;
    /** 截断时，原始（未截断）输出的落盘位置 */
    rawLogPath: string | null;
    /** readProcess 被调用的次数（进 Ledger） */
    pollCount: number;
    endedAt: number | null;
    /** 进程还活着时为 true */
    alive: boolean;
}

export interface ReadDelta {
    processId: string;
    status: ProcessStatus;
    /** 自上次读取（或自 offset）以来新增的 stdout */
    stdout: string;
    stderr: string;
    stdoutOffset: number;
    stderrOffset: number;
    truncated: boolean;
    rawLogPath: string | null;
    exitCode: number | null;
    alive: boolean;
}

export interface SpawnSpec {
    taskId: string;
    command: string;
    args: string[];
    cwdAbs: string;
    cwd: string;
    env: Record<string, string>;
    /** 输出上限（每个流各自） */
    maxOutputBytes: number;
    /** 截断时原始输出写到哪 */
    logDir: string;
    label?: string;
}

interface Entry {
    managed: ManagedProcess;
    proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
    stdoutAll: string;
    stderrAll: string;
    stdoutCursor: number;
    stderrCursor: number;
    exited: Promise<void>;
}

export class ProcessLimitError extends Error {
    readonly code = "PROCESS_LIMIT";
    constructor(readonly limit: number, readonly current: number) {
        super(`[PROCESS_LIMIT] 任务内活动进程数已达上限 ${limit}（当前 ${current}）`);
        this.name = "ProcessLimitError";
    }
}

/** 生成可读且唯一的进程 id */
function nextProcessId(seq: number): string {
    return `proc-${process.pid.toString(36)}-${Date.now().toString(36)}-${seq}`;
}

/** 在 Windows 上安全地保留一份完整输出 */
function persistRawOutput(logDir: string, processId: string, stream: string, text: string): string | null {
    try {
        fs.mkdirSync(logDir, { recursive: true });
        const file = path.join(logDir, `${processId}.${stream}.log`);
        fs.writeFileSync(file, text, "utf-8");
        return file;
    } catch {
        return null;
    }
}

export interface ProcessManagerOptions {
    /** 单任务同时活跃的进程数上限 */
    maxProcessCount?: number;
    /** 默认日志目录（截断时原始输出落在这里） */
    logDir?: string;
    /** 进程生命周期事件（外部写 Ledger 用） */
    onEvent?: (ev: ProcessEvent) => void;
    /** 进程树终止的执行器（测试可注入，默认真的杀） */
    killExecutor?: (pid: number) => Promise<KillMethod>;
}

export class ProcessManager {
    private readonly entries = new Map<string, Entry>();
    private readonly maxProcessCount: number;
    private readonly logDir: string;
    private readonly onEvent: ((ev: ProcessEvent) => void) | undefined;
    private readonly killExecutor: ((pid: number) => Promise<KillMethod>) | undefined;
    private seq = 0;

    constructor(opts: ProcessManagerOptions = {}) {
        this.maxProcessCount = opts.maxProcessCount ?? 8;
        this.logDir = opts.logDir ?? path.join(os.tmpdir(), "crewforge-developer-logs");
        this.onEvent = opts.onEvent;
        this.killExecutor = opts.killExecutor;
    }

    /** 当前活跃进程数（可选按任务过滤） */
    activeCount(taskId?: string): number {
        let n = 0;
        for (const e of this.entries.values()) {
            if (taskId !== undefined && e.managed.taskId !== taskId) continue;
            if (e.managed.status === "running") n++;
        }
        return n;
    }

    list(taskId?: string): ManagedProcess[] {
        const out: ManagedProcess[] = [];
        for (const e of this.entries.values()) {
            if (taskId !== undefined && e.managed.taskId !== taskId) continue;
            out.push({ ...e.managed });
        }
        return out;
    }

    get(processId: string): ManagedProcess | null {
        const e = this.entries.get(processId);
        return e ? { ...e.managed } : null;
    }

    /** 起一个进程并登记。超上限直接抛 ProcessLimitError（不静默排队） */
    spawn(spec: SpawnSpec): ManagedProcess {
        const active = this.activeCount(spec.taskId);
        if (active >= this.maxProcessCount) throw new ProcessLimitError(this.maxProcessCount, active);

        const isWin = process.platform === "win32";
        const proc = Bun.spawn([spec.command, ...spec.args], {
            cwd: spec.cwdAbs,
            stdout: "pipe",
            stderr: "pipe",
            env: spec.env,
            // POSIX 下自成进程组，超时才能整组杀掉；Windows 不认这个信号语义
            detached: !isWin,
        });

        const processId = nextProcessId(this.seq++);
        const managed: ManagedProcess = {
            processId,
            taskId: spec.taskId,
            command: spec.command,
            args: spec.args,
            cwdAbs: spec.cwdAbs,
            cwd: spec.cwd,
            pid: proc.pid,
            startedAt: Date.now(),
            status: "running",
            exitCode: null,
            killedBy: "none",
            killMethod: "none",
            stdout: "",
            stderr: "",
            stdoutBytes: 0,
            stderrBytes: 0,
            truncated: false,
            rawLogPath: null,
            pollCount: 0,
            endedAt: null,
            alive: true,
        };

        const entry: Entry = {
            managed,
            proc,
            stdoutAll: "",
            stderrAll: "",
            stdoutCursor: 0,
            stderrCursor: 0,
            exited: Promise.resolve(),
        };

        const pump = async (
            stream: ReadableStream<Uint8Array> | undefined,
            which: "stdout" | "stderr",
        ): Promise<void> => {
            if (!stream) return;
            const reader = stream.getReader();
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (!value) continue;
                    const chunk = Buffer.from(value).toString("utf-8");
                    // 全量留一份（可能很大），对外只暴露上限内的切片
                    if (which === "stdout") entry.stdoutAll += chunk;
                    else entry.stderrAll += chunk;
                    const all = which === "stdout" ? entry.stdoutAll : entry.stderrAll;
                    const cut = all.slice(0, spec.maxOutputBytes);
                    if (which === "stdout") {
                        managed.stdout = cut;
                        managed.stdoutBytes = Buffer.byteLength(all, "utf-8");
                    } else {
                        managed.stderr = cut;
                        managed.stderrBytes = Buffer.byteLength(all, "utf-8");
                    }
                    if (all.length > cut.length) {
                        managed.truncated = true;
                        if (!managed.rawLogPath) {
                            // 先落一份当前快照（长驻服务被截断时至少要有个抓手）
                            managed.rawLogPath = persistRawOutput(
                                spec.logDir ?? this.logDir, processId, which, all,
                            ) ?? managed.rawLogPath;
                        }
                    }
                }
            } catch {
                // 读流被 kill 打断是正常路径，不往上抛
            } finally {
                try { reader.releaseLock(); } catch { /* 已释放 */ }
            }
        };

        entry.exited = (async () => {
            await Promise.all([pump(proc.stdout as ReadableStream<Uint8Array>, "stdout"),
                pump(proc.stderr as ReadableStream<Uint8Array>, "stderr")]);
            const code = await proc.exited;
            if (managed.status === "running") {
                managed.status = code === 0 ? "exited" : "failed";
                managed.exitCode = code;
            } else {
                managed.exitCode = code;
            }
            managed.alive = false;
            managed.endedAt = Date.now();
            // ★ 截断时**在退出后重写**一份完整输出。
            //   只在 pump 中途写会在"刚超上限"那一刻就落盘，后面还有几千行没进去——
            //   证据不能只留一半。stdout/stderr 一起写，附分隔标记。
            if (managed.truncated) {
                const full = [
                    `# command: ${managed.command} ${managed.args.join(" ")}`,
                    `# cwd: ${managed.cwdAbs}`,
                    `# exitCode: ${managed.exitCode}  killedBy: ${managed.killedBy}  killMethod: ${managed.killMethod}`,
                    `# ---- stdout (${Buffer.byteLength(entry.stdoutAll, "utf-8")} bytes) ----`,
                    entry.stdoutAll,
                    `# ---- stderr (${Buffer.byteLength(entry.stderrAll, "utf-8")} bytes) ----`,
                    entry.stderrAll,
                ].join("\n");
                managed.rawLogPath = persistRawOutput(this.logDir, processId, "full", full)
                    ?? managed.rawLogPath;
            }
            this.emit({
                kind: "exited", processId, taskId: managed.taskId,
                command: managed.command, args: managed.args, pid: managed.pid,
                detail: { exitCode: managed.exitCode, status: managed.status, killedBy: managed.killedBy },
            });
        })();

        this.entries.set(processId, entry);
        this.emit({
            kind: "started", processId, taskId: managed.taskId,
            command: managed.command, args: managed.args, pid: managed.pid,
            detail: { cwd: managed.cwd },
        });
        return { ...managed };
    }

    /** 等进程自然结束（供一次性命令使用） */
    async awaitExit(processId: string): Promise<ManagedProcess> {
        const e = this.entries.get(processId);
        if (!e) throw new Error(`未知进程：${processId}`);
        await e.exited;
        return { ...e.managed };
    }

    /**
     * 增量读取：只返回上次读取之后新增的部分。
     * 传入 sinceStdout/sinceStderr 可显式指定游标（默认用内部游标）。
     */
    read(processId: string, since?: { stdout?: number; stderr?: number }): ReadDelta {
        const e = this.entries.get(processId);
        if (!e) throw new Error(`未知进程：${processId}`);
        const m = e.managed;
        const fromOut = since?.stdout ?? e.stdoutCursor;
        const fromErr = since?.stderr ?? e.stderrCursor;
        const stdout = m.stdout.slice(Math.max(0, fromOut));
        const stderr = m.stderr.slice(Math.max(0, fromErr));
        e.stdoutCursor = m.stdout.length;
        e.stderrCursor = m.stderr.length;
        m.pollCount++;
        this.emit({
            kind: "polled", processId, taskId: m.taskId,
            command: m.command, args: m.args, pid: m.pid,
            detail: { stdoutBytes: stdout.length, stderrBytes: stderr.length, status: m.status },
        });
        return {
            processId, status: m.status, stdout, stderr,
            stdoutOffset: e.stdoutCursor, stderrOffset: e.stderrCursor,
            truncated: m.truncated, rawLogPath: m.rawLogPath,
            exitCode: m.exitCode, alive: m.status === "running",
        };
    }

    /** 终止单个进程（含子进程，尽力而为） */
    async stop(processId: string, reason: KillReason = "stop"): Promise<ManagedProcess> {
        const e = this.entries.get(processId);
        if (!e) throw new Error(`未知进程：${processId}`);
        const m = e.managed;
        if (m.status !== "running") return { ...m };
        m.killedBy = reason;
        m.killMethod = await this.killTree(m.pid);
        m.status = "killed";
        m.alive = false;
        m.endedAt = Date.now();
        this.emit({
            kind: "stopped", processId, taskId: m.taskId,
            command: m.command, args: m.args, pid: m.pid,
            detail: { reason, killMethod: m.killMethod },
        });
        return { ...m };
    }

    /** 终止一个任务下的全部进程（任务完成 / 取消 / 崩溃恢复） */
    async cleanupTaskProcesses(taskId: string, reason: KillReason = "cleanup"): Promise<ManagedProcess[]> {
        const ids = [...this.entries.values()]
            .filter((e) => e.managed.taskId === taskId && e.managed.status === "running")
            .map((e) => e.managed.processId);
        const done: ManagedProcess[] = [];
        for (const id of ids) done.push(await this.stop(id, reason));
        if (ids.length > 0) {
            this.emit({
                kind: "cleaned", processId: "-", taskId, command: "", args: [], pid: null,
                detail: { count: ids.length, reason },
            });
        }
        return done;
    }

    /** 终止所有登记在册的活动进程（进程退出前的兜底） */
    async cleanupAll(reason: KillReason = "cleanup"): Promise<number> {
        const ids = [...this.entries.values()]
            .filter((e) => e.managed.status === "running")
            .map((e) => e.managed.processId);
        for (const id of ids) await this.stop(id, reason);
        return ids.length;
    }

    /**
     * 进程树终止。
     *   POSIX  → 负 pid 打整个进程组（spawn 时 detached:true 已建组）；
     *   Windows→ taskkill /PID <pid> /T /F；执行器不可用时降级为 kill(pid)。
     * 返回**实际生效**的手段，方便把"只能尽力而为"这件事写进证据。
     */
    async killTree(pid: number): Promise<KillMethod> {
        if (this.killExecutor) return this.killExecutor(pid);
        if (process.platform !== "win32") {
            try {
                process.kill(-pid, "SIGKILL");
                return "process-group";
            } catch {
                try { process.kill(pid, "SIGKILL"); return "pid"; } catch { return "none"; }
            }
        }
        try {
            const r = Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], {
                stdout: "ignore", stderr: "ignore",
            });
            if (r.exitCode === 0) return "taskkill";
        } catch {
            // taskkill 不可用（策略禁用/缺失）→ 降级
        }
        try {
            process.kill(pid);
            return "pid";
        } catch {
            return "none";
        }
    }

    private emit(ev: ProcessEvent): void {
        try { this.onEvent?.(ev); } catch { /* 记账失败不掩盖主流程 */ }
    }
}
