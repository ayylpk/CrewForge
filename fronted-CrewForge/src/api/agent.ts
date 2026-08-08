import request from './request'
import type { agentDTO, agentVO } from '../types/agent'

/**
 * 项目 Agent 接口（sys_project_agent）
 * 团队配置页：查询回显 / 新增 / 修改 / 删除
 * 删除 ids 走复合字符串格式："projectId-id1-id2"
 */

/** 查询某项目某用户的全部 Agent（无分页，团队配置页回显用） */
export function fetchAllProjectAgents(projectId: number, userId: number): Promise<agentVO[]> {
  return request.get('/api/project-agent/all', {
    params: { projectId, userId },
  }) as Promise<agentVO[]>
}

/** 查询单个项目 Agent（详情/编辑回显用） */
export function fetchProjectAgentById(id: number): Promise<agentVO> {
  return request.get(`/api/project-agent/${id}`) as Promise<agentVO>
}

/** 新增项目 Agent */
export function createProjectAgent(dto: agentDTO): Promise<void> {
  return request.post('/api/project-agent', dto) as Promise<void>
}

/** 更新项目 Agent（id 走路径） */
export function updateProjectAgent(id: number, dto: agentDTO): Promise<void> {
  return request.put(`/api/project-agent/${id}`, dto) as Promise<void>
}

/** 删除项目 Agent（ids 复合格式：projectId-id1-id2） */
export function deleteProjectAgents(projectId: number, ids: number[]): Promise<void> {
  return request.delete(`/api/project-agent/${projectId}-${ids.join('-')}`) as Promise<void>
}

/** 从 Agent 池批量复制到项目（复制非引用，返回复制的数量） */
export function copyFromPool(projectId: number, userId: number, agentIds: number[]): Promise<number> {
  return request.post('/api/project-agent/copy', { projectId, userId, agentIds }) as Promise<number>
}
