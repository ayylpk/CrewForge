<template>
  <div class="team-detail">
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
        <button class="btn-back" @click="router.push('/teams')">← 团队列表</button>
        <span class="avatar">{{ myName() }}</span>
        <button class="btn-logout" @click="logout">退出</button>
      </div>
    </header>

    <main class="main">
      <!-- 团队头部 -->
      <CardShell class="head-card">
        <div class="head-left">
          <div class="team-logo">
            <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </div>
          <div class="head-meta">
            <h1>{{ team?.name || '团队' }}</h1>
            <p class="head-role" :style="{ color: isManager ? '#5ecb8a' : '#f0c060' }">
              {{ isManager ? '我是 · 管理员' : '我是 · 成员' }}
            </p>
          </div>
        </div>
        <div class="head-right">
          <div class="stat">
            <span class="stat-num">{{ team?.members ?? 0 }}<em>/{{ team?.maxMembers ?? 0 }}</em></span>
            <span class="stat-label">成员</span>
          </div>
          <div class="stat">
            <span class="stat-num">{{ projects.length }}</span>
            <span class="stat-label">项目</span>
          </div>
        </div>
      </CardShell>

      <!-- 描述 + 邀请码（管理员可见） -->
      <CardShell class="desc-card">
        <p class="desc">{{ team?.description || '这个团队还没有描述' }}</p>
        <div v-if="isManager" class="invite-row">
          <span class="invite-label">邀请码</span>
          <code class="invite-code">{{ team?.invitationCode }}</code>
          <span class="invite-hint">成员凭此码申请加入</span>
        </div>
      </CardShell>

      <!-- 左右分栏：成员（左） + 团队项目（右） -->
      <div class="columns">
        <!-- 左：成员 -->
        <div class="col col-left">
          <div class="col-head">
            <h2>成员</h2>
            <div class="col-ops">
              <span class="col-hint">{{ team?.members ?? 0 }} / {{ team?.maxMembers ?? 0 }} 人</span>
              <!-- 申请列表（仅管理员） -->
              <button v-if="isManager" class="btn-apply" @click="openApplyModal">
                <span class="apply-dot" :class="{ has: pendingCount > 0 }"></span>
                申请列表{{ pendingCount > 0 ? ` (${pendingCount})` : '' }}
              </button>
            </div>
          </div>
          <CardShell class="member-panel">
            <div v-if="membersLoading" class="member-empty">加载中...</div>
            <div v-else-if="members.length === 0" class="member-empty">暂无成员</div>
            <div v-else class="member-list">
              <div v-for="m in members" :key="m.id" class="member-item">
                <span class="member-avatar" :style="{ color: m.role === '管理员' ? '#5ecb8a' : '#45b8ff' }">
                  {{ ((m.realName || m.username || '?')[0] || '?').toUpperCase() }}
                </span>
                <div class="member-info">
                  <span class="member-name">{{ m.realName || m.username }}</span>
                  <span class="member-role" :style="{ color: m.role === '管理员' ? '#5ecb8a' : 'var(--text3)' }">
                    {{ m.role }}
                  </span>
                </div>
              </div>
            </div>
          </CardShell>
        </div>

        <!-- 右：团队项目 -->
        <div class="col col-right">
          <div class="col-head">
            <h2>团队项目</h2>
            <div class="col-ops">
              <span class="col-hint">共 {{ projects.length }} 个</span>
              <GradientButton @click="goCreateProject">+ 创建项目</GradientButton>
            </div>
          </div>

          <div v-if="projectsLoading" class="empty">加载中...</div>
          <EmptyState
            v-else-if="projects.length === 0"
            icon="▤"
            title="还没有团队项目"
            desc="点击「创建项目」在团队里新建一个 AI 协作项目"
          >
            <GradientButton @click="goCreateProject">+ 创建项目</GradientButton>
          </EmptyState>
          <div v-else class="proj-grid">
            <CardShell v-for="p in projects" :key="p.id" hoverable class="proj-card" @click="openProject(p.id)">
              <div class="proj-top">
                <div class="proj-ico" :style="{ background: projectGrad(p) }">{{ projectIcon(p) }}</div>
                <h3 class="proj-name">{{ p.name }}</h3>
                <span class="proj-status" :style="{ color: statusMeta(p.status).color }">
                  <StatusDot :color="statusMeta(p.status).color" />
                  {{ statusMeta(p.status).label }}
                </span>
              </div>
              <div class="proj-info">
                <p>{{ p.description || '暂无描述' }}</p>
              </div>
              <div class="proj-bottom">
                <span class="proj-time">{{ p.moduleCount || 0 }} 个模块</span>
                <span class="proj-enter">进入 →</span>
              </div>
            </CardShell>
          </div>
        </div>
      </div>
    </main>

    <!-- 申请列表弹窗（管理员审核） -->
    <div v-if="showApplyModal" class="apply-mask" @click.self="closeApplyModal">
      <div class="apply-modal">
        <div class="am-head">
          <h2>加入申请</h2>
          <button class="am-close" title="关闭" @click="closeApplyModal">✕</button>
        </div>
        <div v-if="applyLoading" class="am-empty">加载中...</div>
        <div v-else-if="applies.length === 0" class="am-empty">暂无申请，把邀请码发给想加入的人</div>
        <div v-else class="am-list">
          <div v-for="a in applies" :key="a.id" class="am-item">
            <span class="am-avatar">{{ ((a.realName || a.username || '?')[0] || '?').toUpperCase() }}</span>
            <div class="am-info">
              <span class="am-name">{{ a.realName || a.username }}</span>
              <span class="am-state" :style="{ color: applyState(a.status).color }">{{ applyState(a.status).label }}</span>
            </div>
            <div v-if="a.status === 0" class="am-ops">
              <button class="am-btn ok" @click="doApprove(a)">同意</button>
              <button class="am-btn no" @click="doReject(a)">拒绝</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import CardShell from '../components/CardShell.vue'
import GradientButton from '../components/GradientButton.vue'
import StatusDot from '../components/StatusDot.vue'
import EmptyState from '../components/EmptyState.vue'
import WorkspaceSwitcher from '../components/WorkspaceSwitcher.vue'
import { fetchTenantById, fetchApplyList, approveApply, rejectApply, fetchTeamMembers, type TenantVO, type TenantApplyVO, type MemberVO } from '../api/tenant'
import { fetchTeamProjects } from '../api/project'
import type { Project, ProjectStatus } from '../types/project'

const router = useRouter()
const route = useRoute()

const teamId = Number(route.params.id)
const team = ref<TenantVO | null>(null)
const projects = ref<Project[]>([])
const projectsLoading = ref(false)
const members = ref<MemberVO[]>([])
const membersLoading = ref(false)

/** 是否管理员（owner） */
const isManager = computed(() => {
  const raw = localStorage.getItem('cf_user_info')
  const myId = raw ? (JSON.parse(raw) as { userId: number }).userId : 0
  return team.value?.ownerId === myId
})

// ===== 项目状态元数据（与 ProjectsView 一致） =====
const STATUS_META: Record<ProjectStatus, { label: string; color: string }> = {
  draft: { label: '草稿', color: '#8890a8' },
  clarifying: { label: '澄清中', color: '#f0c060' },
  planning: { label: '规划中', color: '#45b8ff' },
  executing: { label: '执行中', color: '#5ecb8a' },
  paused: { label: '已暂停', color: '#f09050' },
  done: { label: '已完成', color: '#a76bff' },
  failed: { label: '失败', color: '#f26060' },
}
function statusMeta(s: ProjectStatus) {
  return STATUS_META[s] || STATUS_META.draft
}
function projectIcon(p: Project): string {
  const icons: [RegExp, string][] = [
    [/CRM|客户|crm/i, '📊'],
    [/选课|学生|教育|课程/i, '🎓'],
    [/进销存|库存|采购|订单|商城/i, '📦'],
    [/图书|借阅/i, '📚'],
  ]
  return icons.find(([re]) => re.test(p.name))?.[1] ?? '💻'
}
function projectGrad(p: Project): string {
  const grads = [
    'linear-gradient(135deg,#45b8ff,#a76bff)',
    'linear-gradient(135deg,#5ecb8a,#5ec8c0)',
    'linear-gradient(135deg,#f0c060,#f09050)',
    'linear-gradient(135deg,#a76bff,#f070a0)',
  ]
  return grads[p.id % grads.length]
}

// ===== 加入申请（管理员审核） =====
const showApplyModal = ref(false)
const applyLoading = ref(false)
const applies = ref<TenantApplyVO[]>([])

const pendingCount = computed(() => applies.value.filter((a) => a.status === 0).length)

const APPLY_STATE: Record<number, { label: string; color: string }> = {
  0: { label: '待审核', color: '#f0c060' },
  1: { label: '已同意', color: '#5ecb8a' },
  2: { label: '已拒绝', color: '#f26060' },
}
function applyState(status: number) {
  return APPLY_STATE[status] || APPLY_STATE[0]
}

async function openApplyModal() {
  showApplyModal.value = true
  applyLoading.value = true
  try {
    applies.value = await fetchApplyList(teamId)
  } catch {
    applies.value = []
  } finally {
    applyLoading.value = false
  }
}

function closeApplyModal() {
  showApplyModal.value = false
}

async function doApprove(a: TenantApplyVO) {
  try {
    await approveApply(a.id)
    ElMessage.success(`已同意「${a.realName || a.username}」加入`)
    applies.value = await fetchApplyList(teamId)
    // 成员数可能 +1，刷新团队信息
    team.value = await fetchTenantById(teamId)
  } catch {
    /* 拦截器已提示 */
  }
}

async function doReject(a: TenantApplyVO) {
  try {
    await rejectApply(a.id)
    ElMessage.success(`已拒绝「${a.realName || a.username}」的申请`)
    applies.value = await fetchApplyList(teamId)
  } catch {
    /* 拦截器已提示 */
  }
}

// ===== 页面初始化 =====
onMounted(async () => {
  if (!teamId) {
    router.push('/teams')
    return
  }
  // 团队上下文（X-Tenant-Id）：进入详情页时同步（兜底，正常从列表进入已设置）
  localStorage.setItem('cf_active_tenant', String(teamId))
  try {
    team.value = await fetchTenantById(teamId)
  } catch {
    /* 拦截器已提示 */
  }
  loadProjects()
  loadMembers()
})

/** 成员列表（join sys_user，管理员/成员角色标记） */
async function loadMembers() {
  membersLoading.value = true
  try {
    members.value = await fetchTeamMembers(teamId)
  } catch {
    members.value = []
  } finally {
    membersLoading.value = false
  }
}

async function loadProjects() {
  projectsLoading.value = true
  try {
    const { records } = await fetchTeamProjects(teamId)
    projects.value = records
  } catch {
    projects.value = []
  } finally {
    projectsLoading.value = false
  }
}

function openProject(id: number) {
  router.push(`/projects/${id}`)
}

/** 创建团队项目：复用个人空间的新建流程（?tenantId= 进入团队模式） */
function goCreateProject() {
  router.push(`/projects/new?tenantId=${teamId}`)
}

function switchWs(ws: 'personal' | 'team') {
  if (ws === 'personal') {
    localStorage.removeItem('cf_active_tenant')
    router.push('/projects')
  }
}

/** 当前登录用户显示名（cf_user_info.realName 首字母，取不到用 K） */
function myName(): string {
  try {
    const raw = localStorage.getItem('cf_user_info')
    if (raw) {
      const info = JSON.parse(raw) as { realName?: string; username?: string }
      if (info.realName) return info.realName.slice(0, 1).toUpperCase()
      if (info.username) return info.username.slice(0, 1).toUpperCase()
    }
  } catch {
    /* 忽略 */
  }
  return 'K'
}

function logout() {
  localStorage.removeItem('cf_token')
  localStorage.removeItem('cf_active_tenant')
  router.push('/login')
}
</script>

<style scoped>
.team-detail {
  position: relative;
  z-index: 1;
  min-height: 100vh;
}

/* ===== 顶栏（与团队空间一致） ===== */
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
.btn-back {
  padding: 7px 14px;
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

/* ===== 主体（上下滑动） ===== */
.main {
  width: 100%;
  max-width: 1240px;
  margin: 0 auto;
  padding: 32px 48px 60px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 团队头部卡片 */
.head-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 22px 24px;
}
.head-left {
  display: flex;
  align-items: center;
  gap: 16px;
}
.team-logo {
  width: 56px;
  height: 56px;
  border-radius: 16px;
  background: linear-gradient(135deg, #45b8ff, #a76bff);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.head-meta h1 {
  font-size: 20px;
  font-weight: 700;
}
.head-role {
  margin-top: 4px;
  font-size: 12.5px;
}
.head-right {
  display: flex;
  gap: 32px;
}
.stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
}
.stat-num {
  font-size: 19px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.stat-num em {
  font-size: 12px;
  font-weight: 400;
  color: var(--text3);
  font-style: normal;
}
.stat-label {
  font-size: 11.5px;
  color: var(--text3);
}

/* 描述 + 邀请码 */
.desc-card {
  padding: 18px 24px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.desc {
  font-size: 13.5px;
  color: var(--text2);
  line-height: 1.7;
}
.invite-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-top: 12px;
  border-top: 1px dashed var(--border);
}
.invite-label {
  font-size: 12px;
  color: var(--text3);
}
.invite-code {
  font-size: 14px;
  font-weight: 600;
  color: var(--blue);
  letter-spacing: 1px;
  user-select: all;
}
.invite-hint {
  font-size: 11.5px;
  color: var(--text3);
}

/* ===== 左右分栏 ===== */
.columns {
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 20px;
  align-items: start;
}
.col {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.col-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.col-head h2 {
  font-size: 16px;
  font-weight: 700;
}
.col-ops {
  display: flex;
  align-items: center;
  gap: 10px;
}
.col-hint {
  font-size: 12px;
  color: var(--text3);
}

/* 申请列表按钮（管理员） */
.btn-apply {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg3);
  color: var(--text2);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}
.btn-apply:hover {
  border-color: var(--blue);
  color: var(--blue);
}
.apply-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text3);
}
.apply-dot.has {
  background: #f0c060;
  box-shadow: 0 0 6px rgba(240, 192, 96, 0.6);
}

/* 成员面板 */
.member-panel {
  padding: 14px;
  min-height: 260px;
}
.member-empty {
  padding: 60px 0;
  text-align: center;
  color: var(--text3);
  font-size: 13px;
  line-height: 1.8;
}
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
}
.member-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: rgba(69, 184, 255, 0.12);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 600;
  flex-shrink: 0;
}
.member-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.member-name {
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.member-role {
  font-size: 11px;
}

/* ===== 团队项目（复用个人空间卡片） ===== */
.empty {
  padding: 48px 0;
  text-align: center;
  color: var(--text3);
  font-size: 13px;
  background: var(--bg3);
  border-radius: 14px;
  border: 1px dashed var(--border2);
}
.proj-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 14px;
}
.proj-card {
  padding: 16px 18px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.proj-top {
  display: flex;
  align-items: center;
  gap: 10px;
}
.proj-ico {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  flex-shrink: 0;
}
.proj-name {
  flex: 1;
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.proj-status {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  white-space: nowrap;
}
.proj-info p {
  font-size: 12.5px;
  color: var(--text2);
  line-height: 1.6;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 40px;
}
.proj-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 10px;
  border-top: 1px solid var(--border);
}
.proj-time {
  font-size: 11.5px;
  color: var(--text3);
}
.proj-enter {
  font-size: 12px;
  color: var(--blue);
}

/* ===== 申请列表弹窗 ===== */
.apply-mask {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(8, 11, 17, 0.7);
  backdrop-filter: blur(4px);
}
.apply-modal {
  width: 480px;
  max-height: 70vh;
  box-sizing: border-box;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 24px 28px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
}
.am-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.am-head h2 {
  font-size: 16px;
  font-weight: 700;
}
.am-close {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text3);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}
.am-close:hover {
  border-color: var(--red);
  color: var(--red);
}
.am-empty {
  padding: 40px 0;
  text-align: center;
  color: var(--text3);
  font-size: 13px;
}
.am-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
}
.am-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 14px;
  border-radius: 10px;
  background: var(--bg3);
}
.am-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: rgba(69, 184, 255, 0.15);
  color: var(--blue);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 600;
  flex-shrink: 0;
}
.am-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.am-name {
  font-size: 13.5px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.am-state {
  font-size: 11.5px;
}
.am-ops {
  display: flex;
  gap: 8px;
}
.am-btn {
  padding: 5px 14px;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: transparent;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}
.am-btn.ok {
  color: var(--green);
}
.am-btn.ok:hover {
  border-color: var(--green);
  background: rgba(94, 203, 138, 0.1);
}
.am-btn.no {
  color: var(--red);
}
.am-btn.no:hover {
  border-color: var(--red);
  background: rgba(255, 96, 96, 0.1);
}
</style>
