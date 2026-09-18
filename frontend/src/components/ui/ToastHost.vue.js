import { IconAlertTriangle, IconCircleCheck, IconCircleX, IconInfoCircle, IconX, } from '@tabler/icons-vue';
import { dismiss, toast } from '../../utils/toast';
const ICONS = {
    success: IconCircleCheck,
    error: IconCircleX,
    warning: IconAlertTriangle,
    info: IconInfoCircle,
};
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['t-ico']} */ ;
/** @type {__VLS_StyleScopedClasses['t-ico']} */ ;
/** @type {__VLS_StyleScopedClasses['t-ico']} */ ;
/** @type {__VLS_StyleScopedClasses['t-ico']} */ ;
/** @type {__VLS_StyleScopedClasses['t-close']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "toast-host" },
    'aria-live': "polite",
});
/** @type {__VLS_StyleScopedClasses['toast-host']} */ ;
let __VLS_0;
/** @ts-ignore @type { | typeof __VLS_components.TransitionGroup | typeof __VLS_components.TransitionGroup} */
TransitionGroup;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({
    name: "toast",
}));
const __VLS_2 = __VLS_1({
    name: "toast",
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
const { default: __VLS_5 } = __VLS_3.slots;
for (const [t] of __VLS_vFor((__VLS_ctx.toast.state.items))) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        key: (t.id),
        ...{ class: "toast-item" },
        ...{ class: (`t-${t.kind}`) },
    });
    /** @type {__VLS_StyleScopedClasses['toast-item']} */ ;
    const __VLS_6 = (__VLS_ctx.ICONS[t.kind]);
    // @ts-ignore
    const __VLS_7 = __VLS_asFunctionalComponent1(__VLS_6, new __VLS_6({
        size: (17),
        strokeWidth: (1.75),
        ...{ class: "t-ico" },
    }));
    const __VLS_8 = __VLS_7({
        size: (17),
        strokeWidth: (1.75),
        ...{ class: "t-ico" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_7));
    /** @type {__VLS_StyleScopedClasses['t-ico']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "t-text" },
    });
    /** @type {__VLS_StyleScopedClasses['t-text']} */ ;
    (t.text);
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                return (__VLS_ctx.dismiss(t.id));
                // @ts-ignore
                [toast, ICONS, dismiss,];
            } },
        ...{ class: "t-close" },
        'aria-label': "关闭提示",
    });
    /** @type {__VLS_StyleScopedClasses['t-close']} */ ;
    let __VLS_11;
    /** @ts-ignore @type { | typeof __VLS_components.IconX} */
    IconX;
    // @ts-ignore
    const __VLS_12 = __VLS_asFunctionalComponent1(__VLS_11, new __VLS_11({
        size: (13),
        strokeWidth: (1.75),
    }));
    const __VLS_13 = __VLS_12({
        size: (13),
        strokeWidth: (1.75),
    }, ...__VLS_functionalComponentArgsRest(__VLS_12));
    // @ts-ignore
    [];
}
// @ts-ignore
[];
var __VLS_3;
// @ts-ignore
[];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
