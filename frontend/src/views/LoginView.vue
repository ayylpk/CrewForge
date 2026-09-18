<script setup lang="ts">
/* ============================================================
   登录页 = 领图登记
   ------------------------------------------------------------
   左 60%：蓝晒流水线图版（载入时显影带扫过，一次，之后永远安静）；
   右下角叠真 HTML 标题栏（图号/比例/张数，不用图片带字）。
   右 40%：会签栏式登录表单，回车即提交；失败显示后端返回的提示。
   旧版滚轮两段式撤除——显影就是全页唯一编排动效。
   ============================================================ */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { IconAlertTriangle, IconArrowRight } from '@tabler/icons-vue'
import { useAuthStore } from '../api/auth'

const router = useRouter()
const auth = useAuthStore()

const username = ref('')
const password = ref('')
const loading = ref(false)
const error = ref('')

const revealed = ref(false)
let t = 0
onMounted(() => {
  // 图版显影：留给浏览器先 paint 一帧空版
  t = window.setTimeout(() => (revealed.value = true), 60)
})
onBeforeUnmount(() => clearTimeout(t))

/** 今天日期（标题栏"签发"格，真实数据非装饰） */
const today = computed(() => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
})

/** 登录：调真实接口，成功跳转项目页，失败显示后端返回的提示（行为与旧版一致） */
async function handleLogin() {
  error.value = ''
  loading.value = true
  try {
    await auth.login({ username: username.value, password: password.value })
    router.push('/projects')
  } catch (err) {
    error.value = err instanceof Error ? err.message : '登录失败，请检查用户名和密码'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="gate-entry">
    <!-- ===== 左：蓝晒图版（60%） ===== -->
    <section class="plate" :class="{ revealed }">
      <img class="plate-img" src="../assets/sheet-login-flow.png" alt="CrewForge 软件生产线蓝晒图版" />
      <!-- 显影液带：只扫这一次 -->
      <span class="develop-band" aria-hidden="true"></span>

      <!-- 图版左上角刻字：品牌不落表单，落图版 -->
      <div class="plate-brand">
        <img class="plate-logo" src="../assets/logo-crewforge-cyan.png" alt="" onerror="this.style.display='none'" />
        <h1 class="plate-word">Crew<i>Forge</i></h1>
        <p class="plate-slogan">AI 经理带队 · Agent 团队出图 · 从需求到落盘</p>
      </div>

      <!-- 右下角标题栏（真 HTML 叠图，图内不带字） -->
      <div class="tblock plate-block">
        <div class="tblock-cell">
          <span class="tblock-key">Sheet No.</span>
          <span class="tblock-val mono">PRJ-0000-A</span>
        </div>
        <div class="tblock-cell">
          <span class="tblock-key">Scale</span>
          <span class="tblock-val mono">1:1</span>
        </div>
        <div class="tblock-cell">
          <span class="tblock-key">第</span>
          <span class="tblock-val mono">1 张 / 共 1 张</span>
        </div>
        <div class="tblock-cell">
          <span class="tblock-key">Office</span>
          <span class="tblock-val">晒图室 CrewForge</span>
        </div>
      </div>
    </section>

    <!-- ===== 右：会签栏表单（40%） ===== -->
    <section class="signoff">
      <div class="sign-card">
        <header class="sign-head">
          <span class="sheet-no">FORM·A01 领图登记</span>
          <h2>登录你的 AI 软件团队</h2>
        </header>

        <form class="sign-form" @submit.prevent="handleLogin">
          <label class="field">
            <span class="field-label">账号</span>
            <input v-model="username" class="input" type="text" autocomplete="username" :disabled="loading" />
          </label>
          <label class="field">
            <span class="field-label">密码</span>
            <input v-model="password" class="input" type="password" autocomplete="current-password" :disabled="loading" />
          </label>

          <button class="btn btn-primary sign-btn" type="submit" :disabled="loading">
            {{ loading ? '登录中…' : '进入工作台' }}
            <IconArrowRight v-if="!loading" :size="15" :stroke-width="1.75" />
          </button>

          <p v-if="error" class="sign-error" role="alert">
            <IconAlertTriangle :size="15" :stroke-width="1.75" />
            {{ error }}
          </p>
        </form>

        <footer class="sign-foot">
          <span>签发日期 <b class="mono">{{ today }}</b></span>
          <span>还没有账号？联系你的团队管理员</span>
        </footer>
      </div>
    </section>
  </div>
</template>

<style scoped>
.gate-entry {
  display: grid;
  grid-template-columns: 60% 40%;
  min-height: 100dvh; /* 不用 100vh：移动端地址栏会跳版 */
}

/* ===== 图版 ===== */
.plate {
  position: relative;
  overflow: hidden;
  background: var(--cyan-plate); /* 未显影前：空蓝版 */
}
.plate-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  clip-path: inset(0 100% 0 0);
}
.plate.revealed .plate-img {
  animation: develop 1.2s 0.1s var(--ease) forwards;
}
@keyframes develop {
  to {
    clip-path: inset(0 0% 0 0);
  }
}
/* 显影液带：亮青色竖带从左扫到右，扫完消失 */
.develop-band {
  position: absolute;
  top: 0;
  bottom: 0;
  left: -140px;
  width: 120px;
  background: linear-gradient(90deg, transparent, rgba(159, 198, 232, 0.5), transparent);
  opacity: 0;
  pointer-events: none;
}
.plate.revealed .develop-band {
  animation: band-sweep 1.3s 0.05s var(--ease) forwards;
}
@keyframes band-sweep {
  0% {
    opacity: 1;
    transform: translateX(0);
  }
  100% {
    opacity: 0;
    transform: translateX(calc(100vw * 0.6 + 140px));
  }
}

.plate-brand {
  position: absolute;
  top: 36px;
  left: 40px;
  z-index: 2;
  color: #dbe9f5;
}
.plate-logo {
  width: 34px;
  height: 34px;
  object-fit: contain;
}
.plate-word {
  font-family: var(--font-display);
  font-size: 40px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: #eaf3fa;
  line-height: 1.15;
}
.plate-word i {
  font-style: normal;
  color: #9fc6e8;
}
.plate-slogan {
  margin-top: 6px;
  font-size: var(--fs-meta);
  letter-spacing: 0.1em;
  color: rgba(219, 233, 245, 0.8);
}

.plate-block {
  position: absolute;
  right: 24px;
  bottom: 24px;
  z-index: 2;
  background: rgba(243, 246, 248, 0.94); /* 硫酸纸标题栏贴在图版上 */
  border-color: var(--cyan);
}
.plate-block .tblock-val {
  font-size: var(--fs-meta);
}
@media (max-width: 480px) {
  /* abs 只挂 right 时宽度按内容走，四格顶出图版被裁；钉死左右让 atom 的 2×2 折行生效 */
  .plate-block {
    left: 24px;
    right: 24px;
  }
}

/* ===== 会签栏 ===== */
.signoff {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px 44px;
  background: var(--paper);
}
.sign-card {
  width: 100%;
  max-width: 360px;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line-2);
  border-radius: var(--r);
  background: var(--paper-raised);
}
.sign-head {
  padding: 22px 26px 18px;
  border-bottom: 1px dashed var(--line-2); /* 会签栏骑缝虚线 */
}
.sign-head h2 {
  margin-top: 6px;
  font-size: var(--fs-h1);
  font-weight: 700;
  line-height: 1.3;
}
.sign-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 22px 26px;
}
.sign-btn {
  margin-top: 4px;
  height: 44px;
}
.sign-error {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: var(--fs-meta);
  color: var(--void-ink);
}
.sign-foot {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 26px 18px;
  border-top: 1px solid var(--line);
  font-size: var(--fs-meta);
  color: var(--ink-3);
}
.sign-foot b {
  color: var(--ink-2);
  font-weight: 600;
}

/* ===== 窄屏：图版退为顶部横条 ===== */
@media (max-width: 900px) {
  .gate-entry {
    grid-template-columns: 1fr;
    grid-template-rows: 34vh 1fr;
  }
  .plate-block {
    right: 14px;
    bottom: 14px;
  }
  .plate-word {
    font-size: 30px;
  }
  .plate-brand {
    top: 20px;
    left: 20px;
  }
  .signoff {
    padding: 28px 20px 44px;
  }
  @keyframes band-sweep {
    0% {
      opacity: 1;
      transform: translateX(0);
    }
    100% {
      opacity: 0;
      transform: translateX(calc(100vw + 140px));
    }
  }
}
</style>
