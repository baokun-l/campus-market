/**
 * 会话身份解析 + 账号状态校验 —— **全站唯一口径**。
 *
 * 为什么要有这个文件：
 * 之前「谁在登录」这件事被散落在 `api/user.ts` 里各写一遍（`login` 直接返回 user、
 * `getProfile` 自己正则解析 token），结果**三处都漏了状态校验**，被封禁的账号
 * 依然能登录、能刷新、能继续用：
 *   ① `login()` 只看用户名密码，不看 `status`；
 *   ② `getProfile()` 按 token 还原身份时也不看 `status`（刷新即复活）；
 *   ③ `utils/permission.ts` 的守卫把 `fetchProfile()` 整段 `try/catch` 掉、
 *      错误注释里写个 ignore 就完事 —— 即使 ② 抛错，`token` 还在、
 *      `isLoggedIn` 仍为真，照样放行。
 *
 * 所以这里把「token → 用户 → 是否可继续使用」收敛成一处，
 * 登录、还原、路由守卫都调它，避免再各写一套。
 *
 * ⚠️ 已知边界（mock 层的诚实限制）：用户表是**内存态**，不落 localStorage。
 *    所以「A 标签页封禁、B 标签页里已登录的受害者」不会自动掉线 ——
 *    浏览器标签之间不共享 JS 内存（真实站点靠服务端会话解决）。
 *    同一标签内的变化（后台封禁 → 切到前台）能被 `recheckSession()` 立刻发现 ——
 *    但**仅限 Mock 模式**。
 *
 * ════════════════════════════════════════════════════════════════════
 * ★★ D9 之后的重大变化：真实模式下**本文件的判定能力整体退场** ★★
 * ════════════════════════════════════════════════════════════════════
 * 凭据从 localStorage 搬进了 HttpOnly Cookie，JS 读不到它，于是这里所有
 * 「按 token 正则解析出用户」的函数在真实模式下**没有输入**：
 *   · `readToken()` 直接返回空串（mock 模式下仍读 localStorage）；
 *   · 因而 `isAdminToken` / `resolveSessionUser` / `assertSessionActive` /
 *     `recheckSession` 全部退化为 mock 专用工具。
 * 这不是"退化"，而是把**裁判权整个交给服务端**：
 * 「你是谁、还能不能用」由 `AuthInterceptor` 每请求回查 `t_user` 决定，
 * 前端只负责把 401 翻译成「回登录页」。
 *
 * ★ 由此产生的两条纪律（改这一片之前先读）★
 *   ① **不要**为了"让前端也能判断登录态"而把凭据写回 localStorage ——
 *      那正是 D9 要消灭的东西（XSS 一读即走）；
 *   ② 需要「大概登录着吗」这类弱判断时，用 store 的 `sessionHint`
 *      （一个不含凭据、伪造也换不到权限的布尔标记），而不是这里。
 *   ⇒ 边界一句话：**真实模式下前端不做鉴权判定，只做状态呈现。**
 */
import type { User } from '@/types'
import { mockUsersExport } from './mock'

/** 与 api/* 里同一口径：mock 模式不发真实请求 */
const USE_MOCK = import.meta.env.VITE_USE_MOCK === 'true'

/** 持久化 token 的键（与 `stores/modules/user.ts` 的 persist.key 必须一致） */
export const SESSION_KEY = 'c2c-user'

/**
 * 会话被拒的原因，供 UI 区分文案。
 * 「pending」已随 D11 拆除（2026-09-23）：用户注册即 active，不存在待审核会话。
 */
export type SessionRejectReason = 'banned' | 'expired'

/** token 前缀 → 用户 id 的解析规则（登录 / 注册两套都认） */
const TOKEN_USER_RE = /mock-token-(?:user|register)-(\d+)/

/**
 * 会话不可用（被封禁 / token 认不出来）时抛出的错误。
 * 守卫与 store 靠 `instanceof` 区分「会话问题」与「网络偶发错误」——
 * 后者不该把用户踢下线。
 */
export class SessionRevokedError extends Error {
  readonly reason: SessionRejectReason
  readonly user?: User
  constructor(reason: SessionRejectReason, message: string, user?: User) {
    super(message)
    this.name = 'SessionRevokedError'
    this.reason = reason
    this.user = user
  }
}

/**
 * 读取持久化的 token（解析失败一律当未登录，不抛）。
 *
 * ★ 真实模式**必须**返回空串（D9）★
 * 这不是"读不到就算了"，而是有意为之的最后一道保险：
 * 万一将来有人手滑把凭据又写回了 localStorage（或旧版本残留），
 * 只要这里不认，它就进不了 store、也进不了 Authorization 头 ——
 * 相当于给「凭据回流 localStorage」这个回归装了闸门。
 * 真实模式的凭据只在 HttpOnly Cookie 里，由浏览器自动携带，前端无需（也无法）读它。
 */
export function readToken(): string {
  if (!USE_MOCK) return ''
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return ''
    return JSON.parse(raw)?.token ?? ''
  } catch {
    return ''
  }
}

/** 是否管理员会话 */
export function isAdminToken(token = readToken()): boolean {
  return token.includes('admin')
}

/**
 * token → 用户。**只认用户表里的真实记录**，查不到就返回 null。
 *
 * 之前 `getProfile()` 在解析失败时会 `return mockUsersExport[0]`（兜底成「计算机小张」），
 * 等于「任何无效 token 都会被当成一个可用账号」。这里把这个兜底去掉了：
 * 认不出来就是未登录，由调用方决定回登录页还是当游客。
 */
export function resolveSessionUser(): User | null {
  const token = readToken()
  if (!token) return null
  if (isAdminToken(token)) return mockUsersExport.find((u) => u.role === 'admin') ?? null
  const matched = TOKEN_USER_RE.exec(token)
  if (!matched) return null
  return mockUsersExport.find((u) => u.id === Number(matched[1])) ?? null
}

/** 该账号当前是否**不允许**继续使用；返回原因，可用则返回 null */
export function rejectReasonOf(user: User | null): SessionRejectReason | null {
  if (!user) return null
  // 用户只剩 active / banned 两态（D11 拆除），封禁即拒、其余放行
  if (user.status === 'banned') return 'banned'
  return null
}

/** 封禁态给用户看的文案（登录页 / 被踢提示共用，避免两处措辞不一致） */
export function bannedMessage(user: User): string {
  return `账号「${user.nickname}」已被封禁，无法继续使用。若有疑问请联系管理员申诉。`
}

/**
 * 断言会话仍然可用，不可用就抛 `SessionRevokedError`。
 * 供 `getProfile()` 与路由守卫调用。
 */
export function assertSessionActive(): User {
  const user = resolveSessionUser()
  if (!user) throw new SessionRevokedError('expired', '登录状态已失效，请重新登录')
  if (user.status === 'banned') throw new SessionRevokedError('banned', bannedMessage(user), user)
  return user
}

/**
 * 同步复查：当前**内存里**的账号状态是否还能用。
 *
 * 不查接口、零延迟 —— 专门给路由守卫用：
 * 管理员在后台把某个账号封掉后，同一标签内切回前台时立刻就能发现，
 * 不必依赖「每个路由都发一次异步请求」。
 *
 * ★ 生效范围：**仅 Mock 模式**（调用方务必知悉）★
 * 判定完全建立在「按 `mock-token-*` 正则解析 token → 查前端 mock 用户表」之上。
 * 真实模式下 `readToken()` 直接返回空串（D9：凭据在 HttpOnly Cookie 里），
 * `resolveSessionUser()` 于是第一步就返回 null，本函数**恒为 null**，
 * `stores/modules/user.ts#syncSessionStatus` 永远读到「一切正常」。
 * 真实模式的封禁由服务端保证（`AuthInterceptor` 每请求回查 `t_user.status`），
 * 前端在收到 401 时登出 —— 延迟到下一次请求，而不是路由跳转那一刻。
 * 之所以保留本函数：Mock 模式（课堂演示与 `session.spec.ts`）确实依赖它，
 * 且它宁可不生效也不会误踢人（返回 null 只是「没发现异常」，不会清会话）。
 */
export function recheckSession(): SessionRejectReason | null {
  const user = resolveSessionUser()
  if (!user) return null
  return rejectReasonOf(user)
}
