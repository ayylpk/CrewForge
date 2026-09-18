<script setup lang="ts">
/* ============================================================
   项目台账（/projects）
   ------------------------------------------------------------
   世界观：这里 = 图档柜的索引台。统计 = 标题栏条，筛选 = 目录抽屉标签，
   每张卡 = 一张索引卡（右上角状态章 + hover 露图号）。
   API 设置弹窗逻辑逐字保留（sys_settings 读写 + 本地镜像 + 测试连接），
   仅换 UI 底座：ElMessage → toast，modal → AppModal。
   ============================================================ */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  IconBook,
  IconDeviceLaptop,
  IconLogout,
  IconPackage,
  IconPlus,
  IconSchool,
  IconSearch,
  IconShieldLock,
  IconTrash,
  IconUsersGroup,
  IconWritingSign,
} from '@tabler/icons-vue'
import AppModal from '../components/ui/AppModal.vue'
import CreateProjectSheet from '../components/ui/CreateProjectSheet.vue'
import StampSeal from '../components/ui/StampSeal.vue'
import TopBar from '../components/ui/TopBar.vue'
import { fetchProjects, deleteProject } from '../api/project'
import { fetchSettings, saveSettings, testSettings, type RuntimeSettings } from '../api/settings'
import { useAuthStore } from '../api/auth'
import type { Project, ProjectStatus } from '../types/project'
import { projectStatusMeta } from '../constants/status'
import { confirmDialog } from '../utils/confirm'
import { toast } from '../utils/toast'

const router = useRouter()
const auth = useAuthStore()

const loading = ref(true)
const loadError = ref('')
const projects = ref<Project[]>([])

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    // 分页结果取 records 数组
    const { records } = await fetchProjects()
    projects.value = records
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : '项目清单没拿到'
  } finally {
    loading.value = false
  }
}

/* ===== 新建项目（9/18 起改弹窗，不再是独立页面） =====
   原 `/projects/new` 是一整页，但它的四个板块（名称/描述/确认模式/参考文件）
   和「需求对话」页完全重复。创建只是登记一条记录 → 退化成只收名称+描述的弹窗。 */
const showCreate = ref(false)

function onProjectCreated() {
  showCreate.value = false
  load() // 回列表看到新记录（POST /api/project 不回 id，没法直接跳需求对话）
}

/* ===== API 设置（阶段 2 起接服务端 sys_settings；Key 存服务器，引擎直读） ===== */

const showApiSettings = ref(false)
const cfg = ref<RuntimeSettings>({ modelKind: 'deepseek' })
const maskedKey = ref('未配置') // 服务端当前 key 的掩码（引擎有 .env 兜底，空也能跑）
const saving = ref(false)
const testing = ref(false)
/**
 * 9/18：清除已保存 key 的**待提交标记**。
 *   为什么需要单独一条通道：apiKey 的语义是"空 = 保持原值"，所以光清空输入框删不掉已存的 key
 *   （用户实测反馈"填入了就不让修改"）。点「清除已保存的 Key」→ 置此标记 → 保存时带 clearApiKey。
 */
const clearKeyRequested = ref(false)

function requestClearKey() {
  clearKeyRequested.value = true
  cfg.value.apiKey = ''   // 清除优先于"填新值"：两个动作别打架
  toast.info('保存后生效：已保存的 Key 会被清空')
}

/** 顶栏小灯：服务端配了 key 就算已配置 */
const llmConfigured = computed(() => maskedKey.value !== '未配置' && maskedKey.value !== '')

/** 拉一次服务端配置刷新顶栏状态灯 */
async function refreshSettingsDot() {
  try {
    const s = await fetchSettings()
    maskedKey.value = s.apiKey || '未配置'
  } catch {
    /* 后端未启动：灯灰着，不炸列表页 */
  }
}

/** 打开弹窗时才拉全量配置（掩码回显 + 表单初值） */
async function openApiSettings() {
  showApiSettings.value = true
  clearKeyRequested.value = false   // 每次打开都从"不改 key"的干净状态开始
  try {
    const s = await fetchSettings()
    maskedKey.value = s.apiKey || '未配置'
    cfg.value = {
      modelKind: s.modelKind || 'deepseek',
      modelUrl: s.modelUrl || '',
      apiKey: '', // 永不回显明文；留空=保持
      modelName: s.modelName || '',
      modelPro: s.modelPro || '',
      roleModels: s.roleModels || '',
      javaBaseUrl: s.javaBaseUrl || '',
      confirmTimeoutMin: s.confirmTimeoutMin ?? 30,
      smokeBuild: !!s.smokeBuild,
      llmConcurrency: s.llmConcurrency ?? undefined,
      stationSlots: s.stationSlots ?? undefined,
      toolMode: !!s.toolMode,
    }
  } catch {
    /* 拦截器已提示 */
  }
}

async function saveApiSettings() {
  saving.value = true
  try {
    await saveSettings({
      ...cfg.value,
      apiKey: cfg.value.apiKey?.trim() || undefined, // 空=不改（后端掩码语义）
      // 9/18：显式清除通道（空值语义删不掉已存的 key，必须带这个开关）
      ...(clearKeyRequested.value ? { clearApiKey: true } : {}),
    })
    // 9/18 删掉这里原来的 localStorage 镜像（cf_providers / cf_default_model）：
    // 它唯一的读者是已删除的 AgentFormView（经 loadProviders/globalDefaultModel），
    // 再没有第二个人读 —— 留着就是往用户浏览器里写两份没人看、还含 API Key 的副本。
    // 模型配置的真相现在只有一处：服务端 sys_settings（引擎直读，30s 热加载）。
    toast.success('已保存——引擎最多 30 秒热加载生效')
    maskedKey.value = (await fetchSettings().catch(() => ({} as RuntimeSettings))).apiKey || '未配置'
    cfg.value.apiKey = ''
    clearKeyRequested.value = false
    showApiSettings.value = false
  } finally {
    saving.value = false
  }
}

async function runTest() {
  testing.value = true
  try {
    const r = await testSettings({ ...cfg.value, apiKey: cfg.value.apiKey?.trim() || undefined })
    if (r.ok) toast.success(`连通 ${r.latencyMs ?? '?'}ms（HTTP ${r.status}）`)
    else toast.error(`不通：${r.error || '未知错误'}`)
  } finally {
    testing.value = false
  }
}

/* ===== 项目图标：emoji 换成图章线稿图标（同映射规则） ===== */
const ICON_RULES: [RegExp, typeof IconBook][] = [
  [/CRM|客户|crm/i, IconUsersGroup],
  [/选课|学生|教育|课程/i, IconSchool],
  [/进销存|库存|采购|订单|商城/i, IconPackage],
  [/图书|借阅/i, IconBook],
]
function projectIcon(p: Project) {
  return ICON_RULES.find(([re]) => re.test(p.name))?.[1] ?? IconDeviceLaptop
}

/* ===== 筛选（标签带计数 + **状态色点**：目录抽屉的语言）
   9/18 用户要求：分栏旁边要能看出"这个颜色对应哪个状态"。
   色点取 projectStatusMeta(status).tone，与列表行里的状态章**同一份口径**（constants/status.ts），
   所以点是什么色、行里的章就是什么色——不用记两套。
   「全部」不是状态，故意不给点（否则会被误读成某个状态）。 */
const FILTERS: { label: string; value: string; status?: ProjectStatus }[] = [
  { label: '全部', value: 'all' },
  { label: '执行中', value: 'executing', status: 'executing' },
  { label: '规划中', value: 'planning', status: 'planning' }, // 9/18 补：库里 8 个项目卡在这个状态，原先筛不到
  { label: '已完成', value: 'done', status: 'done' },
  { label: '澄清中', value: 'clarifying', status: 'clarifying' },
  { label: '草稿', value: 'draft', status: 'draft' },
]
const activeFilter = ref('all')
const keyword = ref('')

function countOf(f: (typeof FILTERS)[number]) {
  if (!f.status) return projects.value.length
  return projects.value.filter((p) => p.status === f.status).length
}

const filtered = computed(() => {
  return projects.value.filter((p) => {
    const okStatus = activeFilter.value === 'all' || p.status === activeFilter.value
    const okKeyword = !keyword.value || p.name.includes(keyword.value)
    return okStatus && okKeyword
  })
})

/* ===== 标题栏统计（原五张统计卡收进一条 tblock） ===== */
const totalFiles = computed(() => projects.value.reduce((sum, p) => sum + (p.fileCount || 0), 0))
function countBy(status: ProjectStatus) {
  return projects.value.filter((p) => p.status === status).length
}

/** 图号：PRJ-{id补零}-C（台账卡片的编号，hover 浮现） */
function sheetNo(p: Project) {
  return `PRJ-${String(p.id).padStart(4, '0')}-C`
}

onMounted(() => {
  void load()
  void refreshSettingsDot()
})

/** 删除项目：确认 → 调接口 → 从列表移除（失败提示由 request.ts 拦截器统一弹出） */
async function removeProject(p: Project) {
  const ok = await confirmDialog({
    title: '删除项目',
    body: `确定删除「${p.name}」吗？删除后不可恢复`,
    ok: '删除',
    cancel: '取消',
    danger: true,
  })
  if (!ok) return
  try {
    await deleteProject(p.id)
    projects.value = projects.value.filter((x) => x.id !== p.id)
  } catch {
    /* 拦截器已提示 */
  }
}

function createNew() {
  showCreate.value = true
}

/* 9/18 删掉 goAgentRepo() + 顶栏那颗「Agent 仓库」按钮：
   它 push 的 agent-repo 路由已随封存功能一起删除（点了只会命中 no-match）。
   保留一个指向不存在页面的按钮，比没有按钮更糟。 */

/** 点击卡片 → 项目概览页，定位到「功能清单 + 开发计划」区块 */
function goProject(p: Project) {
  router.push({ name: 'project-detail', params: { id: String(p.id) }, hash: '#overview' })
}

function logout() {
  localStorage.removeItem('cf_token')
  router.push('/login')
}

const userInitial = computed(() => (auth.userName || 'K').slice(0, 1).toUpperCase())
</script>

<template>
  <div class="view">
    <TopBar>
      <template #context>
        <span class="tb-title">项目台账</span>
        <span class="sheet-no tb-sheet">LEDGER-A</span>
      </template>
      <template #right>
        <!-- API 设置（读写服务端 sys_settings） -->
        <button
          class="btn btn-sm"
          :title="llmConfigured ? '模型服务已配置（' + maskedKey + '）' : '未配置 API Key（引擎走服务器 .env 兜底）'"
          @click="openApiSettings"
        >
          <IconShieldLock :size="15" :stroke-width="1.75" />
          API 设置
          <span class="lamp" :class="llmConfigured ? 'lamp-on' : ''" aria-hidden="true"></span>
        </button>
        <span class="tb-user">
          <span class="tb-avatar mono">{{ userInitial }}</span>
        </span>
        <button class="btn btn-sm btn-ghost" @click="logout">
          <IconLogout :size="15" :stroke-width="1.75" />
          退出
        </button>
      </template>
    </TopBar>

    <main class="page">
      <!-- ===== 封面标题 + 新建 ===== -->
      <header class="ledger-head">
        <div>
          <h1 class="ledger-h">项目台账</h1>
          <p class="ledger-sub dim">全部出图记录在此挂号 —— 一张卡一个项目，点开进图档。</p>
        </div>
        <button class="btn btn-primary" @click="createNew">
          <IconPlus :size="16" :stroke-width="1.75" />
          新建项目
        </button>
      </header>

      <!-- ===== 统计：一条标题栏条 ===== -->
      <div class="tblock stats">
        <div class="tblock-cell stat">
          <span class="tblock-key">全部项目</span>
          <span class="tblock-val mono">{{ projects.length }}</span>
        </div>
        <div class="tblock-cell stat">
          <span class="tblock-key">执行中</span>
          <span class="tblock-val mono c-cyan">{{ countBy('executing') }}</span>
        </div>
        <div class="tblock-cell stat">
          <span class="tblock-key">已完成</span>
          <span class="tblock-val mono c-pass">{{ countBy('done') }}</span>
        </div>
        <div class="tblock-cell stat">
          <span class="tblock-key">澄清中</span>
          <span class="tblock-val mono c-wait">{{ countBy('clarifying') }}</span>
        </div>
        <div class="tblock-cell stat">
          <span class="tblock-key">代码文件</span>
          <span class="tblock-val mono">{{ totalFiles }}</span>
        </div>
      </div>

      <!-- ===== 筛选标签 + 检索 ===== -->
      <div class="toolbar">
        <nav class="tabs" aria-label="按状态筛选">
          <button
            v-for="f in FILTERS"
            :key="f.value"
            class="tab"
            :class="{ on: activeFilter === f.value }"
            @click="activeFilter = f.value"
          >
            <!-- 状态色点：与行里的状态章同色（同取 constants/status.ts 的 tone） -->
            <span
              v-if="f.status"
              class="tab-dot"
              :class="`stamp-${projectStatusMeta(f.status).tone}`"
              aria-hidden="true"
            ></span>
            {{ f.label }}<span class="tab-n mono">{{ countOf(f) }}</span>
          </button>
        </nav>
        <label class="quest">
          <IconSearch :size="15" :stroke-width="1.75" class="quest-ico" />
          <input v-model="keyword" class="quest-in" type="text" placeholder="检索项目名…" aria-label="检索项目名" />
        </label>
      </div>

      <!-- ===== 加载：排线骨架 ===== -->
      <div v-if="loading" class="card-grid" aria-busy="true">
        <div v-for="i in 6" :key="i" class="card skel">
          <div class="skeleton" style="height: 22px; width: 55%"></div>
          <div class="skeleton" style="height: 13px; width: 85%; margin-top: 14px"></div>
          <div class="skeleton" style="height: 13px; width: 62%; margin-top: 8px"></div>
          <div class="skeleton" style="height: 11px; width: 40%; margin-top: 26px"></div>
        </div>
      </div>

      <!-- ===== 加载失败：修订云批注 ===== -->
      <div v-else-if="loadError" class="err-sheet">
        <div class="revision-cloud err-cloud">
          <b>台账没取到：</b>{{ loadError }}
        </div>
        <p class="dim">确认后端服务在跑，然后重试。</p>
        <button class="btn" @click="load">重新取图</button>
      </div>

      <!-- ===== 索引卡桌 ===== -->
      <div v-else-if="filtered.length" class="card-grid">
        <article
          v-for="p in filtered"
          :key="p.id"
          class="card proj"
          tabindex="0"
          role="button"
          :aria-label="`打开项目 ${p.name}`"
          @click="goProject(p)"
          @keydown.enter="goProject(p)"
        >
          <span class="card-no sheet-no mono">{{ sheetNo(p) }}</span>
          <div class="proj-top">
            <span class="proj-ico">
              <component :is="projectIcon(p)" :size="21" :stroke-width="1.75" />
            </span>
            <h3 class="proj-name">{{ p.name }}</h3>
            <StampSeal :label="projectStatusMeta(p.status).label" :tone="projectStatusMeta(p.status).tone as any" />
          </div>
          <p class="proj-desc dim">{{ p.description || '暂无描述' }}</p>
          <!-- 进度：3px 青细带（有数据才出现） -->
          <div v-if="p.progress != null && p.progress > 0" class="prog" :title="`进度 ${p.progress}%`">
            <div class="prog-fill" :style="{ width: p.progress + '%' }"></div>
          </div>
          <footer class="proj-foot hairline-top">
            <span class="meta mono">
              <template v-if="p.fileCount">{{ p.fileCount }} 个文件 · </template>{{ p.moduleCount || 0 }} 个模块
            </span>
            <button
              class="del"
              title="删除项目"
              aria-label="删除项目"
              @click.stop="removeProject(p)"
            >
              <IconTrash :size="14" :stroke-width="1.75" />
            </button>
          </footer>
        </article>
      </div>

      <!-- ===== 空态：未开画的图纸 ===== -->
      <div v-else class="empty-sheet">
        <img class="empty-img" src="../assets/sheet-empty-draft.png" alt="" />
        <h3>{{ keyword ? '没有找到项目' : '台账还空着' }}</h3>
        <p>{{ keyword ? '换个关键词试试' : '点击「新建项目」创建你的第一个 AI 协作项目' }}</p>
        <button v-if="!keyword" class="btn btn-primary" @click="createNew">
          <IconPlus :size="16" :stroke-width="1.75" />
          新建项目
        </button>
      </div>
    </main>

    <!-- ===== 新建项目弹窗（9/18：取代原 /projects/new 整页） ===== -->
    <CreateProjectSheet v-if="showCreate" @close="showCreate = false" @created="onProjectCreated" />

    <!-- ===== API 设置弹窗（逻辑逐字保留，仅换皮） ===== -->
    <AppModal v-if="showApiSettings" title="API 设置" sheet="SET-01" width="640px" @close="showApiSettings = false">
      <p class="api-tip dim">
        保存进服务器运行时配置，引擎（需求对话 / 架构师 / 开发 / 测试）自动生效，无需重启。
        OpenAI 兼容档可指向 Ollama / vLLM / 任意中转端点。
      </p>

      <div class="provider">
        <div class="provider-head">
          <span class="provider-name">{{ cfg.modelKind === 'openai' ? 'OpenAI 兼容端点' : 'DeepSeek' }}</span>
          <span v-if="maskedKey && maskedKey !== '未配置'" class="provider-key-state">
            <StampSeal label="Key 已配置" tone="pass" />
            <i class="mono">{{ maskedKey }}</i>
          </span>
          <span v-else class="provider-key-state">
            <StampSeal label="未配置 · 引擎走 .env" tone="pencil" />
          </span>
        </div>

        <label class="prow">
          <span class="prow-k">服务商</span>
          <select v-model="cfg.modelKind" class="select">
            <option value="deepseek">DeepSeek（官方协议，支持 thinking）</option>
            <option value="openai">OpenAI 兼容（Ollama / vLLM / 中转）</option>
          </select>
        </label>
        <label class="prow">
          <span class="prow-k">Base URL</span>
          <input v-model="cfg.modelUrl" class="input" type="text"
                 :placeholder="cfg.modelKind === 'openai' ? '必填，如 http://localhost:11434/v1' : '留空 = https://api.deepseek.com/v1'" />
        </label>
        <label class="prow">
          <span class="prow-k">API Key</span>
          <input v-model="cfg.apiKey" class="input" type="password"
                 placeholder="粘贴新的 sk-... 覆盖；留空不动" />
        </label>
        <!-- 9/18：把"当前值"从 placeholder 里拿出来单独显示 + 给一条清除通道。
             原先把 "留空 = 保持不变（****94d40）" 塞在 placeholder 里，看起来像输入框已经有值、
             又没法删（实测反馈"填入了就不让修改"）。 -->
        <div class="prow prow-current">
          <span class="prow-k">当前</span>
          <span class="prow-cur">
            <span class="mono" :class="{ faint: !llmConfigured }">{{ maskedKey }}</span>
            <button
              v-if="llmConfigured"
              type="button"
              class="btn btn-sm btn-ghost"
              :disabled="clearKeyRequested"
              @click="requestClearKey()"
            >
              {{ clearKeyRequested ? '保存后清空' : '清除已保存的 Key' }}
            </button>
          </span>
        </div>
        <!-- 模型名纯手动填写：不预设不校验，填什么原样透传给端点，对错由端点反馈 -->
        <label class="prow">
          <span class="prow-k">模型名</span>
          <input v-model="cfg.modelName" class="input" type="text" placeholder="自填，以端点支持的名称为准" />
        </label>
        <!-- T3 模型分层双档：pro 档模型名 + 角色档位（留空=不启用分层，全员走上面全局模型名） -->
        <label class="prow">
          <span class="prow-k">Pro 档模型</span>
          <input v-model="cfg.modelPro" class="input" type="text" placeholder="留空=不分层；填了则 pro 角色用它（自填）" />
        </label>
        <label class="prow">
          <span class="prow-k">角色档位</span>
          <input v-model="cfg.roleModels" class="input" type="text"
                 placeholder='JSON，如 {"test":"pro","frontend":"pro","backend":"flash"}；留空=内置表(架构师/测试/前端 pro)' />
        </label>
        <label class="prow">
          <span class="prow-k">回调基址</span>
          <input v-model="cfg.javaBaseUrl" class="input" type="text" placeholder="引擎回调 Java：http://localhost:8080" />
        </label>
        <label class="prow">
          <span class="prow-k">确认门超时</span>
          <input v-model.number="cfg.confirmTimeoutMin" class="input" type="number" min="1" max="720" placeholder="30" />
        </label>
        <div class="prow">
          <span class="prow-k">冒烟加 build</span>
          <label class="check">
            <input v-model="cfg.smokeBuild" type="checkbox" />
            <span class="dim">阶段 4 启用；默认关保演示稳定</span>
          </label>
        </div>
        <!-- T7a 并发令牌闸：队列无上限，token 限在制（30s 热调，看日志尾延迟拧阀门） -->
        <label class="prow">
          <span class="prow-k">LLM 总闸</span>
          <input v-model.number="cfg.llmConcurrency" class="input" type="number" min="1" max="16" placeholder="6" />
          <span class="prow-note dim">全局同时在飞调用上限（并发过高尾延迟暴涨，9/3 实测）</span>
        </label>
        <label class="prow">
          <span class="prow-k">阶段令牌</span>
          <input v-model.number="cfg.stationSlots" class="input" type="number" min="1" max="12" placeholder="5" />
          <span class="prow-note dim">前后端每阶段同时在制任务数（落盘/失败才归还）</span>
        </label>
        <div class="prow">
          <span class="prow-k">工位工具模式</span>
          <label class="check">
            <input v-model="cfg.toolMode" type="checkbox" />
            <span class="dim">T7b：前后端开发改用 read/write/edit 工具交付（默认关=单发老路；端点工具兼容性 live 验证后再开）</span>
          </label>
        </div>
      </div>

      <template #footer>
        <button class="btn btn-sm" @click="showApiSettings = false">取消</button>
        <button class="btn btn-sm" :disabled="testing" @click="runTest">
          <IconWritingSign v-if="!testing" :size="14" :stroke-width="1.75" />
          {{ testing ? '测试中…' : '测试连接' }}
        </button>
        <button class="btn btn-sm btn-primary" :disabled="saving" @click="saveApiSettings">
          {{ saving ? '保存中…' : '保存' }}
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

/* ===== 顶栏文字 ===== */
.tb-title {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

/* ===== 封面标题 ===== */
.ledger-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 18px;
}
.ledger-h {
  font-size: var(--fs-sheet);
  font-weight: 700;
  line-height: 1.08;
  letter-spacing: 0.005em;
}
.ledger-sub {
  margin-top: 6px;
  font-size: var(--fs-body);
}

/* ===== 统计条 ===== */
.stats {
  margin-bottom: 22px;
}
.stat {
  flex: 1;
}
.stat .tblock-val {
  font-family: var(--font-display);
  font-size: 26px;
  font-weight: 600;
  line-height: 1.15;
}
.c-cyan { color: var(--cyan); }
.c-pass { color: var(--pass-ink); }
.c-wait { color: var(--wait-ink); }

/* ===== 筛选 + 检索 ===== */
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  flex-wrap: wrap;
  margin-bottom: 20px;
}
.tabs {
  display: flex;
  gap: 4px;
  border: 1px solid var(--line-2);
  border-radius: var(--r);
  padding: 3px;
  background: var(--paper-raised);
}
.tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border-radius: var(--r-xs);
  font-size: var(--fs-meta);
  font-weight: 500;
  color: var(--ink-2);
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}
.tab:hover {
  background: var(--cyan-wash);
  color: var(--cyan);
}
.tab.on {
  background: var(--cyan); /* 归档标签压青：当前抽屉 */
  color: #f3f6f8;
}
.tab-n {
  font-size: 11px;
  opacity: 0.75;
}
/* 状态色点：颜色由 .stamp-{tone} 给（与行里的状态章同一份 token），这里只做形状。
   选中态 .tab.on 是青底白字，色点会跟着变成白色 —— 加一圈浅描边保证还看得见。 */
.tab-dot {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
  background: currentColor;
}
.tab.on .tab-dot {
  box-shadow: 0 0 0 1.5px rgba(243, 246, 248, 0.55);
}
.quest {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  max-width: 300px;
  min-width: 180px;
  height: 38px;
  padding: 0 12px;
  background: var(--paper-raised);
  border: 1px solid var(--line-2);
  border-radius: var(--r);
}
.quest:focus-within {
  border-color: var(--cyan);
  box-shadow: 0 0 0 3px var(--cyan-wash);
}
.quest-ico {
  color: var(--ink-3);
  flex: none;
}
.quest-in {
  flex: 1;
  border: none;
  background: transparent;
  outline: none;
  font-size: var(--fs-body);
  min-width: 0;
}

/* ===== 卡桌 ===== */
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 14px;
}
.card {
  background: var(--paper-raised);
  border: 1px solid var(--line);
  border-radius: var(--r);
  padding: 16px 18px 12px;
  position: relative;
}
.proj {
  display: flex;
  flex-direction: column;
  min-height: 178px;
  cursor: pointer;
  transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}
.proj:hover,
.proj:focus-visible {
  border-color: var(--cyan);
  box-shadow: 0 2px 0 var(--cyan); /* 压卡：青线，不是浮起阴影 */
}
/* 图号：默认收着，hover 这张卡才算"被抽出" */
.card-no {
  position: absolute;
  top: 8px;
  right: 12px;
  font-size: 10px;
  opacity: 0;
  transition: opacity var(--dur) var(--ease);
}
.proj:hover .card-no,
.proj:focus-visible .card-no {
  opacity: 1;
}
.proj:hover .del,
.proj:focus-within .del {
  opacity: 1;
}
.proj-top {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-right: 70px; /* 给章留位 */
}
.proj-ico {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border: 1px solid var(--line-2);
  border-radius: var(--r-xs);
  color: var(--cyan);
  background: var(--paper);
}
.proj-name {
  font-size: 16px;
  font-weight: 700;
  line-height: 1.3;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
}
.proj .stamp {
  position: absolute;
  top: 14px;
  right: 14px;
}
.proj-desc {
  margin-top: 10px;
  flex: 1;
  font-size: 13px;
  line-height: 1.65;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.prog {
  height: 3px;
  border-radius: 2px;
  background: var(--paper-deep);
  overflow: hidden;
  margin: 4px 0 8px;
}
.prog-fill {
  height: 100%;
  background: var(--cyan);
}
.proj-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 10px;
  padding-top: 8px;
}
.meta {
  font-size: 11px;
  color: var(--ink-3);
}
.del {
  display: inline-flex;
  padding: 4px;
  color: var(--ink-3);
  border-radius: var(--r-xs);
  opacity: 0;
  transition: opacity var(--dur) var(--ease);
}
.del:hover {
  color: var(--void-ink);
  background: var(--void-wash);
}

/* ===== 骨架 ===== */
.skel {
  min-height: 178px;
}

/* ===== 错误 ===== */
.err-sheet {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 60px 20px;
  text-align: center;
}
.err-cloud {
  font-size: var(--fs-body);
}
.err-cloud b {
  color: var(--void-ink);
}

/* ===== 空态 ===== */
.empty-sheet {
  margin-top: 10px;
}
.empty-img {
  width: 220px;
  border: 1px solid var(--line);
  border-radius: var(--r-xs);
  margin-bottom: 6px;
}
.empty-sheet p {
  font-size: 13px;
}
.empty-sheet .btn {
  margin-top: 8px;
}

/* ===== API 设置弹窗内容 ===== */
.api-tip {
  font-size: 13px;
  line-height: 1.7;
  margin-bottom: 14px;
}
.provider {
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--paper);
  padding: 4px 14px 14px;
}
.provider-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  padding: 12px 0 10px;
  border-bottom: 1px dashed var(--line-2);
  margin-bottom: 6px;
}
.provider-name {
  font-weight: 700;
}
.provider-key-state {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: var(--fs-meta);
  color: var(--ink-2);
}
.provider-key-state i {
  font-style: normal;
}
.prow {
  display: grid;
  grid-template-columns: 104px 1fr;
  align-items: center;
  gap: 4px 12px;
  padding: 7px 0;
  border-bottom: 1px solid var(--line);
}
.prow:last-child {
  border-bottom: none;
}
.prow-k {
  font-size: var(--fs-meta);
  font-weight: 600;
  color: var(--ink-2);
}
.prow .input,
.prow .select {
  background: var(--paper-raised);
  padding: 7px 10px;
  font-size: 13px;
}
.prow-note {
  grid-column: 2;
  font-size: 11px;
}
/* 9/18：API Key 的"当前值 + 清除"行（值从 placeholder 里拿出来单独显示，并给一条清除通道） */
.prow-current {
  align-items: start;
}
.prow-cur {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  min-width: 0;
  font-size: 13px;
}
.prow-cur .btn {
  padding: 2px 8px;
  font-size: 12px;
}
.check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  flex-wrap: wrap;
}
.check input[type='checkbox'] {
  width: 16px;
  height: 16px;
  accent-color: var(--cyan);
}

@media (max-width: 760px) {
  /* 窄屏顶栏让位：图号先撤，标题留全 */
  .tb-sheet {
    display: none;
  }
  .ledger-h {
    font-size: 34px;
  }
  .stat .tblock-val {
    font-size: 20px;
  }
  .stats {
    flex-wrap: wrap;
  }
  .stat {
    min-width: 33%;
  }
  .prow {
    grid-template-columns: 1fr;
  }
  .prow-note {
    grid-column: 1;
  }
}
</style>
