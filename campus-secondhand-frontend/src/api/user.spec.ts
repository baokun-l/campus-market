/**
 * API 层单元测试 · 用户模块（Mock 模式 / JSON 静态数据源）
 * 覆盖：登录 / 注册 / 资料还原 / 管理端用户 / 我的商品 / 收藏 / 足迹 / 地址
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  login,
  register,
  getProfile,
  fetchUsers,
  toggleUserStatus,
  fetchPublicProfile,
  fetchMyGoods,
  toggleMyGoods,
  deleteMyGoods,
  fetchFavorites,
  removeFavorite,
  toggleFavorite,
  fetchHistory,
  clearHistory,
  removeHistory,
  recordHistory,
  fetchAddresses,
  saveAddress,
  deleteAddress
} from '@/api/user'
import { publishGoods } from '@/api/goods'
import { mockHelpers, mockUsersExport } from '@/api/mock'
import { SessionRevokedError } from '@/api/session'
import type { Goods } from '@/types'

/** 找一件「审核中」的我的商品（演示数据里固定种了一件，用来验证审核拦截） */
function pendingMyGoods(): Goods | null {
  return mockHelpers.getMyGoodsCache().find((g) => g.status === 'pending') ?? null
}

describe('login() · 登录', () => {
  beforeEach(() => localStorage.clear())

  it('admin / admin123 应登录为管理员并返回管理员 token', async () => {
    const { token, user } = await login({ username: 'admin', password: 'admin123' })
    expect(token).toBe('mock-token-admin')
    expect(user.role).toBe('admin')
  })

  it('已存在的演示账号应返回对应身份（用于验证「对方视角」）', async () => {
    const demo = mockUsersExport[1]
    const { token, user } = await login({ username: demo.username, password: '123456' })
    expect(user.id).toBe(demo.id)
    expect(token).toBe(`mock-token-user-${demo.id}`)
  })

  it('未知用户名应回落到默认账号（计算机小张）', async () => {
    const { user } = await login({ username: 'who_am_i', password: '123456' })
    expect(user.id).toBe(mockUsersExport[0].id)
  })

  it('密码不足 6 位应抛出「密码至少 6 位」', async () => {
    await expect(login({ username: 'random_user', password: '123' })).rejects.toThrow('密码至少 6 位')
  })

  it('已存在账号密码不足 6 位同样应被拒绝', async () => {
    await expect(
      login({ username: mockUsersExport[1].username, password: '1' })
    ).rejects.toThrow('密码至少 6 位')
  })

  it('admin 账号密码错误时应被拒绝，不得回落到管理员身份', async () => {
    // 回归测试：修复前「admin + 任意 6 位密码」即可拿到管理员权限
    await expect(login({ username: 'admin', password: 'wrongpass' })).rejects.toThrow('管理员密码错误')
  })

  it('admin 使用正确密码时仍可正常登录为管理员', async () => {
    const { user } = await login({ username: 'admin', password: 'admin123' })
    expect(user.role).toBe('admin')
  })
})

describe('register() · 注册', () => {
  it('新用户名应注册成功并返回带 id 的用户', async () => {
    const username = `newbie_${Date.now()}`
    const { token, user } = await register({ username, password: '123456', nickname: '新同学' })
    expect(user.username).toBe(username)
    expect(user.nickname).toBe('新同学')
    expect(user.role).toBe('user')
    expect(user.creditScore).toBe(100)
    expect(token).toBe(`mock-token-register-${user.id}`)
  })

  it('重复用户名应抛出「该用户名已被占用」', async () => {
    await expect(
      register({ username: mockUsersExport[0].username, password: '123456', nickname: 'x' })
    ).rejects.toThrow('该用户名已被占用')
  })

  it('注册后应写入静态用户数据集', async () => {
    const before = mockUsersExport.length
    const username = `inject_${Date.now()}`
    await register({ username, password: '123456', nickname: 'n' })
    expect(mockUsersExport.length).toBe(before + 1)
    expect(mockUsersExport.some((u) => u.username === username)).toBe(true)
  })

  it('新用户头像应为自动生成的占位图', async () => {
    const { user } = await register({ username: `av_${Date.now()}`, password: '123456', nickname: 'n' })
    expect(user.avatar).toMatch(/^https?:\/\//)
  })
})

describe('getProfile() · 资料还原', () => {
  beforeEach(() => localStorage.clear())

  /*
   * ⚠️ 这两条用例原本断言的是「无 token / localStorage 损坏 → 兜底返回默认账号」。
   * 那个兜底正是「封禁形同虚设」的帮凶之一：任何无效 token 都能换到一个可用身份。
   * 现在改成断言**正确的行为**：认不出就是未登录（抛 expired），由守卫送回登录页。
   */
  it('无 token 时不应兜底给一个账号，应抛「登录状态已失效」', async () => {
    await expect(getProfile()).rejects.toBeInstanceOf(SessionRevokedError)
    await expect(getProfile()).rejects.toThrow('登录状态已失效')
  })

  it('持久化 token 为 admin 时应还原管理员身份（刷新不掉权限）', async () => {
    localStorage.setItem('c2c-user', JSON.stringify({ token: 'mock-token-admin' }))
    const u = await getProfile()
    expect(u.role).toBe('admin')
  })

  it('持久化 token 含用户 id 时应还原为对应用户', async () => {
    const demo = mockUsersExport[1]
    localStorage.setItem('c2c-user', JSON.stringify({ token: `mock-token-user-${demo.id}` }))
    const u = await getProfile()
    expect(u.id).toBe(demo.id)
  })

  it('注册 token 也应能被正确还原', async () => {
    const { user } = await register({ username: `gp_${Date.now()}`, password: '123456', nickname: 'n' })
    localStorage.setItem('c2c-user', JSON.stringify({ token: `mock-token-register-${user.id}` }))
    const u = await getProfile()
    expect(u.id).toBe(user.id)
  })

  it('localStorage 数据损坏时应视为未登录（不抛非会话错误，也不给默认账号）', async () => {
    localStorage.setItem('c2c-user', '{broken json')
    await expect(getProfile()).rejects.toBeInstanceOf(SessionRevokedError)
  })
})

describe('fetchUsers() / toggleUserStatus() · 管理端用户', () => {
  it('应返回分页结构', async () => {
    const res = await fetchUsers({})
    expect(res).toHaveProperty('list')
    expect(res).toHaveProperty('total')
    expect(res.page).toBe(1)
    expect(res.pageSize).toBe(10)
  })

  it('关键词应能命中用户名或昵称', async () => {
    const demo = mockUsersExport[1]
    const res = await fetchUsers({ keyword: demo.nickname, pageSize: 100 })
    expect(res.list.length).toBeGreaterThan(0)
  })

  it('无匹配关键词时应返回空列表', async () => {
    const res = await fetchUsers({ keyword: '__不存在__' })
    expect(res.list.length).toBe(0)
    expect(res.total).toBe(0)
  })

  it('toggleUserStatus(true) 应把用户置为 banned', async () => {
    const target = mockUsersExport.find((u) => u.role === 'user')!
    await toggleUserStatus({ id: target.id, banned: true })
    expect(mockUsersExport.find((u) => u.id === target.id)?.status).toBe('banned')
  })

  it('toggleUserStatus(false) 应把用户恢复为 active', async () => {
    const target = mockUsersExport.find((u) => u.role === 'user')!
    await toggleUserStatus({ id: target.id, banned: false })
    expect(mockUsersExport.find((u) => u.id === target.id)?.status).toBe('active')
  })

  it('操作不存在的用户不应抛错', async () => {
    await expect(toggleUserStatus({ id: 999999, banned: true })).resolves.toBeUndefined()
  })

  /* ★ approveUser 用例已随 D11 拆除（2026-09-23）：用户注册即 active，
   * 不再有「待审核 → 审核通过」流程，用户治理只剩封禁/解封（上面两个用例覆盖）。 */

  it('fetchPublicProfile() 应只回公开字段，不存在的用户返回 null', async () => {
    const u = mockUsersExport[1]
    const p = await fetchPublicProfile(u.id)
    expect(p).not.toBeNull()
    expect(p!.nickname).toBe(u.nickname)
    expect(p!.creditScore).toBe(u.creditScore)
    expect(p).not.toHaveProperty('username')
    expect(await fetchPublicProfile(-1)).toBeNull()
  })
})

describe('我的商品 · fetchMyGoods / toggleMyGoods / deleteMyGoods', () => {
  it('「我发布的」应覆盖两个来源：演示商品集 + 商品池里属于我的商品', async () => {
    const res = await fetchMyGoods({ pageSize: 200 })
    // 演示用的 8 件（_myGoodsCache）必须都在
    expect(res.total).toBeGreaterThanOrEqual(mockHelpers.getMyGoodsCache().length)
    // 不变量：返回的每一件都必须是「我的」（sellerId = 当前用户）
    res.list.forEach((g) => expect(g.sellerId).toBe(1))
  })

  it('新发布的商品必须出现在「我发布的」里（回归：发布后个人主页看不到）', async () => {
    const before = (await fetchMyGoods({ pageSize: 200 })).total
    const created = await publishGoods({
      title: '【回归用例】我刚发布的商品',
      price: 66,
      stock: 2,
      categoryId: 1
    })
    const after = await fetchMyGoods({ pageSize: 200 })
    expect(after.total).toBe(before + 1)
    expect(after.list.some((g) => g.id === created.id)).toBe(true)
    // 收尾：删掉，避免污染其它用例的数据集
    await deleteMyGoods(created.id)
  })

  it('审核中的商品不允许自行上架（不得绕过平台审核）', async () => {
    const pending = pendingMyGoods()
    expect(pending, '需要至少一件「审核中」的商品才能验证这道防线').toBeTruthy()
    await expect(toggleMyGoods({ id: pending!.id, status: 'on_sale' })).rejects.toThrow(/审核/)
  })

  it('按状态筛选应只返回对应状态', async () => {
    const res = await fetchMyGoods({ status: 'on_sale', pageSize: 200 })
    res.list.forEach((g) => expect(g.status).toBe('on_sale'))
  })

  it('关键词应命中标题', async () => {
    const first = mockHelpers.getMyGoodsCache()[0]
    const kw = first.title.slice(0, 2)
    const res = await fetchMyGoods({ keyword: kw, pageSize: 200 })
    res.list.forEach((g) => expect(g.title).toContain(kw))
  })

  it('toggleMyGoods 应能下架商品', async () => {
    const target = mockHelpers.getMyGoodsCache().find((g) => g.status === 'on_sale')!
    await toggleMyGoods({ id: target.id, status: 'off_shelf' })
    expect(mockHelpers.getMyGoodsCache().find((g) => g.id === target.id)?.status).toBe('off_shelf')
  })

  it('toggleMyGoods 对不存在的商品应报错', async () => {
    await expect(toggleMyGoods({ id: 987654321, status: 'off_shelf' })).rejects.toThrow(/不存在/)
  })

  it('deleteMyGoods 后总数应 -1', async () => {
    const before = mockHelpers.getMyGoodsCache().length
    const target = mockHelpers.getMyGoodsCache()[0]
    await deleteMyGoods(target.id)
    expect(mockHelpers.getMyGoodsCache().length).toBe(before - 1)
  })
})

describe('收藏 · fetchFavorites / toggleFavorite / removeFavorite', () => {
  it('应返回 12 条收藏，含商品快照', async () => {
    const res = await fetchFavorites({ pageSize: 100 })
    expect(res.total).toBeGreaterThan(0)
    res.list.forEach((f) => {
      expect(f).toHaveProperty('goodsId')
      expect(f).toHaveProperty('goods')
      expect(f).toHaveProperty('createTime')
    })
  })

  it('收藏列表应支持分页', async () => {
    const res = await fetchFavorites({ page: 1, pageSize: 5 })
    expect(res.list.length).toBe(5)
    expect(res.pageSize).toBe(5)
  })

  it('toggleFavorite 对未收藏商品应返回 favorited=true 并写入', async () => {
    const goods = { id: 88888, title: '测试商品', price: 10, cover: 'c', status: 'on_sale', location: 'x', sellerName: 'y' } as Goods
    const before = mockHelpers.getFavorites().length
    const res = await toggleFavorite({ goods })
    expect(res.favorited).toBe(true)
    expect(mockHelpers.getFavorites().length).toBe(before + 1)
  })

  it('toggleFavorite 对已收藏商品应返回 favorited=false 并移除（开关语义）', async () => {
    const goods = { id: 88888, title: '测试商品', price: 10, cover: 'c', status: 'on_sale', location: 'x', sellerName: 'y' } as Goods
    const before = mockHelpers.getFavorites().length
    const res = await toggleFavorite({ goods })
    expect(res.favorited).toBe(false)
    expect(mockHelpers.getFavorites().length).toBe(before - 1)
  })

  it('收藏快照应裁剪为必要字段（不存整份商品对象）', async () => {
    const goods = { id: 88889, title: '裁剪测试', price: 20, cover: 'c', status: 'on_sale', location: 'loc', sellerName: 'seller' } as Goods
    await toggleFavorite({ goods })
    const saved = mockHelpers.getFavorites().find((f) => f.goodsId === 88889)!
    expect(saved.goods.title).toBe('裁剪测试')
    expect(Object.keys(saved.goods)).not.toContain('description')
  })

  it('removeFavorite 应移除指定商品', async () => {
    const goods = { id: 88890, title: 't', price: 1, cover: 'c', status: 'on_sale', location: 'l', sellerName: 's' } as Goods
    await toggleFavorite({ goods })
    const before = mockHelpers.getFavorites().length
    await removeFavorite(88890)
    expect(mockHelpers.getFavorites().length).toBe(before - 1)
  })
})

describe('浏览足迹 · fetchHistory / recordHistory / removeHistory / clearHistory', () => {
  it('应返回 18 条足迹', async () => {
    const res = await fetchHistory({})
    expect(res.total).toBe(18)
  })

  it('应支持分页，默认每页 15 条', async () => {
    const res = await fetchHistory()
    expect(res.pageSize).toBe(15)
    expect(res.list.length).toBe(15)
  })

  it('recordHistory 应把新浏览的商品写到最前（回归：看完商品足迹里没有）', async () => {
    // 种子足迹只覆盖部分商品：取一件**确定没被浏览过**的，
    // 否则 recordHistory 会走「去重前移」分支，长度断言必然落空
    const viewed = new Set(mockHelpers.getHistory().map((h) => h.goodsId))
    const goods = mockHelpers.getGoodsCache().find((g) => !viewed.has(g.id))
    expect(goods, '商品池应大于种子足迹的覆盖范围').toBeTruthy()

    const before = mockHelpers.getHistory().length
    await recordHistory({ goods: goods! })
    const list = mockHelpers.getHistory()
    expect(list.length).toBe(before + 1)
    expect(list[0].goodsId).toBe(goods!.id)
    // 快照字段要能支撑足迹列表渲染（标题/封面/价格）
    expect(list[0].goods.title).toBe(goods!.title)
    expect(list[0].goods.cover).toBe(goods!.cover)
  })

  it('同一件商品重复浏览只保留最近一次，不重复堆叠', async () => {
    const goods = mockHelpers.getGoodsCache().find((g) => g.id === 43)!
    await recordHistory({ goods })
    const n = mockHelpers.getHistory().length
    await recordHistory({ goods })
    const list = mockHelpers.getHistory()
    expect(list.length).toBe(n)
    expect(list.filter((h) => h.goodsId === 43).length).toBe(1)
  })

  it('removeHistory 应删除一条记录', async () => {
    const before = mockHelpers.getHistory().length
    const target = mockHelpers.getHistory()[0]
    await removeHistory(target.id)
    expect(mockHelpers.getHistory().length).toBe(before - 1)
  })

  it('clearHistory 应清空全部足迹', async () => {
    await clearHistory()
    expect(mockHelpers.getHistory().length).toBe(0)
    const res = await fetchHistory()
    expect(res.total).toBe(0)
  })
})

describe('收货地址 · fetchAddresses / saveAddress / deleteAddress', () => {
  beforeEach(() => {
    // 每次重置为 2 条标准静态地址
    mockHelpers.setAddresses([
      { id: 1, receiver: '刘宝坤', phone: '13800138001', region: '北京市/海淀区/学院路街道', detail: 'XX大学南门 13 号宿舍楼 502', isDefault: true, tag: '宿舍' },
      { id: 2, receiver: '刘宝坤', phone: '13800138002', region: '北京市/海淀区/中关村南大街', detail: 'XX大学计算机学院 308 室', isDefault: false, tag: '学院' }
    ])
  })

  it('应返回地址列表', async () => {
    const list = await fetchAddresses()
    expect(list.length).toBe(2)
  })

  it('新增地址应自动分配 id 并写入列表', async () => {
    const before = mockHelpers.getAddresses().length
    const saved = await saveAddress({
      id: 0,
      receiver: '张三',
      phone: '13900139000',
      region: '上海市/浦东新区',
      detail: '某小区 1 号',
      isDefault: false
    } as any)
    expect(saved.id).toBeGreaterThan(0)
    expect(mockHelpers.getAddresses().length).toBe(before + 1)
  })

  it('设为默认地址时应清除其他地址的默认标记（全局仅一个默认）', async () => {
    await saveAddress({
      id: 0,
      receiver: '李四',
      phone: '13700137000',
      region: '广州市/天河区',
      detail: '某路 2 号',
      isDefault: true
    } as any)
    const defaults = mockHelpers.getAddresses().filter((a) => a.isDefault)
    expect(defaults.length).toBe(1)
    expect(defaults[0].receiver).toBe('李四')
  })

  it('按 id 保存应更新已有地址而非新增', async () => {
    const before = mockHelpers.getAddresses().length
    await saveAddress({
      id: 1,
      receiver: '改名后',
      phone: '13800138001',
      region: '北京市/海淀区/学院路街道',
      detail: '新地址',
      isDefault: true
    } as any)
    expect(mockHelpers.getAddresses().length).toBe(before)
    expect(mockHelpers.getAddresses().find((a) => a.id === 1)?.receiver).toBe('改名后')
  })

  it('deleteAddress 应移除指定地址', async () => {
    await deleteAddress(2)
    expect(mockHelpers.getAddresses().some((a) => a.id === 2)).toBe(false)
    expect(mockHelpers.getAddresses().length).toBe(1)
  })

  it('删除不存在的地址不应抛错', async () => {
    await expect(deleteAddress(99999)).resolves.toBeUndefined()
  })
})
