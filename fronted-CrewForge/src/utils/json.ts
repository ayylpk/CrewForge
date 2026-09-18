/* ============================================================
   JSON 列读取（双形状宽容）
   ------------------------------------------------------------
   项目表这几列在库里是**双形状**的 —— 网页写裸数组，引擎写信封对象：

     businessModules:  ["功能A"]                |  {risks, modules:[{name,points,…}], summary, deliverables}
     techStack:        ["Vue 3"]                |  {why, tables, moduleTech, techniques}
     devPlan:          [{name,progress,tasks}]  |  {risks, phases:[…], project, features, mvp_scope, uiProfile}
     dirTree:          [{name,type,children}]   |  （目前只有数组）

   9/17 实测现网 22 行：dev_plan 19 个对象、tech_stack 12 个、business_modules 13 个。
   旧实现一律写成 "不是数组就返回 []"，于是这些行在页面上**全显示为空**
   （"还没有确认功能"/"暂无技术选型"），而数据其实都在。
   信封的 key 名是引擎侧定的，所以这里按字段显式列出，不做魔法猜测。
   ============================================================ */

/** 信封里各字段的数组所在 key（顺序即优先级） */
export const ENVELOPE_KEYS = {
  businessModules: ['modules', 'features', 'deliverables'],
  // technologies 优先：架构师页把用户编辑的扁平清单写在这里（引擎原来的 techniques 是
  // 分类对象 {database:{…}, middleware:[…]}，与页面模型不是一回事，不能被它顶替）
  techStack: ['technologies', 'techniques', 'moduleTech', 'middleware', 'tables'],
  devPlan: ['phases'],
  dirTree: ['tree', 'children'],
} as const

/**
 * 从"裸数组或信封对象"里取出数组。
 * 传了 envelopeKeys 就按它找；找不到时退一步取对象里**第一个数组值**
 * （引擎信封加键是常态，硬编码一个 key 迟早漂移）。
 */
export function parseEnvelopeArray(
  raw: string | null | undefined,
  envelopeKeys: readonly string[] = [],
): unknown[] {
  if (!raw) return []
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return [] // 坏 JSON 一律当"没有"，不炸页面
  }
  if (Array.isArray(v)) return v
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>
    for (const k of envelopeKeys) {
      if (Array.isArray(obj[k])) return obj[k] as unknown[]
    }
    for (const inner of Object.values(obj)) {
      if (Array.isArray(inner)) return inner
    }
  }
  return []
}

/**
 * 数组 → 字符串数组（用于清单类展示）。
 * 信封外的数组元素可能是字符串，也可能是对象（如 businessModules 的 {name, points}）。
 * ⚠️ 不能直接 .map(String)：对象会变成 "[object Object]" 印到页面上。
 * 对象优先取 name/title/label，都没有才 JSON 序列化兜底。
 */
export function toDisplayList(items: unknown[]): string[] {
  return items
    .map((it) => {
      if (it == null) return ''
      if (typeof it === 'string') return it
      if (typeof it === 'number' || typeof it === 'boolean') return String(it)
      if (typeof it === 'object') {
        const o = it as Record<string, unknown>
        for (const k of ['name', 'title', 'label', 'summary']) {
          const v = o[k]
          if (typeof v === 'string' && v) return v
        }
        try {
          return JSON.stringify(it)
        } catch {
          return ''
        }
      }
      return String(it)
    })
    .map((s) => s.trim())
    .filter(Boolean)
}

/* ============================================================
   反向：把页面编辑结果写回 JSON 列（保结构合并）
   ------------------------------------------------------------
   抽成纯函数放这里而不是写在 ArchitectView 里，是为了能用真实库数据跑它 ——
   前端没有测试框架，而这两个函数一旦写错就是**静默毁数据**（见下）。
   ============================================================ */

/** 页面里的阶段模型 */
export interface PhaseEdit {
  name: string
  progress: number
  tasks: string[]
}

/** 阶段对象里"任务清单"所在的键：引擎写 features，网页写 tasks —— 谁原来有就写回谁 */
export function taskKeyOf(phase: Record<string, unknown>): string {
  if (Array.isArray(phase.tasks)) return 'tasks'
  if (Array.isArray(phase.features)) return 'features'
  return 'tasks'
}

/**
 * 用页面编辑结果生成新的 devPlan JSON：逐条**在原阶段对象上合并**
 * （只覆盖 name 与任务清单），信封其余键原样带回。
 *
 * 为什么不能"用页面模型重建"：库里 dev_plan 是引擎写的富信封
 *   {risks, phases:[{goal,name,risk,phase,uiStyle,features,dependencies,relative_effort}],
 *    project, features, mvp_scope, uiProfile}
 * 页面模型只有 {name, progress, tasks}。整体重建会丢掉信封全部其他键，
 * **连每个阶段的数字 `phase` 一起丢** —— 而引擎的 usablePhases() 硬要求
 * `Number.isInteger(Number(p.phase))`，丢了它引擎读回 dev_plan 会判定计划不可用，
 * 退回去重跑 PM 对话（引擎侧真故障，不只是少显示几个字段）。
 *
 * 新增阶段按原形状补齐必填键：引擎形状补数字 phase，否则 usablePhases 不认。
 */
export function buildDevPlanJson(
  envelope: Record<string, unknown> | null,
  originalPhases: Record<string, unknown>[],
  edited: PhaseEdit[],
  engineShape: boolean,
): string {
  const merged = edited.map((p, i) => {
    const orig = originalPhases[i]
    if (orig && typeof orig === 'object') {
      return { ...orig, name: p.name, [taskKeyOf(orig)]: p.tasks }
    }
    return engineShape
      ? { phase: i + 1, name: p.name, features: p.tasks }
      : { name: p.name, progress: 0, tasks: p.tasks }
  })
  return JSON.stringify(envelope ? { ...envelope, phases: merged } : merged)
}

/**
 * 生成新的 techStack JSON。
 * 引擎信封里的 techniques 是**分类对象**（{database:{…}, middleware:[{name,purpose}]}），
 * 与本页的扁平字符串数组不是同一个数据模型，硬塞进去就是损坏。
 * 所以：有信封就保留原样，把用户编辑的扁平清单写进独立的 `technologies` 键
 * （读取时优先取 technologies，见 ENVELOPE_KEYS.techStack 的顺序）。
 */
export function buildTechStackJson(envelope: Record<string, unknown> | null, list: string[]): string {
  if (envelope) return JSON.stringify({ ...envelope, technologies: list })
  return JSON.stringify(list)
}

