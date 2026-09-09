import { SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { initModels } from "./models";
import { retryStructured } from "./llm";
import { readWorkspace, writeWorkspace, type ExecTask, type Plan, REQUEST_WRAPPER_PATH } from "./common";
import { bannedDependencyList } from "./foundation";
import { baselinePromptBlock, API_ERROR_CODE, API_SUCCESS_CODE, resolveProjectBaseline } from "./baseline";

export const CONTRACTS_FILE = "CONTRACTS.md";

const CONTRACTS_MODEL_JSON = JSON.stringify({
    provider: "deepseek",
    model: "deepseek-v4-flash",
    temperature: 0.2,
    thinking: false,
});

export const CONTRACT_LAWS = [
    "## 登记制铁律（违反任何一条，写盘闸/测试直接判红）",
    "1. frontend/src/main.ts、frontend/src/App.vue、frontend/src/router/index.ts 是引擎拥有件：任何任务不许产出或修改；路由由引擎按页面清单机械登记。",
    "2. router 的 component 指向必须来自页面清单真实文件；未登记文件不得进入路由。",
    "3. 共享模块由唯一任务创建，其余任务只 import，禁止另起炉灶或覆盖已有文件。",
    "4. 颜色/圆角/间距只使用项目视觉 token，硬编码色值不得超过 5 处。",
    "5. 后端文件必须遵循最终技术栈的目录约定；不得混用不同后端框架的入口或目录，禁止多根目录摇摆。",
].join("\n");

export const CONTRACT_API_BASE = [
    "## 接口基约",
    `- 默认 API 前缀为 /api；前端请求封装唯一使用 ${REQUEST_WRAPPER_PATH}，具体 HTTP 客户端必须与最终技术栈一致。`,
    `- 响应形态统一为 { code, msg, data }；成功 code=${API_SUCCESS_CODE}，失败 code=${API_ERROR_CODE}。`,
    "- 认证统一使用 JWT；前端通过 Authorization: Bearer <token> 请求头发送，不使用 session 作为业务认证协议。",
    "- method、path、参数名、返回字段必须在前后端契约中逐字一致。",
].join("\n");

export const contracts_schema = z.object({
    pages: z.array(z.object({
        path: z.string().describe("路由 path；纯组件填 (组件)"),
        file: z.string().describe("必须来自输入任务 files"),
        task: z.string().describe("输入任务 id"),
    })),
    shared: z.string(),
});

export const contracts_prompt = `
# 角色
你是 CrewForge 的契约对账 Agent。你只登记任务边界，不修改技术基线。

## 强制基线
${baselinePromptBlock()}

## 输出
1. pages：逐条输出 {path,file,task}。file 必须原样来自输入任务 files，不能发明文件或路由；纯组件 path 填 (组件)。
2. shared：只列出多个任务会复用且在 files 中真实存在的文件，并标明唯一创建任务；其余任务只 import。
只输出符合 schema 的 JSON，不输出 Markdown 或额外解释。
`;

export const CONTRACT_STYLE_SECTION = [
    "## 视觉 token（单一来源，全站唯一）",
    "- 组件库、主题入口和视觉 token 以架构师最终技术选型为准；页面不得混用未声明的组件库。",
    "- 页面和组件不得凭记忆引入未在 package.json 与技术选型中声明的 UI 依赖。",
].join("\n");

function renderPages(pages: { path: string; file: string; task: string }[]): string {
    return pages.map(page => `- ${page.path} → ${page.file}（登记任务 ${page.task}）`).join("\n");
}

export function parseBannedImports(md: string | null): string[] {
    if (!md) return [];
    const match = /^- banned-imports:\s*(.+)$/m.exec(md);
    if (!match?.[1]) return [];
    const value = match[1].trim();
    if (!value || value === "（无）" || value === "(none)") return [];
    return value.split(/[,，]/).map(item => item.trim().toLowerCase()).filter(Boolean);
}

function normalizePages(tasks: ExecTask[], pages: { path: string; file: string; task: string }[]): { path: string; file: string; task: string }[] {
    const owners = new Map<string, string>();
    for (const task of tasks) {
        if (task.layer !== "frontend") continue;
        for (const file of task.files) owners.set(file.replace(/\\/g, "/").toLowerCase(), task.id);
    }
    const seen = new Set<string>();
    return pages.filter(page => {
        const file = (page.file ?? "").replace(/\\/g, "/");
        const key = file.toLowerCase();
        const owner = owners.get(key);
        if (!owner || !page.path || seen.has(key)) return false;
        page.file = file;
        page.task = owner;
        if (!page.path.startsWith("/") && page.path !== "(组件)" && page.path !== "（组件）") page.path = `/${page.path}`;
        seen.add(key);
        return true;
    });
}

export function assembleContracts(
    phaseNo: number,
    plan: Plan | null,
    llm: { pages: { path: string; file: string; task: string }[]; shared: string } | null,
    stack: unknown = null,
): string {
    const phase = plan?.phases.find(item => item.phase === phaseNo);
    const goal = phase?.goal ?? plan?.mvp_scope?.join("；") ?? "（见任务清单）";
    const ui = plan?.uiProfile
        ? `界面决策：${plan.uiProfile.web ? `需要 Web，页面意向 ${plan.uiProfile.pages.join("、") || "按功能推断"}` : "不做前端，仅后端/API"}；风格：${plan.uiProfile.style}${plan.uiProfile.defaulted ? "（默认值，未经用户亲答）" : "（用户已确认）"}`
        : "";
    const pages = llm?.pages?.length ? renderPages(llm.pages) : "- （契约登记降级：没有可靠页面清单，路由可达性由测试判定）";
    const shared = llm?.shared?.trim() || "- 无";
    const banned = bannedDependencyList(stack);
    const baseline = [
        "## 技术基线（机械闸，写盘时 import 禁用包直接打回）",
        baselinePromptBlock(resolveProjectBaseline(stack)),
        `- banned-imports: ${banned.join(", ") || "（无）"}`,
    ].join("\n");
    return [
        `# 项目契约（阶段 ${phaseNo} 生成，所有工位 prompt 头部注入）`,
        "",
        `业务目标：${goal}`,
        ui ? `\n${ui}` : "",
        "",
        CONTRACT_STYLE_SECTION,
        "",
        "## 页面清单（引擎在任务收口后机械登记）",
        pages,
        "",
        "## 共享模块（唯一创建者负责制）",
        shared,
        "",
        baseline,
        "",
        CONTRACT_API_BASE,
        "",
        CONTRACT_LAWS,
        "",
    ].join("\n");
}

export async function publishContracts(
    phaseNo: number,
    plan: Plan | null,
    tasks: ExecTask[],
    stack: unknown = null,
): Promise<string | null> {
    const taskLines = tasks.map(task => `- ${task.id} [${task.layer}] ${task.title} | files: ${task.files.join(", ") || "（无）"}`).join("\n");
    try {
        const result = await retryStructured("契约登记", async (feedback, signal) => {
            const model = initModels(CONTRACTS_MODEL_JSON, "contracts");
            const output = await model.withStructuredOutput(contracts_schema, { method: "jsonMode", name: "extract_contracts" })
                .invoke([new SystemMessage(`${contracts_prompt}\n\n## 阶段 ${phaseNo} 任务\n${taskLines}${feedback}`)], { signal });
            return output as { pages: { path: string; file: string; task: string }[]; shared: string };
        });
        const normalized = result ? { pages: normalizePages(tasks, result.pages ?? []), shared: result.shared ?? "" } : null;
        const markdown = assembleContracts(phaseNo, plan, normalized, stack);
        writeWorkspace(CONTRACTS_FILE, markdown);
        console.log(`[contracts] phase=${phaseNo} tasks=${tasks.length} pages=${normalized?.pages.length ?? 0}`);
        return markdown;
    } catch (error) {
        console.warn("[contracts] generation bypassed:", (error as Error).message);
        return null;
    }
}

let cache: { md: string | null; at: number } | null = null;
export async function loadContracts(force = false): Promise<string | null> {
    if (!force && cache && Date.now() - cache.at < 60_000) return cache.md;
    let md: string | null = null;
    try { md = await readWorkspace(CONTRACTS_FILE); } catch { md = null; }
    cache = { md, at: Date.now() };
    return md;
}

export function contractPromptBlock(md: string | null): string {
    return md ? `\n\n## 项目契约 ${CONTRACTS_FILE}（全局唯一真相，与上文冲突时以此为准）\n${md}` : "";
}

export function resetContractsCache(): void {
    cache = null;
}
