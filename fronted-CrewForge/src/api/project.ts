import request from './request'
import type { Project, ProjectCreateDTO } from '../types/project'

const CONFIRM_MAP: Record<string, number> = { green: 0, mixed: 1, manual: 2 }

/** 分页响应（对应后端 PageResult<T>） */
export interface PageResult<T> {
  total: number
  records: T[]
}

export function fetchProjects(): Promise<PageResult<Project>> {
  // userId 从登录时存的 cf_user_info 里解析（LoginResult.userId）
  const raw = localStorage.getItem('cf_user_info')
  const userId = raw ? (JSON.parse(raw) as { userId: number }).userId : 0
  // 参数放 URL query（后端 GET 接口用 @ModelAttribute 绑定，不用 @RequestBody）
  return request.get('/api/project', {
    params: { page: 1, pageSize: 20, projectType: 1, userId },
  }) as Promise<PageResult<Project>>
}

export function fetchTeamProjects(tenantId: number): Promise<PageResult<Project>> {
  return request.get('/api/project', {
    params: { page: 1, pageSize: 20, projectType: 2, tenantId },
  }) as Promise<PageResult<Project>>
}

/** 查询单个项目（详情页用） */
export function fetchProjectById(id: number): Promise<Project> {
  return request.get(`/api/project/${id}`) as Promise<Project>
}

/** 删除项目 */
export function deleteProject(id: number): Promise<void> {
  return request.delete(`/api/project/${id}`) as Promise<void>
}

/** 更新项目（Partial 只传要改的字段；后端 DTO 白名单 + updateById 只更新非 null 字段） */
export function updateProject(id: number, dto: Partial<ProjectCreateDTO>): Promise<void> {
  return request.put(`/api/project/${id}`, {
    ...dto,
    // confirmMode 页面是字符串，后端要数字；undefined 时不传（不修改）
    confirmMode: dto.confirmMode ? CONFIRM_MAP[dto.confirmMode] : undefined,
  }) as Promise<void>
}

export function createProject(dto: ProjectCreateDTO): Promise<void> {
  // createUser 从登录信息取（后端 DTO 注释：前端传当前登录用户）
  const raw = localStorage.getItem('cf_user_info')
  const createUser = raw ? (JSON.parse(raw) as { userId: number }).userId : 0
  // 展开 dto 传全部字段，confirmMode 转数字，projectType/createUser 强制覆盖为个人项目
  return request.post('/api/project', {
    ...dto,
    confirmMode: CONFIRM_MAP[dto.confirmMode],
    projectType: 1,
    createUser,
  }) as Promise<void>
}

export function createTeamProject(dto: ProjectCreateDTO, tenantId: number): Promise<void> {
  const raw = localStorage.getItem('cf_user_info')
  const createUser = raw ? (JSON.parse(raw) as { userId: number }).userId : 0
  return request.post('/api/project', {
    ...dto,
    confirmMode: CONFIRM_MAP[dto.confirmMode],
    projectType: 2,
    tenantId,
    createUser,
  }) as Promise<void>
}
