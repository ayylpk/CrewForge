import request from './request'
import type { agentPoolDTO, agentPoolQueryParam, agentPoolVO, PageResult } from '../types/agent'

/**
 * Agent 池接口（sys_agent，自定义 Agent 仓库）
 * 按 userId 隔离（userId 后端从 JWT 取）；删除 ids 走连字符格式："id1-id2"
 */

/** 分页查询 Agent 池（query params 绑定；userId 后端从 JWT 取） */
export function fetchAgentPool(query: agentPoolQueryParam): Promise<PageResult<agentPoolVO>> {
  return request.get('/api/agent', {
    params: { page: query.page ?? 1, pageSize: query.pageSize ?? 20, keyword: query.keyword },
  }) as Promise<PageResult<agentPoolVO>>
}

/** 查询单个池 Agent（详情/编辑回显用） */
export function fetchAgentPoolById(id: number): Promise<agentPoolVO> {
  return request.get(`/api/agent/${id}`) as Promise<agentPoolVO>
}

/** 新建池 Agent，返回新 Agent id（挂节点用） */
export function createAgentPool(dto: agentPoolDTO): Promise<number> {
  return request.post('/api/agent', dto) as Promise<number>
}

/** 更新池 Agent（id 走路径） */
export function updateAgentPool(id: number, dto: agentPoolDTO): Promise<void> {
  return request.put(`/api/agent/${id}`, dto) as Promise<void>
}

/** 删除池 Agent（ids 连字符格式：id1-id2；userId 后端从 JWT 取） */
export function deleteAgentPool(ids: number[]): Promise<void> {
  return request.delete(`/api/agent/${ids.join('-')}`) as Promise<void>
}
