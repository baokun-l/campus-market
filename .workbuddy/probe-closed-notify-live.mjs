/**
 * D-ALIPAY 收官 · 缺陷④ 真机探针 B：**走真实回调入口的端到端验证**。
 *
 * 场景（真实可达，不是编造）：用户卡在超时关单前后付款 —— 我们的 timeout job 已把
 * 支付单写成 closed、订单写成 cancelled，而渠道的回调此刻才到。
 *
 * 链路：POST /api/pay/notify/alipay_sandbox → 真 RSA2 验签 → app_id 闸 → 金额逐分闸
 *       → findByOutTradeNo → 渠道串号闸 → settle（closed 是合法来源）
 *       → 条件 UPDATE 翻转 success → markPaid（订单已 cancelled ⇒ affected=0）
 *       → autoRefund 接管（钱不能留在平台上）
 *
 * 断言纪律（锚「能力」，不锚字样）：
 *   ⑤ 我没去锚 notify_payload 的格式，只断言它**含这次回调的 trade_no** ——
 *      证明「这一段确实是这条回调写进去的」，而不是碰巧有个非空值。
 *   ⑦ autoRefund 的**结果**取决于渠道退款能否成功，属于外部依赖，不该写死；
 *      所以断言的是「autoRefund 确实接管了」：要么翻了 refunded，要么留下了 fail_reason。
 *      把「必须 refunded」写死就成了锚手段而非锚能力（本项目踩过这个坑）。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';

const BASE = 'http://127.0.0.1:8080/api';
const MYSQL = process.env.MYSQL_BIN || 'D:/Program Files/MySQL/MySQL Server 8.0/bin/mysql.exe';
const DB = 'campus_market';

const ORDER = '20260924090000000001';
const PAYMENT = 'pay_20260924090000000001';
const CONTROL = 'pay_20260923232542706000';
const TRADE_NO = '2026092499000000000000009999';

function q(sql) {
  return execFileSync(MYSQL, [
    '-uroot', '-p123456', '--default-character-set=utf8mb4',
    '-N', '-B', '-D', DB, '-e', sql,
  ], { encoding: 'utf8' }).trim();
}

function snapshot() {
  const pay = q(`SELECT status, IFNULL(trade_no,'<null>'), IFNULL(paid_at,'<null>'),
                        IFNULL(refund_amount,'<null>'), IFNULL(refund_time,'<null>'),
                        IFNULL(fail_reason,'<null>'), IFNULL(notify_payload,'<null>')
                 FROM t_payment WHERE id='${PAYMENT}'`).split('\t');
  const ord = q(`SELECT status, IFNULL(pay_time,'<null>'), IFNULL(pay_channel,'<null>')
                 FROM t_order WHERE id='${ORDER}'`).split('\t');
  const ctl = q(`SELECT status, IFNULL(trade_no,'<null>') FROM t_payment WHERE id='${CONTROL}'`).split('\t');
  const bal = q(`SELECT balance FROM t_user WHERE id=4`);
  return {
    payStatus: pay[0], tradeNo: pay[1], paidAt: pay[2], refundAmount: pay[3],
    refundTime: pay[4], failReason: pay[5], notifyPayload: pay[6],
    ordStatus: ord[0], ordPayTime: ord[1], ordPayChannel: ord[2],
    ctlStatus: ctl[0], ctlTradeNo: ctl[1], balance: bal,
  };
}

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  →  ${detail}`); }
}

/* ---------- 读密钥并签一条「支付宝通知」 ---------- */
const env = Object.fromEntries(
  readFileSync('campus-secondhand-backend/.env.local', 'utf8')
    .split(/\r?\n/).filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
);
const privKey = crypto.createPrivateKey({
  key: Buffer.from(env.APP_PAY_ALIPAY_PRIVATE_KEY, 'base64'), format: 'der', type: 'pkcs8',
});

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
const now = new Date();

const params = {
  app_id: env.APP_PAY_ALIPAY_APP_ID,
  charset: 'UTF-8',
  gmt_create: stamp(now),
  gmt_payment: stamp(now),
  notify_id: 'rg-probe-' + now.getTime(),
  notify_time: stamp(now),
  notify_type: 'trade_status_sync',
  out_trade_no: PAYMENT,
  seller_id: '2088721000000001',
  subject: '真机探针：关单后到达的付款',
  total_amount: '12.00',
  trade_no: TRADE_NO,
  trade_status: 'TRADE_SUCCESS',
  version: '1.0',
};

/** 与 Java 侧 AlipayRsa2.verifyNotify 逐字同口径：剔 sign 与 sign_type，其余非空参数按 ASCII 升序拼 k=v& */
function canonical(obj) {
  return Object.entries(obj)
    .filter(([k, v]) => k !== 'sign' && k !== 'sign_type' && v !== '' && v != null)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

const content = canonical(params);
const sign = crypto.createSign('RSA-SHA256').update(content, 'utf8').sign(privKey).toString('base64');
console.log('待验签规范串（与 Java 侧同口径）：');
console.log('  ' + content);
console.log('sign 长度 =', sign.length, 'chars\n');

console.log('=== POST 之前 ===');
const before = snapshot();
console.log('  ' + JSON.stringify(before, null, 0));

/* ---------- 打回调 ---------- */
const body = new URLSearchParams({ ...params, sign, sign_type: 'RSA2' });
const res = await fetch(`${BASE}/pay/notify/alipay_sandbox`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body,
});
const text = await res.text();
console.log(`\n=== 回调响应：http=${res.status} body=${JSON.stringify(text)} ===`);

console.log('\n=== POST 之后 ===');
const after = snapshot();
console.log('  ' + JSON.stringify(after, null, 0));

/* ---------- 判据 ---------- */
console.log('\n=== ④-B 判据 ===');
check('① 渠道侧收到受理（响应体必须是 success，否则支付宝会重推十几小时）', text === 'success', `body=${JSON.stringify(text)}`);
check('② 【核心】closed 支付单被结算成 success', after.payStatus === 'success', `status=${after.payStatus}`);
check('③ 渠道流水号回填', after.tradeNo === TRADE_NO, `trade_no=${after.tradeNo}`);
check('④ paid_at 落库', after.paidAt !== '<null>', `paid_at=${after.paidAt}`);
check('⑤ notify_payload 记录的确是这次回调（含本次 trade_no）', after.notifyPayload.includes(TRADE_NO), `payload=${after.notifyPayload.slice(0, 120)}`);
check('⑥ 订单未被非法推进（已 cancelled ⇒ 仍是 cancelled 且无 pay_time）',
  after.ordStatus === 'cancelled' && after.ordPayTime === '<null>',
  `status=${after.ordStatus} pay_time=${after.ordPayTime}`);
check('⑦ autoRefund 确实接管（翻了 refunded 或留下 fail_reason，二选一）',
  after.payStatus === 'refunded' || after.failReason !== '<null>',
  `status=${after.payStatus} fail_reason=${after.failReason}`);
check('⑧ 买家余额未减少（钱没有被静静留下、也没被多扣）',
  Number(after.balance) >= Number(before.balance),
  `before=${before.balance} after=${after.balance}`);
check('⑨ 真机对照组未被触碰（23:25 那笔仍是 paying、无流水号）',
  after.ctlStatus === 'paying' && after.ctlTradeNo === '<null>',
  `status=${after.ctlStatus} trade_no=${after.ctlTradeNo}`);

console.log(`\n   退款结局：status=${after.payStatus} refund_amount=${after.refundAmount} fail_reason=${after.failReason}`);

console.log(`\n=== ④-B：${pass} PASS / ${fail} FAIL ===`);
process.exit(fail === 0 ? 0 : 1);
