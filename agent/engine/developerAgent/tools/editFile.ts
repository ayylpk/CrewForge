// tools/editFile.ts —— 局部修改文件（增量修改的主手段）
// 先确认 find 确实存在再写，避免"盲改"把文件整段冲掉。
//
// ★ 9/15 改（参考 dsh str_replace_editor 的 FS_AMBIGUOUS_EDIT 口径）：
//   多命中时报**全部命中行号**。旧行为只说"命中 N 处"，模型得自己数行——
//   多数情况还要再 readFile 一遍才能定位（又一轮往返）。给行号 = 少一轮。
import { str } from "./registry";
import type { ToolContext, ToolResult, ToolSpec } from "./registry";
import { forgetRead } from "./readDedup";

/** find 在 content 中出现的行号列表（1 起，逐个命中都报） */
export function hitLines(content: string, find: string): number[] {
    const out: number[] = [];
    let idx = content.indexOf(find);
    while (idx >= 0) {
        out.push(content.slice(0, idx).split("\n").length);
        idx = content.indexOf(find, idx + Math.max(1, find.length));
    }
    return out;
}

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

        // ★ 多命中且没给 all：报全部命中行号（模型据此决定是 all:true 还是改 find 更具体）
        const lines = !all && hits > 1 ? hitLines(before.content, find) : [];
        const detail = lines.length > 0
            ? `命中 ${hits} 处（行 ${lines.join(", ")}），仅替换第 1 处；要全部替换请加 all:true，或把 find 改得更具体`
            : `命中 ${hits} 处，替换 ${applied} 处`;

        const r = ctx.workspace.writeAtomic(target, after, { owner: ctx.owner, taskId: ctx.taskId });
        // ★ 9/18：改了内容 → 读去重必须失效（同 writeFile 的理由）
        forgetRead(ctx.taskId, ctx.owner, r.path);
        forgetRead(ctx.taskId, ctx.owner, target);
        return {
            ok: true,
            output: `已修改 ${r.path}（${detail}）`,
            meta: { hits, applied, ...(lines.length > 0 ? { hitLines: lines } : {}), ...r },
        };
    },
};
