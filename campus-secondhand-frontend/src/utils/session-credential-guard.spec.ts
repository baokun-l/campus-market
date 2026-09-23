/**
 * D9 静态看守 · 全站不得再把 `userStore.token` 当作「是否登录」的判据
 *
 * ★ 为什么必须有这么一条"看源码"的测试 ★
 *
 * D9 把会话凭据搬进 HttpOnly Cookie 之后，`store.token` 在**真实模式下恒为空串**。
 * 于是任何一处 `v-if="userStore.token"` / `if (user.token)` 都会静默变成
 * "永远为假"——不报错、不抛异常，只是某个能力**整体消失**：
 *   · App.vue 心跳：一次都不发 → 全站在线状态失灵；
 *   · AiAssistant.vue：悬浮入口永远不显示 → 后端 `/ai/**` 变成死代码；
 *   · permission.ts 守卫：冷启动永不拉 profile → 管理员进自己后台被 403。
 * 这三处本次都已经踩过（不是假设），而且**单元测试一个都拦不住** ——
 * 它们分别住在组件、路由守卫里，没有对应的行为测试会去断言"心跳有没有开表"。
 * 所以这里加一条源码级看守：这类回归在**写下的那一刻**就报红。
 *
 * ★ 判据锚"能力"而不是"字样" ★
 * 不是禁止出现 `token` 这个词（`Authorization` 头注入、mock 身份还原都要用它），
 * 而是禁止**把它当登录判据**。所以：
 *   · 白名单里的文件是"凭据的产地与唯一出口"，它们必然要碰 token；
 *   · 白名单之外出现 `userStore.token` / `user.token` 即违规 ——
 *     在那些地方，它除了当判据没有第二种用途。
 *
 * ★ 自证（防"恒真"）★
 * 一个只会 return [] 的扫描器能永远变绿，所以下面第三条用例拿**人造违规样本**
 * 喂给同一个扫描函数，断言它确实能命中；再用一个合法样本断言它不误报。
 * 没有这一条，这个文件本身就是在自欺。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/*
 * 拿 src 的绝对路径。
 * ★ 用 `process.cwd()` 而不是 `import.meta.url` ★：在 happy-dom 环境下
 * `import.meta.url` 不是 file:// 形式（实测报 "The URL must be of scheme file"），
 * 而 vitest 的 cwd 一定在项目根（vitest.config.ts 所在目录）。
 * 并且**必须校验它真的存在** —— 一个扫不到文件的扫描器会"零违规"通过，
 * 那是最典型的自欺（什么都查不到 ⇒ 什么都合格）。
 */
const SRC = join(process.cwd(), 'src')
if (!existsSync(SRC)) {
  throw new Error(`找不到被测源码目录：${SRC}（cwd=${process.cwd()}）—— 扫描器扫空目录会假绿，直接失败更诚实`)
}

/**
 * 允许出现 `<store>.token` 的文件（相对 src 的 posix 路径）。
 * 每一个都必须能说清"它为什么非碰不可"：
 *   · api/request.ts         —— 把 mock 模式的 token 注入 Authorization 头（真实模式恒空，自然不进）
 *   · stores/modules/user.ts —— token 字段的产地，以及自己决定持久化什么
 *   · api/session.ts         —— readToken / resolveSessionUser 的实现（mock 专用工具）
 *
 * 判据锚"能力"而不是"字样"：不是禁止 `token` 这个词，
 * 而是禁止**把它当登录判据**。所以做法是：这几处是凭据的产地与唯一出口，
 * 必然要碰它；别处出现它，除了当判据没有第二种用途 —— 一律违规。
 */
const TOKEN_ALLOWED = new Set([
  'api/request.ts',
  'api/session.ts',
  'stores/modules/user.ts'
])

/** 递归收集 src 下的 .ts / .vue 源文件（排除测试文件与测试基建） */
function collectSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    if (statSync(abs).isDirectory()) {
      if (name === 'test' || name === 'node_modules') continue
      collectSources(abs, out)
      continue
    }
    if (!/\.(ts|vue)$/.test(name)) continue
    if (name.endsWith('.spec.ts') || name.endsWith('.d.ts')) continue
    out.push(abs)
  }
  return out
}

const rel = (abs: string) => relative(SRC, abs).split(sep).join('/')

/**
 * 剥掉源码里的注释，但**保持行号与列位置不变**（注释字符一律换成空格，换行原样保留）。
 *
 * ★ 必须跟踪"块注释状态"，不能按行判断 ★
 * 这条纪律在 P1-11 的源码看守里已经交过一次学费：项目里的注释**故意在讨论旧写法**
 * （`permission.ts` 写着「触发条件以前写的是 userStore.token」、`AiAssistant.vue`
 * 写着「若沿用 userStore.token 做 v-if，入口会永远不显示」）——
 * 若不剥注释，这些解释性文字会把看守自己判成违规；若只按行首判断行注释，
 * 又会漏掉 script 段里跨行的块注释。
 *
 * 三个状态机：HTML 注释（Vue 模板）、块注释、行注释。
 * 行注释额外判一个 `src[i-1] !== ':'`，免得把 `https://…` 里的双斜杠当注释起点
 * （`.vue` 模板与 mock 数据里都有 URL，误剥会把同一行后面的真实代码一起吃掉）。
 * 已知边界：字符串字面量里的 `//`（且前面不是冒号）会被误当注释 ——
 * 本项目没有这种写法，出现了也只是少查一行、不会误报，方向是安全的。
 */
export function stripComments(src: string): string {
  const out: string[] = []
  let st: 'code' | 'block' | 'html' | 'line' = 'code'
  let i = 0
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]
    if (st === 'code') {
      if (c === '<' && n === '!') { st = 'html'; out.push('    '); i += 4; continue }
      if (c === '/' && n === '*') { st = 'block'; out.push('  '); i += 2; continue }
      if (c === '/' && n === '/' && src[i - 1] !== ':') { st = 'line'; out.push('  '); i += 2; continue }
      out.push(c); i++; continue
    }
    if (st === 'line') {
      if (c === '\n') { st = 'code'; out.push(c) } else out.push(' ')
      i++; continue
    }
    if (st === 'block') {
      if (c === '*' && n === '/') { st = 'code'; out.push('  '); i += 2; continue }
      out.push(c === '\n' ? '\n' : ' '); i++; continue
    }
    // html
    if (c === '-' && n === '-' && src[i + 2] === '>') { st = 'code'; out.push('   '); i += 3; continue }
    out.push(c === '\n' ? '\n' : ' '); i++
  }
  return out.join('')
}

/**
 * 扫描器核心：返回"把 token 当登录判据"的行号。
 *
 * 规则刻意定得**极端简单**：在**白名单之外**的文件里，只要出现
 * `<store>.token` 就违规。理由是这个项目里 token 只有三种正当用途 ——
 * 注入 Authorization 头、持久化配置、mock 身份还原 —— 而这三处全部在白名单内。
 * 所以别处出现它，除了当判据没有第二种可能，不需要去猜上下文
 * （判据越"聪明"，越容易在边界上放过真违规）。
 */
export function findTokenPredicateViolations(source: string): number[] {
  const hits: number[] = []
  stripComments(source).split('\n').forEach((line, i) => {
    if (/\b(?:userStore|user|store|s)\.token\b/.test(line)) hits.push(i + 1)
  })
  return hits
}

/** 把白名单一起考虑进去：白名单内的文件豁免 */
export function violationsInFile(relPath: string, source: string): number[] {
  if (TOKEN_ALLOWED.has(relPath)) return []
  return findTokenPredicateViolations(source)
}

describe('D9 静态看守 · 登录判据不得锚在 token 上', () => {
  it('剥注释是块感知的：三种注释都不算代码，且行号不漂移', () => {
    const vue = ['<template>', '  <!-- v-if="userStore.token" -->', '  <div v-if="userStore.isLoggedIn" />', '</template>'].join('\n')
    expect(findTokenPredicateViolations(vue)).toEqual([])
    const ts = ['/*', ' * 以前写的是 userStore.token', ' */', 'const t = userStore.token'].join('\n')
    // 第 2 行的注释不算，第 4 行的真代码算 —— 行号必须还是 4（剥注释不能把行号挪走）
    expect(findTokenPredicateViolations(ts)).toEqual([4])
    const url = ["const avatar = 'https://api.dicebear.com/7.x/initials'", 'const t = user.token'].join('\n')
    // URL 里的 // 不得被误当成行注释（否则第 2 行的真违规会被连带吃掉）
    expect(findTokenPredicateViolations(url)).toEqual([2])
  })

  it('扫描器本身有判别力：能命中人造违规，也不误报合法写法与豁免文件', () => {
    // ① 必须命中：这就是本次要根除的写法
    expect(violationsInFile('views/Home.vue', '    v-if="userStore.token"')).toEqual([1])
    expect(violationsInFile('App.vue', 'if (userStore.token) { onlineStore.startHeartbeat() }')).toEqual([1])
    expect(violationsInFile('utils/permission.ts', 'if (!userStore.profile && userStore.token) {')).toEqual([1])
    // ② 不得误报：正确的写法（mock 看 token、真实看 sessionHint，两者取或）
    expect(violationsInFile('App.vue', 'watch(() => userStore.isLoggedIn, () => {})')).toEqual([])
    // ③ 不得误报：注释里讨论这件事，恰恰是在提醒别人别这么写
    expect(violationsInFile('components/X.vue', '<!-- 若沿用 userStore.token 做 v-if，入口永远不显示 -->')).toEqual([])
    // ④ 不得误报：白名单文件里"把 token 当值用"（注入请求头）是正当用途
    expect(violationsInFile('api/request.ts', 'config.headers.Authorization = `Bearer ${userStore.token}`')).toEqual([])
  })

  it('白名单之外，任何文件都不得用 token 当登录判据', () => {
    const offenders: string[] = []
    for (const abs of collectSources(SRC)) {
      const r = rel(abs)
      const hits = violationsInFile(r, readFileSync(abs, 'utf8'))
      if (hits.length) offenders.push(`${r}:${hits.join(',')}`)
    }
    expect(offenders, `以下位置把 token 当成了登录判据（真实模式下恒为空串 → 能力静默失效）：\n${offenders.join('\n')}`)
      .toEqual([])
  })

  it('扫描范围自证：确实扫到了文件，且覆盖到三个曾经踩坑的位置', () => {
    const files = collectSources(SRC).map(rel)
    // 一个"什么都没扫到"的扫描器会零违规通过 —— 所以先证明它扫到了东西
    expect(files.length).toBeGreaterThan(50)
    for (const must of ['App.vue', 'components/common/AiAssistant.vue', 'utils/permission.ts']) {
      expect(files, `扫描范围漏了 ${must}`).toContain(must)
    }
  })

  it('白名单本身不得腐烂：列出的文件必须真的存在', () => {
    const existing = new Set(collectSources(SRC).map(rel))
    for (const f of TOKEN_ALLOWED) {
      expect(existing.has(f), `白名单里的 ${f} 不存在了 —— 改文件名时别忘了同步这份清单`).toBe(true)
    }
  })
})
