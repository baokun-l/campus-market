/**
 * 管理后台「自动下架」入口真机验证（CDP 驱动，不 mock，真点真发请求）。
 *
 * ★ 这个脚本守的是什么 ★
 * 后端 `GET|POST /admin/goods/auto-offline` 早就实现了，但前端此前**零调用方** ——
 * 一个功能完整的接口，管理员在界面上没有任何入口能用它。
 * 这类缺陷用单测抓不到（单测只测前端 Mock 分支），用类型检查也抓不到
 * （接口不需要被谁调也能编译通过），只有「打开真页面、点一下、看请求有没有发出去」能抓到。
 *
 * ★ 为什么本脚本不点「确认执行」★
 * 执行会真的把商品 status 改成 off_shelf，且**没有撤销键**。
 * 实测当前库里有 2 件超期在售商品（id=15 民谣吉他 / id=16 桌面文具收纳盒，
 * 都是演示种子数据随自然时间推移变成超期的），一旦执行就会改动演示基线。
 * 所以本脚本只验证到「二次确认弹窗出现且内容正确」，然后点**取消**，
 * 并回过头用后端接口复核「件数没有变化」—— 以此证明取消真的没产生副作用。
 *
 * 用法：node scripts/shot-auto-offline.cjs [--target=http://127.0.0.1:5173]
 */
const fs = require('fs')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')

const argv = process.argv.slice(2)
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`))
  return hit ? hit.split('=').slice(1).join('=') : d
}
const TARGET = arg('target', 'http://127.0.0.1:5173')
const OUT = arg('out', 'C:/wbtmp/auto-offline-shots')
const API = arg('api', 'http://127.0.0.1:8080/api')
const USER = arg('user', 'admin')
const PASS = arg('pass', 'admin123')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9339

const results = []
function check(name, cond, detail = '') {
  results.push({ name, cond })
  console.log(`${cond ? '  [PASS] ' : '  [FAIL] '}${name}${detail ? '  -> ' + detail : ''}`)
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = ''
      res.on('data', (c) => (d += c))
      res.on('end', () => resolve(d))
    }).on('error', reject)
  })
}

function apiCall(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null
    const headers = { 'Content-Type': 'application/json' }
    if (data) headers['Content-Length'] = Buffer.byteLength(data)
    if (token) headers['Cookie'] = `c2c-token=${token}`
    const req = http.request({ host: '127.0.0.1', port: 8080, path: `/api${p}`, method, headers }, (res) => {
      let d = ''
      res.on('data', (c) => (d += c))
      res.on('end', () => {
        try { resolve(JSON.parse(d)) } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

async function waitForEndpoint(retries = 60) {
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
    this.events = []
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id)
        this.pending.delete(m.id)
        m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
      } else if (m.method) {
        // 收集事件流，用于断言「真的把请求发出去了」
        this.events.push(m)
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
  /** 等待某个表达式返回真值（避免用固定 sleep 赌渲染时机） */
  async waitFor(expression, timeout = 8000, step = 150) {
    const t0 = Date.now()
    while (Date.now() - t0 < timeout) {
      const v = await this.eval(expression)
      if (v) return v
      await new Promise((r) => setTimeout(r, step))
    }
    return null
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

/* 定位「自动下架天数」所在的 el-form-item，后续所有操作都在这个作用域内 ——
   页面里还有另一个 el-input-number（每日发布上限），不限定作用域会点错控件 */
const AUTO_ITEM = `
  (() => {
    const labels = [...document.querySelectorAll('.el-form-item__label, label')];
    const hit = labels.find((l) => l.textContent.includes('自动下架天数'));
    return hit ? hit.closest('.el-form-item') : null;
  })()
`

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const login = await apiCall('POST', '/user/login', { username: USER, password: PASS })
  const token = login.data.token
  console.log(`已用 ${USER} 登录，票据长度 ${token.length}`)

  /* 基线：执行前的命中件数。取消之后要拿它来复核「真的没动数据」 */
  const basePreview = await apiCall('GET', '/admin/goods/auto-offline', null, token)
  const baseCount = basePreview.data.count
  const baseDays = basePreview.data.days
  console.log(`基线预览：days=${baseDays} count=${baseCount}`)

  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(OUT, 'chrome-profile').replace(/\//g, '\\')}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--disable-extensions',
    'about:blank'
  ], { stdio: 'ignore' })

  const version = await waitForEndpoint()
  console.log('Chrome:', version['Browser'])

  const cdp = await connect()
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Network.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false
  })

  await cdp.send('Page.navigate', { url: `${TARGET}/login` })
  await new Promise((r) => setTimeout(r, 2000))

  const set = await cdp.send('Network.setCookie', {
    name: 'c2c-token', value: token, url: `${TARGET}/`, httpOnly: true
  })
  check('O0 登录票据已注入 HttpOnly Cookie', Boolean(set.success))

  await cdp.eval(`localStorage.setItem('c2c-user', JSON.stringify({token:'',sessionHint:true}));'ok'`)

  await cdp.send('Page.navigate', { url: `${TARGET}/admin?tab=settings` })
  const itemReady = await cdp.waitFor(`Boolean(${AUTO_ITEM})`, 12000)
  check('O1 系统设置页渲染出「自动下架天数」所在表单项', Boolean(itemReady))

  /* ---------- 按钮是否真的存在 ---------- */
  const btns = await cdp.eval(`
    (() => {
      const item = ${AUTO_ITEM};
      if (!item) return null;
      return [...item.querySelectorAll('button')].map((b) => b.innerText.trim());
    })()
  `)
  console.log('  该行的按钮:', JSON.stringify(btns))
  check('O2 该行出现「预览影响范围」按钮', Array.isArray(btns) && btns.some((t) => t.includes('预览影响范围')))
  check('O3 该行出现「立即执行一次」按钮', Array.isArray(btns) && btns.some((t) => t.includes('立即执行一次')))

  /* ---------- 点预览：断言真的发出了后端请求 ---------- */
  cdp.events.length = 0
  const clicked = await cdp.eval(`
    (() => {
      const item = ${AUTO_ITEM};
      const b = [...item.querySelectorAll('button')].find((x) => x.innerText.includes('预览影响范围'));
      if (!b) return false;
      b.click();
      return true;
    })()
  `)
  check('O4 成功点击「预览影响范围」', clicked === true)

  const previewAlert = await cdp.waitFor(
    `(() => {
       const item = ${AUTO_ITEM};
       if (!item) return null;
       const a = item.querySelector('.el-alert');
       return a ? a.innerText.replace(/\\s+/g, ' ').trim() : null;
     })()`,
    10000
  )
  console.log('  预览结果:', previewAlert)
  check('O5 预览结果出现在页面上（只读预览闭环）', Boolean(previewAlert))
  check('O6 结果文案说清了天数与件数',
        Boolean(previewAlert) && previewAlert.includes(String(baseDays)) && previewAlert.includes(`${baseCount} 件`),
        previewAlert || '')

  /* 网络层证据：不是「界面看起来变了」，而是「请求真的发出去了」 */
  /*
   * ★ 只断言 method + path，不断言 host ★
   * 开发环境下前端跑在 5173，请求先发给 Vite dev server 再由它代理到 8080 ——
   * 第一版硬编码了 `http://127.0.0.1:8080/...`，于是把这条正常代理判成了 FAIL。
   * 这是探针自己制造的假缺陷（第三次了：spawnSync EBUSY、ANSI 颜色码、这次的 host）。
   * 请求路径才是契约，host 是部署期的事。
   */
  const reqs = cdp.events
    .filter((e) => e.method === 'Network.requestWillBeSent')
    .map((e) => {
      const u = new URL(e.params.request.url)
      return { method: e.params.request.method, path: u.pathname }
    })
    .filter((r) => r.path.includes('auto-offline'))
  console.log('  实际发出的 auto-offline 请求:', JSON.stringify(reqs))
  check('O7 浏览器真的向 /api/admin/goods/auto-offline 发了 GET',
        reqs.some((r) => r.method === 'GET' && r.path === '/api/admin/goods/auto-offline'),
        reqs.map((r) => `${r.method} ${r.path}`).join(' | ') || '（没有捕获到）')

  /* ---------- 改了天数但没保存：必须提示口径不一致 ---------- */
  /*
   * ★ 这里必须派发**真实鼠标事件**，不能用 DOM 的 `.click()` ★
   * Element Plus 的 InputNumber 增减按钮挂的是 `v-repeat-click` 指令 ——
   * 它监听 `mousedown`（为了支持「按住不放连续加」），而 `.click()` 合成的
   * click 事件走不到它的处理函数。
   * 第一版用 `.click()` 的后果是：天数压根没变 ⇒ dirty 为 false ⇒
   * 下面两条断言直接 FAIL，看起来像「未保存提示没实现」。
   * 这是探针第四次把「我的模拟不够真」伪装成「功能有缺陷」
   * （前三次：spawnSync EBUSY、vitest 的 ANSI 颜色码、Vite 代理的 host）。
   */
  const incPos = await cdp.eval(`
    (() => {
      const item = ${AUTO_ITEM};
      const inc = item && item.querySelector('.el-input-number__increase');
      if (!inc) return null;
      /* 内容区可能比视口长 —— 先滚进视口再取坐标。
         CDP 的 Input.dispatchMouseEvent 用的是视口坐标，元素在视口外时点击会打空，
         表现成「点了没反应」，很容易被误读为「功能没实现」。 */
      inc.scrollIntoView({ block: 'center' });
      const r = inc.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()
  `)
  check('O8 找到「自动下架天数」的加号按钮', incPos !== null)

  /*
   * ★ 为什么必须先等遮罩消失 ★
   * 第一次用真实鼠标点击时打空了。诊断显示该坐标命中的是 `.el-loading-text` ——
   * `el-form` 上的 `v-loading="loading"` 遮罩此刻正盖住整张表单。
   * 真实用户会遇到同一件事：页面还在 loading 时点哪个控件都没反应。
   * 所以这里如实记录遮罩状态并断言它已消失，而不是盲目 sleep 几秒赌它没了。
   */
  const maskInfo = await cdp.eval(`
    (() => {
      const ms = [...document.querySelectorAll('.el-loading-mask')];
      return ms.map((m) => ({
        display: getComputedStyle(m).display,
        parent: m.parentElement ? String(m.parentElement.className).slice(0, 60) : null
      }));
    })()
  `)
  console.log('  loading 遮罩:', JSON.stringify(maskInfo))

  const maskGone = await cdp.waitFor(
    `[...document.querySelectorAll('.el-loading-mask')].every((m) => getComputedStyle(m).display === 'none')`,
    10000
  )
  check('O9 表单 loading 遮罩已消失（页面进入可交互状态，不是永远转圈）',
        maskGone === true,
        maskGone ? '' : `仍在显示：${JSON.stringify(maskInfo)}`)

  /* 遮罩消失后重新取坐标 —— 位置可能因 scrollIntoView 而变化 */
  const incPos2 = await cdp.eval(`
    (() => {
      const item = ${AUTO_ITEM};
      const inc = item && item.querySelector('.el-input-number__increase');
      if (!inc) return null;
      inc.scrollIntoView({ block: 'center' });
      const r = inc.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()
  `)

  /* 诊断：坐标处到底是谁接了这个点？打空时必须能一眼看出来 */
  const diag = await cdp.eval(`
    (() => {
      const item = ${AUTO_ITEM};
      const inc = item && item.querySelector('.el-input-number__increase');
      if (!inc) return null;
      const r = inc.getBoundingClientRect();
      const at = document.elementFromPoint(${incPos2 ? incPos2.x : 0}, ${incPos2 ? incPos2.y : 0});
      return {
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        viewport: [window.innerWidth, window.innerHeight],
        hit: at ? String(at.className).slice(0, 60) : null,
        hitsTarget: at === inc || (at !== null && inc.contains(at))
      };
    })()
  `)
  console.log('  加号按钮诊断:', JSON.stringify(diag))
  check('O10 该坐标处确实命中加号按钮（没被遮挡、也没在视口外）',
        Boolean(diag) && diag.hitsTarget === true,
        diag ? `hit=${diag.hit}` : '')

  if (incPos2) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: incPos2.x, y: incPos2.y })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: incPos2.x, y: incPos2.y, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: incPos2.x, y: incPos2.y, button: 'left', clickCount: 1 })
  }
  const daysNow = await cdp.waitFor(
    `(() => {
       const item = ${AUTO_ITEM};
       const inp = item && item.querySelector('.el-input-number input');
       return inp ? inp.value : null;
     })()`,
    4000
  )
  console.log(`  天数输入框：${baseDays} → ${daysNow}`)
  check('O11 真实鼠标点击后表单里的天数确实变了（否则下面的断言是空转）',
        daysNow !== null && String(daysNow) !== String(baseDays),
        `now=${daysNow}`)

  const dirtyTip = await cdp.waitFor(
    `(() => {
       const item = ${AUTO_ITEM};
       const d = item && item.querySelector('.auto-offline-dirty');
       return d ? d.innerText.replace(/\\s+/g, ' ').trim() : null;
     })()`,
    5000
  )
  console.log('  未保存提示:', dirtyTip)
  check('O12 改了天数未保存时，页面明说「两个按钮按已保存的值执行」',
        Boolean(dirtyTip) && dirtyTip.includes(String(baseDays)),
        dirtyTip || '')

  /* 再点一次预览，应额外弹出「预览读的是已保存的 N 天」告警 */
  await cdp.eval(`
    (() => {
      const item = ${AUTO_ITEM};
      const b = [...item.querySelectorAll('button')].find((x) => x.innerText.includes('预览影响范围'));
      if (b) b.click();
      return true;
    })()
  `)
  const toast = await cdp.waitFor(
    `(() => {
       const m = document.querySelector('.el-message');
       return m ? m.innerText.replace(/\\s+/g, ' ').trim() : null;
     })()`,
    6000
  )
  console.log('  提示条:', toast)
  check('O13 未保存状态下点预览会明确告知「读的是已保存的天数」',
        Boolean(toast) && toast.includes('已保存'),
        toast || '')

  /* ---------- 点执行：只验证二次确认，然后取消 ---------- */
  await cdp.eval(`
    (() => {
      const item = ${AUTO_ITEM};
      const b = [...item.querySelectorAll('button')].find((x) => x.innerText.includes('立即执行一次'));
      if (b) b.click();
      return true;
    })()
  `)
  const boxText = await cdp.waitFor(
    `(() => {
       const b = document.querySelector('.el-message-box');
       return b ? b.innerText.replace(/\\s+/g, ' ').trim() : null;
     })()`,
    10000
  )
  console.log('  确认弹窗:', boxText)
  check('O14 点执行弹出二次确认框', Boolean(boxText))
  check('O15 确认框写出了「会动多少件」而不是空泛地问「确定吗」',
        Boolean(boxText) && boxText.includes(`${baseCount} 件`),
        boxText || '')
  check('O16 确认框明说该操作无法一键撤销', Boolean(boxText) && boxText.includes('撤销'), '')

  const shot1 = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(OUT, '01-confirm-dialog.png'), Buffer.from(shot1.data, 'base64'))
  console.log('  ✅ 01-confirm-dialog.png')

  /* 取消 —— 不碰真实数据 */
  const cancelled = await cdp.eval(`
    (() => {
      const box = document.querySelector('.el-message-box');
      if (!box) return false;
      const b = [...box.querySelectorAll('button')].find((x) => x.innerText.includes('取消'));
      if (!b) return false;
      b.click();
      return true;
    })()
  `)
  check('O17 成功点掉「取消」', cancelled === true)

  await new Promise((r) => setTimeout(r, 1200))
  const boxGone = await cdp.eval(`!document.querySelector('.el-message-box')`)
  check('O18 取消后确认框关闭', boxGone === true)

  /* ---------- 副作用复核：数据必须一件没动 ---------- */
  const afterPreview = await apiCall('GET', '/admin/goods/auto-offline', null, token)
  console.log(`  取消后复核：days=${afterPreview.data.days} count=${afterPreview.data.count}`)
  check('O19 取消没有产生任何副作用（命中件数与执行前一致）',
        afterPreview.data.count === baseCount,
        `before=${baseCount} after=${afterPreview.data.count}`)

  /*
   * ★ 最后一条：整个过程里绝不能出现过 POST ★
   * 「取消了」这件事不能只看弹窗关没关 —— 万一实现里点「立即执行」就顺手发了 POST、
   * 弹窗只是障眼法，界面同样会「看起来正常」，而数据已经被改了。
   * 用网络层的 method 判定，才是真的证据。
   */
  const posts = cdp.events
    .filter((e) => e.method === 'Network.requestWillBeSent')
    .map((e) => ({ method: e.params.request.method, path: new URL(e.params.request.url).pathname }))
    .filter((r) => r.method === 'POST' && r.path.includes('auto-offline'))
  check('O20 全程没有发出过 POST（取消前后都没有误触发执行）',
        posts.length === 0,
        posts.length ? JSON.stringify(posts) : '0 次 POST')

  const shot2 = await cdp.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(OUT, '02-after-cancel.png'), Buffer.from(shot2.data, 'base64'))
  console.log('  ✅ 02-after-cancel.png')

  chrome.kill()
  const passed = results.filter((r) => r.cond).length
  console.log(`\n汇总：通过 ${passed} / ${results.length}`)
  process.exit(passed === results.length ? 0 : 1)
})().catch((e) => {
  console.error('执行失败:', e.message)
  process.exit(1)
})
