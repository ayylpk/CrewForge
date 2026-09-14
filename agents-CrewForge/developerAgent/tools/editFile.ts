// tools/editFile.ts —— 局部修改文件（增量修改的主手段）
// 先确认 find 确实存在再写，避免"盲改"把文件整段冲掉。
import { str } from "./registry";
import type { ToolContext, ToolResult, ToolSpec } from "./registry";

export const editFileTool: ToolSpec = {
    name: "editFile",
    description: "局部修改：把文件中的 find 精确替换为 replace；find 未命中即拒绝写入（防盲改）",
    parameters: {
        path: { type: "string", required: true, description: "相对项目根的路径" },
        find: { type: "string", required: true, description: "被替换的原文，必须已存在于文件中" },
        replace: { type: "string", required: true, description: "替换后的文本；空串表示删除" },
        all: { type: "boolean", required: false, description: "是否替换全部命中，默认只替换第一处" },
    },
    async run(ctx: ToolContext, args): Promise<ToolResult> {
        const target = str(args, "path");
        const find = str(args, "find");
        if (!target) return { ok: false, output: "path 不能为空" };
        if (!find) return { ok: false, output: "find 不能为空（整文件重写请用 writeFile）" };
        const replace = args["replace"] === undefined ? "" : String(args["replace"]);

        const before = ctx.workspace.readText(target);
        const hits = before.content.split(find).length - 1;
        if (hits === 0) {
            return { ok: false, output: `find 未在 ${before.path} 中出现，拒绝写入（防止盲改）` };
        }

        const all = args["all"] === true;
        const after = all
            ? before.content.split(find).join(replace)
            : before.content.replace(find, replace);
        const applied = all ? hits : 1;

        const r = ctx.workspace.writeAtomic(target, after, { owner: ctx.owner, taskId: ctx.taskId });
        return {
            ok: true,
            output: `已修改 ${r.path}（命中 ${hits} 处，替换 ${applied} 处）`,
            meta: { hits, applied, ...r },
        };
    },
};
