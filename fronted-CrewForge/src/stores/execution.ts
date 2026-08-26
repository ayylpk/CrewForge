import { defineStore } from 'pinia'

/**
 * 执行状态共享存储
 * 管理确认模式 + 全局待处理确认弹窗
 */
export const useExecutionStore = defineStore('execution', {
  state: () => ({
    /** 确认模式: 0-全绿灯(自动) / 1-混合(关键步骤确认) / 2-手动(每一步确认) */
    confirmMode: Number(localStorage.getItem('cf_confirm_mode') ?? 0) as 0 | 1 | 2,
    /** 待处理的确认请求（来自 Agent 的 humanGate） */
    pendingConfirm: null as {
      id: string
      title: string
      message: string
      projectId: number
      phase?: string
    } | null,
  }),

  getters: {
    modeLabel(state): string {
      return ['全绿灯', '混合', '手动'][state.confirmMode] ?? '全绿灯'
    },
    modeDesc(state): string {
      return [
        'Agent 自动执行，无需人工确认',
        '关键步骤（如换阶段）需人工确认',
        '每阶段计划都需人工确认',
      ][state.confirmMode] ?? ''
    },
    hasPendingConfirm(state): boolean {
      return state.pendingConfirm !== null
    },
  },

  actions: {
    setConfirmMode(mode: 0 | 1 | 2) {
      this.confirmMode = mode
      localStorage.setItem('cf_confirm_mode', String(mode))
    },
    showConfirm(confirm: {
      id: string
      title: string
      message: string
      projectId: number
      phase?: string
    }) {
      this.pendingConfirm = confirm
    },
    resolveConfirm() {
      this.pendingConfirm = null
    },
  },
})