/** 临时验证：已售商品置灰 + 他人主页 + 评价锁定（node scripts/probe-r17.cjs） */
const http = require('http')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const TARGET = 'http://127.0.0.1:7788'
const OUT = 'C:/wbtmp'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9343
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(d)) }).on('error', reject)
  })
}

;(async () => {
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(OUT, 'probe-r17-profile')}`.replace(/\//g, '\\'),
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

    // ① 已售出商品详情：按钮置灰 + 文案 + 卖家链接
    const soldId = await evalJS(`(function(){
      const ls = JSON.parse(localStorage.getItem('c2c-goods-extra') || '[]');
      return 'seed';
    })()`)
    // 直接找一件已售出商品：先从商品广场拿
    await send('Page.navigate', { url: `${TARGET}/goods` })
    await sleep(2400)
    const sold = await evalJS(`(function(){
      const links = [...document.querySelectorAll('a[href^="/goods/"]')];
      const badge = links.find((a) => a.querySelector('.is-sold'));
      if (!badge) return null;
      return badge.getAttribute('href');
    })()`)
    console.log('已售商品链接:', sold)
    if (sold) {
      await send('Page.navigate', { url: TARGET + sold })
      await sleep(2400)
      const st = await evalJS(`(function(){
        const pick = (sel) => { const b = document.querySelector(sel); if (!b) return null; const s = getComputedStyle(b); return { disabled: b.disabled, bg: s.backgroundColor, color: s.color }; };
        return JSON.stringify({
          flag: document.querySelector('.img-flag')?.textContent?.trim() || null,
          facts: [...document.querySelectorAll('.facts li')].map((li) => li.textContent.replace(/\\s+/g, ' ').trim()).join(' | '),
          cart: pick('.btn-cart'),
          buy: pick('.btn-brand'),
          sellerLink: !!document.querySelector('.seller-link'),
          reason: document.querySelector('.buy-block')?.textContent?.replace(/\\s+/g, ' ').trim() || null
        });
      })()`)
      console.log('已售商品详情:', st)
      await shot('r17-sold-detail.png')
    }

    // ② 卖家可点 → 他人主页
    await evalJS(`document.querySelector('.seller-link')?.click()`)
    await sleep(2200)
    const up = await evalJS(`JSON.stringify({
      url: location.pathname,
      name: document.querySelector('.up-name')?.textContent?.trim() || null,
      credit: document.querySelector('.up-credit')?.textContent?.trim() || null,
      goodsCards: document.querySelectorAll('.up-grid a').length,
      reviews: document.querySelectorAll('.up-review').length,
      hasHead: !!document.querySelector('.up-head')
    })`)
    console.log('他人主页:', up)
    await shot('r17-public-profile.png')

    // ③ 订单中心：已评价锁定
    await send('Page.navigate', { url: `${TARGET}/order` })
    await sleep(2400)
    const ord = await evalJS(`JSON.stringify({
      reviewedTags: [...document.querySelectorAll('.reviewed-tag')].length,
      reviewBtns: [...document.querySelectorAll('.el-table__body button')].filter((b) => b.textContent.trim() === '评价').length,
      userLinks: document.querySelectorAll('.od-user').length
    })`)
    console.log('订单评价锁定:', ord)
    await shot('r17-order-review-lock.png')
  } finally { chrome.kill() }
})()
