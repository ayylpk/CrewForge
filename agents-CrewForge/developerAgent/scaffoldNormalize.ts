// ============================================================
// scaffoldNormalize.ts —— 脚手架产物归一化（确定性，零 LLM）
//
//   为什么需要：
//     · 引擎自己预铺的骨架（engine/workspace/skeleton/springVueMysql.ts:501）用的是
//         "build": "vite build"  +  "type-check": "vue-tsc --noEmit"
//       —— 构建门只做构建，类型检查是独立一步。
//     · 2026-09-17 起，栈命中官方脚手架时该维度不再预铺（skeleton/install.ts 的跳过策略），
//       初始化交给 `npm create vite@latest`。而 create-vite 的 vue-ts 模板写的是
//         "build": "vue-tsc -b && vite build"
//     · 后果（R5 实录）：模型写的 Vue/TS 里只要有**一个**类型错误，`npm run build` 就 exit=1，
//       frontend.build 判 fail —— 真实原因是类型检查，不是"构建不出来"。
//
//   归一化把两条路拉齐：`build` 只做构建，类型检查单独一条命令（谁要谁跑）。
//   判定与改写都是纯函数 + 明确的文件读写；**只动 `&&` 拼接里的类型检查段**，
//   与脚手架无关的脚本一个字节都不碰。
// ============================================================

import fs from "node:fs";
import path from "node:path";

/** 类型检查器的可执行名（模板里出现的形态） */
const CHECKER = String.raw`(?:vue-tsc|tsc)`;
/** "<checker> ... && <其余>" —— 只认 `&&` 拼接，且左段必须是类型检查器 */
const SPLIT_RE = new RegExp(String.raw`^\s*(${CHECKER}\b[^&|]*?)\s*&&\s*(.+)$`);

/** 常见工程目录名（脚手架产物落在这里；只扫这些 + 项目根，不做全树遍历） */
const CANDIDATE_DIRS = ["frontend", "backend", "web", "app", "client", "server", "admin", "ui", "api", "packages"];

export interface NormalizeOne {
    file: string;
    changed: boolean;
    from?: string;
    to?: string;
    typeCheck?: string;
    note?: string;
}

/**
 * 归一化单个 package.json 的 scripts.build。
 * 只在"build 是 `<类型检查器> && <真正的构建>`"形态时改写：
 *   build       → 真正的构建部分
 *   type-check  → 类型检查部分（已存在则不覆盖，尊重项目自己的定义）
 */
export function normalizePackageJsonBuildScript(pkgPath: string): NormalizeOne {
    const rel = pkgPath;
    let raw: string;
    try {
        raw = fs.readFileSync(pkgPath, "utf-8");
    } catch (e) {
        return { file: rel, changed: false, note: `读取失败：${String((e as Error).message ?? e)}` };
    }
    let pkg: Record<string, unknown>;
    try {
        pkg = JSON.parse(raw) as Record<string, unknown>;
    } catch (e) {
        return { file: rel, changed: false, note: `不是合法 JSON（不动）：${String((e as Error).message ?? e)}` };
    }
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    const build = typeof scripts.build === "string" ? scripts.build : "";
    if (!build) return { file: rel, changed: false, note: "没有 scripts.build（不动）" };

    const m = build.match(SPLIT_RE);
    if (!m) return { file: rel, changed: false, note: `build 不是"类型检查 && 构建"形态（不动）：${build}` };

    const typeCheck = (m[1] ?? "").trim();
    const realBuild = (m[2] ?? "").trim();
    if (!realBuild) return { file: rel, changed: false, note: "拆分后构建段为空（不动）" };

    const hadTypeCheck = typeof scripts["type-check"] === "string" && scripts["type-check"].trim().length > 0;
    const nextScripts: Record<string, string> = { ...scripts, build: realBuild };
    if (!hadTypeCheck) nextScripts["type-check"] = typeCheck;
    // 保持键序稳定：build 留在原位，type-check 追加在后
    const nextPkg = { ...pkg, scripts: nextScripts };
    fs.writeFileSync(pkgPath, `${JSON.stringify(nextPkg, null, 2)}\n`, "utf-8");
    return {
        file: rel, changed: true, from: build, to: realBuild,
        typeCheck: hadTypeCheck ? scripts["type-check"] : typeCheck,
        note: hadTypeCheck ? "类型检查已有定义，只拆 build" : "类型检查另立 type-check",
    };
}

/**
 * 扫描项目根 + 常见工程目录，归一化所有 package.json。
 * @param projectDirAbs 生成项目根（绝对路径）
 * @returns 每个被检查文件的结论（含未改动的，便于审计"为什么没改"）
 */
export function normalizeScaffoldedScripts(projectDirAbs: string): NormalizeOne[] {
    const targets: string[] = [];
    const rootPkg = path.join(projectDirAbs, "package.json");
    if (fs.existsSync(rootPkg)) targets.push(rootPkg);
    for (const dir of CANDIDATE_DIRS) {
        const p = path.join(projectDirAbs, dir, "package.json");
        if (fs.existsSync(p)) targets.push(p);
    }
    // 没扫到候选目录里的 package.json 时，退一步看一级子目录（不递归、不碰 node_modules）
    if (targets.length <= (fs.existsSync(rootPkg) ? 1 : 0)) {
        try {
            for (const e of fs.readdirSync(projectDirAbs, { withFileTypes: true })) {
                if (!e.isDirectory() || e.name === "node_modules" || e.name.startsWith(".")) continue;
                const p = path.join(projectDirAbs, e.name, "package.json");
                if (fs.existsSync(p) && !targets.includes(p)) targets.push(p);
            }
        } catch { /* 目录不可读就按已扫到的处理 */ }
    }
    return targets.map(normalizePackageJsonBuildScript);
}

/** 一行摘要（进工具输出 / 事件台账） */
export function summarizeNormalize(results: NormalizeOne[], projectDirAbs: string): string[] {
    const changed = results.filter(r => r.changed);
    const lines: string[] = [];
    for (const r of changed) {
        lines.push(`[脚手架归一化] ${path.relative(projectDirAbs, r.file).replace(/\\/g, "/")}：build "${r.from}" → "${r.to}"（type-check: ${r.typeCheck}）`);
    }
    return lines;
}
