// tools/runCommand.ts —— 执行一次任意可执行程序（command 与 args 分开传递）
//
//   注意（规格二.1）：这里**没有**命令白名单拦截。Developer 可以跑 node / npm /
//   python / java / mvnw / gradle / bun / curl / git / 自定义脚本……
//   边界不在这里，在 processSandbox：环境清洗、cwd 限定、进程树超时终止、
//   输出上限、保护路径监视、网络策略。
//
//   返回的 meta 是**完整原始证据**：command / args / cwd / exitCode / timedOut /
//   durationMs / stdout+stderr（含截断标记与原始输出位置）/ processId /
//   snapshotBefore / snapshotAfter。编译错误、启动错误必须原样传给 Developer。
import { num, str, strList } from "./registry";
import type { ToolContext, ToolResult, ToolSpec } from "./registry";
import { normalizeScaffoldedScripts, summarizeNormalize } from "../scaffoldNormalize";

/** 官方脚手架命令的识别（零 LLM 判定）：npm/pnpm/yarn/bun create|init，以及 create-* 家族。
 *  命中且执行成功后触发产物归一化——见 scaffoldNormalize.ts 的 R5 说明。 */
const SCAFFOLD_CMD_RE = /\b(?:npm|pnpm|yarn|bun)\s+(?:create|init|exec)\b|\bcreate-(?:vite|vue|react-app|next-app|nuxt|svelte)\b/i;

export const runCommandTool: ToolSpec = {
    name: "runCommand",
    description: "在生成项目的隔离环境中执行一次命令（command 与 args 分开）。命令种类不限；返回原始 exitCode / stdout / stderr / 耗时 / 进程与快照证据。",
    parameters: {
        command: { type: "string", required: true, description: "可执行文件，如 node / npm / ./mvnw / python" },
        args: { type: "array", required: false, description: "参数数组（分开传，不要拼成一个字符串）" },
        cwd: { type: "string", required: false, description: "工作目录（相对项目根），默认项目根" },
        timeoutMs: { type: "number", required: false, description: "超时毫秒数，默认 120000" },
        timeoutReason: { type: "string", required: false, description: "延长超时时必须写明原因（会记入 Ledger）" },
    },
    async run(ctx: ToolContext, args): Promise<ToolResult> {
        const command = str(args, "command");
        if (!command) return { ok: false, output: "command 不能为空" };
        const argv = strList(args, "args");
        const cwd = str(args, "cwd") || undefined;
        const timeoutMs = num(args, "timeoutMs", 120_000);

        const r = await ctx.workspace.exec(
            command, argv,
            { cwd, timeoutMs, label: "runCommand" },
            { owner: ctx.owner, taskId: ctx.taskId },
        );
        const head = `$ ${command} ${argv.join(" ")}   (cwd=${r.cwd}) → exit=${r.exitCode}${r.timedOut ? " [超时]" : ""} (${r.durationMs}ms)`
            + (r.truncated ? ` [输出截断，原始输出：${r.rawOutputPath ?? "(未落盘)"}]` : "");
        const violations = r.violations ?? [];
        const violationLines = violations.map((v) => `[${v.code}] ${v.message}`);

        // 脚手架后归一化：`npm create vite` 等生成的 build 脚本形态与引擎骨架不一致（R5），
        // 跑完立刻归一到"build 只构建、type-check 独立"，不等到构建门才发现。
        let normalizeLines: string[] = [];
        if (r.exitCode === 0 && !r.timedOut && ctx.projectDirAbs && SCAFFOLD_CMD_RE.test(`${command} ${argv.join(" ")}`)) {
            try {
                normalizeLines = summarizeNormalize(normalizeScaffoldedScripts(ctx.projectDirAbs), ctx.projectDirAbs);
            } catch (e) {
                normalizeLines = [`[脚手架归一化] 失败（不影响命令本身）：${String((e as Error).message ?? e)}`];
            }
        }
        return {
            ok: r.exitCode === 0 && !r.timedOut && violations.length === 0,
            output: [head, r.stdout.trim(), r.stderr.trim(), ...violationLines, ...normalizeLines].filter(Boolean).join("\n"),
            meta: {
                command, args: argv, cwd: r.cwd, cwdAbs: r.cwdAbs ?? null,
                exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs,
                // ★ 规格四.3：stdout / stderr 必须原样带上（编译错误、启动错误不许只留摘要）
                stdout: r.stdout, stderr: r.stderr,
                truncated: r.truncated ?? false, rawOutputPath: r.rawOutputPath ?? null,
                processId: r.processId ?? null, pid: r.pid ?? null,
                killedBy: r.killedBy ?? "none", killMethod: r.killMethod ?? "none",
                snapshotBefore: r.snapshotBefore ?? null,
                snapshotAfter: r.snapshotAfter ?? null,
                violations,
                envRemoved: r.envRemoved ?? [],
                // ★ 每条执行结果都自报隔离程度：soft 永远不是"已隔离"
                realIsolation: r.realIsolation,
                softIsolation: r.softIsolation,
                sandboxMode: r.sandboxMode,
                sandboxBackend: r.sandboxBackend,
                scaffoldNormalize: normalizeLines,
            },
        };
    },
};
