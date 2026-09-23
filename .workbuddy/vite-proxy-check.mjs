/**
 * 校验前端 dev 代理：`/uploads/**` 能否把请求送到后端的 `/api/uploads/**`
 *
 * ★ 为什么必须实测而不是「看一眼配置觉得对」★
 *
 * 后端 context-path 是 `/api`，而数据库里存的是**不含** context-path 的
 * `/uploads/2026/09/xxx.jpg`。这两个事实叠在一起，意味着前端必须有一条
 * `/uploads → 后端 /api/uploads` 的转发规则，否则 `<img src="/uploads/...">`
 * 会打到 Vite 开发服务器自己身上 —— 返回 404 或 index.html，商品图整片裂开。
 * 而这类问题 **`vue-tsc` 和 `vitest` 都发现不了**：它们不碰代理层。
 *
 * 做法：用 vite 的 loadConfigFromFile 加载**真实的 vite.config.ts**，
 * 断言 proxy 规则与 rewrite 结果，然后真的起一个 dev server 发请求。
 * 只把 `open` 关掉（免得弹浏览器），其余配置一律用真实的。
 *
 * 用法：node .workbuddy/vite-proxy-check.mjs
 * 前置：后端已启动在 8080
 */
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const FE = resolve(HERE, '..', 'campus-secondhand-frontend')
const PORT = 5199
const UPLOAD_REL = process.argv[2] || '/uploads/2026/09/9521558ea4e8454685717d5830986984.jpg'

/*
 * ★ 为什么要按绝对路径加载 vite，而不是直接 `import 'vite'` ★
 *
 * 本脚本放在 .workbuddy/ 下（不属于前端工程），而 ESM 的裸包名解析
 * 是**按脚本自身所在目录**向上找 node_modules 的 —— 这里找不到，会直接
 * ERR_MODULE_NOT_FOUND。改成从前端工程的 node_modules 里按绝对路径 import，
 * 既复用了前端已装好的那份 vite，也不会被 cwd 影响。
 */
const { loadConfigFromFile, createServer } = await import(
  pathToFileURL(resolve(FE, 'node_modules/vite/dist/node/index.js')).href
)

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  [PASS] ${name}${extra ? ' :: ' + extra : ''}`) }
  else { fail++; console.log(`  [FAIL] ${name}${extra ? ' :: ' + extra : ''}`) }
}

console.log('### 1. 解析真实 vite.config.ts')
const loaded = await loadConfigFromFile(
  { command: 'serve', mode: 'development' },
  resolve(FE, 'vite.config.ts'),
  FE
)
ok('配置加载成功', !!loaded?.config, loaded?.path || '')

const cfg = loaded.config
const proxy = cfg.server?.proxy || {}
ok("存在 '/api' 代理规则", !!proxy['/api'], `keys=${Object.keys(proxy).join(',')}`)
ok("存在 '/uploads' 代理规则（本轮新增）", !!proxy['/uploads'], `keys=${Object.keys(proxy).join(',')}`)
ok("'/uploads' 指向后端 8080", String(proxy['/uploads']?.target).includes('8080'),
  `target=${proxy['/uploads']?.target}`)

/*
 * rewrite 是这条规则的关键：不能把 /uploads 原样转发（后端要的是 /api/uploads）。
 * 后端真实路径 = context-path(/api) + 资源映射(/uploads/**)。
 */
const rewritten = proxy['/uploads']?.rewrite?.(UPLOAD_REL)
ok('rewrite 给 /uploads 补上 /api 前缀', rewritten === '/api' + UPLOAD_REL, `rewrite(${UPLOAD_REL}) = ${rewritten}`)

console.log('\n### 2. 起真实 dev server 发请求')
const server = await createServer({
  ...cfg,
  configFile: false,
  root: FE,
  // 只覆盖这三项：端口固定、别弹浏览器、别因为端口占用而换端口
  server: { ...cfg.server, port: PORT, strictPort: true, open: false }
})
await server.listen()

try {
  const imgRes = await fetch(`http://127.0.0.1:${PORT}${UPLOAD_REL}`)
  const ct = imgRes.headers.get('content-type') || ''
  const buf = Buffer.from(await imgRes.arrayBuffer())
  ok('经 Vite 代理取图片 200', imgRes.status === 200, `http=${imgRes.status} ct=${ct}`)
  ok('返回的是图片而不是 index.html', ct.startsWith('image/'), `ct=${ct} bytes=${buf.length}`)
  ok('图片字节非空且是 JPEG', buf.length > 0 && buf[0] === 0xff && buf[1] === 0xd8,
    `bytes=${buf.length} head=${buf.slice(0, 2).toString('hex')}`)

  // 顺带确认 /api 代理没被新规则影响
  const apiRes = await fetch(`http://127.0.0.1:${PORT}/api/goods?page=1&pageSize=1`)
  const apiJson = await apiRes.json().catch(() => null)
  ok('/api 代理仍然正常（未被新规则干扰）', apiJson?.code === 0,
    `http=${apiRes.status} code=${apiJson?.code}`)
} finally {
  await server.close()
}

console.log(`\n========== Vite 代理校验：${pass} PASS / ${fail} FAIL ==========`)
process.exit(fail === 0 ? 0 : 1)
