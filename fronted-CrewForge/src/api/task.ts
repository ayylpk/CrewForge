import request from './request'
import type { Project } from '../types/project'

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