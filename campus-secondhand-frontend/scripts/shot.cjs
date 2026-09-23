/**
 * CDP 截图 + 断言工具
 * 用法：node scripts/shot.cjs [--target=http://127.0.0.1:7788] [--out=C:/wbtmp] [--only=home] [--fresh]
 *   --fresh：截图前清掉本地业务存档（活动 / 购物车等），保证截图反映「出厂状态」。
 *            不加则沿用 profile 里已有的存档（便于刻意复现某个中间状态）。
 * 依赖：Node 22 内置 WebSocket + 本机 Chrome（--remote-debugging-port）
 */
const http = require('http')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const argv = process.argv.slice(2)
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`))
  return hit ? hit.split('=').slice(1).join('=') : d
}
const TARGET = arg('target', 'http://127.0.0.1:7788')
const OUT = arg('out', 'C:/wbtmp')
const ONLY = arg('only', '')
const FRESH = argv.includes('--fresh')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9333

/** 页面清单：route + 输出名 + 登录态（可选 click：点击的元素文字） */
const ALL_PAGES = [
  { path: '/home', name: 'home', token: 'mock-token-user-1', w: 1440, h: 1240, wait: 4200 },
  { path: '/home', name: 'home-narrow', token: 'mock-token-user-1', w: 900, h: 1100, wait: 3800 },
  { path: '/goods', name: 'goods', token: 'mock-token-user-1', w: 1440, h: 1400, wait: 3800 },
  { path: '/message', name: 'message', token: 'mock-token-user-1', w: 1440, h: 1000, wait: 3800 },
  { path: '/admin', name: 'admin-dash', token: 'mock-token-admin', w: 1440, h: 1320, wait: 4400 },
  { path: '/admin', name: 'admin-goods', token: 'mock-token-admin', w: 1440, h: 940, wait: 3800, click: '商品审核' },
  { path: '/admin', name: 'admin-users', token: 'mock-token-admin', w: 1440, h: 940, wait: 3800, click: '用户管理' },
  { path: '/admin', name: 'admin-orders', token: 'mock-token-admin', w: 1440, h: 1140, wait: 3800, click: '订单管理' },
  { path: '/admin', name: 'admin-notices', token: 'mock-token-admin', w: 1440, h: 900, wait: 3800, click: '公告管理' },
  { path: '/admin', name: 'admin-activity', token: 'mock-token-admin', w: 1440, h: 1140, wait: 3600, click: '活动管理' },
  { path: '/admin', name: 'admin-activity-new', token: 'mock-token-admin', w: 1440, h: 1140, wait: 3600, clicks: ['活动管理', '新建活动'] },
  { path: '/admin', name: 'admin-categories', token: 'mock-token-admin', w: 1440, h: 700, wait: 3800, click: '分类管理' },
  { path: '/admin', name: 'admin-content', token: 'mock-token-admin', w: 1440, h: 940, wait: 3800, click: '内容审核' },
  { path: '/admin', name: 'admin-reports', token: 'mock-token-admin', w: 1440, h: 900, wait: 3600, click: '举报处理' },
  { path: '/admin', name: 'admin-settings', token: 'mock-token-admin', w: 1440, h: 1020, wait: 3800, click: '系统设置' },
  { path: '/admin', name: 'admin-logs', token: 'mock-token-admin', w: 1440, h: 900, wait: 3800, clicks: ['系统设置', '操作日志'] },
  { path: '/admin', name: 'admin-export', token: 'mock-token-admin', w: 1440, h: 640, wait: 3800, clicks: ['系统设置', '数据导出'] },
  { path: '/admin', name: 'admin-dash-narrow', token: 'mock-token-admin', w: 820, h: 1500, wait: 4400 },
  { path: '/favorites', name: 'favorites', token: 'mock-token-user-1', w: 1440, h: 1100, wait: 3600 },
  { path: '/favorites', name: 'favorites-narrow', token: 'mock-token-user-1', w: 720, h: 1200, wait: 3600 },
  { path: '/notice', name: 'notice', token: 'mock-token-user-1', w: 1440, h: 900, wait: 3600 },
  { path: '/notice', name: 'notice-narrow', token: 'mock-token-user-1', w: 720, h: 1000, wait: 3600 },
  // 商品 1 默认就在收藏夹里，按钮文案是「已收藏」，点它反而会取消收藏，
  // 所以这里不点击，直接截「已收藏」态。
  { path: '/goods/1', name: 'detail-fav-on', token: 'mock-token-user-1', w: 1440, h: 1000, wait: 3600 },
  { path: '/goods/1', name: 'detail-cart-added', token: 'mock-token-user-1', w: 1440, h: 1000, wait: 3600, click: '加入购物车' },
  { path: '/goods/1', name: 'detail-interact', token: 'mock-token-user-1', w: 1440, h: 2000, wait: 4200 },
  // 商品 55 参与「卖家让利」活动：用于核对详情页的让利归属说明与划线价
  { path: '/goods/55', name: 'detail-promo', token: 'mock-token-user-1', w: 1440, h: 1000, wait: 3600 },
  // 购物车：靠上一张 detail-cart-added 加进去的那件商品渲染双价（必须排在它之后）
  { path: '/cart', name: 'cart', token: 'mock-token-user-1', w: 1440, h: 820, wait: 3600 },
  { path: '/goods/publish', name: 'publish', token: 'mock-token-user-1', w: 1440, h: 1180, wait: 3600 }
]
const PAGES = ONLY ? ALL_PAGES.filter((p) => p.name === ONLY) : ALL_PAGES

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = ''
      res.on('data', (c) => (d += c))
      res.on('end', () => resolve(d))
    }).on('error', reject)
  })
}

async function waitForEndpoint(retries = 50) {
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

/** 页面内点击辅助：优先匹配 tab 项 / 按钮的可点击祖先 */
const CLICK_HELPER = `
window.__clickByText = (t) => {
  const cands = [...document.querySelectorAll('.el-tabs__item, [role=tab], .el-button, button, a')];
  let hit = cands.find((n) => n.textContent.trim() === t);
  if (!hit) {
    const leaf = [...document.querySelectorAll('*')].find(
      (n) => n.children.length === 0 && n.textContent.trim() === t
    );
    hit = leaf ? (leaf.closest('.el-tabs__item, [role=tab], .el-button, button, a') || leaf) : null;
  }
  if (!hit) return 'not-found';
  hit.click();
  return 'clicked:' + (hit.className || hit.tagName);
};
'ready'`

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })

  try {
    const html = await httpGet(`${TARGET}/`)
    if (!html.includes('<div id="app">')) throw new Error('目标不是本项目 dist')
  } catch (e) {
    console.error('预览服务不可用：', e.message)
    process.exit(1)
  }

  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(OUT, 'chrome-shot-profile')}`.replace(/\//g, '\\'),
    '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--disable-extensions',
    'about:blank'
  ], { stdio: 'ignore' })

  const version = await waitForEndpoint()
  console.log('Chrome:', version['Browser'])

  const cdp = await connect()
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')

  for (const p of PAGES) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: p.w, height: p.h, deviceScaleFactor: 1, mobile: false
    })

    // 1) 同源写登录态
    await cdp.send('Page.navigate', { url: `${TARGET}/login` })
    await new Promise((r) => setTimeout(r, 1700))
    await cdp.eval(`localStorage.setItem('c2c-user', JSON.stringify({token:'${p.token}'}));'ok'`)
    // --fresh：清掉本地业务存档，让截图反映出厂状态（否则会带上上一轮的改动）
    if (FRESH) {
      await cdp.eval(
        `['c2c-activity','c2c-activities','c2c-cart','c2c-reports','c2c-comments','c2c-reviews','c2c-audit-logs','c2c-settings']` +
        `.forEach((k)=>localStorage.removeItem(k));'ok'`
      )
    }

    // 2) 目标路由
    await cdp.send('Page.navigate', { url: `${TARGET}${p.path}` })
    await new Promise((r) => setTimeout(r, p.wait))

    // 3) 可选点击（clicks 数组支持多步，如「先切页签 → 再开弹窗」）
    const steps = p.clicks || (p.click ? [p.click] : [])
    if (steps.length) {
      await cdp.eval(CLICK_HELPER)
      for (const step of steps) {
        const res = await cdp.eval(`window.__clickByText(${JSON.stringify(step)})`)
        console.log(`   click("${step}") → ${res}`)
        await new Promise((r) => setTimeout(r, 1200))
      }
    }

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const file = path.join(OUT, `${p.name}.png`)
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
    console.log(`✅ ${p.path} → ${file}`)
  }

  cdp.ws.close()
  chrome.kill()
  console.log('done')
  process.exit(0)
})().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})
