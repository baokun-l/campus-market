/**
 * 管理后台「系统设置」页真机验证（CDP 驱动，不 mock）。
 *
 * 守的是「接线状态标注」这一类问题：界面告诉管理员的
 * 「已生效 / 仅本页估算 / 未启用」，必须与后端真实行为一致。
 *
 * 真实案例：autoOfflineDays 曾被标成「未启用」+ 提示「尚无定时任务执行下架」，
 * 而后端 GoodsOfflineJob 每天 03:30 真在读这一列批量下架 ——
 * 管理员以为改了没用、实际它每天都在跑，预期与实际正好相反。
 *
 * 本脚本断言：该行必须标「已生效」，且提示文案要说清执行时机。
 *
 * 用法：node scripts/shot-admin-settings.cjs [--target=http://127.0.0.1:5173]
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
const OUT = arg('out', 'C:/wbtmp/admin-settings-shots')
const API = arg('api', 'http://127.0.0.1:8080/api')
const USER = arg('user', 'admin')
const PASS = arg('pass', 'admin123')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9338

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

function login() {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ username: USER, password: PASS })
    const req = http.request(`${API}/user/login`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let d = ''
        res.on('data', (c) => (d += c))
        res.on('end', () => {
          try {
            const j = JSON.parse(d)
            j.code === 0 ? resolve(j.data.token) : reject(new Error('登录失败'))
          } catch (e) { reject(e) }
        })
      })
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
  const token = await login()
  console.log(`已用 ${USER} 登录，票据长度 ${token.length}`)

  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(OUT, 'chrome-profile').replace(/\//g, '\\')}`,
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
    width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false
  })

  await cdp.send('Page.navigate', { url: `${TARGET}/login` })
  await new Promise((r) => setTimeout(r, 2000))

  const set = await cdp.send('Network.setCookie', {
    name: 'c2c-token', value: token, url: `${TARGET}/`, httpOnly: true
  })
  check('S0 登录票据已注入 HttpOnly Cookie', Boolean(set.success))

  await cdp.eval(`localStorage.setItem('c2c-user', JSON.stringify({token:'',sessionHint:true}));'ok'`)

  await cdp.send('Page.navigate', { url: `${TARGET}/admin?tab=settings` })
  await new Promise((r) => setTimeout(r, 6000))

  const hasRow = await cdp.eval(`document.body.innerText.includes('自动下架天数')`)
  check('S1 系统设置页出现「自动下架天数」', hasRow === true)

  /*
   * 抓「自动下架天数」这一行附近的文本。
   * 用 closest('.el-form-item') 定位到该控件所在的表单项容器，
   * 这样拿到的就是这一行自己的标签与提示，不会混进邻居的。
   */
  const rowText = await cdp.eval(`
    (() => {
      const labels = [...document.querySelectorAll('.el-form-item__label, label')];
      const hit = labels.find((l) => l.textContent.includes('自动下架天数'));
      if (!hit) return null;
      const item = hit.closest('.el-form-item') || hit.parentElement;
      return item ? item.innerText.replace(/\\s+/g, ' ').trim() : null;
    })()
  `)
  console.log('  该行文本:', rowText)

  check('S2 该行显示「已生效」（原为「未启用」）',
        rowText !== null && rowText.includes('已生效'),
        rowText === null ? '没找到该行' : rowText.slice(0, 90))
  check('S3 该行不再出现「尚无定时任务执行下架」这句过时提示',
        rowText !== null && !rowText.includes('尚无定时任务'),
        '')
  check('S4 提示文案说清了执行时机（03:30）',
        rowText !== null && rowText.includes('03:30'),
        '')

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(OUT, '01-admin-settings.png'), Buffer.from(shot.data, 'base64'))
  console.log('  ✅ 01-admin-settings.png')

  chrome.kill()
  const passed = results.filter((r) => r.cond).length
  console.log(`\n汇总：通过 ${passed} / ${results.length}`)
  process.exit(passed === results.length ? 0 : 1)
})().catch((e) => {
  console.error('执行失败:', e.message)
  process.exit(1)
})
