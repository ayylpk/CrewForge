<script setup lang="ts">
/* ============================================================
   项目经理工作台 —— 需求对话页（/projects/:id/pm）
   ------------------------------------------------------------
   世界观：左 = 挂号栏（项目立项单逐项填写），右 = 会商席（与 Hina 对谈）。
   逻辑与旧版逐字对齐：form 字段 undefined 语义、独立保存三件套
   （名称/描述/模式选中即存）、功能清单校验文案。
   9/18：新建项目已改为台账页弹窗（components/ui/CreateProjectSheet.vue），
   本页不再有"新建模式"分支 —— 顺带删掉了随之失效的创建确认单
   （confirmItems/hasPending/showConfirm/tryCreate/confirmCreate）和单列布局 .desk-solo。
   聊天仍是本地 mock（用户消息只上屏不接 LLM——与旧版一致，不造假回复）。
   ============================================================ */
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  IconCheck,
  IconCircle,
  IconPlus,
  IconSend,
  IconX,
} from '@tabler/icons-vue'
import TopBar from '../components/ui/TopBar.vue'
import {
  answerConfirm,
  fetchConfirmHistory,
  fetchPendingConfirms,
  parseOptions,
  type ConfirmQuestion,
} from '../api/confirm'
import { fetchProjectById, updateProject } from '../api/project'
import { fetchRunStatus, startProjectRun } from '../api/projectRun'
import { MODE_NUM_TO_STR as SHARED_MODE_NUM_TO_STR } from '../constants/status'
import type { ConfirmMode, ProjectCreateDTO } from '../types/project'
import { ENVELOPE_KEYS, buildClarifiedReqJson, parseEnvelopeArray, toDisplayList } from '../utils/json'
import { toast } from '../utils/toast'

const router = useRouter()
const route = useRoute()

/**
 * 9/18：本页**只剩澄清模式**。
 *   原来是双模式（/projects/new 新建 + /projects/:id/pm 澄清），但两页配置区高度重复
 *   （用户实测反馈）—— 新建已退化成台账页里的弹窗（components/ui/CreateProjectSheet.vue）。
 *   所以这里不再有 isEdit 分支：:id 一定存在。
 */
const projectId = Number(route.params.id || 0)

// ===== 表单 =====（类型 = 后端 ProjectDTO 白名单，全字段集中在这，保存统一走 updateProject）
// ⚠️ 可选字段不能给 ''：空字符串会被后端 updateById 当真值覆盖；undefined 才表示"不修改"
const form = ref<ProjectCreateDTO>({
  name: '',
  description: '', // 项目描述：要做什么样子的项目
  confirmMode: 'mixed',
  // 以下可选字段：页面有输入/加载到值才赋值；undefined = 不发送 = 后端不修改
  clarifiedReq: undefined,
  businessModules: undefined,
  techStack: undefined,
  devPlan: undefined,
  status: undefined,
})

// ===== 工作台状态 =====
const working = ref(false) // 是否工作中（对话时点亮）
const saving = ref(false) // 澄清模式：保存功能清单中
const descSaving = ref(false) // 澄清模式：保存描述中
const nameSaving = ref(false) // 澄清模式：保存名称中
const modeSaving = ref(false) // 澄清模式：保存确认模式中

/* ===== 澄清阶段：已确认功能清单 =====
   ⚠️ 读 clarified_req，不是 business_modules（9/18 修「功能不实时添加」）：
     clarified_req    PM 澄清阶段**每轮确认后**累积写入（Node.ts saveClarifiedReq），
                      信封是 {features:[{name,description,priority,acceptance}]}
     business_modules 架构师拆分阶段才写（Node.ts saveArchitectOutput）
   本页整页就是澄清阶段，读 business_modules 的话 —— 对话聊完、PM 都定稿了，
   这列还是空的，页面永远显示"还没有确认功能"。数据其实一直在库里（实测 840 字/6 条）。
   兜底读 business_modules：老项目 clarified_req 可能没写过，有就显示。 */
const features = ref<string[]>([])
const featureDraft = ref('')

/** 后端 JSON 列解析：认裸数组，也认引擎写的信封对象（见 utils/json.ts） */
function parseJsonArr(raw?: string | null, keys: readonly string[] = ENVELOPE_KEYS.clarifiedReq): string[] {
  return toDisplayList(parseEnvelopeArray(raw, keys))
}

/** 本页的功能清单 = PM 的已确认功能；没有才退到架构师的业务模块 */
function pmFeaturesOf(p: { clarifiedReq?: string | null; businessModules?: string | null }): string[] {
  const pm = parseJsonArr(p.clarifiedReq)
  return pm.length ? pm : parseJsonArr(p.businessModules, ENVELOPE_KEYS.businessModules)
}

/** 数字 → 前端串：用 constants/status 的那一份（索引即 0/1/2），不再本地复制一份映射 */
const modeNumToStr = (n: number): ConfirmMode => SHARED_MODE_NUM_TO_STR[n] ?? 'mixed'
const MODE_LABELS: Record<ConfirmMode, string> = {
  green: '全绿灯模式',
  mixed: '混合模式',
  manual: '手动模式',
}

/** 回读项目的已确认功能清单（PM 每轮都写 clarified_req，所以轮询里调它 = 实时长出来） */
async function reloadFeatures() {
  try {
    const p = await fetchProjectById(projectId)
    features.value = pmFeaturesOf(p)
    form.value.clarifiedReq = p.clarifiedReq || undefined
    form.value.businessModules = p.businessModules || undefined
    form.value.status = p.status || undefined
  } catch (e) {
    if (isProjectGone(e)) markProjectGone()
  }
}

/** 进入时加载项目，填充名称/描述/已确认功能，并开始轮询确认门 */
onMounted(async () => {
  try {
    const p = await fetchProjectById(projectId)
    form.value.name = p.name
    form.value.description = p.description || ''
    form.value.confirmMode = modeNumToStr(p.confirmMode)
    // 全字段填充：有值才填，undefined 的字段保存时不发送（不会覆盖后端）
    form.value.clarifiedReq = p.clarifiedReq || undefined
    form.value.businessModules = p.businessModules || undefined
    form.value.techStack = p.techStack || undefined
    form.value.devPlan = p.devPlan || undefined
    form.value.status = p.status || undefined
    features.value = pmFeaturesOf(p)
  } catch (e) {
    // 项目已经没了（比如在另一个标签页删掉了）→ 立刻停手，别起轮询去反复撞
    if (isProjectGone(e)) {
      markProjectGone()
      return
    }
    /* 其余错误拦截器已提示，轮询照起（后端抖动还能自愈） */
  }
  // 对话：先补历史（刷新后对话还在），再起 4s 轮询等新题（与执行面板 CONFIRM_POLL 同频）
  await loadPmHistory()
  await pollPm()
  if (!projectGone.value) pollTimer = setInterval(pollPm, 4000)
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
})

const nameDone = computed(() => !!form.value.name.trim())
const modeDone = computed(() => !!form.value.confirmMode)
/** 功能清单是否已确认 */
const featureDone = computed(() => features.value.length > 0)
const phaseLabel = computed(() => {
  if (working.value) return '正在解析你的描述'
  return features.value.length > 0 ? `已确认 ${features.value.length} 项功能` : '等待确认具体功能'
})

/** 手动添加功能点（澄清模式）
 * ⚠️ 9/17 修"点了添加没反应"：原来空输入和"已存在"都是**静默 return/清空**，用户完全
 * 不知道发生了什么（同文件的 saveFeatures 却会给 warning，口径不一致）。
 * 现在两种失败都给出可读提示，成功也回一句——点了没有任何反馈本身就是 bug。 */
function addFeature() {
  const text = featureDraft.value.trim()
  if (!text) {
    toast.warning('请先输入功能点再点「添加」')
    return
  }
  if (features.value.includes(text)) {
    toast.warning(`「${text}」已经在清单里了`)
    featureDraft.value = ''
    return
  }
  features.value.push(text)
  featureDraft.value = ''
  toast.success(`已加入：${text}（记得点右上角「保存功能清单」落库）`)
}

/** 澄清模式：保存项目描述（只提交 description）
 * ⚠️ 9/17 修「devPlan 必须是 JSON 数组」：
 *   原来这里是 `updateProject(projectId, { ...form.value })` —— 把进页面时读到的**整行**
 *   原样写回去。而库里 dev_plan/tech_stack/business_modules 有 19/12/13 行是引擎写的
 *   **对象信封**（{risks, phases, ...}），后端 validateJsonArray 只认数组 → 400 直接被拦。
 *   更糟的是：就算校验放过，这个往返也会用页面加载那一刻的旧值覆盖掉引擎后来写的内容。
 *   所以这里改成"只发我编辑的字段"—— 不碰我不拥有的数据。
 */
async function saveDescription() {
  descSaving.value = true
  try {
    await updateProject(projectId, { description: form.value.description })
  } finally {
    descSaving.value = false
  }
}

/** 澄清模式：保存项目名称（只提交 name，空值不落库） */
async function saveName() {
  const name = form.value.name.trim()
  if (!name) {
    toast.warning('项目名称不能为空')
    return
  }
  nameSaving.value = true
  try {
    await updateProject(projectId, { name })
  } finally {
    nameSaving.value = false
  }
}

/** 澄清模式：确认模式下拉选中即保存（只提交 confirmMode；confirmMode 转数字在 api 层） */
async function saveConfirmMode() {
  modeSaving.value = true
  try {
    await updateProject(projectId, { confirmMode: form.value.confirmMode })
  } finally {
    modeSaving.value = false
  }
}

/** 保存功能清单（写 clarified_req —— PM 澄清的那一列，本页的产物就住这里）
 *  ⚠️ 9/18 改：原来写 businessModules，那是**架构师的列**（Node.ts saveArchitectOutput）。
 *     写它会两头坏：① 本页读的是 clarified_req，保存完自己反而看不见刚存的东西；
 *     ② 架构师阶段一跑就把人手工加的条目覆盖掉。
 *  ⚠️ 形状走 buildClarifiedReqJson 保结构合并：页面手上只有名字，
 *     一把重建会把每条 description/priority/acceptance 静默冲掉。 */
async function saveFeatures() {
  if (!features.value.length) {
    toast.warning('还没有确认任何功能')
    return
  }
  saving.value = true
  try {
    const envelope = form.value.clarifiedReq ? (JSON.parse(form.value.clarifiedReq) as Record<string, unknown>) : null
    await updateProject(projectId, { clarifiedReq: buildClarifiedReqJson(envelope, features.value) })
    // 保存成功反馈 = 跳转到 overview 看到「已确认功能」清单本身，不再弹全局提示
    router.push({ name: 'project-detail', params: { id: String(projectId) }, hash: '#overview' })
  } finally {
    saving.value = false
  }
}

/* ===== 对话区：真接引擎确认门（9/18 起不再是本地 mock） =====
   链路本来就在（执行面板早在用），本页只是把它接上：
     引擎澄清阶段 projectRunner.ts → questioner.ask()
       → HttpQuestioner POST /api/confirm/engine/ask  → sys_confirm 落一行 pending
       → 本页轮询 GET /api/confirm/history           → PM 的题 + 我的答上屏
       → 人答 POST /api/confirm/{id}/answer
       → 引擎轮询 GET /api/confirm/engine/answer/{questionId} 取到答复 → 续跑
   ⚠️ 题面是 PM 的原话：引擎侧原先写死一句过场话，PM 真问的问题只进了引擎日志，
      确认门里躺着固定提示（9/18 同批修了 projectRunner.ts）。
   ⚠️ 全绿灯模式(confirmMode=0) 引擎自动定稿、**根本不会提问** ——
      所以下面有按当前模式说实话的空状态，而不是让人对着空聊天框干等。
   ⚠️ 只有澄清阶段（node=manager）的题归本页；架构师等别的题在执行面板答。 */

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  /** 该气泡对应的题（只有待答的那道才在下面接选项/输入框） */
  questionId?: string
  options?: string[]
}

const messages = ref<ChatMessage[]>([])
const draft = ref('')
const chatBody = ref<HTMLElement | null>(null)

/** 当前可答的那道题（后端行 id，答复用它）；null = 没有待答 */
const openQuestion = ref<ConfirmQuestion | null>(null)
const answering = ref(false)
/** 引擎在跑吗——没跑就不会有新问题，这时得说实话 */
const engineRunning = ref(false)
/** 别的节点的题挂着几道：本页不答，但提醒一句，别让人干等 */
const otherPending = ref(0)
/** 已上屏的 questionId：每 4s 一轮，不去重会重复刷气泡 */
const shownQuestions = new Set<string>()

let pollTimer: ReturnType<typeof setInterval> | null = null

/**
 * 项目没了（被删/换账号）—— 9/18 加。
 * 为什么必须有：这页的轮询是 4 秒一档，项目被删后每轮都吃一个
 * 「项目不存在: N」的业务错误（ProjectGuard.requireOwned 抛的），
 * 连起来就是"提示一直弹、永远不停"。**光靠 toast 去重只是变稀，正解是别再问**：
 * 一旦确认项目没了就停轮询、停对话，并在页面上把真相摆出来。
 * 判定靠文案（后端 ProjectGuard 的措辞是 '项目不存在: ' + id，稳定且只有这一处来源）。
 */
const projectGone = ref(false)

function isProjectGone(e: unknown): boolean {
  return e instanceof Error && e.message.includes('项目不存在')
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
}

/** 确认项目已不存在：停轮询 + 停值班灯，页面转为"项目没了"的说明态 */
function markProjectGone() {
  if (projectGone.value) return
  projectGone.value = true
  stopPolling()
  engineRunning.value = false
  working.value = false
  openQuestion.value = null
  console.warn('[pm] 项目已不存在，停止轮询（这不是网络问题）')
}

/** 引擎在跑但还没出题 = PM 正在读需求（点亮值班牌 + 打字指示） */
const thinking = computed(() => engineRunning.value && openQuestion.value === null)

/** 按库里记录重建对话：PM 的题 + 人答过的答。刷新后对话还在 */
async function loadPmHistory() {
  try {
    const rows = (await fetchConfirmHistory(projectId)).filter((c) => c.node === 'manager')
    for (const c of rows) {
      if (shownQuestions.has(c.questionId)) continue
      shownQuestions.add(c.questionId)
      messages.value.push({
        role: 'assistant',
        content: c.question,
        questionId: c.questionId,
        options: parseOptions(c),
      })
      // 已答/已放行的补一条"人说的话"（自动放行要标明，别让它看着像我答的）
      if (c.status !== 'pending' && c.reply) {
        messages.value.push({
          role: 'user',
          content: c.status === 'auto_passed' ? `${c.reply}（超时无人应答，自动放行）` : c.reply,
        })
      }
    }
    scrollToBottom()
  } catch (e) {
    // 后端抖动：本轮不上屏，下一轮再试；项目没了则是终局，停轮询
    if (isProjectGone(e)) markProjectGone()
  }
}

/** 轮询：有没有新题、引擎在不在跑，并保管"当前可答的那道" */
async function pollPm() {
  if (!projectId) return
  try {
    const [pending, status] = await Promise.all([
      fetchPendingConfirms(projectId),
      // 运行状态查询失败不算终局（后端重启期间也会失败）→ 单独吞掉，
      // 但注意：拦截器在这之前已经弹过 toast 了，所以这条 .catch 只挡自己的处理
      fetchRunStatus(projectId).catch(() => null),
    ])
    engineRunning.value = !!status?.running
    working.value = engineRunning.value // 值班牌那盏灯跟着引擎走，不再是个安慰灯
    const mine = pending.filter((c) => c.node === 'manager')
    otherPending.value = pending.length - mine.length
    openQuestion.value = mine.length ? mine[mine.length - 1]! : null
    if (mine.some((c) => !shownQuestions.has(c.questionId))) await loadPmHistory()
    // ⚠️ 清单每轮都回读：PM 是"确认一个写一次"（manager.ts 注释），
    //    不回读的话左侧要等整段对话结束才长出来（9/18 用户实测反馈"功能没有实时添加"）
    await reloadFeatures()
  } catch (e) {
    if (isProjectGone(e)) {
      // 项目被删 → 停轮询。不停的话每 4 秒就是一次「项目不存在」，提示弹个没完
      markProjectGone()
      return
    }
    /* 后端抖动：本轮不动，下一轮再试（对话是增强，不拦页面） */
  }
}

/** 答复当前这道题 → 引擎取到答复就续跑 */
async function sendPm() {
  const q = openQuestion.value
  const text = draft.value.trim()
  if (!q || !text || answering.value) return
  answering.value = true
  try {
    await answerConfirm(q.id, text)
    messages.value.push({ role: 'user', content: text })
    draft.value = ''
    openQuestion.value = null
    scrollToBottom()
    await pollPm()
    // 定稿后引擎会写 clarified_req → 左侧「已确认功能」会变，回读一次
    await reloadFeatures()
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

/** 起引擎：澄清阶段跑起来 PM 才会提问 */
const starting = ref(false)
async function startClarify() {
  if (starting.value || engineRunning.value) return
  starting.value = true
  try {
    await startProjectRun(projectId)
    toast.success('已开工，项目经理读完需求就会在这里提问')
    await pollPm()
  } catch (e) {
    // 项目被删了：开工请求会被 ProjectGuard 拒（"项目不存在"）→ 页面转说明态。
    // 原先这里没有 catch：点了开工只有右上角一个一闪而过的提示，
    // 页面上什么都不变 —— 用户看到的就是"我执行了但没有任何产出"。
    if (isProjectGone(e)) markProjectGone()
  } finally {
    starting.value = false
  }
}

// ===== 确认模式 =====
const modes: { value: ConfirmMode; label: string; desc: string }[] = [
  { value: 'green', label: '全绿灯模式', desc: 'AI 自动推进，只在交付时展示结果' },
  { value: 'mixed', label: '混合模式', desc: '在需求/技术栈/计划/团队 4 个节点确认' },
  { value: 'manual', label: '手动模式', desc: '每个阶段完成后由你确认通过' },
]

/** 返回项目概览（本页只有澄清模式，不需要"回列表"分支） */
function goOverview() {
  router.push({ name: 'project-detail', params: { id: String(projectId) }, hash: '#overview' })
}
</script>

<template>
  <div class="view">
    <TopBar>
      <template #context>
        <button class="tb-back btn btn-sm btn-ghost" @click="goOverview()">
          ← 返回
        </button>
        <span class="tb-title">
          <span class="dim">需求对话 ·</span>
          {{ form.name || '未命名项目' }}
        </span>
        <span class="sheet-no">{{ `PRJ-${String(projectId).padStart(4, '0')}-B` }}</span>
      </template>
      <template #right>
        <button class="btn btn-primary" :disabled="saving" @click="saveFeatures()">
          {{ saving ? '保存中…' : '保存功能清单' }}
        </button>
      </template>
    </TopBar>

    <main class="page desk">
      <!-- ===== 左：挂号栏 ===== -->
      <div class="desk-left">
        <!-- 项目经理值班牌 -->
        <section class="pm panel">
          <header class="pm-head">
            <img class="pm-avatar" src="../assets/agent-manager.png" alt="AI 项目经理" />
            <div class="pm-meta">
              <h2 class="pm-name">AI 项目经理 <span class="pm-badge sheet-no">HINA</span></h2>
              <p class="pm-duty dim">
                {{ phaseLabel }} · 正在{{ working ? '整理你的描述...' : '确认项目功能' }}
              </p>
            </div>
            <span class="pm-status">
              <span class="lamp" :class="working ? 'lamp-on lamp-live' : ''"></span>
              <i class="faint">{{ working ? '工作中' : '待命' }}</i>
            </span>
          </header>
          <!-- 职责清单：会签核对项 -->
          <ul class="duty rows">
            <li class="row" :class="{ done: featureDone }">
              <IconCheck v-if="featureDone" :size="15" :stroke-width="1.75" class="dico ok" />
              <IconCircle v-else :size="15" :stroke-width="1.75" class="dico" />
              确认具体功能
            </li>
            <li class="row" :class="{ done: nameDone }">
              <IconCheck v-if="nameDone" :size="15" :stroke-width="1.75" class="dico ok" />
              <IconCircle v-else :size="15" :stroke-width="1.75" class="dico" />
              确定项目名称
            </li>
            <li class="row" :class="{ done: modeDone }">
              <IconCheck v-if="modeDone" :size="15" :stroke-width="1.75" class="dico ok" />
              <IconCircle v-else :size="15" :stroke-width="1.75" class="dico" />
              选择确认模式
            </li>
          </ul>
        </section>

        <!-- 项目名称 -->
        <section class="panel block">
          <header class="panel-head">
            <h3 class="panel-title">项目名称</h3>
            <!-- 名称可修改，独立保存（不依赖「保存功能清单」） -->
            <button class="btn btn-sm" :disabled="nameSaving" @click="saveName()">
              {{ nameSaving ? '保存中...' : '保存名称' }}
            </button>
          </header>
          <div class="block-body">
            <input v-model="form.name" class="input" type="text" placeholder="如：CRM 客户管理系统" />
          </div>
        </section>

        <!-- 项目描述（要做什么样子的项目） -->
        <section class="panel block">
          <header class="panel-head">
            <h3 class="panel-title">项目描述</h3>
            <span class="hint faint">这个项目要做什么</span>
            <button class="btn btn-sm" :disabled="descSaving" @click="saveDescription()">
              {{ descSaving ? '保存中...' : '保存描述' }}
            </button>
          </header>
          <div class="block-body">
            <textarea
              v-model="form.description"
              class="textarea"
              rows="5"
              placeholder="描述这个项目要做什么样子的项目，如：为企业做一个 CRM 客户管理系统，管理客户档案、跟进销售过程、生成统计报表"
            ></textarea>
          </div>
        </section>

        <!-- 已确认功能 -->
        <section class="panel block">
          <header class="panel-head">
            <h3 class="panel-title">已确认功能</h3>
            <span class="hint mono faint">{{ features.length }} 项</span>
          </header>
          <div class="block-body">
            <ul v-if="features.length" class="rows feat-list">
              <li v-for="(f, i) in features" :key="i" class="row feat">
                <IconCheck :size="15" :stroke-width="1.75" class="dico ok" />
                <span class="feat-text">{{ f }}</span>
                <button class="feat-x" aria-label="移除该功能" @click="features.splice(i, 1)">
                  <IconX :size="13" :stroke-width="1.75" />
                </button>
              </li>
            </ul>
            <p v-else class="faint empty-tip">还没有确认功能——在右侧对话中澄清，或手动添加</p>

            <!-- 手动新增 -->
            <div class="feat-add">
              <input
                v-model="featureDraft"
                class="input"
                type="text"
                placeholder="输入功能点，如：报表导出 Excel"
                @keyup.enter="addFeature"
              />
              <button class="btn" @click="addFeature">
                <IconPlus :size="14" :stroke-width="1.75" />
                添加
              </button>
            </div>
          </div>
        </section>

        <!-- 确认模式 -->
        <section class="panel block">
          <header class="panel-head">
            <h3 class="panel-title">确认模式</h3>
          </header>
          <div class="block-body">
            <div class="field">
              <select v-model="form.confirmMode" class="select" :disabled="modeSaving" @change="saveConfirmMode()">
                <option v-for="m in modes" :key="m.value" :value="m.value">{{ m.label }}</option>
              </select>
              <span class="field-hint">选中即保存 · 当前：{{ MODE_LABELS[form.confirmMode] }}</span>
            </div>
          </div>
        </section>

        <!-- 参考文件面板已删（9/18）：整块是个空摆件——files 只进内存，创建/保存都不提交、
             刷新就没了，拖个 PDF 进去会以为附上了。宁可不摆这个假控件。 -->
      </div>

      <!-- ===== 右：会商席 ===== -->
      <aside class="desk-right panel chat">
        <header class="panel-head chat-head">
          <span class="panel-title">与项目经理沟通需求</span>
          <span class="hint faint">对话澄清 → 左侧确认功能清单</span>
        </header>
        <div ref="chatBody" class="chat-body">
          <!-- 项目没了：把真相摆在页面上，而不是让右上角每隔几秒闪一次错误 -->
          <div v-if="projectGone" class="chat-gone">
            <p><strong>这个项目已经不在了</strong>（很可能在另一个标签页或列表里删掉了）。</p>
            <p class="faint">页面已停止轮询，所以你不会再看到重复的错误提示。</p>
            <button class="btn btn-sm btn-primary" @click="router.push('/projects')">回项目台账</button>
          </div>

          <!-- 空对话：按当前真实状态说实话，而不是摆一段假招呼 -->
          <div v-else-if="!messages.length && !thinking" class="chat-empty faint">
            <template v-if="form.confirmMode === 'green'">
              <p>当前是<strong>全绿灯模式</strong>：项目经理不会提问，引擎会自动定稿并直接推进。</p>
              <p>想逐条确认功能，把左侧「确认模式」改成<strong>混合</strong>或<strong>手动</strong>，再点下面开工。</p>
            </template>
            <template v-else-if="engineRunning">
              <p>项目经理正在读你的需求，提问会出现在这里。</p>
            </template>
            <template v-else>
              <p>还没有对话——引擎没在跑，项目经理也就没机会提问。</p>
            </template>
          </div>

          <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.role">
            <img v-if="m.role === 'assistant'" class="msg-avatar" src="../assets/agent-manager.png" alt="Hina" />
            <div class="msg-bubble">{{ m.content }}</div>
          </div>

          <!-- 最后一题还没答 → 选项按钮（点一下即答） -->
          <div v-if="openQuestion && parseOptions(openQuestion).length" class="chat-opts">
            <button
              v-for="opt in parseOptions(openQuestion)"
              :key="opt"
              class="btn btn-sm"
              :disabled="answering"
              @click="draft = opt; sendPm()"
            >
              {{ opt }}
            </button>
          </div>

          <div v-if="thinking" class="msg assistant">
            <img class="msg-avatar" src="../assets/agent-manager.png" alt="Hina" />
            <div class="msg-bubble typing"><span class="tdot"></span><span class="tdot"></span><span class="tdot"></span></div>
          </div>
        </div>
        <!-- 没在跑 → 开工；没题可答 → 说明为什么发不出去 -->
        <div v-if="projectGone" class="chat-foot">
          <span class="hint faint">项目已不存在，无法开工</span>
        </div>
        <div v-else-if="!engineRunning" class="chat-foot">
          <button class="btn btn-primary btn-sm" :disabled="starting" @click="startClarify">
            {{ starting ? '开工中…' : '开工，让项目经理提问' }}
          </button>
          <span class="hint faint">引擎跑起来，澄清对话才会发生</span>
        </div>
        <div v-else-if="!openQuestion" class="chat-foot">
          <span class="hint faint">
            项目经理没有待答问题
            <template v-if="otherPending">（有 {{ otherPending }} 道别的节点的题，去执行面板答）</template>
          </span>
        </div>

        <div class="chat-input">
          <textarea
            v-model="draft"
            class="textarea ci-area"
            rows="2"
            :placeholder="openQuestion ? '回答项目经理的问题…（Enter 发送）' : '现在没有待答问题，先把上面那道题答完'"
            :disabled="!openQuestion || answering"
            @keydown.enter.exact.prevent="sendPm"
          ></textarea>
          <button
            class="btn btn-primary ci-send"
            :disabled="!openQuestion || !draft.trim() || answering"
            aria-label="发送"
            @click="sendPm"
          >
            <IconSend :size="16" :stroke-width="1.75" />
          </button>
        </div>
      </aside>
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

/* ===== 双栏绘图台 ===== */
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

/* ===== 值班牌 ===== */
.pm {
  padding: 16px 18px 6px;
}
.pm-head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.pm-avatar {
  width: 48px;
  height: 48px;
  border-radius: 50%; /* 圆章式头像 */
  border: 1px solid var(--line-2);
  object-fit: cover;
  flex: none;
}
.pm-meta {
  flex: 1;
  min-width: 0;
}
.pm-name {
  font-size: 16px;
  font-weight: 700;
  display: flex;
  align-items: center;
  gap: 8px;
}
.pm-badge {
  font-size: 10px;
  border: 1px solid currentColor;
  padding: 0 5px;
  border-radius: var(--r-xs);
}
.pm-duty {
  font-size: var(--fs-meta);
  margin-top: 2px;
}
.pm-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
}
.pm-status i {
  font-style: normal;
  font-size: var(--fs-meta);
}
.duty {
  margin-top: 10px;
}
.duty .row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 4px;
  font-size: 13px;
  color: var(--ink-2);
}
.duty .row.done {
  color: var(--ink);
}
.dico {
  color: var(--ink-3);
  flex: none;
}
.dico.ok {
  color: var(--pass-ink);
}

/* ===== 表单块 ===== */
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

/* 功能清单 */
.feat-text {
  flex: 1;
  min-width: 0;
  font-size: 13px;
}
.feat-x {
  color: var(--ink-3);
  padding: 2px;
  border-radius: var(--r-xs);
}
.feat-x:hover {
  color: var(--void-ink);
  background: var(--void-wash);
}
.empty-tip {
  font-size: 13px;
  margin-bottom: 10px;
}
.feat-add {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
.feat-add .input {
  flex: 1;
}

/* 确认模式（9/18 起这里只有下拉了；原 .mode-list/.mode-item/.mode-label/.mode-desc
   那套单选卡样式随新建模式一起删掉） */

/* 上传区（.upload-zone/.file-list/.file-name）已随「参考文件」面板删除（9/18） */

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
.chat-head .hint {
  margin-left: 0;
}
.chat-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
/* 空对话的说明 / 待答题的选项按钮 / 开工条：9/18 接真对话后新增 */
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
.chat-empty {
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: var(--fs-meta);
  line-height: 1.7;
}
.chat-empty strong {
  color: var(--cyan);
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
  background: var(--cyan); /* 我方发言：章面压青，白字 */
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

/* ===== 确认单弹窗的 .cm-* 样式已随新建模式删除（弹窗本体在 CreateProjectSheet 里） ===== */

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
