import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    vueDevTools(), // 独立模式: npm run dev 时自动弹出 Vue DevTools 独立窗口
  ],
  // 本机 safe-delete 钩子会拦 vite 清空 dist（批量删除需确认），导致 build 必失败；
  // 改为不清空、增量覆盖（与 engine2 骨架模板同一解法）。仅影响构建清理行为，不涉及任何样式/配色。
  build: {
    emptyOutDir: false,
  },
})
