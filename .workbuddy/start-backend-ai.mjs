/*
 * 以「指向本地假供应商」的 AI 配置启动后端，用于真机验证降级链。
 *
 * 为什么需要它：
 *   真机验证要有真 key 才能打到真 DeepSeek/千问；而我们要证的是「链的行为」，
 *   不是「模型答得好不好」。所以把 base-url 指到本地假端点、api-key 填任意非空串，
 *   就能在完全离线、零成本的前提下把「顺序 / 降级 / 空响应 / 全失败」全跑一遍。
 *
 * 用法：node .workbuddy/start-backend-ai.mjs
 *      node .workbuddy/start-backend-ai.mjs --jar=<文件名或关键字>   # 红绿对照用：钉住某个 jar
 *      node .workbuddy/start-backend-ai.mjs --plain                 # 不覆写 AI 配置（恢复常规运行态）
 */
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = String.raw`C:\Users\刘宝杰\Desktop\软件开发项目实践\软件开发\实践任务3：后端开发(前后端分离)`;
const BE = path.join(ROOT, 'campus-secondhand-backend');
const DIST = path.join(BE, 'dist');

/* ---- 1. 停掉占用 8080 的旧进程 ---- */
try {
  const out = execSync('netstat -ano', { encoding: 'utf8' });
  const pids = new Set();
  for (const line of out.split(/\r?\n/)) {
    if (/:8080\s/.test(line) && /LISTENING/i.test(line)) {
      const p = line.trim().split(/\s+/).pop();
      if (/^\d+$/.test(p) && p !== '0') pids.add(p);
    }
  }
  for (const pid of pids) {
    console.log('[start] stopping old backend pid=' + pid);
    try { execSync('taskkill /PID ' + pid + ' /T /F', { stdio: 'ignore' }); } catch { /* 可能已退出 */ }
  }
  if (pids.size === 0) console.log('[start] 8080 上没有监听进程');
} catch (e) {
  console.log('[start] 停旧进程失败（继续）: ' + e.message);
}

/* ---- 2. 读 .env.local ---- */
const env = { ...process.env };
const envFile = path.join(BE, '.env.local');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    env[k] = v;
  }
  console.log('[start] 已加载 .env.local');
}

/* ---- 3. 叠加：把两个供应商指到本地假端点 ----
 * ★ --plain：跳过覆写，直接以 .env.local 的常规配置启动（验证跑完用它恢复现场，
 *   免得后端一直指着 127.0.0.1:18081/18082 这两个只在本轮存在的假服务器）。
 */
const plain = process.argv.includes('--plain');
if (plain) {
  console.log('[start] ★ --plain：不覆写 AI 配置，按 .env.local 常规启动');
} else {
  Object.assign(env, {
    APP_AI_CHAIN: 'deepseek,qwen',
    APP_AI_DEEPSEEK_ENABLED: 'true',
    APP_AI_DEEPSEEK_BASE_URL: 'http://127.0.0.1:18081',
    APP_AI_DEEPSEEK_API_KEY: 'probe-key-deepseek',
    APP_AI_DEEPSEEK_MODEL: 'deepseek-chat',
    APP_AI_QWEN_ENABLED: 'true',
    APP_AI_QWEN_BASE_URL: 'http://127.0.0.1:18082',
    APP_AI_QWEN_API_KEY: 'probe-key-qwen',
    APP_AI_QWEN_MODEL: 'qwen-plus',
    APP_AI_OPENAI_ENABLED: 'false',
  });
  console.log('[start] AI 供应商已指向本地假端点 18081(deepseek) / 18082(qwen)');
}

/* ---- 4. 找最新的 jar ----
 * ★ 坑（已踩）：本机 dist 下所有 jar 的 mtime 都被规整成 2026-01-01T00:00:00Z，
 *   「按 mtime 取最新」等于按 readdir 顺序取，会静默跑起旧 jar（曾误跑 0494149）。
 *   唯一可信的序 = 文件名末尾的 12 位时间戳 -YYYYMMDDHHmm。
 */
const jars = fs
  .readdirSync(DIST)
  .map((f) => {
    const m = /^campus-market-.*-(\d{12})\.jar$/.exec(f);
    return m ? { f, ts: m[1] } : null;
  })
  .filter(Boolean)
  .sort((a, b) => b.ts.localeCompare(a.ts));
if (!jars.length) {
  console.error('[start] dist 里没有 jar，先跑 build-release.mjs');
  process.exit(1);
}

/* --jar=<文件名或关键字>：红绿对照用，故意钉一个旧 jar 去跑，验证探针会报红 */
const pinArg = process.argv.find((a) => a.startsWith('--jar='));
let picked;
if (pinArg) {
  const want = pinArg.slice('--jar='.length);
  const hits = jars.filter((j) => j.f.includes(want));
  if (hits.length !== 1) {
    console.error('[start] --jar=' + want + ' 命中 ' + hits.length + ' 个，必须唯一：' + JSON.stringify(hits.map((h) => h.f)));
    process.exit(1);
  }
  picked = hits[0];
  console.log('[start] ★ 已钉住 jar（红绿对照模式）');
} else {
  picked = jars[0];
}
const jar = path.join(DIST, picked.f);
console.log('[start] jar = ' + picked.f + ' (ts=' + picked.ts + ', 候选 ' + jars.length + ' 个)');

/* ---- 5. 启动（前台阻塞，保证不被沙箱回收子进程树） ---- */
const java = 'C:/Program Files/Java/jdk-17/bin/java.exe';
const child = spawn(java, ['-Duser.timezone=Asia/Shanghai', '-jar', jar, '--server.port=8080'], {
  env,
  stdio: ['ignore', 'inherit', 'inherit'],
});
console.log('[start] started pid=' + child.pid);

const stop = () => { try { child.kill(); } catch { /* ignore */ } process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
child.on('exit', (code) => { console.log('[start] backend exited code=' + code); process.exit(code || 0); });
