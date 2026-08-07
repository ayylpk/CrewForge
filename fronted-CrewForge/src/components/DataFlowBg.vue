<template>
  <div class="dataflow-bg">
    <!-- 点阵 -->
    <div class="dots-matrix"></div>

    <!-- 蜿蜒数据流光带（静态） -->
    <svg class="flow-lines" viewBox="0 0 1440 420" preserveAspectRatio="none">
      <defs>
        <linearGradient id="flowGrad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#45b8ff" stop-opacity="0" />
          <stop offset="35%" stop-color="#45b8ff" stop-opacity="0.55" />
          <stop offset="65%" stop-color="#a76bff" stop-opacity="0.4" />
          <stop offset="100%" stop-color="#a76bff" stop-opacity="0" />
        </linearGradient>
        <linearGradient id="flowGrad2" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#45b8ff" stop-opacity="0" />
          <stop offset="50%" stop-color="#5ec8c0" stop-opacity="0.35" />
          <stop offset="100%" stop-color="#45b8ff" stop-opacity="0" />
        </linearGradient>
      </defs>

      <!-- 主光带（光晕） -->
      <path d="M0,190 C180,120 420,270 720,200 C1000,135 1230,290 1440,150"
            fill="none" stroke="url(#flowGrad)" stroke-width="16" stroke-linecap="round" opacity="0.12" />
      <!-- 主光带（细线） -->
      <path d="M0,190 C180,120 420,270 720,200 C1000,135 1230,290 1440,150"
            fill="none" stroke="url(#flowGrad)" stroke-width="2" stroke-linecap="round" />
      <!-- 光带上的高光段 -->
      <path d="M420,270 C560,240 640,220 720,200"
            fill="none" stroke="#9fe8ff" stroke-width="1.2" stroke-linecap="round" opacity="0.7" />

      <!-- 沿光带的流动光点 -->
      <circle cx="180" cy="130" r="2" fill="#9fe8ff" opacity="0.8" />
      <circle cx="430" cy="265" r="2.5" fill="#a76bff" opacity="0.8" />
      <circle cx="600" cy="230" r="1.8" fill="#9fe8ff" opacity="0.7" />
      <circle cx="820" cy="172" r="2" fill="#45b8ff" opacity="0.8" />
      <circle cx="1010" cy="185" r="2.5" fill="#a76bff" opacity="0.7" />
      <circle cx="1180" cy="250" r="1.8" fill="#9fe8ff" opacity="0.7" />

      <!-- 第二道光带（底部，青蓝） -->
      <path d="M0,360 C260,400 560,320 880,360 C1100,388 1280,330 1440,368"
            fill="none" stroke="url(#flowGrad2)" stroke-width="1.5" stroke-linecap="round" opacity="0.5" />
      <circle cx="260" cy="395" r="1.8" fill="#5ec8c0" opacity="0.7" />
      <circle cx="560" cy="325" r="2" fill="#5ec8c0" opacity="0.6" />
      <circle cx="1100" cy="380" r="1.8" fill="#9fe8ff" opacity="0.6" />
    </svg>

    <!-- 底部网格纹理 + 节点 + 地平线辉光 -->
    <div class="grid-floor"></div>
    <div class="floor-line"></div>
    <span class="dot node" style="left: 12%; top: 82%; width: 2.5px; opacity: 0.5"></span>
    <span class="dot node" style="left: 28%; top: 87%; width: 2px; opacity: 0.4"></span>
    <span class="dot node breathe" style="left: 41%; top: 84%; width: 3px; opacity: 0.55; animation-delay: 0.5s"></span>
    <span class="dot node" style="left: 56%; top: 88%; width: 2px; opacity: 0.4"></span>
    <span class="dot node breathe" style="left: 66%; top: 83%; width: 2.5px; opacity: 0.5; animation-delay: 1.9s"></span>
    <span class="dot node" style="left: 79%; top: 86%; width: 2px; opacity: 0.45"></span>
    <span class="dot node breathe" style="left: 90%; top: 84%; width: 2.5px; opacity: 0.5; animation-delay: 3.2s"></span>

    <!-- 光点（沿光带散布，部分带极慢呼吸） -->
    <span class="dot breathe" style="left: 18%; top: 34%; width: 3px; opacity: 0.7; animation-delay: 0s"></span>
    <span class="dot" style="left: 26%; top: 40%; width: 2px; opacity: 0.5"></span>
    <span class="dot breathe" style="left: 35%; top: 62%; width: 2.5px; opacity: 0.6; animation-delay: 1.2s"></span>
    <span class="dot" style="left: 44%; top: 47%; width: 2px; opacity: 0.45"></span>
    <span class="dot breathe" style="left: 52%; top: 33%; width: 3px; opacity: 0.7; animation-delay: 2.1s"></span>
    <span class="dot" style="left: 61%; top: 52%; width: 2px; opacity: 0.5"></span>
    <span class="dot breathe" style="left: 68%; top: 38%; width: 2.5px; opacity: 0.6; animation-delay: 0.8s"></span>
    <span class="dot" style="left: 76%; top: 55%; width: 2px; opacity: 0.45"></span>
    <span class="dot breathe" style="left: 84%; top: 32%; width: 2.5px; opacity: 0.65; animation-delay: 1.7s"></span>
    <span class="dot" style="left: 91%; top: 44%; width: 2px; opacity: 0.5"></span>
    <span class="dot blue breathe" style="left: 30%; top: 72%; width: 2.5px; opacity: 0.5; animation-delay: 2.6s"></span>
    <span class="dot blue" style="left: 58%; top: 76%; width: 2px; opacity: 0.4"></span>
    <span class="dot blue breathe" style="left: 80%; top: 70%; width: 3px; opacity: 0.55; animation-delay: 1.4s"></span>

    <!-- 角落光晕（左上电光蓝 / 右下霓虹紫，营造纵深） -->
    <div class="glow glow-blue"></div>
    <div class="glow glow-purple"></div>
  </div>
</template>

<script setup lang="ts">
/**
 * 全局背景 — 深海科技蓝 / 数据流形态（静态，不加动画）
 * 元素：点阵矩阵 + 蜿蜒数据流光带（电光蓝→霓虹紫）+ 底部网格纹理 + 少量光点
 */
</script>

<style scoped>
.dataflow-bg {
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  overflow: hidden;
}

/* 点阵矩阵（保留原基调，略微增强） */
.dots-matrix {
  position: absolute;
  inset: 0;
  background-image: radial-gradient(rgba(69, 184, 255, 0.14) 1px, transparent 1px);
  background-size: 34px 34px;
  mask-image: linear-gradient(to bottom, rgba(0,0,0,0.6), transparent 70%);
  -webkit-mask-image: linear-gradient(to bottom, rgba(0,0,0,0.6), transparent 70%);
}

/* 光带 */
.flow-lines {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 60vh;
  min-height: 320px;
}

/* 底部网格（电路板纹理 + 交叉节点，很淡） */
.grid-floor {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 34vh;
  background-image:
    linear-gradient(rgba(69, 184, 255, 0.05) 1px, transparent 1px),
    linear-gradient(90deg, rgba(69, 184, 255, 0.05) 1px, transparent 1px),
    radial-gradient(rgba(159, 232, 255, 0.12) 1px, transparent 1.5px);
  background-size: 44px 44px, 44px 44px, 44px 44px;
  background-position: 0 0, 0 0, 22px 22px;
  mask-image: linear-gradient(to top, rgba(0,0,0,0.55), transparent 85%);
  -webkit-mask-image: linear-gradient(to top, rgba(0,0,0,0.55), transparent 85%);
}

/* 底部地平线辉光（数据流汇聚处，很淡） */
.floor-line {
  position: absolute;
  left: 5%;
  right: 5%;
  bottom: 3vh;
  height: 1.5px;
  border-radius: 2px;
  background: linear-gradient(90deg,
    transparent 0%,
    rgba(69, 184, 255, 0.25) 30%,
    rgba(167, 107, 255, 0.35) 50%,
    rgba(94, 200, 192, 0.25) 70%,
    transparent 100%);
  filter: blur(0.5px);
}
.floor-line::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: 8px;
  transform: translateY(-50%);
  background: inherit;
  filter: blur(8px);
  opacity: 0.5;
}

/* 底部节点光点（网格上的指示灯，偏青蓝） */
.dot.node {
  background: #5ec8c0;
  box-shadow: 0 0 8px 2px rgba(94, 200, 192, 0.4);
}

/* 光点（沿光带散布，部分极慢呼吸） */
.dot {
  position: absolute;
  height: 0;
  padding-top: 3px;
  border-radius: 50%;
  background: #9fe8ff;
  box-shadow: 0 0 6px 1px rgba(159, 232, 255, 0.5);
}
.dot.blue {
  background: #45b8ff;
  box-shadow: 0 0 6px 1px rgba(69, 184, 255, 0.5);
}
/* 极慢呼吸（5s 周期，轻微明暗，不打扰） */
.dot.breathe {
  animation: breathe 5s ease-in-out infinite;
}
@keyframes breathe {
  0%, 100% { opacity: 0.6; transform: scale(1); }
  50% { opacity: 0.2; transform: scale(0.75); }
}

/* 角落光晕 */
.glow {
  position: absolute;
  border-radius: 50%;
  filter: blur(90px);
  pointer-events: none;
}
.glow-blue {
  top: -160px;
  left: -140px;
  width: 480px;
  height: 480px;
  background: radial-gradient(circle, rgba(69, 184, 255, 0.13), transparent 65%);
}
.glow-purple {
  bottom: -180px;
  right: -160px;
  width: 520px;
  height: 520px;
  background: radial-gradient(circle, rgba(167, 107, 255, 0.1), transparent 65%);
}
</style>
