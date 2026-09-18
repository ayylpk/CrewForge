import { computed } from 'vue';
import { IconShieldLock } from '@tabler/icons-vue';
import { parseDetail } from '../../api/confirm';
const props = defineProps();
const emit = defineEmits();
const d = computed(() => parseDetail(props.req));
const ruleContent = computed(() => (d.value.ruleContent ?? '').trim());
const canRemember = computed(() => ruleContent.value.length > 0);
const ruleLabel = computed(() => `Bash(${ruleContent.value})`);
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
/** @type {__VLS_StyleScopedClasses['perm-pop-rule']} */ ;
/** @type {__VLS_StyleScopedClasses['perm-pop-actions']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "perm-pop" },
});
/** @type {__VLS_StyleScopedClasses['perm-pop']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "perm-pop-head" },
});
/** @type {__VLS_StyleScopedClasses['perm-pop-head']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "perm-pop-tag" },
});
/** @type {__VLS_StyleScopedClasses['perm-pop-tag']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "perm-pop-meta mono faint" },
});
/** @type {__VLS_StyleScopedClasses['perm-pop-meta']} */ ;
/** @type {__VLS_StyleScopedClasses['mono']} */ ;
/** @type {__VLS_StyleScopedClasses['faint']} */ ;
(__VLS_ctx.d.tool || __VLS_ctx.req.node);
(__VLS_ctx.countdown ? ` · ${__VLS_ctx.countdown}` : '');
if (__VLS_ctx.d.command) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.pre, __VLS_intrinsics.pre)({
        ...{ class: "perm-pop-cmd mono" },
    });
    /** @type {__VLS_StyleScopedClasses['perm-pop-cmd']} */ ;
    /** @type {__VLS_StyleScopedClasses['mono']} */ ;
    (__VLS_ctx.d.command);
}
else {
    __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
        ...{ class: "perm-pop-q" },
    });
    /** @type {__VLS_StyleScopedClasses['perm-pop-q']} */ ;
    (__VLS_ctx.req.question);
}
if (__VLS_ctx.d.why) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
        ...{ class: "perm-pop-why faint" },
    });
    /** @type {__VLS_StyleScopedClasses['perm-pop-why']} */ ;
    /** @type {__VLS_StyleScopedClasses['faint']} */ ;
    (__VLS_ctx.d.why);
}
if (__VLS_ctx.canRemember) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
        ...{ class: "perm-pop-rule" },
    });
    /** @type {__VLS_StyleScopedClasses['perm-pop-rule']} */ ;
    let __VLS_0;
    /** @ts-ignore @type { | typeof __VLS_components.IconShieldLock} */
    IconShieldLock;
    // @ts-ignore
    const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({
        size: (12),
        strokeWidth: (1.75),
    }));
    const __VLS_2 = __VLS_1({
        size: (12),
        strokeWidth: (1.75),
    }, ...__VLS_functionalComponentArgsRest(__VLS_1));
    __VLS_asFunctionalElement1(__VLS_intrinsics.code, __VLS_intrinsics.code)({
        ...{ class: "mono" },
    });
    /** @type {__VLS_StyleScopedClasses['mono']} */ ;
    (__VLS_ctx.ruleLabel);
}
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "perm-pop-actions" },
});
/** @type {__VLS_StyleScopedClasses['perm-pop-actions']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (...[$event]) => {
            return (__VLS_ctx.emit('decide', 'allow_once'));
            // @ts-ignore
            [d, d, d, d, d, req, req, countdown, countdown, canRemember, ruleLabel, emit,];
        } },
    ...{ class: "btn btn-sm perm-yes" },
    disabled: (__VLS_ctx.busy),
});
/** @type {__VLS_StyleScopedClasses['btn']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['perm-yes']} */ ;
if (__VLS_ctx.canRemember) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.canRemember))
                    throw 0;
                return (__VLS_ctx.emit('decide', 'allow_always'));
                // @ts-ignore
                [canRemember, emit, busy,];
            } },
        ...{ class: "btn btn-sm perm-always" },
        disabled: (__VLS_ctx.busy),
        title: (`写入规则 ${__VLS_ctx.ruleLabel}`),
    });
    /** @type {__VLS_StyleScopedClasses['btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
    /** @type {__VLS_StyleScopedClasses['perm-always']} */ ;
}
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (...[$event]) => {
            return (__VLS_ctx.emit('decide', 'deny'));
            // @ts-ignore
            [ruleLabel, emit, busy,];
        } },
    ...{ class: "btn btn-sm perm-no" },
    disabled: (__VLS_ctx.busy),
});
/** @type {__VLS_StyleScopedClasses['btn']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
/** @type {__VLS_StyleScopedClasses['perm-no']} */ ;
// @ts-ignore
[busy,];
const __VLS_export = (await import('vue')).defineComponent({
    __typeEmits: {},
    __typeProps: {},
});
export default {};
