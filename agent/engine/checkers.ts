// ============================================================
// checkers.ts —— T1 工位编译自修闸门（v3 §2-T1，2026-09-08）
//
//   治什么病（F5 缝合四坑的机器可检部分）：代码写盘即交付，
//   语法错/引用炸裸奔到看板。本文件提供**写盘前**的纯代码校验：
//     checkJsLike  esbuild.transform 查 ts/jsx 语法 + 相对 import 目标存在性（F5③）+ 目标导出名核验（F5②）
//     checkVue     @vue/compiler-sfc parse + compileTemplate（模板残缺/标签不闭合）+ script 段过 esbuild + import 扫描
//     checkPy      PATH 有 python 就真 py_compile；没有退化为括号/引号配平文本校验（F-卡面降级阀）
//     checkJson    JSON.parse（地基 package.json 等同款坑）
//     checkJavaLike 真 javac 语法闸门（9/10 新增；只否决语法/编码/未归类，缺 classpath 的依赖类诊断不参与判定）
//
//   铁律（[[crewforge-code-over-tools]]）：全部纯函数零 LLM——
//   报错原文喂回工位自修是调用方的事（复用 attempt×3 骨架，话术截断见文末 gateFeedback）。
//   闸门自身绝不误杀：任何"拿不准"（export *、.vue 命名导入、@/ 别名、bare 包名）一律放行——
//   宁漏不误杀，误杀一次=白烧一轮 60~300s 的 LLM 调用。
// ============================================================

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { transform } from "esbuild";
import { parse as sfcParse, compileTemplate, type SFCDescriptor } from "@vue/compiler-sfc";
import { checkJavaContents, javaContentProblems } from "./engine/exec/static/java";

/** 校验结果：人读的中文错误短句列表（直接拼进自修 feedback），空数组=绿 */
export type CheckProblems = string[];

// ---------- 已知文件集（import 存在性的"地图"） ----------

/**
 * GateKnown：当前项目"理论上存在哪些文件、内容是什么"的只读视图。
 * 三层叠加：内存层（本任务已生成未落盘的 writtenFiles + 计划内 planned + bootstrap 批内互引）
 *          > 磁盘层（runs/pN 产物树）。
 * 计划内文件只保证存在性（内容还没生成，导出名核验自动跳过）。
 */
export interface GateKnown {
    has(relPath: string): boolean;
    /** 读内容；读不到（计划内未生成/根本不存在）返回 null */
    read(relPath: string): string | null;
    /**
     * p2 复盘修②③（9/9）新增：已存在文件（磁盘层 ∪ 内存层，不含计划内未生成）的有序路径列表，
     * 展示保原始大小写（匹配仍走归一化）。两个消费者：文件树注入 prompt、打回附候选。
     */
    list(): string[];
}

/** 归一化项目内相对路径：反斜杠→斜杠、小写（Windows 大小写不敏感）、剥 ./ */
function normRel(p: string): string {
    return p.replace(/\\/g, "/").toLowerCase().replace(/^\.\/+/, "");
}

/**
 * 磁盘目录树快照（跳过 node_modules/dist/_archive/.git——这些不该被 import 相对路径指到源码级核验）。
 * p2 修②（9/9）改返回 norm→原始路径 的 Map：normRel 会小写化，直接拿归一化路径给模型看
 * 等于教它"全小写 import"（Windows 侥幸能跑，Linux build 就炸），展示必须保原始大小写。
 */
function walkProject(rootDir: string): Map<string, string> {
    const out = new Map<string, string>();
    const SKIP = new Set(["node_modules", "dist", "_archive", ".git"]);
    const walk = (dir: string, rel: string) => {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const r = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(path.join(dir, e.name), r); }
            else out.set(normRel(r), r.replace(/\\/g, "/"));
        }
    };
    walk(rootDir, "");
    return out;
}

/**
 * 构建闸门视图。projectRoot 传 null 表示无磁盘树（smoke 纯内存场景）。
 * extra = 本任务已生成/批内文件内容；planned = 还没写但已排定的路径（存在性算有）。
 */
export function buildKnown(projectRoot: string | null, extra?: Map<string, string>, planned?: string[]): GateKnown {
    const disk = projectRoot ? walkProject(projectRoot) : new Map<string, string>();
    const mem = new Map<string, string>();
    const names = new Map<string, string>(disk);          // norm → 展示路径（原始大小写；内存层后写覆盖磁盘层）
    for (const [k, v] of extra ?? []) { const n = normRel(k); mem.set(n, v); names.set(n, k.replace(/\\/g, "/")); }
    const plan = new Set((planned ?? []).map(normRel));
    return {
        has: (p) => { const n = normRel(p); return mem.has(n) || disk.has(n) || plan.has(n); },
        read: (p) => {
            const n = normRel(p);
            if (mem.has(n)) return mem.get(n)!;
            const orig = disk.get(n);
            if (orig && projectRoot) {
                // 9/9 顺带修正：磁盘读用原始大小写路径（原先拿归一化小写路径 join，Linux 上会读空）
                try { return fs.readFileSync(path.join(projectRoot, orig), "utf-8"); } catch { return null; }
            }
            return null;   // 计划内未生成：内容未知，名字核验自动跳过
        },
        list: () => [...names.values()].sort(),
    };
}

// ---------- 文件树注入（p2 复盘修②，9/9） ----------

/** 把 known 的现存文件渲染成扁平路径列表（cap 防 token 撑爆，超出如实标注省略数） */
export function formatFileTree(known: GateKnown, cap = 80): string {
    const all = known.list();
    if (all.length === 0) return "";
    const shown = all.slice(0, cap);
    const rest = all.length - shown.length;
    let text = shown.join("\n") + (rest > 0 ? `\n…（共 ${all.length} 个文件，其余 ${rest} 个略）` : "");
    // C-3（9/10）：字节上限——组件/路径多时文件树会撑爆每轮 prompt 的稳定段；
    // 截断处显式标注，绝不静默截断（模型必须能看出"树被截了"）
    const MAX_CHARS = 4000;
    if (text.length > MAX_CHARS) {
        text = text.slice(0, MAX_CHARS) + `\n…（文件树按 ${MAX_CHARS} 字符截断，完整树用 ls 工具查询）`;
    }
    return text;
}

/**
 * p2 复盘的根因②：模型与闸门信息不对称——buildKnown 知道磁盘上有什么，但实现 prompt 里一个字没提，
 * 模型只能看着 prompt 里的"官方封装"猜路径。现在把树直接喂进 system prompt：
 * 打回从"猜谜"变"照抄"。空树（首轮地基/纯内存冒烟）返回空串不污染 prompt。
 */
export function fileTreePrompt(known: GateKnown): string {
    const tree = formatFileTree(known);
    if (!tree) return "";
    return `\n\n## 项目文件树（已落盘/本任务已生成——相对 import 只允许指向树内真实路径；树里没有就不得发明该路径，在目标文件内自实现所需逻辑）\n${tree}`;
}

// ---------- 相对 import 解析 ----------

const RESOLVE_EXTS = ["", ".ts", ".tsx", ".vue", ".js", ".jsx", ".mjs", ".json",
    "/index.ts", "/index.tsx", "/index.js", "/index.vue"];

/** 折叠 a/b/../c → a/c（纯字符串级，不碰磁盘） */
function collapse(rel: string): string {
    const out: string[] = [];
    for (const seg of rel.split("/")) {
        if (seg === "" || seg === ".") continue;
        if (seg === "..") out.pop();
        else out.push(seg);
    }
    return out.join("/");
}

/**
 * 解析相对 import → 项目内真实存在的路径（处理扩展名/index 省略）。
 * 返回 null = 解析不到任何已存在文件（= F5③"引用到空"，该打回）。
 */
function resolveRel(known: GateKnown, fromFile: string, spec: string): string | null {
    const base = collapse(`${path.posix.dirname(normRel(fromFile))}/${spec}`);
    for (const ext of RESOLVE_EXTS) {
        // 只给"无扩展名"的候选补扩展；写了 .vue 就必须真有 .vue
        if (ext !== "" && /\.(ts|tsx|vue|js|jsx|mjs|json)$/i.test(base)) continue;
        if (known.has(base + ext)) return normRel(base + ext);
    }
    return null;
}

// ---------- import 语句提取（静态/动态/require/export-from） ----------

interface ImportRef { spec: string; named: string[] | null }

/** 解析 import/export 子句里的具名绑定（`A, { B, C as D }` → default/B/D）；import type / * 整体跳过名核验 */
function parseClause(clause: string | undefined): string[] | null {
    if (!clause) return null;                       // 裸 import "./x.css"：无绑定
    if (/(^|[\s{,])type\s+[\w$]/.test(clause) || /^\s*type\b/.test(clause)) return null;   // 类型导入运行期被擦除，不核名
    if (clause.includes("*")) return null;          // 命名空间导入：核不了具体名
    // 正则前缀可能跨语句捞进垃圾子句（`import './a.css';\nimport {x} from`）：大括号外出现引号/分号/换行 = 不可信，降级为只核存在性
    if (/[;"'\n]/.test(clause.replace(/\{[^}]*\}/g, ""))) return null;
    const names: string[] = [];
    const brace = clause.match(/\{([^}]*)\}/);
    const outside = clause.replace(/\{[^}]*\}/g, "").replace(/,/g, " ").trim();
    if (outside && /^[\w$]+$/.test(outside)) names.push("default");   // 大括号外的裸标识符才是默认绑定
    if (brace) for (const part of (brace[1] ?? "").split(",")) {
        const t = part.trim();
        if (!t || /^type\b/.test(t)) continue;
        names.push((t.split(/\s+as\s+/)[0] ?? t).trim());   // 核目标导出名用 as 前的原名（as 后是本文件局部别名，与目标无关）
    }
    return names.length ? names : null;
}

/** 扫源码里所有模块引用（.ts/.js/.vue script 通用）。正则宽进：解析不出子句就当匿名引用，只核存在性 */
function extractImports(code: string): ImportRef[] {
    const refs: ImportRef[] = [];
    let m: RegExpExecArray | null;
    const staticRe = /(?:^|[\n;])\s*(?:import|export)\s+(?:type\s+)?([\s\S]*?)\s*from\s*["']([^"'\n]+)["']/g;
    while ((m = staticRe.exec(code))) { if (m[2]) refs.push({ spec: m[2], named: parseClause(m[1]) }); }
    const bareRe = /(?:^|[\n;])\s*import\s*["']([^"'\n]+)["']/g;
    while ((m = bareRe.exec(code))) { if (m[1]) refs.push({ spec: m[1], named: null }); }
    const dynRe = /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g;          // 路由懒加载 () => import('../views/X.vue')
    while ((m = dynRe.exec(code))) { if (m[1]) refs.push({ spec: m[1], named: null }); }
    const reqRe = /\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/g;
    while ((m = reqRe.exec(code))) { if (m[1]) refs.push({ spec: m[1], named: null }); }
    return refs;
}

/**
 * 目标文件的导出名清单。返回 null = 拿不准（export * 转发），调用方跳过名核验。
 * interface/type 也算"有这个名字"（值/类型混用判定太深，闸门不误杀）。
 */
function collectExports(src: string): Set<string> | null {
    if (/\bexport\s*\*\s*(?:as\s+[\w$]+\s*)?from\b/.test(src)) return null;
    const names = new Set<string>();
    if (/\bexport\s+default\b/.test(src)) names.add("default");
    let m: RegExpExecArray | null;
    const declRe = /\bexport\s+(?:async\s+)?(?:default\s+)?(?:abstract\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([\w$]+)/g;
    while ((m = declRe.exec(src))) { if (m[1]) names.add(m[1]); }
    const listRe = /\bexport\s*\{([^}]*)\}/g;                            // export { a, b as c }（含带 from 的转发）
    while ((m = listRe.exec(src))) for (const part of (m[1] ?? "").split(",")) {
        const t = part.trim();
        if (t) names.add((t.split(/\s+as\s+/)[1] ?? t).trim());
    }
    return names;
}

// ---------- import 核验主体（存在性 + 导出名） ----------

/**
 * p2 复盘修③（9/9）：打回不只说"不存在"，附磁盘候选。
 * p3 复盘修（9/9 晚）：候选限同侧目录树——前端 main.ts 找 App.vue 时推一个 backend/src/app.js
 * 是帮倒忙（"app" 撞名跨层）；相似判定从"互相包含"收紧为"前缀开头"（request→requestHelper ✓，
 * package→app ✗），短名噪音立减。
 * 候选两路（纯代码零 LLM）：①文件名前缀相似 ②导出的 named 真实存在。
 * 输出从当前文件算好的**正确相对 spec**——模型照抄即可，不用再自己算 ../ 深度。
 * 宁漏不误带：一个候选都没有就维持原报错，不硬凑。
 */
function candidateHint(known: GateKnown, fromFile: string, spec: string, named: string[] | null): string {
    const base = (spec.split("/").pop() ?? "").replace(/\.(ts|tsx|js|jsx|mjs|vue|json|css|scss)$/i, "").toLowerCase();
    if (!base) return "";
    const pool = known.list();
    if (pool.length === 0) return "";
    const self = normRel(fromFile);
    const dir = path.posix.dirname(self);
    // 同侧限定：frontend/ ↔ backend/ 互不推荐（root 下的杂件也不跨进去推荐）
    const sideOf = (p: string) => /^(frontend|web|client|ui)\//.test(p) ? "front" : /^(backend|server)\//.test(p) ? "back" : "other";
    const mySide = sideOf(self);
    // 候选路径换算成"从当前文件出发的正确写法"，相对路径补 ./ 前缀防歧义。
    // ../ 深度一律用归一化（小写）路径算——大小写混排的目录名会让 relative() 从分歧段多吐 ../；
    // 文件名段最后还以原始大小写（Linux build 认文件名大小写）
    const toSpec = (p: string) => {
        let rel = path.posix.relative(dir, normRel(p));
        if (!rel.startsWith(".")) rel = "./" + rel;
        const segs = rel.split("/");
        segs[segs.length - 1] = p.split("/").pop() ?? segs[segs.length - 1]!;
        return segs.join("/");
    };
    const cands: { spec: string; why: string }[] = [];
    const seen = new Set<string>();
    // ① 文件名前缀相似（cap 3，≥3 字符才配；p3 复盘收紧：互相包含会让 package 撞上 app 这类跨词误推）
    for (const p of pool) {
        if (cands.length >= 3) break;
        const n = normRel(p);
        if (n === self || sideOf(n) !== mySide) continue;
        const name = (n.split("/").pop() ?? "").replace(/\.[^.]+$/, "");
        if (name.length >= 3 && (name.startsWith(base) || base.startsWith(name))) {
            seen.add(p);
            cands.push({ spec: toSpec(p), why: "文件名相似" });
        }
    }
    // ② 导出名命中（default 人人都有不算信号，只核真实具名；树太大时止步防读盘开销失控）
    const want = (named ?? []).filter(n => n !== "default");
    if (want.length > 0 && pool.length <= 600) {
        for (const p of pool) {
            if (cands.length >= 3) break;
            const n = normRel(p);
            if (seen.has(p) || n === self || sideOf(n) !== mySide || !/\.(ts|tsx|js|jsx|mjs|vue)$/i.test(n)) continue;
            const src = known.read(p);
            if (!src) continue;                                  // 计划内未生成/读失败：内容未知，不算候选
            const exp = collectExports(src);
            if (!exp) continue;                                  // export* 转发拿不准：不误带
            const hits = want.filter(w => exp.has(w));
            if (hits.length > 0) cands.push({ spec: toSpec(p), why: `导出 ${hits.slice(0, 3).join("、")}` });
        }
    }
    if (cands.length === 0) return "";
    return `；磁盘上疑似候选：${cands.map(c => `${c.spec}（${c.why}）`).join("、")} —— 要么改引候选（路径照抄），要么在目标文件内自实现所需逻辑，不要再发明路径`;
}

async function checkImports(filePath: string, code: string, known: GateKnown, banned?: string[]): Promise<CheckProblems> {
    const problems: CheckProblems = [];
    const bannedSet = new Set((banned ?? []).map(s => s.toLowerCase()));
    for (const { spec, named } of extractImports(code)) {
        if (!spec.startsWith("./") && !spec.startsWith("../")) {
            // 违禁依赖闸（p3 修④，9/9）：技术基线说了 SQLite，import mysql2 当场红——
            // 不再等测试工位纸面审。裸包名取顶层（@scope/pkg 取两段），比对调用方传入的禁用清单
            if (bannedSet.size > 0) {
                const pkg = (spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0] ?? "").toLowerCase();
                if (bannedSet.has(pkg)) problems.push(`import "${spec}" 使用禁用依赖 ${pkg}（本项目技术基线禁止，见任务【技术基线】段——换用基线内的实现）`);
            }
            continue;   // 裸包名/@别名/http 的存在性：磁盘上没有 node_modules，一律放行（宁漏不误杀）
        }
        const resolved = resolveRel(known, filePath, spec);
        if (!resolved) {
            problems.push(`import "${spec}" 指向的文件不存在（相对 ${filePath} 解析不到，F5③ 引用到空）${candidateHint(known, filePath, spec, named)}`);
            continue;
        }
        if (!named || /\.(vue|css|scss|json|png|svg|jpg)$/.test(resolved)) continue;   // 命名空间/类型/.vue 隐式默认导出等：不核名
        const targetSrc = known.read(resolved);
        if (targetSrc == null) continue;                                    // 计划内还没生成的文件：内容未知
        const exports = collectExports(targetSrc);
        if (!exports || exports.size === 0) continue;                       // 拿不准（export* 转发/纯副作用文件）：放行
        for (const n of named) {
            if (!exports.has(n)) problems.push(`import { ${n} } from "${spec}"：目标文件中不存在导出 ${n}（F5② 引了个不存在的东西）`);
        }
    }
    return problems;
}

// ---------- 各语言校验 ----------

/** ts/jsx 家族：esbuild 语法闸（transform 不解析模块，import 存在性由 checkImports 管） */
export async function checkJsLike(filePath: string, code: string, known: GateKnown, banned?: string[]): Promise<CheckProblems> {
    const problems: CheckProblems = [];
    const loader: "ts" | "tsx" | "jsx" | "js" = /\.tsx$/i.test(filePath) ? "tsx"
        : /\.jsx$/i.test(filePath) ? "jsx"
        : /\.(ts|mjs|mts|cts)$/i.test(filePath) ? "ts" : "js";
    try {
        await transform(code, { loader, sourcefile: filePath });
    } catch (e: any) {
        const msgs: CheckProblems = (e?.errors ?? []).map((x: any) =>
            `语法错误${x?.location ? ` 第 ${x.location.line} 行` : ""}：${x?.text ?? ""}`);
        problems.push(...(msgs.length ? msgs : [`esbuild 拒绝：${String(e?.message ?? e).slice(0, 160)}`]));
    }
    problems.push(...await checkImports(filePath, code, known, banned));
    return problems;
}

/** .vue 单文件组件：sfc parse 结构闸 + 模板编译闸 + script 段过 esbuild + import 扫描（F5①③ 的 vue 侧入口） */
export async function checkVue(filePath: string, code: string, known: GateKnown, banned?: string[]): Promise<CheckProblems> {
    const problems: CheckProblems = [];
    let descriptor: SFCDescriptor;
    try {
        const r = sfcParse(code);
        descriptor = r.descriptor;
        for (const e of r.errors) problems.push(`SFC 结构错误：${String(e.message).slice(0, 160)}`);
        if (r.errors.length) return problems;   // 结构都崩了，模板/script 校验没有意义
    } catch (e: any) {
        return [`SFC 解析失败：${String(e?.message ?? e).slice(0, 160)}`];
    }
    if (descriptor.template) {
        // p3 复盘小修（9/9）：compileTemplate 对个别 v-if/v-for 结构会【抛异常】而不是进 errors
        // （Codegen node is missing…），原先异常逃出去被工位 catch 成"调用失败"白烧一轮 attempt——
        // 闸门自己的炸必须变成材料（报错原文打回），不能伪装成网络错
        try {
            const r = compileTemplate({ source: descriptor.template.content, filename: filePath, id: "gate" });
            for (const e of r.errors) problems.push(`模板编译错误：${String(typeof e === "string" ? e : (e as any)?.message ?? e).slice(0, 160)}`);
        } catch (e: any) {
            problems.push(`模板编译异常：${String(e?.message ?? e).slice(0, 160)}（多为 v-if/v-else 结构问题，检查指令配对）`);
        }
    }
    // script 与 script setup 分别过 esbuild（.vue 相对路径解析仍按 .vue 自身目录）
    for (const blk of [descriptor.script, descriptor.scriptSetup]) {
        if (!blk?.content?.trim()) continue;
        const lang = (blk.lang ?? "js").toLowerCase();
        const sub = `${filePath}.${lang === "ts" ? "ts" : "js"}`;
        try { await transform(blk.content, { loader: lang === "ts" ? "ts" : "js", sourcefile: sub }); }
        catch (e: any) {
            const msgs = (e?.errors ?? []).map((x: any) => `script(${lang}) 语法错误：${x?.text ?? ""}（第 ${x?.location?.line ?? "?"} 行）`);
            problems.push(...(msgs.length ? msgs : [`script(${lang}) esbuild 拒绝：${String(e?.message ?? e).slice(0, 160)}`]));
        }
        problems.push(...await checkImports(filePath, blk.content, known, banned));
    }
    return problems;
}

// python 可用探测（进程内缓存；spawn 一次性，不每文件都摸）
let pythonExe: string | null | undefined;
function findPython(): string | null {
    if (pythonExe !== undefined) return pythonExe;
    for (const exe of ["python", "py", "python3"]) {
        try { execFileSync(exe, ["-c", "print(1)"], { timeout: 8000, stdio: "ignore" }); pythonExe = exe; return exe; }
        catch { /* 换下一个 */ }
    }
    pythonExe = null;
    return null;
}

/** 无 python 时的文本级校验（卡面降级阀）：括号配平 + 三引号成对，无视字符串/注释里的干扰 */
function checkPyText(code: string): CheckProblems {
    const problems: CheckProblems = [];
    const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
    const stack: string[] = [];
    let line = 1;
    for (let i = 0; i < code.length; i++) {
        const c = code[i] ?? "";
        if (c === "\n") { line++; continue; }
        if (c === "#") { const nl = code.indexOf("\n", i); i = nl < 0 ? code.length : nl - 1; continue; }
        if (code.startsWith('"""', i) || code.startsWith("'''", i)) {
            const q = code.slice(i, i + 3);
            const end = code.indexOf(q, i + 3);
            if (end < 0) { problems.push(`三引号 ${q} 未闭合（起始第 ${line} 行）`); return problems; }
            line += (code.slice(i, end).match(/\n/g) ?? []).length;
            i = end + 2;
            continue;
        }
        if (c === '"' || c === "'") {                                   // 单行字符串：跳到闭合或行尾
            let j = i + 1;
            while (j < code.length) {
                if (code[j] === "\\") { j += 2; continue; }
                if (code[j] === c || code[j] === "\n") break;
                j++;
            }
            if (code[j] !== c) { problems.push(`单引号字符串未闭合（第 ${line} 行）`); return problems; }
            i = j;
            continue;
        }
        if (c === "(" || c === "[" || c === "{") stack.push(c);
        else if (pairs[c]) {
            if (stack.pop() !== pairs[c]) { problems.push(`括号 "${c}" 不匹配（第 ${line} 行）`); return problems; }
        }
    }
    if (stack.length) problems.push(`括号未闭合：残留 ${stack.slice(-3).join("")}（全文配平校验）`);
    return problems;
}

/** py：PATH 有 python 就真 py_compile（权威），否则 checkPyText 退化（F10 环境不假设） */
export async function checkPy(_filePath: string, code: string, _known: GateKnown): Promise<CheckProblems> {
    const exe = findPython();
    if (!exe) return checkPyText(code);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crewgate-"));
    const tmpFile = path.join(tmpDir, "gate_check.py");
    try {
        fs.writeFileSync(tmpFile, code, "utf-8");
        try {
            execFileSync(exe, ["-m", "py_compile", tmpFile], { timeout: 20000, stdio: "pipe" });
            return [];
        } catch (e: any) {
            const err: string[] = String(e?.stderr ?? e?.message ?? e).trim().split(/\r?\n/);
            const meaningful = err.filter((l: string) => /Error|error|Syntax|line \d+|invalid|expected|unexpected/i.test(l)).slice(-3);
            return [`py_compile 拒绝：${(meaningful.join(" / ") || err.slice(-1)[0] || "未知").slice(0, 240)}`];
        }
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* 临时目录清理失败无所谓 */ }
    }
}

/** .json：parse 一把梭（地基 package.json 被 enforceTdesignFoundation 改写后也走这里复核） */
export async function checkJson(filePath: string, code: string, _known: GateKnown): Promise<CheckProblems> {
    try { JSON.parse(code); return []; }
    catch (e: any) { return [`JSON 解析失败：${String(e?.message ?? e).slice(0, 160)}`]; }
}

// ---------- 总入口 ----------

/** Java 未校验告警只打一次（避免每文件刷屏），但绝不静默 */
let javaUncheckedWarned = false;
function warnJavaUncheckedOnce(toolError: string | undefined, summary: string): void {
    if (javaUncheckedWarned) return;
    javaUncheckedWarned = true;
    console.warn(`[gate] ⚠️ Java 未经校验（未校验 ≠ 通过）：${toolError ?? summary}`);
}

/**
 * .java：真 javac 语法闸门（9/10 新增）。
 *   背景：本文件 DISPATCH 此前只有 vue/ts/py/json——**Java 文件一个字节都没被检查过**，
 *   而 Java 恰是生成项目里占比最高的语言（runs/p9 的 45 个产物中 21 个 .java）。
 *   形态：`javac -encoding UTF-8 -proc:none -nowarn`；缺 classpath 产生的依赖类诊断被分类器
 *   归为 dependency，不参与判定（生成期依赖常未下载）；只否决"代码自身写错"的三类：
 *   语法 / 编码 / 未归类。临时文件按原始相对路径还原，因此
 *   "public class X 与文件名不符" 这条真错也能抓住。
 *   未校验（无 javac）→ 放行但**打告警**（不变量 2：静态检查只许否决，不许宣称通过）。
 */
export async function checkJavaLike(filePath: string, code: string, _known: GateKnown, _banned?: string[]): Promise<CheckProblems> {
    const res = checkJavaContents([{ path: filePath, content: code }]);
    if (!res.checked) { warnJavaUncheckedOnce(res.toolError, res.summary); return []; }
    return javaContentProblems(res, filePath);
}

const DISPATCH: [RegExp, (f: string, c: string, k: GateKnown, banned?: string[]) => Promise<CheckProblems>][] = [
    [/\.vue$/i, checkVue],
    [/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i, checkJsLike],
    [/\.py$/i, checkPy],
    [/\.json$/i, checkJson],
    [/\.java$/i, checkJavaLike],
];

/**
 * 单文件闸门总入口：按扩展名分派；css/yml/md 等不认识的格式直接绿（放行原则）。
 * banned=禁用包名清单（p3 修④，调用方从契约【技术基线】段解析），缺省=只跑语法/引用两查。
 * 返回错误短句列表（拼 feedback 用），空=可写盘。
 */
export async function checkFile(filePath: string, code: string, known: GateKnown, banned?: string[]): Promise<CheckProblems> {
    if (!code) return [];
    for (const [re, fn] of DISPATCH) {
        if (re.test(filePath)) return await fn(filePath, code, known, banned);
    }
    return [];
}

/** 批校验（architect bootstrap 用）：批内互引先注入 known；返回 path→错误列表（只含红的文件）。banned=技术基线禁用包（S4） */
export async function checkBatch(files: { path: string; content: string }[], known: GateKnown, banned?: string[]): Promise<Map<string, CheckProblems>> {
    const mem = new Map<string, string>();
    for (const f of files) if (f?.path) mem.set(normRel(f.path), f.content ?? "");
    // 批内视图：存在性 = 批内 ∪ 外层 known；内容 = 批内优先（还没落盘，磁盘读不到）
    const batchKnown: GateKnown = {
        has: (p) => mem.has(normRel(p)) || known.has(p),
        read: (p) => mem.get(normRel(p)) ?? known.read(p),
        list: () => [...new Set([...mem.keys(), ...known.list()])].sort(),
    };
    const out = new Map<string, CheckProblems>();
    for (const f of files) {
        if (!f?.path) continue;
        if (/\.java$/i.test(f.path)) continue;   // Java 走下面的批量通道：一次 javac 处理整批，不逐文件烧 JVM 启动
        const problems = await checkFile(f.path, f.content ?? "", batchKnown, banned);
        if (problems.length) out.set(f.path, problems);
    }
    // Java 批量通道（9/10）：bootstrap 一次吐十几个文件，逐文件 javac 会白烧 10+ 次 JVM 启动
    const javaFiles = files.filter(f => f?.path && /\.java$/i.test(f.path));
    if (javaFiles.length > 0) {
        const res = checkJavaContents(javaFiles.map(f => ({ path: f.path, content: f.content ?? "" })));
        if (!res.checked) warnJavaUncheckedOnce(res.toolError, res.summary);
        else {
            for (const f of javaFiles) {
                const ps = javaContentProblems(res, f.path);
                if (ps.length) out.set(f.path, [...(out.get(f.path) ?? []), ...ps]);
            }
        }
    }
    return out;
}

// ---------- 自修反馈话术（同 retryStructured 的口味：错误原文喂回工位） ----------

/**
 * 拼进工位 prompt 尾部的打回段。attempt 只用于日志可读性。
 * p2 复盘修③（9/9）截断 400→600：候选提示挂在报错尾巴上，400 字容易把"出路"截掉、只留"死症"。
 */
export function gateFeedback(attempt: number, problems: CheckProblems): string {
    return `\n\n## 编译闸门打回（第 ${attempt} 次）：上一次产出的文件未通过编译校验，按错误修正后重新输出目标文件完整源代码（不要围栏、JSON 或说明）\n${problems.join("；").slice(0, 600)}`;
}


// ============================================================
// 需求栈 ↔ 架构师选型一致性闸（搬运⑤，2026-09-17）
//
//   治什么病（s4 实弹）：需求原文写明「Node + Express + SQLite」，
//   architectStack 仍按默认兼容组合选了 Spring Boot 3 + sqlite-jdbc，
//   地基按错栈铺、developer 再逐项纠正——整条链白烧。
//   机制：stackSchema 强制模型先**逐字摘录**需求里的栈声明（requirementStack.quote），
//   本函数对比「声明 ↔ 决策」；冲突即 zod addIssue → 走既有 OUTPUT_PARSE 有界重试，
//   报错原文（含出路）自动喂回重选。
//
//   铁律同上：纯函数零 LLM；**宁漏不误杀**——只判"明确写了 A 却选了 B"的硬冲突，
//   需求没写栈（quote=未指定）一律放行。
// ============================================================

// ============================================================
// ★ R3 事故族（2026-09-24 新增）：部署形态族——"不引入外部服务 / 嵌入式" ↔ 选型外部服务
//
//   治什么病（a1 实弹，不是假想）：冻结需求 eval/scenarios/a1/input.md 的"边界"段写死
//   「不引入外部服务，数据库用嵌入式的即可」（交付约束还要求 npm 一键安装/启动/构建），
//   架构师 stack 仍把 techniques.database.type 定成 "MySQL 8"（why 里甚至自陈"不引入 JWT 认证、
//   消息队列、Redis 等中间件"），落盘的 ddl.sql 第一行就是 `-- 目标数据库：MySQL 8，字符集 utf8mb4`——
//   于是整条下游（依赖驱动、连接串、验收）都建立在一台**验收环境并不保证提供**的 MySQL 服务器上。
//   旧闸门只认**命名系别**（SQLite / MySQL / PostgreSQL / MongoDB），需求里"嵌入式 / 无外部服务"
//   这种朴素语言约束它一个字都看不见 →「需求写 A、选型给 B」的硬冲突整条链放行。
//
//   机制：新增一族"部署形态"，命名系别两表**逐字不动**（既有行为不变）：
//     需求侧 = 明确的嵌入式/无外部服务约束（嵌入式、不引入外部服务、无需额外服务、一键启动、
//              开箱即用、不需要安装、sqlite/h2/本地文件数据库… + 英文同义写法）；
//     决策侧 = 外部服务名（mysql/postgres/mongo/redis/docker/kafka/rabbitmq/k8s…）。
//   两侧同时命中才算冲突；决策侧出现"嵌入式友好"标记（sqlite/h2/embedded/in-memory…）即放行。
//
//   铁律（宁漏不误杀）：纯函数、零 LLM、零 I/O；
//     ① 需求只写"数据库用 MySQL"而没写嵌入式/无外部服务 → 约束不明确，一律不判；
//     ② 决策侧的外部服务名若被否定词管住（a1 的 why 就写着"不引入…Redis 等中间件"）
//        → 不算"偏向"，剔除假命中（否则一句"无需 Docker"就能把自己打成冲突）。
// ============================================================

/** 需求侧"部署形态约束"子模式（顺序即优先级；命中片段会原样引回话术，让模型对照原文自己判断） */
const DEPLOYMENT_CONSTRAINT_PATTERNS: readonly { label: string; re: RegExp }[] = [
    { label: "不引入外部服务", re: /不(?:引入|依赖|使用|采用|需要|接入)(?:任何|其它|其他)?外部(?:的)?(?:服务|依赖|组件|中间件)|(?:无|没有|禁止|不依赖)外部(?:服务|依赖)/i },
    { label: "嵌入式/内嵌", re: /嵌入式|内嵌式|内嵌(?:数据库|存储|引擎)/ },
    { label: "无需额外服务或安装", re: /无需(?:额外|其他|其它|任何)?(?:的)?(?:服务|安装|部署|依赖|中间件)|不需要(?:额外|其他|其它|任何)?(?:的)?(?:服务|安装|部署|依赖|中间件)|免安装/ },
    { label: "一键启动/开箱即用", re: /一键(?:启动|安装|运行|跑起来|拉起|克隆|跑)|开箱即用|零配置/ },
    { label: "嵌入式数据库命名", re: /\bsqlite\d*\b|\bh2\b|\bhsqldb\b|\bderby\b|本地文件数据库|单文件数据库|文件型数据库|本地数据库文件/i },
    // 英文/通用写法：冻结输入以中文为主，但约束句混英文（或整篇英文）的场合不能漏
    { label: "no external services", re: /\b(?:no|without|zero)\s+(?:external|extra|additional)\s+(?:external\s+)?(?:service|services|dependency|dependencies|middleware)\b/i },
    { label: "embedded database", re: /\bembedded\s+(?:database|datastore|db|storage)\b/i },
    { label: "one-command / out-of-the-box", re: /\b(?:one|single)[- ](?:command|shot)\b|\bout[- ]of[- ]the[- ]box\b|\bzero[- ]config(?:uration)?\b/i },
    { label: "no install required", re: /\b(?:no|without)\s+install(?:ation)?(?:\s+(?:required|needed))?\b|\binstall[- ]free\b/i },
];

/**
 * 上面全部子模式合成的单一正则。两处消费者共用同一集合：
 *   ① conflictOf 的 claim 只接受一个 RegExp（部署形态族的需求侧认领）；
 *   ② matchDeploymentConstraint 逐模式找"是哪种约束"，并把命中片段摘出来。
 */
const EMBEDDED_CONSTRAINT_RE = new RegExp(DEPLOYMENT_CONSTRAINT_PATTERNS.map(p => `(?:${p.re.source})`).join("|"), "i");

/** 决策侧"外部服务"名：命中即代表选型需要一个独立部署/启动的进程或中间件 */
const EXTERNAL_SERVICE_RE = /\bmysql\d*\b|\bmariadb\b|\bpostgres(?:ql)?\b|\bpg\b|\bmongo(?:db)?\b|\bredis\b|\bdocker\b|\bpodman\b|\bkafka\b|\brabbitmq\b|\bzookeeper\b|\bk8s\b|\bkubernetes\b|\bhelm\b|\belasticsearch\b|\bnacos\b|\bconsul\b|\betcd\b|\bminio\b/i;

/** 决策侧"嵌入式友好"标记：命中即说明决策本身就在嵌入式形态里（放行，不判冲突） */
const EMBEDDED_FRIENDLY_RE = /\bsqlite\d*\b|\bh2\b|\bhsqldb\b|\bderby\b|better-sqlite3|\bembedded\b|\bsingle[- ]file\b|\bin-?memory\b|内嵌|嵌入式|本地文件|单文件|文件型|内存数据库|本地数据库文件/i;

/** 分句边界：句读 + 换行（否定词只在**同一分句内**生效） */
const CLAUSE_BREAK_RE = /[。；;！!？?\n]/;
/** 分句内的转折词：转折之后，前面的否定词不再管到后面的命中点（"不引入 Redis，但数据库用 MySQL"） */
const CLAUSE_REVERSAL_RE = /但是|但|不过|然而|而是|改用|改为|换成|\b(?:but|however|instead)\b/i;
/** 否定词：出现在同一分句命中点之前 → 这个外部服务名不算"选型偏向" */
const CLAUSE_NEGATION_RE = /无需|不需要|不用|不必|不引入|不依赖|不安装|不采用|不使用|不部署|不接入|免安装|避免|禁止|没有引入|without|\bno\s+need\b|\bno\s+external\b|\bnot\s+(?:use|using|need)\b/i;

/** 取命中处的"需求原文片段"：同一分句优先，剥掉 markdown 列表符，压成一行并截断（话术里把原文还给模型对照） */
function constraintFragment(text: string, index: number, len: number): string {
    const MAX = 40;
    let start = index;
    let end = index + len;
    while (start > 0 && index - start < MAX && !CLAUSE_BREAK_RE.test(text[start - 1] ?? "")) start--;
    while (end < text.length && end - (index + len) < MAX && !CLAUSE_BREAK_RE.test(text[end] ?? "")) end++;
    return oneLine(text.slice(start, end).replace(/^[\s>*\-–—•·]+/, ""), 80);
}

/** 命中点所在分句的起点（1-based 无关，纯下标；越界安全） */
function clauseStart(text: string, index: number): number {
    let start = Math.max(0, Math.min(index, text.length));
    while (start > 0 && !CLAUSE_BREAK_RE.test(text[start - 1] ?? "")) start--;
    return start;
}

/**
 * 决策文本里的"外部服务"提及（含下标，便于摘片段做证据）。
 * ★ 被否定词管住的剔除：a1 的 why 写着"不引入 JWT 认证、消息队列、Redis 等中间件"——
 *   照字面匹配会把 Redis 当成偏向，于是"自己声明不引入"反而被打成冲突（典型误杀）。
 *   同一分句内命中点之前若有否定词、且中间没有"但/而是"这类转折，即视为否定提及。
 */
function findExternalServiceMentions(decision: string): { name: string; index: number }[] {
    const text = decision ?? "";
    const out: { name: string; index: number }[] = [];
    const re = new RegExp(EXTERNAL_SERVICE_RE.source, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
        const head = text.slice(clauseStart(text, m.index), m.index);
        const reversal = CLAUSE_REVERSAL_RE.exec(head);
        const headEff = reversal ? head.slice((reversal.index ?? 0) + reversal[0].length) : head;
        if (CLAUSE_NEGATION_RE.test(headEff)) continue;
        out.push({ name: m[0], index: m.index });
    }
    return out;
}

/** 需求侧部署形态约束的命中结果（label=约束类别，fragment=引用给模型的需求原文片段，index=原文下标） */
export interface DeploymentConstraintMatch {
    label: string;
    fragment: string;
    index: number;
}

/**
 * 需求原文是否带**明确**的"嵌入式 / 无外部服务"约束（TASK1 需求侧判定，纯函数）。
 * 返回 null = 约束不明确（只提了数据库、没提部署形态）→ 调用方一律放行，不判冲突。
 * 同一份判定被三处复用：冲突检测、代码级钉死（pinEmbeddedDatabase）、单测。
 */
export function matchDeploymentConstraint(requirement: string): DeploymentConstraintMatch | null {
    const text = requirement ?? "";
    if (!text.trim()) return null;
    for (const p of DEPLOYMENT_CONSTRAINT_PATTERNS) {
        const m = p.re.exec(text);
        if (!m) continue;
        return { label: p.label, fragment: constraintFragment(text, m.index, m[0].length), index: m.index };
    }
    return null;
}

/** 部署形态冲突结论：kind 固定 "deployment-form"（机器可读分支），detail=人读短句（含需求原文/冒犯选项/该选什么） */
export interface DeploymentFormConflict {
    kind: string;
    detail: string;
}

/**
 * ★ TASK1 核心：部署形态冲突检测（导出即可单测，不依赖 conflictOf/闸门其余部分）。
 *
 * 触发条件（缺一不可，两边都必须是"明确写了"）：
 *   ① 需求原文命中嵌入式/无外部服务约束（matchDeploymentConstraint 非空）；
 *   ② 决策文本点名了外部服务（mysql/postgres/mongo/redis/docker/kafka/rabbitmq/k8s…），
 *      且该提及没被否定词管住（findExternalServiceMentions）；
 *   ③ 决策文本里**没有**"嵌入式友好"标记（sqlite/h2/embedded/in-memory…）。
 * 返回 null 的三种情形都是"宁漏不误杀"：约束不明确、没选外部服务、决策其实也是嵌入式。
 */
export function detectDeploymentFormConflict(quote: string, decision: string): DeploymentFormConflict | null {
    const constraint = matchDeploymentConstraint(quote ?? "");
    if (!constraint) return null;                                   // ① 约束不明确 → 放行
    const text = decision ?? "";
    if (EMBEDDED_FRIENDLY_RE.test(text)) return null;               // ③ 决策本身就在嵌入式形态里 → 无冲突
    const mentions = findExternalServiceMentions(text);
    const first = mentions[0];
    if (!first) return null;                                        // ② 没选外部服务（或全被否定词管住）→ 放行
    const names = [...new Set(mentions.map(m => m.name))];
    const chosen = constraintFragment(text, first.index, first.name.length);
    return {
        kind: "deployment-form",
        detail: `部署形态冲突（R3）：需求原文写明「${constraint.fragment}」（约束类别：${constraint.label}）——本项目必须嵌入式/无外部服务即可跑起来；`
            + `而选型选了外部服务 ${names.join("、")}（决策文本片段：「${chosen}」），生成物要额外部署并启动这些服务，验收环境不保证提供。`
            + `请改回嵌入式形态：database.type 用 SQLite（文件型数据库，随应用进程启动、零外部依赖；JVM 项目用 H2 内存库或 sqlite-jdbc 亦可），`
            + `DDL 落盘后必须在启动时真实执行；确实必须外部服务时，先改冻结需求原文再谈选型。`,
    };
}

/** TASK2：嵌入式约束下**代码级钉死**的数据库决策（不是建议，是调用方必须写进 stack 的值） */
export interface PinnedDatabaseChoice {
    type: "sqlite";
    why: string;
    migrationFile: string;
}

/** pinEmbeddedDatabase 的默认迁移文件（相对项目根）。R8 的教训是"DDL 写了没人执行"，所以路径与"启动时执行"绑在一起说 */
export const EMBEDDED_DB_MIGRATION_FILE = "db/init.sql";

/**
 * ★ TASK2 核心：需求带嵌入式/无外部服务约束时，**代码里直接钉死**数据库决策（纯函数，返回 null = 不干预）。
 *
 * 为什么要有它：R3 的根因是"把合规性寄托在模型自觉"——闸门只能事后打回重选（烧一轮 60~300s），
 * 而约束是**确定性**的：需求写了"不引入外部服务/嵌入式"，数据库就不该有任何别的答案。
 * 调用方拿到本函数的结果后，直接以它的值覆盖 stack 决策（含 why 话术），模型连选错的机会都没有。
 *
 * @param requirement   冻结需求原文（与 checkStackConsistency 的入参同一份）
 * @param migrationFile 迁移文件相对路径，默认 db/init.sql；Spring 骨架请传
 *                      "backend/src/main/resources/schema.sql"（与 spring.sql.init 的 schema-locations 对齐）
 * @returns null = 需求没有明确嵌入式约束（不干预选型）；否则 { type:"sqlite", why, migrationFile }
 */
export function pinEmbeddedDatabase(requirement: string, migrationFile: string = EMBEDDED_DB_MIGRATION_FILE): PinnedDatabaseChoice | null {
    const constraint = matchDeploymentConstraint(requirement ?? "");
    if (!constraint) return null;
    const file = (migrationFile ?? "").trim() || EMBEDDED_DB_MIGRATION_FILE;
    return {
        type: "sqlite",
        why: `需求原文「${constraint.fragment}」明确要求嵌入式/无外部服务（约束类别：${constraint.label}），故钉死 sqlite：`
            + `单文件数据库随应用进程启动，零外部依赖（不装 MySQL、不跑 Docker，验收环境开来即用）；`
            + `建表 DDL 写在 ${file}，并必须在启动时真实执行（否则接口会撞 Table '…' doesn't exist 报 500）。`
            + `JVM 项目可用 H2/sqlite-jdbc 等价替代，但不得换成需要独立部署的数据库服务。`,
        migrationFile: file,
    };
}

/** 系别表的一族（见 conflictOf）：claim=需求侧认领，marker/driftOf=决策侧"偏向谁"，detail=可选自定义话术 */
interface StackFamily {
    family: string;
    /**
     * 需求侧认领模式：命中即代表"需求声明了这一系"。
     * 缺省（undefined）= 本族只作为"决策偏向谁"的标记系别、不对需求侧认领——
     * 部署形态族的"外部服务依赖"就是这种（需求写了 MySQL 时不该由它去认领，否则方向会反过来）。
     */
    claim?: RegExp;
    /** 决策侧标记模式（driftOf 缺省时用它判定"偏向"；传了 driftOf 时仍作为展示/兜底） */
    marker: RegExp;
    /** 可选：自定义"决策偏向"识别（缺省 marker.test）——部署形态族要用它剔除被否定词管住的假命中 */
    driftOf?: (decisionText: string) => string[];
    /** 可选：自定义冲突短句（缺省走通用句式；命名系别族不传，话术逐字不变） */
    detail?: (ctx: { family: string; claimText: string; decisionText: string; drifters: string[] }) => string;
}

/** 已知后端系别：命中即归到该系（用于"跨系冲突"判定） */
const BACKEND_FAMILIES: StackFamily[] = [
    { family: "Spring/JVM", claim: /spring\s?boot|spring mvc|mybatis/i, marker: /spring|mybatis|java(?!script)/i },
    { family: "Node 系", claim: /node|express|koa|fastify|nest(\.js)?/i, marker: /express|koa|fastify|nest(\.js)?|node(\.js)?\s*\+/i },
    { family: "Python 系", claim: /django|flask|fastapi/i, marker: /django|flask|fastapi/i },
    { family: "Go 系", claim: /\bgin\b|\becho\b|\bfiber\b/i, marker: /\bgin\b|\becho\b|\bfiber\b/i },
];

/** 已知数据库系别 */
const DB_FAMILIES: StackFamily[] = [
    { family: "SQLite", claim: /sqlite/i, marker: /sqlite/i },
    { family: "MySQL", claim: /mysql/i, marker: /mysql/i },
    { family: "PostgreSQL", claim: /postgres/i, marker: /postgres|pg\b/i },
    { family: "MongoDB", claim: /mongo/i, marker: /mongo/i },
];

function conflictOf(claimText: string, decisionText: string, families: StackFamily[]): string | null {
    const claimFamily = families.find(f => f.claim?.test(claimText) === true);
    if (!claimFamily) return null;
    // 决策文本里出现了**别的系**的标记、且没有出现需求声明的系的标记 → 硬冲突。
    //   driftOf 是 2026-09-24 给部署形态族加的钩子（否定词剔除）；命名系别族不传，行为与旧版逐字一致。
    const others = families.filter(f => f.family !== claimFamily.family);
    const drifted: string[] = [];
    for (const f of others) {
        if (f.driftOf) drifted.push(...f.driftOf(decisionText));
        else if (f.marker.test(decisionText)) drifted.push(f.family);
    }
    if (drifted.length > 0 && !claimFamily.marker.test(decisionText)) {
        if (claimFamily.detail) return claimFamily.detail({ family: claimFamily.family, claimText, decisionText, drifters: drifted });
        return "需求声明 " + claimFamily.family + "，而选型偏向 " + drifted.join("/") + "；回到需求原文重新选型";
    }
    return null;
}

/**
 * ★ 部署形态族（R3，2026-09-24）：需求侧=嵌入式/无外部服务约束；决策侧=外部服务名。
 * 第一族的 detail 直接复用导出的 detectDeploymentFormConflict（同一份判定，话术只写一处）；
 * 第二族**没有 claim**——它只负责回答"决策偏向谁"，不对需求侧认领，
 * 否则"需求写了 MySQL"会反过来被它认领成"需求声明外部服务依赖"，把方向判反。
 */
const DEPLOYMENT_FORM_FAMILIES: StackFamily[] = [
    {
        family: "嵌入式部署形态（无外部服务）",
        claim: EMBEDDED_CONSTRAINT_RE,
        marker: EMBEDDED_FRIENDLY_RE,
        detail: ({ claimText, decisionText }) =>
            detectDeploymentFormConflict(claimText, decisionText)?.detail
            ?? "需求声明「嵌入式/无外部服务」部署形态，而选型偏向外部服务；回到需求原文重新选型",
    },
    {
        family: "外部服务依赖",
        marker: EXTERNAL_SERVICE_RE,
        driftOf: (decisionText) => findExternalServiceMentions(decisionText).map(m => m.name),
    },
];

/**
 * 对比「需求原文摘录 ↔ 栈决策文本」，返回人读冲突短句（空数组=绿/未声明=放行）。
 * 2026-09-24 追加第三族"部署形态"（R3）：命名系别看不懂"不引入外部服务/嵌入式"，
 * 于是需求写嵌入式、选型给 MySQL 8 的硬冲突能整链放行——第三族专治它，前两族行为不变。
 * @param quote    requirementStack.quote（模型从需求原文逐字摘的栈声明；"未指定"=放行）
 * @param decision 决策文本：techniques.database.type/why + moduleTech[].backend + why 拼接
 */
export function checkStackConsistency(quote: string, decision: string): CheckProblems {
    const q = (quote ?? "").trim();
    if (!q || /未指定|none|n\/a/i.test(q)) return [];
    const out: CheckProblems = [];
    const be = conflictOf(q, decision, BACKEND_FAMILIES);
    if (be) out.push(be);
    const db = conflictOf(q, decision, DB_FAMILIES);
    if (db) out.push(db);
    // ★ R3：部署形态族（命名系别冲突已点出的同一件事会多出一条更具体的部署话术——两条都在讲真话，
    //   让重选同时看到"哪个系错了"和"部署形态不符合需求"，比只给一条更快收敛）
    const dep = conflictOf(q, decision, DEPLOYMENT_FORM_FAMILIES);
    if (dep) out.push(dep);
    return out;
}


// ============================================================
// 前端路由登记硬闸（2026-09-17 新增）
//
//   治什么病（白屏事故）：骨架 renderSkeleton 遇到"契约未登记任何页面路由"时直出一张空路由表，
//   只在控制台留一行：
//     [skeleton] 契约未登记任何页面路由：router 表为空（可运行但不注册任何页面，/ 会白屏）
//   这个产物**照样能启动**（vite build 不报错、tsc 也过），所以现有任何闸门都拦不住它；
//   而 eval 的渲染检查 page.home 会在无头 Edge 里打开 "/"，要求可见文本 + <input>——
//   白屏直接判失败：一行没人看的日志换掉整轮评测（60~300s LLM 调用 + 全部产物）。
//   本函数把同一个事实升级为**机器可读、可强制修复**的结论（ok/detail/evidence），
//   由调用方（developer 图 / 验收面）当硬闸用，而不是继续 console.warn。
//
//   铁律（[[crewforge-code-over-tools]]）：纯函数、同步、零 LLM，只读 fs + 正则/字符串解析；
//   拿不准一律放行（动态构造的路由表、导航守卫兜底）——宁漏不误杀，误杀一次=白烧一轮。
// ============================================================

/** 前端路由闸结论：ok=可交付；detail=人读短句（含出路）；evidence=文件:行 + 计数（模型照抄即可，不必自行推导）；file=命中的关键文件（相对 projectDirAbs，斜杠分隔） */
export type FrontendRoutesResult = ReturnType<typeof checkFrontendRoutes>;

/** 扫描前端候选目录时跳过的目录（产物/依赖不该参与"前端在哪"的判断） */
const FE_SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", "_archive", "coverage", ".vite", ".output"]);

/** 路由文件标准位置（顺序即优先级：loader 目录约定 > 单文件约定） */
const ROUTER_CANDIDATES = ["src/router/index.ts", "src/router.ts", "src/router/index.js", "src/router.js"];

/** 单文件页面约定位置 */
const APP_VUE_REL = "src/App.vue";

function statKind(p: string): "dir" | "file" | null {
    try { const s = fs.statSync(p); return s.isDirectory() ? "dir" : s.isFile() ? "file" : null; } catch { return null; }
}
function isDir(p: string): boolean { return statKind(p) === "dir"; }
function isFile(p: string): boolean { return statKind(p) === "file"; }
function readTextOrNull(p: string): string | null { try { return fs.readFileSync(p, "utf-8"); } catch { return null; } }
function toPosix(p: string): string { return p.replace(/\\/g, "/"); }
/** 位置 → 1-based 行号（证据要能被模型直接定位） */
function lineOf(src: string, index: number): number {
    let line = 1;
    for (let i = 0; i < index && i < src.length; i++) if (src[i] === "\n") line++;
    return line;
}
/** 压成一行短片段（证据里贴代码不许把换行带进去） */
function oneLine(text: string, max = 140): string { return text.replace(/\s+/g, " ").trim().slice(0, max); }

/** 一级子目录名（排序，跳过产物/依赖）——"前端在哪"与"产物缺失"证据都用它 */
function listDirs(dir: string): string[] {
    try {
        return fs.readdirSync(dir, { withFileTypes: true })
            .filter(e => e.isDirectory() && !FE_SKIP_DIRS.has(e.name))
            .map(e => e.name).sort();
    } catch { return []; }
}

/** 前端工程根：先认 frontend/，否则在一级子目录里找 package.json + src/ 的那个（找不到 = 产物缺失） */
function findFrontendDir(projectDirAbs: string): { abs: string; rel: string } | null {
    const direct = path.join(projectDirAbs, "frontend");
    if (isDir(direct)) return { abs: direct, rel: "frontend" };
    for (const name of listDirs(projectDirAbs)) {
        const abs = path.join(projectDirAbs, name);
        if (isFile(path.join(abs, "package.json")) && isDir(path.join(abs, "src"))) return { abs, rel: name };
    }
    return null;
}

/**
 * 路由文件：标准四路径优先；再兜底扫 src/router/ 目录下任意 ts/js（index.* 优先）。
 * 兜底存在的意义：把 "src/router/index.tsx + routes.ts" 这类写法误判成"根本没有路由"
 * 会连累后面的单文件兜底去查 App.vue（App.vue 通常只有 <router-view/>）→ 误杀真能跑的应用。
 */
function findRouterFile(frontendAbs: string): string | null {
    for (const rel of ROUTER_CANDIDATES) if (isFile(path.join(frontendAbs, rel))) return rel;
    let names: string[];
    try {
        names = fs.readdirSync(path.join(frontendAbs, "src", "router"))
            .filter(n => /\.(ts|tsx|js|jsx|mts|mjs)$/i.test(n))
            .sort((a, b) => (a.startsWith("index.") === b.startsWith("index.") ? a.localeCompare(b) : a.startsWith("index.") ? -1 : 1));
    } catch { return null; }
    const pick = names[0];
    return pick ? `src/router/${pick}` : null;
}

// ---------- 代码扫描（跳字符串/注释后再数括号，防注释里的 path: 被当真路由） ----------

interface BracePair { open: number; close: number }
interface CodeScan { pairs: BracePair[]; comments: { start: number; end: number }[] }

/** 跳过字符串字面量：返回闭合引号之后的下标（未闭合则到行尾/文末） */
function skipStringAt(src: string, i: number): number {
    const quote = src[i] ?? "";
    let j = i + 1;
    while (j < src.length) {
        const c = src[j];
        if (c === "\\") { j += 2; continue; }
        if (c === quote) return j + 1;
        if (c === "\n" && quote !== "`") return j;      // 单行字符串没闭合：不粘到下一行
        j++;
    }
    return src.length;
}

/** 单遍扫描：括号配对 + 注释区间（字符串整体跳过；注释区间用于排除注释里的假 path:） */
function scanCode(src: string): CodeScan {
    const pairs: BracePair[] = [];
    const comments: { start: number; end: number }[] = [];
    const stack: number[] = [];
    let i = 0;
    while (i < src.length) {
        const c = src[i] ?? "";
        const next = src[i + 1] ?? "";
        if (c === "/" && next === "/") {
            const nl = src.indexOf("\n", i);
            const end = nl < 0 ? src.length : nl;
            comments.push({ start: i, end });
            i = end;
            continue;
        }
        if (c === "/" && next === "*") {
            const e = src.indexOf("*/", i + 2);
            const end = e < 0 ? src.length : e + 2;
            comments.push({ start: i, end });
            i = end;
            continue;
        }
        if (c === '"' || c === "'" || c === "`") { i = skipStringAt(src, i); continue; }
        if (c === "{") stack.push(i);
        else if (c === "}") { const open = stack.pop(); if (open !== undefined) pairs.push({ open, close: i }); }
        i++;
    }
    return { pairs, comments };
}

function inComments(scan: CodeScan, index: number): boolean {
    return scan.comments.some(c => c.start <= index && index < c.end);
}

/** index 所在的最内层花括号对象（路由条目对象 `{ path: ..., component: ... }`） */
function enclosingPair(pairs: BracePair[], index: number): BracePair | null {
    let best: BracePair | null = null;
    for (const p of pairs) if (p.open < index && index < p.close && (!best || p.open > best.open)) best = p;
    return best;
}

/** 条目里"有没有可渲染的东西"：component / components（命名视图）/ render / redirect 都算——redirect 会跳到真实页面，同样不是白屏 */
const COMPONENT_REF_RE = /\bcomponents\s*:|\bcomponent\s*:|\brender\s*:|\bredirect\s*:/;

/** 命中 "/" 的兜底写法：通配路由（/:pathMatch(.*)* 等）也会给 "/" 渲染出东西 */
const CATCH_ALL_RE = /^\*$|^\/\*$|^\/:[\w-]*\(\s*\.\*+\s*\)\*?$/;

interface RouteEntry { line: number; path: string; ref: boolean; aliases: string[] }

/** 摘出字符串字面量值（"a", 'b', `c`） */
function quotedStrings(text: string): string[] {
    const out: string[] = [];
    const re = /"([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) out.push(m[1] ?? m[2] ?? m[3] ?? "");
    return out;
}

/** 数路由条目：每个 `path: "<字面量>"` 算一条，条数 = 路由表真实登记的页面数 */
function routeEntries(src: string, scan: CodeScan): RouteEntry[] {
    const out: RouteEntry[] = [];
    const re = /\bpath\s*:\s*(?:"([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
        if (inComments(scan, m.index)) continue;                 // 注释里的 path: 不算登记
        const value = m[1] ?? m[2] ?? m[3] ?? "";
        const pair = enclosingPair(scan.pairs, m.index);
        const body = pair ? src.slice(pair.open, pair.close + 1) : src.slice(m.index);
        // 父路由 + children 的写法：条目对象里含子路由的 component 也照收（/ 由子路由渲染）
        const ref = COMPONENT_REF_RE.test(body);
        const aliasMatch = /\balias\s*:\s*(\[[^\]]*\]|"[^"\n]*"|'[^'\n]*'|`[^`\n]*`)/g.exec(body);
        out.push({ line: lineOf(src, m.index), path: value, ref, aliases: aliasMatch?.[1] ? quotedStrings(aliasMatch[1]) : [] });
    }
    return out;
}

/** 该条目是否承接 "/"（显式 path、空 path 兜底、通配兜底、或 alias: "/"） */
function isHomeEntry(e: RouteEntry): boolean {
    if (e.path === "/" || e.path === "") return true;
    if (CATCH_ALL_RE.test(e.path)) return true;
    return e.aliases.some(a => a === "/" || CATCH_ALL_RE.test(a));
}

/**
 * 路由表是不是"非字面量"（静态数不出来）：addRoute 运行期注册、import.meta.glob 扫描、
 * 或 `const routes = 别处的变量`。命中即放行（宁漏不误杀）——但绝不说"已通过"，如实标注未判定。
 */
function routesTableIsDynamic(src: string): boolean {
    if (/\baddRoute\s*\(/.test(src)) return true;
    if (/\bimport\s*\.\s*meta\s*\.\s*glob\b/.test(src)) return true;
    const decl = /(?:const|let|var)\s+routes\b[^=\n]*=\s*([\s\S]{0,160})/.exec(src);
    if (decl?.[1] !== undefined && !decl[1].trimStart().startsWith("[")) return true;
    return false;
}

/**
 * App.vue 是不是"自带可见内容"（没有路由表时的唯一救赎）。
 * 只看模板：去掉注释/script/style 和 router-view・transition 这类结构标签后，
 * 还剩真实标签或静态文案 = 能渲染；只剩 <router-view /> = 空壳（没有路由表时必然白屏）。
 */
function appVueLooksRendering(src: string): { ok: boolean; why: string } {
    const m = /<template[^>]*>([\s\S]*)<\/template>/i.exec(src);
    const body = m?.[1];
    if (body === undefined || !body.trim()) return { ok: false, why: "App.vue 里没有 <template> 模板段（或模板为空）" };
    const cleaned = body
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "");
    const structural = new Set(["router-view", "router-link", "template", "transition", "transition-group",
        "keep-alive", "teleport", "suspense", "component"]);
    const tags = [...cleaned.matchAll(/<\/?([A-Za-z][\w.-]*)/g)]
        .map(x => (x[1] ?? "").toLowerCase())
        .filter(t => !structural.has(t));
    const text = cleaned.replace(/<[^>]*>/g, "").replace(/\s+/g, "");
    if (tags.length > 0) return { ok: true, why: `模板里有 <${tags[0] ?? ""}> 等 ${tags.length} 个真实标签` };
    if (text.length > 0) return { ok: true, why: `模板里有 ${text.length} 个字符的静态文案` };
    return { ok: false, why: "模板里只有 <router-view /> 这类结构标签，没有任何真实标签或文案" };
}

/**
 * 前端"页面路由真的登记了"的硬闸：纯读盘判定，不跑浏览器、不调 LLM。
 *
 * 判定顺序（每一步都给出路，evidence 里带文件:行 + 计数，模型照抄即可行动）：
 *   ① 找前端工程（frontend/ 或一级子目录里含 package.json + src/）——都没有 = 产物缺失，红。
 *   ② 找路由文件（src/router/index.ts → src/router.ts → … → src/router/ 目录兜底）。
 *   ③ 有路由文件：数 `path:` 条目。
 *        - 0 条 → 就是那行没人看的 warn 变成的硬红（空路由 / 白屏）；
 *        - 有条目但没一条命中 "/"（也无 alias/通配兜底）→ 红（首页缺登记 = 白屏）；
 *        - 命中 "/" 但条目里没有 component/components/render/redirect → 红（匹配得上却无物可渲染）。
 *   ④ 没有路由文件：只有 src/App.vue 自带真实内容才算过（单文件应用不需要路由表）；空壳 App.vue 红。
 *
 * 拿不准的两处一律放行但如实标注"未判定"：路由表非字面量（addRoute / import.meta.glob / 变量转发）、
 * 以及路由表里没有 "/" 却有 beforeEach 守卫引用 "/"（守卫可能重定向到真实页面）。
 */
export function checkFrontendRoutes(projectDirAbs: string): { ok: boolean; detail: string; evidence: string; file?: string } {
    const root = path.resolve(projectDirAbs);
    const fe = findFrontendDir(root);
    if (!fe) {
        const dirs = listDirs(root);
        return {
            ok: false,
            detail: `${root} 下前端产物缺失：既没有 frontend/，也没有任何含 package.json + src/ 的一级子目录——没有前端工程就无从登记页面路由，page.home（无头 Edge 打开 / 要求可见文本 + <input>）必然失败。请先产出前端产物（package.json / index.html / src/main.ts / src/App.vue / src/router/index.ts）。`,
            evidence: `扫描目录 = ${root}；frontend/ 不存在；一级子目录 = ${dirs.length > 0 ? dirs.join("、") : "（无或目录不存在）"}；其中无一同时含 package.json 与 src/`,
        };
    }
    const frontRel = toPosix(fe.rel);
    const routerRel = findRouterFile(fe.abs);
    const appRel = `${frontRel}/${APP_VUE_REL}`;

    if (routerRel) {
        const routerAbs = path.join(fe.abs, routerRel);
        const relPath = `${frontRel}/${toPosix(routerRel)}`;
        const src = readTextOrNull(routerAbs) ?? "";
        const looksLikeRouter = /\bcreateRouter\b/.test(src) || /\broutes\b/.test(src);
        if (looksLikeRouter) {
            const scan = scanCode(src);
            const entries = routeEntries(src, scan);
            const declIndex = src.search(/\b(?:const|let|var)\s+routes\b/);
            const declLine = declIndex >= 0 ? lineOf(src, declIndex) : 1;
            const declSnippet = oneLine(src.slice(declIndex >= 0 ? declIndex : 0));

            if (entries.length === 0) {
                if (routesTableIsDynamic(src)) {
                    return {
                        ok: true,
                        detail: `路由表非字面量（放行·未判定）：${relPath}:${declLine} 有 createRouter/routes，但路由表不是字面量数组（疑似 import.meta.glob / addRoute / 变量转发），静态闸门数不出条目。按"宁漏不误杀"放行——请自行确认运行时确实注册了 path: "/" 的页面，否则 / 会白屏。`,
                        evidence: `${relPath}:${declLine} 路由表声明（片段：${declSnippet}）；path 条目计数 = 0（非字面量，计数不具判定力）`,
                        file: relPath,
                    };
                }
                return {
                    ok: false,
                    detail: `空路由（/ 白屏）：${relPath}:${declLine} 的路由表登记了 0 条带 path 的页面路由——应用可启动但 / 什么都不渲染（就是骨架那行"契约未登记任何页面路由：router 表为空（可运行但不注册任何页面，/ 会白屏）"的降级产物），page.home 渲染检查必失败。请在 routes 数组里登记至少一条真实页面路由，并把首页**同时**注册到 path: "/"（或给主页面条目补 alias: "/"），路由表不许再留空。`,
                    evidence: `${relPath}:${declLine} 路由表声明（片段：${declSnippet}）；path 条目计数 = 0（去重 0）；createRouter ${/createRouter/.test(src) ? "命中" : "缺失"}；App.vue 是否存在 = ${isFile(path.join(fe.abs, APP_VUE_REL)) ? "是" : "否"}（有路由表时空壳 App.vue 救不了场）`,
                    file: relPath,
                };
            }

            const uniq = [...new Set(entries.map(e => e.path))];
            const listed = uniq.slice(0, 8).join("、") + (uniq.length > 8 ? "…" : "");
            const home = entries.find(isHomeEntry);
            if (!home) {
                if (/\bbeforeEach\s*\(/.test(src) && /["'`]\/["'`]/.test(src)) {
                    return {
                        ok: true,
                        detail: `首页未静态命中 "/"（放行·未判定）：${relPath} 的 ${entries.length} 条 path 里没有 "/"，但文件里有 beforeEach 导航守卫且引用了 "/"——守卫可能在运行时把 / 重定向到真实页面，静态闸门证明不了。按"宁漏不误杀"放行；若守卫并不接管 /，请显式登记 path: "/"。`,
                        evidence: `${relPath} path 条目计数 = ${entries.length}（去重 ${uniq.length}）：${listed}；"/" 命中 = 无（alias/通配兜底 = 无）；beforeEach 守卫 = 命中（未判定）`,
                        file: relPath,
                    };
                }
                return {
                    ok: false,
                    detail: `首页缺登记（/ 白屏）：${relPath} 登记了 ${entries.length} 条 path（${listed}），但没有一条能命中 "/"（也没有 alias: "/" 或通配兜底）——用户打开 / 匹配不上任何已登记页面，页面白屏，page.home 渲染检查必失败。请把首页**同时**注册到 path: "/"（或给主页面条目补 alias: "/"）。`,
                    evidence: `${relPath} path 条目计数 = ${entries.length}（去重 ${uniq.length}）：${listed}；"/" 命中 = 无（path/alias/通配三种写法都没命中）；首页候选行 = 无`,
                    file: relPath,
                };
            }
            if (!home.ref) {
                return {
                    ok: false,
                    detail: `首页路由未绑定组件（/ 白屏）：${relPath}:${home.line} 的 path:"${home.path}" 条目里没有 component / components / render / redirect——vue-router 能匹配到这条却没有东西可渲染（/ 白屏），page.home 渲染检查必失败。请在该条目上补组件引用（如 component: () => import("../views/XxxView.vue")）。`,
                    evidence: `${relPath}:${home.line} 命中 "/" 的条目（path:"${home.path}"，alias 数 ${home.aliases.length}）里未出现 component/components/render/redirect；全表 path 条目计数 = ${entries.length}（去重 ${uniq.length}）：${listed}`,
                    file: relPath,
                };
            }
            return {
                ok: true,
                detail: `路由登记正常：${relPath} 登记了 ${entries.length} 条带 path 的页面路由（去重 ${uniq.length} 条），"/" 由 ${relPath}:${home.line}（path:"${home.path}"）承接且已绑定组件——/ 会渲染出真实页面，page.home 渲染检查可过。`,
                evidence: `${relPath}:${declLine} 路由表（片段：${declSnippet}）；path 条目计数 = ${entries.length}（去重 ${uniq.length}）：${listed}；首页条目 = ${relPath}:${home.line} path:"${home.path}" component/components = 命中${home.aliases.length > 0 ? `（alias: ${home.aliases.join("、")}）` : ""}；App.vue = ${appRel}`,
                file: relPath,
            };
        }
        // 位置像路由、内容却既无 createRouter 也无 routes：不当作路由文件（走下面的单文件兜底），避免误杀
    }

    // ④ 没有可用路由文件 → 单文件前端判定
    const appAbs = path.join(fe.abs, APP_VUE_REL);
    const appSrc = readTextOrNull(appAbs);
    const noRouterWhy = routerRel
        ? `${frontRel} 下的 ${toPosix(routerRel)} 既无 createRouter 也无 routes（不算路由文件）`
        : `${frontRel} 下没有路由文件（已查 ${ROUTER_CANDIDATES.map(toPosix).join(" / ")} 与 src/router/ 目录）`;
    if (appSrc === null) {
        return {
            ok: false,
            detail: `无路由也无单文件页（/ 白屏）：${noRouterWhy}，也找不到 ${appRel}——前端没有任何页面入口，/ 必然白屏（page.home 渲染检查必失败）。请产出 ${appRel}（直接渲染页面内容），或补 ${frontRel}/src/router/index.ts 并登记 path: "/"。`,
            evidence: `${noRouterWhy}；${appRel} 是否存在 = 否；page.home 渲染检查要求 / 有可见文本 + <input>`,
        };
    }
    const app = appVueLooksRendering(appSrc);
    if (!app.ok) {
        return {
            ok: false,
            detail: `App.vue 是空壳（/ 白屏）：${noRouterWhy}，而 ${appRel} ${app.why}——没有路由表时它渲染不出任何内容，/ 白屏（page.home 渲染检查必失败）。请直接在 ${appRel} 里渲染页面内容（真实标签/文案/表单），或补 ${frontRel}/src/router/index.ts 并登记 path: "/"。`,
            evidence: `${noRouterWhy}；${appRel} 存在但模板判定为空壳（${app.why}）；单文件兜底要求 App.vue 模板含真实标记或文案`,
            file: appRel,
        };
    }
    return {
        ok: true,
        detail: `单文件前端（通过）：${noRouterWhy}，但 ${appRel} 非空壳（${app.why}）——main.ts 直接挂载 App.vue 就能在 / 渲染出内容，不需要路由表也能过 page.home 渲染检查。`,
        evidence: `${noRouterWhy}；${appRel} 非空壳：${app.why}；单文件路径判定 = 通过（无路由文件时按单文件应用论）`,
        file: appRel,
    };
}


// ============================================================
// ★ R8 事故族（2026-09-24 新增）：DDL 写了但启动时没人执行
//
//   治什么病（a1 实弹，不是假想）：项目根落着 ddl.sql（第一句就是 CREATE TABLE `poll`…），
//   后端也确实跑起来了，但**全项目没有任何地方在启动时读它/执行它**——
//   首个 HTTP 检查就撞 `Table 'poll' doesn't exist` 报 500，验收全线崩。
//   这属于"产物看着齐全、一跑就废"的静默缺陷：编译闸、引用闸、路由闸一个都看不见它
//   （ddl.sql 是合法 SQL、没人 import 它、跟前端路由无关）。
//
//   机制：纯读盘的一次性判定——先找 DDL 载体，再找"启动期施加者"，结论带 file:line 证据：
//     applied      = 找到施加证据（代码读/执行了它 / Spring 的 spring.sql.init 自动执行 / package.json 脚本 / 代码内联建表并执行）
//     not-applied  = 找到 DDL 载体，但全项目既没有施加者、也没有 ORM 自动建表开关 → 真缺陷（ok:false）
//     undecided    = 静态判不了（没有 DDL 载体 / 有 ORM 自动建表 / 目录不存在 / 大文件没读）→ 写进 note，放行
//
//   铁律：**宁漏不误杀**——本函数拿不准时一律 ok:true 并把"未判定"如实写进 note，
//   绝不假装通过、也绝不把不确定当缺陷；只有"明确有 DDL + 明确没人施加"才报红。
//   纯函数（只读 fs）、同步、零 LLM、零进程。
// ============================================================

/** 迁移自举三态：见上方事故族说明 */
export type MigrationBootstrapStatus = "applied" | "not-applied" | "undecided";

/** 迁移自举结论：ok 只在 status="not-applied"（=真缺陷）时为 false；undecided 一律 true（宁漏不误杀） */
export interface MigrationBootstrapResult {
    ok: boolean;
    /** DDL 载体（相对 projectDirAbs、斜杠分隔；.sql 优先，其次含 CREATE TABLE 的代码文件）；null=没找到 */
    sqlFile: string | null;
    /** 启动期施加证据（"文件:行 ◇片段"）；null=没找到施加者 */
    appliedBy: string | null;
    /** 载体里第一处 CREATE TABLE 的定位（"文件:行"）；null=载体里没有 CREATE TABLE（或没找到载体） */
    ddlAt: string | null;
    status: MigrationBootstrapStatus;
    /** 人读中文结论 + 出路（拿不准时如实写"未判定"，绝不假装通过） */
    note: string;
}

/** 迁移扫描跳过的目录：依赖/产物/缓存不参与"谁施加 DDL"的判断 */
const MIGRATION_SKIP_DIRS = new Set([
    "node_modules", "dist", "build", "target", "out", "bin", "obj", ".git",
    "coverage", "__pycache__", ".venv", "venv", ".idea", ".gradle", ".mvn",
    ".next", ".nuxt", ".output", ".vite", ".cache", "tmp", "temp",
]);

/** 只读这些后缀的文本（其余二进制/图片直接跳过）；无后缀的构建脚本用 MIGRATION_BARE_NAMES 认 */
const MIGRATION_TEXT_EXT = /\.(sql|ts|tsx|mts|cts|js|jsx|mjs|cjs|py|java|kt|kts|go|rb|php|cs|yml|yaml|properties|json|sh|bash|zsh|ps1|cmd|bat|toml|ini|conf|xml|gradle|env)$/i;
const MIGRATION_BARE_NAMES = new Set(["makefile", "dockerfile", "procfile", "justfile"]);

/** 扫描上限：大项目不许把闸门拖死（超出部分如实体现在 note 的计数里） */
const MIGRATION_MAX_FILES = 800;
const MIGRATION_MAX_BYTES = 512 * 1024;

/** DDL 语句 / 内联建表 / 执行调用 / SQL 文件引用 / Spring SQL init 的识别正则 */
const MIGRATION_CREATE_TABLE_RE = /\bcreate\s+table\b/i;
const MIGRATION_OTHER_STMT_RE = /\b(?:alter\s+table|insert\s+into|create\s+index|drop\s+table)\b/i;
const MIGRATION_EXEC_HINT_RE = /\.\s*(?:exec|executescript|execute|query|run|prepare|all|raw)\s*\(|executeSqlScript|ResourceDatabasePopulator|\bexec\s*\(|create_all\s*\(/i;
const MIGRATION_SPRING_SQL_INIT_RE = /spring\s*\.\s*sql|sql\s*[.:]\s*init|schema-locations|data-locations/i;
const MIGRATION_JAVA_SQL_HINT_RE = /executeSqlScript|ResourceDatabasePopulator|@Sql\s*\(/;
/** 迁移类脚本名（package.json scripts）：点名 DDL 文件的已由"文件引用"通道覆盖，这里兜住通用迁移命令 */
const MIGRATION_SCRIPT_HINT_RE = /\b(?:migrate|migration|initdb|db:init|db:setup|db:migrate|db:seed|create_?tables?|prisma|alembic|flyway|liquibase|typeorm|sequelize|knex)\b/i;
/** ORM 自动建表开关：命中即"表可能由 ORM 建出来"，静态判不了 → undecided（不报缺陷） */
const MIGRATION_AUTO_DDL_RE = /ddl-auto\s*[:=]\s*(?:update|create|create-drop)|synchronize\s*[:=]\s*true|create_all\s*\(|db\.create_all|prisma\s+migrate|auto[_-]?migrate\s*[:=]\s*true|\.sync\s*\(\s*\{[^)]*force/i;

interface ScannedTextFile { rel: string; content: string }

/** 项目文本文件快照（名字排序 → 确定性；跳依赖/产物；隐藏文件/目录=引擎状态，不参与判定） */
function scanMigrationTextFiles(root: string): { files: ScannedTextFile[]; skipped: number } {
    const out: ScannedTextFile[] = [];
    let skipped = 0;
    const walk = (dir: string, rel: string) => {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const e of entries) {
            if (out.length >= MIGRATION_MAX_FILES) return;
            if (e.name.startsWith(".") || e.name.startsWith("_")) continue;   // .architect-state.json / _developer：引擎状态不是应用产物
            const r = rel ? `${rel}/${e.name}` : e.name;
            const abs = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (!MIGRATION_SKIP_DIRS.has(e.name.toLowerCase())) walk(abs, r);
                continue;
            }
            if (!MIGRATION_TEXT_EXT.test(e.name) && !MIGRATION_BARE_NAMES.has(e.name.toLowerCase())) { skipped++; continue; }
            try {
                if (fs.statSync(abs).size > MIGRATION_MAX_BYTES) { skipped++; continue; }
                out.push({ rel: toPosix(r), content: fs.readFileSync(abs, "utf-8") });
            } catch { skipped++; }
        }
    };
    walk(root, "");
    return { files: out, skipped };
}

/** 该文件是不是"可能施加 SQL"的候选（代码/脚本/配置/构建文件；.sql 自身不算施加者） */
function isMigrationApplierCandidate(rel: string): boolean {
    if (/\.sql$/i.test(rel)) return false;
    const base = path.posix.basename(rel);
    return MIGRATION_TEXT_EXT.test(base) || MIGRATION_BARE_NAMES.has(base.toLowerCase());
}

/** 文本里第一处出现 needle 的下标（大小写不敏感）；-1=没有 */
function indexOfLoose(content: string, needle: string): number {
    if (!needle) return -1;
    return content.toLowerCase().indexOf(needle.toLowerCase());
}

/** 下标所在整行原文（证据片段用；越界安全） */
function lineAt(content: string, index: number): string {
    if (index < 0) return "";
    const start = content.lastIndexOf("\n", index) + 1;
    const end = content.indexOf("\n", index);
    return content.slice(start, end < 0 ? content.length : end);
}

/** "文件:行 ◇片段" 形式的证据（模型照抄即可行动） */
function migrationEvidence(rel: string, content: string, index: number): string {
    return `${rel}:${lineOf(content, Math.max(0, index))} ◇「${oneLine(lineAt(content, index), 100)}」`;
}

/**
 * ★ TASK3 核心：迁移/DDL 自举判定（纯函数、只读盘、零 LLM 零进程）。
 *
 * 判定链（每步都可能"未判定"，未判定一律放行并写进 note）：
 *   ① 载体：.sql 里含 CREATE TABLE（首选）→ 其次代码内联 CREATE TABLE → 再次只含其它语句的 .sql；都没有=undecided。
 *   ② 施加者（任一命中即 applied，证据取第一条，按文件名字典序保证确定性）：
 *      · 代码/脚本/构建文件里点名了载体的文件名（读进来执行、`sqlite3 app.db < init.sql`、Dockerfile/Makefile…）
 *      · 代码内联 CREATE TABLE + 执行调用（表由代码自己建，R8 的 500 不会发生；note 会提示与 .sql 可能不一致）
 *      · Spring 的 spring.sql.init / schema-locations + mode=always（骨架就是这条路）
 *      · Java 的 executeSqlScript / ResourceDatabasePopulator / @Sql
 *   ③ 都没找到但有 ORM 自动建表开关（ddl-auto=update / synchronize:true / create_all…）→ undecided。
 *   ④ 都没有 → not-applied（ok:false，带"该改哪儿"的两条出路）。
 *
 * 明知会漏的两种（都朝"不误杀"方向）：把 DDL 读进来却在别处执行、被否定的注释里提到
 * `-- TODO: 手动执行 ddl.sql`——静态证明不了运行期行为，一律按"可能有施加者"放行。
 */
export function checkMigrationBootstrap(projectDirAbs: string): MigrationBootstrapResult {
    const root = path.resolve(projectDirAbs ?? "");
    if (statKind(root) !== "dir") {
        return {
            ok: true, sqlFile: null, appliedBy: null, ddlAt: null, status: "undecided",
            note: `迁移自举未判定（不报缺陷）：${toPosix(root)} 不是可读目录（产物还没落盘？），无法判断 DDL 是否存在、是否被施加——按"宁漏不误杀"放行，请自行确认启动时会建表。`,
        };
    }
    const { files, skipped } = scanMigrationTextFiles(root);
    const scanned = `已扫 ${files.length} 个文本文件${skipped > 0 ? `（另跳过 ${skipped} 个非文本/超大/读失败文件）` : ""}`;

    // ① DDL 载体
    const ddlSql = files.find(f => /\.sql$/i.test(f.rel) && MIGRATION_CREATE_TABLE_RE.test(f.content));
    const inlineDdl = files.find(f => !/\.sql$/i.test(f.rel) && MIGRATION_CREATE_TABLE_RE.test(f.content));
    const otherSql = files.find(f => /\.sql$/i.test(f.rel) && MIGRATION_OTHER_STMT_RE.test(f.content));
    const carrier = ddlSql ?? inlineDdl ?? otherSql ?? null;
    if (!carrier) {
        return {
            ok: true, sqlFile: null, appliedBy: null, ddlAt: null, status: "undecided",
            note: `迁移自举未判定（不报缺陷）：${scanned}，没有找到任何含 CREATE TABLE 的 .sql 或代码文件——可能本阶段确实没有表结构，也可能建表全在数据库驱动的自动同步里，静态判不了。按"宁漏不误杀"放行；若启动后接口报 Table '…' doesn't exist，请检查建表语句到底有没有被执行。`,
        };
    }
    const ddlIndex = carrier.content.search(MIGRATION_CREATE_TABLE_RE);
    const ddlAt = ddlIndex >= 0 ? `${carrier.rel}:${lineOf(carrier.content, ddlIndex)}` : null;
    const carrierBase = path.posix.basename(carrier.rel);

    // ② 施加者
    const appliers: string[] = [];
    const autoDdl: string[] = [];
    for (const f of files) {
        if (isMigrationApplierCandidate(f.rel)) {
            // ②-1 点名了 DDL 文件（读进来执行 / 命令行重定向 / Dockerfile·Makefile / package.json 脚本值）
            if (f.rel !== carrier.rel) {
                const at = indexOfLoose(f.content, carrierBase);
                if (at >= 0) appliers.push(migrationEvidence(f.rel, f.content, at));
            }
            // ②-2 代码内联建表 + 执行调用（代码自己建表；载体是 .sql 且代码另建一份时 note 会点出来）
            if (MIGRATION_CREATE_TABLE_RE.test(f.content) && MIGRATION_EXEC_HINT_RE.test(f.content)) {
                appliers.push(`${migrationEvidence(f.rel, f.content, f.content.search(MIGRATION_CREATE_TABLE_RE))}（内联 CREATE TABLE + 执行调用）`);
            }
            // ②-3 Spring 的 spring.sql.init：schema.sql 由启动流程自动执行（骨架骨架就是这么配的）
            if (/(^|\/)application[-\w.]*\.(?:ya?ml|properties)$/i.test(f.rel)
                && MIGRATION_SPRING_SQL_INIT_RE.test(f.content) && /always/i.test(f.content)
                && (indexOfLoose(f.content, carrierBase) >= 0 || /^(?:schema|data)\.sql$/i.test(carrierBase))) {
                appliers.push(`${migrationEvidence(f.rel, f.content, f.content.search(MIGRATION_SPRING_SQL_INIT_RE))}（spring.sql.init 启动时执行）`);
            }
            // ②-4 Java 显式执行脚本
            if (/\.java$/i.test(f.rel) && MIGRATION_JAVA_SQL_HINT_RE.test(f.content)) {
                appliers.push(`${migrationEvidence(f.rel, f.content, f.content.search(MIGRATION_JAVA_SQL_HINT_RE))}（Java 启动期执行 SQL 脚本）`);
            }
            // ②-5 package.json 里的迁移脚本（脚本名/命令是迁移类即算：start 依赖它或部署时跑它）
            if (path.posix.basename(f.rel).toLowerCase() === "package.json" && MIGRATION_SCRIPT_HINT_RE.test(f.content)) {
                appliers.push(`${migrationEvidence(f.rel, f.content, f.content.search(MIGRATION_SCRIPT_HINT_RE))}（package.json 迁移脚本）`);
            }
        }
        // ③ ORM 自动建表（不是 DDL 施加者，但会让"表不存在"不成立）
        if (MIGRATION_AUTO_DDL_RE.test(f.content)) {
            autoDdl.push(migrationEvidence(f.rel, f.content, f.content.search(MIGRATION_AUTO_DDL_RE)));
        }
    }

    const [firstApplier = ""] = appliers;
    if (firstApplier) {
        const more = appliers.length > 1 ? `（另有 ${appliers.length - 1} 条证据）` : "";
        return {
            ok: true, sqlFile: carrier.rel, appliedBy: firstApplier, ddlAt, status: "applied",
            note: `DDL 自举正常：载体 ${carrier.rel}${ddlAt ? `（建表语句在 ${ddlAt}）` : ""} 在启动期会被施加，证据 = ${firstApplier}${more}；HTTP 检查不会因"表不存在"报 500。`,
        };
    }
    const [firstAuto = ""] = autoDdl;
    if (firstAuto) {
        return {
            ok: true, sqlFile: carrier.rel, appliedBy: null, ddlAt, status: "undecided",
            note: `迁移自举未判定（不报缺陷）：找到 DDL 载体 ${carrier.rel}${ddlAt ? `（建表语句在 ${ddlAt}）` : ""}，但全项目没有"启动时读它/执行它"的证据；不过发现了 ORM 自动建表开关（${firstAuto}）——表可能仍会由 ORM 建出来，静态判不了会不会 500。请自行确认：要么让启动流程执行 ${carrier.rel}，要么确认 ORM 自动建表与它一致（不一致时接口会报 Table '…' doesn't exist）。`,
        };
    }
    return {
        ok: false, sqlFile: carrier.rel, appliedBy: null, ddlAt, status: "not-applied",
        note: `DDL 写了没人执行（R8）：找到 DDL 载体 ${carrier.rel}${ddlAt ? `（建表语句在 ${ddlAt}）` : ""}，但${scanned}里没有任何地方在启动时读它/执行它，也没有 ORM 自动建表开关——后端起来了表却不存在，HTTP 检查会撞 Table '…' doesn't exist 报 500。请二选一：① 启动时真实执行它（Node：db.exec(readFileSync("${carrier.rel}", "utf-8"))；Python：conn.executescript(open("${carrier.rel}").read())；Spring：spring.sql.init.mode=always + schema-locations 指到它）；② 在 package.json 里加 db:init 脚本并让 start 依赖它。`,
    };
}
