// ============================================================
// maven-compile-smoke.ts —— Maven 编译验证器自测（零 LLM）
//
//   ① 可编译夹具 → ok
//   ② 类型错夹具 → compile_error 且带 file:line 诊断
//   ③ 坏依赖夹具 → env_error（★ 必须与"代码坏了"分开，否则会把环境问题当返工烧钱）
//   ④ 真实回归：runs/p9/backend（F-3 现场）→ compile_error，诊断指向 SessionConfig.java
//      —— 这是把"我们发现过的真实缺陷"钉成回归用例；runs/ 不在版本库里时自动跳过
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { runMavenCompile, findMaven, makeFixtureDir, writeMinimalPom, compileFeedback, type MavenLauncher } from "./maven";

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string): void {
    if (cond) { pass++; console.log(`  ✓ ${msg}`); }
    else { fail++; console.log(`  ✗ ${msg}`); }
}
function note(msg: string): void { console.log(`  ~ ${msg}`); }

// ⚠️ 9/18 目录重构：引擎深了一层（agent/engine），本级到仓库根要退五级 + backend
const REPO_MVNW = path.resolve(import.meta.dir, "../../../../../backend/mvnw.cmd");
const LAUNCHER: MavenLauncher | null = fs.existsSync(REPO_MVNW)
    ? { exe: process.env.ComSpec || "cmd.exe", prefixArgs: ["/c", REPO_MVNW], label: "mvnw.cmd" }
    : findMaven(process.cwd());

if (!LAUNCHER) {
    console.log("[maven-compile-smoke] 找不到 mvnw/mvn：本机无法自测（未校验 ≠ 通过）");
    process.exit(0);
}
console.log(`[maven-compile-smoke] launcher=${LAUNCHER.label}`);

function writeJava(dir: string, rel: string, body: string): void {
    const p = path.join(dir, "src/main/java", rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body, "utf-8");   // UTF-8 无 BOM；含中文注释作为编码回归
}

// ---------- ① 可编译 ----------
console.log("=== ① 可编译夹具 ===");
{
    const dir = makeFixtureDir("ok");
    writeMinimalPom(dir);
    writeJava(dir, "com/cf/Good.java", `package com.cf;\n/** 中文注释：编码回归 */\npublic class Good { public int n() { return 1; } }\n`);
    const r = runMavenCompile({ projectDir: dir, offline: false, launcher: LAUNCHER, timeoutMs: 300_000, logDir: path.join(dir, "_verify") });
    ok(r.outcome === "ok", `好工程编译通过（${r.summary}）`);
    ok(r.diagnostics.length === 0, "无诊断");
    ok(r.logFile != null && fs.existsSync(r.logFile), "原始日志已留档（证据链）");
    fs.rmSync(dir, { recursive: true, force: true });
}

// ---------- ② 类型错（语法闸门抓不到、只有编译能抓） ----------
console.log("=== ② 类型错夹具（F-3 同类） ===");
{
    const dir = makeFixtureDir("bad");
    writeMinimalPom(dir);
    writeJava(dir, "com/cf/Bad.java",
        `package com.cf;\npublic class Bad {\n    public int n() {\n        String s = "x";\n        return s;\n    }\n}\n`);
    const r = runMavenCompile({ projectDir: dir, offline: false, launcher: LAUNCHER, timeoutMs: 300_000 });
    ok(r.outcome === "compile_error", `类型错被判编译失败（${r.summary}）`);
    ok(r.diagnostics.length > 0, `捕获 ${r.diagnostics.length} 处编译诊断`);
    ok(r.diagnostics.some(d => /Bad\.java$/.test(d.file) && d.line === 5), "诊断定位到 Bad.java:5");
    const fb = compileFeedback(r);
    ok(fb.length > 0 && fb[0]!.includes("Bad.java:5"), `自修反馈可读：${fb[0]}`);
    fs.rmSync(dir, { recursive: true, force: true });
}

// ---------- ③ 坏依赖 → ENV（不许误判成代码错） ----------
console.log("=== ③ 坏依赖夹具 ===");
{
    const dir = makeFixtureDir("env");
    writeMinimalPom(dir, `    <dependency><groupId>com.nonexistent.cf</groupId><artifactId>ghost-lib</artifactId><version>9.9.9</version></dependency>`);
    writeJava(dir, "com/cf/Ok.java", `package com.cf;\npublic class Ok {}\n`);
    const r = runMavenCompile({ projectDir: dir, offline: true, launcher: LAUNCHER, timeoutMs: 300_000 });
    ok(r.outcome === "env_error", `★ 坏依赖归 ENV 而非 COMPILE（${r.summary}）`);
    ok(r.envReasons.length > 0, `ENV 原因已记录：${(r.envReasons[0] ?? "").slice(0, 80)}`);
    ok(compileFeedback(r).length === 0, "ENV 类不进自修反馈（改代码解决不了缺依赖）");
    fs.rmSync(dir, { recursive: true, force: true });
}

// ---------- ④ 真实产物回归（F-3 现场） ----------
console.log("=== ④ 真实回归：runs/p9/backend（F-3） ===");
{
    const p9 = path.resolve(import.meta.dir, "../../../../../agent/runs/p9/backend");
    if (!fs.existsSync(path.join(p9, "pom.xml"))) {
        note(`跳过：${p9} 不存在（runs/ 不入版本库）`);
    } else {
        const r = runMavenCompile({ projectDir: p9, offline: true, launcher: LAUNCHER, timeoutMs: 600_000 });
        ok(r.outcome === "compile_error", `★ p9 产物编译失败被抓住（${r.summary}）`);
        ok(r.diagnostics.some(d => /SessionConfig\.java$/.test(d.file)), "诊断指向 SessionConfig.java（F-3 现场）");
        ok(r.diagnostics.length >= 3, `复现 ≥3 处诊断（实际 ${r.diagnostics.length}）`);
        const fb = compileFeedback(r);
        ok(fb.some(x => x.includes("SessionConfig.java:233") || x.includes("SessionConfig.java:237") || x.includes("SessionConfig.java:249")),
            `幻觉 API 定位到具体行：${fb.slice(0, 2).join(" | ")}`);
    }
}

console.log(`\n[maven-compile-smoke] 通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
