<template>
  <div class="file-tree">
    <div v-for="node in nodes" :key="node.path" class="tree-node" :style="{ paddingLeft: (depth) * 14 + 'px' }">
      <!-- 目录 -->
      <div
        v-if="node.type === 'dir'"
        class="node-row dir"
        @click="toggle(node)"
      >
        <span class="node-arrow" :class="{ open: node.open }">
          <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </span>
        <span class="node-icon dir-icon">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 7v11a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2z" />
          </svg>
        </span>
        <span class="node-name">{{ node.name }}</span>
      </div>

      <!-- 文件 -->
      <div
        v-else
        class="node-row file"
        :class="{ active: selected === node.path, 'is-new': node.isNew }"
        @click="$emit('select', node)"
      >
        <span class="node-arrow spacer"></span>
        <span class="node-icon" :style="{ color: fileIcon(node).color }">
          <svg v-html="fileIcon(node).icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></svg>
        </span>
        <span class="node-name">{{ node.name }}</span>
        <!-- user_modified 锁标记 -->
        <span v-if="node.userModified" class="node-lock" title="已被你修改，Agent 不会覆盖">
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        </span>
      </div>

      <!-- 子节点 -->
      <template v-if="node.type === 'dir' && node.open">
        <FileTree
          :nodes="node.children || []"
          :depth="depth + 1"
          :selected="selected"
          @select="$emit('select', $event)"
        />
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 文件树组件（递归）
 * - 目录展开/折叠
 * - 文件类型图标（按扩展名着色）
 * - user_modified 锁标记（蓝色小锁）
 * - 新文件高亮动画（isNew）
 */
import type { FileNode } from '../types/file'

// depth 默认 0，避免根级递归时 undefined * 14 = NaN
withDefaults(
  defineProps<{
    nodes: FileNode[]
    depth?: number
    selected?: string
  }>(),
  { depth: 0 }
)

defineEmits<{
  (e: 'select', node: FileNode): void
}>()

/** 文件类型 → 图标 + 颜色 */
const FILE_META: Record<string, { color: string; icon: string }> = {
  java: {
    color: '#f09050',
    icon: '<path d="M4 6h16v12H4z"/><path d="M9 10h6M9 14h4"/>',
  },
  vue: {
    color: '#5ecb8a',
    icon: '<path d="M3 5l9 14 9-14z"/><polyline points="8.5 5 12 10.5 15.5 5"/>',
  },
  ts: {
    color: '#45b8ff',
    icon: '<path d="M4 6h16v12H4z"/><path d="M14 10v6M14 13h3"/><path d="M9.5 10v5M7.5 10h4"/>',
  },
  yml: {
    color: '#f0c060',
    icon: '<path d="M4 6h16v12H4z"/><circle cx="8" cy="10" r="1"/><circle cx="8" cy="14" r="1"/><line x1="12" y1="10" x2="17" y2="10"/><line x1="12" y1="14" x2="17" y2="14"/>',
  },
  json: {
    color: '#f0c060',
    icon: '<path d="M4 6h16v12H4z"/><polyline points="10 9 7 12 10 15"/><polyline points="14 9 17 12 14 15"/>',
  },
  xml: {
    color: '#a76bff',
    icon: '<path d="M4 6h16v12H4z"/><polyline points="9 9 6 12 9 15"/><polyline points="15 9 18 12 15 15"/>',
  },
  sql: {
    color: '#5ec8c0',
    icon: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.66 3.13 3 7 3s7-1.34 7-3V6"/><path d="M5 12v6c0 1.66 3.13 3 7 3s7-1.34 7-3v-6"/>',
  },
  md: {
    color: '#8890a8',
    icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/>',
  },
}

const DEFAULT_FILE = {
  color: '#8890a8',
  icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
}

function fileIcon(node: FileNode) {
  const ext = node.name.split('.').pop()?.toLowerCase() || ''
  return FILE_META[ext] || DEFAULT_FILE
}

/** 展开/折叠 */
function toggle(node: FileNode) {
  node.open = !node.open
}
</script>

<style scoped>
.file-tree {
  font-size: 13px;
  user-select: none;
}
.node-row {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  border-radius: 6px;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.12s;
}
.node-row:hover {
  background: var(--bg3);
}
.node-row.dir {
  font-weight: 500;
  color: var(--text);
}
.node-row.file {
  color: var(--text2);
}
.node-row.file.active {
  background: rgba(69, 184, 255, 0.12);
  color: var(--text);
}
.node-row.file.is-new {
  animation: new-file 1.6s var(--ease);
}
@keyframes new-file {
  0% { background: rgba(94, 203, 138, 0.35); }
  100% { background: transparent; }
}
.node-arrow {
  width: 12px;
  height: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text3);
  flex-shrink: 0;
  transition: transform 0.15s;
}
.node-arrow.open {
  transform: rotate(90deg);
}
.node-arrow.spacer {
  visibility: hidden;
}
.node-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.dir-icon {
  color: var(--blue);
}
.node-name {
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}
.node-lock {
  color: var(--blue);
  display: flex;
  align-items: center;
  flex-shrink: 0;
}
</style>
