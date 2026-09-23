/**
 * 端到端验证：数据库自动初始化（spring.sql.init + schema-auto.sql + seed-base.sql）
 * ----------------------------------------------------------------------------
 * 验证三个真实场景，全部起**真实的 java -jar**、打**真实 HTTP**、查**真实 MySQL**：
 *
 *   A. 全新空库（库都不存在）
 *      → 后端能自己把库建出来、17 张表建出来、基础种子灌进去
 *      → 然后能用 admin/admin123 真的登录成功（不只是「启动没报错」）
 *      → 再重启一次：种子不重复灌（幂等）
 *
 *   B. 现有业务库（campus_market，有 16 商品 / 9 订单）
 *      → 启动后**一点都不能变**：表数、各表计数、商品状态分布逐项比对
 *      → 这一条最重要：自动执行脚本最大的风险就是「每次启动清空全库」，
 *        必须证明配的是 IF NOT EXISTS 版而不是 DROP 版
 *
 *   C. 演示 profile（--spring.profiles.active=demo + 另一个新库）
 *      → 自动灌出 16 商品 / 9 订单 / 在线分布 [1,2,4]
 *      → 证明 data-locations 覆盖问题处理正确（seed-base 没有被 demo 顶掉）
 *
 * 安全：只创建/删除 campus_market_autotest、campus_market_demotest 两个测试库，
 *       全程不动 campus_market（只读比对）。
 *
 * 取证方式：给后端加 --logging.level.org.springframework.jdbc.datasource.init=DEBUG，
 *   ScriptUtils 会打印「Executing/Executed SQL script from class path resource [db/xxx.sql]」。
 *   默认日志级别下这几行**根本不存在**，靠它们断言会得到假 FAIL（本探针初版就踩了）。
 *   注意：JVM 在 Windows 上按 GBK 写管道，日志里的**中文是乱码**，
 *   所以证据锚点一律用 ASCII（文件名），不要 grep 中文。
 *
 * 用法：node .workbuddy/verify-auto-init.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

const WS = 'C:\\Users\\刘宝杰\\Desktop\\软件开发项目实践\\软件开发\\实践任务3：后端开发(前后端分离)';
const BACKEND = join(WS, 'campus-secondhand-backend');
const JAR = join(BACKEND, 'target', 'campus-secondhand-backend-1.0.0.jar');
const JAVA = 'C:/Program Files/Java/jdk-17/bin/java.exe';
const MYSQL = 'D:/Program Files/MySQL/MySQL Server 8.0/bin/mysql.exe';
const PORT = 8080;
const BASE = `http://127.0.0.1:${PORT}/api`;

const A_DB = 'campus_market_autotest';   // 场景 A / 幂等复验
const C_DB = 'campus_market_demotest';   // 场景 C
const REAL_DB = 'campus_market';         // 场景 B（只读）

/** 会被 spring.sql.init 自动执行的脚本 —— 每一个都必须「库无关」 */
const AUTO_INIT_SCRIPTS = ['schema-auto.sql', 'seed-base.sql', 'demo-data.sql', 'demo-data-orders.sql', 'demo-online-seed.sql'];

// 本机设了 HTTP_PROXY，Node fetch 必须显式清空，否则本地请求 502
process.env.HTTP_PROXY = '';
process.env.http_proxy = '';
process.env.HTTPS_PROXY = '';
process.env.https_proxy = '';

const checks = [];
const expect = (name, cond, detail) => { checks.push({ name, pass: !!cond, detail }); };
const log = (s) => console.log(s);

// ---------- MySQL ----------
const MYSQL_ARGS = ['-h127.0.0.1', '-uroot', '-p123456', '--default-character-set=utf8mb4'];
function mysql(sql, db) {
  return execFileSync(MYSQL, db ? [...MYSQL_ARGS, db] : MYSQL_ARGS, { input: sql + '\n', encoding: 'utf8' });
}
const rows = (sql, db) => mysql(sql, db).replace(/\r/g, '').trim().split('\n').slice(1).map((l) => l.split('\t'));
const scalar = (sql, db) => rows(sql, db)[0]?.[0];
function dbExists(name) {
  return scalar(`SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name='${name}';`) === '1';
}
function tableCount(name) {
  return dbExists(name) ? +scalar(`SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${name}';`) : 0;
}
/** 一张库的快照：表数 + 关键表计数 + 商品状态分布 */
function snapshot(db) {
  if (!dbExists(db)) return null;
  const t = (n) => +scalar(`SELECT COUNT(*) FROM ${n};`, db);
  const dist = rows(`SELECT status, COUNT(*) FROM t_goods GROUP BY status ORDER BY status;`, db)
    .map((r) => `${r[0]}=${r[1]}`).join(' ');
  return {
    tables: tableCount(db),
    u: t('t_user'), g: t('t_goods'), o: t('t_order'), ol: t('t_order_log'),
    al: t('t_audit_log'), ac: t('t_activity'), cat: t('t_category'),
    st: t('t_settings'), no: t('t_notice'), dist,
  };
}
const snapStr = (s) => (s === null ? '(库不存在)' : `表${s.tables} u=${s.u} g=${s.g} o=${s.o} ol=${s.ol} al=${s.al} ac=${s.ac} cat=${s.cat} st=${s.st} no=${s.no} dist[${s.dist}]`);

// ---------- 后端进程 ----------
function startBackend({ db, profile } = {}) {
  const url = `jdbc:mysql://localhost:3306/${db}?useUnicode=true&characterEncoding=utf-8&useSSL=false&serverTimezone=Asia/Shanghai&allowPublicKeyRetrieval=true&createDatabaseIfNotExist=true`;
  const args = ['-jar', JAR, `--server.port=${PORT}`];
  if (profile) args.push(`--spring.profiles.active=${profile}`);
  // 让 ScriptUtils 打出「执行了哪个脚本」——见文件头「取证方式」
  args.push('--logging.level.org.springframework.jdbc.datasource.init=DEBUG');
  const proc = spawn(JAVA, args, {
    cwd: BACKEND,
    env: { ...process.env, DB_URL: url },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', (d) => { out += d.toString(); });
  proc.stderr.on('data', (d) => { out += d.toString(); });
  const done = new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (/Started CampusMarketApplication/.test(out)) { clearInterval(iv); resolve({ ok: true }); }
      else if (/APPLICATION FAILED TO START|Error starting ApplicationContext/.test(out)) { clearInterval(iv); resolve({ ok: false, why: '启动失败' }); }
      else if (Date.now() - t0 > 90_000) { clearInterval(iv); resolve({ ok: false, why: '启动超时 90s' }); }
    }, 300);
  });
  return { proc, done, log: () => out };
}
async function stopBackend(b) {
  try { execFileSync('taskkill', ['/PID', String(b.proc.pid), '/F', '/T'], { stdio: 'ignore' }); } catch { /* 已退出 */ }
  // 等端口真的释放，否则下一次启动会撞端口
  for (let i = 0; i < 40; i++) {
    try {
      execFileSync('cmd.exe', ['/c', `netstat -ano | findstr :${PORT}`], { stdio: 'ignore' });
      await new Promise((r) => setTimeout(r, 400));
    } catch { return; }  // findstr 无匹配 → 端口已释放
  }
}

// ---------- HTTP ----------
async function api(method, path, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { http: res.status, json };
}
async function login(username, password) {
  return api('POST', '/user/login', { body: { username, password } });
}
/** 提取启动日志里的 sql.init 证据（全 ASCII 锚点，避开 GBK 乱码） */
function initEvidence(logText) {
  const hit = (re) => (logText.match(re) || []).length;
  const res = (f) => `class path resource [db/${f}]`;
  return {
    schema: hit(new RegExp(`\\[db/schema-auto\\.sql\\]`, 'g')),
    seed: hit(new RegExp(`\\[db/seed-base\\.sql\\]`, 'g')),
    demoData: hit(new RegExp(`\\[db/demo-data\\.sql\\]`, 'g')),
    demoOrders: hit(new RegExp(`\\[db/demo-data-orders\\.sql\\]`, 'g')),
    demoOnline: hit(new RegExp(`\\[db/demo-online-seed\\.sql\\]`, 'g')),
    createTable: hit(/CREATE TABLE IF NOT EXISTS/g),
    drops: hit(/DROP TABLE/gi),
    /** 按执行顺序列出脚本：`db/schema-auto.sql · 1088ms` */
    executed: (logText.match(/Executed SQL script from class path resource \[db\/[^\]]+\] in \d+ ms\./g) || [])
      .map((s) => s.replace(/^Executed SQL script from class path resource \[/, '').replace(/\] in (\d+) ms\.$/, ' · $1ms')),
    /** 首次出现位置，用于校验执行顺序 */
    firstAt: (f) => logText.indexOf(res(f)),
  };
}

// ---------- 主流程 ----------
async function main() {
  // 0) 静态防线：自动初始化脚本里出现 USE / CREATE DATABASE 就等于埋了「跨库泄漏」
  log('【0 静态防线】自动初始化脚本不得切换/创建库');
  for (const f of AUTO_INIT_SCRIPTS) {
    const txt = readFileSync(join(BACKEND, 'src', 'main', 'resources', 'db', f), 'utf8');
    const leak = txt.match(/^\s*(USE|CREATE\s+DATABASE|DROP\s+DATABASE)\b/im);
    expect(`静态 ${f} 不含 USE / CREATE DATABASE（跨库泄漏防线）`,
      !leak, leak ? `发现「${leak[0].trim()}」—— 自动执行时会把连接切到别的库！` : '干净');
  }

  // 0.5) 准备：清掉历史测试库；记录真实库基线
  mysql(`DROP DATABASE IF EXISTS ${A_DB};\nDROP DATABASE IF EXISTS ${C_DB};`);
  const realBefore = snapshot(REAL_DB);
  log(`\n【准备】真实库基线：${snapStr(realBefore)}`);
  log(`        测试库已清空：${A_DB}=${dbExists(A_DB)} / ${C_DB}=${dbExists(C_DB)}`);

  // ============ 场景 A：全新空库（库不存在）============
  log('\n========== 场景 A：全新空库（库都不存在）==========');
  const a1 = startBackend({ db: A_DB });
  const a1r = await a1.done;
  expect('A 后端启动成功', a1r.ok, a1r.ok ? 'Started' : a1r.why);
  const a1log = a1.log();
  const ev1 = initEvidence(a1log);
  log(`  日志证据：执行了 [${ev1.executed.join(' → ')}]`);
  log(`           建表语句 ${ev1.createTable} 条 / DROP TABLE ${ev1.drops} 次`);
  expect('A 启动时自动执行了 schema-auto.sql', ev1.schema > 0, `日志命中 ${ev1.schema} 次`);
  expect('A 启动时自动执行了 seed-base.sql', ev1.seed > 0, `日志命中 ${ev1.seed} 次`);
  expect('★ A 日志里全程没有一句 DROP TABLE（自动初始化不是重建型）',
    ev1.drops === 0, `DROP TABLE 出现 ${ev1.drops} 次`);

  const aExists = dbExists(A_DB);
  const aTables = tableCount(A_DB);
  const aSnap = snapshot(A_DB);
  expect('A 库被自动创建（createDatabaseIfNotExist 生效）', aExists, `exists=${aExists}`);
  expect('A 自动建出 17 张表', aTables === 17, `tables=${aTables}`);
  expect('A 基础种子就位（用户6/分类9/设置1/公告2）',
    aSnap && aSnap.u === 6 && aSnap.cat === 9 && aSnap.st === 1 && aSnap.no === 2,
    snapStr(aSnap));

  const aLogin = await login('admin', 'admin123');
  expect('★★ A 新库能真的登录成功（admin/admin123）',
    aLogin.json?.code === 0 && !!aLogin.json?.data?.token,
    `code=${aLogin.json?.code} msg=${aLogin.json?.message}`);
  const aToken = aLogin.json?.data?.token;

  const aGoods = await api('GET', '/goods?page=1&pageSize=10');
  expect('A 商品接口可用（新库无演示商品，list 为空是预期）',
    aGoods.json?.code === 0 && Array.isArray(aGoods.json?.data?.list),
    `code=${aGoods.json?.code} total=${aGoods.json?.data?.total}`);

  const aOnline = await api('GET', '/users/online?ids=1,2,3,4,5,6');
  expect('A 在线名单接口可用且口径生效（lisi=5 应不在名单里）',
    aOnline.json?.code === 0 && Array.isArray(aOnline.json?.data) && !aOnline.json.data.includes(5),
    `data=${JSON.stringify(aOnline.json?.data)}`);

  const aMe = await api('GET', '/user/profile', { token: aToken });
  expect('A 带 token 取本人资料成功（JWT 链路通）',
    aMe.json?.code === 0 && aMe.json?.data?.username === 'admin',
    `code=${aMe.json?.code} username=${aMe.json?.data?.username}`);

  await stopBackend(a1);

  // ============ 场景 A2：同一个库再启动一次 → 种子必须不重复 ============
  log('\n========== 场景 A2：同库重启 → 幂等复验 ==========');
  const a2 = startBackend({ db: A_DB });
  const a2r = await a2.done;
  expect('A2 后端重启成功', a2r.ok, a2r.ok ? 'Started' : a2r.why);
  const a2Snap = snapshot(A_DB);
  expect('★★ A2 重启后种子没有重复灌（用户仍 6、分类仍 9、设置仍 1、公告仍 2）',
    a2Snap.u === 6 && a2Snap.cat === 9 && a2Snap.st === 1 && a2Snap.no === 2,
    snapStr(a2Snap));
  const a2Login = await login('admin', 'admin123');
  expect('A2 重启后仍能登录', a2Login.json?.code === 0, `code=${a2Login.json?.code}`);
  await stopBackend(a2);

  // ============ 场景 B：现有业务库 → 必须零影响 ============
  log('\n========== 场景 B：现有业务库（campus_market）→ 逐项比对零变化 ==========');
  const b1 = startBackend({ db: REAL_DB });
  const b1r = await b1.done;
  expect('B 现有库能正常启动', b1r.ok, b1r.ok ? 'Started' : b1r.why);
  const evB = initEvidence(b1.log());
  expect('★★ B 启动日志里没有一句 DROP TABLE（老库的表不会被重建）',
    evB.drops === 0, `DROP TABLE ${evB.drops} 次 / 建表语句 ${evB.createTable} 条（全是 IF NOT EXISTS）`);
  const realAfter = snapshot(REAL_DB);
  log(`  启动前：${snapStr(realBefore)}`);
  log(`  启动后：${snapStr(realAfter)}`);
  expect('★★ B 表数不变（没有任何表被重建）', realAfter.tables === realBefore.tables, `${realBefore.tables} → ${realAfter.tables}`);
  expect('★★ B 商品数不变（自动脚本没有清库）', realAfter.g === realBefore.g, `${realBefore.g} → ${realAfter.g}`);
  expect('★★ B 全部关键表计数逐项不变',
    ['u', 'g', 'o', 'ol', 'al', 'ac', 'cat', 'st', 'no'].every((k) => realAfter[k] === realBefore[k]),
    `before=${JSON.stringify(realBefore)} after=${JSON.stringify(realAfter)}`);
  expect('★★ B 商品状态分布不变（在售/审核中/下架/售出的实例都还在）',
    realAfter.dist === realBefore.dist, `[${realBefore.dist}] → [${realAfter.dist}]`);
  const bLogin = await login('admin', 'admin123');
  expect('B 现有库登录正常', bLogin.json?.code === 0, `code=${bLogin.json?.code}`);
  const bGoods = await api('GET', '/goods?page=1&pageSize=5');
  expect('B 现有库商品接口有数据（演示数据没被动过）',
    bGoods.json?.code === 0 && bGoods.json?.data?.total > 0, `total=${bGoods.json?.data?.total}`);
  await stopBackend(b1);

  // ============ 场景 C：demo profile → 自动灌演示数据 ============
  log('\n========== 场景 C：--spring.profiles.active=demo → 自动灌演示数据 ==========');
  const c1 = startBackend({ db: C_DB, profile: 'demo' });
  const c1r = await c1.done;
  expect('C demo profile 启动成功', c1r.ok, c1r.ok ? 'Started' : c1r.why);
  const c1log = c1.log();
  const ev3 = initEvidence(c1log);
  log(`  日志证据：执行了 [${ev3.executed.join(' → ')}]`);
  expect('C 启动时执行了 seed-base + demo-data + demo-data-orders + demo-online-seed',
    ev3.seed > 0 && ev3.demoData > 0 && ev3.demoOrders > 0 && ev3.demoOnline > 0,
    `seed=${ev3.seed} demoData=${ev3.demoData} demoOrders=${ev3.demoOrders} demoOnline=${ev3.demoOnline}`);
  expect('★ C seed-base.sql 仍被执行（data-locations 整体覆盖这个坑没踩）',
    ev3.seed > 0 && ev3.firstAt('seed-base.sql') < ev3.firstAt('demo-data.sql'),
    `seed-base 命中 ${ev3.seed} 次，且在 demo-data 之前`);

  const cSnap = snapshot(C_DB);
  log(`  演示库快照：${snapStr(cSnap)}`);
  expect('C 自动灌出 16 件商品', cSnap?.g === 16, `g=${cSnap?.g}`);
  expect('C 自动灌出 9 笔订单', cSnap?.o === 9, `o=${cSnap?.o}`);
  expect('C 商品状态分布为 13 在售 / 1 审核中 / 1 下架 / 1 售出',
    cSnap?.dist.replace(/\s/g, '') === 'off_shelf=1on_sale=13pending=1sold=1', `dist=[${cSnap?.dist}]`);
  expect('★ C 演示脚本全部落在**目标库**上（跨库泄漏已修）',
    cSnap?.g === 16 && dbExists(C_DB), `目标库 ${C_DB} 商品数 = ${cSnap?.g}`);
  const cOnline = await api('GET', '/users/online?ids=1,2,3,4,5,6');
  expect('★ C 在线分布为 [1,2,4]（demo-online-seed 生效；5=lisi 活跃但隐藏）',
    JSON.stringify(cOnline.json?.data) === '[1,2,4]', `data=${JSON.stringify(cOnline.json?.data)}`);
  const cLogin = await login('zhangsan', '123456');
  expect('C 演示账号可登录', cLogin.json?.code === 0, `code=${cLogin.json?.code}`);
  await stopBackend(c1);

  // ============ 清理 ============
  mysql(`DROP DATABASE IF EXISTS ${A_DB};\nDROP DATABASE IF EXISTS ${C_DB};`);
  const realFinal = snapshot(REAL_DB);
  log(`\n【清理】测试库已删除：A=${dbExists(A_DB)} C=${dbExists(C_DB)}`);
  log(`【清理】真实库最终：${snapStr(realFinal)}`);
  expect('★★ 清理后真实库与最初基线完全一致（没有任何自动初始化碰过它）',
    JSON.stringify(realFinal) === JSON.stringify(realBefore),
    JSON.stringify(realFinal) === JSON.stringify(realBefore) ? '一致' : `before=${snapStr(realBefore)} after=${snapStr(realFinal)}`);

  // ============ 汇总 ============
  log('\n========== 断言汇总 ==========');
  let fail = 0;
  for (const c of checks) { if (!c.pass) fail++; log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.name} :: ${c.detail}`); }
  log(`\n========== 结果: ${fail === 0 ? `ALL PASS (${checks.length})` : fail + ' FAILED / ' + checks.length} ==========`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error('脚本异常:', e); process.exitCode = 2; });
