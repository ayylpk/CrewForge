<script setup lang="ts">
import { ref, computed, nextTick, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import CardShell from '../components/CardShell.vue'
import { fetchProjectById } from '../api/project'
import { fetchAllProjectAgents, createProjectAgent, updateProjectAgent, deleteProjectAgents } from '../api/agent'
import type { agentDTO, agentVO } from '../types/agent'

/** 当前登录用户 ID（登录时存的 cf_user_info） */
function currentUserId(): number {
  const raw = localStorage.getItem('cf_user_info')
  return raw ? (JSON.parse(raw) as { userId: number }).userId : 0
}

const router = useRouter()
const route = useRoute()
const projectName = ref('')

onMounted(async () => {
  const id = Number(route.params.id)
  if (!id) return
  try {
    const p = await fetchProjectById(id)
    projectName.value = p.name
    // 查询该项目已保存的 Agent 团队（按 projectId + userId 双条件，回显到 existingAgents）
    existingAgents.value = await fetchAllProjectAgents(id, currentUserId())
  } catch {
    projectName.value = '项目 #' + route.params.id
  }
})

// ===== 职责元数据（每个职责一个 SVG 图标 + 颜色） =====
export type AgentRole = 'manager' | 'architect' | 'backend' | 'frontend' | 'tester' | 'devops' | 'docs'

const ROLE_META: Record<AgentRole, { label: string; color: string; bg: string; icon: string }> = {
  manager: {
    label: '项目经理',
    color: '#f070a0',
    bg: 'rgba(240,112,160,.12)',
    icon: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  },
  architect: {
    label: '架构师',
    color: '#a76bff',
    bg: 'rgba(167,107,255,.12)',
    icon: '<circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>',
  },
  backend: {
    label: '后端开发',
    color: '#5ecb8a',
    bg: 'rgba(94,203,138,.12)',
    icon: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
  },
  frontend: {
    label: '前端开发',
    color: '#f0c060',
    bg: 'rgba(240,192,96,.12)',
    icon: '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
  },
  tester: {
    label: '测试',
    color: '#5ec8c0',
    bg: 'rgba(94,200,192,.12)',
    icon: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
  },
  devops: {
    label: '运维部署',
    color: '#f09050',
    bg: 'rgba(240,144,80,.12)',
    icon: '<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>',
  },
  docs: {
    label: '文档维护',
    color: '#45b8ff',
    bg: 'rgba(69,184,255,.12)',
    icon: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  },
}


// ===== 模型与 API Key（Provider 级管理） =====

/**
 * Provider（模型服务商）：每个 Provider 独立 API Key + Base URL + 模型列表
 * Agent 从所有已启用的 Provider 中选择模型
 */
interface ModelProvider {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  enabled: boolean
  builtin?: boolean
  models: string[]
}

/** 内置 Provider 预设（API 配置入口在首页，这里只供成员模型选择） */
const PRESET_PROVIDERS: ModelProvider[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    enabled: true,
    builtin: true,
    models: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash', 'deepseek-v4-pro[1m]'],
  },
]

/** 从 localStorage 恢复（key: cf_providers） */
function loadProviders(): ModelProvider[] {
  try {
    const saved = localStorage.getItem('cf_providers')
    if (saved) {
      return JSON.parse(saved) as ModelProvider[]
    }
  } catch {
    /* 损坏则用预设 */
  }
  return JSON.parse(JSON.stringify(PRESET_PROVIDERS))
}

const providers = ref<ModelProvider[]>(loadProviders())

/** 模型完整值 = "providerId/modelName"，如 "deepseek/deepseek-v4-flash"（空字符串 = 跟随全局） */

/** 所有已启用 provider 的模型选项（分组） */
const enabledModelOptions = computed(() =>
  providers.value
    .filter((p) => p.enabled)
    .map((p) => ({ group: p.name, value: `${p.id}/${p.models}`, items: p.models.map((m) => `${p.id}/${m}`) }))
)

const globalDefaultModel = ref(localStorage.getItem('cf_default_model') || 'deepseek/deepseek-v4-flash')

/** 模型显示名 */
function modelLabel(value: string): string {
  const [pid, ...rest] = value.split('/')
  const model = rest.join('/')
  const p = providers.value.find((x) => x.id === pid)
  if (!p) return value
  return `${p.name} · ${model}`
}

// ===== 成员 =====

/** 已存在的成员（后端查询回显，有 id；修改走 PUT） */
const existingAgents = ref<agentVO[]>([])
/** 新增的成员（无 id；确认团队时批量 POST） */
const newAgents = ref<agentDTO[]>([])
/** 被删除成员的 id（确认团队时批量 DELETE） */
const removedIds = ref<number[]>([])

/** 页面展示用的统一成员结构（existing 在前 + new 在后） */
interface MemberView {
  tempId: number // existing: 正 id；new: 负索引（仅前端用，保证 key 唯一）
  isNew: boolean
  name: string
  role: string
  systemPrompt: string
  tools: string
  model: string // 空 = 跟随全局
  temperature?: number | null
  status: number
}

const displayMembers = computed<MemberView[]>(() => [
  ...existingAgents.value.map((vo) => ({
    tempId: vo.id,
    isNew: false,
    name: vo.name,
    role: vo.role || '',
    systemPrompt: vo.systemPrompt || '',
    tools: vo.tools || '',
    model: vo.model || '',
    temperature: vo.temperature ?? null,
    status: vo.status,
  })),
  ...newAgents.value.map((dto, i) => ({
    tempId: -(i + 1),
    isNew: true,
    name: dto.name,
    role: dto.role || '',
    systemPrompt: dto.systemPrompt || '',
    tools: dto.tools || '',
    model: dto.model || '',
    temperature: dto.temperature ?? null,
    status: dto.status ?? 1,
  })),
])

/** 是否已有成员配置了提示词 */
const anyPromptSet = computed(() => displayMembers.value.some((m) => m.systemPrompt.trim().length > 0))

/** 按职位描述反查元信息（找不到用通用样式） */
function roleMetaByLabel(label: string) {
  const hit = (Object.keys(ROLE_META) as AgentRole[]).find((k) => ROLE_META[k].label === label)
  return hit ? ROLE_META[hit] : { label, color: '#8890a8', bg: 'rgba(136,144,168,.12)', icon: '' }
}

// ===== 删除成员 =====
function removeMember(m: MemberView) {
  if (m.isNew) {
    // 新增未入库的：直接从数组移除，无需记录
    newAgents.value.splice(-m.tempId - 1, 1)
  } else {
    // 已入库的：从列表移除 + 记录 id，确认团队时 DELETE
    existingAgents.value = existingAgents.value.filter((x) => x.id !== m.tempId)
    removedIds.value.push(m.tempId)
  }
  messages.value.push({
    role: 'assistant',
    content: `已移除「${m.name}」。其承担的职责将不再有人负责，如需补充可以重新添加。`,
  })
  scrollToBottom()
}

// ===== 添加/编辑成员 =====
const showMemberModal = ref(false)
const editingMember = ref<MemberView | null>(null)
const memberForm = ref({
  name: '',
  role: '',
  systemPrompt: '',
  tools: '',
  model: '', // 空 = 跟随全局（后端存 NULL）
  temperature: 0.7 as number | null,
})

function emptyForm() {
  return { name: '', role: '', systemPrompt: '', tools: '', model: '', temperature: 0.7 }
}

function openAdd() {
  editingMember.value = null
  memberForm.value = emptyForm()
  showMemberModal.value = true
}
function openEdit(m: MemberView) {
  editingMember.value = m
  memberForm.value = {
    name: m.name,
    role: m.role,
    systemPrompt: m.systemPrompt,
    tools: parseTools(m.tools),
    model: m.model,
    temperature: m.temperature ?? 0.7,
  }
  showMemberModal.value = true
}
function closeMemberModal() {
  showMemberModal.value = false
}

/** tools JSON 字符串 → 逗号分隔文本（表单编辑用） */
function parseTools(tools: string): string {
  try {
    const arr = JSON.parse(tools)
    return Array.isArray(arr) ? arr.join(', ') : ''
  } catch {
    return tools
  }
}

/** 表单 → 工具列表 JSON 数组字符串 */
function formToolsJson(): string {
  return JSON.stringify(
    memberForm.value.tools
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean)
  )
}

function saveMember() {
  if (!memberForm.value.name.trim()) {
    alert('请填写成员名称')
    return
  }
  const base = {
    name: memberForm.value.name.trim(),
    role: memberForm.value.role.trim() || '通用成员',
    systemPrompt: memberForm.value.systemPrompt,
    tools: formToolsJson(),
    model: memberForm.value.model || '',
    temperature: memberForm.value.temperature ?? null,
  }
  const modelText = base.model
    ? `模型：${modelLabel(base.model)}`
    : `模型：${modelLabel(globalDefaultModel.value)}（跟随全局）`

  if (editingMember.value) {
    const m = editingMember.value
    if (m.isNew) {
      // 编辑新增未入库的：回写 newAgents 对应项
      Object.assign(newAgents.value[-m.tempId - 1], base)
    } else {
      // 编辑已入库的：回写 existingAgents 对应项（确认时 PUT）
      const vo = existingAgents.value.find((x) => x.id === m.tempId)
      if (vo) Object.assign(vo, base)
    }
    messages.value.push({
      role: 'assistant',
      content: `已更新「${base.name}」的配置：${base.role}；${modelText}。`,
    })
  } else {
    // 新增：推入 newAgents（无 id，确认团队时 POST）
    newAgents.value.push({
      projectId: Number(route.params.id),
      userId: currentUserId(),
      ...base,
    })
    messages.value.push({
      role: 'assistant',
      content: `已添加成员「${base.name}」，负责：${base.role}；${modelText}。确认团队后保存到项目。`,
    })
  }
  showMemberModal.value = false
  scrollToBottom()
}

// ===== 对话区 =====
interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}
const messages = ref<ChatMessage[]>([
  {
    role: 'assistant',
    content:
      '你好，我是团队经理 Hina。团队成员目前是空的——你可以从 Agent 库挑选复制，或手动添加成员并配置提示词。\n\n确认团队后配置会保存到项目，之后就可以进入执行了。',
  },
])
const draft = ref('')
const thinking = ref(false)
const chatBody = ref<HTMLElement | null>(null)

function teamReply(text: string): string {
  if (/为什么|理由|分工/.test(text)) {
    return (
      '分工逻辑：\n\n' +
      '• 经理：掌握全局，分派任务、汇总决策\n' +
      '• 架构师：先出规格，避免代码返工\n' +
      '• 后端/前端：并行开发，互不阻塞\n' +
      '• 测试：独立于开发，保证质量\n' +
      '• 维护：记录变更，方便回溯\n\n' +
      '职责拆分越细，每项任务越聚焦，质量越稳。'
    )
  }
  if (/合并|一个人|少.*人|精简/.test(text)) {
    return '可以合并。比如把「测试」并入「后端」，开发完直接自检，减少沟通成本。你可以在卡片上点「合并」操作。'
  }
  if (/多|不够|加人|增加/.test(text)) {
    return '可以添加成员。比如项目模块多时，再加一个后端 Agent 并行开发。点「添加成员」按钮即可。'
  }
  return '好的，收到你的想法。你可以在左侧卡片上直接操作：合并、编辑、删除，我会实时同步调整。'
}

function send() {
  const text = draft.value.trim()
  if (!text || thinking.value) return
  messages.value.push({ role: 'user', content: text })
  draft.value = ''
  thinking.value = true
  scrollToBottom()
  setTimeout(() => {
    messages.value.push({ role: 'assistant', content: teamReply(text) })
    thinking.value = false
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

/** agentVO → agentDTO（去掉 createTime/updateTime 等输出字段） */
function toAgentDTO(vo: agentVO): agentDTO {
  return {
    projectId: vo.projectId,
    userId: vo.userId,
    name: vo.name,
    role: vo.role,
    systemPrompt: vo.systemPrompt,
    tools: vo.tools,
    model: vo.model,
    temperature: vo.temperature,
    status: vo.status,
  }
}

/**
 * 保存团队配置到后端（sys_project_agent）
 * ① 新增的成员（newAgents，无 id）→ POST 批量创建
 * ② 已存在的成员（existingAgents，有 id）→ PUT 逐个更新
 * ③ 被删除的成员（removedIds）→ DELETE 批量移除
 */
async function saveTeam() {
  const projectId = Number(route.params.id)
  // ① 新增的 → POST（agentDTO 无 id）
  for (const dto of newAgents.value) {
    await createProjectAgent(dto)
  }
  newAgents.value = []
  // ② 已存在的 → PUT（id 走路径）
  for (const vo of existingAgents.value) {
    await updateProjectAgent(vo.id, toAgentDTO(vo))
  }
  // ③ 被删除的 → DELETE（ids 复合格式：projectId-id1-id2）
  if (removedIds.value.length) {
    await deleteProjectAgents(projectId, removedIds.value)
    removedIds.value = []
  }
}

/** 确认团队：保存修改 → 返回项目功能模块 */
async function confirmTeam() {
  await saveTeam()
  router.push({ name: 'project-detail', params: { id: String(route.params.id) } })
}
</script>

<template>
  <div class="team">
    <!-- 顶栏 -->
    <header class="topbar">
      <button class="btn-back" @click="goBack">← 返回</button>
      <div class="topbar-title">
        <span class="dim">{{ projectName }} ·</span>
        <span>团队配置</span>
      </div>
      <div class="topbar-right">
        <button class="btn-save" @click="confirmTeam">
          确认团队
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5 12h14M12 5l7 7-7 7" />
          </svg>
        </button>
      </div>
    </header>

    <main class="main">
      <!-- ===== 左侧：团队成员 ===== -->
      <div class="left">
        <!-- 团队经理角色卡 -->
        <CardShell class="tl-card">
          <div class="tl-head">
            <div class="tl-avatar">
              <img src="../assets/agent-manager.png" alt="Hina" />
            </div>
            <div class="tl-meta">
              <h3>AI 团队经理 <span class="tl-badge">Hina</span></h3>
              <p class="tl-duty">已规划 {{ displayMembers.length }} 个成员</p>
            </div>
            <span class="tl-status" :class="{ on: displayMembers.length }">
              <span class="tl-dot"></span>{{ displayMembers.length ? '规划完成' : '待规划' }}
            </span>
          </div>
          <div class="tl-tasks">
            <div class="tl-task" :class="{ done: displayMembers.length > 0 }">
              <span class="tl-check">{{ displayMembers.length > 0 ? '✓' : '○' }}</span>
              <span>规划团队成员</span>
            </div>
            <div class="tl-task" :class="{ done: anyPromptSet }">
              <span class="tl-check">{{ anyPromptSet ? '✓' : '○' }}</span>
              <span>为成员配置提示词</span>
            </div>
            <div class="tl-task">
              <span class="tl-check">○</span>
              <span>等待你的确认调整</span>
            </div>
          </div>
        </CardShell>

        <!-- 成员网格 -->
        <div class="member-grid">
          <CardShell v-for="m in displayMembers" :key="m.tempId" class="member-card">
            <div class="member-top">
              <!-- 职位图标（按 role 反查预设，找不到用通用样式） -->
              <div class="member-icons">
                <span
                  class="role-icon"
                  :style="{ background: roleMetaByLabel(m.role).bg, color: roleMetaByLabel(m.role).color }"
                  :title="m.role"
                >
                  <svg v-if="roleMetaByLabel(m.role).icon" v-html="roleMetaByLabel(m.role).icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></svg>
                  <span v-else>{{ m.role.slice(0, 1) }}</span>
                </span>
                <span v-if="m.isNew" class="member-new-badge">新</span>
              </div>
              <button class="member-remove" @click="removeMember(m)">✕</button>
            </div>

            <h4 class="member-name">{{ m.name }}</h4>

            <!-- 职位标签（单值） -->
            <div class="role-tags">
              <span
                class="role-tag"
                :style="{ color: roleMetaByLabel(m.role).color, borderColor: roleMetaByLabel(m.role).color + '55', background: roleMetaByLabel(m.role).bg }"
              >
                {{ m.role || '通用成员' }}
              </span>
            </div>

            <!-- 模型状态（空 = 跟随全局） -->
            <div class="member-llm">
              <span class="llm-model" :title="m.model ? m.model : '跟随全局默认模型'">
                <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
                {{ m.model ? modelLabel(m.model) : '跟随全局' }}
              </span>
            </div>

            <p class="member-prompt">{{ m.systemPrompt || '（未配置提示词）' }}</p>

            <div class="member-actions">
              <button class="act-btn" @click="openEdit(m)">编辑</button>
            </div>
          </CardShell>

          <!-- 添加成员 -->
          <button class="member-add" @click="openAdd">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span>添加成员</span>
          </button>
        </div>
      </div>

      <!-- ===== 右侧：与团队经理对话 ===== -->
      <div class="right">
        <div class="chat">
          <div class="chat-head">
            <span>与团队经理沟通</span>
            <span class="chat-head-hint">询问分工 · 调整建议</span>
          </div>
          <div ref="chatBody" class="chat-body">
            <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.role">
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
          <div class="chat-input">
            <textarea
              v-model="draft"
              rows="2"
              placeholder="如：为什么要分这么多角色？/ 后端一个人够吗...（Enter 发送）"
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

    <!-- 添加/编辑成员弹窗 -->
    <div v-if="showMemberModal" class="modal-mask" @click.self="closeMemberModal">
      <div class="modal">
        <h2>{{ editingMember ? '编辑成员' : '添加成员' }}</h2>

        <div class="modal-field">
          <label>成员名称</label>
          <input v-model="memberForm.name" class="input" type="text" placeholder="如：后端 Agent" />
        </div>

        <div class="modal-field">
          <label>职位</label>
          <select v-model="memberForm.role" class="select">
            <option v-for="(meta, key) in ROLE_META" :key="key" :value="meta.label">{{ meta.label }}</option>
          </select>
        </div>

        <div class="modal-field">
          <label>System Prompt</label>
          <textarea
            v-model="memberForm.systemPrompt"
            class="prompt-area"
            rows="3"
            placeholder="该 Agent 的角色设定与行为规则..."
          ></textarea>
        </div>

        <div class="modal-field">
          <label>可用工具 <span class="field-hint">逗号分隔，如：web_search, read_file</span></label>
          <input v-model="memberForm.tools" class="input" type="text" placeholder="留空表示暂无工具" />
        </div>

        <div class="modal-field">
          <label>大模型 <span class="field-hint">跟随全局 = 使用首页配置的默认模型</span></label>
          <select v-model="memberForm.model" class="select">
            <option value="">跟随全局（{{ modelLabel(globalDefaultModel) }}）</option>
            <optgroup v-for="g in enabledModelOptions" :key="g.group" :label="g.group">
              <option v-for="m in g.items" :key="m" :value="m">{{ m.split('/').slice(1).join('/') }}</option>
            </optgroup>
          </select>
        </div>

        <div class="modal-field">
          <label>采样温度 <span class="field-hint">0.0-2.0，越大越随机</span></label>
          <input
            v-model.number="memberForm.temperature"
            class="input"
            type="number"
            min="0"
            max="2"
            step="0.1"
          />
        </div>

        <div class="modal-actions">
          <button class="btn-cancel" @click="closeMemberModal">取消</button>
          <button class="btn-save" @click="saveMember">保存</button>
        </div>
      </div>
    </div>

  </div>
</template>

<style scoped>
.team {
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
.btn-api {
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
.btn-api:hover {
  border-color: var(--blue);
  color: var(--blue);
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

/* ===== 团队经理卡 ===== */
.tl-card {
  padding: 18px 20px;
  border-left: 3px solid var(--pink);
}
.tl-head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.tl-avatar {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  overflow: hidden;
  flex-shrink: 0;
  background: var(--bg3);
  border: 1px solid var(--border);
}
.tl-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.tl-meta {
  flex: 1;
}
.tl-meta h3 {
  font-size: 15px;
  font-weight: 700;
}
.tl-badge {
  display: inline-block;
  margin-left: 6px;
  padding: 2px 8px;
  border-radius: 10px;
  background: rgba(240, 112, 160, 0.12);
  border: 1px solid rgba(240, 112, 160, 0.3);
  color: var(--pink);
  font-size: 11px;
  font-weight: 600;
  vertical-align: middle;
}
.tl-duty {
  font-size: 12px;
  color: var(--text2);
  margin-top: 3px;
}
.tl-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--green);
  flex-shrink: 0;
}
.tl-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
}
.tl-tasks {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
}
.tl-task {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--green);
  padding: 4px 10px;
  border-radius: 14px;
  background: rgba(94, 203, 138, 0.06);
  border: 1px solid rgba(94, 203, 138, 0.3);
}
.tl-check {
  font-size: 11px;
}

/* ===== 成员网格 ===== */
.member-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
  gap: 14px;
}
.member-card {
  padding: 16px;
  display: flex;
  flex-direction: column;
}
.member-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 10px;
}
/* 职责图标叠排：合并后自动叠加 */
.member-icons {
  display: flex;
  gap: 6px;
}
.role-icon {
  width: 26px;
  height: 26px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  font-size: 12px;
  font-weight: 600;
}
/* 新增未入库成员标记 */
.member-new-badge {
  font-size: 10px;
  color: var(--green);
  border: 1px solid rgba(94, 203, 138, 0.4);
  border-radius: 6px;
  padding: 0 5px;
  line-height: 14px;
}
.member-remove {
  border: none;
  background: transparent;
  color: var(--text3);
  font-size: 12px;
  cursor: pointer;
  padding: 2px;
  opacity: 0;
  transition: all 0.15s;
}
.member-card:hover .member-remove {
  opacity: 1;
}
.member-remove:hover {
  color: var(--red);
}
.member-name {
  font-size: 14.5px;
  font-weight: 600;
  margin-bottom: 8px;
}
.role-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-bottom: 10px;
}
.role-tag {
  padding: 2px 8px;
  border-radius: 9px;
  border: 1px solid;
  font-size: 11px;
  font-weight: 500;
}
/* 模型 + Key 标签 */
.member-llm {
  display: flex;
  gap: 6px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}
.llm-model,
.llm-key {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 8px;
  font-size: 11px;
  border: 1px solid var(--border);
  color: var(--text3);
  background: var(--bg3);
}
.llm-key.set {
  color: var(--green);
  border-color: rgba(94, 203, 138, 0.3);
}

.member-prompt {
  font-size: 12px;
  color: var(--text2);
  line-height: 1.6;
  flex: 1;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.member-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}
.act-btn {
  flex: 1;
  padding: 7px 0;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg3);
  color: var(--text2);
  font-size: 12.5px;
  cursor: pointer;
  transition: all 0.2s;
}
.act-btn:hover {
  border-color: var(--blue);
  color: var(--blue);
}

/* 添加成员卡片 */
.member-add {
  min-height: 150px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  border: 1.5px dashed var(--border2);
  border-radius: var(--radius);
  background: transparent;
  color: var(--text3);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
}
.member-add:hover {
  border-color: var(--blue);
  color: var(--blue);
  background: rgba(69, 184, 255, 0.04);
}

/* ===== 弹窗 ===== */
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
  width: 440px;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 26px;
}
.modal h2 {
  font-size: 17px;
  font-weight: 700;
  margin-bottom: 18px;
}
.modal-field {
  margin-bottom: 14px;
}
.modal-field label {
  display: block;
  font-size: 12.5px;
  color: var(--text2);
  margin-bottom: 8px;
}
.input {
  width: 100%;
  height: 40px;
  padding: 0 12px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--bg3);
  color: var(--text);
  font-size: 13.5px;
  outline: none;
  transition: border-color 0.2s;
}
.input:focus {
  border-color: var(--blue);
}
.prompt-area {
  width: 100%;
  padding: 10px 12px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--bg3);
  color: var(--text);
  font-size: 13px;
  line-height: 1.6;
  outline: none;
  resize: vertical;
  font-family: inherit;
  transition: border-color 0.2s;
}
.prompt-area:focus {
  border-color: var(--blue);
}
/* 下拉选择（深色） */
.select {
  width: 100%;
  height: 40px;
  padding: 0 12px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--bg3);
  color: var(--text);
  font-size: 13.5px;
  outline: none;
  cursor: pointer;
  transition: border-color 0.2s;
}
.select:focus {
  border-color: var(--blue);
}
.select option,
.select optgroup {
  background: var(--bg3);
  color: var(--text);
}

.field-hint {
  font-size: 11px;
  color: var(--text3);
  font-weight: 400;
  margin-left: 4px;
}
.api-tip {
  font-size: 12.5px;
  color: var(--text2);
  line-height: 1.7;
  margin-bottom: 16px;
}

/* ===== Provider 管理 ===== */
.api-modal {
  width: 560px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.api-modal > .modal-field,
.api-modal > h2,
.api-modal > .api-tip,
.api-modal > .custom-provider,
.api-modal > .modal-actions {
  flex-shrink: 0;
}
.provider-list {
  flex: 1 1 auto;
  min-height: 120px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 14px;
}

/* ===== 保存提示 toast ===== */
.toast {
  position: fixed;
  top: 72px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 200;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 20px;
  border-radius: 10px;
  background: rgba(20, 25, 38, 0.95);
  border: 1px solid rgba(94, 203, 138, 0.4);
  color: var(--green);
  font-size: 13.5px;
  font-weight: 500;
  box-shadow: var(--shadow);
  backdrop-filter: blur(8px);
}
.toast-fade-enter-active,
.toast-fade-leave-active {
  transition: all 0.3s var(--ease);
}
.toast-fade-enter-from,
.toast-fade-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(-8px);
}
.provider-item {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg3);
  overflow: hidden;
}
.provider-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 14px;
}
.provider-name {
  font-size: 13.5px;
  font-weight: 600;
  flex: 1;
}
.provider-key-state {
  font-size: 11px;
  color: var(--green);
  padding: 2px 8px;
  border-radius: 8px;
  background: rgba(94, 203, 138, 0.08);
}
.provider-key-state.no {
  color: var(--yellow);
  background: rgba(240, 192, 96, 0.08);
}
.provider-remove {
  border: none;
  background: transparent;
  color: var(--text3);
  cursor: pointer;
  font-size: 12px;
  padding: 2px 4px;
}
.provider-remove:hover {
  color: var(--red);
}
.provider-body {
  padding: 0 14px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.provider-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.provider-label {
  width: 72px;
  font-size: 12px;
  color: var(--text3);
  flex-shrink: 0;
}
.provider-row .input {
  flex: 1;
  height: 36px;
  font-size: 13px;
}
/* 启用开关 */
.provider-toggle {
  position: relative;
  display: inline-flex;
  cursor: pointer;
}
.provider-toggle input {
  display: none;
}
.toggle-slider {
  width: 34px;
  height: 18px;
  border-radius: 10px;
  background: var(--border);
  position: relative;
  transition: all 0.2s;
  flex-shrink: 0;
}
.toggle-slider::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--text3);
  transition: all 0.2s;
}
.provider-toggle input:checked + .toggle-slider {
  background: rgba(94, 203, 138, 0.4);
}
.provider-toggle input:checked + .toggle-slider::after {
  left: 18px;
  background: var(--green);
}

/* 自定义 Provider */
.custom-provider {
  border: 1px dashed var(--border2);
  border-radius: 10px;
  padding: 12px 14px;
}
.custom-provider-title {
  font-size: 12.5px;
  color: var(--text2);
  font-weight: 600;
  margin-bottom: 10px;
}
.custom-provider-row {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}
.custom-provider-row .input {
  flex: 1;
  height: 36px;
  font-size: 13px;
}
.custom-btn {
  padding: 0 16px;
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
.custom-btn:hover {
  border-color: var(--blue);
  color: var(--blue);
}

.role-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}
.role-pick-btn {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 7px 11px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--bg3);
  color: var(--text2);
  font-size: 12.5px;
  cursor: pointer;
  transition: all 0.15s;
}
.role-pick-btn:hover {
  border-color: var(--border2);
}
.role-pick-btn.active {
  border-color: var(--blue);
  color: var(--blue);
  background: rgba(69, 184, 255, 0.08);
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 20px;
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

/* 渐变保存按钮（原生 button，不经过子组件事件链） */
.btn-save {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 40px;
  padding: 0 22px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--grad1);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity var(--dur) var(--ease), transform 0.1s;
}
.btn-save:hover {
  opacity: 0.9;
}
.btn-save:active {
  transform: translateY(1px);
}

/* 合并弹窗 */
.merge-modal {
  width: 400px;
}
.merge-from {
  font-size: 13px;
  color: var(--text2);
  margin-bottom: 16px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.merge-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.merge-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 13px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg3);
  cursor: pointer;
  transition: all 0.15s;
}
.merge-item:hover {
  border-color: var(--blue);
  background: rgba(69, 184, 255, 0.05);
}
.merge-name {
  flex: 1;
  font-size: 13.5px;
  color: var(--text);
  text-align: left;
}
.merge-arrow {
  font-size: 12px;
  color: var(--blue);
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
