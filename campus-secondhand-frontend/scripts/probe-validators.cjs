/**
 * 固定长度（手机号）校验探针（node scripts/probe-validators.cjs）
 *
 * 在真实浏览器里走「新增地址」流程，逐项验证 validators 的边界文案：
 *   ① 位数不足（138）          → 「手机号应为 11 位，当前为 3 位」
 *   ② 非法字符（…8000a）       → 「只能由数字组成」
 *   ③ 中间夹空格               → 「不能包含空格」
 *   ④ 号段非法（238…）         → 「应以 1 开头」
 *   ⑤ 首尾空格（' 138…000 '）  → 静默 trim 后通过 → 保存成功
 *   ⑥ 失焦行内提示（rules）    → .el-form-item__error 出现
 */
const http = require('http')
const fs = require('fs')
const { spawn } = require('child_process')

const TARGET = 'http://127.0.0.1:7788'
const OUT = 'C:/wbtmp'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9379
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
  try { await httpGet(TARGET + '/') } catch (e) { console.error(`预览服务不可用：${e.message}`); process.exit(2) }

  const chrome = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=C:/wbtmp/probe-validators-profile`,
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
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p(m.result) }
    })
    const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
    const evalJS = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.value
    const shot = async (name) => {
      const s = await send('Page.captureScreenshot', { format: 'png' })
      fs.writeFileSync(`${OUT}/${name}`, Buffer.from(s.data, 'base64'))
    }

    await send('Page.enable'); await send('Runtime.enable')
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false })
    await send('Page.navigate', { url: TARGET + '/' }); await sleep(1600)
    await evalJS(`localStorage.setItem('c2c-user', JSON.stringify({token:'mock-token-user-1'}))`)
    await evalJS(`localStorage.removeItem('c2c-app')`)
    await send('Page.navigate', { url: TARGET + '/user/profile' }); await sleep(2400)

    /** 打开「新增地址」抽屉，填收货人/手机号/地区/详址（可只填部分），点保存，回传 toast 文案 */
    const trySave = async (phone) => {
      await evalJS(`(function(){
        // 每次重开抽屉，状态干净
        const openBtn=[...document.querySelectorAll('button')].find(function(b){ return /新增地址/.test(b.innerText) });
        if(openBtn){ openBtn.click(); return 'opened' } return 'no-btn'
      })()`)
      await sleep(1000)
      // 收货人 + 详址
      await evalJS(`(function(){
        function setVal(el, val){
          const proto = el.tagName==='TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto,'value').set;
          setter.call(el, val);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const form=[...document.querySelectorAll('.el-drawer')].find(function(d){ return d.getBoundingClientRect().width>0 });
        if(!form) return 'no-drawer';
        const inputs=[...form.querySelectorAll('input, textarea')];
        const receiver=inputs.find(function(i){ const ph=i.placeholder||''; return i.type==='text' && !/138/.test(ph) && i.closest('.el-form-item').querySelector('.el-form-item__label').innerText.indexOf('收货人')>=0 });
        const phone=inputs.find(function(i){ return /138/.test(i.placeholder) });
        const detail=[...form.querySelectorAll('textarea')][0];
        if(receiver) setVal(receiver, '张三');
        if(phone) setVal(phone, ${JSON.stringify(phone)});
        if(detail) setVal(detail, '东区 5 号楼 302');
        return 'filled';
      })()`)
      await sleep(200)
      // 级联选区：点开 cascader，逐级点第一项
      await evalJS(`(function(){
        const form=[...document.querySelectorAll('.el-drawer')].find(function(d){ return d.getBoundingClientRect().width>0 });
        const cas=form.querySelector('.el-cascader');
        cas.scrollIntoView({block:'center'});
        cas.querySelector('.el-input__inner, input').dispatchEvent(new MouseEvent('click',{bubbles:true}));
        return 'cas-open';
      })()`)
      await sleep(900)
      for (let level = 0; level < 3; level++) {
        await evalJS(`(function(){
          // 关键：点「最右侧列」的第一个节点——列会随逐级展开从左往右追加，
          // 若每次都取全面板第一个节点会永远停在第一列（前几轮实测踩坑）
          const menus=[...document.querySelectorAll('.el-cascader-panel .el-cascader-menu')]
            .filter(function(mn){ return mn.getBoundingClientRect().width>0 && mn.querySelectorAll('.el-cascader-node').length>0 });
          const last=menus[menus.length-1];
          if(!last) return 'no-menu';
          const node=last.querySelector('.el-cascader-node:not(.is-disabled)');
          if(!node) return 'no-node';
          node.querySelector('.el-cascader-node__label').click();
          return 'picked-level-' + menus.length;
        })()`)
        await sleep(700)
      }
      await evalJS(`document.body.click()`)
      await sleep(300)
      // 点保存
      await evalJS(`(function(){
        const form=[...document.querySelectorAll('.el-drawer')].find(function(d){ return d.getBoundingClientRect().width>0 });
        const btn=[...form.querySelectorAll('button')].find(function(b){ return /^保 ?存$/.test(b.innerText.trim()) });
        if(btn){ btn.click(); return 'saved' } return 'no-save-btn'
      })()`)
      await sleep(900)
      return await evalJS(`(function(){
        const msg=document.querySelector('.el-message');
        return msg ? msg.innerText.trim() : '(无提示)';
      })()`)
    }

    console.log('\n【固定长度（手机号）校验 · 真实浏览器】')

    // 关抽屉辅助（保存失败时抽屉还开着，重开会重置）
    let toast = await trySave('138')
    check('① 位数不足 → 明确报位数', /11 位/.test(toast) && /3 位/.test(toast), toast)

    toast = await trySave('1380013800a')
    check('② 非法字符 → 只能由数字组成', /数字/.test(toast), toast)

    toast = await trySave('138 0013 8000')
    check('③ 中间夹空格 → 明确报错', /空格/.test(toast), toast)

    toast = await trySave('23800138000')
    check('④ 号段非法 → 报以 1 开头', /1 开头/.test(toast), toast)

    // 失焦行内提示（rules）：填非法手机号后触发 blur
    await evalJS(`(function(){
      const form=[...document.querySelectorAll('.el-drawer')].find(function(d){ return d.getBoundingClientRect().width>0 });
      const phone=[...form.querySelectorAll('input')].find(function(i){ return /138/.test(i.placeholder) });
      const proto=HTMLInputElement.prototype;
      const setter=Object.getOwnPropertyDescriptor(proto,'value').set;
      setter.call(phone,'138');
      phone.dispatchEvent(new Event('input',{bubbles:true}));
      phone.dispatchEvent(new Event('blur'));
      phone.dispatchEvent(new Event('change',{bubbles:true}));
      return 'ok';
    })()`)
    await sleep(800)
    const inlineErr = await evalJS(`(function(){
      const form=[...document.querySelectorAll('.el-drawer')].find(function(d){ return d.getBoundingClientRect().width>0 });
      const err=form.querySelector('.el-form-item__error');
      return err ? err.innerText.trim() : '(无行内错误)';
    })()`)
    check('⑤ 失焦行内提示（EP rules）出现', /11 位/.test(inlineErr), inlineErr)
    await shot('validators-inline-error.png')

    toast = await trySave(' 13800138000 ')
    check('⑥ 首尾空格静默 trim → 校验通过并保存成功', /地址已保存/.test(toast), toast)

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
