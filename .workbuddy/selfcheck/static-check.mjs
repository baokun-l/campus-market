/**
 * 静态自检（契约 / 接线 / 鉴权 / 信任权威 / 工程卫生 五个家族的静态可查项）
 *
 * 用法：node .workbuddy/selfcheck/static-check.mjs
 * 输出：stdout 报告 + D:/campus-sql/selfcheck-static.md
 *
 * ★ 本脚本自身踩过的 3 个坑（v1 误报了 4 项 FAIL，已修）★
 *  1) 从 `url:` 往后取 400 字符找 `method:` → 会把**下一个函数**的方法抓过来，
 *     凭空造出「DELETE /admin/audit-logs/stats」「PATCH /user/profile」两个不存在的端点。
 *     修法：括号配对取**整个调用体**，只在体内找 method。
 *  2) 前端 `url:`/`method:` 用三元表达式（`addr.id ? A : B`）→ 只取到第一个分支，
 *     于是把 `POST /user/addresses`、`PUT /user/addresses/{id}` 误判成孤儿接口。
 *     修法：取全部字面量，按分支顺序配对。
 *  3) Java/YAML 里的**注释**里写了「原来是 fundSource = "seller"」「已删除 logic-delete-field」
 *     这类说明文字 → 朴素 grep 会命中注释，把已修好的项报成未修。
 *     修法：匹配前先剥掉注释。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const WS = 'C:/Users/刘宝杰/Desktop/软件开发项目实践/软件开发/实践任务3：后端开发(前后端分离)'
const FE_T3 = path.join(WS, 'campus-secondhand-frontend')
const FE_T2 = 'C:/Users/刘宝杰/Desktop/软件开发项目实践/软件开发/实践任务2：Web前端开发(Vue3+Element Plus+ECharts)/campus-secondhand-frontend'
const BE = path.join(WS, 'campus-secondhand-backend')
const JAVA = path.join(BE, 'src/main/java/com/campus/market')
const RES = path.join(BE, 'src/main/resources')

const results = []
const add = (family, id, name, status, detail) => results.push({ family, id, name, status, detail })

function walk(dir, filter, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (['node_modules', 'dist', '.git', 'target', '.target-old-0917'].includes(e.name)) continue
      walk(p, filter, out)
    } else if (filter(e.name, p)) out.push(p)
  }
  return out
}
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '')
const rel = (p) => path.relative(WS, p).replace(/\\/g, '/')
const lineOf = (t, i) => t.slice(0, i).split('\n').length
const stripJava = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
const stripYml = (s) => s.split('\n').map((l) => {
  const i = l.indexOf('#')
  return i >= 0 ? l.slice(0, i) : l
}).join('\n')
const stripTs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1')

// ==================== 提取后端端点 ====================
const controllers = walk(path.join(JAVA, 'controller'), (n) => n.endsWith('.java'))
const backendEndpoints = []
for (const f of controllers) {
  const src = read(f)
  const classPrefixM = src.match(/@RequestMapping\(\s*"([^"]*)"\s*\)/)
  const classPrefix = classPrefixM ? classPrefixM[1] : ''
  const re = /@(Get|Post|Put|Patch|Delete)Mapping\s*\(([^)]*)\)/g
  let m
  while ((m = re.exec(src)) !== null) {
    const method = m[1].toUpperCase()
    for (const x of m[2].matchAll(/"([^"]*)"/g)) {
      backendEndpoints.push({ method, path: (classPrefix + x[1]).replace(/\/+$/, '') || '/', file: rel(f), line: lineOf(src, m.index) })
    }
  }
}

// ==================== 提取前端调用（括号配对 + 三元配对） ====================
function extractCalls(src, file) {
  const out = []
  const re = /request\s*(?:<[^>()]*>)?\s*\(/g
  let m
  while ((m = re.exec(src)) !== null) {
    const start = m.index + m[0].length
    let depth = 1, i = start, quote = null
    while (i < src.length && depth > 0) {
      const ch = src[i]
      if (quote) { if (ch === quote && src[i - 1] !== '\\') quote = null }
      else if (ch === "'" || ch === '"' || ch === '`') quote = ch
      else if (ch === '(') depth++
      else if (ch === ')') depth--
      i++
    }
    const body = src.slice(start, i - 1)
    // ★ url / method 都可能写成三元表达式（`url: a ? X : Y, method: a ? 'PUT' : 'POST'`），
    //   所以先按属性切段（切到**下一个属性名**，必须容忍换行与任意缩进 ——
    //   早期写成 ', method' 带空格就切不掉，会把 'POST' 当成第二个 URL），
    //   再把段内所有字符串字面量都收进来，最后按顺序与 method 配对。
    const NEXT_PROP = /(,|\n)\s*[A-Za-z_$][\w$]*\s*:/
    const segOf = (idx, len) => {
      let seg = body.slice(idx + len)
      const hit = seg.match(NEXT_PROP)
      if (hit) seg = seg.slice(0, hit.index)
      return seg
    }
    const urls = []
    for (const um of body.matchAll(/url:\s*/g)) {
      for (const lit of segOf(um.index, um[0].length).matchAll(/(['"`])([\s\S]*?)\1/g)) {
        if (lit[2].startsWith('/')) urls.push(lit[2])   // 兜底：端点必以 / 开头，滤掉误抓
      }
    }
    if (!urls.length) continue
    const methods = []
    for (const mm of body.matchAll(/method:\s*/g)) {
      for (const lit of segOf(mm.index, mm[0].length).matchAll(/['"](\w+)['"]/g)) methods.push(lit[1].toUpperCase())
    }
    urls.forEach((u, idx) => {
      let method = 'GET'
      if (methods.length === urls.length) method = methods[idx]
      else if (methods.length === 1) method = methods[0]
      else if (methods.length > 1) method = methods[Math.min(idx, methods.length - 1)]
      const norm = u.replace(/\$\{[^}]*\}/g, '{p}').replace(/\?.*$/, '').replace(/^\/api/, '').replace(/\/+$/, '') || '/'
      out.push({ method, path: norm, raw: u, file, line: lineOf(src, m.index) })
    })
  }
  return out
}
const apiFiles = walk(path.join(FE_T3, 'src/api'), (n) => n.endsWith('.ts') && !n.endsWith('.spec.ts'))
const frontCalls = apiFiles.flatMap((f) => extractCalls(read(f), rel(f)))

const pathMatches = (a, b) => a.replace(/\{[^}]*\}/g, '{p}').replace(/\/+$/, '') === b.replace(/\{[^}]*\}/g, '{p}').replace(/\/+$/, '')
const hasBackend = (method, p) => backendEndpoints.some((e) => pathMatches(e.path, p) && (e.method === method || method === 'UNKNOWN'))
const hasFront = (method, p) => frontCalls.some((c) => pathMatches(p, c.path) && (c.method === method || c.method === 'UNKNOWN'))

/**
 * 有意保留（非缺陷）：后端已实现、前端当前无调用方，但属于独立能力，**经确认决定保留**。
 *
 * ★ 为什么要有这张表：C2 判 WARN 的用意是「提醒有人确认一次」，不是「必须删掉」。
 *   若不加登记，这一项会每次自检都告警，久而久之就没人再看了（告警疲劳）——
 *   反而把真正的新孤儿淹没。登记后 C2 仍会把它们列出来，只是归到「已确认」一栏。
 *
 * 登记即代表：已确认它**不是**漏删、也不是断链，而是有意留下的 API。
 * 新增条目请附一行理由。
 */
const INTENTIONAL_ORPHANS = [
  'GET /orders/{id}/logs', // 订单轨迹单查；前端目前读订单实体上内嵌的 logs，此端点留给管理端/移动端等按需单查
]

// ==================== 家族 1：契约 ====================
{
  const ghost = frontCalls.filter((c) => !hasBackend(c.method, c.path))
  add('契约', 'C1', '幽灵端点（前端在调、后端没有）', ghost.length ? 'FAIL' : 'PASS',
    ghost.length ? ghost.map((g) => `${g.method} ${g.path} @ ${g.file}:${g.line}`).join(' | ')
      : `前端 ${frontCalls.length} 处调用全部命中后端实现（后端共 ${backendEndpoints.length} 个端点）`)

  const alias = []
  const kept = []
  const unused = backendEndpoints.filter((e) => {
    if (hasFront(e.method, e.path)) return false
    // 有意保留：已登记确认，不计入 WARN（见 INTENTIONAL_ORPHANS）
    if (INTENTIONAL_ORPHANS.includes(`${e.method} ${e.path}`)) { kept.push(e); return false }
    // 别名路由：/x/{id}/detail 与 /x/{id} 同 handler，前端调后者即可
    const base = e.path.replace(/\/detail$/, '')
    if (base !== e.path && hasFront(e.method, base)) { alias.push(e); return false }
    return true
  })
  add('契约', 'C2', '孤儿接口（后端有、前端零引用）', unused.length ? 'WARN' : 'PASS',
    (unused.length ? `${unused.length} 条：` + unused.map((e) => `${e.method} ${e.path} @ ${e.file}:${e.line}`).join(' | ') : '无') +
    (alias.length ? `　｜别名路由（非缺陷，共 ${alias.length} 条）：${alias.map((e) => e.path).join(', ')}` : '') +
    (kept.length ? `　｜有意保留（已确认非缺陷，共 ${kept.length} 条）：${kept.map((e) => `${e.method} ${e.path}`).join(', ')}` : ''))
}

// ==================== 家族 2：接线 ====================
{
  const appStore = stripTs(read(path.join(FE_T3, 'src/stores/modules/app.ts')))
  const ifaceM = appStore.match(/interface Settings \{([\s\S]*?)\n\}/)
  const keys = ifaceM ? [...ifaceM[1].matchAll(/^\s{2}(\w+)\s*:/gm)].map((x) => x[1]) : []
  const settingsPageDir = path.join(FE_T3, 'src/views/settings')
  const srcFiles = walk(path.join(FE_T3, 'src'), (n) => /\.(ts|vue)$/.test(n))
  const orphans = [], wired = []
  for (const k of keys) {
    const consumers = srcFiles
      .filter((f) => !f.includes('stores/modules/app.ts'))
      .filter((f) => new RegExp(`settings\\.${k}\\b|settings\\[['"]${k}['"]\\]`).test(read(f)))
    const outside = consumers.filter((c) => !c.startsWith(settingsPageDir))
    if (outside.length === 0) orphans.push(`${k}（${consumers.length ? '仅设置页自身引用' : '无任何引用'}）`)
    else wired.push(`${k}→${outside.map((c) => path.basename(c)).join(',')}`)
  }
  add('接线', 'B1', '孤儿设置（有 UI 无消费点）', orphans.length ? 'WARN' : 'PASS',
    `偏好键 ${keys.length} 个，孤儿 ${orphans.length} 个${orphans.length ? '：' + orphans.join(' | ') : ''}`)
  add('接线', 'B2', '偏好键消费点明细（防「半接线」）', 'PASS', wired.join(' ｜ '))
}

// ==================== 家族 3：鉴权 ====================
{
  const itc = stripJava(read(path.join(JAVA, 'interceptor/AuthInterceptor.java')))
  const hasMethodPath = /PUBLIC_GET|PUBLIC_ANY/.test(itc)
  const usesExclude = /excludePathPatterns/.test(itc)
  add('鉴权', 'A1', '白名单已下沉（按方法+路径；未回退 excludePathPatterns）', hasMethodPath && !usesExclude ? 'PASS' : 'FAIL',
    `方法+路径判定=${hasMethodPath}，代码中仍用 excludePathPatterns=${usesExclude}`)
  const itcRaw = read(path.join(JAVA, 'interceptor/AuthInterceptor.java'))
  add('鉴权', 'A2', '三角色路由规则齐备', /\/admin\/\*\*/.test(itcRaw) && /\/review\/goods/.test(itcRaw) && /\/admin\/reports/.test(itcRaw) ? 'PASS' : 'FAIL',
    `/admin/**=${/\/admin\/\*\*/.test(itcRaw)}，/review/goods/**=${/\/review\/goods/.test(itcRaw)}，/admin/reports/**=${/\/admin\/reports/.test(itcRaw)}`)
  const gs = read(path.join(JAVA, 'service/GoodsService.java'))
  add('鉴权', 'A3', '存在性泄露防护（越界可见性 404 而非 403）', /DETAIL_PRIVILEGED_ROLES/.test(gs) && /notFound\(/.test(gs) ? 'PASS' : 'WARN',
    `后台角色白名单+DETAIL 特权=${/DETAIL_PRIVILEGED_ROLES/.test(gs)}，notFound 分支=${/notFound\(/.test(gs)}`)
  const om = read(path.join(RES, 'mapper/OrderMapper.xml'))
  add('鉴权', 'A4', 'IDOR 约束进 SQL（订单列表不传 role 时收敛为买卖双方）', /<choose>/.test(om) ? 'PASS' : 'WARN', `<choose> 分支=${/<choose>/.test(om)}`)
  const mm = read(path.join(RES, 'mapper/MessageMapper.xml'))
  add('鉴权', 'A5', '会话消息越权约束（按参与者过滤）', /from_user_id/.test(mm) && /to_user_id/.test(mm) ? 'PASS' : 'WARN',
    `from_user_id/to_user_id 过滤=${/from_user_id/.test(mm) && /to_user_id/.test(mm)}`)
}

// ==================== 家族 4：信任与权威 ====================
{
  const gs = read(path.join(JAVA, 'service/GoodsService.java'))
  add('信任权威', 'D1', '客户端 promoPrice 被丢弃（让利价服务端算）', /setPromoPrice\(null\)/.test(gs) ? 'PASS' : 'FAIL',
    `applyPromoPricing 先清空客户端声明=${/setPromoPrice\(null\)/.test(gs)}`)
  const os = stripJava(read(path.join(JAVA, 'service/OrderService.java')))
  add('信任权威', 'D2', 'fundSource 不再硬编码 seller', /fundSourceFor\(/.test(os) && !/fundSource\s*=\s*"seller"/.test(os) ? 'PASS' : 'FAIL',
    `走 ActivityService.fundSourceFor=${/fundSourceFor\(/.test(os)}，代码中残留硬编码=${/fundSource\s*=\s*"seller"/.test(os)}`)
  const as = read(path.join(JAVA, 'service/ActivityService.java'))
  add('信任权威', 'D3', '活动状态由服务端时钟判定', /System\.currentTimeMillis\(\)/.test(as) && /stateOf\(/.test(as) ? 'PASS' : 'FAIL',
    `服务端时钟 + stateOf=${/System\.currentTimeMillis\(\)/.test(as) && /stateOf\(/.test(as)}`)
  add('信任权威', 'D4', '让利声明 categoryId 与 Goods.categoryId 同为 Long（防静默失效）',
    /private\s+Long\s+categoryId/.test(read(path.join(JAVA, 'dto/ActivityDiscountClaim.java'))) ? 'PASS' : 'FAIL',
    `ActivityDiscountClaim.categoryId: Long=${/private\s+Long\s+categoryId/.test(read(path.join(JAVA, 'dto/ActivityDiscountClaim.java')))}`)
  const ana = read(path.join(JAVA, 'service/AnalyticsService.java'))
  add('信任权威', 'D5', '看板 activeActivities 不再硬编码 0', /countActive\(\)/.test(ana) && !/"activeActivities",\s*0/.test(ana) ? 'PASS' : 'FAIL',
    `countActive=${/countActive\(\)/.test(ana)}，残留硬编码=${/"activeActivities",\s*0/.test(ana)}`)
  const gw = stripJava(read(path.join(JAVA, 'service/GoodsService.java')))
  const clamp = /BUYER_VISIBLE_STATUS/.test(gw) && /\.filter\(/.test(gw)
  add('信任权威', 'D6', '越界筛选静默收敛（不撑开可见范围）', clamp ? 'PASS' : 'WARN',
    `BUYER_VISIBLE_STATUS 白名单 + 静默收敛=${clamp}`)
}

// ==================== 家族 5：工程卫生 ====================
{
  const ymlRaw = read(path.join(RES, 'application.yml'))
  const yml = stripYml(ymlRaw)
  add('工程卫生', 'E1', '死配置 logic-delete-field 已从生效配置移除', /logic-delete-field/.test(yml) ? 'FAIL' : 'PASS',
    /logic-delete-field/.test(yml) ? '生效配置里仍存在' : '生效配置中无（仅注释里留有说明）')
  const nonNull = /default-property-inclusion:\s*non_null/.test(yml)
  const noTs = /write-dates-as-timestamps:\s*false/.test(yml)
  add('工程卫生', 'E2', 'Jackson 契约（null 省略 + 日期非时间戳）', nonNull && noTs ? 'PASS' : 'FAIL',
    `non_null=${nonNull}，write-dates-as-timestamps=false=${noTs}`)
  const ge = read(path.join(JAVA, 'common/GlobalExceptionHandler.java'))
  add('工程卫生', 'E3', '500 只由兜底分支产出', /Exception\.class/.test(ge) ? 'PASS' : 'WARN', `全局兜底分支=${/Exception\.class/.test(ge)}`)
  add('工程卫生', 'E4', '业务异常单参默认错误码 1001（非 500）', /PARAM_ERROR|1001/.test(read(path.join(JAVA, 'common/BusinessException.java'))) ? 'PASS' : 'FAIL',
    `默认 1001=${/PARAM_ERROR|1001/.test(read(path.join(JAVA, 'common/BusinessException.java')))}`)
  const jwt = read(path.join(JAVA, 'config/JwtConfig.java'))
  add('工程卫生', 'E5', 'JWT：显式 UTF-8 + 兜底密钥启动告警 + 支持环境变量覆盖',
    /StandardCharsets\.UTF_8/.test(jwt) && /PostConstruct/.test(jwt) ? 'PASS' : 'WARN',
    `UTF-8=${/StandardCharsets\.UTF_8/.test(jwt)}，启动告警=${/PostConstruct/.test(jwt)}`)
  add('工程卫生', 'E6', '数据库口令支持环境变量覆盖（不写死明文）', /\$\{DB_PASSWORD/.test(yml) ? 'PASS' : 'WARN',
    `使用 \${DB_PASSWORD:...} 形式=${/\$\{DB_PASSWORD/.test(yml)}`)
  add('工程卫生', 'E7', '幂等自愈（活动表空时惰性补种）', /seedIfEmpty\(\)/.test(read(path.join(JAVA, 'service/ActivityService.java'))) ? 'PASS' : 'WARN',
    `seedIfEmpty=${/seedIfEmpty\(\)/.test(read(path.join(JAVA, 'service/ActivityService.java')))}`)
  const cfg = read(path.join(JAVA, 'config/MybatisPlusConfig.java'))
  const params = read(path.join(JAVA, 'common/Params.java'))
  const negGuard = /page\s*<\s*1|pageSize\s*<\s*1|MAX_PAGE_SIZE/.test(params + cfg)
  add('工程卫生', 'E9', '分页入参负数/零值校验', negGuard ? 'PASS' : 'WARN',
    negGuard ? '存在边界收敛' : '仅设了 setMaxLimit，未见 page/pageSize 下限校验（已知技术债）')
  add('工程卫生', 'E10', '接口文档自动化（Swagger/OpenAPI）', /springdoc/.test(read(path.join(BE, 'pom.xml'))) ? 'PASS' : 'WARN',
    /springdoc/.test(read(path.join(BE, 'pom.xml'))) ? '已引入' : '未引入，接口清单靠 docs 手工维护（已知技术债）')

  // 双副本漂移
  const srcT2 = path.join(FE_T2, 'src')
  if (!fs.existsSync(srcT2)) {
    add('工程卫生', 'E8', '双副本漂移（T2 正本 vs T3 副本）', 'SKIP', `T2 路径不存在：${srcT2}`)
  } else {
    const hash = (root) => {
      const map = new Map()
      for (const f of walk(root, () => true)) map.set(path.relative(root, f).replace(/\\/g, '/'), crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex'))
      return map
    }
    const a = hash(srcT2), b = hash(path.join(FE_T3, 'src'))
    const onlyT2 = [...a.keys()].filter((k) => !b.has(k))
    const onlyT3 = [...b.keys()].filter((k) => !a.has(k))
    const diff = [...a.keys()].filter((k) => b.has(k) && a.get(k) !== b.get(k))
    const total = onlyT2.length + onlyT3.length + diff.length
    add('工程卫生', 'E8', '双副本漂移（T2 正本 vs T3 副本）', total === 0 ? 'PASS' : 'WARN',
      total === 0 ? `两端 src 全一致（T3 ${b.size} 个文件，MD5 mismatch=0）`
        : `不一致 ${total} 个 → 仅T2有 ${onlyT2.length}，仅T3有 ${onlyT3.length}，内容不同 ${diff.length}：${diff.slice(0, 8).join(', ')}`)
  }
}

// ==================== 死代码 / 过度导出（utils 导出项） ====================
{
  const utilFiles = walk(path.join(FE_T3, 'src/utils'), (n) => n.endsWith('.ts'))
  const allSrc = walk(path.join(FE_T3, 'src'), (n) => /\.(ts|vue)$/.test(n))
  const dead = [], overExported = []
  for (const f of utilFiles) {
    const src = stripTs(read(f))
    for (const x of src.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(\w+)/g)) {
      const n = x[1]
      const re = new RegExp(`\\b${n}\\b`, 'g')
      const insideCount = (src.match(re) || []).length
      const outside = allSrc.some((g) => g !== f && re.test(read(g)))
      if (outside) continue
      // 只剩声明本身（insideCount === 1）才算真死代码；否则是「仅本文件使用」= 过度导出
      if (insideCount <= 1) dead.push(`${n} @ ${path.basename(f)}`)
      else overExported.push(`${n} @ ${path.basename(f)}`)
    }
  }
  add('接线', 'B3', '死代码（零引用的导出）', dead.length ? 'WARN' : 'PASS',
    dead.length ? `${dead.length} 个：${dead.slice(0, 6).join(' | ')}` : '无')
  add('接线', 'B4', '过度导出（仅定义文件内部使用，可收窄 export）', overExported.length ? 'WARN' : 'PASS',
    overExported.length ? `${overExported.length} 个：${overExported.slice(0, 6).join(' | ')}` : '无')
}

// ==================== 输出 ====================
const order = ['契约', '接线', '鉴权', '信任权威', '工程卫生']
let md = `# 静态自检报告\n\n生成时间：${new Date().toLocaleString('zh-CN')}\n\n`
let pass = 0, warn = 0, fail = 0, skip = 0
for (const fam of order) {
  const rows = results.filter((r) => r.family === fam)
  if (!rows.length) continue
  md += `\n## ${fam}\n\n| 项 | 自检项 | 结果 | 证据 |\n|---|---|---|---|\n`
  for (const r of rows) {
    md += `| ${r.id} | ${r.name} | **${r.status}** | ${r.detail.replace(/\|/g, '\\|')} |\n`
    if (r.status === 'PASS') pass++; else if (r.status === 'WARN') warn++; else if (r.status === 'FAIL') fail++; else skip++
  }
}
md += `\n## 汇总\n\n- PASS ${pass} / WARN ${warn} / FAIL ${fail} / SKIP ${skip}（共 ${results.length} 项）\n`
md += `- 扫描范围：后端 ${controllers.length} 个 Controller → ${backendEndpoints.length} 个端点；前端 ${apiFiles.length} 个 api 文件 → ${frontCalls.length} 处调用\n`
fs.writeFileSync('D:/campus-sql/selfcheck-static.md', md, 'utf8')
console.log(md)
console.log(`STATIC_RESULT pass=${pass} warn=${warn} fail=${fail} skip=${skip}`)
