import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { IconCheck, IconCompass, IconDownload, IconFlame, IconLayoutKanban, IconPlayerPlay, IconShieldCheck, IconUsers, } from '@tabler/icons-vue';
import TopBar from '../components/ui/TopBar.vue';
import StampSeal from '../components/ui/StampSeal.vue';
import { downloadProjectZip, fetchProjectById } from '../api/project';
import { fetchRunStatus, startProjectRun, stopProjectRun } from '../api/projectRun';
import { usePolling } from '../composables/usePolling';
import { projectStatusMeta } from '../constants/status';
import { ENVELOPE_KEYS, parseEnvelopeArray, toDisplayList } from '../utils/json';
import { confirmDialog } from '../utils/confirm';
import { toast } from '../utils/toast';
const router = useRouter();
const route = useRoute();
// ===== 项目数据（真实接口） =====
const project = ref(null);
const loading = ref(true);
/** 后端 JSON 列解析成字符串清单：认裸数组，也认引擎写的信封对象（见 utils/json.ts） */
function parseJsonArr(raw, keys = ENVELOPE_KEYS.businessModules) {
    return toDisplayList(parseEnvelopeArray(raw, keys));
}
/**
 * 功能清单：优先架构师的业务模块（business_modules，最终交付物），
 * 没有就退到 PM 澄清阶段的已确认功能（clarified_req）。
 * ⚠️ 9/18：原来只读 business_modules —— 项目刚澄清完、架构师还没跑时，
 * 这一页会显示"还没有确认功能"，可数据就在 clarified_req 里（需求对话页同批修）。
 * 两列是两个阶段的产物，见 utils/json.ts 顶部说明。
 */
const features = computed(() => {
    const modules = parseJsonArr(project.value?.businessModules);
    return modules.length ? modules : parseJsonArr(project.value?.clarifiedReq, ENVELOPE_KEYS.clarifiedReq);
});
const plan = computed(() => {
    if (!project.value?.devPlan)
        return [];
    try {
        const v = JSON.parse(project.value.devPlan);
        // 引擎 PM 存的是 { phases: [...] }，网页手写可能是数组——两种都认
        const arr = Array.isArray(v) ? v : v?.phases;
        return Array.isArray(arr) ? arr : [];
    }
    catch {
        return [];
    }
});
// ===== 项目状态（图章口径：颜色走 constants/status 单一来源） =====
const statusMeta = computed(() => projectStatusMeta(project.value?.status || 'draft'));
const projectName = computed(() => project.value?.name || '项目 #' + route.params.id);
/**
 * 项目描述折叠（9/17）：需求原文动辄几百字，原来只限了 width 没限高度，
 * 直接把标题栏撑满一屏，把下面六个入口挤下去。
 * 现在默认折 3 行；超过这个字数才出现「展开全文」——短描述不该配一个没用的按钮。
 */
const DESC_CLAMP_CHARS = 90;
const descExpanded = ref(false);
const descText = computed(() => project.value?.description || '暂无描述');
const descCollapsible = computed(() => descText.value.length > DESC_CLAMP_CHARS);
/** 返回项目列表 */
const backLabel = '项目列表';
function goBack() {
    router.push('/projects');
}
// ===== 阶段 2 点火：开工 / 停止 / 进程状态轮询 =====
const runStatus = ref(null);
const starting = ref(false);
const stopping = ref(false);
/**
 * 路由 id → 有效数字；拿不到就 null。
 * ⚠️ 9/17 修「一直弹系统繁忙」：原来两个轮询直接 `Number(route.params.id)`，
 * 地址里没有有效项目号时得 NaN → 请求打成 /api/project/NaN 与 /api/project-run/NaN，
 * 后端报「参数 id 需要是 Long，收到 "NaN"」，10s 一轮 = 无限弹窗。
 * 所有按 id 发请求的地方都必须先过这道闸。
 */
const routeProjectId = computed(() => {
    const n = Number(route.params.id);
    return Number.isFinite(n) && n > 0 ? n : null;
});
async function refreshProject() {
    const id = routeProjectId.value;
    if (id == null)
        return; // 地址里没有有效项目号：不发请求（发出去只会换来一个注定失败的 400）
    project.value = await fetchProjectById(id);
}
async function refreshRunStatus() {
    const id = routeProjectId.value;
    if (id == null) {
        runStatus.value = null;
        return;
    }
    try {
        runStatus.value = await fetchRunStatus(id);
    }
    catch {
        runStatus.value = null; // 无账/后端未就绪：按钮组按未运行处理（start 接口自有真错提示）
    }
}
/** 引擎是否在跑（进程判活由后端两级完成，前端只看结论） */
const isRunning = computed(() => runStatus.value?.running === true);
const canStart = computed(() => {
    if (isRunning.value || !project.value)
        return false;
    const s = project.value.status;
    // 开工窗口：方案已确认(planning) / 暂停·失败·未验证续跑 /
    //          执行中但对账账本 stopped（手动停过）
    // blocked=引擎"跑完但交付关未验证"的终态，不放进来的话这类项目在界面上
    // 既没有开工也没有停止按钮，卡死无法捞回来。
    return s === 'planning' || s === 'paused' || s === 'failed' || s === 'blocked'
        || (s === 'executing' && runStatus.value?.runState === 'stopped');
});
const canStop = computed(() => isRunning.value || project.value?.status === 'executing');
const startLabel = computed(() => {
    const s = project.value?.status;
    return s === 'paused' || s === 'failed' || s === 'blocked'
        || (s === 'executing' && runStatus.value?.runState === 'stopped')
        ? '继续开工'
        : '开工';
});
async function startWork() {
    const id = routeProjectId.value;
    if (id == null) {
        toast.error('地址里没有有效的项目号');
        return;
    }
    starting.value = true;
    try {
        await startProjectRun(id);
        toast.success('引擎已拉起，流水线开跑——去执行面板看任务流转');
        await Promise.all([refreshProject(), refreshRunStatus()]);
        router.push({ name: 'execution', params: { id: route.params.id } });
    }
    finally {
        starting.value = false;
    }
}
async function stopWork() {
    const id = routeProjectId.value;
    if (id == null) {
        toast.error('地址里没有有效的项目号');
        return;
    }
    const ok = await confirmDialog({
        title: '停止运行',
        body: '将终止引擎进程并暂停续拉（在途任务停在当前粒度，续开工从断点接上）。确定停止？',
        ok: '停止',
        cancel: '再想想',
        danger: true,
    });
    if (!ok)
        return;
    stopping.value = true;
    try {
        await stopProjectRun(id);
        toast.success('已停止（对账器不会再自动续拉，点「继续开工」可恢复）');
        await Promise.all([refreshProject(), refreshRunStatus()]);
    }
    finally {
        stopping.value = false;
    }
}
/** 10s 轻轮询：项目状态 + 进程账本（不接住 start 表就不走——9/17 自查逮住；卸载自动停表） */
const { start: startPolling } = usePolling(() => {
    void refreshProject().catch(() => { });
    void refreshRunStatus();
}, 10_000);
startPolling();
// 首帧：先取项目（结束骨架），再探进程账本
void refreshProject()
    .catch(() => { })
    .finally(() => {
    loading.value = false;
});
void refreshRunStatus();
/* 9/17：删掉 scrollTo() —— 它只服务于原来那张「项目概览」入口卡，而那张卡本身是个
   假模块（点它只是滚到同页下方的 #overview 区块）。入口卡已换成「验收与证据」。
   下方那个 id="overview" 的容器保留：路由 push 时带的 #overview 锚点仍要靠它。 */
/** 下载 zip（audit F1：原实现 <a href> 直导航——不带 Authorization、dev 下无 /api 代理，必坏包。
 *  改走 axios 实例 blob 下载，request.ts 拦截器已放行 Blob 不拆 Result 信封） */
async function downloadZip() {
    const id = routeProjectId.value;
    if (id == null) {
        toast.error('地址里没有有效的项目号');
        return;
    }
    try {
        const blob = await downloadProjectZip(id);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${projectName.value}.zip`;
        a.click();
        URL.revokeObjectURL(url);
    }
    catch {
        // 失败已由响应拦截器统一弹 toast，此处不重复提示
    }
}
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['desc-toggle']} */ ;
/** @type {__VLS_StyleScopedClasses['desc-toggle']} */ ;
/** @type {__VLS_StyleScopedClasses['entry-card']} */ ;
/** @type {__VLS_StyleScopedClasses['entry-card']} */ ;
/** @type {__VLS_StyleScopedClasses['grid-2']} */ ;
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
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (__VLS_ctx.goBack) },
        ...{ class: "tb-back btn btn-sm btn-ghost" },
    });
    /** @type {__VLS_StyleScopedClasses['tb-back']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-ghost']} */ ;
    (__VLS_ctx.backLabel);
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "tb-title" },
    });
    /** @type {__VLS_StyleScopedClasses['tb-title']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "dim" },
    });
    /** @type {__VLS_StyleScopedClasses['dim']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
    (__VLS_ctx.projectName);
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "sheet-no" },
    });
    /** @type {__VLS_StyleScopedClasses['sheet-no']} */ ;
    (__VLS_ctx.routeProjectId ? String(__VLS_ctx.routeProjectId).padStart(4, '0') : '----');
    // @ts-ignore
    [goBack, backLabel, projectName, routeProjectId, routeProjectId,];
}
{
    const { right: __VLS_7 } = __VLS_3.slots;
    if (__VLS_ctx.runStatus?.running) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "run-hint" },
        });
        /** @type {__VLS_StyleScopedClasses['run-hint']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "lamp lamp-on lamp-live" },
        });
        /** @type {__VLS_StyleScopedClasses['lamp']} */ ;
        /** @type {__VLS_StyleScopedClasses['lamp-on']} */ ;
        /** @type {__VLS_StyleScopedClasses['lamp-live']} */ ;
        (__VLS_ctx.runStatus.pid);
        (__VLS_ctx.runStatus.restartCount ? ` · 续拉 ${__VLS_ctx.runStatus.restartCount}` : '');
    }
    if (__VLS_ctx.canStop) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (__VLS_ctx.stopWork) },
            ...{ class: "btn btn-sm btn-danger" },
            disabled: (__VLS_ctx.stopping),
        });
        /** @type {__VLS_StyleScopedClasses['btn']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-danger']} */ ;
        (__VLS_ctx.stopping ? '停止中…' : '停止');
    }
    if (__VLS_ctx.canStart) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (__VLS_ctx.startWork) },
            ...{ class: "btn btn-primary" },
            disabled: (__VLS_ctx.starting),
        });
        /** @type {__VLS_StyleScopedClasses['btn']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
        if (!__VLS_ctx.starting) {
            let __VLS_8;
            /** @ts-ignore @type { | typeof __VLS_components.IconFlame} */
            IconFlame;
            // @ts-ignore
            const __VLS_9 = __VLS_asFunctionalComponent1(__VLS_8, new __VLS_8({
                size: (15),
                strokeWidth: (1.75),
            }));
            const __VLS_10 = __VLS_9({
                size: (15),
                strokeWidth: (1.75),
            }, ...__VLS_functionalComponentArgsRest(__VLS_9));
        }
        (__VLS_ctx.starting ? '拉起中…' : __VLS_ctx.startLabel);
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                return (__VLS_ctx.router.push({ name: 'execution', params: { id: __VLS_ctx.route.params.id } }));
                // @ts-ignore
                [runStatus, runStatus, runStatus, runStatus, canStop, stopWork, stopping, stopping, canStart, startWork, starting, starting, starting, startLabel, router, route,];
            } },
        ...{ class: "btn btn-primary" },
    });
    /** @type {__VLS_StyleScopedClasses['btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
    // @ts-ignore
    [];
}
// @ts-ignore
[];
var __VLS_3;
__VLS_asFunctionalElement1(__VLS_intrinsics.main, __VLS_intrinsics.main)({
    ...{ class: "page" },
});
/** @type {__VLS_StyleScopedClasses['page']} */ ;
if (__VLS_ctx.loading && !__VLS_ctx.project) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "skeleton sk-head" },
    });
    /** @type {__VLS_StyleScopedClasses['skeleton']} */ ;
    /** @type {__VLS_StyleScopedClasses['sk-head']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "entry-grid" },
    });
    /** @type {__VLS_StyleScopedClasses['entry-grid']} */ ;
    for (const [i] of __VLS_vFor((6))) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            key: (i),
            ...{ class: "skeleton sk-entry" },
        });
        /** @type {__VLS_StyleScopedClasses['skeleton']} */ ;
        /** @type {__VLS_StyleScopedClasses['sk-entry']} */ ;
        // @ts-ignore
        [loading, project,];
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "grid-2" },
    });
    /** @type {__VLS_StyleScopedClasses['grid-2']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "skeleton sk-panel" },
    });
    /** @type {__VLS_StyleScopedClasses['skeleton']} */ ;
    /** @type {__VLS_StyleScopedClasses['sk-panel']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "skeleton sk-panel" },
    });
    /** @type {__VLS_StyleScopedClasses['skeleton']} */ ;
    /** @type {__VLS_StyleScopedClasses['sk-panel']} */ ;
}
else {
    __VLS_asFunctionalElement1(__VLS_intrinsics.section, __VLS_intrinsics.section)({
        ...{ class: "panel head-card" },
    });
    /** @type {__VLS_StyleScopedClasses['panel']} */ ;
    /** @type {__VLS_StyleScopedClasses['head-card']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "head-main" },
    });
    /** @type {__VLS_StyleScopedClasses['head-main']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.h1, __VLS_intrinsics.h1)({
        ...{ class: "head-title" },
    });
    /** @type {__VLS_StyleScopedClasses['head-title']} */ ;
    (__VLS_ctx.projectName);
    const __VLS_13 = StampSeal;
    // @ts-ignore
    const __VLS_14 = __VLS_asFunctionalComponent1(__VLS_13, new __VLS_13({
        label: (__VLS_ctx.statusMeta.label),
        tone: (__VLS_ctx.statusMeta.tone),
    }));
    const __VLS_15 = __VLS_14({
        label: (__VLS_ctx.statusMeta.label),
        tone: (__VLS_ctx.statusMeta.tone),
    }, ...__VLS_functionalComponentArgsRest(__VLS_14));
    __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
        ...{ class: "desc" },
        ...{ class: ({ 'desc-open': __VLS_ctx.descExpanded || !__VLS_ctx.descCollapsible }) },
    });
    /** @type {__VLS_StyleScopedClasses['desc']} */ ;
    /** @type {__VLS_StyleScopedClasses['desc-open']} */ ;
    (__VLS_ctx.descText);
    if (__VLS_ctx.descCollapsible) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!!(__VLS_ctx.loading && !__VLS_ctx.project))
                        throw 0;
                    if (!(__VLS_ctx.descCollapsible))
                        throw 0;
                    return (__VLS_ctx.descExpanded = !__VLS_ctx.descExpanded);
                    // @ts-ignore
                    [projectName, statusMeta, statusMeta, descExpanded, descExpanded, descExpanded, descCollapsible, descCollapsible, descText,];
                } },
            type: "button",
            ...{ class: "desc-toggle" },
            'aria-expanded': (__VLS_ctx.descExpanded),
        });
        /** @type {__VLS_StyleScopedClasses['desc-toggle']} */ ;
        (__VLS_ctx.descExpanded ? '收起' : '展开全文');
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.nav, __VLS_intrinsics.nav)({
        ...{ class: "entry-grid" },
        'aria-label': "项目工作台",
    });
    /** @type {__VLS_StyleScopedClasses['entry-grid']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!!(__VLS_ctx.loading && !__VLS_ctx.project))
                    throw 0;
                return (__VLS_ctx.router.push({ name: 'execution', params: { id: __VLS_ctx.route.params.id } }));
                // @ts-ignore
                [router, route, descExpanded, descExpanded,];
            } },
        ...{ class: "entry-card" },
    });
    /** @type {__VLS_StyleScopedClasses['entry-card']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "entry-ico" },
    });
    /** @type {__VLS_StyleScopedClasses['entry-ico']} */ ;
    let __VLS_18;
    /** @ts-ignore @type { | typeof __VLS_components.IconPlayerPlay} */
    IconPlayerPlay;
    // @ts-ignore
    const __VLS_19 = __VLS_asFunctionalComponent1(__VLS_18, new __VLS_18({
        size: (19),
        strokeWidth: (1.75),
    }));
    const __VLS_20 = __VLS_19({
        size: (19),
        strokeWidth: (1.75),
    }, ...__VLS_functionalComponentArgsRest(__VLS_19));
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "entry-name" },
    });
    /** @type {__VLS_StyleScopedClasses['entry-name']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "entry-desc" },
    });
    /** @type {__VLS_StyleScopedClasses['entry-desc']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!!(__VLS_ctx.loading && !__VLS_ctx.project))
                    throw 0;
                return (__VLS_ctx.router.push({ name: 'pm', params: { id: __VLS_ctx.route.params.id } }));
                // @ts-ignore
                [router, route,];
            } },
        ...{ class: "entry-card" },
    });
    /** @type {__VLS_StyleScopedClasses['entry-card']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "entry-ico" },
    });
    /** @type {__VLS_StyleScopedClasses['entry-ico']} */ ;
    let __VLS_23;
    /** @ts-ignore @type { | typeof __VLS_components.IconUsers} */
    IconUsers;
    // @ts-ignore
    const __VLS_24 = __VLS_asFunctionalComponent1(__VLS_23, new __VLS_23({
        size: (19),
        strokeWidth: (1.75),
    }));
    const __VLS_25 = __VLS_24({
        size: (19),
        strokeWidth: (1.75),
    }, ...__VLS_functionalComponentArgsRest(__VLS_24));
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "entry-name" },
    });
    /** @type {__VLS_StyleScopedClasses['entry-name']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "entry-desc" },
    });
    /** @type {__VLS_StyleScopedClasses['entry-desc']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!!(__VLS_ctx.loading && !__VLS_ctx.project))
                    throw 0;
                return (__VLS_ctx.router.push({ name: 'architect', params: { id: __VLS_ctx.route.params.id }, query: { role: 'architect' } }));
                // @ts-ignore
                [router, route,];
            } },
        ...{ class: "entry-card" },
    });
    /** @type {__VLS_StyleScopedClasses['entry-card']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "entry-ico" },
    });
    /** @type {__VLS_StyleScopedClasses['entry-ico']} */ ;
    let __VLS_28;
    /** @ts-ignore @type { | typeof __VLS_components.IconCompass} */
    IconCompass;
    // @ts-ignore
    const __VLS_29 = __VLS_asFunctionalComponent1(__VLS_28, new __VLS_28({
        size: (19),
        strokeWidth: (1.75),
    }));
    const __VLS_30 = __VLS_29({
        size: (19),
        strokeWidth: (1.75),
    }, ...__VLS_functionalComponentArgsRest(__VLS_29));
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "entry-name" },
    });
    /** @type {__VLS_StyleScopedClasses['entry-name']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "entry-desc" },
    });
    /** @type {__VLS_StyleScopedClasses['entry-desc']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!!(__VLS_ctx.loading && !__VLS_ctx.project))
                    throw 0;
                return (__VLS_ctx.router.push({ name: 'task-board', params: { id: __VLS_ctx.route.params.id } }));
                // @ts-ignore
                [router, route,];
            } },
        ...{ class: "entry-card" },
    });
    /** @type {__VLS_StyleScopedClasses['entry-card']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "entry-ico" },
    });
    /** @type {__VLS_StyleScopedClasses['entry-ico']} */ ;
    let __VLS_33;
    /** @ts-ignore @type { | typeof __VLS_components.IconLayoutKanban} */
    IconLayoutKanban;
    // @ts-ignore
    const __VLS_34 = __VLS_asFunctionalComponent1(__VLS_33, new __VLS_33({
        size: (19),
        strokeWidth: (1.75),
    }));
    const __VLS_35 = __VLS_34({
        size: (19),
        strokeWidth: (1.75),
    }, ...__VLS_functionalComponentArgsRest(__VLS_34));
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "entry-name" },
    });
    /** @type {__VLS_StyleScopedClasses['entry-name']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "entry-desc" },
    });
    /** @type {__VLS_StyleScopedClasses['entry-desc']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!!(__VLS_ctx.loading && !__VLS_ctx.project))
                    throw 0;
                return (__VLS_ctx.router.push({ name: 'verification', params: { id: __VLS_ctx.route.params.id } }));
                // @ts-ignore
                [router, route,];
            } },
        ...{ class: "entry-card" },
    });
    /** @type {__VLS_StyleScopedClasses['entry-card']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "entry-ico" },
    });
    /** @type {__VLS_StyleScopedClasses['entry-ico']} */ ;
    let __VLS_38;
    /** @ts-ignore @type { | typeof __VLS_components.IconShieldCheck} */
    IconShieldCheck;
    // @ts-ignore
    const __VLS_39 = __VLS_asFunctionalComponent1(__VLS_38, new __VLS_38({
        size: (19),
        strokeWidth: (1.75),
    }));
    const __VLS_40 = __VLS_39({
        size: (19),
        strokeWidth: (1.75),
    }, ...__VLS_functionalComponentArgsRest(__VLS_39));
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "entry-name" },
    });
    /** @type {__VLS_StyleScopedClasses['entry-name']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "entry-desc" },
    });
    /** @type {__VLS_StyleScopedClasses['entry-desc']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (__VLS_ctx.downloadZip) },
        ...{ class: "entry-card" },
    });
    /** @type {__VLS_StyleScopedClasses['entry-card']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "entry-ico" },
    });
    /** @type {__VLS_StyleScopedClasses['entry-ico']} */ ;
    let __VLS_43;
    /** @ts-ignore @type { | typeof __VLS_components.IconDownload} */
    IconDownload;
    // @ts-ignore
    const __VLS_44 = __VLS_asFunctionalComponent1(__VLS_43, new __VLS_43({
        size: (19),
        strokeWidth: (1.75),
    }));
    const __VLS_45 = __VLS_44({
        size: (19),
        strokeWidth: (1.75),
    }, ...__VLS_functionalComponentArgsRest(__VLS_44));
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "entry-name" },
    });
    /** @type {__VLS_StyleScopedClasses['entry-name']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "entry-desc" },
    });
    /** @type {__VLS_StyleScopedClasses['entry-desc']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        id: "overview",
        ...{ class: "grid-2" },
    });
    /** @type {__VLS_StyleScopedClasses['grid-2']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.section, __VLS_intrinsics.section)({
        ...{ class: "panel card" },
    });
    /** @type {__VLS_StyleScopedClasses['panel']} */ ;
    /** @type {__VLS_StyleScopedClasses['card']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.header, __VLS_intrinsics.header)({
        ...{ class: "panel-head" },
    });
    /** @type {__VLS_StyleScopedClasses['panel-head']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.h3, __VLS_intrinsics.h3)({
        ...{ class: "panel-title" },
    });
    /** @type {__VLS_StyleScopedClasses['panel-title']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "card-body" },
    });
    /** @type {__VLS_StyleScopedClasses['card-body']} */ ;
    if (__VLS_ctx.features.length) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.ul, __VLS_intrinsics.ul)({
            ...{ class: "rows feature-list" },
        });
        /** @type {__VLS_StyleScopedClasses['rows']} */ ;
        /** @type {__VLS_StyleScopedClasses['feature-list']} */ ;
        for (const [f, i] of __VLS_vFor((__VLS_ctx.features))) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.li, __VLS_intrinsics.li)({
                key: (i),
                ...{ class: "row feature-item" },
            });
            /** @type {__VLS_StyleScopedClasses['row']} */ ;
            /** @type {__VLS_StyleScopedClasses['feature-item']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "fico" },
            });
            /** @type {__VLS_StyleScopedClasses['fico']} */ ;
            let __VLS_48;
            /** @ts-ignore @type { | typeof __VLS_components.IconCheck} */
            IconCheck;
            // @ts-ignore
            const __VLS_49 = __VLS_asFunctionalComponent1(__VLS_48, new __VLS_48({
                size: (14),
                strokeWidth: (1.75),
            }));
            const __VLS_50 = __VLS_49({
                size: (14),
                strokeWidth: (1.75),
            }, ...__VLS_functionalComponentArgsRest(__VLS_49));
            (f);
            // @ts-ignore
            [downloadZip, features, features,];
        }
    }
    else {
        __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
            ...{ class: "empty-tip faint" },
        });
        /** @type {__VLS_StyleScopedClasses['empty-tip']} */ ;
        /** @type {__VLS_StyleScopedClasses['faint']} */ ;
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.section, __VLS_intrinsics.section)({
        ...{ class: "panel card" },
    });
    /** @type {__VLS_StyleScopedClasses['panel']} */ ;
    /** @type {__VLS_StyleScopedClasses['card']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.header, __VLS_intrinsics.header)({
        ...{ class: "panel-head" },
    });
    /** @type {__VLS_StyleScopedClasses['panel-head']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.h3, __VLS_intrinsics.h3)({
        ...{ class: "panel-title" },
    });
    /** @type {__VLS_StyleScopedClasses['panel-title']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "card-body" },
    });
    /** @type {__VLS_StyleScopedClasses['card-body']} */ ;
    if (__VLS_ctx.plan.length) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "plan-list" },
        });
        /** @type {__VLS_StyleScopedClasses['plan-list']} */ ;
        for (const [p, i] of __VLS_vFor((__VLS_ctx.plan))) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                key: (i),
                ...{ class: "plan-item" },
            });
            /** @type {__VLS_StyleScopedClasses['plan-item']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "plan-phase" },
            });
            /** @type {__VLS_StyleScopedClasses['plan-phase']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "plan-dot" },
            });
            /** @type {__VLS_StyleScopedClasses['plan-dot']} */ ;
            (i + 1);
            (p.name);
            if (p.tasks?.length) {
                __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                    ...{ class: "plan-tasks" },
                });
                /** @type {__VLS_StyleScopedClasses['plan-tasks']} */ ;
                for (const [t] of __VLS_vFor((p.tasks))) {
                    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                        key: (t),
                        ...{ class: "plan-task-tag mono" },
                    });
                    /** @type {__VLS_StyleScopedClasses['plan-task-tag']} */ ;
                    /** @type {__VLS_StyleScopedClasses['mono']} */ ;
                    (t);
                    // @ts-ignore
                    [plan, plan,];
                }
            }
            // @ts-ignore
            [];
        }
    }
    else {
        __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
            ...{ class: "empty-tip faint" },
        });
        /** @type {__VLS_StyleScopedClasses['empty-tip']} */ ;
        /** @type {__VLS_StyleScopedClasses['faint']} */ ;
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "actions" },
    });
    /** @type {__VLS_StyleScopedClasses['actions']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (__VLS_ctx.downloadZip) },
        ...{ class: "btn btn-primary" },
    });
    /** @type {__VLS_StyleScopedClasses['btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
    let __VLS_53;
    /** @ts-ignore @type { | typeof __VLS_components.IconDownload} */
    IconDownload;
    // @ts-ignore
    const __VLS_54 = __VLS_asFunctionalComponent1(__VLS_53, new __VLS_53({
        size: (15),
        strokeWidth: (1.75),
    }));
    const __VLS_55 = __VLS_54({
        size: (15),
        strokeWidth: (1.75),
    }, ...__VLS_functionalComponentArgsRest(__VLS_54));
}
// @ts-ignore
[downloadZip,];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
