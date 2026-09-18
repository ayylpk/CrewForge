// ============================================================
// src/review.ts —— 严格语义审查层（机械验收之后的第二道闸）
//
//   职责边界（照抄任务硬约束，代码里逐条落地）：
//     ① 机械 verdict 永远只由 exitCode / evidence / skipped 算——本文件**不碰**它；
//     ② 审查层不能生成 test_passed：它只能产出 findings 与策略结论，
//        而策略里"通过"必须同时满足 机械 pass + 审查可用 + 审查 pass + 高置信 + 无阻断项；
//     ③ 本文件**只读**：只用 readFileSync / readdirSync / statSync / existsSync，
//        没有任何写盘接口，也不引子进程与模型工具链（结构化保证 + 单测钉住）；
//     ④ 审查模型**不带任何工具**：走 /chat/completions，请求体里根本没有 tools 字段，
//        所以它结构上不可能改目标项目、验收脚本、契约或 TestAgent 自身；
//     ⑤ 有证据的怀疑才算数：预扫信号与模型 findings 都必须带 evidence 数组（文件行号 /
//        机器输出 / HTTP 响应），没有证据的猜测由策略压成 uncertain，不能当确定失败；
//     ⑥ findings 全量返回：不截断、不去重成一条、不提前 return；
//     ⑦ LLM 抛错 / 超时 / 输出不合契约 → LLM_REVIEW_UNAVAILABLE，**绝不当成 pass**。
//
//   为什么先做确定性预扫（prescanReviewSignals）：
//     状态码 200 但页面是 `OK`、数据只在内存数组里、把验收脚本的固定值抄进代码——
//     这些用代码就能**带着证据**定位，不必先花一次模型调用。预扫只产出"带证据的怀疑"，
//     它只能阻止通过，永远不能授予通过（授予通过必须经过模型 + 高置信）。
//     模型可以补充、细化，但**不能把预扫的 critical/major 降级掉**（error 不许降成 warning）。
// ============================================================

import fs from "node:fs";
import path from "node:path";

// ============================================================
// 契约类型
// ============================================================

export type ReviewSeverity = "critical" | "major" | "minor";
export type ReviewCategory = "PLACEHOLDER" | "PERSISTENCE" | "SPEC_GAMING" | "UI" | "CONTRACT" | "OTHER";
export type ReviewVerdict = "pass" | "fail" | "uncertain";
export type ReviewConfidence = "high" | "medium" | "low";

/** 一条审查发现。预扫信号与模型 findings 共用这个形状——下游处理不必分两套 */
export interface ReviewFinding {
    severity: ReviewSeverity;
    category: ReviewCategory;
    title: string;
    /** 证据必须落到文件行号 / 机器输出 / HTTP 响应 / 命令退出码上 */
    evidence: string[];
    recommendation: string;
}

/** 模型审查输出（严格结构，逐字段校验后才采用） */
export interface LlmReview {
    reviewVerdict: ReviewVerdict;
    findings: ReviewFinding[];
    confidence: ReviewConfidence;
}

export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
}

/** 可注入的审查模型。**只有 complete 一个方法**——没有工具、没有写盘、没有执行 */
export interface ReviewLlm {
    readonly id: string;
    complete(input: { system: string; user: string }): Promise<{ text: string; usage?: TokenUsage | null }>;
}

/** 一次 HTTP 页面探测的结果（由机械证据里抽出来，或由调用方显式给出） */
export interface PageProbe {
    checkId: string;
    status: number;
    html: string;
    /** 证据里只截到文档前缀（没有 </html>）——此时不能断言"页面是空壳" */
    truncated?: boolean;
}

/** 机械验收的最小镜像（本文件只读它，不改它） */
export interface MechanicalMirror {
    verdict: string;
    evidence: { checkId: string; category?: string; command?: string; args?: string[]; cwd?: string; exitCode: number | null; timedOut?: boolean; durationMs?: number; stdout?: string; stderr?: string }[];
    skipped: { checkId: string; reason: string }[];
    allFailures?: { checkId: string; exitCode: number | null; stderr?: string; stdout?: string }[];
}

export interface ReviewContext {
    projectDir: string;
    /** 机械验收的确定性文本（含每条命令的 exitCode / stdout / stderr 原文） */
    mechanicalText: string;
    mechanicalVerdict: string;
    /** 项目文件树（相对路径，posix，已按上限截断） */
    tree: string[];
    /** 关键源码（相对路径 → 内容，已按上限截断） */
    sources: { path: string; content: string }[];
    /** TestAgent 侧验收脚本——**只作背景**，真实项目行为优先 */
    acceptanceScripts: { path: string; content: string }[];
    pages: PageProbe[];
    /** 已知的验收固定值（来自任务包 / 验收输入），用来查"抄进代码当种子" */
    acceptanceLiterals: string[];
    requiresPersistence: boolean;
}

export interface ReviewAudit {
    status: "ok" | "LLM_REVIEW_UNAVAILABLE" | "disabled";
    reason: string | null;
    model: string;
    promptHash: string;
    evidenceHash: string;
    durationMs: number;
    tokenUsage: TokenUsage | null;
    review: LlmReview | null;
    /** 确定性预扫信号（全量，不截断） */
    signals: ReviewFinding[];
}

export type ReviewOutcome = "pass" | "fail" | "uncertain" | "llm_unavailable" | "blocked_unverified" | "error";

export interface ReviewDecision {
    outcome: ReviewOutcome;
    reason: string;
    /** 阻断性发现（critical | major）——非空就绝不放行 */
    blocking: ReviewFinding[];
}

export interface ReviewOptions {
    llm?: ReviewLlm;
    /** 库层默认 **false**：不显式开启就一次模型都不调（"零 LLM"承诺由结构保证，不靠运气） */
    enabled?: boolean;
    timeoutMs?: number;
    log?: (line: string) => void;
}

/** 审查层可用的工具清单：**空**。它没有 writeFile / editFile / shell / runCommand / 进程控制 */
export const REVIEW_TOOL_NAMES: readonly string[] = [];

/** 明确写出来的禁区清单（供文档与测试对照；不是权限表的镜像） */
export const REVIEW_FORBIDDEN_TOOLS: readonly string[] = [
    "writeFile", "editFile", "mkdir", "shell", "runCommand", "startProcess", "stopProcess",
];

export const REVIEW_CATEGORIES: readonly ReviewCategory[] =
    ["PLACEHOLDER", "PERSISTENCE", "SPEC_GAMING", "UI", "CONTRACT", "OTHER"];
export const REVIEW_SEVERITIES: readonly ReviewSeverity[] = ["critical", "major", "minor"];

const DEFAULT_TIMEOUT_MS = 120_000;

// ============================================================
// 小工具（纯函数）
// ============================================================

/** 确定性指纹：同一份输入永远同一个值，可跨进程复核 */
export function hashText(s: string): string {
    return Bun.hash(s).toString(16);
}

function logLine(log: ((l: string) => void) | undefined, line: string): void {
    if (log) log(`[review] ${line}`);
}

/** 剥掉标签与内联脚本/样式，只留人眼可见文本 */
export function visibleText(html: string): string {
    return String(html)
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/** 从模型回复里取 JSON（模型偶尔加围栏或解释文字） */
export function extractJson(raw: string): unknown {
    const s = raw.indexOf("{");
    const e = raw.lastIndexOf("}");
    const candidate = s >= 0 && e > s ? raw.slice(s, e + 1) : raw;
    try { return JSON.parse(candidate); } catch { return null; }
}

// ============================================================
// 机械证据 → 确定性文本（审查的输入之一）
// ============================================================

export function buildMechanicalText(m: MechanicalMirror): string {
    const lines: string[] = [];
    lines.push(`机械 verdict：${m.verdict}`);
    lines.push(`判据数量：evidence=${m.evidence.length} / skipped=${m.skipped.length}`);
    for (const e of m.evidence) {
        lines.push("");
        lines.push(`--- check ${e.checkId}（${e.category ?? "?"}）exitCode=${String(e.exitCode)}`
            + `${e.timedOut ? "（超时）" : ""} ${e.durationMs ?? "?"}ms`);
        lines.push(`command: ${e.command ?? "?"} ${(e.args ?? []).join(" ")}   cwd: ${e.cwd ?? "."}`);
        lines.push(`stdout:\n${(e.stdout ?? "").slice(0, 20_000)}`);
        lines.push(`stderr:\n${(e.stderr ?? "").slice(0, 20_000)}`);
    }
    for (const s of m.skipped) lines.push(`--- skipped ${s.checkId}：${s.reason}`);
    for (const f of m.allFailures ?? []) {
        lines.push(`--- 红单 ${f.checkId} exit=${String(f.exitCode)} stderr=${(f.stderr ?? "").slice(0, 2000)}`);
    }
    return lines.join("\n");
}

// ============================================================
// 只读上下文收集
// ============================================================

const SKIP_DIRS = new Set([
    "node_modules", ".git", "dist", "build", "target", "coverage", ".next", ".cache", ".vite", "out",
]);
const SOURCE_EXT = new Set([
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".py", ".java", ".go", ".rb", ".php",
    ".sql", ".html", ".css", ".json", ".yml", ".yaml", ".md",
]);
/** 越靠前越优先送给模型（先看入口与业务实现，再看边角） */
const SOURCE_HINTS: readonly RegExp[] = [
    /(^|\/)(app|main|index|server|bootstrap)\.[a-z]+$/i,
    /(^|\/)(route|router|controller|service|store|repo|repository|model|entity|schema|db|database)\./i,
    /\.vue$/i, /\.sql$/i,
];

export interface CollectInput {
    projectDir: string;
    mechanical: MechanicalMirror;
    pages?: PageProbe[];
    acceptanceLiterals?: string[];
    requiresPersistence?: boolean;
    limits?: { maxFiles?: number; maxFileBytes?: number; maxTotalBytes?: number };
}

/** 只读收集：文件树 + 关键源码 + 验收脚本（背景） */
export function collectReviewContext(input: CollectInput): ReviewContext {
    const limits = {
        maxFiles: input.limits?.maxFiles ?? 300,
        maxFileBytes: input.limits?.maxFileBytes ?? 20_000,
        maxTotalBytes: input.limits?.maxTotalBytes ?? 200_000,
    };
    const root = input.projectDir;

    const tree: string[] = [];
    const candidates: string[] = [];
    const walk = (dir: string): void => {
        if (tree.length >= limits.maxFiles) return;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (tree.length >= limits.maxFiles) return;
            const abs = path.join(dir, ent.name);
            if (ent.isDirectory()) {
                if (SKIP_DIRS.has(ent.name)) continue;
                walk(abs);
                continue;
            }
            const rel = path.relative(root, abs).split(path.sep).join("/");
            tree.push(rel);
            if (SOURCE_EXT.has(path.extname(ent.name).toLowerCase())) candidates.push(rel);
        }
    };
    walk(root);

    const score = (rel: string): number => {
        let s = 0;
        for (let i = 0; i < SOURCE_HINTS.length; i++) if (SOURCE_HINTS[i]!.test(rel)) s += SOURCE_HINTS.length - i;
        if (rel.split("/").length <= 3) s += 1;   // 浅层文件更可能是入口
        return s;
    };
    const ordered = [...candidates].sort((a, b) => (score(b) - score(a)) || a.localeCompare(b));

    const sources: { path: string; content: string }[] = [];
    const acceptanceScripts: { path: string; content: string }[] = [];
    let total = 0;
    for (const rel of ordered) {
        if (total >= limits.maxTotalBytes) break;
        let content: string;
        try { content = fs.readFileSync(path.join(root, rel), "utf-8"); } catch { continue; }
        const clipped = content.length > limits.maxFileBytes
            ? `${content.slice(0, limits.maxFileBytes)}\n…[截断，原文 ${content.length} 字符]`
            : content;
        total += clipped.length;
        // TestAgent 侧验收脚本：只作背景，另开一节，避免被当成"项目实现"或唯一依据
        if (rel === "scripts" || rel.startsWith("scripts/")) {
            acceptanceScripts.push({ path: rel, content: clipped });
            continue;
        }
        sources.push({ path: rel, content: clipped });
    }

    return {
        projectDir: root,
        mechanicalText: buildMechanicalText(input.mechanical),
        mechanicalVerdict: input.mechanical.verdict,
        tree: tree.slice(0, limits.maxFiles),
        sources,
        acceptanceScripts,
        pages: input.pages ?? [],
        acceptanceLiterals: (input.acceptanceLiterals ?? []).filter((s) => typeof s === "string" && s.trim().length >= 4),
        requiresPersistence: input.requiresPersistence !== false,
    };
}

// ============================================================
// 确定性预扫：带证据的怀疑（零 LLM）
// ============================================================

/**
 * 从机械证据里抽出"见过的页面响应"（保守启发式；找不到就不猜）。
 *
 *   两条抽取路径，都为反投机服务：
 *     ① 证据正文里出现了 HTML 文档（`<!DOCTYPE html` / `<html>`）→ 抽出一段当页面 HTML，
 *        状态码优先取正文里的 `HTTP 200`，取不到就用判据退出码（0 → 200，非 0 → 599）；
 *     ② 没有文档标记，但这条判据本身就是渲染/页面类、且正文**恰好是** OK / hello /
 *        placeholder 这类占位串、退出码又是 0 —— 这正是"只回 OK 也算过"的形状。
 *        这里要求"恰好等于占位串"而不是"很短"，否则会把验收脚本的进度日志误判成占位页。
 *
 *   证据里只截到文档前缀（没有 `</html>`）时标记 truncated：那种情况下"空壳"不能断言。
 */
export function extractPageProbes(
    evidence: { checkId: string; category?: string; exitCode: number | null; stdout?: string; stderr?: string }[],
): PageProbe[] {
    const out: PageProbe[] = [];
    for (const e of evidence) {
        const text = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
        if (!text.trim()) continue;
        const at = text.search(/<!DOCTYPE\s+html|<html[\s>]/i);
        if (at >= 0) {
            const rest = text.slice(at, at + 8_000);
            const end = rest.search(/<\/html>/i);
            const html = end >= 0 ? rest.slice(0, end + 7) : rest;
            const status = Number(/HTTP\s*(\d{3})/.exec(text)?.[1] ?? (e.exitCode === 0 ? 200 : 599));
            out.push({ checkId: e.checkId, status, html, truncated: end < 0 });
            continue;
        }
        const renderish = /render|page|frontend|ui|http/i.test(`${e.checkId} ${e.category ?? ""}`);
        const body = visibleText(text);
        if (renderish && e.exitCode === 0 && TRIVIAL_BODY_RE.test(body)) {
            out.push({ checkId: e.checkId, status: 200, html: body });
        }
    }
    return out.slice(0, 20);
}

interface SourceLine { path: string; line: number; text: string }

function sourceLines(sources: { path: string; content: string }[]): SourceLine[] {
    const out: SourceLine[] = [];
    for (const s of sources) {
        s.content.split(/\r?\n/).forEach((text, i) => out.push({ path: s.path, line: i + 1, text }));
    }
    return out;
}

const TRIVIAL_BODY_RE = /^(ok|okay|hello|hi|hey|test|pong|placeholder|coming soon|todo)[.!。！\s]*$/i;
const PLACEHOLDER_WORD_RE = /(placeholder|coming soon|lorem ipsum|under construction|to be implemented|敬请期待|待实现|占位)/i;
/** 页面"有真东西"的迹象：表单 / 输入 / 按钮 / 导航 / 列表 / 表格 / 主体 / 标题 */
const PAGE_STRUCTURE_RE = /<\s*(form|input|button|select|textarea|nav|ul|ol|table|main|header|section|h1|h2|h3)\b/i;
const PAGE_STRUCTURE_JSON_RE = /["'`](form|input|button|nav|ul|table|main|header)["'`]/i;

/** 持久化实现迹象：库 / 驱动 / 文件落盘调用（不改任何东西，只是识别） */
const PERSISTENCE_API_RE =
    /(node:sqlite|sqlite3?|better-sqlite3|mysql2?|pg\b|postgres|mongoose|prisma|sequelize|knex|typeorm|DatabaseSync|createPool|createConnection|lowdb|leveldb|redis|fs\.\s*(write|append)|Bun\.\s*(write|file)\b)/i;
/** 只在前端目录里出现的内存集合不算"冒充数据库"（组件状态本来就该在内存里） */
const FRONTEND_PATH_RE = /(^|\/)(frontend|web|ui|src\/views|src\/components)\/|\.vue$/i;

export function prescanReviewSignals(ctx: ReviewContext): ReviewFinding[] {
    const out: ReviewFinding[] = [];
    const lines = sourceLines(ctx.sources);
    const allSourceText = ctx.sources.map((s) => s.content).join("\n");

    // ---------- ① 页面：占位 / 200 但没结构 ----------
    //   注意 SPA 的"空挂载点"是**正常**的：index.html 里 <div id="app"></div> 本来就空，
    //   内容是前端脚本挂进去的。所以只在两种情况下才判"页面是假的"：
    //     · 可见文本本身是占位串（OK / placeholder / 敬请期待 …）；
    //     · 可见文本为空、且连一个脚本都没引用（纯空 div，页面不可能有内容）。
    //   其余"没有表单/导航/列表"的情况交给下面的整站结构检测——那才是有证据的判断。
    for (const p of ctx.pages) {
        if (!(p.status >= 200 && p.status < 300)) continue;
        const text = visibleText(p.html);
        const where = `HTTP ${p.status} ${p.checkId}`;
        const trivial = text.length > 0 && (TRIVIAL_BODY_RE.test(text) || PLACEHOLDER_WORD_RE.test(text));
        const emptyShell = !p.truncated && text.length === 0
            && !/<\s*script\b/i.test(p.html) && !PAGE_STRUCTURE_RE.test(p.html);
        if (trivial || emptyShell) {
            out.push({
                severity: "critical", category: "PLACEHOLDER",
                title: `页面是占位内容（${where}）`,
                evidence: [`${where}，可见文本 = ${JSON.stringify(text.slice(0, 120))}`
                    + `，脚本引用 = ${/<\s*script\b/i.test(p.html) ? "有" : "无"}`],
                recommendation: "返回真实页面：真实的导航 / 主体 / 表单 / 列表与业务数据渲染，而不是 OK / placeholder 之类的占位串。",
            });
        }
    }

    // ---------- ①b 整站有没有任何真实页面结构 ----------
    //   前端源码与页面 HTML 两头都找不到 form/input/button/nav/ul/table/main —— 那就是
    //   "HTTP 200 但页面没有真实内容"，而不是"这一页刚好样式简单"。
    const frontendSources = ctx.sources.filter((s) => FRONTEND_PATH_RE.test(s.path) || /\.(vue|html|tsx|jsx)$/i.test(s.path));
    if (frontendSources.length > 0) {
        const hasStructureInSource = frontendSources.some((s) => PAGE_STRUCTURE_RE.test(s.content));
        const hasStructureInPage = ctx.pages.some((p) => PAGE_STRUCTURE_RE.test(p.html) || PAGE_STRUCTURE_JSON_RE.test(p.html));
        if (!hasStructureInSource && !hasStructureInPage) {
            out.push({
                severity: "major", category: "UI",
                title: "整站找不到任何真实页面结构（HTTP 200 但页面没有表单 / 按钮 / 导航 / 业务内容）",
                evidence: [
                    `前端源码 ${frontendSources.length} 个文件里没有任何 form/input/button/select/nav/ul/ol/table/main/header/section/h1-h3`,
                    `机械验收里的 HTTP 页面响应同样没有这些结构`,
                    `涉及文件：${frontendSources.map((s) => s.path).slice(0, 8).join("、")}`,
                ],
                recommendation: "补上真实页面结构（表单、按钮、导航、列表/表格、数据渲染区域）。状态码不是页面。",
            });
        }
    }

    // ---------- ② 持久化：内存集合冒充数据库 ----------
    if (ctx.requiresPersistence && !PERSISTENCE_API_RE.test(allSourceText)) {
        for (const l of lines) {
            const t = l.text;
            if (FRONTEND_PATH_RE.test(l.path)) continue;
            // 模块级可变集合（不是组件状态：不含 ref( / reactive( / useState( ）
            const moduleCollection = /^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*(?::[^=]*)?=\s*(\[\s*\]|new\s+Map\s*[(<]|new\s+Set\s*[(<])/.test(t);
            if (!moduleCollection) continue;
            const name = /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)/.exec(t)?.[1] ?? "";
            if (!name) continue;
            // 只怀疑"像数据访问层"的位置与"像记录集合"的变量名——避免把工具函数的临时数组误判成持久化
            const looksLikeStore = /(store|repo|repository|model|db|database|persist|data|service|dao)/i.test(l.path)
                || /(project|item|record|note|task|user|diary|entry|repo|file|order)/i.test(name);
            if (!looksLikeStore) continue;
            // 必须有"往里存"的动作，且真的被使用——否则可能只是空占位
            const used = lines.some((x) => x.path === l.path && x.line !== l.line
                && new RegExp(`\\b${name}\\s*\\.\\s*(push|set|add|unshift|splice)\\s*\\(`).test(x.text));
            if (!used) continue;
            out.push({
                severity: "major", category: "PERSISTENCE",
                title: `用内存集合代替持久化存储（${name}）`,
                evidence: [
                    `${l.path}:${l.line} —— ${t.trim().slice(0, 160)}`,
                    `全项目源码里找不到任何持久化实现迹象（sqlite / 数据库驱动 / 文件落盘）`,
                    `进程重启后 ${name} 里的数据会全部消失`,
                ],
                recommendation: "按契约把数据落到真正的持久化存储（数据库或文件），并保证跨进程重启后仍可读。",
            });
        }
    }

    // ---------- ③ 规格投机：验收固定值被抄进代码 / 内联种子 ----------
    for (const literal of ctx.acceptanceLiterals) {
        for (const l of lines) {
            if (!l.text.includes(literal)) continue;
            out.push({
                severity: "critical", category: "SPEC_GAMING",
                title: `源码里出现验收固定值「${literal.slice(0, 40)}」`,
                evidence: [`${l.path}:${l.line} —— ${l.text.trim().slice(0, 200)}`],
                recommendation: "删掉写死的验收值。示例数据只能由真实的创建流程产生，默认值要与验收输入无关。",
            });
            break;   // 同一个固定值只报第一处，避免噪声淹没其它发现
        }
    }
    const seedish = ctx.sources.filter((s) => /(seed|bootstrap|migrat|fixture|sampledata|demo-?data)/i.test(s.path));
    for (const s of seedish) {
        const inserted = /INSERT\s+INTO[\s\S]{0,400}?VALUES\s*\(([\s\S]{0,200}?)\)/i.exec(s.content);
        if (!inserted) continue;
        const values = inserted[1] ?? "";
        // 参数化占位（? / $1 / :name）是正常实现；内联字面量才是写死数据
        if (!/['"]/.test(values) || /[?]|\$\d|:\w/.test(values.replace(/['"][^'"]*['"]/g, ""))) continue;
        const at = s.content.slice(0, inserted.index).split(/\r?\n/).length;
        out.push({
            severity: "major", category: "SPEC_GAMING",
            title: `迁移/引导代码里写了内联种子数据（${s.path}）`,
            evidence: [`${s.path}:${at} —— ${inserted[0].replace(/\s+/g, " ").slice(0, 220)}`],
            recommendation: "去掉写死的种子行；示例数据只应由真实接口/表单流程写入。",
        });
    }

    // ---------- ④ 吞掉异常 / 假实现 / 未完成 ----------
    for (const l of lines) {
        if (/catch\s*(?:\([^)]*\))?\s*\{\s*(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*)?\s*\}/.test(l.text)) {
            out.push({
                severity: "major", category: "OTHER",
                title: "异常被静默吞掉（空 catch）",
                evidence: [`${l.path}:${l.line} —— ${l.text.trim().slice(0, 160)}`],
                recommendation: "把失败如实暴露出来（记录 + 返回错误状态），不要吞掉异常后继续成功返回。",
            });
            continue;
        }
        if (/catch\s*(?:\([^)]*\))?\s*\{[^{}]{0,160}return\s*(?:true|200|\{\s*ok\s*:\s*true)/.test(l.text)) {
            out.push({
                severity: "major", category: "OTHER",
                title: "异常被包装成成功",
                evidence: [`${l.path}:${l.line} —— ${l.text.trim().slice(0, 160)}`],
                recommendation: "catch 里不能把错误改写成成功响应；错误必须向上传播或转成明确的失败状态。",
            });
            continue;
        }
        if (/(not\s+implemented|未实现|尚未实现)/i.test(l.text)) {
            out.push({
                severity: "major", category: "OTHER",
                title: "存在未实现分支",
                evidence: [`${l.path}:${l.line} —— ${l.text.trim().slice(0, 160)}`],
                recommendation: "把该分支实现出来；验收不接受未实现的占位分支。",
            });
            continue;
        }
        if (/\b(TODO|FIXME)\b/.test(l.text)) {
            out.push({
                severity: "minor", category: "OTHER",
                title: "遗留 TODO / FIXME",
                evidence: [`${l.path}:${l.line} —— ${l.text.trim().slice(0, 160)}`],
                recommendation: "确认这些待办是否影响验收涉及的路径；会影响就补齐。",
            });
        }
    }

    // ---------- ⑤ 空页面组件（编译通过但页面空白） ----------
    for (const s of ctx.sources) {
        if (!/\.vue$/i.test(s.path)) continue;
        const m = /<template>([\s\S]*?)<\/template>/i.exec(s.content);
        if (!m) continue;
        const inner = (m[1] ?? "").replace(/<script[\s\S]*?<\/script>/gi, "");
        if (visibleText(inner).length === 0 && !PAGE_STRUCTURE_RE.test(inner)) {
            out.push({
                severity: "major", category: "UI",
                title: `视图组件是空模板（${s.path}）`,
                evidence: [`${s.path} —— <template> 内没有任何可见内容或结构`],
                recommendation: "补上真实页面内容；build 通过不代表页面有东西。",
            });
        }
    }

    return out;
}

// ============================================================
// 送进模型的 prompt（确定性组装）
// ============================================================

/**
 * 审查模型的系统提示词。刻意把"不能降级、不能替 Developer 改文件、验收脚本只是背景"
 * 写死在代码里，而不是靠调用方传参——避免规则被上游悄悄换掉。
 */
export const REVIEW_SYSTEM_PROMPT = [
    "你是 CrewForge 的严格 TestAgent。你的职责不是帮助项目“勉强通过”，而是找出真实错误，",
    "并把所有错误一次性返回给 Developer。",
    "",
    "工作顺序：1) 先看机械验收的全部命令与原始输出；2) 不因第一条失败就停止；",
    "3) 保存每条命令的完整证据；4) 读项目文件与运行结果；5) 做语义审查；",
    "6) 汇总机械错误和语义错误；7) 一次性返回完整结论。",
    "",
    "你必须重点怀疑以下情况：",
    "- 代码里出现验收脚本中的固定测试值；",
    "- 启动时自动插入验收项目；",
    "- 使用数组或变量保存数据但没有真实持久化；",
    "- 页面只返回 OK、Login page、placeholder；",
    "- HTTP 200 但页面没有表单、导航、列表或业务内容；",
    "- 只实现验收请求对应的特殊分支；",
    "- 用固定 ID、固定 slug、固定响应绕过业务逻辑；",
    "- 删除、放宽、绕过契约；",
    "- TODO、空函数、假接口、静态假数据；",
    "- 编译通过但运行时逻辑明显不成立。",
    "",
    "硬性规则：",
    "- 不能因为 build 通过就判定项目正确；",
    "- 不能因为 HTTP 状态码正确就判定页面正确；",
    "- 不能因为某一条检查通过就忽略其他失败；",
    "- 不能替 Developer 修改文件（你没有任何写盘或执行能力）；",
    "- 不能修改验收脚本、契约、Ledger 或 TestAgent 自身；",
    "- 不能伪造命令、退出码、HTTP 响应或证据；",
    "- 不能把 warning 当成 error；",
    "- 不能把 error 降级成 warning；也不能把已有证据的严重问题说成“小问题”；",
    "- 没有证据的猜测必须进 uncertain，不能作为确定失败；",
    "- findings 必须全部返回，禁止只返回第一条；",
    "- 验收脚本只能作为背景参考，真实项目行为优先。",
    "",
    "输出：只输出一个 JSON 对象，不要围栏、不要多余文字，字段严格如下：",
    '{"reviewVerdict":"pass|fail|uncertain",'
    + '"findings":[{"severity":"critical|major|minor",'
    + '"category":"PLACEHOLDER|PERSISTENCE|SPEC_GAMING|UI|CONTRACT|OTHER",'
    + '"title":"...","evidence":["文件路径、行号、机器输出或 HTTP 证据"],"recommendation":"..."}],'
    + '"confidence":"high|medium|low"}',
].join("\n");

export function buildReviewMessages(
    ctx: ReviewContext,
    signals: ReviewFinding[],
): { system: string; user: string } {
    const u: string[] = [];
    u.push("## 机械验收结果（原文，不许改写）");
    u.push(ctx.mechanicalText);
    u.push("");
    u.push("## 机器页面探测（真 HTTP 响应）");
    if (ctx.pages.length === 0) u.push("（本轮没有页面探测结果）");
    for (const p of ctx.pages) {
        u.push(`--- ${p.checkId} HTTP ${p.status}`);
        u.push(p.html.slice(0, 8_000));
    }
    u.push("");
    u.push("## 确定性预扫信号（带证据的怀疑；你可以补充或细化，但不得把 critical/major 降级）");
    if (signals.length === 0) u.push("（无）");
    signals.forEach((s, i) => {
        u.push(`${i + 1}. [${s.severity}/${s.category}] ${s.title}`);
        for (const e of s.evidence) u.push(`   - 证据：${e}`);
        u.push(`   - 建议：${s.recommendation}`);
    });
    u.push("");
    u.push("## 项目文件树");
    u.push(ctx.tree.slice(0, 400).join("\n") || "（空）");
    u.push("");
    u.push("## 关键源码（只读快照）");
    for (const s of ctx.sources) {
        u.push(`--- ${s.path}`);
        u.push("```");
        u.push(s.content);
        u.push("```");
    }
    u.push("");
    u.push("## 验收脚本（仅背景参考，不得作为唯一依据；真实项目行为优先）");
    if (ctx.acceptanceScripts.length === 0) u.push("（无可读的验收脚本）");
    for (const s of ctx.acceptanceScripts) {
        u.push(`--- ${s.path}（背景，不代表实现正确）`);
        u.push("```");
        u.push(s.content);
        u.push("```");
    }
    u.push("");
    u.push("## 已知验收固定值（若出现在项目源码里即为规格投机）");
    u.push(ctx.acceptanceLiterals.length > 0 ? ctx.acceptanceLiterals.join("\n") : "（无）");
    return { system: REVIEW_SYSTEM_PROMPT, user: u.join("\n") };
}

// ============================================================
// 输出解析（严格）
// ============================================================

export type ParseReviewResult =
    | { ok: true; review: LlmReview }
    | { ok: false; reason: string };

function asStringArray(v: unknown): string[] | null {
    if (!Array.isArray(v)) return null;
    const out: string[] = [];
    for (const x of v) {
        if (typeof x === "string") { out.push(x); continue; }
        if (x && typeof x === "object") { out.push(JSON.stringify(x)); continue; }
        return null;
    }
    return out;
}

/** 逐字段校验；任何一处不合契约就整体拒绝（不猜、不修、不将就） */
export function parseLlmReview(raw: unknown): ParseReviewResult {
    let v: unknown = raw;
    if (typeof v === "string") v = extractJson(v);
    if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, reason: "不是 JSON 对象" };
    const o = v as Record<string, unknown>;

    const verdict = o["reviewVerdict"];
    if (verdict !== "pass" && verdict !== "fail" && verdict !== "uncertain") {
        return { ok: false, reason: `reviewVerdict 非法：${JSON.stringify(verdict)}` };
    }
    const confidence = o["confidence"];
    if (confidence !== "high" && confidence !== "medium" && confidence !== "low") {
        return { ok: false, reason: `confidence 非法：${JSON.stringify(confidence)}` };
    }
    if (!Array.isArray(o["findings"])) return { ok: false, reason: "findings 必须是数组" };

    const findings: ReviewFinding[] = [];
    for (let i = 0; i < (o["findings"] as unknown[]).length; i++) {
        const f = (o["findings"] as unknown[])[i];
        if (!f || typeof f !== "object" || Array.isArray(f)) return { ok: false, reason: `findings[${i}] 不是对象` };
        const g = f as Record<string, unknown>;
        const severity = g["severity"];
        if (severity !== "critical" && severity !== "major" && severity !== "minor") {
            return { ok: false, reason: `findings[${i}].severity 非法：${JSON.stringify(severity)}` };
        }
        const category = g["category"];
        if (typeof category !== "string" || !(REVIEW_CATEGORIES as readonly string[]).includes(category)) {
            return { ok: false, reason: `findings[${i}].category 非法：${JSON.stringify(category)}` };
        }
        const title = g["title"];
        if (typeof title !== "string" || !title.trim()) return { ok: false, reason: `findings[${i}].title 缺失` };
        const evidence = asStringArray(g["evidence"]);
        if (evidence === null) return { ok: false, reason: `findings[${i}].evidence 必须是字符串数组` };
        const recommendation = g["recommendation"];
        if (typeof recommendation !== "string") return { ok: false, reason: `findings[${i}].recommendation 缺失` };
        findings.push({
            severity, category: category as ReviewCategory, title,
            evidence, recommendation,
        });
    }
    return { ok: true, review: { reviewVerdict: verdict, findings, confidence } };
}

// ============================================================
// 策略裁决（纯函数：这里是"什么才算通过"的唯一出处）
// ============================================================

export function decideReview(mechanicalVerdict: string, audit: ReviewAudit): ReviewDecision {
    const findings: ReviewFinding[] = [...audit.signals, ...(audit.review?.findings ?? [])];
    const blocking = findings.filter((f) => f.severity === "critical" || f.severity === "major");

    if (mechanicalVerdict === "error") {
        return { outcome: "error", reason: "机械验收输入非法——结论不可信，审查不改变这一点", blocking };
    }
    if (mechanicalVerdict === "blocked_unverified") {
        return { outcome: "blocked_unverified", reason: "有判据没被执行——未验证不等于通过", blocking };
    }
    if (mechanicalVerdict === "fail") {
        return { outcome: "fail", reason: "机械验收失败（exitCode 非 0）", blocking };
    }
    if (blocking.length > 0) {
        return {
            outcome: "fail",
            reason: `存在 ${blocking.length} 条阻断性发现（critical/major）：`
                + blocking.map((f) => `${f.severity}/${f.category} ${f.title}`).join("；"),
            blocking,
        };
    }
    if (audit.status !== "ok" || !audit.review) {
        return {
            outcome: "llm_unavailable",
            reason: audit.status === "disabled"
                ? "语义审查未启用——没有审查就不算通过"
                : `语义审查不可用：${audit.reason ?? "未知原因"}——不能当作 pass`,
            blocking,
        };
    }
    if (audit.review.reviewVerdict === "fail") {
        return { outcome: "fail", reason: `语义审查判定不通过（${audit.review.confidence} 置信）`, blocking };
    }
    if (audit.review.reviewVerdict === "uncertain") {
        return { outcome: "uncertain", reason: "语义审查不确定——需要人工确认，不伪装成通过", blocking };
    }
    if (audit.review.confidence === "low") {
        return { outcome: "uncertain", reason: "审查自称通过但置信度低，证据不足，需要人工确认", blocking };
    }
    return { outcome: "pass", reason: "机械验收通过 + 语义审查通过（无阻断性发现）", blocking };
}

// ============================================================
// 审查主流程（模型可注入；默认走真实 HTTP 的 chat 接口，不带任何工具）
// ============================================================

/**
 * 默认审查模型：直接打 OpenAI 兼容的 /chat/completions。
 *   **刻意不用工具链**——请求体里没有 tools 字段，模型在协议层就拿不到任何工具，
 *   所以"不能改项目文件 / 不能改验收脚本"是结构保证，不是提示词保证。
 *   key 或 model 缺失时返回 null → 上层记 LLM_REVIEW_UNAVAILABLE，绝不当通过。
 */
export function createDefaultReviewer(env: Record<string, string | undefined> = process.env): ReviewLlm | null {
    const key = env["DEEPSEEK_API_KEY"] ?? "";
    const base = (env["DEEPSEEK_BASE_URL"] ?? "").replace(/\/+$/, "");
    const model = env["DEFAULT_MODEL"] ?? "";
    if (!key || !model || !base) return null;
    return {
        id: model,
        async complete({ system, user }) {
            const res = await fetch(`${base}/chat/completions`, {
                method: "POST",
                headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
                body: JSON.stringify({
                    model,
                    temperature: 0,
                    response_format: { type: "json_object" },
                    messages: [
                        { role: "system", content: system },
                        { role: "user", content: user },
                    ],
                }),
            });
            if (!res.ok) {
                const body = await res.text().catch(() => "");
                throw new Error(`审查模型 HTTP ${res.status}：${body.slice(0, 300)}`);
            }
            const j = await res.json() as {
                choices?: { message?: { content?: string } }[];
                usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
            };
            const u = j.usage;
            return {
                text: j.choices?.[0]?.message?.content ?? "",
                usage: u
                    ? {
                        inputTokens: u.prompt_tokens ?? 0,
                        outputTokens: u.completion_tokens ?? 0,
                        totalTokens: u.total_tokens ?? 0,
                    }
                    : null,
            };
        },
    };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`审查模型超过 ${ms}ms 未返回（超时）`)), ms);
        p.then(
            (v) => { clearTimeout(timer); resolve(v); },
            (e) => { clearTimeout(timer); reject(e); },
        );
    });
}

export async function runLlmReview(ctx: ReviewContext, opts: ReviewOptions = {}): Promise<ReviewAudit> {
    const signals = prescanReviewSignals(ctx);
    const messages = buildReviewMessages(ctx, signals);
    const promptHash = hashText(`${messages.system}\n\n${messages.user}`);
    const evidenceHash = hashText([
        ctx.mechanicalText,
        JSON.stringify(ctx.pages),
        JSON.stringify(ctx.acceptanceLiterals),
        ctx.tree.join("\n"),
    ].join("\n"));
    const base: Omit<ReviewAudit, "status" | "reason"> = {
        model: opts.llm?.id ?? "",
        promptHash, evidenceHash, durationMs: 0, tokenUsage: null, review: null, signals,
    };

    if (opts.enabled !== true) {
        logLine(opts.log, "未启用（库层默认关闭）——不调用任何模型");
        return { ...base, status: "disabled", reason: "语义审查未启用" };
    }

    const llm = opts.llm ?? createDefaultReviewer();
    if (!llm) {
        logLine(opts.log, "⛔ 未配置审查模型（缺 DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL / DEFAULT_MODEL）");
        return {
            ...base, status: "LLM_REVIEW_UNAVAILABLE",
            reason: "未配置审查模型（缺 DEEPSEEK_API_KEY / DEEPSEEK_BASE_URL / DEFAULT_MODEL）",
        };
    }

    const started = Date.now();
    try {
        const raw = await withTimeout(llm.complete(messages), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        const parsed = parseLlmReview(raw.text);
        const durationMs = Date.now() - started;
        if (!parsed.ok) {
            logLine(opts.log, `⛔ 审查输出不合契约：${parsed.reason}`);
            return {
                ...base, model: llm.id, durationMs, tokenUsage: raw.usage ?? null,
                status: "LLM_REVIEW_UNAVAILABLE",
                reason: `审查输出不符合契约：${parsed.reason}`,
            };
        }
        logLine(opts.log, `✅ 审查完成：${parsed.review.reviewVerdict}/${parsed.review.confidence}`
            + `，findings ${parsed.review.findings.length} 条，预扫信号 ${signals.length} 条，${durationMs}ms`);
        return {
            ...base, model: llm.id, durationMs, tokenUsage: raw.usage ?? null,
            status: "ok", reason: null, review: parsed.review,
        };
    } catch (e) {
        const durationMs = Date.now() - started;
        const msg = String((e as Error)?.message ?? e).slice(0, 300);
        logLine(opts.log, `⛔ 审查不可用：${msg}`);
        return {
            ...base, model: llm.id, durationMs,
            status: "LLM_REVIEW_UNAVAILABLE",
            reason: msg,
        };
    }
}
