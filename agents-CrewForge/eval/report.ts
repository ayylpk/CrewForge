// ============================================================
// eval/report.ts —— 把各场景的 result.json 汇总成 baseline/before.json + before.md
//
//   用法（cwd = agents-CrewForge）：
//     bun run eval/report.ts                 # 重新探环境 + 汇总
//     bun run eval/report.ts --reuse-env     # 复用已有 baseline/env.json（不再起子进程）
//
//   纪律：
//     · before.json **完全机器生成**，字段稳定，不含任何手写结论
//     · 任何 "pass" 都来自 result.json 里绑定了命令与退出码的检查（runner.ts 已强制）
//     · blocked / fail / skipped 原样搬运，绝不折算
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { probeEnvironment } from "./harness/env";
import type { EnvironmentReport, ScenarioResult } from "./harness/types";

const EVAL_DIR = import.meta.dir;
const RUNS_DIR = path.join(EVAL_DIR, "baseline", "runs");
const OUT_DIR = path.join(EVAL_DIR, "baseline");

interface DerivedSignals {
    derivedFrom: string;
    llmRetryAttempts: number;
    llmRetryExhausted: number;
    revisionMentions: number;
    failureLines: number;
    note: string;
}

type DocScenario = ScenarioResult & { derivedFromLogs: DerivedSignals };

interface BaselineDoc {
    schemaVersion: string;
    kind: string;
    generatedAt: string;
    generator: string;
    note: string;
    system: { repo: string; engine: string; pipelineEntry: string; stack: string; invariants: string[] };
    environment: EnvironmentReport;
    scenarios: DocScenario[];
    summary: {
        scenarioCount: number;
        byVerdict: Record<string, number>;
        checkTotals: Record<string, number>;
        endToEndDelivered: string[];
        realFailures: string[];
        blockedOrPartial: string[];
        fakePassDetected: string[];
        honestStatement: string;
    };
}

/** 从旧系统 stdout 日志里数机器信号（不是判定依据，只作观测：旧系统本身不统计重试） */
function deriveSignals(stdoutFile: string): DerivedSignals {
    let text = "";
    try { text = fs.readFileSync(stdoutFile, "utf-8"); } catch { /* 日志不可读 */ }
    const count = (re: RegExp) => (text.match(re) ?? []).length;
    return {
        derivedFrom: stdoutFile,
        llmRetryAttempts: count(/LLM 失败（第 \d+ 次）/g),
        llmRetryExhausted: count(/重试耗尽/g),
        revisionMentions: count(/revision/gi),
        failureLines: count(/失败/g),
        note: "以上计数由日志正则计数得到——只作观测，不参与任何 pass/fail 判定；旧系统自身不产出 token/重试计数",
    };
}

function hasFlag(n: string): boolean { return process.argv.includes(n); }

function loadResults(): ScenarioResult[] {
    if (!fs.existsSync(RUNS_DIR)) return [];
    const out: ScenarioResult[] = [];
    for (const id of fs.readdirSync(RUNS_DIR).sort()) {
        const f = path.join(RUNS_DIR, id, "result.json");
        if (!fs.existsSync(f)) continue;
        try { out.push(JSON.parse(fs.readFileSync(f, "utf-8")) as ScenarioResult); } catch { /* 坏 JSON 跳过 */ }
    }
    return out;
}

function buildHonestStatement(n: number, delivered: string[], failed: string[], blocked: string[], fakePass: string[]): string {
    const parts: string[] = [];
    parts.push(`共 ${n} 个冻结场景。`);
    parts.push(delivered.length ? `真实端到端跑通（全部必需检查通过）：${delivered.join("、")}。` : "没有任何场景达成端到端跑通（前端 build + 后端启动 + HTTP 断言 + 渲染断言全过）。");
    parts.push(failed.length ? `存在真实失败：${failed.join("、")}。` : "无真实失败记录。");
    parts.push(blocked.length ? `存在无法判定（环境或产物缺失）：${blocked.join("、")}。` : "无无法判定项。");
    parts.push(fakePass.length ? `⚠️ 检出假通过（系统报 done+verified 但有真实断言失败）：${fakePass.join("、")}。` : "未检出假通过。");
    return parts.join("");
}

function renderMarkdown(doc: BaselineDoc): string {
    const L: string[] = [];
    const env = doc.environment;
    L.push("# 阶段 0 基线报告（before）");
    L.push("");
    L.push(`- 生成时间：${doc.generatedAt}`);
    L.push("- 生成方式：**机器生成**（`eval/report.ts`，数据源 `eval/baseline/runs/*/result.json`）");
    L.push(`- 被评对象：\`${doc.system.engine}/${doc.system.pipelineEntry}\`（未改写控制流、未删旧代码）`);
    L.push(`- 判定纪律：${doc.system.invariants.join("；")}`);
    L.push("");
    L.push("## 0. 一句话结论");
    L.push("");
    L.push(doc.summary.honestStatement);
    L.push("");

    L.push("## 1. 环境事实（真跑命令得到）");
    L.push("");
    L.push("| 工具 | 命令 | exit | 版本/输出 |");
    L.push("|---|---|---|---|");
    for (const t of env.tools) {
        L.push(`| ${t.name} | \`${t.command}\` | ${t.exitCode ?? "n/a"} | ${(t.versionLine ?? "").replace(/\|/g, "\\|").slice(0, 90)} |`);
    }
    L.push("");
    L.push("| 服务 | 探针 | 可达 | 证据 |");
    L.push("|---|---|---|---|");
    for (const s of env.services) {
        L.push(`| ${s.name} | \`${s.probe}\` | ${s.reachable === null ? "n/a" : s.reachable ? "是" : "否"} | ${s.evidence.replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 180)} |`);
    }
    L.push("");
    L.push(`- 模型端点：${env.llm.endpoint ?? "n/a"}（model=${env.llm.model ?? "n/a"}）可达=${env.llm.reachable ? "是" : "否"}`);
    L.push(`- 探针原文：${env.llm.evidence.replace(/\n/g, " ").slice(0, 300)}`);
    L.push("");
    if (env.limitations.length) {
        L.push("### 环境缺口及其影响");
        L.push("");
        L.push("| 缺口 | 缺什么 | 影响哪些判定 | 证据 |");
        L.push("|---|---|---|---|");
        for (const l of env.limitations) {
            L.push(`| ${l.id} | ${l.missing} | ${l.impact} | ${l.evidence.replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 220)} |`);
        }
        L.push("");
    }

    L.push("## 2. 场景总览");
    L.push("");
    L.push("| 场景 | 类型 | 旧系统 exit | 耗时 | DB 终态 | run 级验证 | 通过/失败/无法判定 | 结论 |");
    L.push("|---|---|---|---|---|---|---|---|");
    for (const s of doc.scenarios) {
        const p = s.pipeline;
        const pass = s.checks.filter(c => c.status === "pass").length;
        const fail = s.checks.filter(c => c.status === "fail").length;
        const blk = s.checks.filter(c => c.status === "blocked").length;
        L.push(`| ${s.scenarioId} | ${s.kind} | ${p.exitCode}${p.timedOut ? " (TIMEOUT)" : ""} | ${Math.round(p.durationMs / 1000)}s | ${p.dbFinalStatus ?? "n/a"} | ${p.verifyOutcome ?? "无报告"} | ${pass}/${fail}/${blk} | **${s.verdict.overall}** |`);
    }
    L.push("");
    L.push(`- 汇总：${JSON.stringify(doc.summary.byVerdict)}；检查项合计 ${JSON.stringify(doc.summary.checkTotals)}`);
    L.push(`- 端到端跑通：${doc.summary.endToEndDelivered.length ? doc.summary.endToEndDelivered.join("、") : "**无**"}`);
    L.push(`- 假通过：${doc.summary.fakePassDetected.length ? "**" + doc.summary.fakePassDetected.join("、") + "**" : "无"}`);
    L.push("");

    doc.scenarios.forEach((s, i) => {
        L.push(`## 3.${i + 1} 场景 ${s.scenarioId}：${s.title}`);
        L.push("");
        L.push(`- 冻结输入：\`${s.inputFile}\`；机器期望：\`${s.expectedFile}\``);
        L.push(`- 旧系统命令：\`${s.pipeline.command}\`（cwd=\`${s.pipeline.cwd}\`）`);
        L.push(`- 起止：${s.pipeline.startedAt} → ${s.pipeline.finishedAt}（${Math.round(s.pipeline.durationMs / 1000)}s），exit=${s.pipeline.exitCode}${s.pipeline.timedOut ? "，**超时被杀**" : ""}`);
        L.push(`- 落库结果：status=${s.pipeline.dbFinalStatus ?? "n/a"}；任务 ${JSON.stringify(s.pipeline.dbTasks)}`);
        L.push(`- run 级验证：${s.pipeline.verifyOutcome ?? "**无报告**"}${s.pipeline.verifySummary ? ` — ${s.pipeline.verifySummary}` : ""}`);
        L.push(`- 重试次数：${s.pipeline.retries === null ? "系统无计数" : s.pipeline.retries}；日志派生的观测计数：LLM 重试尝试 ${s.derivedFromLogs.llmRetryAttempts} 次、重试耗尽 ${s.derivedFromLogs.llmRetryExhausted} 次、revision 提及 ${s.derivedFromLogs.revisionMentions} 次、含「失败」行 ${s.derivedFromLogs.failureLines} 行`);
        L.push(`- token：${s.pipeline.tokenUsage.available ? JSON.stringify(s.pipeline.tokenUsage) : s.pipeline.tokenUsage.note}`);
        L.push(`- 产物树：\`${s.artifacts.dir}\`（${s.artifacts.exists ? `${s.artifacts.fileCount} 个文件` : "**不存在**"}）`);
        if (s.artifacts.exists) {
            L.push(`  - 顶层目录：${s.artifacts.topLevelDirs.join(" / ") || "(空)"}`);
            L.push(`  - 扩展名分布：${Object.entries(s.artifacts.byExt).map(([k, v]) => `${k}:${v}`).join(" ")}`);
        }
        L.push("");
        L.push("| 检查 | 类型 | 结论 | 命令 | exit | HTTP | 说明 |");
        L.push("|---|---|---|---|---|---|---|");
        for (const c of s.checks) {
            L.push(`| ${c.id} | ${c.kind} | **${c.status}** | \`${(c.command ?? "").replace(/\|/g, "\\|").slice(0, 120)}\` | ${c.exitCode ?? "n/a"} | ${c.httpStatus ?? "n/a"}${c.expectStatus != null ? `/${c.expectStatus}` : ""} | ${c.detail.replace(/\|/g, "\\|").slice(0, 180)} |`);
        }
        L.push("");
        L.push(`判定：**${s.verdict.overall}** — ${s.verdict.reason}`);
        L.push("");
        L.push("<details><summary>证据摘录（stdout 尾部原文）</summary>");
        L.push("");
        L.push("```");
        L.push(s.pipeline.stdoutTail.slice(0, 2500));
        L.push("```");
        if (s.pipeline.stderrTail.trim()) {
            L.push("stderr 尾部：");
            L.push("```");
            L.push(s.pipeline.stderrTail.slice(0, 1200));
            L.push("```");
        }
        L.push("</details>");
        L.push("");
    });

    L.push("## 4. 机器可读结果位置");
    L.push("");
    L.push("- 汇总：`eval/baseline/before.json`（本报告的机器版）");
    L.push("- 环境：`eval/baseline/env.json`");
    L.push("- 逐场景：`eval/baseline/runs/<场景>/result.json`");
    L.push("- 原始日志：`eval/baseline/runs/<场景>/logs/`");
    L.push("");
    return L.join("\n");
}

async function main(): Promise<void> {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const envFile = path.join(OUT_DIR, "env.json");

    let env: EnvironmentReport;
    if (hasFlag("--reuse-env") && fs.existsSync(envFile)) {
        env = JSON.parse(fs.readFileSync(envFile, "utf-8")) as EnvironmentReport;
    } else {
        env = await probeEnvironment(path.join(OUT_DIR, "env-logs"));
        fs.writeFileSync(envFile, JSON.stringify(env, null, 2), "utf-8");
    }

    const results = loadResults();
    const checkTotals: Record<string, number> = { pass: 0, fail: 0, blocked: 0, skipped: 0 };
    const byVerdict: Record<string, number> = { pass: 0, fail: 0, blocked: 0, partial: 0 };

    for (const r of results) {
        byVerdict[r.verdict.overall] = (byVerdict[r.verdict.overall] ?? 0) + 1;
        for (const c of r.checks) checkTotals[c.status] = (checkTotals[c.status] ?? 0) + 1;
    }

    const fakePass = results.filter(s => s.verdict.fakePass).map(s => s.scenarioId);
    const delivered = results.filter(s => s.verdict.overall === "pass" && !s.expectFailure).map(s => s.scenarioId);
    const realFails = results.filter(s => s.verdict.overall === "fail").map(s => s.scenarioId);
    const blockedOnly = results.filter(s => s.verdict.overall === "blocked" || s.verdict.overall === "partial").map(s => s.scenarioId);

    const doc: BaselineDoc = {
        schemaVersion: "crewforge.eval.baseline/1",
        kind: "baseline-before",
        generatedAt: new Date().toISOString(),
        generator: "agents-CrewForge/eval/report.ts",
        note: "阶段 0 基线：用【当前旧系统】跑冻结场景得到的真实结果。未改写控制流、未删除旧代码。所有 pass 都绑定真实命令与退出码（由 runner.ts 的 assertPassIsBound 强制）。",
        system: {
            repo: path.resolve(EVAL_DIR, "..", ".."),
            engine: "agents-CrewForge",
            pipelineEntry: "projectRunner.ts",
            stack: "Vue 3 + Vite / Spring Boot 3 / MySQL 8",
            invariants: [
                "判定只来自命令与退出码",
                "静态检查与 LLM 文字不得单独产生 pass",
                "未能判定一律 blocked（未验证 ≠ 通过）",
            ],
        },
        environment: env,
        scenarios: results.map(r => ({ ...r, derivedFromLogs: deriveSignals(r.pipeline.stdoutFile) })),
        summary: {
            scenarioCount: results.length,
            byVerdict,
            checkTotals,
            endToEndDelivered: delivered,
            realFailures: realFails,
            blockedOrPartial: blockedOnly,
            fakePassDetected: fakePass,
            honestStatement: buildHonestStatement(results.length, delivered, realFails, blockedOnly, fakePass),
        },
    };

    const beforeJson = path.join(OUT_DIR, "before.json");
    fs.writeFileSync(beforeJson, JSON.stringify(doc, null, 2), "utf-8");
    console.log(`[report] 已写出 ${beforeJson}`);

    const beforeMd = path.join(OUT_DIR, "before.md");
    fs.writeFileSync(beforeMd, renderMarkdown(doc), "utf-8");
    console.log(`[report] 已写出 ${beforeMd}`);
}

await main();
