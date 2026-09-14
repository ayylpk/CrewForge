// tools/runBuild.ts —— 前后端常用构建的**快捷方式**（不是 Developer 唯一的命令入口）
//
//   规格二.2：runBuild 继续保留，但 Developer 也能用 runCommand / shell 跑
//   任意构建命令（gradle、bun build、自定义脚本……）。
//
//   9/13 去硬编码：target 只决定**目录**，命令由 resolveProjectCommand 按该目录的
//   工程文件识别（mvnw / gradlew / package.json / pyproject / go.mod）——
//   不再假设"后端一定是 Maven、前端一定是 npm"。识别不到入口返回
//   NO_BUILD_ENTRY（ok=false），**不执行任何猜测命令**，也绝不视为通过。
//   超时默认取沙箱配置里的 buildMs（10 分钟），不再散落魔法数字。
import path from "node:path";
import { num, str } from "./registry";
import type { ToolContext, ToolResult, ToolSpec } from "./registry";
import { NO_BUILD_ENTRY, resolveProjectCommand } from "./projectCommands";

export const runBuildTool: ToolSpec = {
    name: "runBuild",
    description: "前后端构建快捷方式：target=frontend|backend，命令按该目录的工程文件识别（mvnw / gradlew / package.json scripts.build / pyproject / go.mod），识别不了返回 NO_BUILD_ENTRY（不猜命令）。需要自定义命令时用 runCommand / shell。",
    parameters: {
        target: { type: "string", required: true, description: "frontend | backend" },
        cwd: { type: "string", required: false, description: "覆盖默认目录（frontend / backend）" },
        timeoutMs: { type: "number", required: false, description: "超时毫秒数，默认 600000（10 分钟）" },
        timeoutReason: { type: "string", required: false, description: "延长超时时必须写明原因（会记入 Ledger）" },
    },
    async run(ctx: ToolContext, args): Promise<ToolResult> {
        const target = str(args, "target");
        if (target !== "frontend" && target !== "backend") {
            return { ok: false, output: `target 只支持 frontend | backend，收到：${target || "(空)"}` };
        }
        const dir = str(args, "cwd") || target;
        const dirAbs = path.resolve(ctx.workspace.projectDir, dir);
        const resolved = resolveProjectCommand(dirAbs);
        if (!resolved) {
            // 结构化结果：ok=false + 明确错误码。不是编译错误，更不是通过——
            // 调用方（本地自检门禁）据此走"未验证"分支，不进编译修复回路。
            return {
                ok: false,
                output: `[build:${target}] NO_BUILD_ENTRY：${dir} 里没有可识别的通用工程入口`
                    + "（mvnw / gradlew / package.json scripts.build|compile / pyproject.toml / requirements.txt / go.mod）"
                    + "——不猜命令；确需构建请用 runCommand / shell 明确执行。",
                meta: {
                    code: NO_BUILD_ENTRY, target, cwd: dir,
                    command: null, args: [], detectedBy: null, exitCode: null,
                },
            };
        }

        const defaultMs = ctx.workspace.sandboxCapabilities.timeouts.buildMs;
        const timeoutMs = num(args, "timeoutMs", defaultMs);
        const r = await ctx.workspace.exec(
            resolved.command, resolved.args,
            { cwd: dir, timeoutMs, label: `runBuild:${target}` },
            { owner: ctx.owner, taskId: ctx.taskId },
        );
        const head = `[build:${target}] $ ${resolved.command} ${resolved.args.join(" ")}   (cwd=${r.cwd}, by=${resolved.detectedBy}) → exit=${r.exitCode}${r.timedOut ? " [超时]" : ""} (${r.durationMs}ms)`
            + (r.truncated ? ` [输出截断，原始输出：${r.rawOutputPath ?? "(未落盘)"}]` : "");
        const violations = r.violations ?? [];
        return {
            ok: r.exitCode === 0 && !r.timedOut && violations.length === 0,
            output: [head, r.stdout.trim(), r.stderr.trim(),
                ...violations.map((v) => `[${v.code}] ${v.message}`)].filter(Boolean).join("\n"),
            meta: {
                target, cwd: r.cwd, command: resolved.command, args: resolved.args,
                detectedBy: resolved.detectedBy,
                exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs,
                stdout: r.stdout, stderr: r.stderr,
                truncated: r.truncated ?? false, rawOutputPath: r.rawOutputPath ?? null,
                processId: r.processId ?? null, pid: r.pid ?? null,
                killedBy: r.killedBy ?? "none", killMethod: r.killMethod ?? "none",
                snapshotBefore: r.snapshotBefore ?? null,
                snapshotAfter: r.snapshotAfter ?? null,
                violations,
                realIsolation: r.realIsolation,
                softIsolation: r.softIsolation,
                sandboxMode: r.sandboxMode,
                sandboxBackend: r.sandboxBackend,
            },
        };
    },
};
