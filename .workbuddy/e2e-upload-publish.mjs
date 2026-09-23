/**
 * 端到端探针：图片上传 → 发布商品（本轮缺陷修复的验收）
 *
 * 守的是这条链路：
 *   1. 上传需要登录；匿名上传 401
 *   2. 上传合法图片 → 返回 /uploads/... 短路径
 *   3. 返回的路径**匿名可读**（否则 <img> 带不上 token，商品图全裂）
 *   4. 用返回的短路径发布商品 → 成功
 *   5. 旧写法（base64 data URL 直塞 cover）→ 返回 1001 友好拒绝，**绝不能是 500**
 *   6. 各种非法入参 → 均为 1001，且**全程不出现 500**
 *
 * 为什么要单独跑这一支：单元测试用的是 mock，覆盖不到
 * 「MultipartFile 能不能被 Spring 接住」「静态资源映射通不通」
 * 「列宽够不够」这三件只有真跑起来才知道的事 —— 而这次的原始缺陷
 * 恰恰就出在这三件事的交界处。
 *
 * 用法：node .workbuddy/e2e-upload-publish.mjs
 * 前置：后端已启动在 8080
 */
const BASE = 'http://localhost:8080/api'

let pass = 0, fail = 0
const lines = []
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; lines.push(`  [PASS] ${name}${extra ? ' :: ' + extra : ''}`) }
  else { fail++; lines.push(`  [FAIL] ${name}${extra ? ' :: ' + extra : ''}`) }
}
const section = (t) => lines.push(`\n### ${t}`)

async function call(method, path, { token, body } = {}) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers['Authorization'] = 'Bearer ' + token
  const res = await fetch(BASE + path, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, json, text }
}

/** 1x1 的真实 JPEG（最小合法图），用来确保「存下来的确实是张图」 */
const JPEG_1PX = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64'
)

async function upload(token, { bytes = JPEG_1PX, filename = 'probe.jpg', type = 'image/jpeg', field = 'file' } = {}) {
  const fd = new FormData()
  fd.append(field, new Blob([bytes], { type }), filename)
  const headers = {}
  if (token) headers['Authorization'] = 'Bearer ' + token
  const res = await fetch(BASE + '/upload/image', { method: 'POST', headers, body: fd })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, json, text }
}

// ------------------------------------------------------------------
section('0. 登录')
const login = await call('POST', '/user/login', { body: { username: 'zhangsan', password: '123456' } })
const token = login.json?.data?.token
ok('zhangsan 登录拿到 token', !!token, `code=${login.json?.code}`)
if (!token) {
  console.log(lines.join('\n'))
  console.log('\n登录失败，后续用例无法进行')
  process.exit(1)
}

const createdGoodsIds = []
const uploadedUrls = []

// ------------------------------------------------------------------
section('1. 上传鉴权')
{
  const r = await upload(null)
  ok('匿名上传被拒（401）', r.json?.code === 401, `code=${r.json?.code} http=${r.status}`)
}

// ------------------------------------------------------------------
section('2. 上传合法图片')
let firstUrl = null
{
  const r = await upload(token)
  ok('上传成功 code=0', r.json?.code === 0, `code=${r.json?.code} msg=${r.json?.message}`)
  const url = r.json?.data?.url
  ok('返回 /uploads/ 短路径', typeof url === 'string' && url.startsWith('/uploads/'), `url=${url}`)
  ok('路径长度 < 255（不撑 varchar(255)）', typeof url === 'string' && url.length < 255, `len=${url?.length}`)
  ok('返回 size 与上传字节一致', r.json?.data?.size === JPEG_1PX.length, `size=${r.json?.data?.size}`)
  ok('落盘文件名已重命名（不是原文件名）', r.json?.data?.name !== 'probe.jpg', `name=${r.json?.data?.name}`)
  if (url) { firstUrl = url; uploadedUrls.push(url) }
}

// ------------------------------------------------------------------
section('3. 静态资源匿名可读（<img> 带不上 token）')
{
  const res = await fetch(BASE + firstUrl)
  const ct = res.headers.get('content-type') || ''
  const buf = Buffer.from(await res.arrayBuffer())
  ok('匿名 GET 上传的图片 200', res.status === 200, `http=${res.status}`)
  ok('Content-Type 是图片', ct.startsWith('image/'), `content-type=${ct}`)
  ok('字节数与上传一致（没被截断）', buf.length === JPEG_1PX.length, `got=${buf.length} want=${JPEG_1PX.length}`)
  ok('确实是 JPEG（FFD8 开头）', buf[0] === 0xff && buf[1] === 0xd8, `head=${buf.slice(0, 2).toString('hex')}`)
}

// ------------------------------------------------------------------
section('4. 上传非法文件')
{
  const r1 = await upload(token, { bytes: Buffer.from('hello'), filename: 'a.txt', type: 'text/plain' })
  ok('非图片 MIME 被拒 1001', r1.json?.code === 1001, `code=${r1.json?.code}`)

  const r2 = await upload(token, { bytes: JPEG_1PX, filename: 'evil.txt', type: 'image/jpeg' })
  ok('扩展名不在白名单被拒 1001', r2.json?.code === 1001, `code=${r2.json?.code}`)

  const r3 = await upload(token, { bytes: Buffer.alloc(0), filename: 'empty.jpg', type: 'image/jpeg' })
  ok('空文件被拒 1001', r3.json?.code === 1001, `code=${r3.json?.code}`)

  // 路径穿越：沿用客户端文件名会写到 uploads 之外
  const r4 = await upload(token, { bytes: JPEG_1PX, filename: '../../evil.jpg', type: 'image/jpeg' })
  ok('路径穿越文件名不生效（落盘路径仍在本目录）',
    r4.json?.code === 0 && /^\/uploads\/\d{4}\/\d{2}\/[0-9a-f]{32}\.jpg$/.test(r4.json?.data?.url || ''),
    `url=${r4.json?.data?.url}`)
  if (r4.json?.data?.url) uploadedUrls.push(r4.json.data.url)
}

// ------------------------------------------------------------------
section('5. 用上传返回的短路径发布商品（正路）')
{
  const payload = {
    title: '探针·带图商品',
    price: 88.5,
    categoryId: 1,
    stock: 2,
    cover: firstUrl,
    images: [firstUrl],
    location: '三食堂门口',
    description: '端到端探针创建，跑完即删',
    deliveryMethod: 'face',
    // 故意伪造分类名：服务端必须无视它，按 categoryId 回填真实分类名
    categoryName: '伪造分类名'
  }
  const r = await call('POST', '/goods', { token, body: payload })
  ok('带图发布成功 code=0', r.json?.code === 0, `code=${r.json?.code} msg=${r.json?.message}`)
  const g = r.json?.data
  if (g?.id) createdGoodsIds.push(g.id)
  ok('cover 落库为短路径', g?.cover === firstUrl, `cover=${String(g?.cover).slice(0, 60)}`)
  ok('images 是数组且含短路径', Array.isArray(g?.images) && g.images[0] === firstUrl, `images=${JSON.stringify(g?.images)}`)
  ok('新商品进入 pending（审核流未受影响）', g?.status === 'pending', `status=${g?.status}`)
  ok('stock 原样保留（不被默认成 1）', g?.stock === 2, `stock=${g?.stock}`)

  /*
   * 分类名必须由服务端回填：客户端能自由写 categoryName，
   * 若原样落库，分类 1（教材）的商品可以伪装成任意分类。
   */
  ok('categoryName 由服务端回填（不是客户端伪造值）', g?.categoryName && g.categoryName !== '伪造分类名',
    `categoryName=${g?.categoryName}`)
}

// ------------------------------------------------------------------
section('6. 旧写法：base64 data URL 直塞 cover → 必须 1001 而非 500')
{
  // 造一个 20KB 的 data URL，足以触发原缺陷（cover varchar(255)）
  const bigDataUrl = 'data:image/jpeg;base64,' + 'A'.repeat(20000)
  const r = await call('POST', '/goods', {
    token,
    body: { title: '探针·base64直塞', price: 10, categoryId: 1, cover: bigDataUrl }
  })
  ok('base64 直塞 cover 被友好拒绝（1001）', r.json?.code === 1001, `code=${r.json?.code}`)
  ok('不是 500「服务器内部错误」', r.json?.code !== 500, `code=${r.json?.code}`)
  ok('错误信息点名了图片/上传', /图|上传/.test(r.json?.message || ''), `msg=${r.json?.message}`)
}

// ------------------------------------------------------------------
section('7. 参数校验：非法入参一律 1001，全程无 500')
const T = '探针'
const cases = [
  ['标题为空', { title: '', price: 10, categoryId: 1 }],
  ['标题为空白串', { title: '   ', price: 10, categoryId: 1 }],
  ['标题缺失', { price: 10, categoryId: 1 }],
  ['标题超 200 字', { title: 'x'.repeat(201), price: 10, categoryId: 1 }],
  ['价格缺失', { title: T, categoryId: 1 }],
  ['价格为 0', { title: T, price: 0, categoryId: 1 }],
  ['价格为负', { title: T, price: -5, categoryId: 1 }],
  ['价格超 decimal(10,2) 上限', { title: T, price: 100000000, categoryId: 1 }],
  ['数量超上限', { title: T, price: 10, categoryId: 1, stock: 100000 }],
  ['分类缺失', { title: T, price: 10 }],
  ['分类不存在', { title: T, price: 10, categoryId: 99999 }],
  ['交易地点超 200 字', { title: T, price: 10, categoryId: 1, location: 'y'.repeat(201) }],
  ['描述超 2000 字', { title: T, price: 10, categoryId: 1, description: 'z'.repeat(2001) }],
  ['交易方式不在白名单', { title: T, price: 10, categoryId: 1, deliveryMethod: 'teleport' }],
  ['图片超过 9 张', { title: T, price: 10, categoryId: 1, images: Array.from({ length: 10 }, () => '/uploads/x.jpg') }],
  ['单张图片路径超 255', { title: T, price: 10, categoryId: 1, images: ['/uploads/' + 'a'.repeat(300)] }]
]
let saw500 = 0
for (const [name, body] of cases) {
  const r = await call('POST', '/goods', { token, body })
  if (r.json?.code === 500) saw500++
  ok(`拒绝：${name}`, r.json?.code === 1001, `code=${r.json?.code} msg=${r.json?.message}`)
}
ok('16 类非法入参中 0 次 500', saw500 === 0, `500 次数=${saw500}`)

// ------------------------------------------------------------------
section('8. 默认值落地（stock / deliveryMethod 缺省）')
{
  const r = await call('POST', '/goods', {
    token, body: { title: '探针·默认值', price: 12, categoryId: 1 }
  })
  ok('缺省 stock 落为 1', r.json?.data?.stock === 1, `stock=${r.json?.data?.stock}`)
  ok('缺省 deliveryMethod 落为 face', r.json?.data?.deliveryMethod === 'face', `dm=${r.json?.data?.deliveryMethod}`)
  if (r.json?.data?.id) createdGoodsIds.push(r.json.data.id)
}

// ------------------------------------------------------------------
section('9. 清理本次探针产生的数据')
{
  let deleted = 0
  for (const id of createdGoodsIds) {
    const r = await call('DELETE', `/goods/${id}`, { token })
    if (r.json?.code === 0) deleted++
    else lines.push(`  [WARN] 删除商品 ${id} 失败 code=${r.json?.code} msg=${r.json?.message}`)
  }
  ok(`探针商品已全部删除（${deleted}/${createdGoodsIds.length}）`, deleted === createdGoodsIds.length,
    `ids=${createdGoodsIds.join(',')}`)
  lines.push(`  [INFO] 已上传的图片留在 uploads 下，需按精确路径清理：`)
  for (const u of uploadedUrls) lines.push(`         ${u}`)
}

// ------------------------------------------------------------------
console.log(lines.join('\n'))
console.log(`\n========== 上传/发布端到端：${pass} PASS / ${fail} FAIL ==========`)
process.exit(fail === 0 ? 0 : 1)
