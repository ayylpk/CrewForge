import request from './request';
/** 答复权限卡：走 decision，不走 answer —— 引擎要靠可判定的枚举决定放行与否 */
export function answerPermission(id, decision) {
    return request.post(`/api/confirm/${id}/answer`, { decision });
}
export function fetchPendingConfirms(projectId) {
    return request.get('/api/confirm/pending', { params: { projectId } });
}
/**
 * 项目全部问答记录（含已答/已放行），按 id 升序。
 * 需求对话页的对话记录靠它：pending 只回未答的，答完就消失，
 * 只轮询 pending 的话刷新一下对话就空了——看着像没连上（9/18）。
 */
export function fetchConfirmHistory(projectId) {
    return request.get('/api/confirm/history', { params: { projectId } });
}
export function answerConfirm(id, answer) {
    return request.post(`/api/confirm/${id}/answer`, { answer });
}
/** optionsJson → string[]（脏数据回退空数组=自由文本） */
export function parseOptions(c) {
    if (!c.optionsJson)
        return [];
    try {
        const arr = JSON.parse(c.optionsJson);
        return Array.isArray(arr) ? arr.map(String) : [];
    }
    catch {
        return [];
    }
}
/**
 * detailJson → 审批卡要展示的东西（脏数据回退空对象=退化成"只有题面"，也不至于炸）。
 * 与 parseOptions 同一形态：库里这些列都是**双形状**（实体直出是字符串，
 * snapshot 出口是对象），解析一律收在这一个地方，免得每个调用方各写一遍 try/catch。
 */
export function parseDetail(c) {
    const raw = c.detailJson;
    if (!raw)
        return {};
    try {
        const v = JSON.parse(raw);
        return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    }
    catch {
        return {};
    }
}
