<script setup lang="ts">
/**
 * Agent 表单页（新建/编辑，双模式）
 * - 池模式（默认）：保存到 Agent 池（sys_agent），POST/PUT /api/agent
 * - 项目模式（?projectId=）：保存为项目团队成员（sys_project_agent），POST/PUT /api/project-agent
 * userId 后端从 JWT 取，前端不传
 */
import { ref, computed, onMounted } from 'vue'
import { useRouter,useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { createAgentPool, updateAgentPool, fetchAgentPoolById } from '../api/agentPools'
import { createProjectAgent, updateProjectAgent, fetchProjectAgentById } from '../api/agent'
import type { agentPoolDTO, agentPoolVO, agentDTO } from '../types/agent'

const router = useRouter()
const route = useRoute()

const isEdit = computed(() => !!route.params.id)
const agentPoolId = Number(route.params.id || 0)

/** 项目模式：带 ?projectId= 时保存到项目团队（sys_project_agent），否则保存到池（sys_agent） */
const projectId = Number(route.query.projectId || 0)
const isProjectMode = computed(() => projectId > 0)

onMounted(async () => {
  if (!isEdit.value) return
  try {
    // 项目模式回显项目 Agent（有 projectId），池模式回显池 Agent
    const p = isProjectMode.value ? await fetchProjectAgentById(agentPoolId) : await fetchAgentPoolById(agentPoolId)
    form.value.id = p.id ?? 0
    form.value.userId = p.userId ?? null
    form.value.name = p.name ?? ''
    form.value.role = p.role ?? ''
    form.value.systemPrompt = p.systemPrompt ?? ''
    form.value.tools = p.tools ?? ''
    form.value.model = p.model ?? ''
    form.value.temperature = p.temperature ?? 0.7
    form.value.status = p.status ?? 0
    form.value.createTime = p.createTime ?? ''
    form.value.updateTime = p.updateTime ?? ''
  } catch {
    /* 拦截器已提示 */
  }

  toolsArr.value = toolsParse(form.value.tools)
})


// ===== 职责预设（与 TeamView 一致） =====
type AgentRole = 'manager' | 'architect' | 'backend' | 'frontend' | 'tester' | 'devops' | 'docs'

const ROLE_META: Record<AgentRole, { label: string; color: string; bg: string; icon: string }> = {
  manager: { label: '项目经理', color: '#f070a0', bg: 'rgba(240,112,160,.12)', icon: '' },
  architect: { label: '架构师', color: '#a76bff', bg: 'rgba(167,107,255,.12)', icon: '' },
  backend: { label: '后端开发', color: '#5ecb8a', bg: 'rgba(94,203,138,.12)', icon: '' },
  frontend: { label: '前端开发', color: '#f0c060', bg: 'rgba(240,192,96,.12)', icon: '' },
  tester: { label: '测试', color: '#5ec8c0', bg: 'rgba(94,200,192,.12)', icon: '' },
  devops: { label: '运维部署', color: '#f09050', bg: 'rgba(144,80,50,.12)', icon: '' },
  docs: { label: '文档维护', color: '#45b8ff', bg: 'rgba(69,184,255,.12)', icon: '' },
}

// ===== 模型与 API Key（与 TeamView 一致，从首页配置的 localStorage 恢复） =====
interface ModelProvider {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  enabled: boolean
  builtin?: boolean
  models: string[]
}

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

// ===== 表单 =====

/** 工具项：函数名 + 作用说明 */
interface ToolItem {
  name: string
  desc: string
}

/**
 * tools（JSON 数组字符串，如 '["web_search:联网搜索","read_file"]'）→ 工具行
 * 兼容旧格式：非 JSON（逗号分隔）时降级按逗号拆
 */
function toolsParse(tools: string): ToolItem[] {
  if (!tools) return []
  let arr: string[]
  try {
    const parsed = JSON.parse(tools)
    arr = Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    arr = tools.split(',')
  }
  return arr
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .map(item => {
      const [name, desc] = item.split(':').map(s => s.trim())
      return {
        name: name || item,
        desc: desc || ''
      }
    })
}

/** 工具行 → tools JSON 数组字符串（元素格式 "函数名:作用"） */
function toolsCombine(tools: ToolItem[]): string {
  if (!tools || tools.length === 0) return ''
  const arr = tools
    .map(t => t.name.trim())
    .filter(s => s.length > 0)
    .map((name, i) => {
      const desc = (tools[i].desc || '').trim()
      return desc ? `${name}:${desc}` : name
    })
  return JSON.stringify(arr)
}

const toolsArr = ref<ToolItem[]>([])

const form = ref<agentPoolVO>({
    id: 0,
    userId: 0,           // 数字可为 null
    name: '',               // 字符串给空串
    role: '',               // 字符串给空串
    systemPrompt: '',       // 字符串给空串
    tools: '',              // 工具是数组，给空数组
    model: '',              // 字符串给空串
    temperature: 0.7,       // 温度给默认值 0.7
    status: 0,              // 状态给 0（待定）
    createTime: '',         // 时间给空串
    updateTime: ''          // 时间给空串
})

const saving = ref(false)

/** 文本框随内容自动增高（不出现框内滚动，长度增长 → 行高增长） */
function autoResize(el: HTMLTextAreaElement) {
  el.style.height = 'auto'
  el.style.height = el.scrollHeight + 'px'
}

/** 添加一个工具行 */
function addTool() {
  toolsArr.value.push({ name: '', desc: '' })
}

/** 删除工具行 */
function removeTool(i: number) {
  toolsArr.value.splice(i, 1)
}

/** 保存：池模式 POST/PUT /api/agent；项目模式 POST/PUT /api/project-agent */
async function save() {
  const name = form.value.name.trim()
  if (!name) {
    ElMessage.warning('请填写 Agent 名称')
    return
  }
  saving.value = true
  try {
    if (isProjectMode.value) {
      // 项目模式：团队成员（sys_project_agent）
      const dto: agentDTO = {
        projectId,
        name,
        role: form.value.role,
        systemPrompt: form.value.systemPrompt,
        tools: toolsCombine(toolsArr.value),
        model: form.value.model,
        temperature: form.value.temperature,
        status: form.value.status ?? 1,
      }
      if (isEdit.value) {
        await updateProjectAgent(agentPoolId, dto)
        ElMessage.success(`成员「${name}」已更新`)
      } else {
        await createProjectAgent(dto)
        ElMessage.success(`成员「${name}」已加入团队`)
      }
      router.push(`/projects/${projectId}/team`)
    } else {
      // 池模式：Agent 仓库（sys_agent）
      const dto: agentPoolDTO = {
        name,
        role: form.value.role,
        systemPrompt: form.value.systemPrompt,
        tools: toolsCombine(toolsArr.value),
        model: form.value.model,
        temperature: form.value.temperature,
        status: form.value.status ?? 1,
      }
      if (isEdit.value) {
        await updateAgentPool(agentPoolId, dto)
        ElMessage.success(`Agent「${name}」已更新`)
      } else {
        await createAgentPool(dto)
        ElMessage.success(`Agent「${name}」已保存到仓库`)
      }
      router.push('/agents')
    }
  } catch {
    ElMessage.error('保存失败，请重试')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="agent-form">
    <!-- 顶栏 -->
    <header class="topbar">
      <div class="topbar-left">
        <div class="logo">
          <img src="../assets/logo-crewforge.png" alt="CrewForge" />
          <span>CrewForge</span>
        </div>
      </div>
      <div class="topbar-right">
        <button class="btn-back" @click="router.back()">← 返回</button>
        <span class="avatar">K</span>
      </div>
    </header>

    <main class="main">
      <!-- 表单面板（全屏铺开，字段自适应栅格） -->
      <div class="form-panel">
        <div class="card-head">
          <h1>
            {{ isProjectMode ? (isEdit ? '编辑成员' : '新建成员') : isEdit ? '编辑 Agent' : '新建 Agent' }}
          </h1>
          <p class="card-desc">
            {{
              isProjectMode
                ? '配置项目团队成员，保存后返回团队配置'
                : '保存到你的 Agent 仓库，之后在项目团队配置里可以一键复制使用'
            }}
          </p>
        </div>

        <div class="form-grid">
          <div class="form-field">
            <label>名称 <span class="req">*</span></label>
            <input
              v-model="form.name"
              class="input"
              type="text"
              placeholder="如：后端开发 Agent"
            />
            <p class="field-hint">同一仓库内不重名</p>
          </div>

          <div class="form-field">
            <label>职位</label>
            <select v-model="form.role" class="select">
              <option v-for="(meta, key) in ROLE_META" :key="key" :value="meta.label">{{ meta.label }}</option>
            </select>
          </div>

          <!-- Prompt(2/3) + 工具(1/3) 并排 -->
          <div class="prompt-row">
            <div class="form-field">
              <label>System Prompt</label>
              <textarea
                v-model="form.systemPrompt"
                class="prompt-area"
                rows="5"
                placeholder="该 Agent 的角色设定与行为规则..."
                @input="autoResize($event.target as HTMLTextAreaElement)"
              ></textarea>
            </div>

            <!-- 工具列表：函数名 + 作用，框内上下滚动 -->
            <div class="form-field tools-panel">
              <div class="tools-head">
                <label>工具</label>
                <button class="btn-add-tool" @click="addTool">+ 添加</button>
              </div>
              <div class="tools-list">
                <div v-for="(t, i) in toolsArr" :key="i" class="tool-row">
                  <input v-model="t.name" class="input tool-name" type="text" placeholder="函数名" />
                  <input v-model="t.desc" class="input tool-desc" type="text" placeholder="作用" />
                  <button class="tool-del" title="删除" @click="removeTool(i)">✕</button>
                </div>
              </div>
            </div>
          </div>

          <div class="form-field">
            <label>大模型 <span class="field-hint">跟随全局 = 使用首页配置的默认模型</span></label>
            <select v-model="form.model" class="select">
              <option value="">跟随全局（{{ modelLabel(globalDefaultModel) }}）</option>
              <optgroup v-for="g in enabledModelOptions" :key="g.group" :label="g.group">
                <option v-for="m in g.items" :key="m" :value="m">{{ m.split('/').slice(1).join('/') }}</option>
              </optgroup>
            </select>
          </div>

          <div class="form-field">
            <label>采样温度 <span class="field-hint">0.0-2.0，越大越随机</span></label>
            <input
              v-model.number="form.temperature"
              class="input"
              type="number"
              min="0"
              max="2"
              step="0.1"
            />
          </div>
        </div>

        <div class="form-actions">
          <button class="btn-cancel" @click="router.back()">取消</button>
          <button class="btn-save" :disabled="saving" @click="save">保存</button>
        </div>
      </div>
    </main>
  </div>
</template>

<style scoped>
.agent-form {
  min-height: 100vh;
  background: transparent;
}

/* ===== 顶栏（与仓库页一致） ===== */
.topbar {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 48px;
  height: 56px;
  border-bottom: 1px solid var(--border);
  background: rgba(15, 19, 31, 0.85);
  backdrop-filter: blur(12px);
}
.topbar-left {
  display: flex;
  align-items: center;
  gap: 14px;
}
.topbar-right {
  display: flex;
  align-items: center;
  gap: 14px;
}
.logo {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 600;
  font-size: 15px;
}
.logo img {
  width: 28px;
  height: 28px;
  border-radius: 8px;
}
.btn-back {
  padding: 6px 14px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text2);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
}
.btn-back:hover {
  border-color: var(--blue);
  color: var(--blue);
}
.avatar {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--bg4);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 600;
  color: var(--text2);
}

/* ===== 主体：全屏表单面板（撑满视口剩余高度，上下留白对称） ===== */
.main {
  width: 100%;
  box-sizing: border-box;
  min-height: calc(100vh - 56px); /* 顶栏高度 */
  display: flex;
  padding: 32px 48px;
}
.form-panel {
  flex: 1;
  width: 100%;
  display: flex;
  flex-direction: column;
  padding: 28px 32px 32px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--bg2);
}
.card-head {
  margin-bottom: 24px;
}
.card-head h1 {
  font-size: 20px;
}
.card-desc {
  margin-top: 6px;
  font-size: 13px;
  color: var(--text3);
}

/* 字段栅格：固定两列，窄屏收成一列；flex:1 让内容区撑满面板 */
.form-grid {
  flex: 1;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px 24px;
  align-content: start;
}

/* Prompt(2/3) + 工具(1/3) 并排一行 */
.prompt-row {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 24px;
}

.form-field label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  color: var(--text2);
  margin-bottom: 6px;
}

/* ===== 工具面板：函数名 + 作用，固定高度框内滚动 ===== */
.tools-panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.tools-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.btn-add-tool {
  padding: 3px 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg3);
  color: var(--text2);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}
.btn-add-tool:hover {
  border-color: var(--blue);
  color: var(--blue);
}
.tools-list {
  flex: 1;
  min-height: 120px;
  max-height: 260px;
  overflow-y: auto; /* 工具多时框内上下滚动 */
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg3);
}
.tool-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tool-name {
  flex: 2;
  font-family: 'Consolas', 'JetBrains Mono', monospace;
  font-size: 12.5px;
}
.tool-desc {
  flex: 3;
  font-size: 12.5px;
}
.tool-del {
  flex: none;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text3);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}
.tool-del:hover {
  background: rgba(240, 80, 80, 0.15);
  color: var(--red);
}

/* 窄屏：所有列收成一列 */
@media (max-width: 900px) {
  .form-grid,
  .prompt-row {
    grid-template-columns: 1fr;
  }
}
.req {
  color: var(--red, #f070a0);
}
.field-hint {
  font-size: 12px;
  color: var(--text3);
  font-weight: 400;
}
.input,
.select,
.prompt-area {
  width: 100%;
  padding: 9px 12px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg3);
  color: var(--text);
  font-size: 13.5px;
  outline: none;
  transition: border-color 0.2s;
}
.input:focus,
.select:focus,
.prompt-area:focus {
  border-color: var(--blue);
}
.prompt-area {
  resize: none; /* 自动增高接管，禁止手动拖拽 */
  overflow: hidden; /* 内容超出增高，不出现框内滚动 */
  min-height: 120px;
  font-family: inherit;
  line-height: 1.6;
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: auto;
  padding-top: 28px;
}
.btn-cancel {
  padding: 8px 18px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text2);
  font-size: 13.5px;
  cursor: pointer;
  transition: all 0.2s;
}
.btn-cancel:hover {
  border-color: var(--text3);
  color: var(--text);
}
.btn-save {
  padding: 8px 22px;
  border-radius: 8px;
  border: none;
  background: var(--grad1, linear-gradient(135deg, #45b8ff, #a76bff));
  color: #fff;
  font-size: 13.5px;
  font-weight: 500;
  cursor: pointer;
  transition: opacity 0.2s;
}
.btn-save:hover {
  opacity: 0.9;
}
.btn-save:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
