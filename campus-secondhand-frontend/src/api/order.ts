/**
 * 订单 API
 * 买家侧：我的订单 / 支付 / 收货；卖家侧：发货；管理侧：全量检索 / 改状态 / 退款 / 批量处置。
 */
import { request } from './request'
import { mockHelpers, mockUsersExport } from './mock'
import { resolveSessionUser } from './session'
import { resolveFundSourceForGoods } from './activity'
import { settlePrice, scaleBreakdown } from '@/utils/promo'
import { resolveStock } from '@/utils/goods'
import type { Order, OrderLog, PageResult, FundSource } from '@/types'
import type { PayLaunch } from './pay'

const USE_MOCK = import.meta.env.VITE_USE_MOCK === 'true'

/** 订单状态 → 中文（前台、后台、导出共用同一套口径） */
export const ORDER_STATUS_LABEL: Record<Order['status'], string> = {
  pending_payment: '待付款',
  pending_ship: '待发货',
  shipped: '已发货',
  received: '已收货',
  completed: '已完成',
  refunding: '退款中',
  cancelled: '已取消'
}

/** 计入成交额的状态（与 analytics 的 GMV 口径保持一致） */
export const ORDER_PAID_STATUS: Order['status'][] = ['pending_ship', 'shipped', 'received', 'completed']

/**
 * 列表行内的状态标记配色。前台订单中心与后台列表共用，
 * 避免同一状态在两处显示成不同颜色（用户会以为是两回事）。
 */
export const ORDER_STATUS_TAG: Record<Order['status'], 'success' | 'warning' | 'info' | 'danger' | 'primary'> = {
  pending_payment: 'warning',
  pending_ship: 'primary',
  shipped: 'primary',
  received: 'success',
  completed: 'success',
  refunding: 'warning',
  cancelled: 'info'
}

/* ====================================================================
 * 状态机
 * ==================================================================== */

/**
 * 订单状态机：每个状态**只允许流向哪些后续状态**。
 *
 * 主流电商的订单是一条单行道 —— 付款、发货、收货、完成只能顺着走，
 * 已完成的订单不能再退款、已取消的订单不能复活。
 *
 * `→ refunding` 是**已付款之后**才存在的合法岔路：买家收到货不对版、
 * 或货还没发出就想退，都可以进入售后。
 * 之前这张表里根本没有指向 `refunding` 的边 —— 结果是种子数据里
 * 「买家申请退款」这条日志与状态机对不上（测试直接抓到），
 * 真接后端时客服也点不出「把这单转售后」。
 */
export const ORDER_TRANSITIONS: Record<Order['status'], Order['status'][]> = {
  pending_payment: ['pending_ship', 'cancelled'],
  pending_ship: ['shipped', 'cancelled', 'refunding'],
  shipped: ['received', 'cancelled', 'refunding'],
  received: ['completed', 'refunding'],
  completed: [],
  refunding: ['cancelled'],
  cancelled: []
}

/**
 * 退款（置为已取消）允许的起始状态。
 *
 * `refunding` 必须在内 —— 买家已经提交退款申请的单子，
 * 管理员点「同意退款」就是把它推到 cancelled；
 * 之前这张表没有 refunding，售后申请批不了，等于开了入口没有出口。
 *
 * 「已完成」依然不在内：交易完成后的售后走独立流程，不在订单列表里退。
 */
export const REFUNDABLE_STATUS: Order['status'][] = ['pending_ship', 'shipped', 'received', 'refunding']

/**
 * 买家可「申请退款」的起始状态：付款之后、终态之前。
 *
 * 与 {@link REFUNDABLE_STATUS} 的差别就在 `refunding` 一项，两边不能互相替代：
 *   · 这里是**发起**售后（买家点「申请退款」），`refunding` 已经是申请过了，
 *     重复提交要单独报「正在等待平台处理」，而不是含糊地说「不支持」；
 *   · 那边是**处理**售后（管理员点「同意退款」），`refunding` 恰恰是最主要的入口。
 *
 * `pending_payment` 不在内：没付款就没有钱可退，直接走「取消订单」即可；
 * `completed` / `cancelled` 是终态，退不了。
 */
export const APPLY_REFUNDABLE_STATUS: Order['status'][] = ['pending_ship', 'shipped', 'received']

/* ====================================================================
 * 售后：退款原因枚举
 * ==================================================================== */

/**
 * 退款原因（买家申请与管理端判定共用同一份枚举）。
 *
 * 为什么不让管理员自由填：自由文本会让「商品与描述不符」今天写成
 * 「东西不对版」、明天写成「货不对」，售后统计按原因分组时永远对不上。
 * 选单后可以再补一句备注，兼顾准确与灵活。
 */
export const REFUND_REASONS = [
  '商品与描述不符',
  '商品存在质量问题',
  '卖家未按约定时间发货',
  '买家申请七天无理由退货',
  '双方协商一致退款',
  '重复下单',
  '其他'
] as const
export type RefundReason = (typeof REFUND_REASONS)[number]

/* ====================================================================
 * SLA / 异常判定
 * ==================================================================== */

/**
 * 各阶段的服务时限（小时）。超过即视为「需人工介入」。
 *
 * 这些阈值是后台「异常订单」筛选与超时标记的唯一依据 ——
 * 写死在一处，前端不要再各自算一遍，否则列表标红了、导出却没标，对不上账。
 */
export const ORDER_SLA_HOURS: Partial<Record<Order['status'], { hours: number; text: string }>> = {
  pending_payment: { hours: 24, text: '超时未付款' },
  pending_ship: { hours: 48, text: '超时未发货' },
  shipped: { hours: 168, text: '在途超 7 天' },
  refunding: { hours: 48, text: '售后超时未处理' }
}

export interface OrderIssue {
  /** danger = 已经该动手了；warn = 快到了 */
  level: 'warn' | 'danger'
  /** 完整文案，如「超时未发货 3 天」 */
  text: string
  /**
   * 短文案，如「超时未发货」——给列表里那一列窄列用。
   * 带时长那句话（10 个字）塞进 130px 的状态列会被挤成两行，
   * 列表里只留结论、把时长放到 tooltip 里。
   */
  shortText: string
  /** 已等待小时数 */
  hours: number
}

/**
 * 判断一条订单是否已经踩到服务时限。
 *
 * 起算点按状态取「用户真正在等的那一刻」：
 * 待付款从下单算、待发货从付款算、在途从发货算、售后从申请退款算。
 * 用 createTime 一刀切会把「刚付款 1 小时但 3 天前就下单」的单误判成超时。
 */
export function orderIssueOf(o: Order, now = Date.now()): OrderIssue | null {
  const rule = ORDER_SLA_HOURS[o.status]
  if (!rule) return null
  const startMap: Partial<Record<Order['status'], string | undefined>> = {
    pending_payment: o.createTime,
    pending_ship: o.payTime ?? o.createTime,
    shipped: o.shipTime ?? o.createTime,
    refunding: o.refund?.time ?? o.createTime
  }
  const from = startMap[o.status]
  if (!from) return null
  const hours = (now - Date.parse(from)) / 3600_000
  if (hours < rule.hours) return null
  const overdue = hours - rule.hours
  return {
    level: overdue >= rule.hours ? 'danger' : 'warn',
    text: overdue >= 24 ? `${rule.text} ${Math.floor(overdue / 24)} 天` : `${rule.text} ${Math.floor(overdue)} 小时`,
    shortText: rule.text,
    hours
  }
}

/** 需要管理员动手的状态（概览卡「待处理」与「只看待办」筛选共用） */
export const ORDER_TODO_STATUS: Order['status'][] = ['pending_payment', 'pending_ship', 'refunding']

/** 概览卡的分组：把 7 个状态收成 5 张卡（否则卡片太多反而看不清） */
export const ORDER_OVERVIEW_GROUPS: Array<{
  key: string
  label: string
  statuses: Order['status'][]
  tone: 'warn' | 'primary' | 'success' | 'danger' | 'info'
}> = [
  { key: 'todo_pay', label: '待付款', statuses: ['pending_payment'], tone: 'warn' },
  { key: 'todo_ship', label: '待发货', statuses: ['pending_ship'], tone: 'primary' },
  { key: 'shipping', label: '已发货', statuses: ['shipped'], tone: 'primary' },
  { key: 'received', label: '已收货', statuses: ['received'], tone: 'success' },
  { key: 'done', label: '已完成', statuses: ['completed'], tone: 'success' },
  { key: 'after', label: '售后中', statuses: ['refunding', 'cancelled'], tone: 'danger' }
]

/* ====================================================================
 * 管理端列表检索
 * ==================================================================== */

/**
 * 管理端订单检索条件。
 *
 * 抽成独立接口是为了让**列表、概览统计、CSV 导出三者用同一套筛选**：
 * 之前导出直接拿列表当前页的数据，筛选条件一变就导出错内容
 * （用户筛了「只看售后」，导出却是全部）。现在统一走 `filterAdminOrders`。
 */
export interface AdminOrderQuery {
  page?: number
  pageSize?: number
  status?: Order['status']
  /**
   * 多状态筛选（状态总览卡的「售后中」= 退款中 + 已取消）。
   *
   * 单靠 `status` 表达不了分组：卡片上写着 3 单，点进去只筛出 2 单，
   * 用户会以为卡片数字是错的。所以分组筛选走白名单，与 `status` 并行存在，
   * 但**调用方保证两者互斥**（下拉选了单状态就清空白名单，反之亦然）。
   */
  statusIn?: Order['status'][]
  keyword?: string
  /** 下单时间起（含当天，YYYY-MM-DD） */
  dateFrom?: string
  /** 下单时间止（含当天，YYYY-MM-DD） */
  dateTo?: string
  minAmount?: number
  maxAmount?: number
  fundSource?: FundSource
  /** 只看需要人工介入的（待付款 / 待发货 / 售后中） */
  onlyTodo?: boolean
  /** 只看踩到服务时限的 */
  onlyIssue?: boolean
  /** 只看买家留了备注的 */
  onlyRemark?: boolean
  /** 只看后台已写内部备注的 */
  onlyNoted?: boolean
  sort?: 'time_desc' | 'time_asc' | 'amount_desc' | 'amount_asc'
}

/** 纯函数筛选：列表 / 统计 / 导出三处共用，保证口径绝对一致 */
export function filterAdminOrders(list: Order[], q: AdminOrderQuery, now = Date.now()): Order[] {
  const kw = q.keyword?.trim().toLowerCase() ?? ''
  let out = list.slice()
  if (q.status) out = out.filter((o) => o.status === q.status)
  if (q.statusIn?.length) {
    const allow = new Set(q.statusIn)
    out = out.filter((o) => allow.has(o.status))
  }
  if (q.onlyTodo) out = out.filter((o) => ORDER_TODO_STATUS.includes(o.status))
  if (q.onlyIssue) out = out.filter((o) => !!orderIssueOf(o, now))
  if (q.onlyRemark) out = out.filter((o) => !!o.remark)
  if (q.onlyNoted) out = out.filter((o) => !!o.adminNote)
  if (q.fundSource) out = out.filter((o) => o.fundSource === q.fundSource)
  if (q.minAmount != null) out = out.filter((o) => o.amount >= q.minAmount!)
  if (q.maxAmount != null) out = out.filter((o) => o.amount <= q.maxAmount!)
  /*
   * 日期用「本地日」的起止时刻比较，而不是拿字符串前缀去比。
   * ISO 串是 UTC，`2026-09-11` 开头的字符串在 UTC+8 下覆盖的是
   * 本地 9-11 08:00 到 9-12 08:00 —— 直接前缀匹配会漏掉/多算半天。
   */
  if (q.dateFrom) {
    const t = new Date(`${q.dateFrom}T00:00:00`).getTime()
    if (!Number.isNaN(t)) out = out.filter((o) => Date.parse(o.createTime) >= t)
  }
  if (q.dateTo) {
    const t = new Date(`${q.dateTo}T23:59:59.999`).getTime()
    if (!Number.isNaN(t)) out = out.filter((o) => Date.parse(o.createTime) <= t)
  }
  if (kw) {
    out = out.filter(
      (o) =>
        o.id.toLowerCase().includes(kw) ||
        o.goods.title.toLowerCase().includes(kw) ||
        (o.buyerName ?? '').toLowerCase().includes(kw) ||
        (o.sellerName ?? '').toLowerCase().includes(kw) ||
        (o.trackingNo ?? '').toLowerCase().includes(kw)
    )
  }
  const dir = q.sort ?? 'time_desc'
  out.sort((a, b) => {
    if (dir === 'amount_desc') return b.amount - a.amount
    if (dir === 'amount_asc') return a.amount - b.amount
    if (dir === 'time_asc') return a.createTime < b.createTime ? -1 : 1
    return a.createTime < b.createTime ? 1 : -1
  })
  return out
}

/** 买/卖家我的订单 */
export async function fetchOrders(query: {
  page?: number
  pageSize?: number
  status?: Order['status']
  role?: 'buyer' | 'seller'
}): Promise<PageResult<Order>> {
  if (USE_MOCK) {
    await mockHelpers.delay(360)
    const page = query.page ?? 1
    const pageSize = query.pageSize ?? 10
    let list = mockHelpers.getOrderCache()
    if (query.status) list = list.filter((o) => o.status === query.status)
    const total = list.length
    list = list.slice((page - 1) * pageSize, page * pageSize)
    return { list, total, page, pageSize }
  }
  return request({ url: '/orders', method: 'GET', params: query })
}

/**
 * 管理端订单检索：支持关键词 + 状态 + 时间 / 金额区间 + 资金来源 + 各类「只看」开关。
 * 与前台 fetchOrders 的区别是「谁都能搜」——后台不做角色过滤。
 */
export async function fetchAdminOrders(query: AdminOrderQuery): Promise<PageResult<Order>> {
  if (USE_MOCK) {
    await mockHelpers.delay(340)
    const page = query.page ?? 1
    const pageSize = query.pageSize ?? 10
    const list = filterAdminOrders(mockHelpers.getOrderCache(), query)
    return { list: list.slice((page - 1) * pageSize, page * pageSize), total: list.length, page, pageSize }
  }
  return request({ url: '/admin/orders', method: 'GET', params: query })
}

/** 导出用：同样走 filterAdminOrders，但不分页（导出的是「当前筛选的全部」） */
export async function fetchAdminOrdersForExport(query: AdminOrderQuery): Promise<Order[]> {
  if (USE_MOCK) {
    await mockHelpers.delay(260)
    return filterAdminOrders(mockHelpers.getOrderCache(), { ...query, page: 1, pageSize: Number.MAX_SAFE_INTEGER })
  }
  return request({ url: '/admin/orders/export', method: 'GET', params: query })
}

/* ====================================================================
 * 管理端概览统计（订单工作台顶部的卡片）
 * ==================================================================== */

export interface AdminOrderStats {
  total: number
  /** 需人工介入的单数（待付款 + 待发货 + 售后中） */
  todo: number
  /** 踩到服务时限的单数 */
  issues: number
  /** 今日新增单数 */
  todayCount: number
  /** 累计成交额（只算已完成/已收货等已成交状态） */
  gmv: number
  /** 待处理金额（已付款但还没走完的） */
  pendingGmv: number
  /** 已退款金额 */
  refundedAmount: number
  /** 各状态单数 */
  byStatus: Record<Order['status'], number>
  /** 概览卡分组单数 + 金额 */
  groups: Array<{ key: string; label: string; tone: string; count: number; amount: number; statuses: Order['status'][] }>
}

/**
 * 订单工作台统计。
 *
 * 注意 `gmv` 只累计已成交状态（`ORDER_PAID_STATUS`），与运营看板的 GMV 同口径；
 * 「待处理金额」单独给一个数，两者混在一起会让管理员误以为今天的流水已经到账。
 */
export async function fetchAdminOrderStats(now = Date.now()): Promise<AdminOrderStats> {
  if (USE_MOCK) {
    await mockHelpers.delay(240)
    const list = mockHelpers.getOrderCache()
    const byStatus = Object.keys(ORDER_STATUS_LABEL).reduce(
      (acc, k) => ({ ...acc, [k]: 0 }),
      {} as Record<Order['status'], number>
    )
    let gmv = 0
    let pendingGmv = 0
    let refundedAmount = 0
    let todayCount = 0
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)

    for (const o of list) {
      byStatus[o.status] += 1
      if (ORDER_PAID_STATUS.includes(o.status)) gmv += o.amount
      if (o.status === 'pending_ship' || o.status === 'shipped' || o.status === 'received') pendingGmv += o.amount
      if (o.refundTime) refundedAmount += o.refund?.amount ?? o.amount
      if (Date.parse(o.createTime) >= todayStart.getTime()) todayCount += 1
    }
    return {
      total: list.length,
      todo: list.filter((o) => ORDER_TODO_STATUS.includes(o.status)).length,
      issues: list.filter((o) => !!orderIssueOf(o, now)).length,
      todayCount,
      gmv,
      pendingGmv,
      refundedAmount,
      byStatus,
      groups: ORDER_OVERVIEW_GROUPS.map((g) => {
        const hit = list.filter((o) => g.statuses.includes(o.status))
        return {
          key: g.key,
          label: g.label,
          tone: g.tone,
          // 分组白名单跟着下发：视图层点卡片时要拿它去筛，
          // 若只给 key，视图就得再查一次常量表 —— 查不到就是运行时崩溃
          statuses: [...g.statuses],
          count: hit.length,
          // 「售后中」这张卡里的「已取消」也是退款单，金额同样要算进来
          amount: hit.reduce((s, o) => s + (o.status === 'pending_payment' ? 0 : o.amount), 0)
        }
      })
    }
  }
  return request({ url: '/admin/orders/stats', method: 'GET' })
}

/* ====================================================================
 * 账本：操作日志
 * ==================================================================== */

/**
 * 记账助手：把「谁在什么时候把这单推到了哪一步」写进 `order.logs`。
 *
 * 三件事必须一起做，只做状态不做日志等于白改：
 *   ① 改 `status`；
 *   ② 补齐该状态对应的时间戳（payTime / shipTime / receiveTime / completeTime）；
 *   ③ 追加一条日志（操作人 + 身份 + from→to + 说明）。
 *
 * 角色（买家 / 卖家 / 管理员 / 系统）由**调用入口**决定，
 * 昵称尽量取当前会话 —— 不然日志里所有操作人都是「管理员」，
 * 出了纠纷根本不知道是哪个账号批的。
 */
function logActor(role: OrderLog['operatorRole'], fallbackName: string): Pick<OrderLog, 'operator' | 'operatorRole'> {
  const u = resolveSessionUser()
  return { operator: u?.nickname ?? fallbackName, operatorRole: role }
}

/** 给一条订单追加日志（同时做一次「历史补齐」，保证轨迹与承运商跟得上状态） */
function recordOrderLog(o: Order, entry: Omit<OrderLog, 'id'>): void {
  mockHelpers.pushOrderLog(o, entry)
  mockHelpers.refreshOrderHistory(o)
}

/* ====================================================================
 * 买家侧：付款 / 发货 / 收货 / 取消
 * ==================================================================== */

/**
 * 发起一次支付。
 *
 * ★★ 返回值从 `void` 变成了 `PayLaunch` ★★
 *
 * 以前这个函数是「点确认 → 订单已付款」，现在它只回答「下一步该干什么」：
 *   · `DONE`     —— 钱包 / 演示渠道当场扣完，订单已推进，直接刷新；
 *   · `REDIRECT` —— 跳 `url` 去支付宝，付完由**后端回调**推进订单（前端不知道结果）；
 *   · `QR`       —— 渲染二维码并开始轮询。
 *
 * ★ 前端**绝不能**把「接口没报错」当成「支付成功」★
 * 只有 `kind === 'DONE'`，或者轮询到 `paid === true` 时，才算真的付了钱。
 * 这正是改造前最大的问题：一次 HTTP 200 就被当成钱到账了。
 *
 * @param channel 支付方式编码（来自 `fetchPayChannels()`）；不传时后端选第一条可用的
 */
export async function payOrder(id: string, channel?: string): Promise<PayLaunch> {
  if (USE_MOCK) {
    await mockHelpers.delay(500)
    const orders = mockHelpers.getOrderCache()
    const o = orders.find((x) => x.id === id)
    if (o) {
      const now = new Date().toISOString()
      o.status = 'pending_ship'
      o.payTime = now
      recordOrderLog(o, {
        time: now,
        action: 'pay',
        actionLabel: '买家付款',
        from: 'pending_payment',
        to: 'pending_ship',
        ...logActor('buyer', o.buyerName ?? '买家')
      })
    }
    mockHelpers.setOrderCache(orders)
    // 本地演示只有「当场付完」这一种形态，与钱包渠道的返回保持一致
    return {
      paymentId: `pay_mock_${id}`,
      orderId: id,
      channel: channel ?? 'wallet',
      channelLabel: channel === 'demo' ? '演示渠道' : '校园钱包',
      amount: o?.amount ?? 0,
      kind: 'DONE',
      message: '支付成功',
      status: 'success'
    }
  }
  return request({
    url: `/orders/${id}/pay`,
    method: 'POST',
    data: channel ? { channel } : {}
  })
}

/**
 * 买家取消订单（仅待付款可取消）。
 *
 * 取消即交易作废：后端会把下单时扣掉的库存回补，
 * 售罄自动置「已售出」的商品也会翻回「在售」。付款之后不再提供取消 ——
 * 要退走「申请退款」（refunding），两条线不能混。
 */
export async function cancelOrder(id: string, reason?: string): Promise<void> {
  if (USE_MOCK) {
    await mockHelpers.delay(400)
    const orders = mockHelpers.getOrderCache()
    const o = orders.find((x) => x.id === id)
    if (o && o.status === 'pending_payment') {
      const now = new Date().toISOString()
      o.status = 'cancelled'
      // cancelReason 是 { time, text } 结构（与后端 cancel_reason_text/_time 两列对应）
      o.cancelReason = { time: now, text: reason || '买家主动取消' }
      recordOrderLog(o, {
        time: now,
        action: 'cancel',
        actionLabel: '买家取消订单',
        from: 'pending_payment',
        to: 'cancelled',
        note: o.cancelReason.text,
        ...logActor('buyer', o.buyerName ?? '买家')
      })
      // 与真实后端同口径：库存回补，售罄的商品翻回在售
      const goodsList = mockHelpers.getGoodsCache()
      const qty = Math.max(1, o.quantity ?? 1)
      mockHelpers.setGoodsCache(
        goodsList.map((g) => {
          if (g.id !== o.goods.id) return g
          const rest = resolveStock(g) + qty
          return { ...g, stock: rest, status: g.status === 'sold' && rest > 0 ? 'on_sale' : g.status }
        })
      )
    }
    mockHelpers.setOrderCache(orders)
    return
  }
  return request({ url: `/orders/${id}/cancel`, method: 'POST', data: { reason } })
}

export interface RefundApplyPayload {
  /** 申请原因（必填，选单，见 REFUND_REASONS） */
  reason: string
}

/**
 * 买家申请退款：订单进入 `refunding`，等平台（管理员）审核。
 *
 * 与 `cancelOrder` 是两条不能混的线：取消只对「待付款」开放（还没给钱，直接作废），
 * 付了款之后要拿回钱只能走这条售后线。状态机里
 * `pending_ship / shipped / received → refunding` 三条边一直都在，
 * 管理端的「同意退款 / 驳回退款」也早就实现了 —— 之前缺的就是买家这一侧的入口，
 * 于是买家付完款发现货不对版时，既取消不了也申请不了，只能线下找管理员。
 *
 * `received`（已收货）也在可申请之列：收货后才发现质量问题是最常见的售后场景，
 * 而「确认收货」在本项目里会连做「收货 + 完成」两步，一旦走到 completed 就是终态、再也退不掉。
 */
export async function applyRefund(id: string, payload: RefundApplyPayload): Promise<void> {
  if (USE_MOCK) {
    await mockHelpers.delay(420)
    const reason = (payload.reason ?? '').trim()
    if (!reason) throw new Error('退款原因不能为空')
    const orders = mockHelpers.getOrderCache()
    const o = orders.find((x) => x.id === id)
    if (!o) throw new Error('订单不存在')
    if (o.status === 'refunding') throw new Error('退款申请已提交，正在等待平台处理，请勿重复申请')
    if (!APPLY_REFUNDABLE_STATUS.includes(o.status)) {
      throw new Error(`订单当前「${ORDER_STATUS_LABEL[o.status]}」，不能申请退款`)
    }

    const before = o.status
    const now = new Date().toISOString()
    /*
     * 只写「申请」能确定的三项：全额（审批时可改小）、原因、发起方。
     * `refundTime`（退款**完成**时间）留空 —— 它被用来统计「已退款金额」，
     * 申请阶段就填上会把审核中的售后算成已退的钱；申请时间放在 refund.time 里。
     */
    o.refund = { amount: o.amount, reason, by: 'buyer', time: now }
    o.status = 'refunding'
    recordOrderLog(o, {
      time: now,
      action: 'refund',
      actionLabel: '买家申请退款',
      from: before,
      to: 'refunding',
      note: reason,
      ...logActor('buyer', o.buyerName ?? '买家')
    })
    mockHelpers.setOrderCache(orders)
    return
  }
  return request({ url: `/orders/${id}/refund/apply`, method: 'POST', data: { reason: payload.reason } })
}

/** 卖家发货（买家侧入口：我的订单里卖家视角操作） */
export async function shipOrder(id: string, trackingNo: string, company?: string): Promise<void> {
  if (USE_MOCK) {
    await mockHelpers.delay(400)
    const orders = mockHelpers.getOrderCache()
    const o = orders.find((x) => x.id === id)
    if (o) {
      const now = new Date().toISOString()
      o.status = 'shipped'
      o.trackingNo = trackingNo
      if (company) o.logisticsCompany = company
      o.shipTime = now
      // 刚发货时先落一条揽收轨迹，否则详情页「物流轨迹」是空的，像功能没做
      o.traces = [
        { time: now, text: `卖家已发货，${company ? `${company} ` : ''}快件已被【北京学院路营业点】揽收` }
      ]
      recordOrderLog(o, {
        time: now,
        action: 'ship',
        actionLabel: '卖家发货',
        from: 'pending_ship',
        to: 'shipped',
        note: `${company ? `${company} ` : ''}${trackingNo}`,
        ...logActor('seller', o.sellerName ?? '卖家')
      })
    }
    mockHelpers.setOrderCache(orders)
    return
  }
  return request({ url: `/orders/${id}/ship`, method: 'POST', data: { trackingNo, company } })
}

/**
 * 买家确认收货 → 直接进入已完成。
 *
 * 这里把「收货」与「完成」**同一次调用里连做两步**（与主流电商一致：
 * 买家点确认收货后系统即刻结算），但时间戳与日志仍是两条，
 * 保证日志里的 `from → to` 永远是状态机里存在的边，
 * 也让「收货时间 ≠ 完成时间」这件事在数据里看得出来。
 */
export async function confirmReceive(id: string): Promise<void> {
  if (USE_MOCK) {
    await mockHelpers.delay(450)
    const orders = mockHelpers.getOrderCache()
    const o = orders.find((x) => x.id === id)
    if (o) {
      const receiveAt = new Date()
      o.status = 'completed'
      o.receiveTime = receiveAt.toISOString()
      o.completeTime = new Date(receiveAt.getTime() + 1000).toISOString()
      recordOrderLog(o, {
        time: o.receiveTime,
        action: 'receive',
        actionLabel: '买家确认收货',
        from: 'shipped',
        to: 'received',
        ...logActor('buyer', o.buyerName ?? '买家')
      })
      recordOrderLog(o, {
        time: o.completeTime,
        action: 'complete',
        actionLabel: '交易完成',
        from: 'received',
        to: 'completed',
        note: '确认收货后系统自动完成结算',
        ...logActor('system', '系统')
      })
    }
    mockHelpers.setOrderCache(orders)
    return
  }
  return request({ url: `/orders/${id}/receive`, method: 'POST' })
}

/* ====================================================================
 * 买家下单（立即购买 / 购物车结算共用）
 * ==================================================================== */

/** 商品状态 → 中文（下单校验的报错文案要用，与 goods.ts 的口径保持一致） */
const GOODS_STATE_TEXT: Record<string, string> = {
  on_sale: '在售',
  pending: '审核中',
  sold: '已售出',
  off_shelf: '已下架'
}

export interface CreateOrderPayload {
  goodsId: number
  /** 购买数量；不传视为 1 件。超过可售数量直接抛错 */
  quantity?: number
  /** 买家备注（如「周末在宿舍楼下交易」） */
  remark?: string
  address?: string
}

/**
 * 创建订单。
 *
 * 三条底线，缺一条就会产生无法履约或无法对账的脏数据：
 *  ① **只在售商品可下单** —— 审核中 / 已下架 / 已售出的商品不能生成订单；
 *  ② **数量不得超过可售数量** —— 否则确认订单后卖家根本发不出货；
 *  ③ **价格必须走 `settlePrice()` 落快照** —— 让利价是活动期价格，
 *     活动结束后卖家改价都不该影响已成交的这一单，事后对账要拿得出当时的价。
 */
export async function createOrder(payload: CreateOrderPayload): Promise<Order> {
  if (USE_MOCK) {
    await mockHelpers.delay(520)
    const list = mockHelpers.getGoodsCache()
    const goods = list.find((g) => g.id === payload.goodsId)
    if (!goods) throw new Error('商品不存在或已被删除')
    if (goods.status === 'pending') throw new Error('商品正在审核中，暂时无法购买')
    if (goods.status !== 'on_sale') throw new Error(`商品已${GOODS_STATE_TEXT[goods.status] ?? '不可售'}，无法购买`)

    const quantity = Math.max(1, Math.floor(payload.quantity ?? 1))
    const stock = resolveStock(goods)
    if (quantity > stock) throw new Error(`库存不足，该商品当前仅剩 ${stock} 件`)

    const fundSource = resolveFundSourceForGoods(goods)
    // 数量放大走统一入口，保证四个金额项永远对得上（不各乘各的）
    const b = scaleBreakdown(settlePrice(goods, fundSource), quantity)
    const buyer = mockUsersExport[0]

    const orders = mockHelpers.getOrderCache()
    // 订单号沿用 2026 + 5 位的格式，取现有最大值 +1，保证既不撞号也能稳定排序
    const nextId = orders.reduce((max, o) => Math.max(max, Number(o.id) || 0), 202600000) + 1

    const order: Order = {
      id: String(nextId),
      status: 'pending_payment',
      goods: {
        id: goods.id,
        title: goods.title,
        cover: goods.cover,
        price: goods.price,
        promoPrice: goods.promoPrice
      },
      buyerId: buyer.id,
      buyerName: buyer.nickname,
      sellerId: goods.sellerId,
      sellerName: goods.sellerName,
      amount: b.payAmount,
      listPrice: b.listPrice,
      sellerCut: b.sellerCut,
      platformSubsidy: b.platformSubsidy,
      sellerIncome: b.sellerIncome,
      fundSource,
      activityId: b.onPromo ? goods.activityId : undefined,
      quantity,
      remark: payload.remark,
      address: payload.address ?? '北京市海淀区学院路 38 号 计算机学院宿舍',
      createTime: new Date().toISOString()
    }
    // 落一条「买家下单」日志：后台订单详情的时间线由此而来
    mockHelpers.refreshOrderHistory(order)
    mockHelpers.setOrderCache([order, ...orders])

    /*
     * 扣减库存，售罄即置「已售出」。
     * 不扣库存的话，同一件单件闲置可以被无限次下单。
     * 扣掉的部分会在订单取消 / 退款时回补（见 cancelOrder，与后端同口径）。
     */
    const rest = stock - quantity
    mockHelpers.setGoodsCache(
      list.map((g) => (g.id === goods.id ? { ...g, stock: rest, status: rest <= 0 ? 'sold' : g.status } : g))
    )
    return order
  }
  return request({ url: '/orders', method: 'POST', data: payload })
}

/* ====================================================================
 * 管理端订单操作
 * ==================================================================== */

/**
 * 管理员改订单状态（含补填运单号），并写入操作日志。
 *
 * 状态机会拦下非法流转。日志与状态在**同一次调用**里落库，
 * 不允许调用方自己拼日志 —— 批量操作、接口直调时最容易漏记，
 * 事后追溯就变成一笔糊涂账。
 */
export async function updateOrderStatus(payload: {
  id: string
  status: Order['status']
  trackingNo?: string
  logisticsCompany?: string
  /** 关闭订单时的原因（不传则按通用文案记） */
  reason?: string
}): Promise<void> {
  if (USE_MOCK) {
    await mockHelpers.delay(300)
    const orders = mockHelpers.getOrderCache()
    const o = orders.find((x) => x.id === payload.id)
    if (!o) throw new Error('订单不存在')

    const before = o.status
    // 状态机校验：只许顺着走，不许回退或跳到不相干的状态
    if (!ORDER_TRANSITIONS[before].includes(payload.status)) {
      throw new Error(
        `非法流转：订单当前「${ORDER_STATUS_LABEL[before]}」，只能推进到「${
          ORDER_TRANSITIONS[before].map((s) => ORDER_STATUS_LABEL[s]).join(' / ') || '无（已终结）'
        }」`
      )
    }
    const now = new Date().toISOString()
    o.status = payload.status
    if (payload.trackingNo !== undefined) o.trackingNo = payload.trackingNo
    if (payload.logisticsCompany !== undefined) o.logisticsCompany = payload.logisticsCompany
    if (payload.status === 'shipped' && !o.shipTime) o.shipTime = now
    if (payload.status === 'pending_ship' && !o.payTime) o.payTime = now
    if (payload.status === 'received' && !o.receiveTime) o.receiveTime = now
    if (payload.status === 'completed' && !o.completeTime) {
      if (!o.receiveTime) o.receiveTime = now
      o.completeTime = now
    }
    /*
     * 关闭订单必须留下原因。主流电商里「已取消」不是一个状态就完了 ——
     * 取消原因直接决定责任归属（超时未付款是买家责任、卖家缺货是卖家责任），
     * 没有原因，退款与信用扣分的依据就没了。
     */
    if (payload.status === 'cancelled' && !o.cancelReason) {
      o.cancelReason = { time: now, text: payload.reason ?? '管理员关闭订单' }
    }
    recordOrderLog(o, {
      time: now,
      action:
        payload.status === 'cancelled'
          ? 'cancel'
          : payload.status === 'shipped'
            ? 'ship'
            : payload.status === 'received'
              ? 'receive'
              : payload.status === 'completed'
                ? 'complete'
                : 'adjust',
      actionLabel: ORDER_STATUS_LABEL[payload.status],
      from: before,
      to: payload.status,
      note: payload.reason ?? (payload.trackingNo ? `运单号 ${payload.trackingNo}` : undefined),
      ...logActor('admin', '管理员')
    })
    mockHelpers.setOrderCache(orders)

    mockHelpers.addAuditLog({
      action: 'order.status',
      actionLabel: '修改订单状态',
      target: `订单 ${o.id}`,
      detail: `${ORDER_STATUS_LABEL[before]} → ${ORDER_STATUS_LABEL[payload.status]}`
    })
    return
  }
  return request({ url: `/admin/orders/${payload.id}/status`, method: 'PATCH', data: payload })
}

export interface RefundPayload {
  /** 实退金额；不传视为全额退（不得超过订单实付） */
  amount?: number
  /** 退款原因（后台选单，见 REFUND_REASONS） */
  reason?: string
  /** 处理备注 */
  remark?: string
}

/**
 * 退款：置为已取消并记录退款单（金额 / 原因 / 发起方 / 备注）。
 *
 * 相比旧版只记一个 `refundTime`，这里回答了对账真正需要的三个问题：
 * 退了多少（可部分退）、为什么退、谁批的。
 * `refunding` 状态（买家已申请）也在可退之列 —— 那是售后的正常出口。
 */
export async function refundOrder(id: string, payload: RefundPayload = {}): Promise<void> {
  if (USE_MOCK) {
    await mockHelpers.delay(420)
    const orders = mockHelpers.getOrderCache()
    const o = orders.find((x) => x.id === id)
    if (!o) throw new Error('订单不存在')
    if (o.status === 'cancelled') throw new Error('该订单已取消，无需重复退款')
    if (!REFUNDABLE_STATUS.includes(o.status)) {
      throw new Error(`订单当前「${ORDER_STATUS_LABEL[o.status]}」，不支持退款`)
    }

    const before = o.status
    const now = new Date().toISOString()
    const amount = payload.amount ?? o.amount
    if (!(amount > 0)) throw new Error('退款金额必须大于 0')
    if (amount > o.amount) throw new Error(`退款金额不得超过买家实付 ¥${o.amount.toFixed(2)}`)

    /*
     * 买家已申请过退款的（refunding），沿用其原始原因与申请时间 ——
     * 管理员处理时改掉原因会让售后统计失去意义（申请理由是证据，不是可编辑字段）。
     */
    const existed = o.refund
    o.refund = {
      amount,
      reason: existed?.reason ?? payload.reason ?? '双方协商一致退款',
      by: existed?.by ?? 'admin',
      time: existed?.time ?? now,
      remark: payload.remark ?? existed?.remark
    }
    o.status = 'cancelled'
    o.refundTime = now

    // 若是管理员直接退（没有买家申请过），补一条「平台发起退款」，日志才完整
    if (!existed) {
      recordOrderLog(o, {
        time: now,
        action: 'refund',
        actionLabel: '平台发起退款',
        from: before,
        to: 'refunding',
        note: o.refund.reason,
        ...logActor('admin', '管理员')
      })
    }
    recordOrderLog(o, {
      time: now,
      action: 'refund',
      actionLabel: '退款完成，订单关闭',
      from: 'refunding',
      to: 'cancelled',
      note: `退款 ¥${amount.toFixed(2)}${payload.remark ? ` · ${payload.remark}` : ''}`,
      ...logActor('admin', '管理员')
    })
    mockHelpers.setOrderCache(orders)

    mockHelpers.addAuditLog({
      action: 'order.refund',
      actionLabel: '订单退款',
      target: `订单 ${o.id}`,
      detail: `退款 ¥${amount.toFixed(2)}（原因：${o.refund.reason}；原状态：${ORDER_STATUS_LABEL[before]}）`
    })
    return
  }
  return request({ url: `/admin/orders/${id}/refund`, method: 'POST', data: payload })
}

/* ====================================================================
 * 管理端批量处置
 * ==================================================================== */

/** 可批量执行的动作（都要能一次点完一批，逐单点是最没效率的做法） */
export type BatchOrderAction = 'mark_paid' | 'ship' | 'close'

/**
 * 承运商 → 运单号前缀（ASCII）。
 * 运单号是对外单号，含中文会被快递系统与格式校验同时拒掉，所以不能取中文名的首字。
 */
const CARRIER_CODE: Record<string, string> = {
  顺丰速运: 'SF',
  中通快递: 'ZTO',
  圆通速递: 'YTO',
  韵达快递: 'YD',
  京东物流: 'JD'
}

export interface BatchOrderResult {
  /** 成功处置的单数 */
  ok: number
  /** 被跳过的：状态不允许 + 原因，逐条说清楚，别只说「跳过 N 单」 */
  skipped: Array<{ id: string; reason: string }>
}

/**
 * 批量处置。
 *
 * 逐条仍走单条的状态机校验（`skipped` 会把不合法的挑出来），
 * 不做「一把梭全改」—— 批量入口最容易掩盖的 bug 就是
 * 把 50 单里 3 单已完成的一起改成待发货，且没有任何提示。
 */
export async function batchOrderAction(
  ids: string[],
  action: BatchOrderAction,
  options: { carrier?: string; reason?: string } = {}
): Promise<BatchOrderResult> {
  if (!USE_MOCK) {
    return request({ url: '/admin/orders/batch', method: 'POST', data: { ids, action, ...options } })
  }
  await mockHelpers.delay(560)
  const orders = mockHelpers.getOrderCache()
  const skipped: BatchOrderResult['skipped'] = []
  let ok = 0

  for (const id of ids) {
    const o = orders.find((x) => x.id === id)
    if (!o) {
      skipped.push({ id, reason: '订单不存在' })
      continue
    }
    const before = o.status
    const now = new Date().toISOString()

    if (action === 'mark_paid') {
      if (before !== 'pending_payment') {
        skipped.push({ id, reason: `当前「${ORDER_STATUS_LABEL[before]}」，无需标记付款` })
        continue
      }
      o.status = 'pending_ship'
      o.payTime = now
      recordOrderLog(o, {
        time: now,
        action: 'pay',
        actionLabel: '批量标记付款',
        from: before,
        to: 'pending_ship',
        note: '管理员在订单工作台批量确认收款',
        ...logActor('admin', '管理员')
      })
    } else if (action === 'ship') {
      if (before !== 'pending_ship') {
        skipped.push({ id, reason: `当前「${ORDER_STATUS_LABEL[before]}」，不能发货` })
        continue
      }
      const carrier = options.carrier ?? '顺丰速运'
      /*
       * 批量发货没有逐个录入运单号的余地，按「承运商代号 + 订单尾号」生成一个可追溯的号。
       * 代号必须取 ASCII —— 直接用承运商首字（顺 / 中 / 圆）会生成「中B02600009」
       * 这种含中文的运单号，既不符合快递单号规则，也过不了运单号的格式校验。
       */
      const carrierCode = CARRIER_CODE[carrier] ?? 'YB'
      const trackingNo = `${carrierCode}${o.id.slice(-8)}`
      o.status = 'shipped'
      o.trackingNo = trackingNo
      o.logisticsCompany = carrier
      o.shipTime = now
      o.traces = [{ time: now, text: `卖家已发货，${carrier} 快件已被【北京学院路营业点】揽收` }]
      recordOrderLog(o, {
        time: now,
        action: 'ship',
        actionLabel: '批量发货',
        from: before,
        to: 'shipped',
        note: `${carrier} ${trackingNo}`,
        ...logActor('admin', '管理员')
      })
    } else {
      if (!ORDER_TRANSITIONS[before].includes('cancelled')) {
        skipped.push({ id, reason: `当前「${ORDER_STATUS_LABEL[before]}」，不能关闭` })
        continue
      }
      o.status = 'cancelled'
      o.cancelReason = { time: now, text: options.reason ?? '管理员批量关闭' }
      recordOrderLog(o, {
        time: now,
        action: 'cancel',
        actionLabel: '订单关闭',
        from: before,
        to: 'cancelled',
        note: o.cancelReason.text,
        ...logActor('admin', '管理员')
      })
    }
    ok += 1
  }
  mockHelpers.setOrderCache(orders)

  mockHelpers.addAuditLog({
    action: `order.batch.${action}`,
    actionLabel: '批量处置订单',
    target: `${ids.length} 笔订单`,
    detail: `成功 ${ok} 笔${skipped.length ? `，跳过 ${skipped.length} 笔` : ''}`
  })
  return { ok, skipped }
}

/**
 * 售后单「回到哪里」：最近一条「进入 refunding」日志的 from ——
 * 与后端 OrderService#refundBackTarget 同一算法。
 * 语义是「撤销售后单，退回申请退款前的履约进度」，而不是无条件退回 shipped
 * （从 pending_ship 申请的售后单本来就没发过货）。
 */
function refundBackStatusOf(o: Order): Order['status'] {
  const into = o.logs?.find((l) => l.to === 'refunding')
  const from = into?.from as Order['status'] | undefined
  if (from && from !== 'refunding' && REFUNDABLE_STATUS.includes(from)) return from
  return 'shipped'
}

/**
 * 驳回退款申请：把 `refunding` 退回**申请退款前的履约状态**（pending_ship / shipped / received 之一），
 * 双方继续履约。
 *
 * 为什么不复用 `updateOrderStatus(id, 'shipped')`：
 * 状态机（`ORDER_TRANSITIONS`）是**只许顺流**的，`refunding → shipped` 不是它的边。
 * 驳回本质上不是一次普通的流转，而是「撤销一个售后单 + 回到申请售后前的状态」的组合动作，
 * 必须整体原子完成（清退款单、改状态、记日志三件事）。
 * 不能无条件退回 `shipped`：从 `pending_ship` 申请的售后单本来就没发过货，
 * 强行置 `shipped` 会让订单「已发货却没有发货时间」，与状态机自相矛盾；
 * 所以给它一个独立入口，取「进入 refunding 的那条日志的 from」作为恢复目标，
 * 而不是把状态机开一个逆流的洞。
 */
export async function rejectRefund(id: string, note?: string): Promise<void> {
  if (USE_MOCK) {
    await mockHelpers.delay(360)
    const orders = mockHelpers.getOrderCache()
    const o = orders.find((x) => x.id === id)
    if (!o) throw new Error('订单不存在')
    if (o.status !== 'refunding') throw new Error(`订单当前「${ORDER_STATUS_LABEL[o.status]}」，没有待处理的退款申请`)

    const now = new Date().toISOString()
    // 售后单整套字段都要清干净（与后端 rejectRefund 把 refund_* 全部置 null 对齐）：
    // 只删 refund 而留下 refundTime，会出现「没有退款单却有退款完成时间」的残留
    delete o.refund
    delete o.refundTime
    const back = refundBackStatusOf(o)
    o.status = back
    recordOrderLog(o, {
      time: now,
      action: 'adjust',
      actionLabel: '驳回退款申请',
      from: 'refunding',
      to: back,
      note: note?.trim() || '经核实后驳回，订单恢复履约',
      ...logActor('admin', '管理员')
    })
    mockHelpers.setOrderCache(orders)
    mockHelpers.addAuditLog({
      action: 'order.refund.reject',
      actionLabel: '驳回退款申请',
      target: `订单 ${o.id}`,
      detail: `订单恢复为${ORDER_STATUS_LABEL[back]}`
    })
    return
  }
  return request({ url: `/admin/orders/${id}/refund/reject`, method: 'POST', data: { note } })
}

/**
 * 写 / 清空后台内部备注。
 *
 * 单独一个入口而不是塞进改状态里：备注是**协作用**的（交接班留言、风险标注），
 * 改状态是**业务动作**，两者写进同一条日志后，
 * 事后看日志会分不清「这笔是状态真的变了，还是只是有人留了句话」。
 */
export async function saveOrderNote(id: string, note: string): Promise<void> {
  if (USE_MOCK) {
    await mockHelpers.delay(280)
    const orders = mockHelpers.getOrderCache()
    const o = orders.find((x) => x.id === id)
    if (!o) throw new Error('订单不存在')
    const text = note.trim()
    if (o.adminNote === text) return
    const now = new Date().toISOString()
    o.adminNote = text || undefined
    recordOrderLog(o, {
      time: now,
      action: 'note',
      actionLabel: text ? '更新后台备注' : '清空后台备注',
      note: text || undefined,
      ...logActor('admin', '管理员')
    })
    mockHelpers.setOrderCache(orders)
    mockHelpers.addAuditLog({
      action: 'order.note',
      actionLabel: '订单内部备注',
      target: `订单 ${o.id}`,
      detail: text ? text.slice(0, 40) : '（已清空）'
    })
    return
  }
  return request({ url: `/admin/orders/${id}/note`, method: 'PATCH', data: { note } })
}
