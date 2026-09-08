import request from './request'

/**
 * 运行时设置 API（cc-switch 设置页 → sys_settings 单行，阶段 2）
 * 语义与后端 SettingsController 对齐：apiKey 只进不出（GET 永远掩码，PUT 掩码回传=不改）。
 * 引擎直读该表（30s 缓存）——保存后最多半分钟对新起的 LLM 调用生效，无需重启任何进程。
 */

/** 与后端 SettingsDTO/getMasked 对齐（smokeBuild 后端出参是 boolean） */
export interface RuntimeSettings {
  modelName?: string | null
  /** T3：pro 档模型名（空=不分层，pro 角色退回全局名） */
  modelPro?: string | null
  /** T3：角色→档位 JSON 文本 {architect:"pro",...}（留空=内置档位表） */
  roleModels?: string | null
  modelUrl?: string | null
  apiKey?: string | null   // 永远掩码（****末4位 / null）
  modelKind?: string       // 'deepseek' | 'openai'
  javaBaseUrl?: string | null
  confirmTimeoutMin?: number
  smokeBuild?: boolean
  /** T7a：最外层端点总闸（全局在飞 LLM 调用上限，默认 6） */
  llmConcurrency?: number | null
  /** T7a：工位阶段令牌（每把阶段闸在制上限，默认 5） */
  stationSlots?: number | null
  /** T7b：工位工具模式（1=前后端开发走 read/write/edit 工具循环；端点兼容性验证后再开） */
  toolMode?: boolean
}

export function fetchSettings(): Promise<RuntimeSettings> {
  return request.get('/api/settings') as Promise<RuntimeSettings>
}

export function saveSettings(dto: RuntimeSettings): Promise<void> {
  return request.put('/api/settings', dto) as Promise<void>
}

/** 测试连接返回（不落库） */
export interface TestResult {
  ok: boolean
  status?: number
  latencyMs?: number
  error?: string
}

export function testSettings(dto: RuntimeSettings): Promise<TestResult> {
  return request.post('/api/settings/test', dto) as Promise<TestResult>
}
