// ============================================================
// backendEngineer.ts —— 后端开发（多实例 "backend1"/"backend2"...）
//
//   双队列流水线：任务 → 伪代码 → 代码
//     queue1(taskQueue)  ← A 工位消费：任务 → 伪代码骨架
//     queue2(pseudoQueue) ← B 工位消费：伪代码 → 完整代码 → 写盘 → task_result
//
//   关键约定（生产-消费流水线）：
//     - A 只管自己的队列，伪代码 push 进 queue2 后立即回头处理下一个，
//       完全不关心下游堆积（WorkQueue.push 异步入队不等待）
//     - B 在下游队列独立消费，节奏与 A 无关
//     - 每个工位可起多个 worker 提升并行度（瓶颈在哪个队列就加哪个）
//     - 伪代码失败 → 传 null 降级：B 直接单步生成完整代码（不卡流水线）
// ============================================================

import { SystemMessage } from "@langchain/core/messages";
import { BaseAgent } from "./BaseAgent";
import { roles, type TransferStation, WorkQueue } from "./Hub";
import { initModels } from "./models";
import { invokeWithTimeout } from "./llm";
import { writeWorkspace, readWorkspace, type ExecTask } from "./common";
import { nodePrompt, type Node } from "./Node";

const BACKEND_MODEL_JSON = JSON.stringify({
    provider: "deepseek",
    model: "deepseek-v4-flash",
    temperature: 0.1,
    thinking: false,
});

// ---------- 提示词 ----------

// 工位 A：伪代码骨架（先想清楚结构，再让 B 补实现）
export const skeleton_prompt: string = `
# 角色
你是 CrewForge 项目的后端设计 Agent。为指定任务产出"伪代码骨架"，不做完整实现。

## 任务
1. 根据任务契约（method/path/入参/返回/验收）设计各文件的结构。
2. 输出：文件清单、函数签名、关键字段、流程步骤（伪代码）、依赖的调用（DB/中间件/工具类）。
3. 不要写完整实现体，用注释/伪代码占位即可；但签名和流程必须精确。

## 输出
只输出伪代码骨架文本，不要 JSON、Markdown 围栏或额外说明。
`;

// 工位 B：带骨架补全完整实现（移植自 _legacy-agents/backendEngineer.ts）
export const pseudo_prompt: string = `
# 角色
你是 CrewForge 项目的后端文件实现 Agent。当前任务已经由架构师定义，你负责为指定文件产出完整、可运行的代码。

## 输入
1. 当前任务（接口信息 + 技术栈：技术/中间件/数据库，任务描述里已自包含）
2. 伪代码骨架（已确定的结构，必须严格遵循并补全实现体）

## 工作目标
1. 为当前任务 files 中的文件产出完整、可运行的实现。
2. 补齐校验、错误处理、数据转换和必要的持久化调用。
3. 严格遵循任务中给出的技术、依赖、中间件和数据库，不自行换栈。

## 边界
- 只实现当前任务描述和验收标准，不发明字段、接口行为或额外功能。
- 不新增 files 之外的文件路径。
- 输出中的代码必须与 method、path、参数、返回契约保持一致。
- 只输出目标文件的完整源代码，不要 JSON、Markdown 代码围栏或额外说明。
`;

// ---------- 工具：从回复里提取代码（去一个外层代码围栏） ----------

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
// BackendEngineer —— 双队列流水线（任务 → 伪代码 → 代码）
// ============================================================

export class BackendEngineer extends BaseAgent {
    /** queue1：等伪代码的任务 */
    private readonly taskQueue = new WorkQueue<{ task: ExecTask }>();
    /** queue2：伪代码完成、等代码的任务 */
    private readonly pseudoQueue = new WorkQueue<{ task: ExecTask; pseudo: string | null }>();
    /** 工位 A 提示词（节点「伪代码」优先，空回退内置默认） */
    private readonly skeletonPrompt: string;
    /** 工位 B 提示词（节点「代码实现」优先，空回退内置默认） */
    private readonly codePrompt: string;

    constructor(name: string, station: TransferStation, nodes: Node[] = []) {
        super(name, roles.backendEngineer, station);
        this.skeletonPrompt = nodePrompt(nodes, "伪代码", skeleton_prompt);
        this.codePrompt = nodePrompt(nodes, "代码实现", pseudo_prompt);
        this.on("task", { fromNames: ["architect", "merger"] }, ({ data }) => {
            this.taskQueue.push({ task: data.task as ExecTask });
        });
        this.on("revision", { fromRoles: [roles.testEngineer] }, ({ data }) => {
            this.taskQueue.push({
                task: {
                    ...(data.task as ExecTask),
                    description: (data.task as ExecTask).description + "\n\n【测试返工意见（必须逐条解决）】\n" + (data.issues ?? []).join("\n"),
                },
            });
        });
    }

    override async onStart(): Promise<void> {
        // A 工位 ×2 + B 工位 ×2（并行度：瓶颈在 queue2 就多加 B，反之加 A）
        void this.pseudoWorker();
        void this.pseudoWorker();
        void this.codeWorker();
        void this.codeWorker();
    }

    // ---------- 工位 A：任务 → 伪代码 ----------

    private async pseudoWorker(): Promise<void> {
        while (true) {
            const { task } = await this.taskQueue.pop();
            console.log(`[${this.name}] ${task.id} 进入伪代码工位`);
            const pseudo = await this.generatePseudo(task);   // 失败返回 null（降级）
            this.pseudoQueue.push({ task, pseudo });          // 塞进下游，立即回去处理下一个
        }
    }

    private async generatePseudo(task: ExecTask): Promise<string | null> {
        const model = initModels(BACKEND_MODEL_JSON);
        let feedback = "";
        for (let attempt = 1; attempt <= 3; attempt++) {
            const ts = Date.now();
            try {
                const res = await invokeWithTimeout<any>(`${task.id} 伪代码`, 120_000, sig => model.invoke([
                    new SystemMessage(this.skeletonPrompt + `\n\n## 当前任务\n${JSON.stringify(task, null, 2)}` + feedback),
                ], { signal: sig }));
                console.log(`[${this.name}] ${task.id} 伪代码 ${Date.now() - ts}ms`);
                const pseudo = extractGeneratedCode(res.content);
                if (pseudo) return pseudo;
                feedback = "\n\n## 上次没有提取到骨架：请只输出伪代码骨架文本。";
            } catch (error) {
                feedback = `\n\n## 上次调用失败，请重试：${(error as Error).message.slice(0, 200)}`;
                console.log(`[${this.name}] ${task.id} 伪代码失败（第 ${attempt} 次）：${(error as Error).message.slice(0, 80)}`);
            }
        }
        return null;   // 连续 3 次失败：降级，让 B 单步生成
    }

    // ---------- 工位 B：伪代码 → 代码 → 写盘 → 交付 ----------

    private async codeWorker(): Promise<void> {
        while (true) {
            const { task, pseudo } = await this.pseudoQueue.pop();
            console.log(`[${this.name}] ${task.id} 进入代码工位${pseudo ? "" : "（伪代码缺失，单步生成）"}`);
            if (task.files.length === 0) {
                this.send("merger", { type: "task_result", task, success: true });
                continue;
            }

            // 逐文件生成（对齐 frontendEngineer）：每个文件单独一次 LLM 调用，
            // 任务内已生成文件注入记忆，实现跨文件衔接（同任务后写的文件能看到先写的）
            const writtenFiles = new Map<string, string>();
            const implementation: { filePath: string; code: string }[] = [];
            let failed = false;

            for (const filePath of task.files) {
                const code = await this.generateFile(task, pseudo, filePath, writtenFiles);
                if (!code) { failed = true; break; }
                implementation.push({ filePath, code });
            }

            if (failed) {
                console.log(`[${this.name}] ${task.id} 代码生成失败，上报合并器`);
                this.send("merger", { type: "task_result", task, success: false });
                continue;
            }
            for (const f of implementation) {
                const full = writeWorkspace(f.filePath, f.code);
                writtenFiles.set(f.filePath, f.code);
                console.log(`已写入 ${full}`);
            }
            console.log(`[${this.name}] ${task.id} 后端实现已写入 workspace/`);
            this.send("merger", { type: "task_result", task, success: true });
        }
    }

    private async generateFile(
        task: ExecTask,
        pseudo: string | null,
        filePath: string,
        writtenFiles: Map<string, string>,
    ): Promise<string | null> {
        const model = initModels(BACKEND_MODEL_JSON);
        // 本任务内先写的文件注入，供跨文件衔接（避免重复实现或引用不存在的函数）
        const taskExisting = [...writtenFiles.entries()]
            .filter(([knownPath]) => task.files.includes(knownPath))
            .map(([knownPath, knownCode]) => `--- ${knownPath} ---\n${knownCode}`)
            .join("\n");
        const taskExistingPrompt = taskExisting ? `\n\n## 本任务已生成的文件（供衔接，不要重复实现）\n${taskExisting}` : "";
        // 读取现有文件内容（追加修改时参考：当前文件）
        let existingPrompt = "";
        try {
            const existing = await readWorkspace(filePath);
            if (existing) {
                existingPrompt = `\n\n## 现有代码（在此之上修改/追加，保留所有已有功能，不要只输出新增部分）\n\`\`\`\n${existing.slice(0, 20000)}\n\`\`\``;
            }
        } catch { /* 静默失败，无旧内容也正常 */ }
        const pseudoHint = pseudo
            ? `\n\n## 伪代码骨架（必须严格遵循，补全实现体）\n${pseudo}`
            : "\n\n## 提示\n伪代码生成失败，请一次性输出完整可运行的源代码。";
        // 只看当前一个文件的契约与提示词（提示词本身按"目标文件 files 中的文件"措辞，缩小到单文件即逐文件产出）
        const fileTask = { ...task, files: [filePath] };
        let feedback = "";
        for (let attempt = 1; attempt <= 3; attempt++) {
            const ts = Date.now();
            try {
                const res = await invokeWithTimeout<any>(`${task.id} 代码`, 120_000, sig => model.invoke([
                    new SystemMessage(
                        this.codePrompt +
                        `\n\n## 当前任务\n${JSON.stringify(fileTask, null, 2)}` +
                        `\n\n## 当前目标文件\n${filePath}` +
                        `\n\n## 项目路径\nworkspace` +
                        taskExistingPrompt +
                        existingPrompt +
                        pseudoHint +
                        feedback
                    ),
                ], { signal: sig }));
                console.log(`[${this.name}] ${task.id} 代码 ${Date.now() - ts}ms`);
                const code = extractGeneratedCode(res.content);
                if (code) return code;
                feedback = "\n\n## 上次输出没有提取到代码：请只输出目标文件的完整源代码，不要 Markdown 围栏、JSON 或说明。";
            } catch (error) {
                feedback = `\n\n## 上次调用失败，请重试：${(error as Error).message.slice(0, 200)}`;
                console.log(`[${this.name}] ${task.id} 代码失败（第 ${attempt} 次）：${(error as Error).message.slice(0, 80)}`);
            }
        }
        return null;
    }
}
