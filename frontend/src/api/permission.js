import request from './request';
export function fetchPermissionRules(projectId) {
    return request.get('/api/permission/rules', { params: { projectId } });
}
export function addPermissionRule(rule) {
    return request.post('/api/permission/rules', rule);
}
/** 停用（不物理删：停用后仍能在列表里看见它曾经存在过） */
export function disablePermissionRule(id) {
    return request.delete(`/api/permission/rules/${id}`);
}
/** 最近被拒的审批 —— 让人看见闸门实际拦下了什么（不然"拦住了"这件事没有任何痕迹） */
export function fetchRecentDenials(projectId, limit = 20) {
    return request.get('/api/permission/denials', { params: { projectId, limit } });
}
