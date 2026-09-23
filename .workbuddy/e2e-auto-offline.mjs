/**
 * 真机探针：商品自动下架（缺陷清单 M2 · auto_offline_days 死配置复活）
 *
 * 为什么单测不够：单测里 Mapper 是假的，这句
 *   UPDATE t_goods SET status='off_shelf' WHERE status='on_sale' AND create_time < ?
 * 到底在 MySQL 上筛出哪几行、一行都没筛到还是筛多了，**只有真库能回答**。
 * 而这条动作恰恰是「批量改状态」，错一次就是整站商品集体下架 —— 必须真机验证。
 *
 * ★ 探针用「造边界数据」而不是「拿演示数据去试」★
 *   演示商品发布时间都在 15 天以内，拿它们根本试不出边界。
 *   这里用显式主键 9001~9005 造 5 件**只差一个维度**的商品（45 天 vs 1 天 / on_sale vs 其它状态），
 *   从而能断言「改且只改了该改的那一件」——这是本探针最强的一条。
 *   显式主键而非 LAST_INSERT_ID()：后者是**连接级**的，分两次 CLI 调用会拿到 0。
 *
 * ★ 探针不改动演示数据 ★
 *   全程对 16 件演示商品做状态分布快照，每个写操作后都比对一次；
 *   结尾删掉自造数据、恢复设置原值、清掉自己产生的审计流水，并复核基线。
 */
import { execSync } from 'node:child_process';

const BASE = 'http://127.0.0.1:8080/api';
const MYSQL = String.raw`C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe`;
const PJ = 'zz-offline';                       // 自造商品的标题前缀
const ID_LO = 9001;
const ID_HI = 9010;

function sql(q) {
  const cmd = `"${MYSQL}" -uroot -p123456 --default-character-set=utf8mb4 -N -B -Dcampus_market -e "${q}"`;
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function sqlQuiet(q) {
  try { return sql(q); } catch (e) { return 'ERR:' + String(e.message).slice(0, 160); }
}

let pass = 0, fail = 0;
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
const login = (u, p) => api('POST', '/user/login', { body: { username: u, password: p } });

/** 16 件演示商品的状态分布（确定性字符串，直接用于前后比对） */
const statusSnapshot = () =>
  sqlQuiet(`SELECT CONCAT(status, ':', COUNT(*)) FROM t_goods WHERE id < ${ID_LO} GROUP BY status ORDER BY status`)
    .replace(/\n/g, ',');
const autoOfflineLogCount = () =>
  sqlQuiet("SELECT COUNT(*) FROM t_audit_log WHERE action='goods.auto_offline'");
const counted = r => (typeof r.json?.data?.count === 'number' ? r.json.data.count : null);
const daysOf = r => (typeof r.json?.data?.days === 'number' ? r.json.data.days : null);

/**
 * ★ 必须是**单行** SQL ★
 * execSync 在 Windows 上经 cmd.exe 执行，双引号参数里的换行会把命令**截断**，
 * mysql 只收到半句，报 `ERROR 1064 ... near '' at line 1`；而 sqlQuiet 会把异常吞成字符串，
 * 表现就是「D 段后面十几条全部莫名其妙报红」——排查方向完全被带偏。
 * 所以这里显式拼成一行，并把返回值交给调用方断言（种子没进去要当场说出来）。
 */
function seedBoundaryGoods() {
  const rows = [
    `(9001, '${PJ} 45d on_sale',   1.00, 'on_sale',   1, 4, 'probe', NOW() - INTERVAL 45 DAY, NOW() - INTERVAL 45 DAY)`,
    `(9002, '${PJ} 45d pending',   1.00, 'pending',   1, 4, 'probe', NOW() - INTERVAL 45 DAY, NOW() - INTERVAL 45 DAY)`,
    `(9003, '${PJ} 45d sold',      1.00, 'sold',      1, 4, 'probe', NOW() - INTERVAL 45 DAY, NOW() - INTERVAL 45 DAY)`,
    `(9004, '${PJ} 45d off_shelf', 1.00, 'off_shelf', 1, 4, 'probe', NOW() - INTERVAL 45 DAY, NOW() - INTERVAL 45 DAY)`,
    `(9005, '${PJ} 1d  on_sale',   1.00, 'on_sale',   1, 4, 'probe', NOW() - INTERVAL 1  DAY, NOW() - INTERVAL 1  DAY)`,
  ].join(', ');
  return sqlQuiet(`INSERT INTO t_goods (id, title, price, status, stock, seller_id, seller_name, create_time, update_time) VALUES ` + rows);
}
const statusOf = id => sqlQuiet(`SELECT status FROM t_goods WHERE id=${id}`);

// ==================== A. 前置 ====================
section('A. 前置（幂等清理 + 基线快照）');

sqlQuiet(`DELETE FROM t_goods WHERE id BETWEEN ${ID_LO} AND ${ID_HI}`);
// 上一次跑到一半失败时可能留下审计流水；先清干净，后面的条数比对才有意义
sqlQuiet("DELETE FROM t_audit_log WHERE action='goods.auto_offline'");
check('A0 自造商品残留已清理',
  sqlQuiet(`SELECT COUNT(*) FROM t_goods WHERE id BETWEEN ${ID_LO} AND ${ID_HI}`) === '0');

const baseUsers = sql('SELECT COUNT(*) FROM t_user');
const baseGoods = sql('SELECT COUNT(*) FROM t_goods');
const baseOrders = sql('SELECT COUNT(*) FROM t_order');
const baseLogs = autoOfflineLogCount();
const baseSnapshot = statusSnapshot();
const baseDays = sql('SELECT auto_offline_days FROM t_settings LIMIT 1');
console.log(`  基线：u=${baseUsers} g=${baseGoods} o=${baseOrders} auto_offline 审计=${baseLogs}`);
console.log(`  基线：状态分布=${baseSnapshot}  配置天数=${baseDays}`);
check('A1 没有历史 goods.auto_offline 审计（否则收尾的复核数会失真）', baseLogs === '0', `实际=${baseLogs}`);

// ==================== B. 权限（/admin/** 仅 admin） ====================
section('B. 权限：批量改状态的入口不能下放');

{
  const r = await api('POST', '/admin/goods/auto-offline');
  check('B1 未登录执行 → 401', r.json?.code === 401, `code=${r.json?.code} msg=${r.json?.message}`);
}
{
  const r = await api('GET', '/admin/goods/auto-offline');
  check('B2 未登录预览 → 401', r.json?.code === 401, `code=${r.json?.code} msg=${r.json?.message}`);
}

const ga = await login('goods_admin', 'goods123456');
check('B3 前置：goods_admin 可登录', ga.json?.code === 0 && !!ga.json?.data?.token,
  `code=${ga.json?.code} msg=${ga.json?.message}`);
{
  const r = await api('POST', '/admin/goods/auto-offline', { token: ga.json?.data?.token });
  check('B4 ★ goods_admin 执行 → 403（审核员不得批量改商品状态）',
    r.json?.code === 403, `code=${r.json?.code} msg=${r.json?.message}`);
}
{
  const r = await api('GET', '/admin/goods/auto-offline', { token: ga.json?.data?.token });
  check('B5 goods_admin 预览 → 403', r.json?.code === 403, `code=${r.json?.code} msg=${r.json?.message}`);
}

const adm = await login('admin', 'admin123');
const TOKEN = adm.json?.data?.token;
check('B6 前置：admin 可登录', adm.json?.code === 0 && !!TOKEN,
  `code=${adm.json?.code} msg=${adm.json?.message}`);

// ==================== C. 空跑：配置 30 天，演示数据一件都不该动 ====================
section('C. 空跑：30 天下，演示商品（最新 15 天）一件都不能动');

{
  const r = await api('GET', '/admin/goods/auto-offline', { token: TOKEN });
  check('C1 预览：days=30、count=0', r.json?.code === 0 && daysOf(r) === 30 && counted(r) === 0,
    `code=${r.json?.code} data=${JSON.stringify(r.json?.data)}`);
}
{
  const r = await api('POST', '/admin/goods/auto-offline', { token: TOKEN });
  check('C2 执行：days=30、count=0', r.json?.code === 0 && daysOf(r) === 30 && counted(r) === 0,
    `code=${r.json?.code} data=${JSON.stringify(r.json?.data)}`);
}
check('C3 ★ 16 件演示商品状态分布与执行前完全一致（没有误伤）',
  statusSnapshot() === baseSnapshot, `现在=${statusSnapshot()} 基线=${baseSnapshot}`);
check('C4 没有新增审计（0 件不留痕，日志不会被每天的 0 件淹没）',
  autoOfflineLogCount() === baseLogs, `实际=${autoOfflineLogCount()}`);

// ==================== D. 正命中：造边界数据 ====================
section('D. 正命中：45 天前的在售商品被下架，且只改这一件');

const seedErr = seedBoundaryGoods();
check('D0 5 件边界商品已就位（45d on_sale/pending/sold/off_shelf + 1d on_sale）',
  sqlQuiet(`SELECT COUNT(*) FROM t_goods WHERE id BETWEEN ${ID_LO} AND 9005`) === '5',
  `seedErr=${seedErr}`);

{
  const r = await api('GET', '/admin/goods/auto-offline', { token: TOKEN });
  check('D1 ★ 预览 count=1（5 件里只有「45 天前的 on_sale」算数）',
    r.json?.code === 0 && counted(r) === 1, `data=${JSON.stringify(r.json?.data)}`);
}
{
  const r = await api('POST', '/admin/goods/auto-offline', { token: TOKEN });
  check('D2 ★ 执行 count=1（真实影响行数）',
    r.json?.code === 0 && counted(r) === 1, `data=${JSON.stringify(r.json?.data)}`);
}
check('D3 ★ 9001（45d on_sale）已被下架 → off_shelf',
  statusOf(9001) === 'off_shelf', `实际=${statusOf(9001)}`);
check('D4 ★ 9002（45d pending）未被动 —— 只碰 on_sale，待审核不该被下架',
  statusOf(9002) === 'pending', `实际=${statusOf(9002)}`);
check('D5 ★ 9003（45d sold）未被动 —— 已售出不是「挂在架上」',
  statusOf(9003) === 'sold', `实际=${statusOf(9003)}`);
check('D6 9004（45d off_shelf）保持 off_shelf（幂等，状态未变）',
  statusOf(9004) === 'off_shelf', `实际=${statusOf(9004)}`);
check('D7 ★ 9005（1d on_sale）未被动 —— 时间边界真的生效（不是「所有在售」）',
  statusOf(9005) === 'on_sale', `实际=${statusOf(9005)}`);
check('D8 ★ 16 件演示商品状态分布仍与快照一致（批量动作只打到了自造数据上）',
  statusSnapshot() === baseSnapshot, `现在=${statusSnapshot()} 基线=${baseSnapshot}`);

{
  const n = Number(autoOfflineLogCount());
  check('D9 审计新增 1 条', n === Number(baseLogs) + 1, `实际=${n} 基线=${baseLogs}`);
  const row = sqlQuiet("SELECT CONCAT(action,'|',action_label,'|',target,'|',operator) FROM t_audit_log WHERE action='goods.auto_offline' ORDER BY id DESC LIMIT 1");
  check('D10 审计内容可复述「谁、按几天、下了几件」',
    row.includes('goods.auto_offline') && row.includes('1 件在售商品') && row.includes('admin'),
    `实际=${row}`);
}

// ==================== E. 幂等 ====================
section('E. 幂等：再执行一次不应重复下架');

{
  const r = await api('POST', '/admin/goods/auto-offline', { token: TOKEN });
  check('E1 再执行 count=0（9001 已是 off_shelf，不会被重复计数）',
    r.json?.code === 0 && counted(r) === 0, `data=${JSON.stringify(r.json?.data)}`);
}
check('E2 状态分布不变', statusSnapshot() === baseSnapshot, `现在=${statusSnapshot()}`);
check('E3 0 件不留痕：审计条数不再增加',
  Number(autoOfflineLogCount()) === Number(baseLogs) + 1, `实际=${autoOfflineLogCount()}`);

// ==================== F. 0 = 关闭（缺配置放宽，绝不收紧） ====================
section('F. 配置 0 = 关闭：绝不能变成「立刻下架所有在售商品」');

{
  const r = await api('PATCH', '/admin/settings', { token: TOKEN, body: { autoOfflineDays: 0 } });
  check('F0 后台可以把自动下架天数设为 0（0 是合法值，不是「没传」）',
    r.json?.code === 0, `code=${r.json?.code} msg=${r.json?.message}`);
}
check('F1 库里确实落成 0（MP 的 NOT_NULL 策略不拦 0）',
  sqlQuiet('SELECT auto_offline_days FROM t_settings LIMIT 1') === '0',
  `实际=${sqlQuiet('SELECT auto_offline_days FROM t_settings LIMIT 1')}`);

sqlQuiet(`UPDATE t_goods SET status='on_sale', create_time = NOW() - INTERVAL 45 DAY WHERE id=9001`);
check('F2 前置：把 9001 复位成「45 天前的在售」（本来会被下架的那一件）',
  statusOf(9001) === 'on_sale', `实际=${statusOf(9001)}`);

{
  const r = await api('GET', '/admin/goods/auto-offline', { token: TOKEN });
  check('F3 ★ 预览 days=0、count=0（关掉之后连数都不数）',
    r.json?.code === 0 && daysOf(r) === 0 && counted(r) === 0,
    `data=${JSON.stringify(r.json?.data)}`);
}
{
  const r = await api('POST', '/admin/goods/auto-offline', { token: TOKEN });
  check('F4 ★ 执行 days=0、count=0',
    r.json?.code === 0 && daysOf(r) === 0 && counted(r) === 0,
    `data=${JSON.stringify(r.json?.data)}`);
}
check('F5 ★★ 9001 仍是 on_sale —— 0 必须是「关闭」，不能是「立即全量下架」',
  statusOf(9001) === 'on_sale', `实际=${statusOf(9001)}`);
check('F6 审计没有新增（关闭状态下什么都没发生）',
  Number(autoOfflineLogCount()) === Number(baseLogs) + 1, `实际=${autoOfflineLogCount()}`);

// ==================== G. 复位 + 复核 ====================
section('G. 复位与复核');

sqlQuiet(`DELETE FROM t_goods WHERE id BETWEEN ${ID_LO} AND ${ID_HI}`);
sqlQuiet(`UPDATE t_settings SET auto_offline_days = ${baseDays === 'NULL' ? 'NULL' : baseDays}`);
sqlQuiet("DELETE FROM t_audit_log WHERE action='goods.auto_offline'");
// 显式主键插入会把自增计数器顶到 9006，复位它，避免影响后续依赖小 id 的探针
sqlQuiet(`ALTER TABLE t_goods AUTO_INCREMENT = 1`);

check('G1 自造商品已清理',
  sqlQuiet(`SELECT COUNT(*) FROM t_goods WHERE id BETWEEN ${ID_LO} AND ${ID_HI}`) === '0');
check('G2 配置天数已还原',
  sqlQuiet('SELECT auto_offline_days FROM t_settings LIMIT 1') === baseDays,
  `实际=${sqlQuiet('SELECT auto_offline_days FROM t_settings LIMIT 1')} 基线=${baseDays}`);
check('G3 自造审计已清理', autoOfflineLogCount() === baseLogs, `实际=${autoOfflineLogCount()}`);
check('G4 ★ t_goods 状态分布回到基线',
  statusSnapshot() === baseSnapshot, `现在=${statusSnapshot()} 基线=${baseSnapshot}`);
check('G5 t_goods 行数回到基线', sql(`SELECT COUNT(*) FROM t_goods`) === baseGoods,
  `实际=${sqlQuiet('SELECT COUNT(*) FROM t_goods')} 基线=${baseGoods}`);
check('G6 t_user / t_order 未被触碰（本探针不该动它们）',
  sql(`SELECT COUNT(*) FROM t_user`) === baseUsers && sql(`SELECT COUNT(*) FROM t_order`) === baseOrders,
  `u=${sqlQuiet('SELECT COUNT(*) FROM t_user')}/${baseUsers} o=${sqlQuiet('SELECT COUNT(*) FROM t_order')}/${baseOrders}`);
check('G7 t_goods 自增计数器已复位（不留下 9006 起始的痕迹）',
  sqlQuiet("SELECT AUTO_INCREMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA='campus_market' AND TABLE_NAME='t_goods'") === String(Number(baseGoods) + 1),
  `实际=${sqlQuiet("SELECT AUTO_INCREMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA='campus_market' AND TABLE_NAME='t_goods'")}`);

// ==================== H. 收尾 ====================
section('H. 收尾：环境仍然可用');

{
  const r = await login('admin', 'admin123');
  check('H1 ★ admin 仍可登录（探针没有把环境搞坏）', r.json?.code === 0, `code=${r.json?.code} msg=${r.json?.message}`);
}
{
  const r = await api('GET', '/admin/goods/auto-offline', { token: TOKEN });
  check('H2 还原后预览仍可用且 days=30', r.json?.code === 0 && daysOf(r) === 30,
    `data=${JSON.stringify(r.json?.data)}`);
}

console.log('\n==================== 结果 ====================');
console.log(`PASS=${pass}  FAIL=${fail}`);
if (failures.length) {
  console.log('失败明细：');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(fail === 0 ? 0 : 1);
