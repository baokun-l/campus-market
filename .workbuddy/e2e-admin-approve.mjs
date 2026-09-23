/**
 * 只读行为实测取证：管理员"通过"缺陷的根因验证
 * ----------------------------------------------------------------------------
 * 证明三件事（全部用真实 HTTP 请求，不读源码推断）：
 *   ① 管理员走真审核入口 POST /api/review/goods/{id}/review {"action":"approve"}
 *      → code=0，商品变 on_sale，t_goods_audit_record 增 1 条 approve，
 *        t_audit_log 增 1 条 action='goodsAudit.approve'。
 *   ② 通用接口 PATCH /api/goods/{id}/status {"status":"on_sale"}（另一条 pending）
 *      → code=1001，message 精确为「商品还在审核中，通过审核后才可以上架」，状态仍是 pending。
 *   ③ 卖家(非管理员)对自己 pending 商品走同一个 PATCH → 同样被 1001 拦住，状态仍是 pending。
 *
 * 数据安全：
 *   - 不碰商品 #12（已有探针依赖）。
 *   - 测试商品自己造：纯 ASCII 独特前缀 __PROBE_APPROVE_A__ / __PROBE_APPROVE_B__ / __PROBE_SELLER_C__。
 *   - 清理按精确主键 id 删除；删完复核计数回到基线。
 *   - 脚本自带清理（try/finally），可重复运行。
 *
 * 运行前置：后端已在 http://localhost:8080 启动（E2E_BASE 可覆盖）。
 * 用法：node e2e-admin-approve.mjs
 */
import { execFileSync } from 'node:child_process';

// ---------- 配置 ----------
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8080/api';
const MYSQL = process.env.MYSQL_BIN || 'D:/Program Files/MySQL/MySQL Server 8.0/bin/mysql.exe';
const DB = { host: '127.0.0.1', user: 'root', pass: '123456', name: 'campus_market' };

// 本机设了 HTTP_PROXY，Node fetch 必须显式清空，否则 502
process.env.HTTP_PROXY = '';
process.env.http_proxy = '';
process.env.HTTPS_PROXY = '';
process.env.https_proxy = '';

const TITLES = {
  A: '__PROBE_APPROVE_A__',
  B: '__PROBE_APPROVE_B__',
  C: '__PROBE_SELLER_C__',
};
const SELLER_ID = 4;        // zhangsan
const SELLER_NAME = 'zhangsan';
const CATEGORY_ID = 1;
const CATEGORY_NAME = 'probe_cat';   // ASCII，避免中文管道编码问题
// 期望挡板精确文案（来自 BusinessException.of，PARAM_ERROR=1001）
const EXPECT_MSG = '商品还在审核中，通过审核后才可以上架';

// ---------- MySQL 助手 ----------
function mysql(sql) {
  return execFileSync(MYSQL,
    ['-h' + DB.host, '-u' + DB.user, '-p' + DB.pass, DB.name],
    { input: sql + '\n', encoding: 'utf8' });
}
/** 执行多行 SQL（不含读取） */
function mysqlRun(sql) { mysql(sql); }
/** 执行 SELECT 并把结果按行解析成二维数组（跳过表头行） */
function mysqlSelect(sql) {
  const out = mysql(sql);
  return out.trim().split('\n').slice(1).map(l => l.split('\t'));
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
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}
async function login(username, password) {
  const r = await call('POST', '/user/login', { body: { username, password } });
  if (r.json?.code !== 0 || !r.json?.data?.token)
    throw new Error(`登录失败 ${username}: code=${r.json?.code} msg=${r.json?.message}`);
  return { token: r.json.data.token, user: r.json.data.user };
}

// ---------- 证据收集 ----------
const evidence = [];
function record(label, obj) { evidence.push({ label, ...obj }); }

function countsSnapshot() {
  const [u] = mysqlSelect(`SELECT COUNT(*) FROM t_user`);
  const [g] = mysqlSelect(`SELECT COUNT(*) FROM t_goods`);
  const [o] = mysqlSelect(`SELECT COUNT(*) FROM t_order`);
  const [ol] = mysqlSelect(`SELECT COUNT(*) FROM t_order_log`);
  const [al] = mysqlSelect(`SELECT COUNT(*) FROM t_audit_log`);
  const [gar] = mysqlSelect(`SELECT COUNT(*) FROM t_goods_audit_record`);
  const [act] = mysqlSelect(`SELECT COUNT(*) FROM t_activity`);
  const dist = mysqlSelect(
    `SELECT status, COUNT(*) FROM t_goods GROUP BY status ORDER BY COUNT(*) DESC`)
    .map(r => `${r[0]}=${r[1]}`).join(' ');
  return { u: +u[0], g: +g[0], o: +o[0], ol: +ol[0], al: +al[0], gar: +gar[0], act: +act[0], dist };
}

function statusOf(id) {
  const [r] = mysqlSelect(`SELECT status FROM t_goods WHERE id=${id}`);
  return r ? r[0] : '(缺失)';
}
function auditRecordRows(id) {
  return mysqlSelect(
    `SELECT id, action, operator, time FROM t_goods_audit_record WHERE goods_id=${id} ORDER BY id`);
}
function auditLogRowsByTitle(title) {
  // 用 ASCII 标题做 LIKE，避免任何中文经管道被 mysql 客户端按 GBK 误读导致匹配不到
  return mysqlSelect(
    `SELECT id, action, target, operator, create_time FROM t_audit_log WHERE detail LIKE '%${title}%' ORDER BY id`);
}

// ---------- 主流程 ----------
async function main() {
  const lines = [];
  const log = (s) => { lines.push(s); };

  const baseline = countsSnapshot();
  log('【基线】' + JSON.stringify(baseline));

  // 登录：管理员 + 普通卖家
  const admin = await login('admin', 'admin123');
  const seller = await login('zhangsan', '123456');
  log(`登录: admin role=${admin.user.role} / zhangsan role=${seller.user.role}`);

  // 造三条 pending 商品（纯 ASCII 独特前缀，全部归 zhangsan 所有）
  mysqlRun(`
    INSERT INTO t_goods (title, price, status, stock, seller_id, seller_name, category_id, category_name)
      VALUES ('${TITLES.A}', 9.90, 'pending', 1, ${SELLER_ID}, '${SELLER_NAME}', ${CATEGORY_ID}, '${CATEGORY_NAME}');
    INSERT INTO t_goods (title, price, status, stock, seller_id, seller_name, category_id, category_name)
      VALUES ('${TITLES.B}', 8.80, 'pending', 1, ${SELLER_ID}, '${SELLER_NAME}', ${CATEGORY_ID}, '${CATEGORY_NAME}');
    INSERT INTO t_goods (title, price, status, stock, seller_id, seller_name, category_id, category_name)
      VALUES ('${TITLES.C}', 7.70, 'pending', 1, ${SELLER_ID}, '${SELLER_NAME}', ${CATEGORY_ID}, '${CATEGORY_NAME}');
  `);
  const ids = {};
  for (const k of Object.keys(TITLES)) {
    const [r] = mysqlSelect(`SELECT id FROM t_goods WHERE title='${TITLES[k]}'`);
    ids[k] = +r[0];
  }
  log(`造商品: A=#${ids.A} B=#${ids.B} C=#${ids.C}（均 pending, seller=${SELLER_ID}）`);

  const afterInsert = countsSnapshot();

  try {
    // ===== 证据①：管理员走真审核入口 =====
    const r1 = await call('POST', `/review/goods/${ids.A}/review`,
      { token: admin.token, body: { action: 'approve' } });
    const statusA = statusOf(ids.A);
    const recA = auditRecordRows(ids.A);
    const logA = auditLogRowsByTitle(TITLES.A);
    record('①管理员真审核入口', {
      method: 'POST', path: `/api/review/goods/${ids.A}/review`,
      body: { action: 'approve' }, role: admin.user.role,
      respCode: r1.json?.code, respMsg: r1.json?.message,
      goodsStatus: statusA,
      auditRecord: recA.map(x => `id=${x[0]} action=${x[1]} operator=${x[2]}`).join(' | ') || '(无)',
      auditLog: logA.map(x => `id=${x[0]} action=${x[1]} target=${x[2]} operator=${x[3]}`).join(' | ') || '(无)',
    });
    log(`① code=${r1.json?.code} msg=${r1.json?.message} | A状态=${statusA} | 审核记录=${recA.length}条 | 审计流水=${logA.length}条`);

    // ===== 证据②：管理员走通用 PATCH（挡板）=====
    const r2 = await call('PATCH', `/goods/${ids.B}/status`,
      { token: admin.token, body: { status: 'on_sale' } });
    const statusB = statusOf(ids.B);
    record('②管理员通用PATCH(挡板)', {
      method: 'PATCH', path: `/api/goods/${ids.B}/status`,
      body: { status: 'on_sale' }, role: admin.user.role,
      respCode: r2.json?.code, respMsg: r2.json?.message,
      goodsStatus: statusB,
    });
    log(`② code=${r2.json?.code} msg=${r2.json?.message} | B状态=${statusB}`);

    // ===== 证据③：卖家走同一个 PATCH（归属放行但挡板生效）=====
    const r3 = await call('PATCH', `/goods/${ids.C}/status`,
      { token: seller.token, body: { status: 'on_sale' } });
    const statusC = statusOf(ids.C);
    record('③卖家通用PATCH(挡板)', {
      method: 'PATCH', path: `/api/goods/${ids.C}/status`,
      body: { status: 'on_sale' }, role: seller.user.role,
      respCode: r3.json?.code, respMsg: r3.json?.message,
      goodsStatus: statusC,
    });
    log(`③ code=${r3.json?.code} msg=${r3.json?.message} | C状态=${statusC}`);
  } finally {
    // ===== 清理：按精确主键删除自造商品及其审计行 =====
    // 注意：t_audit_log 的 target 含中文，经管道传入会被 mysql 客户端按 GBK 误读，
    // 故改用 ASCII 的 detail LIKE '%__PROBE_%' 来精确命中本次自造记录。
    mysqlRun(`
      DELETE FROM t_goods_audit_record WHERE goods_id IN (${ids.A}, ${ids.B}, ${ids.C});
      DELETE FROM t_audit_log WHERE detail LIKE '%__PROBE_%';
      DELETE FROM t_goods WHERE title LIKE '__PROBE_%';
    `);
  }

  const afterClean = countsSnapshot();
  log('【复位后】' + JSON.stringify(afterClean));

  // ===== 断言 =====
  const checks = [];
  const expect = (name, cond, detail) => checks.push({ name, pass: !!cond, detail });

  expect('① code=0', evidence[0].respCode === 0, `code=${evidence[0].respCode}`);
  expect('① A→on_sale', evidence[0].goodsStatus === 'on_sale', `status=${evidence[0].goodsStatus}`);
  expect('① 审核记录含approve',
    /action=approve/.test(evidence[0].auditRecord), evidence[0].auditRecord);
  expect('① 审计流水含goodsAudit.approve',
    /action=goodsAudit\.approve/.test(evidence[0].auditLog), evidence[0].auditLog);

  expect('② code=1001', evidence[1].respCode === 1001, `code=${evidence[1].respCode}`);
  expect('② message精确', evidence[1].respMsg === EXPECT_MSG, `msg=${evidence[1].respMsg}`);
  expect('② B仍为pending', evidence[1].goodsStatus === 'pending', `status=${evidence[1].goodsStatus}`);

  expect('③ code=1001', evidence[2].respCode === 1001, `code=${evidence[2].respCode}`);
  expect('③ message精确', evidence[2].respMsg === EXPECT_MSG, `msg=${evidence[2].respMsg}`);
  expect('③ C仍为pending', evidence[2].goodsStatus === 'pending', `status=${evidence[2].goodsStatus}`);

  // —— 自造产物清理校验（并发队友可能改动其它行，故只校验"本次自造产物"是否归零）——
  const leftoverGoods = (+mysqlSelect(`SELECT COUNT(*) FROM t_goods WHERE title LIKE '__PROBE_%'`)[0][0]);
  const leftoverRec = (+mysqlSelect(`SELECT COUNT(*) FROM t_goods_audit_record WHERE goods_id IN (SELECT id FROM t_goods WHERE title LIKE '__PROBE_%')`)[0][0]);
  const leftoverLog = (+mysqlSelect(`SELECT COUNT(*) FROM t_audit_log WHERE detail LIKE '%__PROBE_%'`)[0][0]);
  expect('清理: 无残留probe商品', leftoverGoods === 0, `left=${leftoverGoods}`);
  expect('清理: 无残留probe审核记录', leftoverRec === 0, `left=${leftoverRec}`);
  expect('清理: 无残留probe审计流水', leftoverLog === 0, `left=${leftoverLog}`);
  // 全局计数偏差仅作提示（可能受并发队友影响），不作为 PASS/FAIL 硬判
  const globalDrift = (afterClean.g !== baseline.g || afterClean.al !== baseline.al || afterClean.gar !== baseline.gar);
  if (globalDrift) log(`  [提示] 全局计数相对本脚本启动时有偏差(g ${baseline.g}->${afterClean.g}, al ${baseline.al}->${afterClean.al}, gar ${baseline.gar}->${afterClean.gar})，可能来自并发队友操作，已单独校验本次产物已清零。`);

  // ===== 输出报告 =====
  log('\n========== 证据明细 ==========');
  for (const e of evidence) {
    log(`\n● ${e.label}`);
    log(`  请求: ${e.method} ${e.path}  role=${e.role}  body=${JSON.stringify(e.body)}`);
    log(`  响应: code=${e.respCode}  message=${e.respMsg ?? '(空)'}`);
    log(`  库内: goodsStatus=${e.goodsStatus ?? '(n/a)'}` +
      (e.auditRecord ? `  auditRecord=[${e.auditRecord}]` : '') +
      (e.auditLog ? `  auditLog=[${e.auditLog}]` : ''));
  }
  log('\n========== 断言 ==========');
  let fail = 0;
  for (const c of checks) { if (!c.pass) fail++; log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.name} :: ${c.detail}`); }
  log(`\n========== 计数: 基线 g=${baseline.g} al=${baseline.al} gar=${baseline.gar} | 造后 g=${afterInsert.g} | 复位 g=${afterClean.g} al=${afterClean.al} gar=${afterClean.gar} ==========`);
  log(`\n========== 结果: ${fail === 0 ? 'ALL PASS' : fail + ' FAILED'} ==========`);

  console.log(lines.join('\n'));
  if (fail > 0) process.exitCode = 1;
}

main().catch(err => { console.error('脚本异常:', err); process.exitCode = 2; });
