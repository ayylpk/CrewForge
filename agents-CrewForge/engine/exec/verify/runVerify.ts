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
import { hostDbAvailable, createHostDatabase, dropHostDatabase, hostDbConfig, jdbcUrl } from "./hostDb";
import { resolveBunExe } from "../tools";
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
    /** ★ 阶段 1：本次用哪种数据库落库（host = **宿主验证**，报告必须如实标注） */
    dbMode?: "docker" | "host" | "none";
}

export interface RunVerifyOpts {
    projectDir: string;
    profile: StackProfile;
    cases: Acceptance[];
    /** 应用启动命令（默认按栈生成）；返回子进程引用由编排负责杀 */
    startApp?: (args: { projectDir: string; dbPort: number; port: number }) => Promise<{ pid?: number; cmd: string; logFile: string | null; started: boolean }>;
    docker?: DockerRunner;
    mvnwPath?: string | null;
    /**
     * 数据库来源（★ 阶段 1）：
     *   docker —— 容器起库（原行为）
     *   host   —— **宿主 MySQL**（Docker 不可用时的落库方式；报告必须标注"宿主验证"）
     *   auto   —— 默认：能用 Docker 用 Docker，否则回退宿主；两者都没有 → skipped_unverified
     */
    dbMode?: "docker" | "host" | "auto";
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

/** 默认应用启动：Spring Boot 用 mvnw/java 打 jar 后 java -jar（构建在宿主，依赖走 ~/.m2） */
async function defaultStartApp(o: RunVerifyOpts, dsn: { url: string; user: string; password: string }, port: number, logDir: string): Promise<{ pid?: number; cmd: string; logFile: string | null; started: boolean }> {
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
            SPRING_DATASOURCE_URL: dsn.url,
            SPRING_DATASOURCE_USERNAME: dsn.user,
            SPRING_DATASOURCE_PASSWORD: dsn.password,
        },
        stdio: ["ignore", out, out],
    });
    return { pid: child.pid, cmd: `java -jar ${path.basename(jar)}（端口 ${port}，库 ${dsn.url.replace(/^jdbc:mysql:\/\//, "").split("?")[0]}）`, logFile, started: true };
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
    const ctx: { appPid?: number; hostDbName?: string; dbMode: "docker" | "host" | "none" } = { dbMode: "none" };
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
        // ★ 无论成败必清理：杀应用进程树 + 删容器 + **删宿主验证库**（防端口/磁盘泄漏）
        if (ctx.appPid) killTree(ctx.appPid);
        if (!o.skipDatabase) {
            if (ctx.dbMode === "docker") await stopContainer(dbName, o.docker);
            if (ctx.dbMode === "host" && ctx.hostDbName) {
                const dropped = await dropHostDatabase(ctx.hostDbName);
                if (!dropped.ok) console.warn(`[verify] 宿主验证库清理失败：${dropped.error ?? "未知"}（库名 ${ctx.hostDbName}）`);
            }
        }
    }
    return { ...result, cleaned: true, dbMode: ctx.dbMode };
}

/** 内层：只负责流程判断与早退，不负责清理 */
async function attemptVerify(
    o: RunVerifyOpts, logDir: string, dbName: string, ctx: { appPid?: number; hostDbName?: string; dbMode: "docker" | "host" | "none" },
): Promise<Omit<RunVerifyResult, "cleaned">> {
    const evidence: RunVerifyEvidence[] = [];
    const failures: string[] = [];

    if (!o.profile.verified) {
        return { outcome: "skipped_unverified", checked: false, evidence, failures,
            summary: `本栈无验证器（${o.profile.id}）：产物按"未验证"交付，不得计入通过` };
    }

    const docker = o.docker;
    const prefersHost = o.dbMode === "host";
    // 跳过 DB 时不查 Docker（纯静态服务不需要容器，别误报环境问题）
    const hasDocker = (o.skipDatabase || prefersHost) ? false : await dockerAvailable(docker ?? undefined);

    const appPort = o.appPort ?? pickPort(21000);

    // ---------- 1) 起库：容器（原路）或宿主（阶段 1 新增） ----------
    let dsn = { url: `jdbc:mysql://127.0.0.1:3306/app`, user: "app", password: "app" };
    if (!o.skipDatabase) {
        const useHost = prefersHost || !hasDocker;
        if (useHost) {
            const cfg = hostDbConfig();
            const t0 = Date.now();
            const avail = await hostDbAvailable(cfg);
            if (!avail.ok) {
                evidence.push({ step: "host_db_available", cmd: `mysql: SELECT 1 @ ${cfg.host}:${cfg.port}`, exitCode: 1, durationMs: Date.now() - t0, ok: false, logFile: null, excerpt: avail.error?.slice(0, 200) });
                // Docker 与宿主库都没有 → 未验证（不是通过，也不是产品失败）
                return { outcome: "skipped_unverified", checked: false, evidence, failures,
                    summary: `Docker 不可用且宿主 MySQL 不可连（${avail.error ?? "未知"}）：run 级验证跳过（未验证 ≠ 通过）` };
            }
            const hostDbName = `cf_verify_${Date.now().toString(36)}`;
            const created = await createHostDatabase(hostDbName, cfg);
            evidence.push({
                step: "host_db", cmd: created.cmd, exitCode: created.ok ? 0 : 1, durationMs: created.durationMs,
                ok: created.ok, logFile: null,
                excerpt: created.ok ? `宿主验证（host）：已建空库 ${hostDbName}` : created.error?.slice(0, 200),
            });
            if (!created.ok) {
                failures.push(`宿主 MySQL 建库失败：${created.error ?? "未知"}`);
                return { outcome: "env_error", checked: true, evidence, failures, summary: "环境问题：宿主 MySQL 建库失败" };
            }
            ctx.dbMode = "host";
            ctx.hostDbName = hostDbName;
            dsn = { url: jdbcUrl(cfg, hostDbName), user: cfg.user, password: cfg.password };
        } else {
            const dbPort = o.dbPort ?? pickPort(33000);
            const t0 = Date.now();
            const db = await startMysql({
                name: dbName, port: dbPort, database: "app", user: "app", password: "app",
            }, docker);
            evidence.push({ step: "mysql", cmd: `docker run --name ${dbName} -p 127.0.0.1:${dbPort}:3306`, exitCode: db.ok ? 0 : 1, durationMs: Date.now() - t0, ok: db.ok, logFile: null, excerpt: db.error?.slice(0, 200) });
            if (!db.ok) {
                failures.push(`数据库容器启动失败：${db.error ?? "未知"}`);
                return { outcome: "env_error", checked: true, evidence, failures, summary: "环境问题：MySQL 容器起不来" };
            }
            ctx.dbMode = "docker";
            // 等 MySQL 就绪：★ 用 TCP 探连接（MySQL 不说 HTTP，用 HTTP GET 会永远失败）
            const ready = await waitForTcp("127.0.0.1", dbPort, { timeoutMs: 60_000, intervalMs: 1_500 });
            evidence.push({ step: "mysql_ready", cmd: `tcp wait 127.0.0.1:${dbPort}`, exitCode: ready.ok ? 0 : 1, durationMs: ready.durationMs, ok: ready.ok, logFile: null, excerpt: `attempts=${ready.attempts}` });
            if (!ready.ok) {
                failures.push(`MySQL 在 60s 内未就绪（端口 ${dbPort}）`);
                return { outcome: "env_error", checked: true, evidence, failures, summary: "环境问题：数据库未就绪" };
            }
            dsn = { url: `jdbc:mysql://127.0.0.1:${dbPort}/app?useSSL=false&serverTimezone=UTC&allowPublicKeyRetrieval=true`, user: "app", password: "app" };
        }
    }

    // 2) 起应用（宿主）
    const t1 = Date.now();
    const app = o.startApp
        ? await o.startApp({ projectDir: o.projectDir, dbPort: 0, port: appPort })
        : await defaultStartApp(o, dsn, appPort, logDir);
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
        `- 数据库来源：${r.dbMode === "host" ? "**宿主验证（host）**——宿主 MySQL + 本机 JVM，非容器隔离" : r.dbMode === "docker" ? "容器（docker）" : "无（跳过）"}`,
        `- 摘要：${r.summary}`,
        `- 清理：${r.cleaned ? "已完成（进程与容器已回收）" : "未完成——需人工检查"}`,
        "",
        "## 证据链",
        ...r.evidence.map(e => `- [${e.ok ? "x" : " "}] ${e.step}：exit=${e.exitCode} ${e.durationMs}ms${e.excerpt ? ` — ${e.excerpt}` : ""}`),
    ];
    if (r.failures.length) lines.push("", "## 失败原因", ...r.failures.map(f => `- ${f}`));
    return lines.join("\n");
}
