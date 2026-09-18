<script setup lang="ts">
/* ============================================================
   项目经理工作台（/projects/new 新建 ｜ /projects/:id/pm 澄清）
   ------------------------------------------------------------
   世界观：左 = 挂号栏（项目立项单逐项填写），右 = 会商席（与 Hina 对谈）。
   逻辑与旧版逐字对齐：form 字段 undefined 语义、独立保存三件套
   （名称/描述/模式选中即存）、功能清单校验文案、创建前确认单。
   聊天仍是本地 mock（用户消息只上屏不接 LLM——与旧版一致，不造假回复）。
   ============================================================ */
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  IconCheck,
  IconCircle,
  IconFile,
  IconPlus,
  IconSend,
  IconUpload,
  IconX,
} from '@tabler/icons-vue'
import AppModal from '../components/ui/AppModal.vue'
import TopBar from '../components/ui/TopBar.vue'
import { createProject as createProjectApi, fetchProjectById, updateProject } from '../api/project'
import { MODE_NUM_TO_STR as SHARED_MODE_NUM_TO_STR } from '../constants/status'
import type { ConfirmMode, ProjectCreateDTO } from '../types/project'
import { ENVELOPE_KEYS, parseEnvelopeArray, toDisplayList } from '../utils/json'
import { toast } from '../utils/toast'

const router = useRouter()
const route = useRoute()

/**
 * 双模式工作台：
 * · /projects/new      新建模式 —— 定项目描述 → 创建项目
 * · /projects/:id/pm   澄清模式 —— 加载项目 → 确认具体功能 → 保存
 */
const isEdit = computed(() => !!route.params.id)
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

// ===== 澄清模式：已确认功能清单（从项目 businessModules 加载） =====
const features = ref<string[]>([])
const featureDraft = ref('')

/** 后端 JSON 列解析：认裸数组，也认引擎写的信封对象（见 utils/json.ts） */
function parseJsonArr(raw?: string | null): string[] {
  return toDisplayList(parseEnvelopeArray(raw, ENVELOPE_KEYS.businessModules))
}

/** 数字 → 前端串：用 constants/status 的那一份（索引即 0/1/2），不再本地复制一份映射 */
const modeNumToStr = (n: number): ConfirmMode => SHARED_MODE_NUM_TO_STR[n] ?? 'mixed'
const MODE_LABELS: Record<ConfirmMode, string> = {
  green: '全绿灯模式',
  mixed: '混合模式',
  manual: '手动模式',
}

/** 澄清模式：进入时加载项目，填充名称/描述/已确认功能 */
onMounted(async () => {
  if (!isEdit.value) return
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
    features.value = parseJsonArr(p.businessModules)
  } catch {
    /* 拦截器已提示 */
  }
})

const nameDone = computed(() => !!form.value.name.trim())
const descDone = computed(() => !!form.value.description.trim())
const modeDone = computed(() => !!form.value.confirmMode)
/** 澄清模式：功能清单是否已确认；新建模式：描述是否已填 */
const featureDone = computed(() => (isEdit.value ? features.value.length > 0 : descDone.value))
const phaseLabel = computed(() => {
  if (working.value) return '正在解析你的描述'
  if (isEdit.value) return features.value.length > 0 ? `已确认 ${features.value.length} 项功能` : '等待确认具体功能'
  if (!descDone.value) return '等待描述项目需求'
  return '项目描述已确认'
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

/** 澄清模式：保存功能清单（只提交 businessModules —— 这一列归本页所有） */
async function saveFeatures() {
  if (!features.value.length) {
    toast.warning('还没有确认任何功能')
    return
  }
  saving.value = true
  try {
    await updateProject(projectId, { businessModules: JSON.stringify(features.value) })
    // 保存成功反馈 = 跳转到 overview 看到「已确认功能」清单本身，不再弹全局提示
    router.push({ name: 'project-detail', params: { id: String(projectId) }, hash: '#overview' })
  } finally {
    saving.value = false
  }
}

/** 确认弹窗里的完成项列表 */
const confirmItems = computed(() => [
  { label: '项目名称', done: nameDone.value },
  { label: '描述项目需求', done: descDone.value },
  { label: '选择确认模式', done: modeDone.value },
  { label: '收集参考文件（可选）', done: true },
])
const hasPending = computed(() => confirmItems.value.some((c) => !c.done))

// ===== 文件上传（开发期只记录文件名） =====
const files = ref<File[]>([])
const fileInput = ref<HTMLInputElement | null>(null)
const isDragging = ref(false)
function onDrop(e: DragEvent) {
  isDragging.value = false
  files.value.push(...Array.from(e.dataTransfer?.files || []))
}
function pickFile() {
  fileInput.value?.click()
}
function onPick(e: Event) {
  files.value.push(...Array.from((e.target as HTMLInputElement).files || []))
}

// ===== 对话区（本地 mock：只上屏用户消息，不接 LLM——与旧版一致） =====
interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

const messages = ref<ChatMessage[]>(
  isEdit.value
    ? [
        {
          role: 'assistant',
          content:
            '你好，我是 AI 项目经理 Hina。项目描述已经确认了，现在来确认具体功能——描述一个功能点，或直接在左侧清单里增删，完成后点右上角「保存功能清单」。',
        },
      ]
    : [
        {
          role: 'assistant',
          content:
            '你好，我是 AI 项目经理 Hina。请描述这个项目要做什么样子的项目：面向谁、解决什么问题、主要做哪些事。我会帮你把描述整理成项目描述，确认后创建项目。',
        },
      ],
)

const draft = ref('')
const thinking = ref(false)
const chatBody = ref<HTMLElement | null>(null)

function send() {
  const text = draft.value.trim()
  if (!text || thinking.value) return

  // 用户消息
  messages.value.push({ role: 'user', content: text })
  draft.value = ''
  working.value = true
  scrollToBottom()

  working.value = false
  scrollToBottom()
}

function scrollToBottom() {
  nextTick(() => {
    if (chatBody.value) {
      chatBody.value.scrollTop = chatBody.value.scrollHeight
    }
  })
}

// ===== 确认模式 =====
const modes: { value: ConfirmMode; label: string; desc: string }[] = [
  { value: 'green', label: '全绿灯模式', desc: 'AI 自动推进，只在交付时展示结果' },
  { value: 'mixed', label: '混合模式', desc: '在需求/技术栈/计划/团队 4 个节点确认' },
  { value: 'manual', label: '手动模式', desc: '每个阶段完成后由你确认通过' },
]

// ===== 创建项目 =====
const creating = ref(false)
const showConfirm = ref(false)

/** 检查未完成项 → 弹确认框 */
function tryCreate() {
  if (!form.value.name.trim()) {
    toast.warning('请先填写项目名称')
    return
  }
  showConfirm.value = true
}

/** 返回：澄清模式直接回项目概览（不调 update）；新建模式回项目列表 */
function goOverview() {
  router.push({ name: 'project-detail', params: { id: String(projectId) }, hash: '#overview' })
}

/** 确认创建 */
async function confirmCreate() {
  showConfirm.value = false
  creating.value = true
  try {
    const payload = {
      ...form.value,
      name: form.value.name.trim(),
      description: form.value.description.trim(),
    }
    await createProjectApi(payload)
    router.push('/projects')
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <div class="view">
    <TopBar>
      <template #context>
        <button class="tb-back btn btn-sm btn-ghost" @click="isEdit ? goOverview() : router.push('/projects')">
          ← {{ isEdit ? '返回' : '项目列表' }}
        </button>
        <span class="tb-title">
          <span class="dim">{{ isEdit ? '需求对话 ·' : '新建项目 ·' }}</span>
          {{ isEdit ? form.name || '未命名项目' : '项目经理工作台' }}
        </span>
        <span class="sheet-no">{{ isEdit ? `PRJ-${String(projectId).padStart(4, '0')}-B` : 'FORM-A02' }}</span>
      </template>
      <template #right>
        <button class="btn btn-primary" :disabled="isEdit ? saving : creating" @click="isEdit ? saveFeatures() : tryCreate()">
          {{ isEdit ? (saving ? '保存中…' : '保存功能清单') : creating ? '创建中…' : '创建项目' }}
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
              {{ isEdit ? '确认具体功能' : '描述项目需求' }}
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
            <li class="row" :class="{ done: files.length > 0 }">
              <IconCheck v-if="files.length > 0" :size="15" :stroke-width="1.75" class="dico ok" />
              <IconCircle v-else :size="15" :stroke-width="1.75" class="dico" />
              收集参考文件
            </li>
          </ul>
        </section>

        <!-- 项目名称 -->
        <section class="panel block">
          <header class="panel-head">
            <h3 class="panel-title">项目名称</h3>
            <!-- 澄清模式：名称可修改，独立保存（不依赖「保存功能清单」） -->
            <button v-if="isEdit" class="btn btn-sm" :disabled="nameSaving" @click="saveName()">
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
            <button v-if="isEdit" class="btn btn-sm" :disabled="descSaving" @click="saveDescription()">
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

        <!-- 已确认功能（仅澄清模式） -->
        <section v-if="isEdit" class="panel block">
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
            <div v-if="!isEdit" class="mode-list" role="radiogroup" aria-label="确认模式">
              <button
                v-for="m in modes"
                :key="m.value"
                class="mode-item"
                :class="{ active: form.confirmMode === m.value }"
                role="radio"
                :aria-checked="form.confirmMode === m.value"
                @click="form.confirmMode = m.value"
              >
                <span class="mode-label">{{ m.label }}</span>
                <span class="mode-desc dim">{{ m.desc }}</span>
              </button>
            </div>
            <!-- 澄清模式：下拉重新选择，选中即保存 -->
            <div v-else class="field">
              <select v-model="form.confirmMode" class="select" :disabled="modeSaving" @change="saveConfirmMode()">
                <option v-for="m in modes" :key="m.value" :value="m.value">{{ m.label }}</option>
              </select>
              <span class="field-hint">选中即保存 · 当前：{{ MODE_LABELS[form.confirmMode] }}</span>
            </div>
          </div>
        </section>

        <!-- 参考文件 -->
        <section class="panel block">
          <header class="panel-head">
            <h3 class="panel-title">参考文件</h3>
            <span class="hint faint">可选</span>
          </header>
          <div class="block-body">
            <div
              class="upload-zone"
              :class="{ dragging: isDragging }"
              role="button"
              tabindex="0"
              @dragover.prevent="isDragging = true"
              @dragleave.prevent="isDragging = false"
              @drop.prevent="onDrop"
              @click="pickFile"
              @keydown.enter="pickFile"
            >
              <IconUpload :size="22" :stroke-width="1.75" />
              <p>拖拽文件到这里，或点击选择</p>
            </div>
            <ul v-if="files.length" class="rows file-list">
              <li v-for="(f, i) in files" :key="i" class="row file-item">
                <IconFile :size="14" :stroke-width="1.75" class="dico" />
                <span class="file-name mono">{{ f.name }}</span>
                <button class="feat-x" aria-label="移除文件" @click.stop="files.splice(i, 1)">
                  <IconX :size="13" :stroke-width="1.75" />
                </button>
              </li>
            </ul>
            <input ref="fileInput" type="file" multiple hidden @change="onPick" />
          </div>
        </section>
      </div>

      <!-- ===== 右：会商席 ===== -->
      <aside class="desk-right panel chat">
        <header class="panel-head chat-head">
          <span class="panel-title">与项目经理沟通需求</span>
          <span class="hint faint">{{ isEdit ? '对话澄清 → 左侧确认功能清单' : '描述项目 → 确认项目描述' }}</span>
        </header>
        <div ref="chatBody" class="chat-body">
          <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.role">
            <img v-if="m.role === 'assistant'" class="msg-avatar" src="../assets/agent-manager.png" alt="Hina" />
            <div class="msg-bubble">{{ m.content }}</div>
          </div>
          <div v-if="thinking" class="msg assistant">
            <img class="msg-avatar" src="../assets/agent-manager.png" alt="Hina" />
            <div class="msg-bubble typing"><span class="tdot"></span><span class="tdot"></span><span class="tdot"></span></div>
          </div>
        </div>
        <div class="chat-input">
          <textarea
            v-model="draft"
            class="textarea ci-area"
            rows="2"
            placeholder="描述这个项目要做什么，如：做一个选课系统，让学生选课、教师管理课程...（Enter 发送）"
            @keydown.enter.exact.prevent="send"
          ></textarea>
          <button class="btn btn-primary ci-send" :disabled="!draft.trim() || thinking" aria-label="发送" @click="send">
            <IconSend :size="16" :stroke-width="1.75" />
          </button>
        </div>
      </aside>
    </main>

    <!-- 创建确认弹窗（出图前核对单） -->
    <AppModal v-if="showConfirm" title="确认创建项目？" sheet="FORM-A02" width="460px" @close="showConfirm = false">
      <p class="cm-name">「{{ form.name }}」</p>
      <ul class="rows cm-list">
        <li v-for="c in confirmItems" :key="c.label" class="row cm-item">
          <IconCheck v-if="c.done" :size="15" :stroke-width="1.75" class="dico ok" />
          <IconCircle v-else :size="15" :stroke-width="1.75" class="dico" />
          <span class="cm-label" :class="{ pending: !c.done }">{{ c.label }}</span>
          <span class="cm-state faint" :class="{ no: !c.done }">{{ c.done ? '已完成' : '未完成' }}</span>
        </li>
      </ul>
      <p v-if="hasPending" class="cm-warn">以下内容未完成，创建后可在项目详情中继续补充</p>
      <template #footer>
        <button class="btn btn-sm" @click="showConfirm = false">再看看</button>
        <button class="btn btn-sm btn-primary" @click="confirmCreate">确认创建</button>
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

/* 确认模式 */
.mode-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.mode-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  text-align: left;
  padding: 10px 14px;
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--paper);
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.mode-item:hover {
  border-color: var(--cyan);
}
.mode-item.active {
  border-color: var(--cyan);
  background: var(--cyan-wash);
  box-shadow: inset 3px 0 0 var(--cyan); /* 左侧压青轨：选中即归档 */
}
.mode-label {
  font-weight: 600;
  font-size: 13px;
}
.mode-item.active .mode-label {
  color: var(--cyan);
}
.mode-desc {
  font-size: var(--fs-meta);
}

/* 上传区 */
.upload-zone {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 26px 16px;
  border: 1.5px dashed var(--line-2);
  border-radius: var(--r);
  color: var(--ink-2);
  cursor: pointer;
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.upload-zone:hover,
.upload-zone.dragging {
  border-color: var(--cyan);
  background: var(--cyan-wash);
  color: var(--cyan);
}
.upload-zone p {
  font-size: 13px;
}
.file-list {
  margin-top: 8px;
}
.file-name {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

/* ===== 确认单弹窗 ===== */
.cm-name {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 10px;
}
.cm-list {
  border: 1px solid var(--line);
  border-radius: var(--r);
  padding: 2px 12px;
  background: var(--paper);
}
.cm-item {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 13px;
}
.cm-label {
  flex: 1;
}
.cm-label.pending {
  color: var(--ink-3);
}
.cm-state.no {
  color: var(--wait-ink);
}
.cm-warn {
  margin-top: 12px;
  font-size: var(--fs-meta);
  color: var(--wait-ink);
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
