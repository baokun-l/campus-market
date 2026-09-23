/**
 * 诊断：拉取页面真实 DOM + 已加载的 Home chunk 资源，确认加载的是新代码
 */
const http = require('http')
const { spawn } = require('child_process')

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9334
const TARGET = 'http://127.0.0.1:7788'

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(d)) }).on('error', reject)
  })
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map()
    ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data)
      if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id)
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result) } }) }
  send(method, params = {}) { const id = ++this.id
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)) } }, 15000) }) }
}

;(async () => {
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`,
    '--user-data-dir=C:\\wbtmp\\chrome-diag-profile', '--no-first-run', '--disable-gpu', '--no-sandbox',
    '--hide-scrollbars', '--disable-extensions', 'about:blank'], { stdio: 'ignore' })

  for (let i = 0; i < 40; i++) { try { await httpGet(`http://127.0.0.1:${PORT}/json/version`); break } catch { await new Promise(r => setTimeout(r, 300)) } }

  const list = JSON.parse(await httpGet(`http://127.0.0.1:${PORT}/json/list`))
  const page = list.find(t => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  const cdp = new CDP(ws)
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable')

  // 收集网络请求
  const reqs = []
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.method === 'Network.requestWillBeSent') reqs.push(m.params.request.url)
  })

  await cdp.send('Page.navigate', { url: `${TARGET}/login` })
  await new Promise(r => setTimeout(r, 1600))
  await cdp.send('Runtime.evaluate', { expression: `localStorage.setItem('c2c-user', JSON.stringify({token:'mock-token-user-1'}))` })

  reqs.length = 0
  await cdp.send('Page.navigate', { url: `${TARGET}/home` })
  await new Promise(r => setTimeout(r, 4200))

  const r = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      hasWrap: !!document.querySelector('.promo-wrap'),
      hasStatBar: !!document.querySelector('.stat-bar'),
      hasActions: !!document.querySelector('.promo-actions'),
      hasChips: !!document.querySelector('.promo-chips'),
      ctaText: document.querySelector('.promo-cta')?.textContent?.trim() || null,
      statBarCols: document.querySelector('.stat-bar') ? getComputedStyle(document.querySelector('.stat-bar')).gridTemplateColumns : null,
      promoHtml: (document.querySelector('.promo-wrap') || document.querySelector('.promo') || {outerHTML:'none'}).outerHTML.slice(0, 420)
    })`,
    returnByValue: true
  })
  console.log('=== DOM 探针 ===')
  console.log(JSON.stringify(JSON.parse(r.result.value), null, 2))
  console.log('\n=== 本次加载的 Home 相关资源 ===')
  console.log(reqs.filter(u => /Home|index-|\.css/.test(u)).join('\n'))

  ws.close(); chrome.kill(); process.exit(0)
})().catch(e => { console.error('FAILED:', e); process.exit(1) })
