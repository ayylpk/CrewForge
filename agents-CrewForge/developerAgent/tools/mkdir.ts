// tools/mkdir.ts —— 在生成项目内创建目录
// 递归创建；落点校验与审计都在 workspace.ensureDir。
import { str } from "./registry";
import type { ToolContext, ToolResult, ToolSpec } from "./registry";

export const mkdirTool: ToolSpec = {
    name: "mkdir",
    description: "在生成项目内创建目录（递归；必须落在 allowedRoots 内）",
    parameters: {
        path: { type: "string", required: true, description: "相对项目根的目录路径" },
    },
    async run(ctx: ToolContext, args): Promise<ToolResult> {
        const target = str(args, "path");
        if (!target) return { ok: false, output: "path 不能为空" };
        const created = ctx.workspace.ensureDir(target, { owner: ctx.owner, taskId: ctx.taskId });
        return { ok: true, output: `已创建目录 ${created}`, meta: { path: created } };
    },
};
