// ============================================================
// tools/testAssistant.ts —— 只读 Test Assistant（Developer 的**分析上下文**）
//
//   规格十：Developer 允许有一个只读的分析助手，但它必须**结构上**做不到下面这些：
//     · 不可调用写盘工具      → 工具名字先过 READONLY_TOOL_NAMES 白名单
//     · 不可执行任意命令      → runCommand / runBuild 不在白名单里
//     · 不可产生 TestPassed   → 返回值只能是 string，且**没有** Hub 端口 / Ledger / State 句柄
//     · 不可改变 DeveloperState → 同上，它连 state 都拿不到
//
//   所以"它不能写盘"不是靠提示词自觉，而是靠**它拿不到写盘所需的任何句柄**。
//   正式 TestPassed 只能来自配置好的独立 TestAgent（信任链在 protocol.ts）。
//
//   本实现是零 LLM 的确定性分析：抽标识符 → 搜索 → 读相关文件 → 给出候选与建议。
// ============================================================

import type { ToolArgs, ToolContext, ToolResult, ToolRegistry } from "./registry";
import { READONLY_TOOL_NAMES } from "./registry";
import type { Workspace } from "../workspace";

/**
 * 只读助手能碰的工具（白名单，代码写死）。
 * 定义在 registry.ts 里作为**全局权威清单**，这里只做转发——
 * 免得出现"两处白名单不一致"这种漏洞。
 * 注意：shell / runCommand / runBuild / httpRequest / startProcess / … 都不在其中，
 * 所以 Test 侧助手连执行口都摸不到。
 */
export { READONLY_TOOL_NAMES };

export function isReadonlyTool(name: string): boolean {
    return READONLY_TOOL_NAMES.includes(name);
}

export interface ReadonlyToolbox {
    readonly names: readonly string[];
    invoke(name: string, args: ToolArgs): Promise<ToolResult>;
}

/**
 * 给只读助手用的工具盒：
 *   ① 名字不在白名单 → 直接拒绝（连 registry 都不进）；
 *   ② 即便白名单判断被绕过，registry 还会因为 role≠developer 再拦一道写盘。
 *
 * 9/13 微扩：owner/role 可标注调用方（只读子 Agent 用 `subagent:<role>`），
 * 缺省值与旧行为完全一致——这是**全局唯一**的一套只读权限逻辑，
 * 子 Agent / TestAgent / 分析助手都从这里出，不另起第三套。
 */
export function createReadonlyToolbox(o: {
    workspace: Workspace;
    tools: ToolRegistry;
    taskId: string;
    owner?: string;
    role?: string;
}): ReadonlyToolbox {
    const ctx: ToolContext = {
        workspace: o.workspace,
        owner: o.owner ?? "testAssistant",
        role: o.role ?? "test_assistant",   // ★ 不是 developer → 写盘工具天然被拒
        taskId: o.taskId,
    };
    return {
        names: READONLY_TOOL_NAMES,
        async invoke(name: string, args: ToolArgs): Promise<ToolResult> {
            if (!isReadonlyTool(name)) {
                return {
                    ok: false,
                    output: `只读助手禁止调用 ${name}（可用：${READONLY_TOOL_NAMES.join(", ")}）`,
                    rejected: { code: "NOT_READONLY", target: name, message: "只读助手无权执行该工具" },
                };
            }
            return o.tools.invoke(name, ctx, args);
        },
    };
}

/** 能力自述：给测试与文档用的显式声明（全是代码事实，不是承诺） */
export function assistantCapabilities(): {
    canWrite: false; canExecute: false; canEmitTestPassed: false; canMutateState: false;
} {
    return { canWrite: false, canExecute: false, canEmitTestPassed: false, canMutateState: false };
}

/**
 * TestAgent / 只读助手**点名禁止**的工具（规格六）：
 * 不只是"没在白名单里"，而是显式列出——拒绝原因要能说清楚禁的是什么能力。
 *   · 写盘：mkdir / writeFile / editFile
 *   · 执行：runCommand / runBuild / shell / httpRequest
 *   · 进程：startProcess / readProcess / stopProcess
 */
export const TEST_AGENT_FORBIDDEN_TOOLS: readonly string[] = [
    "mkdir", "writeFile", "editFile",
    "runCommand", "runBuild", "shell", "httpRequest",
    "startProcess", "readProcess", "stopProcess",
];

/**
 * TestAgent 侧工具盒：只读白名单 + 明示禁止清单双重收口。
 * 它拿不到 Developer 的任意 shell——这是**结构上**做不到，不是提示词请求。
 */
export function createTestAgentToolbox(o: {
    workspace: Workspace;
    tools: ToolRegistry;
    taskId: string;
}): ReadonlyToolbox {
    const inner = createReadonlyToolbox(o);
    return {
        names: inner.names,
        async invoke(name: string, args: ToolArgs): Promise<ToolResult> {
            if (TEST_AGENT_FORBIDDEN_TOOLS.includes(name)) {
                return {
                    ok: false,
                    output: `TestAgent 禁止调用 ${name}（只读验证角色：不得写生成项目、不得执行任意命令、不得起进程）`,
                    rejected: {
                        code: "NOT_READONLY", target: name,
                        message: "TestAgent 是只读验证角色，代码层不具备执行/写盘能力",
                    },
                };
            }
            return inner.invoke(name, args);
        },
    };
}

const STOPWORDS = new Set([
    "the", "and", "for", "with", "why", "how", "what", "this", "that", "error", "file",
    "npm", "run", "build", "http", "https", "failed", "failure",
]);

/** 从自然语言问题里抽可用于搜索的标识符（零 LLM，纯规则） */
export function extractTokens(question: string, max = 4): string[] {
    const raw = question.match(/[A-Za-z_][A-Za-z0-9_.\-/]{2,}|[1-9][0-9]{2}/g) ?? [];
    const out: string[] = [];
    for (const t of raw) {
        const lower = t.toLowerCase();
        if (STOPWORDS.has(lower)) continue;
        if (out.some((x) => x.toLowerCase() === lower)) continue;
        out.push(t);
        if (out.length >= max) break;
    }
    return out;
}

const REPORT_HEADER = [
    "【只读分析】以下是代码检索结果，**不是**验收结论；",
    "通过与否只能由独立 TestAgent 的机器证据判定。",
].join("");

export interface TestAssistantOptions {
    workspace: Workspace;
    tools: ToolRegistry;
    taskId: string;
    /** 单次分析最多搜几个关键字 / 读几个文件 */
    maxSearchTokens?: number;
    maxHitsPerToken?: number;
    maxFilesToRead?: number;
}

/**
 * 构造只读分析器。返回值直接可喂给 `ToolContext.analyzer`（即 delegateReadonly 的注入点）。
 */
export function createReadonlyTestAssistant(
    o: TestAssistantOptions,
): (req: { question: string; paths?: string[] }) => Promise<string> {
    const box = createReadonlyToolbox({ workspace: o.workspace, tools: o.tools, taskId: o.taskId });
    const maxTokens = o.maxSearchTokens ?? 3;
    const maxHits = o.maxHitsPerToken ?? 8;
    const maxRead = o.maxFilesToRead ?? 5;

    return async (req) => {
        const question = (req.question ?? "").trim();
        const lines: string[] = [REPORT_HEADER, "", `问题：${question || "(空)"}`];

        // ① 显式给出的路径优先读（仍是只读）
        const hinted = (req.paths ?? []).slice(0, maxRead);
        if (hinted.length > 0) {
            lines.push("", "## 指定文件（只读摘录）");
            for (const p of hinted) {
                const r = await box.invoke("readFile", { path: p, maxBytes: 4000 });
                lines.push(r.ok
                    ? `- ${p}：\n${r.output.slice(0, 1200)}`
                    : `- ${p}：读取失败（${r.output.slice(0, 120)}）`);
            }
        }

        // ② 从问题里抽标识符再全库搜
        const tokens = extractTokens(question, maxTokens);
        if (tokens.length > 0) {
            lines.push("", "## 关键字检索");
            for (const token of tokens) {
                const r = await box.invoke("search", { pattern: escapeRegExp(token), maxResults: maxHits });
                lines.push(`- 「${token}」：`);
                lines.push(r.ok ? indent(r.output.slice(0, 1200)) : indent(`检索失败：${r.output.slice(0, 200)}`));
            }
        } else {
            lines.push("", "## 关键字检索", "- 问题里没有可检索的标识符（试试给出接口路径、类名或错误码）");
        }

        // ③ 目录概览，便于模型定位
        const tree = await box.invoke("inspectTree", { limit: 60 });
        lines.push("", "## 目录概览", indent(tree.ok ? tree.output.slice(0, 1500) : "读取失败"));

        lines.push("", "## 建议下一步",
            "- 先打开上面命中的文件确认字段与路由是否一致；",
            "- 修改只能由 Developer 本人通过写盘工具完成，本助手不写盘、不执行命令、不产生验收结论。");

        return lines.join("\n");
    };
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function indent(text: string): string {
    return text.split(/\r?\n/).map((l) => `  ${l}`).join("\n");
}
