// ============================================================
// tools/askHuman.ts —— 模型主动求助（human-in-the-loop 的模型侧入口）
//
//   与 escalation.ts（**代码强制**升级）是一对：
//     · escalation.ts：保险丝触发时，图在路由层把问题抛给人（不依赖模型自觉）
//     · 本工具：模型自己在循环里发现"这事得问人"，随时可以举手
//   两条路都走同一个 Questioner 抽象（confirm.ts 的 pickQuestioner 三分流），
//   所以 Web 气泡卡 / 终端 stdin / AUTO_CONFIRM 自动答三种形态天然一致。
//
//   为什么必须做成工具而不是"提示词里让模型提问"：
//     模型在工具循环里只会输出 tool_use；没有这个工具，它想求助只能把话写在
//     助手文本里——而助手文本不进人的视野（进程在跑），于是"想求助"变成"自己硬扛"，
//     最后烧完预算进 blocked（s5b 就是这么死的）。
//
//   边界（默认拒绝）：
//     · ctx 里没有 askHuman 端口（只读子 Agent / Test 侧工具盒）→ 直接拒绝，
//       子 Agent 不许打扰人；
//     · question 为空 → 拒绝；
//     · 每次调用都进 Ledger（问题 + 答案），可审计"模型到底问了什么、人怎么答的"。
// ============================================================

import { str, strList } from "./registry";
import type { ToolContext, ToolResult, ToolSpec } from "./registry";

export const askHumanTool: ToolSpec = {
    name: "askHuman",
    description: "向人提问并**等待回答**（人不在场会自动按第一个选项兜底，不会卡死）。"
        + "当你遇到：需求歧义、只有人知道的信息（密钥/端口/账号）、需要授权的破坏性操作、"
        + "或者同一个问题你已经试了两次还是不通 —— 用它问，不要自己硬扛到预算烧完。"
        + "question 写清【我在做什么】【我试过什么】【我判断的问题】【需要你决定什么】；"
        + "options 给 2~3 个可选项（第一项是最安全的默认）。",
    parameters: {
        question: { type: "string", required: true, description: "要问人的问题（含背景与你的判断，人能据此决策）" },
        options: { type: "array", required: false, description: "可选项（2~3 个，第一项为最安全的默认）" },
        contextNote: { type: "string", required: false, description: "补充上下文（相关文件、命令、错误摘要），会随问题一起展示" },
    },
    async run(ctx: ToolContext, args): Promise<ToolResult> {
        const question = str(args, "question");
        if (!question) return { ok: false, output: "question 不能为空" };
        if (!ctx.askHuman) {
            // 默认拒绝：只读子 Agent 等没有该端口的调用方一律拒绝（不静默降级成"自己决定"）
            return {
                ok: false,
                output: "当前角色没有向人提问的权限（askHuman 端口未注入）：请自行决策并在输出里写明假设与依据",
                meta: { code: "ASK_HUMAN_UNAVAILABLE" },
            };
        }
        const options = strList(args, "options").filter((o) => o.trim().length > 0).slice(0, 5);
        const contextNote = str(args, "contextNote");
        const prompt = contextNote ? `${question}\n\n【相关上下文】${contextNote}` : question;
        try {
            const answer = await ctx.askHuman({ question: prompt, options });
            return {
                ok: true,
                output: `人已答复：${answer}`,
                meta: { question: prompt, options, answer, answeredBy: "human" },
            };
        } catch (e) {
            // 问不出去 ≠ 整轮失败：如实报错，让模型知道"人这条线断了"，自己决定下一步
            return {
                ok: false,
                output: `提问失败（人这条线不可用）：${String((e as Error).message ?? e)}。请自行决策并写明假设。`,
                meta: { question: prompt, options, code: "ASK_HUMAN_FAILED" },
            };
        }
    },
};
