// tools/inspectTree.ts —— 查看生成项目的目录与文件清单
// 只读；路径解析与越界拦截都在 workspace.ts。
// withMeta=true 时额外返回文件元数据（path/size/hash/language，**不含全文**）——供 Skill 调度用。
import { num, str } from "./registry";
import type { ToolContext, ToolResult, ToolSpec } from "./registry";
import { indexProjectFiles } from "./fileIndex";

export const inspectTreeTool: ToolSpec = {
    name: "inspectTree",
    description: "查看生成项目的目录与文件清单（相对项目根；跳过 node_modules/dist/target/.git 等）",
    parameters: {
        path: { type: "string", required: false, description: "起始目录，默认项目根" },
        limit: { type: "number", required: false, description: "最多返回条目数，默认 200" },
        withMeta: { type: "boolean", required: false, description: "是否附带文件元数据（path/size/hash/language）" },
    },
    async run(ctx: ToolContext, args): Promise<ToolResult> {
        const start = str(args, "path") || ".";
        const limit = num(args, "limit", 200);
        const files = ctx.workspace.walk(start);
        const shown = files.slice(0, Math.max(0, limit));
        const head = files.length > shown.length
            ? `共 ${files.length} 个文件（仅显示前 ${shown.length}）：`
            : `共 ${files.length} 个文件：`;
        // 元数据按同样的 limit 取，避免把上万条塞进 state
        const meta = args["withMeta"] === true
            ? { files: indexProjectFiles(ctx.workspace, start, { limit: Math.max(1, limit) }) }
            : {};
        return {
            ok: true,
            output: [head, ...shown].join("\n"),
            meta: { total: files.length, shown: shown.length, ...meta },
        };
    },
};
