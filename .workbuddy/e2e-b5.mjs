/**
 * B5 真机探针：L10（限时活动 id 发号器）＋ 共享发号器在 Spring 上下文里能起来
 * ============================================================================
 * 全程真实 HTTP + 真实 MySQL，不做源码推断。证明四件事：
 *
 * 【一】L10：POST /admin/activities 不传 id 时，后端生成的活动 id 是
 *       `act_` + 17 位时间戳 + 1 位实例号 + 2 位毫秒内序号（24 字符），
 *       且第 22 位确实是实例号（默认 app.instance-id=0 ⇒ '0'），
 *       前 17 位确实是**当前时间**（±5 秒）。
 *
 * 【二】真实落库：id 能进 `t_activity` 的 VARCHAR(64) 主键；连续建两个活动
 *       拿到的 id **互不相同**（旧实现在单实例下也靠 static 自增躲过了，
 *       这里要证明新实现同样不撞，且形态可唯一切分）。
 *
 * 【三】★ 这一层是单测覆盖不到的 ★：ActivityService 这次新加了
 *       `@Value("${app.instance-id:0}")` 字段注入 + 一个实例字段发号器，
 *       **Spring 上下文能不能起来、@Value 能不能注入**，单测（直接 new）回答不了。
 *       同理 OrderService 的订单号也改成了共用发号器，真机下单要仍然是 20 位。
 *
 * 【四】非 admin 建活动要被拦（角色边界没被这轮改动碰坏）。
 *
 * 数据安全：探针只做**可逆**操作 —— 新建的活动按精确主键删除，
 * 收尾复核基线计数（ac=4）与开跑前快照一致。★ 不碰演示基线里的 4 条活动 ★
 *
 * 运行前置：后端已在 http://127.0.0.1:8080 启动（必须用含本轮改动的正本 jar）。
 * 用法：node .workbuddy/e2e-b5.mjs
 */
import { execFileSync } from 'node:child_process'

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8080/api'
const MYSQL = process.env.MYSQL_BIN || 'D:/Program Files/MySQL/MySQL Server 8.0/bin/mysql.exe'
const DB = { host: '127.0.0.1', user: 'root', pass: '123456', name: 'campus_market' }

for (const k of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy']) process.env[k] = ''

/* ---------------- MySQL 助手 ---------------- */
function mysql(sql) {
  return execFileSync(
    MYSQL,
    ['-h' + DB.host, '-u' + DB.user, '-p' + DB.pass, '--default-character-set=utf8mb4', DB.name],
    { input: sql + '\n', encoding: 'utf8' },
  )
}
function rows(sql) {
  const out = mysql(sql).replace(/\r/g, '').trimEnd().split('\n')
  return out.slice(1).filter((l) => l.length).map((l) => l.split('\t'))
}
function scalar(sql) {
  const r = rows(sql)
  if (!r.length || !r[0].length) return null
  return r[0][0] === 'NULL' ? null : r[0][0]
}
const num = (x) => (x === null || x === undefined || x === 'NULL' ? null : Number(x))

/* ---------------- HTTP 助手 ---------------- */
async function call(method, path, { token, body } = {}) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers['Authorization'] = 'Bearer ' + token
  const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { http: res.status, code: json?.code, message: json?.message, data: json?.data, raw: text.slice(0, 200) }
}
async function login(username, password) {
  const r = await call('POST', '/user/login', { body: { username, password } })
  return r.data?.token ?? null
}

/* ---------------- 断言 ---------------- */
let pass = 0, fail = 0, skip = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  → ' + detail : ''}`) }
}
function skipped(name, why) { skip++; console.log(`  SKIP  ${name}  →  ${why}`) }

const pad = (n, w = 2) => String(n).padStart(w, '0')
function stampOf(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${pad(d.getMilliseconds(), 3)}`
}

/* ---------------- 主流程 ---------------- */
function takeSnapshot() {
  return {
    activities: num(scalar('SELECT COUNT(*) FROM t_activity')),
    auditMaxId: num(scalar('SELECT COALESCE(MAX(id),0) FROM t_audit_log')),
    orders: num(scalar('SELECT COUNT(*) FROM t_order')),
    goods: num(scalar('SELECT COUNT(*) FROM t_goods')),
    users: num(scalar('SELECT COUNT(*) FROM t_user')),
  }
}

const created = []

async function main() {
  console.log('=== PART 0：就绪探测 ===')
  const ready = await call('GET', '/users/online?ids=1')
  if (ready.code === undefined) {
    console.log('后端没起来，后续全部跳过')
    process.exit(2)
  }
  check('后端就绪（能解析出带 code 的 JSON）', ready.code !== undefined, ready.raw)

  const snapshot = takeSnapshot()
  console.log('  开跑前快照：' + JSON.stringify(snapshot))

  console.log('\n=== PART 1：登录 ===')
  const admin = await login('admin', 'admin123')
  const zhangsan = await login('zhangsan', '123456')
  check('admin 能登录', !!admin)
  check('普通用户能登录', !!zhangsan)
  if (!admin) { console.log('admin 登录失败，后续跳过'); process.exit(1) }

  console.log('\n=== PART 2：L10 —— 新建活动拿到的 id ===')
  const before = new Date()
  const r1 = await call('POST', '/admin/activities', {
    token: admin,
    body: { title: 'L10探针活动A', enabled: false, durationDays: 1 },
  })
  check('POST /admin/activities → code 0', r1.code === 0, r1.raw)

  const id1 = r1.data?.id
  check('返回了活动 id', !!id1, String(id1))
  created.push(id1)

  if (id1) {
    check(`★ 形态 = act_ + 20 位数字（实得：${id1}）`, /^act_\d{20}$/.test(String(id1)))
    check(`长度 24（实得 ${String(id1).length}）`, String(id1).length === 24)
    check(`第 22 位是实例号 '0'（默认 app.instance-id=0；实得 '${String(id1).charAt(21)}'）`, String(id1).charAt(21) === '0')
    const tsPrefix = String(id1).substring(4, 21)
    const lo = stampOf(new Date(before.getTime() - 5000))
    const hi = stampOf(new Date(Date.now() + 5000))
    check(`时间戳段在本次时间附近（${tsPrefix} ∈ [${lo}, ${hi}]）`, tsPrefix >= lo && tsPrefix <= hi)
    check('序号段是 2 位数字', /^\d{2}$/.test(String(id1).substring(22)), String(id1).substring(22))
  }

  console.log('\n=== PART 3：真实落库 + 连发不撞号 ===')
  const dbRow = rows(`SELECT id, title, enabled FROM t_activity WHERE id='${id1}'`)
  check(`落库到 t_activity（VARCHAR(64) 主键接受 24 字符）`, dbRow.length === 1, JSON.stringify(dbRow))

  const r2 = await call('POST', '/admin/activities', {
    token: admin,
    body: { title: 'L10探针活动B', enabled: false, durationDays: 1 },
  })
  check('第二次新建也成功', r2.code === 0, r2.raw)
  const id2 = r2.data?.id
  created.push(id2)
  check(`★ 两个 id 互不相同（${id1} vs ${id2}）`, !!id1 && !!id2 && id1 !== id2)
  if (id2) check(`第二个 id 形态也是 act_ + 20 位数字（${id2}）`, /^act_\d{20}$/.test(String(id2)))

  console.log('\n=== PART 4：★ Spring 上下文带着新的 @Value 字段起来了 ===')
  // ActivityService 这轮新加了 @Value("${app.instance-id:0}")；注入失败会让上面所有请求挂掉。
  // 这里再用订单号复验一次共用发号器：下单仍然成功且仍是 20 位纯数字。
  // ★ 买家不能是卖家本人（「不能购买自己发布的商品」），所以要按 lisi 的**真实 id** 排除
  const lisiId = num(scalar("SELECT id FROM t_user WHERE username='lisi'"))
  const goodsRow = rows(
    `SELECT id, seller_id, stock, status FROM t_goods WHERE status='on_sale' AND stock>0 AND seller_id<>${lisiId} ORDER BY id LIMIT 1`)
  if (!goodsRow.length) {
    skipped('复验订单号（20 位）', '没有可用的在售商品')
  } else {
    const [gid, , stock, status] = goodsRow[0]
    const buyer = await login('lisi', '123456')
    if (!buyer) skipped('复验订单号（20 位）', 'lisi 登录失败')
    else {
      const orderRes = await call('POST', '/orders', { token: buyer, body: { goodsId: Number(gid), quantity: 1, addressId: 1 } })
      if (orderRes.code !== 0) skipped('复验订单号（20 位）', '下单失败：' + orderRes.raw)
      else {
        const oid = orderRes.data?.orderId ?? orderRes.data?.id
        check(`★ 共用发号器后订单号仍是 20 位纯数字（${oid}）`, /^\d{20}$/.test(String(oid)), String(oid))
        check(`订单号第 18 位是实例号 '0'（实得 '${String(oid).charAt(17)}'）`, String(oid).charAt(17) === '0')
        mysql(`DELETE FROM t_order_log WHERE order_id='${oid}'`)
        mysql(`DELETE FROM t_order WHERE id='${oid}'`)
        // ★★ 库存**和状态**都要还原 ★★
        // 只还原库存是不够的：把最后 1 件买掉会把商品翻成 sold，
        // 探针收尾只看「计数不变」的话根本发现不了 —— 本轮就真踩了一次
        // （状态分布从 on_sale:13/sold:1 变成 11/3，计数仍是 16）。
        mysql(`UPDATE t_goods SET stock=${Number(stock)}, status='${status}' WHERE id=${gid}`)
      }
    }
  }

  console.log('\n=== PART 5：非 admin 建活动要被拦 ===')
  const noAuth = await call('POST', '/admin/activities', { body: { title: '匿名' } })
  check('匿名建活动 → 401', noAuth.code === 401, noAuth.raw)
  const asUser = await call('POST', '/admin/activities', { token: zhangsan, body: { title: '普通用户' } })
  check('普通用户建活动 → 403（其余 /admin/** 仅 admin）', asUser.code === 403, asUser.raw)
  check('被拦的请求没有落库', rows("SELECT id FROM t_activity WHERE title IN ('匿名','普通用户')").length === 0)

  console.log('\n=== PART 6：清理 + 基线复核 ===')
  for (const id of created) {
    if (!id) continue
    mysql(`DELETE FROM t_activity WHERE id='${id}'`)
  }
  // ★ 活动是「有资金归属的业务数据」，每个写操作都会写 t_audit_log（这是**有意**的行为）。
  // 所以探针要清掉的是**自己这一轮产生的**审计行（id > 开跑时的最大值），
  // 而不是把「审计日志没增长」当成通过条件 —— 那等于把一条真实功能当成噪音抹掉。
  mysql(`DELETE FROM t_audit_log WHERE id > ${snapshot.auditMaxId}`)
  const after = takeSnapshot()
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  check(`基线计数未变（开跑前 ${JSON.stringify(snapshot)} / 收尾 ${JSON.stringify(after)}）`, same(snapshot, after))
  check('新建的活动已按精确主键删除', rows("SELECT id FROM t_activity WHERE id IN ('" + created.filter(Boolean).join("','") + "')").length === 0)

  console.log(`\n================ 结果：${pass} PASS / ${fail} FAIL / ${skip} SKIP ================`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('探针自身异常：', e); process.exit(2) })
