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
 * 工具函数（对应运行时 agents-CrewForge/tools.ts 的 Tool 结构）
 * 节点/Agent 的 tools 字段存的是 toolItem[] 的 JSON 字符串
 */
export interface toolItem {
  /** 函数名（LLM 调用标识，必填） */
  name: string
  /** 作用描述（发给 LLM，必填） */
  description: string
  /** 参数声明（JSON Schema 对象，发给 LLM 用；空 = 无参数） */
  parameters?: Record<string, unknown> | null
  /** 函数体（箭头函数代码字符串，运行时 new Function 执行；缺省 = 仅声明不可执行） */
  code?: string
}

/**
 * 项目 Agent 实体（对应后端 ProjectAgentVO / sys_project_agent 表）
 * 成员行引用池 Agent（agentId），name/role 由后端 JOIN sys_agent 带出
 * 主键 id 就是项目内成员 id；节点配置在 sys_project_agent_node（复制自池）
 */
export interface agentVO {
  /** 项目内成员 ID（精准定位用） */
  id: number
  /** 所属项目 ID */
  projectId: number
  /** 所属用户 ID（数据隔离，与 projectId 双条件） */
  userId: number
  /** 关联池 Agent id（sys_agent.id）；手动添加的成员可能为空 */
  agentId: number | null
  /** Agent 名称（JOIN 池带出，池删除后仍保留） */
  name: string
  /** 职位描述（JOIN 池带出） */
  role: string
  /** 兼容旧字段：后端 ProjectAgentVO 不返回这些，保留类型避免破坏现有引用（值恒为 undefined） */
  systemPrompt?: string
  tools?: string
  model?: string
  temperature?: number | null
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
  /** Agent 名称 */
  name: string
  /** 职位描述 */
  role: string
  /** 系统提示词 */
  systemPrompt: string
  /** 工具列表(toolItem[] 的 JSON 字符串，含函数体代码) */
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
  /** Agent 名称（可重复，ID 是唯一标识） */
  name: string
  /** 职位描述 */
  role: string
  /** 系统提示词 */
  systemPrompt: string
  /** 可用工具列表（toolItem[] 的 JSON 字符串，含函数体代码） */
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

/** 新建/更新 Agent 池请求（对应后端 AgentPoolDTO；userId 后端从 JWT 取，前端不传） */
export interface agentPoolDTO {
  /** Agent 名称（可重复，ID 是唯一标识） */
  name: string
  /** 职位描述 */
  role?: string
  /** 系统提示词 */
  systemPrompt?: string
  /** 工具列表(toolItem[] 的 JSON 字符串，含函数体代码) */
  tools?: string
  /** 模型 */
  model?: string
  /** 采样温度 0.0-2.0 */
  temperature?: number
  /** 状态: 1-启用, 0-停用（不传默认 1） */
  status?: number
}

/** Agent 池分页查询参数（对应后端 AgentPoolQueryParam，GET 请求体；userId 后端从 JWT 取） */
export interface agentPoolQueryParam {
  page?: number
  pageSize?: number
  /** 模糊匹配 name/role */
  keyword?: string
}

/** 项目 Agent 分页查询参数（对应后端 ProjectAgentQueryParam，GET 请求体） */
export interface agentQueryParam {
  page?: number
  pageSize?: number
  /** 项目 ID（实际过滤条件） */
  projectId: number
  /** 模糊匹配 name/role */
  keyword?: string
}

/**
 * Agent 节点（对应后端 AgentNodeVO / sys_agent_node 表）
 * 一个池 Agent 可配多个节点，每节点一套系统提示词/工具/模型/温度
 */
export interface agentNodeVO {
  /** 节点 ID */
  id: number
  /** 关联池 Agent id（sys_agent.id） */
  agentId: number
  /** 节点名称，如"规划节点"、"编码节点" */
  nodeName: string
  /** 节点作用描述 */
  description: string
  /** 系统提示词 */
  systemPrompt: string
  /** 采样温度 0.0-2.0 */
  temperature: number
  /** 可用工具列表（toolItem[] 的 JSON 字符串，含函数体代码） */
  tools: string
  /** 模型，如 deepseek/deepseek-v4-flash；空 = 跟随全局 */
  model: string
  /** 节点类型: llm=调模型 / code=纯代码(按 codeKey 注册) / human=交互门 */
  nodeType: string
  /** 结构化输出 schema 注册名（仅 llm 节点用，可空） */
  schemaKey: string | null
  /** 代码节点注册名（仅 code 节点用，对应运行时 CodeRegistry） */
  codeKey: string | null
  /** 输出 state 通道名（缺省=nodeName；不能与节点名重名，LangGraph 硬约束） */
  output: string | null
  createTime: string
  updateTime: string
}

/** 新建/更新池 Agent 节点请求（对应后端 AgentNodeDTO；id 走路径，agentId 必传） */
export interface agentNodeDTO {
  /** 关联池 Agent id（必传） */
  agentId: number
  /** 节点名称 */
  nodeName: string
  /** 节点作用描述 */
  description?: string
  /** 系统提示词 */
  systemPrompt?: string
  /** 工具列表(toolItem[] 的 JSON 字符串，含函数体代码) */
  tools?: string
  /** 模型 */
  model?: string
  /** 采样温度（不传后端给默认 0.7） */
  temperature?: number | null
  /** 节点类型: llm/code/human（不传后端默认 llm） */
  nodeType?: string
  /** 结构化输出 schema 注册名 */
  schemaKey?: string
  /** 代码节点注册名 */
  codeKey?: string
  /** 输出 state 通道名 */
  output?: string
}

/**
 * Agent 边（对应后端 AgentEdgeVO / sys_agent_edge 表）
 * 节点连线声明：from_node → type → to_nodes
 * 设计原则：节点干什么由代码决定，节点怎么连由 DB 决定
 */
export interface agentEdgeVO {
  /** 边 ID */
  id: number
  /** 关联池 Agent id（sys_agent.id） */
  agentId: number
  /** 起点节点名（__start__ = 图起点） */
  fromNode: string
  /** 连接方式: direct=普通边 / conditional=条件边 / parallel=并行分支 */
  type: 'direct' | 'conditional' | 'parallel'
  /** 下一批节点(字符串):
   *  direct → 单个节点名（如 "finish"）
   *  conditional → JSON {"cond":"条件key","true":"节点","false":"节点"}
   *  parallel → JSON 数组 ["节点A","节点B"] */
  toNodes: string
  createTime: string
  updateTime: string
}

/** 新建/更新池 Agent 边请求（对应后端 AgentEdgeDTO；id 走路径，agentId 必传） */
export interface agentEdgeDTO {
  /** 关联池 Agent id（必传） */
  agentId: number
  /** 起点节点名（必传；__start__ = 图起点） */
  fromNode: string
  /** 连接方式: direct / conditional / parallel（不传默认 direct） */
  type?: 'direct' | 'conditional' | 'parallel'
  /** 下一批节点（必传；格式见 agentEdgeVO.toNodes 注释） */
  toNodes: string
}

/**
 * 项目成员节点（对应后端 ProjectAgentNodeVO / sys_project_agent_node 表）
 * 拉取成员时从池复制一份，项目内独立修改
 */
export interface projectAgentNodeVO {
  id: number
  projectId: number
  /** 来源池 Agent id（sys_agent.id） */
  agentId: number
  userId: number
  nodeName: string
  description: string
  systemPrompt: string
  temperature: number
  /** 工具列表（toolItem[] 的 JSON 字符串，含函数体代码） */
  tools: string
  model: string
  /** 节点类型: llm/code/human */
  nodeType: string
  /** 结构化输出 schema 注册名 */
  schemaKey: string | null
  /** 代码节点注册名 */
  codeKey: string | null
  /** 输出 state 通道名 */
  output: string | null
  createTime: string
  updateTime: string
}

/** 新建/更新项目成员节点请求（对应后端 ProjectAgentNodeDTO） */
export interface projectAgentNodeDTO {
  /** 项目 ID（必传） */
  projectId: number
  /** 来源池 Agent id（必传，即成员的 agentId） */
  agentId: number
  nodeName: string
  description?: string
  systemPrompt?: string
  /** 工具列表（toolItem[] 的 JSON 字符串，含函数体代码） */
  tools?: string
  model?: string
  temperature?: number | null
  /** 节点类型: llm/code/human（不传后端默认 llm） */
  nodeType?: string
  /** 结构化输出 schema 注册名 */
  schemaKey?: string
  /** 代码节点注册名 */
  codeKey?: string
  /** 输出 state 通道名 */
  output?: string
}
