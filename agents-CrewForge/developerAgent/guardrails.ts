// ============================================================
// guardrails.ts —— 代码级护栏规则引擎（**默认拒绝 + 单调 deny**）
//
//   为什么需要它（四家参考实现的一致结论）：
//     opencode permission.ts（默认拒绝 + 通配求值）、dsh 单调 ToolGuard（只能 deny 不能 allow）、
//     claudecode checkRuleBasedPermissions（deny 覆盖 hook 的 allow）、pi before_tool block。
//     四家都把"禁止"做成**代码护栏**，而不是提示词。本仓的反例就在眼前：
//     `skills/backend-development.md` 的"禁止一次生成整个后端目录"写在提示词里被无视过
//     （9/16 p7 llm#16 批量铺 w4→w9）——提示词负责解释"为什么"，代码负责"拦不拦"。
//
//   单调 = 规则**只能拒绝，不能放行**：命中即拒，没有任何 allow 能覆盖它。
//   （claudecode 的 deny-overrides-hook 防的就是"一条更宽的 allow 把 deny 打开"。）
//
//   与 workspace 既有写入白名单的分工：workspace 管"能不能写这个路径"（边界/逃逸/工程文件），
//   这里管"这次动作本身是否属于被明令禁止的做法"（危险命令 / 超量铺文件）。两者互补、不重叠。
// ============================================================

import { WRITE_TOOLS } from "./tools/registry";
import type { ToolArgs } from "./tools/registry";

export interface GuardrailRule {
    id: string;
    /** 命中的工具名；"*" 表示所有工具 */
    tool: string;
    /** 谓词：返回 true = 命中本规则；缺省 = 只要工具名匹配就命中 */
    when?: (args: ToolArgs) => boolean;
    /** 拒绝理由（回灌模型 + 记账，要能让人一眼看懂"违反了哪条、为什么"） */
    reason: string;
}

/** 单个 writeFile 一次写入的正文上限（字节）——防"一条命令铺一个大文件" */
export const MAX_SINGLE_WRITE_BYTES = 64 * 1024;
/** 单次批量决策里写操作的条数上限——治"一次生成整个后端目录"（被提示词无视过的条款） */
export const MAX_WRITES_PER_BATCH = 6;

/** 明确危险、一律禁止的 shell/命令模式（claudecode 的 bash_command_validator 同族） */
const DANGEROUS_SHELL_PATTERNS: readonly { re: RegExp; why: string }[] = [
    { re: /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/i, why: "递归强制删除（rm -rf）" },
    { re: /\bdel\s+\/[a-z]*s[^\n]*\/[a-z]*q|\bdel\s+\/[a-z]*q[^\n]*\/[a-z]*s/i, why: "递归静默删除（del /s /q）" },
    { re: /\b(format|mkfs|diskpart)\b/i, why: "格式化/分区命令" },
    { re: /\b(shutdown|reboot)\b/i, why: "关机/重启命令" },
    { re: /:\s*\(\s*\)\s*\{[^}]*\}\s*;\s*:/, why: "fork 炸弹" },
];

const hitsDangerous = (text: string): boolean => DANGEROUS_SHELL_PATTERNS.some((p) => p.re.test(text));

export const DEFAULT_GUARDRAILS: readonly GuardrailRule[] = [
    {
        id: "dangerous-shell",
        tool: "shell",
        when: (args) => hitsDangerous(String(args["command"] ?? "")),
        reason: "禁止执行危险/破坏性 shell 命令（递归删除、格式化、关机、fork 炸弹）。"
            + "若确需清理，只针对项目内明确路径、用可审计的单条命令。",
    },
    {
        id: "dangerous-runCommand",
        tool: "runCommand",
        when: (args) => {
            const all = [
                String(args["command"] ?? ""),
                ...(Array.isArray(args["args"]) ? (args["args"] as unknown[]).map(String) : []),
            ].join(" ");
            return hitsDangerous(all);
        },
        reason: "禁止执行危险/破坏性命令（递归删除、格式化、关机等）。",
    },
    {
        id: "oversized-write",
        tool: "writeFile",
        when: (args) => {
            const content = args["content"];
            return typeof content === "string" && Buffer.byteLength(content, "utf8") > MAX_SINGLE_WRITE_BYTES;
        },
        reason: `禁止单次写入超过 ${Math.round(MAX_SINGLE_WRITE_BYTES / 1024)}KB 的文件正文`
            + "——大文件请拆成多次写入（先骨架再补内容），或先与需求确认是否真需要这么大。",
    },
];

export interface GuardrailVerdict { id: string; reason: string }

/**
 * 求值：默认拒绝 + **单调**（命中即拒，无 allow 可覆盖）。
 * 返回 null = 放行；否则返回拒绝裁定。
 *
 *   纯函数、零 IO——可单测，也能被 runToolLoop / 未来其它入口复用同一份判定。
 */
export function evaluateGuardrails(
    tool: string, args: ToolArgs, rules: readonly GuardrailRule[] = DEFAULT_GUARDRAILS,
): GuardrailVerdict | null {
    for (const r of rules) {
        if (r.tool !== "*" && r.tool !== tool) continue;
        if (r.when && !r.when(args)) continue;
        return { id: r.id, reason: r.reason };
    }
    return null;
}

/**
 * 批量级护栏：一次模型决策里**写操作**条数超限即整批拒绝。
 *
 *   治的正是被提示词无视过的那条："禁止一次生成整个后端目录"。
 *   批级判定而不是逐条判定——因为"铺整个目录"这个行为只有在**批**的粒度上才看得见。
 */
export function evaluateWriteBatch(
    calls: readonly { tool: string }[], limit = MAX_WRITES_PER_BATCH,
): GuardrailVerdict | null {
    const writes = calls.filter((c) => WRITE_TOOLS.has(c.tool)).length;
    if (writes <= limit) return null;
    return {
        id: "write-batch-limit",
        reason: `一次批量决策里写了 ${writes} 个文件，超过上限 ${limit}`
            + "——禁止一次铺完整个后端目录；请按工作项分批，每批写完先验证再继续。",
    };
}
