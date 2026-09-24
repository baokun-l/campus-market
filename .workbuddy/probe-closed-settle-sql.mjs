/**
 * D-ALIPAY 收官 · 缺陷④ 真机探针 A：**SQL 层红绿对照**（真库、零残留）。
 *
 * 判据（锚「能力」，不锚字样）：
 *   能力 = 「一条 closed 的支付单仍能被结算这条 UPDATE 命中」。
 *
 * 为什么可以手写这条 SQL 而不算「用自己的断言自证」：
 *   下面 settleGreen 的语句**逐字来自真机日志里代码自己渲染出的那一行**
 *   （2026-09-24 08:41:03 对账结算时打印的 Prepared 语句）：
 *       UPDATE t_payment SET status=?,trade_no=?,paid_at=?,notify_payload=?
 *        WHERE (id = ? AND status IN (?,?,?))
 *   参数顺序 success / tradeNo / now / payload / id / created / paying / closed。
 *   所以这里执行的是**代码的 SQL**，不是我另编的一段。
 *
 * 为什么整段包在事务里再 ROLLBACK：
 *   要的是真库对这条谓词给出的**真实 affected rows**（含行锁与谓词求值），
 *   而不是改写库里的数据 —— 夹具留给下一个探针（HTTP 端到端）用。
 *
 * 红绿对照三连（一轮只验一个可观测后果）：
 *   ① settleGreen     带 closed  → 期望 1（能力在）
 *   ② settleMutant    去掉 closed → 期望 0（能力不在 —— 这就是「必须报红」的对照组）
 *   ③ markPaid        订单已 cancelled → 期望 0（订单绝不能被非法推进）
 */
import { execFileSync } from 'node:child_process';

const MYSQL = process.env.MYSQL_BIN || 'D:/Program Files/MySQL/MySQL Server 8.0/bin/mysql.exe';
const DB = 'campus_market';
const ORDER = '20260924090000000001';
const PAYMENT = 'pay_20260924090000000001';
const TRADE_NO = '2026092499000000000000009999';

function q(sql) {
  return execFileSync(MYSQL, [
    '-uroot', '-p123456', '--default-character-set=utf8mb4',
    '-N', '-B', '-D', DB, '-e', sql,
  ], { encoding: 'utf8' }).trim();
}

/** 取一行一列 */
function one(sql) {
  return q(sql).split('\n')[0];
}

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = String(actual) === String(expected);
  if (ok) { pass++; console.log(`  PASS  ${label}  →  affected=${actual}`); }
  else { fail++; console.log(`  FAIL  ${label}  →  affected=${actual}（期望 ${expected}）`); }
}

console.log('=== 夹具当前状态 ===');
console.log('  支付单 : ' + q(`SELECT id, status, IFNULL(trade_no,'<null>') FROM t_payment WHERE id='${PAYMENT}'`).split('\t').join('  |  '));
console.log('  订单   : ' + q(`SELECT id, status, IFNULL(pay_time,'<null>') FROM t_order WHERE id='${ORDER}'`).split('\t').join('  |  '));

/*
 * 三条 UPDATE + ROLLBACK 放在**同一条 mysql -e** 里：
 * 分开调用的话事务边界消失，第一条就会真的落库。
 * 每条 UPDATE 后紧跟一句 SELECT ROW_COUNT() 取值（必须紧邻，中间不能插别的语句）。
 */
const sql = `
START TRANSACTION;
UPDATE t_payment SET status='success', trade_no='${TRADE_NO}', paid_at=NOW(),
       notify_payload='[probe-A] sql-level green'
 WHERE id='${PAYMENT}' AND status IN ('created','paying','closed');
SELECT ROW_COUNT();
UPDATE t_payment SET status='success', trade_no='${TRADE_NO}', paid_at=NOW(),
       notify_payload='[probe-A] sql-level mutant'
 WHERE id='${PAYMENT}' AND status IN ('created','paying');
SELECT ROW_COUNT();
UPDATE t_order SET status='pending_ship', pay_time=NOW(), pay_channel='alipay_sandbox'
 WHERE id='${ORDER}' AND status='pending_payment';
SELECT ROW_COUNT();
ROLLBACK;
`;
const out = q(sql).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

console.log('\n=== ④-A 真机 SQL 层红绿对照（事务内，已 ROLLBACK）===');
console.log('  ① settleGreen（代码原样：IN (created,paying,closed)）');
check('closed 行被这条 UPDATE 命中', out[0], 1);
console.log('  ② settleMutant（红绿对照：IN (created,paying)，即缺陷④修复前的形态）');
check('去掉 closed 后必须命中 0（这正是修复前的行为）', out[1], 0);
console.log('  ③ markPaid（订单 status=cancelled）');
check('订单不可付 ⇒ 不推进', out[2], 0);

console.log('\n=== ROLLBACK 后复核（夹具必须原封不动）===');
const after = q(`SELECT status, IFNULL(trade_no,'<null>'), IFNULL(paid_at,'<null>') FROM t_payment WHERE id='${PAYMENT}'`);
console.log('  支付单 : ' + after.split('\t').join('  |  '));
const restored = after.split('\t')[0] === 'closed' && after.split('\t')[1] === '<null>';
check('夹具仍为 closed 且 trade_no 为空（零残留）', restored ? 1 : 0, 1);

console.log(`\n=== ④-A：${pass} PASS / ${fail} FAIL ===`);
process.exit(fail === 0 ? 0 : 1);
