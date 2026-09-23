/**
 * 构建产物体积对比：dist（优化前基线） vs dist-opt（优化后）
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

function measure(dir) {
  const assets = path.join(dir, 'assets')
  if (!fs.existsSync(assets)) return null
  let js = 0,
    jsGz = 0,
    css = 0,
    cssGz = 0,
    jsN = 0,
    cssN = 0
  const rows = []
  for (const f of fs.readdirSync(assets)) {
    const buf = fs.readFileSync(path.join(assets, f))
    const gz = zlib.gzipSync(buf, { level: 9 }).length
    if (f.endsWith('.js')) {
      js += buf.length
      jsGz += gz
      jsN++
    } else if (f.endsWith('.css')) {
      css += buf.length
      cssGz += gz
      cssN++
    }
    rows.push({ f, size: buf.length, gz })
  }
  const html = fs.existsSync(path.join(dir, 'index.html'))
    ? fs.statSync(path.join(dir, 'index.html')).size
    : 0
  return { js, jsGz, css, cssGz, jsN, cssN, html, rows }
}

const kb = (n) => (n / 1024).toFixed(2)

const before = measure('dist')
const after = measure('dist-opt')

if (!before || !after) {
  console.error('缺少 dist 或 dist-opt 目录，无法对比')
  process.exit(1)
}

const line = (label, a, b, unit = 'KB') => {
  const aK = a / 1024
  const bK = b / 1024
  const diff = bK - aK
  const pct = aK === 0 ? '—' : ((diff / aK) * 100).toFixed(1) + '%'
  const sign = diff > 0 ? '+' : ''
  console.log(
    label.padEnd(22),
    kb(a).padStart(11),
    kb(b).padStart(11),
    (sign + diff.toFixed(2)).padStart(12),
    (diff < 0 ? '' : '+') + pct === '+—' ? pct : (diff < 0 ? '' : '+') + pct
  )
}

console.log('')
console.log('指标'.padEnd(20) + '优化前(KB)'.padStart(13) + '优化后(KB)'.padStart(13) + '变化(KB)'.padStart(14) + '变化率'.padStart(11))
console.log('-'.repeat(74))
line('JS 原始体积', before.js, after.js)
line('JS gzip 体积', before.jsGz, after.jsGz)
line('CSS 原始体积', before.css, after.css)
line('CSS gzip 体积', before.cssGz, after.cssGz)
line('总计 gzip 体积', before.jsGz + before.cssGz + before.html, after.jsGz + after.cssGz + after.html)
console.log('-'.repeat(74))
console.log('JS 文件数'.padEnd(20), String(before.jsN).padStart(11), String(after.jsN).padStart(11))
console.log('CSS 文件数'.padEnd(20), String(before.cssN).padStart(11), String(after.cssN).padStart(11))

console.log('')
console.log('=== 核心 vendor chunk gzip 对比 ===')
const keyOf = (rows, kw) => rows.find((r) => r.f.startsWith(kw))
for (const kw of ['ui-', 'echarts-', 'vue-']) {
  const a = keyOf(before.rows.filter((r) => r.f.endsWith('.js')), kw)
  const b = keyOf(after.rows.filter((r) => r.f.endsWith('.js')), kw)
  if (!a || !b) continue
  const d = b.gz - a.gz
  console.log(
    kw.padEnd(12),
    kb(a.gz).padStart(10) + ' KB',
    '→',
    kb(b.gz).padStart(10) + ' KB',
    (d < 0 ? '' : '+') + kb(d) + ' KB',
    '(' + ((d / a.gz) * 100).toFixed(1) + '%)'
  )
}
console.log('')
