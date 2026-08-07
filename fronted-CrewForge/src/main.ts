import { createApp } from 'vue'
import { createPinia } from 'pinia'
import './style.css'
import router from './router'
import App from './App.vue'
// 按需注册 Element Plus 组件（el-tree 等）+ 对应样式
// 注意：ElMessage/ElMessageBox 是函数式 API，import 直接用，无需注册
import { ElTree } from 'element-plus'
import 'element-plus/es/components/tree/style/css'
import 'element-plus/es/components/message/style/css'
import 'element-plus/es/components/message-box/style/css'

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.component('ElTree', ElTree)
app.mount('#app')
