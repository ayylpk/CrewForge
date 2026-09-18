// tools/writeFile.ts —— 创建或覆盖生成项目内的文件
// 唯一写盘路径：workspace.writeAtomic（allowedRoots + 原子替换 + 审计）。
//
// ★ 搬运③（2026-09-17）：对**已存在且非空**的文件加"先读后改"硬闸
//   （claude-code readFileState / dsh FS_NOT_OBSERVED 口径）：
//   未观察过的文件不许整文件覆盖——先 readFile，或用 editFile 做精确局部替换。
//   新建文件不受影响；模型自己写过的文件（写=观察）可重复覆盖。
//   s4 动因：盲写批量重写把已通过的接口改挂（回归），提示词没管住，工具层管。
import { str } from "./registry";
import type { ToolContext, ToolResult, ToolSpec } from "./registry";
import { isObserved, markObserved } from "./observedFiles";
import { forgetRead } from "./readDedup";

export const writeFileTool: ToolSpec = {
    name: "writeFile",
    description: "在生成项目内创建或覆盖文件（必须落在 allowedRoots 内；临时文件 + 原子替换）。覆盖已存在的文件前必须先用 readFile 读过，否则会被拒绝——局部修改请用 editFile",
    parameters: {
        path: { type: "string", required: true, description: "相对项目根的路径" },
        content: { type: "string", required: true, description: "完整文件内容；空串表示清空该文件" },
    },
    async run(ctx: ToolContext, args): Promise<ToolResult> {
        const target = str(args, "path");
        if (!target) return { ok: false, output: "path 不能为空" };
        const raw = args["content"];
        if (raw === undefined || raw === null) return { ok: false, output: "content 缺失（用空串表示清空文件）" };

        // ★ 搬运③：先读后改硬闸。文件不存在 → 新建放行；存在且非空 → 必须已观察。
        //   口径统一：观察表里存的是 workspace 的 displayPath（readFile 同款），不能拿原始 target 查。
        let existingBytes = 0;
        let observedPath = target;
        try {
            const pre = ctx.workspace.readText(target);
            existingBytes = pre.bytes;
            observedPath = pre.path;
        } catch {
            existingBytes = 0; // 读不到 = 新文件，放行
        }
        if (existingBytes > 0 && !isObserved(ctx.taskId, ctx.owner, observedPath)) {
            return {
                ok: false,
                output: `FS_NOT_OBSERVED：${target} 已存在（${existingBytes} 字节）但本任务从未读过。`
                    + `整文件覆盖会抹掉你不知道的内容（s4 实测这样改挂过已通过的接口）。`
                    + `出路：① 先 readFile 读它；② 局部修改用 editFile（精确 find 替换，不用先整读）。`,
            };
        }

        const r = ctx.workspace.writeAtomic(target, String(raw), { owner: ctx.owner, taskId: ctx.taskId });
        // 写 = 观察：模型写过的内容它自己知道，后续覆盖不再要求重读
        markObserved(ctx.taskId, ctx.owner, r.path);
        // ★ 9/18：写成功后必须让读去重失效——下次读要看到**落盘后的真实内容**
        //   （原子替换后可能与模型发来的不同），不能拿旧的 readFile 结果顶替。
        forgetRead(ctx.taskId, ctx.owner, r.path);
        forgetRead(ctx.taskId, ctx.owner, target);
        return { ok: true, output: `已写入 ${r.path}（${r.bytes} 字节）`, meta: { ...r } };
    },
};
