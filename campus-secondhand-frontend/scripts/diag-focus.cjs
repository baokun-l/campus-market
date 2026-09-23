/**
 * 复现/回归工具：验证浮层焦点是否归还（scripts/diag-focus.cjs）。
 *
 * **修复前**的输出（第十九轮实测）：
 *   [失效态] activeElement = SPAN.el-drawer__sr-focus（在抽屉内、抽屉仍开着）
 *   点一次下拉 → open = 0   ← 焦点残留导致展开被迟到的 blur 撤销，连点/真鼠标都无效
 *   activeElement.blur() → 再点 → open = 1   ← 证明根因是残留焦点
 *
 * **修复后**（`utils/focus.ts` + 各浮层 @closed 调用）预期输出：
 *   [失效态] activeElement = BODY
 *   点一次下拉 → open = 1
 * 若哪天这里又变回 open = 0 且 activeElement 是 __sr-focus，说明有人摘掉了
 * `@closed="releaseOverlayFocus"` —— 用它回归。
 */
const http = require('http')
const path = require('path')
const { spawn } = require('child_process')

const TARGET = 'http://127.0.0.1:7788'
const OUT = 'C:/wbtmp'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9371
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const httpGet = (url) =>
  new Promise((res, rej) => {
    http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(d)) }).on('error', rej)
  })

;(async () => {
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(OUT, 'diag-focus-profile')}`.replace(/\//g, '\\'),
    '--no-first-run', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--window-size=1600,1100', 'about:blank'
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

    const activeInfo = () =>
      evalJS(`(function(){
        const a = document.activeElement;
        if (!a) return '(null)';
        return JSON.stringify({
          tag: a.tagName,
          cls: (a.className || '').toString().slice(0, 70),
          inDrawer: !!a.closest('.el-drawer'),
          inDialog: !!a.closest('.el-dialog'),
          visible: a.getBoundingClientRect().width > 0
        });
      })()`)
    const dropdownOpen = () =>
      evalJS(`[...document.querySelectorAll('.el-select-dropdown')].filter(function(x){ return x.getBoundingClientRect().width > 0 }).length`)
    const clickWrapper = async () => {
      await evalJS(`(function(){ const w=document.querySelector('.adm-select .el-select__wrapper'); if(w) w.click(); return !!w })()`)
      await sleep(800)
    }
    const pick = async (label) => {
      await evalJS(`(function(){ const w=document.querySelector('.adm-select .el-select__wrapper'); if(w) w.click(); return !!w })()`)
      await sleep(650)
      const ok = await evalJS(`(function(){
        const items=[...document.querySelectorAll('.el-select-dropdown__item')].filter(function(i){return i.getBoundingClientRect().width>0});
        const t=items.find(function(i){return i.innerText.trim()===${JSON.stringify(label)}});
        if(!t) return false; t.click(); return true;
      })()`)
      await sleep(1400)
      return ok
    }
    const esc = async () => {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
      await sleep(900)
    }
    const clickByText = (text) =>
      evalJS(`(function(){
        const b=[...document.querySelectorAll('button')].find(function(x){ return x.textContent.replace(/\\s+/g,'').includes(${JSON.stringify(text.replace(/\s+/g, ''))}) });
        if(!b) return false; b.click(); return true;
      })()`)
    const openFirstDetail = () =>
      evalJS(`(function(){ const b=[...document.querySelectorAll('.el-table__body tr td:last-child button')].find(function(x){return x.textContent.includes('详情')}); if(b) b.click(); return !!b })()`)

    await send('Page.enable'); await send('Runtime.enable')
    await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false })
    await send('Page.navigate', { url: TARGET + '/' }); await sleep(1800)
    await evalJS(`localStorage.setItem('c2c-user', JSON.stringify({token:'mock-token-admin'}))`)
    await send('Page.navigate', { url: TARGET + '/admin?tab=orders' }); await sleep(3600)

    console.log('\n[复现] 已发货→详情→ESC；退款中→详情→同意退款并关闭→确认退款')
    await pick('已发货')
    await openFirstDetail()
    await sleep(1200)
    await esc()
    await pick('退款中')
    await openFirstDetail()
    await sleep(1200)
    await clickByText('同意退款并关闭')
    await sleep(1000)
    console.log('  退款弹窗打开时 activeElement：', await activeInfo())
    await clickByText('确认退款')
    await sleep(2400)

    console.log('\n[失效态] activeElement：', await activeInfo())
    await clickWrapper()
    console.log('  点一次下拉 → open =', await dropdownOpen(), '（期望复现 0）')

    console.log('\n[实验] activeElement.blur() 归还焦点后再点：')
    await evalJS(`(function(){ const a=document.activeElement; if(a && a.blur) a.blur(); return !!a })()`)
    await sleep(400)
    console.log('  blur 后 activeElement：', await activeInfo())
    await clickWrapper()
    const openAfterBlur = await dropdownOpen()
    console.log('  点一次下拉 → open =', openAfterBlur)

    console.log('\n[实验] 若仍打不开，改点 body 让焦点明确落到 body：')
    if (openAfterBlur === 0) {
      await evalJS(`document.body.focus()`)
      await sleep(300)
      await clickWrapper()
      console.log('  点一次下拉 → open =', await dropdownOpen())
    }

    console.log('\n[对照] 关抽屉（ESC）后 activeElement：', (await esc(), await activeInfo()))
    const recovered = await pick('已取消')
    console.log('  关抽屉后切「已取消」：', recovered ? '成功' : '失败')

    ws.close()
  } catch (e) {
    console.error('诊断异常：', e)
  } finally {
    chrome.kill()
  }
})()
