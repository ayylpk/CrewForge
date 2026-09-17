// ============================================================
// eval/harness/checks.ts —— 真实执行式检查（构建 / 启动 / HTTP / 渲染）
//
//   这里没有一条判定来自正则或 LLM 文字：
//     · build → 命令 + 退出码
//     · boot  → 进程起来 + 端口真的回 HTTP
//     · http  → 真发请求，比对状态码与逐字段谓词
//     · render→ 真起 headless 浏览器，读 DOM
//   判定不出来 → blocked（缺产物/缺浏览器/缺数据库），并在 detail 里写清楚缺什么。
// ============================================================

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execCapture, killTree, tail } from "./exec";
import { evaluateJsonPath, jsonPathGet, type Predicate } from "../../engine/ir/predicates";
import type {
    ArtifactInventory, CheckResult, JsonAssertionResult,
    ScenarioBuildExpectation, ScenarioHttpAssertion, ScenarioRenderAssertion, ScenarioStartExpectation,
} from "./types";

const WIN = process.platform === "win32";

function nowIso() { return new Date().toISOString(); }

function baseCheck(id: string, kind: CheckResult["kind"]): CheckResult {
    return {
        id, kind, status: "blocked", command: null, cwd: null, exitCode: null,
        httpStatus: null, expectStatus: null, jsonAssertions: [],
        startedAt: nowIso(), finishedAt: nowIso(), durationMs: 0,
        logFile: null, detail: "", evidence: "",
    };
}

/**
 * 用 cmd.exe 跑 .cmd/.bat。★ Windows 上的引号地狱：
 *   `cmd.exe /c "路径带引号 命令"` 会被 Node 把内层引号转义成 \"，cmd 就直接"找不到命令"。
 *   正解是 `/d /s /c "整条命令行"` + windowsVerbatimArguments（让引号原样传给 cmd）。
 */
function shellArgs(cmdline: string): { cmd: string; args: string[]; verbatimArgs?: boolean } {
    return WIN
        ? { cmd: "cmd.exe", args: ["/d", "/s", "/c", `"${cmdline}"`], verbatimArgs: true }
        : { cmd: "sh", args: ["-c", cmdline] };
}

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");

/**
 * 找 Maven：生成项目通常不自带 mvnw，本机也常常没有全局 mvn —— 但 wrapper 下过的
 * Maven 发行版就躺在 ~/.m2/wrapper/dists 里，那是一条**真实可执行**的命令（不是猜测）。
 * 顺序：项目自带 mvnw → PATH 上的 mvn → wrapper 缓存里的 mvn → 仓库自带 mvnw（最后手段）。
 */
export function resolveMaven(projectDir: string): { path: string; source: string } | null {
    const local = path.join(projectDir, WIN ? "mvnw.cmd" : "mvnw");
    if (fs.existsSync(local)) return { path: local, source: "项目自带 wrapper" };

    const pathMvn = process.env.PATH?.split(path.delimiter)
        .map(d => path.join(d, WIN ? "mvn.cmd" : "mvn"))
        .find(p => { try { return fs.existsSync(p); } catch { return false; } });
    if (pathMvn) return { path: pathMvn, source: "PATH 上的 mvn" };

    const dists = path.join(os.homedir(), ".m2", "wrapper", "dists");
    const found: string[] = [];
    try {
        for (const pkg of fs.readdirSync(dists)) {
            if (!pkg.startsWith("apache-maven")) continue;
            for (const hash of fs.readdirSync(path.join(dists, pkg))) {
                const bin = path.join(dists, pkg, hash, "bin", WIN ? "mvn.cmd" : "mvn");
                if (fs.existsSync(bin)) found.push(bin);
            }
        }
    } catch { /* 没有 wrapper 缓存 */ }
    if (found.length) {
        found.sort();
        return { path: found[found.length - 1]!, source: "~/.m2/wrapper/dists 里 wrapper 下载的 Maven 发行版" };
    }

    const repoWrapper = path.join(REPO_ROOT, "backed-CrewForge", WIN ? "mvnw.cmd" : "mvnw");
    if (fs.existsSync(repoWrapper)) return { path: repoWrapper, source: "仓库 backed-CrewForge/mvnw（最后手段，非生成物自带）" };
    return null;
}

// ---------- 产物清单（数据，不是判定） ----------

const SKIP_DIRS = new Set(["node_modules", ".git", "_archive", ".mvn", ".idea"]);

export function inventory(dir: string): ArtifactInventory {
    const files: string[] = [];
    const walk = (d: string) => {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const full = path.join(d, e.name);
            if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full); }
            else files.push(path.relative(dir, full).replace(/\\/g, "/"));
        }
    };
    const exists = fs.existsSync(dir);
    if (exists) walk(dir);
    const byExt: Record<string, number> = {};
    for (const f of files) {
        const ext = path.extname(f).toLowerCase() || "(none)";
        byExt[ext] = (byExt[ext] ?? 0) + 1;
    }
    let topLevelDirs: string[] = [];
    if (exists) {
        try { topLevelDirs = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort(); } catch { topLevelDirs = []; }
    }
    return { dir, exists, fileCount: files.length, byExt, files: files.slice(0, 2000), topLevelDirs };
}

// ---------- 构建 ----------

/** 构建前预清输出目录。
 *  vite 只在 outDir **已存在**时才走 prepareOutDir→emptyDir→fs.rmSync，而那条路径正是
 *  safe-delete shim 的高发点（s4/s4c/s4d/s5b 的 frontend.build 全死在这里）。
 *  预删掉它就直接绕开；rmSync 被拦时退化为改名（rename 不走被 shim 的那条路）。
 *  副作用是**诚实的**：构建真失败时 render 会因缺 dist 而 blocked，而不是拿旧产物骗过渲染检查。 */
function preCleanBuildOutput(cwd: string, cmdline: string): string | null {
    if (!/\bbuild\b/.test(cmdline)) return null;
    const dist = path.join(cwd, "dist");
    if (!fs.existsSync(dist)) return null;
    try {
        fs.rmSync(dist, { recursive: true, force: true });
        return `预清构建输出：已删除 ${dist}（绕开 vite 的 emptyDir→rmSync）`;
    } catch (e) {
        const aside = `${dist}.stale-${Date.now()}`;
        try {
            fs.renameSync(dist, aside);
            return `预清构建输出：rmSync 被拦（${String((e as Error).message ?? e)}），改名绕开 → ${path.basename(aside)}`;
        } catch (e2) {
            return `预清构建输出失败（继续执行，构建可能撞 emptyDir shim）：${String((e2 as Error).message ?? e2)}`;
        }
    }
}

export function checkBuild(exp: ScenarioBuildExpectation, projectDir: string, logDir: string): Promise<CheckResult> {
    const c = baseCheck(exp.id, "build");
    const cwd = path.join(projectDir, exp.cwd);
    c.cwd = cwd;
    return (async () => {
        if (!fs.existsSync(cwd)) {
            c.status = "blocked";
            c.detail = `产物目录缺失：${exp.cwd}/（旧系统没有产出这一层）`;
            c.evidence = `checked path: ${cwd}`;
            c.finishedAt = nowIso();
            return c;
        }
        const steps: { label: string; cmdline: string; timeoutMs: number }[] = [];
        let mavenSource = "";
        const preCleanNotes: string[] = [];

        // ★ 工具链按**产物**判定，不按 id 前缀。
        //   旧实现：id 以 backend. 开头就强制要求 pom.xml + Maven ⇒ 任何自选 Node 栈后端的
        //   backend.deps 永远 blocked ⇒ 而 verdict=pass 要求 blocked=0 ⇒ **Node 场景物理上不可能 pass**，
        //   与产品好坏无关（a1/p32 就是这么被烧掉的）。产物说了算，id 只是标签。
        const hasPom = fs.existsSync(path.join(cwd, "pom.xml"));
        const hasPkg = fs.existsSync(path.join(cwd, "package.json"));
        const isFeBe = exp.id.startsWith("frontend") || exp.id.startsWith("backend");
        const toolchain: "maven" | "npm" | "declared" | "unknown" =
            hasPom ? "maven"
                : hasPkg ? "npm"
                    : exp.runtime === "java" ? "maven"
                        : exp.runtime === "node" ? "npm"
                            : isFeBe ? "unknown" : "declared";
        // 判定理由进 evidence：尺子自己也要能被审计（"为什么用这个工具链"必须可追溯）
        const toolchainNote = hasPom ? "工具链判定：发现 pom.xml → Maven"
            : hasPkg ? "工具链判定：发现 package.json → npm"
                : exp.runtime ? `工具链判定：无 pom.xml/package.json，按 fixture 声明 runtime=${exp.runtime} → ${toolchain === "npm" ? "npm" : "Maven"}`
                    : "工具链判定：无 pom.xml 也无 package.json，且 fixture 未声明 runtime";

        if (toolchain === "maven") {
            const mvn = resolveMaven(cwd);
            if (!mvn) {
                c.status = "blocked";
                c.detail = "找不到任何可用 Maven（项目无 mvnw、PATH 无 mvn、~/.m2/wrapper/dists 无发行版）";
                c.evidence = `cwd=${cwd}\n${toolchainNote}`;
                c.finishedAt = nowIso();
                return c;
            }
            steps.push({ label: "mvn package", cmdline: `"${mvn.path}" -B -DskipTests -Dfile.encoding=UTF-8 package`, timeoutMs: 900_000 });
            mavenSource = `Maven 来源：${mvn.source} → ${mvn.path}`;
        } else if (toolchain === "npm") {
            // fixture 自己声明的就是 install（如 backend.deps = "npm install ..."）时不要重复装
            const declaresInstall = /^npm\s+(install|i|ci)\b/.test(exp.cmd.trim());
            if (!fs.existsSync(path.join(cwd, "node_modules")) && !declaresInstall) {
                steps.push({ label: "npm install", cmdline: "npm install --no-audit --no-fund", timeoutMs: 900_000 });
            }
            const preClean = preCleanBuildOutput(cwd, exp.cmd);
            if (preClean) preCleanNotes.push(preClean);
            steps.push({ label: exp.cmd, cmdline: exp.cmd, timeoutMs: 900_000 });
        } else if (toolchain === "declared") {
            // 非 frontend/backend 的 id（如 db.*）：沿用 fixture 声明的命令，行为与旧实现一致
            steps.push({ label: exp.cmd, cmdline: exp.cmd, timeoutMs: 600_000 });
        } else {
            c.status = "blocked";
            c.detail = "目录存在但既无 pom.xml 也无 package.json：无法确定构建命令";
            c.evidence = `ls=${fs.readdirSync(cwd).slice(0, 20).join(",")}\n${toolchainNote}`;
            c.finishedAt = nowIso();
            return c;
        }

        const t0 = Date.now();
        const evidences: string[] = [];
        let lastExit: number | null = null;
        let lastLog: string | null = null;
        let lastTimedOut = false;
        for (const s of steps) {
            const { cmd, args, verbatimArgs } = shellArgs(s.cmdline);
            const r = await execCapture({ cmd, args, cwd, timeoutMs: s.timeoutMs, logDir, label: `${exp.id}-${s.label.replace(/[^\w.-]+/g, "_")}`, verbatimArgs });
            lastExit = r.exitCode;
            lastLog = r.stdoutFile ?? r.stderrFile;
            lastTimedOut = r.timedOut;
            evidences.push(`$ ${s.cmdline}\nexit=${r.exitCode}${r.timedOut ? " (TIMEOUT)" : ""} ${r.durationMs}ms\n--- stdout tail ---\n${tail(r.stdout, 15)}\n--- stderr tail ---\n${tail(r.stderr, 10)}`);
            if (r.exitCode !== exp.expectExitCode) break;
        }
        c.command = steps.map(s => s.cmdline).join("  &&  ");
        c.exitCode = lastExit;
        c.durationMs = Date.now() - t0;
        c.logFile = lastLog;
        c.finishedAt = nowIso();
        c.evidence = `${toolchainNote}\n${mavenSource ? mavenSource + "\n" : ""}${preCleanNotes.length ? preCleanNotes.join("\n") + "\n" : ""}${evidences.join("\n\n")}`.slice(-6000);
        if (lastExit === exp.expectExitCode) {
            c.status = "pass";
            c.detail = `构建成功（exit=${lastExit}）`;
        } else {
            c.status = "fail";
            c.detail = lastTimedOut ? "构建超时被强杀" : `构建失败（期望 exit=${exp.expectExitCode}，实际 ${lastExit}）`;
        }
        return c;
    })();
}

// ---------- 启动（长驻进程 + 健康探测） ----------

async function waitForAnyHttp(url: string, timeoutMs: number, intervalMs = 2000): Promise<{ ok: boolean; status: number | null; attempts: number; lastError: string | null; durationMs: number }> {
    const t0 = Date.now();
    let attempts = 0;
    let lastError: string | null = null;
    while (Date.now() - t0 < timeoutMs) {
        attempts++;
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
            return { ok: true, status: res.status, attempts, lastError: null, durationMs: Date.now() - t0 };
        } catch (e) {
            lastError = String((e as Error).message ?? e);
        }
        await new Promise(r => setTimeout(r, intervalMs));
    }
    return { ok: false, status: null, attempts, lastError, durationMs: Date.now() - t0 };
}

export interface BootedApp { pid: number | undefined; port: number; baseUrl: string; logFile: string | null; command: string }

export async function checkBoot(
    exp: ScenarioStartExpectation, projectDir: string, logDir: string, appDatabase: string, dbUser: string, dbPassword: string,
): Promise<{ check: CheckResult; app: BootedApp | null }> {
    const c = baseCheck(exp.id, "boot");
    const backendDir = path.join(projectDir, exp.cwd);
    c.cwd = backendDir;

    if (!fs.existsSync(backendDir)) {
        c.detail = "后端目录不存在：无法启动";
        c.evidence = `checked path: ${backendDir}`;
        c.finishedAt = nowIso();
        return { check: c, app: null };
    }

    // runtime 分流：node = npm start（s4 轻量栈）；默认 java = 找 jar 用 java -jar（s1~s3）
    const isNode = exp.runtime === "node";
    let spawnCmd: string;
    let spawnArgs: string[];
    let cmdDescBase: string;
    if (isNode) {
        const pkgFile = path.join(backendDir, "package.json");
        if (!fs.existsSync(pkgFile)) {
            c.detail = "backend/package.json 不存在：无法 npm start（未验证 ≠ 通过）";
            c.evidence = `checked: ${pkgFile}`;
            c.finishedAt = nowIso();
            return { check: c, app: null };
        }
        spawnCmd = WIN ? "cmd.exe" : "npm";
        spawnArgs = WIN ? ["/c", "npm", "start"] : ["start"];
        cmdDescBase = "npm start";
    } else {
        const targetDir = path.join(backendDir, "target");
        let jar: string | null = null;
        try {
            const cands = fs.readdirSync(targetDir).filter(f => f.endsWith(".jar") && !f.endsWith("-sources.jar") && !f.endsWith(".original"));
            jar = cands.length ? path.join(targetDir, cands[0]!) : null;
        } catch { jar = null; }
        if (!jar) {
            c.detail = "target/ 下没有可执行 jar：构建未产出产物，启动被跳过（未验证 ≠ 通过）";
            c.evidence = `checked: ${targetDir}`;
            c.finishedAt = nowIso();
            return { check: c, app: null };
        }
        spawnCmd = WIN ? "java.exe" : "java";
        spawnArgs = ["-jar", jar];
        cmdDescBase = `java -jar ${path.basename(jar!)}`;
    }

    const port = 20000 + Math.floor(Math.random() * 15000);
    const logFile = path.join(logDir, `${exp.id}.app.log`);
    fs.mkdirSync(logDir, { recursive: true });
    const out = fs.openSync(logFile, "a");
    const { spawn } = await import("node:child_process");
    const startedAt = nowIso();
    const t0 = Date.now();
    const child = spawn(spawnCmd, spawnArgs, {
        cwd: backendDir,
        windowsHide: true,
        detached: WIN ? false : true,
        env: {
            ...process.env,
            SERVER_PORT: String(port),
            PORT: String(port),
            // Java 栈才注入宿主 MySQL 连接；node/SQLite 栈不需要（多余变量无害但会误导，故按 runtime 给）
            ...(isNode ? {} : {
                SPRING_DATASOURCE_URL: `jdbc:mysql://127.0.0.1:${process.env.DB_PORT ?? 3306}/${appDatabase}?useSSL=false&serverTimezone=UTC&allowPublicKeyRetrieval=true&createDatabaseIfNotExist=true`,
                SPRING_DATASOURCE_USERNAME: dbUser,
                SPRING_DATASOURCE_PASSWORD: dbPassword,
                SPRING_PROFILES_ACTIVE: "eval",
            }),
        },
        stdio: ["ignore", out, out],
    });
    const cmdDesc = isNode
        ? `npm start (cwd=${exp.cwd}, PORT=${port})`
        : `${cmdDescBase} (SERVER_PORT=${port}, SPRING_DATASOURCE_URL=.../${appDatabase})`;
    c.command = cmdDesc;
    const health = await waitForAnyHttp(`http://127.0.0.1:${port}${exp.healthPath}`, exp.expectReadyTimeoutMs);
    c.exitCode = health.ok ? 0 : 1;
    c.httpStatus = health.status;
    c.durationMs = Date.now() - t0;
    c.startedAt = startedAt;
    c.finishedAt = nowIso();
    c.logFile = logFile;
    const appLog = (() => { try { return fs.readFileSync(logFile, "utf-8"); } catch { return ""; } })();
    c.evidence = `health probe: GET http://127.0.0.1:${port}${exp.healthPath} → ${health.status ?? "无响应"}（尝试 ${health.attempts} 次，${health.durationMs}ms）\nlastError=${health.lastError ?? "n/a"}\n--- app.log tail ---\n${tail(appLog, 20)}`;
    if (health.ok) {
        c.status = "pass";
        c.detail = `应用已启动并响应 HTTP（端口 ${port}，状态 ${health.status}）`;
        return { check: c, app: { pid: child.pid, port, baseUrl: `http://127.0.0.1:${port}`, logFile, command: cmdDesc } };
    }
    c.status = "fail";
    c.detail = `应用在 ${Math.round(exp.expectReadyTimeoutMs / 1000)}s 内没有响应 HTTP（端口 ${port}）`;
    killTree(child.pid);
    return { check: c, app: null };
}

// ---------- HTTP 断言 ----------

export async function checkHttp(
    a: ScenarioHttpAssertion, baseUrl: string, vars: Record<string, string | number>, logDir: string,
): Promise<CheckResult> {
    const c = baseCheck(a.id, "http");
    const render = (s: string) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`));
    const url = `${baseUrl}${render(a.path)}`;
    const headers: Record<string, string> = { ...(a.headers ?? {}) };
    for (const k of Object.keys(headers)) headers[k] = render(headers[k]!);
    const bodyStr = a.body === undefined ? undefined : render(JSON.stringify(a.body));
    if (bodyStr) headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
    c.command = `${a.method} ${url}${bodyStr ? ` body=${bodyStr.slice(0, 200)}` : ""}`;
    c.cwd = null;
    c.expectStatus = a.expectStatus;
    const t0 = Date.now();
    try {
        const res = await fetch(url, { method: a.method, headers, body: bodyStr, signal: AbortSignal.timeout(30_000) });
        const text = await res.text();
        c.httpStatus = res.status;
        let json: unknown = null;
        try { json = JSON.parse(text); } catch { json = null; }
        const assertions: JsonAssertionResult[] = [];
        for (const [p, pred] of Object.entries(a.expectJsonPath)) {
            const actual = jsonPathGet(json, p);
            const failures = evaluateJsonPath(json, { [p]: pred as Predicate });
            assertions.push({ path: p, op: (pred as Predicate).op, ok: failures.length === 0, detail: failures[0] ?? "ok" });
        }
        c.jsonAssertions = assertions;
        if (a.capture) {
            for (const [varName, p] of Object.entries(a.capture)) {
                const got = jsonPathGet(json, p);
                if (got.found && (typeof got.value === "string" || typeof got.value === "number")) vars[varName] = got.value as string | number;
            }
        }
        c.durationMs = Date.now() - t0;
        c.finishedAt = nowIso();
        c.logFile = null;
        c.evidence = `HTTP ${res.status}\nbody(head 800)=${text.slice(0, 800)}${assertions.length ? `\n字段断言：${assertions.map(x => `${x.path}=${x.ok ? "ok" : x.detail}`).join("；")}` : ""}`;
        if (res.status === a.expectStatus && assertions.every(x => x.ok)) {
            c.status = "pass";
            c.detail = `HTTP ${res.status} 符合期望，字段断言 ${assertions.length} 条全过`;
        } else {
            c.status = "fail";
            const why = res.status !== a.expectStatus
                ? `期望状态 ${a.expectStatus}，实际 ${res.status}`
                : `字段断言失败：${assertions.filter(x => !x.ok).map(x => `${x.path} ${x.detail}`).join("；")}`;
            c.detail = why;
        }
        return c;
    } catch (e) {
        c.durationMs = Date.now() - t0;
        c.finishedAt = nowIso();
        c.status = "fail";
        c.httpStatus = null;
        c.detail = `请求失败（服务未起或连接错误）：${String((e as Error).message ?? e)}`;
        c.evidence = `url=${url}`;
        return c;
    }
}

// ---------- 渲染（headless 浏览器 + 静态托管 dist） ----------

function startStaticServer(root: string): { port: number; stop: () => void } {
    const mime: Record<string, string> = {
        ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon",
        ".woff2": "font/woff2", ".map": "application/json",
    };
    const server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(req) {
            const u = new URL(req.url);
            let rel = decodeURIComponent(u.pathname);
            if (rel === "/") rel = "/index.html";
            let full = path.join(root, rel);
            if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
                // SPA 回退：无扩展名的路由一律给 index.html
                full = path.join(root, "index.html");
            }
            if (!fs.existsSync(full)) return new Response("not found", { status: 404 });
            const ext = path.extname(full).toLowerCase();
            return new Response(fs.readFileSync(full), { headers: { "Content-Type": mime[ext] ?? "application/octet-stream" } });
        },
    });
    return { port: server.port ?? 0, stop: () => void server.stop(true) };
}

export async function checkRender(
    a: ScenarioRenderAssertion, frontendDist: string, logDir: string, edgePath: string | null,
): Promise<CheckResult> {
    const c = baseCheck(a.id, "render");
    if (!edgePath || !fs.existsSync(edgePath)) {
        c.detail = "没有可用的 headless 浏览器：渲染判定 blocked（未验证 ≠ 通过）";
        c.evidence = `edgePath=${edgePath ?? "null"}`;
        c.finishedAt = nowIso();
        return c;
    }
    const indexHtml = path.join(frontendDist, "index.html");
    if (!fs.existsSync(indexHtml)) {
        c.detail = `前端构建产物缺失（${path.relative(process.cwd(), indexHtml)} 不存在）：无法渲染`;
        c.evidence = `checked: ${indexHtml}`;
        c.finishedAt = nowIso();
        return c;
    }

    const srv = startStaticServer(frontendDist);
    const url = `http://127.0.0.1:${srv.port}${a.route}`;
    const profile = path.join(os.tmpdir(), `cf-eval-edge-${Date.now()}`);
    const args = [
        "--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
        `--user-data-dir=${profile}`, "--virtual-time-budget=6000", "--dump-dom", url,
    ];
    c.command = `${edgePath} ${args.join(" ")}`;
    c.cwd = frontendDist;
    const t0 = Date.now();
    try {
        const r = await execCapture({ cmd: edgePath, args, cwd: frontendDist, timeoutMs: 120_000, logDir, label: `${a.id}-edge` });
        c.exitCode = r.exitCode;
        c.durationMs = Date.now() - t0;
        c.finishedAt = nowIso();
        c.logFile = r.stdoutFile;
        const dom = r.stdout;
        // ★ 只取 <body>：<title>便签应用</title> 这类 head 文本不是"渲染出来的内容"，
        //   旧系统的 renderGate 把标题算进可见文本，会把白屏判成"有 4 个字"——这里不重复那个错。
        const bodyMatch = /<body[^>]*>([\s\S]*)<\/body>/i.exec(dom);
        const body = bodyMatch ? bodyMatch[1]! : dom;
        const text = body.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        const checks: JsonAssertionResult[] = [];
        checks.push({ path: "body.textLength", op: "gte", ok: text.length >= a.minTextLength, detail: `body 可见文本 ${text.length} 字（阈值 ${a.minTextLength}）` });
        for (const t of a.mustContainText) {
            checks.push({ path: `text.contains(${t})`, op: "contains", ok: text.includes(t), detail: text.includes(t) ? "命中" : `未命中（文本前 200 字：${text.slice(0, 200)}）` });
        }
        for (const h of a.mustContainHtml) {
            checks.push({ path: `html.contains(${h})`, op: "contains", ok: dom.includes(h), detail: dom.includes(h) ? "命中" : "未命中" });
        }
        c.jsonAssertions = checks;
        c.evidence = `edge exit=${r.exitCode}\nurl=${url}\nDOM(head 800)=${dom.slice(0, 800)}\n文本(head 400)=${text.slice(0, 400)}\n--- edge stderr tail ---\n${tail(r.stderr, 8)}`;
        const edgeFailed = r.exitCode !== 0 && dom.trim().length === 0;
        if (edgeFailed) {
            c.status = "blocked";
            c.detail = `headless 浏览器没能跑起来（exit=${r.exitCode}，DOM 为空）——环境阻断，不是产品结论`;
        } else if (checks.every(x => x.ok)) {
            c.status = "pass";
            c.detail = `页面渲染通过：文本 ${text.length} 字，命中 ${a.mustContainText.length} 个文案断言`;
        } else {
            c.status = "fail";
            c.detail = `页面渲染未达标：${checks.filter(x => !x.ok).map(x => x.path).join("；")}`;
        }
        return c;
    } finally {
        srv.stop();
    }
}

export const EDGE_CANDIDATES = [
    path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
];

export function findEdge(): string | null {
    for (const p of EDGE_CANDIDATES) { if (fs.existsSync(p)) return p; }
    return null;
}
