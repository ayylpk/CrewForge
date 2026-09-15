// ============================================================
// architectAgent.ts —— 自包含架构师 Agent（需求文本 → 蓝图 / 批次 / 任务包）
//
// 定位（9/15 新增）：此前 developerAgent 吃的任务包全靠"人 + Claude 手写 JSON"
//   （live/runner.ts --task xxx.json）。本模块把这一步自动化：唯一业务输入是
//   **项目需求原文**，产物是 developerAgent 可直接吃的任务包。
//
// 两阶段拆解（9/15 晚，用户拍板"拆出一个推一个"，取代"一步出整包"）：
//   · decomposeBlueprint()：1 次 LLM 吐**蓝图**（architect_task 形制）。蓝图=全局一次
//     冻结：技术栈 / domainModel / contract **全量** / 工作项骨架（顺序即执行序）/
//     全局底线判据（≥1 条，且每个 allowedRoots 至少 1 条 COMPILE——代码侧强制）。
//     WHY contract 必须整体在蓝图里：跨工作项一致性——前端项要能看到后端项的全部
//     接口，逐批增量补契约必然漂移；而整包体量的真正大头（逐接口 CONTRACT 判据）
//     已随批走，p7 撞的 480s 输出体量墙就是这么拆掉的。
//   · decomposeBatch()：每个工作项 1 次 LLM 吐 architect_batch（detail=该项详规、
//     checks=该竖切判据）。**禁止增删工作项，只能细化本项**——graph 侧 arrived 闸按
//     蓝图前缀推进，本来就收不下新项；写进提示词只是省模型返工，代码才是保证。
//   · assembleTask()：蓝图+批次 → 完整 ArchitectTask 的确定性合并（审计产物 /
//     _tasks 落盘重播种用）。纯函数不碰 fs——落盘策略归 runner。
//   · decompose()（一步整包）**原样保留**：live/runner.ts 还在调用它，步骤 6 切管线
//     后由 orchestrator 统一删除（连同 prompts/architect-system.md）。
//
// 三个生成入口共用同一条已验证的校验哲学（原 decompose 的设计，一字未改）：
//   · 1 次 LLM 调用吐 JSON → 校验链 → 不过就把**报错原文**喂回重试（≤maxAttempts）
//     ——与 graph 的 llmErrorTolerance 同哲学：模型犯格式错不是死刑，
//     有反馈环就能自愈；
//   · 校验链（从宽到严）：
//     ① extractJson —— 围栏/叙述文字里的 JSON 都能抠（复用 realLlm 既有函数）；
//     ② assertNoAuthorityFields —— 权威字段（done/verified/exitCode…）禁入，
//        这是"权威判定不在模型侧"铁律的入口闸；
//     ③ Schema.parse —— 形状校验（zod issues 摘要进反馈）；
//     ④ 业务硬闸 —— schema 合法但没法干活的空包/漏判据提前拦（各阶段清单见注释）；
//     ⑤ parseInbound 终验 —— 保证产物与 runner --task 完全同链路（runner 兼容的
//        机器证据，不是"应该兼容"）。
//   · 共享循环抽成 generateValidated()：信封拆包/抠 JSON/权威闸/反馈环/预算可见性
//     只写一遍，各阶段只交"闸门 + user 文本"两个回调——闸门顺序即 ①~⑤ 的哲学。
//   · 零依赖旧基建：不碰 BaseAgent/Hub/sys_task（旧 architect.ts 是另一条路线）；
//     LLM 通过 DeveloperLlm 接口注入（测试注 Fake，生产注 createRealLlm）。
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { extractJson } from "./realLlm";
import {
    ArchitectBatchSchema, ArchitectTaskSchema, assertNoAuthorityFields, parseInbound,
} from "./protocol";
import type { ArchitectBatch, ArchitectTask, WorkItem, WorkItemKind } from "./protocol";
import type { DeveloperLlm } from "./graph";

/** 缺省提示词目录（与 developerAgent 的 prompts/ 管理方式一致：磁盘读，不内嵌） */
const DEFAULT_PROMPT_DIR = path.resolve(import.meta.dir, "prompts");

// 提示词三份一拆（9/15 两阶段）：system=旧一步整包（decompose 专用，步骤 6 退役）；
// blueprint/batch 各自 ++ check-shape 拼接——判据机器字段口径只维护一份，防漂移。
const ARCHITECT_PROMPT_FILE = "architect-system.md";
const ARCHITECT_BLUEPRINT_PROMPT_FILE = "architect-blueprint.md";
const ARCHITECT_BATCH_PROMPT_FILE = "architect-batch.md";
const ARCHITECT_CHECK_SHAPE_FILE = "_check-shape.md";

/** 这些 kind 是业务实现项：批必须带 ≥1 条判据（无判据的批=该项没被验收） */
const CHECK_REQUIRED_KINDS: ReadonlySet<WorkItemKind> = new Set(["backend", "frontend", "database"]);

export interface ArchitectAgentOptions {
    /** LLM 适配器（DeveloperLlm 接口，与 developerAgent 同一形状） */
    llm: DeveloperLlm;
    /** 最大尝试次数（含首次），缺省 3 */
    maxAttempts?: number;
    /** 提示词目录覆盖（单测注入坏目录验 fail-fast 用；生产不传） */
    promptDir?: string;
}

export interface DecomposeInput {
    /** 项目需求原文（唯一业务输入） */
    requirement: string;
    /** 任务包身份，缺省 "p1"/"t1" */
    projectId?: string;
    taskId?: string;
}

/** 拆解结果：任务包 + 过程观测量（测试/CLI 报告用） */
export interface DecomposeResult {
    task: ArchitectTask;
    /** 消耗的 LLM 调用次数（含被拒重试） */
    attempts: number;
    /** 每轮被拒的原因摘要（成功前那些轮）；一次成功则为空 */
    rejections: string[];
}

export interface DecomposeBlueprintInput {
    requirement: string;
    projectId?: string;
    taskId?: string;
}

/** 蓝图拆解结果（形状与 DecomposeResult 对齐：task=architect_task 形制的蓝图） */
export interface BlueprintResult {
    task: ArchitectTask;
    attempts: number;
    rejections: string[];
}

export interface DecomposeBatchInput {
    /** 需求原文（蓝图的 requirementSnapshot 只是快照，原文才是判据的根据） */
    requirement: string;
    /** 已冻结的蓝图（全局之锚：prompt 全文带上 + CONTRACT 判据按它的 endpoints 校验） */
    blueprint: ArchitectTask;
    /** 本批要细化的工作项（必须来自蓝图，itemId 会被代码强制成本项 id） */
    item: WorkItem;
    /** 已交付判据 id（蓝图底线 + 之前各批）：撞车的批整批拒 */
    deliveredCheckIds: readonly string[];
    projectId?: string;
    taskId?: string;
    /** 覆盖本批最大尝试次数（runner 侧对批次可能想收紧）；缺省用 agent 的 */
    maxAttempts?: number;
}

export interface BatchResult {
    batch: ArchitectBatch;
    attempts: number;
    rejections: string[];
}

/**
 * 把 zod 错误压成模型可读、人也可读的摘要：
 * 每条 issue 一行"路径: 消息"，最多 12 条防爆。
 */
function zodIssuesSummary(error: unknown): string {
    const issues = (error as { issues?: { path: (string | number)[]; message: string }[] })?.issues;
    if (!Array.isArray(issues) || issues.length === 0) return String(error);
    return issues
        .slice(0, 12)
        .map((i) => `- ${i.path.length ? i.path.join(".") : "(根)"}：${i.message}`)
        .join("\n");
}

/** 提示词从磁盘读；缺失（ENOENT 直接抛）/为空 fail fast——宁可不跑，不带残缺提示词上真机 */
function readPrompt(dir: string, file: string): string {
    const text = fs.readFileSync(path.resolve(dir, file), "utf-8");
    if (!text.trim()) throw new Error(`architectAgent：prompts/${file} 为空或不可读`);
    return text;
}

/** 共享判据口径拼到阶段提示词尾部（一份口径，蓝图/批次两阶段同吃） */
function composePrompt(stage: string, shared: string): string {
    return `${stage.trimEnd()}\n\n${shared.trimStart()}`;
}

/**
 * DeveloperLlm 信封拆包（9/15 实弹抓到）：realLlm 在无工具模式下返回
 * {kind:"done", note:"<模型正文>"}——这是 Developer 工具循环的完成信号
 * 形状，对架构师来说是**信封**，正文在 note 里。不拆的话 extractJson
 * 抠到的是外层信封（顶层键 kind/note），zod 必然全字段 undefined。
 */
function llmText(raw: unknown): string {
    return typeof raw === "string"
        ? raw
        : (raw !== null && typeof raw === "object" && typeof (raw as { note?: unknown }).note === "string"
            ? (raw as { note: string }).note
            : JSON.stringify(raw));
}

/** architect_task 形制的 user 文本（decompose 与蓝图共用——同一形状同一话术） */
function taskUserText(requirement: string, projectId: string, taskId: string, feedback: string): string {
    return [
        `## 项目需求\n${requirement}`,
        `## 任务包身份\nprojectId: ${projectId}\ntaskId: ${taskId}`,
        feedback ? `## 上一版输出被拒，必须修正\n${feedback}` : "",
        feedback
            ? "请根据拒绝原因修正后，重新输出**完整**的任务包 JSON（不要只输出改动部分）。"
            : "请输出完整的任务包 JSON。",
    ].filter(Boolean).join("\n\n");
}

function trimRequirement(requirement: string): string {
    const r = requirement?.trim();
    if (!r) throw new Error("architectAgent：需求文本为空");
    return r;
}

/** 闸门判定：过 → 带出强类型产物；不过 → reason 就是喂回模型的拒绝原文 */
type Gate<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * 共享校验-重试循环（原 decompose :92-186 的循环+信封拆包+反馈环抽出来的）。
 * 只管循环骨架：user 文本、抠包后的闸门交给回调；
 * 反馈原文逐字喂回、budget 可见性（批 E 同款：让模型知道还剩几次机会，
 * 而不是盲重试）、耗尽抛错含最后一次原因——全部保持原行为。
 */
async function generateValidated<T>(
    llm: DeveloperLlm,
    maxAttempts: number,
    stage: string,
    s: {
        system: string;
        userFor: (attempt: number, feedback: string) => string;
        validate: (candidate: unknown) => Gate<T>;
    },
): Promise<{ value: T; attempts: number; rejections: string[] }> {
    const rejections: string[] = [];
    let feedback = "";

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const raw = await llm.next({
            system: s.system,
            task: s.userFor(attempt, feedback),
            skill: null, history: [], tools: [],
            // 架构师的"预算"= 剩余重试次数（批 E 预算可见性的同款用途）
            budget: { used: attempt - 1, total: maxAttempts },
        });

        // ① 信封拆包 + 抠 JSON（围栏/叙述都能处理；抠不出=原文交回当拒绝原因）
        const text = llmText(raw);
        let candidate: unknown;
        try {
            candidate = extractJson(text);
        } catch {
            candidate = null;
        }
        if (candidate === null || candidate === undefined) {
            feedback = `输出里找不到合法 JSON 对象。原文开头：${text.slice(0, 300)}`;
            rejections.push(feedback);
            continue;
        }

        // ② 权威字段闸（铁律：done/verified/exitCode 等只能由程序产生）
        try {
            assertNoAuthorityFields("architect 拆解", candidate);
        } catch (e) {
            feedback = `输出包含禁止的权威字段：${(e as Error).message}`;
            rejections.push(feedback);
            continue;
        }

        // ③~⑤ 形状 + 业务 + 入站终验（各阶段的闸门自己写）
        const verdict = s.validate(candidate);
        if (!verdict.ok) {
            feedback = verdict.reason;
            rejections.push(feedback);
            continue;
        }
        return { value: verdict.value, attempts: attempt, rejections };
    }

    throw new Error(
        `architectAgent：${stage} ${maxAttempts} 次全部被拒。最后一次原因：\n${rejections[rejections.length - 1] ?? "(无)"}`,
    );
}

/**
 * architect_task 形制产物的共享闸门链（③④⑤）：zod → 身份强制 → 业务硬闸 →
 * parseInbound 终验。decompose 与 decomposeBlueprint 唯一差异是 enforceCompileFloor
 * ——旧链路不查底线（保持 8 条存量测试的行为不变），蓝图链路查（提示词里
 * "每个被声明的 target 一条 COMPILE"的规矩从"求模型自觉"升级成代码事实）。
 */
function validateArchitectTask(
    candidate: unknown,
    projectId: string,
    taskId: string,
    enforceCompileFloor: boolean,
): Gate<ArchitectTask> {
    // ③ 形状校验（ArchitectTaskSchema，zod）
    let parsed: ArchitectTask;
    try {
        parsed = ArchitectTaskSchema.parse(candidate);
    } catch (e) {
        return { ok: false, reason: `任务包形状不对（zod 校验失败）：\n${zodIssuesSummary(e)}` };
    }

    // 身份字段强制覆盖（code-over-tools：projectId/taskId 是对号用的
    // 确定性管道信息，不赌模型照抄——prompt 里写了"照抄"只是减少返工，
    // 这里的覆盖才是保证；模型写错也不至于把账记串）。
    parsed.projectId = projectId;
    parsed.taskId = taskId;

    // ④ 业务硬闸：schema 合法但没法干活的空包提前拦
    const gaps: string[] = [];
    if (!parsed.foundationPlan.workItems || parsed.foundationPlan.workItems.length === 0) {
        gaps.push("foundationPlan.workItems 不能为空（必须显式给出工作项清单，不要留给目录推导）");
    }
    if (!parsed.foundationPlan.dirs || parsed.foundationPlan.dirs.length === 0) {
        gaps.push("foundationPlan.dirs 不能为空");
    }
    if (parsed.acceptanceChecks.length === 0) {
        gaps.push("acceptanceChecks 不能为空（验收判据是送检依据，一条都没有=没法验收）");
    }
    // 蓝图底线闸：allowedRoots 每个根都要有 ≥1 条 COMPILE（feedback 点名缺哪个根——
    // "数量与强度"的提示词规矩落成代码事实，弱模型漏一条也不会静默欠验收）
    if (enforceCompileFloor) {
        for (const root of parsed.allowedRoots) {
            const hasFloor = parsed.acceptanceChecks.some(
                (c) => String(c.kind ?? "").trim().toUpperCase() === "COMPILE"
                    && String(c.target ?? "").trim() === String(root).trim(),
            );
            if (!hasFloor) {
                gaps.push(`allowedRoots「${root}」缺全局 COMPILE 底线判据（至少 1 条 kind=COMPILE、target="${root}"）`);
            }
        }
    }
    if (gaps.length > 0) {
        return { ok: false, reason: `任务包业务不完整：\n${gaps.map((g) => `- ${g}`).join("\n")}` };
    }

    // ⑤ parseInbound 终验：与 runner --task 同链路（机器证据，不是"应该兼容"）
    const inbound = parseInbound(JSON.stringify(parsed));
    if (!inbound.ok) {
        return { ok: false, reason: `任务包未通过 runner 入站校验：${inbound.error}` };
    }
    return { ok: true, value: parsed };
}

/** 判据的 (method, path) 归一键：method 大小写宽容（verifier 也是 toUpperCase 后用的） */
function methodPathKey(method: unknown, pathValue: unknown): string {
    return `${String(method ?? "GET").trim().toUpperCase()} ${String(pathValue ?? "").trim()}`;
}

export function createArchitectAgent(o: ArchitectAgentOptions) {
    const maxAttempts = o.maxAttempts ?? 3;
    const promptDir = o.promptDir ?? DEFAULT_PROMPT_DIR;
    // 提示词从磁盘读（与 developerAgent 的 prompts/ 管理方式一致）；缺失 fail fast。
    // 三份都在构造期读——起工就验全，不留"跑到第二批才发现文件没部署"的后患。
    const systemTask = readPrompt(promptDir, ARCHITECT_PROMPT_FILE);
    const systemBlueprint = composePrompt(
        readPrompt(promptDir, ARCHITECT_BLUEPRINT_PROMPT_FILE),
        readPrompt(promptDir, ARCHITECT_CHECK_SHAPE_FILE),
    );
    const systemBatch = composePrompt(
        readPrompt(promptDir, ARCHITECT_BATCH_PROMPT_FILE),
        readPrompt(promptDir, ARCHITECT_CHECK_SHAPE_FILE),
    );

    return {
        /**
         * 【旧一步整包，兼容保留】需求文本 → ArchitectTask（全局+逐项一次吐完）。
         * runner.ts 还在调用；步骤 6 切两阶段管线后由 orchestrator 删除。
         * 校验不过把报错原文喂回重试，全败抛错（不静默）。
         */
        async decompose(input: DecomposeInput): Promise<DecomposeResult> {
            const requirement = trimRequirement(input.requirement);
            const projectId = input.projectId ?? "p1";
            const taskId = input.taskId ?? "t1";

            const r = await generateValidated<ArchitectTask>(o.llm, maxAttempts, "拆解", {
                system: systemTask,
                userFor: (_attempt, feedback) => taskUserText(requirement, projectId, taskId, feedback),
                validate: (candidate) => validateArchitectTask(candidate, projectId, taskId, false),
            });
            return { task: r.value, attempts: r.attempts, rejections: r.rejections };
        },

        /**
         * 蓝图拆解：需求原文 → architect_task 形制的**蓝图**（全局一次冻结）。
         * 闸门链在旧五道之上多一条"每个 allowedRoots ≥1 条 COMPILE 底线"；
         * 其余字段口径与 decompose 完全同形（同一 Schema、同一终验）。
         * 逐项 detail 与功能级判据**不在**产物里——那是批次的活。
         */
        async decomposeBlueprint(input: DecomposeBlueprintInput): Promise<BlueprintResult> {
            const requirement = trimRequirement(input.requirement);
            const projectId = input.projectId ?? "p1";
            const taskId = input.taskId ?? "t1";

            const r = await generateValidated<ArchitectTask>(o.llm, maxAttempts, "蓝图拆解", {
                system: systemBlueprint,
                userFor: (_attempt, feedback) => taskUserText(requirement, projectId, taskId, feedback),
                validate: (candidate) => validateArchitectTask(candidate, projectId, taskId, true),
            });
            return { task: r.value, attempts: r.attempts, rejections: r.rejections };
        },

        /**
         * 批次拆解：蓝图 + 一个目标工作项 → architect_batch（该项详规 + 该竖切判据）。
         * 闸门链（③④⑤ 的批次版）：
         *   ③ ArchitectBatchSchema.parse（detail 非空由 schema min(1) 保证）；
         *   ④ 业务硬闸：
         *      - backend/frontend/database 项 checks≥1（无判据的批=该项没被验收）；
         *        inspect/foundation/pre-test/failure 允许 0；
         *      - 判据 id 撞车（与已交付清单重复）拒——全局唯一是 hash/去重的前提；
         *      - CONTRACT 判据的 (method,path) 必须命中蓝图 contract.endpoints
         *        （拼写跑偏的判据会让 TestAgent 打空靶；蓝图没端点则跳过此闸）；
         *   ⑤ parseInbound 终验（architect_batch 已在 INBOUND_SCHEMAS 里，
         *      runner 走的就是这条入站口——同链路证据）。
         * 身份：itemId/projectId/taskId 由**代码强制**覆盖（镜像蓝图身份覆盖纪律——
         * prompt 要求照抄只为减少返工，不担保）；itemId 是否合法不在这里判——
         * 调用方从蓝图 workItems 里取项传进来，代码以入参 item.id 为准。
         */
        async decomposeBatch(input: DecomposeBatchInput): Promise<BatchResult> {
            const requirement = trimRequirement(input.requirement);
            const { blueprint, item } = input;
            const projectId = input.projectId ?? "p1";
            const taskId = input.taskId ?? "t1";
            const cap = input.maxAttempts ?? maxAttempts;
            const delivered = new Set(input.deliveredCheckIds ?? []);

            // 蓝图端点索引（contract.endpoints 是 unknown[]——严格读取，拼不出键的条目忽略）
            const endpointKeys = new Set<string>();
            for (const ep of Array.isArray(blueprint.contract?.endpoints) ? blueprint.contract.endpoints : []) {
                if (!ep || typeof ep !== "object") continue;
                const e = ep as { method?: unknown; path?: unknown };
                if (typeof e.path === "string" && e.path.trim()) {
                    endpointKeys.add(methodPathKey(e.method, e.path));
                }
            }

            const r = await generateValidated<ArchitectBatch>(o.llm, cap, `批次 ${item.id} 拆解`, {
                system: systemBatch,
                userFor: (_attempt, feedback) => [
                    `## 项目需求\n${requirement}`,
                    `## 蓝图（全局已冻结，只读参照，不得改动）\n${JSON.stringify(blueprint, null, 2)}`,
                    `## 目标工作项（本批只细化这一项，禁止增删工作项）\n${JSON.stringify(item, null, 2)}`,
                    `## 已交付判据 id 清单（新判据不许撞这些 id）\n${delivered.size > 0 ? [...delivered].join(", ") : "（无）"}`,
                    `## 任务包身份\nprojectId: ${projectId}\ntaskId: ${taskId}`,
                    feedback ? `## 上一版输出被拒，必须修正\n${feedback}` : "",
                    feedback
                        ? "请根据拒绝原因修正后，重新输出**完整**的批次 JSON（不要只输出改动部分）。"
                        : "请输出该工作项的完整批次 JSON。",
                ].filter(Boolean).join("\n\n"),
                validate: (candidate) => {
                    let parsed: ArchitectBatch;
                    try {
                        parsed = ArchitectBatchSchema.parse(candidate);
                    } catch (e) {
                        return { ok: false, reason: `批次形状不对（zod 校验失败）：\n${zodIssuesSummary(e)}` };
                    }

                    // 身份强制（code-over-tools，镜像蓝图）：itemId 以**入参工作项**为准，
                    // 模型抄错/抄串（把上一批的 itemId 又吐一遍）都不至于把账记歪。
                    parsed.projectId = projectId;
                    parsed.taskId = taskId;
                    parsed.itemId = item.id;

                    const gaps: string[] = [];
                    if (CHECK_REQUIRED_KINDS.has(item.kind) && parsed.checks.length === 0) {
                        gaps.push(`工作项 ${item.id}（kind=${item.kind}）是业务实现项，本批 checks 不能为空——无判据的批=该项没被验收`);
                    }
                    const collided = [...new Set(parsed.checks.map((c) => c.id).filter((id) => delivered.has(id)))];
                    if (collided.length > 0) {
                        gaps.push(`判据 id 撞车：${collided.join("、")} 已在前面交付，判据 id 必须全局唯一（换新 id 或删掉重复判据）`);
                    }
                    if (endpointKeys.size > 0) {
                        const offenders = parsed.checks.filter(
                            (c) => String(c.kind ?? "").trim().toUpperCase() === "CONTRACT"
                                && !endpointKeys.has(methodPathKey(c.method, c.path)),
                        );
                        if (offenders.length > 0) {
                            gaps.push(`以下 CONTRACT 判据的 (method, path) 没命中蓝图 contract.endpoints（拼写跑偏的判据会让 TestAgent 打空靶）：\n${offenders.map(
                                (c) => `- ${String(c.method ?? "GET").trim().toUpperCase()} ${typeof c.path === "string" && c.path.trim() ? c.path.trim() : "(缺 path)"}`,
                            ).join("\n")}`);
                        }
                    }
                    if (gaps.length > 0) {
                        return { ok: false, reason: `批次业务不完整：\n${gaps.map((g) => `- ${g}`).join("\n")}` };
                    }

                    const inbound = parseInbound(JSON.stringify(parsed));
                    if (!inbound.ok) {
                        return { ok: false, reason: `批次未通过 runner 入站校验：${inbound.error}` };
                    }
                    return { ok: true, value: parsed };
                },
            });
            return { batch: r.value, attempts: r.attempts, rejections: r.rejections };
        },
    };
}

/**
 * 确定性装配：蓝图 + 按序批次 → 完整 ArchitectTask（审计产物 / _tasks 落盘用）。
 * 纯函数，不碰 fs（runner 侧重写 _tasks/<runId>.json 也走这里）。
 *
 *   合并规则：
 *   · detail 写进匹配 id 的 workItem（批次只细化本项——这是批次的全部职权）；
 *   · acceptanceChecks = 蓝图底线在前、各批判据按**交付顺序**追加，按 id 去重
 *     （first-wins：蓝图的底线判据永远赢过批次想复用的同款 id）；
 *   · 批次序列必须是蓝图工作项**顺序的前缀**（拆出一个推一个的推送语义在
 *     数据面上的等价校验：跳批/重批/超批都抛错——到这里还不齐就是链路 bug，
 *     不是"还没到"）；身份（projectId/taskId）也必须与蓝图一致，账不能记串。
 *   · 产物必须过 parseInbound（它是 architect_task；机器证据，不是"应该兼容"）。
 */
export function assembleTask(blueprint: ArchitectTask, batches: readonly ArchitectBatch[]): ArchitectTask {
    const planIds = (blueprint.foundationPlan.workItems ?? []).map((w) => w.id);

    const detailById = new Map<string, string>();
    const merged = [...blueprint.acceptanceChecks];
    const seen = new Set(blueprint.acceptanceChecks.map((c) => c.id));

    let cursor = 0;
    for (const b of batches) {
        if (b.projectId !== blueprint.projectId || b.taskId !== blueprint.taskId) {
            throw new Error(
                `assembleTask：批次 ${b.itemId} 身份与蓝图不符（${b.projectId}/${b.taskId} ≠ ${blueprint.projectId}/${blueprint.taskId}）`,
            );
        }
        const expected = planIds[cursor];
        if (b.itemId !== expected) {
            throw new Error(
                `assembleTask：批次顺序违反蓝图——第 ${cursor + 1} 批期望 ${expected ?? "(蓝图已到末尾，不再接受批次)"}，实际 ${b.itemId}`,
            );
        }
        cursor++;
        detailById.set(b.itemId, b.detail);
        for (const c of b.checks) {
            if (!seen.has(c.id)) {
                seen.add(c.id);
                merged.push(c);
            }
        }
    }

    // 克隆合并，不污染入参（blueprint 可能还被调用方攥着继续喂 batch）
    const task: ArchitectTask = {
        ...blueprint,
        foundationPlan: {
            ...blueprint.foundationPlan,
            workItems: (blueprint.foundationPlan.workItems ?? []).map(
                (w) => (detailById.has(w.id) ? { ...w, detail: detailById.get(w.id)! } : { ...w }),
            ),
        },
        acceptanceChecks: merged,
    };

    const inbound = parseInbound(JSON.stringify(task));
    if (!inbound.ok) {
        throw new Error(`assembleTask：装配产物未过入站校验：${inbound.error}`);
    }
    return task;
}
