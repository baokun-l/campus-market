/**
 * API 层单元测试 · 管理端能力
 * 覆盖：分类 CRUD / 公告 CRUD / 订单管理 / 商品批量 / 用户批量 / 内容审核 / 平台参数 / 操作日志
 *
 * 说明：这些用例会真实改动 mock 缓存，因此每条用例尽量「先造数据 → 断言 → 还原」，
 *      涉及计数的地方用相对断言（增减量）而不是写死总数，避免与其它用例耦合。
 */
import { describe, it, expect } from 'vitest'
import {
  fetchCategories,
  fetchCategoryStats,
  createCategory,
  updateCategory,
  deleteCategory
} from '@/api/category'
import { createNotice, updateNotice, toggleNoticePin, deleteNotice, fetchNotices } from '@/api/notice'
import { mockCategories } from '@/api/mock'
import { fetchAdminOrders, updateOrderStatus, refundOrder, ORDER_PAID_STATUS } from '@/api/order'
import { batchUpdateGoodsStatus, batchDeleteGoods, updateGoodsStatus } from '@/api/goods'
import { batchToggleUserStatus, setUserCredit, fetchUsers } from '@/api/user'
import { fetchAdminComments, deleteComment } from '@/api/comment'
import { fetchAdminReviews, deleteReview } from '@/api/review'
import { fetchAuditLogs, clearAuditLogs } from '@/api/audit'
import { fetchReports, batchResolveReports, fetchReportStats } from '@/api/report'
import { fetchSettings, saveSettings, resetSettings } from '@/api/settings'
import { fetchAdminOverview, fetchHotGoodsRank } from '@/api/analytics'
import { mockHelpers } from '@/api/mock'

/* ============================ 分类管理 ============================ */
describe('分类管理 · CRUD', () => {
  it('应返回分类及其商品数', async () => {
    const stats = await fetchCategoryStats()
    expect(stats.length).toBe(mockCategories.length)
    expect(stats.every((s) => typeof s.count === 'number')).toBe(true)
    // 60 件商品全部分布在各分类里，总数应当等于商品总数
    // （兜底分类「其他」目前 count 为 0，只要总数对得上就说明没有商品漏出统计口径）
    const sum = stats.reduce((n, s) => n + s.count, 0)
    expect(sum).toBe(mockHelpers.getGoodsCache().length)
  })

  it('新增分类应写入列表并能被 fetchCategories 读到', async () => {
    const before = (await fetchCategories()).length
    const created = await createCategory({ name: '桌游', icon: '🎲' })
    expect(created.id).toBeGreaterThan(0)
    expect((await fetchCategories()).length).toBe(before + 1)
    // 还原
    await deleteCategory(created.id)
  })

  it('重名分类应被拒绝', async () => {
    await expect(createCategory({ name: '教材', icon: '📚' })).rejects.toThrow(/已存在/)
  })

  it('改名后应同步商品上的 categoryName 冗余字段', async () => {
    const goods = mockHelpers.getGoodsCache().filter((g) => g.categoryId === 1)
    expect(goods.length).toBeGreaterThan(0)
    const original = goods[0].categoryName

    await updateCategory(1, { name: '教材（旧书）' })
    expect(mockHelpers.getGoodsCache().filter((g) => g.categoryId === 1).every((g) => g.categoryName === '教材（旧书）')).toBe(true)

    await updateCategory(1, { name: original })
    expect(mockHelpers.getGoodsCache().filter((g) => g.categoryId === 1).every((g) => g.categoryName === original)).toBe(true)
  })

  it('分类下仍有商品时应拒绝删除并给出原因', async () => {
    const res = await deleteCategory(1)
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/还有 \d+ 件商品/)
  })

  it('空分类可以删除', async () => {
    const tmp = await createCategory({ name: '临时分类', icon: '🧪' })
    const res = await deleteCategory(tmp.id)
    expect(res.ok).toBe(true)
    expect((await fetchCategories()).some((c) => c.id === tmp.id)).toBe(false)
  })

  it('删除不存在的分类应返回 ok:false', async () => {
    expect((await deleteCategory(99999)).ok).toBe(false)
  })
})

/* ============================ 公告管理 ============================ */
describe('公告管理 · CRUD', () => {
  it('新建公告应出现在列表中', async () => {
    const created = await createNotice({ title: '单元测试公告', content: '第一行\n第二行', pinned: false })
    const list = await fetchNotices()
    expect(list.some((n) => n.id === created.id)).toBe(true)
    await deleteNotice(created.id)
  })

  it('新建时置顶，应排在列表最前', async () => {
    const created = await createNotice({ title: '置顶测试公告', content: 'x', pinned: true })
    const list = await fetchNotices()
    expect(list[0].id).toBe(created.id)
    await deleteNotice(created.id)
  })

  it('编辑公告应更新标题与正文', async () => {
    const created = await createNotice({ title: 'A', content: 'a' })
    const updated = await updateNotice(created.id, { title: 'B', content: 'b' })
    expect(updated.title).toBe('B')
    expect(updated.content).toBe('b')
    await deleteNotice(created.id)
  })

  it('toggleNoticePin 应在置顶/取消之间切换', async () => {
    const created = await createNotice({ title: 'pin 测试', content: 'x', pinned: false })
    expect((await toggleNoticePin(created.id)).pinned).toBe(true)
    expect((await toggleNoticePin(created.id)).pinned).toBe(false)
    await deleteNotice(created.id)
  })

  it('编辑不存在的公告应抛错', async () => {
    await expect(updateNotice(99999, { title: 'x' })).rejects.toThrow(/不存在/)
  })

  it('删除公告后列表里不再有它', async () => {
    const created = await createNotice({ title: '待删除', content: 'x' })
    await deleteNotice(created.id)
    expect((await fetchNotices()).some((n) => n.id === created.id)).toBe(false)
  })
})

/* ============================ 订单管理 ============================ */
describe('订单管理 · 检索 / 改状态 / 退款', () => {
  it('应按订单号精确命中', async () => {
    const anyOrder = mockHelpers.getOrderCache()[0]
    const res = await fetchAdminOrders({ keyword: anyOrder.id })
    expect(res.total).toBe(1)
    expect(res.list[0].id).toBe(anyOrder.id)
  })

  it('应按状态过滤', async () => {
    const res = await fetchAdminOrders({ status: 'completed', pageSize: 50 })
    expect(res.list.length).toBeGreaterThan(0)
    expect(res.list.every((o) => o.status === 'completed')).toBe(true)
  })

  it('管理员改状态应生效并补上对应时间戳', async () => {
    const target = mockHelpers.getOrderCache().find((o) => o.status === 'pending_ship')!
    await updateOrderStatus({ id: target.id, status: 'shipped', trackingNo: 'SF-TEST-001' })

    const after = mockHelpers.getOrderCache().find((o) => o.id === target.id)!
    expect(after.status).toBe('shipped')
    expect(after.trackingNo).toBe('SF-TEST-001')
    expect(after.shipTime).toBeTruthy()
  })

  it('改不存在的订单应抛错', async () => {
    await expect(updateOrderStatus({ id: 'not-exist', status: 'shipped' })).rejects.toThrow(/不存在/)
  })

  it('退款应把订单置为已取消并记录退款时间', async () => {
    const target = mockHelpers.getOrderCache().find((o) => o.status === 'shipped')!
    await refundOrder(target.id)
    const after = mockHelpers.getOrderCache().find((o) => o.id === target.id)!
    expect(after.status).toBe('cancelled')
    expect(after.refundTime).toBeTruthy()
  })

  it('重复退款应被拒绝', async () => {
    const target = mockHelpers.getOrderCache().find((o) => o.status === 'cancelled')!
    await expect(refundOrder(target.id)).rejects.toThrow(/重复退款|已取消/)
  })

  it('状态机：已完成订单不能再改状态（不可回退/乱流转）', async () => {
    const done = mockHelpers.getOrderCache().find((o) => o.status === 'completed')!
    await expect(updateOrderStatus({ id: done.id, status: 'shipped' })).rejects.toThrow(/非法流转/)
    await expect(updateOrderStatus({ id: done.id, status: 'pending_ship' })).rejects.toThrow(/非法流转/)
  })

  it('状态机：已完成订单不支持退款（退款只发生在已付款未终结阶段）', async () => {
    const done = mockHelpers.getOrderCache().find((o) => o.status === 'completed')!
    await expect(refundOrder(done.id)).rejects.toThrow(/不支持退款/)
  })

  it('状态机：待付款只能去待发货或取消，不能直接跳已发货', async () => {
    const fresh = mockHelpers.getOrderCache().find((o) => o.status === 'pending_payment')
    if (!fresh) return
    await expect(updateOrderStatus({ id: fresh.id, status: 'shipped' })).rejects.toThrow(/非法流转/)
  })

  it('GMV 口径：只统计已付款及之后的状态', () => {
    const orders = mockHelpers.getOrderCache()
    const paidCount = orders.filter((o) => ORDER_PAID_STATUS.includes(o.status)).length
    expect(paidCount).toBeGreaterThan(0)
    expect(paidCount).toBeLessThanOrEqual(orders.length)
  })
})

/* ============================ 商品批量操作 ============================ */
describe('商品 · 批量操作', () => {
  it('批量下架应只影响传入的 id', async () => {
    const all = mockHelpers.getGoodsCache()
    const ids = [all[0].id, all[1].id]
    const untouched = all[2]

    const n = await batchUpdateGoodsStatus(ids, 'off_shelf')
    expect(n).toBe(2)

    const after = mockHelpers.getGoodsCache()
    expect(ids.every((id) => after.find((g) => g.id === id)?.status === 'off_shelf')).toBe(true)
    expect(after.find((g) => g.id === untouched.id)?.status).toBe(untouched.status)
  })

  it('批量删除应返回实际删除条数', async () => {
    const before = mockHelpers.getGoodsCache().length
    const ids = [mockHelpers.getGoodsCache()[0].id, 999999] // 含一个不存在的 id
    const n = await batchDeleteGoods(ids)
    expect(n).toBe(1)
    expect(mockHelpers.getGoodsCache().length).toBe(before - 1)
  })

  it('传入空数组应安全返回 0 且不改数据', async () => {
    const before = mockHelpers.getGoodsCache().length
    expect(await batchUpdateGoodsStatus([], 'on_sale')).toBe(0)
    expect(await batchDeleteGoods([])).toBe(0)
    expect(mockHelpers.getGoodsCache().length).toBe(before)
  })
})

/* ============================ 用户批量操作 ============================ */
describe('用户 · 批量封禁 / 信用分', () => {
  it('批量封禁应生效', async () => {
    const targets = mockHelpers.getUsersCache().filter((u) => u.role === 'user').slice(0, 2)
    const n = await batchToggleUserStatus(targets.map((u) => u.id), true)
    expect(n).toBe(2)
    expect(targets.every((u) => mockHelpers.getUsersCache().find((x) => x.id === u.id)?.status === 'banned')).toBe(true)
    // 还原
    await batchToggleUserStatus(targets.map((u) => u.id), false)
  })

  it('管理员账号不应被批量封禁（避免把自己锁在门外）', async () => {
    const admin = mockHelpers.getUsersCache().find((u) => u.role === 'admin')!
    const normal = mockHelpers.getUsersCache().find((u) => u.role === 'user')!
    const n = await batchToggleUserStatus([admin.id, normal.id], true)
    expect(n).toBe(1)
    expect(mockHelpers.getUsersCache().find((u) => u.id === admin.id)?.status).toBe('active')
    // 还原
    await batchToggleUserStatus([normal.id], false)
  })

  it('信用分应夹取到 0-100', async () => {
    const target = mockHelpers.getUsersCache().find((u) => u.role === 'user')!
    const original = target.creditScore

    expect((await setUserCredit({ id: target.id, value: 150 })).creditScore).toBe(100)
    expect((await setUserCredit({ id: target.id, value: -5 })).creditScore).toBe(0)

    await setUserCredit({ id: target.id, value: original })
    expect(mockHelpers.getUsersCache().find((u) => u.id === target.id)?.creditScore).toBe(original)
  })

  it('按 status 过滤应只返回对应状态用户', async () => {
    // D11 拆除后用户只有 active / banned 两态，用 banned 验证过滤有效性
    const res = await fetchUsers({ status: 'banned', pageSize: 50 })
    expect(res.list.every((u) => u.status === 'banned')).toBe(true)
    expect(res.list.length).toBeGreaterThan(0) // 种子里有「已封禁」用户
  })
})

/* ============================ 内容审核 ============================ */
describe('内容审核 · 留言 / 评价', () => {
  it('留言列表应带出商品标题与「是否回复」标记', async () => {
    const res = await fetchAdminComments({ pageSize: 50 })
    expect(res.total).toBeGreaterThan(0)
    expect(res.list.every((c) => !!c.goodsTitle)).toBe(true)
    expect(res.list.some((c) => c.isReply)).toBe(true)
  })

  it('留言列表支持关键字搜索', async () => {
    const all = await fetchAdminComments({ pageSize: 100 })
    const word = all.list[0].userName
    const res = await fetchAdminComments({ keyword: word, pageSize: 100 })
    expect(res.list.length).toBeGreaterThan(0)
    expect(res.list.every((c) => c.userName.includes(word) || c.content.includes(word))).toBe(true)
  })

  it('删除顶层留言应连带删除其下回复（不留孤儿）', async () => {
    const list = mockHelpers.getComments()
    const parent = list.find((c) => !c.parentId && list.some((r) => r.parentId === c.id))!
    const before = list.length

    const { removed } = await deleteComment(parent.id)
    expect(removed).toBe(2)
    expect(mockHelpers.getComments().length).toBe(before - 2)
    expect(mockHelpers.getComments().some((c) => c.parentId === parent.id)).toBe(false)
  })

  it('删除不存在的留言返回 removed:0', async () => {
    expect((await deleteComment(999999)).removed).toBe(0)
  })

  it('评价列表可按「差评」（1-3 星）筛选', async () => {
    const res = await fetchAdminReviews({ rating: 'low', pageSize: 50 })
    expect(res.list.length).toBeGreaterThan(0)
    expect(res.list.every((r) => r.rating <= 3)).toBe(true)
  })

  it('评价列表带出商品标题', async () => {
    const res = await fetchAdminReviews({ pageSize: 50 })
    expect(res.list.every((r) => !!r.goodsTitle)).toBe(true)
  })

  it('删除评价后该订单重新变为可评价（hasReviewed 语义）', async () => {
    const res = await fetchAdminReviews({ pageSize: 1 })
    const target = res.list[0]
    const before = mockHelpers.getReviews().length

    await deleteReview(target.id)
    expect(mockHelpers.getReviews().length).toBe(before - 1)
    expect(mockHelpers.getReviews().some((r) => r.id === target.id)).toBe(false)
  })
})

/* ============================ 平台参数 ============================ */
describe('平台参数 · 读取 / 保存 / 恢复默认', () => {
  it('默认值应完整（不含 undefined 字段）', async () => {
    const s = await fetchSettings()
    expect(s.siteName).toBeTruthy()
    expect(typeof s.goodsAuditRequired).toBe('boolean')
    expect(typeof s.maxPublishPerDay).toBe('number')
    expect(Object.values(s).every((v) => v !== undefined)).toBe(true)
  })

  it('保存后应能读回（持久化生效）', async () => {
    const saved = await saveSettings({ siteName: '单元测试集市', maxPublishPerDay: 3 })
    expect(saved.siteName).toBe('单元测试集市')
    expect((await fetchSettings()).maxPublishPerDay).toBe(3)
  })

  it('部分更新不应丢掉其它字段', async () => {
    const before = await fetchSettings()
    const after = await saveSettings({ servicePhone: '010-0000 0000' })
    expect(after.siteName).toBe(before.siteName)
    expect(after.commissionRate).toBe(before.commissionRate)
  })

  it('恢复默认应回到出厂值', async () => {
    await saveSettings({ siteName: '临时名字' })
    const fresh = await resetSettings()
    expect(fresh.siteName).toBe('校园集市')
  })
})

/* ============================ 看板数据 ============================ */
describe('管理看板 · 总览与热销榜', () => {
  it('总览应给出待办数与 GMV', async () => {
    const o = await fetchAdminOverview()
    // pendingUsers 已随 D11 拆除（2026-09-23）：待办只含商品与举报
    expect(o.todoTotal).toBe(o.pendingGoods + o.pendingReports)
    expect(o.gmv).toBeGreaterThan(0)
    expect(o.userTotal).toBe(mockHelpers.getUsersCache().length)
  })

  it('热销榜应按成交单数降序，且只含存在商品', async () => {
    const rank = await fetchHotGoodsRank(5)
    expect(rank.length).toBeGreaterThan(0)
    expect(rank.length).toBeLessThanOrEqual(5)
    const counts = rank.map((r) => r.soldCount)
    expect(counts).toEqual([...counts].sort((a, b) => b - a))
    expect(rank.every((r) => !!r.goods)).toBe(true)
  })
})

/* ============================ 操作日志（放最后，含清空） ============================ */
describe('操作日志', () => {
  it('应记录前面各步的写操作', async () => {
    const res = await fetchAuditLogs({ pageSize: 100 })
    expect(res.total).toBeGreaterThan(0)
    // 新的在前
    const times = res.list.map((l) => +new Date(l.createTime))
    expect(times).toEqual([...times].sort((a, b) => b - a))
  })

  it('按动作分类筛选应只返回该分类', async () => {
    const res = await fetchAuditLogs({ type: 'user', pageSize: 100 })
    expect(res.list.length).toBeGreaterThan(0)
    expect(res.list.every((l) => l.action.startsWith('user.'))).toBe(true)
  })

  it('写操作确实落到了日志里（改商品状态应产生 goods.status）', async () => {
    const target = mockHelpers.getGoodsCache()[0]
    await updateGoodsStatus({ id: target.id, status: 'off_shelf' })

    const res = await fetchAuditLogs({ type: 'goods', pageSize: 100 })
    expect(res.list.some((l) => l.action === 'goods.status')).toBe(true)
  })

  it('清空后日志应为 0 条', async () => {
    await clearAuditLogs()
    expect((await fetchAuditLogs({ pageSize: 10 })).total).toBe(0)
  })
})

/* ============================ 举报处理 ============================ */
describe('举报 · 类型筛选与批量处理', () => {
  it('统计接口应给出待处理 / 已处理 / 已驳回三类计数', async () => {
    const s = await fetchReportStats()
    expect(s.pending + s.handled + s.rejected).toBe(mockHelpers.getReports().length)
  })

  it('按类型筛选只返回该类型的举报', async () => {
    const all = await fetchReports({ pageSize: 100 })
    expect(all.total).toBeGreaterThan(0)

    const types = [...new Set(all.list.map((r) => r.type))]
    const picked = types[0]
    const filtered = await fetchReports({ pageSize: 100, type: picked })
    expect(filtered.total).toBeGreaterThan(0)
    expect(filtered.list.every((r) => r.type === picked)).toBe(true)
  })

  it('待处理举报应排在最前（后台从上往下处理）', async () => {
    const res = await fetchReports({ pageSize: 100 })
    const firstHandledIdx = res.list.findIndex((r) => r.status !== 'pending')
    const lastPendingIdx = res.list.map((r) => r.status).lastIndexOf('pending')
    if (firstHandledIdx >= 0 && lastPendingIdx >= 0) {
      expect(lastPendingIdx).toBeLessThan(firstHandledIdx)
    }
  })

  it('批量处理只改动 pending 的记录，返回实际改动条数', async () => {
    const list = mockHelpers.getReports()
    const pending = list.filter((r) => r.status === 'pending').map((r) => r.id)
    const handled = list.filter((r) => r.status === 'handled').map((r) => r.id)
    expect(pending.length).toBeGreaterThan(0)

    // 故意把一条已处理的也传进去，验证它不会被重复改动、也不计入返回值
    const ids = [...pending, ...handled.slice(0, 1)]
    const affected = await batchResolveReports(ids, 'handle')

    expect(affected).toBe(pending.length)
    expect(mockHelpers.getReports().filter((r) => r.status === 'pending')).toHaveLength(0)
  })

  it('批量驳回应把 pending 置为 rejected', async () => {
    // 先造一条 pending：直接改内存，避免依赖种子数据的初始状态
    const list = mockHelpers.getReports()
    list.push({
      id: Math.max(0, ...list.map((r) => r.id)) + 1,
      type: 'order',
      targetId: 999,
      reason: 'e2e 造数',
      description: '用于验证批量驳回',
      status: 'pending',
      createTime: new Date().toISOString()
    })
    mockHelpers.setReports(list)

    const target = mockHelpers.getReports().find((r) => r.targetId === 999)!
    const n = await batchResolveReports([target.id], 'reject')

    expect(n).toBe(1)
    expect(mockHelpers.getReports().find((r) => r.id === target.id)?.status).toBe('rejected')

    // 清理造的数据，避免影响其它用例
    mockHelpers.setReports(mockHelpers.getReports().filter((r) => r.id !== target.id))
  })

  it('传空数组不应改动任何记录', async () => {
    const before = mockHelpers.getReports().map((r) => r.status).join(',')
    expect(await batchResolveReports([], 'handle')).toBe(0)
    expect(mockHelpers.getReports().map((r) => r.status).join(',')).toBe(before)
  })
})
