/**
 * 数据可视化统计 API
 */
import { request } from './request'
import { mockHelpers, buildTrendData, mockCategoryPie } from './mock'
import { round2 } from '@/utils/promo'
import type { Goods, Order } from '@/types'

const USE_MOCK = import.meta.env.VITE_USE_MOCK === 'true'

export async function fetchTrend(days = 7): Promise<Array<{ date: string; pv: number; uv: number; orders: number }>> {
  if (USE_MOCK) {
    await mockHelpers.delay(280)
    return buildTrendData(days)
  }
  return request({ url: '/analytics/trend', params: { days } })
}

export async function fetchCategoryDistribution(): Promise<Array<{ name: string; value: number }>> {
  if (USE_MOCK) {
    await mockHelpers.delay(220)
    return mockCategoryPie
  }
  return request({ url: '/analytics/category-distribution' })
}

export async function fetchTopGoods(limit = 5): Promise<Goods[]> {
  if (USE_MOCK) {
    await mockHelpers.delay(300)
    return mockHelpers.getGoodsCache().slice().sort((a, b) => b.viewCount - a.viewCount).slice(0, limit)
  }
  return request({ url: '/analytics/top-goods', params: { limit } })
}

export async function fetchDashboardSummary(): Promise<{
  goodsTotal: number
  userTotal: number
  orderTotal: number
  recentOrders: number
}> {
  if (USE_MOCK) {
    await mockHelpers.delay(260)
    const gc = mockHelpers.getGoodsCache()
    const oc = mockHelpers.getOrderCache()
    const today = new Date().toDateString()
    const recentOrders = oc.filter((o) => new Date(o.createTime).toDateString() === today).length
    return {
      goodsTotal: gc.length,
      // 与「用户管理」列表同源，避免首页写 1294、后台只列出 13 个人的口径割裂
      userTotal: mockHelpers.getUsersCache().length,
      orderTotal: oc.length,
      recentOrders: recentOrders || Math.max(1, oc.length)
    }
  }
  return request({ url: '/admin/dashboard/summary' })
}

/**
 * 平台概览（首页 Banner 用，登录用户即可调用）。
 *
 * ★ 首页不要调 fetchDashboardSummary ★：那走的是 /admin/dashboard/summary，
 * 普通用户会被角色分区拦下（403「您没有该操作权限」）。首页 Banner 对所有
 * 登录用户展示平台总数，走这个登录即可见的口子。
 */
export function fetchPlatformSummary(): Promise<{
  goodsTotal: number
  userTotal: number
  orderTotal: number
  recentOrders: number
}> {
  if (USE_MOCK) {
    return fetchDashboardSummary()
  }
  return request({ url: '/analytics/summary' })
}

/* ============ 管理后台总览（待办 + GMV + 热销榜） ============ */

/** 已成交（计入 GMV）的订单状态 */
const PAID_STATUS: Order['status'][] = ['pending_ship', 'shipped', 'received', 'completed']

export interface AdminOverview {
  goodsTotal: number
  onSaleTotal: number
  /** 待审核商品数（后台待办） */
  pendingGoods: number
  userTotal: number
  bannedUsers: number
  orderTotal: number
  /** 今日新增订单 */
  recentOrders: number
  /*
   * GMV 必须拆成三个口径，一个数字说不清这笔交易的钱从哪来、到哪去：
   *   gmv                 买家实付合计（平台真实收到的钱）
   *   gmvListPrice        挂牌价合计（卖家标价口径）
   *   sellerCutTotal      卖家让利合计（卖家自己掏的钱）
   *   platformSubsidyTotal 平台补贴合计（平台真金白银贴出去的钱）
   *   sellerIncomeTotal   卖家实收合计（= 挂牌价 − 卖家让利）
   *
   * 恒等式：gmv + sellerCutTotal + platformSubsidyTotal === gmvListPrice
   * 只报一个 gmv 会在活动期把"平台到底花了多少钱"彻底藏起来。
   */
  /** 累计成交额（买家实付合计，元） */
  gmv: number
  /** 累计挂牌价合计（元） */
  gmvListPrice: number
  /** 其中：卖家让利合计（元） */
  sellerCutTotal: number
  /** 其中：平台补贴合计（元） */
  platformSubsidyTotal: number
  /** 累计卖家实收合计（元） */
  sellerIncomeTotal: number
  /** 今日成交额（元） */
  todayGmv: number
  /** 待处理举报数（后台待办） */
  pendingReports: number
  /** 进行中的活动数 */
  activeActivities: number
  /** 待办合计（各项之和，看板首屏直接展示） */
  todoTotal: number
}

export async function fetchAdminOverview(): Promise<AdminOverview> {
  if (USE_MOCK) {
    await mockHelpers.delay(300)
    const goods = mockHelpers.getGoodsCache()
    const users = mockHelpers.getUsersCache()
    const orders = mockHelpers.getOrderCache()
    const reports = mockHelpers.getReports()
    const today = new Date().toDateString()

    const paid = orders.filter((o) => PAID_STATUS.includes(o.status))
    const gmv = round2(paid.reduce((sum, o) => sum + o.amount, 0))
    /*
     * 老订单没有价格拆分快照，回退规则：
     *   挂牌价缺失 → 认为等于实付金额（即当时没让利）
     *   卖家让利缺失 → 0；平台补贴缺失 → 挂牌价 − 实付 − 卖家让利
     * 这样历史数据也能算进 GMV，且恒等式不会被打破。
     */
    const gmvListPrice = round2(
      paid.reduce((sum, o) => sum + (o.listPrice ?? o.amount), 0)
    )
    const sellerCutTotal = round2(paid.reduce((sum, o) => sum + (o.sellerCut ?? 0), 0))
    const platformSubsidyTotal = round2(gmvListPrice - gmv - sellerCutTotal)
    const sellerIncomeTotal = round2(gmvListPrice - sellerCutTotal)
    const todayGmv = round2(
      paid
        .filter((o) => new Date(o.createTime).toDateString() === today)
        .reduce((sum, o) => sum + o.amount, 0)
    )

    const pendingGoods = goods.filter((g) => g.status === 'pending').length
    const pendingReports = reports.filter((r) => r.status === 'pending').length
    const activeActivities = mockHelpers.getActiveActivities().length

    return {
      goodsTotal: goods.length,
      onSaleTotal: goods.filter((g) => g.status === 'on_sale').length,
      pendingGoods,
      userTotal: users.length,
      bannedUsers: users.filter((u) => u.status === 'banned').length,
      orderTotal: orders.length,
      recentOrders: orders.filter((o) => new Date(o.createTime).toDateString() === today).length,
      gmv,
      gmvListPrice,
      sellerCutTotal,
      platformSubsidyTotal,
      sellerIncomeTotal,
      todayGmv,
      pendingReports,
      activeActivities,
      // pendingUsers 已随 D11 拆除（2026-09-23）：用户不再有待审核态
      todoTotal: pendingGoods + pendingReports
    }
  }
  return request({ url: '/admin/overview' })
}

export interface HotGoodsRow {
  goods: Goods
  /** 成交单数 */
  soldCount: number
  /** 成交金额 */
  amount: number
}

/** 热销榜：按订单成交单数排序（真实带货能力，而非浏览量） */
export async function fetchHotGoodsRank(limit = 8): Promise<HotGoodsRow[]> {
  if (USE_MOCK) {
    await mockHelpers.delay(260)
    const goods = mockHelpers.getGoodsCache()
    const paid = mockHelpers.getOrderCache().filter((o) => PAID_STATUS.includes(o.status))

    const stat = new Map<number, { soldCount: number; amount: number }>()
    for (const o of paid) {
      const cur = stat.get(o.goods.id) ?? { soldCount: 0, amount: 0 }
      cur.soldCount += 1
      cur.amount += o.amount
      stat.set(o.goods.id, cur)
    }

    return [...stat.entries()]
      .map(([goodsId, s]) => ({ goods: goods.find((g) => g.id === goodsId)!, ...s }))
      .filter((row) => !!row.goods)
      .sort((a, b) => b.soldCount - a.soldCount || b.amount - a.amount)
      .slice(0, limit)
  }
  return request({ url: '/admin/analytics/hot-goods', params: { limit } })
}
