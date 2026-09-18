import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { IconCheck, IconCircle, IconPlus, IconSend, IconX, } from '@tabler/icons-vue';
import TopBar from '../components/ui/TopBar.vue';
import { answerConfirm, fetchConfirmHistory, fetchPendingConfirms, parseOptions, } from '../api/confirm';
import { fetchProjectById, updateProject } from '../api/project';
import { fetchRunStatus, startProjectRun } from '../api/projectRun';
import { MODE_NUM_TO_STR as SHARED_MODE_NUM_TO_STR } from '../constants/status';
import { ENVELOPE_KEYS, buildClarifiedReqJson, parseEnvelopeArray, toDisplayList } from '../utils/json';
import { toast } from '../utils/toast';
const router = useRouter();
const route = useRoute();
/**
 * 9/18：本页**只剩澄清模式**。
 *   原来是双模式（/projects/new 新建 + /projects/:id/pm 澄清），但两页配置区高度重复
 *   （用户实测反馈）—— 新建已退化成台账页里的弹窗（components/ui/CreateProjectSheet.vue）。
 *   所以这里不再有 isEdit 分支：:id 一定存在。
 */
const projectId = Number(route.params.id || 0);
// ===== 表单 =====（类型 = 后端 ProjectDTO 白名单，全字段集中在这，保存统一走 updateProject）
// ⚠️ 可选字段不能给 ''：空字符串会被后端 updateById 当真值覆盖；undefined 才表示"不修改"
const form = ref({
    name: '',
    description: '', // 项目描述：要做什么样子的项目
    confirmMode: 'mixed',
    // 以下可选字段：页面有输入/加载到值才赋值；undefined = 不发送 = 后端不修改
    clarifiedReq: undefined,
    businessModules: undefined,
    techStack: undefined,
    devPlan: undefined,
    status: undefined,
});
// ===== 工作台状态 =====
const working = ref(false); // 是否工作中（对话时点亮）
const saving = ref(false); // 澄清模式：保存功能清单中
const descSaving = ref(false); // 澄清模式：保存描述中
const nameSaving = ref(false); // 澄清模式：保存名称中
const modeSaving = ref(false); // 澄清模式：保存确认模式中
/* ===== 澄清阶段：已确认功能清单 =====
   ⚠️ 读 clarified_req，不是 business_modules（9/18 修「功能不实时添加」）：
     clarified_req    PM 澄清阶段**每轮确认后**累积写入（Node.ts saveClarifiedReq），
                      信封是 {features:[{name,description,priority,acceptance}]}
     business_modules 架构师拆分阶段才写（Node.ts saveArchitectOutput）
   本页整页就是澄清阶段，读 business_modules 的话 —— 对话聊完、PM 都定稿了，
   这列还是空的，页面永远显示"还没有确认功能"。数据其实一直在库里（实测 840 字/6 条）。
   兜底读 business_modules：老项目 clarified_req 可能没写过，有就显示。 */
const features = ref([]);
const featureDraft = ref('');
/** 后端 JSON 列解析：认裸数组，也认引擎写的信封对象（见 utils/json.ts） */
function parseJsonArr(raw, keys = ENVELOPE_KEYS.clarifiedReq) {
    return toDisplayList(parseEnvelopeArray(raw, keys));
}
/** 本页的功能清单 = PM 的已确认功能；没有才退到架构师的业务模块 */
function pmFeaturesOf(p) {
    const pm = parseJsonArr(p.clarifiedReq);
    return pm.length ? pm : parseJsonArr(p.businessModules, ENVELOPE_KEYS.businessModules);
}
/** 数字 → 前端串：用 constants/status 的那一份（索引即 0/1/2），不再本地复制一份映射 */
const modeNumToStr = (n) => SHARED_MODE_NUM_TO_STR[n] ?? 'mixed';
const MODE_LABELS = {
    green: '全绿灯模式',
    mixed: '混合模式',
    manual: '手动模式',
};
/** 回读项目的已确认功能清单（PM 每轮都写 clarified_req，所以轮询里调它 = 实时长出来） */
async function reloadFeatures() {
    try {
        const p = await fetchProjectById(projectId);
        features.value = pmFeaturesOf(p);
        form.value.clarifiedReq = p.clarifiedReq || undefined;
        form.value.businessModules = p.businessModules || undefined;
        form.value.status = p.status || undefined;
    }
    catch (e) {
        if (isProjectGone(e))
            markProjectGone();
    }
}
/** 进入时加载项目，填充名称/描述/已确认功能，并开始轮询确认门 */
onMounted(async () => {
    try {
        const p = await fetchProjectById(projectId);
        form.value.name = p.name;
        form.value.description = p.description || '';
        form.value.confirmMode = modeNumToStr(p.confirmMode);
        // 全字段填充：有值才填，undefined 的字段保存时不发送（不会覆盖后端）
        form.value.clarifiedReq = p.clarifiedReq || undefined;
        form.value.businessModules = p.businessModules || undefined;
        form.value.techStack = p.techStack || undefined;
        form.value.devPlan = p.devPlan || undefined;
        form.value.status = p.status || undefined;
        features.value = pmFeaturesOf(p);
    }
    catch (e) {
        // 项目已经没了（比如在另一个标签页删掉了）→ 立刻停手，别起轮询去反复撞
        if (isProjectGone(e)) {
            markProjectGone();
            return;
        }
        /* 其余错误拦截器已提示，轮询照起（后端抖动还能自愈） */
    }
    // 对话：先补历史（刷新后对话还在），再起 4s 轮询等新题（与执行面板 CONFIRM_POLL 同频）
    await loadPmHistory();
    await pollPm();
    if (!projectGone.value)
        pollTimer = setInterval(pollPm, 4000);
});
onUnmounted(() => {
    if (pollTimer)
        clearInterval(pollTimer);
    pollTimer = null;
});
const nameDone = computed(() => !!form.value.name.trim());
const modeDone = computed(() => !!form.value.confirmMode);
/** 功能清单是否已确认 */
const featureDone = computed(() => features.value.length > 0);
const phaseLabel = computed(() => {
    if (working.value)
        return '正在解析你的描述';
    return features.value.length > 0 ? `已确认 ${features.value.length} 项功能` : '等待确认具体功能';
});
/** 手动添加功能点（澄清模式）
 * ⚠️ 9/17 修"点了添加没反应"：原来空输入和"已存在"都是**静默 return/清空**，用户完全
 * 不知道发生了什么（同文件的 saveFeatures 却会给 warning，口径不一致）。
 * 现在两种失败都给出可读提示，成功也回一句——点了没有任何反馈本身就是 bug。 */
function addFeature() {
    const text = featureDraft.value.trim();
    if (!text) {
        toast.warning('请先输入功能点再点「添加」');
        return;
    }
    if (features.value.includes(text)) {
        toast.warning(`「${text}」已经在清单里了`);
        featureDraft.value = '';
        return;
    }
    features.value.push(text);
    featureDraft.value = '';
    toast.success(`已加入：${text}（记得点右上角「保存功能清单」落库）`);
}
/** 澄清模式：保存项目描述（只提交 description）
 * ⚠️ 9/17 修「devPlan 必须是 JSON 数组」：
 *   原来这里是 `updateProject(projectId, { ...form.value })` —— 把进页面时读到的**整行**
 *   原样写回去。而库里 dev_plan/tech_stack/business_modules 有 19/12/13 行是引擎写的
 *   **对象信封**（{risks, phases, ...}），后端 validateJsonArray 只认数组 → 400 直接被拦。
 *   更糟的是：就算校验放过，这个往返也会用页面加载那一刻的旧值覆盖掉引擎后来写的内容。
 *   所以这里改成"只发我编辑的字段"—— 不碰我不拥有的数据。
 */
async function saveDescription() {
    descSaving.value = true;
    try {
        await updateProject(projectId, { description: form.value.description });
    }
    finally {
        descSaving.value = false;
    }
}
/** 澄清模式：保存项目名称（只提交 name，空值不落库） */
async function saveName() {
    const name = form.value.name.trim();
    if (!name) {
        toast.warning('项目名称不能为空');
        return;
    }
    nameSaving.value = true;
    try {
        await updateProject(projectId, { name });
    }
    finally {
        nameSaving.value = false;
    }
}
/** 澄清模式：确认模式下拉选中即保存（只提交 confirmMode；confirmMode 转数字在 api 层） */
async function saveConfirmMode() {
    modeSaving.value = true;
    try {
        await updateProject(projectId, { confirmMode: form.value.confirmMode });
    }
    finally {
        modeSaving.value = false;
    }
}
/** 保存功能清单（写 clarified_req —— PM 澄清的那一列，本页的产物就住这里）
 *  ⚠️ 9/18 改：原来写 businessModules，那是**架构师的列**（Node.ts saveArchitectOutput）。
 *     写它会两头坏：① 本页读的是 clarified_req，保存完自己反而看不见刚存的东西；
 *     ② 架构师阶段一跑就把人手工加的条目覆盖掉。
 *  ⚠️ 形状走 buildClarifiedReqJson 保结构合并：页面手上只有名字，
 *     一把重建会把每条 description/priority/acceptance 静默冲掉。 */
async function saveFeatures() {
    if (!features.value.length) {
        toast.warning('还没有确认任何功能');
        return;
    }
    saving.value = true;
    try {
        const envelope = form.value.clarifiedReq ? JSON.parse(form.value.clarifiedReq) : null;
        await updateProject(projectId, { clarifiedReq: buildClarifiedReqJson(envelope, features.value) });
        // 保存成功反馈 = 跳转到 overview 看到「已确认功能」清单本身，不再弹全局提示
        router.push({ name: 'project-detail', params: { id: String(projectId) }, hash: '#overview' });
    }
    finally {
        saving.value = false;
    }
}
const messages = ref([]);
const draft = ref('');
const chatBody = ref(null);
/** 当前可答的那道题（后端行 id，答复用它）；null = 没有待答 */
const openQuestion = ref(null);
const answering = ref(false);
/** 引擎在跑吗——没跑就不会有新问题，这时得说实话 */
const engineRunning = ref(false);
/** 别的节点的题挂着几道：本页不答，但提醒一句，别让人干等 */
const otherPending = ref(0);
/** 已上屏的 questionId：每 4s 一轮，不去重会重复刷气泡 */
const shownQuestions = new Set();
let pollTimer = null;
/**
 * 项目没了（被删/换账号）—— 9/18 加。
 * 为什么必须有：这页的轮询是 4 秒一档，项目被删后每轮都吃一个
 * 「项目不存在: N」的业务错误（ProjectGuard.requireOwned 抛的），
 * 连起来就是"提示一直弹、永远不停"。**光靠 toast 去重只是变稀，正解是别再问**：
 * 一旦确认项目没了就停轮询、停对话，并在页面上把真相摆出来。
 * 判定靠文案（后端 ProjectGuard 的措辞是 '项目不存在: ' + id，稳定且只有这一处来源）。
 */
const projectGone = ref(false);
function isProjectGone(e) {
    return e instanceof Error && e.message.includes('项目不存在');
}
function stopPolling() {
    if (pollTimer)
        clearInterval(pollTimer);
    pollTimer = null;
}
/** 确认项目已不存在：停轮询 + 停值班灯，页面转为"项目没了"的说明态 */
function markProjectGone() {
    if (projectGone.value)
        return;
    projectGone.value = true;
    stopPolling();
    engineRunning.value = false;
    working.value = false;
    openQuestion.value = null;
    console.warn('[pm] 项目已不存在，停止轮询（这不是网络问题）');
}
/** 引擎在跑但还没出题 = PM 正在读需求（点亮值班牌 + 打字指示） */
const thinking = computed(() => engineRunning.value && openQuestion.value === null);
/** 按库里记录重建对话：PM 的题 + 人答过的答。刷新后对话还在 */
async function loadPmHistory() {
    try {
        const rows = (await fetchConfirmHistory(projectId)).filter((c) => c.node === 'manager');
        for (const c of rows) {
            if (shownQuestions.has(c.questionId))
                continue;
            shownQuestions.add(c.questionId);
            messages.value.push({
                role: 'assistant',
                content: c.question,
                questionId: c.questionId,
                options: parseOptions(c),
            });
            // 已答/已放行的补一条"人说的话"（自动放行要标明，别让它看着像我答的）
            if (c.status !== 'pending' && c.reply) {
                messages.value.push({
                    role: 'user',
                    content: c.status === 'auto_passed' ? `${c.reply}（超时无人应答，自动放行）` : c.reply,
                });
            }
        }
        scrollToBottom();
    }
    catch (e) {
        // 后端抖动：本轮不上屏，下一轮再试；项目没了则是终局，停轮询
        if (isProjectGone(e))
            markProjectGone();
    }
}
/** 轮询：有没有新题、引擎在不在跑，并保管"当前可答的那道" */
async function pollPm() {
    if (!projectId)
        return;
    try {
        const [pending, status] = await Promise.all([
            fetchPendingConfirms(projectId),
            // 运行状态查询失败不算终局（后端重启期间也会失败）→ 单独吞掉，
            // 但注意：拦截器在这之前已经弹过 toast 了，所以这条 .catch 只挡自己的处理
            fetchRunStatus(projectId).catch(() => null),
        ]);
        engineRunning.value = !!status?.running;
        working.value = engineRunning.value; // 值班牌那盏灯跟着引擎走，不再是个安慰灯
        const mine = pending.filter((c) => c.node === 'manager');
        otherPending.value = pending.length - mine.length;
        openQuestion.value = mine.length ? mine[mine.length - 1] : null;
        if (mine.some((c) => !shownQuestions.has(c.questionId)))
            await loadPmHistory();
        // ⚠️ 清单每轮都回读：PM 是"确认一个写一次"（manager.ts 注释），
        //    不回读的话左侧要等整段对话结束才长出来（9/18 用户实测反馈"功能没有实时添加"）
        await reloadFeatures();
    }
    catch (e) {
        if (isProjectGone(e)) {
            // 项目被删 → 停轮询。不停的话每 4 秒就是一次「项目不存在」，提示弹个没完
            markProjectGone();
            return;
        }
        /* 后端抖动：本轮不动，下一轮再试（对话是增强，不拦页面） */
    }
}
/** 答复当前这道题 → 引擎取到答复就续跑 */
async function sendPm() {
    const q = openQuestion.value;
    const text = draft.value.trim();
    if (!q || !text || answering.value)
        return;
    answering.value = true;
    try {
        await answerConfirm(q.id, text);
        messages.value.push({ role: 'user', content: text });
        draft.value = '';
        openQuestion.value = null;
        scrollToBottom();
        await pollPm();
        // 定稿后引擎会写 clarified_req → 左侧「已确认功能」会变，回读一次
        await reloadFeatures();
    }
    catch (e) {
        if (isProjectGone(e))
            markProjectGone();
    }
    finally {
        answering.value = false;
    }
}
function scrollToBottom() {
    nextTick(() => {
        if (chatBody.value) {
            chatBody.value.scrollTop = chatBody.value.scrollHeight;
        }
    });
}
/** 起引擎：澄清阶段跑起来 PM 才会提问 */
const starting = ref(false);
async function startClarify() {
    if (starting.value || engineRunning.value)
        return;
    starting.value = true;
    try {
        await startProjectRun(projectId);
        toast.success('已开工，项目经理读完需求就会在这里提问');
        await pollPm();
    }
    catch (e) {
        // 项目被删了：开工请求会被 ProjectGuard 拒（"项目不存在"）→ 页面转说明态。
        // 原先这里没有 catch：点了开工只有右上角一个一闪而过的提示，
        // 页面上什么都不变 —— 用户看到的就是"我执行了但没有任何产出"。
        if (isProjectGone(e))
            markProjectGone();
    }
    finally {
        starting.value = false;
    }
}
// ===== 确认模式 =====
const modes = [
    { value: 'green', label: '全绿灯模式', desc: 'AI 自动推进，只在交付时展示结果' },
    { value: 'mixed', label: '混合模式', desc: '在需求/技术栈/计划/团队 4 个节点确认' },
    { value: 'manual', label: '手动模式', desc: '每个阶段完成后由你确认通过' },
];
/** 返回项目概览（本页只有澄清模式，不需要"回列表"分支） */
function goOverview() {
    router.push({ name: 'project-detail', params: { id: String(projectId) }, hash: '#overview' });
}
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['pm-status']} */ ;
/** @type {__VLS_StyleScopedClasses['duty']} */ ;
/** @type {__VLS_StyleScopedClasses['duty']} */ ;
/** @type {__VLS_StyleScopedClasses['row']} */ ;
/** @type {__VLS_StyleScopedClasses['dico']} */ ;
/** @type {__VLS_StyleScopedClasses['feat-x']} */ ;
/** @type {__VLS_StyleScopedClasses['feat-add']} */ ;
/** @type {__VLS_StyleScopedClasses['hint']} */ ;
/** @type {__VLS_StyleScopedClasses['chat-gone']} */ ;
/** @type {__VLS_StyleScopedClasses['chat-empty']} */ ;
/** @type {__VLS_StyleScopedClasses['msg']} */ ;
/** @type {__VLS_StyleScopedClasses['msg']} */ ;
/** @type {__VLS_StyleScopedClasses['user']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-bubble']} */ ;
/** @type {__VLS_StyleScopedClasses['tdot']} */ ;
/** @type {__VLS_StyleScopedClasses['tdot']} */ ;
/** @type {__VLS_StyleScopedClasses['desk']} */ ;
/** @type {__VLS_StyleScopedClasses['chat']} */ ;
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
                return (__VLS_ctx.goOverview());
                // @ts-ignore
                [goOverview,];
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
    (__VLS_ctx.form.name || '未命名项目');
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "sheet-no" },
    });
    /** @type {__VLS_StyleScopedClasses['sheet-no']} */ ;
    (`PRJ-${String(__VLS_ctx.projectId).padStart(4, '0')}-B`);
    // @ts-ignore
    [form, projectId,];
}
{
    const { right: __VLS_7 } = __VLS_3.slots;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                return (__VLS_ctx.saveFeatures());
                // @ts-ignore
                [saveFeatures,];
            } },
        ...{ class: "btn btn-primary" },
        disabled: (__VLS_ctx.saving),
    });
    /** @type {__VLS_StyleScopedClasses['btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
    (__VLS_ctx.saving ? '保存中…' : '保存功能清单');
    // @ts-ignore
    [saving, saving,];
}
// @ts-ignore
[];
var __VLS_3;
__VLS_asFunctionalElement1(__VLS_intrinsics.main, __VLS_intrinsics.main)({
    ...{ class: "page desk" },
});
/** @type {__VLS_StyleScopedClasses['page']} */ ;
/** @type {__VLS_StyleScopedClasses['desk']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "desk-left" },
});
/** @type {__VLS_StyleScopedClasses['desk-left']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.section, __VLS_intrinsics.section)({
    ...{ class: "pm panel" },
});
/** @type {__VLS_StyleScopedClasses['pm']} */ ;
/** @type {__VLS_StyleScopedClasses['panel']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.header, __VLS_intrinsics.header)({
    ...{ class: "pm-head" },
});
/** @type {__VLS_StyleScopedClasses['pm-head']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.img)({
    ...{ class: "pm-avatar" },
    src: "../assets/agent-manager.png",
    alt: "AI 项目经理",
});
/** @type {__VLS_StyleScopedClasses['pm-avatar']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "pm-meta" },
});
/** @type {__VLS_StyleScopedClasses['pm-meta']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.h2, __VLS_intrinsics.h2)({
    ...{ class: "pm-name" },
});
/** @type {__VLS_StyleScopedClasses['pm-name']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "pm-badge sheet-no" },
});
/** @type {__VLS_StyleScopedClasses['pm-badge']} */ ;
/** @type {__VLS_StyleScopedClasses['sheet-no']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
    ...{ class: "pm-duty dim" },
});
/** @type {__VLS_StyleScopedClasses['pm-duty']} */ ;
/** @type {__VLS_StyleScopedClasses['dim']} */ ;
(__VLS_ctx.phaseLabel);
(__VLS_ctx.working ? '整理你的描述...' : '确认项目功能');
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "pm-status" },
});
/** @type {__VLS_StyleScopedClasses['pm-status']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "lamp" },
    ...{ class: (__VLS_ctx.working ? 'lamp-on lamp-live' : '') },
});
/** @type {__VLS_StyleScopedClasses['lamp']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.i, __VLS_intrinsics.i)({
    ...{ class: "faint" },
});
/** @type {__VLS_StyleScopedClasses['faint']} */ ;
(__VLS_ctx.working ? '工作中' : '待命');
__VLS_asFunctionalElement1(__VLS_intrinsics.ul, __VLS_intrinsics.ul)({
    ...{ class: "duty rows" },
});
/** @type {__VLS_StyleScopedClasses['duty']} */ ;
/** @type {__VLS_StyleScopedClasses['rows']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.li, __VLS_intrinsics.li)({
    ...{ class: "row" },
    ...{ class: ({ done: __VLS_ctx.featureDone }) },
});
/** @type {__VLS_StyleScopedClasses['row']} */ ;
/** @type {__VLS_StyleScopedClasses['done']} */ ;
if (__VLS_ctx.featureDone) {
    let __VLS_8;
    /** @ts-ignore @type { | typeof __VLS_components.IconCheck} */
    IconCheck;
    // @ts-ignore
    const __VLS_9 = __VLS_asFunctionalComponent1(__VLS_8, new __VLS_8({
        size: (15),
        strokeWidth: (1.75),
        ...{ class: "dico ok" },
    }));
    const __VLS_10 = __VLS_9({
        size: (15),
        strokeWidth: (1.75),
        ...{ class: "dico ok" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_9));
    /** @type {__VLS_StyleScopedClasses['dico']} */ ;
    /** @type {__VLS_StyleScopedClasses['ok']} */ ;
}
else {
    let __VLS_13;
    /** @ts-ignore @type { | typeof __VLS_components.IconCircle} */
    IconCircle;
    // @ts-ignore
    const __VLS_14 = __VLS_asFunctionalComponent1(__VLS_13, new __VLS_13({
        size: (15),
        strokeWidth: (1.75),
        ...{ class: "dico" },
    }));
    const __VLS_15 = __VLS_14({
        size: (15),
        strokeWidth: (1.75),
        ...{ class: "dico" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_14));
    /** @type {__VLS_StyleScopedClasses['dico']} */ ;
}
__VLS_asFunctionalElement1(__VLS_intrinsics.li, __VLS_intrinsics.li)({
    ...{ class: "row" },
    ...{ class: ({ done: __VLS_ctx.nameDone }) },
});
/** @type {__VLS_StyleScopedClasses['row']} */ ;
/** @type {__VLS_StyleScopedClasses['done']} */ ;
if (__VLS_ctx.nameDone) {
    let __VLS_18;
    /** @ts-ignore @type { | typeof __VLS_components.IconCheck} */
    IconCheck;
    // @ts-ignore
    const __VLS_19 = __VLS_asFunctionalComponent1(__VLS_18, new __VLS_18({
        size: (15),
        strokeWidth: (1.75),
        ...{ class: "dico ok" },
    }));
    const __VLS_20 = __VLS_19({
        size: (15),
        strokeWidth: (1.75),
        ...{ class: "dico ok" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_19));
    /** @type {__VLS_StyleScopedClasses['dico']} */ ;
    /** @type {__VLS_StyleScopedClasses['ok']} */ ;
}
else {
    let __VLS_23;
    /** @ts-ignore @type { | typeof __VLS_components.IconCircle} */
    IconCircle;
    // @ts-ignore
    const __VLS_24 = __VLS_asFunctionalComponent1(__VLS_23, new __VLS_23({
        size: (15),
        strokeWidth: (1.75),
        ...{ class: "dico" },
    }));
    const __VLS_25 = __VLS_24({
        size: (15),
        strokeWidth: (1.75),
        ...{ class: "dico" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_24));
    /** @type {__VLS_StyleScopedClasses['dico']} */ ;
}
__VLS_asFunctionalElement1(__VLS_intrinsics.li, __VLS_intrinsics.li)({
    ...{ class: "row" },
    ...{ class: ({ done: __VLS_ctx.modeDone }) },
});
/** @type {__VLS_StyleScopedClasses['row']} */ ;
/** @type {__VLS_StyleScopedClasses['done']} */ ;
if (__VLS_ctx.modeDone) {
    let __VLS_28;
    /** @ts-ignore @type { | typeof __VLS_components.IconCheck} */
    IconCheck;
    // @ts-ignore
    const __VLS_29 = __VLS_asFunctionalComponent1(__VLS_28, new __VLS_28({
        size: (15),
        strokeWidth: (1.75),
        ...{ class: "dico ok" },
    }));
    const __VLS_30 = __VLS_29({
        size: (15),
        strokeWidth: (1.75),
        ...{ class: "dico ok" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_29));
    /** @type {__VLS_StyleScopedClasses['dico']} */ ;
    /** @type {__VLS_StyleScopedClasses['ok']} */ ;
}
else {
    let __VLS_33;
    /** @ts-ignore @type { | typeof __VLS_components.IconCircle} */
    IconCircle;
    // @ts-ignore
    const __VLS_34 = __VLS_asFunctionalComponent1(__VLS_33, new __VLS_33({
        size: (15),
        strokeWidth: (1.75),
        ...{ class: "dico" },
    }));
    const __VLS_35 = __VLS_34({
        size: (15),
        strokeWidth: (1.75),
        ...{ class: "dico" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_34));
    /** @type {__VLS_StyleScopedClasses['dico']} */ ;
}
__VLS_asFunctionalElement1(__VLS_intrinsics.section, __VLS_intrinsics.section)({
    ...{ class: "panel block" },
});
/** @type {__VLS_StyleScopedClasses['panel']} */ ;
/** @type {__VLS_StyleScopedClasses['block']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.header, __VLS_intrinsics.header)({
    ...{ class: "panel-head" },
});
/** @type {__VLS_StyleScopedClasses['panel-head']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.h3, __VLS_intrinsics.h3)({
    ...{ class: "panel-title" },
});
/** @type {__VLS_StyleScopedClasses['panel-title']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (...[$event]) => {
            return (__VLS_ctx.saveName());
            // @ts-ignore
            [phaseLabel, working, working, working, featureDone, featureDone, nameDone, nameDone, modeDone, modeDone, saveName,];
        } },
    ...{ class: "btn btn-sm" },
    disabled: (__VLS_ctx.nameSaving),
});
/** @type {__VLS_StyleScopedClasses['btn']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
(__VLS_ctx.nameSaving ? '保存中...' : '保存名称');
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "block-body" },
});
/** @type {__VLS_StyleScopedClasses['block-body']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.input)({
    value: (__VLS_ctx.form.name),
    ...{ class: "input" },
    type: "text",
    placeholder: "如：CRM 客户管理系统",
});
/** @type {__VLS_StyleScopedClasses['input']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.section, __VLS_intrinsics.section)({
    ...{ class: "panel block" },
});
/** @type {__VLS_StyleScopedClasses['panel']} */ ;
/** @type {__VLS_StyleScopedClasses['block']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.header, __VLS_intrinsics.header)({
    ...{ class: "panel-head" },
});
/** @type {__VLS_StyleScopedClasses['panel-head']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.h3, __VLS_intrinsics.h3)({
    ...{ class: "panel-title" },
});
/** @type {__VLS_StyleScopedClasses['panel-title']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "hint faint" },
});
/** @type {__VLS_StyleScopedClasses['hint']} */ ;
/** @type {__VLS_StyleScopedClasses['faint']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (...[$event]) => {
            return (__VLS_ctx.saveDescription());
            // @ts-ignore
            [form, nameSaving, nameSaving, saveDescription,];
        } },
    ...{ class: "btn btn-sm" },
    disabled: (__VLS_ctx.descSaving),
});
/** @type {__VLS_StyleScopedClasses['btn']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
(__VLS_ctx.descSaving ? '保存中...' : '保存描述');
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "block-body" },
});
/** @type {__VLS_StyleScopedClasses['block-body']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.textarea, __VLS_intrinsics.textarea)({
    value: (__VLS_ctx.form.description),
    ...{ class: "textarea" },
    rows: "5",
    placeholder: "描述这个项目要做什么样子的项目，如：为企业做一个 CRM 客户管理系统，管理客户档案、跟进销售过程、生成统计报表",
});
/** @type {__VLS_StyleScopedClasses['textarea']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.section, __VLS_intrinsics.section)({
    ...{ class: "panel block" },
});
/** @type {__VLS_StyleScopedClasses['panel']} */ ;
/** @type {__VLS_StyleScopedClasses['block']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.header, __VLS_intrinsics.header)({
    ...{ class: "panel-head" },
});
/** @type {__VLS_StyleScopedClasses['panel-head']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.h3, __VLS_intrinsics.h3)({
    ...{ class: "panel-title" },
});
/** @type {__VLS_StyleScopedClasses['panel-title']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "hint mono faint" },
});
/** @type {__VLS_StyleScopedClasses['hint']} */ ;
/** @type {__VLS_StyleScopedClasses['mono']} */ ;
/** @type {__VLS_StyleScopedClasses['faint']} */ ;
(__VLS_ctx.features.length);
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "block-body" },
});
/** @type {__VLS_StyleScopedClasses['block-body']} */ ;
if (__VLS_ctx.features.length) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.ul, __VLS_intrinsics.ul)({
        ...{ class: "rows feat-list" },
    });
    /** @type {__VLS_StyleScopedClasses['rows']} */ ;
    /** @type {__VLS_StyleScopedClasses['feat-list']} */ ;
    for (const [f, i] of __VLS_vFor((__VLS_ctx.features))) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.li, __VLS_intrinsics.li)({
            key: (i),
            ...{ class: "row feat" },
        });
        /** @type {__VLS_StyleScopedClasses['row']} */ ;
        /** @type {__VLS_StyleScopedClasses['feat']} */ ;
        let __VLS_38;
        /** @ts-ignore @type { | typeof __VLS_components.IconCheck} */
        IconCheck;
        // @ts-ignore
        const __VLS_39 = __VLS_asFunctionalComponent1(__VLS_38, new __VLS_38({
            size: (15),
            strokeWidth: (1.75),
            ...{ class: "dico ok" },
        }));
        const __VLS_40 = __VLS_39({
            size: (15),
            strokeWidth: (1.75),
            ...{ class: "dico ok" },
        }, ...__VLS_functionalComponentArgsRest(__VLS_39));
        /** @type {__VLS_StyleScopedClasses['dico']} */ ;
        /** @type {__VLS_StyleScopedClasses['ok']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "feat-text" },
        });
        /** @type {__VLS_StyleScopedClasses['feat-text']} */ ;
        (f);
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.features.length))
                        throw 0;
                    return (__VLS_ctx.features.splice(i, 1));
                    // @ts-ignore
                    [form, descSaving, descSaving, features, features, features, features,];
                } },
            ...{ class: "feat-x" },
            'aria-label': "移除该功能",
        });
        /** @type {__VLS_StyleScopedClasses['feat-x']} */ ;
        let __VLS_43;
        /** @ts-ignore @type { | typeof __VLS_components.IconX} */
        IconX;
        // @ts-ignore
        const __VLS_44 = __VLS_asFunctionalComponent1(__VLS_43, new __VLS_43({
            size: (13),
            strokeWidth: (1.75),
        }));
        const __VLS_45 = __VLS_44({
            size: (13),
            strokeWidth: (1.75),
        }, ...__VLS_functionalComponentArgsRest(__VLS_44));
        // @ts-ignore
        [];
    }
}
else {
    __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
        ...{ class: "faint empty-tip" },
    });
    /** @type {__VLS_StyleScopedClasses['faint']} */ ;
    /** @type {__VLS_StyleScopedClasses['empty-tip']} */ ;
}
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "feat-add" },
});
/** @type {__VLS_StyleScopedClasses['feat-add']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.input)({
    ...{ onKeyup: (__VLS_ctx.addFeature) },
    value: (__VLS_ctx.featureDraft),
    ...{ class: "input" },
    type: "text",
    placeholder: "输入功能点，如：报表导出 Excel",
});
/** @type {__VLS_StyleScopedClasses['input']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (__VLS_ctx.addFeature) },
    ...{ class: "btn" },
});
/** @type {__VLS_StyleScopedClasses['btn']} */ ;
let __VLS_48;
/** @ts-ignore @type { | typeof __VLS_components.IconPlus} */
IconPlus;
// @ts-ignore
const __VLS_49 = __VLS_asFunctionalComponent1(__VLS_48, new __VLS_48({
    size: (14),
    strokeWidth: (1.75),
}));
const __VLS_50 = __VLS_49({
    size: (14),
    strokeWidth: (1.75),
}, ...__VLS_functionalComponentArgsRest(__VLS_49));
__VLS_asFunctionalElement1(__VLS_intrinsics.section, __VLS_intrinsics.section)({
    ...{ class: "panel block" },
});
/** @type {__VLS_StyleScopedClasses['panel']} */ ;
/** @type {__VLS_StyleScopedClasses['block']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.header, __VLS_intrinsics.header)({
    ...{ class: "panel-head" },
});
/** @type {__VLS_StyleScopedClasses['panel-head']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.h3, __VLS_intrinsics.h3)({
    ...{ class: "panel-title" },
});
/** @type {__VLS_StyleScopedClasses['panel-title']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "block-body" },
});
/** @type {__VLS_StyleScopedClasses['block-body']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "field" },
});
/** @type {__VLS_StyleScopedClasses['field']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.select, __VLS_intrinsics.select)({
    ...{ onChange: (...[$event]) => {
            return (__VLS_ctx.saveConfirmMode());
            // @ts-ignore
            [addFeature, addFeature, featureDraft, saveConfirmMode,];
        } },
    value: (__VLS_ctx.form.confirmMode),
    ...{ class: "select" },
    disabled: (__VLS_ctx.modeSaving),
});
/** @type {__VLS_StyleScopedClasses['select']} */ ;
for (const [m] of __VLS_vFor((__VLS_ctx.modes))) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.option, __VLS_intrinsics.option)({
        key: (m.value),
        value: (m.value),
    });
    (m.label);
    // @ts-ignore
    [form, modeSaving, modes,];
}
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "field-hint" },
});
/** @type {__VLS_StyleScopedClasses['field-hint']} */ ;
(__VLS_ctx.MODE_LABELS[__VLS_ctx.form.confirmMode]);
__VLS_asFunctionalElement1(__VLS_intrinsics.aside, __VLS_intrinsics.aside)({
    ...{ class: "desk-right panel chat" },
});
/** @type {__VLS_StyleScopedClasses['desk-right']} */ ;
/** @type {__VLS_StyleScopedClasses['panel']} */ ;
/** @type {__VLS_StyleScopedClasses['chat']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.header, __VLS_intrinsics.header)({
    ...{ class: "panel-head chat-head" },
});
/** @type {__VLS_StyleScopedClasses['panel-head']} */ ;
/** @type {__VLS_StyleScopedClasses['chat-head']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "panel-title" },
});
/** @type {__VLS_StyleScopedClasses['panel-title']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "hint faint" },
});
/** @type {__VLS_StyleScopedClasses['hint']} */ ;
/** @type {__VLS_StyleScopedClasses['faint']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ref: "chatBody",
    ...{ class: "chat-body" },
});
/** @type {__VLS_StyleScopedClasses['chat-body']} */ ;
if (__VLS_ctx.projectGone) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "chat-gone" },
    });
    /** @type {__VLS_StyleScopedClasses['chat-gone']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({});
    __VLS_asFunctionalElement1(__VLS_intrinsics.strong, __VLS_intrinsics.strong)({});
    __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
        ...{ class: "faint" },
    });
    /** @type {__VLS_StyleScopedClasses['faint']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.projectGone))
                    throw 0;
                return (__VLS_ctx.router.push('/projects'));
                // @ts-ignore
                [form, MODE_LABELS, projectGone, router,];
            } },
        ...{ class: "btn btn-sm btn-primary" },
    });
    /** @type {__VLS_StyleScopedClasses['btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
}
else if (!__VLS_ctx.messages.length && !__VLS_ctx.thinking) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "chat-empty faint" },
    });
    /** @type {__VLS_StyleScopedClasses['chat-empty']} */ ;
    /** @type {__VLS_StyleScopedClasses['faint']} */ ;
    if (__VLS_ctx.form.confirmMode === 'green') {
        __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.strong, __VLS_intrinsics.strong)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.strong, __VLS_intrinsics.strong)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.strong, __VLS_intrinsics.strong)({});
    }
    else if (__VLS_ctx.engineRunning) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({});
    }
    else {
        __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({});
    }
}
for (const [m, i] of __VLS_vFor((__VLS_ctx.messages))) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        key: (i),
        ...{ class: "msg" },
        ...{ class: (m.role) },
    });
    /** @type {__VLS_StyleScopedClasses['msg']} */ ;
    if (m.role === 'assistant') {
        __VLS_asFunctionalElement1(__VLS_intrinsics.img)({
            ...{ class: "msg-avatar" },
            src: "../assets/agent-manager.png",
            alt: "Hina",
        });
        /** @type {__VLS_StyleScopedClasses['msg-avatar']} */ ;
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "msg-bubble" },
    });
    /** @type {__VLS_StyleScopedClasses['msg-bubble']} */ ;
    (m.content);
    // @ts-ignore
    [form, messages, messages, thinking, engineRunning,];
}
if (__VLS_ctx.openQuestion && __VLS_ctx.parseOptions(__VLS_ctx.openQuestion).length) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "chat-opts" },
    });
    /** @type {__VLS_StyleScopedClasses['chat-opts']} */ ;
    for (const [opt] of __VLS_vFor((__VLS_ctx.parseOptions(__VLS_ctx.openQuestion)))) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.openQuestion && __VLS_ctx.parseOptions(__VLS_ctx.openQuestion).length))
                        throw 0;
                    __VLS_ctx.draft = opt;
                    __VLS_ctx.sendPm();
                    // @ts-ignore
                    [openQuestion, openQuestion, openQuestion, parseOptions, parseOptions, draft, sendPm,];
                } },
            key: (opt),
            ...{ class: "btn btn-sm" },
            disabled: (__VLS_ctx.answering),
        });
        /** @type {__VLS_StyleScopedClasses['btn']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
        (opt);
        // @ts-ignore
        [answering,];
    }
}
if (__VLS_ctx.thinking) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "msg assistant" },
    });
    /** @type {__VLS_StyleScopedClasses['msg']} */ ;
    /** @type {__VLS_StyleScopedClasses['assistant']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.img)({
        ...{ class: "msg-avatar" },
        src: "../assets/agent-manager.png",
        alt: "Hina",
    });
    /** @type {__VLS_StyleScopedClasses['msg-avatar']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "msg-bubble typing" },
    });
    /** @type {__VLS_StyleScopedClasses['msg-bubble']} */ ;
    /** @type {__VLS_StyleScopedClasses['typing']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "tdot" },
    });
    /** @type {__VLS_StyleScopedClasses['tdot']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "tdot" },
    });
    /** @type {__VLS_StyleScopedClasses['tdot']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "tdot" },
    });
    /** @type {__VLS_StyleScopedClasses['tdot']} */ ;
}
if (__VLS_ctx.projectGone) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "chat-foot" },
    });
    /** @type {__VLS_StyleScopedClasses['chat-foot']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "hint faint" },
    });
    /** @type {__VLS_StyleScopedClasses['hint']} */ ;
    /** @type {__VLS_StyleScopedClasses['faint']} */ ;
}
else if (!__VLS_ctx.engineRunning) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "chat-foot" },
    });
    /** @type {__VLS_StyleScopedClasses['chat-foot']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (__VLS_ctx.startClarify) },
        ...{ class: "btn btn-primary btn-sm" },
        disabled: (__VLS_ctx.starting),
    });
    /** @type {__VLS_StyleScopedClasses['btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
    (__VLS_ctx.starting ? '开工中…' : '开工，让项目经理提问');
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "hint faint" },
    });
    /** @type {__VLS_StyleScopedClasses['hint']} */ ;
    /** @type {__VLS_StyleScopedClasses['faint']} */ ;
}
else if (!__VLS_ctx.openQuestion) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "chat-foot" },
    });
    /** @type {__VLS_StyleScopedClasses['chat-foot']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "hint faint" },
    });
    /** @type {__VLS_StyleScopedClasses['hint']} */ ;
    /** @type {__VLS_StyleScopedClasses['faint']} */ ;
    if (__VLS_ctx.otherPending) {
        (__VLS_ctx.otherPending);
    }
}
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "chat-input" },
});
/** @type {__VLS_StyleScopedClasses['chat-input']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.textarea, __VLS_intrinsics.textarea)({
    ...{ onKeydown: (__VLS_ctx.sendPm) },
    value: (__VLS_ctx.draft),
    ...{ class: "textarea ci-area" },
    rows: "2",
    placeholder: (__VLS_ctx.openQuestion ? '回答项目经理的问题…（Enter 发送）' : '现在没有待答问题，先把上面那道题答完'),
    disabled: (!__VLS_ctx.openQuestion || __VLS_ctx.answering),
});
/** @type {__VLS_StyleScopedClasses['textarea']} */ ;
/** @type {__VLS_StyleScopedClasses['ci-area']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (__VLS_ctx.sendPm) },
    ...{ class: "btn btn-primary ci-send" },
    disabled: (!__VLS_ctx.openQuestion || !__VLS_ctx.draft.trim() || __VLS_ctx.answering),
    'aria-label': "发送",
});
/** @type {__VLS_StyleScopedClasses['btn']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
/** @type {__VLS_StyleScopedClasses['ci-send']} */ ;
let __VLS_53;
/** @ts-ignore @type { | typeof __VLS_components.IconSend} */
IconSend;
// @ts-ignore
const __VLS_54 = __VLS_asFunctionalComponent1(__VLS_53, new __VLS_53({
    size: (16),
    strokeWidth: (1.75),
}));
const __VLS_55 = __VLS_54({
    size: (16),
    strokeWidth: (1.75),
}, ...__VLS_functionalComponentArgsRest(__VLS_54));
// @ts-ignore
[projectGone, thinking, engineRunning, openQuestion, openQuestion, openQuestion, openQuestion, draft, draft, sendPm, sendPm, answering, answering, startClarify, starting, starting, otherPending, otherPending,];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
