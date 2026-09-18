<script setup lang="ts">
/* ============================================================
   状态章：全站唯一的状态表达（方章 -6° 微斜 + 双线圈描边）
   tone 对应 style.css 的 .stamp-{tone} 章面色（六色 → 9/18 加「靛」成七色）。
   ⚠️ 这里的联合类型必须跟 constants/status.ts 的 StampTone 同步：
      两处任一漏加，新增的章色就会在别的页面编译不过（9/18 加 indigo 时实测踩到）。
   just=true 时演一次「盖章」动效（0.32s 从上方压下来）。
   ============================================================ */
withDefaults(
  defineProps<{
    label: string
    tone?: 'pass' | 'void' | 'wait' | 'info' | 'pencil' | 'rust' | 'indigo'
    just?: boolean
  }>(),
  { tone: 'info', just: false },
)
</script>

<template>
  <span class="stamp" :class="[`stamp-${tone}`, just && 'stamp-just']">{{ label }}</span>
</template>
