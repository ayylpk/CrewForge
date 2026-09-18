import request from './request';
const CONFIRM_MAP = { green: 0, mixed: 1, manual: 2 };
export function fetchProjects() {
    return request.get('/api/project', {
        params: { page: 1, pageSize: 20 },
    });
}
/** 查询单个项目（详情页用） */
export function fetchProjectById(id) {
    return request.get(`/api/project/${id}`);
}
/** 下载项目文件 zip（audit F1：原实现用 <a href> 直导航——不带 token 且 dev 无代理，必坏包） */
export function downloadProjectZip(id) {
    return request.get(`/api/project/${id}/download`, { responseType: 'blob' });
}
/** 删除项目 */
export function deleteProject(id) {
    return request.delete(`/api/project/${id}`);
}
/** 更新项目（Partial 只传要改的字段；后端 DTO 白名单 + updateById 只更新非 null 字段） */
export function updateProject(id, dto) {
    return request.put(`/api/project/${id}`, {
        ...dto,
        // confirmMode 页面是字符串，后端要数字；undefined 时不传（不修改）
        confirmMode: dto.confirmMode ? CONFIRM_MAP[dto.confirmMode] : undefined,
    });
}
export function createProject(dto) {
    // createUser 后端从 JWT 取，前端不传
    return request.post('/api/project', {
        ...dto,
        confirmMode: CONFIRM_MAP[dto.confirmMode],
    });
}
