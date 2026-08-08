<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '../api/auth'

const router = useRouter()

const phase = ref<'intro' | 'auth'>('intro')
const username = ref('')
const password = ref('')
const loading = ref(false)
const error = ref('')
const auth = useAuthStore()

/** 进入登录阶段：品牌区压缩成标题，表单居中 */
function enter() {
    phase.value = 'auth'
}

/** 滚轮：intro 下滑进入 auth；auth 上滑回到 intro */
function onWheel(e: WheelEvent) {
    if (phase.value === 'intro' && e.deltaY > 30) {
        enter()
    } else if (phase.value === 'auth' && e.deltaY < -30) {
        back()
    }
}

/** 返回品牌区 */
function back() {
    phase.value = 'intro'
}

onMounted(() => {
    window.addEventListener('wheel', onWheel, { passive: true })
})
onBeforeUnmount(() => {
    window.removeEventListener('wheel', onWheel)
})

/** 登录：调真实接口，成功跳转项目页，失败显示后端返回的提示 */
async function handleLogin() {
    error.value = '';
    loading.value = true;
    try{
        await auth.login({ username: username.value, password: password.value })
        // 新会话从个人空间开始，清掉上次的团队上下文（X-Tenant-Id）
        localStorage.removeItem('cf_active_tenant')
        router.push('/projects')
    }catch(err){
      error.value = err instanceof Error ? err.message : '登录失败，请检查用户名和密码'
    }finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="login">
    <!-- 全屏背景 -->
    <img class="bg" src="../assets/bg-login.png" alt="" />
    <div class="bg-overlay"></div>

    <!-- 品牌区（intro 全屏居中 → auth 缩小到左上角） -->
    <div class="brand" :class="{ compact: phase === 'auth' }">
      <div class="brand-inner">
        <div class="brand-logo">
          <img src="../assets/logo-crewforge.png" alt="CrewForge" />
        </div>
        <h1 class="brand-title" :class="{ hide: phase === 'auth' }">
          Crew<span class="grad">Forge</span>
        </h1>
        <p class="brand-slogan" :class="{ hide: phase === 'auth' }">
          AI 经理带队 · Agent 团队交付
        </p>
        <p class="brand-sub" :class="{ hide: phase === 'auth' }">
          从需求到运行，全流程自动化
        </p>
      </div>
    </div>

    <!-- 下滑提示 -->
    <transition name="fade">
      <div v-if="phase === 'intro'" class="scroll-hint" @click="enter">
        <span>进入工作台</span>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 5v14M19 12l-7 7-7-7" />
        </svg>
      </div>
    </transition>

    <!-- 登录表单 -->
    <transition name="form">
      <div v-if="phase === 'auth'" class="form-side">
        <div class="form-card">
          <!-- 装饰光环（几何线条风格） -->
          <div class="halo-deco">
            <svg viewBox="0 0 64 64" width="64" height="64" fill="none">
              <circle cx="32" cy="32" r="30" stroke="url(#haloGrad)" stroke-width="1.5" />
              <circle cx="32" cy="32" r="22" stroke="url(#haloGrad)" stroke-width="1" stroke-dasharray="4 6" />
              <circle cx="32" cy="32" r="3" fill="url(#haloGrad)" />
              <defs>
                <linearGradient id="haloGrad" x1="0" y1="0" x2="64" y2="64">
                  <stop offset="0%" stop-color="#45b8ff" />
                  <stop offset="100%" stop-color="#a76bff" />
                </linearGradient>
              </defs>
            </svg>
          </div>

          <h2>欢迎回来</h2>
          <p class="form-tip">登录你的 AI 软件团队</p>

          <div class="field">
            <svg class="field-icon" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
            <input
              v-model="username"
              type="text"
              placeholder="账号"
              @keyup.enter="handleLogin"
            />
          </div>

          <div class="field">
            <svg class="field-icon" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            <input
              v-model="password"
              type="password"
              placeholder="密码"
              @keyup.enter="handleLogin"
            />
          </div>

          <button class="btn-login" :disabled="loading" @click="handleLogin">
            <span v-if="loading" class="spinner"></span>
            <span>{{ loading ? '登录中...' : '登 录' }}</span>
          </button>

          <p v-if="error" class="error-msg">⚠ {{ error }}</p>

          <p class="form-footer">还没有账号？请联系你的团队管理员</p>
        </div>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.login {
    position: relative;
    display: flex;
    width: 100%;
    height: 100%;
    overflow: hidden;
}

/* ===== 全屏背景 ===== */
.bg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    z-index: 0;
}
.bg-overlay {
    position: absolute;
    inset: 0;
    background: linear-gradient(90deg, rgba(8, 11, 17, 0.88) 0%, rgba(8, 11, 17, 0.55) 55%, rgba(8, 11, 17, 0.35) 100%);
    z-index: 1;
}

/* ===== 品牌区 ===== */
.brand {
    position: absolute;
    inset: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.7s cubic-bezier(0.4, 0, 0.2, 1);
}
/* auth 阶段：缩小并移到左上角 */
.brand.compact {
    align-items: flex-start;
    justify-content: flex-start;
    padding: 28px 40px;
}
.brand-inner {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    transition: all 0.7s cubic-bezier(0.4, 0, 0.2, 1);
}
.brand.compact .brand-inner {
    flex-direction: row;
    align-items: center;
    gap: 10px;
}
.brand-logo img {
    width: 88px;
    height: 88px;
    border-radius: 22px;
    box-shadow: 0 0 40px rgba(69, 184, 255, 0.35);
    transition: all 0.7s cubic-bezier(0.4, 0, 0.2, 1);
}
.brand.compact .brand-logo img {
    width: 34px;
    height: 34px;
    border-radius: 9px;
    box-shadow: none;
}
.brand-title {
    font-size: 42px;
    font-weight: 800;
    letter-spacing: -0.02em;
    color: #fff;
    margin-top: 8px;
    transition: all 0.7s cubic-bezier(0.4, 0, 0.2, 1);
}
.brand.compact .brand-title {
    font-size: 22px;
    margin-top: 0;
}
.grad {
  background: linear-gradient(135deg, #45b8ff, #a76bff);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}
.brand-slogan {
  font-size: 20px;
  font-weight: 600;
  color: #c8d0e0;
  transition: all 0.4s ease;
}
.brand-sub {
  font-size: 14px;
  color: #8890a8;
  letter-spacing: 0.08em;
  transition: all 0.4s ease;
}
/* 缩小后隐藏副文案 */
.hide {
  opacity: 0;
  transform: translateY(-8px);
}

/* ===== 下滑提示 ===== */
.scroll-hint {
  position: absolute;
  left: 50%;
  bottom: 44px;
  transform: translateX(-50%);
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 8px;
  color: #8890a8;
  font-size: 13px;
  letter-spacing: 0.12em;
  cursor: pointer;
  animation: hint-bounce 2s ease-in-out infinite;
  transition: color 0.2s;
}
.scroll-hint:hover {
  color: #45b8ff;
}
.scroll-hint svg {
  animation: arrow-down 2s ease-in-out infinite;
}
@keyframes hint-bounce {
  0%, 100% { transform: translateX(-50%) translateY(0); }
  50% { transform: translateX(-50%) translateY(6px); }
}
@keyframes arrow-down {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(4px); }
}
.fade-enter-active, .fade-leave-active {
  transition: opacity 0.4s;
}
.fade-enter-from, .fade-leave-to {
  opacity: 0;
}

/* ===== 登录表单 ===== */
.form-side {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
}
.form-card {
  width: 320px;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 36px 32px;
  border-radius: 16px;
  background: rgba(15, 19, 31, 0.5);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border: 1px solid rgba(37, 43, 61, 0.45);
}
/* 表单进入/离开动画 */
.form-enter-active {
  transition: opacity 0.6s ease 0.2s, transform 0.6s cubic-bezier(0.4, 0, 0.2, 1) 0.2s;
}
.form-enter-from {
  opacity: 0;
  transform: translateY(24px) scale(0.96);
}
.form-leave-active {
  transition: opacity 0.4s ease, transform 0.4s ease;
}
.form-leave-to {
  opacity: 0;
  transform: translateY(16px) scale(0.97);
}

.halo-deco {
  margin-bottom: 20px;
  opacity: 0.9;
}
.form-card h2 {
  font-size: 24px;
  font-weight: 700;
  color: #c8d0e0;
}
.form-tip {
  font-size: 13px;
  color: #8890a8;
  margin: 8px 0 32px;
}

/* 输入框 */
.field {
  position: relative;
  width: 100%;
  margin-bottom: 16px;
}
.field-icon {
  position: absolute;
  left: 14px;
  top: 50%;
  transform: translateY(-50%);
  color: #5c6378;
  pointer-events: none;
  transition: color 0.2s;
}
.field:focus-within .field-icon {
  color: #45b8ff;
}
.field input {
  width: 100%;
  height: 46px;
  padding: 0 14px 0 42px;
  border-radius: 10px;
  border: 1px solid #252b3d;
  background: rgba(20, 25, 38, 0.8);
  color: #c8d0e0;
  font-size: 14px;
  outline: none;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.field input::placeholder {
  color: #5c6378;
}
.field input:focus {
  border-color: #45b8ff;
  box-shadow: 0 0 0 3px rgba(69, 184, 255, 0.15);
}

/* 登录按钮 */
.btn-login {
  width: 100%;
  height: 46px;
  border: none;
  border-radius: 10px;
  background: linear-gradient(135deg, #45b8ff, #a76bff);
  color: #fff;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  transition: opacity 0.2s, transform 0.1s;
}
.btn-login:hover:not(:disabled) {
  opacity: 0.9;
}
.btn-login:active:not(:disabled) {
  transform: translateY(1px);
}
.btn-login:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.error-msg {
  margin-top: 14px;
  font-size: 13px;
  color: #f26060;
}
.form-footer {
  margin-top: 28px;
  font-size: 12px;
  color: #5c6378;
}
</style>
