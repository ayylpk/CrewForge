// ============================================================
// scorecard-smoke.ts —— 评分卡与 Java 诊断分类器冒烟（零 LLM）
//
//   覆盖：
//     ① 诊断分类：语法/依赖/编码/未归类 四类判定
//     ② syntaxClean 语义：仅依赖类诊断 → 干净；未归类 → 不干净
//     ③ 评分卡三态：未校验必须是 null（≠ 通过）—— M0 F-1 假绿教训的回归测试
//     ④ javac 真机集成：好码零误杀、坏码必拒、缺依赖不误判成语法错
// ============================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyJavaDiagnostic, parseJavaDiagnostics, summarizeJavaDiagnostics } from "../engine/exec/static/javaDiagnostics";
import { checkJavaFiles, javacAvailable } from "../engine/exec/static/java";
import { scoreSnapshot, summarizeScoreCard, type RunSnapshot } from "./scorecard";

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string): void {
    if (cond) { pass++; console.log(`  ✓ ${msg}`); }
    else { fail++; console.log(`  ✗ ${msg}`); }
}
function eq<T>(actual: T, expected: T, msg: string): void {
    ok(actual === expected, `${msg}（期望 ${String(expected)}，实际 ${String(actual)}）`);
}

// ---------- ① 分类器 ----------
console.log("=== ① 诊断分类 ===");
eq(classifyJavaDiagnostic("/a/B.java:3: error: ';' expected")?.kind, "syntax", "缺分号 → syntax");
eq(classifyJavaDiagnostic("/a/B.java:9: error: reached end of file while parsing")?.kind, "syntax", "文件截断 → syntax");
eq(classifyJavaDiagnostic("/a/B.java:1: error: package org.springframework does not exist")?.kind, "dependency", "缺包 → dependency");
eq(classifyJavaDiagnostic("/a/B.java:12: error: cannot find symbol")?.kind, "dependency", "找不到符号 → dependency");
eq(classifyJavaDiagnostic("/a/B.java:4: error: unmappable character (0x80) for encoding GBK")?.kind, "encoding", "★ 编码错 → encoding（绝不忽略）");
eq(classifyJavaDiagnostic("/a/B.java:5: error: something nobody predicted")?.kind, "other", "★ 未识别 → other（默认计入，不放行）");
eq(classifyJavaDiagnostic("warning: unchecked cast"), null, "warning 不参与判定");
eq(classifyJavaDiagnostic("/a/B.java:3: error: ';' expected")?.line, 3, "行号解析正确");

// ---------- ② syntaxClean 语义 ----------
console.log("=== ② syntaxClean 语义 ===");
const depOnly = parseJavaDiagnostics(
    "/a/B.java:1: error: package org.springframework.stereotype does not exist\n/a/B.java:3: error: cannot find symbol\n", 1);
ok(depOnly.syntaxClean, "仅依赖类诊断 → syntaxClean=true（缺 classpath 属常态）");
eq(depOnly.dependency.length, 2, "依赖诊断计数");
const withUnmappable = parseJavaDiagnostics("/a/B.java:4: error: unmappable character (0x80) for encoding GBK\n", 1);
ok(!withUnmappable.syntaxClean, "★ 编码错 → syntaxClean=false");
const withOther = parseJavaDiagnostics("/a/B.java:7: error: something nobody predicted\n", 1);
ok(!withOther.syntaxClean, "★ 未归类 → syntaxClean=false（白名单忽略纪律）");

// ---------- ③ 评分卡三态 ----------
console.log("=== ③ 评分卡三态（未校验 ≠ 通过）===");
function snapshot(over: Partial<RunSnapshot> = {}): RunSnapshot {
    const req = ["frontend/index.html", "frontend/src/main.ts", "frontend/src/App.vue", "frontend/src/router/index.ts"];
    return {
        runId: "fx", dir: "/fx", fileCount: 10, byExt: { ".java": 3 },
        entryFiles: req.map(p => ({ path: p, present: true })),
        indexHtmlScript: "/src/main.ts",
        testReports: 1, taskEvidence: 0,
        hasContracts: true, contractsChars: 100,
        frontendNodeModules: true,
        java: {
            fileCount: 3, checked: true,
            report: { exitCode: 1, syntax: [], dependency: [{ kind: "dependency", file: "A.java", line: 1, message: "package x does not exist", raw: "" }], encoding: [], other: [], syntaxClean: true },
            summary: "exit=1 语法=0 编码=0 依赖/类型=1 未归类=0",
        },
        ...over,
    };
}
const clean = scoreSnapshot(snapshot());
eq(clean.fail, 0, "干净夹具 → 零失败项");
ok(clean.pass >= 6, `干净夹具 → 通过项 ≥6（实际 ${clean.pass}）`);
ok(!clean.items.some(i => i.ok === false), "干净夹具无红项");

const missingMain = scoreSnapshot(snapshot({ entryFiles: snapshot().entryFiles.map(e => e.path.endsWith("main.ts") ? { ...e, present: false } : e) }));
ok(missingMain.fail >= 1, "缺 main.ts → 有红项");
ok(missingMain.items.some(i => i.key === "entry:frontend/src/main.ts" && i.ok === false), "缺 main.ts 精确命中");

const noJavac = scoreSnapshot(snapshot({ java: { fileCount: 3, checked: false, toolError: "javac not found", summary: "未校验" } }));
ok(noJavac.items.some(i => i.key === "java:syntax" && i.ok === null), "★ javac 不可用 → java:syntax 记 null（未判定）");
ok(!noJavac.items.some(i => i.key === "java:syntax" && i.ok === true), "★ 未校验绝不算通过");

const unclassified = scoreSnapshot(snapshot({ java: { fileCount: 1, checked: true, report: { exitCode: 1, syntax: [], dependency: [], encoding: [], other: [{ kind: "other", file: "A.java", line: 2, message: "something nobody predicted", raw: "" }], syntaxClean: false }, summary: "未归类=1" } }));
ok(unclassified.items.some(i => i.key === "java:unclassified" && i.ok === false), "★ 未归类诊断 → 红项");

const noReports = scoreSnapshot(snapshot({ testReports: 0 }));
ok(noReports.items.some(i => i.key === "evidence:testReports" && i.ok === false), "无测试留档 → 红项");

const noContracts = scoreSnapshot(snapshot({ hasContracts: false }));
ok(noContracts.items.some(i => i.key === "contract:present" && i.ok === false), "无契约 → 红项");

ok(summarizeScoreCard(clean).includes("通过="), "摘要可读");
ok(summarizeJavaDiagnostics(depOnly).includes("依赖/类型=2"), "Java 摘要含分类计数");

// ---------- ④ javac 真机集成（自带夹具，不涉团队产出） ----------
console.log("=== ④ javac 真机集成 ===");
if (!javacAvailable()) {
    console.log("  ~ 本机无 javac：跳过真机用例（未校验 ≠ 通过）");
} else {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cfscorecard-"));
    const enc = new TextEncoder();
    const write = (name: string, body: string) => {
        const p = path.join(tmp, name);
        fs.writeFileSync(p, enc.encode(body));   // 无 BOM，UTF-8
        return p;
    };
    const good = write("Good.java", `package com.demo;\nimport java.util.List;\npublic class Good { public int n(List<String> l){ return l.size(); } }\n`);
    const bad = write("Bad.java", `package com.demo;\npublic class Bad {\n  public void run() {\n    int x = 1\n    if (x > 0) { System.out.println(x);\n  }\n}\n`);
    const depsOnly = write("DepsOnly.java", `package com.demo;\nimport org.springframework.stereotype.Service;\n@Service\npublic class DepsOnly { public String hi(){ return "ok"; } }\n`);
    const chinese = write("Chinese.java", `package com.demo;\n/** 中文注释：账号管理接口 */\npublic class Chinese { public String hi(){ return "好"; } }\n`);

    const rGood = checkJavaFiles([good]);
    ok(rGood.checked && !rGood.report.syntax.length && !rGood.report.encoding.length && !rGood.report.other.length, `好码零误杀（${rGood.summary}）`);

    const rBad = checkJavaFiles([bad]);
    ok(rBad.report.syntax.length > 0, `坏码必拒：捕获 ${rBad.report.syntax.length} 处语法错`);
    ok(!rBad.report.encoding.length, "坏码用例无编码误报");

    const rDeps = checkJavaFiles([depsOnly]);
    eq(rDeps.report.syntax.length, 0, "缺依赖不误判成语法错");
    ok(rDeps.report.dependency.length > 0, "缺依赖被归为 dependency（不计入判定）");
    ok(rDeps.report.syntaxClean, "缺依赖 → syntaxClean=true");

    const rCn = checkJavaFiles([chinese]);
    eq(rCn.report.encoding.length, 0, "★ UTF-8 中文注释零编码误报（-encoding UTF-8 生效）");
    ok(rCn.report.syntaxClean, "★ 中文注释项目 syntaxClean=true");

    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败无妨 */ }
}

console.log(`\n[scorecard-smoke] 通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
