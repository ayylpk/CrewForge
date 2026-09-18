import { onBeforeUnmount } from 'vue';
import { IconX } from '@tabler/icons-vue';
const props = withDefaults(defineProps(), { title: '', sheet: '', width: '560px', closeOnScrim: true, tone: 'paper' });
const emit = defineEmits();
function onKey(e) {
    if (e.key === 'Escape')
        emit('close');
}
window.addEventListener('keydown', onKey);
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
const __VLS_defaults = { title: '', sheet: '', width: '560px', closeOnScrim: true, tone: 'paper' };
const __VLS_ctx = {
    ...{},
    ...{},
    ...{},
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
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ onClick: (...[$event]) => {
            return (props.closeOnScrim && __VLS_ctx.emit('close'));
            // @ts-ignore
            [emit,];
        } },
    ...{ class: "scrim" },
    ...{ class: ({ 'vsc-dark': props.tone === 'dark' }) },
});
/** @type {__VLS_StyleScopedClasses['scrim']} */ ;
/** @type {__VLS_StyleScopedClasses['vsc-dark']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "modal sheet-fall" },
    ...{ style: ({ maxWidth: __VLS_ctx.width }) },
    role: "dialog",
    'aria-modal': "true",
    'aria-label': (__VLS_ctx.title),
});
/** @type {__VLS_StyleScopedClasses['modal']} */ ;
/** @type {__VLS_StyleScopedClasses['sheet-fall']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.header, __VLS_intrinsics.header)({
    ...{ class: "modal-head" },
});
/** @type {__VLS_StyleScopedClasses['modal-head']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "modal-titles" },
});
/** @type {__VLS_StyleScopedClasses['modal-titles']} */ ;
if (__VLS_ctx.sheet) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "sheet-no" },
    });
    /** @type {__VLS_StyleScopedClasses['sheet-no']} */ ;
    (__VLS_ctx.sheet);
}
__VLS_asFunctionalElement1(__VLS_intrinsics.h3, __VLS_intrinsics.h3)({
    ...{ class: "modal-title" },
});
/** @type {__VLS_StyleScopedClasses['modal-title']} */ ;
(__VLS_ctx.title);
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (...[$event]) => {
            return (__VLS_ctx.emit('close'));
            // @ts-ignore
            [emit, width, title, title, sheet, sheet,];
        } },
    ...{ class: "btn btn-ghost modal-x" },
    'aria-label': "关闭",
});
/** @type {__VLS_StyleScopedClasses['btn']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-ghost']} */ ;
/** @type {__VLS_StyleScopedClasses['modal-x']} */ ;
let __VLS_6;
/** @ts-ignore @type { | typeof __VLS_components.IconX} */
IconX;
// @ts-ignore
const __VLS_7 = __VLS_asFunctionalComponent1(__VLS_6, new __VLS_6({
    size: (17),
    strokeWidth: (1.75),
}));
const __VLS_8 = __VLS_7({
    size: (17),
    strokeWidth: (1.75),
}, ...__VLS_functionalComponentArgsRest(__VLS_7));
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "modal-body" },
});
/** @type {__VLS_StyleScopedClasses['modal-body']} */ ;
var __VLS_11 = {};
if (__VLS_ctx.$slots.footer) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.footer, __VLS_intrinsics.footer)({
        ...{ class: "modal-foot" },
    });
    /** @type {__VLS_StyleScopedClasses['modal-foot']} */ ;
    var __VLS_13 = {};
}
// @ts-ignore
[$slots,];
var __VLS_3;
// @ts-ignore
var __VLS_12 = __VLS_11, __VLS_14 = __VLS_13;
// @ts-ignore
[];
const __VLS_base = (await import('vue')).defineComponent({
    __typeEmits: {},
    __typeProps: {},
    props: {},
});
const __VLS_export = {};
export default {};
