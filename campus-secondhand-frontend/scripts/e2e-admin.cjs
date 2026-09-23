/**
 * 端到端验证：管理后台 10 个页签
 *
 * 后台是一堆「列表 + 批量操作 + 弹窗」的组合，光看构建成功说明不了问题，
 * 所以这里用 CDP 真跑一遍：逐个点开页签、读 DOM、点几个关键交互（勾选行 → 批量条、
 * 展开订单、切子视图、改参数），把「页面到底渲染出了什么」变成可断言的文本。
 *
 * 用法：node scripts/e2e-admin.cjs
 * 前置：npx vite build && node scripts/preview-static.cjs （dist 静态服务 :7788）
 */
const http = require('http')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const TARGET = 'http://127.0.0.1:7788'
const OUT = 'C:/wbtmp'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9336

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let d = ''
        res.on('data', (c) => (d += c))
        res.on('end', () => resolve(d))
      })
      .on('error', reject)
  })
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
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error('timeout ' + method))
        }
      }, 30000)
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error('eval 异常: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails))
    return r.result.value
  }
  async probe() {
    const raw = await this.eval('JSON.stringify(window.__probe())')
    return JSON.parse(raw)
  }
}

const HELPERS = `
window.__q = (s) => document.querySelector(s);
window.__count = (s) => document.querySelectorAll(s).length;
window.__text = (s) => (document.querySelector(s)?.textContent || '').replace(/\\s+/g, ' ').trim() || null;
window.__texts = (s) => [...document.querySelectorAll(s)].map((n) => (n.textContent || '').replace(/\\s+/g, ' ').trim());
// 点左侧导航（按 visible label 精确匹配，避开角标数字）
window.__clickNav = (label) => {
  const btn = [...document.querySelectorAll('.nav-item')].find(
    (b) => b.querySelector('.nav-label')?.textContent.trim() === label
  );
  if (!btn) return 'not-found';
  btn.click();
  return 'clicked';
};
// 按文字点任意可点元素（radio-button / button / label 都能命中）
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
// 勾选 el-table 第 i 行的复选框
window.__checkRow = (i = 0) => {
  const rows = [...document.querySelectorAll('.el-table__body tr')];
  const cb = rows[i]?.querySelector('.el-checkbox__inner');
  if (!cb) return 'no-checkbox';
  cb.click();
  return 'clicked';
};
// 展开 el-table 第 i 行（点击展开箭头）
window.__expandRow = (i = 0) => {
  const rows = [...document.querySelectorAll('.el-table__body tr')];
  const icon = rows[i]?.querySelector('.el-table__expand-icon');
  if (!icon) return 'no-expand';
  icon.click();
  return 'clicked';
};
// 往 Vue 受控输入写值：必须走原生 setter + input 事件，否则 v-model 不更新。
// 注意 textarea 与 input 是两套 prototype，用错会抛 "Illegal invocation"。
window.__setNative = (el, value) => {
  if (!el) return 'not-found';
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return 'ok';
};
window.__setInput = (selector, value) => window.__setNative(document.querySelector(selector), value);
// 是否有可见弹窗 —— 必须以「顶层可见 overlay」为准，
// 直接取第一个 .el-overlay 会被已关闭（display:none）的旧弹窗骗到
window.__dialogOpen = () => !!window.__topOverlay();
/*
 * 顶层可见弹窗。
 * el-dialog / el-drawer 都是 append-to-body，关闭后 DOM **不会移除**（只 display:none），
 * 所以 document.querySelector('.el-dialog textarea') 会命中上一个已关闭弹窗里的控件
 * —— 踩过一次：备注写进了「新建公告」，举报弹窗拿到的还是空备注。
 */
window.__topOverlay = () =>
  [...document.querySelectorAll('.el-overlay')]
    .filter((o) => getComputedStyle(o).display !== 'none')
    .pop() || null;
window.__inTopDialog = (sel) => window.__topOverlay()?.querySelector(sel) || null;
window.__topDialogTitle = () => (window.__inTopDialog('.el-dialog__title')?.textContent || '').trim() || null;
window.__setInTopDialog = (sel, value) => window.__setNative(window.__inTopDialog(sel), value);
window.__textInTopDialog = (sel) =>
  (window.__inTopDialog(sel)?.textContent || '').replace(/\\s+/g, ' ').trim() || null;
window.__probe = () => ({
  activeNav: document.querySelector('.nav-item.is-active .nav-label')?.textContent.trim() || null,
  navLabels: [...document.querySelectorAll('.nav-item .nav-label')].map((n) => n.textContent.trim()),
  navGroups: [...document.querySelectorAll('.nav-group-title')].map((n) => n.textContent.trim()),
  navBadges: [...document.querySelectorAll('.nav-item')].map((b) => ({
    label: b.querySelector('.nav-label')?.textContent.trim(),
    badge: b.querySelector('.nav-badge')?.textContent.trim() || null
  })).filter((x) => x.badge),
  todoLabels: [...document.querySelectorAll('.adm-todo-item .adm-todo-label')].map((n) => n.textContent.trim()),
  todoValues: [...document.querySelectorAll('.adm-todo-item .adm-todo-value')].map((n) => n.textContent.trim()),
  kpiValues: [...document.querySelectorAll('.adm-kpi-value')].map((n) => n.textContent.replace(/\\s+/g, ' ').trim()),
  chartCanvas: document.querySelectorAll('.adm-card canvas').length,
  hotRows: document.querySelectorAll('.adm-card .el-table__body tr').length,
  cardTitles: [...document.querySelectorAll('.adm-card-title')].map((n) => n.textContent.trim()),
  tableRows: document.querySelectorAll('.el-table__body tr.el-table__row').length,
  // 表格是否横向溢出。
  // 注意：EP 的滚动容器是 .el-scrollbar__wrap，量 .el-table__body-wrapper 的 scrollWidth
  // 永远等于 clientWidth（看不出问题）。真正能反映「内容被切掉」的现象是
  // sticky 定位的 fixed 列压到了相邻普通列上 —— 直接比值。
  tables: [...document.querySelectorAll('.el-table')].map((t) => {
    const w = t.querySelector('.el-table__body-wrapper');
    const body = t.querySelector('.el-table__body');
    const ths = [...t.querySelectorAll('.el-table__header th')];
    const fixedTh = ths.find((th) => getComputedStyle(th).position === 'sticky');
    let overlap = 0;
    if (fixedTh) {
      const fr = fixedTh.getBoundingClientRect();
      for (const th of ths) {
        if (th === fixedTh || getComputedStyle(th).position === 'sticky') continue;
        const r = th.getBoundingClientRect();
        if (r.right > fr.left + 1) overlap = Math.max(overlap, Math.round(r.right - fr.left));
      }
    }
    return {
      client: w?.clientWidth || 0,
      table: body?.offsetWidth || 0,
      overlap,
      // 单元格内容溢出：会触发 .cell 的 text-overflow:ellipsis，
      // 在列内多画一个 "…"（曾出现于内容审核的「删除」列）
      cellOverflow: [...t.querySelectorAll('td .cell')]
        .map((c) => ({ c, head: ths[c.closest('td')?.cellIndex]?.textContent.trim() || '?' }))
        .filter((o) => o.c.scrollWidth > o.c.clientWidth + 0.5)
        .map(
          (o) =>
            o.head + '「' + o.c.textContent.trim().slice(0, 12) + '」' +
            '(' + Math.round(o.c.scrollWidth) + '>' + Math.round(o.c.clientWidth) + ')'
        )
    }
  }),
  batchText: document.querySelector('.adm-batch')?.textContent.replace(/\\s+/g, ' ').trim() || null,
  tags: [...document.querySelectorAll('.el-table__body .el-tag')].map((n) => n.textContent.trim()),
  detailOpen: document.querySelectorAll('.order-detail').length,
  timelineLen: document.querySelectorAll('.timeline li').length,
  catCards: document.querySelectorAll('.cat-card:not(.cat-add)').length,
  catNames: [...document.querySelectorAll('.cat-name')].map((n) => n.textContent.trim()),
  catCounts: [...document.querySelectorAll('.cat-count')].map((n) => n.textContent.trim()),
  formItems: [...document.querySelectorAll('.set-form .el-form-item__label')].map((n) => n.textContent.trim()),
  exportCards: [...document.querySelectorAll('.export-card .adm-strong')].map((n) => n.textContent.trim()),
  radioLabels: [...document.querySelectorAll('.el-radio-button__inner')].map((n) => n.textContent.trim()),
  rateCount: document.querySelectorAll('.el-rate').length,
  actRows: document.querySelectorAll('.act-table .el-table__body tr').length,
  actBar: document.querySelector('.act-bar-right')?.textContent.replace(/\\s+/g, ' ').trim() || null,
  dialogTitle: document.querySelector('.el-dialog__title')?.textContent.trim() || null
});
'ready'`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
function check(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? '  ✅' : '  ❌'} ${name}${detail !== undefined ? ' — ' + detail : ''}`)
}

/** 表格宽度断言：列宽合计超过容器时，sticky 的 fixed 操作列会压住相邻列 */
function checkNoOverflow(label, p) {
  const bad = p.tables.filter((t) => t.overlap > 0 || t.table > t.client + 2 || t.cellOverflow.length > 0)
  check(
    `${label}：表格未横向溢出 / 单元格未溢出`,
    bad.length === 0,
    bad.length
      ? bad
          .map(
            (t) =>
              `操作列压住相邻列 ${t.overlap}px（表格 ${t.table} / 容器 ${t.client}）` +
              (t.cellOverflow.length ? `；单元格溢出：${t.cellOverflow.join('、')}` : '')
          )
          .join('；')
      : p.tables.map((t) => `${t.table}/${t.client}`).join(' ')
  )
}

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${path.join(OUT, 'chrome-e2e-admin-profile')}`.replace(/\//g, '\\'),
      '--no-first-run',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      '--disable-extensions',
      'about:blank'
    ],
    { stdio: 'ignore' }
  )

  for (let i = 0; i < 50; i++) {
    try {
      await httpGet(`http://127.0.0.1:${PORT}/json/version`)
      break
    } catch {
      await sleep(300)
    }
  }
  const list = JSON.parse(await httpGet(`http://127.0.0.1:${PORT}/json/list`))
  const page = list.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', rej)
  })
  const cdp = new CDP(ws)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })

  const goto = async (p, wait = 3600) => {
    await cdp.send('Page.navigate', { url: `${TARGET}${p}` })
    await sleep(wait)
    await cdp.eval(HELPERS)
  }
  const openTab = async (label, wait = 1300) => {
    const r = await cdp.eval(`window.__clickNav(${JSON.stringify(label)})`)
    await sleep(wait)
    return r
  }
  const shot = async (name) => {
    const s = await cdp.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(OUT, name), Buffer.from(s.data, 'base64'))
  }

  console.log('\n【1】登录管理员，检查左侧分组导航')
  await cdp.send('Page.navigate', { url: `${TARGET}/login` })
  await sleep(1600)
  await cdp.eval(
    `localStorage.removeItem('c2c-activities');localStorage.removeItem('c2c-activity');` +
      `localStorage.removeItem('c2c-settings');localStorage.removeItem('c2c-audit-logs');` +
      `localStorage.setItem('c2c-user', JSON.stringify({token:'mock-token-admin'}));'ok'`
  )
  await goto('/admin', 4200)
  let p = await cdp.probe()

  const EXPECT_NAV = [
    '数据看板',
    '商品审核',
    '用户管理',
    '订单管理',
    '公告管理',
    '活动管理',
    '分类管理',
    '内容审核',
    '举报处理',
    '系统设置'
  ]
  check('导航共 10 项且顺序正确', JSON.stringify(p.navLabels) === JSON.stringify(EXPECT_NAV), p.navLabels.join(' / '))
  check('导航分为 4 组', p.navGroups.length === 4, p.navGroups.join(' / '))
  check('默认停在「数据看板」', p.activeNav === '数据看板', p.activeNav)
  check(
    '角标挂在有待办的页签上',
    p.navBadges.length >= 1 && p.navBadges.every((b) => ['商品审核', '用户管理', '举报处理'].includes(b.label)),
    JSON.stringify(p.navBadges)
  )

  console.log('\n【2】数据看板：待办 / KPI / 图表 / 热销榜')
  check('待办卡 3 个', p.todoLabels.length === 3, p.todoLabels.join(' / '))
  check(
    '待办含商品·用户·举报三类',
    p.todoLabels.join('|') === '待审核商品|待审核用户|待处理举报',
    p.todoLabels.join(' / ')
  )
  check('KPI 卡 6 张且首张为累计成交额', p.kpiValues.length === 6 && /¥/.test(p.kpiValues[0]), p.kpiValues.join(' | '))
  check('GMV 有真实数值（非 0 占位）', /¥[1-9]/.test(p.kpiValues[0]), p.kpiValues[0])
  check('趋势图与饼图已渲染 canvas', p.chartCanvas >= 2, `${p.chartCanvas} 个 canvas`)
  check('热销榜有数据行', p.hotRows > 0, `${p.hotRows} 行`)
  checkNoOverflow('数据看板 · 热销榜', p)
  await shot('admin-e2e-dash.png')

  console.log('\n【3】点待办卡应跳到「商品审核」')
  await cdp.eval(`document.querySelectorAll('.adm-todo-item')[0].click()`)
  await sleep(1500)
  p = await cdp.probe()
  check('导航高亮切到「商品审核」', p.activeNav === '商品审核', p.activeNav)
  check('商品审核表格有数据', p.tableRows > 0, `${p.tableRows} 行`)
  checkNoOverflow('商品审核', p)

  console.log('\n【4】商品审核：勾选行 → 批量条出现')
  check('未选中时无批量条', p.batchText === null, String(p.batchText))
  const ck = await cdp.eval(`window.__checkRow(0)`)
  await sleep(400)
  const ck2 = await cdp.eval(`window.__checkRow(1)`)
  await sleep(500)
  p = await cdp.probe()
  check('勾选 2 行后出现批量条', !!p.batchText && /已选 2 件/.test(p.batchText), p.batchText)
  check(
    '批量条提供上架/下架/删除',
    /批量上架/.test(p.batchText) && /批量下架/.test(p.batchText) && /批量删除/.test(p.batchText),
    p.batchText
  )
  await cdp.eval(`window.__clickByText('取消选择')`)
  await sleep(500)
  p = await cdp.probe()
  check('取消选择后批量条消失', p.batchText === null, String(p.batchText))
  check('勾选动作均被响应', ck === 'clicked' && ck2 === 'clicked', `${ck} / ${ck2}`)
  await shot('admin-e2e-goods.png')

  console.log('\n【4.1】商品审核：点行打开详情抽屉（回归：审核看不到商品信息）')
  const opened = await cdp.eval(
    `(function(){ const t = document.querySelector('.el-table__body tr td .gp-open'); if(!t) return 'no-title'; t.click(); return 'clicked'; })()`
  )
  await sleep(800)
  check('商品标题可点击', opened === 'clicked', opened)
  const drawer = JSON.parse(
    await cdp.eval(`JSON.stringify({
      open: !!document.querySelector('.el-drawer'),
      name: (document.querySelector('.gp-name')?.textContent || '').trim() || null,
      cover: !!document.querySelector('.gp-cover-img img'),
      dl: [...document.querySelectorAll('.el-drawer .adm-dl-item > span')].map(n => n.textContent.trim()),
      descLen: (document.querySelector('.gp-desc')?.textContent || '').trim().length,
      ops: [...document.querySelectorAll('.gp-ops button')].map(b => b.textContent.trim()),
      note: (document.querySelector('.gp-note')?.textContent || '').replace(/\\s+/g, ' ').trim() || null
    })`)
  )
  check('抽屉已打开并显示商品', drawer.open && !!drawer.name, drawer.name)
  check('抽屉显示商品封面', drawer.cover)
  check(
    '价格拆分覆盖 挂牌/实付/让利/补贴/实收',
    // 让利与补贴项带「（本次活动出资方）」后缀，所以用前缀匹配
    ['卖家挂牌价', '买家实付', '卖家让利', '平台补贴', '卖家实收'].every((t) => drawer.dl.some((d) => d.startsWith(t))),
    drawer.dl.join(' / ')
  )
  check('给出结算恒等式说明', /挂牌价/.test(drawer.note || '') && /卖家实收/.test(drawer.note || ''), drawer.note)
  check('抽屉内含商品描述', drawer.descLen > 10, `${drawer.descLen} 字`)
  check('抽屉底部有处置按钮', drawer.ops.length >= 1, drawer.ops.join(' / '))
  await shot('admin-e2e-goods-detail.png')
  await cdp.eval(
    `(function(){ const bs = [...document.querySelectorAll('.gp-detail-head button')]; const b = bs[bs.length - 1]; if(b) b.click(); return 'closed'; })()`
  )
  await sleep(800)
  // 抽屉关闭后 DOM 仍在（el-drawer 只切 display），所以判「不可见」而不是「不存在」
  check('关闭后抽屉不再显示', (await cdp.eval(`window.__dialogOpen()`)) === false)

  console.log('\n【5】用户管理：状态细分（正常 / 待审核 / 已封禁）')
  await openTab('用户管理')
  p = await cdp.probe()
  check('用户表有数据', p.tableRows > 0, `${p.tableRows} 行`)
  checkNoOverflow('用户管理', p)
  const uTags = p.tags.join('|')
  check('状态标签含「待审核」（旧版把它错标成已封禁）', /待审核/.test(uTags), uTags.slice(0, 120))
  const uban = await cdp.eval(`window.__checkRow(0)`)
  await sleep(500)
  p = await cdp.probe()
  check('用户支持批量封禁/解封', !!p.batchText && /批量封禁/.test(p.batchText) && /批量解封/.test(p.batchText), p.batchText)
  check('用户行可勾选', uban === 'clicked', uban)

  /* ---- 第十六轮：更多用户操作 + 他人主页链接 ---- */
  const umore = await cdp.eval(
    `JSON.stringify({
      more: document.querySelectorAll('.adm-more-btn').length,
      links: document.querySelectorAll('.up-link').length,
      adjust: [...document.querySelectorAll('.el-table__body button')].filter((b) => b.textContent.includes('调信用分')).length
    })`
  )
  const um = JSON.parse(umore)
  check('用户行有「更多」操作下拉', um.more >= 1, `${um.more} 个`)
  check('用户名可点进他人主页', um.links >= 1, `${um.links} 个链接`)
  check('保留「调信用分」快捷操作', um.adjust >= 1, `${um.adjust} 个`)

  console.log('\n【6】订单管理：展开行 → 地址 + 时间线')
  await openTab('订单管理')
  p = await cdp.probe()
  check('订单表有数据', p.tableRows > 0, `${p.tableRows} 行`)
  checkNoOverflow('订单管理', p)
  check('订单状态标签渲染', p.tags.length > 0, p.tags.slice(0, 6).join('/'))
  const ex = await cdp.eval(`window.__expandRow(0)`)
  await sleep(700)
  p = await cdp.probe()
  check('详情出现订单进度区', p.detailOpen === 1, `detailOpen=${p.detailOpen}`)
  /*
   * 6 段而不是 5 段：时间线补了「完成」这一节点。
   * 收货与完成是状态机上的两条边，共用一个时间戳会让操作日志里出现
   * 两条同秒记录，追溯时看不出先后，所以拆成两段。
   */
  check('详情含 6 段订单进度时间线（下单/付款/发货/收货/完成/退款）', p.timelineLen === 6, `${p.timelineLen} 段`)

  /* ---- 第十六轮：订单操作收进详情抽屉 + 状态机不可逆 ---- */
  const rowBtns = await cdp.eval(
    `JSON.stringify([...document.querySelectorAll('.el-table__body tr td:last-child button')].map((b) => b.textContent.trim()).slice(0, 6))`
  )
  check('订单行内只剩「详情」入口（写操作收进抽屉）', rowBtns.includes('详情') && !rowBtns.includes('退款') && !rowBtns.includes('标记付款'), rowBtns)

  await cdp.eval(
    `(function(){ const b=[...document.querySelectorAll('.el-table__body tr td:last-child button')].find((x)=>x.textContent.includes('详情')); if(!b) return 'no-btn'; b.click(); return 'clicked'; })()`
  )
  await sleep(900)
  const odrawer = await cdp.eval(
    `JSON.stringify({
      open: (() => { const d=[...document.querySelectorAll('.el-drawer')].find((x) => x.offsetParent !== null || getComputedStyle(x).display !== 'none'); return !!d })(),
      hasOps: !![...document.querySelectorAll('.el-drawer p.od-block-title')].find((n) => n.textContent.includes('订单操作')),
      flow: ([...document.querySelectorAll('.el-drawer .od-flow')].pop()?.textContent || '').replace(/\\s+/g, ' ').trim(),
      ops: [...document.querySelectorAll('.el-drawer .od-ops button')].map((b) => b.textContent.trim()),
      note: ([...document.querySelectorAll('.el-drawer .od-ops .od-note')].pop()?.textContent || '').replace(/\\s+/g, ' ').trim()
    })`
  )
  const dr = JSON.parse(odrawer)
  check('详情抽屉已打开且含「订单操作」区', dr.open && dr.hasOps, `open=${dr.open}`)
  check(
    '抽屉显示状态机流向提示',
    /^流向：/.test(dr.flow) || /已终结/.test(dr.flow) || /无后续/.test(dr.flow) || /无可用/.test(dr.note),
    dr.flow || dr.note
  )
  /*
   * 抽屉里的操作按钮由状态机（ORDER_TRANSITIONS）生成，只应出现「合法的下一步」。
   * 白名单随状态机一起维护：售后单（refunding）的出口是
   * 「同意退款并关闭 / 驳回申请，恢复交易」，关闭订单要写原因，所以是独立按钮。
   */
  const LEGAL_OPS = [
    '标记付款',
    '关闭订单',
    '发货',
    '退款',
    '确认收货',
    '完成订单',
    '同意退款并关闭',
    '驳回申请，恢复交易'
  ]
  const OPS_NOTE = /已终结|无可用|没有可用的流转操作/
  check(
    '抽屉操作与状态机一致（终态无按钮，进行中只出现合法操作）',
    (dr.ops.length === 0 && OPS_NOTE.test(dr.note)) || (dr.ops.length > 0 && dr.ops.every((o) => LEGAL_OPS.includes(o))),
    dr.ops.join('/') || dr.note.slice(0, 30)
  )
  /* 售后单必须有出口：申请了退款却审不了，等于开了入口没有出口 */
  await cdp.eval(
    `(function(){ const w=document.querySelector('.adm-select .el-select__wrapper'); if(w) w.click(); return !!w })()`
  )
  await sleep(600)
  await cdp.eval(
    `(function(){
      const it=[...document.querySelectorAll('.el-select-dropdown__item')].filter((i)=>i.getBoundingClientRect().width>0);
      const t=it.find((i)=>i.innerText.trim()==='退款中');
      if(t) t.click();
      return !!t;
    })()`
  )
  await sleep(1200)
  const refundRows = await cdp.eval(`document.querySelectorAll('.el-table__body tr.el-table__row').length`)
  check('按「退款中」筛选出售后单（种子里有 2 笔）', refundRows > 0, `${refundRows} 行`)
  await cdp.eval(
    `(function(){ const b=[...document.querySelectorAll('.el-table__body tr td:last-child button')].find((x)=>x.textContent.includes('详情')); if(b) b.click(); return !!b })()`
  )
  await sleep(900)
  const refundOps = await cdp.eval(
    `JSON.stringify([...document.querySelectorAll('.el-drawer .od-ops button')].map((b) => b.textContent.trim()))`
  )
  const rOps = JSON.parse(refundOps)
  check(
    '售后单在抽屉里有「同意退款 / 驳回申请」两个出口',
    rOps.includes('同意退款并关闭') && rOps.some((o) => o.includes('驳回')),
    rOps.join('/') || '(无按钮)'
  )
  const drawerInfo = await cdp.eval(
    `(function(){
      const t=document.querySelector('.el-drawer .od-timeline');
      const done=[...(t?.querySelectorAll('li.done')||[])].map((li)=>li.textContent.replace(/\\s+/g,' ').trim());
      return JSON.stringify({
        doneNodes: done.length,
        logs: document.querySelectorAll('.el-drawer .od-logs li').length,
        traces: document.querySelectorAll('.el-drawer .od-trace-list li').length,
        pairs: document.querySelectorAll('.el-drawer .od-party').length
      });
    })()`
  )
  const rs = JSON.parse(drawerInfo)
  check('抽屉里渲染了操作日志（谁在什么时候做了什么）', rs.logs > 0, `${rs.logs} 条`)
  check('已发货的售后单在抽屉里有物流轨迹', rs.traces > 0, `${rs.traces} 条`)
  check('抽屉里给了买卖双方卡片（含信用分）', rs.pairs === 2, `${rs.pairs} 张`)
  await shot('admin-e2e-refund-drawer.png')
  await cdp.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))`)
  await sleep(600)
  // 复原筛选，避免影响后续「公告管理」等页签的断言
  await cdp.eval(
    `(function(){
      const w=document.querySelector('.adm-select .el-select__wrapper'); if(!w) return false;
      w.dispatchEvent(new MouseEvent('mouseenter',{bubbles:true}));
      w.click();
      return true;
    })()`
  )
  await sleep(500)
  await cdp.eval(
    `(function(){
      const c=document.querySelector('.adm-select .el-select__clear');
      if(c){ c.click(); return true }
      const it=[...document.querySelectorAll('.el-select-dropdown__item')].filter((i)=>i.getBoundingClientRect().width>0);
      const t=it.find((i)=>i.innerText.trim()==='全部状态'||i.innerText.trim()==='');
      if(t){ t.click(); return true }
      return false;
    })()`
  )
  await sleep(900)
  await shot('admin-e2e-order-drawer.png')
  /* 抽屉是 :with-header="false"，没有关闭按钮 → 用 ESC 关闭（与真实用户一致） */
  await cdp.eval(
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }))`
  )
  await sleep(700)
  const drawerClosed = await cdp.eval(
    `![...document.querySelectorAll('.el-drawer')].some((d) => getComputedStyle(d).display !== 'none' && d.offsetParent !== null)`
  )
  check('ESC 可关闭订单抽屉（不挡后续弹窗判断）', drawerClosed === true, `closed=${drawerClosed}`)
  await shot('admin-e2e-orders.png')

  console.log('\n【7】公告管理：列表 + 新建弹窗')
  await openTab('公告管理')
  p = await cdp.probe()
  check('公告卡片标题正确', p.cardTitles.includes('公告管理'), p.cardTitles.join(' / '))
  check('公告表有数据', p.tableRows > 0, `${p.tableRows} 行`)
  checkNoOverflow('公告管理', p)
  await cdp.eval(`window.__clickByText('新建公告')`)
  await sleep(700)
  p = await cdp.probe()
  check('弹出「新建公告」弹窗', p.dialogTitle === '新建公告', p.dialogTitle)
  await cdp.eval(`window.__setInput('.el-dialog .el-input__inner', 'E2E 冒烟公告')`)
  await sleep(200)
  await cdp.eval(`window.__setInput('.el-dialog textarea', '本公告由 e2e 脚本创建，用于验证后台发布链路。')`)
  await sleep(200)
  const before = p.tableRows
  await cdp.eval(`window.__clickByText('保存公告')`)
  await sleep(1500)
  p = await cdp.probe()
  check('保存后列表新增一条', p.tableRows === before + 1, `${before} → ${p.tableRows}`)
  check('新公告标题出现在列表中', (await cdp.eval(`document.body.textContent.includes('E2E 冒烟公告')`)) === true)
  // el-dialog 关闭后 DOM 仍保留（v-show），所以只能按计算样式判断可见性
  check('保存后弹窗已关闭', (await cdp.eval(`window.__dialogOpen()`)) === false)

  console.log('\n【8】活动管理：多活动列表（回归重点）')
  await openTab('活动管理')
  p = await cdp.probe()
  check('活动列表 4 条（出厂）', p.actRows === 4, `${p.actRows} 条`)
  check('统计条显示活动数量', /共\s*4\s*个活动/.test(p.actBar || ''), p.actBar)
  checkNoOverflow('活动管理', p)

  console.log('\n【9】分类管理：卡片网格')
  await openTab('分类管理')
  p = await cdp.probe()
  // 出厂 9 个分类：前 8 个是业务分类，第 9 个是兜底的「其他」
  check('分类卡 9 张（出厂）', p.catCards === 9, `${p.catCards} 张：${p.catNames.join('/')}`)
  check('最后一个分类是「其他」', p.catNames[p.catNames.length - 1] === '其他', p.catNames.join('/'))
  check('每张卡显示商品数', p.catCounts.length === 9 && p.catCounts.every((c) => /件$/.test(c)), p.catCounts.join(' '))
  check('存在虚线「新建分类」入口', (await cdp.eval(`window.__count('.cat-add')`)) === 1)
  await shot('admin-e2e-categories.png')

  console.log('\n【10】内容审核：留言 / 评价 双视图 + 差评筛选')
  await openTab('内容审核')
  p = await cdp.probe()
  check('默认展示商品留言', p.radioLabels.includes('商品留言') && p.radioLabels.includes('用户评价'), p.radioLabels.join(' / '))
  const commentRows = p.tableRows
  check('留言列表有数据', commentRows > 0, `${commentRows} 行`)
  checkNoOverflow('内容审核 · 留言', p)
  check('留言带「留言 / 回复」类型标签', p.tags.some((t) => t === '留言' || t === '回复'), p.tags.slice(0, 6).join('/'))
  await cdp.eval(`window.__clickByText('用户评价')`)
  await sleep(1500)
  p = await cdp.probe()
  const reviewRows = p.tableRows
  check('切到用户评价有数据', reviewRows > 0, `${reviewRows} 行`)
  check('评价渲染了星级组件', p.rateCount > 0, `${p.rateCount} 个 el-rate`)
  await shot('admin-e2e-content.png')

  console.log('\n【11】举报处理：统计条 + 类型筛选')
  await openTab('举报处理')
  p = await cdp.probe()
  check('举报表有数据', p.tableRows > 0, `${p.tableRows} 行`)
  checkNoOverflow('举报处理', p)
  check(
    '状态筛选提供 全部/待处理/已处理/已驳回',
    ['全部', '待处理', '已处理', '已驳回'].every((t) => p.radioLabels.includes(t)),
    p.radioLabels.join(' / ')
  )

  console.log('\n【11.1】举报处理：处理必须落「具体措施 + 备注」（回归：点一下就没下文）')
  const rClick = await cdp.eval(`window.__clickByText('处理')`)
  await sleep(800)
  check('点「处理」弹出处置弹窗（不是简单确认框）', rClick === 'clicked', rClick)
  const rdlg = JSON.parse(
    await cdp.eval(`JSON.stringify({
      open: !!document.querySelector('.el-dialog'),
      title: window.__topDialogTitle(),
      measures: [...document.querySelectorAll('.rp-measure .rp-measure-label')].map(n => n.textContent.trim()),
      effects: [...document.querySelectorAll('.rp-measure .rp-measure-effect')].map(n => n.textContent.trim()),
      hasRemark: !!window.__inTopDialog('textarea'),
      target: window.__textInTopDialog('.rp-target')
    })`)
  )
  check('弹窗标题为「处理举报」', rdlg.open && rdlg.title === '处理举报', rdlg.title)
  check('列出可选处理措施', rdlg.measures.length >= 2, rdlg.measures.join(' / '))
  check(
    '每条措施都写明后果（管理员不能凭字面猜）',
    rdlg.effects.length === rdlg.measures.length && rdlg.effects.every((e) => e.length > 5),
    rdlg.effects[0] || ''
  )
  check('弹窗提供处理备注输入', rdlg.hasRemark)
  check('弹窗显示被举报对象摘要', !!rdlg.target, (rdlg.target || '').slice(0, 60))

  // 不选措施直接提交 → 必须被拦住，弹窗不得关闭
  await cdp.eval(`window.__clickByText('确认处理')`)
  await sleep(700)
  const guard = await cdp.eval(`window.__dialogOpen()`)
  const guardMsg = await cdp.eval(`(document.querySelector('.el-message')?.textContent || '').trim()`)
  check('未选措施不允许提交', guard === true)
  check('给出「请先选择处理措施」提示', /请先选择处理措施/.test(guardMsg), guardMsg)

  // 补选措施 + 备注后提交
  await cdp.eval(
    `(function(){ const item = document.querySelector('.rp-measure'); if(!item) return 'no-item'; (item.querySelector('.el-radio__inner') || item).click(); return 'picked'; })()`
  )
  await sleep(300)
  await cdp.eval(`window.__setInTopDialog('textarea', 'e2e 冒烟：经核实商品描述与实物不符，通知卖家限期整改')`)
  await sleep(300)
  await shot('admin-e2e-report-dialog.png')
  await cdp.eval(`window.__clickByText('确认处理')`)
  await sleep(1400)
  check('提交后弹窗关闭', (await cdp.eval(`window.__dialogOpen()`)) === false)
  p = await cdp.probe()
  check('举报状态变为「已处理」', p.tags.includes('已处理'), p.tags.join('/'))
  const resolved = await cdp.eval(`window.__text('.rp-resolve')`)
  check('列表显示处置结论（措施 + 备注）', !!resolved && /警示整改/.test(resolved), resolved)
  await shot('admin-e2e-reports.png')

  console.log('\n【12】系统设置：参数 / 日志 / 导出 三视图')
  await openTab('系统设置')
  p = await cdp.probe()
  check('提供三个子视图', ['平台参数', '操作日志', '数据导出'].every((t) => p.radioLabels.includes(t)), p.radioLabels.join(' / '))
  check('参数表单含 8 个配置项', p.formItems.length === 8, p.formItems.join(' / '))
  check('参数含商品策略与计费分组', p.formItems.includes('发布需审核') && p.formItems.includes('服务费率'))
  await shot('admin-e2e-settings.png')

  await cdp.eval(`window.__clickByText('操作日志')`)
  await sleep(1500)
  p = await cdp.probe()
  check('操作日志有数据（写操作确实落了日志）', p.tableRows > 0, `${p.tableRows} 行`)
  checkNoOverflow('系统设置 · 操作日志', p)
  await shot('admin-e2e-logs.png')

  await cdp.eval(`window.__clickByText('数据导出')`)
  await sleep(800)
  p = await cdp.probe()
  check('导出视图 4 张卡', p.exportCards.length === 4, p.exportCards.join(' / '))
  check('导出覆盖商品/订单/用户/分类', p.exportCards.join('') === '商品数据订单数据用户数据分类数据', p.exportCards.join(' / '))
  await shot('admin-e2e-export.png')

  console.log('\n【13】深链：?tab=orders 应直接打开订单管理')
  await goto('/admin?tab=orders', 4200)
  p = await cdp.probe()
  check('URL query 决定初始页签', p.activeNav === '订单管理', p.activeNav)
  const hash = await cdp.eval('location.search')
  check('切页签会写回 URL', hash === '' || hash === '?tab=orders', hash)

  const failed = results.filter((r) => !r.pass)
  console.log(`\n${'='.repeat(60)}`)
  console.log(`总计 ${results.length} 项断言：通过 ${results.length - failed.length}，失败 ${failed.length}`)
  if (failed.length) console.log('失败项：\n' + failed.map((f) => `  - ${f.name} (${f.detail})`).join('\n'))

  ws.close()
  chrome.kill()
  process.exit(failed.length ? 1 : 0)
})().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})
