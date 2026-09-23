/**
 * 封禁闸门验证探针（node scripts/probe-ban.cjs）
 *
 * 背景：用户反馈「被封禁的账号还能正常使用」。根因是**三道闸门同时缺位**：
 *   ① `login()`      只看用户名密码，不看 status       → 封禁后照样能登进来
 *   ② `getProfile()` 按 token 还原身份时也不看 status   → F5 一下满血复活
 *   ③ 路由守卫把 ② 的异常整段 catch 掉（注释里一个 ignore）→ token 还在就放行
 * 外加 ② 里还有一条「认不出 token 就兜底成计算机小张」的旧逻辑，
 * 等于**任何乱写的 token 都能换到一个可用账号**。
 *
 * 本探针在真实浏览器里逐条把闸门钉死：
 *   A. 被封禁账号：登录被拒（第一道）
 *   B. 被封禁 token：刷新进不来 + 登录页给出原因（第二道）
 *   C. 认不出的 token：一律当未登录，不再兜底成任何人
 *   D. 正常账号：不受影响（不能把好人一起踢了）
 *   E. 待审核账号：能浏览，但发布入口被明确拦下
 *   F. 同一标签内被后台封禁 → 下一次跳转立刻掉线（第三道 + 同步复查）
 *
 * ⚠️ 开跑前必须先 build（preview 供的是 dist，不 build 验的是旧产物）
 *    与 probe-r18 相同：服务没起就 exit 2，别让人去源码里找一个不存在的 bug。
 */
const http = require('http')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const TARGET = 'http://127.0.0.1:7788'
const OUT = 'C:/wbtmp'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9347
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

/*
 * 种子账号 id（与 src/api/mock.ts 一致；前 12 位是演示数据，只增不改，所以可放心硬编码）。
 * 若哪天它们被重排，A/B/C 三项会立刻红 —— 这正是想要的早期报警。
 */
const UID = {
  active: 5,   // art_sun   画材孙同学 · active
  banned: 8,   // cloth_wu  服饰吴同学 · banned
  pending: 9,  // new_zheng 郑同学（待审核）· pending
}
const TOKEN = {
  admin: 'mock-token-admin',
  active: `mock-token-user-${UID.active}`,
  banned: `mock-token-user-${UID.banned}`,
  pending: `mock-token-user-${UID.pending}`,
}

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

  fs.mkdirSync(OUT, { recursive: true })
  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.join(OUT, 'probe-ban-profile')}`.replace(/\//g, '\\'),
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

    const setToken = (t) =>
      evalJS(`localStorage.setItem('c2c-user', ${JSON.stringify(JSON.stringify({ token: t }))}), localStorage.getItem('c2c-user')`)
    const clearToken = () => evalJS(`localStorage.removeItem('c2c-user'), localStorage.getItem('c2c-user')`)
    const where = () => evalJS(`({ path: location.pathname, search: location.search })`)
    /** 当前页面上是否有可见的 el-alert（登录页的「被踢原因」） */
    const alertText = () =>
      evalJS(`(function(){
        const a = [...document.querySelectorAll('.el-alert')].find(function(x){
          return x.getBoundingClientRect().width > 0;
        });
        return a ? a.innerText.replace(/\\s+/g,' ').trim() : '';
      })()`)
    /** 最新一条 ElMessage 文案（登录失败提示） */
    const toastText = () =>
      evalJS(`(function(){
        const ms = [...document.querySelectorAll('.el-message')];
        const m = ms[ms.length - 1];
        return m ? m.innerText.replace(/\\s+/g,' ').trim() : '';
      })()`)

    /*
     * 填表 + 点击必须拆成两次 evaluate。
     * 挤在一次里的话 Vue 还没跑完更新，按钮的 disabled 仍是旧值，点击会被吞掉，
     * 表现成「提交没反应」—— 这个坑踩过，别再合回去。
     */
    const fillLogin = (user, pwd) =>
      evalJS(`(function(){
        const u = document.querySelector('.login-card input');
        const p = document.querySelector('.login-card input[type=password]');
        if (!u || !p) return false;
        u.value = ${JSON.stringify(user)}; u.dispatchEvent(new Event('input', { bubbles: true }));
        p.value = ${JSON.stringify(pwd)}; p.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`)
    const clickSubmit = () => evalJS(`(document.querySelector('.submit-btn')?.click(), true)`)

    await send('Page.enable')
    await send('Runtime.enable')
    await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false })
    await go('/', 1800)
    await clearToken()

    /* ==================== A. 被封禁账号登录被拒（闸门①） ==================== */
    console.log('\n【A · 闸门①：被封禁账号无法登录】')
    await go('/login', 1800)
    await clearToken()
    const filled = await fillLogin('cloth_wu', '123456')
    check('登录表单可填写', filled)
    await sleep(400)
    await clickSubmit()
    await sleep(1400)
    const afterLogin = await where()
    const toast = await toastText()
    const tokenAfter = await evalJS(`localStorage.getItem('c2c-user')`)
    check('登录停在登录页（没有被放进去）', afterLogin.path === '/login', `path=${afterLogin.path}`)
    check('给出「已被封禁」的明确文案', /封禁/.test(toast), toast || '(无提示)')
    check('失败后不落 token（没有留下半登录态）', !tokenAfter, tokenAfter || 'null')
    await shot('ban-A-login-rejected.png')

    /* ==================== B. 封禁 token 刷新不能复活（闸门②） ==================== */
    console.log('\n【B · 闸门②：带着封禁 token 刷新进不来】')
    await setToken(TOKEN.banned)
    await go('/home', 2800)
    const bWhere = await where()
    const bAlert = await alertText()
    check('访问 /home 被送回登录页', bWhere.path === '/login', `path=${bWhere.path}`)
    check('地址栏带上 revoked=banned（说明原因）', /revoked=banned/.test(bWhere.search), bWhere.search)
    check('登录页展示封禁原因提示', /封禁/.test(bAlert), bAlert.slice(0, 40) || '(无 alert)')
    await shot('ban-B-token-revived.png')

    // 关掉提示后刷新，不应再弹旧提示（?revoked= 已被抹掉）
    await evalJS(`(function(){ const b = document.querySelector('.el-alert__close-btn'); if (b) b.click(); return true })()`)
    await sleep(700)
    const cleared = await where()
    check('点掉提示后 URL 里的 revoked 被抹掉', !/revoked=/.test(cleared.search), cleared.search || '(无 query)')

    /* ==================== C. 认不出的 token 不再兜底成「计算机小张」 ==================== */
    console.log('\n【C · 认不出的 token 一律当未登录】')
    for (const [name, tk] of [['不存在的用户 id', 'mock-token-user-99999'], ['彻底乱写的串', 'garbage-token-abc']]) {
      await setToken(tk)
      await go('/home', 2600)
      const w = await where()
      const a = await alertText()
      check(`token「${name}」→ 未登录（不是兜底账号）`, w.path === '/login' && /revoked=expired/.test(w.search), `${w.path}${w.search}`)
      check(`token「${name}」→ 提示「登录状态已失效」`, /失效/.test(a), a.slice(0, 36) || '(无 alert)')
    }
    await shot('ban-C-bad-token.png')

    /* ==================== D. 正常账号不受影响 ==================== */
    console.log('\n【D · 正常账号不受影响】')
    await setToken(TOKEN.active)
    await go('/home', 2800)
    const dWhere = await where()
    const dAlert = await alertText()
    check('正常账号能正常进首页', dWhere.path === '/home', `path=${dWhere.path}`)
    check('正常账号不会看到任何被踢提示', !dAlert, dAlert.slice(0, 30) || '(无 alert)')
    const stillToken = await evalJS(`localStorage.getItem('c2c-user')`)
    check('正常账号 token 未被误清', /mock-token-user-5/.test(stillToken || ''), (stillToken || '').slice(0, 30))

    /* ==================== E. 待审核账号：能看，不能发 ==================== */
    console.log('\n【E · 待审核账号：可浏览，发布被拦】')
    await setToken(TOKEN.pending)
    await go('/home', 2800)
    const eWhere = await where()
    check('待审核账号能进首页（不踢人）', eWhere.path === '/home', `path=${eWhere.path}`)

    /*
     * 发布页的真实路由是 /goods/publish（不是 /publish）。
     * 踩过一次：写错路径时 SPA 的 404 兜底页会让 location.pathname **照样等于 /publish**，
     * 「路径对得上」的断言于是误判成通过 —— 所以这里额外断言「不是 404 页」。
     */
    await go('/goods/publish', 3000)
    const ePub = await where()
    const is404 = await evalJS(`/页面不存在|404/.test(document.body.innerText.slice(0, 120))`)
    check('发布页能打开（不是 404 兜底页）', ePub.path === '/goods/publish' && !is404, `path=${ePub.path} 404=${is404}`)

    const eBanner = await evalJS(`(function(){
      const tip = document.querySelector('.review-tip');
      const btn = [...document.querySelectorAll('button')].find(function(b){ return /提交审核/.test(b.innerText) });
      return {
        tip: tip ? tip.innerText.replace(/\\s+/g,' ').slice(0, 46) : '',
        btnDisabled: btn ? !!btn.disabled : null,
        draftDisabled: (function(){ var d = [...document.querySelectorAll('button')].find(function(b){ return /保存草稿/.test(b.innerText) }); return d ? !!d.disabled : null })()
      };
    })()`)
    check('发布页在填表前就说明「账号正在审核中」', /审核中/.test(eBanner.tip), eBanner.tip || '(未见提示条)')
    check('「提交审核」按钮被禁用（不是填完才报错）', eBanner.btnDisabled === true, `disabled=${eBanner.btnDisabled}`)
    check('「保存草稿」同样被禁用', eBanner.draftDisabled === true, `disabled=${eBanner.draftDisabled}`)
    await shot('ban-E-pending-publish.png')

    /* ==================== F. 同一标签内中途被封 → 立刻掉线 ==================== */
    console.log('\n【F · 管理员封禁 → 同一标签内下一次跳转立刻掉线】')
    await setToken(TOKEN.admin)
    await go('/admin?tab=users', 3800)

    /*
     * 用户管理页**默认筛「待审核」**（打开即待办队列，是刻意的设计）。
     * 所以要找的是 active 用户，必须先把筛选项切到「正常」——
     * 第一次写探针时没切，搜 art_sun 得到 0 行，误以为「表格渲染坏了」。
     *
     * 另一个坑：EP 2.14 的 el-select 必须点 `.el-select__wrapper` 才会展开。
     * 点外层 `.adm-select` 什么都不发生（dropdown 根本不渲染），
     * 于是候选列表为空、断言看起来像「下拉坏了」。
     */
    const opened = await evalJS(`(function(){
      const w = document.querySelector('.adm-select .el-select__wrapper');
      if (!w) return false;
      w.click();
      return true;
    })()`)
    check('能打开状态筛选下拉', opened)
    await sleep(800)
    const picked = await evalJS(`(function(){
      const items = [...document.querySelectorAll('.el-select-dropdown__item')].filter(function(i){
        return i.getBoundingClientRect().width > 0;
      });
      const t = items.find(function(i){ return i.innerText.trim() === '正常' });
      if (!t) return { ok: false, opts: items.map(function(i){ return i.innerText.trim() }) };
      t.click();
      return { ok: true };
    })()`)
    check('状态筛选可切到「正常」', picked.ok, picked.ok ? '' : `候选=${JSON.stringify(picked.opts)}`)
    await sleep(1400)

    const searched = await evalJS(`(function(){
      const inp = document.querySelector('.adm-toolbar input');
      if (!inp) return false;
      inp.value = 'art_sun';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`)
    check('后台用户管理可搜索目标账号', searched)
    await sleep(1300)

    const banned = await evalJS(`(function(){
      const rows = [...document.querySelectorAll('.el-table__body-wrapper tbody tr')];
      const row = rows.find(function(r){ return /art_sun/.test(r.innerText) });
      if (!row) return { ok: false, reason: '未找到 art_sun 行' };
      const btn = [...row.querySelectorAll('button')].find(function(b){ return /封禁/.test(b.innerText) });
      if (!btn) return { ok: false, reason: '该行没有「封禁」按钮' };
      btn.click();
      return { ok: true, rowText: row.innerText.replace(/\\s+/g,' ').slice(0, 40) };
    })()`)
    check('找到目标行并点「封禁」', banned.ok, banned.ok ? banned.rowText : banned.reason)
    await sleep(700)

    const confirmed = await evalJS(`(function(){
      const box = [...document.querySelectorAll('.el-message-box')].find(function(b){
        return b.getBoundingClientRect().width > 0;
      });
      if (!box) return { ok: false };
      const title = (box.querySelector('.el-message-box__title') || {}).innerText || '';
      const btn = box.querySelector('.el-message-box__btns .el-button--primary');
      if (btn) btn.click();
      return { ok: true, title: title.trim() };
    })()`)
    check('弹出确认框并确认封禁', confirmed.ok, confirmed.title || '')
    await sleep(1600)

    /*
     * 封禁成功后该行会**从「正常」列表里消失**（状态已不是 active，被筛掉了）。
     * 所以这里不能断言「同一行变成已封禁」—— 那是错的行为预期。
     * 正确预期：这一行不见了，且切到「已封禁」筛选项能重新找到它。
     */
    const afterBan = await evalJS(`(function(){
      const rows = [...document.querySelectorAll('.el-table__body-wrapper tbody tr')];
      return rows.map(function(r){ return r.innerText.replace(/\\s+/g,' ') });
    })()`)
    check(
      '封禁后该账号从「正常」列表消失（筛选项语义正确）',
      !afterBan.some((t) => /art_sun/.test(t)),
      afterBan.length ? `剩 ${afterBan.length} 行` : '列表已空'
    )

    // 切到「已封禁」确认它真的还在（不是被删了）
    await evalJS(`(function(){
      const w = document.querySelector('.adm-select .el-select__wrapper');
      if (w) w.click();
      return true;
    })()`)
    await sleep(700)
    await evalJS(`(function(){
      const items = [...document.querySelectorAll('.el-select-dropdown__item')].filter(function(i){
        return i.getBoundingClientRect().width > 0;
      });
      const t = items.find(function(i){ return i.innerText.trim() === '已封禁' });
      if (t) t.click();
      return !!t;
    })()`)
    await sleep(1400)
    const bannedList = await evalJS(`(function(){
      const rows = [...document.querySelectorAll('.el-table__body-wrapper tbody tr')];
      return rows.map(function(r){ return r.innerText.replace(/\\s+/g,' ') });
    })()`)
    check(
      '切到「已封禁」能重新找到它（是状态变了，不是被删了）',
      bannedList.some((t) => /art_sun/.test(t)),
      bannedList.length ? `该筛选下 ${bannedList.length} 行` : '列表为空'
    )

    /*
     * 关键一步：把 localStorage 换成刚被封的账号 token，但**不刷新页面**。
     * 此时 store 内存里还是管理员的 profile（token 也是管理员的），
     * 走一次 SPA 内部跳转（点后台菜单）就会触发守卫里的同步复查 ——
     * 这正是「同一标签内封禁立刻生效」的真实路径。
     * 直接 Page.navigate 是整页刷新，那验的是闸门②，不是闸门③。
     *
     * 侧栏 el-menu 带 `router` 属性，点 li 即 router.push，不会整页刷新。
     */
    await setToken(TOKEN.active)
    const clickedMenu = await evalJS(`(function(){
      const items = [...document.querySelectorAll('.layout-menu .el-menu-item')];
      const target = items.find(function(i){ return /商品广场/.test(i.innerText) }) || items[0];
      if (!target) return false;
      target.click();
      return true;
    })()`)
    check('在不刷新的前提下走一次站内跳转', clickedMenu)
    await sleep(2400)
    const fWhere = await where()
    const fAlert = await alertText()
    check('中途被封的账号在下一次跳转立刻掉线', fWhere.path === '/login', `path=${fWhere.path}`)
    check('掉线地址带 revoked=banned', /revoked=banned/.test(fWhere.search), fWhere.search)
    check('掉线时说明「已自动退出登录」', /封禁/.test(fAlert), fAlert.slice(0, 46) || '(无 alert)')
    await shot('ban-F-midsession-kick.png')

    const leftover = await evalJS(`localStorage.getItem('c2c-user')`)
    check('掉线后 token 已被清空（不是只跳个页）', !leftover || !/mock-token-user-5/.test(leftover), (leftover || 'null').slice(0, 30))

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
