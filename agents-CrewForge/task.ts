import mysql, { type RowDataPacket, type ResultSetHeader } from "mysql2/promise";
import type { ExecTask } from "./common";

/** 任务状态（对应看板四列） */
export type TaskStatus = "todo" | "doing" | "done" | "failed";

/** 任务（对应 sys_task 表） */
export interface Task {
    id?: number;
    project_id: number;
    phase_id: number | null;
    title: string;
    description: string | null;
    status: TaskStatus;
    assignee: string | null;
    layer: string | null;
    acceptance: string | null;
    result: string | null;
    error_msg: string | null;
    retry_count: number;
    task_id_ext: string | null;
    depends_on: string | null;
    sort_order: number;
    create_time?: string;
    update_time?: string;
    deleted?: number;
}

const pool = mysql.createPool({
    host: "localhost",
    user: "root",
    // DB 密码从 .env 读取（bun 自动加载），禁止硬编码明文入库
    password: process.env.DB_PASSWORD ?? "",
    database: "crewforge",
    waitForConnections: true,
    connectionLimit: 5,
});

// ============================================================
// 基础 CRUD
// ============================================================

/** 创建任务，返回自增 id */
export async function createTask(task: Omit<Task, "id" | "create_time" | "update_time" | "deleted">): Promise<number> {
    const [res] = await pool.query<ResultSetHeader>(
        `INSERT INTO sys_task
         (project_id, phase_id, title, description, status, assignee, layer,
          acceptance, result, error_msg, retry_count, task_id_ext, depends_on, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            task.project_id, task.phase_id, task.title, task.description,
            task.status, task.assignee, task.layer, task.acceptance,
            task.result, task.error_msg, task.retry_count, task.task_id_ext,
            task.depends_on, task.sort_order,
        ],
    );
    return res.insertId;
}

/** 查询项目的全部任务（看板用，按 sort_order 排序） */
export async function getTasksByProject(projectId: number): Promise<Task[]> {
    const [rows] = await pool.query<RowDataPacket[]>(
        "SELECT * FROM sys_task WHERE project_id = ? AND deleted = 0 ORDER BY sort_order ASC",
        [projectId],
    );
    return rows as Task[];
}

/** 按状态查询项目的任务 */
export async function getTasksByStatus(projectId: number, status: TaskStatus): Promise<Task[]> {
    const [rows] = await pool.query<RowDataPacket[]>(
        "SELECT * FROM sys_task WHERE project_id = ? AND status = ? AND deleted = 0 ORDER BY sort_order ASC",
        [projectId, status],
    );
    return rows as Task[];
}

/** 查询单个任务 */
export async function getTaskById(id: number): Promise<Task | null> {
    const [rows] = await pool.query<RowDataPacket[]>(
        "SELECT * FROM sys_task WHERE id = ? AND deleted = 0 LIMIT 1",
        [id],
    );
    if (!rows || rows.length === 0) return null;
    return rows[0] as Task;
}

/** 更新任务状态（看板拖拽 / 引擎推进） */
export async function updateTaskStatus(id: number, status: TaskStatus, error_msg?: string): Promise<void> {
    if (error_msg !== undefined) {
        await pool.query(
            "UPDATE sys_task SET status = ?, error_msg = ?, update_time = NOW() WHERE id = ?",
            [status, error_msg, id],
        );
    } else {
        await pool.query(
            "UPDATE sys_task SET status = ?, update_time = NOW() WHERE id = ?",
            [status, id],
        );
    }
}

/** 更新任务结果（Agent 完成时写入） */
export async function updateTaskResult(id: number, result: string): Promise<void> {
    await pool.query(
        "UPDATE sys_task SET result = ?, status = 'done', update_time = NOW() WHERE id = ?",
        [result, id],
    );
}

/** 重跑任务：重置为 todo，清空错误和结果，重试次数 +1 */
export async function retryTask(id: number): Promise<void> {
    await pool.query(
        `UPDATE sys_task
         SET status = 'todo', result = NULL, error_msg = NULL, retry_count = retry_count + 1, update_time = NOW()
         WHERE id = ? AND deleted = 0`,
        [id],
    );
}

/** 删除任务（逻辑删除） */
export async function deleteTask(id: number): Promise<void> {
    await pool.query(
        "UPDATE sys_task SET deleted = 1, update_time = NOW() WHERE id = ?",
        [id],
    );
}

/** 获取项目的任务统计（看板侧栏计数用） */
export async function getTaskStats(projectId: number): Promise<{ status: TaskStatus; count: number }[]> {
    const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT status, COUNT(*) AS count
         FROM sys_task
         WHERE project_id = ? AND deleted = 0
         GROUP BY status`,
        [projectId],
    );
    return rows as { status: TaskStatus; count: number }[];
}

// ============================================================
// sys_task 桥 helper（施工卡 1-2）：ext 检索 + 旁路化写入
//   桥=可观测层不是控制层：任何写库异常只 warn 不阻塞流水线
// ============================================================

/** 按外部编号（ExecTask.id, 如 T1/T2-F）查任务：传 phaseId=精确行；不传=取最新（id 最大——阶段顺序处理时即当前行） */
export async function getTaskByExt(projectId: number, extId: string, phaseId?: number): Promise<Task | null> {
    const [rows] = await pool.query<RowDataPacket[]>(
        phaseId == null
            ? "SELECT * FROM sys_task WHERE project_id = ? AND task_id_ext = ? AND deleted = 0 ORDER BY id DESC LIMIT 1"
            : "SELECT * FROM sys_task WHERE project_id = ? AND task_id_ext = ? AND phase_id = ? AND deleted = 0 ORDER BY id DESC LIMIT 1",
        phaseId == null ? [projectId, extId] : [projectId, extId, phaseId],
    );
    return (rows[0] as Task) ?? null;
}

/**
 * 幂等登记阶段任务（映射规则 = 施工手册 F6）：
 *  - ★ 幂等键=(project_id, phase_id, task_id_ext)——architect 的 id 是阶段内顺序号（每阶段都从 T1 起），
 *    不带 phase 会把阶段 2 的 T1 当成阶段 1 的重复而整段漏库（bridge-smoke 用例 5 抓到过）
 *  - depends_on 是 JSON 列：前端任务依赖配对后端 ["T5"]，后端任务 null
 *  - sort_order = 阶段*1000+序（跨阶段保持全局下发序）
 * 异常上抛，由调用方桥函数吞并 warn。
 */
export async function ensureTasksForPhase(tasks: ExecTask[], projectId: number, phaseId: number): Promise<void> {
    for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i]!;
        if (await getTaskByExt(projectId, t.id, phaseId)) continue;   // ★ 幂等键含 phase
        await createTask({
            project_id: projectId,
            phase_id: phaseId,
            title: t.title.slice(0, 199),                     // 列 varchar(200)
            description: t.description ?? null,
            status: "todo",
            assignee: t.layer === "frontend" ? "前端开发" : "后端开发",
            layer: t.layer,
            acceptance: t.acceptance ?? null,
            result: null,
            error_msg: null,
            retry_count: 0,
            task_id_ext: t.id,
            depends_on: t.layer === "frontend" ? JSON.stringify([t.id.replace(/-F$/, "")]) : null,
            sort_order: phaseId * 1000 + i,
        });
    }
}

/** 按 ext 旁路写状态（工位 doing / 判定 done·failed）：无行静默跳过（桥上线前的老任务），DB 异常只 warn */
export async function updateStatusByExt(projectId: number, extId: string, status: TaskStatus, errorMsg?: string): Promise<void> {
    try {
        const task = await getTaskByExt(projectId, extId);
        if (!task?.id) return;
        await updateTaskStatus(task.id, status, errorMsg);
    } catch (e) {
        console.warn(`[task-bridge] ${extId}→${status} 更新失败(不阻塞):`, (e as Error).message);
    }
}