/**
 * 双独立审核后台 · 浏览器探针（node scripts/probe-review.cjs）
 *
 * 验证「商品审核后台」与「举报处理后台」两个职能独立的后台：
 *   A. 商品审核员（goods_admin）登录 → 专属页面渲染 + 侧栏只见自己的入口
 *   B. 真实发布链路造 pending 商品（同会话内存缓存，切换 token 不刷新丢数据）
 *   C. 审核流转：通过 → on_sale；驳回：理由 <5 字被拦、≥5 字 → off_shelf，记录留痕
 *   D. 举报审核员（report_admin）：待处理列表、处置弹窗（措施 + 备注 <5 字被拦）、
 *      处置成立 → 处理记录带「举报审核员」
 *   E. 权限互斥 4 连：goods_admin→举报后台、report_admin→商品后台、普通用户×2 → 全部 /403
 *   F. 全能 admin：能走路由（roles 放行）但侧栏不显示审核员专属入口（菜单互不暗示）
 *
 * ⚠️ 开跑前必须先 `npx vite build --emptyOutDir=false`（preview 供的是 dist），
 *    并启动 `node scripts/preview-static.cjs`（:7788，后台任务）。
 */
const http = require('http')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const TARGET = 'http://127.0.0.1:7788'
const OUT = 'C:/wbtmp'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9351
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
  try {
    const html = await httpGet(TARGET + '/')
    if (!/id="app"|<script/.test(html)) throw new Error('响应不像 SPA 首页')
  } catch (e) {
    console.error(`\n✗ 预览服务不可用：${TARGET} —— ${e.message}`)
    console.error('  先跑：node scripts/preview-static.cjs（run_in_background）')
    console.error('  再跑：npx vite build --emptyOutDir=false\n')
    process.exit(2)
  }

  fs.mkdirSync(OUT, { recursive: true })
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(OUT, 'probe-review-profile')}`.replace(/\//g, '\\'),
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
    const evalJS = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
      if (r?.exceptionDetails) throw new Error('eval 异常: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
      return r?.result?.value
    }
    const shot = async (name) => {
      const s = await send('Page.captureScreenshot', { format: 'png' })
      fs.writeFileSync(`${OUT}/${name}`, Buffer.from(s.data, 'base64'))
    }
    const go = async (p, wait = 3000) => {
      await send('Page.navigate', { url: TARGET + p })
      await sleep(wait)
      // 每个新 document 都要重挂助手（不依赖 addScriptToEvaluateOnNewDocument 的时序）
      await evalJS(HELPERS)
    }
    const setToken = (t) =>
      evalJS(`localStorage.setItem('c2c-user', ${JSON.stringify(JSON.stringify({ token: t }))}), localStorage.getItem('c2c-user')`)
    const where = () => evalJS(`({ path: location.pathname })`)

    // 页面助手（与 e2e-admin 同源的套路：原生 setter 触发 v-model、顶层可见 overlay）
    // ⚠️ 每次导航都会换新 document，必须用 addScriptToEvaluateOnNewDocument 挂载，
    //    只 evalJS 一次会在第一次 go() 之后被整个冲掉（踩过：__text is not a function）。
    const HELPERS = `
      window.__text = (s) => (document.querySelector(s)?.textContent || '').replace(/\\s+/g,' ').trim() || null;
      window.__texts = (s) => [...document.querySelectorAll(s)].map((n) => (n.textContent || '').replace(/\\s+/g,' ').trim());
      window.__count = (s) => document.querySelectorAll(s).length;
      window.__setNative = (el, value) => {
        if (!el) return 'not-found';
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return 'ok';
      };
      window.__setByPh = (ph, value) => {
        const el = [...document.querySelectorAll('input, textarea')].find((n) => n.placeholder === ph);
        return window.__setNative(el, value);
      };
      window.__clickByText = (t, root) => {
        const scope = root || document;
        const cands = [...scope.querySelectorAll('.el-button, button, a, label')];
        let hit = cands.find((n) => n.textContent.trim() === t);
        if (!hit) {
          const leaf = [...scope.querySelectorAll('*')].find((n) => n.children.length === 0 && n.textContent.trim() === t);
          hit = leaf ? (leaf.closest('.el-button, button, a, label') || leaf) : null;
        }
        if (!hit) return 'not-found';
        hit.click();
        return 'clicked';
      };
      window.__topOverlay = () =>
        [...document.querySelectorAll('.el-overlay')].filter((o) => getComputedStyle(o).display !== 'none').pop() || null;
      window.__toast = () => {
        const m = [...document.querySelectorAll('.el-message')].find((x) => x.getBoundingClientRect().width > 0);
        return m ? m.textContent.replace(/\\s+/g,' ').trim() : '';
      };
      window.__navLabels = () => [...document.querySelectorAll('.layout-menu .el-menu-item')].map((n) => n.textContent.trim());
      window.__kpis = () => [...document.querySelectorAll('.kpi-num')].map((n) => n.textContent.trim());
      window.__rowTitles = () => [...document.querySelectorAll('.el-table__body tr')].map((r) => (r.querySelector('.cell-title')?.textContent || '').trim()).filter(Boolean);
      window.__allTableText = () => [...document.querySelectorAll('.el-table__body')].map((t) => t.textContent || '').join(' ');
      window.__rowWith = (t) => [...document.querySelectorAll('.el-table__body tr')].find((r) => r.textContent.includes(t)) || null;
      window.__clickRowBtn = (t, btn) => {
        const row = window.__rowWith(t);
        if (!row) return 'no-row';
        const b = [...row.querySelectorAll('button')].find((x) => x.textContent.trim() === btn);
        if (!b) return 'no-btn';
        b.click();
        return 'clicked';
      };
      'ok'
    `
    await send('Page.addScriptToEvaluateOnNewDocument', { source: HELPERS })
    await evalJS(HELPERS) // 当前这个 about:blank 也补挂一次

    /* ============ A. 商品审核员：专属页面 ============ */
    console.log('\n【A】商品审核员登录 → 专属页面渲染')
    await go('/', 3200) // 先落到站点页面，否则还在 about:blank 上、localStorage 拒绝访问
    await setToken('mock-token-user-97')
    await go('/review/goods', 3400)
    const a = await evalJS(`({
      hero: window.__text('.ga-hero .hero-title'),
      badge: window.__text('.hero-badge'),
      kpis: window.__kpis(),
      nav: window.__navLabels(),
      tabs: window.__texts('.el-tabs__item'),
      is404: !!document.querySelector('.not-found, [class*="404"]')
    })`)
    check('商品审核后台页面打开（非 404）', /商品审核后台/.test(a.hero || '') && !a.is404, a.hero || '(无标题)')
    check('角色徽标「商品审核员专属」可见', /商品审核员专属/.test(a.badge || ''))
    check('KPI 四卡渲染', a.kpis.length === 4, `kpis=${JSON.stringify(a.kpis)}`)
    check('侧栏只有商品审核入口（无管理后台/举报后台）',
      a.nav.includes('商品审核后台') && !a.nav.includes('管理后台') && !a.nav.includes('举报处理后台'),
      `nav=${a.nav.join('|')}`)
    check('两个页签：待审核 / 审核记录', a.tabs.join('|').includes('待审核') && a.tabs.join('|').includes('审核记录'), a.tabs.join('|'))
    await shot('review-A-goods-audit.png')

    /* ============ B. 发布链路造 pending 商品 ============ */
    console.log('\n【B】普通用户发布商品 → 生成 pending（同会话内存缓存）')
    const T1 = `探针审核品A-${Date.now() % 100000}`
    const T2 = `探针审核品B-${Date.now() % 100000}`
    await setToken('mock-token-user-1')
    await go('/goods/publish', 3400)
    async function publish(title) {
      await evalJS(`window.__setByPh('例如：高等数学（同济第七版）九成新', ${JSON.stringify(title)})`)
      await evalJS(`window.__setByPh('¥', '66')`)
      await evalJS(`window.__setByPh('例如：计算机学院宿舍楼下', '东区宿舍楼下')`)
      await evalJS(`window.__setByPh('商品成色、使用情况、有无瑕疵等', '探针自动发布，用于审核流转验证')`)
      // 数量（无 placeholder 的数字输入框，取表单里第 2 个 el-input）
      await evalJS(`
        (function(){
          const nums = [...document.querySelectorAll('.el-form .el-input__inner')].filter((n) => n.type !== 'textarea');
          // 标题/价格/数量/地点 顺序里数量是第 3 个纯 input（价格前后可能有装饰），保险起见按值空判断
          const target = nums.find((n) => (n.value === '' || n.value === '0') && n.placeholder !== '¥' && n.placeholder.indexOf('例如') !== 0);
          if (target) { window.__setNative(target, '1'); return 'ok' }
          return 'not-found';
        })()
      `)
      // 分类下拉（teleported=false，下拉就在页面里）
      await evalJS(`document.querySelector('.el-form .el-select')?.querySelector('.el-select__wrapper, .el-select')?.click(), 'clicked'`)
      await sleep(700)
      await evalJS(`document.querySelector('.el-select-dropdown__item')?.click(), 'clicked'`)
      await sleep(500)
      await evalJS(`window.__clickByText('提交审核')`)
      await sleep(2200)
      return evalJS('window.__toast()')
    }
    const toast1 = await publish(T1)
    check('第一件商品提交成功（提示等待审核）', /等待审核|成功/.test(toast1 || ''), toast1 || '(无提示)')
    await go('/goods/publish', 3200)
    const toast2 = await publish(T2)
    check('第二件商品提交成功', /等待审核|成功/.test(toast2 || ''), toast2 || '(无提示)')

    /* ============ C. 商品审核流转 ============ */
    // 注意：整页导航会重建内存态商品池，B 段发布的商品不会留到这里；
    // 审核流转直接用种子 pending 商品（A 段 KPI 显示种子自带 11 件待审）。
    console.log('\n【C】审核员：通过 / 驳回（含理由校验）')
    await setToken('mock-token-user-97')
    await go('/review/goods', 3400)
    const c0 = await evalJS(`({ titles: window.__rowTitles(), kpi: window.__kpis()[0] })`)
    check('待审列表有种子数据（≥2 行）', c0.titles.length >= 2, `KPI待审=${c0.kpi} 行=${c0.titles.length}`)
    const TA = c0.titles[0]

    // 详情抽屉：完整商品档案（图集 / 价格 / 库存 / 交易地点 / 浏览收藏）
    await evalJS(`window.__clickRowBtn(${JSON.stringify(TA)}, '详情')`)
    await sleep(2200)
    const c0d = await evalJS(`({
      open: !!window.__topOverlay(),
      grid: [...document.querySelectorAll('.dg-item dt')].map((n) => n.textContent.trim()),
      thumbs: document.querySelectorAll('.detail-thumb').length,
      prices: (window.__text('.detail-prices') || '')
    })`)
    check('审核详情抽屉打开', c0d.open)
    check('详情字段齐全（分类/方式/地点/数量/热度/时间）', c0d.grid.length >= 6, c0d.grid.join('|'))
    check('价格区渲染（现价/划线价）', /¥/.test(c0d.prices || ''), c0d.prices || '')
    // 关掉抽屉再走「通过」
    await evalJS(`window.__topOverlay()?.querySelector('.el-drawer__close-btn')?.click(), 'x'`)
    await sleep(1400)

    // 通过第一件
    await evalJS(`window.__clickRowBtn(${JSON.stringify(TA)}, '通过')`)
    await sleep(2400)
    const c1 = await evalJS(`({ gone: !window.__rowWith(${JSON.stringify(TA)}), toast: window.__toast() })`)
    check('点「通过」后商品从待审列表消失', c1.gone, c1.toast || '')
    check('提示「已通过审核，上架售卖」', /通过审核/.test(c1.toast || ''), c1.toast || '')

    // 驳回当前第一件：理由 <5 字被拦
    const TB = (await evalJS('window.__rowTitles()'))[0]
    await evalJS(`window.__clickRowBtn(${JSON.stringify(TB)}, '驳回')`)
    await sleep(1600)
    await evalJS(`window.__setNative(window.__topOverlay()?.querySelector('textarea'), '不行')`)
    await evalJS(`window.__clickByText('确认驳回', window.__topOverlay())`)
    await sleep(900)
    const c2 = await evalJS(`({ err: window.__text('.reject-error'), open: !!window.__topOverlay() })`)
    check('驳回理由不足 5 字被拦（弹窗仍在）', c2.open && /至少 5 个字/.test(c2.err || ''), c2.err || '(未见错误)')
    // 合规理由
    await evalJS(`window.__setNative(window.__topOverlay()?.querySelector('textarea'), '图片与实物不符，请重新拍摄上传')`)
    await evalJS(`window.__clickByText('确认驳回', window.__topOverlay())`)
    await sleep(2400)
    const c3 = await evalJS(`({ gone: !window.__rowWith(${JSON.stringify(TB)}), toast: window.__toast() })`)
    check('合规理由驳回成功，商品从列表消失', c3.gone, c3.toast || '')

    // 审核记录留痕（tabs 切换后页面上可能同时有两张表，读全表文本）
    await evalJS(`window.__clickByText('审核记录')`)
    await sleep(2000)
    const c4 = await evalJS('window.__allTableText()')
    check('审核记录包含「通过上架」', c4.includes('通过上架'))
    check('审核记录包含「驳回」', c4.includes('驳回'))
    check('操作人 =「商品审核员」', c4.includes('商品审核员'))
    check('记录带被审商品标题（通过）', c4.includes(TA), TA)
    check('记录带被审商品标题（驳回）', c4.includes(TB), TB)
    check('驳回理由被记录', c4.includes('图片与实物不符'))
    await shot('review-C-goods-records.png')

    /* ============ D. 举报审核员：处置链路 ============ */
    console.log('\n【D】举报审核员：核实 + 处置 + 记录')
    await setToken('mock-token-user-98')
    await go('/review/report', 3400)
    const d0 = await evalJS(`({
      hero: window.__text('.ra-hero .hero-title'),
      nav: window.__navLabels(),
      rows: window.__count('.el-table__body tr')
    })`)
    check('举报处理后台页面打开', /举报处理后台/.test(d0.hero || ''))
    check('侧栏只有举报处理入口（无管理后台/商品后台）',
      d0.nav.includes('举报处理后台') && !d0.nav.includes('管理后台') && !d0.nav.includes('商品审核后台'),
      `nav=${d0.nav.join('|')}`)
    check('待处理举报列表有数据（种子 pending 1 条）', d0.rows >= 1, `rows=${d0.rows}`)

    // 核实抽屉：商品类举报必须能看到完整商品档案（图集/描述/价格/交易信息网格）
    await evalJS(`window.__clickRowBtn('涉嫌虚假描述', '核实')`)
    await sleep(2200)
    const d0b = await evalJS(`({
      drawer: !!window.__topOverlay(),
      desc: window.__text('.tc-desc'),
      gridLabels: [...document.querySelectorAll('.tcg-item dt')].map((n) => n.textContent.trim()),
      thumbs: document.querySelectorAll('.tc-thumb').length,
      seller: (window.__text('.tc-row') || '')
    })`)
    check('核实抽屉打开且商品描述可见', d0b.drawer && !!d0b.desc, d0b.desc || '(无描述)')
    check('商品档案网格齐全（分类/方式/地点/数量/热度/时间）',
      d0b.gridLabels.length >= 6, d0b.gridLabels.join('|'))
    check('图集缩略图渲染（可切换主图）', d0b.thumbs >= 1, `thumbs=${d0b.thumbs}`)
    check('卖家信息可见', /卖家/.test(d0b.seller || ''), d0b.seller || '')
    await shot('review-D-brief-goods.png')

    // 从抽屉里进处置弹窗
    await evalJS(`window.__clickByText('处置举报', window.__topOverlay())`)
    await sleep(1800)
    const d1 = await evalJS(`({
      open: !!window.__topOverlay(),
      measures: [...(window.__topOverlay()?.querySelectorAll('.measure-label') || [])].map((n) => n.textContent.trim())
    })`)
    check('处置弹窗打开且措施列表渲染', d1.open && d1.measures.length >= 2, d1.measures.join('|'))
    // 备注不足 5 字被拦
    await evalJS(`window.__setNative(window.__topOverlay()?.querySelector('textarea'), '短')`)
    await evalJS(`window.__clickByText('执行处置', window.__topOverlay())`)
    await sleep(900)
    const d2 = await evalJS(`window.__text('.handle-error')`)
    check('处理备注不足 5 字被拦', /至少 5 个字/.test(d2 || ''), d2 || '(未见错误)')
    // 选「下架商品」+ 合规备注
    await evalJS(`window.__clickByText('下架商品', window.__topOverlay())`)
    await sleep(400)
    await evalJS(`window.__setNative(window.__topOverlay()?.querySelector('textarea'), '经核实为违规描述，先下架处理')`)
    await evalJS(`window.__clickByText('执行处置', window.__topOverlay())`)
    await sleep(2400)
    const d3 = await evalJS(`window.__toast()`)
    check('处置成功提示', /已处置/.test(d3 || ''), d3 || '(无提示)')

    // 处理记录
    await evalJS(`window.__clickByText('处理记录')`)
    await sleep(2000)
    const d4 = await evalJS('window.__allTableText()')
    check('处理记录包含「处置成立」', d4.includes('处置成立'))
    check('处理记录包含「下架商品」措施', d4.includes('下架商品'))
    check('处理人 =「举报审核员」', d4.includes('举报审核员'))
    check('处置说明留痕（对象现状）', d4.includes('已下架商品'))
    await shot('review-D-report-records.png')

    /* ============ E. 权限互斥 4 连 ============ */
    console.log('\n【E】权限互斥：串门一律 403')
    const cases = [
      ['goods_admin（97）→ 举报后台', 'mock-token-user-97', '/review/report'],
      ['report_admin（98）→ 商品后台', 'mock-token-user-98', '/review/goods'],
      ['普通用户（5）→ 商品后台', 'mock-token-user-5', '/review/goods'],
      ['普通用户（5）→ 举报后台', 'mock-token-user-5', '/review/report']
    ]
    for (const [label, token, path] of cases) {
      await setToken(token)
      await go(path, 3000)
      const w = await where()
      check(label + ' 被拦到 /403', w.path === '/403', `path=${w.path}`)
    }
    await shot('review-E-403.png')

    /* ============ F. 全能 admin：路由放行、菜单不显示 ============ */
    console.log('\n【F】全能 admin：路由放行但菜单互不暗示')
    await setToken('mock-token-admin')
    await go('/home', 3200)
    const f0 = await evalJS('({ nav: window.__navLabels() })')
    check('admin 侧栏无审核员专属入口', !f0.nav.includes('商品审核后台') && !f0.nav.includes('举报处理后台'),
      `nav=${f0.nav.join('|')}`)
    await go('/review/goods', 3200)
    const f1 = await where()
    check('admin 直进商品审核后台不 403（roles 含 admin）', f1.path === '/review/goods', `path=${f1.path}`)

    /* ============ 汇总 ============ */
    const realErrs = errs.filter((e) => !/favicon|DevTools/i.test(e))
    check('零控制台错误', realErrs.length === 0, realErrs.slice(0, 3).join(' ;; '))

    console.log(`\n═══ probe-review 汇总：${pass} 通过 / ${fail} 失败 ═══`)
    console.log('截图目录：' + OUT)
  } finally {
    chrome.kill()
  }
  process.exit(fail ? 1 : 0)
})()
