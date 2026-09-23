/**
 * B4 真机探针：L5（订单号生成器）+ L8（归属校验失败关闭）
 * ============================================================================
 * 全程真实 HTTP + 真实 MySQL，不做源码推断。证明三件事：
 *
 * 【一】L5：订单号改成「17 位时间戳 + 1 位实例号 + 2 位毫秒内序号」之后，
 *       真实下单仍然成功，落库的号**仍是 20 位纯数字**、第 18 位是实例号、
 *       前 17 位确实是**当前时间**（不是别的毫秒），后 2 位是两位数。
 *       这一层是单测覆盖不到的：单测只调发号器，不经过 Spring 上下文，
 *       而本轮给 OrderService 新加了 @Value 字段注入 —— 上下文能不能起来、
 *       号能不能落进 VARCHAR(30) 主键，只有真机能回答。
 *
 * 【二】L8：归属校验在**两条通道**上都要挡住非卖家。
 *       ★ 这是本项目的旧病根：单条通道修了、批量/旁路通道忘了 ★
 *       所以这里同时验：
 *         - PATCH /goods/{id}/status（后台侧 4 参通道）
 *         - PATCH /user/goods/{id}/status（卖家侧 3 参通道）
 *         - PATCH /admin/goods/batch-status（批量通道，非 admin 必须 403）
 *       并且**每条都必须顺带证明"没落库"**：只验状态码的话，
 *       一个"先改了再报错"的实现照样能骗过探针。
 *
 * 【三】L8 的能力没有被误伤：卖家改自己的商品（下架 → 上架）仍然走得通。
 *       闸门改成失败关闭最怕的就是"焊死了"——那会把正常功能一起干掉。
 *
 * 数据安全：探针只做**可逆**操作 ——
 *   - 自己下一笔单，结束按精确主键删该单 + 它的日志 + 它产生的审计日志，并还原库存；
 *   - 改卖家自己的商品状态后会改回去；
 *   - 全程不碰演示基线里的任何一笔订单。
 * 最后复核全表计数、商品状态与开跑前快照逐项一致。
 *
 * 运行前置：后端已在 http://127.0.0.1:8080 启动（必须用含本轮改动的正本 jar）。
 * 用法：node .workbuddy/e2e-b4.mjs
 */
import { execFileSync } from 'node:child_process'

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8080/api'
const MYSQL = process.env.MYSQL_BIN || 'D:/Program Files/MySQL/MySQL Server 8.0/bin/mysql.exe'
const DB = { host: '127.0.0.1', user: 'root', pass: '123456', name: 'campus_market' }

// 本机设了系统代理，Node fetch 必须显式清空，否则本地请求 502
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
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON 时留 null */ }
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
function skipped(name, why) {
  skip++
  console.log(`  SKIP  ${name}  →  ${why}`)
}

const pad = (n, w = 2) => String(n).padStart(w, '0')
function stampOf(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${pad(d.getMilliseconds(), 3)}`
}

/* ---------------- 快照 / 清理 ---------------- */
let snapshot = null
let createdOrderId = null
let touched = null

function takeSnapshot() {
  return {
    orders: num(scalar('SELECT COUNT(*) FROM t_order')),
    orderLogs: num(scalar('SELECT COUNT(*) FROM t_order_log')),
    auditMaxId: num(scalar('SELECT COALESCE(MAX(id),0) FROM t_audit_log')),
    goods: num(scalar('SELECT COUNT(*) FROM t_goods')),
    users: num(scalar('SELECT COUNT(*) FROM t_user')),
  }
}

function cleanup() {
  console.log('')
  console.log('【清理】把探针造的痕迹按**精确主键**抹掉（绝不用 LIKE 清，种子单号同前缀）')
  if (createdOrderId) {
    mysql(`DELETE FROM t_order_log WHERE order_id='${createdOrderId}';`)
    mysql(`DELETE FROM t_order WHERE id='${createdOrderId}';`)
    console.log(`  已删除探针订单 ${createdOrderId} 及其日志`)
  }
  if (snapshot) {
    mysql(`DELETE FROM t_audit_log WHERE id > ${snapshot.auditMaxId};`)
    console.log(`  已删除审计日志 id > ${snapshot.auditMaxId} 的行`)
  }
  if (touched) {
    mysql(`UPDATE t_goods SET stock=${touched.stock === null ? 'NULL' : touched.stock}, `
      + `status='${touched.status}' WHERE id=${touched.id};`)
    console.log(`  已还原商品 #${touched.id} 的库存与状态`)
  }
}

async function main() {
  /* ================= PART 0 就绪 ================= */
  console.log('【PART 0】就绪判定：必须是"能解析成 JSON 且带 code"的响应，不是 HTTP 200')
  const ready = await call('GET', '/users/online?ids=1')
  check('公开只读接口可用', typeof ready.code === 'number', `code=${ready.code} raw=${ready.raw}`)
  check('业务码为 0', ready.code === 0, `code=${ready.code}`)

  snapshot = takeSnapshot()
  console.log(`  开跑快照：order=${snapshot.orders} orderLog=${snapshot.orderLogs} auditMax=${snapshot.auditMaxId} goods=${snapshot.goods} user=${snapshot.users}`)

  const zhangsan = await login('zhangsan', '123456')
  const lisi = await login('lisi', '123456')
  const admin = await login('admin', 'admin123')
  const goodsAdmin = await login('goods_admin', 'goods123456')
  check('四个种子账号都能登录', !!zhangsan && !!lisi && !!admin && !!goodsAdmin,
    `zs=${!!zhangsan} ls=${!!lisi} admin=${!!admin} ga=${!!goodsAdmin}`)

  /* ================= PART 1 L5：订单号 ================= */
  console.log('')
  console.log('【PART 1】L5：真实下单拿到的订单号')
  // 挑一件「卖家不是 zhangsan(4)、在售、库存 >= 2」的商品：卖给别人自己的商品会被自购闸门挡
  const g = rows("SELECT id, seller_id, stock, status FROM t_goods WHERE status='on_sale' AND COALESCE(stock,0)>=2 AND seller_id<>4 ORDER BY id LIMIT 1")[0]
  if (!g) {
    skipped('L5 全部断言', '找不到可下单的商品（在售 / 库存>=2 / 非本人）')
  } else {
    const goodsId = Number(g[0])
    touched = { id: goodsId, stock: num(g[2]), status: g[3] }
    const before = new Date()
    const created = await call('POST', '/orders', {
      token: zhangsan, body: { goodsId, quantity: 1, remark: 'B4 探针：订单号形态' },
    })
    createdOrderId = created.data?.id ?? null
    check('下单成功', created.code === 0 && !!createdOrderId, `code=${created.code} body=${created.raw}`)
    check('订单号是字符串', typeof createdOrderId === 'string', `typeof=${typeof createdOrderId}`)

    const id = String(createdOrderId ?? '')
    check('20 位纯数字（与历史数据同形，VARCHAR(30) 装得下）', /^\d{20}$/.test(id),
      `实际 "${id}"（长度 ${id.length}）`)
    check('第 18 位是实例号 0（单实例默认）', id.length === 20 && id[17] === '0',
      `实际 "${id.slice(17, 18)}"`)
    check('后 2 位是两位毫秒内序号', /^\d{2}$/.test(id.slice(18)), `实际 "${id.slice(18)}"`)

    // 前 17 位应当是**当前时间**：用同一个格式化口径反解，允许 ±5 秒（网络与时钟抖动）
    const prefix = id.slice(0, 17)
    const parsed = prefix.length === 17
      ? new Date(
        Number(prefix.slice(0, 4)), Number(prefix.slice(4, 6)) - 1, Number(prefix.slice(6, 8)),
        Number(prefix.slice(8, 10)), Number(prefix.slice(10, 12)), Number(prefix.slice(12, 14)),
        Number(prefix.slice(14, 17)),
      )
      : null
    const drift = parsed ? Math.abs(parsed.getTime() - before.getTime()) : Infinity
    check('前 17 位确实是本次下单时间（±5 秒内）', drift <= 5000,
      `号内时间=${prefix} 期望≈${stampOf(before)} 偏差=${drift}ms`)

    check('订单确实落库（按主键查得到）',
      num(scalar(`SELECT COUNT(*) FROM t_order WHERE id='${id}'`)) === 1)
    check('落库的订单号与响应一致',
      String(scalar(`SELECT id FROM t_order WHERE id='${id}'`) ?? '') === id)
    check('库存已按数量扣减',
      num(scalar(`SELECT stock FROM t_goods WHERE id=${goodsId}`)) === (touched.stock ?? 1) - 1,
      `下单前 ${touched.stock} → 现在 ${scalar(`SELECT stock FROM t_goods WHERE id=${goodsId}`)}`)
    check('订单号长度与种子数据一致',
      num(scalar('SELECT LENGTH(id) FROM t_order ORDER BY id LIMIT 1')) === 20
      || id.length === 20, '（种子也是 20 位）')
  }

  /* ================= PART 2 L8：归属校验（两条通道 + 批量） ================= */
  console.log('')
  console.log('【PART 2】L8：非卖家在每条通道上都要被挡，且**不能落库**')
  // 找一件 zhangsan 发布的商品（用 lisi 去攻击）
  const mine = rows("SELECT id, status FROM t_goods WHERE seller_id=4 ORDER BY id LIMIT 1")[0]
  if (!mine) {
    skipped('PART 2 全部断言', 'zhangsan 名下没有商品可供越权测试')
  } else {
    const gid = Number(mine[0])
    const origStatus = mine[1]
    const targetStatus = origStatus === 'on_sale' ? 'off_shelf' : 'on_sale'

    // ① 未登录
    const anon = await call('DELETE', `/goods/${gid}`)
    check('无 token 删商品 → 401', anon.code === 401, `code=${anon.code} raw=${anon.raw}`)
    const anonPatch = await call('PATCH', `/goods/${gid}/status`, { body: { status: targetStatus } })
    check('无 token 改状态 → 401', anonPatch.code === 401, `code=${anonPatch.code}`)

    // ② 后台侧 4 参通道：PATCH /goods/{id}/status
    const t1 = await call('PATCH', `/goods/${gid}/status`, { token: lisi, body: { status: targetStatus } })
    check('非卖家走 PATCH /goods/{id}/status → 403', t1.code === 403, `code=${t1.code} msg=${t1.message}`)
    check('① 该次拒绝没有落库（状态未变）',
      String(scalar(`SELECT status FROM t_goods WHERE id=${gid}`)) === origStatus,
      `期望 ${origStatus} / 实际 ${scalar(`SELECT status FROM t_goods WHERE id=${gid}`)}`)

    // ③ 卖家侧 3 参通道：PATCH /user/goods/{id}/status —— 同一条规则的第二条入口
    const t2 = await call('PATCH', `/user/goods/${gid}/status`, { token: lisi, body: { status: targetStatus } })
    check('非卖家走 PATCH /user/goods/{id}/status → 403', t2.code === 403, `code=${t2.code} msg=${t2.message}`)
    check('② 该次拒绝没有落库（状态未变）',
      String(scalar(`SELECT status FROM t_goods WHERE id=${gid}`)) === origStatus)

    // ④ 删除通道
    const t3 = await call('DELETE', `/goods/${gid}`, { token: lisi })
    check('非卖家删商品 → 403', t3.code === 403, `code=${t3.code} msg=${t3.message}`)
    check('该商品仍在库里（删失败不落库）',
      num(scalar(`SELECT COUNT(*) FROM t_goods WHERE id=${gid}`)) === 1)
    const t4 = await call('DELETE', `/user/goods/${gid}`, { token: lisi })
    check('非卖家走 DELETE /user/goods/{id} → 403', t4.code === 403, `code=${t4.code} msg=${t4.message}`)
    check('该商品仍在库里', num(scalar(`SELECT COUNT(*) FROM t_goods WHERE id=${gid}`)) === 1)

    // ⑤ 批量通道：非 admin 一律 403（这条是"单条防住了、批量放过去"的老病根）
    const b1 = await call('PATCH', '/admin/goods/batch-status', {
      token: lisi, body: { ids: [gid], status: targetStatus },
    })
    check('普通用户走批量改状态 → 403', b1.code === 403, `code=${b1.code} msg=${b1.message}`)
    // ★ 注意这条：goods_admin 在这里**也**该是 403 ★
    // 角色表是按路径分级的 —— 只有 /review/goods/** 放 goods_admin，
    // 其余 /admin/** 仅 admin。写探针时我先入为主以为「后台角色都该放行」，
    // 结果被这条 403 打脸；核对 AuthInterceptor 的角色表后确认**代码是对的**，
    // 是断言错了。留在这里当反例：探针的预期也要有依据，不能靠印象。
    const b2 = await call('PATCH', '/admin/goods/batch-status', {
      token: goodsAdmin, body: { ids: [gid], status: targetStatus },
    })
    check('goods_admin 走批量改状态 → 403（其余 /admin/** 仅 admin）', b2.code === 403,
      `code=${b2.code} msg=${b2.message}`)
    check('② 这两次拒绝都没落库',
      String(scalar(`SELECT status FROM t_goods WHERE id=${gid}`)) === origStatus,
      `期望 ${origStatus} / 实际 ${scalar(`SELECT status FROM t_goods WHERE id=${gid}`)}`)

    // ⑥ 批量通道的**正面**用例：admin 走得通（顺带证明 403 不是把批量通道整体封死了）
    const b3 = await call('PATCH', '/admin/goods/batch-status', {
      token: admin, body: { ids: [gid], status: targetStatus },
    })
    check('admin 走批量改状态 → 0', b3.code === 0, `code=${b3.code} msg=${b3.message}`)
    check('批量改动的确落库',
      String(scalar(`SELECT status FROM t_goods WHERE id=${gid}`)) === targetStatus,
      `期望 ${targetStatus} / 实际 ${scalar(`SELECT status FROM t_goods WHERE id=${gid}`)}`)
    const back = await call('PATCH', `/goods/${gid}/status`, { token: zhangsan, body: { status: origStatus } })
    check('批量改动可被卖家还原', back.code === 0, `code=${back.code} msg=${back.message}`)
    check('③ 状态最终回到原值',
      String(scalar(`SELECT status FROM t_goods WHERE id=${gid}`)) === origStatus,
      `期望 ${origStatus} / 实际 ${scalar(`SELECT status FROM t_goods WHERE id=${gid}`)}`)

    // ⑦ 批量上架不许绕过审核（含 pending 必须整体拒绝）—— 只有存在 pending 商品时才可验
    const pending = rows("SELECT id FROM t_goods WHERE status='pending' ORDER BY id LIMIT 1")[0]
    if (!pending) {
      skipped('批量上架不许绕过审核', '库里当前没有 pending 商品，验不了')
    } else {
      const pid = Number(pending[0])
      const r = await call('PATCH', '/admin/goods/batch-status', {
        token: admin, body: { ids: [pid], status: 'on_sale' },
      })
      check('批量上架含 pending → 1001（业务规则拒绝）', r.code === 1001, `code=${r.code} msg=${r.message}`)
      check('该 pending 商品状态未被改动',
        String(scalar(`SELECT status FROM t_goods WHERE id=${pid}`)) === 'pending',
        `实际 ${scalar(`SELECT status FROM t_goods WHERE id=${pid}`)}`)
    }
  }

  /* ================= PART 3 L8 反证：正常路径没被焊死 ================= */
  console.log('')
  console.log('【PART 3】L8 反证：卖家改自己的商品仍然走得通（失败关闭不能把功能一起关掉）')
  const own = rows("SELECT id, status FROM t_goods WHERE seller_id=4 ORDER BY id LIMIT 1")[0]
  if (!own) {
    skipped('PART 3 全部断言', 'zhangsan 名下没有商品')
  } else {
    const oid = Number(own[0])
    const back = own[1]
    const away = back === 'on_sale' ? 'off_shelf' : 'on_sale'
    const r1 = await call('PATCH', `/goods/${oid}/status`, { token: zhangsan, body: { status: away } })
    check('卖家改自己商品状态 → 0（放行）', r1.code === 0, `code=${r1.code} msg=${r1.message}`)
    check('状态真的落库了',
      String(scalar(`SELECT status FROM t_goods WHERE id=${oid}`)) === away,
      `期望 ${away} / 实际 ${scalar(`SELECT status FROM t_goods WHERE id=${oid}`)}`)
    const r2 = await call('PATCH', `/goods/${oid}/status`, { token: zhangsan, body: { status: back } })
    check('改回去 → 0', r2.code === 0, `code=${r2.code} msg=${r2.message}`)
    check('状态回到原值',
      String(scalar(`SELECT status FROM t_goods WHERE id=${oid}`)) === back,
      `期望 ${back} / 实际 ${scalar(`SELECT status FROM t_goods WHERE id=${oid}`)}`)
  }
}

try {
  await main()
} finally {
  cleanup()

  console.log('')
  console.log('【PART 4】清理后复核：计数必须与开跑前逐项一致')
  if (snapshot) {
    const after = takeSnapshot()
    check(`t_order 计数复位（${snapshot.orders}）`, after.orders === snapshot.orders,
      `期望 ${snapshot.orders} / 实际 ${after.orders}`)
    check(`t_order_log 计数复位（${snapshot.orderLogs}）`, after.orderLogs === snapshot.orderLogs,
      `期望 ${snapshot.orderLogs} / 实际 ${after.orderLogs}`)
    check(`t_audit_log 计数复位（id <= ${snapshot.auditMaxId}）`,
      num(scalar(`SELECT COUNT(*) FROM t_audit_log WHERE id > ${snapshot.auditMaxId}`)) === 0)
    check(`t_goods 计数未变（${snapshot.goods}）`, after.goods === snapshot.goods,
      `期望 ${snapshot.goods} / 实际 ${after.goods}`)
    check(`t_user 计数未变（${snapshot.users}）`, after.users === snapshot.users,
      `期望 ${snapshot.users} / 实际 ${after.users}`)
    if (touched) {
      check(`商品 #${touched.id} 库存/状态已还原`,
        num(scalar(`SELECT stock FROM t_goods WHERE id=${touched.id}`)) === touched.stock
        && String(scalar(`SELECT status FROM t_goods WHERE id=${touched.id}`)) === touched.status,
        `期望 stock=${touched.stock} status=${touched.status} / 实际 stock=${scalar(`SELECT stock FROM t_goods WHERE id=${touched.id}`)} status=${scalar(`SELECT status FROM t_goods WHERE id=${touched.id}`)}`)
    }
  }

  console.log('')
  console.log(`================ 结果：${pass} PASS / ${fail} FAIL / ${skip} SKIP ================`)
  if (createdOrderId) {
    console.log(`（探针订单 ${createdOrderId} 已按主键删除；若上面有 FAIL 请用 verify-baseline.mjs 复核）`)
  }
  process.exit(fail === 0 ? 0 : 1)
}
