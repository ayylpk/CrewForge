/**
 * agents.ts —— Agent 花名册（日志流名字/头像映射，非 mock）
 * 编号对齐引擎 Hub.ts roles（manager=0/architect=1/...）偏移 1 起，0=系统行
 * （历史：原 mocks/execution.ts 的 AGENT_NAMES——假时间线随施工卡 1-4 撤除后仅存此表）
 */
export const AGENT_NAMES: Record<number, { name: string; avatar: string }> = {
  1: { name: 'AI 经理', avatar: 'agent-manager.png' },
  2: { name: '架构师', avatar: 'agent-architect.png' },
  3: { name: '后端 Agent', avatar: 'agent-backend.png' },
  4: { name: '前端 Agent', avatar: 'agent-frontend.png' },
  5: { name: '测试 Agent', avatar: 'agent-tester.png' },
  6: { name: '维护 Agent', avatar: 'agent-maintainer.png' },
}
