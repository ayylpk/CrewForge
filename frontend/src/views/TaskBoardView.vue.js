import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { IconPlus, IconRefresh, IconRotate, IconX } from '@tabler/icons-vue';
import TopBar from '../components/ui/TopBar.vue';
import AppModal from '../components/ui/AppModal.vue';
import StampSeal from '../components/ui/StampSeal.vue';
import { fetchProjectById } from '../api/project';
import { createTask, fetchTaskById, fetchTasks, retryTask, summarizeTaskQuality, updateTaskStatus, } from '../api/task';
import { TASK_STATUS, PROJECT_STATUS } from '../constants/status';
import { usePolling } from '../composables/usePolling';
import { toast } from '../utils/toast';
const router = useRouter();
const route = useRoute();
/** 路由 id → 有效数字；拿不到就 null（贯穿全页的守卫，别让 NaN 进 URL） */
const projectId = computed(() => {
    const n = Number(route.params.id);
    return Number.isFinite(n) && n > 0 ? n : null;
});
const projectName = ref('');
const projectStatus = ref('');
const tasks = ref([]);
const loading = ref(false);
const busyId = ref(null);
/** 看板四列（与 constants/status 同一份口径） */
const COLUMNS = ['todo', 'doing', 'done', 'failed'];
const byStatus = computed(() => {
    const m = { todo: [], doing: [], done: [], failed: [] };
    for (const t of tasks.value)
        (m[t.status] ??= []).push(t);
    return m;
});
/** 质量摘要（复用 api/task.ts 里已有的纯函数，不重写一份统计口径） */
const quality = computed(() => summarizeTaskQuality(tasks.value));
const projectTone = computed(() => PROJECT_STATUS[projectStatus.value]?.tone || 'pencil');
const projectLabel = computed(() => PROJECT_STATUS[projectStatus.value]?.label || projectStatus.value || '—');
async function loadTasks() {
    const id = projectId.value;
    if (id == null)
        return;
    try {
        tasks.value = await fetchTasks(id);
    }
    catch {
        /* 轮询静默：拦截器已提示，保留已有数据 */
    }
}
async function load() {
    const id = projectId.value;
    if (id == null)
        return;
    loading.value = true;
    try {
        const p = await fetchProjectById(id);
        projectName.value = p.name;
        projectStatus.value = p.status;
    }
    catch {
        projectName.value = '项目 #' + route.params.id;
    }
    finally {
        loading.value = false;
    }
    await loadTasks();
}
onMounted(async () => {
    await load();
    startPolling();
});
/** 10s 轮询任务（与执行面板同密度，别改） */
const { start: startPolling } = usePolling(() => {
    void loadTasks();
}, 10_000);
function taskTone(s) {
    return TASK_STATUS[s]?.tone || 'pencil';
}
function taskLabel(s) {
    return TASK_STATUS[s]?.label || s;
}
/* ===== 任务详情 ===== */
const detail = ref(null);
const detailLoading = ref(false);
async function openDetail(t) {
    detailLoading.value = true;
    // 先用列表里那份把弹窗撑开（立即有反馈），再拉全文覆盖（列表可能不含 result 全文）
    detail.value = t;
    try {
        const id = projectId.value;
        if (id == null)
            return;
        detail.value = await fetchTaskById(t.id);
    }
    catch {
        /* 拉不到就显示列表那份 */
    }
    finally {
        detailLoading.value = false;
    }
}
/* ===== 重跑 ===== */
async function doRetry(t) {
    busyId.value = t.id;
    try {
        await retryTask(t.id);
        toast.success(`「${t.title}」已重新排队（第 ${(t.retryCount ?? 0) + 1} 次）`);
        if (detail.value?.id === t.id)
            detail.value = { ...detail.value, status: 'todo', retryCount: (t.retryCount ?? 0) + 1 };
        await loadTasks();
    }
    finally {
        busyId.value = null;
    }
}
/* ===== 手动改状态（激活 PUT /api/task/{id}/status） ===== */
async function changeStatus(t, next) {
    if (next === t.status)
        return;
    busyId.value = t.id;
    try {
        await updateTaskStatus(t.id, next);
        toast.success(`「${t.title}」→ ${taskLabel(next)}`);
        if (detail.value?.id === t.id)
            detail.value = { ...detail.value, status: next };
        await loadTasks();
    }
    catch {
        /* 拦截器已提示 */
    }
    finally {
        busyId.value = null;
    }
}
/* ===== 手动建任务（激活 POST /api/task） ===== */
const showCreate = ref(false);
const creating = ref(false);
const draft = ref({ title: '', phaseId: '', layer: 'backend', assignee: '', description: '', acceptance: '' });
function openCreate() {
    draft.value = { title: '', phaseId: '', layer: 'backend', assignee: '', description: '', acceptance: '' };
    showCreate.value = true;
}
async function submitCreate() {
    const id = projectId.value;
    const title = draft.value.title.trim();
    if (id == null)
        return;
    if (!title) {
        toast.warning('请填写任务标题');
        return;
    }
    creating.value = true;
    try {
        await createTask({
            projectId: id,
            title,
            phaseId: draft.value.phaseId ? Number(draft.value.phaseId) : undefined,
            layer: draft.value.layer || undefined,
            assignee: draft.value.assignee.trim() || undefined,
            description: draft.value.description.trim() || undefined,
            acceptance: draft.value.acceptance.trim() || undefined,
        });
        toast.success('任务已创建（调度器会按需派发）');
        showCreate.value = false;
        await loadTasks();
    }
    finally {
        creating.value = false;
    }
}
/* 9/17：这里原本写了个 setMode()（改确认模式），但本页没有模式选择器 —— 那是执行面板的
   事（ExecutionView 顶栏）。写了不接线的函数就是死代码，故删。 */
const id4 = computed(() => String(route.params.id).padStart(4, '0'));
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['tb-title']} */ ;
/** @type {__VLS_StyleScopedClasses['board']} */ ;
/** @type {__VLS_StyleScopedClasses['board']} */ ;
/** @type {__VLS_StyleScopedClasses['ds-label']} */ ;
/** @type {__VLS_StyleScopedClasses['doc']} */ ;
/** @type {__VLS_StyleScopedClasses['err']} */ ;
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
        ...{ onClick: (...[$event]) => {
                return (__VLS_ctx.router.push(`/projects/${__VLS_ctx.route.params.id}`));
                // @ts-ignore
                [router, route,];
            } },
        ...{ class: "tb-back btn btn-sm btn-ghost" },
    });
    /** @type {__VLS_StyleScopedClasses['tb-back']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-ghost']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "tb-title" },
    });
    /** @type {__VLS_StyleScopedClasses['tb-title']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "dim" },
    });
    /** @type {__VLS_StyleScopedClasses['dim']} */ ;
    (__VLS_ctx.projectName || '项目 #' + __VLS_ctx.route.params.id);
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
    const __VLS_7 = StampSeal;
    // @ts-ignore
    const __VLS_8 = __VLS_asFunctionalComponent1(__VLS_7, new __VLS_7({
        label: (__VLS_ctx.projectLabel),
        tone: (__VLS_ctx.projectTone),
    }));
    const __VLS_9 = __VLS_8({
        label: (__VLS_ctx.projectLabel),
        tone: (__VLS_ctx.projectTone),
    }, ...__VLS_functionalComponentArgsRest(__VLS_8));
    // @ts-ignore
    [route, projectName, projectLabel, projectTone,];
}
{
    const { right: __VLS_12 } = __VLS_3.slots;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "sheet-no" },
    });
    /** @type {__VLS_StyleScopedClasses['sheet-no']} */ ;
    (__VLS_ctx.id4);
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (__VLS_ctx.load) },
        ...{ class: "btn btn-sm" },
        disabled: (__VLS_ctx.loading),
    });
    /** @type {__VLS_StyleScopedClasses['btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
    let __VLS_13;
    /** @ts-ignore @type { | typeof __VLS_components.IconRefresh} */
    IconRefresh;
    // @ts-ignore
    const __VLS_14 = __VLS_asFunctionalComponent1(__VLS_13, new __VLS_13({
        size: (14),
        strokeWidth: (1.75),
    }));
    const __VLS_15 = __VLS_14({
        size: (14),
        strokeWidth: (1.75),
    }, ...__VLS_functionalComponentArgsRest(__VLS_14));
    (__VLS_ctx.loading ? '读取中…' : '刷新');
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (__VLS_ctx.openCreate) },
        ...{ class: "btn btn-primary btn-sm" },
    });
    /** @type {__VLS_StyleScopedClasses['btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
    let __VLS_18;
    /** @ts-ignore @type { | typeof __VLS_components.IconPlus} */
    IconPlus;
    // @ts-ignore
    const __VLS_19 = __VLS_asFunctionalComponent1(__VLS_18, new __VLS_18({
        size: (14),
        strokeWidth: (1.75),
    }));
    const __VLS_20 = __VLS_19({
        size: (14),
        strokeWidth: (1.75),
    }, ...__VLS_functionalComponentArgsRest(__VLS_19));
    // @ts-ignore
    [id4, load, loading, loading, openCreate,];
}
// @ts-ignore
[];
var __VLS_3;
__VLS_asFunctionalElement1(__VLS_intrinsics.main, __VLS_intrinsics.main)({
    ...{ class: "page" },
});
/** @type {__VLS_StyleScopedClasses['page']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "tblock" },
});
/** @type {__VLS_StyleScopedClasses['tblock']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "tblock-cell" },
});
/** @type {__VLS_StyleScopedClasses['tblock-cell']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "tblock-key" },
});
/** @type {__VLS_StyleScopedClasses['tblock-key']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "tblock-val mono" },
});
/** @type {__VLS_StyleScopedClasses['tblock-val']} */ ;
/** @type {__VLS_StyleScopedClasses['mono']} */ ;
(__VLS_ctx.tasks.length);
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "tblock-cell" },
});
/** @type {__VLS_StyleScopedClasses['tblock-cell']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "tblock-key" },
});
/** @type {__VLS_StyleScopedClasses['tblock-key']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "tblock-val mono" },
});
/** @type {__VLS_StyleScopedClasses['tblock-val']} */ ;
/** @type {__VLS_StyleScopedClasses['mono']} */ ;
(__VLS_ctx.quality.firstPassRate);
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "tblock-cell" },
});
/** @type {__VLS_StyleScopedClasses['tblock-cell']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "tblock-key" },
});
/** @type {__VLS_StyleScopedClasses['tblock-key']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "tblock-val mono" },
});
/** @type {__VLS_StyleScopedClasses['tblock-val']} */ ;
/** @type {__VLS_StyleScopedClasses['mono']} */ ;
(__VLS_ctx.quality.totalRetries);
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "tblock-cell" },
});
/** @type {__VLS_StyleScopedClasses['tblock-cell']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "tblock-key" },
});
/** @type {__VLS_StyleScopedClasses['tblock-key']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "tblock-val" },
});
/** @type {__VLS_StyleScopedClasses['tblock-val']} */ ;
if (__VLS_ctx.quality.failureCategories.length) {
    for (const [c] of __VLS_vFor((__VLS_ctx.quality.failureCategories))) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            key: (c.label),
            ...{ class: "chip" },
        });
        /** @type {__VLS_StyleScopedClasses['chip']} */ ;
        (c.label);
        (c.count);
        // @ts-ignore
        [tasks, quality, quality, quality, quality,];
    }
}
else {
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "faint" },
    });
    /** @type {__VLS_StyleScopedClasses['faint']} */ ;
}
__VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
    ...{ class: "hint faint" },
});
/** @type {__VLS_StyleScopedClasses['hint']} */ ;
/** @type {__VLS_StyleScopedClasses['faint']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.b, __VLS_intrinsics.b)({
    ...{ class: "mono" },
});
/** @type {__VLS_StyleScopedClasses['mono']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "board" },
});
/** @type {__VLS_StyleScopedClasses['board']} */ ;
for (const [col] of __VLS_vFor((__VLS_ctx.COLUMNS))) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.section, __VLS_intrinsics.section)({
        key: (col),
        ...{ class: "panel col" },
    });
    /** @type {__VLS_StyleScopedClasses['panel']} */ ;
    /** @type {__VLS_StyleScopedClasses['col']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.header, __VLS_intrinsics.header)({
        ...{ class: "panel-head col-head" },
    });
    /** @type {__VLS_StyleScopedClasses['panel-head']} */ ;
    /** @type {__VLS_StyleScopedClasses['col-head']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.h3, __VLS_intrinsics.h3)({
        ...{ class: "panel-title" },
    });
    /** @type {__VLS_StyleScopedClasses['panel-title']} */ ;
    (__VLS_ctx.taskLabel(col));
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "faint mono" },
    });
    /** @type {__VLS_StyleScopedClasses['faint']} */ ;
    /** @type {__VLS_StyleScopedClasses['mono']} */ ;
    (__VLS_ctx.byStatus[col].length);
    if (__VLS_ctx.byStatus[col].length) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.ul, __VLS_intrinsics.ul)({
            ...{ class: "rows cards" },
        });
        /** @type {__VLS_StyleScopedClasses['rows']} */ ;
        /** @type {__VLS_StyleScopedClasses['cards']} */ ;
        for (const [t] of __VLS_vFor((__VLS_ctx.byStatus[col]))) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.li, __VLS_intrinsics.li)({
                key: (t.id),
                ...{ class: "row tcard" },
            });
            /** @type {__VLS_StyleScopedClasses['row']} */ ;
            /** @type {__VLS_StyleScopedClasses['tcard']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
                ...{ onClick: (...[$event]) => {
                        if (!(__VLS_ctx.byStatus[col].length))
                            throw 0;
                        return (__VLS_ctx.openDetail(t));
                        // @ts-ignore
                        [COLUMNS, taskLabel, byStatus, byStatus, byStatus, openDetail,];
                    } },
                ...{ class: "tcard-main" },
            });
            /** @type {__VLS_StyleScopedClasses['tcard-main']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "tc-ext mono faint" },
            });
            /** @type {__VLS_StyleScopedClasses['tc-ext']} */ ;
            /** @type {__VLS_StyleScopedClasses['mono']} */ ;
            /** @type {__VLS_StyleScopedClasses['faint']} */ ;
            (t.taskIdExt || t.id);
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "tc-title" },
            });
            /** @type {__VLS_StyleScopedClasses['tc-title']} */ ;
            (t.title);
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "tc-meta faint" },
            });
            /** @type {__VLS_StyleScopedClasses['tc-meta']} */ ;
            /** @type {__VLS_StyleScopedClasses['faint']} */ ;
            if (t.phaseId) {
                (t.phaseId);
            }
            (t.layer === 'frontend' ? '前端' : t.layer === 'backend' ? '后端' : '—');
            if (t.assignee) {
                (t.assignee);
            }
            if (t.retryCount > 0) {
                (t.retryCount);
            }
            if (t.status === 'failed' && t.errorMsg) {
                __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                    ...{ class: "tc-err" },
                });
                /** @type {__VLS_StyleScopedClasses['tc-err']} */ ;
                (t.errorMsg.split('\n')[0].slice(0, 70));
            }
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "tc-ops" },
            });
            /** @type {__VLS_StyleScopedClasses['tc-ops']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
                ...{ onClick: (...[$event]) => {
                        if (!(__VLS_ctx.byStatus[col].length))
                            throw 0;
                        return (__VLS_ctx.doRetry(t));
                        // @ts-ignore
                        [doRetry,];
                    } },
                ...{ class: "btn btn-sm btn-ghost" },
                disabled: (__VLS_ctx.busyId === t.id),
                title: "重新排队（引擎于阶段边界重新派发）",
            });
            /** @type {__VLS_StyleScopedClasses['btn']} */ ;
            /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
            /** @type {__VLS_StyleScopedClasses['btn-ghost']} */ ;
            let __VLS_23;
            /** @ts-ignore @type { | typeof __VLS_components.IconRotate} */
            IconRotate;
            // @ts-ignore
            const __VLS_24 = __VLS_asFunctionalComponent1(__VLS_23, new __VLS_23({
                size: (13),
                strokeWidth: (1.75),
            }));
            const __VLS_25 = __VLS_24({
                size: (13),
                strokeWidth: (1.75),
            }, ...__VLS_functionalComponentArgsRest(__VLS_24));
            __VLS_asFunctionalElement1(__VLS_intrinsics.select, __VLS_intrinsics.select)({
                ...{ onChange: (...[$event]) => {
                        if (!(__VLS_ctx.byStatus[col].length))
                            throw 0;
                        return (__VLS_ctx.changeStatus(t, $event.target.value));
                        // @ts-ignore
                        [busyId, changeStatus,];
                    } },
                ...{ class: "sel mono" },
                value: (t.status),
                disabled: (__VLS_ctx.busyId === t.id),
                'aria-label': "手动改状态",
            });
            /** @type {__VLS_StyleScopedClasses['sel']} */ ;
            /** @type {__VLS_StyleScopedClasses['mono']} */ ;
            for (const [s] of __VLS_vFor((__VLS_ctx.COLUMNS))) {
                __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
                    key: (s),
                    value: (s),
                });
                (__VLS_ctx.taskLabel(s));
                // @ts-ignore
                [COLUMNS, taskLabel, busyId,];
            }
            // @ts-ignore
            [];
        }
    }
    else {
        __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
            ...{ class: "col-empty faint" },
        });
        /** @type {__VLS_StyleScopedClasses['col-empty']} */ ;
        /** @type {__VLS_StyleScopedClasses['faint']} */ ;
    }
    // @ts-ignore
    [];
}
if (__VLS_ctx.detail) {
    const __VLS_28 = AppModal || AppModal;
    // @ts-ignore
    const __VLS_29 = __VLS_asFunctionalComponent1(__VLS_28, new __VLS_28({
        ...{ 'onClose': {} },
        title: (__VLS_ctx.detail.title),
        sheet: (__VLS_ctx.detail.taskIdExt || 'TASK'),
        width: "720px",
    }));
    const __VLS_30 = __VLS_29({
        ...{ 'onClose': {} },
        title: (__VLS_ctx.detail.title),
        sheet: (__VLS_ctx.detail.taskIdExt || 'TASK'),
        width: "720px",
    }, ...__VLS_functionalComponentArgsRest(__VLS_29));
    let __VLS_33;
    const __VLS_34 = {
        /** @type {typeof __VLS_33.close} */
        onClose: (...[$event]) => {
            if (!(__VLS_ctx.detail))
                throw 0;
            return (__VLS_ctx.detail = null);
            // @ts-ignore
            [detail, detail, detail, detail,];
        },
    };
    const { default: __VLS_35 } = __VLS_31.slots;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "detail-grid tblock" },
    });
    /** @type {__VLS_StyleScopedClasses['detail-grid']} */ ;
    /** @type {__VLS_StyleScopedClasses['tblock']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "tblock-cell" },
    });
    /** @type {__VLS_StyleScopedClasses['tblock-cell']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "tblock-key" },
    });
    /** @type {__VLS_StyleScopedClasses['tblock-key']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "tblock-val" },
    });
    /** @type {__VLS_StyleScopedClasses['tblock-val']} */ ;
    const __VLS_36 = StampSeal;
    // @ts-ignore
    const __VLS_37 = __VLS_asFunctionalComponent1(__VLS_36, new __VLS_36({
        label: (__VLS_ctx.taskLabel(__VLS_ctx.detail.status)),
        tone: (__VLS_ctx.taskTone(__VLS_ctx.detail.status)),
    }));
    const __VLS_38 = __VLS_37({
        label: (__VLS_ctx.taskLabel(__VLS_ctx.detail.status)),
        tone: (__VLS_ctx.taskTone(__VLS_ctx.detail.status)),
    }, ...__VLS_functionalComponentArgsRest(__VLS_37));
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "tblock-cell" },
    });
    /** @type {__VLS_StyleScopedClasses['tblock-cell']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "tblock-key" },
    });
    /** @type {__VLS_StyleScopedClasses['tblock-key']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "tblock-val mono" },
    });
    /** @type {__VLS_StyleScopedClasses['tblock-val']} */ ;
    /** @type {__VLS_StyleScopedClasses['mono']} */ ;
    (__VLS_ctx.detail.phaseId ?? '—');
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "tblock-cell" },
    });
    /** @type {__VLS_StyleScopedClasses['tblock-cell']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "tblock-key" },
    });
    /** @type {__VLS_StyleScopedClasses['tblock-key']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "tblock-val" },
    });
    /** @type {__VLS_StyleScopedClasses['tblock-val']} */ ;
    (__VLS_ctx.detail.layer === 'frontend' ? '前端' : __VLS_ctx.detail.layer === 'backend' ? '后端' : '—');
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "tblock-cell" },
    });
    /** @type {__VLS_StyleScopedClasses['tblock-cell']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "tblock-key" },
    });
    /** @type {__VLS_StyleScopedClasses['tblock-key']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "tblock-val" },
    });
    /** @type {__VLS_StyleScopedClasses['tblock-val']} */ ;
    (__VLS_ctx.detail.assignee || '—');
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "tblock-cell" },
    });
    /** @type {__VLS_StyleScopedClasses['tblock-cell']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "tblock-key" },
    });
    /** @type {__VLS_StyleScopedClasses['tblock-key']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "tblock-val mono" },
    });
    /** @type {__VLS_StyleScopedClasses['tblock-val']} */ ;
    /** @type {__VLS_StyleScopedClasses['mono']} */ ;
    (__VLS_ctx.detail.retryCount);
    if (__VLS_ctx.detail.dependsOn) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "tblock-cell" },
        });
        /** @type {__VLS_StyleScopedClasses['tblock-cell']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "tblock-key" },
        });
        /** @type {__VLS_StyleScopedClasses['tblock-key']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "tblock-val mono" },
        });
        /** @type {__VLS_StyleScopedClasses['tblock-val']} */ ;
        /** @type {__VLS_StyleScopedClasses['mono']} */ ;
        (__VLS_ctx.detail.dependsOn);
    }
    if (__VLS_ctx.detailLoading) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
            ...{ class: "faint" },
        });
        /** @type {__VLS_StyleScopedClasses['faint']} */ ;
    }
    if (__VLS_ctx.detail.description) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.section, __VLS_intrinsics.section)({
            ...{ class: "dsec" },
        });
        /** @type {__VLS_StyleScopedClasses['dsec']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.h4, __VLS_intrinsics.h4)({
            ...{ class: "ds-label" },
        });
        /** @type {__VLS_StyleScopedClasses['ds-label']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.pre, __VLS_intrinsics.pre)({
            ...{ class: "doc mono" },
        });
        /** @type {__VLS_StyleScopedClasses['doc']} */ ;
        /** @type {__VLS_StyleScopedClasses['mono']} */ ;
        (__VLS_ctx.detail.description);
    }
    if (__VLS_ctx.detail.acceptance) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.section, __VLS_intrinsics.section)({
            ...{ class: "dsec" },
        });
        /** @type {__VLS_StyleScopedClasses['dsec']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.h4, __VLS_intrinsics.h4)({
            ...{ class: "ds-label" },
        });
        /** @type {__VLS_StyleScopedClasses['ds-label']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.pre, __VLS_intrinsics.pre)({
            ...{ class: "doc mono" },
        });
        /** @type {__VLS_StyleScopedClasses['doc']} */ ;
        /** @type {__VLS_StyleScopedClasses['mono']} */ ;
        (__VLS_ctx.detail.acceptance);
    }
    if (__VLS_ctx.detail.errorMsg) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.section, __VLS_intrinsics.section)({
            ...{ class: "dsec" },
        });
        /** @type {__VLS_StyleScopedClasses['dsec']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.h4, __VLS_intrinsics.h4)({
            ...{ class: "ds-label err" },
        });
        /** @type {__VLS_StyleScopedClasses['ds-label']} */ ;
        /** @type {__VLS_StyleScopedClasses['err']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.pre, __VLS_intrinsics.pre)({
            ...{ class: "doc mono err" },
        });
        /** @type {__VLS_StyleScopedClasses['doc']} */ ;
        /** @type {__VLS_StyleScopedClasses['mono']} */ ;
        /** @type {__VLS_StyleScopedClasses['err']} */ ;
        (__VLS_ctx.detail.errorMsg);
    }
    if (__VLS_ctx.detail.result) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.section, __VLS_intrinsics.section)({
            ...{ class: "dsec" },
        });
        /** @type {__VLS_StyleScopedClasses['dsec']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.h4, __VLS_intrinsics.h4)({
            ...{ class: "ds-label" },
        });
        /** @type {__VLS_StyleScopedClasses['ds-label']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.pre, __VLS_intrinsics.pre)({
            ...{ class: "doc mono" },
        });
        /** @type {__VLS_StyleScopedClasses['doc']} */ ;
        /** @type {__VLS_StyleScopedClasses['mono']} */ ;
        (__VLS_ctx.detail.result);
    }
    if (!__VLS_ctx.detail.description && !__VLS_ctx.detail.acceptance && !__VLS_ctx.detail.errorMsg && !__VLS_ctx.detail.result) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
            ...{ class: "faint" },
        });
        /** @type {__VLS_StyleScopedClasses['faint']} */ ;
    }
    {
        const { footer: __VLS_41 } = __VLS_31.slots;
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.detail))
                        throw 0;
                    return (__VLS_ctx.detail = null);
                    // @ts-ignore
                    [taskLabel, detail, detail, detail, detail, detail, detail, detail, detail, detail, detail, detail, detail, detail, detail, detail, detail, detail, detail, detail, detail, detail, detail, taskTone, detailLoading,];
                } },
            ...{ class: "btn btn-sm" },
        });
        /** @type {__VLS_StyleScopedClasses['btn']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.detail))
                        throw 0;
                    return (__VLS_ctx.doRetry(__VLS_ctx.detail));
                    // @ts-ignore
                    [doRetry, detail,];
                } },
            ...{ class: "btn btn-sm" },
            disabled: (__VLS_ctx.busyId === __VLS_ctx.detail.id),
        });
        /** @type {__VLS_StyleScopedClasses['btn']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
        let __VLS_42;
        /** @ts-ignore @type { | typeof __VLS_components.IconRotate} */
        IconRotate;
        // @ts-ignore
        const __VLS_43 = __VLS_asFunctionalComponent1(__VLS_42, new __VLS_42({
            size: (13),
            strokeWidth: (1.75),
        }));
        const __VLS_44 = __VLS_43({
            size: (13),
            strokeWidth: (1.75),
        }, ...__VLS_functionalComponentArgsRest(__VLS_43));
        // @ts-ignore
        [busyId, detail,];
    }
    // @ts-ignore
    [];
    var __VLS_31;
    var __VLS_32;
}
if (__VLS_ctx.showCreate) {
    const __VLS_47 = AppModal || AppModal;
    // @ts-ignore
    const __VLS_48 = __VLS_asFunctionalComponent1(__VLS_47, new __VLS_47({
        ...{ 'onClose': {} },
        title: "补一条任务",
        sheet: "TASK-NEW",
        width: "560px",
    }));
    const __VLS_49 = __VLS_48({
        ...{ 'onClose': {} },
        title: "补一条任务",
        sheet: "TASK-NEW",
        width: "560px",
    }, ...__VLS_functionalComponentArgsRest(__VLS_48));
    let __VLS_52;
    const __VLS_53 = {
        /** @type {typeof __VLS_52.close} */
        onClose: (...[$event]) => {
            if (!(__VLS_ctx.showCreate))
                throw 0;
            return (__VLS_ctx.showCreate = false);
            // @ts-ignore
            [showCreate, showCreate,];
        },
    };
    const { default: __VLS_54 } = __VLS_50.slots;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "form" },
    });
    /** @type {__VLS_StyleScopedClasses['form']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
        ...{ class: "field" },
    });
    /** @type {__VLS_StyleScopedClasses['field']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "lbl" },
    });
    /** @type {__VLS_StyleScopedClasses['lbl']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.b, __VLS_intrinsics.b)({
        ...{ class: "req" },
    });
    /** @type {__VLS_StyleScopedClasses['req']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
        value: (__VLS_ctx.draft.title),
        ...{ class: "input" },
        type: "text",
        placeholder: "如：报表导出接口",
    });
    /** @type {__VLS_StyleScopedClasses['input']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "two" },
    });
    /** @type {__VLS_StyleScopedClasses['two']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
        ...{ class: "field" },
    });
    /** @type {__VLS_StyleScopedClasses['field']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "lbl" },
    });
    /** @type {__VLS_StyleScopedClasses['lbl']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
        ...{ class: "input mono" },
        type: "number",
        min: "1",
        placeholder: "留空=不属于任何阶段",
    });
    (__VLS_ctx.draft.phaseId);
    /** @type {__VLS_StyleScopedClasses['input']} */ ;
    /** @type {__VLS_StyleScopedClasses['mono']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
        ...{ class: "field" },
    });
    /** @type {__VLS_StyleScopedClasses['field']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "lbl" },
    });
    /** @type {__VLS_StyleScopedClasses['lbl']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.select, __VLS_intrinsics.select)({
        value: (__VLS_ctx.draft.layer),
        ...{ class: "input" },
    });
    /** @type {__VLS_StyleScopedClasses['input']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
        value: "backend",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
        value: "frontend",
    });
    __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
        ...{ class: "field" },
    });
    /** @type {__VLS_StyleScopedClasses['field']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "lbl" },
    });
    /** @type {__VLS_StyleScopedClasses['lbl']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
        value: (__VLS_ctx.draft.assignee),
        ...{ class: "input" },
        type: "text",
        placeholder: "如：developer（留空=不指派）",
    });
    /** @type {__VLS_StyleScopedClasses['input']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
        ...{ class: "field" },
    });
    /** @type {__VLS_StyleScopedClasses['field']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "lbl" },
    });
    /** @type {__VLS_StyleScopedClasses['lbl']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.textarea)({
        value: (__VLS_ctx.draft.description),
        ...{ class: "input textarea" },
        rows: "3",
        placeholder: "这条任务要做什么",
    });
    /** @type {__VLS_StyleScopedClasses['input']} */ ;
    /** @type {__VLS_StyleScopedClasses['textarea']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
        ...{ class: "field" },
    });
    /** @type {__VLS_StyleScopedClasses['field']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "lbl" },
    });
    /** @type {__VLS_StyleScopedClasses['lbl']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.textarea)({
        value: (__VLS_ctx.draft.acceptance),
        ...{ class: "input textarea" },
        rows: "3",
        placeholder: "可机械判定的说法，如：GET /api/x 返回 200 且 data 是数组",
    });
    /** @type {__VLS_StyleScopedClasses['input']} */ ;
    /** @type {__VLS_StyleScopedClasses['textarea']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
        ...{ class: "faint tip" },
    });
    /** @type {__VLS_StyleScopedClasses['faint']} */ ;
    /** @type {__VLS_StyleScopedClasses['tip']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.b, __VLS_intrinsics.b)({
        ...{ class: "mono" },
    });
    /** @type {__VLS_StyleScopedClasses['mono']} */ ;
    {
        const { footer: __VLS_55 } = __VLS_50.slots;
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.showCreate))
                        throw 0;
                    return (__VLS_ctx.showCreate = false);
                    // @ts-ignore
                    [showCreate, draft, draft, draft, draft, draft, draft,];
                } },
            ...{ class: "btn btn-sm" },
        });
        /** @type {__VLS_StyleScopedClasses['btn']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
        let __VLS_56;
        /** @ts-ignore @type { | typeof __VLS_components.IconX} */
        IconX;
        // @ts-ignore
        const __VLS_57 = __VLS_asFunctionalComponent1(__VLS_56, new __VLS_56({
            size: (13),
            strokeWidth: (1.75),
        }));
        const __VLS_58 = __VLS_57({
            size: (13),
            strokeWidth: (1.75),
        }, ...__VLS_functionalComponentArgsRest(__VLS_57));
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (__VLS_ctx.submitCreate) },
            ...{ class: "btn btn-sm btn-primary" },
            disabled: (__VLS_ctx.creating),
        });
        /** @type {__VLS_StyleScopedClasses['btn']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
        (__VLS_ctx.creating ? '创建中…' : '创建任务');
        // @ts-ignore
        [submitCreate, creating, creating,];
    }
    // @ts-ignore
    [];
    var __VLS_50;
    var __VLS_51;
}
// @ts-ignore
[];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
