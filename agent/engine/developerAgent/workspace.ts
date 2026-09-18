// ============================================================
// workspace.ts —— 生成项目的**读 / 写 / 执行**唯一闸门
//
//   developerAgent 里**唯一**允许触碰生成项目的入口。所有 tool 的读、写、
//   建目录、执行命令都必须先过这里。
//
//   权限由代码强制，不依赖 prompt 自觉（规格见 2026-09-12 记录第四节）。
//
//   拦截项（写盘）：路径逃逸 / 不在 allowedRoots / .git / CrewForge 控制平面 /
//                  _engine2 / _verify / Contract / acceptance / 测试脚本。
//   写入：临时文件 + 原子 rename；每次写入落审计（path/owner/time/taskId/bytes）。
//
//   —— 关于"执行"这一块，本文件改变了口径（规格二 / 三）——
//   · 不再有"命令白名单 = Developer 的默认拒绝条件"。Developer 可以跑任意
//     编译器 / 包管理器 / 脚本 / HTTP / 本地服务。
//   · 边界从"命令种类"移到"环境"：执行全部交给 tools/processSandbox.ts，
//     由它做环境清洗、cwd 限定、进程树超时终止、输出上限、保护路径监视。
//   · commandAllowlist 降级为**部署级安全策略**（显式配置才生效），
//     不再是 Prompt 规则，也不再是默认行为。
//   · 隔离能力不足时**不降级执行**：直接返回 SANDBOX_UNAVAILABLE。
// ============================================================

import fs from "node:fs";
import path from "node:path";
import {
    ProcessSandbox, snapshotRoots, summarizeSnapshot,
} from "./tools/processSandbox";
import type {
    FsSnapshot, SandboxCapabilities, SandboxConfig, SandboxRunResult, SnapshotSummary,
} from "./tools/processSandbox";

/** 违规类型（机器可读，直接进 Ledger） */
export type ViolationCode =
    | "ESCAPE"                  // 路径逃逸（越出 projectDir）
    | "NOT_IN_ALLOWED_ROOTS"    // 落在 allowedRoots 之外
    | "GIT"                     // .git
    | "CONTROL_PLANE"           // CrewForge 控制平面
    | "ENGINE_OWNED"            // _engine2 / _verify
    | "CONTRACT"                // CONTRACTS.md 等契约文件
    | "ACCEPTANCE"              // acceptance-*.json
    | "TEST_SCRIPT"             // *.test.* / *.spec.*
    | "COMMAND_NOT_ALLOWED"     // 部署级命令策略未放行（兼容旧码）
    | "DEPLOYMENT_COMMAND_DENIED" // 同上，新码
    | "COMMAND_TIMEOUT"         // 超时
    | "SANDBOX_UNAVAILABLE"     // 没有可用的隔离后端 → 不执行
    | "OUT_OF_PROJECT_WRITE"    // 子进程写了生成项目之外的位置
    | "PATH_ESCAPE"             // 子进程 cwd 试图逃出生成项目
    | "NETWORK_DENIED"          // 网络策略拒绝
    | "PROCESS_LIMIT";          // 进程数超限

export class WorkspaceViolation extends Error {
    readonly code: ViolationCode;
    readonly target: string;

    constructor(code: ViolationCode, target: string, detail?: string) {
        super(`[${code}] ${target}${detail ? ` —— ${detail}` : ""}`);
        this.name = "WorkspaceViolation";
        this.code = code;
        this.target = target;
    }
}

/** 写入/建目录/执行审计记录 */
export interface AuditRecord {
    path: string;        // 相对 projectDir，正斜杠
    owner: string;       // 发起方（developer / subagent:xxx）
    at: number;          // epoch ms
    taskId: string;
    bytes: number;
    action: "write" | "mkdir" | "exec";
}

export interface WorkspacePolicyConfig {
    /** 生成项目根（绝对路径） */
    projectDir: string;
    /** 允许写的根；相对 projectDir 或绝对路径 */
    allowedRoots: string[];
    /** 额外禁止的路径（相对 projectDir），叠加在内置禁止项之上 */
    forbiddenPaths?: string[];
    /**
     * 命令白名单 —— **部署环境安全策略**，不是 Developer 的默认限制。
     * 留空（默认）= 不限命令种类；只有部署方显式配置时才生效，
     * 命中时返回 DEPLOYMENT_COMMAND_DENIED。
     */
    commandAllowlist?: string[];
    defaultCommandTimeoutMs?: number;
    /** 单条输出（stdout/stderr 各自）保留上限 */
    maxOutputBytes?: number;
    /** 沙箱配置（mode / backend / 网络策略 / 进程上限 …） */
    sandbox?: Partial<SandboxConfig>;
    /** Ledger 落盘路径：记录用（不进文件快照——宿主自己也在写它，见 protectedSnapshotRoots 注释） */
    ledgerPath?: string;
    /** Ledger 完整性探针：命令前后各取一次计数，只降不升即判"被删改" */
    ledgerIntegrity?: () => Record<string, number>;
    /** 额外写保护路径（绝对路径） */
    protectedPaths?: string[];
}

export interface ExecOptions {
    cwd?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
    label?: string;
}

/** 执行结果：**原始证据**——stdout/stderr 全留，截断时给出原始输出位置 */
export interface ExecResult {
    command: string;
    args: string[];
    cwd: string;
    cwdAbs?: string;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    durationMs: number;
    timedOut: boolean;
    truncated?: boolean;
    rawOutputPath?: string | null;
    processId?: string;
    pid?: number | null;
    killedBy?: string;
    killMethod?: string;
    snapshotBefore?: SnapshotSummary;
    snapshotAfter?: SnapshotSummary;
    violations?: SandboxRunResult["violations"];
    envRemoved?: string[];
    // —— 隔离程度自述：每条执行结果都要能回答"这是不是真的隔离了" ——
    realIsolation?: boolean;
    softIsolation?: boolean;
    sandboxMode?: string;
    sandboxBackend?: string;
}

export interface WriteMeta {
    owner: string;
    taskId: string;
}

// —— 内置禁止项（相对 projectDir 的路径片段）——

/** 目录名命中即拒 */
const FORBIDDEN_SEGMENTS: ReadonlyArray<{ segment: string; code: ViolationCode }> = [
    { segment: ".git", code: "GIT" },
    { segment: "_engine2", code: "ENGINE_OWNED" },
    { segment: "_verify", code: "ENGINE_OWNED" },
];

/** 文件名命中即拒 */
const FORBIDDEN_FILES: ReadonlyArray<{ file: string; code: ViolationCode }> = [
    { file: "CONTRACTS.md", code: "CONTRACT" },
];

/** 路径模式命中即拒 */
const FORBIDDEN_PATTERNS: ReadonlyArray<{ re: RegExp; code: ViolationCode }> = [
    { re: /^acceptance-.*\.json$/i, code: "ACCEPTANCE" },
    { re: /\.(test|spec)\.[cm]?[jt]sx?$/i, code: "TEST_SCRIPT" },
];

/**
 * **写路径**专属的整目录禁区（相对 projectDir）。
 *
 *   项目根 `scripts/` 是 TestAgent 验收脚本的落地位置（live 里每一份任务包都
 *   在 `forbiddenPaths` 里声明它，说明它就是"不该被写的那块"）。
 *   把它做成内置禁区而不是只靠任务包声明，是因为**任务包是模型生成的**——
 *   恰恰是最可能漏写或写错的一环。内置 = 授权再宽也写不进去。
 *
 *   只拦写、不拦读：Developer 需要 readFile 验收脚本以了解判据（任务包明确要求）。
 *   生成项目自己的 `backend/scripts/` 不受影响——匹配只认项目根那一段。
 */
export const FORBIDDEN_REL_PATHS: ReadonlyArray<{ path: string; code: ViolationCode }> = [
    { path: "scripts", code: "TEST_SCRIPT" },
];

/** CrewForge 控制平面根（= agents-CrewForge/）。
 *  ⚠️ 9/16 p20 实测推翻旧注释「生成项目永远不在其中」：团队线产物树就住在
 *  runs/pXX/——**在**控制平面里。所以 checkPath 必须先用项目根圈定，
 *  再对圈外路径谈控制平面；反过来会把整个生成项目误判成引擎地盘（首跑 0 改盘的母病）。 */
const CONTROL_PLANE_ROOT = path.resolve(import.meta.dir, "..");

/** 快照时跳过的大目录（生成项目里这些目录由工具链自己管，不属于"源码快照"） */
const SNAPSHOT_SKIP_DIRS = new Set(["node_modules", "dist", "target", "build", ".git", "_engine2", "_verify"]);

function toPosix(p: string): string {
    return p.replace(/\\/g, "/");
}

/** child 是否等于 parent 或位于其下 */
function within(parent: string, child: string): boolean {
    const rel = path.relative(parent, child);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export class Workspace {
    readonly config: WorkspacePolicyConfig;
    readonly records: AuditRecord[] = [];
    /** 命令执行的唯一出口（隔离边界在这里，不在工具里） */
    readonly sandbox: ProcessSandbox;
    private readonly auditSink?: (record: AuditRecord) => void;
    private readonly allowedRootsAbs: string[];
    /** 允许**读**但不属于项目的外部根（截断后的原始日志） */
    private readonly readableExternalRoots: string[];

    constructor(
        config: WorkspacePolicyConfig,
        auditSink?: (record: AuditRecord) => void,
        sandboxHooks?: {
            onProcessEvent?: (ev: { kind: string; payload: Record<string, unknown> }) => void;
            onViolation?: (v: { code: string; target: string; message: string }) => void;
        },
    ) {
        this.config = {
            ...config,
            projectDir: path.resolve(config.projectDir),
            allowedRoots: config.allowedRoots.map((r) => toPosix(r)),
        };
        if (auditSink) this.auditSink = auditSink;
        this.allowedRootsAbs = this.config.allowedRoots.map((r) => path.resolve(this.config.projectDir, r));
        this.readableExternalRoots = [path.resolve(this.sandboxLogDir())];

        this.sandbox = new ProcessSandbox({
            config: {
                ...(config.sandbox ?? {}),
                // 白名单降级为部署策略：显式配置才生效
                deploymentCommandAllow: config.sandbox?.deploymentCommandAllow
                    ?? config.commandAllowlist ?? [],
                ...(config.maxOutputBytes !== undefined
                    ? { maxOutputBytes: config.maxOutputBytes }
                    : {}),
                ...(config.protectedPaths ? { protectedPaths: config.protectedPaths } : {}),
            },
            host: {
                projectDir: this.config.projectDir,
                sourceRoots: this.allowedRootsAbs,
                hasProtectedPaths: () => this.protectedSnapshotRoots().length > 0,
                protectedSnapshot: () => this.protectedSnapshot(),
                ...(config.ledgerIntegrity ? { integrityProbe: config.ledgerIntegrity } : {}),
                guard: (abs) => this.checkPath(abs),
                display: (abs) => this.displayPath(abs),
            },
            ...(sandboxHooks?.onProcessEvent ? { onProcessEvent: sandboxHooks.onProcessEvent } : {}),
            ...(sandboxHooks?.onViolation ? { onViolation: sandboxHooks.onViolation } : {}),
        });
    }

    /** 当前沙箱能力（真实模式据此判断是否直接 blocked） */
    get sandboxCapabilities(): SandboxCapabilities {
        return this.sandbox.capabilities;
    }

    /** 生成项目的绝对根目录（只读）。构建入口识别等按目录探测要用它。 */
    get projectDir(): string {
        return this.config.projectDir;
    }

    /** 内置禁止清单（供 policies/workspace-policy.json 生成与文档对照） */
    static builtinForbidden(): { segments: string[]; files: string[]; patterns: string[]; relPaths: string[] } {
        return {
            segments: FORBIDDEN_SEGMENTS.map((x) => x.segment),
            files: FORBIDDEN_FILES.map((x) => x.file),
            patterns: FORBIDDEN_PATTERNS.map((x) => String(x.re)),
            relPaths: FORBIDDEN_REL_PATHS.map((x) => x.path),
        };
    }

    // ---------------- 路径解析与校验 ----------------

    /** 读路径解析：只允许 projectDir 内（不给控制平面留读口） */
    resolveRead(target: string): string {
        const abs = path.resolve(this.config.projectDir, target);
        // 例外：截断日志（我们自己写的外部目录）允许读取——只读，且仅此一处
        if (this.readableExternalRoots.some((root) => within(root, abs))) return abs;
        if (!within(this.config.projectDir, abs)) {
            throw new WorkspaceViolation("ESCAPE", target, "读路径越出项目根");
        }
        this.assertNotForbidden(abs, target);
        return abs;
    }

    /** 写路径解析：projectDir 内 + 非禁止项 + allowedRoots 内
     *
     *  判定顺序是**语义**，不是风格：硬禁区（契约 / 验收 / 引擎目录 / 项目根 scripts）
     *  必须排在授权检查之前。否则越权路径只会拿到 NOT_IN_ALLOWED_ROOTS——那个错误
     *  读起来像"授权配错了"，反倒暗示"把路径加进 allowedRoots 就能写"。
     *  硬禁区的含义是：授权再宽也写不进去。
     */
    resolveWrite(target: string): string {
        const abs = path.resolve(this.config.projectDir, target);
        if (!within(this.config.projectDir, abs)) {
            throw new WorkspaceViolation("ESCAPE", target, "写路径越出项目根");
        }
        this.assertNotForbidden(abs, target);
        this.assertNotForbiddenWrite(abs, target);
        const inAllowed = this.allowedRootsAbs.some((root) => within(root, abs));
        if (!inAllowed) {
            throw new WorkspaceViolation("NOT_IN_ALLOWED_ROOTS", target,
                `allowedRoots=[${this.config.allowedRoots.join(", ")}]`);
        }
        return abs;
    }

    /** 路径裁决（不抛异常）：返回违规码或 null。沙箱 guard 也用它 */
    checkPath(abs: string): string | null {
        // 判定顺序是语义：先问「在项目内吗」——团队线 projectDir 落在控制平面里
        // （runs/pXX），圈外才谈 CONTROL_PLANE / ESCAPE。旧顺序先扣 CONTROL_PLANE 帽，
        // 会把圈住的项目整体误判成引擎地盘（9/16 p20 首跑 0 改盘母病）。
        if (!within(this.config.projectDir, abs)) {
            if (within(CONTROL_PLANE_ROOT, abs)) return "CONTROL_PLANE";
            return "ESCAPE";
        }
        const rel = toPosix(path.relative(this.config.projectDir, abs));
        const segments = rel.split("/").filter(Boolean);
        for (const { segment, code } of FORBIDDEN_SEGMENTS) {
            if (segments.includes(segment)) return code;
        }
        const base = segments.at(-1) ?? "";
        for (const { file, code } of FORBIDDEN_FILES) {
            if (base === file) return code;
        }
        for (const { re, code } of FORBIDDEN_PATTERNS) {
            if (re.test(base)) return code;
        }
        for (const extra of this.config.forbiddenPaths ?? []) {
            const ex = toPosix(extra).replace(/^\.\//, "").replace(/\/+$/, "");
            if (!ex) continue;
            if (rel === ex || rel.startsWith(ex + "/")) return "CONTROL_PLANE";
        }
        return null;
    }

    private assertNotForbidden(abs: string, display: string): void {
        const code = this.checkPath(abs);
        if (code) throw new WorkspaceViolation(code as ViolationCode, display);
    }

    /** 写路径的额外禁区：项目根 scripts/（TestAgent 验收脚本）。只拦写，不拦读。 */
    private assertNotForbiddenWrite(abs: string, display: string): void {
        if (!within(this.config.projectDir, abs)) return;
        const rel = toPosix(path.relative(this.config.projectDir, abs));
        for (const { path: p, code } of FORBIDDEN_REL_PATHS) {
            if (rel === p || rel.startsWith(`${p}/`)) {
                throw new WorkspaceViolation(code as ViolationCode, display,
                    `项目根 ${p}/ 属 TestAgent 验收面，Developer 只读不写`);
            }
        }
    }

    /** 相对 projectDir 的正斜杠路径（用于汇报与审计） */
    rel(abs: string): string {
        return toPosix(path.relative(this.config.projectDir, abs));
    }

    /** 展示用路径：项目内给相对路径，项目外给绝对路径（不撒谎说它在项目里） */
    displayPath(abs: string): string {
        return within(this.config.projectDir, abs) ? this.rel(abs) : toPosix(abs);
    }

    // ---------------- 读 ----------------

    exists(target: string): boolean {
        return fs.existsSync(this.resolveRead(target));
    }

    stat(target: string): fs.Stats {
        return fs.statSync(this.resolveRead(target));
    }

    readText(target: string, maxBytes?: number): { path: string; content: string; truncated: boolean; bytes: number } {
        const abs = this.resolveRead(target);
        const buf = fs.readFileSync(abs);
        const limit = maxBytes ?? 256 * 1024;
        const truncated = buf.byteLength > limit;
        const slice = truncated ? buf.subarray(0, limit) : buf;
        return { path: this.displayPath(abs), content: slice.toString("utf-8"), truncated, bytes: buf.byteLength };
    }

    /**
     * 按行区间读取（9/15 截断改造配套）：模型被裁剪后要能"续读"，而不是整文件重读。
     * offset = 起始行号（1 起；<=0 或省略 = 从第 1 行），limit = 行数（省略 = 到文件末尾）。
     * 返回的 content 是**含行号**的文本（"  12| ..."），方便模型引用与再次定位；
     * startLine/endLine/totalLines 供工具层拼"续读指引"（endLine < totalLines 时给下一段 offset）。
     */
    readLines(target: string, offset?: number, limit?: number): {
        path: string; content: string; startLine: number; endLine: number; totalLines: number;
    } {
        const abs = this.resolveRead(target);
        const text = fs.readFileSync(abs, "utf-8");
        const lines = text.split(/\r?\n/);
        const total = lines.length;
        const start = Math.max(1, Math.floor(offset ?? 1) || 1);
        // limit 省略 / <=0 都按"读到末尾"处理（limit:0 不表达"读 0 行"这种无意义语义）
        const count = limit === undefined || limit <= 0 ? total : Math.floor(limit);
        const end = Math.min(total, start - 1 + count);
        const width = String(end).length;
        const body = lines
            .slice(start - 1, end)
            .map((l, i) => `${String(start + i).padStart(width, " ")}| ${l}`)
            .join("\n");
        return {
            path: this.displayPath(abs), content: body,
            startLine: start, endLine: end, totalLines: total,
        };
    }

    /** 递归遍历（只走 projectDir 内；跳过禁止段与常见重目录） */
    walk(start: string, opts?: { maxEntries?: number }): string[] {
        const root = this.resolveRead(start);
        const out: string[] = [];
        const skip = new Set(["node_modules", "dist", "target", "build", ".git", "_engine2", "_verify"]);
        const max = opts?.maxEntries ?? 4000;

        const visit = (dir: string): void => {
            if (out.length >= max) return;
            let entries: fs.Dirent[];
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
            for (const e of entries) {
                if (out.length >= max) return;
                if (e.isDirectory()) {
                    if (skip.has(e.name)) continue;
                    visit(path.join(dir, e.name));
                } else if (e.isFile()) {
                    out.push(this.rel(path.join(dir, e.name)));
                }
            }
        };
        visit(root);
        return out;
    }

    // ---------------- 写 ----------------

    ensureDir(target: string, meta: WriteMeta): string {
        const abs = this.resolveWrite(target);
        fs.mkdirSync(abs, { recursive: true });
        const record: AuditRecord = {
            path: this.rel(abs), owner: meta.owner, at: Date.now(), taskId: meta.taskId, bytes: 0, action: "mkdir",
        };
        this.records.push(record);
        this.auditSink?.(record);
        return record.path;
    }

    /** 临时文件 + 原子替换（写一半被杀不会留半截文件） */
    writeAtomic(target: string, content: string, meta: WriteMeta): { path: string; bytes: number } {
        const abs = this.resolveWrite(target);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const tmp = `${abs}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        fs.writeFileSync(tmp, content, "utf-8");
        try {
            fs.renameSync(tmp, abs);
        } catch (e) {
            try { fs.unlinkSync(tmp); } catch { /* 清理失败不掩盖原错 */ }
            throw e;
        }
        const bytes = Buffer.byteLength(content, "utf-8");
        const record: AuditRecord = {
            path: this.rel(abs), owner: meta.owner, at: Date.now(), taskId: meta.taskId, bytes, action: "write",
        };
        this.records.push(record);
        this.auditSink?.(record);
        return { path: record.path, bytes };
    }

    // ---------------- 快照 ----------------

    /**
     * 生成项目**源码**快照：只覆盖 allowedRoots，跳过 node_modules / dist / target 等。
     * 用途是命令指纹——"文件没变就别重复跑同一条构建"。
     */
    sourceSnapshot(): SnapshotSummary {
        return summarizeSnapshot(snapshotRoots(this.allowedRootsAbs, { depth: 6 }));
    }

    /**
     * 写保护路径快照（执行期间轮询 + 前后对比用）。
     * 只覆盖**不属于生成项目**的东西：控制平面源码、Ledger、契约/验收/测试脚本、.git。
     * 刻意**不**把项目根整个纳入——那会把 Developer 正常写 frontend/backend 误判成违规。
     */
    protectedSnapshot(): FsSnapshot {
        const roots = this.protectedSnapshotRoots().map((r) => r.path);
        // 授权根一律不纳入快照——除非它本身（或它的祖先）就是受保护根。
        // 否则架构师一旦把 scripts 写进 allowedRoots，验收脚本的命令层保护就会
        // 被这条排除规则静默关掉，只剩工具层的 writeAtomic 挡着。
        const guarded = roots.map((r) => path.resolve(r));
        const excluded = this.allowedRootsAbs.filter(
            (root) => !guarded.some((p) => within(p, root)),
        );
        return snapshotRoots(roots, {
            depth: 4,
            exclude: (abs) => allowedRootsExcluded(excluded, abs),
        });
    }

    private protectedSnapshotRoots(): { path: string; label: string }[] {
        const out: { path: string; label: string }[] = [
            // ① CrewForge 控制平面：我们自己的源码，生成项目永远不许碰
            { path: path.join(CONTROL_PLANE_ROOT, "developerAgent"), label: "control-plane:developerAgent" },
            // ② 生成项目里**不属于** allowedRoots 的契约/验收/git
            { path: path.join(this.config.projectDir, "CONTRACTS.md"), label: "contract" },
            { path: path.join(this.config.projectDir, ".git"), label: "git" },
            { path: path.join(this.config.projectDir, "_verify"), label: "engine-owned" },
            { path: path.join(this.config.projectDir, "_engine2"), label: "engine-owned" },
            // ③ TestAgent 验收脚本的落地目录（项目根 scripts/）：
            //    工具层已拒写，这里再钉住命令层——子进程用 fs 绕过去也一样被逮到
            { path: path.join(this.config.projectDir, "scripts"), label: "testagent-verify-scripts" },
            // ④ 验收文件：名字带时间戳/阶段号，只能扫出来，不能写死路径
            ...this.findAcceptanceFiles().map((p) => ({ path: p, label: "acceptance" })),
            // ⑤ 部署方显式追加
            ...(this.config.protectedPaths ?? []).map((p) => ({ path: path.resolve(p), label: "custom" })),
            // ⑥ 注意：**刻意不把 Ledger 放进来**。
            //    Ledger 由宿主进程自己持续写，mtime 每条事件都变——放进来会每条命令都误报。
            //    它的保护走 ledgerIntegrity 探针（命令前后计数只降不升即判违规）。
            // ⑦ 也刻意**不**把项目根整个纳入：Developer 用命令在项目根生成脚手架
            //    （package.json 之类）是正常工程行为，不该被算成"项目外写入"。
        ];
        // 只保留真实存在的（不存在的路径 statSync 会失败，提前剔掉省得白扫）
        return out.filter((r) => fs.existsSync(r.path));
    }

    /** 项目根下的 acceptance-*.json（引擎/验收方的机器可读验收文件） */
    private findAcceptanceFiles(): string[] {
        try {
            return fs.readdirSync(this.config.projectDir)
                .filter((n) => /^acceptance-.*\.json$/i.test(n))
                .map((n) => path.join(this.config.projectDir, n));
        } catch {
            return [];
        }
    }

    private sandboxLogDir(): string {
        return this.config.sandbox?.logDir
            ?? path.join(process.env["TEMP"] ?? process.env["TMPDIR"] ?? "/tmp", "crewforge-developer-logs");
    }

    // ---------------- 执行 ----------------

    /**
     * 执行命令。**没有命令白名单默认拦截**——边界是环境，不是命令种类。
     * 隔离后端不可用时抛 SandboxUnavailableError（不静默在宿主机裸跑）。
     */
    async exec(
        command: string, args: string[], opts?: ExecOptions, meta?: WriteMeta,
        extra?: { fingerprint?: string },
    ): Promise<ExecResult> {
        const r = await this.sandbox.run({
            taskId: meta?.taskId ?? "unknown",
            command,
            args,
            ...(opts?.cwd !== undefined ? { cwdRel: opts.cwd } : {}),
            ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
            ...(opts?.env ? { env: opts.env } : {}),
            ...(opts?.label ? { label: opts.label } : {}),
        });
        if (meta) {
            const record: AuditRecord = {
                path: this.displayPath(r.cwdAbs), owner: meta.owner, at: Date.now(),
                taskId: meta.taskId, bytes: 0, action: "exec",
            };
            this.records.push(record);
            this.auditSink?.(record);
        }
        void extra;
        return r;
    }

    /** 起一个长驻进程（本地服务），返回 processId 供 readProcess / stopProcess 用 */
    startProcess(
        command: string, args: string[], opts?: ExecOptions, meta?: WriteMeta,
    ) {
        void meta;
        return this.sandbox.start({
            taskId: meta?.taskId ?? "unknown",
            command,
            args,
            ...(opts?.cwd !== undefined ? { cwdRel: opts.cwd } : {}),
            ...(opts?.env ? { env: opts.env } : {}),
            ...(opts?.label ? { label: opts.label } : {}),
        });
    }

    readProcess(processId: string, since?: { stdout?: number; stderr?: number }) {
        return this.sandbox.read(processId, since);
    }

    async stopProcess(processId: string) {
        return this.sandbox.stop(processId, "stop");
    }

    /** 任务结束 / 取消 / 崩溃恢复：清掉该任务遗留的服务进程 */
    async cleanupTaskProcesses(taskId: string, reason: "cleanup" | "stop" | "violation" | "timeout" = "cleanup"): Promise<number> {
        return this.sandbox.cleanupTaskProcesses(taskId, reason);
    }

    /** 进程退出前的兜底：清掉本 Workspace 起过的所有进程 */
    async cleanupAllProcesses(): Promise<number> {
        return this.sandbox.cleanupAll();
    }
}

/** allowedRoots 内的路径不算"保护路径"，免得把正常写盘当违规 */
function allowedRootsExcluded(roots: readonly string[], abs: string): boolean {
    return roots.some((root) => within(root, abs));
}
