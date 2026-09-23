/**
 * 扫描项目真实使用到的 @element-plus/icons-vue 图标
 * 判据（双重，避免误报）：
 *   A. 模板中以组件标签形式出现：  <House />  <House>
 *   B. 字符串字面量中出现：       icon: 'House'   :is="'House'"
 * 只要命中任一，即视为「用到了」。
 */
import fs from 'node:fs'
import path from 'node:path'

const iconsEntry = 'node_modules/@element-plus/icons-vue/dist/index.js'
const src = fs.readFileSync(iconsEntry, 'utf8')
const exportBlock = /export\s*\{([^}]+)\}/.exec(src)
const ALL_ICONS = [
  ...new Set(
    (exportBlock ? exportBlock[1] : '')
      .split(',')
      .map((s) => s.trim().split(/\s+as\s+/).pop())
      .filter((x) => /^[A-Z][A-Za-z0-9]*$/.test(x))
  )
]
const iconSet = new Set(ALL_ICONS)

/** 收集项目源码 */
const files = []
;(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) walk(p)
    else if (/\.(vue|ts)$/.test(name) && !/\.spec\.ts$/.test(name)) files.push(p)
  }
})('src')

const hits = new Map() // iconName -> Set<file>

/** 模板标签形式：<House  /  <House> */
const tagRe = /<([A-Z][A-Za-z0-9]*)[\s/>]/g
/** 字符串字面量形式：'House' 或 "House"（用于 icon: 'House' / :is="'House'"） */
const strRe = /['"]([A-Z][A-Za-z0-9]*)['"]/g

for (const f of files) {
  const text = fs.readFileSync(f, 'utf8')
  for (const re of [tagRe, strRe]) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(text))) {
      const name = m[1]
      if (!iconSet.has(name)) continue
      if (!hits.has(name)) hits.set(name, new Set())
      hits.get(name).add(f.replace(/\\/g, '/'))
    }
  }
}

const used = [...hits.keys()].sort()
console.log('图标库总导出 :', ALL_ICONS.length)
console.log('项目实际用到 :', used.length)
console.log('可裁剪掉     :', ALL_ICONS.length - used.length)
console.log('')
console.log('=== 用到的图标（含来源文件）===')
used.forEach((n) => {
  console.log('  ' + n.padEnd(18) + [...hits.get(n)].map((x) => x.replace('src/', '')).join(', '))
})

const out = `/**
 * Element Plus 图标按需注册表
 * 由 scripts/scan-icons.mjs 扫描 src/ 生成，共 ${used.length} 个（图标库共 ${ALL_ICONS.length} 个）。
 * 只注册项目真正用到的图标，避免全量引入带来的体积浪费。
 */
import {
${used.map((n) => '  ' + n).join(',\n')}
} from '@element-plus/icons-vue'

export const appIcons = {
${used.map((n) => '  ' + n).join(',\n')}
}
`
fs.writeFileSync('src/icons.ts', out)
console.log('\n已生成 src/icons.ts')
