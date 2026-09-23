/**
 * 真机探针：自动下架的**定时触发**路径（缺陷清单 M2 的核心主张）
 *
 * 为什么手工入口的探针不够：
 *   M2 的原话是「全仓 @Scheduled 命中 0 → auto_offline_days 是死配置」。
 *   手工入口（POST /admin/goods/auto-offline）只证明「这段业务逻辑是对的」，
 *   完全不能证明「有人会在无人操作时调用它」—— 而后者才是这条缺陷的内容。
 *   一个没注册上的 @Scheduled、写错的任务 Bean、没生效的 @EnableScheduling，
 *   都会让手工入口一切正常、而这条配置在线上依旧是死的。
 *
 * ★ 本探针必须配一个「快跑」的 cron 启动后端 ★
 *   默认 cron 是每天 03:30，等它是不可行的。启动时覆盖：
 *     --app.goods-maintenance.offline-cron=* /10 * * * * ?
 *   于是每 10 秒就有一轮，探针插一件 45 天前的在售商品后轮询它是否被自动下架。
 *   若后端是用默认配置启动的，探针会超时报红，并在失败信息里说明这一点。
 *
 * ★ 还顺带验证了「定时任务的操作人」★
 *   定时任务没有请求上下文，OperatorContext.currentOperator() 必须返回 "system"
 *   而不是 null / 空 —— 否则审计里那一条就成了无主记录。这条只有真跑一次才看得到。
 */
import { execSync } from 'node:child_process';

const MYSQL = String.raw`C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe`;
const PJ = 'zz-offlinejob';
const ID_STALE = 9101;
const ID_FRESH = 9102;
const ID_LO = 9101;
const ID_HI = 9105;
const WAIT_MS = 45_000;

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
const sleep = ms => new Promise(r => setTimeout(r, ms));

const statusSnapshot = () =>
  sqlQuiet(`SELECT CONCAT(status, ':', COUNT(*)) FROM t_goods WHERE id < ${ID_LO} GROUP BY status ORDER BY status`)
    .replace(/\n/g, ',');
const statusOf = id => sqlQuiet(`SELECT status FROM t_goods WHERE id=${id}`);
const systemJobLogs = () =>
  sqlQuiet("SELECT COUNT(*) FROM t_audit_log WHERE action='goods.auto_offline' AND operator='system'");

// ==================== A. 前置 ====================
section('A. 前置');

sqlQuiet(`DELETE FROM t_goods WHERE id BETWEEN ${ID_LO} AND ${ID_HI}`);
sqlQuiet("DELETE FROM t_audit_log WHERE action='goods.auto_offline' AND operator='system'");
check('A0 自造商品与上次的 system 审计已清理',
  sqlQuiet(`SELECT COUNT(*) FROM t_goods WHERE id BETWEEN ${ID_LO} AND ${ID_HI}`) === '0' && systemJobLogs() === '0');

const baseGoods = sql('SELECT COUNT(*) FROM t_goods');
const baseSnapshot = statusSnapshot();
const baseSystemLogs = systemJobLogs();
console.log(`  基线：g=${baseGoods} 状态分布=${baseSnapshot} system 审计=${baseSystemLogs}`);

// 单行 SQL（cmd.exe 会把多行 -e 参数截断，见 e2e-auto-offline.mjs 里的同类注释）
const seedErr = sqlQuiet(
  `INSERT INTO t_goods (id, title, price, status, stock, seller_id, seller_name, create_time, update_time) VALUES ` +
  `(${ID_STALE}, '${PJ} 45d on_sale', 1.00, 'on_sale', 1, 4, 'probe', NOW() - INTERVAL 45 DAY, NOW() - INTERVAL 45 DAY), ` +
  `(${ID_FRESH}, '${PJ} 1d on_sale',  1.00, 'on_sale', 1, 4, 'probe', NOW() - INTERVAL 1 DAY,  NOW() - INTERVAL 1 DAY)`);
check('A1 两件边界商品已就位（45 天 / 1 天，都 on_sale）',
  statusOf(ID_STALE) === 'on_sale' && statusOf(ID_FRESH) === 'on_sale',
  `stale=${statusOf(ID_STALE)} fresh=${statusOf(ID_FRESH)} seedErr=${seedErr}`);

// ==================== B. 等定时任务自己动手 ====================
section('B. 无人操作，等定时器自己把 45 天前那件下架');

const t0 = Date.now();
let fired = false;
while (Date.now() - t0 < WAIT_MS) {
  if (statusOf(ID_STALE) === 'off_shelf') { fired = true; break; }
  await sleep(2000);
}
const waited = ((Date.now() - t0) / 1000).toFixed(1);

check(`B1 ★ 定时任务在 ${waited}s 内自动下架了 45 天前的在售商品`, fired,
  '超时未发生。若后端以默认 cron（每天 03:30）启动，本项必然失败 —— ' +
  '请用 serve-backend-fastcron.mjs 启动后端（cron 覆盖成每 10 秒一轮）');
check(`B2 已变为 off_shelf`, statusOf(ID_STALE) === 'off_shelf', `实际=${statusOf(ID_STALE)}`);
check('B3 ★ 1 天前的那件没被动（时间边界在定时路径上同样生效）',
  statusOf(ID_FRESH) === 'on_sale', `实际=${statusOf(ID_FRESH)}`);

// ==================== C. 审计留痕（含操作人） ====================
section('C. 定时任务的审计留痕');

const nowSystemLogs = Number(systemJobLogs());
check('C1 新增了一条 operator=system 的审计（无请求上下文时落 system，不是 null）',
  nowSystemLogs > Number(baseSystemLogs), `实际=${nowSystemLogs} 基线=${baseSystemLogs}`);

{
  const row = sqlQuiet("SELECT CONCAT(action,'|',action_label,'|',target,'|',operator) FROM t_audit_log " +
    "WHERE action='goods.auto_offline' AND operator='system' ORDER BY id DESC LIMIT 1");
  check('C2 审计内容可复述「按几天、下了几件、谁触发的」',
    row.includes('goods.auto_offline') && row.includes('在售商品') && row.includes('system'),
    `实际=${row}`);
}

// ==================== D. 演示数据未受牵连 ====================
section('D. 16 件演示商品未受牵连');

check('D1 ★ 状态分布与启动前一致（定时任务只打到了自造数据上）',
  statusSnapshot() === baseSnapshot, `现在=${statusSnapshot()} 基线=${baseSnapshot}`);

// ==================== E. 复位 ====================
section('E. 复位与复核');

sqlQuiet(`DELETE FROM t_goods WHERE id BETWEEN ${ID_LO} AND ${ID_HI}`);
sqlQuiet("DELETE FROM t_audit_log WHERE action='goods.auto_offline' AND operator='system'");
sqlQuiet(`ALTER TABLE t_goods AUTO_INCREMENT = 1`);

check('E1 自造商品已清理',
  sqlQuiet(`SELECT COUNT(*) FROM t_goods WHERE id BETWEEN ${ID_LO} AND ${ID_HI}`) === '0');
check('E2 自造审计已清理', systemJobLogs() === baseSystemLogs, `实际=${systemJobLogs()}`);
check('E3 t_goods 行数与状态分布回到基线',
  sql(`SELECT COUNT(*) FROM t_goods`) === baseGoods && statusSnapshot() === baseSnapshot,
  `g=${sqlQuiet('SELECT COUNT(*) FROM t_goods')}/${baseGoods} 分布=${statusSnapshot()}/${baseSnapshot}`);

console.log('\n==================== 结果 ====================');
console.log(`PASS=${pass}  FAIL=${fail}`);
if (failures.length) {
  console.log('失败明细：');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(fail === 0 ? 0 : 1);
