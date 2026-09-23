/**
 * 真机红绿：证明 `app.pay.enabled-channels` 真的被消费（不是"能改能存、没人读"的死配置）。
 *
 * 前置：后端已用 `--app.pay.enabled-channels=wallet` 启动（本脚本不负责启停）。
 * 预期：
 *   · 收银台只剩 wallet（demo 消失）
 *   · 显式用 demo 渠道支付 → 1001 被拒（而不是"建了一张单但永远没结果"）
 */
const BASE = 'http://127.0.0.1:8080/api';

async function call(method, path, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { text, json };
}

const login = await call('POST', '/user/login', { body: { username: 'zhangsan', password: '123456' } });
const token = login.json.data.token;

const ch = await call('GET', '/pay/channels', { token });
const codes = (ch.json?.data ?? []).map((c) => c.code);

const checks = [
  ['demo 渠道已从收银台消失', !codes.includes('demo')],
  ['wallet 渠道仍在', codes.includes('wallet')]
];

// 显式请求已被关闭的渠道 → 必须 1001 被拒
const goods = await call('GET', '/goods?pageSize=50', { token });
const mine = await call('GET', '/user/profile', { token });
const myId = mine.json?.data?.id;
const pick = (goods.json?.data?.list ?? []).find((g) => g.status === 'on_sale' && g.stock > 0 && g.sellerId !== myId);
if (pick) {
  const o = await call('POST', '/orders', { token, body: { goodsId: pick.id, quantity: 1 } });
  const id = o.json?.data?.id;
  const p = await call('POST', `/orders/${id}/pay`, { token, body: { channel: 'demo' } });
  checks.push([`被关闭的 demo 渠道 → 1001 拒绝（实际 code=${p.json?.code}）`, p.json?.code === 1001]);
}

let bad = 0;
for (const [name, cond] of checks) {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}`);
  if (!cond) bad++;
}
console.log(bad === 0 ? `\nPASS 配置真的生效（channels=${JSON.stringify(codes)}）` : `\nFAIL ${bad} 项`);
process.exit(bad === 0 ? 0 : 2);
