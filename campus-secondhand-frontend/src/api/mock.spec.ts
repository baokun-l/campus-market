/**
 * 静态数据测试 · JSON 静态数据源
 *
 * 本文件对应实践任务2「静态测试」要求：
 *   ① 测试数据：src/api/mock.ts 中的 JSON 静态数据集（无后端依赖）
 *   ② 测试结果：本文件全部用例的执行结果
 *
 * 覆盖对象：
 *   - mockCategories   分类静态数据（9 条，含兜底分类「其他」）
 *   - demoAccounts     演示账号静态数据
 *   - mockNotices      公告静态数据
 *   - mockCategoryPie  分类占比静态数据（ECharts 饼图数据源）
 *   - buildTrendData() 趋势图静态数据生成器
 *   - mockHelpers      商品/订单/收藏/足迹/地址/会话/消息 缓存数据集
 *   - makeSessionId()  会话 ID 生成规则（纯函数）
 *   - mockAutoReply()  自动回复语料
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  mockCategories,
  mockNotices,
  demoAccounts,
  mockCategoryPie,
  buildTrendData,
  makeSessionId,
  mockAutoReply,
  mockHelpers,
  mockUsersExport
} from '@/api/mock'

/* ============================================================
 * 一、分类静态数据
 * ============================================================ */
describe('① 静态数据 · 商品分类 mockCategories', () => {
  it('应为非空数组，且包含 9 个一级分类（8 个实体品类 + 兜底「其他」）', () => {
    expect(Array.isArray(mockCategories)).toBe(true)
    expect(mockCategories.length).toBe(9)
  })

  it('应提供兜底分类「其他」，供无法归类的商品落脚', () => {
    const other = mockCategories.find((c) => c.name === '其他')
    expect(other, '缺少兜底分类「其他」时，卖家只能硬塞进不相干的分类').toBeTruthy()
    // 兜底分类必须是最后一个：新增品类一律追加，不能插队打乱既有 id
    expect(mockCategories[mockCategories.length - 1].id).toBe(other!.id)
  })

  it('每条分类的 id / name / icon 字段都应存在且非空', () => {
    mockCategories.forEach((c) => {
      expect(typeof c.id).toBe('number')
      expect(c.name.length).toBeGreaterThan(0)
      expect(c.icon.length).toBeGreaterThan(0)
    })
  })

  it('分类 id 应全局唯一（无重复主键）', () => {
    const ids = mockCategories.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('分类名称应全局唯一（无重复展示项）', () => {
    const names = mockCategories.map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
  })
})

/* ============================================================
 * 二、演示账号静态数据
 * ============================================================ */
describe('② 静态数据 · 演示账号 demoAccounts', () => {
  /*
   * 不再断言「正好 4 个」这种魔数：账号清单本来就会随测试需求增减，
   * 写死数量只会让每次加账号都要改测试，而测试并没有因此更可靠。
   * 这里改为锁定**必须存在**的几类账号 —— 少一个就真的会影响验证能力。
   */
  it('应包含管理员、普通用户各至少一个（覆盖双角色登录验证）', () => {
    const names = demoAccounts.map((a) => a.username)
    expect(names).toContain('admin')
    expect(names).toContain('cs_xiao_zhang')
  })

  it('应包含一个「已封禁」账号，便于手工验证封禁限制生效', () => {
    // 这条反例是产品能力的一部分：没有它，「封禁账号登不进来」
    // 就只能靠去用户表里翻账号名来验证，等于没有入口
    // （原「待审核」反例已随 D11 拆除：用户注册即 active，无第三态）
    const banned = mockUsersExport.find((u) => u.username === 'cloth_wu')
    expect(banned?.status).toBe('banned')
    const names = demoAccounts.map((a) => a.username)
    expect(names).toContain('cloth_wu')
  })

  it('演示账号数应覆盖得比演示用户表小（不是把用户表原样倒出来）', () => {
    expect(demoAccounts.length).toBeGreaterThanOrEqual(4)
    expect(demoAccounts.length).toBeLessThan(mockUsersExport.length)
  })

  it('每个账号都应包含用户名、昵称、角色三项展示字段', () => {
    demoAccounts.forEach((a: any) => {
      expect(typeof a.username).toBe('string')
      expect(a.username.length).toBeGreaterThan(0)
      expect(typeof a.nickname).toBe('string')
      expect(a.nickname.length).toBeGreaterThan(0)
      expect(typeof a.role).toBe('string')
      expect(a.role.length).toBeGreaterThan(0)
    })
  })

  it('演示账号的用户名应全局唯一（避免登录时身份冲突）', () => {
    const names = demoAccounts.map((a: any) => a.username)
    expect(new Set(names).size).toBe(names.length)
  })

  it('演示账号用户名应兼容 mock 登录逻辑（非空且无空格）', () => {
    demoAccounts.forEach((a: any) => {
      expect(a.username.trim()).toBe(a.username)
      expect(a.username).not.toContain(' ')
    })
  })
})

/* ============================================================
 * 三、公告静态数据
 * ============================================================ */
describe('③ 静态数据 · 公告 mockNotices', () => {
  it('公告列表非空，字段完整', () => {
    expect(mockNotices.length).toBeGreaterThan(0)
    mockNotices.forEach((n) => {
      expect(typeof n.id).toBe('number')
      expect(n.title.length).toBeGreaterThan(0)
      expect(n.content.length).toBeGreaterThan(0)
      expect(typeof n.pinned).toBe('boolean')
    })
  })

  it('createTime 应为可被 Date 解析的合法时间字符串', () => {
    mockNotices.forEach((n) => {
      expect(Number.isNaN(new Date(n.createTime).getTime())).toBe(false)
    })
  })

  it('置顶公告数量不应超过公告总数', () => {
    const pinned = mockNotices.filter((n) => n.pinned).length
    expect(pinned).toBeLessThanOrEqual(mockNotices.length)
  })
})

/* ============================================================
 * 四、ECharts 饼图静态数据
 * ============================================================ */
describe('④ 静态数据 · 分类占比 mockCategoryPie', () => {
  it('数据结构应满足 ECharts 饼图要求（name + value）', () => {
    expect(mockCategoryPie.length).toBeGreaterThan(0)
    mockCategoryPie.forEach((d) => {
      expect(typeof d.name).toBe('string')
      expect(typeof d.value).toBe('number')
      expect(d.value).toBeGreaterThan(0)
    })
  })

  it('各分类占比之和应为正数（用于计算百分比的分母）', () => {
    const total = mockCategoryPie.reduce((acc, d) => acc + d.value, 0)
    expect(total).toBeGreaterThan(0)
  })
})

/* ============================================================
 * 五、趋势图数据生成器
 * ============================================================ */
describe('⑤ 静态数据生成器 · buildTrendData()', () => {
  it('默认返回 7 天数据（首页折线图默认视图）', () => {
    expect(buildTrendData().length).toBe(7)
  })

  it('应支持自定义天数参数', () => {
    expect(buildTrendData(30).length).toBe(30)
    expect(buildTrendData(1).length).toBe(1)
  })

  it('每条数据应包含 date / uv / orders 三个字段', () => {
    buildTrendData(10).forEach((d: any) => {
      expect(d).toHaveProperty('date')
      expect(d).toHaveProperty('uv')
      expect(d).toHaveProperty('orders')
    })
  })

  it('uv 与 orders 应为非负数值（图表不可出现负数）', () => {
    buildTrendData(20).forEach((d: any) => {
      expect(d.uv).toBeGreaterThanOrEqual(0)
      expect(d.orders).toBeGreaterThanOrEqual(0)
    })
  })
})

/* ============================================================
 * 六、会话 ID 生成规则（纯函数）
 * ============================================================ */
describe('⑥ 纯函数 · makeSessionId()', () => {
  it('同一对用户生成的会话 ID 应完全一致（保证双方看到同一条会话）', () => {
    expect(makeSessionId(1, 2)).toBe(makeSessionId(2, 1))
  })

  it('不同用户对生成的会话 ID 应不同', () => {
    expect(makeSessionId(1, 2)).not.toBe(makeSessionId(1, 3))
  })

  it('带商品 ID 时，不同商品应产生不同会话 ID（同人不同商品分开聊）', () => {
    expect(makeSessionId(1, 2, 100)).not.toBe(makeSessionId(1, 2, 200))
  })

  it('返回值应为非空字符串', () => {
    const id = makeSessionId(1, 2, 3)
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)
  })
})

/* ============================================================
 * 七、自动回复语料
 * ============================================================ */
describe('⑦ 纯函数 · mockAutoReply()', () => {
  it('应返回非空字符串', () => {
    const reply = mockAutoReply()
    expect(typeof reply).toBe('string')
    expect(reply.length).toBeGreaterThan(0)
  })

  it('多次调用都应稳定返回有效文案', () => {
    for (let i = 0; i < 20; i++) {
      expect(mockAutoReply().length).toBeGreaterThan(0)
    }
  })
})

/* ============================================================
 * 八、商品静态数据集（核心业务数据）
 * ============================================================ */
describe('⑧ 静态数据 · 商品数据集 mockHelpers.getGoodsCache()', () => {
  it('应生成 60 条商品数据（首页列表分页数据源）', () => {
    expect(mockHelpers.getGoodsCache().length).toBe(60)
  })

  it('每条商品都应包含全部必填字段', () => {
    const required = [
      'id', 'title', 'price', 'cover', 'images', 'description',
      'status', 'categoryId', 'categoryName', 'sellerId',
      'sellerName', 'location', 'viewCount', 'favoriteCount', 'createTime'
    ]
    mockHelpers.getGoodsCache().forEach((g) => {
      required.forEach((k) => expect(g).toHaveProperty(k))
    })
  })

  it('商品 id 应全局唯一', () => {
    const ids = mockHelpers.getGoodsCache().map((g) => g.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('商品价格应为非负数', () => {
    mockHelpers.getGoodsCache().forEach((g) => {
      expect(g.price).toBeGreaterThanOrEqual(0)
    })
  })

  it('商品状态应落在 4 个合法枚举值内', () => {
    const valid = ['on_sale', 'off_shelf', 'sold', 'pending']
    mockHelpers.getGoodsCache().forEach((g) => {
      expect(valid).toContain(g.status)
    })
  })

  it('商品分类应能在 mockCategories 中找到（外键完整性）', () => {
    const validIds = new Set(mockCategories.map((c) => c.id))
    mockHelpers.getGoodsCache().forEach((g) => {
      expect(validIds.has(g.categoryId)).toBe(true)
    })
  })

  it('商品 images 应为数组且至少包含 1 张图', () => {
    mockHelpers.getGoodsCache().forEach((g) => {
      expect(Array.isArray(g.images)).toBe(true)
      expect(g.images.length).toBeGreaterThanOrEqual(1)
    })
  })

  it('浏览量 / 收藏量应为非负整数', () => {
    mockHelpers.getGoodsCache().forEach((g) => {
      expect(Number.isInteger(g.viewCount)).toBe(true)
      expect(g.viewCount).toBeGreaterThanOrEqual(0)
      expect(g.favoriteCount).toBeGreaterThanOrEqual(0)
    })
  })

  it('createTime 应为合法时间字符串', () => {
    mockHelpers.getGoodsCache().forEach((g) => {
      expect(Number.isNaN(new Date(g.createTime).getTime())).toBe(false)
    })
  })

  it('setGoodsCache 应能正确覆写数据集，且可还原', () => {
    const backup = mockHelpers.getGoodsCache()
    const original = backup.length
    mockHelpers.setGoodsCache(backup.slice(0, 5))
    expect(mockHelpers.getGoodsCache().length).toBe(5)
    mockHelpers.setGoodsCache(backup)
    expect(mockHelpers.getGoodsCache().length).toBe(original)
  })
})

/* ============================================================
 * 九、其他静态数据集
 * ============================================================ */
describe('⑨ 静态数据 · 其他业务数据集', () => {
  it('我的发布数据集非空，且每条都有 id 与标题', () => {
    const list = mockHelpers.getMyGoodsCache()
    expect(list.length).toBeGreaterThan(0)
    list.forEach((g) => {
      expect(typeof g.id).toBe('number')
      expect(g.title.length).toBeGreaterThan(0)
    })
  })

  it('订单数据集非空，状态应落在合法枚举内', () => {
    const valid = [
      'pending_payment', 'pending_ship', 'shipped',
      'received', 'completed', 'refunding', 'cancelled'
    ]
    const orders = mockHelpers.getOrderCache()
    expect(orders.length).toBeGreaterThan(0)
    orders.forEach((o) => {
      expect(valid).toContain(o.status)
    })
  })

  it('订单金额应为非负数', () => {
    mockHelpers.getOrderCache().forEach((o) => {
      expect(o.amount).toBeGreaterThanOrEqual(0)
    })
  })

  it('收藏数据集非空，且每条都关联有效商品', () => {
    const favs = mockHelpers.getFavorites()
    expect(favs.length).toBeGreaterThan(0)
    favs.forEach((f) => {
      expect(f.goodsId).toBeGreaterThan(0)
    })
  })

  it('浏览足迹数据集非空，含浏览时间字段', () => {
    const history = mockHelpers.getHistory()
    expect(history.length).toBeGreaterThan(0)
    history.forEach((h) => {
      expect(h.viewTime.length).toBeGreaterThan(0)
    })
  })

  it('收货地址数据集非空，且恰好有 1 条默认地址', () => {
    const addrs = mockHelpers.getAddresses()
    expect(addrs.length).toBeGreaterThan(0)
    const defaults = addrs.filter((a) => a.isDefault)
    expect(defaults.length).toBe(1)
  })

  it('收货地址手机号应满足 11 位手机号格式', () => {
    mockHelpers.getAddresses().forEach((a) => {
      expect(/^1[3-9]\d{9}$/.test(a.phone)).toBe(true)
    })
  })

  it('消息数据集非空，read 字段应为布尔值', () => {
    const msgs = mockHelpers.getMessages()
    expect(msgs.length).toBeGreaterThan(0)
    msgs.forEach((m) => {
      expect(typeof m.read).toBe('boolean')
      expect(m.content.length).toBeGreaterThan(0)
    })
  })

  it('会话数据集与消息数据集应有关联（会话 id 在消息中出现）', () => {
    const sessionIds = new Set(mockHelpers.getSessions().map((s) => s.id))
    expect(sessionIds.size).toBeGreaterThan(0)
    const msgs = mockHelpers.getMessages()
    const matched = msgs.filter((m) => sessionIds.has(m.sessionId))
    expect(matched.length).toBeGreaterThan(0)
  })

  it('nextMessageId() 应返回大于现有全部消息 id 的值', () => {
    const maxId = Math.max(...mockHelpers.getMessages().map((m) => m.id))
    expect(mockHelpers.nextMessageId()).toBe(maxId + 1)
  })
})

/* ============================================================
 * 十、测试隔离性验证
 * ============================================================ */
describe('⑩ 测试环境 · localStorage 隔离', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('localStorage 应在每个用例前被清空', () => {
    expect(localStorage.length).toBe(0)
    localStorage.setItem('probe', '1')
    expect(localStorage.length).toBe(1)
  })

  it('上一个用例写入的数据不应污染当前用例', () => {
    expect(localStorage.getItem('probe')).toBeNull()
  })
})
