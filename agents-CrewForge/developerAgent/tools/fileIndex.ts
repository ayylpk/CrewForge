// ============================================================
// tools/fileIndex.ts —— 生成项目的**文件元数据索引**（只读）
//
//   规格七：inspectProject 必须把文件元数据写进 state，但**不许放全文**。
//   所以这里只产出 { path, size, hash, language } 四样：
//     · path     相对项目根、正斜杠
//     · size     字节数
//     · hash     内容 sha256 前 16 位（判"文件有没有变过"用）
//     · language 由扩展名映射（Skill 与自检据此挑文件）
//
//   所有读取都过 Workspace.resolveRead —— 越界/禁止项在这里同样拦得住。
// ============================================================

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Workspace } from "../workspace";
import type { FileMeta } from "../state";

/** 扩展名 → 语言标记（够用即可；未知给 "other"） */
export const LANGUAGE_BY_EXT: Readonly<Record<string, string>> = {
    ".ts": "typescript", ".tsx": "typescript",
    ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".vue": "vue",
    ".java": "java",
    ".sql": "sql",
    ".json": "json", ".jsonc": "json",
    ".yml": "yaml", ".yaml": "yaml",
    ".xml": "xml",
    ".md": "markdown",
    ".css": "css", ".scss": "css", ".less": "css",
    ".html": "html", ".htm": "html",
    ".properties": "properties",
    ".sh": "shell", ".ps1": "shell",
    ".env": "env",
};

export function languageOf(p: string): string {
    const base = path.basename(p).toLowerCase();
    if (base === ".env" || base.startsWith(".env.")) return "env";
    const ext = path.extname(base);
    return LANGUAGE_BY_EXT[ext] ?? "other";
}

const DEFAULT_MAX_BYTES = 1024 * 1024;

/**
 * 索引项目内文件（只读）。
 *   二进制与超大文件只记 `size`，`hash` 留空串——**不把内容读进来**。
 */
export function indexProjectFiles(
    ws: Workspace,
    start = ".",
    opts?: { limit?: number; maxBytes?: number; skip?: readonly string[] },
): FileMeta[] {
    const limit = opts?.limit ?? 2000;
    const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
    const skip = new Set(opts?.skip ?? []);
    const out: FileMeta[] = [];

    for (const rel of ws.walk(start, { maxEntries: limit * 2 })) {
        if (out.length >= limit) break;
        if (skip.has(rel)) continue;
        let size = 0;
        let hash = "";
        try {
            const abs = ws.resolveRead(rel);
            const st = fs.statSync(abs);
            size = st.size;
            if (size <= maxBytes) {
                const buf = fs.readFileSync(abs);
                // 二进制（含 NUL）不哈希，避免把大块二进制读进内存语义
                if (!buf.includes(0)) {
                    hash = createHash("sha256").update(buf).digest("hex").slice(0, 16);
                }
            }
        } catch {
            continue;   // 读不到就跳过（可能在索引过程中被删）
        }
        out.push({ path: rel, size, hash, language: languageOf(rel) });
    }
    return out;
}
