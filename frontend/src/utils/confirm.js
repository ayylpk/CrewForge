/* ============================================================
   全局确认门总线（替代 ElMessageBox.confirm / alert）
   ------------------------------------------------------------
   用法：const ok = await confirmDialog({ title, body, ok, cancel })
   只给 ok 不给 cancel = 提示框（alert 模式，路由守卫用）。
   渲染：App.vue 里挂 <ConfirmHost/>，本文件只管数据。
   ============================================================ */
import { reactive } from 'vue';
const state = reactive({ pending: null });
/** 弹出确认门，返回 Promise<boolean>（确认 true / 取消或 Esc false） */
export function confirmDialog(req) {
    // 同时只允许一个门：已开的按「取消」处理掉
    if (state.pending) {
        state.pending.resolve(false);
        state.pending = null;
    }
    return new Promise((res) => {
        state.pending = { ...req, resolve: res };
    });
}
/** ConfirmHost 内部调用：把结果回给 await 方 */
export function answerConfirm(v) {
    const p = state.pending;
    state.pending = null;
    p?.resolve(v);
}
export const confirmState = state;
