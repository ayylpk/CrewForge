<template>
  <div class="overview">
    <!-- 顶栏 -->
    <header class="topbar">
      <button class="btn-back" @click="goBack">← {{ backLabel }}</button>
      <div class="topbar-title">
        <span class="dim">项目 ·</span>
        <span>{{ projectName }}</span>
      </div>
      <div class="topbar-right">
        <!-- 阶段 2 点火：开工/停止（对账器状态来自 /api/project-run/{id}） -->
        <span v-if="runStatus?.running" class="run-hint">
          ⚙ 引擎运行中（pid {{ runStatus.pid }}{{ runStatus.restartCount ? ` · 续拉 ${runStatus.restartCount}` : '' }}）
        </span>
        <button v-if="canStop" class="btn-stop" :disabled="stopping" @click="stopWork">
          {{ stopping ? '停止中…' : '停止' }}
        </button>
        <GradientButton v-if="canStart" :disabled="starting" @click="startWork">
          {{ starting ? '拉起中…' : startLabel }}
        </GradientButton>
        <GradientButton @click="router.push({ name: 'execution', params: { id: route.params.id } })">
          进入执行面板
        </GradientButton>
      </div>
    </header>

    <main class="main">
      <!-- 头部信息 -->
      <div class="head-card">
        <div class="head-left">
          <h1>{{ projectName }} <span class="status-badge" :style="{ color: statusColor }">
            <span class="status-dot" :style="{ background: statusColor }"></span>{{ statusLabel }}
          </span></h1>
          <p class="desc">{{ project?.description || '暂无描述' }}</p>
        </div>
      </div>

      <!-- 功能入口（项目工作台） -->
      <div class="entry-grid">
        <button class="entry-card" @click="router.push({ name: 'execution', params: { id: route.params.id } })">
          <span class="entry-ico" style="background: rgba(69, 184, 255, 0.12); color: var(--blue)">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
          </span>
          <span class="entry-name">执行面板</span>
          <span class="entry-desc">Agent 任务流水线</span>
        </button>

        <button class="entry-card" @click="router.push({ name: 'pm', params: { id: route.params.id } })">
          <span class="entry-ico" style="background: rgba(240, 112, 160, 0.12); color: var(--pink)">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </span>
          <span class="entry-name">需求对话</span>
          <span class="entry-desc">项目经理 · 改功能</span>
        </button>

        <button class="entry-card" @click="router.push({ name: 'architect', params: { id: route.params.id }, query: { role: 'architect' } })">
          <span class="entry-ico" style="background: rgba(167, 107, 255, 0.12); color: var(--purple)">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10" />
              <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
            </svg>
          </span>
          <span class="entry-name">技术方案</span>
          <span class="entry-desc">架构师 · 技术选型</span>
        </button>

        <button class="entry-card" @click="router.push({ name: 'team', params: { id: route.params.id } })">
          <span class="entry-ico" style="background: rgba(94, 203, 138, 0.12); color: var(--green)">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
            </svg>
          </span>
          <span class="entry-name">Agent 团队</span>
          <span class="entry-desc">成员 · 模型 · 提示词</span>
        </button>

        <button class="entry-card" @click="downloadZip">
          <span class="entry-ico" style="background: rgba(94, 200, 192, 0.12); color: var(--cyan)">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </span>
          <span class="entry-name">下载项目</span>
          <span class="entry-desc">zip 打包</span>
        </button>

        <button class="entry-card" @click="scrollTo('overview')">
          <span class="entry-ico" style="background: rgba(240, 192, 96, 0.12); color: var(--yellow)">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
            </svg>
          </span>
          <span class="entry-name">项目概览</span>
          <span class="entry-desc">功能 · 接口 · 版本</span>
        </button>
      </div>

      <!-- 功能清单 + 开发计划（数据来自后端 businessModules / devPlan，没有就显示空态） -->
      <div id="overview" class="grid-2">
        <CardShell class="card">
          <h3 class="card-title">已确认功能</h3>
          <div v-if="features.length" class="feature-list">
            <div v-for="(f, i) in features" :key="i" class="feature-item">
              <span class="feature-check">✓</span>{{ f }}
            </div>
          </div>
          <p v-else class="empty-tip">暂无已确认功能</p>
        </CardShell>

        <!-- 开发计划 -->
        <CardShell class="card">
          <h3 class="card-title">开发计划</h3>
          <div v-if="plan.length" class="plan-list">
            <div v-for="(p, i) in plan" :key="i" class="plan-item">
              <span class="plan-phase"><span class="plan-dot"></span>阶段 {{ i + 1 }} · {{ p.name }}</span>
              <div v-if="p.tasks?.length" class="plan-tasks">
                <span v-for="t in p.tasks" :key="t" class="plan-task-tag">{{ t }}</span>
              </div>
            </div>
          </div>
          <p v-else class="empty-tip">暂无开发计划</p>
        </CardShell>
      </div>

      <!-- 操作区 -->
      <div class="actions">
        <button class="act-btn primary" @click="downloadZip">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          下载项目 zip
        </button>
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import CardShell from '../components/CardShell.vue'
import GradientButton from '../components/GradientButton.vue'
import { fetchProjectById } from '../api/project'
import { startProjectRun, stopProjectRun, fetchRunStatus, type RunStatus } from '../api/projectRun'
import type { Project, ProjectStatus } from '../types/project'

const router = useRouter()
const route = useRoute()

// ===== 项目数据（真实接口） =====
const project = ref<Project | null>(null)
const loading = ref(true)

/** 后端 JSON 字符串字段解析成数组（解析失败返回空数组 —— 没有就没有） */
function parseJsonArr(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.map(String) : []
  } catch {
    return []
  }
}

// 已确认功能(businessModules)（字符串数组）
const features = computed(() => parseJsonArr(project.value?.businessModules))

/** 开发阶段（devPlan 是对象数组：{ name, progress, tasks }） */
interface PlanPhase {
  name: string
  progress?: number
  tasks?: string[]
}
const plan = computed<PlanPhase[]>(() => {
  if (!project.value?.devPlan) return []
  try {
    const v = JSON.parse(project.value.devPlan)
    // 引擎 PM 存的是 { phases: [...] }，网页手写可能是数组——两种都认
    const arr = Array.isArray(v) ? v : v?.phases
    return Array.isArray(arr) ? (arr as PlanPhase[]) : []
  } catch {
    return []
  }
})

// ===== 项目状态 =====
const STATUS_META: Record<ProjectStatus, { label: string; color: string }> = {
  draft: { label: '草稿', color: '#8890a8' },
  clarifying: { label: '澄清中', color: '#f0c060' },
  planning: { label: '规划中', color: '#45b8ff' },
  executing: { label: '执行中', color: '#5ecb8a' },
  paused: { label: '已暂停', color: '#f09050' },
  done: { label: '已完成', color: '#a76bff' },
  failed: { label: '失败', color: '#f26060' },
}
const statusLabel = computed(() => STATUS_META[project.value?.status || 'draft'].label)
const statusColor = computed(() => STATUS_META[project.value?.status || 'draft'].color)
const projectName = computed(() => project.value?.name || '项目 #' + route.params.id)

/** 返回项目列表 */
const backLabel = '项目列表'

function goBack() {
  router.push('/projects')
}

// ===== 阶段 2 点火：开工 / 停止 / 进程状态轮询 =====
const runStatus = ref<RunStatus | null>(null)
const starting = ref(false)
const stopping = ref(false)
let pollTimer: ReturnType<typeof setInterval> | null = null

async function refreshProject() {
  project.value = await fetchProjectById(Number(route.params.id))
}

async function refreshRunStatus() {
  try {
    runStatus.value = await fetchRunStatus(Number(route.params.id))
  } catch {
    runStatus.value = null // 无账/后端未就绪：按钮组按未运行处理（start 接口自有真错提示）
  }
}

/** 引擎是否在跑（进程判活由后端两级完成，前端只看结论） */
const isRunning = computed(() => runStatus.value?.running === true)

const canStart = computed(() => {
  if (isRunning.value || !project.value) return false
  const s = project.value.status
  // 开工窗口：方案已确认(planning) / 暂停·失败续跑 / 执行中但对账账本 stopped（手动停过）
  return s === 'planning' || s === 'paused' || s === 'failed' || (s === 'executing' && runStatus.value?.runState === 'stopped')
})
const canStop = computed(() => isRunning.value || project.value?.status === 'executing')
const startLabel = computed(() => {
  const s = project.value?.status
  return s === 'paused' || s === 'failed' || (s === 'executing' && runStatus.value?.runState === 'stopped') ? '继续开工' : '🔥 开工'
})

async function startWork() {
  starting.value = true
  try {
    await startProjectRun(Number(route.params.id))
    ElMessage.success('引擎已拉起，流水线开跑——去执行面板看任务流转')
    await Promise.all([refreshProject(), refreshRunStatus()])
    router.push({ name: 'execution', params: { id: route.params.id } })
  } finally {
    starting.value = false
  }
}

async function stopWork() {
  try {
    await ElMessageBox.confirm(
      '将终止引擎进程并暂停续拉（在途任务停在当前粒度，续开工从断点接上）。确定停止？',
      '停止运行',
      { type: 'warning', confirmButtonText: '停止', cancelButtonText: '再想想' },
    )
  } catch {
    return
  }
  stopping.value = true
  try {
    await stopProjectRun(Number(route.params.id))
    ElMessage.success('已停止（对账器不会再自动续拉，点「继续开工」可恢复）')
    await Promise.all([refreshProject(), refreshRunStatus()])
  } finally {
    stopping.value = false
  }
}

onMounted(async () => {
  try {
    await refreshProject()
  } finally {
    loading.value = false
  }
  await refreshRunStatus()
  // 10s 轻轮询：项目状态 + 进程账本（开工→跑完→done 全程无人肉刷新）
  pollTimer = setInterval(() => {
    void refreshProject().catch(() => {})
    void refreshRunStatus()
  }, 10_000)
})

onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer)
})

/** 概览锚点滚动 */
function scrollTo(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })
}

/** 下载 zip（调后端 API 打包项目文件） */
function downloadZip() {
  const id = route.params.id
  const a = document.createElement('a')
  a.href = `/api/project/${id}/download`
  a.download = `${projectName.value}.zip`
  a.click()
}
</script>

<style scoped>
.overview {
  position: relative;
  z-index: 1;
  min-height: 100vh;
}

/* ===== 顶栏 ===== */
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 48px;
  height: 56px;
  border-bottom: 1px solid var(--border);
  background: rgba(15, 19, 31, 0.85);
  backdrop-filter: blur(12px);
}
.btn-back {
  padding: 7px 14px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text2);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
}
/* ===== 开工/停止按钮区 ===== */
.topbar-right {
  display: flex;
  align-items: center;
  gap: 12px;
}
.run-hint {
  font-size: 12px;
  color: var(--green);
  white-space: nowrap;
}
.btn-stop {
  height: 40px;
  padding: 0 16px;
  border-radius: var(--radius-sm);
  border: 1px solid rgba(242, 96, 96, 0.45);
  background: rgba(242, 96, 96, 0.08);
  color: #f26060;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
}
.btn-stop:hover:not(:disabled) {
  background: rgba(242, 96, 96, 0.18);
}
.btn-stop:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.btn-back:hover {
  border-color: var(--border2);
  color: var(--text);
}
.topbar-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
}
.dim {
  color: var(--text3);
  font-weight: 400;
}
.topbar-right {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* ===== 主区域 ===== */
.main {
  width: 100%;
  max-width: 1080px;
  margin: 0 auto;
  padding: 32px 48px 60px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

/* 头部 */
.head-card {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  padding: 24px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border);
  background: var(--bg2);
}
.head-left h1 {
  font-size: 22px;
  font-weight: 700;
  margin-bottom: 8px;
}
.desc {
  font-size: 13.5px;
  color: var(--text2);
  line-height: 1.7;
  margin-bottom: 14px;
}
/* 状态徽章 */
.status-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 500;
  padding: 3px 10px;
  border-radius: 10px;
  background: var(--bg3);
  border: 1px solid var(--border);
  vertical-align: middle;
  margin-left: 8px;
}
.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

/* 功能入口网格 */
.entry-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 12px;
}
.entry-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 18px 12px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--bg2);
  cursor: pointer;
  transition: all 0.2s var(--ease);
}
.entry-card:hover {
  border-color: var(--border2);
  transform: translateY(-2px);
  box-shadow: var(--shadow-sm);
}
.entry-ico {
  width: 42px;
  height: 42px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.entry-name {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text);
}
.entry-desc {
  font-size: 11px;
  color: var(--text3);
}

.head-right {
  display: flex;
  gap: 24px;
  align-items: center;
  flex-shrink: 0;
}
.stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}
.stat-num {
  font-size: 24px;
  font-weight: 700;
  color: var(--text);
}
.stat-label {
  font-size: 11.5px;
  color: var(--text3);
}

/* 卡片 */
.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
}
.card {
  padding: 20px;
}
.card-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 14px;
}
.empty-tip {
  font-size: 12.5px;
  color: var(--text3);
  padding: 12px 0;
}
.feature-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.feature-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text2);
}
.feature-check {
  color: var(--green);
  font-weight: 700;
}
.plan-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.plan-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 9px 12px;
  border-radius: 9px;
  background: var(--bg3);
  font-size: 13px;
}
.plan-phase {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text);
}
/* 阶段任务标签 */
.plan-tasks {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  padding-left: 16px;
}
.plan-task-tag {
  padding: 2px 8px;
  border-radius: 7px;
  background: var(--bg4);
  border: 1px solid var(--border);
  font-size: 11px;
  color: var(--text2);
}
.plan-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text3);
}
.plan-phase.done .plan-dot {
  background: var(--green);
}
.plan-phase.current .plan-dot {
  background: var(--blue);
  animation: pulse 1.2s infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
.plan-state {
  font-size: 11.5px;
  color: var(--text3);
}

/* 模块 */
.module-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.module-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-radius: 9px;
  background: var(--bg3);
  font-size: 13px;
}
.module-ico {
  width: 26px;
  height: 26px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  flex-shrink: 0;
}
.module-name {
  flex: 1;
  color: var(--text);
}
.module-files {
  font-size: 11.5px;
  color: var(--text3);
}
.module-state {
  font-size: 11.5px;
  font-weight: 500;
}

/* 返回按钮 */
.team-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.team-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-radius: 9px;
  background: var(--bg3);
  font-size: 13px;
}
.team-avatar {
  width: 26px;
  height: 26px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.team-name {
  flex: 1;
  color: var(--text);
  font-weight: 500;
}
.team-roles {
  font-size: 11.5px;
  color: var(--text3);
}

/* 接口 */
.api-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.api-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--bg3);
  font-size: 12.5px;
  font-family: 'Consolas', monospace;
}
.api-method {
  width: 60px;
  text-align: center;
  padding: 2px 6px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 700;
  flex-shrink: 0;
}
.api-method.get { background: rgba(94, 203, 138, 0.12); color: var(--green); }
.api-method.post { background: rgba(69, 184, 255, 0.12); color: var(--blue); }
.api-method.put { background: rgba(240, 192, 96, 0.12); color: var(--yellow); }
.api-method.delete { background: rgba(242, 96, 96, 0.12); color: var(--red); }
.api-path {
  flex: 1;
  color: var(--text2);
}
.api-desc {
  font-size: 11.5px;
  color: var(--text3);
  font-family: inherit;
}

/* 版本 */
.version-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.version-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 12px;
  border-radius: 9px;
  background: var(--bg3);
  font-size: 13px;
}
.version-tag {
  padding: 2px 8px;
  border-radius: 8px;
  background: rgba(167, 107, 255, 0.12);
  color: var(--purple);
  font-size: 11.5px;
  font-weight: 600;
  flex-shrink: 0;
}
.version-log {
  flex: 1;
  color: var(--text2);
}
.version-time {
  font-size: 11.5px;
  color: var(--text3);
  flex-shrink: 0;
}

/* 操作 */
.actions {
  display: flex;
  gap: 12px;
}
.act-btn {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 11px 20px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg3);
  color: var(--text2);
  font-size: 13.5px;
  cursor: pointer;
  transition: all 0.2s;
}
.act-btn:hover {
  border-color: var(--border2);
  color: var(--text);
}
.act-btn.primary {
  background: var(--grad1);
  border-color: transparent;
  color: #fff;
  font-weight: 600;
}
.act-btn.primary:hover {
  opacity: 0.9;
}
</style>
