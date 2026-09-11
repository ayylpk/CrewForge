// ============================================================
// ownership.ts —— 写盘纪律（M4，纯函数 + 进程内登记，零 LLM）
//
//   治的病（实测）：
//     · runs/p1 一个项目里出现四套互斥目录约定（app.py / backend/app.py / src/routes/auth.py / …），
//       根因是"每个任务让模型自由填 files"
//     · runs/p9 全树没有 main.ts / App.vue —— 引擎拥有件本该直出，却被任务当普通文件对待
//
//   四条规则（按顺序判定，任一不过即拒，理由可读且**附候选**）：
//     ① 路径必须是项目内相对路径（禁绝对路径 / .. 逃逸）
//     ② 引擎拥有件不许任务产出（入口/路由登记/样式 token/构建文件）
//     ③ **任务只能写自己声明的 files**（越界即拒）—— 这一条直接消灭"路径漂移"整类缺陷
//     ④ 一个文件同一时刻只有一个 owner（跨任务让渡必须先释放）
// ============================================================

import type { StackProfile } from "../stacks/profile";

/** 历史引擎件（Express 时代遗留；统一并入判定，防回归） */
const LEGACY_ENGINE_OWNED = [
    "backend/src/app.js",
    "frontend/src/main.ts",
    "frontend/src/App.vue",
    "frontend/src/router/index.ts",
    "frontend/src/style.css",
];

export function normPath(p: string): string {
    return (p ?? "").replace(/\\/g, "/").replace(/^\.\/+/, "").toLowerCase();
}

export function isEngineOwnedFile(path: string, profile?: StackProfile): boolean {
    const key = normPath(path);
    const owned = [...LEGACY_ENGINE_OWNED, ...(profile?.engineOwnedFiles ?? [])].map(normPath);
    return owned.includes(key);
}

export type WriteDecision =
    | { ok: true }
    | { ok: false; code: "escape" | "engine_owned" | "out_of_plan" | "owned_by_other"; reason: string; candidates?: string[] };

export interface WriteRequest {
    path: string;
    taskId: string;
    /** 任务声明的文件清单（架构师产出） */
    plannedFiles: string[];
    profile?: StackProfile;
}

/** 纯判定：不依赖任何状态（owner 判定在外面单独做） */
export function decideWrite(req: WriteRequest): WriteDecision {
    const raw = (req.path ?? "").trim();
    const key = normPath(raw);
    // ① 逃逸
    if (!key || key.startsWith("/") || /^[a-z]:/.test(key) || key.split("/").includes("..")) {
        return { ok: false, code: "escape", reason: `路径越界：${raw}（只允许项目内相对路径）` };
    }
    // ② 引擎拥有件
    if (isEngineOwnedFile(key, req.profile)) {
        return {
            ok: false, code: "engine_owned",
            reason: `引擎拥有件不许任务产出/修改：${raw}（入口/路由登记/样式 token/构建文件由引擎直出）`,
        };
    }
    // ③ 必须在自己声明的 files 里
    const planned = req.plannedFiles.map(normPath);
    if (planned.length > 0 && !planned.includes(key)) {
        const base = key.split("/").pop() ?? key;
        const candidates = req.plannedFiles.filter(p => {
            const n = normPath(p);
            return n.endsWith(base) || n.includes(base.replace(/\.[a-z]+$/, ""));
        }).slice(0, 3);
        return {
            ok: false, code: "out_of_plan",
            reason: `越界写盘：${raw} 不在本任务声明的 files 里（登记制：任务只能写自己的文件）`,
            candidates,
        };
    }
    return { ok: true };
}

// ---------- 进程内 owner 登记（一个文件一个 writer） ----------
export interface ClaimResult { ok: boolean; owner?: string; reason?: string }

export class OwnershipRegistry {
    private readonly owners = new Map<string, string>();       // path → taskId

    /** 认领：同一任务可重复认领；他人已认领则拒（需先 release） */
    claim(path: string, taskId: string): ClaimResult {
        const key = normPath(path);
        const cur = this.owners.get(key);
        if (!cur || cur === taskId) { this.owners.set(key, taskId); return { ok: true, owner: taskId }; }
        return { ok: false, owner: cur, reason: `文件已被任务 ${cur} 占用（需先释放/让渡）：${path}` };
    }

    ownerOf(path: string): string | null {
        return this.owners.get(normPath(path)) ?? null;
    }

    /** 任务结束时释放它占用的全部文件（失败/放弃也要释放，否则会死锁后续任务） */
    releaseTask(taskId: string): void {
        for (const [k, v] of [...this.owners.entries()]) if (v === taskId) this.owners.delete(k);
    }

    snapshot(): { path: string; owner: string }[] {
        return [...this.owners.entries()].map(([path, owner]) => ({ path, owner }));
    }
}
