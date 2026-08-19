// ============================================================
// common.ts —— 7 个 Agent 类共享的类型与工具
// （参照 _legacy-agents：ExecTask/Pair 每个文件各写一份；
//   拆成独立文件后统一放这里，避免重复）
// ============================================================

import fs from "node:fs";
import path from "node:path";

/** 可执行任务（架构师产出 → 开发执行 → 合并器配对 → 测试判定） */
export interface ExecTask {
    id: string;
    layer: "backend" | "frontend";
    method: string;
    path: string;
    files: string[];
    title: string;
    description: string;
    parameters: { name: string; type: string; required: boolean; description: string }[];
    acceptance: string;
}

/** 接口对：一个接口的后端 + 前端（前端可能落单为空） */
export interface Pair {
    back: ExecTask;
    front: ExecTask | null;
}

/** 阶段（planItem）：轻量规划里每个阶段的结构 */
export interface planItem {
    phase: number;
    name: string;
    goal: string;
    features: string[];
    dependencies: string[];
    relative_effort: string;
    risk: string;
}

/** 全量计划（PM 产出 → 消息携带传给架构师） */
export interface Plan {
    project: string;
    features: { name: string; description: string; priority: string; acceptance: string }[];
    phases: planItem[];
    mvp_scope: string[];
    risks: string[];
}

/** 占位任务（LLM 拆分失败时的兜底，保证流水线能跑通） */
export function makeTask(no: number, feature: string, layer: "backend" | "frontend"): ExecTask {
    return {
        id: layer === "frontend" ? `T${no}-F` : `T${no}`,
        layer,
        method: layer === "backend" ? "POST" : "",
        path: layer === "backend" ? `/api/feature-${no}` : "",
        files: [layer === "backend" ? `src/backend/feature${no}.ts` : `src/frontend/Feature${no}.vue`],
        title: `T${no} ${feature}（${layer}）`,
        description: `功能：${feature}\n技术：模板技术栈`,
        parameters: [],
        acceptance: `功能 ${feature} 可正常使用`,
    };
}

/** 写盘到 workspace/（防路径穿越） */
export function writeWorkspace(relative: string, code: string): string {
    const safe = relative.replace(/^[/\\]+/, "").replace(/\.\./g, "");
    const full = path.join("workspace", safe);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, code, "utf-8");
    return full;
}
