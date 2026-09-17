<script setup lang="ts">
/* ============================================================
   Monaco 编辑器封装（全站唯一保留的第三方编辑器）
   ------------------------------------------------------------
   晒图室版：弃 vs-dark，自定义 cf-paper 浅色主题（纸底墨字，
   行号青、当前行淡纸深），字体用自托管 JetBrains Mono。
   双向同步 value / Ctrl+S 触发 save 的逻辑原样保留（userEditing
   防回写循环）。
   ============================================================ */
import * as monaco from 'monaco-editor'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

/* 主题只定义一次（模块级），多处实例共享 */
let themeReady = false
function ensureTheme() {
  if (themeReady) return
  monaco.editor.defineTheme('cf-paper', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '8a97a3', fontStyle: 'italic' },
      { token: 'keyword', foreground: '155e93', fontStyle: 'bold' },
      { token: 'string', foreground: '1e6f45' },
      { token: 'number', foreground: '8a5d10' },
      { token: 'type', foreground: '0f4b76' },
    ],
    colors: {
      'editor.background': '#f3f6f8',
      'editor.foreground': '#16222e',
      'editorLineNumber.foreground': '#9aacba',
      'editorLineNumber.activeForeground': '#155e93',
      'editor.lineHighlightBackground': '#e9eef2',
      'editor.selectionBackground': '#c9dcec',
      'editorCursor.foreground': '#155e93',
      'editorIndentGuide.background1': '#d9e2e9',
      'editorIndentGuide.activeBackground1': '#8fa3b3',
      'editorWidget.background': '#f3f6f8',
      'editorWidget.border': '#b9c6d1',
      'editor.findMatchBackground': '#d98f1b55',
    },
  })
  themeReady = true
}

const props = defineProps<{
  language: string
  value: string
  readOnly?: boolean
}>()

const emit = defineEmits<{
  (e: 'change', value: string): void
  (e: 'save', value: string): void
}>()

const container = ref<HTMLElement | null>(null)
let editor: monaco.editor.IStandaloneCodeEditor | null = null
let userEditing = false // 用户正在输入（避免回写循环）

onMounted(() => {
  if (!container.value) return
  ensureTheme()
  editor = monaco.editor.create(container.value, {
    value: props.value,
    language: props.language,
    theme: 'cf-paper',
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 13,
    fontFamily: "'JetBrains Mono', Consolas, 'Courier New', monospace",
    lineHeight: 20,
    scrollBeyondLastLine: false,
    readOnly: props.readOnly,
    renderLineHighlight: 'all',
    padding: { top: 12 },
  })

  editor.onDidChangeModelContent(() => {
    if (!editor) return
    userEditing = true
    emit('change', editor.getValue())
  })

  // Ctrl+S / Cmd+S 保存
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
    emit('save', editor?.getValue() ?? '')
  })
})

// 外部更新内容（Agent 生成/切换文件）
watch(
  () => props.value,
  (v) => {
    if (editor && !userEditing && v !== editor.getValue()) {
      editor.setValue(v)
    }
    userEditing = false
  },
)

// 切换语言
watch(
  () => props.language,
  (lang) => {
    const model = editor?.getModel()
    if (model) {
      monaco.editor.setModelLanguage(model, lang)
    }
  },
)

onBeforeUnmount(() => {
  editor?.dispose()
  editor = null
})
</script>

<template>
  <div ref="container" class="monaco-container"></div>
</template>

<style scoped>
.monaco-container {
  width: 100%;
  height: 100%;
  min-height: 200px;
}
</style>
