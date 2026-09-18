/* ============================================================
   轮询纪律收口（替代散落在各页的 setInterval + onBeforeUnmount）
   ------------------------------------------------------------
   用法：const { start, stop } = usePolling(poll, 10000)
         onMounted(() => { poll(); start() })
   规则：一个页面一个定时器；组件卸载自动清，漏调 stop 也不会泄漏。
   后端只有轮询没有推送（10s 一档是既有口径，别改密度）。
   ============================================================ */
import { onBeforeUnmount } from 'vue';
export function usePolling(fn, ms = 10000) {
    let timer = null;
    function start() {
        stop(); // 幂等：重复 start 不叠定时器
        timer = window.setInterval(() => {
            void fn();
        }, ms);
    }
    function stop() {
        if (timer !== null) {
            clearInterval(timer);
            timer = null;
        }
    }
    onBeforeUnmount(stop);
    return { start, stop };
}
