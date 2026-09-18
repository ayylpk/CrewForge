import { computed } from 'vue';
import { IconChevronDown, IconChevronRight, IconFile, IconFolder, IconFolderOpen } from '@tabler/icons-vue';
const props = defineProps();
const emit = defineEmits();
/** 深度优先展平：目录 open=false 时跳过子树 */
const rows = computed(() => {
    const out = [];
    const walk = (arr, depth) => {
        for (const n of arr) {
            out.push({ node: n, depth });
            if (n.type === 'dir' && n.open && n.children)
                walk(n.children, depth + 1);
        }
    };
    walk(props.nodes, 0);
    return out;
});
function toggle(row) {
    if (row.node.type === 'dir')
        row.node.open = !row.node.open;
    else
        emit('open', row.node);
}
/** 文件扩展名（右下角小角标，等宽） */
function extOf(name) {
    const i = name.lastIndexOf('.');
    return i > 0 ? name.slice(i + 1).toLowerCase() : '';
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
/** @type {__VLS_StyleScopedClasses['frow']} */ ;
/** @type {__VLS_StyleScopedClasses['frow']} */ ;
/** @type {__VLS_StyleScopedClasses['frow']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "ftree" },
});
/** @type {__VLS_StyleScopedClasses['ftree']} */ ;
if (!__VLS_ctx.rows.length) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "ftree-empty faint" },
    });
    /** @type {__VLS_StyleScopedClasses['ftree-empty']} */ ;
    /** @type {__VLS_StyleScopedClasses['faint']} */ ;
}
for (const [row] of __VLS_vFor((__VLS_ctx.rows))) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                return (__VLS_ctx.toggle(row));
                // @ts-ignore
                [rows, rows, toggle,];
            } },
        key: (row.node.path),
        ...{ class: "frow" },
        ...{ class: ({ active: row.node.path === __VLS_ctx.activePath, dir: row.node.type === 'dir' }) },
        ...{ style: ({ paddingLeft: 10 + row.depth * 16 + 'px' }) },
    });
    /** @type {__VLS_StyleScopedClasses['frow']} */ ;
    /** @type {__VLS_StyleScopedClasses['active']} */ ;
    /** @type {__VLS_StyleScopedClasses['dir']} */ ;
    if (row.node.type === 'dir' && row.node.open) {
        let __VLS_0;
        /** @ts-ignore @type { | typeof __VLS_components.IconChevronDown} */
        IconChevronDown;
        // @ts-ignore
        const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({
            size: (13),
            strokeWidth: (1.75),
            ...{ class: "chev" },
        }));
        const __VLS_2 = __VLS_1({
            size: (13),
            strokeWidth: (1.75),
            ...{ class: "chev" },
        }, ...__VLS_functionalComponentArgsRest(__VLS_1));
        /** @type {__VLS_StyleScopedClasses['chev']} */ ;
    }
    else if (row.node.type === 'dir') {
        let __VLS_5;
        /** @ts-ignore @type { | typeof __VLS_components.IconChevronRight} */
        IconChevronRight;
        // @ts-ignore
        const __VLS_6 = __VLS_asFunctionalComponent1(__VLS_5, new __VLS_5({
            size: (13),
            strokeWidth: (1.75),
            ...{ class: "chev" },
        }));
        const __VLS_7 = __VLS_6({
            size: (13),
            strokeWidth: (1.75),
            ...{ class: "chev" },
        }, ...__VLS_functionalComponentArgsRest(__VLS_6));
        /** @type {__VLS_StyleScopedClasses['chev']} */ ;
    }
    else {
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "chev-sp" },
            'aria-hidden': "true",
        });
        /** @type {__VLS_StyleScopedClasses['chev-sp']} */ ;
    }
    if (row.node.type === 'dir' && row.node.open) {
        let __VLS_10;
        /** @ts-ignore @type { | typeof __VLS_components.IconFolderOpen} */
        IconFolderOpen;
        // @ts-ignore
        const __VLS_11 = __VLS_asFunctionalComponent1(__VLS_10, new __VLS_10({
            size: (14),
            strokeWidth: (1.75),
            ...{ class: "ico dir-ico" },
        }));
        const __VLS_12 = __VLS_11({
            size: (14),
            strokeWidth: (1.75),
            ...{ class: "ico dir-ico" },
        }, ...__VLS_functionalComponentArgsRest(__VLS_11));
        /** @type {__VLS_StyleScopedClasses['ico']} */ ;
        /** @type {__VLS_StyleScopedClasses['dir-ico']} */ ;
    }
    else if (row.node.type === 'dir') {
        let __VLS_15;
        /** @ts-ignore @type { | typeof __VLS_components.IconFolder} */
        IconFolder;
        // @ts-ignore
        const __VLS_16 = __VLS_asFunctionalComponent1(__VLS_15, new __VLS_15({
            size: (14),
            strokeWidth: (1.75),
            ...{ class: "ico dir-ico" },
        }));
        const __VLS_17 = __VLS_16({
            size: (14),
            strokeWidth: (1.75),
            ...{ class: "ico dir-ico" },
        }, ...__VLS_functionalComponentArgsRest(__VLS_16));
        /** @type {__VLS_StyleScopedClasses['ico']} */ ;
        /** @type {__VLS_StyleScopedClasses['dir-ico']} */ ;
    }
    else {
        let __VLS_20;
        /** @ts-ignore @type { | typeof __VLS_components.IconFile} */
        IconFile;
        // @ts-ignore
        const __VLS_21 = __VLS_asFunctionalComponent1(__VLS_20, new __VLS_20({
            size: (14),
            strokeWidth: (1.75),
            ...{ class: "ico" },
        }));
        const __VLS_22 = __VLS_21({
            size: (14),
            strokeWidth: (1.75),
            ...{ class: "ico" },
        }, ...__VLS_functionalComponentArgsRest(__VLS_21));
        /** @type {__VLS_StyleScopedClasses['ico']} */ ;
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "fname" },
        title: (row.node.path),
    });
    /** @type {__VLS_StyleScopedClasses['fname']} */ ;
    (row.node.name);
    if (row.node.userModified) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "mod" },
            title: "你手工改过（引擎不会再覆盖）",
        });
        /** @type {__VLS_StyleScopedClasses['mod']} */ ;
    }
    else if (row.node.type === 'file' && __VLS_ctx.extOf(row.node.name)) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "ext mono" },
        });
        /** @type {__VLS_StyleScopedClasses['ext']} */ ;
        /** @type {__VLS_StyleScopedClasses['mono']} */ ;
        (__VLS_ctx.extOf(row.node.name));
    }
    // @ts-ignore
    [activePath, extOf, extOf,];
}
// @ts-ignore
[];
const __VLS_export = (await import('vue')).defineComponent({
    __typeEmits: {},
    __typeProps: {},
});
export default {};
