/**
 * zoom × 弹层错位诊断 v2（node scripts/diag-zoom-popper.cjs）
 * ① 设置页：字号行已是 el-segmented（无 Popper），点「特大」验证 zoom 生效 + 截图看排版；
 * ② 商品列表：特大档下打开排序 el-select，量化弹层与输入框的视口偏差（遗留问题取证）。
 */
const http = require('http')
const fs = require('fs')
const { spawn } = require('child_process')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const httpGet = (url) => new Promise((res, rej) => { http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(d)) }).on('error', rej) })
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9377

;(async () => {
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    '--user-data-dir=C:/wbtmp/zoomdiag-profile',
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
    await send('Page.navigate', { url: 'http://127.0.0.1:7788/' }); await sleep(1600)
    await evalJS(`localStorage.setItem('c2c-user', JSON.stringify({token:'mock-token-user-1'}))`)
    await evalJS(`localStorage.removeItem('c2c-app')`)
    await send('Page.navigate', { url: 'http://127.0.0.1:7788/settings' }); await sleep(2200)

    /* ① 字号分段选择器：点「特大」→ zoom 生效 + 弹层无关 */
    const seg = await evalJS(`(function(){
      const row=[...document.querySelectorAll('.settings-page .settings-item')].find(function(r){
        const l=r.querySelector('.item-label'); return l && l.innerText.trim()==='字号大小';
      });
      const items=[...row.querySelectorAll('.el-segmented__item')];
      const t=items.find(function(i){ return i.innerText.trim()==='特大' });
      if(!t) return 'no-segment: ' + items.length;
      t.scrollIntoView({block:'center'});
      t.click();
      return 'picked';
    })()`)
    await sleep(700)
    const fontState = await evalJS(`JSON.stringify({
      zoom: getComputedStyle(document.body).zoom,
      root: document.documentElement.style.fontSize,
      dataFont: document.documentElement.dataset.font
    })`)
    console.log('分段选择器：', seg, '｜', fontState)
    await shot('settings-xlarge-segmented.png')

    /* ② 商品列表排序 el-select 在特大档下的弹层偏差（取证） */
    await send('Page.navigate', { url: 'http://127.0.0.1:7788/goods' }); await sleep(2400)
    const openSel = await evalJS(`(function(){
      const sel=document.querySelector('.el-select');
      if(!sel) return 'no-select';
      sel.scrollIntoView({block:'center'});
      sel.querySelector('.el-select__wrapper').dispatchEvent(new MouseEvent('click',{bubbles:true}));
      return 'clicked';
    })()`)
    await sleep(900)
    const m = await evalJS(`(function(){
      const sel=document.querySelector('.el-select');
      const r=sel.getBoundingClientRect();
      const p=[...document.querySelectorAll('.el-select__popper')].find(function(x){ return x.getBoundingClientRect().width>0 });
      if(!p) return JSON.stringify({ openSel, popper: null });
      const pr=p.getBoundingClientRect();
      return JSON.stringify({
        trigger: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) },
        popper: { x: Math.round(pr.x), y: Math.round(pr.y), w: Math.round(pr.width) },
        dx: Math.round(pr.x - r.x),
        dy: Math.round(pr.y - (r.y + r.height))
      });
    })()`)
    console.log('特大档 el-select 排序弹层：', m)
    await shot('goods-xlarge-select.png')
    ws.close()
  } finally { chrome.kill() }
})()
