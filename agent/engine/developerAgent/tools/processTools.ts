// tools/processTools.ts —— 长驻服务三件套：startProcess / readProcess / stopProcess
//
//   为什么要三个而不是一个 runBuild 类的"一次性"工具：
//   本地服务是**跨工具调用**存在的。Developer 需要：
//     起服务 → 打接口/看日志 → 再改代码 → 再看日志 → 停服务
//   如果每次都重新 start，端口会冲突、日志会丢、进程会越堆越多。
//
//   所以：
//     · startProcess 只起一次，返回 processId；
//     · readProcess **只读增量**（游标在 ProcessManager 里），不重跑命令；
//     · stopProcess 杀整棵进程树；任务结束/取消/崩溃恢复也会统一清理。
//
//   启动、轮询、停止三类动作都会经 workspace.sandbox 落 Ledger（process_* 事件）。
import { num, str, strList } from "./registry";
import type { ToolContext, ToolResult, ToolSpec } from "./registry";

/** startProcess 起完之后最多等多久看它是否"活着" */
const DEFAULT_LIVENESS_WAIT_MS = 800;

/** 隔离程度自述：每条工具结果都要能回答"这是不是真的隔离了" */
function isolationFlags(ctx: ToolContext): Record<string, unknown> {
    const caps = ctx.workspace.sandboxCapabilities;
    return {
        realIsolation: caps.realIsolation,
        softIsolation: caps.softIsolation,
        sandboxMode: caps.mode,
        sandboxBackend: caps.backend,
    };
}

export const startProcessTool: ToolSpec = {
    name: "startProcess",
    description: "启动一个长期运行的服务/进程（不阻塞），返回 processId；之后用 readProcess 读增量日志、stopProcess 终止。任务结束/取消/崩溃恢复时会自动清理。",
    parameters: {
        command: { type: "string", required: true, description: "可执行文件，如 npm / node / ./mvnw" },
        args: { type: "array", required: false, description: "参数数组" },
        cwd: { type: "string", required: false, description: "工作目录（相对项目根），默认项目根" },
        label: { type: "string", required: false, description: "人类可读标签，如 frontend-dev-server" },
        waitMs: { type: "number", required: false, description: "等待毫秒数，观察进程是否立刻退出，默认 800" },
    },
    async run(ctx: ToolContext, args): Promise<ToolResult> {
        const command = str(args, "command");
        if (!command) return { ok: false, output: "command 不能为空" };
        const argv = strList(args, "args");
        const cwd = str(args, "cwd") || undefined;
        const label = str(args, "label") || undefined;
        const waitMs = num(args, "waitMs", DEFAULT_LIVENESS_WAIT_MS);

        let proc;
        try {
            proc = ctx.workspace.startProcess(command, argv, { cwd, label }, { owner: ctx.owner, taskId: ctx.taskId });
        } catch (e) {
            return {
                ok: false,
                output: `启动失败：${(e as Error).message}`,
                rejected: { code: "PROCESS_START_FAILED", target: command, message: (e as Error).message },
            };
        }

        // 等一下再返回：起手就崩（端口占用/命令不存在）应该在这次调用里就被看见，
        // 而不是让模型拿个 processId 去读空气。
        await new Promise((r) => setTimeout(r, Math.max(0, Math.min(waitMs, 5_000))));
        const current = ctx.workspace.sandbox.listProcesses(ctx.taskId)
            .find((p) => p.processId === proc.processId) ?? proc;
        const head = current.status === "running"
            ? `已启动：processId=${current.processId} pid=${current.pid}（${label ?? command}）`
            : `进程已退出：processId=${current.processId} status=${current.status} exitCode=${current.exitCode}`;
        return {
            ok: current.status === "running",
            output: [head, current.stdout.trim(), current.stderr.trim()].filter(Boolean).join("\n"),
            meta: {
                processId: current.processId, pid: current.pid, status: current.status,
                exitCode: current.exitCode, cwd: current.cwd, command: current.command, args: current.args,
                stdoutOffset: current.stdout.length, stderrOffset: current.stderr.length,
                ...isolationFlags(ctx),
            },
        };
    },
};

export const readProcessTool: ToolSpec = {
    name: "readProcess",
    description: "读取指定进程**新增**的 stdout/stderr（增量，不重跑命令）。可反复轮询；进程已退出时同时返回退出码。",
    parameters: {
        processId: { type: "string", required: true, description: "startProcess 返回的 processId" },
        sinceStdout: { type: "number", required: false, description: "从哪个 stdout 游标开始读（默认继上次）" },
        sinceStderr: { type: "number", required: false, description: "从哪个 stderr 游标开始读（默认继上次）" },
    },
    async run(ctx: ToolContext, args): Promise<ToolResult> {
        const processId = str(args, "processId");
        if (!processId) return { ok: false, output: "processId 不能为空" };
        const since: { stdout?: number; stderr?: number } = {};
        if (args["sinceStdout"] !== undefined) since.stdout = num(args, "sinceStdout", 0);
        if (args["sinceStderr"] !== undefined) since.stderr = num(args, "sinceStderr", 0);

        let delta;
        try {
            delta = ctx.workspace.readProcess(processId, since);
        } catch (e) {
            return { ok: false, output: `读取失败：${(e as Error).message}` };
        }
        const head = `[readProcess ${processId}] status=${delta.status}`
            + ` exitCode=${delta.exitCode ?? "-"} alive=${delta.alive}`
            + (delta.truncated ? ` [输出截断，原始输出：${delta.rawLogPath ?? "(未落盘)"}]` : "");
        const newOut = delta.stdout.length;
        const newErr = delta.stderr.length;
        return {
            ok: true,
            output: [
                head,
                `新增输出：stdout ${newOut} 字符 / stderr ${newErr} 字符`,
                delta.stdout.trim(), delta.stderr.trim(),
            ].filter(Boolean).join("\n"),
            meta: {
                processId, status: delta.status, alive: delta.alive, exitCode: delta.exitCode,
                stdoutOffset: delta.stdoutOffset, stderrOffset: delta.stderrOffset,
                newStdoutChars: newOut, newStderrChars: newErr,
                truncated: delta.truncated, rawOutputPath: delta.rawLogPath,
                ...isolationFlags(ctx),
            },
        };
    },
};

export const stopProcessTool: ToolSpec = {
    name: "stopProcess",
    description: "终止指定进程及其子进程（Windows 用 taskkill /T，Unix 用进程组）。返回实际生效的终止手段。",
    parameters: {
        processId: { type: "string", required: true, description: "startProcess 返回的 processId" },
    },
    async run(ctx: ToolContext, args): Promise<ToolResult> {
        const processId = str(args, "processId");
        if (!processId) return { ok: false, output: "processId 不能为空" };
        let stopped;
        try {
            stopped = await ctx.workspace.stopProcess(processId);
        } catch (e) {
            return { ok: false, output: `停止失败：${(e as Error).message}` };
        }
        return {
            ok: stopped.status !== "running",
            output: `[stopProcess ${processId}] status=${stopped.status} killMethod=${stopped.killMethod}`
                + ` exitCode=${stopped.exitCode ?? "-"}`,
            meta: {
                processId, status: stopped.status, killMethod: stopped.killMethod,
                killedBy: stopped.killedBy, exitCode: stopped.exitCode, pid: stopped.pid,
                ...isolationFlags(ctx),
            },
        };
    },
};
