// 验证「带图发布」是否必然 500：前端把图片压成 base64 data URL 塞进 cover / images
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8080/api';

async function post(path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { }
  return { http: res.status, code: json?.code, message: json?.message, id: json?.data?.id };
}

const login = await post('/user/login', { username: 'zhangsan', password: '123456' });
const token = login.data?.token; // login 走 post() 返回的是顶层字段
console.log(`登录: code=${login.code}`);

// 重新取 token（post() 已解构，这里单独取一次以防万一）
const raw = await fetch(`${BASE}/user/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'zhangsan', password: '123456' }),
}).then(r => r.json());
const tk = raw?.data?.token;
console.log(`token=${tk ? 'ok' : 'NONE'}`);
if (!tk) process.exit(1);

const dataUrl = (kb) => 'data:image/jpeg;base64,' + 'A'.repeat(kb * 1024);
const base = { title: '诊断用测试商品-图片', price: 12.5, stock: 1, categoryId: 1, description: '探针', location: '校园内', deliveryMethod: 'face' };

const cases = [
  ['1 cover=3KB dataURL', { ...base, cover: dataUrl(3) }],
  ['2 cover=纯路径(对照)', { ...base, cover: '/goods/cat1-1.jpg' }],
  ['3 images=[3KB]', { ...base, cover: '/goods/cat1-1.jpg', images: [dataUrl(3)] }],
  ['4 images=[40KB]', { ...base, cover: '/goods/cat1-1.jpg', images: [dataUrl(40)] }],
  ['5 images=[80KB]', { ...base, cover: '/goods/cat1-1.jpg', images: [dataUrl(80)] }],
  ['6 images=[3KB x4]', { ...base, cover: '/goods/cat1-1.jpg', images: [dataUrl(3), dataUrl(3), dataUrl(3), dataUrl(3)] }],
];

const ok = [];
for (const [name, payload] of cases) {
  const r = await post('/goods', payload, tk);
  const flag = r.code === 0 ? 'OK  ' : (r.code === 500 ? '**500**' : 'BIZ ');
  console.log(`${flag} ${name.padEnd(26)} code=${r.code} id=${r.id ?? '-'} msg=${r.message ?? ''}`);
  if (r.code === 0 && r.id) ok.push(r.id);
}
console.log('\n成功创建 id:', ok.join(', ') || '(无)');
