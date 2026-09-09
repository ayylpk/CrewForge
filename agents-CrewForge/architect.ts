// ============================================================
// architect.ts —— 架构师（单例 "architect"）
//
//   完整逻辑移植自 _legacy-agents/architect.ts，结构参照 manager.ts：
//     phase_plan → 拆分图（业务分解 → 技术栈 → 确认门 → 基础架构 → 接口拆分 → 下发）
//     phase_done → 转告 PM 请求下一阶段
//
//   拆分图走 GraphFactory 的 stitch()：DB 存声明（DEFAULT_NODES/EDGES），
//   实现注册进 codeRegistry / schemaRegistry / condRegistry。
//   确认门用 human 交互（runWithInteraction + pickQuestioner：阶段 3 三分流——
//   AUTO_CONFIRM 自动 y / Java 管理进程 Web 问答卡 / 手工终端真 stdin）。
//   接口拆分失败/被拒 → 声明 0 对并 final，阶段直接完成（不卡死）。
// ============================================================

import { z } from "zod";
import { SystemMessage } from "@langchain/core/messages";
import { Annotation } from "@langchain/langgraph";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { BaseAgent } from "./BaseAgent";
import { roles, type TransferStation } from "./Hub";
import { initModels } from "./models";
import { retryStructured } from "./llm";
import {
    stitch, runWithInteraction,
    codeRegistry, schemaRegistry, condRegistry,
    type StateNodeFn, type CondFn,
} from "./GraphFactory";
import { type Node, type Edge, saveArchitectOutput, readProjectFile, getProjectConfirmMode } from "./Node";
import { writeWorkspace, type Pair, type ExecTask, type Plan, type planItem, REQUEST_WRAPPER_PATH, REQUEST_WRAPPER_CODE } from "./common";
import { currentProjectId, projectDir } from "./runEnv";
import { ensureTasksForPhase, getTasksByStatus, updateStatusByExt } from "./task";
import { pickQuestioner } from "./confirm";
import { TDESIGN_THEME_CSS } from "./tdesignMcp";
import { buildKnown, checkBatch } from "./checkers";
import { publishContracts } from "./contracts";

// ---------- 模型 ----------

const ARCHITECT_MODEL_JSON = JSON.stringify({
    provider: "deepseek",
    model: "deepseek-v4-flash",
    temperature: 0.3,
    thinking: false,
});

// ---------- 提示词（移植自 _legacy-agents/architect.ts） ----------

export const plan_prompt: string = `
# 角色
你是 CrewForge 项目的架构师-业务规划 Agent。你的输出是当前阶段的业务模块蓝图，供技术栈设计和接口拆分继续使用。

## 任务
1. 将本阶段的每个功能拆成一个业务模块，business 必须填写输入中的原始功能名。
2. description 描述角色、触发条件、主要步骤、状态变化和结果，不写实现代码。
3. dataNeeds 只列出实现该模块确实需要持久化或读取的数据，写实体和字段需求，不设计表结构。
4. points 拆成可执行的业务子步骤，覆盖正常流程和关键异常分支，供接口拆分使用。

## 边界
- 只处理输入中已确认的功能，不新增、不合并、不改变功能含义。
- 不做技术选型，不指定框架、数据库、表名或接口路径。
- 不把可选建议写成必做事项；信息不足时在 risks 中指出，不要猜测。
- 模块必须覆盖输入的全部功能，不能遗漏；一个功能对应一个模块。

## 输出
只输出合法 JSON，不要 Markdown、解释或额外字段：
{
  "summary": "一句话：本阶段做哪些业务",
  "modules": [
    {
      "name": "模块名",
      "business": "对应功能名",
      "description": "角色、触发条件、主要步骤、状态变化和结果",
      "dataNeeds": ["实体或字段需求"],
      "points": ["可执行的业务子步骤"]
    }
  ],
  "risks": ["业务实现风险"],
  "deliverables": ["交付物清单"]
}
`;

export const stack_prompt: string = `
# 角色
你是 CrewForge 项目的架构师-技术落地 Agent。你的输出是当前阶段唯一的技术基线，供基础架构和开发 Agent 使用。

## 任务
1. 只选择当前阶段实际需要的中间件，并说明每项用途；不要为了完整而堆叠技术。
2. 将 dataNeeds 落成可实现的表和字段，字段类型、必填性和业务含义必须明确，避免重复存储和无法验证的字段。
3. 为每个业务模块绑定服务端和客户端技术。backend 只写服务端框架、ORM、数据库访问等；frontend 只写前端框架、UI 和请求库等。
4. why 说明关键取舍，并指出会影响后续开发的风险。

## 约束
- 技术选择必须服务于输入中的业务模块和数据需求，不新增业务功能。
- moduleTech 必须覆盖每个输入模块，module 名必须原样复制。
- 表字段应能支撑输入中的功能和验收，不设计与当前阶段无关的表。
- 前端技术栈固定为 Vue 3 + TDesign Vue Next（9/5 拍板 [[frontend-uilib-trial-0903]]）：只在此范围内细化（主题走 --td-* 变量覆盖、按需引入），不得改用其他组件库。
- 不输出接口路径、文件清单或代码；这些由后续 Agent 负责。

## 输出
只输出合法 JSON，不要 Markdown、解释或额外字段：
{
  "techniques": {
    "middleware": [{ "name": "技术名", "purpose": "用途" }],
    "database": { "type": "数据库类型", "why": "为什么选它" }
  },
  "tables": [
    { "name": "表名", "purpose": "服务哪个数据需求", "fields": [{ "name": "字段名", "type": "类型", "required": true, "remark": "业务含义" }] }
  ],
  "moduleTech": [{ "module": "模块名", "backend": "服务端技术", "frontend": "客户端技术" }],
  "why": "整体选型理由"
}
`;

export const base_prompt: string = `
# 角色
你是 CrewForge 项目的架构师-基础架构 Agent，负责把当前阶段需要的工程基础动作整理成可执行清单。

## 任务
根据技术栈、表结构和交付物清单：
1. actions 列出需要新建或补齐的脚手架、配置、目录和依赖。已有基础只列缺失项。
2. ddl 将输入表结构落成与目标数据库匹配的建表 SQL，包含必要的主键、约束和索引。

## 约束
- 只补基础设施，不新增业务功能，不设计接口，不写业务代码。
- actions 必须具体到后续开发可以执行；无法确认的前置条件写入动作描述，不要擅自选择。

## 输出
只输出合法 JSON，不要 Markdown、解释或额外字段：
{ "actions": ["基建动作"], "ddl": "建表 SQL" }
`;

/** bootstrap 提示词：把 basePlan（actions/ddl）变成真实的地基文件内容（脚手架/配置/DDL） */
export const bootstrap_prompt: string = `
# 角色
你是 CrewForge 项目的架构师-工程地基落地 Agent。输入是基础架构清单（actions + ddl），输出是可直接写盘的项目地基文件。

## 输入
1. actions：需要新建或补齐的脚手架、配置、目录和依赖动作（字符串列表，可能较长）
2. ddl：与目标数据库匹配的建表 SQL
3. techStack：技术选型（中间件/数据库/技术绑定），用于生成依赖与配置

## 任务
把 actions 和 ddl 转成**具体的文件**，每个文件包含完整可直接使用的 content：
- 依赖/脚手架动作 → 生成对应的构建文件（如 pom.xml、package.json 依赖段）
- 配置动作 → 生成对应的配置文件（如 application.yml、vite.config、.env.example）
- 目录动作 → 用空文件占位（content 留空字符串即可，如 src/main/java/.gitkeep）
- ddl → 生成 ddl.sql 文件，原样保留建表 SQL
- 无法确定内容的动作 → 跳过，不要编造

## 约束
- 只写项目地基文件（脚手架/配置/DDL/占位），绝不写业务代码（Controller/Service/页面组件由开发 Agent 负责）
- 前端脚手架的 package.json 必须包含 vue、vite、@vitejs/plugin-vue，以及 UI 库 tdesign-vue-next 与按需引入插件 unplugin-vue-components（前端栈固定 Vue3 + TDesign，见 9/5 拍板 [[frontend-uilib-trial-0903]]）
- 前端脚手架必须产出请求封装 frontend/src/utils/request.ts：创建 axios 实例（baseURL='/api'，timeout=10000）并 default 导出；业务页面统一从该路径 import，不得另起 services/api.js 之类的别名（p2 复盘修①，9/9：契约基约与前端工位 prompt 都钉死这个路径，地基必须供得上）
- path 使用相对路径（如 pom.xml、src/main/resources/application.yml），不含 ../
- content 必须是完整可用的文件内容；占位文件 content 用空字符串
- 文件数量控制在合理范围（5-15 个），不要重复造轮子

## 输出
只输出合法 JSON，不要 Markdown、解释或额外字段：
{ "files": [ { "path": "pom.xml", "content": "文件完整内容" } ] }
`;

export const api_prompt: string = `
# 角色
你是 CrewForge 项目的架构师-功能拆分 Agent。你的输出是"功能竖切"任务对：一个功能 = 一个后端任务 + 一个前端任务，供开发 Agent 整块实现和验收。

## 任务
1. 按业务闭环把模块圈成功能竖切（通常一个输入模块=一个功能）；每个功能产出一对任务，顺序固定为后端在前、前端在后。
2. 后端任务：列出该功能的全部接口 apis（几个列几个，不许为凑数拆碎，也不许把两个功能并进来）；files 是所有接口涉及文件的合集，同一功能的文件不得散到别的任务。
3. 前端任务：列出该功能的全部页面（列表/详情/表单算多页）；interactions 写清每页交互；files 含该功能全部页面/组件文件——一个页面的模板、样式、接口调用都归这一个任务。
4. 每页的组件/样式/接口调用不许拆给别的任务做（T4 竖切铁律：页面是原子）。

## 输入
业务模块（数据需求 + 实现要点）+ 技术绑定（每个模块用什么技术实现，backend/frontend 分开）

## 边界
- 只设计接口和页面形态，不写实现代码，不发明输入中没有的业务规则。
- feature 必须原样使用输入里的模块名/功能名，不能自创或改写；前后端两半的 feature 必须相同。
- 参数 type 只能使用 string、number、boolean、array、object；required 必须反映业务必填性。
- 前端页面调用的 path 必须出自同一任务对后端 apis 的 method+path，字段名一致。
- files 是开发 Agent 唯一允许产出的文件清单：按技术栈列全，不遗漏、不填无关文件。
- router/index.ts、main.ts 这类全局登记文件只允许归一个 feature 任务（通常第一个前端功能），其余功能不许列它（追加登记由契约铁律约束）。
- 每个任务的验收标准继承对应模块的业务要求，不新增无法追溯的验收条件。

## 输出
只输出合法 JSON，不要 Markdown、解释或额外字段。tasks 是二维数组，每项固定为 [后端任务, 前端任务]：
{
  "tasks": [
    [
      { "feature": "功能名",
        "apis": [
          { "method": "POST", "path": "/api/tasks", "purpose": "接口职责", "files": ["backend/app/routers/tasks.py"], "parameters": [{ "name": "title", "type": "string", "required": true, "description": "任务标题" }], "response": "返回说明" }
        ] },
      { "feature": "功能名",
        "pages": [
          { "page": "页面名", "interactions": "页面交互（表单/列表/刷新等）", "files": ["frontend/src/views/Tasks.vue"] }
        ] }
    ]
  ]
}
`;

// ---------- 结构化 schema（schemaRegistry，DB 的 schema_key 引用） ----------

export const detailedPlanSchema = z.object({
    summary: z.string(),
    modules: z.array(z.object({
        name: z.string(),
        business: z.string(),
        description: z.string(),
        dataNeeds: z.array(z.string()),
        points: z.array(z.string()),
    })),
    risks: z.array(z.string()),
    deliverables: z.array(z.string()),
});

export const stackSchema = z.object({
    techniques: z.object({
        middleware: z.array(z.object({ name: z.string(), purpose: z.string() })),
        database: z.object({ type: z.string(), why: z.string() }),
    }),
    tables: z.array(z.object({
        name: z.string(),
        purpose: z.string(),
        fields: z.array(z.object({ name: z.string(), type: z.string(), required: z.boolean(), remark: z.string() })),
    })),
    moduleTech: z.array(z.object({ module: z.string(), backend: z.string(), frontend: z.string() })),
    why: z.string(),
});

export const baseSchema = z.object({
    actions: z.array(z.string()),
    ddl: z.string(),
});

// 工程地基文件清单：bootstrap 节点把 basePlan 转成可写盘的文件
export const bootstrapSchema = z.object({
    files: z.array(z.object({
        path: z.string(),
        content: z.string(),
    })),
});

// 接口拆分（T4 竖切，9/8）：任务单位从"一个接口"升级为"一个功能竖切"；
// pair 语义原样保留——同一 feature 的后端任务 + 前端任务成对（同编号 T{n}/T{n}-F），
// merger/maintainer/消息协议零改动（卡面：只动拆分与生成层，Hub 不背锅）
export const resolutionSchema = z.object({
    tasks: z.array(z.tuple([
        z.object({
            feature: z.string(),                 // 功能竖切名（原样使用输入模块/功能名）
            apis: z.array(z.object({             // 该功能的全部接口（可多个）
                method: z.string(),
                path: z.string(),
                purpose: z.string(),
                files: z.array(z.string()),
                parameters: z.array(z.object({
                    name: z.string(),
                    type: z.string(),
                    required: z.boolean(),
                    description: z.string(),
                })),
                response: z.string(),
            })).min(1),
        }),
        z.object({
            feature: z.string(),
            pages: z.array(z.object({            // 该功能的全部页面（整页归一任务，不再按接口切散）
                page: z.string(),
                interactions: z.string(),
                files: z.array(z.string()),
            })).min(1),
        }),
    ])),
});

type ResolutionApi = z.infer<typeof resolutionSchema>["tasks"][number][0]["apis"][number];
type ResolutionBack = z.infer<typeof resolutionSchema>["tasks"][number][0];
type ResolutionFront = z.infer<typeof resolutionSchema>["tasks"][number][1];

// ---------- 机械构建（T4 竖切核心：纯函数，dispatch/redesignTask 共用，t4-smoke 狗考入口） ----------

/** 一组接口的契约文本行（description 自包含铁律的载体：机械拼，不劳 LLM） */
function apiContractBlock(apis: ResolutionApi[]): string {
    return apis.map(a =>
        `- ${a.method} ${a.path}（${a.purpose}）\n  入参：${a.parameters.map(p => `${p.name}(${p.type}${p.required ? "" : "，可选"})：${p.description}`).join("、") || "无"}\n  返回：${a.response}`,
    ).join("\n");
}

/**
 * 功能竖切 → ExecTask 对（id/配对/验收继承/自包含契约的全量规矩都在这）。
 * method/path 带主接口只为看板列可读；真实契约看 description 的接口清单。
 * 验收标准从 Plan.features 按模块 business 机械抄（验收契约不发明）。
 */
export function buildExecTasks(
    parsed: { tasks: [ResolutionBack, ResolutionFront][] },
    detailed: any, stack: any, plan: Plan,
): ExecTask[] {
    const middlewareContent = (stack?.techniques?.middleware ?? []).map((m: any) => `${m.name}（${m.purpose}）`).join("、");
    const dbContent = `${stack?.techniques?.database?.type ?? ""}（${stack?.techniques?.database?.why ?? ""}）`;
    return parsed.tasks.flatMap((pair, i) => {
        const [back, front] = pair;
        const mod = (detailed?.modules ?? []).find((m: any) => m.name === back.feature)
            ?? (detailed?.modules ?? []).find((m: any) => back.feature.includes(m.name) || m.name.includes(back.feature));
        const acceptance = plan.features.find((f: any) => f.name === mod?.business)?.acceptance
            ?? plan.features.find((f: any) => f.name === back.feature)?.acceptance ?? "功能可正常使用";
        const mtech = (stack?.moduleTech ?? []).find((mt: any) => mt.module === back.feature)
            ?? (stack?.moduleTech ?? []).find((mt: any) => back.feature.includes(mt.module) || mt.module.includes(back.feature));
        const backendTech = mtech?.backend ?? "";
        const frontendTech = mtech?.frontend ?? "";
        const apiBlock = apiContractBlock(back.apis);
        const primary = back.apis[0]!;

        const backendTask: ExecTask = {
            id: `T${i + 1}`,
            layer: "backend",
            method: primary.method,
            path: primary.path,
            files: [...new Set(back.apis.flatMap(a => a.files))],
            title: `功能 ${back.feature}${back.apis.length > 1 ? `（${back.apis.length} 个接口）` : ""}`,
            description: `模块/功能：${back.feature}\n业务：${mod?.business ?? ""}\n技术：${backendTech}\n中间件：${middlewareContent}\n数据库：${dbContent}\n包含接口（${back.apis.length} 个，全部必须实现）：\n${apiBlock}`,
            parameters: primary.parameters,
            acceptance,
        };

        // 自包含铁律（保持）：整组接口契约机械抄进前端描述——竖切后一任务多页面，契约仍是一套
        const contract = `\n\n【后端契约（前端必须遵守：字段名/格式/枚举值照抄，不得改名）】\n${apiBlock}`;
        const frontendTask: ExecTask = {
            id: `T${i + 1}-F`,
            layer: "frontend",
            method: primary.method,
            path: primary.path,
            files: [...new Set(front.pages.flatMap(p => p.files))],
            title: `功能 ${front.feature}：${front.pages.map(p => p.page).join("、")}`,
            description: `模块/功能：${front.feature}\n业务：${mod?.business ?? ""}\n技术：${frontendTech}\n` +
                front.pages.map(p => `页面：${p.page}\n交互：${p.interactions}`).join("\n") + contract,
            parameters: [],
            acceptance,
        };
        return [backendTask, frontendTask];
    });
}

// ---------- 节点实现（codeRegistry，DB 的 code_key 引用） ----------

/**
 * TDesign 地基强制（9/5 集成，代码兜底不靠提示词自觉）：
 *  ① 前端形态的 package.json（路径以 frontend|web|client|ui 开头，或依赖里已有 vue/vite）
 *     → 缺 tdesign-vue-next / unplugin-vue-components 就合并进去（已有的绝不动，防覆盖用户改过的版本）；
 *  ② 整批文件没有含 --td-* 的 theme css → 补一份 frontend/src/styles/td-theme.css。
 * 背景：stack/bootstrap 提示词会被 DB 旧行覆盖（sys_agent_node 早先入库），代码侧才钉得住。
 * 导出供 smoke 测试。
 */
export function enforceTdesignFoundation(files: { path: string; content: string }[]): void {
    for (const f of files) {
        if (!/package\.json$/i.test(f.path) || !f.content) continue;
        let pkg: any;
        try { pkg = JSON.parse(f.content); } catch { continue; }   // 非 JSON：留给测试工位，这里不硬来
        const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
        const isFrontend = /^(frontend|web|client|ui)[\\/]/i.test(f.path)
            || Object.keys(allDeps).some(d => /^vue$|^vite$|tdesign/i.test(d));
        if (!isFrontend) continue;
        pkg.dependencies = { "tdesign-vue-next": "^1.20.7", ...(pkg.dependencies ?? {}) };
        pkg.devDependencies = { "unplugin-vue-components": "latest", ...(pkg.devDependencies ?? {}) };
        f.content = JSON.stringify(pkg, null, 2);
        console.log(`[architect] TDesign 地基：${f.path} 已合并组件库依赖`);
    }
    const hasTheme = files.some(f => /\.css$/i.test(f.path) && (f.content ?? "").includes("--td-"));
    if (!hasTheme && files.length > 0) {
        files.push({ path: "frontend/src/styles/td-theme.css", content: TDESIGN_THEME_CSS });
        console.log("[architect] TDesign 地基：补写 frontend/src/styles/td-theme.css（--td-* 主题兜底）");
    }
}

/**
 * p2 复盘修①（9/9）：前端请求封装代码强制保底——34 次编译打回里 20 次死在幽灵 import "../utils/request"。
 * 病根是三方漂移：bootstrap 批由 LLM 自由发挥（p2 造出 services/api.js），而契约接口基约和
 * frontendEngineer 的 prompt 都写着 utils/request.ts——模型忠实执行 prompt 就 import 到空。
 * 规矩（同 enforceTdesignFoundation 姿势：代码兜底不靠提示词自觉，DB 旧 prompt 顶不掉）：
 *   ① 批内有前端形态文件而标准路径没有封装 → 补写 <前端根>/src/utils/request.ts（内容=common.ts 常量，
 *      与前端工位注入的 prompt 严格同源，教的路径=盘上真实存在）；
 *   ② 前端 package.json 缺 axios 就合并进去（有封装没依赖=编译过、build 炸）；
 *   ③ LLM 另起的名字（services/api.js 等）一律不管——标准文件在场，两种 import 都能命中；
 *      重复是瑕疵，幽灵才是致命（去重归 #7 扩展名单轨管）。
 * 导出供 smoke 狗考。
 */
export function ensureRequestFoundation(files: { path: string; content: string }[]): void {
    if (files.length === 0) return;
    const FRONT_RE = /^(frontend|web|client|ui)[\\/]/i;
    const front = files.find(f => FRONT_RE.test(f.path ?? ""));
    if (!front) return;   // 无前端形态（纯后端/web=false 项目）：不掺和
    // 前端根目录取批内首个前端文件的第一段（通常 frontend/；web/client/ui 形态也钉得住，别硬写死）
    const root = ((front.path ?? "").replace(/\\/g, "/").split("/")[0] ?? "frontend").toLowerCase();
    const wrapperPath = root === "frontend" ? REQUEST_WRAPPER_PATH : `${root}/src/utils/request.ts`;
    const canonicalRe = new RegExp(`^${root}/src/utils/request\\.(ts|js)$`, "i");
    let hasWrapper = false;
    for (const f of files) {
        const p = (f.path ?? "").replace(/\\/g, "/");
        if (canonicalRe.test(p)) { hasWrapper = true; continue; }
        if (/package\.json$/i.test(p) && FRONT_RE.test(p) && f.content) {
            let pkg: any;
            try { pkg = JSON.parse(f.content); } catch { continue; }   // 非 JSON：留给编译闸门/测试工位，这里不硬来
            if (!pkg.dependencies?.axios && !pkg.devDependencies?.axios) {
                pkg.dependencies = { axios: "^1.7.0", ...(pkg.dependencies ?? {}) };
                f.content = JSON.stringify(pkg, null, 2);
                console.log(`[architect] p2 修①：${p} 已合并 axios 依赖`);
            }
        }
    }
    if (!hasWrapper) {
        files.push({ path: wrapperPath, content: REQUEST_WRAPPER_CODE });
        console.log(`[architect] p2 修①：补写 ${wrapperPath}（axios 实例，baseURL=/api，与契约/前端 prompt 同源）`);
    }
}

/** 工程地基落地：读 basePlan（actions/ddl）→ LLM 转文件清单 → 逐个写盘（沙箱校验） */
const bootstrapNode: StateNodeFn = async (state, node) => {
    const basePlan = state?.basePlan;
    // 没有地基计划（确认门被拒等）→ 跳过，不卡流水线
    if (!basePlan || !Array.isArray(basePlan.actions)) {
        console.log("[architect] bootstrap：无 basePlan，跳过地基落地");
        return {};
    }
    const prompt = node?.systemPrompt?.trim() || bootstrap_prompt;
    const stack = state?.stack ?? {};
    // 读取当前项目已有的地基文件，供 LLM 参考（追加修改时保留已有内容）
    let existingFilesPrompt = "";
    try {
        const pid = currentProjectId();
        if (pid) {
            const commonPaths = ["pom.xml", "package.json", "application.yml", "application.properties",
                "vite.config.ts", "tsconfig.json", ".env.example", "docker-compose.yml"];
            const existing: string[] = [];
            for (const p of commonPaths) {
                const content = await readProjectFile(pid, p);
                if (content) existing.push(`--- ${p} ---\n${content.slice(0, 20000)}`);
            }
            if (existing.length > 0) {
                existingFilesPrompt = `\n\n## 项目已有的文件（在此之上修改/追加，保留所有已有配置）\n${existing.join("\n")}`;
            }
        }
    } catch { /* 静默 */ }
    try {
        const parsed = await retryStructured<{ files: { path: string; content: string }[] }>(
            "工程地基落地",
            async (feedback, sig) => {
                const model = initModels(ARCHITECT_MODEL_JSON, "architect");
                const result = await model
                    .withStructuredOutput(bootstrapSchema, { method: "jsonMode", name: "extract_bootstrap" })
                    .invoke([
                        new SystemMessage(
                            prompt +
                            `\n\n## 基础架构动作（basePlan）\n${JSON.stringify(basePlan, null, 2)}` +
                            `\n\n## 技术选型（stack）\n${JSON.stringify(stack, null, 2)}` +
                            existingFilesPrompt +
                            feedback,
                        ),
                    ], { signal: sig });
                const out = result as { files: { path: string; content: string }[] };
                out.files = out.files ?? [];
                // T1 编译闸门（9/8）：地基一次吐几十个完整文件，同样过检——代码强制（enforce 挪进回调）
                // 之后整批校验，任一台红就 throw：retryStructured 把报错原文截 400 字喂回下一轮
                // （卡面"编译器报错原文喂回、话术同 retryStructured"零新增机关，现成反馈环直接复用）
                enforceTdesignFoundation(out.files);
                ensureRequestFoundation(out.files);   // p2 修①（9/9）：契约基约/前端 prompt 都钉 utils/request.ts，地基代码保证供得上
                const pid = currentProjectId();
                const known = buildKnown(pid != null ? projectDir(pid) : null, undefined, out.files.map(f => f.path));
                const reds = await checkBatch(out.files, known);
                if (reds.size > 0) {
                    throw new Error(`地基文件未过编译闸门：${[...reds.entries()].map(([p, ps]) => `${p} → ${ps.join("；")}`).join(" ｜ ")}`);
                }
                return out;
            },
            // 地基是流水线输出量最大的节点（5-15 个完整文件内容），180s 默认超时不够，单独放宽到 300s
            { timeoutMs: 300_000 },
        );
        const files = parsed?.files ?? [];
        for (const f of files) {
            if (!f?.path) continue;
            try {
                writeWorkspace(f.path, f.content ?? "");
                console.log(`[architect] 地基文件已写入：${f.path}`);
            } catch (e) {
                console.warn(`[architect] 地基文件写入失败（跳过）：${f.path} - ${(e as Error).message}`);
            }
        }
        console.log(`[architect] 地基落地完成：${files.length} 个文件`);

        // 状态落盘（含地基就绪标记）：阶段 2+ 的 runPhaseSplit 读回 → 条件边短路跳过技术栈/确认门/地基
        const pid = currentProjectId();
        if (pid != null) {
            try {
                const stateFile = projectDir(pid) + "/.architect-state.json";
                fs.mkdirSync(projectDir(pid), { recursive: true });
                fs.writeFileSync(stateFile, JSON.stringify(
                    { bootstrapDone: true, stack: state?.stack ?? null, basePlan: state?.basePlan ?? null },
                    null, 2,
                ));
                console.log("[architect] 架构状态已落盘：.architect-state.json（后续阶段将短路复用）");
            } catch (e) {
                console.warn("[architect] 架构状态落盘失败:", (e as Error).message);
            }
        }
        return { bootstrapFiles: files, bootstrapDone: true };
    } catch (e) {
        // LLM 失败不阻塞流水线：记录并继续（地基缺失，开发仍按接口任务写代码）
        console.warn("[architect] 工程地基落地失败（跳过）:", (e as Error).message);
        return {};
    }
};

/** 确认门：human 交互（y/n），把答案保留进 confirmAnswer 供条件边判断（humanGate 会清掉 humanAnswer）
 *  确认模式控制：0-全绿灯(自动) / 1-混合(自动) / 2-手动(弹出确认) */
const confirmNode: StateNodeFn = async (state, node) => {
    if (state.humanAnswer != null) {
        return { human: null, confirmAnswer: state.humanAnswer, humanAnswer: null };
    }
    const mode = state.confirmMode ?? 0;
    // 全绿灯(0) 或 混合(1)：架构师确认门自动跳过
    if (mode === 0 || mode === 1) {
        return { human: null, confirmAnswer: "y", humanAnswer: null };
    }
    return { human: { questionId: randomUUID(), prompt: node?.systemPrompt?.trim() || "技术方案如上，确认开工？(y / n)", options: ["y", "n"] } };
};

/** 接口拆分 + 任务构建 + 下发（station 副作用）。返回 exeTasks。 */
function makeDispatchNode(station: TransferStation): StateNodeFn {
    return async (state) => {
        const plan: Plan = state.plan;
        const detailed: any = state.detailedPlan;
        const stack: any = state.stack;
        if (!plan || !detailed || !stack) throw new Error("接口拆分缺少前置输入（plan/detailedPlan/stack）");

        const phaseNo = plan.phases[0]?.phase ?? 1;

        // 1. LLM 接口拆分（api_prompt + 业务模块 + 技术绑定；重试 ≤3 带反馈）
        const modulesContent = detailed.modules
            .map((m: any) => `${m.name}（对应功能：${m.business}）\n   数据需求：${(m.dataNeeds ?? []).join("、")}\n   要点：${(m.points ?? []).join("；")}`)
            .join("\n");
        const techContent = (stack.moduleTech ?? [])
            .map((mt: any) => `${mt.module} → 后端：${mt.backend}｜前端：${mt.frontend}`)
            .join("\n");

        const parsed = await retryStructured<{ tasks: [ResolutionBack, ResolutionFront][] }>(
            "接口拆分",
            async (feedback, sig) => {
                const model = initModels(ARCHITECT_MODEL_JSON, "architect");
                const result = await model
                    .withStructuredOutput(resolutionSchema, { method: "jsonMode", name: "extract_resolution" })
                    .invoke([new SystemMessage(api_prompt + `\n\n## 业务模块（阶段${detailed.phase}）\n${modulesContent}\n\n## 技术绑定\n${techContent}` + feedback)], { signal: sig });
                return result as { tasks: [ResolutionBack, ResolutionFront][] };
            },
        );
        if (!parsed || parsed.tasks.length === 0) throw new Error("接口拆分返回空任务（tasks 为空数组）");

        // 2. 机械构建 ExecTasks（T4 竖切版：抽成纯函数 buildExecTasks，redesignTask 共用、t4-smoke 直测）
        const tasks: ExecTask[] = buildExecTasks(parsed, detailed, stack, plan);

        // 2.5 T2 全局契约（9/8）：拆完任务、下发之前发布 CONTRACTS.md——
        // 三工位+测试每次调用头部注入（contracts.ts 读同一份），路由登记/文件归属从此有据可依。
        // 发布失败只 warn 不拦下发（旁路）；契约本身也随 writeWorkspace 落库进 sys_project_file
        try { await publishContracts(phaseNo, plan, tasks); }
        catch (e) { console.warn("[architect] 契约发布异常（旁路，工位按无契约运行）:", (e as Error).message); }

        // 3. 副作用：按层分流下发开发 + 声明给维护（final）+ 通知合并器清配对缓存
        for (const t of tasks) {
            t.phase = phaseNo;   // 阶段 3：任务自带归属阶段，工位/维护写 sys_task 时按 (project,phase,ext) 定位
            const role = t.layer === "backend" ? roles.backendEngineer : roles.frontendEngineer;
            const target = station.pickLeastBusy(role);
            if (!target) { console.log(`提示：没有 ${t.layer} 开发注册，任务 ${t.id} 下发失败`); continue; }
            station.sendMessage("architect", target, JSON.stringify({ type: "task", task: t }));
            console.log(`[architect] 发送到 ${target}：下发任务 ${t.id}（${t.title}）`);
        }
        const pairIds = [...new Set(tasks.map(t => (t.id.endsWith("-F") ? t.id.slice(0, -2) : t.id)))];
        station.sendMessage("architect", "maintainer", JSON.stringify({ type: "tasks_declared", phase: phaseNo, pairIds, final: true }));
        console.log(`[architect] 声明阶段 ${phaseNo} 任务 ${pairIds.length} 对（final）`);
        station.sendMessage("architect", "merger", JSON.stringify({ type: "phase_reset", phase: phaseNo }));
        console.log(`[architect] 通知合并器：阶段 ${phaseNo} 配对缓存重置`);

        return { exeTasks: tasks, llmCalls: 1 };
    };
}

// ---------- 条件（condRegistry，条件边的 cond 引用） ----------

/** 确认门：回答 y → 去基础架构；n / 未答 → 结束（本阶段跳过，runPhaseSplit 声明 0 对） */
const confirmYes: CondFn = (state) => String(state.confirmAnswer ?? "").trim().toLowerCase().startsWith("y");

// ---------- 默认声明（模板可直接 new Architect(station)；生产用 DB 声明 + fromDb） ----------

export const DEFAULT_NODES: Node[] = [
    {
        nodeName: "architectPlan",
        nodeType: "llm",
        description: "业务分解：功能 → 业务模块蓝图",
        systemPrompt: plan_prompt,
        temperature: 0.3,
        tools: "",
        model: ARCHITECT_MODEL_JSON,
        schemaKey: "architect_detailed_plan",
        codeKey: "",
        output: "detailedPlan",
    },
    {
        nodeName: "architectStack",
        nodeType: "llm",
        description: "技术栈：技术基线",
        systemPrompt: stack_prompt,
        temperature: 0.3,
        tools: "",
        model: ARCHITECT_MODEL_JSON,
        schemaKey: "architect_stack",
        codeKey: "",
        output: "stack",
    },
    {
        nodeName: "confirmGate",
        nodeType: "code",
        description: "确认门：y/n 开工确认",
        systemPrompt: "技术方案如上，确认开工？(y / n)",
        temperature: 0.3,
        tools: "",
        model: ARCHITECT_MODEL_JSON,
        schemaKey: "",
        codeKey: "architect_confirm",
        output: "",
    },
    {
        nodeName: "base",
        nodeType: "llm",
        description: "基础架构：基建动作 + DDL",
        systemPrompt: base_prompt,
        temperature: 0.3,
        tools: "",
        model: ARCHITECT_MODEL_JSON,
        schemaKey: "architect_base",
        codeKey: "",
        output: "basePlan",
    },
    {
        nodeName: "bootstrap",
        nodeType: "code",
        description: "工程地基落地：basePlan → 文件清单 → 写盘",
        systemPrompt: bootstrap_prompt,
        temperature: 0.3,
        tools: "",
        model: ARCHITECT_MODEL_JSON,
        schemaKey: "",
        codeKey: "architect_bootstrap",
        output: "",
    },
    {
        nodeName: "dispatch",
        nodeType: "code",
        description: "接口拆分 + 任务构建 + 下发",
        systemPrompt: api_prompt,
        temperature: 0.3,
        tools: "",
        model: ARCHITECT_MODEL_JSON,
        schemaKey: "architect_resolution",
        codeKey: "architect_dispatch",
        output: "",
    },
];

export const DEFAULT_EDGES: Edge[] = [
    { fromNode: "__start__", type: "direct", toNodes: "architectPlan" },
    // 地基已就绪（阶段 2+）：跳过 architectStack/confirmGate/base/bootstrap，直接拆任务
    //（stack/basePlan 由 runPhaseSplit 从 .architect-state.json 读回注入；bootstrapDone 置 true 走此短路）
    { fromNode: "architectPlan", type: "conditional", toNodes: JSON.stringify({ cond: "architect_bootstrap_done", true: "dispatch", false: "architectStack" }) },
    { fromNode: "architectStack", type: "direct", toNodes: "confirmGate" },
    { fromNode: "confirmGate", type: "conditional", toNodes: JSON.stringify({ cond: "architect_confirm_yes", true: "base", false: "__end__" }) },
    { fromNode: "base", type: "direct", toNodes: "bootstrap" },
    { fromNode: "bootstrap", type: "direct", toNodes: "dispatch" },
    { fromNode: "dispatch", type: "direct", toNodes: "__end__" },
];

// ============================================================
// Architect —— 架构师（固定类，消息驱动 + 拆分图）
// ============================================================

export class Architect extends BaseAgent {
    private graph: any;

    constructor(station: TransferStation, nodes: Node[] = DEFAULT_NODES, edges: Edge[] = DEFAULT_EDGES) {
        super("architect", roles.architect, station);
        this.build(nodes, edges);

        // phase_plan → 拆分当前阶段；phase_done → 转告 PM 请求下一阶段
        this.on("phase_plan", { fromNames: ["manager"] }, ({ data }) => {
            void this.runPhaseSplit(data.plan as Plan, data.phase as planItem, data.projectId as number | undefined);
        });
        // 测试 3 次未过 → 回炉：重设计该接口任务并重新下发
        this.on("task_rejected", { fromRoles: [roles.testEngineer] }, ({ data }) => {
            void this.redesignTask(data.pair as Pair, data.issues as string[], data.phase as number);
        });
        this.on("phase_done", { fromNames: ["maintainer"] }, ({ data }) => {
            // 3 次兜底汇总：打印放弃清单（哪个接口没做出来 + 原因），不再静默
            if (Array.isArray(data.failed) && data.failed.length > 0) {
                console.log(`[architect] 阶段 ${data.phase} 放弃 ${data.failed.length} 个任务：`);
                data.failed.forEach((f: any) => {
                    const task = f.task ?? {};
                    console.log(`   - ${task.method || ""} ${task.path || f.pairId}（尝试 ${f.attempts ?? 3} 次）`);
                    (f.issues ?? []).forEach((i: string) => console.log(`       原因：${i}`));
                });
            }
            this.send("manager", { type: "phase_request", phase: data.phase });
            console.log(`[architect] 发送到 PM：请求下一阶段（阶段 ${data.phase} 已完成）`);
        });
    }

    /** 注册实现（schema/code/cond）→ stitch() 拼接编译 → this.graph */
    private build(nodes: Node[], edges: Edge[]): void {
        schemaRegistry.register("architect_detailed_plan", detailedPlanSchema);
        schemaRegistry.register("architect_stack", stackSchema);
        schemaRegistry.register("architect_base", baseSchema);
        schemaRegistry.register("architect_bootstrap", bootstrapSchema);
        schemaRegistry.register("architect_resolution", resolutionSchema);
        codeRegistry.register("architect_confirm", confirmNode);
        codeRegistry.register("architect_bootstrap", bootstrapNode);
        codeRegistry.register("architect_dispatch", makeDispatchNode(this.station));
        condRegistry.register("architect_confirm_yes", confirmYes);
        condRegistry.register("architect_bootstrap_done", (s: any) => s.bootstrapDone === true);

        console.log(`[architect] 拼接编译拆分图：${nodes.map(n => n.nodeName).join(" → ")}`);
        this.graph = stitch(nodes, edges, {
            stateExtra: {
                plan: Annotation<any>({ default: () => null, reducer: (_: any, u: any) => u }),
                confirmAnswer: Annotation<any>({ default: () => null, reducer: (_: any, u: any) => u }),
                exeTasks: Annotation<any[]>({ default: () => [], reducer: (_: any[], u: any[]) => u }),
                confirmMode: Annotation<number>({ default: () => 0, reducer: (_: number, u: number) => u }),
                bootstrapDone: Annotation<boolean>({ default: () => false, reducer: (_: boolean, u: boolean) => u }),
            },
        });
    }

    /** 拆分一个阶段：跑图（含确认门交互）→ 有任务已由 dispatch 下发；无任务则声明 0 对，阶段直接完成 */
    private async runPhaseSplit(plan: Plan, phase: planItem, projectId?: number): Promise<void> {
        console.log(`[architect] 拆分阶段 ${phase.phase}「${phase.name}」`);
        const planForPhase: Plan = {
            ...plan,
            features: plan.features.filter(f => phase.features.includes(f.name)),
            phases: [phase],
        };
        // 读取项目确认模式，控制确认门是否弹出
        let confirmMode = 0;
        if (projectId) {
            try { confirmMode = await getProjectConfirmMode(projectId); } catch { /* 默认 0 */ }
        }
        // 阶段 2+：地基已就绪 → 读回 stack/basePlan 并置 bootstrapDone → 条件边短路（见 DEFAULT_EDGES）
        const extraInput: any = { plan: planForPhase, confirmMode };
        const pid = currentProjectId();
        if (pid != null) {
            try {
                const stateFile = projectDir(pid) + "/.architect-state.json";
                if (fs.existsSync(stateFile)) {
                    const saved = JSON.parse(fs.readFileSync(stateFile, "utf-8"));
                    if (saved?.bootstrapDone) {
                        extraInput.stack = saved.stack ?? null;
                        extraInput.basePlan = saved.basePlan ?? null;
                        extraInput.bootstrapDone = true;
                        console.log(`[architect] 复用已有架构状态：阶段 ${phase.phase} 跳过技术栈/确认门/地基，直接拆分任务`);
                    }
                }
            } catch { /* 读回失败走全图（退化为老行为，不阻塞） */ }
        }
        // 确认门提问器三分流（阶段 3，A3"stdin 死锁"根治的收尾：管理进程的问题上 Web）
        const state = await runWithInteraction(this.graph, extraInput, `architect-phase-${phase.phase}`,
            pickQuestioner(projectId ?? pid ?? 0));
        // 落库：业务模块(detailedPlan) + 技术选型(stack) + status=executing
        if (projectId) {
            try {
                await saveArchitectOutput(projectId, state?.detailedPlan ?? null, state?.stack ?? null);
            } catch (e) {
                console.warn("[architect] 产出落库失败:", (e as Error).message);
            }
        }
        const tasks: ExecTask[] = state?.exeTasks ?? [];
        // ★ sys_task 桥（施工卡 1-2/1-3）：本阶段任务幂等落库 + 消费返工 todo；旁路 fire-and-forget 不阻塞
        void this.bridgeTasks(tasks, phase.phase, projectId ?? pid ?? undefined);
        if (tasks.length > 0) {
            console.log(`[architect] 阶段 ${phase.phase} 拆出 ${tasks.length} 个任务并下发`);
        } else {
            // 方案被拒 / 拆分失败 → 声明 0 对并 final，维护据此直接完成本阶段（不卡死流水线）
            console.log(`[architect] 阶段 ${phase.phase} 无任务（被拒或拆分失败），声明 0 对完成`);
            this.send("maintainer", { type: "tasks_declared", phase: phase.phase, pairIds: [], final: true });
        }
    }

    /**
     * sys_task 桥（任务为原子的落点）：
     *  ① 幂等登记本阶段任务（ext 唯一键，阶段重跑/重放不重复建——ensureTasksForPhase 内）
     *  ② 消费返工任务：人在看板点重跑=todo+retry_count+1，此后每个阶段边界在这里重新下发到工位
     *     （description 自包含，契约/验收抄在里面；files/method/path 不落列，由工位按描述重推）
     * 旁路原则：整段 try 包住，DB 异常只 warn——桥是可观测层，不是控制层。
     */
    private async bridgeTasks(tasks: ExecTask[], phaseId: number, projectId?: number): Promise<void> {
        if (!projectId) return;
        try {
            await ensureTasksForPhase(tasks, projectId, phaseId);
            // 补 doing：dispatch 节点的消息比桥落库先到，工位 on("task") 写 doing 时无行可写（9/2 实测）
            // 语义="已下发工位"；发送失败的任务（无空闲工位）会被略早标 doing——可接受的观测误差
            for (const t of tasks) void updateStatusByExt(projectId, t.id, "doing", undefined, phaseId);
            const dispatched = new Set(tasks.map(t => t.id));
            for (const row of await getTasksByStatus(projectId, "todo")) {
                if (!row.retry_count || row.retry_count >= 3) continue;              // 只吃返工任务；≥3=放弃护栏
                if (!row.task_id_ext || dispatched.has(row.task_id_ext)) continue;   // 本阶段重新拆过的以新消息为准
                const target = this.station.pickLeastBusy(row.layer === "frontend" ? roles.frontendEngineer : roles.backendEngineer);
                if (!target) continue;
                const t: ExecTask = {
                    id: row.task_id_ext,
                    layer: row.layer === "frontend" ? "frontend" : "backend",
                    method: "", path: "", files: [],
                    title: row.title,
                    description: row.description ?? row.title,
                    parameters: [],
                    acceptance: row.acceptance ?? "功能可正常使用",
                    phase: row.phase_id ?? undefined,   // 返工任务带着归属阶段回炉，工位写状态不串台
                };
                this.station.sendMessage("architect", target, JSON.stringify({ type: "task", task: t }));
                console.log(`[architect] sys_task 桥：消费返工任务 ${row.task_id_ext}（第 ${row.retry_count} 次）→ ${target}`);
            }
        } catch (e) {
            console.warn("[architect] sys_task 桥失败(不阻塞):", (e as Error).message);
        }
    }

    /** 测试 3 次未过 → 回炉重设计：带问题重新拆分该接口（id 沿用原 pairId 保证计数连续）→ 重新下发 */
    private async redesignTask(pair: Pair, issues: string[], phase: number): Promise<void> {
        const back = pair.back;
        const front = pair.front;
        console.log(`[architect] 收到测试回炉：${back.id}（${back.method} ${back.path}），重新拆分该接口`);
        const prompt = api_prompt +
            `\n\n## 上一版后端任务（契约）\n${JSON.stringify(back, null, 2)}` +
            (front ? `\n\n## 上一版前端任务\n${JSON.stringify(front, null, 2)}` : "") +
            `\n\n## 测试判定问题（必须解决，否则同样会被拒）\n${issues.map((s, i) => `${i + 1}. ${s}`).join("\n")}` +
            `\n\n## 要求\n只重新设计这一个功能竖切（${back.title}）为前后端任务对，修正契约中的问题（接口参数/返回/文件清单/页面划分/前后端一致性），不要新增其他功能。`;
        try {
            const parsed = await retryStructured<{ tasks: [ResolutionBack, ResolutionFront][] }>(
                "接口重设计",
                async (feedback, sig) => {
                    const model = initModels(ARCHITECT_MODEL_JSON, "architect");
                    const result = await model
                        .withStructuredOutput(resolutionSchema, { method: "jsonMode", name: "extract_resolution" })
                        .invoke([new SystemMessage(prompt + feedback)], { signal: sig });
                    return result as { tasks: [ResolutionBack, ResolutionFront][] };
                },
            );
            const p0 = parsed?.tasks?.[0];
            if (!p0) throw new Error("重设计返回空任务");
            const [nb, nf] = p0;
            const id = back.id;   // ★ 沿用原 pairId，保证测试计数（阶段:pairId）连续到第 6 次
            const apiBlock = apiContractBlock(nb.apis);
            const primary = nb.apis[0]!;

            // 后端任务：保留原 id/layer，契约整段换新（T4 竖切形状）；测试问题原文附进描述，开发照着改
            const newBack: ExecTask = {
                ...back,
                method: primary.method,
                path: primary.path,
                files: [...new Set(nb.apis.flatMap(a => a.files))],
                title: `功能 ${nb.feature}（重设计）${nb.apis.length > 1 ? `·${nb.apis.length} 个接口` : ""}`,
                description: `【架构师重设计·第 2 版，接口契约以本段为准】\n模块/功能：${nb.feature}\n包含接口（${nb.apis.length} 个，全部必须实现）：\n${apiBlock}\n必须修正的测试问题：\n${issues.map((s, j) => `${j + 1}. ${s}`).join("\n")}`,
                parameters: primary.parameters,
            };
            const bTarget = this.station.pickLeastBusy(roles.backendEngineer);
            if (bTarget) {
                this.station.sendMessage("architect", bTarget, JSON.stringify({ type: "task", task: newBack }));
                console.log(`[architect] 重设计后下发后端：${id}（${nb.feature}，${nb.apis.length} 接口）`);
            }

            if (front && nf) {
                const contract = `\n\n【后端契约（前端必须遵守：字段名/格式/枚举值照抄，不得改名）】\n${apiBlock}`;
                const newFront: ExecTask = {
                    ...front,
                    id: `${id}-F`,
                    files: [...new Set(nf.pages.flatMap(p => p.files))],
                    title: `功能 ${nf.feature}：${nf.pages.map(p => p.page).join("、")}（重设计）`,
                    description: `【架构师重设计·第 2 版，契约以本段为准】\n模块/功能：${nf.feature}\n` +
                        nf.pages.map(p => `页面：${p.page}\n交互：${p.interactions}`).join("\n") + contract,
                    parameters: [],
                };
                const fTarget = this.station.pickLeastBusy(roles.frontendEngineer);
                if (fTarget) {
                    this.station.sendMessage("architect", fTarget, JSON.stringify({ type: "task", task: newFront }));
                    console.log(`[architect] 重设计后下发前端：${id}-F（${nf.pages.map(p => p.page).join("、")}）`);
                }
            }

            // 通知合并器：清该对的配对/交付缓存（防旧版前端配新版后端）
            this.station.sendMessage("architect", "merger", JSON.stringify({ type: "phase_reset", phase, pairId: id }));
            console.log(`[architect] 重设计完成，任务 ${id} 重新进入流水线`);
        } catch (e) {
            // 重设计失败 → 直接放弃上报（避免无限循环），不卡流水线
            console.warn("[architect] 接口重设计失败，放弃该任务:", (e as Error).message);
            this.send("maintainer", {
                type: "task_failed", phase, pairId: back.id,
                issues: issues ?? [], task: { id: back.id, method: back.method, path: back.path }, attempts: 6,
            });
            this.send("merger", { type: "task_failed", pairId: back.id });
        }
    }
}
