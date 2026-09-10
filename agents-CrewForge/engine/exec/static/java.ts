// ============================================================
// java.ts —— Java 静态闸门（写盘前预筛，IO 层）
//
//   形态（M0 实测决定）：
//     javac -encoding UTF-8 -proc:none -nowarn -J-Duser.language=en -d <tmp> <files>
//   要点：
//     ① 必须 -encoding UTF-8：不加则中文注释全报 unmappable（F-1 实锤）
//     ② 不提供 classpath：缺依赖产生的诊断被分类器归为 dependency，不参与判定
//        —— 这让闸门在"依赖尚未下载"时也能工作（生成期常态）
//     ③ exit=2（命令行错误）/3、4（系统错误）**不是**"干净"，必须显式报警
//     ④ 结论只能用语法+编码+未归类三类推导；dependency 一律不算证据
//
//   铁律（[[crewforge-code-over-tools]] + 不变量 2）：静态检查只许否决，不许放行。
// ============================================================

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
    parseJavaDiagnostics, summarizeJavaDiagnostics, syntaxFeedback,
    type JavaDiagnosticsReport,
} from "./javaDiagnostics";

/** javac 探测（进程内缓存；null=不可用 → 调用方退化为"无 Java 校验"并**必须**标注） */
let javacPath: string | null | undefined;
export function javacAvailable(): string | null {
    if (javacPath !== undefined) return javacPath;
    for (const exe of ["javac", "javac.exe"]) {
        try {
            execFileSync(exe, ["-version"], { timeout: 8000, stdio: "ignore" });
            javacPath = exe;
            return exe;
        } catch { /* 换下一个 */ }
    }
    javacPath = null;
    return null;
}

export interface JavaGateResult {
    /** 是否执行了 javac（false = 环境无 javac，结论为"未校验"） */
    checked: boolean;
    report: JavaDiagnosticsReport;
    /** 可读短句，直接进工位自修 feedback */
    feedback: string[];
    /** 人读摘要 */
    summary: string;
    /** 环境/工具级异常（javac 缺失、命令行错误、超时）——非代码问题，但不许静默 */
    toolError?: string;
    fileCount: number;
}

const BATCH = 60;   // 单批文件数上限（防命令行超长；语法校验不依赖跨文件解析）

/**
 * 跑一次 Java 语法闸门。
 * @param files 绝对路径列表
 */
export function checkJavaFiles(files: string[], timeoutMs = 120_000): JavaGateResult {
    const empty: JavaDiagnosticsReport = { exitCode: 0, syntax: [], dependency: [], encoding: [], other: [], syntaxClean: true };
    const exe = javacAvailable();
    if (!exe) {
        return {
            checked: false, report: empty, feedback: [], fileCount: 0,
            summary: "javac 不可用：本轮 Java 未经校验（未校验 ≠ 通过）",
            toolError: "javac not found",
        };
    }
    const targets = files.filter(f => /\.java$/i.test(f) && fs.existsSync(f));
    if (targets.length === 0) {
        return { checked: false, report: empty, feedback: [], fileCount: 0, summary: "无 Java 文件" };
    }

    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "cfjavac-"));
    const all: JavaDiagnosticsReport["syntax"] = [];
    const deps: JavaDiagnosticsReport["dependency"] = [];
    const encs: JavaDiagnosticsReport["encoding"] = [];
    const others: JavaDiagnosticsReport["other"] = [];
    let lastExit = 0;
    let toolError: string | undefined;
    try {
        for (let i = 0; i < targets.length; i += BATCH) {
            const batch = targets.slice(i, i + BATCH);
            let output = "";
            let exit = 0;
            try {
                execFileSync(exe, [
                    "-J-Duser.language=en", "-J-Duser.country=US",
                    "-encoding", "UTF-8",
                    "-proc:none", "-nowarn",
                    "-d", outDir,
                    ...batch,
                ], { timeout: timeoutMs, stdio: "pipe", encoding: "utf-8" });
            } catch (e: any) {
                exit = typeof e?.status === "number" ? e.status : 1;
                output = `${e?.stdout ?? ""}${e?.stderr ?? ""}`;
                // 命令行错误(2)/系统错误(3,4)：不是代码问题，明确报警而不是当作"有语法错"
                if (exit === 2 || exit === 3 || exit === 4) {
                    toolError = `javac 非代码错误 exit=${exit}: ${output.split(/\r?\n/).slice(0, 3).join(" / ").slice(0, 200)}`;
                }
            }
            const r = parseJavaDiagnostics(output, exit);
            all.push(...r.syntax); deps.push(...r.dependency); encs.push(...r.encoding); others.push(...r.other);
            lastExit = exit;
        }
    } finally {
        try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* 清理失败无妨 */ }
    }

    const report: JavaDiagnosticsReport = {
        exitCode: toolError ? (lastExit || 2) : lastExit,
        syntax: all, dependency: deps, encoding: encs, other: others,
        syntaxClean: all.length === 0 && encs.length === 0 && others.length === 0,
    };
    return {
        checked: true, report, fileCount: targets.length,
        feedback: syntaxFeedback(report),
        summary: summarizeJavaDiagnostics(report),
        toolError,
    };
}

/** 结论谓词（闸门/测试共用，避免各处各写一份判定） */
export function javaGateRejects(r: JavaGateResult): boolean {
    if (!r.checked) return false;                      // 未校验不否决（但不能算通过——由调用方标注）
    if (r.toolError) return false;                     // 工具级错误另行处理
    return r.report.syntax.length > 0 || r.report.encoding.length > 0 || r.report.other.length > 0;
}
