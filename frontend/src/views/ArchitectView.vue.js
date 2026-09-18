import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { IconCheck, IconCircle, IconPencil, IconPlus, IconSend, IconX, } from '@tabler/icons-vue';
import AppModal from '../components/ui/AppModal.vue';
import SheetTree from '../components/SheetTree.vue';
import TopBar from '../components/ui/TopBar.vue';
import { answerConfirm, fetchConfirmHistory, fetchPendingConfirms, parseOptions } from '../api/confirm';
import { fetchProjectById, updateProject } from '../api/project';
import { ENVELOPE_KEYS, buildDevPlanJson, buildTechStackJson, parseArchPlan, parseEnvelopeArray, toStringList } from '../utils/json';
import { cleanTree, restoreTree } from '../types/tree';
const router = useRouter();
const route = useRoute();
const projectName = ref('');
/** 后端 JSON 字符串字段解析（解析失败返回空数组） */
function parseArr(raw) {
    if (!raw)
        return [];
    try {
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    }
    catch {
        return [];
    }
}
/** 解析 devPlan：纯数组与引擎 PM 的 {phases:[…]} 对象两种都认
 *  （口径与 ProjectDetailView 的 plan computed 样板完全一致，两处不许漂移） */
function parsePlanArr(raw) {
    if (!raw)
        return [];
    try {
        const v = JSON.parse(raw);
        const arr = Array.isArray(v) ? v : v?.phases;
        return Array.isArray(arr) ? arr : [];
    }
    catch {
        return [];
    }
}
/**
 * 库里原始形状的"底稿"（9/17 加）。
 *
 * 为什么必须留着：这一页只编辑阶段名/任务清单，但库里这些列是**引擎写的富信封**：
 *   dev_plan  = {risks, phases:[{goal,name,risk,phase,uiStyle,features,dependencies,relative_effort}],
 *                project, features, mvp_scope, uiProfile}
 *   tech_stack= {why, tables, moduleTech, techniques:{database:{…}, middleware:[{name,purpose}]}}
 * 而页面模型只有 {name, progress, tasks}。原来「确认方案」直接
 * `JSON.stringify(phases.value)` 整体替换 → 一次性丢掉信封的全部其他键，
 * 连每个阶段的 `phase` 数字都丢了 —— 而 `projectRunner.usablePhases()` 硬要求
 * `phase` 是整数、`name` 非空，丢了它引擎读回 dev_plan 会判定"计划不可用"，
 * 退回去重跑 PM 对话（引擎侧真故障，不只是少显示几个字段）。
 * 所以保存时必须"在底稿上改"，而不是"用页面模型重建"。
 */
const devPlanEnvelope = ref(null);
const devPlanOriginalPhases = ref([]);
/** 原计划是不是引擎形状（阶段带数字 phase）——决定新增阶段要不要补 phase */
const devPlanEngineShape = ref(false);
const techStackEnvelope = ref(null);
/* ===== 架构师方案（引擎 tech_stack 信封的结构化产物，只读） =====
   为什么单开一块（9/18）：引擎写的这几块内容以前在页面上**完全看不见** ——
     why          技术理由（整段话）
     moduleTech   [{module, backend, frontend}]  分模块技术选型
     tables       [{name, fields:[{name,type,remark,required}], purpose}]
     techniques   {database:{type,why}, middleware:[{name,purpose}]}
   它们在"技术选型"标签云里只会被 toDisplayList 兜底成 JSON.stringify 的一坨
   （认不出 name/title/label/summary 就整体序列化）。
   现网 10 个项目全是这个信封，等于架构师产出的方案一直在页面上是一堆乱码。
   解析逻辑是 utils/json.ts 的纯函数 parseArchPlan（那边能用真实库数据跑测试，
   这里只负责画）。只读展示：要改技术栈请在标签云里加减，
   保存时 buildTechStackJson 会在底稿上保结构合并。 */
const archPlan = computed(() => parseArchPlan(techStackEnvelope.value));
const hasArchPlan = computed(() => archPlan.value.has);
/** 把读回的条目归一成页面模型：PM 的 planItem 只有 features 没有 tasks，
 *  tasks 兜成 [] 同时防渲染 .length 崩（审计 F11 同型点） */
function normalizePhases(rows) {
    return rows
        .filter((r) => r != null && typeof r === 'object')
        .map((r) => ({
        name: r.name ?? '未命名阶段',
        progress: typeof r.progress === 'number' ? r.progress : 0,
        tasks: Array.isArray(r.tasks) ? r.tasks : Array.isArray(r.features) ? r.features : [],
    }));
}
/** 阶段对象里"任务清单"所在的键：引擎写 features，网页写 tasks —— 谁原来有就写回谁 */
const projectId = computed(() => Number(route.params.id));
onMounted(async () => {
    const id = projectId.value;
    if (!id)
        return;
    try {
        const p = await fetchProjectById(id);
        projectName.value = p.name;
        // 回显已保存的方案（确认方案提交过才有数据）
        // ---- techStack：双形状（网页裸数组 / 引擎信封），并留底稿供保存时合并 ----
        let rawStack = null;
        try {
            rawStack = p.techStack ? JSON.parse(p.techStack) : null;
        }
        catch {
            rawStack = null; // 坏 JSON：当没有
        }
        techStackEnvelope.value =
            rawStack && typeof rawStack === 'object' && !Array.isArray(rawStack)
                ? rawStack
                : null;
        // ⚠️ 9/18：标签云只吃**网页自己写的扁平清单**（technologies）。
        //    原来用 ENVELOPE_KEYS.techStack（一路退到 moduleTech/tables），
        //    那两个是对象数组，toDisplayList 认不出就 JSON.stringify —— 页面上把
        //    {"module":"用户登录与退出","backend":"…","frontend":"…"} 当标签印出来。
        //    引擎的结构化方案改由下面「架构师方案」面板渲染。
        techStack.value = toStringList(parseEnvelopeArray(p.techStack, ENVELOPE_KEYS.techStackPageList));
        // ---- devPlan：同上，而且信封里的 phases 要留着做合并底稿 ----
        let rawPlan = null;
        try {
            rawPlan = p.devPlan ? JSON.parse(p.devPlan) : null;
        }
        catch {
            rawPlan = null;
        }
        if (rawPlan && typeof rawPlan === 'object' && !Array.isArray(rawPlan)) {
            const env = rawPlan;
            devPlanEnvelope.value = env;
            devPlanOriginalPhases.value = Array.isArray(env.phases)
                ? env.phases
                : [];
        }
        else {
            devPlanEnvelope.value = null;
            devPlanOriginalPhases.value = Array.isArray(rawPlan) ? rawPlan : [];
        }
        devPlanEngineShape.value = devPlanOriginalPhases.value.some((x) => typeof x?.phase === 'number');
        // 旧 parseArr 把对象当 → [] → 页面显示"暂无开发计划"，一点「确认方案」把 "[]" PUT 回去清空引擎计划。
        phases.value = normalizePhases(devPlanOriginalPhases.value.length ? devPlanOriginalPhases.value : parsePlanArr(p.devPlan));
        dirTree.value = restoreTree(parseArr(p.dirTree));
    }
    catch (e) {
        projectName.value = '项目 #' + route.params.id;
        // 项目已经没了（在别处删掉）→ 不进对话轮询，否则每 4 秒撞一次「项目不存在」
        if (isProjectGone(e)) {
            markProjectGone();
            return;
        }
    }
    // 对话：先补历史（刷新后对话还在），再起 4s 轮询等新题（与需求对话页同频）
    await loadArchHistory();
    await pollArch();
    if (!projectGone.value)
        pollTimer = setInterval(pollArch, 4000);
});
onUnmounted(stopPolling);
/** 分类元信息 + 常见技术库 */
const CATEGORIES = [
    { key: 'backend', label: '后端框架' },
    { key: 'frontend', label: '前端框架' },
    { key: 'rdb', label: '关系型数据库' },
    { key: 'nosql', label: 'NoSQL' },
    { key: 'cache', label: '缓存' },
    { key: 'mq', label: '消息队列' },
    { key: 'devops', label: '部署运维' },
    { key: 'other', label: '其他' },
];
const TECH_LIB = {
    backend: ['Spring Boot', 'MyBatis-Plus', 'Node.js', 'NestJS', 'FastAPI', 'Flask', 'Django', 'Go Gin', '.NET Core'],
    frontend: ['Vue 3', 'React', 'Element Plus', 'Ant Design', 'Next.js', 'Nuxt.js', 'Angular', 'Tailwind CSS'],
    rdb: ['MySQL', 'PostgreSQL', 'SQLite', 'Oracle', 'SQL Server'],
    nosql: ['MongoDB', 'Elasticsearch', 'Cassandra', 'DynamoDB', 'InfluxDB'],
    cache: ['Redis', 'Memcached'],
    mq: ['RabbitMQ', 'Kafka', 'RocketMQ', 'ActiveMQ'],
    devops: ['Docker', 'Kubernetes', 'Nginx', 'Jenkins', 'GitHub Actions', 'Nacos'],
    other: ['GraphQL', 'WebSocket', 'JWT', 'OAuth2', 'Swagger', 'Lombok'],
};
// 技术选型（初始为空，由用户添加 / 后续真实 AI 生成）
const techStack = ref([]);
const stackConfirmed = computed(() => techStack.value.length > 0);
/** 删除技术 */
function removeStack(name) {
    techStack.value = techStack.value.filter((t) => t !== name);
}
/* ===== 选型弹窗（两段式：勾选待选 → 确定才入册） ===== */
const showStackPicker = ref(false);
const activeCat = ref('backend');
const categories = CATEGORIES;
const filteredTech = computed(() => TECH_LIB[activeCat.value]);
const customStack = ref('');
/** 弹窗内待选技术（点击确定后才真正加入技术选型） */
const pickingStack = ref([]);
/** 打开弹窗：清空上次的待选 */
function openStackPicker() {
    pickingStack.value = [];
    showStackPicker.value = true;
}
/** 是否已勾选 */
function isPicked(name) {
    return pickingStack.value.includes(name);
}
/** 点击切换勾选状态（再点一次取消） */
function togglePick(name) {
    const i = pickingStack.value.indexOf(name);
    if (i >= 0)
        pickingStack.value.splice(i, 1);
    else
        pickingStack.value.push(name);
}
/** 自定义技术：加入待选，不直接提交 */
function addCustomStack() {
    const name = customStack.value.trim();
    if (!name)
        return;
    if (!techStack.value.includes(name) && !isPicked(name)) {
        pickingStack.value.push(name);
    }
    customStack.value = '';
}
/** 确定：把所有待选技术加入技术选型，关闭弹窗 */
function confirmStackPicker() {
    const added = pickingStack.value.filter((t) => !techStack.value.includes(t));
    for (const t of added)
        techStack.value.push(t);
    if (added.length) {
        archMessages.value.push({
            role: 'assistant',
            content: `已添加技术：${added.join('、')}。我会评估它们与现有架构的兼容性。`,
        });
        scrollToBottom();
    }
    pickingStack.value = [];
    showStackPicker.value = false;
}
/* ===== 开发阶段（初始为空，用户手动编辑 / 后续真实 AI 生成） ===== */
const phases = ref([]);
const planShown = computed(() => phases.value.length > 0);
// ===== 阶段编辑（内存态，点"确认方案"时随 devPlan 一起提交） =====
/** 正在重命名的阶段下标（null = 无） */
const editingPhaseName = ref(null);
const phaseNameDraft = ref('');
/** 正在添加任务的阶段下标（null = 无） */
const addingTaskIn = ref(null);
const taskDraft = ref('');
/** 新增阶段 */
function addPhase() {
    phases.value.push({ name: '新阶段', progress: 0, tasks: [] });
}
/** 删除阶段 */
function removePhase(i) {
    phases.value.splice(i, 1);
}
/** 开始重命名：把当前名字填入输入框 */
function startEditPhaseName(i) {
    editingPhaseName.value = i;
    phaseNameDraft.value = phases.value[i].name;
}
/** 保存重命名（空值则回退原名） */
function savePhaseName(i) {
    if (editingPhaseName.value !== i)
        return;
    const name = phaseNameDraft.value.trim();
    if (name)
        phases.value[i].name = name;
    editingPhaseName.value = null;
}
/** 开始添加任务 */
function startAddTask(i) {
    addingTaskIn.value = i;
    taskDraft.value = '';
}
/** 添加任务 */
function addTask(i) {
    const t = taskDraft.value.trim();
    if (t)
        phases.value[i].tasks.push(t);
    addingTaskIn.value = null;
    taskDraft.value = '';
}
/** 删除任务 */
function removeTask(i, t) {
    phases.value[i].tasks = phases.value[i].tasks.filter((x) => x !== t);
}
/* ===== 项目目录（编辑逻辑收进 SheetTree，这里只持数据） ===== */
const dirTree = ref([]);
const treeShown = computed(() => dirTree.value.length > 0);
const treeRef = ref(null);
// 接口文档功能尚未实现，保持未完成状态
const apiShown = ref(false);
const avatarArch = new URL('../assets/agent-architect.png', import.meta.url).href;
/** 架构师值班牌（左上角 + 职责清单；紫色换成图章口径） */
const currentRole = {
    name: 'AI 架构师',
    badge: 'Architect',
    avatar: avatarArch,
    duty: '技术选型 · 规划架构方案',
    tasks: () => [
        { label: '确定技术选型', done: stackConfirmed.value },
        { label: '规划开发阶段', done: planShown.value },
        { label: '设计项目目录', done: treeShown.value },
        { label: '规划接口文档', done: apiShown.value },
    ],
};
/* ============================================================
   与架构师对谈 —— 真接引擎确认门（9/18）
   ------------------------------------------------------------
   架构师在出方案前会追问关键决策（architect.ts 的 consult 节点，LLM 生成），
   问题经 HttpQuestioner 落 sys_confirm（node='architect'），本页轮询取来展示、
   把人的回答 POST 回去 → 引擎取到答复继续同一张图。
   跟需求对话页是同一条链，只是 node 过滤不同：
     manager   = PM 澄清（需求对话页）
     architect = 架构师澄清（本页）
   为什么以前这里是假的：archReply() 是几个正则回预置文案（"为什么用 MySQL？"
   会得到一段固定话术）。现在显示的每一句都是引擎里 LLM 真正问出来的。
   ⚠️ 架构师澄清最多 3 问（引擎侧提示词约束 + runWithInteraction 轮次上限），
      所以这框不是无限闲聊，是"他在开工前把关键决策问清楚"。
   ============================================================ */
const archMessages = ref([]);
const draft = ref('');
const thinking = ref(false);
const working = ref(false);
const chatBody = ref(null);
/** 当前待答的那道架构师提问；null = 没有待答 */
const archPending = ref(null);
const answering = ref(false);
/** 已上屏的 questionId：4s 一轮，不去重会重复刷气泡 */
const shownQuestions = new Set();
/** 项目被删（在别处删掉）→ 停轮询，别再每 4 秒撞一次「项目不存在」 */
const projectGone = ref(false);
let pollTimer = null;
function isProjectGone(e) {
    return e instanceof Error && e.message.includes('项目不存在');
}
function stopPolling() {
    if (pollTimer)
        clearInterval(pollTimer);
    pollTimer = null;
}
function markProjectGone() {
    if (projectGone.value)
        return;
    projectGone.value = true;
    stopPolling();
    thinking.value = false;
    working.value = false;
    archPending.value = null;
    console.warn('[architect] 项目已不存在，停止轮询（这不是网络问题）');
}
/** 按库里记录重建对话：架构师问过的 + 人答过的（刷新后还在） */
async function loadArchHistory() {
    try {
        const rows = (await fetchConfirmHistory(projectId.value)).filter((c) => c.node === 'architect');
        for (const c of rows) {
            if (shownQuestions.has(c.questionId))
                continue;
            shownQuestions.add(c.questionId);
            archMessages.value.push({ role: 'assistant', content: c.question });
            if (c.status !== 'pending' && c.reply) {
                archMessages.value.push({
                    role: 'user',
                    content: c.status === 'auto_passed' ? `${c.reply}（超时无人应答，自动放行）` : c.reply,
                });
            }
        }
        scrollToBottom();
    }
    catch (e) {
        if (isProjectGone(e))
            markProjectGone();
    }
}
/** 轮询：有没有新的架构师提问 */
async function pollArch() {
    const id = projectId.value;
    if (!id || projectGone.value)
        return;
    try {
        const pending = (await fetchPendingConfirms(id)).filter((c) => c.node === 'architect');
        archPending.value = pending.length ? pending[pending.length - 1] : null;
        if (pending.some((c) => !shownQuestions.has(c.questionId)))
            await loadArchHistory();
    }
    catch (e) {
        if (isProjectGone(e))
            markProjectGone();
    }
}
/** 答复当前这道题 → 引擎取到答复就继续出方案 */
async function send() {
    const q = archPending.value;
    const text = draft.value.trim();
    if (!q || !text || answering.value)
        return;
    answering.value = true;
    try {
        await answerConfirm(q.id, text);
        archMessages.value.push({ role: 'user', content: text });
        draft.value = '';
        archPending.value = null;
        scrollToBottom();
        await pollArch();
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
/* ===== 顶栏动作 ===== */
/** 返回项目功能模块（不保存任何修改） */
function goBack() {
    router.push({ name: 'project-detail', params: { id: String(route.params.id) } });
}
/**
 * 保存方案到后端：技术选型 + 开发计划 + 项目目录 + 状态置 planning
 *
 * ⚠️ 9/17 修：原来这里是 `devPlan: JSON.stringify(phases.value)` —— 用页面模型
 *   （只有 name/progress/tasks）**整体替换**库里的引擎信封，一次性丢掉
 *   risks/project/features/mvp_scope/uiProfile 和每个阶段的 phase 数字，
 *   而 usablePhases() 硬要求数字 phase → 引擎读回后判定计划不可用、退回重跑 PM 对话。
 *   现在改为"在底稿上合并"（见 buildDevPlanJson / buildTechStackJson）。
 *   这两个 JSON 仍是**数组或对象**都是合法形状（后端 validateJsonShape 两种都收）。
 */
async function savePlan() {
    await updateProject(projectId.value, {
        techStack: buildTechStackJson(techStackEnvelope.value, techStack.value),
        devPlan: buildDevPlanJson(devPlanEnvelope.value, devPlanOriginalPhases.value, phases.value, devPlanEngineShape.value),
        dirTree: JSON.stringify(cleanTree(dirTree.value)),
        status: 'planning',
    });
}
/** 确认方案：提交所有修改后返回功能模块（失败提示由拦截器统一弹） */
async function confirmPlan() {
    try {
        await savePlan();
        router.push({ name: 'project-detail', params: { id: String(route.params.id) } });
    }
    catch {
        /* 拦截器已提示，留在本页继续改 */
    }
}
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['rc-status']} */ ;
/** @type {__VLS_StyleScopedClasses['rc-tasks']} */ ;
/** @type {__VLS_StyleScopedClasses['row']} */ ;
/** @type {__VLS_StyleScopedClasses['dico']} */ ;
/** @type {__VLS_StyleScopedClasses['chip-x']} */ ;
/** @type {__VLS_StyleScopedClasses['chip-add']} */ ;
/** @type {__VLS_StyleScopedClasses['ph-op']} */ ;
/** @type {__VLS_StyleScopedClasses['ph-op']} */ ;
/** @type {__VLS_StyleScopedClasses['chat-gone']} */ ;
/** @type {__VLS_StyleScopedClasses['msg']} */ ;
/** @type {__VLS_StyleScopedClasses['msg']} */ ;
/** @type {__VLS_StyleScopedClasses['user']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-bubble']} */ ;
/** @type {__VLS_StyleScopedClasses['tdot']} */ ;
/** @type {__VLS_StyleScopedClasses['tdot']} */ ;
/** @type {__VLS_StyleScopedClasses['cat-tab']} */ ;
/** @type {__VLS_StyleScopedClasses['cat-tab']} */ ;
/** @type {__VLS_StyleScopedClasses['tech-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['tech-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['tech-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['custom-add']} */ ;
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
        ...{ onClick: (__VLS_ctx.goBack) },
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
    (__VLS_ctx.projectName);
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "sheet-no" },
    });
    /** @type {__VLS_StyleScopedClasses['sheet-no']} */ ;
    (String(__VLS_ctx.projectId).padStart(4, '0'));
    // @ts-ignore
    [goBack, projectName, projectId,];
}
{
    const { right: __VLS_7 } = __VLS_3.slots;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (__VLS_ctx.confirmPlan) },
        ...{ class: "btn btn-primary" },
    });
    /** @type {__VLS_StyleScopedClasses['btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
    // @ts-ignore
    [confirmPlan,];
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
    ...{ class: "panel rolecard" },
});
/** @type {__VLS_StyleScopedClasses['panel']} */ ;
/** @type {__VLS_StyleScopedClasses['rolecard']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.header, __VLS_intrinsics.header)({
    ...{ class: "rc-head" },
});
/** @type {__VLS_StyleScopedClasses['rc-head']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.img)({
    ...{ class: "rc-avatar" },
    src: (__VLS_ctx.currentRole.avatar),
    alt: (__VLS_ctx.currentRole.name),
});
/** @type {__VLS_StyleScopedClasses['rc-avatar']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "rc-meta" },
});
/** @type {__VLS_StyleScopedClasses['rc-meta']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.h2, __VLS_intrinsics.h2)({
    ...{ class: "rc-name" },
});
/** @type {__VLS_StyleScopedClasses['rc-name']} */ ;
(__VLS_ctx.currentRole.name);
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "sheet-no rc-badge" },
});
/** @type {__VLS_StyleScopedClasses['sheet-no']} */ ;
/** @type {__VLS_StyleScopedClasses['rc-badge']} */ ;
(__VLS_ctx.currentRole.badge.toUpperCase());
__VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
    ...{ class: "rc-duty dim" },
});
/** @type {__VLS_StyleScopedClasses['rc-duty']} */ ;
/** @type {__VLS_StyleScopedClasses['dim']} */ ;
(__VLS_ctx.currentRole.duty);
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "rc-status" },
});
/** @type {__VLS_StyleScopedClasses['rc-status']} */ ;
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
    ...{ class: "rows rc-tasks" },
});
/** @type {__VLS_StyleScopedClasses['rows']} */ ;
/** @type {__VLS_StyleScopedClasses['rc-tasks']} */ ;
for (const [t] of __VLS_vFor((__VLS_ctx.currentRole.tasks()))) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.li, __VLS_intrinsics.li)({
        key: (t.label),
        ...{ class: "row" },
        ...{ class: ({ done: t.done }) },
    });
    /** @type {__VLS_StyleScopedClasses['row']} */ ;
    /** @type {__VLS_StyleScopedClasses['done']} */ ;
    if (t.done) {
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
    (t.label);
    // @ts-ignore
    [currentRole, currentRole, currentRole, currentRole, currentRole, currentRole, working, working,];
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
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "hint faint" },
});
/** @type {__VLS_StyleScopedClasses['hint']} */ ;
/** @type {__VLS_StyleScopedClasses['faint']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "block-body stack-cloud" },
});
/** @type {__VLS_StyleScopedClasses['block-body']} */ ;
/** @type {__VLS_StyleScopedClasses['stack-cloud']} */ ;
if (!__VLS_ctx.techStack.length) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "stack-empty faint" },
    });
    /** @type {__VLS_StyleScopedClasses['stack-empty']} */ ;
    /** @type {__VLS_StyleScopedClasses['faint']} */ ;
    if (__VLS_ctx.hasArchPlan) {
    }
    else {
    }
}
for (const [t] of __VLS_vFor((__VLS_ctx.techStack))) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        key: (t),
        ...{ class: "chip" },
    });
    /** @type {__VLS_StyleScopedClasses['chip']} */ ;
    (t);
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                return (__VLS_ctx.removeStack(t));
                // @ts-ignore
                [techStack, techStack, hasArchPlan, removeStack,];
            } },
        ...{ class: "chip-x" },
        'aria-label': (`移除 ${t}`),
    });
    /** @type {__VLS_StyleScopedClasses['chip-x']} */ ;
    let __VLS_18;
    /** @ts-ignore @type { | typeof __VLS_components.IconX} */
    IconX;
    // @ts-ignore
    const __VLS_19 = __VLS_asFunctionalComponent1(__VLS_18, new __VLS_18({
        size: (12),
        strokeWidth: (1.75),
    }));
    const __VLS_20 = __VLS_19({
        size: (12),
        strokeWidth: (1.75),
    }, ...__VLS_functionalComponentArgsRest(__VLS_19));
    // @ts-ignore
    [];
}
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (__VLS_ctx.openStackPicker) },
    ...{ class: "chip chip-add" },
    'aria-label': "添加技术",
});
/** @type {__VLS_StyleScopedClasses['chip']} */ ;
/** @type {__VLS_StyleScopedClasses['chip-add']} */ ;
let __VLS_23;
/** @ts-ignore @type { | typeof __VLS_components.IconPlus} */
IconPlus;
// @ts-ignore
const __VLS_24 = __VLS_asFunctionalComponent1(__VLS_23, new __VLS_23({
    size: (13),
    strokeWidth: (2),
}));
const __VLS_25 = __VLS_24({
    size: (13),
    strokeWidth: (2),
}, ...__VLS_functionalComponentArgsRest(__VLS_24));
if (__VLS_ctx.hasArchPlan) {
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
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "block-body arch-plan" },
    });
    /** @type {__VLS_StyleScopedClasses['block-body']} */ ;
    /** @type {__VLS_StyleScopedClasses['arch-plan']} */ ;
    if (__VLS_ctx.archPlan.why) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
            ...{ class: "arch-why" },
        });
        /** @type {__VLS_StyleScopedClasses['arch-why']} */ ;
        (__VLS_ctx.archPlan.why);
    }
    if (__VLS_ctx.archPlan.moduleTech.length) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "arch-sub" },
        });
        /** @type {__VLS_StyleScopedClasses['arch-sub']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.h4, __VLS_intrinsics.h4)({
            ...{ class: "arch-h" },
        });
        /** @type {__VLS_StyleScopedClasses['arch-h']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.ul, __VLS_intrinsics.ul)({
            ...{ class: "rows" },
        });
        /** @type {__VLS_StyleScopedClasses['rows']} */ ;
        for (const [m] of __VLS_vFor((__VLS_ctx.archPlan.moduleTech))) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.li, __VLS_intrinsics.li)({
                key: (m.module),
                ...{ class: "row arch-mod" },
            });
            /** @type {__VLS_StyleScopedClasses['row']} */ ;
            /** @type {__VLS_StyleScopedClasses['arch-mod']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "arch-mod-name" },
            });
            /** @type {__VLS_StyleScopedClasses['arch-mod-name']} */ ;
            (m.module);
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "arch-mod-tech" },
            });
            /** @type {__VLS_StyleScopedClasses['arch-mod-tech']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "arch-tag" },
            });
            /** @type {__VLS_StyleScopedClasses['arch-tag']} */ ;
            (m.backend);
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "arch-mod-tech" },
            });
            /** @type {__VLS_StyleScopedClasses['arch-mod-tech']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "arch-tag" },
            });
            /** @type {__VLS_StyleScopedClasses['arch-tag']} */ ;
            (m.frontend);
            // @ts-ignore
            [hasArchPlan, openStackPicker, archPlan, archPlan, archPlan, archPlan,];
        }
    }
    if (__VLS_ctx.archPlan.dbType || __VLS_ctx.archPlan.middleware.length) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "arch-sub" },
        });
        /** @type {__VLS_StyleScopedClasses['arch-sub']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.h4, __VLS_intrinsics.h4)({
            ...{ class: "arch-h" },
        });
        /** @type {__VLS_StyleScopedClasses['arch-h']} */ ;
        if (__VLS_ctx.archPlan.dbType) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
                ...{ class: "arch-line" },
            });
            /** @type {__VLS_StyleScopedClasses['arch-line']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "arch-tag" },
            });
            /** @type {__VLS_StyleScopedClasses['arch-tag']} */ ;
            (__VLS_ctx.archPlan.dbType.type);
            if (__VLS_ctx.archPlan.dbType.why) {
                __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                    ...{ class: "faint" },
                });
                /** @type {__VLS_StyleScopedClasses['faint']} */ ;
                (__VLS_ctx.archPlan.dbType.why);
            }
        }
        for (const [m] of __VLS_vFor((__VLS_ctx.archPlan.middleware))) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
                key: (m.name),
                ...{ class: "arch-line" },
            });
            /** @type {__VLS_StyleScopedClasses['arch-line']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "arch-tag" },
            });
            /** @type {__VLS_StyleScopedClasses['arch-tag']} */ ;
            (m.name);
            if (m.purpose) {
                __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                    ...{ class: "faint" },
                });
                /** @type {__VLS_StyleScopedClasses['faint']} */ ;
                (m.purpose);
            }
            // @ts-ignore
            [archPlan, archPlan, archPlan, archPlan, archPlan, archPlan, archPlan,];
        }
    }
    if (__VLS_ctx.archPlan.tables.length) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "arch-sub" },
        });
        /** @type {__VLS_StyleScopedClasses['arch-sub']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.h4, __VLS_intrinsics.h4)({
            ...{ class: "arch-h" },
        });
        /** @type {__VLS_StyleScopedClasses['arch-h']} */ ;
        for (const [t] of __VLS_vFor((__VLS_ctx.archPlan.tables))) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                key: (t.name),
                ...{ class: "arch-table" },
            });
            /** @type {__VLS_StyleScopedClasses['arch-table']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
                ...{ class: "arch-line" },
            });
            /** @type {__VLS_StyleScopedClasses['arch-line']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "arch-tag arch-tag-strong mono" },
            });
            /** @type {__VLS_StyleScopedClasses['arch-tag']} */ ;
            /** @type {__VLS_StyleScopedClasses['arch-tag-strong']} */ ;
            /** @type {__VLS_StyleScopedClasses['mono']} */ ;
            (t.name);
            if (t.purpose) {
                __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                    ...{ class: "faint" },
                });
                /** @type {__VLS_StyleScopedClasses['faint']} */ ;
                (t.purpose);
            }
            __VLS_asFunctionalElement1(__VLS_intrinsics.ul, __VLS_intrinsics.ul)({
                ...{ class: "rows arch-fields" },
            });
            /** @type {__VLS_StyleScopedClasses['rows']} */ ;
            /** @type {__VLS_StyleScopedClasses['arch-fields']} */ ;
            for (const [f] of __VLS_vFor((t.fields))) {
                __VLS_asFunctionalElement1(__VLS_intrinsics.li, __VLS_intrinsics.li)({
                    key: (f.name),
                    ...{ class: "row arch-field" },
                });
                /** @type {__VLS_StyleScopedClasses['row']} */ ;
                /** @type {__VLS_StyleScopedClasses['arch-field']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                    ...{ class: "arch-field-name mono" },
                });
                /** @type {__VLS_StyleScopedClasses['arch-field-name']} */ ;
                /** @type {__VLS_StyleScopedClasses['mono']} */ ;
                (f.name);
                __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                    ...{ class: "arch-field-type mono faint" },
                });
                /** @type {__VLS_StyleScopedClasses['arch-field-type']} */ ;
                /** @type {__VLS_StyleScopedClasses['mono']} */ ;
                /** @type {__VLS_StyleScopedClasses['faint']} */ ;
                (f.type);
                if (f.required) {
                    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                        ...{ class: "arch-field-req" },
                    });
                    /** @type {__VLS_StyleScopedClasses['arch-field-req']} */ ;
                }
                if (f.remark) {
                    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                        ...{ class: "arch-field-remark dim" },
                    });
                    /** @type {__VLS_StyleScopedClasses['arch-field-remark']} */ ;
                    /** @type {__VLS_StyleScopedClasses['dim']} */ ;
                    (f.remark);
                }
                // @ts-ignore
                [archPlan, archPlan,];
            }
            // @ts-ignore
            [];
        }
    }
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
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "hint faint" },
});
/** @type {__VLS_StyleScopedClasses['hint']} */ ;
/** @type {__VLS_StyleScopedClasses['faint']} */ ;
(__VLS_ctx.phases.length);
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "block-body phase-list" },
});
/** @type {__VLS_StyleScopedClasses['block-body']} */ ;
/** @type {__VLS_StyleScopedClasses['phase-list']} */ ;
if (!__VLS_ctx.phases.length) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "phase-empty faint" },
    });
    /** @type {__VLS_StyleScopedClasses['phase-empty']} */ ;
    /** @type {__VLS_StyleScopedClasses['faint']} */ ;
}
for (const [p, i] of __VLS_vFor((__VLS_ctx.phases))) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        key: (i),
        ...{ class: "phase panel" },
    });
    /** @type {__VLS_StyleScopedClasses['phase']} */ ;
    /** @type {__VLS_StyleScopedClasses['panel']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "ph-head" },
    });
    /** @type {__VLS_StyleScopedClasses['ph-head']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "ph-num sheet-no" },
    });
    /** @type {__VLS_StyleScopedClasses['ph-num']} */ ;
    /** @type {__VLS_StyleScopedClasses['sheet-no']} */ ;
    (i + 1);
    if (__VLS_ctx.editingPhaseName === i) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
            ...{ onKeyup: (...[$event]) => {
                    if (!(__VLS_ctx.editingPhaseName === i))
                        throw 0;
                    return (__VLS_ctx.savePhaseName(i));
                    // @ts-ignore
                    [phases, phases, phases, editingPhaseName, savePhaseName,];
                } },
            ...{ onKeyup: (...[$event]) => {
                    if (!(__VLS_ctx.editingPhaseName === i))
                        throw 0;
                    return (__VLS_ctx.editingPhaseName = null);
                    // @ts-ignore
                    [editingPhaseName,];
                } },
            ...{ onBlur: (...[$event]) => {
                    if (!(__VLS_ctx.editingPhaseName === i))
                        throw 0;
                    return (__VLS_ctx.savePhaseName(i));
                    // @ts-ignore
                    [savePhaseName,];
                } },
            ...{ class: "ph-input" },
        });
        (__VLS_ctx.phaseNameDraft);
        /** @type {__VLS_StyleScopedClasses['ph-input']} */ ;
    }
    else {
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "ph-name" },
        });
        /** @type {__VLS_StyleScopedClasses['ph-name']} */ ;
        (p.name);
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "ph-count mono faint" },
    });
    /** @type {__VLS_StyleScopedClasses['ph-count']} */ ;
    /** @type {__VLS_StyleScopedClasses['mono']} */ ;
    /** @type {__VLS_StyleScopedClasses['faint']} */ ;
    (p.tasks.length);
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "ph-ops" },
    });
    /** @type {__VLS_StyleScopedClasses['ph-ops']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                return (__VLS_ctx.startEditPhaseName(i));
                // @ts-ignore
                [phaseNameDraft, startEditPhaseName,];
            } },
        ...{ class: "ph-op" },
        title: "重命名阶段",
    });
    /** @type {__VLS_StyleScopedClasses['ph-op']} */ ;
    let __VLS_28;
    /** @ts-ignore @type { | typeof __VLS_components.IconPencil} */
    IconPencil;
    // @ts-ignore
    const __VLS_29 = __VLS_asFunctionalComponent1(__VLS_28, new __VLS_28({
        size: (13),
        strokeWidth: (1.75),
    }));
    const __VLS_30 = __VLS_29({
        size: (13),
        strokeWidth: (1.75),
    }, ...__VLS_functionalComponentArgsRest(__VLS_29));
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                return (__VLS_ctx.removePhase(i));
                // @ts-ignore
                [removePhase,];
            } },
        ...{ class: "ph-op del" },
        title: "删除阶段",
    });
    /** @type {__VLS_StyleScopedClasses['ph-op']} */ ;
    /** @type {__VLS_StyleScopedClasses['del']} */ ;
    let __VLS_33;
    /** @ts-ignore @type { | typeof __VLS_components.IconX} */
    IconX;
    // @ts-ignore
    const __VLS_34 = __VLS_asFunctionalComponent1(__VLS_33, new __VLS_33({
        size: (13),
        strokeWidth: (1.75),
    }));
    const __VLS_35 = __VLS_34({
        size: (13),
        strokeWidth: (1.75),
    }, ...__VLS_functionalComponentArgsRest(__VLS_34));
    if (p.progress > 0) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "prog" },
            title: (`进度 ${p.progress}%`),
        });
        /** @type {__VLS_StyleScopedClasses['prog']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "prog-fill" },
            ...{ style: ({ width: p.progress + '%' }) },
        });
        /** @type {__VLS_StyleScopedClasses['prog-fill']} */ ;
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "ph-tags" },
    });
    /** @type {__VLS_StyleScopedClasses['ph-tags']} */ ;
    for (const [t] of __VLS_vFor((p.tasks))) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            key: (t),
            ...{ class: "chip" },
        });
        /** @type {__VLS_StyleScopedClasses['chip']} */ ;
        (t);
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    return (__VLS_ctx.removeTask(i, t));
                    // @ts-ignore
                    [removeTask,];
                } },
            ...{ class: "chip-x" },
            'aria-label': (`删除任务 ${t}`),
            title: "删除任务",
        });
        /** @type {__VLS_StyleScopedClasses['chip-x']} */ ;
        let __VLS_38;
        /** @ts-ignore @type { | typeof __VLS_components.IconX} */
        IconX;
        // @ts-ignore
        const __VLS_39 = __VLS_asFunctionalComponent1(__VLS_38, new __VLS_38({
            size: (11),
            strokeWidth: (1.75),
        }));
        const __VLS_40 = __VLS_39({
            size: (11),
            strokeWidth: (1.75),
        }, ...__VLS_functionalComponentArgsRest(__VLS_39));
        // @ts-ignore
        [];
    }
    if (__VLS_ctx.addingTaskIn === i) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
            ...{ onKeyup: (...[$event]) => {
                    if (!(__VLS_ctx.addingTaskIn === i))
                        throw 0;
                    return (__VLS_ctx.addTask(i));
                    // @ts-ignore
                    [addingTaskIn, addTask,];
                } },
            ...{ onKeyup: (...[$event]) => {
                    if (!(__VLS_ctx.addingTaskIn === i))
                        throw 0;
                    return (__VLS_ctx.addingTaskIn = null);
                    // @ts-ignore
                    [addingTaskIn,];
                } },
            ...{ onBlur: (...[$event]) => {
                    if (!(__VLS_ctx.addingTaskIn === i))
                        throw 0;
                    return (__VLS_ctx.addTask(i));
                    // @ts-ignore
                    [addTask,];
                } },
            ...{ class: "ph-task-input" },
            placeholder: "任务名称，回车添加",
        });
        (__VLS_ctx.taskDraft);
        /** @type {__VLS_StyleScopedClasses['ph-task-input']} */ ;
    }
    else {
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!!(__VLS_ctx.addingTaskIn === i))
                        throw 0;
                    return (__VLS_ctx.startAddTask(i));
                    // @ts-ignore
                    [taskDraft, startAddTask,];
                } },
            ...{ class: "chip chip-add" },
            title: "添加任务",
        });
        /** @type {__VLS_StyleScopedClasses['chip']} */ ;
        /** @type {__VLS_StyleScopedClasses['chip-add']} */ ;
    }
    // @ts-ignore
    [];
}
__VLS_asFunctionalElement1(__VLS_intrinsics.footer, __VLS_intrinsics.footer)({
    ...{ class: "block-foot" },
});
/** @type {__VLS_StyleScopedClasses['block-foot']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (__VLS_ctx.addPhase) },
    ...{ class: "btn btn-sm" },
});
/** @type {__VLS_StyleScopedClasses['btn']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
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
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "tree-tools" },
});
/** @type {__VLS_StyleScopedClasses['tree-tools']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (...[$event]) => {
            return (__VLS_ctx.treeRef?.addAt('file'));
            // @ts-ignore
            [addPhase, treeRef,];
        } },
    ...{ class: "btn btn-sm" },
});
/** @type {__VLS_StyleScopedClasses['btn']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (...[$event]) => {
            return (__VLS_ctx.treeRef?.addAt('dir'));
            // @ts-ignore
            [treeRef,];
        } },
    ...{ class: "btn btn-sm" },
});
/** @type {__VLS_StyleScopedClasses['btn']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (...[$event]) => {
            return (__VLS_ctx.treeRef?.pasteAtRoot());
            // @ts-ignore
            [treeRef,];
        } },
    ...{ class: "btn btn-sm" },
    disabled: (!__VLS_ctx.treeRef?.hasClip()),
});
/** @type {__VLS_StyleScopedClasses['btn']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
const __VLS_43 = SheetTree;
// @ts-ignore
const __VLS_44 = __VLS_asFunctionalComponent1(__VLS_43, new __VLS_43({
    ref: "treeRef",
    nodes: (__VLS_ctx.dirTree),
}));
const __VLS_45 = __VLS_44({
    ref: "treeRef",
    nodes: (__VLS_ctx.dirTree),
}, ...__VLS_functionalComponentArgsRest(__VLS_44));
var __VLS_48;
var __VLS_46;
__VLS_asFunctionalElement1(__VLS_intrinsics.aside, __VLS_intrinsics.aside)({
    ...{ class: "desk-right panel chat" },
});
/** @type {__VLS_StyleScopedClasses['desk-right']} */ ;
/** @type {__VLS_StyleScopedClasses['panel']} */ ;
/** @type {__VLS_StyleScopedClasses['chat']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.header, __VLS_intrinsics.header)({
    ...{ class: "panel-head" },
});
/** @type {__VLS_StyleScopedClasses['panel-head']} */ ;
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
                [treeRef, dirTree, projectGone, router,];
            } },
        ...{ class: "btn btn-sm btn-primary" },
    });
    /** @type {__VLS_StyleScopedClasses['btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
}
else if (!__VLS_ctx.archMessages.length && !__VLS_ctx.thinking) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "chat-empty faint" },
    });
    /** @type {__VLS_StyleScopedClasses['chat-empty']} */ ;
    /** @type {__VLS_StyleScopedClasses['faint']} */ ;
    if (__VLS_ctx.archPending) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({});
    }
    else {
        __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({});
    }
}
for (const [m, i] of __VLS_vFor((__VLS_ctx.archMessages))) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        key: (i),
        ...{ class: "msg" },
        ...{ class: (m.role) },
    });
    /** @type {__VLS_StyleScopedClasses['msg']} */ ;
    if (m.role === 'assistant') {
        __VLS_asFunctionalElement1(__VLS_intrinsics.img)({
            ...{ class: "msg-avatar" },
            src: (__VLS_ctx.avatarArch),
            alt: "架构师",
        });
        /** @type {__VLS_StyleScopedClasses['msg-avatar']} */ ;
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "msg-bubble" },
    });
    /** @type {__VLS_StyleScopedClasses['msg-bubble']} */ ;
    (m.content);
    // @ts-ignore
    [archMessages, archMessages, thinking, archPending, avatarArch,];
}
if (__VLS_ctx.archPending && __VLS_ctx.parseOptions(__VLS_ctx.archPending).length) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "chat-opts" },
    });
    /** @type {__VLS_StyleScopedClasses['chat-opts']} */ ;
    for (const [opt] of __VLS_vFor((__VLS_ctx.parseOptions(__VLS_ctx.archPending)))) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.archPending && __VLS_ctx.parseOptions(__VLS_ctx.archPending).length))
                        throw 0;
                    __VLS_ctx.draft = opt;
                    __VLS_ctx.send();
                    // @ts-ignore
                    [archPending, archPending, archPending, parseOptions, parseOptions, draft, send,];
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
        src: (__VLS_ctx.avatarArch),
        alt: "架构师",
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
if (__VLS_ctx.archPending) {
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
else if (!__VLS_ctx.projectGone) {
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
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "chat-input" },
});
/** @type {__VLS_StyleScopedClasses['chat-input']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.textarea, __VLS_intrinsics.textarea)({
    ...{ onKeydown: (__VLS_ctx.send) },
    value: (__VLS_ctx.draft),
    ...{ class: "textarea ci-area" },
    rows: "2",
    placeholder: (__VLS_ctx.archPending ? '回答架构师的问题…（Enter 发送）' : '现在没有待答问题'),
    disabled: (!__VLS_ctx.archPending || __VLS_ctx.answering),
});
/** @type {__VLS_StyleScopedClasses['textarea']} */ ;
/** @type {__VLS_StyleScopedClasses['ci-area']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (__VLS_ctx.send) },
    ...{ class: "btn btn-primary ci-send" },
    disabled: (!__VLS_ctx.archPending || !__VLS_ctx.draft.trim() || __VLS_ctx.answering),
    'aria-label': "发送",
});
/** @type {__VLS_StyleScopedClasses['btn']} */ ;
/** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
/** @type {__VLS_StyleScopedClasses['ci-send']} */ ;
let __VLS_50;
/** @ts-ignore @type { | typeof __VLS_components.IconSend} */
IconSend;
// @ts-ignore
const __VLS_51 = __VLS_asFunctionalComponent1(__VLS_50, new __VLS_50({
    size: (16),
    strokeWidth: (1.75),
}));
const __VLS_52 = __VLS_51({
    size: (16),
    strokeWidth: (1.75),
}, ...__VLS_functionalComponentArgsRest(__VLS_51));
if (__VLS_ctx.showStackPicker) {
    const __VLS_55 = AppModal || AppModal;
    // @ts-ignore
    const __VLS_56 = __VLS_asFunctionalComponent1(__VLS_55, new __VLS_55({
        ...{ 'onClose': {} },
        title: "添加技术",
        sheet: "TECH-PICK",
        width: "680px",
    }));
    const __VLS_57 = __VLS_56({
        ...{ 'onClose': {} },
        title: "添加技术",
        sheet: "TECH-PICK",
        width: "680px",
    }, ...__VLS_functionalComponentArgsRest(__VLS_56));
    let __VLS_60;
    const __VLS_61 = {
        /** @type {typeof __VLS_60.close} */
        onClose: (...[$event]) => {
            if (!(__VLS_ctx.showStackPicker))
                throw 0;
            return (__VLS_ctx.showStackPicker = false);
            // @ts-ignore
            [projectGone, thinking, archPending, archPending, archPending, archPending, avatarArch, draft, draft, send, send, answering, answering, showStackPicker, showStackPicker,];
        },
    };
    const { default: __VLS_62 } = __VLS_58.slots;
    __VLS_asFunctionalElement1(__VLS_intrinsics.nav, __VLS_intrinsics.nav)({
        ...{ class: "cat-tabs" },
        'aria-label': "技术分类",
    });
    /** @type {__VLS_StyleScopedClasses['cat-tabs']} */ ;
    for (const [cat] of __VLS_vFor((__VLS_ctx.categories))) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.showStackPicker))
                        throw 0;
                    return (__VLS_ctx.activeCat = cat.key);
                    // @ts-ignore
                    [categories, activeCat,];
                } },
            key: (cat.key),
            ...{ class: "cat-tab" },
            ...{ class: ({ active: __VLS_ctx.activeCat === cat.key }) },
        });
        /** @type {__VLS_StyleScopedClasses['cat-tab']} */ ;
        /** @type {__VLS_StyleScopedClasses['active']} */ ;
        (cat.label);
        // @ts-ignore
        [activeCat,];
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "tech-grid" },
    });
    /** @type {__VLS_StyleScopedClasses['tech-grid']} */ ;
    for (const [t] of __VLS_vFor((__VLS_ctx.filteredTech))) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.showStackPicker))
                        throw 0;
                    return (__VLS_ctx.togglePick(t));
                    // @ts-ignore
                    [filteredTech, togglePick,];
                } },
            key: (t),
            ...{ class: "tech-btn" },
            ...{ class: ({ added: __VLS_ctx.techStack.includes(t), picked: __VLS_ctx.isPicked(t) }) },
            disabled: (__VLS_ctx.techStack.includes(t)),
        });
        /** @type {__VLS_StyleScopedClasses['tech-btn']} */ ;
        /** @type {__VLS_StyleScopedClasses['added']} */ ;
        /** @type {__VLS_StyleScopedClasses['picked']} */ ;
        (t);
        if (__VLS_ctx.techStack.includes(t) || __VLS_ctx.isPicked(t)) {
            let __VLS_63;
            /** @ts-ignore @type { | typeof __VLS_components.IconCheck} */
            IconCheck;
            // @ts-ignore
            const __VLS_64 = __VLS_asFunctionalComponent1(__VLS_63, new __VLS_63({
                size: (13),
                strokeWidth: (2),
                ...{ class: "tech-tick" },
            }));
            const __VLS_65 = __VLS_64({
                size: (13),
                strokeWidth: (2),
                ...{ class: "tech-tick" },
            }, ...__VLS_functionalComponentArgsRest(__VLS_64));
            /** @type {__VLS_StyleScopedClasses['tech-tick']} */ ;
        }
        // @ts-ignore
        [techStack, techStack, techStack, isPicked, isPicked,];
    }
    if (!__VLS_ctx.filteredTech.length) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
            ...{ class: "tech-empty faint" },
        });
        /** @type {__VLS_StyleScopedClasses['tech-empty']} */ ;
        /** @type {__VLS_StyleScopedClasses['faint']} */ ;
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "custom-add" },
    });
    /** @type {__VLS_StyleScopedClasses['custom-add']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
        ...{ onKeyup: (__VLS_ctx.addCustomStack) },
        value: (__VLS_ctx.customStack),
        ...{ class: "input" },
        type: "text",
        placeholder: "自定义技术名称，如：Docker Compose",
    });
    /** @type {__VLS_StyleScopedClasses['input']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (__VLS_ctx.addCustomStack) },
        ...{ class: "btn" },
    });
    /** @type {__VLS_StyleScopedClasses['btn']} */ ;
    {
        const { footer: __VLS_68 } = __VLS_58.slots;
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.showStackPicker))
                        throw 0;
                    return (__VLS_ctx.showStackPicker = false);
                    // @ts-ignore
                    [showStackPicker, filteredTech, addCustomStack, addCustomStack, customStack,];
                } },
            ...{ class: "btn btn-sm" },
        });
        /** @type {__VLS_StyleScopedClasses['btn']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (__VLS_ctx.confirmStackPicker) },
            ...{ class: "btn btn-sm btn-primary" },
            disabled: (!__VLS_ctx.pickingStack.length),
        });
        /** @type {__VLS_StyleScopedClasses['btn']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
        (__VLS_ctx.pickingStack.length);
        // @ts-ignore
        [confirmStackPicker, pickingStack, pickingStack,];
    }
    // @ts-ignore
    [];
    var __VLS_58;
    var __VLS_59;
}
// @ts-ignore
var __VLS_49 = __VLS_48;
// @ts-ignore
[];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
