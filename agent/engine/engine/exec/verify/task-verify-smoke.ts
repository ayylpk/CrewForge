// ============================================================
// task-verify-smoke.ts —— 任务级执行式验证 + 失败账本自测（零 LLM）
//
//   ① 失败账本：签名归一（行号漂移不改变签名）、同修法重复即升级、不同修法不升级
//   ② 未验证 ≠ 通过：无验证器栈 / 无产物 / 无依赖 一律 checked=false
//   ③ 编译真机：好工程 ok、类型错 compile_error 且带 file:line、坏依赖 env_error（且不进自修反馈）
//   ④ 真实回归：runs/p9 → compile_error（F-3 现场，锁死"幻觉 API 必须被抓住"）
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { verifyWrittenTask } from "./taskVerify";
import { FailureLedger, signatureOf } from "./ledger";
import { makeFixtureDir, writeMinimalPom } from "./maven";
import { SPRING_VUE, GENERIC_STACK } from "../../stacks/profile";

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string): void {
    if (cond) { pass++; console.log(`  ✓ ${msg}`); }
    else { fail++; console.log(`  ✗ ${msg}`); }
}
function note(msg: string): void { console.log(`  ~ ${msg}`); }

// ⚠️ 9/18 目录重构：引擎深了一层（agent/engine），本级到仓库根要退五级 + backend
const REPO_MVNW = path.resolve(import.meta.dir, "../../../../../backend/mvnw.cmd");
const MVNW = fs.existsSync(REPO_MVNW) ? REPO_MVNW : null;

function writeJava(root: string, rel: string, body: string): void {
    const p = path.join(root, "backend/src/main/java", rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body, "utf-8");
}

// ---------- ① 失败账本 ----------
console.log("=== ① 失败账本 ===");
{
    const d1 = [{ file: "C:/x/SessionConfig.java", line: 233, message: "constructor cannot be applied to given types" }];
    const d2 = [{ file: "C:/x/SessionConfig.java", line: 251, message: "constructor cannot be applied to given types" }];
    ok(signatureOf("compile", d1) === signatureOf("compile", d2), "★ 行号漂移不改变签名（同一处错仍归一）");
    const d3 = [{ file: "C:/x/Other.java", line: 233, message: "constructor cannot be applied to given types" }];
    ok(signatureOf("compile", d1) !== signatureOf("compile", d3), "换文件即换签名（不误升级）");

    const led = new FailureLedger();
    const r1 = led.record("sig-A", "compile_repair", "compile", "缺分号");
    ok(r1.attempts === 1 && !r1.shouldEscalate, "首次记录不升级");
    const r2 = led.record("sig-A", "compile_repair", "compile", "缺分号");
    ok(r2.attempts === 2 && r2.shouldEscalate, "★ 同一签名 + 同一修法第二次出现 → 升级（禁止原地重复）");
    ok((r2.reason ?? "").includes("换策略"), `升级原因可读：${r2.reason}`);
    const led2 = new FailureLedger();
    led2.record("sig-B", "compile_repair");
    const alt = led2.record("sig-B", "task_shrink");
    ok(!alt.shouldEscalate, "换了修法 → 不升级（允许换策略再试一次）");
    ok(led2.snapshot()[0]!.fixKinds.length === 2, "已用修法被记录");
}

// ---------- ② 未验证 ≠ 通过 ----------
console.log("=== ② 未验证 ≠ 通过 ===");
{
    const dir = makeFixtureDir("unverified");
    const r = await verifyWrittenTask({ projectDir: dir, layer: "backend", profile: GENERIC_STACK, mvnwPath: MVNW });
    ok(r.outcome === "skipped_unverified" && r.checked === false, `★ 无验证器栈 → skipped_unverified（${r.summary}）`);
    ok(r.signature === "" && r.feedback.length === 0, "未验证不产生失败签名/反馈");

    const r2 = await verifyWrittenTask({ projectDir: dir, layer: "backend", profile: SPRING_VUE, mvnwPath: MVNW });
    ok(r2.outcome === "skipped_unverified" && !r2.checked, "有验证器但无 pom.xml → 仍标未验证（不假装跑过）");

    const r3 = await verifyWrittenTask({ projectDir: dir, layer: "frontend", profile: SPRING_VUE, mvnwPath: MVNW });
    ok(r3.outcome === "skipped_unverified", "前端无 package.json → 未验证");
    fs.rmSync(dir, { recursive: true, force: true });
}

// ---------- ③ 编译真机 ----------
console.log("=== ③ 编译真机 ===");
if (!MVNW) {
    note("找不到 mvnw：跳过真机用例（未校验 ≠ 通过）");
} else {
    const good = makeFixtureDir("tv-ok");
    writeMinimalPom(path.join(good, "backend"));
    writeJava(good, "com/cf/Good.java", `package com.cf;\n/** 中文注释 */\npublic class Good { public int n() { return 1; } }\n`);
    const rGood = await verifyWrittenTask({ projectDir: good, layer: "backend", profile: SPRING_VUE, mvnwPath: MVNW, timeoutMs: 300_000 });
    ok(rGood.outcome === "ok" && rGood.checked, `好工程编译通过（${rGood.summary}）`);
    ok(rGood.logFile != null && fs.existsSync(rGood.logFile), "证据日志已留档");
    fs.rmSync(good, { recursive: true, force: true });

    const bad = makeFixtureDir("tv-bad");
    writeMinimalPom(path.join(bad, "backend"));
    writeJava(bad, "com/cf/Bad.java", `package com.cf;\npublic class Bad {\n    public int n() {\n        String s = "x";\n        return s;\n    }\n}\n`);
    const rBad = await verifyWrittenTask({ projectDir: bad, layer: "backend", profile: SPRING_VUE, mvnwPath: MVNW, timeoutMs: 300_000 });
    ok(rBad.outcome === "compile_error", `类型错判编译失败（${rBad.summary}）`);
    ok(rBad.feedback.some(f => f.includes("Bad.java:5")), `自修反馈可定位：${rBad.feedback[0]}`);
    ok(rBad.signature.length > 0, "产生失败签名（供账本去重）");
    fs.rmSync(bad, { recursive: true, force: true });

    const env = makeFixtureDir("tv-env");
    writeMinimalPom(path.join(env, "backend"), `    <dependency><groupId>com.nonexistent.cf</groupId><artifactId>ghost</artifactId><version>9.9.9</version></dependency>`);
    writeJava(env, "com/cf/Ok.java", `package com.cf;\npublic class Ok {}\n`);
    const rEnv = await verifyWrittenTask({ projectDir: env, layer: "backend", profile: SPRING_VUE, mvnwPath: MVNW, allowNetwork: false, timeoutMs: 300_000 });
    ok(rEnv.outcome === "env_error", `★ 缺依赖归 ENV（${rEnv.summary}）`);
    ok(rEnv.feedback.length === 0, "★ ENV 不进自修反馈（改代码解决不了缺依赖）");
    ok(rEnv.signature === "", "ENV 不产生「代码错」签名（不会污染账本）");
    fs.rmSync(env, { recursive: true, force: true });
}

// ---------- ④ 真实回归：F-3 现场 ----------
console.log("=== ④ 真实回归：runs/p9（F-3） ===");
{
    const p9 = path.resolve(import.meta.dir, "../../../../../agent/runs/p9");
    if (!fs.existsSync(path.join(p9, "backend", "pom.xml"))) {
        note("跳过：runs/p9 不存在（runs/ 不入版本库）");
    } else {
        const r = await verifyWrittenTask({ projectDir: p9, layer: "backend", profile: SPRING_VUE, mvnwPath: MVNW, timeoutMs: 600_000 });
        ok(r.outcome === "compile_error", `★ p9 产物编译失败被抓住（${r.summary}）`);
        ok(r.feedback.some(f => f.includes("SessionConfig.java")), `幻觉 API 被定位：${r.feedback[0]}`);
        ok(r.signature.includes("sessionconfig.java"), "签名含文件名（可去重/可升级）");
    }
}

console.log(`\n[task-verify-smoke] 通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
