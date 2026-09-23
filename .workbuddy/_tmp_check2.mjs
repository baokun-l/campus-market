process.env.HTTP_PROXY='';process.env.http_proxy='';process.env.HTTPS_PROXY='';process.env.https_proxy='';
const fs = require('fs');
const P = 'C:/Users/刘宝杰/Desktop/软件开发项目实践/软件开发/实践任务3：后端开发(前后端分离)/.workbuddy/_tmp_check2.out';
fs.writeFileSync(P, 'start\n');
const log = s => fs.appendFileSync(P, s + '\n');

(async () => {
  // 1) TCP connect with 5s
  await new Promise(res => {
    const net = require('net');
    const s = net.connect(8080, '127.0.0.1');
    const to = setTimeout(() => { log('TCP 8080: TIMEOUT'); s.destroy(); res(); }, 5000);
    s.on('connect', () => { clearTimeout(to); log('TCP 8080: OPEN'); s.destroy(); res(); });
    s.on('error', e => { clearTimeout(to); log('TCP 8080: ERR ' + e.code); res(); });
  });
  // 2) HTTP GET
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch('http://127.0.0.1:8080/api/goods?page=1&pageSize=1', { signal: ctrl.signal });
    clearTimeout(t);
    log('HTTP 8080: status=' + r.status);
  } catch (e) {
    log('HTTP 8080: ERR ' + e.message);
  }
  log('end');
})();
