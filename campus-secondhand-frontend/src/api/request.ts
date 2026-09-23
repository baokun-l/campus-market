/**
 * Axios 请求封装层
 * - 统一拦截、错误处理、Loading 管理、Token 注入
 */
import axios, { type AxiosInstance, type AxiosRequestConfig, type AxiosResponse } from 'axios'
import { BusinessCode } from '@/types'
import { useUserStore } from '@/stores/modules/user'

/**
 * 把自定义配置项合并进 axios 的类型，这样拦截器里能直接 `config.showLoading` 取到，
 * 不必再 `(config as any)` 强转。
 */
declare module 'axios' {
  export interface AxiosRequestConfig {
    /** 是否展示全局 loading，默认 true */
    showLoading?: boolean
    /** true 时不再自动弹错误提示（由调用方自己处理） */
    silent?: boolean
    /** 内部标记：本次请求确实开过 loading，用于配套关闭，避免误减计数 */
    _showLoading?: boolean
  }
}

// ============== 全局 Loading 引用 ==============
let loadingInstance: { close: () => void } | null = null
let pendingRequests = 0

function startLoading() {
  pendingRequests++
  if (pendingRequests === 1) {
    loadingInstance = ElLoading.service({
      lock: true,
      text: '加载中…',
      background: 'rgba(255, 255, 255, 0.5)',
      fullscreen: false,
      target: 'body'
    })
  }
}

function stopLoading() {
  pendingRequests = Math.max(pendingRequests - 1, 0)
  if (pendingRequests === 0 && loadingInstance) {
    loadingInstance.close()
    loadingInstance = null
  }
}

// ============== 401 统一处理 ==============
/**
 * 401 弹窗去重开关：token 过期时一个页面往往会并发发出好几个请求
 * （列表 + 详情 + 未读数…），每个失败请求都弹一次「登录状态已过期」的话，
 * 用户要连点好几次「去登录」才能关干净。用它把并发失败收敛成**只弹一次**，
 * 下一次成功响应时复位。
 */
let unauthorizedHandled = false

/**
 * 处理「服务端说这张票不认了」（body.code = 401）。
 *
 * ★ D9 之后 401 的含义变重了 ★
 * 凭据在 HttpOnly Cookie 里、由浏览器自动携带，**前端无法自己判断票还有没有效**，
 * 所以 401 是唯一、也是权威的「会话已作废」信号。它来自三种服务端判定：
 *   ① 票压根没有 / 解析失败（未登录）；
 *   ② 账号被封禁（`AuthInterceptor` 回查 t_user.status）；
 *   ③ token_version 对不上（改过密码 / 被管理员重置密码）。
 * ②③ 都会返回 **HTTP 200 + body.code 401**（本项目的既定错误契约），
 * 靠 `message` 区分具体原因。
 *
 * ★ 为什么必须在这里就把本地会话清掉，而不是等用户点弹窗 ★
 * 清掉 = `isLoggedIn` 变假。真实模式下 `isLoggedIn` 的唯一来源是 `sessionHint`，
 * 若留着它，路由守卫会继续认为"人还在"并放行，用户会停在一个
 * 什么数据都没有的页面上（每个请求都 401），刷新也回不到登录页。
 * 这是 D9 引入的新耦合：**标记的存在性必须跟着票据的有效性一起收敛**。
 *
 * 原因文案取自服务端的 message（如「账号已被封禁，请联系管理员」），
 * 比前端硬编码一句"登录状态已过期"更准确 —— 被封禁的人不该以为自己只是掉线了。
 */
function handleUnauthorized(serverMessage?: string): void {
  const userStore = useUserStore()
  /*
   * 只在**确实是已登录状态**下才作废会话。
   * 游客（从未登录）触发 401 时若也写 revoked，登录页会平白弹一句
   * 「登录状态已失效」—— 那是在吓唬第一次进站的访客。
   */
  let reason = 'expired'
  if (userStore.isLoggedIn) {
    // 「封禁」是唯一需要单独区分的分支：文案与 query 键都要对得上 Login.vue 的 REVOKED_TEXT
    if (serverMessage?.includes('封禁')) reason = 'banned'
    userStore.revoke(reason as 'banned' | 'expired', serverMessage || '登录状态已过期，请重新登录')
  }
  if (unauthorizedHandled) return
  unauthorizedHandled = true
  ElMessageBox.alert(serverMessage || '登录状态已过期，请重新登录', '提示', {
    confirmButtonText: '去登录',
    callback: () => {
      /*
       * 本地会话已在上面作废，这里只负责把人送到登录页。
       * ★ 不要再调一次 userStore.logout() ★：它会清掉 revoked/revokedMessage，
       * 那句"为什么被踢"的解释会在跳转前一刻被抹掉，用户回到登录页只剩一个空表单。
       */
      window.location.href = loginUrlAfterUnauthorized(reason)
    }
  })
}

/**
 * 被踢回登录页的目标地址。
 *
 * ★ 两个必须做对的点，都有用例守着（request.spec.ts）★
 *   ① 带上 `?revoked=<原因>` —— `revoked`/`revokedMessage` 只活在内存里、不持久化，
 *      而这里是整页跳转（不是 SPA 路由跳转），跳完内存态就没了。
 *      query 参数能活过这次跳转与后续刷新，Login.vue 按它给兜底文案；
 *      不带上就等于"用户被踢了但不知道为什么"。
 *   ② 不能写死 '/login' —— 子路径部署（P2-3，如挂在 /market/ 下）时，
 *      绝对路径 '/login' 会跳到应用**外面**去，Nginx 直接 404。
 *      必须从 `BASE_URL` 派生，它是 Vite 按 `base` 注入的。
 *
 * 抽成独立函数是为了能被直接断言，而不是靠"真的去改 window.location 再看结果"——
 * 后者在 happy-dom 下是一次真实导航，脆且会污染同文件其它用例。
 */
export function loginUrlAfterUnauthorized(reason: string): string {
  const base = import.meta.env.BASE_URL.endsWith('/')
    ? import.meta.env.BASE_URL
    : `${import.meta.env.BASE_URL}/`
  return `${base}login?revoked=${reason}`
}

// ============== 创建实例 ==============
const service: AxiosInstance = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || '/api',
  timeout: 15000,
  headers: { 'Content-Type': 'application/json;charset=UTF-8' }
  /*
   * ★ 这里**刻意不写 withCredentials: true**（D9）★
   *
   * 会话 Cookie 要能被带上，前提是**同源**：
   *   · 开发：`VITE_API_BASE=/api` 走 Vite dev server 代理 → 同源；
   *   · 生产：`.env.production` 约定由 Nginx 把 `/api` 反代到后端 → 同源。
   * 同源请求浏览器**必然**携带 Cookie，`withCredentials` 在此毫无作用（它是给跨源用的）。
   *
   * 反过来，如果哪天真去跨源调这个后端，只在这一行加 `withCredentials: true`
   * 是**不够**的：后端 `WebMvcConfig` 是 `allowCredentials(false)`
   * （通配来源 + 允许携带凭据是危险组合，见那边的注释），浏览器会直接拒收响应。
   * 也就是说"加个开关就能跨源"是假象 —— 所以这里不放一个永远不生效的配置项，只留这段说明。
   *
   * ⚠️ 由此产生的排查线索：若有人把 VITE_API_BASE 改成绝对地址（如
   * http://localhost:8080/api）做跨源调试，症状是「登录成功 → 立刻被弹回登录页」
   * （登录响应体里的 token 前端不再使用，而 Cookie 跨源没带上）。
   * 看到这个症状，先查是不是跨源了，而不是去查密码。
   */
})

// ============== 请求拦截 ==============
service.interceptors.request.use(
  (config) => {
    /*
     * Authorization 头现在只服务 **mock 模式**（D9）。
     *
     * 真实模式下 `userStore.token` 恒为空串（凭据在 HttpOnly Cookie 里，
     * 由浏览器自动携带），所以这个分支自然不进 —— 不需要额外的模式判断，
     * "token 为空" 本身就是模式的区别所在。
     * 后端两条通道都认（`AuthInterceptor` 先读 Cookie 再看头），
     * 头这条留给探针脚本 / Swagger / 非浏览器客户端，不要删。
     */
    const userStore = useUserStore()
    if (userStore.token) {
      config.headers!.Authorization = `Bearer ${userStore.token}`
    }
    /*
     * ★ 这里以前读的是 `config.headers['showLoading']`，是错的 ★
     *
     * 13 处调用方传的都是**顶层**的 `showLoading: false`（登录、注册、个人资料、
     * 发消息、评价列表、公告、AI 对话、商品留言…），headers 里根本没有这个键，
     * 于是 `undefined !== false` 恒成立 —— 所有「不要全局遮罩」的意图全部失效，
     * 这些接口每次都会闪一下全屏「加载中…」。
     * 自定义配置项就该从顶层读。
     */
    if (config.showLoading !== false) {
      startLoading()
      config._showLoading = true
    }
    return config
  },
  (err) => {
    ElMessage.error('请求发送失败，请重试')
    return Promise.reject(err)
  }
)

// ============== 响应拦截 ==============
service.interceptors.response.use(
  (response: AxiosResponse<{ code: number; message: string; data: unknown }>) => {
    const config = response.config
    // 只关闭「自己开过」的那次，避免把别人的计数减掉
    if (config._showLoading) stopLoading()

    const res = response.data
    if (res.code === BusinessCode.SUCCESS) {
      unauthorizedHandled = false
      return res.data as any
    }

    if (res.code === BusinessCode.UNAUTHORIZED) {
      handleUnauthorized(res.message)
      return Promise.reject(new Error('Unauthorized'))
    }

    if (res.code === BusinessCode.FORBIDDEN) {
      if (!config.silent) ElMessage.error('您没有该操作权限')
      return Promise.reject(new Error('Forbidden'))
    }

    if (!config.silent) ElMessage.error(res.message || '请求失败')
    return Promise.reject(new Error(res.message || 'Error'))
  },
  (err) => {
    // 只关闭「自己开过」的那次；原来无条件 stopLoading()，
    // 请求根本没开 loading 时也会把计数减掉，可能把别人的遮罩提前关掉
    if (err.config?._showLoading) stopLoading()
    if (axios.isCancel(err)) return Promise.reject(err)

    if (!err.config?.silent) {
      if (err.code === 'ECONNABORTED') ElMessage.error('请求超时，请检查网络')
      else if (err.response?.status === 401) ElMessage.error('登录状态已过期，请重新登录')
      else if (err.response?.status === 403) ElMessage.error('您没有该操作权限')
      else if (err.response?.status === 404) ElMessage.error('接口不存在')
      else if (err.response?.status >= 500) ElMessage.error('服务器异常，请稍后再试')
      else if (err.message?.includes('Network')) ElMessage.error('网络连接失败')
      else ElMessage.error(err.message || '请求失败')
    }
    return Promise.reject(err)
  }
)

// ============== 统一封装 ==============
export interface RequestOptions extends Omit<AxiosRequestConfig, 'data' | 'params' | 'url'> {
  url: string
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  params?: Record<string, any>
  data?: any
  /** 是否展示全局 loading，默认 true */
  showLoading?: boolean
  /** 自定义错误处理，true 时不再自动弹错误 */
  silent?: boolean
}

export async function request<T = unknown>(opts: RequestOptions): Promise<T> {
  const { method = 'GET', showLoading = true, silent = false, ...rest } = opts
  /*
   * ★ 不要把 `...opts` 摊在显式字段后面 ★
   *
   * 原来的写法是 `{ url: opts.url, method: opts.method || 'GET', ...opts }`——
   * `opts` 必然带 `url`，摊开后又把前面的 `url` 覆盖一遍，
   * TS 直接报 TS2783「'url' is specified more than once」。
   * 这里改成先解构出需要兜底的项，其余原样透传。
   */
  return (await service({ method, showLoading, silent, ...rest })) as T
}

export default service
