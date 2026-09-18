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
  node: string        // architect / manager / bash（发问节点，角标展示）
  /** 卡的类型（9/18）：permission=审批卡（三态按钮）/ question=问答卡 */
  kind: 'question' | 'permission'
  question: string    // 题面
  optionsJson: string | null   // '["y","n"]'；null/空=自由文本题
  /**
   * "要执行什么"（审批卡）：**JSON 字符串**，用 parseDetail 解析。
   *
   * ⚠️ 为什么是字符串：`/pending` 与 `/history` 回的是**实体**（optionsJson 同款），
   *    只有 ask/getAnswer 那条路回的是解析好的对象。踩过：卡片一开始读的是 `detail`
   *    对象 → 两个字段恒为 undefined → 卡上恰好缺了命令原文与"将写入的规则"，
   *    也就是缺了"人必须看得见自己批的是什么"的全部。
   */
  detailJson: string | null
  status: string      // pending / answered / auto_passed（列表接口只回 pending，history 回全部）
  reply: string | null // 人的答复；未答为 null（仅 history 有值）
  /** 权限卡的裁定：allow_once / allow_always / deny */
  decision: string | null
  expireAt: string | null      // 超此时刻自动放行（默认答案=options 第一项）
  createTime: string
}

/**
 * 审批卡里"要执行什么"。
 * 这些键由**发起方**（引擎 / testAgent）决定，后端只原样存回 —— 所以前端也按需取用、不假设全有。
 */
export interface PermissionDetail {
  tool?: string        // 工具名：bash
  command?: string     // 命令原文（人必须看得见自己批的是什么）
  cwd?: string         // 在哪个目录跑
  why?: string         // 为什么要问（不在白名单 / 命中哪条规则 / 危险）
  matchRule?: string | null
  preview?: string     // 预览：文件 diff、展开后的命令等
  /** 选了"始终允许"会写入的规则内容，如 `npm install:*`；后端把 Bash(...) 的括号里那部分放这 */
  ruleContent?: string | null
}

/** 权限卡的三个按钮（与 opencode 的 allowOnce/allowAlways/deny 一一对应） */
export type PermissionDecision = 'allow_once' | 'allow_always' | 'deny'

/** 答复权限卡：走 decision，不走 answer —— 引擎要靠可判定的枚举决定放行与否 */
export function answerPermission(id: number, decision: PermissionDecision): Promise<void> {
  return request.post(`/api/confirm/${id}/answer`, { decision }) as Promise<void>
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

/**
 * detailJson → 审批卡要展示的东西（脏数据回退空对象=退化成"只有题面"，也不至于炸）。
 * 与 parseOptions 同一形态：库里这些列都是**双形状**（实体直出是字符串，
 * snapshot 出口是对象），解析一律收在这一个地方，免得每个调用方各写一遍 try/catch。
 */
export function parseDetail(c: ConfirmQuestion): PermissionDetail {
  const raw = c.detailJson
  if (!raw) return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as PermissionDetail) : {}
  } catch {
    return {}
  }
}
