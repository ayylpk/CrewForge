// ============================================================
// scaffold.ts —— 官方脚手架候选表（确定性数据 + 纯函数，零 LLM）
//
// 定位（9/15 新增）：空项目初始化不应手写全部工程文件——npm create vite
//   这类官方脚手架又快又标准。本模块只做**确定性匹配**：stackProfile →
//   有序候选清单；用哪个、能不能用，由 Developer 用 runCommand 拿真实
//   exitCode 探测后自行判断（环境里有 pnpm 就选 pnpm 形态，断网就退回
//   手写工程文件）——判定权在带证据的模型，不在硬编码。
//
// 为什么是"候选清单"不是"单点映射"：
//   同一栈有多个官方起点（create-vite / create-vue）、同一脚手架有多个
//   包管理器形态（npm / pnpm）、各机器环境不同——代码不替模型拍板，
//   只提供**带探测命令的有序候选**。
//
// 口径：
//   · 命令一律**非交互**形态（带 template / 参数），避免卡在交互提示符等输入；
//   · {dir} 占位符 = 目标子目录名，由模型按 foundationPlan.dirs 替换；
//   · 只收录官方 / 一等公民脚手架；flags 可能随版本变化，以各自 --help 实测为准；
//   · 未收录的栈 → 空候选 → bootstrap-project 技能的"手写工程文件"既有流程
//     （行为与从前完全一致，脚手架是加速器不是依赖项）；
//   · 栈名词只出现在本表（数据层），**不进技能正文**——技能保持栈无关（②的口径）。
// ============================================================

import type { StackProfile } from "./protocol";

/** 一个脚手架候选：怎么探测环境、怎么非交互执行、有什么注意点 */
export interface ScaffoldCandidate {
    /** 候选名（人话标签，含包管理器形态） */
    name: string;
    /** 非交互命令；{dir} = 目标子目录占位符 */
    command: string;
    /** 执行前先跑这条探测命令，exitCode=0 才考虑本候选 */
    probe: string;
    /** 一句话注意事项（依赖/参数怎么改、Windows 差异等） */
    note?: string;
}

/** 一个维度的匹配结果：stackProfile 的 frontend 或 backend */
export interface ScaffoldMatch {
    dimension: "frontend" | "backend";
    /** 原始栈名（如 "vue3"），仅回显用 */
    stack: string;
    candidates: ScaffoldCandidate[];
}

/** 匹配规则：stackProfile 值（小写化后）包含 match 词即命中 */
interface ScaffoldEntry {
    match: string;
    candidates: ScaffoldCandidate[];
}

// ------------------------------------------------------------
// 前端：create-vite 是官方多模板脚手架，模板随栈切换
// ------------------------------------------------------------

const FRONTEND_SCAFFOLDS: ScaffoldEntry[] = [
    {
        match: "vue",
        candidates: [
            {
                name: "create-vite（pnpm 形态）",
                command: "pnpm create vite {dir} --template vue-ts",
                probe: "pnpm -v",
                note: "纯 JS 项目把 vue-ts 换成 vue",
            },
            {
                name: "create-vite（npm 形态）",
                command: "npm create vite@latest {dir} -- --template vue-ts",
                probe: "node -v",
                note: "-- 之后的参数透传给 create-vite；纯 JS 项目用 vue 模板",
            },
        ],
    },
    {
        match: "react",
        candidates: [
            {
                name: "create-vite（pnpm 形态）",
                command: "pnpm create vite {dir} --template react-ts",
                probe: "pnpm -v",
            },
            {
                name: "create-vite（npm 形态）",
                command: "npm create vite@latest {dir} -- --template react-ts",
                probe: "node -v",
            },
        ],
    },
    {
        match: "svelte",
        candidates: [
            {
                name: "create-vite（pnpm 形态）",
                command: "pnpm create vite {dir} --template svelte-ts",
                probe: "pnpm -v",
            },
            {
                name: "create-vite（npm 形态）",
                command: "npm create vite@latest {dir} -- --template svelte-ts",
                probe: "node -v",
            },
        ],
    },
];

// ------------------------------------------------------------
// 后端：按生态各归各；无官方脚手架的生态给"最小起点"而不是瞎编
// ------------------------------------------------------------

const BACKEND_SCAFFOLDS: ScaffoldEntry[] = [
    {
        match: "spring",
        candidates: [
            {
                name: "Spring Initializr（curl 拉包）",
                command: "curl -s https://start.spring.io/starter.zip -d type=gradle-project -d language=java -d dependencies=web -o starter.zip && tar -xf starter.zip -C {dir}",
                probe: "curl --version",
                note: "-d 参数（构建工具/语言/依赖）按契约增删；需外网；tar 解 zip 在 Windows 10+ 可用",
            },
            {
                name: "Spring CLI（spring init）",
                command: "spring init -d=web {dir}",
                probe: "spring --version",
                note: "依赖按契约增删",
            },
        ],
    },
    {
        match: "nest",
        candidates: [
            {
                name: "@nestjs/cli new",
                command: "npx @nestjs/cli new {dir} --skip-git",
                probe: "node -v",
                note: "包管理器选择与 flags 以 CLI 提示为准",
            },
        ],
    },
    {
        match: "express",
        candidates: [
            {
                name: "npm init（最小起点）",
                command: "npm init -y",
                probe: "node -v",
                note: "express 无官方脚手架；init 后按契约手动安装依赖与目录结构",
            },
        ],
    },
];

// ------------------------------------------------------------
// 匹配与提示词渲染（纯函数）
// ------------------------------------------------------------

/**
 * stackProfile → 各维度候选。确定性：同输入必同输出（测试钉住）。
 * 未收录的栈不出现（而非报错）——调用方据空结果走手写兜底。
 */
export function matchScaffolds(stackProfile: StackProfile | null): ScaffoldMatch[] {
    if (!stackProfile) return [];
    const out: ScaffoldMatch[] = [];
    const push = (
        dimension: ScaffoldMatch["dimension"],
        value: unknown,
        table: ScaffoldEntry[],
    ): void => {
        if (typeof value !== "string" || !value.trim()) return;
        const v = value.toLowerCase();
        const entry = table.find((e) => v.includes(e.match));
        if (entry) out.push({ dimension, stack: value, candidates: entry.candidates });
    };
    push("frontend", stackProfile.frontend, FRONTEND_SCAFFOLDS);
    push("backend", stackProfile.backend, BACKEND_SCAFFOLDS);
    return out;
}

/**
 * 渲染进任务提示词的"脚手架候选"节。**有候选才返回整节文本，无候选返回空串**
 * （空串 = 不产生空标题节，任务模板对旧任务包零扰动）。
 */
export function scaffoldHintFor(stackProfile: StackProfile | null): string {
    const matches = matchScaffolds(stackProfile);
    if (matches.length === 0) return "";
    const lines: string[] = [
        "## 官方脚手架候选（空项目初始化用）",
        "",
        "以下候选按顺序考虑，**先跑探测命令（runCommand，看真实 exitCode）确认环境可用，再执行脚手架命令**：",
    ];
    for (const m of matches) {
        lines.push("", `**${m.dimension}：${m.stack}**`);
        m.candidates.forEach((c, i) => {
            lines.push(`${i + 1}. ${c.name} — 命令：\`${c.command}\`（探测：\`${c.probe}\`）`);
            if (c.note) lines.push(`   注意：${c.note}`);
        });
    }
    lines.push(
        "",
        "规则：",
        "- `{dir}` 换成 FoundationPlan 里的目标子目录；命令卡在交互提示符 = 失败，换非交互参数或下一个候选；",
        "- 探测或脚手架失败就跳到下一候选，同一候选不反复重试；",
        "- 全部候选不可用（缺工具 / 断网）→ 放弃脚手架，按技能手写工程文件，不阻塞任务；",
        "- 脚手架产物同样要过 runBuild 验证最小可运行，目录结构对齐 FoundationPlan.dirs 与 allowedRoots；"
            + "脚手架生成的样板文件里没有的，照常手写补齐。",
    );
    return lines.join("\n");
}
