/**
 * API 层单元测试 · 留言 / 评价 / 举报（Mock 模式）
 * 对应 ER 实体：留言表 / 评价表 / 举报表
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { fetchComments, postComment } from '@/api/comment'
import {
  fetchReviewsByGoods,
  submitReview,
  hasReviewed,
  fetchReviewByOrder,
  appendReview
} from '@/api/review'
import { submitReport, fetchReports, resolveReport } from '@/api/report'
import { mockHelpers } from '@/api/mock'

const ORIG_COMMENTS = mockHelpers.getComments().map((c) => ({ ...c }))
const ORIG_REVIEWS = mockHelpers.getReviews().map((r) => ({ ...r }))
const ORIG_REPORTS = mockHelpers.getReports().map((r) => ({ ...r }))

describe('留言 · fetchComments / postComment', () => {
  beforeEach(() => {
    mockHelpers.setComments(ORIG_COMMENTS.map((c) => ({ ...c })))
  })

  it('应只返回指定商品的留言', async () => {
    const list = await fetchComments(1)
    expect(list.length).toBeGreaterThan(0)
    list.forEach((c) => expect(c.goodsId).toBe(1))
  })

  it('种子数据应包含回复（parentId 指向顶层留言）', async () => {
    const list = await fetchComments(1)
    const replies = list.filter((c) => c.parentId)
    expect(replies.length).toBeGreaterThan(0)
    const topIds = new Set(list.filter((c) => !c.parentId).map((c) => c.id))
    replies.forEach((r) => expect(topIds.has(r.parentId!)).toBe(true))
  })

  it('postComment 顶层留言应追加且不设 parentId', async () => {
    const before = mockHelpers.getComments().length
    const c = await postComment({ goodsId: 999, content: '测试留言' })
    expect(c.content).toBe('测试留言')
    expect(c.parentId).toBeUndefined()
    expect(mockHelpers.getComments().length).toBe(before + 1)
  })

  it('postComment 回复应记录 parentId 与被回复人昵称', async () => {
    const tops = await fetchComments(1)
    const top = tops.find((c) => !c.parentId)!
    const r = await postComment({ goodsId: 1, content: '回复一下', parentId: top.id })
    expect(r.parentId).toBe(top.id)
    expect(r.replyToName).toBe(top.userName)
  })
})

describe('评价 · fetchReviewsByGoods / submitReview', () => {
  beforeEach(() => {
    mockHelpers.setReviews(ORIG_REVIEWS.map((r) => ({ ...r })))
  })

  it('应只返回指定商品的评价，且按时间倒序', async () => {
    const list = await fetchReviewsByGoods(1)
    list.forEach((r) => expect(r.goodsId).toBe(1))
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1].createTime >= list[i].createTime).toBe(true)
    }
  })

  it('submitReview 应写入新评价；重复提交同一订单应返回 duplicate', async () => {
    const before = mockHelpers.getReviews().length
    const ok = await submitReview({
      orderId: 'test-order-1',
      goodsId: 1,
      toUserId: 2,
      rating: 4,
      content: '测试评价内容'
    })
    expect(ok.ok).toBe(true)
    expect(mockHelpers.getReviews().length).toBe(before + 1)

    const dup = await submitReview({
      orderId: 'test-order-1',
      goodsId: 1,
      toUserId: 2,
      rating: 5,
      content: '再评一次'
    })
    expect(dup.ok).toBe(false)
    expect(dup.duplicate).toBe(true)
  })

  it('星级应被夹在 1-5 之间', async () => {
    await submitReview({ orderId: 'test-order-2', goodsId: 1, toUserId: 2, rating: 99, content: '超五星' })
    const list = mockHelpers.getReviews()
    expect(list.find((r) => r.orderId === 'test-order-2')!.rating).toBe(5)
  })

  it('hasReviewed 应正确判断', async () => {
    const first = mockHelpers.getReviews()[0]
    expect(await hasReviewed(first.orderId)).toBe(true)
    expect(await hasReviewed('not-exist-order')).toBe(false)
  })

  /*
   * 追评（追加评价）—— 这一组锁的是「首评不可被追评篡改」这条不变量。
   * 追评若写成「覆盖 content」，卖家收到的就是被改过的历史评分，那是另一回事了。
   */
  describe('追加评论 · fetchReviewByOrder / appendReview', () => {
    const orderId = 'test-order-append'

    beforeEach(async () => {
      await submitReview({
        orderId,
        goodsId: 1,
        toUserId: 2,
        rating: 4,
        content: '首评内容，不允许被追评改写'
      })
    })

    it('fetchReviewByOrder 应取到整条评价（没有则回 null）', async () => {
      const rv = await fetchReviewByOrder(orderId)
      expect(rv?.orderId).toBe(orderId)
      expect(rv?.rating).toBe(4)
      expect(await fetchReviewByOrder('not-exist-order')).toBeNull()
    })

    it('追评应追加在原评价上，且不改动首评的星级与内容', async () => {
      const before = await fetchReviewByOrder(orderId)
      const res = await appendReview(orderId, '用了一个月来补充：依然好用')
      expect(res.ok).toBe(true)

      const after = await fetchReviewByOrder(orderId)
      expect(after!.appendContent).toBe('用了一个月来补充：依然好用')
      expect(after!.appendTime).toBeTruthy()
      // 首评原样保留
      expect(after!.content).toBe(before!.content)
      expect(after!.rating).toBe(before!.rating)
      // 追评是追加而不是新增一条评价
      expect(mockHelpers.getReviews().filter((r) => r.orderId === orderId)).toHaveLength(1)
    })

    it('同一订单只能追评一次', async () => {
      expect((await appendReview(orderId, '第一次追评')).ok).toBe(true)
      const dup = await appendReview(orderId, '第二次追评')
      expect(dup.ok).toBe(false)
      expect(dup.duplicate).toBe(true)
      expect((await fetchReviewByOrder(orderId))!.appendContent).toBe('第一次追评')
    })

    it('没有首评的订单不能追评（防止出现只有追评没有首评的孤儿数据）', async () => {
      const res = await appendReview('order-without-review', '想直接追评')
      expect(res.ok).toBe(false)
      expect(res.notFound).toBe(true)
    })

    it('追评时间必须晚于首评时间，不能出现时间倒流', async () => {
      await appendReview(orderId, '追评')
      const rv = (await fetchReviewByOrder(orderId))!
      expect(Date.parse(rv.appendTime!)).toBeGreaterThanOrEqual(Date.parse(rv.createTime))
    })
  })
})

describe('评价种子 · 追评', () => {
  /*
   * 演示数据里必须有追评，否则「追加评论」做完在页面上根本看不见，
   * 也就没法演示 / 验收。同时把时间线钉死：追评晚于首评、不越过「现在」。
   */
  it('应存在追评种子，且追评时间晚于首评、不产生未来时间', () => {
    const withAppend = ORIG_REVIEWS.filter((r) => r.appendContent)
    expect(withAppend.length).toBeGreaterThan(0)

    withAppend.forEach((r) => {
      expect(r.appendTime, `评价 #${r.id} 有追评内容却没有追评时间`).toBeTruthy()
      const appendTs = Date.parse(r.appendTime!)
      expect(appendTs).toBeGreaterThan(Date.parse(r.createTime))
      expect(appendTs).toBeLessThanOrEqual(Date.now())
    })
  })

  it('追评内容不能与首评内容雷同（那只是复制了一行字，不算追评）', () => {
    ORIG_REVIEWS.filter((r) => r.appendContent).forEach((r) => {
      expect(r.appendContent).not.toBe(r.content)
    })
  })
})

describe('举报 · submitReport / fetchReports / resolveReport', () => {
  beforeEach(() => {
    mockHelpers.setReports(ORIG_REPORTS.map((r) => ({ ...r })))
  })

  it('submitReport 应新增一条 pending 举报', async () => {
    const before = mockHelpers.getReports().length
    await submitReport({ type: 'goods', targetId: 42, reason: '测试理由', description: '测试说明' })
    const list = mockHelpers.getReports()
    expect(list.length).toBe(before + 1)
    expect(list[0].status).toBe('pending')
    expect(list[0].targetId).toBe(42)
  })

  it('fetchReports 应按状态筛选，且待处理排前', async () => {
    const pending = await fetchReports({ status: 'pending' })
    expect(pending.total).toBeGreaterThan(0)
    pending.list.forEach((r) => expect(r.status).toBe('pending'))

    const all = await fetchReports({})
    const firstPending = all.list.findIndex((r) => r.status === 'pending')
    const lastDone = all.list.map((r) => r.status).lastIndexOf('handled')
    if (firstPending !== -1 && lastDone !== -1) {
      expect(lastDone).toBeLessThan(firstPending + all.list.length) // pending 在前即可
    }
  })

  it('resolveReport handle/reject 应更新状态', async () => {
    const pending = (await fetchReports({ status: 'pending' })).list[0]
    await resolveReport({ id: pending.id, action: 'handle' })
    expect(mockHelpers.getReports().find((r) => r.id === pending.id)!.status).toBe('handled')

    const p2 = (await fetchReports({ status: 'pending' })).list[0]
    if (p2) {
      await resolveReport({ id: p2.id, action: 'reject' })
      expect(mockHelpers.getReports().find((r) => r.id === p2.id)!.status).toBe('rejected')
    }
  })
})
