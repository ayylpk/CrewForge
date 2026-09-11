// ============================================================
// classify-smoke.ts —— 失败分类与分流自测（零 LLM）
//
//   ① 六类各自被正确识别（用**真实错误原文**当夹具）
//   ② 判定优先级：环境优先于编译（缺依赖时 Maven 走不到编译阶段）
//   ③ 无指纹不猜测（UNKNOWN + low confidence），不硬套某一类
//   ④ 分流去处与"可否原地重试"正确（SPEC/BUDGET 不可重试）
// ============================================================

import { classifyFailure, routeOf, diagnose } from "./classify";

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string): void {
    if (cond) { pass++; console.log(`  ✓ ${msg}`); }
    else { fail++; console.log(`  ✗ ${msg}`); }
}

console.log("=== ① 六类识别（真实原文夹具） ===");
{
    const compile = classifyFailure({
        outcome: "compile_error",
        output: "[ERROR] COMPILATION ERROR :\n[ERROR] /x/SessionConfig.java:[233,51] constructor JdbcIndexedSessionRepository cannot be applied to given types;",
    });
    ok(compile.cls === "COMPILE" && compile.confidence === "high", `F-3 现场归 COMPILE（原因：${compile.reasons[0]}）`);

    const env = classifyFailure({
        outcome: "env_error",
        output: "[ERROR] Could not resolve dependencies for project x: Cannot access central (https://repo.maven.apache.org/maven2) in offline mode",
    });
    ok(env.cls === "ENV" && env.reasons.some(r => r.includes("依赖")), `缺依赖归 ENV（${env.reasons[0]}）`);

    const contract = classifyFailure({ outcome: "failed", output: "[FAIL] login -> POST /api/auth/login 期望状态 200，实际 404" });
    ok(contract.cls === "CONTRACT", `状态码不符归 CONTRACT（${contract.reasons[0]}）`);

    const contract2 = classifyFailure({ outcome: "failed", output: "[FAIL] login -> $.data.expiresIn：期望类型 string，实际 number" });
    ok(contract2.cls === "CONTRACT", `字段类型不符归 CONTRACT`);

    const test = classifyFailure({ outcome: "failed", output: "Tests run: 5, Failures: 2, Errors: 0\nFAILED" });
    ok(test.cls === "TEST", `单测失败归 TEST（${test.reasons[0]}）`);

    const spec = classifyFailure({ outcome: "failed", openQuestions: ["是否需要短信验证码登录？"] });
    ok(spec.cls === "SPEC" && spec.confidence === "high", "未决需求问题归 SPEC（机器无法裁定）");

    const budget = classifyFailure({ outcome: "failed", budgetExceeded: true });
    ok(budget.cls === "BUDGET", "预算超限归 BUDGET");

    const tool = classifyFailure({ outcome: "tool_error", exitCode: -1, tool: "mvn" });
    ok(tool.cls === "ENV", "工具级错误归 ENV（不是代码错）");
}

console.log("=== ② 优先级：环境优先于编译 ===");
{
    const mixed = classifyFailure({
        outcome: "compile_error",
        output: "Could not resolve dependencies for project x\n[ERROR] COMPILATION ERROR :\n[ERROR] /a/B.java:[1,1] cannot find symbol",
    });
    ok(mixed.cls === "ENV", "★ 同时含两类关键词时归 ENV（缺依赖时编译阶段根本没意义）");
}

console.log("=== ③ 无指纹不猜测 ===");
{
    const unknown = classifyFailure({ outcome: "failed", output: "something nobody predicted" });
    ok(unknown.cls === "UNKNOWN" && unknown.confidence === "low", "无指纹 → UNKNOWN + low（不硬套）");
    ok(unknown.reasons[0]!.includes("不猜测"), "理由写明不猜测");
    const empty = classifyFailure({ outcome: "failed" });
    ok(empty.cls === "UNKNOWN", "空证据 → UNKNOWN");
}

console.log("=== ④ 分流去处 ===");
{
    ok(routeOf("COMPILE").target === "implementer" && routeOf("COMPILE").retryable, "COMPILE → 实现器（可重试）");
    ok(routeOf("CONTRACT").target === "planner", "CONTRACT → 规划器");
    ok(routeOf("TEST").target === "implementer", "TEST → 实现器");
    ok(routeOf("ENV").target === "environment", "ENV → 环境恢复");
    ok(routeOf("SPEC").target === "user" && !routeOf("SPEC").retryable, "★ SPEC → 用户且不可原地重试");
    ok(routeOf("BUDGET").target === "stop" && !routeOf("BUDGET").retryable, "★ BUDGET → 停且不可重试");
    ok(routeOf("COMPILE").action.includes("必须重跑验证"), "★ COMPILE 分流话术含『必须重跑验证』");

    const d = diagnose({ outcome: "compile_error", output: "error TS2322: Type 'string' is not assignable to type 'number'" });
    ok(d.cls === "COMPILE" && d.route.target === "implementer", "diagnose 一步给出分类+分流");
}

console.log(`\n[classify-smoke] 通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
