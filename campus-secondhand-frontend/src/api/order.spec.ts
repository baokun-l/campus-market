/**
 * API 层单元测试 · 订单模块（Mock 模式 / JSON 静态数据源）
 * 重点验证订单状态机的流转正确性
 */
import { describe, it, expect } from 'vitest'
import { fetchOrders, payOrder, shipOrder, confirmReceive, createOrder, applyRefund } from '@/api/order'
import { hasReviewed } from '@/api/review'
import { resolveFundSourceForGoods } from '@/api/activity'
import { settlePrice, scaleBreakdown, round2 } from '@/utils/promo'
import { resolveStock, availabilityText } from '@/utils/goods'
import { mockHelpers } from '@/api/mock'
import type { Order } from '@/types'

const findOrder = (id: string) => mockHelpers.getOrderCache().find((o) => o.id === id)!

/**
 * 订单种子快照（模块加载时取，早于任何用例）
 * 后面的用例会推进订单状态，这里留一份未被污染的原始数据，
 * 专门用来校验「种子数据自身是否自洽」。
 */
const SEED_ORDERS: Order[] = mockHelpers.getOrderCache().map((o) => ({ ...o }))

describe('fetchOrders() · 订单分页查询', () => {
  it('不传参数时应返回第 1 页、默认 10 条', async () => {
    const res = await fetchOrders({})
    expect(res.page).toBe(1)
    expect(res.pageSize).toBe(10)
    expect(res.list.length).toBe(10)
  })

  it('total 应等于静态订单总数（23 = 20 笔常规 + 2 笔退款中 + 1 笔已取消）', async () => {
    const res = await fetchOrders({})
    /*
     * 23 而不是 20：种子里补了 3 笔售后单（refunding ×2 / cancelled ×1）。
     * 不补的话后台的「售后中」「已取消」两个筛选永远空白，
     * 退款审批、退款原因、取消原因这些功能根本没有可测的数据。
     */
    expect(res.total).toBe(23)
  })

  it('翻页应返回不同订单', async () => {
    const p1 = await fetchOrders({ page: 1, pageSize: 10 })
    const p2 = await fetchOrders({ page: 2, pageSize: 10 })
    expect(p1.list[0].id).not.toBe(p2.list[0].id)
    expect(p2.list.length).toBe(10)
  })

  it('按状态筛选应只返回该状态订单', async () => {
    const res = await fetchOrders({ status: 'completed', pageSize: 50 })
    res.list.forEach((o) => expect(o.status).toBe('completed'))
  })

  it('每条订单都应包含商品信息快照', async () => {
    const res = await fetchOrders({})
    res.list.forEach((o) => {
      expect(o.goods).toBeTruthy()
      expect(o.goods.title.length).toBeGreaterThan(0)
      expect(o.goods.price).toBeGreaterThanOrEqual(0)
    })
  })
})

describe('订单状态机 · 待付款 → 待发货 → 已发货 → 已完成', () => {
  it('payOrder() 应把订单从 pending_payment 推进到 pending_ship 并记录支付时间', async () => {
    const target = mockHelpers.getOrderCache().find((o) => o.status === 'pending_payment')!
    expect(target).toBeTruthy()

    await payOrder(target.id)

    const after = findOrder(target.id)
    expect(after.status).toBe('pending_ship')
    expect(after.payTime).toBeTruthy()
  })

  it('shipOrder() 应把订单推进到 shipped 并写入运单号', async () => {
    const target = mockHelpers.getOrderCache().find((o) => o.status === 'pending_ship')!
    expect(target).toBeTruthy()

    await shipOrder(target.id, 'SF1234567890')

    const after = findOrder(target.id)
    expect(after.status).toBe('shipped')
    expect(after.trackingNo).toBe('SF1234567890')
    expect(after.shipTime).toBeTruthy()
  })

  it('confirmReceive() 应把订单推进到 completed 并记录收货时间', async () => {
    const target = mockHelpers.getOrderCache().find((o) => o.status === 'shipped')!
    expect(target).toBeTruthy()

    await confirmReceive(target.id)

    const after = findOrder(target.id)
    expect(after.status).toBe('completed')
    expect(after.receiveTime).toBeTruthy()
  })

  it('完整链路：一笔待付款订单可一路推进到已完成', async () => {
    const target = mockHelpers.getOrderCache().find((o) => o.status === 'pending_payment')
    if (!target) return

    await payOrder(target.id)
    expect(findOrder(target.id).status).toBe('pending_ship')

    await shipOrder(target.id, 'YT999')
    expect(findOrder(target.id).status).toBe('shipped')

    await confirmReceive(target.id)
    expect(findOrder(target.id).status).toBe('completed')
  })

  it('操作不存在的订单号应静默返回（不抛错）', async () => {
    /*
     * ★ payOrder 现在返回 PayLaunch 而不是 void ★
     * 「没报错」不等于「付了钱」—— 这正是这次支付改造要纠正的误解。
     * 所以这里断言的是「返回了结果且形态是 DONE」，而不是「返回 undefined」。
     */
    const launch = await payOrder('NOT-EXIST')
    expect(launch.kind).toBe('DONE')
    await expect(shipOrder('NOT-EXIST', 'X')).resolves.toBeUndefined()
    await expect(confirmReceive('NOT-EXIST')).resolves.toBeUndefined()
  })

  it('★ payOrder() 返回 PayLaunch：只有 kind=DONE 才算当场付完（不能把「接口没报错」当成付了钱）', async () => {
    const target = mockHelpers.getOrderCache().find((o) => o.status === 'pending_payment')!
    const launch = await payOrder(target.id, 'wallet')
    expect(launch.kind).toBe('DONE')
    expect(launch.channel).toBe('wallet')
    expect(launch.orderId).toBe(target.id)
    expect(launch.amount).toBeGreaterThan(0)
  })

  it('订单操作后总数不应改变（仅改状态）', async () => {
    const before = mockHelpers.getOrderCache().length
    const target = mockHelpers.getOrderCache()[0]
    await payOrder(target.id)
    expect(mockHelpers.getOrderCache().length).toBe(before)
  })
})

/*
 * 种子数据自洽性。
 *
 * 起因：评价种子曾把 orderId 硬编成 2026${i}，正好和「已发货」订单撞号，
 * 于是前台一点「确认收货」（订单变 completed），hasReviewed() 立刻命中，
 * 页面凭空显示「已评价」。根因在数据不在显示，所以这里把不变量钉死：
 * 一条评价能存在，前提是它对应的订单已经走完收货。
 */
describe('种子数据一致性 · 评价 / 订单 / 时间线', () => {
  it('每条评价都必须挂在「已收货 / 已完成」的订单上', () => {
    const byId = new Map(SEED_ORDERS.map((o) => [o.id, o]))
    const reviews = mockHelpers.getReviews()
    expect(reviews.length).toBeGreaterThan(0)

    reviews.forEach((r) => {
      const order = byId.get(r.orderId)
      expect(order, `评价 #${r.id} 指向了不存在的订单 ${r.orderId}`).toBeTruthy()
      expect(
        ['received', 'completed'],
        `订单 ${r.orderId} 当前状态为 ${order!.status}，在没收货前不该存在评价`
      ).toContain(order!.status)
    })
  })

  it('评价关联的商品与买卖双方应与订单保持一致', () => {
    const byId = new Map(SEED_ORDERS.map((o) => [o.id, o]))
    mockHelpers.getReviews().forEach((r) => {
      const order = byId.get(r.orderId)!
      expect(r.goodsId).toBe(order.goods.id)
      expect(r.toUserId).toBe(order.sellerId)
      expect(r.fromUserId).toBe(order.buyerId)
    })
  })

  it('「已发货」订单不应被误判为已评价（确认收货后必须仍可评价）', async () => {
    const shipped = SEED_ORDERS.filter((o) => o.status === 'shipped')
    expect(shipped.length).toBeGreaterThan(0)
    for (const o of shipped) {
      expect(await hasReviewed(o.id), `订单 ${o.id} 在收货前就被判为已评价`).toBe(false)
    }
  })

  it('订单时间线单调递增且不晚于当前时间', () => {
    const now = Date.now()
    SEED_ORDERS.forEach((o) => {
      const seq = [o.createTime, o.payTime, o.shipTime, o.receiveTime]
        .filter((t): t is string => !!t)
        .map((t) => Date.parse(t))
      for (let i = 1; i < seq.length; i++) {
        expect(seq[i], `订单 ${o.id} 时间线倒挂`).toBeGreaterThanOrEqual(seq[i - 1])
      }
      seq.forEach((t) => expect(t, `订单 ${o.id} 出现了未来时间`).toBeLessThanOrEqual(now))
    })
  })

  it('未收货的订单不应带收货时间', () => {
    SEED_ORDERS.forEach((o) => {
      const received = o.status === 'received' || o.status === 'completed'
      expect(!!o.receiveTime, `订单 ${o.id}(${o.status}) 的收货时间与状态不符`).toBe(received)
    })
  })
})

/* ---------------------------- 状态与数量的文案 ---------------------------- */
describe('availabilityText() · 已售商品不得再显示「剩余 N 件」', () => {
  it('非在售状态直接说状态，不看库存', () => {
    expect(availabilityText({ stock: 2, status: 'sold' })).toBe('已售出')
    expect(availabilityText({ stock: 2, status: 'off_shelf' })).toBe('已下架')
    expect(availabilityText({ stock: 2, status: 'pending' })).toContain('审核中')
  })

  it('在售商品沿用库存口径', () => {
    expect(availabilityText({ stock: 5, status: 'on_sale' })).toBe('剩余 5 件')
    expect(availabilityText({ stock: 1, status: 'on_sale' })).toBe('仅剩 1 件')
    expect(availabilityText({ stock: 0, status: 'on_sale' })).toBe('已售罄')
  })
})

/*
 * 立即购买 / 购物车结算共用的下单入口。
 * 这里守的是三条底线：只在售可买、数量不超库存、金额按统一口径落快照。
 */
describe('createOrder() · 买家下单', () => {
  /** 找一件在售且有货的商品 */
  const findSellable = (minStock = 1) =>
    mockHelpers.getGoodsCache().find((g) => g.status === 'on_sale' && resolveStock(g) >= minStock)!

  it('应生成一笔待付款订单，并落「数量 × 单价」的价格快照', async () => {
    const goods = findSellable(2)
    const expected = scaleBreakdown(settlePrice(goods, resolveFundSourceForGoods(goods)), 2)

    const order = await createOrder({ goodsId: goods.id, quantity: 2 })

    expect(order.status).toBe('pending_payment')
    expect(order.quantity).toBe(2)
    expect(order.amount).toBeCloseTo(expected.payAmount, 2)
    expect(order.listPrice).toBeCloseTo(expected.listPrice, 2)
    // 恒等式：实付 + 卖家让利 + 平台补贴 === 挂牌价合计
    expect(round2(order.amount + order.sellerCut + order.platformSubsidy)).toBeCloseTo(order.listPrice, 2)
    expect(order.createTime).toBeTruthy()
    expect(order.payTime).toBeUndefined()
  })

  it('新订单应排在订单列表最前（便于买家立刻看到待付款）', async () => {
    const goods = findSellable()
    const order = await createOrder({ goodsId: goods.id, quantity: 1 })
    expect(mockHelpers.getOrderCache()[0].id).toBe(order.id)
  })

  it('下单应扣减库存；售罄即置为「已售出」', async () => {
    const goods = mockHelpers.getGoodsCache().find((g) => g.status === 'on_sale' && resolveStock(g) === 1)!
    await createOrder({ goodsId: goods.id, quantity: 1 })

    const after = mockHelpers.getGoodsCache().find((g) => g.id === goods.id)!
    expect(resolveStock(after)).toBe(0)
    expect(after.status).toBe('sold')
  })

  it('数量超过可售数量应拒绝下单，并说明还剩几件', async () => {
    const goods = findSellable(1)
    const stock = resolveStock(goods)
    await expect(createOrder({ goodsId: goods.id, quantity: stock + 1 })).rejects.toThrow(/库存不足/)
  })

  it('审核中的商品不能下单（回归：审核中还能购买）', async () => {
    const pending = mockHelpers.getGoodsCache().find((g) => g.status === 'pending')
    expect(pending, '需要至少一件「审核中」的商品才能验证这道防线').toBeTruthy()
    await expect(createOrder({ goodsId: pending!.id, quantity: 1 })).rejects.toThrow(/审核中/)
  })

  it('已售出 / 已下架的商品不能下单', async () => {
    // 商品池的种子状态里不一定恰有「已下架」，这里自己造一件 ——
    // 依赖种子分布会让这条断言在改 seed 时莫名其妙地红掉
    const arr = mockHelpers.getGoodsCache()
    const candidate = arr.find((g) => g.status === 'on_sale')!
    mockHelpers.setGoodsCache(
      arr.map((g) => (g.id === candidate.id ? { ...g, status: 'off_shelf' as const } : g))
    )

    await expect(createOrder({ goodsId: candidate.id, quantity: 1 })).rejects.toThrow(/已下架/)

    const sold = mockHelpers.getGoodsCache().find((g) => g.status === 'sold')
    if (sold) {
      await expect(createOrder({ goodsId: sold.id, quantity: 1 })).rejects.toThrow()
    }
  })

  it('商品不存在应报错，不得生成空订单', async () => {
    await expect(createOrder({ goodsId: 99999999, quantity: 1 })).rejects.toThrow(/不存在/)
  })
})

/* ============================================================
 * 买家申请退款（售后入口）
 * ============================================================ */
describe('applyRefund() · 买家申请退款', () => {
  /**
   * 取一笔订单并强制成指定状态。
   *
   * 不去种子里「找一个 pending_ship 的单子」：前面的用例已经把状态推着走过了，
   * 依赖种子分布会让这条断言在别人改 seed 或调整用例顺序时莫名其妙地红掉。
   */
  function given(status: Order['status']): Order {
    const arr = mockHelpers.getOrderCache()
    const base = arr[arr.length - 1]
    const patched: Order = { ...base, status }
    delete patched.refund
    delete patched.refundTime
    mockHelpers.setOrderCache(arr.map((o) => (o.id === base.id ? patched : o)))
    return patched
  }

  it('提交后订单进入 refunding，退款单带「申请时间」与买家发起方', async () => {
    const o = given('shipped')
    await applyRefund(o.id, { reason: '商品存在质量问题' })

    const after = findOrder(o.id)
    expect(after.status).toBe('refunding')
    expect(after.refund?.by).toBe('buyer')
    expect(after.refund?.reason).toBe('商品存在质量问题')
    expect(after.refund?.amount).toBeCloseTo(after.amount, 2)
    expect(after.refund?.time).toBeTruthy()
    /*
     * ★ refundTime 是「退款**完成**时间」，申请阶段必须留空 ★
     * 它被用来统计「已退款金额」，申请即写入会把还在审核中的售后算成已经退出去的钱。
     */
    expect(after.refundTime).toBeUndefined()
  })

  it('时间线补一条「买家申请退款」，方向是 发货态 → refunding', async () => {
    const o = given('shipped')
    await applyRefund(o.id, { reason: '卖家未按约定时间发货' })

    const log = findOrder(o.id).logs?.[0]
    expect(log?.actionLabel).toBe('买家申请退款')
    expect(log?.from).toBe('shipped')
    expect(log?.to).toBe('refunding')
    expect(log?.note).toBe('卖家未按约定时间发货')
    expect(log?.operatorRole).toBe('buyer')
  })

  it('已收货也能申请 —— 收货后才发现问题是最常见的售后场景', async () => {
    const o = given('received')
    await expect(applyRefund(o.id, { reason: '商品与描述不符' })).resolves.toBeUndefined()
    expect(findOrder(o.id).status).toBe('refunding')
  })

  it('待付款不能申请退款 —— 还没给钱，应该走「取消订单」', async () => {
    const o = given('pending_payment')
    await expect(applyRefund(o.id, { reason: '不想要了' })).rejects.toThrow(/不能申请退款/)
  })

  it('重复申请被挡（不能把已在等待审核的单子再刷一遍）', async () => {
    const o = given('refunding')
    await expect(applyRefund(o.id, { reason: '不想要了' })).rejects.toThrow(/正在等待平台处理/)
  })

  it('原因必填，空白不行', async () => {
    const o = given('shipped')
    await expect(applyRefund(o.id, { reason: '   ' })).rejects.toThrow(/不能为空/)
  })

  it('申请不动钱、也不回补库存（回补要等审批通过、交易真正作废）', async () => {
    const o = given('shipped')
    const goodsId = o.goods.id
    const beforeStock = resolveStock(mockHelpers.getGoodsCache().find((g) => g.id === goodsId)!)

    await applyRefund(o.id, { reason: '不想要了' })

    const afterStock = resolveStock(mockHelpers.getGoodsCache().find((g) => g.id === goodsId)!)
    expect(afterStock).toBe(beforeStock)
    expect(findOrder(o.id).amount).toBeCloseTo(o.amount, 2)
  })
})
