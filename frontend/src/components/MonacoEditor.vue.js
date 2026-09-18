import * as monaco from 'monaco-editor';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
/* 主题只定义一次（模块级），多处实例共享 */
let themeReady = false;
function ensureTheme() {
    if (themeReady)
        return;
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
    });
    themeReady = true;
}
const props = defineProps();
const emit = defineEmits();
const container = ref(null);
let editor = null;
let userEditing = false; // 用户正在输入（避免回写循环）
onMounted(() => {
    if (!container.value)
        return;
    ensureTheme();
    editor = monaco.editor.create(container.value, {
        value: props.value,
        language: props.language,
        theme: props.theme ?? 'cf-paper',
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 13,
        fontFamily: "'JetBrains Mono', Consolas, 'Courier New', monospace",
        lineHeight: 20,
        scrollBeyondLastLine: false,
        readOnly: props.readOnly,
        renderLineHighlight: 'all',
        padding: { top: 12 },
    });
    editor.onDidChangeModelContent(() => {
        if (!editor)
            return;
        userEditing = true;
        emit('change', editor.getValue());
    });
    // Ctrl+S / Cmd+S 保存
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        emit('save', editor?.getValue() ?? '');
    });
});
// 外部更新内容（Agent 生成/切换文件）
watch(() => props.value, (v) => {
    if (editor && !userEditing && v !== editor.getValue()) {
        editor.setValue(v);
    }
    userEditing = false;
});
// 切换语言
watch(() => props.language, (lang) => {
    const model = editor?.getModel();
    if (model) {
        monaco.editor.setModelLanguage(model, lang);
    }
});
// 切换主题（monaco 的主题是全局的，所以用 setTheme 而不是重建编辑器）
watch(() => props.theme, (t) => {
    monaco.editor.setTheme(t ?? 'cf-paper');
});
onBeforeUnmount(() => {
    editor?.dispose();
    editor = null;
});
const __VLS_ctx = {
    ...{},
    ...{},
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ref: "container",
    ...{ class: "monaco-container" },
});
/** @type {__VLS_StyleScopedClasses['monaco-container']} */ ;
const __VLS_export = (await import('vue')).defineComponent({
    __typeEmits: {},
    __typeProps: {},
});
export default {};
