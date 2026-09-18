/* ============================================================
   全局提示总线（替代 Element Plus 的 ElMessage）
   ------------------------------------------------------------
   用法：import { toast } from '@/utils/toast' → toast.success('...')
   渲染：App.vue 里挂 <ToastHost/>，本文件只管数据。
   世界观：提示条 = 盖在图角的小回执条，3.8 秒自动收回。
   ============================================================ */
import { reactive } from 'vue';
const state = reactive({ items: [] });
let seq = 0;
/* ============================================================
   同文案抑制窗（9/18 重做 —— 修「错误提示一直弹」）
   ------------------------------------------------------------
   原来只写了一句 `if (items.some(同 kind 同文)) return`，本意是"轮询不刷屏"
   （见下面 push 的旧注释），但 **它从来没生效过**：
     · items 里的条目 3.8 秒就被自动收回（AUTO_DISMISS_MS）
     · 而轮询间隔是 10s（执行面板）/ 4s（需求对话页）
     · 下一轮错误进来时，上一条**已经不在 items 里了** → 去重条件为假 → 又入列
   结果不是"一次错误一个提示"，而是**每 10 秒准时弹一次、永远不停**。
   9/18 用户实测"网络错误一直弹 / 42 号的项目不存在一直弹"就是这个：
   项目被删了，页面还挂着 10s/4s 的轮询，每轮都失败一次。

   现在改成记"最近展示时刻"，在抑制窗内不再入列：
     · error/warning 用 30s —— 比最慢的轮询档宽 3 倍，该看见的都看见了，
       但持续故障不会变成刷屏（真正要停的是轮询本身，见各页的 gone 判断）
     · success/info 只挡"当前还挂在屏上"的那一条（保持即时反馈，
       用户连点两次保存也该看到两次回执）
   ============================================================ */
const AUTO_DISMISS_MS = 3800;
const ERROR_DEDUP_MS = 30_000;
/** kind|text → 最近一次展示时刻 */
const lastShown = new Map();
/** 抑制窗是 30s，Map 可能被带 id 的文案撑大（如"项目不存在: 42"每项目一条）→ 定期清 */
function sweepLastShown(now) {
    if (lastShown.size <= 50)
        return;
    for (const [k, t] of lastShown) {
        if (now - t >= ERROR_DEDUP_MS)
            lastShown.delete(k);
    }
}
function push(kind, text) {
    const now = Date.now();
    const key = `${kind}|${text}`;
    const prev = lastShown.get(key);
    // 错误/警告：抑制窗内不再入列（轮询持续失败时这就是"一次故障一个提示"）
    if (kind === 'error' || kind === 'warning') {
        if (prev !== undefined && now - prev < ERROR_DEDUP_MS)
            return;
    }
    else if (state.items.some((t) => t.kind === kind && t.text === text)) {
        // 成功/提示：只挡当前可见的那一条
        return;
    }
    sweepLastShown(now);
    lastShown.set(key, now);
    const id = ++seq;
    state.items.push({ id, kind, text });
    // 同屏最多 4 条，最老的先被顶掉（防止错误风暴糊满屏幕）
    if (state.items.length > 4)
        state.items.shift();
    window.setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
}
export function dismiss(id) {
    const i = state.items.findIndex((t) => t.id === id);
    if (i >= 0)
        state.items.splice(i, 1);
}
export const toast = {
    state,
    success: (t) => push('success', t),
    error: (t) => push('error', t),
    warning: (t) => push('warning', t),
    info: (t) => push('info', t),
    dismiss,
};
