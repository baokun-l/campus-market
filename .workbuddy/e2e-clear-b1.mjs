/**
 * 真机探针：清空失效族（N1/N2）+ 注册校验（M5）+ 删商品连带清理（L4）
 *
 * 为什么单测不够：单测里 mapper 是 mock，只证明「调了哪个方法、拼了什么 SET」，
 * 证明不了「MySQL 真的把列写成了 NULL」「连带 DELETE 真的删掉了行」。
 * 本探针直接读库比对，并全程只做 ASCII 的 SQL 断言（IS NULL / COUNT），避免管道编码噪音。
 *
 * ★ 两个已经踩过的探针自身陷阱（都会伪装成「代码有 bug」）★
 *   1. `LAST_INSERT_ID()` 是**连接级**的：每次 mysql CLI 调用都是新连接，
 *      所以「INSERT 完再单独查 LAST_INSERT_ID」拿到的是 0 —— 后续断言全部打在
 *      一个不存在的主键上，既「成功」（空集）又「残留」（脏行还在）。
 *      ⇒ 取新插入 id 必须在同一条命令里完成。
 *   2. `POST /admin/activities/restart` **不接受 id**，服务端用 `current()` 自己解析主推活动；
 *      而 `current()` 在目标被下架后会落到另一条活动上。
 *      ⇒ 想验证「重开清空标记」，必须先让 `current()` 的目标带着标记，再断言**返回的那条**。
 */
import { execSync } from 'node:child_process';

const BASE = 'http://127.0.0.1:8080/api';
const MYSQL = String.raw`C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe`;
const PROBE_GOODS_TITLE = 'probe-cascade-goods';

function sql(q) {
  const cmd = `"${MYSQL}" -uroot -p123456 --default-character-set=utf8mb4 -N -B -Dcampus_market -e "${q}"`;
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function sqlQuiet(q) {
  try { return sql(q); } catch (e) { return 'ERR:' + String(e.message).slice(0, 120); }
}
function isNull(table, idCol, id, col) {
  return sql(`SELECT ${col} IS NULL FROM ${table} WHERE ${idCol}='${id}'`) === '1';
}

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; failures.push(`${name} :: ${detail}`); console.log(`  FAIL  ${name}  -> ${detail}`); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

async function api(method, path, { token, body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, json, text };
}

const cleanupUsers = [];

// 幂等：上一次中断留下的探针数据先清掉，否则 A5「重名」会自己撞自己
sqlQuiet("DELETE FROM t_user WHERE username LIKE 'probe\\_%'");
sqlQuiet(`DELETE FROM t_goods WHERE title LIKE '${PROBE_GOODS_TITLE}%'`);

// ==================== A. M5 · 注册校验 ====================
section('A. M5 注册校验（免登录）');

{
  const r = await api('POST', '/user/register', { body: { username: 'probe_pw1', password: 'a', nickname: 'probe' } });
  check('A1 1 位口令被拒(1001) 且提示含「6」',
    r.json?.code === 1001 && /6/.test(r.json?.message || ''),
    `code=${r.json?.code} msg=${r.json?.message}`);
  check('A1b 被拒后库里没有这行', sql("SELECT COUNT(*) FROM t_user WHERE username='probe_pw1'") === '0');
}
{
  const r = await api('POST', '/user/register', { body: { username: 'probe_pw2', password: '12345', nickname: 'probe' } });
  check('A2 5 位口令被拒(1001)', r.json?.code === 1001, `code=${r.json?.code} msg=${r.json?.message}`);
}
{
  const r = await api('POST', '/user/register', { body: { username: 'ab', password: '123456', nickname: 'probe' } });
  check('A3 用户名 <4 位被拒(1001)', r.json?.code === 1001, `code=${r.json?.code} msg=${r.json?.message}`);
}
{
  const r = await api('POST', '/user/register', { body: { username: 'probe bad!', password: '123456', nickname: 'probe' } });
  check('A4 用户名含空格/符号被拒(1001)', r.json?.code === 1001, `code=${r.json?.code} msg=${r.json?.message}`);
}
{
  const r1 = await api('POST', '/user/register', { body: { username: 'probe_dup', password: '123456', nickname: 'probe' } });
  check('A5 合法注册成功(code=0)', r1.json?.code === 0, `code=${r1.json?.code} msg=${r1.json?.message}`);
  if (r1.json?.code === 0) cleanupUsers.push('probe_dup');
  const r2 = await api('POST', '/user/register', { body: { username: 'probe_dup', password: '123456', nickname: 'probe' } });
  check('A6 ★ 重名返回 1001「已被占用」而不是 500',
    r2.json?.code === 1001 && /占用/.test(r2.json?.message || ''),
    `code=${r2.json?.code} msg=${r2.json?.message}`);
}

// ==================== B. 登录 ====================
section('B. 登录后台账号');
const admin = await api('POST', '/user/login', { body: { username: 'admin', password: 'admin123' } });
const token = admin.json?.data?.token;
check('B1 admin 登录成功', !!token, `code=${admin.json?.code} msg=${admin.json?.message}`);
if (!token) { console.log('\n登录失败，后续用例无法执行'); process.exit(1); }

// ==================== C. N2 · 活动取消标记的清空 ====================
section('C. N2 活动「重开不清取消标记」');

// 先把所有活动原状快照下来，结束时逐条还原（只存数字列，避免命令行中文编码问题）
function activityRows() {
  const out = sql('SELECT id, IFNULL(enabled,0), IFNULL(start_at,0), IFNULL(duration_days,0), IFNULL(cancelled_at,0) FROM t_activity');
  if (!out) return [];
  return out.split(/\r?\n/).filter(Boolean).map(l => {
    const [id, enabled, startAt, durationDays, ca] = l.split('\t');
    return { id, enabled, startAt, durationDays, cancelledAt: ca };
  });
}
const origActivities = activityRows();
console.log('  快照 ' + origActivities.length + ' 条活动（结束时还原）');

const cur0 = await api('GET', '/activities/current', { token });
const act = cur0.json?.data?.config;
check('C0 /activities/current 可读', !!act?.id, JSON.stringify(cur0.json).slice(0, 200));
if (!act?.id) { console.log('!! 拿不到活动，中断'); process.exit(1); }
const actId = act.id;

// C1/C2：走 setEnabled 两条边（下架要写标记、重新上架要清标记）
await api('POST', `/admin/activities/${actId}/enabled`, { token, body: { enabled: false } });
check('C1 下架后 cancelled_at 已落库(NOT NULL)',
  !isNull('t_activity', 'id', actId, 'cancelled_at'),
  sqlQuiet(`SELECT IFNULL(cancelled_at,'NULL') FROM t_activity WHERE id='${actId}'`));

// ★ 旧代码在这里失败：writeCancelledMark 只是 setCancelledAt(null) + updateById ⇒ 清不掉
await api('POST', `/admin/activities/${actId}/enabled`, { token, body: { enabled: true } });
check('C2 ★ setEnabled(true) 后 cancelled_at 真的是 NULL',
  isNull('t_activity', 'id', actId, 'cancelled_at'),
  '实际 = ' + sqlQuiet(`SELECT IFNULL(cancelled_at,'NULL') FROM t_activity WHERE id='${actId}'`));

const cur1 = await api('GET', '/activities/current', { token });
check('C2b API 侧 cancelledAt 也为 null（前端 v-if 不会再渲染「已下架」）',
  cur1.json?.data?.config?.cancelledAt == null,
  'cancelledAt=' + JSON.stringify(cur1.json?.data?.config?.cancelledAt));

// C3：另一条边 —— restartFeatured。它用 current() 自解析目标，
// 所以先把「所有」活动压上下架标记，让 current() 必然落到同一条上。
const stamp = Date.now();
sqlQuiet(`UPDATE t_activity SET enabled=0, cancelled_at=${stamp}, cancelled_by='probe'`);
const forced = sql('SELECT COUNT(*) FROM t_activity WHERE cancelled_at IS NOT NULL');
check('C3 全部活动已压上下架标记', forced === String(origActivities.length), 'marked=' + forced);

const rs = await api('POST', '/admin/activities/restart', { token, body: { durationDays: 14 } });
check('C4 restart 接口返回成功', rs.json?.code === 0, `code=${rs.json?.code} msg=${rs.json?.message}`);
const restarted = rs.json?.data;
check('C4b restart 返回了被重开的活动', !!restarted?.id, JSON.stringify(rs.json).slice(0, 160));
if (restarted?.id) {
  // ★ 旧代码在这里失败：cancelledAt 只在实体上置 null，updateById 写不进库
  check(`C5 ★ restartFeatured 后 cancelled_at 真的是 NULL（目标 ${restarted.id}）`,
    isNull('t_activity', 'id', restarted.id, 'cancelled_at'),
    '实际 = ' + sqlQuiet(`SELECT IFNULL(cancelled_at,'NULL') FROM t_activity WHERE id='${restarted.id}'`));
  check('C5b restart 后该活动确实被启用', sql(`SELECT enabled FROM t_activity WHERE id='${restarted.id}'`) === '1');
}

// ==================== D. N1 · 清空后台备注 ====================
section('D. N1 后台备注「清空不生效」');

const orders = await api('GET', '/admin/orders?page=1&pageSize=1', { token });
const order = orders.json?.data?.list?.[0];
check('D0 能取到一笔订单', !!order?.id, JSON.stringify(orders.json).slice(0, 200));
const orderId = order.id;
const origNote = order.adminNote ?? null;
console.log('  订单 ' + orderId + ' 原始 adminNote = ' + JSON.stringify(origNote));

const w = await api('PATCH', `/admin/orders/${orderId}/note`, { token, body: { note: 'probe-note-1' } });
check('D1 写入备注成功', w.json?.code === 0, `code=${w.json?.code} msg=${w.json?.message}`);
check('D1b 备注已落库(NOT NULL)', !isNull('t_order', 'id', orderId, 'admin_note'));

const c = await api('PATCH', `/admin/orders/${orderId}/note`, { token, body: { note: '' } });
check('D2 清空备注接口返回成功', c.json?.code === 0, `code=${c.json?.code} msg=${c.json?.message}`);
check('D3 ★ 清空后 admin_note 真的是 NULL（旧代码会留着旧值）',
  isNull('t_order', 'id', orderId, 'admin_note'),
  '实际 = ' + sqlQuiet(`SELECT IFNULL(admin_note,'NULL') FROM t_order WHERE id='${orderId}'`));

// ==================== E. L4 · 删商品连带清留言/评价 ====================
section('E. L4 删商品连带清留言/评价');

const sellerId = sql("SELECT id FROM t_user WHERE username='zhangsan'").trim();
check('E0 取到 zhangsan 的 id', /^\d+$/.test(sellerId), sellerId);

// ★ 取新插入 id 必须与 INSERT 同一条命令（同一条连接），否则 LAST_INSERT_ID() 恒为 0
const gidRaw = sql(`INSERT INTO t_goods (title, price, seller_id, status) VALUES ('${PROBE_GOODS_TITLE}-${stamp}', 1.00, ${sellerId}, 'off_shelf'); SELECT LAST_INSERT_ID();`);
const gid = gidRaw.split(/\r?\n/).filter(Boolean).pop().trim();
check('E0b 拿到探针商品真实 id', /^\d+$/.test(gid) && gid !== '0', 'gid=' + gid);
check('E0c 探针商品确实存在',
  sql('SELECT COUNT(*) FROM t_goods WHERE id=' + gid) === '1');

sql(`INSERT INTO t_comment (goods_id, user_id, content) VALUES (${gid}, ${sellerId}, 'probe-comment')`);
sql(`INSERT INTO t_review (order_id, goods_id, from_user_id, to_user_id, rating, content) VALUES ('PROBE-ORDER', ${gid}, ${sellerId}, ${sellerId}, 5, 'probe-review')`);
check('E1 探针数据就位（1 商品 + 1 留言 + 1 评价）',
  sql('SELECT COUNT(*) FROM t_comment WHERE goods_id=' + gid) === '1'
  && sql('SELECT COUNT(*) FROM t_review WHERE goods_id=' + gid) === '1');

const zs = await api('POST', '/user/login', { body: { username: 'zhangsan', password: '123456' } });
const zsToken = zs.json?.data?.token;
check('E2 卖家 zhangsan 登录成功', !!zsToken, `code=${zs.json?.code} msg=${zs.json?.message}`);

const del = await api('DELETE', `/user/goods/${gid}`, { token: zsToken });
check('E3 删除商品接口返回成功', del.json?.code === 0, `code=${del.json?.code} msg=${del.json?.message}`);
check('E4 商品已删除', sql('SELECT COUNT(*) FROM t_goods WHERE id=' + gid) === '0');
check('E5 ★ 留言被连带删除', sql('SELECT COUNT(*) FROM t_comment WHERE goods_id=' + gid) === '0',
  '残留 ' + sqlQuiet('SELECT COUNT(*) FROM t_comment WHERE goods_id=' + gid) + ' 行');
check('E6 ★ 评价被连带删除', sql('SELECT COUNT(*) FROM t_review WHERE goods_id=' + gid) === '0',
  '残留 ' + sqlQuiet('SELECT COUNT(*) FROM t_review WHERE goods_id=' + gid) + ' 行');

// ==================== F. 复位 ====================
section('F. 复位（把探针改动的数据恢复原样）');

if (origNote != null) {
  const rb = await api('PATCH', `/admin/orders/${orderId}/note`, { token, body: { note: origNote } });
  check('F1 订单备注已还原', rb.json?.code === 0, `code=${rb.json?.code}`);
} else {
  check('F1 订单备注原本为空，保持清空态', isNull('t_order', 'id', orderId, 'admin_note'));
}

let restored = 0;
for (const r of origActivities) {
  const ca = r.cancelledAt === '0' ? 'NULL' : r.cancelledAt;
  const q = `UPDATE t_activity SET enabled=${r.enabled === '1' ? 1 : 0}, start_at=${r.startAt}, duration_days=${r.durationDays}, cancelled_at=${ca} WHERE id='${r.id}'`;
  if (!sqlQuiet(q).startsWith('ERR:')) restored++;
}
check('F2 活动状态已逐条还原', restored === origActivities.length, `restored=${restored}/${origActivities.length}`);

for (const u of cleanupUsers) sqlQuiet(`DELETE FROM t_user WHERE username='${u}'`);
check('F3 探针账号已清理', sql("SELECT COUNT(*) FROM t_user WHERE username LIKE 'probe\\_%'") === '0');

sqlQuiet('DELETE FROM t_comment WHERE goods_id=' + gid);
sqlQuiet('DELETE FROM t_review WHERE goods_id=' + gid);
sqlQuiet('DELETE FROM t_goods WHERE id=' + gid);
sqlQuiet(`DELETE FROM t_goods WHERE title LIKE '${PROBE_GOODS_TITLE}%'`);
check('F4 探针商品/留言/评价兜底清理完成',
  sql(`SELECT COUNT(*) FROM t_goods WHERE title LIKE '${PROBE_GOODS_TITLE}%'`) === '0'
  && sql('SELECT COUNT(*) FROM t_comment WHERE goods_id=' + gid) === '0'
  && sql('SELECT COUNT(*) FROM t_review WHERE goods_id=' + gid) === '0');

console.log('\n==================== 结果 ====================');
console.log(`PASS=${pass}  FAIL=${fail}`);
if (failures.length) {
  console.log('失败明细：');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(fail === 0 ? 0 : 1);
