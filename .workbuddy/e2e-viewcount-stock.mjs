/**
 * 端到端取证：「浏览量自增」必须是单列原子 UPDATE（H2 的最后一处残留）
 * ----------------------------------------------------------------------------
 * 背景：`GoodsService.fetchGoodsDetail` 原本是
 *   `selectById 读整实体 → setViewCount(+1) → updateById 整体回写`。
 * 整实体回写把上面读到的**旧快照**盖回整行，于是详情页（全站写入最频繁的接口）
 * 会把「下单扣掉的库存 / 别人刚加的 favorite_count / 卖家刚改的价格」一并还原成旧值
 * —— 防超卖被旁路：A 打开详情读到 stock=1 → B 下单扣到 0 → A 把 stock=1 写回去。
 *
 * ★ 为什么单线程探针测不出来 ★
 * 丢更新需要「读」与「写」之间**有人插进来改同一行**。单线程下窗口内没人动，
 * 旧代码照样能写出正确结果。所以这里必须制造并发：
 *   N 个详情请求同时打 → 旧代码各自读到同一个 view_count、各自写回同一个值 ⇒ 净增 ≈ 1；
 *                        新代码每次都是一条 `view_count = COALESCE(view_count,0)+1` ⇒ 净增恰好 N。
 * 「净增恰好 N」是新旧实现的判别式，也是这一步唯一有说服力的断言。
 *
 * 本探针证明三件事（全程真实 HTTP + 真实 MySQL，不做源码推断）：
 *  【A】并发 N 次看详情 → view_count 净增恰好 N（原子自增，不是读改写）
 *  【B】view_count 为 NULL（老数据）时，一次详情后从 1 起算（COALESCE 真的生效，
 *        且证明 setSql 生成的 SQL 在真实 MySQL 上合法 —— 单测用 mock mapper
 *        完全绕过 wrapper→SQL 的生成过程，这一步它测不到）
 *  【C】详情页只动 view_count 一列：stock / status / favorite_count 一个字节不变
 *
 * 数据安全：开头快照 goods#1 的 (view_count, stock, status, favorite_count)，
 * 结束（含异常）一律原值还原并**再查表复核**；只碰 #1，不动演示基线 #12(pending)。
 *
 * 运行前置：后端已在 http://127.0.0.1:8080 启动（须用含本轮改动的正本 jar）。
 * 用法：node .workbuddy/e2e-viewcount-stock.mjs
 */
import { execFileSync } from 'node:child_process';

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8080/api';
const MYSQL = process.env.MYSQL_BIN || 'D:/Program Files/MySQL/MySQL Server 8.0/bin/mysql.exe';
const DB = { host: '127.0.0.1', user: 'root', pass: '123456', name: 'campus_market' };
const GOODS_ID = 1;
const CONCURRENCY = 8;

// 本机设了系统代理，Node fetch 必须显式清空，否则本地请求 502
for (const k of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy']) process.env[k] = '';

/* ---------------- MySQL 助手 ---------------- */
function mysql(sql) {
  return execFileSync(
    MYSQL,
    ['-h' + DB.host, '-u' + DB.user, '-p' + DB.pass, '--default-character-set=utf8mb4', DB.name],
    { input: sql + '\n', encoding: 'utf8' }
  );
}
function mysqlSelect(sql) {
  const out = mysql(sql);
  const lines = out.replace(/\r/g, '').trimEnd().split('\n');
  return lines.slice(1).map((l) => l.split('\t'));
}
function scalar(sql) {
  const rows = mysqlSelect(sql);
  if (!rows.length || rows[0].length === 0) return null;
  return rows[0][0] === 'NULL' ? null : rows[0][0];
}
const num = (x) => (x === null || x === undefined ? null : Number(x));

/* ---------------- HTTP 助手 ---------------- */
async function get(path) {
  const res = await fetch(BASE + path);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON（如 500 白页）时留 null */ }
  return { http: res.status, code: json?.code, data: json?.data, raw: text.slice(0, 200) };
}

/* ---------------- 断言 ---------------- */
let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  → ' + detail : ''}`); }
}

const snap = (col) => num(scalar(`SELECT ${col} FROM t_goods WHERE id=${GOODS_ID}`));

(async () => {
  // ---------- 快照 ----------
  const before = {
    view_count: snap('view_count'),
    stock: snap('stock'),
    status: scalar(`SELECT status FROM t_goods WHERE id=${GOODS_ID}`),
    favorite_count: snap('favorite_count')
  };
  console.log('【快照】goods#1 =', JSON.stringify(before));

  try {
    // ================= A. 并发 8 次看详情 → view_count 净增恰好 8 =================
    console.log(`\n=== A. 并发 ${CONCURRENCY} 次看详情：view_count 必须净增恰好 ${CONCURRENCY}（原子自增的判别式）===`);
    mysql(`UPDATE t_goods SET view_count=100, stock=5, status='on_sale', favorite_count=777 WHERE id=${GOODS_ID};`);
    const base = snap('view_count');
    check('准备：view_count 已置为 100', base === 100, `实际 ${base}`);

    const results = await Promise.all(Array.from({ length: CONCURRENCY }, () => get(`/goods/${GOODS_ID}`)));
    const bad = results.filter((r) => r.code !== 0);
    check(`并发 ${CONCURRENCY} 次请求全部 code=0（SQL 合法，没有 500）`,
      bad.length === 0, bad.map((r) => `http=${r.http} code=${r.code} body=${r.raw}`).join(' | '));

    const after = snap('view_count');
    check(`view_count 净增恰好 ${CONCURRENCY}（旧实现会丢更新，净增 < ${CONCURRENCY}）`,
      after === base + CONCURRENCY, `期望 ${base + CONCURRENCY}，实际 ${after}`);

    // ================= C. 只动这一列 =================
    console.log('\n=== C. 详情页只动 view_count 一列：stock / status / favorite_count 必须不变 ===');
    check('stock 仍为 5（整实体回写会把旧库存盖回）', snap('stock') === 5, `实际 ${snap('stock')}`);
    check('favorite_count 仍为 777（整实体回写会抹掉它）', snap('favorite_count') === 777, `实际 ${snap('favorite_count')}`);
    check("status 仍为 on_sale", scalar(`SELECT status FROM t_goods WHERE id=${GOODS_ID}`) === 'on_sale');

    // ================= B. NULL → COALESCE 生效 =================
    console.log('\n=== B. 老数据 view_count=NULL：一次详情后必须从 1 起算（COALESCE 真的生效）===');
    mysql(`UPDATE t_goods SET view_count=NULL WHERE id=${GOODS_ID};`);
    check('准备：view_count 已置为 NULL', scalar(`SELECT view_count FROM t_goods WHERE id=${GOODS_ID}`) === null);

    const one = await get(`/goods/${GOODS_ID}`);
    check('NULL 状态下看详情仍然 code=0（`NULL + 1` 不会让 SQL 出错）', one.code === 0, `code=${one.code} body=${one.raw}`);
    const afterNull = num(scalar(`SELECT view_count FROM t_goods WHERE id=${GOODS_ID}`));
    check('库内 view_count 从 NULL 变成 1（COALESCE(view_count,0)+1 在真实 MySQL 上生效）',
      afterNull === 1, `实际 ${afterNull === null ? 'NULL' : afterNull}`);
    check('返回给前端的展示值也是 1（内存 +1，与 SQL 同口径）',
      num(one.data?.viewCount) === 1, `实际 ${one.data?.viewCount}`);
  } finally {
    // ---------- 原值还原 ----------
    mysql(
      `UPDATE t_goods SET ` +
      `view_count=${before.view_count === null ? 'NULL' : before.view_count}, ` +
      `stock=${before.stock === null ? 'NULL' : before.stock}, ` +
      `status='${before.status}', ` +
      `favorite_count=${before.favorite_count === null ? 'NULL' : before.favorite_count} ` +
      `WHERE id=${GOODS_ID};`
    );
    console.log('\n=== 收尾复核（必须与快照逐项一致）===');
    const after = {
      view_count: snap('view_count'),
      stock: snap('stock'),
      status: scalar(`SELECT status FROM t_goods WHERE id=${GOODS_ID}`),
      favorite_count: snap('favorite_count')
    };
    check('goods#1 已还原到快照', JSON.stringify(after) === JSON.stringify(before),
      `快照 ${JSON.stringify(before)} / 实际 ${JSON.stringify(after)}`);
  }

  console.log(`\n===== 结果：${pass} PASS / ${fail} FAIL =====`);
  process.exit(fail === 0 ? 0 : 1);
})();
