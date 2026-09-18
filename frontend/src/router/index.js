import { createRouter, createWebHistory } from 'vue-router';
import LoginView from '../views/LoginView.vue';
import ProjectsView from '../views/ProjectsView.vue';
/* ============================================================
   路由表
   ------------------------------------------------------------
   9/18 清理：删掉 4 条路由 + 整个 SEALED_PATHS 闸门。

   删的 4 条是「Agent 仓库」与「团队配置」两组功能（/agents、/agents/new、
   /agents/:id、/projects/:id/team）。它们自 9/15 起就被下面的守卫拦成
   "功能未开放"弹窗 —— 界面进不去、又占着 1700 行死代码 + element-plus 依赖。
   入口卡片删除后，这四页连"点得到"都不成立，于是页面源码、配套 api/types、
   CardShell/EmptyState 组件与 element-plus 依赖一并清掉。
   ⚠️ 要恢复：从 git 历史取回（删除时 HEAD 记为 4264873 之后那一次提交）。
   ============================================================ */
const router = createRouter({
    history: createWebHistory(),
    routes: [
        { path: '/login', name: 'login', component: LoginView },
        { path: '/projects', name: 'projects', component: ProjectsView },
        // 新建项目不再是独立路由：改为台账页里的弹窗（CreateProjectSheet），
        // 因为原 /projects/new 与下面这条需求对话页的配置区高度重复。见该组件顶部注释。
        // 保留一条重定向：否则旧书签会掉进 /projects/:id 里当成 id="new" 的项目去查。
        { path: '/projects/new', redirect: '/projects' },
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
        // 执行面板（Agent 状态 + 文件树 + Monaco）
        {
            path: '/projects/:id/execution',
            name: 'execution',
            component: () => import('../views/ExecutionView.vue'),
        },
        // 工单板（sys_task 四列全宽：重跑 / 手动改状态 / 补一条任务）
        {
            path: '/projects/:id/tasks',
            name: 'task-board',
            component: () => import('../views/TaskBoardView.vue'),
        },
        // 验收与证据（交付关实测报告 + 验收判据 + 任务证据 + 引擎日志；只读）
        {
            path: '/projects/:id/verification',
            name: 'verification',
            component: () => import('../views/VerificationView.vue'),
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
            return { el: to.hash, behavior: 'smooth' };
        }
        return { top: 0 };
    },
});
// 路由守卫：未登录跳转登录页（开发阶段检查假 token）
router.beforeEach((to) => {
    const token = localStorage.getItem('cf_token');
    if (to.path !== '/login' && !token) {
        return '/login';
    }
    if (to.path === '/login' && token) {
        return '/projects';
    }
});
export default router;
