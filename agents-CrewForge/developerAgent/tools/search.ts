// tools/search.ts —— grep / 正则 / 符号搜索（只读）
// 只读；遍历范围与越界拦截都在 workspace.ts。
import { num, str } from "./registry";
import type { ToolContext, ToolResult, ToolSpec } from "./registry";

const MAX_FILE_BYTES = 1024 * 1024;

export const searchTool: ToolSpec = {
    name: "search",
    description: "在生成项目内按正则搜索文本，返回 文件:行号: 内容（只读）",
    parameters: {
        pattern: { type: "string", required: true, description: "正则表达式" },
        path: { type: "string", required: false, description: "搜索范围，默认项目根" },
        maxResults: { type: "number", required: false, description: "最多命中数，默认 50" },
        ignoreCase: { type: "boolean", required: false, description: "忽略大小写" },
    },
    async run(ctx: ToolContext, args): Promise<ToolResult> {
        const pattern = str(args, "pattern");
        if (!pattern) return { ok: false, output: "pattern 不能为空" };
        let re: RegExp;
        try {
            re = new RegExp(pattern, args.ignoreCase === true ? "i" : "");
        } catch (e) {
            return { ok: false, output: `正则非法：${(e as Error).message}` };
        }

        const root = str(args, "path") || ".";
        const maxResults = Math.max(1, num(args, "maxResults", 50));
        const files = ctx.workspace.walk(root);
        const hits: string[] = [];
        let scanned = 0;

        for (const f of files) {
            if (hits.length >= maxResults) break;
            let r: { path: string; content: string; truncated: boolean; bytes: number };
            try { r = ctx.workspace.readText(f, MAX_FILE_BYTES); } catch { continue; }
            if (r.truncated) continue;              // 超大文件跳过，避免半截误报
            if (r.content.includes("\u0000")) continue;   // 二进制跳过
            scanned++;
            const lines = r.content.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (line === undefined) continue;
                if (re.test(line)) {
                    hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 300)}`);
                    if (hits.length >= maxResults) break;
                }
            }
        }

        return {
            ok: true,
            output: hits.length > 0 ? hits.join("\n") : `无命中（已扫描 ${scanned} 个文件）`,
            meta: { scanned, hits: hits.length },
        };
    },
};
