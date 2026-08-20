<template>
  <div class="exec">
    <!-- 顶栏 -->
    <header class="topbar">
      <button class="btn-back" @click="router.push('/projects')">← 项目列表</button>
      <div class="topbar-title">
        <span class="dim">{{ projectName }} ·</span>
        <span>执行面板</span>
        <span class="phase-badge">{{ currentPhase || '准备中' }}</span>
      </div>
      <div class="topbar-right">
        <button v-if="!done" class="btn-pause" :class="{ paused }" @click="togglePause">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <template v-if="!paused">
              <rect x="6" y="4" width="4" height="16" />
              <rect x="14" y="4" width="4" height="16" />
            </template>
            <template v-else>
              <polygon points="5 3 19 12 5 21 5 3" />
            </template>
          </svg>
          {{ paused ? '恢复' : '暂停' }}
        </button>
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
          title="Agent 状态"
          @click="rightOpen = !rightOpen"
        >
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="8" r="4" />
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
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

      <!-- ===== 右侧边栏（Agent 状态） ===== -->
      <aside v-if="rightOpen" class="rightbar" :style="{ width: rightbarWidth + 'px' }">
        <div class="side-head">
          <span>Agent 团队</span>
          <span class="side-count">{{ doneCount }}/{{ agentStates.length }} 完成</span>
        </div>
        <div class="right-scroll">
          <div
            v-for="a in agentStates"
            :key="a.id"
            class="agent-row"
            :class="a.status"
          >
            <div class="agent-avatar">
              <img :src="avatarSrc(a.avatar)" :alt="a.name" />
              <span class="agent-dot" :class="a.status"></span>
            </div>
            <div class="agent-info">
              <span class="agent-name">{{ a.name }}</span>
              <span class="agent-task">{{ a.status === 'working' ? a.task || '执行中...' : STATUS_LABEL[a.status] }}</span>
            </div>
          </div>
        </div>
      </aside>
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
import { EXEC_TIMELINE, AGENT_NAMES } from '../mocks/execution'
import type { ExecEvent } from '../mocks/execution'
import { fetchProjectFiles, fetchProjectFileDetail } from '../api/projectFile'
import type { FileNode, projectFileVO } from '../types/file'

const router = useRouter()
const route = useRoute()
const projectName = ref('项目 #' + route.params.id)

// ===== 布局状态（VS Code 风格） =====
const activeView = ref<'files' | 'chat'>('files') // 左侧边栏内容
const leftOpen = ref(true) // 左侧边栏
const rightOpen = ref(false) // 右侧边栏（Agent 状态）
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

// ===== Agent 状态 =====
type AgentStatus = 'idle' | 'working' | 'done'
const STATUS_LABEL: Record<AgentStatus, string> = {
  idle: '等待中',
  working: '执行中',
  done: '已完成',
}

interface AgentState {
  id: number
  name: string
  avatar: string
  status: AgentStatus
  task: string
}

const agentStates = reactive<AgentState[]>(
  [1, 2, 3, 4, 5].map((id) => ({
    id,
    name: AGENT_NAMES[id].name,
    avatar: AGENT_NAMES[id].avatar,
    status: 'idle' as AgentStatus,
    task: '',
  }))
)

const doneCount = computed(() => agentStates.filter((a) => a.status === 'done').length)

function avatarSrc(name: string) {
  return new URL(`../assets/${name}`, import.meta.url).href
}
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

/** 按路径插入文件（自动建目录） */
function insertFile(path: string, content: string) {
  const parts = path.split('/')
  const fileName = parts.pop()!
  let level = fileTree.value
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
  const exists = level.find((n) => n.path === path)
  if (exists) {
    exists.content = content
    exists.isNew = false
    return exists
  }
  const node: FileNode = { name: fileName, type: 'file', path, content, isNew: true }
  level.push(node)
  setTimeout(() => {
    node.isNew = false
  }, 2000)
  persistFiles()
  return node
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
    return `当前处于${currentPhase.value || '初始阶段'}，整体进度 ${overallProgress.value}%。${doneCount.value}/${agentStates.length} 个 Agent 已完成任务。`
  }
  if (/这个文件|为什么.*写|代码/.test(text)) {
    return '后端按架构师输出的 JSON spec 生成标准 Spring Boot 分层：Controller（接口层）→ Service（业务层）→ Mapper（数据层），前端对应 views + api 封装。'
  }
  if (/暂停|停|继续|恢复/.test(text)) {
    return paused.value ? '已恢复执行，Agent 团队继续干活。' : '好的，Agent 完成当前任务后会暂停，随时可以恢复。'
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

// ===== 执行引擎（mock 时间线） =====
const logs = ref<{ time: string; agentId: number; agent: string; text: string }[]>([])
const logBody = ref<HTMLElement | null>(null)
const currentPhase = ref('')
const overallProgress = ref(0)
const paused = ref(false)
const done = ref(false)

let eventIdx = 0
let timer: ReturnType<typeof setTimeout> | null = null
let startedAt = 0

function pushLog(e: ExecEvent) {
  logs.value.push({
    time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    agentId: e.agentId,
    agent: AGENT_NAMES[e.agentId]?.name || '系统',
    text: e.log,
  })
  nextTick(() => {
    if (logBody.value) {
      logBody.value.scrollTop = logBody.value.scrollHeight
    }
  })
}

function schedule() {
  if (paused.value || done.value) return
  const now = performance.now() - startedAt
  while (eventIdx < EXEC_TIMELINE.length && EXEC_TIMELINE[eventIdx].at <= now) {
    fire(EXEC_TIMELINE[eventIdx])
    eventIdx++
  }
  if (eventIdx >= EXEC_TIMELINE.length) {
    done.value = true
    return
  }
  timer = setTimeout(schedule, 100)
}

function fire(e: ExecEvent) {
  const agent = agentStates.find((a) => a.id === e.agentId)
  if (agent) {
    agent.status = e.status
    if (e.task) agent.task = e.task
  }
  if (e.phase) currentPhase.value = e.phase
  if (e.phaseProgress != null) overallProgress.value = e.phaseProgress
  if (e.file) {
    const node = insertFile(e.file.path, e.file.content)
    openFile(node) // 新文件自动打开 Tab
  }
  pushLog(e)
  if (e.status === 'done' && e.task && /完成|交付/.test(e.task)) {
    agentStates.forEach((a) => {
      if (a.id !== e.agentId) a.status = 'done'
    })
  }
}

function togglePause() {
  paused.value = !paused.value
  if (!paused.value && !done.value) {
    startedAt = performance.now() - (eventIdx ? EXEC_TIMELINE[eventIdx].at : 0)
    timer = setTimeout(schedule, 100)
  }
}

onMounted(async () => {
  // 优先从数据库加载真实文件（agent 落库 sys_project_file）
  if (await loadFromDb()) {
    done.value = true
    currentPhase.value = '已完成'
    overallProgress.value = 100
    agentStates.forEach((a) => {
      a.status = 'done'
      a.task = ''
    })
    return
  }
  // 数据库无文件 → 兜底：本地缓存恢复，否则 mock 时间线演示执行
  if (restoreFiles()) {
    done.value = true
    currentPhase.value = '已完成'
    overallProgress.value = 100
    agentStates.forEach((a) => {
      a.status = 'done'
      a.task = ''
    })
    return
  }
  startedAt = performance.now()
  timer = setTimeout(schedule, 100)
})

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})

function viewOverview() {
  router.push({ name: 'project-detail', params: { id: String(route.params.id) } })
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
.right-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.agent-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg3);
  transition: all 0.2s;
}
.agent-row.working {
  border-color: rgba(69, 184, 255, 0.4);
}
.agent-row.done {
  border-color: rgba(94, 203, 138, 0.25);
}
.agent-avatar {
  position: relative;
  width: 30px;
  height: 30px;
  border-radius: 9px;
  overflow: hidden;
  flex-shrink: 0;
  border: 1px solid var(--border);
}
.agent-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.agent-dot {
  position: absolute;
  right: -1px;
  bottom: -1px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  border: 2px solid var(--bg3);
}
.agent-dot.idle { background: var(--text3); }
.agent-dot.working { background: var(--blue); animation: pulse 1.2s infinite; }
.agent-dot.done { background: var(--green); }
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
.agent-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.agent-name {
  font-size: 12.5px;
  font-weight: 600;
}
.agent-task {
  font-size: 11px;
  color: var(--text3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.agent-row.working .agent-task { color: var(--blue); }
.agent-row.done .agent-task { color: var(--green); }

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
