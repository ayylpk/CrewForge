<script setup lang="ts">
/* ============================================================
   全局确认门（confirmDialog 总线的渲染端），挂在 App.vue。
   替代 ElMessageBox.confirm（8 处）与 alert（路由守卫 1 处）。
   只给 ok 按钮 = 提示框模式。Esc / 遮罩点击按「取消」处理。
   ============================================================ */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { answerConfirm, confirmState } from '../../utils/confirm'

const okBtn = ref<HTMLButtonElement | null>(null)
const req = computed(() => confirmState.pending)
const isAlert = computed(() => !!req.value && req.value.cancel === undefined)

watch(req, async (v) => {
  if (v) {
    await nextTick()
    okBtn.value?.focus() // 键盘直达确认，Esc 退出
  }
})

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && confirmState.pending) answerConfirm(false)
}
window.addEventListener('keydown', onKey)
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <Transition name="door">
      <div v-if="req" class="scrim" @click.self="answerConfirm(false)">
        <div class="door-sheet sheet-fall" role="alertdialog" aria-modal="true" :aria-label="req.title">
          <!-- 标题栏：确认门也要有图号感 -->
          <div class="door-head">
            <span class="sheet-no">DOOR·{{ isAlert ? 'NOTE' : 'CONFIRM' }}</span>
            <h3 class="door-title">{{ req.title }}</h3>
          </div>
          <p v-if="req.body" class="door-body">{{ req.body }}</p>
          <div class="door-foot">
            <button v-if="!isAlert" class="btn btn-sm" @click="answerConfirm(false)">
              {{ req.cancel }}
            </button>
            <button
              ref="okBtn"
              class="btn btn-sm"
              :class="req.danger ? 'btn-danger' : 'btn-primary'"
              @click="answerConfirm(true)"
            >
              {{ req.ok || '确定' }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.door-sheet {
  width: 100%;
  max-width: 420px;
  background: var(--paper-raised);
  border: 1px solid var(--line-2);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-lg);
  padding: 20px 22px;
}
.door-head {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 8px;
}
.door-title {
  font-size: var(--fs-h2);
  font-weight: 600;
}
.door-body {
  font-size: var(--fs-body);
  color: var(--ink-2);
  line-height: 1.7;
  white-space: pre-line; /* 停止工作确认文案里有换行 */
}
.door-foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 18px;
}
.door-leave-active {
  transition: opacity 0.16s linear;
}
.door-leave-to {
  opacity: 0;
}
</style>
