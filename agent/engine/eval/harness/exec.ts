// ============================================================
// eval/harness/exec.ts —— 基线采集用的命令执行器（零 LLM）
//
//   为什么不直接用 engine/exec/run.runCommand：
//     · 基线要求**边跑边落盘**（长跑中途被杀也不丢日志），runCommand 只在结束时写一次
//     · 基线要 stdout/stderr 分开留档（诊断"编译错在 stderr / maven 错在 stdout"）
//   判定口径与 runCommand 保持一致：一切结果都变成返回值，不抛异常。
// ============================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export interface ExecResult {
    command: string;
    cwd: string;
    exitCode: number | null;
    timedOut: boolean;
    durationMs: number;
    startedAt: string;
    finishedAt: string;
    stdout: string;
    stderr: string;
    stdoutFile: string | null;
    stderrFile: string | null;
    spawnError: string | null;
}

function safeLabel(label: string): string {
    return label.replace(/[^\w.-]+/g, "_").slice(0, 80);
}

/** 进程树强杀（Windows: taskkill /T /F）——只杀父进程会留孤儿占端口 */
export function killTree(pid: number | undefined): void {
    if (!pid) return;
    try {
        spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch { /* 已退出 */ }
}

export interface ExecOpts {
    cmd: string;
    args: string[];
    cwd: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    logDir?: string | null;
    label?: string;
    /** Windows：按原样传参（cmd.exe /d /s /c "..." 专用，否则引号会被转义成 \" 导致命令找不到） */
    verbatimArgs?: boolean;
}

/** 子进程环境清洗。
 *
 *  ① 宿主若用 NODE_OPTIONS 注入 safe-delete shim（genie-safe-delete.cjs），
 *  `vite build` 的 prepareOutDir → emptyDir → fs.rmSync 会被打断（exit=1），
 *  看起来像"前端构建失败"，其实是宿主环境问题——s4/s4c/s4d/s5b 四轮的 frontend.build
 *  全死在这上面。与 developerAgent/tools/processSandbox.ts 的处理保持一致：一律摘掉。
 *  实测确认：注入存在时 vite 报 `[safe-delete] 操作失败 … at Object.wrappedRmSync`。
 *
 *  ② npm 的缓存目录**必须钉在产物树之外**——见下面 pinNpmCacheOutOfProject 的一手证据。 */
function childEnv(extra: Record<string, string> | undefined, cwdAbs: string): Record<string, string> {
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    if (env.NODE_OPTIONS) {
        console.warn(`[exec] 摘掉宿主 NODE_OPTIONS（防 safe-delete shim 打断构建）：${env.NODE_OPTIONS}`);
        delete env.NODE_OPTIONS;
    }
    const merged = { ...env, ...(extra ?? {}) };
    const pinned = pinNpmCacheOutOfProject(merged, cwdAbs);
    if (pinned.changed) {
        console.warn(`[exec] npm_config_cache=${pinned.changed.from}（相对路径或落在命令 cwd 内）`
            + ` → 钉成 ${pinned.changed.to}：否则 npm 会把整棵缓存树写进被测产物。`);
    }
    return pinned.env;
}

// ============================================================
// npm 缓存目录：钉在产物树之外（★ 产物污染缺陷的修复，2026-09-17）
//
//   ── 为什么必须钉（本机实测，不是推测）──
//   `npm_config_cache=.npm-cache`（**相对路径**）会被 npm 按**命令 cwd** 解析：
//   在 `<产物>/backend` 里跑一次 `npm install` 就长出 `<产物>/backend/.npm-cache/`
//   （`_cacache/` + `_logs/*-debug-0.log` + `_update-notifier-last-checked`）。
//   实证（只读既有产物与报告）：
//     · `eval/baseline/runs/s4d-todo-lite/result.json` 的产物清单 417 条 `backend/.npm-cache/...`
//     · `eval/baseline/runs/s5b-meeting-room/result.json` 932 条（含 `_prebuilds/*.tar.gz`）
//   这些是缓存，不是 agent 写的代码，却混进"产物盘点/文件数/统计"。
//   而相对路径的 `npm_config_cache` 在本仓库**没有任何代码设置过**（全量 grep + 全部 git 历史，
//   只有 docs/superpowers/plans/2026-09-11-engine2-items-1-8-report.md:51 提过这个变量名），
//   即它来自进程的**外部环境**（宿主/启动脚本）。宿主改不了，所以在**唯一执行出口**把它钉死。
//
//   ── 为什么钉到共享临时目录，而不是"全局 cache"或"项目内 cache"──
//   同一份 09-11 文档记下了当年为什么改用项目本地 cache：本机全局 cache
//   （`%LOCALAPPDATA%\npm-cache`）被宿主的安全删除钩子（genie-safe-delete）接管，
//   `npm cache verify` 直接报 `[safe-delete] 操作失败`，需要 prune 的 install 可能炸。
//   所以"躲开全局 cache"这个**意图保留**，只把**位置挪出产物树**：`%TEMP%\cf-npm-cache`
//   （跨进程共享、可随时整目录删除、永远不在任何 artifact 下）。
//
//   规则：调用方/宿主给的是**产物树之外的绝对路径**就尊重它；相对路径、或落在命令 cwd 里的路径
//   一律换成共享目录。npm 的配置优先级是「环境变量 > 项目 .npmrc > 用户 .npmrc > 默认」，
//   所以钉这一个变量就足以盖住"项目内 .npmrc 写了 cache=.npm-cache"这种写法。
// ============================================================

/** npm 认的键名（Windows 上变量名不分大小写，Node 的 env 对象分，所以两种拼写都要处理） */
const NPM_CACHE_KEY = "npm_config_cache";

/** 共享 npm 缓存目录（产物树之外）。`CF_NPM_CACHE_DIR` 可覆盖，但只接受绝对路径。 */
export function defaultNpmCacheDir(): string {
    const override = process.env["CF_NPM_CACHE_DIR"];
    if (override !== undefined && override !== "" && path.isAbsolute(override)) return override;
    return path.join(os.tmpdir(), "cf-npm-cache");
}

/** childAbs 是否等于 parentAbs 或在其内部（大小写不敏感，Windows 语义） */
function isInsideDir(parentAbs: string, childAbs: string): boolean {
    const rel = path.relative(path.resolve(parentAbs), path.resolve(childAbs));
    if (rel === "") return true;
    const norm = rel.replace(/\\/g, "/").toLowerCase();
    return norm !== ".." && !norm.startsWith("../") && !path.isAbsolute(rel);
}

export interface NpmCachePin {
    env: Record<string, string>;
    /** 非 null = 改动过（值来自哪里、改成了什么），调用方据此打日志 */
    changed: { from: string; to: string } | null;
}

/**
 * 把 npm 的 cache 钉到产物树之外的绝对路径（纯函数，便于单测）。
 * `cwdAbs` = 该命令的工作目录：相对 cache 会被 npm 解析成它下面的 `.npm-cache`。
 */
export function pinNpmCacheOutOfProject(
    env: Record<string, string>,
    cwdAbs: string,
    fallbackDir: string = defaultNpmCacheDir(),
): NpmCachePin {
    const next: Record<string, string> = { ...env };
    const keys = Object.keys(next).filter(k => k.toLowerCase() === NPM_CACHE_KEY);
    const current = keys.map(k => next[k] ?? "").find(v => v.trim() !== "") ?? "";

    // 已经是产物树之外的绝对路径 → 尊重原值（宿主/调用方有权指定缓存位置）
    if (current !== "" && path.isAbsolute(current) && !isInsideDir(cwdAbs, current)) {
        for (const k of keys) if (k !== NPM_CACHE_KEY) delete next[k];
        next[NPM_CACHE_KEY] = current;
        return { env: next, changed: null };
    }
    // 重复拼写（npm_config_cache / NPM_CONFIG_CACHE）只留一个，避免互相打架
    for (const k of keys) delete next[k];
    next[NPM_CACHE_KEY] = fallbackDir;
    return { env: next, changed: current === "" ? null : { from: current, to: fallbackDir } };
}


/** 跑一条命令，stdout/stderr 分流留档；超时按进程树杀并如实标注 */
export function execCapture(o: ExecOpts): Promise<ExecResult> {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const command = [o.cmd, ...o.args].join(" ");
    const label = safeLabel(o.label ?? path.basename(o.cmd));

    let stdoutFile: string | null = null;
    let stderrFile: string | null = null;
    if (o.logDir) {
        try {
            fs.mkdirSync(o.logDir, { recursive: true });
            stdoutFile = path.join(o.logDir, `${label}.stdout.log`);
            stderrFile = path.join(o.logDir, `${label}.stderr.log`);
            fs.writeFileSync(stdoutFile, `# ${command}\ncwd=${o.cwd}\nstarted=${startedAt}\n\n`, "utf-8");
            fs.writeFileSync(stderrFile, `# ${command}\ncwd=${o.cwd}\nstarted=${startedAt}\n\n`, "utf-8");
        } catch { stdoutFile = null; stderrFile = null; }
    }

    return new Promise<ExecResult>(resolve => {
        const finish = (exitCode: number | null, timedOut: boolean, spawnError: string | null, out: string, err: string) => {
            const finishedAt = new Date().toISOString();
            if (stdoutFile) { try { fs.appendFileSync(stdoutFile, `\n\n## exit=${exitCode} timedOut=${timedOut} at ${finishedAt}\n`, "utf-8"); } catch { /* ignore */ } }
            if (stderrFile) { try { fs.appendFileSync(stderrFile, `\n\n## exit=${exitCode} timedOut=${timedOut} at ${finishedAt}\n`, "utf-8"); } catch { /* ignore */ } }
            resolve({
                command, cwd: o.cwd, exitCode, timedOut, durationMs: Date.now() - t0,
                startedAt, finishedAt, stdout: out, stderr: err, stdoutFile, stderrFile, spawnError,
            });
        };

        let child: ReturnType<typeof spawn>;
        try {
            child = spawn(o.cmd, o.args, {
                cwd: o.cwd,
                env: childEnv(o.env, o.cwd),
                windowsHide: true,
                windowsVerbatimArguments: o.verbatimArgs === true,
                detached: process.platform !== "win32",
            });
        } catch (e) {
            finish(-1, false, String((e as Error).message ?? e), "", "");
            return;
        }

        let out = "";
        let err = "";
        let timedOut = false;
        const outStream = stdoutFile ? fs.createWriteStream(stdoutFile, { flags: "a" }) : null;
        const errStream = stderrFile ? fs.createWriteStream(stderrFile, { flags: "a" }) : null;

        const timer = setTimeout(() => {
            timedOut = true;
            killTree(child.pid);
        }, o.timeoutMs ?? 600_000);

        child.stdout?.on("data", (d: Buffer) => { out += d.toString("utf-8"); outStream?.write(d); });
        child.stderr?.on("data", (d: Buffer) => { err += d.toString("utf-8"); errStream?.write(d); });
        child.on("error", (e: Error) => {
            clearTimeout(timer);
            outStream?.end(); errStream?.end();
            finish(-1, timedOut, e.message, out, err);
        });
        child.on("close", (code: number | null) => {
            clearTimeout(timer);
            if (timedOut) killTree(child.pid);
            outStream?.end(); errStream?.end();
            finish(code ?? (timedOut ? 124 : -1), timedOut, null, out, err);
        });
    });
}

/** 尾部摘录（证据链用；判定不看它） */
export function tail(text: string, lines = 12, maxChars = 2000): string {
    const arr = text.split(/\r?\n/).filter(l => l.trim().length > 0);
    const t = arr.slice(-lines).join("\n");
    return t.length > maxChars ? t.slice(-maxChars) : t;
}
