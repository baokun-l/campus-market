/**
 * 放大截图工具：对页面的某个区域做 Nx 缩放截图，用于核对细节
 * 用法：node scripts/zoom.cjs <page> <click1,click2> <x> <y> <w> <h> <outName> [scale=3]
 * 例：node scripts/zoom.cjs /admin 系统设置 640 240 420 120 zoom-settings.png
 *     node scripts/zoom.cjs /admin 内容审核 1360 330 60 60 zoom-x.png 8
 */
const http = require('http')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const TARGET = 'http://127.0.0.1:7788'
const OUT = 'C:/wbtmp'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9339
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const httpGet = (url) =>
  new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(d)) }).on('error', reject)
  })

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map()
    ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data)
      if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id)
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result) } }) }
  send(method, params = {}) { const id = ++this.id
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout')) } }, 25000) }) }
  async eval(e) { const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); return r.result.value }
}

const [page = '/admin', clicks = '', x = '0', y = '0', w = '400', h = '200', out = 'zoom.png', scale = '3'] = process.argv.slice(2)

;(async () => {
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(OUT, 'chrome-zoom-profile')}`.replace(/\//g, '\\'),
    '--no-first-run', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--disable-extensions', 'about:blank'], { stdio: 'ignore' })
  for (let i = 0; i < 50; i++) { try { await httpGet(`http://127.0.0.1:${PORT}/json/version`); break } catch { await sleep(300) } }
  const list = JSON.parse(await httpGet(`http://127.0.0.1:${PORT}/json/list`))
  const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  const cdp = new CDP(ws)
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })

  await cdp.send('Page.navigate', { url: `${TARGET}/login` }); await sleep(1600)
  await cdp.eval(`localStorage.setItem('c2c-user', JSON.stringify({token:'mock-token-admin'}));'ok'`)
  await cdp.send('Page.navigate', { url: `${TARGET}${page}` }); await sleep(4200)

  const CLICK_HELPER = `
window.__zoomClick = (t) => {
  const nav = [...document.querySelectorAll('.nav-item')].find((b) => b.querySelector('.nav-label')?.textContent.trim() === t);
  if (nav) { nav.click(); return 'nav:' + t; }
  const cands = [...document.querySelectorAll('.el-tabs__item, [role=tab], .el-button, button, a')];
  let hit = cands.find((n) => n.textContent.trim() === t);
  if (!hit) {
    const leaf = [...document.querySelectorAll('*')].find((n) => n.children.length === 0 && n.textContent.trim() === t);
    hit = leaf ? (leaf.closest('.el-tabs__item, [role=tab], .el-button, button, a') || leaf) : null;
  }
  if (!hit) return 'not-found:' + t;
  hit.click();
  return 'clicked:' + t;
};
'ready'`
  await cdp.eval(CLICK_HELPER)

  for (const label of clicks.split(',').map((s) => s.trim()).filter(Boolean)) {
    console.log('  click →', await cdp.eval(`window.__zoomClick(${JSON.stringify(label)})`))
    await sleep(1400)
  }

  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: Number(x), y: Number(y), width: Number(w), height: Number(h), scale: Number(scale) }
  })
  fs.writeFileSync(path.join(OUT, out), Buffer.from(shot.data, 'base64'))
  console.log('→', path.join(OUT, out))
  ws.close(); chrome.kill(); process.exit(0)
})().catch((e) => { console.error('FAILED:', e); process.exit(1) })
