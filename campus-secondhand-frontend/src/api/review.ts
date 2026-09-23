/**
 * 评价 API（评价表：订单-评价-用户-被评价人）
 * 买家完成订单后评价卖家；评价展示在商品详情页。
 */
import { request } from './request'
import { mockHelpers, mockUsersExport } from './mock'
import type { Review, PageResult } from '@/types'

const USE_MOCK = import.meta.env.VITE_USE_MOCK === 'true'

/** 拉取某商品的评价（时间倒序） */
export async function fetchReviewsByGoods(goodsId: number): Promise<Review[]> {
  if (USE_MOCK) {
    await new Promise((r) => setTimeout(r, 200))
    return mockHelpers
      .getReviews()
      .filter((r) => r.goodsId === goodsId)
      .sort((a, b) => (a.createTime < b.createTime ? 1 : -1))
  }
  return request({ url: `/goods/${goodsId}/reviews`, showLoading: false })
}

/**
 * 提交评价（订单完成后，一个订单只允许评价一次）
 * 返回：ok=成功；duplicate=该订单已评价过
 */
export async function submitReview(payload: {
  orderId: string
  goodsId: number
  toUserId: number
  rating: number
  content: string
}): Promise<{ ok: boolean; duplicate?: boolean }> {
  if (USE_MOCK) {
    await new Promise((r) => setTimeout(r, 220))
    const list = mockHelpers.getReviews()
    if (list.some((r) => r.orderId === payload.orderId)) {
      return { ok: false, duplicate: true }
    }
    const me = mockUsersExport[0]
    const review: Review = {
      id: Math.max(0, ...list.map((x) => x.id)) + 1,
      orderId: payload.orderId,
      goodsId: payload.goodsId,
      fromUserId: me.id,
      fromUserName: me.nickname,
      fromUserAvatar: me.avatar,
      toUserId: payload.toUserId,
      rating: Math.min(5, Math.max(1, Math.round(payload.rating))),
      content: payload.content,
      createTime: new Date().toISOString()
    }
    mockHelpers.setReviews([...list, review])
    return { ok: true }
  }
  return request({ url: '/reviews', method: 'POST', data: payload })
}

/** 查询某订单是否已评价 */
export async function hasReviewed(orderId: string): Promise<boolean> {
  if (USE_MOCK) {
    return mockHelpers.getReviews().some((r) => r.orderId === orderId)
  }
  const list = await request<Review[]>({ url: `/orders/${orderId}/review`, showLoading: false })
  return Array.isArray(list) && list.length > 0
}

/**
 * 取某订单的评价实体（而不是只回一个布尔）。
 *
 * 订单列表要区分「没评 / 评了没追 / 追过了」三种状态，
 * 只靠 hasReviewed 的布尔量推不出「追评」，所以这里把整条评价回给页面。
 */
export async function fetchReviewByOrder(orderId: string): Promise<Review | null> {
  if (USE_MOCK) {
    await new Promise((r) => setTimeout(r, 120))
    return mockHelpers.getReviews().find((r) => r.orderId === orderId) ?? null
  }
  const list = await request<Review[]>({ url: `/orders/${orderId}/review`, showLoading: false })
  return Array.isArray(list) && list.length ? list[0] : null
}

/**
 * 追加评价（追评）。
 *
 * 与 submitReview 的分工：
 *   - submitReview = 首评，一单一次，重复提交回 duplicate；
 *   - appendReview = 追评，必须已有首评，一单也只能追一次（主流电商口径）。
 * 首评的星级与内容不会被覆盖 —— 追评是「另起一段」，不是「编辑」。
 */
export async function appendReview(
  orderId: string,
  content: string
): Promise<{ ok: boolean; notFound?: boolean; duplicate?: boolean }> {
  if (USE_MOCK) {
    await new Promise((r) => setTimeout(r, 220))
    const list = mockHelpers.getReviews()
    const target = list.find((r) => r.orderId === orderId)
    // 还没首评就想追评 —— 先让用户把首评写了
    if (!target) return { ok: false, notFound: true }
    if (target.appendContent) return { ok: false, duplicate: true }
    mockHelpers.setReviews(
      list.map((r) =>
        r.orderId === orderId
          ? { ...r, appendContent: content, appendTime: new Date().toISOString() }
          : r
      )
    )
    return { ok: true }
  }
  return request({ url: `/orders/${orderId}/review/append`, method: 'POST', data: { content } })
}

/** 某用户「收到」的评价（他人主页展示用，时间倒序） */
export async function fetchReviewsByUser(userId: number): Promise<Review[]> {
  if (USE_MOCK) {
    await new Promise((r) => setTimeout(r, 200))
    return mockHelpers
      .getReviews()
      .filter((r) => r.toUserId === userId)
      .sort((a, b) => (a.createTime < b.createTime ? 1 : -1))
  }
  return request({ url: `/users/${userId}/reviews`, showLoading: false })
}

/* ====================================================================
 * 管理端：评价审核
 * 评价本身没有层级，删除是一对一的；但评价带有星级，后台需要能按「差评」筛。
 * ==================================================================== */

export interface AdminReviewRow extends Review {
  /** 所属商品标题（联表字段） */
  goodsTitle: string
}

/** 全部评价（后台内容审核列表，分页 + 关键字 + 星级筛选） */
export async function fetchAdminReviews(query: {
  page?: number
  pageSize?: number
  keyword?: string
  /** 只看某个星级；传 'low' 表示只看 1-3 星差评 */
  rating?: number | 'low'
} = {}): Promise<PageResult<AdminReviewRow>> {
  if (USE_MOCK) {
    await new Promise((r) => setTimeout(r, 240))
    const page = query.page ?? 1
    const pageSize = query.pageSize ?? 10
    const kw = query.keyword?.trim().toLowerCase() ?? ''
    const goodsMap = new Map(mockHelpers.getGoodsCache().map((g) => [g.id, g.title]))
    const userMap = new Map(mockHelpers.getUsersCache().map((u) => [u.id, u.nickname]))

    let list = mockHelpers.getReviews().map<AdminReviewRow>((r) => ({
      ...r,
      goodsTitle: goodsMap.get(r.goodsId) ?? `商品 #${r.goodsId}`,
      fromUserName: r.fromUserName || userMap.get(r.fromUserId) || `用户 #${r.fromUserId}`
    }))
    if (query.rating === 'low') list = list.filter((r) => r.rating <= 3)
    else if (typeof query.rating === 'number') list = list.filter((r) => r.rating === query.rating)
    if (kw) {
      list = list.filter(
        (r) => r.content.toLowerCase().includes(kw) || r.fromUserName.toLowerCase().includes(kw)
      )
    }
    list.sort((a, b) => (a.createTime < b.createTime ? 1 : -1))

    const total = list.length
    return { list: list.slice((page - 1) * pageSize, page * pageSize), total, page, pageSize }
  }
  return request({ url: '/admin/reviews', method: 'GET', params: query })
}

/** 删除评价（被删除后，对应订单会重新变回「可评价」） */
export async function deleteReview(id: number): Promise<void> {
  if (USE_MOCK) {
    await new Promise((r) => setTimeout(r, 200))
    const list = mockHelpers.getReviews()
    const target = list.find((r) => r.id === id)
    mockHelpers.setReviews(list.filter((r) => r.id !== id))
    if (target) {
      mockHelpers.addAuditLog({
        action: 'content.reviewDelete',
        actionLabel: '删除评价',
        target: `评价 #${id}（订单 ${target.orderId}）`,
        detail: `${target.rating} 星 · ${target.content.slice(0, 30)}`
      })
    }
    return
  }
  return request({ url: `/admin/reviews/${id}`, method: 'DELETE' })
}
