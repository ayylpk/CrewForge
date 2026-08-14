<script setup lang="ts">
/**
 * Agent 表单页（新建/编辑，双模式），Agent 配置以"节点"为原子
 * - 池模式（默认）：保存到 Agent 池（sys_agent），档案 = 名称/职位；节点存 sys_agent_node（POST/PUT /api/agent-node）
 * - 项目模式（?projectId=）：成员档案来自池（只读展示，JOIN sys_agent），节点存 sys_project_agent_node（复制自池，项目内独立）
 *   - 项目模式新建（/agents/new?projectId=）没有池关联 → 引导页：成员必须从仓库拉取
 * userId 后端从 JWT 取，前端不传
 */
import { ref, computed, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { createAgentPool, updateAgentPool, fetchAgentPoolById } from '../api/agentPools'
import { fetchProjectAgentById } from '../api/agent'
import {
  fetchAgentNodes, createAgentNode, updateAgentNode, deleteAgentNode,
} from '../api/agentNode'
import {
  fetchProjectAgentNodes, createProjectAgentNode, updateProjectAgentNode, deleteProjectAgentNode,
} from '../api/projectAgentNode'
import type { agentNodeVO, projectAgentNodeVO, agentNodeDTO, projectAgentNodeDTO } from '../types/agent'

const router = useRouter()
const route = useRoute()

const isEdit = computed(() => !!route.params.id)
const agentPoolId = Number(route.params.id || 0)

/** 项目模式：带 ?projectId= 时保存到项目团队（sys_project_agent），否则保存到池（sys_agent） */
const projectId = Number(route.query.projectId || 0)
const isProjectMode = computed(() => projectId > 0)

/** 项目模式新建 = 无池关联的成员无法配置 → 引导页 */
const showGuide = computed(() => isProjectMode.value && !isEdit.value)

// ===== 职责预设（与 TeamView 一致，供职位下拉） =====
const ROLE_META: Record<string, { label: string }> = {
  manager: { label: '项目经理' },
  architect: { label: '架构师' },
  backend: { label: '后端开发' },
  frontend: { label: '前端开发' },
  tester: { label: '测试' },
  devops: { label: '运维部署' },
  docs: { label: '文档维护' },
}

// ===== 池模式档案表单（名称/职位；提示词等配置在节点里） =====
const form = ref({
  id: 0,
  name: '',
  role: '',
  status: 0,
})

// ===== 项目模式：档案来自池（只读，回显到 form 展示） =====
const memberAgentId = ref(0)   // 成员引用的池 Agent id；0 = 无池关联

// ===== 模型（与 TeamView 一致，从首页配置的 localStorage 恢复） =====
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

// ===== 节点（工作区：未保存的增删改都在内存，点保存才落库） =====

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

/** 工作区节点（id = null 表示本地新增，尚未落库；expanded 仅控制卡片提示词展开） */
interface NodeEdit {
  id: number | null
  nodeName: string
  description: string
  systemPrompt: string
  tools: string
  model: string
  temperature: number | null
  expanded?: boolean
}

const nodes = ref<NodeEdit[]>([])
/** 本地删除的服务端节点 id（保存时 DELETE） */
const removedIds = ref<number[]>([])

function toNodeEdit(v: agentNodeVO | projectAgentNodeVO): NodeEdit {
  return {
    id: v.id,
    nodeName: v.nodeName ?? '',
    description: v.description ?? '',
    systemPrompt: v.systemPrompt ?? '',
    tools: v.tools ?? '',
    model: v.model ?? '',
    temperature: v.temperature ?? null,
  }
}

// ===== 节点编辑器（内嵌面板） =====
interface NodeDraft {
  index: number           // nodes 中的位置，-1 = 新增
  nodeName: string
  description: string
  systemPrompt: string
  toolsArr: ToolItem[]
  model: string
  temperature: number | null
}
const editing = ref<NodeDraft | null>(null)

function startAddNode() {
  editing.value = {
    index: -1,
    nodeName: '',
    description: '',
    systemPrompt: '',
    toolsArr: [],
    model: '',
    temperature: 0.7,
  }
}

function startEditNode(i: number) {
  const n = nodes.value[i]
  editing.value = {
    index: i,
    nodeName: n.nodeName,
    description: n.description,
    systemPrompt: n.systemPrompt,
    toolsArr: toolsParse(n.tools),
    model: n.model,
    temperature: n.temperature,
  }
}

function cancelEdit() {
  editing.value = null
}

/** 编辑器内工具行操作 */
function editAddTool() {
  editing.value?.toolsArr.push({ name: '', desc: '' })
}
function editRemoveTool(i: number) {
  editing.value?.toolsArr.splice(i, 1)
}

/** 编辑器保存 → 写回工作区节点（不落库） */
function saveNodeDraft() {
  const d = editing.value
  if (!d) return
  if (!d.nodeName.trim()) {
    ElMessage.warning('请填写节点名称')
    return
  }
  const node: NodeEdit = {
    id: d.index >= 0 ? nodes.value[d.index].id : null,
    nodeName: d.nodeName.trim(),
    description: d.description.trim(),
    systemPrompt: d.systemPrompt,
    tools: toolsCombine(d.toolsArr),
    model: d.model,
    temperature: d.temperature ?? 0.7,
  }
  if (d.index >= 0) nodes.value[d.index] = node
  else nodes.value.push(node)
  editing.value = null
}

/** 删除节点：记下服务端 id（保存时 DELETE），本地移除 */
async function removeNode(i: number) {
  const n = nodes.value[i]
  try {
    await ElMessageBox.confirm(`确定删除节点「${n.nodeName}」吗？`, '删除确认', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    return // 用户取消
  }
  if (n.id != null) removedIds.value.push(n.id)
  nodes.value.splice(i, 1)
}

/** 文本框随内容自动增高 */
function autoResize(el: HTMLTextAreaElement) {
  el.style.height = 'auto'
  el.style.height = el.scrollHeight + 'px'
}

// ===== 页面初始化（回显档案 + 节点） =====
onMounted(async () => {
  // 项目模式新建：引导页，无需拉取
  if (showGuide.value) return

  if (isProjectMode.value) {
    try {
      // 项目模式：成员档案来自池（JOIN 带出 name/role），节点存项目表
      const p = await fetchProjectAgentById(agentPoolId)
      memberAgentId.value = p.agentId ?? 0
      form.value.name = p.name ?? ''
      form.value.role = p.role ?? ''
      if (memberAgentId.value > 0) {
        nodes.value = (await fetchProjectAgentNodes(projectId, memberAgentId.value)).map(toNodeEdit)
      }
    } catch {
      /* 拦截器已提示 */
    }
    return
  }

  // 池模式：回显档案 + 池节点
  if (!isEdit.value) return
  try {
    const p = await fetchAgentPoolById(agentPoolId)
    form.value.id = p.id ?? 0
    form.value.name = p.name ?? ''
    form.value.role = p.role ?? ''
    form.value.status = p.status ?? 0
    nodes.value = (await fetchAgentNodes(agentPoolId)).map(toNodeEdit)
  } catch {
    /* 拦截器已提示 */
  }
})

// ===== 保存 =====
const saving = ref(false)

/** 节点 diff 落库：新建 POST、已存在 PUT、本地删除 DELETE */
async function persistNodes(mode: 'pool' | 'project', agentId: number) {
  for (const n of nodes.value) {
    const base = {
      agentId,
      nodeName: n.nodeName,
      description: n.description,
      systemPrompt: n.systemPrompt,
      tools: n.tools,
      model: n.model,
      temperature: n.temperature,
    }
    if (mode === 'pool') {
      if (n.id == null) await createAgentNode(base as agentNodeDTO)
      else await updateAgentNode(n.id, base as agentNodeDTO)
    } else {
      const dto = { ...base, projectId } as projectAgentNodeDTO
      if (n.id == null) await createProjectAgentNode(dto)
      else await updateProjectAgentNode(n.id, dto)
    }
  }
  for (const id of removedIds.value) {
    if (mode === 'pool') await deleteAgentNode(id)
    else await deleteProjectAgentNode(id)
  }
}

async function save() {
  if (saving.value) return
  // 池模式：先存档案（新建拿到新 id），再存节点
  if (!isProjectMode.value) {
    const name = form.value.name.trim()
    if (!name) {
      ElMessage.warning('请填写 Agent 名称')
      return
    }
    saving.value = true
    try {
      let poolId = agentPoolId
      if (isEdit.value) {
        await updateAgentPool(poolId, { name, role: form.value.role, status: form.value.status ?? 1 })
      } else {
        poolId = await createAgentPool({ name, role: form.value.role, status: 1 })
      }
      await persistNodes('pool', poolId)
      ElMessage.success(isEdit.value ? `Agent「${name}」已更新` : `Agent「${name}」已保存到仓库`)
      router.push('/agents')
    } catch {
      ElMessage.error('保存失败，请重试')
    } finally {
      saving.value = false
    }
    return
  }
  // 项目模式（仅编辑可达，引导页无保存）：只存节点，档案只读不动
  if (memberAgentId.value <= 0) return
  saving.value = true
  try {
    await persistNodes('project', memberAgentId.value)
    ElMessage.success(`「${form.value.name || '成员'}」节点已保存`)
    router.push(`/projects/${projectId}/team`)
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
      <div class="form-panel">
        <!-- ===== 项目模式新建：无池关联的成员无法配置 → 引导 ===== -->
        <div v-if="showGuide" class="guide">
          <div class="guide-ico">▣</div>
          <h1>成员从 Agent 仓库拉取</h1>
          <p class="guide-desc">
            项目成员必须来自 Agent 仓库（池 Agent），拉取时会把节点的配置复制一份进项目。
            请回到团队配置页，点击「从仓库拉取」选择成员。
          </p>
          <button class="btn-save" @click="router.push(`/projects/${projectId}/team`)">去团队配置</button>
        </div>

        <!-- ===== 正常表单：档案（只读/可编辑）+ 节点管理 ===== -->
        <template v-else>
          <div class="card-head">
            <h1>
              {{ isProjectMode ? '编辑成员' : isEdit ? '编辑 Agent' : '新建 Agent' }}
            </h1>
            <p class="card-desc">
              <template v-if="isProjectMode">
                成员档案来自 Agent 仓库（只读），下方节点配置复制自仓库、项目内独立修改
              </template>
              <template v-else>
                Agent 配置以节点为原子：一个 Agent 可配多个节点（如规划/编码），每节点一套提示词、工具与模型
              </template>
            </p>
          </div>

          <div class="form-grid">
            <!-- 名称：池模式可编辑必填；项目模式只读 -->
            <div class="form-field">
              <label>名称 <span class="req">*</span></label>
              <input
                v-model="form.name"
                class="input"
                type="text"
                placeholder="如：后端开发 Agent"
                :readonly="isProjectMode"
                :class="{ readonly: isProjectMode }"
              />
              <p class="field-hint">{{ isProjectMode ? '档案来自 Agent 仓库' : '同一仓库内不重名' }}</p>
            </div>

            <!-- 职位：池模式可编辑；项目模式只读 -->
            <div class="form-field">
              <label>职位</label>
              <select
                v-model="form.role"
                class="select"
                :disabled="isProjectMode"
                :class="{ readonly: isProjectMode }"
              >
                <option v-for="(meta, key) in ROLE_META" :key="key" :value="meta.label">{{ meta.label }}</option>
              </select>
            </div>
          </div>

          <!-- ===== 节点管理区 ===== -->
          <div class="node-section">
            <div class="node-head">
              <h2>节点配置</h2>
              <span class="node-hint">{{ nodes.length }} 个节点 · 每节点一套提示词/工具/模型</span>
              <button class="btn-add-node" @click="startAddNode">+ 添加节点</button>
            </div>

            <!-- 无池关联（手动添加的成员） -->
            <div v-if="isProjectMode && memberAgentId <= 0" class="node-empty">
              该成员未关联 Agent 池，无法配置节点。建议移除后从仓库拉取。
            </div>

            <!-- 节点列表 -->
            <div v-else-if="nodes.length === 0 && !editing" class="node-empty">
              还没有节点，点击「+ 添加节点」为这个 {{ isProjectMode ? '成员' : 'Agent' }} 配置第一套提示词
            </div>

            <div v-else class="node-list">
              <div v-for="(n, i) in nodes" :key="i" class="node-card">
                <div class="node-top">
                  <span class="node-name">{{ n.nodeName }}</span>
                  <span class="node-ops">
                    <button class="op-btn" title="编辑" @click="startEditNode(i)">✎</button>
                    <button class="op-btn del" title="删除" @click="removeNode(i)">✕</button>
                  </span>
                </div>
                <p class="node-desc">{{ n.description || '（无描述）' }}</p>
                <div class="node-meta">
                  <span class="meta-item">{{ n.model ? modelLabel(n.model) : '跟随全局模型' }}</span>
                  <span class="meta-item">温度 {{ n.temperature ?? 0.7 }}</span>
                  <span class="meta-item">{{ toolsParse(n.tools).length }} 个工具</span>
                </div>
                <!-- 工具明细 -->
                <div v-if="toolsParse(n.tools).length" class="node-tools">
                  <span v-for="t in toolsParse(n.tools)" :key="t.name" class="tool-tag">
                    {{ t.name }}{{ t.desc ? `：${t.desc}` : '' }}
                  </span>
                </div>
                <!-- 提示词：默认截断，点击展开完整内容 -->
                <div class="node-prompt-wrap">
                  <p class="node-prompt" :class="{ full: n.expanded }">{{ n.systemPrompt || '（未配置提示词）' }}</p>
                  <button
                    v-if="n.systemPrompt && n.systemPrompt.length > 60"
                    class="prompt-toggle"
                    @click="n.expanded = !n.expanded"
                  >
                    {{ n.expanded ? '收起' : '展开全文' }}
                  </button>
                </div>
              </div>
            </div>

            <!-- 节点编辑器（内嵌） -->
            <div v-if="editing" class="node-editor">
              <div class="ed-head">
                <h3>{{ editing.index >= 0 ? '编辑节点' : '新增节点' }}</h3>
                <button class="op-btn" title="关闭" @click="cancelEdit">✕</button>
              </div>
              <div class="ed-grid">
                <div class="form-field">
                  <label>节点名称 <span class="req">*</span> <span class="field-hint">如"规划节点"、"编码节点"</span></label>
                  <input v-model="editing.nodeName" class="input" type="text" placeholder="如：规划节点" />
                </div>
                <div class="form-field">
                  <label>作用描述</label>
                  <input v-model="editing.description" class="input" type="text" placeholder="该节点负责什么" />
                </div>
                <div class="form-field ed-prompt">
                  <label>System Prompt</label>
                  <textarea
                    v-model="editing.systemPrompt"
                    class="prompt-area"
                    rows="5"
                    placeholder="该节点的角色设定与行为规则..."
                    @input="autoResize($event.target as HTMLTextAreaElement)"
                  ></textarea>
                </div>
                <div class="form-field ed-tools">
                  <div class="tools-head">
                    <label>工具</label>
                    <button class="btn-add-tool" @click="editAddTool">+ 添加</button>
                  </div>
                  <div class="tools-list">
                    <div v-for="(t, ti) in editing.toolsArr" :key="ti" class="tool-row">
                      <input v-model="t.name" class="input tool-name" type="text" placeholder="函数名" />
                      <input v-model="t.desc" class="input tool-desc" type="text" placeholder="作用" />
                      <button class="tool-del" title="删除" @click="editRemoveTool(ti)">✕</button>
                    </div>
                  </div>
                </div>
                <div class="form-field">
                  <label>大模型 <span class="field-hint">跟随全局 = 使用首页配置的默认模型</span></label>
                  <select v-model="editing.model" class="select">
                    <option value="">跟随全局（{{ modelLabel(globalDefaultModel) }}）</option>
                    <optgroup v-for="g in enabledModelOptions" :key="g.group" :label="g.group">
                      <option v-for="m in g.items" :key="m" :value="m">{{ m.split('/').slice(1).join('/') }}</option>
                    </optgroup>
                  </select>
                </div>
                <div class="form-field">
                  <label>采样温度 <span class="field-hint">0.0-2.0，越大越随机</span></label>
                  <input
                    v-model.number="editing.temperature"
                    class="input"
                    type="number"
                    min="0"
                    max="2"
                    step="0.1"
                  />
                </div>
              </div>
              <div class="ed-actions">
                <button class="btn-cancel" @click="cancelEdit">取消</button>
                <button class="btn-save" @click="saveNodeDraft">保存节点</button>
              </div>
            </div>
          </div>

          <div class="form-actions">
            <button class="btn-cancel" @click="router.back()">取消</button>
            <button class="btn-save" :disabled="saving" @click="save">{{ saving ? '保存中...' : '保存' }}</button>
          </div>
        </template>
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

/* ===== 主体 ===== */
.main {
  width: 100%;
  box-sizing: border-box;
  display: flex;
  padding: 32px 48px 60px;
}
.form-panel {
  flex: 1;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 28px 32px 32px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--bg2);
}
.card-head h1 {
  font-size: 20px;
}
.card-desc {
  margin-top: 6px;
  font-size: 13px;
  color: var(--text3);
}

/* ===== 档案字段（两列栅格） ===== */
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px 24px;
}
.form-field label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  color: var(--text2);
  margin-bottom: 6px;
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
/* 项目模式只读态 */
.input.readonly,
.select.readonly {
  color: var(--text3);
  cursor: not-allowed;
}
.prompt-area {
  resize: none;
  overflow: hidden;
  min-height: 120px;
  font-family: inherit;
  line-height: 1.6;
}

/* ===== 节点管理区 ===== */
.node-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 4px;
}
.node-head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.node-head h2 {
  font-size: 15px;
  font-weight: 700;
}
.node-hint {
  flex: 1;
  font-size: 12px;
  color: var(--text3);
}
.btn-add-node {
  padding: 6px 14px;
  border-radius: 8px;
  border: 1px solid var(--blue);
  background: rgba(69, 184, 255, 0.08);
  color: var(--blue);
  font-size: 12.5px;
  cursor: pointer;
  transition: all 0.2s;
}
.btn-add-node:hover {
  background: rgba(69, 184, 255, 0.15);
}
.node-empty {
  padding: 36px 0;
  text-align: center;
  color: var(--text3);
  font-size: 13px;
  line-height: 1.8;
  border: 1px dashed var(--border2);
  border-radius: 10px;
  background: var(--bg3);
}
.node-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}
.node-card {
  display: flex;
  flex-direction: column;
  padding: 14px 16px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg3);
  transition: border-color 0.2s;
}
.node-card:hover {
  border-color: var(--blue);
}
.node-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.node-name {
  font-size: 14px;
  font-weight: 600;
}
.node-ops {
  display: flex;
  gap: 4px;
}
.op-btn {
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
.op-btn:hover {
  background: rgba(69, 184, 255, 0.15);
  color: var(--blue);
}
.op-btn.del:hover {
  background: rgba(240, 80, 80, 0.15);
  color: var(--red);
}
.node-desc {
  font-size: 12px;
  color: var(--text2);
  margin-bottom: 8px;
}
.node-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 12px;
  margin-bottom: 8px;
}
.meta-item {
  font-size: 11.5px;
  color: var(--text3);
  padding: 2px 8px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg2);
}
/* 工具明细标签 */
.node-tools {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}
.tool-tag {
  font-size: 11px;
  color: var(--blue);
  padding: 2px 9px;
  border-radius: 8px;
  background: rgba(69, 184, 255, 0.08);
  border: 1px solid rgba(69, 184, 255, 0.25);
  font-family: 'Consolas', 'JetBrains Mono', monospace;
}
.node-prompt-wrap {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.node-prompt {
  font-size: 12px;
  color: var(--text2);
  line-height: 1.6;
  white-space: pre-line;
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.node-prompt.full {
  display: block;
  max-height: 240px;
  overflow-y: auto;
}
.prompt-toggle {
  align-self: flex-start;
  border: none;
  background: transparent;
  color: var(--blue);
  font-size: 11.5px;
  cursor: pointer;
  padding: 0;
}
.prompt-toggle:hover {
  text-decoration: underline;
}

/* ===== 节点编辑器 ===== */
.node-editor {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px 20px;
  border-radius: 12px;
  border: 1px solid var(--blue);
  background: var(--bg3);
}
.ed-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.ed-head h3 {
  font-size: 14px;
  font-weight: 600;
}
.ed-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px 20px;
}
.ed-prompt {
  grid-column: 1 / -1;
}
.ed-tools {
  grid-column: 1 / -1;
  display: flex;
  flex-direction: column;
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
  background: var(--bg2);
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
  min-height: 72px;
  max-height: 200px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg2);
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
.ed-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

/* ===== 底部按钮 ===== */
.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
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

/* ===== 引导页（项目模式新建） ===== */
.guide {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 80px 0;
  text-align: center;
}
.guide-ico {
  width: 64px;
  height: 64px;
  border-radius: 18px;
  background: rgba(69, 184, 255, 0.1);
  border: 1px solid rgba(69, 184, 255, 0.3);
  color: var(--blue);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 28px;
}
.guide h1 {
  font-size: 19px;
}
.guide-desc {
  max-width: 460px;
  font-size: 13px;
  color: var(--text2);
  line-height: 1.8;
}
.req {
  color: var(--red, #f070a0);
}
.field-hint {
  font-size: 12px;
  color: var(--text3);
  font-weight: 400;
  margin-left: 4px;
}

@media (max-width: 900px) {
  .form-grid,
  .ed-grid {
    grid-template-columns: 1fr;
  }
}
</style>
