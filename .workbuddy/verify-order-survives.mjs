/**
 * 实测：「真单不会掉」这句话到底成不成立？
 * ----------------------------------------------------------------------------
 * 为什么值得实测：demo profile 里有两类完全不同的删除方式 ——
 *   · demo-data.sql        DELETE FROM t_goods;              ← 无 WHERE，全表清空
 *   · demo-data-orders.sql DELETE FROM t_order WHERE id IN (9 个固定单号);
 *                                                             ← 有 WHERE，定点删
 * 得证明「你自己下的单」落在第二类的 WHERE 之外。
 *
 * 安全：全程在**真库的完整副本** campus_market_orderstest 上做，真库只被 mysqldump 读一次。
 *
 * 用法：node .workbuddy/verify-order-survives.mjs
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WS = 'C:\\Users\\刘宝杰\\Desktop\\软件开发项目实践\\软件开发\\实践任务3：后端开发(前后端分离)';
const DBDIR = join(WS, 'campus-secondhand-backend', 'src', 'main', 'resources', 'db');
const BIN = 'D:/Program Files/MySQL/MySQL Server 8.0/bin';
const MYSQL = `${BIN}/mysql.exe`;
const DUMP = `${BIN}/mysqldump.exe`;
const REAL = 'campus_market';
const T = 'campus_market_orderstest';

const checks = [];
const expect = (n, c, d) => checks.push({ name: n, pass: !!c, detail: d });
const log = (s) => console.log(s);

const args = (db) => ['-h127.0.0.1', '-uroot', '-p123456', '--default-character-set=utf8mb4', ...(db ? [db] : [])];
const q = (sql, db) => execFileSync(MYSQL, args(db), { input: sql + '\n', encoding: 'utf8' })
  .replace(/\r/g, '').trim().split('\n').slice(1).map((l) => l.split('\t')).map((r) => (r.length === 1 ? r[0] : r));

// 造一个「像真单」的订单号：与 OrderService 同一格式 yyyyMMddHHmmssSSS + 3 位序号
const now = new Date();
const p = (n, w = 2) => String(n).padStart(w, '0');
const FAKE_ID = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}${p(now.getMilliseconds(), 3)}001`;

const SEED_IDS = ['20260916201512001', '20260915102033002', '20260912090511003', '20260905194000004',
  '20260828151000005', '20260909083000006', '20260907120000007', '20260916091000008', '20260820140000009'];

log(`【1】把真库 ${REAL} 整库复制到临时库 ${T}（真库只被读取）`);
execFileSync(MYSQL, args(), { input: `DROP DATABASE IF EXISTS ${T};\nCREATE DATABASE ${T} DEFAULT CHARACTER SET utf8mb4;\n`, encoding: 'utf8' });
const dump = execFileSync(DUMP, ['-h127.0.0.1', '-uroot', '-p123456', '--single-transaction', '--skip-add-locks', REAL],
  { maxBuffer: 256 * 1024 * 1024 });
execFileSync(MYSQL, args(T), { input: dump });
const beforeIds = q('SELECT id FROM t_order ORDER BY id;', T);
log(`  复制完成：t_order = ${beforeIds.length} 笔 / t_goods = ${q('SELECT COUNT(*) FROM t_goods;', T)[0]} 件`);

log(`\n【2】往副本里插一笔「你真实下单」形态的订单`);
log(`  订单号 = ${FAKE_ID}（格式与后端 OrderService 生成的一致）`);
execFileSync(MYSQL, args(T), {
  input: `INSERT INTO t_order (id, status, goods_id, goods_title, goods_cover, goods_price,
    buyer_id, buyer_name, seller_id, seller_name, amount, list_price, seller_cut, platform_subsidy,
    seller_income, fund_source, quantity, create_time)
    VALUES ('${FAKE_ID}', 'pending_payment', 3, '【实测】真实下单不会被演示脚本删掉', '/uploads/x.jpg', 99.00,
    4, '计算机小张', 5, '图书小李', 99.00, 99.00, 0, 0, 99.00, 'seller', 1, NOW());\n`, encoding: 'utf8' });
log(`  插入后 t_order = ${q('SELECT COUNT(*) FROM t_order;', T)[0]} 笔`);

log(`\n【3】在副本上执行 demo-data-orders.sql（就是 demo profile 会跑的那个）`);
execFileSync(MYSQL, args(T), { input: readFileSync(join(DBDIR, 'demo-data-orders.sql'), 'utf8'), encoding: 'utf8' });
const afterIds = q('SELECT id FROM t_order ORDER BY id;', T);
log(`  执行后 t_order = ${afterIds.length} 笔`);

log(`\n【4】比对`);
const survived = afterIds.includes(FAKE_ID);
const seedAll = SEED_IDS.every((id) => afterIds.includes(id));
log(`  「真实下单」那笔还在吗？  ${survived ? '★ 还在 ✓' : '✗ 被删了'}`);
log(`  9 笔演示订单齐全吗？      ${seedAll ? '✓' : '✗'}`);
log(`  订单总数：${beforeIds.length} → ${afterIds.length}（期望 +1，因为只多了一笔我插的）`);

expect('★ 真实形态的订单在 demo-data-orders.sql 之后**依然存在**', survived,
  survived ? `${FAKE_ID} 未被删除` : '被删除');
expect('9 笔演示订单仍被正确重建（脚本的清理只针对自己）', seedAll,
  seedAll ? SEED_IDS.length + '/9 齐全' : '有缺失');
expect('订单总数只增加了「我插的那一笔」', afterIds.length === beforeIds.length + 1,
  `${beforeIds.length} → ${afterIds.length}`);

log('\n【5】对照：demo-data.sql 的商品表是无 WHERE 的全表删');
const goodsSql = readFileSync(join(DBDIR, 'demo-data.sql'), 'utf8');
const goodsFullWipe = /DELETE FROM t_goods;\s*$/m.test(goodsSql) || /DELETE FROM t_goods;\s/.test(goodsSql);
log(`  demo-data.sql 里 「DELETE FROM t_goods;」后面没有 WHERE → ${goodsFullWipe ? '全表清空（商品会被清）' : '未确认'}`);
log(`  外键检查：schema.sql 中 FOREIGN KEY / ON DELETE 级联 = ${/FOREIGN KEY|ON DELETE/i.test(readFileSync(join(DBDIR, 'schema.sql'), 'utf8')) ? '存在' : '无 → 清商品带不走订单'}`);
expect('数据模型无外键级联（清商品不会连带删订单）',
  !/FOREIGN KEY|ON DELETE/i.test(readFileSync(join(DBDIR, 'schema.sql'), 'utf8')), '无外键');

log(`\n【6】清理：删掉临时库 ${T}`);
execFileSync(MYSQL, args(), { input: `DROP DATABASE IF EXISTS ${T};\n`, encoding: 'utf8' });
log(`  剩余：${q(`SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name='${T}';`)[0]}（0 = 已删干净）`);

log('\n========== 结论 ==========');
let fail = 0;
for (const c of checks) { if (!c.pass) fail++; log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.name} :: ${c.detail}`); }
log(`\n${fail === 0 ? '✅ 「订单是定点删、真单不会掉」成立' : `❌ ${fail} 项未通过`}`);
if (fail > 0) process.exitCode = 1;
