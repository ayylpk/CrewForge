// ============================================================
// docker.ts —— 容器验证底座 + HTTP 契约执行（M3-b，零 LLM）
//
//   为什么需要它（此前无法逾越的障碍）：生成的后端**需要 MySQL 才能启动**，
//   所以过去只能退化成"读代码猜"。Docker 让"起库 → 起服务 → 打接口 → 拆环境"变成可执行、
//   可隔离（端口/卷不污染宿主）、且**退出必清理**的确定性动作。
//
//   三条纪律：
//     ① 端口/命名带 runId，互不冲突；② 无论成败 finally 必清理（防容器泄漏吃满磁盘）；
//     ③ 判定只能来自命令输出与退出码；网络/镜像拉取失败归 ENV，不归 COMPILE
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { runCommand, type RunResult } from "../run";
import { renderAcceptanceRunner } from "../../ir/contract";
import type { Acceptance } from "../../ir/acceptance";

export type DockerRunner = (args: string[], opts?: { timeoutMs?: number }) => Promise<RunResult>;

const defaultRunner: DockerRunner = (args, opts) =>
    runCommand(process.platform === "win32" ? "docker.exe" : "docker", args, {
        cwd: process.cwd(),
        timeoutMs: opts?.timeoutMs ?? 180_000,
    });

export async function dockerAvailable(run: DockerRunner = defaultRunner): Promise<boolean> {
    try {
        const r = await run(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 20_000 });
        return r.exitCode === 0;
    } catch { return false; }
}

// ---------- MySQL 容器 ----------
export interface MysqlSpec {
    /** 容器名（带 runId 防冲突） */
    name: string;
    /** 宿主端口（每 run 分配，防冲突） */
    port: number;
    database: string;
    user: string;
    password: string;
    image?: string;
}

export function mysqlRunArgs(s: MysqlSpec): string[] {
    return [
        "run", "-d", "--rm",
        "--name", s.name,
        "-e", `MYSQL_ROOT_PASSWORD=${s.password}`,
        "-e", `MYSQL_DATABASE=${s.database}`,
        "-e", `MYSQL_USER=${s.user}`,
        "-e", `MYSQL_PASSWORD=${s.password}`,
        "-p", `127.0.0.1:${s.port}:3306`,
        s.image ?? "mysql:8.0",
    ];
}

export async function startMysql(s: MysqlSpec, run: DockerRunner = defaultRunner): Promise<{ ok: boolean; container: string; error?: string }> {
    const r = await run(mysqlRunArgs(s), { timeoutMs: 300_000 });
    if (r.exitCode !== 0) return { ok: false, container: s.name, error: r.output.slice(-400) || r.spawnError };
    return { ok: true, container: s.name };
}

/** 停容器：**幂等**（不存在也算成功），供 finally 无条件调用 */
export async function stopContainer(name: string, run: DockerRunner = defaultRunner): Promise<void> {
    try { await run(["rm", "-f", name], { timeoutMs: 60_000 }); } catch { /* 容器本就不存在 */ }
}

/** 解析 `docker port <name> 3306` 的宿主端口（供应用连库用；也可直接用固定 port） */
export async function publishedPort(name: string, containerPort: number, run: DockerRunner = defaultRunner): Promise<number | null> {
    const r = await run(["port", name, String(containerPort)], { timeoutMs: 30_000 });
    const m = /:(\d+)\s*$/.exec(r.output.trim());
    return m ? Number(m[1]) : null;
}

// ---------- 健康检查（等真实服务起来） ----------
export interface WaitResult { ok: boolean; status?: number; attempts: number; durationMs: number }

export async function waitForHttp(
    url: string,
    opts: { timeoutMs?: number; intervalMs?: number; acceptStatuses?: number[] } = {},
): Promise<WaitResult> {
    const timeoutMs = opts.timeoutMs ?? 90_000;
    const intervalMs = opts.intervalMs ?? 1_500;
    const accept = opts.acceptStatuses ?? [200, 201, 204, 400, 401, 403, 404, 405];   // 有响应即"服务已起"（4xx 也算活着）
    const t0 = Date.now();
    let attempts = 0;
    let last: number | undefined;
    while (Date.now() - t0 < timeoutMs) {
        attempts++;
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), Math.min(5_000, intervalMs * 2));
            try {
                const res = await fetch(url, { signal: ctrl.signal });
                last = res.status;
                if (accept.includes(res.status)) return { ok: true, status: res.status, attempts, durationMs: Date.now() - t0 };
            } finally { clearTimeout(timer); }
        } catch { /* 还没起来，继续等 */ }
        await new Promise(r => setTimeout(r, intervalMs));
    }
    return { ok: false, status: last, attempts, durationMs: Date.now() - t0 };
}

// ---------- HTTP 契约执行（把生成的脚本真跑一遍） ----------
export interface ContractRunResult {
    outcome: "ok" | "failed" | "env_error" | "tool_error";
    total: number;
    failed: number;
    failures: string[];
    logFile: string | null;
    output: string;
    durationMs: number;
}

/** 从脚本输出里抠出结论（脚本是引擎自己生成的，格式固定） */
export function parseContractOutput(output: string): { total: number; failed: number; failures: string[] } {
    const failures = output.split(/\r?\n/).filter(l => l.includes("[FAIL]")).map(l => l.replace(/^.*\[FAIL\]\s*/, "").trim());
    const summary = /契约测试：失败\s*(\d+)\s*\/\s*共\s*(\d+)/.exec(output);
    return {
        total: summary ? Number(summary[2]) : 0,
        failed: summary ? Number(summary[1]) : failures.length,
        failures,
    };
}

/**
 * 把验收清单渲染成脚本 → 写进产物树 → 用 bun 真跑 → 解析结论。
 * BASE_URL 必须指向**已启动**的真实服务（调用方负责起服务与健康检查）。
 */
export async function runContractTests(opts: {
    projectDir: string;
    cases: Acceptance[];
    baseUrl: string;
    timeoutMs?: number;
}): Promise<ContractRunResult> {
    const verifyDir = path.join(opts.projectDir, "_verify");
    fs.mkdirSync(verifyDir, { recursive: true });
    const script = path.join(verifyDir, "contract-test.ts");
    fs.writeFileSync(script, renderAcceptanceRunner(opts.cases, `run@${path.basename(opts.projectDir)}`), "utf-8");

    const bun = process.platform === "win32" ? "bun.exe" : "bun";
    const r = await runCommand(bun, [script], {
        cwd: opts.projectDir,
        timeoutMs: opts.timeoutMs ?? 180_000,
        logDir: verifyDir,
        label: "contract-test",
        env: { BASE_URL: opts.baseUrl, PATH: process.env.PATH ?? "" },
    });
    const parsed = parseContractOutput(r.output);
    if (r.spawnError && r.exitCode === -1) {
        return { outcome: "tool_error", total: 0, failed: 0, failures: [], logFile: r.logFile, output: r.output, durationMs: r.durationMs };
    }
    if (r.timedOut) {
        return { outcome: "env_error", total: parsed.total, failed: parsed.failed, failures: parsed.failures, logFile: r.logFile, output: r.output, durationMs: r.durationMs };
    }
    if (r.exitCode === 0) {
        return { outcome: "ok", total: parsed.total, failed: 0, failures: [], logFile: r.logFile, output: r.output, durationMs: r.durationMs };
    }
    // 脚本自身错（退出码 2）与断言失败（退出码 1）区分：前者是工具问题，后者是真实失败
    if (r.exitCode === 2) {
        return { outcome: "tool_error", total: parsed.total, failed: parsed.failed, failures: parsed.failures, logFile: r.logFile, output: r.output, durationMs: r.durationMs };
    }
    return { outcome: "failed", total: parsed.total, failed: parsed.failed, failures: parsed.failures, logFile: r.logFile, output: r.output, durationMs: r.durationMs };
}
