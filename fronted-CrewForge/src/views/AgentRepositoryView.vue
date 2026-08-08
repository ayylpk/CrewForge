<template>
  <div class="agent-repo">
    <!-- 顶栏 -->
    <header class="topbar">
      <div class="topbar-left">
        <div class="logo">
          <img src="../assets/logo-crewforge.png" alt="CrewForge" />
          <span>CrewForge</span>
        </div>
      </div>
      <div class="topbar-center">
        <WorkspaceSwitcher :current="'personal'" @switch="switchWs" />
      </div>
      <div class="topbar-right">
        <button class="btn-back" @click="router.back()">← 返回</button>
        <span class="avatar">K</span>
      </div>
    </header>

    <main class="main">
      <!-- 页头 -->
      <div class="page-head">
        <h1>Agent 仓库</h1>
        <span class="hint">共 {{ total }} 个自定义 Agent，可在项目团队配置里一键复制使用</span>
        <button class="btn-new" @click="router.push({ name: 'agent-new' })">+ 新建 Agent</button>
      </div>

      <!-- 搜索 -->
      <div class="toolbar">
        <input
          v-model="keyword"
          class="search-input"
          type="text"
          placeholder="按名称/职位搜索..."
          @keyup.enter="search"
        />
        <button class="btn-search" @click="search">搜索</button>
      </div>

      <!-- 加载中 -->
      <div v-if="loading && agents.length === 0" class="loading">加载中...</div>

      <!-- 空态：仓库暂无 Agent -->
      <EmptyState
        v-else-if="agents.length === 0"
        title="仓库还是空的"
        desc="这里保存你自定义的 Agent 模板，之后在项目团队配置里可以一键复制使用"
      />

      <!-- 列表 -->
      <div v-else class="agent-grid">
        <div v-for="a in agents" :key="a.id" class="agent-card" @click="edit(a)">
          <div class="card-top">
            <span class="role-tag" :style="{ color: roleColor(a.role).color, background: roleColor(a.role).bg }">
              {{ a.role || '通用' }}
            </span>
            <div class="card-ops">
              <button class="op-btn" title="编辑" @click.stop="edit(a)">✎</button>
              <button class="op-btn del" title="删除" @click.stop="remove(a)">✕</button>
            </div>
          </div>
          <h3 class="card-name">{{ a.name }}</h3>
          <p class="card-prompt">{{ a.systemPrompt || '暂无系统提示词' }}</p>
          <div class="card-meta">
            <span>模型：{{ a.model ? modelLabel(a.model) : '跟随全局' }}</span>
            <span>温度：{{ a.temperature ?? 0.7 }}</span>
            <span>{{ toolsCount(a.tools) }} 个工具</span>
            <span>{{ formatTime(a.createTime) }}</span>
          </div>
        </div>
      </div>

      <!-- 分页 -->
      <div v-if="total > pageSize" class="pager">
        <button class="page-btn" :disabled="page <= 1" @click="page--; load()">上一页</button>
        <span class="page-num">{{ page }} / {{ pages }}</span>
        <button class="page-btn" :disabled="page >= pages" @click="page++; load()">下一页</button>
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
/**
 * Agent 仓库：自定义 Agent 池（sys_agent）管理页
 * 列表分页查询 + 搜索；新建 → /agents/new；编辑 → /agents/:id；删除 → DELETE 复合 ids
 * 从池里复制到项目 = sys_project_agent（复制非引用）
 */
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { fetchAgentPool, deleteAgentPool } from '../api/agentPools'
import type { agentPoolVO } from '../types/agent'
import WorkspaceSwitcher from '../components/WorkspaceSwitcher.vue'
import EmptyState from '../components/EmptyState.vue'

/** 当前登录用户 ID（登录时存的 cf_user_info） */
function currentUserId(): number {
  const raw = localStorage.getItem('cf_user_info')
  return raw ? (JSON.parse(raw) as { userId: number }).userId : 0
}

const router = useRouter()
const userId = currentUserId()

// ===== 职责配色（与 TeamView/AgentFormView 一致） =====
const ROLE_COLOR: Record<string, { color: string; bg: string }> = {
  项目经理: { color: '#f070a0', bg: 'rgba(240,112,160,.12)' },
  架构师: { color: '#a76bff', bg: 'rgba(167,107,255,.12)' },
  后端开发: { color: '#5ecb8a', bg: 'rgba(94,203,138,.12)' },
  前端开发: { color: '#f0c060', bg: 'rgba(240,192,96,.12)' },
  测试: { color: '#5ec8c0', bg: 'rgba(94,200,192,.12)' },
  运维部署: { color: '#f09050', bg: 'rgba(144,80,50,.12)' },
  文档维护: { color: '#45b8ff', bg: 'rgba(69,184,255,.12)' },
}

function roleColor(role: string) {
  return ROLE_COLOR[role] || { color: 'var(--text2)', bg: 'var(--bg3)' }
}

/** 模型显示名（model 存 'provider/model'） */
function modelLabel(value: string): string {
  return value.split('/').slice(1).join('/') || value
}

/** tools JSON 数组字符串 → 工具数量 */
function toolsCount(tools: string): number {
  if (!tools) return 0
  try {
    const arr = JSON.parse(tools)
    return Array.isArray(arr) ? arr.length : 0
  } catch {
    return tools ? tools.split(',').length : 0
  }
}

/** 时间戳 → 日期（YYYY-MM-DD） */
function formatTime(t: string): string {
  return t ? t.slice(0, 10) : ''
}

// ===== 列表 =====
const agents = ref<agentPoolVO[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = 12
const keyword = ref('')
const loading = ref(false)

const pages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)))

async function load() {
  loading.value = true
  try {
    const res = await fetchAgentPool({
      page: page.value,
      pageSize,
      userId,
      keyword: keyword.value.trim() || undefined,
    })
    agents.value = res.records
    total.value = res.total
    // 删到当前页空了就回退一页
    if (agents.value.length === 0 && page.value > 1) {
      page.value--
      load()
    }
  } catch {
    /* 拦截器已提示 */
  } finally {
    loading.value = false
  }
}

function search() {
  page.value = 1
  load()
}

function edit(a: agentPoolVO) {
  router.push(`/agents/${a.id}`)
}

async function remove(a: agentPoolVO) {
  try {
    await ElMessageBox.confirm(`确定删除「${a.name}」吗？删除后不可恢复`, '删除确认', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    return // 用户取消
  }
  try {
    await deleteAgentPool(userId, [a.id])
    ElMessage.success(`已删除「${a.name}」`)
    load()
  } catch {
    /* 拦截器已提示 */
  }
}

onMounted(load)

/** 工作区切换：个人 ↔ 团队 */
function switchWs(ws: 'personal' | 'team') {
  if (ws === 'personal') {
    router.push('/projects')
  } else {
    router.push('/teams')
  }
}
</script>

<style scoped>
.agent-repo {
  min-height: 100vh;
  background: transparent;
}

/* ===== 顶栏（与首页一致） ===== */
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
.btn-back {
  padding: 6px 14px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text2);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
}
.btn-back:hover {
  border-color: var(--blue);
  color: var(--blue);
}
.avatar {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--bg4);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 600;
  color: var(--text2);
}

/* ===== 主体 ===== */
.main {
  width: 100%;
  padding: 32px 48px;
}
.page-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 20px;
}
.page-head h1 {
  font-size: 22px;
}
.hint {
  flex: 1;
  font-size: 12.5px;
  color: var(--text3);
}
.btn-new {
  padding: 8px 16px;
  border-radius: 8px;
  border: none;
  background: var(--grad1, linear-gradient(135deg, #45b8ff, #a76bff));
  color: #fff;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: opacity 0.2s;
}
.btn-new:hover {
  opacity: 0.9;
}

/* ===== 搜索栏 ===== */
.toolbar {
  display: flex;
  gap: 10px;
  margin-bottom: 20px;
}
.search-input {
  flex: 1;
  max-width: 360px;
  padding: 8px 14px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg2);
  color: var(--text);
  font-size: 13px;
  outline: none;
  transition: border-color 0.2s;
}
.search-input:focus {
  border-color: var(--blue);
}
.btn-search {
  padding: 8px 18px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg3);
  color: var(--text2);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
}
.btn-search:hover {
  border-color: var(--blue);
  color: var(--blue);
}

/* ===== 加载 ===== */
.loading {
  padding: 60px 0;
  text-align: center;
  font-size: 13px;
  color: var(--text3);
}

/* ===== Agent 卡片网格 ===== */
.agent-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 16px;
}
.agent-card {
  display: flex;
  flex-direction: column;
  padding: 16px 18px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--bg2);
  cursor: pointer;
  transition: all 0.2s;
}
.agent-card:hover {
  border-color: var(--blue);
  transform: translateY(-2px);
}
.card-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.role-tag {
  padding: 2px 10px;
  border-radius: 20px;
  font-size: 12px;
  font-weight: 500;
}
.card-ops {
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.2s;
}
.agent-card:hover .card-ops {
  opacity: 1;
}
.op-btn {
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text3);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
}
.op-btn:hover {
  background: rgba(69, 184, 255, 0.15);
  color: var(--blue);
}
.op-btn.del:hover {
  background: rgba(240, 80, 80, 0.15);
  color: var(--red);
}
.card-name {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 6px;
}
.card-prompt {
  flex: 1;
  font-size: 12.5px;
  color: var(--text3);
  line-height: 1.6;
  margin-bottom: 12px;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.card-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  font-size: 12px;
  color: var(--text2);
}

/* ===== 分页 ===== */
.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  margin-top: 28px;
}
.page-btn {
  padding: 6px 16px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg2);
  color: var(--text2);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
}
.page-btn:hover:not(:disabled) {
  border-color: var(--blue);
  color: var(--blue);
}
.page-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.page-num {
  font-size: 13px;
  color: var(--text2);
}
</style>
