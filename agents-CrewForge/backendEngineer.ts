import { ChatDeepSeek } from "@langchain/deepseek";
import { SystemMessage } from "@langchain/core/messages";
import * as z from "zod";
import { Annotation, StateGraph, START, END, MemorySaver, type GraphNode } from "@langchain/langgraph";
import fs from "node:fs";

const model = new ChatDeepSeek({
    model: "deepseek-v4-flash",
})

//   [
//     {
//       "id": "T1",
//       "method": "POST",
//       "path": "/api/tasks",
//       "title": "POST /api/tasks：创建新任务，校验必填字段和格式，保存并生成ID和创建时间",
//       "description": "模块：任务创建\n业务：任务创建\n技术：Node.js + Express + express-validator + PostgreSQL（或
//   Fastify + zod + Prisma 均可）\n入参：title(string)、priority(string)、dueTime(string)\n返回：返回创建成功的任务对象，包
//   含任务ID、标题、优先级、截止时间、创建时间",
//       "parameters": [
//         { "name": "title", "type": "string", "required": true, "description": "任务标题，必填" },
//         { "name": "priority", "type": "string", "required": true, "description": "优先级，必填，取值如 high/medium/low"
//   },
//         { "name": "dueTime", "type": "string", "required": true, "description": "截止时间，必填，格式为ISO 8601" }
//       ],
//       "acceptance": "创建后列表出现且字段完整"
//     },
//     {
//       "id": "T2",
//       "method": "GET",
//       "path": "/api/tasks",
//       "title": "GET /api/tasks：获取任务列表，用于创建后刷新列表展示",
//       "description": "模块：任务创建\n业务：任务创建\n技术：Node.js + Express + express-validator + PostgreSQL（或
//   Fastify + zod + Prisma 均可）\n入参：\n返回：返回任务列表数组，每个任务包含任务ID、标题、优先级、截止时间、创建时间",
//       "parameters": [],
//       "acceptance": "创建后列表出现且字段完整"
//     }
//   ]

interface ExecTask {
  id: string;
  layer: "backend" | "frontend";  // 归属层（backendEngineer 只处理 backend）
  method: string;        // GET/POST/PUT/DELETE（前端任务为空串）
  path: string;          // 接口路径（前端任务为空串）
  title: string;         // "POST /api/tasks：创建任务"
  description: string;   // 任务描述（含模块/业务/技术/入参/返回，自包含）
  parameters: {
    name: string;
    type: string;        // string/number/boolean…
    required: boolean;
    description: string; // 业务含义
  }[];
  acceptance: string;    // 验收标准（从 Plan.features 原样抄 —— 任务的验收契约，交接给执行层用）
}

// 单个文件结构
interface CodeFile {
  description: string;  
  filePath: string;
  code: string;
}

// 1. 伪代码接口（设计阶段）
interface PseudoCode {
  description: string;      
  files: CodeFile[];        
}

// 2. 实际代码接口（实现阶段）
interface CodeContent {
  description: string;      
  files: CodeFile[];      
}

const PseudoCodeReducer = (
  current: PseudoCode[] = [],
  update: PseudoCode[] | PseudoCode
): PseudoCode[] => {
  if (Array.isArray(update) && update.length === 0) {
    return [];
  }
  if (Array.isArray(update)) {
    return [...current, ...update];
  }
  return [...current, update];
};

const codeContentReducer = (
  current: CodeContent[] = [],
  update: CodeContent[] | CodeContent
): CodeContent[] => {
  if (Array.isArray(update) && update.length === 0) {
    return [];
  }
  if (Array.isArray(update)) {
    return [...current, ...update];
  }
  return [...current, update];
};

const MessageState = Annotation.Root({
    execTasks: Annotation<ExecTask[]>({
        default: () => [],
        reducer: (_, u) => u,
    }),
    pseudoCodes: Annotation<PseudoCode[]> ({
        default: () => [],
        reducer: PseudoCodeReducer,
    }),
    codeContents: Annotation<CodeContent[]>({
        default: () => [],
        reducer: codeContentReducer,
    }),
    summary: Annotation<number>({
        default: () => 0,
        reducer: (x, y) => x + y,
    }),   
    llmCalls: Annotation<number>({
        default: () => 0,
        reducer: (x, y) => x + y,
    }),
    project: Annotation<string>({
        default: () => "",
        reducer: (x) => x
    })
});


// ---------- 伪代码提示词 ----------

// 核心策略：简单接口直接写完整代码；复杂接口逻辑用伪代码占位，交给下一节点展开
const pseudo_prompt: string = `
# 角色定义
你是 CrewForge 项目的【后端开发-伪代码设计】Agent。当前任务是一个接口，你要产出该接口的代码文件（伪代码/完整代码）。

## 输入
1. 当前任务（接口信息 + 技术栈：技术/中间件/数据库，任务描述里已自包含）
2. 项目路径（决定 filePath 写哪个文件）

## 工作目标
为当前任务产出代码文件（一个任务可拆多个文件，如 controller/service/mapper 分层）：
1. 判断复杂度：
   - 简单接口（CRUD 直通、无业务逻辑、无数据转换）→ code 直接写完整可运行代码
   - 复杂接口（有数据转换/权限校验/多表操作/分支循环/业务规则）→ 逻辑部分用伪代码占位：中文注释写清"做什么、为什么"，配关键代码骨架，交给下一节点展开成完整代码
2. filePath：根据项目路径和任务技术栈约定决定写入位置；目录不存在时给出建议路径
3. 代码风格：严格按任务描述中的【技术】【中间件】【数据库】字段

## 边界（严格遵守）
- 不发明新需求，只实现当前任务描述里的接口
- 伪代码占位必须能看懂逻辑意图（注释里写清做什么和为什么），下一节点据此展开

## 输出格式（必须遵守）
只输出一段 JSON，不要夹带讨论：
{
  "description": "本次产出说明",
  "files": [
    { "description": "文件职责", "filePath": "src/routes/tasks.ts", "code": "完整代码或伪代码" }
  ]
}
`;

// ---------- 结构化输出模型 ----------

const pseudoModel = model.withStructuredOutput(
  z.object({
    description: z.string(),
    files: z.array(z.object({
      description: z.string(),
      filePath: z.string(),
      code: z.string(),
    })),
  }),
  { method: "jsonMode", name: "extract_pseudo_code" }
);

// ---------- 节点 ----------

// 伪代码节点：每次只处理队首任务（execTasks[0]），产出追加进 pseudoCodes
// 删除逻辑：产出非空（files.length > 0）→ 出队（slice(1)）；空 → 留在队首，下轮重试
const PseudoCodeNode: GraphNode<typeof MessageState.State> = async (state) => {
    const currentTask = state.execTasks[0];
    if (!currentTask) return {};  // 队列空，无事可做

    const response = await pseudoModel.invoke([
        new SystemMessage(
            pseudo_prompt +
            `\n\n## 当前任务\n${JSON.stringify(currentTask, null, 2)}` +
            `\n\n## 项目路径\n${state.project || "workspace"}`
        ),
    ]);

    // 删除逻辑：有产出才出队；空产出留在队首（下次 invoke 重试）
    if (response.files.length > 0) {
        return { pseudoCodes: [response], execTasks: state.execTasks.slice(1), llmCalls: 1 };
    }
    return { llmCalls: 1 };
};

// ---------- 实际代码提示词 ----------

// 核心策略：把伪代码展开成完整可运行代码（逻辑占位 → 真实实现），保持 filePath 不动
const code_prompt: string = `
# 角色定义
你是 CrewForge 项目的【后端开发-代码实现】Agent。上一步已经给出了伪代码，你要把它展开成完整可运行的代码。

## 输入
1. 伪代码（含代码骨架和中文注释描述的逻辑意图）
2. 技术栈在伪代码里已有体现（按原风格写）

## 工作目标
1. 展开：把伪代码里的逻辑占位全部替换成真实实现（保留注释里的意图），产出完整可运行代码
2. filePath：原样保留伪代码里的文件路径，不要改动
3. 代码风格：与伪代码保持一致（同语言、同框架、同中间件）

## 边界（严格遵守）
- 不发明新需求，只实现伪代码描述的逻辑
- 不新增文件路径，只展开伪代码已有的文件；确有必要时（如依赖缺失的配置文件）才新增

## 输出格式（必须遵守）
只输出一段 JSON，不要夹带讨论：
{
  "description": "本次产出说明",
  "files": [
    { "description": "文件职责", "filePath": "src/routes/tasks.ts", "code": "完整可运行代码" }
  ]
}
`;

// ---------- 结构化输出模型 ----------

const codeModel = model.withStructuredOutput(
  z.object({
    description: z.string(),
    files: z.array(z.object({
      description: z.string(),
      filePath: z.string(),
      code: z.string(),
    })),
  }),
  { method: "jsonMode", name: "extract_code" }
);

// ---------- 节点 ----------

// 实际代码节点：每次只处理队首伪代码（pseudoCodes[0]），展开成完整代码并写盘
// 删除逻辑：产出非空（files.length > 0）→ 写盘 + 出队（slice(1)）；空 → 留在队首，下轮重试
const CodeWriterNode: GraphNode<typeof MessageState.State> = async (state) => {
    const currentPseudo = state.pseudoCodes[0];
    if (!currentPseudo) return {};  // 无待实现伪代码

    const response = await codeModel.invoke([
        new SystemMessage(
            code_prompt +
            `\n\n## 伪代码\n${JSON.stringify(currentPseudo, null, 2)}`
        ),
    ]);

    // 删除逻辑：有产出才出队；空产出留在队首（下次 invoke 重试）
    if (response.files.length > 0) {
        // 演示版：代码输出到控制台（正式版改为按 filePath 写盘）
        for (const f of response.files) {
            console.log(`\n===== 文件：${f.filePath} =====`);
            console.log(f.code);
            console.log("===== 文件结束 =====\n");
        }
        return { codeContents: [response], pseudoCodes: state.pseudoCodes.slice(1), llmCalls: 1 };
    }
    return { llmCalls: 1 };
};

// ---------- 工具 ----------

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---------- 组装图 ----------
// 双工位流水线：每个工位一个单节点图（节点化保留，未来映射 sys_agent_step）

// 伪代码图：单节点（B 工位）
const pseudoGraph = new StateGraph(MessageState)
    .addNode("pseudoCode", PseudoCodeNode)
    .addEdge(START, "pseudoCode")
    .addEdge("pseudoCode", END)
    .compile({ checkpointer: new MemorySaver() });

// 代码图：单节点（C 工位）
const codeGraph = new StateGraph(MessageState)
    .addNode("codeWriter", CodeWriterNode)
    .addEdge(START, "codeWriter")
    .addEdge("codeWriter", END)
    .compile({ checkpointer: new MemorySaver() });

// ---------- 双工位流水线（图 + 并发循环） ----------

async function main() {
    const all = JSON.parse(fs.readFileSync("tasks.json", "utf-8")) as ExecTask[];
    const tasks = all.filter(t => t.layer === "backend");   // 后端工程师只处理后端任务（前端任务留给前端工程师）
    console.log(`读取 ${all.length} 个任务，其中后端 ${tasks.length} 个，流水线开工\n`);
    const queue: PseudoCode[] = [];   // 传送带（main 里的共享数组）
    let bDone = false;

    // B 工位：每任务 invoke 一次伪代码图（图的节点逻辑原样保留）
    async function stationB() {
        for (const t of tasks) {
            const state = await pseudoGraph.invoke(
                { execTasks: [t], project: "workspace" },
                { configurable: { thread_id: `b-${t.id}` } }   // 每任务独立断点
            );
            queue.push(state.pseudoCodes[0]!);                 // 取图上传送带（图跑完必然出货）
        }
        bDone = true;
    }

    async function stationC() {
        while (true) {
            const p = queue.shift();
            if (!p) {
                if (bDone) break;
                await sleep(100);
                continue;
            }
            await codeGraph.invoke(
                { pseudoCodes: [p], project: "workspace" },
                { configurable: { thread_id: `c-${p.description}` } }
            );   // 输出代码在 CodeWriterNode 里（原逻辑）
        }
    }

    await Promise.all([stationB(), stationC()]);
    console.log("流水线全部完成");
}

main();



