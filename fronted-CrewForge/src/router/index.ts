import { createRouter, createWebHistory } from 'vue-router'
import LoginView from '../views/LoginView.vue'
import ProjectsView from '../views/ProjectsView.vue'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: LoginView },
    { path: '/projects', name: 'projects', component: ProjectsView },
    // 团队空间（与个人空间平级）
    { path: '/teams', name: 'teams', component: () => import('../views/TeamWorkspaceView.vue') },
    // 团队详情（进入团队后的工作区）
    { path: '/teams/:id', name: 'team-detail', component: () => import('../views/TeamDetailView.vue') },
    // Agent 仓库（自定义 Agent 池管理）
    { path: '/agents', name: 'agent-repo', component: () => import('../views/AgentRepositoryView.vue') },
    // Agent 表单（新建仓库 Agent）
    { path: '/agents/new', name: 'agent-new', component: () => import('../views/AgentFormView.vue') },
    // Agent 表单（编辑仓库 Agent，:id 即编辑回显模式）
    { path: '/agents/:id', name: 'agent-edit', component: () => import('../views/AgentFormView.vue') },
    // 新建项目页（配置区 + AI 对话区）
    { path: '/projects/new', name: 'project-new', component: () => import('../views/CreateProjectView.vue') },
    // 需求对话（复用项目经理工作台：确认具体功能，带 :id 即澄清模式）
    {
      path: '/projects/:id/pm',
      name: 'pm',
      component: () => import('../views/CreateProjectView.vue'),
    },
    // 架构师页（技术选型 + 开发计划）
    {
      path: '/projects/:id/architect',
      name: 'architect',
      component: () => import('../views/ArchitectView.vue'),
    },
    // 团队配置页（AI 预设 + 合并/添加）
    {
      path: '/projects/:id/team',
      name: 'team',
      component: () => import('../views/TeamView.vue'),
    },
    // 执行面板（Agent 状态 + 文件树 + Monaco）
    {
      path: '/projects/:id/execution',
      name: 'execution',
      component: () => import('../views/ExecutionView.vue'),
    },
    // 项目概览页
    {
      path: '/projects/:id',
      name: 'project-detail',
      component: () => import('../views/ProjectDetailView.vue'),
    },
    { path: '/', redirect: '/login' },
  ],
  // 带 #锚点 的路由（如 /projects/3#overview）平滑滚动到对应区块
  scrollBehavior(to) {
    if (to.hash) {
      return { el: to.hash, behavior: 'smooth' }
    }
    return { top: 0 }
  },
})

// 路由守卫：未登录跳转登录页（开发阶段检查假 token）
router.beforeEach((to) => {
  const token = localStorage.getItem('cf_token')
  if (to.path !== '/login' && !token) {
    return '/login'
  }
  if (to.path === '/login' && token) {
    return '/projects'
  }
})

export default router
