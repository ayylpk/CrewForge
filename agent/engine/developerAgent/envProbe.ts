// ============================================================
// envProbe.ts —— 环境自检：这台机器上到底有什么工具、能不能联网、端口空不空
//
// 定位（9/15 新增）：scaffold.ts 只给**候选表**（npm create vite / pnpm create vite…），
//   但"哪条候选真能跑"必须看本机实况。此前模型只能一条一条 runCommand 去试，
//   试错成本高，断网时还会反复重试同一个脚手架。本模块把"本机实况"一次性探明，
//   压成一段短简报注入任务提示词：模型据此**选**初始化方式（有 npm + registry
//   可达 → 走官方脚手架；离线 → 直接手写工程文件），而不是靠猜。
//   判定权仍在模型：这里只提供带证据的事实。
//
// 为什么输出捕获走"临时文件 fd"而不是 stdio:"pipe"（真实事故）：
//   在 DSH 的文件沙箱下，piped stdio 的 spawn 直接 EPERM：
//     `EPERM: operation not permitted, uv_spawn 'node.exe'`（node 的 execFile 同样）。
//   若按 pipe 抓输出，全部探测会集体假阴性 → 简报谎报"这台机器什么都没有"，
//   比不探测更糟（会让模型毫无必要地手写全部工程文件）。改用
//   `stdio: ["ignore", fd, fd]`（fd = openSync 出来的临时文件）后实测正常
//   （node v24.8.0 / npm 11.6.0 都抓到了）；只在临时文件建不出来时才退回 pipe。
//
// 口径：
//   · 并发探测 + **每个探针**一个硬超时（默认 15s，见 DEFAULT_TIMEOUT_MS 的注释）：
//     一个卡死的二进制不能拖住整轮自检；
//   · 永不抛异常：探不到 = available:false + note，不是报错；
//   · available 只表示"PATH（或标准安装位）上定位到了可执行文件"——跑不动
//     （沙箱/权限/超时）只记 note，不据此判"缺失"：EPERM 不是"没装"的证据；
//   · 结果按进程内缓存 60s（refresh:true 强制重探），允许每轮任务无脑调一次；
//   · 同一份查询**并发去重**（见 probeEnvironment 的 in-flight 去重）：N 个调用者
//     同时第一次叫自检时，只跑一次探测——不让自检把自己（和整台机器）打满。
//
//   ⚠️ 本模块**不认识**"调用方愿意等多久"。给一轮开工定界的是调用方的等待预算
//   （graph.ts 的 ENV_BRIEF_BUDGET_MS）：探针慢只会让它**被放弃**，不会拖住那一轮。
//   所以这里的超时值可以给足余量，而"预算"那一侧必须小——两者不是同一个数。
// ============================================================

import { spawn } from "node:child_process";
import type { ChildProcess, StdioOptions } from "node:child_process";
import { createServer } from "node:net";
import {
    accessSync,
    closeSync,
    constants as fsConstants,
    mkdtempSync,
    openSync,
    readFileSync,
    rmSync,
    statSync,
} from "node:fs";
import { delimiter, join } from "node:path";

// ------------------------------------------------------------
// 对外类型
// ------------------------------------------------------------

/** 单个工具的探测结果。为什么要有这个结构：模型需要"有/没有 + 版本 + 在哪"三件事
 *  才能决定用哪条命令（版本影响 flags，path 影响能不能直接起进程）。 */
export interface ToolProbe {
    name: string;
    available: boolean;
    version: string | null;
    path: string | null;
    note?: string;
}

/** 一次环境自检的完整快照。probedAt 让人能判断"这份结论多旧"（缓存 60s 的可见性）。 */
export interface EnvProbe {
    probedAt: string;
    platform: string;
    tools: ToolProbe[];
    network: { npmRegistry: boolean | null; note: string };
    ports: { port: number; free: boolean }[];
    notes: string[];
}

/** 探测开关。timeoutMs 是"每个探针"的硬上限（不是总预算）；
 *  offline:true 表示调用方已知断网，直接跳过 registry 网络请求（省时间也避免假阴性）。 */
export interface ProbeOptions {
    timeoutMs?: number;
    ports?: number[];
    offline?: boolean;
    /** 跳过 60s 进程内缓存，强制重探（环境可能刚被 install/start 改动过） */
    refresh?: boolean;
}

// ------------------------------------------------------------
// 常量：工具清单与默认值
// ------------------------------------------------------------

interface ToolSpec {
    /** 工具名（PATH 上要找的可执行文件名） */
    name: string;
    /** 打印版本的参数；各工具口径不一（java -version 写 stderr，mvn 用 -v） */
    versionArgs: string[];
    /** PATH 之外还要找的标准安装位（msedge 从不进 PATH） */
    extraPaths?: string[];
    /** 该工具"拿不到版本文本"时的固定解释（避免把正常行为记成异常） */
    noteNoVersion?: string;
    /**
     * ★ 只定位、**绝不执行**（2026-09-17 实弹事故）。
     *
     *   msedge 必须走这条：Windows 上 `msedge.exe --version` **不打印版本，而是直接
     *   打开一个浏览器窗口**（或把命令转交给已运行的会话）。探测环境本来是无害的只读动作，
     *   结果每跑一次探针就弹一个人家浏览器窗口出来——被用户当场抓到两次。
     *   所以浏览器这类"执行即有副作用"的工具，可用性一律以**文件存在**为准。
     */
    noExec?: boolean;
}

/** Edge 的两个标准安装位（Windows）：PATH 上没有 msedge，但验收常要用无头浏览器渲染 */
const EDGE_PATHS: string[] = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

/** 要探测的工具清单——覆盖脚手架（npm/pnpm/npx）、JVM 栈（java/mvn/gradle）、
 *  解释器（python/pip/go/cargo）、运行态（docker）、数据（mysql/sqlite3）、
 *  版本管理（git）、渲染验收（msedge）六类决策所需的全部关键二进制。 */
const TOOL_SPECS: ToolSpec[] = [
    { name: "node", versionArgs: ["--version"] },
    { name: "npm", versionArgs: ["--version"] },
    { name: "npx", versionArgs: ["--version"] },
    { name: "pnpm", versionArgs: ["--version"] },
    { name: "yarn", versionArgs: ["--version"] },
    { name: "bun", versionArgs: ["--version"] },
    { name: "java", versionArgs: ["-version"] },
    { name: "mvn", versionArgs: ["-v"] },
    { name: "gradle", versionArgs: ["-v"] },
    { name: "python", versionArgs: ["--version"] },
    { name: "pip", versionArgs: ["--version"] },
    { name: "go", versionArgs: ["version"] },
    { name: "cargo", versionArgs: ["--version"] },
    { name: "docker", versionArgs: ["--version"] },
    { name: "git", versionArgs: ["--version"] },
    { name: "mysql", versionArgs: ["--version"] },
    { name: "sqlite3", versionArgs: ["--version"] },
    {
        name: "msedge",
        versionArgs: ["--version"],
        extraPaths: EDGE_PATHS,
        // ★ noExec：**不要执行它**。实测 `msedge --version` 会把浏览器窗口弹出来
        //   （"在现有浏览器会话中打开。"），探测动作因此产生用户可见的副作用——
        //   这是探测器的红线：只读动作不许打扰人。版本留 null，可用性看文件存在。
        noExec: true,
        noteNoVersion: "Edge 只按安装位判定（不执行探测，避免弹出浏览器窗口）；装没装看 path 即可，无头渲染照常可用",
    },
];

/**
 * 单个探针的默认**硬上限**（9/17 由 5000 抬到 15000）。
 *
 * ★ 这是**每个探针的上限**，不是"期望等待"，也不是"这一轮自检该花多久"。
 *   一轮自检的真实时长 ≈ **最慢的那一个探针**（18 个是并发跑的），而**真正给一轮开工
 *   定界的**是调用方的等待预算（graph.ts 的 ENV_BRIEF_BUDGET_MS = 2s）：
 *   探针没在预算内返回就被放弃，那一轮照常往下走。所以这里给足余量是安全的。
 *
 * 为什么 5s 不是"紧"，而是"必然误判"（本机实测，不是推断）：
 *   · 5s 上限下最常翻车的是 `bun --version`：它走 bvm 的 shim，实测 0.9s~6s 抖动，
 *     满负载下量到过 **10.4s**；被切掉时 `version` 变 null，于是
 *     `envProbe.test.ts` 的 `expect(bun?.version).toMatch(/^\d+\.\d+/)` 报
 *     「Received value must be a string: null」——这正是那批 [5094ms] 失败的真身
 *     （不是用例超时：该用例自己有 30s 预算，是**判据**被打成 null）。
 *   · 12s/15s 都远大于实测最慢值，5s 则小于它——所以这不是调参，是纠错。
 *
 * 为什么不更大（15s 而不是 30s）：这是"卡死的二进制"的兜底。它越长，一次被放弃的
 * 探测（调用方不等它了，见 graph.refreshEnvBrief）在后台活得越久；15s 已经比实测
 * 最慢值高 ~1.4 倍，再大只是在赌更极端的负载。
 */
const DEFAULT_TIMEOUT_MS = 15000;
const MIN_TIMEOUT_MS = 200;
const MAX_TIMEOUT_MS = 60000;
/** registry 只等 3s：它只是"能不能联网"的一个采样点，不值得占满整个探针预算 */
const DEFAULT_NETWORK_TIMEOUT_MS = 3000;
/** 本地 listen 是微秒级操作，2s 内没结果基本就是端口状态异常 */
const DEFAULT_PORT_TIMEOUT_MS = 2000;
/** 默认端口：Vite(5173) / 常见前后端(3000, 8080) / 兜底(8000) */
const DEFAULT_PORTS: number[] = [3000, 5173, 8080, 8000];
/** 最多查 16 个端口，防止调用方传进来一整个 1..65535 把自检拖成扫描器 */
const MAX_PORT_CHECKS = 16;
/** 简报行数预算：注入提示词的东西必须短，否则挤掉任务本身 */
const MAX_BRIEF_LINES = 25;
/** 进程内缓存 TTL：环境在任务内不会频繁变，60s 足够又不会僵化 */
const CACHE_TTL_MS = 60_000;

const NPM_PING_URL = "https://registry.npmjs.org/-/ping";

// ------------------------------------------------------------
// 可执行文件定位（不依赖 `where`/`which`，跨平台同一套逻辑）
// ------------------------------------------------------------

/** Windows 的可执行后缀集合；非 Windows 返回空后缀（PATH 上就是裸文件名） */
function executableExtensions(): string[] {
    if (process.platform !== "win32") return [""];
    const raw = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
    const exts = raw
        .split(";")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    return exts.length > 0 ? exts : [".EXE", ".CMD", ".BAT"];
}

/** 是不是"能执行的普通文件"。Windows 忽略权限位，POSIX 额外检查 X_OK */
function isExecutableFile(p: string): boolean {
    try {
        if (!statSync(p).isFile()) return false;
        if (process.platform !== "win32") accessSync(p, fsConstants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/**
 * 在 PATH 上解析可执行文件绝对路径。
 * 为什么自己扫 PATH 而不用 `where`/`which`：少起一个进程（快一个数量级）、
 * 少一条可能卡住的命令行、且不必区分 Windows/POSIX 两套命令。
 */
function resolveOnPath(name: string): string | null {
    const rawPath = process.env.PATH ?? process.env.Path ?? "";
    if (!rawPath) return null;
    const dirs = rawPath.split(delimiter);
    const exts = executableExtensions();
    for (const dir of dirs) {
        if (!dir.trim()) continue;
        for (const ext of exts) {
            const candidate = join(dir, name + ext);
            if (isExecutableFile(candidate)) return candidate;
        }
    }
    return null;
}

// ------------------------------------------------------------
// 子进程：带硬超时的输出捕获
// ------------------------------------------------------------

interface CaptureResult {
    /** 退出码；没跑起来或被杀是 null */
    code: number | null;
    /** stdout + stderr 合并文本（版本命令普遍把版本写 stderr，如 java -version） */
    output: string;
    /** spawn 层就失败（EPERM/ENOENT 等）：说明"文件在但起不来" */
    spawnError: string | null;
    /** 是否被硬超时打断（二进制存在但卡死） */
    timedOut: boolean;
}

/** 临时目录：只用环境变量推导，不引 node:os（保持依赖面 = child_process/net/fs/path） */
function tempRoot(): string {
    return process.env.TEMP ?? process.env.TMP ?? process.env.TMPDIR ?? ".";
}

/** Windows 上 .cmd/.bat 不能直接被 Node 20+ spawn（EINVAL），必须经 cmd.exe 转发 */
function isWindowsShim(file: string): boolean {
    return process.platform === "win32" && /\.(cmd|bat)$/i.test(file);
}

/** 杀掉探针进程。Windows 上 .cmd 是 cmd.exe 包装进程，只杀父进程留不下真正的工具进程 → taskkill /T */
function killProbe(child: ChildProcess | null): void {
    if (!child) return;
    const pid = child.pid;
    try {
        if (process.platform === "win32" && typeof pid === "number") {
            spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).unref();
        }
    } catch {
        // taskkill 不可用（被拦/不存在）：下面 child.kill() 兜底
    }
    try {
        child.kill("SIGKILL");
    } catch {
        // 进程可能已经自己退了
    }
    try {
        child.kill();
    } catch {
        // 同上
    }
}

/**
 * 跑一次命令并抓输出，硬超时到点必返回（不抛异常）。
 * 输出走临时文件 fd（见文件头"为什么不用 pipe"），临时文件建不出来才退回 pipe。
 */
function runOnce(cmd: string, argv: string[], timeoutMs: number): Promise<CaptureResult> {
    return new Promise<CaptureResult>((resolve) => {
        let settled = false;
        let child: ChildProcess | null = null;
        let fd: number | null = null;
        let outFile: string | null = null;
        let outDir: string | null = null;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let piped = "";

        const cleanup = (): void => {
            if (fd !== null) {
                try {
                    closeSync(fd);
                } catch {
                    // 已经关过了
                }
                fd = null;
            }
            if (outDir !== null) {
                try {
                    rmSync(outDir, { recursive: true, force: true });
                } catch {
                    // 临时文件残留无害，不影响探测结论
                }
                outDir = null;
            }
            outFile = null;
        };

        const finish = (r: CaptureResult): void => {
            if (settled) return;
            settled = true;
            if (timer !== null) clearTimeout(timer);
            cleanup();
            resolve(r);
        };

        let stdio: StdioOptions = "pipe";
        try {
            outDir = mkdtempSync(join(tempRoot(), "crewforge-envprobe-"));
            outFile = join(outDir, "out.txt");
            const opened = openSync(outFile, "w");
            fd = opened;
            stdio = ["ignore", opened, opened];
        } catch {
            fd = null;
            outDir = null;
            outFile = null;
            stdio = "pipe";
        }
        const usePipe = stdio === "pipe";

        timer = setTimeout(() => {
            killProbe(child);
            finish({ code: null, output: "", spawnError: null, timedOut: true });
        }, Math.max(1, Math.round(timeoutMs)));

        try {
            child = spawn(cmd, argv, { windowsHide: true, stdio });
        } catch (e) {
            finish({ code: null, output: "", spawnError: (e as Error).message, timedOut: false });
            return;
        }

        if (usePipe) {
            child.stdout?.on("data", (c: Buffer | string) => {
                piped += String(c);
            });
            child.stderr?.on("data", (c: Buffer | string) => {
                piped += String(c);
            });
        }
        const started: ChildProcess = child;
        started.on("error", (e: Error) => {
            finish({ code: null, output: piped, spawnError: e.message, timedOut: false });
        });
        started.on("close", (code: number | null) => {
            let output = piped;
            if (!usePipe && outFile !== null) {
                try {
                    output = readFileSync(outFile, "utf8");
                } catch {
                    output = "";
                }
            }
            finish({ code, output, spawnError: null, timedOut: false });
        });
    });
}

/**
 * 跑命令（带 Windows shim 兼容）。先按原名直接起：Bun 能直接起 .cmd/.bat，
 * 路径带空格的引号交给运行时处理最稳；只有在 spawn **根本没起来**（Node 20+
 * 对 .cmd/.bat 直接 EINVAL）时才经 cmd.exe 转发一次。
 *
 * 为什么转发时把 file/args **分列**传给 cmd 而不是自己拼一个带引号的字符串（真实踩坑）：
 *   拼字符串 `cmd /s /c "\"C:\...\npm.CMD\" \"--version\""` 时，运行时会按 Windows
 *   规则把内层引号转义成 `\"`，而 cmd.exe **不认识** `\"`，于是报
 *   `'\"C:\...\npm.CMD\"' is not recognized as an internal or external command`，
 *   所有 .CMD 工具（npm/pnpm/bun/bun 的 bvm shim…）集体 exit 1 且无输出 →
 *   简报谎报"没版本"。分列传参实测可用（npm.CMD --version → 11.6.0）。
 */
async function runCapture(file: string, args: string[], timeoutMs: number): Promise<CaptureResult> {
    const direct = await runOnce(file, args, timeoutMs);
    if (direct.spawnError === null || !isWindowsShim(file)) return direct;
    const comspec = process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe";
    const viaCmd = await runOnce(comspec, ["/d", "/c", file, ...args], timeoutMs);
    return viaCmd.spawnError === null ? viaCmd : direct;
}

// ------------------------------------------------------------
// 单项探测：工具 / 网络 / 端口
// ------------------------------------------------------------

/** 从版本输出里取第一个版本号样式 token（java 的 "17.0.2"、git 的 "2.43.0.windows.1" 都要） */
function pickVersion(output: string): string | null {
    const m = /(\d+\.\d+(?:\.\d+)?(?:[-+._][0-9A-Za-z.-]+)*)/.exec(output);
    return m ? (m[1] ?? null) : null;
}

/**
 * 探一个工具。
 * available 的判据是"定位到了文件"，不是"跑成功了"：沙箱 EPERM / 超时只记 note。
 * 这样即使输出捕获被环境拦掉，也不会谎报"工具缺失"（假阴性比不知道更危险）。
 */
async function probeTool(spec: ToolSpec, timeoutMs: number): Promise<ToolProbe> {
    let resolved: string | null = resolveOnPath(spec.name);
    if (!resolved && spec.extraPaths) {
        for (const p of spec.extraPaths) {
            if (isExecutableFile(p)) {
                resolved = p;
                break;
            }
        }
    }
    if (!resolved) {
        return { name: spec.name, available: false, version: null, path: null };
    }
    // ★ 只定位不执行：有副作用的工具（浏览器）绝不在探针里跑起来
    if (spec.noExec) {
        return {
            name: spec.name,
            available: true,
            version: null,
            path: resolved,
            ...(spec.noteNoVersion ? { note: spec.noteNoVersion } : {}),
        };
    }
    const res = await runCapture(resolved, spec.versionArgs, timeoutMs);
    if (res.spawnError !== null) {
        return {
            name: spec.name,
            available: true,
            version: null,
            path: resolved,
            note: `已定位可执行文件但无法执行探测（${res.spawnError}）；可用性以文件存在为准`,
        };
    }
    if (res.timedOut) {
        return {
            name: spec.name,
            available: true,
            version: null,
            path: resolved,
            note: `版本探测超时（>${Math.round(timeoutMs)}ms）：二进制存在但可能卡死，用前先试跑`,
        };
    }
    const version = pickVersion(res.output);
    if (version === null) {
        return {
            name: spec.name,
            available: true,
            version: null,
            path: resolved,
            note: spec.noteNoVersion ?? `版本命令无输出（exitCode=${res.code === null ? "null" : res.code}）`,
        };
    }
    return { name: spec.name, available: true, version, path: resolved };
}

/**
 * 探 npm registry 可达性。
 * 判据：拿到 HTTP 响应（哪怕是 4xx）就算"网络通、registry 在答"；只有
 * 连接/超时/DNS 失败才算不可达——所以 5xx 之外不看状态码细节。
 */
async function probeNpmRegistry(timeoutMs: number): Promise<{ npmRegistry: boolean | null; note: string }> {
    if (typeof fetch !== "function") {
        return { npmRegistry: null, note: "宿主运行时没有 fetch → registry 未探测" };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
        controller.abort();
    }, Math.max(1, Math.round(timeoutMs)));
    const t0 = Date.now();
    try {
        const res = await fetch(NPM_PING_URL, {
            method: "GET",
            signal: controller.signal,
            headers: { accept: "application/json", "user-agent": "crewforge-envprobe" },
        });
        try {
            await res.arrayBuffer(); // 排空 body，避免连接悬挂
        } catch {
            // body 读不完不影响"收到响应"这个结论
        }
        const ms = Date.now() - t0;
        if (res.status >= 500) {
            return { npmRegistry: false, note: `registry 返回 HTTP ${res.status}（服务端异常，${ms}ms）` };
        }
        return { npmRegistry: true, note: `registry 可达（HTTP ${res.status}，${ms}ms）` };
    } catch (e) {
        return { npmRegistry: false, note: `registry 不可达：${(e as Error).message}` };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * 探一个端口是否空闲：能独占 listen 127.0.0.1:port 就是空闲。
 * 端口被占用**不是错误**（本机常常跑着别的东西），只作为事实记录。
 * 拿不到结论（超时）时保守判 false——"能不能 bind"没确认就不该让模型当成可用。
 */
function probePort(port: number, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const server = createServer();
        const finish = (free: boolean): void => {
            if (settled) return;
            settled = true;
            if (timer !== null) clearTimeout(timer);
            try {
                server.close();
            } catch {
                // 还没 listen 就 close：忽略
            }
            resolve(free);
        };
        timer = setTimeout(() => finish(false), Math.max(1, Math.round(timeoutMs)));
        server.once("error", () => finish(false));
        server.once("listening", () => finish(true));
        try {
            // exclusive:false 更好（Windows 上 SO_EXCLUSIVEADDRUSE 会误报），但这里只要"能不能占住"
            server.listen({ host: "127.0.0.1", port });
        } catch {
            finish(false);
        }
    });
}

// ------------------------------------------------------------
// 结论（notes）：给人看的短句，也是简报的素材
// ------------------------------------------------------------

function specOf(tools: ToolProbe[], name: string): ToolProbe | undefined {
    return tools.find((t) => t.name === name);
}

function isAvailable(tools: ToolProbe[], name: string): boolean {
    return specOf(tools, name)?.available === true;
}

function describeTool(t: ToolProbe): string {
    return t.version ? `${t.name} ${t.version}` : t.name;
}

/** 生成"结论"短句。刻意写成"事实 + 推论"的形态，模型可以直接引用进决策。
 *  （9/18 起导出：这条"结论句"是 s1 零产出事故的现场，必须有直接单测盯着，不能只经 renderEnvBrief 间接覆盖。） */
export function buildNotes(tools: ToolProbe[], network: EnvProbe["network"], ports: EnvProbe["ports"]): string[] {
    const notes: string[] = [];

    const pkgMgr = (["npm", "pnpm", "yarn", "bun"] as const)
        .map((n) => specOf(tools, n))
        .find((t) => t?.available === true);
    if (network.npmRegistry === false) {
        notes.push("离线：脚手架不可用，需手写工程文件");
    } else if (!pkgMgr) {
        notes.push("npm/pnpm/yarn/bun 全缺失 → 脚手架不可用，需手写工程文件");
    } else if (network.npmRegistry === true) {
        notes.push(`${pkgMgr.name} 可用（${pkgMgr.version ?? "版本未知"}）+ registry 可达 → 官方脚手架可用`);
    } else {
        notes.push("registry 未探测（offline 模式）→ 脚手架可用性未知，先按手写工程文件兜底");
    }

    // ★ 9/18 修（这一条是 s1 那轮"跑 19 分钟零产出"的真根因）：
    //   原写法把「mvn 不在 PATH」直接翻译成「JVM 栈不可选」——
    //   于是 agent 拿着 w1 派下来的 Spring Boot 任务书，看到的却是"JVM 栈不可选"，
    //   就去**想办法把它变成可选**：下 maven-wrapper、探 javac、翻 %USERPROFILE%\.m2、
    //   找 wrapper dists、试 mysql 密码、docker ps…最后 55 次 LLM 调用 / 167k output token /
    //   88 次工具调用里**一次文件写入都没有**，落盘的只有骨架和不含代码的 mw.zip。
    //   澄清两件被混为一谈的事：**"别新选 JVM 栈"（选型建议）≠"JVM 工程做不了"（能力）**。
    //   没有 mvn 从来不等于后者——Maven Wrapper（mvnw/mvnw.cmd + .mvn/wrapper）就是这个场景的
    //   标准答案，退一步手写 pom.xml + 源码本身就是可交付物，"跑不了 mvn package" 只影响
    //   **编译校验**（如实记「未验证」），不是不干活的理由。
    const hasJava = isAvailable(tools, "java");
    const hasBuildTool = isAvailable(tools, "mvn") || isAvailable(tools, "gradle");
    if (!hasJava) {
        notes.push(
            "java 缺失 → JVM 栈不可选（本机也无法编译/运行 JVM 工程；工程文件照样手写，编译校验记「未验证」）",
        );
    } else if (!hasBuildTool) {
        notes.push(
            "java 在、mvn/gradle 不在 → **本机不能新选 JVM 栈**；"
            + "但任务书已指定 JVM 时照做：按 skills/bootstrap-project.md 手写 pom.xml + 源码"
            + "（构建脚本用 Maven Wrapper：mvnw/mvnw.cmd + .mvn/wrapper，官方发行包可直接下载），"
            + "**不要**为了「装/找构建工具」耗轮次——跑不了 `mvn package` 只是把编译校验记成「未验证」，不阻塞交付。",
        );
    }

    if (!isAvailable(tools, "mysql")) {
        notes.push("mysql 客户端缺失 → 数据库联调/落库验证要在代码层兜底（sqlite3 或 mock）");
    }
    if (!isAvailable(tools, "msedge")) {
        notes.push("msedge 缺失 → 无头浏览器渲染/截图验收不可用，验收退到 HTTP 层");
    }

    const busy = ports.filter((p) => !p.free).map((p) => p.port);
    if (busy.length > 0) {
        notes.push(`端口 ${busy.join("、")} 已被占用 → 不要写进 dev server 配置`);
    }

    const execFailed = tools.filter((t) => t.available && (t.note ?? "").startsWith("已定位可执行文件但无法执行")).length;
    if (execFailed > 0) {
        notes.push(`${execFailed} 个工具已定位但探测执行失败（沙箱/权限限制？）→ 可用性以 path 存在为准，别急着判缺失`);
    }
    return notes;
}

// ------------------------------------------------------------
// 简报渲染（纯函数）
// ------------------------------------------------------------

/** 工具清单渲染：工具多时只列前 12 个，避免一行挤爆提示词 */
function formatToolList(tools: ToolProbe[]): string {
    if (tools.length === 0) return "（无）";
    const head = tools.slice(0, 12).map(describeTool).join("、");
    return tools.length > 12 ? `${head} 等 ${tools.length} 个` : head;
}

/** 脚手架可行性结论（简报核心：决定"用脚手架初始化"还是"手写工程文件"） */
function scaffoldVerdict(p: EnvProbe): string {
    const pm = (["npm", "pnpm", "yarn", "bun"] as const)
        .map((n) => specOf(p.tools, n))
        .find((t) => t?.available === true);
    const reg = p.network.npmRegistry;
    if (reg === false) {
        return "离线（registry 不可达）→ 官方脚手架不可用，必须手写工程文件；不要再反复重试 npx/create-*";
    }
    if (!pm) {
        return "包管理器缺失（npm/pnpm/yarn/bun 都没有）→ 官方脚手架不可用，必须手写工程文件";
    }
    if (reg === true) {
        return `脚手架可用 —— ${describeTool(pm)} 可用 + registry 可达 → 优先官方脚手架（\`npm create vite@latest\` / \`npx create-*\`，用非交互参数），脚手架失败再手写工程文件`;
    }
    return "registry 未探测 → 脚手架可用性未知：先按手写工程文件推进，联网后（或 refresh 自检）再改用脚手架";
}

/** 构建与验证可行性：决定了"能不能 install/build/test/无头渲染" */
function buildVerdict(p: EnvProbe): string {
    const parts: string[] = [];
    const node = specOf(p.tools, "node");
    const npm = specOf(p.tools, "npm");
    if (node?.available === true && npm?.available === true) {
        parts.push(`JS 可构建可验证（node/npm 都在，install/build/test 能跑）`);
    } else if (node?.available === true) {
        parts.push("node 在但包管理器缺失 → 装不了依赖，只能跑裸 node");
    } else {
        parts.push("node 缺失 → JS 工具链不可选");
    }

    // ★ 9/18 同源修正：java 在、只是没有构建工具时，原句直接写"JVM 栈不可选"，
    //   和 buildNotes 里那处是同一个错误信念（实测把 agent 带到"想办法装 Maven"上）。
    //   拆成三种情形：能构建 / 压根没 java / 有 java 缺构建工具（可交付，只是本机不能新选 JVM 栈）。
    const hasJava = isAvailable(p.tools, "java");
    const hasBuild = isAvailable(p.tools, "mvn") || isAvailable(p.tools, "gradle");
    if (hasJava && hasBuild) {
        parts.push("JVM 构建可跑（java + mvn/gradle）");
    } else if (!hasJava) {
        parts.push("java 缺失 → JVM 栈不可选（本机也无法编译/运行 JVM 工程）");
    } else {
        parts.push(
            "java 在、mvn/gradle 不在 → **本机不能新选 JVM 栈**；"
            + "任务书已指定 JVM 时照做：手写 pom.xml + 源码 + Maven Wrapper，编译校验记「未验证」，不阻塞",
        );
    }

    if (isAvailable(p.tools, "msedge")) {
        parts.push("msedge 可用 → 可做无头渲染/截图验收");
    } else {
        parts.push("msedge 缺失 → 渲染验收不可用，验收退到 HTTP 层");
    }
    return parts.join("；");
}

/** 端口结论：给模型一个"能直接用"的端口集合 */
function portVerdict(p: EnvProbe): string {
    if (p.ports.length === 0) return "未探测（调用时没给端口清单）";
    const free = p.ports.filter((x) => x.free).map((x) => x.port);
    const busy = p.ports.filter((x) => !x.free).map((x) => x.port);
    const seg: string[] = [];
    seg.push(free.length > 0 ? `空闲 ${free.join("、")}` : "无空闲端口");
    if (busy.length > 0) seg.push(`占用 ${busy.join("、")}（别写进配置）`);
    return seg.join("；");
}

/**
 * 把 EnvProbe 压成注入提示词的短简报（≤25 行，纯函数、不读时钟、不改入参）。
 * 为什么不是"原始 dump"：模型看 JSON 表格要自己推理，而"该用脚手架还是手写"
 * 这种结论是确定性的，机器直接给出来更省 token 也更不容易推错。
 */
export function renderEnvBrief(p: EnvProbe): string {
    const avail = p.tools.filter((t) => t.available);
    const missing = p.tools.filter((t) => !t.available);
    const lines: string[] = [];
    lines.push("## 环境自检（本机实测，非猜测）");
    lines.push(`平台：${p.platform}；探测时间：${p.probedAt}`);
    lines.push("");
    lines.push(`**可用的工具链**：${formatToolList(avail)}`);
    if (missing.length > 0) {
        lines.push(`**不可用/未安装**：${missing.map((t) => t.name).join("、")}`);
    }
    lines.push(`**脚手架可行性**：${scaffoldVerdict(p)}`);
    lines.push(`**构建与验证可行性**：${buildVerdict(p)}`);
    lines.push(`**端口**：${portVerdict(p)}`);
    // 结论块只补"上文没说到的"：分组行已经承载了主要结论，重复列一遍纯属浪费提示词预算
    const rendered = lines.join("\n");
    const extra = p.notes.filter((n) => !rendered.includes(n));
    if (extra.length > 0) {
        lines.push("**补充结论**：");
        for (const n of extra.slice(0, 4)) lines.push(`- ${n}`);
    }
    lines.push("行动口径：初始化方式按上面「脚手架可行性」选（先探测后执行，失败退手写）；构建/验证只用「可用」的工具链；dev server 端口从空闲里挑。");
    if (lines.length > MAX_BRIEF_LINES) {
        const cut = lines.slice(0, MAX_BRIEF_LINES - 1);
        cut.push("…（余下条目已省略）");
        return cut.join("\n");
    }
    return lines.join("\n");
}

// ------------------------------------------------------------
// 主入口：并发自检 + 60s 进程内缓存
// ------------------------------------------------------------

interface CacheEntry {
    at: number;
    signature: string;
    value: EnvProbe;
}

let cache: CacheEntry | null = null;

/**
 * 正在飞的探测（同一份查询的并发去重）——见 probeEnvironment 里的注释。
 * 存 promise 而不是结果：**共享的是"这一次探测"本身**，调用方各拿各的引用语义不变。
 */
let inflight: { signature: string; promise: Promise<ProbeOutcome> } | null = null;

/**
 * 探测结果的**元信息**——台本/台账要能诚实区分"这轮真跑了探针"与"这轮只是命中记忆"。
 *
 *   为什么不能只在 EnvProbe 上加个字段：命中的是**同一个对象**（`expect(b).toBe(a)`
 *   这条既有断言钉着引用相等），在对象上盖一个 fromMemo 章会连带改掉先前那位调用者
 *   看到的那一份——那就不是"如实记录"，而是往历史结论上贴新标签了。
 */
export interface ProbeOutcome {
    probe: EnvProbe;
    /** true = 命中 60s 进程内记忆，本次**没有**真的跑探针 */
    memoHit: boolean;
}

function normalizeTimeoutMs(v: number | undefined, fallback: number): number {
    if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
    return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(v)));
}

function normalizePorts(input: number[] | undefined): number[] {
    const src = input && input.length > 0 ? input : DEFAULT_PORTS;
    const out: number[] = [];
    for (const v of src) {
        if (!Number.isInteger(v) || v < 1 || v > 65535) continue;
        if (out.includes(v)) continue;
        if (out.length >= MAX_PORT_CHECKS) break;
        out.push(v);
    }
    return out;
}

/**
 * 探测本机环境。并发跑完所有探针，**永不抛异常**。
 * 60s 内重复调用直接返回缓存对象（同一引用）；`refresh:true` 强制重探。
 * 入参（超时/端口/offline）不同则视为不同查询，不会串用缓存。
 *
 * 需要"这份结论是现探的还是命中记忆"的调用方用 probeEnvironmentMeta（同一份实现）。
 */
export async function probeEnvironment(opts?: ProbeOptions): Promise<EnvProbe> {
    return (await probeEnvironmentMeta(opts)).probe;
}

/**
 * 同 probeEnvironment，另带一层**元信息**（memoHit）供台账如实记账。
 *
 * ★ 并发去重（9/17 负载修复，实测依据）：
 *   `bun test` 把**所有测试文件跑在同一个进程里**（实测：模块级计数器跨文件连续，
 *   pid 相同），而每个跑到 graph 的文件都会叫一次自检。没有去重时它们是**各探各的**：
 *   N 个文件同时第一次开工 = N×18 个子进程 + N 次 registry ping + N×4 个端口探测，
 *   机器被自检自己打满——实测同一台机器上单次冷探测因此从 ~4s 涨到 **10.4s**，
 *   而 5s 上限下的探针就被切成了"版本为 null"。
 *   去重之后，同一份查询（同样的超时/端口/offline）在飞的时候，后来者**共享同一次探测**，
 *   所以"第一个开工的那一轮"不会因为并发而变慢，记忆也更容易被填上（refresh:true 同样
 *   只保证"是新的一次"，不保证"我要自己独占跑一次"）。
 */
export async function probeEnvironmentMeta(opts?: ProbeOptions): Promise<ProbeOutcome> {
    const timeoutMs = normalizeTimeoutMs(opts?.timeoutMs, DEFAULT_TIMEOUT_MS);
    const offline = opts?.offline === true;
    const ports = normalizePorts(opts?.ports);
    const signature = `${timeoutMs}|${ports.join(",")}|${offline ? "offline" : "online"}`;

    if (opts?.refresh !== true && cache !== null && cache.signature === signature && Date.now() - cache.at < CACHE_TTL_MS) {
        return { probe: cache.value, memoHit: true };
    }
    if (inflight !== null && inflight.signature === signature) return inflight.promise;

    const promise = runProbe({ timeoutMs, offline, ports, signature });
    inflight = { signature, promise };
    try {
        return await promise;
    } finally {
        // 只在"这一份还是我挂上去的那份"时清空：清早了会让后来者重复探，
        // 清晚了（别人覆盖过）会把别人的在飞状态抹掉。
        if (inflight !== null && inflight.promise === promise) inflight = null;
    }
}

/** 真跑一次探测并写记忆（永不抛异常；`refresh` 与否由调用方决定，见 probeEnvironmentMeta） */
async function runProbe(o: {
    timeoutMs: number; offline: boolean; ports: number[]; signature: string;
}): Promise<ProbeOutcome> {
    const { timeoutMs, offline, ports, signature } = o;
    const platform = `${process.platform} ${process.arch}`;
    try {
        const networkTimeout = Math.min(timeoutMs, DEFAULT_NETWORK_TIMEOUT_MS);
        const portTimeout = Math.min(timeoutMs, DEFAULT_PORT_TIMEOUT_MS);

        const [tools, network, portStates] = await Promise.all([
            Promise.all(TOOL_SPECS.map((s) => probeTool(s, timeoutMs))),
            offline
                ? Promise.resolve<EnvProbe["network"]>({
                      npmRegistry: null,
                      note: "offline 模式：未探测 registry 可达性",
                  })
                : probeNpmRegistry(networkTimeout),
            Promise.all(ports.map(async (port) => ({ port, free: await probePort(port, portTimeout) }))),
        ]);

        const value: EnvProbe = {
            probedAt: new Date().toISOString(),
            platform,
            tools,
            network,
            ports: portStates,
            notes: buildNotes(tools, network, portStates),
        };
        cache = { at: Date.now(), value, signature };
        return { probe: value, memoHit: false };
    } catch (e) {
        // 兜底：任何一个探针的意外抛错都不该让整个自检失败（宁可给残缺但坦白的结果）
        const fallback: EnvProbe = {
            probedAt: new Date().toISOString(),
            platform,
            tools: TOOL_SPECS.map((s) => ({ name: s.name, available: false, version: null, path: null })),
            network: { npmRegistry: null, note: "自检异常中断，网络未确认" },
            ports: ports.map((port) => ({ port, free: false })),
            notes: [`环境自检异常：${(e as Error).message} → 结论不可信，请用 runCommand 单点确认`],
        };
        cache = { at: Date.now(), value: fallback, signature };
        return { probe: fallback, memoHit: false };
    }
}
