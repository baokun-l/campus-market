/** 临时诊断：为什么下单返回 1001 */
const BASE = 'http://127.0.0.1:8080/api'
async function call(method, path, { token, body } = {}) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers['Authorization'] = 'Bearer ' + token
  const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* ignore */ }
  return { status: res.status, json, text }
}
const login = async (u, p) => (await call('POST', '/user/login', { body: { username: u, password: p } })).json?.data?.token

const admin = await login('admin', 'admin123')
const zs = await login('zhangsan', '123456')
const ls = await login('lisi', '123456')

const act = await call('POST', '/admin/activities', {
  token: admin,
  body: { title: '【诊断】活动', durationDays: 3, priority: 5, fundSource: 'platform', claims: [{ categoryId: 5, rate: 0.8 }] }
})
console.log('activity:', act.json?.data?.id)

const g = await call('POST', '/goods', {
  token: zs,
  body: { title: '【诊断】商品', price: 200, stock: 2, deliveryMethod: 'face', categoryId: 5, activityId: act.json?.data?.id }
})
console.log('publish:', g.status, JSON.stringify(g.json))
const gid = g.json?.data?.id

const st = await call('PATCH', `/goods/${gid}/status`, { token: admin, body: { status: 'on_sale' } })
console.log('patch status:', st.status, JSON.stringify(st.json))

const detail = await call('GET', `/goods/${gid}`, { token: admin })
console.log('detail:', JSON.stringify(detail.json?.data && {
  id: detail.json.data.id, status: detail.json.data.status, sellerId: detail.json.data.sellerId,
  stock: detail.json.data.stock, promoPrice: detail.json.data.promoPrice, activityId: detail.json.data.activityId
}))

const me = await call('GET', '/user/info', { token: ls })
console.log('lisi info:', JSON.stringify(me.json))

const order = await call('POST', '/orders', { token: ls, body: { goodsId: gid, quantity: 1, address: '诊断点' } })
console.log('order:', order.status, JSON.stringify(order.json))

// 清理
console.log('cleanup goods:', (await call('DELETE', `/goods/${gid}`, { token: admin })).json?.code)
console.log('cleanup act:', (await call('DELETE', `/admin/activities/${act.json?.data?.id}`, { token: admin })).json?.code)
