import request from './request';
export function fetchVerifyEvidence(projectId) {
    return request.get(`/api/project-verify/${projectId}`);
}
