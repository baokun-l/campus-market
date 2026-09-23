/**
 * 限时活动模块端到端探针（09-18 新增模块的验收脚本）
 *
 * 覆盖四块：
 *   A. 读接口：/activities、/activities/active、/activities/current（结构、排序、幂等补种）
 *   B. 权限：游客 401 / 普通用户可读但不可写 / goods_admin 也不可写（仅 admin）
 *   C. 写接口：新建 / 编辑 / 上下架 / 删除 + 审计日志留痕
 *   D. 让利价与资金归属由**服务端**算：
 *        发布时客户端谎报 promoPrice 必须被丢弃；
 *        下单时 platform 补贴的差价不能算到卖家头上（sellerCut=0、sellerIncome=挂牌价）
 *
 * 用法：后端跑在 8080，然后  node .workbuddy/e2e-activities.mjs
 * 清理：脚本会打印它创建的订单号（订单没有删除接口），跑完用 mysql 按**精确单号**删除。
 */
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8080/api'

let pass = 0
let fail = 0
const lines = []
const createdOrders = []

function ok(name, cond, extra = '') {
  // 立刻打印：脚本中途抛错时，前面已跑完的结论不会跟着丢掉（第一次跑就吃了这个亏）
  if (cond) { pass++; lines.push(`  [PASS] ${name}${extra ? ' :: ' + extra : ''}`) }
  else { fail++; lines.push(`  [FAIL] ${name}${extra ? ' :: ' + extra : ''}`) }
  console.log(lines[lines.length - 1])
}
const section = (t) => { lines.push(`\n### ${t}`); console.log(`\n### ${t}`) }

/*
 * 两个本项目的约定，写断言时必须照顾到：
 *
 * ① 鉴权失败走 `AuthInterceptor.reject()` → **HTTP 恒为 200**，状态放在响应体的 `code` 里
 *    （401 / 403）。所以判「被拦下」要看 body.code，不能只看 res.status。
 * ② `spring.jackson.default-property-inclusion: non_null` → **null 字段不出现在 JSON 里**。
 *    于是「值为 null」在客户端表现为「键不存在」（`undefined`）。
 *    前端也正是靠这一点判断「未参与活动」（`promoPrice !== undefined`），
 *    所以探针里 null 与 undefined 必须视作同一件事，别把 `=== null` 写成硬断言。
 */
const denied = (r, code) => r.json?.code === code || r.status === code
const isBlank = (v) => v === null || v === undefined

async function call(method, path, { token, body } = {}) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers['Authorization'] = 'Bearer ' + token
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON（例如 401 的 HTML） */ }
  return { status: res.status, json, text }
}

async function login(username, password) {
  const r = await call('POST', '/user/login', { body: { username, password } })
  return r.json?.data?.token ?? null
}

const admin = await login('admin', 'admin123')
const zhangsan = await login('zhangsan', '123456')
const lisi = await login('lisi', '123456')
const goodsAdmin = await login('goods_admin', 'goods123456')
ok('前置：4 个账号登录成功', !!(admin && zhangsan && lisi && goodsAdmin))

/**
 * 清掉上一次没跑完留下的探针活动 —— 让本脚本**可重复执行**。
 * 探针只认标题里带「探针」的活动，绝不会误删出厂活动或管理员真建的活动。
 */
async function cleanupProbeActivities() {
  const r = await call('GET', '/activities', { token: admin })
  const leftovers = (r.json?.data ?? []).filter((x) => String(x.config.title ?? '').includes('探针'))
  for (const x of leftovers) await call('DELETE', `/admin/activities/${x.config.id}`, { token: admin })
  return leftovers.length
}
const cleaned = await cleanupProbeActivities()
ok('前置：清理历史探针活动（脚本可重复执行）', true, `清理 ${cleaned} 条`)

/**
 * 让商品走**审核通过**上架。
 * `pending → on_sale` 只能由审核动作完成（`POST /review/goods/{id}/review`，
 * action=approve，需 admin 或 goods_admin）；直接 PATCH 状态会被状态机拦下。
 */
async function approveGoods(goodsId) {
  const r = await call('POST', `/review/goods/${goodsId}/review`, {
    token: admin, body: { action: 'approve' }
  })
  return r.json?.code === 0
}

/* ==================== A. 读接口 ==================== */
section('A. 读接口结构与排序')

const all = await call('GET', '/activities', { token: admin })
ok('GET /activities 返回 code=0', all.json?.code === 0, `code=${all.json?.code}`)
const list = all.json?.data ?? []
ok('空表时惰性补种出厂活动（≥4 条）', Array.isArray(list) && list.length >= 4, `len=${list.length}`)

const d0 = list[0]
ok('元素结构 = {config,state,expiresAt,remainingMs,shouldShow}',
  d0 && d0.config && typeof d0.state === 'string' && typeof d0.expiresAt === 'number'
  && typeof d0.remainingMs === 'number' && typeof d0.shouldShow === 'boolean',
  d0 ? `keys=${Object.keys(d0).join(',')}` : 'data 为空')
ok('config.highlights 是数组（JSON 列）', Array.isArray(d0?.config?.highlights),
  `typeof=${typeof d0?.config?.highlights}`)
ok('config.claims 是数组且元素含 categoryId/rate',
  Array.isArray(d0?.config?.claims) && d0.config.claims.every((c) => 'categoryId' in c && 'rate' in c),
  JSON.stringify(d0?.config?.claims))
ok('config.startAt 是毫秒时间戳（number）', typeof d0?.config?.startAt === 'number',
  `typeof=${typeof d0?.config?.startAt}`)
ok('state 取值在 pending/active/expired/cancelled 内',
  list.every((x) => ['pending', 'active', 'expired', 'cancelled'].includes(x.state)),
  [...new Set(list.map((x) => x.state))].join(','))

const priorities = list.map((x) => x.config.priority)
ok('按优先级降序返回', priorities.every((p, i) => i === 0 || priorities[i - 1] >= p),
  priorities.join('>='))

const again = await call('GET', '/activities', { token: admin })
ok('重复读取不会重复补种（幂等）', (again.json?.data ?? []).length === list.length,
  `${list.length} → ${(again.json?.data ?? []).length}`)

const activeOnly = await call('GET', '/activities/active', { token: admin })
const act = activeOnly.json?.data ?? []
ok('GET /activities/active 只含 active/pending',
  act.every((x) => x.state === 'active' || x.state === 'pending'),
  [...new Set(act.map((x) => x.state))].join(','))
const firstPending = act.findIndex((x) => x.state === 'pending')
ok('active 全部排在 pending 之前',
  firstPending === -1 || act.slice(firstPending).every((x) => x.state === 'pending'))

const cur = await call('GET', '/activities/current', { token: admin })
ok('GET /activities/current 返回单个展示模型',
  cur.json?.code === 0 && !!cur.json.data?.config?.id,
  `id=${cur.json?.data?.config?.id} state=${cur.json?.data?.state}`)
ok('主推优先取进行中的活动',
  act.some((x) => x.state === 'active') ? cur.json?.data?.state === 'active' : true,
  `state=${cur.json?.data?.state}`)

/* ==================== B. 权限 ==================== */
section('B. 访问控制')

const guest = await call('GET', '/activities')
ok('游客读活动列表 → 401（需登录）', denied(guest, 401), `http=${guest.status} code=${guest.json?.code}`)

const userRead = await call('GET', '/activities/active', { token: zhangsan })
ok('普通用户可读（前台要用）', userRead.json?.code === 0, `code=${userRead.json?.code}`)

const userWrite = await call('POST', '/admin/activities', {
  token: zhangsan, body: { title: '越权活动', durationDays: 3 }
})
ok('普通用户写活动 → 403', denied(userWrite, 403),
  `http=${userWrite.status} code=${userWrite.json?.code}`)

const goodsAdminWrite = await call('POST', '/admin/activities', {
  token: goodsAdmin, body: { title: '审核员越权活动', durationDays: 3 }
})
ok('goods_admin 写活动 → 403（角色分区互斥）', denied(goodsAdminWrite, 403),
  `http=${goodsAdminWrite.status} code=${goodsAdminWrite.json?.code}`)

/* ==================== C. 写接口 ==================== */
section('C. 管理员写接口')

// 平台补贴活动：声明「分类 5（生活）8 折」，用于验证 fundSource=platform 的拆分
const created = await call('POST', '/admin/activities', {
  token: admin,
  body: {
    title: '【探针】平台补贴活动',
    subtitle: '自动化验收用，跑完即删',
    ctaText: '去看看',
    ctaLink: '/goods?categoryId=5',
    highlights: ['平台补贴', '卖家实收不变'],
    icon: '🧪',
    theme: 'blue',
    priority: 5,
    durationDays: 5,
    fundSource: 'platform',
    claims: [{ categoryId: 5, rate: 0.8 }],
    note: 'e2e 探针'
  }
})
const probeAct = created.json?.data
ok('POST /admin/activities 新建成功', created.json?.code === 0 && !!probeAct?.id,
  `id=${probeAct?.id} code=${created.json?.code}`)
ok('新建未传 startAt → 从此刻开始（不是 0）',
  typeof probeAct?.startAt === 'number' && probeAct.startAt > 0, `startAt=${probeAct?.startAt}`)
ok('claims 落库后仍是数组', Array.isArray(probeAct?.claims) && probeAct.claims[0]?.categoryId === 5,
  JSON.stringify(probeAct?.claims))

const afterCreate = await call('GET', '/activities/active', { token: admin })
const hit = (afterCreate.json?.data ?? []).find((x) => x.config.id === probeAct.id)
ok('新活动立刻出现在前台列表且 state=active', hit?.state === 'active', `state=${hit?.state}`)

const patched = await call('PATCH', `/admin/activities/${probeAct.id}`, {
  token: admin, body: { title: '【探针】平台补贴活动（已改）', priority: 6 }
})
ok('PATCH 局部更新生效', patched.json?.data?.title === '【探针】平台补贴活动（已改）',
  `title=${patched.json?.data?.title}`)
ok('未传的字段保持原值（fundSource 未被重置）', patched.json?.data?.fundSource === 'platform',
  `fundSource=${patched.json?.data?.fundSource}`)

// 非法让利声明必须被挡在入口：rate=1.5 会让「让利价」比挂牌价还高
const badClaims = await call('PATCH', `/admin/activities/${probeAct.id}`, {
  token: admin, body: { claims: [{ categoryId: 5, rate: 1.5 }, { categoryId: 2, rate: 0.8 }] }
})
ok('越界 rate（≥1）被过滤，只留合法声明',
  (badClaims.json?.data?.claims ?? []).length === 1 && badClaims.json?.data?.claims[0].categoryId === 2,
  JSON.stringify(badClaims.json?.data?.claims))
// 还原声明，供 D 段使用
await call('PATCH', `/admin/activities/${probeAct.id}`, {
  token: admin, body: { claims: [{ categoryId: 5, rate: 0.8 }] }
})

const off = await call('POST', `/admin/activities/${probeAct.id}/enabled`, { token: admin, body: { enabled: false } })
ok('下架后 state=cancelled', off.json?.data?.enabled === false, `enabled=${off.json?.data?.enabled}`)
const afterOff = await call('GET', '/activities', { token: admin })
const offRow = (afterOff.json?.data ?? []).find((x) => x.config.id === probeAct.id)
ok('下架的活动 state=cancelled 且不再该展示', offRow?.state === 'cancelled' && offRow?.shouldShow === false,
  `state=${offRow?.state} shouldShow=${offRow?.shouldShow}`)
ok('下架记录带时间与操作人', typeof offRow?.config?.cancelledAt === 'number' && !!offRow?.config?.cancelledBy,
  `cancelledAt=${offRow?.config?.cancelledAt} by=${offRow?.config?.cancelledBy}`)

const on = await call('POST', `/admin/activities/${probeAct.id}/enabled`, { token: admin, body: { enabled: true } })
ok('重新上架后回到 active 且清掉下架记录',
  on.json?.data?.enabled === true && isBlank(on.json?.data?.cancelledAt),
  `enabled=${on.json?.data?.enabled} cancelledAt=${on.json?.data?.cancelledAt}（null 字段按 non_null 被省略）`)

const logs = await call('GET', '/admin/audit-logs?page=1&pageSize=50', { token: admin })
const logRows = logs.json?.data?.list ?? []
const activityLogs = logRows.filter((l) => String(l.action).startsWith('activity.'))
ok('活动写操作全部落审计日志', activityLogs.length >= 3,
  activityLogs.slice(0, 5).map((l) => l.action).join(','))

/* ==================== D. 让利价与资金归属 ==================== */
section('D. 让利价 / 资金归属由服务端算')

/*
 * 服务端算法（与前端 utils/promo.ts 同规则）：
 *   阶梯 = [声明值, +0.05, +0.1]；取档下标 = floor(挂牌价) % 阶梯长度
 *   让利价 = floor(挂牌价 × 取档率)，下限 1
 * 案例一：200 元 / 声明 0.8 → 阶梯 [0.8,0.85,0.9]，200 % 3 = 2 → 0.9 → 180
 */
const goodsBody = (title, activityId, categoryId = 5) => ({
  title, price: 200, stock: 2, deliveryMethod: 'face', categoryId,
  location: '探针教学楼', description: 'e2e 探针商品',
  activityId, promoPrice: 1 // ← 客户端故意谎报：必须被丢弃
})

const g1 = await call('POST', '/goods', { token: zhangsan, body: goodsBody('【探针】平台补贴商品', probeAct.id) })
const goods1 = g1.json?.data
ok('发布商品成功（卖家 zhangsan）', g1.json?.code === 0 && !!goods1?.id,
  `id=${goods1?.id} code=${g1.json?.code} http=${g1.status} resp=${g1.text?.slice(0, 200)}`)
ok('客户端谎报的 promoPrice=1 被丢弃，按活动声明算出 180',
  Number(goods1?.promoPrice) === 180, `promoPrice=${goods1?.promoPrice}`)
ok('activityId 被服务端回填（认的是活动声明）', goods1?.activityId === probeAct.id,
  `activityId=${goods1?.activityId}`)
if (!goods1?.id) {
  console.log('\n⚠️ 发布失败，后续下单相关的断言无法继续（见上面的响应体）')
  console.log(`\n==== 探针结果：PASS ${pass} / FAIL ${fail} ====`)
  process.exit(1)
}

const g2 = await call('POST', '/goods', {
  token: zhangsan, body: { title: '【探针】无活动商品', price: 100, stock: 1, deliveryMethod: 'face', categoryId: 5, promoPrice: 1 }
})
const goods2 = g2.json?.data
ok('没报名活动时，就算传了 promoPrice 也是 null', isBlank(goods2?.promoPrice) && isBlank(goods2?.activityId),
  `promoPrice=${goods2?.promoPrice} activityId=${goods2?.activityId}`)

const g3 = await call('POST', '/goods', {
  token: zhangsan, body: goodsBody('【探针】幽灵活动商品', 'ghost-activity-does-not-exist')
})
const goods3 = g3.json?.data
ok('活动不存在时按挂牌价落库（静默降级，不写脏让利价）',
  g3.json?.code === 0 && isBlank(goods3?.promoPrice) && isBlank(goods3?.activityId),
  `promoPrice=${goods3?.promoPrice} activityId=${goods3?.activityId}`)

// 走**审核**流程上架（pending → on_sale 只能由审核动作完成，
// 直接 PATCH 状态会被状态机拦下：「商品还在审核中，通过审核后才可以上架」）
await approveGoods(goods1.id)
const order1 = await call('POST', '/orders', { token: lisi, body: { goodsId: goods1.id, quantity: 1, address: '探针面交点' } })
const o1 = order1.json?.data
if (o1?.id) createdOrders.push(o1.id)
ok('买家下单成功', order1.json?.code === 0 && !!o1?.id,
  `id=${o1?.id} code=${order1.json?.code} msg=${order1.json?.message}`)
ok('订单 fundSource = platform（平台补贴）', o1?.fundSource === 'platform', `fundSource=${o1?.fundSource}`)
ok('平台补贴的差价不算卖家头上：sellerCut=0、sellerIncome=挂牌价',
  Number(o1?.sellerCut) === 0 && Number(o1?.sellerIncome) === 200,
  `sellerCut=${o1?.sellerCut} sellerIncome=${o1?.sellerIncome} listPrice=${o1?.listPrice}`)
ok('平台补贴金额 = 挂牌价 − 实付（200−180=20）',
  Number(o1?.platformSubsidy) === 20 && Number(o1?.amount) === 180,
  `platformSubsidy=${o1?.platformSubsidy} amount=${o1?.amount}`)
ok('订单回填 activityId（可追溯到哪次活动）', o1?.activityId === probeAct.id, `activityId=${o1?.activityId}`)

// 案例二：卖家让利（分类 1 教材 / 声明 0.5 → 阶梯 [0.5,0.55,0.6]，100 % 3 = 1 → 0.55 → 55）
const sellerAct = await call('POST', '/admin/activities', {
  token: admin,
  body: {
    title: '【探针】卖家让利活动', durationDays: 5, priority: 5, fundSource: 'seller',
    claims: [{ categoryId: 1, rate: 0.5 }], ctaLink: '/goods?categoryId=1', theme: 'orange'
  }
})
const sellerActId = sellerAct.json?.data?.id
const g4 = await call('POST', '/goods', {
  token: zhangsan,
  body: { title: '【探针】卖家让利商品', price: 100, stock: 1, deliveryMethod: 'face', categoryId: 1, activityId: sellerActId }
})
const goods4 = g4.json?.data
ok('卖家让利活动：100 元 → 让利价 55', Number(goods4?.promoPrice) === 55, `promoPrice=${goods4?.promoPrice}`)

await approveGoods(goods4.id)
const order2 = await call('POST', '/orders', { token: lisi, body: { goodsId: goods4.id, quantity: 1 } })
const o2 = order2.json?.data
if (o2?.id) createdOrders.push(o2.id)
ok('卖家让利单：sellerCut=45、platformSubsidy=0、卖家实收 55',
  Number(o2?.sellerCut) === 45 && Number(o2?.platformSubsidy) === 0 && Number(o2?.sellerIncome) === 55,
  `sellerCut=${o2?.sellerCut} platformSubsidy=${o2?.platformSubsidy} sellerIncome=${o2?.sellerIncome} msg=${order2.json?.message}`)
ok('卖家让利单 fundSource = seller', o2?.fundSource === 'seller', `fundSource=${o2?.fundSource}`)

// 看板的「平台补贴合计」不再恒为 0
const overview = await call('GET', '/admin/overview', { token: admin })
const ov = overview.json?.data ?? {}
ok('看板 activeActivities 不再是硬编码 0（已接真实统计）',
  typeof ov.activeActivities === 'number' && ov.activeActivities >= 2, `activeActivities=${ov.activeActivities}`)

/* ==================== 清理 ==================== */
section('E. 清理探针数据')
for (const gid of [goods1?.id, goods2?.id, goods3?.id, goods4?.id].filter(Boolean)) {
  const r = await call('DELETE', `/goods/${gid}`, { token: admin })
  ok(`删除探针商品 #${gid}`, r.json?.code === 0, `code=${r.json?.code}`)
}
for (const aid of [probeAct?.id, sellerActId].filter(Boolean)) {
  const r = await call('DELETE', `/admin/activities/${aid}`, { token: admin })
  ok(`删除探针活动 ${aid}`, r.json?.code === 0, `code=${r.json?.code}`)
}
ok('收尾：库中不再残留任何探针活动', (await cleanupProbeActivities()) === 0)

// 每条断言在 ok() 里已实时打印过，这里只收口一行结论（避免整份日志打两遍）
console.log(`\n==== 探针结果：PASS ${pass} / FAIL ${fail} ====`)
if (createdOrders.length) {
  console.log('⚠️ 需要手工清理的订单号（订单无删除接口）：' + createdOrders.join(' '))
}
process.exit(fail === 0 ? 0 : 1)
