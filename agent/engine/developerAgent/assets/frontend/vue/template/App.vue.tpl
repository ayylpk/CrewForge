<script setup lang="ts"></script>

<template>
  <main class="app-shell">
    <header><h1>{{APP_TITLE}}</h1></header>
    <RouterView />
  </main>
</template>

<style>
body { margin: 0; font-family: Inter, system-ui, sans-serif; color: #1f2937; background: #f6f7f9; }
.app-shell { width: min(1120px, calc(100% - 32px)); margin: 0 auto; padding: 24px 0; }
</style>
