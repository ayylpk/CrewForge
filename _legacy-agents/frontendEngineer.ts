import { SystemMessage } from "@langchain/core/messages";
import fs from "node:fs";
import path from "node:path";
import { TransferStation, roles, WorkQueue, llmWithTimeout } from "./Hub.ts";   // 中转站 + 角色枚举 + 工位队列 + 超时兜底
import { getModel, getModelRequestTimeout } from "./modelRegistry.ts";

// 前端全程非思考：契约自包含（后端契约照抄），执行性最强，要速度
// thinking: {type:"disabled"} 是 DeepSeek v4 API 的关闭思考参数（实测有效）
const model = getModel("frontend");

// ============================================================
// 前端工程师链路（v1）：前端任务 → 单文件完整实现 → 聚合交付
//
//   execTasks(前端任务) → 单文件实现节点 → 输出组件
//
// 关键约定：
//   - 视图节点一次生成模板、样式和脚本，避免二次调用携带完整组件造成请求不稳定
//   - 文件按类型进入独立队列，完成后由父任务协调器聚合
//   - main 只筛 layer === "frontend" 的任务（后端任务留给 backendEngineer.ts）
// ============================================================

// ---------- 类型定义 ----------

export interface ExecTask {
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

export type FrontendSubtaskKind = "view" | "api" | "route" | "support";

export interface FrontendSubtask {
  id: string;
  parentId: string;
  kind: FrontendSubtaskKind;
  filePath: string;
  task: ExecTask;
}

export type FrontendRunStatus = "pending" | "success" | "failure" | "ignored";

export interface FrontendRunResult {
  status: FrontendRunStatus;
  parentTask?: ExecTask;
}

interface FrontendRunState {
  parentTask: ExecTask;
  expected: Set<string>;
  completed: Set<string>;
  settled: boolean;
}

export function classifyFrontendFile(filePath: string): FrontendSubtaskKind {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  const segments = normalized.split("/");
  const baseName = segments[segments.length - 1] ?? normalized;

  if (segments.includes("router") || /^router(?:\.[^./]+)?$/.test(baseName)) return "route";
  if (segments.some(segment => ["api", "apis", "service", "services"].includes(segment))) return "api";
  if (/\.(vue|tsx|jsx|svelte)$/.test(baseName) || segments.some(segment => ["views", "pages", "components"].includes(segment))) return "view";
  return "support";
}

export function splitFrontendTask(task: ExecTask): FrontendSubtask[] {
  const files = [...new Set(task.files)];
  return files.map((filePath, index) => {
    const kind = classifyFrontendFile(filePath);
    const id = `${task.id}-part-${index + 1}`;
    return {
      id,
      parentId: task.id,
      kind,
      filePath,
      task: {
        ...task,
        id,
        files: [filePath],
        title: `${task.title}（${kind}：${filePath}）`,
        description: `${task.description}\n\n【前端子任务】类型：${kind}；只负责文件：${filePath}`,
      },
    };
  });
}

export class FrontendRunCoordinator {
  private runSequence = 0;
  private readonly runs = new Map<string, FrontendRunState>();
  private readonly activeRunByParent = new Map<string, string>();

  start(parentTask: ExecTask, subtasks: FrontendSubtask[]): string {
    const runId = `${parentTask.id}:run-${++this.runSequence}`;
    this.activeRunByParent.set(parentTask.id, runId);
    this.runs.set(runId, {
      parentTask,
      expected: new Set(subtasks.map(subtask => subtask.id)),
      completed: new Set(),
      settled: false,
    });
    return runId;
  }

  isActive(runId: string): boolean {
    const run = this.runs.get(runId);
    return Boolean(run && !run.settled && this.activeRunByParent.get(run.parentTask.id) === runId);
  }

  record(runId: string, subtaskId: string, success: boolean): FrontendRunResult {
    const run = this.runs.get(runId);
    if (!run || run.settled || this.activeRunByParent.get(run.parentTask.id) !== runId || !run.expected.has(subtaskId) || run.completed.has(subtaskId)) {
      return { status: "ignored" };
    }

    if (!success) {
      run.settled = true;
      this.activeRunByParent.delete(run.parentTask.id);
      return { status: "failure", parentTask: run.parentTask };
    }

    run.completed.add(subtaskId);
    if (run.completed.size < run.expected.size) return { status: "pending" };

    run.settled = true;
    this.activeRunByParent.delete(run.parentTask.id);
    return { status: "success", parentTask: run.parentTask };
  }
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

// 视图文件一次生成完整组件，避免把首轮完整代码再次注入第二次模型调用。
const file_prompt: string = `
# 角色
你是 CrewForge 项目的前端文件实现 Agent。你只负责输入任务中指定的一个文件，并返回这个文件的完整代码。

## 规则
- 只输出任务 files 中的唯一文件，不新增、不遗漏、不改名。
- 遵循任务中的前端技术栈、接口契约和验收标准。
- 先理解下方已有文件内容，再在必要时最小修改；没有已有内容时从零产出完整文件。
- 不发明任务之外的接口、字段、交互或业务规则。
- 只输出目标文件的完整源代码，不要 JSON、Markdown 代码围栏或额外说明。
`;

// ============================================================
// 前端开发消息收发（参照 backendEngineer.ts 模板）
//   消息协议（content 为 JSON 字符串）：
//     架构师/合并器 → 前端: {"type": "task", "task": ExecTask}                 下发任务（layer 已筛过）/ 返工
//     前端 → 合并器:        {"type": "task_result", "task": ExecTask, "success": bool} 干完活交合并器配对
// ============================================================

// 前端开发入口（函数化：接收 agent 名 + 共享中转站，由 start.ts 拉起）
// name = "frontend1"/"frontend2"…（多开发负载均衡），station 是进程内全局唯一的站
//
// 按文件类型分流的内部队列，所有子任务完成后一次性交给合并器。
interface FrontendJob {
    runId: string;
    subtask: FrontendSubtask;
}

function normalizedPath(filePath: string): string {
    return filePath.replace(/\\/g, "/").replace(/^\/+/, "");
}

export function extractGeneratedCode(content: unknown): string | null {
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

    // Some providers add a fence despite the prompt; remove only one outer fence.
    const fenced = trimmed.match(/^```[^\r\n]*\r?\n([\s\S]*?)\r?\n?```$/);
    const code = (fenced?.[1] ?? trimmed).trim();
    return code || null;
}

export async function runFrontend(name: string, station: TransferStation) {
    const viewQueue = new WorkQueue<FrontendJob>();
    const fileQueue = new WorkQueue<FrontendJob>();
    const routeQueue = new WorkQueue<FrontendJob>();
    const writtenFiles = new Map<string, string>();
    const coordinator = new FrontendRunCoordinator();

    function existingContent(filePath: string): string {
        const code = writtenFiles.get(filePath);
        return code ? `\n\n## 已存在的文件\n--- ${filePath} ---\n${code}` : "";
    }

    function sendAggregate(result: FrontendRunResult): void {
        if ((result.status !== "success" && result.status !== "failure") || !result.parentTask) return;
        station.sendMessage(name, "merger", JSON.stringify({
            type: "task_result",
            task: result.parentTask,
            success: result.status === "success",
        }));
        console.log(`[${name}] 前端父任务 ${result.parentTask.id} 聚合${result.status === "success" ? "成功" : "失败"}，发送到合并器`);
    }

    function completeSubtask(job: FrontendJob, file: CodeFile | null): void {
        if (!coordinator.isActive(job.runId)) {
            console.log(`[${name}] 忽略过期子任务 ${job.subtask.id}`);
            return;
        }
        if (!file) {
            console.log(`[${name}] 子任务 ${job.subtask.id} 没有生成指定文件`);
            sendAggregate(coordinator.record(job.runId, job.subtask.id, false));
            return;
        }

        const safePath = normalizedPath(job.subtask.filePath).replace(/\.\./g, "");
        const full = path.join("workspace", safePath);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, file.code, "utf-8");
        writtenFiles.set(job.subtask.filePath, file.code);
        console.log(`[${name}] 子任务 ${job.subtask.id} 已写入 ${full}`);
        sendAggregate(coordinator.record(job.runId, job.subtask.id, true));
    }

    async function invokeWithRetries(job: FrontendJob, prompt: string, extra: string, stage: string): Promise<CodeFile | null> {
        for (let attempt = 1; attempt <= 3; attempt++) {
            const ts = Date.now();
            try {
                const response = await llmWithTimeout(
                    signal => model.invoke([
                        new SystemMessage(
                            prompt +
                            `\n\n## 当前子任务\n${JSON.stringify(job.subtask.task, null, 2)}` +
                            extra
                        ),
                    ], { signal }),
                    getModelRequestTimeout("frontend"),
                    `[${job.subtask.id}] ${stage}`
                );
                console.log(`[${job.subtask.id}] ${stage} ${Date.now() - ts}ms`);
                const code = extractGeneratedCode(response.content);
                if (code) {
                    return {
                        description: `${job.subtask.kind} 文件实现`,
                        filePath: job.subtask.filePath,
                        code,
                    };
                }
                console.log(`提示：${job.subtask.id} ${stage} 没有产出代码，重试 ${attempt}/3`);
            } catch (error) {
                console.log(`${job.subtask.id} ${stage} 请求失败（第 ${attempt} 次，${Date.now() - ts}ms）：${(error as Error).message.slice(0, 100)}`);
            }
        }
        return null;
    }

    async function viewWorker(): Promise<void> {
        while (true) {
            const job = await viewQueue.pop();
            const content = await invokeWithRetries(
                job,
                file_prompt,
                `\n\n## 主题变量\n${DEFAULT_THEME}\n\n## 请求封装\n${DEFAULT_REQUEST}${existingContent(job.subtask.filePath)}`,
                "页面实现"
            );
            completeSubtask(job, content);
        }
    }

    async function fileWorker(queue: WorkQueue<FrontendJob>, stage: string): Promise<void> {
        while (true) {
            const job = await queue.pop();
            const content = await invokeWithRetries(job, file_prompt, existingContent(job.subtask.filePath), stage);
            completeSubtask(job, content);
        }
    }

    function enqueueParentTask(task: ExecTask): void {
        const subtasks = splitFrontendTask(task);
        if (subtasks.length === 0) {
            console.log(`提示：前端任务 ${task.id} 没有文件，直接上报失败`);
            station.sendMessage(name, "merger", JSON.stringify({ type: "task_result", task, success: false }));
            return;
        }

        const runId = coordinator.start(task, subtasks);
        console.log(`[${name}] 前端任务 ${task.id} 拆分为 ${subtasks.length} 个子任务，运行 ${runId}`);
        for (const subtask of subtasks) {
            const job = { runId, subtask };
            if (subtask.kind === "view") viewQueue.push(job);
            else if (subtask.kind === "route") routeQueue.push(job);
            else fileQueue.push(job);
            console.log(`[${name}] 子任务 ${subtask.id} 进入 ${subtask.kind} 队列：${subtask.filePath}`);
        }
    }

    void viewWorker();
    void fileWorker(fileQueue, "文件实现");
    void fileWorker(routeQueue, "路由实现");

    async function messageLoop(): Promise<void> {
        console.log(`[${name}] 消息监听已启动：等架构师下发任务`);
        while (true) {
            const msg = await station.waitForMessage(name);
            if (!msg) continue;
            let data: { type?: string; task?: ExecTask; issues?: string[] };
            try { data = JSON.parse(msg.content); } catch { continue; }

            const senderRole = station.status[msg.sender]?.role;
            if ((msg.sender === "architect" || msg.sender === "merger") && data.type === "task" && data.task) {
                console.log(`[${name}] 收到 ${msg.sender} 的任务：${data.task.id}（${data.task.title}）`);
                enqueueParentTask(data.task);
            }

            if (senderRole === roles.testEngineer && data.type === "revision" && data.task) {
                console.log(`[${name}] 收到测试返工：任务 ${data.task.id}（${data.issues?.length ?? 0} 条意见）`);
                enqueueParentTask({
                    ...data.task,
                    description: data.task.description + "\n\n【测试返工意见（必须逐条解决）】\n" + (data.issues ?? []).join("\n"),
                });
            }
            station.markDone(name);
        }
    }

    await messageLoop();
}
