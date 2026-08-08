<template>
  <div class="projects">
    <!-- 顶栏 -->
    <header class="topbar">
      <div class="topbar-left">
        <div class="logo">
          <img src="../assets/logo-crewforge.png" alt="CrewForge" />
          <span>CrewForge</span>
        </div>
        <!-- API 设置（配置 AI 模型服务，Key 仅存浏览器本地） -->
        <button
          class="btn-api"
          :class="{ ok: llmConfigured }"
          :title="llmConfigured ? '已配置 DeepSeek' : '未配置 API Key，AI 功能不可用'"
          @click="showApiSettings = true"
        >
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
          API 设置
          <span class="api-dot" :class="{ on: llmConfigured }"></span>
        </button>
      </div>
      <div class="topbar-center">
        <WorkspaceSwitcher :current="'personal'" @switch="switchWs" />
      </div>
      <div class="topbar-right">
        <!-- Agent 仓库（自定义 Agent 池管理） -->
        <button class="btn-api" title="管理 Agent 仓库" @click="goAgentRepo">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="7" width="18" height="13" rx="2" />
            <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            <path d="M12 11v5M9.5 13.5h5" />
          </svg>
          Agent 仓库
        </button>
        <span class="avatar">K</span>
        <button class="btn-logout" @click="logout">退出</button>
      </div>
    </header>

    <main class="main">
      <!-- 页头 -->
      <div class="page-head">
        <h1>项目</h1>
        <GradientButton @click="createNew">+ 新建项目</GradientButton>
      </div>

      <!-- 统计栏 -->
      <div class="stats">
        <div class="stat-card">
          <span class="stat-num grad-text">{{ projects.length }}</span>
          <span class="stat-label">全部项目</span>
        </div>
        <div class="stat-card">
          <span class="stat-num" style="color: var(--green)">{{ countBy('executing') }}</span>
          <span class="stat-label">执行中</span>
        </div>
        <div class="stat-card">
          <span class="stat-num" style="color: var(--purple)">{{ countBy('done') }}</span>
          <span class="stat-label">已完成</span>
        </div>
        <div class="stat-card">
          <span class="stat-num" style="color: var(--yellow)">{{ countBy('clarifying') }}</span>
          <span class="stat-label">澄清中</span>
        </div>
        <div class="stat-card">
          <span class="stat-num" style="color: var(--blue)">{{ totalFiles }}</span>
          <span class="stat-label">代码文件</span>
        </div>
      </div>

      <!-- 筛选 + 搜索 -->
      <div class="toolbar">
        <div class="filters">
          <button
            v-for="f in filters"
            :key="f.value"
            class="filter-btn"
            :class="{ active: activeFilter === f.value }"
            @click="activeFilter = f.value"
          >
            <StatusDot :color="f.color" />
            {{ f.label }}
          </button>
        </div>
        <div class="search-box">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input v-model="keyword" type="text" placeholder="搜索项目..." />
        </div>
      </div>

      <!-- 项目卡片 -->
      <div v-if="filtered.length" class="card-grid">
        <CardShell v-for="p in filtered" :key="p.id" hoverable class="proj-card" @click="goProject(p)">
          <div class="proj-top">
            <div class="proj-ico" :style="{ background: projectGrad(p) }">{{ projectIcon(p) }}</div>
            <h3 class="proj-name">{{ p.name }}</h3>
            <div class="proj-top-right">
              <span class="proj-status" :style="{ color: statusMeta(p.status).color }">
                <StatusDot :color="statusMeta(p.status).color" />
                {{ statusMeta(p.status).label }}
              </span>
              <button class="btn-del" title="删除项目" @click.stop="removeProject(p)">✕</button>
            </div>
          </div>
          <div class="proj-info">
            <p>{{ p.description || '暂无描述' }}</p>
          </div>
          <div class="proj-bottom">
            <div class="proj-meta">
              <!-- 进度条 -->
              <div v-if="p.progress != null && p.progress > 0" class="proj-progress">
                <div class="proj-progress-fill" :style="{ width: p.progress + '%' }"></div>
              </div>
              <span class="proj-time">
                <template v-if="p.fileCount">{{ p.fileCount }} 个文件 · </template>{{ p.moduleCount || 0 }} 个模块
              </span>
            </div>
            <span class="proj-enter">进入 →</span>
          </div>
        </CardShell>
      </div>

      <!-- 空状态 -->
      <EmptyState
        v-else
        icon="▤"
        title="没有找到项目"
        :desc="keyword ? '换个关键词试试' : '点击「新建项目」创建你的第一个 AI 协作项目'"
      >
        <GradientButton v-if="!keyword" @click="createNew">+ 新建项目</GradientButton>
      </EmptyState>
    </main>

    <!-- API 设置弹窗（DeepSeek） -->
    <div v-if="showApiSettings" class="modal-mask" @click.self="showApiSettings = false">
      <div class="modal api-modal">
        <h2>API 设置</h2>
        <p class="api-tip">
          配置后，需求对话 / 架构师 / 团队成员等 AI 功能将使用该模型服务。
          API Key 仅保存在浏览器本地，不会上传服务器。
        </p>

        <div class="modal-field">
          <label>模型服务商</label>
          <div class="provider-card">
            <div class="provider-head">
              <span class="provider-name">DeepSeek</span>
              <span v-if="llmKey" class="provider-key-state">Key 已配置</span>
              <span v-else class="provider-key-state no">未配置 Key</span>
            </div>
            <div class="provider-row">
              <span class="provider-label">Base URL</span>
              <input class="input" type="text" :value="DEEPSEEK_BASE_URL" disabled />
            </div>
            <div class="provider-row">
              <span class="provider-label">API Key</span>
              <input v-model="llmKey" class="input" type="password" placeholder="sk-..." />
            </div>
            <div class="provider-row">
              <span class="provider-label">默认模型</span>
              <select v-model="llmModel" class="select">
                <option v-for="m in DEEPSEEK_MODELS" :key="m" :value="'deepseek/' + m">{{ m }}</option>
              </select>
            </div>
          </div>
        </div>

        <div class="modal-actions">
          <button class="btn-cancel" @click="showApiSettings = false">取消</button>
          <button class="btn-save" @click="saveApiSettings">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import CardShell from '../components/CardShell.vue'
import GradientButton from '../components/GradientButton.vue'
import StatusDot from '../components/StatusDot.vue'
import EmptyState from '../components/EmptyState.vue'
import WorkspaceSwitcher from '../components/WorkspaceSwitcher.vue'
import { fetchProjects, deleteProject } from '../api/project'
import type { Project, ProjectStatus } from '../types/project'

const router = useRouter()

// ===== API 设置（DeepSeek，Key 仅存浏览器 localStorage） =====
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1'
const DEEPSEEK_MODELS = ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash', 'deepseek-v4-pro[1m]']

const showApiSettings = ref(false)
const llmKey = ref('')
const llmModel = ref('deepseek/deepseek-v4-flash')

/** 已配置 Key 才算可用 */
const llmConfigured = computed(() => llmKey.value.trim().length > 0)

/** 从 localStorage 恢复（key: cf_providers / cf_default_model，与旧格式兼容） */
function loadLlmSettings() {
  try {
    const saved = localStorage.getItem('cf_providers')
    if (saved) {
      const providers = JSON.parse(saved) as { id: string; apiKey?: string }[]
      const ds = providers.find((p) => p.id === 'deepseek')
      if (ds?.apiKey) llmKey.value = ds.apiKey
    }
  } catch {
    /* 数据损坏则用默认 */
  }
  llmModel.value = localStorage.getItem('cf_default_model') || 'deepseek/deepseek-v4-flash'
}

/** 保存配置到浏览器本地 */
function saveApiSettings() {
  localStorage.setItem(
    'cf_providers',
    JSON.stringify([
      {
        id: 'deepseek',
        name: 'DeepSeek',
        baseUrl: DEEPSEEK_BASE_URL,
        apiKey: llmKey.value.trim(),
        enabled: true,
        builtin: true,
        models: DEEPSEEK_MODELS,
      },
    ])
  )
  localStorage.setItem('cf_default_model', llmModel.value)
  showApiSettings.value = false
  ElMessage.success(llmConfigured.value ? 'API 设置已保存' : '已保存（尚未填写 API Key）')
}

// ===== 状态元数据 =====
const STATUS_META: Record<ProjectStatus, { label: string; color: string }> = {
  draft: { label: '草稿', color: '#8890a8' },
  clarifying: { label: '澄清中', color: '#f0c060' },
  planning: { label: '规划中', color: '#45b8ff' },
  executing: { label: '执行中', color: '#5ecb8a' },
  paused: { label: '已暂停', color: '#f09050' },
  done: { label: '已完成', color: '#a76bff' },
  failed: { label: '失败', color: '#f26060' },
}
function statusMeta(s: ProjectStatus) {
  return STATUS_META[s] || STATUS_META.draft
}

// ===== 项目图标 =====
function projectIcon(p: Project): string {
  const icons: [RegExp, string][] = [
    [/CRM|客户|crm/i, '📊'],
    [/选课|学生|教育|课程/i, '🎓'],
    [/进销存|库存|采购|订单|商城/i, '📦'],
    [/图书|借阅/i, '📚'],
  ]
  return icons.find(([re]) => re.test(p.name))?.[1] ?? '💻'
}
function projectGrad(p: Project): string {
  const grads = [
    'linear-gradient(135deg,#45b8ff,#a76bff)',
    'linear-gradient(135deg,#5ecb8a,#5ec8c0)',
    'linear-gradient(135deg,#f0c060,#f09050)',
    'linear-gradient(135deg,#a76bff,#f070a0)',
  ]
  return grads[p.id % grads.length]
}

// ===== 筛选 =====
const filters = [
  { label: '全部', value: 'all', color: '#8890a8' },
  { label: '执行中', value: 'executing', color: '#5ecb8a' },
  { label: '已完成', value: 'done', color: '#a76bff' },
  { label: '澄清中', value: 'clarifying', color: '#f0c060' },
  { label: '草稿', value: 'draft', color: '#8890a8' },
]
const activeFilter = ref('all')
const keyword = ref('')

const projects = ref<Project[]>([])
const filtered = computed(() => {
  return projects.value.filter((p) => {
    const okStatus = activeFilter.value === 'all' || p.status === activeFilter.value
    const okKeyword = !keyword.value || p.name.includes(keyword.value)
    return okStatus && okKeyword
  })
})

onMounted(async () => {
  // 分页结果取 records 数组
  const { records } = await fetchProjects()
  projects.value = records
  loadLlmSettings()
})

/** 删除项目：确认 → 调接口 → 从列表移除（失败提示由 request.ts 拦截器统一弹出） */
async function removeProject(p: Project) {
  if (!window.confirm(`确定删除「${p.name}」吗？删除后不可恢复`)) return
  try {
    await deleteProject(p.id)
    projects.value = projects.value.filter((x) => x.id !== p.id)
  } catch {
  }
}

// ===== 统计 =====
function countBy(status: ProjectStatus | 'executing' | 'done' | 'clarifying'): number {
  return projects.value.filter((p) => p.status === status).length
}
const totalFiles = computed(() =>
  projects.value.reduce((sum, p) => sum + (p.fileCount || 0), 0)
)

// ===== 工作区切换（个人 ↔ 团队平级入口） =====
function switchWs(ws: 'personal' | 'team') {
  if (ws === 'team') {
    router.push('/teams')
  }
}

// ===== 新建（路由切换，不弹窗） =====
function createNew() {
  router.push({ name: 'project-new' })
}

// ===== 跳转：Agent 仓库（自定义 Agent 池管理） =====
function goAgentRepo() {
  router.push({ name: 'agent-repo' })
}

// ===== 跳转：点击卡片 → 项目概览页，定位到「功能清单 + 开发计划」区块 =====
function goProject(p: Project) {
  router.push({ name: 'project-detail', params: { id: String(p.id) }, hash: '#overview' })
}

// ===== 退出 =====
function logout() {
  localStorage.removeItem('cf_token')
  localStorage.removeItem('cf_active_tenant')
  router.push('/login')
}
</script>

<style scoped>
.projects {
  position: relative;
  z-index: 1;
  min-height: 100vh;
  background: transparent;
}

/* ===== 顶栏 ===== */
.topbar {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 48px;
  height: 56px;
  border-bottom: 1px solid var(--border);
  background: rgba(15, 19, 31, 0.85);
  backdrop-filter: blur(12px);
}
.topbar-center {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
}
.logo {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 600;
  font-size: 15px;
}
.logo img {
  width: 28px;
  height: 28px;
  border-radius: 8px;
}
.topbar-left {
  display: flex;
  align-items: center;
  gap: 14px;
}
.topbar-right {
  display: flex;
  align-items: center;
  gap: 14px;
}
.team-tag {
  padding: 4px 12px;
  border-radius: 14px;
  background: var(--bg3);
  border: 1px solid var(--border);
  font-size: 12px;
  color: var(--text2);
}
.avatar {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--bg4);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--blue);
  border: 1px solid var(--border2);
}
.btn-logout {
  padding: 6px 14px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text2);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
}
.btn-logout:hover {
  border-color: var(--red);
  color: var(--red);
}

/* ===== API 设置按钮 ===== */
.btn-api {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg3);
  color: var(--text2);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
}
.btn-api:hover {
  border-color: var(--blue);
  color: var(--blue);
}
.btn-api.ok {
  border-color: rgba(94, 203, 138, 0.4);
  color: var(--text1);
}
/* 配置状态点 */
.api-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--red);
  flex-shrink: 0;
}
.api-dot.on {
  background: var(--green);
  box-shadow: 0 0 6px rgba(94, 203, 138, 0.6);
}

/* ===== API 设置弹窗 ===== */
.modal-mask {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(8, 11, 17, 0.7);
  backdrop-filter: blur(4px);
}
.modal {
  width: 440px;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 26px;
}
.modal h2 {
  font-size: 17px;
  font-weight: 700;
  margin-bottom: 18px;
}
.api-tip {
  font-size: 12.5px;
  color: var(--text2);
  line-height: 1.7;
  margin-bottom: 16px;
}
.modal-field {
  margin-bottom: 14px;
}
.modal-field label {
  display: block;
  font-size: 12.5px;
  color: var(--text3);
  margin-bottom: 8px;
}
.provider-card {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px;
  background: var(--bg3);
}
.provider-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
.provider-name {
  font-size: 13.5px;
  font-weight: 600;
  flex: 1;
}
.provider-key-state {
  font-size: 11px;
  color: var(--green);
  padding: 2px 8px;
  border-radius: 8px;
  background: rgba(94, 203, 138, 0.08);
}
.provider-key-state.no {
  color: var(--yellow);
  background: rgba(240, 192, 96, 0.08);
}
.provider-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.provider-row:last-child {
  margin-bottom: 0;
}
.provider-label {
  width: 76px;
  flex-shrink: 0;
  font-size: 12px;
  color: var(--text3);
}
.input {
  flex: 1;
  min-width: 0;
  background: var(--bg4);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 12px;
  color: var(--text1);
  font-size: 13px;
  outline: none;
  transition: border-color 0.2s;
}
.input:focus {
  border-color: var(--blue);
}
.input:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.select {
  flex: 1;
  min-width: 0;
  background: var(--bg4);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 12px;
  color: var(--text1);
  font-size: 13px;
  outline: none;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 20px;
}
.btn-cancel {
  padding: 0 20px;
  height: 40px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text2);
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s;
}
.btn-cancel:hover {
  border-color: var(--border2);
  color: var(--text1);
}
.btn-save {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 40px;
  padding: 0 22px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--grad1);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity var(--dur) var(--ease), transform 0.1s;
}
.btn-save:hover {
  opacity: 0.9;
}

/* ===== 主区域 ===== */
.main {
  width: 100%;
  padding: 32px 48px;
}

/* 页头 */
.page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
}
.page-head h1 {
  font-size: 24px;
  font-weight: 700;
}

/* 统计栏 */
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 12px;
  margin-bottom: 20px;
}
.stat-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 14px 0;
  border-radius: var(--radius);
  background: var(--bg2);
  border: 1px solid var(--border);
}
.stat-num {
  font-size: 22px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.stat-label {
  font-size: 11.5px;
  color: var(--text3);
}

/* 工具栏 */
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 24px;
  gap: 16px;
  flex-wrap: wrap;
}
.filters {
  display: flex;
  gap: 8px;
}
.filter-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border-radius: 20px;
  border: 1px solid var(--border);
  background: var(--bg2);
  color: var(--text2);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
}
.filter-btn:hover {
  border-color: var(--border2);
  color: var(--text);
}
.filter-btn.active {
  border-color: var(--blue);
  color: var(--blue);
  background: rgba(69, 184, 255, 0.08);
}
.search-box {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 14px;
  height: 36px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg2);
  color: var(--text3);
  width: 240px;
}
.search-box input {
  flex: 1;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: 13px;
  outline: none;
}
.search-box input::placeholder {
  color: var(--text3);
}

/* ===== 卡片网格 ===== */
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 16px;
}
.proj-card {
  padding: 20px;
}
.proj-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}
.proj-ico {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 20px;
}
.proj-top-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
/* 项目名：图标右侧，占满剩余空间 */
.proj-name {
  flex: 1;
  min-width: 0;
  margin: 0 0 0 12px;
  font-size: 15px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.proj-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
}
/* 删除按钮：hover 卡片时才显示 */
.btn-del {
  width: 22px;
  height: 22px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text3);
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition: all 0.2s;
}
.proj-card:hover .btn-del {
  opacity: 1;
}
.btn-del:hover {
  border-color: var(--red);
  color: var(--red);
  background: rgba(242, 96, 96, 0.08);
}
.proj-info p {
  font-size: 12.5px;
  color: var(--text2);
  line-height: 1.6;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 40px;
}
.proj-bottom {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  margin-top: 14px;
  gap: 8px;
}
.proj-meta {
  flex: 1;
  min-width: 0;
}
.proj-progress {
  height: 4px;
  border-radius: 2px;
  background: var(--bg3);
  overflow: hidden;
  margin-bottom: 6px;
}
.proj-progress-fill {
  height: 100%;
  border-radius: 2px;
  background: var(--grad1);
  transition: width 0.4s var(--ease);
}
.proj-time {
  font-size: 11.5px;
  color: var(--text3);
}
.proj-enter {
  font-size: 12px;
  color: var(--blue);
  opacity: 0;
  transform: translateX(-4px);
  transition: all 0.2s var(--ease);
  flex-shrink: 0;
}
.proj-card:hover .proj-enter {
  opacity: 1;
  transform: translateX(0);
}
</style>
