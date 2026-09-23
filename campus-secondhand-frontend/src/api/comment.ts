/**
 * 商品留言 API（留言表：用户-商品「留言」、留言-留言「评论、回复」）
 */
import { request } from './request'
import { mockHelpers, mockUsersExport } from './mock'
import type { GoodsComment, PageResult } from '@/types'

const USE_MOCK = import.meta.env.VITE_USE_MOCK === 'true'

/** 拉取某商品的留言（时间正序，回复紧跟父留言） */
export async function fetchComments(goodsId: number): Promise<GoodsComment[]> {
  if (USE_MOCK) {
    await new Promise((r) => setTimeout(r, 200))
    return mockHelpers
      .getComments()
      .filter((c) => c.goodsId === goodsId)
      .sort((a, b) => (a.createTime < b.createTime ? -1 : 1))
  }
  return request({ url: `/goods/${goodsId}/comments`, showLoading: false })
}

/** 发表留言 / 回复（parentId 传父留言 id 即为回复） */
export async function postComment(payload: {
  goodsId: number
  content: string
  parentId?: number
}): Promise<GoodsComment> {
  if (USE_MOCK) {
    await new Promise((r) => setTimeout(r, 180))
    const list = mockHelpers.getComments()
    const me = mockUsersExport[0]
    let replyToName: string | undefined
    if (payload.parentId) {
      replyToName = list.find((c) => c.id === payload.parentId)?.userName
    }
    const c: GoodsComment = {
      id: Math.max(0, ...list.map((x) => x.id)) + 1,
      goodsId: payload.goodsId,
      userId: me.id,
      userName: me.nickname,
      userAvatar: me.avatar,
      content: payload.content,
      parentId: payload.parentId,
      replyToName,
      createTime: new Date().toISOString()
    }
    mockHelpers.setComments([...list, c])
    return c
  }
  return request({
    url: `/goods/${payload.goodsId}/comments`,
    method: 'POST',
    data: { content: payload.content, parentId: payload.parentId }
  })
}

/* ====================================================================
 * 管理端：留言审核
 * 留言是「树」，后台删除顶层留言时必须连带删除它的回复，
 * 否则会留下 parentId 指向已删除记录的孤儿节点。
 * ==================================================================== */

export interface AdminCommentRow extends GoodsComment {
  /** 所属商品标题（联表字段，后台列表展示用） */
  goodsTitle: string
  /** 是否是一条回复 */
  isReply: boolean
}

/** 全部留言（后台内容审核列表，分页 + 关键字） */
export async function fetchAdminComments(query: {
  page?: number
  pageSize?: number
  keyword?: string
  goodsId?: number
} = {}): Promise<PageResult<AdminCommentRow>> {
  if (USE_MOCK) {
    await new Promise((r) => setTimeout(r, 240))
    const page = query.page ?? 1
    const pageSize = query.pageSize ?? 10
    const kw = query.keyword?.trim().toLowerCase() ?? ''
    const goodsMap = new Map(mockHelpers.getGoodsCache().map((g) => [g.id, g.title]))

    let list = mockHelpers.getComments().map<AdminCommentRow>((c) => ({
      ...c,
      goodsTitle: goodsMap.get(c.goodsId) ?? `商品 #${c.goodsId}`,
      isReply: !!c.parentId
    }))
    if (query.goodsId) list = list.filter((c) => c.goodsId === query.goodsId)
    if (kw) {
      list = list.filter(
        (c) => c.content.toLowerCase().includes(kw) || c.userName.toLowerCase().includes(kw)
      )
    }
    // 新的在前，方便先看最新内容
    list.sort((a, b) => (a.createTime < b.createTime ? 1 : -1))

    const total = list.length
    return { list: list.slice((page - 1) * pageSize, page * pageSize), total, page, pageSize }
  }
  return request({ url: '/admin/comments', method: 'GET', params: query })
}

/** 删除留言：顶层留言会连带删除其下全部回复，返回实际删除条数 */
export async function deleteComment(id: number): Promise<{ removed: number }> {
  if (USE_MOCK) {
    await new Promise((r) => setTimeout(r, 200))
    const list = mockHelpers.getComments()
    const target = list.find((c) => c.id === id)
    if (!target) return { removed: 0 }

    // 只允许两层：顶层 id 下挂的回复 parentId === id
    const removedRows = list.filter((c) => c.id === id || c.parentId === id)
    mockHelpers.setComments(list.filter((c) => c.id !== id && c.parentId !== id))

    mockHelpers.addAuditLog({
      action: 'content.commentDelete',
      actionLabel: '删除留言',
      target: `留言 #${id}（商品 #${target.goodsId}）`,
      detail: `${target.userName}：${target.content.slice(0, 30)}${removedRows.length > 1 ? `（含 ${removedRows.length - 1} 条回复）` : ''}`
    })
    return { removed: removedRows.length }
  }
  return request({ url: `/admin/comments/${id}`, method: 'DELETE' })
}
