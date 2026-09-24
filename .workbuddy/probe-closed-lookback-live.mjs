/**
 * D-ALIPAY 收官补丁 · 真机探针：证明「closed 候选回看窗口」这一段在**真进程**里成立。
 *
 * ★ 要证明的能力 ★
 * 一笔「用户在到期前最后一两分钟付了款、通知始终不来、随后被超时关单任务关掉」的支付单，
 * 必须仍会被对账捞出来问渠道。此前它落在 closed 上，而 closed 既不是「未过期候选」，
 * 也不在任何人的待办里 —— 钱在渠道手上、订单已作废、没有代码会去退它。
 *
 * ★ 为什么单测和红绿还不够，非要真机 ★
 * 单测用 mock 的 mapper，**只能证明「条件被拼进了 SQL 字符串」**，证明不了
 * 「这条 SQL 在真的 MySQL 上能选出那一行」。而本轮的关单时刻锚点是
 * t_payment.update_time，它由 **DDL 的 ON UPDATE CURRENT_TIMESTAMP** 维护 ——
 * 也就是说，判据依赖一条**单测完全看不见的建表语句**。真机跑一遍才覆盖它。
 *
 * ★ 判据锚在哪里（三条互相独立，任一条断了都能单独定位）★
 *   ① 日志里出现**第二条** selectList，且它的条件含 update_time —— 候选查询确实多了一段；
 *   ② 窗口内夹具的 id 出现在 `reconciling a CLOSED payment` 这条 WARN 里
 *      —— 它不但被选中，还**穿过了 reconcileOne 的状态闸门**（本轮改的第二处）；
 *   ③ 窗口外夹具的 id **不出现** —— 对照组，证明「选出来」不是「把所有 closed 都拿来问」。
 *
 * ★ 对照组为什么要靠 update_time 而不是 status ★
 * 两个夹具的 status 完全一样（都是 closed），唯一差别是关单时刻是否落在回看窗口内。
 * 于是「A 出现 / B 不出现」这个差异**只能**由窗口判据解释 —— 排除了「凡是 closed 都会问」
 * 这种更宽松（也更危险）的实现侥幸通过。
 *
 * 子命令：
 *   baseline  从 dist/logs/campus-market.log 抽出**修前**证据（旧 jar 的活日志）存档
 *   stop      停掉占用 8080 的旧后端
 *   fixtures  建两个夹具（窗口内 A / 窗口外 B），不打乱真数据
 *   state     打印夹具、对照组与真库活跃沙箱支付单
 *   assert <起始时间>  从日志里抽**修后**证据并逐条断言
 *   cleanup   删夹具并校验真数据完好
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const ROOT = String.raw`C:\Users\刘宝杰\Desktop\软件开发项目实践\软件开发\实践任务3：后端开发(前后端分离)`;
const LOG = path.join(ROOT, 'campus-secondhand-backend', 'dist', 'logs', 'campus-market.log');
const EVID = path.join(ROOT, '.workbuddy', 'evidence');
const MYSQL = process.env.MYSQL_BIN || 'D:/Program Files/MySQL/MySQL Server 8.0/bin/mysql.exe';
const DB = 'campus_market';

/** 窗口内：关单时刻 = 3 分钟前 ⇒ 落在 10 分钟回看窗口里 */
export const A_ORDER = '20260924093000000001';
export const A_PAYMENT = 'pay_20260924093000000001';
/** 窗口外对照组：关单时刻 = 60 分钟前 ⇒ 明显出窗（窗口 10 分钟） */
export const B_ORDER = '20260924093000000002';
export const B_PAYMENT = 'pay_20260924093000000002';
/** 真机既有的两笔「从未付款」支付单，必须永远保持 paying（本轮不许被新分支碰到） */
export const CONTROLS = ['pay_20260923230310911000', 'pay_20260923232542706000'];

function q(sql) {
  return execFileSync(MYSQL, [
    '-uroot', '-p123456', '--default-character-set=utf8mb4',
    '-N', '-B', '-D', DB, '-e', sql,
  ], { encoding: 'utf8' }).trim();
}

const fmt = (row) => (row ? row.split('\t').join('  |  ') : '(不存在)');

function fixtureRow(id) {
  return q(`SELECT id, order_id, channel, amount, status, IFNULL(trade_no,'<null>'),
                   IFNULL(paid_at,'<null>'), IFNULL(refund_amount,'<null>'),
                   IFNULL(fail_reason,'<null>'), create_time, expire_at, update_time
            FROM t_payment WHERE id='${id}'`);
}

export function state() {
  return {
    A: fixtureRow(A_PAYMENT),
    B: fixtureRow(B_PAYMENT),
    A_order: q(`SELECT id, status FROM t_order WHERE id='${A_ORDER}'`),
    B_order: q(`SELECT id, status FROM t_order WHERE id='${B_ORDER}'`),
    controls: q(`SELECT id, status, IFNULL(trade_no,'<null>') FROM t_payment
                 WHERE id IN ('${CONTROLS.join("','")}') ORDER BY id`),
    activeSandbox: q(`SELECT id, status FROM t_payment WHERE channel='alipay_sandbox'
                      AND status IN ('created','paying') ORDER BY id`),
  };
}

/**
 * 从某一行开始、按 id 复制一个支付单（结构与真行逐列一致，不手抄列名）。
 * 关单时刻显式写进 update_time —— INSERT 时显式给值会覆盖 DEFAULT，
 * 所以窗口内/外的差别能稳定落库（不是靠运气）。
 */
function buildFixture(orderId, paymentId, srcOrder, srcPayment, minutesAgoClosed, minutesAgoExpired) {
  q(`CREATE TABLE zz_rg_order AS SELECT * FROM t_order WHERE id='${srcOrder}';
     UPDATE zz_rg_order SET id='${orderId}', status='cancelled', pay_time=NULL,
            pay_channel=NULL, cancel_reason_text='探针夹具：模拟超时关单';
     INSERT INTO t_order SELECT * FROM zz_rg_order;
     DROP TABLE zz_rg_order;

     CREATE TABLE zz_rg_payment AS SELECT * FROM t_payment WHERE id='${srcPayment}';
     UPDATE zz_rg_payment SET id='${paymentId}', order_id='${orderId}',
            out_trade_no='${paymentId}', status='closed', trade_no=NULL,
            notify_payload=NULL, paid_at=NULL, refund_amount=NULL, refund_time=NULL,
            fail_reason='支付超时，已自动关闭',
            update_time=DATE_SUB(NOW(), INTERVAL ${minutesAgoClosed} MINUTE),
            expire_at  =DATE_SUB(NOW(), INTERVAL ${minutesAgoExpired} MINUTE),
            create_time=DATE_SUB(NOW(), INTERVAL ${minutesAgoExpired + 10} MINUTE);
     INSERT INTO t_payment SELECT * FROM zz_rg_payment;
     DROP TABLE zz_rg_payment;`);
}

/** 找占用 8080 的 PID（不用 grep / PowerShell —— 本机 shim bash 没有 grep，PS 输出被吞） */
function pidOn8080() {
  const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
  const pids = new Set();
  for (const line of out.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue;
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5) continue;
    if (cols[1].endsWith(':8080')) pids.add(cols[cols.length - 1]);
  }
  return [...pids];
}

const mode = process.argv[2] || 'state';

if (mode === 'baseline') {
  fs.mkdirSync(EVID, { recursive: true });
  const lines = fs.readFileSync(LOG, 'utf8').split(/\r?\n/);
  // 取最后一个完整的对账轮：从最后一条 `finished.` 往回找到它的那条 Preparing
  const endIdx = lines.map((l, i) => ({ l, i })).filter(({ l }) => /pay-reconcile\] finished\./.test(l)).pop();
  const slice = endIdx ? lines.slice(Math.max(0, endIdx.i - 14), endIdx.i + 1) : [];
  const body = [
    '# 修前基线（旧 jar = 0494149-202609240037，不含 closed 候选）',
    '',
    '说明：这是运行中的旧后端在**默认 cron（每 2 分钟）**下的一轮对账，',
    '直接从 dist/logs/campus-market.log 摘录，不是重跑出来的。',
    '',
    '要点：',
    '  1. 只有 **一条** selectList，条件里**没有** status=closed / update_time；',
    '  2. 该轮 checked=2 —— 两笔 paying 对照参与了，closed 行完全不参与。',
    '  3. 因而「关单后那段真空期」在旧实现里确实没有任何人管。',
    '',
    '```',
    ...slice,
    '```',
  ].join('\n');
  fs.writeFileSync(path.join(EVID, 'closed-lookback-BEFORE.txt'), body, 'utf8');
  console.log(slice.join('\n'));
  console.log('\n已存档 -> .workbuddy/evidence/closed-lookback-BEFORE.txt');
} else if (mode === 'stop') {
  const pids = pidOn8080();
  if (pids.length === 0) {
    console.log('8080 上没有监听进程（无需停止）');
  } else {
    for (const pid of pids) {
      console.log(`停止旧后端 pid=${pid}`);
      try {
        execFileSync('taskkill', ['/PID', pid, '/F'], { encoding: 'utf8' });
      } catch (e) {
        console.log('  taskkill 失败：' + (e.stdout || e.message));
      }
    }
    await new Promise((r) => setTimeout(r, 3000));
    console.log('停止后 8080 监听：' + (pidOn8080().length === 0 ? '已释放 ✓' : '仍在 ✗'));
  }
} else if (mode === 'fixtures') {
  for (const id of [A_PAYMENT, B_PAYMENT]) {
    if (q(`SELECT COUNT(*) FROM t_payment WHERE id='${id}'`) !== '0') {
      console.log(`夹具已存在（${id}），先 cleanup`);
      process.exit(2);
    }
  }
  // 来源行都取自真机从未付款的沙箱单（12 元、买家 4），只改主键与状态
  buildFixture(A_ORDER, A_PAYMENT, '20260923230310573000', 'pay_20260923230310911000', 3, 30);
  buildFixture(B_ORDER, B_PAYMENT, '20260923230310573000', 'pay_20260923230310911000', 60, 90);
  console.log('夹具已建：A=窗口内(关单 3 分钟前)  B=窗口外(关单 60 分钟前)');
  const s = state();
  console.log('  A : ' + fmt(s.A));
  console.log('  B : ' + fmt(s.B));
  console.log('  对照组 paying : ' + s.controls.split('\n').map((l) => l.split('\t').join('  |  ')).join('   //   '));
} else if (mode === 'cleanup') {
  q(`DELETE FROM t_payment WHERE id IN ('${A_PAYMENT}','${B_PAYMENT}');
     DELETE FROM t_order   WHERE id IN ('${A_ORDER}','${B_ORDER}');`);
  const left = q(`SELECT (SELECT COUNT(*) FROM t_payment WHERE id IN ('${A_PAYMENT}','${B_PAYMENT}'))
                       + (SELECT COUNT(*) FROM t_order   WHERE id IN ('${A_ORDER}','${B_ORDER}'))`);
  console.log(`夹具已删除（残留行数=${left}，期望 0）`);
  const s = state();
  console.log('  对照组仍为 paying : ' +
    (s.controls.split('\n').every((l) => l.split('\t')[1] === 'paying') ? 'OK ✓' : 'RED ✗'));
  console.log('  真库活跃沙箱支付单：');
  console.log(s.activeSandbox ? s.activeSandbox.split('\n').map((l) => '    ' + l.split('\t').join('  |  ')).join('\n') : '    (无)');
} else if (mode === 'assert') {
  const since = process.argv[3];
  const until = process.argv[4] || '9999-12-31 23:59:59';
  if (!since) {
    console.error('用法：assert "YYYY-MM-DD HH:MM:SS" ["YYYY-MM-DD HH:MM:SS"]');
    console.error('  第二个参数是可选上界 —— ★ 它的用处是「把同一套判据指向修前的日志段」，');
    console.error('  那一跑**必须报红**。判据改完不证明它还能红，就等于没修（只是从假红换成了恒真）。');
    process.exit(2);
  }
  const all = fs.readFileSync(LOG, 'utf8').split(/\r?\n/);
  const lines = all.filter((l) => l.slice(0, 19) >= since && l.slice(0, 19) <= until);

  /*
   * ★★★ 判据只能锚「WHERE 子句的形状」，绝不能锚「整行里有没有某个列名」★★★
   *
   * 踩过一次假红：`update_time` 是 t_payment 的**列**，它出现在**每一条**查询的
   * SELECT 列表里（`... ,create_time,update_time FROM t_payment WHERE ...`）。
   * 于是「整行含 update_time」这个条件对闭合段和 paying 段**同时成立**，
   * 两条查询都被当成闭合段，读到的是最后一条（paying）的 Total —— 报出一个
   * 与实现无关的假红（closedTotal=2 其实是 paying 段的 2 笔）。
   *
   * 正确的锚是**条件形状**：闭合段是 `status = ? AND update_time >= ?`，
   * paying 段是 `status = ? AND expire_at IS NOT NULL AND expire_at > ? AND create_time < ?`。
   * 这正是本项目那条纪律：**锚能力/结构，不锚手段/字样。**
   */
  const CLOSED_WHERE = /AND update_time >= \?/;
  const PAYING_WHERE = /AND expire_at IS NOT NULL/;

  const prepping = lines.filter((l) => /PaymentMapper\.selectList - ==>  Preparing:/.test(l));
  const sqlOf = (l) => l.split('Preparing:')[1].trim();
  const closedQuery = prepping.filter((l) => CLOSED_WHERE.test(sqlOf(l)));
  const payingQuery = prepping.filter((l) => PAYING_WHERE.test(sqlOf(l)));

  /*
   * ★ Total 必须与它**紧邻的那条 Preparing** 配对，不能「往后找 5 行」★
   * 同一轮里 selectList 之后还会跟着 selectById（对账逐笔读支付单），
   * 它的 `<== Total:` 会被「往后找」的写法误收。用一个最小状态机：
   * 见到 Preparing 就记住它属于哪一段；随后第一条 `<== Total:` 归它，然后清空。
   */
  const totals = { closed: [], paying: [] };
  let cur = null;
  for (const l of lines) {
    const pr = l.match(/PaymentMapper\.selectList - ==>  Preparing:\s*(.*)$/);
    if (pr) {
      cur = CLOSED_WHERE.test(pr[1]) ? 'closed' : (PAYING_WHERE.test(pr[1]) ? 'paying' : null);
      continue;
    }
    const tot = l.match(/<==\s+Total:\s+(\d+)/);
    if (tot) {
      if (cur) totals[cur].push(+tot[1]);
      cur = null;
    }
  }
  const payingTotal = totals.paying.length ? totals.paying[0] : -1;
  const closedTotal = totals.closed.length ? totals.closed[0] : -1;

  const finishing = lines.filter((l) => /pay-reconcile\] finished\./.test(l));
  const closedWarn = lines.filter((l) => /reconciling a CLOSED payment/.test(l));
  const checked = finishing.length
    ? [...finishing[finishing.length - 1].matchAll(/checked=(\d+)/g)].map((m) => +m[1])[0]
    : -1;

  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  add('① 日志里出现第二条 selectList（closed 段），条件含 update_time',
    closedQuery.length >= 1,
    `命中 ${closedQuery.length} 条` + (closedQuery[0] ? ` :: ${closedQuery[0].split('Preparing:')[1].trim()}` : ''));

  add('② 窗口内夹具 A 穿过闸门（reconciling a CLOSED payment）',
    closedWarn.some((l) => l.includes(A_PAYMENT)),
    closedWarn.length ? closedWarn.map((l) => l.trim().slice(0, 150)).join('\n      ') : '(没有任何 CLOSED 对账日志)');

  add('③ 对照组：窗口外夹具 B **不出现**在闸门日志里',
    !closedWarn.some((l) => l.includes(B_PAYMENT)),
    '未命中 B ✓');

  add('④ 该轮 checked = paying 段笔数 + 窗口内 closed 笔数（B 未混入）',
    checked === payingTotal + closedTotal && closedTotal === 1 && payingTotal >= 0,
    `checked=${checked}  payingTotal=${payingTotal}  closedTotal=${closedTotal}`);

  // 副作用：两笔都必须是 NOT_PAID ⇒ 状态一个字不改
  const a = fixtureRow(A_PAYMENT);
  const b = fixtureRow(B_PAYMENT);
  const unchanged = (row) => row.split('\t')[4] === 'closed'
    && row.split('\t')[5] === '<null>' && row.split('\t')[6] === '<null>'
    && row.split('\t')[7] === '<null>';
  add('⑤ 夹具 A 仍为 closed，且 trade_no/paid_at/refund_amount 全空（NOT_PAID 零副作用）',
    unchanged(a), a);
  add('⑥ 对照组夹具 B 亦未被动过', unchanged(b), b);

  const s = state();
  add('⑦ 真机既有的两笔对照仍为 paying（新分支没有误伤在途单）',
    s.controls.split('\n').every((l) => l.split('\t')[1] === 'paying'),
    s.controls.split('\n').map((l) => l.split('\t').join('  |  ')).join('\n      '));

  fs.mkdirSync(EVID, { recursive: true });
  fs.writeFileSync(path.join(EVID, 'closed-lookback-AFTER.txt'),
    ['# 修后证据（新 jar，含 closed 候选回看窗口）', '', '起始时刻：' + since, '',
      '## 候选查询（应有两条：closed 段含 update_time；paying 段含 expire_at）', '```',
      ...prepping.map((l) => l.trim()), '```', '',
      '## 闸门日志（A 在、B 不在）', '```',
      ...closedWarn.map((l) => l.trim()), '```', '',
      '## 每轮收尾', '```',
      ...finishing.map((l) => l.trim()), '```', ''].join('\n'), 'utf8');

  for (const c of checks) {
    console.log((c.ok ? 'PASS  ' : 'RED   ') + c.name + '\n        ' + (c.detail || ''));
  }
  const pass = checks.filter((c) => c.ok).length;
  console.log(`\n${pass}/${checks.length} PASS`);
  console.log(pass === checks.length ? 'CLOSED-LOOKBACK LIVE ALL PASS' : 'CLOSED-LOOKBACK LIVE HAS FAILURE');
  process.exit(pass === checks.length ? 0 : 1);
} else {
  const s = state();
  console.log('=== 夹具 A（窗口内，应被问） ===\n  ' + fmt(s.A));
  console.log('=== 夹具 B（窗口外对照组，不应被问） ===\n  ' + fmt(s.B));
  console.log('=== A 订单 / B 订单 ===\n  ' + fmt(s.A_order) + '\n  ' + fmt(s.B_order));
  console.log('=== 真机既有对照（必须永远 paying） ===\n  ' +
    s.controls.split('\n').map((l) => '  ' + l.split('\t').join('  |  ')).join('\n'));
  console.log('=== 真库活跃沙箱支付单 ===\n  ' +
    (s.activeSandbox ? s.activeSandbox.split('\n').map((l) => l.split('\t').join('  |  ')).join('\n  ') : '(无)'));
  console.log('=== 8080 ===\n  ' + (pidOn8080().length ? 'pid=' + pidOn8080().join(',') : '无监听'));
}
