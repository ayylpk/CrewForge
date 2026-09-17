// ============================================================
// eval/runner.ts —— 阶段 0 基线跑法（阶段 0 唯一入口，可重复执行）
//
//   用法（cwd = agents-CrewForge）：
//     bun run eval/runner.ts --validate                  # 只校验冻结场景夹具，不开工、不调 LLM
//     bun run eval/runner.ts --scenario s1-crud-min      # 跑一个场景：旧系统 + 构建/启动/HTTP/渲染
//     bun run eval/runner.ts --all                       # 跑全部场景（串行）
//     bun run eval/runner.ts --scenario s1-crud-min --reuse-run   # 复用已有 pipeline 产物，只重跑检查
//     bun run eval/runner.ts --scenario s1-crud-min --phase run   # 只驱动旧系统（不跑检查）
//
//   每个场景产出 eval/baseline/runs/<id>/result.json（结果）+ logs/（原始日志）。
//   汇总 before.json / before.md 由 eval/report.ts 负责（本文件不写汇总）。
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { execCapture } from "./harness/exec";
import { resolveBun } from "./harness/env";
import { provisionProject, readProjectState } from "./harness/provision";
import { runPipeline, adoptPipelineRecord } from "./harness/runPipeline";
import { checkBuild, checkBoot, checkHttp, checkRender, findEdge, inventory } from "./harness/checks";
import { assertAllPassesBound } from "./harness/types";
import type { CheckResult, Scenario, ScenarioResult, ScenarioVerdict } from "./harness/types";

const AGENTS_DIR = path.resolve(import.meta.dir, "..");
const SCENARIOS_DIR = path.join(import.meta.dir, "scenarios");
const RUNS_DIR = path.join(import.meta.dir, "baseline", "runs");

function argValue(name: string): string | null {
    const i = process.argv.indexOf(name);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : null;
}
function hasFlag(name: string): boolean { return process.argv.includes(name); }

function listScenarios(): string[] {
    return fs.readdirSync(SCENARIOS_DIR, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .filter(n => fs.existsSync(path.join(SCENARIOS_DIR, n, "expected.json")))
        .sort();
}

function loadScenario(id: string): { scenario: Scenario; input: string; expectedFile: string } {
    const dir = path.join(SCENARIOS_DIR, id);
    const expectedFile = path.join(dir, "expected.json");
    if (!fs.existsSync(expectedFile)) throw new Error(`场景 ${id} 缺 expected.json`);
    const scenario = JSON.parse(fs.readFileSync(expectedFile, "utf-8")) as Scenario;
    const inputFile = path.join(dir, scenario.inputFile || "input.md");
    if (!fs.existsSync(inputFile)) throw new Error(`场景 ${id} 缺 ${scenario.inputFile || "input.md"}`);
    return { scenario, input: fs.readFileSync(inputFile, "utf-8"), expectedFile };
}

/** 夹具自检：机器可比的字段必须齐全（缺了就拒绝开跑，不带着坏尺子跑） */
function validateScenario(id: string): string[] {
    const errors: string[] = [];
    const { scenario, input } = loadScenario(id);
    if (scenario.schemaVersion !== "crewforge.eval.scenario/1") errors.push(`schemaVersion 非法：${scenario.schemaVersion}`);
    if (!scenario.id) errors.push("缺 id");
    if (scenario.id !== id) errors.push(`目录名与 id 不一致：${id} vs ${scenario.id}`);
    if (!scenario.stack?.backend) errors.push("缺 stack.backend");
    if (!scenario.buildExpectations?.length) errors.push("缺 buildExpectations");
    if (!scenario.startExpectations?.length) errors.push("缺 startExpectations");
    if (!scenario.httpAssertions?.length) errors.push("缺 httpAssertions");
    if (!scenario.renderAssertions?.length) errors.push("缺 renderAssertions");
    for (const a of scenario.httpAssertions ?? []) {
        if (!a.id || !a.method || !a.path) errors.push(`httpAssertion 字段不全：${JSON.stringify(a).slice(0, 80)}`);
        if (typeof a.expectStatus !== "number") errors.push(`httpAssertion ${a.id} 缺 expectStatus（自然语言验收不许进判定）`);
        if (a.expectJsonPath === undefined) errors.push(`httpAssertion ${a.id} 缺 expectJsonPath`);
        // 需求原文必须真的写了这个路径，否则期望是凭空发明的
        // 带 {var} 占位的路径只比对占位前的静态前缀（需求里写的是 /api/notes/{id}）
        const staticPrefix = a.path.split("{")[0]!.replace(/\/$/, "");
        if (staticPrefix && !input.includes(staticPrefix)) {
            errors.push(`httpAssertion ${a.id} 的路径前缀 ${staticPrefix} 未出现在 input.md 里（期望必须来自冻结需求）`);
        }
    }
    for (const r of scenario.renderAssertions ?? []) {
        if (typeof r.minTextLength !== "number") errors.push(`renderAssertion ${r.id} 缺 minTextLength`);
    }
    if (input.length < 200) errors.push("input.md 太短（<200 字），不足以构成可判定需求");
    return errors;
}

function computeVerdict(checks: CheckResult[], p: ScenarioResult["pipeline"]): ScenarioVerdict {
    const passed = checks.filter(c => c.status === "pass").map(c => c.id);
    const failed = checks.filter(c => c.status === "fail").map(c => c.id);
    const blocked = checks.filter(c => c.status === "blocked").map(c => ({ id: c.id, reason: c.detail }));
    const skipped = checks.filter(c => c.status === "skipped").map(c => c.id);

    const claimedStatus = p.dbFinalStatus;
    const claimedVerified = p.verifyOutcome === "ok";
    const realJudgementFailed = checks.some(c => c.status === "fail" && c.kind !== "pipeline");
    const systemSaidDone = claimedStatus === "done";

    const fakePass = realJudgementFailed && systemSaidDone && claimedVerified;
    const doneButUnverified = systemSaidDone && !claimedVerified;

    let overall: ScenarioVerdict["overall"];
    if (failed.length > 0) overall = "fail";
    else if (blocked.length > 0 && passed.length > 0) overall = "partial";
    else if (blocked.length > 0) overall = "blocked";
    else overall = "pass";

    const reasons: string[] = [];
    reasons.push(`真实检查 通过 ${passed.length} / 失败 ${failed.length} / 无法判定 ${blocked.length}`);
    reasons.push(`旧系统自报：status=${claimedStatus ?? "n/a"}，run 级验证=${p.verifyOutcome ?? "无报告"}`);
    if (fakePass) reasons.push("⚠️ 假通过：系统报 done+verified，但真实断言存在失败");
    if (doneButUnverified) reasons.push("系统报 done 但显式未验证（诚实，但不等于通过）");

    return { overall, passed, failed, blocked, skipped, systemClaimedStatus: claimedStatus, systemClaimedVerified: claimedVerified, fakePass, doneButUnverified, reason: reasons.join("；") };
}

async function runScenario(id: string, opts: { phase: "all" | "run" | "check"; reuseRun: boolean; timeoutMs: number; render: boolean; adoptRun: boolean; projectId: number | null; adoptReason: string | null }): Promise<ScenarioResult> {
    const { scenario, input, expectedFile } = loadScenario(id);
    const runDir = path.join(RUNS_DIR, id);
    const logDir = path.join(runDir, "logs");
    const artifactsRoot = path.join(runDir, "artifacts");
    fs.mkdirSync(logDir, { recursive: true });
    fs.mkdirSync(artifactsRoot, { recursive: true });

    const bun = resolveBun();
    const resultFile = path.join(runDir, "result.json");
    const prior = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, "utf-8")) as ScenarioResult : null;

    // ---------- 1) 驱动旧系统 ----------
    let pipeline: ScenarioResult["pipeline"];
    if (opts.adoptRun) {
        // 人工终止后重建现场：不重跑旧系统，用日志 + 落库状态如实补一条记录，然后照常跑检查
        const projectId = opts.projectId ?? prior?.pipeline.projectId;
        if (!projectId) throw new Error("--adopt-run 需要 --project-id（或已存在的 result.json）");
        console.log(`[runner] ${id}：adopt 已有现场 projectId=${projectId}（人工终止，不重跑旧系统）`);
        pipeline = await adoptPipelineRecord({
            projectId, agentsDir: AGENTS_DIR, runsRoot: artifactsRoot, logDir,
            bunCmd: resolveBun().cmd,
            reason: opts.adoptReason ?? "用户指令：失败居多，止损并继续下一项",
        });
        console.log(`[runner] ${id}：adopted，日志 ${pipeline.stdoutBytes} 字节，DB status=${pipeline.dbFinalStatus}，任务 ${JSON.stringify(pipeline.dbTasks)}`);
    } else if (opts.reuseRun || (opts.phase === "check" && prior)) {
        if (!prior) throw new Error(`--reuse-run 但 ${resultFile} 不存在`);
        pipeline = prior.pipeline;
        console.log(`[runner] ${id}：复用已有 pipeline 记录（projectId=${pipeline.projectId}，exit=${pipeline.exitCode}）`);
    } else {
        const prov = await provisionProject(scenario.id, input);
        console.log(`[runner] ${id}：新建项目 projectId=${prov.projectId}（应用库 ${prov.appDatabase}）`);
        pipeline = await runPipeline({
            projectId: prov.projectId,
            agentsDir: AGENTS_DIR,
            runsRoot: artifactsRoot,
            logDir,
            timeoutMs: opts.timeoutMs,
            bunCmd: bun.cmd,
            label: scenario.id,
            acceptanceSpec: expectedFile,
            verifyDbMode: "auto",
        });
        console.log(`[runner] ${id}：旧系统退出 exit=${pipeline.exitCode}${pipeline.timedOut ? " (TIMEOUT)" : ""}，耗时 ${Math.round(pipeline.durationMs / 1000)}s，DB status=${pipeline.dbFinalStatus}`);
    }

    if (opts.phase === "run") {
        // 只跑旧系统：仍写一份最小结果，便于后续 --reuse-run
        const artifacts = inventory(path.join(artifactsRoot, `p${pipeline.projectId}`));
        const res: ScenarioResult = {
            schemaVersion: "crewforge.eval.result/1",
            scenarioId: scenario.id, title: scenario.title, kind: scenario.kind, expectFailure: scenario.expectFailure,
            ranAt: new Date().toISOString(),
            inputFile: path.join(SCENARIOS_DIR, scenario.id, scenario.inputFile),
            expectedFile,
            pipeline, artifacts, checks: [],
            verdict: { overall: "blocked", passed: [], failed: [], blocked: [], skipped: [], systemClaimedStatus: pipeline.dbFinalStatus, systemClaimedVerified: pipeline.verifyOutcome === "ok", fakePass: false, doneButUnverified: false, reason: "只跑了 pipeline 阶段，检查未执行" },
        };
        fs.writeFileSync(resultFile, JSON.stringify(res, null, 2), "utf-8");
        return res;
    }

    // ---------- 2) 真实检查 ----------
    const projectDir = path.join(artifactsRoot, `p${pipeline.projectId}`);
    const artifacts = inventory(projectDir);
    const checks: CheckResult[] = [];

    for (const b of scenario.buildExpectations) {
        const c = await checkBuild(b, projectDir, logDir);
        console.log(`[runner]   ${b.id}: ${c.status} — ${c.detail}`);
        checks.push(c);
    }

    // 应用库凭据：用 .env 的 DB_*（宿主 MySQL）
    const dbUser = process.env.DB_USER ?? "root";
    const dbPassword = process.env.DB_PASSWORD ?? "";
    const appDatabase = `cf_eval_${scenario.id.replace(/[^a-z0-9]+/gi, "_")}`;

    let app: { pid: number | undefined; port: number; baseUrl: string } | null = null;
    const startExp = scenario.startExpectations[0];
    if (startExp) {
        const { check, app: booted } = await checkBoot(startExp, projectDir, logDir, appDatabase, dbUser, dbPassword);
        console.log(`[runner]   ${startExp.id}: ${check.status} — ${check.detail}`);
        checks.push(check);
        app = booted;
    }

    const vars: Record<string, string | number> = {};
    for (const a of scenario.httpAssertions) {
        if (!app) {
            checks.push({
                id: a.id, kind: "http", status: "blocked",
                command: `${a.method} ${a.path}`, cwd: null, exitCode: null,
                httpStatus: null, expectStatus: a.expectStatus, jsonAssertions: [],
                startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 0,
                logFile: null, detail: "应用未启动：HTTP 断言无法执行（未验证 ≠ 通过）",
                evidence: "boot 检查未通过或产物缺失",
            });
            continue;
        }
        const c = await checkHttp(a, app.baseUrl, vars, logDir);
        console.log(`[runner]   ${a.id}: ${c.status} — ${c.detail}`);
        checks.push(c);
    }

    if (opts.render) {
        let dist = path.join(projectDir, scenario.artifactLayout.frontendDir, "dist");
        if (!fs.existsSync(dist)) {
            const alt = path.join(projectDir, scenario.artifactLayout.frontendDir, "build");
            if (fs.existsSync(alt)) dist = alt;
        }
        const edge = findEdge();
        for (const r of scenario.renderAssertions) {
            const c = await checkRender(r, dist, logDir, edge);
            console.log(`[runner]   ${r.id}: ${c.status} — ${c.detail}`);
            checks.push(c);
        }
    } else {
        for (const r of scenario.renderAssertions) {
            checks.push({
                id: r.id, kind: "render", status: "blocked",
                command: null, cwd: null, exitCode: null, httpStatus: null, expectStatus: null, jsonAssertions: [],
                startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 0,
                logFile: null, detail: "本轮按 --no-render 关闭渲染检查（未验证 ≠ 通过）", evidence: "",
            });
        }
    }

    // 收尾：杀掉应用进程树（防占端口）
    if (app?.pid) {
        try {
            const r = await execCapture({ cmd: "taskkill", args: ["/PID", String(app.pid), "/T", "/F"], cwd: AGENTS_DIR, timeoutMs: 30_000, logDir, label: "cleanup-app" });
            console.log(`[runner]   清理应用进程：taskkill exit=${r.exitCode}`);
        } catch { /* ignore */ }
    }

    assertAllPassesBound(checks);   // ★ 违反"pass 必须绑定命令与退出码"直接抛

    const verdict = computeVerdict(checks, pipeline);
    const res: ScenarioResult = {
        schemaVersion: "crewforge.eval.result/1",
        scenarioId: scenario.id, title: scenario.title, kind: scenario.kind, expectFailure: scenario.expectFailure,
        ranAt: new Date().toISOString(),
        inputFile: path.join(SCENARIOS_DIR, scenario.id, scenario.inputFile),
        expectedFile,
        pipeline, artifacts, checks, verdict,
    };
    fs.writeFileSync(resultFile, JSON.stringify(res, null, 2), "utf-8");
    console.log(`[runner] ${id}：verdict=${verdict.overall} → ${resultFile}`);
    return res;
}

async function main(): Promise<void> {
    const ids = (() => {
        const one = argValue("--scenario");
        if (one) return [one];
        if (hasFlag("--all") || hasFlag("--validate")) return listScenarios();
        return [];
    })();

    if (ids.length === 0) {
        console.log("用法：bun run eval/runner.ts --validate | --scenario <id> | --all [--reuse-run] [--phase run|check|all] [--no-render] [--timeout-min N]");
        console.log(`可用场景：${listScenarios().join(", ")}`);
        return;
    }

    if (hasFlag("--validate")) {
        let bad = 0;
        for (const id of ids) {
            const errors = validateScenario(id);
            if (errors.length) { bad++; console.log(`✗ ${id}`); for (const e of errors) console.log(`    ${e}`); }
            else console.log(`✓ ${id} 夹具合法`);
        }
        process.exit(bad > 0 ? 1 : 0);
    }

    const phase = (argValue("--phase") ?? "all") as "all" | "run" | "check";
    const timeoutMs = Number(argValue("--timeout-min") ?? "45") * 60_000;
    const render = !hasFlag("--no-render");

    // 场景夹具先自检：坏尺子不许跑
    for (const id of ids) {
        const errors = validateScenario(id);
        if (errors.length) throw new Error(`场景 ${id} 夹具非法：\n${errors.join("\n")}`);
    }

    const out: ScenarioResult[] = [];
    const adoptReason = argValue("--adopt-reason");
    const projectId = argValue("--project-id") ? Number(argValue("--project-id")) : null;
    for (const id of ids) {
        out.push(await runScenario(id, {
            phase, reuseRun: hasFlag("--reuse-run"), timeoutMs, render,
            adoptRun: hasFlag("--adopt-run"), projectId, adoptReason: adoptReason ?? null,
        }));
    }
    console.log("\n[runner] 完成：", out.map(r => `${r.scenarioId}=${r.verdict.overall}`).join("  "));
}

await main();
