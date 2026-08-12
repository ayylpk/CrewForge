import { ChatDeepSeek } from "@langchain/deepseek";
import { SystemMessage } from "@langchain/core/messages";
import * as z from "zod";
import { Annotation, StateGraph, START, END, MemorySaver, type GraphNode } from "@langchain/langgraph";
import fs from "node:fs";
import readline from "readline";
import { TransferStation, roles } from "./Hub.ts";   // 架构师与 PM 的消息中转站 + 角色枚举

// ============================================================
// 架构师链路（v1）：PM 阶段计划 → 拆分下发为止
//
//   PM阶段划分 → agent1详细计划(业务分解) → agent2技术栈(中间件裁剪+表结构+绑定)`
//   → 用户确认 → agent3基础架构 → agent4接口拆分 → 交接（tasks.json）
//
// 边界（重要）：架构师只负责到拆分下发，之后是开发/测试/维护的事（executor.ts）
// 交接物：tasks.json（ExecTask[]，任务=原子）—— 未来换成 sys_task 表
//
// 关键约定：
//   - 技术决策单一归属 agent2（agent1 只出业务分解，不含技术）
//   - agent4 拆接口：LLM 出接口形态（RESTful），id/验收标准代码机械补（契约不发明）
//   - 防死循环：确认门最多拒绝 1 次重计划
// ============================================================

const model = new ChatDeepSeek({
    model: "deepseek-v4-flash",
})

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

// ---------- 类型定义 ----------

interface typeOfTasks{
  name: string,
  description: string,
  priority: string,
  acceptance: string
}

interface planItem {
  phase: number;
  name: string;
  goal: string;
  features: string[];      // 该阶段包含的功能名
  dependencies: string[];  // 依赖的阶段名
  relative_effort: string; // 大 | 中 | 小（不评估人天）
  risk: string;            // 高 | 中 | 低
}

// PM 产出：结构化 PRD + 阶段规划（manager.ts 的输出，本文件从 plan.json 读）
interface Plan {
  project: string;
  features: typeOfTasks[]; // 详细功能清单原样放回
  phases: planItem[];
  mvp_scope: string[];
  risks: string[];
}

// agent1 产出：业务分解版详细计划（不含技术）
interface DetailedPlan {
  phase: number;
  summary: string;
  modules: ModulePlan[];
  risks: string[];
  deliverables: string[];
}

// 业务模块：dataNeeds 是 agent2 出表结构的原料
interface ModulePlan {
  name: string;        // 模块名
  business: string;    // 对应功能名（Plan.features 里的名字，agent4 抄验收用）
  description: string; // 业务逻辑/流程
  dataNeeds: string[]; // 要存什么数据 —— agent2 据此设计表结构
  points: string[];    // 业务子步骤 —— agent4 据此拆 ExecTask
}

// agent2 产出：技术栈（全技术唯一归属：选型 + 表结构 + 按模块绑定）
interface TechStack {
  techniques: {
    middleware: { name: string; purpose: string }[];
    database: { type: string; why: string };
  };
  tables: TablePlan[];
  // 按层绑定：backend = 服务端技术，frontend = 客户端技术（agent4 拆任务时各抄各的）
  moduleTech: { module: string; backend: string; frontend: string }[];
  why: string;
}

interface TablePlan {
  name: string;                    // 表名
  purpose: string;                 // 服务哪个数据需求
  fields: {
    name: string;
    type: string;                  // varchar/int/datetime…
    required: boolean;
    remark: string;                // 业务含义
  }[];
}

// agent3 产出：基础架构动作
interface BasePlan {
  actions: string[];
  ddl: string;
}

// agent4 产出：可执行任务（任务 = 一个接口的一层 = 原子，交接给执行层）
// 每个接口拆成两个任务：[0]后端 + [1]前端，layer 区分；method/path 仅后端任务有
// 交接形态：只留定义性字段；status/output/retries/review_comment 是执行层运行字段，
// 等 executor（开发/测试）写的时候再定义，架构师不关心
interface ExecTask {
  id: string;
  layer: "backend" | "frontend";  // 归属层（backendEngineer 只筛 backend）
  method: string;        // GET/POST/PUT/DELETE（前端任务为空串）
  path: string;          // 接口路径（前端任务为空串）
  files: string[];       // 架构师指定的文件清单（按技术栈约定列全，如 Java 三层 Controller/Service/Mapper）——开发照做不探索
  title: string;         // "POST /api/tasks：创建任务" / "任务创建页：表单+列表刷新"
  description: string;   // 任务描述（含模块/业务/对应层技术栈/要素，自包含）
  parameters: {
    name: string;
    type: string;        // string/number/boolean…
    required: boolean;
    description: string; // 业务含义
  }[];
  acceptance: string;    // 验收标准（从 Plan.features 原样抄 —— 任务的验收契约，交接给执行层用）
}

// ---------- 状态通道 ----------
// 通道名不能和节点名重名（老约定）；执行层无对话，所以没有 messages 通道
const MessageState = Annotation.Root({
    plans: Annotation<Plan | null>({
        default: () => null,
        reducer: (_, u) => u,
    }),
    phaseIdx: Annotation<number>({
        default: () => 0,
        reducer: (_, u) => u,  // 阶段指针（v1 固定 0，v2 套阶段循环）
    }),
    detailedPlan: Annotation<DetailedPlan | null>({
        default: () => null,
        reducer: (_, u) => u,  // 每阶段覆盖写
    }),
    stack: Annotation<TechStack | null>({
        default: () => null,
        reducer: (_, u) => u,
    }),
    userConfirm: Annotation<boolean>({
        default: () => false,
        reducer: (_, u) => u,
    }),
    confirmPending: Annotation<boolean>({
        default: () => false,
        reducer: (_, u) => u,  // true = 图停了，等 main() 问用户
    }),
    feedback: Annotation<string | null>({
        default: () => null,
        reducer: (_, u) => u,  // 确认门拒绝原因
    }),
    baseReady: Annotation<boolean>({
        default: () => false,
        reducer: (_, u) => u,
    }),
    basePlan: Annotation<BasePlan | null>({
        default: () => null,
        reducer: (_, u) => u,
    }),
    exeTasks: Annotation<ExecTask[]>({
        default: () => [],
        reducer: (_, u) => u,  // 交接物（任务=原子）
    }),
    handoffMsg: Annotation<string | null>({
        default: () => null,
        reducer: (_, u) => u,  // 交接提示（main 据此写 tasks.json）
    }),
    llmCalls: Annotation<number>({
        default: () => 0,
        reducer: (x, y) => x + y, // debug 用
    }),
});

// ---------- 系统提示词 ----------

// agent1：业务分解（先跑，不含技术）
const plan_prompt: string = `
# 角色定义
你是 CrewForge 项目的【架构师-详细计划】Agent，负责把当前阶段的业务功能拆解成【业务模块蓝图】。

## 工作目标
1. 模块拆解：把本阶段功能拆成业务模块，一个模块对应一个功能（business 填功能名）
2. 业务逻辑：description 写清模块的业务流程
3. 数据需求：dataNeeds 列出该模块要存的数据（实体/字段需求）——下游技术栈 Agent 据此设计表结构
4. 实现要点：points 拆成可执行的业务子步骤——下游任务拆分 Agent 按它拆任务

## 边界（严格遵守）
- 不做技术选型、不写表结构（那是技术栈 Agent 的职责）
- 不发明新功能，只拆解输入清单里的功能

## 输出格式（必须遵守）
只输出一段 JSON，不要夹带讨论：
{
  "summary": "一句话：本阶段做哪些业务",
  "modules": [
    {
      "name": "模块名",
      "business": "对应功能名",
      "description": "业务逻辑/流程",
      "dataNeeds": ["要存的数据"],
      "points": ["业务子步骤"]
    }
  ],
  "risks": ["业务实现风险"],
  "deliverables": ["交付物清单"]
}
`;

// agent2：技术落地（后跑，技术唯一归属）
const stack_prompt: string = `
# 角色定义
你是 CrewForge 项目的【架构师-技术栈】Agent，负责技术落地：中间件裁剪 + 数据库字段设计 + 按模块绑定技术。技术决策的唯一归属就是你。

## 工作目标
1. 中间件裁剪：根据业务需求从常见技术里选，只留必需的，每个都要给用途
2. 表结构设计：把模块的 dataNeeds 落成具体表 + 字段（数据库类型自己定，给理由）
3. 技术绑定：moduleTech 给每个模块指定技术实现，**必须按层分开**——backend 填服务端技术（框架/ORM/数据库操作），frontend 填客户端技术（前端框架/UI 库/请求库）

## 输入
业务详细计划（模块 + 数据需求 + 实现要点）

## 输出格式（必须遵守）
只输出一段 JSON，不要夹带讨论：
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

// agent3：基础架构（对照 tables/deliverables 检查补缺）
const base_prompt: string = `
# 角色定义
你是 CrewForge 项目的【架构师-基础架构】Agent，负责为当前阶段搭建/补缺基础架构。

## 工作目标
根据技术栈（中间件、表结构）和交付物清单，产出本阶段要做的基建动作：
1. actions：要新建/补齐的脚手架、配置、目录等动作（已有工程基础时只补缺）
2. ddl：把表结构落成建表 SQL（DDL）

## 输出格式（必须遵守）
只输出一段 JSON，不要夹带讨论：
{ "actions": ["基建动作"], "ddl": "建表 SQL" }
`;

// agent4：接口拆分（LLM 出接口形态；id/验收标准由代码机械补，验收契约不发明）
const api_prompt: string = `
# 角色定义
你是 CrewForge 项目的【架构师-接口设计】Agent，负责把业务模块拆成【接口任务对】。任务是原子的：一个接口 = 两个任务（后端任务 + 前端任务）。

## 工作目标
1. 接口拆分：根据每个模块的实现要点（points）和数据需求，拆出对应的接口
2. 每个接口必须拆成一对任务：后端任务（接口形态：method/path/入参/返回）+ 前端任务（页面形态：页面/交互/调用的接口）
3. 粒度：一个业务要点通常对应 1-2 个接口；一个模块可以拆出多个接口

## 输入
业务模块（数据需求 + 实现要点）+ 技术绑定（每个模块用什么技术实现，backend/frontend 分开）

## 边界（严格遵守）
- 只设计接口/页面形态，不写实现细节（那是执行层的事）
- module 必须原样使用输入里的模块名，不能自创（下游按它抄验收标准）
- 后端入参的 type 用简单类型：string/number/boolean/array/object
- 前端任务的 api 字段填它调用的接口（method + path），必须和该对后端任务一致
- files：按技术栈约定列全本任务要写的文件（Java 三层架构 → controller/service/mapper 三个文件；Express 分层 → routes/service/db 按需；简单接口一个文件即可）。这是开发唯一允许产出的文件清单，不得遗漏，也不要填不相关的文件

## 输出格式（必须遵守）
只输出一段 JSON，不要夹带讨论。tasks 是二维数组：每个接口一对 [后端任务, 前端任务]：
{
  "tasks": [
    [
      { "method": "POST", "path": "/api/tasks", "module": "模块名", "purpose": "接口职责", "files": ["src/routes/tasks.ts"], "parameters": [{ "name": "title", "type": "string", "required": true, "description": "任务标题" }], "response": "返回说明" },
      { "module": "模块名", "page": "页面/组件名", "files": ["src/pages/TasksForm.vue"], "interactions": "页面交互（表单/列表/刷新等）", "api": "POST /api/tasks" }
    ]
  ]
}
`;

// ---------- 结构化输出模型 ----------

// agent1：业务分解（无兜底：schema 校验失败即抛错，外层 catch 接住）
const planModel = model.withStructuredOutput(
  z.object({
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
  }),
  { method: "jsonMode", name: "extract_detailed_plan" }
);

// agent2：技术栈
const stackModel = model.withStructuredOutput(
  z.object({
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
  }),
  { method: "jsonMode", name: "extract_stack" }
);

// agent3：基础架构
const baseModel = model.withStructuredOutput(
  z.object({
    actions: z.array(z.string()),
    ddl: z.string(),
  }),
  { method: "jsonMode", name: "extract_base_plan" }
);

// agent4：接口拆分（LLM 出接口/页面形态；id/验收标准在 dispatch 节点里机械补）
// tasks 二维数组：每个接口一对 [后端任务, 前端任务]（z.tuple 定长 2）
const resolutionModel = model.withStructuredOutput(
  z.object({
    tasks: z.array(z.tuple([
      // [0] 后端任务：接口形态
      z.object({
        method: z.string(),
        path: z.string(),
        module: z.string(),      // 模块名必须和 detailedPlan 一致（代码据此抄验收标准）
        purpose: z.string(),
        files: z.array(z.string()), // 文件清单（技术栈约定，开发照做不探索）
        parameters: z.array(z.object({
          name: z.string(),
          type: z.string(),
          required: z.boolean(),
          description: z.string(),
        })),
        response: z.string(),
      }),
      // [1] 前端任务：页面形态
      z.object({
        module: z.string(),
        page: z.string(),        // 页面/组件名
        files: z.array(z.string()), // 文件清单（页面组件文件）
        interactions: z.string(), // 页面交互
        api: z.string(),         // 调用的接口（method + path，与同对后端一致）
      }),
    ])),
  }),
  { method: "jsonMode", name: "extract_api_tasks" }
);

// ---------- 节点 ----------

// agent1：详细计划（业务分解）
const architectPlan: GraphNode<typeof MessageState.State> = async (state) => {
  const plan = state.plans!;
  const phase = plan.phases[state.phaseIdx]!; // phaseIdx 由阶段循环保证有效
  // 本阶段功能详情：按名字从 plan.features 里筛（带验收标准，架构师不重新发明）
  const featuresContent = plan.features
    .filter(f => phase.features.includes(f.name))
    .map((f, i) => `${i + 1}. ${f.name}（${f.priority}）：${f.description} | 验收：${f.acceptance}`)
    .join('\n');

  const parsed = await planModel.invoke([
    new SystemMessage(plan_prompt + `\n\n## 本阶段\n阶段${phase.phase}「${phase.name}」目标：${phase.goal}\n\n## 本阶段功能详情\n${featuresContent}`),
  ]);
  return { detailedPlan: { ...parsed, phase: phase.phase }, llmCalls: 1 };
};

// agent2：技术栈（读业务计划，出全技术）
const architectStack: GraphNode<typeof MessageState.State> = async (state) => {
  const d = state.detailedPlan!;
  const modulesContent = d.modules
    .map((m, i) => `${i + 1}. ${m.name}（对应功能：${m.business}）\n   业务：${m.description}\n   数据需求：${m.dataNeeds.join("、")}\n   要点：${m.points.join("；")}`)
    .join('\n');

  const parsed = await stackModel.invoke([
    new SystemMessage(stack_prompt + `\n\n## 业务详细计划（阶段${d.phase}）\n${modulesContent}`),
  ]);
  return { stack: parsed, llmCalls: 1 };
};

// 用户确认门：userConfirm 没置位就停（confirmPending=true），等 main() 问用户再回来
const confirmGate: GraphNode<typeof MessageState.State> = async (state) => {
  if (!state.userConfirm) return { confirmPending: true };
  return { confirmPending: false };
};

// agent3：基础架构（对照表结构和交付物补缺）
const base: GraphNode<typeof MessageState.State> = async (state) => {
  const stack = state.stack!;
  const parsed = await baseModel.invoke([
    new SystemMessage(
      base_prompt +
      `\n\n## 技术栈\n中间件：${stack.techniques.middleware.map(m => `${m.name}（${m.purpose}）`).join("、")}\n数据库：${stack.techniques.database.type}（${stack.techniques.database.why}）` +
      `\n\n## 表结构\n${stack.tables.map(t => `${t.name}：${t.fields.map(f => f.name).join("、")}`).join("\n")}` +
      `\n\n## 交付物\n${state.detailedPlan!.deliverables.join("、")}`
    ),
  ]);
  return { baseReady: true, basePlan: parsed, llmCalls: 1 };
};

// agent4：接口拆分 —— LLM 出接口形态（RESTful），id/验收标准代码机械补（验收契约不发明）
// 幂等：exeTasks 空才调 LLM，崩溃重启时已拆过就直接返回（结果在 state 里，可恢复）
const dispatch: GraphNode<typeof MessageState.State> = async (state) => {
  let tasks = state.exeTasks;
  if (tasks.length === 0) {
    const plan = state.plans!;
    const detailed = state.detailedPlan!;
    const stack = state.stack!;

    // 输入给 LLM：业务模块（数据需求 + 要点）→ 设计接口
    const modulesContent = detailed.modules
      .map((m, i) => `${i + 1}. ${m.name}（对应功能：${m.business}）\n   数据需求：${m.dataNeeds.join("、")}\n   要点：${m.points.join("；")}`)
      .join('\n');
    const techContent = stack.moduleTech.map(mt => `${mt.module} → 后端：${mt.backend}｜前端：${mt.frontend}`).join("\n");

    const parsed = await resolutionModel.invoke([
      new SystemMessage(api_prompt + `\n\n## 业务模块（阶段${detailed.phase}）\n${modulesContent}\n\n## 技术绑定\n${techContent}`),
    ]);

    // 完整技术上下文：中间件 + 数据库（agent2 唯一归属，机械抄不发明）
    const middlewareContent = stack.techniques.middleware.map(m => `${m.name}（${m.purpose}）`).join("、");
    const dbContent = `${stack.techniques.database.type}（${stack.techniques.database.why}）`;

    // 机械部分：每个接口对拆成后端+前端两个任务；id 顺序生成；验收标准从 Plan.features 按模块 business 原样抄
    tasks = parsed.tasks.flatMap((pair, i) => {
      const [back, front] = pair;
      // 模块名兜底匹配：LLM 可能在模块名上增删字（如"任务创建"→"任务创建模块"），严格匹配失败时按包含匹配
      const mod = detailed.modules.find(m => m.name === back.module)
        ?? detailed.modules.find(m => back.module.includes(m.name) || m.name.includes(back.module));
      const acceptance = plan.features.find(f => f.name === mod?.business)?.acceptance ?? "功能可正常使用";
      const mtech = stack.moduleTech.find(mt => mt.module === back.module)
        ?? stack.moduleTech.find(mt => back.module.includes(mt.module) || mt.module.includes(back.module));
      const backendTech = mtech?.backend ?? "";
      const frontendTech = mtech?.frontend ?? "";

      // 后端任务（接口形态）
      const backendTask: ExecTask = {
        id: `T${i + 1}`,
        layer: "backend",
        method: back.method,
        path: back.path,
        files: back.files,
        title: `${back.method} ${back.path}：${back.purpose}`,
        description: `模块：${back.module}\n业务：${mod?.business}\n技术：${backendTech}\n中间件：${middlewareContent}\n数据库：${dbContent}\n入参：${back.parameters.map(p => `${p.name}(${p.type}${p.required ? "" : "，可选"})`).join("、")}\n返回：${back.response}`,
        parameters: back.parameters,
        acceptance,
      };

      // 前端任务（页面形态，method/path 空串）
      // 自包含铁律：后端契约机械抄进前端描述（字段名/格式/枚举照抄，前端工程师不探索、不猜）
      const contract = `\n\n【后端契约（前端必须遵守：字段名/格式/枚举值照抄，不得改名）】\n接口：${back.method} ${back.path}\n入参：${back.parameters.map(p => `${p.name}(${p.type}${p.required ? "" : "，可选"})：${p.description}`).join("、")}\n返回：${back.response}`;
      const frontendTask: ExecTask = {
        id: `T${i + 1}-F`,
        layer: "frontend",
        method: "",
        path: "",
        files: front.files,
        title: `${front.page}：${front.interactions}`,
        description: `模块：${front.module}\n业务：${mod?.business}\n技术：${frontendTech}\n页面：${front.page}\n交互：${front.interactions}\n调用接口：${front.api}` + contract,
        parameters: [],
        acceptance,
      };

      return [backendTask, frontendTask];
    });
    return { exeTasks: tasks, llmCalls: 1 };
  }
  return { exeTasks: tasks };
};

// 交接：拆分完成，提示 main() 把任务清单写进 tasks.json（未来 = sys_task 表）
const handoff: GraphNode<typeof MessageState.State> = async (state) => {
  return { handoffMsg: `任务已拆分 ${state.exeTasks.length} 个，交接给执行层` };
};

// ---------- 路由（条件边）----------

// START 断点路由：崩溃/重启后按状态续跑
const resume = (state: typeof MessageState.State): string => {
  if (state.confirmPending) return "confirmGate";              // 确认门待决
  if (state.baseReady || state.exeTasks.length > 0) return "dispatch"; // 已过确认 → 直接到拆分（幂等）
  if (state.detailedPlan && state.stack) return "confirmGate"; // 计划+选型就绪未确认
  if (state.detailedPlan) return "architectStack";
  return "architectPlan";
};

// 确认门后：确认 → 基建；拒绝带原因 → 架构师带 feedback 重计划；没表态（confirmPending）→ 结束等 main
const afterConfirm = (state: typeof MessageState.State): string => {
  if (state.userConfirm) return "base";
  if (state.feedback) return "architectPlan";
  return "__end__";
};

// ---------- 组装图 ----------
// 架构师职责到此为止：计划 → 选型 → 确认 → 基建 → 拆分 → 交接
const graph = new StateGraph(MessageState)
  .addNode("architectPlan", architectPlan)   // agent1 业务分解
  .addNode("architectStack", architectStack) // agent2 技术落地
  .addNode("confirmGate", confirmGate)       // 用户确认门
  .addNode("base", base)                     // agent3 基础架构
  .addNode("dispatch", dispatch)             // agent4 拆分（纯代码）
  .addNode("handoff", handoff)               // 交接（任务清单落盘）
  .addConditionalEdges(START, resume)
  .addEdge("architectPlan", "architectStack")
  .addEdge("architectStack", "confirmGate")
  .addConditionalEdges("confirmGate", afterConfirm)
  .addEdge("base", "dispatch")
  .addEdge("dispatch", "handoff")
  .addEdge("handoff", END)
  .compile({ checkpointer: new MemorySaver() });

// ---------- 交互 ----------

function ask(question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question + " ", resolve));
}

// 确认门：把方案概要打印给用户看
function printConfirm(state: typeof MessageState.State) {
  const d = state.detailedPlan!;
  const s = state.stack!;
  console.log("\n========== 技术方案（待确认）==========");
  console.log(`方案：${d.summary}`);
  console.log("模块与技术绑定：");
  s.moduleTech.forEach(mt => console.log(`  ${mt.module} → 后端：${mt.backend}｜前端：${mt.frontend}`));
  console.log("中间件：");
  s.techniques.middleware.forEach(m => console.log(`  ${m.name}（${m.purpose}）`));
  console.log(`数据库：${s.techniques.database.type}（${s.techniques.database.why}）`);
  console.log("表结构：");
  s.tables.forEach(t => console.log(`  ${t.name}：${t.fields.map(f => f.name).join("、")}`));
  if (d.risks.length) console.log(`风险：${d.risks.join("；")}`);
  console.log("========================================");
}

// ============================================================
// 架构师消息收发（参照 manager.ts 模板）
//   消息协议（content 为 JSON 字符串）：
//     PM → 架构师:       {"type": "phase_plan", "phase": {...}}   下发阶段计划
//     维护 → 架构师:     {"type": "phase_done", "phase": N}       汇报阶段完成（任务全做完）
//     架构师 → PM:       {"type": "phase_request", "phase": N}    请求下一阶段（收到维护的完成才发）
// ============================================================

// 拆分一个阶段：读 plan.json → 只给当前阶段的 features → 跑拆分图 → 确认门 → tasks.json
// 消息驱动：PM 发 phase_plan 才调用（不再启动就跑）；阶段=原子，一次只拆一个阶段
// station：下发给开发/维护用（由 runArchitect 传入）
async function runPhaseSplit(phase: planItem, station: TransferStation) {
    const full = JSON.parse(fs.readFileSync("plan.json", "utf-8")) as Plan;
    // 只把当前阶段的 features 丢给拆分图（验收标准从全量 features 里按名抄）
    const planForPhase: Plan = {
        project: full.project,
        features: full.features.filter(f => phase.features.includes(f.name)),
        phases: [phase],
        mvp_scope: full.mvp_scope,
        risks: full.risks,
    };

    const thread = { configurable: { thread_id: `architect-phase-${phase.phase}` } };  // 每阶段独立断点
    let rejects = 0; // 防死循环：确认门最多拒绝 1 次重计划

    try {
        let state = await graph.invoke({ plans: planForPhase }, thread);
        while (true) {
            if (state.handoffMsg) break; // 拆分交接完成
            if (state.confirmPending) {
                printConfirm(state);   // 给用户看方案
                // 测试钩子：AUTO_CONFIRM=1 时自动确认（CI/脚本验证用，不影响手动交互）
                if (process.env.AUTO_CONFIRM === "1") { state = await graph.invoke({ userConfirm: true }, thread); continue; }
                const ans = await ask("技术方案如上，确认开工？(y / n+原因)");
                if (/^y/i.test(ans.trim())) {
                    state = await graph.invoke({ userConfirm: true }, thread);
                    continue;
                }
                rejects += 1;
                if (rejects >= 2) { console.log("连续两次拒绝，结束（防死循环）。"); break; }
                const reason = ans.replace(/^n/i, "").trim() || "方案不满足需求";
                state = await graph.invoke({ userConfirm: false, feedback: reason }, thread);
                continue;
            }
            break; // 兜底
        }

        if (state.exeTasks.length > 0) {
            // 交接物落盘：任务=原子，执行层按它接手（未来 = sys_task 表）
            fs.writeFileSync("tasks.json", JSON.stringify(state.exeTasks, null, 2));
            console.log(`\n${state.handoffMsg}`);
            console.log(`交接物：tasks.json（${state.exeTasks.length} 个任务，含验收标准和技术绑定）`);

            // 按 layer 分流 + 负载均衡下发给前后端开发（确定性路由，代码决定，不需要 LLM）
            // 协议：{"type": "task", "task": ExecTask}
            // 多开发场景：同一角色有多个注册（backend1/backend2），pickLeastBusy 选待处理最少的那个
            state.exeTasks.forEach(t => {
                const role = t.layer === "backend" ? roles.backendEngineer : roles.frontendEngineer;
                const target = station.pickLeastBusy(role);
                if (!target) {
                    console.log(`⚠️ 没有 ${t.layer} 开发注册，任务 ${t.id} 下发失败`);
                    return;
                }
                station.sendMessage("architect", target, JSON.stringify({ type: "task", task: t }));
                console.log(`架构师 → ${target}：下发任务 ${t.id}（${t.title}）`);
            });

            // 任务全部下发完 → 向维护声明本阶段任务清单（当前一次性拆完：final=true）
            // 维护按"已声明对全部通过 + final"判断阶段完成（集合收敛，不依赖预定的 N；
            // 以后流水线分批拆分时：每批发一次声明（final=false），最后一批发 final=true）
            const pairIds = [...new Set(state.exeTasks.map(t => t.id.endsWith("-F") ? t.id.slice(0, -2) : t.id))];
            station.sendMessage("architect", "maintainer", JSON.stringify({ type: "tasks_declared", phase: phase.phase, pairIds, final: true }));
            console.log(`架构师 → 维护：声明本阶段任务 ${pairIds.length} 对（final=true，阶段 ${phase.phase}）`);

            console.log(`[debug] llmCalls=${state.llmCalls}`);
        }
    } catch (error) {
        // 崩溃/校验失败：打印错误后重跑即可（MemorySaver + thread_id + resume 会从断点续跑）
        console.error("出错了:", error);
        console.log("重新运行 bun run architect.ts 即可从断点恢复。");
    }
}

// 架构师入口（函数化：单例，名字写死 "architect"；由 start.ts 拉起）
export async function runArchitect(station: TransferStation) {
    // 架构师消息循环：收两方消息——PM 的阶段计划 + 维护的完成信号
    // 收到维护的"完成"之后，才向 PM 请求下一阶段
    async function messageLoop() {
        console.log("[architect] 消息监听已启动：等 PM 下发阶段计划 / 维护汇报完成");
        while (true) {
            const msg = await station.waitForMessage("architect");
            if (!msg) continue;
            let data: { type?: string; phase?: planItem };
            try { data = JSON.parse(msg.content); } catch { continue; }

            if (msg.sender === "manager" && data.type === "phase_plan") {
                // PM 下发阶段计划 → 跑拆分（只拆消息里这个阶段，阶段=原子）
                console.log(`[architect] ← PM：收到阶段计划（阶段 ${data.phase?.phase}）`);
                if (data.phase) await runPhaseSplit(data.phase, station);
            } else if (msg.sender === "maintainer" && data.type === "phase_done") {
                // 维护汇报：本阶段任务全部完成 → 转告 PM 请求下一阶段
                console.log(`[architect] ← 维护：阶段 ${data.phase?.phase} 全部完成`);
                station.sendMessage("architect", "manager", JSON.stringify({ type: "phase_request", phase: data.phase?.phase }));
                console.log(`[architect] → PM：请求下一阶段（阶段 ${data.phase?.phase} 已完成）`);
            }
            station.markDone("architect");   // 处理完记账（负载均衡的数据基础：pendingCount -1）
        }
    }

    // 挂住等消息（进程保持存活；拆分在 messageLoop 里由消息触发）
    await messageLoop();
}
