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

/** 递归收集目录下所有文件的绝对路径 */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else out.push(full)
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
  /^tsconfig\.tsbuildinfo$/
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
