<template>
  <div class="workspace-switcher">
    <button
      class="ws-btn"
      :class="{ active: current === 'personal' }"
      @click="$emit('switch', 'personal')"
    >
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
      个人空间
    </button>
    <button
      class="ws-btn"
      :class="{ active: current === 'team' }"
      @click="$emit('switch', 'team')"
    >
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
      团队空间
    </button>
  </div>
</template>

<script setup lang="ts">
/**
 * 工作区切换器：个人空间 / 团队空间（平级入口）
 * @prop current — 当前工作区
 * @event switch — 切换工作区
 */
defineProps<{
  current: 'personal' | 'team'
}>()

defineEmits<{
  (e: 'switch', ws: 'personal' | 'team'): void
}>()
</script>

<style scoped>
.workspace-switcher {
  display: flex;
  gap: 4px;
  background: var(--bg3);
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 3px;
}
.ws-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--text3);
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
}
.ws-btn:hover {
  color: var(--text);
}
.ws-btn.active {
  background: var(--grad1);
  color: #fff;
}
</style>
