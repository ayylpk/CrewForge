// ============================================================
// eval/harness/provision.ts —— 为每个冻结场景准备一次干净的"开工现场"
//
//   · 在 crewforge 库里插一行 sys_project（description = 冻结的需求原文，confirm_mode=0 全绿灯）
//   · 清掉该项目的历史 sys_task / dev_plan（保证"全新开工"而不是断点续跑）
//   · 另建一个专用空库给生成的应用连（等价于 finalGate 里那个空的容器库）
//   全程真读真写 MySQL；任何一步失败都必须让调用方看到错误，不静默继续。
// ============================================================

import mysql from "mysql2/promise";

export interface DbConnOpts {
    host?: string; port?: number; user?: string; password?: string; database?: string;
}

function connOpts(db?: string): DbConnOpts {
    return {
        host: process.env.DB_HOST ?? "localhost",
        port: Number(process.env.DB_PORT ?? 3306),
        user: process.env.DB_USER ?? "root",
        password: process.env.DB_PASSWORD ?? "",
        database: db ?? process.env.DB_NAME ?? "crewforge",
    };
}

export interface ProvisionResult {
    projectId: number;
    projectName: string;
    appDatabase: string;
    previousState: { status: string | null; tasks: number; hadPlan: boolean } | null;
}

/** 建库（幂等） */
export async function ensureDatabase(name: string): Promise<void> {
    const conn = await mysql.createConnection(connOpts("mysql"));
    try {
        await conn.query(`CREATE DATABASE IF NOT EXISTS \`${name}\` DEFAULT CHARSET utf8mb4`);
    } finally {
        await conn.end();
    }
}

/** 清掉该项目的所有运行痕迹（任务桥 + 计划 + 确认门），让它从"没拆过任务"的状态开工 */
export async function resetProjectRun(projectId: number): Promise<void> {
    const conn = await mysql.createConnection(connOpts());
    try {
        await conn.query("DELETE FROM sys_task WHERE project_id = ?", [projectId]);
        await conn.query("UPDATE sys_project SET dev_plan = NULL, clarified_req = NULL, dir_tree = NULL, status = 'planning' WHERE id = ?", [projectId]);
        await conn.query("DELETE FROM sys_confirm WHERE project_id = ?", [projectId]).catch(() => { /* 表结构差异容忍 */ });
    } finally {
        await conn.end();
    }
}

/** 新建一个场景项目（每次都新建一行，保留历史以便复核） */
export async function provisionProject(scenarioId: string, requirement: string): Promise<ProvisionResult> {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const projectName = `eval-${scenarioId}-${ts}`;
    const appDatabase = `cf_eval_${scenarioId.replace(/[^a-z0-9]+/gi, "_")}`;
    await ensureDatabase(appDatabase);

    const conn = await mysql.createConnection(connOpts());
    try {
        const [res] = await conn.query(
            "INSERT INTO sys_project (project_type, name, description, status, confirm_mode, create_time, update_time, deleted) VALUES (1, ?, ?, 'planning', 0, NOW(), NOW(), 0)",
            [projectName, requirement],
        );
        const id = Number((res as { insertId?: number }).insertId);
        if (!Number.isInteger(id) || id <= 0) throw new Error(`插项目失败，insertId=${String((res as { insertId?: unknown }).insertId)}`);
        return { projectId: id, projectName, appDatabase, previousState: null };
    } finally {
        await conn.end();
    }
}

export interface ProjectState {
    status: string | null;
    hasPlan: boolean;
    phaseCount: number;
    tasks: { total: number; done: number; failed: number; todo: number; running: number };
    taskRows: { phaseId: number | null; title: string; status: string; layer: string | null; retry: number | null }[];
}

export async function readProjectState(projectId: number): Promise<ProjectState> {
    const conn = await mysql.createConnection(connOpts());
    try {
        const [proj] = await conn.query("SELECT status, dev_plan FROM sys_project WHERE id = ?", [projectId]);
        const p = (proj as Record<string, unknown>[])[0] ?? {};
        let hasPlan = false;
        let phaseCount = 0;
        const rawPlan = p.dev_plan;
        if (rawPlan) {
            try {
                const parsed = typeof rawPlan === "string" ? JSON.parse(rawPlan) : rawPlan;
                const phases = (parsed as { phases?: unknown[] })?.phases;
                hasPlan = Array.isArray(phases) && phases.length > 0;
                phaseCount = Array.isArray(phases) ? phases.length : 0;
            } catch { hasPlan = false; }
        }
        const [rows] = await conn.query(
            "SELECT phase_id, title, status, layer, retry_count FROM sys_task WHERE project_id = ? ORDER BY id",
            [projectId],
        );
        const list = (rows as Record<string, unknown>[]).map(r => ({
            phaseId: r.phase_id == null ? null : Number(r.phase_id),
            title: String(r.title ?? ""),
            status: String(r.status ?? ""),
            layer: r.layer == null ? null : String(r.layer),
            retry: r.retry_count == null ? null : Number(r.retry_count),
        }));
        const count = (s: string) => list.filter(r => r.status === s).length;
        return {
            status: p.status == null ? null : String(p.status),
            hasPlan,
            phaseCount,
            tasks: { total: list.length, done: count("done"), failed: count("failed"), todo: count("todo"), running: count("running") },
            taskRows: list,
        };
    } finally {
        await conn.end();
    }
}
