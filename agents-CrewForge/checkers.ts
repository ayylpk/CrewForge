// ============================================================
// checkers.ts —— T1 工位编译自修闸门（v3 §2-T1，2026-09-08）
//
//   治什么病（F5 缝合四坑的机器可检部分）：代码写盘即交付，
//   语法错/引用炸裸奔到看板。本文件提供**写盘前**的纯代码校验：
//     checkJsLike  esbuild.transform 查 ts/jsx 语法 + 相对 import 目标存在性（F5③）+ 目标导出名核验（F5②）
//     checkVue     @vue/compiler-sfc parse + compileTemplate（模板残缺/标签不闭合）+ script 段过 esbuild + import 扫描
//     checkPy      PATH 有 python 就真 py_compile；没有退化为括号/引号配平文本校验（F-卡面降级阀）
//     checkJson    JSON.parse（地基 package.json 等同款坑）
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
    return shown.join("\n") + (rest > 0 ? `\n…（共 ${all.length} 个文件，其余 ${rest} 个略）` : "");
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
 * p2 的 smoking gun：模型被打回后只是给 import 加个 .ts 后缀继续猜（TagManager 同一错误复读 6 次）——
 * 报错不带出路，2 次名额就是白烧。候选两路（纯代码零 LLM）：
 *   ① 路径名相似：spec 末段与文件名互相包含（request↔requestHelper、middleware↔middlewares 这类漂移）
 *   ② 导出名命中：想 import 的 { getUsers } 真实存在于别的文件（如 LLM 自创的 services/api.js）
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
    // ① 路径名相似（cap 3，短名互含噪音大，≥3 字符才配）
    for (const p of pool) {
        if (cands.length >= 3) break;
        if (normRel(p) === self) continue;
        const name = (p.split("/").pop() ?? "").replace(/\.[^.]+$/, "").toLowerCase();
        if (name.length >= 3 && (name.includes(base) || base.includes(name))) {
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
            if (seen.has(p) || n === self || !/\.(ts|tsx|js|jsx|mjs|vue)$/i.test(n)) continue;
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

async function checkImports(filePath: string, code: string, known: GateKnown): Promise<CheckProblems> {
    const problems: CheckProblems = [];
    for (const { spec, named } of extractImports(code)) {
        if (!spec.startsWith("./") && !spec.startsWith("../")) continue;   // 裸包名/@别名/http：磁盘上没有 node_modules，一律放行（宁漏不误杀）
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
export async function checkJsLike(filePath: string, code: string, known: GateKnown): Promise<CheckProblems> {
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
    problems.push(...await checkImports(filePath, code, known));
    return problems;
}

/** .vue 单文件组件：sfc parse 结构闸 + 模板编译闸 + script 段过 esbuild + import 扫描（F5①③ 的 vue 侧入口） */
export async function checkVue(filePath: string, code: string, known: GateKnown): Promise<CheckProblems> {
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
        const r = compileTemplate({ source: descriptor.template.content, filename: filePath, id: "gate" });
        for (const e of r.errors) problems.push(`模板编译错误：${String(typeof e === "string" ? e : (e as any)?.message ?? e).slice(0, 160)}`);
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
        problems.push(...await checkImports(filePath, blk.content, known));
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

const DISPATCH: [RegExp, (f: string, c: string, k: GateKnown) => Promise<CheckProblems>][] = [
    [/\.vue$/i, checkVue],
    [/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i, checkJsLike],
    [/\.py$/i, checkPy],
    [/\.json$/i, checkJson],
];

/**
 * 单文件闸门总入口：按扩展名分派；css/yml/md 等不认识的格式直接绿（放行原则）。
 * 返回错误短句列表（拼 feedback 用），空=可写盘。
 */
export async function checkFile(filePath: string, code: string, known: GateKnown): Promise<CheckProblems> {
    if (!code) return [];
    for (const [re, fn] of DISPATCH) {
        if (re.test(filePath)) return await fn(filePath, code, known);
    }
    return [];
}

/** 批校验（architect bootstrap 用）：批内互引先注入 known；返回 path→错误列表（只含红的文件） */
export async function checkBatch(files: { path: string; content: string }[], known: GateKnown): Promise<Map<string, CheckProblems>> {
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
        const problems = await checkFile(f.path, f.content ?? "", batchKnown);
        if (problems.length) out.set(f.path, problems);
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
