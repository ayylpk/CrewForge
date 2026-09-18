// ============================================================
// maven.ts —— Maven 编译验证器（M3 的判决者，零 LLM）
//
//   存在理由（F-3 实机证据，2026-09-10）：
//     runs/p9/backend 用仓库 mvnw + 真实 classpath 编译 = BUILD FAILURE，3 处全是**幻觉 API**
//     （JdbcIndexedSessionRepository 构造器签名不存在、两个 setter 方法不存在）。
//     这类缺陷对语法闸门、正则比对、纸审清单、渲染审**全部不可见**——只有真编译能抓。
//     而当前流水线从不编译 Java，所以这类产物一路"绿灯"走到交付。
//
//   三条施工纪律（都由实测得出）：
//     ① 必须区分 ENV 与 COMPILE：离线时本地 ~/.m2 缺依赖会报 "Could not resolve dependencies"
//        ——那是环境问题，不能计成"代码坏了"，否则会把 ENV 误判成返工死循环
//     ② 必须强制英文 locale（MAVEN_OPTS=-Duser.language=en）：本机 javac/Maven 输出是 GBK 中文，
//        正则解析跨机器不稳定
//     ③ 原始输出必须留档（证据链）——判定只能来自"命令 + 退出码"，日志是审计材料
// ============================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export type MavenOutcome = "ok" | "compile_error" | "env_error" | "tool_error";

export interface MavenDiagnostic {
    file: string;
    line: number;
    column: number;
    message: string;
}

export interface MavenCompileResult {
    outcome: MavenOutcome;
    exitCode: number;
    durationMs: number;
    diagnostics: MavenDiagnostic[];
    /** ENV 类原因原文（依赖/仓库/网络），用于分流到"环境恢复"而不是返工 */
    envReasons: string[];
    summary: string;
    logFile: string | null;
}

// ---------- 环境类错误（依赖/仓库/网络/插件） ----------
const ENV_PATTERNS: RegExp[] = [
    /Could not resolve dependencies/i,
    /Cannot access central/i,
    /Non-resolvable parent POM/i,
    /Could not find artifact/i,
    /could not be resolved/i,
    /Unknown host|Connection (refused|timed out)|Network is unreachable/i,
    /Could not transfer artifact/i,
];

/** 诊断行：`[ERROR] /abs/path/X.java:[233,51] 说明` */
const DIAG_RE = /\[ERROR\]\s+(.+?):\[(\d+),(\d+)\]\s+(.*)$/;

/**
 * 找 Maven 入口：优先项目自带 wrapper → 环境变量 CREWFORGE_MVNW → PATH 上的 mvn。
 * wrapper 返回 {exe:"cmd.exe", args:["/c", wrapper]} 形态（Windows 批处理必须经 cmd 跑）。
 */
export interface MavenLauncher { exe: string; prefixArgs: string[]; label: string }

export function findMaven(projectDir: string): MavenLauncher | null {
    const candidates: string[] = [
        path.join(projectDir, "mvnw.cmd"),
        path.join(projectDir, "mvnw"),
        process.env.CREWFORGE_MVNW?.trim() ?? "",
    ].filter(Boolean);
    for (const c of candidates) {
        if (fs.existsSync(c)) {
            const isCmd = /\.cmd$/i.test(c);
            return { exe: isCmd ? (process.env.ComSpec || "cmd.exe") : c, prefixArgs: isCmd ? ["/c", c] : [], label: path.basename(c) };
        }
    }
    return null;   // 由调用方决定是否回退 PATH 上的 mvn
}

export interface MavenCompileOpts {
    projectDir: string;
    /** 离线（默认 true）：离线时缺依赖会明确落到 ENV，而不是静默去联网 */
    offline?: boolean;
    timeoutMs?: number;
    /** 原始日志留档目录；给了就写 maven-compile.log（证据链） */
    logDir?: string;
    /** 额外 maven 参数（如 -DskipTests） */
    extraArgs?: string[];
    launcher?: MavenLauncher | null;
}

/**
 * 跑一次 `compile`。**不启动服务、不跑测试**——只回答"能不能编译"。
 */
export function runMavenCompile(opts: MavenCompileOpts): MavenCompileResult {
    const t0 = Date.now();
    const launcher = opts.launcher ?? findMaven(opts.projectDir);
    if (!launcher) {
        return {
            outcome: "tool_error", exitCode: -1, durationMs: 0, diagnostics: [], envReasons: [],
            summary: "找不到 mvnw/mvn：Java 未经编译验证（未校验 ≠ 通过）", logFile: null,
        };
    }
    const args = [
        ...launcher.prefixArgs,
        "-B",
        ...(opts.offline === false ? [] : ["-o"]),
        "-DskipTests",
        "-Dfile.encoding=UTF-8",
        ...(opts.extraArgs ?? []),
        "compile",
    ];
    let output = "";
    let exitCode = 0;
    let toolError = "";
    try {
        output = execFileSync(launcher.exe, args, {
            cwd: opts.projectDir,
            timeout: opts.timeoutMs ?? 600_000,
            encoding: "utf-8",
            maxBuffer: 32 * 1024 * 1024,
            // ② 强制英文 locale：本机默认 GBK 中文，会破坏跨机正则解析
            env: { ...process.env, MAVEN_OPTS: `${process.env.MAVEN_OPTS ?? ""} -Duser.language=en -Duser.country=US -Dfile.encoding=UTF-8`.trim() },
        });
    } catch (e: any) {
        exitCode = typeof e?.status === "number" ? e.status : -1;
        output = `${e?.stdout ?? ""}${e?.stderr ?? ""}`;
        if (exitCode < 0) toolError = String(e?.message ?? e).slice(0, 200);
    }
    const durationMs = Date.now() - t0;

    // 证据留档
    let logFile: string | null = null;
    if (opts.logDir) {
        try {
            fs.mkdirSync(opts.logDir, { recursive: true });
            logFile = path.join(opts.logDir, "maven-compile.log");
            fs.writeFileSync(logFile, `# ${launcher.label} ${args.join(" ")}\n# exit=${exitCode} ${durationMs}ms\n\n${output}`, "utf-8");
        } catch { logFile = null; }
    }

    // 分类：ENV 优先（缺依赖时 Maven 根本走不到编译阶段）
    const envReasons = ENV_PATTERNS
        .flatMap(re => output.split(/\r?\n/).filter(l => re.test(l)).map(l => l.replace(/^\[ERROR\]\s*/, "").trim()))
        .filter((v, i, a) => v && a.indexOf(v) === i)
        .slice(0, 8);

    const diagnostics: MavenDiagnostic[] = [];
    const seen = new Set<string>();
    for (const line of output.split(/\r?\n/)) {
        const m = DIAG_RE.exec(line.trim());
        if (!m) continue;
        const [, file, lineText, colText, message] = m;
        const key = `${file}:${lineText}:${message}`;
        if (seen.has(key)) continue;                 // 同一诊断在"编译块"与"goal 摘要"里各出现一次
        seen.add(key);
        diagnostics.push({ file: file ?? "", line: Number(lineText), column: Number(colText), message: (message ?? "").trim() });
    }

    const hasCompileBlock = /COMPILATION ERROR/i.test(output);
    let outcome: MavenOutcome;
    if (toolError && exitCode < 0) outcome = "tool_error";
    else if (envReasons.length > 0) outcome = "env_error";
    else if (exitCode === 0 && !hasCompileBlock) outcome = "ok";
    else if (diagnostics.length > 0 || hasCompileBlock) outcome = "compile_error";
    else outcome = exitCode === 0 ? "ok" : "tool_error";

    const summary = outcome === "ok"
        ? `编译通过（${durationMs}ms）`
        : outcome === "compile_error"
            ? `编译失败：${diagnostics.length} 处诊断`
            : outcome === "env_error"
                ? `环境问题（依赖/仓库）：${envReasons[0] ?? "未知"}`
                : `工具级错误 exit=${exitCode}${toolError ? `：${toolError}` : ""}`;

    return { outcome, exitCode, durationMs, diagnostics, envReasons, summary, logFile };
}

/** 给工位自修用的反馈短句（只带编译诊断，ENV 类不进 feedback——改代码也解决不了缺依赖） */
export function compileFeedback(r: MavenCompileResult, limit = 6): string[] {
    return r.diagnostics.slice(0, limit).map(d => {
        const short = d.file.split(/[\\/]/).pop() ?? d.file;
        return `${short}:${d.line} ${d.message}`;
    });
}

/** 建一个最小可编译的 Maven 工程（验证器自测夹具用；不依赖网络） */
export function writeMinimalPom(dir: string, extraDeps = ""): string {
    fs.mkdirSync(dir, { recursive: true });
    const pom = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.cf.fixture</groupId>
  <artifactId>fixture</artifactId>
  <version>1.0</version>
  <properties>
    <maven.compiler.source>17</maven.compiler.source>
    <maven.compiler.target>17</maven.compiler.target>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>
  <dependencies>
${extraDeps}
  </dependencies>
</project>
`;
    const p = path.join(dir, "pom.xml");
    fs.writeFileSync(p, pom, "utf-8");
    return p;
}

/** 临时工程目录工厂（自测用） */
export function makeFixtureDir(tag: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `cfmvn-${tag}-`));
}
