import request from './request'
import type { agentEdgeDTO, agentEdgeVO } from '../types/agent'

/**
 * Agent 边接口（sys_agent_edge，池维度）
 * 节点连线声明：from_node → type → to_nodes
 * 图编辑器（池模式）用；userId 后端从 JWT 取
 */

/** 按池 Agent id 查边列表 */
export function fetchAgentEdges(agentId: number): Promise<agentEdgeVO[]> {
  return request.get(`/api/agent-edge/list/${agentId}`) as Promise<agentEdgeVO[]>
}

/** 新增池边 */
export function createAgentEdge(dto: agentEdgeDTO): Promise<void> {
  return request.post('/api/agent-edge', dto) as Promise<void>
}

/** 更新池边（id 走路径） */
export function updateAgentEdge(id: number, dto: agentEdgeDTO): Promise<void> {
  return request.put(`/api/agent-edge/${id}`, dto) as Promise<void>
}

/** 删除池边 */
export function deleteAgentEdge(id: number): Promise<void> {
  return request.delete(`/api/agent-edge/${id}`) as Promise<void>
}
