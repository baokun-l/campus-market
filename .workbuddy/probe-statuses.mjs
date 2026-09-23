/**
 * 单点探针：statuses / statuses[] 三种形态到底哪种能绑上。
 *
 * 背景：e2e-p1-8-orders.mjs 里「显式 statuses 白名单原样生效」一条 FAIL，
 * 报 total=undefined。需要判定这是**被测服务的缺陷**还是**测试脚本自身的坑**。
 *
 * 假设：node fetch 走 WHATWG URL 解析，query 里的 [ ] 不会被百分号编码，
 * 而 Tomcat 默认拒绝请求行中的原始 [ ]（relaxedQueryChars 未放开）
 * → 返回 400 且响应体不是 JSON → data 为 undefined。
 * 浏览器里 axios 会自动把 [ ] 编成 %5B %5D，所以真实前端不受影响。
 */
const BASE = 'http://127.0.0.1:8080/api'

async function raw(path, token) {
  const res = await fetch(BASE + path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON（如 Tomcat 的 400 HTML） */
  }
  return { http: res.status, json, text: text.slice(0, 200) }
}

async function login(username) {
  const res = await fetch(BASE + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: '123456' })
  })
  const j = await res.json()
  return j?.data?.token
}

const admin = await login('admin')
console.log('admin token:', admin ? 'OK' : 'MISSING')

const cases = [
  ['不带 statuses（基线）', '/goods?page=1&pageSize=100'],
  ['原始方括号 statuses[]', '/goods?page=1&pageSize=100&statuses[]=pending'],
  ['百分号编码 statuses%5B%5D', '/goods?page=1&pageSize=100&statuses%5B%5D=pending'],
  ['裸名 statuses（无括号）', '/goods?page=1&pageSize=100&statuses=pending'],
  ['CSV 形态 statuses=pending,off_shelf', '/goods?page=1&pageSize=100&statuses=pending,off_shelf']
]

for (const [label, path] of cases) {
  const r = await raw(path, admin)
  const list = r.json?.data?.list
  const statuses = list ? [...new Set(list.map((g) => g.status))].join(',') : null
  console.log(
    `\n${label}\n  http=${r.http} code=${r.json?.code} total=${r.json?.data?.total} ` +
      `n=${list?.length} statuses=${statuses}` +
      (r.json ? '' : `\n  body(非JSON)=${r.text.replace(/\s+/g, ' ')}`)
  )
}
