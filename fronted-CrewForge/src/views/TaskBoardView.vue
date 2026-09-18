<script setup lang="ts">
/* ============================================================
   工单板（/projects/:id/tasks）= 车间派工台
   ------------------------------------------------------------
   为什么单开一页：执行面板右下角那块看板是挤在侧栏里的小卡，而且**只能看不能动**。
   本页把 sys_task 提升成一等工作台：四列全宽、按阶段分组、单任务详情（result/errorMsg 全文）、
   重跑 / 手动改状态 / 手动补任务。

   它顺便激活了后端**已经写好却零调用**的三个端点（9/17 审计结论）：
     GET  /api/task/{id}          → 单任务详情
     PUT  /api/task/{id}/status   → 手动改状态
     POST /api/task               → 手动建任务
   归后端已有的 JWT + ProjectGuard 保护，本页不需要任何后端改动。
   ============================================================ */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { IconPlus, IconRefresh, IconRotate, IconX } from '@tabler/icons-vue'
import TopBar from '../components/ui/TopBar.vue'
import AppModal from '../components/ui/AppModal.vue'
import StampSeal from '../components/ui/StampSeal.vue'
import { fetchProjectById } from '../api/project'
import {
  createTask,
  fetchTaskById,
  fetchTasks,
  retryTask,
  summarizeTaskQuality,
  updateTaskStatus,
  type TaskItem,
  type TaskStatus,
} from '../api/task'
import { TASK_STATUS, PROJECT_STATUS, type StampTone } from '../constants/status'
import { usePolling } from '../composables/usePolling'
import { toast } from '../utils/toast'

const router = useRouter()
const route = useRoute()

/** 路由 id → 有效数字；拿不到就 null（贯穿全页的守卫，别让 NaN 进 URL） */
const projectId = computed(() => {
  const n = Number(route.params.id)
  return Number.isFinite(n) && n > 0 ? n : null
})

const projectName = ref('')
const projectStatus = ref('')
const tasks = ref<TaskItem[]>([])
const loading = ref(false)
const busyId = ref<number | null>(null)

/** 看板四列（与 constants/status 同一份口径） */
const COLUMNS: TaskStatus[] = ['todo', 'doing', 'done', 'failed']

const byStatus = computed(() => {
  const m: Record<string, TaskItem[]> = { todo: [], doing: [], done: [], failed: [] }
  for (const t of tasks.value) (m[t.status] ??= []).push(t)
  return m
})

/** 质量摘要（复用 api/task.ts 里已有的纯函数，不重写一份统计口径） */
const quality = computed(() => summarizeTaskQuality(tasks.value))

const projectTone = computed<StampTone>(() => PROJECT_STATUS[projectStatus.value]?.tone || 'pencil')
const projectLabel = computed(() => PROJECT_STATUS[projectStatus.value]?.label || projectStatus.value || '—')

async function loadTasks() {
  const id = projectId.value
  if (id == null) return
  try {
    tasks.value = await fetchTasks(id)
  } catch {
    /* 轮询静默：拦截器已提示，保留已有数据 */
  }
}

async function load() {
  const id = projectId.value
  if (id == null) return
  loading.value = true
  try {
    const p = await fetchProjectById(id)
    projectName.value = p.name
    projectStatus.value = p.status
  } catch {
    projectName.value = '项目 #' + route.params.id
  } finally {
    loading.value = false
  }
  await loadTasks()
}

onMounted(async () => {
  await load()
  startPolling()
})

/** 10s 轮询任务（与执行面板同密度，别改） */
const { start: startPolling } = usePolling(() => {
  void loadTasks()
}, 10_000)

function taskTone(s: string): StampTone {
  return TASK_STATUS[s]?.tone || 'pencil'
}
function taskLabel(s: string): string {
  return TASK_STATUS[s]?.label || s
}

/* ===== 任务详情 ===== */
const detail = ref<TaskItem | null>(null)
const detailLoading = ref(false)

async function openDetail(t: TaskItem) {
  detailLoading.value = true
  // 先用列表里那份把弹窗撑开（立即有反馈），再拉全文覆盖（列表可能不含 result 全文）
  detail.value = t
  try {
    const id = projectId.value
    if (id == null) return
    detail.value = await fetchTaskById(t.id)
  } catch {
    /* 拉不到就显示列表那份 */
  } finally {
    detailLoading.value = false
  }
}

/* ===== 重跑 ===== */
async function doRetry(t: TaskItem) {
  busyId.value = t.id
  try {
    await retryTask(t.id)
    toast.success(`「${t.title}」已重新排队（第 ${(t.retryCount ?? 0) + 1} 次）`)
    if (detail.value?.id === t.id) detail.value = { ...detail.value, status: 'todo', retryCount: (t.retryCount ?? 0) + 1 }
    await loadTasks()
  } finally {
    busyId.value = null
  }
}

/* ===== 手动改状态（激活 PUT /api/task/{id}/status） ===== */
async function changeStatus(t: TaskItem, next: TaskStatus) {
  if (next === t.status) return
  busyId.value = t.id
  try {
    await updateTaskStatus(t.id, next)
    toast.success(`「${t.title}」→ ${taskLabel(next)}`)
    if (detail.value?.id === t.id) detail.value = { ...detail.value, status: next }
    await loadTasks()
  } catch {
    /* 拦截器已提示 */
  } finally {
    busyId.value = null
  }
}

/* ===== 手动建任务（激活 POST /api/task） ===== */
const showCreate = ref(false)
const creating = ref(false)
const draft = ref({ title: '', phaseId: '', layer: 'backend', assignee: '', description: '', acceptance: '' })

function openCreate() {
  draft.value = { title: '', phaseId: '', layer: 'backend', assignee: '', description: '', acceptance: '' }
  showCreate.value = true
}

async function submitCreate() {
  const id = projectId.value
  const title = draft.value.title.trim()
  if (id == null) return
  if (!title) {
    toast.warning('请填写任务标题')
    return
  }
  creating.value = true
  try {
    await createTask({
      projectId: id,
      title,
      phaseId: draft.value.phaseId ? Number(draft.value.phaseId) : undefined,
      layer: draft.value.layer || undefined,
      assignee: draft.value.assignee.trim() || undefined,
      description: draft.value.description.trim() || undefined,
      acceptance: draft.value.acceptance.trim() || undefined,
    })
    toast.success('任务已创建（调度器会按需派发）')
    showCreate.value = false
    await loadTasks()
  } finally {
    creating.value = false
  }
}

/* 9/17：这里原本写了个 setMode()（改确认模式），但本页没有模式选择器 —— 那是执行面板的
   事（ExecutionView 顶栏）。写了不接线的函数就是死代码，故删。 */

const id4 = computed(() => String(route.params.id).padStart(4, '0'))
</script>

<template>
  <div class="view">
    <TopBar>
      <template #context>
        <button class="tb-back btn btn-sm btn-ghost" @click="router.push(`/projects/${route.params.id}`)">← 返回</button>
        <span class="tb-title">
          <span class="dim">{{ projectName || '项目 #' + route.params.id }} ·</span>
          <span>工单板</span>
        </span>
        <StampSeal :label="projectLabel" :tone="projectTone" />
      </template>
      <template #right>
        <span class="sheet-no">PRJ-{{ id4 }}-T</span>
        <button class="btn btn-sm" :disabled="loading" @click="load">
          <IconRefresh :size="14" :stroke-width="1.75" />
          {{ loading ? '读取中…' : '刷新' }}
        </button>
        <button class="btn btn-primary btn-sm" @click="openCreate">
          <IconPlus :size="14" :stroke-width="1.75" />
          补一条任务
        </button>
      </template>
    </TopBar>

    <main class="page">
      <!-- ===== 质量条（口径同执行面板，复用 summarizeTaskQuality） ===== -->
      <div class="tblock">
        <div class="tblock-cell">
          <span class="tblock-key">任务总数</span>
          <span class="tblock-val mono">{{ tasks.length }}</span>
        </div>
        <div class="tblock-cell">
          <span class="tblock-key">首次通过</span>
          <span class="tblock-val mono">{{ quality.firstPassRate }}%</span>
        </div>
        <div class="tblock-cell">
          <span class="tblock-key">累计重试</span>
          <span class="tblock-val mono">{{ quality.totalRetries }}</span>
        </div>
        <div class="tblock-cell">
          <span class="tblock-key">失败分类</span>
          <span class="tblock-val">
            <template v-if="quality.failureCategories.length">
              <span v-for="c in quality.failureCategories" :key="c.label" class="chip">
                {{ c.label }} {{ c.count }}
              </span>
            </template>
            <span v-else class="faint">—</span>
          </span>
        </div>
      </div>

      <p class="hint faint">
        看板唯一数据源 = <b class="mono">sys_task</b>，10s 轮询；这里的改动会落库，引擎在阶段边界消费。
      </p>

      <!-- ===== 四列看板 ===== -->
      <div class="board">
        <section v-for="col in COLUMNS" :key="col" class="panel col">
          <header class="panel-head col-head">
            <h3 class="panel-title">{{ taskLabel(col) }}</h3>
            <span class="faint mono">{{ byStatus[col].length }}</span>
          </header>
          <ul v-if="byStatus[col].length" class="rows cards">
            <li v-for="t in byStatus[col]" :key="t.id" class="row tcard">
              <button class="tcard-main" @click="openDetail(t)">
                <span class="tc-ext mono faint">{{ t.taskIdExt || t.id }}</span>
                <span class="tc-title">{{ t.title }}</span>
                <span class="tc-meta faint">
                  <template v-if="t.phaseId">阶段 {{ t.phaseId }} · </template>
                  {{ t.layer === 'frontend' ? '前端' : t.layer === 'backend' ? '后端' : '—' }}
                  <template v-if="t.assignee"> · {{ t.assignee }}</template>
                  <template v-if="t.retryCount > 0"> · 重试 {{ t.retryCount }}</template>
                </span>
                <span v-if="t.status === 'failed' && t.errorMsg" class="tc-err">
                  {{ t.errorMsg.split('\n')[0].slice(0, 70) }}
                </span>
              </button>
              <div class="tc-ops">
                <button
                  class="btn btn-sm btn-ghost"
                  :disabled="busyId === t.id"
                  title="重新排队（引擎于阶段边界重新派发）"
                  @click="doRetry(t)"
                >
                  <IconRotate :size="13" :stroke-width="1.75" />
                  重跑
                </button>
                <select
                  class="sel mono"
                  :value="t.status"
                  :disabled="busyId === t.id"
                  aria-label="手动改状态"
                  @change="changeStatus(t, ($event.target as HTMLSelectElement).value as TaskStatus)"
                >
                  <option v-for="s in COLUMNS" :key="s" :value="s">{{ taskLabel(s) }}</option>
                </select>
              </div>
            </li>
          </ul>
          <p v-else class="col-empty faint">空</p>
        </section>
      </div>
    </main>

    <!-- ===== 任务详情 ===== -->
    <AppModal
      v-if="detail"
      :title="detail.title"
      :sheet="detail.taskIdExt || 'TASK'"
      width="720px"
      @close="detail = null"
    >
      <div class="detail-grid tblock">
        <div class="tblock-cell">
          <span class="tblock-key">状态</span>
          <span class="tblock-val">
            <StampSeal :label="taskLabel(detail.status)" :tone="taskTone(detail.status)" />
          </span>
        </div>
        <div class="tblock-cell">
          <span class="tblock-key">阶段</span>
          <span class="tblock-val mono">{{ detail.phaseId ?? '—' }}</span>
        </div>
        <div class="tblock-cell">
          <span class="tblock-key">分层</span>
          <span class="tblock-val">{{ detail.layer === 'frontend' ? '前端' : detail.layer === 'backend' ? '后端' : '—' }}</span>
        </div>
        <div class="tblock-cell">
          <span class="tblock-key">负责人</span>
          <span class="tblock-val">{{ detail.assignee || '—' }}</span>
        </div>
        <div class="tblock-cell">
          <span class="tblock-key">重试</span>
          <span class="tblock-val mono">{{ detail.retryCount }}</span>
        </div>
        <div v-if="detail.dependsOn" class="tblock-cell">
          <span class="tblock-key">依赖</span>
          <span class="tblock-val mono">{{ detail.dependsOn }}</span>
        </div>
      </div>

      <p v-if="detailLoading" class="faint">正在读全文…</p>

      <section v-if="detail.description" class="dsec">
        <h4 class="ds-label">描述</h4>
        <pre class="doc mono">{{ detail.description }}</pre>
      </section>
      <section v-if="detail.acceptance" class="dsec">
        <h4 class="ds-label">验收标准</h4>
        <pre class="doc mono">{{ detail.acceptance }}</pre>
      </section>
      <section v-if="detail.errorMsg" class="dsec">
        <h4 class="ds-label err">失败原因</h4>
        <pre class="doc mono err">{{ detail.errorMsg }}</pre>
      </section>
      <section v-if="detail.result" class="dsec">
        <h4 class="ds-label">产出结果</h4>
        <pre class="doc mono">{{ detail.result }}</pre>
      </section>
      <p v-if="!detail.description && !detail.acceptance && !detail.errorMsg && !detail.result" class="faint">
        这条任务没有更多正文。
      </p>

      <template #footer>
        <button class="btn btn-sm" @click="detail = null">关闭</button>
        <button class="btn btn-sm" :disabled="busyId === detail.id" @click="doRetry(detail)">
          <IconRotate :size="13" :stroke-width="1.75" />
          重新排队
        </button>
      </template>
    </AppModal>

    <!-- ===== 手动建任务 ===== -->
    <AppModal v-if="showCreate" title="补一条任务" sheet="TASK-NEW" width="560px" @close="showCreate = false">
      <div class="form">
        <label class="field">
          <span class="lbl">标题 <b class="req">*</b></span>
          <input v-model="draft.title" class="input" type="text" placeholder="如：报表导出接口" />
        </label>
        <div class="two">
          <label class="field">
            <span class="lbl">阶段 ID</span>
            <input v-model="draft.phaseId" class="input mono" type="number" min="1" placeholder="留空=不属于任何阶段" />
          </label>
          <label class="field">
            <span class="lbl">分层</span>
            <select v-model="draft.layer" class="input">
              <option value="backend">后端</option>
              <option value="frontend">前端</option>
            </select>
          </label>
        </div>
        <label class="field">
          <span class="lbl">负责人</span>
          <input v-model="draft.assignee" class="input" type="text" placeholder="如：developer（留空=不指派）" />
        </label>
        <label class="field">
          <span class="lbl">描述</span>
          <textarea v-model="draft.description" class="input textarea" rows="3" placeholder="这条任务要做什么" />
        </label>
        <label class="field">
          <span class="lbl">验收标准</span>
          <textarea v-model="draft.acceptance" class="input textarea" rows="3" placeholder="可机械判定的说法，如：GET /api/x 返回 200 且 data 是数组" />
        </label>
        <p class="faint tip">
          状态与计数由服务端兜底（新建一律 <b class="mono">todo</b>、retry_count 归零）。手建的任务不会被自动派发给引擎，
          需要引擎消费时，请把它摆在对应阶段下或让人工处理。
        </p>
      </div>

      <template #footer>
        <button class="btn btn-sm" @click="showCreate = false">
          <IconX :size="13" :stroke-width="1.75" />
          取消
        </button>
        <button class="btn btn-sm btn-primary" :disabled="creating" @click="submitCreate">
          {{ creating ? '创建中…' : '创建任务' }}
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
.tb-back,
.tb-title {
  flex: none;
}
.tb-title {
  font-weight: 600;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tblock {
  margin-bottom: 6px;
}
.hint {
  margin: 0 0 14px;
  font-size: var(--fs-meta);
}
.chip {
  display: inline-block;
  font-size: 11px;
  padding: 1px 7px;
  margin-right: 4px;
  border: 1px solid var(--line);
  border-radius: var(--r-xs);
  background: var(--paper-deep);
  color: var(--ink-2);
}

/* ===== 四列看板 ===== */
.board {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  align-items: start;
}
/* 窄屏折成两列、再窄折一列（图纸世界不横滚） */
@media (max-width: 1080px) {
  .board {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 620px) {
  .board {
    grid-template-columns: minmax(0, 1fr);
  }
}
.col {
  min-width: 0;
}
.col-head {
  padding: 10px 14px;
}
.col-empty {
  padding: 18px 14px;
  font-size: 12px;
}
.cards {
  padding: 0 10px 10px;
}
.tcard {
  display: block;
  padding: 10px 4px;
}
.tcard-main {
  display: block;
  width: 100%;
  text-align: left;
  padding: 0;
}
.tc-ext {
  font-size: 11px;
  margin-right: 6px;
}
.tc-title {
  display: block;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.5;
  margin-bottom: 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.tc-meta {
  display: block;
  font-size: 11px;
}
.tc-err {
  display: block;
  margin-top: 5px;
  font-size: 11px;
  color: var(--void-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tc-ops {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
}
.sel {
  height: 30px;
  font-size: 11px;
  padding: 0 6px;
  border: 1px solid var(--line-2);
  border-radius: var(--r);
  background: var(--paper-raised);
  color: var(--ink);
}

/* 详情弹窗 */
.detail-grid {
  margin-bottom: 14px;
}
.dsec {
  margin-bottom: 14px;
}
.ds-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--ink-2);
  margin-bottom: 6px;
}
.ds-label.err {
  color: var(--void-ink);
}
.doc {
  margin: 0;
  padding: 10px 12px;
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  border: 1px solid var(--line);
  border-radius: var(--r-xs);
  background: var(--paper);
  max-height: 300px;
  overflow: auto;
}
.doc.err {
  border-color: var(--void);
  background: var(--void-wash);
  color: var(--void-ink);
}

/* 建任务表单 */
.form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
.lbl {
  font-size: 12px;
  color: var(--ink-2);
}
.req {
  color: var(--void-ink);
}
.tip {
  font-size: 12px;
  line-height: 1.7;
}
</style>
