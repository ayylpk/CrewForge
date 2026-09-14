// tools/shell.ts —— 执行完整 shell 命令字符串（Claude Code 式）
//
//   「命令自由 + 环境隔离」：这里不判断"能不能跑这条命令"，
//   只负责把整串命令交给正确的 shell，剩下的边界由 processSandbox 负责。
//     Windows → cmd /c "<cmd>"（或显式指定 powershell）
//     Unix    → sh -lc "<cmd>"
//
//   注意：软档下 shell 字符串能做的事比结构化命令多得多（管道、重定向、
//   命令串联）。这正是要的——但也是"cwd 不是沙箱"这句提醒最适用的地方。
import { num, str } from "./registry";
import type { ToolContext, ToolResult, ToolSpec } from "./registry";

const IS_WIN = process.platform === "win32";

export type ShellKind = "auto" | "cmd" | "powershell" | "sh";

export interface ShellInvocation {
    command: string;
    args: string[];
    shell: Exclude<ShellKind, "auto">;
}

/** 选 shell 并组装 argv（纯函数，便于单测） */
export function resolveShell(command: string, kind: ShellKind = "auto"): ShellInvocation {
    const picked: Exclude<ShellKind, "auto"> = kind === "auto"
        ? (IS_WIN ? "cmd" : "sh")
        : kind;
    if (picked === "powershell") {
        return {
            command: IS_WIN ? "powershell" : "pwsh",
            args: ["-NoLogo", "-NonInteractive", "-Command", command],
            shell: "powershell",
        };
    }
    if (picked === "cmd") {
        return { command: "cmd", args: ["/c", command], shell: "cmd" };
    }
    return { command: "sh", args: ["-lc", command], shell: "sh" };
}

export const shellTool: ToolSpec = {
    name: "shell",
    description: "在生成项目内执行完整 shell 命令字符串（支持管道/重定向/串联；Windows 用 cmd /c 或 PowerShell，Unix 用 sh -lc）。命令自由，但环境受隔离边界约束。",
    parameters: {
        command: { type: "string", required: true, description: "完整 shell 命令字符串，如 `npm run build 2>&1 | tail -50`" },
        cwd: { type: "string", required: false, description: "工作目录（相对项目根），默认项目根" },
        shell: { type: "string", required: false, description: "auto | cmd | powershell | sh，默认 auto" },
        timeoutMs: { type: "number", required: false, description: "超时毫秒数，默认 120000" },
        timeoutReason: { type: "string", required: false, description: "延长超时时必须写明原因（会记入 Ledger）" },
    },
    async run(ctx: ToolContext, args): Promise<ToolResult> {
        const command = str(args, "command");
        if (!command.trim()) return { ok: false, output: "command 不能为空" };
        const kind = str(args, "shell") as ShellKind;
        if (!["auto", "cmd", "powershell", "sh", ""].includes(kind)) {
            return { ok: false, output: `shell 只支持 auto | cmd | powershell | sh，收到：${kind}` };
        }
        const invoke = resolveShell(command, kind || "auto");
        const cwd = str(args, "cwd") || undefined;
        const timeoutMs = num(args, "timeoutMs", 120_000);

        const r = await ctx.workspace.exec(
            invoke.command, invoke.args,
            { cwd, timeoutMs, label: "shell" },
            { owner: ctx.owner, taskId: ctx.taskId },
        );
        const head = `$ [shell:${invoke.shell}] ${command}   (cwd=${r.cwd}) → exit=${r.exitCode}${r.timedOut ? " [超时]" : ""} (${r.durationMs}ms)` +
            (r.truncated ? ` [输出截断，原始输出：${r.rawOutputPath ?? "(未落盘)"}]` : "");
        const failed: string[] = (r.violations ?? []).map((v) => `[${v.code}] ${v.message}`);
        return {
            ok: r.exitCode === 0 && !r.timedOut && (r.violations ?? []).length === 0,
            output: [head, r.stdout.trim(), r.stderr.trim(), ...failed].filter(Boolean).join("\n"),
            meta: {
                shell: invoke.shell, command: invoke.command, args: invoke.args, cwd: r.cwd,
                exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs,
                stdout: r.stdout, stderr: r.stderr,
                truncated: r.truncated ?? false, rawOutputPath: r.rawOutputPath ?? null,
                processId: r.processId ?? null, pid: r.pid ?? null,
                killedBy: r.killedBy ?? "none", killMethod: r.killMethod ?? "none",
                snapshotBefore: r.snapshotBefore ?? null, snapshotAfter: r.snapshotAfter ?? null,
                violations: r.violations ?? [],
                realIsolation: r.realIsolation,
                softIsolation: r.softIsolation,
                sandboxMode: r.sandboxMode,
                sandboxBackend: r.sandboxBackend,
            },
        };
    },
};
