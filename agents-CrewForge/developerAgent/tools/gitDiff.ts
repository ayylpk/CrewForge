// tools/gitDiff.ts —— 查看改动（只读）
// 每次修改后都要看 diff；只读操作，不产生写入审计。
import { str } from "./registry";
import type { ToolContext, ToolResult, ToolSpec } from "./registry";

export const gitDiffTool: ToolSpec = {
    name: "gitDiff",
    description: "查看生成项目内的改动内容（git diff，只读）",
    parameters: {
        path: { type: "string", required: false, description: "限定路径，默认全部" },
        staged: { type: "boolean", required: false, description: "查看已暂存改动（--cached）" },
    },
    async run(ctx: ToolContext, args): Promise<ToolResult> {
        const argv = ["diff"];
        if (args["staged"] === true) argv.push("--cached");
        const p = str(args, "path");
        if (p) argv.push("--", p);

        const r = await ctx.workspace.exec("git", argv, {}, { owner: ctx.owner, taskId: ctx.taskId });
        const body = r.stdout.trim();
        return {
            ok: r.exitCode === 0,
            output: body || "(无改动)",
            meta: { exitCode: r.exitCode, staged: args["staged"] === true, path: p || null },
        };
    },
};
