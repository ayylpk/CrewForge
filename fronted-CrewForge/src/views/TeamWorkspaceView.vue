<template>
  <div class="team-ws">
    <!-- 顶栏 -->
    <header class="topbar">
      <div class="topbar-left">
        <div class="logo">
          <img src="../assets/logo-crewforge.png" alt="CrewForge" />
          <span>CrewForge</span>
        </div>
      </div>
      <div class="topbar-center">
        <WorkspaceSwitcher :current="'team'" @switch="switchWs" />
      </div>
      <div class="topbar-right">
        <!-- Agent 仓库（自定义 Agent 池管理） -->
        <button class="btn-api" title="管理 Agent 仓库" @click="goAgentRepo">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="7" width="18" height="13" rx="2" />
            <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            <path d="M12 11v5M9.5 13.5h5" />
          </svg>
          Agent 仓库
        </button>
        <span class="avatar">K</span>
        <button class="btn-logout" @click="logout">退出</button>
      </div>
    </header>

    <main class="main">
      <!-- 横幅背景层（透明，内容覆盖其上） -->
      <div class="main-banner"></div>

      <div class="content">
      <!-- 页头 -->
      <div class="page-head">
        <h1>团队</h1>
        <button class="btn-disabled" title="功能开发中">+ 创建团队</button>
      </div>

      <!-- 团队列表（骨架） -->
      <div class="team-grid">
        <CardShell
          v-for="t in teams"
          :key="t.id"
          hoverable
          class="team-card"
          :class="{ selected: activeTeam?.id === t.id }"
          @click="activeTeam = t"
        >
          <div class="team-top">
            <div class="team-logo" :style="{ background: t.grad }">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
            </div>
            <div class="team-meta">
              <h3>{{ t.name }}</h3>
              <p class="team-role" :style="{ color: t.color }">{{ t.role }}</p>
            </div>
            <span class="team-enter">进入 →</span>
          </div>
          <div class="team-stats">
            <div class="ts-item">
              <span class="ts-num">{{ t.members }}</span>
              <span class="ts-label">成员</span>
            </div>
            <div class="ts-item">
              <span class="ts-num">{{ t.projects }}</span>
              <span class="ts-label">项目</span>
            </div>
            <div class="ts-item">
              <span class="ts-num">{{ t.files }}</span>
              <span class="ts-label">文件</span>
            </div>
          </div>
        </CardShell>
      </div>

      <!-- 团队详情（骨架，选中团队后显示） -->
      <template v-if="activeTeam">
        <div class="detail-head">
          <h2>{{ activeTeam.name }}</h2>
          <span class="detail-hint">团队空间 · 骨架版 · 功能开发中</span>
        </div>

        <div class="grid-2">
          <!-- 成员 -->
          <CardShell class="card">
            <div class="card-head">
              <h3 class="card-title">成员</h3>
              <button class="btn-disabled small">+ 邀请</button>
            </div>
            <div class="member-list">
              <div v-for="m in activeTeam.membersList" :key="m.name" class="member-item">
                <span class="member-avatar" :style="{ background: m.color + '22', color: m.color }">
                  {{ m.name[0] }}
                </span>
                <span class="member-name">{{ m.name }}</span>
                <span class="member-role" :style="{ color: m.color }">{{ m.role }}</span>
              </div>
            </div>
          </CardShell>

          <!-- 团队项目 -->
          <CardShell class="card">
            <div class="card-head">
              <h3 class="card-title">团队项目</h3>
              <button class="btn-disabled small">+ 新建项目</button>
            </div>
            <div class="proj-list">
              <div v-for="p in activeTeam.projectsList" :key="p.name" class="proj-item">
                <span class="proj-ico" :style="{ background: p.grad }">
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="3" />
                    <path d="M3 9h18M9 21V9" />
                  </svg>
                </span>
                <span class="proj-name">{{ p.name }}</span>
                <span class="proj-state" :style="{ color: p.color }">
                  <span class="dot" :style="{ background: p.color }"></span>{{ p.state }}
                </span>
              </div>
            </div>
          </CardShell>
        </div>
      </template>
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import CardShell from '../components/CardShell.vue'
import WorkspaceSwitcher from '../components/WorkspaceSwitcher.vue'

const router = useRouter()

/** 工作区切换：团队 → 个人 */
function switchWs(ws: 'personal' | 'team') {
  if (ws === 'personal') {
    router.push('/projects')
  }
}

// ===== 跳转：Agent 仓库（自定义 Agent 池管理） =====
function goAgentRepo() {
  router.push({ name: 'agent-repo' })
}

// ===== mock 团队（骨架数据） =====
interface Team {
  id: number
  name: string
  role: string
  color: string
  grad: string
  members: number
  projects: number
  files: number
  membersList: { name: string; role: string; color: string }[]
  projectsList: { name: string; state: string; color: string; grad: string }[]
}

const teams = ref<Team[]>([
  {
    id: 1,
    name: '后端开发组',
    role: '我是 · 管理员',
    color: '#5ecb8a',
    grad: 'linear-gradient(135deg,#5ecb8a,#5ec8c0)',
    members: 3,
    projects: 2,
    files: 41,
    membersList: [
      { name: 'K', role: '管理员', color: '#5ecb8a' },
      { name: 'Z', role: '成员', color: '#45b8ff' },
      { name: 'L', role: '成员', color: '#f0c060' },
    ],
    projectsList: [
      { name: 'CRM 客户管理系统', state: '执行中', color: '#5ecb8a', grad: 'linear-gradient(135deg,#45b8ff,#a76bff)' },
      { name: '进销存管理后台', state: '澄清中', color: '#f0c060', grad: 'linear-gradient(135deg,#f0c060,#f09050)' },
    ],
  },
  {
    id: 2,
    name: '前端小组',
    role: '我是 · 成员',
    color: '#f0c060',
    grad: 'linear-gradient(135deg,#f0c060,#f09050)',
    members: 2,
    projects: 1,
    files: 16,
    membersList: [
      { name: 'M', role: '管理员', color: '#f0c060' },
      { name: 'K', role: '成员', color: '#45b8ff' },
    ],
    projectsList: [
      { name: '学生选课系统', state: '已完成', color: '#a76bff', grad: 'linear-gradient(135deg,#5ecb8a,#5ec8c0)' },
    ],
  },
])

const activeTeam = ref<Team | null>(null)

function logout() {
  localStorage.removeItem('cf_token')
  router.push('/login')
}
</script>

<style scoped>
.team-ws {
  position: relative;
  z-index: 1;
  min-height: 100vh;
}

/* ===== 顶栏 ===== */
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
.avatar {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--bg4);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--blue);
  border: 1px solid var(--border2);
}
.btn-api {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg3);
  color: var(--text2);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
}
.btn-api:hover {
  border-color: var(--blue);
  color: var(--blue);
}
.btn-logout {
  padding: 6px 14px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text2);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
}
.btn-logout:hover {
  border-color: var(--red);
  color: var(--red);
}

/* ===== 主区域 ===== */
.main {
  position: relative;
  width: 100%;
  max-width: 1080px;
  margin: 0 auto;
  padding: 32px 48px 460px;
}
/* 横幅背景层（完整图放大显示，底部对齐页面底部） */
.main-banner {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 400px;
  background-image: url('../assets/banner-agents.png');
  /* 完整显示，不裁切 */
  background-size: contain;
  background-repeat: no-repeat;
  background-position: center bottom;
  opacity: 0.3;
  pointer-events: none;
  mask-image: linear-gradient(to top, rgba(0, 0, 0, 0.95), transparent 88%);
  -webkit-mask-image: linear-gradient(to top, rgba(0, 0, 0, 0.95), transparent 88%);
}
/* 内容层浮在横幅上方 */
.content {
  position: relative;
  z-index: 1;
}
.page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 24px;
}
.page-head h1 {
  font-size: 24px;
  font-weight: 700;
}
.btn-disabled {
  padding: 9px 20px;
  border-radius: 8px;
  border: 1px dashed var(--border2);
  background: transparent;
  color: var(--text3);
  font-size: 14px;
  font-weight: 500;
  cursor: not-allowed;
}
.btn-disabled.small {
  padding: 5px 12px;
  font-size: 12px;
}

/* ===== 团队卡片 ===== */
.team-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
  margin-bottom: 32px;
}
.team-card {
  padding: 20px;
}
.team-card.selected {
  border-color: var(--blue);
  box-shadow: 0 0 0 1px rgba(69, 184, 255, 0.3);
}
.team-top {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}
.team-logo {
  width: 42px;
  height: 42px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.team-meta {
  flex: 1;
}
.team-meta h3 {
  font-size: 15px;
  margin-bottom: 3px;
}
.team-role {
  font-size: 11.5px;
}
.team-enter {
  font-size: 12px;
  color: var(--blue);
  opacity: 0;
  transform: translateX(-4px);
  transition: all 0.2s var(--ease);
}
.team-card:hover .team-enter {
  opacity: 1;
  transform: translateX(0);
}
.team-stats {
  display: flex;
  border-top: 1px solid var(--border);
  padding-top: 14px;
}
.ts-item {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
}
.ts-num {
  font-size: 17px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.ts-label {
  font-size: 11px;
  color: var(--text3);
}

/* ===== 详情 ===== */
.detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.detail-head h2 {
  font-size: 18px;
  font-weight: 700;
}
.detail-hint {
  font-size: 12px;
  color: var(--text3);
}
.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
.card {
  padding: 20px;
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}
.card-title {
  font-size: 14px;
  font-weight: 600;
}

/* 成员 */
.member-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.member-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-radius: 9px;
  background: var(--bg3);
  font-size: 13px;
}
.member-avatar {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  flex-shrink: 0;
}
.member-name {
  flex: 1;
}
.member-role {
  font-size: 11.5px;
}

/* 团队项目 */
.proj-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.proj-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  border-radius: 9px;
  background: var(--bg3);
  font-size: 13px;
}
.proj-ico {
  width: 26px;
  height: 26px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.proj-name {
  flex: 1;
}
.proj-state {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
}
.proj-state .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}
</style>
