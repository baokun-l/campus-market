/**
 * D-ALIPAY 收官：对账结算后的**接口层**复验（真机）。
 *
 * 为什么要走接口而不是只看库：
 *   库里 status 变了只能证明「有 UPDATE 执行了」，证明不了**读路径**也一致 ——
 *   而用户真正看到的是接口。收银台轮询走的正是 GET /orders/{id}/pay/status。
 *
 * 四组判据（含两组对照，避免「只看一笔成了就宣布成功」）：
 *   ① 被结算的那笔：paid=true / orderStatus=pending_ship / paymentStatus=success
 *   ② 对照组×2（真机从未付款）：paid=false / orderStatus=pending_payment / paymentStatus=paying
 *      —— 这两笔必须**一个字都没变**，否则说明对账把「问不到」当成了「没成」或反过来误判
 *   ③ 非归属人视角：换 lisi 的 token 查 zhangsan 的订单 —— 必须查不到（可见性口径）
 */
const BASE = 'http://127.0.0.1:8080/api';

// ★ 登录路径是 /user/login（UserController），**不是** /auth/login ★
//   AuthInterceptor 的 PUBLIC_ANY 白名单里写的是 "/user/login"。
//   打错路径的后果特别隐蔽：白名单不命中 ⇒ 被拦截器拒 ⇒ 返回
//   {"code":401,"message":"未登录"} —— 看起来像「密码错了」，其实是路径错了。
async function login(username) {
  const res = await fetch(BASE + '/user/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: '123456' }),
  });
  const j = await res.json();
  return { http: res.status, code: j?.code, token: j?.data?.token, raw: j };
}

async function payStatus(orderId, token) {
  const res = await fetch(`${BASE}/orders/${orderId}/pay/status`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* 非 JSON */ }
  return { http: res.status, json: j, text: text.slice(0, 160) };
}

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}  →  ${detail}`); }
}

/* ---------- 登录 ---------- */
const zs = await login('zhangsan');
console.log(`登录 zhangsan : http=${zs.http} code=${zs.code} token=${zs.token ? zs.token.length + ' chars' : 'MISSING'}`);
if (!zs.token) { console.log('RED: 拿不到 token，后续无从验证'); process.exit(2); }
const ls = await login('lisi');
console.log(`登录 lisi     : http=${ls.http} code=${ls.code} token=${ls.token ? ls.token.length + ' chars' : 'MISSING'}`);

/* ---------- ① 被结算的那笔 ---------- */
const TARGET = '20260923233755355000';
const r1 = await payStatus(TARGET, zs.token);
console.log(`\n① 目标单 ${TARGET} 的支付状态：`);
console.log('   ' + JSON.stringify(r1.json?.data));
const d1 = r1.json?.data ?? {};
check('paid=true（真钱到了 ⇒ 必须判为已付）', d1.paid === true, `paid=${JSON.stringify(d1.paid)}`);
check('orderStatus=pending_ship（订单被真正推进）', d1.orderStatus === 'pending_ship', `orderStatus=${JSON.stringify(d1.orderStatus)}`);
check('paymentStatus=success（支付单已结算）', d1.paymentStatus === 'success', `paymentStatus=${JSON.stringify(d1.paymentStatus)}`);
check('channel=alipay_sandbox', d1.channel === 'alipay_sandbox', `channel=${JSON.stringify(d1.channel)}`);
check('payChannel=alipay_sandbox（订单侧回填）', d1.payChannel === 'alipay_sandbox', `payChannel=${JSON.stringify(d1.payChannel)}`);
// ★ 这里锚「数值相等」而不是字面量 "12.00" ★
//   第一版写成 String(d1.amount) === '12.00' 报了假红：Payment.amount 是 BigDecimal，
//   Jackson 默认把 12.00 序列化成 12（去掉尾零），线上本来就是数字不是字符串。
//   金额的精度由 DECIMAL(10,2) 列保证，不是由 JSON 字面量保证 —— 断言该锚语义而非字样。
check('amount 数值等于 12（应付金额 12.00）', Number(d1.amount) === 12, `amount=${JSON.stringify(d1.amount)}`);
check('payTime 非空', d1.payTime != null, `payTime=${JSON.stringify(d1.payTime)}`);

/* ---------- ② 对照组：真机从未付款的两笔，必须原样不动 ---------- */
const CONTROLS = ['20260923232541801000', '20260923230310573000'];
for (const [i, oid] of CONTROLS.entries()) {
  const r = await payStatus(oid, zs.token);
  const d = r.json?.data ?? {};
  console.log(`\n② 对照组${i + 1} ${oid} 的支付状态：`);
  console.log('   ' + JSON.stringify(r.json?.data));
  check(`paid=false（从未付款 ⇒ 不许被结算）`, d.paid === false, `paid=${JSON.stringify(d.paid)}`);
  check(`orderStatus=pending_payment（订单不许被推进）`, d.orderStatus === 'pending_payment', `orderStatus=${JSON.stringify(d.orderStatus)}`);
  check(`paymentStatus=paying（支付单必须原地不动）`, d.paymentStatus === 'paying', `paymentStatus=${JSON.stringify(d.paymentStatus)}`);
}

/* ---------- ③ 非归属人视角 ---------- */
// ★ 断言口径的更正（第一版据「可见性 404」写成 404/1001，实测报红）★
//   实测返回 code=403「只有买家本人可以操作该订单」，且这是**刻意的**：
//   OrderService#requireBuyer 的注释写明它是越权防线，全文案覆盖整个订单域。
//   项目里两处口径不同、且各自有理：
//     · 商品/资源「可见性」→ 404（不暴露存在性）；
//     · 订单「归属」→ 403 + 明确文案（告诉调用者「这单存在，但不是你的」）。
//   后者确实泄露了「该订单号存在」这一点信息。本轮不动它 ——
//   它与支付链路无关，改它属于另一件事，记进缺陷清单当**观察项**而不是顺手改掉。
if (ls.token) {
  const r3 = await payStatus(TARGET, ls.token);
  console.log(`\n③ 非归属人（lisi）查 zhangsan 的订单：http=${r3.http} code=${r3.json?.code} message=${JSON.stringify(r3.json?.message)}`);
  check('非归属人被拒（订单域口径：403 + 明确文案）', r3.json?.code === 403,
    `code=${JSON.stringify(r3.json?.code)} body=${r3.text}`);
  check('非归属人拿不到任何订单数据（金额/渠道/流水号都不许漏）', r3.json?.data == null,
    `data=${JSON.stringify(r3.json?.data)}`);
}

console.log(`\n=== 接口层复验：${pass} PASS / ${fail} FAIL ===`);
process.exit(fail === 0 ? 0 : 1);
