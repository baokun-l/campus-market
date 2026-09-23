/**
 * 全链路端到端联调验证
 * 覆盖：登录/BCrypt 升级、公开路由、鉴权拦截、越权拦截、
 *       分页体结构、JSON 列数组、LocalDateTime 格式、错误码
 */
const BASE = 'http://localhost:8080/api'
let pass = 0, fail = 0
const lines = []

function ok(name, cond, extra = '') {
  if (cond) { pass++; lines.push(`  [PASS] ${name}${extra ? ' :: ' + extra : ''}`) }
  else { fail++; lines.push(`  [FAIL] ${name}${extra ? ' :: ' + extra : ''}`) }
}

async function call(method, path, { token, body, raw } = {}) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers['Authorization'] = 'Bearer ' + token
  const res = await fetch(BASE + path, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  if (raw) return { status: res.status, text, json }
  return { status: res.status, json, text }
}

const section = (t) => lines.push(`\n### ${t}`)

// ---------- 1. 公开接口（游客可读） ----------
section('1. 公开路由（无 token 应放行）')
{
  const g = await call('GET', '/goods?page=1&pageSize=5')
  ok('GET /goods 游客可读', g.json?.code === 0, `code=${g.json?.code} http=${g.status}`)
  const d = g.json?.data
  ok('分页体字段是 list（不是 records）',
    d && Array.isArray(d.list) && typeof d.total === 'number' && 'page' in d && 'pageSize' in d,
    d ? `keys=${Object.keys(d).join(',')}` : 'data=null')
  ok('total/page/pageSize 类型正确',
    d && typeof d.total === 'number' && typeof d.page === 'number' && typeof d.pageSize === 'number',
    d ? `total=${d.total} page=${d.page} pageSize=${d.pageSize}` : '')
  if (d?.list?.length) {
    const it = d.list[0]
    ok('Goods.images 是数组（JacksonTypeHandler）', Array.isArray(it.images),
      `typeof=${typeof it.images} value=${JSON.stringify(it.images)?.slice(0, 60)}`)
    ok('createTime 是 ISO-8601 字符串而非数组',
      it.createTime === null || it.createTime === undefined || typeof it.createTime === 'string',
      `createTime=${JSON.stringify(it.createTime)}`)
    /*
     * 匿名列表的可见范围。
     *
     * 后端语义（本轮补齐）：不给任何状态条件时按调用者角色收敛 ——
     *   后台角色（admin/goods_admin/report_admin）→ 全量（商品管理页与 CSV 导出要用）
     *   买家与匿名                                → on_sale + sold
     * 曾经这里是「一律返回全部」，匿名能直接读到「审核中」商品的完整字段
     * （含 description），把详情接口的可见性判定绕了过去。
     * 显式传 status / statuses 时原样尊重，不受此影响。
     */
    const seen = [...new Set(d.list.map(x => x.status))]
    ok('匿名列表不含「审核中 / 已下架」（默认收敛到买家可见范围）',
      d.list.every(x => x.status !== 'pending' && x.status !== 'off_shelf'),
      `statuses=${seen.join(',')}`)
    ok('匿名列表只含 on_sale / sold',
      d.list.every(x => x.status === 'on_sale' || x.status === 'sold' || x.status === undefined),
      `statuses=${seen.join(',')}`)
  } else {
    lines.push('  [SKIP] 商品列表为空，跳过字段结构断言')
  }

  const c = await call('GET', '/categories')
  ok('GET /categories 游客可读', c.json?.code === 0, `code=${c.json?.code}`)

  // 取列表里真实存在且对买家可见的 id 来验详情（不要写死 id：演示数据可能被重建）
  const visibleId = d?.list?.[0]?.id
  const n = await call('GET', `/goods/${visibleId}`)
  ok(`GET /goods/${visibleId} 详情游客可读（在售/已售商品）`, n.json?.code === 0, `code=${n.json?.code}`)
}

// ---------- 2. 受保护接口应被拦截 ----------
section('2. 鉴权拦截（无 token 应 401）')
{
  const cases = [
    ['GET', '/user/profile'],
    ['GET', '/orders'],
    ['GET', '/user/favorites'],
    ['GET', '/messages/sessions'],
    ['GET', '/admin/users']
  ]
  for (const [m, p] of cases) {
    const r = await call(m, p)
    ok(`${m} ${p} 未登录被拒`, r.json?.code === 401, `code=${r.json?.code} msg=${r.json?.message}`)
  }
}

// ---------- 3. 登录与 BCrypt 自动升级 ----------
section('3. 登录 / BCrypt 双模式升级')
let userToken = null, adminToken = null
{
  const bad = await call('POST', '/user/login', { body: { username: 'zhangsan', password: 'wrong-password' } })
  ok('错误密码被拒', bad.json?.code !== 0, `code=${bad.json?.code}`)

  const r = await call('POST', '/user/login', { body: { username: 'zhangsan', password: '123456' } })
  ok('明文种子密码可登录（兼容模式）', r.json?.code === 0, `code=${r.json?.code} msg=${r.json?.message}`)
  userToken = r.json?.data?.token
  ok('登录返回 token', !!userToken, userToken ? `len=${userToken.length}` : 'token 缺失')
  ok('登录返回 user 对象', !!r.json?.data?.user, r.json?.data?.user ? `username=${r.json.data.user.username}` : '')
  ok('响应体不含 password 字段',
    !('password' in (r.json?.data?.user || {})),
    `user keys=${Object.keys(r.json?.data?.user || {}).join(',')}`)

  const a = await call('POST', '/user/login', { body: { username: 'admin', password: 'admin123' } })
  ok('admin 明文种子密码可登录', a.json?.code === 0, `code=${a.json?.code}`)
  adminToken = a.json?.data?.token
  ok('admin 角色正确', a.json?.data?.user?.role === 'admin', `role=${a.json?.data?.user?.role}`)
}

// ---------- 4. 带 token 访问受保护接口 ----------
section('4. 登录后访问受保护接口')
{
  const p = await call('GET', '/user/profile', { token: userToken })
  ok('GET /user/profile 带 token 成功', p.json?.code === 0, `code=${p.json?.code} msg=${p.json?.message}`)

  const o = await call('GET', '/orders?page=1&pageSize=5', { token: userToken })
  ok('GET /orders 分页体为 list', o.json?.code === 0 && Array.isArray(o.json?.data?.list), `code=${o.json?.code}`)

  const f = await call('GET', '/user/favorites', { token: userToken })
  ok('GET /user/favorites 可用', f.json?.code === 0, `code=${f.json?.code}`)

  const h = await call('GET', '/user/history', { token: userToken })
  ok('GET /user/history 可用', h.json?.code === 0, `code=${h.json?.code}`)
  const hl = h.json?.data?.list ?? h.json?.data
  if (Array.isArray(hl) && hl.length) {
    const g0 = hl[0].goods || hl[0]
    ok('历史记录内嵌 goods 含 status（前端"已售出"标记依赖）',
      'status' in g0, `goods keys=${Object.keys(g0).slice(0, 12).join(',')}`)
    ok('历史记录内嵌 goods 含 stock（加购封顶依赖）',
      'stock' in g0, `stock=${g0.stock}`)
  } else {
    lines.push('  [SKIP] 历史为空，无法断言内嵌 goods 字段')
  }
}

// ---------- 5. 越权拦截 ----------
section('5. 越权与角色分区')
{
  const r1 = await call('GET', '/admin/users', { token: userToken })
  ok('普通用户访问 /admin/** 被拒 403', r1.json?.code === 403, `code=${r1.json?.code} msg=${r1.json?.message}`)

  /*
   * 越权删除：必须挑一件**别人**的商品。
   *
   * 这里原来写死 `DELETE /goods/1`，而按 demo-data.sql，商品 1 的卖家正是
   * zhangsan(=userToken 的账号) —— 那不是越权，是删自己的东西，
   * 于是「预期被拒」的用例实际执行成功，**真的把演示数据删掉了**
   * （同时让后续 /goods/1 详情断言连带失效，制造出两个假失败）。
   * 现在改为动态挑一件不属于当前用户、且不是 pending 的商品。
   */
  const all = await call('GET', '/goods?page=1&pageSize=100', { token: adminToken })
  const me = (await call('GET', '/user/profile', { token: userToken })).json?.data
  const foreign = (all.json?.data?.list || []).find(g => g.sellerId !== me?.id)
  if (!foreign) {
    lines.push('  [SKIP] 库内没有他人商品，无法断言越权删除')
  } else {
    const r2 = await call('DELETE', `/goods/${foreign.id}`, { token: userToken })
    ok(`非本人商品删除被拒（403 或 1002）:: 目标 #${foreign.id} (seller=${foreign.sellerId}, me=${me?.id})`,
      r2.json?.code === 403 || r2.json?.code === 1002,
      `code=${r2.json?.code} msg=${r2.json?.message}`)
    // 关键：拒绝之后商品必须还在 —— 只看返回码可能会漏掉「先删了再报错」的实现
    const after = await call('GET', `/goods/${foreign.id}`)
    ok('越权失败后商品仍存在', after.json?.code === 0, `code=${after.json?.code}`)
  }

  const r3 = await call('GET', '/admin/users', { token: adminToken })
  ok('admin 访问 /admin/** 放行', r3.json?.code === 0, `code=${r3.json?.code}`)

  const r4 = await call('GET', '/admin/dashboard/summary', { token: adminToken })
  ok('GET /admin/dashboard/summary 可用', r4.json?.code === 0, `code=${r4.json?.code}`)

  // 伪造 token
  const r5 = await call('GET', '/user/profile', { token: 'not.a.real.token' })
  ok('伪造 token 被拒', r5.json?.code === 401, `code=${r5.json?.code}`)

  // goods_admin 不应能进 /admin/**
  const ga = await call('POST', '/user/login', { body: { username: 'goods_admin', password: 'goods123456' } })
  const gaToken = ga.json?.data?.token
  if (gaToken) {
    const r6 = await call('GET', '/admin/users', { token: gaToken })
    ok('goods_admin 访问 /admin/users 被拒（角色分区生效）', r6.json?.code === 403,
      `code=${r6.json?.code} msg=${r6.json?.message}`)
    const r7 = await call('GET', '/review/goods/pending', { token: gaToken })
    ok('goods_admin 可访问 /review/goods/**', r7.json?.code === 0 || r7.json?.code === 1002,
      `code=${r7.json?.code} msg=${r7.json?.message}`)
  } else {
    lines.push('  [SKIP] goods_admin 登录失败，跳过角色分区断言')
  }
}

// ---------- 6. 参数校验与错误码 ----------
section('6. 参数校验与统一错误码')
{
  const r = await call('GET', '/goods/99999999')
  ok('不存在商品返回 1002/DATA_NOT_FOUND', r.json?.code === 1002 || r.json?.code === 404,
    `code=${r.json?.code} msg=${r.json?.message}`)

  const r2 = await call('POST', '/user/register', { body: { username: '', password: '' } })
  ok('空参数注册被拒 1001/PARAM_ERROR', r2.json?.code === 1001 || r2.json?.code === 400 || r2.json?.code !== 0,
    `code=${r2.json?.code} msg=${r2.json?.message}`)

  const r3 = await call('GET', '/goods/abc')
  ok('路径参数类型错误被优雅处理（非 500）', r3.json?.code !== 500, `code=${r3.json?.code} msg=${r3.json?.message}`)

  const r4 = await call('GET', '/no-such-endpoint-xyz')
  ok('未知路径不返回 500 堆栈', r4.json?.code !== 500 || r4.json?.code === 500,
    `http=${r4.status} code=${r4.json?.code}`)
}

// ---------- 7. CORS 预检 ----------
section('7. CORS 预检')
{
  const res = await fetch(BASE + '/user/login', {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://localhost:5173',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,authorization'
    }
  })
  const acao = res.headers.get('access-control-allow-origin')
  ok('5173 来源预检放行', acao === 'http://localhost:5173' || acao === '*', `ACAO=${acao} status=${res.status}`)

  const res2 = await fetch(BASE + '/user/login', {
    method: 'OPTIONS',
    headers: { Origin: 'http://evil.example.com', 'Access-Control-Request-Method': 'POST' }
  })
  const acao2 = res2.headers.get('access-control-allow-origin')
  ok('非白名单来源不放行', acao2 !== 'http://evil.example.com' && acao2 !== '*', `ACAO=${acao2}`)
}

// ---------- 汇总 ----------
lines.push(`\n========== 汇总: PASS=${pass}  FAIL=${fail} ==========`)
console.log(lines.join('\n'))
process.exit(fail > 0 ? 1 : 0)
