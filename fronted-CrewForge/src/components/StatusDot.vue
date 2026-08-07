<template>
  <span class="status-dot" :style="{ background: color }"></span>
</template>

<script setup lang="ts">
/**
 * 彩色状态圆点
 * @prop color — 颜色（hex），状态色由调用方传入
 */
defineProps<{
  color: string
}>()
</script>

<style scoped>
.status-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
</style>
