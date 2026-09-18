import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { IconBook, IconDeviceLaptop, IconLogout, IconPackage, IconPlus, IconSchool, IconSearch, IconShieldLock, IconTrash, IconUsersGroup, IconWritingSign, } from '@tabler/icons-vue';
import AppModal from '../components/ui/AppModal.vue';
import CreateProjectSheet from '../components/ui/CreateProjectSheet.vue';
import StampSeal from '../components/ui/StampSeal.vue';
import TopBar from '../components/ui/TopBar.vue';
import { fetchProjects, deleteProject } from '../api/project';
import { fetchSettings, saveSettings, testSettings } from '../api/settings';
import { useAuthStore } from '../api/auth';
import { projectStatusMeta } from '../constants/status';
import { confirmDialog } from '../utils/confirm';
import { toast } from '../utils/toast';
const router = useRouter();
const auth = useAuthStore();
const loading = ref(true);
const loadError = ref('');
const projects = ref([]);
async function load() {
    loading.value = true;
    loadError.value = '';
    try {
        // 分页结果取 records 数组
        const { records } = await fetchProjects();
        projects.value = records;
    }
    catch (err) {
        loadError.value = err instanceof Error ? err.message : '项目清单没拿到';
    }
    finally {
        loading.value = false;
    }
}
/* ===== 新建项目（9/18 起改弹窗，不再是独立页面） =====
   原 `/projects/new` 是一整页，但它的四个板块（名称/描述/确认模式/参考文件）
   和「需求对话」页完全重复。创建只是登记一条记录 → 退化成只收名称+描述的弹窗。 */
const showCreate = ref(false);
function onProjectCreated() {
    showCreate.value = false;
    load(); // 回列表看到新记录（POST /api/project 不回 id，没法直接跳需求对话）
}
/* ===== API 设置（阶段 2 起接服务端 sys_settings；Key 存服务器，引擎直读） ===== */
const showApiSettings = ref(false);
const cfg = ref({ modelKind: 'deepseek' });
const maskedKey = ref('未配置'); // 服务端当前 key 的掩码（引擎有 .env 兜底，空也能跑）
const saving = ref(false);
const testing = ref(false);
/**
 * 9/18：清除已保存 key 的**待提交标记**。
 *   为什么需要单独一条通道：apiKey 的语义是"空 = 保持原值"，所以光清空输入框删不掉已存的 key
 *   （用户实测反馈"填入了就不让修改"）。点「清除已保存的 Key」→ 置此标记 → 保存时带 clearApiKey。
 */
const clearKeyRequested = ref(false);
function requestClearKey() {
    clearKeyRequested.value = true;
    cfg.value.apiKey = ''; // 清除优先于"填新值"：两个动作别打架
    toast.info('保存后生效：已保存的 Key 会被清空');
}
/** 顶栏小灯：服务端配了 key 就算已配置 */
const llmConfigured = computed(() => maskedKey.value !== '未配置' && maskedKey.value !== '');
/** 拉一次服务端配置刷新顶栏状态灯 */
async function refreshSettingsDot() {
    try {
        const s = await fetchSettings();
        maskedKey.value = s.apiKey || '未配置';
    }
    catch {
        /* 后端未启动：灯灰着，不炸列表页 */
    }
}
/** 打开弹窗时才拉全量配置（掩码回显 + 表单初值） */
async function openApiSettings() {
    showApiSettings.value = true;
    clearKeyRequested.value = false; // 每次打开都从"不改 key"的干净状态开始
    try {
        const s = await fetchSettings();
        maskedKey.value = s.apiKey || '未配置';
        cfg.value = {
            modelKind: s.modelKind || 'deepseek',
            modelUrl: s.modelUrl || '',
            apiKey: '', // 永不回显明文；留空=保持
            modelName: s.modelName || '',
            modelPro: s.modelPro || '',
            roleModels: s.roleModels || '',
            javaBaseUrl: s.javaBaseUrl || '',
            confirmTimeoutMin: s.confirmTimeoutMin ?? 30,
            smokeBuild: !!s.smokeBuild,
            llmConcurrency: s.llmConcurrency ?? undefined,
            stationSlots: s.stationSlots ?? undefined,
            toolMode: !!s.toolMode,
        };
    }
    catch {
        /* 拦截器已提示 */
    }
}
async function saveApiSettings() {
    saving.value = true;
    try {
        await saveSettings({
            ...cfg.value,
            apiKey: cfg.value.apiKey?.trim() || undefined, // 空=不改（后端掩码语义）
            // 9/18：显式清除通道（空值语义删不掉已存的 key，必须带这个开关）
            ...(clearKeyRequested.value ? { clearApiKey: true } : {}),
        });
        // 9/18 删掉这里原来的 localStorage 镜像（cf_providers / cf_default_model）：
        // 它唯一的读者是已删除的 AgentFormView（经 loadProviders/globalDefaultModel），
        // 再没有第二个人读 —— 留着就是往用户浏览器里写两份没人看、还含 API Key 的副本。
        // 模型配置的真相现在只有一处：服务端 sys_settings（引擎直读，30s 热加载）。
        toast.success('已保存——引擎最多 30 秒热加载生效');
        maskedKey.value = (await fetchSettings().catch(() => ({}))).apiKey || '未配置';
        cfg.value.apiKey = '';
        clearKeyRequested.value = false;
        showApiSettings.value = false;
    }
    finally {
        saving.value = false;
    }
}
async function runTest() {
    testing.value = true;
    try {
        const r = await testSettings({ ...cfg.value, apiKey: cfg.value.apiKey?.trim() || undefined });
        if (r.ok)
            toast.success(`连通 ${r.latencyMs ?? '?'}ms（HTTP ${r.status}）`);
        else
            toast.error(`不通：${r.error || '未知错误'}`);
    }
    finally {
        testing.value = false;
    }
}
/* ===== 项目图标：emoji 换成图章线稿图标（同映射规则） ===== */
const ICON_RULES = [
    [/CRM|客户|crm/i, IconUsersGroup],
    [/选课|学生|教育|课程/i, IconSchool],
    [/进销存|库存|采购|订单|商城/i, IconPackage],
    [/图书|借阅/i, IconBook],
];
function projectIcon(p) {
    return ICON_RULES.find(([re]) => re.test(p.name))?.[1] ?? IconDeviceLaptop;
}
/* ===== 筛选（标签带计数 + **状态色点**：目录抽屉的语言）
   9/18 用户要求：分栏旁边要能看出"这个颜色对应哪个状态"。
   色点取 projectStatusMeta(status).tone，与列表行里的状态章**同一份口径**（constants/status.ts），
   所以点是什么色、行里的章就是什么色——不用记两套。
   「全部」不是状态，故意不给点（否则会被误读成某个状态）。 */
const FILTERS = [
    { label: '全部', value: 'all' },
    { label: '执行中', value: 'executing', status: 'executing' },
    { label: '规划中', value: 'planning', status: 'planning' }, // 9/18 补：库里 8 个项目卡在这个状态，原先筛不到
    { label: '已完成', value: 'done', status: 'done' },
    { label: '澄清中', value: 'clarifying', status: 'clarifying' },
    { label: '草稿', value: 'draft', status: 'draft' },
];
const activeFilter = ref('all');
const keyword = ref('');
function countOf(f) {
    if (!f.status)
        return projects.value.length;
    return projects.value.filter((p) => p.status === f.status).length;
}
const filtered = computed(() => {
    return projects.value.filter((p) => {
        const okStatus = activeFilter.value === 'all' || p.status === activeFilter.value;
        const okKeyword = !keyword.value || p.name.includes(keyword.value);
        return okStatus && okKeyword;
    });
});
/* ===== 标题栏统计（原五张统计卡收进一条 tblock） ===== */
const totalFiles = computed(() => projects.value.reduce((sum, p) => sum + (p.fileCount || 0), 0));
function countBy(status) {
    return projects.value.filter((p) => p.status === status).length;
}
/** 图号：PRJ-{id补零}-C（台账卡片的编号，hover 浮现） */
function sheetNo(p) {
    return `PRJ-${String(p.id).padStart(4, '0')}-C`;
}
onMounted(() => {
    void load();
    void refreshSettingsDot();
});
/** 删除项目：确认 → 调接口 → 从列表移除（失败提示由 request.ts 拦截器统一弹出） */
async function removeProject(p) {
    const ok = await confirmDialog({
        title: '删除项目',
        body: `确定删除「${p.name}」吗？删除后不可恢复`,
        ok: '删除',
        cancel: '取消',
        danger: true,
    });
    if (!ok)
        return;
    try {
        await deleteProject(p.id);
        projects.value = projects.value.filter((x) => x.id !== p.id);
    }
    catch {
        /* 拦截器已提示 */
    }
}
function createNew() {
    showCreate.value = true;
}
/* 9/18 删掉 goAgentRepo() + 顶栏那颗「Agent 仓库」按钮：
   它 push 的 agent-repo 路由已随封存功能一起删除（点了只会命中 no-match）。
   保留一个指向不存在页面的按钮，比没有按钮更糟。 */
/** 点击卡片 → 项目概览页，定位到「功能清单 + 开发计划」区块 */
function goProject(p) {
    router.push({ name: 'project-detail', params: { id: String(p.id) }, hash: '#overview' });
}
function logout() {
    localStorage.removeItem('cf_token');
    router.push('/login');
}
const userInitial = computed(() => (auth.userName || 'K').slice(0, 1).toUpperCase());
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['stat']} */ ;
/** @type {__VLS_StyleScopedClasses['tab']} */ ;
/** @type {__VLS_StyleScopedClasses['tab']} */ ;
/** @type {__VLS_StyleScopedClasses['tab']} */ ;
/** @type {__VLS_StyleScopedClasses['on']} */ ;
/** @type {__VLS_StyleScopedClasses['tab-dot']} */ ;
/** @type {__VLS_StyleScopedClasses['quest']} */ ;
/** @type {__VLS_StyleScopedClasses['proj']} */ ;
/** @type {__VLS_StyleScopedClasses['proj']} */ ;
/** @type {__VLS_StyleScopedClasses['proj']} */ ;
/** @type {__VLS_StyleScopedClasses['card-no']} */ ;
/** @type {__VLS_StyleScopedClasses['proj']} */ ;
/** @type {__VLS_StyleScopedClasses['card-no']} */ ;
/** @type {__VLS_StyleScopedClasses['proj']} */ ;
/** @type {__VLS_StyleScopedClasses['proj']} */ ;
/** @type {__VLS_StyleScopedClasses['del']} */ ;
/** @type {__VLS_StyleScopedClasses['proj']} */ ;
/** @type {__VLS_StyleScopedClasses['del']} */ ;
/** @type {__VLS_StyleScopedClasses['del']} */ ;
/** @type {__VLS_StyleScopedClasses['err-cloud']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-sheet']} */ ;
/** @type {__VLS_StyleScopedClasses['empty-sheet']} */ ;
/** @type {__VLS_StyleScopedClasses['provider-key-state']} */ ;
/** @type {__VLS_StyleScopedClasses['prow']} */ ;
/** @type {__VLS_StyleScopedClasses['prow']} */ ;
/** @type {__VLS_StyleScopedClasses['prow']} */ ;
/** @type {__VLS_StyleScopedClasses['prow-cur']} */ ;
/** @type {__VLS_StyleScopedClasses['btn']} */ ;
/** @type {__VLS_StyleScopedClasses['check']} */ ;
/** @type {__VLS_StyleScopedClasses['ledger-h']} */ ;
/** @type {__VLS_StyleScopedClasses['stat']} */ ;
/** @type {__VLS_StyleScopedClasses['tblock-val']} */ ;
/** @type {__VLS_StyleScopedClasses['stats']} */ ;
/** @type {__VLS_StyleScopedClasses['stat']} */ ;
/** @type {__VLS_StyleScopedClasses['prow']} */ ;
/** @type {__VLS_StyleScopedClasses['prow-note']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "view" },
});
/** @type {__VLS_StyleScopedClasses['view']} */ ;
const __VLS_0 = TopBar || TopBar;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({}));
const __VLS_2 = __VLS_1({}, ...__VLS_functionalComponentArgsRest(__VLS_1));
const { default: __VLS_5 } = __VLS_3.slots;
{
    const { context: __VLS_6 } = __VLS_3.slots;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "tb-title" },
    });
    /** @type {__VLS_StyleScopedClasses['tb-title']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "sheet-no tb-sheet" },
    });
    /** @type {__VLS_StyleScopedClasses['sheet-no']} */ ;
    /** @type {__VLS_StyleScopedClasses['tb-sheet']} */ ;
}
{
    const { right: __VLS_7 } = __VLS_3.slots;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (__VLS_ctx.openApiSettings) },
        ...{ class: "btn btn-sm" },
        title: (__VLS_ctx.llmConfigured ? '模型服务已配置（' + __VLS_ctx.maskedKey + '）' : '未配置 API Key（引擎走服务器 .env 兜底）'),
    });
    /** @type {__VLS_StyleScopedClasses['btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
    let __VLS_8;
    /** @ts-ignore @type { | typeof __VLS_components.IconShieldLock} */
    IconShieldLock;
    // @ts-ignore
    const __VLS_9 = __VLS_asFunctionalComponent1(__VLS_8, new __VLS_8({
        size: (15),
        strokeWidth: (1.75),
    }));
    const __VLS_10 = __VLS_9({
        size: (15),
        strokeWidth: (1.75),
    }, ...__VLS_functionalComponentArgsRest(__VLS_9));
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "lamp" },
        ...{ class: (__VLS_ctx.llmConfigured ? 'lamp-on' : '') },
        'aria-hidden': "true",
    });
    /** @type {__VLS_StyleScopedClasses['lamp']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "tb-user" },
    });
    /** @type {__VLS_StyleScopedClasses['tb-user']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "tb-avatar mono" },
    });
    /** @type {__VLS_StyleScopedClasses['tb-avatar']} */ ;
    /** @type {__VLS_StyleScopedClasses['mono']} */ ;
    (__VLS_ctx.userInitial);
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (__VLS_ctx.logout) },
        ...{ class: "btn btn-sm btn-ghost" },
    });
    /** @type {__VLS_StyleScopedClasses['btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-ghost']} */ ;
    let __VLS_13;
    /** @ts-ignore @type { | typeof __VLS_components.IconLogout} */
    IconLogout;
    // @ts-ignore
    const __VLS_14 = __VLS_asFunctionalComponent1(__VLS_13, new __VLS_13({
        size: (15),
        strokeWidth: (1.75),
    }));
    const __VLS_15 = __VLS_14({
        size: (15),
        strokeWidth: (1.75),
    }, ...__VLS_functionalComponentArgsRest(__VLS_14));
    // @ts-ignore
    [openApiSettings, llmConfigured, llmConfigured, maskedKey, userInitial, logout,];
}
// @ts-ignore
[];
var __VLS_3;
__VLS_asFunctionalElement1(__VLS_intrinsics.main, __VLS_intrinsics.main)({
    ...{ class: "page" },
});
/** @type {__VLS_StyleScopedClasses['page']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.header, __VLS_intrinsics.header)({
    ...{ class: "ledger-head" },
});
/** @type {__VLS_StyleScopedClasses['ledger-head']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({});
__VLS_asFunctionalElement1(__VLS_intrinsics.h1, __VLS_intrinsics.h1)({
    ...{ class: "ledger-h" },
});
/** @type {__VLS_StyleScopedClasses['ledger-h']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
    ...{ class: "ledger-sub dim" },
});
/** @type {__VLS_StyleScopedClasses['ledger-sub']} */ ;
/** @type {__VLS_StyleScopedClasses['dim']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (__VLS_ctx.createNew) },
    ...{ class: "btn btn-primary" },
});
/** @type {__VLS_StyleScopedClasses['btn']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
let __VLS_18;
/** @ts-ignore @type { | typeof __VLS_components.IconPlus} */
IconPlus;
// @ts-ignore
const __VLS_19 = __VLS_asFunctionalComponent1(__VLS_18, new __VLS_18({
    size: (16),
    strokeWidth: (1.75),
}));
const __VLS_20 = __VLS_19({
    size: (16),
    strokeWidth: (1.75),
}, ...__VLS_functionalComponentArgsRest(__VLS_19));
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "tblock stats" },
});
/** @type {__VLS_StyleScopedClasses['tblock']} */ ;
/** @type {__VLS_StyleScopedClasses['stats']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "tblock-cell stat" },
});
/** @type {__VLS_StyleScopedClasses['tblock-cell']} */ ;
/** @type {__VLS_StyleScopedClasses['stat']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "tblock-key" },
});
/** @type {__VLS_StyleScopedClasses['tblock-key']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "tblock-val mono" },
});
/** @type {__VLS_StyleScopedClasses['tblock-val']} */ ;
/** @type {__VLS_StyleScopedClasses['mono']} */ ;
(__VLS_ctx.projects.length);
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "tblock-cell stat" },
});
/** @type {__VLS_StyleScopedClasses['tblock-cell']} */ ;
/** @type {__VLS_StyleScopedClasses['stat']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "tblock-key" },
});
/** @type {__VLS_StyleScopedClasses['tblock-key']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "tblock-val mono c-cyan" },
});
/** @type {__VLS_StyleScopedClasses['tblock-val']} */ ;
/** @type {__VLS_StyleScopedClasses['mono']} */ ;
/** @type {__VLS_StyleScopedClasses['c-cyan']} */ ;
(__VLS_ctx.countBy('executing'));
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "tblock-cell stat" },
});
/** @type {__VLS_StyleScopedClasses['tblock-cell']} */ ;
/** @type {__VLS_StyleScopedClasses['stat']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "tblock-key" },
});
/** @type {__VLS_StyleScopedClasses['tblock-key']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "tblock-val mono c-pass" },
});
/** @type {__VLS_StyleScopedClasses['tblock-val']} */ ;
/** @type {__VLS_StyleScopedClasses['mono']} */ ;
/** @type {__VLS_StyleScopedClasses['c-pass']} */ ;
(__VLS_ctx.countBy('done'));
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "tblock-cell stat" },
});
/** @type {__VLS_StyleScopedClasses['tblock-cell']} */ ;
/** @type {__VLS_StyleScopedClasses['stat']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "tblock-key" },
});
/** @type {__VLS_StyleScopedClasses['tblock-key']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "tblock-val mono c-wait" },
});
/** @type {__VLS_StyleScopedClasses['tblock-val']} */ ;
/** @type {__VLS_StyleScopedClasses['mono']} */ ;
/** @type {__VLS_StyleScopedClasses['c-wait']} */ ;
(__VLS_ctx.countBy('clarifying'));
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "tblock-cell stat" },
});
/** @type {__VLS_StyleScopedClasses['tblock-cell']} */ ;
/** @type {__VLS_StyleScopedClasses['stat']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "tblock-key" },
});
/** @type {__VLS_StyleScopedClasses['tblock-key']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "tblock-val mono" },
});
/** @type {__VLS_StyleScopedClasses['tblock-val']} */ ;
/** @type {__VLS_StyleScopedClasses['mono']} */ ;
(__VLS_ctx.totalFiles);
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "toolbar" },
});
/** @type {__VLS_StyleScopedClasses['toolbar']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.nav, __VLS_intrinsics.nav)({
    ...{ class: "tabs" },
    'aria-label': "按状态筛选",
});
/** @type {__VLS_StyleScopedClasses['tabs']} */ ;
for (const [f] of __VLS_vFor((__VLS_ctx.FILTERS))) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                return (__VLS_ctx.activeFilter = f.value);
                // @ts-ignore
                [createNew, projects, countBy, countBy, countBy, totalFiles, FILTERS, activeFilter,];
            } },
        key: (f.value),
        ...{ class: "tab" },
        ...{ class: ({ on: __VLS_ctx.activeFilter === f.value }) },
    });
    /** @type {__VLS_StyleScopedClasses['tab']} */ ;
    /** @type {__VLS_StyleScopedClasses['on']} */ ;
    if (f.status) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "tab-dot" },
            ...{ class: (`stamp-${__VLS_ctx.projectStatusMeta(f.status).tone}`) },
            'aria-hidden': "true",
        });
        /** @type {__VLS_StyleScopedClasses['tab-dot']} */ ;
    }
    (f.label);
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "tab-n mono" },
    });
    /** @type {__VLS_StyleScopedClasses['tab-n']} */ ;
    /** @type {__VLS_StyleScopedClasses['mono']} */ ;
    (__VLS_ctx.countOf(f));
    // @ts-ignore
    [activeFilter, projectStatusMeta, countOf,];
}
__VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
    ...{ class: "quest" },
});
/** @type {__VLS_StyleScopedClasses['quest']} */ ;
let __VLS_23;
/** @ts-ignore @type { | typeof __VLS_components.IconSearch} */
IconSearch;
// @ts-ignore
const __VLS_24 = __VLS_asFunctionalComponent1(__VLS_23, new __VLS_23({
    size: (15),
    strokeWidth: (1.75),
    ...{ class: "quest-ico" },
}));
const __VLS_25 = __VLS_24({
    size: (15),
    strokeWidth: (1.75),
    ...{ class: "quest-ico" },
}, ...__VLS_functionalComponentArgsRest(__VLS_24));
/** @type {__VLS_StyleScopedClasses['quest-ico']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.input)({
    value: (__VLS_ctx.keyword),
    ...{ class: "quest-in" },
    type: "text",
    placeholder: "检索项目名…",
    'aria-label': "检索项目名",
});
/** @type {__VLS_StyleScopedClasses['quest-in']} */ ;
if (__VLS_ctx.loading) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "card-grid" },
        'aria-busy': "true",
    });
    /** @type {__VLS_StyleScopedClasses['card-grid']} */ ;
    for (const [i] of __VLS_vFor((6))) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            key: (i),
            ...{ class: "card skel" },
        });
        /** @type {__VLS_StyleScopedClasses['card']} */ ;
        /** @type {__VLS_StyleScopedClasses['skel']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "skeleton" },
            ...{ style: {} },
        });
        /** @type {__VLS_StyleScopedClasses['skeleton']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "skeleton" },
            ...{ style: {} },
        });
        /** @type {__VLS_StyleScopedClasses['skeleton']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "skeleton" },
            ...{ style: {} },
        });
        /** @type {__VLS_StyleScopedClasses['skeleton']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "skeleton" },
            ...{ style: {} },
        });
        /** @type {__VLS_StyleScopedClasses['skeleton']} */ ;
        // @ts-ignore
        [keyword, loading,];
    }
}
else if (__VLS_ctx.loadError) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "err-sheet" },
    });
    /** @type {__VLS_StyleScopedClasses['err-sheet']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "revision-cloud err-cloud" },
    });
    /** @type {__VLS_StyleScopedClasses['revision-cloud']} */ ;
    /** @type {__VLS_StyleScopedClasses['err-cloud']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.b, __VLS_intrinsics.b)({});
    (__VLS_ctx.loadError);
    __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
        ...{ class: "dim" },
    });
    /** @type {__VLS_StyleScopedClasses['dim']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (__VLS_ctx.load) },
        ...{ class: "btn" },
    });
    /** @type {__VLS_StyleScopedClasses['btn']} */ ;
}
else if (__VLS_ctx.filtered.length) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "card-grid" },
    });
    /** @type {__VLS_StyleScopedClasses['card-grid']} */ ;
    for (const [p] of __VLS_vFor((__VLS_ctx.filtered))) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.article, __VLS_intrinsics.article)({
            ...{ onClick: (...[$event]) => {
                    if (!!(__VLS_ctx.loading))
                        throw 0;
                    if (!!(__VLS_ctx.loadError))
                        throw 0;
                    if (!(__VLS_ctx.filtered.length))
                        throw 0;
                    return (__VLS_ctx.goProject(p));
                    // @ts-ignore
                    [loadError, loadError, load, filtered, filtered, goProject,];
                } },
            ...{ onKeydown: (...[$event]) => {
                    if (!!(__VLS_ctx.loading))
                        throw 0;
                    if (!!(__VLS_ctx.loadError))
                        throw 0;
                    if (!(__VLS_ctx.filtered.length))
                        throw 0;
                    return (__VLS_ctx.goProject(p));
                    // @ts-ignore
                    [goProject,];
                } },
            key: (p.id),
            ...{ class: "card proj" },
            tabindex: "0",
            role: "button",
            'aria-label': (`打开项目 ${p.name}`),
        });
        /** @type {__VLS_StyleScopedClasses['card']} */ ;
        /** @type {__VLS_StyleScopedClasses['proj']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "card-no sheet-no mono" },
        });
        /** @type {__VLS_StyleScopedClasses['card-no']} */ ;
        /** @type {__VLS_StyleScopedClasses['sheet-no']} */ ;
        /** @type {__VLS_StyleScopedClasses['mono']} */ ;
        (__VLS_ctx.sheetNo(p));
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "proj-top" },
        });
        /** @type {__VLS_StyleScopedClasses['proj-top']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "proj-ico" },
        });
        /** @type {__VLS_StyleScopedClasses['proj-ico']} */ ;
        const __VLS_28 = (__VLS_ctx.projectIcon(p));
        // @ts-ignore
        const __VLS_29 = __VLS_asFunctionalComponent1(__VLS_28, new __VLS_28({
            size: (21),
            strokeWidth: (1.75),
        }));
        const __VLS_30 = __VLS_29({
            size: (21),
            strokeWidth: (1.75),
        }, ...__VLS_functionalComponentArgsRest(__VLS_29));
        __VLS_asFunctionalElement1(__VLS_intrinsics.h3, __VLS_intrinsics.h3)({
            ...{ class: "proj-name" },
        });
        /** @type {__VLS_StyleScopedClasses['proj-name']} */ ;
        (p.name);
        const __VLS_33 = StampSeal;
        // @ts-ignore
        const __VLS_34 = __VLS_asFunctionalComponent1(__VLS_33, new __VLS_33({
            label: (__VLS_ctx.projectStatusMeta(p.status).label),
            tone: __VLS_ctx.projectStatusMeta(p.status).tone,
        }));
        const __VLS_35 = __VLS_34({
            label: (__VLS_ctx.projectStatusMeta(p.status).label),
            tone: __VLS_ctx.projectStatusMeta(p.status).tone,
        }, ...__VLS_functionalComponentArgsRest(__VLS_34));
        __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
            ...{ class: "proj-desc dim" },
        });
        /** @type {__VLS_StyleScopedClasses['proj-desc']} */ ;
        /** @type {__VLS_StyleScopedClasses['dim']} */ ;
        (p.description || '暂无描述');
        if (p.progress != null && p.progress > 0) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "prog" },
                title: (`进度 ${p.progress}%`),
            });
            /** @type {__VLS_StyleScopedClasses['prog']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "prog-fill" },
                ...{ style: ({ width: p.progress + '%' }) },
            });
            /** @type {__VLS_StyleScopedClasses['prog-fill']} */ ;
        }
        __VLS_asFunctionalElement1(__VLS_intrinsics.footer, __VLS_intrinsics.footer)({
            ...{ class: "proj-foot hairline-top" },
        });
        /** @type {__VLS_StyleScopedClasses['proj-foot']} */ ;
        /** @type {__VLS_StyleScopedClasses['hairline-top']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "meta mono" },
        });
        /** @type {__VLS_StyleScopedClasses['meta']} */ ;
        /** @type {__VLS_StyleScopedClasses['mono']} */ ;
        if (p.fileCount) {
            (p.fileCount);
        }
        (p.moduleCount || 0);
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!!(__VLS_ctx.loading))
                        throw 0;
                    if (!!(__VLS_ctx.loadError))
                        throw 0;
                    if (!(__VLS_ctx.filtered.length))
                        throw 0;
                    return (__VLS_ctx.removeProject(p));
                    // @ts-ignore
                    [projectStatusMeta, projectStatusMeta, sheetNo, projectIcon, removeProject,];
                } },
            ...{ class: "del" },
            title: "删除项目",
            'aria-label': "删除项目",
        });
        /** @type {__VLS_StyleScopedClasses['del']} */ ;
        let __VLS_38;
        /** @ts-ignore @type { | typeof __VLS_components.IconTrash} */
        IconTrash;
        // @ts-ignore
        const __VLS_39 = __VLS_asFunctionalComponent1(__VLS_38, new __VLS_38({
            size: (14),
            strokeWidth: (1.75),
        }));
        const __VLS_40 = __VLS_39({
            size: (14),
            strokeWidth: (1.75),
        }, ...__VLS_functionalComponentArgsRest(__VLS_39));
        // @ts-ignore
        [];
    }
}
else {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "empty-sheet" },
    });
    /** @type {__VLS_StyleScopedClasses['empty-sheet']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.img)({
        ...{ class: "empty-img" },
        src: "../assets/sheet-empty-draft.png",
        alt: "",
    });
    /** @type {__VLS_StyleScopedClasses['empty-img']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.h3, __VLS_intrinsics.h3)({});
    (__VLS_ctx.keyword ? '没有找到项目' : '台账还空着');
    __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({});
    (__VLS_ctx.keyword ? '换个关键词试试' : '点击「新建项目」创建你的第一个 AI 协作项目');
    if (!__VLS_ctx.keyword) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (__VLS_ctx.createNew) },
            ...{ class: "btn btn-primary" },
        });
        /** @type {__VLS_StyleScopedClasses['btn']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
        let __VLS_43;
        /** @ts-ignore @type { | typeof __VLS_components.IconPlus} */
        IconPlus;
        // @ts-ignore
        const __VLS_44 = __VLS_asFunctionalComponent1(__VLS_43, new __VLS_43({
            size: (16),
            strokeWidth: (1.75),
        }));
        const __VLS_45 = __VLS_44({
            size: (16),
            strokeWidth: (1.75),
        }, ...__VLS_functionalComponentArgsRest(__VLS_44));
    }
}
if (__VLS_ctx.showCreate) {
    const __VLS_48 = CreateProjectSheet;
    // @ts-ignore
    const __VLS_49 = __VLS_asFunctionalComponent1(__VLS_48, new __VLS_48({
        ...{ 'onClose': {} },
        ...{ 'onCreated': {} },
    }));
    const __VLS_50 = __VLS_49({
        ...{ 'onClose': {} },
        ...{ 'onCreated': {} },
    }, ...__VLS_functionalComponentArgsRest(__VLS_49));
    let __VLS_53;
    const __VLS_54 = {
        /** @type {typeof __VLS_53.close} */
        onClose: (...[$event]) => {
            if (!(__VLS_ctx.showCreate))
                throw 0;
            return (__VLS_ctx.showCreate = false);
            // @ts-ignore
            [createNew, keyword, keyword, keyword, showCreate, showCreate,];
        },
    };
    const __VLS_55 = {
        /** @type {typeof __VLS_53.created} */
        onCreated: (__VLS_ctx.onProjectCreated),
    };
    var __VLS_51;
    var __VLS_52;
}
if (__VLS_ctx.showApiSettings) {
    const __VLS_56 = AppModal || AppModal;
    // @ts-ignore
    const __VLS_57 = __VLS_asFunctionalComponent1(__VLS_56, new __VLS_56({
        ...{ 'onClose': {} },
        title: "API 设置",
        sheet: "SET-01",
        width: "640px",
    }));
    const __VLS_58 = __VLS_57({
        ...{ 'onClose': {} },
        title: "API 设置",
        sheet: "SET-01",
        width: "640px",
    }, ...__VLS_functionalComponentArgsRest(__VLS_57));
    let __VLS_61;
    const __VLS_62 = {
        /** @type {typeof __VLS_61.close} */
        onClose: (...[$event]) => {
            if (!(__VLS_ctx.showApiSettings))
                throw 0;
            return (__VLS_ctx.showApiSettings = false);
            // @ts-ignore
            [onProjectCreated, showApiSettings, showApiSettings,];
        },
    };
    const { default: __VLS_63 } = __VLS_59.slots;
    __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
        ...{ class: "api-tip dim" },
    });
    /** @type {__VLS_StyleScopedClasses['api-tip']} */ ;
    /** @type {__VLS_StyleScopedClasses['dim']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "provider" },
    });
    /** @type {__VLS_StyleScopedClasses['provider']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "provider-head" },
    });
    /** @type {__VLS_StyleScopedClasses['provider-head']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "provider-name" },
    });
    /** @type {__VLS_StyleScopedClasses['provider-name']} */ ;
    (__VLS_ctx.cfg.modelKind === 'openai' ? 'OpenAI 兼容端点' : 'DeepSeek');
    if (__VLS_ctx.maskedKey && __VLS_ctx.maskedKey !== '未配置') {
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "provider-key-state" },
        });
        /** @type {__VLS_StyleScopedClasses['provider-key-state']} */ ;
        const __VLS_64 = StampSeal;
        // @ts-ignore
        const __VLS_65 = __VLS_asFunctionalComponent1(__VLS_64, new __VLS_64({
            label: "Key 已配置",
            tone: "pass",
        }));
        const __VLS_66 = __VLS_65({
            label: "Key 已配置",
            tone: "pass",
        }, ...__VLS_functionalComponentArgsRest(__VLS_65));
        __VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
            ...{ class: "mono" },
        });
        /** @type {__VLS_StyleScopedClasses['mono']} */ ;
        (__VLS_ctx.maskedKey);
    }
    else {
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "provider-key-state" },
        });
        /** @type {__VLS_StyleScopedClasses['provider-key-state']} */ ;
        const __VLS_69 = StampSeal;
        // @ts-ignore
        const __VLS_70 = __VLS_asFunctionalComponent1(__VLS_69, new __VLS_69({
            label: "未配置 · 引擎走 .env",
            tone: "pencil",
        }));
        const __VLS_71 = __VLS_70({
            label: "未配置 · 引擎走 .env",
            tone: "pencil",
        }, ...__VLS_functionalComponentArgsRest(__VLS_70));
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
        ...{ class: "prow" },
    });
    /** @type {__VLS_StyleScopedClasses['prow']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "prow-k" },
    });
    /** @type {__VLS_StyleScopedClasses['prow-k']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.select, __VLS_intrinsics.select)({
        value: (__VLS_ctx.cfg.modelKind),
        ...{ class: "select" },
    });
    /** @type {__VLS_StyleScopedClasses['select']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
        value: "deepseek",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
        value: "openai",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
        ...{ class: "prow" },
    });
    /** @type {__VLS_StyleScopedClasses['prow']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "prow-k" },
    });
    /** @type {__VLS_StyleScopedClasses['prow-k']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
        value: (__VLS_ctx.cfg.modelUrl),
        ...{ class: "input" },
        type: "text",
        placeholder: (__VLS_ctx.cfg.modelKind === 'openai' ? '必填，如 http://localhost:11434/v1' : '留空 = https://api.deepseek.com/v1'),
    });
    /** @type {__VLS_StyleScopedClasses['input']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
        ...{ class: "prow" },
    });
    /** @type {__VLS_StyleScopedClasses['prow']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "prow-k" },
    });
    /** @type {__VLS_StyleScopedClasses['prow-k']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
        ...{ class: "input" },
        type: "password",
        placeholder: "粘贴新的 sk-... 覆盖；留空不动",
    });
    (__VLS_ctx.cfg.apiKey);
    /** @type {__VLS_StyleScopedClasses['input']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "prow prow-current" },
    });
    /** @type {__VLS_StyleScopedClasses['prow']} */ ;
    /** @type {__VLS_StyleScopedClasses['prow-current']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "prow-k" },
    });
    /** @type {__VLS_StyleScopedClasses['prow-k']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "prow-cur" },
    });
    /** @type {__VLS_StyleScopedClasses['prow-cur']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "mono" },
        ...{ class: ({ faint: !__VLS_ctx.llmConfigured }) },
    });
    /** @type {__VLS_StyleScopedClasses['mono']} */ ;
    /** @type {__VLS_StyleScopedClasses['faint']} */ ;
    (__VLS_ctx.maskedKey);
    if (__VLS_ctx.llmConfigured) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.showApiSettings))
                        throw 0;
                    if (!(__VLS_ctx.llmConfigured))
                        throw 0;
                    return (__VLS_ctx.requestClearKey());
                    // @ts-ignore
                    [llmConfigured, llmConfigured, maskedKey, maskedKey, maskedKey, maskedKey, cfg, cfg, cfg, cfg, cfg, requestClearKey,];
                } },
            type: "button",
            ...{ class: "btn btn-sm btn-ghost" },
            disabled: (__VLS_ctx.clearKeyRequested),
        });
        /** @type {__VLS_StyleScopedClasses['btn']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-ghost']} */ ;
        (__VLS_ctx.clearKeyRequested ? '保存后清空' : '清除已保存的 Key');
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
        ...{ class: "prow" },
    });
    /** @type {__VLS_StyleScopedClasses['prow']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "prow-k" },
    });
    /** @type {__VLS_StyleScopedClasses['prow-k']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
        value: (__VLS_ctx.cfg.modelName),
        ...{ class: "input" },
        type: "text",
        placeholder: "自填，以端点支持的名称为准",
    });
    /** @type {__VLS_StyleScopedClasses['input']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
        ...{ class: "prow" },
    });
    /** @type {__VLS_StyleScopedClasses['prow']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "prow-k" },
    });
    /** @type {__VLS_StyleScopedClasses['prow-k']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
        value: (__VLS_ctx.cfg.modelPro),
        ...{ class: "input" },
        type: "text",
        placeholder: "留空=不分层；填了则 pro 角色用它（自填）",
    });
    /** @type {__VLS_StyleScopedClasses['input']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
        ...{ class: "prow" },
    });
    /** @type {__VLS_StyleScopedClasses['prow']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "prow-k" },
    });
    /** @type {__VLS_StyleScopedClasses['prow-k']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
        value: (__VLS_ctx.cfg.roleModels),
        ...{ class: "input" },
        type: "text",
        placeholder: 'JSON，如 {"test":"pro","frontend":"pro","backend":"flash"}；留空=内置表(架构师/测试/前端 pro)',
    });
    /** @type {__VLS_StyleScopedClasses['input']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
        ...{ class: "prow" },
    });
    /** @type {__VLS_StyleScopedClasses['prow']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "prow-k" },
    });
    /** @type {__VLS_StyleScopedClasses['prow-k']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
        value: (__VLS_ctx.cfg.javaBaseUrl),
        ...{ class: "input" },
        type: "text",
        placeholder: "引擎回调 Java：http://localhost:8080",
    });
    /** @type {__VLS_StyleScopedClasses['input']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
        ...{ class: "prow" },
    });
    /** @type {__VLS_StyleScopedClasses['prow']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "prow-k" },
    });
    /** @type {__VLS_StyleScopedClasses['prow-k']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
        ...{ class: "input" },
        type: "number",
        min: "1",
        max: "720",
        placeholder: "30",
    });
    (__VLS_ctx.cfg.confirmTimeoutMin);
    /** @type {__VLS_StyleScopedClasses['input']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "prow" },
    });
    /** @type {__VLS_StyleScopedClasses['prow']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "prow-k" },
    });
    /** @type {__VLS_StyleScopedClasses['prow-k']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
        ...{ class: "check" },
    });
    /** @type {__VLS_StyleScopedClasses['check']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
        type: "checkbox",
    });
    (__VLS_ctx.cfg.smokeBuild);
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "dim" },
    });
    /** @type {__VLS_StyleScopedClasses['dim']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
        ...{ class: "prow" },
    });
    /** @type {__VLS_StyleScopedClasses['prow']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "prow-k" },
    });
    /** @type {__VLS_StyleScopedClasses['prow-k']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
        ...{ class: "input" },
        type: "number",
        min: "1",
        max: "16",
        placeholder: "6",
    });
    (__VLS_ctx.cfg.llmConcurrency);
    /** @type {__VLS_StyleScopedClasses['input']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "prow-note dim" },
    });
    /** @type {__VLS_StyleScopedClasses['prow-note']} */ ;
    /** @type {__VLS_StyleScopedClasses['dim']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
        ...{ class: "prow" },
    });
    /** @type {__VLS_StyleScopedClasses['prow']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "prow-k" },
    });
    /** @type {__VLS_StyleScopedClasses['prow-k']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
        ...{ class: "input" },
        type: "number",
        min: "1",
        max: "12",
        placeholder: "5",
    });
    (__VLS_ctx.cfg.stationSlots);
    /** @type {__VLS_StyleScopedClasses['input']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "prow-note dim" },
    });
    /** @type {__VLS_StyleScopedClasses['prow-note']} */ ;
    /** @type {__VLS_StyleScopedClasses['dim']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "prow" },
    });
    /** @type {__VLS_StyleScopedClasses['prow']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "prow-k" },
    });
    /** @type {__VLS_StyleScopedClasses['prow-k']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
        ...{ class: "check" },
    });
    /** @type {__VLS_StyleScopedClasses['check']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
        type: "checkbox",
    });
    (__VLS_ctx.cfg.toolMode);
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "dim" },
    });
    /** @type {__VLS_StyleScopedClasses['dim']} */ ;
    {
        const { footer: __VLS_74 } = __VLS_59.slots;
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.showApiSettings))
                        throw 0;
                    return (__VLS_ctx.showApiSettings = false);
                    // @ts-ignore
                    [showApiSettings, cfg, cfg, cfg, cfg, cfg, cfg, cfg, cfg, cfg, clearKeyRequested, clearKeyRequested,];
                } },
            ...{ class: "btn btn-sm" },
        });
        /** @type {__VLS_StyleScopedClasses['btn']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (__VLS_ctx.runTest) },
            ...{ class: "btn btn-sm" },
            disabled: (__VLS_ctx.testing),
        });
        /** @type {__VLS_StyleScopedClasses['btn']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
        if (!__VLS_ctx.testing) {
            let __VLS_75;
            /** @ts-ignore @type { | typeof __VLS_components.IconWritingSign} */
            IconWritingSign;
            // @ts-ignore
            const __VLS_76 = __VLS_asFunctionalComponent1(__VLS_75, new __VLS_75({
                size: (14),
                strokeWidth: (1.75),
            }));
            const __VLS_77 = __VLS_76({
                size: (14),
                strokeWidth: (1.75),
            }, ...__VLS_functionalComponentArgsRest(__VLS_76));
        }
        (__VLS_ctx.testing ? '测试中…' : '测试连接');
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (__VLS_ctx.saveApiSettings) },
            ...{ class: "btn btn-sm btn-primary" },
            disabled: (__VLS_ctx.saving),
        });
        /** @type {__VLS_StyleScopedClasses['btn']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
        (__VLS_ctx.saving ? '保存中…' : '保存');
        // @ts-ignore
        [runTest, testing, testing, testing, saveApiSettings, saving, saving,];
    }
    // @ts-ignore
    [];
    var __VLS_59;
    var __VLS_60;
}
// @ts-ignore
[];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
