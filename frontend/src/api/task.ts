import request from './request'

/** 任务状态（与看板四列一致） */
export type TaskStatus = 'todo' | 'doing' | 'done' | 'failed'

/** 任务（对应后端 sys_task VO） */
export interface TaskItem {
  id: number
  projectId: number
  phaseId: number | null
  title: string
  description: string | null
  status: TaskStatus
  assignee: string | null
  layer: string | null
  acceptance: string | null
  result: string | null
  errorMsg: string | null
  retryCount: number
  taskIdExt: string | null
  dependsOn: string | null
  sortOrder: number
  createTime: string
  updateTime: string
}

export interface TaskQualitySummary {
  evaluated: number
  passed: number
  failed: number
  firstPassRate: number
  totalRetries: number
  failureCategories: { label: string; count: number }[]
}

/** 从任务桥已有字段计算质量摘要；不引入会话级状态，也不依赖 LLM。 */
export function summarizeTaskQuality(tasks: TaskItem[]): TaskQualitySummary {
  const terminal = tasks.filter((task) => task.status === 'done' || task.status === 'failed')
  const categoryCounts = new Map<string, number>()
  for (const task of terminal.filter((item) => item.status === 'failed')) {
    const text = task.errorMsg || ''
    const label = /import|导出|export|request\.ts|utils[\\/]request/i.test(text) ? 'Import/导出' :
      /api|接口|路由|mapping|endpoint|method|path/i.test(text) ? 'API 契约' :
      /编译|syntax|type.?check|compile|语法/i.test(text) ? '编译/语法' :
      /白屏|渲染|render|dom|页面/i.test(text) ? '渲染/UI' :
      /依赖|dependency|package|npm|bun|maven|gradle/i.test(text) ? '依赖' :
      /落盘|数据库|持久化|database|persist|upsert/i.test(text) ? '持久化' : '其他'
    categoryCounts.set(label, (categoryCounts.get(label) || 0) + 1)
  }
  const evaluated = terminal.length
  const passed = terminal.filter((task) => task.status === 'done').length
  return {
    evaluated,
    passed,
    failed: evaluated - passed,
    firstPassRate: evaluated ? Math.round((terminal.filter((task) => task.status === 'done' && task.retryCount === 0).length / evaluated) * 100) : 0,
    totalRetries: tasks.reduce((sum, task) => sum + Math.max(0, task.retryCount || 0), 0),
    failureCategories: [...categoryCounts.entries()].sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ label, count })),
  }
}

/** 查询项目的全部任务（看板用） */
export function fetchTasks(projectId: number): Promise<TaskItem[]> {
  return request.get('/api/task/list', { params: { projectId } }) as Promise<TaskItem[]>
}

/** 按状态过滤 */
export function fetchTasksByStatus(projectId: number, status: TaskStatus): Promise<TaskItem[]> {
  return request.get('/api/task/list', { params: { projectId, status } }) as Promise<TaskItem[]>
}

/** 查询单个任务 */
export function fetchTaskById(id: number): Promise<TaskItem> {
  return request.get(`/api/task/${id}`) as Promise<TaskItem>
}

/** 更新任务状态（看板拖拽 / 引擎推进） */
export function updateTaskStatus(id: number, status: TaskStatus, errorMsg?: string): Promise<void> {
  return request.put(`/api/task/${id}/status`, { status, errorMsg } as any) as Promise<void>
}

/** 重跑任务 */
export function retryTask(id: number): Promise<void> {
  return request.post(`/api/task/${id}/retry`) as Promise<void>
}

/** 创建任务 */
export function createTask(data: {
  projectId: number
  phaseId?: number
  title: string
  description?: string
  assignee?: string
  layer?: string
  acceptance?: string
  taskIdExt?: string
  dependsOn?: string
}): Promise<void> {
  return request.post('/api/task', data as any) as Promise<void>
}
