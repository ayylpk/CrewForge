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
import { writeWorkspace, readWorkspace, sliceGuard, flushWorkspacePersists, type ExecTask, REQUEST_WRAPPER_PATH, REQUEST_WRAPPER_CODE } from "./common";
import { currentProjectId, projectDir } from "./runEnv";
import { updateStatusByExt } from "./task";
import { nodePrompt, type Node } from "./Node";
import { buildKnown, checkFile, gateFeedback, fileTreePrompt } from "./checkers";
import { contractPromptBlock, loadContracts, parseBannedImports } from "./contracts";
import { registerRoutes, STYLE_CSS } from "./foundation";
import { baselinePromptBlock, resolveProjectBaseline } from "./baseline";
import { gate } from "./concurrency";
import { FILE_TOOLS, TOOL_PROTOCOL, runToolFileJob, type ToolExecCtx } from "./fileTools";
import { runtimeSettings } from "./settings";
import { assemblePrompt, buildStablePrefix, fingerprint } from "./engine/steps/promptPrefix";
import { CODE_QUALITY_RULES } from "./engine/steps/codeQualityRules";
import { fitContext, describeFit, DEFAULT_CONTEXT_BUDGET } from "./engine/steps/contextBudget";
import { resolveStackProfile, type StackProfile } from "./engine/stacks/profile";
import { findComponentTagIssues, shouldScanComponentTags } from "./engine/stacks/components";
import { verifyWrittenTask, type TaskVerifyResult } from "./engine/exec/verify/taskVerify";
import { FailureLedger } from "./engine/exec/verify/ledger";
import { decideWrite, OwnershipRegistry } from "./engine/workspace/ownership";
import path from "node:path";

/** M3-a（9/10）：单任务构建返工次数上限 */
const MAX_BUILD_REPAIRS = 2;

const FRONTEND_MODEL_JSON = JSON.stringify({
    provider: "deepseek",
    model: "deepseek-v4-flash",
    temperature: 0.1,
    thinking: false,
});

/**
 * C-2（9/10 成本轨）：文件数低于此值的小任务跳过「设计稿」阶段。
 * 阈值比后端保守（后端 <3、前端 <2）：前端设计稿承载页面结构/交互，价值高于后端伪代码，
 * 因此只砍最小的单文件任务；多页面任务的整页原子性依赖设计稿，保留。
 */
const SKIP_DESIGN_MAX_FILES = 2;

// ---------- 提示词 ----------

// 工位 A：页面设计稿（先定结构/交互/接口清单，再让 B 实现）
export const design_prompt: string = `
# 角色
你是 CrewForge 项目的前端设计 Agent。为指定任务产出"页面设计稿"，不做代码实现。

${baselinePromptBlock()}

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

${baselinePromptBlock()}

## 规则
- 只输出任务 files 中的唯一文件，不新增、不遗漏、不改名。
- 遵循任务中的前端技术栈、设计稿（接口字段/组件结构必须照抄）和验收标准。
- 先理解下方已有文件内容，再在必要时最小修改；没有已有内容时从零产出完整文件。
- 不发明任务之外的接口、字段、交互或业务规则。
- 只输出目标文件的完整源代码，不要 JSON、Markdown 代码围栏或额外说明。
`;

// ---------- 基建占位（p2 复盘修①，9/9：路径+内容双同源，不再悬空） ----------
// 旧文案只写 "request.ts —— 全局请求封装（基建产出）" 不给路径，地基批却未必产出（p2 造的是
// services/api.js）——34 次打回里 20 次幽灵 import 就是这几行教的。现在：
//   内容=common.ts 常量（architect.ensureRequestFoundation 落盘用的同一份，教的路径=盘上真实存在）；
//   路径钉死契约标准 frontend/src/utils/request.ts，由地基代码强制保证在场。
const DEFAULT_THEME = STYLE_CSS;

const DEFAULT_REQUEST = REQUEST_WRAPPER_CODE + `
// 用法（页面/组件统一走这个封装，不要另起 axios/fetch 轮子）：
// import request from '../utils/request';   // ../ 深度按当前文件所在位置调整`;

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

// 历史设计稿兼容解析器；核心生产提示词不再依赖组件库文档/MCP。
export function parseDesignComponents(design: string | null): string[] {
    if (!design) return [];
    const line = design.match(/【组件清单】(.+)/)?.[1] ?? "";
    const names = [...new Set([...line.matchAll(/t-([a-z][a-z0-9-]*)/g)].map(m => m[1] ?? ""))].filter(Boolean);
    return names.slice(0, 15);
}

// ============================================================
// 技术栈上下文（9/10：替代已删除的四条硬编码规约常量）
//
//   此前引擎里躺着 TDesign×2 + Element Plus×2 四条规约，**全部零引用**——模型拿不到组件库规约，
//   而 architect 又强制装 element-plus、幻觉闸还是空实现。现在规约由 StackProfile **按任务技术栈**
//   生成：换栈只换描述符，不换引擎。未登记栈走 GENERIC（verified=false）并在日志里显式标注。
// ============================================================
interface StackContext { profile: StackProfile; rule: string; verified: boolean; label: string }

function stackContextOf(engineName: string, task: ExecTask): StackContext {
    const baseline = resolveProjectBaseline(task.stack);
    const profile = resolveStackProfile(baseline);
    if (!profile.verified) {
        console.warn(`[${engineName}] ⚠️ 未登记技术栈（${baseline.frontend.framework}/${baseline.backend.framework}）：`
            + `本栈无验证器，产物只能"未验证"交付，不得计入通过`);
    }
    return {
        profile,
        rule: profile.uiRule(baseline),
        verified: profile.verified,
        label: `${profile.id}·${baseline.frontend.ui}`,
    };
}

// ============================================================
// FrontendEngineer —— 双队列流水线（任务 → 设计稿 → 代码）
// ============================================================

export class FrontendEngineer extends BaseAgent {
    /** T7b：工具模式一次性判死（同 backendEngineer） */
    private toolModeDead = false;
    /** M3-a：失败账本（同一签名 + 同一修法重复即升级） */
    private readonly ledger = new FailureLedger();
    /** M3-a：单任务已用构建返工次数 */
    private readonly buildRepairs = new Map<string, number>();
    /** M4：文件 owner 登记 */
    private readonly ownership = new OwnershipRegistry();
    /** 最近一次执行式验证结果（供报告/落库） */
    private lastVerify: TaskVerifyResult | null = null;
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
        this.designPrompt = nodePrompt(nodes, "页面设计", design_prompt);
        this.filePrompt = nodePrompt(nodes, "代码实现", file_prompt);
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
        // T7a（9/8 用户拍板，与 backendEngineer 同款）：队列无上限，token 限在制（出厂各 5）
        for (let i = 0; i < 5; i++) void this.designWorker();
        for (let i = 0; i < 5; i++) void this.codeWorker();
    }

    // ---------- 工位 A：任务 → 设计稿 ----------

    private async designWorker(): Promise<void> {
        const g = gate("frontend.design");
        while (true) {
            const { task } = await this.taskQueue.pop();
            await g.acquire();
            try {
                // C-2（9/10）：单文件小任务跳过设计稿阶段（阈值 SKIP_DESIGN_MAX_FILES）
                if (task.files.length < SKIP_DESIGN_MAX_FILES) {
                    console.log(`[${this.name}] ${task.id} 单文件任务跳过设计稿阶段，直接进实现工位（C-2 省一次调用）`);
                    this.designQueue.push({ task, design: null });
                    continue;
                }
                console.log(`[${this.name}] ${task.id} 进入设计工位`);
                const design = await this.generateDesign(task);   // 失败返回 null（降级）
                this.designQueue.push({ task, design });          // 塞进下游，立即回头
            } finally {
                g.release();   // A 阶段"落盘"=移交下游（含降级 null）
            }
        }
    }

    private async generateDesign(task: ExecTask): Promise<string | null> {
        const model = initModels(FRONTEND_MODEL_JSON, "pseudo");   // T3：A 工位（设计稿）归 pseudo 档
        const baseline = resolveProjectBaseline(task.stack);
        const dynamicBaseline = `\n\n${baselinePromptBlock(baseline)}`;
        const contract = contractPromptBlock(await loadContracts());   // T2：契约头部注入（设计稿的页面/路由归属以此为准）
        const stack = stackContextOf(this.name, task);                 // ★ 栈驱动规约（替代已删的硬编码常量）
        let feedback = "";
        for (let attempt = 1; attempt <= 3; attempt++) {
            const ts = Date.now();
            try {
                // 工位超时 9/3 拍板：与主链同级 300s（旧 180s 两档制被 run10 击穿，见 backendEngineer 同款注释）
                const res = await invokeWithTimeout<any>(`${task.id} 设计稿`, DEFAULT_TIMEOUT_MS, sig => model.invoke([
                    new SystemMessage(assemblePrompt(
                        { role: this.designPrompt + stack.rule, baseline: dynamicBaseline, contract },
                        [`\n\n## 当前任务\n${JSON.stringify(task, null, 2)}`, feedback],
                    )),
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
        const g = gate("frontend.code");
        while (true) {
            const { task, design } = await this.designQueue.pop();
            await g.acquire();   // T7a：领令牌开工——整任务（含 TDesign 预取+逐文件+统一写盘）算一件在制
            try {
            console.log(`[${this.name}] ${task.id} 进入实现工位${design ? "" : "（设计稿缺失，单步实现）"}`);
            if (task.files.length === 0) {
                // 9/3 run11 修正：无 UI 任务（Swagger 调试类，架构师明示"无新增前端界面"）= 没有文件要写就是完成，
                // 与 backendEngineer 同语义 success:true。旧值 false 让 merger 数满 3 轮放弃整对——
                // run10/run11 里所有"开发自测失败 3 轮"的无 UI 对全是这个不对称杀的（超时修复后现形）
                this.send("merger", { type: "task_result", task, success: true });
                continue;
            }

            // 任务内已生成文件记忆（同任务后写的文件能看到先写的，跨文件衔接）
            const writtenFiles = new Map<string, string>();
            const implementation: { filePath: string; code: string }[] = [];
            let failed = false;
            const pid = currentProjectId();   // p3 修②：收口登记路由用（generateFile 里同名变量互不干涉）
            // ★ C-3（9/10）：文件树**快照**——整任务只算一次（磁盘 ∪ 计划内，不含本任务已写文件），
            //   稳定段不随写盘增长 → 同任务后续调用前缀逐字节一致（缓存命中）；已写文件另由 existingContent 注入
            const taskTree = fileTreePrompt(buildKnown(pid != null ? projectDir(pid) : null, new Map(), task.files));

            for (const filePath of task.files) {
                const code = await this.generateFile(task, design, filePath, writtenFiles, taskTree);
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
            // ★ M4（9/10）写盘纪律：越界/引擎件/非声明文件一律拒（路由登记仍由引擎机械完成）
            const planProfile = resolveStackProfile(resolveProjectBaseline(task.stack));
            for (const f of implementation) {
                const decision = decideWrite({ path: f.filePath, taskId: task.id, plannedFiles: task.files, profile: planProfile });
                if (!decision.ok) {
                    console.warn(`[${this.name}] ${task.id} 拒绝写盘（${decision.code}）：${decision.reason}`
                        + (decision.candidates?.length ? `；候选：${decision.candidates.join("、")}` : ""));
                    failed = true;
                    break;
                }
                const claim = this.ownership.claim(f.filePath, task.id);
                if (!claim.ok) {
                    console.warn(`[${this.name}] ${task.id} 拒绝写盘（owner 冲突）：${claim.reason}`);
                    failed = true;
                    break;
                }
                const full = writeWorkspace(f.filePath, f.code);
                writtenFiles.set(f.filePath, f.code);
                console.log(`已写入 ${full}`);
            }
            this.ownership.releaseTask(task.id);
            if (failed) {
                this.send("merger", { type: "task_result", task, success: false });
                continue;
            }
            // p3 修②（9/9）：路由机械登记——契约「页面清单」里归本任务的页面由引擎追加进 router/index.ts，
            // 模型不碰路由文件（登记死锁病根绝根）；失败只 warn，页面可达性还有测试判定兜底
            await registerRoutes(pid, task, await loadContracts())
                .catch(e => console.warn(`[${this.name}] ${task.id} 路由机械登记异常（旁路）:`, (e as Error).message));
            await flushWorkspacePersists();
            // ★ M3-a（9/10）：写盘不是交付——前端跑真实 `build`（tsc + 打包）作为最接近"能不能跑"的廉价判据
            const verdict = await this.verifyAfterWrite(task);
            if (verdict === "rework") continue;
            if (verdict === "failed") {
                this.send("merger", { type: "task_result", task, success: false });
                continue;
            }
            console.log(`[${this.name}] ${task.id} 前端实现已写入 workspace/`);
            this.send("merger", { type: "task_result", task, success: true });
            } finally {
                g.release();   // ★ 真落盘或判失败之后才归还（backend 同款，finally 罩住全部 continue/异常路径）
            }
        }
    }

    /**
     * M3-a：写盘后执行式验证。语义与 backendEngineer.verifyAfterWrite 完全一致：
     *   构建通过 → delivered；构建不过 → 有界返工（把构建诊断喂回）；环境/未验证 → 放行但标注"未验证"。
     */
    private async verifyAfterWrite(task: ExecTask): Promise<"delivered" | "rework" | "failed"> {
        const pid = currentProjectId();
        if (pid == null) return "delivered";
        const profile = resolveStackProfile(resolveProjectBaseline(task.stack));
        const res = await verifyWrittenTask({
            projectDir: projectDir(pid),
            layer: "frontend",
            profile,
            logDir: path.join(projectDir(pid), "_verify"),
        });
        this.lastVerify = res;

        if (res.outcome === "ok") {
            console.log(`[${this.name}] ${task.id} 执行式验证通过：${res.summary}`);
            return "delivered";
        }
        if (res.outcome === "compile_error") {
            const decision = this.ledger.record(res.signature, "compile_repair", "build", res.feedback[0] ?? "");
            const used = this.buildRepairs.get(task.id) ?? 0;
            if (decision.shouldEscalate || used >= MAX_BUILD_REPAIRS) {
                console.warn(`[${this.name}] ${task.id} 构建返工停止：${decision.reason ?? `已返工 ${used} 次仍未过`}`);
                console.warn(`[${this.name}] ${task.id} 最后一次诊断：${res.feedback.slice(0, 3).join(" | ")}`);
                return "failed";
            }
            this.buildRepairs.set(task.id, used + 1);
            console.warn(`[${this.name}] ${task.id} 构建未过（第 ${used + 1} 次返工，${res.summary}）：${res.feedback.slice(0, 2).join(" | ")}`);
            this.taskQueue.push({
                task: {
                    ...task,
                    files: task.files,
                    description: task.description
                        + `\n\n【构建验证返工（第 ${used + 1} 次，必须逐条解决；错误原文如下）】\n`
                        + res.feedback.join("\n"),
                },
            });
            return "rework";
        }
        console.warn(`[${this.name}] ${task.id} 未完成执行式验证（${res.outcome}）：${res.summary} —— 按"未验证"交付，不计入通过`);
        return "delivered";
    }

    private async generateFile(
        task: ExecTask,
        design: string | null,
        filePath: string,
        writtenFiles: Map<string, string>,
        taskTree: string,
    ): Promise<string | null> {
        const model = initModels(FRONTEND_MODEL_JSON, "frontend");   // T3：B 工位（页面实现）归 frontend 档
        const finalBaseline = resolveProjectBaseline(task.stack);
        const dynamicBaseline = `\n\n${baselinePromptBlock(finalBaseline)}`;
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
        // 文件树用**任务级快照**（C-3）：贴进 prompt 的树不随本任务写盘增长，保证前缀稳定
        const treeBlock = taskTree;
        const contractsMd = await loadContracts();                         // p3 修④：留原文解析禁用包清单
        const contract = contractPromptBlock(contractsMd);                 // T2：契约头部注入（旁路=无契约空串）
        const banned = parseBannedImports(contractsMd);
        const guard = sliceGuard(task.files.length);                       // T4：竖切大任务收敛为 2 次×600s
        // ★ C-1（9/10 成本轨）：稳定段定序装配（角色→基线→契约→文件树[→工具协议]），易变段只许追加在后
        const stack = stackContextOf(this.name, task);                     // ★ 栈驱动规约（组件库/封装/样式变量）
        const stackRule = stack.profile.componentRules(finalBaseline);
        const stableSections = { role: this.filePrompt + stack.rule + CODE_QUALITY_RULES, baseline: dynamicBaseline, contract, fileTree: treeBlock };
        console.log(`[${this.name}] ${task.id} ${filePath} 栈=${stack.label} 验证=${stack.verified} 稳定前缀 ${fingerprint(buildStablePrefix(stableSections))}（${buildStablePrefix(stableSections).length} 字符）`);
        // ---- T7b 工具模式（默认关，backendEngineer 同注释）。幻觉闸挂进工具的 extraGate 位：
        // write/edit 内容里的越库组件标签红=拒绝落盘+错因回给模型（9/5 闸门语义，9/10 改为**栈驱动**：
        //   判据来自本栈声明的组件库，不再硬编码 Element Plus/TDesign）----
        if (runtimeSettings()?.toolMode && !this.toolModeDead) {
            try {
                const toolModel = initModels(JSON.stringify({ ...JSON.parse(FRONTEND_MODEL_JSON), tools: FILE_TOOLS }), "frontend");
                const ctx: ToolExecCtx = {
                    pid, written: writtenFiles, planned: task.files, landed: null, banned,
                    extraGate: async (fp, code) => shouldScanComponentTags(fp) ? findComponentTagIssues(code, stackRule) : [],
                };
                const landed = await runToolFileJob({
                    system: assemblePrompt(
                        { ...stableSections, toolProtocol: TOOL_PROTOCOL },
                        [
                            `\n\n## 当前子任务\n${JSON.stringify(fileTask, null, 2)}`,
                            designHint,
                            existingContent,
                            dbExistingPrompt,
                            `\n\n## 主题变量\n${DEFAULT_THEME}\n\n## 请求封装（固定路径 ${REQUEST_WRAPPER_PATH}，地基已代码保证落盘）\n${DEFAULT_REQUEST}`,
                        ],
                    ),
                    targetFile: filePath, ctx,
                    maxRounds: task.files.length >= 3 ? 12 : 8,   // p3 loop 化（9/9）：五件工具+查证开销，轮次预算翻倍
                    timeoutMs: guard.timeoutMs,
                    label: `${task.id} ${filePath}`,
                    invoke: (msgs, sig) => toolModel.invoke(msgs, { signal: sig }),
                });
                if (landed != null) return landed;
                // ★ C-4（9/10）：轮次耗尽/模型放弃不再直接判死文件——退单发老路重试一次
                console.warn(`[${this.name}] ${task.id} ${filePath} 工具循环未交付（${ctx.exitReason ?? "?"}；连续未命中 ${ctx.missStreak ?? 0} 次），退单发老路重试`);
            } catch (e) {
                this.toolModeDead = true;
                console.warn(`[${this.name}] 工具模式异常（${(e as Error).message.slice(0, 120)}），本进程退回单发老路，当前文件立即重走`);
            }
        }

        let feedback = "";
        for (let attempt = 1; attempt <= guard.maxAttempt; attempt++) {
            const ts = Date.now();
            try {
                const res = await invokeWithTimeout<any>(`${task.id} ${filePath}`, guard.timeoutMs, sig => model.invoke([
                    new SystemMessage(
                        assemblePrompt(stableSections, [
                            // ★ 上下文预算：essential=返工意见/目标文件；其余按优先级填充
                            fitContext([
                                { name: "返工意见", text: feedback, priority: 9, essential: true },
                                { name: "目标文件", text: `\n\n## 当前子任务路径\n${filePath}`, priority: 9, essential: true },
                                { name: "设计稿", text: designHint, priority: 6 },
                                { name: "现有内容", text: dbExistingPrompt, priority: 5 },
                                { name: "当前子任务", text: `\n\n## 当前子任务\n${JSON.stringify(fileTask, null, 2)}`, priority: 5 },
                                { name: "本任务其他文件", text: existingContent, priority: 2 },
                                { name: "主题与封装", text: `\n\n## 主题变量\n${DEFAULT_THEME}\n\n## 请求封装（固定路径 ${REQUEST_WRAPPER_PATH}，地基已代码保证落盘）\n${DEFAULT_REQUEST}`, priority: 4 },
                            ], DEFAULT_CONTEXT_BUDGET).text,
                        ])
                    ),
                ], { signal: sig }));
                console.log(`[${this.name}] ${task.id} ${filePath} ${Date.now() - ts}ms`);
                const code = extractGeneratedCode(res.content);
                if (!code) {
                    feedback = "\n\n## 上次输出没有提取到代码：请只输出目标文件的完整源代码，不要 Markdown 围栏、JSON 或说明。";
                    continue;
                }

                // ---- T1 编译闸门（9/8）：幻觉过了还要过编译——语法/SFC 结构/相对引用一锅查，
                // 与幻觉闸共用本轮工位 attempt 名额，耗尽同样判文件失败走返工（宁失败不交坏码）----
                const problems = await checkFile(filePath, code, known, banned);
                // ★ 9/10：组件库校验在老路同样生效（此前只挂在工具模式的空实现 extraGate 上，等于全丢）
                if (shouldScanComponentTags(filePath)) {
                    problems.push(...findComponentTagIssues(code, stackRule));
                }
                if (problems.length > 0) {
                    if (attempt < guard.maxAttempt) {
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
