// ============================================================
// live/ts-site-v2/monitor.ts —— 监控 Agent（9/13 分发令 §2/§3/§4 的执行体）
//
//   它是 hub-runner 的父进程：原样参数转发拉起子进程，自己只干三件事——
//   看（子进程日志 + Ledger 只读）、数（下列量化红线）、报（事实 verdict）。
//   **不修改 Developer / hub-runner / testAgentAdapter / 探针 / 验收规则 / 任务包**；
//   不自动换 bun/node、npm/bun、模型名或任何命令。
//
//   红线（任一命中 → 立即终止子进程，如实报 blocked，不重试）：
//     R1 连续 3 次 LLM 调用：无 write_audit、无任何工具事件（只有 llm_call_*）
//     R2 同一工具指纹 tool_call_reused 出现 ≥2 次（同码重复构建 = 空转铁证）
//     R3 timeout_extended ≥2 次（npm install/构建反复超时 → 归 ENV，模型不许重装修）
//     R4 LLM 完成数超过 maxLlmCalls（预算内进不了 test_request = 引擎失守，监控补刀）
//     R5 子日志出现"同一失败签名第 2 次"
//     R6 墙钟总时长 ≥ --max-minutes（默认 30）
//
//   成功判据（§5，唯一口径）：test_request 发出 + testAgent --verify 回了
//   test_passed（Ledger 里都有事件），Developer 的自述一个字都不算。
//
//   用法：
//     bun run .../monitor.ts --config .../P1A.json [--reset] [--project-dir <dir>] [--max-minutes 30]
//     （--config 之外的参数原样转发给 hub-runner；DEVELOPER_LLM_MODEL 由外层 shell 注入，本文件不碰）
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { DeveloperLedger } from "../../ledger";

const argv = process.argv.slice(2);
const argOf = (f: string): string | null => {
    const i = argv.indexOf(f);
    return i >= 0 ? (argv[i + 1] ?? null) : null;
};
const configPath = argOf("--config");
if (!configPath) { console.error("用法: monitor.ts --config <P1x.json> [--max-minutes 30] [其余参数转发 hub-runner]"); process.exit(2); }
const maxMinutes = Number(argOf("--max-minutes") ?? 30);
const CFG_FILE = path.resolve(configPath);
const cfg = JSON.parse(fs.readFileSync(CFG_FILE, "utf-8")) as { projectId: string; phase: number; maxLlmCalls?: number };
const taskId = `${cfg.projectId}-p${cfg.phase}`;
const runId = taskId;
const RUNS_ROOT = path.resolve(import.meta.dir, "..", "..", "..", "..", ".runs", "developer-local");
const LEDGER = path.join(RUNS_ROOT, "_ledger", `${runId}.db`);
const HUB_RUNNER = path.resolve(import.meta.dir, "..", "hub-runner.ts");
const logDir = path.join(RUNS_ROOT, "_logs");
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, `${runId}-monitor.log`);
const startedAt = Date.now();

const out = fs.createWriteStream(logFile, { flags: "w" });
const say = (line: string): void => {
    const s = `[monitor ${Math.round((Date.now() - startedAt) / 1000)}s] ${line}`;
    console.log(s); out.write(s + "\n");
};

// ---------- 拉起子进程（参数原样转发，一个不改） ----------

const childArgs: string[] = [];
for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--config") { childArgs.push(a, argv[++i]!); continue; }
    if (a === "--max-minutes") { i++; continue; } // 监控自己的参数
    childArgs.push(a);
}
const child = Bun.spawn([process.execPath, "run", HUB_RUNNER, ...childArgs], {
    stdout: "pipe", stderr: "pipe", env: { ...process.env }, cwd: path.resolve(HUB_RUNNER, "..", "..", ".."),
});
say(`子进程已拉起 pid=${child.pid} args=${childArgs.join(" ")}`);

const R5 = /同一失败签名第 2 次/;
const childBuf: string[] = [];
const drain = (stream: ReadableStream<Uint8Array> | null, tag: string): void => {
    if (!stream) return;
    let pending = "";
    void new Response(stream).body!.pipeTo(new WritableStream({
        write: (v: Uint8Array) => {
            pending += new TextDecoder().decode(v, { stream: true });
            const lines = pending.split(/\r?\n/); pending = lines.pop() ?? "";
            for (const l of lines) if (l.trim()) {
                childBuf.push(l);
                out.write(`  ${tag}| ${l}\n`);
                if (/止损|test_request|test_passed|test_failure|===== 结果|status=|运行报告|VERIFY|verify 进程/.test(l)) say(`${tag}| ${l}`);
                if (R5.test(l)) requestKill("R5 同一失败签名第 2 次出现");
            }
        },
    })).catch(() => { /* 子进程退出 */ });
};
drain(child.stdout as unknown as ReadableStream<Uint8Array>, "out");
drain(child.stderr as unknown as ReadableStream<Uint8Array>, "err");

// ---------- Ledger 只读巡检 ----------

let ledger: DeveloperLedger | null = null as DeveloperLedger | null;
let cursor = 0;                 // 已扫描事件数
const reuseCount = new Map<string, number>(); // R2：按指纹累计
const envFp = new Map<string, number>();      // R3：按命令指纹累计扩窗
let envTimeouts = 0;            // R3 总量
let killReason: string | null = null;

function openLedger(): void {
    if (ledger) return;
    try {
        if (!fs.existsSync(LEDGER)) return; // 子进程 --reset 还没重建
        ledger = DeveloperLedger.open(LEDGER, `${cfg.projectId}:${taskId}:${runId}`);
    } catch { /* 锁/未就绪，下一轮再试 */ }
}
function scanLedger(): void {
    openLedger();
    if (!ledger) return;
    let ev: { type: string; payload: unknown; at: number }[];
    try { ev = ledger.listEvents(); } catch { ledger = null; return; }
    for (; cursor < ev.length; cursor++) {
        const e = ev[cursor]!;
        // R1 已移交 hub-runner 内部实现（9/13 教训）：Ledger 里看不到决策原文，
        // 事件计数判"空转"必然误杀增量运行里的合法 done；hub-runner 的
        // 决策内容感知版（写盘/tool/done=进展，散文/解析失败=空转）是同一规则的严格正确版。
        if (e.type === "tool_call_reused") {
            const fp = String((e.payload as { fingerprint?: string }).fingerprint ?? "?");
            const n = (reuseCount.get(fp) ?? 0) + 1;
            reuseCount.set(fp, n);
            if (n >= 2) requestKill(`R2 同一工具指纹累计复用 ${n} 次（同码重复构建=空转铁证）`);
        }
        if (e.type === "timeout_extended") {
            const fp = String((e.payload as { fingerprint?: string }).fingerprint ?? "?");
            envTimeouts++;
            const n = (envFp.get(fp) ?? 0) + 1;
            envFp.set(fp, n);
            // 同一条命令（同指纹）扩窗 ≥2 = 装完一遍又超时第二遍 → 归 ENV 止损；
            // 单次慢安装的多次扩窗不误杀，但总量 ≥4 也停（预算保护）。
            if (n >= 2) requestKill(`R3 同一命令反复超时扩窗 ${n} 次——归类 ENV，模型不许重复安装/重建`);
            else if (envTimeouts >= 4) requestKill(`R3 超时扩窗总次数 ${envTimeouts} ≥4——归类 ENV 停止`);
        }
        if (e.type === "llm_call_completed" && cfg.maxLlmCalls && cursor >= 0) {
            const done = ev.slice(0, cursor + 1).filter((x) => x.type === "llm_call_completed").length;
            if (done > cfg.maxLlmCalls + 2) requestKill(`R4 LLM 完成 ${done} 次 > 预算 ${cfg.maxLlmCalls}（引擎闸失守，监控补刀）`);
        }
    }
}

function requestKill(reason: string): void {
    if (killReason) return;
    killReason = reason;
    say(`⛔ 止损：${reason} —— 终止子进程`);
    try { child.kill(); } catch { /* 已退 */ }
    setTimeout(() => { try { if (child.exitCode === null) child.kill(9); } catch { /* 已退 */ } }, 5_000).unref?.();
}
const wall = setInterval(() => {
    if ((Date.now() - startedAt) / 60_000 >= maxMinutes) requestKill(`R6 墙钟超 ${maxMinutes} 分钟`);
}, 5_000); wall.unref?.();
const tick = setInterval(() => { if (!killReason) scanLedger(); }, 1_500); tick.unref?.();

// ---------- 终局：事实 verdict（§5 唯一口径） ----------

const childExit = await child.exited;
clearInterval(wall); clearInterval(tick);
scanLedger();
openLedger();
let facts: Record<string, unknown> = { ledgerReadable: false };
const led: DeveloperLedger | null = ledger;
if (led) {
    try {
        const ev = led.listEvents();
        const types = (t: string) => ev.filter((e) => e.type === t).length;
        const outbound = ev.filter((e) => e.type === "outbound").map((e) => (e.payload as { type?: string }).type ?? "");
        const inboundTypes = ev.filter((e) => e.type === "inbound").map((e) => (e.payload as { type?: string }).type ?? "");
        facts = {
            ledgerReadable: true,
            llmCompleted: types("llm_call_completed"), writeAudits: types("write_audit"),
            testRequestSent: outbound.includes("test_request"),
            gotTestPassed: inboundTypes.includes("test_passed"),
            gotTestFailure: inboundTypes.includes("test_failure"),
            violations: led.listViolations(),
            checkpoint: led.latestCheckpoint(),
            readyEvent: outbound.includes("developer_ready"),
        };
        led.close();
    } catch (e) { facts.readError = (e as Error).message; }
}
interface Facts { testRequestSent?: boolean; gotTestPassed?: boolean; readyEvent?: boolean; [k: string]: unknown }
const f = facts as Facts;
const verdict = !killReason && f.testRequestSent && f.gotTestPassed && f.readyEvent
    ? "ready（外部 test_passed 为证）"
    : killReason ? `blocked（监控止损：${killReason}）`
        : childExit === 0 && f.testRequestSent && f.gotTestPassed ? "ready（外部 test_passed 为证）"
            : f.testRequestSent && !f.gotTestPassed ? `blocked（进了验收环但未拿到 test_passed，子退出码 ${childExit}）`
                : `blocked（未进入 test_request，子退出码 ${childExit}）`;
const summary = {
    runId, taskId, config: CFG_FILE, startedAt, durationMs: Date.now() - startedAt,
    childExitCode: childExit, killReason, facts, verdict,
};
console.log(JSON.stringify(summary, null, 2));
out.write("=== monitor summary ===\n" + JSON.stringify(summary, null, 2) + "\n");
out.end();
// 退出码：ready=0；一切 blocked/failed 非 0——不给上游任何"看起来成功"的错觉
process.exit(String(verdict).startsWith("ready") ? 0 : 1);
