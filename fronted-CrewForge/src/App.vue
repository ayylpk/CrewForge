<script setup lang="ts">
/* ============================================================
   应用壳：路由视图 + 两个全局挂件
   ------------------------------------------------------------
   旧版 DataFlowBg（深海数据流背景）随赛博皮囊退役，
   蓝晒格线底改由 style.css body::before 承担。
   ToastHost/ConfirmHost = 手写提示条与会签单（Element 拔除后的总线）。
   GlobalConfirmModal（execution store 的 pendingConfirm 渲染端）已删：
   store.showConfirm() 全仓无人调用 → 它挂在这里也永远渲染不出来，
   真正的确认门问答由 ExecutionView 的就地浮层承担。
   ============================================================ */
import ConfirmHost from './components/ui/ConfirmHost.vue'
import ToastHost from './components/ui/ToastHost.vue'
</script>

<template>
  <RouterView v-slot="{ Component }">
    <Transition name="route" mode="out-in">
      <component :is="Component" />
    </Transition>
  </RouterView>

  <!-- 全局挂件（任意页面可见） -->
  <ToastHost />
  <ConfirmHost />
</template>
