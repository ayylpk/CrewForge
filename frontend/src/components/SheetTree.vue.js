import { computed, onBeforeUnmount, reactive, ref } from 'vue';
import { IconChevronDown, IconChevronRight, IconCopy, IconFile, IconFilePlus, IconFolder, IconFolderOpen, IconFolderPlus, IconPencil, IconScissors, IconClipboard, IconTrash, } from '@tabler/icons-vue';
import { cleanTree, cloneFresh, containsNode, findNodeById, newNode } from '../types/tree';
import { confirmDialog } from '../utils/confirm';
const props = defineProps();
const emit = defineEmits();
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
/* ---------- 剪贴板（copy=留原处 / cut=贴时搬走） ---------- */
const clip = ref(null);
/* ---------- 右键操作单（node=null 表示根级空白区） ---------- */
const MENU_W = 170;
const menu = reactive({
    x: 0,
    y: 0,
    node: null,
    open: false,
});
function showMenu(e, node) {
    // 贴边翻转：菜单别出屏幕（旧版 menuW=170 同口径，另补纵向防溢出）
    let x = e.clientX;
    let y = e.clientY;
    if (x + MENU_W + 8 > window.innerWidth)
        x = Math.max(8, e.clientX - MENU_W);
    if (y + 250 > window.innerHeight)
        y = Math.max(8, window.innerHeight - 260);
    menu.x = x;
    menu.y = y;
    menu.node = node;
    menu.open = true;
}
function closeMenu() {
    menu.open = false;
    menu.node = null;
}
// 点击任何地方都收单（菜单自身点击在选择项后自行关闭）
document.addEventListener('click', closeMenu);
window.addEventListener('blur', closeMenu);
onBeforeUnmount(() => {
    document.removeEventListener('click', closeMenu);
    window.removeEventListener('blur', closeMenu);
});
/* ---------- 树操作 ---------- */
function findParent(id) {
    const walk = (arr) => {
        for (const n of arr) {
            if (n.id === id)
                return arr;
            if (n.children) {
                const hit = walk(n.children);
                if (hit)
                    return hit;
            }
        }
        return null;
    };
    return walk(props.nodes);
}
function containerOf(node) {
    return node.children ?? (node.children = []);
}
function addAt(type, parent) {
    const n = newNode(type === 'dir' ? '新建文件夹' : '新建文件.txt', type);
    if (parent) {
        containerOf(parent).push(n);
        parent.open = true;
    }
    else {
        props.nodes.push(n);
    }
    startRename(n);
    emit('change');
}
/** 环防护（与旧版一致的双向检查）：目标不得是剪贴板自身/其祖先/其子孙 */
function canPaste(target) {
    const c = clip.value;
    if (!c)
        return false;
    if (!target)
        return true; // 根级总能贴
    if (target.type === 'file')
        return false;
    return target.id !== c.node.id && !containsNode(target, c.node.id) && !containsNode(c.node, target.id);
}
function pasteInto(target) {
    const c = clip.value;
    if (!c || !canPaste(target))
        return;
    let container;
    if (target) {
        container = containerOf(target);
        target.open = true;
    }
    else {
        container = props.nodes;
    }
    if (c.mode === 'copy') {
        container.push(cloneFresh(c.node));
    }
    else {
        // 剪切 = 先摘原处再挂新处
        const list = findParent(c.node.id);
        if (list)
            list.splice(list.indexOf(c.node), 1);
        container.push(c.node);
        clip.value = null;
    }
    emit('change');
}
async function removeNode(node) {
    const ok = await confirmDialog({
        title: '删除确认',
        body: `确定删除「${node.name}」吗？${node.type === 'dir' ? '目录内的文件将一并删除。' : ''}`,
        ok: '删除',
        cancel: '取消',
        danger: true,
    });
    if (!ok)
        return;
    const list = findParent(node.id);
    if (list)
        list.splice(list.indexOf(node), 1);
    if (selectedId.value === node.id)
        selectedId.value = null;
    emit('change');
}
/* ---------- 选中 / 内联重命名 ---------- */
const selectedId = ref(null);
const renameId = ref(null);
const renameVal = ref('');
function startRename(node) {
    renameId.value = node.id;
    renameVal.value = node.name;
    closeMenu();
}
function commitRename() {
    if (renameId.value == null)
        return;
    const node = findNodeById(props.nodes, renameId.value);
    const v = renameVal.value.trim();
    if (node && v && v !== node.name) {
        node.name = v;
        emit('change');
    }
    renameId.value = null;
}
function cancelRename() {
    renameId.value = null;
}
function toggle(node) {
    if (node.type === 'dir')
        node.open = !node.open;
}
/* ---------- 菜单动作分发 ---------- */
function menuAct(act) {
    const node = menu.node;
    switch (act) {
        case 'new-file':
            addAt('file', node);
            break;
        case 'new-dir':
            addAt('dir', node);
            break;
        case 'paste':
            pasteInto(node);
            closeMenu();
            break;
        case 'copy':
            if (node)
                clip.value = { mode: 'copy', node };
            closeMenu();
            break;
        case 'cut':
            if (node)
                clip.value = { mode: 'cut', node };
            closeMenu();
            break;
        case 'rename':
            if (node)
                startRename(node);
            break;
        case 'remove':
            if (node)
                void removeNode(node);
            closeMenu();
            break;
    }
}
/** 对外：工具条按钮直连 + 干净结构导出 */
const __VLS_exposed = {
    addAt: (t) => addAt(t, null),
    pasteAtRoot: () => pasteInto(null),
    hasClip: () => !!clip.value,
    exportClean: () => cleanTree(props.nodes),
};
defineExpose(__VLS_exposed);
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
/** @type {__VLS_StyleScopedClasses['srow']} */ ;
/** @type {__VLS_StyleScopedClasses['srow']} */ ;
/** @type {__VLS_StyleScopedClasses['srow']} */ ;
/** @type {__VLS_StyleScopedClasses['srow']} */ ;
/** @type {__VLS_StyleScopedClasses['sname']} */ ;
/** @type {__VLS_StyleScopedClasses['srow']} */ ;
/** @type {__VLS_StyleScopedClasses['more']} */ ;
/** @type {__VLS_StyleScopedClasses['srow']} */ ;
/** @type {__VLS_StyleScopedClasses['more']} */ ;
/** @type {__VLS_StyleScopedClasses['more']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ onContextmenu: (...[$event]) => {
            return (__VLS_ctx.showMenu($event, null));
            // @ts-ignore
            [showMenu,];
        } },
    ...{ class: "stree" },
});
/** @type {__VLS_StyleScopedClasses['stree']} */ ;
if (!__VLS_ctx.rows.length) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "stree-empty" },
    });
    /** @type {__VLS_StyleScopedClasses['stree-empty']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "faint" },
    });
    /** @type {__VLS_StyleScopedClasses['faint']} */ ;
}
for (const [row] of __VLS_vFor((__VLS_ctx.rows))) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ onClick: (...[$event]) => {
                return (__VLS_ctx.selectedId = row.node.id);
                // @ts-ignore
                [rows, rows, selectedId,];
            } },
        ...{ onContextmenu: (...[$event]) => {
                return (__VLS_ctx.showMenu($event, row.node));
                // @ts-ignore
                [showMenu,];
            } },
        key: (row.node.id),
        ...{ class: "srow" },
        ...{ class: ({
                dir: row.node.type === 'dir',
                selected: __VLS_ctx.selectedId === row.node.id,
                clipped: __VLS_ctx.clip?.mode === 'cut' && __VLS_ctx.clip.node.id === row.node.id,
            }) },
        ...{ style: ({ paddingLeft: 8 + row.depth * 16 + 'px' }) },
    });
    /** @type {__VLS_StyleScopedClasses['srow']} */ ;
    /** @type {__VLS_StyleScopedClasses['dir']} */ ;
    /** @type {__VLS_StyleScopedClasses['selected']} */ ;
    /** @type {__VLS_StyleScopedClasses['clipped']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                return (__VLS_ctx.toggle(row.node));
                // @ts-ignore
                [selectedId, clip, clip, toggle,];
            } },
        ...{ class: "chev" },
        'aria-label': (row.node.open ? '收起' : '展开'),
    });
    /** @type {__VLS_StyleScopedClasses['chev']} */ ;
    if (row.node.type === 'dir' && row.node.open) {
        let __VLS_0;
        /** @ts-ignore @type { | typeof __VLS_components.IconChevronDown} */
        IconChevronDown;
        // @ts-ignore
        const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({
            size: (13),
            strokeWidth: (1.75),
        }));
        const __VLS_2 = __VLS_1({
            size: (13),
            strokeWidth: (1.75),
        }, ...__VLS_functionalComponentArgsRest(__VLS_1));
    }
    else if (row.node.type === 'dir') {
        let __VLS_5;
        /** @ts-ignore @type { | typeof __VLS_components.IconChevronRight} */
        IconChevronRight;
        // @ts-ignore
        const __VLS_6 = __VLS_asFunctionalComponent1(__VLS_5, new __VLS_5({
            size: (13),
            strokeWidth: (1.75),
        }));
        const __VLS_7 = __VLS_6({
            size: (13),
            strokeWidth: (1.75),
        }, ...__VLS_functionalComponentArgsRest(__VLS_6));
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
    if (__VLS_ctx.renameId === row.node.id) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
            ...{ onClick: () => { } },
            ...{ onKeydown: (__VLS_ctx.commitRename) },
            ...{ onKeydown: (__VLS_ctx.cancelRename) },
            ...{ onBlur: (__VLS_ctx.commitRename) },
            ...{ class: "rename" },
            autofocus: true,
        });
        (__VLS_ctx.renameVal);
        /** @type {__VLS_StyleScopedClasses['rename']} */ ;
    }
    else {
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ onDblclick: (...[$event]) => {
                    if (!!(__VLS_ctx.renameId === row.node.id))
                        throw 0;
                    return (__VLS_ctx.startRename(row.node));
                    // @ts-ignore
                    [renameId, commitRename, commitRename, cancelRename, renameVal, startRename,];
                } },
            ...{ class: "sname" },
            title: (row.node.name),
        });
        /** @type {__VLS_StyleScopedClasses['sname']} */ ;
        (row.node.name);
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                return (__VLS_ctx.showMenu($event, row.node));
                // @ts-ignore
                [showMenu,];
            } },
        ...{ class: "more" },
        'aria-label': "更多操作",
    });
    /** @type {__VLS_StyleScopedClasses['more']} */ ;
    // @ts-ignore
    [];
}
let __VLS_25;
/** @ts-ignore @type { | typeof __VLS_components.Teleport | typeof __VLS_components.Teleport} */
Teleport;
// @ts-ignore
const __VLS_26 = __VLS_asFunctionalComponent1(__VLS_25, new __VLS_25({
    to: "body",
}));
const __VLS_27 = __VLS_26({
    to: "body",
}, ...__VLS_functionalComponentArgsRest(__VLS_26));
const { default: __VLS_30 } = __VLS_28.slots;
if (__VLS_ctx.menu.open) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ onClick: () => { } },
        ...{ onContextmenu: () => { } },
        ...{ class: "ctx" },
        ...{ style: ({ left: __VLS_ctx.menu.x + 'px', top: __VLS_ctx.menu.y + 'px', width: __VLS_ctx.MENU_W + 'px' }) },
    });
    /** @type {__VLS_StyleScopedClasses['ctx']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.menu.open))
                    throw 0;
                return (__VLS_ctx.menuAct('new-file'));
                // @ts-ignore
                [menu, menu, menu, MENU_W, menuAct,];
            } },
        ...{ class: "ctx-i" },
    });
    /** @type {__VLS_StyleScopedClasses['ctx-i']} */ ;
    let __VLS_31;
    /** @ts-ignore @type { | typeof __VLS_components.IconFilePlus} */
    IconFilePlus;
    // @ts-ignore
    const __VLS_32 = __VLS_asFunctionalComponent1(__VLS_31, new __VLS_31({
        size: (14),
        strokeWidth: (1.75),
    }));
    const __VLS_33 = __VLS_32({
        size: (14),
        strokeWidth: (1.75),
    }, ...__VLS_functionalComponentArgsRest(__VLS_32));
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.menu.open))
                    throw 0;
                return (__VLS_ctx.menuAct('new-dir'));
                // @ts-ignore
                [menuAct,];
            } },
        ...{ class: "ctx-i" },
    });
    /** @type {__VLS_StyleScopedClasses['ctx-i']} */ ;
    let __VLS_36;
    /** @ts-ignore @type { | typeof __VLS_components.IconFolderPlus} */
    IconFolderPlus;
    // @ts-ignore
    const __VLS_37 = __VLS_asFunctionalComponent1(__VLS_36, new __VLS_36({
        size: (14),
        strokeWidth: (1.75),
    }));
    const __VLS_38 = __VLS_37({
        size: (14),
        strokeWidth: (1.75),
    }, ...__VLS_functionalComponentArgsRest(__VLS_37));
    if (__VLS_ctx.clip) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.menu.open))
                        throw 0;
                    if (!(__VLS_ctx.clip))
                        throw 0;
                    return (__VLS_ctx.menuAct('paste'));
                    // @ts-ignore
                    [clip, menuAct,];
                } },
            ...{ class: "ctx-i" },
            disabled: (!__VLS_ctx.canPaste(__VLS_ctx.menu.open ? __VLS_ctx.menu.node : null)),
        });
        /** @type {__VLS_StyleScopedClasses['ctx-i']} */ ;
        let __VLS_41;
        /** @ts-ignore @type { | typeof __VLS_components.IconClipboard} */
        IconClipboard;
        // @ts-ignore
        const __VLS_42 = __VLS_asFunctionalComponent1(__VLS_41, new __VLS_41({
            size: (14),
            strokeWidth: (1.75),
        }));
        const __VLS_43 = __VLS_42({
            size: (14),
            strokeWidth: (1.75),
        }, ...__VLS_functionalComponentArgsRest(__VLS_42));
        (__VLS_ctx.menu.node ? '粘贴到这里' : '粘贴');
    }
    if (__VLS_ctx.menu.node) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "ctx-sep" },
        });
        /** @type {__VLS_StyleScopedClasses['ctx-sep']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.menu.open))
                        throw 0;
                    if (!(__VLS_ctx.menu.node))
                        throw 0;
                    return (__VLS_ctx.menuAct('copy'));
                    // @ts-ignore
                    [menu, menu, menu, menu, menuAct, canPaste,];
                } },
            ...{ class: "ctx-i" },
        });
        /** @type {__VLS_StyleScopedClasses['ctx-i']} */ ;
        let __VLS_46;
        /** @ts-ignore @type { | typeof __VLS_components.IconCopy} */
        IconCopy;
        // @ts-ignore
        const __VLS_47 = __VLS_asFunctionalComponent1(__VLS_46, new __VLS_46({
            size: (14),
            strokeWidth: (1.75),
        }));
        const __VLS_48 = __VLS_47({
            size: (14),
            strokeWidth: (1.75),
        }, ...__VLS_functionalComponentArgsRest(__VLS_47));
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.menu.open))
                        throw 0;
                    if (!(__VLS_ctx.menu.node))
                        throw 0;
                    return (__VLS_ctx.menuAct('cut'));
                    // @ts-ignore
                    [menuAct,];
                } },
            ...{ class: "ctx-i" },
        });
        /** @type {__VLS_StyleScopedClasses['ctx-i']} */ ;
        let __VLS_51;
        /** @ts-ignore @type { | typeof __VLS_components.IconScissors} */
        IconScissors;
        // @ts-ignore
        const __VLS_52 = __VLS_asFunctionalComponent1(__VLS_51, new __VLS_51({
            size: (14),
            strokeWidth: (1.75),
        }));
        const __VLS_53 = __VLS_52({
            size: (14),
            strokeWidth: (1.75),
        }, ...__VLS_functionalComponentArgsRest(__VLS_52));
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.menu.open))
                        throw 0;
                    if (!(__VLS_ctx.menu.node))
                        throw 0;
                    return (__VLS_ctx.menuAct('rename'));
                    // @ts-ignore
                    [menuAct,];
                } },
            ...{ class: "ctx-i" },
        });
        /** @type {__VLS_StyleScopedClasses['ctx-i']} */ ;
        let __VLS_56;
        /** @ts-ignore @type { | typeof __VLS_components.IconPencil} */
        IconPencil;
        // @ts-ignore
        const __VLS_57 = __VLS_asFunctionalComponent1(__VLS_56, new __VLS_56({
            size: (14),
            strokeWidth: (1.75),
        }));
        const __VLS_58 = __VLS_57({
            size: (14),
            strokeWidth: (1.75),
        }, ...__VLS_functionalComponentArgsRest(__VLS_57));
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "ctx-sep" },
        });
        /** @type {__VLS_StyleScopedClasses['ctx-sep']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.menu.open))
                        throw 0;
                    if (!(__VLS_ctx.menu.node))
                        throw 0;
                    return (__VLS_ctx.menuAct('remove'));
                    // @ts-ignore
                    [menuAct,];
                } },
            ...{ class: "ctx-i ctx-del" },
        });
        /** @type {__VLS_StyleScopedClasses['ctx-i']} */ ;
        /** @type {__VLS_StyleScopedClasses['ctx-del']} */ ;
        let __VLS_61;
        /** @ts-ignore @type { | typeof __VLS_components.IconTrash} */
        IconTrash;
        // @ts-ignore
        const __VLS_62 = __VLS_asFunctionalComponent1(__VLS_61, new __VLS_61({
            size: (14),
            strokeWidth: (1.75),
        }));
        const __VLS_63 = __VLS_62({
            size: (14),
            strokeWidth: (1.75),
        }, ...__VLS_functionalComponentArgsRest(__VLS_62));
    }
}
// @ts-ignore
[];
var __VLS_28;
// @ts-ignore
[];
const __VLS_export = (await import('vue')).defineComponent({
    setup: () => __VLS_exposed,
    __typeEmits: {},
    __typeProps: {},
});
export default {};
