<script setup lang="ts">
/* ============================================================
   全局确认弹窗（执行 store 的 pendingConfirm 渲染端，任意页面可见）
   旧版行为保留：跳转执行页 / 确认 / 拒绝 / 点遮罩关闭。
   （确认/拒绝仍只 resolve store——接引擎 answer 通道是后话，与原一致）
   ============================================================ */
import { useRouter } from 'vue-router'
import { IconArrowRight, IconX } from '@tabler/icons-vue'
import { useExecutionStore } from '../stores/execution'

const router = useRouter()
const store = useExecutionStore()

function dismiss() {
  store.resolveConfirm()
}

function jumpToExecution() {
  if (store.pendingConfirm) {
    router.push(`/projects/${store.pendingConfirm.projectId}/execution`)
  }
  dismiss()
}

function confirm() {
  // 确认：后续接入实时通道时发送 answer="y" 给后端
  console.log('[GlobalConfirm] 确认:', store.pendingConfirm?.id)
  dismiss()
}

function reject() {
  // 拒绝：后续接入实时通道时发送 answer="n" 给后端
  console.log('[GlobalConfirm] 拒绝:', store.pendingConfirm?.id)
  dismiss()
}
</script>

<template>
  <Teleport to="body">
    <Transition name="door">
      <div v-if="store.hasPendingConfirm" class="scrim" @click.self="dismiss">
        <div class="gate sheet-fall" role="alertdialog" aria-modal="true">
          <div class="gate-head">
            <span class="stamp stamp-wait">会签待审</span>
            <button class="btn btn-ghost gate-x" aria-label="关闭" @click="dismiss">
              <IconX :size="16" :stroke-width="1.75" />
            </button>
          </div>
          <h3 class="gate-title">{{ store.pendingConfirm?.title }}</h3>
          <p class="gate-msg">{{ store.pendingConfirm?.message }}</p>
          <div class="gate-actions">
            <button class="btn btn-sm" @click="jumpToExecution">
              去执行页
              <IconArrowRight :size="14" :stroke-width="1.75" />
            </button>
            <div class="gate-group">
              <button class="btn btn-sm btn-danger" @click="reject">拒绝</button>
              <button class="btn btn-sm btn-primary" @click="confirm">确认放行</button>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.gate {
  width: 100%;
  max-width: 440px;
  background: var(--paper-raised);
  border: 1px solid var(--line-2);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-lg);
  padding: 18px 20px 20px;
}
.gate-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.gate-x {
  margin: -4px;
}
.gate-title {
  margin-top: 12px;
  font-size: var(--fs-h2);
  font-weight: 600;
}
.gate-msg {
  margin-top: 6px;
  font-size: var(--fs-body);
  color: var(--ink-2);
  line-height: 1.7;
  white-space: pre-line;
  word-break: break-word;
}
.gate-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 18px;
}
.gate-group {
  display: flex;
  gap: 8px;
}
.door-leave-active {
  transition: opacity 0.16s linear;
}
.door-leave-to {
  opacity: 0;
}
</style>
