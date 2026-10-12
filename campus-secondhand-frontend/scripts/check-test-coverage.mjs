/**
 * 测试口径自检：证明「这一次测试真的把该跑的文件都跑了」。
 *
 * ============================================================================
 * ★ 它要解决的具体事故 ★
 * ============================================================================
 * 本机跑 `npm test`（vitest 默认的文件级并行）时，会**静默丢掉 1~2 个 spec 文件**：
 *
 *   并行第 1 次：28 个文件 / 618 个用例 / 退出码 0   ← 看起来全绿
 *   并行第 2 次：29 个文件 / 651 个用例 / 退出码 1
 *   串行：      30 个文件 / 723 个用例 / 退出码 0
 *
 * 每次丢的文件还不一样（先是 promo.spec.ts，再是 order.spec.ts，单独跑都过），
 * 伴生的报错是 `Unhandled Error: wrappedPromisesWriteFile … node-brokered-fs-shim.cjs`
 * —— 沙箱的文件系统 shim 把 worker 搞死了。
 *
 * 最恶劣的地方在于**退出码不可靠**：跑到 28 个文件、丢掉 3 个、退出码却是 0。
 * 也就是说 CI 与人工都会看到「全绿」，而实际有 100 多个用例根本没执行。
 * 历史记录里那句「29 个文件 / 651 个用例」就是这么来的 —— 它不是某一刻的真实值，
 * 而是某一次**残缺运行**留下的数字，之后被当作基线反复引用。
 *
 * ★ 所以这个脚本不改判定逻辑，只做一件事：数清楚 ★
 * 数磁盘上有多少个 `*.spec.ts`，数这次实际跑了多少个，两侧必须相等。
 * 「跑了几个」不由 vitest 的退出码或屏幕上的统计行决定，而由它自己产出的
 * JSON 报告决定 —— 那是同一份数据的另一种呈现，但可以逐个文件核对。
 *
 * 用法：npm run test:audit
 *   （= vitest run --no-file-parallelism --reporter=json --outputFile=.vitest-report.json
 *      && node scripts/check-test-coverage.mjs）
 * 退出码：0 = 文件数与用例数都对得上；1 = 有文件没跑或有用例失败；2 = 缺报告文件
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const REPORT = path.join(ROOT, '.vitest-report.json')
const SRC = path.join(ROOT, 'src')

if (!fs.existsSync(REPORT)) {
  console.error('✗ 找不到 .vitest-report.json —— 没有可核对的口径数据。')
  console.error('  请用 `npm run test:audit` 运行：它会让 vitest 额外产出一份 JSON 报告。')
  console.error('  （单独跑 `npm test` 是不会产出报告文件的，那样也就无从核对。）')
  process.exit(2)
}

/** 把任意写法的路径归一化成「正斜杠的绝对路径」，避免相对/绝对混用导致误判 */
const norm = (p) => path.resolve(ROOT, p).replace(/\\/g, '/')

/** 递归数出 src 下所有 spec 文件 */
function collectSpecs(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) collectSpecs(full, acc)
    else if (e.name.endsWith('.spec.ts')) acc.push(norm(full))
  }
  return acc
}

const onDisk = collectSpecs(SRC).sort()
const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'))
const results = Array.isArray(report.testResults) ? report.testResults : []
const ran = results.map((r) => norm(r.name)).sort()

const missing = onDisk.filter((f) => !ran.includes(f))
const unexpected = ran.filter((f) => !onDisk.includes(f))

const rel = (f) => path.relative(ROOT, f).replace(/\\/g, '/')

const total = report.numTotalTests ?? 0
const passed = report.numPassedTests ?? 0
const failed = report.numFailedTests ?? 0

console.log('─'.repeat(76))
console.log('测试口径自检')
console.log('─'.repeat(76))
console.log(`  磁盘上的 spec 文件 : ${onDisk.length}`)
console.log(`  本次实际执行       : ${ran.length}`)
console.log(`  用例               : ${passed} 通过 / ${failed} 失败 / 共 ${total}`)
console.log('─'.repeat(76))

let bad = false

if (missing.length) {
  bad = true
  console.error(`❌ 有 ${missing.length} 个 spec 文件**没有执行**（并行丢文件的典型症状）：`)
  for (const f of missing) console.error(`     - ${rel(f)}`)
  console.error('   这时的「全绿」是假的：这些文件里的用例一条都没跑。')
}

if (unexpected.length) {
  bad = true
  console.error(`❌ 报告里有 ${unexpected.length} 个 src 下不存在的 spec 文件（可能来自缓存）：`)
  for (const f of unexpected) console.error(`     - ${rel(f)}`)
}

if (total === 0) {
  bad = true
  console.error('❌ 用例数为 0 —— 报告是空的，不能据此认为测试通过。')
}

if (failed > 0) {
  bad = true
  console.error(`❌ 有 ${failed} 条用例失败。`)
}

if (!bad) {
  console.log(`✅ ${onDisk.length} 个 spec 文件全部执行，${passed} 条用例全部通过`)
  console.log('   （这个数字可以引用；`npm test` 的统计行在并行模式下不可信）')
}

process.exit(bad ? 1 : 0)
