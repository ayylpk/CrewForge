import { ChatDeepSeek } from "@langchain/deepseek";
import { SystemMessage } from "@langchain/core/messages";
import * as z from "zod";
import fs from "node:fs";
import path from "node:path";
import { TransferStation, roles, WorkQueue, llmWithTimeout } from "./Hub.ts";   // 中转站 + 角色枚举 + 工位队列 + 超时兜底

// 双实例分工：伪代码图用思考模式（设计业务逻辑要推理）；代码图用非思考（契约已定，执行性展开，快+省 token）
// thinking: {type:"disabled"} 是 DeepSeek v4 API 的关闭思考参数（实测有效）
const model = new ChatDeepSeek({
    model: "deepseek-v4-flash",
    timeout: 120000,   // 单次调用 120s 超时：thinking 模型大输出可能很慢，但必须有界（挂起走重试）
})

const codeModelBase = new ChatDeepSeek({
    model: "deepseek-v4-flash",
    timeout: 120000,
    thinking: { type: "disabled" },   // 非思考：代码展开是执行性工作，要速度
} as any)   // thinking 非 LangChain 官方字段，透传给 openai client

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

const codeModel = codeModelBase.withStructuredOutput(
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

// ============================================================
// 后端开发消息收发（参照 architect.ts 模板）
//   消息协议（content 为 JSON 字符串）：
//     架构师/合并器 → 后端: {"type": "task", "task": ExecTask}                 下发任务（layer 已筛过）/ 返工
//     后端 → 合并器:        {"type": "task_result", "task": ExecTask, "success": bool} 干完活交合并器配对
// ============================================================

// 后端开发入口（函数化：接收 agent 名 + 共享中转站，由 start.ts 拉起）
// name = "backend1"/"backend2"…（多开发负载均衡），station 是进程内全局唯一的站
//
// 真双工位流水线（信号量队列，非图）：
//   任务队列(pseudoQueue) →【伪代码工位】(LLM 伪代码) → 代码队列(codeQueue)
//     →【代码工位】(LLM 展开 + 写盘) → 交合并器
//   两个工位是独立循环：伪代码写完一个任务立刻开下一个，代码工位同时展开上一个——并行流水线
export async function runBackend(name: string, station: TransferStation) {
    const pseudoQueue = new WorkQueue<{ task: ExecTask }>();        // 任务 → 伪代码工位
    const codeQueue = new WorkQueue<{ task: ExecTask; pseudo: PseudoCode }>();   // 伪代码 → 代码工位
    const writtenFiles = new Map<string, string>();   // 追加语义：filePath → 最新代码（跨任务共享，同文件先读懂再追加）

    // 伪代码工位：取任务 → LLM 写伪代码（重试 ≤3）→ 塞代码队列；失败直接上报合并器
    async function pseudoWorker() {
        while (true) {
            const { task } = await pseudoQueue.pop();
            let pseudo: PseudoCode | null = null;
            for (let attempt = 1; attempt <= 3; attempt++) {
                const ts = Date.now();
                try {
                    // llmWithTimeout：外部超时兜底（150s，thinking 大输出实测 20~90s 波动）
                    const r = await llmWithTimeout(
                        sig => pseudoModel.invoke([
                            new SystemMessage(
                                pseudo_prompt +
                                `\n\n## 当前任务\n${JSON.stringify(task, null, 2)}` +
                                `\n\n## 项目路径\nworkspace`
                            ),
                        ], { signal: sig }),
                        150000,
                        `[${task.id}] 伪代码`
                    );
                    console.log(`[${task.id}] 伪代码 ${Date.now() - ts}ms`);
                    if (r.files.length > 0) { pseudo = r; break; }
                    console.log(`⚠️ ${task.id} 伪代码产出为空，重试 ${attempt}/3`);
                } catch (e) {
                    console.log(`⚠️ ${task.id} 伪代码 LLM 失败（第 ${attempt} 次，${Date.now() - ts}ms）：${(e as Error).message.slice(0, 80)}`);
                }
            }
            if (!pseudo) {
                console.log(`❌ ${task.id} 伪代码连续 3 次失败，上报合并器`);
                station.sendMessage(name, "merger", JSON.stringify({ type: "task_result", task, success: false }));
                continue;
            }
            codeQueue.push({ task, pseudo });   // 立即开下一个任务，代码工位并行展开
        }
    }

    // 代码工位：取伪代码 → 组装已有文件（追加语义）→ LLM 展开（重试 ≤3）→ 写盘 → 交合并器
    async function codeWorker() {
        while (true) {
            const { task, pseudo } = await codeQueue.pop();

            // 追加语义：本次伪代码涉及的文件里，哪些已由前面任务产出 → 注入已有内容（read→看懂→追加→保存）
            const existing = [...writtenFiles.entries()]
                .filter(([fp]) => pseudo.files.some(f => f.filePath === fp))
                .map(([filePath, code]) => ({ filePath, code }));
            const existingContent = existing.length > 0
                ? `\n\n## 已存在的文件（追加语义：先读懂原内容，同路径文件在原有代码基础上追加/修改，保留已有代码和风格）\n${existing.map(f => `--- ${f.filePath} ---\n${f.code}`).join("\n")}`
                : "";

            let last: CodeFile[] | null = null;
            for (let attempt = 1; attempt <= 3; attempt++) {
                const ts = Date.now();
                try {
                    const r = await llmWithTimeout(
                        sig => codeModel.invoke([
                            new SystemMessage(
                                code_prompt +
                                `\n\n## 伪代码\n${JSON.stringify(pseudo, null, 2)}` +
                                existingContent
                            ),
                        ], { signal: sig }),
                        150000,
                        `[${task.id}] 代码`
                    );
                    console.log(`[${task.id}] 代码 ${Date.now() - ts}ms`);
                    if (r.files.length > 0) { last = r.files; break; }
                    console.log(`⚠️ ${task.id} 代码产出为空，重试 ${attempt}/3`);
                } catch (e) {
                    console.log(`⚠️ ${task.id} 代码 LLM 失败（第 ${attempt} 次，${Date.now() - ts}ms）：${(e as Error).message.slice(0, 80)}`);
                }
            }
            if (!last) {
                console.log(`❌ ${task.id} 代码连续 3 次失败，上报合并器`);
                station.sendMessage(name, "merger", JSON.stringify({ type: "task_result", task, success: false }));
                continue;
            }
            // 写盘（路径净化防 .. 逃逸）+ 记录最新内容供后续任务追加
            for (const f of last) {
                const safePath = f.filePath.replace(/^[/\\]+/, "").replace(/\.\./g, "");
                const full = path.join("workspace", safePath);
                fs.mkdirSync(path.dirname(full), { recursive: true });
                fs.writeFileSync(full, f.code, "utf-8");
                console.log(`✓ 已写入 ${full}`);
            }
            for (const f of last) writtenFiles.set(f.filePath, f.code);
            console.log(`✓ ${task.id} 代码已写入 workspace/`);
            station.sendMessage(name, "merger", JSON.stringify({ type: "task_result", task, success: true }));
            console.log(`[${name}] → 合并器：任务 ${task.id} 完成，等配对`);
        }
    }

    // 两个工位并行拉起（各自挂在队列 pop 上；LLM 等待期间事件循环交替执行）
    const w1 = pseudoWorker();
    const w2 = codeWorker();

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
                // 架构师下发 / 合并器返工 → 入伪代码队列（不 await，工位并行处理）
                console.log(`[${name}] ← ${msg.sender}：收到任务 ${data.task?.id}（${data.task?.title}）`);
                if (data.task) pseudoQueue.push({ task: data.task });
            }

            // 测试返工：revision（带问题清单）→ issues 拼进任务描述针对性修改 → 重进伪代码队列
            if (senderRole === roles.testEngineer && data.type === "revision" && data.task) {
                console.log(`[${name}] ← 测试：任务 ${data.task.id} 返工（${data.issues?.length ?? 0} 条意见）`);
                const revised = {
                    ...data.task,
                    description: data.task.description + "\n\n【测试返工意见（必须逐条解决）】\n" + (data.issues ?? []).join("\n"),
                };
                pseudoQueue.push({ task: revised });
            }
            station.markDone(name);   // 处理完记账（负载均衡的数据基础：pendingCount -1）
        }
    }

    // 挂住等消息（进程保持存活；伪代码/代码工位在后台并行运转）
    await messageLoop();
}



