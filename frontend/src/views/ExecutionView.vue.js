import { ref, computed, onMounted, nextTick, reactive } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { IconChevronDown, IconClock, IconCode, IconFolder, IconLayoutKanban, IconMessage, IconRefresh, IconSend, IconShieldLock, IconTerminal, IconX, } from '@tabler/icons-vue';
import FileTree from '../components/FileTree.vue';
import MonacoEditor from '../components/MonacoEditor.vue';
import TopBar from '../components/ui/TopBar.vue';
import AppModal from '../components/ui/AppModal.vue';
import StampSeal from '../components/ui/StampSeal.vue';
import { AGENT_NAMES } from '../constants/agents';
import { MODE_META, MODE_NUM_TO_STR, TASK_STATUS } from '../constants/status';
import { fetchProjectFiles, fetchProjectFileDetail } from '../api/projectFile';
import { useExecutionStore } from '../stores/execution';
import { fetchTasks, retryTask as apiRetryTask, summarizeTaskQuality } from '../api/task';
import { fetchProjectById, updateProject } from '../api/project';
import { fetchPendingConfirms, parseOptions } from '../api/confirm';
import { answerConfirm as answerConfirmApi } from '../api/confirm';
import { answerPermission } from '../api/confirm';
import { disablePermissionRule, fetchPermissionRules, fetchRecentDenials, } from '../api/permission';
import PermissionRequestCard from '../components/ui/PermissionRequestCard.vue';
import { usePolling } from '../composables/usePolling';
import { pmAnswer } from '../utils/pmChat';
import { toast } from '../utils/toast';
const router = useRouter();
const route = useRoute();
const projectName = ref('项目 #' + route.params.id);
const execStore = useExecutionStore();
const confirmMode = ref(execStore.confirmMode);
/**
 * 路由 id → 有效数字；拿不到就 null。
 * ⚠️ 9/17 修「一直弹系统繁忙」：原来 pollConfirms / loadFromDb / 首拉项目名
 * 都直接 `Number(route.params.id)`，地址里没有有效项目号时得 NaN，
 * 请求打成 /api/confirm/pending?projectId=NaN，后端报 400，10s 一轮 = 无限弹窗。
 * 本页所有按 id 发请求的地方都必须先过这道闸（看板与文件树的轮询早已自己有守卫，这里补齐）。
 */
const routeProjectId = computed(() => {
    const n = Number(route.params.id);
    return Number.isFinite(n) && n > 0 ? n : null;
});
/** 确认模式常量（收口到 constants/status：label/desc 逐字即旧 MODES） */
const MODES = [0, 1, 2].map((n) => ({
    value: n,
    ...MODE_META[MODE_NUM_TO_STR[n]],
}));
function setMode(mode) {
    confirmMode.value = mode;
    execStore.setConfirmMode(mode);
    // 阶段 3：模式落后端 sys_project.confirm_mode（引擎开工时读它决定 Cli/Http 分流）——
    // 只存 localStorage 的话选择器就是装饰，Web 上切了引擎也看不见
    const id = routeProjectId.value;
    if (id == null)
        return; // 没有有效项目号：本地态照切，不发注定失败的请求
    const strMode = MODE_NUM_TO_STR[mode];
    updateProject(id, { confirmMode: strMode }).catch(() => {
        /* 保存失败提示由拦截器统一弹；本地态保留，用户可重试 */
    });
}
// ===== 确认门问答卡（阶段 3）：pending 题轮询弹卡，答复即续跑 =====
const pendingConfirms = ref([]);
const confirmText = ref('');
const confirmBusy = ref(false);
/**
 * 权限规则（9/18）：点"始终允许"会把规则写进库，写完立刻回读 ——
 * 否则"我刚写的规则在哪"要等下次进页面才看得到（人就会怀疑那一下点击没生效）。
 */
const permRules = ref([]);
const permDenials = ref([]);
async function loadRules() {
    const id = routeProjectId.value;
    if (id == null)
        return;
    try {
        permRules.value = await fetchPermissionRules(id);
    }
    catch {
        /* 后端未就绪：规则列表是增强，不拦看板 */
    }
}
/** 最近被拒：detail_json 里只有字符串，取出来给"最近被拒"面板显示命令原文 */
async function loadDenials() {
    const id = routeProjectId.value;
    if (id == null)
        return;
    try {
        const rows = await fetchRecentDenials(id, 20);
        permDenials.value = rows.map((r) => {
            let command;
            const raw = r.detailJson;
            if (typeof raw === 'string' && raw) {
                try {
                    const d = JSON.parse(raw);
                    command = d.command;
                }
                catch {
                    /* 坏 JSON 就当没有，不炸面板 */
                }
            }
            return { command, question: typeof r.question === 'string' ? r.question : undefined };
        });
    }
    catch {
        /* 同上：增强项，失败不拦 */
    }
}
/** 停用规则（不物理删：停用后仍能看见它曾经存在过） */
async function disableRule(id) {
    try {
        await disablePermissionRule(id);
        toast.success('规则已停用（保留在列表里，便于日后对照）');
        await loadRules();
    }
    catch {
        /* 拦截器已提示 */
    }
}
const permBehaviorLabel = (b) => b === 'allow' ? '允许' : b === 'deny' ? '拒绝' : '询问';
const permSourceLabel = (s) => s === 'policy' ? '策略层' : s === 'project' ? '项目层' : s === 'session' ? '会话层' : '用户层';
/**
 * 当前模式对"命令权限"意味着什么 —— 这张表是要给人看的，不是内部实现细节：
 *   全自动 —— 什么都不问（连破坏性命令也放），预算不设限
 *   混合   —— 白名单直放；有后果的命令（装依赖/写盘/连网/删改）问一次；换阶段问 y/n
 *   手动   —— 白名单以外一律问
 * 写在这里而不是散在代码里：人看到规则列表为空时，得能自己判断"是没规则，还是模式没问"。
 */
const permModeHint = computed(() => {
    if (confirmMode.value === 0)
        return '· 全时不询问，命令一律放行';
    if (confirmMode.value === 2)
        return '· 白名单之外一律询问';
    return '· 有后果的命令才询问';
});
async function pollConfirms() {
    const id = routeProjectId.value;
    if (id == null || projectGone.value)
        return; // 无效 id / 项目已删：都别发
    try {
        pendingConfirms.value = await fetchPendingConfirms(id);
    }
    catch (e) {
        if (isProjectGone(e))
            markProjectGone();
        /* 后端未就绪等：本轮不弹卡，下轮 10s 再试（卡是增强不是控制，永不拦看板） */
    }
}
async function submitConfirm(answer) {
    if (confirmBusy.value || !pendingConfirms.value.length)
        return;
    confirmBusy.value = true;
    try {
        await answerConfirmApi(pendingConfirms.value[0].id, answer);
        toast.success('已答复，引擎几秒内续跑');
        confirmText.value = '';
        await pollConfirms();
    }
    finally {
        confirmBusy.value = false;
    }
}
/** 超时放行倒计时提示（惰性：每轮轮询刷新，不做秒级动画） */
function confirmCountdown(expireAt) {
    if (!expireAt)
        return '';
    const min = Math.max(0, Math.round((new Date(expireAt).getTime() - Date.now()) / 60000));
    return min > 0 ? `${min} 分钟无人应答将自动放行` : '即将自动放行';
}
/**
 * 权限卡的倒计时 —— 文案与问答卡**故意不同**（9/18）：
 *   问答卡超时=按默认答案放行；权限卡超时=**按拒绝处理**（fail-closed，见后端 passExpired）。
 * 这里如果偷懒复用"将自动放行"，人就会以为"不管它也会过去"，
 * 而实际结果是"不管它就不许跑" —— 两句话指向相反的后果，不能共用。
 */
function permCountdown(expireAt) {
    if (!expireAt)
        return '';
    const min = Math.max(0, Math.round((new Date(expireAt).getTime() - Date.now()) / 60000));
    return min > 0 ? `${min} 分钟无人应答将按「拒绝」处理` : '即将按「拒绝」处理';
}
/** 审批卡的裁定提交：走 decision（可判定枚举），不走 answer 文本 */
async function submitPermission(decision) {
    if (confirmBusy.value || !pendingConfirms.value.length)
        return;
    confirmBusy.value = true;
    try {
        await answerPermission(pendingConfirms.value[0].id, decision);
        toast.success(decision === 'deny'
            ? '已拒绝，引擎会换做法或如实交代'
            : decision === 'allow_always'
                ? '已始终允许（规则已写入，同类命令不再询问）'
                : '已允许这一次');
        await pollConfirms();
        // 规则落库后立刻刷新规则列表 —— 否则"我刚写的规则在哪"要等下次进页面才看得到
        await loadRules();
    }
    finally {
        confirmBusy.value = false;
    }
}
// ===== 布局状态（活动栏三席） =====
const activeView = ref('files'); // 左侧边栏内容：文件树 / 对话 / 命令权限规则
// 窄屏（≤860px 侧栏变浮层，挡着看图台）默认收抽屉——车间图纸桌先给屏幕，点图夹脊可开
const leftOpen = ref(!window.matchMedia('(max-width: 860px)').matches); // 左侧边栏
const rightOpen = ref(false); // 右侧边栏（任务看板）
const logOpen = ref(false); // 底部日志面板
// ===== 面板尺寸（支持拖拽拉伸） =====
const sidebarWidth = ref(280);
const rightbarWidth = ref(250);
const logHeight = ref(180);
/**
 * 拖拽调整面板大小（直接在模板中传入事件对象）
 * @param e      鼠标事件
 * @param axis   拖拽方向
 * @param target 目标面板
 */
function startDrag(e, axis, target) {
    e.preventDefault();
    const startPos = axis === 'x' ? e.clientX : e.clientY;
    const startSize = target === 'left' ? sidebarWidth.value
        : target === 'right' ? rightbarWidth.value
            : logHeight.value;
    function onMove(ev) {
        const delta = (axis === 'x' ? ev.clientX : ev.clientY) - startPos;
        if (target === 'left') {
            sidebarWidth.value = Math.min(Math.max(startSize + delta, 180), 500);
        }
        else if (target === 'right') {
            rightbarWidth.value = Math.min(Math.max(startSize - delta, 180), 500);
        }
        else {
            logHeight.value = Math.min(Math.max(startSize - delta, 100), 420);
        }
    }
    function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
}
// ===== 任务看板 =====
const tasks = ref([]);
const qualitySummary = computed(() => summarizeTaskQuality(tasks.value));
/** 收起的列（默认完工收起来） */
const collapsedCols = reactive(new Set(['done']));
/** 任务详情弹窗 */
const taskDetail = ref(null);
function openTaskDetail(t) {
    taskDetail.value = t;
}
function taskTone(status) {
    return TASK_STATUS[status]?.tone || 'pencil';
}
function taskStatusLabel(status) {
    return TASK_STATUS[status]?.label || status;
}
function toggleCol(status) {
    if (collapsedCols.has(status))
        collapsedCols.delete(status);
    else
        collapsedCols.add(status);
}
function taskCount(status) {
    return tasks.value.filter((t) => t.status === status).length;
}
function tasksBy(status) {
    return tasks.value.filter((t) => t.status === status);
}
/** 重跑：调后端（todo 复位 + retry_count+1），乐观更新，pollTasks 校准；引擎在阶段边界消费返工 */
async function retryTask(t) {
    try {
        await apiRetryTask(t.id);
        t.status = 'todo';
        t.retryCount += 1;
        pushLog({ time: '', agentId: 0, agent: '系统', text: `任务 ${t.taskIdExt || t.id}「${t.title}」已重新排队（第 ${t.retryCount} 次，引擎于阶段边界重新派发）` });
    }
    catch (e) {
        pushLog({ time: '', agentId: 0, agent: '系统', text: `重跑失败：${e.message || e}` });
    }
}
/** 上次轮询的任务状态快照：diff 出真事件进日志流（替代假时间线播放器） */
const lastStatus = new Map();
/** 10s 轮询——看板唯一数据源=sys_task（施工卡 1-4：mock 已撤，一切以库里为准） */
async function pollTasks() {
    const projectId = Number(route.params.id);
    if (!projectId || projectGone.value)
        return;
    let list = null;
    try {
        list = await fetchTasks(projectId);
    }
    catch (e) {
        if (isProjectGone(e))
            markProjectGone(); // 项目被删 → 停轮询，别每 10s 撞一次
        return; // 后端未就绪时静默，保留已有数据
    }
    if (!list)
        return;
    // 1. 状态变化 → 日志真事件（谁在动这块卡片一目了然）
    for (const t of list) {
        if (lastStatus.get(t.id) !== t.status) {
            const who = t.status === 'failed' ? 5 : t.status === 'done' ? 6 : t.layer === 'frontend' ? 4 : 3;
            const line = t.status === 'failed'
                ? `任务 ${t.taskIdExt || t.id}「${t.title}」失败：${(t.errorMsg || '未记录原因').split('\n')[0].slice(0, 60)}`
                : `任务 ${t.taskIdExt || t.id}「${t.title}」${taskStatusLabel(t.status)}`;
            pushLog({ time: '', agentId: who, agent: '', text: line });
            lastStatus.set(t.id, t.status);
        }
    }
    tasks.value = list;
    // 2. 顶栏真状态：进度=done/total；阶段=在办任务最小编号；全部终态=已收敛
    const total = list.length;
    const doneCount = list.filter((t) => t.status === 'done').length;
    overallProgress.value = total ? Math.round((doneCount / total) * 100) : 0;
    const doing = list.filter((t) => t.status === 'doing');
    if (doing.length)
        currentPhase.value = `阶段 ${doing.reduce((m, t) => Math.min(m, t.phaseId ?? 99), 99)}`;
    else if (list.some((t) => t.status === 'todo'))
        currentPhase.value = '待派发';
    else if (total)
        currentPhase.value = '已收敛';
    else
        currentPhase.value = '';
    done.value = total > 0 && list.every((t) => t.status === 'done' || t.status === 'failed');
}
/** 日志里 Agent 名号的颜色：一席一章色（旧版是五串手写 hex，现在走章色 token 类名） */
function agentClass(id) {
    const cls = ['', 'ag-1', 'ag-2', 'ag-3', 'ag-4', 'ag-5', 'ag-6'];
    return cls[id] || 'ag-sys';
}
// ===== 文件树 + 多 Tab 编辑器（持久化到 localStorage） =====
const FILE_STORAGE_KEY = `cf_files_${route.params.id}`;
const fileTree = ref([]);
const tabs = ref([]);
const activeFile = ref(null);
const fileCount = computed(() => countFiles(fileTree.value));
/** 保存文件树（查看代码随时可恢复） */
function persistFiles() {
    try {
        localStorage.setItem(FILE_STORAGE_KEY, JSON.stringify(fileTree.value));
    }
    catch {
        /* 内容过大时忽略 */
    }
}
/** 恢复文件树 */
function restoreFiles() {
    try {
        const saved = localStorage.getItem(FILE_STORAGE_KEY);
        if (saved) {
            fileTree.value = JSON.parse(saved);
            return true;
        }
    }
    catch {
        /* 损坏忽略 */
    }
    return false;
}
function countFiles(nodes) {
    return nodes.reduce((sum, n) => sum + (n.type === 'file' ? 1 : countFiles(n.children || [])), 0);
}
/** 打开文件 → 加入 Tab（VS Code 行为）；落库文件无内容时异步拉详情 */
async function openFile(node) {
    if (!tabs.value.find((t) => t.path === node.path)) {
        tabs.value.push(node);
    }
    activeFile.value = node;
    if (node.id && !node.content) {
        try {
            const vo = await fetchProjectFileDetail(node.id);
            node.content = vo.fileContent ?? '';
            node.userModified = !!vo.userModified;
        }
        catch {
            /* 拦截器已提示 */
        }
    }
}
/** 从数据库加载文件树（sys_project_file）：目录优先展开、文件按路径排序 */
async function loadFromDb() {
    const id = routeProjectId.value;
    if (id == null)
        return false;
    try {
        const list = await fetchProjectFiles(id);
        if (!list || list.length === 0)
            return false;
        fileTree.value = buildTreeFromVO(list);
        return true;
    }
    catch {
        return false;
    }
}
/** VO 列表 → 目录树（复用 insertFile 的建目录逻辑，批量版；目录默认展开） */
function buildTreeFromVO(list) {
    const root = [];
    const sorted = [...list].sort((a, b) => a.filePath.localeCompare(b.filePath));
    for (const vo of sorted) {
        const parts = vo.filePath.split('/');
        const fileName = parts.pop();
        let level = root;
        let curPath = '';
        for (const part of parts) {
            curPath += (curPath ? '/' : '') + part;
            let dir = level.find((n) => n.type === 'dir' && n.name === part);
            if (!dir) {
                dir = { name: part, type: 'dir', path: curPath, open: true, children: [] };
                level.push(dir);
            }
            if (!dir.children)
                dir.children = [];
            level = dir.children;
        }
        level.push({
            id: vo.id,
            name: fileName,
            type: 'file',
            path: vo.filePath,
            content: '', // 详情点开再拉，列表不含大字段
            userModified: !!vo.userModified,
        });
    }
    return root;
}
function closeTab(path) {
    const idx = tabs.value.findIndex((t) => t.path === path);
    if (idx < 0)
        return;
    tabs.value.splice(idx, 1);
    if (activeFile.value?.path === path) {
        activeFile.value = tabs.value[idx] || tabs.value[idx - 1] || null;
    }
}
/** Tab 显示：最后一段路径 */
function tabName(path) {
    return path.split('/').pop() || path;
}
/** 扩展名 → 章色（旧 FILE_TAB_META 的手绘小图标换成字码片：色随章色走） */
const EXT_TONE = {
    java: 'rust',
    vue: 'pass',
    ts: 'info',
    js: 'info',
    yml: 'wait',
    yaml: 'wait',
    md: 'pencil',
};
function tabExt(path) {
    return path.split('.').pop()?.toLowerCase() || '';
}
function extToneClass(path) {
    return 'ext-' + (EXT_TONE[tabExt(path)] || 'pencil');
}
function langFor(path) {
    const ext = tabExt(path);
    const map = {
        java: 'java', vue: 'html', ts: 'typescript', js: 'javascript',
        yml: 'yaml', yaml: 'yaml', json: 'json', xml: 'xml', sql: 'sql', md: 'markdown', css: 'css',
    };
    return map[ext] || 'plaintext';
}
function onUserEdit() {
    if (activeFile.value && !activeFile.value.userModified) {
        activeFile.value.userModified = true;
    }
}
function onSave() {
    if (activeFile.value) {
        activeFile.value.userModified = true;
    }
}
const chatMessages = ref([
    {
        role: 'assistant',
        // 开场白也得说实话：这框能答什么、答不了什么先讲清楚。
        // 否则用户拿"这段代码为什么这么写"来问，得到一句编的话比得到"答不了"更糟。
        content: '我是项目经理 Hina。这个框读的是执行状态数据（任务、失败原因、确认门、产物树、执行日志），可以问我：进度、卡在哪、要我确认什么、产出了哪些文件、下一步、怎么停。\n\n「这段代码为什么这么写」这类要读代码本身的问题我答不了 —— 请到右下「执行日志」和任务详情里看原话凭据。',
    },
]);
const chatDraft = ref('');
const chatThinking = ref(false);
const chatUnread = ref(false);
/* ===== 对话的答案从哪来 =====
   9/18 接上：答案一律**来自页面正在轮询的真数据**，不再回预置文案。
   数据源（全是本页已有的、每 10s 刷新的）：
     tasks          sys_task 全量（状态/失败原因/返工次数）
     currentPhase   收口进度算出来的阶段
     pendingConfirms sys_confirm 里挂着的待答题（确认门）
     fileTree       sys_project_file 的产物树
     logs           引擎日志差分出来的真事件
   为什么不做成"什么都能聊"：那需要一条 LLM 通道（后端新端点 + 引擎单轮调用），
   现在没有。所以**读代码问为什么**这类问题它老实说答不了，并把人指到真凭据
   （执行日志 / 任务详情弹窗），而不是编一段听起来合理的话。
   编话比说"我不知道"更坏 —— 那正是这个框原来的毛病。 */
/** 组装给纯函数回答器的快照（全部来自本页正在轮询的真数据） */
function pmSnapshot() {
    const dirs = [];
    for (const n of fileTree.value) {
        if (n.type === 'dir' && !dirs.includes(n.name))
            dirs.push(n.name);
    }
    return {
        tasks: tasks.value.map((t) => ({
            id: t.id,
            taskIdExt: t.taskIdExt,
            title: t.title,
            status: t.status,
            retryCount: t.retryCount,
            layer: t.layer,
            errorMsg: t.errorMsg,
        })),
        currentPhase: currentPhase.value,
        overallProgress: overallProgress.value,
        pending: pendingConfirms.value.map((c) => ({
            question: c.question,
            expireAt: c.expireAt,
            countdown: confirmCountdown(c.expireAt),
        })),
        fileCount: countFiles(fileTree.value),
        topDirs: dirs.slice(0, 8),
    };
}
/* 关键词 mock 已删（9/18）：回答逻辑搬到 utils/pmChat.ts 的 pmAnswer —— 纯函数，
   能拿真实 sys_task 行验它说的每句话是不是真的（前端没有测试框架，
   这就是把判定抽出去的理由，同 utils/json.ts 里那几个 build*）。
   本组件只负责递快照。 */
function chatReply(text) {
    return pmAnswer(pmSnapshot(), text);
}
function sendChat() {
    const text = chatDraft.value.trim();
    if (!text || chatThinking.value)
        return;
    chatMessages.value.push({ role: 'user', content: text });
    chatDraft.value = '';
    chatThinking.value = true;
    setTimeout(() => {
        chatMessages.value.push({ role: 'assistant', content: chatReply(text) });
        chatThinking.value = false;
        chatUnread.value = true;
    }, 700);
}
// ===== 执行视图状态（真数据：日志=轮询差分，顶栏状态=pollTasks 计算） =====
const logs = ref([]);
const logBody = ref(null);
const currentPhase = ref('');
const overallProgress = ref(0);
const done = ref(false);
function pushLog(e) {
    logs.value.push({
        time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
        agentId: e.agentId,
        agent: AGENT_NAMES[e.agentId]?.name || '系统',
        text: e.text,
    });
    nextTick(() => {
        if (logBody.value) {
            logBody.value.scrollTop = logBody.value.scrollHeight;
        }
    });
}
/* 项目没了（被删）→ 停轮询（9/18）
   ------------------------------------------------------------
   这页的轮询是 10 秒一档，项目被删后每轮都会撞出「项目不存在: N」
   （ProjectGuard.requireOwned 抛的），连起来就是"错误提示一直弹、永远不停"。
   toast 那层只是把它变稀（见 utils/toast.ts 的抑制窗），正解是**别再问**。
   判定靠文案：ProjectGuard 的措辞是 '项目不存在: ' + id，来源唯一且稳定。 */
const projectGone = ref(false);
function isProjectGone(e) {
    return e instanceof Error && e.message.includes('项目不存在');
}
function markProjectGone() {
    if (projectGone.value)
        return;
    projectGone.value = true;
    stopPolling();
    console.warn('[exec] 项目已不存在，停止轮询（这不是网络问题）');
}
const { start: startPolling, stop: stopPolling } = usePolling(() => {
    pollFiles();
    pollTasks();
    pollConfirms();
}, 10000);
onMounted(async () => {
    // 看板唯一数据源=sys_task 轮询（假卡片/假时间线已随施工卡 1-4 撤除）
    await pollTasks();
    void pollConfirms(); // 确认门首拉：进页面就答，不等 10s（阶段 3）
    void loadRules(); // 规则与最近被拒：活动栏角标要显示条数，所以首拉一次
    void loadDenials();
    // 回填真项目名 + 库中确认模式（阶段 3：模式以 sys_project.confirm_mode 为真相，本地只是即时态）
    const pid = routeProjectId.value;
    if (pid != null) {
        fetchProjectById(pid)
            .then((p) => {
            projectName.value = p.name;
            if (p.confirmMode === 0 || p.confirmMode === 1 || p.confirmMode === 2) {
                confirmMode.value = p.confirmMode;
                execStore.setConfirmMode(p.confirmMode);
            }
        })
            .catch(() => {
            /* 详情拉不到不拦面板主流程 */
        });
    }
    // 文件优先从数据库加载（agent 落库 sys_project_file），本地草稿兜底；任务状态只信 pollTasks
    if (!(await loadFromDb()))
        restoreFiles();
    // 10s 轮询：文件 + 任务 + 待答问题（引擎在跑就有新状态）
    startPolling();
});
function viewOverview() {
    router.push({ name: 'project-detail', params: { id: String(route.params.id) } });
}
// ===== 10s 轮询：文件列表 + 当前 Tab（Agent 修改后自动刷新） =====
/** 保存当前目录展开状态 */
function saveOpenPaths(nodes) {
    const paths = new Set();
    function walk(list) {
        for (const n of list) {
            if (n.type === 'dir') {
                if (n.open)
                    paths.add(n.path);
                if (n.children)
                    walk(n.children);
            }
        }
    }
    walk(nodes);
    return paths;
}
/** 恢复目录展开状态 */
function restoreOpenPaths(nodes, openPaths) {
    for (const n of nodes) {
        if (n.type === 'dir') {
            if (openPaths.has(n.path))
                n.open = true;
            if (n.children)
                restoreOpenPaths(n.children, openPaths);
        }
    }
}
/** 轮询：刷新文件树 + 当前 Tab 内容（用户修改的不覆盖） */
async function pollFiles() {
    const projectId = Number(route.params.id);
    if (!projectId || projectGone.value)
        return;
    try {
        // 保存展开 → 重建树 → 恢复展开（避免目录折叠）
        const openPaths = saveOpenPaths(fileTree.value);
        const list = await fetchProjectFiles(projectId);
        if (list && list.length > 0) {
            fileTree.value = buildTreeFromVO(list);
            restoreOpenPaths(fileTree.value, openPaths);
            persistFiles();
        }
        // 轮询当前 Tab：非用户修改的文件自动更新内容
        if (activeFile.value && activeFile.value.id && !activeFile.value.userModified) {
            const vo = await fetchProjectFileDetail(activeFile.value.id);
            if (vo.fileContent && vo.fileContent !== activeFile.value.content) {
                activeFile.value.content = vo.fileContent;
                // 同步更新 tabs 数组中对应 tab 的内容
                const tab = tabs.value.find((t) => t.path === activeFile.value?.path);
                if (tab)
                    tab.content = vo.fileContent;
            }
        }
    }
    catch (e) {
        if (isProjectGone(e))
            markProjectGone();
        // 其余静默失败，下次轮询继续
    }
}
const __VLS_ctx = {
    ...{},
    ...{},
};
let __VLS_components;
let __VLS_intrinsics;
let __VLS_directives;
/** @type {__VLS_StyleScopedClasses['exec']} */ ;
/** @type {__VLS_StyleScopedClasses['quality-strip']} */ ;
/** @type {__VLS_StyleScopedClasses['activity-item']} */ ;
/** @type {__VLS_StyleScopedClasses['activity-item']} */ ;
/** @type {__VLS_StyleScopedClasses['rightbar']} */ ;
/** @type {__VLS_StyleScopedClasses['rules-mode']} */ ;
/** @type {__VLS_StyleScopedClasses['mode-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['mode-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['active']} */ ;
/** @type {__VLS_StyleScopedClasses['mode-btn']} */ ;
/** @type {__VLS_StyleScopedClasses['msg']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-avatar']} */ ;
/** @type {__VLS_StyleScopedClasses['msg']} */ ;
/** @type {__VLS_StyleScopedClasses['user']} */ ;
/** @type {__VLS_StyleScopedClasses['msg-bubble']} */ ;
/** @type {__VLS_StyleScopedClasses['tdot']} */ ;
/** @type {__VLS_StyleScopedClasses['tdot']} */ ;
/** @type {__VLS_StyleScopedClasses['chat-input']} */ ;
/** @type {__VLS_StyleScopedClasses['resize-handle']} */ ;
/** @type {__VLS_StyleScopedClasses['resize-handle']} */ ;
/** @type {__VLS_StyleScopedClasses['resize-handle']} */ ;
/** @type {__VLS_StyleScopedClasses['resize-handle']} */ ;
/** @type {__VLS_StyleScopedClasses['tab']} */ ;
/** @type {__VLS_StyleScopedClasses['tab']} */ ;
/** @type {__VLS_StyleScopedClasses['active']} */ ;
/** @type {__VLS_StyleScopedClasses['tab-close']} */ ;
/** @type {__VLS_StyleScopedClasses['editor-wrap']} */ ;
/** @type {__VLS_StyleScopedClasses['editor-empty']} */ ;
/** @type {__VLS_StyleScopedClasses['faint']} */ ;
/** @type {__VLS_StyleScopedClasses['qc-head']} */ ;
/** @type {__VLS_StyleScopedClasses['kanban-col-head']} */ ;
/** @type {__VLS_StyleScopedClasses['kb-arrow']} */ ;
/** @type {__VLS_StyleScopedClasses['kanban-card']} */ ;
/** @type {__VLS_StyleScopedClasses['kanban-card']} */ ;
/** @type {__VLS_StyleScopedClasses['kanban-card']} */ ;
/** @type {__VLS_StyleScopedClasses['kanban-card']} */ ;
/** @type {__VLS_StyleScopedClasses['kanban-card']} */ ;
/** @type {__VLS_StyleScopedClasses['kanban-retry']} */ ;
/** @type {__VLS_StyleScopedClasses['ds-label']} */ ;
/** @type {__VLS_StyleScopedClasses['detail-text']} */ ;
/** @type {__VLS_StyleScopedClasses['detail-text']} */ ;
/** @type {__VLS_StyleScopedClasses['confirm-free']} */ ;
/** @type {__VLS_StyleScopedClasses['sidebar']} */ ;
/** @type {__VLS_StyleScopedClasses['rightbar']} */ ;
/** @type {__VLS_StyleScopedClasses['sidebar']} */ ;
/** @type {__VLS_StyleScopedClasses['rightbar']} */ ;
/** @type {__VLS_StyleScopedClasses['resize-handle']} */ ;
/** @type {__VLS_StyleScopedClasses['quality-strip']} */ ;
/** @type {__VLS_StyleScopedClasses['q-muted']} */ ;
/** @type {__VLS_StyleScopedClasses['quality-strip']} */ ;
/** @type {__VLS_StyleScopedClasses['tb-title']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "exec vsc-dark" },
});
/** @type {__VLS_StyleScopedClasses['exec']} */ ;
/** @type {__VLS_StyleScopedClasses['vsc-dark']} */ ;
const __VLS_0 = TopBar || TopBar;
// @ts-ignore
const __VLS_1 = __VLS_asFunctionalComponent1(__VLS_0, new __VLS_0({
    ...{ class: "exec-top" },
}));
const __VLS_2 = __VLS_1({
    ...{ class: "exec-top" },
}, ...__VLS_functionalComponentArgsRest(__VLS_1));
/** @type {__VLS_StyleScopedClasses['exec-top']} */ ;
const { default: __VLS_5 } = __VLS_3.slots;
{
    const { context: __VLS_6 } = __VLS_3.slots;
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                return (__VLS_ctx.router.push(`/projects/${__VLS_ctx.route.params.id}`));
                // @ts-ignore
                [router, route,];
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
    (__VLS_ctx.projectName);
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
    const __VLS_7 = StampSeal;
    // @ts-ignore
    const __VLS_8 = __VLS_asFunctionalComponent1(__VLS_7, new __VLS_7({
        label: (__VLS_ctx.currentPhase || '准备中'),
        tone: "info",
    }));
    const __VLS_9 = __VLS_8({
        label: (__VLS_ctx.currentPhase || '准备中'),
        tone: "info",
    }, ...__VLS_functionalComponentArgsRest(__VLS_8));
    // @ts-ignore
    [projectName, currentPhase,];
}
{
    const { right: __VLS_12 } = __VLS_3.slots;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "quality-strip" },
        title: "基于当前已进入终态的任务统计",
    });
    /** @type {__VLS_StyleScopedClasses['quality-strip']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "q-label faint" },
    });
    /** @type {__VLS_StyleScopedClasses['q-label']} */ ;
    /** @type {__VLS_StyleScopedClasses['faint']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.strong, __VLS_intrinsics.strong)({});
    (__VLS_ctx.qualitySummary.firstPassRate);
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "q-muted" },
    });
    /** @type {__VLS_StyleScopedClasses['q-muted']} */ ;
    (__VLS_ctx.qualitySummary.evaluated);
    if (__VLS_ctx.qualitySummary.totalRetries) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "q-retry" },
        });
        /** @type {__VLS_StyleScopedClasses['q-retry']} */ ;
        let __VLS_13;
        /** @ts-ignore @type { | typeof __VLS_components.IconRefresh} */
        IconRefresh;
        // @ts-ignore
        const __VLS_14 = __VLS_asFunctionalComponent1(__VLS_13, new __VLS_13({
            size: (13),
            strokeWidth: (1.75),
        }));
        const __VLS_15 = __VLS_14({
            size: (13),
            strokeWidth: (1.75),
        }, ...__VLS_functionalComponentArgsRest(__VLS_14));
        (__VLS_ctx.qualitySummary.totalRetries);
    }
    if (__VLS_ctx.done) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (__VLS_ctx.viewOverview) },
            ...{ class: "btn btn-primary btn-sm" },
        });
        /** @type {__VLS_StyleScopedClasses['btn']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
    }
    // @ts-ignore
    [qualitySummary, qualitySummary, qualitySummary, qualitySummary, done, viewOverview,];
}
// @ts-ignore
[];
var __VLS_3;
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "body" },
});
/** @type {__VLS_StyleScopedClasses['body']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.nav, __VLS_intrinsics.nav)({
    ...{ class: "activity-bar" },
    'aria-label': "面板切换",
});
/** @type {__VLS_StyleScopedClasses['activity-bar']} */ ;
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (...[$event]) => {
            return (__VLS_ctx.leftOpen && __VLS_ctx.activeView === 'files' ? (__VLS_ctx.leftOpen = false) : ((__VLS_ctx.activeView = 'files'), (__VLS_ctx.leftOpen = true)));
            // @ts-ignore
            [leftOpen, leftOpen, leftOpen, activeView, activeView,];
        } },
    ...{ class: "activity-item" },
    ...{ class: ({ active: __VLS_ctx.leftOpen && __VLS_ctx.activeView === 'files' }) },
    title: "资源管理器（文件树）",
});
/** @type {__VLS_StyleScopedClasses['activity-item']} */ ;
/** @type {__VLS_StyleScopedClasses['active']} */ ;
let __VLS_18;
/** @ts-ignore @type { | typeof __VLS_components.IconFolder} */
IconFolder;
// @ts-ignore
const __VLS_19 = __VLS_asFunctionalComponent1(__VLS_18, new __VLS_18({
    size: (21),
    strokeWidth: (1.75),
}));
const __VLS_20 = __VLS_19({
    size: (21),
    strokeWidth: (1.75),
}, ...__VLS_functionalComponentArgsRest(__VLS_19));
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (...[$event]) => {
            return (__VLS_ctx.leftOpen && __VLS_ctx.activeView === 'chat' ? (__VLS_ctx.leftOpen = false) : ((__VLS_ctx.activeView = 'chat'), (__VLS_ctx.leftOpen = true)));
            // @ts-ignore
            [leftOpen, leftOpen, leftOpen, leftOpen, activeView, activeView, activeView,];
        } },
    ...{ class: "activity-item" },
    ...{ class: ({ active: __VLS_ctx.leftOpen && __VLS_ctx.activeView === 'chat' }) },
    title: "与项目经理对话",
});
/** @type {__VLS_StyleScopedClasses['activity-item']} */ ;
/** @type {__VLS_StyleScopedClasses['active']} */ ;
let __VLS_23;
/** @ts-ignore @type { | typeof __VLS_components.IconMessage} */
IconMessage;
// @ts-ignore
const __VLS_24 = __VLS_asFunctionalComponent1(__VLS_23, new __VLS_23({
    size: (21),
    strokeWidth: (1.75),
}));
const __VLS_25 = __VLS_24({
    size: (21),
    strokeWidth: (1.75),
}, ...__VLS_functionalComponentArgsRest(__VLS_24));
if (__VLS_ctx.chatUnread) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "activity-badge" },
    });
    /** @type {__VLS_StyleScopedClasses['activity-badge']} */ ;
}
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (...[$event]) => {
            return (__VLS_ctx.leftOpen && __VLS_ctx.activeView === 'rules' ? (__VLS_ctx.leftOpen = false) : ((__VLS_ctx.activeView = 'rules'), (__VLS_ctx.leftOpen = true), __VLS_ctx.loadRules(), __VLS_ctx.loadDenials()));
            // @ts-ignore
            [leftOpen, leftOpen, leftOpen, leftOpen, activeView, activeView, activeView, chatUnread, loadRules, loadDenials,];
        } },
    ...{ class: "activity-item" },
    ...{ class: ({ active: __VLS_ctx.leftOpen && __VLS_ctx.activeView === 'rules' }) },
    title: "命令权限规则",
});
/** @type {__VLS_StyleScopedClasses['activity-item']} */ ;
/** @type {__VLS_StyleScopedClasses['active']} */ ;
let __VLS_28;
/** @ts-ignore @type { | typeof __VLS_components.IconShieldLock} */
IconShieldLock;
// @ts-ignore
const __VLS_29 = __VLS_asFunctionalComponent1(__VLS_28, new __VLS_28({
    size: (21),
    strokeWidth: (1.75),
}));
const __VLS_30 = __VLS_29({
    size: (21),
    strokeWidth: (1.75),
}, ...__VLS_functionalComponentArgsRest(__VLS_29));
if (__VLS_ctx.permRules.length) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "activity-count mono" },
    });
    /** @type {__VLS_StyleScopedClasses['activity-count']} */ ;
    /** @type {__VLS_StyleScopedClasses['mono']} */ ;
    (__VLS_ctx.permRules.length);
}
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (...[$event]) => {
            return (__VLS_ctx.rightOpen = !__VLS_ctx.rightOpen);
            // @ts-ignore
            [leftOpen, activeView, permRules, permRules, rightOpen, rightOpen,];
        } },
    ...{ class: "activity-item" },
    ...{ class: ({ active: __VLS_ctx.rightOpen }) },
    title: "任务看板",
});
/** @type {__VLS_StyleScopedClasses['activity-item']} */ ;
/** @type {__VLS_StyleScopedClasses['active']} */ ;
let __VLS_33;
/** @ts-ignore @type { | typeof __VLS_components.IconLayoutKanban} */
IconLayoutKanban;
// @ts-ignore
const __VLS_34 = __VLS_asFunctionalComponent1(__VLS_33, new __VLS_33({
    size: (21),
    strokeWidth: (1.75),
}));
const __VLS_35 = __VLS_34({
    size: (21),
    strokeWidth: (1.75),
}, ...__VLS_functionalComponentArgsRest(__VLS_34));
__VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
    ...{ onClick: (...[$event]) => {
            return (__VLS_ctx.logOpen = !__VLS_ctx.logOpen);
            // @ts-ignore
            [rightOpen, logOpen, logOpen,];
        } },
    ...{ class: "activity-item" },
    ...{ class: ({ active: __VLS_ctx.logOpen }) },
    title: "执行日志",
});
/** @type {__VLS_StyleScopedClasses['activity-item']} */ ;
/** @type {__VLS_StyleScopedClasses['active']} */ ;
let __VLS_38;
/** @ts-ignore @type { | typeof __VLS_components.IconTerminal} */
IconTerminal;
// @ts-ignore
const __VLS_39 = __VLS_asFunctionalComponent1(__VLS_38, new __VLS_38({
    size: (21),
    strokeWidth: (1.75),
}));
const __VLS_40 = __VLS_39({
    size: (21),
    strokeWidth: (1.75),
}, ...__VLS_functionalComponentArgsRest(__VLS_39));
__VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
    ...{ class: "ab-progress mono" },
    title: "完工任务 / 全部",
});
/** @type {__VLS_StyleScopedClasses['ab-progress']} */ ;
/** @type {__VLS_StyleScopedClasses['mono']} */ ;
(__VLS_ctx.overallProgress);
if (__VLS_ctx.leftOpen) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.aside, __VLS_intrinsics.aside)({
        ...{ class: "sidebar" },
        ...{ style: ({ width: __VLS_ctx.sidebarWidth + 'px' }) },
    });
    /** @type {__VLS_StyleScopedClasses['sidebar']} */ ;
    if (__VLS_ctx.activeView === 'files') {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "side-head" },
        });
        /** @type {__VLS_StyleScopedClasses['side-head']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "side-count" },
        });
        /** @type {__VLS_StyleScopedClasses['side-count']} */ ;
        (__VLS_ctx.fileCount);
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "side-scroll" },
        });
        /** @type {__VLS_StyleScopedClasses['side-scroll']} */ ;
        const __VLS_43 = FileTree;
        // @ts-ignore
        const __VLS_44 = __VLS_asFunctionalComponent1(__VLS_43, new __VLS_43({
            ...{ 'onOpen': {} },
            nodes: (__VLS_ctx.fileTree),
            activePath: (__VLS_ctx.activeFile?.path),
        }));
        const __VLS_45 = __VLS_44({
            ...{ 'onOpen': {} },
            nodes: (__VLS_ctx.fileTree),
            activePath: (__VLS_ctx.activeFile?.path),
        }, ...__VLS_functionalComponentArgsRest(__VLS_44));
        let __VLS_48;
        const __VLS_49 = {
            /** @type {typeof __VLS_48.open} */
            onOpen: (__VLS_ctx.openFile),
        };
        var __VLS_46;
        var __VLS_47;
    }
    else if (__VLS_ctx.activeView === 'rules') {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "side-head" },
        });
        /** @type {__VLS_StyleScopedClasses['side-head']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "side-count" },
        });
        /** @type {__VLS_StyleScopedClasses['side-count']} */ ;
        (__VLS_ctx.permRules.filter((r) => r.enabled === 1).length);
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "side-scroll rules-panel" },
        });
        /** @type {__VLS_StyleScopedClasses['side-scroll']} */ ;
        /** @type {__VLS_StyleScopedClasses['rules-panel']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "rules-mode" },
        });
        /** @type {__VLS_StyleScopedClasses['rules-mode']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "lamp" },
            ...{ class: ('lamp-' + __VLS_ctx.MODES[__VLS_ctx.confirmMode]?.tone) },
        });
        /** @type {__VLS_StyleScopedClasses['lamp']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.b, __VLS_intrinsics.b)({});
        (__VLS_ctx.MODES[__VLS_ctx.confirmMode]?.label);
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "faint" },
        });
        /** @type {__VLS_StyleScopedClasses['faint']} */ ;
        (__VLS_ctx.permModeHint);
        if (!__VLS_ctx.permRules.length) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
                ...{ class: "rules-empty faint" },
            });
            /** @type {__VLS_StyleScopedClasses['rules-empty']} */ ;
            /** @type {__VLS_StyleScopedClasses['faint']} */ ;
        }
        for (const [r] of __VLS_vFor((__VLS_ctx.permRules.filter((x) => x.enabled === 1)))) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                key: (r.id),
                ...{ class: "rule-row" },
            });
            /** @type {__VLS_StyleScopedClasses['rule-row']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "rule-line" },
            });
            /** @type {__VLS_StyleScopedClasses['rule-line']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "rule-beh" },
                ...{ class: ('beh-' + r.behavior) },
            });
            /** @type {__VLS_StyleScopedClasses['rule-beh']} */ ;
            (__VLS_ctx.permBehaviorLabel(r.behavior));
            __VLS_asFunctionalElement1(__VLS_intrinsics.code, __VLS_intrinsics.code)({
                ...{ class: "rule-text mono" },
            });
            /** @type {__VLS_StyleScopedClasses['rule-text']} */ ;
            /** @type {__VLS_StyleScopedClasses['mono']} */ ;
            (r.ruleContent || '*');
            __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
                ...{ onClick: (...[$event]) => {
                        if (!(__VLS_ctx.leftOpen))
                            throw 0;
                        if (!!(__VLS_ctx.activeView === 'files'))
                            throw 0;
                        if (!(__VLS_ctx.activeView === 'rules'))
                            throw 0;
                        return (__VLS_ctx.disableRule(r.id));
                        // @ts-ignore
                        [leftOpen, activeView, activeView, permRules, permRules, permRules, logOpen, overallProgress, sidebarWidth, fileCount, fileTree, activeFile, openFile, MODES, MODES, confirmMode, confirmMode, permModeHint, permBehaviorLabel, disableRule,];
                    } },
                ...{ class: "rule-x btn btn-sm btn-ghost" },
                title: "删除这条规则（不再展示；库里留档）",
            });
            /** @type {__VLS_StyleScopedClasses['rule-x']} */ ;
            /** @type {__VLS_StyleScopedClasses['btn']} */ ;
            /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
            /** @type {__VLS_StyleScopedClasses['btn-ghost']} */ ;
            let __VLS_50;
            /** @ts-ignore @type { | typeof __VLS_components.IconX} */
            IconX;
            // @ts-ignore
            const __VLS_51 = __VLS_asFunctionalComponent1(__VLS_50, new __VLS_50({
                size: (12),
                strokeWidth: (1.75),
            }));
            const __VLS_52 = __VLS_51({
                size: (12),
                strokeWidth: (1.75),
            }, ...__VLS_functionalComponentArgsRest(__VLS_51));
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "rule-meta faint" },
            });
            /** @type {__VLS_StyleScopedClasses['rule-meta']} */ ;
            /** @type {__VLS_StyleScopedClasses['faint']} */ ;
            (__VLS_ctx.permSourceLabel(r.source));
            (r.projectId === 0 ? '全局（跨项目）' : '本项目');
            if (r.note) {
                (r.note);
            }
            // @ts-ignore
            [permSourceLabel,];
        }
        if (__VLS_ctx.permDenials.length) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "rules-denials" },
            });
            /** @type {__VLS_StyleScopedClasses['rules-denials']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "rules-sub" },
            });
            /** @type {__VLS_StyleScopedClasses['rules-sub']} */ ;
            (__VLS_ctx.permDenials.length);
            for (const [d, i] of __VLS_vFor((__VLS_ctx.permDenials))) {
                __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                    key: (i),
                    ...{ class: "denial-row" },
                });
                /** @type {__VLS_StyleScopedClasses['denial-row']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.code, __VLS_intrinsics.code)({
                    ...{ class: "mono faint" },
                });
                /** @type {__VLS_StyleScopedClasses['mono']} */ ;
                /** @type {__VLS_StyleScopedClasses['faint']} */ ;
                (d.command || d.question);
                // @ts-ignore
                [permDenials, permDenials, permDenials,];
            }
        }
    }
    else {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "side-head" },
        });
        /** @type {__VLS_StyleScopedClasses['side-head']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "side-count" },
        });
        /** @type {__VLS_StyleScopedClasses['side-count']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "mode-selector" },
        });
        /** @type {__VLS_StyleScopedClasses['mode-selector']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "mode-label" },
        });
        /** @type {__VLS_StyleScopedClasses['mode-label']} */ ;
        let __VLS_55;
        /** @ts-ignore @type { | typeof __VLS_components.IconClock} */
        IconClock;
        // @ts-ignore
        const __VLS_56 = __VLS_asFunctionalComponent1(__VLS_55, new __VLS_55({
            size: (13),
            strokeWidth: (1.75),
        }));
        const __VLS_57 = __VLS_56({
            size: (13),
            strokeWidth: (1.75),
        }, ...__VLS_functionalComponentArgsRest(__VLS_56));
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "mode-options" },
        });
        /** @type {__VLS_StyleScopedClasses['mode-options']} */ ;
        for (const [m] of __VLS_vFor((__VLS_ctx.MODES))) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
                ...{ onClick: (...[$event]) => {
                        if (!(__VLS_ctx.leftOpen))
                            throw 0;
                        if (!!(__VLS_ctx.activeView === 'files'))
                            throw 0;
                        if (!!(__VLS_ctx.activeView === 'rules'))
                            throw 0;
                        return (__VLS_ctx.setMode(m.value));
                        // @ts-ignore
                        [MODES, setMode,];
                    } },
                key: (m.value),
                ...{ class: "mode-btn" },
                ...{ class: ({ active: __VLS_ctx.confirmMode === m.value }) },
                title: (m.desc),
            });
            /** @type {__VLS_StyleScopedClasses['mode-btn']} */ ;
            /** @type {__VLS_StyleScopedClasses['active']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "lamp" },
                ...{ class: ('lamp-' + m.tone) },
            });
            /** @type {__VLS_StyleScopedClasses['lamp']} */ ;
            (m.label);
            // @ts-ignore
            [confirmMode,];
        }
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "mode-hint faint" },
        });
        /** @type {__VLS_StyleScopedClasses['mode-hint']} */ ;
        /** @type {__VLS_StyleScopedClasses['faint']} */ ;
        (__VLS_ctx.MODES[__VLS_ctx.confirmMode]?.desc);
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "chat-body" },
        });
        /** @type {__VLS_StyleScopedClasses['chat-body']} */ ;
        for (const [m, i] of __VLS_vFor((__VLS_ctx.chatMessages))) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                key: (i),
                ...{ class: "msg" },
                ...{ class: (m.role) },
            });
            /** @type {__VLS_StyleScopedClasses['msg']} */ ;
            if (m.role === 'assistant') {
                __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                    ...{ class: "msg-avatar" },
                });
                /** @type {__VLS_StyleScopedClasses['msg-avatar']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.img)({
                    src: "../assets/agent-manager.png",
                    alt: "Hina",
                });
            }
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "msg-bubble" },
            });
            /** @type {__VLS_StyleScopedClasses['msg-bubble']} */ ;
            (m.content);
            // @ts-ignore
            [MODES, confirmMode, chatMessages,];
        }
        if (__VLS_ctx.chatThinking) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "msg assistant" },
            });
            /** @type {__VLS_StyleScopedClasses['msg']} */ ;
            /** @type {__VLS_StyleScopedClasses['assistant']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "msg-avatar" },
            });
            /** @type {__VLS_StyleScopedClasses['msg-avatar']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.img)({
                src: "../assets/agent-manager.png",
                alt: "Hina",
            });
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
        if (__VLS_ctx.pendingConfirms.length && __VLS_ctx.pendingConfirms[0].kind === 'permission') {
            const __VLS_60 = PermissionRequestCard;
            // @ts-ignore
            const __VLS_61 = __VLS_asFunctionalComponent1(__VLS_60, new __VLS_60({
                ...{ 'onDecide': {} },
                req: (__VLS_ctx.pendingConfirms[0]),
                busy: (__VLS_ctx.confirmBusy),
                countdown: (__VLS_ctx.permCountdown(__VLS_ctx.pendingConfirms[0].expireAt)),
            }));
            const __VLS_62 = __VLS_61({
                ...{ 'onDecide': {} },
                req: (__VLS_ctx.pendingConfirms[0]),
                busy: (__VLS_ctx.confirmBusy),
                countdown: (__VLS_ctx.permCountdown(__VLS_ctx.pendingConfirms[0].expireAt)),
            }, ...__VLS_functionalComponentArgsRest(__VLS_61));
            let __VLS_65;
            const __VLS_66 = {
                /** @type {typeof __VLS_65.decide} */
                onDecide: (__VLS_ctx.submitPermission),
            };
            var __VLS_63;
            var __VLS_64;
        }
        else if (__VLS_ctx.pendingConfirms.length) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "msg assistant" },
            });
            /** @type {__VLS_StyleScopedClasses['msg']} */ ;
            /** @type {__VLS_StyleScopedClasses['assistant']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "msg-avatar" },
            });
            /** @type {__VLS_StyleScopedClasses['msg-avatar']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.img)({
                src: "../assets/agent-manager.png",
                alt: "Hina",
            });
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ class: "msg-bubble" },
            });
            /** @type {__VLS_StyleScopedClasses['msg-bubble']} */ ;
            (__VLS_ctx.pendingConfirms[0].question);
            if (__VLS_ctx.parseOptions(__VLS_ctx.pendingConfirms[0]).length) {
                __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                    ...{ class: "chat-opts" },
                });
                /** @type {__VLS_StyleScopedClasses['chat-opts']} */ ;
                for (const [opt] of __VLS_vFor((__VLS_ctx.parseOptions(__VLS_ctx.pendingConfirms[0])))) {
                    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
                        ...{ onClick: (...[$event]) => {
                                if (!(__VLS_ctx.leftOpen))
                                    throw 0;
                                if (!!(__VLS_ctx.activeView === 'files'))
                                    throw 0;
                                if (!!(__VLS_ctx.activeView === 'rules'))
                                    throw 0;
                                if (!!(__VLS_ctx.pendingConfirms.length && __VLS_ctx.pendingConfirms[0].kind === 'permission'))
                                    throw 0;
                                if (!(__VLS_ctx.pendingConfirms.length))
                                    throw 0;
                                if (!(__VLS_ctx.parseOptions(__VLS_ctx.pendingConfirms[0]).length))
                                    throw 0;
                                return (__VLS_ctx.submitConfirm(opt));
                                // @ts-ignore
                                [chatThinking, pendingConfirms, pendingConfirms, pendingConfirms, pendingConfirms, pendingConfirms, pendingConfirms, pendingConfirms, pendingConfirms, confirmBusy, permCountdown, submitPermission, parseOptions, parseOptions, submitConfirm,];
                            } },
                        key: (opt),
                        ...{ class: "btn btn-sm" },
                        disabled: (__VLS_ctx.confirmBusy),
                    });
                    /** @type {__VLS_StyleScopedClasses['btn']} */ ;
                    /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
                    (opt);
                    // @ts-ignore
                    [confirmBusy,];
                }
            }
            else {
                __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                    ...{ class: "chat-free" },
                });
                /** @type {__VLS_StyleScopedClasses['chat-free']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.input)({
                    ...{ onKeyup: (...[$event]) => {
                            if (!(__VLS_ctx.leftOpen))
                                throw 0;
                            if (!!(__VLS_ctx.activeView === 'files'))
                                throw 0;
                            if (!!(__VLS_ctx.activeView === 'rules'))
                                throw 0;
                            if (!!(__VLS_ctx.pendingConfirms.length && __VLS_ctx.pendingConfirms[0].kind === 'permission'))
                                throw 0;
                            if (!(__VLS_ctx.pendingConfirms.length))
                                throw 0;
                            if (!!(__VLS_ctx.parseOptions(__VLS_ctx.pendingConfirms[0]).length))
                                throw 0;
                            return (__VLS_ctx.confirmText.trim() && __VLS_ctx.submitConfirm(__VLS_ctx.confirmText.trim()));
                            // @ts-ignore
                            [submitConfirm, confirmText, confirmText,];
                        } },
                    value: (__VLS_ctx.confirmText),
                    ...{ class: "input" },
                    type: "text",
                    placeholder: "输入回复…",
                    disabled: (__VLS_ctx.confirmBusy),
                });
                /** @type {__VLS_StyleScopedClasses['input']} */ ;
                __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
                    ...{ onClick: (...[$event]) => {
                            if (!(__VLS_ctx.leftOpen))
                                throw 0;
                            if (!!(__VLS_ctx.activeView === 'files'))
                                throw 0;
                            if (!!(__VLS_ctx.activeView === 'rules'))
                                throw 0;
                            if (!!(__VLS_ctx.pendingConfirms.length && __VLS_ctx.pendingConfirms[0].kind === 'permission'))
                                throw 0;
                            if (!(__VLS_ctx.pendingConfirms.length))
                                throw 0;
                            if (!!(__VLS_ctx.parseOptions(__VLS_ctx.pendingConfirms[0]).length))
                                throw 0;
                            return (__VLS_ctx.submitConfirm(__VLS_ctx.confirmText.trim()));
                            // @ts-ignore
                            [confirmBusy, submitConfirm, confirmText, confirmText,];
                        } },
                    ...{ class: "btn btn-sm btn-primary" },
                    disabled: (__VLS_ctx.confirmBusy || !__VLS_ctx.confirmText.trim()),
                });
                /** @type {__VLS_StyleScopedClasses['btn']} */ ;
                /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
                /** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
            }
        }
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "chat-input" },
        });
        /** @type {__VLS_StyleScopedClasses['chat-input']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.textarea, __VLS_intrinsics.textarea)({
            ...{ onKeydown: (__VLS_ctx.sendChat) },
            value: (__VLS_ctx.chatDraft),
            ...{ class: "textarea" },
            rows: "2",
            placeholder: "问项目经理：进度、代码、下一步...",
        });
        /** @type {__VLS_StyleScopedClasses['textarea']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (__VLS_ctx.sendChat) },
            ...{ class: "btn btn-primary btn-send" },
            disabled: (!__VLS_ctx.chatDraft.trim() || __VLS_ctx.chatThinking),
        });
        /** @type {__VLS_StyleScopedClasses['btn']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-send']} */ ;
        let __VLS_67;
        /** @ts-ignore @type { | typeof __VLS_components.IconSend} */
        IconSend;
        // @ts-ignore
        const __VLS_68 = __VLS_asFunctionalComponent1(__VLS_67, new __VLS_67({
            size: (15),
            strokeWidth: (1.75),
        }));
        const __VLS_69 = __VLS_68({
            size: (15),
            strokeWidth: (1.75),
        }, ...__VLS_functionalComponentArgsRest(__VLS_68));
    }
}
if (__VLS_ctx.leftOpen) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ onMousedown: (...[$event]) => {
                if (!(__VLS_ctx.leftOpen))
                    throw 0;
                return (__VLS_ctx.startDrag($event, 'x', 'left'));
                // @ts-ignore
                [leftOpen, chatThinking, confirmBusy, confirmText, sendChat, sendChat, chatDraft, chatDraft, startDrag,];
            } },
        ...{ class: "resize-handle v" },
        title: "拖拽调整宽度",
    });
    /** @type {__VLS_StyleScopedClasses['resize-handle']} */ ;
    /** @type {__VLS_StyleScopedClasses['v']} */ ;
}
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "editor-area" },
});
/** @type {__VLS_StyleScopedClasses['editor-area']} */ ;
if (__VLS_ctx.tabs.length) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "tabs" },
    });
    /** @type {__VLS_StyleScopedClasses['tabs']} */ ;
    for (const [t] of __VLS_vFor((__VLS_ctx.tabs))) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.tabs.length))
                        throw 0;
                    return (__VLS_ctx.activeFile = t);
                    // @ts-ignore
                    [activeFile, tabs, tabs,];
                } },
            key: (t.path),
            ...{ class: "tab" },
            ...{ class: ({ active: __VLS_ctx.activeFile?.path === t.path }) },
        });
        /** @type {__VLS_StyleScopedClasses['tab']} */ ;
        /** @type {__VLS_StyleScopedClasses['active']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "tab-ext mono" },
            ...{ class: (__VLS_ctx.extToneClass(t.path)) },
        });
        /** @type {__VLS_StyleScopedClasses['tab-ext']} */ ;
        /** @type {__VLS_StyleScopedClasses['mono']} */ ;
        (__VLS_ctx.tabExt(t.path));
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "tab-name" },
        });
        /** @type {__VLS_StyleScopedClasses['tab-name']} */ ;
        (__VLS_ctx.tabName(t.path));
        if (t.userModified) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "tab-modified" },
                title: "已手动修改",
            });
            /** @type {__VLS_StyleScopedClasses['tab-modified']} */ ;
        }
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.tabs.length))
                        throw 0;
                    return (__VLS_ctx.closeTab(t.path));
                    // @ts-ignore
                    [activeFile, extToneClass, tabExt, tabName, closeTab,];
                } },
            ...{ class: "tab-close" },
            'aria-label': "关闭",
        });
        /** @type {__VLS_StyleScopedClasses['tab-close']} */ ;
        let __VLS_72;
        /** @ts-ignore @type { | typeof __VLS_components.IconX} */
        IconX;
        // @ts-ignore
        const __VLS_73 = __VLS_asFunctionalComponent1(__VLS_72, new __VLS_72({
            size: (12),
            strokeWidth: (1.75),
        }));
        const __VLS_74 = __VLS_73({
            size: (12),
            strokeWidth: (1.75),
        }, ...__VLS_functionalComponentArgsRest(__VLS_73));
        // @ts-ignore
        [];
    }
}
__VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
    ...{ class: "editor-wrap" },
});
/** @type {__VLS_StyleScopedClasses['editor-wrap']} */ ;
if (__VLS_ctx.activeFile) {
    const __VLS_77 = MonacoEditor;
    // @ts-ignore
    const __VLS_78 = __VLS_asFunctionalComponent1(__VLS_77, new __VLS_77({
        ...{ 'onChange': {} },
        ...{ 'onSave': {} },
        key: (__VLS_ctx.activeFile.path),
        language: (__VLS_ctx.langFor(__VLS_ctx.activeFile.path)),
        value: (__VLS_ctx.activeFile.content || ''),
        theme: "vs-dark",
    }));
    const __VLS_79 = __VLS_78({
        ...{ 'onChange': {} },
        ...{ 'onSave': {} },
        key: (__VLS_ctx.activeFile.path),
        language: (__VLS_ctx.langFor(__VLS_ctx.activeFile.path)),
        value: (__VLS_ctx.activeFile.content || ''),
        theme: "vs-dark",
    }, ...__VLS_functionalComponentArgsRest(__VLS_78));
    let __VLS_82;
    const __VLS_83 = {
        /** @type {typeof __VLS_82.change} */
        onChange: (__VLS_ctx.onUserEdit),
    };
    const __VLS_84 = {
        /** @type {typeof __VLS_82.save} */
        onSave: (__VLS_ctx.onSave),
    };
    var __VLS_80;
    var __VLS_81;
}
else {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "editor-empty" },
    });
    /** @type {__VLS_StyleScopedClasses['editor-empty']} */ ;
    let __VLS_85;
    /** @ts-ignore @type { | typeof __VLS_components.IconCode} */
    IconCode;
    // @ts-ignore
    const __VLS_86 = __VLS_asFunctionalComponent1(__VLS_85, new __VLS_85({
        size: (42),
        strokeWidth: (1.2),
        ...{ class: "ee-ico" },
    }));
    const __VLS_87 = __VLS_86({
        size: (42),
        strokeWidth: (1.2),
        ...{ class: "ee-ico" },
    }, ...__VLS_functionalComponentArgsRest(__VLS_86));
    /** @type {__VLS_StyleScopedClasses['ee-ico']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({});
    __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
        ...{ class: "faint" },
    });
    /** @type {__VLS_StyleScopedClasses['faint']} */ ;
}
if (__VLS_ctx.rightOpen) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ onMousedown: (...[$event]) => {
                if (!(__VLS_ctx.rightOpen))
                    throw 0;
                return (__VLS_ctx.startDrag($event, 'x', 'right'));
                // @ts-ignore
                [rightOpen, activeFile, activeFile, activeFile, activeFile, startDrag, langFor, onUserEdit, onSave,];
            } },
        ...{ class: "resize-handle v" },
        title: "拖拽调整宽度",
    });
    /** @type {__VLS_StyleScopedClasses['resize-handle']} */ ;
    /** @type {__VLS_StyleScopedClasses['v']} */ ;
}
if (__VLS_ctx.rightOpen) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.aside, __VLS_intrinsics.aside)({
        ...{ class: "rightbar" },
        ...{ style: ({ width: __VLS_ctx.rightbarWidth + 'px' }) },
    });
    /** @type {__VLS_StyleScopedClasses['rightbar']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "side-head" },
    });
    /** @type {__VLS_StyleScopedClasses['side-head']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "side-count" },
    });
    /** @type {__VLS_StyleScopedClasses['side-count']} */ ;
    (__VLS_ctx.tasks.length);
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "quality-card" },
    });
    /** @type {__VLS_StyleScopedClasses['quality-card']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "qc-head" },
    });
    /** @type {__VLS_StyleScopedClasses['qc-head']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
    __VLS_asFunctionalElement1(__VLS_intrinsics.strong, __VLS_intrinsics.strong)({});
    (__VLS_ctx.qualitySummary.firstPassRate);
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "qc-meta" },
    });
    /** @type {__VLS_StyleScopedClasses['qc-meta']} */ ;
    (__VLS_ctx.qualitySummary.passed);
    (__VLS_ctx.qualitySummary.failed);
    (__VLS_ctx.qualitySummary.totalRetries);
    if (__VLS_ctx.qualitySummary.failureCategories.length) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "qc-failures" },
        });
        /** @type {__VLS_StyleScopedClasses['qc-failures']} */ ;
        for (const [item] of __VLS_vFor((__VLS_ctx.qualitySummary.failureCategories.slice(0, 3)))) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                key: (item.label),
                ...{ class: "mono" },
            });
            /** @type {__VLS_StyleScopedClasses['mono']} */ ;
            (item.label);
            (item.count);
            // @ts-ignore
            [qualitySummary, qualitySummary, qualitySummary, qualitySummary, qualitySummary, qualitySummary, rightOpen, rightbarWidth, tasks,];
        }
    }
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "kanban" },
    });
    /** @type {__VLS_StyleScopedClasses['kanban']} */ ;
    for (const [col] of __VLS_vFor(['todo', 'doing', 'done', 'failed'])) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            key: (col),
            ...{ class: "kanban-col" },
        });
        /** @type {__VLS_StyleScopedClasses['kanban-col']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.rightOpen))
                        throw 0;
                    return (__VLS_ctx.toggleCol(col));
                    // @ts-ignore
                    [toggleCol,];
                } },
            ...{ class: "kanban-col-head" },
        });
        /** @type {__VLS_StyleScopedClasses['kanban-col-head']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "kb-dot" },
            ...{ class: ('dot-' + __VLS_ctx.TASK_STATUS[col].tone) },
        });
        /** @type {__VLS_StyleScopedClasses['kb-dot']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({});
        (__VLS_ctx.TASK_STATUS[col].label);
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "kanban-count mono" },
        });
        /** @type {__VLS_StyleScopedClasses['kanban-count']} */ ;
        /** @type {__VLS_StyleScopedClasses['mono']} */ ;
        (__VLS_ctx.taskCount(col));
        let __VLS_90;
        /** @ts-ignore @type { | typeof __VLS_components.IconChevronDown} */
        IconChevronDown;
        // @ts-ignore
        const __VLS_91 = __VLS_asFunctionalComponent1(__VLS_90, new __VLS_90({
            size: (14),
            strokeWidth: (1.75),
            ...{ class: "kb-arrow" },
            ...{ class: ({ collapsed: __VLS_ctx.collapsedCols.has(col) }) },
        }));
        const __VLS_92 = __VLS_91({
            size: (14),
            strokeWidth: (1.75),
            ...{ class: "kb-arrow" },
            ...{ class: ({ collapsed: __VLS_ctx.collapsedCols.has(col) }) },
        }, ...__VLS_functionalComponentArgsRest(__VLS_91));
        /** @type {__VLS_StyleScopedClasses['kb-arrow']} */ ;
        /** @type {__VLS_StyleScopedClasses['collapsed']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "kanban-list" },
        });
        __VLS_asFunctionalDirective(__VLS_directives.vShow, {})(null, { ...__VLS_directiveBindingRestFields, value: (!__VLS_ctx.collapsedCols.has(col)), }, null, null);
        /** @type {__VLS_StyleScopedClasses['kanban-list']} */ ;
        for (const [t] of __VLS_vFor((__VLS_ctx.tasksBy(col)))) {
            __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
                ...{ onClick: (...[$event]) => {
                        if (!(__VLS_ctx.rightOpen))
                            throw 0;
                        return (__VLS_ctx.openTaskDetail(t));
                        // @ts-ignore
                        [TASK_STATUS, TASK_STATUS, taskCount, collapsedCols, collapsedCols, tasksBy, openTaskDetail,];
                    } },
                key: (t.id),
                ...{ class: "kanban-card" },
                ...{ class: (col) },
            });
            /** @type {__VLS_StyleScopedClasses['kanban-card']} */ ;
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "kanban-title" },
            });
            /** @type {__VLS_StyleScopedClasses['kanban-title']} */ ;
            (t.title);
            __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
                ...{ class: "kanban-assignee faint" },
            });
            /** @type {__VLS_StyleScopedClasses['kanban-assignee']} */ ;
            /** @type {__VLS_StyleScopedClasses['faint']} */ ;
            (t.assignee);
            if (col === 'failed') {
                __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
                    ...{ onClick: (...[$event]) => {
                            if (!(__VLS_ctx.rightOpen))
                                throw 0;
                            if (!(col === 'failed'))
                                throw 0;
                            return (__VLS_ctx.retryTask(t));
                            // @ts-ignore
                            [retryTask,];
                        } },
                    ...{ class: "kanban-retry" },
                    title: "重跑",
                });
                /** @type {__VLS_StyleScopedClasses['kanban-retry']} */ ;
                let __VLS_95;
                /** @ts-ignore @type { | typeof __VLS_components.IconRefresh} */
                IconRefresh;
                // @ts-ignore
                const __VLS_96 = __VLS_asFunctionalComponent1(__VLS_95, new __VLS_95({
                    size: (13),
                    strokeWidth: (1.75),
                }));
                const __VLS_97 = __VLS_96({
                    size: (13),
                    strokeWidth: (1.75),
                }, ...__VLS_functionalComponentArgsRest(__VLS_96));
            }
            // @ts-ignore
            [];
        }
        // @ts-ignore
        [];
    }
}
if (__VLS_ctx.taskDetail) {
    const __VLS_100 = AppModal || AppModal;
    // @ts-ignore
    const __VLS_101 = __VLS_asFunctionalComponent1(__VLS_100, new __VLS_100({
        ...{ 'onClose': {} },
        title: (__VLS_ctx.taskDetail.title),
        sheet: "TASK·DETAIL",
        tone: "dark",
        width: "640px",
    }));
    const __VLS_102 = __VLS_101({
        ...{ 'onClose': {} },
        title: (__VLS_ctx.taskDetail.title),
        sheet: "TASK·DETAIL",
        tone: "dark",
        width: "640px",
    }, ...__VLS_functionalComponentArgsRest(__VLS_101));
    let __VLS_105;
    const __VLS_106 = {
        /** @type {typeof __VLS_105.close} */
        onClose: (...[$event]) => {
            if (!(__VLS_ctx.taskDetail))
                throw 0;
            return (__VLS_ctx.taskDetail = null);
            // @ts-ignore
            [taskDetail, taskDetail, taskDetail,];
        },
    };
    const { default: __VLS_107 } = __VLS_103.slots;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "detail-grid tblock" },
    });
    /** @type {__VLS_StyleScopedClasses['detail-grid']} */ ;
    /** @type {__VLS_StyleScopedClasses['tblock']} */ ;
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
    (__VLS_ctx.taskDetail.taskIdExt || __VLS_ctx.taskDetail.id);
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
    const __VLS_108 = StampSeal;
    // @ts-ignore
    const __VLS_109 = __VLS_asFunctionalComponent1(__VLS_108, new __VLS_108({
        label: (__VLS_ctx.taskStatusLabel(__VLS_ctx.taskDetail.status)),
        tone: (__VLS_ctx.taskTone(__VLS_ctx.taskDetail.status)),
    }));
    const __VLS_110 = __VLS_109({
        label: (__VLS_ctx.taskStatusLabel(__VLS_ctx.taskDetail.status)),
        tone: (__VLS_ctx.taskTone(__VLS_ctx.taskDetail.status)),
    }, ...__VLS_functionalComponentArgsRest(__VLS_109));
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
    (__VLS_ctx.taskDetail.assignee || '-');
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
    (__VLS_ctx.taskDetail.layer === 'backend' ? '后端' : __VLS_ctx.taskDetail.layer === 'frontend' ? '前端' : '-');
    if (__VLS_ctx.taskDetail.phaseId) {
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
        (__VLS_ctx.taskDetail.phaseId);
    }
    if (__VLS_ctx.taskDetail.retryCount > 0) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "tblock-cell" },
        });
        /** @type {__VLS_StyleScopedClasses['tblock-cell']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "tblock-key" },
        });
        /** @type {__VLS_StyleScopedClasses['tblock-key']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "tblock-val mono wait-txt" },
        });
        /** @type {__VLS_StyleScopedClasses['tblock-val']} */ ;
        /** @type {__VLS_StyleScopedClasses['mono']} */ ;
        /** @type {__VLS_StyleScopedClasses['wait-txt']} */ ;
        (__VLS_ctx.taskDetail.retryCount);
    }
    if (__VLS_ctx.taskDetail.description) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "detail-section" },
        });
        /** @type {__VLS_StyleScopedClasses['detail-section']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "ds-label faint" },
        });
        /** @type {__VLS_StyleScopedClasses['ds-label']} */ ;
        /** @type {__VLS_StyleScopedClasses['faint']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
            ...{ class: "detail-text" },
        });
        /** @type {__VLS_StyleScopedClasses['detail-text']} */ ;
        (__VLS_ctx.taskDetail.description);
    }
    if (__VLS_ctx.taskDetail.acceptance) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "detail-section" },
        });
        /** @type {__VLS_StyleScopedClasses['detail-section']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "ds-label faint" },
        });
        /** @type {__VLS_StyleScopedClasses['ds-label']} */ ;
        /** @type {__VLS_StyleScopedClasses['faint']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
            ...{ class: "detail-text" },
        });
        /** @type {__VLS_StyleScopedClasses['detail-text']} */ ;
        (__VLS_ctx.taskDetail.acceptance);
    }
    if (__VLS_ctx.taskDetail.result) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "detail-section" },
        });
        /** @type {__VLS_StyleScopedClasses['detail-section']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "ds-label faint" },
        });
        /** @type {__VLS_StyleScopedClasses['ds-label']} */ ;
        /** @type {__VLS_StyleScopedClasses['faint']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
            ...{ class: "detail-text result mono" },
        });
        /** @type {__VLS_StyleScopedClasses['detail-text']} */ ;
        /** @type {__VLS_StyleScopedClasses['result']} */ ;
        /** @type {__VLS_StyleScopedClasses['mono']} */ ;
        (__VLS_ctx.taskDetail.result);
    }
    if (__VLS_ctx.taskDetail.errorMsg) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            ...{ class: "detail-section" },
        });
        /** @type {__VLS_StyleScopedClasses['detail-section']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "ds-label err" },
        });
        /** @type {__VLS_StyleScopedClasses['ds-label']} */ ;
        /** @type {__VLS_StyleScopedClasses['err']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.p, __VLS_intrinsics.p)({
            ...{ class: "detail-text error" },
        });
        /** @type {__VLS_StyleScopedClasses['detail-text']} */ ;
        /** @type {__VLS_StyleScopedClasses['error']} */ ;
        (__VLS_ctx.taskDetail.errorMsg);
    }
    {
        const { footer: __VLS_113 } = __VLS_103.slots;
        __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
            ...{ onClick: (...[$event]) => {
                    if (!(__VLS_ctx.taskDetail))
                        throw 0;
                    return (__VLS_ctx.taskDetail = null);
                    // @ts-ignore
                    [taskDetail, taskDetail, taskDetail, taskDetail, taskDetail, taskDetail, taskDetail, taskDetail, taskDetail, taskDetail, taskDetail, taskDetail, taskDetail, taskDetail, taskDetail, taskDetail, taskDetail, taskDetail, taskDetail, taskDetail, taskStatusLabel, taskTone,];
                } },
            ...{ class: "btn btn-sm" },
        });
        /** @type {__VLS_StyleScopedClasses['btn']} */ ;
        /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
        if (__VLS_ctx.taskDetail.status === 'failed') {
            __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
                ...{ onClick: (...[$event]) => {
                        if (!(__VLS_ctx.taskDetail))
                            throw 0;
                        if (!(__VLS_ctx.taskDetail.status === 'failed'))
                            throw 0;
                        __VLS_ctx.retryTask(__VLS_ctx.taskDetail);
                        __VLS_ctx.taskDetail = null;
                        // @ts-ignore
                        [retryTask, taskDetail, taskDetail, taskDetail,];
                    } },
                ...{ class: "btn btn-sm btn-primary" },
            });
            /** @type {__VLS_StyleScopedClasses['btn']} */ ;
            /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
            /** @type {__VLS_StyleScopedClasses['btn-primary']} */ ;
            let __VLS_114;
            /** @ts-ignore @type { | typeof __VLS_components.IconRefresh} */
            IconRefresh;
            // @ts-ignore
            const __VLS_115 = __VLS_asFunctionalComponent1(__VLS_114, new __VLS_114({
                size: (14),
                strokeWidth: (1.75),
            }));
            const __VLS_116 = __VLS_115({
                size: (14),
                strokeWidth: (1.75),
            }, ...__VLS_functionalComponentArgsRest(__VLS_115));
        }
        // @ts-ignore
        [];
    }
    // @ts-ignore
    [];
    var __VLS_103;
    var __VLS_104;
}
if (__VLS_ctx.logOpen) {
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "log-resize-wrap" },
    });
    /** @type {__VLS_StyleScopedClasses['log-resize-wrap']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ onMousedown: (...[$event]) => {
                if (!(__VLS_ctx.logOpen))
                    throw 0;
                return (__VLS_ctx.startDrag($event, 'y', 'log'));
                // @ts-ignore
                [logOpen, startDrag,];
            } },
        ...{ class: "resize-handle h" },
        title: "拖拽调整高度",
    });
    /** @type {__VLS_StyleScopedClasses['resize-handle']} */ ;
    /** @type {__VLS_StyleScopedClasses['h']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "log-panel" },
        ...{ style: ({ height: __VLS_ctx.logHeight + 'px' }) },
    });
    /** @type {__VLS_StyleScopedClasses['log-panel']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ...{ class: "log-head" },
    });
    /** @type {__VLS_StyleScopedClasses['log-head']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
        ...{ class: "log-title" },
    });
    /** @type {__VLS_StyleScopedClasses['log-title']} */ ;
    let __VLS_119;
    /** @ts-ignore @type { | typeof __VLS_components.IconTerminal} */
    IconTerminal;
    // @ts-ignore
    const __VLS_120 = __VLS_asFunctionalComponent1(__VLS_119, new __VLS_119({
        size: (12),
        strokeWidth: (1.75),
    }));
    const __VLS_121 = __VLS_120({
        size: (12),
        strokeWidth: (1.75),
    }, ...__VLS_functionalComponentArgsRest(__VLS_120));
    __VLS_asFunctionalElement1(__VLS_intrinsics.button, __VLS_intrinsics.button)({
        ...{ onClick: (...[$event]) => {
                if (!(__VLS_ctx.logOpen))
                    throw 0;
                return (__VLS_ctx.logs = []);
                // @ts-ignore
                [logHeight, logs,];
            } },
        ...{ class: "log-clear btn btn-sm btn-ghost" },
    });
    /** @type {__VLS_StyleScopedClasses['log-clear']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-sm']} */ ;
    /** @type {__VLS_StyleScopedClasses['btn-ghost']} */ ;
    __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
        ref: "logBody",
        ...{ class: "log-scroll" },
    });
    /** @type {__VLS_StyleScopedClasses['log-scroll']} */ ;
    for (const [l, i] of __VLS_vFor((__VLS_ctx.logs))) {
        __VLS_asFunctionalElement1(__VLS_intrinsics.div, __VLS_intrinsics.div)({
            key: (i),
            ...{ class: "log-item" },
        });
        /** @type {__VLS_StyleScopedClasses['log-item']} */ ;
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "log-time mono faint" },
        });
        /** @type {__VLS_StyleScopedClasses['log-time']} */ ;
        /** @type {__VLS_StyleScopedClasses['mono']} */ ;
        /** @type {__VLS_StyleScopedClasses['faint']} */ ;
        (l.time);
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "log-agent mono" },
            ...{ class: (__VLS_ctx.agentClass(l.agentId)) },
        });
        /** @type {__VLS_StyleScopedClasses['log-agent']} */ ;
        /** @type {__VLS_StyleScopedClasses['mono']} */ ;
        (l.agent);
        __VLS_asFunctionalElement1(__VLS_intrinsics.span, __VLS_intrinsics.span)({
            ...{ class: "log-text" },
        });
        /** @type {__VLS_StyleScopedClasses['log-text']} */ ;
        (l.text);
        // @ts-ignore
        [logs, agentClass,];
    }
}
// @ts-ignore
[];
const __VLS_export = (await import('vue')).defineComponent({});
export default {};
