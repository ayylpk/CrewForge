import request from './request';
export function fetchSettings() {
    return request.get('/api/settings');
}
export function saveSettings(dto) {
    return request.put('/api/settings', dto);
}
export function testSettings(dto) {
    return request.post('/api/settings/test', dto);
}
