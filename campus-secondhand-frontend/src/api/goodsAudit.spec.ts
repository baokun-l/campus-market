/**
 * 商品审核后台 + 双审核员账号 · 单元测试
 *
 * 锁四件事：
 *  ① 两个审核员账号能按约定密码登录、token 复用 user 正则（session 零改动）
 *  ② 通过 → on_sale、驳回 → off_shelf 且理由 ≥ 5 字、非 pending 重复审核抛错
 *  ③ 每次审核都留痕：记录带操作人（会话昵称）、记录与统计口径一致
 *  ④ 举报处理人不再硬编码「管理员」，而是当前会话昵称
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { SESSION_KEY } from '@/api/session'
import { login } from '@/api/user'
import { resolveReport } from '@/api/report'
import {
  fetchPendingGoods,
  fetchGoodsAuditDetail,
  fetchGoodsAuditRecords,
  fetchGoodsAuditStats,
  reviewGoods
} from '@/api/goodsAudit'
import { mockHelpers, mockUsersExport } from '@/api/mock'
import type { Goods } from '@/types'

/* ---------------- 测试夹具 ---------------- */

/** 构造一件最小可用的商品（缺少的字段对审核逻辑不可见） */
function makeGoods(id: number, status: Goods['status'], title = `测试商品${id}`): Goods {
  return {
    id,
    title,
    price: 50,
    cover: '/goods/cat1-1.jpg',
    images: [],
    description: '九成新',
    status,
    categoryId: 1,
    categoryName: '教材',
    sellerId: 2,
    sellerName: '旧书摊李同学',
    sellerAvatar: '',
    location: '东区',
    viewCount: 0,
    favoriteCount: 0,
    createTime: '2026-09-01T10:00:00'
  }
}

/** 把商品池 / 我的商品缓存重置成已知状态，避免用例互相污染 */
function resetCaches(pool: Goods[], mine: Goods[]) {
  mockHelpers.setGoodsCache(pool)
  mockHelpers.setMyGoodsCache(mine)
}

function signInAs(id: number) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ token: `mock-token-user-${id}` }))
}

async function captureError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return await fn()
  } catch (e) {
    return e
  }
}

beforeEach(() => {
  localStorage.clear()
  // 池里：1 件在售、1 件待审；「我的商品」缓存里：1 件待审（证明查找横跨两个缓存）
  const mine = makeGoods(201, 'pending', '待审·自行车')
  mine.sellerName = '数码王同学' // 与池里的待审商品区分开，卖家搜索才能命中唯一
  resetCaches([makeGoods(101, 'on_sale'), makeGoods(102, 'pending', '待审·高数教材')], [mine])
})

/* ---------------- ① 双审核员账号 ---------------- */
describe('双审核员账号与登录', () => {
  it('goods_admin 用约定密码登录，token 落在 user 正则区间（97）', async () => {
    const res = await login({ username: 'goods_admin', password: 'goods123456' })
    expect(res.token).toBe('mock-token-user-97')
    expect(res.user.role).toBe('goods_admin')
  })

  it('report_admin 用约定密码登录（98），密码错误被拒', async () => {
    const ok = await login({ username: 'report_admin', password: 'report123456' })
    expect(ok.token).toBe('mock-token-user-98')
    expect(ok.user.role).toBe('report_admin')

    const err = await captureError(() => login({ username: 'report_admin', password: 'wrong-password' }))
    expect(err).toBeInstanceOf(Error)
  })

  it('审核员账号不能被批量封禁（管理员类账号保护）', async () => {
    const { batchToggleUserStatus } = await import('@/api/user')
    const n = await batchToggleUserStatus([97, 98, 2], true)
    expect(n).toBe(1) // 只有普通用户 id=2 被封
    expect(mockUsersExport.find((u) => u.id === 97)!.status).toBe('active')
    expect(mockUsersExport.find((u) => u.id === 98)!.status).toBe('active')
  })
})

/* ---------------- ② 审核动作 ---------------- */
describe('reviewGoods · 审核动作', () => {
  beforeEach(() => signInAs(97)) // 商品审核员登录

  it('通过：pending → on_sale，记录留痕且操作人是会话昵称', async () => {
    await reviewGoods({ goodsId: 102, action: 'approve' })
    expect(mockHelpers.getGoodsCache().find((g) => g.id === 102)!.status).toBe('on_sale')

    const { list } = await fetchGoodsAuditRecords()
    expect(list).toHaveLength(1)
    expect(list[0].action).toBe('approve')
    expect(list[0].operator).toBe('商品审核员')
    expect(list[0].goodsTitle).toBe('待审·高数教材')
    expect(list[0].reason).toBeUndefined()
  })

  it('驳回：理由不足 5 字抛错；合规理由 → off_shelf 且记录带理由', async () => {
    const short = await captureError(() => reviewGoods({ goodsId: 102, action: 'reject', reason: '不行' }))
    expect(short).toBeInstanceOf(Error)
    // 抛错后状态不能变
    expect(mockHelpers.getGoodsCache().find((g) => g.id === 102)!.status).toBe('pending')

    await reviewGoods({ goodsId: 102, action: 'reject', reason: '图片与实物不符，请重新拍摄' })
    expect(mockHelpers.getGoodsCache().find((g) => g.id === 102)!.status).toBe('off_shelf')
    const { list } = await fetchGoodsAuditRecords()
    expect(list[0].action).toBe('reject')
    expect(list[0].reason).toBe('图片与实物不符，请重新拍摄')
  })

  it('重复审核抛错：已通过的不能再驳回（状态闸门）', async () => {
    await reviewGoods({ goodsId: 102, action: 'approve' })
    const err = await captureError(() => reviewGoods({ goodsId: 102, action: 'reject', reason: '再驳一次试试' }))
    expect(err).toBeInstanceOf(Error)
    expect(mockHelpers.getGoodsCache().find((g) => g.id === 102)!.status).toBe('on_sale')
  })

  it('「我的商品」缓存里的 pending 也能审到（横跨两个缓存）', async () => {
    await reviewGoods({ goodsId: 201, action: 'approve' })
    expect(mockHelpers.getMyGoodsCache().find((g) => g.id === 201)!.status).toBe('on_sale')
  })
})

/* ---------------- ③ 列表与统计 ---------------- */
describe('fetchPendingGoods / stats / detail', () => {
  it('待审列表同时覆盖商品池与我的商品缓存，关键字可搜标题与卖家', async () => {
    const all = await fetchPendingGoods()
    expect(all.total).toBe(2)

    const byTitle = await fetchPendingGoods({ keyword: '自行车' })
    expect(byTitle.total).toBe(1)
    expect(byTitle.list[0].id).toBe(201)

    const bySeller = await fetchPendingGoods({ keyword: '旧书摊' })
    expect(bySeller.total).toBe(1)
  })

  it('统计口径：待审不含已审，通过/驳回分别计数', async () => {
    signInAs(97)
    // 审核记录是模块内存态，同文件前序用例已累积若干条 —— 用**增量**断言，与执行顺序解耦
    const before = await fetchGoodsAuditStats()
    await reviewGoods({ goodsId: 102, action: 'approve' })
    const s = await fetchGoodsAuditStats()
    expect(s.pending).toBe(1) // 只剩 201
    expect(s.approved).toBe(before.approved + 1)
    expect(s.rejected).toBe(before.rejected)
    expect(s.today).toBe(before.today + 1)
  })

  it('详情带回卖家信用概况', async () => {
    const d = await fetchGoodsAuditDetail(102)
    expect(d.goods.id).toBe(102)
    expect(d.seller.nickname).toBe('旧书摊李同学')
    expect(d.seller.creditScore).toBeGreaterThan(0)
  })
})

/* ---------------- ④ 举报处理人 = 会话昵称 ---------------- */
describe('report · 处理人取会话昵称', () => {
  it('举报审核员处理举报后，handledBy 是「举报审核员」而不是硬编码管理员', async () => {
    signInAs(98)
    // 造一条 pending 举报直接塞进缓存（不依赖种子数据）
    const report = {
      id: 9001,
      type: 'goods' as const,
      targetId: 101,
      reason: '假货',
      description: '描述与实物不符',
      status: 'pending' as const,
      createTime: new Date().toISOString()
    }
    mockHelpers.setReports([report])

    await resolveReport({ id: 9001, action: 'handle', measure: 'warn', remark: '情况属实，先警示' })
    const saved = mockHelpers.getReports().find((r) => r.id === 9001)!
    expect(saved.handledBy).toBe('举报审核员')
  })
})
