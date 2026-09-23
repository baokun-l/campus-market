/**
 * 端到端验证：活动让利在页面上的呈现是否与价格模型一致
 *
 * 背景：单测（src/api/promo.spec.ts）锁的是**数据**一致（活动声明的折扣必须真的有商品达到、
 * 划线价必须等于真实挂牌价、订单快照必须能对平）。本脚本补上**渲染层**：
 * 页面上真正画出来的划线价、折扣标签、让利归属、"已省金额" 是否与数据一致。
 *
 * 断言链：
 *   ① 商品卡：有让利的卡才有划线价 + 折扣标签；折扣标签永不夸大
 *   ② 详情页：让利归属徽标 + 「可省 ¥X」必须与价格区拆出来的差额一致
 *   ③ 购物车：单价双价（实付 + 划线挂牌）+ 汇总区「活动让利已省」
 *   ④ 后台看板：GMV 四格对账 + 恒等式「已对平」
 *
 * 用法：node scripts/e2e-promo.cjs     （需先 node scripts/preview-static.cjs）
 */
const http = require('http')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const TARGET = process.env.TARGET || 'http://127.0.0.1:7788'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9337
const USER_DATA = 'C:\\wbtmp\\cdp-promo'
const OUT = 'C:/wbtmp/shots-r5'

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
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map()
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
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout ' + method)) }
      }, 30000)
    })
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) {
      throw new Error(`${r.exceptionDetails.text || 'eval error'} :: ${r.exceptionDetails.exception?.description || ''}`)
    }
    return r.result?.value
  }
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' })
    fs.mkdirSync(OUT, { recursive: true })
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'))
  }
}

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? '  → ' + detail : ''}`)
}

/** 把 "¥1,234.50" / "1234.5" 之类解析成数字 */
const NUM = `(s) => Number(String(s || '').replace(/[^0-9.]/g, '')) `

;(async () => {
  const proc = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${USER_DATA}`,
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--hide-scrollbars', '--window-size=1440,1000', 'about:blank'
  ], { detached: true, stdio: 'ignore' })

  try {
    await waitForEndpoint()
    const tabs = JSON.parse(await httpGet(`http://127.0.0.1:${PORT}/json/list`))
    const page = tabs.find((t) => t.type === 'page')
    if (!page) throw new Error('未找到可用的页面标签页')
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((r) => ws.addEventListener('open', r))
    const cdp = new CDP(ws)
    await cdp.send('Runtime.enable')
    await cdp.send('Page.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })

    const goto = async (p, wait = 3800) => {
      await cdp.send('Page.navigate', { url: TARGET + p })
      await sleep(wait)
    }

    // 先落到站点再写 localStorage（about:blank 无 origin 会抛 SecurityError）
    await goto('/login', 2000)
    await cdp.evaluate(`localStorage.clear(); localStorage.setItem('c2c-user', JSON.stringify({ token: 'mock-token-user-1' })); 'ok'`)

    /* ============================================================
     * ① 商品卡：划线价 + 折扣标签必须成对出现，且折扣永不夸大
     * ============================================================ */
    console.log('\n【1】商品卡：划线价与折扣标签')
    await goto('/goods', 4200)
    const cards = await cdp.evaluate(`(() => {
      const num = ${NUM};
      const list = [...document.querySelectorAll('.goods-card')];
      const rows = list.map((c) => {
        const now = c.querySelector('.price-wrap .now')?.textContent || '';
        const origin = c.querySelector('.price-wrap .origin')?.textContent || '';
        const discount = c.querySelector('.price-wrap .discount')?.textContent || '';
        return { now: num(now), origin: origin ? num(origin) : null, discount };
      });
      return {
        total: list.length,
        withOrigin: rows.filter((r) => r.origin !== null).length,
        withDiscount: rows.filter((r) => r.discount).length,
        rows
      };
    })()`)
    check('商品卡渲染出数据', cards.total > 0, `${cards.total} 张`)
    check('存在带划线价的卡片（活动生效）', cards.withOrigin > 0, `${cards.withOrigin} 张`)
    check('划线价与折扣标签成对出现', cards.withOrigin === cards.withDiscount,
      `划线 ${cards.withOrigin} / 折扣 ${cards.withDiscount}`)

    // 划线价必须 ≥ 现价，否则就是"越打越贵"的脏数据
    const badPrice = cards.rows.filter((r) => r.origin !== null && !(r.origin >= r.now))
    check('所有划线价均不低于实付价', badPrice.length === 0,
      badPrice.length ? JSON.stringify(badPrice[0]) : '全部正常')

    // 折扣标签的折数必须 ≥ 真实折数（向上取整 ⇒ 只会说浅、不会说深）
    const overstated = cards.rows.filter((r) => {
      if (!r.discount || !r.origin) return false
      const label = Number(r.discount.replace('折', ''))
      const real = (r.now / r.origin) * 10
      return !(label >= real - 0.001)
    })
    check('折扣标签不夸大力度', overstated.length === 0,
      overstated.length ? JSON.stringify(overstated[0]) : '全部正当')

    // 未参与活动的卡片不应出现划线价
    const plain = await cdp.evaluate(`(() => {
      const list = [...document.querySelectorAll('.goods-card')];
      return list.filter((c) => c.querySelector('.price-wrap .origin')).length;
    })()`)
    check('未参与活动的卡片无划线价（不会凭空造原价）', plain === cards.withOrigin,
      `含划线 ${plain} / 应含 ${cards.withOrigin}`)
    await cdp.shot('promo-goods-cards.png')

    /* ============================================================
     * ② 详情页：让利归属 + 可省金额
     * ============================================================ */
    console.log('\n【2】商品详情：让利归属与可省金额')
    const href = await cdp.evaluate(`(() => {
      // 必须挑一件「参与活动 **且仍在售**」的商品：
      // 商品广场现在也会展示已售出的历史商品，它们的加购/立即购买按钮是禁用的，
      // 选到就会让后面整个购物车环节空转（曾因此 4 条断言集体失败）
      const c = [...document.querySelectorAll('.goods-card')].find(
        (x) => x.querySelector('.price-wrap .origin') && !x.querySelector('.status-badge.is-sold')
      );
      const a = c?.closest('a') || c?.querySelector('a');
      return a ? a.getAttribute('href') : null;
    })()`)
    check('找到一件参与活动且在售的商品', !!href, href)
    await goto(href, 4200)

    const detail = await cdp.evaluate(`(() => {
      const num = ${NUM};
      const now = num(document.querySelector('.price-block .price-wrap .now')?.textContent);
      const origin = num(document.querySelector('.price-block .price-wrap .origin')?.textContent);
      const badge = document.querySelector('.promo-note .promo-badge')?.textContent?.trim() || null;
      const note = document.querySelector('.promo-note')?.textContent?.replace(/\\s+/g, ' ').trim() || null;
      const saved = num((note || '').match(/可省 ¥([\\d.]+)/)?.[1]);
      return { now, origin, badge, note, saved };
    })()`)
    check('详情页显示让利归属徽标', ['卖家让利', '平台补贴'].includes(detail.badge), detail.badge)
    check('详情页显示可省金额', detail.saved > 0, String(detail.saved))
    check('可省金额 = 划线价 − 实付价', Math.abs(detail.saved - (detail.origin - detail.now)) < 0.011,
      `省 ${detail.saved} vs ${detail.origin} − ${detail.now}`)
    check('归属说明写明谁承担（卖家/平台）', /(卖家|平台)/.test(detail.note || ''), detail.note)
    await cdp.shot('promo-detail-note.png')

    /* ============================================================
     * ③ 购物车：双价快照 + 已省金额
     * ============================================================ */
    console.log('\n【3】购物车：实付/挂牌双价与已省金额')
    await cdp.evaluate(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('加入购物车'));
      btn?.click();
      return 'ok';
    })()`)
    await sleep(1200)
    await goto('/cart', 3600)

    const cart = await cdp.evaluate(`(() => {
      const num = ${NUM};
      const row = document.querySelector('.cart-table .el-table__body tr');
      const now = num(row?.querySelector('.price-wrap .now')?.textContent);
      const origin = num(row?.querySelector('.price-wrap .origin')?.textContent);
      const subOrigin = row?.querySelector('.sub-origin')?.textContent?.trim() || null;
      const savedText = document.querySelector('.summary .saved')?.textContent?.replace(/\\s+/g, ' ').trim() || null;
      return { now, origin, subOrigin, savedText, saved: num((savedText || '').match(/已省 ¥([\\d.]+)/)?.[1]) };
    })()`)
    check('购物车单价显示实付价', cart.now > 0, String(cart.now))
    check('购物车单价带出挂牌价（可核对）', cart.origin >= cart.now && cart.origin > 0, String(cart.origin))
    check('小计下方标注挂牌合计', !!cart.subOrigin, cart.subOrigin)
    check('汇总区显示「活动让利已省」', cart.saved > 0, cart.savedText)
    check('已省金额 = 挂牌 − 实付', Math.abs(cart.saved - (cart.origin - cart.now)) < 0.011,
      `省 ${cart.saved} vs ${cart.origin} − ${cart.now}`)
    await cdp.shot('promo-cart.png')

    /* ============================================================
     * ④ 后台看板：GMV 四格对账
     * ============================================================ */
    console.log('\n【4】后台看板：GMV 三口径对账')
    await goto('/login', 2000)
    await cdp.evaluate(`localStorage.setItem('c2c-user', JSON.stringify({ token: 'mock-token-admin' })); 'ok'`)
    await goto('/admin', 4600)

    const dash = await cdp.evaluate(`(() => {
      const cells = [...document.querySelectorAll('.gmv-split .gmv-cell')].map((c) => ({
        label: c.querySelector('.gmv-label')?.textContent?.trim(),
        value: c.querySelector('.gmv-value')?.textContent?.trim()
      }));
      const formula = document.querySelector('.gmv-formula')?.textContent?.replace(/\\s+/g, ' ').trim() || null;
      const ok = document.querySelector('.gmv-formula .gmv-ok')?.textContent?.trim() || null;
      const heroLabel = document.querySelector('.adm-kpi.is-hero .adm-kpi-label')?.textContent?.trim() || null;
      return { cells, formula, ok, heroLabel };
    })()`)
    check('看板有 4 格成交额构成', dash.cells.length === 4, dash.cells.map((c) => c.label).join(' / '))
    check('含「卖家让利」与「平台补贴」两格',
      dash.cells.some((c) => c.label === '卖家让利') && dash.cells.some((c) => c.label === '平台补贴'),
      dash.cells.map((c) => c.label).join(' / '))
    check('展示对账恒等式', /对账恒等式/.test(dash.formula || ''), dash.formula)
    check('恒等式显示「已对平」', dash.ok === '✓ 已对平', dash.ok)
    check('首屏 GMV 口径已明确为买家实付', /买家实付/.test(dash.heroLabel || ''), dash.heroLabel)
    await cdp.shot('promo-admin-gmv.png')

    /* ============================================================
     * ⑤ 发布页报名：从「看得见的规则」到「点得动的控件」
     *
     * 这一段的由来：发布页原先只有一段「自愿报名」的说明文案，却没有报名入口 ——
     * 卖家看得见、做不到。补上控件后要盯住三件事：
     *   1. 有活动的分类才出现报名控件，没活动的分类必须明说「按挂牌价成交」；
     *   2. 勾选后立刻给出成交价预览，并**讲清这笔差价谁出**（卖家让利要说「你将少收」）；
     *   3. 预览的金额必须与提交后详情页真正成交的价一致（同源，不能两套算法）。
     * ============================================================ */
    console.log('\n【5】发布页报名：控件、预览与成交价一致性')
    await goto('/login', 2000)
    await cdp.evaluate(`localStorage.setItem('c2c-user', JSON.stringify({ token: 'mock-token-user-1' })); 'ok'`)
    await goto('/goods/publish', 3600)

    // el-select 下拉选择分类
    async function pickCategory(name) {
      await cdp.evaluate(`(() => {
        const sel = document.querySelector('.el-select');
        sel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        sel.querySelector('input')?.click();
        return 'ok';
      })()`)
      await sleep(700)
      const picked = await cdp.evaluate(`(() => {
        const hit = [...document.querySelectorAll('.el-select-dropdown__item')]
          .find((i) => i.textContent.includes(${JSON.stringify(name)}));
        if (!hit) return null;
        hit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        hit.click();
        return hit.textContent.trim();
      })()`)
      await sleep(700)
      return picked
    }

    // 商品分类默认是「教材」（1 号），它挂了开学季特卖（卖家让利，最高 5 折）
    const joinState = await cdp.evaluate(`(() => {
      const box = document.querySelector('.join-box');
      const opts = [...document.querySelectorAll('.join-box .join-item')];
      const hint = document.querySelector('.policy-hint');
      return {
        hasJoin: !!box,
        joinText: box?.textContent?.replace(/\\s+/g, ' ').trim() || null,
        optTitles: opts.map((o) => o.querySelector('.ji-title')?.textContent?.trim() || ''),
        optChecked: opts.filter((o) => o.classList.contains('is-checked')).length,
        // 单选组永远有一项被选中；默认必须停在「不参加」那一项，而不是某个活动
        checkedIsNone: !!opts[0]?.classList.contains('is-checked'),
        hasHint: !!hint,
        hintText: hint?.textContent?.replace(/\\s+/g, ' ').trim() || null,
        hasPreview: !!document.querySelector('.promo-preview')
      };
    })()`)
    check('教材分类出现报名控件', joinState.hasJoin, joinState.joinText)
    check('报名控件写明活动名与折扣力度', /《.+》/.test(joinState.joinText || '') && /折/.test(joinState.joinText || ''),
      joinState.joinText)
    check('未选中时不显示让利预览', joinState.hasPreview === false, String(joinState.hasPreview))
    // 默认必须停在「不参加」——平台不能替卖家默认报名（默认勾选＝替卖家决定让利）
    check('提供「不参加活动」选项，且默认停在「不参加」而非某个活动',
      joinState.optTitles.some((t) => /不参加/.test(t)) && joinState.checkedIsNone && joinState.optChecked === 1,
      `${joinState.optTitles.join(' / ')}｜选中 ${joinState.optChecked} 个，默认不参加=${joinState.checkedIsNone}`)

    // 填售价（预览与提交都要用到）
    await cdp.evaluate(`(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      const inp = document.querySelector('.el-input-number input');
      setter.call(inp, '200');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok';
    })()`)
    await sleep(600)

    /* ============================================================
     * ⑤b 多活动共享同一分类：**全部列出来，但只能选一个**
     *
     * 生活用品（5 号）同时挂在两个活动下：开学季特卖（卖家让利，最高 8 折）
     * 与宿舍焕新补贴周（平台补贴，最高 8.5 折）。
     * 平台要把两个都摆出来（否则等于替卖家决定参加哪个），但必须单选：
     * 让利价只有一个字段，同时参加两条＝叠加打折，也分不清谁掏钱。
     * ============================================================ */
    console.log('\n【5b】多活动共享分类：全部列出，但只能选一个')
    const pickedShare = await pickCategory('生活')
    await sleep(700)
    const multi = await cdp.evaluate(`(() => {
      const opts = [...document.querySelectorAll('.join-box .join-item')];
      const acts = opts.filter((o) => !o.classList.contains('is-none'));
      return {
        total: opts.length,
        actCount: acts.length,
        titles: acts.map((o) => o.querySelector('.ji-title')?.textContent?.trim() || ''),
        metas: acts.map((o) => o.querySelector('.ji-meta')?.textContent?.trim() || ''),
        tip: document.querySelector('.join-tip')?.textContent?.replace(/\\s+/g, ' ').trim() || null,
        checked: opts.filter((o) => o.classList.contains('is-checked')).length,
        checkedIsNone: !!opts[0]?.classList.contains('is-checked')
      };
    })()`)
    check('切到生活分类（两条活动共享）', pickedShare !== null, String(pickedShare))
    check('两个在招活动全部列出（不是只给一个）', multi.actCount === 2, `${multi.actCount} 个：${multi.titles.join(' / ')}`)
    check('每个选项都写明自己的力度与资金归属',
      multi.metas.every((m) => /折/.test(m)) && multi.metas.some((m) => /少收/.test(m)) && multi.metas.some((m) => /实收不变/.test(m)),
      multi.metas.join(' ｜ '))
    check('单选组默认停在「不参加」（切分类后不残留上一个分类的活动）',
      multi.checkedIsNone && multi.checked === 1,
      `选中 ${multi.checked} 个，默认不参加=${multi.checkedIsNone}`)
    check('说明文案点明「只能参加其中一个」', /只能参加其中一个/.test(multi.tip || ''), multi.tip)

    // 选第 1 条（卖家让利）→ 预览必须讲清「你会少收钱」
    await cdp.evaluate(`(() => { document.querySelectorAll('.join-box .join-item')[1]?.click(); return 'ok'; })()`)
    await sleep(700)
    const sel1 = await cdp.evaluate(`(() => {
      const num = ${NUM};
      const opts = [...document.querySelectorAll('.join-box .join-item')];
      return {
        checked: opts.filter((o) => o.classList.contains('is-checked')).length,
        idx: opts.findIndex((o) => o.classList.contains('is-checked')),
        pay: num(document.querySelector('.promo-preview .pp-pay')?.textContent),
        note: document.querySelector('.promo-preview .pp-note')?.textContent?.replace(/\\s+/g, ' ').trim() || ''
      };
    })()`)
    check('点选后只有这一个被选中（单选互斥）', sel1.checked === 1, `选中 ${sel1.checked} 个`)
    check('选中的是第 1 条活动', sel1.idx === 1, `index=${sel1.idx}`)
    check('卖家让利必须写明「你将少收」', /你将少收/.test(sel1.note), sel1.note)

    // 切到第 2 条（平台补贴）→ 金额随活动规则变、文案改说「实收不变」
    await cdp.evaluate(`(() => { document.querySelectorAll('.join-box .join-item')[2]?.click(); return 'ok'; })()`)
    await sleep(700)
    const sel2 = await cdp.evaluate(`(() => {
      const num = ${NUM};
      const opts = [...document.querySelectorAll('.join-box .join-item')];
      return {
        checked: opts.filter((o) => o.classList.contains('is-checked')).length,
        idx: opts.findIndex((o) => o.classList.contains('is-checked')),
        pay: num(document.querySelector('.promo-preview .pp-pay')?.textContent),
        note: document.querySelector('.promo-preview .pp-note')?.textContent?.replace(/\\s+/g, ' ').trim() || ''
      };
    })()`)
    check('切换活动后仍然只有一个被选中', sel2.checked === 1 && sel2.idx === 2, `选中 ${sel2.checked} 个 · index=${sel2.idx}`)
    check('平台补贴必须写明「你的实收仍是…一分不少」', /你的实收仍是/.test(sel2.note) && /一分不少/.test(sel2.note), sel2.note)
    check('换活动后预览金额随规则变化（各算各的，不叠加）', sel1.pay !== sel2.pay, `${sel1.pay} → ${sel2.pay}`)
    await cdp.shot('publish-multi-activity.png')

    // 回到教材分类继续走「报名 → 提交 → 详情页」的主链路
    await pickCategory('教材')
    await cdp.evaluate(`(() => { document.querySelectorAll('.join-box .join-item')[1]?.click(); return 'ok'; })()`)
    await sleep(700)

    const pv = await cdp.evaluate(`(() => {
      const box = document.querySelector('.promo-preview');
      if (!box) return null;
      const rows = [...box.querySelectorAll('.pp-row')].map((r) => ({
        label: r.querySelector('.pp-label')?.textContent?.trim(),
        value: r.querySelector('b')?.textContent?.trim(),
        tag: r.querySelector('.el-tag')?.textContent?.trim() || null
      }));
      return { rows, note: box.querySelector('.pp-note')?.textContent?.replace(/\\s+/g, ' ').trim() || '' };
    })()`)
    check('选中活动后出现让利预览', !!pv, pv ? `${pv.rows.length} 行` : 'null')

    if (pv) {
      const num = (s) => Number(String(s || '').replace(/[^0-9.]/g, ''))
      const list = num(pv.rows[0]?.value)
      const pay = num(pv.rows[1]?.value)
      const zhe = Number((pv.rows[1]?.tag || '').replace(/[^0-9.]/g, ''))

      check('预览第 1 行是挂牌价', pv.rows[0]?.label === '你的挂牌价', pv.rows[0]?.label)
      check('预览挂牌价 = 填写的售价', Math.abs(list - 200) < 0.011, String(list))
      check('预览给出报名后买家实付', pay > 0 && pay < list, `${pay} < ${list}`)
      check('预览带折扣标签', zhe > 0 && zhe < 10, `${zhe}折`)
      /*
       * 教材声明的是「最高 5 折」——5 折是该分类**最深**的力度，
       * 因此单件商品的折扣数只能 ≥ 5（6 折比 5 折浅，是允许的）；
       * 若标签出现 4 折这种**比声明更深**的力度，说明档位算错了。
       */
      check('折扣力度未深于活动声明（教材最高 5 折）', zhe >= 5, `${zhe}折 vs 声明最高 5 折`)
      // 文案里有多个 ¥ 金额，只取第一个（= 让利金额）；直接抽全部数字会拼成 NaN
      const noteAmount = Number((pv.note.match(/¥([\d.]+)/) || [])[1])
      check('让利金额 = 挂牌 − 实付', Math.abs((list - pay) - noteAmount) < 0.011,
        `省 ${(list - pay).toFixed(2)} vs 文案 ¥${noteAmount}`)
      check('卖家让利必须明确告知「你将少收」', /你将少收/.test(pv.note), pv.note)
      await cdp.shot('publish-join-preview.png')

      /* —— 关键一致性：预览的价 = 提交后详情页成交的价 —— */
      await cdp.evaluate(`(() => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        const tas = document.querySelectorAll('textarea');
        if (tas.length) {
          const t = tas[tas.length - 1];
          setter.call(t, 'e2e 自动化报名测试');
          t.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return 'ok';
      })()`)
      await sleep(400)
      // 「交易地点」是普通 el-input，按 label 定位更稳
      await cdp.evaluate(`(() => {
        const item = [...document.querySelectorAll('.el-form-item')]
          .find((i) => i.querySelector('.el-form-item__label')?.textContent.includes('交易地点'));
        const inp = item?.querySelector('input');
        if (!inp) return 'miss';
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(inp, '计算机学院宿舍楼下');
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        return 'ok';
      })()`)
      await sleep(400)
      // 标题同理（用 label 精确定位，避免拿到别的输入框）
      await cdp.evaluate(`(() => {
        const item = [...document.querySelectorAll('.el-form-item')]
          .find((i) => i.querySelector('.el-form-item__label')?.textContent.includes('商品标题'));
        const inp = item?.querySelector('input');
        if (!inp) return 'miss';
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(inp, 'e2e 报名测试书');
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        return 'ok';
      })()`)
      await sleep(400)

      const submitted = await cdp.evaluate(`(() => {
        const btn = [...document.querySelectorAll('.el-button')]
          .find((b) => b.textContent.trim() === '提交审核');
        if (!btn) return false;
        btn.click();
        return true;
      })()`)
      check('提交按钮可点击', submitted === true, String(submitted))
      await sleep(4200)

      const after = await cdp.evaluate(`(() => {
        const num = ${NUM};
        const origin = num(document.querySelector('.price-block .price-wrap .origin')?.textContent);
        const now = num(document.querySelector('.price-block .price-wrap .now')?.textContent);
        const badge = document.querySelector('.promo-note .promo-badge')?.textContent?.trim() || null;
        return { url: location.pathname + location.search, origin, now, badge };
      })()`)
      check('提交后跳到新商品详情页', /^\/goods\/\d+/.test(after.url), after.url)
      check('详情页出现划线价（报名已生效）', Number(after.origin) > 0, String(after.origin))
      check('详情页实付价 = 发布页预览的价（同源，不允许两套算法）',
        Math.abs(Number(after.now) - pay) < 0.011, `详情 ${after.now} vs 预览 ${pay}`)
      check('详情页让利归属与活动声明一致', after.badge === '卖家让利', String(after.badge))
      await cdp.shot('publish-joined-detail.png')
    }

    /* —— 无活动的分类：不能承诺「报名」，要明说按挂牌价成交 —— */
    await goto('/goods/publish', 3600)
    const picked = await pickCategory('代步')
    const noClaim = await cdp.evaluate(`(() => {
      const hint = document.querySelector('.policy-hint');
      return {
        hasJoin: !!document.querySelector('.join-box'),
        hasPreview: !!document.querySelector('.promo-preview'),
        hint: hint?.textContent?.replace(/\\s+/g, ' ').trim() || null
      };
    })()`)
    check('切到无活动的分类（代步）', picked !== null, String(picked))
    check('无活动的分类不出现报名控件', noClaim.hasJoin === false, String(noClaim.hasJoin))
    check('无活动的分类不给让利预览', noClaim.hasPreview === false, String(noClaim.hasPreview))
    check('无活动的分类明说「按挂牌价成交」', /按你的挂牌价成交/.test(noClaim.hint || ''), noClaim.hint)
    check('此时不出现「报名」字样（不承诺做不到的事）', !/报名/.test(noClaim.hint || ''), noClaim.hint)
    // 空框必须能自解释：把「哪些分类有活动」直接列出来，否则卖家只能靠猜
    check('提示里列出当前有活动的分类', /目前有活动的分类/.test(noClaim.hint || ''), noClaim.hint)
    check('列出的分类包含「教材」（确有活动）', /教材/.test(noClaim.hint || ''), noClaim.hint)
    await cdp.shot('publish-no-claim.png')

    // 切回有活动的分类：选择必须已被重置（否则会带着上一个分类的活动 id 提交）
    await pickCategory('教材')
    const reset = await cdp.evaluate(`(() => {
      const opts = [...document.querySelectorAll('.join-box .join-item')];
      return {
        hasJoin: !!document.querySelector('.join-box'),
        hasPreview: !!document.querySelector('.promo-preview'),
        checked: opts.filter((o) => o.classList.contains('is-checked')).length,
        checkedIsNone: !!opts[0]?.classList.contains('is-checked')
      };
    })()`)
    check('切回有活动的分类后重新出现报名控件', reset.hasJoin === true, String(reset.hasJoin))
    check('切过分类后报名状态已重置（回到「不参加」、无预览）',
      reset.hasPreview === false && reset.checkedIsNone && reset.checked === 1,
      `选中 ${reset.checked} 个 · 不参加=${reset.checkedIsNone} · 预览 ${reset.hasPreview}`)

    /* ============================================================
     * ⑥ 旧存档自愈：复现「活动看得见、却报不了名」
     *
     * 第十轮之前的活动存档没有 claims / fundSource 字段 ——
     * 首页 Banner 照旧展示（不读 claims），但发布页任何分类都查不到让利声明。
     * 这里直接把这种老数据写进 localStorage 再重载，验证自愈真的生效。
     * ============================================================ */
    console.log('\n【6】旧存档自愈：老活动数据也能报名')
    await cdp.evaluate(`(() => {
      const legacy = [{
        id: 'back-to-school-2026-fall',
        enabled: true,
        startAt: Date.now() - 3600000,
        durationDays: 30,
        title: '卖家让利专区：教材 5 折起，宿舍电器 8 折起',
        subtitle: '折扣来自卖家自愿让利',
        ctaText: '看看让利好物',
        ctaLink: '/goods?categoryId=1',
        highlights: ['卖家让利 · 教材 5 折起'],
        icon: '🎓',
        theme: 'orange',
        priority: 100,
        createTime: Date.now(),
        updateTime: Date.now()
      }];
      localStorage.setItem('c2c-activities', JSON.stringify(legacy));
      return 'ok';
    })()`)
    // 整页重载才会重新走 loadActivities()（内含自愈）
    await goto('/goods/publish', 4200)
    const healed = await cdp.evaluate(`(() => {
      const stored = JSON.parse(localStorage.getItem('c2c-activities') || '[]');
      return {
        hasJoin: !!document.querySelector('.join-box'),
        // 存档已被回写为带 claims 的形状
        storedClaims: Array.isArray(stored[0]?.claims) ? stored[0].claims : null,
        storedFund: stored[0]?.fundSource ?? null
      };
    })()`)
    check('老存档（无 claims）重载后仍能报名', healed.hasJoin === true, String(healed.hasJoin))
    check('自愈已写回存档：claims 补回', JSON.stringify(healed.storedClaims) === JSON.stringify([{ categoryId: 1, rate: 0.5 }, { categoryId: 5, rate: 0.8 }]),
      JSON.stringify(healed.storedClaims))
    check('自愈已写回存档：fundSource 补回为声明值', healed.storedFund === 'seller', String(healed.storedFund))
    await cdp.shot('publish-legacy-healed.png')

    const failed = results.filter((r) => !r.ok)
    console.log('\n' + '='.repeat(56))
    console.log(`总计 ${results.length} 项断言：通过 ${results.length - failed.length}，失败 ${failed.length}`)
    if (failed.length) console.log('失败项：\n' + failed.map((f) => `  - ${f.name}（${f.detail}）`).join('\n'))
    try { proc.kill() } catch { /* ignore */ }
    process.exit(failed.length ? 1 : 0)
  } catch (e) {
    console.error('执行失败：', e.message)
    try { proc.kill() } catch { /* ignore */ }
    process.exit(1)
  }
})()
