/**
 * 参数校验回归探针（第二轮）
 *
 * ★ 目的 ★
 * 第一轮 audit-overflow.mjs 找出了 23 处「数据库约束当校验器」的 500 缺陷。
 * 本轮在补完 Service 层校验之后重跑同一批场景，并补上第一轮因**前置条件不满足**
 * 而没测到的用例（商品审核被「不在待审核状态」挡住、举报 measure 因 action=reject
 * 被短路、活动 theme 走白名单收敛）。
 *
 * 判定口径：
 *   code 1001 / 1002 / 403 / 404 → ✅ PASS（友好拒绝，说明校验生效）
 *   code 0                       → ⚠️ ACCEPTED（需人工判断是否该拒）
 *   code 500                     → ❌ STILL_DEFECT（仍然撞库变成内部错误）
 *
 * 副作用：只创建 1 条探针举报（末尾打印 id，跑完按 id 删除），
 * 其余用例的输入都是「校验阶段就会被拒」的非法值，不会落库。
 *
 * 用法：node .workbuddy/audit-overflow2.mjs
 */
const BASE = 'http://localhost:8080/api'

const rows = []
const created = { reportIds: [], addressIds: [], userIds: [] }

async function call(method, path, { token, body } = {}) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers['Authorization'] = 'Bearer ' + token
  try {
    const res = await fetch(BASE + path, {
      method, headers, body: body !== undefined ? JSON.stringify(body) : undefined
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* 非 JSON */ }
    return { status: res.status, json, text }
  } catch (e) {
    return { status: 0, json: null, text: String(e) }
  }
}

function record(name, col, expect, r) {
  const code = r.json?.code
  let verdict
  if (code === 500) verdict = 'STILL_DEFECT'
  else if (code === 0) verdict = 'ACCEPTED'
  else if (code === undefined) verdict = 'NON_JSON'
  else verdict = 'PASS'
  rows.push({ name, col, expect, code, msg: r.json?.message ?? r.text?.slice(0, 70), verdict })
}

const long = (n) => 'x'.repeat(n)

// ------------------------------------------------------------------
const adminLogin = await call('POST', '/user/login', { body: { username: 'admin', password: 'admin123' } })
const admin = adminLogin.json?.data?.token
const userLogin = await call('POST', '/user/login', { body: { username: 'zhangsan', password: '123456' } })
const user = userLogin.json?.data?.token
if (!admin || !user) {
  console.error('登录失败', JSON.stringify(adminLogin.json))
  process.exit(1)
}

const pending = await call('GET', '/review/goods/pending?page=1&pageSize=5', { token: admin })
const pendingGoodsId = pending.json?.data?.list?.[0]?.id
const goodsList = await call('GET', '/goods?page=1&pageSize=3')
const goodsId = goodsList.json?.data?.list?.[0]?.id ?? 1
const notices = await call('GET', '/notices')
const noticeId = notices.json?.data?.[0]?.id
const cats = await call('GET', '/categories')
const categoryId = cats.json?.data?.[0]?.id
const orders = await call('GET', '/admin/orders?page=1&pageSize=5', { token: admin })
const orderId = orders.json?.data?.list?.[0]?.id

console.log(`样本：goodsId=${goodsId} pendingGoodsId=${pendingGoodsId ?? '(无)'} orderId=${orderId}`)
console.log(`本轮断言 ${'—'} 共 ${rows.length} 项（见下）\n`)

// ------------------------------------------------------------------
// 1. 商品审核（第一轮被「不在待审核状态」挡住，本轮取真实 pending 商品）
if (pendingGoodsId) {
  const r1 = await call('POST', `/review/goods/${pendingGoodsId}/review`, {
    token: admin, body: { action: 'reject', reason: long(600) }
  })
  record('商品审核 reject 理由 600 字', 't_goods_audit_record.reason varchar(500)', '1001', r1)

  const r2 = await call('POST', `/review/goods/${pendingGoodsId}/review`, {
    token: admin, body: { action: '不存在的动作' }
  })
  record('商品审核 action 非法枚举', 't_goods.status 状态机', '1001', r2)

  const r3 = await call('POST', `/review/goods/${pendingGoodsId}/review`, {
    token: admin, body: { action: 'reject', reason: '太短' }
  })
  record('商品审核 理由 <5 字（原有下限）', 't_goods_audit_record.reason', '1001', r3)
} else {
  rows.push({ name: '商品审核（无 pending 商品，跳过）', col: '-', expect: '-', code: '-', msg: '跳过的用例不计入统计', verdict: 'SKIP' })
}

// ------------------------------------------------------------------
// 2. 举报处理：新建一条探针举报，用它把 action / measure / remark 三条路径都走一遍
{
  const create = await call('POST', '/reports', {
    token: user, body: { type: 'goods', targetId: goodsId, reason: '校验回归探针', description: '跑完即删' }
  })
  const list = await call('GET', '/admin/reports?page=1&pageSize=1', { token: admin })
  const rid = list.json?.data?.list?.[0]?.id
  if (rid) created.reportIds.push(rid)

  if (rid) {
    // 处置措施超长（varchar(20)）—— action 用 handle，避免被 reject 短路成 none
    const r1 = await call('POST', `/admin/reports/${rid}/resolve`, {
      token: admin, body: { action: 'handle', measure: long(30) }
    })
    record('举报处置 measure 30 字', 't_report.measure varchar(20)', '1001', r1)

    const r2 = await call('POST', `/admin/reports/${rid}/resolve`, {
      token: admin, body: { action: 'handle', measure: '不存在的措施' }
    })
    record('举报处置 measure 非法枚举', 't_report.measure 枚举', '1001', r2)

    // ★ 这条最关键：修复前 action 非法会被当成「举报成立」，默认 measure=warn 静默扣信用分
    const r3 = await call('POST', `/admin/reports/${rid}/resolve`, {
      token: admin, body: { action: '不存在的动作' }
    })
    record('举报处置 action 非法枚举（扣分风险）', 't_report.status / 信用分', '1001', r3)

    const r4 = await call('POST', `/admin/reports/${rid}/resolve`, {
      token: admin, body: { action: 'handle', measure: 'warn', remark: long(600) }
    })
    record('举报处置 remark 600 字', 't_report.remark varchar(500)', '1001', r4)

    // 合法收尾：把探针举报正常驳回（避免留一条 pending 干扰举报台统计）
    const r5 = await call('POST', `/admin/reports/${rid}/resolve`, {
      token: admin, body: { action: 'reject', remark: '探针收尾' }
    })
    record('举报处置 合法驳回（应成功）', 't_report.status', '0', r5)
  } else {
    rows.push({ name: '举报处置（未取到探针举报 id）', col: '-', expect: '-', code: '-', msg: '跳过', verdict: 'SKIP' })
  }
  void create
}

// ------------------------------------------------------------------
// 3. 收货地址（含第一轮暴露的「手机号格式无校验」）
{
  const base = { receiver: '张三', phone: '13800138000', region: '北京市海淀区', detail: '某大学 1 号楼', tag: '宿舍' }
  const cases = [
    ['地址 receiver 80 字', { receiver: long(80) }, 't_address.receiver varchar(50)'],
    ['地址 phone 30 字', { phone: long(30) }, 't_address.phone varchar(20)'],
    ['地址 region 300 字', { region: long(300) }, 't_address.region varchar(200)'],
    ['地址 detail 700 字', { detail: long(700) }, 't_address.detail varchar(500)'],
    ['地址 tag 30 字', { tag: long(30) }, 't_address.tag varchar(20)'],
    ['地址 phone 非数字格式', { phone: 'abcdefghijk' }, 't_address.phone 格式'],
    ['地址 receiver 为空', { receiver: '  ' }, 't_address.receiver NOT NULL']
  ]
  for (const [name, patch, col] of cases) {
    const r = await call('POST', '/user/addresses', { token: user, body: { ...base, ...patch } })
    record(name, col, '1001', r)
    if (r.json?.code === 0 && r.json?.data?.id) created.addressIds.push(r.json.data.id)
  }
}

// ------------------------------------------------------------------
// 4. 公告 / 分类 / 注册 / 后台订单备注 / 活动 / 设置（同第一轮，验证已收敛为 1001）
{
  const r = await call('POST', '/admin/notices', { token: admin, body: { title: long(300), content: '探针' } })
  record('公告 title 300 字', 't_notice.title varchar(200)', '1001', r)
}
if (noticeId) {
  const r = await call('PATCH', `/admin/notices/${noticeId}`, { token: admin, body: { title: long(300) } })
  record('公告 title 300 字（改已有）', 't_notice.title varchar(200)', '1001', r)
}
{
  const r = await call('POST', '/admin/categories', { token: admin, body: { name: long(80), icon: '📦' } })
  record('分类 name 80 字', 't_category.name varchar(50)', '1001', r)
}
{
  const r = await call('POST', '/admin/categories', { token: admin, body: { name: '探针分类', icon: long(30) } })
  record('分类 icon 30 字', 't_category.icon varchar(20)', '1001', r)
}
{
  const r = await call('POST', '/user/register', {
    body: { username: long(80), password: '123456', nickname: '探针' }
  })
  record('注册 username 80 字', 't_user.username varchar(50)', '1001', r)
}
{
  const r = await call('POST', '/user/register', {
    body: { username: 'probe' + Date.now(), password: '123456', nickname: long(80) }
  })
  record('注册 nickname 80 字', 't_user.nickname varchar(50)', '1001', r)
}
if (orderId) {
  const r = await call('PATCH', `/admin/orders/${orderId}/note`, { token: admin, body: { note: long(600) } })
  record('后台订单备注 600 字', 't_order.admin_note varchar(500)', '1001', r)
}
{
  const base = {
    id: 'probe-activity-tmp2', title: '探针活动', subtitle: '副标题', ctaText: '去看看',
    ctaLink: '/goods', icon: 'gift', theme: 'orange', note: '备注', durationDays: 7, enabled: true,
    highlights: ['亮点'], claims: [{ categoryId: 1, rate: 0.9 }]
  }
  const cases = [
    ['活动 title 150 字', { title: long(150) }, 't_activity.title varchar(100)'],
    ['活动 subtitle 300 字', { subtitle: long(300) }, 't_activity.subtitle varchar(200)'],
    ['活动 ctaText 80 字', { ctaText: long(80) }, 't_activity.cta_text varchar(50)'],
    ['活动 ctaLink 300 字', { ctaLink: long(300) }, 't_activity.cta_link varchar(200)'],
    ['活动 note 700 字', { note: long(700) }, 't_activity.note varchar(500)'],
    ['活动 durationDays 999999', { durationDays: 999999 }, 't_activity.duration_days']
  ]
  for (const [name, patch, col] of cases) {
    const r = await call('POST', '/admin/activities', { token: admin, body: { ...base, ...patch } })
    record(name, col, '1001', r)
  }
}
{
  const cases = [
    ['设置 siteName 150 字', { siteName: long(150) }, 't_settings.site_name varchar(100)'],
    ['设置 servicePhone 50 字', { servicePhone: long(50) }, 't_settings.service_phone varchar(30)'],
    ['设置 announceText 700 字', { announceText: long(700) }, 't_settings.announce_text varchar(500)'],
    ['设置 commissionRate 99', { commissionRate: 99 }, 't_settings.commission_rate decimal(5,4)'],
    ['设置 maxPublishPerDay 负数', { maxPublishPerDay: -5 }, 't_settings.max_publish_per_day'],
    ['设置 autoOfflineDays 负数', { autoOfflineDays: -1 }, 't_settings.auto_offline_days']
  ]
  for (const [name, patch, col] of cases) {
    const r = await call('PATCH', '/admin/settings', { token: admin, body: patch })
    record(name, col, '1001', r)
  }
}

// ------------------------------------------------------------------
// 5. 评价 / 留言 / 私信 / 平台警告（TEXT 列的业务上限）
{
  const r = await call('POST', `/goods/${goodsId}/comments`, { token: user, body: { content: long(2500) } })
  record('留言 content 2500 字', 't_comment.content TEXT 上限', '1001', r)
}
{
  const r = await call('POST', '/reviews', {
    token: user, body: { orderId: orderId, rating: 5, content: long(2500) }
  })
  record('评价 content 2500 字', 't_review.content TEXT 上限', '1001', r)
}
{
  const r = await call('POST', '/admin/users/5/warn', { token: admin, body: { reason: long(2000) } })
  record('平台警告 2000 字', 't_message.content TEXT 上限', '1001', r)
}

// ------------------------------------------------------------------
console.log('================ 结果 ================')
const w = (s, n) => String(s ?? '').padEnd(n).slice(0, n)
console.log(`${w('用例', 30)} ${w('目标列', 34)} ${w('期望', 6)} ${w('code', 6)} ${w('判定', 13)} 消息`)
for (const r of rows) {
  console.log(`${w(r.name, 30)} ${w(r.col, 34)} ${w(r.expect, 6)} ${w(r.code, 6)} ${w(r.verdict, 13)} ${r.msg}`)
}

const skip = rows.filter((r) => r.verdict === 'SKIP')
const pass = rows.filter((r) => r.verdict === 'PASS')
const defect = rows.filter((r) => r.verdict === 'STILL_DEFECT')
const acc = rows.filter((r) => r.verdict === 'ACCEPTED')
const njson = rows.filter((r) => r.verdict === 'NON_JSON')
console.log(`\n合计 ${rows.length} 项：PASS ${pass.length} / STILL_DEFECT ${defect.length} / ACCEPTED ${acc.length} / 非JSON ${njson.length} / 跳过 ${skip.length}`)
if (defect.length) {
  console.log('\n❌ 仍会变成 500 的用例：')
  defect.forEach((r) => console.log(`   - ${r.name} → ${r.col} :: ${r.msg}`))
}
if (acc.length) {
  console.log('\n⚠️ 意外成功（需人工判断是否该拒）：')
  acc.forEach((r) => console.log(`   - ${r.name} :: ${r.msg}`))
}
console.log('\n本轮产生的数据 id（需按精确 id 清理）：')
console.log('  ' + JSON.stringify(created))
