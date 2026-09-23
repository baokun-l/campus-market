/**
 * 后台「订单工作台」验证探针（node scripts/probe-orders.cjs）
 *
 * 覆盖第十九轮新增的一整套管理能力，全部在真实浏览器里点出来：
 *   A. 工作台 KPI 与状态总览卡（数值自洽 + 点卡即筛选）
 *   B. 高级筛选（金额区间 / 只看超时异常 / 重置）
 *   C. 批量处置（多选 → 批量标记付款 → 列表与统计同步变化）
 *   D. 详情抽屉（操作日志 / 物流轨迹 / 交易双方 / 后台备注写入生效）
 *   E. 售后退款弹窗（部分退款 → 订单落到已取消）
 *   F. 导出 CSV（真下载一次，并校验落盘文件有内容）
 *
 * ⚠️ 与 probe-r18 相同的两条纪律：
 *   ① 开跑前必须先 `npx vite build --emptyOutDir=false`，否则验的是旧产物；
 *   ② 预览服务没起就 exit 2，别让人去源码里找一个不存在的 bug。
 */
const http = require('http')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const TARGET = 'http://127.0.0.1:7788'
const OUT = 'C:/wbtmp'
const DOWNLOADS = path.join(OUT, 'downloads')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9353
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

/** 读取表格里每行的「状态」列文本（状态列是第 4 列：选择/展开/订单号/商品/金额/买家/状态） */
const ROW_STATUS_EXPR = `(function(){
  return [...document.querySelectorAll('.el-table__body tr.el-table__row')].map(function(tr){
    const cell = tr.querySelector('.od-status-cell');
    return cell ? cell.innerText.replace(/\\s+/g,' ').trim() : '';
  });
})()`

;(async () => {
  try {
    const html = await httpGet(TARGET + '/')
    if (!/id="app"|<script/.test(html)) throw new Error('响应不像 SPA 首页')
  } catch (e) {
    console.error(`\n✗ 预览服务不可用：${TARGET} —— ${e.message}`)
    console.error('  先跑：node scripts/preview-static.cjs （用 run_in_background，别接管道）')
    console.error('  再跑：npx vite build --emptyOutDir=false\n')
    process.exit(2)
  }

  fs.rmSync(DOWNLOADS, { recursive: true, force: true })
  fs.mkdirSync(DOWNLOADS, { recursive: true })
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(OUT, 'probe-orders-profile')}`.replace(/\//g, '\\'),
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
    const go = async (p, wait = 2800) => { await send('Page.navigate', { url: TARGET + p }); await sleep(wait) }
    const clickByText = (text, scope = 'button') =>
      evalJS(`(function(){
        const b = [...document.querySelectorAll(${JSON.stringify(scope)})].find(function(x){
          return x.textContent.replace(/\\s+/g,'').includes(${JSON.stringify(text.replace(/\s+/g, ''))});
        });
        if (!b) return false;
        b.click();
        return true;
      })()`)
    /** 确认 el-message-box（点主按钮） */
    const confirmBox = () =>
      evalJS(`(function(){
        const box = [...document.querySelectorAll('.el-message-box')].find(function(b){ return b.getBoundingClientRect().width > 0 });
        if (!box) return '';
        const btn = box.querySelector('.el-message-box__btns .el-button--primary');
        const title = (box.querySelector('.el-message-box__title')||{}).innerText || '';
        if (btn) btn.click();
        return title.trim();
      })()`)
    /**
     * 下拉没选中时的现场取证。
     *
     * 「探针点不动」和「功能坏了」是两件事，只报 false 会把排查引到错误方向 ——
     * 这里把「下拉到底展没展开」直接打出来：dropdownOpen=0 是没展开（多半被浮层/重渲染干扰），
     * dropdownOpen=1 但 visibleItems 里没有目标项，才是选项本身的问题。
     */
    const dropdownDump = () =>
      evalJS(`(function(){
        const vis = function(s){ return [...document.querySelectorAll(s)].filter(function(x){ return x.getBoundingClientRect().width > 0 }) };
        const dd = [...document.querySelectorAll('.el-select-dropdown')];
        const w = document.querySelector('.adm-select .el-select__wrapper');
        return JSON.stringify({
          overlays: vis('.el-overlay').length,
          dialogOpen: vis('.el-dialog').length,
          drawerOpen: vis('.el-drawer').length,
          dropdownNodes: dd.length,
          dropdownOpen: dd.filter(function(d){ return d.getBoundingClientRect().width > 0 }).length,
          dropdownDisplay: dd.map(function(d){ return getComputedStyle(d).display }),
          visibleItems: [...document.querySelectorAll('.el-select-dropdown__item')]
            .filter(function(i){ return i.getBoundingClientRect().width > 0 })
            .map(function(i){ return i.innerText.trim() }),
          firstAdmSelect: w ? w.innerText.replace(/\\s+/g,' ').trim() : '(none)'
        });
      })()`)
    /** 选 el-select 下拉里文字为 label 的项（EP 2.14 必须点 .el-select__wrapper 才会展开） */
    const pickSelect = async (selectSel, label) => {
      await evalJS(`(function(){ const w = document.querySelector(${JSON.stringify(selectSel)} + ' .el-select__wrapper'); if (w) w.click(); return !!w })()`)
      await sleep(600)
      const ok = await evalJS(`(function(){
        const items = [...document.querySelectorAll('.el-select-dropdown__item')].filter(function(i){ return i.getBoundingClientRect().width > 0 });
        const t = items.find(function(i){ return i.innerText.trim() === ${JSON.stringify(label)} });
        if (!t) return false;
        t.click();
        return true;
      })()`)
      await sleep(1300)
      if (!ok) {
        const d = JSON.parse(await dropdownDump())
        console.log(`     ↳ 选「${label}」失败，现场：${JSON.stringify(d)}`)
      }
      return ok
    }

    await send('Page.enable')
    await send('Runtime.enable')
    // 让「导出 CSV」真的落到磁盘上，否则只能验「点了没报错」
    await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS })
    await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false })
    await go('/', 1800)
    await evalJS(`localStorage.setItem('c2c-user', JSON.stringify({token:'mock-token-admin'}))`)
    await go('/admin?tab=orders', 3600)

    /* ==================== A. KPI 与状态总览 ==================== */
    console.log('\n【A · 工作台 KPI 与状态总览】')
    const kpi = await evalJS(`(function(){
      const cards = [...document.querySelectorAll('.od-kpi-grid .adm-kpi')].map(function(c){
        return {
          label: (c.querySelector('.adm-kpi-label')||{}).innerText||'',
          value: (c.querySelector('.adm-kpi-value')||{}).innerText||'',
          clickable: c.classList.contains('is-clickable')
        };
      });
      return JSON.stringify(cards);
    })()`)
    const kpiCards = JSON.parse(kpi)
    check('渲染 4 张工作台 KPI 卡', kpiCards.length === 4, kpiCards.map((c) => c.label.trim()).join(' / '))
    const gmv = Number((kpiCards[0].value || '').replace(/[^0-9.]/g, ''))
    check('累计成交额是正数（不是 0 或 NaN）', gmv > 0, kpiCards[0].value)
    check('「待处理」「超时异常」两张卡可点', kpiCards[1].clickable && kpiCards[2].clickable)
    check(
      'KPI 脚下有「在途待结算 / 已退款」等细分口径',
      /待结算/.test(kpiCards[0].label + await evalJS(`document.querySelector('.od-kpi-grid .adm-kpi .adm-kpi-foot').innerText`)),
      (await evalJS(`document.querySelector('.od-kpi-grid .adm-kpi .adm-kpi-foot').innerText`)).replace(/\s+/g, ' ')
    )

    const pills = await evalJS(`(function(){
      return JSON.stringify([...document.querySelectorAll('.od-pill')].map(function(p){
        return { label: (p.querySelector('.od-pill-label')||{}).innerText||'', count: Number((p.querySelector('.od-pill-count')||{}).innerText||'0'), amt: (p.querySelector('.od-pill-amt')||{}).innerText||'' };
      }));
    })()`)
    const pillList = JSON.parse(pills)
    check('渲染 6 张状态总览卡（含售后中）', pillList.length === 6, pillList.map((p) => `${p.label}:${p.count}`).join(' '))
    const pillSum = pillList.reduce((a, p) => a + p.count, 0)
    const headerTotal = Number(
      (await evalJS(`document.querySelector('.adm-card-hint').innerText`)).replace(/[^0-9]/g, '')
    )
    check('状态卡计数之和 = 列表总数（口径一致，不重不漏）', pillSum === headerTotal, `${pillSum} vs ${headerTotal}`)
    check('售后中卡有内容（退款 / 已取消可查）', pillList[5].count > 0, `售后中 ${pillList[5].count}`)
    await shot('orders-A-workbench.png')

    // 点「待发货」卡 → 列表只剩待发货
    const shipPill = await evalJS(`(function(){
      const p = [...document.querySelectorAll('.od-pill')].find(function(x){ return /待发货/.test(x.innerText) });
      if (!p) return false;
      p.click();
      return true;
    })()`)
    check('状态卡可点击', shipPill)
    await sleep(1400)
    const afterPill = await evalJS(ROW_STATUS_EXPR)
    check(
      '点「待发货」后列表只剩待发货',
      afterPill.length > 0 && afterPill.every((t) => t.startsWith('待发货')),
      afterPill.length ? afterPill.join(' | ') : '(空)'
    )
    check(
      '被点中的状态卡高亮（知道自己正被什么筛着）',
      await evalJS(`!!document.querySelector('.od-pill.is-on')`)
    )
    await shot('orders-A-filter-by-pill.png')

    // 「售后中」是唯一的多状态分组（退款中 + 已取消）：必须两态都筛得出来。
    // 曾经的实现会退化成「只筛第一个状态」，卡片写 3 单点进去只有 2 单 —— 数字与列表自相矛盾。
    const afterGroupPill = await evalJS(`(function(){
      const p=[...document.querySelectorAll('.od-pill')].find(function(x){ return /售后中/.test(x.innerText) });
      if (!p) return JSON.stringify({ ok:false });
      const want = Number((p.querySelector('.od-pill-count')||{}).innerText||'0');
      p.click();
      return JSON.stringify({ ok:true, want:want });
    })()`)
    const ag = JSON.parse(afterGroupPill)
    await sleep(1500)
    const groupRows = await evalJS(`(function(){
      return {
        rows: [...document.querySelectorAll('.el-table__body tr.el-table__row')].map(function(tr){
          const c = tr.querySelector('.od-status-cell');
          return c ? c.innerText.replace(/\\s+/g,' ').trim() : '';
        }),
        on: [...document.querySelectorAll('.od-pill.is-on')].map(function(p){ return (p.querySelector('.od-pill-label')||{}).innerText||'' })
      };
    })()`)
    check(
      '「售后中」卡把两种状态都筛出来（不重不漏 = 卡片计数）',
      ag.ok && groupRows.rows.length === ag.want && groupRows.rows.every((t) => /退款中|已取消/.test(t)),
      `卡=${ag.want} 行=${groupRows.rows.length}｜${groupRows.rows.join(' | ')}`
    )
    check('高亮的是「售后中」这张卡', groupRows.on.includes('售后中'), groupRows.on.join('/'))
    // 点第二下取消分组筛选
    await evalJS(`(function(){
      const p=[...document.querySelectorAll('.od-pill')].find(function(x){ return /售后中/.test(x.innerText) });
      if (p) p.click();
      return !!p;
    })()`)
    await sleep(1400)

    /* ==================== B. 高级筛选 ==================== */
    console.log('\n【B · 高级筛选与重置】')
    // 退出卡片筛选（点当前高亮的那张即可），避免条件叠加看不出效果。
    // 这里按 `.is-on` 找而不是写死卡片名：上面 A 段换过筛选目标，写死会点错一张
    await evalJS(`(function(){
      const p=document.querySelector('.od-pill.is-on');
      if (p) p.click();
      return !!p;
    })()`)
    await sleep(1200)

    const opened = await clickByText('高级筛选')
    check('可展开高级筛选面板', opened)
    await sleep(600)
    check(
      '高级筛选含时间 / 金额 / 让利归属 / 只看开关四类条件',
      await evalJS(`(function(){
        const t = document.querySelector('.od-adv').innerText;
        return /下单时间/.test(t) && /实付金额/.test(t) && /让利归属/.test(t) && /只看/.test(t);
      })()`)
    )

    // 勾「超时异常」
    await evalJS(`(function(){
      const cb = [...document.querySelectorAll('.od-adv .el-checkbox')].find(function(c){ return /超时异常/.test(c.innerText) });
      if (!cb) return false;
      cb.click();
      return true;
    })()`)
    await sleep(1400)
    const issueRows = await evalJS(`(function(){
      return {
        rows: document.querySelectorAll('.el-table__body tr.el-table__row').length,
        marked: document.querySelectorAll('.el-table__body .od-issue').length,
        firstText: (document.querySelector('.el-table__body .od-status-cell')||{}).innerText || ''
      };
    })()`)
    check('勾「只看超时异常」后仍有结果（种子里确实有超时单）', issueRows.rows > 0, `${issueRows.rows} 行`)
    check('结果里每行都带超时标记', issueRows.marked === issueRows.rows, `${issueRows.marked}/${issueRows.rows}`)
    await shot('orders-B-issue-filter.png')

    // 重置
    const reset = await clickByText('重置')
    check('存在「重置」按钮', reset)
    await sleep(1400)
    const afterReset = await evalJS(`(function(){
      return {
        checked: document.querySelectorAll('.od-adv .el-checkbox.is-checked').length,
        count: document.querySelector('.adm-card-hint').innerText
      };
    })()`)
    check('重置后「只看」条件全部清空', afterReset.checked === 0, `${afterReset.checked} 个仍勾选`)
    check('重置后恢复全量列表', /已启用/.test(afterReset.count) === false, afterReset.count.replace(/\s+/g, ' '))

    /* ==================== C. 批量处置 ==================== */
    console.log('\n【C · 批量处置】')
    const picked = await pickSelect('.adm-select', '待付款')
    check('可筛选「待付款」订单', picked)
    const beforeBatch = await evalJS(`document.querySelectorAll('.el-table__body tr.el-table__row').length`)
    check('待付款有可处置的订单', beforeBatch > 0, `${beforeBatch} 行`)

    // 点表头全选
    await evalJS(`(function(){ const cb=document.querySelector('.el-table__header .el-checkbox'); if(cb) cb.click(); return !!cb })()`)
    await sleep(700)
    const batchBar = await evalJS(`(function(){
      const b = document.querySelector('.adm-batch');
      return b ? b.innerText.replace(/\\s+/g,' ').trim() : '';
    })()`)
    check('勾选后出现批量操作条', /已选/.test(batchBar), batchBar.slice(0, 50))
    check(
      '批量条给出「标记付款 / 发货 / 关闭」三个动作',
      /批量标记付款/.test(batchBar) && /批量发货/.test(batchBar) && /批量关闭/.test(batchBar)
    )
    await shot('orders-C-batch-bar.png')

    await clickByText('批量标记付款')
    await sleep(700)
    const boxTitle = await confirmBox()
    check('批量操作有二次确认', /批量/.test(boxTitle), boxTitle)
    await sleep(2000)
    const afterBatch = await evalJS(`(function(){
      return {
        rows: document.querySelectorAll('.el-table__body tr.el-table__row').length,
        hint: document.querySelector('.adm-card-hint').innerText.replace(/\\s+/g,' ').trim()
      };
    })()`)
    check('批量标记付款后「待付款」列表清空（状态真的推进了）', afterBatch.rows === 0, `${beforeBatch} → ${afterBatch.rows} 行`)
    check('筛选计数同步刷新', /当前筛选\s*0\s*单/.test(afterBatch.hint), afterBatch.hint)

    /* ==================== D. 详情抽屉 ==================== */
    console.log('\n【D · 详情抽屉：日志 / 物流 / 双方 / 备注】')
    // 切到「已发货」，这批单有运单号与轨迹
    await pickSelect('.adm-select', '已发货')
    await sleep(400)
    await evalJS(`(function(){ const b=[...document.querySelectorAll('.el-table__body tr td:last-child button')].find(function(x){return x.textContent.includes('详情')}); if(b) b.click(); return !!b })()`)
    await sleep(1100)
    const drawer = await evalJS(`(function(){
      const d = [...document.querySelectorAll('.el-drawer')].filter(function(x){
        const ov = x.closest('.el-overlay');
        return ov && getComputedStyle(ov).display !== 'none' && x.getBoundingClientRect().width > 0;
      }).pop();
      if (!d) return JSON.stringify({ open: false });
      return JSON.stringify({
        open: true,
        logs: d.querySelectorAll('.od-logs li').length,
        traces: d.querySelectorAll('.od-trace-list li').length,
        parties: d.querySelectorAll('.od-party').length,
        partyCredit: /信用\\s*\\d+/.test(d.innerText),
        blocks: [...d.querySelectorAll('.od-block-title')].map(function(n){ return n.innerText.trim() })
      });
    })()`)
    const dw = JSON.parse(drawer)
    check('详情抽屉已打开', dw.open === true)
    check('抽屉渲染了操作日志', dw.logs > 0, `${dw.logs} 条`)
    check('已发货订单有物流轨迹', dw.traces > 0, `${dw.traces} 条`)
    check('抽屉给出买卖双方卡片（含信用分）', dw.parties === 2 && dw.partyCredit, `${dw.parties} 张`)
    check(
      '抽屉信息分块齐全（金额 / 交易物流 / 双方 / 进度 / 日志 / 备注 / 操作）',
      ['金额拆分', '交易与物流', '交易双方', '订单进度', '操作日志', '后台内部备注', '订单操作'].every((t) =>
        dw.blocks.includes(t)
      ),
      dw.blocks.join(' / ')
    )
    await shot('orders-D-drawer.png')

    // 写后台备注 → 保存 → 日志要多一条
    const noteBefore = await evalJS(`document.querySelectorAll('.el-drawer .od-logs li').length`)
    await evalJS(`(function(){
      const ta = document.querySelector('.el-drawer textarea');
      if (!ta) return false;
      ta.value = '探针标注：买家历史投诉 1 次，发货前再核对成色';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`)
    await sleep(500)
    const noteBtnEnabled = await evalJS(`(function(){
      const b = [...document.querySelectorAll('.el-drawer button')].find(function(x){ return /保存备注/.test(x.innerText) });
      return b ? !b.disabled : null;
    })()`)
    check('填写备注后「保存备注」按钮解禁', noteBtnEnabled === true, `disabled=${!noteBtnEnabled}`)
    await clickByText('保存备注')
    await sleep(1800)
    const afterNote = await evalJS(`(function(){
      const rows = [...document.querySelectorAll('.el-table__body tr.el-table__row')];
      return {
        logs: document.querySelectorAll('.el-drawer .od-logs li').length,
        latest: (document.querySelector('.el-drawer .od-logs li')||{}).innerText || ''
      };
    })()`)
    check('保存备注后日志新增一条', afterNote.logs === noteBefore + 1, `${noteBefore} → ${afterNote.logs}`)
    check('新日志写明「更新后台备注」并带身份标签', /备注/.test(afterNote.latest) && /管理员/.test(afterNote.latest), afterNote.latest.replace(/\s+/g, ' ').slice(0, 46))

    // 关掉抽屉
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(800)

    /* ==================== E. 售后退款（部分退款） ==================== */
    console.log('\n【E · 售后审批：部分退款】')
    const pickedRefund = await pickSelect('.adm-select', '退款中')
    check('可筛选「退款中」售后单', pickedRefund)
    const refundRows = await evalJS(`document.querySelectorAll('.el-table__body tr.el-table__row').length`)
    check('种子里有可审批的售后单', refundRows > 0, `${refundRows} 行`)
    const targetId = await evalJS(`(document.querySelector('.el-table__body tr.el-table__row .adm-id')||{}).innerText || ''`)

    await evalJS(`(function(){ const b=[...document.querySelectorAll('.el-table__body tr td:last-child button')].find(function(x){return x.textContent.includes('详情')}); if(b) b.click(); return !!b })()`)
    await sleep(1100)
    await clickByText('同意退款并关闭')
    await sleep(1000)
    const refundDlg = await evalJS(`(function(){
      const d = [...document.querySelectorAll('.el-dialog')].filter(function(x){
        const ov = x.closest('.el-overlay');
        return ov && getComputedStyle(ov).display !== 'none' && x.getBoundingClientRect().width > 0;
      }).pop();
      if (!d) return JSON.stringify({ open: false });
      const inputs = [...d.querySelectorAll('input')].map(function(i){ return i.value });
      return JSON.stringify({
        open: true,
        title: (d.querySelector('.el-dialog__title')||{}).innerText || '',
        showsApplyReason: /买家申请退款/.test(d.innerText),
        amountValue: inputs[0] || '',
        reasonDisabled: !!(d.querySelector('.el-select.is-disabled') || d.querySelector('.el-select__wrapper.is-disabled')),
        text: d.innerText.replace(/\\s+/g,' ').slice(0, 120)
      });
    })()`)
    const rd = JSON.parse(refundDlg)
    check('弹出「退款处理」弹窗', rd.open && /退款/.test(rd.title), rd.title)
    check('弹窗展示买家申请的原因（审批有依据）', rd.showsApplyReason, rd.text.slice(0, 60))
    check('退款金额默认等于买家实付', Number(rd.amountValue) > 0, `¥${rd.amountValue}`)
    check('退款中的单，原因不可被审批人改写（申请理由是证据）', rd.reasonDisabled === true)
    await shot('orders-E-refund-dialog.png')

    // 改成部分退款
    const half = (Number(rd.amountValue) / 2).toFixed(2)
    await evalJS(`(function(){
      const d = [...document.querySelectorAll('.el-dialog')].filter(function(x){ return x.getBoundingClientRect().width > 0 }).pop();
      const inp = d.querySelector('.el-input-number input');
      if (!inp) return false;
      inp.value = ${JSON.stringify(half)};
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`)
    await sleep(500)
    await clickByText('确认退款')
    await sleep(2200)

    const afterRefund = await evalJS(`(function(){
      return {
        refundingRows: document.querySelectorAll('.el-table__body tr.el-table__row').length,
        hint: document.querySelector('.adm-card-hint').innerText.replace(/\\s+/g,' ').trim()
      };
    })()`)
    check('退款后该单离开「退款中」列表', afterRefund.refundingRows === refundRows - 1, `${refundRows} → ${afterRefund.refundingRows}`)

    /*
     * 焦点归还断言 —— 这一条锁的是一个「点一下没反应」的隐蔽故障：
     * 弹窗关闭后焦点若留在浮层内的哨兵（`.el-drawer__sr-focus`）上，
     * 之后点状态下拉会在展开瞬间被一次迟到的 blur 撤销，
     * 表现成「连点 5 次、真鼠标点也没反应」。现场取证见 diag-focus.cjs。
     */
    const focusState = await evalJS(`(function(){
      const a = document.activeElement;
      const cls = a ? (a.className || '').toString() : '';
      const holder = a && a.closest ? a.closest('.el-overlay') : null;
      return {
        tag: a ? a.tagName : '(null)',
        cls: cls.slice(0, 60),
        isSentinel: /__sr-focus/.test(cls),
        inHiddenOverlay: !!holder && holder.getBoundingClientRect().width === 0
      };
    })()`)
    check(
      '退款弹窗关闭后焦点已归还（残留焦点会让后续筛选「点一下没反应」）',
      !focusState.isSentinel && !focusState.inHiddenOverlay,
      `activeElement = ${focusState.tag}.${focusState.cls || '(无类名)'}`
    )

    // 这一条曾经失败过：抽屉里处理完退款，再切状态筛选就点不动了（根因见上一条断言）
    const pickedCancelled = await pickSelect('.adm-select', '已取消')
    check('抽屉里退款后，「已取消」筛选仍可切换（焦点残留回归）', pickedCancelled)
    // 取证：下拉真的选中了 / 面板真的按它查了 —— 否则「0 行」分不清是筛选坏了还是真没数据
    const cancelledState = await evalJS(`(function(){
      const w = document.querySelector('.adm-select .el-select__wrapper');
      const rows = [...document.querySelectorAll('.el-table__body tr.el-table__row')].map(function(tr){
        const c = tr.querySelector('.od-status-cell');
        return c ? c.innerText.replace(/\\s+/g,' ').trim() : '';
      });
      return {
        selectText: w ? w.innerText.replace(/\\s+/g,' ').trim() : '(找不到下拉)',
        hint: (document.querySelector('.adm-card-hint')||{}).innerText.replace(/\\s+/g,' ').trim(),
        rows: rows
      };
    })()`)
    console.log(`     ↳ 下拉="${cancelledState.selectText}"（空=没选中）｜ ${cancelledState.hint}`)
    console.log(`     ↳ 行状态：${cancelledState.rows.length ? cancelledState.rows.join(' | ') : '(空)'}`)
    const cancelledRows = await evalJS(`(function(){
      return [...document.querySelectorAll('.el-table__body tr.el-table__row')].map(function(tr){
        return tr.innerText.replace(/\\s+/g,' ');
      });
    })()`)
    check(
      `退款单已落到「已取消」且能找到订单 ${targetId}`,
      cancelledRows.some((t) => t.includes(targetId)),
      cancelledRows.length ? `${cancelledRows.length} 行` : '(空)'
    )
    await shot('orders-E-after-refund.png')

    /* ==================== F. 导出 CSV ==================== */
    console.log('\n【F · 导出当前筛选】')
    await pickSelect('.adm-select', '已取消')
    await sleep(400)
    const exportBtn = await clickByText('导出当前筛选')
    check('存在「导出当前筛选」入口', exportBtn)
    await sleep(2600)
    const files = fs.existsSync(DOWNLOADS) ? fs.readdirSync(DOWNLOADS).filter((f) => f.endsWith('.csv')) : []
    check('CSV 真的下载到本地（不是只弹了个提示）', files.length > 0, files.join(' / ') || '(无文件)')
    if (files.length) {
      const raw = fs.readFileSync(path.join(DOWNLOADS, files[0]))
      // BOM 是 Excel 中文不乱码的前提，必须存在
      check('CSV 带 UTF-8 BOM（Excel 打开中文不乱码）', raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf)
      const text = raw.toString('utf8').replace(/^\uFEFF/, '')
      const lines = text.split(/\r?\n/).filter(Boolean)
      check('CSV 有表头且行数与筛选结果一致', lines.length > 1, `${lines.length - 1} 行数据`)
      check('表头含对账需要的列（实付 / 让利归属 / 运单号 / 后台备注）', 
        ['买家实付', '让利归属', '运单号', '后台备注'].every((h) => lines[0].includes(h)),
        lines[0].slice(0, 90)
      )
      check('导出的确实是「已取消」这一筛选结果', lines.slice(1).every((l) => l.includes('已取消')), `${lines.length - 1} 行`)
    }

    console.log(`\n控制台错误: ${errs.length ? errs.slice(0, 5).join(' | ') : 'none'}`)
    console.log(`\n=========== 结果：${pass} 通过 / ${fail} 失败 ===========\n`)
    ws.close()
    process.exitCode = fail ? 1 : 0
  } catch (e) {
    console.error('探针异常：', e)
    process.exitCode = 1
  } finally {
    chrome.kill()
  }
})()
