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
    codeRegistry, schemaRegistry, condRegistry, registerNodeValidator,
    type StateNodeFn, type CondFn,
} from "./GraphFactory";
import { type Node, type Edge, saveArchitectOutput, readProjectFile, getProjectConfirmMode } from "./Node";
import { writeWorkspace, type Pair, type ExecTask, type Plan, type planItem, REQUEST_WRAPPER_PATH, REQUEST_WRAPPER_CODE } from "./common";
import { currentProjectId, projectDir } from "./runEnv";
import { ensureTasksForPhase, getTasksByStatus, updateStatusByExt } from "./task";
import { pickQuestioner } from "./confirm";
import { dispatchArchitectTaskBatched } from "./architectTaskBuilder";
import { createRealLlm } from "./developerAgent/realLlm";
import { matchScaffolds } from "./developerAgent/scaffold";
// 召唤工位（9/17 拓扑升级·层 B）：架构师对**自己冻结的产物**（蓝图 + 批次）有职权。
//   · batch_resend：把 _tasks/<taskId>/ 档案里**尚未交付**的那一批重发一次
//     （已交付的重发会被 developer 的 batch_duplicate_ignored 吃掉，天然幂等）；
//   · plan_revision：修订说明落盘到 _tasks/<taskId>/consult-revisions.json。
//   ★ 为什么 plan_revision 不改蓝图字段本身：蓝图一旦中途改写，developer 侧
//     已冻结的 acceptanceHash 立刻漂移，已经交付的批次也失去"前缀"语义——
//     那等于把正在跑的流水线当场作废。修订落在**它的产物文件**上，由下游自己读。
import { handleConsultRequest } from "./consultStation";
import type { ConsultContext } from "./consultStation";
import { CONSULT_DRIVER } from "./consult";
import type { ConsultAmendment, ConsultRequest } from "./consult";
import { batchFileNameOf } from "./developerAgent/architectCheckpoint";
import { ArchitectBatchSchema, ArchitectTaskSchema } from "./developerAgent/protocol";
import type { ArchitectBatch, ArchitectTask } from "./developerAgent/protocol";
import { DEVELOPER_NAME } from "./developerAgent/hubAdapter";
import path from "node:path";

/**
 * 召唤工位（层 B）的注入缝。
 *   · 缺省 = **接架构师自己的模型**（ARCHITECT_MODEL_JSON：拆分图用的就是它）——
 *     层 B 的问答本来就该由它来答："计划改不改、哪一批重发"是它的判断。
 *   · consultLlm：显式注入（测试注脚本化 fake，或换模型）。
 *   · deterministicOnly：显式关掉 LLM（测试/无 key 环境），只做"复述自己产物"的
 *     确定性回答——零行为变化的那条路。
 */
export interface ArchitectConsultDeps {
    /** 被召唤时用它组织回答（可选）；不注入且未关 LLM = 用架构师自己的模型 */
    consultLlm?: (prompt: string) => Promise<string>;
    /** true = 不接任何 LLM，只做确定性复述（绝不编事实的那条路） */
    deterministicOnly?: boolean;
}

/**
 * 脚手架接管维度计算（2026-09-17 修订）：state.stack 有两种形状——
 *   ① 消息路径语义栈：{frontend:"...", backend:"..."}；
 *   ② 图路径 stackSchema 输出：{techniques, moduleTech:[{backend,frontend}], ...}。
 * s6 首跑实测：只查顶层字段在形状②下扑空 → 骨架照铺 13 件 → 脚手架被架空。
 * 统一聚合出前/后端栈文本再交给 matchScaffolds 判定。
 */
function computeScaffoldSkip(stack: unknown): ("frontend" | "backend")[] {
    const st = (stack ?? {}) as any;
    const frontText = typeof st.frontend === "string" && st.frontend
        ? st.frontend
        : Array.isArray(st.moduleTech) ? st.moduleTech.map((m: any) => String(m?.frontend ?? "")).join(" ") : "";
    const backText = typeof st.backend === "string" && st.backend
        ? st.backend
        : Array.isArray(st.moduleTech) ? st.moduleTech.map((m: any) => String(m?.backend ?? "")).join(" ") : "";
    if (!frontText && !backText) return [];
    return matchScaffolds({ frontend: frontText, backend: backText } as any)
        .filter(m => m.candidates.length > 0)
        .map(m => m.dimension);
}
import { buildKnown, checkBatch, checkStackConsistency } from "./checkers";
import { publishContracts } from "./contracts";
import { enforceEngineFoundation, tidyExecTasks, bannedDependencyList } from "./foundation";
import { installSkeleton, missingSkeletonFiles } from "./engine/workspace/skeleton/install";
import { baselinePromptBlock, resolveProjectBaseline } from "./baseline";
import { acceptanceFromTasks } from "./engine/ir/contract";
import type { Acceptance } from "./engine/ir/acceptance";
import { activeScenarioSpec, acceptanceFromScenarioSpec, resolveAcceptanceCode } from "./engine/ir/scenarioSpec";
import { getProjectRequirement } from "./Node";

// ---------- 模型 ----------

const ARCHITECT_MODEL_JSON = JSON.stringify({
    provider: "deepseek",
    model: "deepseek-v4-flash",
    temperature: 0.3,
    thinking: false,
});

const ARCHITECT_BASELINE = baselinePromptBlock();

// ---------- 提示词（移植自 _legacy-agents/architect.ts） ----------

export const plan_prompt: string = `
# 角色
你是 CrewForge 项目的架构师-业务规划 Agent。你的输出是当前阶段的业务模块蓝图，供技术栈设计和接口拆分继续使用。

${ARCHITECT_BASELINE}

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

${ARCHITECT_BASELINE}

## 任务
0. 需求原文里如果明确写了技术栈（语言/框架/数据库），那是硬约束——选型必须与之一致；
   校验器会把你的决策与需求原文比对，冲突会打回重选。
1. 只选择当前阶段实际需要的中间件，并说明每项用途；不要为了完整而堆叠技术。
2. 将 dataNeeds 落成可实现的表和字段，字段类型、必填性和业务含义必须明确，避免重复存储和无法验证的字段。
3. 为每个业务模块绑定服务端和客户端技术。backend 只写服务端框架、ORM、数据库访问等；frontend 只写前端框架、UI 和请求库等。
4. why 说明关键取舍，并指出会影响后续开发的风险。

## 约束
- 技术选择必须服务于输入中的业务模块和数据需求，不新增业务功能。
- moduleTech 必须覆盖每个输入模块，module 名必须原样复制。
- 表字段应能支撑输入中的功能和验收，不设计与当前阶段无关的表。
- 前端、后端、数据库和中间件由你根据业务模块、部署约束和数据需求选择；不要把默认兼容栈当成固定限制。
- 默认兼容组合是 Vue 3 + Element Plus + Vite、Spring Boot 3 + Java 17 + MyBatis-Plus、MySQL 8；只有在没有更合适方案时才使用它。
- 选型必须在 techniques、moduleTech 和 why 中保持一致；后续所有任务必须读取本次最终选型，不得回退到历史栈。
- 平台默认使用 JWT + Authorization、/api 和 { code, msg, data }；若业务确实需要其他协议，必须在技术选型和契约中明确记录。
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

export const consult_prompt: string = `
# 角色
你是 CrewForge 项目的架构师。动手出技术方案**之前**，你先跟用户把会影响选型的关键决策问清楚。

## 为什么要有这一步
用户的需求原文通常只写"做什么"，不写"跑在哪、要不要登录、单机还是多机"。
这些不问清，选型就只能靠猜；猜错的话后面拆出来的任务、表结构、接口全白做。
所以问要比猜便宜得多。

## 任务
看需求原文与本阶段功能清单，判断有没有"不问清就会选错"的点。有就提出**一个**最关键的追问；没有就输出空 question。

该问的典型：
- 需求没写、但选型必须知道的部署/环境约束（跑在哪台机器、要不要外网、单机还是多人用）；
- 有两条都说得通的技术路线、且用户偏好决定取舍的（如 SQLite 单文件 vs MySQL 服务、要不要引入登录体系）；
- 需求自相矛盾或明显遗漏、会改变数据模型或接口形态的。

## 不能问的（问了就是浪费用户时间）
- 需求里**已经写明**的——硬约束照做，不要复述确认；
- 纯实现细节（文件怎么组织、用什么 ORM、命名）——那是你该自己定的；
- 泛泛的"还有什么要补充的吗"。
**没有问题就必须输出空 question**，不要为了显得尽责而硬凑一个问题。

## 轮次
最多问 3 个。输入里的 consultHistory 是你已经问过的与用户已答的，不要重复问；
用户答过的按答案执行，不要再确认一遍。

## 输出
只输出合法 JSON，不要 Markdown、解释或额外字段：
{ "question": "要问用户的那一个问题（没有就空串）", "why": "为什么必须问它（一句话，给用户看背景）" }
`;

export const base_prompt: string = `
# 角色
你是 CrewForge 项目的架构师-基础架构 Agent，负责把当前阶段需要的工程基础动作整理成可执行清单。

${ARCHITECT_BASELINE}

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

${ARCHITECT_BASELINE}

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
- 依赖、配置、目录和入口必须与最终技术选型匹配；不要无条件加入 Vue、Spring、MySQL 或其他未选中的依赖。
- 若有 Web 前端，请统一使用 frontend/src/utils/request.ts 作为业务请求封装；其内容应随选定 HTTP 客户端生成，业务文件不得另起 wrapper。
- 引擎只维护最终栈对应的入口、根组件和路由登记文件；你不要把这些引擎拥有件列入任务 files。
- HTML 入口脚本必须指向最终前端框架的引擎入口；不要假设一定是 /src/main.ts。
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

${ARCHITECT_BASELINE}

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
- 竖切前提（p3 翻车修，9/9）：每一对任务必须后端有接口、前端有页面——"只有前端没有接口"的横切能力（路由守卫、请求拦截器、鉴权工具）**不得自立成功能对**，把它的文件并进使用它的那个功能的前端任务里。schema 会拒收空 apis/空 pages，被拒=白烧三轮重试。
- 引擎拥有件：frontend/src/main.ts、App.vue、router/index.ts、style.css、backend/src/app.js 禁止列入任何任务的 files；路由由引擎按契约页面清单在任务收口后自动登记，入口由模板直出；后端文件一律 backend/src/ 前缀。
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
    // ★ 搬运⑤（2026-09-17 修订）：一致性闸**不进 schema**——s4b 实弹证明 DB 节点声明里的
    //   旧 prompt 不会带新指令，要求模型吐新字段只会 3 连拒炸整个进程（项目零产出）。
    //   改为外部校验：GraphFactory 的 registerNodeValidator 在解析成功后，
    //   直接拿图状态（state.plan）里的需求原文跑 checkStackConsistency，冲突走有界重试。
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

/**
 * 架构师澄清（9/18）：出方案前先问清关键决策。
 * question 空串 = 没有要问的（**必须允许空串**：模型不该为了显得尽责而硬凑问题，
 * 所以这里不用 min(1)，"没问题"是一个合法且应当被鼓励的输出）。
 */
export const consultSchema = z.object({
    question: z.string(),
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
                // p4 阶段 3 血案（9/9）：jsonMode 偶发漏 files 键，strict 拒整包=3 连败进程死。
                // 改判：形状宽容（optional）+ 解析成功后机械回填 backfillSliceFiles——漏键不该是死刑
                files: z.array(z.string()).optional(),
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
                files: z.array(z.string()).optional(),   // 同 apis.files：宽容+回填，理由见上
            })).min(1),
        }),
    ])),
});

type ResolutionApi = z.infer<typeof resolutionSchema>["tasks"][number][0]["apis"][number];
type ResolutionBack = z.infer<typeof resolutionSchema>["tasks"][number][0];
type ResolutionFront = z.infer<typeof resolutionSchema>["tasks"][number][1];

/**
 * 拆分漏键机械回填（p4 阶段 3 血案，9/9）：模型在 jsonMode 下偶发整键漏掉 files（其余字段全对），
 * strict schema 时代=整包拒收 3 连败炸进程。现改宽容收+此处补产：
 * 后端按接口路径首段推 routes/<seg>.js，前端按首接口推 views/<Seg>Page{n}.vue。
 * 大字 warn 留痕——这是修复不是掩盖，跑完账本要数它出现几次。
 */
export function backfillSliceFiles(parsed: { tasks: [ResolutionBack, ResolutionFront][] }): string[] {
    const repairs: string[] = [];
    const routeSeg = (path: string) =>
        (path ?? "").replace(/^\/api\/?/, "").split("/").find(s => s && !/^[{:$]/.test(s))?.replace(/[^a-z0-9-]/gi, "-").toLowerCase() ?? "";
    parsed.tasks.forEach(([back, front], ti) => {
        for (const api of back.apis ?? []) {
            if (!api.files?.length) {
                api.files = [`backend/src/routes/${routeSeg(api.path) || "misc"}.js`];
                repairs.push(`接口 ${api.method} ${api.path} 缺 files → ${api.files[0]}`);
            }
        }
        (front.pages ?? []).forEach((pg, pi) => {
            if (!pg.files?.length) {
                const seg = routeSeg(back.apis?.[0]?.path ?? "");
                const base = seg ? seg[0]!.toUpperCase() + seg.slice(1) : `T${ti + 1}`;
                pg.files = [`frontend/src/views/${base}Page${pi + 1}.vue`];
                repairs.push(`页面「${pg.page}」缺 files → ${pg.files[0]}`);
            }
        });
    });
    if (repairs.length) console.warn(`[architect] ⚠️ 拆分漏键回填 ${repairs.length} 处：\n  ${repairs.join("\n  ")}`);
    return repairs;
}

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
    // p3 修②③④（9/9）：拆完过 foundation.tidyExecTasks 机械整风——
    // 引擎件剔除/backend 路径归一/跨任务文件去重让渡/【技术基线】硬约束注入 description
    return tidyExecTasks(buildExecTasksRaw(parsed, detailed, stack, plan), stack);
}

function buildExecTasksRaw(
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
            files: [...new Set(back.apis.flatMap(a => a.files ?? []))],
            title: `功能 ${back.feature}${back.apis.length > 1 ? `（${back.apis.length} 个接口）` : ""}`,
            description: `模块/功能：${back.feature}\n业务：${mod?.business ?? ""}\n技术：${backendTech}\n中间件：${middlewareContent}\n数据库：${dbContent}\n包含接口（${back.apis.length} 个，全部必须实现）：\n${apiBlock}`,
            parameters: primary.parameters,
            acceptance,
            stack,
        };

        // 自包含铁律（保持）：整组接口契约机械抄进前端描述——竖切后一任务多页面，契约仍是一套
        const contract = `\n\n【后端契约（前端必须遵守：字段名/格式/枚举值照抄，不得改名）】\n${apiBlock}`;
        const frontendTask: ExecTask = {
            id: `T${i + 1}-F`,
            layer: "frontend",
            method: primary.method,
            path: primary.path,
            files: [...new Set(front.pages.flatMap(p => p.files ?? []))],
            title: `功能 ${front.feature}：${front.pages.map(p => p.page).join("、")}`,
            description: `模块/功能：${front.feature}\n业务：${mod?.business ?? ""}\n技术：${frontendTech}\n` +
                front.pages.map(p => `页面：${p.page}\n交互：${p.interactions}`).join("\n") + contract,
            parameters: [],
            acceptance,
            stack,
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
export function enforceElementPlusFoundation(files: { path: string; content: string }[]): void {
    for (const f of files) {
        if (!/package\.json$/i.test(f.path) || !f.content) continue;
        let pkg: any;
        try { pkg = JSON.parse(f.content); } catch { continue; }   // 非 JSON：留给测试工位，这里不硬来
        const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
        const isFrontend = /^(frontend|web|client|ui)[\\/]/i.test(f.path)
            || Object.keys(allDeps).some(d => /^vue$|^vite$|element-plus/i.test(d));
        if (!isFrontend) continue;
        pkg.dependencies = {
            axios: "^1.7.0",
            "vue-router": "^4",
            "element-plus": "^2",
            ...(pkg.dependencies ?? {}),
        };
        f.content = JSON.stringify(pkg, null, 2);
        console.log(`[architect] Element Plus 地基：${f.path} 已合并前端运行依赖`);
    }
}

/** @deprecated 历史调用方兼容名；实现已切换为 Element Plus 基线。 */
export const enforceTdesignFoundation = enforceElementPlusFoundation;

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
                ensureRequestFoundation(out.files);   // p2 修①（9/9）：契约基约/前端 prompt 都钉 utils/request.ts，地基代码保证供得上
                enforceEngineFoundation(out.files, stack);   // 按最终技术选型维护入口与依赖
                const pid = currentProjectId();
                const known = buildKnown(pid != null ? projectDir(pid) : null, undefined, out.files.map(f => f.path));
                const reds = await checkBatch(out.files, known, bannedDependencyList(stack));   // p3 修④：地基也过违禁依赖闸
                if (reds.size > 0) {
                    throw new Error(`地基文件未过编译闸门：${[...reds.entries()].map(([p, ps]) => `${p} → ${ps.join("；")}`).join(" ｜ ")}`);
                }
                return out;
            },
            // 地基是流水线输出量最大的节点（5-15 个完整文件内容），180s 默认超时不够，单独放宽到 300s
            { timeoutMs: 300_000 },
        );
        const files = parsed?.files ?? [];
        // ★ 脚手架接管的维度：basePlan 里该侧的初始化文件同样不铺（与骨架同规则）
        const scaffoldSkip0 = computeScaffoldSkip(state?.stack);
        let laid = 0;
        for (const f of files) {
            if (!f?.path) continue;
            const dim = f.path.startsWith("frontend/") ? "frontend" : f.path.startsWith("backend/") ? "backend" : null;
            if (dim && scaffoldSkip0.includes(dim)) {
                console.log(`[architect] 地基文件跳过（脚手架接管 ${dim}）：${f.path}`);
                continue;
            }
            try {
                writeWorkspace(f.path, f.content ?? "");
                laid++;
                console.log(`[architect] 地基文件已写入：${f.path}`);
            } catch (e) {
                console.warn(`[architect] 地基文件写入失败（跳过）：${f.path} - ${(e as Error).message}`);
            }
        }
        console.log(`[architect] 地基落地完成：${laid} 个文件`);

        // ★ 阶段 1 提交 2：**引擎骨架直出**最后一个落盘（覆盖 LLM 同名文件）。
        //   治的病：s3 前端没有 index.html（vite 直接构建失败）、s1 后端空库启动无表可查、
        //   p9 全树没有 main.ts/App.vue。这些文件归引擎所有，写盘前已在 ownership 层拒绝任务产出。
        const pidForSkeleton = currentProjectId();
        if (pidForSkeleton != null) {
            // ★ 脚手架接管（2026-09-17）：栈命中官方脚手架候选的维度，骨架不预铺该侧文件，
            //   初始化交给 Developer 走 `npm create vite` / `npm init`（bootstrap-project 技能已引导）。
            //   s4d 实测：骨架先行导致 `npm create` 0 次调用，脚手架被架空。
            const scaffoldSkip = computeScaffoldSkip(state?.stack);
            if (scaffoldSkip.length > 0) console.log(`[architect] 脚手架接管维度：${scaffoldSkip.join("、")}（该侧不铺骨架）`);
            try {
                const sk = installSkeleton({
                    appName: "crewforge-app",
                    title: "CrewForge 应用",
                    ddl: (state?.basePlan as { ddl?: string } | null | undefined)?.ddl ?? null,
                    ...(scaffoldSkip.length ? { skip: scaffoldSkip } : {}),
                });
                console.log(`[architect] 引擎骨架已落盘：${sk.written.length} 个引擎拥有件${sk.markerPatched ? "（补了路由登记缝 {{ROUTES}}）" : ""}${sk.skipped.length ? `；跳过/失败 ${sk.skipped.length} 个：${sk.skipped.join("；")}` : ""}`);
                const missing = missingSkeletonFiles(pidForSkeleton, scaffoldSkip);
                if (missing.length > 0) console.warn(`[architect] ⚠️ 骨架仍缺件：${missing.join("、")}（缺件 = 前端/后端起不来的直接来源）`);
            } catch (e) {
                console.error("[architect] ❌ 引擎骨架落盘失败:", (e as Error).message);
            }
        }

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

/**
 * 架构师澄清节点（9/18）—— 出方案前先让 LLM 就关键决策追问用户。
 *
 * 为什么要自己调 LLM，而不是用 nodeType:"llm" 声明一个节点：
 *   这个节点要做的第一件事是**归一历史** —— 把上一轮的 `consult.question` 与
 *   `state.humanAnswer` 合成一条 consultHistory。而 llm 节点只会把整个 state
 *   原样 JSON 化喂给模型（GraphFactory:165），做不到"先整理再问"。
 *   历史归一必须发生在提问之前，否则模型看不到自己刚问过什么，会重复追问。
 *
 * 为什么放在图的最前面（__start__ → 本节点 → architectPlan）：
 *   `runWithInteraction` 每答一轮就重新 invoke 一次图，而图是从 __start__ 重跑的。
 *   本节点排在 architectPlan/architectStack 之前，重跑一轮的代价就只有这一次提问调用；
 *   若排在 stack 之后，每轮都要连带重跑 plan+stack 两个大 LLM 调用（白烧钱）。
 */
function makeConsultNode(): StateNodeFn {
    return async (state: any) => {
        // ① 归一历史：上一轮"问了什么 + 用户答了什么" → consultHistory
        const history: { question: string; answer: string }[] = Array.isArray(state?.consultHistory)
            ? [...state.consultHistory]
            : [];
        const lastQuestion = String(state?.consult?.question ?? "").trim();
        if (state?.humanAnswer != null && lastQuestion) {
            history.push({ question: lastQuestion, answer: String(state.humanAnswer) });
        }

        // ② 阶段 2+：架构已定（bootstrapDone）→ 技术决策不重复追问，直接放行
        if (state?.bootstrapDone === true) {
            return { consultHistory: history, consult: { question: "", why: "" }, human: null, humanAnswer: null };
        }

        // ②b 确认模式分流（与网页上三个模式的承诺对齐）：
        //   全绿灯(0) = "AI 自动推进，只在交付时展示结果" → 不许打扰用户，直接出方案；
        //   混合(1)   = "在需求/技术栈/计划/团队 4 个节点确认" → **技术栈这个节点就是这里**；
        //   手动(2)   = 每阶段都要人过 → 更要问。
        //   ⚠️ 这一条补上之前，"混合模式在技术栈节点确认"是句空话：架构师的 y/n 确认门
        //   在 mode 0/1 都自动放行（见 confirmNode），人在技术栈这一步根本没有发言机会。
        const mode = state?.confirmMode ?? 0;
        if (mode === 0) {
            return { consultHistory: history, consult: { question: "", why: "" }, human: null, humanAnswer: null };
        }

        // ③ 需求原文优先读库（与 stack 校验器同口径：state.plan 是 PM 消化过的，可能洗掉原话）
        let requirement = "";
        try {
            const pid = currentProjectId();
            if (pid != null) requirement = await getProjectRequirement(pid);
        } catch { /* 读不到就退到 plan */ }
        if (!requirement) {
            requirement = typeof state?.plan === "object" && state.plan !== null
                ? JSON.stringify(state.plan)
                : String(state?.plan ?? "");
        }
        const input = { requirement, plan: state?.plan ?? null, consultHistory: history };

        // ④ 问 LLM：还有要跟用户确认的吗（question 为空 = 没有）
        const parsed = await retryStructured<{ question: string; why: string }>(
            "架构师澄清提问",
            async (feedback, sig) => {
                const model = initModels(ARCHITECT_MODEL_JSON, "architect");
                const out = await model
                    .withStructuredOutput(consultSchema, { method: "jsonMode", name: "extract_architect_consult" })
                    .invoke([new SystemMessage(`${consult_prompt}\n\n## 输入\n${JSON.stringify(input, null, 2)}${feedback}`)], { signal: sig });
                return out as { question: string; why: string };
            },
        );
        const question = String(parsed?.question ?? "").trim();
        if (question) {
            console.log(`[architect] 澄清第 ${history.length + 1} 问：${question}`);
        } else if (history.length > 0) {
            console.log(`[architect] 澄清结束（用户答了 ${history.length} 轮，不再追问）`);
        }
        // human: null 显式清掉上一轮的挂起标记：否则图会停在旧问题上（humanGate 语义）
        return {
            consultHistory: history,
            consult: { question, why: String(parsed?.why ?? "") },
            human: null,
            humanAnswer: null,
            llmCalls: 1,
        };
    };
}

/**
 * 澄清门：LLM 有问题就交给用户答（经确认门落 sys_confirm），没有就放行去出方案。
 * 与 confirmNode 的区别：这里是**开放式问答**（options 为空 = 自由文本），
 * 不是 y/n；且可连续问，直到 LLM 自己说没有要问的了。
 */
const consultGateNode: StateNodeFn = async (state) => {
    const question = String(state?.consult?.question ?? "").trim();
    if (!question) {
        return { human: null };   // 没有问题 → 条件边放行到 architectPlan
    }
    // questionId 带轮次：HttpQuestioner 建题幂等，同轮重跑不会给用户重复塞单子
    const turn = Array.isArray(state?.consultHistory) ? state.consultHistory.length : 0;
    return {
        human: {
            questionId: `architect-consult-${turn}`,
            prompt: state?.consult?.why ? `${question}\n\n（为什么要问：${state.consult.why}）` : question,
            options: [],
        },
    };
};

/** 澄清门：human != null = 有问题挂着，图收在 __end__ 等人答 */
const consultPending: CondFn = (state) => state?.human != null;

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

/**
 * 派发模式（**新路径为默认**）：
 *   hub（默认）—— 两阶段派发（9/15）：需求原文 → architectAgent 拆蓝图
 *                 （architect_task 先发）→ 按工作项顺序逐批 architect_batch；
 *                 经 Hub 直派 developer，全程经 architectTaskBuilder.dispatchArchitectTaskBatched
 *                 校验/落盘/幂等记账；任一批 3 连拒=整次作废（cancel_task + manager 报告）。
 *   legacy      —— 旧的"按层拆 ExecTask → 发 backendEngineer / frontendEngineer"路径，
 *                 代码保留，但要显式 CF_ARCHITECT_DISPATCH=legacy 才走。
 */
export function architectDispatchMode(): "hub" | "legacy" {
    return (process.env.CF_ARCHITECT_DISPATCH ?? "hub").trim().toLowerCase() === "legacy" ? "legacy" : "hub";
}

/** 接口拆分 + 任务构建 + 下发（station 副作用）。返回 exeTasks。 */
function makeDispatchNode(station: TransferStation): StateNodeFn {
    return async (state) => {
        const plan: Plan = state.plan;
        const detailed: any = state.detailedPlan;
        const stack: any = state.stack;
        if (!plan || !detailed || !stack) throw new Error("接口拆分缺少前置输入（plan/detailedPlan/stack）");

        const phaseNo = plan.phases[0]?.phase ?? 1;

        // ★ 两阶段派发（9/15 解耦测试第二项）：hub 模式下**蓝图先行 + 按工作项逐批发
        //   architect_batch**（architectTaskBuilder.dispatchArchitectTaskBatched →
        //   developerAgent/architectAgent 拆解，需求原文取 sys_project.description +
        //   clarified_req）。放在接口拆分 LLM 之前：蓝图/批次自带拆解，旧的
        //   "api_prompt 拆分 → architectSemanticsFromPlan → 整包"链在 hub 模式
        //   零调用（连这次拆分 LLM 都省了）；代码保留只为 legacy 模式继续可用。
        if (architectDispatchMode() === "hub") {
            const pidNum = currentProjectId();
            const projectIdStr = String(pidNum ?? plan.project ?? "project");
            const taskIdStr = `${projectIdStr}-p${phaseNo}`;
            // 需求原文：DB 读失败/为空都显式炸（不猜需求把空包派出去）
            let requirement = "";
            try {
                if (pidNum != null) requirement = await getProjectRequirement(pidNum);
            } catch (e) {
                throw new Error(`两阶段派发：需求原文读取失败（sys_project）：${(e as Error).message}`);
            }
            // ★ 声明先于派发（9/15 新链，maintainer 收敛闸的家法——lane D 报告 #2）：
            //   ① sys_task 登记本阶段"开发流任务"一行——taskId 与 developer 三终态消息
            //     （developer_ready/blocked/failed 的 taskId）同一 id 空间，maintainer 的
            //     updateStatusByExt 才找得到行；桥=可观测层，写库异常只 warn 不拦派发。
            //   ② tasks_declared {pairIds:[taskId], final:true}——新链路一个阶段=一个
            //     开发任务包，终态一次定论，收敛条件即"这一行定论"。旧 pairIds(T 形) 作废。
            if (pidNum != null) {
                const flowTask: ExecTask = {
                    id: taskIdStr, phase: phaseNo, layer: "backend", method: "", path: "",
                    title: `developer 流水（阶段 ${phaseNo}：蓝图+分批任务包）`,
                    description: `两阶段派发 architect_task/architect_batch；taskId=${taskIdStr}`,
                    files: [], parameters: [], acceptance: "",
                };
                try { await ensureTasksForPhase([flowTask], pidNum, phaseNo); }
                catch (e) { console.warn(`[architect] sys_task 流水行登记失败（桥层不阻塞）：${(e as Error).message}`); }
                station.sendMessage("architect", "maintainer", JSON.stringify({
                    type: "tasks_declared", phase: phaseNo, pairIds: [taskIdStr], final: true,
                }));
            }
            // 真机 LLM 档位照抄 live/architect-cli.ts：maxTokens 32768 / timeoutMs 1350s
            // （8192 实测被截断；9/16 p7 实弹 w5 撞 900s 超时整次作废后，
            //   用户指令全部超时 ×1.5：900s → 1350s——architect-cli.ts 已改，
            //   9/16 p20 首跑团队线漏 bump 在同一处猝死，今补上）
            const outcome = await dispatchArchitectTaskBatched({
                station,
                requirement,
                projectId: projectIdStr,
                taskId: taskIdStr,
                llm: createRealLlm({ maxTokens: 32768, timeoutMs: 1_350_000 }),
                // 断点重放目录：RUNS_ROOT/p{N}/_tasks/{taskId}/（runEnv.projectDir 定根）
                ...(pidNum != null ? { taskDir: `${projectDir(pidNum)}/_tasks/${taskIdStr}` } : {}),
                onEvent: (ev) => console.log(`[architect] ${ev.type}`
                    + (ev.taskId ? ` ${ev.taskId}` : "")
                    + (ev.detail ? ` ${JSON.stringify(ev.detail).slice(0, 300)}` : "")),
            });
            if (!outcome.ok) {
                // 拆解/派发失败=这一阶段没有下发（不静默回退旧路径）；
                // 半途作废时 builder 已发 cancel_task 并向 manager 显式报告。
                throw new Error(`architect_task 两阶段派发失败（stage=${outcome.stage}`
                    + (outcome.failedItemId ? ` failedItem=${outcome.failedItemId}` : "")
                    + `，已作废=${outcome.cancelled}）：${outcome.issues.join("；")}`);
            }
            console.log(`[architect] 两阶段派发完成：蓝图 + ${outcome.batches.length} 批 → developer`
                + `（taskId=${taskIdStr}，账本去重 ${outcome.deduped.length} 条`
                + (outcome.deduped.length ? `：${outcome.deduped.join("、")}` : "") + "）");
            return { exeTasks: [], architectTaskDispatched: true, llmCalls: 1 };
        }

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
        backfillSliceFiles(parsed);   // p4 血案补丁：漏 files 键=回填不死

        // （9/15）原"hub 模式装整包"分支已上移到接口拆分之前，升级为**两阶段派发**
        //   （蓝图 + 逐批 architect_batch，见 dispatchArchitectTaskBatched）；
        //   走到这里只剩 legacy 路径：旧的按层拆 ExecTask → backendEngineer/frontendEngineer。

        // 2. 机械构建 ExecTasks（T4 竖切版：抽成纯函数 buildExecTasks，redesignTask 共用、t4-smoke 直测）
        const tasks: ExecTask[] = buildExecTasks(parsed, detailed, stack, plan);

        // 2.5 T2 全局契约（9/8）：拆完任务、下发之前发布 CONTRACTS.md——
        // 三工位+测试每次调用头部注入（contracts.ts 读同一份），路由登记/文件归属从此有据可依。
        // 发布失败只 warn 不拦下发（旁路）；契约本身也随 writeWorkspace 落库进 sys_project_file
        try { await publishContracts(phaseNo, plan, tasks, stack); }
        catch (e) { console.warn("[architect] 契约发布异常（旁路，工位按无契约运行）:", (e as Error).message); }

        // 2.6 ★ 交付关输入（9/10）：把**可执行验收**落成产物（per-phase），供 runner 最后统一验证。
        //     为什么走文件而不是 DB：sys_task 不落 method/path（工位按描述重推），而交付关必须拿到
        //     结构化接口清单——从 ExecTask 字段机械生成，**不碰文本正则**（旧 expectedApisOf 的坑）。
        try {
            const pid = currentProjectId();
            if (pid != null) {
                // ★ 阶段 1 提交 3：验收来源优先级 = 冻结场景规格 > 需求原文解析 > （都没有则不发明判据）
                //   旧实现在这里硬编码 successCode: 1，与冻结需求的 code=200 直接冲突。
                const active = activeScenarioSpec();
                let cases: Acceptance[];
                let skipped: string[];
                let sourceNote: string;
                if (active) {
                    const built = acceptanceFromScenarioSpec(active.spec);
                    cases = built.cases;
                    skipped = built.skipped;
                    sourceNote = `来源=场景规格 ${active.spec.id}（${active.file}）`;
                } else {
                    let requirementText: string | null = null;
                    try { requirementText = await getProjectRequirement(pid); } catch { requirementText = null; }
                    const code = resolveAcceptanceCode(requirementText);
                    const built = acceptanceFromTasks(
                        tasks.map(t => ({ id: t.id, layer: t.layer, method: t.method, path: t.path, title: t.title })),
                        { apiPrefix: stack?.apiPrefix ?? "/api", ...(code.successCode != null ? { successCode: code.successCode } : {}) },
                    );
                    cases = built.cases;
                    skipped = built.skipped;
                    sourceNote = `来源=任务字段 + ${code.source}（${code.evidence}）`;
                    if (code.successCode == null) {
                        console.warn(`[architect] ⚠️ openQuestion：需求未写明统一响应成功码——**不发明判据**，本次验收不含 $.code 断言`);
                    }
                }
                const dir = projectDir(pid) + "/_verify";
                fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(`${dir}/acceptance-p${phaseNo}.json`,
                    JSON.stringify({ phase: phaseNo, generatedAt: new Date().toISOString(), source: sourceNote, cases, skipped }, null, 2), "utf-8");
                console.log(`[architect] 交付关输入已落盘：_verify/acceptance-p${phaseNo}.json（${cases.length} 条可执行验收${skipped.length ? `，跳过 ${skipped.length} 个缺 method/path 的任务` : ""}；${sourceNote}）`);
            }
        } catch (e) { console.warn("[architect] 验收 IR 落盘失败（旁路）:", (e as Error).message); }

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
        // ⚠️ 节点名不能叫 `consult` —— state 里已有 `consult` 通道，LangGraph 的 addNode 会直接抛
        //    "consult is already being used as a state attribute, cannot also be used as a node name"
        //    （9/18 实测：这一抛发生在 createCoreTeam，等于任何项目一开工就崩，代价为零但必须记住）
        nodeName: "architectConsult",
        nodeType: "code",
        description: "澄清：出方案前就关键决策追问用户（LLM 生成，最多 3 问）",
        systemPrompt: consult_prompt,
        temperature: 0.3,
        tools: "",
        model: ARCHITECT_MODEL_JSON,
        schemaKey: "",
        codeKey: "architect_consult",
        output: "",
    },
    {
        nodeName: "consultGate",
        nodeType: "code",
        description: "澄清门：有问题就挂起等人答，没有就放行",
        systemPrompt: "",
        temperature: 0.3,
        tools: "",
        model: ARCHITECT_MODEL_JSON,
        schemaKey: "",
        codeKey: "architect_consult_gate",
        output: "",
    },
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
    // 9/18：图最前面插澄清环（先问清关键决策再出方案）。
    // 为什么在最前面而不是 stack 之后：runWithInteraction 每答一轮都会从 __start__ 重跑图，
    // 放最前面时重跑代价 = 一次提问调用；放 stack 后面则每轮白烧 plan+stack 两个大调用。
    { fromNode: "__start__", type: "direct", toNodes: "architectConsult" },
    { fromNode: "architectConsult", type: "direct", toNodes: "consultGate" },
    // 有问题 → 收在图末（human 已置位，runWithInteraction 负责问人）；没问题 → 出方案
    { fromNode: "consultGate", type: "conditional", toNodes: JSON.stringify({ cond: "architect_consult_pending", true: "__end__", false: "architectPlan" }) },
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
    /** 召唤工位（层 B）注入缝：缺省 = 确定性回答（见 ArchitectConsultDeps 注释） */
    private readonly consultDeps: ArchitectConsultDeps;
    /** 本工位签发的计划修订（层 B 的产物之一，落 _tasks/<taskId>/consult-revisions.json） */
    private readonly planRevisions = new Map<string, { detail: string; payload?: Record<string, unknown>; at: number }[]>();

    constructor(
        station: TransferStation, nodes: Node[] = DEFAULT_NODES, edges: Edge[] = DEFAULT_EDGES,
        consultDeps: ArchitectConsultDeps = {},
    ) {
        super("architect", roles.architect, station);
        this.consultDeps = consultDeps;
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
        // ---------- 召唤工位（9/17 层 B）：司机中途把问题送进来 ----------
        //   为什么是它：计划/批次是**架构师冻结的产物**，中途发现"计划里少了鉴权、
        //   批次顺序不对"时，唯一有权处置的就是它。以前它只在阶段开始时出现一次，
        //   之后司机只能自己发明解释——这正是"换脑断层"。
        //   ★ 不按 fromNames 过滤：发错人的请求也要拿到一条**明确拒绝**的回复
        //     （投递闸在 handleConsultRequest 里）。
        this.on("consult_request", ({ data }) => this.answerConsult(data as unknown as ConsultRequest));
    }

    /** 召唤应答（层 B）：ownContext = 它自己的蓝图/批次产物；amend = 计划修订 + 批次重发 */
    private async answerConsult(req: ConsultRequest): Promise<void> {
        const reply = await handleConsultRequest(req, this.buildConsultContext(req));
        this.send(CONSULT_DRIVER, reply as unknown as Record<string, any>);
        console.log(`[architect] 应答召唤 ${reply.consultId}（confidence=${reply.confidence}`
            + `${reply.refused ? "，已拒绝" : ""}${reply.amendment ? `，已签发 ${reply.amendment.kind}` : ""}）`);
    }

    private buildConsultContext(req: ConsultRequest): ConsultContext {
        const pid = currentProjectId();
        const taskId = typeof req?.taskId === "string" && req.taskId ? req.taskId : "";
        const llm = this.consultLlmPort();
        return {
            role: "architect",
            projectId: pid != null ? String(pid) : "",
            // 架构师**不绑定单一任务**：一个阶段一个 taskId，同一个工位实例服务整个阶段。
            // 留空 = "不持该维度"，不构成拒绝理由（见 handleConsultRequest 的身份闸注释）。
            taskId: "",
            ownContext: async () => this.renderOwnContext(taskId),
            ...(llm ? { llm } : {}),
            amend: async (a) => this.applyArchitectAmendment(a, taskId, pid),
        };
    }

    /**
     * 层 B 的 LLM 端口：架构师本来就有模型（拆分图走的就是 ARCHITECT_MODEL_JSON），
     * 所以默认真的由它来答——否则"召唤架构师"只会复述自己产物的文件名，
     * 而它真正该回答的是"这个计划要不要改"。
     *   · 一次一调（超时/重试由调用方负责；调用失败会被应答器收敛成 refused，不抛）；
     *   · 模型档位/上限沿用拆解档，不在这里另调参（调参要能被审计）。
     */
    private consultLlmPort(): ((prompt: string) => Promise<string>) | undefined {
        if (this.consultDeps.consultLlm) return this.consultDeps.consultLlm;
        if (this.consultDeps.deterministicOnly) return undefined;
        return async (prompt: string): Promise<string> => {
            const model = initModels(ARCHITECT_MODEL_JSON, "architect") as unknown as {
                invoke(input: unknown): Promise<{ content: unknown }>;
            };
            const res = await model.invoke([new SystemMessage(prompt)]);
            return typeof res.content === "string" ? res.content : JSON.stringify(res.content);
        };
    }

    /** 本工位持有的产物目录（与派发节点落盘的同一处：RUNS_ROOT/p{N}/_tasks/{taskId}） */
    private taskDirOf(taskId: string, pid: number | null): string | null {
        if (pid == null || !taskId) return null;
        return path.join(projectDir(pid), "_tasks", taskId);
    }

    /** 读回自己落盘的蓝图与批次（读不到就如实说读不到，不猜） */
    private readOwnArtifacts(taskId: string, pid: number | null): {
        dir: string | null; blueprint: ArchitectTask | null; batches: ArchitectBatch[]; reasons: string[];
    } {
        const dir = this.taskDirOf(taskId, pid);
        const reasons: string[] = [];
        let blueprint: ArchitectTask | null = null;
        const batches: ArchitectBatch[] = [];
        if (!dir) {
            reasons.push("拿不到 _tasks 目录（项目号或 taskId 缺失）");
            return { dir: null, blueprint: null, batches, reasons };
        }
        const bpFile = path.join(dir, "blueprint.json");
        if (fs.existsSync(bpFile)) {
            try { blueprint = ArchitectTaskSchema.parse(JSON.parse(fs.readFileSync(bpFile, "utf-8"))); }
            catch (e) { reasons.push(`blueprint.json 不可用：${(e as Error).message}`); }
        } else {
            reasons.push(`蓝图文件不存在（${bpFile}）：本阶段可能还没派发，或 taskId 不对`);
        }
        try {
            for (const f of fs.readdirSync(dir)) {
                if (!f.startsWith("batch-") || !f.endsWith(".json")) continue;
                try {
                    batches.push(ArchitectBatchSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"))));
                } catch (e) {
                    reasons.push(`${f} 不可用：${(e as Error).message}`);
                }
            }
        } catch { /* 目录不存在：上面已经记过原因 */ }
        return { dir, blueprint, batches, reasons };
    }

    /** ownContext：只讲自己拥有的产物（工作项序、已交付批次、判据 id、技术栈、已签发修订） */
    private async renderOwnContext(taskId: string): Promise<string> {
        const pid = currentProjectId();
        const { dir, blueprint, batches, reasons } = this.readOwnArtifacts(taskId, pid);
        const items = blueprint?.foundationPlan.workItems ?? [];
        const deliveredIds = new Set(batches.map((b) => b.itemId));
        const pending = items.filter((w) => !deliveredIds.has(w.id));
        const revisions = this.planRevisions.get(taskId) ?? [];
        return [
            "# 架构师当前持有的产物（事实，逐条可核）",
            `- 产物目录：${dir ?? "（不可用）"}`,
            blueprint ? `- 蓝图：projectId=${blueprint.projectId} taskId=${blueprint.taskId}` : "- 蓝图：**没读到**",
            blueprint
                ? `- 技术栈：frontend=${blueprint.stackProfile.frontend} backend=${blueprint.stackProfile.backend}`
                    + `${blueprint.stackProfile.database ? ` database=${blueprint.stackProfile.database}` : ""}`
                : "",
            `- 工作项（顺序即执行序，${items.length}）：${items.map((w) => `${w.id}(${w.kind})`).join(" → ") || "（无）"}`,
            `- 已交付批次（${batches.length}）：${batches.map((b) => b.itemId).join("、") || "（无）"}`,
            `- **尚未交付**的工作项（${pending.length}）：${pending.map((w) => w.id).join("、") || "（无，蓝图已发满）"}`,
            `- 蓝图判据 id：${blueprint?.acceptanceChecks.map((c) => String((c as { id?: unknown }).id ?? "?" )).join("、") || "（无）"}`,
            `- 已签发的计划修订（${revisions.length}）：${revisions.map((r) => r.detail).join("；") || "（无）"}`,
            "",
            "## 注意事项",
            ...(reasons.length > 0 ? reasons.map((r) => `- 读取告警：${r}`) : ["- 产物读取无告警"]),
            "- 我不持有：生成项目的代码（司机）、判据的执行/判定（测试）、需求原文（PM）。",
            "- 蓝图字段一旦中途改写会让 developer 侧 acceptanceHash 漂移、已发批次失去前缀语义，"
                + "所以计划修订落在 consult-revisions.json 上，由下游读；**已冻结的蓝图字段不动**。",
        ].filter((l) => l !== "").join("\n");
    }

    /**
     * 层 B 的职权动作（只认自己拥有的产物；别的 kind 一律退回，不改任何状态）：
     *   batch_resend → 把**尚未交付**的那一批原样重发给 developer；
     *   plan_revision → 修订说明落盘 _tasks/<taskId>/consult-revisions.json（进 ownContext 与下游可见）。
     */
    private async applyArchitectAmendment(a: ConsultAmendment, taskId: string, pid: number | null): Promise<boolean> {
        if (a.kind === "batch_resend") {
            const { dir, blueprint, batches, reasons } = this.readOwnArtifacts(taskId, pid);
            if (!dir || !blueprint) {
                console.warn(`[architect] 批次重发被退回：读不到自己的产物（${reasons.join("；")}）`);
                return false;
            }
            const delivered = new Set(batches.map((b) => b.itemId));
            const wanted = typeof a.payload?.["itemId"] === "string" ? String(a.payload["itemId"]) : "";
            const items = blueprint.foundationPlan.workItems ?? [];
            const target = wanted
                ? items.find((w) => w.id === wanted)
                : items.find((w) => !delivered.has(w.id));
            if (!target) {
                console.warn(`[architect] 批次重发被退回：${wanted ? `工作项 ${wanted} 不在蓝图里` : "没有尚未交付的工作项"}`);
                return false;
            }
            const file = path.join(dir, batchFileNameOf(target.id));
            if (!fs.existsSync(file)) {
                // 诚实失败：批还没拆出来就不假装"已重发"（否则司机会以为等到了）
                console.warn(`[architect] 批次重发被退回：批次文件不存在（${file}）`);
                return false;
            }
            try {
                const batch = ArchitectBatchSchema.parse(JSON.parse(fs.readFileSync(file, "utf-8")));
                if (batch.projectId !== blueprint.projectId || batch.taskId !== blueprint.taskId) {
                    console.warn("[architect] 批次重发被退回：批次文件身份与蓝图不符");
                    return false;
                }
                this.station.sendMessage("architect", DEVELOPER_NAME, JSON.stringify(batch));
                console.log(`[architect] 层 B：按召唤重发批次 ${batch.itemId} → ${DEVELOPER_NAME}`);
                return true;
            } catch (e) {
                console.warn(`[architect] 批次重发失败：${(e as Error).message}`);
                return false;
            }
        }
        if (a.kind === "plan_revision") {
            const dir = this.taskDirOf(taskId, pid);
            if (!dir) return false;
            const list = this.planRevisions.get(taskId) ?? [];
            list.push({ detail: a.detail, ...(a.payload ? { payload: a.payload } : {}), at: Date.now() });
            this.planRevisions.set(taskId, list);
            try {
                fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(
                    path.join(dir, "consult-revisions.json"),
                    JSON.stringify({ taskId, revisions: list, updatedAt: new Date().toISOString() }, null, 2),
                    "utf-8",
                );
            } catch (e) {
                // 落盘失败 = 修订没有留下任何可核验的痕迹 → 按未生效处理（不骗司机）
                console.warn(`[architect] 计划修订落盘失败：${(e as Error).message}`);
                return false;
            }
            console.log(`[architect] 层 B：已记录计划修订（${taskId}）：${a.detail.slice(0, 200)}`);
            return true;
        }
        // 其余 kind（判据澄清/需求澄清/验收说明）不是架构师的产物 → 退回
        return false;
    }

    /** 注册实现（schema/code/cond）→ stitch() 拼接编译 → this.graph */
    private build(nodes: Node[], edges: Edge[]): void {
        schemaRegistry.register("architect_detailed_plan", detailedPlanSchema);
        schemaRegistry.register("architect_stack", stackSchema);
        // ★ 搬运⑤：栈一致性外部校验——需求原文取自图状态（plan 是 PM 消化后的需求全文，
        //   含各 feature 描述），决策文本取自 stack 产出。冲突短句由 checkStackConsistency 给出，
        //   在 llmNode 重试回调内抛出 → 有界重试带反馈重选（s4b 的接线教训：不靠模型吐新字段）。
        registerNodeValidator("architect_stack", async (value: any, state: any) => {
            // ★ 需求原文的权威来源是 sys_project.description（冻结需求）——state.plan 是 PM
            //   消化后的功能清单，栈关键词可能被洗掉（s4c 实测：PM 转述写了 Express，
            //   plan JSON 里没有 → 校验器空放行 → 又滑回 Spring Boot）。读库失败回退 plan。
            let requirement = "";
            try {
                const pid = currentProjectId();
                if (pid != null) requirement = await getProjectRequirement(pid);
            } catch { /* 读不到就走回退 */ }
            if (!requirement) {
                requirement = typeof state?.plan === "object" && state.plan !== null
                    ? JSON.stringify(state.plan)
                    : String(state?.plan ?? "");
            }
            const v = value ?? {};
            const decision = [
                v?.techniques?.database?.type, v?.techniques?.database?.why, v?.why,
                ...(Array.isArray(v?.moduleTech) ? v.moduleTech.map((m: any) => `${m?.backend ?? ""} ${m?.frontend ?? ""}`) : []),
            ].join("\n");
            return checkStackConsistency(requirement, decision);
        });
        schemaRegistry.register("architect_base", baseSchema);
        schemaRegistry.register("architect_bootstrap", bootstrapSchema);
        schemaRegistry.register("architect_resolution", resolutionSchema);
        schemaRegistry.register("architect_consult", consultSchema);
        codeRegistry.register("architect_confirm", confirmNode);
        codeRegistry.register("architect_consult", makeConsultNode());
        codeRegistry.register("architect_consult_gate", consultGateNode);
        codeRegistry.register("architect_bootstrap", bootstrapNode);
        codeRegistry.register("architect_dispatch", makeDispatchNode(this.station));
        condRegistry.register("architect_confirm_yes", confirmYes);
        condRegistry.register("architect_consult_pending", consultPending);
        condRegistry.register("architect_bootstrap_done", (s: any) => s.bootstrapDone === true);

        console.log(`[architect] 拼接编译拆分图：${nodes.map(n => n.nodeName).join(" → ")}`);
        this.graph = stitch(nodes, edges, {
            stateExtra: {
                plan: Annotation<any>({ default: () => null, reducer: (_: any, u: any) => u }),
                confirmAnswer: Annotation<any>({ default: () => null, reducer: (_: any, u: any) => u }),
                // 9/18 澄清环：本轮的提问（question 空串=没问题）+ 已问已回答的历史
                consult: Annotation<any>({ default: () => ({ question: "", why: "" }), reducer: (_: any, u: any) => u }),
                consultHistory: Annotation<any[]>({ default: () => [], reducer: (_: any[], u: any[]) => u }),
                exeTasks: Annotation<any[]>({ default: () => [], reducer: (_: any[], u: any[]) => u }),
                confirmMode: Annotation<number>({ default: () => 0, reducer: (_: number, u: number) => u }),
                bootstrapDone: Annotation<boolean>({ default: () => false, reducer: (_: boolean, u: boolean) => u }),
                // 新默认派发路径标记：dispatch 节点走了 architectTaskBuilder → developer。
                // 有了它，runPhaseSplit 才不会把"exeTasks 为空"误读成"拆分失败，声明 0 对完成"。
                architectTaskDispatched: Annotation<boolean>({ default: () => false, reducer: (_: boolean, u: boolean) => u }),
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
        // 新默认路径：任务包已直接派给 developer（无分层 ExecTask）——
        // 这里**不能**再走"声明 0 对完成"，否则维护会把刚派出去的阶段直接判完。
        if (state?.architectTaskDispatched === true) {
            console.log(`[architect] 阶段 ${phase.phase} 已按新路径派发 architect_task 给 developer（旧分层工位路径未启用）`);
            return;
        }
        // 任务登记和 doing 状态必须在阶段处理器结束前落库，避免进程边界丢写。
        await this.bridgeTasks(tasks, phase.phase, projectId ?? pid ?? undefined);
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
            await Promise.all(tasks.map(t => updateStatusByExt(projectId, t.id, "doing", undefined, phaseId)));
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
            backfillSliceFiles(parsed!);   // 同上：重设计也吃这条铁律
            const [nb, nf] = p0;
            const id = back.id;   // ★ 沿用原 pairId，保证测试计数（阶段:pairId）连续到第 6 次
            const apiBlock = apiContractBlock(nb.apis);
            const primary = nb.apis[0]!;

            // 后端任务：保留原 id/layer，契约整段换新（T4 竖切形状）；测试问题原文附进描述，开发照着改
            const newBack: ExecTask = {
                ...back,
                method: primary.method,
                path: primary.path,
                files: [...new Set(nb.apis.flatMap(a => a.files ?? []))],
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
                    files: [...new Set(nf.pages.flatMap(p => p.files ?? []))],
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
