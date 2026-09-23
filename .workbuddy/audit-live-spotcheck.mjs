// 窄列溢出收敛 · 现场抽查（针对当前 8080 运行实例）
// 原则：只发应当被拒绝的非法请求 → 预期 code=1001，出现 500 即判 FAIL
const BASE = 'http://localhost:8080/api';
const rows = [];

async function call(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON（Tomcat 400 HTML 等） */ }
  return { http: res.status, code: json?.code, message: json?.message };
}

function judge(label, rule, r) {
  const ok = r.code === 1001;
  rows.push({ label, rule, got: `http=${r.http} code=${r.code}`, msg: String(r.message ?? '').slice(0, 40), verdict: ok ? 'PASS' : (r.code === 500 ? 'FAIL_500' : 'UNEXPECTED') });
}

const L = (n) => 'x'.repeat(n);

const adminRes = await fetch(BASE + '/user/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
});
const adminToken = (await adminRes.json()).data?.token;
const userRes = await fetch(BASE + '/user/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'zhangsan', password: '123456' }),
});
const userToken = (await userRes.json()).data?.token;

if (!adminToken || !userToken) {
  console.error('登录失败，无法继续：admin=' + !!adminToken + ' user=' + !!userToken);
  process.exit(2);
}

// ── A. 窄列溢出（varchar 上限）──────────────────────────────
judge('商品 title 260 字', 'title varchar(200)', await call('POST', '/goods', {
  token: userToken, body: { title: L(260), price: 10, categoryId: 1, location: '图书馆', deliveryMethod: 'meet' },
}));

judge('商品 location 260 字', 'location varchar(200)', await call('POST', '/goods', {
  token: userToken, body: { title: '探针', price: 10, categoryId: 1, location: L(260), deliveryMethod: 'meet' },
}));

judge('收货人 80 字', 'receiver varchar(50)', await call('POST', '/user/addresses', {
  token: userToken, body: { receiver: L(80), phone: '13800000000', region: '北京', detail: 'x', tag: 'home' },
}));

judge('公告标题 300 字', 'title varchar(200)', await call('POST', '/admin/notices', {
  token: adminToken, body: { title: L(300), content: '正文' },
}));

judge('分类名 80 字', 'category name varchar(50)', await call('POST', '/admin/categories', {
  token: adminToken, body: { name: L(80), icon: 'icon' },
}));

judge('警告事由 600 字', 'reason varchar(500)', await call('POST', '/admin/users/1/warn', {
  token: adminToken, body: { reason: L(600) },
}));

judge('活动标题 200 字', 'title varchar(100)', await call('POST', '/admin/activities', {
  token: adminToken, body: { id: 'probe-spot-' + Date.now(), title: L(200), durationDays: 7 },
}));

judge('活动 id 80 字', 'activity id varchar(64)', await call('POST', '/admin/activities', {
  token: adminToken, body: { id: L(80), title: '探针', durationDays: 7 },
}));

// ── B. 数值 / 枚举（此前"该拒未拒"或直接 500）──────────────
judge('商品 price = -5', 'price decimal 正数约束', await call('POST', '/goods', {
  token: userToken, body: { title: '探针', price: -5, categoryId: 1, location: '图书馆', deliveryMethod: 'meet' },
}));

judge('商品 price = 9999999999', 'price decimal(10,2)', await call('POST', '/goods', {
  token: userToken, body: { title: '探针', price: 9999999999, categoryId: 1, location: '图书馆', deliveryMethod: 'meet' },
}));

judge('商品 deliveryMethod=teleport', 'deliveryMethod 枚举白名单', await call('POST', '/goods', {
  token: userToken, body: { title: '探针', price: 10, categoryId: 1, location: '图书馆', deliveryMethod: 'teleport' },
}));

judge('商品 categoryId 缺失', 'categoryId 必填', await call('POST', '/goods', {
  token: userToken, body: { title: '探针', price: 10, location: '图书馆', deliveryMethod: 'meet' },
}));

judge('封面塞 data URL(3KB)', 'cover varchar(255)', await call('POST', '/goods', {
  token: userToken, body: { title: '探针', price: 10, categoryId: 1, location: '图书馆', deliveryMethod: 'meet', cover: 'data:image/jpeg;base64,' + L(3000) },
}));

// ── 输出 ────────────────────────────────────────────────────
const bad = rows.filter((r) => r.verdict !== 'PASS');
console.log('label'.padEnd(30) + 'rule'.padEnd(32) + 'got'.padEnd(28) + 'verdict');
for (const r of rows) console.log(r.label.padEnd(30) + r.rule.padEnd(32) + r.got.padEnd(28) + r.verdict + (r.msg ? '  ' + r.msg : ''));
console.log(`\n合计 ${rows.length} 项：PASS ${rows.length - bad.length} / FAIL_500 ${bad.filter(b => b.verdict === 'FAIL_500').length} / UNEXPECTED ${bad.filter(b => b.verdict === 'UNEXPECTED').length}`);
process.exit(bad.length ? 1 : 0);
