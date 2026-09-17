import { createApp } from 'vue'
import { createPinia } from 'pinia'
import './style.css'
import router from './router'
import App from './App.vue'

// 9/17 晒图室重塑：Element Plus 从活跃路径整体拔除（toast/确认单/目录树全部手写，
// 见 utils/toast.ts · utils/confirm.ts · components/SheetTree.vue）。
// 封存的三个页面（TeamView/AgentRepositoryView/AgentFormView）源码保留但未挂载入口；
// 恢复时把模板里的 <el-tree> 换成 SheetTree/FileTree，并删掉 element-plus 依赖。

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
