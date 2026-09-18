// ============================================================
// taskVerify.ts —— 任务级执行式验证（把"判决权"接进交付路径）
//
//   这是"自我纠正"闭环的入口：任务文件写盘后**立刻用真实命令验证**，
//   不通过就把编译诊断喂回去返工，修完**再验证**。
//
//   为什么必须它（F-3 铁证）：runs/p9 的 3 处幻觉 API 通过了当时所有基于 LLM 判断的关卡
//   （六项纸审 / 自身置信 / 正则比对），唯一抓住它的是 javac；而且执行式验证便宜得多
//   （一次编译 ≈ 0 token，一次纸审要烧几千 token）。
//
//   三条纪律：
//     ① 未验证 ≠ 通过：无验证器/无产物/缺依赖 → outcome=skipped_unverified，checked=false
//     ② ENV 与 COMPILE 严格分开：缺依赖进"环境恢复"，不进自修反馈（改代码解决不了缺依赖）
//     ③ 结果带签名（进失败账本）与日志路径（证据链）
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { runMavenCompile, findMaven, type MavenLauncher, type MavenCompileResult } from "./maven";
import { runCommand } from "../run";
import { signatureOf } from "./ledger";
import type { StackProfile } from "../../stacks/profile";

export type TaskVerifyOutcome = "ok" | "compile_error" | "env_error" | "tool_error" | "skipped_unverified";

export interface TaskVerifyResult {
    outcome: TaskVerifyOutcome;
    /** 是否真的跑过命令。false 时**任何下游都不许把它当作通过** */
    checked: boolean;
    summary: string;
    /** 进自修/返工的短句（只含"代码自身写错"类） */
    feedback: string[];
    /** 失败签名（失败账本用；成功时为空串） */
    signature: string;
    logFile: string | null;
    durationMs: number;
}

export interface TaskVerifyOpts {
    /** 项目产物根目录（runs/pN） */
    projectDir: string;
    layer: "backend" | "frontend";
    profile: StackProfile;
    /** mvnw 兜底路径：生成项目常常没有 wrapper，用引擎仓库自带的 */
    mvnwPath?: string | null;
    /** 离线缺依赖时是否允许联网补齐（默认允许，跑一次） */
    allowNetwork?: boolean;
    timeoutMs?: number;
    logDir?: string;
}

function skipped(summary: string): TaskVerifyResult {
    return { outcome: "skipped_unverified", checked: false, summary, feedback: [], signature: "", logFile: null, durationMs: 0 };
}

function launcherFrom(p: string | null | undefined): MavenLauncher | null {
    if (!p || !fs.existsSync(p)) return null;
    const isCmd = /\.cmd$/i.test(p);
    return { exe: isCmd ? (process.env.ComSpec || "cmd.exe") : p, prefixArgs: isCmd ? ["/c", p] : [], label: path.basename(p) };
}

function fromMaven(r: MavenCompileResult): TaskVerifyResult {
    if (r.outcome === "ok") {
        return { outcome: "ok", checked: true, summary: r.summary, feedback: [], signature: "", logFile: r.logFile, durationMs: r.durationMs };
    }
    if (r.outcome === "env_error") {
        // ★ 环境问题：不给自修反馈（改代码解决不了缺依赖），由调用方分流到环境恢复
        return { outcome: "env_error", checked: true, summary: r.summary, feedback: [], signature: "", logFile: r.logFile, durationMs: r.durationMs };
    }
    const feedback = r.diagnostics.slice(0, 8).map(d => `${d.file.split(/[\\/]/).pop()}:${d.line} ${d.message}`);
    return {
        outcome: r.outcome === "compile_error" ? "compile_error" : "tool_error",
        checked: true,
        summary: r.summary,
        feedback,
        signature: signatureOf("compile", r.diagnostics),
        logFile: r.logFile,
        durationMs: r.durationMs,
    };
}

// ---------- 前端构建输出分类 ----------
const FE_COMPILE_PATTERNS: RegExp[] = [
    /error TS\d+/i,
    /Failed to resolve import/i,
    /Could not resolve/i,
    /Cannot find module/i,
    /\[vite\][^\n]*error/i,
    /Transform failed/i,
    /build failed/i,
];
const FE_ENV_PATTERNS: RegExp[] = [
    /npm ERR! code ENOENT/i,
    /npm ERR! code ERESOLVE/i,
    /npm ERR! code ETIMEDOUT/i,
    /EACCES/i,
    /ENOTFOUND|ECONNREFUSED/i,
    /Could not resolve dependency/i,
];

/** 从构建输出里抠出 file:line 形态的诊断（拿不到就退化为首行错误文本） */
function extractFeDiagnostics(output: string): { file: string; line: number; message: string }[] {
    const out: { file: string; line: number; message: string }[] = [];
    const seen = new Set<string>();
    for (const raw of output.split(/\r?\n/)) {
        const line = raw.trim();
        if (!FE_COMPILE_PATTERNS.some(re => re.test(line))) continue;
        const m = /^(.*?\.(?:ts|tsx|vue|js|jsx|css))[:(](\d+)[,:)]?\s*(.*)$/.exec(line);
        const rec = m
            ? { file: m[1] ?? "", line: Number(m[2]), message: (m[3] ?? line).slice(0, 200) }
            : { file: "(构建输出)", line: 0, message: line.slice(0, 200) };
        const key = `${rec.file}:${rec.line}:${rec.message}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(rec);
        if (out.length >= 12) break;
    }
    return out;
}

function findPackageManager(dir: string): { cmd: string; args: string[] } {
    if (fs.existsSync(path.join(dir, "bun.lock")) || fs.existsSync(path.join(dir, "bun.lockb"))) {
        return { cmd: process.platform === "win32" ? "bun.exe" : "bun", args: ["run", "build"] };
    }
    return { cmd: process.platform === "win32" ? "npm.cmd" : "npm", args: ["run", "build"] };
}

/**
 * 验证一个任务刚写盘的产物。**不抛异常**——一切结果都变成返回值，由调用方分流。
 */
export async function verifyWrittenTask(o: TaskVerifyOpts): Promise<TaskVerifyResult> {
    // ① 未登记栈/无验证器：如实标"未验证"，绝不假装通过
    if (!o.profile.verified) {
        return skipped(`本栈无验证器（${o.profile.id}）：产物按"未验证"交付，不得计入通过`);
    }
    // 证据必须总是留档（判定只能来自命令+退出码，日志是审计材料）——未显式给就落到 <projectDir>/_verify
    const logDir = o.logDir ?? path.join(o.projectDir, "_verify");

    if (o.layer === "backend") {
        const dir = path.join(o.projectDir, "backend");
        if (!fs.existsSync(path.join(dir, "pom.xml"))) return skipped("后端 pom.xml 未产出，无可验证对象");
        const launcher = findMaven(dir) ?? launcherFrom(o.mvnwPath);
        if (!launcher) return { ...skipped("找不到 mvnw/mvn：Java 未经编译验证"), outcome: "tool_error" };
        const base = { projectDir: dir, launcher, timeoutMs: o.timeoutMs ?? 600_000, logDir };
        let r = runMavenCompile({ ...base, offline: true });
        if (r.outcome === "env_error" && o.allowNetwork !== false) {
            // 离线缺依赖 → 联网补齐后重跑一次（这次才是"代码到底对不对"的答案）
            r = runMavenCompile({ ...base, offline: false });
        }
        return fromMaven(r);
    }

    // 前端：build 是最接近"能不能跑"的廉价判据（tsc + 打包）
    const dir = path.join(o.projectDir, "frontend");
    if (!fs.existsSync(path.join(dir, "package.json"))) return skipped("前端 package.json 未产出，无可验证对象");
    if (!fs.existsSync(path.join(dir, "node_modules"))) return skipped("前端依赖未安装，构建验证跳过（未验证 ≠ 通过）");
    const pm = findPackageManager(dir);
    const r = await runCommand(pm.cmd, pm.args, {
        cwd: dir, timeoutMs: o.timeoutMs ?? 600_000, logDir,
        env: { ...(process.env as Record<string, string>), CI: "1" },
    });
    if (r.spawnError && r.exitCode === -1) {
        return { outcome: "tool_error", checked: false, summary: `构建命令无法启动：${r.spawnError}`, feedback: [], signature: "", logFile: r.logFile, durationMs: r.durationMs };
    }
    if (r.timedOut) {
        return { outcome: "env_error", checked: true, summary: `构建超时（${Math.round(r.durationMs / 1000)}s）`, feedback: [], signature: "", logFile: r.logFile, durationMs: r.durationMs };
    }
    if (r.exitCode === 0) {
        return { outcome: "ok", checked: true, summary: `构建通过（${Math.round(r.durationMs / 1000)}s）`, feedback: [], signature: "", logFile: r.logFile, durationMs: r.durationMs };
    }
    if (FE_ENV_PATTERNS.some(re => re.test(r.output))) {
        return { outcome: "env_error", checked: true, summary: "构建环境问题（依赖/网络）", feedback: [], signature: "", logFile: r.logFile, durationMs: r.durationMs };
    }
    const diags = extractFeDiagnostics(r.output);
    return {
        outcome: "compile_error",
        checked: true,
        summary: `构建失败：${diags.length} 处诊断`,
        feedback: diags.slice(0, 8).map(d => `${d.file.split(/[\\/]/).pop()}:${d.line} ${d.message}`),
        signature: signatureOf("build", diags),
        logFile: r.logFile,
        durationMs: r.durationMs,
    };
}
