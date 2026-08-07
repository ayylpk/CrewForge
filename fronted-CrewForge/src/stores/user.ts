import { defineStore } from 'pinia'

/**
 * 用户状态（开发期：假数据，不接后端）
 */
export const useUserStore = defineStore('user', {
  state: () => ({
    token: localStorage.getItem('cf_token') || '',
    username: localStorage.getItem('cf_username') || 'admin',
    tenantId: 1,
  }),
  getters: {
    isLoggedIn: (state) => !!state.token,
  },
  actions: {
    /** 开发期登录（后续替换为真实接口） */
    login(username: string, password: string): boolean {
      if (username === 'admin' && password === '123456') {
        this.token = 'dev-token-admin'
        this.username = username
        localStorage.setItem('cf_token', this.token)
        localStorage.setItem('cf_username', username)
        return true
      }
      return false
    },
    logout() {
      this.token = ''
      localStorage.removeItem('cf_token')
      localStorage.removeItem('cf_username')
    },
  },
})
