import request from './request'

/**
 * 命令执行权限规则 API（/api/permission，9/18）
 *
 * 与确认门的分工：
 *   确认门（api/confirm）—— 一次性的"这一次能不能跑"（挂起 → 人拍板 → 引擎续跑）
 *   这里       —— 持久化的"这类命令以后还用不用问"（三态规则 + 分层来源）
 * 点"始终允许"时，后端会用审批卡里带的 ruleContent 写一条规则到这里；
 * 前端只负责显示与增删改，**不自己拼规则内容**（猜错就是把过宽的规则写进库）。
 */

/** 规则分层来源的优先级：policy > project > user > session（判定时首个命中为准） */
export type RuleSource = 'policy' | 'project' | 'user' | 'session'
export type RuleBehavior = 'allow' | 'deny' | 'ask'

export interface PermissionRule {
  id: number
  /** 0 = 全局（跟着人走，跨项目生效）；否则 = 项目级（跟着项目走） */
  projectId: number
  toolName: string
  /** 规则内容，即 Bash(<这里>) 括号内那部分；空串 = 该工具整条规则 */
  ruleContent: string
  behavior: RuleBehavior
  source: RuleSource
  /** 0 = 已停用（仍留档：复发时能对照"当初为什么加了这条"） */
  enabled: number
  note: string | null
  createTime: string
  updateTime: string
}

export function fetchPermissionRules(projectId: number): Promise<PermissionRule[]> {
  return request.get('/api/permission/rules', { params: { projectId } }) as Promise<PermissionRule[]>
}

export function addPermissionRule(rule: Partial<PermissionRule>): Promise<PermissionRule> {
  return request.post('/api/permission/rules', rule) as Promise<PermissionRule>
}

/** 停用（不物理删：停用后仍能在列表里看见它曾经存在过） */
export function disablePermissionRule(id: number): Promise<void> {
  return request.delete(`/api/permission/rules/${id}`) as Promise<void>
}

/** 最近被拒的审批 —— 让人看见闸门实际拦下了什么（不然"拦住了"这件事没有任何痕迹） */
export function fetchRecentDenials(projectId: number, limit = 20): Promise<unknown[]> {
  return request.get('/api/permission/denials', { params: { projectId, limit } }) as Promise<unknown[]>
}
