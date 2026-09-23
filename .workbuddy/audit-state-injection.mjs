// 探针：① 商品状态可注入幽灵值 ② pageSize 回显与实际生效值不一致 ③ 审核角色越权读订单日志
const BASE = 'http://localhost:8080/api';
const GOODS = 1;            // zhangsan(4) 自持、on_sale
const ORDER = '20260820140000009';

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

const tok = async (u, p) => (await call('POST', '/user/login', { body: { username: u, password: p } })).data?.token;
const zhangsan = await tok('zhangsan', '123456');
const goodsAdmin = await tok('goods_admin', 'goods123456');
const admin = await tok('admin', 'admin123');
if (!zhangsan || !goodsAdmin || !admin) { console.error('登录失败'); process.exit(2); }

const goodsStatus = async (t) => {
  const r = await call('GET', `/goods/${GOODS}`, { token: t });
  return r.data?.status;
};

console.log('════ ① 商品状态白名单（清单 M3 标注为"已修复"）════');
const before = await goodsStatus(zhangsan);
console.log(`   注入前状态: ${before}`);
const inj = await call('PATCH', `/goods/${GOODS}/status`, { token: zhangsan, body: { status: 'teleport' } });
console.log(`   PATCH status=teleport → code=${inj.code} msg=${inj.message ?? ''}`);
const after = await goodsStatus(zhangsan);
console.log(`   注入后状态: ${after}`);
const c3 = after === 'teleport';
console.log(c3 ? '   >>> 缺陷确认：幽灵状态 teleport 被直接写入数据库（无白名单）' : '   >>> 已拦截');

const inj2 = await call('PATCH', `/goods/${GOODS}/status`, { token: zhangsan, body: { status: 'on_sale' } });
const restored = await goodsStatus(zhangsan);
console.log(`   还原: code=${inj2.code} → 当前 ${restored}` + (restored === 'on_sale' ? '  ✓已还原' : '  ✗还原失败！'));

console.log('');
console.log('════ ② 分页 pageSize：响应回显 vs 实际生效 ════');
const pg = await call('GET', '/goods?page=1&pageSize=100000', { token: zhangsan });
console.log(`   GET /goods?pageSize=100000 → 回显 pageSize=${pg.data?.pageSize}, 实际返回 ${pg.data?.list?.length} 条`);
const c2 = pg.data?.pageSize === 100000;
console.log(c2 ? '   >>> 不一致：回显 100000 而实际被 MP 钳到 500 —— 前端按 100000 算总页数会翻页错位' : '   >>> 一致');

console.log('');
console.log('════ ③ 审核角色读任意订单日志（越权）════');
const lg = await call('GET', `/orders/${ORDER}/logs`, { token: goodsAdmin });
const c1 = lg.code === 0 && Array.isArray(lg.data) && lg.data.length > 0;
console.log(`   goods_admin 读订单 ${ORDER} 的日志 → code=${lg.code}, 返回 ${Array.isArray(lg.data) ? lg.data.length : 'n/a'} 条`);
if (c1) console.log(`   首条: action=${lg.data[0].action} to=${lg.data[0].toStatus} note=${String(lg.data[0].note ?? '').slice(0, 30)}`);
console.log(c1 ? '   >>> 确认：审核角色（非该单买卖双方）可读到含运单号/内部备注的完整操作日志' : '   >>> 已拦截');

console.log('');
console.log(`结论：① ${c3 ? '缺陷' : 'OK'}　② ${c2 ? '缺陷' : 'OK'}　③ ${c1 ? '越权' : 'OK'}`);
process.exit(0);
