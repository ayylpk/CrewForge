import request from './request'
import type { agentNodeDTO, agentNodeVO } from '../types/agent'

/**
 * Agent 节点接口（sys_agent_node，池维度）
 * 一个池 Agent 可配多个节点，每节点一套系统提示词/工具/模型/温度
 * Agent 仓库编辑页（池模式）用；userId 后端从 JWT 取
 */

/** 按池 Agent id 查节点列表 */
export function fetchAgentNodes(agentId: number): Promise<agentNodeVO[]> {
  return request.get(`/api/agent-node/list/${agentId}`) as Promise<agentNodeVO[]>
}

/** 新增池节点 */
export function createAgentNode(dto: agentNodeDTO): Promise<void> {
  return request.post('/api/agent-node', dto) as Promise<void>
}

/** 更新池节点（id 走路径） */
export function updateAgentNode(id: number, dto: agentNodeDTO): Promise<void> {
  return request.put(`/api/agent-node/${id}`, dto) as Promise<void>
}

/** 删除池节点 */
export function deleteAgentNode(id: number): Promise<void> {
  return request.delete(`/api/agent-node/${id}`) as Promise<void>
}
