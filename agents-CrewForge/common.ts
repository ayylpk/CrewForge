// ============================================================
// common.ts —— 7 个 Agent 类共享的类型与工具
// （参照 _legacy-agents：ExecTask/Pair 每个文件各写一份；
//   拆成独立文件后统一放这里，避免重复）
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { currentProjectId, safeRealPath } from "./runEnv";

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
    /** 所属阶段号（阶段 3 加，可选保协议兼容）：ext 是阶段内编号，sys_task 桥写状态
     *  必须按 (project, phase, ext) 定位——缺了它跨阶段同名任务（每阶段都有 T1）会串台（9/4 live 实锤） */
    phase?: number;
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
    uiStyle?: string;        // T5：UI 决策一行（manager planner 机械注入在阶段1，全绿灯带"默认值"标注）
}

/** T5 UI 访谈决策（PM 定稿必带，plan.uiProfile 全链携带 → T2 契约消费） */
export interface UiProfile {
    /** 要不要 Web 前端 */
    web: boolean;
    /** 页面/主要界面清单（web=false 时可为空） */
    pages: string[];
    /** 风格愿望一句话（用户原话提炼；未采访问得=兜底串） */
    style: string;
    /** true=值非用户亲答（全绿灯/回炉耗尽兜底），契约与看板须标注 */
    defaulted: boolean;
}

/** 全量计划（PM 产出 → 消息携带传给架构师） */
export interface Plan {
    project: string;
    features: { name: string; description: string; priority: string; acceptance: string }[];
    phases: planItem[];
    mvp_scope: string[];
    risks: string[];
    /** T5：UI 决策（机械注入，不由 LLM 输出——防它忘/瞎编字段名） */
    uiProfile?: UiProfile;
}

// 写盘（沙箱：只能写当前项目的房间，逃逸直接抛错）
export function writeWorkspace(relative: string, code: string): string {
  const pid = currentProjectId();
  if (pid == null) throw new Error("缺少 PROJECT_ID，无法确定写入目录");
  const full = safeRealPath(pid, relative);          // 保安先检查
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, code, "utf-8");
  // 同步落库 sys_project_file（异步 fire-and-forget：失败只 warn，不阻塞写盘）
  // 动态 import 避免与 Node.ts 的静态循环依赖
  import("./Node").then(m => m.upsertProjectFile(pid, relative, code)).catch(e =>
    console.warn("[writeWorkspace] 代码落库失败:", (e as Error).message));
  return full;
}

/** 读盘：从 DB 读取当前项目已存在的文件内容（用于 agent 追加修改时参考） */
export async function readWorkspace(relative: string): Promise<string | null> {
  const pid = currentProjectId();
  if (pid == null) return null;
  const { readProjectFile } = await import("./Node");
  return readProjectFile(pid, relative);
}
