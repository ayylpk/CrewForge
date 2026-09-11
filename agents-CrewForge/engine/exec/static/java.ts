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

// ============================================================
// 内容版闸门：给 checkers.checkFile / checkBatch 用
//
//   设计要点：
//     ① 按**原始相对路径**在临时根下还原目录树再编译——文件名必须保留，
//        否则 javac 的 "class X is public, should be declared in a file named X.java"
//        这条真错会被掩盖（生成代码里这是高频错）
//     ② 一次 javac 处理整批（bootstrap 一次吐十几个文件，不逐文件烧 JVM 启动）
//     ③ 诊断按文件归因回调用方路径；**未校验显式标注**，绝不折算成通过
// ============================================================

export interface JavaContentGateResult {
    /** 是否真的跑了 javac */
    checked: boolean;
    /** 归一化相对路径 → 问题短句（只含"代码自身写错"的类：语法/编码/未归类） */
    problems: Map<string, string[]>;
    summary: string;
    toolError?: string;
}

function normKey(p: string): string {
    return p.replace(/\\/g, "/").replace(/^\.\/+/, "").toLowerCase();
}

/** 路径安全：只接受项目内相对路径（防写到临时根之外） */
function safeRel(p: string): string | null {
    const clean = p.replace(/\\/g, "/").replace(/^\.\/+/, "");
    if (!clean || clean.startsWith("/") || /^[a-zA-Z]:/.test(clean)) return null;
    if (clean.split("/").includes("..")) return null;
    return clean;
}

export function checkJavaContents(
    files: { path: string; content: string }[],
    timeoutMs = 180_000,
): JavaContentGateResult {
    const empty = { checked: false, problems: new Map<string, string[]>(), summary: "无 Java 文件" };
    const targets = files.filter(f => /\.java$/i.test(f.path ?? "") && safeRel(f.path) != null);
    if (targets.length === 0) return empty;

    const exe = javacAvailable();
    if (!exe) {
        return {
            checked: false, problems: new Map(), toolError: "javac not found",
            summary: "javac 不可用：Java 未经校验（未校验 ≠ 通过）",
        };
    }

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cfjavacont-"));
    const outDir = path.join(root, "__out");
    const normToRel = new Map<string, string>();     // 归一化 key → 原始相对路径
    const absToNorm = new Map<string, string>();     // 临时绝对路径(小写) → 归一化 key
    try {
        fs.mkdirSync(outDir, { recursive: true });
        for (const f of targets) {
            const rel = safeRel(f.path)!;
            const key = normKey(rel);
            if (normToRel.has(key)) continue;         // 同路径去重（后者不覆盖）
            normToRel.set(key, rel);
            const abs = path.join(root, ...rel.split("/"));
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, f.content ?? "", "utf-8");
            absToNorm.set(abs.replace(/\\/g, "/").toLowerCase(), key);
        }

        const absFiles = [...absToNorm.keys()].map(k => path.join(root, ...normToRel.get(absToNorm.get(k)!)!.split("/")));
        const gate = checkJavaFiles(absFiles, timeoutMs);

        const problems = new Map<string, string[]>();
        if (!gate.checked) {
            return { checked: false, problems, toolError: gate.toolError, summary: gate.summary };
        }
        const add = (tempFile: string, line: number, message: string) => {
            const key = absToNorm.get(tempFile.replace(/\\/g, "/").toLowerCase());
            if (!key) return;                          // 归因不到本批 → 丢弃（不误挂到别的文件上）
            const arr = problems.get(key) ?? [];
            const short = normToRel.get(key)!.split("/").pop();
            arr.push(`${short}:${line} ${message}`);
            problems.set(key, arr);
        };
        for (const d of [...gate.report.syntax, ...gate.report.encoding, ...gate.report.other]) {
            add(d.file, d.line, d.message);
        }
        return {
            checked: true, problems, summary: gate.summary, toolError: gate.toolError,
        };
    } finally {
        try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 清理失败无妨 */ }
    }
}

/** 内容版谓词：该文件是否有"必须打回"的问题 */
export function javaContentProblems(res: JavaContentGateResult, relPath: string): string[] {
    return res.problems.get(normKey(relPath)) ?? [];
}
