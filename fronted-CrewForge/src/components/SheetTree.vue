<script setup lang="ts">
/* ============================================================
   图纸目录树（架构师页 · 可编辑）
   ------------------------------------------------------------
   右键行 = 节点菜单；右键空白 = 根级菜单；行尾 ⋯ = 触屏替身。
   操作与旧版一致：新建文件/文件夹、复制、粘贴（环防护）、重命名、删除。
   节点数据由父组件持有（TreeNode[]），本组件原地修改并 emit('change')；
   落库前父组件调 cleanTree() 去 id。
   ============================================================ */
import { computed, onBeforeUnmount, reactive, ref } from 'vue'
import {
  IconChevronDown,
  IconChevronRight,
  IconCopy,
  IconFile,
  IconFilePlus,
  IconFolder,
  IconFolderOpen,
  IconFolderPlus,
  IconPencil,
  IconScissors,
  IconClipboard,
  IconTrash,
} from '@tabler/icons-vue'
import { cleanTree, cloneFresh, containsNode, findNodeById, newNode, type TreeNode } from '../types/tree'
import { confirmDialog } from '../utils/confirm'

const props = defineProps<{ nodes: TreeNode[] }>()
const emit = defineEmits<{ change: [] }>()

/* ---------- 展平渲染 ---------- */
interface FlatRow {
  node: TreeNode
  depth: number
}
const rows = computed<FlatRow[]>(() => {
  const out: FlatRow[] = []
  const walk = (arr: TreeNode[], depth: number) => {
    for (const n of arr) {
      out.push({ node: n, depth })
      if (n.type === 'dir' && n.open && n.children) walk(n.children, depth + 1)
    }
  }
  walk(props.nodes, 0)
  return out
})

/* ---------- 剪贴板（copy=留原处 / cut=贴时搬走） ---------- */
const clip = ref<{ mode: 'copy' | 'cut'; node: TreeNode } | null>(null)

/* ---------- 右键操作单（node=null 表示根级空白区） ---------- */
const MENU_W = 170
const menu = reactive<{ x: number; y: number; node: TreeNode | null; open: boolean }>({
  x: 0,
  y: 0,
  node: null,
  open: false,
})

function showMenu(e: MouseEvent, node: TreeNode | null) {
  // 贴边翻转：菜单别出屏幕（旧版 menuW=170 同口径，另补纵向防溢出）
  let x = e.clientX
  let y = e.clientY
  if (x + MENU_W + 8 > window.innerWidth) x = Math.max(8, e.clientX - MENU_W)
  if (y + 250 > window.innerHeight) y = Math.max(8, window.innerHeight - 260)
  menu.x = x
  menu.y = y
  menu.node = node
  menu.open = true
}
function closeMenu() {
  menu.open = false
  menu.node = null
}
// 点击任何地方都收单（菜单自身点击在选择项后自行关闭）
document.addEventListener('click', closeMenu)
window.addEventListener('blur', closeMenu)
onBeforeUnmount(() => {
  document.removeEventListener('click', closeMenu)
  window.removeEventListener('blur', closeMenu)
})

/* ---------- 树操作 ---------- */
function findParent(id: number): TreeNode[] | null {
  const walk = (arr: TreeNode[]): TreeNode[] | null => {
    for (const n of arr) {
      if (n.id === id) return arr
      if (n.children) {
        const hit = walk(n.children)
        if (hit) return hit
      }
    }
    return null
  }
  return walk(props.nodes)
}

function containerOf(node: TreeNode): TreeNode[] {
  return node.children ?? (node.children = [])
}

function addAt(type: 'dir' | 'file', parent: TreeNode | null) {
  const n = newNode(type === 'dir' ? '新建文件夹' : '新建文件.txt', type)
  if (parent) {
    containerOf(parent).push(n)
    parent.open = true
  } else {
    props.nodes.push(n)
  }
  startRename(n)
  emit('change')
}

/** 环防护（与旧版一致的双向检查）：目标不得是剪贴板自身/其祖先/其子孙 */
function canPaste(target: TreeNode | null): boolean {
  const c = clip.value
  if (!c) return false
  if (!target) return true // 根级总能贴
  if (target.type === 'file') return false
  return target.id !== c.node.id && !containsNode(target, c.node.id) && !containsNode(c.node, target.id)
}

function pasteInto(target: TreeNode | null) {
  const c = clip.value
  if (!c || !canPaste(target)) return
  let container: TreeNode[]
  if (target) {
    container = containerOf(target)
    target.open = true
  } else {
    container = props.nodes
  }
  if (c.mode === 'copy') {
    container.push(cloneFresh(c.node))
  } else {
    // 剪切 = 先摘原处再挂新处
    const list = findParent(c.node.id)
    if (list) list.splice(list.indexOf(c.node), 1)
    container.push(c.node)
    clip.value = null
  }
  emit('change')
}

async function removeNode(node: TreeNode) {
  const ok = await confirmDialog({
    title: '删除确认',
    body: `确定删除「${node.name}」吗？${node.type === 'dir' ? '目录内的文件将一并删除。' : ''}`,
    ok: '删除',
    cancel: '取消',
    danger: true,
  })
  if (!ok) return
  const list = findParent(node.id)
  if (list) list.splice(list.indexOf(node), 1)
  if (selectedId.value === node.id) selectedId.value = null
  emit('change')
}

/* ---------- 选中 / 内联重命名 ---------- */
const selectedId = ref<number | null>(null)
const renameId = ref<number | null>(null)
const renameVal = ref('')

function startRename(node: TreeNode) {
  renameId.value = node.id
  renameVal.value = node.name
  closeMenu()
}
function commitRename() {
  if (renameId.value == null) return
  const node = findNodeById(props.nodes, renameId.value)
  const v = renameVal.value.trim()
  if (node && v && v !== node.name) {
    node.name = v
    emit('change')
  }
  renameId.value = null
}
function cancelRename() {
  renameId.value = null
}

function toggle(node: TreeNode) {
  if (node.type === 'dir') node.open = !node.open
}

/* ---------- 菜单动作分发 ---------- */
function menuAct(act: string) {
  const node = menu.node
  switch (act) {
    case 'new-file':
      addAt('file', node)
      break
    case 'new-dir':
      addAt('dir', node)
      break
    case 'paste':
      pasteInto(node)
      closeMenu()
      break
    case 'copy':
      if (node) clip.value = { mode: 'copy', node }
      closeMenu()
      break
    case 'cut':
      if (node) clip.value = { mode: 'cut', node }
      closeMenu()
      break
    case 'rename':
      if (node) startRename(node)
      break
    case 'remove':
      if (node) void removeNode(node)
      closeMenu()
      break
  }
}

/** 对外：工具条按钮直连 + 干净结构导出 */
defineExpose({
  addAt: (t: 'dir' | 'file') => addAt(t, null),
  pasteAtRoot: () => pasteInto(null),
  hasClip: () => !!clip.value,
  exportClean: () => cleanTree(props.nodes),
})
</script>

<template>
  <div class="stree" @contextmenu.prevent="showMenu($event, null)">
    <div v-if="!rows.length" class="stree-empty">
      <span class="faint">目录为空，右键空白处新建——或在右栏让架构师生成。</span>
    </div>
    <div
      v-for="row in rows"
      :key="row.node.id"
      class="srow"
      :class="{
        dir: row.node.type === 'dir',
        selected: selectedId === row.node.id,
        clipped: clip?.mode === 'cut' && clip.node.id === row.node.id,
      }"
      :style="{ paddingLeft: 8 + row.depth * 16 + 'px' }"
      @click="selectedId = row.node.id"
      @contextmenu.stop.prevent="showMenu($event, row.node)"
    >
      <button class="chev" :aria-label="row.node.open ? '收起' : '展开'" @click.stop="toggle(row.node)">
        <IconChevronDown v-if="row.node.type === 'dir' && row.node.open" :size="13" :stroke-width="1.75" />
        <IconChevronRight v-else-if="row.node.type === 'dir'" :size="13" :stroke-width="1.75" />
      </button>
      <IconFolderOpen v-if="row.node.type === 'dir' && row.node.open" :size="14" :stroke-width="1.75" class="ico dir-ico" />
      <IconFolder v-else-if="row.node.type === 'dir'" :size="14" :stroke-width="1.75" class="ico dir-ico" />
      <IconFile v-else :size="14" :stroke-width="1.75" class="ico" />

      <input
        v-if="renameId === row.node.id"
        v-model="renameVal"
        class="rename"
        autofocus
        @click.stop
        @keydown.enter.prevent="commitRename"
        @keydown.esc.prevent="cancelRename"
        @blur="commitRename"
      />
      <span v-else class="sname" :title="row.node.name" @dblclick="startRename(row.node)">{{ row.node.name }}</span>

      <button class="more" aria-label="更多操作" @click.stop="showMenu($event, row.node)">⋯</button>
    </div>

    <!-- 操作单：Teleport 到 body，fixed 定位贴边翻转 -->
    <Teleport to="body">
      <div
        v-if="menu.open"
        class="ctx"
        :style="{ left: menu.x + 'px', top: menu.y + 'px', width: MENU_W + 'px' }"
        @click.stop
        @contextmenu.prevent
      >
        <button class="ctx-i" @click="menuAct('new-file')"><IconFilePlus :size="14" :stroke-width="1.75" />新建文件</button>
        <button class="ctx-i" @click="menuAct('new-dir')"><IconFolderPlus :size="14" :stroke-width="1.75" />新建文件夹</button>
        <button
          v-if="clip"
          class="ctx-i"
          :disabled="!canPaste(menu.open ? menu.node : null)"
          @click="menuAct('paste')"
        >
          <IconClipboard :size="14" :stroke-width="1.75" />{{ menu.node ? '粘贴到这里' : '粘贴' }}
        </button>
        <template v-if="menu.node">
          <div class="ctx-sep"></div>
          <button class="ctx-i" @click="menuAct('copy')"><IconCopy :size="14" :stroke-width="1.75" />复制</button>
          <button class="ctx-i" @click="menuAct('cut')"><IconScissors :size="14" :stroke-width="1.75" />剪切</button>
          <button class="ctx-i" @click="menuAct('rename')"><IconPencil :size="14" :stroke-width="1.75" />重命名</button>
          <div class="ctx-sep"></div>
          <button class="ctx-i ctx-del" @click="menuAct('remove')"><IconTrash :size="14" :stroke-width="1.75" />删除</button>
        </template>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.stree {
  display: flex;
  flex-direction: column;
  padding: 6px 0;
  font-size: 13px;
  min-height: 150px;
}
.stree-empty {
  padding: 18px 12px;
  font-size: var(--fs-meta);
}
.srow {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  color: var(--ink);
  border-radius: var(--r-xs);
  min-width: 0;
}
.srow:hover {
  background: var(--cyan-wash);
}
.srow.selected {
  background: var(--cyan-wash-2);
}
.srow.dir {
  font-weight: 600;
}
/* 剪切态：虚影等着被搬走 */
.srow.clipped .sname {
  color: var(--ink-3);
  text-decoration: line-through;
}
.chev {
  flex: none;
  width: 13px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--ink-3);
}
.ico {
  flex: none;
  color: var(--ink-2);
}
.dir-ico {
  color: var(--cyan);
}
.sname {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rename {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  padding: 1px 6px;
  background: #fff;
  border: 1px solid var(--cyan);
  border-radius: var(--r-xs);
  outline: none;
}
.more {
  flex: none;
  width: 22px;
  height: 20px;
  color: var(--ink-3);
  border-radius: var(--r-xs);
  visibility: hidden;
  line-height: 1;
}
.srow:hover .more,
.srow:focus-within .more {
  visibility: visible;
}
.more:hover {
  background: var(--cyan-wash-2);
  color: var(--cyan);
}
</style>

<style>
/* 操作单 Teleport 到 body，scoped 管不到——类名够独，放全局 */
.ctx {
  position: fixed;
  z-index: 1300;
  background: var(--paper-raised);
  border: 1px solid var(--line-2);
  border-radius: var(--r);
  box-shadow: var(--shadow-lg);
  padding: 4px;
}
.ctx-i {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 9px;
  font-size: 13px;
  text-align: left;
  border-radius: var(--r-xs);
  color: var(--ink);
}
.ctx-i:hover:not(:disabled) {
  background: var(--cyan-wash);
  color: var(--cyan);
}
.ctx-i:disabled {
  color: var(--ink-3);
  cursor: not-allowed;
}
.ctx-del:hover {
  background: var(--void-wash) !important;
  color: var(--void-ink) !important;
}
.ctx-sep {
  height: 1px;
  background: var(--line);
  margin: 4px 2px;
}
</style>
