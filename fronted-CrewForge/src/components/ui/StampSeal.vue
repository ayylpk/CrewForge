<script setup lang="ts">
/* ============================================================
   状态章：全站唯一的状态表达（方章 -6° 微斜 + 双线圈描边）
   tone 对应 style.css 的 .stamp-{tone} 六色章面。
   just=true 时演一次「盖章」动效（0.32s 从上方压下来）。
   ============================================================ */
withDefaults(
  defineProps<{
    label: string
    tone?: 'pass' | 'void' | 'wait' | 'info' | 'pencil' | 'rust'
    just?: boolean
  }>(),
  { tone: 'info', just: false },
)
</script>

<template>
  <span class="stamp" :class="[`stamp-${tone}`, just && 'stamp-just']">{{ label }}</span>
</template>
