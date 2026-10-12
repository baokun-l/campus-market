/**
 * 清理 Vite / vite-node 在项目根目录留下的 `*.timestamp-*.mjs` 临时转译产物。
 *
 * ============================================================================
 * ★ 这些文件是什么、为什么会堆起来 ★
 * ============================================================================
 * 加载 `vitest.config.ts` / `vite.config.ts` 这类 **TS 配置**时，vite-node 会先把配置
 * 转译成一个 `*.timestamp-<ms>-<hash>.mjs` 放在配置旁边，正常退出时会自行删除。
 * 所以**每个文件都对应一次「进程没能正常退出」** —— 被超时 kill、被 Ctrl+C、
 * 或本机沙箱里 worker 崩掉（后者在本项目里很常见，见 `check-test-coverage.mjs`）。
 *
 * 本项目一次堆到 56 个，就是这么来的。
 *
 * ============================================================================
 * ★ 为什么是「归档」而不是 `rm` ★
 * ============================================================================
 * 它们确实是可以随时重新生成的构建垃圾（`.gitignore` 里写着「每次构建重新生成，不应入库」），
 * 删掉不会有任何信息损失。但**在用户桌面上执行未明确要求的删除是不可接受的**（项目既有纪律），
 * 所以这里一律**移动到归档目录**：根目录立刻干净，需要时还能翻回去看。
 *
 * 用法：
 *   node scripts/clean-vite-tmp.mjs --dry     # 只列不动
 *   node scripts/clean-vite-tmp.mjs           # 移动到 .workbuddy/_vite-tmp-archive/<时间戳>/
 * 退出码：0 = 完成（或 --dry 无文件）；1 = --dry 有文件待处理
 */
import fs from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const DRY = process.argv.includes('--dry')

/** 形状：<配置文件名>.timestamp-<毫秒>-<hash>.mjs */
const TMP_RE = /\.timestamp-\d+-[0-9a-z]+\.mjs$/i

const stamp = (() => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
})()

const ARCHIVE = join(ROOT, '.workbuddy', '_vite-tmp-archive', stamp)

const files = fs
  .readdirSync(ROOT, { withFileTypes: true })
  .filter((e) => e.isFile() && TMP_RE.test(e.name))
  .map((e) => e.name)
  .sort()

console.log(`扫描目录：${ROOT}`)
console.log(`命中 ${files.length} 个 vite/vite-node 临时产物`)

if (files.length === 0) {
  console.log('✅ 没有需要清理的文件。')
  process.exit(DRY ? 1 : 0)
}

if (DRY) {
  for (const f of files.slice(0, 10)) console.log(`  · ${f}`)
  if (files.length > 10) console.log(`  … 另有 ${files.length - 10} 个`)
  console.log(`\n[--dry] 未移动任何文件。去掉 --dry 即可归档到：\n  ${ARCHIVE}`)
  process.exit(1)
}

fs.mkdirSync(ARCHIVE, { recursive: true })
let moved = 0
for (const f of files) {
  const dst = join(ARCHIVE, f)
  // 同名文件理论上不会出现（文件名带毫秒时间戳），真撞上就跳过而不是覆盖
  if (fs.existsSync(dst)) continue
  fs.renameSync(join(ROOT, f), dst)
  moved++
}

console.log(`\n已归档 ${moved} 个文件 → ${ARCHIVE}`)
console.log('这些文件随时可以删掉：它们只是 vite-node 转译配置时的中间产物，')
console.log('之所以会堆积，是因为每次异常退出都没能自行清理（不是项目代码的问题）。')
