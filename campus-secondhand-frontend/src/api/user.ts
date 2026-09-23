/**
 * 用户相关 API
 */
import { request } from './request'
import { mockHelpers, mockUsersExport, makeSessionId } from './mock'
import { bannedMessage, assertSessionActive } from './session'
import { validateCnPhone } from '@/utils/validators'
import type { PageResult, User, Goods, Favorite, HistoryItem, Address, Message } from '@/types'

const USE_MOCK = import.meta.env.VITE_USE_MOCK === 'true'

/** 登录 */
export async function login(payload: { username: string; password: string }): Promise<{ token: string; user: User }> {
  if (USE_MOCK) {
    await mockHelpers.delay(400)
    // ① 管理员
    if (payload.username === 'admin' && payload.password === 'admin123') {
      const user = mockUsersExport.find((u) => u.role === 'admin')!
      return { token: 'mock-token-admin', user }
    }
    // ① b 商品审核员（专属后台：/review/goods）
    if (payload.username === 'goods_admin') {
      const user = mockUsersExport.find((u) => u.role === 'goods_admin')!
      if (payload.password !== 'goods123456') throw new Error('商品审核员密码错误（演示密码：goods123456）')
      return { token: 'mock-token-user-97', user }
    }
    // ① c 举报审核员（专属后台：/review/report）
    if (payload.username === 'report_admin') {
      const user = mockUsersExport.find((u) => u.role === 'report_admin')!
      if (payload.password !== 'report123456') throw new Error('举报审核员密码错误（演示密码：report123456）')
      return { token: 'mock-token-user-98', user }
    }
    // ② 已存在的演示账号（可用 book_li / digital_wang 等登录，验证「对方视角」）
    const found = mockUsersExport.find((u) => u.username === payload.username)
    if (found) {
      if (payload.password.length < 6) throw new Error('密码至少 6 位')
      // 管理员类账号必须使用约定的演示密码，否则「任意 6 位密码即可提权」（文案按角色区分，老断言不破）
      const ADMIN_PW: Partial<Record<User['role'], [string, string]>> = {
        admin: ['管理员', 'admin123'],
        goods_admin: ['商品审核员', 'goods123456'],
        report_admin: ['举报审核员', 'report123456']
      }
      const adminMeta = ADMIN_PW[found.role]
      if (adminMeta && payload.password !== adminMeta[1]) {
        throw new Error(`${adminMeta[0]}密码错误（演示密码：${adminMeta[1]}）`)
      }
      /*
       * ★ 状态闸门：封禁账号不允许登录。
       * 这里是**第一道**也是最重要的一道 —— 之前没有它，
       * 后台点了「封禁」之后，该账号照样能用原密码登进来，封禁等于没做。
       * 用户只剩 active / banned 两态（D11 拆除，2026-09-23），
       * 封禁即挡、其余放行，不存在「登录了但不能发布」的第三态。
       */
      if (found.status === 'banned') throw new Error(bannedMessage(found))
      return { token: `mock-token-user-${found.id}`, user: found }
    }
    // ③ 任意其它用户名 → 视为新用户，落到默认账号（计算机小张）
    if (payload.password.length < 6) throw new Error('密码至少 6 位')
    return { token: `mock-token-user-${mockUsersExport[0].id}`, user: mockUsersExport[0] }
  }
  return request({ url: '/user/login', method: 'POST', data: payload, showLoading: false })
}

/** 注册 */
export async function register(payload: {
  username: string
  password: string
  nickname: string
}): Promise<{ token: string; user: User }> {
  if (USE_MOCK) {
    await mockHelpers.delay(450)
    if (mockUsersExport.some((u) => u.username === payload.username)) {
      throw new Error('该用户名已被占用，换一个试试')
    }
    const user: User = {
      id: 100 + Math.floor(Math.random() * 9000),
      username: payload.username,
      nickname: payload.nickname,
      avatar: `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(payload.username)}`,
      creditScore: 100,
      status: 'active',
      role: 'user',
      createTime: new Date().toISOString()
    }
    mockUsersExport.push(user)
    return { token: `mock-token-register-${user.id}`, user }
  }
  return request({ url: '/user/register', method: 'POST', data: payload, showLoading: false })
}

/**
 * 退出登录 —— 让**服务端**把会话票据清掉（D9）。
 *
 * ★ 为什么前端必须多调这一个接口 ★
 * 凭据现在放在 HttpOnly Cookie 里：JS 读不到它（这正是它能防 XSS 的原因），
 * 但代价是**前端也没有能力删掉它**。只把 Pinia 里的状态清空的话，
 * 浏览器下一次请求依然带着那张有效票据 —— 用户会看到
 * 「点了退出、刷新一下又回来了」，而且不报错，只有真人操作才会发现。
 *
 * 所以「清票」这件事只能由服务端做，这就是本函数存在的唯一理由。
 *
 * silent：登出是幂等的收尾动作，失败也不该打断用户（本地状态照样清），
 * 更不能因为网络抖动弹一条红色错误——那时用户已经在登录页了。
 */
export function logout(): Promise<void> {
  if (USE_MOCK) return Promise.resolve()
  return request({ url: '/user/logout', method: 'POST', showLoading: false, silent: true })
}

/**
 * 获取当前用户信息（Mock 下按持久化 token 还原真实身份，保证管理员刷新后仍为管理员）。
 *
 * ★ 这里是**第二道**闸门：刷新页面后 store 只剩 `sessionHint`（真实模式）
 *   或 `token`（mock 模式）、没有 profile，全靠这个函数还原身份。之前它不校验 `status`，
 *   所以「刚被封禁的账号只要 F5 一下就能满血复活」。
 *   另外也去掉了「认不出 token 就兜底成计算机小张」的逻辑 ——
 *   那等于任何乱写的 token 都能换到一个可用账号。
 */
export async function getProfile(): Promise<User> {
  if (USE_MOCK) {
    await mockHelpers.delay(200)
    return assertSessionActive()
  }
  return request({ url: '/user/profile', showLoading: false })
}

/**
 * 修改密码（设置页入口，用户自助）。
 * 原密码错误 / 新密码不足 6 位 / 与原密码相同 → 后端以业务码 1001 拒绝，
 * request.ts 会把 message（如「原密码不正确」）直接 toast 出来。
 */
export function changePassword(payload: { oldPassword: string; newPassword: string }): Promise<void> {
  return request({ url: '/user/password', method: 'PATCH', data: payload, showLoading: false })
}

/**
 * 修改个人资料（昵称 / 头像 / 手机号）。
 *
 * ★ 为什么这个函数曾经不存在 ★
 * 「编辑资料」弹窗一直在，但它只改了 Pinia 里的 profile 对象：
 * 页面当场显示新昵称，看着像成功了，一刷新就变回去 —— 因为**后端根本没有这个接口**。
 * 这不是「实现得不够好」，是整条链路缺了一半。
 *
 * ★ 局部更新语义 ★：只发送需要修改的字段。后端按「请求体里出现了哪个键」判断改哪一列，
 * 所以这里必须用 `!== undefined` 而不是「有值才发」—— 手机号传空串是**有意义的**
 * （表示清空该字段），不能因为它是空值就被过滤掉。
 *
 * ★ 返回值是服务端落库后的完整资料 ★：调用方必须拿它回填（`userStore.applyProfile`），
 * 而不是沿用本地乐观值 —— 否则请求失败时界面已经变了，用户会以为保存成功。
 */
export async function updateProfile(patch: {
  nickname?: string
  avatar?: string
  phone?: string
}): Promise<User> {
  if (USE_MOCK) {
    await mockHelpers.delay(260)
    const me = assertSessionActive()
    /*
     * mock 分支刻意与后端保持同一套语义，而不是「随便改改」：
     *  - 昵称非空（t_user.nickname 是 NOT NULL，清空会让真实后端抛 SQL 异常）；
     *  - 手机号空串 = 清空，填了就必须合法（与后端 Validators.phone 同一口径）。
     * 不同步的话，演示时「Mock 下能保存、切到真实模式就报错」，很难解释。
     */
    if (patch.nickname !== undefined) {
      const nickname = patch.nickname.trim()
      if (!nickname) throw new Error('昵称不能为空')
      me.nickname = nickname
    }
    if (patch.avatar !== undefined) me.avatar = patch.avatar.trim()
    if (patch.phone !== undefined) {
      const r = validateCnPhone(patch.phone, { allowEmpty: true })
      if (!r.ok) throw new Error(r.message)
      me.phone = r.value || undefined
    }
    // 返回浅拷贝：与 fetchUsers 的理由一样，避免调用方拿到 mock 源对象的引用
    return { ...me }
  }
  return request({ url: '/user/profile', method: 'PATCH', data: patch, showLoading: false })
}

/* ====================================================================
 * 在线状态：心跳 / 在线名单 / 隐私开关
 * ====================================================================
 * ★ 这一组接口存在的意义 ★
 * 在线状态此前是**纯前端编出来的**：utils/prefs 里用「用户 id + 当天日期」做散列，
 * 约六成用户显示在线 —— 页面看着挺像，但：
 *   - 关掉「显示在线状态」只遮住了自己的眼睛，别人照样看得到你在线；
 *   - 在线与否跟「你到底在不在」毫无关系，纯随机（当天固定）；
 *   - 首页根本不渲染卖家信息，所以开关在首页切来切去毫无变化，像个坏开关。
 * 现在「谁在线」由服务端算：客户端只负责定期心跳报到，
 * 名单由服务端按「show_online = 1 且 5 分钟内活跃过」现算 —— 口径只有一处。
 */

/** 在线时间窗（毫秒）。★ 必须与后端 UserService.ONLINE_WINDOW_SECONDS 一致（300 秒）★ */
export const ONLINE_WINDOW_MS = 5 * 60 * 1000

/** 心跳间隔（毫秒）：60 秒。取时间窗的 1/5 —— 连丢 4 次心跳也还在线 */
export const HEARTBEAT_INTERVAL_MS = 60 * 1000

/**
 * 心跳：告诉服务端「我还在」。
 * <p>
 * 不带任何参数 —— 活跃时刻由**服务端时钟**决定。若允许客户端上报时间戳，
 * 改本机时间就能把自己（或配合其他漏洞把别人）刷成在线。
 */
export function heartbeat(): Promise<void> {
  if (USE_MOCK) {
    mockTouchPresence()
    return Promise.resolve()
  }
  return request({ url: '/user/heartbeat', method: 'POST', showLoading: false })
}

/**
 * 批量查询「这批 id 里谁在线」。
 * <p>
 * 只传 id、只回 id：不返回活跃时间戳，避免把「某人几点在不在线」的时间线暴露出去。
 * 空数组直接短路，不发请求。
 */
export async function fetchOnlineIds(ids: number[]): Promise<number[]> {
  const clean = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))]
  if (clean.length === 0) return []
  if (USE_MOCK) {
    await mockHelpers.delay(60)
    return mockOnlineIds(clean)
  }
  // 逗号分隔而不是数组：axios 会把数组序列化成 ids[]=1&ids[]=2，
  // 后端 Params.multiValue 两种都收，但 CSV 更省事也更好读日志
  return request({ url: '/users/online', params: { ids: clean.join(',') }, showLoading: false })
}

/**
 * 隐私设置：是否对外展示自己的在线状态。
 * <p>
 * ★ 这是账号级设置，必须落库 ★
 * 返回值是**服务端落库后的值**，调用方应拿它回填开关，而不是沿用乐观更新的结果 ——
 * 否则请求失败时界面会显示一个「其实没生效」的开关。
 */
export async function updatePrivacy(payload: { showOnline: boolean }): Promise<boolean> {
  if (USE_MOCK) {
    await mockHelpers.delay(150)
    mockSetShowOnline(payload.showOnline)
    return payload.showOnline
  }
  return request({ url: '/user/privacy', method: 'PATCH', data: payload, showLoading: false })
}

/* ---- Mock 在线名单（演示模式专用，口径与后端一致） ---- */

/**
 * mock 下的「在线名单」。
 * <p>
 * 没有后端时用本地时间戳模拟同一套判定：记「最后活跃时刻」，按同一个 5 分钟窗口现场算，
 * 并且**同样尊重本账号的 showOnline 开关** —— 否则 mock 模式下开关又变回「只遮自己的眼睛」，
 * 演示时一开关就露馅。
 */
const mockPresence = new Map<number, number>()
let mockPresenceSeeded = false

/** 种入一批「刚活跃过」的演示用户，避免 mock 下在线标识永远不亮 */
function ensureMockPresenceSeeded() {
  if (mockPresenceSeeded) return
  mockPresenceSeeded = true
  const now = Date.now()
  mockUsersExport.forEach((u, i) => {
    // 隔一个算一个在线：在线 / 离线两种形态都能看到
    if (i % 2 === 0) mockPresence.set(u.id, now - i * 1000)
  })
}

/** 心跳（mock）：把「我」的活跃时间刷成现在 */
function mockTouchPresence() {
  ensureMockPresenceSeeded()
  try {
    const me = assertSessionActive()
    mockPresence.set(me.id, Date.now())
  } catch {
    // 未登录时心跳没有意义，静默忽略（真实接口会回 401，由 request.ts 统一处理）
  }
}

/** 在线名单（mock）：与后端 SQL 同一口径 —— 先看隐私开关，再看时间窗 */
function mockOnlineIds(ids: number[]): number[] {
  ensureMockPresenceSeeded()
  const now = Date.now()
  return ids
    .filter((id) => {
      const user = mockUsersExport.find((u) => u.id === id)
      // showOnline === false 的人一律不在名单里，等价于后端 SQL 的 show_online = 1
      if (user && user.showOnline === false) return false
      const last = mockPresence.get(id)
      return last !== undefined && now - last < ONLINE_WINDOW_MS
    })
    .sort((a, b) => a - b)
}

/** 更新隐私开关（mock） */
function mockSetShowOnline(showOnline: boolean) {
  ensureMockPresenceSeeded()
  const me = assertSessionActive()
  me.showOnline = showOnline
  if (showOnline) {
    mockPresence.set(me.id, Date.now())
  } else {
    mockPresence.delete(me.id)
  }
}

/** 用户列表（管理端）。行做浅拷贝返回：表格拿到的永远是新对象，改完信用分必然重渲染 */
export async function fetchUsers(query: { page?: number; pageSize?: number; keyword?: string; status?: string }): Promise<PageResult<User>> {
  if (USE_MOCK) {
    await mockHelpers.delay(300)
    const page = query.page ?? 1
    const pageSize = query.pageSize ?? 10
    const keyword = query.keyword?.toLowerCase() ?? ''
    let list = mockUsersExport.filter((u) => !keyword || u.username.includes(keyword) || u.nickname.includes(keyword))
    if (query.status) list = list.filter((u) => u.status === query.status)
    const total = list.length
    list = list.slice((page - 1) * pageSize, page * pageSize).map((u) => ({ ...u }))
    return { list, total, page, pageSize }
  }
  return request({ url: '/admin/users', method: 'GET', params: query })
}

/**
 * 用户公开主页（他人视角）。
 *
 * 只回「可以示人」的字段：昵称 / 头像 / 信用分 / 注册时间 / 角色，
 * 用户名、邮箱等私有信息不外露 —— 与主流电商的他人主页口径一致。
 */
export interface PublicProfile {
  id: number
  nickname: string
  avatar: string
  creditScore: number
  role: User['role']
  createTime: string
}

export async function fetchPublicProfile(id: number): Promise<PublicProfile | null> {
  if (USE_MOCK) {
    await mockHelpers.delay(220)
    const u = mockUsersExport.find((x) => x.id === id)
    if (!u) return null
    return {
      id: u.id,
      nickname: u.nickname,
      avatar: u.avatar,
      creditScore: u.creditScore,
      role: u.role,
      createTime: u.createTime
    }
  }
  return request({ url: `/users/${id}/profile` })
}

/*
 * ★ approveUser（用户审核通过）已随 D11 拆除（2026-09-23）★
 * 决策：注册不走管理员审核，注册即 active；「待审核」为无入口的死状态。
 * 用户治理只保留封禁/解封（toggleUserStatus）。
 */

/** 重置密码（Mock 演示：固定重置为 123456，并要求用户下次登录后修改） */
export async function resetUserPassword(id: number): Promise<string> {
  if (USE_MOCK) {
    await mockHelpers.delay(240)
    const u = mockUsersExport.find((x) => x.id === id)
    if (!u) throw new Error('用户不存在')
    mockHelpers.addAuditLog({
      action: 'user.resetPassword',
      actionLabel: '重置用户密码',
      target: `用户 #${u.id}`,
      detail: `${u.nickname}（${u.username}）密码已被管理员重置`
    })
    return '123456'
  }
  return request({ url: `/admin/users/${id}/reset-password`, method: 'POST' })
}

/**
 * 发送平台警告（站内信）。
 *
 * 直接写消息缓存而不是走 sendMessage()：sendMessage 会触发「对方自动回复」的
 * 演示逻辑，平台警告不该收到一条"好的谢谢"的机器人回复。
 */
export async function warnUser(id: number, reason: string): Promise<void> {
  if (USE_MOCK) {
    await mockHelpers.delay(240)
    const u = mockUsersExport.find((x) => x.id === id)
    if (!u) throw new Error('用户不存在')
    const admin = mockUsersExport.find((x) => x.role === 'admin')!
    const sessionId = makeSessionId(admin.id, u.id, 0)
    const msg: Message = {
      id: mockHelpers.nextMessageId(),
      sessionId,
      fromUserId: admin.id,
      toUserId: u.id,
      content: `【平台警告】${reason}`,
      createTime: new Date().toISOString(),
      read: false
    }
    mockHelpers.setMessages([...mockHelpers.getMessages(), msg])
    const sessions = mockHelpers.getSessions()
    if (!sessions.some((s) => s.id === sessionId)) {
      sessions.unshift({
        id: sessionId,
        peerId: u.id,
        peerName: u.nickname,
        peerAvatar: u.avatar,
        lastMessage: msg.content,
        lastTime: msg.createTime,
        unread: 0
      })
      mockHelpers.setSessions(sessions)
    } else {
      const s = sessions.find((x) => x.id === sessionId)!
      s.lastMessage = msg.content
      s.lastTime = msg.createTime
    }
    mockHelpers.addAuditLog({
      action: 'user.warn',
      actionLabel: '发送平台警告',
      target: `用户 #${u.id}`,
      detail: `${u.nickname}：${reason}`
    })
    return
  }
  return request({ url: `/admin/users/${id}/warn`, method: 'POST', data: { reason } })
}

/** 封禁/解封 */
export async function toggleUserStatus(payload: { id: number; banned: boolean }): Promise<void> {
  if (USE_MOCK) {
    await mockHelpers.delay(300)
    const u = mockUsersExport.find((x) => x.id === payload.id)
    if (u) u.status = payload.banned ? 'banned' : 'active'
    if (u) {
      mockHelpers.addAuditLog({
        action: payload.banned ? 'user.ban' : 'user.unban',
        actionLabel: payload.banned ? '封禁用户' : '解封用户',
        target: `用户 #${u.id}`,
        detail: `${u.nickname}（${u.username}）`
      })
    }
    return
  }
  return request({ url: `/admin/users/${payload.id}/ban`, method: 'POST', data: { banned: payload.banned } })
}

/** 批量封禁 / 解封（后台多选） */
export async function batchToggleUserStatus(ids: number[], banned: boolean): Promise<number> {
  if (USE_MOCK) {
    await mockHelpers.delay(340)
    if (!ids.length) return 0
    const set = new Set(ids)
    // 管理员类账号不允许被批量封禁，避免把自己锁在门外
    const ADMIN_ROLES: ReadonlyArray<User['role']> = ['admin', 'goods_admin', 'report_admin']
    const targets = mockUsersExport.filter((u) => set.has(u.id) && !ADMIN_ROLES.includes(u.role))
    targets.forEach((u) => {
      u.status = banned ? 'banned' : 'active'
    })
    if (targets.length) {
      mockHelpers.addAuditLog({
        action: banned ? 'user.batchBan' : 'user.batchUnban',
        actionLabel: banned ? '批量封禁用户' : '批量解封用户',
        target: `${targets.length} 个用户`,
        detail: targets.map((u) => u.nickname).join('、')
      })
    }
    return targets.length
  }
  return request({ url: '/admin/users/batch-ban', method: 'POST', data: { ids, banned } })
}

/** 调整信用分（夹取到 0-100，并记录调整量） */
export async function setUserCredit(payload: { id: number; delta?: number; value?: number }): Promise<User> {
  if (USE_MOCK) {
    await mockHelpers.delay(240)
    const u = mockUsersExport.find((x) => x.id === payload.id)
    if (!u) throw new Error('用户不存在')
    const before = u.creditScore
    const raw = payload.value ?? before + (payload.delta ?? 0)
    u.creditScore = Math.min(100, Math.max(0, Math.round(raw)))
    mockHelpers.addAuditLog({
      action: 'user.credit',
      actionLabel: '调整信用分',
      target: `用户 #${u.id}`,
      detail: `${u.nickname}：${before} → ${u.creditScore}`
    })
    return u
  }
  return request({ url: `/admin/users/${payload.id}/credit`, method: 'PATCH', data: payload })
}

/* ====================================================================
 * 个人中心 API：我的商品 / 收藏 / 历史 / 地址
 * ==================================================================== */

/** 当前登录用户在 mock 数据里的 id（演示账号「计算机小张」） */
const CURRENT_USER_ID = 1

/**
 * 「我发布的」商品全集。
 *
 * 两个来源缺一不可：
 *  ① `_myGoodsCache`：演示用的 8 件「我的商品」（四种状态齐全，方便演示筛选与上下架）；
 *  ② 商品池里 `sellerId === 1` 的商品 —— **新发布的商品是写进商品池的**
 *     （`publishGoods` 只往 `_goodsCache` 里插），只读 ① 就会出现
 *     「发布成功 → 个人主页我的发布里什么都没有」。
 * 按 id 去重（②里的商品可能已被①收录），我的商品排在前面。
 */
function collectMyGoods(): Goods[] {
  const mine = mockHelpers.getMyGoodsCache().slice()
  const seen = new Set(mine.map((g) => g.id))
  const fromPool = mockHelpers
    .getGoodsCache()
    .filter((g) => g.sellerId === CURRENT_USER_ID && !seen.has(g.id))
  return [...mine, ...fromPool]
}

/**
 * 跨两个存储给我的商品打补丁：命中哪个就改哪个，并返回是否命中。
 *
 * 只改 `_myGoodsCache` 会让商品池里的商品（含刚发布的）点「下架」毫无反应 ——
 * 列表来自两个来源，写也必须覆盖两个来源。
 */
function patchMyGoods(id: number, patch: Partial<Goods>): boolean {
  let hit = false
  const mine = mockHelpers.getMyGoodsCache()
  if (mine.some((g) => g.id === id)) {
    mockHelpers.setMyGoodsCache(mine.map((g) => (g.id === id ? { ...g, ...patch } : g)))
    hit = true
  }
  const pool = mockHelpers.getGoodsCache()
  if (pool.some((g) => g.id === id && g.sellerId === CURRENT_USER_ID)) {
    mockHelpers.setGoodsCache(pool.map((g) => (g.id === id ? { ...g, ...patch } : g)))
    hit = true
  }
  return hit
}

/** 从两个存储里同时删除我的商品 */
function removeMyGoods(id: number): void {
  mockHelpers.setMyGoodsCache(mockHelpers.getMyGoodsCache().filter((g) => g.id !== id))
  const pool = mockHelpers.getGoodsCache()
  if (pool.some((g) => g.id === id && g.sellerId === CURRENT_USER_ID)) {
    mockHelpers.setGoodsCache(pool.filter((g) => g.id !== id))
  }
}

/** 我发布的商品（按状态 / 关键字过滤） */
export async function fetchMyGoods(query: {
  page?: number
  pageSize?: number
  status?: Goods['status']
  keyword?: string
}): Promise<PageResult<Goods>> {
  if (USE_MOCK) {
    await mockHelpers.delay(280)
    const page = query.page ?? 1
    const pageSize = query.pageSize ?? 12
    let list = collectMyGoods()
    if (query.status) list = list.filter((g) => g.status === query.status)
    if (query.keyword) {
      const kw = query.keyword.toLowerCase()
      list = list.filter((g) => g.title.toLowerCase().includes(kw))
    }
    const total = list.length
    list = list.slice((page - 1) * pageSize, page * pageSize)
    return { list, total, page, pageSize }
  }
  return request({ url: '/user/goods', method: 'GET', params: query })
}

/**
 * 上下架我的商品。
 *
 * **审核中的商品不能自己上架** —— 上架意味着「已通过平台审核、可以对外售卖」，
 * 绕过审核自行上架等于让未审内容直接面对买家。这条必须挡在数据层，
 * 不能只靠按钮不显示：任何调用方都不该有绕过审核的路径。
 */
export async function toggleMyGoods(payload: { id: number; status: 'on_sale' | 'off_shelf' }): Promise<void> {
  if (USE_MOCK) {
    await mockHelpers.delay(220)
    const target = collectMyGoods().find((g) => g.id === payload.id)
    if (!target) throw new Error('商品不存在')
    if (payload.status === 'on_sale' && target.status === 'pending') {
      throw new Error('商品还在审核中，通过审核后才可以上架')
    }
    patchMyGoods(payload.id, { status: payload.status })
    return
  }
  return request({ url: `/user/goods/${payload.id}/status`, method: 'PATCH', data: { status: payload.status } })
}

/** 删除我的商品 */
export async function deleteMyGoods(id: number): Promise<void> {
  if (USE_MOCK) {
    await mockHelpers.delay(220)
    removeMyGoods(id)
    return
  }
  return request({ url: `/user/goods/${id}`, method: 'DELETE' })
}

/** 我的收藏 */
export async function fetchFavorites(query: { page?: number; pageSize?: number } = {}): Promise<PageResult<Favorite>> {
  if (USE_MOCK) {
    await mockHelpers.delay(280)
    const page = query.page ?? 1
    const pageSize = query.pageSize ?? 12
    const all = mockHelpers.getFavorites()
    const total = all.length
    const list = all.slice((page - 1) * pageSize, page * pageSize)
    return { list, total, page, pageSize }
  }
  return request({ url: '/user/favorites', method: 'GET', params: query })
}

/** 取消收藏 */
export async function removeFavorite(goodsId: number): Promise<void> {
  if (USE_MOCK) {
    await mockHelpers.delay(180)
    mockHelpers.setFavorites(mockHelpers.getFavorites().filter((x) => x.goodsId !== goodsId))
    return
  }
  return request({ url: `/user/favorites/${goodsId}`, method: 'DELETE' })
}

/** 切换收藏（不存在则添加） */
export async function toggleFavorite(payload: { goods: Goods }): Promise<{ favorited: boolean }> {
  if (USE_MOCK) {
    await mockHelpers.delay(150)
    const list = mockHelpers.getFavorites()
    const exist = list.find((x) => x.goodsId === payload.goods.id)
    if (exist) {
      mockHelpers.setFavorites(list.filter((x) => x.goodsId !== payload.goods.id))
      return { favorited: false }
    }
    list.unshift({
      id: Date.now(),
      goodsId: payload.goods.id,
      goods: {
        id: payload.goods.id,
        title: payload.goods.title,
        price: payload.goods.price,
        cover: payload.goods.cover,
        promoPrice: payload.goods.promoPrice,
        status: payload.goods.status,
        location: payload.goods.location,
        sellerName: payload.goods.sellerName,
        stock: payload.goods.stock
      },
      createTime: new Date().toISOString()
    })
    mockHelpers.setFavorites(list)
    return { favorited: true }
  }
  return request({ url: '/user/favorites/toggle', method: 'POST', data: { goodsId: payload.goods.id } })
}

/** 浏览历史 */
export async function fetchHistory(query: { page?: number; pageSize?: number } = {}): Promise<PageResult<HistoryItem>> {
  if (USE_MOCK) {
    await mockHelpers.delay(260)
    const page = query.page ?? 1
    const pageSize = query.pageSize ?? 15
    const all = mockHelpers.getHistory()
    const total = all.length
    const list = all.slice((page - 1) * pageSize, page * pageSize)
    return { list, total, page, pageSize }
  }
  return request({ url: '/user/history', method: 'GET', params: query })
}

/** 浏览足迹最多保留的条数（超过就丢掉最旧的，避免本地数据无限膨胀） */
const HISTORY_MAX = 50

/**
 * 记录一次浏览足迹。
 *
 * 原先只有种子数据、**没有任何写入入口** —— 所以「看完商品 → 个人主页浏览足迹」
 * 永远是那 18 条假数据，新看的商品一个都不会出现。
 * 详情页每次打开都要调它。
 *
 * 同一件商品重复浏览只保留**最近一次**（先按 goodsId 去重再插到最前）：
 * 不去重的话，反复看同一件商品会把整个足迹列表刷成一模一样的条目。
 */
export async function recordHistory(payload: { goods: Goods }): Promise<void> {
  if (USE_MOCK) {
    const g = payload.goods
    const list = mockHelpers.getHistory().filter((h) => h.goodsId !== g.id)
    const item: HistoryItem = {
      // 用时间戳兜底自增，避免商品反复浏览时 id 撞车
      id: Math.max(Date.now(), ...list.map((h) => h.id)) + 1,
      goodsId: g.id,
      goods: {
        id: g.id,
        title: g.title,
        price: g.price,
        promoPrice: g.promoPrice,
        cover: g.cover,
        // status / stock 必须一起快照：
        // 足迹页要把这份快照原样转成收藏条目，而收藏列表靠 `goods.status === 'sold'`
        // 打「已售出」标、靠 stock 给加购数量封顶。漏掉就等于这两个能力同时失效。
        status: g.status,
        stock: g.stock,
        location: g.location,
        sellerName: g.sellerName
      },
      viewTime: new Date().toISOString()
    }
    mockHelpers.setHistory([item, ...list].slice(0, HISTORY_MAX))
    return
  }
  return request({ url: '/user/history', method: 'POST', data: { goodsId: payload.goods.id } })
}

/** 清空浏览历史 */
export async function clearHistory(): Promise<void> {
  if (USE_MOCK) {
    await mockHelpers.delay(180)
    mockHelpers.setHistory([])
    return
  }
  return request({ url: '/user/history', method: 'DELETE' })
}

/** 删除一条历史 */
export async function removeHistory(id: number): Promise<void> {
  if (USE_MOCK) {
    await mockHelpers.delay(160)
    mockHelpers.setHistory(mockHelpers.getHistory().filter((x) => x.id !== id))
    return
  }
  return request({ url: `/user/history/${id}`, method: 'DELETE' })
}

/** 收货地址列表 */
export async function fetchAddresses(): Promise<Address[]> {
  if (USE_MOCK) {
    await mockHelpers.delay(220)
    return mockHelpers.getAddresses()
  }
  return request({ url: '/user/addresses' })
}

/** 新增 / 修改地址 */
export async function saveAddress(addr: Address): Promise<Address> {
  if (USE_MOCK) {
    await mockHelpers.delay(220)
    const list = mockHelpers.getAddresses().slice()
    if (addr.isDefault) list.forEach((x) => (x.isDefault = false))
    if (addr.id) {
      const idx = list.findIndex((x) => x.id === addr.id)
      if (idx >= 0) list[idx] = addr
    } else {
      const id = Math.max(0, ...list.map((x) => x.id)) + 1
      mockHelpers.setAddresses([...list, { ...addr, id }])
      return { ...addr, id }
    }
    mockHelpers.setAddresses(list)
    return addr
  }
  return request({ url: addr.id ? `/user/addresses/${addr.id}` : '/user/addresses', method: addr.id ? 'PUT' : 'POST', data: addr })
}

/** 删除地址 */
export async function deleteAddress(id: number): Promise<void> {
  if (USE_MOCK) {
    await mockHelpers.delay(180)
    mockHelpers.setAddresses(mockHelpers.getAddresses().filter((x) => x.id !== id))
    return
  }
  return request({ url: `/user/addresses/${id}`, method: 'DELETE' })
}
