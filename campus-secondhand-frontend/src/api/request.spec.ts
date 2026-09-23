/**
 * request.ts · 401 语义（D9 会话凭据搬进 HttpOnly Cookie 之后）
 *
 * ★ 为什么这一组用例非有不可 ★
 * 凭据进 Cookie 之后，前端**失去了"自己判断票还有没有效"的能力**
 * （JS 读不到 Cookie），于是服务端返回的 401 成了唯一、也是权威的
 * 「会话已作废」信号。它必须做到三件事，每一件都是可以在代码里被改坏的：
 *   ① **立刻**作废本地会话 —— 否则 `isLoggedIn` 仍为真，路由守卫继续放行，
 *      用户停在一个每个请求都 401 的空页面上，刷新也回不到登录页；
 *   ② 把服务端给的原因（封禁 / 过期）如实带到登录页 ——
 *      被封禁的人不该只看到一句"登录状态已过期"；
 *   ③ **不误伤游客** —— 从未登录的人触发 401 时不得写 revoked，
 *      否则登录页平白弹一句"登录状态已失效"，第一次进站就被吓一跳。
 *
 * ⚠️ 这一组**不 mock 用户 store**，用的是真实 Pinia + 真实 localStorage，
 * 只把 element-plus 的弹窗换成间谍 —— 我们要验证的正是"401 有没有真的改到 state"，
 * 把 store 换成假对象就等于把被测对象换掉了。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createApp } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'

/*
 * ElMessageBox.alert 在 happy-dom 下会真的去挂载一个弹窗组件，
 * 既慢又可能因为动画/焦点行为而抖动。这里只换掉"弹窗"这一个动作，
 * 保留"调用了几次 / 传了什么文案"这两个可观测量 —— 去重逻辑本身就靠它验证。
 * 用 vi.hoisted 是因为 vi.mock 的工厂函数会被提升到文件顶部，
 * 直接引用下面声明的 const 会命中 TDZ。
 */
const spies = vi.hoisted(() => ({ alert: vi.fn() }))

vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
  ElMessageBox: { alert: spies.alert, confirm: vi.fn() }
}))

import service, { loginUrlAfterUnauthorized } from '@/api/request'
import { useUserStore } from '@/stores/modules/user'
import { BusinessCode } from '@/types'

/**
 * 取出响应拦截器的成功分支直接调用。
 *
 * 这样测的是**真实的拦截器代码**，而不是"我以为拦截器会做的事"——
 * 整条 401 处理链（判定 → 作废会话 → 弹窗去重 → 拼跳转地址）都在里面。
 */
function responseFulfilled(): (r: unknown) => Promise<unknown> {
  const handlers = (service.interceptors.response as any).handlers as Array<{
    fulfilled: (r: unknown) => Promise<unknown>
  }>
  return handlers[0].fulfilled
}

/** 造一个「HTTP 200 + body 业务码」的响应 —— 本项目的既定错误契约 */
function body(code: number, message: string) {
  return { data: { code, message, data: null }, config: {} }
}

/**
 * 调一次响应拦截器，把"同步返回"与"reject"统一成 Promise<void>。
 *
 * 两个细节都不能省：
 *   · **业务错误一律 reject** —— 调用方各自 catch 是本项目的既定分工，
 *     用例里必须跟着吞掉，否则会以 unhandled rejection 的形式污染其它用例；
 *   · **成功分支返回的不是 Promise**（`return res.data`），直接 `.catch()` 会
 *     报 "Cannot read properties of null" —— 那是测试自己的 bug，不是被测代码的。
 */
async function invoke(code: number, message: string): Promise<void> {
  try {
    await Promise.resolve(responseFulfilled()(body(code, message)))
  } catch {
    /* 预期内的业务拒绝 */
  }
}

/** 触发一次 401（或任意业务码）响应 */
const fire = (code: number, message: string) => invoke(code, message)

/**
 * 复位「401 弹窗去重」开关。
 *
 * ★ 为什么用例之间必须复位它 ★
 * 它是一个模块级变量，而**唯一的复位路径**就是"下一次成功响应"
 * （见下面的用例「一次成功响应之后，去重开关复位」）。
 * 不复位的话，第一个用例把开关置真之后，后续每个用例都收不到弹窗 ——
 * 于是"弹了几次"这类断言全部变成恒假的噪声，而原因与被测逻辑毫无关系。
 * 这里刻意走真实复位路径（喂一个成功响应），而不是去改内部变量：
 * 那样才能保证"复位机制"本身也被用到、被验证。
 */
const resetUnauthorizedDedupe = () => invoke(BusinessCode.SUCCESS, 'ok')

describe('request.ts · 401 统一处理', () => {
  beforeEach(async () => {
    localStorage.clear()
    spies.alert.mockClear()
    const pinia = createPinia()
    pinia.use(piniaPluginPersistedstate)
    createApp({}).use(pinia)
    setActivePinia(pinia)
    await resetUnauthorizedDedupe()
  })

  it('已登录收到 401 → 立刻作废本地会话（不能等用户点弹窗）', async () => {
    const user = useUserStore()
    user.token = 'mock-token-user-1'
    user.sessionHint = true
    user.profile = { id: 1, nickname: '小张' } as any
    user.roles = ['user']

    await fire(BusinessCode.UNAUTHORIZED, '登录状态已失效，请重新登录')

    // 三个可观测量：登录态、资料、原因
    expect(user.isLoggedIn).toBe(false)
    expect(user.sessionHint).toBe(false)
    expect(user.token).toBe('')
    expect(user.profile).toBeNull()
    expect(user.revoked).toBe('expired')
    // 文案必须来自服务端，而不是前端硬编码的那一句
    expect(user.revokedMessage).toContain('登录状态已失效')
  })

  it('服务端说「封禁」时，原因要归到 banned（登录页据此换文案）', async () => {
    const user = useUserStore()
    user.sessionHint = true
    user.profile = { id: 1, nickname: '小张' } as any

    await fire(BusinessCode.UNAUTHORIZED, '账号已被封禁，请联系管理员')

    expect(user.revoked).toBe('banned')
    expect(user.revokedMessage).toContain('封禁')
    // 被封禁的人不该以为自己"只是掉线了"
    expect(spies.alert).toHaveBeenCalledTimes(1)
    expect(String(spies.alert.mock.calls[0][0])).toContain('封禁')
  })

  it('游客触发 401 不得写 revoked（否则登录页会平白说"状态已失效"）', async () => {
    const user = useUserStore()
    expect(user.isLoggedIn).toBe(false)

    await fire(BusinessCode.UNAUTHORIZED, '未登录')

    expect(user.revoked).toBeNull()
    expect(user.revokedMessage).toBe('')
  })

  it('并发多个 401 只弹一次（其余请求静默失败）', async () => {
    const user = useUserStore()
    user.sessionHint = true

    // 一个页面同时发三个请求，全部 401 —— 真实场景：列表 + 详情 + 未读数
    await fire(BusinessCode.UNAUTHORIZED, '登录状态已失效，请重新登录')
    await fire(BusinessCode.UNAUTHORIZED, '登录状态已失效，请重新登录')
    await fire(BusinessCode.UNAUTHORIZED, '登录状态已失效，请重新登录')

    expect(spies.alert).toHaveBeenCalledTimes(1)
    // 但三次都要如实 reject，调用方才能各自收尾
    expect(user.isLoggedIn).toBe(false)
  })

  it('一次成功响应之后，去重开关复位（下次 401 仍能提醒）', async () => {
    const user = useUserStore()
    user.sessionHint = true
    await fire(BusinessCode.UNAUTHORIZED, '登录状态已失效，请重新登录')
    expect(spies.alert).toHaveBeenCalledTimes(1)

    // 用户重新登录 → 成功响应
    await resetUnauthorizedDedupe()

    // 之后再次失效，必须还能弹（否则用户第二次被踢时只会莫名跳走）
    user.sessionHint = true
    await fire(BusinessCode.UNAUTHORIZED, '登录状态已失效，请重新登录')
    expect(spies.alert).toHaveBeenCalledTimes(2)
  })

  it('401 的跳转地址必须带原因、且从 BASE_URL 派生（写死 /login 会跳出应用）', async () => {
    const user = useUserStore()
    user.sessionHint = true
    await fire(BusinessCode.UNAUTHORIZED, '账号已被封禁，请联系管理员')

    // alert 的 callback 是被延迟执行的（等用户点"去登录"）
    // ★ 注意参数位置：ElMessageBox.alert(message, title, options) —— options 在第 3 个 ★
    const opts = spies.alert.mock.calls[0][2] as { callback: () => void }
    expect(typeof opts.callback).toBe('function')
    const callback = opts.callback

    // ① 根路径部署：BASE_URL = '/'（测试环境的实际值）
    vi.stubEnv('BASE_URL', '/')
    expect(loginUrlAfterUnauthorized('banned')).toBe('/login?revoked=banned')

    /*
     * ② 子路径部署（P2-3，如挂在 /market/ 下）：
     *    这里必须与 BASE_URL 同源 —— 写死 '/login' 的实现会返回 '/login?revoked=banned'，
     *    本断言立刻报红。这就是"能力"层面的判据，而不是"字符串里有没有 login"。
     */
    vi.stubEnv('BASE_URL', '/market/')
    expect(loginUrlAfterUnauthorized('banned')).toBe('/market/login?revoked=banned')
    vi.unstubAllEnvs()

    /*
     * ③ 顺便确认 callback 真的用了这个函数（而不是另写一份拼串）：
     *    调用它只会去改 window.location，happy-dom 下不抛错即可，
     *    真正的判据是上面的纯函数断言 —— 不靠"真跳转"这种脆手段。
     */
    expect(() => callback()).not.toThrow()
  })
})
