// ============================================================
// tools/runAcceptance.ts —— 验收预演（把"自检"从模型手里收回引擎）
//
//   ── 这一刀治什么（r5 实测数据）──
//   r5 的 145 次 LLM 调用里，**116 次（80%）发生在最后一次写文件之后**，
//   46 分钟里有 25 次是"自造验证"：模型手写 backend/scripts/selftest-persistence.mjs
//   （11,107 B）、selftest-id-reset.mjs（9,508 B），再逐条跑、读输出、改。
//
//   根因不是模型笨，是**引擎没给执行器**：任务包里 8 条 CONTRACT 判据
//   （"GET /api/todos → 200 且 data 是数组且倒序"）完全可机械执行，但
//   verifier 侧把它们登记为 skipped（无通用 HTTP 执行器），模型只能自己造。
//
//   本工具把 contractProbeCore 暴露给 Developer：**一条调用换掉一整轮写脚本-跑-读-改**。
//   它只做"执行 + 报告"，**不产生任何权威结论**——verified 仍然只属于外部 TestAgent。
//   这是刻意的：Developer 自检再真也不能自判通过（反规格投机skill 的红线）。
//
//   ── 与 TestAgent 执行的是不是同一份逻辑 ──
//   是。同一个 contractProbeCore.runContractProbe，同一套断言。
//   区别只在**谁发起**：这里由 Developer 主动预演（用来提前发现契约未通），
//   正式验收仍由外部 TestAgent 跑（用它产生 test_passed/test_failure 证据）。
// ============================================================

import path from "node:path";
import { runContractProbe, suggestServeCommand } from "../../contractProbeCore";
import type { ContractIntent, ServeSpec } from "../../contractProbeCore";
import { resolveProjectCommand } from "./projectCommands";
import { num, str } from "./registry";
import type { ToolContext, ToolResult, ToolSpec } from "./registry";

/** 一条预演项：要么是可执行命令（COMPILE 类），要么是 HTTP 契约（CONTRACT 类） */
interface RehearsalItem {
    id: string;
    kind: "command" | "contract";
    // command 形态
    command?: string;
    args?: string[];
    cwd?: string;
    // contract 形态
    method?: string;
    urlPath?: string;
    expectedStatus?: number;
    body?: unknown;
    expectBodyContains?: string;
    auth?: { method: string; path: string; body?: unknown };
    /** 前置步骤（播数据 / 取变量）——原样透传给探针 */
    setup?: unknown[];
}

/**
 * 从任务包的 acceptanceChecks 里抽出**可机械执行**的子集。
 *
 *   · 显式命令 → 直接执行（与 TestAgent 同语义）；
 *   · kind=COMPILE → 读工程文件解析命令（resolveGenericCommand，与 verifier 同一份）；
 *   · kind=CONTRACT → 走 contractProbeCore（**这就是 r5 缺的那块**）；
 *   · 其他形状（认不出）→ 如实列进 unexecutable，**不猜**。
 */
function collectChecks(
    projectDirAbs: string,
    checks: unknown[],
    resolveCommand: (dirAbs: string) => { command: string; args: string[] } | null,
): { runnable: RehearsalItem[]; unexecutable: { id: string; kind: string; reason: string }[] } {
    const runnable: RehearsalItem[] = [];
    const unexecutable: { id: string; kind: string; reason: string }[] = [];

    for (const raw of checks) {
        const c = (raw ?? {}) as Record<string, unknown>;
        const id = String(c["id"] ?? "?");
        const kind = String(c["kind"] ?? (typeof c["command"] === "string" ? "COMMAND" : "UNKNOWN"));

        // ① 显式命令形态
        if (typeof c["command"] === "string" && c["command"]) {
            runnable.push({
                id, kind: "command", command: c["command"],
                args: Array.isArray(c["args"]) ? (c["args"] as unknown[]).map(String) : [],
                cwd: typeof c["cwd"] === "string" ? c["cwd"] : ".",
            });
            continue;
        }
        // ② COMPILE 意图 → 工程文件解析
        if (kind === "COMPILE") {
            const target = String(c["target"] ?? ".");
            const resolved = resolveCommand(path.join(projectDirAbs, target));
            if (resolved) {
                runnable.push({ id, kind: "command", command: resolved.command, args: resolved.args, cwd: target });
            } else {
                unexecutable.push({ id, kind, reason: `目录 ${target} 找不到通用工程入口（mvnw/gradlew/package.json/pyproject/go.mod）` });
            }
            continue;
        }
        // ③ CONTRACT 意图 → HTTP 契约执行器（r5 缺的就是这块）
        if (kind === "CONTRACT") {
            const p = c["path"];
            if (typeof p !== "string" || !p) {
                unexecutable.push({ id, kind, reason: "CONTRACT 判据缺 path，无法执行" });
                continue;
            }
            runnable.push({
                id, kind: "contract",
                method: String(c["method"] ?? "GET").toUpperCase(),
                urlPath: p,
                expectedStatus: typeof c["expectedStatus"] === "number" ? c["expectedStatus"] : 200,
                ...(c["body"] !== undefined ? { body: c["body"] } : {}),
                ...(typeof c["expectBodyContains"] === "string" ? { expectBodyContains: c["expectBodyContains"] } : {}),
                ...(c["auth"] ? { auth: c["auth"] as { method: string; path: string; body?: unknown } } : {}),
                ...(Array.isArray(c["setup"]) ? { setup: c["setup"] as unknown[] } : {}),
            });
            continue;
        }
        unexecutable.push({ id, kind, reason: `无法机械执行的判据形状（kind=${kind}）` });
    }
    return { runnable, unexecutable };
}

export const runAcceptanceTool: ToolSpec = {
    name: "runAcceptance",
    description:
        "验收预演：把任务包里的可机械执行判据（COMPILE 命令 + CONTRACT HTTP 契约）"
        + "**一次性批量真跑**，返回逐条证据（exitCode / 状态码 / 正文片段）。"
        + "契约类会自己起服务（随机端口）→ 打请求 → 断言 → 杀服务。"
        + "⚠️ 这是自检，不是验收：结果只用于提前发现问题，**不能**当成 verified 的依据。",
    parameters: {
        /** 只跑指定 id（缺省全跑）；避免"只想看一条却重跑全量" */
        only: { type: "array", required: false, description: "只跑这些判据 id（如 [\"ac-3\",\"ac-4\"]）；不传=全跑" },
        /** 起服务命令：不给就按 serveCwd 的 package.json 探测 dev/start */
        serveCommand: { type: "string", required: false, description: "起被测服务的可执行文件（如 npm / node / bun）" },
        serveArgs: { type: "array", required: false, description: "起服务的参数数组" },
        serveCwd: { type: "string", required: false, description: "起服务的工作目录（相对项目根，默认 backend）" },
        portEnv: { type: "string", required: false, description: "端口注入的环境变量名，默认 PORT" },
        healthPath: { type: "string", required: false, description: "健康检查路径，默认 /" },
        bootWaitMs: { type: "number", required: false, description: "等服务启动的上限毫秒数，默认 30000" },
        timeoutMs: { type: "number", required: false, description: "整体超时毫秒数，默认 300000" },
    },
    async run(ctx: ToolContext, args): Promise<ToolResult> {
        const ws = ctx.workspace;
        // 从 state 里拿任务包判据：ctx 里没有它，走 workspace 上挂的运行时快照（见 registry 注入）
        const checks = ctx.acceptanceChecks ?? [];

        if (checks.length === 0) {
            return {
                ok: false,
                output: "当前任务没有可预演的验收判据（acceptanceChecks 为空）——请按契约实现后交由外部 TestAgent 验收。",
            };
        }

        const projectDirAbs = ctx.projectDirAbs;
        if (!projectDirAbs) {
            return { ok: false, output: "内部错误：工具上下文缺 projectDirAbs（无法定位项目根）" };
        }

        const only = new Set(Array.isArray(args["only"]) ? (args["only"] as unknown[]).map(String) : []);
        const picked = only.size > 0 ? checks.filter((c) => only.has(String((c as Record<string, unknown>)["id"]))) : checks;

        if (picked.length === 0) {
            return { ok: false, output: `only 里指定的 id 在任务包判据里一个都不存在：${[...only].join(", ")}` };
        }

        // 直接用底层解析器（不引 architectTaskBuilder：它反过来依赖 developerAgent，
        // 会形成循环依赖；resolveGenericCommand 只是它的兼容别名）
        const { runnable, unexecutable } = collectChecks(projectDirAbs, picked, resolveProjectCommand);

        // 起服务命令：显式给了就用；没给就按 serveCwd 探测 package.json（探测不到=不猜）
        const serveCwd = str(args, "serveCwd") || "backend";
        let serve: ServeSpec | null = null;
        const explicitCmd = str(args, "serveCommand");
        if (explicitCmd) {
            serve = {
                command: explicitCmd,
                args: Array.isArray(args["serveArgs"]) ? (args["serveArgs"] as unknown[]).map(String) : [],
                cwd: serveCwd,
                portEnv: str(args, "portEnv") || "PORT",
                healthPath: str(args, "healthPath") || "/",
                bootWaitMs: num(args, "bootWaitMs", 30_000),
            };
        } else {
            const guessed = suggestServeCommand(path.join(projectDirAbs, serveCwd));
            if (guessed) {
                serve = {
                    command: guessed.command, args: guessed.args, cwd: serveCwd,
                    portEnv: str(args, "portEnv") || "PORT",
                    healthPath: str(args, "healthPath") || "/",
                    bootWaitMs: num(args, "bootWaitMs", 30_000),
                };
            }
        }

        const timeoutMs = num(args, "timeoutMs", 300_000);
        const startedAll = Date.now();
        const lines: string[] = [];
        const m = (s: string): void => { lines.push(s); console.log(`[runAcceptance] ${s}`); };

        let passed = 0, failed = 0;
        const results: Record<string, unknown>[] = [];

        for (const item of runnable) {
            if (Date.now() - startedAll > timeoutMs) {
                m(`⏱ 整体超时（${timeoutMs}ms），剩余判据未执行：${item.id} 起`);
                break;
            }
            if (item.kind === "command") {
                const r = await ws.exec(
                    item.command!, item.args ?? [],
                    { cwd: item.cwd, timeoutMs: Math.min(600_000, timeoutMs), label: `acceptance:${item.id}` },
                    { owner: ctx.owner, taskId: ctx.taskId },
                );
                const ok = r.exitCode === 0 && !r.timedOut && (r.violations ?? []).length === 0;
                if (ok) passed++; else failed++;
                m(`${ok ? "✅" : "❌"} ${item.id} ${item.command} ${(item.args ?? []).join(" ")} → exit=${String(r.exitCode)} ${r.durationMs}ms${r.timedOut ? " [超时]" : ""}`);
                if (!ok) {
                    // 失败给足原文（与 TestAgent 同规格：不许只留摘要）
                    m(`--- stdout 尾部 ---\n${r.stdout.slice(-3_000)}`);
                    if (r.stderr.trim()) m(`--- stderr 尾部 ---\n${r.stderr.slice(-3_000)}`);
                }
                results.push({
                    id: item.id, kind: "COMPILE", ok, command: item.command, args: item.args, cwd: r.cwd,
                    exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs,
                });
                continue;
            }
            // CONTRACT：需要起服务
            if (!serve) {
                failed++;
                m(`⏭ ${item.id}（契约）跳过：探测不到起服务命令（${serveCwd}/package.json 无 dev/start 脚本）。`
                    + "请用 serveCommand+serveArgs 显式指定怎么起服务，或确认服务已能启动。");
                results.push({ id: item.id, kind: "CONTRACT", ok: false, reason: "SERVE_UNKNOWN" });
                continue;
            }
            const intent: ContractIntent = {
                method: item.method ?? "GET",
                path: item.urlPath ?? "/",
                expectedStatus: item.expectedStatus ?? 200,
                ...(item.body !== undefined ? { body: item.body } : {}),
                ...(item.expectBodyContains ? { expectBodyContains: item.expectBodyContains } : {}),
                ...(item.auth ? { auth: item.auth } : {}),
                ...(item.setup ? { setup: item.setup as ContractIntent["setup"] } : {}),
            };
            const r = await runContractProbe({
                projectDirAbs, serve, intent,
                timeoutMs: Math.min(180_000, Math.max(30_000, timeoutMs - (Date.now() - startedAll))),
                log: (l) => m(l),
            });
            if (r.ok) passed++; else failed++;
            m(`${r.ok ? "✅" : "❌"} ${item.id} ${intent.method} ${intent.path} → ${String(r.meta["actualStatus"] ?? "-")}（期望 ${intent.expectedStatus}）`);
            results.push({ id: item.id, kind: "CONTRACT", ok: r.ok, ...r.meta });
        }

        const unexec = unexecutable.map((u) => `${u.id}(${u.kind})`);
        const summary = [
            `验收预演完成：通过 ${passed} / 失败 ${failed} / 共 ${runnable.length} 条可执行判据`
            + (unexec.length > 0 ? `；另有 ${unexec.length} 条无法机械执行：${unexec.join(", ")}` : ""),
            `耗时 ${((Date.now() - startedAll) / 1000).toFixed(1)}s`,
            "",
            "⚠️ 这是自检预演，不是验收结论：verified 只能由外部 TestAgent 判定。",
        ];

        // 一条 CONTRACT 失败 → ok:false（让模型看到失败并去修），但**不阻断**：全部结果都在 output 里
        return {
            ok: failed === 0 && runnable.length > 0,
            output: [...lines, "", ...summary].join("\n"),
            meta: {
                passed, failed, runnable: runnable.length,
                unexecutable: unexecutable.map((u) => u.id),
                results,
                durationMs: Date.now() - startedAll,
            },
        };
    },
};
