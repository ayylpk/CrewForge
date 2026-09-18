<script setup lang="ts">
/* ============================================================
   全局提示回执条（toast 总线的渲染端），挂在 App.vue。
   右上角堆叠，最多 4 条，3.8s 自动收；aria-live 播报给读屏。
   ============================================================ */
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconCircleX,
  IconInfoCircle,
  IconX,
} from '@tabler/icons-vue'
import { dismiss, toast } from '../../utils/toast'

const ICONS = {
  success: IconCircleCheck,
  error: IconCircleX,
  warning: IconAlertTriangle,
  info: IconInfoCircle,
} as const
</script>

<template>
  <div class="toast-host" aria-live="polite">
    <TransitionGroup name="toast">
      <div v-for="t in toast.state.items" :key="t.id" class="toast-item" :class="`t-${t.kind}`">
        <component :is="ICONS[t.kind]" :size="17" :stroke-width="1.75" class="t-ico" />
        <span class="t-text">{{ t.text }}</span>
        <button class="t-close" aria-label="关闭提示" @click="dismiss(t.id)">
          <IconX :size="13" :stroke-width="1.75" />
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-host {
  position: fixed;
  top: 68px;
  right: 20px;
  z-index: 1200;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: min(420px, calc(100vw - 32px));
}
.toast-item {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 10px 12px;
  background: var(--paper-raised);
  border: 1px solid var(--line-2);
  border-radius: var(--r);
  box-shadow: var(--shadow);
  font-size: var(--fs-meta);
  line-height: 1.5;
}
/* 性质由领头图章图标自己讲（形+色双通道），不做色条边 */
.t-ico {
  flex: none;
  margin-top: 1px;
}
.t-success .t-ico { color: var(--pass-ink); }
.t-error .t-ico { color: var(--void-ink); }
.t-warning .t-ico { color: var(--wait-ink); }
.t-info .t-ico { color: var(--cyan); }
.t-text {
  flex: 1;
  color: var(--ink);
  word-break: break-word;
}
.t-close {
  flex: none;
  display: inline-flex;
  padding: 2px;
  color: var(--ink-3);
  border-radius: var(--r-xs);
}
.t-close:hover {
  color: var(--ink);
  background: var(--cyan-wash);
}
/* 入场像盖章压下来，出场只是抽走 */
.toast-enter-active {
  transition: transform 0.28s var(--ease), opacity 0.28s var(--ease);
}
.toast-enter-from {
  transform: translateY(-10px) scale(0.97);
  opacity: 0;
}
.toast-leave-active {
  transition: opacity 0.18s linear;
  position: absolute; /* 抽走时下面的条子立刻补位 */
  width: 100%;
}
.toast-leave-to {
  opacity: 0;
}
</style>
