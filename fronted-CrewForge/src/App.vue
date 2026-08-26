<script setup lang="ts">
import DataFlowBg from './components/DataFlowBg.vue'
import GlobalConfirmModal from './components/GlobalConfirmModal.vue'
</script>

<template>
  <!-- 全局背景（深海科技蓝 · 数据流形态） -->
  <DataFlowBg />
  <router-view />
  <!-- 全局确认弹窗（任意页面可见） -->
  <GlobalConfirmModal />
</template>
