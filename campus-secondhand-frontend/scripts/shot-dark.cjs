/** 深色全页截图（设置页 + 首页）：node scripts/shot-dark.cjs（一次性验证工具） */
const http = require('http')
const fs = require('fs')
const { spawn } = require('child_process')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const httpGet = (url) => new Promise((res, rej) => { http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(d)) }).on('error', rej) })
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9376

;(async () => {
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    '--user-data-dir=C:/wbtmp/darkshot-profile',
    '--no-first-run', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--window-size=1280,1000', 'about:blank'
  ], { stdio: 'ignore' })
  try {
    for (let i = 0; i < 60; i++) { try { await httpGet(`http://127.0.0.1:${PORT}/json/version`); break } catch { await sleep(300) } }
    const list = JSON.parse(await httpGet(`http://127.0.0.1:${PORT}/json/list`))
    const page = list.find((t) => t.type === 'page')
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
    let id = 0
    const pending = new Map()
    ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id) } })
    const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
    const evalJS = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.value
    const shot = async (name) => { const s = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(`C:/wbtmp/${name}`, Buffer.from(s.data, 'base64')) }
    await send('Page.enable'); await send('Runtime.enable')
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false })
    await send('Page.navigate', { url: 'http://127.0.0.1:7788/' }); await sleep(1800)
    await evalJS(`localStorage.setItem('c2c-user', JSON.stringify({token:'mock-token-admin'}))`)
    await send('Page.navigate', { url: 'http://127.0.0.1:7788/settings' }); await sleep(2200)
    // 走真实持久化链路：写 c2c-app.dark=true 后刷新，验证 applyPreferences 恢复
    await evalJS(`localStorage.setItem('c2c-app', JSON.stringify({settings:{fontSize:'standard',dark:true,accent:'blue',allowSearch:true,showOnline:true,personalizedAds:true,notifyTrade:true,notifySystem:true,notifyMarketing:false},sidebarCollapsed:false,cacheSize:128}))`)
    await send('Page.navigate', { url: 'http://127.0.0.1:7788/settings' }); await sleep(2400)
    const dark = await evalJS(`document.documentElement.classList.contains('dark')`)
    const asideBg = await evalJS(`getComputedStyle(document.querySelector('.layout-aside')).backgroundColor`)
    console.log('刷新后 dark 类（applyPreferences 恢复）:', dark, '｜ 侧栏:', asideBg)
    await shot('settings-dark-full-v2.png')
    await send('Page.navigate', { url: 'http://127.0.0.1:7788/home' }); await sleep(2600)
    await shot('home-dark-full-v2.png')
    console.log('shots done')
    ws.close()
  } finally { chrome.kill() }
})()
