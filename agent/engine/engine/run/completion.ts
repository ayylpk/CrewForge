// ============================================================
// completion.ts —— 项目收尾（IO 层：数产物、查任务、判终态、落库、出报告）
//
//   阶段 1 提交 1 的核心：**项目只有一个终态判据**（state.ts 的 decideProjectStatus），
//   而"done"必须同时满足任务数>0、产物数>0、无 failed 任务、交付关 done 且 verified。
//
//   历史病（阶段 0 实测）：
//     · s3：8 个任务 6 个 failed，项目仍落 done
//     · s2：解析异常冒泡 → 进程退出，项目永远停在 planning（孤儿状态）
//     · 交付关自身异常 → 返回 { status:"done", verified:false }（把"没验"说成"完成"）
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { decideProjectStatus, completionReasons, type CompletionInput, type ProjectStatus } from "./state";
import { updateProjectField } from "../../Node";
import { getTasksByProject } from "../../task";

/** 产物计数：只数真实产品文件（前端/后端源码与配置），排除依赖与构建缓存 */
const EXCLUDE_DIRS = new Set(["node_modules", "dist", "target", ".git", ".vite", ".idea"]);
const EXCLUDE_ROOTS = new Set(["_verify", "_shots", "_test-report", "_task-evidence", "_archive"]);

export function countArtifacts(projectDir: string): number {
    let n = 0;
    const walk = (dir: string, depth: number) => {
        if (depth > 12) return;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (e.isDirectory()) {
                if (EXCLUDE_DIRS.has(e.name)) continue;
                if (depth === 0 && EXCLUDE_ROOTS.has(e.name)) continue;
                walk(path.join(dir, e.name), depth + 1);
            } else {
                n++;
            }
        }
    };
    if (!fs.existsSync(projectDir)) return 0;
    walk(projectDir, 0);
    return n;
}

export interface FinalizeOptions {
    projectId: number;
    projectDir: string;
    /** 交付关结论（skipped_unverified 会把项目判成 blocked） */
    finalGateStatus: string;
    /** 交付关是否真的验证通过 */
    verified: boolean;
    /** 必需断言是否全过；不传则跟随 verified */
    requiredAssertionsPassed?: boolean;
    /** 失败/阻塞时的原因附件（例如解析异常原文） */
    failureDetail?: { kind: string; message: string; attempts?: number; raw?: string } | null;
}

export interface FinalizeResult {
    status: ProjectStatus;
    input: CompletionInput;
    reasons: string[];
    reportFile: string | null;
}

/** 采集现场 → 判终态 → 落库 → 落失败报告（唯一收尾入口） */
export async function finalizeProject(o: FinalizeOptions): Promise<FinalizeResult> {
    let tasks: Awaited<ReturnType<typeof getTasksByProject>> = [];
    try { tasks = await getTasksByProject(o.projectId); } catch { tasks = []; }

    const input: CompletionInput = {
        taskCount: tasks.length,
        artifactCount: countArtifacts(o.projectDir),
        failedTaskCount: tasks.filter(t => t.status === "failed").length,
        finalGateStatus: o.finalGateStatus,
        verified: o.verified,
        requiredAssertionsPassed: o.requiredAssertionsPassed ?? o.verified,
    };
    const status = decideProjectStatus(input);
    const reasons = completionReasons(input);

    // 落库（终态唯一入口；写失败必须让人看见，绝不让项目留在中间态）
    try {
        await updateProjectField(o.projectId, { status });
    } catch (e) {
        console.error(`[completion] ⚠️ 终态落库失败（projectId=${o.projectId}, status=${status}）:`, (e as Error).message);
    }

    let reportFile: string | null = null;
    if (status !== "done" || o.failureDetail) {
        try {
            const dir = path.join(o.projectDir, "_verify");
            fs.mkdirSync(dir, { recursive: true });
            reportFile = path.join(dir, "completion.json");
            fs.writeFileSync(reportFile, JSON.stringify({
                schemaVersion: "crewforge.completion/1",
                projectId: o.projectId,
                decidedAt: new Date().toISOString(),
                status,
                input,
                reasons,
                failureDetail: o.failureDetail ?? null,
                taskBreakdown: {
                    total: tasks.length,
                    done: tasks.filter(t => t.status === "done").length,
                    failed: input.failedTaskCount,
                    todo: tasks.filter(t => t.status === "todo").length,
                    doing: tasks.filter(t => t.status === "doing").length,
                },
            }, null, 2), "utf-8");
        } catch (e) {
            console.warn("[completion] 失败报告落盘失败:", (e as Error).message);
        }
    }
    return { status, input, reasons, reportFile };
}
