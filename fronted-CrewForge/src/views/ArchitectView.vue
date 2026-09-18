<script setup lang="ts">
/* ============================================================
   架构师工作台（/projects/:id/architect）
   ------------------------------------------------------------
   世界观：这里 = 出图前的绘图桌。左桌三张单（选型 / 阶段 / 目录），
   右席与架构师对谈（仍是本地 mock，回复分支逐字保留）。
   「确认方案」一次性 PUT：techStack/devPlan/dirTree + status=planning。
   devPlan 双形状容错口径与 ProjectDetailView 完全一致，不许漂移。
   ============================================================ */
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
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
import { answerConfirm, fetchConfirmHistory, fetchPendingConfirms, parseOptions, type ConfirmQuestion } from '../api/confirm'
import { fetchProjectById, updateProject } from '../api/project'
import { ENVELOPE_KEYS, buildDevPlanJson, buildTechStackJson, parseArchPlan, parseEnvelopeArray, toStringList } from '../utils/json'
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

/* ===== 架构师方案（引擎 tech_stack 信封的结构化产物，只读） =====
   为什么单开一块（9/18）：引擎写的这几块内容以前在页面上**完全看不见** ——
     why          技术理由（整段话）
     moduleTech   [{module, backend, frontend}]  分模块技术选型
     tables       [{name, fields:[{name,type,remark,required}], purpose}]
     techniques   {database:{type,why}, middleware:[{name,purpose}]}
   它们在"技术选型"标签云里只会被 toDisplayList 兜底成 JSON.stringify 的一坨
   （认不出 name/title/label/summary 就整体序列化）。
   现网 10 个项目全是这个信封，等于架构师产出的方案一直在页面上是一堆乱码。
   解析逻辑是 utils/json.ts 的纯函数 parseArchPlan（那边能用真实库数据跑测试，
   这里只负责画）。只读展示：要改技术栈请在标签云里加减，
   保存时 buildTechStackJson 会在底稿上保结构合并。 */
const archPlan = computed(() => parseArchPlan(techStackEnvelope.value))
const hasArchPlan = computed(() => archPlan.value.has)

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
    // ⚠️ 9/18：标签云只吃**网页自己写的扁平清单**（technologies）。
    //    原来用 ENVELOPE_KEYS.techStack（一路退到 moduleTech/tables），
    //    那两个是对象数组，toDisplayList 认不出就 JSON.stringify —— 页面上把
    //    {"module":"用户登录与退出","backend":"…","frontend":"…"} 当标签印出来。
    //    引擎的结构化方案改由下面「架构师方案」面板渲染。
    techStack.value = toStringList(parseEnvelopeArray(p.techStack, ENVELOPE_KEYS.techStackPageList))

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
  } catch (e) {
    projectName.value = '项目 #' + route.params.id
    // 项目已经没了（在别处删掉）→ 不进对话轮询，否则每 4 秒撞一次「项目不存在」
    if (isProjectGone(e)) {
      markProjectGone()
      return
    }
  }
  // 对话：先补历史（刷新后对话还在），再起 4s 轮询等新题（与需求对话页同频）
  await loadArchHistory()
  await pollArch()
  if (!projectGone.value) pollTimer = setInterval(pollArch, 4000)
})

onUnmounted(stopPolling)

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

/* ============================================================
   与架构师对谈 —— 真接引擎确认门（9/18）
   ------------------------------------------------------------
   架构师在出方案前会追问关键决策（architect.ts 的 consult 节点，LLM 生成），
   问题经 HttpQuestioner 落 sys_confirm（node='architect'），本页轮询取来展示、
   把人的回答 POST 回去 → 引擎取到答复继续同一张图。
   跟需求对话页是同一条链，只是 node 过滤不同：
     manager   = PM 澄清（需求对话页）
     architect = 架构师澄清（本页）
   为什么以前这里是假的：archReply() 是几个正则回预置文案（"为什么用 MySQL？"
   会得到一段固定话术）。现在显示的每一句都是引擎里 LLM 真正问出来的。
   ⚠️ 架构师澄清最多 3 问（引擎侧提示词约束 + runWithInteraction 轮次上限），
      所以这框不是无限闲聊，是"他在开工前把关键决策问清楚"。
   ============================================================ */

const archMessages = ref<ChatMessage[]>([])
const draft = ref('')
const thinking = ref(false)
const working = ref(false)
const chatBody = ref<HTMLElement | null>(null)

/** 当前待答的那道架构师提问；null = 没有待答 */
const archPending = ref<ConfirmQuestion | null>(null)
const answering = ref(false)
/** 已上屏的 questionId：4s 一轮，不去重会重复刷气泡 */
const shownQuestions = new Set<string>()
/** 项目被删（在别处删掉）→ 停轮询，别再每 4 秒撞一次「项目不存在」 */
const projectGone = ref(false)
let pollTimer: ReturnType<typeof setInterval> | null = null

function isProjectGone(e: unknown): boolean {
  return e instanceof Error && e.message.includes('项目不存在')
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
}
function markProjectGone() {
  if (projectGone.value) return
  projectGone.value = true
  stopPolling()
  thinking.value = false
  working.value = false
  archPending.value = null
  console.warn('[architect] 项目已不存在，停止轮询（这不是网络问题）')
}

/** 按库里记录重建对话：架构师问过的 + 人答过的（刷新后还在） */
async function loadArchHistory() {
  try {
    const rows = (await fetchConfirmHistory(projectId.value)).filter((c) => c.node === 'architect')
    for (const c of rows) {
      if (shownQuestions.has(c.questionId)) continue
      shownQuestions.add(c.questionId)
      archMessages.value.push({ role: 'assistant', content: c.question })
      if (c.status !== 'pending' && c.reply) {
        archMessages.value.push({
          role: 'user',
          content: c.status === 'auto_passed' ? `${c.reply}（超时无人应答，自动放行）` : c.reply,
        })
      }
    }
    scrollToBottom()
  } catch (e) {
    if (isProjectGone(e)) markProjectGone()
  }
}

/** 轮询：有没有新的架构师提问 */
async function pollArch() {
  const id = projectId.value
  if (!id || projectGone.value) return
  try {
    const pending = (await fetchPendingConfirms(id)).filter((c) => c.node === 'architect')
    archPending.value = pending.length ? pending[pending.length - 1]! : null
    if (pending.some((c) => !shownQuestions.has(c.questionId))) await loadArchHistory()
  } catch (e) {
    if (isProjectGone(e)) markProjectGone()
  }
}

/** 答复当前这道题 → 引擎取到答复就继续出方案 */
async function send() {
  const q = archPending.value
  const text = draft.value.trim()
  if (!q || !text || answering.value) return
  answering.value = true
  try {
    await answerConfirm(q.id, text)
    archMessages.value.push({ role: 'user', content: text })
    draft.value = ''
    archPending.value = null
    scrollToBottom()
    await pollArch()
  } catch (e) {
    if (isProjectGone(e)) markProjectGone()
  } finally {
    answering.value = false
  }
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

        <!-- 技术选型（你自己确认的扁平清单；引擎的结构化方案在下面那块只读面板里） -->
        <section class="panel block">
          <header class="panel-head">
            <h3 class="panel-title">技术选型</h3>
            <span class="hint faint">点击 ＋ 调整 · 随方案提交</span>
          </header>
          <div class="block-body stack-cloud">
            <span v-if="!techStack.length" class="stack-empty faint">
              <template v-if="hasArchPlan">还没确认自己的选型——架构师的建议见下方「架构师方案」</template>
              <template v-else>暂无技术选型，点击 ＋ 添加</template>
            </span>
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

        <!-- 架构师方案（引擎 tech_stack 信封，只读） -->
        <section v-if="hasArchPlan" class="panel block">
          <header class="panel-head">
            <h3 class="panel-title">架构师方案</h3>
            <span class="hint faint">引擎产出 · 只读</span>
          </header>
          <div class="block-body arch-plan">
            <p v-if="archPlan.why" class="arch-why">{{ archPlan.why }}</p>

            <div v-if="archPlan.moduleTech.length" class="arch-sub">
              <h4 class="arch-h">分模块技术选型</h4>
              <ul class="rows">
                <li v-for="m in archPlan.moduleTech" :key="m.module" class="row arch-mod">
                  <span class="arch-mod-name">{{ m.module }}</span>
                  <span class="arch-mod-tech">
                    <span class="arch-tag">后端</span>{{ m.backend }}
                  </span>
                  <span class="arch-mod-tech">
                    <span class="arch-tag">前端</span>{{ m.frontend }}
                  </span>
                </li>
              </ul>
            </div>

            <div v-if="archPlan.dbType || archPlan.middleware.length" class="arch-sub">
              <h4 class="arch-h">数据库与中间件</h4>
              <p v-if="archPlan.dbType" class="arch-line">
                <span class="arch-tag">数据库</span>{{ archPlan.dbType.type }}
                <span v-if="archPlan.dbType.why" class="faint">—— {{ archPlan.dbType.why }}</span>
              </p>
              <p v-for="m in archPlan.middleware" :key="m.name" class="arch-line">
                <span class="arch-tag">中间件</span>{{ m.name }}
                <span v-if="m.purpose" class="faint">—— {{ m.purpose }}</span>
              </p>
            </div>

            <div v-if="archPlan.tables.length" class="arch-sub">
              <h4 class="arch-h">数据表</h4>
              <div v-for="t in archPlan.tables" :key="t.name" class="arch-table">
                <p class="arch-line">
                  <span class="arch-tag arch-tag-strong mono">{{ t.name }}</span>
                  <span v-if="t.purpose" class="faint">{{ t.purpose }}</span>
                </p>
                <ul class="rows arch-fields">
                  <li v-for="f in t.fields" :key="f.name" class="row arch-field">
                    <span class="arch-field-name mono">{{ f.name }}</span>
                    <span class="arch-field-type mono faint">{{ f.type }}</span>
                    <span v-if="f.required" class="arch-field-req">必填</span>
                    <span v-if="f.remark" class="arch-field-remark dim">{{ f.remark }}</span>
                  </li>
                </ul>
              </div>
            </div>
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

      <!-- ===== 右席：与架构师对谈（真接引擎确认门） ===== -->
      <aside class="desk-right panel chat">
        <header class="panel-head">
          <span class="panel-title">与架构师沟通方案</span>
          <span class="hint faint">他在开工前就关键决策提问</span>
        </header>
        <div ref="chatBody" class="chat-body">
          <!-- 项目没了：说清真相，别再让轮询反复撞 -->
          <div v-if="projectGone" class="chat-gone">
            <p><strong>这个项目已经不在了</strong>（很可能在列表里删掉了）。</p>
            <p class="faint">页面已停止轮询，不会再重复弹错。</p>
            <button class="btn btn-sm btn-primary" @click="router.push('/projects')">回项目台账</button>
          </div>

          <!-- 空对话：按真实状态说实话，不摆假招呼 -->
          <div v-else-if="!archMessages.length && !thinking" class="chat-empty faint">
            <template v-if="archPending">
              <p>架构师有问题等你回答，见下面那张卡。</p>
            </template>
            <template v-else>
              <p>还没有对话。</p>
              <p>架构师**在出方案前**会就关键决策提问（跑在哪、要不要登录、数据库怎么选这类），问题会出现在这里。</p>
              <p>引擎没在跑、或技术方案已经定完，他就不会再问了。</p>
            </template>
          </div>

          <div v-for="(m, i) in archMessages" :key="i" class="msg" :class="m.role">
            <img v-if="m.role === 'assistant'" class="msg-avatar" :src="avatarArch" alt="架构师" />
            <div class="msg-bubble">{{ m.content }}</div>
          </div>

          <!-- 待答题的选项按钮（架构师追问是自由文本，通常没有选项） -->
          <div v-if="archPending && parseOptions(archPending).length" class="chat-opts">
            <button
              v-for="opt in parseOptions(archPending)"
              :key="opt"
              class="btn btn-sm"
              :disabled="answering"
              @click="draft = opt; send()"
            >
              {{ opt }}
            </button>
          </div>

          <div v-if="thinking" class="msg assistant">
            <img class="msg-avatar" :src="avatarArch" alt="架构师" />
            <div class="msg-bubble typing"><span class="tdot"></span><span class="tdot"></span><span class="tdot"></span></div>
          </div>
        </div>
        <div v-if="archPending" class="chat-foot">
          <span class="hint faint">架构师在等你回答，答完他继续出方案</span>
        </div>
        <div v-else-if="!projectGone" class="chat-foot">
          <span class="hint faint">当前没有待答问题（技术选型/阶段/目录可在左侧直接改，点「确认方案」提交）</span>
        </div>
        <div class="chat-input">
          <textarea
            v-model="draft"
            class="textarea ci-area"
            rows="2"
            :placeholder="archPending ? '回答架构师的问题…（Enter 发送）' : '现在没有待答问题'"
            :disabled="!archPending || answering"
            @keydown.enter.exact.prevent="send"
          ></textarea>
          <button
            class="btn btn-primary ci-send"
            :disabled="!archPending || !draft.trim() || answering"
            aria-label="发送"
            @click="send"
          >
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

/* ===== 架构师方案（只读展示，9/18） =====
   一排"标签 + 正文"的读法：标签是字段名（后端/前端/数据库/表名），正文才是内容。
   长段（why/remark/purpose）压一档颜色，避免整块都是同一种黑。 */
.arch-plan {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.arch-why {
  font-size: 13px;
  line-height: 1.72;
  color: var(--ink-2);
  padding-left: 10px;
  border-left: 3px solid var(--line-2);
}
.arch-sub {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.arch-h {
  font-size: var(--fs-meta);
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--ink-3);
}
.arch-mod {
  flex-direction: column;
  align-items: flex-start;
  gap: 5px;
  padding: 10px 0;
}
.arch-mod-name {
  font-weight: 600;
  font-size: 13px;
}
.arch-mod-tech {
  font-size: 12px;
  line-height: 1.7;
  color: var(--ink-2);
}
.arch-tag {
  display: inline-block;
  min-width: 46px;
  margin-right: 8px;
  padding: 1px 6px;
  border: 1px solid var(--line);
  border-radius: var(--r-xs);
  background: var(--paper);
  font-size: 11px;
  color: var(--ink-3);
  text-align: center;
}
/* 表名那枚标签是"标题"不是字段名，给它压重一档 */
.arch-tag-strong {
  min-width: 0;
  font-weight: 600;
  color: var(--ink);
  background: var(--paper-deep);
}
.arch-line {
  font-size: 12px;
  line-height: 1.72;
  color: var(--ink-2);
}
.arch-table {
  padding: 8px 0;
}
.arch-fields {
  margin-top: 4px;
  padding-left: 8px;
  border-left: 1px dashed var(--line);
}
.arch-field {
  flex-wrap: wrap;
  gap: 8px;
  font-size: 12px;
  padding: 3px 0;
}
.arch-field-name {
  font-weight: 600;
  min-width: 88px;
}
.arch-field-type {
  font-size: 11px;
}
.arch-field-req {
  padding: 0 5px;
  border-radius: var(--r-xs);
  background: var(--paper-deep);
  color: var(--rust);
  font-size: 10px;
}
.arch-field-remark {
  flex: 1 1 100%;
  font-size: 11px;
  line-height: 1.6;
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
/* 空对话说明 / 待答选项 / 状态条 / 项目没了：9/18 接真确认门后新增
   （与需求对话页 CreateProjectView 同一套读法，两页长得一样才好认） */
.chat-empty {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: var(--fs-meta);
  line-height: 1.7;
}
.chat-opts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding-left: 39px; /* 与气泡对齐（头像 30 + 间隔 9） */
}
.chat-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px 0;
  border-top: 1px solid var(--line);
}
.chat-gone {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  padding: 14px;
  border: 1px solid var(--wait-ink);
  border-radius: var(--r);
  background: var(--paper);
  font-size: var(--fs-meta);
  line-height: 1.7;
}
.chat-gone strong {
  color: var(--wait-ink);
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
