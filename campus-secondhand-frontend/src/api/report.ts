/**
 * 举报 API（举报表：用户-商品 / 用户-用户 / 用户-订单 举报）
 * 用户提交举报 → 管理员在后台「举报处理」页签处理 / 驳回。
 */
import { request } from './request'
import { mockHelpers } from './mock'
import { resolveSessionUser } from './session'
import type { Report, ReportMeasure, PageResult, Goods } from '@/types'

const USE_MOCK = import.meta.env.VITE_USE_MOCK === 'true'

/** 提交举报 */
export async function submitReport(payload: {
  type: Report['type']
  targetId: number
  reason: string
  description: string
}): Promise<void> {
  if (USE_MOCK) {
    await new Promise((r) => setTimeout(r, 240))
    const list = mockHelpers.getReports()
    mockHelpers.setReports([
      {
        id: Math.max(0, ...list.map((x) => x.id)) + 1,
        type: payload.type,
        targetId: payload.targetId,
        reason: payload.reason,
        description: payload.description,
        status: 'pending',
        createTime: new Date().toISOString()
      },
      ...list
    ])
    return
  }
  return request({ url: '/reports', method: 'POST', data: payload })
}

/** 举报列表（管理端，按状态 / 类型筛选 + 分页） */
export async function fetchReports(query: {
  page?: number
  pageSize?: number
  status?: Report['status']
  /** 举报对象类型；不传表示全部 */
  type?: Report['type']
} = {}): Promise<PageResult<Report>> {
  if (USE_MOCK) {
    await new Promise((r) => setTimeout(r, 220))
    const page = query.page ?? 1
    const pageSize = query.pageSize ?? 10
    let list = mockHelpers.getReports().slice()
    if (query.status) list = list.filter((r) => r.status === query.status)
    if (query.type) list = list.filter((r) => r.type === query.type)
    // 待处理优先，再按时间倒序
    list.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'pending' ? -1 : 1
      return a.createTime < b.createTime ? 1 : -1
    })
    const total = list.length
    list = list.slice((page - 1) * pageSize, page * pageSize)
    return { list, total, page, pageSize }
  }
  return request({ url: '/admin/reports', method: 'GET', params: query })
}

/**
 * 处理记录导出（全量，带状态 / 类型过滤，不翻页）。
 * 与列表共用同一套筛选条件，导出的永远是「当前筛选的全部」；
 * 后端走专用导出端点（关闭分页计数），mock 模式直读举报缓存。
 */
export async function fetchReportsForExport(
  query: { status?: Report['status']; type?: Report['type'] } = {}
): Promise<Report[]> {
  if (USE_MOCK) {
    await new Promise((r) => setTimeout(r, 200))
    let list = mockHelpers.getReports().slice()
    if (query.status) list = list.filter((r) => r.status === query.status)
    if (query.type) list = list.filter((r) => r.type === query.type)
    return list.sort((a, b) => (a.createTime < b.createTime ? 1 : -1))
  }
  return request({ url: '/admin/reports/export', method: 'GET', params: query })
}

export const REPORT_TYPE_LABEL: Record<Report['type'], string> = {
  goods: '商品',
  user: '用户',
  order: '订单'
}

/* ====================================================================
 * 处理措施
 *
 * 「点完处理按钮就没有了」的根因是：处理动作只把状态从 pending 改成 handled，
 * 既没说明平台做了什么，也没真的动过被举报对象。下面的每一项措施都带着
 * **真实副作用**，并且会在操作日志里留下「做了什么 + 为什么」。
 * ==================================================================== */

export interface ReportMeasureMeta {
  value: ReportMeasure
  label: string
  /** 具体会做什么 —— 管理员选之前必须知道后果 */
  effect: string
  /** 适用对象类型：给商品类举报提供「封禁用户」这种选项毫无意义 */
  types: Report['type'][]
}

export const REPORT_MEASURES: ReportMeasureMeta[] = [
  {
    value: 'warn',
    label: '警示整改',
    effect: '向被举报方发出警示并扣减 5 点信用分，要求限期整改',
    types: ['goods', 'user', 'order']
  },
  {
    value: 'off_shelf',
    label: '下架商品',
    effect: '被举报商品立即下架，买家不再能浏览与购买',
    types: ['goods']
  },
  {
    value: 'remove',
    label: '删除商品',
    effect: '被举报商品从平台移除（举报成立且情节严重时使用）',
    types: ['goods']
  },
  {
    value: 'ban',
    label: '封禁用户',
    effect: '封禁被举报用户账号，其名下商品一并不可交易',
    types: ['user']
  },
  {
    value: 'none',
    label: '仅记录结论',
    effect: '不做任何处置，仅把举报标记为已处理（证据不足但需留痕）',
    types: ['goods', 'user', 'order']
  }
]

export const REPORT_MEASURE_LABEL: Record<ReportMeasure, string> = {
  none: '仅记录结论',
  warn: '警示整改',
  off_shelf: '下架商品',
  remove: '删除商品',
  ban: '封禁用户'
}

/** 某种举报对象可用的处理措施 */
export function measuresForType(type: Report['type']): ReportMeasureMeta[] {
  return REPORT_MEASURES.filter((m) => m.types.includes(type))
}

/**
 * 处理人：取**当前会话**的昵称（双后台之后，处理举报的可能是
 * 举报审核员 / 全能管理员，不能再硬编码「管理员」）。
 * 取不到会话（异常场景）兜底为「管理员」。
 */
function currentOperator(): string {
  return resolveSessionUser()?.nickname ?? '管理员'
}

/**
 * 施加处理措施的真实副作用，返回一句可读的处置说明（写进操作日志）。
 *
 * 商品类举报要同时照顾两件事：被举报商品的处置 + 卖家的责任 ——
 * 只下架商品而不警示卖家，同一个卖家换个商品又能继续违规。
 */
function applyMeasure(report: Report, measure: ReportMeasure): string {
  const goodsList = mockHelpers.getGoodsCache()
  const targetGoods = goodsList.find((g) => g.id === report.targetId)
  /** 责任方：商品类举报找卖家，用户类举报就是本人，订单类举报找卖家 */
  const userId = report.type === 'goods' ? targetGoods?.sellerId : report.targetId
  const penalizeUser = () => {
    const u = userId ? mockHelpers.getUsersCache().find((x) => x.id === userId) : undefined
    if (!u) return null
    u.creditScore = Math.max(0, u.creditScore - 5)
    return u
  }

  switch (measure) {
    case 'warn': {
      const u = penalizeUser()
      return u ? `已向「${u.nickname}」发出警示，信用分扣减至 ${u.creditScore}` : '已发出警示（未匹配到责任用户）'
    }
    case 'off_shelf': {
      if (!targetGoods) return '目标商品已不存在，未执行下架'
      mockHelpers.setGoodsCache(
        goodsList.map((g) => (g.id === report.targetId ? { ...g, status: 'off_shelf' as const } : g))
      )
      return `已下架商品《${targetGoods.title}》`
    }
    case 'remove': {
      if (!targetGoods) return '目标商品已不存在，未执行删除'
      mockHelpers.setGoodsCache(goodsList.filter((g) => g.id !== report.targetId))
      return `已删除商品《${targetGoods.title}》`
    }
    case 'ban': {
      const u = userId ? mockHelpers.getUsersCache().find((x) => x.id === userId) : undefined
      if (!u) return '目标用户已不存在，未执行封禁'
      u.status = 'banned'
      return `已封禁用户「${u.nickname}」`
    }
    default:
      return '未做处置（仅记录结论）'
  }
}

/**
 * 处理 / 驳回举报。
 *
 * - `action='handle'` 时必须给出 `measure`：不给出措施就不允许「处理」，
 *   否则「已处理」会变成一个没有任何内容的结论（这正是被反馈的问题）。
 * - `action='reject'` 表示举报不成立，等价于 `measure='none'`。
 */
export async function resolveReport(payload: {
  id: number
  action: 'handle' | 'reject'
  measure?: ReportMeasure
  remark?: string
}): Promise<void> {
  if (USE_MOCK) {
    await new Promise((r) => setTimeout(r, 200))
    const measure: ReportMeasure = payload.action === 'reject' ? 'none' : payload.measure ?? 'warn'
    const list = mockHelpers.getReports()
    const r = list.find((x) => x.id === payload.id)
    if (!r) throw new Error('举报记录不存在')
    if (r.status !== 'pending') throw new Error('该举报已处理过，不能重复处置')

    // 先动被举报对象，再落状态：措施执行失败时举报应保持待处理
    const effect = payload.action === 'reject' ? '举报不成立，未做处置' : applyMeasure(r, measure)

    r.status = payload.action === 'handle' ? 'handled' : 'rejected'
    r.measure = measure
    r.remark = payload.remark?.trim() || undefined
    r.outcome = effect
    r.handleTime = new Date().toISOString()
    r.handledBy = currentOperator()
    mockHelpers.setReports(list)

    mockHelpers.addAuditLog({
      action: payload.action === 'handle' ? 'report.handle' : 'report.reject',
      actionLabel: payload.action === 'handle' ? '处理举报' : '驳回举报',
      target: `举报 #${r.id}（${REPORT_TYPE_LABEL[r.type]} #${r.targetId}）`,
      detail: `${REPORT_MEASURE_LABEL[measure]}：${effect}${r.remark ? `；备注：${r.remark}` : ''}`
    })
    return
  }
  return request({
    url: `/admin/reports/${payload.id}/resolve`,
    method: 'POST',
    data: { action: payload.action, measure: payload.measure, remark: payload.remark }
  })
}

/**
 * 批量处理 / 驳回举报。
 * 只作用于仍处于 pending 的记录：对已处理过的举报再点一次不应改变结果，
 * 所以返回的是「实际被改动」的条数，而不是传入的 ids 数量。
 */
export async function batchResolveReports(
  ids: number[],
  action: 'handle' | 'reject',
  options: { measure?: ReportMeasure; remark?: string } = {}
): Promise<number> {
  if (USE_MOCK) {
    await new Promise((r) => setTimeout(r, 320))
    if (!ids.length) return 0
    const set = new Set(ids)
    const list = mockHelpers.getReports()
    const affected = list.filter((r) => set.has(r.id) && r.status === 'pending')
    const remark = options.remark?.trim() || undefined
    /** 逐条记录各自的处置说明：批量时被举报对象不同，结论也不会一样 */
    const outcomes: string[] = []

    affected.forEach((r) => {
      const measure: ReportMeasure = action === 'reject' ? 'none' : options.measure ?? 'warn'
      const effect = action === 'handle' ? applyMeasure(r, measure) : '举报不成立，未做处置'
      outcomes.push(effect)
      r.status = action === 'handle' ? 'handled' : 'rejected'
      r.measure = measure
      r.remark = remark
      r.outcome = effect
      r.handleTime = new Date().toISOString()
      r.handledBy = currentOperator()
    })
    mockHelpers.setReports(list)

    if (affected.length) {
      const measureLabel = REPORT_MEASURE_LABEL[action === 'reject' ? 'none' : options.measure ?? 'warn']
      // 日志里带上每条的具体结论（去重，避免 10 条同样的话刷屏）
      const detail = [...new Set(outcomes)].join('；')
      mockHelpers.addAuditLog({
        action: action === 'handle' ? 'report.batchHandle' : 'report.batchReject',
        actionLabel: action === 'handle' ? '批量处理举报' : '批量驳回举报',
        target: `${affected.length} 条举报`,
        detail: `${measureLabel}：${detail}；ID：${affected.map((r) => r.id).join('、')}${
          remark ? `；备注：${remark}` : ''
        }`
      })
    }
    return affected.length
  }
  return request({
    url: '/admin/reports/batch-resolve',
    method: 'POST',
    data: { ids, action, measure: options.measure, remark: options.remark }
  })
}

/** 举报待办统计（后台页签角标 + 看板待办） */
export async function fetchReportStats(): Promise<{ pending: number; handled: number; rejected: number }> {
  if (USE_MOCK) {
    const list = mockHelpers.getReports()
    return {
      pending: list.filter((r) => r.status === 'pending').length,
      handled: list.filter((r) => r.status === 'handled').length,
      rejected: list.filter((r) => r.status === 'rejected').length
    }
  }
  return request({ url: '/admin/reports/stats' })
}

/* ====================================================================
 * 核实详情：被举报对象现状快照
 *
 * 举报处理后台的「核实」不能只看举报文案 —— 必须能当场看到
 * 被举报对象**现在**是什么状态（商品还在不在架 / 用户信用分多少），
 * 处置决定才有依据。快照在打开抽屉时取一次，处置后重取。
 * ==================================================================== */

export interface ReportTargetBrief {
  /** 对象是否还存在（商品可能已被删除） */
  exists: boolean
  /** 展示标题：商品标题 / 用户昵称 / 订单号 */
  title: string
  /** 当前状态标签（在售 / 已下架 / 正常 / 已封禁 …） */
  statusLabel: string
  statusType: 'success' | 'warning' | 'danger' | 'info'
  /** 对象为用户时给出信用分 */
  creditScore?: number
  /** 对象为用户时给出头像 */
  avatar?: string
  /** 对象为商品时给出卖家昵称（订单类给买卖双方） */
  sellerName?: string
  buyerName?: string
  /** 对象为商品时给出版图 */
  cover?: string
  price?: number

  /* ---------- 商品类举报的核实需要完整商品档案，光看一行小卡判不了「虚假描述」 ---------- */
  /** 挂牌价（划线价的唯一来源） */
  listPrice?: number
  /** 活动让利价（未参加活动为 undefined；举报常围绕「价格与描述不符」） */
  promoPrice?: number
  description?: string
  categoryName?: string
  /** 交易地点 / 可售数量 / 交易方式 */
  location?: string
  stock?: number
  deliveryMethod?: Goods['deliveryMethod']
  /** 图片集（判定「图片有使用痕迹」的直接证据） */
  images?: string[]
  /** 发布时间 / 浏览与收藏热度（判断举报时机是否可疑） */
  createTime?: string
  viewCount?: number
  favoriteCount?: number
}

const GOODS_STATUS_TEXT: Record<string, { label: string; type: ReportTargetBrief['statusType'] }> = {
  on_sale: { label: '在售中', type: 'success' },
  off_shelf: { label: '已下架', type: 'info' },
  sold: { label: '已售出', type: 'info' },
  pending: { label: '审核中', type: 'warning' }
}

export async function fetchReportTargetBrief(type: Report['type'], targetId: number): Promise<ReportTargetBrief> {
  if (USE_MOCK) {
    if (type === 'goods') {
      const g = mockHelpers
        .getGoodsCache()
        .find((x) => x.id === targetId) ?? mockHelpers.getMyGoodsCache().find((x) => x.id === targetId)
      if (!g) {
        return { exists: false, title: `商品 #${targetId}（已删除）`, statusLabel: '不存在', statusType: 'danger' }
      }
      const st = GOODS_STATUS_TEXT[g.status] ?? { label: g.status, type: 'info' as const }
      return {
        exists: true,
        title: g.title,
        statusLabel: st.label,
        statusType: st.type,
        sellerName: g.sellerName,
        cover: g.cover,
        price: g.promoPrice ?? g.price,
        // 完整商品档案：核实「虚假描述 / 违规商品」要能看到全部证据
        listPrice: g.price,
        promoPrice: g.promoPrice,
        description: g.description,
        categoryName: g.categoryName,
        location: g.location,
        stock: g.stock,
        deliveryMethod: g.deliveryMethod,
        images: [g.cover, ...g.images].filter(Boolean),
        createTime: g.createTime,
        viewCount: g.viewCount,
        favoriteCount: g.favoriteCount
      }
    }
    if (type === 'user') {
      const u = mockHelpers.getUsersCache().find((x) => x.id === targetId)
      if (!u) {
        return { exists: false, title: `用户 #${targetId}（已注销）`, statusLabel: '不存在', statusType: 'danger' }
      }
      return {
        exists: true,
        title: u.nickname,
        avatar: u.avatar,
        statusLabel: u.status === 'banned' ? '已封禁' : '正常',
        statusType: u.status === 'banned' ? 'danger' : 'success',
        creditScore: u.creditScore
      }
    }
    // order
    const o = mockHelpers.getOrderCache().find((x) => x.id === String(targetId)) ??
      mockHelpers.getOrderCache().find((x) => x.id === `ORD${String(targetId).padStart(5, '0')}`)
    if (!o) {
      return { exists: false, title: `订单 #${targetId}`, statusLabel: '未找到该订单', statusType: 'danger' }
    }
    const orderStatus: Record<string, { label: string; type: ReportTargetBrief['statusType'] }> = {
      pending_payment: { label: '待付款', type: 'warning' },
      pending_ship: { label: '待发货', type: 'warning' },
      shipped: { label: '已发货', type: 'info' },
      received: { label: '已收货', type: 'info' },
      completed: { label: '已完成', type: 'success' },
      refunding: { label: '退款中', type: 'warning' },
      cancelled: { label: '已取消', type: 'info' }
    }
    const st = orderStatus[o.status] ?? { label: o.status, type: 'info' as const }
    return {
      exists: true,
      title: o.id,
      statusLabel: st.label,
      statusType: st.type,
      sellerName: o.sellerName,
      buyerName: o.buyerName,
      price: o.amount
    }
  }
  return request({ url: `/admin/reports/target/${type}/${targetId}` })
}
