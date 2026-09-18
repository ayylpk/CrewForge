// ============================================================
// tests/review.test.ts —— 严格 LLM 审查层（零 LLM + Fake LLM）
//
//   这一层要回答机械验收答不了的问题：状态码对了但页面是假的、编译过了但没真做业务、
//   数据只在内存里、把验收脚本里的固定值抄进代码。分成两半，都能离线测：
//
//     · 确定性预扫（零 LLM）：`prescanReviewSignals` 只产出**带证据的怀疑**，
//       每条都指到文件行号 / HTTP 响应 / 机器输出。它只能**阻止**通过，永远不能授予通过。
//     · 语义审查（Fake LLM）：`runLlmReview` 把上下文交给可注入的模型，输出严格结构化。
//       这里注入 FakeReviewLlm 全程离线，证明管道与裁决规则（而不是证明模型聪明）。
//
//   红线（都在下面有对应断言）：
//     · 机械 verdict 只由 exitCode/evidence/skipped 算；
//     · LLM 不能生成 test_passed；
//     · 没有证据的猜测只能进 uncertain，不能当确定失败；
//     · 任一 critical/major 都阻止通过；
//     · LLM 失败/超时/解析失败 → LLM_REVIEW_UNAVAILABLE，**绝不当成 pass**；
//     · findings 必须全量返回，不能只留第一条；
//     · 审查层没有任何写盘 / 执行工具，跑完项目文件一字不变。
// ============================================================

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    REVIEW_FORBIDDEN_TOOLS, REVIEW_TOOL_NAMES, collectReviewContext, decideReview,
    parseLlmReview, prescanReviewSignals, runLlmReview,
} from "../src/review";
import type { ReviewAudit, ReviewFinding, ReviewLlm, ReviewSignal } from "../src/review";

// ---------- 夹具：临时"目标项目" ----------

let root: string;
const dirs: Record<string, string> = {};

function mkProject(name: string, files: Record<string, string>): string {
    const dir = path.join(root, name);
    for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(dir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, "utf-8");
    }
    dirs[name] = dir;
    return dir;
}

beforeAll(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "ta-review-")); });
// afterAll 给足预算：Windows 上删整棵临时树能超 5s 默认钩子预算
afterAll(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 句柄 */ } }, 30_000);

/** 一条机械证据的最小形状（只喂给上下文，不真跑命令） */
const ev = (checkId: string, over: Record<string, unknown> = {}) => ({
    checkId, category: "RENDER", command: "node", args: ["probe.mjs"], cwd: ".",
    exitCode: 0, startedAt: 1, finishedAt: 2, durationMs: 1, timedOut: false,
    stdout: "", stderr: "", ...over,
});

const mech = (over: Record<string, unknown> = {}) => ({
    verdict: "pass", evidence: [ev("api", { exitCode: 0 })], skipped: [], allFailures: [], ...over,
});

/** 从源码目录收上下文（不跑命令，只读文件） */
function ctxOf(dir: string, over: Record<string, unknown> = {}) {
    return collectReviewContext({
        projectDir: dir,
        mechanical: mech(),
        ...over,
    } as never);
}

const sigOf = (signals: ReviewSignal[], category: string) => signals.filter((s) => s.category === category);
const blockingOf = (findings: ReviewFinding[]) =>
    findings.filter((f) => f.severity === "critical" || f.severity === "major");

// ============================================================
// 一、占位页面（零 LLM）
// ============================================================

describe("review / 占位页面（零 LLM 预扫）", () => {
    test("GET / 只回 OK → PLACEHOLDER critical", () => {
        const dir = mkProject("page-ok", { "backend/dist/index.js": "// server\n" });
        const ctx = ctxOf(dir, {
            pages: [{ checkId: "frontend-pages", status: 200, html: "OK" }],
        });
        const s = sigOf(prescanReviewSignals(ctx), "PLACEHOLDER");
        expect(s.length).toBeGreaterThan(0);
        expect(s[0]!.severity).toBe("critical");
        // 证据必须能指回机器输出，不是空口怀疑
        expect(s[0]!.evidence.join(" ")).toContain("frontend-pages");
    });

    test("Login page placeholder → PLACEHOLDER critical", () => {
        const dir = mkProject("page-login-ph", { "frontend/dist/index.html": "<div id=\"app\"></div>" });
        const ctx = ctxOf(dir, {
            pages: [{ checkId: "frontend-pages", status: 200, html: "Login page placeholder" }],
        });
        const s = sigOf(prescanReviewSignals(ctx), "PLACEHOLDER");
        expect(s.length).toBeGreaterThan(0);
        expect(s[0]!.severity).toBe("critical");
    });

    test("HTTP 200 但整站没有任何表单 / 按钮 / 导航 / 业务内容 → UI major", () => {
        const dir = mkProject("page-empty", {
            // SPA 的空挂载点本身不算罪（那是正常的）；罪在整站两头都找不到真实结构
            "frontend/src/main.ts": "import { createApp } from 'vue';\ncreateApp({}).mount('#app');\n",
            "frontend/dist/index.html": '<div id="app"></div>',
        });
        const ctx = ctxOf(dir, {
            pages: [{
                checkId: "frontend-pages", status: 200,
                html: '<!DOCTYPE html><html><body><div id="app"></div><script src="/a.js"></script></body></html>',
            }],
        });
        const s = sigOf(prescanReviewSignals(ctx), "UI");
        expect(s.length).toBeGreaterThan(0);
        expect(blockingOf(s).length).toBeGreaterThan(0);
        expect(s[0]!.evidence.length).toBeGreaterThan(0);
    });

    test("纯空 div 且没有任何脚本 → PLACEHOLDER critical（页面不可能有内容）", () => {
        const dir = mkProject("page-bare", { "frontend/src/main.ts": "export const x = 1;\n" });
        const ctx = ctxOf(dir, {
            pages: [{ checkId: "frontend-pages", status: 200, html: '<!DOCTYPE html><html><body><div id="app"></div></body></html>' }],
        });
        const s = sigOf(prescanReviewSignals(ctx), "PLACEHOLDER");
        expect(s.length).toBeGreaterThan(0);
        expect(s[0]!.severity).toBe("critical");
    });

    test("完整真实表单页面 → 无 critical/major（不误杀）", () => {
        const dir = mkProject("page-real", {
            "frontend/dist/index.html": '<!DOCTYPE html><html><body><div id="app"></div><script type="module" src="/assets/index.js"></script></body></html>',
            "frontend/src/views/ProjectsView.vue": [
                "<template><section class=\"projects-list\">",
                "  <nav>导航</nav>",
                "  <form @submit.prevent=\"createProject\"><input v-model=\"draft.title\" placeholder=\"新项目标题\" /><button type=\"submit\">创建</button></form>",
                "  <ul><li v-for=\"p in items\" :key=\"p.id\">{{ p.title }}</li></ul>",
                "  <p v-if=\"loading\">加载中…</p>",
                "</section></template>",
            ].join("\n"),
        });
        const ctx = ctxOf(dir, {
            pages: [{
                checkId: "frontend-pages", status: 200,
                html: '<!DOCTYPE html><html><body><div id="app"></div><script type="module" src="/assets/index.js"></script></body></html>',
            }],
        });
        const blocking = blockingOf(prescanReviewSignals(ctx));
        expect(blocking).toEqual([]);
    });
});

// ============================================================
// 二、持久化（零 LLM）
// ============================================================

describe("review / 持久化（零 LLM 预扫）", () => {
    test("模块级内存数组冒充数据库 → PERSISTENCE major", () => {
        const dir = mkProject("mem-array", {
            "backend/src/store.js": [
                "const projects = [];",                        // 模块级可变集合
                "export function addProject(p) { projects.push(p); }",
                "export function listProjects() { return projects; }",
            ].join("\n"),
        });
        const ctx = ctxOf(dir, { requiresPersistence: true });
        const s = sigOf(prescanReviewSignals(ctx), "PERSISTENCE");
        expect(s.length).toBeGreaterThan(0);
        expect(s[0]!.severity).toBe("major");
        expect(s[0]!.evidence.join(" ")).toContain("store.js:1");
    });

    test("真 sqlite 持久化 → 无 PERSISTENCE 信号", () => {
        const dir = mkProject("real-db", {
            "backend/src/db.js": [
                "import { DatabaseSync } from 'node:sqlite';",
                "const db = new DatabaseSync('./data/app.db');",
                "db.exec('CREATE TABLE IF NOT EXISTS project (id INTEGER PRIMARY KEY, title TEXT)');",
                "export function addProject(p) { db.prepare('INSERT INTO project (title) VALUES (?)').run(p.title); }",
                "export function listProjects() { return db.prepare('SELECT * FROM project').all(); }",
            ].join("\n"),
        });
        const ctx = ctxOf(dir, { requiresPersistence: true });
        expect(sigOf(prescanReviewSignals(ctx), "PERSISTENCE")).toEqual([]);
    });
});

// ============================================================
// 三、规格投机（零 LLM）
// ============================================================

describe("review / 规格投机（零 LLM 预扫）", () => {
    test("源码里出现验收脚本的固定值 → SPEC_GAMING critical", () => {
        const dir = mkProject("seed-literal", {
            "backend/src/seed.js": [
                "const SEED = [",
                "  { title: 'CrewForge 多 Agent 编程平台', slug: 'crewforge' },",
                "  { title: 'Hina AI 陪伴应用', slug: 'hina' },",
                "];",
                "export function bootstrap(db) { for (const s of SEED) db.insert(s); }",
            ].join("\n"),
        });
        const ctx = ctxOf(dir, {
            acceptanceLiterals: ["CrewForge 多 Agent 编程平台", "crewforge", "hina"],
        });
        const s = sigOf(prescanReviewSignals(ctx), "SPEC_GAMING");
        expect(s.length).toBeGreaterThan(0);
        expect(s.some((x) => x.severity === "critical")).toBe(true);
        expect(s[0]!.evidence.join(" ")).toContain("seed.js:");
    });

    test("迁移 / 引导代码里 INSERT 内联字面量 → SPEC_GAMING major", () => {
        const dir = mkProject("seed-insert", {
            "backend/src/migrate.js": [
                "export function migrate(db) {",
                "  db.exec(\"CREATE TABLE IF NOT EXISTS project (id INTEGER PRIMARY KEY, slug TEXT)\");",
                "  db.exec(\"INSERT INTO project (slug) VALUES ('alpha-one'), ('hidden-one')\");",
                "}",
            ].join("\n"),
        });
        const ctx = ctxOf(dir, { requiresPersistence: true });
        const s = sigOf(prescanReviewSignals(ctx), "SPEC_GAMING");
        expect(s.length).toBeGreaterThan(0);
        expect(blockingOf(s).length).toBeGreaterThan(0);
    });

    test("吞掉异常 / 空实现 → OTHER，且带证据", () => {
        const dir = mkProject("swallow", {
            "backend/src/handler.js": [
                "export function save(p) {",
                "  try { persist(p); } catch { /* 吞掉 */ }",
                "  return true;",
                "}",
                "export function notYet() { /* TODO */ }",
            ].join("\n"),
        });
        const ctx = ctxOf(dir, {});
        const s = sigOf(prescanReviewSignals(ctx), "OTHER");
        expect(s.length).toBeGreaterThan(0);
        expect(s.every((x) => x.evidence.length > 0)).toBe(true);
    });
});

// ============================================================
// 四、Fake LLM：管道 + 裁决规则
// ============================================================

/** 假模型：脚本化回复，可观察收到的 prompt */
function fakeLlm(script: {
    text?: string; fail?: string; hangMs?: number;
    usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}): ReviewLlm & { calls: number; lastUser: string } {
    const self = {
        id: "fake-reviewer",
        calls: 0,
        lastUser: "",
        async complete(input: { system: string; user: string }) {
            self.calls++;
            self.lastUser = input.user;
            if (script.hangMs) await new Promise((r) => setTimeout(r, script.hangMs));
            if (script.fail) throw new Error(script.fail);
            return { text: script.text ?? '{"reviewVerdict":"pass","findings":[],"confidence":"high"}', usage: script.usage ?? null };
        },
    };
    return self;
}

const AUDIT_DIR = () => mkProject("audit", { "backend/src/app.js": "export const app = 1;\n" });

const finding = (sev: string, cat: string, title: string): Record<string, unknown> => ({
    severity: sev, category: cat, title,
    evidence: ["backend/src/app.js:1 机器输出示例"], recommendation: "改成真实实现",
});

describe("review / Fake LLM 语义审查", () => {
    test("findings 必须全量返回，不能只留第一条", async () => {
        const ctx = ctxOf(AUDIT_DIR(), {});
        const llm = fakeLlm({
            text: JSON.stringify({
                reviewVerdict: "fail", confidence: "high",
                findings: [
                    finding("major", "PLACEHOLDER", "首页是占位页"),
                    finding("major", "PERSISTENCE", "数据只在内存"),
                    finding("minor", "OTHER", "缺错误日志"),
                ],
            }),
        });
        const audit = await runLlmReview(ctx, { llm, enabled: true });
        expect(audit.status).toBe("ok");
        expect(audit.review?.findings.length).toBe(3);
        expect(audit.review?.findings.map((f) => f.title)).toEqual(["首页是占位页", "数据只在内存", "缺错误日志"]);
    });

    test("没有证据的猜测只能是 uncertain，不能当确定失败", () => {
        const ctx = ctxOf(AUDIT_DIR(), {});
        const audit: ReviewAudit = {
            status: "ok", reason: null, model: "m", promptHash: "p", evidenceHash: "e",
            durationMs: 1, tokenUsage: null, signals: [],
            review: {
                reviewVerdict: "uncertain", confidence: "low",
                findings: [{ severity: "minor", category: "OTHER", title: "怀疑（无证据）", evidence: [], recommendation: "人工确认" }],
            },
        };
        const d = decideReview("pass", audit);
        expect(d.outcome).toBe("uncertain");
        expect(d.blocking).toEqual([]);          // minor 不阻止，但也不允许通过
    });

    test("pass + low confidence → 不授予通过（uncertain）", async () => {
        const ctx = ctxOf(AUDIT_DIR(), {});
        const audit = await runLlmReview(ctx, {
            llm: fakeLlm({ text: '{"reviewVerdict":"pass","findings":[],"confidence":"low"}' }),
            enabled: true,
        });
        expect(decideReview("pass", audit).outcome).toBe("uncertain");
    });

    test("LLM 抛错 → LLM_REVIEW_UNAVAILABLE，且绝不当作 pass", async () => {
        const ctx = ctxOf(AUDIT_DIR(), {});
        const audit = await runLlmReview(ctx, { llm: fakeLlm({ fail: "402 余额不足" }), enabled: true });
        expect(audit.status).toBe("LLM_REVIEW_UNAVAILABLE");
        expect(audit.review).toBeNull();
        expect(audit.reason).toContain("402");
        expect(decideReview("pass", audit).outcome).toBe("llm_unavailable");
    });

    test("LLM 超时 → LLM_REVIEW_UNAVAILABLE", async () => {
        const ctx = ctxOf(AUDIT_DIR(), {});
        const audit = await runLlmReview(ctx, { llm: fakeLlm({ hangMs: 300 }), enabled: true, timeoutMs: 50 });
        expect(audit.status).toBe("LLM_REVIEW_UNAVAILABLE");
        expect(audit.reason).toMatch(/超时|timeout/i);
    });

    test("LLM 输出非法 JSON / 结构不符 → LLM_REVIEW_UNAVAILABLE", async () => {
        const ctx = ctxOf(AUDIT_DIR(), {});
        const a = await runLlmReview(ctx, { llm: fakeLlm({ text: "我觉得应该没问题" }), enabled: true });
        expect(a.status).toBe("LLM_REVIEW_UNAVAILABLE");
        const b = await runLlmReview(ctx, {
            llm: fakeLlm({ text: '{"reviewVerdict":"PASS","findings":[],"confidence":"high"}' }), enabled: true,
        });
        expect(b.status).toBe("LLM_REVIEW_UNAVAILABLE");   // 大小写不符 = 不合契约，不猜
    });

    test("审查关闭 / 未启用 → status=disabled，不调用模型", async () => {
        const ctx = ctxOf(AUDIT_DIR(), {});
        const llm = fakeLlm({});
        const audit = await runLlmReview(ctx, { llm, enabled: false });
        expect(audit.status).toBe("disabled");
        expect(llm.calls).toBe(0);
        expect(decideReview("pass", audit).outcome).toBe("llm_unavailable");
    });

    test("审计字段齐全（promptHash / evidenceHash / model / duration / tokenUsage）", async () => {
        const ctx = ctxOf(AUDIT_DIR(), {});
        const audit = await runLlmReview(ctx, {
            llm: fakeLlm({ usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 } }),
            enabled: true,
        });
        expect(audit.model).toBe("fake-reviewer");
        expect(audit.promptHash).toMatch(/^[0-9a-f]{8,}$/);
        expect(audit.evidenceHash).toMatch(/^[0-9a-f]{8,}$/);
        expect(typeof audit.durationMs).toBe("number");
        expect(audit.tokenUsage?.totalTokens).toBe(150);
        // 同一份上下文 → 同一个 promptHash（可复核）
        const again = await runLlmReview(ctx, { llm: fakeLlm({}), enabled: true });
        expect(again.promptHash).toBe(audit.promptHash);
    });

    test("送进模型的 prompt 里带机械证据，且明确验收脚本只是背景", async () => {
        const dir = mkProject("prompt-check", {
            "backend/src/app.js": "export const app = 1;\n",
            "scripts/verify-p1-api.mjs": "console.log('verify');\n",
        });
        const ctx = collectReviewContext({
            projectDir: dir,
            mechanical: mech({ evidence: [ev("api", { stdout: "MACHINE-OUTPUT-MARKER", exitCode: 1 })] }),
        } as never);
        const llm = fakeLlm({});
        await runLlmReview(ctx, { llm, enabled: true });
        expect(llm.lastUser).toContain("MACHINE-OUTPUT-MARKER");
        expect(llm.lastUser).toContain("verify-p1-api.mjs");
        expect(llm.lastUser).toMatch(/背景|不得作为唯一依据/);
    });
});

// ============================================================
// 五、裁决策略（纯函数）
// ============================================================

const auditWith = (o: Partial<ReviewAudit>): ReviewAudit => ({
    status: "ok", reason: null, model: "m", promptHash: "p", evidenceHash: "e",
    durationMs: 1, tokenUsage: null, signals: [], review: null, ...o,
});

describe("review / 裁决策略", () => {
    test("机械 fail + LLM 发现 → fail，且 LLM findings 全部保留", () => {
        const d = decideReview("fail", auditWith({
            review: {
                reviewVerdict: "fail", confidence: "high",
                findings: [finding("major", "CONTRACT", "响应结构不符"), finding("minor", "UI", "次要")] as never,
            },
        }));
        expect(d.outcome).toBe("fail");
        expect(d.blocking.map((f) => f.title)).toEqual(["响应结构不符"]);
    });

    test("机械 pass 但 LLM 发现 critical → 最终不能 pass", () => {
        const d = decideReview("pass", auditWith({
            review: {
                reviewVerdict: "pass", confidence: "high",     // 模型嘴上说通过
                findings: [finding("critical", "SPEC_GAMING", "写了固定验收值的特殊分支")] as never,
            },
        }));
        expect(d.outcome).toBe("fail");
        expect(d.blocking.length).toBe(1);
    });

    test("机械 pass + reviewVerdict=fail（无 critical/major）→ fail", () => {
        expect(decideReview("pass", auditWith({
            review: {
                reviewVerdict: "fail", confidence: "medium",
                findings: [finding("minor", "OTHER", "小问题")] as never,
            },
        })).outcome).toBe("fail");
    });

    test("机械 pass + reviewVerdict=uncertain → uncertain（不伪装成通过）", () => {
        expect(decideReview("pass", auditWith({
            review: { reviewVerdict: "uncertain", confidence: "medium", findings: [] as never },
        })).outcome).toBe("uncertain");
    });

    test("机械 pass + review ok + pass + high，且无阻塞 → pass", () => {
        const d = decideReview("pass", auditWith({
            review: { reviewVerdict: "pass", confidence: "high", findings: [finding("minor", "OTHER", "小问题")] as never },
        }));
        expect(d.outcome).toBe("pass");
        expect(d.blocking).toEqual([]);
    });

    test("预扫的 critical 阻止通过——模型说 pass 也压不下去（error 不许降级成 warning）", () => {
        const d = decideReview("pass", auditWith({
            signals: [finding("critical", "PLACEHOLDER", "首页只回 OK") as never],
            review: { reviewVerdict: "pass", confidence: "high", findings: [] as never },
        }));
        expect(d.outcome).toBe("fail");
        expect(d.blocking.map((f) => f.title)).toContain("首页只回 OK");
    });

    test("blocked_unverified / error 原样透传，既不冒充 pass 也不冒充 fail", () => {
        expect(decideReview("blocked_unverified", auditWith({})).outcome).toBe("blocked_unverified");
        expect(decideReview("error", auditWith({})).outcome).toBe("error");
    });
});

// ============================================================
// 六、只读与"没有任何工具"（红线）
// ============================================================

describe("review / 红线：只读、无工具、不改验收面", () => {
    test("审查层不暴露任何工具（没有 writeFile / shell / mkdir…）", () => {
        expect(REVIEW_TOOL_NAMES).toEqual([]);
        for (const t of ["writeFile", "editFile", "mkdir", "shell", "runCommand", "startProcess", "stopProcess"]) {
            expect(REVIEW_FORBIDDEN_TOOLS).toContain(t);
        }
    });

    test("src/review.ts 结构上不含任何写盘 / 执行调用（只读）", () => {
        const src = fs.readFileSync(path.join(import.meta.dir, "..", "src", "review.ts"), "utf-8");
        // ① 不得调用任何写盘 / 改名 / 删除接口
        expect(src).not.toMatch(
            /(?:\bfs\.)?(?:writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|unlink|unlinkSync|rmdir|rmdirSync|rmSync|rename|renameSync|copyFile)\s*\(/,
        );
        expect(src).not.toMatch(/(?:\bfs\.)?(?:createWriteStream|truncate|chmod|symlink)\s*\(/);
        // ② 不得引入子进程 / 模型工具链
        expect(src).not.toMatch(/from\s+["']node:child_process["']/);
        expect(src).not.toContain("langchain");
        // ③ fs 的用法只允许读
        const fsCalls = [...src.matchAll(/\bfs\.(\w+)\s*\(/g)].map((m) => m[1]);
        const READ_ONLY = ["readFileSync", "readdirSync", "statSync", "existsSync", "lstatSync"];
        expect(fsCalls.length).toBeGreaterThan(0);
        expect(fsCalls.filter((n) => !READ_ONLY.includes(n as string))).toEqual([]);
    });

    test("审查只读：跑完一轮，项目文件一字未变（无新增、无改动、无删除）", async () => {
        const proj = path.join(root, "readonly-proj");
        fs.mkdirSync(path.join(proj, "backend", "src"), { recursive: true });
        fs.writeFileSync(path.join(proj, "backend", "src", "app.js"), "export const app = 1;\n");
        fs.writeFileSync(path.join(proj, "CONTRACTS.md"), "# 契约\n");
        const snapshot = (): Map<string, string> => {
            const m = new Map<string, string>();
            const walk = (d: string): void => {
                for (const f of fs.readdirSync(d, { withFileTypes: true })) {
                    const p = path.join(d, f.name);
                    if (f.isDirectory()) walk(p);
                    else m.set(p, Bun.hash(fs.readFileSync(p)).toString());
                }
            };
            walk(proj);
            return m;
        };
        const before = snapshot();
        const ctx = ctxOf(proj, {});
        prescanReviewSignals(ctx);
        await runLlmReview(ctx, { llm: fakeLlm({ text: '{"reviewVerdict":"fail","findings":[],"confidence":"high"}' }), enabled: true });
        const after = snapshot();
        expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
        for (const [p, h] of before) expect(after.get(p)).toBe(h);
    });

    test("结构校验：parseLlmReview 拒绝非法严重度 / 类别 / 缺字段", () => {
        expect(parseLlmReview(null).ok).toBe(false);
        expect(parseLlmReview({ reviewVerdict: "pass" }).ok).toBe(false);              // 缺 confidence
        expect(parseLlmReview({ reviewVerdict: "pass", findings: "nope", confidence: "high" }).ok).toBe(false);
        const badSev = parseLlmReview({
            reviewVerdict: "fail", confidence: "high",
            findings: [{ severity: "blocker", category: "PLACEHOLDER", title: "t", evidence: [], recommendation: "r" }],
        });
        expect(badSev.ok).toBe(false);
        const badCat = parseLlmReview({
            reviewVerdict: "fail", confidence: "high",
            findings: [{ severity: "major", category: "WHATEVER", title: "t", evidence: [], recommendation: "r" }],
        });
        expect(badCat.ok).toBe(false);
        // 合法：允许 evidence 为空（无证据 → 由策略压成 uncertain，不在这里吞掉）
        const ok = parseLlmReview({
            reviewVerdict: "uncertain", confidence: "low",
            findings: [{ severity: "minor", category: "OTHER", title: "t", evidence: [], recommendation: "r" }],
        });
        expect(ok.ok).toBe(true);
    });
});
