/*
 * 真机探针：证明 AI 降级链真的按「DeepSeek → 千问 → 模板」工作
 *
 * ★ 为什么不需要真 key ★
 * 要验证的是「链的行为」：顺序、降级、空响应换家、全失败回模板。
 * 这些与模型的**内容质量**无关，所以用两个本地假 OpenAI 兼容端点即可证伪 ——
 * 而且比用真 key 更强：能精确控制「哪一家失败、以什么方式失败」。
 *
 * 用法：
 *   node .workbuddy/probe-ai-chain-live.mjs serve             # 起两个假供应商（后台常驻）
 *   node .workbuddy/probe-ai-chain-live.mjs mode deepseek fail qwen ok
 *   node .workbuddy/probe-ai-chain-live.mjs log
 *   node .workbuddy/probe-ai-chain-live.mjs reset
 *   node .workbuddy/probe-ai-chain-live.mjs assert
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = String.raw`C:\Users\刘宝杰\Desktop\软件开发项目实践\软件开发\实践任务3：后端开发(前后端分离)`;
const TMP = path.join(ROOT, '.workbuddy', 'tmp');
const MODE_FILE = path.join(TMP, 'ai-chain-mode.json');
const LOG_FILE = path.join(TMP, 'ai-chain-requests.jsonl');

const PORTS = { deepseek: 18081, qwen: 18082 };
const BACKEND = 'http://127.0.0.1:8080/api';

function readMode() {
  try {
    return JSON.parse(fs.readFileSync(MODE_FILE, 'utf8'));
  } catch {
    return { deepseek: 'ok', qwen: 'ok' };
  }
}

function writeLog(rec) {
  fs.appendFileSync(LOG_FILE, JSON.stringify(rec) + '\n', 'utf8');
}

function readLog() {
  try {
    return fs
      .readFileSync(LOG_FILE, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function completion(provider, model, content) {
  return {
    id: 'chatcmpl-fake-' + provider,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
  };
}

async function serveOne(provider) {
  const port = PORTS[provider];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* 非 JSON 也记下来 */ }
      const behavior = readMode()[provider] || 'ok';
      writeLog({
        at: new Date().toISOString(),
        provider,
        path: req.url,
        method: req.method,
        model: parsed && parsed.model,
        messageCount: parsed && Array.isArray(parsed.messages) ? parsed.messages.length : null,
        roles: parsed && Array.isArray(parsed.messages) ? parsed.messages.map((m) => m.role) : null,
        behavior,
      });

      if (behavior === 'fail') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'fake failure for probe', type: 'server_error' } }));
        return;
      }
      if (behavior === 'blank') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(completion(provider, (parsed && parsed.model) || 'x', '   ')));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(completion(provider, (parsed && parsed.model) || 'x', 'FAKE-' + provider.toUpperCase())));
    });
  });
  server.listen(port, '127.0.0.1', () => {
    console.log('[fake] ' + provider + ' listening on http://127.0.0.1:' + port + '/v1/chat/completions');
  });
  return server;
}

/* ---------------- 后端调用 ---------------- */

async function callJson(url, opts) {
  const r = await fetch(url, opts);
  const t = await r.text();
  let body;
  try { body = JSON.parse(t); } catch { body = t.slice(0, 300); }
  return { status: r.status, body, headers: r.headers };
}

async function login() {
  const r = await callJson(BACKEND + '/user/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  const setc = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')].filter(Boolean);
  return setc.map((c) => c.split(';')[0]).join('; ');
}

async function chat(cookie, msg) {
  return callJson(BACKEND + '/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ message: msg }),
  });
}

/* ---------------- 断言 ---------------- */

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   [' + detail + ']' : ''));
}

async function doAssert() {
  const pass = process.env.AI_PROBE_LABEL || 'AFTER';

  // 0) 清空请求日志，保证断言只看本次
  fs.writeFileSync(LOG_FILE, '', 'utf8');

  const cookie = await login();
  check('能拿到登录凭据', !!cookie, cookie ? 'cookie 已获取' : '拿不到 cookie');
  if (!cookie) return finish(pass);

  const prov = await callJson(BACKEND + '/ai/providers', { headers: { Cookie: cookie } });
  const data = prov.body && prov.body.data;
  console.log('  /ai/providers → ' + JSON.stringify(data));
  check('链上 registered 含 deepseek 与 qwen',
    !!data && JSON.stringify(data.available) === JSON.stringify(['deepseek', 'qwen']),
    data ? 'available=' + JSON.stringify(data.available) : 'no data');
  check('missing 为空（两家 key 都配上了）', !!data && Array.isArray(data.missing) && data.missing.length === 0,
    data ? 'missing=' + JSON.stringify(data.missing) : '');
  check('unknown 为空（链里没有拼错的名字）', !!data && Array.isArray(data.unknown) && data.unknown.length === 0,
    data ? 'unknown=' + JSON.stringify(data.unknown) : '');

  // A) 两家都好 → 只调链首，且用的是 deepseek 的模型名
  fs.writeFileSync(MODE_FILE, JSON.stringify({ deepseek: 'ok', qwen: 'ok' }), 'utf8');
  fs.writeFileSync(LOG_FILE, '', 'utf8');
  const a = await chat(cookie, '怎么退款？');
  const aText = a.body && a.body.data && a.body.data.reply;
  let log = readLog();
  check('A 两家都好 → 回复来自链首 deepseek', aText === 'FAKE-DEEPSEEK', 'reply=' + JSON.stringify((aText || '').slice(0, 40)));
  check('A 只调了 deepseek 一次（链首成功不再调下一家）',
    log.length === 1 && log[0].provider === 'deepseek', 'calls=' + JSON.stringify(log.map((l) => l.provider)));
  check('A 传给 deepseek 的 model 是 deepseek-chat',
    log.length === 1 && log[0].model === 'deepseek-chat', 'model=' + (log[0] && log[0].model));
  check('A 出站路径正确（/v1/chat/completions）',
    log.length === 1 && log[0].path === '/v1/chat/completions', 'path=' + (log[0] && log[0].path));
  check('A 角色隔离：出站消息是 system+user 两条',
    log.length === 1 && log[0].messageCount === 2 && JSON.stringify(log[0].roles) === JSON.stringify(['system', 'user']),
    log.length === 1 ? 'roles=' + JSON.stringify(log[0].roles) : 'n/a');

  // B) 链首 500 → 落到千问
  fs.writeFileSync(MODE_FILE, JSON.stringify({ deepseek: 'fail', qwen: 'ok' }), 'utf8');
  fs.writeFileSync(LOG_FILE, '', 'utf8');
  const b = await chat(cookie, '卖家不发货怎么办？');
  const bText = b.body && b.body.data && b.body.data.reply;
  log = readLog();
  check('B deepseek 失败 → 回复来自千问', bText === 'FAKE-QWEN', 'reply=' + JSON.stringify((bText || '').slice(0, 40)));
  check('B 两家都被调过，且顺序是 deepseek→qwen',
    JSON.stringify(log.map((l) => l.provider)) === JSON.stringify(['deepseek', 'qwen']),
    'calls=' + JSON.stringify(log.map((l) => l.provider)));
  check('B 传给千问的 model 是 qwen-plus',
    log.length === 2 && log[1].model === 'qwen-plus', 'model=' + (log[1] && log[1].model));

  // C) 链首「空响应」→ 也必须落到千问
  fs.writeFileSync(MODE_FILE, JSON.stringify({ deepseek: 'blank', qwen: 'ok' }), 'utf8');
  fs.writeFileSync(LOG_FILE, '', 'utf8');
  const c = await chat(cookie, '怎么举报？');
  const cText = c.body && c.body.data && c.body.data.reply;
  log = readLog();
  check('C 链首返回空白 → 回复来自千问', cText === 'FAKE-QWEN', 'reply=' + JSON.stringify((cText || '').slice(0, 40)));
  check('C 空白响应确实触发了降级（两家都调过）',
    JSON.stringify(log.map((l) => l.provider)) === JSON.stringify(['deepseek', 'qwen']),
    'calls=' + JSON.stringify(log.map((l) => l.provider)));

  // D) 两家都失败 → 回退模板文案
  fs.writeFileSync(MODE_FILE, JSON.stringify({ deepseek: 'fail', qwen: 'fail' }), 'utf8');
  fs.writeFileSync(LOG_FILE, '', 'utf8');
  const d = await chat(cookie, '平台规则是什么？');
  const dText = (d.body && d.body.data && d.body.data.reply) || '';
  log = readLog();
  check('D 两家都失败 → 回退模板文案（不是空回复）',
    dText.includes('智能客服') || dText.includes('管理员'), 'reply=' + JSON.stringify(dText.slice(0, 50)));
  check('D 两家都被尝试过',
    JSON.stringify(log.map((l) => l.provider)) === JSON.stringify(['deepseek', 'qwen']),
    'calls=' + JSON.stringify(log.map((l) => l.provider)));
  check('D 全失败时接口仍返回 HTTP 200 + code 0（契约不变）',
    d.status === 200 && d.body && d.body.code === 0, 'status=' + d.status + ' code=' + (d.body && d.body.code));

  fs.writeFileSync(MODE_FILE, JSON.stringify({ deepseek: 'ok', qwen: 'ok' }), 'utf8');
  finish(pass);
}

function finish(label) {
  const passCount = results.filter((r) => r.ok).length;
  const out = path.join(ROOT, '.workbuddy', 'evidence', 'ai-chain-' + label + '.txt');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const lines = [
    'AI 降级链真机探针 · ' + label + ' · ' + new Date().toISOString(),
    '合计 ' + passCount + '/' + results.length + (passCount === results.length ? '  ALL PASS' : '  ← 有失败'),
    '',
    ...results.map((r) => (r.ok ? 'PASS  ' : 'FAIL  ') + r.name + (r.detail ? '   [' + r.detail + ']' : '')),
  ];
  fs.writeFileSync(out, lines.join('\n') + '\n', 'utf8');
  console.log('');
  console.log('合计 ' + passCount + '/' + results.length + ' → ' + out);
  process.exit(passCount === results.length ? 0 : 1);
}

/* ---------------- 入口 ---------------- */

const cmd = process.argv[2] || 'help';

if (cmd === 'serve') {
  fs.writeFileSync(MODE_FILE, JSON.stringify({ deepseek: 'ok', qwen: 'ok' }), 'utf8');
  fs.writeFileSync(LOG_FILE, '', 'utf8');
  await serveOne('deepseek');
  await serveOne('qwen');
  console.log('[fake] ready. mode file=' + MODE_FILE);
} else if (cmd === 'mode') {
  const [, d, q] = process.argv.slice(3);
  fs.writeFileSync(MODE_FILE, JSON.stringify({ deepseek: d, qwen: q }), 'utf8');
  console.log('mode = ' + fs.readFileSync(MODE_FILE, 'utf8'));
} else if (cmd === 'log') {
  console.log(readLog().map((l) => l.at + '  ' + l.provider + '  model=' + l.model + '  behavior=' + l.behavior + '  path=' + l.path).join('\n') || '(空)');
} else if (cmd === 'reset') {
  fs.writeFileSync(LOG_FILE, '', 'utf8');
  console.log('request log cleared');
} else if (cmd === 'assert') {
  await doAssert();
} else {
  console.log('用法: serve | mode <deepseek> <qwen> | log | reset | assert');
}
