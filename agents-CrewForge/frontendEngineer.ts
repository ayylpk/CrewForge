import { ChatDeepSeek } from "@langchain/deepseek";
import { SystemMessage } from "@langchain/core/messages";
import * as z from "zod";
import { Annotation, StateGraph, START, END, MemorySaver, type GraphNode } from "@langchain/langgraph";
import fs from "node:fs";
import path from "node:path";
import { TransferStation, roles } from "./Hub.ts";   // 前端与架构师/测试的消息中转站 + 角色枚举

const model = new ChatDeepSeek({
    model: "deepseek-v4-flash",
})

// ============================================================
// 前端工程师链路（v1）：前端任务 → 结构样式 → 逻辑脚本 → 完整组件
//
//   execTasks(前端任务) → structureNode(模板+样式) → logicNode(脚本逻辑) → 输出组件
//
// 关键约定：
//   - 结构节点产静态页面（引用主题变量 var()，禁写死颜色值）
//   - 逻辑节点追加脚本（ref/handler 名必须与模板一致，用请求封装调任务描述里的接口）
//   - 双工位流水线：structureGraph + logicGraph 并发循环（同 backendEngineer.ts）
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

const contentReducer = (
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
    structures: Annotation<CodeContent[]>({
        default: () => [],
        reducer: contentReducer,   // 结构节点产出（模板+样式）
    }),
    logicCodes: Annotation<CodeContent[]>({
        default: () => [],
        reducer: contentReducer,   // 逻辑节点产出（完整组件）
    }),
    existingFiles: Annotation<{ filePath: string; code: string }[]>({
        default: () => [],
        reducer: (_, u) => u,   // 追加语义：同文件已由前面任务产出的内容，注入提示词（read→看懂→追加→保存）
    }),
    llmCalls: Annotation<number>({
        default: () => 0,
        reducer: (x, y) => x + y,
    }),
    project: Annotation<string>({
        default: () => "",
        reducer: (x) => x,
    }),
});

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

// ---------- 节点 ----------

// 结构样式节点：队首前端任务 → 静态页面（模板+样式）
// 删除逻辑：产出非空 → 出队；产出时把任务信息（交互/接口）并入 description，逻辑节点自包含
const StructureNode: GraphNode<typeof MessageState.State> = async (state) => {
    const currentTask = state.execTasks[0];
    if (!currentTask) return {};  // 队列空，无事可做

    const response = await contentModel.invoke([
        new SystemMessage(
            structure_prompt +
            `\n\n## 当前任务\n${JSON.stringify(currentTask, null, 2)}` +
            `\n\n## 主题变量\n${DEFAULT_THEME}` +
            `\n\n## 请求封装\n${DEFAULT_REQUEST}`
        ),
    ]);

    // 删除逻辑：有产出才出队；任务信息并入 description 传给逻辑节点
    if (response.files.length > 0) {
        return {
            structures: [{ ...response, description: `【任务】${currentTask.title}\n${currentTask.description}\n【产出】${response.description}` }],
            execTasks: state.execTasks.slice(1),
            llmCalls: 1,
        };
    }
    return { llmCalls: 1 };
};

// 逻辑节点：队首结构组件 → 补脚本 → 完整组件并输出
// 删除逻辑：产出非空 → 输出 + 出队；空 → 留在队首，下轮重试
const LogicNode: GraphNode<typeof MessageState.State> = async (state) => {
    const currentStructure = state.structures[0];
    if (!currentStructure) return {};  // 无待实现结构组件

    // 追加语义：只把本次结构产出涉及文件（路径相同）的已有内容注入，避免无关文件刷屏
    const existingContent = state.existingFiles.length > 0
        ? `\n\n## 已存在的文件（追加语义：先读懂原内容，同路径文件在原有代码基础上追加/修改，保留已有代码和风格）\n${state.existingFiles.map(f => `--- ${f.filePath} ---\n${f.code}`).join("\n")}`
        : "";

    const response = await contentModel.invoke([
        new SystemMessage(
            logic_prompt +
            `\n\n## 结构组件\n${JSON.stringify(currentStructure, null, 2)}` +
            existingContent
        ),
    ]);

    // 删除逻辑：有产出才输出出队；空产出留在队首（下次 invoke 重试）
    if (response.files.length > 0) {
        // 正式版：按 filePath 写盘到工作区（替换控制台输出）；路径净化防 .. 逃逸
        for (const f of response.files) {
            const safePath = f.filePath.replace(/^[/\\]+/, "").replace(/\.\./g, "");
            const full = path.join("workspace", safePath);
            fs.mkdirSync(path.dirname(full), { recursive: true });
            fs.writeFileSync(full, f.code, "utf-8");
            console.log(`✓ 已写入 ${full}`);
        }
        return { logicCodes: [response], structures: state.structures.slice(1), llmCalls: 1 };
    }
    return { llmCalls: 1 };
};

// ---------- 工具 ----------

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---------- 组装图 ----------
// 双工位流水线：每个工位一个单节点图（节点化保留，未来映射 sys_agent_step）

// 结构图：单节点（结构样式工位）
const structureGraph = new StateGraph(MessageState)
    .addNode("structure", StructureNode)
    .addEdge(START, "structure")
    .addEdge("structure", END)
    .compile({ checkpointer: new MemorySaver() });

// 逻辑图：单节点（逻辑工位）
const logicGraph = new StateGraph(MessageState)
    .addNode("logic", LogicNode)
    .addEdge(START, "logic")
    .addEdge("logic", END)
    .compile({ checkpointer: new MemorySaver() });

// ---------- 消息驱动版（参照 backendEngineer.ts） ----------
// 消息协议（content 为 JSON 字符串）：
//   架构师/合并器 → 前端: {"type": "task", "task": ExecTask}                 下发任务（layer 已筛过）/ 返工
//   前端 → 合并器:        {"type": "task_result", "task": ExecTask, "success": bool} 干完活交合并器配对

const writtenFiles = new Map<string, string>();   // 追加语义：filePath → 最新代码（跨任务共享，同文件先读懂再追加）

// 处理单个任务（从 main() 的双工位流水线提炼）：结构图 → 逻辑图 → 写盘 workspace/
// 返回是否成功（失败也交测试，测试按 task_result.success 判断）
async function processOneTask(t: ExecTask): Promise<boolean> {
    // 结构工位：每任务 invoke 一次结构图（重试 ≤3，防卡死）
    let state: typeof MessageState.State | undefined;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            state = await structureGraph.invoke(
                { execTasks: [t], project: "workspace" },
                { configurable: { thread_id: `fs-${t.id}` } }   // 每任务独立断点
            );
        } catch (e) {
            console.log(`⚠️ ${t.id} LLM 调用失败（第 ${attempt} 次）：${(e as Error).message.slice(0, 80)}`);
            state = undefined;
            continue;
        }
        if (state.structures.length > 0) break;
        console.log(`⚠️ ${t.id} 结构产出为空，重试 ${attempt}/3`);
    }
    if (!state || state.structures.length === 0) {
        console.log(`❌ ${t.id} 连续 3 次失败，标记失败跳过`);
        return false;
    }
    const s = state.structures[0]!;

    // 追加语义：本次结构产出涉及的文件里，哪些已由前面任务产出 → 注入已有内容
    const existing = [...writtenFiles.entries()]
        .filter(([fp]) => s.files.some(f => f.filePath === fp))
        .map(([filePath, code]) => ({ filePath, code }));

    // 逻辑工位：invoke 逻辑图（输出组件在 LogicNode 里写盘）
    let cstate: typeof MessageState.State | undefined;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            cstate = await logicGraph.invoke(
                { structures: [s], project: "workspace", existingFiles: existing },
                { configurable: { thread_id: `fl-${s.description.slice(0, 20)}` } }
            );
        } catch (e) {
            console.log(`⚠️ LLM 调用失败（第 ${attempt} 次）：${(e as Error).message.slice(0, 80)}`);
            cstate = undefined;
            continue;
        }
        const last = cstate.logicCodes[cstate.logicCodes.length - 1];
        if (last && last.files.length > 0) break;   // 有产出才往下走
        console.log(`⚠️ 组件产出为空，重试 ${attempt}/3`);
    }
    const last = cstate ? cstate.logicCodes[cstate.logicCodes.length - 1] : undefined;
    if (!last || last.files.length === 0) {
        console.log(`❌ 连续 3 次失败，标记失败跳过：${s.description.slice(0, 40)}`);
        return false;
    }
    for (const f of last.files) writtenFiles.set(f.filePath, f.code);   // 记录最新内容，供后续任务追加
    console.log(`✓ ${t.id} 组件已写入 workspace/`);
    return true;
}

// 前端开发入口（函数化：接收 agent 名 + 共享中转站，由 start.ts 拉起）
export async function runFrontend(name: string, station: TransferStation) {
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
                // 架构师下发 / 合并器返工 → 干活（结构图 + 逻辑图 → 写盘 workspace/）
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
