// ============================================================
// tools/processSandbox.ts —— Developer 命令执行的**唯一**出口与隔离边界
//
//   核心原则（规格二 / 三）：
//     不限制"能执行什么命令"，限制"命令能访问什么环境"。
//
//   ⚠️ 先说清楚一件事，代码与文档都必须承认：
//     **"把 cwd 设成项目目录"不是沙箱。** cwd 只约束相对路径的默认起点，
//     一个 `node -e "fs.writeFileSync('/任意绝对路径','x')"` 照样能写满磁盘。
//     所以本文件把隔离分成两档，并**拒绝**把软档冒充硬档：
//
//     · 硬档（realIsolation = true）
//       由容器运行时提供（docker/podman 等），文件系统、网络、用户都是真的隔开，
//       命令在容器内跑，宿主机文件系统默认不可见。当前宿主若没有可用后端，
//       直接返回结构化 SANDBOX_UNAVAILABLE，**不允许**静默降级成宿主机裸跑。
//
//     · 软档（realIsolation = false，softIsolation = true，必须显式开启）
//       本机无容器时的受约束执行：环境变量清洗、cwd 限定、进程树超时终止、
//       输出上限、执行前后保护路径快照 + 执行期间轮询检测项目外写入并终止。
//       它**能发现**越界写入，也能在轮询粒度内**打断**它，但**不能阻止**瞬时写入。
//       调用方（真实 LLM 模式）默认拿不到这一档——必须由部署方显式选择。
//
//   所以：strict + 无后端 = 不执行；soft = 显式选择，且证据里永远带着
//   `realIsolation:false`，不许被读成"已经隔离好了"。
// ============================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashOf } from "../ledger";
import { ProcessManager, ProcessLimitError } from "./processManager";
import type { KillReason, ManagedProcess } from "./processManager";

export const SANDBOX_UNAVAILABLE = "SANDBOX_UNAVAILABLE";

export type SandboxMode = "strict" | "soft";
/** none = 未配置任何隔离后端；local = 软档；docker = 容器硬档 */
export type SandboxBackend = "none" | "local" | "docker";

export interface NetworkPolicy {
    /** 允许访问的主机名（默认只允许本机回环） */
    allowHosts: string[];
    /** 显式放开外网（默认 false；软档下这只是**策略**，不是强制拦截） */
    allowExternal: boolean;
}

export interface SandboxTimeouts {
    commandMs: number;
    buildMs: number;
    startMs: number;
    httpMs: number;
}

export interface DockerBackendOptions {
    image: string;
    user?: string;
    extraArgs?: string[];
    /** 容器内挂载点（项目根挂到这里） */
    mountPoint?: string;
    /** 探测 Docker 守护进程是否可用（测试可注入，保证确定性） */
    probe?: () => boolean;
}

export interface SandboxConfig {
    mode: SandboxMode;
    backend: SandboxBackend;
    timeouts: SandboxTimeouts;
    maxOutputBytes: number;
    maxProcessCount: number;
    networkPolicy: NetworkPolicy;
    /**
     * 显式允许透传给子进程的**额外**环境变量名。
     * 密钥类的过滤规则（见 DENY_* ）不受此名单影响，永远优先。
     */
    passthroughEnv: string[];
    /** 进程运行期间被持续监视的写保护路径（绝对路径，目录或文件） */
    protectedPaths: string[];
    /** 是否在执行期间轮询检测项目外写入（默认开） */
    watchProtectedPaths: boolean;
    watchIntervalMs: number;
    /** 截断时原始输出的落盘根目录 */
    logDir: string;
    /**
     * 部署级命令策略：非空即启用。
     * 这是**部署环境的安全策略**，不是 Prompt 规则，也不再是 Developer 的默认限制。
     */
    deploymentCommandAllow: string[];
    /** 容器后端参数（backend=docker 时生效） */
    docker?: DockerBackendOptions;
}

export const DEFAULT_TIMEOUTS: SandboxTimeouts = {
    commandMs: 2 * 60_000,     // 普通命令 2 分钟
    buildMs: 10 * 60_000,      // 前后端构建 10 分钟
    startMs: 2 * 60_000,       // 服务启动等待 2 分钟
    httpMs: 30_000,            // HTTP 请求 30 秒
};

export const DEFAULT_NETWORK_POLICY: NetworkPolicy = {
    allowHosts: ["localhost", "127.0.0.1", "::1", "[::1]"],
    allowExternal: false,
};

/**
 * 绝不允许进入生成项目子进程的环境变量（规格三.6）。
 * 名字命中 DENY_NAME_RE 或等于 DENY_EXACT 的一律删除。
 */
const DENY_EXACT: readonly string[] = [
    "OPENAI_API_KEY", "DEEPSEEK_API_KEY", "ANTHROPIC_API_KEY", "DASHSCOPE_API_KEY",
    "DATABASE_PASSWORD", "DB_PASSWORD", "MYSQL_PASSWORD", "MYSQL_ROOT_PASSWORD",
    "PGPASSWORD", "REDIS_PASSWORD", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "NPM_TOKEN", "CI_JOB_TOKEN",
    "TENCENT_SECRET_ID", "TENCENT_SECRET_KEY", "ALIYUN_ACCESS_KEY_ID", "ALIYUN_ACCESS_KEY_SECRET",
];
const DENY_NAME_RE = /(API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_?KEY|SSH_?AUTH_SOCK|_AUTH)$/i;

export interface SandboxCapabilities {
    mode: SandboxMode;
    backend: SandboxBackend;
    /** 只有容器后端才为 true */
    realIsolation: boolean;
    /** 软档（受约束的宿主执行）已显式启用 */
    softIsolation: boolean;
    /** 生效的边界清单（给证据与文档用） */
    boundaries: string[];
    /** 明确的**不**能力（不许含糊带过） */
    limitations: string[];
    reasons: string[];
    networkPolicy: NetworkPolicy;
    timeouts: SandboxTimeouts;
    maxOutputBytes: number;
    maxProcessCount: number;
}

function hasDockerDaemon(): boolean {
    try {
        const r = Bun.spawnSync(["docker", "info", "--format", "{{.ServerVersion}}"], {
            stdout: "ignore", stderr: "ignore",
        });
        return r.exitCode === 0;
    } catch {
        return false;
    }
}

/** 沙箱能力探测：纯函数 + 可注入探测，便于零 LLM 单测拿到确定结论 */
export function resolveSandboxCapabilities(cfg: Partial<SandboxConfig> = {}): SandboxCapabilities {
    const mode: SandboxMode = cfg.mode ?? "strict";
    // soft 默认就是本机受约束执行 → backend=local；strict 没有后端就是 none。
    // 这个默认值很重要：报告里必须能一眼看出"用的是本机 soft"，而不是含糊的 backend=none。
    const backend: SandboxBackend = cfg.backend ?? (mode === "soft" ? "local" : "none");
    const networkPolicy = cfg.networkPolicy ?? DEFAULT_NETWORK_POLICY;
    const timeouts = cfg.timeouts ?? DEFAULT_TIMEOUTS;

    const base = {
        mode, backend,
        networkPolicy, timeouts,
        maxOutputBytes: cfg.maxOutputBytes ?? 256 * 1024,
        maxProcessCount: cfg.maxProcessCount ?? 8,
    };

    if (mode === "soft") {
        return {
            ...base,
            realIsolation: false,
            softIsolation: true,
            boundaries: [
                "环境变量清洗（密钥类一律删除）",
                "cwd 与读写路径限定在生成项目内",
                "进程树超时终止 + 输出上限 + 进程数上限",
                "执行前后对保护路径做文件快照，执行期间轮询检测项目外写入并终止",
                "httpRequest 默认只放行 localhost / 127.0.0.1 / ::1",
            ],
            limitations: [
                "子进程仍然拥有宿主机用户权限",
                "cwd 不是沙箱：子进程理论上可以读取项目外的文件",
                "项目外写入只能检测 + 轮询打断，不能绝对阻止",
                "网络访问无法由 soft 模式强制隔离",
                "Windows 进程树终止使用 taskkill，属于 best-effort",
                "仅用于本机开发与真实 LLM 冒烟，不得用于生产运行不受信生成代码",
            ],
            reasons: [
                "显式选择 soft 模式：本机无可用容器后端，执行「受约束但非隔离」的本机命令",
                "禁止把本模式描述成安全隔离；生产必须改用真实隔离后端",
            ],
        };
    }

    if (backend === "docker") {
        const probe = cfg.docker?.probe ?? hasDockerDaemon;
        const image = cfg.docker?.image ?? "";
        if (!image) {
            return unavailable(mode, backend, ["backend=docker 但未配置镜像名（sandbox.docker.image）"]);
        }
        if (!probe()) {
            return unavailable(mode, backend, ["Docker 守护进程不可用（docker info 失败）"]);
        }
        const mount = cfg.docker?.mountPoint ?? "/workspace";
        return {
            ...base,
            realIsolation: true,
            softIsolation: false,
            boundaries: [
                `命令在容器 ${image} 内执行，挂载点 ${mount} 只映射生成项目`,
                "宿主机文件系统默认不可见；网络按 networkPolicy 决定（默认 --network=none）",
                "环境变量在容器边界上重新给，宿主机密钥不进入容器",
            ],
            limitations: [
                "容器内仍可写自己看到的挂载点（也就是生成项目内部）——这是 Designer 的预期能力",
                "镜像内的工具链决定能跑什么（Java/Node 版本由镜像决定）",
            ],
            reasons: [`容器后端可用：${image}`],
        };
    }

    return unavailable(mode, backend, [
        "未配置隔离后端（sandbox.backend = none）",
        "当前环境没有可用的容器运行时，禁止在宿主机上开放无限制 Shell",
    ]);
}

function unavailable(mode: SandboxMode, backend: SandboxBackend, reasons: string[]): SandboxCapabilities {
    return {
        mode, backend,
        realIsolation: false,
        softIsolation: false,
        boundaries: [],
        limitations: ["没有任何隔离边界——命令根本不会被执行"],
        reasons,
        networkPolicy: DEFAULT_NETWORK_POLICY,
        timeouts: DEFAULT_TIMEOUTS,
        maxOutputBytes: 256 * 1024,
        maxProcessCount: 8,
    };
}

/** 结构化"沙箱不可用"结果——给工具与上层统一消费 */
export interface SandboxUnavailableResult {
    code: typeof SANDBOX_UNAVAILABLE;
    mode: SandboxMode;
    backend: SandboxBackend;
    reasons: string[];
    hint: string;
}

export class SandboxUnavailableError extends Error {
    readonly code = SANDBOX_UNAVAILABLE;
    readonly detail: SandboxUnavailableResult;
    constructor(detail: SandboxUnavailableResult) {
        super(`[${SANDBOX_UNAVAILABLE}] ${detail.reasons.join("；")}`);
        this.name = "SandboxUnavailableError";
        this.detail = detail;
    }
}

// ============================================================
// 环境变量清洗
// ============================================================

export interface SanitizedEnv {
    env: Record<string, string>;
    /** 被删掉的变量名（**只记名字，绝不记值**） */
    removed: string[];
    /** 显式透传（本任务所需）的变量名 */
    forwarded: string[];
}

/**
 * 子进程环境 = 宿主环境 − 密钥类变量 + 显式透传。
 * 过滤看**名字**，不看值——值永远不读出、不记录、不落盘。
 */
export function sanitizeEnv(
    hostEnv: NodeJS.ProcessEnv | Record<string, string | undefined>,
    opts: { passthrough?: string[]; extra?: Record<string, string> } = {},
): SanitizedEnv {
    const passthrough = new Set(opts.passthrough ?? []);
    const env: Record<string, string> = {};
    const removed: string[] = [];
    const forwarded: string[] = [];

    for (const [k, v] of Object.entries(hostEnv)) {
        if (v === undefined) continue;
        // 硬性密钥过滤优先于任何白名单——显式透传也不能把密钥带出去
        if (DENY_EXACT.includes(k) || DENY_NAME_RE.test(k)) {
            removed.push(k);
            continue;
        }
        if (passthrough.has(k)) forwarded.push(k);
        env[k] = v;
    }

    for (const [k, v] of Object.entries(opts.extra ?? {})) {
        if (DENY_EXACT.includes(k) || DENY_NAME_RE.test(k)) {
            if (!removed.includes(k)) removed.push(k);
            continue;
        }
        if (!(k in env)) forwarded.push(k);
        env[k] = v;
    }

    // 避免子进程被父进程的调试/交互变量带偏
    delete env["NODE_OPTIONS"];
    return { env, removed, forwarded };
}

// ============================================================
// 文件快照（用于"执行前后对比 + 执行期间轮询"）
// ============================================================

export interface FsSnapshot {
    root: string;
    entries: Record<string, number>;
    count: number;
    truncated: boolean;
    takenAt: number;
}

const SNAPSHOT_SKIP = new Set(["node_modules", ".git", "dist", "target", "build", ".venv", "__pycache__"]);

export interface SnapshotOptions {
    maxEntries?: number;
    /** 目录递归深度（深度 0 = 只记录根本身） */
    depth?: number;
    /** 命中即跳过（接收绝对路径） */
    exclude?: (abs: string) => boolean;
}

/** 对一组根做浅快照：记录 路径 → mtimeMs，上限内截断 */
export function snapshotRoots(roots: readonly string[], opts: SnapshotOptions = {}): FsSnapshot {
    const entries: Record<string, number> = {};
    const maxEntries = opts.maxEntries ?? 4000;
    const maxDepth = opts.depth ?? 3;
    let count = 0;
    let truncated = false;
    const takenAt = Date.now();

    const visit = (p: string, depth: number): void => {
        if (count >= maxEntries) { truncated = true; return; }
        if (opts.exclude?.(p)) return;
        let st: fs.Stats;
        try { st = fs.statSync(p); } catch { return; }
        entries[p] = st.mtimeMs;
        count++;
        if (!st.isDirectory() || depth <= 0) return;
        let names: string[];
        try { names = fs.readdirSync(p); } catch { return; }
        for (const name of names) {
            if (SNAPSHOT_SKIP.has(name)) continue;
            visit(path.join(p, name), depth - 1);
            if (count >= maxEntries) { truncated = true; return; }
        }
    };

    for (const root of roots) visit(root, maxDepth);
    return { root: roots.join("|"), entries, count, truncated, takenAt };
}

export interface SnapshotSummary {
    count: number;
    truncated: boolean;
    hash: string;
    takenAt: number;
}

export function summarizeSnapshot(s: FsSnapshot): SnapshotSummary {
    const keys = Object.keys(s.entries).sort();
    const flat = keys.map((k) => `${k}:${s.entries[k]}`);
    return { count: s.count, truncated: s.truncated, hash: hashOf(flat), takenAt: s.takenAt };
}

/** 两次快照之间新增/被修改的路径（= 违规候选） */
export function diffSnapshots(before: FsSnapshot, after: FsSnapshot): string[] {
    const out: string[] = [];
    for (const [p, mtime] of Object.entries(after.entries)) {
        const prev = before.entries[p];
        if (prev === undefined || prev !== mtime) out.push(p);
    }
    return out;
}

/** 完整性计数下降的项（被删/被改的迹象） */
export function integrityDeltas(
    before: Record<string, number>, after: Record<string, number>,
): { key: string; before: number; after: number }[] {
    const out: { key: string; before: number; after: number }[] = [];
    for (const [k, v] of Object.entries(before)) {
        const now = after[k];
        if (now === undefined || now < v) out.push({ key: k, before: v, after: now ?? -1 });
    }
    return out;
}

// ============================================================
// 执行结果
// ============================================================

export interface SandboxViolation {
    code: "PATH_ESCAPE" | "OUT_OF_PROJECT_WRITE" | "DEPLOYMENT_COMMAND_DENIED" | "PROCESS_LIMIT";
    target: string;
    message: string;
}

export interface SandboxRunResult {
    command: string;
    args: string[];
    cwd: string;
    cwdAbs: string;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    truncated: boolean;
    rawOutputPath: string | null;
    durationMs: number;
    timedOut: boolean;
    /** 截断时原始输出落盘位置（stdout/stderr 各一份） */
    processId: string;
    pid: number | null;
    killedBy: KillReason;
    killMethod: string;
    snapshotBefore: SnapshotSummary;
    snapshotAfter: SnapshotSummary;
    violations: SandboxViolation[];
    envRemoved: string[];
    // ---- 每一条执行结果都必须自报隔离程度（规格一.7）----
    /** 是否真的隔离。本机 soft 模式永远是 false。 */
    realIsolation: boolean;
    /** 是否只是"受约束的本机执行" */
    softIsolation: boolean;
    sandboxMode: SandboxMode;
    sandboxBackend: SandboxBackend;
}

export interface SandboxRunSpec {
    taskId: string;
    command: string;
    args: string[];
    /** 相对 projectDir 的 cwd（空 = 项目根） */
    cwdRel?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
    label?: string;
}

/**
 * 沙箱宿主：由 Workspace 实现（它才有路径规则），沙箱只负责执行与边界。
 * 让 Workspace 反向注入，避免 workspace ↔ sandbox 循环依赖。
 */
export interface SandboxHost {
    readonly projectDir: string;
    /** 生成项目源码快照的根（allowedRoots 的绝对路径） */
    readonly sourceRoots: readonly string[];
    /** 是否存在需要持续监视的写保护路径（决定要不要开轮询） */
    hasProtectedPaths(): boolean;
    /** 取一次保护路径快照（深度与排除策略由宿主决定） */
    protectedSnapshot(): FsSnapshot;
    /**
     * 完整性探针（可选）。用于那些**宿主自己也在写**、没法用 mtime 判断的东西——
     * 最典型的就是 Ledger：它每写一条事件 mtime 就变，用快照监视必然误报。
     * 所以改成"命令前后各取一次计数，只降不升就判违规"。
     */
    integrityProbe?(): Record<string, number>;
    /** 路径守卫：返回违规码，或 null 表示合法 */
    guard(absPath: string): string | null;
    /** 绝对路径 → 展示用相对路径 */
    display(absPath: string): string;
}

const DEFAULT_SANDBOX: SandboxConfig = {
    mode: "strict",
    backend: "none",
    timeouts: DEFAULT_TIMEOUTS,
    maxOutputBytes: 256 * 1024,
    maxProcessCount: 8,
    networkPolicy: DEFAULT_NETWORK_POLICY,
    passthroughEnv: [],
    protectedPaths: [],
    watchProtectedPaths: true,
    watchIntervalMs: 1000,
    logDir: path.join(os.tmpdir(), "crewforge-developer-logs"),
    deploymentCommandAllow: [],
};

export function normalizeSandboxConfig(cfg: Partial<SandboxConfig> = {}): SandboxConfig {
    return {
        ...DEFAULT_SANDBOX,
        ...cfg,
        timeouts: { ...DEFAULT_TIMEOUTS, ...(cfg.timeouts ?? {}) },
        networkPolicy: { ...DEFAULT_NETWORK_POLICY, ...(cfg.networkPolicy ?? {}) },
        passthroughEnv: cfg.passthroughEnv ?? [],
        protectedPaths: cfg.protectedPaths ?? [],
    };
}

/** 命令首词（去掉路径与扩展名）——部署策略比对用 */
export function commandKeyOf(command: string): string {
    const base = command.replace(/\\/g, "/").split("/").pop() ?? command;
    return base.replace(/\.(cmd|bat|exe|sh|ps1)$/i, "").toLowerCase();
}

export interface ProcessSandboxOptions {
    config?: Partial<SandboxConfig>;
    host: SandboxHost;
    /** 进程生命周期事件 → Ledger */
    onProcessEvent?: (ev: { kind: string; payload: Record<string, unknown> }) => void;
    /** 触发违规时的回调（Ledger 留痕） */
    onViolation?: (v: SandboxViolation) => void;
    /** 进程树终止执行器（测试注入） */
    killExecutor?: (pid: number) => Promise<"taskkill" | "pid" | "process-group" | "none">;
}

export class ProcessSandbox {
    readonly config: SandboxConfig;
    readonly capabilities: SandboxCapabilities;
    private readonly host: SandboxHost;
    private readonly manager: ProcessManager;
    private readonly onViolation: ((v: SandboxViolation) => void) | undefined;
    private readonly onProcessEvent: ((ev: { kind: string; payload: Record<string, unknown> }) => void) | undefined;

    constructor(o: ProcessSandboxOptions) {
        this.config = normalizeSandboxConfig(o.config);
        this.capabilities = resolveSandboxCapabilities(this.config);
        this.host = o.host;
        this.onViolation = o.onViolation;
        this.onProcessEvent = o.onProcessEvent;
        this.manager = new ProcessManager({
            maxProcessCount: this.config.maxProcessCount,
            logDir: this.config.logDir,
            ...(o.killExecutor ? { killExecutor: o.killExecutor } : {}),
            onEvent: (ev) => this.onProcessEvent?.({
                kind: `process_${ev.kind}`,
                payload: {
                    processId: ev.processId, taskId: ev.taskId, command: ev.command,
                    args: ev.args, pid: ev.pid, ...(ev.detail ?? {}),
                },
            }),
        });
    }

    /** 沙箱不可用时的结构化结果（不抛异常，工具层统一转 ToolResult） */
    unavailableResult(): SandboxUnavailableResult {
        return {
            code: SANDBOX_UNAVAILABLE,
            mode: this.capabilities.mode,
            backend: this.capabilities.backend,
            reasons: this.capabilities.reasons,
            hint: "配置 sandbox.backend=docker 并提供可用镜像，或在**仅测试**场景显式开启 sandbox.mode=soft；严禁在真实模式下静默降级为宿主裸跑。",
        };
    }

    /** 未隔离就不执行——所有执行入口第一道闸 */
    assertAvailable(): void {
        if (this.capabilities.realIsolation || this.capabilities.softIsolation) return;
        throw new SandboxUnavailableError(this.unavailableResult());
    }

    /** 生成项目源码快照（命令指纹用；跳过热目录） */
    sourceSnapshot(): SnapshotSummary {
        return summarizeSnapshot(snapshotRoots(this.host.sourceRoots));
    }

    protectedSnapshot(): FsSnapshot {
        return this.host.protectedSnapshot();
    }

    private probeIntegrity(): Record<string, number> {
        try { return this.host.integrityProbe?.() ?? {}; } catch { return {}; }
    }

    /**
     * 隔离程度自述（规格一.7）。**每条执行结果都带上它**，
     * 免得下游（报告 / 模型 / 人）把 soft 读成"已经隔离好了"。
     */
    private flags(): { realIsolation: boolean; softIsolation: boolean; sandboxMode: SandboxMode; sandboxBackend: SandboxBackend } {
        return {
            realIsolation: this.capabilities.realIsolation,
            softIsolation: this.capabilities.softIsolation,
            sandboxMode: this.capabilities.mode,
            sandboxBackend: this.capabilities.backend,
        };
    }

    /** 一次性的命令执行（runCommand / runBuild / shell 都走这里） */
    async run(spec: SandboxRunSpec): Promise<SandboxRunResult> {
        this.assertAvailable();

        const violations: SandboxViolation[] = [];
        const timeoutMs = spec.timeoutMs ?? this.config.timeouts.commandMs;

        // ① 部署级命令策略（显式配置才生效；不是 Developer 的默认限制）
        const allow = this.config.deploymentCommandAllow;
        if (allow.length > 0) {
            const key = commandKeyOf(spec.command);
            const ok = allow.some((a) => commandKeyOf(a) === key || a === spec.command);
            if (!ok) {
                const v: SandboxViolation = {
                    code: "DEPLOYMENT_COMMAND_DENIED",
                    target: spec.command,
                    message: `部署级命令策略未放行「${spec.command}」（允许：${allow.join(", ")}）`,
                };
                violations.push(v);
                this.onViolation?.(v);
                const empty = { count: 0, truncated: false, hash: hashOf([]), takenAt: Date.now() };
                return {
                    command: spec.command, args: spec.args, cwd: spec.cwdRel ?? ".",
                    cwdAbs: this.host.projectDir, exitCode: null, stdout: "", stderr: v.message,
                    truncated: false, rawOutputPath: null, durationMs: 0, timedOut: false,
                    processId: "-", pid: null, killedBy: "none", killMethod: "none",
                    snapshotBefore: empty, snapshotAfter: empty, violations, envRemoved: [],
                    ...this.flags(),
                };
            }
        }

        // ② cwd 必须落在生成项目内——先过宿主守卫，再做物理路径解析（防符号链接逃逸）
        const cwdAbs = this.resolveCwd(spec.cwdRel);

        // ③ 环境清洗
        const sanitized = sanitizeEnv(process.env, {
            passthrough: this.config.passthroughEnv,
            ...(spec.env ? { extra: spec.env } : {}),
        });

        const snapshotBefore = this.protectedSnapshot();
        const integrityBefore = this.probeIntegrity();
        const started = Date.now();
        let timedOut = false;
        // 用 string 而不是 KillReason：这个变量在定时器回调里被赋值，
        // 声明成字面量联合会被 TS 控制流收窄成 "none"，导致后面的比较被判成"永不成立"。
        let killedByReason = "none";

        let proc: ManagedProcess;
        try {
            proc = this.manager.spawn({
                taskId: spec.taskId,
                command: this.resolveCommand(spec.command, cwdAbs),
                args: spec.args,
                cwdAbs,
                cwd: this.host.display(cwdAbs),
                env: sanitized.env,
                maxOutputBytes: this.config.maxOutputBytes,
                logDir: this.config.logDir,
                ...(spec.label ? { label: spec.label } : {}),
            });
        } catch (e) {
            // 起不来也要给**原文证据**，不能只扔一句"工具执行失败"
            const message = (e as Error).message ?? String(e);
            if (e instanceof ProcessLimitError) {
                const v: SandboxViolation = {
                    code: "PROCESS_LIMIT", target: spec.command, message: e.message,
                };
                violations.push(v);
                this.onViolation?.(v);
            }
            return {
                command: spec.command, args: spec.args, cwd: this.host.display(cwdAbs), cwdAbs,
                exitCode: null, stdout: "",
                stderr: `启动失败（${spec.command} ${spec.args.join(" ")} @ ${this.host.display(cwdAbs)}）：${message}`,
                truncated: false, rawOutputPath: null, durationMs: Date.now() - started,
                timedOut: false, processId: "-", pid: null, killedBy: "none", killMethod: "none",
                snapshotBefore: summarizeSnapshot(snapshotBefore),
                snapshotAfter: summarizeSnapshot(snapshotBefore),
                violations, envRemoved: sanitized.removed,
                ...this.flags(),
            };
        }

        const processId = proc.processId;
        const watchEnabled = this.config.watchProtectedPaths && this.host.hasProtectedPaths();

        // ④ 执行期间轮询保护路径：发现项目外写入立即终止整棵进程树
        let watchTimer: ReturnType<typeof setInterval> | null = null;
        if (watchEnabled) {
            watchTimer = setInterval(() => {
                const changed = diffSnapshots(snapshotBefore, this.protectedSnapshot());
                if (changed.length === 0) return;
                for (const p of changed.slice(0, 20)) {
                    const v: SandboxViolation = {
                        code: "OUT_OF_PROJECT_WRITE", target: this.host.display(p),
                        message: `执行期间检测到保护路径被写入：${this.host.display(p)}`,
                    };
                    violations.push(v);
                    this.onViolation?.(v);
                }
                if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
                killedByReason = "violation";
                void this.manager.stop(processId, "violation");
            }, this.config.watchIntervalMs);
        }

        const timer = setTimeout(() => {
            timedOut = true;
            killedByReason = "timeout";
            void this.manager.stop(processId, "timeout");
        }, timeoutMs);

        let final: ManagedProcess;
        try {
            final = await this.manager.awaitExit(processId);
        } finally {
            clearTimeout(timer);
            if (watchTimer) clearInterval(watchTimer);
        }

        // ⑤ 命令结束后再比一次快照：轮询没抓到的也要留证
        const snapshotAfter = this.protectedSnapshot();
        const changedAfter = diffSnapshots(snapshotBefore, snapshotAfter);
        const already = new Set(violations.map((v) => v.target));
        for (const p of changedAfter.slice(0, 50)) {
            const target = this.host.display(p);
            if (already.has(target)) continue;
            const v: SandboxViolation = {
                code: "OUT_OF_PROJECT_WRITE", target,
                message: `命令结束后发现保护路径被写入：${target}`,
            };
            violations.push(v);
            this.onViolation?.(v);
        }

        // ⑤b 完整性探针：Ledger 之类的"宿主也在写"的对象，只降不升就判违规
        for (const d of integrityDeltas(integrityBefore, this.probeIntegrity())) {
            const v: SandboxViolation = {
                code: "OUT_OF_PROJECT_WRITE", target: d.key,
                message: `命令执行后 ${d.key} 的计数从 ${d.before} 降到 ${d.after}（疑似被删改）`,
            };
            violations.push(v);
            this.onViolation?.(v);
        }

        // ⑥ 杀不掉就如实说：不能假装"已经终止"
        const stillAlive = final.status === "running";
        const killCause = killedByReason as KillReason;
        return {
            command: spec.command,
            args: spec.args,
            cwd: this.host.display(cwdAbs),
            cwdAbs,
            exitCode: timedOut || killCause === "violation" ? null : final.exitCode,
            stdout: final.stdout,
            stderr: final.stderr,
            truncated: final.truncated,
            rawOutputPath: final.rawLogPath,
            durationMs: Date.now() - started,
            timedOut,
            processId,
            pid: final.pid,
            killedBy: killCause,
            killMethod: stillAlive ? "none" : final.killMethod,
            snapshotBefore: summarizeSnapshot(snapshotBefore),
            snapshotAfter: summarizeSnapshot(snapshotAfter),
            violations,
            envRemoved: sanitized.removed,
            ...this.flags(),
        };
    }

    // ---------- 长驻进程 ----------

    start(spec: SandboxRunSpec): ManagedProcess {
        this.assertAvailable();
        const cwdAbs = this.resolveCwd(spec.cwdRel);
        const sanitized = sanitizeEnv(process.env, {
            passthrough: this.config.passthroughEnv,
            ...(spec.env ? { extra: spec.env } : {}),
        });
        return this.manager.spawn({
            taskId: spec.taskId,
            command: this.resolveCommand(spec.command, cwdAbs),
            args: spec.args,
            cwdAbs,
            cwd: this.host.display(cwdAbs),
            env: sanitized.env,
            maxOutputBytes: this.config.maxOutputBytes,
            logDir: this.config.logDir,
            ...(spec.label ? { label: spec.label } : {}),
        });
    }

    read(processId: string, since?: { stdout?: number; stderr?: number }) {
        return this.manager.read(processId, since);
    }

    async stop(processId: string, reason: KillReason = "stop"): Promise<ManagedProcess> {
        return this.manager.stop(processId, reason);
    }

    activeCount(taskId?: string): number {
        return this.manager.activeCount(taskId);
    }

    listProcesses(taskId?: string): ManagedProcess[] {
        return this.manager.list(taskId);
    }

    /** 任务完成 / 取消 / 崩溃恢复：清掉遗留进程 */
    async cleanupTaskProcesses(taskId: string, reason: KillReason = "cleanup"): Promise<number> {
        const killed = await this.manager.cleanupTaskProcesses(taskId, reason);
        return killed.length;
    }

    async cleanupAll(reason: KillReason = "cleanup"): Promise<number> {
        return this.manager.cleanupAll(reason);
    }

    // ---------- 网络策略（httpRequest 用） ----------

    checkNetwork(host: string): { ok: boolean; reason?: string } {
        const policy = this.config.networkPolicy;
        if (policy.allowExternal) return { ok: true };
        const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
        if (policy.allowHosts.includes(normalized)) return { ok: true };
        return {
            ok: false,
            reason: `网络策略只放行本机回环（${policy.allowHosts.join(", ")}），拒绝访问 ${host}`,
        };
    }

    // ---------- 内部 ----------

    /** 命令解析（Windows 上补 ".\" 前缀，见 resolveCommand 注释） */
    private resolveCommand(command: string, cwdAbs: string): string {
        return resolveCommand(command, cwdAbs);
    }

    /** cwd 解析：先过宿主守卫，再用 realpath 复核（防 symlink 逃逸） */
    private resolveCwd(cwdRel?: string): string {
        const abs = path.resolve(this.host.projectDir, cwdRel ?? ".");
        const guarded = this.host.guard(abs);
        if (guarded) {
            const v: SandboxViolation = {
                code: "PATH_ESCAPE", target: this.host.display(abs),
                message: `[${guarded}] cwd 不在生成项目边界内：${this.host.display(abs)}`,
            };
            this.onViolation?.(v);
            throw new Error(v.message);
        }
        const real = realpathOrNull(abs);
        if (real) {
            const escaped = this.host.guard(real);
            if (escaped) {
                const v: SandboxViolation = {
                    code: "PATH_ESCAPE", target: this.host.display(real),
                    message: `[${escaped}] cwd 经符号链接解析后越界：${this.host.display(real)}`,
                };
                this.onViolation?.(v);
                throw new Error(v.message);
            }
            return real;
        }
        return abs;
    }
}

function realpathOrNull(p: string): string | null {
    try { return fs.realpathSync.native(p); } catch { return null; }
}

/**
 * Windows 下命令解析。
 * 9/12 mysite T1 实弹坑：本环境 cmd 不搜当前目录（裸 mvnw.cmd → "不是内部或外部命令"），
 * runBuild 因此永远假失败。修法：命令本身没带路径分隔符、且 cwd 下确有同名文件时，
 * 自动补 ".\\" 前缀（npm.cmd 等走 PATH 的不受影响）。
 */
export function resolveCommand(command: string, cwdAbs: string): string {
    if (process.platform !== "win32") return command;
    if (!/\.(cmd|bat|exe)$/i.test(command)) return command;
    if (command.includes("\\") || command.includes("/")) return command;
    try {
        if (fs.existsSync(path.join(cwdAbs, command))) return `.\\${command}`;
    } catch {
        // cwd 不存在 → 原样返回，让 spawn 报出真实的启动错误
    }
    return command;
}

export { ProcessLimitError };
