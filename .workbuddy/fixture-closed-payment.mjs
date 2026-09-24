/**
 * D-ALIPAY 收官 · 缺陷④ 真机探针的**一次性夹具**。
 *
 * 要验证的能力：渠道回调**晚于**关单到达时，一条 status='closed' 的支付单
 * 必须仍能被 settle 翻转成 success（否则这笔钱就是「无痕进账」）。
 *
 * 为什么必须造夹具而不是拿现成的库行：
 *   真库上仅有的 3 张沙箱支付单里，1 张已在 08:41 被对账结算、另 2 张要留着做
 *   真机对照组（「未付款的绝不能被误推进」）。把对照组改成 closed 就毁掉了对照，
 *   而把已结算那张改回来则是在伪造证据。所以另起一份夹具，用完即删。
 *
 * 夹具做法：从库行「复制一份」出来（CREATE TABLE AS SELECT → 改主键与状态 → INSERT），
 *   - 结构与真行逐列一致，不手抄列名（避免漏列/错序导致默认值悄悄生效）；
 *   - 主键独立（zz_rg 前缀），因此与真数据零耦合；
 *   - `cleanup` 直接按主键删，删完校验真数据未被触碰。
 *
 * 用法：
 *   node .workbuddy/tmp/fixture-closed-payment.mjs create    # 建夹具并打印初始状态
 *   node .workbuddy/tmp/fixture-closed-payment.mjs state     # 打印夹具 + 对照组 + 买家余额
 *   node .workbuddy/tmp/fixture-closed-payment.mjs cleanup   # 删夹具并校验真数据完好
 */
import { execFileSync } from 'node:child_process';

const MYSQL = process.env.MYSQL_BIN || 'D:/Program Files/MySQL/MySQL Server 8.0/bin/mysql.exe';
const DB = 'campus_market';

export const FIXTURE_ORDER = '20260924090000000001';
export const FIXTURE_PAYMENT = 'pay_20260924090000000001';
/** 对照组：真机从未付款、且必须永远保持 paying 的那一笔（23:25 那张） */
export const CONTROL_PAYMENT = 'pay_20260923232542706000';

function q(sql) {
  return execFileSync(MYSQL, [
    '-uroot', '-p123456', '--default-character-set=utf8mb4',
    '-N', '-B', '-D', DB, '-e', sql,
  ], { encoding: 'utf8' }).trim();
}

export function state() {
  const fixturePayment = q(`SELECT id, order_id, channel, amount, status, out_trade_no,
                                  IFNULL(trade_no,'<null>'), IFNULL(paid_at,'<null>'),
                                  IFNULL(refund_amount,'<null>'), IFNULL(refund_time,'<null>'),
                                  IFNULL(fail_reason,'<null>'), LEFT(IFNULL(notify_payload,'<null>'),60)
                           FROM t_payment WHERE id='${FIXTURE_PAYMENT}'`);
  const fixtureOrder = q(`SELECT id, status, amount, buyer_id, IFNULL(pay_time,'<null>'),
                                 IFNULL(pay_channel,'<null>')
                          FROM t_order WHERE id='${FIXTURE_ORDER}'`);
  const control = q(`SELECT id, status, IFNULL(trade_no,'<null>'), IFNULL(paid_at,'<null>')
                     FROM t_payment WHERE id='${CONTROL_PAYMENT}'`);
  const balance = q(`SELECT id, username, balance FROM t_user WHERE id=4`);
  return { fixturePayment, fixtureOrder, control, balance };
}

/** 分隔符用 \x1f，避免与数据里的制表符冲突 */
function fmt(row) {
  return row.split('\t').join('  |  ');
}

const mode = process.argv[2] || 'state';

if (mode === 'create') {
  const exists = q(`SELECT COUNT(*) FROM t_payment WHERE id='${FIXTURE_PAYMENT}'`);
  if (exists !== '0') {
    console.log(`夹具已存在（${FIXTURE_PAYMENT}），先 cleanup 再 create`);
    process.exit(2);
  }
  /*
   * 复制 t_order：来源是 23:03 那张订单（同样 12 元、买家 4，且真机从未付款），
   * 只改主键与状态 —— status='cancelled' 代表「超时关单任务已经把这单关掉了」，
   * 这正是「用户卡在关单前后付款」里订单的那一半。
   */
  q(`CREATE TABLE zz_rg_order AS SELECT * FROM t_order WHERE id='20260923230310573000';
     UPDATE zz_rg_order SET id='${FIXTURE_ORDER}', status='cancelled', pay_time=NULL,
            pay_channel=NULL, cancel_reason_text='探针夹具：模拟超时关单';
     INSERT INTO t_order SELECT * FROM zz_rg_order;
     DROP TABLE zz_rg_order;
     CREATE TABLE zz_rg_payment AS SELECT * FROM t_payment WHERE id='pay_20260923230310911000';
     UPDATE zz_rg_payment SET id='${FIXTURE_PAYMENT}', order_id='${FIXTURE_ORDER}',
            out_trade_no='${FIXTURE_PAYMENT}', status='closed', trade_no=NULL,
            notify_payload=NULL, paid_at=NULL, refund_amount=NULL, refund_time=NULL,
            fail_reason=NULL,
            expire_at=DATE_SUB(NOW(), INTERVAL 30 MINUTE),
            create_time=DATE_SUB(NOW(), INTERVAL 40 MINUTE);
     INSERT INTO t_payment SELECT * FROM zz_rg_payment;
     DROP TABLE zz_rg_payment;`);
  console.log('夹具已创建');
  const s = state();
  console.log('  订单   : ' + fmt(s.fixtureOrder));
  console.log('  支付单 : ' + fmt(s.fixturePayment));
  console.log('  对照组 : ' + fmt(s.control));
  console.log('  买家   : ' + fmt(s.balance));
} else if (mode === 'cleanup') {
  q(`DELETE FROM t_payment WHERE id='${FIXTURE_PAYMENT}';
     DELETE FROM t_order   WHERE id='${FIXTURE_ORDER}';`);
  const left = q(`SELECT (SELECT COUNT(*) FROM t_payment WHERE id='${FIXTURE_PAYMENT}')
                       + (SELECT COUNT(*) FROM t_order WHERE id='${FIXTURE_ORDER}')`);
  console.log(`夹具已删除（残留行数=${left}，期望 0）`);
  const s = state();
  console.log('  夹具支付单 : ' + (s.fixturePayment || '(已不存在 ✓)'));
  console.log('  对照组     : ' + fmt(s.control));
  // 校验：真数据未被触碰 —— 对照组必须仍是 paying
  const controlOk = s.control.split('\t')[1] === 'paying';
  console.log('  对照组仍为 paying : ' + (controlOk ? 'OK ✓' : 'RED ✗'));
  console.log('  真库活跃沙箱支付单（应只剩对照组那一笔）：');
  const active = q(`SELECT id, status FROM t_payment WHERE channel='alipay_sandbox'
                    AND status IN ('created','paying') ORDER BY id`);
  console.log(active ? active.split('\n').map((l) => '    ' + l.split('\t').join('  |  ')).join('\n') : '    (无)');
} else {
  const s = state();
  console.log('=== 夹具支付单 ===');
  console.log('  ' + (s.fixturePayment ? fmt(s.fixturePayment) : '(不存在)'));
  console.log('=== 夹具订单 ===');
  console.log('  ' + (s.fixtureOrder ? fmt(s.fixtureOrder) : '(不存在)'));
  console.log('=== 真机对照组（必须永远 paying） ===');
  console.log('  ' + fmt(s.control));
  console.log('=== 买家余额 ===');
  console.log('  ' + fmt(s.balance));
}
