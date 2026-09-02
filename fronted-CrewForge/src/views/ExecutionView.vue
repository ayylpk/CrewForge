<template>
  <div class="exec">
    <!-- 顶栏 -->
    <header class="topbar">
      <button class="btn-back" @click="router.push(`/projects/${route.params.id}`)">← 返回</button>
      <div class="topbar-title">
        <span class="dim">{{ projectName }} ·</span>
        <span>执行面板</span>
        <span class="phase-badge">{{ currentPhase || '准备中' }}</span>
      </div>
      <div class="topbar-right">
        <!-- 暂停/继续随假引擎退役（施工卡 1-4）：真执行无剧本，引擎侧控制=确认门（阶段 3） -->
        <button v-if="done" class="btn-save" @click="viewOverview">查看项目</button>
      </div>
    </header>

    <div class="body">
      <!-- ===== 活动栏（VS Code 风格） ===== -->
      <div class="activity-bar">
        <button
          class="activity-item"
          :class="{ active: leftOpen && activeView === 'files' }"
          title="资源管理器（文件树）"
          @click="leftOpen && activeView === 'files' ? (leftOpen = false) : (activeView = 'files', leftOpen = true)"
        >
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 7v11a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2z" />
          </svg>
        </button>
        <button
          class="activity-item"
          :class="{ active: leftOpen && activeView === 'chat' }"
          title="与项目经理对话"
          @click="leftOpen && activeView === 'chat' ? (leftOpen = false) : (activeView = 'chat', leftOpen = true)"
        >
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
          </svg>
          <span v-if="chatUnread" class="activity-badge"></span>
        </button>
        <button
          class="activity-item"
          :class="{ active: rightOpen }"
          title="任务看板"
          @click="rightOpen = !rightOpen"
        >
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="7" height="7" />
            <rect x="14" y="3" width="7" height="7" />
            <rect x="3" y="14" width="7" height="7" />
            <rect x="14" y="14" width="7" height="7" />
          </svg>
        </button>
        <button
          class="activity-item"
          :class="{ active: logOpen }"
          title="执行日志"
          @click="logOpen = !logOpen"
        >
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
          </svg>
        </button>
      </div>

      <!-- ===== 左侧边栏（文件树 / 对话） ===== -->
      <aside v-if="leftOpen" class="sidebar" :style="{ width: sidebarWidth + 'px' }">
        <!-- 文件树视图 -->
        <template v-if="activeView === 'files'">
          <div class="side-head">
            <span>项目文件</span>
            <span class="side-count">{{ fileCount }} 个</span>
          </div>
          <div class="side-scroll">
            <FileTree :nodes="fileTree" :selected="activeFile?.path" @select="openFile" />
          </div>
        </template>

        <!-- 对话视图（与项目经理） -->
        <template v-else>
          <div class="side-head">
            <span>项目经理</span>
            <span class="side-count">执行中随时提问</span>
          </div>
          <!-- 确认模式选择器 -->
          <div class="mode-selector">
            <div class="mode-label">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 6v6l4 2" />
              </svg>
              确认模式
            </div>
            <div class="mode-options">
              <button
                v-for="m in MODES" :key="m.value"
                class="mode-btn"
                :class="{ active: confirmMode === m.value }"
                :title="m.desc"
                @click="setMode(m.value)"
              >
                <span class="mode-dot" :style="{ background: m.color }"></span>
                {{ m.label }}
              </button>
            </div>
            <div class="mode-hint">{{ MODES[confirmMode]?.desc }}</div>
          </div>
          <div class="chat-body">
            <div v-for="(m, i) in chatMessages" :key="i" class="msg" :class="m.role">
              <div v-if="m.role === 'assistant'" class="msg-avatar">
                <img src="../assets/agent-manager.png" alt="Hina" />
              </div>
              <div class="msg-bubble">{{ m.content }}</div>
            </div>
            <div v-if="chatThinking" class="msg assistant">
              <div class="msg-avatar">
                <img src="../assets/agent-manager.png" alt="Hina" />
              </div>
              <div class="msg-bubble typing">
                <span class="dot"></span>
                <span class="dot"></span>
                <span class="dot"></span>
              </div>
            </div>
          </div>
          <div class="chat-input">
            <textarea
              v-model="chatDraft"
              rows="2"
              placeholder="问项目经理：进度、代码、下一步..."
              @keydown.enter.exact.prevent="sendChat"
            ></textarea>
            <button class="btn-send" :disabled="!chatDraft.trim() || chatThinking" @click="sendChat">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M22 2 11 13" />
                <path d="M22 2 15 22l-4-9-9-4z" />
              </svg>
            </button>
          </div>
        </template>
      </aside>

      <!-- 左侧边栏拖拽手柄 -->
      <div
        v-if="leftOpen"
        class="resize-handle v"
        title="拖拽调整宽度"
        @mousedown="startDrag($event, 'x', 'left')"
      ></div>

      <!-- ===== 编辑器（多 Tab） ===== -->
      <div class="editor-area">
        <div v-if="tabs.length" class="tabs">
          <div
            v-for="t in tabs"
            :key="t.path"
            class="tab"
            :class="{ active: activeFile?.path === t.path }"
            @click="activeFile = t"
          >
            <span class="tab-icon" :style="{ color: tabColor(t.path) }">
              <svg v-html="tabIcon(t.path)" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></svg>
            </span>
            <span class="tab-name">{{ tabName(t.path) }}</span>
            <span v-if="t.userModified" class="tab-modified">●</span>
            <button class="tab-close" @click.stop="closeTab(t.path)">✕</button>
          </div>
        </div>
        <div class="editor-wrap">
          <MonacoEditor
            v-if="activeFile"
            :key="activeFile.path + ':' + (activeFile.userModified ? 'm' : '')"
            :language="langFor(activeFile.path)"
            :value="activeFile.content || ''"
            @change="onUserEdit"
            @save="onSave"
          />
          <div v-else class="editor-empty">
            <svg viewBox="0 0 24 24" width="42" height="42" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="16 18 22 12 16 6" />
              <polyline points="8 6 2 12 8 18" />
            </svg>
            <p>从左侧文件树打开文件</p>
            <p class="dim">Agent 生成的文件会实时出现在文件树中</p>
          </div>
        </div>
      </div>

      <!-- 右侧边栏拖拽手柄 -->
      <div
        v-if="rightOpen"
        class="resize-handle v"
        title="拖拽调整宽度"
        @mousedown="startDrag($event, 'x', 'right')"
      ></div>

      <!-- ===== 右侧边栏（任务看板） ===== -->
      <aside v-if="rightOpen" class="rightbar" :style="{ width: rightbarWidth + 'px' }">
        <div class="side-head">
          <span>任务看板</span>
          <span class="side-count">{{ tasks.length }} 个任务</span>
        </div>
        <div class="kanban">
          <div class="kanban-col">
            <div class="kanban-col-head" @click="toggleCol('todo')">
              <span class="kanban-dot todo"></span>
              <span>待办</span>
              <span class="kanban-count">{{ taskCount('todo') }}</span>
              <span class="kanban-arrow" :class="{ collapsed: collapsedCols.has('todo') }">▾</span>
            </div>
            <div v-show="!collapsedCols.has('todo')" class="kanban-list">
              <div v-for="t in tasksBy('todo')" :key="t.id" class="kanban-card" @click="openTaskDetail(t)">
                <span class="kanban-title">{{ t.title }}</span>
                <span class="kanban-assignee">{{ t.assignee }}</span>
              </div>
            </div>
          </div>
          <div class="kanban-col">
            <div class="kanban-col-head" @click="toggleCol('doing')">
              <span class="kanban-dot doing"></span>
              <span>执行中</span>
              <span class="kanban-count">{{ taskCount('doing') }}</span>
              <span class="kanban-arrow" :class="{ collapsed: collapsedCols.has('doing') }">▾</span>
            </div>
            <div v-show="!collapsedCols.has('doing')" class="kanban-list">
              <div v-for="t in tasksBy('doing')" :key="t.id" class="kanban-card doing" @click="openTaskDetail(t)">
                <span class="kanban-title">{{ t.title }}</span>
                <span class="kanban-assignee">{{ t.assignee }}</span>
              </div>
            </div>
          </div>
          <div class="kanban-col">
            <div class="kanban-col-head" @click="toggleCol('done')">
              <span class="kanban-dot done"></span>
              <span>已完成</span>
              <span class="kanban-count">{{ taskCount('done') }}</span>
              <span class="kanban-arrow" :class="{ collapsed: collapsedCols.has('done') }">▾</span>
            </div>
            <div v-show="!collapsedCols.has('done')" class="kanban-list">
              <div v-for="t in tasksBy('done')" :key="t.id" class="kanban-card done" @click="openTaskDetail(t)">
                <span class="kanban-title">{{ t.title }}</span>
                <span class="kanban-assignee">{{ t.assignee }}</span>
              </div>
            </div>
          </div>
          <div class="kanban-col">
            <div class="kanban-col-head" @click="toggleCol('failed')">
              <span class="kanban-dot failed"></span>
              <span>失败</span>
              <span class="kanban-count">{{ taskCount('failed') }}</span>
              <span class="kanban-arrow" :class="{ collapsed: collapsedCols.has('failed') }">▾</span>
            </div>
            <div v-show="!collapsedCols.has('failed')" class="kanban-list">
              <div v-for="t in tasksBy('failed')" :key="t.id" class="kanban-card failed" @click="openTaskDetail(t)">
                <span class="kanban-title">{{ t.title }}</span>
                <span class="kanban-assignee">{{ t.assignee }}</span>
                <button class="kanban-retry" title="重跑" @click.stop="retryTask(t)">↻</button>
              </div>
            </div>
          </div>
        </div>
      </aside>

      <!-- ===== 任务详情弹窗 ===== -->
      <div v-if="taskDetail" class="modal-mask" @click.self="taskDetail = null">
        <div class="modal task-detail-modal">
          <div class="modal-head">
            <h2>{{ taskDetail.title }}</h2>
            <button class="modal-close" @click="taskDetail = null">✕</button>
          </div>
          <div class="modal-body">
            <div class="detail-grid">
              <div class="detail-field">
                <span class="detail-label">任务编号</span>
                <span class="detail-value">{{ taskDetail.taskIdExt || taskDetail.id }}</span>
              </div>
              <div class="detail-field">
                <span class="detail-label">状态</span>
                <span class="detail-value" :style="{ color: STATUS_COLOR[taskDetail.status] }">{{ STATUS_LABEL[taskDetail.status] }}</span>
              </div>
              <div class="detail-field">
                <span class="detail-label">负责人</span>
                <span class="detail-value">{{ taskDetail.assignee || '-' }}</span>
              </div>
              <div class="detail-field">
                <span class="detail-label">分层</span>
                <span class="detail-value">{{ taskDetail.layer === 'backend' ? '后端' : taskDetail.layer === 'frontend' ? '前端' : '-' }}</span>
              </div>
              <div class="detail-field" v-if="taskDetail.phaseId">
                <span class="detail-label">阶段 ID</span>
                <span class="detail-value">{{ taskDetail.phaseId }}</span>
              </div>
              <div class="detail-field" v-if="taskDetail.retryCount > 0">
                <span class="detail-label">重试次数</span>
                <span class="detail-value" style="color: var(--yellow)">{{ taskDetail.retryCount }}/3</span>
              </div>
            </div>

            <div class="detail-section" v-if="taskDetail.description">
              <span class="detail-label">描述</span>
              <p class="detail-text">{{ taskDetail.description }}</p>
            </div>

            <div class="detail-section" v-if="taskDetail.acceptance">
              <span class="detail-label">验收标准</span>
              <p class="detail-text">{{ taskDetail.acceptance }}</p>
            </div>

            <div class="detail-section" v-if="taskDetail.result">
              <span class="detail-label">执行结果</span>
              <p class="detail-text result">{{ taskDetail.result }}</p>
            </div>

            <div class="detail-section" v-if="taskDetail.errorMsg">
              <span class="detail-label" style="color: var(--red)">失败原因</span>
              <p class="detail-text error">{{ taskDetail.errorMsg }}</p>
            </div>
          </div>
          <div class="modal-actions">
            <button class="btn-cancel" @click="taskDetail = null">关闭</button>
            <button v-if="taskDetail.status === 'failed'" class="btn-retry" @click="retryTask(taskDetail); taskDetail = null">↻ 重跑</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ===== 底部日志面板 ===== -->
    <div v-if="logOpen" class="log-resize-wrap">
      <div
        class="resize-handle h"
        title="拖拽调整高度"
        @mousedown="startDrag($event, 'y', 'log')"
      ></div>
      <div class="log-panel" :style="{ height: logHeight + 'px' }">
      <div class="log-head">
        <span class="log-title">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
          </svg>
          执行日志
        </span>
        <button class="log-clear" @click="logs = []">清空</button>
      </div>
      <div ref="logBody" class="log-scroll">
        <div v-for="(l, i) in logs" :key="i" class="log-item">
          <span class="log-time">{{ l.time }}</span>
          <span class="log-agent" :style="{ color: agentColor(l.agentId) }">[{{ l.agent }}]</span>
          <span class="log-text">{{ l.text }}</span>
        </div>
      </div>
      </div>
    </div>

  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, nextTick, reactive } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import FileTree from '../components/FileTree.vue'
import MonacoEditor from '../components/MonacoEditor.vue'
import { AGENT_NAMES } from '../constants/agents'
import { fetchProjectFiles, fetchProjectFileDetail } from '../api/projectFile'
import type { FileNode, projectFileVO } from '../types/file'
import { useExecutionStore } from '../stores/execution'
import { fetchTasks, retryTask as apiRetryTask } from '../api/task'
import type { TaskItem as ApiTaskItem, TaskStatus } from '../api/task'

const router = useRouter()
const route = useRoute()
const projectName = ref('项目 #' + route.params.id)
const execStore = useExecutionStore()
const confirmMode = ref(execStore.confirmMode)

/** 确认模式常量 */
const MODES = [
  { value: 0, label: '全绿灯', color: '#5ecb8a', desc: 'Agent 自动执行，无需人工确认' },
  { value: 1, label: '混合', color: '#f2b840', desc: '关键步骤（如换阶段）需人工确认' },
  { value: 2, label: '手动', color: '#f070a0', desc: '每阶段计划都需人工确认' },
] as const

function setMode(mode: 0 | 1 | 2) {
  confirmMode.value = mode
  execStore.setConfirmMode(mode)
}

// ===== 布局状态（VS Code 风格） =====
const activeView = ref<'files' | 'chat'>('files') // 左侧边栏内容
const leftOpen = ref(true) // 左侧边栏
const rightOpen = ref(false) // 右侧边栏（任务看板）
const logOpen = ref(false) // 底部日志面板


// ===== 面板尺寸（支持拖拽拉伸） =====
const sidebarWidth = ref(280)
const rightbarWidth = ref(250)
const logHeight = ref(180)

/**
 * 拖拽调整面板大小（直接在模板中传入事件对象）
 * @param e      鼠标事件
 * @param axis   拖拽方向
 * @param target 目标面板
 */
function startDrag(e: MouseEvent, axis: 'x' | 'y', target: 'left' | 'right' | 'log') {
  e.preventDefault()
  const startPos = axis === 'x' ? e.clientX : e.clientY
  const startSize =
    target === 'left' ? sidebarWidth.value
    : target === 'right' ? rightbarWidth.value
    : logHeight.value

  function onMove(ev: MouseEvent) {
    const delta = (axis === 'x' ? ev.clientX : ev.clientY) - startPos
    if (target === 'left') {
      sidebarWidth.value = Math.min(Math.max(startSize + delta, 180), 500)
    } else if (target === 'right') {
      rightbarWidth.value = Math.min(Math.max(startSize - delta, 180), 500)
    } else {
      logHeight.value = Math.min(Math.max(startSize - delta, 100), 420)
    }
  }
  function onUp() {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
  document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize'
  document.body.style.userSelect = 'none'
}

// ===== 任务看板 =====
const tasks = ref<ApiTaskItem[]>([])

/** 收起的列（默认已完成收起来） */
const collapsedCols = reactive(new Set<TaskStatus>(['done']))

/** 任务详情弹窗 */
const taskDetail = ref<ApiTaskItem | null>(null)
function openTaskDetail(t: ApiTaskItem) {
  taskDetail.value = t
}

const STATUS_COLOR: Record<TaskStatus, string> = {
  todo: '#8890a8',
  doing: '#45b8ff',
  done: '#5ecb8a',
  failed: '#f26060',
}
const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: '待办',
  doing: '执行中',
  done: '已完成',
  failed: '失败',
}

function toggleCol(status: TaskStatus) {
  if (collapsedCols.has(status)) collapsedCols.delete(status)
  else collapsedCols.add(status)
}

function taskCount(status: TaskStatus): number {
  return tasks.value.filter((t) => t.status === status).length
}
function tasksBy(status: TaskStatus): ApiTaskItem[] {
  return tasks.value.filter((t) => t.status === status)
}
/** 重跑：调后端（todo 复位 + retry_count+1），乐观更新，pollTasks 校准；引擎在阶段边界消费返工 */
async function retryTask(t: ApiTaskItem) {
  try {
    await apiRetryTask(t.id)
    t.status = 'todo'
    t.retryCount += 1
    pushLog({ time: '', agentId: 0, agent: '系统', text: `任务 ${t.taskIdExt || t.id}「${t.title}」已重新排队（第 ${t.retryCount} 次，引擎于阶段边界重新派发）` })
  } catch (e) {
    pushLog({ time: '', agentId: 0, agent: '系统', text: `重跑失败：${(e as Error).message || e}` })
  }
}

/** 上次轮询的任务状态快照：diff 出真事件进日志流（替代假时间线播放器） */
const lastStatus = new Map<number, TaskStatus>()

/** 10s 轮询——看板唯一数据源=sys_task（施工卡 1-4：mock 已撤，一切以库里为准） */
async function pollTasks() {
  const projectId = Number(route.params.id)
  if (!projectId) return
  let list: ApiTaskItem[] | null = null
  try {
    list = await fetchTasks(projectId)
  } catch {
    return // 后端未就绪时静默，保留已有数据
  }
  if (!list) return
  // 1. 状态变化 → 日志真事件（谁在动这块卡片一目了然）
  for (const t of list) {
    if (lastStatus.get(t.id) !== t.status) {
      const who = t.status === 'failed' ? 5 : t.status === 'done' ? 6 : t.layer === 'frontend' ? 4 : 3
      const line = t.status === 'failed'
        ? `任务 ${t.taskIdExt || t.id}「${t.title}」失败：${(t.errorMsg || '未记录原因').split('\n')[0].slice(0, 60)}`
        : `任务 ${t.taskIdExt || t.id}「${t.title}」${STATUS_LABEL[t.status]}`
      pushLog({ time: '', agentId: who, agent: '', text: line })
      lastStatus.set(t.id, t.status)
    }
  }
  tasks.value = list
  // 2. 顶栏真状态：进度=done/total；阶段=在办任务最小编号；全部终态=已收敛
  const total = list.length
  const doneCount = list.filter((t) => t.status === 'done').length
  overallProgress.value = total ? Math.round((doneCount / total) * 100) : 0
  const doing = list.filter((t) => t.status === 'doing')
  if (doing.length) currentPhase.value = `阶段 ${doing.reduce((m, t) => Math.min(m, t.phaseId ?? 99), 99)}`
  else if (list.some((t) => t.status === 'todo')) currentPhase.value = '待派发'
  else if (total) currentPhase.value = '已收敛'
  else currentPhase.value = ''
  done.value = total > 0 && list.every((t) => t.status === 'done' || t.status === 'failed')
}

/** Agent 日志颜色 */
function agentColor(id: number): string {
  return ['#f070a0', '#a76bff', '#5ecb8a', '#f0c060', '#5ec8c0'][id - 1] || '#8890a8'
}

// ===== 文件树 + 多 Tab 编辑器（持久化到 localStorage） =====
const FILE_STORAGE_KEY = `cf_files_${route.params.id}`

const fileTree = ref<FileNode[]>([])
const tabs = ref<FileNode[]>([])
const activeFile = ref<FileNode | null>(null)
const fileCount = computed(() => countFiles(fileTree.value))

/** 保存文件树（查看代码随时可恢复） */
function persistFiles() {
  try {
    localStorage.setItem(FILE_STORAGE_KEY, JSON.stringify(fileTree.value))
  } catch {
    /* 内容过大时忽略 */
  }
}

/** 恢复文件树 */
function restoreFiles(): boolean {
  try {
    const saved = localStorage.getItem(FILE_STORAGE_KEY)
    if (saved) {
      fileTree.value = JSON.parse(saved)
      return true
    }
  } catch {
    /* 损坏忽略 */
  }
  return false
}

function countFiles(nodes: FileNode[]): number {
  return nodes.reduce((sum, n) => sum + (n.type === 'file' ? 1 : countFiles(n.children || [])), 0)
}

/** 打开文件 → 加入 Tab（VS Code 行为）；落库文件无内容时异步拉详情 */
async function openFile(node: FileNode) {
  if (!tabs.value.find((t) => t.path === node.path)) {
    tabs.value.push(node)
  }
  activeFile.value = node
  if (node.id && !node.content) {
    try {
      const vo = await fetchProjectFileDetail(node.id)
      node.content = vo.fileContent ?? ''
      node.userModified = !!vo.userModified
    } catch {
      /* 拦截器已提示 */
    }
  }
}

/** 从数据库加载文件树（sys_project_file）：目录优先展开、文件按路径排序 */
async function loadFromDb(): Promise<boolean> {
  try {
    const list = await fetchProjectFiles(Number(route.params.id))
    if (!list || list.length === 0) return false
    fileTree.value = buildTreeFromVO(list)
    return true
  } catch {
    return false
  }
}

/** VO 列表 → 目录树（复用 insertFile 的建目录逻辑，批量版；目录默认展开） */
function buildTreeFromVO(list: projectFileVO[]): FileNode[] {
  const root: FileNode[] = []
  const sorted = [...list].sort((a, b) => a.filePath.localeCompare(b.filePath))
  for (const vo of sorted) {
    const parts = vo.filePath.split('/')
    const fileName = parts.pop()!
    let level = root
    let curPath = ''
    for (const part of parts) {
      curPath += (curPath ? '/' : '') + part
      let dir = level.find((n) => n.type === 'dir' && n.name === part)
      if (!dir) {
        dir = { name: part, type: 'dir', path: curPath, open: true, children: [] }
        level.push(dir)
      }
      if (!dir.children) dir.children = []
      level = dir.children
    }
    level.push({
      id: vo.id,
      name: fileName,
      type: 'file',
      path: vo.filePath,
      content: '', // 详情点开再拉，列表不含大字段
      userModified: !!vo.userModified,
    })
  }
  return root
}

function closeTab(path: string) {
  const idx = tabs.value.findIndex((t) => t.path === path)
  if (idx < 0) return
  tabs.value.splice(idx, 1)
  if (activeFile.value?.path === path) {
    activeFile.value = tabs.value[idx] || tabs.value[idx - 1] || null
  }
}

/** Tab 显示：最后一段路径 */
function tabName(path: string): string {
  return path.split('/').pop() || path
}

const FILE_TAB_META: Record<string, { color: string; icon: string }> = {
  java: { color: '#f09050', icon: '<path d="M4 6h16v12H4z"/><path d="M9 10h6M9 14h4"/>' },
  vue: { color: '#5ecb8a', icon: '<path d="M3 5l9 14 9-14z"/><polyline points="8.5 5 12 10.5 15.5 5"/>' },
  ts: { color: '#45b8ff', icon: '<path d="M4 6h16v12H4z"/><path d="M14 10v6M14 13h3"/><path d="M9.5 10v5M7.5 10h4"/>' },
  yml: { color: '#f0c060', icon: '<path d="M4 6h16v12H4z"/><circle cx="8" cy="10" r="1"/><circle cx="8" cy="14" r="1"/><line x1="12" y1="10" x2="17" y2="10"/><line x1="12" y1="14" x2="17" y2="14"/>' },
  md: { color: '#8890a8', icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>' },
}
const DEFAULT_TAB = { color: '#8890a8', icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>' }

function tabIcon(path: string) {
  const ext = path.split('.').pop()?.toLowerCase() || ''
  return FILE_TAB_META[ext] || DEFAULT_TAB
}
function tabColor(path: string) {
  return tabIcon(path).color
}

function langFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || ''
  const map: Record<string, string> = {
    java: 'java', vue: 'html', ts: 'typescript', js: 'javascript',
    yml: 'yaml', yaml: 'yaml', json: 'json', xml: 'xml', sql: 'sql', md: 'markdown', css: 'css',
  }
  return map[ext] || 'plaintext'
}

function onUserEdit() {
  if (activeFile.value && !activeFile.value.userModified) {
    activeFile.value.userModified = true
  }
}
function onSave() {
  if (activeFile.value) {
    activeFile.value.userModified = true
  }
}

// ===== 与项目经理对话（侧边栏） =====
interface ChatMsg {
  role: 'user' | 'assistant'
  content: string
}

const chatMessages = ref<ChatMsg[]>([
  {
    role: 'assistant',
    content: '我是项目经理 Hina。执行过程中有任何问题（进度、代码、下一步）都可以问我。',
  },
])
const chatDraft = ref('')
const chatThinking = ref(false)
const chatUnread = ref(false)

function chatReply(text: string): string {
  if (/进度|到哪|阶段|多久/.test(text)) {
    return `当前处于${currentPhase.value || '初始阶段'}，整体进度 ${overallProgress.value}%。${taskCount('done')}/${tasks.value.length} 个任务已完成。`
  }
  if (/这个文件|为什么.*写|代码/.test(text)) {
    return '后端按架构师输出的 JSON spec 生成标准 Spring Boot 分层：Controller（接口层）→ Service（业务层）→ Mapper（数据层），前端对应 views + api 封装。'
  }
  if (/暂停|停|继续|恢复/.test(text)) {
    return '真执行没有暂停按钮——引擎按阶段自动推进；要中止请用顶栏返回后在项目详情停止运行（阶段 2 接入）。'
  }
  if (/下一步|接下来|后面/.test(text)) {
    const next = currentPhase.value
    return next ? `当前阶段完成后，会进入：${next} 之后的集成测试与部署交付。` : '即将进入执行阶段。'
  }
  return '收到。执行在正常推进中，有具体问题（进度、代码、调整）随时问我。'
}

function sendChat() {
  const text = chatDraft.value.trim()
  if (!text || chatThinking.value) return
  chatMessages.value.push({ role: 'user', content: text })
  chatDraft.value = ''
  chatThinking.value = true
  setTimeout(() => {
    chatMessages.value.push({ role: 'assistant', content: chatReply(text) })
    chatThinking.value = false
    chatUnread.value = true
  }, 700)
}

// ===== 执行视图状态（真数据：日志=轮询差分，顶栏状态=pollTasks 计算） =====
const logs = ref<{ time: string; agentId: number; agent: string; text: string }[]>([])
const logBody = ref<HTMLElement | null>(null)
const currentPhase = ref('')
const overallProgress = ref(0)
const done = ref(false)

const pollTimer = ref<ReturnType<typeof setInterval> | null>(null)

function pushLog(e: { time: string; agentId: number; agent: string; text: string }) {
  logs.value.push({
    time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    agentId: e.agentId,
    agent: AGENT_NAMES[e.agentId]?.name || '系统',
    text: e.text,
  })
  nextTick(() => {
    if (logBody.value) {
      logBody.value.scrollTop = logBody.value.scrollHeight
    }
  })
}

onMounted(async () => {
  // 看板唯一数据源=sys_task 轮询（假卡片/假时间线已随施工卡 1-4 撤除）
  await pollTasks()
  // 文件优先从数据库加载（agent 落库 sys_project_file），本地草稿兜底；任务状态只信 pollTasks
  if (!(await loadFromDb())) restoreFiles()
  // 10s 轮询：文件 + 任务（引擎在跑就有新状态）
  pollTimer.value = setInterval(() => {
    pollFiles()
    pollTasks()
  }, 10000)
})

onBeforeUnmount(() => {
  if (pollTimer.value) clearInterval(pollTimer.value)
})

function viewOverview() {
  router.push({ name: 'project-detail', params: { id: String(route.params.id) } })
}

// ===== 10s 轮询：文件列表 + 当前 Tab（Agent 修改后自动刷新） =====

/** 保存当前目录展开状态 */
function saveOpenPaths(nodes: FileNode[]): Set<string> {
  const paths = new Set<string>()
  function walk(list: FileNode[]) {
    for (const n of list) {
      if (n.type === 'dir') {
        if (n.open) paths.add(n.path)
        if (n.children) walk(n.children)
      }
    }
  }
  walk(nodes)
  return paths
}

/** 恢复目录展开状态 */
function restoreOpenPaths(nodes: FileNode[], openPaths: Set<string>) {
  for (const n of nodes) {
    if (n.type === 'dir') {
      if (openPaths.has(n.path)) n.open = true
      if (n.children) restoreOpenPaths(n.children, openPaths)
    }
  }
}

/** 轮询：刷新文件树 + 当前 Tab 内容（用户修改的不覆盖） */
async function pollFiles() {
  const projectId = Number(route.params.id)
  if (!projectId) return
  try {
    // 保存展开 → 重建树 → 恢复展开（避免目录折叠）
    const openPaths = saveOpenPaths(fileTree.value)
    const list = await fetchProjectFiles(projectId)
    if (list && list.length > 0) {
      fileTree.value = buildTreeFromVO(list)
      restoreOpenPaths(fileTree.value, openPaths)
      persistFiles()
    }

    // 轮询当前 Tab：非用户修改的文件自动更新内容
    if (activeFile.value && activeFile.value.id && !activeFile.value.userModified) {
      const vo = await fetchProjectFileDetail(activeFile.value.id)
      if (vo.fileContent && vo.fileContent !== activeFile.value.content) {
        activeFile.value.content = vo.fileContent
        // 同步更新 tabs 数组中对应 tab 的内容
        const tab = tabs.value.find(t => t.path === activeFile.value?.path)
        if (tab) tab.content = vo.fileContent
      }
    }
  } catch {
    // 静默失败，下次轮询继续
  }
}
</script>

<style scoped>
.exec {
  position: relative;
  z-index: 1;
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* ===== 顶栏 ===== */
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 48px;
  height: 52px;
  border-bottom: 1px solid var(--border);
  background: rgba(15, 19, 31, 0.9);
  backdrop-filter: blur(12px);
  flex-shrink: 0;
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
.btn-back:hover {
  border-color: var(--border2);
  color: var(--text);
}
.topbar-title {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 14px;
  font-weight: 600;
}
.dim {
  color: var(--text3);
  font-weight: 400;
}
.phase-badge {
  padding: 3px 10px;
  border-radius: 10px;
  background: rgba(69, 184, 255, 0.1);
  border: 1px solid rgba(69, 184, 255, 0.25);
  color: var(--blue);
  font-size: 11.5px;
  font-weight: 500;
}
.topbar-right {
  display: flex;
  align-items: center;
  gap: 12px;
}
.btn-pause {
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
.btn-pause:hover {
  border-color: var(--yellow);
  color: var(--yellow);
}
.btn-pause.paused {
  border-color: var(--green);
  color: var(--green);
}
.btn-save {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 36px;
  padding: 0 20px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--grad1);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity var(--dur) var(--ease);
}
.btn-save:hover {
  opacity: 0.9;
}

/* ===== 主体 ===== */
.body {
  flex: 1;
  display: flex;
  min-height: 0;
}

/* ===== 活动栏 ===== */
.activity-bar {
  width: 46px;
  background: var(--bg2);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 0;
  gap: 4px;
  flex-shrink: 0;
}
.activity-item {
  position: relative;
  width: 38px;
  height: 38px;
  border: none;
  border-left: 2px solid transparent;
  background: transparent;
  color: var(--text3);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
}
.activity-item:hover {
  color: var(--text);
}
.activity-item.active {
  color: var(--blue);
  border-left-color: var(--blue);
  background: rgba(69, 184, 255, 0.06);
}
.activity-badge {
  position: absolute;
  top: 6px;
  right: 5px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--pink);
}

/* ===== 拖拽手柄（点击区 10px，视觉线 2px 居中） ===== */
.resize-handle {
  position: relative;
  z-index: 30;
  background: transparent;
  display: flex;
  align-items: center;
  justify-content: center;
}
.resize-handle.v {
  width: 10px;
  cursor: col-resize;
  flex-shrink: 0;
}
.resize-handle.h {
  height: 10px;
  cursor: row-resize;
  flex-shrink: 0;
}
.resize-handle.v::after {
  content: '';
  width: 2px;
  height: 100%;
  border-radius: 1px;
  background: transparent;
  transition: background 0.15s;
}
.resize-handle.h::after {
  content: '';
  height: 2px;
  width: 100%;
  border-radius: 1px;
  background: transparent;
  transition: background 0.15s;
}
.resize-handle:hover::after,
.resize-handle:active::after {
  background: rgba(69, 184, 255, 0.6);
}

/* ===== 侧边栏 ===== */
.sidebar {
  background: var(--bg2);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  min-width: 0;
  animation: side-in 0.2s var(--ease);
}
@keyframes side-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
.side-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
  font-size: 12.5px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text2);
}
.side-count {
  font-size: 11px;
  color: var(--text3);
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
}

/* ===== 确认模式选择器（PM 对话区） ===== */
.mode-selector {
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.mode-label {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text3);
  margin-bottom: 8px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.mode-options {
  display: flex;
  gap: 4px;
  margin-bottom: 6px;
}
.mode-btn {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 5px 0;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg3);
  color: var(--text2);
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
}
.mode-btn:hover {
  border-color: var(--border2);
  color: var(--text);
}
.mode-btn.active {
  border-color: var(--blue);
  color: var(--blue);
  background: rgba(69, 184, 255, 0.06);
}
.mode-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}
.mode-hint {
  font-size: 10.5px;
  color: var(--text3);
  line-height: 1.5;
  padding-left: 2px;
}

.side-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 8px 6px;
}

/* ===== 对话（侧边栏内） ===== */
.chat-body {
  flex: 1;
  overflow-y: auto;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.msg {
  display: flex;
  gap: 8px;
  max-width: 95%;
}
.msg.user {
  align-self: flex-end;
  flex-direction: row-reverse;
}
.msg-avatar {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  overflow: hidden;
  flex-shrink: 0;
  background: var(--bg3);
  border: 1px solid var(--border);
}
.msg-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.msg-bubble {
  padding: 9px 12px;
  border-radius: 10px;
  font-size: 12.5px;
  line-height: 1.7;
  white-space: pre-line;
  word-break: break-word;
}
.msg.assistant .msg-bubble {
  background: var(--bg3);
  border: 1px solid var(--border);
  color: var(--text);
  border-top-left-radius: 3px;
}
.msg.user .msg-bubble {
  background: var(--grad1);
  color: #fff;
  border-top-right-radius: 3px;
}
.typing {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 12px 14px;
}
.typing .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text3);
  animation: blink 1.4s infinite;
}
.typing .dot:nth-child(2) { animation-delay: 0.2s; }
.typing .dot:nth-child(3) { animation-delay: 0.4s; }
@keyframes blink {
  0%, 80%, 100% { opacity: 0.25; }
  40% { opacity: 1; }
}
.chat-input {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 10px;
  border-top: 1px solid var(--border);
}
.chat-input textarea {
  flex: 1;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg3);
  color: var(--text);
  font-size: 12.5px;
  line-height: 1.5;
  outline: none;
  resize: none;
  font-family: inherit;
  transition: border-color 0.2s;
}
.chat-input textarea:focus {
  border-color: var(--blue);
}
.chat-input textarea::placeholder {
  color: var(--text3);
}
.btn-send {
  width: 34px;
  height: 34px;
  border: none;
  border-radius: 8px;
  background: var(--grad1);
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: opacity 0.2s;
  flex-shrink: 0;
}
.btn-send:hover:not(:disabled) { opacity: 0.9; }
.btn-send:disabled { opacity: 0.4; cursor: not-allowed; }

/* ===== 编辑器区 ===== */
.editor-area {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: #1e1e1e;
}
.tabs {
  display: flex;
  background: var(--bg2);
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
  flex-shrink: 0;
}
.tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px 8px 12px;
  border-right: 1px solid var(--border);
  font-size: 12.5px;
  color: var(--text2);
  cursor: pointer;
  white-space: nowrap;
  position: relative;
  transition: background 0.15s;
}
.tab:hover {
  background: var(--bg3);
}
.tab.active {
  background: #1e1e1e;
  color: var(--text);
}
.tab-modified {
  color: var(--blue);
  font-size: 8px;
}
.tab-close {
  border: none;
  background: transparent;
  color: var(--text3);
  font-size: 10px;
  cursor: pointer;
  padding: 2px;
  border-radius: 4px;
  opacity: 0;
  transition: all 0.15s;
}
.tab:hover .tab-close {
  opacity: 1;
}
.tab-close:hover {
  background: rgba(242, 96, 96, 0.15);
  color: var(--red);
}
.editor-wrap {
  flex: 1;
  min-height: 0;
}
.editor-empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text3);
  font-size: 13px;
  background: #1e1e1e;
}
.editor-empty svg { opacity: 0.35; }
.editor-empty .dim { font-size: 12px; }

/* ===== 右侧边栏 ===== */
.rightbar {
  background: var(--bg2);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  min-width: 0;
  animation: right-in 0.2s var(--ease);
}
@keyframes right-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

/* ===== 任务看板 ===== */
.kanban {
  flex: 1;
  overflow-y: auto;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.kanban-col {
  background: var(--bg3);
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
}
.kanban-col-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  font-weight: 600;
  color: var(--text2);
  cursor: pointer;
  user-select: none;
  transition: background 0.15s;
}
.kanban-col-head:hover {
  background: rgba(69, 184, 255, 0.04);
}
.kanban-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.kanban-dot.todo { background: var(--text3); }
.kanban-dot.doing { background: var(--blue); }
.kanban-dot.done { background: var(--green); }
.kanban-dot.failed { background: var(--red); }
.kanban-count {
  margin-left: auto;
  font-size: 11px;
  color: var(--text3);
  font-weight: 400;
}
.kanban-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px;
}
.kanban-card {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 8px;
  border-radius: 7px;
  background: var(--bg2);
  border: 1px solid var(--border);
  font-size: 12px;
  transition: all 0.15s;
}
.kanban-card.doing {
  border-color: rgba(69, 184, 255, 0.35);
  background: rgba(69, 184, 255, 0.06);
}
.kanban-card.done {
  border-color: rgba(94, 203, 138, 0.25);
  opacity: 0.7;
}
.kanban-card.failed {
  border-color: rgba(242, 96, 96, 0.35);
  background: rgba(242, 96, 96, 0.06);
}
.kanban-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kanban-assignee {
  font-size: 10px;
  color: var(--text3);
  flex-shrink: 0;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--bg3);
}
.kanban-retry {
  border: none;
  background: transparent;
  color: var(--red);
  cursor: pointer;
  font-size: 14px;
  padding: 0 2px;
  line-height: 1;
}
.kanban-retry:hover {
  color: #ff8080;
}
.kanban-arrow {
  font-size: 10px;
  transition: transform 0.2s;
  margin-left: auto;
}
.kanban-arrow.collapsed {
  transform: rotate(-90deg);
}

/* ===== 任务详情弹窗 ===== */
.task-detail-modal {
  width: 480px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
}
.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 16px;
}
.modal-head h2 {
  font-size: 16px;
  font-weight: 700;
  margin: 0;
}
.modal-close {
  border: none;
  background: transparent;
  color: var(--text3);
  font-size: 16px;
  cursor: pointer;
  padding: 4px;
}
.modal-close:hover {
  color: var(--text);
}
.modal-body {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.detail-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.detail-field {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--bg3);
  border: 1px solid var(--border);
}
.detail-label {
  font-size: 11px;
  color: var(--text3);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.detail-value {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.detail-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.detail-section .detail-label {
  font-size: 11px;
  text-transform: uppercase;
}
.detail-text {
  font-size: 13px;
  line-height: 1.7;
  color: var(--text2);
  margin: 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--bg3);
  border: 1px solid var(--border);
  white-space: pre-wrap;
  word-break: break-word;
}
.detail-text.result {
  border-color: rgba(94, 203, 138, 0.25);
}
.detail-text.error {
  border-color: rgba(242, 96, 96, 0.3);
  color: var(--red);
}
.btn-retry {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 18px;
  height: 36px;
  border-radius: 8px;
  border: 1px solid var(--red);
  background: rgba(242, 96, 96, 0.1);
  color: var(--red);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}
.btn-retry:hover {
  background: rgba(242, 96, 96, 0.2);
}

/* ===== 弹窗遮罩 + 通用 modal（与项目其他页面一致） ===== */
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
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 24px;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 18px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}
.btn-cancel {
  padding: 0 18px;
  height: 36px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text2);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
}
.btn-cancel:hover {
  border-color: var(--border2);
  color: var(--text);
}

/* ===== 底部日志面板 ===== */
.log-resize-wrap {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  animation: log-in 0.2s var(--ease);
}
@keyframes log-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
.log-panel {
  background: var(--bg2);
  border-top: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  overflow: hidden;
}
.log-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
}
.log-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text2);
}
.log-clear {
  border: none;
  background: transparent;
  color: var(--text3);
  font-size: 11px;
  cursor: pointer;
}
.log-clear:hover { color: var(--text); }
.log-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 8px 14px;
  font-family: 'Consolas', monospace;
  font-size: 11.5px;
  line-height: 1.9;
}
.log-item {
  display: flex;
  gap: 8px;
}
.log-time { color: var(--text3); flex-shrink: 0; }
.log-agent { flex-shrink: 0; }
.log-text { color: var(--text2); word-break: break-all; }

</style>
