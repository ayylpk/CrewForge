<script setup lang="ts">
/* ============================================================
   走线带（示波带）：引擎心跳的可视化——本世界唯一"活着"的动效。
   active=true 时画一条持续向左滚的晒图青信号线（在制图 = 心跳）；
   false 时归零成一条直线（停车）。reduced-motion / 不可见时自动歇。
   父组件给宽度，本组件只负责 canvas 本身。
   ============================================================ */
import { onBeforeUnmount, onMounted, ref } from 'vue'

const props = withDefaults(defineProps<{ active?: boolean; height?: number }>(), {
  active: false,
  height: 26,
})

const cv = ref<HTMLCanvasElement | null>(null)
let raf = 0
let x = 0 // 波形滚动相位
const CYAN = '#155e93'
const FLAT = 'rgba(21,94,147,0.35)'

function draw(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.clearRect(0, 0, w, h)
  const mid = h / 2
  ctx.lineWidth = 1.4
  ctx.strokeStyle = props.active ? CYAN : FLAT
  ctx.beginPath()
  const amp = props.active ? Math.min(6, h / 4) : 0
  for (let px = 0; px <= w; px += 2) {
    const t = (px + x) * 0.05
    // 双频叠加：像示波器，不像正弦装饰
    const y = mid + Math.sin(t) * amp * 0.7 + Math.sin(t * 2.6 + 1.3) * amp * 0.3
    if (px === 0) ctx.moveTo(px, y)
    else ctx.lineTo(px, y)
  }
  ctx.stroke()
  // 行末端一小段留白刻度：像图纸上的接续符号
  ctx.strokeStyle = FLAT
  ctx.beginPath()
  ctx.moveTo(w - 3, mid - 3)
  ctx.lineTo(w - 3, mid + 3)
  ctx.stroke()
}

let ro: ResizeObserver | null = null
const reduced =
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

function loop() {
  const c = cv.value
  if (!c) return
  const ctx = c.getContext('2d')
  if (!ctx) return
  const dpr = window.devicePixelRatio || 1
  const w = c.clientWidth
  const h = c.clientHeight
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr)
    c.height = Math.round(h * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
  if (props.active && !reduced) x += 1.6 // 停车时相位冻结在原地
  draw(ctx, w, h)
  raf = requestAnimationFrame(loop)
}

onMounted(() => {
  raf = requestAnimationFrame(loop)
  if (cv.value && 'ResizeObserver' in window) {
    ro = new ResizeObserver(() => {}) // 尺寸变化交给 loop 里的 dpr 对账
    ro.observe(cv.value)
  }
})
onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  ro?.disconnect()
})
</script>

<template>
  <canvas ref="cv" class="trace" :style="{ height: height + 'px' }" aria-hidden="true" />
</template>

<style scoped>
.trace {
  display: block;
  width: 100%;
}
</style>
