// ============================================================
// runVerify.ts —— run 级验证编排（M3 闭环，零 LLM）
//
//   把散件串成一条真判决：起库 → 起应用 → 健康检查 → 跑契约测试 → **退出必清理**。
//
//   形态决定（务实优先，且**诚实标注**）：
//     · DB 在容器里（隔离、可丢弃、端口随机分配）
//     · 应用在宿主上跑（免网络编排，构建用宿主 mvnw/.m2——已实测可用）
//     ⚠️ 安全边界：宿主跑生成代码**只适合自用/可信场景**；托管服务必须改成应用也进容器
//        （StackProfile.runtime.isolated 预留了这条），否则用户提交的代码就能摸你的机器。
//
//   铁律：
//     · Docker 不可用 → skipped_unverified（**未验证 ≠ 通过**），绝不假装跑过
//     · 任何一步失败都要走 finally：容器、进程、端口全清（否则会吃满磁盘/端口）
//     · 结论只来自命令与 HTTP 证据；日志全部留档
// ============================================================

import fs from "node:fs";
import path from "node:path";
import {
    dockerAvailable, startMysql, stopContainer, waitForHttp, waitForTcp, runContractTests,
    type DockerRunner, type ContractRunResult,
} from "./docker";
import { runCommand, killTree, type RunResult } from "../run";
import { findMaven, type MavenLauncher } from "./maven";
import type { Acceptance } from "../../ir/acceptance";
import type { StackProfile } from "../../stacks/profile";

export type RunVerifyOutcome = "ok" | "contract_failed" | "boot_failed" | "env_error" | "skipped_unverified" | "tool_error";

export interface RunVerifyEvidence {
    step: string;
    cmd: string;
    exitCode: number;
    durationMs: number;
    ok: boolean;
    logFile: string | null;
    /** 关键摘录（人读；判定不看它） */
    excerpt?: string;
}

export interface RunVerifyResult {
    outcome: RunVerifyOutcome;
    checked: boolean;
    summary: string;
    evidence: RunVerifyEvidence[];
    contract?: ContractRunResult;
    /** 用于失败签名的短句（进失败账本） */
    failures: string[];
    cleaned: boolean;
}

export interface RunVerifyOpts {
    projectDir: string;
    profile: StackProfile;
    cases: Acceptance[];
    /** 应用启动命令（默认按栈生成）；返回子进程引用由编排负责杀 */
    startApp?: (args: { projectDir: string; dbPort: number; port: number }) => Promise<{ pid?: number; cmd: string; logFile: string | null; started: boolean }>;
    docker?: DockerRunner;
    mvnwPath?: string | null;
    /** 端口选择（默认随机高位端口） */
    appPort?: number;
    dbPort?: number;
    buildTimeoutMs?: number;
    bootTimeoutMs?: number;
    logDir?: string;
    /** 跳过 DB（纯静态契约服务）——少数栈不需要 */
    skipDatabase?: boolean;
}

function pickPort(base = 20000): number {
    return base + Math.floor(Math.random() * 2000);
}

/** 默认应用启动：Spring Boot 用 mvnw 打 jar 后 java -jar（构建在宿主，依赖走 ~/.m2） */
async function defaultStartApp(o: RunVerifyOpts, dbPort: number, port: number, logDir: string): Promise<{ pid?: number; cmd: string; logFile: string | null; started: boolean }> {
    const backendDir = path.join(o.projectDir, "backend");
    const launcher: MavenLauncher | null = findMaven(backendDir)
        ?? (o.mvnwPath && fs.existsSync(o.mvnwPath)
            ? { exe: process.env.ComSpec || "cmd.exe", prefixArgs: ["/c", o.mvnwPath], label: path.basename(o.mvnwPath) }
            : null);
    if (!launcher) return { cmd: "(无 mvnw)", logFile: null, started: false };

    const build = await runCommand(launcher.exe, [
        ...launcher.prefixArgs, "-B", "-DskipTests", "-Dfile.encoding=UTF-8", "package",
    ], { cwd: backendDir, timeoutMs: o.buildTimeoutMs ?? 600_000, logDir, label: "mvn-package" });
    if (build.exitCode !== 0) return { cmd: build.cmd, logFile: build.logFile, started: false };

    // 找可执行 jar
    let jar: string | null = null;
    const targetDir = path.join(backendDir, "target");
    try {
        const cands = fs.readdirSync(targetDir).filter(f => f.endsWith(".jar") && !f.endsWith("-sources.jar") && !f.endsWith(".original"));
        jar = cands.length > 0 ? path.join(targetDir, cands[0]!) : null;
    } catch { jar = null; }
    if (!jar) return { cmd: build.cmd, logFile: build.logFile, started: false };

    const { spawn } = await import("node:child_process");
    const logFile = path.join(logDir, "app.log");
    fs.mkdirSync(logDir, { recursive: true });
    const out = fs.openSync(logFile, "a");
    const child = spawn(process.platform === "win32" ? "java.exe" : "java", ["-jar", jar], {
        cwd: backendDir, detached: process.platform !== "win32", windowsHide: true,
        env: {
            ...process.env,
            SERVER_PORT: String(port),
            SPRING_DATASOURCE_URL: `jdbc:mysql://127.0.0.1:${dbPort}/app?useSSL=false&serverTimezone=UTC&allowPublicKeyRetrieval=true`,
            SPRING_DATASOURCE_USERNAME: "app",
            SPRING_DATASOURCE_PASSWORD: "app",
        },
        stdio: ["ignore", out, out],
    });
    return { pid: child.pid, cmd: `java -jar ${path.basename(jar)}（端口 ${port}）`, logFile, started: true };
}

/**
 * run 级验证：一整套真判决。任何失败都返回结构化结果（不抛异常）。
 *
 * ★ 两段式结构（9/10 修正）：内层 `attempt` 负责流程与早退，外层负责**清理后**再返回。
 *   旧写法把 `cleaned` 写进 `return {...}` 字面量，而 `return` 表达式在 `finally` **之前**求值，
 *   于是早退路径全部被固化成 `cleaned: false`——字段在撒谎。现在只有清理真正完成后才标 true。
 */
export async function verifyRun(o: RunVerifyOpts): Promise<RunVerifyResult> {
    const logDir = o.logDir ?? path.join(o.projectDir, "_verify");
    fs.mkdirSync(logDir, { recursive: true });
    const ctx: { appPid?: number } = {};
    const dbName = `cf-${path.basename(o.projectDir)}-${Date.now().toString(36)}-db`;

    let result: Omit<RunVerifyResult, "cleaned">;
    try {
        result = await attemptVerify(o, logDir, dbName, ctx);
    } catch (e) {
        result = {
            outcome: "tool_error", checked: false, evidence: [],
            failures: [`编排异常：${String((e as Error).message ?? e).slice(0, 200)}`],
            summary: "编排异常（按工具级错误处理）",
        };
    } finally {
        // ★ 无论成败必清理：杀应用进程树 + 删容器（防端口/磁盘泄漏，容器泄漏会吃满磁盘）
        if (ctx.appPid) killTree(ctx.appPid);
        if (!o.skipDatabase) await stopContainer(dbName, o.docker);
    }
    return { ...result, cleaned: true };
}

/** 内层：只负责流程判断与早退，不负责清理 */
async function attemptVerify(
    o: RunVerifyOpts, logDir: string, dbName: string, ctx: { appPid?: number },
): Promise<Omit<RunVerifyResult, "cleaned">> {
    const evidence: RunVerifyEvidence[] = [];
    const failures: string[] = [];

    if (!o.profile.verified) {
        return { outcome: "skipped_unverified", checked: false, evidence, failures,
            summary: `本栈无验证器（${o.profile.id}）：产物按"未验证"交付，不得计入通过` };
    }

    const docker = o.docker;
    // 跳过 DB 时不查 Docker（纯静态服务不需要容器，别误报环境问题）
    const hasDocker = o.skipDatabase ? true : await dockerAvailable(docker ?? undefined);
    if (!hasDocker) {
        return { outcome: "skipped_unverified", checked: false, evidence, failures,
            summary: "Docker 不可用：无法起库与应用，run 级验证跳过（未验证 ≠ 通过）" };
    }

    const dbPort = o.dbPort ?? pickPort(33000);
    const appPort = o.appPort ?? pickPort(21000);

    // 1) 起库（容器）
    if (!o.skipDatabase) {
        const t0 = Date.now();
        const db = await startMysql({
            name: dbName, port: dbPort, database: "app", user: "app", password: "app",
        }, docker);
        evidence.push({ step: "mysql", cmd: `docker run --name ${dbName} -p 127.0.0.1:${dbPort}:3306`, exitCode: db.ok ? 0 : 1, durationMs: Date.now() - t0, ok: db.ok, logFile: null, excerpt: db.error?.slice(0, 200) });
        if (!db.ok) {
            failures.push(`数据库容器启动失败：${db.error ?? "未知"}`);
            return { outcome: "env_error", checked: true, evidence, failures, summary: "环境问题：MySQL 容器起不来" };
        }
        // 等 MySQL 就绪：★ 用 TCP 探连接（MySQL 不说 HTTP，用 HTTP GET 会永远失败）
        const ready = await waitForTcp("127.0.0.1", dbPort, { timeoutMs: 60_000, intervalMs: 1_500 });
        evidence.push({ step: "mysql_ready", cmd: `tcp wait 127.0.0.1:${dbPort}`, exitCode: ready.ok ? 0 : 1, durationMs: ready.durationMs, ok: ready.ok, logFile: null, excerpt: `attempts=${ready.attempts}` });
        if (!ready.ok) {
            failures.push(`MySQL 在 60s 内未就绪（端口 ${dbPort}）`);
            return { outcome: "env_error", checked: true, evidence, failures, summary: "环境问题：数据库未就绪" };
        }
    }

    // 2) 起应用（宿主）
    const t1 = Date.now();
    const app = o.startApp
        ? await o.startApp({ projectDir: o.projectDir, dbPort, port: appPort })
        : await defaultStartApp(o, dbPort, appPort, logDir);
    ctx.appPid = app.pid;
    evidence.push({ step: "app_start", cmd: app.cmd, exitCode: app.started ? 0 : 1, durationMs: Date.now() - t1, ok: app.started, logFile: app.logFile });
    if (!app.started) {
        failures.push("应用启动命令失败（构建不过或找不到可执行产物）");
        return { outcome: "boot_failed", checked: true, evidence, failures, summary: "启动失败：应用未起来" };
    }

    // 3) 健康检查
    const health = await waitForHttp(`http://127.0.0.1:${appPort}/`, {
        timeoutMs: o.bootTimeoutMs ?? 120_000, intervalMs: 2_000,
    });
    evidence.push({ step: "health", cmd: `GET http://127.0.0.1:${appPort}/`, exitCode: health.ok ? 0 : 1, durationMs: health.durationMs, ok: health.ok, logFile: app.logFile, excerpt: `attempts=${health.attempts} status=${health.status ?? "n/a"}` });
    if (!health.ok) {
        failures.push(`应用在 ${Math.round((o.bootTimeoutMs ?? 120_000) / 1000)}s 内未通过健康检查（端口 ${appPort}，日志 ${app.logFile ?? "无"}）`);
        return { outcome: "boot_failed", checked: true, evidence, failures, summary: "启动失败：健康检查未通过" };
    }

    // 4) 契约测试（真打接口）
    const contract = await runContractTests({
        projectDir: o.projectDir, cases: o.cases, baseUrl: `http://127.0.0.1:${appPort}`,
    });
    evidence.push({ step: "contract", cmd: `bun _verify/contract-test.ts（BASE_URL=http://127.0.0.1:${appPort}）`, exitCode: contract.outcome === "ok" ? 0 : 1, durationMs: contract.durationMs, ok: contract.outcome === "ok", logFile: contract.logFile, excerpt: `${contract.total - contract.failed}/${contract.total} 通过` });

    if (contract.outcome === "ok") {
        return { outcome: "ok", checked: true, evidence, contract, failures: [], summary: `run 级验证通过：契约 ${contract.total}/${contract.total}` };
    }
    failures.push(...(contract.failures.length ? contract.failures : [contract.outcome]));
    return {
        outcome: contract.outcome === "env_error" ? "env_error" : "contract_failed",
        checked: true, evidence, contract, failures,
        summary: `契约测试未通过：${contract.failed}/${contract.total} 失败`,
    };
}

/** 证据包 → 可读报告（M8 报告页的数据源之一） */
export function renderRunVerifyReport(r: RunVerifyResult): string {
    const lines = [
        `# run 级验证报告`,
        `- 结论：${r.outcome}${r.checked ? "" : "（未验证）"}`,
        `- 摘要：${r.summary}`,
        `- 清理：${r.cleaned ? "已完成（进程与容器已回收）" : "未完成——需人工检查"}`,
        "",
        "## 证据链",
        ...r.evidence.map(e => `- [${e.ok ? "x" : " "}] ${e.step}：exit=${e.exitCode} ${e.durationMs}ms${e.excerpt ? ` — ${e.excerpt}` : ""}`),
    ];
    if (r.failures.length) lines.push("", "## 失败原因", ...r.failures.map(f => `- ${f}`));
    return lines.join("\n");
}
