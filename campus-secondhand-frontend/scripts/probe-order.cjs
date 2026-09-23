/** 临时验证：订单详情抽屉 + 我的发布商品详情（node scripts/probe-order.cjs） */
const http = require('http')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const TARGET = 'http://127.0.0.1:7788'
const OUT = 'C:/wbtmp'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9342
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(d)) }).on('error', reject)
  })
}

;(async () => {
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(OUT, 'probe-order-profile')}`.replace(/\//g, '\\'),
    '--no-first-run', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', 'about:blank'
  ], { stdio: 'ignore' })
  try {
    for (let i = 0; i < 50; i++) { try { await httpGet(`http://127.0.0.1:${PORT}/json/version`); break } catch { await sleep(300) } }
    const list = JSON.parse(await httpGet(`http://127.0.0.1:${PORT}/json/list`))
    const page = list.find((t) => t.type === 'page')
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
    let id = 0
    const pending = new Map()
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p.resolve(m.result) }
    })
    const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, { resolve: res }); ws.send(JSON.stringify({ id: i, method, params })) })
    const evalJS = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value
    const shot = async (name) => {
      const s = await send('Page.captureScreenshot', { format: 'png' })
      fs.writeFileSync(`${OUT}/${name}`, Buffer.from(s.data, 'base64'))
      console.log('shot ->', name)
    }

    await send('Page.enable')
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
    await send('Page.navigate', { url: `${TARGET}/` })
    await sleep(1500)
    await evalJS(`localStorage.setItem('c2c-user', JSON.stringify({token:'mock-token-user-1'}))`)

    // ① 订单详情抽屉
    await send('Page.navigate', { url: `${TARGET}/order` })
    await sleep(2600)
    await evalJS(`(() => { const b=[...document.querySelectorAll('.el-button')].find(x=>x.textContent.trim()==='详情'); if(!b) return 'no-btn'; b.click(); return 'ok' })()`)
    await sleep(1200)
    const info = await evalJS(`JSON.stringify({
      drawer: !!document.querySelector('.od'),
      kv: [...document.querySelectorAll('.od-kv')].length,
      tl: [...document.querySelectorAll('.od-timeline li')].length,
      hasFormula: /恒等式/.test(document.querySelector('.od')?.textContent || ''),
      hasGoods: !!document.querySelector('.od-goods')
    })`)
    console.log('订单抽屉:', info)
    await shot('order-detail-drawer.png')

    // ② 我的发布 → 查看详情（id 9000）
    await send('Page.navigate', { url: `${TARGET}/goods/9000` })
    await sleep(2600)
    const d = await evalJS(`JSON.stringify({
      title: (document.querySelector('.detail-page h1, .gd-name, .info-r h1, h1')?.textContent || '').trim().slice(0, 30) || null,
      notFound: /找不到|不存在/.test(document.body.textContent.slice(0, 3000)),
      hasBack: !!document.querySelector('.back-btn')
    })`)
    console.log('我的发布详情:', d)
    await shot('my-goods-9000.png')

    // ③ 公告页返回键
    await send('Page.navigate', { url: `${TARGET}/notice` })
    await sleep(2000)
    console.log('公告页返回键:', await evalJS(`!!document.querySelector('.notice-page .back-btn')`))
  } finally { chrome.kill() }
})()
