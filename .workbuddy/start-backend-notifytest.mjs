/**
 * D-ALIPAY 收官 · 缺陷④ 探针 B 专用启动器：把**回调验签锚**换成一对可控密钥。
 *
 * ★★ 为什么要换验签锚，以及为什么这不等于「改代码」★★
 * 缺陷④ 的能力是「渠道回调晚于关单到达时，closed 支付单仍能被结算」。
 * 触发它的唯一入口是 POST /pay/notify/{channel}，而该入口的**全部鉴权就是验签** ——
 * 也就是说，除了支付宝本人，没有人能合法地产生这条请求。
 * 想在没有支付宝配合的情况下验证这条路，唯一办法是让「我们信任的签名」变成
 * 「我们能签出来的签名」：把 APP_PAY_ALIPAY_PUBLIC_KEY 临时设为
 * **应用私钥所对应的公钥**（私钥本就在 .env.local 里，公钥由它派生）。
 *
 * 于是这条链路上除「信任锚是谁」以外的每一环都是真的：
 *   真 jar、真 HTTP、真 RSA2 验签（SHA256withRSA 真算）、真 app_id 闸、真金额闸、
 *   真 settle 条件更新、真 markPaid、真 autoRefund、真库。
 * 换掉的只是一个**配置值**（哪把公钥算数），代码一行未动 ——
 * 这正是集成测试里「渠道仿真」的标准做法。
 *
 * ★★ 关键：只在子进程环境里覆写，**.env.local 磁盘文件一个字都不动** ★★
 * 早先的设想是改 .env.local 再改回来，那要依赖「记得改回来」+ 逐字节校验，
 * 属于把风险押在纪律上。改成「启动器在合并环境变量之后再覆写」后，
 * 磁盘文件从未被写过 —— 没有「忘了还原」这个状态存在的可能。
 *
 * ★ 顺带说明：本进程运行期间，出站响应验签也会用这把派生公钥 ★
 * 于是对账查单会失败（UNAVAILABLE）。这是**安全方向**的失败：
 * 按四态语义，「问不到」不改任何状态 —— 正好又当着真机演一遍。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

const root = String.raw`C:\Users\刘宝杰\Desktop\软件开发项目实践\软件开发\实践任务3：后端开发(前后端分离)`;
const envPath = root + String.raw`\campus-secondhand-backend\.env.local`;
const dist = root + String.raw`\campus-secondhand-backend\dist`;

const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
);

// 由应用私钥派生公钥（X.509/SPKI 的裸 base64；AlipayRsa2.decodePem 支持无 PEM 头尾的形态）
const privKey = crypto.createPrivateKey({
  key: Buffer.from(env.APP_PAY_ALIPAY_PRIVATE_KEY, 'base64'),
  format: 'der',
  type: 'pkcs8',
});
const derivedPubB64 = crypto.createPublicKey(privKey).export({ format: 'der', type: 'spki' }).toString('base64');

const jar = existsSync(dist)
  ? readdirSync(dist)
      .filter((f) => /^campus-market-1\.0\.0-[0-9a-f]{7}-\d{12}\.jar$/.test(f))
      .sort((a, b) => a.match(/(\d{12})\.jar$/)[1].localeCompare(b.match(/(\d{12})\.jar$/)[1]))
      .pop()
  : null;
if (!jar) { console.error('RED: dist 里没有发版 jar'); process.exit(2); }

console.log('[env] enabled-channels    =', env.APP_PAY_ENABLED_CHANNELS);
console.log('[env] app-id              =', env.APP_PAY_ALIPAY_APP_ID);
console.log('[env] gateway             =', env.APP_PAY_ALIPAY_GATEWAY);
console.log('[env] order-timeout       =', env.APP_PAY_ORDER_TIMEOUT_MINUTES, 'minutes');
console.log('[env] 原验签公钥长度      =', (env.APP_PAY_ALIPAY_PUBLIC_KEY || '').length, 'chars（支付宝公钥）');
console.log('[env] 覆写为派生公钥长度  =', derivedPubB64.length, 'chars（应用私钥对应公钥；仅本进程）');
console.log('[jar]', jar);
console.log('PROFILE=<default>   磁盘 .env.local 未被修改');

const childEnv = { ...process.env, ...env };
delete childEnv.HTTP_PROXY; delete childEnv.http_proxy;
delete childEnv.HTTPS_PROXY; delete childEnv.https_proxy;
childEnv.APP_PAY_ALIPAY_PUBLIC_KEY = derivedPubB64;
childEnv.APP_PAY_RECONCILE_CRON = '*/20 * * * * ?';

const child = spawn(
  'C:/Program Files/Java/jdk-17/bin/java.exe',
  ['-jar', jar, '--server.port=8080'],
  { cwd: dist, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] }
);
child.stdout.on('data', (d) => process.stdout.write(d));
child.stderr.on('data', (d) => process.stderr.write(d));
child.on('exit', (code) => { console.log(`[java exited ${code}]`); process.exit(code ?? 0); });
setInterval(() => {}, 1 << 30);
