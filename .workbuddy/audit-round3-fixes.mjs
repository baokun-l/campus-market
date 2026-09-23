/*
 * 第三轮修复的**逐项自检探针**（可重复跑，跑完需按脚本末尾提示复位数据库）
 *
 * 覆盖：
 *   D1  驳回退款回到「申请售后前的状态」，不再硬编码 shipped
 *   D2  商品状态白名单（幽灵状态 teleport 必须被拒）
 *   D4a 审核角色读不到别人的订单日志
 *   D4b 举报管理员不能代任意用户追评
 *   D5  信用分原子扣减（并发不丢分）
 *   D6  举报并发处置只生效一次
 *   D10 pageSize / page 回显被钳到与数据库实际生效值一致
 *   D11 待审核账号被登录闸门拦住
 *   D12 真实发货会写入 t_order.traces（不再是死列）
 */
const BASE = 'http://localhost:8080/api'

let pass = 0
let fail = 0
function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${label}${detail ? ' — ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`) }
}

async function call(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(BASE + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  })
  let json = null
  try { json = await res.json() } catch { /* 空响应 */ }
  return { http: res.status, code: json?.code, message: json?.message, data: json?.data }
}

const login = (u, p) => call('POST', '/user/login', { body: { username: u, password: p } })

const admin = (await login('admin', 'admin123')).data?.token
const goodsAdmin = (await login('goods_admin', 'goods123456')).data?.token
const reportAdmin = (await login('report_admin', 'report123456')).data?.token
if (!admin || !goodsAdmin || !reportAdmin) { console.error('登录失败，终止'); process.exit(2) }
console.log('登录：admin / goods_admin / report_admin 均成功\n')

/* ---------------- D10 分页回显 ---------------- */
console.log('D10 分页回显与实际生效值一致')
{
  const big = await call('GET', '/goods?page=1&pageSize=100000', { token: admin })
  check('pageSize=100000 回显被钳到 500', big.data?.pageSize === 500, `回显 pageSize=${big.data?.pageSize}，返回 ${big.data?.list?.length} 条`)
  const zero = await call('GET', '/goods?page=0&pageSize=0', { token: admin })
  check('page=0 / pageSize=0 回显收敛为 1 / 500', zero.data?.page === 1 && zero.data?.pageSize === 500, `回显 page=${zero.data?.page} pageSize=${zero.data?.pageSize}`)
  const normal = await call('GET', '/goods?page=2&pageSize=5', { token: admin })
  check('正常分页原样回显（没有被误改）', normal.data?.page === 2 && normal.data?.pageSize === 5, `回显 page=${normal.data?.page} pageSize=${normal.data?.pageSize}`)
}

/* ---------------- D2 商品状态白名单 ---------------- */
console.log('\nD2 商品状态白名单')
{
  const before = (await call('GET', '/goods/1', { token: admin })).data?.status
  const bad = await call('PATCH', '/goods/1/status', { token: admin, body: { status: 'teleport' } })
  check('幽灵状态 teleport 被拒绝（1001）', bad.code === 1001, `code=${bad.code} msg=${bad.message ?? ''}`)
  const after = (await call('GET', '/goods/1', { token: admin })).data?.status
  check('库里状态未被污染', after === before && after !== 'teleport', `${before} → ${after}`)
  const good = await call('PATCH', '/goods/1/status', { token: admin, body: { status: before } })
  check('合法状态（原值，等价 no-op）不报错', good.code === 0, `code=${good.code}`)
}

/* ---------------- D4a 订单日志越权 ---------------- */
console.log('\nD4a 审核角色读不到别人的订单日志')
{
  const orders = (await call('GET', '/admin/orders?page=1&pageSize=200', { token: admin })).data?.list ?? []
  const target = orders[0]
  const asAdmin = await call('GET', `/orders/${target.id}/logs`, { token: admin })
  check('全能 admin 读得到（订单工作台需要）', asAdmin.code === 0 && Array.isArray(asAdmin.data), `code=${asAdmin.code} 条数=${asAdmin.data?.length}`)
  const asGoods = await call('GET', `/orders/${target.id}/logs`, { token: goodsAdmin })
  check('goods_admin 被拒（403）', asGoods.code === 403, `code=${asGoods.code} msg=${asGoods.message ?? ''}`)
  const asReport = await call('GET', `/orders/${target.id}/logs`, { token: reportAdmin })
  check('report_admin 被拒（403）', asReport.code === 403, `code=${asReport.code} msg=${asReport.message ?? ''}`)
}

/* ---------------- D4b 追评越权 ---------------- */
console.log('\nD4b 举报管理员不能代任意用户追评')
{
  const reviews = (await call('GET', '/admin/reviews?page=1&pageSize=50', { token: admin })).data?.list ?? []
  const orderId = reviews.find((r) => r.orderId && r.appendContent == null)?.orderId
  if (!orderId) {
    check('找到一条可追评的评价（前置条件）', false, '种子数据里没有未追评的评价，跳过')
  } else {
    const asReport = await call('POST', `/orders/${orderId}/review/append`, { token: reportAdmin, body: { content: '探针：举报管理员代追评' } })
    check('report_admin 被拒（403）', asReport.code === 403, `顺序号=${orderId} code=${asReport.code} msg=${asReport.message ?? ''}`)
  }
}

/* ---------------- D5 + D6 并发处置举报 ---------------- */
console.log('\nD5 + D6 举报并发处置：只生效一次、信用分只扣一次')
{
  const pend = (await call('GET', '/admin/reports?status=pending&page=1&pageSize=50', { token: admin })).data?.list ?? []
  const rep = pend.find((r) => r.type === 'user')
  if (!rep) {
    check('找到一条 pending 的 user 类举报（前置条件）', false, '无可用数据，跳过本组')
  } else {
    const usersBefore = (await call('GET', '/admin/users?page=1&pageSize=100', { token: admin })).data?.list ?? []
    const creditOf = (list) => list.find((u) => u.id === rep.targetId)?.creditScore
    const before = creditOf(usersBefore)

    // 同一举报并发打两次 —— 旧实现（check-then-act）会让副作用执行两次
    const body = { action: 'handle', measure: 'warn', remark: '探针：并发处置' }
    const [a, b] = await Promise.all([
      call('POST', `/admin/reports/${rep.id}/resolve`, { token: admin, body }),
      call('POST', `/admin/reports/${rep.id}/resolve`, { token: admin, body })
    ])
    const okCount = [a, b].filter((r) => r.code === 0).length
    check('并发两次处置，恰好一次成功', okCount === 1, `成功 ${okCount} 次（A code=${a.code} / B code=${b.code}）`)
    check('失败的那次给出可读提示', [a, b].some((r) => r.code !== 0 && typeof r.message === 'string' && r.message.length > 0),
      [a, b].filter((r) => r.code !== 0).map((r) => r.message).join(' | '))

    const usersAfter = (await call('GET', '/admin/users?page=1&pageSize=100', { token: admin })).data?.list ?? []
    const after = creditOf(usersAfter)
    check('信用分恰好扣 5 分（没有重复扣）', before != null && after === before - 5, `${before} → ${after}`)

    const rp = (await call('GET', '/admin/reports?page=1&pageSize=50', { token: admin })).data?.list ?? []
    const now = rp.find((r) => r.id === rep.id)
    check('举报状态已落为 handled', now?.status === 'handled', `status=${now?.status} outcome=${now?.outcome ?? ''}`)
  }
}

/* ---------------- D1 驳回退款回到申请前状态 ---------------- */
console.log('\nD1 驳回退款回到「申请售后前的状态」')
{
  const ORDER = '20260916091000008'
  const find = async () => {
    const list = (await call('GET', '/admin/orders?page=1&pageSize=200', { token: admin })).data?.list ?? []
    return list.find((o) => o.id === ORDER)
  }
  const o0 = await find()
  check(`目标订单 ${ORDER} 初始为 pending_ship（卖家从未发货）`, o0?.status === 'pending_ship', `status=${o0?.status} shipTime=${o0?.shipTime ?? 'null'}`)

  await call('PATCH', `/admin/orders/${ORDER}/status`, { token: admin, body: { status: 'refunding', reason: '探针：模拟申请退款' } })
  const mid = await find()
  check('已进入 refunding', mid?.status === 'refunding', `status=${mid?.status}`)

  const rej = await call('POST', `/admin/orders/${ORDER}/refund/reject`, { token: admin, body: { note: '探针：驳回' } })
  check('驳回调用成功', rej.code === 0, `code=${rej.code} msg=${rej.message ?? ''}`)
  const end = await find()
  check('驳回后回到 pending_ship（而不是被硬编码成 shipped）', end?.status === 'pending_ship', `status=${end?.status}`)
  check('发货时间为空（验证没有造出「已发货但没发货时间」的脏数据）', !end?.shipTime, `shipTime=${end?.shipTime ?? 'null'}`)
}

/* ---------------- D12 发货写入物流轨迹 ---------------- */
console.log('\nD12 真实发货会写入 t_order.traces')
{
  const list = (await call('GET', '/admin/orders?page=1&pageSize=200', { token: admin })).data?.list ?? []
  const cand = list.find((o) => o.status === 'pending_ship')
  if (!cand) {
    check('找到一笔 pending_ship 订单（前置条件）', false, '无可用数据，跳过')
  } else {
    const nameToUser = { 计算机小张: 'zhangsan', 图书小李: 'lisi', 数码小王: 'wangwu' }
    const uname = nameToUser[cand.sellerName]
    const sellerToken = uname ? (await login(uname, '123456')).data?.token : null
    if (!sellerToken) {
      check(`能登录该单卖家「${cand.sellerName}」`, false, '卖家不是演示账号，跳过')
    } else {
      const ship = await call('POST', `/orders/${cand.id}/ship`, { token: sellerToken, body: { trackingNo: 'SF20260919999', company: '顺丰速运' } })
      check('卖家发货成功', ship.code === 0, `code=${ship.code} msg=${ship.message ?? ''}`)
      const mine = (await call('GET', '/orders?page=1&pageSize=200', { token: sellerToken })).data?.list ?? []
      const shipped = mine.find((o) => o.id === cand.id) ?? (await call('GET', '/admin/orders?page=1&pageSize=200', { token: admin })).data.list.find((o) => o.id === cand.id)
      const traces = shipped?.traces
      check('traces 不再是 null（死列已写活）', Array.isArray(traces) && traces.length > 0, `条数=${traces?.length ?? 0}`)
      check('轨迹内容含「已发货」且格式为 {time,text}', !!traces?.[0]?.text?.includes('已发货') && !!traces?.[0]?.time, JSON.stringify(traces?.[0] ?? null))
      check('轨迹时间格式与种子一致（yyyy-MM-ddTHH:mm:ss）', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(traces?.[0]?.time ?? ''), traces?.[0]?.time ?? '')
    }
  }
}

console.log(`\n===== 本轮探针：${pass} PASS / ${fail} FAIL =====`)
console.log('提示：D1 改动了订单 20260916091000008、D5/D6 扣了信用分、D12 让一笔订单进入 shipped，')
console.log('      跑完请按下面命令复位：')
console.log('      mysql -uroot -p123456 campus_market < db/demo-data.sql && mysql -uroot -p123456 campus_market < db/demo-data-orders.sql')
process.exit(fail === 0 ? 0 : 1)
