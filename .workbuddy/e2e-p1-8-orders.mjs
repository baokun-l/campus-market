// ====================================================================
// P1-8 修复复验 + 订单/会话种子数据联通性验证
// ====================================================================
// 覆盖三件事：
//   A. 商品详情的可见性判定（本轮新修的 P1-8）
//      on_sale / sold          → 任何人可读
//      pending / off_shelf     → 仅卖家本人 + 后台角色（admin/goods_admin/report_admin）
//      不可读时必须是 404（不是 403，否则泄露「这个 id 存在」）
//   B. 订单种子数据的读取链路（列表 / 日志 / 角色筛选 / 状态筛选 / 后台统计）
//   C. 私信会话种子数据的读取链路（会话列表 / 消息列表 / 未读计数 / 拉取即已读）
//
// 前置：后端已启动在 8080（context-path /api），且已执行 demo-data.sql + demo-data-orders.sql
// 用法：node .workbuddy/e2e-p1-8-orders.mjs
//
// 注：用 Node 内置 fetch（不走系统代理），刻意不用 curl —— 本机 HTTP_PROXY 会让
//     localhost 请求被代理掉返 502。
// ====================================================================

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8080/api'

let pass = 0
let fail = 0
const failures = []

function ok(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`  \x1b[32mPASS\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail++
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n\x1b[36m${title}\x1b[0m`)
}

/** 发请求；返回 { http, code, data, raw }。code 是业务码（Result.code） */
async function req(method, path, { token, body } = {}) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  let json = null
  const text = await res.text()
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON 响应（如 401 的纯文本）保持 null */
  }
  return { http: res.status, code: json?.code, data: json?.data, raw: text }
}

const USERS = {
  admin: { username: 'admin', password: 'admin123', id: 1, role: 'admin' },
  goodsAdmin: { username: 'goods_admin', password: 'goods123456', id: 2, role: 'goods_admin' },
  reportAdmin: { username: 'report_admin', password: 'report123456', id: 3, role: 'report_admin' },
  zhangsan: { username: 'zhangsan', password: '123456', id: 4, role: 'user' },
  lisi: { username: 'lisi', password: '123456', id: 5, role: 'user' },
  wangwu: { username: 'wangwu', password: '123456', id: 6, role: 'user' }
}

async function login(key) {
  const u = USERS[key]
  const r = await req('POST', '/user/login', { body: { username: u.username, password: u.password } })
  if (r.code !== 0) throw new Error(`登录 ${u.username} 失败: ${r.raw.slice(0, 200)}`)
  const token = r.data?.token || r.data?.accessToken
  if (!token) throw new Error(`登录 ${u.username} 未返回 token，返回体: ${r.raw.slice(0, 200)}`)
  return token
}

// 商品样本（状态取自 demo-data.sql）
const PENDING = 12      // pending，卖家 4 zhangsan
const OFF_SHELF = 6     // off_shelf，卖家 5 lisi
const ON_SALE = 5       // on_sale，卖家 4 zhangsan
const SOLD = 13         // sold，卖家 5 lisi

/**
 * demo-data-orders.sql 播种的 9 笔订单号。
 *
 * 断言刻意只针对这批 id，而不是「全表总数」—— e2e-deep.mjs 会自己下单且只清商品
 * 不清订单，跑完会给库留下若干 pending_payment 单；若断言写死总数，
 * 换台机器/换个执行顺序就会假失败。数据隔离类断言（不含他人订单）仍按全量查。
 */
const SEED_ORDER_IDS = [
  '20260916201512001', '20260915102033002', '20260912090511003',
  '20260905194000004', '20260828151000005', '20260909083000006',
  '20260907120000007', '20260916091000008', '20260820140000009'
]
const seededOnly = (list) => (list || []).filter((o) => SEED_ORDER_IDS.includes(o.id))

async function main() {
  console.log(`目标: ${BASE}`)

  /* ---------------------------------------------------------------
   * 预热：确认后端活着
   * --------------------------------------------------------------- */
  section('0. 后端可达性')
  const health = await req('GET', '/goods?page=1&pageSize=1')
  ok('GET /goods 可达且业务成功', health.code === 0, `http=${health.http} code=${health.code}`)
  if (health.code !== 0) {
    console.log('\n后端不可用，后续用例无法执行。')
    process.exit(1)
  }

  /* ---------------------------------------------------------------
   * A. P1-8 匿名可见性
   * --------------------------------------------------------------- */
  section('A. 匿名（不带 token）访问商品详情')
  const anonPending = await req('GET', `/goods/${PENDING}`)
  ok(
    `审核中商品 #${PENDING} 匿名不可读`,
    anonPending.code === 404,
    `期望 code=404，实得 code=${anonPending.code} http=${anonPending.http}`
  )
  ok('  且不泄露商品数据', anonPending.data == null, `data=${JSON.stringify(anonPending.data)?.slice(0, 60)}`)

  const anonOff = await req('GET', `/goods/${OFF_SHELF}`)
  ok(
    `已下架商品 #${OFF_SHELF} 匿名不可读`,
    anonOff.code === 404,
    `期望 code=404，实得 code=${anonOff.code}`
  )

  const anonOnSale = await req('GET', `/goods/${ON_SALE}`)
  ok(`在售商品 #${ON_SALE} 匿名可读`, anonOnSale.code === 0, `code=${anonOnSale.code}`)

  const anonSold = await req('GET', `/goods/${SOLD}`)
  ok(`已售出商品 #${SOLD} 匿名可读`, anonSold.code === 0, `code=${anonSold.code}`)

  const anonMissing = await req('GET', '/goods/999999')
  ok('不存在的商品返回 404', anonMissing.code === 404, `code=${anonMissing.code}`)

  // JSON 列 & 浏览量：确认这条路径没有被判定逻辑改坏
  ok('在售商品 images 仍是数组', Array.isArray(anonOnSale.data?.images), `typeof=${typeof anonOnSale.data?.images}`)
  const vc1 = anonOnSale.data?.viewCount
  const anonOnSale2 = await req('GET', `/goods/${ON_SALE}`)
  ok(
    '详情仍正常累加浏览量',
    anonOnSale2.data?.viewCount === vc1 + 1,
    `${vc1} → ${anonOnSale2.data?.viewCount}`
  )

  // 列表侧也必须收敛：否则匿名能从列表读到「审核中」商品的完整字段（含 description），
  // 把详情接口刚补上的判定整个绕过去。
  const anonList = await req('GET', '/goods?page=1&pageSize=100')
  const anonStatuses = [...new Set((anonList.data?.list || []).map((g) => g.status))]
  ok(
    '匿名商品列表不含 pending / off_shelf',
    (anonList.data?.list || []).every((g) => g.status !== 'pending' && g.status !== 'off_shelf'),
    `statuses=${anonStatuses.join(',')}`
  )
  ok(
    '匿名商品列表仍能看到 on_sale / sold（不是把列表清空了）',
    anonStatuses.includes('on_sale') && anonList.data?.total > 0,
    `total=${anonList.data?.total}`
  )

  /* ---------------------------------------------------------------
   * B. P1-8 带身份可见性（关键：别把卖家自己挡在门外）
   * --------------------------------------------------------------- */
  section('B. 登录后访问「审核中 / 已下架」商品详情')
  const tokens = {}
  for (const k of Object.keys(USERS)) tokens[k] = await login(k)

  const matrix = [
    ['zhangsan', PENDING, 0, '卖家本人在「我的发布」里查看自己的待审商品'],
    ['lisi', PENDING, 404, '普通用户不得提前看到他人待审内容'],
    ['wangwu', PENDING, 404, '同上'],
    ['admin', PENDING, 0, '管理员需审核，必须可读'],
    ['goodsAdmin', PENDING, 0, '商品审核员需审核，必须可读'],
    ['reportAdmin', PENDING, 0, '举报审核员要能打开被举报的待审商品'],
    ['lisi', OFF_SHELF, 0, '卖家本人要能看自己已下架的发布'],
    ['zhangsan', OFF_SHELF, 404, '他人已下架商品不可读'],
    ['reportAdmin', OFF_SHELF, 0, '被举报下架的商品，举报台要能复核']
  ]
  for (const [who, gid, expect, why] of matrix) {
    const r = await req('GET', `/goods/${gid}`, { token: tokens[who] })
    ok(
      `${who.padEnd(11)} → #${gid} 期望 ${expect}`,
      r.code === expect,
      `实得 ${r.code}｜${why}`
    )
  }

  // 卖家视角 + 匿名 → 匿名仍不可读（不能因为「有人登录过」就放行）
  const anonAfter = await req('GET', `/goods/${PENDING}`)
  ok('上一步结束后匿名仍未放行', anonAfter.code === 404, `code=${anonAfter.code}`)

  // 后台列表视图：不带状态条件时必须拿到全量，否则「商品管理」页看不到待审/已下架商品
  const adminList = await req('GET', '/goods?page=1&pageSize=100', { token: tokens.admin })
  const adminStatuses = [...new Set((adminList.data?.list || []).map((g) => g.status))]
  ok(
    '后台列表（不带状态条件）返回全量，含 pending / off_shelf',
    adminStatuses.includes('pending') && adminStatuses.includes('off_shelf'),
    `statuses=${adminStatuses.join(',')}`
  )
  /* --- 后台显式传 statuses：三种序列化形态都必须绑得上 --- */

  // axios（浏览器 XHR / fetch）把数组序列化成 `statuses[]=on_sale&statuses[]=sold`，
  // 且会把方括号百分号编码成 %5B %5D。这里**必须照抄编码后的形态**：
  // Tomcat 默认拒绝请求行里的原始 `[` `]`（直接 400 Bad Request，响应体是 HTML），
  // 而 node fetch 走 WHATWG URL 不编码它们 —— 用裸方括号测会得到一个
  // 纯属测试自身的假失败（曾在本次验证中出现过）。
  const explicit = await req(
    'GET',
    '/goods?page=1&pageSize=100&statuses%5B%5D=pending',
    { token: tokens.admin }
  )
  ok(
    '后台显式 statuses（%5B%5D 编码形态，即 axios 真实写法）原样生效',
    explicit.data?.total > 0 && (explicit.data?.list || []).every((g) => g.status === 'pending'),
    `total=${explicit.data?.total}`
  )

  // 裸名与 CSV 形态是服务端 Params.multiValue 额外兼容的，一并锁住，
  // 免得哪天有人把 multiValue 换回 @RequestParam List 而无人察觉。
  const csvForm = await req(
    'GET',
    '/goods?page=1&pageSize=100&statuses=pending,off_shelf',
    { token: tokens.admin }
  )
  const csvStatuses = [...new Set((csvForm.data?.list || []).map((g) => g.status))].sort()
  ok(
    '后台 CSV 形态 statuses 原样生效（server 兼容多种序列化）',
    csvForm.data?.total > 0 && csvStatuses.every((s) => s === 'pending' || s === 'off_shelf'),
    `statuses=${csvStatuses.join(',')}`
  )

  /* --- ★ 可见范围必须由服务端说了算：调用方自己声明白名单不算数 --- */
  section('B2. 越界筛选条件不得撑开可见范围（白名单不可由调用方声明）')

  const scopeChecks = [
    ['匿名 statuses=pending', '/goods?page=1&pageSize=100&statuses=pending', null],
    ['匿名 status=pending', '/goods?page=1&pageSize=100&status=pending', null],
    ['匿名 statuses=pending,off_shelf', '/goods?page=1&pageSize=100&statuses=pending,off_shelf', null],
    ['登录买家 statuses=pending', '/goods?page=1&pageSize=100&statuses=pending', tokens.lisi],
    // 只看「他人」的 sellerId —— 传别人的 id 不该获得任何额外可见性
    ['登录买家 sellerId=他人 + statuses=pending', '/goods?page=1&pageSize=100&sellerId=4&statuses=pending', tokens.lisi]
  ]
  for (const [label, path, token] of scopeChecks) {
    const r = await req('GET', path, { token })
    const list = r.data?.list || []
    const leaked = list.filter((g) => g.status === 'pending' || g.status === 'off_shelf')
    ok(
      label,
      r.code === 0 && leaked.length === 0 && list.length > 0,
      `total=${r.data?.total} 越界条数=${leaked.length}`
    )
  }

  // 反向断言：卖家查**自己**的发布时必须能看见待审 / 已下架，
  // 否则「我的发布」列表会凭空少东西（收紧可见范围最容易踩坏的地方）。
  const selfScoped = await req(
    'GET',
    '/goods?page=1&pageSize=100&sellerId=4&statuses=pending,off_shelf',
    { token: tokens.zhangsan }
  )
  const selfStatuses = [...new Set((selfScoped.data?.list || []).map((g) => g.status))].sort()
  ok(
    '卖家查自己（sellerId=本人）时待审/已下架可见 —— 「我的发布」依赖这条',
    selfScoped.code === 0 && (selfScoped.data?.list || []).length > 0,
    `statuses=${selfStatuses.join(',')}`
  )

  /* ---------------------------------------------------------------
   * C. 订单种子数据
   * --------------------------------------------------------------- */
  section('C. 订单种子数据')
  const zhOrders = await req('GET', '/orders?page=1&pageSize=50', { token: tokens.zhangsan })
  ok('买卖双方都能拉到自己的订单', zhOrders.code === 0 && zhOrders.data?.total > 0, `total=${zhOrders.data?.total}`)
  ok(
    '分页体是 PageResult（list 而不是 records）',
    Array.isArray(zhOrders.data?.list),
    `keys=${Object.keys(zhOrders.data || {}).join(',')}`
  )
  const zhList = zhOrders.data?.list || []
  // zhangsan(id 4) 参与的单：作为买家 ② ⑥ ⑨，作为卖家 ③ ⑧ —— 种子里的 5 笔
  ok('zhangsan 能看到自己参与的全部 5 笔种子单', seededOnly(zhList).length === 5, `实得 ${seededOnly(zhList).length}`)
  // ★ 数据隔离：列表里不允许出现与自己无关的单（曾因不传 role 时 WHERE 只剩 1=1 而漏出全表）
  const leaked = zhList.filter((o) => o.buyerId !== 4 && o.sellerId !== 4)
  ok('列表中不含他人订单（默认视图按当前用户收敛）', leaked.length === 0, leaked.length ? `漏出 ${leaked.length} 笔：${leaked.map((o) => o.id).join(',')}` : '0 笔')
  ok('他人订单的收货地址不可见', !leaked.some((o) => !!o.address), `leaked=${leaked.length}`)

  // 未登录不得读订单（非公开路由）
  const anonOrders = await req('GET', '/orders?page=1&pageSize=10')
  ok('匿名读订单被拒', anonOrders.code !== 0, `code=${anonOrders.code}`)

  const buyerOnly = await req('GET', '/orders?page=1&pageSize=50&role=buyer', { token: tokens.zhangsan })
  ok('role=buyer 只返回买家单（种子 3 笔）', seededOnly(buyerOnly.data?.list).length === 3, `实得 ${seededOnly(buyerOnly.data?.list).length}`)
  ok('role=buyer 的结果里没有卖家单', (buyerOnly.data?.list || []).every((o) => o.buyerId === 4))
  const sellerOnly = await req('GET', '/orders?page=1&pageSize=50&role=seller', { token: tokens.zhangsan })
  ok('role=seller 只返回卖家单（种子 2 笔）', seededOnly(sellerOnly.data?.list).length === 2, `实得 ${seededOnly(sellerOnly.data?.list).length}`)
  ok('role=seller 的结果里没有买家单', (sellerOnly.data?.list || []).every((o) => o.sellerId === 4))

  const one = zhList[0]
  ok('订单带嵌套 goods 视图（前端 order.goods.title 取值）', typeof one?.goods?.title === 'string' && one.goods.title.length > 0, `title=${one?.goods?.title}`)
  ok('订单带 logs 数组', Array.isArray(one?.logs), `typeof=${typeof one?.logs}`)
  ok('订单带 address 字段（前端必填）', typeof one?.address === 'string' && one.address.length > 0, `address=${one?.address}`)
  ok('订单金额快照齐全', typeof one?.listPrice === 'number' && typeof one?.sellerIncome === 'number', `listPrice=${one?.listPrice} sellerIncome=${one?.sellerIncome}`)

  // 状态筛选：7 个状态逐个查，总数必须等于 SQL 播种的分布
  const expectedByStatus = {
    pending_payment: 1, pending_ship: 2, shipped: 1,
    received: 1, completed: 2, refunding: 1, cancelled: 1
  }
  const allOrders = await req('GET', '/admin/orders?page=1&pageSize=100', { token: tokens.admin })
  ok('管理端可检索全部订单', allOrders.code === 0, `code=${allOrders.code}`)
  const allList = allOrders.data?.list || []
  const orderIdByStatus = {}
  for (const o of allList) orderIdByStatus[o.status] = o.id

  for (const [st, n] of Object.entries(expectedByStatus)) {
    const r = await req('GET', `/admin/orders?page=1&pageSize=100&status=${st}`, { token: tokens.admin })
    const hit = seededOnly(r.data?.list)
    ok(`状态筛选 ${st} 命中种子 ${n} 笔`, hit.length === n, `实得 ${hit.length}`)
    ok(`  且筛选结果确实都是 ${st}`, (r.data?.list || []).every((o) => o.status === st))
  }

  // 优先取种子单：库里的其它单可能来自 e2e-deep 的联调，字段未必满足下面的断言
  const pick = (status) =>
    allList.find((o) => o.status === status && SEED_ORDER_IDS.includes(o.id)) ||
    allList.find((o) => o.status === status)

  // 物流轨迹格式（前端 LogisticsTrace = {time,text}，且最新在前）
  const shipped = pick('shipped')
  ok('已发货订单带 trackingNo / 承运公司', !!shipped?.trackingNo && !!shipped?.logisticsCompany, `${shipped?.logisticsCompany} ${shipped?.trackingNo}`)
  ok('物流轨迹为数组', Array.isArray(shipped?.traces), `typeof=${typeof shipped?.traces}`)
  if (Array.isArray(shipped?.traces) && shipped.traces.length) {
    const t0 = shipped.traces[0]
    ok('轨迹元素是 {time,text}', typeof t0?.time === 'string' && typeof t0?.text === 'string', JSON.stringify(t0)?.slice(0, 80))
    ok('轨迹起点不早于发货时间', Date.parse(t0.time) >= Date.parse(shipped.shipTime), `ship=${shipped.shipTime} first=${t0.time}`)
    ok('轨迹最新在前', Date.parse(shipped.traces[0].time) >= Date.parse(shipped.traces[shipped.traces.length - 1].time))
  }

  // 售后：退款单字段（前端 order.refund）
  const refunding = pick('refunding')
  ok('退款中订单带 refund 对象', refunding?.refund != null, JSON.stringify(refunding?.refund)?.slice(0, 120))
  ok('退款金额/原因/发起方齐全', refunding?.refund?.amount > 0 && !!refunding?.refund?.reason && refunding?.refund?.by === 'buyer', `amount=${refunding?.refund?.amount} by=${refunding?.refund?.by}`)
  ok('后台内部备注只在该单可见（adminNote）', typeof refunding?.adminNote === 'string' && refunding.adminNote.length > 0)
  // 平台补贴口径：卖家实收 = 挂牌价（补贴不让卖家吃亏）
  ok(
    '平台补贴单：卖家实收 = 挂牌价',
    Number(refunding?.sellerIncome) === Number(refunding?.listPrice) && Number(refunding?.platformSubsidy) > 0,
    `list=${refunding?.listPrice} income=${refunding?.sellerIncome} subsidy=${refunding?.platformSubsidy}`
  )
  // 买家实付 = 挂牌价 - 平台补贴 + 卖家让利
  ok(
    '金额恒等式成立（实付 + 补贴 = 挂牌价 + 让利）',
    Number(refunding?.amount) + Number(refunding?.platformSubsidy) === Number(refunding?.listPrice) + Number(refunding?.sellerCut),
    `${refunding?.amount} + ${refunding?.platformSubsidy} = ${refunding?.listPrice} + ${refunding?.sellerCut}`
  )

  // 已取消：必须留关闭原因（前端 order.cancelReason）
  const cancelled = pick('cancelled')
  ok('已取消订单带 cancelReason {time,text}', !!cancelled?.cancelReason?.text && !!cancelled?.cancelReason?.time, cancelled?.cancelReason?.text)

  // 订单日志接口
  const logsResp = await req('GET', `/orders/${shipped.id}/logs`, { token: tokens.zhangsan })
  ok('订单日志接口可用', logsResp.code === 0 && Array.isArray(logsResp.data), `code=${logsResp.code} n=${logsResp.data?.length}`)
  const logs = logsResp.data || []
  ok('已发货订单有 3 条日志（下单/付款/发货）', logs.length === 3, `实得 ${logs.length}`)
  ok('日志按时间倒序', logs.length >= 2 && Date.parse(logs[0].time) >= Date.parse(logs[logs.length - 1].time))
  const shipLog = logs.find((l) => l.action === 'ship')
  // 契约：from/to 是**可选**字段 —— create 这类「凭空起头」的动作没有 from，
  // 后端配了 NON_NULL，null 会被整个键省掉。所以只对有前置状态的动作断言。
  ok('日志用 from/to 命名（前端 OrderLog 契约）', 'from' in shipLog && 'to' in shipLog, `keys=${Object.keys(shipLog).join(',')}`)
  ok(
    'create 日志无 from（可选字段，不输出 null）',
    !logs[logs.length - 1] || !('from' in logs[logs.length - 1]),
    `create.keys=${Object.keys(logs[logs.length - 1] || {}).join(',')}`
  )
  ok(
    '发货日志的 from→to 是状态机合法边',
    shipLog?.from === 'pending_ship' && shipLog?.to === 'shipped',
    `${shipLog?.from} → ${shipLog?.to}`
  )
  ok('日志带 operator / operatorRole', !!shipLog?.operator && shipLog?.operatorRole === 'seller', `${shipLog?.operator}/${shipLog?.operatorRole}`)

  // 越权：别人的订单日志不该给看
  const otherLogs = await req('GET', `/orders/${shipped.id}/logs`, { token: tokens.wangwu })
  ok('无关用户读不到该订单日志', otherLogs.code !== 0, `code=${otherLogs.code}`)

  // 后台统计：7 个状态键齐全且与播种数一致
  const stats = await req('GET', '/admin/orders/stats', { token: tokens.admin })
  ok('后台订单统计可用', stats.code === 0, `code=${stats.code}`)
  const byStatus = stats.data?.byStatus
  ok('byStatus 含 7 个状态键', byStatus && Object.keys(byStatus).length === 7, `keys=${Object.keys(byStatus || {}).join(',')}`)
  if (byStatus) {
    // 只做「≥ 种子数」的下界断言：库里可能还有联调遗留单，写死相等会假失败
    const short = Object.entries(expectedByStatus).filter(([k, v]) => (byStatus[k] ?? 0) < v)
    ok('byStatus 各状态计数 ≥ 种子数', short.length === 0, short.length ? JSON.stringify(short) : '全部满足')
    const sum = Object.values(byStatus).reduce((a, b) => a + b, 0)
    ok('byStatus 之和 == 订单总数（无状态被漏统计）', sum === stats.data?.total, `${sum} vs ${stats.data?.total}`)
  }

  // 种子单自身的状态分布必须与脚本设计一致（覆盖 7 种状态，一条不漏）
  const dist = {}
  for (const o of seededOnly(allList)) dist[o.status] = (dist[o.status] || 0) + 1
  const distOk = Object.keys(expectedByStatus).every((k) => (dist[k] || 0) === expectedByStatus[k])
  ok('9 笔种子单覆盖全部 7 种状态且分布正确', distOk, JSON.stringify(dist))

  /* ---------------------------------------------------------------
   * D. 私信会话种子数据
   * --------------------------------------------------------------- */
  section('D. 私信会话种子数据')
  const wwSessions = await req('GET', '/messages/sessions', { token: tokens.wangwu })
  ok('会话列表可用', wwSessions.code === 0 && Array.isArray(wwSessions.data), `code=${wwSessions.code}`)
  const sess = wwSessions.data || []
  // 用户 6 参与：s_4_5_6(5↔6) / s_14_4_6(4↔6) / s_10_5_6(5↔6) / s_0_1_6(1↔6)
  ok('wangwu 看到自己参与的 4 个会话', sess.length === 4, `实得 ${sess.length}：${sess.map((s) => s.id).join(',')}`)
  // 不该出现与他无关的会话
  ok(
    '不含他人会话',
    sess.every((s) => ['s_4_5_6', 's_14_4_6', 's_10_5_6', 's_0_1_6'].includes(s.id)),
    sess.map((s) => s.id).join(',')
  )
  const s456 = sess.find((s) => s.id === 's_4_5_6')
  ok('会话 id 规则正确（s_{goodsId}_{min}_{max}）', !!s456, `ids=${sess.map((s) => s.id).join(',')}`)
  ok('会话带对方昵称/头像', !!s456?.peerName && !!s456?.peerAvatar, `${s456?.peerName}`)
  ok('会话关联到商品（goodsId/goodsTitle/goodsCover）', s456?.goodsId === 4 && !!s456?.goodsTitle, `goodsId=${s456?.goodsId} title=${s456?.goodsTitle}`)
  ok('会话带最后一条消息与时间', !!s456?.lastMessage && !!s456?.lastTime, `${s456?.lastMessage}`)
  ok(
    '未读条数只统计发给我的（to_user_id=6）',
    typeof s456?.unread === 'number' && s456.unread >= 0 && s456.unread <= 2,
    `unread=${s456?.unread}`
  )

  const platformSess = sess.find((s) => s.id === 's_0_1_6')
  ok('平台警告会话存在', !!platformSess, `id=${platformSess?.id}`)
  ok('平台会话 goodsId 解析为 0 且商品字段为 null（LEFT JOIN 落空分支）', platformSess?.goodsTitle == null, `goodsTitle=${platformSess?.goodsTitle}`)

  const unread = await req('GET', '/messages/unread', { token: tokens.wangwu })
  ok('未读总数接口可用', unread.code === 0 && typeof unread.data === 'number', `unread=${unread.data}`)
  const unreadSum = sess.reduce((a, s) => a + (s.unread || 0), 0)
  ok('未读总数 = 各会话未读之和', unread.data === unreadSum, `${unread.data} vs ${unreadSum}`)

  const msgs = await req('GET', '/messages/sessions/s_4_5_6', { token: tokens.wangwu })
  ok('会话消息接口可用', msgs.code === 0 && Array.isArray(msgs.data), `code=${msgs.code}`)
  const list = msgs.data || []
  ok('该会话 3 条消息', list.length === 3, `实得 ${list.length}`)
  ok('消息按时间正序（聊天记录顺序）', list.length >= 2 && Date.parse(list[0].createTime) <= Date.parse(list[list.length - 1].createTime))
  ok('消息带 fromUserId/toUserId/content/read', typeof list[0]?.content === 'string' && typeof list[0]?.read === 'boolean', `read=${list[0]?.read}`)

  // 拉取即已读（MessageService.fetchMessages 会 markRead）。
  // 断言方式刻意写成「差值」而不是固定值：脚本可重复执行，
  // 上一次跑完未读已经被消费掉了，写死 1 会在第二次运行时假失败。
  const sBefore = s456?.unread ?? 0
  const unreadAfter = await req('GET', '/messages/unread', { token: tokens.wangwu })
  ok(
    '拉取会话后未读按该会话条数递减（拉取即已读）',
    unreadAfter.data === unread.data - sBefore,
    `${unread.data} - ${sBefore} = ${unreadAfter.data}`
  )
  ok('该会话未读已清零', (await req('GET', '/messages/sessions', { token: tokens.wangwu })).data.find((s) => s.id === 's_4_5_6')?.unread === 0)

  /* 会话越权：会话 id 可被猜到（商品 id + 用户 id 都是小整数），
     只按 session_id 查 = 换一个 id 就能读别人的聊天记录。 */
  const otherSession = await req('GET', '/messages/sessions/s_15_4_5', { token: tokens.wangwu })
  ok(
    'wangwu 读不到与自己无关的会话（s_15_4_5 是 4↔5 的对话）',
    (otherSession.data?.length ?? 0) === 0,
    `code=${otherSession.code} n=${otherSession.data?.length}`
  )
  // 但真正的参与者必须读得到，别修过头
  const mineSession = await req('GET', '/messages/sessions/s_15_4_5', { token: tokens.lisi })
  ok('会话真正的参与者仍可读（lisi 读 s_15_4_5）', mineSession.data?.length === 3, `n=${mineSession.data?.length}`)
  const platformRead = await req('GET', '/messages/sessions/s_0_1_6', { token: tokens.wangwu })
  ok('平台警告会话对收件人可读', platformRead.data?.length === 1, `n=${platformRead.data?.length}`)

  /* ---------------------------------------------------------------
   * 汇总
   * --------------------------------------------------------------- */
  console.log(`\n${'='.repeat(60)}`)
  console.log(`结果: \x1b[32m${pass} PASS\x1b[0m / \x1b[31m${fail} FAIL\x1b[0m  共 ${pass + fail} 项`)
  if (fail) {
    console.log('\n失败项：')
    failures.forEach((f) => console.log(`  · ${f}`))
  }
  console.log('='.repeat(60))
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('\n脚本异常:', e.message)
  process.exit(2)
})
