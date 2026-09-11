// ============================================================
// ir-smoke.ts —— 验收 IR / 契约 IR 自测（零 LLM）
//
//   ① 谓词与 JSONPath：各 op 的正确/失败判定（失败必须给可读原因，不许静默通过）
//   ② 验收校验：纯自然语言被"隔离"而非报错；非法结构报错；id 重复报错
//   ③ 契约 → 可执行验收（$.code + 响应字段类型）
//   ④ 契约 → 前端请求桩（只 import 唯一封装路径）
//   ⑤ ★ 契约 → 可跑测试脚本：起一个真实本地 HTTP 服务，**把生成的脚本真跑一遍**
//      —— 通过时退出码 0，故意错配时期望退出码 1（证明它真在判定，不是摆设）
// ============================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { jsonPathGet, evaluatePredicate, evaluateJsonPath } from "./predicates";
import { validateAcceptance, judgeHttpAcceptance, type Acceptance } from "./acceptance";
import { validateContract, acceptanceFromContract, renderClientStub, renderAcceptanceRunner, renderContractDoc } from "./contract";
import { runCommand } from "../exec/run";
import { PROJECT_BASELINE } from "../../baseline";

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string): void {
    if (cond) { pass++; console.log(`  ✓ ${msg}`); }
    else { fail++; console.log(`  ✗ ${msg}`); }
}

console.log("=== ① 谓词与 JSONPath ===");
{
    const obj = { code: 1, data: { id: "a", name: "", tags: [{ k: 1 }] } };
    ok(jsonPathGet(obj, "$.data.id").value === "a", "$.data.id 取值");
    ok(jsonPathGet(obj, "data.tags[0].k").value === 1, "数组下标 + 省略 $. 取值");
    ok(jsonPathGet(obj, "$.data.missing").found === false, "不存在的字段 found=false");
    ok(evaluatePredicate(jsonPathGet(obj, "$.code"), { op: "equals", value: 1 }) === null, "equals 命中");
    ok((evaluatePredicate(jsonPathGet(obj, "$.code"), { op: "equals", value: 0 }) ?? "").includes("期望"), "equals 未命中给可读原因");
    ok(evaluatePredicate(jsonPathGet(obj, "$.data.missing"), { op: "exists" }) !== null, "exists 对缺失字段报错");
    ok(evaluatePredicate(jsonPathGet(obj, "$.data.name"), { op: "nonEmpty" }) !== null, "nonEmpty 对空串报错");
    ok(evaluatePredicate(jsonPathGet(obj, "$.data.tags"), { op: "type", value: "array" }) === null, "type=array 命中");
    ok((evaluatePredicate(jsonPathGet(obj, "$.data.id"), { op: "type", value: "number" }) ?? "").includes("实际 string"), "类型不符给出实际类型");
    ok(evaluatePredicate(jsonPathGet(obj, "$.code"), { op: "oneOf", values: [1, 2] }) === null, "oneOf 命中");
    ok(evaluateJsonPath(obj, { "$.code": { op: "equals", value: 1 }, "$.data.nope": { op: "exists" } }).length === 1, "批量断言只报失败项");
}

console.log("=== ② 验收校验 ===");
{
    const mixed = validateAcceptance([
        "用户可以登录",                                                    // 纯自然语言
        { kind: "http", id: "login", request: { method: "POST", path: "/api/auth/login" }, expect: { status: 200, jsonPath: { "$.code": { op: "equals", value: 1 } } } },
    ]);
    ok(mixed.ok && mixed.value.length === 1, "自然语言不阻断合法条目");
    ok(mixed.rejectedDisplayOnly.length === 1 && mixed.rejectedDisplayOnly[0]!.includes("用户可以登录"),
        "★ 纯自然语言被隔离并显式列出（既不假装验证了，也不整包拒收）");

    const bad = validateAcceptance([{ kind: "http", id: "x", request: { method: "GET", path: "/a" } }]);
    ok(!bad.ok && bad.errors.length > 0, "★ http 缺 expect → 规划期拒收（错误：" + bad.errors[0]!.slice(0, 60) + "）");

    const dup = validateAcceptance([
        { kind: "command", id: "same", run: "echo 1", expect: { exitCode: 0 } },
        { kind: "command", id: "same", run: "echo 2", expect: { exitCode: 0 } },
    ]);
    ok(!dup.ok && dup.errors.some(e => e.includes("重复")), "id 重复被拒");

    const none = validateAcceptance([]);
    ok(!none.ok, "空验收 = 不通过（0 条验收不能算绿）");

    const judge = judgeHttpAcceptance(
        { kind: "http", id: "j", request: { method: "GET", path: "/x" }, expect: { status: 200, jsonPath: { "$.data.id": { op: "nonEmpty" } } } },
        { status: 200, json: { data: { id: "1" } } });
    ok(judge.passed, "判定器：命中即通过");
    const judge2 = judgeHttpAcceptance(
        { kind: "http", id: "j", request: { method: "GET", path: "/x" }, expect: { status: 200 } },
        { status: 500, json: {} });
    ok(!judge2.passed && judge2.reason.includes("期望状态 200"), "判定器：状态不符给原因");
}

console.log("=== ③ 契约 → 可执行验收 ===");
{
    const c = validateContract({
        endpoints: [{ method: "post", path: "/auth/login", purpose: "登录",
            requestFields: [{ name: "username", type: "string", required: true }],
            responseFields: [{ name: "token", type: "string", required: true }, { name: "expiresIn", type: "number", required: true }] }],
    });
    ok(c.ok && c.value != null, "合法契约通过校验");

    const bad = validateContract({ endpoints: [
        { method: "get", path: "no-slash" },
        { method: "get", path: "/dup" }, { method: "GET", path: "/dup" }] });
    ok(!bad.ok && bad.errors.some(e => e.includes("必须以 / 开头")) && bad.errors.some(e => e.includes("重复")),
        "非法契约给两类错误：path 前缀、接口重复");

    const cases = acceptanceFromContract(c.value!, { apiPrefix: PROJECT_BASELINE.apiPrefix, successCode: PROJECT_BASELINE.response.successCode });
    ok(cases.length === 1, "每个接口生成一条验收");
    const http = cases[0] as Extract<typeof cases[number], { kind: "http" }>;
    ok(http.request.path === "/api/auth/login" && http.request.method === "POST", "前缀与 method 归一正确");
    ok(http.expect.jsonPath!["$.code"]!.op === "equals", "断言成功码");
    ok(http.expect.jsonPath!["$.data.token"]!.op === "type", "★ 响应字段生成 data 路径类型断言");

    const doc = renderContractDoc(c.value!);
    ok(doc.includes("/api/auth/login") && doc.includes("token"), "契约文档可读（人读用，不进判据）");

    const stub = renderClientStub(c.value!, PROJECT_BASELINE.frontend.requestPath);
    ok(stub.includes("from \"../utils/request\"") || stub.includes("utils/request"), "前端桩 import 唯一封装路径");
    ok(stub.includes("postauth_login") || stub.includes("export const post"), "桩函数按路径机械生成");
}

console.log("=== ⑤ 生成的契约测试脚本真跑一遍 ===");
{
    const port = 18080 + Math.floor(Math.random() * 200);
    const server = Bun.serve({
        port,
        fetch(req) {
            const url = new URL(req.url);
            if (url.pathname === "/api/auth/login") {
                return Response.json({ code: 1, msg: "ok", data: { token: "t-123", expiresIn: 3600 } });
            }
            return new Response("not found", { status: 404 });
        },
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cfir-"));
    const cases: Acceptance[] = [
        { kind: "http", id: "login-ok", request: { method: "POST", path: "/api/auth/login" },
          expect: { status: 200, jsonPath: { "$.code": { op: "equals", value: 1 }, "$.data.token": { op: "nonEmpty" }, "$.data.expiresIn": { op: "type", value: "number" } } } },
    ];
    const goodFile = path.join(dir, "contract-good.ts");
    fs.writeFileSync(goodFile, renderAcceptanceRunner(cases, "good"), "utf-8");
    const r1 = await runCommand(process.execPath === "" ? "bun" : (process.platform === "win32" ? "bun.exe" : "bun"), [goodFile], {
        cwd: dir, timeoutMs: 60_000, env: { BASE_URL: `http://127.0.0.1:${port}`, PATH: process.env.PATH ?? "" },
    });
    ok(r1.exitCode === 0 && r1.output.includes("[PASS] login-ok"), `★ 生成的脚本对真实服务判定通过（退出码 ${r1.exitCode}）`);

    // 故意错配：期望字段类型是 string，实际是 number → 必须退出码 1
    const badCases: Acceptance[] = [{
        kind: "http", id: "login-bad", request: { method: "POST", path: "/api/auth/login" },
        expect: { status: 200, jsonPath: { "$.data.expiresIn": { op: "type", value: "string" } } },
    }];
    const badFile = path.join(dir, "contract-bad.ts");
    fs.writeFileSync(badFile, renderAcceptanceRunner(badCases, "bad"), "utf-8");
    const r2 = await runCommand(process.platform === "win32" ? "bun.exe" : "bun", [badFile], {
        cwd: dir, timeoutMs: 60_000, env: { BASE_URL: `http://127.0.0.1:${port}`, PATH: process.env.PATH ?? "" },
    });
    ok(r2.exitCode === 1 && r2.output.includes("[FAIL] login-bad"), `★ 字段类型不符 → 退出码 1（实际 ${r2.exitCode}）：${r2.output.split(/\r?\n/).find(l => l.includes("[FAIL]")) ?? ""}`);

    // 404 路径：状态码不符也要判红
    const notFound: Acceptance[] = [{ kind: "http", id: "ghost", request: { method: "GET", path: "/api/nope" }, expect: { status: 200 } }];
    const nfFile = path.join(dir, "contract-nf.ts");
    fs.writeFileSync(nfFile, renderAcceptanceRunner(notFound, "nf"), "utf-8");
    const r3 = await runCommand(process.platform === "win32" ? "bun.exe" : "bun", [nfFile], {
        cwd: dir, timeoutMs: 60_000, env: { BASE_URL: `http://127.0.0.1:${port}`, PATH: process.env.PATH ?? "" },
    });
    ok(r3.exitCode === 1 && r3.output.includes("期望状态 200，实际 404"), "★ 状态码不符给出可读原因");

    server.stop(true);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败无妨 */ }
}

console.log(`\n[ir-smoke] 通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
