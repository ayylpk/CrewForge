import { createApp } from 'vue'
import { createPinia } from 'pinia'
import './style.css'
import router from './router'
import App from './App.vue'

/* ============================================================
   应用入口
   ------------------------------------------------------------
   9/17 晒图室重塑：Element Plus 从活跃路径整体拔除（toast/确认单/目录树全部手写，
   见 utils/toast.ts · utils/confirm.ts · components/SheetTree.vue）。
   9/18 收尾：那三个"封存但保留"的页面（TeamView / AgentRepositoryView /
   AgentFormView）已连同 element-plus 依赖一起删除 —— 它们自 9/15 起就被路由守卫
   拦成"功能未开放"，入口卡片也在 9/18 一并删掉，属于永远进不去的死代码。
   ============================================================ */

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
