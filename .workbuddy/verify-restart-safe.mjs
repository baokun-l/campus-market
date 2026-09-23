/**
 * 实测：重启后端会不会把数据库重写？
 * ----------------------------------------------------------------------------
 * 做法（对**真实业务库** campus_market 全程只读比对）：
 *   1. 对 17 张表逐表取 [行数 + CHECKSUM TABLE 校验和 + AUTO_INCREMENT]，作为「重启前指纹」
 *      —— CHECKSUM TABLE 是内容级校验和，比「行数没变」强得多：
 *         改一个字段、动一个时间戳、挪一行顺序都会变。
 *   2. 杀掉正在跑的后端，用**默认 profile**（不带 demo）原样重启
 *   3. 等 Started 后再取一次指纹，逐表比对
 *   4. 再打三个真实接口，确认服务本身是好的
 *
 * 结论只有两种：
 *   · 指纹逐表一致 → 重启**不会**重写数据库（默认 profile 下自动脚本全是 no-op）
 *   · 有任何一张表对不上 → 立刻打红，并列出是哪张表的哪一项变了
 *
 * 用法：node .workbuddy/verify-restart-safe.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { openSync, readFileSync } from 'node:fs';

const WS = 'C:\\Users\\刘宝杰\\Desktop\\软件开发项目实践\\软件开发\\实践任务3：后端开发(前后端分离)';
const BACKEND = join(WS, 'campus-secondhand-backend');
const JAR = join(BACKEND, 'target', 'campus-secondhand-backend-1.0.0.jar');
const JAVA = 'C:/Program Files/Java/jdk-17/bin/java.exe';
const MYSQL = 'D:/Program Files/MySQL/MySQL Server 8.0/bin/mysql.exe';
const LOGFILE = join(WS, '.workbuddy', 'backend-run7.log');
const PORT = 8080;
const BASE = `http://127.0.0.1:${PORT}/api`;
const DB = 'campus_market';

for (const k of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy']) process.env[k] = '';

const checks = [];
const expect = (name, cond, detail) => { checks.push({ name, pass: !!cond, detail }); };
const log = (s) => console.log(s);

const MYSQL_ARGS = ['-h127.0.0.1', '-uroot', '-p123456', '--default-character-set=utf8mb4'];
const mysql = (sql) => execFileSync(MYSQL, [...MYSQL_ARGS, DB], { input: sql + '\n', encoding: 'utf8' });
const rowsOf = (sql) => mysql(sql).replace(/\r/g, '').trim().split('\n').slice(1).map((l) => l.split('\t'));

const unquote = (s) => s.replace(/`/g, '').split('.').pop();

/** 重启前/后的「数据库指纹」：逐表 行数 + 校验和 + 自增值 */
function fingerprint() {
  const tables = rowsOf(
    `SELECT table_name FROM information_schema.tables WHERE table_schema='${DB}' AND table_type='BASE TABLE' ORDER BY table_name;`
  ).map((r) => r[0]);

  const ck = Object.fromEntries(rowsOf(`CHECKSUM TABLE ${tables.map((t) => `${DB}.${t}`).join(',')};`)
    .map((r) => [unquote(r[0]), r[1]]));

  const ai = Object.fromEntries(rowsOf(
    `SELECT table_name, IFNULL(auto_increment, -1) FROM information_schema.tables WHERE table_schema='${DB}' AND table_type='BASE TABLE';`
  ).map((r) => [r[0], r[1]]));

  const fp = {};
  for (const t of tables) {
    const c = rowsOf(`SELECT COUNT(*) FROM \`${t}\`;`)[0][0];
    fp[t] = { rows: c, ck: ck[t], ai: ai[t] };
  }
  return fp;
}

/** 找出占用 8080 的进程并杀掉 */
function killBackend() {
  let out = '';
  try { out = execFileSync('cmd.exe', ['/c', `netstat -ano | findstr :${PORT}`], { encoding: 'utf8' }); } catch { return null; }
  const pids = [...new Set(out.split(/\r?\n/).filter((l) => /LISTENING/.test(l))
    .map((l) => l.trim().split(/\s+/).pop()).filter((p) => /^\d+$/.test(p) && p !== '0'))];
  for (const p of pids) { try { execFileSync('taskkill', ['/PID', p, '/F', '/T'], { stdio: 'ignore' }); } catch {} }
  return pids;
}

async function waitPortFree() {
  for (let i = 0; i < 40; i++) {
    try { execFileSync('cmd.exe', ['/c', `netstat -ano | findstr :${PORT}`], { stdio: 'ignore' }); await new Promise((r) => setTimeout(r, 400)); }
    catch { return true; }
  }
  return false;
}

async function main() {
  log(`【1】重启前指纹（库 = ${DB}）`);
  const before = fingerprint();
  log(`  表数 = ${Object.keys(before).length}`);
  log(`  指纹样例：t_user=${JSON.stringify(before.t_user)}  t_goods=${JSON.stringify(before.t_goods)}`);

  log(`\n【2】杀掉 8080 上的后端`);
  const killed = killBackend();
  log(`  已杀 PID：${killed && killed.length ? killed.join(', ') : '(无)'}`);
  await waitPortFree();

  log(`\n【3】用默认 profile 原样重启（不带 demo）`);
  const fd = openSync(LOGFILE, 'w');
  const proc = spawn(JAVA, ['-jar', JAR, `--server.port=${PORT}`], {
    cwd: BACKEND, detached: true, stdio: ['ignore', fd, fd], env: { ...process.env },
  });
  proc.unref();
  const t0 = Date.now();
  let started = false;
  while (Date.now() - t0 < 90_000) {
    await new Promise((r) => setTimeout(r, 500));
    let txt = '';
    try { txt = readFileSync(LOGFILE, 'utf8'); } catch {}
    if (/Started CampusMarketApplication/.test(txt)) { started = true; break; }
    if (/APPLICATION FAILED TO START|Error starting ApplicationContext/.test(txt)) break;
  }
  log(`  ${started ? '启动成功（Started）' : '启动失败/超时'}`);
  expect('重启后后端能正常启动', started, started ? 'Started' : '见 backend-run7.log');

  log(`\n【4】重启后指纹 + 逐表比对`);
  const after = fingerprint();
  const tNames = Object.keys(before);
  const diffs = [];
  for (const t of tNames) {
    for (const k of ['rows', 'ck', 'ai']) {
      if (before[t][k] !== after[t][k]) diffs.push(`${t}.${k}: ${before[t][k]} → ${after[t][k]}`);
    }
  }
  log(`  比对表数 = ${tNames.length}，差异项 = ${diffs.length}`);
  if (diffs.length) diffs.forEach((d) => log(`    ✗ ${d}`));
  else log('    ✓ 17 张表的行数 / CHECKSUM 校验和 / AUTO_INCREMENT 全部逐字节一致');

  expect('★★ 全部 17 张表逐表比对无差异（行数 + 校验和 + 自增值）',
    diffs.length === 0, diffs.length ? diffs.slice(0, 6).join(' | ') : '完全一致');
  expect('★★ 没有一张表被 DROP / 重建（表名集合不变）',
    JSON.stringify(Object.keys(after).sort()) === JSON.stringify(tNames.slice().sort()),
    `${tNames.length} → ${Object.keys(after).length}`);
  expect('★★ 行数总量不变', 
    Object.values(before).reduce((s, v) => s + +v.rows, 0) === Object.values(after).reduce((s, v) => s + +v.rows, 0),
    '总行数一致');

  log(`\n【5】服务可用性（真实 HTTP）`);
  const login = await (await fetch(BASE + '/user/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  })).json();
  expect('重启后仍能登录（admin/admin123）', login.code === 0, `code=${login.code}`);

  const goods = await (await fetch(BASE + '/goods?page=1&pageSize=5')).json();
  expect('重启后商品接口正常', goods.code === 0 && goods.data.total > 0, `code=${goods.code} total=${goods.data?.total}`);

  const online = await (await fetch(BASE + '/users/online?ids=1,2,3,4,5,6')).json();
  expect('重启后在线名单接口正常', online.code === 0 && Array.isArray(online.data), `code=${online.code} data=${JSON.stringify(online.data)}`);

  log('\n========== 结论 ==========');
  let fail = 0;
  for (const c of checks) { if (!c.pass) fail++; log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.name} :: ${c.detail}`); }
  log(`\n${fail === 0 ? '✅ 重启不会重写数据库（默认 profile）' : `❌ ${fail} 项未通过`}`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error('脚本异常:', e); process.exitCode = 2; });
