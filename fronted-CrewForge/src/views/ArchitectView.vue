<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { ElMessageBox } from 'element-plus'
import CardShell from '../components/CardShell.vue'
import GradientButton from '../components/GradientButton.vue'
import { fetchProjectById, updateProject } from '../api/project'

const router = useRouter()
const route = useRoute()

const projectName = ref('')

/** 后端 JSON 字符串字段解析（解析失败返回空数组） */
function parseArr(raw?: string | null): unknown[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

onMounted(async () => {
  const id = Number(route.params.id)
  if (!id) return
  try {
    const p = await fetchProjectById(id)
    projectName.value = p.name
    // 回显已保存的方案（确认方案提交过才有数据）
    techStack.value = (parseArr(p.techStack) as unknown[]).filter((x): x is string => typeof x === 'string')
    phases.value = parseArr(p.devPlan) as { name: string; progress: number; tasks: string[] }[]
    dirTree.value = restoreTree(parseArr(p.dirTree) as DirNode[])
  } catch {
    projectName.value = '项目 #' + route.params.id
  }
})

// ===== 技术选型（气泡式：AI 预设 + 增删） =====

/** 技术分类 */
type TechCategory = 'backend' | 'frontend' | 'rdb' | 'nosql' | 'cache' | 'mq' | 'devops' | 'other'

/** 分类元信息 + 常见技术库 */
const CATEGORIES: { key: TechCategory; label: string }[] = [
  { key: 'backend', label: '后端框架' },
  { key: 'frontend', label: '前端框架' },
  { key: 'rdb', label: '关系型数据库' },
  { key: 'nosql', label: 'NoSQL' },
  { key: 'cache', label: '缓存' },
  { key: 'mq', label: '消息队列' },
  { key: 'devops', label: '部署运维' },
  { key: 'other', label: '其他' },
]

const TECH_LIB: Record<TechCategory, string[]> = {
  backend: ['Spring Boot', 'MyBatis-Plus', 'Node.js', 'NestJS', 'FastAPI', 'Flask', 'Django', 'Go Gin', '.NET Core'],
  frontend: ['Vue 3', 'React', 'Element Plus', 'Ant Design', 'Next.js', 'Nuxt.js', 'Angular', 'Tailwind CSS'],
  rdb: ['MySQL', 'PostgreSQL', 'SQLite', 'Oracle', 'SQL Server'],
  nosql: ['MongoDB', 'Elasticsearch', 'Cassandra', 'DynamoDB', 'InfluxDB'],
  cache: ['Redis', 'Memcached'],
  mq: ['RabbitMQ', 'Kafka', 'RocketMQ', 'ActiveMQ'],
  devops: ['Docker', 'Kubernetes', 'Nginx', 'Jenkins', 'GitHub Actions', 'Nacos'],
  other: ['GraphQL', 'WebSocket', 'JWT', 'OAuth2', 'Swagger', 'Lombok'],
}

// 技术选型（初始为空，由用户添加 / 后续真实 AI 生成）
const techStack = ref<string[]>([])

const stackConfirmed = computed(() => techStack.value.length > 0)

/** 删除技术 */
function removeStack(name: string) {
  techStack.value = techStack.value.filter((t) => t !== name)
}

// ===== 弹窗 =====
const showStackPicker = ref(false)
const activeCat = ref<TechCategory>('backend')
const categories = CATEGORIES
const filteredTech = computed(() => TECH_LIB[activeCat.value])
const customStack = ref('')

/** 弹窗内待选技术（点击确定后才真正加入技术选型） */
const pickingStack = ref<string[]>([])

/** 打开弹窗：清空上次的待选 */
function openStackPicker() {
  pickingStack.value = []
  showStackPicker.value = true
}

/** 是否已勾选 */
function isPicked(name: string): boolean {
  return pickingStack.value.includes(name)
}

/** 点击切换勾选状态（再点一次取消） */
function togglePick(name: string) {
  const i = pickingStack.value.indexOf(name)
  if (i >= 0) pickingStack.value.splice(i, 1)
  else pickingStack.value.push(name)
}

/** 自定义技术：加入待选，不直接提交 */
function addCustomStack() {
  const name = customStack.value.trim()
  if (!name) return
  if (!techStack.value.includes(name) && !isPicked(name)) {
    pickingStack.value.push(name)
  }
  customStack.value = ''
}

/** 确定：把所有待选技术加入技术选型，关闭弹窗 */
function confirmStackPicker() {
  const added = pickingStack.value.filter((t) => !techStack.value.includes(t))
  for (const t of added) techStack.value.push(t)
  if (added.length) {
    archMessages.value.push({
      role: 'assistant',
      content: `已添加技术：${added.join('、')}。我会评估它们与现有架构的兼容性。`,
    })
    scrollToBottom()
  }
  pickingStack.value = []
  showStackPicker.value = false
}

// ===== 开发阶段（初始为空，用户手动编辑 / 后续真实 AI 生成） =====
const phases = ref<{ name: string; progress: number; tasks: string[] }[]>([])
const planShown = computed(() => phases.value.length > 0)

// ===== 开发阶段编辑（内存态，点"确认方案"时随 devPlan 一起提交） =====

/** 正在重命名的阶段下标（null = 无） */
const editingPhaseName = ref<number | null>(null)
const phaseNameDraft = ref('')
/** 正在添加任务的阶段下标（null = 无） */
const addingTaskIn = ref<number | null>(null)
const taskDraft = ref('')

/** 新增阶段 */
function addPhase() {
  phases.value.push({ name: '新阶段', progress: 0, tasks: [] })
}

/** 删除阶段 */
function removePhase(i: number) {
  phases.value.splice(i, 1)
}

/** 开始重命名：把当前名字填入输入框 */
function startEditPhaseName(i: number) {
  editingPhaseName.value = i
  phaseNameDraft.value = phases.value[i].name
}

/** 保存重命名（空值则回退原名） */
function savePhaseName(i: number) {
  if (editingPhaseName.value !== i) return
  const name = phaseNameDraft.value.trim()
  if (name) phases.value[i].name = name
  editingPhaseName.value = null
}

/** 开始添加任务 */
function startAddTask(i: number) {
  addingTaskIn.value = i
  taskDraft.value = ''
}

/** 添加任务 */
function addTask(i: number) {
  const t = taskDraft.value.trim()
  if (t) phases.value[i].tasks.push(t)
  addingTaskIn.value = null
  taskDraft.value = ''
}

/** 删除任务 */
function removeTask(i: number, t: string) {
  phases.value[i].tasks = phases.value[i].tasks.filter((x) => x !== t)
}

// ===== 项目目录（VSCode 风格资源管理器，内存态） =====

/** 树节点：目录可折叠展开，文件无 children */
interface TreeNode {
  id: number
  name: string
  type: 'file' | 'dir'
  children?: TreeNode[]
  open?: boolean
}

/** 后端存储的目录纯结构（无 id/open 等前端内部字段） */
interface DirNode {
  name: string
  type: 'file' | 'dir'
  children?: DirNode[]
}

let nodeSeq = 0
const newNode = (name: string, type: 'file' | 'dir'): TreeNode => ({
  id: ++nodeSeq,
  name,
  type,
  children: type === 'dir' ? [] : undefined,
  open: true,
})

/** 从后端 JSON 还原目录树：纯结构 → TreeNode（重新分配 id/open） */
function restoreTree(nodes: DirNode[]): TreeNode[] {
  return nodes.map((n) => {
    const node = newNode(n.name, n.type === 'dir' ? 'dir' : 'file')
    if (n.type === 'dir' && Array.isArray(n.children)) {
      node.children = restoreTree(n.children)
    }
    return node
  })
}

// 项目目录（初始为空，右键空白处新建 / 后续真实 AI 生成）
const dirTree = ref<TreeNode[]>([])
const treeShown = computed(() => dirTree.value.length > 0)

/** 扁平渲染行（折叠的目录不展开子级） */
interface FlatRow {
  node: TreeNode
  depth: number
}
const flatTree = computed<FlatRow[]>(() => {
  const out: FlatRow[] = []
  const walk = (nodes: TreeNode[], depth: number) => {
    for (const n of nodes) {
      out.push({ node: n, depth })
      if (n.type === 'dir' && n.open && n.children) walk(n.children, depth + 1)
    }
  }
  walk(dirTree.value, 0)
  return out
})

// ===== 选中 / 折叠 =====
const selectedId = ref<number | null>(null)

function selectNode(node: TreeNode) {
  selectedId.value = node.id
}

function clearSelection() {
  selectedId.value = null
}

/** 目录折叠 / 展开 */
function toggleDir(node: TreeNode) {
  node.open = !node.open
}

// ===== 右键菜单 =====
interface CtxState {
  x: number
  y: number
  node: TreeNode | null // null = 空白区（根级）
}
const ctxMenu = ref<CtxState | null>(null)
/** 前端剪贴板（内存态，深拷贝） */
const clipboard = ref<TreeNode | null>(null)

function openMenu(e: MouseEvent, node: TreeNode | null) {
  // 贴边翻转，防止菜单超出视口
  const menuW = 170
  const x = e.clientX + menuW > window.innerWidth ? e.clientX - menuW : e.clientX
  ctxMenu.value = { x, y: e.clientY, node }
}

/** 右键目标容器（菜单操作的插入点）：目录 = 自身，文件/空白 = 父级（根为 dirTree） */
function targetContainer(node: TreeNode | null, tree: TreeNode[] = dirTree.value): TreeNode[] | null {
  if (!node) return tree
  if (node.type === 'dir') return node.children!
  return findParent(node, tree) ?? null
}

/** 查找节点的父级容器 */
function findParent(target: TreeNode, nodes: TreeNode[]): TreeNode[] | null {
  if (nodes.includes(target)) return nodes
  for (const n of nodes) {
    if (n.children) {
      const hit = findParent(target, n.children)
      if (hit) return hit
    }
  }
  return null
}

/** 关闭菜单（全局点击） */
function closeMenu() {
  ctxMenu.value = null
}

/** 新建文件（目录或空白区） */
function createFile(node: TreeNode | null) {
  const container = targetContainer(node)
  if (!container) return
  const file = newNode('新建文件.txt', 'file')
  container.push(file)
  ctxMenu.value = null
  startRename(file)
}

/** 新建文件夹 */
function createDir(node: TreeNode | null) {
  const container = targetContainer(node)
  if (!container) return
  const dir = newNode('新建文件夹', 'dir')
  container.push(dir)
  ctxMenu.value = null
  startRename(dir)
}

/** 复制（深拷贝，粘贴时重分配 id） */
function copyNode(node: TreeNode) {
  clipboard.value = structuredClone(node)
  ctxMenu.value = null
}

/** anc 是否为 node 的祖先（node 位于 anc 的子树中） */
function isAncestor(anc: TreeNode, node: TreeNode): boolean {
  return !!(
    anc.children &&
    (anc.children.includes(node) || anc.children.some((c) => isAncestor(c, node)))
  )
}

/**
 * 粘贴是否可用：剪贴板有内容，且目标目录不是剪贴板自身/子孙（防无限嵌套）。
 * 两种情况拒绝：①剪贴板是 node 的子孙 ②node 是剪贴板的子孙。
 */
function canPaste(node: TreeNode | null): boolean {
  if (!clipboard.value) return false
  if (!node) return true // 空白区 = 粘贴到根
  if (node.type === 'file') return false
  return !isAncestor(clipboard.value, node) && !isAncestor(node, clipboard.value)
}

/** 粘贴到目标目录（文件/空白 = 其父级） */
function pasteInto(node: TreeNode | null) {
  if (!clipboard.value || !canPaste(node)) return
  const container = targetContainer(node)
  if (!container) return
  // 深拷贝后重分配整棵子树的 id，避免冲突
  const copy = structuredClone(clipboard.value)
  const reid = (n: TreeNode) => {
    n.id = ++nodeSeq
    n.children?.forEach(reid)
  }
  reid(copy)
  container.push(copy)
  ctxMenu.value = null
}

// ===== 重命名 =====
const renamingId = ref<number | null>(null)
const renameDraft = ref('')

function startRename(node: TreeNode) {
  renamingId.value = node.id
  renameDraft.value = node.name
  ctxMenu.value = null
}

function commitRename(node: TreeNode) {
  if (renamingId.value !== node.id) return
  const name = renameDraft.value.trim()
  if (name) node.name = name
  renamingId.value = null
}

function cancelRename() {
  renamingId.value = null
}

// ===== 删除（弹窗确认） =====
async function removeNode(node: TreeNode) {
  const container = findParent(node, dirTree.value)
  if (!container) return
  try {
    await ElMessageBox.confirm(
      `确定删除「${node.name}」吗？${node.type === 'dir' ? '目录内的文件将一并删除。' : ''}`,
      '删除确认',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' }
    )
    container.splice(container.indexOf(node), 1)
    if (selectedId.value === node.id) selectedId.value = null
  } catch {
    /* 用户取消 */
  }
  ctxMenu.value = null
}

// 全局点击关闭右键菜单
document.addEventListener('click', closeMenu)
onUnmounted(() => document.removeEventListener('click', closeMenu))
// 接口文档功能尚未实现，保持未完成状态
const apiShown = ref(false)

const avatarArch = new URL('../assets/agent-architect.png', import.meta.url).href

/** 架构师卡元数据（左上角 + 职责清单） */
const ROLE_META = {
  architect: {
    name: 'AI 架构师',
    badge: 'Architect',
    color: '#a76bff',
    bg: 'rgba(167,107,255,.12)',
    avatar: avatarArch,
    duty: '技术选型 · 规划架构方案',
    tasks: () => [
      { label: '确定技术选型', done: stackConfirmed.value },
      { label: '规划开发阶段', done: planShown.value },
      { label: '设计项目目录', done: treeShown.value },
      { label: '规划接口文档', done: apiShown.value },
    ],
  },
}

const currentRole = ROLE_META.architect

// ===== 对话区 =====
interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

const archMessages = ref<ChatMessage[]>([
  {
    role: 'assistant',
    content:
      '你好，我是 AI 架构师。技术选型、开发阶段和项目目录都还是空的——你可以直接告诉我需求，或在左侧手动添加；之后点「确认方案」一次性提交。',
  },
])

const draft = ref('')
const thinking = ref(false)
const working = ref(false)
const chatBody = ref<HTMLElement | null>(null)


/** mock 架构师回复（技术方案咨询） */
function archReply(text: string): string {
  if (/为什么|理由|原因/.test(text)) {
    return '选型基于需求规模和团队熟练度：Spring Boot 生态成熟、人才好招，Vue 3 组合式 API 适合快速迭代，MySQL + Redis 覆盖常规读写与缓存。如果换技术栈，直接在左侧技术选型里增删即可。'
  }
  if (/换|改成|不用|去掉|换掉/.test(text)) {
    return '好的，调整技术选型会同步影响开发阶段和项目目录。直接在左侧气泡里增删技术，我会按最新选型评估影响。'
  }
  if (/阶段|计划|排期|多久/.test(text)) {
    return `当前规划了 ${phases.value.length} 个阶段（${phases.value[0]?.name || ''} → 部署交付）。开发阶段可在左侧直接增删任务，确认方案时一并提交。`
  }
  if (/目录|结构|文件夹/.test(text)) {
    return '项目目录是标准前后端分离结构：backend 用 Maven 分层（controller/service/mapper/entity），frontend 按 views/components/api 组织。你可以右键目录新建、重命名、复制粘贴，完全像 VSCode 资源管理器。'
  }
  return '收到。技术选型、开发阶段、项目目录都可以在左侧直接调整，点「确认方案」时一起提交保存。'
}

function send() {
  const text = draft.value.trim()
  if (!text || thinking.value) return

  archMessages.value.push({ role: 'user', content: text })
  draft.value = ''
  working.value = true
  scrollToBottom()

  setTimeout(() => {
    archMessages.value.push({ role: 'assistant', content: archReply(text) })
    working.value = false
    scrollToBottom()
  }, 800)
}

function scrollToBottom() {
  nextTick(() => {
    if (chatBody.value) {
      chatBody.value.scrollTop = chatBody.value.scrollHeight
    }
  })
}

// ===== 顶栏按钮 =====

/** 返回项目功能模块（不保存任何修改） */
function goBack() {
  router.push({ name: 'project-detail', params: { id: String(route.params.id) } })
}

/**
 * 目录树序列化为纯结构（去掉 id/open 等前端内部字段，只留 name/type/children）
 */
/** 目录树序列化为纯结构（与 restoreTree 互逆，去掉 id/open 内部字段） */
function cleanTree(nodes: TreeNode[]): DirNode[] {
  return nodes.map((n) =>
    n.type === 'dir'
      ? { name: n.name, type: n.type, children: n.children ? cleanTree(n.children) : [] }
      : { name: n.name, type: n.type }
  )
}

/**
 * 保存方案到后端：技术选型 + 开发计划 + 项目目录 + 状态置 planning
 * techStack / devPlan / dirTree 均为 JSON 数组字符串（后端校验格式）
 */
async function savePlan() {
  const id = Number(route.params.id)
  await updateProject(id, {
    techStack: JSON.stringify(techStack.value),
    devPlan: JSON.stringify(phases.value),
    dirTree: JSON.stringify(cleanTree(dirTree.value)),
    status: 'planning',
  })
}

/** 确认方案：提交所有修改（techStack/devPlan/dirTree/status）后返回功能模块 */
async function confirmPlan() {
  await savePlan()
  router.push({ name: 'project-detail', params: { id: String(route.params.id) } })
}
</script>


<template>
  <div class="architect">
    <!-- 顶栏 -->
    <header class="topbar">
      <button class="btn-back" @click="goBack">← 返回</button>
      <div class="topbar-title">
        <span class="dim">{{ projectName }} ·</span>
        <span>架构师工作台</span>
      </div>
      <div class="topbar-right">
        <GradientButton @click="confirmPlan">
          确认方案
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5 12h14M12 5l7 7-7 7" />
          </svg>
        </GradientButton>
      </div>
    </header>

    <main class="main">
      <!-- ===== 左侧：架构师工作台 ===== -->
      <div class="left">
        <!-- 角色卡（跟随对话角色切换） -->
        <CardShell class="arch-card" :style="{ borderLeftColor: currentRole.color }">
          <div class="arch-head">
            <div class="arch-avatar">
              <img :src="currentRole.avatar" :alt="currentRole.name" />
            </div>
            <div class="arch-meta">
              <h3>
                {{ currentRole.name }}
                <span class="arch-badge" :style="{ color: currentRole.color, borderColor: currentRole.color + '55', background: currentRole.bg }">
                  {{ currentRole.badge }}
                </span>
              </h3>
              <p class="arch-duty">{{ currentRole.duty }}</p>
            </div>
            <span class="arch-status" :class="{ on: working }">
              <span class="arch-dot"></span>{{ working ? '工作中' : '待命' }}
            </span>
          </div>
          <div class="arch-tasks">
            <div
              v-for="t in currentRole.tasks()"
              :key="t.label"
              class="arch-task"
              :class="{ done: t.done }"
            >
              <span class="arch-check">{{ t.done ? '✓' : '○' }}</span>
              <span>{{ t.label }}</span>
            </div>
          </div>
        </CardShell>

        <!-- 技术选型（气泡式，AI 预设 + 可增删） -->
        <CardShell class="block">
          <div class="block-head">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="16 18 22 12 16 6" />
              <polyline points="8 6 2 12 8 18" />
            </svg>
            <h3 class="block-title">技术选型</h3>
            <span class="hint">AI 预设 · 点击 ＋ 调整</span>
          </div>

          <!-- 气泡区 -->
          <div class="stack-cloud">
            <span v-if="!techStack.length" class="stack-empty">暂无技术选型，点击 ＋ 添加</span>
            <span
              v-for="t in techStack"
              :key="t"
              class="stack-bubble"
            >
              {{ t }}
              <button class="bubble-remove" @click="removeStack(t)">✕</button>
            </span>
            <button class="bubble-add" @click="openStackPicker">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          </div>
        </CardShell>

        <!-- 开发阶段计划 -->
        <CardShell class="block">
          <div class="block-head">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            <h3 class="block-title">开发阶段与计划</h3>
            <span class="hint">AI 规划 · {{ phases.length }} 个阶段</span>
          </div>
          <div class="phase-list">
            <div v-if="!phases.length" class="phase-empty">暂无开发计划，点击下方「＋ 新增阶段」开始规划</div>
            <div v-for="(p, i) in phases" :key="i" class="phase-item">
              <div class="phase-head">
                <span class="phase-num">阶段 {{ i + 1 }}</span>
                <!-- 阶段名：点击铅笔 inline 编辑，回车/失焦保存 -->
                <input
                  v-if="editingPhaseName === i"
                  v-model="phaseNameDraft"
                  class="phase-name-input"
                  @keyup.enter="savePhaseName(i)"
                  @blur="savePhaseName(i)"
                  @keyup.esc="editingPhaseName = null"
                />
                <span v-else class="phase-name">{{ p.name }}</span>
                <span class="phase-tasks">{{ p.tasks.length }} 个任务</span>
                <span class="phase-ops">
                  <button class="phase-op" title="重命名阶段" @click="startEditPhaseName(i)">✎</button>
                  <button class="phase-op del" title="删除阶段" @click="removePhase(i)">✕</button>
                </span>
              </div>
              <div class="phase-bar">
                <div class="phase-bar-fill" :style="{ width: p.progress + '%' }"></div>
              </div>
              <div class="phase-tag-list">
                <span v-for="t in p.tasks" :key="t" class="phase-tag">
                  {{ t }}
                  <button class="tag-del" title="删除任务" @click="removeTask(i, t)">✕</button>
                </span>
                <!-- 添加任务（inline 输入） -->
                <span v-if="addingTaskIn === i" class="phase-add-task">
                  <input
                    v-model="taskDraft"
                    class="phase-task-input"
                    placeholder="任务名称，回车添加"
                    @keyup.enter="addTask(i)"
                    @keyup.esc="addingTaskIn = null"
                  />
                </span>
                <button v-else class="phase-add-btn" title="添加任务" @click="startAddTask(i)">
                  ＋ 任务
                </button>
              </div>
            </div>
          </div>
          <!-- 新增阶段 -->
          <button class="phase-add" @click="addPhase">＋ 新增阶段</button>
        </CardShell>

        <!-- 项目目录预览 -->
        <CardShell class="block">
          <div class="block-head">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 7v11a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2z" />
            </svg>
            <h3 class="block-title">项目目录</h3>
            <span class="hint">架构师设计</span>
          </div>
          <div class="tree" @click.self="clearSelection" @contextmenu.self.prevent="openMenu($event, null)">
            <!-- 扁平渲染：折叠的目录不展开其子级 -->
            <div
              v-for="f in flatTree"
              :key="f.node.id"
              class="tree-line"
              :class="{ dir: f.node.type === 'dir', selected: f.node.id === selectedId }"
              :style="{ paddingLeft: 8 + f.depth * 16 + 'px' }"
              @click="selectNode(f.node)"
              @contextmenu.prevent="openMenu($event, f.node)"
            >
              <!-- 三角箭头（目录） / 占位（文件） -->
              <span v-if="f.node.type === 'dir'" class="tree-arrow" @click.stop="toggleDir(f.node)">
                <svg viewBox="0 0 24 24" width="12" height="12" :class="{ open: f.node.open }" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </span>
              <span v-else class="tree-arrow"></span>
              <!-- 类型图标（VSCode 风格：目录 / 文件） -->
              <span v-if="f.node.type === 'dir'" class="tree-file-icon folder">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
              </span>
              <span v-else class="tree-file-icon file">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
                  <polyline points="13 2 13 9 20 9" />
                </svg>
              </span>
              <!-- 重命名 inline 编辑 -->
              <input
                v-if="renamingId === f.node.id"
                v-model="renameDraft"
                class="tree-rename-input"
                @click.stop
                @keyup.enter="commitRename(f.node)"
                @keyup.esc="cancelRename"
                @blur="commitRename(f.node)"
              />
              <span v-else class="tree-name">{{ f.node.name }}</span>
              <!-- hover 快捷操作（VSCode 资源管理器风格） -->
              <span v-if="f.node.type === 'dir'" class="tree-hover-ops">
                <button class="tree-hover-op" title="新建文件" @click.stop="createFile(f.node)">
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="12" y1="18" x2="12" y2="12" /><line x1="9" y1="15" x2="15" y2="15" /></svg>
                </button>
                <button class="tree-hover-op" title="新建文件夹" @click.stop="createDir(f.node)">
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /><line x1="12" y1="11" x2="12" y2="17" /><line x1="9" y1="14" x2="15" y2="14" /></svg>
                </button>
              </span>
            </div>
            <div v-if="!flatTree.length" class="tree-empty">目录为空，右键空白处新建</div>
          </div>

          <!-- 右键菜单（VSCode 资源管理器风格） -->
          <div v-if="ctxMenu" class="ctx-menu" :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }" @click.stop>
            <button class="ctx-item" @click="createFile(ctxMenu.node)">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><polyline points="13 2 13 9 20 9" /></svg>
              新建文件
            </button>
            <button class="ctx-item" @click="createDir(ctxMenu.node)">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" /></svg>
              新建文件夹
            </button>
            <div class="ctx-sep"></div>
            <button class="ctx-item" @click="copyNode(ctxMenu.node!)">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
              复制
            </button>
            <button
              class="ctx-item"
              :class="{ disabled: !clipboard || !canPaste(ctxMenu.node) }"
              @click="pasteInto(ctxMenu.node)"
            >
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><rect x="8" y="2" width="8" height="4" rx="1" /></svg>
              粘贴
            </button>
            <div class="ctx-sep"></div>
            <button class="ctx-item" @click="startRename(ctxMenu.node!)">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /></svg>
              重命名
            </button>
            <button class="ctx-item danger" @click="removeNode(ctxMenu.node!)">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></svg>
              删除
            </button>
          </div>
        </CardShell>
      </div>

      <!-- ===== 右侧：角色切换对话 ===== -->
      <div class="right">
        <div class="chat">
          <div class="chat-head">
            <span class="chat-head-hint">询问理由 · 提出调整</span>
          </div>
          <div ref="chatBody" class="chat-body">
            <div
              v-for="(m, i) in archMessages"
              :key="i"
              class="msg"
              :class="m.role"
            >
              <div v-if="m.role === 'assistant'" class="msg-avatar">
                <img :src="avatarArch" alt="架构师" />
              </div>
              <div class="msg-bubble">{{ m.content }}</div>
            </div>
            <div v-if="thinking" class="msg assistant">
              <div class="msg-avatar">
                <img :src="avatarArch" alt="架构师" />
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
              v-model="draft"
              rows="2"
              placeholder="如：为什么用 MySQL？/ 后端换 Node.js...（Enter 发送）"
              @keydown.enter.exact.prevent="send"
            ></textarea>
            <button class="btn-send" :disabled="!draft.trim() || thinking" @click="send">
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M22 2 11 13" />
                <path d="M22 2 15 22l-4-9-9-4z" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </main>

    <!-- 技术选型弹窗 -->
    <div v-if="showStackPicker" class="modal-mask" @click.self="showStackPicker = false">
      <div class="stack-modal">
        <div class="stack-modal-head">
          <h2>添加技术</h2>
          <button class="modal-close" @click="showStackPicker = false">✕</button>
        </div>

        <div class="stack-modal-body">
          <!-- 分类 tab -->
          <div class="cat-tabs">
            <button
              v-for="cat in categories"
              :key="cat.key"
              class="cat-tab"
              :class="{ active: activeCat === cat.key }"
              @click="activeCat = cat.key"
            >
              {{ cat.label }}
            </button>
          </div>

          <!-- 技术网格：点击勾选，再点取消 -->
          <div class="tech-grid">
            <button
              v-for="t in filteredTech"
              :key="t"
              class="tech-btn"
              :class="{ added: techStack.includes(t), picked: isPicked(t) }"
              :disabled="techStack.includes(t)"
              @click="togglePick(t)"
            >
              {{ t }}
              <span v-if="techStack.includes(t) || isPicked(t)" class="tech-added">✓</span>
            </button>
            <p v-if="!filteredTech.length" class="tech-empty">该分类暂无更多技术</p>
          </div>

        </div>

        <!-- 自定义添加（加入待选） -->
        <div class="custom-add">
          <input
            v-model="customStack"
            class="custom-input"
            type="text"
            placeholder="自定义技术名称，如：Docker Compose"
            @keyup.enter="addCustomStack"
          />
          <button class="custom-btn" @click="addCustomStack">加入待选</button>
        </div>

        <!-- 底部操作：取消 / 确定（新增并关闭） -->
        <div class="stack-modal-actions">
          <button class="btn-cancel" @click="showStackPicker = false">取消</button>
          <button class="btn-save" :disabled="!pickingStack.length" @click="confirmStackPicker">
            确定（{{ pickingStack.length }}）
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.architect {
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
  display: flex;
  gap: 20px;
  width: 100%;
  height: calc(100vh - 56px);
  padding: 20px 48px 24px;
}
.left {
  flex: 3;
  display: flex;
  flex-direction: column;
  gap: 16px;
  overflow-y: auto;
  padding-right: 4px;
}
.right {
  flex: 2;
  display: flex;
  flex-direction: column;
  min-width: 380px;
}

/* ===== 架构师角色卡 ===== */
.arch-card {
  padding: 18px 20px;
  border-left: 3px solid var(--purple);
}
.arch-head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.arch-avatar {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  overflow: hidden;
  flex-shrink: 0;
  background: var(--bg3);
  border: 1px solid var(--border);
}
.arch-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.arch-meta {
  flex: 1;
}
.arch-meta h3 {
  font-size: 15px;
  font-weight: 700;
}
.arch-badge {
  display: inline-block;
  margin-left: 6px;
  padding: 2px 8px;
  border-radius: 10px;
  background: rgba(167, 107, 255, 0.12);
  border: 1px solid rgba(167, 107, 255, 0.3);
  color: var(--purple);
  font-size: 11px;
  font-weight: 600;
  vertical-align: middle;
}
.arch-duty {
  font-size: 12px;
  color: var(--text2);
  margin-top: 3px;
}
.arch-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text3);
  flex-shrink: 0;
}
.arch-status.on {
  color: var(--green);
}
.arch-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
  animation: pulse 1.2s infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

/* 职责清单 */
.arch-tasks {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}
.arch-task {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text3);
  padding: 4px 10px;
  border-radius: 14px;
  background: var(--bg3);
  border: 1px solid var(--border);
  transition: all 0.2s;
}
.arch-task.done {
  color: var(--green);
  border-color: rgba(94, 203, 138, 0.3);
  background: rgba(94, 203, 138, 0.06);
}
.arch-check {
  font-size: 11px;
}

/* ===== 区块 ===== */
.block {
  padding: 18px 20px;
}
.block-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
  color: var(--text2);
}
.block-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}
.hint {
  font-size: 11.5px;
  color: var(--text3);
  margin-left: auto;
}

/* 技术选型气泡 */
.stack-cloud {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}
.stack-empty {
  font-size: 12.5px;
  color: var(--text3);
}
.stack-bubble {
  position: relative;
  display: inline-flex;
  align-items: center;
  padding: 7px 24px 7px 13px;
  border-radius: 16px;
  border: 1px solid rgba(69, 184, 255, 0.3);
  background: rgba(69, 184, 255, 0.08);
  color: var(--blue);
  font-size: 13px;
  font-weight: 500;
  transition: all 0.2s;
}
.stack-bubble:hover {
  border-color: rgba(69, 184, 255, 0.5);
}
.bubble-remove {
  position: absolute;
  top: 2px;
  right: 5px;
  border: none;
  background: transparent;
  color: var(--text3);
  font-size: 10px;
  cursor: pointer;
  padding: 2px;
  line-height: 1;
  border-radius: 50%;
  transition: all 0.15s;
}
.bubble-remove:hover {
  color: var(--red);
  background: rgba(242, 96, 96, 0.1);
}
.bubble-add {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 1.5px dashed var(--border2);
  background: transparent;
  color: var(--text2);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
  flex-shrink: 0;
}
.bubble-add:hover {
  border-color: var(--blue);
  color: var(--blue);
  background: rgba(69, 184, 255, 0.06);
}

/* ===== 技术选择弹窗 ===== */
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
.stack-modal {
  width: 620px;
  max-height: 72vh;
  display: flex;
  flex-direction: column;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  overflow: hidden;
}
.stack-modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 22px;
  border-bottom: 1px solid var(--border);
}
.stack-modal-head h2 {
  font-size: 16px;
  font-weight: 700;
}
.modal-close {
  border: none;
  background: transparent;
  color: var(--text3);
  font-size: 14px;
  cursor: pointer;
  padding: 4px;
}
.modal-close:hover {
  color: var(--text);
}
.stack-modal-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}
.cat-tabs {
  width: 130px;
  display: flex;
  flex-direction: column;
  padding: 12px;
  border-right: 1px solid var(--border);
  gap: 4px;
  overflow-y: auto;
}
.cat-tab {
  padding: 9px 12px;
  border-radius: 8px;
  border: none;
  background: transparent;
  color: var(--text2);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: all 0.15s;
}
.cat-tab:hover {
  background: var(--bg3);
  color: var(--text);
}
.cat-tab.active {
  background: rgba(69, 184, 255, 0.1);
  color: var(--blue);
  font-weight: 600;
}
.tech-grid {
  flex: 1;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  padding: 16px;
  align-content: start;
  overflow-y: auto;
}
.tech-btn {
  position: relative;
  padding: 10px 8px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--bg3);
  color: var(--text2);
  font-size: 12.5px;
  cursor: pointer;
  transition: all 0.15s;
  overflow: hidden;
}
.tech-btn:hover:not(:disabled) {
  border-color: var(--blue);
  color: var(--blue);
}
.tech-btn.added {
  border-color: rgba(94, 203, 138, 0.35);
  background: rgba(94, 203, 138, 0.06);
  color: var(--green);
  cursor: default;
}
.tech-added {
  position: absolute;
  top: 3px;
  right: 6px;
  font-size: 10px;
  font-weight: 700;
}
.tech-empty {
  grid-column: 1 / -1;
  color: var(--text3);
  font-size: 13px;
  padding: 20px 0;
  text-align: center;
}
/* 勾选态（区别于已添加 disabled） */
.tech-btn.picked:not(:disabled) {
  border-color: var(--green);
  background: rgba(94, 203, 138, 0.12);
  color: var(--text1);
}
/* 弹窗底部操作 */
.stack-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px 18px;
  border-top: 1px solid var(--border);
}
.stack-modal-actions .btn-save:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.stack-modal-actions .btn-cancel {
  padding: 0 20px;
  height: 38px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text2);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
}
.stack-modal-actions .btn-cancel:hover {
  border-color: var(--border2);
  color: var(--text1);
}
.stack-modal-actions .btn-save {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 38px;
  padding: 0 22px;
  border: none;
  border-radius: 9px;
  background: var(--grad1);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity var(--dur) var(--ease);
}
.stack-modal-actions .btn-save:hover:not(:disabled) {
  opacity: 0.9;
}
.custom-add {
  display: flex;
  gap: 8px;
  padding: 14px 18px;
  border-top: 1px solid var(--border);
}
.custom-input {
  flex: 1;
  height: 38px;
  padding: 0 12px;
  border-radius: 9px;
  border: 1px dashed var(--border2);
  background: transparent;
  color: var(--text);
  font-size: 13px;
  outline: none;
  transition: all 0.2s;
}
.custom-input:focus {
  border-color: var(--blue);
  border-style: solid;
}
.custom-input::placeholder {
  color: var(--text3);
}
.custom-btn {
  padding: 0 18px;
  height: 38px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--bg3);
  color: var(--text2);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
}
.custom-btn:hover {
  border-color: var(--blue);
  color: var(--blue);
}

/* 开发阶段 */
.phase-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.phase-empty {
  font-size: 12.5px;
  color: var(--text3);
  padding: 4px 0;
}
.phase-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}
.phase-num {
  font-size: 11.5px;
  font-weight: 700;
  color: var(--blue);
  padding: 2px 8px;
  border-radius: 8px;
  background: rgba(69, 184, 255, 0.1);
}
.phase-name {
  font-size: 13.5px;
  font-weight: 600;
  flex: 1;
}
.phase-tasks {
  font-size: 11.5px;
  color: var(--text3);
}
.phase-bar {
  height: 6px;
  border-radius: 3px;
  background: var(--bg3);
  overflow: hidden;
  margin-bottom: 8px;
}
.phase-bar-fill {
  height: 100%;
  border-radius: 3px;
  background: var(--grad1);
  transition: width 0.5s var(--ease);
}
.phase-tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.phase-tag {
  padding: 3px 9px;
  border-radius: 8px;
  background: var(--bg3);
  border: 1px solid var(--border);
  font-size: 11px;
  color: var(--text2);
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.tag-del {
  display: none;
  border: none;
  background: none;
  color: var(--text3);
  font-size: 10px;
  cursor: pointer;
  padding: 0;
  line-height: 1;
}
.phase-tag:hover .tag-del {
  display: inline;
}
.tag-del:hover {
  color: var(--red);
}
/* 阶段操作按钮（重命名 / 删除） */
.phase-ops {
  display: flex;
  gap: 4px;
}
.phase-op {
  display: none;
  border: none;
  background: none;
  color: var(--text3);
  font-size: 12px;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 4px;
  line-height: 1;
}
.phase-head:hover .phase-op {
  display: inline-block;
}
.phase-op:hover {
  color: var(--blue);
  background: var(--bg4);
}
.phase-op.del:hover {
  color: var(--red);
}
/* 阶段名 inline 编辑 */
.phase-name-input {
  flex: 1;
  min-width: 0;
  background: var(--bg4);
  border: 1px solid var(--blue);
  border-radius: 6px;
  color: var(--text1);
  font-size: 13.5px;
  padding: 3px 8px;
  outline: none;
}
/* 添加任务按钮 + inline 输入 */
.phase-add-btn {
  border: 1px dashed var(--border);
  background: none;
  color: var(--text3);
  font-size: 11px;
  padding: 2px 9px;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s;
}
.phase-add-btn:hover {
  border-color: var(--blue);
  color: var(--blue);
}
.phase-add-task {
  display: inline-flex;
}
.phase-task-input {
  background: var(--bg4);
  border: 1px solid var(--blue);
  border-radius: 8px;
  color: var(--text1);
  font-size: 11px;
  padding: 3px 9px;
  width: 150px;
  outline: none;
}
/* 新增阶段（卡片底部） */
.phase-add {
  margin-top: 12px;
  width: 100%;
  padding: 8px 0;
  border: 1px dashed var(--border);
  border-radius: 10px;
  background: none;
  color: var(--text3);
  font-size: 12.5px;
  cursor: pointer;
  transition: all 0.2s;
}
.phase-add:hover {
  border-color: var(--blue);
  color: var(--blue);
  background: rgba(69, 184, 255, 0.05);
}

/* ===== 目录树（VSCode 资源管理器风格） ===== */
.tree {
  font-family: 'Consolas', 'Courier New', monospace;
  font-size: 12.5px;
  line-height: 1.9;
  background: var(--bg2);
  border-radius: 8px;
  padding: 6px 0;
  min-height: 60px;
  user-select: none;
}
.tree-line {
  display: flex;
  align-items: center;
  gap: 5px;
  padding-right: 8px;
  cursor: pointer;
  color: var(--text2);
  white-space: nowrap;
}
.tree-line:hover {
  background: var(--bg4);
}
.tree-line.selected {
  background: rgba(106, 165, 251, 0.16);
  color: var(--text1);
}
.tree-line.selected .tree-name {
  color: var(--text1);
}
.tree-arrow {
  width: 12px;
  height: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text3);
  flex-shrink: 0;
}
.tree-arrow svg {
  transition: transform 0.15s var(--ease);
}
.tree-arrow svg.open {
  transform: rotate(90deg);
}
.tree-file-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.tree-file-icon.folder {
  color: #6aa5fb;
}
.tree-file-icon.file {
  color: var(--text3);
}
.tree-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tree-line.dir .tree-name {
  color: var(--text1);
  font-weight: 600;
}
/* hover 快捷按钮（新建文件 / 文件夹） */
.tree-hover-ops {
  display: none;
  gap: 2px;
  flex-shrink: 0;
}
.tree-line:hover .tree-hover-ops {
  display: inline-flex;
}
.tree-hover-op {
  border: none;
  background: none;
  color: var(--text3);
  font-size: 12px;
  line-height: 1;
  padding: 2px 4px;
  border-radius: 4px;
  cursor: pointer;
}
.tree-hover-op:hover {
  color: var(--blue);
  background: var(--bg3);
}
/* 重命名 inline 编辑 */
.tree-rename-input {
  flex: 1;
  min-width: 0;
  background: var(--bg4);
  border: 1px solid var(--blue);
  border-radius: 4px;
  color: var(--text1);
  font-size: 12.5px;
  font-family: inherit;
  padding: 1px 6px;
  outline: none;
}
.tree-empty {
  padding: 10px 14px;
  color: var(--text3);
  font-size: 12px;
}
/* ===== 右键菜单（VSCode 风格浮层） ===== */
.ctx-menu {
  position: fixed;
  z-index: 1000;
  min-width: 170px;
  padding: 5px;
  border-radius: 8px;
  background: #1a2030;
  border: 1px solid var(--border);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.ctx-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  border-radius: 5px;
  background: none;
  color: var(--text1);
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}
.ctx-item:hover:not(.disabled) {
  background: rgba(106, 165, 251, 0.15);
}
.ctx-item.danger {
  color: var(--red);
}
.ctx-item.danger:hover {
  background: rgba(242, 96, 96, 0.12);
}
.ctx-item.disabled {
  color: var(--text3);
  cursor: not-allowed;
  opacity: 0.5;
}
.ctx-sep {
  height: 1px;
  background: var(--border);
  margin: 4px 6px;
}

/* ===== 对话区 ===== */
.chat {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  overflow: hidden;
}
.chat-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
  font-weight: 600;
}
.chat-head-hint {
  font-size: 11px;
  font-weight: 400;
  color: var(--text3);
}

/* 角色切换 */
.role-switch {
  display: flex;
  gap: 4px;
  background: var(--bg3);
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 3px;
}
.role-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 6px 12px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--text3);
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}
.role-btn:hover {
  color: var(--text);
}
.role-btn.active {
  background: var(--grad1);
  color: #fff;
}

/* 功能清单 */
.feature-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.feature-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-radius: 9px;
  background: var(--bg3);
  border: 1px solid var(--border);
  font-size: 13px;
  color: var(--text);
  animation: feature-in 0.3s var(--ease);
}
@keyframes feature-in {
  from { opacity: 0; transform: translateX(-8px); }
  to { opacity: 1; transform: translateX(0); }
}
.feature-check {
  color: var(--green);
  font-weight: 700;
  flex-shrink: 0;
}
.feature-text {
  flex: 1;
}
.feature-remove {
  border: none;
  background: transparent;
  color: var(--text3);
  cursor: pointer;
  font-size: 12px;
}
.feature-remove:hover {
  color: var(--red);
}
.feature-add {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}
.feature-input {
  flex: 1;
  height: 36px;
  padding: 0 12px;
  border-radius: 9px;
  border: 1px dashed var(--border2);
  background: transparent;
  color: var(--text);
  font-size: 13px;
  outline: none;
  transition: all 0.2s;
}
.feature-input:focus {
  border-color: var(--blue);
  border-style: solid;
  background: rgba(69, 184, 255, 0.04);
}
.feature-input::placeholder {
  color: var(--text3);
}
.feature-add-btn {
  padding: 0 14px;
  height: 36px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--bg3);
  color: var(--text2);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
  flex-shrink: 0;
}
.feature-add-btn:hover {
  border-color: var(--blue);
  color: var(--blue);
}
.chat-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.msg {
  display: flex;
  gap: 10px;
  max-width: 92%;
}
.msg.user {
  align-self: flex-end;
  flex-direction: row-reverse;
}
.msg-avatar {
  width: 32px;
  height: 32px;
  border-radius: 10px;
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
  padding: 11px 14px;
  border-radius: 12px;
  font-size: 13.5px;
  line-height: 1.7;
  white-space: pre-line;
  word-break: break-word;
}
.msg.assistant .msg-bubble {
  background: var(--bg3);
  border: 1px solid var(--border);
  color: var(--text);
  border-top-left-radius: 4px;
}
.msg.user .msg-bubble {
  background: var(--grad1);
  color: #fff;
  border-top-right-radius: 4px;
}

.typing {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 14px 18px;
}
.typing .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text3);
  animation: blink 1.4s infinite;
}
.typing .dot:nth-child(2) {
  animation-delay: 0.2s;
}
.typing .dot:nth-child(3) {
  animation-delay: 0.4s;
}
@keyframes blink {
  0%, 80%, 100% { opacity: 0.25; }
  40% { opacity: 1; }
}

.chat-input {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  padding: 12px 14px;
  border-top: 1px solid var(--border);
  background: var(--bg2);
}
.chat-input textarea {
  flex: 1;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg3);
  color: var(--text);
  font-size: 13.5px;
  line-height: 1.6;
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
  width: 40px;
  height: 40px;
  border: none;
  border-radius: 10px;
  background: var(--grad1);
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: opacity 0.2s;
  flex-shrink: 0;
}
.btn-send:hover:not(:disabled) {
  opacity: 0.9;
}
.btn-send:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
