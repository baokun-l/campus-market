/**
 * 端到端取证：「买家申请退款」闭环（H1）—— 全程真实 HTTP + 真实 MySQL
 * ----------------------------------------------------------------------------
 * 背景：状态机里 `pending_ship / shipped / received → refunding` 三条边一直都在，
 * 管理端的「同意退款 / 驳回退款」也早就实现，但**买家一侧从来没有入口** ——
 * 全代码没有任何一处能把订单置成 refunding（只有种子数据和前端 Mock 手工写过）。
 * 买家付完款发现货不对版时，取消只对未付款开放、申请又没入口，只能线下找管理员。
 *
 * 本探针证明五件事（不做源码推断）：
 *  【A】申请把订单推进到 refunding，且**不写 refund_time**（那是完成时间，
 *        前端拿它统计已退金额，申请即写入会把审核中的售后算成已退的钱）
 *  【B】响应里的 `refund.time` 是**申请时间**：它等于「买家申请退款」那条日志的时间，
 *        而"完成时间" refundTime 此时还没落库 —— 旧实现（time 直接取 refundTime）
 *        会整个键都不出现，这是新旧实现的判别式
 *  【C】驳回必须把 refund_* 五列**真的清成 NULL**：MyBatis-Plus 的 updateById 默认
 *        NOT_NULL 策略会跳过 null 字段，靠它清空等于没清，库里会残留一张
 *        「已驳回却还挂着退款单」的记录，响应里 refund 键也依然存在
 *  【D】审批通过时**保留买家的申请原因与发起方**（申请理由是证据，不能被审批人改写），
 *        金额才允许改小（部分退款）；且不再补「平台发起退款」日志（否则申请出现两次）
 *  【E】越权与重复申请都被挡：别人拿别人的单号申请不了；已申请的单子再申请给出
 *        「等待平台处理」而不是含糊的「不支持」
 *
 * 数据安全：探针**自己下一笔单**（不碰演示基线里的任何一笔），
 * 结束（含异常）按**精确主键**删除该单 + 它的日志 + 探针产生的审计日志，
 * 并把商品库存/状态还原到快照；最后复核全表计数与快照一致。
 *
 * 运行前置：后端已在 http://127.0.0.1:8080 启动（须用含本轮改动的正本 jar）。
 * 用法：node .workbuddy/e2e-refund-apply.mjs
 */
import { execFileSync } from 'node:child_process';

const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8080/api';
const MYSQL = process.env.MYSQL_BIN || 'D:/Program Files/MySQL/MySQL Server 8.0/bin/mysql.exe';
const DB = { host: '127.0.0.1', user: 'root', pass: '123456', name: 'campus_market' };

// 本机设了系统代理，Node fetch 必须显式清空，否则本地请求 502
for (const k of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy']) process.env[k] = '';

const REASON = '探针：商品存在质量问题';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- MySQL 助手 ---------------- */
function mysql(sql) {
  return execFileSync(
    MYSQL,
    ['-h' + DB.host, '-u' + DB.user, '-p' + DB.pass, '--default-character-set=utf8mb4', DB.name],
    { input: sql + '\n', encoding: 'utf8' }
  );
}
function rows(sql) {
  const out = mysql(sql).replace(/\r/g, '').trimEnd().split('\n');
  return out.slice(1).filter((l) => l.length).map((l) => l.split('\t'));
}
function scalar(sql) {
  const r = rows(sql);
  if (!r.length || !r[0].length) return null;
  return r[0][0] === 'NULL' ? null : r[0][0];
}
const num = (x) => (x === null || x === undefined || x === 'NULL' ? null : Number(x));

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
  try { json = JSON.parse(text); } catch { /* 非 JSON 时留 null */ }
  // ★ 业务错误的文案在**顶层 message**，不在 data 里 ★（data 只有成功时才装载荷）
  return { http: res.status, code: json?.code, message: json?.message, data: json?.data, raw: text.slice(0, 200) };
}
async function login(username, password) {
  const r = await call('POST', '/user/login', { body: { username, password } });
  return r.data?.token ?? null;
}

/* ---------------- 断言 ---------------- */
let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  → ' + detail : ''}`); }
}
/** 取该单当前在库里的退款单五列（NULL 与「键不存在」在 API 层是同一件事） */
function refundRow(orderId) {
  const r = rows(`SELECT refund_amount, refund_reason, refund_by, refund_time FROM t_order WHERE id='${orderId}'`);
  const [amount, reason, by, time] = r[0] ?? [];
  return {
    amount: amount === 'NULL' ? null : amount,
    reason: reason === 'NULL' ? null : reason,
    by: by === 'NULL' ? null : by,
    time: time === 'NULL' ? null : time
  };
}
const apiOrder = async (token, orderId) => {
  const r = await call('GET', '/orders?page=1&pageSize=50', { token });
  return (r.data?.list ?? []).find((o) => o.id === orderId) ?? null;
};

(async () => {
  // ---------- 全表计数快照（用于证明探针没留下垃圾） ----------
  const counts = () =>
    ['t_user', 't_goods', 't_order', 't_order_log', 't_audit_log', 't_activity']
      .map((t) => num(scalar(`SELECT COUNT(*) FROM ${t}`)))
      .join('/');
  const countsBefore = counts();
  const auditMaxBefore = num(scalar('SELECT COALESCE(MAX(id),0) FROM t_audit_log'));
  console.log('【快照】表计数 u/g/o/ol/al/ac =', countsBefore, ' auditMax =', auditMaxBefore);

  let orderId = null;
  let goodsBefore = null;
  let zhangsan = null;

  try {
    // ================= 前置 =================
    console.log('\n=== 0. 前置：登录 + 自己下一笔单（不碰演示基线的任何一笔）===');
    zhangsan = await login('zhangsan', '123456');
    const lisi = await login('lisi', '123456');
    const admin = await login('admin', 'admin123');
    check('admin / zhangsan / lisi 登录成功', !!(admin && zhangsan && lisi),
      `admin=${!!admin} zhangsan=${!!zhangsan} lisi=${!!lisi}`);
    if (!admin || !zhangsan || !lisi) throw new Error('登录失败，后续步骤无法进行');

    // 找一件「在售、有货、不是自己发布的」商品（不能买自己的东西）
    const g = rows("SELECT id, stock, status FROM t_goods WHERE status='on_sale' AND COALESCE(stock,0)>=2 AND seller_id<>4 ORDER BY id LIMIT 1")[0];
    if (!g) throw new Error('找不到可下单的商品');
    const goodsId = Number(g[0]);
    goodsBefore = { id: goodsId, stock: num(g[1]), status: g[2], maxGoodsId: num(scalar('SELECT MAX(id) FROM t_goods')) };

    const created = await call('POST', '/orders', {
      token: zhangsan, body: { goodsId, quantity: 1, remark: '退款闭环探针' }
    });
    orderId = created.data?.id;
    check('下单成功（pending_payment）', created.code === 0 && !!orderId, `code=${created.code} body=${created.raw}`);
    if (!orderId) throw new Error('下单失败，后续步骤无法进行');

    const paid = await call('POST', `/orders/${orderId}/pay`, { token: zhangsan });
    check('付款成功（pending_ship）', paid.code === 0 && scalar(`SELECT status FROM t_order WHERE id='${orderId}'`) === 'pending_ship',
      `code=${paid.code} status=${scalar(`SELECT status FROM t_order WHERE id='${orderId}'`)}`);
    const stockAfterOrder = num(scalar(`SELECT stock FROM t_goods WHERE id=${goodsId}`));

    // ================= A. 申请 =================
    console.log('\n=== A. 买家申请退款：进入 refunding，且**不写** refund_time ===');
    const apply = await call('POST', `/orders/${orderId}/refund/apply`, { token: zhangsan, body: { reason: REASON } });
    check('申请接口返回 code=0', apply.code === 0, `http=${apply.http} code=${apply.code} body=${apply.raw}`);

    const afterApply = refundRow(orderId);
    check("状态置为 refunding", scalar(`SELECT status FROM t_order WHERE id='${orderId}'`) === 'refunding',
      `实际 ${scalar(`SELECT status FROM t_order WHERE id='${orderId}'`)}`);
    check('refund_by = buyer（发起方，管理端据此显示「买家申请」）', afterApply.by === 'buyer', `实际 ${afterApply.by}`);
    check('refund_reason 落库为买家填写的原因', afterApply.reason === REASON, `实际 ${afterApply.reason}`);
    check('refund_amount = 订单实付（申请时先按全额挂上）',
      Math.abs(num(afterApply.amount) - num(scalar(`SELECT amount FROM t_order WHERE id='${orderId}'`))) < 0.001,
      `refund_amount=${afterApply.amount} amount=${scalar(`SELECT amount FROM t_order WHERE id='${orderId}'`)}`);
    check('★ refund_time 仍为 NULL（它是完成时间，申请阶段写入会把审核中的售后算成已退的钱）',
      afterApply.time === null, `实际 ${afterApply.time}`);
    check('申请不动库存（回补要等审批通过、交易真正作废）',
      num(scalar(`SELECT stock FROM t_goods WHERE id=${goodsId}`)) === stockAfterOrder,
      `下单后 ${stockAfterOrder} / 现在 ${scalar(`SELECT stock FROM t_goods WHERE id=${goodsId}`)}`);

    const applyLog = rows(`SELECT action, action_label, from_status, to_status, operator_role, note FROM t_order_log WHERE order_id='${orderId}' ORDER BY id DESC LIMIT 1`)[0];
    check('时间线记「买家申请退款」，方向 pending_ship → refunding',
      applyLog?.[0] === 'refund' && applyLog?.[1] === '买家申请退款'
      && applyLog?.[2] === 'pending_ship' && applyLog?.[3] === 'refunding',
      JSON.stringify(applyLog));
    check('日志操作人角色为 buyer，note 为申请原因', applyLog?.[4] === 'buyer' && applyLog?.[5] === REASON,
      JSON.stringify(applyLog));

    // ================= B. 响应契约：refund.time = 申请时间 =================
    console.log('\n=== B. 响应契约：refund.time 给的是「申请时间」而非完成时间 ===');
    const detail = await apiOrder(zhangsan, orderId);
    check('订单出现在买家列表里', !!detail);
    check('下单发的 refund 键存在（售后中的订单必须能显示出退款卡片）', !!detail?.refund,
      `refund=${JSON.stringify(detail?.refund)}`);
    check('refund.by = buyer', detail?.refund?.by === 'buyer', `实际 ${detail?.refund?.by}`);
    const applyLogInApi = (detail?.logs ?? []).find((l) => l.actionLabel === '买家申请退款');
    check('★ refund.time 恰好等于「买家申请退款」那条日志的时间',
      !!applyLogInApi && detail?.refund?.time === applyLogInApi.time,
      `refund.time=${detail?.refund?.time} log.time=${applyLogInApi?.time}`);
    check('同时 refundTime（完成时间）尚未下发 —— 两者语义不同，不能互相顶替',
      detail?.refundTime === undefined, `实际 ${detail?.refundTime}`);

    // ================= E. 重复申请 / 越权 =================
    console.log('\n=== E. 重复申请与越权都被挡 ===');
    const dup = await call('POST', `/orders/${orderId}/refund/apply`, { token: zhangsan, body: { reason: '再申请一次' } });
    check('重复申请被拒（1001），且说明是「等待平台处理」而不是含糊的「不支持」',
      dup.code === 1001 && String(dup.message ?? '').includes('等待平台处理'),
      `code=${dup.code} message=${dup.message}`);
    const dupRows = num(scalar(`SELECT COUNT(*) FROM t_order_log WHERE order_id='${orderId}'`));
    check('重复申请没有留下多余日志（先校验后写入，不产生半截状态）', dupRows === 3,
      `日志条数 ${dupRows}（下单 / 付款 / 申请 = 3）`);

    const cross = await call('POST', `/orders/${orderId}/refund/apply`, { token: lisi, body: { reason: '别人的单' } });
    check('非买家本人申请被拒（403 越权）', cross.code === 403, `code=${cross.code} body=${cross.raw}`);

    // ================= C. 驳回：refund_* 必须真的清成 NULL =================
    console.log('\n=== C. 驳回退款：refund_* 五列必须真的清成 NULL（updateById 会跳过 null）===');
    const reject = await call('POST', `/admin/orders/${orderId}/refund/reject`, { token: admin, body: { note: '探针：核实后驳回' } });
    check('驳回接口返回 code=0', reject.code === 0, `http=${reject.http} code=${reject.code} body=${reject.raw}`);

    const afterReject = refundRow(orderId);
    check('状态退回申请前的 pending_ship（不是写死 shipped）',
      scalar(`SELECT status FROM t_order WHERE id='${orderId}'`) === 'pending_ship',
      `实际 ${scalar(`SELECT status FROM t_order WHERE id='${orderId}'`)}`);
    check('★ refund_amount 已清空', afterReject.amount === null, `实际 ${afterReject.amount}`);
    check('★ refund_reason 已清空', afterReject.reason === null, `实际 ${afterReject.reason}`);
    check('★ refund_by 已清空', afterReject.by === null, `实际 ${afterReject.by}`);
    check('★ refund_time 已清空', afterReject.time === null, `实际 ${afterReject.time}`);
    const afterRejectApi = await apiOrder(zhangsan, orderId);
    check('★ 响应里的 refund 键整个消失（否则前端会一直显示一张不存在的退款单）',
      afterRejectApi?.refund === undefined, `refund=${JSON.stringify(afterRejectApi?.refund)}`);

    // ================= D. 再次申请 + 同意（部分退款） =================
    console.log('\n=== D. 再次申请并同意：保留买家原因与发起方，金额可改小 ===');
    const apply2 = await call('POST', `/orders/${orderId}/refund/apply`, { token: zhangsan, body: { reason: REASON } });
    check('可以重新申请（驳回后回到履约态，售后未结案）', apply2.code === 0, `code=${apply2.code} body=${apply2.raw}`);
    const payAmount = num(scalar(`SELECT amount FROM t_order WHERE id='${orderId}'`));
    const half = Number((payAmount / 2).toFixed(2));

    /*
     * ★ 必须在这里睡一秒以上 ★
     * 下面要断言「refund.time 是申请时间、不等于完成时间」。若申请与审批落在同一秒，
     * 两者字符串相等，断言就失去区分度（旧实现取完成时间也能过）。睡够一秒，
     * 让两次操作在日志里落在不同的秒上，这条断言才真的能分辨新旧实现。
     */
    await sleep(1300);

    const approve = await call('POST', `/admin/orders/${orderId}/refund`, {
      token: admin, body: { amount: half, reason: '其他（审批人改的原因）', remark: '探针：协商退一半' }
    });
    check('同意退款接口返回 code=0', approve.code === 0, `http=${approve.http} code=${approve.code} body=${approve.raw}`);

    const afterApprove = refundRow(orderId);
    check('状态置为 cancelled', scalar(`SELECT status FROM t_order WHERE id='${orderId}'`) === 'cancelled',
      `实际 ${scalar(`SELECT status FROM t_order WHERE id='${orderId}'`)}`);
    check('★ refund_reason 仍是买家填的原文（申请理由是证据，审批人不能改写）',
      afterApprove.reason === REASON, `实际 ${afterApprove.reason}`);
    check('★ refund_by 仍是 buyer', afterApprove.by === 'buyer', `实际 ${afterApprove.by}`);
    check('refund_amount 采用审批结论（部分退款 = 实付一半）',
      Math.abs(num(afterApprove.amount) - half) < 0.001, `期望 ${half} 实际 ${afterApprove.amount}`);
    check('refund_time 此时才落库（退款完成时间）', afterApprove.time !== null, `实际 ${afterApprove.time}`);

    const approvedApi = await apiOrder(zhangsan, orderId);
    const labels = (approvedApi?.logs ?? []).map((l) => l.actionLabel);
    check('日志只有一条「退款完成，订单关闭」，没有多余的「平台发起退款」',
      labels.filter((l) => l === '平台发起退款').length === 0 && labels.includes('退款完成，订单关闭'),
      JSON.stringify(labels));
    check('驳回后重新申请：时间线保留两次申请与一次驳回（历史不丢）',
      labels.filter((l) => l === '买家申请退款').length === 2 && labels.includes('驳回退款申请'),
      JSON.stringify(labels));
    // logs 是「最新在前」，所以第一条匹配到的就是本轮（第二次）申请
    const applyLogLatest = (approvedApi?.logs ?? []).find((l) => l.actionLabel === '买家申请退款');
    const doneLog = (approvedApi?.logs ?? []).find((l) => l.actionLabel === '退款完成，订单关闭');
    check('★ 响应里的 refund.time 是本轮**申请时间**，不是完成时间（旧实现直接取 refundTime）',
      approvedApi?.refund?.time === applyLogLatest?.time && approvedApi?.refund?.time !== doneLog?.time,
      `refund.time=${approvedApi?.refund?.time} 申请=${applyLogLatest?.time} 完成=${doneLog?.time}`);
    check('库存已回补到下单之前（交易作废，库存原样还回）',
      num(scalar(`SELECT stock FROM t_goods WHERE id=${goodsId}`)) === goodsBefore.stock,
      `下单前 ${goodsBefore.stock} / 现在 ${scalar(`SELECT stock FROM t_goods WHERE id=${goodsId}`)}`);
  } finally {
    // ================= 收尾：按精确主键清理 + 还原 =================
    console.log('\n=== 收尾：按精确主键删除探针订单，并还原商品快照 ===');
    if (orderId) {
      mysql(`DELETE FROM t_order_log WHERE order_id='${orderId}';`);
      mysql(`DELETE FROM t_order WHERE id='${orderId}';`);
      mysql(`DELETE FROM t_audit_log WHERE id > ${auditMaxBefore};`);
      console.log(`  已删除探针订单 ${orderId} 及其日志、审计日志`);
    }
    if (goodsBefore) {
      mysql(`UPDATE t_goods SET stock=${goodsBefore.stock === null ? 'NULL' : goodsBefore.stock}, ` +
        `status='${goodsBefore.status}' WHERE id=${goodsBefore.id};`);
    }
    console.log('\n=== 收尾复核（表计数必须与快照逐项一致）===');
    const countsAfter = counts();
    check('全表计数已还原（探针没有留下垃圾数据）', countsAfter === countsBefore,
      `快照 ${countsBefore} / 实际 ${countsAfter}`);
    check('t_order 无残留（按精确单号删，未用 LIKE 批量删）',
      orderId ? num(scalar(`SELECT COUNT(*) FROM t_order WHERE id='${orderId}'`)) === 0 : true);
    check('t_order_log 无残留',
      orderId ? num(scalar(`SELECT COUNT(*) FROM t_order_log WHERE order_id='${orderId}'`)) === 0 : true);
  }

  console.log(`\n===== 结果：${pass} PASS / ${fail} FAIL =====`);
  process.exit(fail === 0 ? 0 : 1);
})();
