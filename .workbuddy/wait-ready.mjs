/**
 * 等待后端就绪。
 *
 * ★ 为什么不用「能拿到 200」当就绪条件 ★
 * 本项目所有响应都是 HTTP 200（错误码在 body 里，见业务约定），
 * 所以「HTTP 200」在有代理页、甚至在有别的进程占用时也可能成立，
 * 会造成「假就绪」—— 探针随后拿到一串 404/ECONNREFUSED，
 * 看起来像功能坏了。
 * 这里改成：拿到一个 **能解析成 JSON 且带 code 字段** 的响应才算就绪；
 * 并且特意打**公开且无副作用**的 /users/online（打登录接口会给闸门计失败次数）。
 */
const BASE = 'http://127.0.0.1:8080/api';
const DEADLINE_MS = 60_000;
const started = Date.now();

let last = '(未尝试)';
while (Date.now() - started < DEADLINE_MS) {
  try {
    const res = await fetch(BASE + '/users/online?ids=1', { method: 'GET' });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    if (json && typeof json.code === 'number') {
      console.log(`READY  after ${Date.now() - started}ms  code=${json.code}`);
      process.exit(0);
    }
    last = `status=${res.status} body=${text.slice(0, 80)}`;
  } catch (e) {
    last = 'ERR:' + String(e.message).slice(0, 80);
  }
  await new Promise(r => setTimeout(r, 1000));
}
console.log('NOT READY within ' + DEADLINE_MS + 'ms, last=' + last);
process.exit(1);
