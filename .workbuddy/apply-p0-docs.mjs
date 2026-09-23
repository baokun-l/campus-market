/**
 * B5-P0 文档回填（幂等：第二次跑退出码 0，且不会再追加一次）
 * ------------------------------------------------------------------
 *   1. 三份文档各追加一节（§二十四 / §十九 / 附二十二）
 *   2. 服务器部署适配清单：订正"demo 会 DROP 表"的旧结论 + 标注已落地
 *   3. 服务器部署适配清单：第 6 节检查表把已落地的项标上 ✅
 *
 * 判据：所有锚点必须**恰好命中一次** —— 0 次说明文档被改过、>1 次说明锚点不够独特，
 * 两种情况都以退出码 2 报错，绝不静默跳过。
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = 'C:/Users/刘宝杰/Desktop/软件开发项目实践/软件开发/实践任务3：后端开发(前后端分离)'
const p = (rel) => path.join(ROOT, rel)
const DEPLOY = 'campus-secondhand-backend/docs/服务器部署适配清单.md'

let changed = 0
const fail = (msg) => { console.log('  ✗ ' + msg); process.exitCode = 2 }

/**
 * 精确替换：needle 必须恰好出现一次。
 * ★ 必须幂等 ★ doneMarker 非空时，先检查"改后的特征"是否已在文件里 ——
 * 在就跳过。否则第二次运行会因为 needle 已被替换成别的内容而报"命中 0 次"，
 * 把一个正常的重复执行误报成故障（这次就是这么暴露的）。
 */
function sub(file, needle, replacement, doneMarker) {
  const f = p(file)
  const text = fs.readFileSync(f, 'utf8')
  if (doneMarker && text.includes(doneMarker)) { console.log('  · 已替换过，跳过 → ' + file); return }
  const n = text.split(needle).length - 1
  if (n !== 1) return fail(`锚点命中 ${n} 次（应为 1）→ ${file} :: ${needle.slice(0, 50)}`)
  fs.writeFileSync(f, text.replace(needle, replacement))
  changed++
  console.log('  ✓ 替换 → ' + file)
}

/** 追加一节（已存在就跳过，保证幂等） */
function appendSection(file, srcRel, marker) {
  const body = fs.readFileSync(p(srcRel), 'utf8')
  const f = p(file)
  const text = fs.readFileSync(f, 'utf8')
  if (text.includes(marker)) { console.log(`  · 已有 ${marker}，跳过`); return }
  fs.writeFileSync(f, text.replace(/\s*$/, '\n') + '\n' + body.replace(/^\s*\n/, ''))
  changed++
  console.log(`  ✓ 追加 ${marker}`)
}

console.log('=== B5-P0 文档回填 ===')

appendSection('项目缺陷检查与修复清单.md', '.workbuddy/_new-p0-section24.md', '## 二十四、B5-P0：部署护栏与 `prod` profile')
appendSection('缺陷清单逐条核对报告.md', '.workbuddy/_new-p0-section19.md', '## 十九、B5-P0：部署 P0 项的落地核对')
appendSection('campus-secondhand-backend/docs/后端设计说明.md', '.workbuddy/_new-p0-appendix22.md', '## 附二十二、部署护栏 `DeploymentGuard` 的设计')

/* ---- 订正"demo 会 DROP 表"的旧结论 ---- */
sub(DEPLOY,
  '一旦在生产上被带上，商品表会被重建、演示订单会被删除。**',
  '一旦在生产上被带上，商品、分类、订单与审核日志会被**清空并换成演示数据**。**\n' +
  '>\n' +
  '> ⚠️ **订正**：旧版写的是"商品表会被重建（DROP）"，**不准确**。核对 `db/demo-data.sql` 后确认：\n' +
  '> 实际是 `DELETE FROM t_goods / t_category / t_goods_audit_record / t_audit_log` 后重新 INSERT，\n' +
  '> `schema-auto.sql` 从来不 DROP —— **破坏的是数据，不是表结构**。严重程度不变（不可回滚），\n' +
  '> 但告警文案要写准（护栏里的提示因此写的是 `DELETE FROM ...`）。',
  '清空并换成演示数据')

/* ---- 在第 0 节结论之后插入"已落地"说明 ---- */
{
  const f = p(DEPLOY)
  let dep = fs.readFileSync(f, 'utf8')
  if (dep.includes('✅ **2026-09-22 更新**')) {
    console.log('  · 已落地说明已存在，跳过')
  } else {
    const anchor = '\n## 1. 配置管理与环境变量'
    if (dep.split(anchor).length - 1 !== 1) fail('找不到 §1 锚点')
    else {
      const note = '\n' +
        '> ✅ **2026-09-22 更新**：P0-1 / P0-2 / P0-3 / P0-4 / P0-5 / P0-9 **已落地并经真机复验**\n' +
        '> （新增 `DeploymentGuard` 启动护栏 + `application-prod.yml` + `deploy/` 三件套；\n' +
        '> 真机探针 `.workbuddy/e2e-p0-guard.mjs` **28 PASS / 0 FAIL**）。\n' +
        '> 未做的：P0-6 `mvnw`、P0-7 `spring-ai` 升 GA、P0-8 `logback-spring.xml`（待拍板）；\n' +
        '> P0-10 的 TLS 属基础设施，配置模板已在 `deploy/`。\n' +
        '> 细节见 `项目缺陷检查与修复清单.md` §二十四、`缺陷清单逐条核对报告.md` §十九。\n' +
        '\n---\n'
      dep = dep.replace(anchor, note + anchor)
      fs.writeFileSync(f, dep)
      changed++
      console.log('  ✓ 插入「已落地」说明')
    }
  }
}

/* ---- 第 6 节检查表：给已落地的项打勾（只在单元格内部改，不破坏列数） ---- */
{
  const f = p(DEPLOY)
  let d = fs.readFileSync(f, 'utf8')
  if (d.includes('**阻断 demo profile** ✅')) {
    console.log('  · 检查表已标注，跳过')
  } else {
    const marks = [
      ['**阻断 demo profile**', '**阻断 demo profile** ✅'],
      ['**时区三处统一**', '**时区三处统一** ✅'],
      ['**JWT_SECRET 必须设**', '**JWT_SECRET 必须设** ✅'],
      ['**prod profile 落地**', '**prod profile 落地** ✅'],
    ]
    for (const [from, to] of marks) {
      const n = d.split(from).length - 1
      if (n !== 1) fail(`检查表锚点命中 ${n} 次（应为 1）→ ${from}`)
      else d = d.replace(from, to)
    }
    fs.writeFileSync(f, d)
    changed++
    console.log('  ✓ 检查表打勾（4 项）')
  }
}

console.log(`\n完成：${changed} 处改动，退出码 ${process.exitCode ?? 0}`)
