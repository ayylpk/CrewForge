import { ChatDeepSeek } from "@langchain/deepseek";
import { SystemMessage } from "@langchain/core/messages";
import * as z from "zod";
import fs from "node:fs";
import path from "node:path";
import { TransferStation, roles, WorkQueue, llmWithTimeout } from "./Hub.ts";   // 中转站 + 角色枚举 + 工位队列 + 超时兜底

// 前端全程非思考：契约自包含（后端契约照抄），执行性最强，要速度
// thinking: {type:"disabled"} 是 DeepSeek v4 API 的关闭思考参数（实测有效）
const model = new ChatDeepSeek({
    model: "deepseek-v4-flash",
    timeout: 120000,   // 单次调用 120s 超时：thinking 模型大输出可能很慢，但必须有界（挂起走重试）
    thinking: { type: "disabled" },
} as any)   // thinking 非 LangChain 官方字段，透传给 openai client

// ============================================================
// 前端工程师链路（v1）：前端任务 → 结构样式 → 逻辑脚本 → 完整组件
//
//   execTasks(前端任务) → structureNode(模板+样式) → logicNode(脚本逻辑) → 输出组件
//
// 关键约定：
//   - 结构节点产静态页面（引用主题变量 var()，禁写死颜色值）
//   - 逻辑节点追加脚本（ref/handler 名必须与模板一致，用请求封装调任务描述里的接口）
//   - 双工位流水线：结构工位(模板+样式) → 逻辑工位(补脚本+写盘)，信号量队列并行（同 backendEngineer.ts）
//   - main 只筛 layer === "frontend" 的任务（后端任务留给 backendEngineer.ts）
// ============================================================

// ---------- 类型定义 ----------

interface ExecTask {
  id: string;
  layer: "backend" | "frontend";  // 归属层（frontendEngineer 只处理 frontend）
  method: string;        // GET/POST/PUT/DELETE（前端任务为空串）
  path: string;          // 接口路径（前端任务为空串）
  files: string[];       // 架构师指定的文件清单（只写这些文件，不得另起）
  title: string;         // 页面/组件任务标题
  description: string;   // 任务描述（含页面/交互/调用接口，自包含）
  parameters: {
    name: string;
    type: string;        // string/number/boolean…
    required: boolean;
    description: string; // 业务含义
  }[];
  acceptance: string;    // 验收标准（从 Plan.features 原样抄 —— 任务的验收契约）
}

// 单个文件结构
interface CodeFile {
  description: string;
  filePath: string;
  code: string;
}

// 结构/逻辑节点产出：组件文件集合
interface CodeContent {
  description: string;
  files: CodeFile[];
}

// ---------- 基建占位（演示版） ----------
// 正式版：架构师搭目录时产出 theme.css 和 request 封装，节点从 workspace 读取

const DEFAULT_THEME = `
:root {
  --primary: #1a2a4a;      /* 主色：藏青 */
  --accent: #00d4ff;       /* 强调：赛博蓝 */
  --bg: #0d1117;           /* 背景 */
  --card: #161b26;         /* 卡片 */
  --text: #e6e6e6;         /* 文字 */
  --radius: 8px;
}
`;

const DEFAULT_REQUEST = `
// request.ts —— 全局请求封装（基建产出）
import axios from 'axios';
const request = axios.create({ baseURL: '/api', timeout: 10000 });
export default request;
`;

// ---------- 提示词 ----------

// 结构节点：模板 + 样式（静态部分）
const structure_prompt: string = `
# 角色定义
你是 CrewForge 项目的【前端工程师-结构样式】Agent。当前任务是一个页面/组件，你要产出它的模板和样式（静态部分）。

## 输入
1. 当前任务（页面/交互/调用接口 + 前端技术栈，任务描述里已自包含）
2. 主题变量（CSS 变量，必须引用）
3. 请求封装（逻辑节点会用它调接口，结构层不需要写调用）

## 工作目标
产出页面组件文件（模板 + 样式）：
0. filePath：**只用任务 files 字段里列出的路径**（架构师指定的文件清单，照做不探索）；files 里每个文件都要产出，不得遗漏、不得另起文件
1. 模板：按任务描述的页面和交互搭结构（表单/列表/按钮等），组件库标签优先
2. 样式：引用主题变量（var(--primary) 等），禁止写死颜色值
3. 给关键元素命名（ref/class/handler 名），逻辑节点会按名字补脚本
4. **样式必须产出，不许漏**：Vue 场景在 .vue 文件的 <style> 块里写样式；React 场景在 files 里单独产出 .css 文件（组件里 import 它）

## 边界（严格遵守）
- 只写静态部分（模板+样式），不写脚本逻辑（那是逻辑节点的活）
- handler 名用语义化命名（如 submitForm/loadList），逻辑节点按名绑定
- 如果任务描述里带【后端契约】：提交/筛选/渲染的字段名、格式、枚举值**必须照抄契约**，不得自己改名或换格式（如契约是 dueTime 就不能写 deadline，契约要 ISO 8601 就不能发 YYYY-MM-DD）

## 输出格式（必须遵守）
只输出一段 JSON，不要夹带讨论：
{ "description": "本次产出说明", "files": [{ "description": "文件职责", "filePath": "src/pages/TasksForm.vue", "code": "模板+样式" }] }
`;

// 逻辑节点：补脚本（动态部分）
const logic_prompt: string = `
# 角色定义
你是 CrewForge 项目的【前端工程师-逻辑实现】Agent。结构节点已产出页面的模板和样式，你要补全脚本逻辑让它动起来。

## 输入
1. 结构组件（模板+样式，含 ref/handler 命名，description 里带任务信息）
2. 任务信息（交互描述 + 调用接口，在结构组件的 description 里）

## 工作目标
1. 脚本：补全 <script> 逻辑——表单校验、事件绑定、API 调用、数据渲染
2. ref/handler 名必须与模板一致（不得改名）
3. 用请求封装调任务描述里的接口（调用接口：method + path）
4. 返回完整组件文件（模板+样式+脚本）：**样式必须保留**——.vue 场景 <style> 块原样保留，React 场景 .css 文件一并输出

## 边界（严格遵守）
- 不改动模板结构（除非必要）
- 不发明任务描述之外的交互

## 输出格式（必须遵守）
只输出一段 JSON，不要夹带讨论：
{ "description": "本次产出说明", "files": [{ "description": "文件职责", "filePath": "src/pages/TasksForm.vue", "code": "完整组件（模板+样式+脚本）" }] }
`;

// ---------- 结构化输出模型 ----------

const contentModel = model.withStructuredOutput(
  z.object({
    description: z.string(),
    files: z.array(z.object({
      description: z.string(),
      filePath: z.string(),
      code: z.string(),
    })),
  }),
  { method: "jsonMode", name: "extract_component" }
);

// ============================================================
// 前端开发消息收发（参照 backendEngineer.ts 模板）
//   消息协议（content 为 JSON 字符串）：
//     架构师/合并器 → 前端: {"type": "task", "task": ExecTask}                 下发任务（layer 已筛过）/ 返工
//     前端 → 合并器:        {"type": "task_result", "task": ExecTask, "success": bool} 干完活交合并器配对
// ============================================================

// 前端开发入口（函数化：接收 agent 名 + 共享中转站，由 start.ts 拉起）
// name = "frontend1"/"frontend2"…（多开发负载均衡），station 是进程内全局唯一的站
//
// 真双工位流水线（信号量队列，非图，同 backendEngineer）：
//   任务队列(structQueue) →【结构工位】(LLM 模板+样式) → 逻辑队列(logicQueue)
//     →【逻辑工位】(LLM 补脚本 + 写盘) → 交合并器
export async function runFrontend(name: string, station: TransferStation) {
    const structQueue = new WorkQueue<{ task: ExecTask }>();        // 任务 → 结构工位
    const logicQueue = new WorkQueue<{ task: ExecTask; structure: CodeContent }>();   // 结构 → 逻辑工位
    const writtenFiles = new Map<string, string>();   // 追加语义：filePath → 最新代码（跨任务共享，同文件先读懂再追加）

    // 结构工位：取任务 → LLM 模板+样式（重试 ≤3）→ 任务信息并入 description → 塞逻辑队列；失败上报
    async function structureWorker() {
        while (true) {
            const { task } = await structQueue.pop();
            let structure: CodeContent | null = null;
            for (let attempt = 1; attempt <= 3; attempt++) {
                const ts = Date.now();
                try {
                    const r = await llmWithTimeout(
                        sig => contentModel.invoke([
                            new SystemMessage(
                                structure_prompt +
                                `\n\n## 当前任务\n${JSON.stringify(task, null, 2)}` +
                                `\n\n## 主题变量\n${DEFAULT_THEME}` +
                                `\n\n## 请求封装\n${DEFAULT_REQUEST}`
                            ),
                        ], { signal: sig }),
                        150000,
                        `[${task.id}] 结构`
                    );
                    console.log(`[${task.id}] 结构 ${Date.now() - ts}ms`);
                    if (r.files.length > 0) {
                        // 任务信息并入 description，逻辑工位自包含（原 StructureNode 语义）
                        structure = { ...r, description: `【任务】${task.title}\n${task.description}\n【产出】${r.description}` };
                        break;
                    }
                    console.log(`⚠️ ${task.id} 结构产出为空，重试 ${attempt}/3`);
                } catch (e) {
                    console.log(`⚠️ ${task.id} 结构 LLM 失败（第 ${attempt} 次，${Date.now() - ts}ms）：${(e as Error).message.slice(0, 80)}`);
                }
            }
            if (!structure) {
                console.log(`❌ ${task.id} 结构连续 3 次失败，上报合并器`);
                station.sendMessage(name, "merger", JSON.stringify({ type: "task_result", task, success: false }));
                continue;
            }
            logicQueue.push({ task, structure });   // 立即开下一个任务，逻辑工位并行补脚本
        }
    }

    // 逻辑工位：取结构 → 组装已有文件（追加语义）→ LLM 补脚本（重试 ≤3）→ 写盘 → 交合并器
    async function logicWorker() {
        while (true) {
            const { task, structure } = await logicQueue.pop();

            // 追加语义：本次结构涉及的文件里，哪些已由前面任务产出 → 注入已有内容
            const existing = [...writtenFiles.entries()]
                .filter(([fp]) => structure.files.some(f => f.filePath === fp))
                .map(([filePath, code]) => ({ filePath, code }));
            const existingContent = existing.length > 0
                ? `\n\n## 已存在的文件（追加语义：先读懂原内容，同路径文件在原有代码基础上追加/修改，保留已有代码和风格）\n${existing.map(f => `--- ${f.filePath} ---\n${f.code}`).join("\n")}`
                : "";

            let last: CodeFile[] | null = null;
            for (let attempt = 1; attempt <= 3; attempt++) {
                const ts = Date.now();
                try {
                    const r = await llmWithTimeout(
                        sig => contentModel.invoke([
                            new SystemMessage(
                                logic_prompt +
                                `\n\n## 结构组件\n${JSON.stringify(structure, null, 2)}` +
                                existingContent
                            ),
                        ], { signal: sig }),
                        150000,
                        `[${task.id}] 逻辑`
                    );
                    console.log(`[${task.id}] 逻辑 ${Date.now() - ts}ms`);
                    if (r.files.length > 0) { last = r.files; break; }
                    console.log(`⚠️ ${task.id} 逻辑产出为空，重试 ${attempt}/3`);
                } catch (e) {
                    console.log(`⚠️ ${task.id} 逻辑 LLM 失败（第 ${attempt} 次，${Date.now() - ts}ms）：${(e as Error).message.slice(0, 80)}`);
                }
            }
            if (!last) {
                console.log(`❌ ${task.id} 逻辑连续 3 次失败，上报合并器`);
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
            console.log(`✓ ${task.id} 组件已写入 workspace/`);
            station.sendMessage(name, "merger", JSON.stringify({ type: "task_result", task, success: true }));
            console.log(`[${name}] → 合并器：任务 ${task.id} 完成，等配对`);
        }
    }

    // 两个工位并行拉起（各自挂在队列 pop 上；LLM 等待期间事件循环交替执行）
    const w1 = structureWorker();
    const w2 = logicWorker();

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
                // 架构师下发 / 合并器返工 → 入结构队列（不 await，工位并行处理）
                console.log(`[${name}] ← ${msg.sender}：收到任务 ${data.task?.id}（${data.task?.title}）`);
                if (data.task) structQueue.push({ task: data.task });
            }

            // 测试返工：revision（带问题清单）→ issues 拼进任务描述针对性修改 → 重进结构队列
            if (senderRole === roles.testEngineer && data.type === "revision" && data.task) {
                console.log(`[${name}] ← 测试：任务 ${data.task.id} 返工（${data.issues?.length ?? 0} 条意见）`);
                const revised = {
                    ...data.task,
                    description: data.task.description + "\n\n【测试返工意见（必须逐条解决）】\n" + (data.issues ?? []).join("\n"),
                };
                structQueue.push({ task: revised });
            }
            station.markDone(name);   // 处理完记账（负载均衡的数据基础：pendingCount -1）
        }
    }

    // 挂住等消息（进程保持存活；结构/逻辑工位在后台并行运转）
    await messageLoop();
}
