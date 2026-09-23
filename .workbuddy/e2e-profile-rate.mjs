/**
 * 端到端取证：批次 B（B1 个人资料接口 / B2 每日发布上限）+ 服务费率跨边界单位修复
 * ----------------------------------------------------------------------------
 * 全程走真实 HTTP + 真实 MySQL，不做源码推断。要证明三件事：
 *
 * 【B1】PATCH /user/profile 真的存在，且是「局部更新」
 *   ① 未登录 401；空 body / 拼错键名 / 空白昵称 / 超长昵称 / 非法手机号 一律 1001（不是 500）；
 *   ② 只传 nickname 时，credit_score / status / role / password / token_version / username
 *      **一个字节都不变** —— 这是「只 SET 指定列，不用 updateById 整实体回写」的唯一硬证据；
 *   ③ 手机号传空串 = 清空（落库 NULL），传合法值落库，传非法值（含位数对但格式错的）拒绝；
 *   ④ 返回值就是落库值（前端要用它回填，不能沿用本地乐观值）；
 *   ⑤ 请求体里塞 id / userId 无法改到别人（身份只认 token）。
 *
 * 【B2】t_settings.max_publish_per_day 真的拦得住发布
 *   ① 上限设成「今天已发数 + 1」→ 第 1 件发布成功，第 2 件被拒（1001）；
 *   ② 被拒时**商品表行数不变** —— 证明是「先拦后写」而不是「写完再删」；
 *   ③ 上限设 0 → 不限，可以继续发；
 *   ④ 上限按卖家分别计算，不牵连其他卖家。
 *
 * 【C】服务费率的跨边界单位错（本轮发现并修复）
 *   ① 直传 {commissionRate: 2} 必须被 1001 拒绝
 *      —— 那正是修复前前端一直发出去的值（界面按百分比 0~20，后端按比率 0~1 校验）；
 *   ② 传 0.02（= 前端修复后发的值）必须成功；
 *   ③ GET 回读是比率 0.02 而非百分比 2 —— 证明前端的 ×100 换算是必需的，不是多余代码；
 *   ④ 边界：1 合法、1.01 拒绝；表单上限 20% 换算成 0.2 后合法。
 *
 * 数据安全：
 *   - 开头快照 t_user(zhangsan 的 nickname/avatar/phone) + t_settings 整行；
 *   - 结束（含异常）一律原值还原，并**再查表复核**；
 *   - 探针发布的商品按主键删除，连带删掉它产生的 goods.publish 审计流水；
 *   - 不触碰订单表，不改动演示基线商品（#12 保持 pending）。
 *
 * 运行前置：后端已在 http://127.0.0.1:8080 启动（须用含本轮改动的正本 jar）。
 * 用法：node .workbuddy/e2e-profile-rate.mjs
 */
import { execFileSync } from 'node:child_process';

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8080/api';
const MYSQL = process.env.MYSQL_BIN || 'D:/Program Files/MySQL/MySQL Server 8.0/bin/mysql.exe';
const DB = { host: '127.0.0.1', user: 'root', pass: '123456', name: 'campus_market' };

// 本机设了系统代理，Node fetch 必须显式清空，否则本地请求 502
for (const k of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy']) process.env[k] = '';

const log = (...a) => console.log(...a);

/* ---------------- MySQL 助手（必须显式 utf8mb4：本探针要读写中文昵称） ---------------- */
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
  return rows.length ? rows[0][0] : null;
}
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
/** SQL 字面量：null/undefined → NULL，数字原样，其余按字符串加引号 */
const v = (x) => (x === null || x === undefined || x === 'NULL' ? 'NULL' : typeof x === 'number' ? String(x) : q(x));

/* ---------------- HTTP 助手 ---------------- */
async function call(method, path, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON（如 500 白页）时留 null */ }
  return { http: res.status, code: json?.code, message: json?.message, data: json?.data };
}
async function login(username, password) {
  const r = await call('POST', '/user/login', { body: { username, password } });
  if (r.code !== 0 || !r.data?.token) throw new Error(`登录失败 ${username}: code=${r.code} msg=${r.message}`);
  return { token: r.data.token, user: r.data.user };
}

/* ---------------- 结果收集 ---------------- */
const checks = [];
const expect = (name, cond, detail) => checks.push({ name, pass: !!cond, detail: String(detail) });

/* ---------------- 快照 / 还原 ---------------- */
const SELECT_PROFILE = (uid) =>
  `SELECT nickname, IFNULL(avatar,'<NULL>'), IFNULL(phone,'<NULL>'),
          credit_score, status, role, username, password, IFNULL(token_version,0)
   FROM t_user WHERE id = ${uid}`;

function profileNow(uid) {
  const r = mysqlSelect(SELECT_PROFILE(uid))[0];
  return {
    nickname: r[0] === 'NULL' ? null : r[0],
    avatar: r[1] === '<NULL>' ? null : r[1],
    phone: r[2] === '<NULL>' ? null : r[2],
    creditScore: r[3], status: r[4], role: r[5], username: r[6], password: r[7], tokenVersion: r[8]
  };
}

const SETTINGS_COLS = ['site_name', 'service_phone', 'announce_text', 'goods_audit_required',
  'max_publish_per_day', 'auto_offline_days', 'report_auto_hide', 'commission_rate'];

function settingsSnapshot() {
  const r = mysqlSelect(`SELECT id, ${SETTINGS_COLS.join(', ')} FROM t_settings ORDER BY id LIMIT 1`)[0];
  const o = { id: Number(r[0]) };
  SETTINGS_COLS.forEach((c, i) => (o[c] = r[i + 1]));
  return o;
}
const settingsMaxPublish = () => Number(scalar('SELECT max_publish_per_day FROM t_settings ORDER BY id LIMIT 1'));
const settingsCommissionRaw = () => scalar('SELECT commission_rate FROM t_settings ORDER BY id LIMIT 1');
const goodsCountToday = (sellerId) =>
  Number(scalar(`SELECT COUNT(*) FROM t_goods WHERE seller_id = ${sellerId} AND create_time >= CURDATE()`));
const goodsTotal = () => Number(scalar('SELECT COUNT(*) FROM t_goods'));

/* ---------------- 全局状态：供收尾复核 ---------------- */
const createdGoods = [];
const restorers = [];
let settingsBeforeRef = null;
let failed = 0;

/* ---------------- 主流程 ---------------- */
async function main() {
  const admin = await login('admin', 'admin123');
  const seller = await login('zhangsan', '123456');
  const uid = seller.user.id;
  const adminId = admin.user.id;
  log(`登录：admin(id=${adminId}, role=${admin.user.role}) / zhangsan(id=${uid}, role=${seller.user.role})`);

  /* ============================================================
   * B1 · PATCH /user/profile
   * ============================================================ */
  log('\n========== B1 · PATCH /user/profile ==========');
  const before = profileNow(uid);
  const adminNickBefore = profileNow(adminId).nickname;
  restorers.push(() =>
    mysql(`UPDATE t_user SET nickname = ${v(before.nickname)}, avatar = ${v(before.avatar)},
           phone = ${v(before.phone)} WHERE id = ${uid}`));

  // ① 鉴权：未登录必须 401（本项目错误一律 HTTP 200 + body code）
  const anon = await call('PATCH', '/user/profile', { body: { nickname: 'x' } });
  expect('①未登录被拒（body code=401）', anon.code === 401, `code=${anon.code} msg=${anon.message}`);

  // ② 参数形态全覆盖：一律 1001，绝不能是 500
  const badCases = [
    ['空 body', {}],
    ['拼错键名 nickName', { nickName: '张三改' }],
    ['空白昵称', { nickname: '   ' }],
    ['昵称超长(51 字)', { nickname: '甲'.repeat(51) }],
    ['手机号 11 位字母', { phone: 'abcdefghijk' }],
    ['手机号 10 位', { phone: '1380013800' }]
  ];
  for (const [label, body] of badCases) {
    const r = await call('PATCH', '/user/profile', { token: seller.token, body });
    expect(`②${label} → 1001`, r.code === 1001, `code=${r.code} msg=${r.message}`);
  }

  // ③ 只改昵称：其它列必须一字节不变（局部更新的硬证据）
  const NICK = '探针昵称·局部更新';
  const r3 = await call('PATCH', '/user/profile', { token: seller.token, body: { nickname: NICK } });
  const after3 = profileNow(uid);
  expect('③改昵称成功且落库', r3.code === 0 && after3.nickname === NICK, `code=${r3.code} db=${after3.nickname}`);
  expect('③返回值即落库值（前端靠它回填）', r3.data?.nickname === after3.nickname,
    `api=${r3.data?.nickname} db=${after3.nickname}`);
  const untouched = ['creditScore', 'status', 'role', 'username', 'password', 'tokenVersion'];
  const drifted = untouched.filter((k) => String(after3[k]) !== String(before[k]));
  expect('③★ credit_score/status/role/username/password/token_version 全未变',
    drifted.length === 0, drifted.length ? `被改动列：${drifted.join(',')}` : '全部一致（未整实体回写）');

  // ④ 手机号三态
  const r4a = await call('PATCH', '/user/profile', { token: seller.token, body: { phone: '13800138000' } });
  expect('④手机号合法值落库', r4a.code === 0 && profileNow(uid).phone === '13800138000',
    `code=${r4a.code} db=${profileNow(uid).phone}`);
  const r4b = await call('PATCH', '/user/profile', { token: seller.token, body: { phone: '' } });
  expect('④手机号空串 = 清空（落库 NULL）', r4b.code === 0 && profileNow(uid).phone === null,
    `code=${r4b.code} db=${profileNow(uid).phone}`);

  // ⑤ 头像可单独更新
  const AVA = 'https://example.com/probe-avatar.png';
  const r5 = await call('PATCH', '/user/profile', { token: seller.token, body: { avatar: AVA } });
  expect('⑤头像可单独更新', r5.code === 0 && profileNow(uid).avatar === AVA,
    `code=${r5.code} db=${profileNow(uid).avatar}`);

  // ⑥ 请求体注入 id / userId：身份只认 token，注入的键既不生效也不报错
  //
  // ★ 期望值是 code=0，不是 1001 ★
  // 服务端按「请求体里出现了哪个已知字段」决定改哪几列，`id` / `userId` 不是已知字段，
  // 因此被**无视**（而不是拒绝）—— 这与「拼错键名且没有任何已知键 → 1001」是两件事：
  // 前者是「多传了无关字段仍能正常改昵称」，后者是「以为改了其实一个字段都没匹配上」。
  // 真正要证明的安全属性不是「报错」，而是「**写法落到自己那一行，目标用户毫发无损**」。
  const INJECT = '注入尝试昵称';
  const rInject = await call('PATCH', '/user/profile', {
    token: seller.token, body: { id: adminId, userId: adminId, nickname: INJECT }
  });
  expect('⑥★ body 注入 id/userId 不改别人（写入落在自己行上）',
    rInject.code === 0 && profileNow(adminId).nickname === adminNickBefore && profileNow(uid).nickname === INJECT,
    `code=${rInject.code}｜admin.nickname=${profileNow(adminId).nickname}（应仍为 ${adminNickBefore}）`
    + `｜zhangsan.nickname=${profileNow(uid).nickname}`);

  // ⑦ 汇总复核：跑完整轮 B1 之后，admin 那一行应当一个字节都没动
  const adminNickAfter = profileNow(adminId).nickname;
  expect('⑦admin 行始终未被本探针改动', adminNickAfter === adminNickBefore && !!adminNickAfter,
    `before=${adminNickBefore} after=${adminNickAfter}`);

  /* ============================================================
   * B2 · 每日发布上限真生效
   * ============================================================ */
  log('\n========== B2 · max_publish_per_day 真生效 ==========');
  const sBefore = settingsSnapshot();
  settingsBeforeRef = sBefore;
  restorers.push(() =>
    mysql(`UPDATE t_settings SET ${SETTINGS_COLS.map((c) => `${c} = ${v(sBefore[c])}`).join(', ')}
           WHERE id = ${sBefore.id}`));
  restorers.push(() => {
    for (const gid of createdGoods) {
      mysql(`DELETE FROM t_audit_log WHERE action = 'goods.publish' AND target = ${q('商品 #' + gid)}`);
      mysql(`DELETE FROM t_goods WHERE id = ${gid}`);
    }
  });

  const base = goodsCountToday(uid);
  log(`今日 zhangsan 已发布 ${base} 件（base），当前上限 = ${settingsMaxPublish()}`);

  const setLimit = async (n) => {
    const r = await call('PATCH', '/admin/settings', { token: admin.token, body: { maxPublishPerDay: n } });
    if (r.code !== 0) throw new Error(`设置发布上限失败: code=${r.code} msg=${r.message}`);
  };
  const payload = (tag) => ({
    title: '探针商品-' + tag, price: 9.9, stock: 1, categoryId: 1, categoryName: '教材',
    description: 'e2e 探针，用完即删', cover: '/goods/cat1-1.jpg', images: ['/goods/cat1-1.jpg'],
    location: '校园内', deliveryMethod: 'face'
  });

  // ① 上限 = base + 1
  await setLimit(base + 1);
  const p1 = await call('POST', '/goods', { token: seller.token, body: payload('在限内') });
  if (p1.code === 0 && p1.data?.id) createdGoods.push(p1.data.id);
  expect(`①上限=${base + 1} 时第 1 件发布成功`, p1.code === 0, `code=${p1.code} msg=${p1.message} id=${p1.data?.id}`);
  expect('①发布后今日计数 = base+1', goodsCountToday(uid) === base + 1, `now=${goodsCountToday(uid)}`);

  const totalBeforeReject = goodsTotal();
  const p2 = await call('POST', '/goods', { token: seller.token, body: payload('超限') });
  expect('②超限发布被 1001 拒绝', p2.code === 1001, `code=${p2.code} msg=${p2.message}`);
  expect('②拒绝语说明上限与重试时机', /今天最多发布/.test(p2.message || ''), `msg=${p2.message}`);
  expect('②★ 先拦后写：商品表总行数不变', goodsTotal() === totalBeforeReject,
    `before=${totalBeforeReject} after=${goodsTotal()}`);

  // ③ 上限 0 = 不限
  await setLimit(0);
  const p3 = await call('POST', '/goods', { token: seller.token, body: payload('不限') });
  if (p3.code === 0 && p3.data?.id) createdGoods.push(p3.data.id);
  expect('③上限 0 = 不限，可继续发布', p3.code === 0, `code=${p3.code} msg=${p3.message}`);

  // ④ 按卖家分别计数
  await setLimit(1);
  const other = await login('lisi', '123456');
  const lisiBase = goodsCountToday(other.user.id);
  const p4 = await call('POST', '/goods', { token: other.token, body: payload('他人') });
  if (p4.code === 0 && p4.data?.id) createdGoods.push(p4.data.id);
  const expectP4 = lisiBase >= 1 ? p4.code === 1001 : p4.code === 0;
  expect(`④按卖家分别计数（lisi 今日 ${lisiBase} 件 / 上限 1）`, expectP4,
    `code=${p4.code} msg=${p4.message}`);

  /* ============================================================
   * C · 服务费率：界面百分比 ↔ 线上比率
   * ============================================================ */
  log('\n========== C · 服务费率跨边界单位 ==========');
  const rateBefore = settingsCommissionRaw();
  log(`费率原值（库里）=${rateBefore}`);

  const rc1 = await call('PATCH', '/admin/settings', { token: admin.token, body: { commissionRate: 2 } });
  expect('①直传 2（= 修复前的线上行为）被 1001 拒绝', rc1.code === 1001, `code=${rc1.code} msg=${rc1.message}`);

  const rc2 = await call('PATCH', '/admin/settings', { token: admin.token, body: { commissionRate: 0.02 } });
  expect('②传 0.02（= 修复后前端发的值）保存成功', rc2.code === 0, `code=${rc2.code} msg=${rc2.message}`);

  const rc3 = await call('GET', '/admin/settings', { token: admin.token });
  expect('③★ GET 回读的是比率 0.02（证明前端 ×100 换算必需）',
    Number(rc3.data?.commissionRate) === 0.02, `api=${rc3.data?.commissionRate} db=${settingsCommissionRaw()}`);

  const rc4 = await call('PATCH', '/admin/settings', { token: admin.token, body: { commissionRate: 1 } });
  const rc5 = await call('PATCH', '/admin/settings', { token: admin.token, body: { commissionRate: 1.01 } });
  expect('④边界：1 合法 / 1.01 拒绝', rc4.code === 0 && rc5.code === 1001,
    `1→${rc4.code}、1.01→${rc5.code} msg=${rc5.message}`);

  const rc6 = await call('PATCH', '/admin/settings', { token: admin.token, body: { commissionRate: 0.2 } });
  expect('⑤表单上限 20% → 换算成 0.2 合法（修复前会以 20 直传被拒）', rc6.code === 0,
    `code=${rc6.code} msg=${rc6.message}`);
}

/* ---------------- 收尾：还原 + 复核 ---------------- */
try {
  await main();
} catch (e) {
  failed++;
  log(`\n[异常] ${e?.stack || e}`);
} finally {
  log('\n========== 收尾：还原并复核 ==========');
  for (const fn of restorers.reverse()) {
    try { fn(); } catch (e) { failed++; log(`[还原失败] ${e.message}`); }
  }
  if (settingsBeforeRef) {
    const nowSet = settingsSnapshot();
    const diff = SETTINGS_COLS.filter((c) => String(nowSet[c]) !== String(settingsBeforeRef[c]));
    log(`设置行还原：${diff.length === 0 ? '✅ 与原值一致' : '⚠️ 差异列 ' + diff.join(', ')}`);
    if (diff.length) failed++;
  }
  const leftover = createdGoods.filter((id) => Number(scalar(`SELECT COUNT(*) FROM t_goods WHERE id = ${id}`)) > 0);
  log(`探针商品残留：${leftover.length} 件 ${leftover.length === 0 ? '✅' : '⚠️ ' + leftover.join(',')}`);
  if (leftover.length) failed++;
}

log('\n========== 结果 ==========');
for (const c of checks) {
  if (!c.pass) failed++;
  log(`[${c.pass ? 'PASS' : 'FAIL'}] ${c.name} :: ${c.detail}`);
}
log(`\n合计 ${checks.length} 项，FAIL ${failed} 项 → ${failed === 0 ? 'ALL PASS' : '存在失败'}`);
process.exit(failed === 0 ? 0 : 1);
