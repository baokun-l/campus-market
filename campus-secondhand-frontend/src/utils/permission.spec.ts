/**
 * 权限工具单元测试 · createAuthGuard / checkPermission
 *
 * 覆盖：公开页放行 / 未登录拦截 / 非管理员拦到 403 /
 *      **账号被封禁与会话失效时把人送回登录页**（这一组是本次修复新增的）。
 *
 * ⚠️ 这里刻意**不 mock API 层**，而是走真实的 mock 用户表 + 真实 localStorage。
 * 之前这组用例手写 `user.token = 'mock-token-user'`（一个在任何用户表里都不存在的 token）就当作「已登录」，
 * 恰好绕过了「token 能否还原成真实账号」这件事 —— 而漏洞就藏在那条路径上。
 * 用真实 token 才能验证守卫真的会拦住不该放行的人。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createApp } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import { createAuthGuard, checkPermission } from '@/utils/permission'
import { useUserStore } from '@/stores/modules/user'
import { mockUsersExport } from '@/api/mock'
import { SESSION_KEY } from '@/api/session'

/** 构造一个最小的路由对象 */
const route = (meta: Record<string, unknown>, fullPath = '/test') =>
  ({ meta, fullPath, path: String(meta.path ?? fullPath) }) as any

/**
 * 模拟「带着持久化 token 进入页面」：
 * 只写 token（与 pinia persist 的真实行为一致，profile 靠守卫去还原）。
 */
function enterWithToken(token: string) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ token }))
  const user = useUserStore()
  user.token = token
  user.profile = null
  return user
}

const normalUser = () => mockUsersExport.find((u) => u.role === 'user' && u.status === 'active')!

describe('createAuthGuard() · 路由守卫', () => {
  beforeEach(() => {
    localStorage.clear()
    const pinia = createPinia()
    pinia.use(piniaPluginPersistedstate)
    createApp({}).use(pinia)
    setActivePinia(pinia)
  })

  it('应放行标记了 meta.public 的页面（如登录/注册）', async () => {
    const guard = createAuthGuard()
    const next = vi.fn()
    await guard(route({ public: true }), route({}), next)
    expect(next).toHaveBeenCalledWith()
  })

  it('未登录访问需鉴权页面时应重定向到 /login 并带上 redirect', async () => {
    const guard = createAuthGuard()
    const next = vi.fn()
    await guard(route({ requireAuth: true }, '/order'), route({}), next)
    expect(next).toHaveBeenCalledWith({ path: '/login', query: { redirect: '/order' } })
  })

  it('已登录访问需鉴权页面时应放行', async () => {
    enterWithToken(`mock-token-user-${normalUser().id}`)
    const guard = createAuthGuard()
    const next = vi.fn()
    await guard(route({ requireAuth: true }), route({}), next)
    expect(next).toHaveBeenCalledWith()
  })

  it('非管理员访问 requireAdmin 页面时应被拦到 /403', async () => {
    enterWithToken(`mock-token-user-${normalUser().id}`)
    const guard = createAuthGuard()
    const next = vi.fn()
    await guard(route({ requireAuth: true, requireAdmin: true }), route({}), next)
    expect(next).toHaveBeenCalledWith({ path: '/403' })
  })

  it('管理员访问 requireAdmin 页面时应放行', async () => {
    enterWithToken('mock-token-admin')
    const guard = createAuthGuard()
    const next = vi.fn()
    await guard(route({ requireAuth: true, requireAdmin: true }), route({}), next)
    expect(next).toHaveBeenCalledWith()
  })

  /* ---------------- 本次修复：封禁与会话失效 ---------------- */

  it('已封禁账号的 token 应被拦回登录页并带 revoked=banned（刷新不能复活）', async () => {
    const banned = mockUsersExport.find((u) => u.status === 'banned')!
    const user = enterWithToken(`mock-token-user-${banned.id}`)
    const guard = createAuthGuard()
    const next = vi.fn()
    await guard(route({ requireAuth: true }, '/home'), route({}), next)
    expect(next).toHaveBeenCalledWith({ path: '/login', query: { revoked: 'banned' } })
    // 会话确实被作废了，而不是只跳了个页
    expect(user.token).toBe('')
    expect(user.revoked).toBe('banned')
    expect(user.revokedMessage).toContain('封禁')
  })

  it('认不出来的 token 应带 revoked=expired 回登录页', async () => {
    enterWithToken('mock-token-user-999999')
    const guard = createAuthGuard()
    const next = vi.fn()
    await guard(route({ requireAuth: true }, '/home'), route({}), next)
    expect(next).toHaveBeenCalledWith({ path: '/login', query: { revoked: 'expired' } })
  })

  it('已在用的人被封禁后，下一次跳转立刻被踢（同一会话内生效）', async () => {
    const u = normalUser()
    const user = enterWithToken(`mock-token-user-${u.id}`)
    const guard = createAuthGuard()
    // 第一次跳转：正常放行并把 profile 还原出来
    const ok = vi.fn()
    await guard(route({ requireAuth: true }), route({}), ok)
    expect(ok).toHaveBeenCalledWith()
    expect(user.profile?.id).toBe(u.id)

    // 模拟管理员在后台把这个账号封了
    const before = u.status
    u.status = 'banned'
    try {
      const next = vi.fn()
      await guard(route({ requireAuth: true }, '/order'), route({}), next)
      expect(next).toHaveBeenCalledWith({ path: '/login', query: { revoked: 'banned' } })
      expect(user.token).toBe('')
    } finally {
      u.status = before
    }
  })

  /* ★ 待审核账号用例已随 D11 拆除（2026-09-23）：用户注册即 active，
   * 不存在 pending 用户，守卫只需区分 active / banned（上一用例覆盖封禁拦截）。 */

  it('未标记任何 meta 的页面应默认放行', async () => {
    const guard = createAuthGuard()
    const next = vi.fn()
    await guard(route({}), route({}), next)
    expect(next).toHaveBeenCalledWith()
  })

  /* ---------------- D9：守卫必须认 sessionHint，不能只看 token ---------------- */

  it('真实模式（无 token、只有 sessionHint）也要去求证会话，而不是直接放行', async () => {
    /*
     * 真实模式下凭据在 HttpOnly Cookie 里，store 的 token 恒为空串，
     * "我大概登录着"唯一的依据是持久化的 `sessionHint`。
     *
     * ★ 判别力所在 ★
     * 守卫里那个"启动时恢复 profile"的条件曾经写的是 `userStore.token`：
     * 真实模式下它恒假 ⇒ 这个分支永远不进 ⇒ profile 一直是 null ⇒
     * `isAdmin` 恒假（管理员进自己后台被 403）；
     * 同时 `isLoggedIn` 又为真 ⇒ 守卫不会把人送去登录页，而是**直接放行**。
     * 于是用户停在一个什么数据都没有的页面上 —— 不报错、不跳转，最难查的一种。
     *
     * 这里用 mock 数据模拟"标记还在但票已经没了"（mock 模式下没有 token 就还原不出身份）：
     * 正确行为是**判为会话失效并送回登录页**，而不是放行。
     */
    const user = useUserStore()
    user.token = ''
    user.sessionHint = true
    user.profile = null

    const guard = createAuthGuard()
    const next = vi.fn()
    await guard(route({ requireAuth: true }, '/home'), route({}), next)

    expect(next).toHaveBeenCalledWith({ path: '/login', query: { revoked: 'expired' } })
    // 会话被如实作废，而不是"跳个页但状态还留着"
    expect(user.isLoggedIn).toBe(false)
    expect(user.sessionHint).toBe(false)
  })
})

describe('checkPermission() · 按钮级权限', () => {
  beforeEach(() => {
    localStorage.clear()
    const pinia = createPinia()
    pinia.use(piniaPluginPersistedstate)
    createApp({}).use(pinia)
    setActivePinia(pinia)
  })

  it('传入空数组时应视为无需权限，直接放行', () => {
    expect(checkPermission([])).toBe(true)
  })

  it('未登录用户不应通过 user / admin 权限校验', () => {
    expect(checkPermission('user')).toBe(false)
    expect(checkPermission('admin')).toBe(false)
  })

  it('普通登录用户应通过 user 校验但不通过 admin 校验', () => {
    const user = useUserStore()
    user.token = 't'
    user.roles = ['user']
    expect(checkPermission('user')).toBe(true)
    expect(checkPermission('admin')).toBe(false)
  })

  it('管理员应同时通过 user 与 admin 校验', () => {
    const user = useUserStore()
    user.token = 't'
    user.roles = ['admin']
    expect(checkPermission('user')).toBe(true)
    expect(checkPermission('admin')).toBe(true)
  })

  it('数组形式应满足「任一命中即通过」', () => {
    const user = useUserStore()
    user.token = 't'
    user.roles = ['user']
    expect(checkPermission(['admin', 'user'])).toBe(true)
    expect(checkPermission(['admin', 'merchant'])).toBe(false)
  })

  it('未知权限标识应返回 false', () => {
    const user = useUserStore()
    user.token = 't'
    user.roles = ['admin']
    expect(checkPermission('super-root')).toBe(false)
  })
})
