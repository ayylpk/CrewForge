<script setup lang="ts">
/**
 * Agent 表单页（新建/编辑，双模式），Agent 配置以"节点"为原子
 * - 池模式（默认）：保存到 Agent 池（sys_agent），档案 = 名称/职位；节点存 sys_agent_node（POST/PUT /api/agent-node）
 * - 项目模式（编辑时带 ?projectId=）：成员档案来自池（只读展示，JOIN sys_agent），节点存 sys_project_agent_node（复制自池，项目内独立）
 * - 团队页新建（/agents/new?projectId=）：先保存到 Agent 池，再自动复制为当前项目成员
 * userId 后端从 JWT 取，前端不传
 */
import { ref, computed, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { ElDialog, ElMessage } from 'element-plus'
import 'element-plus/es/components/dialog/style/css'
import { createAgentPool, updateAgentPool, fetchAgentPoolById } from '../api/agentPools'
import { fetchProjectAgentById, copyFromPool } from '../api/agent'
import {
  fetchAgentNodes, createAgentNode, updateAgentNode, deleteAgentNode,
} from '../api/agentNode'
import {
  fetchProjectAgentNodes, createProjectAgentNode, updateProjectAgentNode, deleteProjectAgentNode,
} from '../api/projectAgentNode'
import type { agentNodeVO, projectAgentNodeVO, agentNodeDTO, projectAgentNodeDTO } from '../types/agent'
import MonacoEditor from '../components/MonacoEditor.vue'

const router = useRouter()
const route = useRoute()

const isEdit = computed(() => !!route.params.id)
const agentPoolId = Number(route.params.id || 0)

/** 编辑成员时保存到项目节点；新建时始终先保存到 Agent 池 */
const projectId = Number(route.query.projectId || 0)
const isProjectMode = computed(() => projectId > 0 && isEdit.value)

// ===== 职责预设（供职位下拉；项目经理/架构师为单例角色：一个项目最多一个，后端自动补模板） =====
const ROLE_META: Record<string, { label: string }> = {
  manager: { label: '项目经理' },
  architect: { label: '架构师' },
  backend: { label: '后端开发' },
  frontend: { label: '前端开发' },
  tester: { label: '测试' },
  maintainer: { label: '维护' },
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

/** 工具项：函数名 + 描述 + 参数 JSON + 函数体代码（对齐运行时 Tool 结构） */
interface ToolItem {
  name: string
  description: string
  /** JSON Schema 文本（空 = 无参数） */
  parameters: string
  /** 函数体（箭头函数字符串；空 = 仅声明不可执行） */
  code: string
}

/** 空工具（新增时用） */
function emptyTool(): ToolItem {
  return { name: '', description: '', parameters: '', code: '' }
}

/**
 * tools（JSON 字符串）→ 工具行
 * 兼容三种存储形态：
 *   新格式：[{"name":"web_search","description":"...","parameters":{...},"code":"..."}]
 *   旧格式：["web_search:联网搜索"]（字符串数组，name:desc）
 *   兜底：  非 JSON 时按逗号拆
 */
function toolsParse(tools: string): ToolItem[] {
  if (!tools) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(tools)
  } catch {
    return tools
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0)
      .map(s => {
        const [name, desc] = s.split(':').map(x => x.trim())
        return { name: name || s, description: desc || '', parameters: '', code: '' }
      })
  }
  if (!Array.isArray(parsed)) return []
  return parsed.map(item => {
    if (typeof item === 'string') {
      // 旧格式字符串 "name:desc"
      const [name, desc] = item.split(':').map(s => s.trim())
      return { name: name || item, description: desc || '', parameters: '', code: '' }
    }
    const o = (item ?? {}) as Record<string, unknown>
    const parameters = o.parameters
    return {
      name: String(o.name ?? '').trim(),
      description: String(o.description ?? '').trim(),
      parameters: parameters && typeof parameters === 'object' ? JSON.stringify(parameters, null, 2) : '',
      code: String(o.code ?? '').trim(),
    }
  }).filter(t => t.name.length > 0)
}

/** 工具行 → tools JSON 字符串（对象数组，空字段省略） */
function toolsCombine(tools: ToolItem[]): string {
  if (!tools || tools.length === 0) return ''
  const arr = tools
    .filter(t => t.name.trim().length > 0)
    .map(t => {
      const out: Record<string, unknown> = { name: t.name.trim(), description: t.description.trim() }
      if (t.parameters.trim()) {
        try { out.parameters = JSON.parse(t.parameters) } catch { /* 保存前已校验，忽略 */ }
      }
      if (t.code.trim()) out.code = t.code.trim()
      return out
    })
  return arr.length > 0 ? JSON.stringify(arr) : ''
}

/** 校验函数体是合法函数表达式（试解析不执行；空 = 仅声明，放行） */
function isValidFunctionCode(code: string): boolean {
  if (!code.trim()) return true
  try {
    // eslint-disable-next-line no-new-func
    new Function(`return (${code})`)
    return true
  } catch {
    return false
  }
}

/** 工作区节点（id = null 表示本地新增，尚未落库；expanded 仅控制卡片提示词展开）
 * 技术字段（nodeType/schemaKey/codeKey/output）用户不可编辑，保存时必须原样带回，
 * 否则 UPDATE 会把它们置 null 覆盖（node_type 是 NOT NULL 列会直接报错） */
interface NodeEdit {
  id: number | null
  nodeName: string
  description: string
  systemPrompt: string
  tools: string
  model: string
  temperature: number | null
  nodeType: string
  schemaKey: string | null
  codeKey: string | null
  output: string | null
  expanded?: boolean
}

const nodes = ref<NodeEdit[]>([])
/** 本地删除的服务端节点 id（保存时 DELETE） */
const removedIds = ref<number[]>([])

function toNodeEdit(v: agentNodeVO | projectAgentNodeVO): NodeEdit {
  // 项目节点（projectAgentNodeVO）无技术字段 → 取不到时给默认（llm）
  const pool = v as agentNodeVO
  return {
    id: v.id,
    nodeName: v.nodeName ?? '',
    description: v.description ?? '',
    systemPrompt: v.systemPrompt ?? '',
    tools: v.tools ?? '',
    model: v.model ?? '',
    temperature: v.temperature ?? null,
    nodeType: pool.nodeType ?? 'llm',
    schemaKey: pool.schemaKey ?? null,
    codeKey: pool.codeKey ?? null,
    output: pool.output ?? null,
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
const toolEditing = ref<ToolItem | null>(null)   // 行内编辑中的工具（null = 未展开）
const toolEditingIndex = ref(-1)                  // toolsArr 下标；-1 = 新增

function editRemoveTool(i: number) {
  editing.value?.toolsArr.splice(i, 1)
  if (toolEditingIndex.value === i) toolEditCancel()
}

function toolEditAdd() {
  toolEditing.value = emptyTool()
  toolEditingIndex.value = -1
}

function toolEditStart(i: number) {
  const t = editing.value?.toolsArr[i]
  if (!t) return
  toolEditing.value = { ...t }
  toolEditingIndex.value = i
}

function toolEditCancel() {
  toolEditing.value = null
  toolEditingIndex.value = -1
}

/** 参数模板：一键填入基础 JSON Schema */
function applyParamTemplate() {
  if (!toolEditing.value) return
  toolEditing.value.parameters = JSON.stringify(
    { type: 'object', properties: {}, required: [] },
    null,
    2,
  )
}

/** 保存工具：校验通过写回 toolsArr，已落库的节点即时更新 API */
async function toolEditSave() {
  const d = toolEditing.value
  if (!d) return
  if (!d.name.trim()) {
    ElMessage.warning('请填写函数名')
    return
  }
  if (!d.description.trim()) {
    ElMessage.warning('请填写作用描述')
    return
  }
  if (d.parameters.trim()) {
    try {
      JSON.parse(d.parameters)
    } catch {
      ElMessage.warning('参数声明不是合法 JSON')
      return
    }
  }
  if (!isValidFunctionCode(d.code)) {
    ElMessage.warning('函数体不是合法的函数表达式（需是箭头函数）')
    return
  }
  const saved: ToolItem = {
    name: d.name.trim(),
    description: d.description.trim(),
    parameters: d.parameters.trim(),
    code: d.code.trim(),
  }
  if (toolEditingIndex.value >= 0 && editing.value) {
    editing.value.toolsArr[toolEditingIndex.value] = saved
  } else {
    editing.value?.toolsArr.push(saved)
  }
  // 已落库的节点 → 工具变更即时写库；新增节点无 id，等保存节点时一起落
  await persistToolToNode()
  toolEditing.value = null
  toolEditingIndex.value = -1
}

/** 工具变更即时写库：仅当编辑的是已落库节点时调用（池/项目模式对应 API） */
async function persistToolToNode() {
  const d = editing.value
  if (!d || d.index < 0) return
  const node = nodes.value[d.index]
  if (!node || node.id == null) return
  const base = {
    agentId: isProjectMode.value ? memberAgentId.value : agentPoolId,
    nodeName: node.nodeName,
    description: node.description,
    systemPrompt: node.systemPrompt,
    tools: toolsCombine(d.toolsArr),
    model: node.model,
    temperature: node.temperature,
  }
  try {
    if (isProjectMode.value) {
      // 项目节点带技术字段（sys_project_agent_node.node_type 是 NOT NULL）
      await updateProjectAgentNode(node.id, {
        ...base,
        projectId,
        nodeType: node.nodeType ?? 'llm',
        schemaKey: node.schemaKey ?? null,
        codeKey: node.codeKey ?? null,
        output: node.output ?? null,
      } as projectAgentNodeDTO)
    } else {
      // 池节点带技术字段（同 persistNodes：缺了会置 null 覆盖 NOT NULL 列）
      await updateAgentNode(node.id, {
        ...base,
        nodeType: node.nodeType ?? 'llm',
        schemaKey: node.schemaKey ?? null,
        codeKey: node.codeKey ?? null,
        output: node.output ?? null,
      } as agentNodeDTO)
    }
    node.tools = base.tools
    ElMessage.success(`工具「${toolEditing.value?.name || '已更新'}」已保存`)
  } catch {
    ElMessage.error('工具保存失败，请重试')
  }
}

/** 编辑器保存 → 写回工作区节点（不落库）；技术字段原样保留 */
function saveNodeDraft() {
  const d = editing.value
  if (!d) return
  if (!d.nodeName.trim()) {
    ElMessage.warning('请填写节点名称')
    return
  }
  const prev = d.index >= 0 ? nodes.value[d.index] : null
  const node: NodeEdit = {
    id: d.index >= 0 ? nodes.value[d.index].id : null,
    nodeName: d.nodeName.trim(),
    description: d.description.trim(),
    systemPrompt: d.systemPrompt,
    tools: toolsCombine(d.toolsArr),
    model: d.model,
    temperature: d.temperature ?? 0.7,
    // 技术字段保留原值（用户不可编辑）
    nodeType: prev?.nodeType ?? 'llm',
    schemaKey: prev?.schemaKey ?? null,
    codeKey: prev?.codeKey ?? null,
    output: prev?.output ?? null,
  }
  if (d.index >= 0) nodes.value[d.index] = node
  else nodes.value.push(node)
  editing.value = null
}

/** 文本框随内容自动增高 */
function autoResize(el: HTMLTextAreaElement) {
  el.style.height = 'auto'
  el.style.height = el.scrollHeight + 'px'
}

// ===== 页面初始化（回显档案 + 节点） =====
onMounted(async () => {
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
    } catch (e) {
      console.error('[AgentFormView] 项目模式加载失败:', e)
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
  } catch (e) {
    console.error('[AgentFormView] 池模式加载失败:', e)
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
      // 池节点必须带技术字段：缺了会把 DB 里的 node_type 等置 null（node_type 是 NOT NULL 会报错）
      const dto = {
        ...base,
        nodeType: n.nodeType ?? 'llm',
        schemaKey: n.schemaKey ?? null,
        codeKey: n.codeKey ?? null,
        output: n.output ?? null,
      } as agentNodeDTO
      if (n.id == null) await createAgentNode(dto)
      else await updateAgentNode(n.id, dto)
    } else {
      // 项目节点同样要带技术字段（sys_project_agent_node.node_type 也是 NOT NULL）
      const dto = {
        ...base,
        projectId,
        nodeType: n.nodeType ?? 'llm',
        schemaKey: n.schemaKey ?? null,
        codeKey: n.codeKey ?? null,
        output: n.output ?? null,
      } as projectAgentNodeDTO
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
      if (projectId > 0) {
        await copyFromPool(projectId, [poolId])
        ElMessage.success(`Agent「${name}」已创建并加入当前项目`)
        router.push(`/projects/${projectId}/team`)
      } else {
        ElMessage.success(isEdit.value ? `Agent「${name}」已更新` : `Agent「${name}」已保存到仓库`)
        router.push('/agents')
      }
    } catch {
      ElMessage.error('保存失败，请重试')
    } finally {
      saving.value = false
    }
    return
  }
  // 项目模式（仅编辑可达）：只存节点，档案只读不动
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
        <!-- ===== 正常表单：档案（只读/可编辑）+ 节点管理 ===== -->
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
              <p class="field-hint">{{ isProjectMode ? '档案来自 Agent 仓库' : '名称可重复，以 ID 区分' }}</p>
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
              <span class="node-hint">{{ nodes.length }} 个节点 · 模板预置，可编辑提示词/工具/模型</span>
            </div>

            <!-- 无池关联（手动添加的成员） -->
            <div v-if="isProjectMode && memberAgentId <= 0" class="node-empty">
              该成员未关联 Agent 池，无法配置节点。建议移除后从仓库拉取。
            </div>

            <!-- 节点列表 -->
            <div v-else-if="nodes.length === 0 && !editing" class="node-empty">
              暂无节点配置（节点由模板预置，如有需要请联系开发者初始化）
            </div>

            <div v-else class="node-list">
              <div v-for="(n, i) in nodes" :key="i" class="node-card" @click="startEditNode(i)">
                <div class="node-top">
                  <span class="node-name">{{ n.nodeName }}</span>
                  <span class="node-ops">
                    <button class="op-btn" title="编辑" @click.stop="startEditNode(i)">✎</button>
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
                    {{ t.name }}{{ t.description ? `：${t.description}` : '' }}{{ t.code ? ' ·可执行' : '' }}
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

            <!-- 节点编辑器（弹窗） -->
            <el-dialog
              :model-value="!!editing"
              title="编辑节点"
              width="680px"
              class="cf-dialog"
              :close-on-click-modal="false"
              @update:model-value="(v: boolean) => { if (!v) cancelEdit() }"
            >
              <div v-if="editing" class="dlg-body">
                <div class="dlg-grid">
                  <div class="form-field">
                    <label>节点名称 <span class="req">*</span> <span class="field-hint">如"规划节点"、"编码节点"</span></label>
                    <input v-model="editing.nodeName" class="input" type="text" placeholder="如：规划节点" />
                  </div>
                  <div class="form-field">
                    <label>作用描述</label>
                    <input v-model="editing.description" class="input" type="text" placeholder="该节点负责什么" />
                  </div>
                  <div class="form-field dlg-full">
                    <label>System Prompt</label>
                    <textarea
                      v-model="editing.systemPrompt"
                      class="input prompt-area"
                      rows="6"
                      placeholder="该节点的角色设定与行为规则..."
                      @input="autoResize($event.target as HTMLTextAreaElement)"
                    ></textarea>
                  </div>
                  <div class="form-field dlg-full">
                    <div class="tools-head">
                      <label>工具 <span class="field-hint">函数体在运行时执行</span></label>
                      <button class="btn-add-tool" @click="toolEditAdd">+ 添加工具</button>
                    </div>
                    <div class="tools-list">
                      <div v-if="editing.toolsArr.length === 0" class="tools-empty">
                        还没有工具，点「+ 添加工具」编写第一个函数
                      </div>
                      <div v-for="(t, ti) in editing.toolsArr" :key="ti" class="tool-row">
                        <span class="tool-tag">{{ t.name || '未命名' }}</span>
                        <span class="tool-desc-text">{{ t.description || '（无描述）' }}</span>
                        <span v-if="t.code" class="tool-exec" title="已配置函数体，运行时执行">可执行</span>
                        <button class="tool-edit-btn" @click="toolEditStart(ti)">编辑</button>
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
              </div>
              <template #footer>
                <button class="btn-cancel" @click="cancelEdit">取消</button>
                <button class="btn-save" @click="saveNodeDraft">保存节点</button>
              </template>
            </el-dialog>

            <!-- 工具编辑器（弹窗） -->
            <el-dialog
              :model-value="!!toolEditing"
              :title="toolEditingIndex >= 0 ? `编辑工具 · ${toolEditing?.name || '未命名'}` : '添加工具'"
              width="560px"
              class="cf-dialog"
              :close-on-click-modal="false"
              @update:model-value="(v: boolean) => { if (!v) toolEditCancel() }"
            >
              <div v-if="toolEditing" class="dlg-body">
                <div class="dlg-grid">
                  <div class="form-field">
                    <label>函数名 <span class="req">*</span> <span class="field-hint">LLM 调用标识</span></label>
                    <input v-model="toolEditing.name" class="input tool-code-input" type="text" placeholder="如：web_search" />
                  </div>
                  <div class="form-field">
                    <label>作用描述 <span class="req">*</span> <span class="field-hint">发给 LLM，说明何时调用</span></label>
                    <input v-model="toolEditing.description" class="input" type="text" placeholder="联网搜索，返回摘要" />
                  </div>
                  <div class="form-field dlg-full">
                    <div class="param-row">
                      <label class="param-label">参数声明 <span class="field-hint">JSON Schema，留空 = 无参数</span></label>
                      <button class="btn-add-tool" title="填入基础参数模板" @click="applyParamTemplate">模板</button>
                    </div>
                    <textarea
                      v-model="toolEditing.parameters"
                      class="input param-area"
                      rows="3"
                      placeholder='{"type":"object","properties":{},"required":[]}'
                      @input="autoResize($event.target as HTMLTextAreaElement)"
                    ></textarea>
                  </div>
                  <div class="form-field dlg-full">
                    <label>函数体 <span class="field-hint">箭头函数，入参为 LLM 提取的参数对象；留空 = 仅声明</span></label>
                    <div class="code-editor-wrap">
                      <MonacoEditor
                        language="javascript"
                        :value="toolEditing.code"
                        @change="(v: string) => { if (toolEditing) toolEditing.code = v }"
                      />
                    </div>
                  </div>
                </div>
              </div>
              <template #footer>
                <button class="btn-cancel" @click="toolEditCancel">取消</button>
                <button class="btn-save" @click="toolEditSave">保存工具</button>
              </template>
            </el-dialog>
          </div>

          <div class="form-actions">
            <button class="btn-cancel" @click="router.back()">取消</button>
            <button class="btn-save" :disabled="saving" @click="save">{{ saving ? '保存中...' : '保存' }}</button>
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
  cursor: pointer;
  transition: border-color 0.2s, background 0.2s;
}
.node-card:hover {
  border-color: var(--blue);
  background: rgba(69, 184, 255, 0.05);
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

/* ===== 节点/工具弹窗 ===== */
.dlg-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.dlg-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px 20px;
}
.dlg-full {
  grid-column: 1 / -1;
}
.param-label {
  flex: 1;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text2);
  margin-bottom: 5px;
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
  padding: 6px 8px;
  border-radius: 8px;
  border: 1px solid transparent;
  transition: border-color 0.2s, background 0.2s;
}
.tool-row.editing {
  border-color: var(--blue);
  background: rgba(69, 184, 255, 0.06);
}
.tools-empty {
  padding: 14px 0;
  text-align: center;
  font-size: 12px;
  color: var(--text3);
}
.tool-desc-text {
  flex: 1;
  font-size: 12.5px;
  color: var(--text2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tool-exec {
  flex: none;
  font-size: 11px;
  color: var(--green, #3fbf7f);
  padding: 1px 7px;
  border-radius: 6px;
  border: 1px solid rgba(63, 191, 127, 0.35);
  background: rgba(63, 191, 127, 0.08);
}
.tool-edit-btn {
  flex: none;
  border: none;
  background: transparent;
  color: var(--blue);
  font-size: 12px;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 6px;
  transition: background 0.2s;
}
.tool-edit-btn:hover {
  background: rgba(69, 184, 255, 0.15);
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

.tool-code-input {
  font-family: 'Consolas', 'JetBrains Mono', monospace;
  font-size: 12.5px;
}
.param-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.param-row .btn-add-tool {
  flex: none;
  align-self: flex-end;
}
.param-area {
  resize: none;
  overflow: hidden;
  font-family: 'Consolas', 'JetBrains Mono', monospace;
  font-size: 12px;
  line-height: 1.5;
}
.code-editor-wrap {
  height: 220px;
  border-radius: 8px;
  border: 1px solid var(--border);
  overflow: hidden;
  background: #1e1e1e;
}
.code-editor-wrap :deep(.monaco-container) {
  min-height: 0;
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

/* ===== 弹窗深色主题（覆盖 Element Plus 默认亮色，匹配项目深色变量） ===== */
:deep(.cf-dialog) {
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 12px;
  color: var(--text);
  overflow: hidden;
}
:deep(.cf-dialog .el-dialog__header) {
  padding: 18px 22px 0;
  margin-right: 0;
}
:deep(.cf-dialog .el-dialog__title) {
  color: var(--text);
  font-size: 15px;
  font-weight: 600;
}
:deep(.cf-dialog .el-dialog__body) {
  padding: 16px 22px;
  color: var(--text);
}
:deep(.cf-dialog .el-dialog__footer) {
  padding: 0 22px 18px;
}
:deep(.cf-dialog .el-dialog__headerbtn) {
  top: 14px;
  right: 14px;
  width: 28px;
  height: 28px;
}
:deep(.cf-dialog .el-dialog__close) {
  color: var(--text3);
  font-size: 16px;
}
:deep(.cf-dialog .el-dialog__headerbtn:hover .el-dialog__close) {
  color: var(--text);
}
:deep(.el-overlay:has(> .cf-dialog)) {
  background: rgba(5, 8, 16, 0.6);
}

@media (max-width: 900px) {
  .form-grid,
  .ed-grid {
    grid-template-columns: 1fr;
  }
}
</style>
