/**
 * 项目相关类型定义（与后端 Entity/API 对齐）
 */

/** 项目状态（与后端 sys_project.status 对应） */
export type ProjectStatus =
  | 'draft'        // 草稿
  | 'clarifying'   // 需求澄清中
  | 'planning'     // 规划中
  | 'executing'    // 执行中
  | 'paused'       // 已暂停
  | 'done'         // 已完成
  | 'failed'       // 失败

/** 确认模式（创建提交时用字符串；后端返回数字 0/1/2） */
export type ConfirmMode = 'green' | 'mixed' | 'manual'

/** 项目（对应后端 ProjectVO） */
export interface Project {
  /** 项目 ID */
  id: number
  /** 项目名称 */
  name: string
  /** 项目描述（原始需求：这个项目要做什么样子的项目） */
  description: string
  /** 项目状态: draft/clarifying/planning/executing/paused/done/failed */
  status: ProjectStatus
  /** 确认模式: 0-全绿灯, 1-混合, 2-手动（后端返回数字） */
  confirmMode: number
  /** 创建人用户 ID */
  createUser: number
  /** 创建时间 */
  createTime: string
  /** 最后更新时间 */
  updateTime: string
  /** 需求澄清后的结构化文档(Markdown)，项目经理澄清后生成 */
  clarifiedReq?: string | null
  /** 业务模块/功能列表（后端是 JSON 字符串，如 ["客户管理","跟进记录"]） */
  businessModules?: string | null
  /** 技术栈列表（后端是 JSON 字符串，如 ["Spring Boot","Vue 3"]，前端解析成数组） */
  techStack?: string | null
  /** 开发计划（后端是 JSON 字符串，架构师生成） */
  devPlan?: string | null
  /** 项目目录树（后端是 JSON 字符串，架构师设计，形如 [{name,type,children}]） */
  dirTree?: string | null
  /** 技术栈标签数组（前端从 techStack 解析后填充） */
  stack?: string[]
  /** 整体进度 0-100（后端暂无此字段，保留兼容旧展示） */
  progress?: number
  /** 文件数（后端暂无此字段，保留兼容旧展示） */
  fileCount?: number
  /** 模块数（后端暂无此字段，保留兼容旧展示） */
  moduleCount?: number
}

/** 新建/更新项目请求（对应后端 ProjectDTO，字段白名单与后端对齐）
 * 创建时必填 name/description/confirmMode；
 * 更新时用 Partial<ProjectCreateDTO> 只传要改的字段 */
export interface ProjectCreateDTO {
  /** 项目名称 */
  name: string
  /** 项目描述（要做什么样子的项目） */
  description: string
  /** 确认模式（前端字符串，提交时经 CONFIRM_MAP 转数字 0/1/2） */
  confirmMode: ConfirmMode
  /** 需求澄清后的结构化文档(Markdown) */
  clarifiedReq?: string
  /** 业务模块/功能列表(JSON 数组字符串)，如 '["客户管理","跟进记录"]' */
  businessModules?: string
  /** 技术栈列表(JSON 数组字符串)，如 '["Spring Boot","Vue 3"]' */
  techStack?: string
  /** 开发计划(JSON 数组字符串) */
  devPlan?: string
  /** 项目目录树(JSON 数组字符串) */
  dirTree?: string
  /** 项目状态: draft/clarifying/planning/executing/paused/done/failed */
  status?: ProjectStatus
}
