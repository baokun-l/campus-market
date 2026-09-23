/**
 * 真机探针：游客可达面（B3-d · M7 游客能力，选 B「放开游客浏览」）
 *
 * ============================================================
 * ★ 为什么这个探针必须跑真机，单测和静态审计都替代不了 ★
 * ============================================================
 *   · 静态审计（audit-guest-requests.mjs）只回答「前端会不会**发**这个请求」；
 *     它看不到后端认不认、更看不到**响应体里带了什么字段**。
 *   · 单测跑在 mock 上，连 HTTP 都不发。
 * 本探针回答的是另外两件只有真机才知道的事：
 *   ① 放开游客浏览之后，**匿名访客到底能读到哪些数据、里面有没有隐私字段**；
 *   ② 放行**只对 GET 生效**这个性质在真机上是否成立
 *      —— 这是最关键的一条：白名单里的商品详情通配路径，
 *        一旦有人图省事把它挪回 `excludePathPatterns`（只按路径匹配），
 *        同一个 pattern 会连 `DELETE /goods/{id}` 一起放行。
 *        静态审计看不到这一层，只有真机打过去才知道。
 *
 * ============================================================
 * ★★ 本探针的核心设计：必须能自证、且必须会报红 ★★
 * ============================================================
 *   · 【自证】隐私扫描统计「扫了多少个响应、多少个键」并断言 > 0。
 *     否则一旦抓取失败、响应为空，扫描会「零发现」然后静默报绿
 *     —— 那是这类检查最经典的失败模式。
 *   · 【判别力】配对探针 red-probe-b3d.mjs 已证明静态审计会报红；
 *     本探针的判别力由「同路径不同方法」那一组承担：
 *     如果放行退化成了按路径匹配，PART 3 会立刻由绿转红。
 *
 * 用法：node .workbuddy/e2e-guest-surface.mjs
 * 前置：后端已在 8080 运行（serve-backend.mjs），基线未被破坏
 */
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const BASE = 'http://127.0.0.1:8080/api'
const ROOT = String.raw`C:\Users\刘宝杰\Desktop\软件开发项目实践\软件开发\实践任务3：后端开发(前后端分离)`

let pass = 0, fail = 0, skip = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; failures.push(`${name} :: ${detail}`); console.log(`  FAIL  ${name}  -> ${detail}`) }
}
function skipped(name, why) { skip++; console.log(`  SKIP  ${name}  (${why})`) }
function section(t) { console.log('\n== ' + t + ' ==') }

/** 匿名请求（**刻意不带任何 Authorization 头** —— 这正是游客的样子） */
async function anon(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON（如上传的图片） */ }
  return { status: res.status, type: res.headers.get('content-type') || '', text, json }
}

/* ============================================================
 * PART 0 · 前置：后端就绪
 * ============================================================
 * ★ 就绪判据不能是「HTTP 200」★ 本项目所有业务错误都是 HTTP 200 + body 里的 code，
 * 所以 200 根本不能说明服务起来了。判据 = 「能解析出带 code 的 JSON」，
 * 并且打的是**公开且无副作用**的接口（/users/online）。
 */
section('PART 0 · 前置')
{
  let ready = null
  for (let i = 0; i < 40; i++) {
    try {
      const r = await anon('GET', '/users/online?ids=1')
      if (r.json && typeof r.json.code === 'number') { ready = r.json; break }
    } catch { /* 还没起来 */ }
    await new Promise((s) => setTimeout(s, 500))
  }
  if (!ready) {
    console.log('  ★ 后端未就绪（20 秒内 /users/online 没能返回带 code 的 JSON）')
    console.log('    请先跑：node .workbuddy/serve-backend.mjs')
    process.exit(1)
  }
  check('P0 后端已就绪（能解析出带 code 的 JSON，而不是只看 HTTP 200）', true,
    `code=${ready.code}`)
}

/* ============================================================
 * PART 1 · 匿名可读面（正面）：每条放行的业务 GET 都要真能通
 * ============================================================
 * 后端白名单里的浏览类接口，从游客视角走一遍。
 * 这里用的是**自举**取 id：先匿名拉商品列表，从响应里取真实 id，
 * 而不是硬编码 1/2/3 —— 硬编码会让探针在数据变了之后"报绿但什么都没验"。
 */
section('PART 1 · 匿名可读面（游客能看的）')

let goodsId = null, sellerId = null, noticeId = null, uploadCover = null
const readResponses = [] // 供 PART 2 扫描

{
  const g = await anon('GET', '/goods?page=1&pageSize=12')
  check('1-1 GET /goods 匿名可达', g.json?.code === 0, `code=${g.json?.code} msg=${g.json?.message}`)
  readResponses.push({ label: 'GET /goods', body: g.json })

  const list = g.json?.data?.list
  if (Array.isArray(list) && list.length) {
    const first = list.find((x) => x && x.id != null) || list[0]
    goodsId = first.id
    sellerId = first.sellerId
    uploadCover = list.map((x) => x.cover).find((c) => typeof c === 'string' && c.includes('/uploads/')) || null
    console.log(`  （自举：goodsId=${goodsId} sellerId=${sellerId} 上传图=${uploadCover || '本页没有'})`)
  }
  check('1-2 商品列表非空且拿到了自举用的 id', goodsId != null && sellerId != null,
    `goodsId=${goodsId} sellerId=${sellerId}`)
  check('1-3 ★ 分页体是 {list,total,page,pageSize}（list 而非 records）',
    Array.isArray(list) && typeof g.json?.data?.total === 'number',
    `keys=${Object.keys(g.json?.data || {}).join(',')}`)

  if (goodsId != null) {
    const d1 = await anon('GET', `/goods/${goodsId}`)
    check('1-4 GET /goods/{id} 匿名可达', d1.json?.code === 0, `code=${d1.json?.code}`)
    readResponses.push({ label: `GET /goods/${goodsId}`, body: d1.json })

    const d2 = await anon('GET', `/goods/${goodsId}/detail`)
    check('1-5 GET /goods/{id}/detail 匿名可达', d2.json?.code === 0, `code=${d2.json?.code}`)
    readResponses.push({ label: `GET /goods/${goodsId}/detail`, body: d2.json })

    const c = await anon('GET', `/goods/${goodsId}/comments`)
    check('1-6 GET /goods/{id}/comments 匿名可达', c.json?.code === 0, `code=${c.json?.code}`)
    readResponses.push({ label: `GET /goods/${goodsId}/comments`, body: c.json })

    const rv = await anon('GET', `/goods/${goodsId}/reviews`)
    check('1-7 GET /goods/{id}/reviews 匿名可达', rv.json?.code === 0, `code=${rv.json?.code}`)
    readResponses.push({ label: `GET /goods/${goodsId}/reviews`, body: rv.json })
  }

  const cate = await anon('GET', '/categories')
  check('1-8 GET /categories 匿名可达', cate.json?.code === 0, `code=${cate.json?.code}`)
  readResponses.push({ label: 'GET /categories', body: cate.json })

  const n = await anon('GET', '/notices')
  check('1-9 GET /notices 匿名可达', n.json?.code === 0, `code=${n.json?.code} msg=${n.json?.message}`)
  readResponses.push({ label: 'GET /notices', body: n.json })
  {
    const arr = Array.isArray(n.json?.data) ? n.json.data : n.json?.data?.list
    if (Array.isArray(arr) && arr.length) noticeId = arr.find((x) => x?.id != null)?.id ?? null
  }
  if (noticeId != null) {
    const n1 = await anon('GET', `/notices/${noticeId}`)
    check('1-10 GET /notices/{id} 匿名可达', n1.json?.code === 0, `code=${n1.json?.code}`)
    readResponses.push({ label: `GET /notices/${noticeId}`, body: n1.json })
  } else {
    skipped('1-10 GET /notices/{id}', '公告列表为空，拿不到 id')
  }

  if (sellerId != null) {
    const p = await anon('GET', `/users/${sellerId}/profile`)
    check('1-11 GET /users/{id}/profile 匿名可达', p.json?.code === 0, `code=${p.json?.code}`)
    readResponses.push({ label: `GET /users/${sellerId}/profile`, body: p.json })

    const ur = await anon('GET', `/users/${sellerId}/reviews`)
    check('1-12 GET /users/{id}/reviews 匿名可达', ur.json?.code === 0, `code=${ur.json?.code}`)
    readResponses.push({ label: `GET /users/${sellerId}/reviews`, body: ur.json })
  }

  const on = await anon('GET', `/users/online?ids=${sellerId ?? 1}`)
  check('1-13 GET /users/online 匿名可达（游客也要能看卖家在不在线）',
    on.json?.code === 0, `code=${on.json?.code}`)
  readResponses.push({ label: 'GET /users/online', body: on.json })

  // 商品图：游客的 <img src> 不带 Authorization 头，所以这里也不带
  /*
   * ★ 取哪个文件：优先从商品数据里找（最贴近真实动线），找不到就**枚举上传目录** ★
   * 早先只从商品数据里找，结果种子商品的封面都是前端静态资源（不在 /uploads/ 下），
   * 这一项被 SKIP 掉了 —— 而 SKIP 掉的检查等于没做。
   * 磁盘上明明有上传产物，那就直接枚举出来用：反正要验证的是
   * 「匿名 GET /uploads/** 会不会被拦成 401」，用哪个文件不影响结论。
   */
  let uploadRel = uploadCover
  if (!uploadRel) {
    const dir = join(ROOT, 'campus-secondhand-backend/uploads')
    if (existsSync(dir)) {
      const walkAll = (d, acc = []) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const p = join(d, e.name)
          e.isDirectory() ? walkAll(p, acc) : acc.push(p)
        }
        return acc
      }
      const f = walkAll(dir)[0]
      if (f) {
        uploadRel = '/uploads/' + f.replace(dir, '').replace(/\\/g, '/').replace(/^\//, '')
        console.log(`  （上传图自举：商品数据里没有，改为枚举上传目录 -> ${uploadRel}）`)
      }
    }
  }

  if (uploadRel) {
    const up = await anon('GET', uploadRel)
    check('1-14 ★ GET /uploads/** 匿名可达且返回的是**图片**而不是 401 的 JSON',
      !up.json?.code && (up.type.includes('image') || up.text.length > 100),
      `type=${up.type} 前 60 字=${up.text.slice(0, 60)}`)
    check('1-14b 它没有被拦成 401/403 信封',
      up.json?.code !== 401 && up.json?.code !== 403, `code=${up.json?.code}`)
    // 反向：上传目录只放行 GET，往里写必须仍是 401
    for (const m of ['PUT', 'POST', 'DELETE']) {
      const w = await anon(m, uploadRel)
      check(`1-15 ${m} ${uploadRel} → 401（/uploads/** 只放行 GET，不是整条路径放开）`,
        w.json?.code === 401, `code=${w.json?.code} msg=${w.json?.message}`)
    }
  } else {
    skipped('1-14 GET /uploads/**', '商品数据与上传目录里都没有图片文件 —— 上传几张商品图后本项会自动生效')
  }
}

/* ============================================================
 * PART 2 · 隐私扫描（★ 本探针的核心）
 * ============================================================
 * 游客能读 ≠ 游客能读到隐私。逐层递归扫 PART 1 拿到的**每一个响应体**，
 * 任何一个键命中禁字段就报红，并打印出精确路径。
 */
section('PART 2 · 隐私扫描（游客能读的响应里不许有隐私字段）')

const FORBIDDEN = [
  'password', 'passwordhash', 'oldpassword', 'newpassword', 'pwd',
  'phone', 'mobile', 'telephone', 'receiverphone', 'contactphone',
  'email',
  'tokenversion', 'lastactiveat', 'showonline',
  'token', 'accesstoken', 'refreshtoken',
  'receiver', 'consignee', 'region',
  'idcard', 'realname', 'username',
]
const norm = (k) => String(k).toLowerCase().replace(/[_-]/g, '')

/** 递归收集所有键路径 */
function walk(node, trail, out) {
  if (Array.isArray(node)) {
    node.forEach((v, i) => walk(v, `${trail}[${i}]`, out))
    return
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      out.push({ key: k, path: `${trail}.${k}` })
      walk(v, `${trail}.${k}`, out)
    }
  }
}

const leaks = []
let scannedResponses = 0
let scannedKeys = 0
for (const { label, body } of readResponses) {
  if (!body) continue
  scannedResponses++
  const keys = []
  walk(body, '$', keys)
  scannedKeys += keys.length
  for (const { key, path } of keys) {
    if (FORBIDDEN.includes(norm(key))) leaks.push({ label, key, path })
  }
}

console.log(`  （自证：扫描响应 ${scannedResponses} 个、键 ${scannedKeys} 个、禁字段 ${FORBIDDEN.length} 个）`)

// ★ 自证：扫不到东西时必须报红，不能静默通过
check('2-0 ★ 自证：确实扫到了响应与键（否则下面的"无泄露"是空跑出来的）',
  scannedResponses >= 6 && scannedKeys >= 20,
  `scannedResponses=${scannedResponses} scannedKeys=${scannedKeys}`)

check('2-1 ★ 匿名可读的所有响应里没有隐私字段',
  leaks.length === 0,
  leaks.length ? leaks.map((l) => `${l.label} 的 ${l.path}`).join(' | ') : '')

if (leaks.length) {
  console.log('\n  泄露明细：')
  for (const l of leaks) console.log(`    - ${l.label}  ->  ${l.path}  (key=${l.key})`)
}

// 针对性断言：公开主页只能给白名单字段
{
  const p = readResponses.find((x) => /\/users\/\d+\/profile/.test(x.label))
  const d = p?.body?.data
  if (d && typeof d === 'object') {
    const allowed = ['id', 'nickname', 'avatar', 'creditScore', 'role', 'createTime']
    const extra = Object.keys(d).filter((k) => !allowed.includes(k))
    check('2-2 ★ /users/{id}/profile 是**白名单式取值**（只给 6 个公开字段）',
      extra.length === 0, `多出来的字段：${extra.join(',')}`)
  } else {
    check('2-2 /users/{id}/profile 取到了资料', false, '响应里没有 data 对象')
  }
}

// 针对性断言：在线名单只能给 id
{
  const o = readResponses.find((x) => x.label === 'GET /users/online')
  const d = o?.body?.data
  const arr = Array.isArray(d) ? d : (Array.isArray(d?.list) ? d.list : null)
  if (arr) {
    const offender = arr.find((x) => x && typeof x === 'object' && Object.keys(x).some((k) => norm(k) !== 'id'))
    check('2-3 ★ /users/online 只回 id（不含活跃时间/身份信息）',
      !offender, offender ? `出现了 ${JSON.stringify(offender)}` : '')
  } else {
    check('2-3 /users/online 返回可解析的列表', false, `data=${JSON.stringify(d)?.slice(0, 120)}`)
  }
}

/* ============================================================
 * PART 3 · ★★ 放行必须「按方法 + 路径」，不能退化成「只按路径」★★
 * ============================================================
 * 这一组是本探针的**判别力来源**。
 * 白名单里有商品详情的通配路径（星号段），如果白名单被挪回
 * `excludePathPatterns`（Spring 的路径匹配不区分方法），那么
 * `DELETE /goods/{id}` 会被同一个 pattern 放行 —— 任何人无需登录就能删别人的商品。
 * 这里逐条打写操作，全部必须是 401。
 */
section('PART 3 · 同路径不同方法：写操作对游客必须一律 401')

const WRITE_OPS = [
  ['POST', '/goods', { title: 'x', price: 1, categoryId: 1, description: 'x' }],
  ['PATCH', `/goods/${goodsId}/status`, { status: 'off_shelf' }],
  ['DELETE', `/goods/${goodsId}`, null],
  ['POST', `/goods/${goodsId}/comments`, { content: 'hi' }],
  ['POST', '/reports', { targetType: 'goods', targetId: goodsId, reason: 'x' }],
  ['POST', '/orders', { goodsId, quantity: 1 }],
  ['POST', '/user/favorites/toggle', { goodsId }],
  ['POST', '/user/history', { goodsId }],
  ['POST', '/messages/sessions/open', { peerId: sellerId, goodsId }],
  ['POST', '/upload/image', null],
  ['PATCH', '/user/profile', { nickname: 'x' }],
  ['PATCH', '/user/privacy', { showOnline: false }],
  ['POST', '/user/heartbeat', null],
]

for (let i = 0; i < WRITE_OPS.length; i++) {
  const [m, p, body] = WRITE_OPS[i]
  const r = await anon(m, p, body)
  check(`3-${String(i + 1).padStart(2, '0')} ${m} ${p} → 401`,
    r.json?.code === 401, `code=${r.json?.code} msg=${r.json?.message}`)
}

/* ============================================================
 * PART 4 · GET 但**不在白名单** → 仍须 401
 * ============================================================
 * 「GET 是不是就一律放行」是最容易犯的错。这里挑最有代表性的几条：
 *   · /user/**（我的数据）
 *   · /analytics/**（★ 刻意移出白名单的经营数据：GMV / 趋势 / 分类占比）
 *   · /admin/**、/messages/**、/orders/**
 */
section('PART 4 · GET 但不在白名单：仍须 401（不能"凡 GET 就放行"）')

const PROTECTED_GETS = [
  '/user/profile',
  '/user/favorites',
  '/user/history',
  '/user/addresses',
  '/user/goods',
  '/analytics/summary',
  '/analytics/trend',
  '/analytics/top-goods',
  '/analytics/category-distribution',
  '/messages/sessions',
  '/messages/unread',
  '/orders',
  '/activities',
  '/activities/active',
  '/activities/current',
  '/admin/settings',
  '/admin/users',
  '/admin/orders',
  '/admin/dashboard/summary',
  '/admin/audit-logs',
]

for (const p of PROTECTED_GETS) {
  const r = await anon('GET', p)
  check(`4-${String(PROTECTED_GETS.indexOf(p) + 1).padStart(2, '0')} GET ${p} → 401`,
    r.json?.code === 401, `code=${r.json?.code} msg=${r.json?.message}`)
}

/* ============================================================
 * PART 5 · 越权面：放行游客**不能**把别人拉到不该有的权限
 * ============================================================
 * 最典型的一条：/admin/** 对游客是 401（未登录），
 * 但对**已登录的普通学生**必须仍是 403（角色不够）。
 * 这两者走的是拦截器里两条不同的分支，改白名单时很容易一起弄坏。
 */
section('PART 5 · 认证与授权两条分支都没被放行带松')
{
  const r = await anon('GET', '/admin/settings')
  check('5-01 游客访问 /admin/settings → 401（未登录分支）', r.json?.code === 401,
    `code=${r.json?.code}`)

  // 用**不存在的账号**试登录，避免撞上登录闸门把种子账号锁掉（会毁掉演示）
  const badLogin = await anon('POST', '/user/login', { username: 'zz_guest_probe_nobody', password: 'zz-nope-1' })
  check('5-02 不存在的账号登录 → 非 0（探测登录链路仍受控）', badLogin.json?.code !== 0,
    `code=${badLogin.json?.code} msg=${badLogin.json?.message}`)

  const pub = await anon('GET', '/goods')
  check('5-03 同一时刻公开接口依旧可达（没有因为上面的失败登录被误伤）',
    pub.json?.code === 0, `code=${pub.json?.code}`)
}

/* ============================================================
 * PART 6 · 反向：放行清单不能"顺手"扩大
 * ============================================================
 * 逐条断言「**不该**被放行的路径」真的被拒 —— 尤其
 * /orders/{orderId}/review（凭订单号看评价）这种带 id 的 GET，
 * 路径形状和白名单里的 /goods/{id}/reviews 很像，最容易被误加进去。
 */
section('PART 6 · 反面对照：形状相似但**不在**白名单的 GET')
{
  const lookalikes = [
    `/orders/1/review`,
    `/orders/1/logs`,
    `/users/${sellerId}/goods`,
  ]
  for (const p of lookalikes) {
    const r = await anon('GET', p)
    check(`6-0${lookalikes.indexOf(p) + 1} GET ${p} → 401（白名单没有被"形状相似"带偏）`,
      r.json?.code === 401, `code=${r.json?.code} msg=${r.json?.message}`)
  }
}

console.log('\n==================== 结果 ====================')
console.log(`PASS=${pass}  FAIL=${fail}  SKIP=${skip}`)
if (failures.length) {
  console.log('失败明细：')
  for (const f of failures) console.log('  - ' + f)
}
process.exit(fail === 0 ? 0 : 1)
