<script setup lang="ts">
/* ============================================================
   通用弹窗「图纸浮层」：硫酸纸（全站唯一允许 backdrop-blur 的两处之一）
   父组件用 v-if 控制开关；Esc / 点遮罩 emits('close')。
   head 里的图号牌可传 sheet（如 'SET-01'），没传就不显示。
   ============================================================ */
import { onBeforeUnmount } from 'vue'
import { IconX } from '@tabler/icons-vue'

const props = withDefaults(
  defineProps<{
    title?: string
    sheet?: string
    width?: string
    closeOnScrim?: boolean
  }>(),
  { title: '', sheet: '', width: '560px', closeOnScrim: true },
)

const emit = defineEmits<{ close: [] }>()

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}
window.addEventListener('keydown', onKey)
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <div class="scrim" @click.self="props.closeOnScrim && emit('close')">
      <div class="modal sheet-fall" :style="{ maxWidth: width }" role="dialog" aria-modal="true" :aria-label="title">
        <header class="modal-head">
          <div class="modal-titles">
            <span v-if="sheet" class="sheet-no">{{ sheet }}</span>
            <h3 class="modal-title">{{ title }}</h3>
          </div>
          <button class="btn btn-ghost modal-x" aria-label="关闭" @click="emit('close')">
            <IconX :size="17" :stroke-width="1.75" />
          </button>
        </header>
        <div class="modal-body">
          <slot />
        </div>
        <footer v-if="$slots.footer" class="modal-foot">
          <slot name="footer" />
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.modal {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-height: 86vh;
  background: var(--paper-raised);
  border: 1px solid var(--line-2);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}
.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--line);
  background: var(--paper); /* 头浅一档：像图框标题栏 */
}
.modal-titles {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
}
.modal-title {
  font-size: var(--fs-h2);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.modal-x {
  flex: none;
}
.modal-body {
  padding: 18px;
  overflow-y: auto;
}
.modal-foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px 18px;
  border-top: 1px solid var(--line);
  background: var(--paper);
}
</style>
