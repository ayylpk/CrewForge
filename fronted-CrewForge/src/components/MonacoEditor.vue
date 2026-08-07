<template>
  <div ref="container" class="monaco-container"></div>
</template>

<script setup lang="ts">
/**
 * Monaco 编辑器封装（VS Code 同款内核）
 * - 按扩展名高亮（language prop）
 * - vs-dark 主题，贴合项目深色风格
 * - 双向同步 value，Ctrl+S 触发 save 事件
 */
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import * as monaco from 'monaco-editor'

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
  editor = monaco.editor.create(container.value, {
    value: props.value,
    language: props.language,
    theme: 'vs-dark',
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 13,
    fontFamily: "'Consolas', 'Courier New', monospace",
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
  }
)

// 切换语言
watch(
  () => props.language,
  (lang) => {
    const model = editor?.getModel()
    if (model) {
      monaco.editor.setModelLanguage(model, lang)
    }
  }
)

onBeforeUnmount(() => {
  editor?.dispose()
  editor = null
})
</script>

<style scoped>
.monaco-container {
  width: 100%;
  height: 100%;
  min-height: 200px;
}
</style>
