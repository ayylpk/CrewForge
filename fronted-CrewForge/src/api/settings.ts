import request from './request'

/**
 * 运行时设置 API（cc-switch 设置页 → sys_settings 单行，阶段 2）
 * 语义与后端 SettingsController 对齐：apiKey 只进不出（GET 永远掩码，PUT 掩码回传=不改）。
 * 引擎直读该表（30s 缓存）——保存后最多半分钟对新起的 LLM 调用生效，无需重启任何进程。
 */

/** 与后端 SettingsDTO/getMasked 对齐（smokeBuild 后端出参是 boolean） */
export interface RuntimeSettings {
  modelName?: string | null
  modelUrl?: string | null
  apiKey?: string | null   // 永远掩码（****末4位 / null）
  modelKind?: string       // 'deepseek' | 'openai'
  javaBaseUrl?: string | null
  confirmTimeoutMin?: number
  smokeBuild?: boolean
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
