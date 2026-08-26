<template>
  <Teleport to="body">
    <!-- 全局确认弹窗：任意页面可见，点击跳转执行页 -->
    <Transition name="confirm-fade">
      <div v-if="store.hasPendingConfirm" class="global-confirm-overlay" @click.self="dismiss">
        <div class="global-confirm-card">
          <!-- 头部 -->
          <div class="confirm-head">
            <span class="confirm-badge">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              待确认
            </span>
            <button class="confirm-close" @click="dismiss">✕</button>
          </div>

          <!-- 标题 -->
          <div class="confirm-title">{{ store.pendingConfirm?.title }}</div>

          <!-- 消息内容 -->
          <div class="confirm-message">{{ store.pendingConfirm?.message }}</div>

          <!-- 操作按钮 -->
          <div class="confirm-actions">
            <button class="btn-jump" @click="jumpToExecution">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M5 12h14M12 5l7 7-7 7" />
              </svg>
              跳转执行页
            </button>
            <div class="action-group">
              <button class="btn-reject" @click="reject">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
                拒绝
              </button>
              <button class="btn-confirm" @click="confirm">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                确认
              </button>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useExecutionStore } from '../stores/execution'

const router = useRouter()
const store = useExecutionStore()

function dismiss() {
  store.resolveConfirm()
}

function jumpToExecution() {
  if (store.pendingConfirm) {
    router.push(`/projects/${store.pendingConfirm.projectId}/execution`)
  }
  dismiss()
}

function confirm() {
  // 确认：后续接入 WebSocket 时发送 answer="y" 给后端
  console.log('[GlobalConfirm] 确认:', store.pendingConfirm?.id)
  dismiss()
}

function reject() {
  // 拒绝：后续接入 WebSocket 时发送 answer="n" 给后端
  console.log('[GlobalConfirm] 拒绝:', store.pendingConfirm?.id)
  dismiss()
}
</script>

<style scoped>
/* ===== 浮层遮罩 ===== */
.global-confirm-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(4px);
}

/* ===== 卡片 ===== */
.global-confirm-card {
  width: 420px;
  max-width: 90vw;
  background: var(--bg2, #1a1e2e);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
  border-radius: 14px;
  padding: 24px;
  box-shadow: 0 12px 48px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(69, 184, 255, 0.15);
  animation: card-in 0.25s ease;
}

@keyframes card-in {
  from { opacity: 0; transform: scale(0.92) translateY(12px); }
  to { opacity: 1; transform: scale(1) translateY(0); }
}

/* ===== 头部 ===== */
.confirm-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.confirm-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border-radius: 20px;
  background: rgba(242, 184, 64, 0.12);
  border: 1px solid rgba(242, 184, 64, 0.25);
  color: #f2b840;
  font-size: 11.5px;
  font-weight: 600;
}
.confirm-close {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text3, #667);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  transition: all 0.15s;
}
.confirm-close:hover {
  background: rgba(242, 96, 96, 0.15);
  color: var(--red, #f26060);
}

/* ===== 标题 ===== */
.confirm-title {
  font-size: 16px;
  font-weight: 700;
  color: var(--text, #e6e6e6);
  margin-bottom: 10px;
  line-height: 1.4;
}

/* ===== 消息 ===== */
.confirm-message {
  font-size: 13px;
  line-height: 1.7;
  color: var(--text2, #9aa);
  margin-bottom: 22px;
  white-space: pre-line;
  word-break: break-word;
}

/* ===== 操作按钮 ===== */
.confirm-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.btn-jump {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border-radius: 8px;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
  background: transparent;
  color: var(--text2, #9aa);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.15s;
}
.btn-jump:hover {
  border-color: var(--blue, #45b8ff);
  color: var(--blue, #45b8ff);
}

.action-group {
  display: flex;
  gap: 8px;
}
.btn-reject, .btn-confirm {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 18px;
  border-radius: 8px;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
}
.btn-reject {
  background: transparent;
  color: var(--text2, #9aa);
}
.btn-reject:hover {
  border-color: var(--red, #f26060);
  color: var(--red, #f26060);
  background: rgba(242, 96, 96, 0.08);
}
.btn-confirm {
  background: var(--grad1, linear-gradient(135deg, #2563eb, #7c3aed));
  color: #fff;
  border: none;
}
.btn-confirm:hover {
  opacity: 0.9;
}

/* ===== 过渡动画 ===== */
.confirm-fade-enter-active,
.confirm-fade-leave-active {
  transition: opacity 0.2s ease;
}
.confirm-fade-enter-from,
.confirm-fade-leave-to {
  opacity: 0;
}
.confirm-fade-enter-active .global-confirm-card,
.confirm-fade-leave-active .global-confirm-card {
  transition: transform 0.2s ease;
}
.confirm-fade-enter-from .global-confirm-card {
  transform: scale(0.92) translateY(12px);
}
.confirm-fade-leave-to .global-confirm-card {
  transform: scale(0.92) translateY(12px);
}
</style>