<script setup lang="ts">
/* ============================================================
   文件树（执行面板 · 只读）：引擎产出的图纸目录
   ------------------------------------------------------------
   数据是 FileNode[]（buildTreeFromVO 在 ExecutionView 里拼好）；
   点开文件时 content 为空 → 只 emit open，父组件拉详情（懒加载）。
   渲染用扁平化 walker（不递归组件，缩进=左内边距，竖导引线靠背景）。
   ============================================================ */
import { computed } from 'vue'
import { IconChevronDown, IconChevronRight, IconFile, IconFolder, IconFolderOpen } from '@tabler/icons-vue'
import type { FileNode } from '../types/file'

const props = defineProps<{
  nodes: FileNode[]
  activePath?: string
}>()

const emit = defineEmits<{ open: [node: FileNode] }>()

interface FlatRow {
  node: FileNode
  depth: number
}

/** 深度优先展平：目录 open=false 时跳过子树 */
const rows = computed<FlatRow[]>(() => {
  const out: FlatRow[] = []
  const walk = (arr: FileNode[], depth: number) => {
    for (const n of arr) {
      out.push({ node: n, depth })
      if (n.type === 'dir' && n.open && n.children) walk(n.children, depth + 1)
    }
  }
  walk(props.nodes, 0)
  return out
})

function toggle(row: FlatRow) {
  if (row.node.type === 'dir') row.node.open = !row.node.open
  else emit('open', row.node)
}

/** 文件扩展名（右下角小角标，等宽） */
function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : ''
}
</script>

<template>
  <div class="ftree">
    <div v-if="!rows.length" class="ftree-empty faint">引擎还没有落盘任何文件</div>
    <button
      v-for="row in rows"
      :key="row.node.path"
      class="frow"
      :class="{ active: row.node.path === activePath, dir: row.node.type === 'dir' }"
      :style="{ paddingLeft: 10 + row.depth * 16 + 'px' }"
      @click="toggle(row)"
    >
      <IconChevronDown v-if="row.node.type === 'dir' && row.node.open" :size="13" :stroke-width="1.75" class="chev" />
      <IconChevronRight v-else-if="row.node.type === 'dir'" :size="13" :stroke-width="1.75" class="chev" />
      <span v-else class="chev-sp" aria-hidden="true"></span>
      <IconFolderOpen v-if="row.node.type === 'dir' && row.node.open" :size="14" :stroke-width="1.75" class="ico dir-ico" />
      <IconFolder v-else-if="row.node.type === 'dir'" :size="14" :stroke-width="1.75" class="ico dir-ico" />
      <IconFile v-else :size="14" :stroke-width="1.75" class="ico" />
      <span class="fname" :title="row.node.path">{{ row.node.name }}</span>
      <span v-if="row.node.userModified" class="mod" title="你手工改过（引擎不会再覆盖）">改</span>
      <span v-else-if="row.node.type === 'file' && extOf(row.node.name)" class="ext mono">{{ extOf(row.node.name) }}</span>
    </button>
  </div>
</template>

<style scoped>
.ftree {
  display: flex;
  flex-direction: column;
  padding: 6px 0;
  font-size: 13px;
}
.ftree-empty {
  padding: 18px 12px;
  font-size: var(--fs-meta);
}
.frow {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  padding: 4px 10px;
  text-align: left;
  color: var(--ink);
  border-left: 2px solid transparent;
  min-width: 0;
}
.frow:hover {
  background: var(--cyan-wash);
}
.frow.active {
  background: var(--cyan-wash-2);
  border-left-color: var(--cyan); /* 选中轨：青线 0.5mm */
}
.frow.dir {
  font-weight: 600;
}
.chev,
.chev-sp {
  flex: none;
  color: var(--ink-3);
  width: 13px;
  display: inline-flex;
  justify-content: center;
}
.ico {
  flex: none;
  color: var(--ink-2);
}
.dir-ico {
  /* 双重取值的写法：本组件同时用在浅色纸面页和执行面板（暗色工作台）。
     纸面世界里 --cyan-ink 没定义 → 回落到 --cyan(#155e93)，行为与原来完全一致；
     暗色作用域里 --cyan-ink 有定义 → 用 #4fc1ff，否则目录图标在 #1e1e1e 上会糊。 */
  color: var(--cyan-ink, var(--cyan));
}
.fname {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ext {
  flex: none;
  font-size: 10px;
  color: var(--ink-3);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
/* 手工修改章：微型"改"章（铅笔灰） */
.mod {
  flex: none;
  font-size: 10px;
  font-weight: 700;
  color: var(--pencil);
  border: 1px solid var(--pencil);
  border-radius: var(--r-xs);
  padding: 0 3px;
  line-height: 1.5;
}
</style>
