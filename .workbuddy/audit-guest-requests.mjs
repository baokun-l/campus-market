/**
 * 游客可达面静态审计（B3-d 放开游客浏览的配套检查）
 *
 * ★ 为什么必须做这一步 ★
 * 前端 `request.ts` 对 **401** 的处理是「提示『登录状态已过期』+ 清 token + 跳登录页」。
 * 这在「登录用户 token 过期」场景下是对的；
 * 但对**从未登录过的游客**来说，只要公开页面（商品广场/详情/公告/关于/他人主页）
 * 里有一个调用没有做登录判断，游客打开页面就会被弹一个莫名其妙的
 * 「登录状态已过期，请重新登录」甚至被踢去登录页 ——
 * 而这恰恰是放开游客浏览最容易踩、也最难在人工点测中发现的坑
 * （因为点测时你自己通常是登录状态）。
 *
 * ============================================================
 * ★★ 本脚本的两次「撒谎」，以及为什么现在的写法能自证 ★★
 * ============================================================
 *
 * 【第一次】用正则整段剥块注释 → 把真白名单一起删掉了。
 *   原因：商品详情的通配路径（星号紧跟斜杠）恰好构成块注释的结束序列，
 *   正则一路吃到下一个同样的序列，把整段白名单吃没了。
 *   后果：白名单被抽小 → 判定"需要登录" → 报出一堆假命中。
 *   改法：**逐行判断**（只有以 * / // 开头的行才算注释），见 extractList()。
 *
 * 【第二次】把「附近 30 行内出现过 isLoggedIn」当作"有守卫"。
 *   两个方向都错：
 *     · 漏（危险）：`isLoggedIn` 来自**相邻的另一个函数**，本调用点其实没守
 *       —— 历史上 `recordHistory` 就是这么被误判成"有守卫"的，而它恰恰是
 *       详情页**加载时必然发出**的那个请求。
 *     · 多（噪音）：守卫被抽成了 `requireLogin()` 之后，函数体里不再直接出现
 *       `isLoggedIn`，于是**所有**调用点都被报成"无守卫"，6 个假命中。
 *       一个总是喊狼来了的审计等于没有审计。
 *   改法：把判据从「附近若干行」改成「**同一个函数体内**」——
 *     先向上找到包住调用点的那个函数定义，再看它到调用点之间有没有守卫。
 *     守卫词表也扩成 { isLoggedIn | requireLogin( | requireAuth }。
 *
 * 【纪律】**审计脚本自身的失败必须是响亮的**（退出码 2），不能静默"通过"。
 *   所以下面有一整套自证：解析到的路由数、API 函数数、守卫命中数都必须 > 0，
 *   且必须能在已知必然有守卫的 Detail.vue 里认出守卫来。
 *
 * 用法：node .workbuddy/audit-guest-requests.mjs
 * 退出码：0 = 未发现无守卫的游客可达调用；1 = 存在高风险调用点；2 = 脚本自身解析失败
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = String.raw`C:\Users\刘宝杰\Desktop\软件开发项目实践\软件开发\实践任务3：后端开发(前后端分离)`
const BE = join(ROOT, 'campus-secondhand-backend')
const FE = join(ROOT, 'campus-secondhand-frontend')

/** 脚本自身解析失败 → 用退出码 2 响亮地失败，绝不能伪装成 0（通过） */
function selfFail(msg) {
  console.error('\n★★★ 审计脚本自身失败 ★★★')
  console.error(msg)
  console.error('（这不代表代码有问题，代表**审计本身**不可信 —— 请先修脚本再看结论）\n')
  process.exit(2)
}

/* ============================================================
 * ① 后端：抽出匿名可达的路径（唯一权威来源）
 * ============================================================ */
const interceptor = readFileSync(
  join(BE, 'src/main/java/com/campus/market/interceptor/AuthInterceptor.java'), 'utf8')

function extractList(name) {
  const re = new RegExp(`List<String>\\s+${name}\\s*=\\s*List\\.of\\(([\\s\\S]*?)\\);`)
  const m = interceptor.match(re)
  if (!m) selfFail(`未能在 AuthInterceptor 中找到 ${name}`)
  // ★ 逐行判断注释（见文件头【第一次】）：不做整段正则剥离
  const out = []
  for (const line of m[1].split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('*') || t.startsWith('/*') || t.startsWith('//')) continue
    for (const x of t.matchAll(/"([^"]+)"/g)) out.push(x[1])
  }
  if (out.length === 0) selfFail(`${name} 解析出 0 条 —— 解析器坏了`)
  return out
}

const PUBLIC_GET = extractList('PUBLIC_GET')   // 仅 GET 放行
const PUBLIC_ANY = extractList('PUBLIC_ANY')   // 任意方法放行

/** Ant 风格 pattern → 正则（`*` 不跨 `/`，`**` 跨） */
function antToRe(p) {
  const esc = p.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*')
  return new RegExp('^' + esc + '$')
}
const RE_ANY = PUBLIC_ANY.map(antToRe)
const RE_GET = PUBLIC_GET.map(antToRe)

function isPublic(method, path) {
  if (RE_ANY.some((r) => r.test(path))) return true
  if (method === 'GET' && RE_GET.some((r) => r.test(path))) return true
  return false
}

console.log('后端 PUBLIC_ANY :', PUBLIC_ANY.join(' '))
console.log('后端 PUBLIC_GET :', PUBLIC_GET.length, '条 ->', PUBLIC_GET.join(' '))

/* ============================================================
 * ② 前端路由：视图文件 → 该页是否游客可达
 * ============================================================
 * ★ 这一步取代了原先手写的 PUBLIC_VIEWS 清单 ★
 * 手写清单的风险是「路由改了、清单忘了改」—— 审计会静默放过新放开的页面。
 * 现在直接从 router/index.ts 推导，并保留手写清单做**交叉核对**（两边不一致就报错）。
 * 解析用**逐行状态机**：本文件里每条路由都是 path → component → meta 的固定顺序。
 */
const routerSrc = readFileSync(join(FE, 'src/router/index.ts'), 'utf8')
const viewMeta = new Map() // 'src/views/x.vue' -> {path, public, requireAuth}
{
  let cur = null
  for (const line of routerSrc.split(/\r?\n/)) {
    // 注释行跳过，避免注释里的 path 扰乱状态机
    const t = line.trim()
    if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) continue

    const pathM = line.match(/\bpath:\s*'([^']+)'/)
    if (pathM) cur = { path: pathM[1], public: false, requireAuth: false }
    const compM = line.match(/component:\s*\(\)\s*=>\s*import\('@\/([^']+)'\)/)
    if (compM && cur) {
      // `@/` 在 vite 里映射到 src/，这里补回来，保证与扫描用的相对路径同一口径
      const view = 'src/' + compM[1]
      cur.view = view
      viewMeta.set(view, cur)
    }
    if (cur && /\bpublic:\s*true/.test(line)) cur.public = true
    if (cur && /\brequireAuth:\s*true/.test(line)) cur.requireAuth = true
  }
}
if (viewMeta.size === 0) selfFail('未能从 router/index.ts 解析出任何视图文件')

/** 路由里标了 public 的页面 = 游客可达入口 */
const ROUTE_PUBLIC_VIEWS = [...viewMeta.entries()].filter(([, m]) => m.public).map(([v]) => v)

/** 交叉核对：手写清单与路由推导必须一致（防「路由改了清单没改」） */
const EXPECTED_PUBLIC_VIEWS = [
  'src/views/goods/List.vue',
  'src/views/goods/Detail.vue',
  'src/views/Notice.vue',
  'src/views/About.vue',
  'src/views/user/PublicProfile.vue'
]
{
  const a = new Set(ROUTE_PUBLIC_VIEWS)
  const missing = EXPECTED_PUBLIC_VIEWS.filter((v) => !a.has(v))
  if (missing.length) {
    console.log(`\n⚠️ 路由里标 public 的视图 = ${ROUTE_PUBLIC_VIEWS.length} 个`)
    selfFail(`手写清单里有、但路由没标 public 的视图：\n  ${missing.join('\n  ')}`)
  }
}

/** 公开页一定会挂在 BasicLayout 下，布局与它引用的子组件也在游客可达面上 */
const PUBLIC_VIEWS = [...ROUTE_PUBLIC_VIEWS, 'src/layouts/BasicLayout.vue']
console.log(`路由标 public 的视图 ${ROUTE_PUBLIC_VIEWS.length} 个 -> ${ROUTE_PUBLIC_VIEWS.join(' ')}`)

/* ============================================================
 * ③ 前端 API：导出函数 → (方法, 路径)
 * ============================================================ */
const apiDir = join(FE, 'src/api')
const apiFiles = readdirSync(apiDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))

const fnToEndpoints = new Map()
const fnDef = new Map()

for (const f of apiFiles) {
  const src = readFileSync(join(apiDir, f), 'utf8')
  const lines = src.split(/\r?\n/)

  lines.forEach((l, i) => {
    const m = l.match(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/)
    if (m) fnDef.set(`${f}#${m[1]}`, { file: f, name: m[1], start: i })
  })

  /*
   * 本项目的真实调用写法是**对象式**：request({ url: '/goods', method: 'GET', params })
   * 而不是 `request.get('/goods')`。url / method 顺序不固定、对象可能跨多行，
   * 所以逐行累积到 `})` 为止再解析。
   */
  for (let i = 0; i < lines.length; i++) {
    if (!/request\s*\(\s*\{/.test(lines[i])) continue
    let buf = ''
    for (let j = i; j < Math.min(lines.length, i + 12); j++) {
      buf += lines[j] + '\n'
      if (/\}\s*\)/.test(lines[j])) break
    }
    const urlM = buf.match(/url:\s*[`'"]([^`'"]+)[`'"]/)
    if (!urlM) continue
    const methodM = buf.match(/method:\s*[`'"]?([A-Za-z]+)[`'"]?/)
    const method = (methodM ? methodM[1] : 'GET').toUpperCase()
    const raw = urlM[1]
    const path = raw.replace(/\$\{[^}]*\}/g, '*')

    let owner = null
    for (const [, v] of fnDef) {
      if (v.file === f && v.start <= i && (!owner || v.start > owner.start)) owner = v
    }
    const name = owner ? owner.name : `(top-level@${f}:${i + 1})`
    if (!fnToEndpoints.has(name)) fnToEndpoints.set(name, [])
    fnToEndpoints.get(name).push({ method, path, raw, file: f, line: i + 1 })
  }
}
if (fnToEndpoints.size === 0) selfFail('未能从 src/api/*.ts 解析出任何接口函数')

const totalEndpoints = [...fnToEndpoints.values()].reduce((n, a) => n + a.length, 0)
if (totalEndpoints < 50) selfFail(`只解析出 ${totalEndpoints} 个端点，明显偏少 —— 解析器可能失效`)
console.log(`前端 API 文件 ${apiFiles.length} 个，接口函数 ${fnToEndpoints.size} 个，端点 ${totalEndpoints} 条`)

/* ============================================================
 * ④ 守卫判定：**同一个函数体内**是否出现过守卫
 * ============================================================ */
const GUARD_TOKENS = [
  /\bisLoggedIn\b/,          // 直接判断登录态
  /\brequireLogin\s*\(/,     // 本项目统一的游客守卫函数（Detail.vue）
  /\brequireAuth\b/,         // 路由 meta 风格的同义守卫
  /\brequireLogin\b/         // 只引用不调用的写法（如作为回调传递）
]

/** 从 callIdx 向上找到包住它的顶层函数定义，返回 {name, start} */
function enclosingFunction(lines, callIdx) {
  for (let i = callIdx; i >= 0; i--) {
    const m = lines[i].match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/)
    if (m) return { name: m[1], start: i }
    const m2 = lines[i].match(/^(?:const|let)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(/)
    if (m2) return { name: m2[1], start: i }
  }
  return null
}

let guardHitCount = 0

function isGuarded(lines, callIdx) {
  const fn = enclosingFunction(lines, callIdx)
  const from = fn ? fn.start : Math.max(0, callIdx - 40)
  const ctx = lines.slice(from, callIdx).join('\n')
  const hit = GUARD_TOKENS.some((r) => r.test(ctx))
  if (hit) guardHitCount++
  return { guarded: hit, fn }
}

/* ============================================================
 * ⑤ 扫描公开可达面（含递归子组件）
 * ============================================================ */
function collectApiImports(src) {
  const out = []
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'@\/api\/[a-z-]+'/g)) {
    for (const piece of m[1].split(',')) {
      const t = piece.trim().replace(/^type\s+/, '')
      const [orig, alias] = t.split(/\s+as\s+/).map((x) => x?.trim())
      if (orig) out.push({ orig, alias: alias || orig })
    }
  }
  return out
}

function collectLocalImports(src) {
  const out = []
  for (const m of src.matchAll(/import\s+\w+\s+from\s*'([^']+\.vue)'/g)) out.push({ path: m[1], name: null })
  for (const m of src.matchAll(/import\s+\{\s*([A-Za-z0-9_$]+)\s*\}\s*from\s*'([^']+\.vue)'/g)) {
    out.push({ path: m[2], name: m[1] })
  }
  return out
}

const findings = []
const scanned = new Set()
/** 子组件 → 引用它的文件清单 */
const importedBy = new Map()

function resolveImport(relPath, imp) {
  return imp.startsWith('@/')
    ? 'src/' + imp.slice(2)
    : join(relPath, '..', imp).replace(/\\/g, '/')
}

function scanFile(relPath, depth = 0) {
  if (scanned.has(relPath) || depth > 3) return
  const full = join(FE, relPath)
  if (!existsSync(full)) return
  scanned.add(relPath)
  const src = readFileSync(full, 'utf8')
  const lines = src.split(/\r?\n/)
  const imports = collectApiImports(src)

  for (const { orig, alias } of imports) {
    const eps = fnToEndpoints.get(orig)
    if (!eps) continue
    const risky = eps.filter((e) => !isPublic(e.method, e.path))
    if (risky.length === 0) continue

    const callRe = new RegExp(`\\b${alias}\\s*\\(`)
    lines.forEach((l, i) => {
      if (!callRe.test(l)) return
      const { guarded, fn } = isGuarded(lines, i)
      findings.push({
        relPath, depth, line: i + 1, fn: orig, alias,
        method: risky[0].method, path: risky[0].path,
        guarded, guardedIn: fn ? fn.name : '(顶层/无法定位)',
        snippet: l.trim().slice(0, 96)
      })
    })
  }

  for (const imp of collectLocalImports(src)) {
    if (!imp.path.startsWith('.') && !imp.path.startsWith('@/')) continue
    const resolved = resolveImport(relPath, imp.path)
    if (!importedBy.has(resolved)) importedBy.set(resolved, [])
    importedBy.get(resolved).push(relPath)
    scanFile(resolved, depth + 1)
  }
}
for (const v of PUBLIC_VIEWS) scanFile(v)

/* ---- 自证：守卫检测器必须真的认出守卫来 ---- */
{
  const detailFindings = findings.filter((f) => f.relPath === 'src/views/goods/Detail.vue')
  if (detailFindings.length === 0) {
    selfFail('未能在 Detail.vue 中命中任何调用点 —— 解析器坏了')
  }
  if (guardHitCount === 0) {
    selfFail('守卫检测器一次都没命中（连 Detail.vue 的 requireLogin 都没认出来）—— 判据失效')
  }
}

/* ============================================================
 * ⑥ 子组件的「调用方契约」
 * ============================================================
 * 通用组件（如 ChatWindow）自己不判断登录态，它假定调用方已经保证。
 * 这类文件里出现"无守卫"调用**不等于有风险**，风险取决于谁在用它。
 * 所以：
 *   · 声明了契约标记（guest-guard: caller-contract）的子组件 → 逐一对调用方求证；
 *   · 调用方若本身是 requireAuth 路由 → 天然安全；
 *   · 调用方若是游客可达页 → 必须存在一个「打开该组件的变量」，
 *     且它的每一次"置为真"都在有守卫的函数里。
 */
const CONTRACT_MARK = /guest-guard:\s*caller-contract/

/** 推断某个子组件在调用方页面里由**哪些**变量控制可见性
 *
 * ★ 这里踩过两个坑，都记下来 ★
 *  ① 原来只写 `<ChatWindow[\s>]`，而本项目的组件标签是**单独占一行**的
 *     （`<ChatWindow` 后面直接换行，属性在下一行）→ 匹配不上，推断直接失败。
 *     改成 `(?![\w-])` 这种「后面不是标识符字符」的写法，行尾也算。
 *  ② 原来只取**一个**变量（遇到 v-model 就 return）。
 *     实际控制可见性的往往不止一个：Detail.vue 里外层 el-drawer 用
 *     `v-model="chatVisible"`、组件自身还有 `v-if="chatSessionId && ..."`，
 *     两个都得查 —— 任一能在无守卫路径下被置为真，组件就会被挂载。
 *     所以现在收集**整段窗口内的全部**候选变量。
 */
function gateVariablesOf(importerRel, childRel) {
  const src = readFileSync(join(FE, importerRel), 'utf8')
  const lines = src.split(/\r?\n/)
  const base = childRel.split('/').pop().replace(/\.vue$/, '')
  const tagRe = new RegExp(`<${base}(?![\\w-])`)
  for (let i = 0; i < lines.length; i++) {
    if (!tagRe.test(lines[i])) continue
    const vars = new Map() // varName -> line
    // 窗口取到标签前后各 12 行：外层容器（v-model）在上、标签自身属性在下
    for (let j = Math.max(0, i - 12); j < Math.min(lines.length, i + 12); j++) {
      for (const m of lines[j].matchAll(/v-model="([A-Za-z0-9_$]+)"/g)) {
        if (!vars.has(m[1])) vars.set(m[1], j + 1)
      }
      for (const m of lines[j].matchAll(/v-if="([A-Za-z0-9_$]+)/g)) {
        if (!vars.has(m[1])) vars.set(m[1], j + 1)
      }
    }
    return { tagLine: i + 1, vars: [...vars.entries()].map(([name, line]) => ({ name, line })) }
  }
  return null
}

/** 该变量的每一次「置为非空值」的赋值，是否都在有守卫的函数里
 *
 * ★ 只挑「打开」方向 ★
 * 重置成假值（false / null / '' / 0 / undefined）属于关闭，不构成风险，跳过。
 * 其余一律当成打开：像 `chatSessionId.value = await openSession({...})` 这种
 * 「赋一个非字面量」的写法同样是打开，早先只认字面量 true 会漏掉它。
 */
function openingsAllGuarded(importerRel, varName) {
  const src = readFileSync(join(FE, importerRel), 'utf8')
  const lines = src.split(/\r?\n/)
  const re = new RegExp(`\\b${varName}\\s*\\.value\\s*=\\s*(.+)$`)
  const hits = []
  lines.forEach((l, i) => {
    const m = l.match(re)
    if (!m) return
    const rhs = m[1].trim()
    if (/^(?:false|null|undefined|0|''|""|\[\]|\{\});?$/.test(rhs)) return // 关闭方向
    const { guarded, fn } = isGuarded(lines, i)
    hits.push({ line: i + 1, guarded, inFn: fn ? fn.name : '?', text: l.trim().slice(0, 70) })
  })
  return hits
}

const contractIssues = []
const contractOk = []
for (const f of findings.filter((x) => x.depth > 0)) {
  const full = join(FE, f.relPath)
  const src = existsSync(full) ? readFileSync(full, 'utf8') : ''
  if (!CONTRACT_MARK.test(src)) {
    contractIssues.push({ ...f, reason: '子组件无调用方契约标记 —— 无人担保它被守卫着调用' })
    continue
  }
  const callers = (importedBy.get(f.relPath) || [])
  let safe = false
  const detail = []
  for (const c of callers) {
    const meta = viewMeta.get(c)
    if (meta?.requireAuth) { safe = true; detail.push(`${c}（requireAuth 路由）`); continue }
    const gate = gateVariablesOf(c, f.relPath)
    if (!gate || gate.vars.length === 0) {
      detail.push(`${c}（★ 找不到控制可见性的变量，无法求证）`)
      continue
    }
    const perVar = gate.vars.map((v) => ({ ...v, opens: openingsAllGuarded(c, v.name) }))
    const allOk = perVar.every((v) => v.opens.length > 0 && v.opens.every((o) => o.guarded))
    if (allOk) {
      safe = true
      detail.push(`${c}（开启变量 ${perVar.map((v) => `${v.name}@${v.opens.map((o) => o.line).join('/')}`).join(', ')} 全部有守卫）`)
    } else {
      const bad = perVar.filter((v) => v.opens.length === 0 || v.opens.some((o) => !o.guarded))
      detail.push(`${c}（★ 这些开启变量有无守卫路径：${bad.map((v) => `${v.name}@${v.opens.filter((o) => !o.guarded).map((o) => o.line).join(',') || '无置真处'}`).join('; ')}）`)
    }
  }
  if (safe) contractOk.push({ ...f, callers: detail })
  else contractIssues.push({ ...f, reason: `调用方未提供守卫 —— ${detail.join(' / ')}` })
}

/* ============================================================
 * ⑦ 报告
 * ============================================================ */
const pageFindings = findings.filter((f) => f.depth === 0)
const risky = pageFindings.filter((f) => !f.guarded)

console.log('\n================ 公开页面调用的「需登录接口」 ================')
if (pageFindings.length === 0) {
  console.log('（无）')
} else {
  const byFile = new Map()
  for (const f of pageFindings) {
    if (!byFile.has(f.relPath)) byFile.set(f.relPath, [])
    byFile.get(f.relPath).push(f)
  }
  for (const [file, list] of byFile) {
    console.log('\n' + file)
    for (const f of list) {
      const flag = f.guarded ? `  [守卫在 ${f.guardedIn}()]` : '★ [无守卫]'
      console.log(`  ${f.line}: ${f.fn}()  ->  ${f.method} ${f.path}${flag}`)
      console.log(`        ${f.snippet}`)
    }
  }
}

if (contractOk.length) {
  console.log('\n---------------- 子组件（已声明调用方契约，已求证） ----------------')
  const seen = new Set()
  for (const f of contractOk) {
    if (seen.has(f.relPath)) continue
    seen.add(f.relPath)
    console.log(`\n${f.relPath}  调用点 ${f.method} ${f.path}`)
    for (const d of f.callers) console.log('    ✓ ' + d)
  }
}

console.log(`\n扫描文件 ${scanned.size} 个；公开页调用点 ${pageFindings.length} 个（有守卫 ${pageFindings.length - risky.length}），`
  + `子组件契约点 ${contractOk.length + contractIssues.length} 个`)
console.log(`自证：解析路由 ${viewMeta.size} 条 / 接口函数 ${fnToEndpoints.size} 个 / 守卫命中 ${guardHitCount} 处`)

let bad = 0
if (risky.length) {
  bad += risky.length
  console.log('\n★ 以下点位在游客态会真的发出请求并收到 401（会被 request.ts 当成"登录已过期"）：')
  for (const f of risky) console.log(`  - ${f.relPath}:${f.line}  ${f.fn}() -> ${f.method} ${f.path}`)
}
if (contractIssues.length) {
  bad += contractIssues.length
  console.log('\n★ 以下子组件调用点无人担保会被守卫着触发：')
  for (const f of contractIssues) console.log(`  - ${f.relPath}:${f.line}  ${f.fn}() -> ${f.method} ${f.path}\n      ${f.reason}`)
}

if (bad === 0) {
  console.log('\n✅ 游客可达面干净：所有「需登录接口」的调用都在有守卫的函数体内，'
    + '或已由调用方契约担保。')
}
process.exit(bad === 0 ? 0 : 1)
