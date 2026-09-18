// ============================================================
// collect.ts —— 产物快照采集（IO 层，零 LLM）
//
//   只读既有产物树 + 跑 javac 语法闸门。**不运行 agent 团队、不调 LLM**。
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { checkJavaFiles } from "../engine/exec/static/java";
import type { JavaDiagnosticsReport } from "../engine/exec/static/javaDiagnostics";
import type { RunSnapshot, FileEntryStat } from "./scorecard";

const SKIP_DIRS = new Set(["node_modules", ".git", "_archive", "dist", ".vite"]);

function walk(dir: string, out: string[] = []): string[] {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full, out); }
        else out.push(full);
    }
    return out;
}

function readIndexHtmlScript(dir: string): string | null {
    const p = path.join(dir, "frontend", "index.html");
    if (!fs.existsSync(p)) return null;
    try {
        const html = fs.readFileSync(p, "utf-8");
        const m = /<script[^>]*\bsrc=["']([^"']+)["']/i.exec(html);
        return m?.[1] ?? null;
    } catch { return null; }
}

/** 采集一个 run 目录的快照；runId 默认取目录名 */
export function collectSnapshot(dir: string, runId?: string): RunSnapshot {
    const abs = path.resolve(dir);
    const id = runId ?? path.basename(abs);
    const files = walk(abs).map(f => f.replace(/\\/g, "/"));

    const byExt: Record<string, number> = {};
    for (const f of files) {
        const ext = path.extname(f).toLowerCase() || "(none)";
        byExt[ext] = (byExt[ext] ?? 0) + 1;
    }

    const entryPaths = [
        "frontend/index.html",
        "frontend/src/main.ts",
        "frontend/src/App.vue",
        "frontend/src/router/index.ts",
    ];
    const entryFiles: FileEntryStat[] = entryPaths.map(p => ({
        path: p,
        present: fs.existsSync(path.join(abs, p)),
    }));

    const countFiles = (sub: string) => {
        const d = path.join(abs, sub);
        if (!fs.existsSync(d)) return 0;
        try { return fs.readdirSync(d).filter(n => fs.statSync(path.join(d, n)).isFile()).length; } catch { return 0; }
    };

    const contractsPath = path.join(abs, "CONTRACTS.md");
    const hasContracts = fs.existsSync(contractsPath);
    let contractsChars = 0;
    if (hasContracts) { try { contractsChars = fs.readFileSync(contractsPath, "utf-8").length; } catch { /* 0 */ } }

    const javaFiles = files.filter(f => f.toLowerCase().endsWith(".java"));
    const gate: { checked: boolean; report?: JavaDiagnosticsReport; toolError?: string; summary: string; fileCount: number } =
        javaFiles.length > 0
            ? checkJavaFiles(javaFiles)
            : { checked: false, summary: "无 Java 文件", fileCount: 0 };

    return {
        runId: id,
        dir: abs,
        fileCount: files.length,
        byExt,
        entryFiles,
        indexHtmlScript: readIndexHtmlScript(abs),
        testReports: countFiles("_test-report"),
        taskEvidence: countFiles("_task-evidence"),
        hasContracts,
        contractsChars,
        frontendNodeModules: fs.existsSync(path.join(abs, "frontend", "node_modules")),
        java: {
            fileCount: javaFiles.length,
            checked: gate.checked,
            report: gate.report,
            toolError: gate.toolError,
            summary: gate.summary,
        },
    };
}
