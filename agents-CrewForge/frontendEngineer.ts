// ============================================================
// frontendEngineer.ts —— 前端开发（多实例 "frontend1"/"frontend2"...）
//
//   双队列流水线：任务 → 设计稿 → 代码（与后端"伪代码→代码"对称）
//     queue1(taskQueue)  ← A 工位消费：任务 → 页面设计稿
//     queue2(designQueue) ← B 工位消费：设计稿 → 逐文件实现 → 写盘 → task_result
//
//   为什么前端拆"设计→实现"而不是"按文件类型分队列"：
//     - view/api/route 字段一致性由设计稿统一约束（接口字段清单写进设计稿）
//     - 一个页面多个文件时，先定结构再逐文件实现，质量更稳
//   关键约定（生产-消费流水线，同后端）：
//     - A 产出设计稿 push 进 queue2 立即回头，不关心下游堆积
//     - B 独立消费，逐文件生成（带设计稿 + 任务内已写文件的记忆）
//     - 每个工位可起多个 worker；设计稿失败 → 传 null 降级单步实现
// ============================================================

import { SystemMessage } from "@langchain/core/messages";
import { BaseAgent } from "./BaseAgent";
import { roles, type TransferStation, WorkQueue } from "./Hub";
import { initModels } from "./models";
import { invokeWithTimeout, DEFAULT_TIMEOUT_MS } from "./llm";
import { writeWorkspace, readWorkspace, type ExecTask } from "./common";
import { currentProjectId, projectDir } from "./runEnv";
import { updateStatusByExt } from "./task";
import { nodePrompt, type Node } from "./Node";
import { buildKnown, checkFile, gateFeedback } from "./checkers";
import {
    TDESIGN_WHITELIST, TDESIGN_WHITELIST_TAGS, TDESIGN_THEME_CSS,
    fetchComponentDocs, extractUsedComponents, findHallucinated, buildDocsBlock,
} from "./tdesignMcp";

const FRONTEND_MODEL_JSON = JSON.stringify({
    provider: "deepseek",
    model: "deepseek-v4-flash",
    temperature: 0.1,
    thinking: false,
});

// ---------- 提示词 ----------

// 工位 A：页面设计稿（先定结构/交互/接口清单，再让 B 实现）
export const design_prompt: string = `
# 角色
你是 CrewForge 项目的前端设计 Agent。为指定任务产出"页面设计稿"，不做代码实现。

## 任务
1. 根据任务契约（页面/交互/调用的接口/验收标准）设计页面结构。
2. 输出：文件清单与各文件职责、组件层级、页面交互流程、需要调用的接口（method/path/入参/出参字段，字段名必须精确）。
3. 接口字段清单是本任务所有文件的唯一契约来源，后续实现必须照抄，不得改名。

## 输出
只输出设计稿文本，不要 JSON、Markdown 围栏或额外说明。
`;

// 工位 B：带设计稿实现单个文件（移植自 _legacy-agents/frontendEngineer.ts）
export const file_prompt: string = `
# 角色
你是 CrewForge 项目的前端文件实现 Agent。你只负责输入任务中指定的一个文件，并返回这个文件的完整代码。

## 规则
- 只输出任务 files 中的唯一文件，不新增、不遗漏、不改名。
- 遵循任务中的前端技术栈、设计稿（接口字段/组件结构必须照抄）和验收标准。
- 先理解下方已有文件内容，再在必要时最小修改；没有已有内容时从零产出完整文件。
- 不发明任务之外的接口、字段、交互或业务规则。
- 只输出目标文件的完整源代码，不要 JSON、Markdown 代码围栏或额外说明。
`;

// ---------- TDesign 规约（9/5 MCP 集成） ----------
// 刻意不写进 design_prompt/file_prompt 常量本体，而是构造函数里"追加"到最终提示词：
// DB 的 sys_agent_node 早先已入库旧 prompt，只改内置常量对已建 agent 不生效；
// 代码侧追加 = 无论节点怎么自定义，规约必在场（同 DEFAULT_THEME 的注入姿势）。

/** 工位 A 追加：设计稿必须声明选用组件（→ 代码侧预取文档 + 幻觉闸门的输入） */
const TDESIGN_DESIGN_RULE = `

## 组件库规约（强制，与上文冲突时以本节为准）
- UI 统一 TDesign Vue Next，模板只用 \`<t-*>\` 标签；可用组件白名单：${TDESIGN_WHITELIST_TAGS}
- 白名单外的能力用原生 HTML/CSS 实现，不得发明组件（写了也会在下游闸门被核验打回）。
- 设计稿末尾必须单起一行声明本任务选用的组件，格式严格为：
  【组件清单】<t-form>、<t-input>、<t-button>
  （只列白名单内、本任务真正用到的；一个都不用就写【组件清单】无）`;

/** 工位 B 追加：只准用白名单组件、API 照抄注入的真实文档、主题走 --td-* 变量 */
const TDESIGN_FILE_RULE = `

## 组件库规约（强制）
- 只允许 TDesign Vue Next 组件：<t-button> 等 <t-*> 标签，白名单：${TDESIGN_WHITELIST_TAGS}
- 禁止其他组件库标签（el-*、a-*、van-*、v-* 除 vue 内置外）；禁止凭记忆发明 <t-xxx>。
- 下方若附带"TDesign 组件真实 API"文档，props/事件名/v-model 一律照抄文档；文档里没有的属性不要写。
- 颜色/圆角/间距一律引用输入给定的 --td-* 主题变量，不硬编码色值。`;

// ---------- 基建占位（移植自 _legacy-agents；正式版架构师产出 theme.css / request 封装） ----------

// 主题串在 tdesignMcp.ts 单一来源（architect bootstrap 落盘用的同一份，防提示词与真实文件漂移）
const DEFAULT_THEME = TDESIGN_THEME_CSS;

const DEFAULT_REQUEST = `
// request.ts —— 全局请求封装（基建产出）
import axios from 'axios';
const request = axios.create({ baseURL: '/api', timeout: 10000 });
export default request;
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

// ---------- 工具：任务级 TDesign 文档上下文（预取结果 + 通道存活标记） ----------

/** 一个任务共享的文档上下文：docs 组件名→原始文档串；alive=false 表示 MCP 通道已挂（闸门放行） */
interface TDesignContext {
    docs: Record<string, string>;
    alive: boolean;
}

/** 解析设计稿的【组件清单】声明行 → 组件名列表（剥 <t-> 壳；只留白名单内；≤15 控 prompt 体量）。导出供 smoke 测试 */
export function parseDesignComponents(design: string | null): string[] {
    if (!design) return [];
    const line = design.match(/【组件清单】(.+)/)?.[1] ?? "";
    const names = [...new Set([...line.matchAll(/t-([a-z][a-z0-9-]*)/g)].map(m => m[1] ?? ""))].filter(Boolean);
    return names.filter(n => (TDESIGN_WHITELIST as readonly string[]).includes(n)).slice(0, 15);
}

// ============================================================
// FrontendEngineer —— 双队列流水线（任务 → 设计稿 → 代码）
// ============================================================

export class FrontendEngineer extends BaseAgent {
    /** queue1：等设计稿的任务 */
    private readonly taskQueue = new WorkQueue<{ task: ExecTask }>();
    /** queue2：设计稿完成、等实现的任务 */
    private readonly designQueue = new WorkQueue<{ task: ExecTask; design: string | null }>();
    /** 工位 A 提示词（节点「页面设计」优先，空回退内置默认） */
    private readonly designPrompt: string;
    /** 工位 B 提示词（节点「代码实现」优先，空回退内置默认） */
    private readonly filePrompt: string;

    constructor(name: string, station: TransferStation, nodes: Node[] = []) {
        super(name, roles.frontendEngineer, station);
        this.designPrompt = nodePrompt(nodes, "页面设计", design_prompt) + TDESIGN_DESIGN_RULE;
        this.filePrompt = nodePrompt(nodes, "代码实现", file_prompt) + TDESIGN_FILE_RULE;
        this.on("task", { fromNames: ["architect", "merger"] }, ({ data }) => {
            const t = data.task as ExecTask;
            this.taskQueue.push({ task: t });
            // sys_task 桥：工位取任务 → doing（旁路，helper 自吞异常）
            const pid = currentProjectId();
            if (pid != null) void updateStatusByExt(pid, t.id, "doing", undefined, t.phase);   // phase 防跨阶段串台（9/4 live 修，ExecTask.phase）
        });
        this.on("revision", { fromRoles: [roles.testEngineer] }, ({ data }) => {
            const t = data.task as ExecTask;
            this.taskQueue.push({
                task: {
                    ...t,
                    description: t.description + "\n\n【测试返工意见（必须逐条解决）】\n" + (data.issues ?? []).join("\n"),
                },
            });
            // 返工重新排队 → 状态回 doing（error_msg 保留至下次判定覆盖）
            const pid = currentProjectId();
            if (pid != null) void updateStatusByExt(pid, t.id, "doing", undefined, t.phase);   // phase 防跨阶段串台（9/4 live 修，ExecTask.phase）
        });
    }

    override async onStart(): Promise<void> {
        // A 工位 ×1 + B 工位 ×2（B 是逐文件生成，通常是瓶颈，多起几个）
        void this.designWorker();
        void this.codeWorker();
        void this.codeWorker();
    }

    // ---------- 工位 A：任务 → 设计稿 ----------

    private async designWorker(): Promise<void> {
        while (true) {
            const { task } = await this.taskQueue.pop();
            console.log(`[${this.name}] ${task.id} 进入设计工位`);
            const design = await this.generateDesign(task);   // 失败返回 null（降级）
            this.designQueue.push({ task, design });          // 塞进下游，立即回头
        }
    }

    private async generateDesign(task: ExecTask): Promise<string | null> {
        const model = initModels(FRONTEND_MODEL_JSON);
        let feedback = "";
        for (let attempt = 1; attempt <= 3; attempt++) {
            const ts = Date.now();
            try {
                // 工位超时 9/3 拍板：与主链同级 300s（旧 180s 两档制被 run10 击穿，见 backendEngineer 同款注释）
                const res = await invokeWithTimeout<any>(`${task.id} 设计稿`, DEFAULT_TIMEOUT_MS, sig => model.invoke([
                    new SystemMessage(this.designPrompt + `\n\n## 当前任务\n${JSON.stringify(task, null, 2)}` + feedback),
                ], { signal: sig }));
                console.log(`[${this.name}] ${task.id} 设计稿 ${Date.now() - ts}ms`);
                const design = extractGeneratedCode(res.content);
                if (design) return design;
                feedback = "\n\n## 上次没有提取到设计稿：请只输出设计稿文本。";
            } catch (error) {
                feedback = `\n\n## 上次调用失败，请重试：${(error as Error).message.slice(0, 200)}`;
                console.log(`[${this.name}] ${task.id} 设计稿失败（第 ${attempt} 次）：${(error as Error).message.slice(0, 80)}`);
            }
        }
        return null;   // 连续 3 次失败：降级，让 B 单步实现
    }

    // ---------- 工位 B：设计稿 → 逐文件实现 → 写盘 → 交付 ----------

    private async codeWorker(): Promise<void> {
        while (true) {
            const { task, design } = await this.designQueue.pop();
            console.log(`[${this.name}] ${task.id} 进入实现工位${design ? "" : "（设计稿缺失，单步实现）"}`);
            if (task.files.length === 0) {
                // 9/3 run11 修正：无 UI 任务（Swagger 调试类，架构师明示"无新增前端界面"）= 没有文件要写就是完成，
                // 与 backendEngineer 同语义 success:true。旧值 false 让 merger 数满 3 轮放弃整对——
                // run10/run11 里所有"开发自测失败 3 轮"的无 UI 对全是这个不对称杀的（超时修复后现形）
                this.send("merger", { type: "task_result", task, success: true });
                continue;
            }

            // TDesign 文档通道（9/5）：设计稿声明的【组件清单】→ 任务级预取真实 API（一任务一次，任务内各文件共享）
            const comps = parseDesignComponents(design);
            const tdesign: TDesignContext = { docs: {}, alive: true };
            if (comps.length > 0) {
                const fetched = await fetchComponentDocs(comps);
                if (fetched) Object.assign(tdesign.docs, fetched);
                else tdesign.alive = false;   // 通道挂 → 幻觉闸门放行（旁路，不阻塞任务）
                console.log(`[${this.name}] ${task.id} TDesign 预取 ${comps.length} 组件文档${tdesign.alive ? "" : "（通道不可用，闸门降级）"}`);
            }

            // 任务内已生成文件记忆（同任务后写的文件能看到先写的，跨文件衔接）
            const writtenFiles = new Map<string, string>();
            const implementation: { filePath: string; code: string }[] = [];
            let failed = false;

            for (const filePath of task.files) {
                const code = await this.generateFile(task, design, filePath, writtenFiles, tdesign);
                if (!code) { failed = true; break; }
                implementation.push({ filePath, code });
                // T1 顺带修（9/8）：writtenFiles 生成一个补一个（原先任务全成后才统一 set，生成期恒空，
                // "已存在文件注入/闸门已知文件集"名存实亡）——backendEngineer 同款注释，不重复
                writtenFiles.set(filePath, code);
            }

            if (failed) {
                console.log(`[${this.name}] ${task.id} 前端实现失败，上报合并器`);
                this.send("merger", { type: "task_result", task, success: false });
                continue;
            }
            for (const f of implementation) {
                const full = writeWorkspace(f.filePath, f.code);
                writtenFiles.set(f.filePath, f.code);
                console.log(`已写入 ${full}`);
            }
            console.log(`[${this.name}] ${task.id} 前端实现已写入 workspace/`);
            this.send("merger", { type: "task_result", task, success: true });
        }
    }

    private async generateFile(
        task: ExecTask,
        design: string | null,
        filePath: string,
        writtenFiles: Map<string, string>,
        tdesign: TDesignContext,
    ): Promise<string | null> {
        const model = initModels(FRONTEND_MODEL_JSON);
        // 已有文件（本任务内先写的）注入，供最小修改/衔接
        const existing = [...writtenFiles.entries()]
            .filter(([knownPath]) => task.files.includes(knownPath))
            .map(([knownPath, knownCode]) => `--- ${knownPath} ---\n${knownCode}`)
            .join("\n");
        const existingContent = existing ? `\n\n## 已存在的文件\n${existing}` : "";
        // 读取 DB 中该文件的现有内容（追加修改时参考）
        let dbExistingPrompt = "";
        try {
            const dbExisting = await readWorkspace(filePath);
            if (dbExisting) {
                dbExistingPrompt = `\n\n## 文件现有内容（在此之上修改/追加，保留所有已有功能，不要只输出新增部分）\n\`\`\`\n${dbExisting.slice(0, 20000)}\n\`\`\``;
            }
        } catch { /* 静默失败，无旧内容也正常 */ }
        const designHint = design ? `\n\n## 页面设计稿（接口字段/组件结构必须照抄）\n${design}` : "";
        const fileTask = { ...task, files: [filePath] };
        // T1 编译闸门（9/8）：known = 磁盘树 ∪ 本任务已生成 ∪ 计划内（backend 同注释）。
        // 每轮现建：并行 B 工位刚落盘的文件、上一文件新写的内容，下一文件校验时都算已知
        const pid = currentProjectId();
        const known = buildKnown(pid != null ? projectDir(pid) : null, writtenFiles, task.files);

        let feedback = "";
        for (let attempt = 1; attempt <= 3; attempt++) {
            const ts = Date.now();
            // 文档段每轮现拼：闸门补拉的新组件文档从第 2 轮起参与生成（写前必查的闭环）
            const docsBlock = buildDocsBlock(Object.keys(tdesign.docs), tdesign.docs);
            const tdesignHint = docsBlock ? `\n\n${docsBlock}` : "";
            try {
                const res = await invokeWithTimeout<any>(`${task.id} ${filePath}`, DEFAULT_TIMEOUT_MS, sig => model.invoke([
                    new SystemMessage(
                        this.filePrompt +
                        `\n\n## 当前子任务\n${JSON.stringify(fileTask, null, 2)}` +
                        designHint +
                        tdesignHint +
                        existingContent +
                        dbExistingPrompt +
                        `\n\n## 主题变量\n${DEFAULT_THEME}\n\n## 请求封装\n${DEFAULT_REQUEST}` +
                        feedback
                    ),
                ], { signal: sig }));
                console.log(`[${this.name}] ${task.id} ${filePath} ${Date.now() - ts}ms`);
                const code = extractGeneratedCode(res.content);
                if (!code) {
                    feedback = "\n\n## 上次输出没有提取到代码：请只输出目标文件的完整源代码，不要 Markdown 围栏、JSON 或说明。";
                    continue;
                }

                // ---- 幻觉闸门（9/5）：文件用到的每个 <t-*> 必须验真（通道活着才卡，挂了放行=旁路） ----
                const used = extractUsedComponents(code);
                if (used.length > 0 && tdesign.alive) {
                    const fresh = used.filter(n => !(n in tdesign.docs));   // 设计稿没列但写了：补验（真实组件也补文档，下轮可用）
                    if (fresh.length > 0) {
                        const extra = await fetchComponentDocs(fresh);
                        if (extra) Object.assign(tdesign.docs, extra);
                        else tdesign.alive = false;   // 通道中途挂 → 本任务后续放行
                    }
                    const hallucinated = tdesign.alive ? findHallucinated(used, tdesign.docs) : [];
                    if (hallucinated.length > 0) {
                        if (attempt < 3) {
                            feedback = `\n\n## 闸门打回：TDesign 不存在这些组件 ${hallucinated.map(n => `<t-${n}>`).join("、")}。只允许白名单组件或原生 HTML 实现该功能，重新输出完整文件。`;
                            console.log(`[${this.name}] ${task.id} ${filePath} 闸门：幻觉组件 ${hallucinated.join("、")}（第 ${attempt} 次打回）`);
                            continue;
                        }
                        console.warn(`[${this.name}] ${task.id} ${filePath} 闸门：幻觉组件打回耗尽，本文件判失败`);
                        return null;   // 宁可失败走返工循环，不交幻觉代码
                    }
                }
                // ---- T1 编译闸门（9/8）：幻觉过了还要过编译——语法/SFC 结构/相对引用一锅查，
                // 与幻觉闸共用 attempt×3 名额，耗尽同样判文件失败走返工（宁失败不交坏码）----
                const problems = await checkFile(filePath, code, known);
                if (problems.length > 0) {
                    if (attempt < 3) {
                        feedback = gateFeedback(attempt, problems);
                        console.log(`[${this.name}] ${task.id} ${filePath} 编译闸门：${problems.join("；").slice(0, 80)}（第 ${attempt} 次打回）`);
                        continue;
                    }
                    console.warn(`[${this.name}] ${task.id} ${filePath} 编译闸门打回耗尽，本文件判失败`);
                    return null;
                }
                return code;
            } catch (error) {
                feedback = `\n\n## 上次调用失败，请重试：${(error as Error).message.slice(0, 200)}`;
                console.log(`[${this.name}] ${task.id} ${filePath} 失败（第 ${attempt} 次）：${(error as Error).message.slice(0, 80)}`);
            }
        }
        return null;
    }
}
