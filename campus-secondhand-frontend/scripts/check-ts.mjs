/**
 * 仅做语法级校验（不依赖类型解析），快速发现 .ts 文件里的语法错误
 * 用法: node scripts/check-ts.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.ts') || e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

const files = [...walk(path.join(ROOT, 'src')), path.join(ROOT, 'vite.config.ts')]
const problems = []
let ok = 0

/**
 * 顶层同名重复声明检查。
 *
 * 为什么单列一项：`ts.createSourceFile` 只做**语法**解析，不会报
 * 「Multiple exports with the same name」——曾因此漏掉一个
 * `report.ts` 里新旧两个 `resolveReport` 并存的问题：语法检查通过、
 * 但 vite build 与 vitest 全部直接崩溃（esbuild 拒绝转译）。
 *
 * TS 里「类型空间」与「值空间」是两个独立的命名空间，
 * `interface Foo` + `const Foo` 是合法的，所以两者分开统计。
 *
 * ⚠️ 必须用 `ts.SyntaxKind` 的**数值**比较，不能反查字符串：
 * 枚举里存在别名（`SyntaxKind[256]` 反查到的是 `FirstStatement` 而不是
 * `VariableStatement`），用字符串判断会把 `export const` 全部漏掉。
 */
const K = ts.SyntaxKind
const TYPE_ONLY = new Set([K.InterfaceDeclaration, K.TypeAliasDeclaration])
const BOTH_SPACE = new Set([K.ClassDeclaration, K.EnumDeclaration])

function collectTopLevelNames(sf) {
  const seen = new Map()
  const dup = []
  const push = (name, space, pos) => {
    const key = `${space}:${name}`
    if (seen.has(key)) {
      const { line, character } = sf.getLineAndCharacterOfPosition(pos)
      dup.push(`[${line + 1}:${character + 1}] 重复声明「${name}」（同属${space}空间，已在本文件另一处声明）`)
    } else {
      seen.set(key, true)
    }
  }
  /** kind 为数值型 SyntaxKind；按声明所在命名空间分别登记 */
  const record = (name, kind, pos) => {
    if (!name || !name.text) return
    if (TYPE_ONLY.has(kind)) push(name.text, '类型', pos)
    else if (BOTH_SPACE.has(kind)) {
      push(name.text, '类型', pos)
      push(name.text, '值', pos)
    } else push(name.text, '值', pos)
  }

  for (const st of sf.statements) {
    // `declare global {}` / `declare module 'x' {}` 允许出现多次（声明合并），
    // auto-imports.d.ts 里就重复了 global，跳过以免误报
    if (st.kind === K.ModuleDeclaration) continue
    if (st.kind === K.VariableStatement) {
      for (const d of st.declarationList.declarations) record(d.name, K.VariableDeclaration, st.pos)
    } else if (st.kind === K.ImportDeclaration) {
      for (const s of st.importClause?.namedBindings?.elements ?? []) record(s.name, st.kind, st.pos)
      record(st.importClause?.name, st.kind, st.pos)
    } else {
      record(st.name, st.kind, st.pos)
    }
  }
  return dup
}

for (const file of files) {
  const source = fs.readFileSync(file, 'utf-8')
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true)
  const diags = sf.parseDiagnostics || []
  const id = path.relative(ROOT, file)

  const messages = []
  for (const d of diags) {
    const { line, character } = sf.getLineAndCharacterOfPosition(d.start)
    messages.push(`[${line + 1}:${character + 1}] ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`)
  }
  if (!diags.length) messages.push(...collectTopLevelNames(sf))

  if (messages.length) {
    for (const m of messages) problems.push(`${id} ${m}`)
  } else {
    ok++
  }
}

console.log(`\n扫描文件: ${files.length} 个 TS 文件\n`)
if (problems.length) {
  console.log(`❌ 发现 ${problems.length} 个语法问题:\n`)
  problems.forEach((p) => console.log('  ' + p))
  process.exit(1)
} else {
  console.log(`✅ 全部 ${ok} 个 TS 文件语法正确\n`)
}
