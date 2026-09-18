// ============================================================
// components.ts —— 组件标签幻觉闸（栈驱动，纯函数零 LLM）
//
//   背景（2026-09-10）：TDesign 时代这条闸能拦 `<t-ghost>`；迁到 Element Plus 后被换成
//   空实现 `extraGate: async () => []`，等于**组件库校验彻底消失**。此处按 StackProfile
//   的 componentRules 重新接上——且判据来自"本栈声明的组件库"，不是硬编码 Element Plus。
//
//   纪律：**宁漏不误杀**。只对"连字符小写标签"（第三方库标签形态）做前缀判定；
//   认不出前缀的（自定义组件 `<my-widget>`、Web Component）一律放行——
//   误杀一次 = 白烧一轮 60~300s 的 LLM 调用。
// ============================================================

import type { ComponentRules } from "./profile";

/** 连字符小写标签 = 第三方/自定义元素形态（`<el-button>`、`<my-widget>`）；大驼峰组件不在此列 */
const HYPHEN_TAG_RE = /<([a-z][a-z0-9]*-[a-z0-9-]+)(?=[\s/>])/g;

/**
 * 扫内容里的标签，返回**必须打回**的问题短句（空数组=绿）。
 * 判定顺序：允许前缀 → 命中禁止库 → 其余放行（不确定即放行）
 */
export function findComponentTagIssues(content: string, rules: ComponentRules): string[] {
    if (!content || rules.allowedPrefixes.length === 0) return [];   // 未登记栈/React 家族：不做前缀校验
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const m of content.matchAll(HYPHEN_TAG_RE)) {
        const tag = m[1]!;
        if (seen.has(tag)) continue;
        seen.add(tag);
        if (rules.allowedPrefixes.some(p => tag.startsWith(p))) continue;      // 本栈组件库
        const bad = rules.forbidden.find(f => tag.startsWith(f.prefix));
        if (bad) problems.push(`组件库不符：<${tag}> 属于 ${bad.name}，本栈只允许 ${rules.allowedPrefixes.join("/")} 前缀的组件`);
        // 命不中任何已知库 → 自定义组件/Web Component，放行（宁漏不误杀）
    }
    return problems;
}

/** 该文件是否值得扫（只扫可能含标签的前端文件） */
export function shouldScanComponentTags(filePath: string): boolean {
    return /\.(vue|tsx|jsx|html)$/i.test(filePath);
}
