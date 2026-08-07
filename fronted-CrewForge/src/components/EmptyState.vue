<template>
  <div class="empty-state">
    <div class="empty-icon">{{ icon }}</div>
    <p class="empty-title">{{ title }}</p>
    <p v-if="desc" class="empty-desc">{{ desc }}</p>
    <div v-if="$slots.default" class="empty-action">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 空状态占位
 * @prop icon  — emoji/图标
 * @prop title — 主文案
 * @prop desc  — 副文案（可选）
 */
defineProps<{
  icon?: string
  title: string
  desc?: string
}>()
</script>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 64px 0;
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  text-align: center;
}
.empty-icon {
  font-size: 40px;
  margin-bottom: 16px;
  opacity: 0.7;
}
.empty-title {
  font-size: 15px;
  color: var(--text2);
}
.empty-desc {
  font-size: 13px;
  color: var(--text3);
  margin-top: 6px;
}
.empty-action {
  margin-top: 20px;
}
</style>
