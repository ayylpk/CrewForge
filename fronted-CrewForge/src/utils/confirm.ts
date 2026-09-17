/* ============================================================
   全局确认门总线（替代 ElMessageBox.confirm / alert）
   ------------------------------------------------------------
   用法：const ok = await confirmDialog({ title, body, ok, cancel })
   只给 ok 不给 cancel = 提示框（alert 模式，路由守卫用）。
   渲染：App.vue 里挂 <ConfirmHost/>，本文件只管数据。
   ============================================================ */
import { reactive } from 'vue'

export interface ConfirmReq {
  title: string
  body?: string
  /** 确认按钮文案，默认「确定」 */
  ok?: string
  /** 不传 = alert 模式（单按钮） */
  cancel?: string
  /** 破坏性操作：确认按钮用验收红 */
  danger?: boolean
}

type Pending = ConfirmReq & { resolve: (v: boolean) => void }

const state = reactive<{ pending: Pending | null }>({ pending: null })

/** 弹出确认门，返回 Promise<boolean>（确认 true / 取消或 Esc false） */
export function confirmDialog(req: ConfirmReq): Promise<boolean> {
  // 同时只允许一个门：已开的按「取消」处理掉
  if (state.pending) {
    state.pending.resolve(false)
    state.pending = null
  }
  return new Promise<boolean>((res) => {
    state.pending = { ...req, resolve: res }
  })
}

/** ConfirmHost 内部调用：把结果回给 await 方 */
export function answerConfirm(v: boolean) {
  const p = state.pending
  state.pending = null
  p?.resolve(v)
}

export const confirmState = state
