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
  status: string      // pending（列表接口只回 pending）
  expireAt: string | null      // 超此时刻自动放行（默认答案=options 第一项）
  createTime: string
}

export function fetchPendingConfirms(projectId: number): Promise<ConfirmQuestion[]> {
  return request.get('/api/confirm/pending', { params: { projectId } }) as Promise<ConfirmQuestion[]>
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
