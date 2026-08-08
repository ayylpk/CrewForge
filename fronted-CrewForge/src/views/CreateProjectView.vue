<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import CardShell from '../components/CardShell.vue'
import GradientButton from '../components/GradientButton.vue'
import { createProject as createProjectApi, createTeamProject, fetchProjectById, updateProject } from '../api/project'
import type { ConfirmMode ,ProjectCreateDTO} from '../types/project'

const router = useRouter()
const route = useRoute()

/**
 * 双模式工作台：
 * · /projects/new      新建模式 —— 定项目描述 → 创建项目
 * · /projects/:id/pm   澄清模式 —— 加载项目 → 确认具体功能 → 保存
 */
const isEdit = computed(() => !!route.params.id)
const projectId = Number(route.params.id || 0)

/**
 * 团队模式：/projects/new?tenantId=xxx —— 创建的项目归属该团队（projectType=2）
 * 保存走 createTeamProject，成功后跳回团队详情页
 */
const teamId = Number(route.query.tenantId || 0)
const isTeamMode = computed(() => teamId > 0)

// ===== 表单 =====（类型 = 后端 ProjectDTO 白名单，全字段集中在这，保存统一走 saveProject）
// ⚠️ 可选字段不能给 ''：空字符串会被后端 updateById 当真值覆盖；undefined 才表示"不修改"
const form = ref<ProjectCreateDTO>({
  name: '',
  description: '', // 项目描述：要做什么样子的项目
  confirmMode: 'mixed',
  // 以下可选字段：页面有输入/加载到值才赋值；undefined = 不发送 = 后端不修改
  tenantId: undefined,
  projectType: undefined,
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

/** 后端 JSON 字符串字段解析成数组 */
function parseJsonArr(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.map(String) : []
  } catch {
    return []
  }
}

const MODE_NUM_TO_STR: Record<number, ConfirmMode> = { 0: 'green', 1: 'mixed', 2: 'manual' }
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
    form.value.confirmMode = MODE_NUM_TO_STR[p.confirmMode] || 'mixed'
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

/** 手动添加功能点（澄清模式） */
function addFeature() {
  const text = featureDraft.value.trim()
  if (!text) return
  if (!features.value.includes(text)) {
    features.value.push(text)
  }
  featureDraft.value = ''
}

/** 澄清模式：保存项目描述（复用统一 updateProject；undefined 字段不发送不覆盖） */
async function saveDescription() {
  descSaving.value = true
  try {
    await updateProject(projectId, { ...form.value })
  } finally {
    descSaving.value = false
  }
}

/** 澄清模式：保存项目名称（只提交 name，空值不落库） */
async function saveName() {
  const name = form.value.name.trim()
  if (!name) {
    alert('项目名称不能为空')
    return
  }
  nameSaving.value = true
  try {
    await updateProject(projectId, { name })
  } finally {
    nameSaving.value = false
  }
}

/** 澄清模式：确认模式下拉选中即保存（复用统一 updateProject，confirmMode 转数字在 api 层） */
async function saveConfirmMode() {
  modeSaving.value = true
  try {
    await updateProject(projectId, { ...form.value })
  } finally {
    modeSaving.value = false
  }
}

/** 澄清模式：保存功能清单（校验 → 把 features 组装成 JSON 写进 form → 统一调 updateProject） */
async function saveFeatures() {
  if (!features.value.length) {
    ElMessage.warning('还没有确认任何功能')
    return
  }
  saving.value = true
  try {
    form.value.businessModules = JSON.stringify(features.value)
    await updateProject(projectId, { ...form.value })
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

// ===== 对话区 =====
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
    alert('请先填写项目名称')
    return
  }
  showConfirm.value = true
}

/** 返回：澄清模式放弃修改，直接回项目概览的「功能清单 + 开发计划」（不调 update）；新建模式回项目列表 */
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
    if (isTeamMode.value) {
      // 团队模式：项目归属团队，创建后回团队详情页
      await createTeamProject(payload, teamId)
      router.push(`/teams/${teamId}`)
    } else {
      await createProjectApi(payload)
      router.push('/projects')
    }
  } finally {
    creating.value = false
  }
}
</script>

<template>
  <div class="create">
    <!-- 顶栏 -->
    <header class="topbar">
      <button class="btn-back" @click="isEdit ? goOverview() : isTeamMode ? router.push(`/teams/${teamId}`) : router.push('/projects')">
        {{ isEdit ? '← 返回' : isTeamMode ? '← 团队详情' : '← 项目列表' }}
      </button>
      <div class="topbar-title">
        <span class="dim">{{ isEdit ? '需求对话 ·' : '新建项目 ·' }}</span>
        <span>{{ isEdit ? form.name : '项目经理工作台' }}</span>
      </div>
      <div class="topbar-right">
        <GradientButton :loading="isEdit ? saving : creating" @click="isEdit ? saveFeatures() : tryCreate()">
          {{ isEdit ? '保存功能清单' : '创建项目' }}
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5 12h14M12 5l7 7-7 7" />
          </svg>
        </GradientButton>
      </div>
    </header>

    <main class="main">
      <!-- ===== 左侧：项目经理工作台 ===== -->
      <div class="left">
        <!-- 项目经理角色卡 -->
        <CardShell class="pm-card">
          <div class="pm-head">
            <div class="pm-avatar">
              <img src="../assets/agent-manager.png" alt="AI 项目经理" />
            </div>
            <div class="pm-meta">
              <h3>AI 项目经理 <span class="pm-badge">Hina</span></h3>
              <p class="pm-duty">
                {{ phaseLabel }} · 正在{{ working ? '整理你的描述...' : '确认项目功能' }}
              </p>
            </div>
            <span class="pm-status" :class="{ on: working }">
              <span class="pm-dot"></span>{{ working ? '工作中' : '待命' }}
            </span>
          </div>
          <!-- 职责说明 -->
          <div class="pm-tasks">
            <div class="pm-task" :class="{ done: featureDone }">
              <span class="pm-check">{{ featureDone ? '✓' : '○' }}</span>
              <span>{{ isEdit ? '确认具体功能' : '描述项目需求' }}</span>
            </div>
            <div class="pm-task" :class="{ done: nameDone }">
              <span class="pm-check">{{ nameDone ? '✓' : '○' }}</span>
              <span>确定项目名称</span>
            </div>
            <div class="pm-task" :class="{ done: modeDone }">
              <span class="pm-check">{{ modeDone ? '✓' : '○' }}</span>
              <span>选择确认模式</span>
            </div>
            <div class="pm-task" :class="{ done: files.length > 0 }">
              <span class="pm-check">{{ files.length > 0 ? '✓' : '○' }}</span>
              <span>收集参考文件</span>
            </div>
          </div>
        </CardShell>

        <!-- 项目名称 -->
        <CardShell class="block">
          <div class="block-head">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="3" />
              <path d="M3 9h18M9 21V9" />
            </svg>
            <h3 class="block-title">项目名称</h3>
            <!-- 澄清模式：名称可修改，独立保存（不依赖「保存功能清单」） -->
            <button v-if="isEdit" class="btn-save-desc" :disabled="nameSaving" @click="saveName()">
              {{ nameSaving ? '保存中...' : '保存名称' }}
            </button>
          </div>
          <input
            v-model="form.name"
            class="input"
            type="text"
            placeholder="如：CRM 客户管理系统"
          />
        </CardShell>

        <!-- 项目描述（要做什么样子的项目） -->
        <CardShell class="block">
          <div class="block-head">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
            <h3 class="block-title">项目描述</h3>
            <span class="hint">这个项目要做什么</span>
            <!-- 澄清模式：描述可修改，独立保存（不依赖「保存功能清单」） -->
            <button v-if="isEdit" class="btn-save-desc" :disabled="descSaving" @click="saveDescription()">
              {{ descSaving ? '保存中...' : '保存描述' }}
            </button>
          </div>
          <textarea
            v-model="form.description"
            class="desc-input"
            rows="5"
            placeholder="描述这个项目要做什么样子的项目，如：为企业做一个 CRM 客户管理系统，管理客户档案、跟进销售过程、生成统计报表"
          ></textarea>
        </CardShell>

        <!-- 已确认功能（仅澄清模式：项目经理确认的具体功能） -->
        <CardShell v-if="isEdit" class="block">
          <div class="block-head">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
              <polyline points="22 4 12 14.01 9 11.01" />
            </svg>
            <h3 class="block-title">已确认功能</h3>
            <span class="hint">{{ features.length }} 项</span>
          </div>
          <div v-if="features.length" class="feature-list">
            <div v-for="(f, i) in features" :key="i" class="feature-item">
              <span class="feature-check">✓</span>
              <span class="feature-text">{{ f }}</span>
              <button class="feature-remove" @click="features.splice(i, 1)">✕</button>
            </div>
          </div>
          <p v-else class="empty-tip">还没有确认功能——在右侧对话中澄清，或手动添加</p>

          <!-- 手动新增 -->
          <div class="feature-add">
            <input
              v-model="featureDraft"
              class="feature-input"
              type="text"
              placeholder="输入功能点，如：报表导出 Excel"
              @keyup.enter="addFeature"
            />
            <button class="feature-add-btn" @click="addFeature">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              添加
            </button>
          </div>
        </CardShell>

        <!-- 确认模式 -->
        <CardShell class="block">
          <div class="block-head">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
            <h3 class="block-title">确认模式</h3>
          </div>
          <div v-if="!isEdit" class="mode-list">
            <button
              v-for="m in modes"
              :key="m.value"
              class="mode-item"
              :class="{ active: form.confirmMode === m.value }"
              @click="form.confirmMode = m.value"
            >
              <span class="mode-label">{{ m.label }}</span>
              <span class="mode-desc">{{ m.desc }}</span>
            </button>
          </div>
          <!-- 澄清模式：下拉重新选择，选中即保存 -->
          <div v-else class="mode-select-wrap">
            <select
              v-model="form.confirmMode"
              class="mode-select"
              :disabled="modeSaving"
              @change="saveConfirmMode()"
            >
              <option v-for="m in modes" :key="m.value" :value="m.value">{{ m.label }}</option>
            </select>
            <span class="mode-select-desc">选中即保存 · 当前：{{ MODE_LABELS[form.confirmMode] }}</span>
          </div>
        </CardShell>

        <!-- 参考文件 -->
        <CardShell class="block">
          <div class="block-head">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <h3 class="block-title">参考文件</h3>
            <span class="hint">可选</span>
          </div>
          <div
            class="upload-zone"
            :class="{ dragging: isDragging }"
            @dragover.prevent="isDragging = true"
            @dragleave.prevent="isDragging = false"
            @drop.prevent="onDrop"
            @click="pickFile"
          >
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <p>拖拽文件到这里，或点击选择</p>
          </div>
          <div v-if="files.length" class="file-list">
            <div v-for="(f, i) in files" :key="i" class="file-item">
              <span class="file-name">{{ f.name }}</span>
              <button class="file-remove" @click.stop="files.splice(i, 1)">✕</button>
            </div>
          </div>
          <input ref="fileInput" type="file" multiple hidden @change="onPick" />
        </CardShell>

      </div>

      <!-- ===== 右侧：与项目经理对话 ===== -->
      <div class="right">
        <div class="chat">
          <div class="chat-head">
            <span>与项目经理沟通需求</span>
            <span class="chat-head-hint">{{ isEdit ? '对话澄清 → 左侧确认功能清单' : '描述项目 → 确认项目描述' }}</span>
          </div>
          <!-- 消息列表 -->
          <div ref="chatBody" class="chat-body">
            <div
              v-for="(m, i) in messages"
              :key="i"
              class="msg"
              :class="m.role"
            >
              <div v-if="m.role === 'assistant'" class="msg-avatar">
                <img src="../assets/agent-manager.png" alt="Hina" />
              </div>
              <div class="msg-bubble">{{ m.content }}</div>
            </div>
            <div v-if="thinking" class="msg assistant">
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

          <!-- 输入区 -->
          <div class="chat-input">
            <textarea
              v-model="draft"
              rows="2"
              placeholder="描述这个项目要做什么，如：做一个选课系统，让学生选课、教师管理课程...（Enter 发送）"
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

    <!-- 创建确认弹窗 -->
    <div v-if="showConfirm" class="modal-mask" @click.self="showConfirm = false">
      <div class="modal">
        <h2>确认创建项目？</h2>
        <p class="modal-name">「{{ form.name }}」</p>

        <div class="confirm-list">
          <div v-for="c in confirmItems" :key="c.label" class="confirm-item">
            <span class="confirm-check" :class="{ no: !c.done }">{{ c.done ? '✓' : '○' }}</span>
            <span class="confirm-label" :class="{ pending: !c.done }">{{ c.label }}</span>
            <span class="confirm-state" :class="{ no: !c.done }">{{ c.done ? '已完成' : '未完成' }}</span>
          </div>
        </div>

        <p v-if="hasPending" class="modal-warn">
          以下内容未完成，创建后可在项目详情中继续补充
        </p>

        <div class="modal-actions">
          <button class="btn-cancel" @click="showConfirm = false">再看看</button>
          <GradientButton @click="confirmCreate">确认创建</GradientButton>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.create {
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
.topbar-right .avatar {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--bg4);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--blue);
  border: 1px solid var(--border2);
}

/* ===== 主区域：左工作台 + 右对话 ===== */
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

/* ===== 项目经理角色卡 ===== */
.pm-card {
  padding: 18px 20px;
  border-left: 3px solid var(--blue);
}
.pm-head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.pm-avatar {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  overflow: hidden;
  flex-shrink: 0;
  background: var(--bg3);
  border: 1px solid var(--border);
}
.pm-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.pm-meta {
  flex: 1;
}
.pm-meta h3 {
  font-size: 15px;
  font-weight: 700;
}
.pm-badge {
  display: inline-block;
  margin-left: 6px;
  padding: 2px 8px;
  border-radius: 10px;
  background: rgba(69, 184, 255, 0.12);
  border: 1px solid rgba(69, 184, 255, 0.3);
  color: var(--blue);
  font-size: 11px;
  font-weight: 600;
  vertical-align: middle;
}
.pm-duty {
  font-size: 12px;
  color: var(--text2);
  margin-top: 3px;
}
.pm-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text3);
  flex-shrink: 0;
}
.pm-status.on {
  color: var(--green);
}
.pm-dot {
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
.pm-tasks {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}
.pm-task {
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
.pm-task.done {
  color: var(--green);
  border-color: rgba(94, 203, 138, 0.3);
  background: rgba(94, 203, 138, 0.06);
}
.pm-check {
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
.btn-save-desc {
  margin-left: auto;
  padding: 5px 12px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text2);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}
.btn-save-desc:hover {
  border-color: var(--green);
  color: var(--green);
}
.btn-save-desc:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.mode-select-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
}
.mode-select {
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg3);
  color: var(--text);
  font-size: 13px;
  cursor: pointer;
  outline: none;
  transition: border-color 0.2s;
}
.mode-select:hover {
  border-color: var(--green);
}
.mode-select:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.mode-select-desc {
  font-size: 11.5px;
  color: var(--text3);
}

/* 输入 */
.input {
  width: 100%;
  height: 42px;
  padding: 0 14px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg3);
  color: var(--text);
  font-size: 14px;
  outline: none;
  transition: border-color 0.2s;
}
/* 只读展示（澄清模式） */
.static-text {
  font-size: 13.5px;
  color: var(--text2);
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
}
.empty-tip {
  font-size: 12.5px;
  color: var(--text3);
  padding: 10px 0;
}
/* 项目描述多行输入 */
.desc-input {
  width: 100%;
  padding: 10px 14px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg3);
  color: var(--text);
  font-size: 13.5px;
  font-family: inherit;
  line-height: 1.7;
  outline: none;
  resize: vertical;
  transition: border-color 0.2s;
}
.input:focus {
  border-color: var(--blue);
}
.input::placeholder {
  color: var(--text3);
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

/* 手动新增功能 */
.feature-add {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}
.feature-input {
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
.feature-input:focus {
  border-color: var(--blue);
  border-style: solid;
  background: rgba(69, 184, 255, 0.04);
}
.feature-input::placeholder {
  color: var(--text3);
}
.feature-add-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 0 14px;
  height: 38px;
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
  gap: 3px;
  padding: 11px 14px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg3);
  color: var(--text2);
  cursor: pointer;
  text-align: left;
  transition: all 0.2s;
}
.mode-item:hover {
  border-color: var(--border2);
}
.mode-item.active {
  border-color: var(--blue);
  background: rgba(69, 184, 255, 0.08);
}
.mode-label {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text);
}
.mode-item.active .mode-label {
  color: var(--blue);
}
.mode-desc {
  font-size: 12px;
  color: var(--text3);
}

/* 上传 */
.upload-zone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 22px 0;
  border: 1.5px dashed var(--border2);
  border-radius: 12px;
  color: var(--text2);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
}
.upload-zone:hover,
.upload-zone.dragging {
  border-color: var(--blue);
  color: var(--blue);
  background: rgba(69, 184, 255, 0.05);
}
.file-list {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.file-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--bg3);
  font-size: 12.5px;
  color: var(--text2);
}
.file-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-remove {
  border: none;
  background: transparent;
  color: var(--text3);
  cursor: pointer;
  font-size: 12px;
}
.file-remove:hover {
  color: var(--red);
}

/* ===== 创建确认弹窗 ===== */
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
  width: 420px;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 28px;
}
.modal h2 {
  font-size: 18px;
  font-weight: 700;
}
.modal-name {
  font-size: 14px;
  color: var(--blue);
  margin-top: 6px;
  margin-bottom: 20px;
}
.confirm-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.confirm-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-radius: 9px;
  background: var(--bg3);
  font-size: 13px;
}
.confirm-check {
  color: var(--green);
  font-weight: 700;
}
.confirm-check.no {
  color: var(--yellow);
}
.confirm-label {
  flex: 1;
  color: var(--text);
}
.confirm-label.pending {
  color: var(--text2);
}
.confirm-state {
  font-size: 11.5px;
  color: var(--green);
}
.confirm-state.no {
  color: var(--yellow);
}
.modal-warn {
  margin-top: 14px;
  font-size: 12.5px;
  color: var(--yellow);
  line-height: 1.6;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 24px;
}
.btn-cancel {
  padding: 0 20px;
  height: 40px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text2);
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s;
}
.btn-cancel:hover {
  border-color: var(--border2);
  color: var(--text);
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
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
  font-weight: 600;
}
.chat-head-hint {
  font-size: 11px;
  font-weight: 400;
  color: var(--text3);
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

/* 打字动画 */
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

/* 输入区 */
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
