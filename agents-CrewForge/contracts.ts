// ============================================================
// contracts.ts —— 全局契约 CONTRACTS.md（T2，2026-09-08）
//
//   治什么病（F8 零跨任务视野 + F5③ 路由指空 + F15 双 root）：
//   每个任务的 LLM 调用只看得到"自己该写哪些文件"，看不到别的任务写了什么——
//   页面被切散、router 指向从未生成的文件、request.ts 被重复实现，全靠运气对齐。
//
//   方案（v3 §2-T2）：架构师拆完任务、下发之前，一次 LLM 调用产出 runs/pN/CONTRACTS.md
//   （写盘+落库，走 writeWorkspace 现成通道），三工位+测试每次调用头部注入全文（~1KB，成本可忽略）。
//   契约的确定性部分（token 表/接口基约/登记铁律）由代码拼模板——LLM 只负责它擅长的
//   页面清单与共享模块归属（[[crewforge-code-over-tools]]）。
//
//   旁路原则：契约生成失败只 warn，工位照跑（可观测层非控制层——同任务桥/文档通道姿势）。
// ============================================================

import { SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import { initModels } from "./models";
import { retryStructured } from "./llm";
import { readWorkspace, writeWorkspace, type ExecTask, type Plan } from "./common";

/** 产物树里的契约文件名（相对 runs/pN，写盘落库同名，工位按此读） */
export const CONTRACTS_FILE = "CONTRACTS.md";

const CONTRACTS_MODEL_JSON = JSON.stringify({
    provider: "deepseek",
    model: "deepseek-v4-flash",
    temperature: 0.2,
    thinking: false,
});

/** 登记制铁律——F5③（路由指空）与双 root（F15）的治本条款，写死进每份契约，LLM 没资格删 */
export const CONTRACT_LAWS = [
    "## 登记制铁律（违反任何一条，测试工位直接判红）",
    "1. 路由/入口文件（router/index.ts、main.ts、App.vue）只有下表登记的「登记任务」可修改，且只允许**追加**路由/挂载，禁止整文件重写；其余任务碰都不许碰。",
    "2. router 的每一条 component 指向必须在本契约「页面清单」里存在；没登记的文件不许被 import。",
    "3. 共享模块（请求封装/主题/通用工具）由「共享模块」表指定的唯一任务创建，其余任务只 import、禁另起炉灶（同路径重写=抹掉别人成果）。",
    "4. 颜色/圆角/间距只引用「设计 token」与 td-theme.css 的 --td-* 变量，硬编码色值不得超过 5 处。",
    "5. 后端只在自己的模块目录里加文件；一个业务动作一套文件，禁止在两个根目录（app/ 与 backend/）之间摇摆。",
].join("\n");

/** 接口基约（确定性段——具体 path 前缀会随 bootstrap 的 baseURL 配置对齐） */
export const CONTRACT_API_BASE = [
    "## 接口基约",
    "- 前缀 /api/*，请求封装统一走 frontend/src/utils/request.ts（axios 实例，baseURL=/api）",
    "- 响应形态 { code, message, data }，code=0 成功；字段名以各任务的【后端契约】段为准，照抄不改名",
].join("\n");

/** LLM 只写这两段：页面清单（路由→登记任务）+ 共享模块归属 */
export const contracts_schema = z.object({
    pages: z.string(),
    shared: z.string(),
});

export const contracts_prompt: string = `
# 角色
你是 CrewForge 项目的架构师-契约登记 Agent。接口任务已拆分完毕，你负责把它们登记成一份全局契约，
让每个开发任务开工前都能看到"别人会写什么、谁对哪个文件负责"。

## 输入
本阶段任务清单（每条含 id/layer/title/files）+ 业务模块说明。

## 任务
1. pages——【页面清单】：逐条列出前端任务的路由与文件归属。每行严格用这个格式（尖括号是占位符，替换成真实值）：
   - <路由path> → <文件路径>（登记任务 <任务id>，router 追加责任归它）
   路由从任务 title/description 推断；纯组件（非整页）也要列，路由位置写 (组件)。
2. shared——【共享模块】：从所有任务的 files 里找出会被多个任务用到的公共文件（request/theme/公共组件/布局）。每行严格用这个格式：
   - <文件路径>（创建任务 <首次出现该文件的任务id>，其余任务只 import 禁重写）
   没有共享文件就写一行「- 无」。files 里没有的文件不许发明。

## 边界
- 只登记输入中出现过的任务与文件，不新增页面、不改文件名、不发明路由之外的东西。
- 输出 JSON：{"pages": "...", "shared": "..."}，两段都是纯 Markdown 列表文本。
`;

/** 风格真相段（确定性文本）——不做风格预设（9/8 用户拍板），单一来源=地基落盘的 td-theme.css */
export const CONTRACT_STYLE_SECTION = [
    "## 视觉 token（单一来源，全站唯一）",
    "- 主题文件 frontend/src/styles/td-theme.css 的 --td-* 变量就是全部视觉真相（主色/底色/文字/描边/圆角），提示词注入与落盘文件同源",
    "- 组件库 tdesign-vue-next，只用 <t-*> 白名单组件；样式引用变量，硬编码色值全站不得超过 5 处",
].join("\n");

/** 拼装最终 md：确定性三段 + LLM 两段。LLM 段落缺失/格式漂了也只丢那两段，骨架照落 */
export function assembleContracts(phaseNo: number, plan: Plan | null, llm: { pages: string; shared: string } | null): string {
    const head = `# 项目契约（阶段 ${phaseNo} 生成，所有工位 prompt 头部注入；本阶段产物以此为准）\n\n` +
        `业务目标：${plan?.phases.find(p => p.phase === phaseNo)?.goal ?? plan?.mvp_scope?.join("；") ?? "（见任务清单）"}\n\n`;
    const pages = llm?.pages?.trim() || "- （契约登记降级：LLM 未产出页面清单，各任务按自身 files 自行约束，router 改动归各任务）";
    const shared = llm?.shared?.trim() || "- 无";
    return head +
        CONTRACT_STYLE_SECTION + "\n\n" +
        "## 页面清单（router 追加责任唯一化）\n" + pages + "\n\n" +
        "## 共享模块（唯一创建者负责制）\n" + shared + "\n\n" +
        CONTRACT_API_BASE + "\n\n" + CONTRACT_LAWS + "\n";
}

/**
 * 生成并落盘本阶段契约（architect dispatch 在任务构建后、下发前调用）。
 * 返回 md 原文；失败返回 null（旁路，不阻塞下发）。
 */
export async function publishContracts(phaseNo: number, plan: Plan | null, tasks: ExecTask[]): Promise<string | null> {
    const taskLines = tasks.map(t => `- ${t.id} [${t.layer}] ${t.title}｜files: ${t.files.join(", ") || "（无）"}`).join("\n");
    try {
        const llm = await retryStructured("契约登记", async (feedback, sig) => {
            const model = initModels(CONTRACTS_MODEL_JSON);
            const result = await model
                .withStructuredOutput(contracts_schema, { method: "jsonMode", name: "extract_contracts" })
                .invoke([new SystemMessage(
                    contracts_prompt +
                    `\n\n## 本阶段任务清单（阶段 ${phaseNo}）\n${taskLines}` +
                    feedback,
                )], { signal: sig });
            return result as { pages: string; shared: string };
        });
        const md = assembleContracts(phaseNo, plan, llm ?? null);
        const full = writeWorkspace(CONTRACTS_FILE, md);
        console.log(`[contracts] 阶段 ${phaseNo} 契约已发布：${full}（${tasks.length} 个任务登记）`);
        return md;
    } catch (e) {
        // 旁路：契约缺了流水线照跑（等于回到 T2 前），但绝不因它卡死下发
        console.warn("[contracts] 契约生成失败（旁路放行，工位按无契约运行）:", (e as Error).message);
        return null;
    }
}

/** 工位侧读取（DB 通道，进程内 60s 缓存——契约每阶段只发布一次，读得勤没必要） */
let cache: { md: string | null; at: number } | null = null;
export async function loadContracts(force = false): Promise<string | null> {
    if (!force && cache && Date.now() - cache.at < 60_000) return cache.md;
    let md: string | null = null;
    try { md = await readWorkspace(CONTRACTS_FILE); } catch { md = null; }   // 无 pid/无库：契约缺席=正常旁路
    cache = { md, at: Date.now() };
    return md;
}

/** 拼进工位 prompt 的契约段（紧跟角色规约之后、任务之前——卡面"头部注入"） */
export function contractPromptBlock(md: string | null): string {
    if (!md) return "";
    return `\n\n## 项目契约 CONTRACTS.md（全局唯一真相：文件归属/路由登记/风格 token/接口基约以此为准，与上文冲突时按契约执行）\n${md}`;
}

/** smoke/测试用：清缓存（换项目跑时防止上一单的契约串进来） */
export function resetContractsCache(): void { cache = null; }
