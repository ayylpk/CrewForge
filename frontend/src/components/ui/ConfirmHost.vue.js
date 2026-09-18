import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { answerConfirm, confirmState } from '../../utils/confirm';
const okBtn = ref(null);
const req = computed(() => confirmState.pending);
const isAlert = computed(() => !!req.value && req.value.cancel === undefined);
watch(req, async (v) => {
    if (v) {
        await nextTick();
        okBtn.value?.focus(); // 键盘直达确认，Esc 退出
    }
});
function onKey(e) {
    if (e.key === 'Escape' && confirmState.pending)
        answerConfirm(false);
}
window.addEventListener('keydown', onKey);
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
let __VLS_0;
/** @ts-ignore @type { | typeof __VLS_components.Teleport | typeof __VLS_components.Teleport} */
Teleport;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({
    to: "body",
}));
const __VLS_2 = __VLS_1({
    to: "body",
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
const { default: __VLS_5 } = __VLS_3.slots;
let __VLS_6;
/** @ts-ignore @type { | typeof __VLS_components.Transition | typeof __VLS_components.Transition} */
Transition;
// @ts-ignore
const __VLS_7 = __VLS_asFunctionalComponent1(__VLS_6, new __VLS_6({
    name: "door",
}));
const __VLS_8 = __VLS_7({
    name: "door",
}, ...__VLS_functionalComponentArgsRest(__VLS_7));
const { default: __VLS_11 } = __VLS_9.slots;
if (__VLS_ctx.req) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.req))
                    throw 0;
                return (__VLS_ctx.answerConfirm(false));
                // @ts-ignore
                [req, answerConfirm,];
            } },
        ...{ class: "scrim" },
    });
    /** @type {__VLS_StyleScopedClasses['scrim']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "door-sheet sheet-fall" },
        role: "alertdialog",
        'aria-modal': "true",
        'aria-label': (__VLS_ctx.req.title),
    });
    /** @type {__VLS_StyleScopedClasses['door-sheet']} */ ;
    /** @type {__VLS_StyleScopedClasses['sheet-fall']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "door-head" },
    });
    /** @type {__VLS_StyleScopedClasses['door-head']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "sheet-no" },
    });
    /** @type {__VLS_StyleScopedClasses['sheet-no']} */ ;
    (__VLS_ctx.isAlert ? 'NOTE' : 'CONFIRM');
    __VLS_asFunctionalElement1(__VLS_intrinsics.h3, __VLS_intrinsics.h3)({
        ...{ class: "door-title" },
    });
    /** @type {__VLS_StyleScopedClasses['door-title']} */ ;
    (__VLS_ctx.req.title);
    if (__VLS_ctx.req.body) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
            ...{ class: "door-body" },
        });
        /** @type {__VLS_StyleScopedClasses['door-body']} */ ;
        (__VLS_ctx.req.body);
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "door-foot" },
    });
    /** @type {__VLS_StyleScopedClasses['door-foot']} */ ;
    if (!__VLS_ctx.isAlert) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.req))
                        throw 0;
                    if (!(!__VLS_ctx.isAlert))
                        throw 0;
                    return (__VLS_ctx.answerConfirm(false));
                    // @ts-ignore
                    [req, req, req, req, answerConfirm, isAlert, isAlert,];
                } },
            ...{ class: "btn btn-sm" },
        });
        /** @type {__VLS_StyleScopedClasses['btn']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
        (__VLS_ctx.req.cancel);
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.req))
                    throw 0;
                return (__VLS_ctx.answerConfirm(true));
                // @ts-ignore
                [req, answerConfirm,];
            } },
        ref: "okBtn",
        ...{ class: "btn btn-sm" },
        ...{ class: (__VLS_ctx.req.danger ? 'btn-danger' : 'btn-primary') },
    });
    /** @type {__VLS_StyleScopedClasses['btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
    (__VLS_ctx.req.ok || '确定');
}
// @ts-ignore
[req, req,];
var __VLS_9;
// @ts-ignore
[];
var __VLS_3;
// @ts-ignore
[];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
