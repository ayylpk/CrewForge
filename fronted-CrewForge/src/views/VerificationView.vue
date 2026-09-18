<script setup lang="ts">
/* ============================================================
   验收与证据（/projects/:id/verification）= 出图后的质检台
   ------------------------------------------------------------
   为什么单开一页：PRODUCT.md 要求外人第一眼能看懂
   「需求 → 架构 → 团队执行 → **产出**」四段链路，而前三段都有入口，
   第四段此前没有 —— 项目落了 done/failed/blocked，人却看不到"凭什么"。
   本页把引擎落在产物树里的交付关证据端出来：
     判定结论（本项目口径：判定只来自命令与退出码）
     → 缺什么（notes）
     → 交付关实测报告（_verify/run-report.md，证据链）
     → 验收判据清单（acceptance-p*.json，逐条可执行）
     → 任务级证据（sys_task 的 result/errorMsg）
     → 引擎真实 stdout（logs/p{id}.run.log）
   只读页：不发任何写请求。
   ============================================================ */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { IconAlertTriangle, IconFileText, IconRefresh, IconShieldCheck } from '@tabler/icons-vue'
import TopBar from '../components/ui/TopBar.vue'
import StampSeal from '../components/ui/StampSeal.vue'
import { fetchProjectById } from '../api/project'
import { fetchVerifyEvidence, type VerifyEvidence } from '../api/verify'
import { TASK_STATUS, type StampTone } from '../constants/status'

const router = useRouter()
const route = useRoute()

const projectId = computed(() => {
  const n = Number(route.params.id)
  return Number.isFinite(n) && n > 0 ? n : null
})
const projectName = ref('')
const ev = ref<VerifyEvidence | null>(null)
const loading = ref(false)
const loadError = ref('')

async function load() {
  const id = projectId.value
  if (id == null) {
    loadError.value = '地址里没有有效的项目号'
    return
  }
  loading.value = true
  loadError.value = ''
  try {
    ev.value = await fetchVerifyEvidence(id)
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : '证据没拿到'
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  void load()
  const id = projectId.value
  if (id == null) return
  try {
    projectName.value = (await fetchProjectById(id)).name
  } catch {
    projectName.value = '项目 #' + id
  }
})

/* ===== 判定结论：① 交付关报告在不在 ② 进程退出码 ③ 续拉次数 =====
   口径刻意保守：**没读到报告 ≠ 通过**（与引擎"未验证 ≠ 通过"同源） */
const verdict = computed<{ label: string; tone: StampTone; why: string }>(() => {
  const e = ev.value
  if (!e) return { label: '读取中', tone: 'pencil', why: '' }
  if (e.runReport) {
    return { label: '有实测报告', tone: 'pass', why: '交付关跑了执行式验证并出了报告（逐条证据见下方）' }
  }
  if (e.acceptance.cases.length) {
    return { label: '未验证', tone: 'wait', why: '有验收判据但没出实测报告 —— 按口径未验证 ≠ 通过' }
  }
  return { label: '无证据', tone: 'void', why: '产物树里既没有验收判据也没有实测报告' }
})

const exitCodeText = computed(() => {
  const c = ev.value?.run?.exitCode
  return c === null || c === undefined ? '—' : String(c)
})

/** 任务证据里失败的那几条（先看它们，是排障入口） */
const failedEvidence = computed(() => (ev.value?.taskEvidence ?? []).filter((t) => t.status === 'failed'))
const doneCount = computed(() => (ev.value?.taskEvidence ?? []).filter((t) => t.status === 'done').length)

function taskTone(status: string): StampTone {
  return TASK_STATUS[status]?.tone || 'pencil'
}
function taskLabel(status: string): string {
  return TASK_STATUS[status]?.label || status
}

/** 一条验收判据 → 单行人话（三种 kind 各自的读法） */
function caseLine(c: { kind: string | null; method?: string | null; path?: string | null; expectStatus?: number | null; command?: string | null; expectExitCode?: number | null; testPath?: string | null }): string {
  if (c.kind === 'http') return `${c.method || 'GET'} ${c.path || '?'} → 期望 ${c.expectStatus ?? '?'}`
  if (c.kind === 'command') return `${c.command || '?'} → 期望退出码 ${c.expectExitCode ?? 0}`
  if (c.kind === 'testFile') return `跑测试文件 ${c.testPath || '?'}`
  return '（未知判据类型）'
}

const id4 = computed(() => String(route.params.id).padStart(4, '0'))

/** completion.json 的失败详情（有无都渲染得出来） */
const completionReasons = computed(() => ev.value?.completion?.reasons ?? [])
const completionBreakdown = computed(() => ev.value?.completion?.taskBreakdown ?? null)
</script>

<template>
  <div class="view">
    <TopBar>
      <template #context>
        <button class="tb-back btn btn-sm btn-ghost" @click="router.push(`/projects/${route.params.id}`)">← 返回</button>
        <span class="tb-title">
          <span class="dim">{{ projectName || '项目 #' + route.params.id }} ·</span>
          <span>验收与证据</span>
        </span>
        <StampSeal :label="verdict.label" :tone="verdict.tone" />
      </template>
      <template #right>
        <span class="sheet-no">PRJ-{{ id4 }}-V</span>
        <button class="btn btn-sm" :disabled="loading" @click="load">
          <IconRefresh :size="14" :stroke-width="1.75" />
          {{ loading ? '读取中…' : '刷新' }}
        </button>
      </template>
    </TopBar>

    <main class="page">
      <!-- ===== 结论条 ===== -->
      <div class="tblock">
        <div class="tblock-cell">
          <span class="tblock-key">交付关</span>
          <span class="tblock-val">{{ verdict.label }}</span>
        </div>
        <div class="tblock-cell">
          <span class="tblock-key">进程退出码</span>
          <span class="tblock-val mono">{{ exitCodeText }}</span>
        </div>
        <div class="tblock-cell">
          <span class="tblock-key">续拉次数</span>
          <span class="tblock-val mono">{{ ev?.run?.restartCount ?? '—' }}</span>
        </div>
        <div class="tblock-cell">
          <span class="tblock-key">验收判据</span>
          <span class="tblock-val mono">{{ ev?.acceptance?.cases?.length ?? 0 }}</span>
        </div>
        <div class="tblock-cell">
          <span class="tblock-key">任务</span>
          <span class="tblock-val mono">{{ doneCount }}/{{ ev?.taskEvidence?.length ?? 0 }} 完工</span>
        </div>
      </div>

      <p v-if="verdict.why" class="verdict-why faint">{{ verdict.why }}</p>

      <!-- ===== 读取失败 ===== -->
      <div v-if="loadError" class="panel revision-cloud card">
        <p>{{ loadError }}</p>
      </div>

      <!-- ===== 缺什么 / 为什么（后端如实列的 notes） ===== -->
      <section v-if="ev?.notes?.length" class="panel card">
        <header class="panel-head">
          <h3 class="panel-title">缺什么 · 为什么</h3>
          <span class="faint mono">{{ ev.notes.length }} 条</span>
        </header>
        <ul class="card-body notes">
          <li v-for="(n, i) in ev.notes" :key="i">
            <IconAlertTriangle :size="14" :stroke-width="1.75" class="ni" />
            <span>{{ n }}</span>
          </li>
        </ul>
      </section>

      <!-- ===== 交付关实测报告（最关键的实物凭据） ===== -->
      <section class="panel card">
        <header class="panel-head">
          <h3 class="panel-title">
            <IconShieldCheck :size="16" :stroke-width="1.75" class="pt-ico" />
            交付关实测报告
          </h3>
          <span class="faint mono">_verify/run-report.md</span>
        </header>
        <pre v-if="ev?.runReport" class="doc mono">{{ ev.runReport }}</pre>
        <div v-else class="empty-sheet card-body">
          <IconFileText :size="34" :stroke-width="1.2" class="es-ico" />
          <h3>没有实测报告</h3>
          <p>
            交付关没跑执行式验证 —— 可能：项目没跑到收尾、被中途停止、该技术栈暂无验证器，
            或按 <b class="mono">SKIP_RUN_VERIFY</b> 显式跳过。
            <b>未验证 ≠ 通过</b>，所以这里不显示任何"通过"字样。
          </p>
        </div>
      </section>

      <!-- ===== 终态判据（completion.json） ===== -->
      <section v-if="ev?.completion" class="panel card">
        <header class="panel-head">
          <h3 class="panel-title">终态判据</h3>
          <span class="faint mono">_verify/completion.json</span>
        </header>
        <div class="card-body">
          <div v-if="completionBreakdown" class="chips">
            <span class="chip">任务 {{ completionBreakdown.total ?? '—' }}</span>
            <span class="chip chip-pass">完工 {{ completionBreakdown.done ?? '—' }}</span>
            <span class="chip chip-void">失败 {{ completionBreakdown.failed ?? '—' }}</span>
            <span class="chip">待办 {{ completionBreakdown.todo ?? '—' }}</span>
            <span class="chip">在制 {{ completionBreakdown.doing ?? '—' }}</span>
          </div>
          <ul v-if="completionReasons.length" class="notes">
            <li v-for="(r, i) in completionReasons" :key="i"><span>{{ r }}</span></li>
          </ul>
          <p v-if="ev.completion.failureDetail" class="fail-detail mono">
            {{ ev.completion.failureDetail.kind || 'EXCEPTION' }}：
            {{ ev.completion.failureDetail.message || '（无消息）' }}
          </p>
        </div>
      </section>

      <!-- ===== 验收判据清单 ===== -->
      <section class="panel card">
        <header class="panel-head">
          <h3 class="panel-title">验收判据</h3>
          <span class="faint mono">
            {{ ev?.acceptance?.files?.length ?? 0 }} 个阶段文件 · {{ ev?.acceptance?.cases?.length ?? 0 }} 条
          </span>
        </header>
        <ul v-if="ev?.acceptance?.cases?.length" class="rows">
          <li v-for="(c, i) in ev.acceptance.cases" :key="i" class="row kase">
            <span class="k-kind mono">{{ c.kind }}</span>
            <span class="k-line mono">{{ caseLine(c) }}</span>
            <span class="k-display faint">{{ c.display || c.id }}</span>
            <span class="k-from faint mono">{{ c.from }}</span>
          </li>
        </ul>
        <p v-else class="card-body faint empty-tip">
          没有落盘的验收判据。架构师每阶段应把可执行判据写进
          <b class="mono">_verify/acceptance-p&lt;阶段&gt;.json</b>；没有它，交付关只能退回从任务字段推导。
        </p>
      </section>

      <!-- ===== 任务级证据 ===== -->
      <section class="panel card">
        <header class="panel-head">
          <h3 class="panel-title">任务级证据</h3>
          <span class="faint mono">
            {{ ev?.taskEvidence?.length ?? 0 }} 个任务
            <template v-if="failedEvidence.length"> · {{ failedEvidence.length }} 个失败</template>
          </span>
        </header>
        <ul v-if="ev?.taskEvidence?.length" class="rows">
          <li v-for="t in ev.taskEvidence" :key="t.id" class="row tev">
            <span class="t-ext mono faint">{{ t.taskIdExt || t.id }}</span>
            <span class="t-title">{{ t.title }}</span>
            <span class="t-layer faint">{{ t.layer === 'frontend' ? '前端' : t.layer === 'backend' ? '后端' : '—' }}</span>
            <span v-if="t.retryCount > 0" class="t-retry mono">重试 {{ t.retryCount }}</span>
            <StampSeal :label="taskLabel(t.status)" :tone="taskTone(t.status)" />
            <details v-if="t.errorMsg || t.result" class="t-detail">
              <summary>证据</summary>
              <pre v-if="t.errorMsg" class="doc mono err">{{ t.errorMsg }}</pre>
              <pre v-if="t.result" class="doc mono">{{ t.result }}</pre>
            </details>
          </li>
        </ul>
        <p v-else class="card-body faint empty-tip">这个项目还没有任务行（还没拆过任务）。</p>
      </section>

      <!-- ===== 引擎真实 stdout ===== -->
      <section class="panel card">
        <header class="panel-head">
          <h3 class="panel-title">引擎日志（末尾）</h3>
          <span class="faint mono">logs/p{{ route.params.id }}.run.log</span>
        </header>
        <pre v-if="ev?.logTail?.length" class="doc mono logdoc">{{ ev.logTail.join('\n') }}</pre>
        <p v-else class="card-body faint empty-tip">
          没有引擎日志。Java spawn 的引擎才会写这份；手工终端跑的引擎不写。
        </p>
      </section>
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

/* 结论条与下方留一点呼吸 */
.tblock {
  margin-bottom: 8px;
}
.verdict-why {
  margin: 0 0 14px;
  font-size: var(--fs-meta);
}

.card {
  margin-bottom: 14px;
}
.card-body {
  padding: 14px 16px 16px;
}
.pt-ico {
  vertical-align: -3px;
  margin-right: 6px;
  color: var(--cyan);
}
.empty-tip {
  font-size: 13px;
}

/* notes：缺什么、为什么 */
.notes {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 13px;
  color: var(--ink-2);
}
.notes li {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  line-height: 1.7;
}
.ni {
  flex: none;
  margin-top: 3px;
  color: var(--wait-ink);
}

/* 报告 / 日志：等宽块，可滚动，不撑破版面 */
.doc {
  margin: 0;
  padding: 14px 16px 16px;
  font-size: 12.5px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 460px;
  overflow: auto;
}
.logdoc {
  max-height: 320px;
  color: var(--ink-2);
}
.err {
  color: var(--void-ink);
}

/* completion 的计数片 */
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}
.chip {
  font-size: 12px;
  padding: 2px 8px;
  border: 1px solid var(--line);
  border-radius: var(--r-xs);
  color: var(--ink-2);
  background: var(--paper-deep);
}
.chip-pass {
  color: var(--pass-ink);
  border-color: var(--pass);
}
.chip-void {
  color: var(--void-ink);
  border-color: var(--void);
}
.fail-detail {
  font-size: 12px;
  color: var(--void-ink);
  margin-top: 8px;
  white-space: pre-wrap;
  word-break: break-word;
}

/* 验收判据行 */
.kase {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 13px;
}
.k-kind {
  flex: none;
  width: 68px;
  font-size: 11px;
  color: var(--cyan);
}
.k-line {
  flex: 1;
  min-width: 0;
  word-break: break-all;
}
.k-display {
  flex: none;
  max-width: 22ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}
.k-from {
  flex: none;
  font-size: 11px;
}

/* 任务证据行 */
.tev {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  flex-wrap: wrap;
}
.t-ext {
  flex: none;
  font-size: 11px;
  min-width: 44px;
}
.t-title {
  flex: 1;
  min-width: 12ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.t-layer,
.t-retry {
  flex: none;
  font-size: 11px;
}
.t-retry {
  color: var(--wait-ink);
}
.t-detail {
  flex: 1 0 100%;
  font-size: 12px;
}
.t-detail summary {
  cursor: pointer;
  color: var(--cyan);
  width: fit-content;
}
.t-detail summary:focus-visible {
  outline: 2px solid var(--focus-cyan);
  outline-offset: 2px;
}
.t-detail .doc {
  margin-top: 6px;
  border: 1px solid var(--line);
  border-radius: var(--r-xs);
  background: var(--paper);
  max-height: 260px;
}
</style>
