// 白名单前缀绕过探针：用 .. / 编码 / 分号 穿越到受保护路由
const BASE = 'http://localhost:8080/api';
const rows = [];

async function raw(path, method = 'GET', token) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetch(BASE + path, { method, headers, redirect: 'manual' });
    const text = await res.text();
    let code = null;
    try { code = JSON.parse(text).code; } catch { /* HTML 或空体 */ }
    return { http: res.status, code, body: text.slice(0, 90).replace(/\s+/g, ' ') };
  } catch (e) {
    return { http: 'ERR', code: null, body: String(e.message).slice(0, 60) };
  }
}

// 受保护目标：GET /admin/categories/stats 仅 admin；GET /orders 仅登录用户
const targets = ['/admin/categories/stats', '/orders'];

// 借道白名单前缀（PUBLIC_GET 里的通配前缀）
const prefixes = ['/uploads', '/goods', '/users'];

const variants = (target) => {
  const t = target.replace(/^\//, '');
  return [
    { label: '基线（直连）', path: target },
    { label: '单 ..', path: `/uploads/../${t}` },
    { label: '双 ..', path: `/uploads/../../api/${t}` },
    { label: '编码 ..', path: `/uploads/%2e%2e/${t}` },
    { label: '双编码 ..', path: `/uploads/%252e%252e/${t}` },
    { label: '分号 ..;', path: `/uploads/..;/${t}` },
    { label: '反斜杠', path: `/uploads/..\\${t}` },
    { label: 'goods 借道', path: `/goods/x/../../${t}` },
    { label: 'users 借道', path: `/users/x/profile/../../../${t}` },
  ];
};

for (const target of targets) {
  for (const v of variants(target)) {
    const r = await raw(v.path, 'GET', null);
    // 判定：拿到数据（code=0）即绕过成功
    const bypass = r.code === 0;
    rows.push({ target, label: v.label, path: v.path, ...r, verdict: bypass ? 'BYPASS!' : (r.code === 401 ? 'ok(401)' : `code=${r.code}`) });
  }
}

const bad = rows.filter((r) => r.verdict === 'BYPASS!');
console.log('target'.padEnd(28) + 'variant'.padEnd(14) + 'http'.padEnd(6) + 'code'.padEnd(7) + 'verdict');
for (const r of rows) {
  console.log(r.target.padEnd(28) + r.label.padEnd(14) + String(r.http).padEnd(6) + String(r.code).padEnd(7) + r.verdict);
}
console.log(`\n合计 ${rows.length} 项，白名单绕过 ${bad.length} 项`);
if (bad.length) {
  console.log('\n--- 绕过成功明细 ---');
  for (const b of bad) console.log(b.path + '  →  ' + b.body);
}
process.exit(bad.length ? 1 : 0);
