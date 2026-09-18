import { defineStore } from 'pinia'

/**
 * 执行状态共享存储
 *
 * 只留"确认模式"这一件真状态：页面选择器 / 引擎开工读取都认它
 * （ExecutionView 的 setMode → updateProject 落 sys_project.confirm_mode）。
 *
 * 已删（9/17 清理）：pendingConfirm / showConfirm / resolveConfirm / hasPendingConfirm
 * 与 modeLabel / modeDesc。前者那套"全局会签弹窗"的数据源全仓没有任何调用方
 * （渲染端 GlobalConfirmModal 已一并删除），真正的确认门问答走
 * ExecutionView 自己的 pendingConfirms + 就地浮层；后者两个 getter 从未被渲染使用。
 */
export const useExecutionStore = defineStore('execution', {
  state: () => ({
    /** 确认模式: 0-全绿灯(自动) / 1-混合(关键步骤确认) / 2-手动(每一步确认) */
    confirmMode: Number(localStorage.getItem('cf_confirm_mode') ?? 0) as 0 | 1 | 2,
  }),

  actions: {
    setConfirmMode(mode: 0 | 1 | 2) {
      this.confirmMode = mode
      localStorage.setItem('cf_confirm_mode', String(mode))
    },
  },
})
