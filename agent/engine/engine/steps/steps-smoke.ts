// ============================================================
// steps-smoke.ts —— 代码质量纪律 + 上下文预算自测（零 LLM）
//
//   ① 质量纪律：10 条法条齐全、关键词覆盖（反过度设计/不吞错误/不留占位/契约照抄）
//   ② ★ 纪律真的被注入：读两个实现器源码，断言都引用了 CODE_QUALITY_RULES
//      —— 这一条专门防止它变成"四条死规约"那样的无人引用文本
//   ③ 上下文预算：essential 不裁、优先级降序保留、截断有标注、丢弃有记录、输出稳定
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { CODE_QUALITY_RULES, CODE_QUALITY_RULES_COUNT } from "./codeQualityRules";
import { fitContext, describeFit, DEFAULT_CONTEXT_BUDGET } from "./contextBudget";

let pass = 0, fail = 0;
function ok(cond: boolean, msg: string): void {
    if (cond) { pass++; console.log(`  ✓ ${msg}`); }
    else { fail++; console.log(`  ✗ ${msg}`); }
}

console.log("=== ① 质量纪律内容 ===");
{
    const laws = CODE_QUALITY_RULES.split(/\r?\n/).filter(l => /^\d+\./.test(l.trim()));
    ok(laws.length === CODE_QUALITY_RULES_COUNT && laws.length === 10, `10 条法条齐全（实际 ${laws.length}）`);
    for (const kw of ["只写被要求的东西", "最小改动", "匹配现有风格", "先复用再造轮子", "不新增依赖", "不吞错误", "注释只写", "不留占位实现", "契约逐字照抄", "完成即完整"]) {
        ok(CODE_QUALITY_RULES.includes(kw), `法条覆盖：${kw}`);
    }
    ok(CODE_QUALITY_RULES.includes("throw new Error(\"not implemented\")") || CODE_QUALITY_RULES.includes("not implemented"), "明令禁止占位实现");
}

console.log("=== ② ★ 纪律真的被注入实现器 ===");
{
    for (const f of ["backendEngineer.ts", "frontendEngineer.ts"]) {
        const src = fs.readFileSync(path.resolve(import.meta.dir, "../../", f), "utf-8");
        ok(src.includes("CODE_QUALITY_RULES"), `${f} 引用了质量纪律`);
        ok(/CODE_QUALITY_RULES\s*[,}]/.test(src) || src.includes("+ CODE_QUALITY_RULES") || src.includes("CODE_QUALITY_RULES\n"),
            `${f} 把纪律拼进了提示词（不是只 import）`);
    }
}

console.log("=== ③ 上下文预算 ===");
{
    const pieces = [
        { name: "contract", text: "C".repeat(2000), priority: 9, essential: true },
        { name: "feedback", text: "F".repeat(500), priority: 9, essential: true },
        { name: "hint", text: "H".repeat(3000), priority: 5 },
        { name: "current_file", text: "X".repeat(3000), priority: 3 },
        { name: "siblings", text: "S".repeat(3000), priority: 1 },
    ];
    const r1 = fitContext(pieces, 10_000);
    ok(r1.text.includes("C".repeat(2000)) && r1.text.includes("F".repeat(500)), "★ essential 段完整保留（契约/返工意见不裁）");
    ok(r1.text.includes("H".repeat(3000)), "高优先级软段保留");
    ok(r1.truncated.includes("siblings") || r1.dropped.includes("siblings"),
        `★ 预算不足时最低优先级段被截断或丢弃（实际 truncated=${r1.truncated.join("、") || "无"} dropped=${r1.dropped.join("、") || "无"}）`);
    ok(r1.text.includes("X".repeat(3000)), "预算够时中优先级段完整保留（不无谓裁剪）");
    ok(r1.text.includes("按上下文预算截断"), "★ 截断处有显式标注（绝不静默）");
    ok(r1.chars <= 10_000 + 200, `总长受控（${r1.chars}/${r1.budgetChars}）`);

    // 输出稳定：同输入同输出（缓存前提）
    const r2 = fitContext(pieces, 10_000);
    ok(r1.text === r2.text, "同输入 → 同输出（前缀稳定，缓存友好）");

    // essential 自身超预算：如实报告，但不裁 essential
    const r3 = fitContext([{ name: "contract", text: "C".repeat(12_000), priority: 9, essential: true },
                           { name: "x", text: "X".repeat(1000), priority: 1 }], 5_000);
    ok(r3.text.includes("C".repeat(12_000)), "★ essential 超预算也不裁（宁可超预算，不丢判据材料）");
    ok(r3.dropped.includes("x"), "此时软段被丢弃");

    ok(describeFit(r1).includes("字符"), `摘要可读：${describeFit(r1)}`);
    ok(DEFAULT_CONTEXT_BUDGET === 24_000, "默认预算集中在一处（改一个数即可调）");
}

console.log(`\n[steps-smoke] 通过 ${pass}，失败 ${fail}`);
if (fail > 0) process.exit(1);
