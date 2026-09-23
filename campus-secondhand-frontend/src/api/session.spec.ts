/**
 * 会话与账号状态校验 · 单元测试
 *
 * 这一组用例锁的是「**被封禁的账号不能再用**」这件事。
 * 修复前它有三个漏洞，任何一个漏掉都等于封禁没做：
 *   ① `login()` 不看 `status` —— 封了还能登进来；
 *   ② `getProfile()` 不看 `status` —— 封了只要刷新就复活；
 *   ③ 路由守卫 `catch { /* ignore *\/ }` 吞掉错误 —— token 还在，`isLoggedIn` 仍为真。
 * 所以这三条路径各配断言，避免以后只修一处又漏回去。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  SESSION_KEY,
  SessionRevokedError,
  readToken,
  isAdminToken,
  resolveSessionUser,
  rejectReasonOf,
  assertSessionActive,
  recheckSession,
  bannedMessage
} from '@/api/session'
import { login, getProfile } from '@/api/user'
import { publishGoods } from '@/api/goods'
import { mockHelpers, mockUsersExport } from '@/api/mock'

/** 把某个用户「登录」进 localStorage（模拟持久化 token 的还原路径） */
function signInAs(id: number) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ token: `mock-token-user-${id}` }))
}
function signInAsAdmin() {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ token: 'mock-token-admin' }))
}
const userById = (id: number) => mockUsersExport.find((u) => u.id === id)!

/** 跑一段必然抛错的逻辑并把错误对象取回来（避免写成永远为真的 try/catch 断言） */
function captureError(fn: () => unknown): unknown {
  try {
    fn()
  } catch (e) {
    return e
  }
  return 'NO_ERROR_THROWN'
}

/** 找一个非管理员用户，并临时把它改成指定状态（用完还原）。用户只有 active/banned 两态（D11 拆除） */
async function withStatus<T>(id: number, status: 'active' | 'banned', fn: () => Promise<T>) {
  const u = userById(id)
  const before = u.status
  u.status = status
  try {
    return await fn()
  } finally {
    u.status = before
  }
}

describe('session · token 解析', () => {
  beforeEach(() => localStorage.clear())

  it('未登录时 readToken 返回空串，不抛错', () => {
    expect(readToken()).toBe('')
    localStorage.setItem(SESSION_KEY, '这不是 JSON')
    expect(readToken()).toBe('')
  })

  it('管理员 token 应解析回管理员账号', () => {
    signInAsAdmin()
    expect(isAdminToken()).toBe(true)
    expect(resolveSessionUser()?.role).toBe('admin')
  })

  it('普通用户 token 应解析回对应账号（而不是兜底成第一个人）', () => {
    const target = userById(3)
    signInAs(target.id)
    expect(resolveSessionUser()?.id).toBe(target.id)
  })

  it('认不出来的 token 一律返回 null —— 不再兜底成某个可用账号', () => {
    // 回归测试：修复前 getProfile() 会 return mockUsersExport[0]，
    // 等于任何乱写的 token 都能换来一个可用身份
    localStorage.setItem(SESSION_KEY, JSON.stringify({ token: 'mock-token-user-999999' }))
    expect(resolveSessionUser()).toBeNull()
    localStorage.setItem(SESSION_KEY, JSON.stringify({ token: '垃圾token' }))
    expect(resolveSessionUser()).toBeNull()
  })
})

describe('session · 账号状态判定', () => {
  it('active 放行、banned 拦下（pending 已随 D11 拆除，用户只有两态）', () => {
    const u = userById(1)
    const before = u.status
    u.status = 'active'
    expect(rejectReasonOf(u)).toBeNull()
    u.status = 'banned'
    expect(rejectReasonOf(u)).toBe('banned')
    u.status = before
  })

  it('封禁文案里带昵称，便于用户对号', () => {
    const u = userById(8)
    expect(bannedMessage(u)).toContain(u.nickname)
    expect(bannedMessage(u)).toContain('封禁')
  })

  it('assertSessionActive：封禁抛 banned、token 认不出抛 expired、正常返回本人', () => {
    localStorage.clear()
    // 未登录 → expired（用「捕获到的实参」断言，避免写成永远为真的 try/catch）
    const noToken = captureError(() => assertSessionActive())
    expect(noToken).toBeInstanceOf(SessionRevokedError)
    expect((noToken as SessionRevokedError).reason).toBe('expired')

    signInAs(1)
    expect(assertSessionActive().id).toBe(1)
  })

  it('recheckSession 是同步的：内存里一改状态立刻能反映', async () => {
    signInAs(1)
    expect(recheckSession()).toBeNull()
    await withStatus(1, 'banned', async () => {
      expect(recheckSession()).toBe('banned')
    })
    expect(recheckSession()).toBeNull()
  })
})

describe('login() · 状态闸门（漏洞 ①）', () => {
  beforeEach(() => localStorage.clear())

  it('被封禁的账号不能登录，且提示里点明「封禁」', async () => {
    const banned = mockUsersExport.find((u) => u.status === 'banned')
    expect(banned, '种子数据里应有已封禁账号，否则这条用例形同虚设').toBeTruthy()
    await expect(login({ username: banned!.username, password: '123456' })).rejects.toThrow(/封禁/)
  })

  it('临时封禁一个正常账号后，它也应登不进来（不是只认种子里的那一个）', async () => {
    const u = userById(2)
    await withStatus(u.id, 'banned', async () => {
      await expect(login({ username: u.username, password: '123456' })).rejects.toThrow(/封禁/)
    })
    // 解封后恢复可登录
    const { user } = await login({ username: u.username, password: '123456' })
    expect(user.id).toBe(u.id)
  })

  /* ★ 「待审核账号可以登录」用例已随 D11 拆除（2026-09-23）：
   * 用户注册即 active，不存在 pending 账号，登录闸门只看 banned。 */
})

describe('getProfile() · 还原闸门（漏洞 ②）', () => {
  beforeEach(() => localStorage.clear())

  it('正常 token 还原本人（管理员刷新后仍是管理员）', async () => {
    signInAsAdmin()
    expect((await getProfile()).role).toBe('admin')
    signInAs(2)
    expect((await getProfile()).id).toBe(2)
  })

  it('已封禁账号的 token 不应还原成功 —— 刷新不能复活', async () => {
    const banned = mockUsersExport.find((u) => u.status === 'banned')!
    signInAs(banned.id)
    await expect(getProfile()).rejects.toBeInstanceOf(SessionRevokedError)
  })

  it('无效 token 抛 expired（而不是悄悄给一个默认账号）', async () => {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ token: 'mock-token-user-999999' }))
    try {
      await getProfile()
      throw new Error('本应抛错')
    } catch (e) {
      expect(e).toBeInstanceOf(SessionRevokedError)
      expect((e as SessionRevokedError).reason).toBe('expired')
    }
  })
})

describe('publishGoods() · 发布闸门', () => {
  beforeEach(() => localStorage.clear())

  /* ★ 「pending 账号发布被拒」用例已随 D11 拆除（2026-09-23）：
   * 发布闸门不再看账号状态，封禁账号连登录都进不来。 */

  it('正常账号可以发布（闸门不能误伤）', async () => {
    const u = userById(1)
    signInAs(u.id)
    const before = mockHelpers.getGoodsCache().length
    const g = await publishGoods({ title: '会话测试商品', price: 12, categoryId: 1 })
    expect(g.id).toBeTruthy()
    expect(mockHelpers.getGoodsCache().length).toBe(before + 1)
  })
})
