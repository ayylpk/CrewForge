/**
 * Agent 相关类型定义（与后端 Entity/API 对齐）
 *
 * 两张表：
 * - sys_agent（Agent 池）：用户自定义的 Agent 档案，按 userId 隔离，跨项目复用
 * - sys_project_agent（项目 Agent）：创建项目团队时从池里复制一份，每个成员一行
 */

/** 分页响应（对应后端 PageResult<T>） */
export interface PageResult<T> {
  total: number
  records: T[]
}

/**
 * 项目 Agent 实体（对应后端 ProjectAgentVO / sys_project_agent 表）
 * 从池里复制一份过来，每个项目成员一行；主键 id 就是项目内 agent_id
 */
export interface agentVO {
  /** 项目内 Agent ID（精准定位用） */
  id: number
  /** 所属项目 ID */
  projectId: number
  /** 所属用户 ID（数据隔离，与 projectId 双条件） */
  userId: number
  /** Agent 名称（复制自池，项目内可再改） */
  name: string
  /** 职位描述，如"负责 Vue 前端开发" */
  role: string
  /** 系统提示词 */
  systemPrompt: string
  /** 可用工具列表（后端是 JSON 数组字符串，如 '["web_search","read_file"]'） */
  tools: string
  /** 模型，如 deepseek/deepseek-v4-flash */
  model: string
  /** 采样温度 0.0-2.0 */
  temperature: number
  /** 状态: 1-参与项目, 0-已移出 */
  status: number
  createTime: string
  updateTime: string
}

/** 新建/更新项目 Agent 请求（对应后端 ProjectAgentDTO）
 * 注意：无 id 字段——新增走 POST，更新走 PUT /{id}（id 在路径里）
 */
export interface agentDTO {
  /** 所属项目 ID（必传） */
  projectId: number
  /** 所属用户 ID（必传，数据隔离用） */
  userId: number
  /** Agent 名称 */
  name: string
  /** 职位描述 */
  role: string
  /** 系统提示词 */
  systemPrompt: string
  /** 工具列表(JSON 数组字符串) */
  tools: string
  /** 模型 */
  model: string
  /** 采样温度 0.0-2.0 */
  temperature: number | null
  /** 状态: 1-参与项目, 0-已移出（不传默认 1） */
  status?: number
}

/**
 * Agent 池实体（对应后端 AgentPoolVO / sys_agent 表）
 * 用户永久自定义保存的 Agent 档案，按用户隔离
 */
export interface agentPoolVO {
  /** 池内 Agent ID */
  id: number
  /** 所属用户 ID（池按用户隔离，前端调用时传入） */
  userId: number
  /** Agent 名称（同一用户下唯一，后端 uk_user_name 约束） */
  name: string
  /** 职位描述 */
  role: string
  /** 系统提示词 */
  systemPrompt: string
  /** 可用工具列表（后端是 JSON 数组字符串） */
  tools: string
  /** 模型 */
  model: string
  /** 采样温度 0.0-2.0 */
  temperature: number
  /** 状态: 1-启用, 0-停用 */
  status: number
  createTime: string
  updateTime: string
}

/** 新建/更新 Agent 池请求（对应后端 AgentPoolDTO，userId 必须前端传） */
export interface agentPoolDTO {
  /** 所属用户 ID（必传，后端不取 token） */
  userId: number
  /** Agent 名称（同一用户下不重名） */
  name: string
  /** 职位描述 */
  role?: string
  /** 系统提示词 */
  systemPrompt?: string
  /** 工具列表(JSON 数组字符串) */
  tools?: string
  /** 模型 */
  model?: string
  /** 采样温度 0.0-2.0 */
  temperature?: number
  /** 状态: 1-启用, 0-停用（不传默认 1） */
  status?: number
}

/** Agent 池分页查询参数（对应后端 AgentPoolQueryParam，GET 请求体） */
export interface agentPoolQueryParam {
  page?: number
  pageSize?: number
  /** 用户 ID（按 userId 隔离） */
  userId: number
  /** 模糊匹配 name/role */
  keyword?: string
}

/** 项目 Agent 分页查询参数（对应后端 ProjectAgentQueryParam，GET 请求体） */
export interface agentQueryParam {
  page?: number
  pageSize?: number
  /** 团队 ID（后端 SQL 未使用，实际按 projectId 过滤） */
  tenantId?: number
  /** 项目 ID（实际过滤条件） */
  projectId: number
  /** 模糊匹配 name/role */
  keyword?: string
}
