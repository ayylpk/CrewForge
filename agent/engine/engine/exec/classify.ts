// ============================================================
// classify.ts —— 失败分类与分流（纯函数，零 LLM）
//
//   铁律（主计划不变量 8）：**失败分类只能来自机器信号**（退出码 + 错误指纹 + 工具身份）。
//   模型只能当 tiebreaker，且结论必须引用证据原文——否则它就退化成"换个名字的正则裁判"。
//
//   六类 → 六个去处（程序决定，模型不参与）：
//     COMPILE  → 实现器（把编译器原文喂回去修）
//     CONTRACT → 规划器（重生成该切片契约）
//     TEST     → 实现器（业务行为不对）
//     ENV      → 环境恢复（缺依赖/端口/网络——改代码解决不了）
//     SPEC     → 用户（需求自相矛盾，必须人拍板）
//     BUDGET   → 停（暂停并报告，不续烧）
// ============================================================

import type { FailureClass } from "../run/state";

export interface FailureEvidence {
    /** 验证层给出的结论（ok/compile_error/env_error/tool_error/failed/skipped_unverified…） */
    outcome: string;
    exitCode?: number;
    /** 失败工具身份（javac/mvn/vite/bun test…） */
    tool?: string;
    output?: string;
    diagnostics?: { message: string }[];
    /** Analyst 产出的未决问题（非空 → SPEC） */
    openQuestions?: string[];
    budgetExceeded?: boolean;
}

export interface ClassificationResult {
    cls: FailureClass;
    confidence: "high" | "medium" | "low";
    reasons: string[];
}

/** 环境类指纹（与代码错严格分开：改代码解决不了缺依赖） */
const ENV_FINGERPRINTS: [RegExp, string][] = [
    [/Could not resolve dependencies/i, "Maven 依赖无法解析"],
    [/Cannot access central|Could not transfer artifact/i, "仓库不可达"],
    [/EADDRINUSE|port .* already allocated|address already in use/i, "端口被占用"],
    [/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|Connection refused/i, "网络/服务不可达"],
    [/npm ERR! code (ENOENT|ERESOLVE|ETIMEDOUT|EACCES)/i, "npm 环境错误"],
    [/dependency .* not found|Cannot find module '.*' *$/im, "依赖缺失"],
];

/** 编译类指纹 */
const COMPILE_FINGERPRINTS: [RegExp, string][] = [
    [/COMPILATION ERROR/i, "Maven 编译失败"],
    [/error TS\d+/i, "TypeScript 编译错"],
    [/reached end of file while parsing|';' expected|<identifier> expected/i, "Java 语法错"],
    [/Failed to resolve import|Transform failed|\[vite\][^\n]*error/i, "构建期解析失败"],
    [/cannot find symbol|incompatible types|constructor .* cannot be applied/i, "Java 类型错（含幻觉 API）"],
];

/** 契约类指纹（引擎自己的断言脚本输出） */
const CONTRACT_FINGERPRINTS: [RegExp, string][] = [
    [/期望状态 \d+，实际 \d+/i, "HTTP 状态码不符"],
    [/字段断言失败|期望类型 |字段不存在|字段为空/i, "响应字段不符契约"],
    [/契约测试：失败/i, "契约测试有失败项"],
];

/** 测试类指纹 */
const TEST_FINGERPRINTS: [RegExp, string][] = [
    [/Tests run:.*Failures: [1-9]/i, "单测失败"],
    [/AssertionError|assertion failed/i, "断言失败"],
    [/^\s*FAILED\b/m, "测试框架报 FAILED"],
];

function scan(pairs: [RegExp, string][], text: string): string[] {
    return pairs.filter(([re]) => re.test(text)).map(([, why]) => why);
}

/**
 * 分类。判定顺序刻意如此：
 *   预算 → 需求 → 工具级 → 环境 → 编译 → 契约 → 测试 → 未知
 * （环境优先于编译：缺依赖时 Maven 根本走不到编译阶段，报错里同时含两类关键词）
 */
export function classifyFailure(ev: FailureEvidence): ClassificationResult {
    const text = `${ev.output ?? ""}\n${(ev.diagnostics ?? []).map(d => d.message).join("\n")}`;

    if (ev.budgetExceeded) return { cls: "BUDGET", confidence: "high", reasons: ["预算计数器超限"] };
    if ((ev.openQuestions?.length ?? 0) > 0) {
        return { cls: "SPEC", confidence: "high", reasons: [`需求存在未决问题 ${ev.openQuestions!.length} 条（机器无法判定，必须人拍板）`] };
    }
    if (ev.outcome === "tool_error" || (ev.exitCode != null && ev.exitCode < 0)) {
        return { cls: "ENV", confidence: "medium", reasons: [`工具级错误（${ev.tool ?? "未知工具"}，exitCode=${ev.exitCode ?? "n/a"}）——按环境问题处理`] };
    }
    // ★ 指纹优先于 outcome：能给出**具体**原因（"缺哪个依赖/哪个端口"）比"验证层说是环境问题"有用得多，
    //   分流结果一致，但报告与自修材料质量差一个量级。
    const env = scan(ENV_FINGERPRINTS, text);
    if (env.length > 0) return { cls: "ENV", confidence: "high", reasons: env };
    if (ev.outcome === "env_error") return { cls: "ENV", confidence: "high", reasons: ["验证层判定为环境错误（无具体指纹）"] };

    const compile = scan(COMPILE_FINGERPRINTS, text);
    if (compile.length > 0) return { cls: "COMPILE", confidence: "high", reasons: compile };

    const contract = scan(CONTRACT_FINGERPRINTS, text);
    if (contract.length > 0) return { cls: "CONTRACT", confidence: "medium", reasons: contract };

    const test = scan(TEST_FINGERPRINTS, text);
    if (test.length > 0) return { cls: "TEST", confidence: "medium", reasons: test };

    return {
        cls: "UNKNOWN",
        confidence: "low",
        reasons: ["无机器指纹命中：不猜测，按未知处理（首次走实现器，重复则缩任务/升级）"],
    };
}

export type RouteTarget = "implementer" | "planner" | "environment" | "user" | "stop";

export interface Route { target: RouteTarget; action: string; /** 可否原地重试（false=必须换策略） */ retryable: boolean }

export function routeOf(cls: FailureClass): Route {
    switch (cls) {
        case "COMPILE": return { target: "implementer", action: "把编译器原文喂回实现器，只改报错处；修完**必须重跑验证**", retryable: true };
        case "CONTRACT": return { target: "planner", action: "重生成该切片的契约（接口/字段与实现对齐），再重新实现", retryable: true };
        case "TEST": return { target: "implementer", action: "按失败断言改业务行为", retryable: true };
        case "ENV": return { target: "environment", action: "补齐依赖/释放端口/恢复服务；连续两次仍失败则暂停上报", retryable: true };
        case "SPEC": return { target: "user", action: "暂停并向用户提问（需求自相矛盾，机器无法裁定）", retryable: false };
        case "BUDGET": return { target: "stop", action: "暂停并出报告（不续烧）", retryable: false };
        default: return { target: "implementer", action: "无指纹：先按实现器修一次；若同一签名再现则缩任务粒度或升级", retryable: true };
    }
}

/** 一步到位：证据 → 分类 + 分流（调用方只需关心 route） */
export function diagnose(ev: FailureEvidence): ClassificationResult & { route: Route } {
    const c = classifyFailure(ev);
    return { ...c, route: routeOf(c.cls) };
}
