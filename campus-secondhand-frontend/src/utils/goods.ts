/**
 * 商品维度的公共口径：数量（库存）与交易方式。
 *
 * 这两件事必须在**一处**定义：
 *  - 数量决定「购物车 / 立即购买最多能买几件」，发布页、详情页、购物车三处都要用同一个上限；
 *  - 交易方式是卖家在发布时选定的履约约定，详情页展示、后台审核都要读同一份文案。
 * 各写各的必然出现「发布页写 5 件、详情页写不限量」这种自相矛盾。
 */
import type { Goods } from '@/types'

/* ============================ 数量（库存） ============================ */

/** 卖家未填写数量时的默认值：校园二手多为单件闲置，按 1 件处理最保守 */
export const DEFAULT_STOCK = 1

/** 单个买家一单的数量上限（超过这个数二手车交易本来也不合理，且便于 mock 演示） */
export const MAX_ORDER_QUANTITY = 99

/**
 * 商品可售数量。
 *
 * 只有「未填写 / 非法值（NaN、负数）」才回落到 1 件；
 * **显式的 0 是「已售罄」**，必须原样返回 —— 若把 0 也当成未填写，
 * 卖光的商品在详情页仍会显示「仅剩 1 件」，而且 `createOrder` 扣减到 0
 * 之后还能继续卖（回归 bug）。
 */
export function resolveStock(goods: Pick<Goods, 'stock'> | null | undefined): number {
  const n = goods?.stock
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return DEFAULT_STOCK
  return Math.floor(n)
}

/** 「剩余 N 件」文案；售罄单独给一句，只剩 1 件时用「仅剩 1 件」制造合理的紧张感，不夸张 */
export function stockText(goods: Pick<Goods, 'stock'> | null | undefined): string {
  const n = resolveStock(goods)
  if (n === 0) return '已售罄'
  return n === 1 ? '仅剩 1 件' : `剩余 ${n} 件`
}

/**
 * 带「商品状态」的数量文案。
 *
 * 只看 stock 会自相矛盾：已售出的商品库存可能还剩 2（多件商品卖掉 1 件后置 sold，
 * 剩余数量对买家已无意义），页面就会出现「已售出 · 剩余 2 件」这种打架的文案。
 * 详情页等买家入口一律用这个口径：非在售状态直接说状态，不看库存。
 */
export function availabilityText(goods: Pick<Goods, 'stock' | 'status'> | null | undefined): string {
  if (!goods) return stockText(goods)
  if (goods.status === 'sold') return '已售出'
  if (goods.status === 'pending') return '审核中，暂不可购买'
  if (goods.status === 'off_shelf') return '已下架'
  return stockText(goods)
}

/* ============================ 交易方式（单选） ============================ */

export type DeliveryMethod = NonNullable<Goods['deliveryMethod']>

/** 交易方式选项：value 入库，label 展示，hint 说明差异（供发布页与详情页共用） */
export const DELIVERY_OPTIONS: Array<{ value: DeliveryMethod; label: string; hint: string }> = [
  { value: 'face', label: '校园面交', hint: '校内约时间当面交易，最快也最稳妥' },
  { value: 'express', label: '包邮快递', hint: '卖家承担运费，适合跨校区或假期' },
  { value: 'self', label: '自提', hint: '买家到卖家指定地点自取，运费自理' }
]

/** 交易方式 → 中文标签（未填写按「校园面交」） */
export const DELIVERY_LABEL: Record<DeliveryMethod, string> = {
  face: '校园面交',
  express: '包邮快递',
  self: '自提'
}

export function deliveryLabel(method: Goods['deliveryMethod']): string {
  return DELIVERY_LABEL[method ?? 'face'] ?? DELIVERY_LABEL.face
}
