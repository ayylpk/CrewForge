import { ChatDeepSeek } from "@langchain/deepseek";
import { SystemMessage } from "@langchain/core/messages";
import * as z from "zod";
import { Annotation, StateGraph, START, END, MemorySaver, type GraphNode } from "@langchain/langgraph";
import fs from "node:fs";
import path from "node:path";
import { TransferStation, roles } from "./Hub.ts";   // 后端与架构师/测试的消息中转站 + 角色枚举

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
  files: string[];       // 架构师指定的文件清单（只写这些文件，不得另起）
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
    existingFiles: Annotation<{ filePath: string; code: string }[]>({
        default: () => [],
        reducer: (_, u) => u,   // 追加语义：同文件已由前面任务产出的内容，注入提示词（read→看懂→追加→保存）
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
为当前任务产出代码文件：
1. 判断复杂度：
   - 简单接口（CRUD 直通、无业务逻辑、无数据转换）→ code 直接写完整可运行代码
   - 复杂接口（有数据转换/权限校验/多表操作/分支循环/业务规则）→ 逻辑部分用伪代码占位：中文注释写清"做什么、为什么"，配关键代码骨架，交给下一节点展开成完整代码
2. filePath：**只用任务 files 字段里列出的路径**（架构师指定的文件清单，照做不探索）；files 里每个文件都要产出，不得遗漏、不得另起文件
3. 代码风格：严格按任务描述中的【技术】【中间件】【数据库】字段

## 边界（严格遵守）
- 不发明新需求，只实现当前任务描述里的接口
- 不新增 files 之外的文件路径
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
3. 已存在的文件（追加语义）：和本次文件路径相同的旧文件内容会附在下方，先读懂再在其基础上追加/修改

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

    // 追加语义：只把本次伪代码涉及文件（路径相同）的已有内容注入，避免无关文件刷屏
    const existingContent = state.existingFiles.length > 0
        ? `\n\n## 已存在的文件（追加语义：先读懂原内容，同路径文件在原有代码基础上追加/修改，保留已有代码和风格）\n${state.existingFiles.map(f => `--- ${f.filePath} ---\n${f.code}`).join("\n")}`
        : "";

    const response = await codeModel.invoke([
        new SystemMessage(
            code_prompt +
            `\n\n## 伪代码\n${JSON.stringify(currentPseudo, null, 2)}` +
            existingContent
        ),
    ]);

    // 删除逻辑：有产出才出队；空产出留在队首（下次 invoke 重试）
    if (response.files.length > 0) {
        // 正式版：按 filePath 写盘到工作区（替换控制台输出）；路径净化防 .. 逃逸
        for (const f of response.files) {
            const safePath = f.filePath.replace(/^[/\\]+/, "").replace(/\.\./g, "");
            const full = path.join("workspace", safePath);
            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, f.code, "utf-8");
            console.log(`✓ 已写入 ${full}`);
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

// ============================================================
// 后端开发消息收发（参照 architect.ts 模板）
//   消息协议（content 为 JSON 字符串）：
//     架构师/合并器 → 后端: {"type": "task", "task": ExecTask}                 下发任务（layer 已筛过）/ 返工
//     后端 → 合并器:        {"type": "task_result", "task": ExecTask, "success": bool} 干完活交合并器配对
// ============================================================

const writtenFiles = new Map<string, string>();   // 追加语义：filePath → 最新代码（跨任务共享，同文件先读懂再追加）

// 处理单个任务（从 main() 的双工位流水线提炼）：伪代码图 → 代码图 → 写盘 workspace/
// 返回是否成功（失败也交测试，测试按 task_result.success 判断）
async function processOneTask(t: ExecTask): Promise<boolean> {
    // B 工位：伪代码图（重试 ≤3，防卡死）
    let state: typeof MessageState.State | undefined;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            state = await pseudoGraph.invoke(
                { execTasks: [t], project: "workspace" },
                { configurable: { thread_id: `b-${t.id}` } }   // 每任务独立断点
            );
        } catch (e) {
            console.log(`⚠️ ${t.id} LLM 调用失败（第 ${attempt} 次）：${(e as Error).message.slice(0, 80)}`);
            state = undefined;
            continue;
        }
        if (state.pseudoCodes.length > 0) break;
        console.log(`⚠️ ${t.id} 伪代码产出为空，重试 ${attempt}/3`);
    }
    if (!state || state.pseudoCodes.length === 0) {
        console.log(`❌ ${t.id} 连续 3 次失败，标记失败跳过`);
        return false;
    }
    const p = state.pseudoCodes[0]!;

    // 追加语义：本次伪代码涉及的文件里，哪些已由前面任务产出 → 注入已有内容（read→看懂→追加→保存）
    const existing = [...writtenFiles.entries()]
        .filter(([fp]) => p.files.some(f => f.filePath === fp))
        .map(([filePath, code]) => ({ filePath, code }));

    // C 工位：代码图（重试 ≤3）
    let cstate: typeof MessageState.State | undefined;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            cstate = await codeGraph.invoke(
                { pseudoCodes: [p], project: "workspace", existingFiles: existing },
                { configurable: { thread_id: `c-${p.description}` } }
            );
        } catch (e) {
            console.log(`⚠️ LLM 调用失败（第 ${attempt} 次）：${(e as Error).message.slice(0, 80)}`);
            cstate = undefined;
            continue;
        }
        const last = cstate.codeContents[cstate.codeContents.length - 1];
        if (last && last.files.length > 0) break;   // 有产出才往下走
        console.log(`⚠️ 代码产出为空，重试 ${attempt}/3`);
    }
    const last = cstate ? cstate.codeContents[cstate.codeContents.length - 1] : undefined;
    if (!last || last.files.length === 0) {
        console.log(`❌ 连续 3 次失败，标记失败跳过：${p.description.slice(0, 40)}`);
        return false;
    }
    for (const f of last.files) writtenFiles.set(f.filePath, f.code);   // 记录最新内容，供后续任务追加
    console.log(`✓ ${t.id} 代码已写入 workspace/`);
    return true;
}

// 后端消息循环：收架构师的任务 → 干活（processOneTask）→ 交测试
// 后端开发入口（函数化：接收 agent 名 + 共享中转站，由 start.ts 拉起）
// name = "backend1"/"backend2"…（多开发负载均衡），station 是进程内全局唯一的站
export async function runBackend(name: string, station: TransferStation) {
    async function messageLoop() {
        console.log(`[${name}] 消息监听已启动：等架构师下发任务`);
        while (true) {
            const msg = await station.waitForMessage(name);
            if (!msg) continue;
            let data: { type?: string; task?: ExecTask; success?: boolean; issues?: string[] };
            try { data = JSON.parse(msg.content); } catch { continue; }

            // 用角色检测发送方（多实例场景名字可能是 test1/test2，role 才是身份）
            const senderRole = station.status[msg.sender]?.role;

            if ((msg.sender === "architect" || msg.sender === "merger") && data.type === "task") {
                // 架构师下发 / 合并器返工 → 干活（伪代码图 + 代码图 → 写盘 workspace/）
                console.log(`[${name}] ← ${msg.sender}：收到任务 ${data.task?.id}（${data.task?.title}）`);
                if (data.task) {
                    const ok = await processOneTask(data.task);
                    // 干完 → 交合并器配对（成功与否都交，success 由合并器判断是否返工）
                    station.sendMessage(name, "merger", JSON.stringify({ type: "task_result", task: data.task, success: ok }));
                    console.log(`[${name}] → 合并器：任务 ${data.task.id} ${ok ? "完成" : "失败"}，等配对`);
                }
            }

            // 测试返工：revision（带问题清单）→ issues 拼进任务描述针对性修改 → 重新交合并器配对
            if (senderRole === roles.testEngineer && data.type === "revision" && data.task) {
                console.log(`[${name}] ← 测试：任务 ${data.task.id} 返工（${data.issues?.length ?? 0} 条意见）`);
                const revised = {
                    ...data.task,
                    description: data.task.description + "\n\n【测试返工意见（必须逐条解决）】\n" + (data.issues ?? []).join("\n"),
                };
                const ok = await processOneTask(revised);
                station.sendMessage(name, "merger", JSON.stringify({ type: "task_result", task: data.task, success: ok }));
                console.log(`[${name}] → 合并器：任务 ${data.task.id} 返工${ok ? "完成" : "仍失败"}，重新交配`);
            }
            station.markDone(name);   // 处理完记账（负载均衡的数据基础：pendingCount -1）
        }
    }

    // 挂住等消息（进程保持存活；干活在 messageLoop 里由消息触发）
    await messageLoop();
}



