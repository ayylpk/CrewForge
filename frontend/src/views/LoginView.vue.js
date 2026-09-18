import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { IconAlertTriangle, IconArrowRight } from '@tabler/icons-vue';
import { useAuthStore } from '../api/auth';
const router = useRouter();
const auth = useAuthStore();
const username = ref('');
const password = ref('');
const loading = ref(false);
const error = ref('');
const revealed = ref(false);
let t = 0;
onMounted(() => {
    // 图版显影：留给浏览器先 paint 一帧空版
    t = window.setTimeout(() => (revealed.value = true), 60);
});
onBeforeUnmount(() => clearTimeout(t));
/** 今天日期（标题栏"签发"格，真实数据非装饰） */
const today = computed(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
});
/** 登录：调真实接口，成功跳转项目页，失败显示后端返回的提示（行为与旧版一致） */
async function handleLogin() {
    error.value = '';
    loading.value = true;
    try {
        await auth.login({ username: username.value, password: password.value });
        router.push('/projects');
    }
    catch (err) {
        error.value = err instanceof Error ? err.message : '登录失败，请检查用户名和密码';
    }
    finally {
        loading.value = false;
    }
}
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['plate']} */ ;
/** @type {__VLS_StyleScopedClasses['plate-img']} */ ;
/** @type {__VLS_StyleScopedClasses['plate']} */ ;
/** @type {__VLS_StyleScopedClasses['revealed']} */ ;
/** @type {__VLS_StyleScopedClasses['develop-band']} */ ;
/** @type {__VLS_StyleScopedClasses['plate-word']} */ ;
/** @type {__VLS_StyleScopedClasses['plate-block']} */ ;
/** @type {__VLS_StyleScopedClasses['plate-block']} */ ;
/** @type {__VLS_StyleScopedClasses['sign-head']} */ ;
/** @type {__VLS_StyleScopedClasses['sign-foot']} */ ;
/** @type {__VLS_StyleScopedClasses['gate-entry']} */ ;
/** @type {__VLS_StyleScopedClasses['plate-block']} */ ;
/** @type {__VLS_StyleScopedClasses['plate-word']} */ ;
/** @type {__VLS_StyleScopedClasses['plate-brand']} */ ;
/** @type {__VLS_StyleScopedClasses['signoff']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "gate-entry" },
});
/** @type {__VLS_StyleScopedClasses['gate-entry']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.section, __VLS_intrinsics.section)({
    ...{ class: "plate" },
    ...{ class: ({ revealed: __VLS_ctx.revealed }) },
});
/** @type {__VLS_StyleScopedClasses['plate']} */ ;
/** @type {__VLS_StyleScopedClasses['revealed']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.img)({
    ...{ class: "plate-img" },
    src: "../assets/sheet-login-flow.png",
    alt: "CrewForge 软件生产线蓝晒图版",
});
/** @type {__VLS_StyleScopedClasses['plate-img']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "develop-band" },
    'aria-hidden': "true",
});
/** @type {__VLS_StyleScopedClasses['develop-band']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "plate-brand" },
});
/** @type {__VLS_StyleScopedClasses['plate-brand']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.img)({
    ...{ class: "plate-logo" },
    src: "../assets/logo-crewforge-cyan.png",
    alt: "",
    onerror: "this.style.display='none'",
});
/** @type {__VLS_StyleScopedClasses['plate-logo']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.h1, __VLS_intrinsics.h1)({
    ...{ class: "plate-word" },
});
/** @type {__VLS_StyleScopedClasses['plate-word']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({});
__VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
    ...{ class: "plate-slogan" },
});
/** @type {__VLS_StyleScopedClasses['plate-slogan']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "tblock plate-block" },
});
/** @type {__VLS_StyleScopedClasses['tblock']} */ ;
/** @type {__VLS_StyleScopedClasses['plate-block']} */ ;
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
__VLS_asFunctionalElement1(__VLS_intrinsics.section, __VLS_intrinsics.section)({
    ...{ class: "signoff" },
});
/** @type {__VLS_StyleScopedClasses['signoff']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "sign-card" },
});
/** @type {__VLS_StyleScopedClasses['sign-card']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.header, __VLS_intrinsics.header)({
    ...{ class: "sign-head" },
});
/** @type {__VLS_StyleScopedClasses['sign-head']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "sheet-no" },
});
/** @type {__VLS_StyleScopedClasses['sheet-no']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.h2, __VLS_intrinsics.h2)({});
__VLS_asFunctionalElement1(__VLS_intrinsics.form, __VLS_intrinsics.form)({
    ...{ onSubmit: (__VLS_ctx.handleLogin) },
    ...{ class: "sign-form" },
});
/** @type {__VLS_StyleScopedClasses['sign-form']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
    ...{ class: "field" },
});
/** @type {__VLS_StyleScopedClasses['field']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "field-label" },
});
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.input)({
    value: (__VLS_ctx.username),
    ...{ class: "input" },
    type: "text",
    autocomplete: "username",
    disabled: (__VLS_ctx.loading),
});
/** @type {__VLS_StyleScopedClasses['input']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.label, __VLS_intrinsics.label)({
    ...{ class: "field" },
});
/** @type {__VLS_StyleScopedClasses['field']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "field-label" },
});
/** @type {__VLS_StyleScopedClasses['field-label']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.input)({
    ...{ class: "input" },
    type: "password",
    autocomplete: "current-password",
    disabled: (__VLS_ctx.loading),
});
(__VLS_ctx.password);
/** @type {__VLS_StyleScopedClasses['input']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ class: "btn btn-primary sign-btn" },
    type: "submit",
    disabled: (__VLS_ctx.loading),
});
/** @type {__VLS_StyleScopedClasses['btn']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
/** @type {__VLS_StyleScopedClasses['sign-btn']} */ ;
(__VLS_ctx.loading ? '登录中…' : '进入工作台');
if (!__VLS_ctx.loading) {
    let __VLS_0;
    /** @ts-ignore @type { | typeof __VLS_components.IconArrowRight} */
    IconArrowRight;
    // @ts-ignore
    const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({
        size: (15),
        strokeWidth: (1.75),
    }));
    const __VLS_2 = __VLS_1({
        size: (15),
        strokeWidth: (1.75),
    }, ...__VLS_functionalComponentArgsRest(__VLS_1));
}
if (__VLS_ctx.error) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
        ...{ class: "sign-error" },
        role: "alert",
    });
    /** @type {__VLS_StyleScopedClasses['sign-error']} */ ;
    let __VLS_5;
    /** @ts-ignore @type { | typeof __VLS_components.IconAlertTriangle} */
    IconAlertTriangle;
    // @ts-ignore
    const __VLS_6 = __VLS_asFunctionalComponent1(__VLS_5, new __VLS_5({
        size: (15),
        strokeWidth: (1.75),
    }));
    const __VLS_7 = __VLS_6({
        size: (15),
        strokeWidth: (1.75),
    }, ...__VLS_functionalComponentArgsRest(__VLS_6));
    (__VLS_ctx.error);
}
__VLS_asFunctionalElement1(__VLS_intrinsics.footer, __VLS_intrinsics.footer)({
    ...{ class: "sign-foot" },
});
/** @type {__VLS_StyleScopedClasses['sign-foot']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
__VLS_asFunctionalElement1(__VLS_intrinsics.b, __VLS_intrinsics.b)({
    ...{ class: "mono" },
});
/** @type {__VLS_StyleScopedClasses['mono']} */ ;
(__VLS_ctx.today);
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
// @ts-ignore
[revealed, handleLogin, username, loading, loading, loading, loading, loading, password, error, error, today,];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
