<script setup lang="ts">
/* ============================================================
   执行面板（/projects/:id/execution）= 车间现场
   ------------------------------------------------------------
   世界观：这里 = 晒图室的车间。左列"图夹"（活动栏走深蓝晒图纸底），
   中为"看图台"（文件树 + 多 Tab 描图台），右为"工单板"（看板），
   底部"运行记录"（日志=轮询差分）。确认门 = 会签待审卡。
   逻辑与旧版逐字保留：看板唯一数据源=sys_task（10s 轮询），
   模式落后端 confirm_mode，文件懒加载详情，草稿持久化 cf_files_{id}。
   视觉移植的两处收敛：手绘 SVG 图标全部换 tabler 一族；
   tab 的文件类型小画片改成"扩展名字码片"（色值进章色 token）。
   ============================================================ */
import { ref, computed, onMounted, nextTick, reactive } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import {
  IconChevronDown,
  IconClock,
  IconCode,
  IconFolder,
  IconLayoutKanban,
  IconMessage,
  IconRefresh,
  IconSend,
  IconTerminal,
  IconX,
} from '@tabler/icons-vue'
import FileTree from '../components/FileTree.vue'
import MonacoEditor from '../components/MonacoEditor.vue'
import TopBar from '../components/ui/TopBar.vue'
import AppModal from '../components/ui/AppModal.vue'
import StampSeal from '../components/ui/StampSeal.vue'
import { AGENT_NAMES } from '../constants/agents'
import { MODE_META, MODE_NUM_TO_STR, TASK_STATUS, nodeLabel, type StampTone } from '../constants/status'
import { fetchProjectFiles, fetchProjectFileDetail } from '../api/projectFile'
import type { FileNode, projectFileVO } from '../types/file'
import { useExecutionStore } from '../stores/execution'
import { fetchTasks, retryTask as apiRetryTask, summarizeTaskQuality } from '../api/task'
import type { TaskItem as ApiTaskItem, TaskStatus } from '../api/task'
import { fetchProjectById, updateProject } from '../api/project'
import { fetchPendingConfirms, parseOptions, type ConfirmQuestion } from '../api/confirm'
import { answerConfirm as answerConfirmApi } from '../api/confirm'
import { usePolling } from '../composables/usePolling'
import { toast } from '../utils/toast'

const router = useRouter()
const route = useRoute()
const projectName = ref('项目 #' + route.params.id)
const execStore = useExecutionStore()
const confirmMode = ref(execStore.confirmMode)

/** 确认模式常量（收口到 constants/status：label/desc 逐字即旧 MODES） */
const MODES = [0, 1, 2].map((n) => ({
  value: n as 0 | 1 | 2,
  ...MODE_META[MODE_NUM_TO_STR[n]],
}))

function setMode(mode: 0 | 1 | 2) {
  confirmMode.value = mode
  execStore.setConfirmMode(mode)
  // 阶段 3：模式落后端 sys_project.confirm_mode（引擎开工时读它决定 Cli/Http 分流）——
  // 只存 localStorage 的话选择器就是装饰，Web 上切了引擎也看不见
  const strMode = MODE_NUM_TO_STR[mode]
  updateProject(Number(route.params.id), { confirmMode: strMode } as never).catch(() => {
    /* 保存失败提示由拦截器统一弹；本地态保留，用户可重试 */
  })
}

// ===== 确认门问答卡（阶段 3）：pending 题轮询弹卡，答复即续跑 =====
const pendingConfirms = ref<ConfirmQuestion[]>([])
const confirmText = ref('')
const confirmBusy = ref(false)

async function pollConfirms() {
  try {
    pendingConfirms.value = await fetchPendingConfirms(Number(route.params.id))
  } catch {
    /* 后端未就绪等：本轮不弹卡，下轮 10s 再试（卡是增强不是控制，永不拦看板） */
  }
}

async function submitConfirm(answer: string) {
  if (confirmBusy.value || !pendingConfirms.value.length) return
  confirmBusy.value = true
  try {
    await answerConfirmApi(pendingConfirms.value[0].id, answer)
    toast.success('已答复，引擎几秒内续跑')
    confirmText.value = ''
    await pollConfirms()
  } finally {
    confirmBusy.value = false
  }
}

/** 超时放行倒计时提示（惰性：每轮轮询刷新，不做秒级动画） */
function confirmCountdown(expireAt: string | null): string {
  if (!expireAt) return ''
  const min = Math.max(0, Math.round((new Date(expireAt).getTime() - Date.now()) / 60000))
  return min > 0 ? `${min} 分钟无人应答将自动放行` : '即将自动放行'
}

// ===== 布局状态（活动栏三席） =====
const activeView = ref<'files' | 'chat'>('files') // 左侧边栏内容
// 窄屏（≤860px 侧栏变浮层，挡着看图台）默认收抽屉——车间图纸桌先给屏幕，点图夹脊可开
const leftOpen = ref(!window.matchMedia('(max-width: 860px)').matches) // 左侧边栏
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
const qualitySummary = computed(() => summarizeTaskQuality(tasks.value))

/** 收起的列（默认完工收起来） */
const collapsedCols = reactive(new Set<TaskStatus>(['done']))

/** 任务详情弹窗 */
const taskDetail = ref<ApiTaskItem | null>(null)
function openTaskDetail(t: ApiTaskItem) {
  taskDetail.value = t
}

function taskTone(status: TaskStatus): StampTone {
  return TASK_STATUS[status]?.tone || 'pencil'
}
function taskStatusLabel(status: TaskStatus): string {
  return TASK_STATUS[status]?.label || status
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
        : `任务 ${t.taskIdExt || t.id}「${t.title}」${taskStatusLabel(t.status)}`
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

/** 日志里 Agent 名号的颜色：一席一章色（旧版是五串手写 hex，现在走章色 token 类名） */
function agentClass(id: number): string {
  const cls = ['', 'ag-1', 'ag-2', 'ag-3', 'ag-4', 'ag-5', 'ag-6']
  return cls[id] || 'ag-sys'
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

/** 扩展名 → 章色（旧 FILE_TAB_META 的手绘小图标换成字码片：色随章色走） */
const EXT_TONE: Record<string, string> = {
  java: 'rust',
  vue: 'pass',
  ts: 'info',
  js: 'info',
  yml: 'wait',
  yaml: 'wait',
  md: 'pencil',
}
function tabExt(path: string): string {
  return path.split('.').pop()?.toLowerCase() || ''
}
function extToneClass(path: string): string {
  return 'ext-' + (EXT_TONE[tabExt(path)] || 'pencil')
}

function langFor(path: string): string {
  const ext = tabExt(path)
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

const { start: startPolling } = usePolling(() => {
  pollFiles()
  pollTasks()
  pollConfirms()
}, 10000)

onMounted(async () => {
  // 看板唯一数据源=sys_task 轮询（假卡片/假时间线已随施工卡 1-4 撤除）
  await pollTasks()
  void pollConfirms() // 确认门首拉：进页面就答，不等 10s（阶段 3）
  // 回填真项目名 + 库中确认模式（阶段 3：模式以 sys_project.confirm_mode 为真相，本地只是即时态）
  fetchProjectById(Number(route.params.id))
    .then((p) => {
      projectName.value = p.name
      if (p.confirmMode === 0 || p.confirmMode === 1 || p.confirmMode === 2) {
        confirmMode.value = p.confirmMode
        execStore.setConfirmMode(p.confirmMode)
      }
    })
    .catch(() => {
      /* 详情拉不到不拦面板主流程 */
    })
  // 文件优先从数据库加载（agent 落库 sys_project_file），本地草稿兜底；任务状态只信 pollTasks
  if (!(await loadFromDb())) restoreFiles()
  // 10s 轮询：文件 + 任务 + 待答问题（引擎在跑就有新状态）
  startPolling()
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
        const tab = tabs.value.find((t) => t.path === activeFile.value?.path)
        if (tab) tab.content = vo.fileContent
      }
    }
  } catch {
    // 静默失败，下次轮询继续
  }
}
</script>

<template>
  <div class="exec">
    <!-- 顶栏 -->
    <TopBar class="exec-top">
      <template #context>
        <button class="tb-back btn btn-sm btn-ghost" @click="router.push(`/projects/${route.params.id}`)">← 返回</button>
        <span class="tb-title">
          <span class="dim">{{ projectName }} ·</span>
          <span>执行面板</span>
        </span>
        <StampSeal :label="currentPhase || '准备中'" tone="info" />
      </template>
      <template #right>
        <div class="quality-strip" title="基于当前已进入终态的任务统计">
          <span class="q-label faint">质量</span>
          <strong>{{ qualitySummary.firstPassRate }}%</strong>
          <span class="q-muted">首次通过 · {{ qualitySummary.evaluated }} 个终态任务</span>
          <span v-if="qualitySummary.totalRetries" class="q-retry">
            <IconRefresh :size="13" :stroke-width="1.75" /> {{ qualitySummary.totalRetries }}
          </span>
        </div>
        <!-- 暂停/继续随假引擎退役（施工卡 1-4）：真执行无剧本，引擎侧控制=确认门（阶段 3） -->
        <button v-if="done" class="btn btn-primary btn-sm" @click="viewOverview">查看项目</button>
      </template>
    </TopBar>

    <div class="body">
      <!-- ===== 活动栏（图夹脊） ===== -->
      <nav class="activity-bar" aria-label="面板切换">
        <button
          class="activity-item"
          :class="{ active: leftOpen && activeView === 'files' }"
          title="资源管理器（文件树）"
          @click="leftOpen && activeView === 'files' ? (leftOpen = false) : ((activeView = 'files'), (leftOpen = true))"
        >
          <IconFolder :size="21" :stroke-width="1.75" />
        </button>
        <button
          class="activity-item"
          :class="{ active: leftOpen && activeView === 'chat' }"
          title="与项目经理对话"
          @click="leftOpen && activeView === 'chat' ? (leftOpen = false) : ((activeView = 'chat'), (leftOpen = true))"
        >
          <IconMessage :size="21" :stroke-width="1.75" />
          <span v-if="chatUnread" class="activity-badge"></span>
        </button>
        <button
          class="activity-item"
          :class="{ active: rightOpen }"
          title="任务看板"
          @click="rightOpen = !rightOpen"
        >
          <IconLayoutKanban :size="21" :stroke-width="1.75" />
        </button>
        <button
          class="activity-item"
          :class="{ active: logOpen }"
          title="执行日志"
          @click="logOpen = !logOpen"
        >
          <IconTerminal :size="21" :stroke-width="1.75" />
        </button>
        <!-- 收口进度：车间总闸（done/total 角标） -->
        <span class="ab-progress mono" title="完工任务 / 全部">{{ overallProgress }}%</span>
      </nav>

      <!-- ===== 左侧边栏（文件树 / 对话） ===== -->
      <aside v-if="leftOpen" class="sidebar" :style="{ width: sidebarWidth + 'px' }">
        <!-- 文件树视图 -->
        <template v-if="activeView === 'files'">
          <div class="side-head">
            <span>项目文件</span>
            <span class="side-count">{{ fileCount }} 个</span>
          </div>
          <div class="side-scroll">
            <FileTree :nodes="fileTree" :active-path="activeFile?.path" @open="openFile" />
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
              <IconClock :size="13" :stroke-width="1.75" />
              确认模式
            </div>
            <div class="mode-options">
              <button
                v-for="m in MODES"
                :key="m.value"
                class="mode-btn"
                :class="{ active: confirmMode === m.value }"
                :title="m.desc"
                @click="setMode(m.value)"
              >
                <span class="lamp" :class="'lamp-' + m.tone"></span>
                {{ m.label }}
              </button>
            </div>
            <div class="mode-hint faint">{{ MODES[confirmMode]?.desc }}</div>
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
                <span class="tdot"></span>
                <span class="tdot"></span>
                <span class="tdot"></span>
              </div>
            </div>
          </div>
          <div class="chat-input">
            <textarea
              v-model="chatDraft"
              class="textarea"
              rows="2"
              placeholder="问项目经理：进度、代码、下一步..."
              @keydown.enter.exact.prevent="sendChat"
            ></textarea>
            <button class="btn btn-primary btn-send" :disabled="!chatDraft.trim() || chatThinking" @click="sendChat">
              <IconSend :size="15" :stroke-width="1.75" />
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

      <!-- ===== 编辑器（多 Tab 描图台） ===== -->
      <div class="editor-area">
        <div v-if="tabs.length" class="tabs">
          <div
            v-for="t in tabs"
            :key="t.path"
            class="tab"
            :class="{ active: activeFile?.path === t.path }"
            @click="activeFile = t"
          >
            <span class="tab-ext mono" :class="extToneClass(t.path)">{{ tabExt(t.path) }}</span>
            <span class="tab-name">{{ tabName(t.path) }}</span>
            <span v-if="t.userModified" class="tab-modified" title="已手动修改"></span>
            <button class="tab-close" aria-label="关闭" @click.stop="closeTab(t.path)">
              <IconX :size="12" :stroke-width="1.75" />
            </button>
          </div>
        </div>
        <div class="editor-wrap">
          <!-- key 只含 path：曾把 userModified 编进 key（9/15 审计坑 F4），
               用户敲第一字符→0变1→key 变→编辑器销毁重建，首字符被吞、光标/撤销栈重置。
               注意：注释必须放标签外——塞进属性区会打断 Vue 模板解析（9/16 vue-tsc 实锤） -->
          <MonacoEditor
            v-if="activeFile"
            :key="activeFile.path"
            :language="langFor(activeFile.path)"
            :value="activeFile.content || ''"
            @change="onUserEdit"
            @save="onSave"
          />
          <div v-else class="editor-empty">
            <IconCode :size="42" :stroke-width="1.2" class="ee-ico" />
            <p>从左侧文件树打开文件</p>
            <p class="faint">Agent 生成的文件会实时出现在文件树中</p>
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

      <!-- ===== 右侧边栏（任务工单板） ===== -->
      <aside v-if="rightOpen" class="rightbar" :style="{ width: rightbarWidth + 'px' }">
        <div class="side-head">
          <span>任务看板</span>
          <span class="side-count">{{ tasks.length }} 个任务</span>
        </div>
        <div class="quality-card">
          <div class="qc-head"><span>产出质量</span><strong>{{ qualitySummary.firstPassRate }}%</strong></div>
          <div class="qc-meta">通过 {{ qualitySummary.passed }} · 失败 {{ qualitySummary.failed }} · 重试 {{ qualitySummary.totalRetries }}</div>
          <div v-if="qualitySummary.failureCategories.length" class="qc-failures">
            <span v-for="item in qualitySummary.failureCategories.slice(0, 3)" :key="item.label" class="mono">
              {{ item.label }} {{ item.count }}
            </span>
          </div>
        </div>
        <div class="kanban">
          <div v-for="col in (['todo', 'doing', 'done', 'failed'] as TaskStatus[])" :key="col" class="kanban-col">
            <div class="kanban-col-head" @click="toggleCol(col)">
              <span class="kb-dot" :class="'dot-' + TASK_STATUS[col].tone"></span>
              <span>{{ TASK_STATUS[col].label }}</span>
              <span class="kanban-count mono">{{ taskCount(col) }}</span>
              <IconChevronDown
                :size="14"
                :stroke-width="1.75"
                class="kb-arrow"
                :class="{ collapsed: collapsedCols.has(col) }"
              />
            </div>
            <div v-show="!collapsedCols.has(col)" class="kanban-list">
              <div
                v-for="t in tasksBy(col)"
                :key="t.id"
                class="kanban-card"
                :class="col"
                @click="openTaskDetail(t)"
              >
                <span class="kanban-title">{{ t.title }}</span>
                <span class="kanban-assignee faint">{{ t.assignee }}</span>
                <button
                  v-if="col === 'failed'"
                  class="kanban-retry"
                  title="重跑"
                  @click.stop="retryTask(t)"
                >
                  <IconRefresh :size="13" :stroke-width="1.75" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </aside>

      <!-- ===== 任务详情弹窗 ===== -->
      <AppModal
        v-if="taskDetail"
        :title="taskDetail.title"
        sheet="TASK·DETAIL"
        width="640px"
        @close="taskDetail = null"
      >
        <div class="detail-grid tblock">
          <div class="tblock-cell">
            <span class="tblock-key">任务编号</span>
            <span class="tblock-val mono">{{ taskDetail.taskIdExt || taskDetail.id }}</span>
          </div>
          <div class="tblock-cell">
            <span class="tblock-key">状态</span>
            <span class="tblock-val">
              <StampSeal :label="taskStatusLabel(taskDetail.status)" :tone="taskTone(taskDetail.status)" />
            </span>
          </div>
          <div class="tblock-cell">
            <span class="tblock-key">负责人</span>
            <span class="tblock-val">{{ taskDetail.assignee || '-' }}</span>
          </div>
          <div class="tblock-cell">
            <span class="tblock-key">分层</span>
            <span class="tblock-val">{{ taskDetail.layer === 'backend' ? '后端' : taskDetail.layer === 'frontend' ? '前端' : '-' }}</span>
          </div>
          <div v-if="taskDetail.phaseId" class="tblock-cell">
            <span class="tblock-key">阶段 ID</span>
            <span class="tblock-val mono">{{ taskDetail.phaseId }}</span>
          </div>
          <div v-if="taskDetail.retryCount > 0" class="tblock-cell">
            <span class="tblock-key">重试次数</span>
            <span class="tblock-val mono wait-txt">{{ taskDetail.retryCount }}/3</span>
          </div>
        </div>

        <div v-if="taskDetail.description" class="detail-section">
          <span class="ds-label faint">描述</span>
          <p class="detail-text">{{ taskDetail.description }}</p>
        </div>
        <div v-if="taskDetail.acceptance" class="detail-section">
          <span class="ds-label faint">验收标准</span>
          <p class="detail-text">{{ taskDetail.acceptance }}</p>
        </div>
        <div v-if="taskDetail.result" class="detail-section">
          <span class="ds-label faint">执行结果</span>
          <p class="detail-text result mono">{{ taskDetail.result }}</p>
        </div>
        <div v-if="taskDetail.errorMsg" class="detail-section">
          <span class="ds-label err">失败原因</span>
          <p class="detail-text error">{{ taskDetail.errorMsg }}</p>
        </div>

        <template #footer>
          <button class="btn btn-sm" @click="taskDetail = null">关闭</button>
          <button
            v-if="taskDetail.status === 'failed'"
            class="btn btn-sm btn-primary"
            @click="retryTask(taskDetail); taskDetail = null"
          >
            <IconRefresh :size="14" :stroke-width="1.75" /> 重跑
          </button>
        </template>
      </AppModal>
    </div>

    <!-- ===== 底部日志面板（运行记录） ===== -->
    <div v-if="logOpen" class="log-resize-wrap">
      <div class="resize-handle h" title="拖拽调整高度" @mousedown="startDrag($event, 'y', 'log')"></div>
      <div class="log-panel" :style="{ height: logHeight + 'px' }">
        <div class="log-head">
          <span class="log-title">
            <IconTerminal :size="12" :stroke-width="1.75" />
            执行日志
          </span>
          <button class="log-clear btn btn-sm btn-ghost" @click="logs = []">清空</button>
        </div>
        <div ref="logBody" class="log-scroll">
          <div v-for="(l, i) in logs" :key="i" class="log-item">
            <span class="log-time mono faint">{{ l.time }}</span>
            <span class="log-agent mono" :class="agentClass(l.agentId)">[{{ l.agent }}]</span>
            <span class="log-text">{{ l.text }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- ===== 确认门就地问答卡（阶段 3：引擎挂起等人拍板，答复后自动续跑） ===== -->
    <Teleport to="body">
      <div v-if="pendingConfirms.length" class="confirm-mask">
        <div class="confirm-card panel sheet-fall">
          <div class="confirm-head">
            <StampSeal :label="nodeLabel(pendingConfirms[0].node)" tone="wait" :just="true" />
            <span class="confirm-expire mono faint">{{ confirmCountdown(pendingConfirms[0].expireAt) }}</span>
          </div>
          <p class="confirm-question">{{ pendingConfirms[0].question }}</p>
          <!-- 有选项=选择题（点一下即答），无选项=自由文本题（PM 追问走这里） -->
          <div v-if="parseOptions(pendingConfirms[0]).length" class="confirm-opts">
            <button
              v-for="opt in parseOptions(pendingConfirms[0])"
              :key="opt"
              class="btn confirm-opt"
              :disabled="confirmBusy"
              @click="submitConfirm(opt)"
            >
              {{ opt }}
            </button>
          </div>
          <div v-else class="confirm-free">
            <input
              v-model="confirmText"
              class="input"
              type="text"
              placeholder="输入回复…"
              :disabled="confirmBusy"
              @keyup.enter="confirmText.trim() && submitConfirm(confirmText.trim())"
            />
            <button class="btn btn-primary" :disabled="confirmBusy || !confirmText.trim()" @click="submitConfirm(confirmText.trim())">
              发送
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* ===== 车间骨架：顶栏 + 活动栏/侧栏/看图台/工单板 + 底部运行记录 ===== */
.exec {
  position: relative;
  z-index: 1;
  height: 100dvh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.exec-top {
  flex: none;
  padding-inline: clamp(14px, 3vw, 42px);
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
.quality-strip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: var(--fs-meta);
  color: var(--ink-2);
  white-space: nowrap;
}
.quality-strip strong {
  font-family: var(--font-display);
  font-size: 15px;
  color: var(--ink);
  font-variant-numeric: tabular-nums;
}
.q-label {
  font-weight: 600;
}
.q-muted {
  color: var(--ink-3);
}
.q-retry {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--rust);
}

.body {
  flex: 1;
  display: flex;
  min-height: 0;
}

/* ===== 活动栏：深蓝晒图纸底 ===== */
.activity-bar {
  flex: none;
  width: 50px;
  background: var(--cyan-plate);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 0;
  gap: 4px;
}
.activity-item {
  position: relative;
  width: 38px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #7fa8c9;
  border-left: 2px solid transparent;
  transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.activity-item:hover {
  color: #dbe9f5;
}
.activity-item.active {
  color: #eaf3fa;
  background: rgba(243, 246, 248, 0.08);
  border-left-color: #9fc6e8;
}
.activity-badge {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--wait);
  border: 1px solid var(--cyan-plate);
}
.ab-progress {
  margin-top: auto;
  padding: 6px 0 4px;
  font-size: 10px;
  color: #7fa8c9;
  font-variant-numeric: tabular-nums;
}

/* ===== 侧栏公共 ===== */
.sidebar,
.rightbar {
  flex: none;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--paper-raised);
  border-right: 1px solid var(--line-2);
  overflow: hidden;
}
.rightbar {
  border-right: none;
  border-left: 1px solid var(--line-2);
}
.side-head {
  flex: none;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--line);
  font-family: var(--font-display);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-2);
}
.side-count {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 400;
  letter-spacing: 0;
  color: var(--ink-3);
}
.side-scroll {
  flex: 1;
  overflow: auto;
}

/* ===== 确认模式 ===== */
.mode-selector {
  flex: none;
  padding: 10px 12px;
  border-bottom: 1px dashed var(--line-2);
}
.mode-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--fs-meta);
  font-weight: 600;
  color: var(--ink-2);
  margin-bottom: 8px;
}
.mode-options {
  display: flex;
  gap: 4px;
}
.mode-btn {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 6px 4px;
  border: 1px solid var(--line-2);
  border-radius: var(--r-xs);
  background: var(--paper);
  font-size: var(--fs-meta);
  color: var(--ink-2);
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.mode-btn:hover {
  border-color: var(--cyan);
}
.mode-btn.active {
  border-color: var(--cyan);
  background: var(--cyan-wash-2);
  color: var(--cyan);
  font-weight: 600;
}
.mode-btn .lamp {
  width: 8px;
  height: 8px;
}
.mode-hint {
  margin-top: 7px;
  font-size: 11px;
  line-height: 1.5;
}

/* ===== 侧栏对话 ===== */
.chat-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.msg {
  display: flex;
  gap: 8px;
  align-items: flex-start;
}
.msg.user {
  justify-content: flex-end;
}
.msg-avatar {
  flex: none;
}
.msg-avatar img {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 1px solid var(--line-2);
  object-fit: cover;
  display: block;
}
.msg-bubble {
  max-width: 82%;
  padding: 8px 11px;
  border-radius: 2px 10px 10px 10px;
  background: var(--paper-deep);
  border: 1px solid var(--line);
  font-size: 13px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
}
.msg.user .msg-bubble {
  background: var(--cyan);
  border-color: var(--cyan);
  color: #f3f6f8;
  border-radius: 10px 2px 10px 10px;
}
.typing {
  display: flex;
  gap: 5px;
  padding: 12px;
}
.tdot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ink-3);
  animation: tdot 1.1s var(--ease) infinite;
}
.tdot:nth-child(2) {
  animation-delay: 0.15s;
}
.tdot:nth-child(3) {
  animation-delay: 0.3s;
}
@keyframes tdot {
  35% {
    transform: translateY(-4px);
    opacity: 0.5;
  }
}
.chat-input {
  flex: none;
  display: flex;
  gap: 6px;
  padding: 10px;
  border-top: 1px solid var(--line);
  align-items: flex-end;
}
.chat-input .textarea {
  flex: 1;
  min-height: 40px;
  max-height: 110px;
  font-size: 13px;
}
.btn-send {
  height: 40px;
  width: 40px;
  padding: 0;
  flex: none;
}

/* ===== 拖拽手柄 ===== */
.resize-handle {
  flex: none;
  background: transparent;
  transition: background var(--dur) var(--ease);
}
.resize-handle:hover,
.resize-handle:active {
  background: var(--cyan-wash-2);
}
.resize-handle.v {
  width: 5px;
  cursor: col-resize;
  margin: 0 -2px; /* 视觉不占位，热区 9px */
  z-index: 2;
}
.resize-handle.h {
  height: 5px;
  cursor: row-resize;
  margin: -2px 0;
  z-index: 2;
}

/* ===== 看图台 ===== */
.editor-area {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--paper);
}
.tabs {
  flex: none;
  display: flex;
  overflow-x: auto;
  border-bottom: 1px solid var(--line-2);
  background: var(--paper-deep);
}
.tab {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 8px 10px 8px 12px;
  border-right: 1px solid var(--line);
  font-size: 13px;
  color: var(--ink-2);
  cursor: pointer;
  white-space: nowrap;
  user-select: none;
}
.tab:hover {
  background: var(--cyan-wash);
}
.tab.active {
  background: var(--paper-raised);
  color: var(--ink);
  font-weight: 500;
  box-shadow: inset 0 2px 0 var(--cyan); /* 图签夹条 */
}
.tab-ext {
  font-size: 9px;
  line-height: 1;
  padding: 3px 4px;
  border: 1px solid currentColor;
  border-radius: var(--r-xs);
  opacity: 0.9;
}
.ext-rust {
  color: var(--rust);
}
.ext-pass {
  color: var(--pass-ink);
}
.ext-info {
  color: var(--cyan);
}
.ext-wait {
  color: var(--wait-ink);
}
.ext-pencil {
  color: var(--pencil);
}
.tab-modified {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  border: 1.5px solid var(--wait-ink);
  flex: none;
}
.tab-close {
  display: inline-flex;
  padding: 2px;
  border-radius: var(--r-xs);
  color: var(--ink-3);
}
.tab-close:hover {
  background: var(--void-wash);
  color: var(--void-ink);
}
.editor-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
}
.editor-wrap > :deep(div) {
  flex: 1;
  min-width: 0;
}
.editor-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--ink-2);
  font-size: 14px;
}
.ee-ico {
  color: var(--line-2);
}
.editor-empty .faint {
  font-size: var(--fs-meta);
}

/* ===== 工单板 ===== */
.quality-card {
  flex: none;
  margin: 10px 12px 4px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--paper);
}
.qc-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: var(--fs-meta);
  color: var(--ink-2);
}
.qc-head strong {
  font-family: var(--font-display);
  font-size: 18px;
  color: var(--ink);
  font-variant-numeric: tabular-nums;
}
.qc-meta {
  margin-top: 4px;
  font-size: 11px;
  color: var(--ink-3);
}
.qc-failures {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  margin-top: 7px;
  font-size: 10px;
  color: var(--void-ink);
}

.kanban {
  flex: 1;
  overflow-y: auto;
  padding: 6px 0 12px;
}
.kanban-col {
  margin-top: 6px;
}
.kanban-col-head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 12px;
  font-size: var(--fs-meta);
  font-weight: 600;
  color: var(--ink-2);
  cursor: pointer;
  user-select: none;
}
.kanban-col-head:hover {
  background: var(--cyan-wash);
}
.kb-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
}
.dot-pencil {
  background: var(--pencil);
}
.dot-info {
  background: var(--cyan);
}
.dot-pass {
  background: var(--pass);
}
.dot-void {
  background: var(--void);
}
.kanban-count {
  margin-left: auto;
  font-size: 10px;
  color: var(--ink-3);
  font-variant-numeric: tabular-nums;
}
.kb-arrow {
  color: var(--ink-3);
  transition: transform var(--dur) var(--ease);
}
.kb-arrow.collapsed {
  transform: rotate(-90deg);
}
.kanban-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 2px 8px;
}
.kanban-card {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border: 1px solid var(--line);
  border-left-width: 2px;
  border-radius: var(--r-xs);
  background: var(--paper-raised);
  cursor: pointer;
  transition: border-color var(--dur) var(--ease);
}
.kanban-card:hover {
  border-color: var(--cyan);
}
.kanban-card.todo {
  border-left-color: var(--pencil);
}
.kanban-card.doing {
  border-left-color: var(--cyan);
}
.kanban-card.done {
  border-left-color: var(--pass);
}
.kanban-card.failed {
  border-left-color: var(--void);
}
.kanban-title {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kanban-assignee {
  flex: none;
  font-size: 10px;
}
.kanban-retry {
  flex: none;
  display: inline-flex;
  padding: 3px;
  color: var(--void-ink);
  border-radius: var(--r-xs);
}
.kanban-retry:hover {
  background: var(--void-wash);
}

/* ===== 任务详情 ===== */
.detail-grid {
  margin-bottom: 14px;
}
.wait-txt {
  color: var(--wait-ink);
}
.detail-section {
  margin-top: 12px;
}
.ds-label {
  display: block;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin-bottom: 4px;
}
.ds-label.err {
  color: var(--void-ink);
}
.detail-text {
  font-size: 13px;
  line-height: 1.7;
  color: var(--ink);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 180px;
  overflow-y: auto;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: var(--r-xs);
  background: var(--paper);
}
.detail-text.result {
  font-size: 12px;
}
.detail-text.error {
  border-color: var(--void);
  background: var(--void-wash);
  color: var(--void-ink);
}

/* ===== 底部运行记录 ===== */
.log-resize-wrap {
  flex: none;
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--line-2);
  background: var(--paper-raised);
}
.log-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.log-head {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 14px;
  border-bottom: 1px solid var(--line);
}
.log-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: var(--font-display);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink-2);
}
.log-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 8px 14px;
  font-size: 12.5px;
  line-height: 1.8;
}
.log-item {
  display: flex;
  gap: 10px;
  align-items: baseline;
}
.log-time {
  flex: none;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.log-agent {
  flex: none;
  font-size: 11px;
}
.ag-1 {
  color: var(--cyan);
} /* 经理 */
.ag-2 {
  color: var(--rust);
} /* 架构师 */
.ag-3 {
  color: var(--pass-ink);
} /* 后端 */
.ag-4 {
  color: var(--wait-ink);
} /* 前端 */
.ag-5 {
  color: var(--void-ink);
} /* 测试 */
.ag-6 {
  color: var(--ink-2);
} /* 维护 */
.ag-sys {
  color: var(--pencil);
}
.log-text {
  min-width: 0;
  word-break: break-word;
  color: var(--ink);
}

/* ===== 确认门卡 ===== */
.confirm-mask {
  position: fixed;
  inset: 0;
  z-index: 1500;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(22, 34, 46, 0.4);
  backdrop-filter: blur(3px);
  padding: 20px;
}
.confirm-card {
  width: 100%;
  max-width: 520px;
  padding: 20px 22px;
}
.confirm-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.confirm-expire {
  font-size: 11px;
}
.confirm-question {
  font-size: 14.5px;
  line-height: 1.7;
  color: var(--ink);
  white-space: pre-wrap;
  word-break: break-word;
  margin-bottom: 16px;
}
.confirm-opts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.confirm-opt {
  min-width: 88px;
}
.confirm-free {
  display: flex;
  gap: 8px;
}
.confirm-free .input {
  flex: 1;
}

/* ===== 窄屏：侧栏浮起（能看文件就行） ===== */
@media (max-width: 860px) {
  .sidebar,
  .rightbar {
    position: absolute;
    top: 57px;
    bottom: 0;
    z-index: 40;
    box-shadow: var(--shadow-lg);
  }
  .sidebar {
    left: 50px;
  }
  .rightbar {
    right: 0;
  }
  .resize-handle {
    display: none;
  }
  .quality-strip .q-muted {
    display: none;
  }
}
/* 手机屏装不下质量指标条（flex:none 会把状态章挤出画幅——9/17 exec-mobile 实锤）；
   质量数据在右抽屉看板卡里仍有全量，顶栏让位 */
@media (max-width: 640px) {
  .quality-strip {
    display: none;
  }
  /* 图名让位——状态章必须完整在框内；页名"执行面板"本身已说明身在何处 */
  .tb-title .dim {
    display: none;
  }
}
</style>
