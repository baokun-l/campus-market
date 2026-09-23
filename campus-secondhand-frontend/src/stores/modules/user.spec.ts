/**
 * Pinia Store 单元测试 · 用户状态
 * 通过 vi.mock 隔离 API 层，专注验证 store 的状态流转逻辑
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createApp } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'

/**
 * 服务端「清票」接口的间谍（D9）。
 * 必须提到 vi.mock 之前用 vi.hoisted 声明：vi.mock 的工厂会被提升到文件顶部执行，
 * 直接引用下面声明的变量会命中 TDZ。
 */
const logoutSpy = vi.hoisted(() => vi.fn(async () => undefined))

// 隔离 API 层：避免测试依赖 axios / mock 开关
vi.mock('@/api/user', () => ({
  logout: logoutSpy,
  login: vi.fn(async ({ username }: { username: string }) => ({
    token: `token-${username}`,
    user: {
      id: 1,
      username,
      nickname: '计算机小张',
      avatar: 'a.png',
      creditScore: 98,
      status: 'active',
      role: username === 'admin' ? 'admin' : 'user',
      createTime: '2026-08-15T10:23:00'
    }
  })),
  register: vi.fn(async ({ username }: { username: string }) => ({
    token: `token-reg-${username}`,
    user: {
      id: 9,
      username,
      nickname: '新同学',
      avatar: 'n.png',
      creditScore: 100,
      status: 'active',
      role: 'user',
      createTime: '2026-09-10T00:00:00'
    }
  })),
  getProfile: vi.fn(async () => ({
    id: 1,
    username: 'cs_xiao_zhang',
    nickname: '计算机小张',
    avatar: 'a.png',
    creditScore: 98,
    status: 'active',
    role: 'user',
    createTime: '2026-08-15T10:23:00'
  }))
}))

import { useUserStore } from '@/stores/modules/user'
import { useCartStore } from '@/stores/modules/cart'

describe('useUserStore · 用户状态管理', () => {
  beforeEach(() => {
    localStorage.clear()
    const pinia = createPinia()
    pinia.use(piniaPluginPersistedstate)
    createApp({}).use(pinia)
    setActivePinia(pinia)
  })

  it('初始状态应为未登录', () => {
    const user = useUserStore()
    expect(user.token).toBe('')
    expect(user.profile).toBeNull()
    expect(user.isLoggedIn).toBe(false)
    expect(user.isAdmin).toBe(false)
  })

  it('未登录时 getter 应返回兜底值', () => {
    const user = useUserStore()
    expect(user.nickname).toBe('未登录')
    expect(user.avatar).toBe('')
    expect(user.creditScore).toBe(100)
  })

  it('login() 应写入 token / profile / roles', async () => {
    const user = useUserStore()
    await user.login({ username: 'cs_xiao_zhang', password: '123456' })
    expect(user.token).toBe('token-cs_xiao_zhang')
    expect(user.profile?.nickname).toBe('计算机小张')
    expect(user.roles).toEqual(['user'])
    expect(user.isLoggedIn).toBe(true)
  })

  it('以 admin 登录后 isAdmin 应为 true', async () => {
    const user = useUserStore()
    await user.login({ username: 'admin', password: 'admin123' })
    expect(user.isAdmin).toBe(true)
    expect(user.roles).toContain('admin')
  })

  it('login() 应返回用户对象供调用方使用', async () => {
    const user = useUserStore()
    const u = await user.login({ username: 'a', password: '123456' })
    expect(u.nickname).toBe('计算机小张')
  })

  it('register() 应同样建立登录态', async () => {
    const user = useUserStore()
    await user.register({ username: 'newbie', password: '123456', nickname: '新同学' })
    expect(user.token).toBe('token-reg-newbie')
    expect(user.isLoggedIn).toBe(true)
  })

  it('fetchProfile() 应刷新用户资料', async () => {
    const user = useUserStore()
    user.token = 't'
    const u = await user.fetchProfile()
    expect(u.username).toBe('cs_xiao_zhang')
    expect(user.profile?.username).toBe('cs_xiao_zhang')
    expect(user.roles).toEqual(['user'])
  })

  it('logout() 应清空全部登录态', async () => {
    const user = useUserStore()
    await user.login({ username: 'cs_xiao_zhang', password: '123456' })
    user.logout()
    expect(user.token).toBe('')
    expect(user.profile).toBeNull()
    expect(user.roles).toEqual([])
    expect(user.isLoggedIn).toBe(false)
  })

  it('加购后 logout()，购物车应清空', async () => {
    const user = useUserStore()
    const cart = useCartStore()
    await user.login({ username: 'cs_xiao_zhang', password: '123456' })
    cart.add({ goodsId: 1, title: '旧书', listPrice: 10, price: 10, stock: 1, cover: '', quantity: 1, addedAt: Date.now() })
    expect(cart.totalCount).toBe(1)
    user.logout()
    // 购物车存的是该账号的价格快照视图，登出须清空，避免下一账号看到/下单别人的车
    expect(cart.totalCount).toBe(0)
  })

  it('加购后 revoke()，购物车应清空', async () => {
    const user = useUserStore()
    const cart = useCartStore()
    await user.login({ username: 'cs_xiao_zhang', password: '123456' })
    cart.add({ goodsId: 2, title: '耳机', listPrice: 50, price: 50, stock: 1, cover: '', quantity: 1, addedAt: Date.now() })
    expect(cart.totalCount).toBe(1)
    user.revoke('banned', '账号已被封禁')
    expect(cart.totalCount).toBe(0)
  })

  it('setToken() 应能单独写入 token', () => {
    const user = useUserStore()
    user.setToken('manual-token')
    expect(user.token).toBe('manual-token')
    expect(user.isLoggedIn).toBe(true)
  })

  it('token 应持久化到 localStorage（key = c2c-user），profile 不持久化', async () => {
    const user = useUserStore()
    await user.login({ username: 'cs_xiao_zhang', password: '123456' })
    await new Promise((r) => setTimeout(r, 0))
    const raw = localStorage.getItem('c2c-user')
    expect(raw).toBeTruthy()
    expect(raw).toContain('token')
    // paths 只导出 token，出于安全考虑不落盘用户资料
    expect(raw).not.toContain('creditScore')
  })
})

/* ====================================================================
 * D9 · 凭据从 localStorage 搬进 HttpOnly Cookie
 * ====================================================================
 * ★ 这一组要钉住的是一件"看不见"的事 ★
 * 把凭据挪进 Cookie，最大的风险不是新路径不通，而是**顺手把演示身份还原
 * 与「刷新保持登录」一起弄坏**（这两件事原来都搭在 token 上）。
 * 所以两个方向都要钉：
 *   · 真实模式（VITE_USE_MOCK=false）：凭据**不得**出现在任何 JS 可读的存储里；
 *   · mock 模式（默认值）：`mock-token-*` **必须**照旧持久化。
 * 只测一个方向的话，"把能力删掉"也能让测试变绿 —— 所以下面两种模式各有一组，
 * 互为对照（对照组的每一项都点名了"它必须仍然成立"）。
 *
 * ⚠️ 模式必须靠 `vi.stubEnv` + `vi.resetModules()` + 动态 import 三件套来切：
 * 被测代码里 `const USE_MOCK = import.meta.env.VITE_USE_MOCK === 'true'` 是
 * **模块加载时**求值的，少了 resetModules 拿到的还是上一次加载的旧模块
 * （模式根本没换，测试会"空转通过"）。这也解释了为什么本文件顶部那份静态 import
 * 不受影响 —— 它早已在默认模式（.env.test 的 true）下实例化完毕。
 */
const USER_KEY = 'c2c-user'

/** 按指定模式加载**一份全新的** store / session 模块实例 */
async function loadFresh(useMock: boolean) {
  vi.stubEnv('VITE_USE_MOCK', useMock ? 'true' : 'false')
  vi.resetModules()
  const [storeMod, sessionMod] = await Promise.all([
    import('@/stores/modules/user'),
    import('@/api/session')
  ])
  return { useUserStore: storeMod.useUserStore, readToken: sessionMod.readToken }
}

function freshPinia() {
  const pinia = createPinia()
  pinia.use(piniaPluginPersistedstate)
  createApp({}).use(pinia)
  setActivePinia(pinia)
}

describe('useUserStore · D9 真实模式（凭据只在 HttpOnly Cookie）', () => {
  beforeEach(() => {
    localStorage.clear()
    logoutSpy.mockClear()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('登录成功后：凭据一个字符都不许落进 localStorage，但登录态要成立', async () => {
    const { useUserStore } = await loadFresh(false)
    freshPinia()
    const user = useUserStore()

    await user.login({ username: 'cs_xiao_zhang', password: '123456' })
    await new Promise((r) => setTimeout(r, 0))

    // ① 能力：登录成功（不能因为"没存 token"就被当成未登录）
    expect(user.isLoggedIn).toBe(true)
    expect(user.profile?.nickname).toBe('计算机小张')
    // ② 能力：store 自己不持有凭据
    expect(user.token).toBe('')
    // ③ 能力（核心）：整个 localStorage 搜不到那张票
    const dump = Object.keys(localStorage).map((k) => `${k}=${localStorage.getItem(k)}`).join('\n')
    expect(dump).not.toContain('token-cs_xiao_zhang')
    expect(JSON.parse(localStorage.getItem(USER_KEY)!).token).toBe('')
  })

  it('刷新后仍是已登录，依据是不含凭据的 sessionHint（profile 仍要重新取）', async () => {
    const first = await loadFresh(false)
    freshPinia()
    await first.useUserStore().login({ username: 'cs_xiao_zhang', password: '123456' })
    await new Promise((r) => setTimeout(r, 0))
    expect(String(localStorage.getItem(USER_KEY))).toContain('"sessionHint":true')

    // 模拟 F5：模块缓存清掉 + 全新 Pinia，只靠磁盘上的持久化数据还原
    const { useUserStore } = await loadFresh(false)
    freshPinia()
    const after = useUserStore()

    expect(after.isLoggedIn).toBe(true)
    // profile 不持久化（含手机号等个人信息），必须由守卫 fetchProfile 重新取
    expect(after.profile).toBeNull()
  })

  it('readToken() 在真实模式恒返回空串 —— 即便有人把凭据写回了 localStorage', async () => {
    // 种一张"上一版实现遗留"的凭据，模拟凭据回流
    localStorage.setItem(USER_KEY, JSON.stringify({ token: 'mock-token-user-1' }))

    const { readToken } = await loadFresh(false)
    expect(readToken()).toBe('')
  })

  it('logout() 必须通知服务端清票（HttpOnly Cookie 前端删不掉）', async () => {
    const { useUserStore } = await loadFresh(false)
    freshPinia()
    const user = useUserStore()
    await user.login({ username: 'cs_xiao_zhang', password: '123456' })

    user.logout()
    await new Promise((r) => setTimeout(r, 0))

    expect(logoutSpy).toHaveBeenCalledTimes(1)
    expect(user.isLoggedIn).toBe(false)
    expect(user.sessionHint).toBe(false)
    expect(user.profile).toBeNull()
  })

  it('被踢（revoke）要同时清 sessionHint 并通知服务端清票', async () => {
    const { useUserStore } = await loadFresh(false)
    freshPinia()
    const user = useUserStore()
    await user.login({ username: 'cs_xiao_zhang', password: '123456' })

    user.revoke('banned', '你的账号已被封禁')
    await new Promise((r) => setTimeout(r, 0))

    // 不清 sessionHint 的话，路由守卫会继续认为"人还在"并放行
    expect(user.isLoggedIn).toBe(false)
    expect(user.sessionHint).toBe(false)
    expect(user.revoked).toBe('banned')
    // 票据已失效，留着只会让之后每个请求反复拿到 401
    expect(logoutSpy).toHaveBeenCalledTimes(1)
  })

  it('登出后刷新不得「复活」（持久化里的标记也要跟着变成 false）', async () => {
    const first = await loadFresh(false)
    freshPinia()
    const user = first.useUserStore()
    await user.login({ username: 'cs_xiao_zhang', password: '123456' })
    user.logout()
    await new Promise((r) => setTimeout(r, 0))

    const { useUserStore } = await loadFresh(false)
    freshPinia()
    expect(useUserStore().isLoggedIn).toBe(false)
  })
})

describe('useUserStore · D9 对照组：mock 模式的演示身份不能被一起删掉', () => {
  beforeEach(() => {
    localStorage.clear()
    logoutSpy.mockClear()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('mock 模式下 mock-token 必须照旧持久化，readToken() 也照样读得到', async () => {
    const { useUserStore, readToken } = await loadFresh(true)
    freshPinia()
    const user = useUserStore()

    await user.login({ username: 'cs_xiao_zhang', password: '123456' })
    await new Promise((r) => setTimeout(r, 0))

    expect(user.token).toBe('token-cs_xiao_zhang')
    expect(user.isLoggedIn).toBe(true)
    // ★ 关键对照：没有这一条，"readToken 恒为空"可以靠"把函数写成 return ''"骗过去
    expect(readToken()).toBe('token-cs_xiao_zhang')
  })

  it('mock 模式下 logout() 不发请求（没有后端可清）', async () => {
    const { useUserStore } = await loadFresh(true)
    freshPinia()
    const user = useUserStore()
    await user.login({ username: 'cs_xiao_zhang', password: '123456' })

    user.logout()
    await new Promise((r) => setTimeout(r, 0))

    /*
     * ★ 这是一条**反向对照**，所以只断言"没发请求"这一件事 ★
     * 若这里顺带断言"本地状态也清了"，那么"把 logout 清状态那几行删掉"的突变
     * 会让这条对照用例一起变红 —— 对照就失去了"只看着它、别的一概不管"的意义，
     * 探针那轮的 red 清单也会把两条互不相干的后果混在一起（实测已发生过）。
     * 本地状态是否清干净，由真实模式那组用例与上面「logout() 应清空全部登录态」负责。
     */
    expect(logoutSpy).not.toHaveBeenCalled()
  })
})
