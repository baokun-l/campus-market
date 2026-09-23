/**
 * 全量校验所有 .vue 文件能否被 Vue 官方编译器解析
 * 用法: node scripts/check-vue.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(__dirname, '..', 'src')

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.vue')) out.push(p)
  }
  return out
}

const files = walk(SRC)
const errors = []
let ok = 0

for (const file of files) {
  const source = fs.readFileSync(file, 'utf-8')
  const id = path.relative(SRC, file)

  try {
    const { descriptor, errors: parseErrors } = parse(source, { filename: file })

    if (parseErrors && parseErrors.length) {
      for (const e of parseErrors) {
        errors.push(`[parse] ${id}:${e.loc?.start?.line ?? '?'}  ${e.message}`)
      }
      continue
    }

    if (descriptor.scriptSetup || descriptor.script) {
      try {
        compileScript(descriptor, { id })
      } catch (e) {
        errors.push(`[script] ${id}  ${e.message}`)
        continue
      }
    }

    if (descriptor.template) {
      const r = compileTemplate({
        source: descriptor.template.content,
        filename: file,
        id
      })
      if (r.errors && r.errors.length) {
        for (const e of r.errors) {
          const msg = typeof e === 'string' ? e : e.message
          const line = typeof e === 'object' && e.loc ? `:${e.loc.start.line}` : ''
          errors.push(`[template] ${id}${line}  ${msg}`)
        }
        continue
      }
    }

    ok++
  } catch (e) {
    errors.push(`[fatal] ${id}  ${e.message}`)
  }
}

console.log(`\n扫描文件: ${files.length} 个 .vue 文件\n`)
if (errors.length) {
  console.log(`❌ 发现 ${errors.length} 个问题:\n`)
  errors.forEach((e) => console.log('  ' + e))
  process.exit(1)
} else {
  console.log(`✅ 全部 ${ok} 个 .vue 文件编译通过，无语法错误\n`)
}
