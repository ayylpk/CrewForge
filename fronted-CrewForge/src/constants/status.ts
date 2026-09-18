/* ============================================================
   状态口径统一（项目 7 态 / 任务 4 态 / 确认节点标签）
   ------------------------------------------------------------
   旧版 STATUS_META 散在 ProjectsView/Detail 里各写一份，颜色混着
   Element 语义色；这里收口成一份，样式全部走 style.css 的章色 token。
   tone 对应 .stamp-{tone} / .lamp-{tone} 类名。
   ============================================================ */

/** 图章色名（= style.css .stamp-{tone}/.lamp-{tone} 的 tone，StampSeal.vue 同口径） */
export type StampTone = 'pass' | 'void' | 'wait' | 'info' | 'pencil' | 'rust' | 'indigo'

/** 项目状态（后端 status 字段的 8 个取值） */
export const PROJECT_STATUS: Record<string, { label: string; tone: StampTone }> = {
  draft: { label: '草稿', tone: 'pencil' }, // 铅笔灰：还没下墨
  // ⚠️ 规划中改「靛」（9/18 第 7 个章色，见 style.css 与 DESIGN.md §1）。
  //    历史：原先 planning 与 executing 共用晒图青 —— 一个色五种含义（主按钮/链接/选中/图号/状态），
  //    操作员分不出"机器在跑"和"还没开工"。9/17 改成跟草稿一样的铅笔灰，代价是
  //    **草稿与规划中肉眼分不开**（用户实测反馈"草稿/规划中/执行中没颜色区分"）。
  //    现在：草稿=灰 / 规划中=靛 / 执行中=青，三档彼此可分；青仍专属 executing 与交互态。
  planning: { label: '规划中', tone: 'indigo' },
  clarifying: { label: '澄清中', tone: 'wait' }, // 待检黄：等人回答问题
  executing: { label: '执行中', tone: 'info' }, // 晒图青：机器在画（唯一用青的状态）
  paused: { label: '已暂停', tone: 'rust' }, // 铁锈橙：停车队列
  done: { label: '已交付', tone: 'pass' }, // 合格绿：验收章已盖
  failed: { label: '失败', tone: 'void' }, // 验收红：修订云
  // 引擎第三终态：跑完了但交付关没验过（skipped_unverified）。
  // 漏了它前端就只会显示原始英文 "blocked" + 铅笔灰（见 projectStatusMeta 的兜底分支）。
  blocked: { label: '未验证', tone: 'wait' },
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
export const MODE_NUM_TO_STR = ['green', 'mixed', 'manual'] as const
export type ConfirmModeStr = (typeof MODE_NUM_TO_STR)[number]

/**
 * label/desc 逐字沿用旧执行面板 MODES（这是引擎行为描述，不许文学化改写）。
 *
 * 9/18 扩写 desc：权限闸门接上后，三个模式**同时也决定"什么时候会问你"**
 * （见 PermissionRuleServiceImpl.decide 的模式分流 + architect.ts 的 confirmNode）。
 * 只写"自动执行/需人工确认"会让人以为这只管阶段确认，然后看到命令审批卡时一头雾水 ——
 * 所以把"问什么"和"预算"一并写进来。
 */
export const MODE_META: Record<ConfirmModeStr, { label: string; desc: string; tone: StampTone }> = {
  green: { label: '全绿灯', desc: 'Agent 自动执行，无需人工确认；命令一律放行、迭代不设限（跑到上限为止）', tone: 'pass' },
  mixed: { label: '混合', desc: '关键步骤（如换阶段）需人工确认；命令只在"有后果"时（装依赖/写盘/连网/动库）才问你', tone: 'wait' },
  manual: { label: '手动', desc: '每阶段计划都需人工确认；命令白名单之外一律问你', tone: 'void' },
}
