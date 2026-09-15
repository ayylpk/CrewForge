// tools/readFile.ts —— 读取生成项目内的文件内容
// 只读；读取范围限 projectDir 内（不给控制平面留读口）。
//
// ★ 9/15 截断改造：加 offset / limit 参数（按行续读，含行号）。
//   动因：结果进模型上下文会被 clipForModel 头尾裁剪（8192 字符），
//   模型需要一条"从哪继续读"的出路——原来只有 maxBytes 字节口径的整读，
//   被裁后只能整文件重读一遍（r4 里 103 次 readFile 的贡献因素之一）。
//   offset/limit 与 maxBytes 互斥优先：给了 offset 或 limit 就走行模式。
import { num, str } from "./registry";
import type { ToolContext, ToolResult, ToolSpec } from "./registry";

const DEFAULT_MAX_BYTES = 256 * 1024;

export const readFileTool: ToolSpec = {
    name: "readFile",
    description: "读取生成项目内的文件内容（相对项目根路径）；可用 offset/limit 按行续读（结果带行号）",
    parameters: {
        path: { type: "string", required: true, description: "相对项目根的路径" },
        offset: { type: "number", required: false, description: "起始行号（1 起）；给出即按行读取，结果带行号" },
        limit: { type: "number", required: false, description: "读取行数；省略 = 读到文件末尾" },
        maxBytes: { type: "number", required: false, description: `最多读取字节数（整读模式），默认 ${DEFAULT_MAX_BYTES}` },
    },
    async run(ctx: ToolContext, args): Promise<ToolResult> {
        const target = str(args, "path");
        if (!target) return { ok: false, output: "path 不能为空" };

        // 行模式：offset/limit 任一给出即触发（offset 缺省为 1）
        const hasOffset = args["offset"] !== undefined;
        const hasLimit = args["limit"] !== undefined;
        if (hasOffset || hasLimit) {
            const r = ctx.workspace.readLines(
                target,
                hasOffset ? num(args, "offset", 1) : 1,
                hasLimit ? num(args, "limit", 0) : undefined,
            );
            const more = r.startLine > r.totalLines
                ? `（offset=${r.startLine} 超出文件末尾：共 ${r.totalLines} 行）`
                : r.endLine < r.totalLines
                    ? `\n…（共 ${r.totalLines} 行；续读：offset=${r.endLine + 1}）`
                    : `\n…（共 ${r.totalLines} 行，已到末尾）`;
            return {
                ok: true,
                output: `${r.content}${more}`,
                meta: {
                    path: r.path, startLine: r.startLine, endLine: r.endLine,
                    totalLines: r.totalLines, lineMode: true,
                },
            };
        }

        const r = ctx.workspace.readText(target, num(args, "maxBytes", DEFAULT_MAX_BYTES));
        const output = r.truncated
            ? `${r.content}\n…（已截断；文件共 ${r.bytes} 字节）`
            : r.content;
        return { ok: true, output, meta: { path: r.path, bytes: r.bytes, truncated: r.truncated } };
    },
};
