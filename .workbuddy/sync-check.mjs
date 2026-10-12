/**
 * 两份前端副本同步校验（T2 正本 vs T3 副本）
 *
 * 为什么需要它：本项目前端存在两份必须保持一致的副本 ——
 *   正本 = 实践任务2（Web前端开发作业要交的那份）
 *   副本 = 实践任务3（后端作业里配套的前端）
 * 只改一份是最容易犯的错，而且改错的那份往往几个月后才被发现。
 * 这个脚本对 `src/` 下所有文件做双向 MD5 比对，并额外比对 vite.config.ts。
 *
 * 用法：node .workbuddy/sync-check.mjs
 * 退出码：0 = 完全一致；1 = 存在差异
 */
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, relative } from 'node:path'

const ROOT =
  'C:\\Users\\刘宝杰\\Desktop\\软件开发项目实践\\软件开发'
const T2 = join(ROOT, '实践任务2：Web前端开发(Vue3+Element Plus+ECharts)', 'campus-secondhand-frontend')
const T3 = join(ROOT, '实践任务3：后端开发(前后端分离)', 'campus-secondhand-frontend')

/** 递归收集目录下所有文件的绝对路径（噪声目录下探前先剪掉，见 sync-front.mjs 同款注释） */
const PRUNE_DIRS = ['node_modules', 'dist', 'dist-deploy', 'dist-opt', '.workbuddy', '.idea', '.vite', 'coverage']
const shouldPrune = (name) => PRUNE_DIRS.includes(name) || name.startsWith('_旧dist-')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (shouldPrune(name)) continue
      walk(full, out)
    } else out.push(full)
  }
  return out
}

function md5(file) {
  return createHash('md5').update(readFileSync(file)).digest('hex')
}

/** 把一个基目录下的文件集映射为「相对路径 -> md5」 */
function snapshot(base) {
  const map = new Map()
  for (const f of walk(base)) map.set(relative(base, f).replace(/\\/g, '/'), md5(f))
  return map
}

/** 与同步无关的已知噪音：构建产物、IDE 状态、本地备份、vitest 临时文件 */
const IGNORE = [
  /^node_modules\//,
  /^dist\//,
  /^\.workbuddy\//,
  /^\.idea\//,
  /^\.vite\//,
  /vitest\.config\.ts\.timestamp-.*\.mjs$/,
  /^\.eslintcache$/,
  /^tsconfig\.tsbuildinfo$/,
  /*
   * ★ 2026-10-12 补：本地构建备份目录 `_旧dist-<日期>-勿部署/` ★
   * 它是人手备份下来的旧 dist（目录名自己就写着「勿部署」），里面有 100+ 个哈希文件。
   * 没排除它之前，`--dry` 会报「仅 T3 有 111 个文件」，其中 104 个是这个备份目录 ——
   * 真正需要同步的只有 7 个。噪音比 15:1 时没有人会认真看那份清单，
   * 于是真差异也就一起被忽略了。清单的作用是让差异**可读**，不是让差异更多。
   */
  /^_旧dist-/,
  /*
   * ★ 2026-10-12 再补：`dist-deploy/` ★
   * 上面排除了 `dist/`，但受限执行环境里 vite 的清空动作会被安全护栏拦下
   * （[SAFE_DELETE_BULK_CONFIRM_REQUIRED]，要删的文件数超阈值），
   * 于是发版构建改用 `vite build --outDir dist-deploy` 输出到全新目录 ——
   * 结果就是**多出一个 dist 的等价物**，而 `dist/` 那条规则盖不住它。
   * 症状与上一次同型：`--dry` 报 107 处差异，全是这个目录，真差异被淹没。
   * ★ 规则按目录名穷举就总有漏的；但这两处的判据同源（都是「构建产物」），
   *   所以两条规则也必须放在一起改 —— 与 PRUNE_DIRS 保持同源。
   */
  /^dist-deploy\//,
  // 覆盖率产物（vitest --coverage 的 HTML 报告），与 dist 同类
  /^coverage\//,
  // `npm run test:audit` 的口径报告：本机运行产物，只对生成它的那一次运行有意义
  /^\.vitest-report\.json$/
]
const isNoise = (k) => IGNORE.some((re) => re.test(k))

let bad = 0
const skipped = []

for (const relDir of ['src', '.']) {
  const a = snapshot(join(T2, relDir))
  const b = snapshot(join(T3, relDir))
  const keys = new Set([...a.keys(), ...b.keys()])
  let same = 0
  let diff = 0

  for (const k of [...keys].sort()) {
    if (isNoise(k)) {
      // 噪音不参与判定，但若只存在于某一侧，记录一笔便于人工确认
      if (a.get(k) === undefined || b.get(k) === undefined) skipped.push(`${relDir}/${k}`)
      continue
    }
    const va = a.get(k)
    const vb = b.get(k)
    if (va === undefined) {
      console.log(`  ONLY-IN-T3  ${relDir}/${k}`)
      diff++
    } else if (vb === undefined) {
      console.log(`  ONLY-IN-T2  ${relDir}/${k}`)
      diff++
    } else if (va !== vb) {
      console.log(`  MISMATCH    ${relDir}/${k}  T2=${va.slice(0, 8)} T3=${vb.slice(0, 8)}`)
      diff++
    } else {
      same++
    }
  }
  bad += diff
  console.log(`[${relDir}] 一致 ${same} 项，差异 ${diff} 项`)
  if (relDir === '.') break // 只需要 src + 根级一轮
}

if (skipped.length) {
  console.log(`\n（已忽略 ${skipped.length} 个噪音文件：${skipped.slice(0, 6).join(', ')}${skipped.length > 6 ? ' …' : ''}）`)
}
console.log(bad === 0 ? '\n✅ 两份前端完全同步' : `\n❌ 存在 ${bad} 处差异`)
process.exit(bad === 0 ? 0 : 1)
