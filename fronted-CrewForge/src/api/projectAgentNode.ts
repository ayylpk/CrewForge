import request from './request'
import type { projectAgentNodeDTO, projectAgentNodeVO } from '../types/agent'

/**
 * 项目成员节点接口（sys_project_agent_node，项目维度）
 * 拉取成员时从池复制一份节点进项目，项目内修改不影响池
 * 团队配置成员详细面板（项目模式）用；userId 后端从 JWT 取
 */

/** 按项目 + 池 Agent 查成员节点列表 */
export function fetchProjectAgentNodes(projectId: number, agentId: number): Promise<projectAgentNodeVO[]> {
  return request.get('/api/project-agent-node/list', {
    params: { projectId, agentId },
  }) as Promise<projectAgentNodeVO[]>
}

/** 新增成员节点 */
export function createProjectAgentNode(dto: projectAgentNodeDTO): Promise<void> {
  return request.post('/api/project-agent-node', dto) as Promise<void>
}

/** 更新成员节点（id 走路径） */
export function updateProjectAgentNode(id: number, dto: projectAgentNodeDTO): Promise<void> {
  return request.put(`/api/project-agent-node/${id}`, dto) as Promise<void>
}

/** 删除成员节点 */
export function deleteProjectAgentNode(id: number): Promise<void> {
  return request.delete(`/api/project-agent-node/${id}`) as Promise<void>
}
