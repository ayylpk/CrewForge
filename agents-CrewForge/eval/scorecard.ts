// ============================================================
// scorecard.ts —— 评测评分卡（纯函数，零 LLM 零 IO）
//
//   设计纪律（对齐不变量 1/2）：
//     · 只记**机器可验证的事实**，不做主观质量打分（不给"综合分 87"这种数字）
//     · 每项三态：ok=true / ok=false / ok=null（未能判定，必须显式标注，不许折算成通过）
//     · "未校验" 永远不等于 "通过"（M0 的 F-1 假绿教训）
// ============================================================

import type { JavaDiagnosticsReport } from "../engine/exec/static/javaDiagnostics";

export interface FileEntryStat {
    path: string;
    present: boolean;
}

export interface JavaSnapshot {
    fileCount: number;
    /** 是否真的跑了 javac（false = 环境无 javac，结论只能是"未校验"） */
    checked: boolean;
    report?: JavaDiagnosticsReport;
    toolError?: string;
    summary: string;
}

export interface RunSnapshot {
    runId: string;
    dir: string;
    fileCount: number;
    byExt: Record<string, number>;
    entryFiles: FileEntryStat[];
    /** index.html 的脚本入口指向（诊断用；null=文件不存在或未解析到） */
    indexHtmlScript: string | null;
    testReports: number;
    taskEvidence: number;
    hasContracts: boolean;
    contractsChars: number;
    frontendNodeModules: boolean;
    java: JavaSnapshot;
}

export interface Expectations {
    /** 必须具备的引擎拥有件（相对路径） */
    requiredEntryFiles: string[];
    /** 期望的最少测试留档数（默认 1：至少要有一份判定记录） */
    minTestReports?: number;
    requireContracts?: boolean;
}

export interface ScoreItem {
    key: string;
    /** true=事实成立；false=事实不成立；null=未能判定（跳过，不计入通过） */
    ok: boolean | null;
    detail: string;
}

export interface ScoreCard {
    runId: string;
    items: ScoreItem[];
    pass: number;
    fail: number;
    skip: number;
    /** 通过率分母 = pass+fail（skip 不入分母），无判定项时为 null */
    ratio: number | null;
}

export const DEFAULT_EXPECTATIONS: Expectations = {
    requiredEntryFiles: [
        "frontend/index.html",
        "frontend/src/main.ts",
        "frontend/src/App.vue",
        "frontend/src/router/index.ts",
    ],
    minTestReports: 1,
    requireContracts: true,
};

export function scoreSnapshot(s: RunSnapshot, exp: Expectations = DEFAULT_EXPECTATIONS): ScoreCard {
    const items: ScoreItem[] = [];
    const push = (key: string, ok: boolean | null, detail: string) => items.push({ key, ok, detail });

    // 1. 引擎拥有件齐全度
    for (const req of exp.requiredEntryFiles) {
        const hit = s.entryFiles.find(e => e.path.replace(/\\/g, "/").toLowerCase() === req.toLowerCase());
        push(`entry:${req}`, hit?.present === true, hit?.present ? "存在" : "缺失（引擎拥有件未直出）");
    }

    // 2. HTML 入口指向（诊断：指向错=前端起不来）
    const script = s.indexHtmlScript;
    push("indexHtml:scriptTarget",
        script == null ? null : /src\/main\.(ts|js|tsx)/i.test(script),
        script == null ? "未解析到脚本入口（可能无 index.html）" : `指向 ${script}`);

    // 3. Java 语法/编码/未归类（★ 未校验 = null，不折算成通过）
    if (!s.java.fileCount) {
        push("java:syntax", null, "本轮无 Java 文件");
    } else if (!s.java.checked) {
        push("java:syntax", null, `未校验：${s.java.toolError ?? "javac 不可用"}（未校验 ≠ 通过）`);
    } else if (s.java.toolError) {
        push("java:syntax", null, `javac 工具级错误：${s.java.toolError}`);
    } else {
        const r = s.java.report!;
        push("java:syntax", r.syntax.length === 0, `语法错 ${r.syntax.length} 处${r.syntax.length ? "：" + r.syntax.slice(0, 3).map(d => `${d.file.split(/[\\/]/).pop()}:${d.line} ${d.message}`).join("；") : ""}`);
        push("java:encoding", r.encoding.length === 0, `编码错 ${r.encoding.length} 处`);
        // 未归类诊断：非空即异常（白名单忽略纪律）
        push("java:unclassified", r.other.length === 0, `未归类诊断 ${r.other.length} 处${r.other.length ? "：" + r.other.slice(0, 3).map(d => d.message).join("；") : ""}`);
        // 依赖/类型诊断仅作诊断信息（缺 classpath 必然出现），不参与判定
        push("java:typeLayer", null, `依赖/类型诊断 ${r.dependency.length} 处（无 classpath，需 M3 用 mvnw compile 复核）`);
    }

    // 4. 判定留档（无留档 = 判定阶段没跑完，这是 p9 的实况）
    const minReports = exp.minTestReports ?? 1;
    push("evidence:testReports", s.testReports >= minReports, `测试报告 ${s.testReports} 份（期望 ≥ ${minReports}）`);

    // 5. 契约
    if (exp.requireContracts) {
        push("contract:present", s.hasContracts, s.hasContracts ? `存在（${s.contractsChars} 字符）` : "缺失（工位将按无契约运行）");
    }

    // 6. 产物规模（事实陈述，不判定）
    push("artifact:fileCount", null, `产物 ${s.fileCount} 个文件`);

    const pass = items.filter(i => i.ok === true).length;
    const fail = items.filter(i => i.ok === false).length;
    const skip = items.filter(i => i.ok === null).length;
    return { runId: s.runId, items, pass, fail, skip, ratio: pass + fail === 0 ? null : pass / (pass + fail) };
}

/** 一行摘要：`p9 通过 3 失败 4 跳过 3 (0.43)` */
export function summarizeScoreCard(c: ScoreCard): string {
    return `${c.runId} 通过=${c.pass} 失败=${c.fail} 未判定=${c.skip} 比率=${c.ratio == null ? "n/a" : c.ratio.toFixed(2)}`;
}
