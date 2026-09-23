/**
 * 禁用态「薄纱」浓度梯度对照（node scripts/swatch-disabled.cjs）
 * 生成一张候选色板截图，用于人工挑选「灰纱蒙在橙上」的落点。
 *
 * 唯一变量 = 纱的不透明度。灰一律取中性（R=G=B=104），
 * 所以**无论浓淡，合成色相都钉在 24.9°**（= 品牌橙的色相），只有彩度与明度跟着变。
 * 渐变方向就是「从压住 → 到蒙一层薄纱」。
 */

/** 实心款：底 = 品牌橙，纱 = 中性灰（background-image 叠在 background-color 上） */
const SOLID = [
  { k: '上一版 38%（对照）', veil: 'rgba(104,104,104,.38)', color: '#fff' },
  { k: 'A 30% 还偏实', veil: 'rgba(104,104,104,.30)', color: '#fff' },
  { k: 'B 26%', veil: 'rgba(104,104,104,.26)', color: '#fff' },
  { k: 'C 24% ← 当前', veil: 'rgba(104,104,104,.24)', color: '#fff', cur: true },
  { k: 'D 20%', veil: 'rgba(104,104,104,.20)', color: '#fff' },
  { k: 'E 16% 更透', veil: 'rgba(104,104,104,.16)', color: '#fff' },
  { k: 'F 12% 近原色', veil: 'rgba(104,104,104,.12)', color: '#fff' }
]
/** 描边款：底 = 近白，纱 = 极薄中性灰；字/边 = 「压暗的橙」 */
const OUTLINE = [
  { k: '上一版 10%（对照）', veil: 'rgba(104,104,104,.10)', color: '#b1510f', line: '#c26f38' },
  { k: 'a 8%', veil: 'rgba(104,104,104,.08)', color: '#b1510f', line: '#c26f38' },
  { k: 'b 6% ← 当前', veil: 'rgba(104,104,104,.06)', color: '#b1510f', line: '#c26f38', cur: true },
  { k: 'c 4%', veil: 'rgba(104,104,104,.04)', color: '#b1510f', line: '#c26f38' },
  { k: 'd 2% 几乎无色', veil: 'rgba(104,104,104,.02)', color: '#b1510f', line: '#c26f38' }
]

function btnSolid(v) {
  return `<div class="col${v.cur ? ' cur' : ''}">
    <div class="cap">${v.k}</div>
    <button class="b solid" style="background-color:#ff6a00;background-image:linear-gradient(${v.veil},${v.veil});color:${v.color};box-shadow:inset 0 0 0 1.5px rgba(255,106,0,.3)">
      <span class="ico">🛒</span> 立即购买
    </button>
  </div>`
}
function btnOutline(v) {
  return `<div class="col${v.cur ? ' cur' : ''}">
    <div class="cap">${v.k}</div>
    <button class="b outline" style="background-color:#fff;background-image:linear-gradient(${v.veil},${v.veil});color:${v.color};border-color:${v.line}">
      <span class="ico">🛒</span> 加入购物车
    </button>
  </div>`
}

const http = require('http')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const OUT = 'C:/wbtmp'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9346
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const httpGet = (url) =>
  new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(d)) }).on('error', reject)
  })

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin:0; padding:20px; background:#fff; font-family:"Microsoft YaHei",system-ui,sans-serif; }
  h3 { margin:4px 0 10px; font-size:13px; color:#1f2329; }
  .row { display:flex; gap:14px; align-items:flex-end; margin-bottom:22px; flex-wrap:wrap; }
  .col { display:flex; flex-direction:column; gap:5px; }
  .col.cur { padding:8px; margin:-8px; border:1.5px dashed #ff6a00; border-radius:8px; }
  .cap { font-size:11px; color:#646a73; }
  .b { height:48px; min-width:150px; padding:0 18px; border:none; border-radius:4px;
       font-size:15px; font-weight:600; display:inline-flex; align-items:center; justify-content:center; gap:6px;
       font-family:inherit; }
  .b.outline { border:1.5px solid; }
  .ref { display:inline-flex; gap:10px; margin-bottom:18px; }
</style></head><body>
  <h3>基准：可用态（对照 —— 禁用态要能一眼看出「同一个按钮、能量被抽掉」）</h3>
  <div class="row">
    <div class="col"><div class="cap">可用 · 描边款</div>
      <button class="b outline" style="background:#fff;color:#ff6a00;border-color:#ff6a00"><span class="ico">🛒</span> 加入购物车</button></div>
    <div class="col"><div class="cap">可用 · 实心款</div>
      <button class="b solid" style="background:#ff6a00;color:#fff"><span class="ico">🛒</span> 立即购买</button></div>
  </div>
  <h3>实心款（立即购买）薄纱梯度：底 = 品牌橙 #ff6a00，上层 = 中性灰纱（R=G=B → 色相恒为 24.9°）</h3>
  <div class="row">${SOLID.map(btnSolid).join('')}</div>
  <h3>描边款（加入购物车）薄纱梯度：底 = 近白，字 #b1510f / 边 #c26f38</h3>
  <div class="row">${OUTLINE.map(btnOutline).join('')}</div>
</body></html>`

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, 'swatch.html'), HTML, 'utf8')
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(OUT, 'swatch-profile')}`.replace(/\//g, '\\'),
    '--no-first-run', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--allow-file-access-from-files', 'about:blank'
  ], { stdio: 'ignore' })
  try {
    for (let i = 0; i < 50; i++) { try { await httpGet(`http://127.0.0.1:${PORT}/json/version`); break } catch { await sleep(300) } }
    const list = JSON.parse(await httpGet(`http://127.0.0.1:${PORT}/json/list`))
    const ws = new WebSocket(list.find((t) => t.type === 'page').webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
    let id = 0
    const pending = new Map()
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p.resolve(m.result) }
    })
    const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, { resolve: res }); ws.send(JSON.stringify({ id: i, method, params })) })
    await send('Page.enable')
    await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 760, deviceScaleFactor: 2, mobile: false })
    await send('Page.navigate', { url: 'file:///' + path.join(OUT, 'swatch.html').replace(/\\/g, '/') })
    await sleep(1200)
    const s = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
    fs.writeFileSync(path.join(OUT, 'swatch-disabled.png'), Buffer.from(s.data, 'base64'))
    console.log('→', path.join(OUT, 'swatch-disabled.png'))
  } catch (e) {
    console.error('FAILED', e)
  } finally {
    chrome.kill()
  }
})()
