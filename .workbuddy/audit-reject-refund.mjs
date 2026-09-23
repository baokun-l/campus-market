// 探针：驳回退款后订单状态被硬编码成 shipped ？
// 目标订单 20260916091000008（种子数据中为 pending_ship，卖家从未发货）
const BASE = 'http://localhost:8080/api';
const ORDER = '20260916091000008';

async function call(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { http: res.status, code: json?.code, message: json?.message, data: json?.data };
}

async function statusOf(token) {
  const r = await call('GET', '/admin/orders?page=1&pageSize=200', { token });
  const list = r.data?.list ?? r.data?.records ?? [];
  const o = list.find((x) => x.id === ORDER);
  return o ? { status: o.status, shipTime: o.shipTime ?? null } : { status: '(未找到)', shipTime: null };
}

const login = await call('POST', '/user/login', { body: { username: 'admin', password: 'admin123' } });
const token = login.data?.token;
if (!token) { console.error('登录失败'); process.exit(2); }

const steps = [];
const push = (label, val) => { steps.push({ label, val }); console.log(label + ' :: ' + val); };

push('① 初始状态', JSON.stringify(await statusOf(token)));

const r1 = await call('PATCH', `/admin/orders/${ORDER}/status`, {
  token, body: { status: 'refunding', reason: '探针：模拟买家申请退款' },
});
push('② 置为 refunding', `code=${r1.code} msg=${r1.message ?? ''}`);
push('③ 此时状态', JSON.stringify(await statusOf(token)));

const r2 = await call('POST', `/admin/orders/${ORDER}/refund/reject`, {
  token, body: { note: '探针：驳回退款' },
});
push('④ 驳回退款', `code=${r2.code} msg=${r2.message ?? ''}`);

const after = await statusOf(token);
push('⑤ 驳回后状态', JSON.stringify(after));

const bug = after.status === 'shipped';
console.log('');
console.log(bug
  ? '>>> 缺陷确认：驳回退款后订单从「待发货 / 已收货」被硬编码成「已发货」，卖家事实上从未发货'
  : '>>> 未复现：驳回后状态为 ' + after.status);
process.exit(0);
