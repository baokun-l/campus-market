/**
 * 后台「订单工作台」专项测试
 *
 * 覆盖第十九轮新增的整套管理能力：筛选口径、SLA 超时判定、KPI 统计、
 * 批量处置、部分退款、驳回售后、内部备注、导出。
 *
 * 除了功能本身，这里还锁一类**跨字段一致性**——单看某一条数据都正常，
 * 但合起来看就自相矛盾的那种问题（日志说「待付款→已完成」、
 * 轨迹时间早于发货时间、退款原因在审批时被改掉）。这类问题不会报错，
 * 只会让后台的对账和追溯悄悄失真，所以必须由测试钉住。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  ORDER_PAID_STATUS,
  ORDER_SLA_HOURS,
  ORDER_STATUS_LABEL,
  ORDER_TODO_STATUS,
  ORDER_OVERVIEW_GROUPS,
  ORDER_TRANSITIONS,
  REFUNDABLE_STATUS,
  fetchAdminOrderStats,
  fetchAdminOrders,
  fetchAdminOrdersForExport,
  filterAdminOrders,
  orderIssueOf,
  batchOrderAction,
  refundOrder,
  rejectRefund,
  saveOrderNote,
  updateOrderStatus
} from '@/api/order'
import { mockHelpers } from '@/api/mock'
import type { Order, OrderLog } from '@/types'

/** 每个用例都从种子快照重建订单池，避免相互污染（改状态的用例很多） */
const SEED: Order[] = mockHelpers.getOrderCache().map((o) => JSON.parse(JSON.stringify(o)))

beforeEach(() => {
  mockHelpers.setOrderCache(SEED.map((o) => JSON.parse(JSON.stringify(o))))
})

const all = () => mockHelpers.getOrderCache()
const one = (status: Order['status']) => all().find((o) => o.status === status)!

/* ============================================================
 * 一、筛选口径
 * ============================================================ */
describe('filterAdminOrders() · 后台筛选口径', () => {
  it('关键词应能命中订单号 / 商品 / 买卖双方 / 运单号', () => {
    const target = all().find((o) => o.trackingNo)!
    const byTracking = filterAdminOrders(all(), { keyword: target.trackingNo! })
    expect(byTracking.map((o) => o.id)).toContain(target.id)

    /*
     * 关键词命中昵称时，**买家侧与卖家侧都要算命中** ——
     * 搜「计算机小张」既该搜出他买的单，也该搜出他卖的单。
     * 所以不能断言「结果里所有 buyerName 都相同」，
     * 而要断言「每条结果至少在某个可搜索字段里含关键词」。
     */
    const nickname = target.buyerName!
    const byName = filterAdminOrders(all(), { keyword: nickname })
    expect(byName.length).toBeGreaterThan(0)
    byName.forEach((o) => {
      const haystack = [o.id, o.goods.title, o.buyerName, o.sellerName, o.trackingNo]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      expect(haystack, `订单 ${o.id} 不含关键词「${nickname}」却被搜出来`).toContain(nickname.toLowerCase())
    })
    // 确实至少有一条是「他买的」或「他卖的」
    expect(byName.some((o) => o.buyerName === nickname || o.sellerName === nickname)).toBe(true)
  })

  it('关键词应忽略大小写与首尾空格', () => {
    const target = all().find((o) => o.trackingNo)!
    const a = filterAdminOrders(all(), { keyword: `  ${target.trackingNo!.toLowerCase()}  ` })
    expect(a.map((o) => o.id)).toContain(target.id)
  })

  it('状态筛选应只回该状态', () => {
    const res = filterAdminOrders(all(), { status: 'refunding' })
    expect(res.length).toBeGreaterThan(0)
    res.forEach((o) => expect(o.status).toBe('refunding'))
  })

  it('onlyTodo 只回需要人工介入的状态', () => {
    const res = filterAdminOrders(all(), { onlyTodo: true })
    expect(res.length).toBeGreaterThan(0)
    res.forEach((o) => expect(ORDER_TODO_STATUS).toContain(o.status))
    expect(res.length).toBe(all().filter((o) => ORDER_TODO_STATUS.includes(o.status)).length)
  })

  it('金额区间是闭区间', () => {
    const sorted = all().slice().sort((a, b) => a.amount - b.amount)
    const lo = sorted[2].amount
    const hi = sorted[sorted.length - 3].amount
    const res = filterAdminOrders(all(), { minAmount: lo, maxAmount: hi })
    res.forEach((o) => {
      expect(o.amount).toBeGreaterThanOrEqual(lo)
      expect(o.amount).toBeLessThanOrEqual(hi)
    })
    // 边界本身必须被包含进来（闭区间），否则「刚好等于」的单会莫名其妙消失
    expect(res.some((o) => o.amount === lo || o.amount === hi)).toBe(true)
  })

  it('让利归属可筛选（卖家让利 / 平台补贴两条路径分别可查）', () => {
    const seller = filterAdminOrders(all(), { fundSource: 'seller' })
    seller.forEach((o) => expect(o.fundSource).toBe('seller'))
    const platform = filterAdminOrders(all(), { fundSource: 'platform' })
    platform.forEach((o) => expect(o.fundSource).toBe('platform'))
    expect(seller.length + platform.length).toBe(all().length)
  })

  it('onlyRemark / onlyNoted 分别对应买家备注与后台备注', () => {
    const r = filterAdminOrders(all(), { onlyRemark: true })
    r.forEach((o) => expect(o.remark).toBeTruthy())

    // 后台备注默认是空的，先给一条写上再筛，验证 it 真的按 adminNote 过滤
    all()[0].adminNote = '疑似黄牛，重点关注'
    const n = filterAdminOrders(all(), { onlyNoted: true })
    expect(n.length).toBe(1)
    expect(n[0].id).toBe(all()[0].id)
  })

  it('日期区间按**本地日**闭合，不因 ISO(UTC) 串而错半天', () => {
    const target = all()[0]
    const d = new Date(target.createTime)
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

    const same = filterAdminOrders(all(), { dateFrom: ymd, dateTo: ymd })
    expect(same.map((o) => o.id)).toContain(target.id)
    // 同一天内不该出现别的日期
    same.forEach((o) => {
      const od = new Date(o.createTime)
      expect(`${od.getFullYear()}-${od.getMonth()}-${od.getDate()}`).toBe(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`)
    })

    // 只给 dateFrom 时，晚于该日的都应命中
    const after = filterAdminOrders(all(), { dateFrom: ymd })
    expect(after.length).toBeGreaterThanOrEqual(same.length)
  })

  it('排序 4 种都生效', () => {
    const byTimeDesc = filterAdminOrders(all(), { sort: 'time_desc' })
    for (let i = 1; i < byTimeDesc.length; i++) {
      expect(byTimeDesc[i - 1].createTime >= byTimeDesc[i].createTime).toBe(true)
    }
    const byTimeAsc = filterAdminOrders(all(), { sort: 'time_asc' })
    for (let i = 1; i < byTimeAsc.length; i++) {
      expect(byTimeAsc[i - 1].createTime <= byTimeAsc[i].createTime).toBe(true)
    }
    const byAmtDesc = filterAdminOrders(all(), { sort: 'amount_desc' })
    for (let i = 1; i < byAmtDesc.length; i++) {
      expect(byAmtDesc[i - 1].amount).toBeGreaterThanOrEqual(byAmtDesc[i].amount)
    }
    expect(filterAdminOrders(all(), { sort: 'amount_asc' })[0].amount).toBe(byAmtDesc[byAmtDesc.length - 1].amount)
  })

  it('多条件叠加是「与」关系，且不改动入参数组', () => {
    const before = all().length
    const res = filterAdminOrders(all(), { onlyTodo: true, minAmount: 1, sort: 'amount_desc' })
    res.forEach((o) => expect(ORDER_TODO_STATUS).toContain(o.status))
    expect(all().length).toBe(before)
  })

  it('筛选结果为空时不抛错（而不是回退成全量）', () => {
    expect(filterAdminOrders(all(), { keyword: '这个订单号肯定不存在' })).toEqual([])
  })
})

/* ============================================================
 * 二、SLA 超时判定
 * ============================================================ */
describe('orderIssueOf() · 服务时限判定', () => {
  const NOW = Date.parse('2026-09-12T12:00:00')

  const mk = (status: Order['status'], times: Partial<Order>): Order =>
    ({ ...SEED[0], status, ...times }) as Order

  it('未到期不报超时', () => {
    const o = mk('pending_payment', { createTime: '2026-09-12T00:00:00' }) // 12 小时 < 24
    expect(orderIssueOf(o, NOW)).toBeNull()
  })

  it('待付款超 24 小时 → 报超时，短文案用于窄列', () => {
    const o = mk('pending_payment', { createTime: '2026-09-10T12:00:00' }) // 48 小时
    const issue = orderIssueOf(o, NOW)!
    expect(issue).toBeTruthy()
    expect(issue.shortText).toBe(ORDER_SLA_HOURS.pending_payment!.text)
    expect(issue.text).toContain('超时未付款')
    expect(issue.text).toContain('天')
  })

  it('起算点是「用户真正在等的那一刻」，不是一刀切用下单时间', () => {
    /*
     * 3 天前下单、1 小时前才付款的待发货单 —— 卖家刚收到通知，
     * 不该被判定成「超时未发货」。用 createTime 起算就会误报。
     */
    const o = mk('pending_ship', {
      createTime: '2026-09-09T12:00:00',
      payTime: '2026-09-12T11:00:00'
    })
    expect(orderIssueOf(o, NOW)).toBeNull()

    // 同一笔单，付款已经过了 3 天 → 这才该报
    const late = mk('pending_ship', {
      createTime: '2026-09-01T12:00:00',
      payTime: '2026-09-09T12:00:00'
    })
    expect(orderIssueOf(late, NOW)).toBeTruthy()
  })

  it('超得越久级别越高（warn → danger）', () => {
    // pending_ship 的时限是 48h：超 12h 记 warn，超 84h 记 danger
    const warn = orderIssueOf(mk('pending_ship', { payTime: '2026-09-10T00:00:00' }), NOW)! // 60h → 超 12h
    const danger = orderIssueOf(mk('pending_ship', { payTime: '2026-09-07T00:00:00' }), NOW)! // 132h → 超 84h
    expect(warn.level).toBe('warn')
    expect(danger.level).toBe('danger')
    expect(danger.hours).toBeGreaterThan(warn.hours)
  })

  it('终态与在售中的状态（已完成 / 已取消 / 已收货）不参与超时判定', () => {
    expect(orderIssueOf(mk('completed', { createTime: '2026-01-01T00:00:00' }), NOW)).toBeNull()
    expect(orderIssueOf(mk('cancelled', { createTime: '2026-01-01T00:00:00' }), NOW)).toBeNull()
    expect(orderIssueOf(mk('received', { createTime: '2026-01-01T00:00:00' }), NOW)).toBeNull()
  })

  it('售后时效从「申请退款」那一刻起算', () => {
    const base = mk('refunding', { createTime: '2026-09-01T00:00:00' })
    // 刚申请 → 不算超时（虽然下单已经很久了）
    expect(orderIssueOf({ ...base, refund: { amount: 1, reason: 'x', by: 'buyer', time: '2026-09-12T11:00:00' } }, NOW)).toBeNull()
    // 申请已过 3 天 → 售后超时
    const late = orderIssueOf({ ...base, refund: { amount: 1, reason: 'x', by: 'buyer', time: '2026-09-09T00:00:00' } }, NOW)!
    expect(late.shortText).toBe(ORDER_SLA_HOURS.refunding!.text)
  })
})

/* ============================================================
 * 三、工作台统计
 * ============================================================ */
describe('fetchAdminOrderStats() · 工作台 KPI', () => {
  it('各状态计数之和 = 订单总数', async () => {
    const s = await fetchAdminOrderStats()
    const sum = Object.values(s.byStatus).reduce((a, b) => a + b, 0)
    expect(sum).toBe(s.total)
    expect(s.total).toBe(all().length)
  })

  it('GMV 只累计已成交状态，与运营看板同口径', async () => {
    const s = await fetchAdminOrderStats()
    const expectGmv = all()
      .filter((o) => ORDER_PAID_STATUS.includes(o.status))
      .reduce((sum, o) => sum + o.amount, 0)
    expect(s.gmv).toBeCloseTo(expectGmv, 2)
  })

  it('「待处理金额」与 GMV 分开统计（在途 ≠ 已到账）', async () => {
    const s = await fetchAdminOrderStats()
    expect(s.pendingGmv).toBeGreaterThan(0)
    expect(s.pendingGmv).not.toBe(s.gmv)
  })

  it('待处理单数 = 待付款 + 待发货 + 售后中', async () => {
    const s = await fetchAdminOrderStats()
    const manual = all().filter((o) => ORDER_TODO_STATUS.includes(o.status)).length
    expect(s.todo).toBe(manual)
  })

  it('超时单数与逐单判定结果一致（同一套规则）', async () => {
    const s = await fetchAdminOrderStats()
    expect(s.issues).toBe(all().filter((o) => !!orderIssueOf(o)).length)
  })

  it('概览卡分组覆盖全部 7 个状态，不重不漏', async () => {
    const s = await fetchAdminOrderStats()
    const covered = ORDER_OVERVIEW_GROUPS.flatMap((g) => g.statuses)
    expect(new Set(covered).size).toBe(Object.keys(ORDER_STATUS_LABEL).length)
    expect(s.groups.length).toBe(ORDER_OVERVIEW_GROUPS.length)
    // 分组计数之和也应等于总数
    expect(s.groups.reduce((a, g) => a + g.count, 0)).toBe(s.total)
  })

  it('退款金额只统计真正退过的单', async () => {
    const s = await fetchAdminOrderStats()
    const manual = all()
      .filter((o) => o.refundTime)
      .reduce((sum, o) => sum + (o.refund?.amount ?? o.amount), 0)
    expect(s.refundedAmount).toBeCloseTo(manual, 2)
  })

  /**
   * 状态总览卡的可点性靠两个契约撑着，缺一个就会「点了没反应」或「数字对不上」：
   *   ① 接口下发的每个分组自带 `statuses` 白名单（视图点卡片直接拿去筛，不用回查常量表）；
   *   ② 用该白名单筛出来的行数 == 卡片上印的数字。
   * 早期只下发 key/label/count，视图取 `g.statuses.length` 直接抛 TypeError，
   * 而「售后中」这种双状态分组若退化成只筛第一个状态，卡片写 3 单点进去只有 2 单。
   */
  it('概览卡下发 statuses 白名单，且与静态定义逐项一致', async () => {
    const s = await fetchAdminOrderStats()
    for (const def of ORDER_OVERVIEW_GROUPS) {
      const got = s.groups.find((g) => g.key === def.key)
      expect(got, `缺少分组 ${def.key}`).toBeTruthy()
      expect(got!.statuses).toEqual(def.statuses)
    }
  })

  it('按分组白名单筛选的行数 == 卡片计数（点进去看到的就是卡片上的数）', async () => {
    const s = await fetchAdminOrderStats()
    for (const g of s.groups) {
      expect(filterAdminOrders(all(), { statusIn: g.statuses }).length, `${g.label} 口径不一致`).toBe(g.count)
    }
    // 「售后中」必须真的是两种状态的并集，而不是被截断成一个
    const after = s.groups.find((g) => g.key === 'after')!
    expect(after.statuses.length).toBeGreaterThan(1)
    expect(
      filterAdminOrders(all(), { statusIn: after.statuses }).every((o) => after.statuses.includes(o.status))
    ).toBe(true)
  })

  it('单状态白名单等价于 status 精确筛；status 与 statusIn 同时给出时取交集', () => {
    const shipped = filterAdminOrders(all(), { status: 'shipped' })
    expect(filterAdminOrders(all(), { statusIn: ['shipped'] }).map((o) => o.id)).toEqual(shipped.map((o) => o.id))
    // 交集而非并集：两个条件互斥时结果必须为空，不能悄悄退化成「或」
    expect(filterAdminOrders(all(), { status: 'shipped', statusIn: ['cancelled'] })).toEqual([])
  })

  it('空白名单不构成筛选（等价于不传）', () => {
    expect(filterAdminOrders(all(), { statusIn: [] }).length).toBe(all().length)
  })
})

/* ============================================================
 * 四、列表分页与导出
 * ============================================================ */
describe('fetchAdminOrders() / 导出', () => {
  it('分页返回正确切片，total 为筛选后的总数', async () => {
    const p1 = await fetchAdminOrders({ page: 1, pageSize: 5 })
    expect(p1.list.length).toBe(5)
    expect(p1.total).toBe(all().length)
    const p2 = await fetchAdminOrders({ page: 2, pageSize: 5 })
    expect(p2.list[0].id).not.toBe(p1.list[0].id)
  })

  it('导出走同一套筛选，但不受分页限制', async () => {
    const onlyTodo = all().filter((o) => ORDER_TODO_STATUS.includes(o.status))
    const exported = await fetchAdminOrdersForExport({ page: 1, pageSize: 10, onlyTodo: true })
    expect(exported.length).toBe(onlyTodo.length)
    exported.forEach((o) => expect(ORDER_TODO_STATUS).toContain(o.status))

    /*
     * 「不受分页限制」要靠对比来证：同一个 pageSize=1 的条件走列表只回 1 条，
     * 走导出却要回全部 —— 否则只是「恰好 9 条 < 10」的巧合。
     */
    const onePage = await fetchAdminOrders({ page: 1, pageSize: 1, onlyTodo: true })
    expect(onePage.list.length).toBe(1)
    expect(onePage.total).toBe(onlyTodo.length)
    expect(exported.length).toBeGreaterThan(onePage.list.length)
  })

  it('导出与列表的筛选口径完全一致（同条件同结果）', async () => {
    const q = { status: 'shipped' as const, sort: 'amount_desc' as const }
    const list = await fetchAdminOrdersForExport(q)
    const page = await fetchAdminOrders({ ...q, page: 1, pageSize: 100 })
    expect(list.map((o) => o.id)).toEqual(page.list.map((o) => o.id))
  })
})

/* ============================================================
 * 五、批量处置
 * ============================================================ */
describe('batchOrderAction() · 批量处置', () => {
  it('批量标记付款：只动待付款，其余逐条给出跳过原因', async () => {
    const paidId = one('pending_payment').id
    const doneId = one('completed').id
    const r = await batchOrderAction([paidId, doneId], 'mark_paid')

    expect(r.ok).toBe(1)
    expect(r.skipped).toHaveLength(1)
    expect(r.skipped[0].id).toBe(doneId)
    expect(r.skipped[0].reason).toContain(ORDER_STATUS_LABEL.completed)

    const paid = all().find((o) => o.id === paidId)!
    expect(paid.status).toBe('pending_ship')
    expect(paid.payTime).toBeTruthy()
    // 已完成的那笔必须原样不动
    expect(all().find((o) => o.id === doneId)!.status).toBe('completed')
  })

  it('批量发货：写入承运商、运单号、发货时间与首条轨迹', async () => {
    const id = one('pending_ship').id
    const r = await batchOrderAction([id], 'ship', { carrier: '中通快递' })
    expect(r.ok).toBe(1)

    const o = all().find((x) => x.id === id)!
    expect(o.status).toBe('shipped')
    expect(o.logisticsCompany).toBe('中通快递')
    expect(o.trackingNo).toMatch(/^[A-Za-z0-9-]{6,24}$/)
    expect(o.shipTime).toBeTruthy()
    expect(o.traces?.length).toBeGreaterThan(0)
    // 刚发货就应有轨迹，否则详情页物流区是空的，像功能没做
    expect(Date.parse(o.traces![0].time)).toBeGreaterThanOrEqual(Date.parse(o.shipTime!))
  })

  it('批量关闭：写入取消原因（责任归属要靠它）', async () => {
    const id = one('pending_payment').id
    const r = await batchOrderAction([id], 'close', { reason: '买家超时未付款' })
    expect(r.ok).toBe(1)
    const o = all().find((x) => x.id === id)!
    expect(o.status).toBe('cancelled')
    expect(o.cancelReason?.text).toBe('买家超时未付款')
  })

  it('批量关闭拒绝已完成的单（终态不可逆）', async () => {
    const id = one('completed').id
    const r = await batchOrderAction([id], 'close')
    expect(r.ok).toBe(0)
    expect(r.skipped[0].reason).toContain(ORDER_STATUS_LABEL.completed)
    expect(all().find((o) => o.id === id)!.status).toBe('completed')
  })

  it('不存在的订单被记为跳过而不是抛错（一批里有个脏 id 不该整批失败）', async () => {
    const r = await batchOrderAction(['202699999', one('pending_payment').id], 'mark_paid')
    expect(r.ok).toBe(1)
    expect(r.skipped[0].reason).toBe('订单不存在')
  })

  it('每次处置都会留下操作日志（追溯的依据）', async () => {
    const id = one('pending_payment').id
    const before = all().find((o) => o.id === id)!.logs!.length
    await batchOrderAction([id], 'mark_paid')
    const after = all().find((o) => o.id === id)!.logs!
    expect(after.length).toBe(before + 1)
    expect(after[0].actionLabel).toContain('批量')
    expect(after[0].operatorRole).toBe('admin')
  })
})

/* ============================================================
 * 六、退款与售后
 * ============================================================ */
describe('refundOrder() · 退款（含部分退款）', () => {
  it('部分退款：记录实退金额而不是订单全额', async () => {
    const o = one('shipped')
    const half = Number((o.amount / 2).toFixed(2))
    await refundOrder(o.id, { amount: half, reason: '商品存在质量问题', remark: '双方协商退一半' })

    const after = all().find((x) => x.id === o.id)!
    expect(after.status).toBe('cancelled')
    expect(after.refund?.amount).toBeCloseTo(half, 2)
    expect(after.refund?.reason).toBe('商品存在质量问题')
    expect(after.refund?.remark).toBe('双方协商退一半')
    expect(after.refundTime).toBeTruthy()
  })

  it('退款金额不得超过买家实付', async () => {
    const o = one('shipped')
    await expect(refundOrder(o.id, { amount: o.amount + 1 })).rejects.toThrow(/不得超过/)
  })

  it('退款金额必须大于 0', async () => {
    const o = one('shipped')
    await expect(refundOrder(o.id, { amount: 0 })).rejects.toThrow(/大于 0/)
  })

  it('已取消 / 已完成都不能再退（终态不可逆）', async () => {
    await expect(refundOrder(one('cancelled').id)).rejects.toThrow(/已取消/)
    await expect(refundOrder(one('completed').id)).rejects.toThrow(/不支持退款/)
  })

  it('买家已申请的售后单：走原有原因与申请时间，不被审批人改写', async () => {
    const o = one('refunding')
    const originalReason = o.refund!.reason
    const originalTime = o.refund!.time
    await refundOrder(o.id, { reason: '其他', remark: '同意' })

    const after = all().find((x) => x.id === o.id)!
    expect(after.status).toBe('cancelled')
    // 申请理由是证据，不是可编辑字段 —— 改掉它售后统计就失去意义了
    expect(after.refund?.reason).toBe(originalReason)
    expect(after.refund?.time).toBe(originalTime)
    expect(after.refund?.by).toBe('buyer')
  })

  it('退款完成后日志里能看到「申请 → 完成」两条，且方向合法', async () => {
    const o = one('refunding')
    await refundOrder(o.id)
    const logs = all().find((x) => x.id === o.id)!.logs!
    const refundLogs = logs.filter((l) => l.action === 'refund')
    expect(refundLogs.length).toBeGreaterThanOrEqual(2)
    // 最新在前
    expect(refundLogs[0].to).toBe('cancelled')
    expect(refundLogs[0].from).toBe('refunding')
  })
})

describe('rejectRefund() · 驳回退款申请', () => {
  it('驳回后退回申请售后前的状态并清掉退款单', async () => {
    const o = one('refunding')
    // 种子里两笔 refunding 单的 prior 状态都是 shipped，从「进入 refunding 的日志」推导恢复目标，
    // 不再写死 shipped（旧代码硬编码 shipped，从 pending_ship 申请的单会被错误置 shipped）
    const prior = o.logs!.find((l) => l.to === 'refunding')!.from as Order['status']
    await rejectRefund(o.id, '经核实商品与描述一致')

    const after = all().find((x) => x.id === o.id)!
    expect(after.status).toBe(prior)
    expect(after.refund).toBeUndefined()
    expect(after.refundTime).toBeUndefined()
  })

  it('从 pending_ship 申请的售后被驳回应回到 pending_ship（而非误置 shipped）', async () => {
    // 这个用例专门抓 D1：旧实现把驳回无条件置 shipped，本应从 pending_ship 申请的单会变成
    // 「已发货却没有发货时间」的脏数据。修复后应回到申请售后前的 pending_ship，shipTime 保持为空。
    const o = one('pending_ship')
    const target = all().find((x) => x.id === o.id)!
    // 模拟「买家申请退款」：状态置 refunding，并写入一条 from=pending_ship 的进入日志
    target.status = 'refunding'
    mockHelpers.pushOrderLog(target, {
      time: new Date().toISOString(),
      action: 'refund',
      actionLabel: '买家申请退款',
      from: 'pending_ship',
      to: 'refunding',
      operator: target.buyerName ?? '买家',
      operatorRole: 'buyer'
    })

    await rejectRefund(o.id, '经核实后驳回')
    const after = all().find((x) => x.id === o.id)!
    expect(after.status).toBe('pending_ship')
    expect(after.shipTime).toBeUndefined()
    expect(after.refund).toBeUndefined()
  })

  it('驳回会留下日志（这次「不处理」本身也是要追溯的动作）', async () => {
    const o = one('refunding')
    await rejectRefund(o.id)
    const logs = all().find((x) => x.id === o.id)!.logs!
    expect(logs[0].actionLabel).toContain('驳回')
    expect(logs[0].operatorRole).toBe('admin')
  })

  it('非售后单调用应报错（没有申请可驳回）', async () => {
    await expect(rejectRefund(one('shipped').id)).rejects.toThrow(/没有待处理的退款申请/)
  })
})

/* ============================================================
 * 七、后台内部备注
 * ============================================================ */
describe('saveOrderNote() · 后台内部备注', () => {
  it('写入备注并留下日志', async () => {
    const o = all()[0]
    await saveOrderNote(o.id, '疑似黄牛，关注后续下单频率')
    const after = all().find((x) => x.id === o.id)!
    expect(after.adminNote).toBe('疑似黄牛，关注后续下单频率')
    expect(after.logs![0].action).toBe('note')
    expect(after.logs![0].note).toContain('疑似黄牛')
  })

  it('清空备注也要留痕（否则看起来像从没写过）', async () => {
    const o = all()[0]
    await saveOrderNote(o.id, '先标一下')
    const mid = all().find((x) => x.id === o.id)!.logs!.length
    await saveOrderNote(o.id, '   ')
    const after = all().find((x) => x.id === o.id)!
    expect(after.adminNote).toBeUndefined()
    expect(after.logs!.length).toBe(mid + 1)
    expect(after.logs![0].actionLabel).toContain('清空')
  })

  it('内容没变时不产生噪音日志', async () => {
    const o = all()[0]
    await saveOrderNote(o.id, '同样的内容')
    const n = all().find((x) => x.id === o.id)!.logs!.length
    await saveOrderNote(o.id, '同样的内容')
    expect(all().find((x) => x.id === o.id)!.logs!.length).toBe(n)
  })

  it('备注只落在 adminNote 上，不会写进买家可见的 remark', async () => {
    const o = all()[0]
    const buyerRemark = o.remark
    await saveOrderNote(o.id, '内部标记')
    expect(all().find((x) => x.id === o.id)!.remark).toBe(buyerRemark)
  })
})

/* ============================================================
 * 八、跨字段一致性（这类问题不报错，只会悄悄失真）
 * ============================================================ */
describe('种子数据 · 订单历史自洽性', () => {
  it('每笔订单都有操作日志，且至少含一条「下单」', () => {
    all().forEach((o) => {
      expect(o.logs, `订单 ${o.id} 缺操作日志`).toBeTruthy()
      expect(o.logs!.length).toBeGreaterThan(0)
      expect(o.logs!.some((l) => l.action === 'create')).toBe(true)
    })
  })

  it('日志按时间倒序，且 id 与时间同向（可用于稳定排序）', () => {
    all().forEach((o) => {
      const logs = o.logs!
      for (let i = 1; i < logs.length; i++) {
        expect(Date.parse(logs[i - 1].time), `订单 ${o.id} 日志时间未倒序`).toBeGreaterThanOrEqual(
          Date.parse(logs[i].time)
        )
        expect(logs[i - 1].id).toBeGreaterThan(logs[i].id)
      }
    })
  })

  it('日志里的 from → to 都必须是状态机里存在的边（唯一例外：驳回售后回到申请前的可退状态）', () => {
    const log = (o: Order, l: OrderLog) => `订单 ${o.id} · ${l.actionLabel}（${l.from} → ${l.to}）`
    all().forEach((o) => {
      o.logs!.forEach((l) => {
        if (!l.from || !l.to) return
        // 驳回退款申请是「撤销售后单 + 回到申请售后前的履约状态」的组合动作，不是顺流，
        // 所以在代码里单列一个 action=adjust 的入口。恢复目标是「进入 refunding 的那条日志的 from」，
        // 它必须属于 REFUNDABLE 且不等于 refunding 本身，否则仍按状态机校验。
        const isReject = l.action === 'adjust' && l.from === 'refunding' &&
          l.to !== 'refunding' && REFUNDABLE_STATUS.includes(l.to)
        if (isReject) return
        expect(ORDER_TRANSITIONS[l.from], `${log(o, l)}：${l.from} 没有出口`).toBeTruthy()
        expect(ORDER_TRANSITIONS[l.from].includes(l.to), `${log(o, l)} 不是合法流转`).toBe(true)
      })
    })
  })

  it('日志时间不早于订单创建时间，也不晚于现在', () => {
    const now = Date.now() + 60_000
    all().forEach((o) => {
      o.logs!.forEach((l) => {
        expect(Date.parse(l.time), `订单 ${o.id} 的日志早于下单时间`).toBeGreaterThanOrEqual(Date.parse(o.createTime) - 1000)
        expect(Date.parse(l.time), `订单 ${o.id} 的日志落在未来`).toBeLessThanOrEqual(now)
      })
    })
  })

  it('时间线严格单调：下单 ≤ 付款 ≤ 发货 ≤ 收货 ≤ 完成', () => {
    all().forEach((o) => {
      const seq = [o.createTime, o.payTime, o.shipTime, o.receiveTime, o.completeTime].filter(Boolean) as string[]
      for (let i = 1; i < seq.length; i++) {
        expect(Date.parse(seq[i]), `订单 ${o.id} 时间线倒挂`).toBeGreaterThanOrEqual(Date.parse(seq[i - 1]))
      }
      // 收货与完成必须不同时刻：同秒会让日志里两条记录看不出先后
      if (o.receiveTime && o.completeTime) expect(o.completeTime).not.toBe(o.receiveTime)
    })
  })

  it('物流轨迹：起点不早于发货、终点不晚于收货（或现在）', () => {
    all().forEach((o) => {
      if (!o.traces?.length) return
      expect(o.shipTime, `订单 ${o.id} 有轨迹却没有发货时间`).toBeTruthy()
      const ship = Date.parse(o.shipTime!)
      const end = o.receiveTime ? Date.parse(o.receiveTime) : Date.now() + 60_000
      o.traces.forEach((t) => {
        expect(Date.parse(t.time), `订单 ${o.id} 的轨迹早于发货`).toBeGreaterThanOrEqual(ship)
        expect(Date.parse(t.time), `订单 ${o.id} 的轨迹晚于收货/现在`).toBeLessThanOrEqual(end)
      })
    })
  })

  it('有运单号才有承运商；未发货不应出现运单号', () => {
    all().forEach((o) => {
      if (o.logisticsCompany) expect(o.trackingNo, `订单 ${o.id} 有承运商却没运单号`).toBeTruthy()
      if (!o.payTime && o.status !== 'cancelled') return
      if (o.status === 'pending_payment' || o.status === 'pending_ship' || o.status === 'cancelled') {
        expect(o.trackingNo, `订单 ${o.id}（${o.status}）不该有运单号`).toBeUndefined()
      }
    })
  })

  it('退款中的单必须有退款单；已取消的单必须有取消原因或退款单', () => {
    all().forEach((o) => {
      if (o.status === 'refunding') {
        expect(o.refund, `订单 ${o.id} 处于退款中却没有退款单`).toBeTruthy()
        expect(o.refund!.amount).toBeGreaterThan(0)
        expect(o.refund!.reason.length).toBeGreaterThan(0)
        expect(o.refundTime, `订单 ${o.id} 还没处理完就不该有退款完成时间`).toBeUndefined()
      }
      if (o.status === 'cancelled') {
        expect(!!o.cancelReason || !!o.refund, `订单 ${o.id} 已取消却查不到原因`).toBe(true)
      }
    })
  })

  it('退款金额不超过买家实付（部分退款也守这条线）', () => {
    all().forEach((o) => {
      if (o.refund) expect(o.refund.amount).toBeLessThanOrEqual(o.amount + 0.001)
    })
  })

  it('种子里售后与已取消都有实例（否则对应筛选与审批链路无从验证）', () => {
    expect(all().filter((o) => o.status === 'refunding').length).toBeGreaterThan(0)
    expect(all().filter((o) => o.status === 'cancelled').length).toBeGreaterThan(0)
  })

  it('前 8 单仍是已收货 / 已完成（种子评价挂在这 8 单上）', () => {
    all().slice(0, 8).forEach((o) => {
      expect(['received', 'completed']).toContain(o.status)
    })
  })
})

/* ============================================================
 * 九、状态机本身
 * ============================================================ */
describe('ORDER_TRANSITIONS · 只许顺流', () => {
  it('终态没有出口', () => {
    expect(ORDER_TRANSITIONS.completed).toEqual([])
    expect(ORDER_TRANSITIONS.cancelled).toEqual([])
  })

  it('售后中只能走向已取消（审批出口）', () => {
    expect(ORDER_TRANSITIONS.refunding).toEqual(['cancelled'])
  })

  it('已付款之后都可以转售后（→ refunding 是合法岔路）', () => {
    // 这笔单可能已经发了货、也可能已经签收，买家都有权申请退款
    expect(ORDER_TRANSITIONS.pending_ship).toContain('refunding')
    expect(ORDER_TRANSITIONS.shipped).toContain('refunding')
    expect(ORDER_TRANSITIONS.received).toContain('refunding')
    // 但没付款的单不能转售后 —— 钱都没收过，退什么
    expect(ORDER_TRANSITIONS.pending_payment).not.toContain('refunding')
  })

  it('不存在任何回退到未付款 / 复活已取消的边', () => {
    Object.entries(ORDER_TRANSITIONS).forEach(([from, tos]) => {
      tos.forEach((to) => {
        expect(to, `${from} → ${to} 是逆流`).not.toBe('pending_payment')
      })
    })
    expect(ORDER_TRANSITIONS.cancelled).toEqual([])
    expect(ORDER_TRANSITIONS.completed).toEqual([])
  })

  it('updateOrderStatus 拒绝非法流转并说明只能去哪', async () => {
    const o = one('completed')
    await expect(updateOrderStatus({ id: o.id, status: 'shipped' })).rejects.toThrow(/非法流转/)
    await expect(updateOrderStatus({ id: o.id, status: 'shipped' })).rejects.toThrow(/已终结/)
  })

  it('关闭订单时补上取消原因（售后统计要靠它）', async () => {
    const o = one('pending_payment')
    await updateOrderStatus({ id: o.id, status: 'cancelled', reason: '买家申请取消' })
    const after = all().find((x) => x.id === o.id)!
    expect(after.cancelReason?.text).toBe('买家申请取消')
    expect(after.logs![0].action).toBe('cancel')
  })
})
