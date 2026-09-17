<script setup lang="ts">
/* ============================================================
   项目详情页（/projects/:id/overview）= 项目总图首页
   ------------------------------------------------------------
   世界观：一张项目图纸的"首页"——标题栏 + 图别目录（六个入口）+
   功能清单/开发计划两栏 + 底部出图（下载 zip）。
   开工/停止 = 引擎点火台，进程判活由后端两级完成，前端只看结论；
   10s 轻轮询：项目状态 + 进程账本（开工→跑完→done 全程无人肉刷新）。
   旧版页尾 module/team/api/version 四段样式为死代码（模板未用），已清理。
   ============================================================ */
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  IconCheck,
  IconCompass,
  IconDownload,
  IconFileText,
  IconFlame,
  IconPlayerPlay,
  IconStar,
  IconUsers,
} from '@tabler/icons-vue'
import TopBar from '../components/ui/TopBar.vue'
import StampSeal from '../components/ui/StampSeal.vue'
import { downloadProjectZip, fetchProjectById } from '../api/project'
import { fetchRunStatus, startProjectRun, stopProjectRun, type RunStatus } from '../api/projectRun'
import { usePolling } from '../composables/usePolling'
import { projectStatusMeta } from '../constants/status'
import { confirmDialog } from '../utils/confirm'
import { toast } from '../utils/toast'
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

// ===== 项目状态（图章口径：颜色走 constants/status 单一来源） =====
const statusMeta = computed(() => projectStatusMeta(project.value?.status || ('draft' as ProjectStatus)))
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
  return s === 'paused' || s === 'failed' || (s === 'executing' && runStatus.value?.runState === 'stopped') ? '继续开工' : '开工'
})

async function startWork() {
  starting.value = true
  try {
    await startProjectRun(Number(route.params.id))
    toast.success('引擎已拉起，流水线开跑——去执行面板看任务流转')
    await Promise.all([refreshProject(), refreshRunStatus()])
    router.push({ name: 'execution', params: { id: route.params.id } })
  } finally {
    starting.value = false
  }
}

async function stopWork() {
  const ok = await confirmDialog({
    title: '停止运行',
    body: '将终止引擎进程并暂停续拉（在途任务停在当前粒度，续开工从断点接上）。确定停止？',
    ok: '停止',
    cancel: '再想想',
    danger: true,
  })
  if (!ok) return
  stopping.value = true
  try {
    await stopProjectRun(Number(route.params.id))
    toast.success('已停止（对账器不会再自动续拉，点「继续开工」可恢复）')
    await Promise.all([refreshProject(), refreshRunStatus()])
  } finally {
    stopping.value = false
  }
}

/** 10s 轻轮询：项目状态 + 进程账本（不接住 start 表就不走——9/17 自查逮住；卸载自动停表） */
const { start: startPolling } = usePolling(() => {
  void refreshProject().catch(() => {})
  void refreshRunStatus()
}, 10_000)
startPolling()

// 首帧：先取项目（结束骨架），再探进程账本
void refreshProject()
  .catch(() => {})
  .finally(() => {
    loading.value = false
  })
void refreshRunStatus()

/** 概览锚点滚动 */
function scrollTo(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })
}

/** 下载 zip（audit F1：原实现 <a href> 直导航——不带 Authorization、dev 下无 /api 代理，必坏包。
 *  改走 axios 实例 blob 下载，request.ts 拦截器已放行 Blob 不拆 Result 信封） */
async function downloadZip() {
  try {
    const id = Number(route.params.id)
    const blob = await downloadProjectZip(id)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${projectName.value}.zip`
    a.click()
    URL.revokeObjectURL(url)
  } catch {
    // 失败已由响应拦截器统一弹 toast，此处不重复提示
  }
}
</script>

<template>
  <div class="view">
    <TopBar>
      <template #context>
        <button class="tb-back btn btn-sm btn-ghost" @click="goBack">← {{ backLabel }}</button>
        <span class="tb-title">
          <span class="dim">项目 ·</span>
          <span>{{ projectName }}</span>
        </span>
        <span class="sheet-no">PRJ-{{ String(route.params.id).padStart(4, '0') }}-O</span>
      </template>
      <template #right>
        <!-- 阶段 2 点火：开工/停止（对账器状态来自 /api/project-run/{id}） -->
        <span v-if="runStatus?.running" class="run-hint">
          <span class="lamp lamp-on lamp-live"></span>
          引擎运行中（pid {{ runStatus.pid }}{{ runStatus.restartCount ? ` · 续拉 ${runStatus.restartCount}` : '' }}）
        </span>
        <button v-if="canStop" class="btn btn-sm btn-danger" :disabled="stopping" @click="stopWork">
          {{ stopping ? '停止中…' : '停止' }}
        </button>
        <button v-if="canStart" class="btn btn-primary" :disabled="starting" @click="startWork">
          <IconFlame v-if="!starting" :size="15" :stroke-width="1.75" />
          {{ starting ? '拉起中…' : startLabel }}
        </button>
        <button class="btn btn-primary" @click="router.push({ name: 'execution', params: { id: route.params.id } })">
          进入执行面板
        </button>
      </template>
    </TopBar>

    <main class="page">
      <template v-if="loading && !project">
        <!-- 骨架：与真实版式同形（标题栏 / 六入口 / 双栏） -->
        <div class="skeleton sk-head"></div>
        <div class="entry-grid">
          <div v-for="i in 6" :key="i" class="skeleton sk-entry"></div>
        </div>
        <div class="grid-2">
          <div class="skeleton sk-panel"></div>
          <div class="skeleton sk-panel"></div>
        </div>
      </template>

      <template v-else>
        <!-- ===== 图纸标题栏 ===== -->
        <section class="panel head-card">
          <div class="head-main">
            <h1 class="head-title">
              {{ projectName }}
              <StampSeal :label="statusMeta.label" :tone="statusMeta.tone" />
            </h1>
            <p class="desc">{{ project?.description || '暂无描述' }}</p>
          </div>
        </section>

        <!-- ===== 图别目录（六个入口） ===== -->
        <nav class="entry-grid" aria-label="项目工作台">
          <button class="entry-card" @click="router.push({ name: 'execution', params: { id: route.params.id } })">
            <span class="entry-ico"><IconPlayerPlay :size="19" :stroke-width="1.75" /></span>
            <span class="entry-name">执行面板</span>
            <span class="entry-desc">Agent 任务流水线</span>
          </button>

          <button class="entry-card" @click="router.push({ name: 'pm', params: { id: route.params.id } })">
            <span class="entry-ico"><IconUsers :size="19" :stroke-width="1.75" /></span>
            <span class="entry-name">需求对话</span>
            <span class="entry-desc">项目经理 · 改功能</span>
          </button>

          <button class="entry-card" @click="router.push({ name: 'architect', params: { id: route.params.id }, query: { role: 'architect' } })">
            <span class="entry-ico"><IconCompass :size="19" :stroke-width="1.75" /></span>
            <span class="entry-name">技术方案</span>
            <span class="entry-desc">架构师 · 技术选型</span>
          </button>

          <button class="entry-card" @click="router.push({ name: 'team', params: { id: route.params.id } })">
            <span class="entry-ico"><IconStar :size="19" :stroke-width="1.75" /></span>
            <span class="entry-name">Agent 团队</span>
            <span class="entry-desc">成员 · 模型 · 提示词</span>
          </button>

          <button class="entry-card" @click="downloadZip">
            <span class="entry-ico"><IconDownload :size="19" :stroke-width="1.75" /></span>
            <span class="entry-name">下载项目</span>
            <span class="entry-desc">zip 打包</span>
          </button>

          <button class="entry-card" @click="scrollTo('overview')">
            <span class="entry-ico"><IconFileText :size="19" :stroke-width="1.75" /></span>
            <span class="entry-name">项目概览</span>
            <span class="entry-desc">功能 · 开发计划</span>
          </button>
        </nav>

        <!-- 功能清单 + 开发计划（数据来自后端 businessModules / devPlan，没有就显示空态） -->
        <div id="overview" class="grid-2">
          <section class="panel card">
            <header class="panel-head">
              <h3 class="panel-title">已确认功能</h3>
            </header>
            <div class="card-body">
              <ul v-if="features.length" class="rows feature-list">
                <li v-for="(f, i) in features" :key="i" class="row feature-item">
                  <span class="fico"><IconCheck :size="14" :stroke-width="1.75" /></span>{{ f }}
                </li>
              </ul>
              <p v-else class="empty-tip faint">暂无已确认功能</p>
            </div>
          </section>

          <!-- 开发计划 -->
          <section class="panel card">
            <header class="panel-head">
              <h3 class="panel-title">开发计划</h3>
            </header>
            <div class="card-body">
              <div v-if="plan.length" class="plan-list">
                <div v-for="(p, i) in plan" :key="i" class="plan-item">
                  <span class="plan-phase"><span class="plan-dot"></span>阶段 {{ i + 1 }} · {{ p.name }}</span>
                  <div v-if="p.tasks?.length" class="plan-tasks">
                    <span v-for="t in p.tasks" :key="t" class="plan-task-tag mono">{{ t }}</span>
                  </div>
                </div>
              </div>
              <p v-else class="empty-tip faint">暂无开发计划</p>
            </div>
          </section>
        </div>

        <!-- 操作区 -->
        <div class="actions">
          <button class="btn btn-primary" @click="downloadZip">
            <IconDownload :size="15" :stroke-width="1.75" />
            下载项目 zip
          </button>
        </div>
      </template>
    </main>
  </div>
</template>

<style scoped>
.view {
  position: relative;
  z-index: 1;
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
}
.tb-back {
  flex: none;
}
.tb-title {
  font-weight: 600;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.run-hint {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: var(--fs-meta);
  color: var(--pass-ink);
  white-space: nowrap;
}

/* ===== 骨架 ===== */
.sk-head {
  height: 108px;
  border-radius: var(--r);
  margin-bottom: 14px;
}
.sk-entry {
  height: 116px;
  border-radius: var(--r);
}
.sk-panel {
  height: 220px;
  border-radius: var(--r);
}

/* ===== 标题栏 ===== */
.head-card {
  padding: 22px 24px;
  margin-bottom: 14px;
}
.head-title {
  font-size: 22px;
  font-weight: 700;
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.desc {
  margin-top: 8px;
  font-size: 13.5px;
  color: var(--ink-2);
  line-height: 1.7;
  max-width: 72ch;
}

/* ===== 入口格 ===== */
.entry-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(158px, 1fr));
  gap: 12px;
  margin-bottom: 14px;
}
.entry-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  padding: 16px 16px 14px;
  text-align: left;
  cursor: pointer;
  background: var(--paper-raised);
  border: 1px solid var(--line);
  border-radius: var(--r);
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.entry-card:hover {
  border-color: var(--cyan);
}
.entry-card:focus-visible {
  outline: 2px solid var(--focus-cyan);
  outline-offset: 1px;
}
.entry-ico {
  width: 34px;
  height: 34px;
  border: 1px solid var(--line-2);
  border-radius: var(--r-xs);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--cyan);
  background: var(--cyan-wash);
  margin-bottom: 4px;
}
.entry-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--ink);
}
.entry-desc {
  font-size: var(--fs-meta);
  color: var(--ink-3);
}

/* ===== 双栏 ===== */
.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  scroll-margin-top: 76px; /* 锚点滚动别钻到顶栏底下 */
}
.card-body {
  padding: 14px 16px 16px;
}
.empty-tip {
  font-size: 13px;
  padding: 12px 2px;
}
.feature-list .row {
  font-size: 13px;
  color: var(--ink-2);
}
.fico {
  color: var(--pass-ink);
  display: inline-flex;
  flex: none;
}

/* 开发计划 */
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
  border: 1px solid var(--line);
  border-radius: var(--r-xs);
  background: var(--paper);
  font-size: 13px;
}
.plan-phase {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--ink);
  font-weight: 500;
}
.plan-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--cyan);
  flex: none;
}
.plan-tasks {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  padding-left: 15px;
}
.plan-task-tag {
  padding: 2px 8px;
  border: 1px solid var(--line);
  border-radius: var(--r-xs);
  background: var(--paper-deep);
  font-size: 11px;
  color: var(--ink-2);
}

/* ===== 操作 ===== */
.actions {
  display: flex;
  gap: 12px;
  margin-top: 18px;
}

@media (max-width: 860px) {
  .grid-2 {
    grid-template-columns: 1fr;
  }
}
</style>
