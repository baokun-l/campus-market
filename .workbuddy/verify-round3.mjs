/*
 * 第三轮修复的**逐项自检探针 v2**（可重复跑；跑完必须按文末提示复位数据库）
 *
 * v2 相对 v1 的三点改进：
 *   ① D4b / D5+D6 不再依赖种子数据（v1 因 t_review / t_report 为空而 FAIL），
 *      改为**自己造前置数据**（用真实接口，不直接写库）；
 *   ② 新增 D8（改密后旧令牌立即失效）、D14（清空审计日志需要显式确认）、
 *      D7（收藏数并发不漂移）三组断言；
 *   ③ 用临时注册账号做「会写脏数据」的用例（D7/D8），跑完删号即可，
 *      不再污染 6 个种子账号。
 *
 * 覆盖：
 *   D1  驳回退款回到「申请售后前的状态」，不再硬编码 shipped
 *   D2  商品状态白名单（幽灵状态必须被拒）
 *   D4a 审核角色读不到别人的订单日志
 *   D4b 举报管理员不能代任意用户追评
 *   D5  信用分原子扣减（并发不重复扣）
 *   D6  举报并发处置只生效一次
 *   D7  收藏数并发不漂移（单列原子 UPDATE）
 *   D8  改密码后旧 JWT 立即失效（token_version）
 *   D10 分页回显与数据库实际生效值一致
 *   D12 真实发货会写入 t_order.traces（死列已写活）
 *   D14 清空审计日志需要显式确认，且自身留痕
 *
 * 顺序刻意安排：D14 会清空审计日志，所以放最后。
 */
const BASE = 'http://localhost:8080/api'

let pass = 0
let fail = 0
const failures = []

function check(label, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`  PASS  ${label}${detail ? ' — ' + detail : ''}`)
  } else {
    fail++
    failures.push(label)
    console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`)
  }
}

async function call(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  let json = null
  try {
    json = await res.json()
  } catch {
    /* 空响应 */
  }
  return { http: res.status, code: json?.code, message: json?.message, data: json?.data }
}

const login = (u, p) => call('POST', '/user/login', { body: { username: u, password: p } })

const admin = (await login('admin', 'admin123')).data?.token
const goodsAdmin = (await login('goods_admin', 'goods123456')).data?.token
const reportAdmin = (await login('report_admin', 'report123456')).data?.token
const zhangsan = (await login('zhangsan', '123456')).data?.token
const lisi = (await login('lisi', '123456')).data?.token
if (!admin || !goodsAdmin || !reportAdmin || !zhangsan || !lisi) {
  console.error('登录失败，终止')
  process.exit(2)
}
console.log('登录：admin / goods_admin / report_admin / zhangsan / lisi 均成功\n')

const adminOrders = async () =>
  (await call('GET', '/admin/orders?page=1&pageSize=200', { token: admin })).data?.list ?? []
const findOrder = async (id) => (await adminOrders()).find((o) => o.id === id)

/* ---------------- D10 分页回显 ---------------- */
console.log('D10 分页回显与实际生效值一致')
{
  const big = await call('GET', '/goods?page=1&pageSize=100000', { token: admin })
  check(
    'pageSize=100000 回显被钳到 500',
    big.data?.pageSize === 500,
    `回显 pageSize=${big.data?.pageSize}，返回 ${big.data?.list?.length} 条`
  )
  const zero = await call('GET', '/goods?page=0&pageSize=0', { token: admin })
  check(
    'page=0 / pageSize=0 回显收敛为 1 / 500',
    zero.data?.page === 1 && zero.data?.pageSize === 500,
    `回显 page=${zero.data?.page} pageSize=${zero.data?.pageSize}`
  )
  const normal = await call('GET', '/goods?page=2&pageSize=5', { token: admin })
  check(
    '正常分页原样回显（没有被误改）',
    normal.data?.page === 2 && normal.data?.pageSize === 5,
    `回显 page=${normal.data?.page} pageSize=${normal.data?.pageSize}`
  )
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
  const orders = await adminOrders()
  const target = orders[0]
  const asAdmin = await call('GET', `/orders/${target.id}/logs`, { token: admin })
  check(
    '全能 admin 读得到（订单工作台需要）',
    asAdmin.code === 0 && Array.isArray(asAdmin.data),
    `code=${asAdmin.code} 条数=${asAdmin.data?.length}`
  )
  const asGoods = await call('GET', `/orders/${target.id}/logs`, { token: goodsAdmin })
  check('goods_admin 被拒（403）', asGoods.code === 403, `code=${asGoods.code} msg=${asGoods.message ?? ''}`)
  const asReport = await call('GET', `/orders/${target.id}/logs`, { token: reportAdmin })
  check('report_admin 被拒（403）', asReport.code === 403, `code=${asReport.code} msg=${asReport.message ?? ''}`)
}

/* ---------------- D4b 追评越权（自造前置数据） ----------------
 * 20260820140000009 是「已完成」订单且买家是 zhangsan（种子数据），
 * 由买家正常提交一条评价作为前置；若已存在（重复跑）则忽略 duplicate。
 */
console.log('\nD4b 举报管理员不能代任意用户追评')
{
  const ORDER = '20260820140000009'
  const mk = await call('POST', '/reviews', {
    token: zhangsan,
    body: { orderId: ORDER, rating: 5, content: '探针：买家正常评价（前置数据）' }
  })
  const exists = (await call('GET', `/orders/${ORDER}/review`, { token: zhangsan })).data ?? []
  check('前置：该订单上存在一条评价', exists.length > 0, `code=${mk.code} 评价条数=${exists.length}`)

  const asReport = await call('POST', `/orders/${ORDER}/review/append`, {
    token: reportAdmin,
    body: { content: '探针：举报管理员代追评（应当被拒）' }
  })
  check('report_admin 被拒（403）', asReport.code === 403, `code=${asReport.code} msg=${asReport.message ?? ''}`)
  const asGoods = await call('POST', `/orders/${ORDER}/review/append`, {
    token: goodsAdmin,
    body: { content: '探针：商品管理员代追评（应当被拒）' }
  })
  check('goods_admin 同样被拒（403，两处口径一致）', asGoods.code === 403, `code=${asGoods.code} msg=${asGoods.message ?? ''}`)
}

/* ---------------- D5 + D6 举报并发处置（自造前置数据） ---------------- */
console.log('\nD5 + D6 举报并发处置：只生效一次、信用分只扣一次')
{
  // 先记下当前 pending 的 id 集合，用「差集」精确锁定本次新建的那条
  const beforeIds = new Set(
    ((await call('GET', '/admin/reports?status=pending&page=1&pageSize=200', { token: admin })).data?.list ?? []).map(
      (r) => r.id
    )
  )
  const TARGET_USER = 6 // wangwu，credit 基线 100
  const created = await call('POST', '/reports', {
    token: lisi,
    body: { type: 'user', targetId: TARGET_USER, reason: '探针：并发处置前置举报' }
  })
  check('前置：举报已创建', created.code === 0, `code=${created.code}`)

  const pend = ((await call('GET', '/admin/reports?status=pending&page=1&pageSize=200', { token: admin })).data?.list ?? []).filter(
    (r) => r.type === 'user' && r.targetId === TARGET_USER
  )
  const fresh = pend.filter((r) => !beforeIds.has(r.id)).sort((a, b) => b.id - a.id)[0]
  if (!fresh) {
    check('找到本次新建的 pending user 类举报', false, '未找到（可能上一条未清理）')
  } else {
    const usersBefore = (await call('GET', '/admin/users?page=1&pageSize=100', { token: admin })).data?.list ?? []
    const creditOf = (list) => list.find((u) => u.id === TARGET_USER)?.creditScore
    const before = creditOf(usersBefore)

    // 同一举报并发打两次 —— 旧实现（check-then-act）会让副作用执行两次
    const body = { action: 'handle', measure: 'warn', remark: '探针：并发处置' }
    const [a, b] = await Promise.all([
      call('POST', `/admin/reports/${fresh.id}/resolve`, { token: admin, body }),
      call('POST', `/admin/reports/${fresh.id}/resolve`, { token: admin, body })
    ])
    const okCount = [a, b].filter((r) => r.code === 0).length
    check('并发两次处置，恰好一次成功', okCount === 1, `成功 ${okCount} 次（A code=${a.code} / B code=${b.code}）`)
    check(
      '失败的那次给出可读提示',
      [a, b].some((r) => r.code !== 0 && typeof r.message === 'string' && r.message.length > 0),
      [a, b]
        .filter((r) => r.code !== 0)
        .map((r) => r.message)
        .join(' | ')
    )

    const usersAfter = (await call('GET', '/admin/users?page=1&pageSize=100', { token: admin })).data?.list ?? []
    const after = creditOf(usersAfter)
    check('信用分恰好扣 5 分（没有重复扣）', before != null && after === before - 5, `${before} → ${after}`)

    const rp = (await call('GET', '/admin/reports?page=1&pageSize=200', { token: admin })).data?.list ?? []
    const now = rp.find((r) => r.id === fresh.id)
    check('举报状态已落为 handled', now?.status === 'handled', `status=${now?.status}`)
  }
}

/* ---------------- D7 收藏连点 / 并发不报错且计数不漂移 ----------------
 * 两件事一起验：
 *  ① 8 次并发 toggle **一次 500 都不能有**。
 *     修复前实测是 `0,500,500,0,0,500,500,0` —— t_favorite 上的唯一键
 *     uk_user_goods 撞上「先查后插」的 check-then-act，重复插入直接 500。
 *  ② 并发结束后再做**一次串行** toggle（它会重新数一遍真实收藏行数并回写），
 *     此时 favoriteCount 必须等于 t_favorite 里真实行数。
 *     本机种子把 t_favorite 清空、却给 t_goods.favorite_count 填了装饰性大数，
 *     所以「真实行数」只可能是 0 或 1（只有这个临时号收藏过 goods#1）。
 */
console.log('\nD7 收藏连点 / 并发：不报 500，计数与真实收藏行数一致')
let tempUser = null
let favCountAfter = null
{
  const uname = `probe_tmp_${Date.now()}`
  const reg = await call('POST', '/user/register', { body: { username: uname, password: 'probe123456', nickname: '探针临时号' } })
  tempUser = uname
  const tk = reg.data?.token
  check('前置：临时账号注册成功', reg.code === 0 && !!tk, `code=${reg.code} username=${uname}`)
  if (tk) {
    const toggles = await Promise.all(
      Array.from({ length: 8 }, () => call('POST', '/user/favorites/toggle', { token: tk, body: { goodsId: 1 } }))
    )
    const codes = toggles.map((r) => r.code)
    check('8 次并发 toggle 全部成功（没有 500）', codes.every((c) => c === 0), codes.join(','))
    check('并发结果里不含 500（唯一键冲突不再冒泡成内部错误）', !codes.includes(500), `codes=${codes.join(',')}`)

    /* 并发已全部返回 → 事务均已提交；再做一次串行 toggle 触发一次权威重算 */
    const seq = await call('POST', '/user/favorites/toggle', { token: tk, body: { goodsId: 1 } })
    const favorited = seq.data?.favorited === true
    favCountAfter = (await call('GET', '/goods/1', { token: admin })).data?.favoriteCount
    const expected = favorited ? 1 : 0
    check('串行 toggle 后 favoriteCount == 真实收藏行数（无漂移）',
      favCountAfter === expected,
      `favorited=${favorited} 期望=${expected} 实际=${favCountAfter}`)
    /* 复回去，尽量少留痕迹 */
    await call('POST', '/user/favorites/toggle', { token: tk, body: { goodsId: 1 } })
  }
}

/* ---------------- D8 改密后旧令牌立即失效（token_version） ---------------- */
console.log('\nD8 改密码后旧 JWT 立即失效（token_version）')
{
  if (!tempUser) {
    check('前置：需要临时账号', false, '上一步注册失败，跳过')
  } else {
    const old = (await login(tempUser, 'probe123456')).data?.token
    check('前置：用初始口令登录成功', !!old)

    const okBefore = await call('GET', '/user/profile', { token: old })
    check('改密前旧令牌可用', okBefore.code === 0, `code=${okBefore.code}`)

    const chg = await call('PATCH', '/user/password', {
      token: old,
      body: { oldPassword: 'probe123456', newPassword: 'probe654321' }
    })
    check('改密码成功', chg.code === 0, `code=${chg.code} msg=${chg.message ?? ''}`)

    const stale = await call('GET', '/user/profile', { token: old })
    check('改密后**旧令牌立即失效**（401，而不是继续用满 24h）', stale.code === 401, `code=${stale.code} msg=${stale.message ?? ''}`)

    const relogin = await login(tempUser, 'probe654321')
    check('用新口令重新登录成功', relogin.code === 0 && !!relogin.data?.token, `code=${relogin.code}`)
    const okNew = await call('GET', '/user/profile', { token: relogin.data?.token })
    check('新令牌可用', okNew.code === 0, `code=${okNew.code}`)

    // 反证：令牌里带 ver，且与库里一致时放行 —— 排除「所有令牌都被拒」的假绿
    const other = await call('GET', '/user/profile', { token: admin })
    check('其它账号的令牌不受影响（排除全局误杀）', other.code === 0, `code=${other.code}`)
  }
}

/* ---------------- D1 驳回退款回到申请前状态 ---------------- */
console.log('\nD1 驳回退款回到「申请售后前的状态」')
{
  const ORDER = '20260916091000008'
  const o0 = await findOrder(ORDER)
  check(
    `目标订单 ${ORDER} 初始为 pending_ship（卖家从未发货）`,
    o0?.status === 'pending_ship',
    `status=${o0?.status} shipTime=${o0?.shipTime ?? 'null'}`
  )

  await call('PATCH', `/admin/orders/${ORDER}/status`, {
    token: admin,
    body: { status: 'refunding', reason: '探针：模拟申请退款' }
  })
  const mid = await findOrder(ORDER)
  check('已进入 refunding', mid?.status === 'refunding', `status=${mid?.status}`)

  const rej = await call('POST', `/admin/orders/${ORDER}/refund/reject`, { token: admin, body: { note: '探针：驳回' } })
  check('驳回调用成功', rej.code === 0, `code=${rej.code} msg=${rej.message ?? ''}`)
  const end = await findOrder(ORDER)
  check('驳回后回到 pending_ship（而不是被硬编码成 shipped）', end?.status === 'pending_ship', `status=${end?.status}`)
  check('发货时间为空（没有造出「已发货但没发货时间」的脏数据）', !end?.shipTime, `shipTime=${end?.shipTime ?? 'null'}`)
}

/* ---------------- D12 发货写入物流轨迹 ---------------- */
console.log('\nD12 真实发货会写入 t_order.traces')
{
  const list = await adminOrders()
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
      const ship = await call('POST', `/orders/${cand.id}/ship`, {
        token: sellerToken,
        body: { trackingNo: 'SF20260919999', company: '顺丰速运' }
      })
      check('卖家发货成功', ship.code === 0, `order=${cand.id} code=${ship.code} msg=${ship.message ?? ''}`)
      const mine = (await call('GET', '/orders?page=1&pageSize=200', { token: sellerToken })).data?.list ?? []
      const shipped = mine.find((o) => o.id === cand.id) ?? (await findOrder(cand.id))
      const traces = shipped?.traces
      check('traces 不再是 null（死列已写活）', Array.isArray(traces) && traces.length > 0, `条数=${traces?.length ?? 0}`)
      check(
        '轨迹内容含「已发货」且格式为 {time,text}',
        !!traces?.[0]?.text?.includes('已发货') && !!traces?.[0]?.time,
        JSON.stringify(traces?.[0] ?? null)
      )
      check(
        '轨迹时间格式与种子一致（yyyy-MM-ddTHH:mm:ss）',
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(traces?.[0]?.time ?? ''),
        traces?.[0]?.time ?? ''
      )
    }
  }
}

/* ---------------- D14 清空审计日志需要显式确认（放最后：它会清空日志） ---------------- */
console.log('\nD14 清空审计日志需要显式确认，且自身留痕')
{
  const totalOf = async () => (await call('GET', '/admin/audit-logs?page=1&pageSize=1', { token: admin })).data?.total
  const before = await totalOf()

  const noConfirm = await call('DELETE', '/admin/audit-logs', { token: admin })
  check('不带 confirm 直接 DELETE 被拒绝（1001）', noConfirm.code === 1001, `code=${noConfirm.code} msg=${noConfirm.message ?? ''}`)
  const afterReject = await totalOf()
  check('被拒绝时**一条都没删**', afterReject === before, `${before} → ${afterReject}`)

  const withConfirm = await call('DELETE', '/admin/audit-logs?confirm=CLEAR', { token: admin })
  check('带 confirm=CLEAR 才执行', withConfirm.code === 0, `code=${withConfirm.code} msg=${withConfirm.message ?? ''}`)
  const afterClear = await call('GET', '/admin/audit-logs?page=1&pageSize=10', { token: admin })
  check('清空后只剩 1 条（刻意留痕，不是没删干净）', afterClear.data?.total === 1, `total=${afterClear.data?.total}`)
  const only = afterClear.data?.list?.[0]
  check('留下的那条正是「清空操作日志」', only?.action === 'audit.clear', `action=${only?.action} detail=${only?.detail ?? ''}`)
  check('留痕里记了操作人', !!only?.operator, `operator=${only?.operator}`)
}

console.log(`\n===== 本轮探针：${pass} PASS / ${fail} FAIL =====`)
if (failures.length) console.log('未通过：' + failures.join(' | '))
console.log(`临时账号（跑完需 SQL 清理）：${tempUser ?? '无'}；goods#1 favoriteCount 回显=${favCountAfter}`)
console.log('提示：本探针改动了订单 20260916091000008、wangwu 信用分、审计日志；')
console.log('      跑完请复位：demo-data.sql + demo-data-orders.sql，并删除 probe_* 临时账号。')
process.exit(fail === 0 ? 0 : 1)
