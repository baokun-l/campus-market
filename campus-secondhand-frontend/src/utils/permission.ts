/**
 * 权限与鉴权工具
 */
import type { NavigationGuard } from 'vue-router'
import { useUserStore } from '@/stores/modules/user'
import { SessionRevokedError } from '@/api/session'

/**
 * 全局路由守卫工厂
 *
 * ★ 这里曾经是「封禁形同虚设」的第三处、也是最隐蔽的一处漏洞：
 *   `try { await userStore.fetchProfile() } catch { /* ignore *\/ }`
 *   —— 错误被整段吞掉。哪怕 `fetchProfile()` 因为账号被封禁而抛错，
 *   `token` 依然留在 store 里，`isLoggedIn` 照样是 true，守卫于是正常放行。
 *   现在必须区分两类失败：
 *     · `SessionRevokedError`（封禁 / token 失效）→ 清会话 + 带回原因送回登录页；
 *     · 其它（网络抖动之类）→ 不踢人，交给后续的「未登录」分支处理。
 *
 * 另外加了**每次跳转的同步复查**（`syncSessionStatus`，零延迟，只在内存里比一次状态）。
 *
 * ★ 这道复查的实际生效范围 —— 别把它想得比真实情况更强 ★
 * 它依赖 `recheckSession()` → `resolveSessionUser()`，后者按 `mock-token-*` 正则解析 token
 * 再比对**前端 mock 用户表**。于是：
 *   · Mock 模式：有效。后台把某账号改成 banned 后，同一标签内切回前台立刻被踢出；
 *   · 真实模式（`VITE_USE_MOCK=false`）：**恒为空转** —— D9 之后更彻底，
 *     `readToken()` 直接返回空串（凭据在 HttpOnly Cookie 里），
 *     `resolveSessionUser()` 于是第一步就返回 null，下面的判断永远不会成立。
 * 真实模式下拦住被封禁账号的是**服务端**：`AuthInterceptor` 每个请求回查 `t_user.status`，
 * 加上本守卫开头的 `fetchProfile()`（只在 `profile` 尚未加载时才执行）。
 * 所以真实模式里封禁是在**下一次请求拿到 401 / 抛 SessionRevokedError** 时生效，
 * 而不是路由跳转那一刻。这个差距是已知的 —— 不要用注释把它抹平。
 */
export function createAuthGuard(): NavigationGuard {
  return async (to, _from, next) => {
    const userStore = useUserStore()

    /*
     * 启动时恢复登录态。★ 判断条件必须是 `isLoggedIn`，不能是 `token`（D9）★
     *
     * 持久化的东西里没有 profile，而 profile 是权限判定（isAdmin / roles）
     * 与界面渲染的唯一依据，所以每次冷启动都得向服务端要一次。
     * 触发条件以前写的是 `userStore.token` —— 真实模式下 token 恒为空串
     * （凭据在 HttpOnly Cookie 里），这个分支于是**永远不进**：
     * profile 一直为 null ⇒ `isAdmin` 恒假 ⇒ 管理员登录后进自己后台直接被 403。
     * 这正是"能力静默消失"的典型样子：不报错，只是某个角色突然用不了。
     * `isLoggedIn` 两种模式都对：mock 看 token，真实看 sessionHint。
     */
    if (!userStore.profile && userStore.isLoggedIn) {
      try {
        await userStore.fetchProfile()
      } catch (e) {
        if (e instanceof SessionRevokedError) {
          userStore.revoke(e.reason, e.message)
          if (to.meta.public) return next()
          return next({ path: '/login', query: { revoked: e.reason } })
        }
        /*
         * 非会话问题：放行，让下面的「未登录」分支去处理，不要误踢。
         *
         * 真实模式下最常见的走法就在这一支：401 由 `api/request.ts#handleUnauthorized`
         * 处理 —— 它已经作废了本地会话（`sessionHint` 置假），所以下面
         * `requireAuth && !isLoggedIn` 会把用户送回登录页，同时
         * `revokedMessage` 里留着服务端给的原因（「账号已被封禁…」）。
         * 这里**不需要**再 revoke 一次：重复调用会把 revoked 文案覆盖成通用文案。
         */
      }
    }

    // 每次跳转复查一次账号状态：封禁后同一会话内立刻生效
    if (userStore.isLoggedIn && userStore.syncSessionStatus() === 'banned' && !to.meta.public) {
      return next({ path: '/login', query: { revoked: 'banned' } })
    }

    if (to.meta.public) return next()
    if (to.meta.requireAuth && !userStore.isLoggedIn) {
      return next({ path: '/login', query: { redirect: to.fullPath } })
    }
    if (to.meta.requireAdmin && !userStore.isAdmin) {
      return next({ path: '/403' })
    }
    /*
     * 细粒度角色闸门：`meta.roles` 声明**允许进入的角色数组**。
     *
     * 双独立后台的关键：商品审核后台只认 goods_admin（全能 admin 也放行，
     * 便于排查演示数据），举报处理后台只认 report_admin。
     * 普通用户 / 对口审核员**互串**对方的后台，在这里被统一拦到 /403 ——
     * 权限边界必须挡在路由层，只靠菜单不显示是藏不住直接输 URL 的。
     */
    const requiredRoles = to.meta.roles as string[] | undefined
    if (requiredRoles?.length && !requiredRoles.some((r) => userStore.roles.includes(r))) {
      return next({ path: '/403' })
    }
    next()
  }
}

/** 简易粗粒度按钮权限 */
export function checkPermission(required: string | string[]): boolean {
  const userStore = useUserStore()
  const allow = Array.isArray(required) ? required : [required]
  if (allow.length === 0) return true
  return allow.some((p) => {
    if (p === 'admin') return userStore.isAdmin
    if (p === 'user') return userStore.isLoggedIn
    return false
  })
}
