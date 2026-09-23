/**
 * 全链路联通验证（真实链路：浏览器 → Vite dev server 代理 → Spring Boot → MySQL）
 * 判据：从 Vite 端口请求 /api/xxx，能拿到真实后端的响应。
 * 若代理配置有误（例如 target 填成了 '/api'），这里会表现为 500 / ECONNREFUSED。
 *
 * 端口可覆盖（默认值保持历史行为，直接 `node e2e-proxy.mjs` 无需任何配置）：
 *   E2E_VITE=http://127.0.0.1:5173  —— 默认 5199；若 dev server 用的是 vite.config 里的
 *   5173，必须显式传入，否则脚本会连不上并报 ECONNREFUSED 127.0.0.1:5199。
 */
const VITE = process.env.E2E_VITE || 'http://127.0.0.1:5199'
const BACKEND = process.env.E2E_BACKEND || 'http://127.0.0.1:8080'

let pass = 0, fail = 0
const lines = []
function ok(name, cond, extra = '') {
  if (cond) { pass++; lines.push(`  [PASS] ${name}${extra ? ' :: ' + extra : ''}`) }
  else { fail++; lines.push(`  [FAIL] ${name}${extra ? ' :: ' + extra : ''}`) }
}
const section = (t) => lines.push(`\n### ${t}`)

async function get(base, path, opts = {}) {
  const headers = {}
  if (opts.token) headers['Authorization'] = 'Bearer ' + opts.token
  const res = await fetch(base + path, { method: opts.method || 'GET', headers, body: opts.body })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: res.status, json, text, headers: res.headers }
}

// ---------- 0. Vite dev server 首页可访问 ----------
section('0. Vite dev server 基础可用性')
{
  const r = await get(VITE, '/')
  ok('首页返回 HTML', r.status === 200 && r.text.includes('<div id="app"'),
    `status=${r.status} len=${r.text.length}`)
  ok('首页注入了 dev client（确认是 dev 而非静态预览）',
    r.text.includes('/@vite/client'), `hasDevClient=${r.text.includes('/@vite/client')}`)
}

// ---------- 1. 代理转发：前端端口直接打通后端 ----------
section(`1. ★ 代理链路：${VITE.replace('http://', '')}(Vite) → ${BACKEND.replace('http://', '')}(后端) → MySQL`)
{
  const viaProxy = await get(VITE, '/api/goods?page=1&pageSize=5')
  ok('★ 经 Vite 代理请求 /api/goods 返回 JSON', !!viaProxy.json,
    `status=${viaProxy.status} ctype=${viaProxy.headers.get('content-type')}`)
  ok('★ 代理返回的是后端 Result 结构（code/message/data）',
    viaProxy.json && 'code' in viaProxy.json && 'message' in viaProxy.json,
    `code=${viaProxy.json?.code} msg=${viaProxy.json?.message}`)
  ok('★ 代理链路业务成功（code=0）', viaProxy.json?.code === 0, `code=${viaProxy.json?.code}`)

  // 直连后端做对照，确认数据一致
  const direct = await get(BACKEND, '/api/goods?page=1&pageSize=5')
  ok('★ 代理结果与直连后端完全一致',
    JSON.stringify(viaProxy.json) === JSON.stringify(direct.json),
    `proxy.total=${viaProxy.json?.data?.total} direct.total=${direct.json?.data?.total}`)

  ok('★ 数据来自 MySQL 真实库（分页体为 list）',
    Array.isArray(viaProxy.json?.data?.list),
    `keys=${Object.keys(viaProxy.json?.data || {}).join(',')}`)
}

// ---------- 2. 经代理完成登录 → 带 token 访问受保护接口 ----------
section('2. ★ 经代理走完整业务闭环')
let token = null
{
  const r = await fetch(VITE + '/api/user/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'lisi', password: '123456' })
  })
  const j = await r.json()
  ok('★ 经代理登录成功', j?.code === 0, `code=${j?.code} msg=${j?.message}`)
  token = j?.data?.token
  ok('拿到 token', !!token, token ? `len=${token.length}` : '')

  const prof = await get(VITE, '/api/user/profile', { token })
  ok('★ 经代理带 token 访问 /user/profile 成功', prof.json?.code === 0, `code=${prof.json?.code}`)
  ok('代理链路未篡改响应体（user.username 正确）',
    prof.json?.data?.username === 'lisi', `username=${prof.json?.data?.username}`)

  const fav = await get(VITE, '/api/user/favorites', { token })
  ok('★ 经代理访问 /user/favorites 成功', fav.json?.code === 0, `code=${fav.json?.code}`)

  const hist = await get(VITE, '/api/user/history', { token })
  ok('★ 经代理访问 /user/history 成功', hist.json?.code === 0, `code=${hist.json?.code}`)
  const hl = hist.json?.data?.list || []
  if (hl.length) {
    const g = hl[0].goods || hl[0]
    ok('★ 历史内嵌 goods 带 status/stock（前端标记依赖）',
      'status' in g && 'stock' in g, `status=${g.status} stock=${g.stock}`)
  } else {
    lines.push('  [SKIP] 历史为空')
  }

  const unauth = await get(VITE, '/api/user/profile')
  ok('★ 经代理未登录仍被拦 401', unauth.json?.code === 401, `code=${unauth.json?.code}`)
}

// ---------- 3. 错误码语义（本轮修复验证） ----------
section('3. ★ 错误码语义修复验证（500 只留给真故障）')
{
  const nf = await get(VITE, '/api/goods/99999999')
  ok('★ 商品不存在 → 404（原为 500）', nf.json?.code === 404,
    `code=${nf.json?.code} msg=${nf.json?.message}`)

  const bad = await fetch(VITE + '/api/user/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'lisi', password: 'definitely-wrong' })
  })
  const bj = await bad.json()
  ok('★ 密码错误 → 1001 而非 500 / 401', bj?.code === 1001,
    `code=${bj?.code} msg=${bj?.message}`)

  const self = await fetch(VITE + '/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ goodsId: 99999999, quantity: 1 })
  })
  const sj = await self.json()
  ok('★ 下单不存在商品 → 404（原为 500）', sj?.code === 404, `code=${sj?.code} msg=${sj?.message}`)

  const wrong = await get(VITE, '/api/goods/abc')
  ok('★ 路径参数类型错 → 1001', wrong.json?.code === 1001, `code=${wrong.json?.code}`)

  // 未知路由的两种形态：
  //   未登录 → 401「未登录」：拦截器覆盖 /**，先判身份，不泄露「这个路由到底存不存在」
  //   已登录 → 404「接口不存在」：请求穿过拦截器后才由 NoResourceFoundException 兜底
  // 前者的 401 是**刻意的防路由枚举**，不是错误码错位。
  const ghost = await get(VITE, '/api/no-such-endpoint')
  ok('★ 未登录访问未知路由 → 401（防路由枚举，先判身份）', ghost.json?.code === 401,
    `code=${ghost.json?.code} msg=${ghost.json?.message}`)

  const ghostAuth = await get(VITE, '/api/no-such-endpoint', { token })
  ok('★ 已登录访问未知路由 → 404 接口不存在', ghostAuth.json?.code === 404,
    `code=${ghostAuth.json?.code} msg=${ghostAuth.json?.message}`)
}

// ---------- 4. 安全：越权 / 角色分区（经代理） ----------
section('4. ★ 安全边界（经代理复核）')
{
  const adm = await get(VITE, '/api/admin/users', { token })
  ok('★ 普通用户访问 /admin/** → 403', adm.json?.code === 403, `code=${adm.json?.code}`)

  const fake = await get(VITE, '/api/user/profile', { token: 'aaa.bbb.ccc' })
  ok('★ 伪造 token → 401', fake.json?.code === 401, `code=${fake.json?.code}`)
}

lines.push(`\n========== 汇总: PASS=${pass}  FAIL=${fail} ==========`)
console.log(lines.join('\n'))
process.exit(fail > 0 ? 1 : 0)
