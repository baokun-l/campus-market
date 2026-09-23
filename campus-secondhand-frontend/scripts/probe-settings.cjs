/**
 * 设置页功能逐项验证（node scripts/probe-settings.cjs）
 *
 * 用户问「这里的功能能使用吗」—— 不做静态推断，每项都在真实浏览器里点出来：
 *   A 字号大小   ：切换 → 根字号 + html[data-font] + body zoom + 实际渲染宽度 + 刷新保留
 *   B 深色模式   ：开关 → html.dark 加没加 + 页面背景/文字色**真的变不变**（有 class ≠ 有效果）
 *   C 界面主题色 ：真鼠标点第 2 个色点 → active 移动 + --color-primary / --el-color-primary 变橙
 *   D 清除缓存   ：确认弹窗 → 真实的购物车键（c2c-cart-v3）被删没删
 *   E 版本信息   ：点击行 → 版本弹窗打开且内容正确（关闭走 releaseOverlayFocus）
 *
 * 纪律：每项都带「点之前 vs 点之后」的对照证据；服务不可达 exit 2。
 */
const http = require('http')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const TARGET = 'http://127.0.0.1:7788'
const OUT = 'C:/wbtmp'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9375
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const httpGet = (url) =>
  new Promise((res, rej) => {
    http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(d)) }).on('error', rej)
  })

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`) }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`) }
}

;(async () => {
  try {
    await httpGet(TARGET + '/')
  } catch (e) {
    console.error(`预览服务不可用：${TARGET} —— ${e.message}`)
    process.exit(2)
  }

  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(OUT, 'probe-settings-profile')}`.replace(/\//g, '\\'),
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
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p.resolve(m.result) }
    })
    const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, { resolve: res }); ws.send(JSON.stringify({ id: i, method, params })) })
    const evalJS = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.value
    const shot = async (name) => {
      const s = await send('Page.captureScreenshot', { format: 'png' })
      fs.writeFileSync(`${OUT}/${name}`, Buffer.from(s.data, 'base64'))
    }
    const go = async (p, wait = 2200) => { await send('Page.navigate', { url: TARGET + p }); await sleep(wait) }
    /** 真鼠标：move → press → release（EP 的下拉是 hover 触发、开关要点 core，合成 .click() 会误伤） */
    const realMouseClick = async (sel) => {
      const pos = JSON.parse(await evalJS(`(function(){
        const e=document.querySelector(${JSON.stringify(sel)});
        if(!e) return 'null';
        const r=e.getBoundingClientRect();
        return JSON.stringify({ x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2) });
      })()`) || 'null')
      if (!pos) return false
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y, button: 'none' })
      await sleep(120)
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', buttons: 1, clickCount: 1 })
      await sleep(60)
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', buttons: 0, clickCount: 1 })
      return true
    }

    await send('Page.enable'); await send('Runtime.enable')
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false })
    await go('/', 1600)
    await evalJS(`localStorage.setItem('c2c-user', JSON.stringify({token:'mock-token-user-1'}))`)
    // 预置一个购物车，供 D 项验证「清除缓存」是否真的清到它
    await evalJS(`localStorage.setItem('c2c-cart-v3', JSON.stringify([{goodsId:1,quantity:1}]))`)
    // 清掉上次探针运行持久化的偏好，保证 A 段从「标准」档起步（否则 root 一开始就是 16px）
    await evalJS(`localStorage.removeItem('c2c-app')`)
    await go('/settings', 2400)

    const pageText = await evalJS(`document.body.innerText`)
    check('设置页正常渲染（含 5 个目标项）',
      ['字号大小', '深色模式', '界面主题色', '清除缓存', '版本信息'].every((t) => pageText.includes(t)))

    /** 在设置页里按标签文字找到对应行，再取行内的控件（页面上有 8 个开关，必须按行定位） */
    const realMouseClickRow = async (label, inner, hoverOnly = false) => {
      const pos = JSON.parse((await evalJS(`(function(){
        const row=[...document.querySelectorAll('.settings-page .settings-item')].find(function(r){
          const l=r.querySelector('.item-label');
          return l && l.innerText.trim()===${JSON.stringify(label)};
        });
        if(!row) return 'null';
        const e=row.querySelector(${JSON.stringify(inner)});
        if(!e) return 'null';
        // 目标行可能在长页面视口之外：真实鼠标点不到视口外的坐标，必须先滚进来
        e.scrollIntoView({ block: 'center' });
        const r=e.getBoundingClientRect();
        return JSON.stringify({ x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2) });
      })()`)) || 'null')
      if (!pos) return false
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y, button: 'none' })
      await sleep(150)
      if (hoverOnly) return true
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', buttons: 1, clickCount: 1 })
      await sleep(60)
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', buttons: 0, clickCount: 1 })
      return true
    }

    /* ==================== A. 字号 ==================== */
    console.log('\n【A · 字号大小】')
    const fontBefore = await evalJS(`(function(){
      const el = document.querySelector('.set-page') || document.body;
      const probe = el.querySelector('p, span, div');
      const title = document.querySelector('.page-title');
      return JSON.stringify({
        root: document.documentElement.style.fontSize || '(未设置)',
        computed: getComputedStyle(document.documentElement).fontSize,
        textPx: probe ? getComputedStyle(probe).fontSize : '(none)',
        titleW: title ? Math.round(title.getBoundingClientRect().width * 10) / 10 : 0
      });
    })()`)
    console.log('  切换前：', fontBefore)
    // 字号行是 el-segmented 分段选择器（第廿一轮改造：弃用下拉规避 zoom×Popper 错位）。
    // segmented 是原生 label+radio（非 EP 浮层），合成 click 即可生效（diag-zoom-popper 实证）。
    const segPicked = await evalJS(`(function(){
      const row=[...document.querySelectorAll('.settings-page .settings-item')].find(function(r){
        const l=r.querySelector('.item-label');
        return l && l.innerText.trim()==='字号大小';
      });
      if(!row) return 'no-row';
      const items=[...row.querySelectorAll('.el-segmented__item')];
      const t=items.find(function(i){ return i.innerText.trim()==='大' });
      if(!t) return 'no-item('+items.length+')';
      t.scrollIntoView({ block: 'center' });
      t.click();
      return '已点「大」档（segmented）';
    })()`)
    await sleep(900)
    const ddOpened = !!segPicked && segPicked.startsWith('已点')
    const pickedFont = segPicked
    console.log('  下拉：', ddOpened ? '已悬停' : '没找到下拉', '｜', pickedFont)
    await sleep(900)
    const fontAfter = await evalJS(`(function(){
      const el = document.querySelector('.set-page') || document.body;
      const title = document.querySelector('.page-title');
      return JSON.stringify({
        root: document.documentElement.style.fontSize || '(未设置)',
        dataFont: document.documentElement.dataset.font || '(未设置)',
        bodyZoom: getComputedStyle(document.body).zoom || '(无)',
        titleW: title ? Math.round(title.getBoundingClientRect().width * 10) / 10 : 0,
        toast: (document.querySelector('.el-message')||{}).innerText || '(无提示)'
      });
    })()`)
    console.log('  切换后：', fontAfter)
    const fb = JSON.parse(fontBefore); const fa = JSON.parse(fontAfter)
    check('根字号被修改', fa.root !== '(未设置)' && parseFloat(fa.root) !== parseFloat(fb.computed), `${fb.computed} → ${fa.root}`)
    check('html[data-font] 档位被写入', fa.dataFont === 'large', `data-font=${fa.dataFont}`)
    check('body zoom 生效（px 定字号靠整体缩放肉眼可见）', fa.bodyZoom !== '(无)' && parseFloat(fa.bodyZoom) > 1, `zoom=${fa.bodyZoom}`)
    check('标题实际渲染宽度变大（zoom 视觉联动）', fa.titleW > 0 && fb.titleW > 0 && fa.titleW > fb.titleW * 1.03, `${fb.titleW}px → ${fa.titleW}px`)
    // 刷新验证持久化
    await go('/settings', 2200)
    const fontReload = await evalJS(`document.documentElement.style.fontSize || '(未设置)'`)
    check('刷新后字号保留', fontReload !== '(未设置)', `刷新后 root=${fontReload}`)

    /* ==================== B. 深色模式 ==================== */
    console.log('\n【B · 深色模式】')
    const bgBefore = await evalJS(`(function(){
      const main = document.querySelector('.page-card, main, .layout-main') || document.body;
      const aside = document.querySelector('.layout-aside');
      return JSON.stringify({
        darkClass: document.documentElement.classList.contains('dark'),
        bodyBg: getComputedStyle(document.body).backgroundColor,
        mainBg: getComputedStyle(main).backgroundColor,
        mainText: getComputedStyle(main).color,
        asideBg: aside ? getComputedStyle(aside).backgroundColor : '(none)'
      });
    })()`)
    console.log('  开关前：', bgBefore)
    // 真鼠标点「深色模式」那一行里的 el-switch core
    const swOk = await realMouseClickRow('深色模式', '.el-switch__core')
    await sleep(900)
    const bgAfter = await evalJS(`(function(){
      const main = document.querySelector('.page-card, main, .layout-main') || document.body;
      const aside = document.querySelector('.layout-aside');
      return JSON.stringify({
        darkClass: document.documentElement.classList.contains('dark'),
        bodyBg: getComputedStyle(document.body).backgroundColor,
        mainBg: getComputedStyle(main).backgroundColor,
        mainText: getComputedStyle(main).color,
        asideBg: aside ? getComputedStyle(aside).backgroundColor : '(none)',
        epDark: !!document.querySelector('html.dark')
      });
    })()`)
    console.log('  开关后：', bgAfter)
    const bb = JSON.parse(bgBefore); const ba = JSON.parse(bgAfter)
    check('开关可交互（真鼠标点到了 core）', swOk, swOk ? '' : '页面上没找到 .el-switch__core')
    check('html.dark 类被加上', ba.darkClass === true)
    check('页面背景色真的变了（有 class ≠ 有视觉效果）', ba.mainBg !== bb.mainBg || ba.bodyBg !== bb.bodyBg, `${bb.mainBg} → ${ba.mainBg}`)
    check('正文颜色真的变了', ba.mainText !== bb.mainText, `${bb.mainText} → ${ba.mainText}`)
    const asideRgb = (ba.asideBg.match(/\d+/g) || []).map(Number)
    check('侧栏外壳也变暗（第廿轮修复：$var → var()）',
      ba.asideBg !== bb.asideBg && asideRgb.length >= 3 && asideRgb.every((n) => n < 60),
      `${bb.asideBg} → ${ba.asideBg}`)
    await shot('settings-dark-on.png')
    // 关回去（同一条行内开关）
    await realMouseClickRow('深色模式', '.el-switch__core')
    await sleep(700)

    /* ==================== C. 主题色 ==================== */
    console.log('\n【C · 界面主题色】')
    const colorInfo = await evalJS(`(function(){
      const dots=[...document.querySelectorAll('.color-dots .dot')];
      return JSON.stringify({
        count: dots.length,
        active: dots.findIndex(function(d){ return d.classList.contains('active') }),
        primary: (document.documentElement.style.getPropertyValue('--color-primary')||'').trim(),
        epPrimary: (document.documentElement.style.getPropertyValue('--el-color-primary')||'').trim(),
        titles: dots.map(function(d){ return d.getAttribute('title') || '' })
      });
    })()`)
    console.log('  色点：', colorInfo)
    const ci = JSON.parse(colorInfo)
    check('主题色有 4 个色点（带名称提示）', ci.count === 4 && ci.titles.every(Boolean), ci.titles.join('/'))
    check('默认 active 在第 1 个（商务蓝）', ci.active === 0, `primary=${ci.primary}`)
    // 真鼠标点第 2 个色点（活力橙）
    const dotPos = JSON.parse((await evalJS(`(function(){
      const d=[...document.querySelectorAll('.color-dots .dot')][1];
      if(!d) return 'null';
      d.scrollIntoView({ block: 'center' });
      const r=d.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2) });
    })()`)) || 'null')
    let dotClicked = false
    if (dotPos) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: dotPos.x, y: dotPos.y, button: 'none' })
      await sleep(120)
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dotPos.x, y: dotPos.y, button: 'left', buttons: 1, clickCount: 1 })
      await sleep(60)
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dotPos.x, y: dotPos.y, button: 'left', buttons: 0, clickCount: 1 })
      dotClicked = true
    }
    await sleep(800)
    const colorAfter = await evalJS(`(function(){
      const dots=[...document.querySelectorAll('.color-dots .dot')];
      return JSON.stringify({
        active: dots.findIndex(function(d){ return d.classList.contains('active') }),
        primary: (document.documentElement.style.getPropertyValue('--color-primary')||'').trim(),
        epPrimary: (document.documentElement.style.getPropertyValue('--el-color-primary')||'').trim()
      });
    })()`)
    console.log('  点击后：', colorAfter)
    const ca = JSON.parse(colorAfter)
    check('色点可点击（真鼠标点到）', dotClicked)
    check('active 移动到第 2 个（活力橙）', ca.active === 1, `active=${ca.active + 1}`)
    check('--color-primary 变成活力橙 #f97316', /f97316/i.test(ca.primary), ca.primary)
    check('Element Plus 主色同步（--el-color-primary）', /f97316/i.test(ca.epPrimary), ca.epPrimary)
    await shot('settings-accent-orange.png')
    // 点回第 1 个恢复默认，避免影响后续断言
    await evalJS(`(function(){ const d=[...document.querySelectorAll('.color-dots .dot')][0]; if(d) d.click(); return !!d })()`)
    await sleep(500)

    /* ==================== D. 清除缓存 ==================== */
    console.log('\n【D · 清除缓存】')
    const cartBefore = await evalJS(`localStorage.getItem('c2c-cart-v3')`)
    check('预置的购物车键存在（前置条件）', !!cartBefore)
    await evalJS(`(function(){
      const row=[...document.querySelectorAll('div')].find(function(x){ return /清除缓存/.test(x.innerText||''); });
      const btn = row ? [...row.querySelectorAll('button')].find(function(b){ return /清除/.test(b.innerText) }) : null;
      if(btn) btn.click(); return !!btn;
    })()`)
    await sleep(800)
    const boxTitle = await evalJS(`(document.querySelector('.el-message-box__title')||{}).innerText || ''`)
    check('弹出二次确认框', /清除/.test(boxTitle), boxTitle)
    await evalJS(`(function(){ const b=document.querySelector('.el-message-box__btns .el-button--primary'); if(b) b.click(); return !!b })()`)
    await sleep(1000)
    const cartAfter = await evalJS(`localStorage.getItem('c2c-cart-v3')`)
    check('真实的购物车缓存（c2c-cart-v3）被清除', cartAfter === null, cartAfter === null ? '已删除' : `仍在：${String(cartAfter).slice(0, 40)}`)

    /* ==================== E. 版本信息 ==================== */
    console.log('\n【E · 版本信息】')
    // 等 D 段的 toast 消失，避免把「已清除缓存」误记成本项的反应
    await sleep(1600)
    const dialogsBefore = await evalJS(`document.querySelectorAll('.el-dialog, .el-drawer').length`)
    const toastBefore = await evalJS(`(document.querySelector('.el-message')||{}).innerText || '(无)'`)
    const verClicked = await evalJS(`(function(){
      const row=[...document.querySelectorAll('.settings-page .settings-item')].find(function(r){
        const l=r.querySelector('.item-label');
        return l && l.innerText.trim()==='版本信息';
      });
      if(!row) return false; row.click(); return true;
    })()`)
    await sleep(900)
    const dialogsAfter = await evalJS(`document.querySelectorAll('.el-dialog, .el-drawer').length`)
    const toastAfter = await evalJS(`(document.querySelector('.el-message')||{}).innerText || '(无)'`)
    const newToast = toastAfter !== toastBefore && toastAfter !== '(无)'
    check('点击版本信息有反应（弹层或新提示）', verClicked && (dialogsAfter > dialogsBefore || newToast), `弹层 ${dialogsBefore}→${dialogsAfter}，提示「${toastAfter}」`)
    // 弹窗内容验证：标题 + 关键字段真实渲染
    const verDialog = await evalJS(`(function(){
      const d=[...document.querySelectorAll('.el-dialog')].find(function(x){ return x.getBoundingClientRect().width>0 });
      if(!d) return '(无可见弹窗)';
      return JSON.stringify({
        title: (d.querySelector('.el-dialog__title')||{}).innerText || '',
        hasVersion: /v1\\.0\\.0/.test(d.innerText),
        hasName: /校园二手集市/.test(d.innerText)
      });
    })()`)
    console.log('  版本弹窗：', verDialog)
    const vd = JSON.parse(verDialog)
    check('版本信息弹窗打开且内容正确', !!vd && vd.title === '版本信息' && vd.hasVersion && vd.hasName, `标题「${vd.title}」`)
    await shot('settings-version-dialog.png')
    // 关闭弹窗（点「知道了」），顺带覆盖 releaseOverlayFocus 的焦点归还路径
    await evalJS(`(function(){
      const b=[...document.querySelectorAll('.el-dialog__footer .el-button')].find(function(x){ return x.getBoundingClientRect().width>0 && /知道了/.test(x.innerText) });
      if(b) b.click(); return !!b;
    })()`)
    await sleep(700)

    console.log(`\n=========== 结果：${pass} 通过 / ${fail} 失败 ============\n`)
    ws.close()
    process.exitCode = fail ? 1 : 0
  } catch (e) {
    console.error('探针异常：', e)
    process.exitCode = 1
  } finally {
    chrome.kill()
  }
})()
