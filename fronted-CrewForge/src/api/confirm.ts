import request from './request'

/**
 * 确认门 API（sys_confirm，阶段 3）
 * 引擎在架构确认门等处挂起 → 问题落 sys_confirm → 本页轮询弹卡 → 人答 → 引擎轮询续跑。
 * 后端两组端点里前端只用 Web 侧（带 JWT）；engine 侧是机器通道。
 */

/** 一行待答问题（后端 Confirm 实体驼峰直出；optionsJson 是 JSON 数组字符串，展示前 parse） */
export interface ConfirmQuestion {
  id: number
  projectId: number
  questionId: string
  node: string        // architect / manager（发问节点，角标展示）
  question: string    // 题面
  optionsJson: string | null   // '["y","n"]'；null/空=自由文本题
  status: string      // pending / answered / auto_passed（列表接口只回 pending，history 回全部）
  reply: string | null // 人的答复；未答为 null（仅 history 有值）
  expireAt: string | null      // 超此时刻自动放行（默认答案=options 第一项）
  createTime: string
}

export function fetchPendingConfirms(projectId: number): Promise<ConfirmQuestion[]> {
  return request.get('/api/confirm/pending', { params: { projectId } }) as Promise<ConfirmQuestion[]>
}

/**
 * 项目全部问答记录（含已答/已放行），按 id 升序。
 * 需求对话页的对话记录靠它：pending 只回未答的，答完就消失，
 * 只轮询 pending 的话刷新一下对话就空了——看着像没连上（9/18）。
 */
export function fetchConfirmHistory(projectId: number): Promise<ConfirmQuestion[]> {
  return request.get('/api/confirm/history', { params: { projectId } }) as Promise<ConfirmQuestion[]>
}

export function answerConfirm(id: number, answer: string): Promise<void> {
  return request.post(`/api/confirm/${id}/answer`, { answer }) as Promise<void>
}

/** optionsJson → string[]（脏数据回退空数组=自由文本） */
export function parseOptions(c: ConfirmQuestion): string[] {
  if (!c.optionsJson) return []
  try {
    const arr = JSON.parse(c.optionsJson)
    return Array.isArray(arr) ? arr.map(String) : []
  } catch {
    return []
  }
}
