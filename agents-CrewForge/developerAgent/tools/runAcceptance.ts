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
// 回归冻结（9/17）：上一次预演的逐条状态 vs 这一次 —— 抓"修复动作弄坏已通过项"（s4 死因）
import { diffCriteria, renderRegressionWarning, summarizeCriteriaDiff } from "../regression";
import type { CriteriaDiff } from "../regression";

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
    /** 结构化断言（过滤/隔离/汇总类语义）——原样透传给探针 */
    assertJson?: unknown[];
    /** 本条判据自己的干净起点声明（优先于工具级 resetPaths） */
    resetPaths?: string[];
    auth?: { method: string; path: string; body?: unknown };
    /** 前置步骤（播数据 / 取变量）——原样透传给探针 */
    setup?: unknown[];
    /** 自定义请求头（通用能力：多身份判据靠它表达；引擎不解释头语义） */
    headers?: Record<string, string>;
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
    checks: readonly unknown[],
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
                ...(Array.isArray(c["assertJson"]) ? { assertJson: c["assertJson"] as unknown[] } : {}),
                ...(Array.isArray(c["resetPaths"]) ? { resetPaths: (c["resetPaths"] as unknown[]).map(String) } : {}),
                ...(c["auth"] ? { auth: c["auth"] as { method: string; path: string; body?: unknown } } : {}),
                ...(Array.isArray(c["setup"]) ? { setup: c["setup"] as unknown[] } : {}),
                ...(c["headers"] && typeof c["headers"] === "object"
                    ? { headers: c["headers"] as Record<string, string> } : {}),
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
        resetPaths: { type: "array", required: false, description: "起服务前删除的数据文件；**相对 serveCwd 或相对项目根都认**（如 serveCwd=backend 时写 \"data/ledger.db\"，或从项目根写 \"backend/data/ledger.db\"；两处都存在时优先 serveCwd 并告警）。用于保证「干净起点」——精确断言（id=1、汇总=某值）依赖它。**写错文件名会让本轮判据直接失败**（不会静默跳过）" },
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

        const only = new Set<string>(Array.isArray(args["only"]) ? (args["only"] as readonly unknown[]).map(String) : []);
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
        // 干净起点：无论命令来自显式还是探测，都挂上 resetPaths（判据/调用方声明的）
        const resetPaths = Array.isArray(args["resetPaths"]) ? (args["resetPaths"] as unknown[]).map(String) : [];
        if (serve && resetPaths.length > 0) serve = { ...serve, resetPaths };

        const timeoutMs = num(args, "timeoutMs", 300_000);
        const startedAll = Date.now();
        const modelLines: string[] = [];       // 给模型的：紧凑、失败优先（见下方 output 注释）
        // 全量逐条现场只进控制台（runner 把它落进日志），**不进 output** —— 否则必被 8192 截断
        const m = (s: string): void => { console.log(`[runAcceptance] ${s}`); };
        /** 从工具原始输出里抠出**一条**能进紧凑清单的原因（优先"· "条目行，其次末行） */
        const briefReason = (out: string): string => {
            const ls = out.split(/\r?\n/).map((s) => s.trim()).filter((s) => s !== "");
            const pick = ls.find((s) => s.startsWith("·")) ?? ls[ls.length - 1] ?? "";
            return pick.replace(/^·\s*/, "").slice(0, 220);
        };

        let passed = 0, failed = 0;
        // ★ 第三个桶：判据**求值不了**（判据侧问题，改代码无效）。
        //   与 failed 严格分开：9/16 p7 实弹把两类混在一起报 ❌，模型分不清该改代码
        //   还是这条判据根本判不了，在一条永远过不了的判据上追了 49 分钟。
        let unevaluable = 0;
        const unevaluableIds: string[] = [];
        const failedIds: string[] = [];
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
                ...(item.assertJson ? { assertJson: item.assertJson as ContractIntent["assertJson"] } : {}),
                ...(item.auth ? { auth: item.auth } : {}),
                ...(item.setup ? { setup: item.setup as ContractIntent["setup"] } : {}),
                ...(item.headers ? { headers: item.headers } : {}),
            };
            const r = await runContractProbe({
                projectDirAbs, serve, intent,
                timeoutMs: Math.min(180_000, Math.max(30_000, timeoutMs - (Date.now() - startedAll))),
                log: (l) => m(l),
            });
            // 分三桶：全绿 / 有真断言失败（改代码有用）/ 全是"判不了"（改代码无效）
            const uneval = (r.meta["unevaluableChecks"] as string[] | undefined) ?? [];
            const realFails = (r.meta["assertFailures"] as string[] | undefined) ?? [];
            if (r.ok) passed++;
            else if (uneval.length > 0 && realFails.length === 0) { unevaluable++; unevaluableIds.push(item.id); }
            else { failed++; failedIds.push(item.id); }
            const oneLine = `${r.ok ? "✅" : "❌"} ${item.id} ${intent.method} ${intent.path} → ${String(r.meta["actualStatus"] ?? "-")}（期望 ${intent.expectedStatus}）`;
            m(oneLine);
            // 给模型的那份：一行结论 + 一行原因 —— 够它决定"该改哪一条"
            modelLines.push(r.ok ? oneLine : `${oneLine}\n    ↳ ${briefReason(r.output)}`);
            // ★ 失败现场：**全量**原文进控制台/日志（人看得细），模型侧走紧凑清单 + only 重跑。
            //   9/15 p1 的教训（只打一行 → 模型看不到任何原因 → 自己去造工具猜）仍然成立，
            //   所以"一行原因"必须留；但旧做法把全量塞进 output，几十条 × 2.5KB 必超 8192，
            //   于是被 clipForModel 头尾截断 —— **失败清单恰好在中间被吃掉**
            //   （9/16 p7 llm#55 原话："truncated in the middle so I can't see which"）。
            //   现在：模型拿到"一行结论 + 一行原因"（够决定改哪条），要看某条完整现场就
            //   only:["<id>"] 重跑 —— 现场依然够，但不再越窗。
            if (!r.ok) {
                m(`--- ${item.id} 现场 ---\n${r.output.slice(-2_500)}`);
            }
            results.push({ id: item.id, kind: "CONTRACT", ok: r.ok, ...r.meta });
        }

        const unexec = unexecutable.map((u) => `${u.id}(${u.kind})`);
        // ---------- 回归冻结（9/17）----------
        // 把这一次的逐条状态与**上一次预演**比对：上次通过、这次失败的 = 回归（修复动作弄坏了已通过项）。
        // 基线存在 Ledger 里（跨阶段/跨进程不丢）：s4 就是死在"批量改盘把已通过的 create 改挂"，
        // 而当时没有任何东西守着已通过项，模型只看到"现在有几条失败"，于是越修越乱。
        const statusNow: Record<string, "pass" | "fail" | "unevaluable"> = {};
        for (const r of results) {
            const id = typeof r["id"] === "string" ? r["id"] : null;
            if (!id) continue;
            if (r["ok"] === true) statusNow[id] = "pass";
            else if (r["unevaluable"] === true || r["reason"] === "UNEVALUABLE") statusNow[id] = "unevaluable";
            else statusNow[id] = "fail";
        }
        // 不可判定清单以汇总口径为准（明细里未必带 unevaluable 标记）
        for (const id of unevaluableIds) statusNow[id] = "unevaluable";
        let diff: CriteriaDiff = { firstRun: true, regressed: [], fixed: [], stillFailing: [], appeared: [], disappeared: [] };
        try {
            const prev = ctx.acceptanceMemory?.load() ?? null;
            diff = diffCriteria(prev, statusNow);
            ctx.acceptanceMemory?.save(statusNow);
        } catch (e) {
            console.warn(`[runAcceptance] 回归比对不可用（继续，不影响预演结果）：${String((e as Error).message ?? e)}`);
        }
        const regressionBlock = renderRegressionWarning(diff);

        const summary = [
            `验收预演完成：通过 ${passed} / 失败 ${failed} / 不可判定 ${unevaluable} / 共 ${runnable.length} 条可执行判据`
            + (unexec.length > 0 ? `；另有 ${unexec.length} 条无法机械执行：${unexec.join(", ")}` : ""),
            `耗时 ${((Date.now() - startedAll) / 1000).toFixed(1)}s`,
        ];
        if (!diff.firstRun) {
            summary.push(`本轮对比上一轮：${summarizeCriteriaDiff(diff)}`);
        }
        if (unevaluable > 0) {
            // 把"判不了"单独讲清楚：它既不是绿，也不是模型的锅
            summary.push(
                "",
                `⚠️ 不可判定的判据（${unevaluable} 条）：${unevaluableIds.join(", ")}`,
                "   这些**不是代码问题**——是判据自身求值不了（形状非法 / 执行器不支持的写法）。",
                "   改服务端代码对它们**无效**：要修的是判据（架构师侧）。别在它们身上反复重跑预演。",
            );
        }
        // ★ id 清单永远完整（这是不可再省的那部分：模型至少要**知道是哪几条**）。
        //   明细可以省，清单不能省——9/16 p7 的痛点正是"知道错了 17 条、不知道是哪 17 条"。
        if (failed > 0) summary.push("", `失败（改代码有用）：${failedIds.join(", ")}`);
        summary.push("", "⚠️ 这是自检预演，不是验收结论：verified 只能由外部 TestAgent 判定。");

        // 一条 CONTRACT 失败 → ok:false（让模型看到失败并去修），但**不阻断**。
        // ★ output 给模型的是**紧凑版**：失败/不可判定清单（一条一行 + 一行原因）+ 汇总。
        //   全量 lines 只进控制台与 meta.results —— 堆进 output 就会被 8192 截断，把清单吃掉。
        const hint = (failed > 0 || unevaluable > 0)
            ? `\n要看某一条的完整现场：用 only: ["${failedIds[0] ?? unevaluableIds[0] ?? ""}"] 只重跑它。`
            : "";
        // 兜底：明细本身也要有上限。64 条全失败时一行约 270 字符 × 64 ≈ 17KB，照样越窗；
        // 而"是哪几条"的完整清单在 summary 里（那部分不省），这里省掉的只是逐条原因。
        const DETAIL_CAP = 5_000;
        let body = modelLines.join("\n");
        if (body.length > DETAIL_CAP) {
            const kept: string[] = [];
            let n = 0;
            for (const l of modelLines) {
                if (n + l.length > DETAIL_CAP) break;
                kept.push(l);
                n += l.length;
            }
            body = `${kept.join("\n")}\n…（明细过长，已省略 ${modelLines.length - kept.length} 条原因；`
                + "完整 id 见下面的清单，逐条现场用 only 重跑）";
        }
        return {
            // fail-closed：有真失败、或仍有判不了的，都不算绿（判不了 ≠ 通过；
            // 同"JSON 解析失败也判失败"的既有口径）
            ok: failed === 0 && unevaluable === 0 && runnable.length > 0,
            output: [
                regressionBlock,
                modelLines.length > 0 ? body : "（全部判据通过）",
                "",
                ...summary,
            ].filter(Boolean).join("\n") + hint,
            meta: {
                passed, failed, failedIds, unevaluable, unevaluableIds, runnable: runnable.length,
                unexecutable: unexecutable.map((u) => u.id),
                results,
                durationMs: Date.now() - startedAll,
                // 回归冻结的证据：上一轮通过、这一轮挂掉的判据（空数组 = 无回归）
                regressions: diff.regressed,
                fixedSinceLastRun: diff.fixed,
                criteriaFirstRun: diff.firstRun,
            },
        };
    },
};
