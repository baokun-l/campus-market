/**
 * 真机探针：支付链路端到端（第三层验证）。
 *
 * 前两层已经证明过的东西，在这里都不再重复断言：
 *   · 单测层 —— 金额校验、幂等、app_id 比对（含红绿探针）
 *   · 前端层 —— vue-tsc 0 错 + 707 用例通过
 * 真机层要证明的是**那些只有跑起来才能暴露的问题**：
 *   ① 渠道 Bean 真的被注册了（单测里是 new 出来的，绕过了注册链路）
 *   ② 回调白名单真的生效（匿名可 POST、GET 仍要登录）
 *   ③ 钱包真的扣了钱、退款真的把钱退回去了（账实相符）
 *   ④ 回调返回的是纯文本 success / failure，不是 JSON
 *
 * 用法：node .workbuddy/e2e-pay.mjs   （需后端已在 8080 运行）
 * 退出码：0 全通过；2 有断言失败
 */
import { readFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:8080/api';

let pass = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(`${name} ${detail}`);
    console.log(`  FAIL  ${name}  ${detail}`);
  }
}

/** 本项目错误一律 HTTP 200 + body 码，所以"不可达"要看响应体，不能看状态码 */
async function call(method, path, { token, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : (form ?? undefined)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 纯文本响应（回调接口） */ }
  return { status: res.status, text, json };
}

async function login(username, password) {
  const r = await call('POST', '/user/login', { body: { username, password } });
  if (r.json?.code !== 0) throw new Error(`登录失败 ${username}: ${JSON.stringify(r.json)}`);
  return r.json.data.token;
}

async function main() {
  console.log('=== 真机探针：支付链路 ===\n');

  const buyer = await login('zhangsan', '123456');
  const admin = await login('admin', 'admin123');
  ok('① 买家与管理员可登录', true);

  /* ---------- ① 渠道注册（单测绕过了注册链路，必须真机验证） ---------- */
  const ch = await call('GET', '/pay/channels', { token: buyer });
  const codes = (ch.json?.data ?? []).map((c) => c.code);
  ok('② 收银台返回渠道列表', ch.json?.code === 0 && codes.length > 0, JSON.stringify(codes));
  ok('③ 钱包渠道在列（说明 WalletPayChannel Bean 被注册了）', codes.includes('wallet'), JSON.stringify(codes));
  ok('④ 演示渠道在列（默认 profile 下可用）', codes.includes('demo'), JSON.stringify(codes));
  ok('⑤ 支付宝沙箱不在列（没配密钥，沉默消失而不是报错）', !codes.includes('alipay_sandbox'), JSON.stringify(codes));

  const walletOpt = (ch.json?.data ?? []).find((c) => c.code === 'wallet');
  ok('⑥ 钱包渠道带余额', walletOpt && walletOpt.balance != null, JSON.stringify(walletOpt));

  /* ---------- ② 找一件别人的在售商品，下单 ---------- */
  const goods = await call('GET', '/goods?pageSize=50', { token: buyer });
  const mine = await call('GET', '/user/profile', { token: buyer });
  const myId = mine.json?.data?.id;
  const pick = (goods.json?.data?.list ?? []).find(
    (g) => g.status === 'on_sale' && g.stock > 0 && g.sellerId !== myId);
  ok('⑦ 找到一件别人的在售商品', Boolean(pick), pick ? '' : '没有可下单的商品，后续用例将跳过');
  if (!pick) { report(); return; }

  const before = Number(walletOpt.balance);
  const created = await call('POST', '/orders', {
    token: buyer,
    body: { goodsId: pick.id, quantity: 1, address: '探针测试地址' }
  });
  const orderId = created.json?.data?.id;
  ok('⑧ 下单成功且带支付截止时间', created.json?.code === 0 && Boolean(orderId) && Boolean(created.json?.data?.payExpireAt),
    JSON.stringify(created.json?.data ?? {}).slice(0, 200));
  if (!orderId) { report(); return; }

  /* ---------- ③ 发起支付（钱包） ---------- */
  const launch = await call('POST', `/orders/${orderId}/pay`, { token: buyer, body: { channel: 'wallet' } });
  const L = launch.json?.data ?? {};
  ok('⑨ 钱包支付返回 DONE', launch.json?.code === 0 && L.kind === 'DONE', JSON.stringify(L).slice(0, 240));
  ok('⑩ 金额取自订单快照（与商品价一致）', L.amount === created.json?.data?.amount,
    `launch=${L.amount} order=${created.json?.data?.amount}`);

  const after = await call('GET', `/orders/${orderId}/pay/status`, { token: buyer });
  ok('⑪ 轮询接口显示已付款', after.json?.code === 0 && after.json?.data?.paid === true, JSON.stringify(after.json?.data ?? {}));

  /* ---------- ④ 账实相符：余额真的少了 ---------- */
  const ch2 = await call('GET', '/pay/channels', { token: buyer });
  const after2 = Number((ch2.json?.data ?? []).find((c) => c.code === 'wallet')?.balance);
  const delta = Number((before - after2).toFixed(2));
  ok('⑫ 钱包余额真的被扣了（账实相符）', Math.abs(delta - Number(L.amount)) < 0.005,
    `扣了 ${delta}，应付 ${L.amount}`);

  /* ---------- ⑤ 重复支付必须被拒 ---------- */
  const again = await call('POST', `/orders/${orderId}/pay`, { token: buyer, body: { channel: 'wallet' } });
  ok('⑬ 已付款的订单不能再次发起支付', again.json?.code === 1001, JSON.stringify(again.json));

  /* ---------- ⑥ 回调端点：白名单与协议 ---------- */
  const anon = await call('GET', '/pay/channels', {});
  ok('⑭ 匿名访问收银台 → 401（body 码，不是 HTTP 码）',
    anon.status === 200 && anon.json?.code === 401, `status=${anon.status} body=${anon.text.slice(0, 80)}`);

  /*
   * ★ 这条断言的口径要小心 ★
   * GET /pay/notify/** 会被 Spring 的 HandlerMapping 在**拦截器之前**就拒掉
   * （没有匹配 GET 的处理器方法 → HttpRequestMethodNotSupportedException → 兜底成 1001），
   * 所以拿到的不是「401 未登录」而是「1001 不支持的方法」。
   * 两者都是"没进回调逻辑"，但写死 401 会变成一条**永远错误地失败**的断言 ——
   * 那比没有断言更糟：真出问题时会误以为是被拦住了。
   * 真正"白名单只放行 POST"的精确断言在单测 AuthInterceptorPublicPathTest 里。
   */
  const getNotify = await call('GET', '/pay/notify/alipay_sandbox', {});
  const getRejected = getNotify.json?.code === 401 || getNotify.json?.code === 1001;
  ok('⑮ GET 回调不会进入回调逻辑（401 未登录 / 1001 方法不支持都对，纯文本 success/failure 才叫漏）',
    getRejected && getNotify.text.trim() !== 'success' && getNotify.text.trim() !== 'failure',
    `body=${getNotify.text.slice(0, 90)}`);

  const syncNotify = await call('POST', '/pay/notify/wallet', { form: 'out_trade_no=x&total_amount=1.00' });
  ok('⑯ 同步渠道被伪造成回调 → 纯文本 failure（这类渠道没有验签，放行等于不设防）',
    syncNotify.text.trim() === 'failure', `body=${syncNotify.text.slice(0, 80)}`);

  const badSign = await call('POST', '/pay/notify/alipay_sandbox', {
    form: 'out_trade_no=pay_x&total_amount=0.01&trade_status=TRADE_SUCCESS&sign=zzz'
  });
  ok('⑰ 验签不过的支付宝回调 → failure（返回的是纯文本，不是 Result JSON）',
    badSign.text.trim() === 'failure', `body=${badSign.text.slice(0, 80)}`);

  /* ---------- ⑦ 退款：钱必须真的退回去 ---------- */
  const apply = await call('POST', `/orders/${orderId}/refund/apply`, { token: buyer, body: { reason: '七天无理由' } });
  ok('⑱ 买家可申请退款', apply.json?.code === 0, JSON.stringify(apply.json));

  const refund = await call('POST', `/admin/orders/${orderId}/refund`, {
    token: admin,
    body: { amount: L.amount, reason: '同意退款', remark: '探针验证原路退回' }
  });
  ok('⑲ 管理员同意退款成功', refund.json?.code === 0, JSON.stringify(refund.json));

  const ch3 = await call('GET', '/pay/channels', { token: buyer });
  const after3 = Number((ch3.json?.data ?? []).find((c) => c.code === 'wallet')?.balance);
  ok('⑳ 退款后余额回到原值（原路退回真的动了钱）', Math.abs(after3 - before) < 0.005,
    `退款后 ${after3}，原本 ${before}`);

  /* ---------- ⑧ 付款时不传渠道：后端自己选第一条 ---------- */
  const g2 = (goods.json?.data?.list ?? []).filter((g) => g.status === 'on_sale' && g.stock > 0 && g.sellerId !== myId);
  if (g2.length > 0) {
    const c2 = await call('POST', '/orders', { token: buyer, body: { goodsId: g2[0].id, quantity: 1 } });
    const id2 = c2.json?.data?.id;
    const p2 = await call('POST', `/orders/${id2}/pay`, { token: buyer, body: {} });
    ok('㉑ 不带 channel 也能支付（后端选第一条可用渠道，老版本前端不会一升级就付不了款）',
      p2.json?.code === 0 && p2.json?.data?.kind === 'DONE', JSON.stringify(p2.json?.data ?? {}).slice(0, 160));
  }

  report();
}

function report() {
  console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'} 通过 ${pass} 项，失败 ${failures.length} 项`);
  if (failures.length) {
    for (const f of failures) console.log('  × ' + f);
  }
  process.exit(failures.length === 0 ? 0 : 2);
}

main().catch((e) => {
  console.error('探针异常：', e.message);
  process.exit(2);
});
