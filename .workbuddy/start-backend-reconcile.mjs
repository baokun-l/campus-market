/**
 * D-ALIPAY 收官：带沙箱密钥启动后端，专供「主动对账兜底」真机验证。
 *
 * ★★ 与 start-backend-sandbox.mjs 的关键差异：**不带 demo profile** ★★
 * demo profile 是「重置型」（demo-data-orders.sql 先 DELETE 再 INSERT，
 * 支付单与钱包余额都在重置范围内）。本轮要验证的正是「库里那 3 张卡在 paying 的
 * 沙箱支付单能否被对账捞回来」—— 一旦带 demo 启动，这 3 行会被直接删掉，
 * 证据当场消失，任务永远跑不出对照组。
 * 默认 profile（不带 profile）走的是 schema-auto.sql + seed-base.sql：
 * 零 DROP、零 DELETE、全部守卫式 INSERT，已有库上每条都是 no-op。
 *
 * ★ 快跑 cron 是**刻意覆盖**，且只发生在本脚本里 ★
 * 默认 app.pay.reconcile-cron = 「每秒 0 分、每 2 分钟一轮」。等 2 分钟只能拿到
 * 一次反馈，而本轮要观察的是「多轮执行 + 空跑心跳 + 成交 1 笔 + 另 2 笔不动」。
 * 所以覆盖成每 20 秒一轮 —— 只改频率，不改任何判定逻辑，结算入口仍是同一个 settle。
 * 走环境变量而不是命令行参数：占位符 ${app.pay.reconcile-cron:…} 的默认值里含空格，
 * 用 --app.pay.reconcile-cron=… 在 Windows 下要穿过 spawnSync → CreateProcess 的引号处理，
 * 少一层可变因素就少一类「明明传了却没生效」的排查。
 *
 * ★ 沙箱行为提醒 ★ 不能 spawn 后让 launcher 退出 —— 调用结束时子进程树会被杀掉。
 *   必须由 run_in_background 里的 spawnSync 阻塞保活（见文件末尾 setInterval）。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const root = String.raw`C:\Users\刘宝杰\Desktop\软件开发项目实践\软件开发\实践任务3：后端开发(前后端分离)`;
const envPath = root + String.raw`\campus-secondhand-backend\.env.local`;
const dist = root + String.raw`\campus-secondhand-backend\dist`;

const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
);

// 不打印密钥，只打印配置到位情况
console.log('[env] enabled-channels =', env.APP_PAY_ENABLED_CHANNELS);
console.log('[env] app-id           =', env.APP_PAY_ALIPAY_APP_ID);
console.log('[env] gateway          =', env.APP_PAY_ALIPAY_GATEWAY);
console.log('[env] public-base-url  =', env.APP_PAY_PUBLIC_BASE_URL);
console.log('[env] order-timeout    =', env.APP_PAY_ORDER_TIMEOUT_MINUTES, 'minutes');
console.log('[env] private-key      =', env.APP_PAY_ALIPAY_PRIVATE_KEY ? `${env.APP_PAY_ALIPAY_PRIVATE_KEY.length} chars` : 'MISSING');
console.log('[env] public-key       =', env.APP_PAY_ALIPAY_PUBLIC_KEY ? `${env.APP_PAY_ALIPAY_PUBLIC_KEY.length} chars` : 'MISSING');

// 取 dist/ 里最新的发版 jar（campus-market-1.0.0-<hash>-<ts>.jar，按名末尾 12 位时间戳取最大）
const jar = existsSync(dist)
  ? readdirSync(dist)
      .filter((f) => /^campus-market-1\.0\.0-[0-9a-f]{7}-\d{12}\.jar$/.test(f))
      // ★ 按 12 位时间戳取最大（commit hash 字符序 ≠ 时间序，按名排序会起旧 jar）
      .sort((a, b) => a.match(/(\d{12})\.jar$/)[1].localeCompare(b.match(/(\d{12})\.jar$/)[1]))
      .pop()
  : null;
if (!jar) {
  console.error('RED: dist 里没有发版 jar');
  process.exit(2);
}
console.log('[jar]', jar);

// 防御性清掉代理变量：本机系统代理可能残留在 WorkBuddy 子进程里，
// 而本轮查单是「后端直连支付宝网关」的路径，留一个指向未运行端口的代理只会制造干扰。
const childEnv = { ...process.env, ...env };
delete childEnv.HTTP_PROXY; delete childEnv.http_proxy;
delete childEnv.HTTPS_PROXY; delete childEnv.https_proxy;
/*
 * ★ 快跑 cron 改成**可选**了（RG_CRON 未设时不覆写）★
 * 早先这里无条件写成「每 20 秒一轮」的表达式，那是为了让「多轮执行 + 空跑心跳 +
 * 结算 1 笔 + 另 2 笔不动」在一分钟里就观察完。
 * 但那会带来一个盲区：**yml 里的默认 cron（每 2 分钟）从未被真机走过** ——
 * 而「默认值能不能生效」正是本项目反复踩的坑（占位符名 ≠ 代码键名、缺前缀……）。
 * 所以现在：不设 RG_CRON 就完全不动这个键，让应用去消费它自己的默认占位符。
 *
 * ⚠️ 本段注释**刻意不写出那个 cron 字面量**：它的第 2、3 个字符是「星号 + 斜杠」，
 *   写进块注释会**提前闭合注释**，于是整段代码变成语法错误（本次真的踩了一次）。
 *   要看快节奏：RG_CRON='每20秒的六段式表达式' node 本脚本
 */
if (process.env.RG_CRON) {
  childEnv.APP_PAY_RECONCILE_CRON = process.env.RG_CRON;
  console.log('CRON=' + process.env.RG_CRON + '（覆盖，仅本次验证用）');
} else {
  console.log('CRON=<未覆写> ⇒ 走 application.yml 占位符默认值（每 2 分钟）');
}
console.log('PROFILE=<default>（刻意不带 demo —— 重置型会删掉待验证的支付单）');

const child = spawn(
  'C:/Program Files/Java/jdk-17/bin/java.exe',
  ['-jar', jar, '--server.port=8080'],
  { cwd: dist, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] }
);
child.stdout.on('data', (d) => process.stdout.write(d));
child.stderr.on('data', (d) => process.stderr.write(d));
child.on('exit', (code) => {
  console.log(`[java exited ${code}]`);
  process.exit(code ?? 0);
});
// 阻塞保活（沙箱 Bash 结束会杀子进程树，靠父进程常驻）
setInterval(() => {}, 1 << 30);
