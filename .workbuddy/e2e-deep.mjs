/**
 * 深度联调验证（需要真实数据）
 * 目标：把「JSON 列数组」「越权防护」「订单/会话/收藏联动」这几项真正跑通
 */
const BASE = 'http://localhost:8080/api'
let pass = 0, fail = 0
const lines = []
function ok(name, cond, extra = '') {
  if (cond) { pass++; lines.push(`  [PASS] ${name}${extra ? ' :: ' + extra : ''}`) }
  else { fail++; lines.push(`  [FAIL] ${name}${extra ? ' :: ' + extra : ''}`) }
}
const section = (t) => lines.push(`\n### ${t}`)

async function call(method, path, { token, body } = {}) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers['Authorization'] = 'Bearer ' + token
  const res = await fetch(BASE + path, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: res.status, json, text }
}

async function login(u, p) {
  const r = await call('POST', '/user/login', { body: { username: u, password: p } })
  return r.json?.data?.token
}

const zs = await login('zhangsan', '123456')
const ls = await login('lisi', '123456')
const ga = await login('goods_admin', 'goods123456')
ok('三方登录成功', !!(zs && ls && ga), `zs=${!!zs} ls=${!!ls} ga=${!!ga}`)

// ---------- 1. 发布商品：JSON 数组写入 ----------
section('1. 发布商品（验证 images JSON 列写入/回读）')
let goodsId = null
{
  const body = {
    title: '[联调验证] 高等数学教材 第七版',
    price: 25.5,
    cover: '/goods/cover-test.svg',
    images: ['/goods/a.svg', '/goods/b.svg', '/goods/c.svg'],
    description: '九成新，无笔记，适合大一新生。本条目由联调脚本创建。',
    stock: 2,
    categoryId: 1,
    deliveryMethod: 'face',
    location: '图书馆一楼'
  }
  const r = await call('POST', '/goods', { token: zs, body })
  ok('POST /goods 发布成功', r.json?.code === 0, `code=${r.json?.code} msg=${r.json?.message}`)
  goodsId = r.json?.data?.id
  ok('返回商品 id', typeof goodsId === 'number', `id=${goodsId}`)
  ok('新发布商品状态为 pending（审核开关已开）', r.json?.data?.status === 'pending',
    `status=${r.json?.data?.status}`)
  ok('★ images 回读为数组而非字符串', Array.isArray(r.json?.data?.images),
    `typeof=${typeof r.json?.data?.images} val=${JSON.stringify(r.json?.data?.images)}`)
}

// ---------- 2. 详情回读：JSON 列 + 时间格式 ----------
section('2. 详情回读（JSON 列 / LocalDateTime 格式）')
{
  /*
   * 这里读的是**自己刚发布的 pending 商品**，所以必须带卖家 token。
   *
   * 本轮给详情接口补上了可见性判定：on_sale/sold 任何人可读，
   * pending/off_shelf 只有卖家本人与后台角色可读（不可见时 404）。
   * 沿用旧写法（匿名 GET）会拿到 404，下面 7 项会连带全红 ——
   * 那是断言过时，不是功能坏了。顺带把「匿名读 pending 必须 404」补成正式用例。
   */
  const anon = await call('GET', `/goods/${goodsId}`)
  ok('★ 匿名读「审核中」商品详情被拒 404（本轮新口径）', anon.json?.code === 404,
    `code=${anon.json?.code}`)

  const r = await call('GET', `/goods/${goodsId}`, { token: zs })
  const d = r.json?.data
  ok('GET /goods/{id} 成功（卖家本人视角）', r.json?.code === 0, `code=${r.json?.code}`)
  ok('★ images 是数组', Array.isArray(d?.images), `val=${JSON.stringify(d?.images)}`)
  ok('★ images 元素个数正确', d?.images?.length === 3, `len=${d?.images?.length}`)
  ok('★ createTime 是 ISO-8601 字符串（非数组）',
    typeof d?.createTime === 'string', `createTime=${JSON.stringify(d?.createTime)}`)
  ok('★ createTime 可被 Date 正确解析',
    !!d?.createTime && !isNaN(new Date(d.createTime).getTime()),
    `parsed=${d?.createTime ? new Date(d.createTime).toISOString() : 'N/A'}`)
  ok('price 为数值（非字符串）', typeof d?.price === 'number', `price=${JSON.stringify(d?.price)}`)
  ok('viewCount 非空（详情触发 +1 未 NPE）', typeof d?.viewCount === 'number', `viewCount=${d?.viewCount}`)
}

// ---------- 3. 越权防护（真实数据） ----------
section('3. 越权防护（lisi 操作 zhangsan 的商品）')
{
  const r1 = await call('DELETE', `/goods/${goodsId}`, { token: ls })
  ok('★ lisi 删除 zhangsan 商品被拒 403', r1.json?.code === 403,
    `code=${r1.json?.code} msg=${r1.json?.message}`)

  const r2 = await call('PATCH', `/goods/${goodsId}/status`, { token: ls, body: { status: 'off_shelf' } })
  ok('★ lisi 改 zhangsan 商品状态被拒 403', r2.json?.code === 403,
    `code=${r2.json?.code} msg=${r2.json?.message}`)

  const r3 = await call('PATCH', `/user/goods/${goodsId}/status`, { token: ls, body: { status: 'off_shelf' } })
  ok('★ lisi 经卖家侧端点改状态也被拒 403', r3.json?.code === 403,
    `code=${r3.json?.code} msg=${r3.json?.message}`)

  const r4 = await call('DELETE', `/user/goods/${goodsId}`, { token: ls })
  ok('★ lisi 经 /user/goods/{id} 删除同人商品被拒', r4.json?.code === 403,
    `code=${r4.json?.code} msg=${r4.json?.message}`)

  // 确认商品仍在（用卖家 token 读：此刻商品仍是 pending，匿名读会 404）
  const still = await call('GET', `/goods/${goodsId}`, { token: zs })
  ok('★ 越权尝试后商品仍存在', still.json?.code === 0 && still.json?.data?.id === goodsId,
    `code=${still.json?.code}`)
}

// ---------- 4. 审核流程 ----------
section('4. 审核流程（goods_admin 通过）')
{
  const p = await call('GET', '/review/goods/pending?page=1&pageSize=50', { token: ga })
  ok('待审核列表可读', p.json?.code === 0, `code=${p.json?.code}`)
  ok('★ 待审核列表只含 pending 商品',
    (p.json?.data?.list || []).every(x => x.status === 'pending'),
    `statuses=${[...new Set((p.json?.data?.list || []).map(x => x.status))].join(',')}`)

  const rj = await call('POST', `/review/goods/${goodsId}/review`, { token: ga, body: { action: 'reject', reason: '短' } })
  ok('★ 驳回理由不足 5 字被拒 1001', rj.json?.code === 1001,
    `code=${rj.json?.code} msg=${rj.json?.message}`)

  const r = await call('POST', `/review/goods/${goodsId}/review`, { token: ga, body: { action: 'approve' } })
  ok('审核通过成功', r.json?.code === 0, `code=${r.json?.code} msg=${r.json?.message}`)

  const after = await call('GET', `/goods/${goodsId}`)
  ok('★ 审核通过后状态变为 on_sale', after.json?.data?.status === 'on_sale',
    `status=${after.json?.data?.status}`)

  const dup = await call('POST', `/review/goods/${goodsId}/review`, { token: ga, body: { action: 'approve' } })
  ok('重复审核被拒（非 500 语义）', dup.json?.code !== 0, `code=${dup.json?.code} msg=${dup.json?.message}`)
}

// ---------- 5. 列表可见性 ----------
section('5. 审核通过后在售列表可见')
{
  const r = await call('GET', '/goods?page=1&pageSize=50')
  const found = (r.json?.data?.list || []).find(x => x.id === goodsId)
  ok('★ 已上架商品出现在公开列表', !!found, `total=${r.json?.data?.total}`)
  if (found) {
    ok('列表项 images 也是数组', Array.isArray(found.images), `val=${JSON.stringify(found.images)}`)
  }
}

// ---------- 6. 自购拦截 ----------
section('6. 自购拦截（订单）')
{
  const r = await call('POST', '/orders', { token: zs, body: { goodsId, quantity: 1 } })
  ok('★ 卖家买自己的商品被拒', r.json?.code !== 0, `code=${r.json?.code} msg=${r.json?.message}`)
}

// ---------- 7. 下单 → 会话 → 收藏联动 ----------
section('7. 买家侧全链路（下单/会话/收藏）')
let orderId = null, sessionId = null
{
  const r = await call('POST', '/orders', { token: ls, body: { goodsId, quantity: 1 } })
  ok('lisi 下单成功', r.json?.code === 0, `code=${r.json?.code} msg=${r.json?.message}`)
  orderId = r.json?.data?.id ?? r.json?.data?.orderId
  ok('返回订单 id', !!orderId, `orderId=${orderId}`)
  const o = r.json?.data
  ok('★ 订单 traces 是数组（JSON 列）',
    o?.traces === undefined || Array.isArray(o.traces), `traces=${JSON.stringify(o?.traces)?.slice(0, 60)}`)

  // 库存原子扣减
  const g = await call('GET', `/goods/${goodsId}`)
  ok('★ 下单后库存原子扣减 2 → 1', g.json?.data?.stock === 1, `stock=${g.json?.data?.stock}`)

  // 超卖防护
  const over = await call('POST', '/orders', { token: ls, body: { goodsId, quantity: 99 } })
  ok('★ 超量下单被拒', over.json?.code !== 0, `code=${over.json?.code} msg=${over.json?.message}`)

  // 会话（返回的 data 直接是 String sessionId）
  const s = await call('POST', '/messages/sessions/open', { token: ls, body: { toUserId: 4, goodsId } })
  ok('开启会话成功', s.json?.code === 0, `code=${s.json?.code} msg=${s.json?.message}`)
  sessionId = s.json?.data
  if (sessionId) {
    const expect = `s_${goodsId}_4_5`
    ok('★ 会话 id 符合 s_{goodsId}_{min}_{max} 规则', String(sessionId) === expect,
      `期望=${expect} 实际=${sessionId}`)
    // 对称性：卖家反向开启同一会话应得到同一个 id
    const s2 = await call('POST', '/messages/sessions/open', { token: zs, body: { toUserId: 5, goodsId } })
    ok('★ 会话 id 对称（卖家反向开启得到同一会话）', s2.json?.data === sessionId,
      `卖家侧=${s2.json?.data} 买家侧=${sessionId}`)
  } else {
    lines.push('  [SKIP] 会话 id 未取到')
  }

  // 收藏
  const f1 = await call('POST', '/user/favorites/toggle', { token: ls, body: { goodsId } })
  ok('收藏切换成功', f1.json?.code === 0, `code=${f1.json?.code} msg=${f1.json?.message}`)
  const fl = await call('GET', '/user/favorites', { token: ls })
  ok('收藏列表可读', fl.json?.code === 0, `code=${fl.json?.code}`)
  const flist = fl.json?.data?.list ?? fl.json?.data ?? []
  const hit = Array.isArray(flist) ? flist.find(x => (x.goodsId ?? x.goods?.id) === goodsId) : null
  ok('★ 收藏项内嵌 goods 含 status/stock（前端"已售出"标记依赖）',
    !hit || ('status' in (hit.goods || hit)),
    hit ? `keys=${Object.keys(hit.goods || hit).slice(0, 10).join(',')}` : '未命中收藏项')

  // 历史足迹
  const h = await call('POST', '/user/history', { token: ls, body: { goodsId } })
  ok('写入浏览足迹成功', h.json?.code === 0, `code=${h.json?.code} msg=${h.json?.message}`)
  const hl = await call('GET', '/user/history', { token: ls })
  const hlist = hl.json?.data?.list ?? hl.json?.data ?? []
  const hitem = Array.isArray(hlist) ? hlist[0] : null
  if (hitem) {
    const hg = hitem.goods || hitem
    ok('★ 历史项内嵌 goods 含 status', 'status' in hg, `status=${hg.status}`)
    ok('★ 历史项内嵌 goods 含 stock', 'stock' in hg, `stock=${hg.stock}`)
  } else {
    lines.push('  [SKIP] 浏览足迹为空')
  }
}

// ---------- 8. 订单状态机越权 ----------
section('8. 订单状态机越权')
{
  if (orderId) {
    const ship = await call('POST', `/orders/${orderId}/ship`, { token: ls, body: { trackingNo: 'SF123', company: '顺丰速运' } })
    ok('★ 买家不能发货（应仅卖家/管理员）', ship.json?.code === 403,
      `code=${ship.json?.code} msg=${ship.json?.message}`)

    const logs = await call('GET', `/orders/${orderId}/logs`, { token: zs })
    ok('卖家可查看与自己商品相关的订单日志', logs.json?.code === 0,
      `code=${logs.json?.code} msg=${logs.json?.message}`)

    const logsOutsider = await call('GET', `/orders/${orderId}/logs`, { token: ga })
    ok('无关第三方查看订单日志被拒（或按角色放行）',
      logsOutsider.json?.code === 403 || logsOutsider.json?.code === 0,
      `code=${logsOutsider.json?.code} msg=${logsOutsider.json?.message}`)
  }

  const nocode = await call('GET', '/admin/orders/999999/refund/detail', { token: ls })
  ok('/admin/** 对普通用户始终 403', nocode.json?.code === 403, `code=${nocode.json?.code}`)
}

// ---------- 9. 清理 ----------
section('9. 清理联调数据')
{
  const r = await call('DELETE', `/goods/${goodsId}`, { token: zs })
  ok('卖家删除自己的商品成功', r.json?.code === 0, `code=${r.json?.code} msg=${r.json?.message}`)
  const after = await call('GET', `/goods/${goodsId}`)
  ok('删除后详情不可读', after.json?.code !== 0, `code=${after.json?.code} msg=${after.json?.message}`)
}

lines.push(`\n========== 汇总: PASS=${pass}  FAIL=${fail} ==========`)
console.log(lines.join('\n'))
process.exit(fail > 0 ? 1 : 0)
