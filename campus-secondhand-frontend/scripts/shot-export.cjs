/**
 * 管理后台「导出当前筛选」真机验证（CDP 驱动，不 mock）。
 *
 * 背景：这个按钮曾经稳定报「服务器内部错误，请稍后再试」。
 * 根因是 OrderMapper.xml 的 selectAdminOrdersForExport 写了 `LIMIT #{pageSize}`，
 * 而该语句对应的方法签名是 @Param("query") —— 可用名只有 [query, param1]，
 * 于是抛 BindingException，被 GlobalExceptionHandler 兜底脱敏成了那句无信息量的 500。
 *
 * 本脚本走真实链路：真浏览器 → 真实登录拿 HttpOnly Cookie → 打开订单面板 →
 * **点击按钮** → 监听 /admin/orders/export 的响应 → 验证 CSV 真的落盘。
 * 关键在于它是"点按钮"，而不是直接打接口 —— 前者能同时证明：
 *   · 按钮的 disabled/loading 状态没把请求挡掉；
 *   · 前端 buildQuery() 序列化出来的参数后端真的收得下；
 *   · 界面不会把失败静默掉。
 *
 * 用法：node scripts/shot-export.cjs [--target=http://127.0.0.1:5173] [--out=C:/wbtmp/export-shots]
 */
const fs = require('fs')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')

const argv = process.argv.slice(2)
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`))
  return hit ? hit.split('=').slice(1).join('=') : d
}
const TARGET = arg('target', 'http://127.0.0.1:5173')
const OUT = arg('out', 'C:/wbtmp/export-shots')
const API = arg('api', 'http://127.0.0.1:8080/api')
const USER = arg('user', 'admin')
const PASS = arg('pass', 'admin123')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9336

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

async function waitForEndpoint(retries = 60) {
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

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  // 清掉上一轮的下载，避免把旧 CSV 误当成本次产物
  for (const f of fs.readdirSync(OUT)) {
    if (f.endsWith('.csv')) fs.unlinkSync(path.join(OUT, f))
  }

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
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: OUT.replace(/\//g, '\\') })

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false
  })

  await cdp.send('Page.navigate', { url: `${TARGET}/login` })
  await new Promise((r) => setTimeout(r, 2000))

  const set = await cdp.send('Network.setCookie', {
    name: 'c2c-token', value: token, url: `${TARGET}/`, httpOnly: true
  })
  check('E0 登录票据已注入 HttpOnly Cookie', Boolean(set.success))

  // 前端读不到 HttpOnly Cookie，isLoggedIn 的唯一来源是这个不含凭据的布尔
  const hint = await cdp.eval(
    `localStorage.setItem('c2c-user', JSON.stringify({token:'',sessionHint:true}));'ok'`
  )
  check('E0b 已补 sessionHint（否则会被路由守卫弹回登录页）', hint === 'ok')

  /*
   * 监听导出请求的响应。这一层能证明「后端到底回了什么」，
   * 而不是只看页面上有没有弹红条 —— 万一前端把失败吞了，只看界面是查不出来的。
   */
  const exportCalls = []
  cdp.ws.addEventListener('message', (ev) => {
    let m
    try { m = JSON.parse(ev.data) } catch { return }
    if (m.method === 'Network.responseReceived' && m.params?.response?.url?.includes('/admin/orders/export')) {
      exportCalls.push({ requestId: m.params.requestId, status: m.params.response.status })
    }
    if (m.method === 'Network.loadingFailed') {
      exportCalls.push({ requestId: m.params.requestId, failed: m.params.errorText })
    }
  })

  // ---- 打开管理后台的订单面板 ----
  await cdp.send('Page.navigate', { url: `${TARGET}/admin?tab=orders` })
  await new Promise((r) => setTimeout(r, 5000))

  const onOrders = await cdp.eval(`document.body.innerText.includes('导出当前筛选')`)
  check('E1 订单管理面板已打开', onOrders === true)

  const beforeErr = await cdp.eval(
    `document.querySelectorAll('.el-message--error').length`
  )
  check('E2 点击前页面无错误提示', beforeErr === 0, `error 提示数=${beforeErr}`)

  // ---- 真实点击「导出当前筛选」 ----
  const clicked = await cdp.eval(`
    (() => {
      const btn = [...document.querySelectorAll('.el-button,button')]
        .find((b) => b.textContent.replace(/\\s/g,'').includes('导出当前筛选'));
      if (!btn) return 'not-found';
      if (btn.disabled || btn.classList.contains('is-disabled')) return 'disabled';
      btn.click();
      return 'clicked';
    })()
  `)
  check('E3 「导出当前筛选」按钮可点击并已点击', clicked === 'clicked', clicked)

  await new Promise((r) => setTimeout(r, 4000))

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(OUT, '01-orders-export.png'), Buffer.from(shot.data, 'base64'))
  console.log('  ✅ 01-orders-export.png')

  // ---- 断言 ----
  const okCalls = exportCalls.filter((c) => c.status === 200)
  const failedCalls = exportCalls.filter((c) => c.failed)
  check('E4 确实发出了 /admin/orders/export 请求', exportCalls.length > 0,
        `捕获 ${exportCalls.length} 次`)

  let bodyCode = null
  if (okCalls.length) {
    try {
      const b = await cdp.send('Network.getResponseBody', { requestId: okCalls[0].requestId })
      const parsed = JSON.parse(b.body)
      bodyCode = parsed.code
      const rows = Array.isArray(parsed.data) ? parsed.data.length : -1
      check('E5 导出接口返回 code=0（不再是 500）', parsed.code === 0, `code=${parsed.code} 行数=${rows}`)
    } catch (e) {
      check('E5 导出接口返回 code=0（不再是 500）', false, '读取响应体失败: ' + e.message)
    }
  } else {
    check('E5 导出接口返回 code=0（不再是 500）', false, '没有成功的响应')
  }

  check('E6 网络层无加载失败', failedCalls.length === 0, JSON.stringify(failedCalls))

  const afterErrText = await cdp.eval(`
    [...document.querySelectorAll('.el-message--error')].map(n => n.textContent.trim()).join(' | ')
  `)
  check('E7 界面未出现「服务器内部错误」', !String(afterErrText).includes('服务器内部错误'),
        String(afterErrText) || '(无错误提示)')

  const csvs = fs.readdirSync(OUT).filter((f) => f.endsWith('.csv'))
  const csvSize = csvs.length ? fs.statSync(path.join(OUT, csvs[0])).size : 0
  check('E8 CSV 文件真的落盘了', csvs.length > 0 && csvSize > 0,
        csvs.length ? `${csvs[0]} (${csvSize} 字节)` : '没有 csv')

  if (csvs.length) {
    const head = fs.readFileSync(path.join(OUT, csvs[0]), 'utf8').split('\n').slice(0, 3)
    console.log('\n  CSV 前 3 行：')
    head.forEach((l) => console.log('    ' + l.slice(0, 110)))
  }

  chrome.kill()
  const passed = results.filter((r) => r.cond).length
  console.log(`\n汇总：通过 ${passed} / ${results.length}`)
  console.log(`截图目录：${OUT}`)
  process.exit(passed === results.length ? 0 : 1)
})().catch((e) => {
  console.error('执行失败:', e.message)
  process.exit(1)
})
