// ============================================================
// architectTaskBuilder.ts —— ArchitectTask 的**唯一**生产者（正式流程入口）
//
//   在这之前，architect_task 只有消费侧（developerAgent 收），没有生产侧：
//   正式流程唯一能跑的方式是**人**手写一份 JSON 喂给 Developer。
//   本模块把「PM 结构化需求 + Architect LLM 的语义输出」机械装配成一份
//   Developer 能直接接收的 ArchitectTask，并负责校验、指纹与 Hub 派发。
//
//   ── 职责切分（铁律，别混）──
//   LLM 只填**业务语义**：目标 / 功能 / 技术栈选择 / 实体 / 接口语义 / 页面语义 /
//                        工作项 / 约束与风险。
//   程序只填**机械字段**：projectId / taskId / allowedRoots / forbiddenPaths /
//                        packageHash / source / 时间 / 权限字段。
//   LLM 输出里出现 done / verified / status / evidence / exitCode 等权威字段 → 直接拒收。
//
//   ── 刻意**不**做的事（先收缩，不要扩建）──
//   · 不为任何技术栈写 bootstrap / 验证器 / 模板 / 套餐；
//   · 不为任何技术栈预写命令：验收项只声明**意图**（kind + target + expected），
//     真正的命令由 TestAgent 在验收时**读工程文件**解析（resolveGenericCommand）；
//   · 技术栈在 catalog 里匹配不上**不是错误**：置 stackAssetMatched=false，
//     任务照常下发，Developer 用文件工具 + Shell 自行完成；
//   · 不引入新协议 / 新状态机 / 新服务——派发只是往现有 Hub 里塞一条消息。
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { TransferStation } from "./Hub";
import { DeveloperLedger, ensureDir, hashOf } from "./developerAgent/ledger";
import {
    ArchitectBatchSchema, ArchitectTaskSchema, WorkItemKindSchema,
    canonicalJson, findAuthorityFields,
} from "./developerAgent/protocol";
import type { ArchitectBatch, ArchitectTask } from "./developerAgent/protocol";
import { createArchitectAgent } from "./developerAgent/architectAgent";
import type { DeveloperLlm } from "./developerAgent/graph";

// ============================================================
// 一、LLM 语义输出的 Schema（strict：不收未知关键字段）
// ============================================================

export const ArchitectSemanticsSchema = z.strictObject({
    /** 需求目标（PM 收敛后的业务目标，一句话） */
    goal: z.string().min(1),
    /** 功能模块清单——空列表不接受 */
    features: z.array(z.object({
        name: z.string().min(1),
        description: z.string().min(1),
    })).min(1),
    /** 技术栈选择：只能写 catalog 里的资产名（或自成体系的名字，后者只会让 stackAssetMatched=false） */
    stack: z.object({
        frontend: z.string().min(1),
        backend: z.string().min(1),
        database: z.string().min(1).optional(),
        why: z.string().min(1),
    }),
    /** 数据实体（至少一个） */
    entities: z.array(z.object({
        entity: z.string().min(1),
        table: z.string().optional(),
        fields: z.array(z.object({
            name: z.string().min(1),
            type: z.string().min(1),
            required: z.boolean().optional(),
            remark: z.string().optional(),
        })).optional(),
    })).min(1),
    /** 接口语义（至少一个）——expectedStatus 是"什么算通过"的语义，不是命令 */
    endpoints: z.array(z.object({
        method: z.string().min(1),
        path: z.string().min(1),
        purpose: z.string().min(1),
        response: z.string().optional(),
        expectedStatus: z.number().int().optional(),
        // 9/13 ts-site-v2：通用 HTTP 契约执行器（live/hubTestEngineer.ts）的声明通道，
        // 全部**可选**，缺省行为与旧语义完全一致（旧任务包/旧测试零感知）。
        /** 请求体（JSON 可序列化值）；不传 = 无 body */
        body: z.unknown().optional(),
        /** 响应正文关键字断言（包含即过） */
        expectBodyContains: z.string().min(1).optional(),
        /** 登录前置：先打这个接口拿 token，再以 Bearer 发本检查——鉴权契约可机械验收 */
        auth: z.object({
            method: z.string().min(1),
            path: z.string().min(1),
            body: z.unknown().optional(),
        }).optional(),
        /** 同一 method+path 需要多条判据（如 401 与 200 各一条）时区隔 id，避免撞名 */
        variant: z.string().min(1).optional(),
    })).min(1),
    /** 页面语义（至少一个） */
    pages: z.array(z.object({
        path: z.string().min(1),
        purpose: z.string().min(1),
    })).min(1),
    /** 工作项（按执行顺序）——不给"目录空不空"留猜的余地 */
    workItems: z.array(z.object({
        id: z.string().min(1),
        kind: WorkItemKindSchema,
        title: z.string().optional(),
        paths: z.array(z.string()).optional(),
    })).min(1),
    /** 约束与顺序（写给 Developer 的短说明，不写文件清单、不写命令） */
    instructions: z.string().min(1),
    /** 风险 */
    risks: z.array(z.string()),
});

export type ArchitectSemantics = z.infer<typeof ArchitectSemanticsSchema>;

// ============================================================
// 二、LLM 输出解析（只吃 JSON；不吃 Markdown / 解释文字 / 权威字段）
// ============================================================

export type ArchitectParseCode =
    | "ARCHITECT_INVALID_JSON"
    | "ARCHITECT_SCHEMA_INVALID"
    | "ARCHITECT_AUTHORITY_FIELD";

export interface ArchitectParseFailure {
    ok: false;
    code: ArchitectParseCode;
    /** 机器可读的错误位置（重试 Prompt 只用它，不再重发无关上下文） */
    issues: string[];
    /** 原样留存的模型输出（截断），供账本/报告追溯 */
    raw: string;
}

export interface ArchitectParseSuccess { ok: true; value: ArchitectSemantics }

export type ArchitectParseResult = ArchitectParseSuccess | ArchitectParseFailure;

/** 去掉 ```json 围栏；只接受"整段就是一个 JSON"，前面有解释文字也算失败 */
function extractJson(text: string): string | null {
    const trimmed = text.trim();
    if (!trimmed) return null;
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    const body = fenced?.[1] ?? trimmed;
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    // 只有 JSON 本体允许出现在花括号之外（空白），否则视为夹带解释文字
    const outside = body.slice(0, start) + body.slice(end + 1);
    if (outside.trim().length > 0) return null;
    return body.slice(start, end + 1);
}

/**
 * 解析 Architect LLM 输出。任何一步不过都返回结构化失败——
 * 调用方**必须**在此处停下，不允许把半成品推给 Developer。
 */
export function parseArchitectSemantics(raw: unknown): ArchitectParseResult {
    const text = typeof raw === "string" ? raw : JSON.stringify(raw ?? null);
    const json = typeof raw === "string" ? extractJson(raw) : text;
    if (json === null) {
        return {
            ok: false, code: "ARCHITECT_INVALID_JSON",
            issues: ["输出不是纯 JSON（不接受 Markdown 说明或解释文字）"],
            raw: text.slice(0, 2000),
        };
    }
    let value: unknown;
    try {
        value = JSON.parse(json);
    } catch (e) {
        return {
            ok: false, code: "ARCHITECT_INVALID_JSON",
            issues: [`JSON 解析失败：${(e as Error).message}`],
            raw: text.slice(0, 2000),
        };
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return {
            ok: false, code: "ARCHITECT_INVALID_JSON",
            issues: ["JSON 顶层必须是对象"],
            raw: text.slice(0, 2000),
        };
    }

    // 权威字段禁令先于形状校验：模型碰了这些词就不该继续往下走
    const authority = findAuthorityFields(value);
    if (authority.length > 0) {
        return {
            ok: false, code: "ARCHITECT_AUTHORITY_FIELD",
            issues: authority.map((p) => `权威字段只能由程序产生，LLM 输出里不许出现：${p}`),
            raw: text.slice(0, 2000),
        };
    }

    const parsed = ArchitectSemanticsSchema.safeParse(value);
    if (!parsed.success) {
        return {
            ok: false, code: "ARCHITECT_SCHEMA_INVALID",
            issues: parsed.error.issues.map((i) => `${i.path.join(".") || "$"}: ${i.message}`),
            raw: text.slice(0, 2000),
        };
    }
    return { ok: true, value: parsed.data };
}

/** 重试 Prompt：**只**带错误位置，不重发无关上下文 */
export function retryPromptFor(failure: ArchitectParseFailure): string {
    return [
        "上一次输出不合格，只有下面这些问题需要修：",
        ...failure.issues.slice(0, 20).map((i) => `- ${i}`),
        "",
        "请只输出修正后的完整 JSON，不要解释、不要 Markdown。",
    ].join("\n");
}

export interface CollectResult {
    ok: boolean;
    semantics?: ArchitectSemantics;
    failure?: ArchitectParseFailure;
    attempts: number;
    /** 每次失败的重试 Prompt（审计用） */
    retryPrompts: string[];
}

/**
 * 有限重试地收语义输出。`call` 由调用方注入（真实 LLM / Fake LLM），
 * 本函数不做任何网络访问——所以它可以被零 LLM 测试完整覆盖。
 */
export async function collectArchitectSemantics(o: {
    call: (retryPrompt: string | null) => Promise<unknown>;
    maxAttempts?: number;
}): Promise<CollectResult> {
    const maxAttempts = Math.max(1, o.maxAttempts ?? 2);
    const retryPrompts: string[] = [];
    let failure: ArchitectParseFailure | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const raw = await o.call(attempt === 1 ? null : retryPrompts[retryPrompts.length - 1] ?? null);
        const parsed = parseArchitectSemantics(raw);
        if (parsed.ok) {
            return { ok: true, semantics: parsed.value, attempts: attempt, retryPrompts };
        }
        failure = parsed;
        retryPrompts.push(retryPromptFor(parsed));
    }
    return { ok: false, ...(failure ? { failure } : {}), attempts: maxAttempts, retryPrompts };
}

// ============================================================
// 三、技术栈与 catalog 的匹配（匹配不上**不是错误**）
// ============================================================

export interface AssetEntry { id: string; kind: string; version: string; path: string; summary: string }

/** 归一化：只留字母数字，好让 "Spring Boot 3" 能对上 id "springboot" */
function norm(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function loadAssetCatalog(file?: string): AssetEntry[] {
    const target = file ?? path.resolve(import.meta.dir, "developerAgent/assets/catalog.json");
    try {
        const parsed = JSON.parse(fs.readFileSync(target, "utf-8")) as { assets?: AssetEntry[] };
        return parsed.assets ?? [];
    } catch {
        return [];
    }
}

/**
 * 用 catalog 校验技术栈选择。
 *   命中 → 记下 asset id/version；
 *   **没命中 → 不报错、不替换**（尤其不许偷偷换成 Spring Boot），只把 stackAssetMatched 置 false。
 */
export function matchStackAssets(
    stack: ArchitectSemantics["stack"], catalog: readonly AssetEntry[],
): {
    stackAssetMatched: boolean;
    matched: { slot: string; chosen: string; assetId: string | null; kindOk: boolean }[];
    notes: string[];
} {
    const slots: { slot: string; chosen: string | undefined; wantKind: string }[] = [
        { slot: "frontend", chosen: stack.frontend, wantKind: "frontend" },
        { slot: "backend", chosen: stack.backend, wantKind: "backend" },
        { slot: "database", chosen: stack.database, wantKind: "database" },
    ];
    const matched: { slot: string; chosen: string; assetId: string | null; kindOk: boolean }[] = [];
    const notes: string[] = [];

    for (const s of slots) {
        if (!s.chosen) continue;
        const n = norm(s.chosen);
        const hit = catalog.find((a) => n.includes(norm(a.id)));
        if (!hit) {
            matched.push({ slot: s.slot, chosen: s.chosen, assetId: null, kindOk: false });
            notes.push(`${s.slot}「${s.chosen}」不在 assets/catalog.json 里——不阻止任务，Developer 自行读工程文件用 Shell 完成`);
            continue;
        }
        const kindOk = hit.kind === s.wantKind;
        matched.push({ slot: s.slot, chosen: s.chosen, assetId: hit.id, kindOk });
        if (!kindOk) {
            notes.push(`${s.slot}「${s.chosen}」命中的资产 ${hit.id} 的 kind 是 ${hit.kind}，与槽位不符（仅记录，不阻止）`);
        }
    }
    return {
        // ★ 匹配 = 「命中了资产」**且**「资产的 kind 与槽位相符」。
        //   只判 assetId 非空是不够的：把 springboot 填进 frontend 槽位同样能命中 id，
        //   那种情况下技术栈其实是错配的，不能算 matched=true。
        stackAssetMatched: matched.length > 0 && matched.every((m) => m.assetId !== null && m.kindOk),
        matched,
        notes,
    };
}

// ============================================================
// 四、验收项 = **意图**（命令留给 TestAgent 按工程文件解析）
// ============================================================

export interface AcceptanceIntent {
    id: string;
    kind: "COMPILE" | "CONTRACT";
    /** COMPILE：要构建的目录（相对 projectDir） */
    target?: string;
    /** COMPILE：判据，固定 exitCode=0 */
    expected?: string;
    /** CONTRACT：接口语义 */
    method?: string;
    path?: string;
    expectedStatus?: number;
    note?: string;
    /** CONTRACT 可选扩展（通用 HTTP 执行器消费；见 live/hubTestEngineer.ts） */
    body?: unknown;
    expectBodyContains?: string;
    auth?: { method: string; path: string; body?: unknown };
}

/** Developer 可写的根目录（程序定，不由 LLM 决定） */
export const DEFAULT_ALLOWED_ROOTS: readonly string[] = ["frontend", "backend"];

/**
 * 引擎预置的构建工具链：属于"本机没有又无法自举"的东西（如 Maven Wrapper），
 * 由引擎放置，Developer 不得改写。这是一张静态路径表，**不是**框架适配层。
 */
export const DEFAULT_FORBIDDEN_PATHS: readonly string[] = [
    "backend/mvnw", "backend/mvnw.cmd", "backend/.mvn",
    "backend/gradlew", "backend/gradlew.bat", "backend/gradle",
];

/** 机械生成验收意图：编译按目录，契约按接口端点。命令一个都不写。 */
export function deriveAcceptanceIntents(
    semantics: ArchitectSemantics, allowedRoots: readonly string[],
): AcceptanceIntent[] {
    const intents: AcceptanceIntent[] = [];
    for (const dir of allowedRoots) {
        intents.push({
            id: `compile:${dir}`,
            kind: "COMPILE",
            target: dir,
            expected: "exitCode=0",
            note: "命令由 TestAgent 读该目录的工程文件（mvnw / gradlew / package.json / pyproject / go.mod）解析",
        });
    }
    for (const ep of semantics.endpoints) {
        const intent: AcceptanceIntent = {
            // variant：同一 method+path 的多条判据（如登录 200 与错密码 401）靠它区隔 id，不撞名
            id: `http:${ep.method.toUpperCase()}:${ep.path}${ep.variant ? `#${ep.variant}` : ""}`,
            kind: "CONTRACT",
            method: ep.method.toUpperCase(),
            path: ep.path,
            expectedStatus: ep.expectedStatus ?? 200,
            note: ep.purpose,
        };
        if (ep.body !== undefined) intent.body = ep.body;
        if (ep.expectBodyContains) intent.expectBodyContains = ep.expectBodyContains;
        if (ep.auth) intent.auth = { ...ep.auth };
        intents.push(intent);
    }
    return intents;
}

// ============================================================
// 五、命令解析：**按工程文件，不按框架**
//
//   9/13：实现搬到 developerAgent/tools/projectCommands.ts——本地自检门禁与
//   TestAgent 验收共用**同一个**解析器（共享识别，不共享权限与裁决）。
//   这里保留同名导出，下游（live/verifier.ts、测试）无感。
// ============================================================

import { resolveProjectCommand } from "./developerAgent/tools/projectCommands";

export type ResolvedCommand = {
    command: string;
    args: string[];
    /** 依据哪个工程文件解析出来的（写进证据，便于审计） */
    detectedBy: string;
};

/** @deprecated 直接用 developerAgent/tools/projectCommands.ts 的 resolveProjectCommand；本别名仅为兼容旧调用点 */
export function resolveGenericCommand(dirAbs: string, o: { isWin?: boolean } = {}): ResolvedCommand | null {
    return resolveProjectCommand(dirAbs, o);
}

// ============================================================
// 五之二、PM 功能清单对账（**机械**，不靠模型自觉）
//
//   为什么必须有：Architect LLM 完全可能"只挑了它觉得重要的两条"，
//   把 PM 明确列出的功能悄悄丢掉，而下游谁都不会发现。
//   所以派发前做一次机械对账：**本阶段要求的 PM 功能必须一条不漏地出现在语义里**，
//   漏一个就拒绝派发（ARCHITECT_FEATURE_MISMATCH），而不是让 Developer 少做一个模块。
// ============================================================

/** 归一化比较：忽略大小写与空白/标点，并允许包含关系（"便签管理" vs "便签管理模块"） */
function looseFeatureEq(a: string, b: string): boolean {
    const norm = (s: string): string => s.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
    const x = norm(a);
    const y = norm(b);
    if (x.length === 0 || y.length === 0) return false;
    return x === y || x.includes(y) || y.includes(x);
}

/** 本阶段要求的 PM 功能名：优先取阶段声明的 features，缺省退回 PM 全量 features */
export function requiredFeatures(pmPlan: PmPlanLike, phase: number): string[] {
    const fromPhase = pmPlan.phases.find((p) => p.phase === phase)?.features ?? [];
    if (fromPhase.length > 0) return [...fromPhase];
    return pmPlan.features.map((f) => f.name);
}

/** 机械对账：哪些 PM 功能在 Architect 语义里**完全找不到** */
export function reconcileFeatures(o: {
    pmPlan: PmPlanLike;
    phase: number;
    semanticsFeatures: readonly { name: string }[];
}): { required: string[]; matched: string[]; missing: string[] } {
    const required = requiredFeatures(o.pmPlan, o.phase);
    const names = o.semanticsFeatures.map((f) => f.name);
    const matched: string[] = [];
    const missing: string[] = [];
    for (const r of required) {
        if (names.some((n) => looseFeatureEq(n, r))) matched.push(r);
        else missing.push(r);
    }
    return { required, matched, missing };
}

// ============================================================
// 六、装配 ArchitectTask（纯函数，无 IO）
// ============================================================

/** PM 侧的结构化需求（只取用得上的字段，避免 import manager.ts 拖进重依赖） */
export interface PmPlanLike {
    project: string;
    features: { name: string; description: string; priority?: string; acceptance?: string }[];
    phases: { phase: number; name: string; goal: string; features?: string[] }[];
    mvp_scope?: string[];
    risks?: string[];
}

export type BuildCode = "ARCHITECT_SCHEMA_INVALID" | "ARCHITECT_PACKAGE_INVALID" | "ARCHITECT_FEATURE_MISMATCH";

export interface BuildOutcome {
    ok: boolean;
    code?: BuildCode;
    issues: string[];
    task?: ArchitectTask;
    /** 任务包指纹（同一输入必须稳定） */
    packageHash?: string;
    stackAssetMatched: boolean;
    /** 技术栈匹配的逐槽位结果（含未命中原因） */
    stackMatch: { slot: string; chosen: string; assetId: string | null; kindOk: boolean }[];
    notes: string[];
    acceptanceIntents: AcceptanceIntent[];
}

/** 不参与指纹的易变字段（时间在装配时写入，但不进 hash） */
function stableForHash(task: Omit<ArchitectTask, "type">): unknown {
    return task;
}

/**
 * 把「PM 结构化需求 + Architect 语义」装配成 ArchitectTask。
 * 所有机械字段（id / 权限 / 指纹 / 时间）都在这里产生；LLM 一个都碰不到。
 */
export function buildArchitectTaskFromPlan(o: {
    pmPlan: PmPlanLike;
    semantics: ArchitectSemantics;
    projectId: string;
    /** 阶段号（默认取 PM 第一个阶段） */
    phase?: number;
    catalog?: readonly AssetEntry[];
    allowedRoots?: readonly string[];
    forbiddenPaths?: readonly string[];
}): BuildOutcome {
    const issues: string[] = [];
    const notes: string[] = [];

    // ① 语义本身再过一次 schema（调用方可能直接传对象，不是走 parseArchitectSemantics）
    const semParsed = ArchitectSemanticsSchema.safeParse(o.semantics);
    if (!semParsed.success) {
        return {
            ok: false, code: "ARCHITECT_SCHEMA_INVALID",
            issues: semParsed.error.issues.map((i) => `${i.path.join(".") || "$"}: ${i.message}`),
            stackAssetMatched: false, stackMatch: [], notes, acceptanceIntents: [],
        };
    }
    const sem = semParsed.data;

    // ② 技术栈匹配 catalog（匹配不上不报错）
    const catalog = o.catalog ?? loadAssetCatalog();
    const stackMatch = matchStackAssets(sem.stack, catalog);
    notes.push(...stackMatch.notes);

    const phase = o.phase ?? o.pmPlan.phases[0]?.phase ?? 1;

    // ③ ★ 机械对账 PM 功能清单：漏一个就**拒绝派发**（不许悄悄少做一个模块）
    const rec = reconcileFeatures({ pmPlan: o.pmPlan, phase, semanticsFeatures: sem.features });
    if (rec.missing.length > 0) {
        return {
            ok: false, code: "ARCHITECT_FEATURE_MISMATCH",
            issues: [
                `Architect 语义漏掉了 PM 明确要求的功能：${rec.missing.join("、")}`
                + `（本阶段要求 ${rec.required.join("、")}，语义只给了 ${sem.features.map((f) => f.name).join("、")}）`,
            ],
            stackAssetMatched: stackMatch.stackAssetMatched, stackMatch: stackMatch.matched,
            notes, acceptanceIntents: [],
        };
    }

    // ④ 机械字段
    const allowedRoots = [...(o.allowedRoots ?? DEFAULT_ALLOWED_ROOTS)];
    const forbiddenPaths = [...(o.forbiddenPaths ?? DEFAULT_FORBIDDEN_PATHS)];
    const acceptanceIntents = deriveAcceptanceIntents(sem, allowedRoots);
    const acceptanceChecks = acceptanceIntents.map((x) => ({ ...x }));

    // ④ PM 侧的功能清单作为兜底：LLM 若把 features 写窄了，这里保留 PM 的原始条目
    const features = sem.features.map((f) => ({ name: f.name, description: f.description }));
    if (features.length === 0) issues.push("功能列表为空——不接受");

    const taskId = `${o.projectId}-p${phase}`;
    const requirementSnapshot = {
        goal: sem.goal,
        features,
        phase,
        // PM 侧原文一并保留，便于追溯"需求是怎么被收敛的"
        pmPhases: o.pmPlan.phases.map((p) => ({ phase: p.phase, name: p.name, goal: p.goal })),
    };
    const domainModel = {
        entity: sem.entities[0]!.entity,
        entities: sem.entities,
    };
    const contract = {
        version: "1",
        endpoints: sem.endpoints.map((e) => ({
            method: e.method.toUpperCase(),
            path: e.path,
            purpose: e.purpose,
            ...(e.response ? { response: e.response } : {}),
            expectedStatus: e.expectedStatus ?? 200,
            // 验收判据对 Developer 透明：body/关键字断言/登录前置原样带出，不搞黑箱
            ...(e.body !== undefined ? { body: e.body } : {}),
            ...(e.expectBodyContains ? { expectBodyContains: e.expectBodyContains } : {}),
            ...(e.auth ? { auth: { ...e.auth } } : {}),
        })),
        pages: sem.pages,
    };
    const foundationPlan = {
        dirs: allowedRoots,
        workItems: sem.workItems,
    };

    const task: ArchitectTask = {
        type: "architect_task",
        projectId: o.projectId,
        taskId,
        requirementSnapshot,
        stackProfile: {
            frontend: sem.stack.frontend,
            backend: sem.stack.backend,
            ...(sem.stack.database ? { database: sem.stack.database } : {}),
            why: sem.stack.why,
        },
        domainModel,
        contract,
        foundationPlan,
        allowedRoots,
        forbiddenPaths,
        acceptanceChecks,
        developerInstructions: sem.instructions,
    } as ArchitectTask;

    // ⑤ 自己先过一遍 Developer 的权威 schema —— 过不了的包**不许**派发
    const pkgParsed = ArchitectTaskSchema.safeParse(task);
    if (!pkgParsed.success) {
        return {
            ok: false, code: "ARCHITECT_PACKAGE_INVALID",
            issues: pkgParsed.error.issues.map((i) => `${i.path.join(".") || "$"}: ${i.message}`),
            stackAssetMatched: stackMatch.stackAssetMatched, stackMatch: stackMatch.matched,
            notes, acceptanceIntents,
        };
    }
    if (issues.length > 0) {
        return {
            ok: false, code: "ARCHITECT_SCHEMA_INVALID", issues,
            stackAssetMatched: stackMatch.stackAssetMatched, stackMatch: stackMatch.matched,
            notes, acceptanceIntents,
        };
    }

    const finalTask = pkgParsed.data as ArchitectTask;
    return {
        ok: true,
        issues: [],
        task: finalTask,
        packageHash: hashOf(stableForHash(finalTask as unknown as Omit<ArchitectTask, "type">)),
        stackAssetMatched: stackMatch.stackAssetMatched,
        stackMatch: stackMatch.matched,
        notes,
        acceptanceIntents,
    };
}

// ============================================================
// 七、派发（走现有 Hub，幂等；不新增服务）
// ============================================================

export type ArchEventType =
    | "package_created" | "package_validated" | "package_dispatched"
    | "package_rejected" | "package_failed"
    // 两阶段派发（9/15，见第十节）：蓝图/逐批各自的账本事件
    | "blueprint_replayed" | "blueprint_dispatched"
    | "batch_replayed" | "batch_dispatched"
    | "dispatch_deduped" | "dispatch_cancelled" | "dispatch_failed" | "dispatch_completed";

export interface ArchEvent {
    type: ArchEventType;
    taskId?: string;
    packageHash?: string;
    detail?: Record<string, unknown>;
    at: number;
}

export interface DispatchOutcome {
    dispatched: boolean;
    reason?: string;
    state?: "wake" | "queued";
    key: string;
}

/** 幂等键：同一个 taskId + packageHash 只许派发一次 */
export function dispatchKeyOf(taskId: string, packageHash: string): string {
    return `${taskId}:${packageHash}`;
}

/**
 * 把任务包塞进现有 Hub。发送方/接收方名字由调用方给（默认 architect → developer）。
 * 幂等靠调用方提供的 isDuplicate/markDispatched；**默认实现是持久化 Ledger**
 * （createLedgerDispatchRegistry）——同一 taskId+packageHash 跨进程、跨重启都不重复派发。
 */
export function dispatchArchitectTask(o: {
    station: TransferStation;
    task: ArchitectTask;
    packageHash: string;
    sender?: string;
    receiver?: string;
    isDuplicate?: (key: string) => boolean;
    markDispatched?: (key: string, task: ArchitectTask, hash: string) => void;
    onEvent?: (ev: ArchEvent) => void;
}): DispatchOutcome {
    const sender = o.sender ?? "architect";
    const receiver = o.receiver ?? "developer";
    const key = dispatchKeyOf(o.task.taskId, o.packageHash);
    const emit = (type: ArchEventType, detail?: Record<string, unknown>): void =>
        o.onEvent?.({ type, taskId: o.task.taskId, packageHash: o.packageHash, ...(detail ? { detail } : {}), at: Date.now() });

    if (o.isDuplicate?.(key)) {
        emit("package_rejected", { reason: "duplicate", key });
        return { dispatched: false, reason: `重复派发被拦：${key}`, key };
    }
    try {
        const state = o.station.sendMessage(sender, receiver, JSON.stringify(o.task));
        o.markDispatched?.(key, o.task, o.packageHash);
        emit("package_dispatched", { sender, receiver, state, key });
        return { dispatched: true, state, key };
    } catch (e) {
        emit("package_failed", { error: (e as Error).message, key });
        return { dispatched: false, reason: `派发失败：${(e as Error).message}`, key };
    }
}

/** 派发幂等表的最小接口（持久实现、临时实现都满足它） */
export interface DispatchRegistry {
    isDuplicate: (key: string) => boolean;
    markDispatched: (key: string) => void;
}

/** 持久幂等表：复用 Developer Ledger 的 seen_message 表（**不新增存储**，同一份真相） */
export interface DispatchLedgerLike {
    hasSeen(msgKey: string): boolean;
    markSeen(msgKey: string): boolean;
}

/** 派发幂等账本用固定 runKey：同一份 dispatch 账本跨进程共享 */
export const DISPATCH_LEDGER_RUN_KEY = "architect:dispatch";

/** 默认派发账本落盘位置（仓库根 .runs/_architect/dispatch.db；.runs/ 已 gitignore） */
export function defaultDispatchLedgerPath(): string {
    return path.resolve(import.meta.dir, "..", ".runs", "_architect", "dispatch.db");
}

/**
 * 默认幂等实现：**持久化 Ledger**。
 * 每次 createArchitectTask 新建内存 Set 的做法是错的——进程重启即失忆，
 * 同一个任务包会被再派一次；这里改成读同一个账本文件。
 */
export function createLedgerDispatchRegistry(ledger: DispatchLedgerLike): DispatchRegistry {
    const keyOf = (key: string): string => `dispatch:${key}`;
    return {
        isDuplicate: (key) => ledger.hasSeen(keyOf(key)),
        markDispatched: (key) => { ledger.markSeen(keyOf(key)); },
    };
}

/** 打开默认持久幂等表（不传路径则用 defaultDispatchLedgerPath()） */
export function openDispatchRegistry(ledgerPath?: string): { registry: DispatchRegistry; close: () => void } {
    const file = ledgerPath ?? defaultDispatchLedgerPath();
    ensureDir(path.dirname(file));
    const ledger = DeveloperLedger.open(file, DISPATCH_LEDGER_RUN_KEY);
    return { registry: createLedgerDispatchRegistry(ledger), close: () => ledger.close() };
}

/**
 * 内存幂等表：**仅限单次调用内部的临时场景与测试显式注入**。
 * 不要拿它当默认——它一重启就失忆。默认走 openDispatchRegistry()。
 */
export function createMemoryDispatchRegistry(): DispatchRegistry {
    const seen = new Set<string>();
    return {
        isDuplicate: (key) => seen.has(key),
        markDispatched: (key) => { seen.add(key); },
    };
}

// ============================================================
// 九、旧 Architect 的已有产出 → 语义（供新默认派发路径使用）
//
//   刻意**不新增 LLM 调用**：detailedPlan / stack / resolution 本来就是 Architect
//   三个 LLM 节点产出的**语义**，这里只做形状搬运（一个字段都不发明），
//   搬完仍要过 parseArchitectSemantics 的严格校验——校验不过就 ARCHITECT_FAILED，
//   Developer 什么都收不到。
//   空缺就用空数组/空串如实表达，让校验去拒绝，而不是在这里补一个"看起来对"的值。
// ============================================================

export interface ArchitectPlanInputs {
    plan: { phases?: { phase: number; name?: string; goal?: string; features?: string[] }[] };
    detailedPlan: {
        summary: string;
        modules: { name: string; business?: string; description?: string }[];
        risks?: string[];
    };
    stack: {
        techniques: { database: { type: string; why?: string } };
        tables: {
            name: string; purpose?: string;
            fields: { name: string; type: string; required?: boolean; remark?: string }[];
        }[];
        moduleTech: { module: string; backend: string; frontend: string }[];
        why: string;
    };
    /** resolutionSchema 的 tasks：每项是 [后端切片, 前端切片] */
    resolution: readonly (readonly [
        { feature?: string; apis: { method: string; path: string; purpose: string; response?: string }[] },
        { feature?: string; pages: { page: string; interactions: string }[] },
    ])[];
}

/** 保序去重（空串丢掉） */
function uniqNonEmpty(values: readonly (string | undefined)[]): string[] {
    const out: string[] = [];
    for (const v of values) {
        const s = (v ?? "").trim();
        if (s && !out.includes(s)) out.push(s);
    }
    return out;
}

/** 把 Architect 已有的结构化产出搬成「语义」形状（结果**必须**再过严格校验才能派发） */
export function architectSemanticsFromPlan(inputs: ArchitectPlanInputs): unknown {
    const d = inputs.detailedPlan;
    const s = inputs.stack;

    // 功能：模块的 business 就是 PM 功能名（旧 dispatch 也是这么用的）
    const seen = new Set<string>();
    const features: { name: string; description: string }[] = [];
    for (const m of d.modules ?? []) {
        const name = (m.business ?? "").trim() || (m.name ?? "").trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        features.push({ name, description: (m.description ?? "").trim() || name });
    }

    const frontend = uniqNonEmpty((s.moduleTech ?? []).map((m) => m.frontend));
    const backend = uniqNonEmpty((s.moduleTech ?? []).map((m) => m.backend));
    const database = (s.techniques?.database?.type ?? "").trim();

    const apis = (inputs.resolution ?? []).flatMap((pair) => pair[0]?.apis ?? []);
    const pages = (inputs.resolution ?? []).flatMap((pair) => pair[1]?.pages ?? []);

    // 工作项：机械顺序（地基 → 库 → 后端 → 前端 → 自检），不写文件清单
    const workItems: { id: string; kind: string; title: string }[] = [
        { id: "w1-foundation", kind: "foundation", title: "工程骨架与工程文件就位" },
    ];
    if ((s.tables ?? []).length > 0) workItems.push({ id: "w2-database", kind: "database", title: "数据表与初始化" });
    workItems.push({ id: "w3-backend", kind: "backend", title: `后端实现（${backend.join(" / ") || "未声明"}）` });
    workItems.push({ id: "w4-frontend", kind: "frontend", title: `前端实现（${frontend.join(" / ") || "未声明"}）` });
    workItems.push({ id: "w5-pre-test", kind: "pre-test", title: "本地自检与自测" });

    const phaseGoal = (inputs.plan.phases?.[0]?.goal ?? "").trim();
    const instructions = [
        (d.summary ?? "").trim(),
        phaseGoal ? `本阶段目标：${phaseGoal}` : "",
        "先让工程能构建，再写业务；不要修改契约路径与验收脚本。",
    ].filter((x) => x.length > 0).join("；");

    return {
        goal: (d.summary ?? "").trim(),
        features,
        stack: {
            frontend: frontend[0] ?? "",
            backend: backend[0] ?? "",
            ...(database ? { database } : {}),
            why: (s.why ?? "").trim(),
        },
        entities: (s.tables ?? []).map((t) => ({
            entity: t.name,
            table: t.name,
            fields: (t.fields ?? []).map((f) => ({
                name: f.name, type: f.type,
                ...(f.required !== undefined ? { required: f.required } : {}),
                ...(f.remark ? { remark: f.remark } : {}),
            })),
        })),
        endpoints: apis.map((a) => ({
            method: a.method, path: a.path, purpose: a.purpose,
            ...(a.response ? { response: a.response } : {}),
        })),
        pages: pages.map((p) => ({ path: p.page, purpose: p.interactions })),
        workItems,
        instructions,
        risks: [...(d.risks ?? [])],
    };
}

// ============================================================
// 八、唯一入口：收 LLM 输出 → 校验 → 装配 → 派发
// ============================================================

export interface CreateArchitectTaskOptions {
    station: TransferStation;
    pmPlan: PmPlanLike;
    projectId: string;
    /** 真实 LLM / Fake LLM 的调用口；重试 Prompt 只带错误位置 */
    call: (retryPrompt: string | null) => Promise<unknown>;
    maxAttempts?: number;
    phase?: number;
    catalog?: readonly AssetEntry[];
    allowedRoots?: readonly string[];
    forbiddenPaths?: readonly string[];
    sender?: string;
    receiver?: string;
    /** 显式注入幂等表（测试/特殊场景）；不传 = 用持久化 Ledger（见 ledgerPath） */
    registry?: DispatchRegistry;
    /** 持久化幂等账本路径；不传 = defaultDispatchLedgerPath()（仓库根 .runs/_architect/dispatch.db） */
    ledgerPath?: string;
    onEvent?: (ev: ArchEvent) => void;
}

export interface CreateArchitectTaskOutcome {
    ok: boolean;
    code?: ArchitectParseCode | BuildCode | "ARCHITECT_FAILED";
    issues: string[];
    attempts: number;
    retryPrompts: string[];
    task?: ArchitectTask;
    packageHash?: string;
    stackAssetMatched?: boolean;
    notes?: string[];
    dispatch?: DispatchOutcome;
    /** 任务包是否被派发出去——false 时 Developer 一定**没有**收到任何东西 */
    dispatched: boolean;
}

export async function createArchitectTask(o: CreateArchitectTaskOptions): Promise<CreateArchitectTaskOutcome> {
    const emit = (ev: ArchEvent): void => o.onEvent?.(ev);
    const collected = await collectArchitectSemantics({ call: o.call, ...(o.maxAttempts !== undefined ? { maxAttempts: o.maxAttempts } : {}) });
    if (!collected.ok || !collected.semantics) {
        const failure = collected.failure;
        emit({
            type: "package_failed",
            detail: { stage: "parse", code: failure?.code, issues: failure?.issues, attempts: collected.attempts },
            at: Date.now(),
        });
        return {
            ok: false,
            code: "ARCHITECT_FAILED",
            issues: failure?.issues ?? ["语义收不上来"],
            attempts: collected.attempts,
            retryPrompts: collected.retryPrompts,
            dispatched: false,
        };
    }

    const built = buildArchitectTaskFromPlan({
        pmPlan: o.pmPlan,
        semantics: collected.semantics,
        projectId: o.projectId,
        ...(o.phase !== undefined ? { phase: o.phase } : {}),
        ...(o.catalog ? { catalog: o.catalog } : {}),
        ...(o.allowedRoots ? { allowedRoots: o.allowedRoots } : {}),
        ...(o.forbiddenPaths ? { forbiddenPaths: o.forbiddenPaths } : {}),
    });
    if (!built.ok || !built.task || !built.packageHash) {
        emit({
            type: "package_rejected",
            detail: { stage: "build", code: built.code, issues: built.issues, stackMatch: built.stackMatch },
            at: Date.now(),
        });
        return {
            ok: false, code: built.code, issues: built.issues,
            attempts: collected.attempts, retryPrompts: collected.retryPrompts,
            stackAssetMatched: built.stackAssetMatched, notes: built.notes, dispatched: false,
        };
    }

    emit({
        type: "package_created",
        taskId: built.task.taskId, packageHash: built.packageHash,
        detail: { stackAssetMatched: built.stackAssetMatched, notes: built.notes },
        at: Date.now(),
    });
    emit({
        type: "package_validated",
        taskId: built.task.taskId, packageHash: built.packageHash,
        detail: { acceptanceChecks: built.acceptanceIntents.map((x) => x.id) },
        at: Date.now(),
    });

    // ★ 幂等：默认走**持久化 Ledger**（跨进程、跨重启都记得）；
    //   只有调用方显式注入 registry 时才用注入的（测试用内存表）。
    const owned = o.registry ? null : openDispatchRegistry(o.ledgerPath);
    const registry: DispatchRegistry = o.registry ?? owned!.registry;
    try {
        const dispatch = dispatchArchitectTask({
            station: o.station,
            task: built.task,
            packageHash: built.packageHash,
            ...(o.sender ? { sender: o.sender } : {}),
            ...(o.receiver ? { receiver: o.receiver } : {}),
            isDuplicate: registry.isDuplicate,
            markDispatched: (key) => registry.markDispatched(key),
            ...(o.onEvent ? { onEvent: o.onEvent } : {}),
        });

        return {
            ok: dispatch.dispatched,
            issues: dispatch.dispatched ? [] : [dispatch.reason ?? "派发未成功"],
            attempts: collected.attempts,
            retryPrompts: collected.retryPrompts,
            task: built.task,
            packageHash: built.packageHash,
            stackAssetMatched: built.stackAssetMatched,
            notes: built.notes,
            dispatch,
            dispatched: dispatch.dispatched,
        };
    } finally {
        owned?.close();
    }
}

// ============================================================
// 十、两阶段派发（9/15 解耦测试第二项"架构师会不会按批次产出"）：
//     蓝图 architect_task 先行 → 按工作项顺序逐批 architect_batch
//
//   与第八节 createArchitectTask（一份 architect_task 整包）的差异：
//   · 拆解逻辑**不在本文件重写**——直接吃 developerAgent/architectAgent.ts
//     （decomposeBlueprint / decomposeBatch，24 用例测绿的两阶段拆解器），
//     LLM 经 DeveloperLlm 接口注入（测试注 scripted Fake，真机注 createRealLlm）；
//   · 需求来源从「PM 结构化 plan + 旧三节点语义」换成**需求原文**（调用方经
//     Node.ts getProjectRequirement 读 sys_project.description + clarified_req）；
//   · 派发面从 1 条消息变成 1+N 条：蓝图先发，随后**严格按蓝图 workItems 顺序**
//     逐批发——developer 端 resumeWithBatch 是在序闸（index.ts:608，itemId 必须
//     等于首个未达项，乱序/跳批 batch_rejected 吃掉），顺序即执行序是协议事实；
//   · 没有 architect_close：发满全部 itemId 即流闭（protocol.ts:329 的设计，
//     收尾键进协议=模型可伪造的提前送检入口，所以这里不发任何"结束"消息）。
//
//   断点重放（落盘=零重烧）：蓝图与每批**生成即落盘**
//     RUNS_ROOT/p{N}/_tasks/{taskId}/blueprint.json、batch-{itemId}.json
//   （taskDir 由调用方用 runEnv.projectDir 算好传入；落盘时机=生成成功立刻、
//   发送之前——发送崩了文件还在，重跑直接从磁盘续）。重跑时文件在 ⇒ 跳过 LLM
//   直接重发/续发；幂等账本对"蓝图 + 每批"分别记账（blueprintDispatchKeyOf /
//   batchDispatchKeyOf，内容寻址 ⇒ 重跑不重发）。
//
//   失败语义（用户拍板"整次作废"）：某批 3 连拒（decomposeBatch 重试耗尽抛错）
//   → 停止发后续批 + 向 developer 发 cancel_task（字段逐字对齐 CancelTaskSchema）
//   + 向 manager 显式报告（见 reportFailure 注释）。
// ============================================================

/** 蓝图幂等键（内容寻址：同一份蓝图 → 同一个键 → 重跑被账本去重不重发） */
export function blueprintDispatchKeyOf(taskId: string, blueprint: ArchitectTask): string {
    return dispatchKeyOf(taskId, `blueprint:${hashOf(canonicalJson(blueprint))}`);
}

/** 批次幂等键：每批独立记账——蓝图/各批"分别记"是重跑不重发的粒度基础 */
export function batchDispatchKeyOf(taskId: string, batch: ArchitectBatch): string {
    return dispatchKeyOf(taskId, `batch:${batch.itemId}:${hashOf(canonicalJson(batch))}`);
}

/** itemId → 重放文件名（只替换文件系统非法字符，不动消息本体与幂等键） */
function batchFileNameOf(itemId: string): string {
    return `batch-${itemId.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")}.json`;
}

export interface ArchitectBatchDispatchOptions {
    /** 消息总线（architect → developer / manager 都从这里走） */
    station: TransferStation;
    /** 需求原文（sys_project.description + clarified_req）；空文本报错，不起 LLM */
    requirement: string;
    /** 协议身份：三消息（蓝图/各批/cancel）逐字一致，账不能记串 */
    projectId: string;
    taskId: string;
    /** LLM 注入（DeveloperLlm 形状）：测试注 scripted Fake，生产传 createRealLlm */
    llm: DeveloperLlm;
    /** 每阶段（蓝图/每批）的拆解尝试上限，缺省 3=architectAgent 默认 */
    maxAttempts?: number;
    /** 断点重放目录（RUNS_ROOT/p{N}/_tasks/{taskId}）；不传=不落盘不重放（纯内存派发） */
    taskDir?: string;
    /** 显式注入幂等表（测试）；不传=持久化 Ledger（见 ledgerPath），同第八节约定 */
    registry?: DispatchRegistry;
    ledgerPath?: string;
    sender?: string;
    receiver?: string;
    /** 失败上报对象（缺省 "manager"） */
    managerName?: string;
    onEvent?: (ev: ArchEvent) => void;
}

export interface ArchitectBatchDispatchOutcome {
    ok: boolean;
    /** 走到哪：blueprint=蓝图阶段折了；batch=某个工作项折了（看 failedItemId）；done=全部发满 */
    stage: "blueprint" | "batch" | "done";
    issues: string[];
    blueprint?: ArchitectTask;
    /** 本次处理过的批（按蓝图序；含重放/去重的）——审计用 */
    batches: ArchitectBatch[];
    /** ok=false 且 stage=batch 时的失败工作项 */
    failedItemId?: string;
    /** 是否已向 developer 发出 cancel_task（蓝图都没发出去时为 false——没东西可作废） */
    cancelled: boolean;
    /** 被幂等账本拦下（上次运行已发过）的条目："blueprint" + 各 itemId */
    deduped: string[];
}

/** sendOnce 的三态返回：发送成功 / 账本去重 / 总线抛错（错误原文交上层收口） */
type SendVerdict = { kind: "sent" | "deduped" } | { kind: "error"; error: string };

/**
 * 两阶段派发主函数：需求原文 →（蓝图 + N 批）→ Hub。
 * 拆解全程委托 architectAgent（本函数只做：重放读盘、发送+记账、落盘、失败收口）。
 */
export async function dispatchArchitectTaskBatched(
    o: ArchitectBatchDispatchOptions,
): Promise<ArchitectBatchDispatchOutcome> {
    const sender = o.sender ?? "architect";
    const receiver = o.receiver ?? "developer";
    const managerName = o.managerName ?? "manager";
    const emit = (type: ArchEventType, detail?: Record<string, unknown>): void =>
        o.onEvent?.({ type, taskId: o.taskId, detail: { projectId: o.projectId, ...detail }, at: Date.now() });

    const requirement = (o.requirement ?? "").trim();
    if (!requirement) {
        // fail fast：没需求原文不猜需求、不起 LLM（空包派出去=Developer 白烧一轮）
        return {
            ok: false, stage: "blueprint", issues: ["需求原文为空（sys_project.description/clarified_req），不派发"],
            batches: [], cancelled: false, deduped: [],
        };
    }

    const agent = createArchitectAgent({
        llm: o.llm,
        ...(o.maxAttempts !== undefined ? { maxAttempts: o.maxAttempts } : {}),
    });
    // 幂等账本：默认持久化 Ledger（跨进程记得），测试可注入内存表——同第八节约定
    const owned = o.registry ? null : openDispatchRegistry(o.ledgerPath);
    const registry: DispatchRegistry = o.registry ?? owned!.registry;

    const fileOf = (name: string): string | null => (o.taskDir ? path.join(o.taskDir, name) : null);
    const writeJson = (file: string, value: unknown): void => {
        ensureDir(path.dirname(file));
        fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf-8");
    };
    const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, "utf-8"));

    /** 发送一条消息并记账；重复（上次运行已发）→ deduped，不重发 */
    const sendOnce = (key: string, payload: unknown, evType: ArchEventType): SendVerdict => {
        if (registry.isDuplicate(key)) {
            emit("dispatch_deduped", { key });
            return { kind: "deduped" };
        }
        try {
            o.station.sendMessage(sender, receiver, JSON.stringify(payload));
        } catch (e) {
            return { kind: "error", error: (e as Error).message };
        }
        registry.markDispatched(key);
        emit(evType, { key });
        return { kind: "sent" };
    };

    /**
     * 失败显式上报。architect.ts 的上报通道是 BaseAgent.send（类方法），但派发
     * 逻辑住在节点函数/本模块里拿不到 this——所以直接 sendMessage 给 manager。
     * 形状 {type:"architect_dispatch_failed", ...} 自定：manager.ts 未注册该类型的
     * on() 处理器，Hub 侧只会躺进收件箱（观测留痕，不是控制消息）——目的是让
     * "整次作废"在管理侧肉眼可见，而不是只有一行 console。
     */
    const reportFailure = (stage: "blueprint" | "batch", itemId: string | null, error: string): void => {
        emit("dispatch_failed", { stage, ...(itemId ? { failedItemId: itemId } : {}), error });
        try {
            o.station.sendMessage(sender, managerName, JSON.stringify({
                type: "architect_dispatch_failed",
                projectId: o.projectId, taskId: o.taskId, stage,
                ...(itemId ? { failedItemId: itemId } : {}),
                error, at: Date.now(),
            }));
        } catch { /* 上报通道本身坏了：只剩 onEvent 账，不再叠错误 */ }
    };

    /**
     * 作废通知。字段逐字对齐 CancelTaskSchema（protocol.ts:355：projectId 必填，
     * taskId/reason 可选）。**不走幂等账本**：取消必须无条件到达——developer
     * 可能正卡在 waiting_item 等永远不会来的下一批；终态幂等由 developer 端
     * cancelTask 自己兜（index.ts:642）。
     */
    const cancelDeveloper = (reason: string): void => {
        try {
            o.station.sendMessage(sender, receiver, JSON.stringify({
                type: "cancel_task", projectId: o.projectId, taskId: o.taskId, reason,
            }));
            emit("dispatch_cancelled", { reason });
        } catch { /* 同上 */ }
    };

    try {
        // ---- 阶段 1：蓝图（architect_task，全局一次冻结；先于一切批次）----
        let blueprint: ArchitectTask;
        const bpFile = fileOf("blueprint.json");
        if (bpFile && fs.existsSync(bpFile)) {
            // 重放：文件在 ⇒ 零重烧。形状坏=fail fast（半截文件不猜着喂）
            try {
                blueprint = ArchitectTaskSchema.parse(readJson(bpFile));
            } catch (e) {
                const msg = `重放蓝图文件损坏（${bpFile}）：${(e as Error).message}`;
                reportFailure("blueprint", null, msg);
                return { ok: false, stage: "blueprint", issues: [msg], batches: [], cancelled: false, deduped: [] };
            }
            emit("blueprint_replayed", { file: bpFile });
        } else {
            try {
                blueprint = (await agent.decomposeBlueprint({
                    requirement, projectId: o.projectId, taskId: o.taskId,
                })).task;
            } catch (e) {
                // 蓝图 3 连拒：developer 什么都没收到 → 不发 cancel_task（没东西可作废），只上报
                const msg = (e as Error).message;
                reportFailure("blueprint", null, msg);
                return { ok: false, stage: "blueprint", issues: [msg], batches: [], cancelled: false, deduped: [] };
            }
            // 生成即落盘（发送之前）：崩在发送上，文件还在，重跑不重烧
            if (bpFile) writeJson(bpFile, blueprint);
        }

        const bpSent = sendOnce(blueprintDispatchKeyOf(o.taskId, blueprint), blueprint, "blueprint_dispatched");
        if (bpSent.kind === "error") {
            reportFailure("blueprint", null, bpSent.error);
            return { ok: false, stage: "blueprint", issues: [`蓝图派发失败：${bpSent.error}`], blueprint, batches: [], cancelled: false, deduped: [] };
        }
        const deduped: string[] = bpSent.kind === "deduped" ? ["blueprint"] : [];
        const batches: ArchitectBatch[] = [];
        // 已交付判据滚动清单（CLI 同款）：蓝图底线起步，每批追加——后续批的撞车闸吃它
        const delivered = blueprint.acceptanceChecks.map((c) => c.id);

        /** 批阶段的统一收口：停发后续批 + cancel + 上报（"整次作废"三件套） */
        const abortBatch = (itemId: string, why: string): ArchitectBatchDispatchOutcome => {
            cancelDeveloper(`架构师批次派发作废：工作项 ${itemId} —— ${why}`);
            reportFailure("batch", itemId, why);
            return {
                ok: false, stage: "batch", failedItemId: itemId, issues: [why],
                blueprint, batches, cancelled: true, deduped,
            };
        };

        // ---- 阶段 2：按蓝图 workItems 顺序逐批（顺序=执行序，乱序会被在序闸吃掉）----
        const items = blueprint.foundationPlan.workItems ?? [];
        for (const item of items) {
            let batch: ArchitectBatch;
            const bFile = fileOf(batchFileNameOf(item.id));
            if (bFile && fs.existsSync(bFile)) {
                try {
                    batch = ArchitectBatchSchema.parse(readJson(bFile));
                } catch (e) {
                    return abortBatch(item.id, `重放批次文件损坏（${bFile}）：${(e as Error).message}`);
                }
                emit("batch_replayed", { itemId: item.id, file: bFile });
            } else {
                try {
                    batch = (await agent.decomposeBatch({
                        requirement, blueprint, item,
                        deliveredCheckIds: delivered, projectId: o.projectId, taskId: o.taskId,
                    })).batch;
                } catch (e) {
                    // ★ 3 连拒（重试耗尽抛错）→ 整次作废
                    return abortBatch(item.id, (e as Error).message);
                }
                if (bFile) writeJson(bFile, batch);
            }
            const sent = sendOnce(batchDispatchKeyOf(o.taskId, batch), batch, "batch_dispatched");
            if (sent.kind === "error") return abortBatch(item.id, `批次派发失败：${sent.error}`);
            if (sent.kind === "deduped") deduped.push(item.id);
            batches.push(batch);
            delivered.push(...batch.checks.map((c) => c.id));
        }

        // 发满全部 itemId 即流闭：没有 architect_close，收尾键由 developer 代码侧判
        emit("dispatch_completed", { batches: batches.length, deduped: deduped.length });
        return { ok: true, stage: "done", issues: [], blueprint, batches, cancelled: false, deduped };
    } finally {
        owned?.close();
    }
}
