/**
 * 商品 + 分类 API
 */
import { request } from './request'
import { mockHelpers, mockCategories, goodsPhoto } from './mock'
import { resolveSessionUser } from './session'
import { resolveJoinableClaimsByCategory } from './activity'
import { settleJoin } from '@/utils/promo'
import { DEFAULT_STOCK } from '@/utils/goods'
import type { Goods, PageResult } from '@/types'

export { fetchCategories, fetchCategoryStats } from './category'
export type { CategoryStat } from './category'

const USE_MOCK = import.meta.env.VITE_USE_MOCK === 'true'

/** 商品状态 → 中文（用于操作日志描述，前后台共用同一套口径） */
export const GOODS_STATUS_LABEL: Record<string, string> = {
  on_sale: '在售',
  pending: '审核中',
  sold: '已售出',
  off_shelf: '已下架'
}

/**
 * 买家侧可见的商品状态（商品广场用）。
 *
 * 「审核中」是平台内部的流转状态，「已下架」是卖家自己的私有决定，
 * 两者都不该出现在买家的浏览入口 —— 否则买家点进去才发现根本买不了。
 * 「已售出」保留：卡片上有「已售出」角标，对同类商品的成交行情有参考价值。
 */
export const BUYER_VISIBLE_STATUS: Goods['status'][] = ['on_sale', 'sold']

/** 首页推荐位只推「真正能买」的商品，已售出也不推 */
export const SELLABLE_STATUS: Goods['status'][] = ['on_sale']

/**
 * 商品列表查询。
 *
 * `status` 与 `statuses` 的分工（这是买家侧与后台侧的关键差别）：
 *  - 后台商品审核要能按**单一状态**精确筛选（含「审核中」），用 `status`；
 *  - 买家侧（商品广场 / 首页推荐）只该看到**可交易**的商品，用 `statuses` 传白名单。
 *
 * 不给任何状态条件时返回全部 —— 这是后台的语义。
 * 买家入口必须显式传 `statuses`，否则「审核中」「已下架」的商品会直接出现在广场里，
 * 买家点进去才发现买不了（见 GoodsPanel 与 List.vue 的用法差异）。
 */
export async function fetchGoods(query: {
  page?: number
  pageSize?: number
  keyword?: string
  categoryId?: number
  /** 只看某个卖家的商品（他人主页「Ta 的在售」用） */
  sellerId?: number
  status?: string
  /** 多状态白名单（买家侧可见范围）；与 `status` 同时传时以 `status` 为准 */
  statuses?: Goods['status'][]
  sort?: 'new' | 'price_asc' | 'price_desc' | 'hot'
}): Promise<PageResult<Goods>> {
  if (USE_MOCK) {
    await mockHelpers.delay(380)
    const list = mockHelpers.getGoodsCache().slice()
    const page = query.page ?? 1
    const pageSize = query.pageSize ?? 12
    let filtered = list
    if (query.categoryId) filtered = filtered.filter((g) => g.categoryId === query.categoryId)
    if (query.sellerId) filtered = filtered.filter((g) => g.sellerId === query.sellerId)
    if (query.status) filtered = filtered.filter((g) => g.status === query.status)
    else if (query.statuses?.length) {
      const allow = new Set(query.statuses)
      filtered = filtered.filter((g) => allow.has(g.status))
    }
    if (query.keyword) {
      const kw = query.keyword.toLowerCase()
      filtered = filtered.filter((g) => g.title.toLowerCase().includes(kw))
    }
    if (query.sort === 'new') filtered.sort((a, b) => +new Date(b.createTime) - +new Date(a.createTime))
    if (query.sort === 'price_asc') filtered.sort((a, b) => a.price - b.price)
    if (query.sort === 'price_desc') filtered.sort((a, b) => b.price - a.price)
    if (query.sort === 'hot') filtered.sort((a, b) => b.viewCount - a.viewCount)
    const total = filtered.length
    const paged = filtered.slice((page - 1) * pageSize, page * pageSize)
    return { list: paged, total, page, pageSize }
  }
  return request({ url: '/goods', method: 'GET', params: query })
}

/** 商品详情 */
export async function fetchGoodsDetail(id: number | string): Promise<Goods> {
  if (USE_MOCK) {
    await mockHelpers.delay(200)
    const nid = Number(id)
    // 商品池里没有时回退「我的发布」：演示集商品（id 9000+）只存在 _myGoodsCache，
    // 不回退的话「我的发布 → 查看」必然 404（回归 bug）
    const g =
      mockHelpers.getGoodsCache().find((x) => x.id === nid) ??
      mockHelpers.getMyGoodsCache().find((x) => x.id === nid)
    if (!g) throw new Error('商品不存在')
    return g
  }
  return request({ url: `/goods/${id}` })
}

/** 发布商品 */
/**
 * 发布商品（卖家报名活动也在这里发生）。
 *
 * `activityId` 是**唯一**能让卖家自己的商品获得让利价的入口：
 *   - 报了名 → 按该活动声明的 `rate` 用 `promoPriceFor()` 算出让利价，并记下 `activityId`；
 *   - 没报名 / 分类不在该活动的让利声明内 / 算出的价不低于挂牌价 → `promoPrice: undefined`（按挂牌价成交）。
 *
 * ⚠️ 入参里**故意不提供**让利金额或折扣字段：卖家只能决定「参不参加」，
 *    不能决定「打几折」—— 折扣力度由活动声明统一决定，否则又变成卖家自定价。
 */
export async function publishGoods(payload: Partial<Goods>): Promise<Goods> {
  if (USE_MOCK) {
    await mockHelpers.delay(450)

    /*
     * 封禁账号走不到这里（登录与会话两道闸门已经拦住）。
     * 用户「待审核」状态已随 D11 拆除（2026-09-23）：注册即 active，
     * 这里原有的 pending 发布闸门一并移除。
     */
    const list = mockHelpers.getGoodsCache()
    const price = payload.price ?? 0
    const categoryId = payload.categoryId ?? 1

    /*
     * 报名结算：命中活动声明就按规则生成让利价。
     * 走 `settleJoin()`（`utils/promo.ts`）—— 与发布页的实时预览是**同一个函数**，
     * 保证「卖家看到省多少」与「买家实际付多少」不会出现两套算法。
     *
     * 一个分类可能挂着多条在招活动（如生活用品同时有卖家让利的开学季与平台补贴的
     * 宿舍焕新），所以这里查的是**全部**可报名声明，再按卖家选定的 id 精确匹配：
     * 选中哪条就按哪条的力度与资金归属算，不猜、不按优先级替卖家决定。
     */
    const joinable = payload.activityId ? resolveJoinableClaimsByCategory(categoryId) : []
    const matched = joinable.find((c) => c.activityId === payload.activityId) ?? null
    const breakdown = matched ? settleJoin(price, matched.rate, matched.fundSource) : null

    const newG: Goods = {
      id: list.length + 1,
      title: payload.title || '未命名',
      price,
      // 让利价只能由「报名 + 活动规则」产生，卖家不能自填「原价」
      promoPrice: breakdown && breakdown.onPromo ? breakdown.payAmount : undefined,
      activityId: breakdown && breakdown.onPromo ? matched!.activityId : undefined,
      // 封面：卖家上传的图优先 → 分类实拍图池 → makeCover 渐变兜底
      cover: payload.cover || goodsPhoto(categoryId, Date.now() % 3),
      images: payload.images || [],
      description: payload.description || '',
      status: 'pending',
      // 数量与交易方式由卖家填写，缺失时落保守默认值（1 件 / 校园面交），绝不落成 undefined
      stock: payload.stock && payload.stock > 0 ? Math.floor(payload.stock) : DEFAULT_STOCK,
      deliveryMethod: payload.deliveryMethod ?? 'face',
      categoryId,
      categoryName: mockCategories.find((c) => c.id === categoryId)?.name ?? '',
      sellerId: 1,
      sellerName: '我',
      sellerAvatar: 'https://api.dicebear.com/7.x/initials/svg?seed=me',
      location: payload.location || '校园内',
      viewCount: 0,
      favoriteCount: 0,
      createTime: new Date().toISOString()
    }
    mockHelpers.setGoodsCache([newG, ...list])
    return newG
  }
  return request({ url: '/goods', method: 'POST', data: payload })
}

/** 切换上下架 / 审核（写操作会记入操作日志） */
export async function updateGoodsStatus(payload: { id: number; status: Goods['status'] }): Promise<void> {
  if (USE_MOCK) {
    await mockHelpers.delay(250)
    const list = mockHelpers.getGoodsCache()
    const g = list.find((x) => x.id === payload.id)
    if (g) g.status = payload.status
    mockHelpers.setGoodsCache(list)
    if (g) {
      mockHelpers.addAuditLog({
        action: 'goods.status',
        actionLabel: '修改商品状态',
        target: `商品 #${g.id}`,
        detail: `${g.title} → ${GOODS_STATUS_LABEL[payload.status] ?? payload.status}`
      })
    }
    return
  }
  return request({ url: `/goods/${payload.id}/status`, method: 'PATCH', data: { status: payload.status } })
}

/** 删除商品 */
export async function deleteGoods(id: number): Promise<void> {
  if (USE_MOCK) {
    await mockHelpers.delay(220)
    const target = mockHelpers.getGoodsCache().find((x) => x.id === id)
    mockHelpers.setGoodsCache(mockHelpers.getGoodsCache().filter((x) => x.id !== id))
    if (target) {
      mockHelpers.addAuditLog({
        action: 'goods.delete',
        actionLabel: '删除商品',
        target: `商品 #${target.id}`,
        detail: target.title
      })
    }
    return
  }
  return request({ url: `/goods/${id}`, method: 'DELETE' })
}

/** 批量修改商品状态（后台多选后一次性通过 / 下架） */
export async function batchUpdateGoodsStatus(ids: number[], status: Goods['status']): Promise<number> {
  if (USE_MOCK) {
    await mockHelpers.delay(320)
    if (!ids.length) return 0
    const set = new Set(ids)
    const list = mockHelpers.getGoodsCache()
    list.forEach((g) => {
      if (set.has(g.id)) g.status = status
    })
    mockHelpers.setGoodsCache(list)
    mockHelpers.addAuditLog({
      action: 'goods.batchStatus',
      actionLabel: '批量修改商品状态',
      target: `${ids.length} 件商品`,
      detail: `ID：${ids.join('、')} → ${GOODS_STATUS_LABEL[status] ?? status}`
    })
    return ids.length
  }
  return request({ url: '/admin/goods/batch-status', method: 'PATCH', data: { ids, status } })
}

/** 批量删除商品 */
export async function batchDeleteGoods(ids: number[]): Promise<number> {
  if (USE_MOCK) {
    await mockHelpers.delay(320)
    if (!ids.length) return 0
    const set = new Set(ids)
    const before = mockHelpers.getGoodsCache()
    const removed = before.filter((g) => set.has(g.id))
    mockHelpers.setGoodsCache(before.filter((g) => !set.has(g.id)))
    mockHelpers.addAuditLog({
      action: 'goods.batchDelete',
      actionLabel: '批量删除商品',
      target: `${removed.length} 件商品`,
      detail: `ID：${ids.join('、')}`
    })
    return removed.length
  }
  return request({ url: '/admin/goods/batch-delete', method: 'POST', data: { ids } })
}
