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
      <div class="content">
      <!-- 页头 -->
      <div class="page-head">
        <h1>团队</h1>
        <GradientButton @click="openCreateModal">+ 创建团队</GradientButton>
      </div>

      <!-- 团队列表（真实数据） -->
      <div v-if="loadingTeams && teams.length === 0" class="team-empty">加载中...</div>
      <div v-else-if="teams.length === 0" class="team-empty">
        <p>还没有加入任何团队</p>
        <p class="team-empty-sub">点击右上角"创建团队"，或用邀请码加入他人的团队</p>
      </div>
      <div v-else class="team-grid">
        <CardShell
          v-for="t in teams"
          :key="t.id"
          hoverable
          class="team-card"
          :class="{ selected: activeTeam?.id === t.id }"
          @click="selectTeam(t)"
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
            <!-- 管理员操作（hover 显示） -->
            <div v-if="t.role === '我是 · 管理员'" class="team-ops">
              <button class="op-btn" title="编辑团队" @click.stop="openEditModal(t)">✎</button>
              <button class="op-btn del" title="解散团队" @click.stop="removeTeam(t)">✕</button>
            </div>
            <span class="team-enter">进入 →</span>
          </div>
          <div class="team-stats">
            <div class="ts-item">
              <span class="ts-num">{{ t.members }}<em class="ts-sub">/{{ t.maxMembers }}</em></span>
              <span class="ts-label">成员</span>
            </div>
            <div class="ts-item">
              <span class="ts-num">{{ t.projects }}</span>
              <span class="ts-label">项目</span>
            </div>
          </div>
        </CardShell>
      </div>

      <!-- 团队详情（选中团队后显示） -->
      <template v-if="activeTeam">
        <div class="detail-head">
          <h2>{{ activeTeam.name }}</h2>
          <span class="detail-hint">{{ activeTeam.role }}</span>
        </div>

        <div class="grid-2">
          <!-- 成员 -->
          <CardShell class="card">
            <div class="card-head">
              <h3 class="card-title">成员</h3>
              <button class="btn-disabled small">+ 邀请</button>
            </div>
            <div class="member-empty">
              成员列表开发中 · 当前 {{ activeTeam.members }} / {{ activeTeam.maxMembers }} 人
            </div>
          </CardShell>

          <!-- 团队项目 -->
          <CardShell class="card">
            <div class="card-head">
              <h3 class="card-title">团队项目</h3>
              <button class="btn-disabled small">+ 新建项目</button>
            </div>
            <div v-if="teamProjectsLoading" class="member-empty">加载中...</div>
            <div v-else-if="teamProjects.length === 0" class="member-empty">还没有团队项目</div>
            <div v-else class="proj-list">
              <div v-for="p in teamProjects" :key="p.id" class="proj-item" @click="openProject(p.id)">
                <span class="proj-ico" :style="{ background: projGrad(p.status) }">
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="3" />
                    <path d="M3 9h18M9 21V9" />
                  </svg>
                </span>
                <span class="proj-name">{{ p.name }}</span>
                <span class="proj-state" :style="{ color: STATUS_COLOR[p.status] }">
                  <span class="dot" :style="{ background: STATUS_COLOR[p.status] }"></span>{{ STATUS_LABEL[p.status] }}
                </span>
              </div>
            </div>
          </CardShell>
        </div>
      </template>
      </div>
    </main>

    <!-- 创建/编辑团队弹窗（屏幕 2/3，居中） -->
    <div v-if="showCreateModal" class="create-mask" @click.self="closeCreateModal">
      <div class="create-modal">
        <div class="cm-head">
          <h2>{{ editingTeam ? '编辑团队' : '创建团队' }}</h2>
          <button class="cm-close" title="关闭" @click="closeCreateModal">✕</button>
        </div>
        <p class="cm-desc">{{ editingTeam ? '修改团队信息后保存，成员和项目不受影响' : '团队是独立的工作空间，创建后凭邀请码邀请成员加入' }}</p>

        <div class="cm-body">
          <!-- 左侧：默认头像 + 基本信息 -->
          <div class="cm-left">
            <div class="cm-avatar" title="团队头像（暂为默认）">
              <svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
            </div>
            <label class="cm-field">
              <span class="cm-label">团队名称 <em>*</em></span>
              <input v-model="createForm.name" class="cm-input" type="text" placeholder="如：后端开发组" maxlength="30" @keyup.enter="doSave" />
            </label>
            <label class="cm-field">
              <span class="cm-label">联系人</span>
              <input v-model="createForm.contact" class="cm-input" type="text" placeholder="团队联系人姓名（可选）" maxlength="20" @keyup.enter="doSave" />
            </label>
            <label class="cm-field">
              <span class="cm-label">团队人数 <em>*</em></span>
              <input v-model.number="createForm.maxMembers" class="cm-input" type="number" min="1" max="100" placeholder="团队容量上限，默认 10" @keyup.enter="doSave" />
            </label>
          </div>
          <!-- 右侧：团队描述 -->
          <div class="cm-right">
            <label class="cm-field">
              <span class="cm-label">团队描述</span>
              <textarea v-model="createForm.description" class="cm-textarea" placeholder="介绍一下这个团队是做什么的（可选）" maxlength="500"></textarea>
            </label>
          </div>
        </div>

        <div class="cm-actions">
          <button class="btn-cancel" :disabled="creating" @click="closeCreateModal">取消</button>
          <button class="btn-create" :disabled="creating" @click="doSave">
            {{ creating ? '保存中...' : editingTeam ? '保存修改' : '创建团队' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import CardShell from '../components/CardShell.vue'
import GradientButton from '../components/GradientButton.vue'
import WorkspaceSwitcher from '../components/WorkspaceSwitcher.vue'
import { createTenant, fetchTenantById, fetchMyTeams, updateTenant, deleteTenant, type TenantVO } from '../api/tenant'
import { fetchTeamProjects } from '../api/project'

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

// ===== 我的团队（真实数据，来自 GET /api/tenant） =====
interface Team {
  id: number
  name: string
  role: string
  color: string
  grad: string
  members: number
  maxMembers: number
  projects: number
}

const teams = ref<Team[]>([])
const loadingTeams = ref(false)
const activeTeam = ref<Team | null>(null)

/** 我的角色：owner = 管理员，否则成员 */
function myRole(t: TenantVO): string {
  const raw = localStorage.getItem('cf_user_info')
  const myId = raw ? (JSON.parse(raw) as { userId: number }).userId : 0
  return t.ownerId === myId ? '我是 · 管理员' : '我是 · 成员'
}

/** 卡片配色：管理员绿 / 成员黄 */
function teamStyle(role: string): { color: string; grad: string } {
  if (role === '我是 · 管理员') {
    return { color: '#5ecb8a', grad: 'linear-gradient(135deg,#5ecb8a,#5ec8c0)' }
  }
  return { color: '#f0c060', grad: 'linear-gradient(135deg,#f0c060,#f09050)' }
}

async function loadTeams() {
  loadingTeams.value = true
  try {
    const { records } = await fetchMyTeams()
    teams.value = records.map((t) => {
      const role = myRole(t)
      const s = teamStyle(role)
      return {
        id: t.id,
        name: t.name,
        role,
        color: s.color,
        grad: s.grad,
        members: t.members,
        maxMembers: t.maxMembers,
        projects: t.projectCount ?? 0,
      }
    })
    // 选中的团队被删/刷新后，重置选中
    if (activeTeam.value && !teams.value.some((t) => t.id === activeTeam.value!.id)) {
      activeTeam.value = null
    }
  } catch {
    /* 拦截器已提示 */
  } finally {
    loadingTeams.value = false
  }
}

onMounted(loadTeams)

// ===== 团队详情（项目列表） =====
const teamProjects = ref<{ id: number; name: string; status: string }[]>([])
const teamProjectsLoading = ref(false)

/** 项目状态颜色（与 ProjectsView 一致） */
const STATUS_COLOR: Record<string, string> = {
  draft: '#8a94a6',
  clarifying: '#f0c060',
  planning: '#45b8ff',
  executing: '#5ecb8a',
  paused: '#f09050',
  done: '#a76bff',
  failed: '#ff6b6b',
}
const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  clarifying: '澄清中',
  planning: '规划中',
  executing: '执行中',
  paused: '已暂停',
  done: '已完成',
  failed: '失败',
}

function projGrad(status: string): string {
  const map: Record<string, string> = {
    draft: 'linear-gradient(135deg,#8a94a6,#a7b0c0)',
    clarifying: 'linear-gradient(135deg,#f0c060,#f09050)',
    planning: 'linear-gradient(135deg,#45b8ff,#a76bff)',
    executing: 'linear-gradient(135deg,#5ecb8a,#5ec8c0)',
    paused: 'linear-gradient(135deg,#f09050,#f070a0)',
    done: 'linear-gradient(135deg,#a76bff,#f070a0)',
    failed: 'linear-gradient(135deg,#ff6b6b,#f09050)',
  }
  return map[status] || 'linear-gradient(135deg,#45b8ff,#a76bff)'
}

function selectTeam(t: Team) {
  activeTeam.value = t
  loadTeamProjects(t.id)
}

async function loadTeamProjects(tenantId: number) {
  teamProjectsLoading.value = true
  try {
    const { records } = await fetchTeamProjects(tenantId)
    teamProjects.value = records.map((p) => ({ id: p.id, name: p.name, status: p.status }))
  } catch {
    teamProjects.value = []
  } finally {
    teamProjectsLoading.value = false
  }
}

function openProject(id: number) {
  router.push(`/projects/${id}`)
}

// ===== 创建 / 编辑团队 =====
const showCreateModal = ref(false)
const creating = ref(false)
const editingTeam = ref<Team | null>(null)
const createForm = ref({ name: '', contact: '', maxMembers: 10, description: '' })

function openCreateModal() {
  editingTeam.value = null
  createForm.value = { name: '', contact: '', maxMembers: 10, description: '' }
  showCreateModal.value = true
}

async function openEditModal(t: Team) {
  editingTeam.value = t
  createForm.value = { name: '', contact: '', maxMembers: 10, description: '' }
  showCreateModal.value = true
  // 回显完整信息（contact/description 卡片上没有，从后端取）
  try {
    const full = await fetchTenantById(t.id)
    createForm.value = {
      name: full.name || '',
      contact: full.contact || '',
      maxMembers: full.maxMembers || 10,
      description: full.description || '',
    }
  } catch {
    /* 拦截器已提示 */
  }
}

function closeCreateModal() {
  if (!creating.value) showCreateModal.value = false
}

async function doSave() {
  const name = createForm.value.name.trim()
  if (!name) {
    ElMessage.warning('请填写团队名称')
    return
  }
  const maxMembers = createForm.value.maxMembers || 10
  if (maxMembers < 1) {
    ElMessage.warning('团队人数至少为 1')
    return
  }
  const payload = {
    name,
    contact: createForm.value.contact.trim() || undefined,
    description: createForm.value.description.trim() || undefined,
    maxMembers,
  }
  creating.value = true
  try {
    let keepId: number | null = null
    if (editingTeam.value) {
      // 编辑模式：PUT 更新后保持选中
      keepId = editingTeam.value.id
      await updateTenant(keepId, payload)
      showCreateModal.value = false
      ElMessage.success(`团队「${name}」已更新`)
    } else {
      // 创建模式：POST + 回查邀请码
      const id = await createTenant(payload)
      const t = await fetchTenantById(id)
      keepId = id
      showCreateModal.value = false
      await ElMessageBox.alert(`邀请码：${t.invitationCode}`, `团队「${t.name}」创建成功`, {
        confirmButtonText: '知道了',
      })
    }
    // 刷新列表并保持选中
    await loadTeams()
    activeTeam.value = teams.value.find((x) => x.id === keepId) ?? null
  } catch {
    /* 拦截器已提示 */
  } finally {
    creating.value = false
  }
}

// ===== 解散团队（仅管理员） =====
async function removeTeam(t: Team) {
  try {
    await ElMessageBox.confirm(`确定解散团队「${t.name}」吗？解散后团队及其项目不再显示`, '解散团队', {
      confirmButtonText: '解散',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    return // 用户取消
  }
  try {
    await deleteTenant(t.id)
    ElMessage.success(`团队「${t.name}」已解散`)
    await loadTeams()
  } catch {
    /* 拦截器已提示 */
  }
}

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
  padding: 32px 48px 60px;
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
.team-empty {
  padding: 48px 0;
  text-align: center;
  color: var(--text3);
  font-size: 14px;
}
.team-empty-sub {
  margin-top: 8px;
  font-size: 12.5px;
  color: var(--text3);
  opacity: 0.8;
}
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
  white-space: nowrap;
}
.team-card:hover .team-enter {
  opacity: 1;
  transform: translateX(0);
}
/* 管理员操作按钮（hover 显示） */
.team-ops {
  display: flex;
  gap: 6px;
}
.op-btn {
  width: 26px;
  height: 26px;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: var(--bg3);
  color: var(--text3);
  font-size: 12px;
  cursor: pointer;
  opacity: 0;
  transition: all 0.2s;
}
.team-card:hover .op-btn {
  opacity: 1;
}
.op-btn:hover {
  border-color: var(--blue);
  color: var(--blue);
}
.op-btn.del:hover {
  border-color: var(--red);
  color: var(--red);
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
.ts-sub {
  font-size: 11px;
  font-weight: 400;
  color: var(--text3);
  font-style: normal;
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

/* 成员（占位，成员列表接口开发中） */
.member-empty {
  padding: 28px 0;
  text-align: center;
  color: var(--text3);
  font-size: 13px;
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
  cursor: pointer;
  transition: all 0.2s;
}
.proj-item:hover {
  background: var(--bg4);
  border-color: var(--border2);
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

/* ===== 创建团队弹窗 ===== */
.create-mask {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(8, 11, 17, 0.7);
  backdrop-filter: blur(4px);
}
.create-modal {
  width: 66.67vw; /* 屏幕 2/3 */
  height: 66.67vh; /* 屏幕 2/3 */
  box-sizing: border-box;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 32px 40px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
}
.cm-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.cm-head h2 {
  font-size: 18px;
  font-weight: 700;
}
.cm-close {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text3);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
}
.cm-close:hover {
  border-color: var(--red);
  color: var(--red);
}
.cm-desc {
  margin-top: 6px;
  font-size: 12.5px;
  color: var(--text3);
}
.cm-body {
  flex: 1;
  display: flex;
  gap: 40px;
  align-items: stretch;
  justify-content: center;
  padding-top: 12px;
}
/* 左侧：头像 + 基本信息 */
.cm-left {
  flex: 1;
  max-width: 360px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 18px;
}
.cm-avatar {
  width: 96px;
  height: 96px;
  border-radius: 24px;
  background: linear-gradient(135deg, #45b8ff, #a76bff);
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto 6px;
  box-shadow: 0 10px 28px rgba(69, 184, 255, 0.25);
}
/* 右侧：团队描述 */
.cm-right {
  flex: 1;
  max-width: 480px;
  display: flex;
  flex-direction: column;
}
.cm-right .cm-field {
  flex: 1;
  display: flex;
  flex-direction: column;
}
.cm-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.cm-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text2);
}
.cm-label em {
  color: var(--red);
  font-style: normal;
}
.cm-input {
  height: 44px;
  padding: 0 14px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--bg3);
  color: var(--text);
  font-size: 14px;
  outline: none;
  transition: border-color 0.2s;
}
.cm-input:focus {
  border-color: var(--blue);
}
.cm-input::placeholder {
  color: var(--text3);
}
.cm-textarea {
  flex: 1;
  min-height: 200px;
  resize: none;
  padding: 14px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--bg3);
  color: var(--text);
  font-size: 14px;
  line-height: 1.7;
  outline: none;
  transition: border-color 0.2s;
}
.cm-textarea:focus {
  border-color: var(--blue);
}
.cm-textarea::placeholder {
  color: var(--text3);
}
.cm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}
.btn-cancel {
  padding: 9px 22px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text2);
  font-size: 14px;
  cursor: pointer;
  transition: all 0.2s;
}
.btn-cancel:hover:not(:disabled) {
  border-color: var(--text2);
  color: var(--text);
}
.btn-cancel:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn-create {
  padding: 9px 22px;
  border-radius: 9px;
  border: none;
  background: var(--grad1);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.2s;
}
.btn-create:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
