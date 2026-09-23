/**
 * 独立验证 ①：普通卖家能否自己通过自己的商品？
 * ------------------------------------------------------------------
 * 静态结论：reviewGoods 内部只校验「必须是 pending」，无角色校验；
 * 唯一挡住卖家的是 AuthInterceptor 对 /review/goods/** 的角色规则
 * （ROLE_GOODS_AUDIT = admin | goods_admin）。卖家角色应被 403 挡在门外。
 *
 * 本脚本动态证明：造一个临时卖家账号 + 它自己的一件 pending 临时商品，
 * 用该卖家 token 调 POST /api/review/goods/{自己商品的id}/review {"action":"approve"}，
 * 记录响应的 code 与 message，并复核该临时商品状态未被改动。
 *
 * 红线：
 *   - 不碰商品 #12（保持 pending）。
 *   - 临时账号/商品用 ASCII 独特前缀 __VERIFY_SELLER__ / __VERIFY_GOOD__。
 *   - 测完按精确主键删干净并复查（不只凭“已删”）。
 *   - 不停止 8080、不跑 package、只发少量 HTTP。
 *
 * 运行：node .workbuddy/verify-seller-selfapprove.mjs
 */
import { execFileSync } from 'node:child_process';

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8080/api';
const MYSQL = process.env.MYSQL_BIN || 'D:/Program Files/MySQL/MySQL Server 8.0/bin/mysql.exe';
const DB = { host: '127.0.0.1', user: 'root', pass: '123456', name: 'campus_market' };

// 本机设了 HTTP_PROXY，Node fetch 必须显式清空，否则 502
process.env.HTTP_PROXY = '';
process.env.http_proxy = '';
process.env.HTTPS_PROXY = '';
process.env.https_proxy = '';

const SELLER_U = '__VERIFY_SELLER__';
const GOOD_T = '__VERIFY_GOOD__';

function mysql(sql) {
  return execFileSync(MYSQL, ['-h' + DB.host, '-u' + DB.user, '-p' + DB.pass, DB.name],
    { input: sql + '\n', encoding: 'utf8' });
}
/** SELECT 单行单列 */
function scalar(sql) {
  const out = mysql(sql).trim().split('\n');
  return out.length > 1 ? out[1].trim() : null;
}

async function call(method, path, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(BASE + path, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { httpStatus: res.status, json, text };
}

let sellerId = null;
let goodId = null;
const lines = [];
const log = (s) => lines.push(s);

try {
  // ---- 基线：商品 #12 必须仍是 pending ----
  const p12Before = scalar("SELECT status FROM t_goods WHERE id=12");
  log(`[基线] 商品#12 状态=${p12Before}（必须 pending）`);

  // ---- 取 zhangsan 的 BCrypt 哈希，复制给临时卖家（用同一口令 123456 登录）----
  const zhangsanHash = scalar("SELECT password FROM t_user WHERE username='zhangsan'");
  if (!zhangsanHash) throw new Error('未取到 zhangsan 的密码哈希，无法构造临时卖家');

  // ---- 造临时卖家账号（role=seller）----
  mysql(`INSERT INTO t_user (username, password, nickname, role, status, token_version, credit_score)
         VALUES ('${SELLER_U}', '${zhangsanHash}', '${SELLER_U}', 'seller', 'active', 0, 100);`);
  sellerId = Number(scalar(`SELECT id FROM t_user WHERE username='${SELLER_U}'`));
  log(`[造] 临时卖家 ${SELLER_U} id=${sellerId} role=seller`);

  // ---- 用 123456 登录拿 token ----
  const loginRes = await call('POST', '/user/login', { body: { username: SELLER_U, password: '123456' } });
  if (loginRes.json?.code !== 0 || !loginRes.json?.data?.token) {
    throw new Error(`临时卖家登录失败: code=${loginRes.json?.code} msg=${loginRes.json?.message}`);
  }
  const sellerToken = loginRes.json.data.token;
  const sellerRole = loginRes.json.data.user?.role;
  log(`[登录] ${SELLER_U} role=${sellerRole}（期望 seller）`);

  // ---- 造临时 pending 商品，归该卖家所有 ----
  mysql(`INSERT INTO t_goods (title, price, status, stock, seller_id, seller_name, category_id, category_name)
         VALUES ('${GOOD_T}', 1.23, 'pending', 1, ${sellerId}, '${SELLER_U}', 1, 'probe');`);
  goodId = Number(scalar(`SELECT id FROM t_goods WHERE title='${GOOD_T}'`));
  const statusBefore = scalar(`SELECT status FROM t_goods WHERE id=${goodId}`);
  log(`[造] 临时商品 ${GOOD_T} id=${goodId} status=${statusBefore}（必须 pending，归卖家 ${sellerId}）`);

  // ---- 核心动作：卖家用自己 token 调审核通过入口 ----
  const r = await call('POST', `/review/goods/${goodId}/review`,
    { token: sellerToken, body: { action: 'approve' } });
  const statusAfter = scalar(`SELECT status FROM t_goods WHERE id=${goodId}`);

  log(`[请求] POST /api/review/goods/${goodId}/review  body={"action":"approve"}  role=${sellerRole}`);
  log(`[响应] HTTP=${r.httpStatus}  body.code=${r.json?.code}  body.message=${r.json?.message ?? '(空)'}`);
  log(`[库内] 商品状态 前=${statusBefore} 后=${statusAfter}  →  ${statusBefore === statusAfter ? '未改动(预期)' : '被改动(异常!)'}`);

  // ---- 断言 ----
  const checks = [];
  const expect = (name, cond, detail) => checks.push({ name, pass: !!cond, detail });
  expect('卖家被拒(code=403)', r.json?.code === 403, `code=${r.json?.code}`);
  expect('拒绝文案精确', r.json?.message === '无权限访问该接口', `msg=${r.json?.message}`);
  expect('商品未被改动(仍pending)', statusAfter === 'pending', `status=${statusAfter}`);
  expect('#12 仍 pending', p12Before === 'pending', `p12=${p12Before}`);

  let fail = 0;
  log('\n==== 断言 ====');
  for (const c of checks) { if (!c.pass) fail++; log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.name} :: ${c.detail}`); }
  log(`\n==== 结论: ${fail === 0 ? '卖家无法自己通过自己商品（拦截成立）' : fail + ' 项不通过'} ====`);
} finally {
  // ---- 清理：按精确主键删除自造数据 ----
  try {
    if (goodId != null) mysql(`DELETE FROM t_goods WHERE id=${goodId};`);
    if (sellerId != null) mysql(`DELETE FROM t_user WHERE id=${sellerId};`);
  } catch (e) {
    log('[清理] 删除时异常: ' + e.message);
  }
  // ---- 复查：确认无残留 ----
  const leftGoods = Number(scalar(`SELECT COUNT(*) FROM t_goods WHERE title='${GOOD_T}'`));
  const leftUser = Number(scalar(`SELECT COUNT(*) FROM t_user WHERE username='${SELLER_U}'`));
  const p12After = scalar('SELECT status FROM t_goods WHERE id=12');
  log(`\n[复查] 残留临时商品=${leftGoods}（应0）  残留临时账号=${leftUser}（应0）  商品#12=${p12After}（应pending）`);
  if (leftGoods !== 0 || leftUser !== 0) log('[复查] ⚠ 清理不彻底！');
  else log('[复查] ✅ 已复位');
}

console.log(lines.join('\n'));
process.exitCode = 0;
