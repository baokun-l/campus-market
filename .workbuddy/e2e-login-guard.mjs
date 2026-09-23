/**
 * 真机探针：登录失败闸门（缺陷清单 M4 · 防暴力破解）
 *
 * 为什么单测不够：单测里时钟是假的、HTTP 层不存在。真机必须验证
 * 「JSON 请求体 → UserController → UserService → LoginAttemptGuard → 前端能看到的 message」
 * 这条完整链路上，锁定提示真的会以 1001 下发（而不是 401/500），
 * 且真实账号不会被误伤。
 *
 * ★ 本探针刻意**不**撞满 IP 维度 ★
 *   阈值 = 同一来源 15 分钟内 100 次失败 → 锁 5 分钟。探针自己是从 127.0.0.1 发起的，
 *   一旦把 100 次撞满，本机**所有**登录（包括正在演示的人、以及后续所有探针
 *   里依赖登录的用例）都会在 5 分钟内全部失败 —— 探针把自己的环境搞挂。
 *   所以 IP 维度只用假时钟在 LoginAttemptGuardTest 里覆盖，真机只覆盖账号维度。
 *
 * ★ 探针只用不存在的账号名（zzguard_*）+ 一个临时注册账号 ★
 *   绝不去撞 admin/种子账号：账号维度一锁就是 15 分钟，
 *   会直接把后续演示和探针一起毁掉（这正是闸门该有的行为，但对探针是自伤）。
 */
import { execSync } from 'node:child_process';

const BASE = 'http://127.0.0.1:8080/api';
const MYSQL = String.raw`C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe`;
const PREFIX = 'zzguard';
const GHOST = 'zzguard_ghost';          // 库里不存在，专门用来撞
const OTHER = 'zzguard_other';          // 库里不存在，用来验证「锁定按账号隔离」
const REAL = 'zzguard_ok';              // 临时注册，用来验证「成功登录清零」
const REAL_PWD = 'guard123456';
const PWD_ERROR = '用户名或密码错误';

function sql(q) {
  const cmd = `"${MYSQL}" -uroot -p123456 --default-character-set=utf8mb4 -N -B -Dcampus_market -e "${q}"`;
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function sqlQuiet(q) {
  try { return sql(q); } catch (e) { return 'ERR:' + String(e.message).slice(0, 120); }
}

let pass = 0;
let fail = 0;
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

const login = (username, password) =>
  api('POST', '/user/login', { body: { username, password } });

// ==================== A. 前置 ====================
section('A. 前置（探针幂等 + 基线）');

sqlQuiet(`DELETE FROM t_user WHERE username LIKE '${PREFIX}%'`);
check('A0 探针残留账号已清理', sql(`SELECT COUNT(*) FROM t_user WHERE username LIKE '${PREFIX}%'`) === '0');

const baseUsers = sql('SELECT COUNT(*) FROM t_user');
const baseGoods = sql('SELECT COUNT(*) FROM t_goods');
console.log(`  基线：t_user=${baseUsers}  t_goods=${baseGoods}`);

// ==================== B. 账号维度 ====================
section('B. 账号维度：连续失败 → 临时锁定');

for (let i = 1; i <= 4; i++) {
  const r = await login(GHOST, 'definitely-wrong');
  check(`B1.${i} 第 ${i} 次失败：1001 + 「${PWD_ERROR}」`,
    r.json?.code === 1001 && r.json?.message === PWD_ERROR,
    `code=${r.json?.code} msg=${r.json?.message}`);
}

{
  // 第 5 次失败自身触发锁定，但「用户看到的」仍应是口令错误 ——
  // 否则一个刚输错第 5 次的人会收到一条他完全无法理解的锁定通知
  const r = await login(GHOST, 'definitely-wrong');
  check('B2 第 5 次失败仍只提示口令错误（锁定从下一次才可见）',
    r.json?.code === 1001 && r.json?.message === PWD_ERROR,
    `code=${r.json?.code} msg=${r.json?.message}`);
}

{
  const r = await login(GHOST, 'definitely-wrong');
  const msg = r.json?.message || '';
  check('B3 ★ 第 6 次被闸门拦下：1001 + 文案含「锁定」+ 含剩余时间',
    r.json?.code === 1001 && msg.includes('锁定') && msg.includes('分钟'),
    `code=${r.json?.code} msg=${msg}`);
}

{
  // 唯一索引在 utf8mb4 下大小写不敏感，计数也必须归一化，
  // 否则把 GHOST 换成 ZZGUARD_GHOST 就又能白拿 5 次机会
  const r = await login(GHOST.toUpperCase(), 'definitely-wrong');
  check('B4 ★ 大小写变体同样被锁（用户名归一化生效）',
    (r.json?.message || '').includes('锁定'),
    `msg=${r.json?.message}`);
}

{
  const r = await login(OTHER, 'definitely-wrong');
  check('B5 锁定按账号隔离：换一个账号只提示口令错误，未被牵连',
    r.json?.code === 1001 && r.json?.message === PWD_ERROR,
    `code=${r.json?.code} msg=${r.json?.message}`);
}

// ==================== C. 成功登录清零 ====================
section('C. 成功登录即清空该账号的失败累计');

{
  const r = await api('POST', '/user/register', { body: { username: REAL, password: REAL_PWD, nickname: '探针' } });
  check('C0 临时探针账号注册成功（顺带确认 M5 注册口径没被改坏）',
    r.json?.code === 0, `code=${r.json?.code} msg=${r.json?.message}`);
}

for (let i = 1; i <= 4; i++) {
  const r = await login(REAL, 'definitely-wrong');
  check(`C1.${i} 错口令第 ${i} 次：仍是口令错误`,
    r.json?.message === PWD_ERROR, `msg=${r.json?.message}`);
}

{
  const r = await login(REAL, REAL_PWD);
  check('C2 正确口令登录成功（失败计数被清零）',
    r.json?.code === 0 && !!r.json?.data?.token, `code=${r.json?.code} msg=${r.json?.message}`);
}

{
  let allError = true;
  for (let i = 1; i <= 4; i++) {
    const r = await login(REAL, 'definitely-wrong');
    if (r.json?.message !== PWD_ERROR) allError = false;
  }
  // 若成功登录没清零，这 4 次里的第 1 次就凑满 5 次并给出锁定提示
  check('C3 ★ 再错 4 次仍是口令错误（未清零的话第 1 次就会锁）', allError);
}

{
  const r = await login(REAL, REAL_PWD);
  check('C4 仍然可以正常登录', r.json?.code === 0 && !!r.json?.data?.token,
    `code=${r.json?.code} msg=${r.json?.message}`);
}

// ==================== D. 真实账号未受牵连 ====================
section('D. 真实账号 / 正常流程未被误伤');

{
  const r = await login('admin', 'admin123');
  check('D1 ★ admin 仍能正常登录（闸门没有误伤正常流程，来源维度也没被撞满）',
    r.json?.code === 0 && !!r.json?.data?.token, `code=${r.json?.code} msg=${r.json?.message}`);
}

// ==================== E. 复位 + 复核 ====================
section('E. 复位与复核');

sqlQuiet(`DELETE FROM t_user WHERE username LIKE '${PREFIX}%'`);
check('E1 探针账号已清理',
  sql(`SELECT COUNT(*) FROM t_user WHERE username LIKE '${PREFIX}%'`) === '0');
check('E2 t_user 数量回到基线（没有留下注册残留）',
  sql('SELECT COUNT(*) FROM t_user') === baseUsers,
  `实际=${sqlQuiet('SELECT COUNT(*) FROM t_user')} 基线=${baseUsers}`);
check('E3 t_goods 数量未变（本探针不该动商品）',
  sql('SELECT COUNT(*) FROM t_goods') === baseGoods,
  `实际=${sqlQuiet('SELECT COUNT(*) FROM t_goods')} 基线=${baseGoods}`);

{
  const r = await login('admin', 'admin123');
  check('E4 复位后 admin 仍可登录（探针没有把环境搞坏）',
    r.json?.code === 0, `code=${r.json?.code} msg=${r.json?.message}`);
}

console.log('\n==================== 结果 ====================');
console.log(`PASS=${pass}  FAIL=${fail}`);
if (failures.length) {
  console.log('失败明细：');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(fail === 0 ? 0 : 1);
