import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { IconAlertTriangle, IconFileText, IconRefresh, IconShieldCheck } from '@tabler/icons-vue';
import TopBar from '../components/ui/TopBar.vue';
import StampSeal from '../components/ui/StampSeal.vue';
import { fetchProjectById } from '../api/project';
import { fetchVerifyEvidence } from '../api/verify';
import { TASK_STATUS } from '../constants/status';
const router = useRouter();
const route = useRoute();
const projectId = computed(() => {
    const n = Number(route.params.id);
    return Number.isFinite(n) && n > 0 ? n : null;
});
const projectName = ref('');
const ev = ref(null);
const loading = ref(false);
const loadError = ref('');
async function load() {
    const id = projectId.value;
    if (id == null) {
        loadError.value = '地址里没有有效的项目号';
        return;
    }
    loading.value = true;
    loadError.value = '';
    try {
        ev.value = await fetchVerifyEvidence(id);
    }
    catch (e) {
        loadError.value = e instanceof Error ? e.message : '证据没拿到';
    }
    finally {
        loading.value = false;
    }
}
onMounted(async () => {
    void load();
    const id = projectId.value;
    if (id == null)
        return;
    try {
        projectName.value = (await fetchProjectById(id)).name;
    }
    catch {
        projectName.value = '项目 #' + id;
    }
});
/* ===== 判定结论：① 交付关报告在不在 ② 进程退出码 ③ 续拉次数 =====
   口径刻意保守：**没读到报告 ≠ 通过**（与引擎"未验证 ≠ 通过"同源） */
const verdict = computed(() => {
    const e = ev.value;
    if (!e)
        return { label: '读取中', tone: 'pencil', why: '' };
    if (e.runReport) {
        return { label: '有实测报告', tone: 'pass', why: '交付关跑了执行式验证并出了报告（逐条证据见下方）' };
    }
    if (e.acceptance.cases.length) {
        return { label: '未验证', tone: 'wait', why: '有验收判据但没出实测报告 —— 按口径未验证 ≠ 通过' };
    }
    return { label: '无证据', tone: 'void', why: '产物树里既没有验收判据也没有实测报告' };
});
const exitCodeText = computed(() => {
    const c = ev.value?.run?.exitCode;
    return c === null || c === undefined ? '—' : String(c);
});
/** 任务证据里失败的那几条（先看它们，是排障入口） */
const failedEvidence = computed(() => (ev.value?.taskEvidence ?? []).filter((t) => t.status === 'failed'));
const doneCount = computed(() => (ev.value?.taskEvidence ?? []).filter((t) => t.status === 'done').length);
function taskTone(status) {
    return TASK_STATUS[status]?.tone || 'pencil';
}
function taskLabel(status) {
    return TASK_STATUS[status]?.label || status;
}
/** 一条验收判据 → 单行人话（三种 kind 各自的读法） */
function caseLine(c) {
    if (c.kind === 'http')
        return `${c.method || 'GET'} ${c.path || '?'} → 期望 ${c.expectStatus ?? '?'}`;
    if (c.kind === 'command')
        return `${c.command || '?'} → 期望退出码 ${c.expectExitCode ?? 0}`;
    if (c.kind === 'testFile')
        return `跑测试文件 ${c.testPath || '?'}`;
    return '（未知判据类型）';
}
const id4 = computed(() => String(route.params.id).padStart(4, '0'));
/** completion.json 的失败详情（有无都渲染得出来） */
const completionReasons = computed(() => ev.value?.completion?.reasons ?? []);
const completionBreakdown = computed(() => ev.value?.completion?.taskBreakdown ?? null);
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['tb-title']} */ ;
/** @type {__VLS_StyleScopedClasses['notes']} */ ;
/** @type {__VLS_StyleScopedClasses['t-retry']} */ ;
/** @type {__VLS_StyleScopedClasses['t-detail']} */ ;
/** @type {__VLS_StyleScopedClasses['t-detail']} */ ;
/** @type {__VLS_StyleScopedClasses['t-detail']} */ ;
/** @type {__VLS_StyleScopedClasses['doc']} */ ;
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
        label: (__VLS_ctx.verdict.label),
        tone: (__VLS_ctx.verdict.tone),
    }));
    const __VLS_9 = __VLS_8({
        label: (__VLS_ctx.verdict.label),
        tone: (__VLS_ctx.verdict.tone),
    }, ...__VLS_functionalComponentArgsRest(__VLS_8));
    // @ts-ignore
    [route, projectName, verdict, verdict,];
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
    // @ts-ignore
    [id4, load, loading, loading,];
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
    ...{ class: "tblock-val" },
});
/** @type {__VLS_StyleScopedClasses['tblock-val']} */ ;
(__VLS_ctx.verdict.label);
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
(__VLS_ctx.exitCodeText);
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
(__VLS_ctx.ev?.run?.restartCount ?? '—');
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
(__VLS_ctx.ev?.acceptance?.cases?.length ?? 0);
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
(__VLS_ctx.doneCount);
(__VLS_ctx.ev?.taskEvidence?.length ?? 0);
if (__VLS_ctx.verdict.why) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
        ...{ class: "verdict-why faint" },
    });
    /** @type {__VLS_StyleScopedClasses['verdict-why']} */ ;
    /** @type {__VLS_StyleScopedClasses['faint']} */ ;
    (__VLS_ctx.verdict.why);
}
if (__VLS_ctx.loadError) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "panel revision-cloud card" },
    });
    /** @type {__VLS_StyleScopedClasses['panel']} */ ;
    /** @type {__VLS_StyleScopedClasses['revision-cloud']} */ ;
    /** @type {__VLS_StyleScopedClasses['card']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({});
    (__VLS_ctx.loadError);
}
if (__VLS_ctx.ev?.notes?.length) {
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
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "faint mono" },
    });
    /** @type {__VLS_StyleScopedClasses['faint']} */ ;
    /** @type {__VLS_StyleScopedClasses['mono']} */ ;
    (__VLS_ctx.ev.notes.length);
    __VLS_asFunctionalElement1(__VLS_intrinsics.ul, __VLS_intrinsics.ul)({
        ...{ class: "card-body notes" },
    });
    /** @type {__VLS_StyleScopedClasses['card-body']} */ ;
    /** @type {__VLS_StyleScopedClasses['notes']} */ ;
    for (const [n, i] of __VLS_vFor((__VLS_ctx.ev.notes))) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.li, __VLS_intrinsics.li)({
            key: (i),
        });
        let __VLS_18;
        /** @ts-ignore @type { | typeof __VLS_components.IconAlertTriangle} */
        IconAlertTriangle;
        // @ts-ignore
        const __VLS_19 = __VLS_asFunctionalComponent1(__VLS_18, new __VLS_18({
            size: (14),
            strokeWidth: (1.75),
            ...{ class: "ni" },
        }));
        const __VLS_20 = __VLS_19({
            size: (14),
            strokeWidth: (1.75),
            ...{ class: "ni" },
        }, ...__VLS_functionalComponentArgsRest(__VLS_19));
        /** @type {__VLS_StyleScopedClasses['ni']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
        (n);
        // @ts-ignore
        [verdict, verdict, verdict, exitCodeText, ev, ev, ev, ev, ev, ev, doneCount, loadError, loadError,];
    }
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
let __VLS_23;
/** @ts-ignore @type { | typeof __VLS_components.IconShieldCheck} */
IconShieldCheck;
// @ts-ignore
const __VLS_24 = __VLS_asFunctionalComponent1(__VLS_23, new __VLS_23({
    size: (16),
    strokeWidth: (1.75),
    ...{ class: "pt-ico" },
}));
const __VLS_25 = __VLS_24({
    size: (16),
    strokeWidth: (1.75),
    ...{ class: "pt-ico" },
}, ...__VLS_functionalComponentArgsRest(__VLS_24));
/** @type {__VLS_StyleScopedClasses['pt-ico']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "faint mono" },
});
/** @type {__VLS_StyleScopedClasses['faint']} */ ;
/** @type {__VLS_StyleScopedClasses['mono']} */ ;
if (__VLS_ctx.ev?.runReport) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.pre, __VLS_intrinsics.pre)({
        ...{ class: "doc mono" },
    });
    /** @type {__VLS_StyleScopedClasses['doc']} */ ;
    /** @type {__VLS_StyleScopedClasses['mono']} */ ;
    (__VLS_ctx.ev.runReport);
}
else {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "empty-sheet card-body" },
    });
    /** @type {__VLS_StyleScopedClasses['empty-sheet']} */ ;
    /** @type {__VLS_StyleScopedClasses['card-body']} */ ;
    let __VLS_28;
    /** @ts-ignore @type { | typeof __VLS_components.IconFileText} */
    IconFileText;
    // @ts-ignore
    const __VLS_29 = __VLS_asFunctionalComponent1(__VLS_28, new __VLS_28({
        size: (34),
        strokeWidth: (1.2),
        ...{ class: "es-ico" },
    }));
    const __VLS_30 = __VLS_29({
        size: (34),
        strokeWidth: (1.2),
        ...{ class: "es-ico" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_29));
    /** @type {__VLS_StyleScopedClasses['es-ico']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.h3, __VLS_intrinsics.h3)({});
    __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({});
    __VLS_asFunctionalElement1(__VLS_intrinsics.b, __VLS_intrinsics.b)({
        ...{ class: "mono" },
    });
    /** @type {__VLS_StyleScopedClasses['mono']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.b, __VLS_intrinsics.b)({});
}
if (__VLS_ctx.ev?.completion) {
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
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "faint mono" },
    });
    /** @type {__VLS_StyleScopedClasses['faint']} */ ;
    /** @type {__VLS_StyleScopedClasses['mono']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "card-body" },
    });
    /** @type {__VLS_StyleScopedClasses['card-body']} */ ;
    if (__VLS_ctx.completionBreakdown) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "chips" },
        });
        /** @type {__VLS_StyleScopedClasses['chips']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "chip" },
        });
        /** @type {__VLS_StyleScopedClasses['chip']} */ ;
        (__VLS_ctx.completionBreakdown.total ?? '—');
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "chip chip-pass" },
        });
        /** @type {__VLS_StyleScopedClasses['chip']} */ ;
        /** @type {__VLS_StyleScopedClasses['chip-pass']} */ ;
        (__VLS_ctx.completionBreakdown.done ?? '—');
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "chip chip-void" },
        });
        /** @type {__VLS_StyleScopedClasses['chip']} */ ;
        /** @type {__VLS_StyleScopedClasses['chip-void']} */ ;
        (__VLS_ctx.completionBreakdown.failed ?? '—');
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "chip" },
        });
        /** @type {__VLS_StyleScopedClasses['chip']} */ ;
        (__VLS_ctx.completionBreakdown.todo ?? '—');
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "chip" },
        });
        /** @type {__VLS_StyleScopedClasses['chip']} */ ;
        (__VLS_ctx.completionBreakdown.doing ?? '—');
    }
    if (__VLS_ctx.completionReasons.length) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.ul, __VLS_intrinsics.ul)({
            ...{ class: "notes" },
        });
        /** @type {__VLS_StyleScopedClasses['notes']} */ ;
        for (const [r, i] of __VLS_vFor((__VLS_ctx.completionReasons))) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.li, __VLS_intrinsics.li)({
                key: (i),
            });
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
            (r);
            // @ts-ignore
            [ev, ev, ev, completionBreakdown, completionBreakdown, completionBreakdown, completionBreakdown, completionBreakdown, completionBreakdown, completionReasons, completionReasons,];
        }
    }
    if (__VLS_ctx.ev.completion.failureDetail) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
            ...{ class: "fail-detail mono" },
        });
        /** @type {__VLS_StyleScopedClasses['fail-detail']} */ ;
        /** @type {__VLS_StyleScopedClasses['mono']} */ ;
        (__VLS_ctx.ev.completion.failureDetail.kind || 'EXCEPTION');
        (__VLS_ctx.ev.completion.failureDetail.message || '（无消息）');
    }
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
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "faint mono" },
});
/** @type {__VLS_StyleScopedClasses['faint']} */ ;
/** @type {__VLS_StyleScopedClasses['mono']} */ ;
(__VLS_ctx.ev?.acceptance?.files?.length ?? 0);
(__VLS_ctx.ev?.acceptance?.cases?.length ?? 0);
if (__VLS_ctx.ev?.acceptance?.cases?.length) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.ul, __VLS_intrinsics.ul)({
        ...{ class: "rows" },
    });
    /** @type {__VLS_StyleScopedClasses['rows']} */ ;
    for (const [c, i] of __VLS_vFor((__VLS_ctx.ev.acceptance.cases))) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.li, __VLS_intrinsics.li)({
            key: (i),
            ...{ class: "row kase" },
        });
        /** @type {__VLS_StyleScopedClasses['row']} */ ;
        /** @type {__VLS_StyleScopedClasses['kase']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "k-kind mono" },
        });
        /** @type {__VLS_StyleScopedClasses['k-kind']} */ ;
        /** @type {__VLS_StyleScopedClasses['mono']} */ ;
        (c.kind);
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "k-line mono" },
        });
        /** @type {__VLS_StyleScopedClasses['k-line']} */ ;
        /** @type {__VLS_StyleScopedClasses['mono']} */ ;
        (__VLS_ctx.caseLine(c));
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "k-display faint" },
        });
        /** @type {__VLS_StyleScopedClasses['k-display']} */ ;
        /** @type {__VLS_StyleScopedClasses['faint']} */ ;
        (c.display || c.id);
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "k-from faint mono" },
        });
        /** @type {__VLS_StyleScopedClasses['k-from']} */ ;
        /** @type {__VLS_StyleScopedClasses['faint']} */ ;
        /** @type {__VLS_StyleScopedClasses['mono']} */ ;
        (c.from);
        // @ts-ignore
        [ev, ev, ev, ev, ev, ev, ev, caseLine,];
    }
}
else {
    __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
        ...{ class: "card-body faint empty-tip" },
    });
    /** @type {__VLS_StyleScopedClasses['card-body']} */ ;
    /** @type {__VLS_StyleScopedClasses['faint']} */ ;
    /** @type {__VLS_StyleScopedClasses['empty-tip']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.b, __VLS_intrinsics.b)({
        ...{ class: "mono" },
    });
    /** @type {__VLS_StyleScopedClasses['mono']} */ ;
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
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "faint mono" },
});
/** @type {__VLS_StyleScopedClasses['faint']} */ ;
/** @type {__VLS_StyleScopedClasses['mono']} */ ;
(__VLS_ctx.ev?.taskEvidence?.length ?? 0);
if (__VLS_ctx.failedEvidence.length) {
    (__VLS_ctx.failedEvidence.length);
}
if (__VLS_ctx.ev?.taskEvidence?.length) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.ul, __VLS_intrinsics.ul)({
        ...{ class: "rows" },
    });
    /** @type {__VLS_StyleScopedClasses['rows']} */ ;
    for (const [t] of __VLS_vFor((__VLS_ctx.ev.taskEvidence))) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.li, __VLS_intrinsics.li)({
            key: (t.id),
            ...{ class: "row tev" },
        });
        /** @type {__VLS_StyleScopedClasses['row']} */ ;
        /** @type {__VLS_StyleScopedClasses['tev']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "t-ext mono faint" },
        });
        /** @type {__VLS_StyleScopedClasses['t-ext']} */ ;
        /** @type {__VLS_StyleScopedClasses['mono']} */ ;
        /** @type {__VLS_StyleScopedClasses['faint']} */ ;
        (t.taskIdExt || t.id);
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "t-title" },
        });
        /** @type {__VLS_StyleScopedClasses['t-title']} */ ;
        (t.title);
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "t-layer faint" },
        });
        /** @type {__VLS_StyleScopedClasses['t-layer']} */ ;
        /** @type {__VLS_StyleScopedClasses['faint']} */ ;
        (t.layer === 'frontend' ? '前端' : t.layer === 'backend' ? '后端' : '—');
        if (t.retryCount > 0) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "t-retry mono" },
            });
            /** @type {__VLS_StyleScopedClasses['t-retry']} */ ;
            /** @type {__VLS_StyleScopedClasses['mono']} */ ;
            (t.retryCount);
        }
        const __VLS_33 = StampSeal;
        // @ts-ignore
        const __VLS_34 = __VLS_asFunctionalComponent1(__VLS_33, new __VLS_33({
            label: (__VLS_ctx.taskLabel(t.status)),
            tone: (__VLS_ctx.taskTone(t.status)),
        }));
        const __VLS_35 = __VLS_34({
            label: (__VLS_ctx.taskLabel(t.status)),
            tone: (__VLS_ctx.taskTone(t.status)),
        }, ...__VLS_functionalComponentArgsRest(__VLS_34));
        if (t.errorMsg || t.result) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.details, __VLS_intrinsics.details)({
                ...{ class: "t-detail" },
            });
            /** @type {__VLS_StyleScopedClasses['t-detail']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.summary, __VLS_intrinsics.summary)({});
            if (t.errorMsg) {
                __VLS_asFunctionalElement1(__VLS_intrinsics.pre, __VLS_intrinsics.pre)({
                    ...{ class: "doc mono err" },
                });
                /** @type {__VLS_StyleScopedClasses['doc']} */ ;
                /** @type {__VLS_StyleScopedClasses['mono']} */ ;
                /** @type {__VLS_StyleScopedClasses['err']} */ ;
                (t.errorMsg);
            }
            if (t.result) {
                __VLS_asFunctionalElement1(__VLS_intrinsics.pre, __VLS_intrinsics.pre)({
                    ...{ class: "doc mono" },
                });
                /** @type {__VLS_StyleScopedClasses['doc']} */ ;
                /** @type {__VLS_StyleScopedClasses['mono']} */ ;
                (t.result);
            }
        }
        // @ts-ignore
        [ev, ev, ev, failedEvidence, failedEvidence, taskLabel, taskTone,];
    }
}
else {
    __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
        ...{ class: "card-body faint empty-tip" },
    });
    /** @type {__VLS_StyleScopedClasses['card-body']} */ ;
    /** @type {__VLS_StyleScopedClasses['faint']} */ ;
    /** @type {__VLS_StyleScopedClasses['empty-tip']} */ ;
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
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "faint mono" },
});
/** @type {__VLS_StyleScopedClasses['faint']} */ ;
/** @type {__VLS_StyleScopedClasses['mono']} */ ;
(__VLS_ctx.route.params.id);
if (__VLS_ctx.ev?.logTail?.length) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.pre, __VLS_intrinsics.pre)({
        ...{ class: "doc mono logdoc" },
    });
    /** @type {__VLS_StyleScopedClasses['doc']} */ ;
    /** @type {__VLS_StyleScopedClasses['mono']} */ ;
    /** @type {__VLS_StyleScopedClasses['logdoc']} */ ;
    (__VLS_ctx.ev.logTail.join('\n'));
}
else {
    __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
        ...{ class: "card-body faint empty-tip" },
    });
    /** @type {__VLS_StyleScopedClasses['card-body']} */ ;
    /** @type {__VLS_StyleScopedClasses['faint']} */ ;
    /** @type {__VLS_StyleScopedClasses['empty-tip']} */ ;
}
// @ts-ignore
[route, ev, ev,];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
