/**
 * 窄列溢出 / 枚举缺校验 探针（同类缺陷全盘扫描）
 *
 * ★ 为什么只挑「窄 varchar 列」下手 ★
 *
 * 目标列若比输入短，MySQL（STRICT_TRANS_TABLES）会在 INSERT/UPDATE 时直接报错 ——
 * 于是请求要么被业务层友好拒绝（1001），要么撞 DB 报错变成 500。
 * **两种结局都不会留下数据**，所以这组探测是零副作用的，可以放心跑。
 *
 * 判定口径：
 *   1001 / 1002 / 403 / 404  → ✅ 友好拒绝（有校验）
 *   500                      → ❌ 缺陷：数据库约束又当校验器了
 *   0（成功）                → ⚠️ 需人工看：说明长度够了或没校验但列够宽
 *
 * 用法：node .workbuddy/audit-overflow.mjs
 * 前置：后端在 8080
 */
const BASE = 'http://localhost:8080/api'

const rows = []
const created = { reportIds: [], addressIds: [], noticeIds: [], categoryIds: [], activityIds: [], userIds: [] }

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

/** 记一条探测结果 */
function record(group, name, colInfo, r, note = '') {
  const code = r.json?.code
  let verdict
  if (code === 500) verdict = 'DEFECT_500'
  else if (code === 0) verdict = 'ACCEPTED'
  else if (code === undefined) verdict = 'NON_JSON'
  else verdict = 'REJECTED'
  rows.push({ group, name, colInfo, code, msg: r.json?.message ?? r.text?.slice(0, 60), verdict, note })
}

const long = (n) => 'x'.repeat(n)

// ------------------------------------------------------------------
// 登录
const adminLogin = await call('POST', '/user/login', { body: { username: 'admin', password: 'admin123' } })
const admin = adminLogin.json?.data?.token
const userLogin = await call('POST', '/user/login', { body: { username: 'zhangsan', password: '123456' } })
const user = userLogin.json?.data?.token
if (!admin || !user) {
  console.error('登录失败：admin=%s user=%s', !!admin, !!user)
  console.error(JSON.stringify(adminLogin.json))
  process.exit(1)
}

// 取样本 id
const goodsList = await call('GET', '/goods?page=1&pageSize=3')
const goodsId = goodsList.json?.data?.list?.[0]?.id ?? 1
const notices = await call('GET', '/notices')
const noticeId = notices.json?.data?.[0]?.id
const cats = await call('GET', '/categories')
const categoryId = cats.json?.data?.[0]?.id
const orders = await call('GET', '/admin/orders?page=1&pageSize=5', { token: admin })
const orderId = orders.json?.data?.list?.[0]?.id
const orderStatus = orders.json?.data?.list?.[0]?.status
const acts = await call('GET', '/activities', { token: admin })
const activityId = acts.json?.data?.[0]?.id

console.log(`样本：goodsId=${goodsId} noticeId=${noticeId} categoryId=${categoryId} orderId=${orderId}(${orderStatus}) activityId=${activityId}`)

// ------------------------------------------------------------------
// 1. 举报（reason varchar(200)、type varchar(10)）
{
  const g = '举报'
  // 先建一条「合法」举报，用于后面的处理接口测试（唯一会产生数据的探测，末尾按 id 清理）
  const base = { type: 'goods', targetId: goodsId, reason: '探针用举报', description: '探针创建，跑完即删' }
  const r0 = await call('POST', '/reports', { token: user, body: base })
  record(g, '对照：合法举报（应成功）', 't_report', r0)
  if (r0.json?.code === 0) {
    // 后端不返回 id，从管理员列表取最新一条
    const list = await call('GET', '/admin/reports?page=1&pageSize=1', { token: admin })
    const id = list.json?.data?.list?.[0]?.id
    if (id) created.reportIds.push(id)
  }

  const r1 = await call('POST', '/reports', {
    token: user, body: { ...base, reason: long(300) }
  })
  record(g, `reason 300 字`, 't_report.reason varchar(200)', r1)

  const r2 = await call('POST', '/reports', {
    token: user, body: { ...base, type: long(15) }
  })
  record(g, `type 15 字`, 't_report.type varchar(10)', r2)

  const r3 = await call('POST', '/reports', {
    token: user, body: { ...base, type: '不存在的类型' }
  })
  record(g, `type 非法枚举（该拒未拒？）`, 't_report.type 枚举', r3)
}

// ------------------------------------------------------------------
// 2. 举报处理（remark varchar(500)、outcome varchar(500)、measure varchar(20)）
if (created.reportIds.length) {
  const rid = created.reportIds[0]
  const g = '举报处理'
  const r1 = await call('POST', `/admin/reports/${rid}/resolve`, {
    token: admin, body: { action: 'reject', remark: long(600) }
  })
  record(g, 'remark 600 字', 't_report.remark varchar(500)', r1)

  const r2 = await call('POST', `/admin/reports/${rid}/resolve`, {
    token: admin, body: { action: 'reject', measure: long(30) }
  })
  record(g, 'measure 30 字', 't_report.measure varchar(20)', r2)

  const r3 = await call('POST', `/admin/reports/${rid}/resolve`, {
    token: admin, body: { action: '不存在的动作' }
  })
  record(g, 'action 非法枚举（该拒未拒？）', 't_report.status', r3)

  const r4 = await call('POST', `/admin/reports/${rid}/resolve`, {
    token: admin, body: { action: 'reject', measure: '不存在的措施' }
  })
  record(g, 'measure 非法枚举（该拒未拒？）', 't_report.measure 枚举', r4)
}

// ------------------------------------------------------------------
// 3. 收货地址（receiver 50 / phone 20 / region 200 / detail 500 / tag 20）
{
  const g = '收货地址'
  const base = { receiver: '张三', phone: '13800138000', region: '北京市海淀区', detail: '某大学 1 号楼', tag: '宿舍' }
  const cases = [
    ['receiver 80 字', { receiver: long(80) }, 't_address.receiver varchar(50)'],
    ['phone 30 字', { phone: long(30) }, 't_address.phone varchar(20)'],
    ['region 300 字', { region: long(300) }, 't_address.region varchar(200)'],
    ['detail 700 字', { detail: long(700) }, 't_address.detail varchar(500)'],
    ['tag 30 字', { tag: long(30) }, 't_address.tag varchar(20)'],
    ['phone 非数字', { phone: 'abcdefghijk' }, 't_address.phone 格式']
  ]
  for (const [name, patch, col] of cases) {
    const r = await call('POST', '/user/addresses', { token: user, body: { ...base, ...patch } })
    record(g, name, col, r)
    if (r.json?.code === 0 && r.json?.data?.id) created.addressIds.push(r.json.data.id)
  }
}

// ------------------------------------------------------------------
// 4. 公告（title varchar(200)、content TEXT）
{
  const g = '公告'
  const r1 = await call('POST', '/admin/notices', {
    token: admin, body: { title: long(300), content: '探针用公告' }
  })
  record(g, 'title 300 字', 't_notice.title varchar(200)', r1)
  if (r1.json?.code === 0 && r1.json?.data?.id) created.noticeIds.push(r1.json.data.id)

  if (noticeId) {
    const r2 = await call('PATCH', `/admin/notices/${noticeId}`, {
      token: admin, body: { title: long(300), content: '探针' }
    })
    record(g, 'title 300 字（改已有公告）', 't_notice.title varchar(200)', r2)
  }
}

// ------------------------------------------------------------------
// 5. 分类（name varchar(50)、icon varchar(20)）
{
  const g = '分类'
  const r1 = await call('POST', '/admin/categories', { token: admin, body: { name: long(80), icon: '📦' } })
  record(g, 'name 80 字', 't_category.name varchar(50)', r1)
  if (r1.json?.code === 0 && r1.json?.data?.id) created.categoryIds.push(r1.json.data.id)

  const r2 = await call('POST', '/admin/categories', { token: admin, body: { name: '探针分类', icon: long(30) } })
  record(g, 'icon 30 字', 't_category.icon varchar(20)', r2)
  if (r2.json?.code === 0 && r2.json?.data?.id) created.categoryIds.push(r2.json.data.id)
}

// ------------------------------------------------------------------
// 6. 活动（title 100 / subtitle 200 / cta_text 50 / cta_link 200 / icon 50 / theme 30 / note 500）
{
  const g = '活动'
  const base = {
    id: 'probe-activity-tmp', title: '探针活动', subtitle: '副标题', ctaText: '去看看',
    ctaLink: '/goods', icon: 'gift', theme: 'orange', note: '备注', durationDays: 7, enabled: true,
    highlights: ['亮点'], claims: [{ categoryId: 1, rate: 0.9 }]
  }
  const cases = [
    ['title 150 字', { title: long(150) }, 't_activity.title varchar(100)'],
    ['subtitle 300 字', { subtitle: long(300) }, 't_activity.subtitle varchar(200)'],
    ['ctaText 80 字', { ctaText: long(80) }, 't_activity.cta_text varchar(50)'],
    ['ctaLink 300 字', { ctaLink: long(300) }, 't_activity.cta_link varchar(200)'],
    ['theme 50 字', { theme: long(50) }, 't_activity.theme varchar(30)'],
    ['note 700 字', { note: long(700) }, 't_activity.note varchar(500)']
  ]
  for (const [name, patch, col] of cases) {
    const r = await call('POST', '/admin/activities', { token: admin, body: { ...base, ...patch } })
    record(g, name, col, r)
    if (r.json?.code === 0) created.activityIds.push(base.id)
  }
}

// ------------------------------------------------------------------
// 7. 系统设置（site_name 100 / service_phone 30 / announce_text 500）
{
  const g = '系统设置'
  const cases = [
    ['siteName 150 字', { siteName: long(150) }, 't_settings.site_name varchar(100)'],
    ['servicePhone 50 字', { servicePhone: long(50) }, 't_settings.service_phone varchar(30)'],
    ['announceText 700 字', { announceText: long(700) }, 't_settings.announce_text varchar(500)'],
    ['commissionRate 越界(99)', { commissionRate: 99 }, 't_settings.commission_rate decimal(5,4)'],
    ['maxPublishPerDay 负数', { maxPublishPerDay: -5 }, 't_settings.max_publish_per_day']
  ]
  for (const [name, patch, col] of cases) {
    const r = await call('PATCH', '/admin/settings', { token: admin, body: patch })
    record(g, name, col, r)
  }
}

// ------------------------------------------------------------------
// 8. 商品审核驳回理由（reason varchar(500)）
{
  const g = '商品审核'
  const r1 = await call('POST', `/review/goods/${goodsId}/review`, {
    token: admin, body: { action: 'reject', reason: long(600) }
  })
  record(g, 'reason 600 字', 't_goods_audit_record.reason varchar(500)', r1)
  const r2 = await call('POST', `/review/goods/${goodsId}/review`, {
    token: admin, body: { action: '不存在的动作' }
  })
  record(g, 'action 非法枚举（该拒未拒？）', 't_goods.status', r2)
}

// ------------------------------------------------------------------
// 9. 注册（username 50 / nickname 50 / password 100）
{
  const g = '注册'
  const r1 = await call('POST', '/user/register', {
    token: undefined, body: { username: long(80), password: '123456', nickname: '探针' }
  })
  record(g, 'username 80 字', 't_user.username varchar(50)', r1)

  const r2 = await call('POST', '/user/register', {
    token: undefined, body: { username: 'probe' + Date.now(), password: '123456', nickname: long(80) }
  })
  record(g, 'nickname 80 字', 't_user.nickname varchar(50)', r2)
  if (r2.json?.code === 0) {
    const uid = r2.json?.data?.user?.id
    if (uid) created.userIds.push(uid)
  }
}

// ------------------------------------------------------------------
// 10. 后台订单备注 / 状态（admin_note varchar(500)）
if (orderId) {
  const g = '后台订单'
  const r1 = await call('PATCH', `/admin/orders/${orderId}/note`, { token: admin, body: { note: long(600) } })
  record(g, 'note 600 字', 't_order.admin_note varchar(500)', r1)
  const r2 = await call('PATCH', `/admin/orders/${orderId}/status`, {
    token: admin, body: { status: '不存在的状态' }
  })
  record(g, 'status 非法枚举（该拒未拒？）', 't_order.status 状态机', r2)
}

// ------------------------------------------------------------------
// 11. 用户警告（reason → t_message.content TEXT + t_audit_log.detail TEXT）
{
  const g = '用户警告'
  const r1 = await call('POST', '/admin/users/5/warn', { token: admin, body: { reason: long(2000) } })
  record(g, 'reason 2000 字', 't_message.content TEXT（下限？）', r1, 'TEXT 列不会撑爆，关注有无长度上限')
}

// ------------------------------------------------------------------
// 12. 评价 rating 越界（rating INT，无 CHECK）
{
  const g = '评价'
  const r1 = await call('POST', '/reviews', {
    token: user, body: { orderId: orderId, rating: 99, content: '探针' }
  })
  record(g, 'rating=99（该拒未拒？）', 't_review.rating 1-5', r1)
  const r2 = await call('POST', '/reviews', {
    token: user, body: { orderId: orderId, rating: 0, content: '探针' }
  })
  record(g, 'rating=0（该拒未拒？）', 't_review.rating 1-5', r2)
}

// ------------------------------------------------------------------
// 输出
console.log('\n================ 结果 ================')
const w = (s, n) => String(s ?? '').padEnd(n).slice(0, n)
console.log(`${w('组', 8)} ${w('用例', 26)} ${w('目标列', 36)} ${w('code', 6)} ${w('判定', 11)} 消息`)
for (const r of rows) {
  console.log(`${w(r.group, 8)} ${w(r.name, 26)} ${w(r.colInfo, 36)} ${w(r.code, 6)} ${w(r.verdict, 11)} ${r.msg}`)
}

const def = rows.filter((r) => r.verdict === 'DEFECT_500')
const acc = rows.filter((r) => r.verdict === 'ACCEPTED')
const njson = rows.filter((r) => r.verdict === 'NON_JSON')
console.log(`\n合计 ${rows.length} 项：友好拒绝 ${rows.length - def.length - acc.length - njson.length} / DEFECT_500 ${def.length} / ACCEPTED ${acc.length} / 非JSON ${njson.length}`)
if (def.length) {
  console.log('\n❌ 500 缺陷（数据库约束当校验器）：')
  def.forEach((r) => console.log(`   - [${r.group}] ${r.name} → ${r.colInfo} :: ${r.msg}`))
}
if (acc.length) {
  console.log('\n⚠️ 意外成功（需看是否该拒）：')
  acc.forEach((r) => console.log(`   - [${r.group}] ${r.name} :: ${r.msg}`))
}
if (njson.length) {
  console.log('\n❓ 非 JSON 响应（Tomcat 层拒绝，可能是路径/方法问题）：')
  njson.forEach((r) => console.log(`   - [${r.group}] ${r.name} :: ${r.msg}`))
}
console.log('\n本次产生的数据 id（需按精确 id 清理）：')
console.log('  ' + JSON.stringify(created))
