// ============================================================
// tools/registry.ts —— 工具注册表与统一调用入口
//
// 所有工具调用都要走 invoke()：参数校验 → 角色闸门 → 执行 → 权限拒绝转结构化结果。
// 权限本身在 workspace.ts / processSandbox.ts（工具内部调用），这里不重复实现，
// 只做统一收口与「渐进披露」（describe() 只吐名字/描述/参数）。
// ============================================================

import { WorkspaceViolation } from "../workspace";
import type { Workspace } from "../workspace";
import { SandboxUnavailableError } from "./processSandbox";
import type { ReadonlySubAgentCall } from "./readonlySubAgent";

export interface ToolContext {
    /** 唯一写盘/执行闸门 */
    workspace: Workspace;
    /** 发起方标识（进审计记录） */
    owner: string;
    taskId: string;
    /**
     * 调用者角色。代码层闸门（不看 prompt）：
     *   · 写盘工具只接受 developer；
     *   · 执行/进程工具只接受 developer —— PM / Architect / Test / Document 一律拒绝。
     */
    role?: string;
    /**
     * 生成项目的绝对路径（项目根）。runAcceptance 用它定位工程文件 / 起服务目录。
     * 由 graph.ts 的 ctxOf 从 state.projectDir 注入；子 Agent 的 ctx 里没有它。
     */
    projectDirAbs?: string;
    /**
     * 任务包的验收判据（原样，不翻译）。runAcceptance 用它做"验收预演"：
     * 只有**引擎**知道任务声明的判据是什么，模型不该从 history 里回忆。
     * 由 graph.ts 的 ctxOf 从 state.acceptanceChecks 注入。
     */
    acceptanceChecks?: readonly unknown[];
    /** 只读子 Agent（旧通道）：能分析、能解释，**不能写盘**。未注入时 delegateReadonly 直接拒绝 */
    analyzer?: (req: { question: string; paths?: string[] }) => Promise<string>;
    /**
     * 只读子 Agent（统一接口，tools/readonlySubAgent.ts）：
     * delegateReadonly 带 role 参数时走这里——结构化请求 / 结构化结果 / 严格 Schema。
     * ★ 这个端口由 **Developer 侧**（graph.ts ctxOf）注入；子 Agent 自身的运行环境里
     *   只有只读工具盒，永远拿不到 ctx，也拿不到写盘 / Hub / Ledger / State 任何入口。
     */
    subagent?: ReadonlySubAgentCall;
}

/** 唯一被允许写生成项目、并且唯一被允许执行命令的角色 */
export const DEVELOPER_ROLE_NAME = "developer";

/** 会改动生成项目的工具（调用前必须过角色检查） */
export const WRITE_TOOLS: ReadonlySet<string> = new Set(["mkdir", "writeFile", "editFile"]);

/**
 * 会在隔离环境里跑东西的工具（调用前必须过角色检查）。
 * runAcceptance 也在这里：它会真跑构建命令、真起服务打 HTTP——不是只读工具。
 */
export const EXEC_TOOLS: ReadonlySet<string> = new Set([
    "runCommand", "runBuild", "shell", "httpRequest", "runAcceptance",
]);

/** 会起/读/停长驻进程的工具（同样只属于 Developer） */
export const PROCESS_TOOLS: ReadonlySet<string> = new Set(["startProcess", "readProcess", "stopProcess"]);

/** 需要 Developer 角色的全部工具（写盘 ∪ 执行 ∪ 进程） */
export const PRIVILEGED_TOOLS: ReadonlySet<string> = new Set([
    ...WRITE_TOOLS, ...EXEC_TOOLS, ...PROCESS_TOOLS,
]);

/** 只读工具的权威清单（子 Agent / Test 侧只能碰这些） */
export const READONLY_TOOL_NAMES: readonly string[] = [
    "inspectTree", "readFile", "search", "gitDiff",
];

export interface ToolResult {
    ok: boolean;
    output: string;
    meta?: Record<string, unknown>;
    /** 被 workspace / sandbox 权限闸拒绝时的机器可读信息 */
    rejected?: { code: string; target: string; message: string };
}

export type ToolArgs = Record<string, unknown>;

export interface ToolParamSpec {
    type: "string" | "number" | "boolean" | "array" | "object";
    required: boolean;
    description: string;
}

export interface ToolSpec {
    name: string;
    description: string;
    parameters: Record<string, ToolParamSpec>;
    run(ctx: ToolContext, args: ToolArgs): Promise<ToolResult>;
}

/** 取字符串参数（缺省给 ""） */
export function str(args: ToolArgs, key: string): string {
    const v = args[key];
    return typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
}

/** 取数字参数（缺省给 fallback） */
export function num(args: ToolArgs, key: string, fallback: number): number {
    const v = args[key];
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : fallback;
}

/** 取字符串数组参数 */
export function strList(args: ToolArgs, key: string): string[] {
    const v = args[key];
    if (Array.isArray(v)) return v.map((x) => String(x));
    if (typeof v === "string" && v.trim()) return [v];
    return [];
}

export class ToolRegistry {
    private readonly tools = new Map<string, ToolSpec>();

    register(spec: ToolSpec): this {
        this.tools.set(spec.name, spec);
        return this;
    }

    get(name: string): ToolSpec | undefined {
        return this.tools.get(name);
    }

    list(): ToolSpec[] {
        return [...this.tools.values()];
    }

    names(): string[] {
        return [...this.tools.keys()];
    }

    /** 渐进披露：只给名字 / 描述 / 参数，不把实现塞进上下文 */
    describe(names?: string[]): { name: string; description: string; parameters: Record<string, ToolParamSpec> }[] {
        const picked = names
            ? names.map((n) => this.tools.get(n)).filter((t): t is ToolSpec => t !== undefined)
            : this.list();
        return picked.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
    }

    /** 统一入口：角色拒绝、沙箱缺失与执行异常都转成结构化结果，不往上抛 */
    async invoke(name: string, ctx: ToolContext, args: ToolArgs): Promise<ToolResult> {
        const spec = this.tools.get(name);
        if (!spec) return { ok: false, output: `未知工具：${name}` };

        // 特权工具只认 Developer —— 权限在代码里，不在 prompt 里。
        // 先判权限再判参数：角色不对就该听到"你没这个权限"，而不是"少传了参数"。
        // PM / Architect / TestAgent / Document 拿到 shell 或其他执行口 = 直接拒绝。
        if (PRIVILEGED_TOOLS.has(name) && ctx.role !== DEVELOPER_ROLE_NAME) {
            const who = ctx.role ?? "(未声明角色)";
            return {
                ok: false,
                output: `拒绝：角色「${who}」不是 Developer，无权调用 ${name}`,
                rejected: {
                    code: "NOT_DEVELOPER", target: name,
                    message: `角色「${who}」没有 ${name} 的权限（只有 Developer 可以写盘 / 执行命令 / 起进程）`,
                },
            };
        }

        const missing = Object.entries(spec.parameters)
            .filter(([key, p]) => p.required && args[key] === undefined)
            .map(([key]) => key);
        if (missing.length > 0) {
            return { ok: false, output: `缺少必填参数：${missing.join(", ")}` };
        }

        try {
            return await spec.run(ctx, args);
        } catch (e) {
            if (e instanceof WorkspaceViolation) {
                return {
                    ok: false,
                    output: e.message,
                    rejected: { code: e.code, target: e.target, message: e.message },
                };
            }
            if (e instanceof SandboxUnavailableError) {
                return {
                    ok: false,
                    output: e.message,
                    rejected: { code: e.detail.code, target: name, message: e.message },
                };
            }
            return { ok: false, output: `工具执行失败：${(e as Error).message}` };
        }
    }
}

// ---------- 默认装配：核心 10 个工具，顺序即规格里的清单顺序 ----------

import { inspectTreeTool } from "./inspectTree";
import { readFileTool } from "./readFile";
import { searchTool } from "./search";
import { writeFileTool } from "./writeFile";
import { editFileTool } from "./editFile";
import { mkdirTool } from "./mkdir";
import { runCommandTool } from "./runCommand";
import { runBuildTool } from "./runBuild";
import { gitDiffTool } from "./gitDiff";
import { delegateReadonlyTool } from "./delegateReadonly";

import { shellTool } from "./shell";
import { httpRequestTool } from "./httpRequest";
import { startProcessTool, readProcessTool, stopProcessTool } from "./processTools";
import { runAcceptanceTool } from "./runAcceptance";

/**
 * 核心工具集：文件读写 + 基础构建。
 * **保持与既有测试一致的 10 个工具**——进程与命令相关的扩展放在
 * createDeveloperProcessRegistry()，由 createFullDeveloperToolRegistry() 合并。
 */
export function createDeveloperToolRegistry(): ToolRegistry {
    return new ToolRegistry()
        .register(inspectTreeTool)
        .register(readFileTool)
        .register(searchTool)
        .register(writeFileTool)
        .register(editFileTool)
        .register(mkdirTool)
        .register(runCommandTool)
        .register(runBuildTool)
        .register(gitDiffTool)
        .register(delegateReadonlyTool);
}

/**
 * Claude Code 式扩展工具集：任意 shell、本机 HTTP 调试、长驻服务生命周期。
 * 这些是 Developer 的**额外**能力，不是唯一的命令入口（runCommand 仍在核心集里）。
 */
export function createDeveloperProcessRegistry(): ToolRegistry {
    return new ToolRegistry()
        .register(shellTool)
        .register(httpRequestTool)
        .register(startProcessTool)
        .register(readProcessTool)
        .register(stopProcessTool)
        // 验收预演（9/15 下沉）：一条调用跑完 COMPILE + CONTRACT 判据，
        // 替掉 r5 里"模型手写 selftest-*.mjs 自证"的 25 次自造验证。
        .register(runAcceptanceTool);
}

/** 合并多个注册表（同名后者覆盖前者，冲突可见） */
export function mergeToolRegistries(...registries: readonly ToolRegistry[]): ToolRegistry {
    const merged = new ToolRegistry();
    for (const r of registries) for (const spec of r.list()) merged.register(spec);
    return merged;
}

/** Developer 实际使用的完整工具集（核心 10 + 扩展 5） */
export function createFullDeveloperToolRegistry(): ToolRegistry {
    return mergeToolRegistries(createDeveloperToolRegistry(), createDeveloperProcessRegistry());
}

