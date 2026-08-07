<template>
  <div class="card-shell" :class="[hoverable ? 'hoverable' : '']">
    <slot />
  </div>
</template>

<script setup lang="ts">
/**
 * 通用毛玻璃卡片容器
 * @prop hoverable — hover 时上浮 + 边框亮起
 */
defineProps<{
  hoverable?: boolean
}>()
</script>

<style scoped>
.card-shell {
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  transition: border-color var(--dur) var(--ease), transform var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}
.card-shell.hoverable {
  cursor: pointer;
}
.card-shell.hoverable:hover {
  border-color: var(--border2);
  transform: translateY(-2px);
  box-shadow: var(--shadow-sm);
}
</style>
