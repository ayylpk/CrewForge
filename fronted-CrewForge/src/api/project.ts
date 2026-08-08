import request from './request'
import type { Project, ProjectCreateDTO } from '../types/project'

const CONFIRM_MAP: Record<string, number> = { green: 0, mixed: 1, manual: 2 }

/** 分页响应（对应后端 PageResult<T>） */
export interface PageResult<T> {
  total: number
  records: T[]
}

export function fetchProjects(): Promise<PageResult<Project>> {
  // userId 后端从 JWT 取，前端不传
  return request.get('/api/project', {
    params: { page: 1, pageSize: 20, projectType: 1 },
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
  // createUser 后端从 JWT 取，前端不传
  return request.post('/api/project', {
    ...dto,
    confirmMode: CONFIRM_MAP[dto.confirmMode],
    projectType: 1,
  }) as Promise<void>
}

export function createTeamProject(dto: ProjectCreateDTO, tenantId: number): Promise<void> {
  return request.post('/api/project', {
    ...dto,
    confirmMode: CONFIRM_MAP[dto.confirmMode],
    projectType: 2,
    tenantId,
  }) as Promise<void>
}
