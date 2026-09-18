<script setup lang="ts">
/* ============================================================
   审批小弹窗（本地命令执行权限）—— 9/18
   ------------------------------------------------------------
   形态：**对话流里的一小条**，不是独立大卡片。
   为什么改小：审批是干活途中被打断一次，不是"必须处理完才能看别的"。
   一张占满半屏的卡会挡住执行日志与任务看板，而那两样恰好是人判断
   "这条命令该不该批"的依据（"它刚才是不是已经失败三次了"）。

   再小也必须有这三样 —— 少一样就等于让人凭猜拍板：
     ① 命令原文（单独 mono 底，不塞进句子）
     ② 为什么要问（一行，超出省略）
     ③ 选了"始终允许"会写入什么规则（一行提示）
   ⚠️ ruleContent 为空时不给"始终允许"按钮：那一下点击会退化成给整类命令开永久口子。
   ============================================================ */
import { computed } from 'vue'
import { IconShieldLock } from '@tabler/icons-vue'
import type { ConfirmQuestion, PermissionDecision } from '../../api/confirm'
import { parseDetail } from '../../api/confirm'

const props = defineProps<{
  req: ConfirmQuestion
  busy?: boolean
  /** 还剩多久无人应答就按拒绝处理（权限卡 fail-closed） */
  countdown?: string
}>()

const emit = defineEmits<{ decide: [d: PermissionDecision] }>()

const d = computed(() => parseDetail(props.req))
const ruleContent = computed(() => (d.value.ruleContent ?? '').trim())
const canRemember = computed(() => ruleContent.value.length > 0)
const ruleLabel = computed(() => `Bash(${ruleContent.value})`)
</script>

<template>
  <div class="perm-pop">
    <div class="perm-pop-head">
      <span class="perm-pop-tag">需要批准</span>
      <span class="perm-pop-meta mono faint">{{ d.tool || req.node }}{{ countdown ? ` · ${countdown}` : '' }}</span>
    </div>

    <!-- ① 命令原文：人必须看得见自己批的是什么 -->
    <pre v-if="d.command" class="perm-pop-cmd mono">$ {{ d.command }}</pre>
    <p v-else class="perm-pop-q">{{ req.question }}</p>

    <!-- ② 为什么问 -->
    <p v-if="d.why" class="perm-pop-why faint">{{ d.why }}</p>

    <!-- ③ 会写入什么规则 —— 不写出来，人不知道自己在批一条永久规则 -->
    <p v-if="canRemember" class="perm-pop-rule">
      <IconShieldLock :size="12" :stroke-width="1.75" />
      始终允许 → 写入 <code class="mono">{{ ruleLabel }}</code>
    </p>

    <div class="perm-pop-actions">
      <button class="btn btn-sm perm-yes" :disabled="busy" @click="emit('decide', 'allow_once')">允许一次</button>
      <button
        v-if="canRemember"
        class="btn btn-sm perm-always"
        :disabled="busy"
        :title="`写入规则 ${ruleLabel}`"
        @click="emit('decide', 'allow_always')"
      >
        始终允许
      </button>
      <button class="btn btn-sm perm-no" :disabled="busy" @click="emit('decide', 'deny')">拒绝</button>
    </div>
  </div>
</template>

<style scoped>
/* 一条对话流里的"系统打断"：左边压一道等宽竖线表示"这不是聊天，是要你拍板的事" */
.perm-pop {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 9px 11px;
  border: 1px solid var(--wait-ink);
  border-left-width: 3px;
  border-radius: var(--r-xs);
  background: var(--vsc-side, var(--paper-raised));
}
.perm-pop-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.perm-pop-tag {
  font-size: 11px;
  font-weight: 600;
  color: var(--wait-ink);
}
.perm-pop-meta {
  margin-left: auto;
  font-size: 10px;
}
.perm-pop-cmd {
  margin: 0;
  padding: 6px 8px;
  border-radius: var(--r-xs);
  background: var(--vsc-editor, var(--paper-deep));
  font-size: 11.5px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--vsc-fg, var(--ink));
}
.perm-pop-q {
  font-size: 12px;
  line-height: 1.6;
}
.perm-pop-why {
  font-size: 11px;
  line-height: 1.55;
  /* 一行就够：详情去日志/任务看板里看，这里只回答"为什么突然问我" */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.perm-pop-rule {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 10.5px;
  color: var(--ink-3);
}
.perm-pop-rule code {
  padding: 0 4px;
  border-radius: 3px;
  background: var(--vsc-editor, var(--paper-deep));
  color: var(--cyan-ink, var(--cyan));
}
.perm-pop-actions {
  display: flex;
  gap: 6px;
  margin-top: 2px;
}
.perm-pop-actions .btn {
  padding: 3px 10px;
  font-size: 11.5px;
}
.perm-yes {
  border-color: var(--pass-ink, var(--line-2));
  color: var(--pass-ink, var(--ink));
}
.perm-always {
  border-color: var(--cyan);
  color: var(--cyan-ink, var(--cyan));
}
.perm-no {
  margin-left: auto;
  border-color: var(--line-2);
  color: var(--ink-3);
}
</style>
