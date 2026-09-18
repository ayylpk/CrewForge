/* ============================================================
   全局提示总线（替代 Element Plus 的 ElMessage）
   ------------------------------------------------------------
   用法：import { toast } from '@/utils/toast' → toast.success('...')
   渲染：App.vue 里挂 <ToastHost/>，本文件只管数据。
   世界观：提示条 = 盖在图角的小回执条，3.8 秒自动收回。
   ============================================================ */
import { reactive } from 'vue'

export type ToastKind = 'success' | 'error' | 'warning' | 'info'

export interface ToastItem {
  id: number
  kind: ToastKind
  text: string
}

const state = reactive<{ items: ToastItem[] }>({ items: [] })
let seq = 0

function push(kind: ToastKind, text: string) {
  // 同文案不叠加：轮询类页面（执行面板/项目详情都是 10s 一档）同一个错误会反复复现，
  // 不去重就不是"一次错误一个提示"，而是"一直弹窗"——9/17 用户实测反馈的正是这个。
  if (state.items.some((t) => t.kind === kind && t.text === text)) return
  const id = ++seq
  state.items.push({ id, kind, text })
  // 同屏最多 4 条，最老的先被顶掉（防止错误风暴糊满屏幕）
  if (state.items.length > 4) state.items.shift()
  window.setTimeout(() => dismiss(id), 3800)
}

export function dismiss(id: number) {
  const i = state.items.findIndex((t) => t.id === id)
  if (i >= 0) state.items.splice(i, 1)
}

export const toast = {
  state,
  success: (t: string) => push('success', t),
  error: (t: string) => push('error', t),
  warning: (t: string) => push('warning', t),
  info: (t: string) => push('info', t),
  dismiss,
}
