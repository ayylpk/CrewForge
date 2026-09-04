import axios from 'axios'
import { ElMessage } from 'element-plus'

/**
 * axios 统一封装
 * 开发期：不带 token（JWT 后续接入），直接调后端
 * 响应格式约定（与后端 Result<T> 对齐）：{ code, msg, data }，code=1 成功
 */
const request = axios.create({
  // C10：基址从 VITE_API_BASE 读（.env 配置），未配则回退本地后端；
  // 与 sys_settings.java_base_url 同源，部署换端口/域名只改 .env 不改代码
  baseURL: import.meta.env.VITE_API_BASE || 'http://localhost:8080',
  timeout: 30000,
})

// 请求拦截器：统一带 token（Authorization 头）
request.interceptors.request.use((config) => {
    const token = localStorage.getItem('cf_token')
    if(token){
        config.headers.Authorization = token
    }
    return config
    },
    (error) => Promise.reject(error),
)

// 响应拦截器：统一处理 Result<T> 包装和错误
request.interceptors.response.use(
  (response) => {
    const res = response.data
    // 后端统一格式 { code: 1(成功) / 0(失败), msg, data }
    if (res.code === 0) {
      ElMessage.error(res.msg || '请求失败')
      return Promise.reject(new Error(res.msg || '请求失败'))
    }
    // 统一解包：调用方拿到的直接是业务数据（如 LoginVO），不用自己拆 Result
    return res.data
  },
  (error) => {
    if (error.response) {
      const { status } = error.response
      if (status === 401) {
        localStorage.removeItem('cf_token')
        ElMessage.error('登录已过期，请重新登录')
        // 跳转登录页（避免在登录页重复跳转）
        if (window.location.pathname !== '/login') {
          window.location.href = '/login'
        }
      } else {
        ElMessage.error(error.response.data?.msg || `请求错误 ${status}`)
      }
    } else {
      ElMessage.error('网络异常，请检查连接')
    }
    return Promise.reject(error)
  },
)
/** 请求泛型：T 为 Result 解包后的数据类型 */
export function get<T>(url: string, params?: object): Promise<T> {
  return request.get(url, { params }) as Promise<T>
}

export function post<T>(url: string, data?: object): Promise<T> {
  return request.post(url, data) as Promise<T>
}

export function put<T>(url: string, data?: object): Promise<T> {
  return request.put(url, data) as Promise<T>
}

export function del<T>(url: string): Promise<T> {
  return request.delete(url) as Promise<T>
}

export default request
