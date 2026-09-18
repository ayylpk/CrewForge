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
import { askHumanTool } from "./askHuman";
import { probeEnvTool } from "./probeEnv";
import { consultStationTool } from "./consultStation";
// 召唤工位（层 B）的协议类型：与 developerAgent/protocol.ts 的形状约定不同——
// 它是**跨工位**的协议（四个工位都实现同一份），所以定义住在 agents-CrewForge/consult.ts。
import type { ConsultReply, ConsultRole } from "../../consult";

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
     * 观测端口（9/18）：工具把自己身上"值得记账的事"写进台账。
     *
     *   为什么需要它：只读工具的返回**不进 completed_tool_call**（见 graph 的只读免缓存策略），
     *   于是"readFile 去重到底命中几次"在台账里查不到——9/18 想量这个指标时才发现是个盲区。
     *   与 askHuman/consultStation 同款：**未注入就是没有**，工具不静默降级、也不报错。
     */
    note?: (event: string, payload?: Record<string, unknown>) => void;
    /**
     * 只读子 Agent（统一接口，tools/readonlySubAgent.ts）：
     * delegateReadonly 带 role 参数时走这里——结构化请求 / 结构化结果 / 严格 Schema。
     * ★ 这个端口由 **Developer 侧**（graph.ts ctxOf）注入；子 Agent 自身的运行环境里
     *   只有只读工具盒，永远拿不到 ctx，也拿不到写盘 / Hub / Ledger / State 任何入口。
     */
    subagent?: ReadonlySubAgentCall;
    /**
     * 问人端口（9/17）：askHuman 工具的落点。
     * 由 **Developer 侧**（graph.ts ctxOf ← index.ts 注入的 Questioner）提供；
     * 未注入 = 该角色无权打扰人（子 Agent / Test 侧工具盒），askHuman 会**默认拒绝**，
     * 而不是静默降级成"自己决定"。
     */
    askHuman?: (req: { question: string; options?: string[] }) => Promise<string>;
    /**
     * 验收记忆（9/17 回归冻结）：runAcceptance 用它读/写"上一次预演的逐条判据状态"。
     * 由 graph 侧用 Ledger 实现（落库，跨阶段/跨进程不丢）——回归判定的基线必须比进程活得久，
     * 否则每阶段起新进程就退化成"每轮都是首次预演"，回归永远抓不到。
     * 未注入 = 不做回归判定（只报当轮结果，行为与改造前一致）。
     */
    acceptanceMemory?: {
        load(): Record<string, "pass" | "fail" | "unevaluable"> | null;
        save(status: Record<string, "pass" | "fail" | "unevaluable">): void;
    };
    /**
     * 召唤真工位（层 B，咨询协议见 agents-CrewForge/consult.ts）：
     * architect / pm / test-core / maintainer 四站，各自对自己**拥有的产物**有职权
     * （架构师改计划/批次、测试澄清判据、PM 澄清需求、维护者出验收说明）。
     *
     *   ★ 端口只传 role/question/focus —— **没有 evidence 参数**是刻意的：
     *     协议里的 evidence 是"发起方声明的背景"，模型手写的内容不该披着机器证据的皮
     *     送出去（graph.ts 里 delegateReadonly 剥离模型自写 evidence 是同一手法）；
     *     模型提供的背景材料由工具拼进 question 正文，并显式标注"未经机器核验"。
     *   ★ 返回 null = 超时（工位没在时限内回话）——司机据此**降级**（自行决策 + 写明假设），
     *     绝不允许挂起：这条线的断掉不该把整轮任务打死。
     *   ★ 未注入 = 该角色无权召唤工位（只读子 Agent / Test 侧工具盒），工具默认拒绝。
     *   ★ 工位永远不写生成项目的代码：写盘/执行只有 DEVELOPER_ROLE_NAME 有权限
     *     （WRITE_TOOLS / EXEC_TOOLS 的角色闸），本端口不改变这条。
     */
    consultStation?: (req: { role: ConsultRole; question: string; focus?: string[] }) => Promise<ConsultReply | null>;
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
        .register(runAcceptanceTool)
        // 问人（9/17）：模型主动求助。与 escalation.ts（代码强制升级）是一对——
        // 没有这个工具，模型"想求助"只能写在助手文本里，而进程在跑、没人看得到，
        // 于是变成自己硬扛到预算烧尽（s5b）。挂在扩展集，核心 10 件套不动。
        .register(askHumanTool)
        // 环境自省（9/17）：随时实测本机有什么，再决定走哪条路（只读、无副作用）
        .register(probeEnvTool)
        // 召唤真工位（9/17 拓扑升级·层 B）：司机在自己的循环里把问题送回**拥有该产物**的
        // 工位（架构师/PM/测试/维护者），拿回意见**或**已生效的修订。
        // 层 A（delegateReadonly 的两个顾问角色）只给意见；没有层 B，"契约不一致"这类
        // 上游缺口在流程里就没有任何处置权，司机只能自己发明解释——这就是"换脑断层"。
        // 与 askHuman/probeEnv 同挂扩展集：核心 10 件套不动（tools.test.ts 的 10 个工具清单不改）。
        .register(consultStationTool);
}

/** 合并多个注册表（同名后者覆盖前者，冲突可见） */
export function mergeToolRegistries(...registries: readonly ToolRegistry[]): ToolRegistry {
    const merged = new ToolRegistry();
    for (const r of registries) for (const spec of r.list()) merged.register(spec);
    return merged;
}

/** Developer 实际使用的完整工具集（核心 10 + 扩展 9：shell/httpRequest/进程三件套/
 *  runAcceptance/askHuman/probeEnv/consultStation） */
export function createFullDeveloperToolRegistry(): ToolRegistry {
    return mergeToolRegistries(createDeveloperToolRegistry(), createDeveloperProcessRegistry());
}

