import request from './request'
import type { agentPoolDTO, agentPoolQueryParam, agentPoolVO, PageResult } from '../types/agent'

/**
 * Agent 池接口（sys_agent，自定义 Agent 仓库）
 * 按 userId 隔离；删除 ids 走复合字符串格式："userId-id1-id2"
 */

/** 分页查询 Agent 池（query params 绑定） */
export function fetchAgentPool(query: agentPoolQueryParam): Promise<PageResult<agentPoolVO>> {
  return request.get('/api/agent', {
    params: { page: query.page ?? 1, pageSize: query.pageSize ?? 20, userId: query.userId, keyword: query.keyword },
  }) as Promise<PageResult<agentPoolVO>>
}

/** 查询单个池 Agent（详情/编辑回显用） */
export function fetchAgentPoolById(id: number): Promise<agentPoolVO> {
  return request.get(`/api/agent/${id}`) as Promise<agentPoolVO>
}

/** 新建池 Agent（后端不取 token，userId 必须前端传） */
export function createAgentPool(dto: agentPoolDTO): Promise<void> {
  return request.post('/api/agent', dto) as Promise<void>
}

/** 更新池 Agent（id 走路径） */
export function updateAgentPool(id: number, dto: agentPoolDTO): Promise<void> {
  return request.put(`/api/agent/${id}`, dto) as Promise<void>
}

/** 删除池 Agent（ids 复合格式：userId-id1-id2） */
export function deleteAgentPool(userId: number, ids: number[]): Promise<void> {
  return request.delete(`/api/agent/${userId}-${ids.join('-')}`) as Promise<void>
}
