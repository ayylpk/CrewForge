import { post } from './request';
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
function getStoredToken() {
    const raw = localStorage.getItem('cf_token');
    if (!raw || raw === 'undefined' || raw === null) {
        return '';
    }
    return raw;
}
function getStoredUserInfo() {
    try {
        const raw = localStorage.getItem('cf_user_info');
        if (!raw || raw === 'undefined' || raw === null) {
            return null;
        }
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
export const useAuthStore = defineStore('auth', () => {
    const token = ref(getStoredToken());
    const userInfo = ref(getStoredUserInfo());
    const isLoggedIn = computed(() => !!token.value);
    // 注意：后端 LoginVO 字段是 username（小写 n），不是 userName
    const userName = computed(() => userInfo.value?.username || '');
    async function login(info) {
        // post 已解包：返回的 res 直接就是 LoginVO（不是 axios 原始响应）
        const res = await post('/api/auth/login', info);
        const rawToken = res?.accessToken || '';
        token.value = rawToken;
        userInfo.value = res;
        if (rawToken) {
            localStorage.setItem('cf_token', rawToken);
            localStorage.setItem('cf_user_info', JSON.stringify(res));
        }
        return res;
    }
    function logout() {
        token.value = '';
        userInfo.value = null;
        localStorage.removeItem('cf_token');
        localStorage.removeItem('cf_user_info');
    }
    return { token, userInfo, isLoggedIn, userName, login, logout };
});
