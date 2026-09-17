/* ============================================================
   状态口径统一（项目 7 态 / 任务 4 态 / 确认节点标签）
   ------------------------------------------------------------
   旧版 STATUS_META 散在 ProjectsView/Detail 里各写一份，颜色混着
   Element 语义色；这里收口成一份，样式全部走 style.css 的章色 token。
   tone 对应 .stamp-{tone} / .lamp-{tone} 类名。
   ============================================================ */

/** 图章色名（= style.css .stamp-{tone}/.lamp-{tone} 的 tone，StampSeal.vue 同口径） */
export type StampTone = 'pass' | 'void' | 'wait' | 'info' | 'pencil' | 'rust'

/** 项目状态（后端 status 字段的 7 个取值） */
export const PROJECT_STATUS: Record<string, { label: string; tone: StampTone }> = {
  draft: { label: '草稿', tone: 'pencil' }, // 铅笔灰：还没下墨
  planning: { label: '规划中', tone: 'info' }, // 蓝图细线
  clarifying: { label: '澄清中', tone: 'wait' }, // 待检黄：等人回答问题
  executing: { label: '执行中', tone: 'info' }, // 晒图青：机器在画
  paused: { label: '已暂停', tone: 'rust' }, // 铁锈橙：停车队列
  done: { label: '已交付', tone: 'pass' }, // 合格绿：验收章已盖
  failed: { label: '失败', tone: 'void' }, // 验收红：修订云
}

export function projectStatusMeta(s?: string | null) {
  return PROJECT_STATUS[s || ''] || { label: s || '未知', tone: 'pencil' }
}

/** 任务状态（看板四列，后端 sys_task.status） */
export const TASK_STATUS: Record<string, { label: string; tone: StampTone }> = {
  todo: { label: '待办', tone: 'pencil' },
  doing: { label: '在制', tone: 'info' },
  done: { label: '完工', tone: 'pass' },
  failed: { label: '返工', tone: 'void' },
}

/** 执行确认节点 → 中文标签（旧 nodeLabel 映射） */
export const NODE_LABELS: Record<string, string> = {
  architect: '架构师',
  manager: '项目经理',
  test: '测试',
}

export function nodeLabel(node?: string | null) {
  return (node && NODE_LABELS[node]) || node || '系统'
}

/** 确认模式：前端串 ↔ 后端数字（0=绿 1=混合 2=手动），全局唯一一份 */
export const MODE_STR_TO_NUM: Record<string, number> = { green: 0, mixed: 1, manual: 2 }
export const MODE_NUM_TO_STR = ['green', 'mixed', 'manual'] as const
export type ConfirmModeStr = (typeof MODE_NUM_TO_STR)[number]

/** label/desc 逐字沿用旧执行面板 MODES（这是引擎行为描述，不许文学化改写） */
export const MODE_META: Record<ConfirmModeStr, { label: string; desc: string; tone: StampTone }> = {
  green: { label: '全绿灯', desc: 'Agent 自动执行，无需人工确认', tone: 'pass' },
  mixed: { label: '混合', desc: '关键步骤（如换阶段）需人工确认', tone: 'wait' },
  manual: { label: '手动', desc: '每阶段计划都需人工确认', tone: 'void' },
}
