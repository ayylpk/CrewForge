import axios from 'axios'
import { toast } from '../utils/toast'

/**
 * axios 统一封装
 * 开发期：不带 token（JWT 后续接入），直接调后端
 * 响应格式约定（与后端 Result<T> 对齐）：{ code, msg, data }，code=1 成功
 */

/**
 * 基址口径（C10 + 9/17 修部署洞）：
 *   · 已显式配置 VITE_API_BASE（含**空串**）→ 用配置值；
 *   · 空串 = 同源相对路径，生产由前置反向代理（nginx 等）把 /api 转到后端；
 *   · 完全没配（undefined）→ 回退本地后端，纯 `npm run dev` 不开 .env 也能跑。
 * 注意必须用 ?? 而不是 ||：空串是"有意的配置"，被 || 当 falsy 吞掉就会回落成
 * http://localhost:8080 —— 那正是 Docker 里前端去访问访客自己电脑的经典事故。
 */
const FALLBACK_BASE = 'http://localhost:8080'
const baseURL = import.meta.env.VITE_API_BASE ?? FALLBACK_BASE

const request = axios.create({
  baseURL,
  timeout: 30000,
})

/**
 * 无效 id 拦截闸（9/17）。
 *
 * 前端多处写 `Number(route.params.id)`；当地址里没有有效 id 时它得 NaN，
 * 拼进路径就是 `/api/project/NaN`，后端把该段转 Long 直接抛
 * `参数 id 需要是 Long，收到 "NaN"`。10s 轮询下这会变成**每 10 秒弹一次窗**。
 *
 * 这类请求注定失败，所以在源头拦掉：**只进 console，不弹 toast**——
 * 闸门自己再造一个 10s 一次的错误提示，就等于把刚修的问题换个地方复现。
 */
const BAD_SEGMENT = /(^|[/?&=])(NaN|undefined|null)([/?&=]|$)/
function badIdIn(config: { url?: unknown; params?: unknown }): string | null {
  const url = typeof config.url === 'string' ? config.url : ''
  if (BAD_SEGMENT.test(url)) return url
  const params = config.params
  if (params && typeof params === 'object') {
    for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
      if (typeof value === 'number' && !Number.isFinite(value)) return `${url}?${key}=${value}`
    }
  }
  return null
}

// 请求拦截器：统一带 token（Authorization 头，裸 token——与后端 jjwt 解析口径一致）
request.interceptors.request.use((config) => {
    const bad = badIdIn(config)
    if (bad) {
      const msg = `[request] 地址里的 id 无效，已拦截未发送: ${bad}`
      console.error(msg)
      // ⚠️ 打上 clientGuard 标记：这不是网络问题，响应拦截器必须据此**跳过**
      //    "网络异常，请检查连接"那条提示 —— 否则会把排障方向带偏到网络上
      //    （9/17 用户实测被这句误导去找网络问题，真因是 id 无效）。
      const guardErr = new Error(msg) as Error & { clientGuard?: boolean; badTarget?: string }
      guardErr.clientGuard = true
      guardErr.badTarget = bad
      return Promise.reject(guardErr)
    }
    const token = localStorage.getItem('cf_token')
    if(token){
        config.headers.Authorization = token
    }
    return config
    },
    (error) => Promise.reject(error),
)

/**
 * 从失败响应里取出后端 msg。
 * 两种情况要分开：
 *   · 普通 JSON 错误（GlobalExceptionHandler 出的 {code:0,msg}）→ 直接读 msg；
 *   · responseType:'blob' 的下载接口失败时 data 是 Blob（不是信封）→ 读不出来，
 *     退回 null 让调用方用状态码兜底，绝不能拿 Blob 当对象点属性。
 */
function extractMsg(data: unknown): string | null {
  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data) as { msg?: string }
      return parsed?.msg || null
    } catch {
      return null
    }
  }
  if (data && typeof data === 'object' && 'msg' in data) {
    const msg = (data as { msg?: unknown }).msg
    return typeof msg === 'string' && msg ? msg : null
  }
  return null
}

// 响应拦截器：统一处理 Result<T> 包装和错误
request.interceptors.response.use(
  (response) => {
    const res = response.data
    // 二进制直传：responseType:'blob' 的下载类响应不是 Result 信封，
    // 走下面的解包会拿 .data=undefined 把文件吃掉（9/16 修 audit F1 时发现）
    if (res instanceof Blob) return res
    // 后端统一格式 { code: 1(成功) / 0(失败), msg, data }
    if (res.code === 0) {
      toast.error(res.msg || '请求失败')
      return Promise.reject(new Error(res.msg || '请求失败'))
    }
    // 统一解包：调用方拿到的直接是业务数据（如 LoginVO），不用自己拆 Result
    return res.data
  },
  (error) => {
    // ★ 首先处理"请求拦截闸"自己的错误：它是**客户端参数错误**，请求根本没发出去，
    //   所以没有 error.response。若让它掉进下面的兜底，就会弹出
    //   "网络异常，请检查连接" —— 把"地址里 id 无效"谎报成"网络问题"，
    //   排障方向全错（9/17 用户实测就是这么被误导的，白找了一圈网络）。
    //   这里改用**如实**的文案，并把被拦下的地址一起报出来：
    //   下次再出现，弹出的这句话本身就是定位结果。
    //   （toast 已按文案去重，轮询场景不会刷屏）
    if ((error as { clientGuard?: boolean } | null)?.clientGuard) {
      const target = String((error as { badTarget?: string }).badTarget ?? '')
      toast.error(`请求地址无效（id 是 NaN/undefined），已拦截未发送：${target}`)
      return Promise.reject(error)
    }

    // ★ 9/17 修：原来这里只 toast、却把**原始 axios error** reject 出去，
    //   于是视图层 catch 到的是 "Request failed with status code 400"，
    //   后端精心写的"账号不存在/密码错误"只有 toast 一闪而过。
    //   现在把后端 msg 挂到 Error 上（同时保留 response 供将来需要者取用）。
    let message = '网络异常，请检查连接'
    if (error.response) {
      const { status, data } = error.response
      if (status === 401) {
        localStorage.removeItem('cf_token')
        message = '登录已过期，请重新登录'
        // 跳转登录页（避免在登录页重复跳转）
        if (window.location.pathname !== '/login') {
          window.location.href = '/login'
        }
      } else {
        message = extractMsg(data) || `请求错误 ${status}`
      }
    }
    toast.error(message)
    const wrapped = new Error(message) as Error & { response?: unknown; status?: number }
    wrapped.response = error.response
    wrapped.status = error.response?.status
    return Promise.reject(wrapped)
  },
)

/**
 * 请求泛型：T 为 Result 解包后的数据类型。
 * 只有 post 有调用方（api/auth.ts 的登录）；原来还导出的 get/put/del 全仓零引用，
 * 已删——其余模块一律 `import request from './request'` 用下面的实例方法，两套并存只会漂移。
 */
export function post<T>(url: string, data?: object): Promise<T> {
  return request.post(url, data) as Promise<T>
}

export default request
