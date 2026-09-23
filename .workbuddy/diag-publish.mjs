// 发布商品 500 复现探针：用不同输入探明哪一类会触发未捕获异常
// 用法：node diag-publish.mjs  （后端跑在 8080）
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8080/api';

async function post(path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON */ }
  return { http: res.status, code: json?.code, message: json?.message, data: json?.data };
}

const login = await post('/user/login', { username: 'zhangsan', password: '123456' });
const token = login.data?.token;
console.log(`登录 zhangsan: code=${login.code} role=${login.data?.user?.role ?? login.data?.role} token=${token ? 'ok' : 'NONE'}`);
if (!token) process.exit(1);

const longTitle = '测'.repeat(260);

const cases = [
  ['A 正常数据', { title: '诊断用测试商品-正常', price: 12.5, stock: 1, categoryId: 1, categoryName: '教材', description: '探针', cover: '/goods/cat1-1.jpg', images: ['/goods/cat1-1.jpg'], location: '校园内', deliveryMethod: 'face' }],
  ['B title 缺失/空', { price: 12.5, stock: 1, categoryId: 1 }],
  ['C title 超长(260)', { title: longTitle, price: 12.5, stock: 1, categoryId: 1 }],
  ['D price 缺失', { title: '诊断用测试商品-price空', stock: 1, categoryId: 1 }],
  ['E price=0', { title: '诊断用测试商品-price0', price: 0, stock: 1, categoryId: 1 }],
  ['F price=-5', { title: '诊断用测试商品-price负', price: -5, stock: 1, categoryId: 1 }],
  ['G stock 缺失', { title: '诊断用测试商品-stock空', price: 12.5, categoryId: 1 }],
  ['H categoryId 缺失', { title: '诊断用测试商品-无分类', price: 12.5, stock: 1 }],
  ['I 含活动报名(不存在的活动)', { title: '诊断用测试商品-活动', price: 100, stock: 1, categoryId: 1, activityId: 'not-exist-activity' }],
  ['J images 传字符串', { title: '诊断用测试商品-图片串', price: 12.5, stock: 1, categoryId: 1, images: '/goods/cat1-1.jpg' }],
  ['K location 超长(260)', { title: '诊断用测试商品-地点长', price: 12.5, stock: 1, categoryId: 1, location: '地'.repeat(260) }],
  ['L deliveryMethod 非法', { title: '诊断用测试商品-方式', price: 12.5, stock: 1, categoryId: 1, deliveryMethod: 'teleport' }],
  ['M 价格超大', { title: '诊断用测试商品-天价', price: 9999999999, stock: 1, categoryId: 1 }],
];

const results = [];
for (const [name, payload] of cases) {
  const r = await post('/goods', payload, token);
  const flag = r.code === 0 ? 'OK  ' : (r.code === 500 ? '**500**' : 'BIZ ');
  console.log(`${flag} ${name.padEnd(28)} code=${r.code} msg=${r.message ?? ''} id=${r.data?.id ?? '-'}`);
  results.push({ name, ...r });
}

const created = results.filter(r => r.code === 0 && r.data?.id).map(r => r.data.id);
console.log('\n成功创建的商品 id:', created.join(', ') || '(无)');
console.log('触发 500 的用例:', results.filter(r => r.code === 500).map(r => r.name).join(' | ') || '(无)');
