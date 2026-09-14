// tools/delegateReadonly.ts —— 把问题交给只读子 Agent
//
// 两条通道：
//   ① 不传 role（旧通道）：走 ctx.analyzer，返回一段只读分析文本（向后兼容既有测试）；
//   ② 传 role（统一接口）：走 ctx.subagent（tools/readonlySubAgent.ts），
//      返回**结构化**只读建议（rootCause / evidence / 建议 / 风险 / confidence / cannotVerify）。
//
// 子 Agent 的能力边界（硬，与通道无关）：
//   · 能读文件、能搜索、能解释错误、能给建议；
//   · **不能写盘**——它拿不到 workspace 写入口，只拿到只读工具盒；
//   · 不能发 Hub 消息、不能写 Ledger、不能改 DeveloperState（运行环境里根本没有这些句柄）；
//   · Developer 审核它的建议之后，才由 Developer 自己调 writeFile / editFile 落盘。
import { str, strList } from "./registry";
import type { ToolArgs, ToolContext, ToolResult, ToolSpec } from "./registry";
import { coerceReadonlyRequest, READONLY_SUBAGENT_ROLES } from "./readonlySubAgent";
import type { ReadonlySubAgentRole } from "./readonlySubAgent";

export const delegateReadonlyTool: ToolSpec = {
    name: "delegateReadonly",
    description: "调用只读子 Agent 分析问题（可搜索、可解释错误、可给结构化建议；绝不能写盘）。传 role 走结构化通道：explorer / debugger / ui-reviewer",
    parameters: {
        question: { type: "string", required: true, description: "要分析的问题，例如「为什么 PUT /api/notes 返回 500」" },
        paths: { type: "array", required: false, description: "相关文件路径，供其只读查阅" },
        role: { type: "string", required: false, description: `只读子 Agent 角色：${READONLY_SUBAGENT_ROLES.join(" / ")}；不传则用通用只读分析器` },
        evidence: { type: "object", required: false, description: "机器证据（category/command/exitCode/stdout/stderr/affectedFiles/failureSignature），主要供 debugger 角色使用" },
    },
    async run(ctx: ToolContext, args: ToolArgs): Promise<ToolResult> {
        const question = str(args, "question");
        if (!question) return { ok: false, output: "question 不能为空" };

        // ---- ② 结构化通道（传了合法 role 才走；否则回落旧通道，向后兼容） ----
        const roleArg = str(args, "role").trim() as ReadonlySubAgentRole;
        if (roleArg) {
            if (!READONLY_SUBAGENT_ROLES.includes(roleArg)) {
                return {
                    ok: false,
                    output: `未知子 Agent 角色「${roleArg}」（可用：${READONLY_SUBAGENT_ROLES.join(" / ")}）`,
                    rejected: { code: "SUBAGENT_INVALID_REQUEST", target: roleArg, message: "非法子 Agent 角色" },
                };
            }
            if (!ctx.subagent) {
                return { ok: false, output: "只读子 Agent 未接入（本环境未提供结构化分析器）" };
            }
            const outcome = await ctx.subagent(coerceReadonlyRequest(args));
            return {
                ok: outcome.ok,
                // 结构化结果原样序列化回给主 Agent；非法返回早在派发器里就被挡下，不会到这
                output: JSON.stringify(outcome.result),
                meta: {
                    readonly: true,
                    subagent: true,
                    role: outcome.result.role,
                    confidence: outcome.result.confidence,
                    reused: outcome.reused ?? false,
                    stale: outcome.stale ?? false,
                    // 子 Agent 的 LLM 预算回填给主循环（规格九.1）：确定性模式下恒为 0
                    llmCallsPlanned: outcome.llmCallsPlanned,
                    llmCallsCompleted: outcome.llmCallsCompleted,
                    ...(outcome.code ? { code: outcome.code } : {}),
                    ...(outcome.message ? { message: outcome.message } : {}),
                },
            };
        }

        // ---- ① 旧通道：通用只读分析器（返回文本） ----
        if (!ctx.analyzer) {
            return { ok: false, output: "只读子 Agent 未接入（本阶段仅保留接口，不接真实 MCP/模型）" };
        }
        const paths = strList(args, "paths");
        const answer = await ctx.analyzer({ question, ...(paths.length > 0 ? { paths } : {}) });
        return { ok: true, output: answer, meta: { readonly: true, paths } };
    },
};
