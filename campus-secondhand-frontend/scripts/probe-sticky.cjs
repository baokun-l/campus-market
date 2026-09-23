/** 临时探针：实测后台侧栏 sticky 是否生效（node scripts/probe-sticky.cjs） */
const http = require('http')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const TARGET = 'http://127.0.0.1:7788'
const OUT = 'C:/wbtmp'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9341
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(d)) }).on('error', reject)
  })
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map()
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id)
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)) } }, 30000)
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error('eval 异常: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails))
    return r.result.value
  }
}

;(async () => {
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(OUT, 'probe-profile')}`.replace(/\//g, '\\'),
    '--no-first-run', '--disable-gpu', '--no-sandbox', 'about:blank'
  ], { stdio: 'ignore' })
  try {
    for (let i = 0; i < 50; i++) { try { await httpGet(`http://127.0.0.1:${PORT}/json/version`); break } catch { await sleep(300) } }
    const list = JSON.parse(await httpGet(`http://127.0.0.1:${PORT}/json/list`))
    const page = list.find((t) => t.type === 'page')
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
    const cdp = new CDP(ws)
    await cdp.send('Page.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })

    await cdp.send('Page.navigate', { url: `${TARGET}/` })
    await sleep(1600)
    await cdp.eval(`localStorage.setItem('c2c-user', JSON.stringify({token:'mock-token-admin'}))`)
    await cdp.send('Page.navigate', { url: `${TARGET}/admin?tab=goods` })
    await sleep(2600)

    const info = await cdp.eval(`(() => {
      const main = document.querySelector('.layout-main')
      const nav = document.querySelector('.admin-nav')
      if (!main || !nav) return { err: 'missing', main: !!main, nav: !!nav }
      const cs = getComputedStyle(nav)
      const before = nav.getBoundingClientRect().top
      main.scrollTop = 600
      return new Promise((r) => setTimeout(() => {
        const after = nav.getBoundingClientRect().top
        const card = document.querySelector('.page-card')
        // 逐层检查祖先：sticky 会被 transform / overflow / contain 破坏
        const chain = []
        let el = nav.parentElement
        while (el && el !== document.body) {
          const s = getComputedStyle(el)
          chain.push({
            cls: (el.className || el.tagName).toString().slice(0, 40),
            overflow: s.overflowY,
            transform: s.transform,
            willChange: s.willChange,
            contain: s.contain
          })
          el = el.parentElement
        }
        r({
          navTopBefore: before, navTopAfter: after,
          position: cs.position, top: cs.top, navH: nav.offsetHeight,
          mainScrollTop: main.scrollTop, mainScrollH: main.scrollHeight, mainClientH: main.clientHeight,
          chain
        })
      }, 400))
    })()`)
    console.log(JSON.stringify(info, null, 2))
  } finally { chrome.kill() }
})()
