<script setup lang="ts">
/* ============================================================
   架构师工作台（/projects/:id/architect）
   ------------------------------------------------------------
   世界观：这里 = 出图前的绘图桌。左桌三张单（选型 / 阶段 / 目录），
   右席与架构师对谈（仍是本地 mock，回复分支逐字保留）。
   「确认方案」一次性 PUT：techStack/devPlan/dirTree + status=planning。
   devPlan 双形状容错口径与 ProjectDetailView 完全一致，不许漂移。
   ============================================================ */
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  IconCheck,
  IconCircle,
  IconPencil,
  IconPlus,
  IconSend,
  IconX,
} from '@tabler/icons-vue'
import AppModal from '../components/ui/AppModal.vue'
import SheetTree from '../components/SheetTree.vue'
import TopBar from '../components/ui/TopBar.vue'
import { fetchProjectById, updateProject } from '../api/project'
import { ENVELOPE_KEYS, buildDevPlanJson, buildTechStackJson, parseEnvelopeArray, toDisplayList } from '../utils/json'
import { cleanTree, restoreTree, type CleanNode, type TreeNode } from '../types/tree'

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

/** 解析 devPlan：纯数组与引擎 PM 的 {phases:[…]} 对象两种都认
 *  （口径与 ProjectDetailView 的 plan computed 样板完全一致，两处不许漂移） */
function parsePlanArr(raw?: string | null): unknown[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    const arr = Array.isArray(v) ? v : (v as { phases?: unknown[] })?.phases
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

/**
 * 库里原始形状的"底稿"（9/17 加）。
 *
 * 为什么必须留着：这一页只编辑阶段名/任务清单，但库里这些列是**引擎写的富信封**：
 *   dev_plan  = {risks, phases:[{goal,name,risk,phase,uiStyle,features,dependencies,relative_effort}],
 *                project, features, mvp_scope, uiProfile}
 *   tech_stack= {why, tables, moduleTech, techniques:{database:{…}, middleware:[{name,purpose}]}}
 * 而页面模型只有 {name, progress, tasks}。原来「确认方案」直接
 * `JSON.stringify(phases.value)` 整体替换 → 一次性丢掉信封的全部其他键，
 * 连每个阶段的 `phase` 数字都丢了 —— 而 `projectRunner.usablePhases()` 硬要求
 * `phase` 是整数、`name` 非空，丢了它引擎读回 dev_plan 会判定"计划不可用"，
 * 退回去重跑 PM 对话（引擎侧真故障，不只是少显示几个字段）。
 * 所以保存时必须"在底稿上改"，而不是"用页面模型重建"。
 */
const devPlanEnvelope = ref<Record<string, unknown> | null>(null)
const devPlanOriginalPhases = ref<Record<string, unknown>[]>([])
/** 原计划是不是引擎形状（阶段带数字 phase）——决定新增阶段要不要补 phase */
const devPlanEngineShape = ref(false)
const techStackEnvelope = ref<Record<string, unknown> | null>(null)

/** 把读回的条目归一成页面模型：PM 的 planItem 只有 features 没有 tasks，
 *  tasks 兜成 [] 同时防渲染 .length 崩（审计 F11 同型点） */
function normalizePhases(rows: unknown[]): { name: string; progress: number; tasks: string[] }[] {
  return (rows as Partial<{ name: string; progress: number; tasks: string[]; features: string[] }>[])
    .filter((r): r is NonNullable<typeof r> => r != null && typeof r === 'object')
    .map((r) => ({
      name: r.name ?? '未命名阶段',
      progress: typeof r.progress === 'number' ? r.progress : 0,
      tasks: Array.isArray(r.tasks) ? r.tasks : Array.isArray(r.features) ? r.features : [],
    }))
}

/** 阶段对象里"任务清单"所在的键：引擎写 features，网页写 tasks —— 谁原来有就写回谁 */

const projectId = computed(() => Number(route.params.id))

onMounted(async () => {
  const id = projectId.value
  if (!id) return
  try {
    const p = await fetchProjectById(id)
    projectName.value = p.name
    // 回显已保存的方案（确认方案提交过才有数据）

    // ---- techStack：双形状（网页裸数组 / 引擎信封），并留底稿供保存时合并 ----
    let rawStack: unknown = null
    try {
      rawStack = p.techStack ? JSON.parse(p.techStack) : null
    } catch {
      rawStack = null // 坏 JSON：当没有
    }
    techStackEnvelope.value =
      rawStack && typeof rawStack === 'object' && !Array.isArray(rawStack)
        ? (rawStack as Record<string, unknown>)
        : null
    techStack.value = toDisplayList(parseEnvelopeArray(p.techStack, ENVELOPE_KEYS.techStack))

    // ---- devPlan：同上，而且信封里的 phases 要留着做合并底稿 ----
    let rawPlan: unknown = null
    try {
      rawPlan = p.devPlan ? JSON.parse(p.devPlan) : null
    } catch {
      rawPlan = null
    }
    if (rawPlan && typeof rawPlan === 'object' && !Array.isArray(rawPlan)) {
      const env = rawPlan as Record<string, unknown>
      devPlanEnvelope.value = env
      devPlanOriginalPhases.value = Array.isArray(env.phases)
        ? (env.phases as Record<string, unknown>[])
        : []
    } else {
      devPlanEnvelope.value = null
      devPlanOriginalPhases.value = Array.isArray(rawPlan) ? (rawPlan as Record<string, unknown>[]) : []
    }
    devPlanEngineShape.value = devPlanOriginalPhases.value.some((x) => typeof x?.phase === 'number')
    // 旧 parseArr 把对象当 → [] → 页面显示"暂无开发计划"，一点「确认方案」把 "[]" PUT 回去清空引擎计划。
    phases.value = normalizePhases(
      devPlanOriginalPhases.value.length ? devPlanOriginalPhases.value : parsePlanArr(p.devPlan),
    )

    dirTree.value = restoreTree(parseArr(p.dirTree) as CleanNode[])
  } catch {
    projectName.value = '项目 #' + route.params.id
  }
})

/* ===== 技术选型（气泡式：AI 预设 + 增删） ===== */

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

/* ===== 选型弹窗（两段式：勾选待选 → 确定才入册） ===== */
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

/* ===== 开发阶段（初始为空，用户手动编辑 / 后续真实 AI 生成） ===== */
const phases = ref<{ name: string; progress: number; tasks: string[] }[]>([])
const planShown = computed(() => phases.value.length > 0)

// ===== 阶段编辑（内存态，点"确认方案"时随 devPlan 一起提交） =====

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

/* ===== 项目目录（编辑逻辑收进 SheetTree，这里只持数据） ===== */
const dirTree = ref<TreeNode[]>([])
const treeShown = computed(() => dirTree.value.length > 0)
const treeRef = ref<InstanceType<typeof SheetTree> | null>(null)

// 接口文档功能尚未实现，保持未完成状态
const apiShown = ref(false)

const avatarArch = new URL('../assets/agent-architect.png', import.meta.url).href

/** 架构师值班牌（左上角 + 职责清单；紫色换成图章口径） */
const currentRole = {
  name: 'AI 架构师',
  badge: 'Architect',
  avatar: avatarArch,
  duty: '技术选型 · 规划架构方案',
  tasks: () => [
    { label: '确定技术选型', done: stackConfirmed.value },
    { label: '规划开发阶段', done: planShown.value },
    { label: '设计项目目录', done: treeShown.value },
    { label: '规划接口文档', done: apiShown.value },
  ],
}

/* ===== 对话区（本地 mock） ===== */
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

/** mock 架构师回复（技术方案咨询，五个分支逐字保留） */
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

/* ===== 顶栏动作 ===== */

/** 返回项目功能模块（不保存任何修改） */
function goBack() {
  router.push({ name: 'project-detail', params: { id: String(route.params.id) } })
}

/**
 * 保存方案到后端：技术选型 + 开发计划 + 项目目录 + 状态置 planning
 *
 * ⚠️ 9/17 修：原来这里是 `devPlan: JSON.stringify(phases.value)` —— 用页面模型
 *   （只有 name/progress/tasks）**整体替换**库里的引擎信封，一次性丢掉
 *   risks/project/features/mvp_scope/uiProfile 和每个阶段的 phase 数字，
 *   而 usablePhases() 硬要求数字 phase → 引擎读回后判定计划不可用、退回重跑 PM 对话。
 *   现在改为"在底稿上合并"（见 buildDevPlanJson / buildTechStackJson）。
 *   这两个 JSON 仍是**数组或对象**都是合法形状（后端 validateJsonShape 两种都收）。
 */
async function savePlan() {
  await updateProject(projectId.value, {
    techStack: buildTechStackJson(techStackEnvelope.value, techStack.value),
    devPlan: buildDevPlanJson(
      devPlanEnvelope.value,
      devPlanOriginalPhases.value,
      phases.value,
      devPlanEngineShape.value,
    ),
    dirTree: JSON.stringify(cleanTree(dirTree.value)),
    status: 'planning',
  })
}

/** 确认方案：提交所有修改后返回功能模块（失败提示由拦截器统一弹） */
async function confirmPlan() {
  try {
    await savePlan()
    router.push({ name: 'project-detail', params: { id: String(route.params.id) } })
  } catch {
    /* 拦截器已提示，留在本页继续改 */
  }
}
</script>

<template>
  <div class="view">
    <TopBar>
      <template #context>
        <button class="tb-back btn btn-sm btn-ghost" @click="goBack">← 返回</button>
        <span class="tb-title">
          <span class="dim">{{ projectName }} ·</span> 架构师工作台
        </span>
        <span class="sheet-no">ARCH-{{ String(projectId).padStart(4, '0') }}-D</span>
      </template>
      <template #right>
        <button class="btn btn-primary" @click="confirmPlan">确认方案</button>
      </template>
    </TopBar>

    <main class="page desk">
      <!-- ===== 左桌：三张单 ===== -->
      <div class="desk-left">
        <!-- 值班牌 -->
        <section class="panel rolecard">
          <header class="rc-head">
            <img class="rc-avatar" :src="currentRole.avatar" :alt="currentRole.name" />
            <div class="rc-meta">
              <h2 class="rc-name">
                {{ currentRole.name }}
                <span class="sheet-no rc-badge">{{ currentRole.badge.toUpperCase() }}</span>
              </h2>
              <p class="rc-duty dim">{{ currentRole.duty }}</p>
            </div>
            <span class="rc-status">
              <span class="lamp" :class="working ? 'lamp-on lamp-live' : ''"></span>
              <i class="faint">{{ working ? '工作中' : '待命' }}</i>
            </span>
          </header>
          <ul class="rows rc-tasks">
            <li v-for="t in currentRole.tasks()" :key="t.label" class="row" :class="{ done: t.done }">
              <IconCheck v-if="t.done" :size="15" :stroke-width="1.75" class="dico ok" />
              <IconCircle v-else :size="15" :stroke-width="1.75" class="dico" />
              {{ t.label }}
            </li>
          </ul>
        </section>

        <!-- 技术选型 -->
        <section class="panel block">
          <header class="panel-head">
            <h3 class="panel-title">技术选型</h3>
            <span class="hint faint">AI 预设 · 点击 ＋ 调整</span>
          </header>
          <div class="block-body stack-cloud">
            <span v-if="!techStack.length" class="stack-empty faint">暂无技术选型，点击 ＋ 添加</span>
            <span v-for="t in techStack" :key="t" class="chip">
              {{ t }}
              <button class="chip-x" :aria-label="`移除 ${t}`" @click="removeStack(t)">
                <IconX :size="12" :stroke-width="1.75" />
              </button>
            </span>
            <button class="chip chip-add" aria-label="添加技术" @click="openStackPicker">
              <IconPlus :size="13" :stroke-width="2" />
            </button>
          </div>
        </section>

        <!-- 开发阶段与计划 -->
        <section class="panel block">
          <header class="panel-head">
            <h3 class="panel-title">开发阶段与计划</h3>
            <span class="hint faint">AI 规划 · {{ phases.length }} 个阶段</span>
          </header>
          <div class="block-body phase-list">
            <div v-if="!phases.length" class="phase-empty faint">暂无开发计划，点击下方「＋ 新增阶段」开始规划</div>
            <div v-for="(p, i) in phases" :key="i" class="phase panel">
              <div class="ph-head">
                <span class="ph-num sheet-no">阶段 {{ i + 1 }}</span>
                <!-- 阶段名：点击铅笔 inline 编辑，回车/失焦保存 -->
                <input
                  v-if="editingPhaseName === i"
                  v-model="phaseNameDraft"
                  class="ph-input"
                  @keyup.enter="savePhaseName(i)"
                  @keyup.esc="editingPhaseName = null"
                  @blur="savePhaseName(i)"
                />
                <span v-else class="ph-name">{{ p.name }}</span>
                <span class="ph-count mono faint">{{ p.tasks.length }} 个任务</span>
                <span class="ph-ops">
                  <button class="ph-op" title="重命名阶段" @click="startEditPhaseName(i)">
                    <IconPencil :size="13" :stroke-width="1.75" />
                  </button>
                  <button class="ph-op del" title="删除阶段" @click="removePhase(i)">
                    <IconX :size="13" :stroke-width="1.75" />
                  </button>
                </span>
              </div>
              <!-- 进度：3px 细带（已存计划回显用） -->
              <div v-if="p.progress > 0" class="prog" :title="`进度 ${p.progress}%`">
                <div class="prog-fill" :style="{ width: p.progress + '%' }"></div>
              </div>
              <div class="ph-tags">
                <span v-for="t in p.tasks" :key="t" class="chip">
                  {{ t }}
                  <button class="chip-x" :aria-label="`删除任务 ${t}`" title="删除任务" @click="removeTask(i, t)">
                    <IconX :size="11" :stroke-width="1.75" />
                  </button>
                </span>
                <!-- 添加任务（inline 输入） -->
                <input
                  v-if="addingTaskIn === i"
                  v-model="taskDraft"
                  class="ph-task-input"
                  placeholder="任务名称，回车添加"
                  @keyup.enter="addTask(i)"
                  @keyup.esc="addingTaskIn = null"
                  @blur="addTask(i)"
                />
                <button v-else class="chip chip-add" title="添加任务" @click="startAddTask(i)">＋ 任务</button>
              </div>
            </div>
          </div>
          <footer class="block-foot">
            <button class="btn btn-sm" @click="addPhase">＋ 新增阶段</button>
          </footer>
        </section>

        <!-- 项目目录 -->
        <section class="panel block">
          <header class="panel-head">
            <h3 class="panel-title">项目目录</h3>
            <span class="hint faint">架构师设计 · 右键更多操作</span>
          </header>
          <div class="tree-tools">
            <button class="btn btn-sm" @click="treeRef?.addAt('file')">＋ 文件</button>
            <button class="btn btn-sm" @click="treeRef?.addAt('dir')">＋ 目录</button>
            <button class="btn btn-sm" :disabled="!treeRef?.hasClip()" @click="treeRef?.pasteAtRoot()">粘贴</button>
          </div>
          <SheetTree ref="treeRef" :nodes="dirTree" />
        </section>
      </div>

      <!-- ===== 右席：与架构师对谈 ===== -->
      <aside class="desk-right panel chat">
        <header class="panel-head">
          <span class="panel-title">与架构师沟通方案</span>
          <span class="hint faint">询问理由 · 提出调整</span>
        </header>
        <div ref="chatBody" class="chat-body">
          <div v-for="(m, i) in archMessages" :key="i" class="msg" :class="m.role">
            <img v-if="m.role === 'assistant'" class="msg-avatar" :src="avatarArch" alt="架构师" />
            <div class="msg-bubble">{{ m.content }}</div>
          </div>
          <div v-if="thinking" class="msg assistant">
            <img class="msg-avatar" :src="avatarArch" alt="架构师" />
            <div class="msg-bubble typing"><span class="tdot"></span><span class="tdot"></span><span class="tdot"></span></div>
          </div>
        </div>
        <div class="chat-input">
          <textarea
            v-model="draft"
            class="textarea ci-area"
            rows="2"
            placeholder="如：为什么用 MySQL？/ 后端换 Node.js...（Enter 发送）"
            @keydown.enter.exact.prevent="send"
          ></textarea>
          <button class="btn btn-primary ci-send" :disabled="!draft.trim() || thinking" aria-label="发送" @click="send">
            <IconSend :size="16" :stroke-width="1.75" />
          </button>
        </div>
      </aside>
    </main>

    <!-- 技术选型弹窗（两段式待选） -->
    <AppModal v-if="showStackPicker" title="添加技术" sheet="TECH-PICK" width="680px" @close="showStackPicker = false">
      <nav class="cat-tabs" aria-label="技术分类">
        <button
          v-for="cat in categories"
          :key="cat.key"
          class="cat-tab"
          :class="{ active: activeCat === cat.key }"
          @click="activeCat = cat.key"
        >
          {{ cat.label }}
        </button>
      </nav>

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
          <IconCheck v-if="techStack.includes(t) || isPicked(t)" :size="13" :stroke-width="2" class="tech-tick" />
        </button>
        <p v-if="!filteredTech.length" class="tech-empty faint">该分类暂无更多技术</p>
      </div>

      <!-- 自定义添加（加入待选） -->
      <div class="custom-add">
        <input
          v-model="customStack"
          class="input"
          type="text"
          placeholder="自定义技术名称，如：Docker Compose"
          @keyup.enter="addCustomStack"
        />
        <button class="btn" @click="addCustomStack">加入待选</button>
      </div>

      <!-- 底部操作：取消 / 确定（新增并关闭） -->
      <template #footer>
        <button class="btn btn-sm" @click="showStackPicker = false">取消</button>
        <button class="btn btn-sm btn-primary" :disabled="!pickingStack.length" @click="confirmStackPicker">
          确定（{{ pickingStack.length }}）
        </button>
      </template>
    </AppModal>
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

/* ===== 双栏绘图桌 ===== */
.desk {
  display: grid;
  grid-template-columns: minmax(0, 1.08fr) minmax(0, 0.92fr);
  gap: 18px;
  align-items: start;
}
.desk-left {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.block-body {
  padding: 14px 16px 16px;
}
.hint {
  font-size: var(--fs-meta);
  margin-left: auto;
}
.panel-head .btn {
  margin-left: 8px;
}

/* ===== 值班牌 ===== */
.rolecard {
  padding: 16px 18px 6px;
}
.rc-head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.rc-avatar {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  border: 1px solid var(--line-2);
  object-fit: cover;
  flex: none;
}
.rc-meta {
  flex: 1;
  min-width: 0;
}
.rc-name {
  font-size: 16px;
  font-weight: 700;
  display: flex;
  align-items: center;
  gap: 8px;
}
.rc-badge {
  font-size: 10px;
  border: 1px solid currentColor;
  padding: 0 5px;
  border-radius: var(--r-xs);
}
.rc-duty {
  font-size: var(--fs-meta);
  margin-top: 2px;
}
.rc-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
}
.rc-status i {
  font-style: normal;
  font-size: var(--fs-meta);
}
.rc-tasks .row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--ink-2);
}
.rc-tasks .row.done {
  color: var(--ink);
}
.dico {
  color: var(--ink-3);
  flex: none;
}
.dico.ok {
  color: var(--pass-ink);
}

/* ===== 技术气泡 ===== */
.stack-cloud {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.stack-empty {
  font-size: 13px;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border: 1px solid var(--line-2);
  border-radius: var(--r);
  background: var(--paper);
  font-size: 13px;
  font-weight: 500;
}
.chip-x {
  color: var(--ink-3);
  display: inline-flex;
}
.chip-x:hover {
  color: var(--void-ink);
}
.chip-add {
  color: var(--cyan);
  border-style: dashed;
  cursor: pointer;
}
.chip-add:hover {
  background: var(--cyan-wash);
  border-style: solid;
}

/* ===== 阶段 ===== */
.phase-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.phase-empty {
  font-size: 13px;
  padding: 6px 2px;
}
.phase {
  padding: 10px 12px;
  background: var(--paper);
}
.ph-head {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.ph-num {
  flex: none;
}
.ph-name {
  font-weight: 600;
  font-size: 14px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ph-input {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  padding: 2px 8px;
  border: 1px solid var(--cyan);
  border-radius: var(--r-xs);
  background: #fff;
  outline: none;
}
.ph-count {
  margin-left: auto;
  font-size: var(--fs-meta);
  flex: none;
}
.ph-ops {
  display: inline-flex;
  gap: 2px;
  flex: none;
}
.ph-op {
  padding: 3px;
  color: var(--ink-3);
  border-radius: var(--r-xs);
}
.ph-op:hover {
  color: var(--cyan);
  background: var(--cyan-wash);
}
.ph-op.del:hover {
  color: var(--void-ink);
  background: var(--void-wash);
}
.prog {
  height: 3px;
  border-radius: 2px;
  background: var(--paper-deep);
  overflow: hidden;
  margin: 8px 0 2px;
}
.prog-fill {
  height: 100%;
  background: var(--cyan);
}
.ph-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin-top: 10px;
}
.ph-task-input {
  font-size: 13px;
  padding: 5px 10px;
  border: 1px solid var(--cyan);
  border-radius: var(--r);
  background: #fff;
  outline: none;
  min-width: 180px;
}
.block-foot {
  padding: 0 16px 14px;
}

/* ===== 目录工具条 ===== */
.tree-tools {
  display: flex;
  gap: 6px;
  padding: 10px 16px 2px;
}

/* ===== 会商席 ===== */
.chat {
  position: sticky;
  top: 74px;
  display: flex;
  flex-direction: column;
  height: calc(100dvh - 102px);
  min-height: 420px;
  overflow: hidden;
}
.chat-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.msg {
  display: flex;
  gap: 9px;
  align-items: flex-start;
}
.msg.user {
  justify-content: flex-end;
}
.msg-avatar {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  border: 1px solid var(--line-2);
  flex: none;
  object-fit: cover;
}
.msg-bubble {
  max-width: 78%;
  padding: 10px 13px;
  border-radius: 2px 10px 10px 10px;
  background: var(--paper-deep);
  border: 1px solid var(--line);
  font-size: 13px;
  line-height: 1.7;
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
  padding: 13px;
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
  display: flex;
  gap: 8px;
  padding: 12px;
  border-top: 1px solid var(--line);
  background: var(--paper);
  align-items: flex-end;
}
.ci-area {
  flex: 1;
  min-height: 44px;
  max-height: 120px;
}
.ci-send {
  height: 44px;
  width: 44px;
  padding: 0;
  flex: none;
}

/* ===== 选型弹窗 ===== */
.cat-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  border: 1px solid var(--line-2);
  border-radius: var(--r);
  padding: 3px;
  margin-bottom: 14px;
  background: var(--paper);
}
.cat-tab {
  padding: 5px 11px;
  border-radius: var(--r-xs);
  font-size: var(--fs-meta);
  font-weight: 500;
  color: var(--ink-2);
}
.cat-tab:hover {
  background: var(--cyan-wash);
  color: var(--cyan);
}
.cat-tab.active {
  background: var(--cyan);
  color: #f3f6f8;
}
.tech-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 8px;
  max-height: 320px;
  overflow-y: auto;
  padding: 2px;
}
.tech-btn {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 9px 8px;
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--paper);
  font-size: 13px;
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.tech-btn:hover:not(:disabled) {
  border-color: var(--cyan);
}
.tech-btn.picked {
  border-color: var(--cyan);
  background: var(--cyan-wash-2);
  color: var(--cyan);
  font-weight: 600;
}
.tech-btn.added {
  color: var(--ink-3);
  background: var(--paper-deep);
  cursor: not-allowed;
}
.tech-tick {
  color: var(--cyan);
  flex: none;
}
.tech-empty {
  grid-column: 1 / -1;
  text-align: center;
  font-size: 13px;
  padding: 20px 0;
}
.custom-add {
  display: flex;
  gap: 8px;
  margin-top: 14px;
}
.custom-add .input {
  flex: 1;
}

@media (max-width: 980px) {
  .desk {
    grid-template-columns: 1fr;
  }
  .chat {
    position: static;
    height: 520px;
  }
}
</style>
