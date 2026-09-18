import { ref } from 'vue';
import AppModal from './AppModal.vue';
import { createProject } from '../../api/project';
import { toast } from '../../utils/toast';
const emit = defineEmits();
const name = ref('');
const description = ref('');
const submitting = ref(false);
async function submit() {
    const n = name.value.trim();
    const d = description.value.trim();
    if (!n) {
        toast.warning('请先填写项目名称');
        return;
    }
    if (!d) {
        toast.warning('请先描述这个项目要做什么');
        return;
    }
    submitting.value = true;
    try {
        await createProject({ name: n, description: d, confirmMode: 'green' });
        toast.success('项目已创建——在台账里点它进「需求对话」确认功能');
        emit('created');
    }
    finally {
        submitting.value = false;
    }
}
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
/** @type {__VLS_StyleScopedClasses['csrow']} */ ;
const __VLS_0 = AppModal || AppModal;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({
    ...{ 'onClose': {} },
    title: "新建项目",
    sheet: "FORM-A02",
    width: "760px",
}));
const __VLS_2 = __VLS_1({
    ...{ 'onClose': {} },
    title: "新建项目",
    sheet: "FORM-A02",
    width: "760px",
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
let __VLS_5;
const __VLS_6 = {
    /** @type {typeof __VLS_5.close} */
    onClose: (...[$event]) => {
        return (__VLS_ctx.emit('close'));
        // @ts-ignore
        [emit,];
    },
};
var __VLS_7;
const { default: __VLS_8 } = __VLS_3.slots;
__VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
    ...{ class: "csrow" },
});
/** @type {__VLS_StyleScopedClasses['csrow']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "csrow-k" },
});
/** @type {__VLS_StyleScopedClasses['csrow-k']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.input)({
    ...{ onKeydown: (__VLS_ctx.submit) },
    value: (__VLS_ctx.name),
    ...{ class: "input" },
    type: "text",
    placeholder: "如：CRM 客户管理系统",
});
/** @type {__VLS_StyleScopedClasses['input']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
    ...{ class: "csrow csrow-col" },
});
/** @type {__VLS_StyleScopedClasses['csrow']} */ ;
/** @type {__VLS_StyleScopedClasses['csrow-col']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "csrow-k" },
});
/** @type {__VLS_StyleScopedClasses['csrow-k']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.textarea, __VLS_intrinsics.textarea)({
    value: (__VLS_ctx.description),
    ...{ class: "textarea" },
    rows: "11",
    placeholder: "描述这个项目要做什么样子的项目，如：为企业做一个 CRM 客户管理系统，管理客户档案、跟进销售过程、生成统计报表",
});
/** @type {__VLS_StyleScopedClasses['textarea']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "cs-hint faint" },
});
/** @type {__VLS_StyleScopedClasses['cs-hint']} */ ;
/** @type {__VLS_StyleScopedClasses['faint']} */ ;
{
    const { footer: __VLS_9 } = __VLS_3.slots;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                return (__VLS_ctx.emit('close'));
                // @ts-ignore
                [emit, submit, name, description,];
            } },
        ...{ class: "btn" },
        disabled: (__VLS_ctx.submitting),
    });
    /** @type {__VLS_StyleScopedClasses['btn']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (__VLS_ctx.submit) },
        ...{ class: "btn btn-primary" },
        disabled: (__VLS_ctx.submitting),
    });
    /** @type {__VLS_StyleScopedClasses['btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
    (__VLS_ctx.submitting ? '创建中…' : '创建项目');
    // @ts-ignore
    [submit, submitting, submitting, submitting,];
}
// @ts-ignore
[];
var __VLS_3;
var __VLS_4;
// @ts-ignore
[];
const __VLS_export = (await import('vue')).defineComponent({
    __typeEmits: {},
});
export default {};
