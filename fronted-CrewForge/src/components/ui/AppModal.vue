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
    /**
     * 配色作用域。
     * 本组件用 <Teleport to="body"> 把内容腾到 body 下 —— 腾出去之后它
     * **不再是调用页面的 DOM 后代**，CSS 变量的继承链就断了。
     * 所以暗色页面（执行面板）里的弹窗必须显式带 tone="dark"，
     * 由这里补挂 .vsc-dark 作用域；否则暗色页面会弹出一个浅色对话框。
     */
    tone?: 'paper' | 'dark'
  }>(),
  { title: '', sheet: '', width: '560px', closeOnScrim: true, tone: 'paper' },
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
    <div
      class="scrim"
      :class="{ 'vsc-dark': props.tone === 'dark' }"
      @click.self="props.closeOnScrim && emit('close')"
    >
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
/* 暗色工作台上的遮罩用纯黑压暗，而不是纸面世界那层藏青薄雾。
   （不用 CSS 嵌套写法：本仓库其他地方也没有，保持一致更好读） */
.scrim.vsc-dark {
  background: rgba(0, 0, 0, 0.5);
}
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
