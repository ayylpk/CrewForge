// tools/writeFile.ts —— 创建或覆盖生成项目内的文件
// 唯一写盘路径：workspace.writeAtomic（allowedRoots + 原子替换 + 审计）。
import { str } from "./registry";
import type { ToolContext, ToolResult, ToolSpec } from "./registry";

export const writeFileTool: ToolSpec = {
    name: "writeFile",
    description: "在生成项目内创建或覆盖文件（必须落在 allowedRoots 内；临时文件 + 原子替换）",
    parameters: {
        path: { type: "string", required: true, description: "相对项目根的路径" },
        content: { type: "string", required: true, description: "完整文件内容；空串表示清空该文件" },
    },
    async run(ctx: ToolContext, args): Promise<ToolResult> {
        const target = str(args, "path");
        if (!target) return { ok: false, output: "path 不能为空" };
        const raw = args["content"];
        if (raw === undefined || raw === null) return { ok: false, output: "content 缺失（用空串表示清空文件）" };

        const r = ctx.workspace.writeAtomic(target, String(raw), { owner: ctx.owner, taskId: ctx.taskId });
        return { ok: true, output: `已写入 ${r.path}（${r.bytes} 字节）`, meta: { ...r } };
    },
};
