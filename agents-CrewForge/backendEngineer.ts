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
import { invokeWithTimeout, DEFAULT_TIMEOUT_MS } from "./llm";
import { writeWorkspace, readWorkspace, sliceGuard, flushWorkspacePersists, type ExecTask } from "./common";
import { currentProjectId, projectDir } from "./runEnv";
import { updateStatusByExt } from "./task";
import { nodePrompt, type Node } from "./Node";
import { buildKnown, checkFile, gateFeedback, fileTreePrompt } from "./checkers";
import { contractPromptBlock, loadContracts, parseBannedImports } from "./contracts";
import { gate } from "./concurrency";
import { FILE_TOOLS, TOOL_PROTOCOL, runToolFileJob, type ToolExecCtx } from "./fileTools";
import { runtimeSettings } from "./settings";
import { baselinePromptBlock, resolveProjectBaseline } from "./baseline";
import { assemblePrompt, buildStablePrefix, fingerprint } from "./engine/steps/promptPrefix";
import path from "node:path";
import { resolveStackProfile } from "./engine/stacks/profile";
import { verifyWrittenTask, type TaskVerifyResult } from "./engine/exec/verify/taskVerify";
import { FailureLedger } from "./engine/exec/verify/ledger";
import { decideWrite, OwnershipRegistry } from "./engine/workspace/ownership";

const BACKEND_MODEL_JSON = JSON.stringify({
    provider: "deepseek",
    model: "deepseek-v4-flash",
    temperature: 0.1,
    thinking: false,
});

/**
 * C-2（9/10 成本轨）：文件数低于此值的小任务跳过「伪代码」阶段。
 * 口径与 sliceGuard 的"大任务 ≥3 文件"一致——小任务的契约已自包含在 task.description 里，
 * 再烧一次调用做骨架属纯开销（runs/p9 是 6 个任务 6 次伪代码调用）。
 */
const SKIP_PSEUDO_MAX_FILES = 3;

/** M3-a（9/10）：单任务编译返工次数上限（超限则判失败走既有返工链，不无限烧） */
const MAX_COMPILE_REPAIRS = 2;

/** 生成项目常无 mvnw，用引擎仓库自带的 wrapper 兜底（可用 CREWFORGE_MVNW 覆盖） */
const REPO_MVNW = process.env.CREWFORGE_MVNW?.trim()
    || path.resolve(import.meta.dir, "..", "backed-CrewForge", "mvnw.cmd");

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
    /** T7b：工具模式一次性判死（端点不支持 function-calling 等）→ 本进程全退回单发老路 */
    private toolModeDead = false;
    /** M3-a：失败账本（同一签名 + 同一修法出现第二次即升级，禁止原地重复） */
    private readonly ledger = new FailureLedger();
    /** M3-a：单任务已用编译返工次数 */
    private readonly compileRepairs = new Map<string, number>();
    /** M4：文件 owner 登记（一个文件同一时刻只有一个 writer） */
    private readonly ownership = new OwnershipRegistry();
    /** 最近一次执行式验证结果（供报告/落库，M8 消费） */
    private lastVerify: TaskVerifyResult | null = null;
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
        // T7a（9/8 用户拍板）：队列不设上限，token 限在制——工位数对齐 station_slots（出厂 5），
        // 真并发由全局闸管（同进程多实例共享一把）：2 个后端实例×5 worker=10 个取货员，
        // 但全端同时在制伪代码 ≤5、在制代码任务 ≤5；空等的 worker 停在 pop 上，不占令牌
        for (let i = 0; i < 5; i++) void this.pseudoWorker();
        for (let i = 0; i < 5; i++) void this.codeWorker();
    }

    // ---------- 工位 A：任务 → 伪代码 ----------

    private async pseudoWorker(): Promise<void> {
        const g = gate("backend.pseudo");
        while (true) {
            const { task } = await this.taskQueue.pop();
            await g.acquire();
            try {
                // C-2（9/10）：小任务跳过伪代码——少一次调用胜过任何缓存优化。
                // 降级语义与"伪代码失败"一致（pseudo=null → B 单步生成完整代码）
                if (task.files.length < SKIP_PSEUDO_MAX_FILES) {
                    console.log(`[${this.name}] ${task.id} 小任务（${task.files.length} 文件）跳过伪代码阶段，直接进代码工位（C-2 省一次调用）`);
                    this.pseudoQueue.push({ task, pseudo: null });
                    continue;
                }
                console.log(`[${this.name}] ${task.id} 进入伪代码工位`);
                const pseudo = await this.generatePseudo(task);   // 失败返回 null（降级）
                this.pseudoQueue.push({ task, pseudo });          // 塞进下游，立即回头处理下一个
            } finally {
                g.release();   // A 阶段的"落盘"=移交下游；降级路径（null）同样移交，都算归还
            }
        }
    }

    private async generatePseudo(task: ExecTask): Promise<string | null> {
        const model = initModels(BACKEND_MODEL_JSON, "pseudo");   // T3：A 工位（伪代码）归 pseudo 档
        const dynamicBaseline = `\n\n${baselinePromptBlock(resolveProjectBaseline(task.stack))}`;
        const contract = contractPromptBlock(await loadContracts());   // T2：契约头部注入（无契约=空串，旁路）
        let feedback = "";
        for (let attempt = 1; attempt <= 3; attempt++) {
            const ts = Date.now();
            try {
                // 工位超时 9/3 拍板：与主链同级 300s（旧 180s 两档制被击穿——run10 代码步实测 178~256s 尾延迟，3 发全误杀致整阶段 0 通过）
                const res = await invokeWithTimeout<any>(`${task.id} 伪代码`, DEFAULT_TIMEOUT_MS, sig => model.invoke([
                    new SystemMessage(this.skeletonPrompt + dynamicBaseline + contract + `\n\n## 当前任务\n${JSON.stringify(task, null, 2)}` + feedback),
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
        const g = gate("backend.code");
        while (true) {
            const { task, pseudo } = await this.pseudoQueue.pop();
            await g.acquire();   // T7a：领令牌开工——整任务（逐文件生成+统一写盘）算一件在制
            try {
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
            // ★ C-3（9/10）：文件树**快照**——整任务只算一次（磁盘 ∪ 计划内，**不含本任务已写文件**）：
            //   ① 稳定段不随写盘增长 → 同任务后续调用前缀逐字节一致（缓存命中）
            //   ② 本任务已写文件由 taskExistingPrompt 单独注入，信息一点不丢
            const pid = currentProjectId();
            const taskTree = fileTreePrompt(buildKnown(pid != null ? projectDir(pid) : null, new Map(), task.files));

            for (const filePath of task.files) {
                const code = await this.generateFile(task, pseudo, filePath, writtenFiles, taskTree);
                if (!code) { failed = true; break; }
                implementation.push({ filePath, code });
                // T1 顺带修（9/8）：writtenFiles 原先只在任务全部成功后统一补——生成期永远是空的，
                // 注释宣称的"本任务先写文件注入/闸门已知文件集"实际都没吃到。生成一个补一个才符合原意
                // （写在 implementation 旁：任务失败时这两个内存结构整体作废，磁盘未污染，无副作用）
                writtenFiles.set(filePath, code);
            }

            if (failed) {
                console.log(`[${this.name}] ${task.id} 代码生成失败，上报合并器`);
                this.send("merger", { type: "task_result", task, success: false });
                continue;
            }
            // ★ M4（9/10）写盘纪律：越界/引擎件/非声明文件一律拒；一文件一 owner
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
            this.ownership.releaseTask(task.id);   // 任务收口即释放（失败路径也要释放，防死锁后续任务）
            if (failed) {
                this.send("merger", { type: "task_result", task, success: false });
                continue;
            }
            await flushWorkspacePersists();
            // ★ M3-a（9/10）：**写盘不是交付**——立刻用真实命令验证（Java = 真实 classpath 编译）。
            //   编译不过 → 带诊断返工（有界）；环境/验证器缺失 → 放行但显式标注"未验证"，绝不计入通过。
            const verdict = await this.verifyAfterWrite(task);
            if (verdict === "rework") continue;                       // 已重新入队，本轮不报成功
            if (verdict === "failed") {
                this.send("merger", { type: "task_result", task, success: false });
                continue;
            }
            console.log(`[${this.name}] ${task.id} 后端实现已写入 workspace/`);
            this.send("merger", { type: "task_result", task, success: true });
            } finally {
                g.release();   // ★ 真落盘或判失败之后才归还（用户拍板的归还时机；finally 罩住全部 continue/异常路径）
            }
        }
    }

    /**
     * M3-a：写盘后执行式验证（自我纠正闭环的入口）。
     *   · 编译通过      → delivered
     *   · 编译不过      → 有界返工（把 javac 原文喂回实现器），超限/账本判定重复 → failed
     *   · 环境/未验证   → delivered，但**明确标注未验证**（未验证 ≠ 通过）
     */
    private async verifyAfterWrite(task: ExecTask): Promise<"delivered" | "rework" | "failed"> {
        const pid = currentProjectId();
        if (pid == null) return "delivered";
        const profile = resolveStackProfile(resolveProjectBaseline(task.stack));
        const res = await verifyWrittenTask({
            projectDir: projectDir(pid),
            layer: "backend",
            profile,
            mvnwPath: REPO_MVNW,
            logDir: path.join(projectDir(pid), "_verify"),
        });
        this.lastVerify = res;

        if (res.outcome === "ok") {
            console.log(`[${this.name}] ${task.id} 执行式验证通过：${res.summary}`);
            return "delivered";
        }
        if (res.outcome === "compile_error") {
            const decision = this.ledger.record(res.signature, "compile_repair", "compile", res.feedback[0] ?? "");
            const used = this.compileRepairs.get(task.id) ?? 0;
            if (decision.shouldEscalate || used >= MAX_COMPILE_REPAIRS) {
                console.warn(`[${this.name}] ${task.id} 编译返工停止：${decision.reason ?? `已返工 ${used} 次仍未过`}`);
                console.warn(`[${this.name}] ${task.id} 最后一次诊断：${res.feedback.slice(0, 3).join(" | ")}`);
                return "failed";
            }
            this.compileRepairs.set(task.id, used + 1);
            console.warn(`[${this.name}] ${task.id} 编译未过（第 ${used + 1} 次返工，${res.summary}）：${res.feedback.slice(0, 2).join(" | ")}`);
            this.taskQueue.push({
                task: {
                    ...task,
                    description: task.description
                        + `\n\n【编译验证返工（第 ${used + 1} 次，必须逐条解决；错误原文如下）】\n`
                        + res.feedback.join("\n"),
                },
            });
            return "rework";
        }
        // env_error / tool_error / skipped_unverified：环境或验证器缺失，不是代码错
        console.warn(`[${this.name}] ${task.id} 未完成执行式验证（${res.outcome}）：${res.summary} —— 按"未验证"交付，不计入通过`);
        return "delivered";
    }

    private async generateFile(
        task: ExecTask,
        pseudo: string | null,
        filePath: string,
        writtenFiles: Map<string, string>,
        taskTree: string,
    ): Promise<string | null> {
        const model = initModels(BACKEND_MODEL_JSON, "backend");   // T3：B 工位（代码实现）归 backend 档
        const dynamicBaseline = `\n\n${baselinePromptBlock(resolveProjectBaseline(task.stack))}`;
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
        // T1 编译闸门（9/8，v3 §2-T1）：写盘不是交付——返回前必须过编译。
        // known = 磁盘树(runs/pN) ∪ 本任务已生成 ∪ 计划内路径（存在性可核，内容未生成的自动跳名核验）
        const pid = currentProjectId();
        const known = buildKnown(pid != null ? projectDir(pid) : null, writtenFiles, task.files);
        // 文件树用**任务级快照**（C-3）：贴进 prompt 的树不随本任务写盘增长，保证前缀稳定
        const treeBlock = taskTree;
        const contractsMd = await loadContracts();               // p3 修④：留原文解析禁用包清单
        const contract = contractPromptBlock(contractsMd);       // T2：契约头部注入（旁路同伪代码工位）
        const banned = parseBannedImports(contractsMd);
        const guard = sliceGuard(task.files.length);                   // T4：竖切大任务收敛为 2 次×600s
        // ★ C-1（9/10 成本轨）：稳定段定序装配（角色→基线→契约→文件树[→工具协议]），
        //   易变段（任务/文件路径/已写文件/现有内容/反馈）只许追加在后。指纹打日志，
        //   便于事后核对"本该命中缓存却没命中"的批次（成本可观测的第一步）。
        const stableSections = { role: this.codePrompt, baseline: dynamicBaseline, contract, fileTree: treeBlock };
        console.log(`[${this.name}] ${task.id} ${filePath} 稳定前缀 ${fingerprint(buildStablePrefix(stableSections))}（${buildStablePrefix(stableSections).length} 字符）`);
        // ---- T7b 工具模式（sys_settings.tool_mode 默认关）：runToolFileJob 走 read/write/edit 交付——
        // 工具内 write/edit 自带过闸+落盘+文件锁，落地即返回；未交付则退单发老路（C-4）；
        // 抛异常（端点不支持 function-calling 等）→ 本进程永久退回下面的单发老路 ----
        if (runtimeSettings()?.toolMode && !this.toolModeDead) {
            try {
                const toolModel = initModels(JSON.stringify({ ...JSON.parse(BACKEND_MODEL_JSON), tools: FILE_TOOLS }), "backend");
                const ctx: ToolExecCtx = { pid, written: writtenFiles, planned: task.files, landed: null, banned };
                const landed = await runToolFileJob({
                    system: assemblePrompt(
                        { ...stableSections, toolProtocol: TOOL_PROTOCOL },
                        [
                            `\n\n## 当前任务\n${JSON.stringify(fileTask, null, 2)}`,
                            `\n\n## 当前目标文件\n${filePath}`,
                            `\n\n## 项目路径\nworkspace`,
                            taskExistingPrompt, existingPrompt, pseudoHint,
                        ],
                    ),
                    targetFile: filePath, ctx,
                    maxRounds: task.files.length >= 3 ? 12 : 8,   // p3 loop 化（9/9）：五件工具+查证开销翻倍（老路 attempt 仍是 2~3）
                    timeoutMs: guard.timeoutMs,
                    label: `${task.id} ${filePath}`,
                    invoke: (msgs, sig) => toolModel.invoke(msgs, { signal: sig }),
                });
                if (landed != null) return landed;   // 已落盘；codeWorker 末尾对同内容再幂等写一次（upsert 无害），协议零改动
                // ★ C-4（9/10）：轮次耗尽/模型放弃**不再直接判死文件**——退单发老路再试一次。
                //   旧行为（landed==null → return null）正是 runs/p9 阶段 3 六个任务 0 产出的直接原因。
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
                const res = await invokeWithTimeout<any>(`${task.id} 代码`, guard.timeoutMs, sig => model.invoke([
                    new SystemMessage(
                        assemblePrompt(stableSections, [
                            `\n\n## 当前任务\n${JSON.stringify(fileTask, null, 2)}`,
                            `\n\n## 当前目标文件\n${filePath}`,
                            `\n\n## 项目路径\nworkspace`,
                            taskExistingPrompt,
                            existingPrompt,
                            pseudoHint,
                            feedback,
                        ])
                    ),
                ], { signal: sig }));
                console.log(`[${this.name}] ${task.id} 代码 ${Date.now() - ts}ms`);
                const code = extractGeneratedCode(res.content);
                if (!code) {
                    feedback = "\n\n## 上次输出没有提取到代码：请只输出目标文件的完整源代码，不要 Markdown 围栏、JSON 或说明。";
                    continue;
                }
                // ---- 编译闸门打回：吃本轮工位 attempt 名额（同前端幻觉闸姿势），耗尽=文件失败走返工，宁失败不交坏码 ----
                const problems = await checkFile(filePath, code, known, banned);
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
                console.log(`[${this.name}] ${task.id} 代码失败（第 ${attempt} 次）：${(error as Error).message.slice(0, 80)}`);
            }
        }
        return null;
    }
}
