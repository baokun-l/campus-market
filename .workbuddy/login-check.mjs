// 六个种子账号登录验证（schema.sql 换 BCrypt 后的回归探针）
// 用法：先清空代理环境变量，后端跑在 8080，然后 node login-check.mjs
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:8080/api';

const ACCOUNTS = [
  ['admin', 'admin123'],
  ['goods_admin', 'goods123456'],
  ['report_admin', 'report123456'],
  ['zhangsan', '123456'],
  ['lisi', '123456'],
  ['wangwu', '123456'],
];

let fail = 0;
for (const [username, password] of ACCOUNTS) {
  const res = await fetch(`${BASE}/user/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await res.json().catch(() => ({}));
  const token = body?.data?.token;
  const role = body?.data?.user?.role ?? body?.data?.role;
  const ok = res.ok && body?.code === 0 && !!token;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${username.padEnd(13)} code=${body?.code} role=${role ?? '-'} token=${token ? token.slice(0, 12) + '...' : 'none'}`);
}
console.log(fail === 0 ? 'ALL 6 ACCOUNTS PASS' : `${fail} ACCOUNT(S) FAILED`);
process.exit(fail === 0 ? 0 : 1);
