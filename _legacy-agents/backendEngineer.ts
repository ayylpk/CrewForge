import { SystemMessage } from "@langchain/core/messages";
import fs from "node:fs";
import path from "node:path";
import { TransferStation, roles, WorkQueue, llmWithTimeout } from "./Hub.ts";   // 中转站 + 角色枚举 + 工位队列 + 超时兜底
import { getModel, getModelRequestTimeout } from "./modelRegistry.ts";

// 后端任务一次生成完整文件，避免将首轮产物整体注入第二次模型调用。
const model = getModel("backend");

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

// ---------- 后端实现提示词 ----------

const pseudo_prompt: string = `
# 角色
你是 CrewForge 项目的后端文件实现 Agent。当前任务已经由架构师定义，你负责为指定文件产出完整、可运行的代码。

## 输入
1. 当前任务（接口信息 + 技术栈：技术/中间件/数据库，任务描述里已自包含）
2. 项目路径（决定 filePath 写哪个文件）

## 工作目标
1. 为当前任务 files 中唯一指定的文件产出完整、可运行的实现。
2. 补齐校验、错误处理、数据转换和必要的持久化调用。
3. 严格遵循任务中给出的技术、依赖、中间件和数据库，不自行换栈。
4. 已有文件内容存在时，只做完成任务所需的最小修改。

## 边界
- 只实现当前任务描述和验收标准，不发明字段、接口行为或额外功能。
- 不新增 files 之外的文件路径。
- 任务契约不明确的地方保留为风险或最小假设，不要编造业务规则。
- 输出中的代码必须与 method、path、参数、返回契约保持一致。

- 只输出目标文件的完整源代码，不要 JSON、Markdown 代码围栏或额外说明。
`;

function extractGeneratedCode(content: unknown): string | null {
    const text = typeof content === "string"
        ? content
        : Array.isArray(content)
            ? content.map(part => {
                if (typeof part === "string") return part;
                if (part && typeof part === "object" && "text" in part && typeof (part as { text?: unknown }).text === "string") {
                    return (part as { text: string }).text;
                }
                return "";
            }).join("")
            : "";
    const trimmed = text.trim();
    if (!trimmed) return null;
    const fenced = trimmed.match(/^```[^\r\n]*\r?\n([\s\S]*?)\r?\n?```$/);
    const code = (fenced?.[1] ?? trimmed).trim();
    return code || null;
}

// ============================================================
// 后端开发消息收发（参照 architect.ts 模板）
//   消息协议（content 为 JSON 字符串）：
//     架构师/合并器 → 后端: {"type": "task", "task": ExecTask}                 下发任务（layer 已筛过）/ 返工
//     后端 → 合并器:        {"type": "task_result", "task": ExecTask, "success": bool} 干完活交合并器配对
// ============================================================

// 后端开发入口（函数化：接收 agent 名 + 共享中转站，由 start.ts 拉起）
// name = "backend1"/"backend2"…（多开发负载均衡），station 是进程内全局唯一的站
//
// 单次实现队列：每个后端任务只调用一次模型，写盘后交给合并器。
export async function runBackend(name: string, station: TransferStation) {
    const implementationQueue = new WorkQueue<{ task: ExecTask }>();
    const writtenFiles = new Map<string, string>();

    async function implementationWorker() {
        while (true) {
            const { task } = await implementationQueue.pop();
            if (task.files.length === 0) {
                console.log(`${task.id} 后端任务没有文件，无需 LLM 调用，直接交付`);
                station.sendMessage(name, "merger", JSON.stringify({ type: "task_result", task, success: true }));
                continue;
            }

            const implementation: CodeFile[] = [];
            let failed = false;

            for (const filePath of task.files) {
                let code: string | null = null;
                for (let attempt = 1; attempt <= 3; attempt++) {
                    const ts = Date.now();
                    const knownFiles = new Map<string, string>([
                        ...writtenFiles,
                        ...implementation.map(file => [file.filePath, file.code] as const),
                    ]);
                    const existing = [...knownFiles.entries()]
                        .filter(([knownPath]) => task.files.includes(knownPath))
                        .map(([knownPath, knownCode]) => `--- ${knownPath} ---\n${knownCode}`)
                        .join("\n");
                    const existingContent = existing ? `\n\n## 已存在的文件\n${existing}` : "";
                    const fileTask = { ...task, files: [filePath] };

                    try {
                        const response = await llmWithTimeout(
                            sig => model.invoke([
                                new SystemMessage(
                                    pseudo_prompt +
                                    `\n\n## 当前任务\n${JSON.stringify(fileTask, null, 2)}` +
                                    `\n\n## 项目路径\nworkspace` +
                                    existingContent
                                ),
                            ], { signal: sig }),
                            getModelRequestTimeout("backend"),
                            `[${task.id}] 后端文件 ${filePath}`
                        );
                        console.log(`[${task.id}] 后端文件 ${filePath} ${Date.now() - ts}ms`);
                        code = extractGeneratedCode(response.content);
                        if (code) break;
                        console.log(`提示：${task.id} 后端文件 ${filePath} 没有产出代码，重试 ${attempt}/3`);
                    } catch (e) {
                        console.log(`${task.id} 后端文件 ${filePath} LLM 失败（第 ${attempt} 次，${Date.now() - ts}ms）：${(e as Error).message.slice(0, 80)}`);
                    }
                }

                if (!code) {
                    failed = true;
                    break;
                }
                implementation.push({ description: "后端文件实现", filePath, code });
            }

            if (failed) {
                console.log(`${task.id} 后端实现连续 3 次失败，上报合并器`);
                station.sendMessage(name, "merger", JSON.stringify({ type: "task_result", task, success: false }));
                continue;
            }
            for (const f of implementation) {
                const safePath = f.filePath.replace(/^[/\\]+/, "").replace(/\.\./g, "");
                const full = path.join("workspace", safePath);
                fs.mkdirSync(path.dirname(full), { recursive: true });
                fs.writeFileSync(full, f.code, "utf-8");
                console.log(`已写入 ${full}`);
            }
            for (const f of implementation) writtenFiles.set(f.filePath, f.code);
            console.log(`${task.id} 后端实现已写入 workspace/`);
            station.sendMessage(name, "merger", JSON.stringify({ type: "task_result", task, success: true }));
            console.log(`[${name}] 发送到合并器：任务 ${task.id} 完成，等配对`);
        }
    }

    void implementationWorker();

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
                // 架构师下发 / 合并器返工 → 入实现队列。
                console.log(`[${name}] 收到 ${msg.sender} 的任务：${data.task?.id}（${data.task?.title}）`);
                if (data.task) implementationQueue.push({ task: data.task });
            }

            // 测试返工：revision（带问题清单）→ issues 拼进任务描述针对性修改 → 重进实现队列。
            if (senderRole === roles.testEngineer && data.type === "revision" && data.task) {
                console.log(`[${name}] 收到测试返工：任务 ${data.task.id}（${data.issues?.length ?? 0} 条意见）`);
                const revised = {
                    ...data.task,
                    description: data.task.description + "\n\n【测试返工意见（必须逐条解决）】\n" + (data.issues ?? []).join("\n"),
                };
                implementationQueue.push({ task: revised });
            }
            station.markDone(name);   // 处理完记账（负载均衡的数据基础：pendingCount -1）
        }
    }

    // 挂住等消息，后端实现工位在后台按队列处理任务。
    await messageLoop();
}



