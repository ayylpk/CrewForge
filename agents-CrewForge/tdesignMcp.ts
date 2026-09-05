// ============================================================
// tdesignMcp.ts —— TDesign 组件文档通道（9/5 下午主线：frontendEngineer 集成）
//
//   定位（铁律 [[crewforge-code-over-tools]]）：这是"代码骨架"里的确定性动作，
//   不是给 LLM 调的 tool。流程：
//     设计稿声明选用组件 → 代码预取真实 API 文档（注入 file prompt）→ 生成 →
//     代码闸门核验"用到的 t-* 是否真实存在"（查回"组件不存在"= 幻觉 → 打回重生成）。
//
//   为什么预取而非让模型自己查：flash 无视软提醒、也不给它 tool loop；把"查"从
//   模型意愿问题变成代码必做步骤，才拦得住它凭记忆瞎编组件（pokedex-demo 9/5 验收教训）。
//
//   旁路原则（同 sys_task 桥姿势）：MCP 进程起不来 / 拉取超时 / 任何异常 →
//   返回 null，调用方降级到"不注入文档、不卡幻觉闸门"，绝不为打补丁杀流水线。
// ============================================================

import path from "node:path";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { invokeWithTimeout } from "./llm";

/** 高频组件白名单（进 systemPrompt，引导模型优先用这些；不是硬禁用清单——真用了别的走幻觉核验） */
export const TDESIGN_WHITELIST: readonly string[] = [
    "button", "input", "textarea", "select", "form", "checkbox", "radio", "switch",
    "date-picker", "input-number", "upload", "table", "card", "tag", "avatar",
    "dialog", "drawer", "message", "notification", "popconfirm", "tooltip", "loading",
    "menu", "breadcrumb", "tabs", "pagination", "empty", "space", "image", "progress",
];

/** 白名单的 `<t-xxx>` 形态（贴进提示词用，模型看这个比看裸名更不容易记错前缀） */
export const TDESIGN_WHITELIST_TAGS = TDESIGN_WHITELIST.map(n => `<t-${n}>`).join(" ");

/**
 * 藏青/午夜蓝赛博主题（--td-* CSS 变量覆盖，[[crewforge-frontend-style]] 色系）。
 * 单一来源双消费：frontendEngineer 注入生成提示词 + architect bootstrap 落盘成真实 theme 文件。
 */
export const TDESIGN_THEME_CSS = `/* td-theme.css —— CrewForge 主题：覆盖 TDesign --td-* 变量
   （必须放在 tdesign-vue-next 自带样式之后引入，后声明者优先生效） */
:root {
  --td-brand-color: #00d4ff;              /* 主色：赛博蓝 */
  --td-brand-color-hover: #33ddff;
  --td-brand-color-active: #00aed1;
  --td-radius-default: 8px;
  --td-bg-color-page: #0d1117;            /* 页面底：午夜黑蓝 */
  --td-bg-color-container: #161b26;       /* 容器/卡片：藏青 */
  --td-bg-color-container-hover: #1c2331;
  --td-bg-color-secondarycontainer: #1a2130;
  --td-text-color-primary: #e6e6e6;
  --td-text-color-secondary: #9aa4b2;
  --td-text-color-placeholder: #5c6675;
  --td-component-border: #2a3547;         /* 描边：暗钢 */
  --td-component-stroke: #232d3f;
}
`;

/** 客户端进程内单例；起不来则置 unavailable，本进程后续不再尝试（引擎进程短命，重跑自然重来） */
let clientPromise: Promise<MultiServerMCPClient | null> | null = null;
let unavailable = false;
/** 工具句柄（初始化后缓存，避免每次 getTools 重新协商） */
let docToolPromise: Promise<any | null> | null = null;
/** 进程内文档缓存：组件名 → 原始返回串（"组件不存在" 也缓存，避免重复问同一个幻觉名） */
const docCache = new Map<string, string>();

const STDIO_ENTRY = () => path.join(import.meta.dir, "node_modules", "tdesign-mcp-server", "dist", "stdio.js");

/** 惰性起 MCP stdio 客户端；失败 → null 并置 unavailable（旁路）。启动窗口 20s 判死 */
function ensureClient(): Promise<MultiServerMCPClient | null> {
    if (unavailable) return Promise.resolve(null);
    if (!clientPromise) {
        clientPromise = (async () => {
            try {
                const client = new MultiServerMCPClient({
                    tdesign: { transport: "stdio", command: "node", args: [STDIO_ENTRY()] },
                });
                // 预热一次 getTools：起进程 + 列工具，失败即判通道不可用（不等真正拉文档才暴露）
                await invokeWithTimeout("TDesign MCP 启动", 20_000, () => client.getTools());
                return client;
            } catch (e) {
                console.warn(`[tdesignMcp] 通道启动失败，本进程降级不查文档：${(e as Error).message.slice(0, 120)}`);
                unavailable = true;
                return null;
            }
        })();
    }
    return clientPromise;
}

/** 拿 get-component-docs 工具句柄（缓存）；通道不可用 → null */
async function getDocTool(): Promise<any | null> {
    const client = await ensureClient();
    if (!client) return null;
    if (!docToolPromise) {
        docToolPromise = (async () => {
            try {
                const tools = await invokeWithTimeout("TDesign MCP 取工具", 15_000, () => client.getTools());
                const t = tools.find((x: any) => x.name === "get-component-docs") ?? null;
                if (!t) console.warn("[tdesignMcp] 没找到 get-component-docs 工具");
                return t;
            } catch (e) {
                console.warn(`[tdesignMcp] 取工具失败：${(e as Error).message.slice(0, 120)}`);
                return null;
            }
        })();
    }
    return docToolPromise;
}

/** 规范化组件名：剥 `<t->`、剥尖括号、小写、下划线转连字符（`t-date-picker`/`date_picker`/`<t-date-picker>` → date-picker） */
export function normalizeName(raw: string): string {
    return raw.trim().replace(/^</, "").replace(/>$/, "").replace(/^t-/i, "").replace(/_/g, "-").toLowerCase();
}

/**
 * 批量拉组件文档。返回 组件名 → 原始文档串（真实组件为 `{"api":"..."}`，幻觉为 `"组件不存在"`）；
 * 通道不可用返回 null（调用方据此降级）。已缓存的名不再问 MCP。
 */
export async function fetchComponentDocs(names: string[]): Promise<Record<string, string> | null | undefined> {
    const uniq = [...new Set(names.map(normalizeName))].filter(Boolean);
    if (uniq.length === 0) return {};   // 没名要查：空对象（≠ null，表示"通道在、只是无需查"）

    const tool = await getDocTool();
    if (!tool) return null;             // 旁路信号

    const result: Record<string, string> = {};
    const need: string[] = [];
    for (const n of uniq) {
        if (docCache.has(n)) result[n] = docCache.get(n)!;
        else need.push(n);
    }

    if (need.length > 0) {
        try {
            const out = await invokeWithTimeout(`TDesign 文档(${need.length})`, 45_000,
                sig => tool.invoke({ framework: "vue-next", names: need }, { signal: sig }));
            const text = typeof out === "string" ? out : Array.isArray(out)
                ? out.map((p: any) => (typeof p === "string" ? p : p?.text ?? "")).join("")
                : JSON.stringify(out);
            const parsed = JSON.parse(text);
            for (const n of need) {
                const v = parsed?.[n];
                const doc = typeof v === "string" ? v : v ? JSON.stringify(v) : "";
                result[n] = doc;
                docCache.set(n, doc);   // 幻觉名也缓存，下轮直接命中不再问
            }
        } catch (e) {
            console.warn(`[tdesignMcp] 拉文档失败(需 ${need.length} 个)，本轮降级：${(e as Error).message.slice(0, 120)}`);
            return null;                // 部分成功也没意义，整批旁路
        }
    }
    return result;
}

/** 真实文档判定：非空且不是"组件不存在"。用于幻觉闸门与注入过滤 */
export function isRealDoc(doc: string | undefined | null): boolean {
    if (!doc) return false;
    const s = doc.trim();
    return s.length > 20 && !s.includes("组件不存在");
}

/** 扫描代码里用到的 `<t-xxx>` 组件名（已规范化、去重）。仅匹配 kebab 模板形态——file_prompt 已强制 kebab */
export function extractUsedComponents(code: string): string[] {
    const set = new Set<string>();
    for (const m of code.matchAll(/<t-([a-z][a-z0-9-]*)/g)) { if (m[1]) set.add(m[1]); }
    return [...set];
}

/**
 * 闸门结果：used 里"真实不存在"的组件名（幻觉）。docs 为 null（通道挂）时返回空数组=放行（旁路）。
 */
export function findHallucinated(used: string[], docs: Record<string, string> | null | undefined): string[] {
    if (docs == null) return [];        // 通道不可用：不卡闸门，降级放行
    return used.filter(n => !isRealDoc(docs[n]));
}

/** 退出前关闭通道（同 closeTaskBridge 姿势）：没起过就不起，异常一律吞——清理不该挡住 exit */
export async function closeTdesignMcp(): Promise<void> {
    try {
        const client = clientPromise ? await clientPromise : null;
        if (client) await client.close();
    } catch (e) {
        console.warn("[tdesignMcp] 关闭异常(忽略):", (e as Error).message);
    }
}

/** 把组件文档拼成注入 file_prompt 的段落（只拼真实命中的，控制体量） */
export function buildDocsBlock(names: string[], docs: Record<string, string>): string {
    const lines = names
        .map(normalizeName)
        .filter(n => isRealDoc(docs[n]))
        .map(n => {
            // 原始值是 `{"api":"### Button Props..."}`，抠出 api 正文，去 JSON 壳更省 token
            let body: string = docs[n] ?? "";
            try { const j = JSON.parse(body); body = j?.api ?? body; } catch { /* 不是 JSON 就原样 */ }
            return `### <t-${n}>\n${body}`;
        });
    if (lines.length === 0) return "";
    return `## TDesign 组件真实 API（以下由 MCP 拉取，props/事件/v-model 一律照抄，不得凭记忆改名）\n\n${lines.join("\n\n")}`;
}
