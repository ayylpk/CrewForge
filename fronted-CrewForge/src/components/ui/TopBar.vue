<script setup lang="ts">
/* ============================================================
   图签顶栏（全局壳）：logo + 当前图纸上下文 + 右侧动作区。
   slot: context（页名/图号/状态章）、right（按钮/账户）。
   登录页不用它；六个活跃页里除登录外全部共用这一条。
   ============================================================ */
import logo from '../../assets/logo-crewforge.png'
</script>

<template>
  <header class="topbar">
    <div class="tb-inner">
      <router-link to="/projects" class="tb-brand" title="回到项目台账">
        <img :src="logo" alt="" class="tb-logo" />
        <span class="tb-word">Crew<i>Forge</i></span>
      </router-link>
      <span class="tb-rule" aria-hidden="true"></span>
      <div class="tb-context">
        <slot name="context" />
      </div>
      <div class="tb-right">
        <slot name="right" />
      </div>
    </div>
  </header>
</template>

<style scoped>
.topbar {
  position: sticky;
  top: 0;
  z-index: 100;
  background: var(--paper-raised);
  border-bottom: 1px solid var(--line-2); /* 主轮廓 0.7mm */
}
.tb-inner {
  display: flex;
  align-items: center;
  gap: 14px;
  height: 56px;
  max-width: 1320px;
  margin: 0 auto;
  padding: 0 40px;
}
@media (max-width: 760px) {
  .tb-inner {
    padding: 0 16px;
    gap: 10px;
  }
}
@media (max-width: 480px) {
  /* 手机屏字标让位给图号/状态章（9/17 exec-mobile：字标 90px 把章挤出画幅）；logo 仍认品牌 */
  .tb-word {
    display: none;
  }
  .tb-inner {
    gap: 8px;
  }
}
.tb-brand {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  flex: none;
  color: var(--ink);
}
.tb-logo {
  width: 26px;
  height: 26px;
  object-fit: contain;
}
.tb-word {
  font-family: var(--font-display);
  font-size: 19px;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.tb-word i {
  font-style: normal;
  color: var(--cyan);
}
/* 品牌与上下文之间的竖分隔：图框边的语言 */
.tb-rule {
  width: 1px;
  height: 24px;
  background: var(--line-2);
  flex: none;
}
.tb-context {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex: 1;
}
.tb-right {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
}
</style>
