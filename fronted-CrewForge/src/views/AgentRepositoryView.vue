<template>
  <div class="agent-repo">
    <!-- 顶栏 -->
    <header class="topbar">
      <div class="topbar-left">
        <div class="logo">
          <img src="../assets/logo-crewforge.png" alt="CrewForge" />
          <span>CrewForge</span>
        </div>
      </div>
      <div class="topbar-center">
        <WorkspaceSwitcher :current="'personal'" @switch="switchWs" />
      </div>
      <div class="topbar-right">
        <button class="btn-back" @click="router.back()">← 返回</button>
        <span class="avatar">K</span>
      </div>
    </header>

    <main class="main">
      <!-- 页头 -->
      <div class="page-head">
        <h1>Agent 仓库</h1>
        <span class="hint"> </span>
        <button class="btn-new" @click="router.push({ name: 'agent-new' })">+ 新建 Agent</button>
      </div>

      <!-- 空态：仓库暂无 Agent -->
      <EmptyState
        title="仓库还是空的"
        desc="这里保存你自定义的 Agent 模板，之后在项目团队配置里可以一键复制使用"
      />
    </main>
  </div>
</template>

<script setup lang="ts">
/**
 * Agent 仓库：自定义 Agent 池（sys_agent）管理页
 * 从池里复制到项目 = sys_project_agent（复制非引用）
 * TODO: 池 CRUD（列表/新建/编辑/删除）对接 /api/agent
 */
import { useRouter } from 'vue-router'
import WorkspaceSwitcher from '../components/WorkspaceSwitcher.vue'
import EmptyState from '../components/EmptyState.vue'

const router = useRouter()

/** 工作区切换：个人 ↔ 团队 */
function switchWs(ws: 'personal' | 'team') {
  if (ws === 'personal') {
    router.push('/projects')
  } else {
    router.push('/teams')
  }
}
</script>

<style scoped>
.agent-repo {
  min-height: 100vh;
  background: transparent;
}

/* ===== 顶栏（与首页一致） ===== */
.topbar {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 48px;
  height: 56px;
  border-bottom: 1px solid var(--border);
  background: rgba(15, 19, 31, 0.85);
  backdrop-filter: blur(12px);
}
.topbar-center {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
}
.topbar-left {
  display: flex;
  align-items: center;
  gap: 14px;
}
.topbar-right {
  display: flex;
  align-items: center;
  gap: 14px;
}
.logo {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 600;
  font-size: 15px;
}
.logo img {
  width: 28px;
  height: 28px;
  border-radius: 8px;
}
.btn-back {
  padding: 6px 14px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text2);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
}
.btn-back:hover {
  border-color: var(--blue);
  color: var(--blue);
}
.avatar {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--bg4);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 600;
  color: var(--text2);
}

/* ===== 主体 ===== */
.main {
  width: 100%;
  padding: 32px 48px;
}
.page-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 20px;
}
.page-head h1 {
  font-size: 22px;
}
.hint {
  flex: 1;
  font-size: 12.5px;
  color: var(--text3);
}
.btn-new {
  padding: 8px 16px;
  border-radius: 8px;
  border: none;
  background: var(--grad1, linear-gradient(135deg, #45b8ff, #a76bff));
  color: #fff;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: opacity 0.2s;
}
.btn-new:hover {
  opacity: 0.9;
}
</style>
