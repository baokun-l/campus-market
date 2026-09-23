/**
 * 端到端验证：限时活动生命周期
 * ① 管理员在后台看到活动「进行中」→ ② 点「提前结束」→ ③ 前台 Banner 消失
 * ④ 后台重新开启 → ⑤ 前台 Banner 恢复且倒计时递减
 * 用法：node scripts/e2e-activity.cjs
 */
const http = require('http')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const TARGET = 'http://127.0.0.1:7788'
const OUT = 'C:/wbtmp'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9335

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
    return r.result.value
  }
}

const HELPERS = `
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
  return 'clicked';
};
// 首页活动态探针
window.__homeProbe = () => ({
  hasBanner: !!document.querySelector('.promo'),
  hasEmpty: !!document.querySelector('.promo-empty'),
  hasCountdown: !!document.querySelector('.promo-countdown'),
  countdown: document.querySelector('.cd-time')?.textContent?.trim() || null,
  title: document.querySelector('.promo-title')?.textContent?.trim() || null,
  chips: [...document.querySelectorAll('.promo-chips li')].map((n) => n.textContent.trim()),
  cta: document.querySelector('.promo-cta')?.textContent?.replace(/\\s+/g,' ').trim() || null,
  // 让利归属徽标（由活动数据算出，不是手写文案）
  fund: document.querySelector('.promo-fund')?.textContent?.trim() || null,
  dots: document.querySelectorAll('.promo-dots .dot').length,
  theme: [...(document.querySelector('.promo')?.classList || [])].find((c) => c.startsWith('theme-')) || null,
  statCells: [...document.querySelectorAll('.stat-bar li')].map((n) => n.textContent.replace(/\\s+/g,' ').trim()),
  cardsWithCover: [...document.querySelectorAll('.goods-grid img')].filter((i) => i.getAttribute('src')).length
});
// 后台活动面板探针
window.__adminProbe = () => ({
  panelTitle: document.querySelector('.activity-head h4')?.textContent?.trim() || null,
  stateTag: document.querySelector('.activity-head .el-tag')?.textContent?.trim() || null,
  metaKeys: [...document.querySelectorAll('.activity-meta .meta-item span')].map((n) => n.textContent.trim()),
  metaVals: [...document.querySelectorAll('.activity-meta .meta-item b')].map((n) => n.textContent.trim()),
  buttons: [...document.querySelectorAll('.activity-actions button')].map((n) => n.textContent.trim()),
  // 活动列表（多活动模型新增）
  rowCount: document.querySelectorAll('.act-table .el-table__body tr').length,
  rowTitles: [...document.querySelectorAll('.act-table .el-table__body tr .act-txt b')].map((n) => n.textContent.trim()),
  barText: document.querySelector('.act-bar-right')?.textContent?.replace(/\\s+/g,' ').trim() || null
});
// 往 Vue 受控输入里写值（必须走原生 setter + input 事件，否则 v-model 不更新）
window.__setInput = (selector, value) => {
  const el = document.querySelector(selector);
  if (!el) return 'not-found';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return 'ok';
};
// 选中某一行（点单元格，不能点按钮——行内按钮都带了 @click.stop）
window.__selectRow = (rowText) => {
  const rows = [...document.querySelectorAll('.act-table .el-table__body tr')];
  const row = rows.find((r) => r.textContent.includes(rowText));
  if (!row) return 'row-not-found';
  const cell = row.querySelector('td .act-cell') || row.querySelector('td');
  if (!cell) return 'cell-not-found';
  cell.click();
  return 'clicked';
};
// 点某一行里的某个按钮
window.__clickRowAction = (rowText, btnText) => {
  const rows = [...document.querySelectorAll('.act-table .el-table__body tr')];
  const row = rows.find((r) => r.textContent.includes(rowText));
  if (!row) return 'row-not-found';
  const btn = [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === btnText);
  if (!btn) return 'btn-not-found';
  btn.click();
  return 'clicked';
};
'ready'`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
function check(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? '  ✅' : '  ❌'} ${name}${detail ? ' — ' + detail : ''}`)
}

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(OUT, 'chrome-e2e-profile')}`.replace(/\//g, '\\'),
    '--no-first-run', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--disable-extensions', 'about:blank'],
    { stdio: 'ignore' })

  for (let i = 0; i < 50; i++) {
    try { await httpGet(`http://127.0.0.1:${PORT}/json/version`); break } catch { await sleep(300) }
  }
  const list = JSON.parse(await httpGet(`http://127.0.0.1:${PORT}/json/list`))
  const page = list.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  const cdp = new CDP(ws)
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })

  const goto = async (p, wait = 3800) => {
    await cdp.send('Page.navigate', { url: `${TARGET}${p}` })
    await sleep(wait)
    await cdp.eval(HELPERS)
  }
  const login = async (token) => {
    await cdp.send('Page.navigate', { url: `${TARGET}/login` })
    await sleep(1600)
    // 两个 key 都要清：c2c-activities（多活动列表）+ c2c-activity（旧版单活动存档）
    await cdp.eval(`localStorage.removeItem('c2c-activity');localStorage.removeItem('c2c-activities');localStorage.setItem('c2c-user', JSON.stringify({token:'${token}'}));'ok'`)
  }

  console.log('\n【1】管理员登录，活动初始应为「进行中」')
  await login('mock-token-admin')
  await goto('/admin')
  await cdp.eval(`window.__clickByText('活动管理')`); await sleep(1200)
  let a = await cdp.eval('JSON.stringify(window.__adminProbe())')
  a = JSON.parse(a)
  check('后台活动面板标题正确', /卖家让利专区/.test(a.panelTitle || ''), a.panelTitle)
  check('状态标签=进行中', a.stateTag === '进行中', a.stateTag)
  check('展示倒计时元数据', a.metaKeys.includes('限时剩余'), a.metaKeys.join(' / '))
  check('提供「提前结束活动」按钮', a.buttons.includes('提前结束活动'), a.buttons.join(' / '))

  console.log('\n【2】前台首页 Banner 可见 + 倒计时在跑')
  await goto('/home')
  let h1 = JSON.parse(await cdp.eval('JSON.stringify(window.__homeProbe())'))
  check('Banner 存在', h1.hasBanner)
  check('倒计时格式 DD天 HH:MM:SS', /^\d{2}天 \d{2}:\d{2}:\d{2}$/.test(h1.countdown || ''), h1.countdown)
  check('chips 4 个卖点', h1.chips.length === 4, h1.chips.join(' / '))
  check('CTA 文案存在', /看看让利好物/.test(h1.cta || ''), h1.cta)
  check('数据条 3 格', h1.statCells.length === 3, h1.statCells.join(' | '))
  check('推荐商品封面已加载', h1.cardsWithCover >= 8, `${h1.cardsWithCover} 张`)
  // 让利归属徽标由活动数据算出：文案说卖家让利，数据就必须是 seller
  check('显示「卖家让利」归属徽标', h1.fund === '卖家让利', h1.fund)

  const cd1 = h1.countdown
  await sleep(2200)
  const cd2 = await cdp.eval(`document.querySelector('.cd-time')?.textContent.trim()`)
  check('倒计时实时递减', cd1 !== cd2, `${cd1} → ${cd2}`)

  console.log('\n【3】管理员点「提前结束活动」→ 确认')
  await goto('/admin')
  await cdp.eval(`window.__clickByText('活动管理')`); await sleep(1000)
  await cdp.eval(`window.__clickByText('提前结束活动')`); await sleep(900)
  const boxText = await cdp.eval(`document.querySelector('.el-message-box__message')?.textContent?.trim() || null`)
  check('弹出二次确认', !!boxText, boxText)
  // 确认文案必须讲清后果：多活动模型下下架≠前台没活动，而是「让利声明失效 + 切到下一个」
  check('确认文案说明让利声明会失效', /让利声明将立即失效/.test(boxText || ''), boxText)
  await cdp.eval(`document.querySelector('.el-message-box__btns .el-button--primary')?.click()`); await sleep(1400)
  let a2 = JSON.parse(await cdp.eval('JSON.stringify(window.__adminProbe())'))
  check('状态标签变为已取消', a2.stateTag === '已取消', a2.stateTag)
  check('展示取消时间/操作人', a2.metaKeys.includes('取消于'), a2.metaKeys.join(' / '))
  check('提供重新开启入口', a2.buttons.some((b) => b.includes('开启新活动')), a2.buttons.join(' / '))
  const shot1 = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(OUT, 'admin-activity-cancelled.png'), Buffer.from(shot1.data, 'base64'))

  console.log('\n【4】前台首页：Banner 应自动切到下一个进行中的活动（多活动模型）')
  await goto('/home')
  const h2 = JSON.parse(await cdp.eval('JSON.stringify(window.__homeProbe())'))
  check('Banner 仍在（切到次优先级活动）', !!h2.hasBanner)
  check('已切换到数码补贴活动', /平台补贴日/.test(h2.title || ''), h2.title)
  check('归属徽标切换为「平台补贴」', h2.fund === '平台补贴', h2.fund)
  check('不再显示无活动占位', !h2.hasEmpty)
  check('数据条仍在', h2.statCells.length === 3, h2.statCells.join(' | '))
  const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(OUT, 'home-activity-switched.png'), Buffer.from(shot2.data, 'base64'))

  console.log('\n【4b】再把其余进行中的活动逐个下架 → 前台 Banner 才消失')
  await goto('/admin')
  await cdp.eval(`window.__clickByText('活动管理')`); await sleep(1000)
  const sel = await cdp.eval(`window.__selectRow('平台补贴日')`); await sleep(700)
  check('可选中第二个活动', sel === 'clicked', sel)
  const off = await cdp.eval(`window.__clickRowAction('平台补贴日', '下架')`); await sleep(900)
  check('可按行下架第二个活动', off === 'clicked', off)
  await cdp.eval(`document.querySelector('.el-message-box__btns .el-button--primary')?.click()`); await sleep(1400)
  // 出厂活动里有 3 个是进行中的（开学季 / 数码补贴日 / 宿舍焕新），只下架前两个 Banner 还会切到第三个
  const sel3 = await cdp.eval(`window.__selectRow('宿舍焕新补贴周')`); await sleep(700)
  check('可选中第三个进行中的活动', sel3 === 'clicked', sel3)
  const off3 = await cdp.eval(`window.__clickRowAction('宿舍焕新补贴周', '下架')`); await sleep(900)
  check('可下架第三个进行中的活动', off3 === 'clicked', off3)
  await cdp.eval(`document.querySelector('.el-message-box__btns .el-button--primary')?.click()`); await sleep(1400)
  await goto('/home')
  const h2b = JSON.parse(await cdp.eval('JSON.stringify(window.__homeProbe())'))
  check('全部下架后 Banner 已隐藏', !h2b.hasBanner)
  check('显示无活动占位', h2b.hasEmpty)
  const shot2b = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(OUT, 'home-no-activity.png'), Buffer.from(shot2b.data, 'base64'))

  console.log('\n【5】后台重新开启活动（倒计时从现在重新计算）')
  await goto('/admin')
  await cdp.eval(`window.__clickByText('活动管理')`); await sleep(1000)
  await cdp.eval(`window.__selectRow('平台补贴日')`); await sleep(600)
  await cdp.eval(`window.__clickByText('开启新活动（14 天）') || window.__clickByText('开启新活动')`); await sleep(1500)
  let a3 = JSON.parse(await cdp.eval('JSON.stringify(window.__adminProbe())'))
  check('状态恢复为进行中', a3.stateTag === '进行中', a3.stateTag)
  check('持续天数已更新', (a3.metaVals[a3.metaKeys.indexOf('持续天数')] || '').includes('天'), a3.metaVals.join(' | '))

  console.log('\n【6】前台首页：Banner 恢复')
  await goto('/home')
  const h3 = JSON.parse(await cdp.eval('JSON.stringify(window.__homeProbe())'))
  check('Banner 重新出现', h3.hasBanner)
  check('倒计时为 13/14 天区间', /^(1[0-4])天/.test(h3.countdown || ''), h3.countdown)
  const shot3 = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(OUT, 'home-activity-restored.png'), Buffer.from(shot3.data, 'base64'))

  console.log('\n【7】多活动管理：新建 / 上下架 / 前台轮播 / 恢复出厂')
  await goto('/admin')
  await cdp.eval(`window.__clickByText('活动管理')`); await sleep(1200)
  const a4 = JSON.parse(await cdp.eval('JSON.stringify(window.__adminProbe())'))
  check('活动列表初始 4 条', a4.rowCount === 4, `实际 ${a4.rowCount} 条：${a4.rowTitles.join(' / ')}`)
  check('统计条显示活动数量', /共\s*4\s*个活动/.test(a4.barText || ''), a4.barText)

  await cdp.eval(`window.__clickByText('新建活动')`); await sleep(800)
  const dlgTitle = await cdp.eval(`document.querySelector('.el-dialog__title')?.textContent?.trim() || null`)
  check('新建活动弹窗可打开', dlgTitle === '新建活动', dlgTitle)
  const claimField = await cdp.eval(
    `[...document.querySelectorAll('.el-dialog .act-form .el-form-item__label')].map((n) => n.textContent.trim()).join(' / ')`
  )
  // 没有「资金来源 / 让利声明」，管理员就能造出「喊了折扣却没依据」的活动
  check('弹窗含「资金来源」字段', /资金来源/.test(claimField), claimField)
  check('弹窗含「让利声明」字段', /让利声明/.test(claimField), claimField)
  await cdp.eval(`window.__setInput('.el-dialog .act-form .el-form-item input', 'E2E 自动化活动')`)
  await sleep(250)
  await cdp.eval(`window.__clickByText('保存')`); await sleep(1400)
  const a5 = JSON.parse(await cdp.eval('JSON.stringify(window.__adminProbe())'))
  check('保存后列表变为 5 条', a5.rowCount === 5, `实际 ${a5.rowCount} 条`)
  check('新活动出现在列表中', a5.rowTitles.includes('E2E 自动化活动'), a5.rowTitles.join(' / '))

  // 行内「下架」→ 二次确认 → 「上架」：验证多活动可随时上下架
  const offRow = await cdp.eval(`window.__clickRowAction('平台补贴日', '下架')`); await sleep(800)
  check('可按行下架活动', offRow === 'clicked', offRow)
  await cdp.eval(`document.querySelector('.el-message-box__btns .el-button--primary')?.click()`); await sleep(1200)
  const up = await cdp.eval(`window.__clickRowAction('平台补贴日', '上架')`)
  await sleep(1300)
  check('可按行重新上架活动', up === 'clicked', up)

  await goto('/home')
  const h4 = JSON.parse(await cdp.eval('JSON.stringify(window.__homeProbe())'))
  // 此时进行中活动 = 平台补贴日（【5】重新上架）+ E2E 自动化活动（刚新建）
  // （开学季在【3】已下架、宿舍焕新在【4b】已下架、毕业清仓已自然到期）
  check('首页出现轮播指示器（2 个进行中活动）', h4.dots === 2, `dots=${h4.dots}`)
  const t1 = h4.title
  await cdp.eval(`document.querySelectorAll('.promo-dots .dot')[1]?.click()`); await sleep(700)
  const t2 = await cdp.eval(`document.querySelector('.promo-title')?.textContent?.trim() || null`)
  check('点击指示器可切换活动', !!t2 && t2 !== t1, `${t1} → ${t2}`)
  const shot5 = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(OUT, 'home-activity-carousel.png'), Buffer.from(shot5.data, 'base64'))

  await goto('/admin')
  await cdp.eval(`window.__clickByText('活动管理')`); await sleep(1000)
  await cdp.eval(`window.__clickByText('恢复出厂')`); await sleep(900)
  await cdp.eval(`document.querySelector('.el-message-box__btns .el-button--primary')?.click()`); await sleep(1500)
  const a6 = JSON.parse(await cdp.eval('JSON.stringify(window.__adminProbe())'))
  check('恢复出厂后回到 4 条', a6.rowCount === 4, `实际 ${a6.rowCount} 条`)

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${'='.repeat(56)}`)
  console.log(`总计 ${results.length} 项断言：通过 ${results.length - failed.length}，失败 ${failed.length}`)
  if (failed.length) console.log('失败项：\n' + failed.map((f) => `  - ${f.name} (${f.detail})`).join('\n'))

  ws.close(); chrome.kill()
  process.exit(failed.length ? 1 : 0)
})().catch((e) => { console.error('FAILED:', e); process.exit(1) })
