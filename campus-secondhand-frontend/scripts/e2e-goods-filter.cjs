/**
 * 验证：商品广场的筛选状态是否跟随 URL query 变化
 *
 * 场景（用户报的问题）：
 *  ① 首页点「教材」→ /goods?categoryId=1，列表筛出教材
 *  ② 再点侧栏「商品广场」（/goods，无 query）→ Vue Router 复用同一组件，
 *     旧实现不会重置 categoryId，导致「全部」点了还停在教材
 * 断言：步②之后分类下拉应为空、且列表条数 > 单一分类的条数
 *
 * 用法：node scripts/e2e-goods-filter.cjs
 */
const http = require('http')
const { spawn } = require('child_process')

const TARGET = process.env.TARGET || 'http://127.0.0.1:7788'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9334
const USER_DATA = 'C:\\wbtmp\\cdp-goods-filter'

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = ''
      res.on('data', (c) => (d += c))
      res.on('end', () => resolve(d))
    }).on('error', reject)
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitForEndpoint(retries = 60) {
  for (let i = 0; i < retries; i++) {
    try {
      const v = await httpGet(`http://127.0.0.1:${PORT}/json/version`)
      if (v) return JSON.parse(v)
    } catch { /* retry */ }
    await sleep(300)
  }
  throw new Error('Chrome CDP 未就绪')
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
    if (r.exceptionDetails) {
      const d = r.exceptionDetails
      throw new Error(`${d.text || 'eval error'} :: ${d.exception?.description || ''}`)
    }
    return r.result?.value
  }
}

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? '  → ' + detail : ''}`)
}

;(async () => {
  const proc = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${USER_DATA}`,
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--window-size=1440,1000',
    'about:blank'
  ], { detached: true, stdio: 'ignore' })

  try {
    await waitForEndpoint()
    // 新版 Chrome 的 /json/new 仅支持 PUT，改为复用启动时的 about:blank 标签页
    const tabs = JSON.parse(await httpGet(`http://127.0.0.1:${PORT}/json/list`))
    const page = tabs.find((t) => t.type === 'page')
    if (!page) throw new Error('未找到可用的页面标签页')
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((r) => ws.addEventListener('open', r))
    const cdp = new CDP(ws)
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')

    // 先落到目标站点，才能写 localStorage（about:blank 无 origin 会抛 SecurityError）
    await cdp.send('Page.navigate', { url: TARGET + '/login' })
    await sleep(2000)
    await cdp.evaluate(`localStorage.setItem('c2c-user', JSON.stringify({ token: 'mock-token-user-1' }))`)
    await cdp.send('Page.navigate', { url: TARGET + '/home' })
    await sleep(4000)

    // ---- 步① 首页点「教材」分类 ----
    const clickedCat = await cdp.evaluate(`(() => {
      const el = [...document.querySelectorAll('.cat-item')].find(a => a.textContent.includes('教材'));
      if (!el) return 'not-found';
      el.click();
      return el.getAttribute('href') || 'clicked';
    })()`)
    await sleep(2500)

    const afterCat = await cdp.evaluate(`(() => {
      const sels = [...document.querySelectorAll('.filter-bar .el-select')].map(s => s.innerText.replace(/\\n/g, '|').trim());
      const cards = document.querySelectorAll('.goods-card').length;
      const total = (document.querySelector('.el-pagination__total')?.textContent || '').trim();
      return { url: location.pathname + location.search, selectTexts: sels, cards, total };
    })()`)
    check('① 点分类后 URL 带 categoryId', /categoryId=\d+/.test(afterCat.url), afterCat.url)
    check('① 分类下拉显示「教材」', afterCat.selectTexts.some((t) => t.includes('教材')), afterCat.selectTexts.join(' / '))
    const filteredCount = afterCat.cards
    check('① 列表已按分类过滤（有结果）', filteredCount > 0, `${filteredCount} 张卡`)

    // ---- 步② 点侧栏「商品广场」（/goods 无 query）模拟「全部」 ----
    const clickedAll = await cdp.evaluate(`(() => {
      const el = [...document.querySelectorAll('.el-menu-item')].find(a => a.textContent.trim() === '商品广场');
      if (!el) return 'not-found';
      el.click();
      return 'clicked';
    })()`)
    check('② 成功点击侧栏「商品广场」', clickedAll === 'clicked', clickedAll)
    await sleep(2500)

    const afterAll = await cdp.evaluate(`(() => {
      const sels = [...document.querySelectorAll('.filter-bar .el-select')].map(s => s.innerText.replace(/\\n/g, '|').trim());
      const cards = document.querySelectorAll('.goods-card').length;
      const total = (document.querySelector('.el-pagination__total')?.textContent || '').trim();
      return { url: location.pathname + location.search, selectTexts: sels, cards, total };
    })()`)

    check('② URL 已去掉 categoryId', !/categoryId=/.test(afterAll.url), afterAll.url)
    check('② 分类下拉已清空（回到全部分类）', afterAll.selectTexts.some((t) => t.includes('全部分类')), afterAll.selectTexts.join(' / '))
    check(
      '② 列表已重置为全量（条数 > 单一分类）',
      afterAll.cards > filteredCount,
      `分类 ${afterCat.total} → 全部 ${afterAll.total}`
    )

    ws.close()
  } finally {
    try { process.kill(-proc.pid) } catch { /* ignore */ }
  }

  const passed = results.filter((r) => r.ok).length
  console.log(`\n结果：${passed}/${results.length} 通过`)
  process.exit(passed === results.length ? 0 : 1)
})().catch((e) => {
  console.error('探针失败：', e.message)
  process.exit(2)
})
