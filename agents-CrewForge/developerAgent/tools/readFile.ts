// tools/readFile.ts —— 读取生成项目内的文件内容
// 只读；读取范围限 projectDir 内（不给控制平面留读口）。
import { num, str } from "./registry";
import type { ToolContext, ToolResult, ToolSpec } from "./registry";

const DEFAULT_MAX_BYTES = 256 * 1024;

export const readFileTool: ToolSpec = {
    name: "readFile",
    description: "读取生成项目内的文件内容（相对项目根路径）",
    parameters: {
        path: { type: "string", required: true, description: "相对项目根的路径" },
        maxBytes: { type: "number", required: false, description: `最多读取字节数，默认 ${DEFAULT_MAX_BYTES}` },
    },
    async run(ctx: ToolContext, args): Promise<ToolResult> {
        const target = str(args, "path");
        if (!target) return { ok: false, output: "path 不能为空" };
        const r = ctx.workspace.readText(target, num(args, "maxBytes", DEFAULT_MAX_BYTES));
        const output = r.truncated
            ? `${r.content}\n…（已截断；文件共 ${r.bytes} 字节）`
            : r.content;
        return { ok: true, output, meta: { path: r.path, bytes: r.bytes, truncated: r.truncated } };
    },
};
