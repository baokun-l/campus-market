/**
 * 端到端取证：「在线状态」从装饰性开关 → 有真实语义的服务端能力
 * ----------------------------------------------------------------------------
 * 要证明的事（全部走真实 HTTP + 真实 MySQL，不做源码推断）：
 *   ① 心跳接口 POST /api/user/heartbeat 真的把 last_active_at 推到「现在」
 *      —— 活跃时间由服务端落表，不认客户端自报。
 *   ② GET /api/users/online 的判定口径是真的：show_online=1 且 last_active_at
 *      在 300 秒窗口内。把时间戳改成 10 分钟前（其他列不动）→ 立刻从名单消失，
 *      证明它不是「一个布尔列假装在线」。
 *   ③ 隐私开关 PATCH /api/user/privacy {showOnline:false} 落库且语义精确：
 *      → 该用户从名单消失
 *      → 但 last_active_at **一个字节都不动**（关展示 ≠ 伪造离线，也 ≠ 清空活跃）
 *      → 再打开 true 立刻回到名单
 *   ④ 开关是「账号级」而非「设备级」：换一个 token 查名单，结果一致。
 *   ⑤ 越权被约束在 SQL 的 WHERE 里：张三关自己的开关，李四的 show_online 不变。
 *   ⑥ 参数形态健壮：ids=a,b / ids=a&ids=b / ids[]=a&ids[]=b 三种前端序列化都能收；
 *      非数字静默丢弃、空参不炸、重复去重、超 100 条不 500。
 *   ⑦ 权限边界：读名单对游客开放（未登录也要能看卖家在不在线），
 *      写接口（心跳 / 隐私）必须登录，否则 401。
 *   ⑧ 类型严格：{"showOnline":"false"}（字符串）必须被 1001 拒绝，
 *      而不是被 parseBoolean 静默当成 false —— 隐私配置最怕这种「悄悄生效」。
 *
 * 数据安全：
 *   - 不动商品、订单、审计表。只动 t_user 的 last_active_at / show_online。
 *   - 脚本开头对**全表**这两列做快照，finally 里逐行原值还原，还原后再查表复核。
 *   - 可重复运行。
 *
 * 运行前置：后端已在 http://127.0.0.1:8080 启动。
 * 用法：node e2e-online.mjs
 */
import { execFileSync } from 'node:child_process';

// ---------- 配置 ----------
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8080/api';
const MYSQL = process.env.MYSQL_BIN || 'D:/Program Files/MySQL/MySQL Server 8.0/bin/mysql.exe';
const DB = { host: '127.0.0.1', user: 'root', pass: '123456', name: 'campus_market' };

// 本机设了 HTTP_PROXY，Node fetch 必须显式清空，否则本地请求 502
process.env.HTTP_PROXY = '';
process.env.http_proxy = '';
process.env.HTTPS_PROXY = '';
process.env.https_proxy = '';

// 测试用账号（普通用户，避免碰 admin 的在线态影响其它探针/截图）
const ACCOUNTS = [
  { username: 'zhangsan', password: '123456', tag: '张三' },
  { username: 'lisi', password: '123456', tag: '李四' },
  { username: 'wangwu', password: '123456', tag: '王五' },
];
// 在线窗口（与 UserService.ONLINE_WINDOW_SECONDS 同口径，仅用于造「窗口外」数据）
const WINDOW_SECONDS = 300;

// ---------- MySQL 助手 ----------
function mysql(sql) {
  return execFileSync(MYSQL,
    ['-h' + DB.host, '-u' + DB.user, '-p' + DB.pass, DB.name],
    { input: sql + '\n', encoding: 'utf8' });
}
function mysqlRun(sql) { mysql(sql); }
function mysqlSelect(sql) {
  const out = mysql(sql);
  const lines = out.replace(/\r/g, '').trim().split('\n');
  return lines.slice(1).map(l => l.split('\t'));
}
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** t_user 两列的完整快照（用于原值还原） */
function snapshotUsers() {
  return mysqlSelect(
    `SELECT id, username, show_online,
            DATE_FORMAT(last_active_at, '%Y-%m-%d %H:%i:%s') AS t
     FROM t_user ORDER BY id`);
}
/** 某个 id 的两列现值 */
function userState(id) {
  const rows = mysqlSelect(
    `SELECT show_online, DATE_FORMAT(last_active_at, '%Y-%m-%d %H:%i:%s')
     FROM t_user WHERE id = ${id}`);
  if (!rows.length) return null;
  return { showOnline: rows[0][0], lastActiveAt: rows[0][1] === 'NULL' ? null : rows[0][1] };
}
function idOf(username) {
  const rows = mysqlSelect(`SELECT id FROM t_user WHERE username = ${q(username)}`);
  if (!rows.length) throw new Error(`找不到账号 ${username}`);
  return +rows[0][0];
}
function onlineBySql() {
  return mysqlSelect(
    `SELECT id FROM t_user
     WHERE show_online = 1 AND last_active_at > NOW() - INTERVAL ${WINDOW_SECONDS} SECOND
     ORDER BY id`).map(r => +r[0]);
}

// ---------- HTTP 助手 ----------
async function call(method, path, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(BASE + path, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON（如 500 白页）时留 null */ }
  return { http: res.status, json, text };
}
async function login(username, password) {
  const r = await call('POST', '/user/login', { body: { username, password } });
  if (r.json?.code !== 0 || !r.json?.data?.token)
    throw new Error(`登录失败 ${username}: code=${r.json?.code} msg=${r.json?.message}`);
  return { token: r.json.data.token, id: r.json.data.user?.id, role: r.json.data.user?.role };
}
/** 打开 / 关闭某人的在线展示，返回接口回的布尔值 */
async function setPrivacy(token, showOnline) {
  return call('PATCH', '/user/privacy', { token, body: { showOnline } });
}
/** 查在线名单；ids 直接拼进 query（调用方自行决定形态） */
async function online(token, idsQuery) {
  const path = idsQuery === undefined ? '/users/online' : `/users/online?${idsQuery}`;
  const r = await call('GET', path, { token });
  return { code: r.json?.code, data: r.json?.data, http: r.http, raw: r.json?.message };
}

// ---------- 主流程 ----------
const checks = [];
const evidence = [];
const expect = (name, cond, detail) => checks.push({ name, pass: !!cond, detail });
const rec = (label, o) => evidence.push({ label, ...o });

async function main() {
  const lines = [];
  const log = (s) => lines.push(s);

  // ===== 快照 =====
  const snap = snapshotUsers();
  log(`【快照】t_user 共 ${snap.length} 行，已记录 show_online + last_active_at 原值`);

  const users = {};
  for (const a of ACCOUNTS) {
    users[a.username] = { ...a, id: idOf(a.username) };
    log(`  账号 ${a.username}(${a.tag}) id=${users[a.username].id}`);
  }
  const zs = users.zhangsan, ls = users.lisi, ww = users.wangwu;
  const allIds = snap.map(r => +r[0]);
  const allIdsCsv = allIds.join(',');

  let sessions = {};
  try {
    // ===== 证据① 心跳把 last_active_at 推到「现在」 =====
    // 先人为把三人时间戳推到 2 天前（模拟「很久没来」），再看心跳能否救回来
    mysqlRun(`UPDATE t_user SET last_active_at = NOW() - INTERVAL 2 DAY,
                              show_online = 1
              WHERE id IN (${zs.id}, ${ls.id}, ${ww.id});`);
    const beforeBeat = {
      zs: userState(zs.id), ls: userState(ls.id), ww: userState(ww.id),
    };
    const listBeforeBeat = (await online(undefined, `ids=${allIdsCsv}`)).data;

    for (const a of ACCOUNTS) sessions[a.username] = await login(a.username, a.password);

    const beatResp = {};
    for (const a of ACCOUNTS) {
      const r = await call('POST', '/user/heartbeat', { token: sessions[a.username].token });
      beatResp[a.username] = { code: r.json?.code, http: r.http, msg: r.json?.message };
    }
    const afterBeat = {
      zs: userState(zs.id), ls: userState(ls.id), ww: userState(ww.id),
    };
    const listAfterBeat = (await online(undefined, `ids=${allIdsCsv}`)).data;

    rec('①心跳刷新活跃时间', {
      before: `zs=${beforeBeat.zs?.lastActiveAt} ls=${beforeBeat.ls?.lastActiveAt} ww=${beforeBeat.ww?.lastActiveAt}`,
      after: `zs=${afterBeat.zs?.lastActiveAt} ls=${afterBeat.ls?.lastActiveAt} ww=${afterBeat.ww?.lastActiveAt}`,
      resp: JSON.stringify(beatResp),
      listBefore: JSON.stringify(listBeforeBeat),
      listAfter: JSON.stringify(listAfterBeat),
    });
    log(`\n① 心跳：改前 zs=${beforeBeat.zs?.lastActiveAt} / 改后 zs=${afterBeat.zs?.lastActiveAt}`);
    log(`   三人心跳响应 ${JSON.stringify(beatResp)}`);
    log(`   名单 改前=${JSON.stringify(listBeforeBeat)} → 改后=${JSON.stringify(listAfterBeat)}`);

    expect('① 心跳 code=0（三个账号）',
      ACCOUNTS.every(a => beatResp[a.username].code === 0),
      JSON.stringify(beatResp));
    const ages = mysqlSelect(
      `SELECT id, TIMESTAMPDIFF(SECOND, last_active_at, NOW()) FROM t_user
       WHERE id IN (${zs.id}, ${ls.id}, ${ww.id}) ORDER BY id`);
    expect('① 三人时间戳都被推到「现在」（距今在 300 秒窗口内）',
      ages.length === 3 && ages.every(r => Math.abs(+r[1]) <= WINDOW_SECONDS),
      ages.map(r => `id=${r[0]} 距今${r[1]}s`).join(' | '));
    expect('① 心跳前三人均在窗口外（造数据有效）',
      listBeforeBeat.length === 0 || ![zs.id, ls.id, ww.id].some(i => listBeforeBeat.includes(i)),
      `listBefore=${JSON.stringify(listBeforeBeat)}`);
    expect('① 心跳后三人全进名单',
      [zs.id, ls.id, ww.id].every(i => listAfterBeat.includes(i)),
      `listAfter=${JSON.stringify(listAfterBeat)}`);
    expect('① 接口名单 == SQL 口径名单',
      JSON.stringify(listAfterBeat) === JSON.stringify(onlineBySql()),
      `api=${JSON.stringify(listAfterBeat)} sql=${JSON.stringify(onlineBySql())}`);

    // ===== 证据② 时间窗是真的（不只是布尔列）=====
    // 只把张三的时间戳改成 10 分钟前，show_online 保持 1
    mysqlRun(`UPDATE t_user SET last_active_at = NOW() - INTERVAL 10 MINUTE WHERE id = ${zs.id};`);
    const zsStale = userState(zs.id);
    const listStale = (await online(undefined, `ids=${allIdsCsv}`)).data;

    rec('②超出时间窗即离线', {
      sql: `UPDATE t_user SET last_active_at = NOW() - INTERVAL 10 MINUTE WHERE id=${zs.id}（show_online 保持 1）`,
      zsState: `show_online=${zsStale?.showOnline} last_active_at=${zsStale?.lastActiveAt}`,
      list: JSON.stringify(listStale),
    });
    log(`\n② 时间窗：把 ${zs.username} 时间戳改到 10 分钟前（show_online 仍为 ${zsStale?.showOnline}）`);
    log(`   名单=${JSON.stringify(listStale)}`);

    expect('② show_online 仍为 1（没被顺手改掉）', zsStale?.showOnline === '1', `show_online=${zsStale?.showOnline}`);
    expect('② 超窗用户被排除，且同批其他人不受影响',
      !listStale.includes(zs.id) && listStale.includes(ls.id) && listStale.includes(ww.id),
      `list=${JSON.stringify(listStale)} zs=${zs.id} ls=${ls.id} ww=${ww.id}`);
    // 还原张三为活跃（继续后面的用例）
    await call('POST', '/user/heartbeat', { token: sessions.zhangsan.token });

    // ===== 证据③ 隐私开关：落库 + 语义精确（不碰活跃时间）=====
    const lsBeforeOff = userState(ls.id);
    const offResp = await setPrivacy(sessions.lisi.token, false);
    const lsAfterOff = userState(ls.id);
    const listAfterOff = (await online(undefined, `ids=${allIdsCsv}`)).data;

    // 换个 token（张三）再查一次，证明是账号级而非设备级
    const listAfterOff2 = (await online(sessions.zhangsan.token, `ids=${allIdsCsv}`)).data;

    const onResp = await setPrivacy(sessions.lisi.token, true);
    const lsAfterOn = userState(ls.id);
    const listAfterOn = (await online(undefined, `ids=${allIdsCsv}`)).data;

    rec('③隐私开关落库', {
      '关闭·响应': `code=${offResp.json?.code} data=${JSON.stringify(offResp.json?.data)}`,
      '关闭·库内': `show_online=${lsAfterOff?.showOnline} last_active_at=${lsAfterOff?.lastActiveAt}`,
      '关闭·名单': JSON.stringify(listAfterOff),
      '关闭·换他人token查': JSON.stringify(listAfterOff2),
      '打开·响应': `code=${onResp.json?.code} data=${JSON.stringify(onResp.json?.data)}`,
      '打开·库内': `show_online=${lsAfterOn?.showOnline} last_active_at=${lsAfterOn?.lastActiveAt}`,
      '打开·名单': JSON.stringify(listAfterOn),
    });
    log(`\n③ 隐私开关（${ls.username}）：`);
    log(`   关闭 → code=${offResp.json?.code} data=${JSON.stringify(offResp.json?.data)} 库内 show_online=${lsAfterOff?.showOnline}`);
    log(`   名单=${JSON.stringify(listAfterOff)} / 换张三 token 查=${JSON.stringify(listAfterOff2)}`);
    log(`   打开 → code=${onResp.json?.code} data=${JSON.stringify(onResp.json?.data)} 库内 show_online=${lsAfterOn?.showOnline}`);
    log(`   名单=${JSON.stringify(listAfterOn)}`);

    expect('③ 关闭返回 code=0 且 data=false', offResp.json?.code === 0 && offResp.json?.data === false,
      `code=${offResp.json?.code} data=${JSON.stringify(offResp.json?.data)}`);
    expect('③ 关闭后落库 show_online=0', lsAfterOff?.showOnline === '0', `show_online=${lsAfterOff?.showOnline}`);
    expect('③ 关闭后本人从名单消失，其他人还在',
      !listAfterOff.includes(ls.id) && listAfterOff.includes(ww.id),
      `list=${JSON.stringify(listAfterOff)} ls=${ls.id}`);
    expect('③ 关闭的效果与 token 无关（账号级，不是设备级）',
      JSON.stringify(listAfterOff) === JSON.stringify(listAfterOff2),
      `anon=${JSON.stringify(listAfterOff)} other-token=${JSON.stringify(listAfterOff2)}`);
    expect('★ 关闭开关绝不篡改活跃时间（只改展示口径）',
      lsAfterOff?.lastActiveAt === lsBeforeOff?.lastActiveAt,
      `before=${lsBeforeOff?.lastActiveAt} after=${lsAfterOff?.lastActiveAt}`);
    expect('③ 打开返回 data=true 且落库 show_online=1',
      onResp.json?.data === true && lsAfterOn?.showOnline === '1',
      `data=${JSON.stringify(onResp.json?.data)} show_online=${lsAfterOn?.showOnline}`);
    expect('③ 打开后立刻回到名单', listAfterOn.includes(ls.id), `list=${JSON.stringify(listAfterOn)}`);

    // ===== 证据④ 越权：改自己不会碰到别人 =====
    const wwBefore = userState(ww.id);
    const zsBeforePriv = userState(zs.id);
    const zsOff = await setPrivacy(sessions.zhangsan.token, false);
    const wwAfter = userState(ww.id);
    const zsAfterPriv = userState(zs.id);
    // 还原张三
    await setPrivacy(sessions.zhangsan.token, true);

    rec('④越权隔离', {
      sqlNote: '张三调 PATCH /user/privacy 只应命中自己那一行（约束进 SELF 的 WHERE）',
      resp: `code=${zsOff.json?.code} data=${JSON.stringify(zsOff.json?.data)}`,
      zhangsan: `show_online ${zsBeforePriv?.showOnline} → ${zsAfterPriv?.showOnline}`,
      wangwu: `show_online ${wwBefore?.showOnline} → ${wwAfter?.showOnline}`,
    });
    log(`\n④ 越权隔离：张三关自己的开关 → 张三 show_online ${zsBeforePriv?.showOnline}→${zsAfterPriv?.showOnline}；王五 ${wwBefore?.showOnline}→${wwAfter?.showOnline}`);

    expect('④ 自己的开关生效', zsAfterPriv?.showOnline === '0', `show_online=${zsAfterPriv?.showOnline}`);
    expect('★ 别人的 show_online 不受影响',
      wwAfter?.showOnline === wwBefore?.showOnline,
      `wangwu before=${wwBefore?.showOnline} after=${wwAfter?.showOnline}`);

    // ===== 证据⑤ 参数形态与健壮性 =====
    const formCsv = await online(undefined, `ids=${allIdsCsv}`);
    const formRepeat = await online(undefined, allIds.map(i => `ids=${i}`).join('&'));
    const formBracket = await online(undefined, allIds.map(i => `ids%5B%5D=${i}`).join('&'));
    const formDirty = await online(undefined, `ids=abc,${ww.id},${ww.id},-1,999999,`);
    const formEmpty = await online(undefined, 'ids=');
    const formMissing = await online(undefined, undefined);
    const bigIds = Array.from({ length: 150 }, (_, i) => i + 1).join(',');
    const formBig = await online(undefined, `ids=${bigIds}`);

    rec('⑤参数形态与健壮性', {
      csv: `code=${formCsv.code} data=${JSON.stringify(formCsv.data)}`,
      repeat: `code=${formRepeat.code} data=${JSON.stringify(formRepeat.data)}`,
      bracket: `code=${formBracket.code} data=${JSON.stringify(formBracket.data)}`,
      dirty: `code=${formDirty.code} data=${JSON.stringify(formDirty.data)}`,
      empty: `code=${formEmpty.code} data=${JSON.stringify(formEmpty.data)}`,
      missing: `code=${formMissing.code} data=${JSON.stringify(formMissing.data)}`,
      big: `code=${formBig.code} 条数=${formBig.data?.length} http=${formBig.http}`,
    });
    log(`\n⑤ 参数形态：`);
    log(`   ids=1,2,3       → code=${formCsv.code} data=${JSON.stringify(formCsv.data)}`);
    log(`   ids=1&ids=2     → code=${formRepeat.code} data=${JSON.stringify(formRepeat.data)}`);
    log(`   ids[]=1&ids[]=2 → code=${formBracket.code} data=${JSON.stringify(formBracket.data)}`);
    log(`   脏值 abc,ww,ww,-1,999999, → code=${formDirty.code} data=${JSON.stringify(formDirty.data)}`);
    log(`   空 ids=         → code=${formEmpty.code} data=${JSON.stringify(formEmpty.data)}`);
    log(`   不传 ids        → code=${formMissing.code} data=${JSON.stringify(formMissing.data)}`);
    log(`   150 条          → code=${formBig.code} 条数=${formBig.data?.length} http=${formBig.http}`);

    const sameSet = (a, b) => JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort());
    expect('⑤ 三种序列化形态结果一致（含 axios 的 ids[] 形态）',
      sameSet(formCsv.data, formRepeat.data) && sameSet(formCsv.data, formBracket.data),
      `csv=${JSON.stringify(formCsv.data)} repeat=${JSON.stringify(formRepeat.data)} bracket=${JSON.stringify(formBracket.data)}`);
    expect('⑤ 脏值静默丢弃 + 去重 + 只回真实在线者',
      formDirty.code === 0 && formDirty.data.every(x => allIds.includes(x)) && new Set(formDirty.data).size === formDirty.data.length,
      `data=${JSON.stringify(formDirty.data)}`);
    expect('⑤ 空 ids / 不传 ids 返回空数组且不报错',
      formEmpty.code === 0 && Array.isArray(formEmpty.data) && formEmpty.data.length === 0 &&
      formMissing.code === 0 && Array.isArray(formMissing.data) && formMissing.data.length === 0,
      `empty=${JSON.stringify(formEmpty.data)} missing=${JSON.stringify(formMissing.data)}`);
    expect('⑤ 150 条不 500（上限收敛生效）',
      formBig.code === 0 && formBig.http === 200 && formBig.data.length <= 100,
      `code=${formBig.code} http=${formBig.http} len=${formBig.data?.length}`);

    // ===== 证据⑥ 权限边界 =====
    const beatAnon = await call('POST', '/user/heartbeat', {});
    const privAnon = await call('PATCH', '/user/privacy', { body: { showOnline: false } });
    const onlineAnon = await online(undefined, `ids=${allIdsCsv}`);

    // 关键：游客的隐私写入不能生效
    const wwAfterAnonWrite = userState(ww.id);
    const lsAfterAnonWrite = userState(ls.id);

    rec('⑥权限边界', {
      heartbeatNoToken: `code=${beatAnon.json?.code} http=${beatAnon.http} msg=${beatAnon.json?.message}`,
      privacyNoToken: `code=${privAnon.json?.code} http=${privAnon.http} msg=${privAnon.json?.message}`,
      onlineNoToken: `code=${onlineAnon.code} data=${JSON.stringify(onlineAnon.data)}`,
      dbUntouched: `ls=${lsAfterAnonWrite?.showOnline} ww=${wwAfterAnonWrite?.showOnline}`,
    });
    log(`\n⑥ 权限边界：`);
    log(`   心跳无 token   → code=${beatAnon.json?.code} http=${beatAnon.http} msg=${beatAnon.json?.message}`);
    log(`   隐私无 token   → code=${privAnon.json?.code} http=${privAnon.http} msg=${privAnon.json?.message}`);
    log(`   名单无 token   → code=${onlineAnon.code} data=${JSON.stringify(onlineAnon.data)}`);

    expect('⑥ 无 token 调心跳被拒（401）', beatAnon.json?.code === 401, `code=${beatAnon.json?.code}`);
    expect('⑥ 无 token 改隐私被拒（401）', privAnon.json?.code === 401, `code=${privAnon.json?.code}`);
    expect('⑥ 游客可读在线名单（商品详情未登录也要能看卖家在不在线）',
      onlineAnon.code === 0 && Array.isArray(onlineAnon.data),
      `code=${onlineAnon.code} data=${JSON.stringify(onlineAnon.data)}`);
    expect('⑥ 未授权的隐私写入没有落到任何一行',
      lsAfterAnonWrite?.showOnline === lsAfterOn?.showOnline && wwAfterAnonWrite?.showOnline === wwBefore?.showOnline,
      `ls=${lsAfterAnonWrite?.showOnline} ww=${wwAfterAnonWrite?.showOnline}`);

    // ===== 证据⑦ 类型严格：字符串布尔必须被拒 =====
    const lsBeforeBad = userState(ls.id);
    const badString = await call('PATCH', '/user/privacy',
      { token: sessions.lisi.token, body: { showOnline: 'false' } });
    const badMissing = await call('PATCH', '/user/privacy',
      { token: sessions.lisi.token, body: {} });
    const badNumber = await call('PATCH', '/user/privacy',
      { token: sessions.lisi.token, body: { showOnline: 0 } });
    const lsAfterBad = userState(ls.id);

    rec('⑦类型严格', {
      stringFalse: `code=${badString.json?.code} msg=${badString.json?.message}`,
      missingField: `code=${badMissing.json?.code} msg=${badMissing.json?.message}`,
      numberZero: `code=${badNumber.json?.code} msg=${badNumber.json?.message}`,
      dbUnchanged: `show_online ${lsBeforeBad?.showOnline} → ${lsAfterBad?.showOnline}`,
    });
    log(`\n⑦ 类型严格（${ls.username}，当前 show_online=${lsBeforeBad?.showOnline}）：`);
    log(`   {"showOnline":"false"} → code=${badString.json?.code} msg=${badString.json?.message}`);
    log(`   {}                     → code=${badMissing.json?.code} msg=${badMissing.json?.message}`);
    log(`   {"showOnline":0}       → code=${badNumber.json?.code} msg=${badNumber.json?.message}`);
    log(`   库内 show_online ${lsBeforeBad?.showOnline} → ${lsAfterBad?.showOnline}`);

    expect('⑦ 字符串 "false" 被拒（1001），不被静默当 false',
      badString.json?.code === 1001, `code=${badString.json?.code} msg=${badString.json?.message}`);
    expect('⑦ 缺字段被拒（1001），不被静默当 false',
      badMissing.json?.code === 1001, `code=${badMissing.json?.code} msg=${badMissing.json?.message}`);
    expect('⑦ 数字 0 被拒（1001），只认布尔字面量',
      badNumber.json?.code === 1001, `code=${badNumber.json?.code} msg=${badNumber.json?.message}`);
    expect('★ 三次非法写入后库内值原封不动（隐私配置不允许「悄悄生效」）',
      lsAfterBad?.showOnline === lsBeforeBad?.showOnline,
      `${lsBeforeBad?.showOnline} → ${lsAfterBad?.showOnline}`);

  } finally {
    // ===== 原值还原：逐行写回快照 =====
    let sql = '';
    for (const r of snap) {
      const [id, , showOnline, t] = r;
      const ts = t === 'NULL' ? 'NULL' : q(t);
      sql += `UPDATE t_user SET show_online = ${showOnline}, last_active_at = ${ts} WHERE id = ${id};\n`;
    }
    mysqlRun(sql);
  }

  // ===== 还原复核 =====
  const snapAfter = snapshotUsers();
  let drift = [];
  for (let i = 0; i < snap.length; i++) {
    if (snap[i].join('|') !== snapAfter[i]?.join('|')) {
      drift.push(`id=${snap[i][0]}: 原[${snap[i].slice(2).join(' ')}] → 现[${(snapAfter[i] ?? []).slice(2).join(' ')}]`);
    }
  }
  log(`\n【还原复核】${snap.length} 行，偏移 ${drift.length} 处${drift.length ? '：' + drift.join('; ') : '（与快照逐字节一致）'}`);
  expect('还原: t_user 两列与快照完全一致', drift.length === 0, drift.join('; ') || '无偏移');

  // ===== 输出 =====
  log('\n========== 证据明细 ==========');
  const fmt = (v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v));
  for (const e of evidence) {
    log(`\n● ${e.label}`);
    for (const [k, v] of Object.entries(e)) if (k !== 'label') log(`   ${k}: ${fmt(v)}`);
  }
  log('\n========== 断言 ==========');
  let fail = 0;
  for (const c of checks) { if (!c.pass) fail++; log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.name} :: ${c.detail}`); }
  log(`\n========== 结果: ${fail === 0 ? `ALL PASS (${checks.length})` : fail + ' FAILED / ' + checks.length} ==========`);

  console.log(lines.join('\n'));
  if (fail > 0) process.exitCode = 1;
}

main().catch(err => { console.error('脚本异常:', err); process.exitCode = 2; });
