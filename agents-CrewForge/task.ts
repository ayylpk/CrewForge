import mysql, { type RowDataPacket, type ResultSetHeader } from "mysql2/promise";

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