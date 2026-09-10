// ============================================================
// javaDiagnostics.ts —— javac 诊断分类器（纯函数，零 LLM 零 IO）
//
// 存在理由（M0 实测 F-1，2026-09-10）：
//   本机 javac 默认按 GBK 读源码，而生成物是 UTF-8 含中文注释 → 每个中文注释都报
//   `unmappable character`。第一版统计把它漏掉，得出"语法通过率 100%"的假绿。
//   因此本分类器采用【白名单忽略】纪律：
//     - 只有明确列出的诊断种类才被"忽略"（依赖/类型类，缺 classpath 时必然出现）
//     - 其余一切（含未识别）一律计入 other，并且 other>0 视为异常信号，绝不静默算过
//
// 语言固定英文（调用方给 javac 传 -J-Duser.language=en），保证正则跨机器稳定。
// ============================================================

export type DiagnosticKind = "syntax" | "dependency" | "encoding" | "other";

export interface JavaDiagnostic {
    kind: DiagnosticKind;
    file: string;
    line: number;
    message: string;
    raw: string;
}

export interface JavaDiagnosticsReport {
    /** javac 退出码（0=无错；1=有诊断；2=命令行错误；3/4=系统错误） */
    exitCode: number;
    syntax: JavaDiagnostic[];
    dependency: JavaDiagnostic[];
    encoding: JavaDiagnostic[];
    /** ★ 未归类诊断：非空即视为异常，调用方必须报警而不是放行 */
    other: JavaDiagnostic[];
    /** 是否可判定为"语法干净"（语法 0 + 编码 0 + other 0） */
    syntaxClean: boolean;
}

/** 语法类：这些是"代码本身写错了"，闸门必须拒绝 */
const SYNTAX_PATTERNS: RegExp[] = [
    /expected/i,                                     // ';' expected / <identifier> expected / ')' expected
    /reached end of file while parsing/i,
    /illegal start of (expression|type|statement)/i,
    /not a statement/i,
    /unclosed (string|character|comment)/i,
    /class, interface, enum, or record expected/i,
    /invalid method declaration/i,
    /malformed/i,
    /orphaned/i,
    /duplicate (case|default)/i,
    /is public, should be declared in a file named/i,
    /missing return statement/i,
    /variable .* might not have been initialized/i,
    /非法的表达式开始|需要|找不到符号/i,              // 中文兜底（万一 -J 语言注入失效）
];

/** 依赖/类型类：缺 classpath 时必然出现，闸门阶段【允许忽略】（但它们不是"通过"的证据） */
const DEPENDENCY_PATTERNS: RegExp[] = [
    /package .* does not exist/i,
    /cannot find symbol/i,
    /cannot access/i,
    /incompatible types/i,
    /method .* cannot be applied/i,
    /no suitable (method|constructor)/i,
    /is not abstract and does not override/i,
    /cannot be applied to given types/i,
    /has private access/i,
    /bad operand types/i,
    /unreported exception/i,
    /程序包.*不存在|找不到符号|不兼容的类型/i,
];

/** 编码类：★★ 必须单列且绝不忽略（F-1 的教训） */
const ENCODING_PATTERNS: RegExp[] = [
    /unmappable character/i,
    /malformed input/i,
    /illegal character/i,          // 常见于 BOM / 非法字节
    /解码错误|不可映射/i,
];

/** 一行诊断的解析：<path>:<line>: error: <message> */
const DIAG_RE = /^(.*?):(\d+):\s*error:\s*(.*)$/;

export function classifyJavaDiagnostic(raw: string): JavaDiagnostic | null {
    const m = DIAG_RE.exec(raw.trim());
    if (!m) return null;
    const [, fileRaw, lineText, msgRaw] = m;
    const file = fileRaw ?? "";
    const message = msgRaw ?? "";
    const line = Number(lineText);
    // 判定顺序：编码 → 依赖 → 语法 → other
    // 顺序刻意让"编码"优先：unmappable 行里可能同时含其他关键词，必须先被抓住
    const kind: DiagnosticKind =
        ENCODING_PATTERNS.some(re => re.test(message)) ? "encoding"
            : DEPENDENCY_PATTERNS.some(re => re.test(message)) ? "dependency"
                : SYNTAX_PATTERNS.some(re => re.test(message)) ? "syntax"
                    : "other";
    return { kind, file: file ?? "", line: Number.isFinite(line) ? line : 0, message, raw: raw.trim() };
}

/**
 * 从 javac 的完整输出文本里提取诊断。
 * 只认 `: error: ` 行——warning/note 不参与判定（闸门不做风格警察）。
 */
export function parseJavaDiagnostics(output: string, exitCode = 1): JavaDiagnosticsReport {
    const report: JavaDiagnosticsReport = {
        exitCode, syntax: [], dependency: [], encoding: [], other: [], syntaxClean: false,
    };
    for (const rawLine of String(output ?? "").split(/\r?\n/)) {
        const d = classifyJavaDiagnostic(rawLine);
        if (!d) continue;
        report[d.kind].push(d);
    }
    report.syntaxClean = report.syntax.length === 0 && report.encoding.length === 0 && report.other.length === 0;
    return report;
}

/** 给闸门用的可读短句（进自修 feedback；只报"代码自身写错"的类，依赖类不入 feedback，避免误导模型改 import） */
export function syntaxFeedback(report: JavaDiagnosticsReport, limit = 5): string[] {
    const items = [...report.syntax, ...report.encoding, ...report.other];
    return items.slice(0, limit).map(d => `${d.file.split(/[\\/]/).pop()}:${d.line} ${d.message}`);
}

/** 一行摘要（日志/报告用） */
export function summarizeJavaDiagnostics(report: JavaDiagnosticsReport): string {
    return `exit=${report.exitCode} 语法=${report.syntax.length} 编码=${report.encoding.length} 依赖/类型=${report.dependency.length} 未归类=${report.other.length}`;
}
