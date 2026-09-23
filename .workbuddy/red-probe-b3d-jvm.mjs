/**
 * 红绿探针（JVM 层）：`AuthInterceptor` 的公开白名单**方法敏感性**
 *
 * ★ 这一条为什么值得单独做一次红绿 ★
 * B3-d 放开游客浏览这件事，最危险的不是"放开太多"，而是**放开的判据退化**：
 * 白名单原本是按「方法 + 路径」判定的，一旦有人把
 *   `if (!"GET".equalsIgnoreCase(method)) return false;`
 * 这行删掉（或把白名单挪回 `excludePathPatterns`），
 * 而白名单里的商品详情是一条**通配路径** ——
 * 同一个 pattern 会立刻把 `DELETE /goods/{id}` 一起放行：
 * 任何人无需登录就能删除别人的商品。
 *
 * 这类退化**不会让任何既有测试变红**（原有测试只跑登录用户的正常动线），
 * 所以必须有专门的红：把判据打掉，测试要**立刻报红**。
 *
 * 判据 = 三层里最硬的那一层：**单测（证明调了什么）→ 红绿（证明用例有判别力）**。
 * （跨边界那一层由真机探针 .workbuddy/e2e-guest-surface.mjs 负责，62 条断言全绿。）
 *
 * 用法：node .workbuddy/red-probe-b3d-jvm.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const ROOT = String.raw`C:\Users\刘宝杰\Desktop\软件开发项目实践\软件开发\实践任务3：后端开发(前后端分离)`
const TARGET = join(ROOT, 'campus-secondhand-backend/src/main/java/com/campus/market/interceptor/AuthInterceptor.java')
const TEST = 'AuthInterceptorPublicPathTest'

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16)

/** 跑单测，返回 {code, out} */
function runTest() {
  try {
    const out = execFileSync(process.execPath, [join(ROOT, '.workbuddy/run-mvn.mjs'), `-Dtest=${TEST}`, 'test'],
      { encoding: 'utf8', cwd: ROOT })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? -1, out: (e.stdout || '') + (e.stderr || '') }
  }
}

let pass = 0, fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`) }
  else { fail++; failures.push(`${name} :: ${detail}`); console.log(`  FAIL  ${name}  -> ${detail}`) }
}

/** 从 maven 输出里取「Tests run: N, Failures: F, Errors: E」的最后一个汇总 */
function summary(out) {
  const all = [...out.matchAll(/Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)/g)]
  if (!all.length) return null
  const last = all[all.length - 1]
  return { total: +last[1], failures: +last[2], errors: +last[3] }
}

console.log('== 基线：未注入缺陷时必须全绿 ==')
const before = runTest()
const s0 = summary(before.out)
check('B0 单测全绿（24 个用例、0 失败）', s0 && s0.failures === 0 && s0.errors === 0,
  `summary=${JSON.stringify(s0)}`)
check('B0b 用例数确实跑了 24 个（不是"0 个用例通过"这种假绿）', s0?.total === 24, `total=${s0?.total}`)

console.log('\n== 注入缺陷：删掉「非 GET 一律不放行」那行 ==')
const original = readFileSync(TARGET, 'utf8')
const beforeSha = sha(original)

// 精确命中 isPublic() 里那一行（只在方法体里出现一次）
const FROM = '        if (!"GET".equalsIgnoreCase(method)) return false;\n'
const TO = '        // ★ 红绿探针临时删除：模拟"白名单退化成只按路径匹配"\n'
check('注入点存在（能在 isPublic 里定位到那一行）', original.includes(FROM),
  `文件里找不到：${JSON.stringify(FROM.trim())}`)

if (original.includes(FROM)) {
  try {
    writeFileSync(TARGET, original.replace(FROM, TO), 'utf8')
    const red = runTest()
    const s1 = summary(red.out)

    check('R1 ★ 注入后单测必须报红（说明用例有判别力）',
      s1 && (s1.failures > 0 || s1.errors > 0), `summary=${JSON.stringify(s1)}`)
    check('R2 ★ 报红的正是「同路径不同方法」那一组',
      /deleteGoodsDetailRejected|postGoodsRejected|patchGoodsStatusRejected|postCommentRejected/.test(red.out),
      `输出里没出现那几个用例名；尾部=${red.out.slice(-600).replace(/\n/g, ' | ')}`)
    check('R3 报错信息点明了"退化成只按路径匹配"',
      /只按路径匹配|任何人都能删别人的商品/.test(red.out),
      '断言消息没有出现在输出里 —— 排查时看不到原因')
  } finally {
    writeFileSync(TARGET, original, 'utf8')
    const after = sha(readFileSync(TARGET, 'utf8'))
    check('R4 已字节级还原（sha 一致）', beforeSha === after, `${beforeSha} -> ${after}`)
  }
}

console.log('\n== 收尾：还原后必须重新变绿 ==')
const after2 = runTest()
const s2 = summary(after2.out)
check('G1 还原后回到全绿', s2 && s2.failures === 0 && s2.errors === 0 && s2.total === 24,
  `summary=${JSON.stringify(s2)}`)

console.log('\n==================== 结果 ====================')
console.log(`PASS=${pass}  FAIL=${fail}`)
if (failures.length) {
  console.log('失败明细：')
  for (const f of failures) console.log('  - ' + f)
}
process.exit(fail === 0 ? 0 : 1)
