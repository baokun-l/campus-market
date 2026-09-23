/**
 * 第十八轮验证探针（node scripts/probe-r18.cjs）
 *   ① 已售商品：禁用按钮应为「灰盖在橙上」两层叠加（底=品牌橙 + 上=中性灰纱，不是全灰、也不是灰橙混色）
 *   ② 评价不再锁定：评过 → 追加评论；追过 → 已追评（可点开查看）
 *   ③ 后台调信用分：填目标值 → 列表即时变化 + 该行高亮
 *   ④ 后台订单管理：点商品名即可打开详情抽屉
 */
const http = require('http')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const TARGET = 'http://127.0.0.1:7788'
const OUT = 'C:/wbtmp'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9345
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(d)) }).on('error', reject)
  })
}

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`) }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`) }
}

;(async () => {
  /*
   * 开跑前先确认 dist 预览服务真的在 —— 踩过一次：
   * 后台起的 preview-static 随 shell 一起死掉，探针却照跑，
   * 于是整片断言变红（.od-open 找不到、弹窗弹不出来），看起来像「代码被改坏了」，
   * 实际页面压根没加载（chrome-error://chromewebdata ERR_CONNECTION_REFUSED）。
   * 服务没起就立刻说清楚，别让人去源码里找一个不存在的 bug。
   */
  try {
    const html = await httpGet(TARGET + '/')
    if (!/id="app"|<script/.test(html)) throw new Error('响应不像 SPA 首页')
  } catch (e) {
    console.error(`\n✗ 预览服务不可用：${TARGET} —— ${e.message}`)
    console.error('  先跑：node scripts/preview-static.cjs （注意用 run_in_background，别接管道，否则随 shell 一起退出）')
    console.error('  再跑：npx vite build --emptyOutDir=false  （确认 dist 是最新的，否则验的是旧产物）\n')
    process.exit(2)
  }

  fs.mkdirSync(OUT, { recursive: true })
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(OUT, 'probe-r18-profile')}`.replace(/\//g, '\\'),
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
    const errs = []
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p.resolve(m.result) }
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        errs.push(m.params.args.map((a) => a.value ?? a.description).join(' '))
      }
      if (m.method === 'Runtime.exceptionThrown') {
        errs.push('EXC ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text))
      }
    })
    const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, { resolve: res }); ws.send(JSON.stringify({ id: i, method, params })) })
    const evalJS = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value
    const shot = async (name) => {
      const s = await send('Page.captureScreenshot', { format: 'png' })
      fs.writeFileSync(`${OUT}/${name}`, Buffer.from(s.data, 'base64'))
    }
    const go = async (p, wait = 2400) => { await send('Page.navigate', { url: TARGET + p }); await sleep(wait) }

    await send('Page.enable')
    await send('Runtime.enable')
    await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false })
    await go('/', 1800)
    await evalJS(`localStorage.setItem('c2c-user', JSON.stringify({token:'mock-token-admin'}))`)

    /* ============================ ④ 后台订单管理 ============================ */
    console.log('\n【④ 后台订单管理 · 点商品名开详情】')
    await go('/admin?tab=orders', 3200)
    const odOpen = await evalJS(`(function(){
      const el = document.querySelector('.od-open');
      return el ? { text: el.textContent.trim(), clickable: true } : null;
    })()`)
    check('订单表存在可点的商品名 .od-open', !!odOpen, odOpen ? odOpen.text.slice(0, 18) : '未找到')

    // 点商品名 → 抽屉打开
    await evalJS(`document.querySelector('.od-open')?.click()`)
    await sleep(900)
    /*
     * ⚠️ 别用 offsetParent 判可见：抽屉 overlay 是 position:fixed，
     * 而 fixed 元素的 offsetParent 恒为 null —— 之前的断言就是这么误报的。
     * 用「overlay 未被 display:none 收掉 + 盒子有实际宽高」两个条件一起判。
     */
    const drawerVisibleExpr = `(function(){
      const ds = [...document.querySelectorAll('.el-drawer')].filter(function(d){
        const ov = d.closest('.el-overlay');
        if (!ov || getComputedStyle(ov).display === 'none') return false;
        return d.getBoundingClientRect().width > 0 && d.getBoundingClientRect().height > 0;
      });
      const d = ds[ds.length - 1];
      return d ? { visible: true, count: ds.length, text: d.innerText.replace(/\\s+/g,' ').slice(0, 60) } : { visible: false, count: 0 };
    })()`
    const drawer1 = await evalJS(drawerVisibleExpr)
    check('点商品名后详情抽屉已打开', drawer1.visible, drawer1.visible ? drawer1.text.slice(0, 40) : '')
    await shot('r18-4-orders-drawer.png')

    // 关掉抽屉（ESC），再验证可反复操作
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(700)
    const closed = await evalJS(drawerVisibleExpr)
    check('抽屉可被 ESC 关闭（可反复操作）', !closed.visible)

    // 再点一次商品名，确认抽屉能重新打开（不是一次性）
    await evalJS(`document.querySelector('.od-open')?.click()`)
    await sleep(800)
    const drawer2 = await evalJS(drawerVisibleExpr)
    check('再次点击商品名仍能打开抽屉', drawer2.visible)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(600)

    // 点「订单号」等普通单元格也应打开（整行可点）
    await evalJS(`(function(){
      const r = document.querySelector('.el-table__body-wrapper tbody tr');
      r.querySelectorAll('td')[1].click();
    })()`)
    await sleep(800)
    const drawer3 = await evalJS(drawerVisibleExpr)
    check('点普通单元格（非按钮）也能开抽屉（整行可点）', drawer3.visible)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(600)

    /* ============================ ③ 后台调信用分 ============================ */
    console.log('\n【③ 后台用户管理 · 调信用分】')
    await go('/admin?tab=users', 3200)
    const before = await evalJS(`(function(){
      const rows = [...document.querySelectorAll('.el-table__body-wrapper tbody tr')];
      const r = rows.find(function(tr){ return [...tr.querySelectorAll('td')].length > 5; });
      if (!r) return null;
      const tds = [...r.querySelectorAll('td')];
      return { credit: tds[3].innerText.trim(), nick: r.querySelector('.adm-strong')?.innerText.trim() };
    })()`)
    console.log('  调整前:', JSON.stringify(before))

    await evalJS(`(function(){
      const rows = [...document.querySelectorAll('.el-table__body-wrapper tbody tr')];
      const r = rows.find(function(tr){ return [...tr.querySelectorAll('td')].length > 5; });
      [...r.querySelectorAll('button')].find(function(b){ return b.innerText.includes('调信用分'); }).click();
    })()`)
    await sleep(900)
    const boxTitle = await evalJS(`(function(){
      const b = [...document.querySelectorAll('.el-message-box')].filter(function(x){ return getComputedStyle(x.closest('.el-overlay')).display !== 'none'; }).pop();
      return b ? b.querySelector('.el-message-box__title').innerText + ' || ' + b.querySelector('.el-message-box__message').innerText : null;
    })()`)
    check('弹窗改为「填目标分值」的口径', !!boxTitle && boxTitle.includes('设置'), boxTitle ? boxTitle.slice(0, 46) : '未弹出')

    // 填一个必然不同于当前值的合法分值
    const targetVal = before && before.credit === '66' ? '67' : '66'
    await evalJS(`(function(){
      const b = [...document.querySelectorAll('.el-message-box')].filter(function(x){ return getComputedStyle(x.closest('.el-overlay')).display !== 'none'; }).pop();
      const inp = b.querySelector('input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, '');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(inp, '${targetVal}');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      [...b.querySelectorAll('button')].find(function(x){ return x.innerText.includes('保存'); }).click();
    })()`)
    await sleep(700)
    const immediate = await evalJS(`(function(){
      const rows = [...document.querySelectorAll('.el-table__body-wrapper tbody tr')];
      const r = rows.find(function(tr){ return [...tr.querySelectorAll('td')].length > 5; });
      const tds = [...r.querySelectorAll('td')];
      return { credit: tds[3].innerText.trim(), flushed: r.className.includes('row-flash') };
    })()`)
    check('保存后列表立即显示新分值', immediate.credit === targetVal, `${before ? before.credit : '?'} → ${immediate.credit}（期望 ${targetVal}）`)
    check('被改的行有高亮反馈（.row-flash）', immediate.flushed)
    const toast = await evalJS(`[...document.querySelectorAll('.el-message')].map(function(m){return m.innerText.trim()}).join(' // ')`)
    check('提示语说明「从多少到多少」', /→/.test(toast), toast)
    await shot('r18-3-credit-after.png')

    /* ============================ ② 评价不再锁定 ============================ */
    console.log('\n【② 订单中心 · 评价 / 追加评论】')
    await evalJS(`localStorage.setItem('c2c-user', JSON.stringify({token:'mock-token-user-1'}))`)
    await go('/order', 3200)
    const ordState = await evalJS(`(function(){
      const btns = [...document.querySelectorAll('.el-table__body button')].map(function(b){ return b.innerText.trim(); });
      return {
        deadTags: document.querySelectorAll('.reviewed-tag').length,
        appendBtns: btns.filter(function(t){ return t === '追加评论'; }).length,
        appendedBtns: btns.filter(function(t){ return t === '已追评'; }).length,
        reviewBtns: btns.filter(function(t){ return t === '评价'; }).length
      };
    })()`)
    console.log('  订单页评价入口:', JSON.stringify(ordState))
    check('已无「已评价」死标签（不再锁定）', ordState.deadTags === 0)
    check('存在「追加评论」入口', ordState.appendBtns > 0, `${ordState.appendBtns} 个`)
    check('已追评的订单显示为可点的「已追评」', ordState.appendedBtns > 0, `${ordState.appendedBtns} 个`)
    await shot('r18-2-order-append.png')

    // 走完一次追评：点「追加评论」→ 弹窗 → 提交
    const appendBtnIndex = await evalJS(`(function(){
      const bs = [...document.querySelectorAll('.el-table__body button')];
      return bs.findIndex(function(b){ return b.innerText.trim() === '追加评论'; });
    })()`)
    if (appendBtnIndex > -1) {
      await evalJS(`[...document.querySelectorAll('.el-table__body button')][${appendBtnIndex}].click()`)
      await sleep(900)
      const dlg = await evalJS(`(function(){
        const ds = [...document.querySelectorAll('.el-dialog')].filter(function(d){ return d.offsetParent !== null; });
        const d = ds[ds.length - 1];
        if (!d) return null;
        return {
          title: d.querySelector('.el-dialog__title')?.innerText.trim(),
          hasOrigin: !!d.querySelector('.rf-origin'),
          originTxt: d.querySelector('.rf-origin-txt')?.innerText.trim().slice(0, 24),
          hasRate: !!d.querySelector('.rf-rate')
        };
      })()`)
      check('追评弹窗标题为「追加评论」', !!dlg && dlg.title === '追加评论', dlg ? dlg.title : '未弹出')
      check('弹窗内展示只读的首评作为上下文', !!dlg && dlg.hasOrigin, dlg && dlg.originTxt ? dlg.originTxt : '')
      check('追评模式不再让改星级', !!dlg && !dlg.hasRate)
      await shot('r18-2-append-dialog.png')

      /*
       * 分两步：先只填内容，等 Vue 把「提交」按钮解禁，再点。
       * 挤在同一次求值里点，按钮还是 disabled 状态 —— 点击会被浏览器直接吞掉，
       * 看起来就像「提交没反应」。
       */
      await evalJS(`(function(){
        const d = [...document.querySelectorAll('.el-dialog')].filter(function(x){ return x.offsetParent !== null; }).pop();
        const ta = d.querySelector('textarea');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, '探针追评：用了一阵子回来补充，依旧很好用。');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      })()`)
      await sleep(500)
      const btnState = await evalJS(`(function(){
        const d = [...document.querySelectorAll('.el-dialog')].filter(function(x){ return x.offsetParent !== null; }).pop();
        const b = [...d.querySelectorAll('.el-dialog__footer button')].find(function(x){ return x.innerText.includes('提交追评'); });
        return { found: !!b, disabled: b ? b.disabled : null };
      })()`)
      check('填写后「提交追评」按钮解禁', !!btnState.found && btnState.disabled === false,
        JSON.stringify(btnState))
      await evalJS(`(function(){
        const d = [...document.querySelectorAll('.el-dialog')].filter(function(x){ return x.offsetParent !== null; }).pop();
        [...d.querySelectorAll('.el-dialog__footer button')].find(function(b){ return b.innerText.includes('提交追评'); }).click();
      })()`)
      await sleep(1800)
      const afterAppend = await evalJS(`(function(){
        const btns = [...document.querySelectorAll('.el-table__body button')].map(function(b){ return b.innerText.trim(); });
        return {
          appendedBtns: btns.filter(function(t){ return t === '已追评'; }).length,
          toast: [...document.querySelectorAll('.el-message')].map(function(m){return m.innerText.trim()}).join(' // ')
        };
      })()`)
      check('提交后该行变为「已追评」', afterAppend.appendedBtns >= ordState.appendedBtns + 1,
        `${ordState.appendedBtns} → ${afterAppend.appendedBtns}`)
      check('提交有成功提示', /追评已提交/.test(afterAppend.toast), afterAppend.toast)

      // 点「已追评」→ 我的评价弹窗（首评 + 追评）
      await evalJS(`(function(){
        const b = [...document.querySelectorAll('.el-table__body button')].find(function(x){ return x.innerText.trim() === '已追评'; });
        b.click();
      })()`)
      await sleep(900)
      const mine = await evalJS(`(function(){
        const d = [...document.querySelectorAll('.el-dialog')].filter(function(x){ return x.offsetParent !== null; }).pop();
        if (!d) return null;
        return { title: d.querySelector('.el-dialog__title')?.innerText.trim(), blocks: d.querySelectorAll('.mr-block').length,
                 appendTxt: d.querySelector('.mr-block--append .mr-txt')?.innerText.trim().slice(0,20) };
      })()`)
      check('「已追评」可点开查看（不再是死胡同）', !!mine && mine.blocks === 2, mine ? `${mine.title} / ${mine.blocks} 块` : '未弹出')
      check('查看弹窗里追评内容正确', !!mine && !!mine.appendTxt, mine && mine.appendTxt ? mine.appendTxt : '')
      await shot('r18-2-my-review.png')
    } else {
      check('找到可追评的订单', false, '页面上没有「追加评论」按钮')
    }

    /* ============================ ① 已售商品禁用按钮 ============================ */
    console.log('\n【① 已售商品 · 禁用按钮「灰盖在橙上」】')
    await go('/goods', 2600)
    const soldHref = await evalJS(`(function(){
      const links = [...document.querySelectorAll('a[href^="/goods/"]')];
      const b = links.find(function(a){ return a.querySelector('.is-sold'); });
      return b ? b.getAttribute('href') : null;
    })()`)
    if (soldHref) {
      await go(soldHref, 2400)
      const btn = await evalJS(`(function(){
        const pick = function(sel){
          const b = document.querySelector(sel);
          if (!b) return null;
          const s = getComputedStyle(b);
          return {
            disabled: b.disabled,
            bgColor: s.backgroundColor,      // 底层
            bgImage: s.backgroundImage,      // 上层（灰纱）
            color: s.color,
            border: s.borderColor,
            shadow: s.boxShadow
          };
        };
        return { flag: document.querySelector('.img-flag')?.textContent?.trim(), cart: pick('.btn-cart'), buy: pick('.btn-brand') };
      })()`)
      console.log('  按钮计算样式:', JSON.stringify(btn))

      /*
       * 口径是「灰罩在橙上」两层结构，不是「橙与灰调成的中间色」——
       * 所以断言必须拆成两条：底层仍是原来的颜色 + 上层额外叠了中性灰纱。
       * 只断言一个 backgroundColor 是查不出「是不是混色」的。
       */
      const isOrangeBase = (c) => /^rgb\(255,\s*106,\s*0\)$/.test(c)
      const hasNeutralVeil = (img) => /rgba\(104,\s*104,\s*104/.test(img) // R=G=B：中性灰，零色偏
      const isDimOrange = (c) => /^rgb\(177,\s*81,\s*15\)$/.test(c) // #b1510f：压暗的橙，色相仍是橙

      check('「立即购买」底层仍是品牌橙（橙没被调成棕）',
        isOrangeBase(btn.buy.bgColor) && btn.buy.disabled, btn.buy.bgColor)
      check('「立即购买」上层叠了中性灰纱（R=G=B，不给橙引入色偏）',
        hasNeutralVeil(btn.buy.bgImage), btn.buy.bgImage.slice(0, 58))
      check('「立即购买」内圈留一道细橙边（看得出灰纱下面罩着橙）',
        /255,\s*106,\s*0/.test(btn.buy.shadow))
      check('「加入购物车」底层是白底 + 薄灰纱（整块发闷）',
        /^rgb\(255,\s*255,\s*255\)$/.test(btn.cart.bgColor) && hasNeutralVeil(btn.cart.bgImage),
        btn.cart.bgColor + ' / ' + btn.cart.bgImage.slice(0, 46))
      check('「加入购物车」文字是压暗的橙（色相未变、未掺灰成中间色）',
        isDimOrange(btn.cart.color), btn.cart.color)
      check('两者都不是「全灰」（没有退化回 rgb(247,248,250) 底 + 灰字）',
        btn.cart.color !== 'rgb(143, 149, 158)' && btn.buy.bgColor !== 'rgb(247, 248, 250)')

      /*
       * 把「不许调成棕」量化：合成色 = 品牌橙 + 中性灰纱。
       * 判据用「与品牌橙相对比较」，不用绝对值 ——
       * 绝对值会把「压暗版」（V 很低但看着发棕）误判为合格。
       *   ① 色相偏差 < 3°：中性灰纱不引入色偏，橙的色相原地不动；
       *   ② 饱和度 > 0.7 且低于品牌橙：还被认得成橙，但已经掉了彩度；
       *   ③ 亮度低于品牌橙：被压住了，没原来那么亮、那么有能量。
       * 三条合起来 = 「橙明确可辨，但被一层灰压住」，也顺手拦住发棕的暗化版。
       *
       * ⚠️ 纱的透明度**必须从 DOM 读**，不能写死：
       * 写死过一次 0.38，后来把样式改成 0.24，断言照旧拿 0.38 算 —— 全绿，但验的是
       * 一个已经不存在的颜色（假绿）。凡是「断言里复现了一遍实现里的魔法数字」，
       * 都是一个会过期的断言。
       */
      const veilAlphaOf = (img) => {
        const m = /rgba\(104,\s*104,\s*104,\s*([\d.]+)\)/.exec(img || '')
        return m ? parseFloat(m[1]) : NaN
      }
      const deepAlpha = veilAlphaOf(btn.buy.bgImage)
      const thinAlpha = veilAlphaOf(btn.cart.bgImage)
      check('灰纱透明度能从 DOM 取出来（不是断言里写死的）',
        Number.isFinite(deepAlpha) && Number.isFinite(thinAlpha),
        `deep=${deepAlpha} thin=${thinAlpha}`)
      check('灰纱是「薄纱」级（不透明度 ≤0.3，朦胧而非压暗）',
        deepAlpha <= 0.3 && thinAlpha <= 0.1,
        `deep=${deepAlpha} · thin=${thinAlpha}`)
      check('实心款纱比描边款浓（有主次，不是一刀切）',
        deepAlpha > thinAlpha)

      const mix = (hex, veilA, veilGray) => {
        const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16)
        return [0, 1, 2].map((i) => [r, g, b][i] * (1 - veilA) + veilGray * veilA)
      }
      const hueOf = ([r, g, b]) => {
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
        if (mx === mn) return 0
        let h
        if (mx === r) h = 60 * ((g - b) / (mx - mn))
        else if (mx === g) h = 60 * (2 + (b - r) / (mx - mn))
        else h = 60 * (4 + (r - g) / (mx - mn))
        return (h + 360) % 360
      }
      const satOf = ([r, g, b]) => { const mx = Math.max(r, g, b), mn = Math.min(r, g, b); return mx === 0 ? 0 : (mx - mn) / mx }
      const valOf = ([r, g, b]) => Math.max(r, g, b) / 255
      const brand = [255, 106, 0]
      const composite = mix('#ff6a00', deepAlpha, 104)
      const hueDrift = Math.abs(hueOf(composite) - hueOf(brand))
      check('实心款合成色相与品牌橙一致（偏差 <3°，没被推向棕/黄）',
        hueDrift < 3, `漂移 ${hueDrift.toFixed(1)}°`)
      check('实心款合成色饱和度 >0.7（橙仍「明确可辨」，不是发灰的棕）',
        satOf(composite) > 0.7, `S=${satOf(composite).toFixed(2)}`)
      check('实心款饱和与亮度都低于品牌橙（读得出「被灰压住、发闷」）',
        satOf(composite) < satOf(brand) && valOf(composite) < valOf(brand),
        `S ${satOf(brand).toFixed(2)}→${satOf(composite).toFixed(2)} · V ${valOf(brand).toFixed(2)}→${valOf(composite).toFixed(2)}`)
      await shot('r18-1-sold-disabled.png')

      // 按元素实际位置裁一张放大图，肉眼核对「灰罩在橙上」是否成立
      const rect = await evalJS(`(function(){
        const a = document.querySelector('.actions');
        if (!a) return null;
        const r = a.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      })()`)
      if (rect) {
        const clipShot = await send('Page.captureScreenshot', {
          format: 'png',
          clip: { x: rect.x - 10, y: rect.y - 10, width: rect.w + 20, height: rect.h + 20, scale: 3 }
        })
        fs.writeFileSync(`${OUT}/r18-1-btn-zoom.png`, Buffer.from(clipShot.data, 'base64'))
        console.log('  放大图 -> C:/wbtmp/r18-1-btn-zoom.png')
      }
    } else {
      check('找到已售出商品', false)
    }

    // 商品详情页应能看到种子追评
    let appendFound = null
    for (let gid = 1; gid <= 40; gid++) {
      await go('/goods/' + gid, 1100)
      const got = await evalJS(`(function(){
        const a = document.querySelector('.rv-append');
        return a ? { tag: a.querySelector('.rv-append-tag')?.innerText.trim(), txt: a.querySelector('.rv-append-txt')?.innerText.trim().slice(0,26) } : null;
      })()`)
      if (got) { appendFound = { gid, ...got }; break }
    }
    check('商品详情页能渲染追评块（橙色「追评」标签）', !!appendFound,
      appendFound ? `/goods/${appendFound.gid} ${appendFound.tag} · ${appendFound.txt}` : '扫描 1-40 未找到')
    if (appendFound) await shot('r18-2-detail-append.png')

    console.log('\n控制台错误:', errs.length ? errs.slice(0, 6) : 'none')
    console.log(`\n=========== 结果：${pass} 通过 / ${fail} 失败 ===========`)
  } catch (e) {
    console.error('PROBE FAIL', e)
  } finally {
    chrome.kill()
  }
})()
