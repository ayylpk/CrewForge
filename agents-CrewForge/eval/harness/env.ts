// ============================================================
// eval/harness/env.ts —— 环境探针（真跑命令，如实记录）
//
//   纪律：探针只产出**事实**（命令 + 退出码 + 版本行），不产出结论性"可用/不可用"以外的判断；
//   缺口一律进 limitations，并写清"它让哪些判定无法完成"——绝不用缺口换 pass。
// ============================================================

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import mysql from "mysql2/promise";
import { execCapture, tail } from "./exec";
import type { EnvironmentReport, ToolProbe, ServiceProbe } from "./types";

const AGENTS_DIR = path.resolve(import.meta.dir, "..", "..");
const REPO_ROOT = path.resolve(AGENTS_DIR, "..");

/** bun 在 Windows 上常被 shim 包一层；shim 会在沙箱下读不到自身 js 而失败，故显式找真 exe */
export function resolveBun(): { cmd: string; note: string } {
    const candidates: string[] = [];
    const home = os.homedir();
    const bvmRuntime = path.join(home, ".bvm", "runtime");
    try {
        for (const v of fs.readdirSync(bvmRuntime)) {
            candidates.push(path.join(bvmRuntime, v, "bin", "bun.exe"));
        }
    } catch { /* 没装 bvm */ }
    candidates.push(path.join(home, ".bun", "bin", "bun.exe"));
    candidates.push("bun.exe");
    for (const c of candidates) {
        try {
            if (c !== "bun.exe" && !fs.existsSync(c)) continue;
            return { cmd: c, note: c === "bun.exe" ? "PATH 上的 bun.exe" : `直连真实 bun.exe（绕开 bvm shim）` };
        } catch { /* continue */ }
    }
    return { cmd: "bun", note: "未找到 bun.exe，回退 PATH 上的 bun" };
}

async function probeTool(name: string, cmd: string, args: string[], cwd: string, note = ""): Promise<ToolProbe> {
    const r = await execCapture({ cmd, args, cwd, timeoutMs: 60_000, label: `probe-${name}` });
    const combined = `${r.stdout}\n${r.stderr}`.trim();
    const versionLine = combined.split(/\r?\n/).map(l => l.trim()).find(l => l.length > 0) ?? null;
    const ok = r.exitCode === 0;
    return {
        name,
        command: [cmd, ...args].join(" "),
        found: r.spawnError == null || r.exitCode !== -1 || combined.length > 0,
        path: r.spawnError == null ? cmd : null,
        exitCode: r.exitCode,
        versionLine: versionLine ? versionLine.slice(0, 200) : null,
        ok,
        note: note || (r.spawnError ? `spawn 失败：${r.spawnError}` : ""),
    };
}

export async function probeTcp(host: string, port: number, timeoutMs = 3000): Promise<{ open: boolean; evidence: string }> {
    return new Promise(resolve => {
        const sock = net.connect({ host, port });
        const done = (open: boolean, why: string) => {
            sock.removeAllListeners();
            sock.destroy();
            resolve({ open, evidence: why });
        };
        sock.setTimeout(timeoutMs);
        sock.once("connect", () => done(true, `TCP ${host}:${port} 已连接`));
        sock.once("timeout", () => done(false, `TCP ${host}:${port} 超时`));
        sock.once("error", (e: Error) => done(false, `TCP ${host}:${port} 失败：${e.message}`));
    });
}

export interface LlmSettings { modelName: string | null; modelUrl: string | null; apiKey: string | null }

/** 读 sys_settings 里的模型配置（真实读库，不是读 .env） */
export async function readLlmSettings(): Promise<LlmSettings> {
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST ?? "localhost",
        port: Number(process.env.DB_PORT ?? 3306),
        user: process.env.DB_USER ?? "root",
        password: process.env.DB_PASSWORD ?? "",
        database: process.env.DB_NAME ?? "crewforge",
    });
    try {
        const [rows] = await conn.query("SELECT model_name, model_url, api_key FROM sys_settings WHERE id = 1");
        const r = (rows as Record<string, unknown>[])[0] ?? {};
        return {
            modelName: (r.model_name as string) ?? null,
            modelUrl: (r.model_url as string) ?? null,
            apiKey: (r.api_key as string) ?? null,
        };
    } finally {
        await conn.end();
    }
}

async function probeLlm(): Promise<EnvironmentReport["llm"]> {
    try {
        const s = await readLlmSettings();
        if (!s.modelUrl || !s.apiKey) {
            return { endpoint: s.modelUrl, model: s.modelName, reachable: false, httpStatus: null, evidence: "sys_settings 缺 model_url 或 api_key" };
        }
        const base = s.modelUrl.replace(/\/+$/, "");
        const urls = [`${base}/v1/chat/completions`, `${base}/chat/completions`];
        let last = "";
        for (const url of urls) {
            try {
                const res = await fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.apiKey}` },
                    body: JSON.stringify({ model: s.modelName ?? "deepseek-chat", messages: [{ role: "user", content: "ping" }], max_tokens: 4 }),
                    signal: AbortSignal.timeout(40_000),
                });
                const body = (await res.text()).slice(0, 300);
                last = `POST ${url} → ${res.status} ${body}`;
                if (res.ok) return { endpoint: url, model: s.modelName, reachable: true, httpStatus: res.status, evidence: last };
            } catch (e) {
                last = `POST ${url} 异常：${String((e as Error).message ?? e)}`;
            }
        }
        return { endpoint: urls[0]!, model: s.modelName, reachable: false, httpStatus: null, evidence: last };
    } catch (e) {
        return { endpoint: null, model: null, reachable: false, httpStatus: null, evidence: `读 sys_settings 失败：${String((e as Error).message ?? e)}` };
    }
}

/** 完整环境探针 */
export async function probeEnvironment(logDir?: string): Promise<EnvironmentReport> {
    const bun = resolveBun();
    const tools: ToolProbe[] = [];
    tools.push(await probeTool("bun", bun.cmd, ["--version"], AGENTS_DIR, bun.note));
    tools.push(await probeTool("node", "node", ["--version"], AGENTS_DIR));
    tools.push(await probeTool("npm", process.platform === "win32" ? "npm.cmd" : "npm", ["--version"], AGENTS_DIR));
    tools.push(await probeTool("java", "java", ["-version"], AGENTS_DIR));
    tools.push(await probeTool("javac", "javac", ["-version"], AGENTS_DIR));
    tools.push(await probeTool("mvn", process.platform === "win32" ? "mvn.cmd" : "mvn", ["-v"], AGENTS_DIR, "全局 mvn（项目自带 mvnw 亦可）"));
    tools.push(await probeTool("mvnw(backed-CrewForge)", process.platform === "win32" ? "cmd.exe" : "./mvnw",
        process.platform === "win32" ? ["/c", "mvnw.cmd", "-v"] : ["-v"], path.join(REPO_ROOT, "backed-CrewForge")));
    tools.push(await probeTool("docker", "docker", ["version", "--format", "{{.Server.Version}}"], AGENTS_DIR));
    tools.push(await probeTool("git", "git", ["--version"], REPO_ROOT));

    const edgeCandidates = [
        path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
    ];
    const edge = edgeCandidates.find(p => fs.existsSync(p)) ?? null;
    tools.push(edge
        ? await probeTool("msedge", edge, ["--version"], AGENTS_DIR, `路径 ${edge}`)
        : { name: "msedge", command: "msedge.exe --version", found: false, path: null, exitCode: null, versionLine: null, ok: false, note: "未找到 Edge 可执行文件" });

    // ---------- 服务 ----------
    const services: ServiceProbe[] = [];

    const mysqlTcp = await probeTcp("127.0.0.1", Number(process.env.DB_PORT ?? 3306));
    let mysqlQueryOk: boolean | null = null;
    let mysqlEvidence = mysqlTcp.evidence;
    try {
        const conn = await mysql.createConnection({
            host: process.env.DB_HOST ?? "localhost",
            port: Number(process.env.DB_PORT ?? 3306),
            user: process.env.DB_USER ?? "root",
            password: process.env.DB_PASSWORD ?? "",
            database: process.env.DB_NAME ?? "crewforge",
        });
        const [rows] = await conn.query("SELECT VERSION() AS v, DATABASE() AS d");
        const r0 = (rows as Record<string, unknown>[])[0] ?? {};
        mysqlQueryOk = true;
        mysqlEvidence = `mysql2 连接成功：version=${String(r0.v)} database=${String(r0.d)}；${mysqlTcp.evidence}`;
        await conn.end();
    } catch (e) {
        mysqlQueryOk = false;
        mysqlEvidence = `mysql2 连接失败：${String((e as Error).message ?? e)}；${mysqlTcp.evidence}`;
    }
    services.push({
        name: "mysql", probe: "TCP 3306 + mysql2 SELECT VERSION()（用 .env 的 DB_* 凭据）",
        reachable: mysqlQueryOk, exitCode: null, evidence: mysqlEvidence,
        note: mysqlQueryOk ? "可直连（可作生成应用的宿主数据库）" : "不可用",
    });

    const redisTcp = await probeTcp("127.0.0.1", 6379);
    services.push({ name: "redis", probe: "TCP 127.0.0.1:6379", reachable: redisTcp.open, exitCode: null, evidence: redisTcp.evidence, note: "旧引擎运行路径未见 Redis 依赖（仅部署脚本提及）" });

    const dockerServer = await execCapture({ cmd: "docker", args: ["version", "--format", "{{.Server.Version}}"], cwd: AGENTS_DIR, timeoutMs: 30_000, logDir: logDir ?? null, label: "probe-docker-server" });
    services.push({
        name: "docker", probe: "docker version --format {{.Server.Version}}",
        reachable: dockerServer.exitCode === 0, exitCode: dockerServer.exitCode,
        evidence: tail(`${dockerServer.stdout}\n${dockerServer.stderr}`, 4),
        note: dockerServer.exitCode === 0 ? "daemon 在线" : "docker CLI 在但 daemon 不可用",
    });

    if (edge) {
        const headless = await execCapture({
            cmd: edge,
            args: ["--headless=new", "--disable-gpu", "--no-sandbox", `--user-data-dir=${path.join(os.tmpdir(), "cf-eval-edge-envprobe")}`, "--dump-dom", "data:text/html,<h1>cf</h1>"],
            cwd: AGENTS_DIR, timeoutMs: 60_000, logDir: logDir ?? null, label: "probe-edge-headless",
        });
        const domOk = /<h1>cf<\/h1>/i.test(headless.stdout);
        services.push({
            name: "msedge-headless", probe: "msedge --headless=new --dump-dom data:text/html,<h1>cf</h1>",
            reachable: domOk, exitCode: headless.exitCode,
            evidence: `exit=${headless.exitCode} dom=${headless.stdout.slice(0, 80)} err=${tail(headless.stderr, 3)}`,
            note: domOk ? "headless 可用（渲染判定可执行）" : "headless 被环境拒绝（沙箱命名管道限制），渲染判定只能是 blocked",
        });
    } else {
        services.push({ name: "msedge-headless", probe: "msedge --headless=new", reachable: false, exitCode: null, evidence: "未找到 msedge.exe", note: "无浏览器" });
    }

    const llm = await probeLlm();

    // ---------- 缺口 ----------
    const limitations: EnvironmentReport["limitations"] = [];
    const dockerOk = services.find(s => s.name === "docker")?.reachable === true;
    if (!dockerOk) {
        limitations.push({
            id: "docker-unavailable",
            missing: "Docker daemon",
            impact: "旧系统的 run 级验证（finalGate → verifyRun）必然早退为 skipped_unverified：不会构建、不会启动、不会打接口、不会渲染。因此『交付是否真的成立』只能由本 harness 用宿主 MySQL 自行实测，或记为 blocked。",
            evidence: services.find(s => s.name === "docker")?.evidence ?? "",
        });
    }
    const edgeOk = services.find(s => s.name === "msedge-headless")?.reachable === true;
    if (!edgeOk) {
        limitations.push({
            id: "browser-headless-blocked",
            missing: "可用的 headless 浏览器运行时",
            impact: "渲染断言（页面非白屏/页面文本）无法执行，一律记为 blocked（未验证 ≠ 通过）。",
            evidence: services.find(s => s.name === "msedge-headless")?.evidence ?? "",
        });
    }
    if (!mysqlQueryOk) {
        limitations.push({ id: "mysql-unavailable", missing: "可连接的 MySQL", impact: "生成的后端无法启动，启动/HTTP 判定只能 blocked。", evidence: mysqlEvidence });
    }
    if (!llm.reachable) {
        limitations.push({ id: "llm-unreachable", missing: "可用的大模型端点", impact: "旧系统根本无法产出任何代码，所有场景都只会是『未运行』。", evidence: llm.evidence });
    }
    if (!tools.find(t => t.name === "mvn")?.ok) {
        limitations.push({
            id: "global-mvn-missing",
            missing: "全局 mvn",
            impact: "生成项目的 Maven 构建只能用项目自带 mvnw（本 harness 会把 backed-CrewForge/mvnw 作为回退），无 mvnw 的项目判 blocked。",
            evidence: "mvn -v 未通过",
        });
    }

    return {
        schemaVersion: "crewforge.eval.env/1",
        probedAt: new Date().toISOString(),
        cwd: AGENTS_DIR,
        platform: `${process.platform} ${os.release()} node=${process.version} bun=${Bun.version}`,
        tools, services, llm, limitations,
    };
}
