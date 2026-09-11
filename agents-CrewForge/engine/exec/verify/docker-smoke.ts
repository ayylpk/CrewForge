// ============================================================
// docker-smoke.ts —— 容器底座与 HTTP 契约执行自测（零 LLM）
//
//   ① 参数构造：端口/命名/环境变量按 runId 隔离
//   ② ★ finally 必清理：启动失败也必须 stopContainer（防容器泄漏）
//   ③ waitForHttp 真机：对真实本地服务判"已起"，对空端口判"超时未起"
//   ④ ★ 契约执行真机：起一个真实 HTTP 服务 → 跑引擎生成的脚本 → 通过/失败都能正确归因
//      （失败时必须是 outcome=failed 且带可读 failures，而不是含混的 tool_error）
// ============================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    mysqlRunArgs, startMysql, stopContainer, waitForHttp, runContractTests, parseContractOutput,
    type DockerRunner, type MysqlSpec,
} from "./docker";
import type { Acceptance } from "../../ir/acceptance";
import type { RunResult } from "../run";

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string): void {
    if (cond) { pass++; console.log(`  ✓ ${msg}`); }
    else { fail++; console.log(`  ✗ ${msg}`); }
}
function fakeResult(exitCode: number, output = ""): RunResult {
    return { cmd: "docker", exitCode, output, durationMs: 1, timedOut: false, logFile: null };
}

console.log("=== ① MySQL 参数构造（隔离）===");
{
    const spec: MysqlSpec = { name: "cf-mysql-run42", port: 13306, database: "app", user: "app", password: "pw" };
    const args = mysqlRunArgs(spec);
    const joined = args.join(" ");
    ok(joined.includes("--name cf-mysql-run42"), "容器名带 runId（互不冲突）");
    ok(joined.includes("127.0.0.1:13306:3306"), "端口只绑本机且按 run 分配");
    ok(joined.includes("MYSQL_DATABASE=app") && joined.includes("MYSQL_ROOT_PASSWORD=pw"), "库名/口令注入");
    ok(args.includes("--rm"), "自带 --rm（异常退出也不留容器）");
}

console.log("=== ② finally 必清理 ===");
{
    const calls: string[][] = [];
    const runner: DockerRunner = async (args) => { calls.push(args); return fakeResult(args[0] === "run" ? 1 : 0, "port is already allocated"); };
    let cleaned = false;
    try {
        const r = await startMysql({ name: "cf-x", port: 13307, database: "d", user: "u", password: "p" }, runner);
        ok(!r.ok && (r.error ?? "").includes("already allocated"), "启动失败返回可读错误（归 ENV，不是代码错）");
    } finally {
        await stopContainer("cf-x", runner);
        cleaned = true;
    }
    ok(cleaned && calls.some(a => a[0] === "rm" && a.includes("cf-x")), "★ 启动失败仍执行 rm -f（不留容器）");

    const okCalls: string[][] = [];
    const okRunner: DockerRunner = async (args) => { okCalls.push(args); return fakeResult(0, "abc123"); };
    const r2 = await startMysql({ name: "cf-y", port: 13308, database: "d", user: "u", password: "p" }, okRunner);
    ok(r2.ok && r2.container === "cf-y", "启动成功返回容器名");
    ok(!okCalls[0]!.includes("-v"), "不挂宿主卷（避免污染与残留）");
}

console.log("=== ③ 健康检查真机 ===");
{
    const port = 19100 + Math.floor(Math.random() * 300);
    const server = Bun.serve({ port, fetch: () => Response.json({ ok: true }) });
    const up = await waitForHttp(`http://127.0.0.1:${port}/health`, { timeoutMs: 15_000, intervalMs: 300 });
    ok(up.ok && up.status === 200, `服务已起被识别（尝试 ${up.attempts} 次，${up.durationMs}ms）`);
    server.stop(true);

    const downPort = port + 5000;
    const t0 = Date.now();
    const down = await waitForHttp(`http://127.0.0.1:${downPort}/health`, { timeoutMs: 3_000, intervalMs: 500 });
    ok(!down.ok, "★ 空端口如实判「未起来」（不假装成功）");
    ok(Date.now() - t0 < 15_000, "超时有界（不会挂死）");
}

console.log("=== ④ 契约执行真机 ===");
{
    const port = 19400 + Math.floor(Math.random() * 300);
    const server = Bun.serve({
        port,
        fetch(req) {
            const u = new URL(req.url);
            if (u.pathname === "/api/auth/login") return Response.json({ code: 1, msg: "ok", data: { token: "t1", expiresIn: 3600 } });
            return new Response("nf", { status: 404 });
        },
    });
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfdocker-"));
    const good: Acceptance[] = [{ kind: "http", id: "login", request: { method: "POST", path: "/api/auth/login" },
        expect: { status: 200, jsonPath: { "$.code": { op: "equals", value: 1 }, "$.data.token": { op: "nonEmpty" } } } }];
    const rOk = await runContractTests({ projectDir, cases: good, baseUrl: `http://127.0.0.1:${port}` });
    ok(rOk.outcome === "ok" && rOk.total === 1, `★ 契约测试通过（${rOk.total} 例，${rOk.durationMs}ms）`);
    ok(rOk.logFile != null && fs.existsSync(rOk.logFile), "脚本与原始输出留档到 _verify/");

    const bad: Acceptance[] = [{ kind: "http", id: "bad-field", request: { method: "POST", path: "/api/auth/login" },
        expect: { status: 200, jsonPath: { "$.data.expiresIn": { op: "type", value: "string" } } } }];
    const rBad = await runContractTests({ projectDir, cases: bad, baseUrl: `http://127.0.0.1:${port}` });
    ok(rBad.outcome === "failed" && rBad.failed === 1, `★ 断言失败归 failed（不是 tool_error），失败 ${rBad.failed}/${rBad.total}`);
    ok((rBad.failures[0] ?? "").includes("expiresIn"), `失败原因可读：${rBad.failures[0]}`);

    const unreachable: Acceptance[] = [{ kind: "http", id: "down", request: { method: "GET", path: "/api/x" }, expect: { status: 200 } }];
    const rDown = await runContractTests({ projectDir, cases: unreachable, baseUrl: `http://127.0.0.1:${port + 5000}` });
    ok(rDown.outcome === "failed" && (rDown.failures[0] ?? "").includes("请求失败"), "服务不可达时给出「请求失败」原因（可分流到 ENV）");

    const parsed = parseContractOutput("[PASS] a\n[FAIL] b -> x\n\n契约测试：失败 1 / 共 2");
    ok(parsed.total === 2 && parsed.failed === 1 && parsed.failures.length === 1, "输出解析：总数/失败数/原因");

    server.stop(true);
    try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* 清理失败无妨 */ }
}

console.log(`\n[docker-smoke] 通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
