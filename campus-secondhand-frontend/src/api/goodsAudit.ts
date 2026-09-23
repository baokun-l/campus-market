/**
 * 商品审核后台 API（独立于全能管理员的商品管理，职能单一）。
 *
 * 职能边界（只能做这三件事，别的不归它管）：
 *  ① 查看待审核商品列表（status === 'pending'）
 *  ② 通过（→ on_sale）/ 驳回（→ off_shelf，理由必填 ≥ 5 字）
 *  ③ 查看审核记录（只增不改，出争议可复核）
 *
 * 数据说明：
 *  - 商品池 + 「我的商品」缓存里都可能有 pending 商品（演示的 8 件「我的商品」
 *    四种状态齐全），所以查找与写入都要**横跨两个缓存**，漏一个就会出现
 *    「列表里看得见、点通过没反应」。
 *  - 审核记录存模块内存（遵守「不为单个功能新增 localStorage 键」的约定），
 *    商品状态本身走既有商品缓存、刷新不丢；记录刷新重置是 mock 层已知的取舍。
 */
import { request } from './request'
import { mockHelpers, mockUsersExport } from './mock'
import { resolveSessionUser } from './session'
import type { Goods, GoodsAuditRecord, GoodsAuditAction, PageResult } from '@/types'

const USE_MOCK = import.meta.env.VITE_USE_MOCK === 'true'

/* ====================================================================
 * 审核记录（内存态，只增不改）
 * ==================================================================== */
let _auditRecords: GoodsAuditRecord[] = []
let _nextRecordId = 1

/** 当前操作人（会话昵称；取不到兜底，保证记录永远有名有姓） */
function operator(): string {
  return resolveSessionUser()?.nickname ?? '商品审核员'
}

/* ====================================================================
 * 待审核商品
 * ==================================================================== */

/**
 * 收集全部 pending 商品：商品池 + 我的商品缓存，按 id 去重、新发布的在前。
 * 返回行级浅拷贝 —— 表格直接改行对象不会反映到缓存，改完必然「看起来没生效」。
 */
function collectPending(): Goods[] {
  const pool = mockHelpers.getGoodsCache().filter((g) => g.status === 'pending')
  const mine = mockHelpers.getMyGoodsCache().filter((g) => g.status === 'pending')
  const seen = new Set(pool.map((g) => g.id))
  return [...pool, ...mine.filter((g) => !seen.has(g.id))].map((g) => ({ ...g }))
}

/** 待审核商品列表（分页 + 标题/卖家关键字） */
export async function fetchPendingGoods(query: {
  page?: number
  pageSize?: number
  keyword?: string
} = {}): Promise<PageResult<Goods>> {
  if (USE_MOCK) {
    await mockHelpers.delay(260)
    const page = query.page ?? 1
    const pageSize = query.pageSize ?? 10
    const kw = query.keyword?.trim().toLowerCase() ?? ''
    let list = collectPending()
    if (kw) {
      list = list.filter(
        (g) => g.title.toLowerCase().includes(kw) || g.sellerName.toLowerCase().includes(kw)
      )
    }
    const total = list.length
    list = list.slice((page - 1) * pageSize, page * pageSize)
    return { list, total, page, pageSize }
  }
  return request({ url: '/review/goods/pending', method: 'GET', params: query })
}

/** 审核详情：商品 + 卖家信用概况（核实「该不该过」时要看卖家是谁、信用如何） */
export interface GoodsAuditDetail {
  goods: Goods
  seller: { id: number; nickname: string; creditScore: number; status: string; onSaleCount: number }
}

export async function fetchGoodsAuditDetail(goodsId: number): Promise<GoodsAuditDetail> {
  if (USE_MOCK) {
    await mockHelpers.delay(200)
    const all = [
      ...mockHelpers.getGoodsCache(),
      ...mockHelpers.getMyGoodsCache().filter((m) => !mockHelpers.getGoodsCache().some((p) => p.id === m.id))
    ]
    const g = all.find((x) => x.id === goodsId)
    if (!g) throw new Error('商品不存在')
    const seller = mockUsersExport.find((u) => u.id === g.sellerId)
    return {
      goods: { ...g },
      seller: {
        id: g.sellerId,
        nickname: seller?.nickname ?? g.sellerName,
        creditScore: seller?.creditScore ?? 100,
        status: seller?.status ?? 'active',
        onSaleCount: all.filter((x) => x.sellerId === g.sellerId && x.status === 'on_sale').length
      }
    }
  }
  return request({ url: `/review/goods/${goodsId}/detail` })
}

/* ====================================================================
 * 审核动作
 * ==================================================================== */

/**
 * 审核一件商品（**唯一审核入口**）。
 *  - approve → on_sale（通过上架）
 *  - reject  → off_shelf，理由必填且 ≥ 5 字（「不合格」三个字等于没说）
 *  - 只有 pending 可审：已通过/已驳回的商品重复审核直接抛错，
 *    防止「驳回后又悄悄改成通过」这类不可追溯的操作。
 */
export async function reviewGoods(payload: {
  goodsId: number
  action: GoodsAuditAction
  reason?: string
}): Promise<void> {
  if (USE_MOCK) {
    await mockHelpers.delay(320)
    const reason = payload.reason?.trim() ?? ''
    if (payload.action === 'reject' && reason.length < 5) {
      throw new Error('驳回理由至少 5 个字，让卖家知道差在哪里')
    }

    // 横跨两个缓存找目标（见文件头说明）
    const pool = mockHelpers.getGoodsCache()
    let target = pool.find((g) => g.id === payload.goodsId && g.status === 'pending')
    let inPool = true
    if (!target) {
      const mine = mockHelpers.getMyGoodsCache()
      target = mine.find((g) => g.id === payload.goodsId && g.status === 'pending')
      inPool = false
    }
    if (!target) {
      const exists = [...pool, ...mockHelpers.getMyGoodsCache()].some((g) => g.id === payload.goodsId)
      throw new Error(exists ? '该商品不在待审核状态，无需重复审核' : '商品不存在')
    }

    const nextStatus: Goods['status'] = payload.action === 'approve' ? 'on_sale' : 'off_shelf'
    target.status = nextStatus
    if (inPool) {
      mockHelpers.setGoodsCache(pool.map((g) => (g.id === target!.id ? { ...g, status: nextStatus } : g)))
    } else {
      const mine = mockHelpers.getMyGoodsCache()
      mockHelpers.setMyGoodsCache(mine.map((g) => (g.id === target!.id ? { ...g, status: nextStatus } : g)))
    }

    const record: GoodsAuditRecord = {
      id: _nextRecordId++,
      goodsId: target.id,
      goodsTitle: target.title,
      action: payload.action,
      reason: payload.action === 'reject' ? reason : undefined,
      operator: operator(),
      time: new Date().toISOString()
    }
    _auditRecords.unshift(record)

    mockHelpers.addAuditLog({
      action: payload.action === 'approve' ? 'goodsAudit.approve' : 'goodsAudit.reject',
      actionLabel: payload.action === 'approve' ? '商品审核通过' : '商品审核驳回',
      target: `商品 #${target.id}`,
      detail:
        payload.action === 'approve'
          ? `《${target.title}》审核通过，上架售卖（审核人：${record.operator}）`
          : `《${target.title}》审核驳回：${reason}（审核人：${record.operator}）`
    })
    return
  }
  return request({ url: `/review/goods/${payload.goodsId}/review`, method: 'POST', data: payload })
}

/* ====================================================================
 * 审核记录与统计
 * ==================================================================== */

/** 审核记录（新→旧，分页） */
export async function fetchGoodsAuditRecords(query: {
  page?: number
  pageSize?: number
  keyword?: string
} = {}): Promise<PageResult<GoodsAuditRecord>> {
  if (USE_MOCK) {
    await mockHelpers.delay(220)
    const page = query.page ?? 1
    const pageSize = query.pageSize ?? 10
    const kw = query.keyword?.trim().toLowerCase() ?? ''
    let list = _auditRecords.slice()
    if (kw) {
      list = list.filter(
        (r) => r.goodsTitle.toLowerCase().includes(kw) || (r.reason ?? '').toLowerCase().includes(kw)
      )
    }
    const total = list.length
    list = list.slice((page - 1) * pageSize, page * pageSize)
    return { list, total, page, pageSize }
  }
  return request({ url: '/review/goods/records', method: 'GET', params: query })
}

/**
 * 审核记录导出（全量，带关键字过滤，不翻页）。
 * 审核记录是只增不改的复核凭据，导出必须拿「全部」而不是当前页 ——
 * 后端走专用导出端点（关闭分页计数），mock 模式直读内存记录。
 */
export async function fetchGoodsAuditRecordsForExport(
  query: { keyword?: string } = {}
): Promise<GoodsAuditRecord[]> {
  if (USE_MOCK) {
    await mockHelpers.delay(200)
    const kw = query.keyword?.trim().toLowerCase() ?? ''
    let list = _auditRecords.slice()
    if (kw) {
      list = list.filter(
        (r) => r.goodsTitle.toLowerCase().includes(kw) || (r.reason ?? '').toLowerCase().includes(kw)
      )
    }
    return list
  }
  return request({ url: '/review/goods/records/export', method: 'GET', params: query })
}

/** 审核工作台统计：待审 / 已通过 / 已驳回 / 今日已审 */
export interface GoodsAuditStats {
  pending: number
  approved: number
  rejected: number
  today: number
}

export async function fetchGoodsAuditStats(): Promise<GoodsAuditStats> {
  if (USE_MOCK) {
    await mockHelpers.delay(180)
    const today = new Date().toISOString().slice(0, 10)
    return {
      pending: collectPending().length,
      approved: _auditRecords.filter((r) => r.action === 'approve').length,
      rejected: _auditRecords.filter((r) => r.action === 'reject').length,
      today: _auditRecords.filter((r) => r.time.slice(0, 10) === today).length
    }
  }
  return request({ url: '/review/goods/stats' })
}
