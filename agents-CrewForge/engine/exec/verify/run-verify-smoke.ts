// ============================================================
// run-verify-smoke.ts —— run 级验证编排自测（零 LLM）
//
//   ① Docker 不可用 → skipped_unverified（★ 未验证 ≠ 通过），绝不假装跑过
//   ② 无验证器栈 → skipped_unverified
//   ③ 数据库容器起不来 → env_error（环境问题，不是代码错）
//   ④ ★ 真机穿过一遍：起真实 HTTP 服务 → 健康检查 → 契约测试通过 → 结论 ok
//   ⑤ 契约失败 → contract_failed 且失败原因可读
//   ⑥ 健康检查不过 → boot_failed（有界超时，不挂死）
//   ⑦ ★ 清理：无论成败 finally 都要回收（容器 rm + 进程树杀）
// ============================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyRun, renderRunVerifyReport } from "./runVerify";
import type { DockerRunner } from "./docker";
import type { RunResult } from "../run";
import { runCommand } from "../run";
import { SPRING_VUE, GENERIC_STACK } from "../../stacks/profile";
import type { Acceptance } from "../../ir/acceptance";

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string): void {
    if (cond) { pass++; console.log(`  ✓ ${msg}`); }
    else { fail++; console.log(`  ✗ ${msg}`); }
}
function fakeResult(exitCode: number, output = ""): RunResult {
    return { cmd: "docker", exitCode, output, durationMs: 1, timedOut: false, logFile: null };
}
/** 假 docker：version 成功、run 成功、rm 记录在案 */
function fakeDocker(opts: { runOk?: boolean } = {}): { runner: DockerRunner; calls: string[][] } {
    const calls: string[][] = [];
    const runner: DockerRunner = async (args) => {
        calls.push(args);
        if (args[0] === "version") return fakeResult(0, "27.0.0");
        if (args[0] === "run") return opts.runOk === false ? fakeResult(1, "port is already allocated") : fakeResult(0, "abc123");
        return fakeResult(0);
    };
    return { runner, calls };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cfrunverify-"));
const CASES_OK: Acceptance[] = [{ kind: "http", id: "ping", request: { method: "GET", path: "/api/ping" }, expect: { status: 200, jsonPath: { "$.code": { op: "equals", value: 1 } } } }];
const CASES_BAD: Acceptance[] = [{ kind: "http", id: "ping", request: { method: "GET", path: "/api/ping" }, expect: { status: 200, jsonPath: { "$.data.n": { op: "type", value: "string" } } } }];

console.log("=== ①/② 未验证路径 ===");
{
    const r1 = await verifyRun({ projectDir: tmp, profile: GENERIC_STACK, cases: CASES_OK, skipDatabase: true });
    ok(r1.outcome === "skipped_unverified" && !r1.checked, `无验证器栈 → skipped_unverified（${r1.summary}）`);

    const noDocker: DockerRunner = async () => fakeResult(1, "cannot connect to the docker API");
    const r2 = await verifyRun({ projectDir: tmp, profile: SPRING_VUE, cases: CASES_OK, docker: noDocker });
    ok(r2.outcome === "skipped_unverified" && !r2.checked, `★ Docker 不可用 → skipped_unverified（${r2.summary}）`);
    ok(r2.cleaned, "未验证路径也标记已清理");
}

console.log("=== ③ 数据库起不来 ===");
{
    const { runner, calls } = fakeDocker({ runOk: false });
    const r = await verifyRun({ projectDir: tmp, profile: SPRING_VUE, cases: CASES_OK, docker: runner, logDir: path.join(tmp, "_v3") });
    ok(r.outcome === "env_error" && r.checked, `数据库起不来 → env_error（${r.summary}）`);
    ok(r.failures.some(f => f.includes("数据库容器")), `失败原因指向数据库：${r.failures[0]}`);
    ok(calls.some(a => a[0] === "version"), "★ 未跳过 DB 时先探 Docker server 可用性");
    ok(calls.some(a => a[0] === "rm"), "★ 失败也要 rm 容器（finally 必清理）");
    ok(r.cleaned, "★ cleaned 只在清理真正完成后才为 true（早退路径不再撒谎）");
}

console.log("=== ④ 真机穿过一遍（跳过 DB，起真实服务） ===");
{
    const port = 22100 + Math.floor(Math.random() * 300);
    let server: any = null;
    const { runner, calls } = fakeDocker();
    const r = await verifyRun({
        projectDir: tmp, profile: SPRING_VUE, cases: CASES_OK, docker: runner, skipDatabase: true,
        appPort: port, bootTimeoutMs: 20_000, logDir: path.join(tmp, "_v4"),
        startApp: async () => {
            server = Bun.serve({ port, fetch: () => Response.json({ code: 1, msg: "ok", data: { n: 1 } }) });
            return { cmd: `fake-app:${port}`, logFile: null, started: true };
        },
    });
    ok(r.outcome === "ok" && r.checked, `★ run 级验证通过（${r.summary}）`);
    ok(r.evidence.some(e => e.step === "health" && e.ok), "证据链含健康检查通过");
    ok(r.evidence.some(e => e.step === "contract" && e.ok), "证据链含契约测试通过");
    ok(r.contract?.total === 1, "契约用例数正确");
    const report = renderRunVerifyReport(r);
    ok(report.includes("结论：ok") && report.includes("证据链"), "报告可读（含结论与证据链）");
    server?.stop(true);

    // ⑤ 契约失败
    const port5 = port + 1;
    const r5 = await verifyRun({
        projectDir: tmp, profile: SPRING_VUE, cases: CASES_BAD, docker: runner, skipDatabase: true,
        appPort: port5, bootTimeoutMs: 20_000, logDir: path.join(tmp, "_v5"),
        startApp: async () => { server = Bun.serve({ port: port5, fetch: () => Response.json({ code: 1, data: { n: 1 } }) }); return { cmd: "fake", logFile: null, started: true }; },
    });
    ok(r5.outcome === "contract_failed" && r5.failures.length > 0, `契约失败 → contract_failed（${r5.summary}）`);
    ok((r5.failures[0] ?? "").includes("n"), `失败原因可读：${r5.failures[0]?.slice(0, 80)}`);
    server?.stop(true);
    ok(calls.length === 0, "★ 跳过 DB 时不打扰 Docker（不需要容器就不误报环境问题）");
}

console.log("=== ⑥ 健康检查不过（有界超时） ===");
{
    const port = 22800 + Math.floor(Math.random() * 200);
    const t0 = Date.now();
    const r = await verifyRun({
        projectDir: tmp, profile: SPRING_VUE, cases: CASES_OK, skipDatabase: true,
        appPort: port, bootTimeoutMs: 4_000, logDir: path.join(tmp, "_v6"),
        startApp: async () => ({ cmd: "fake-no-listen", logFile: null, started: true }),
    });
    ok(r.outcome === "boot_failed", `健康检查不过 → boot_failed（${r.summary}）`);
    ok(Date.now() - t0 < 30_000, `超时有界（${Math.round((Date.now() - t0) / 1000)}s）`);
    ok(r.cleaned, "★ 失败路径也完成清理");
    ok(renderRunVerifyReport(r).includes("清理：已完成"), "报告标明清理状态");
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败无妨 */ }
console.log(`\n[run-verify-smoke] 通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
