/**
 * 校园币充值入口 · 界面截图与断言（CDP）
 * 用法：node scripts/shot-wallet.cjs [--target=http://127.0.0.1:5173] [--out=C:/wbtmp]
 *
 * ★ 为什么不能直接用 shot.cjs ★
 * shot.cjs 走的是 **mock 模式**：它往 localStorage 写一个假的 `mock-token-user-1`。
 * 而本工作区 `.env.development` 里 `VITE_USE_MOCK=false`（联调模式，请求真打到 8080），
 * 那种假 token 会被 AuthInterceptor 拒掉，页面直接弹回登录页、截出来是空页。
 * 所以这里改成：**先用真实账号登录拿票据，再把票据以 Cookie 形式注入浏览器**。
 *
 * ★ 为什么要注入 Cookie 而不是在页面上填表单登录 ★
 * D9 之后凭据走 HttpOnly Cookie（名 `c2c-token`），前端 store 里**不再有任何 token**。
 * 靠页面表单登录需要依赖输入框选择器，页面一改就脆；直接注入 Cookie
 * 走的正是浏览器与后端之间那条真实通道，一次到位且与页面结构解耦。
 *
 * 断言口径：不只截图，还要在页面上**读到**「去充值」这个按钮才算通过 ——
 * 截图可能只是一片空白，而空白在肉眼下和「页面正常但没有这个按钮」很难区分。
 */
const http = require('http')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const argv = process.argv.slice(2)
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`))
  return hit ? hit.split('=').slice(1).join('=') : d
}
const TARGET = arg('target', 'http://127.0.0.1:5173')
const OUT = arg('out', 'C:/wbtmp/wallet-shots')
const API = arg('api', 'http://127.0.0.1:8080/api')
const USER = arg('user', 'admin')
const PASS = arg('pass', 'admin123')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9334

const results = []
function check(name, cond, detail = '') {
  results.push({ name, cond })
  console.log(`${cond ? '  [PASS] ' : '  [FAIL] '}${name}${detail ? '  -> ' + detail : ''}`)
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = ''
      res.on('data', (c) => (d += c))
      res.on('end', () => resolve(d))
    }).on('error', reject)
  })
}

/** 真实登录，拿票据（响应体里仍有 token，见 UserController#issueSessionCookie 的说明） */
function login() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ username: USER, password: PASS })
    const req = http.request(
      `${API}/user/login`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let d = ''
        res.on('data', (c) => (d += c))
        res.on('end', () => {
          try {
            const j = JSON.parse(d)
            if (j.code !== 0) return reject(new Error('登录失败: ' + d))
            resolve(j.data.token)
          } catch (e) { reject(e) }
        })
      }
    )
    req.on('error', reject)
    req.end(body)
  })
}

async function waitForEndpoint(retries = 50) {
  for (let i = 0; i < retries; i++) {
    try {
      const v = await httpGet(`http://127.0.0.1:${PORT}/json/version`)
      if (v) return JSON.parse(v)
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error('Chrome CDP 未就绪')
}

class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id)
        this.pending.delete(m.id)
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP timeout ${method}`)) }
      }, 30000)
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    return r.result.value
  }
}

async function connect() {
  const list = JSON.parse(await httpGet(`http://127.0.0.1:${PORT}/json/list`))
  let page = list.find((t) => t.type === 'page')
  if (!page) {
    await httpGet(`http://127.0.0.1:${PORT}/json/new?about:blank`)
    const l2 = JSON.parse(await httpGet(`http://127.0.0.1:${PORT}/json/list`))
    page = l2.find((t) => t.type === 'page')
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', rej)
  })
  return new CDP(ws)
}

const CLICK_HELPER = `
window.__clickByText = (t) => {
  const cands = [...document.querySelectorAll('.el-button, button, a')];
  let hit = cands.find((n) => n.textContent.trim() === t);
  if (!hit) return 'not-found';
  hit.click();
  return 'clicked';
};
'ready'`

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })

  const token = await login()
  console.log(`已用 ${USER} 登录，票据长度 ${token.length}`)

  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(OUT, 'chrome-profile')}`.replace(/\//g, '\\'),
    '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--disable-extensions',
    'about:blank'
  ], { stdio: 'ignore' })

  const version = await waitForEndpoint()
  console.log('Chrome:', version['Browser'])

  const cdp = await connect()
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Network.enable')

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false
  })

  // 先落到同源页面，再注入 Cookie（Network.setCookie 用 url 形式最省事）
  await cdp.send('Page.navigate', { url: `${TARGET}/login` })
  await new Promise((r) => setTimeout(r, 2000))

  const set = await cdp.send('Network.setCookie', {
    name: 'c2c-token',
    value: token,
    url: `${TARGET}/`,
    httpOnly: true
  })
  console.log('Cookie 注入:', JSON.stringify(set))
  check('W0 登录票据已注入 HttpOnly Cookie', Boolean(set.success))

  /*
   * ★ 还要补 localStorage 里的 `sessionHint` ★
   *
   * 光有 Cookie 会被前端自己的路由守卫弹回登录页 —— 真实模式下凭据在 HttpOnly Cookie 中，
   * 前端**读不到它**，所以 `isLoggedIn` 的唯一来源是 store 里那个不含凭据的布尔 `sessionHint`
   * （见 stores/modules/user.ts 的注释）。持久化键 `c2c-user`，paths 只有 token / sessionHint。
   *
   * 这一步**不是绕过鉴权**：它只骗过"界面上要不要显示登录态"这一层；
   * 所有接口的通行证仍然是上面那个 Cookie，服务端是唯一裁判
   * （伪造 sessionHint 换不到任何权限，这正是那个设计的用意）。
   */
  const hint = await cdp.eval(
    `localStorage.setItem('c2c-user', JSON.stringify({token:'',sessionHint:true}));'ok'`
  )
  check('W0b 已补 sessionHint（否则会被路由守卫弹回登录页）', hint === 'ok')

  // ---- ① 设置页：校园钱包分组 ----
  await cdp.send('Page.navigate', { url: `${TARGET}/settings` })
  await new Promise((r) => setTimeout(r, 4200))

  const hasTitle = await cdp.eval(`document.body.innerText.includes('校园钱包')`)
  check('W1 设置页出现「校园钱包」分组', hasTitle === true)

  const hasBtn = await cdp.eval(
    `[...document.querySelectorAll('.el-button,button')].some(b=>b.textContent.trim()==='去充值')`
  )
  check('W2 设置页出现「去充值」按钮', hasBtn === true)

  const amountText = await cdp.eval(`
    (() => {
      const el = document.querySelector('.wallet-amount');
      return el ? el.textContent.trim() : null;
    })()
  `)
  check('W3 余额被真实读出（非占位符）', amountText !== null && amountText !== '—',
        String(amountText))

  let shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(OUT, '01-settings-wallet.png'), Buffer.from(shot.data, 'base64'))
  console.log('  ✅ 01-settings-wallet.png')

  // ---- ② 点「去充值」→ 充值弹窗 ----
  await cdp.eval(CLICK_HELPER)
  const clicked = await cdp.eval(`window.__clickByText('去充值')`)
  check('W4 「去充值」按钮可点击', clicked === 'clicked', clicked)
  await new Promise((r) => setTimeout(r, 1600))

  const dlgTitle = await cdp.eval(
    `(() => { const d = document.querySelector('.el-dialog__title'); return d ? d.textContent.trim() : null })()`
  )
  check('W5 充值弹窗已打开', dlgTitle === '校园币充值', String(dlgTitle))

  const presetCnt = await cdp.eval(`document.querySelectorAll('.wr-presets .el-button').length`)
  check('W6 弹窗内有快捷档位按钮', Number(presetCnt) >= 4, `${presetCnt} 个`)

  const dlgBody = await cdp.eval(`(() => { const d=document.querySelector('.wr'); return d?d.innerText:'' })()`)
  console.log('  弹窗文案：' + String(dlgBody).replace(/\n+/g, ' | ').slice(0, 160))

  shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(OUT, '02-recharge-dialog.png'), Buffer.from(shot.data, 'base64'))
  console.log('  ✅ 02-recharge-dialog.png')

  cdp.ws.close()
  chrome.kill()

  const failed = results.filter((r) => !r.cond)
  console.log(`\n汇总：通过 ${results.length - failed.length} / ${results.length}`)
  console.log(`截图目录：${OUT}`)
  process.exit(failed.length ? 1 : 0)
})().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})
