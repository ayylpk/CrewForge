<template>
  <button
    class="gradient-btn"
    :disabled="disabled"
    :class="{ loading }"
    @click="$emit('click')"
  >
    <span v-if="loading" class="spinner"></span>
    <slot />
  </button>
</template>

<script setup lang="ts">
/**
 * 主操作按钮（青绿→冷蓝运行轨道，全项目统一）
 * @prop disabled — 禁用
 * @prop loading  — 加载态（转圈）
 * @event click — 显式 emit，不依赖属性透传
 */
defineProps<{
  disabled?: boolean
  loading?: boolean
}>()

defineEmits<{
  (e: 'click'): void
}>()
</script>

<style scoped>
.gradient-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 40px;
  padding: 0 22px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--grad1);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity var(--dur) var(--ease), transform 0.1s;
  box-shadow: 0 6px 18px rgba(83, 224, 183, 0.16);
}
.gradient-btn:hover:not(:disabled) {
  filter: brightness(1.08);
  box-shadow: 0 8px 22px rgba(83, 224, 183, 0.24);
}
.gradient-btn:active:not(:disabled) {
  transform: translateY(1px);
}
.gradient-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.spinner {
  width: 15px;
  height: 15px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
