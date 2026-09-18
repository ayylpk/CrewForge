import request from './request';
export function startProjectRun(projectId) {
    return request.post(`/api/project-run/${projectId}`);
}
export function fetchRunStatus(projectId) {
    return request.get(`/api/project-run/${projectId}`);
}
export function stopProjectRun(projectId) {
    return request.delete(`/api/project-run/${projectId}`);
}
