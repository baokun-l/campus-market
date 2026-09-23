/**
 * 用户全局状态
 *
 * 除了 token / profile，这里还多存了「会话是否还活着」的字段：
 *   - `revoked` / `revokedMessage`：会话被拒的原因与文案。
 *     守卫读它决定是否把人送回登录页，登录页读它决定要不要弹那条提示。
 *
 * 之所以要显式存下来而不是只 `logout()`：直接清掉 token 会丢掉「为什么被踢」，
 * 用户只看到自己莫名其妙回到了登录页。
 *
 * ★★ D9 之后，「登录态」这件事在这里被拆成了两个来源（别只看 token）★★
 *   · mock 模式：`token`（`mock-token-*`）—— 前端的 mock 用户表靠它还原身份；
 *   · 真实模式：`sessionHint` 布尔标记 —— 真实凭据只在 **HttpOnly Cookie** 里，
 *     JS 读不到，`token` 恒为空串。
 * 判断"是否登录"一律用 `isLoggedIn` getter（两者取或），**不要直接看 `token`** ——
 * 真实模式下 `token` 永远为空，直接看它会把已登录用户全判成游客。
 * 这个陷阱已经在 App.vue（心跳启停）与 AiAssistant.vue（按钮显示）上各踩过一次。
 */
import { defineStore } from 'pinia'
import type { User } from '@/types'
import { login as apiLogin, register as apiRegister, getProfile as apiProfile, logout as apiLogout } from '@/api/user'
import { recheckSession, type SessionRejectReason } from '@/api/session'
import { useCartStore } from './cart'

/** 与 api/* 里同一口径：mock 模式不发真实请求 */
const USE_MOCK = import.meta.env.VITE_USE_MOCK === 'true'

/**
 * 通知服务端把会话 Cookie 清掉（部署适配清单 D9）。
 *
 * ★ 为什么登出必须发这一个请求 ★
 * 凭据现在放在 **HttpOnly Cookie** 里，也就是说**前端没有能力删掉它** ——
 * 这正是它防 XSS 的原因，但代价是「前端自己删 token」这条免费能力没了。
 * 只清空 store 的话，浏览器下一次请求仍然带着那张有效票据，
 * 用户会看到「点了退出登录、刷新一下又回来了」。所以清票必须由服务端执行。
 *
 * ★ 失败不拦 ★
 * 网络异常时照样要把本地状态清干净（否则用户退不出去），
 * 只是这次退出在服务端没生效 —— Cookie 会在到期后自然失效，风险有限。
 */
function revokeServerSession() {
  if (USE_MOCK) return
  apiLogout().catch(() => {})
}

interface State {
  /**
   * 会话票据。**真实模式（D9 之后）恒为空串** —— 凭据只在 HttpOnly Cookie 里。
   * 保留这个字段是因为 mock 模式的演示身份还原完全依赖它（见文件头）。
   * 任何"是否登录"的判断请用 `isLoggedIn`，见下方 `sessionHint`。
   */
  token: string
  /**
   * 「可能已登录」这一个布尔事实（仅真实模式使用）。
   *
   * ★ 为什么需要它，而不是用 token 判断登录 ★
   * 真实模式下凭据只在 HttpOnly Cookie 里，JS 读不到，所以刷新后前端
   * 无法自证「我还登录着」。若不持久化任何东西，刷新后会直接把人踢回登录页
   * （哪怕 Cookie 完全有效）。于是只持久化这个**不含凭据的标记**：
   * 它最多让界面先假定已登录，紧接着 `fetchProfile()` 会向服务端求证，
   * 失败（401）时立刻登出。伪造成本为零、也换不到任何权限 —— 服务端才是唯一裁判。
   */
  sessionHint: boolean
  profile: User | null
  roles: string[]
  /** 会话被拒原因；非空 = 刚被踢，需要给用户一个解释 */
  revoked: SessionRejectReason | null
  revokedMessage: string
}

export const useUserStore = defineStore('user', {
  state: (): State => ({
    token: '',
    sessionHint: false,
    profile: null,
    roles: [],
    revoked: null,
    revokedMessage: ''
  }),
  getters: {
    isLoggedIn: (s) => !!s.token || s.sessionHint,
    isAdmin: (s) => s.roles.includes('admin'),
    /** 商品审核员 —— 只能进商品审核后台（/review/goods） */
    isGoodsAdmin: (s) => s.roles.includes('goods_admin'),
    /** 举报审核员 —— 只能进举报处理后台（/review/report） */
    isReportAdmin: (s) => s.roles.includes('report_admin'),
    /** 有任意后台权限（全能管理员或两种审核员），决定外壳是否露后台入口 */
    hasAdminAccess: (s) => s.roles.some((r) => ['admin', 'goods_admin', 'report_admin'].includes(r)),
    nickname: (s) => s.profile?.nickname ?? '未登录',
    avatar: (s) => s.profile?.avatar ?? '',
    creditScore: (s) => s.profile?.creditScore ?? 100
  },
  actions: {
    /** 把「这个用户现在什么状态」同步成 store 字段，登录 / 还原两处共用 */
    applyProfile(u: User) {
      this.profile = u
      this.roles = [u.role]
    },
    async login(payload: { username: string; password: string }) {
      const { token, user } = await apiLogin(payload)
      /*
       * ★ 真实模式下**刻意不保存 token**（D9）★
       * 服务端已经把票据写进 HttpOnly Cookie 并随每次请求自动带上，
       * 前端再留一份就是「同一条凭据多一个可被 JS 读走的副本」——
       * 那正是本次要修的问题。接口响应里仍有这个字段（契约未变），
       * 只是前端不再持久化、不再使用它。
       * mock 模式必须保留：`mock-token-*` 承载着演示身份的还原逻辑，
       * 且它不含任何真实凭据（mock 模式根本不发请求）。
       */
      if (USE_MOCK) this.token = token
      this.sessionHint = true
      this.revoked = null
      this.revokedMessage = ''
      this.applyProfile(user)
      return user
    },
    async register(payload: { username: string; password: string; nickname: string }) {
      const { token, user } = await apiRegister(payload)
      // 同 login()：真实模式不落地凭据，注册即登录靠服务端下发的 Cookie
      if (USE_MOCK) this.token = token
      this.sessionHint = true
      this.revoked = null
      this.revokedMessage = ''
      this.applyProfile(user)
      return user
    },
    async fetchProfile() {
      const u = await apiProfile()
      this.applyProfile(u)
      return u
    },
    /**
     * 同步复查会话（零延迟，不查接口）。
     *
     * 给路由守卫用：管理员刚在后台把某个账号封掉，同一标签内切回前台时
     * 立刻就能发现并把会话作废。返回被拒原因。
     *
     * ★ 以 `token` 为前置条件是**有意**的：本复查只能靠 `mock-token-*`
     * 在内存里比对（见 api/session.ts 顶部「D9 之后的重大变化」）。
     * 真实模式下 token 恒为空 ⇒ 这里直接返回 null，等同"不复查"，
     * 真实模式的封禁由服务端 401 兜住。别把前置条件改成 `isLoggedIn`
     * ——那会让真实模式也走进去，只是白读一遍空串，反而掩盖了"此处不生效"这件事。
     */
    syncSessionStatus(): SessionRejectReason | null {
      if (!this.token) return null
      const reason = recheckSession()
      if (reason === 'banned') this.revoke('banned', '你的账号已被封禁，已自动退出登录。')
      return reason
    },
    /**
     * 作废会话并记下原因（守卫清人、被封禁、服务端 401 三处共用）。
     *
     * ★ 必须同时清 `sessionHint` ★
     * 真实模式下它是 `isLoggedIn` 的唯一来源（token 恒为空）。漏掉它的话，
     * 被踢之后 `isLoggedIn` 仍为真 —— 路由守卫会认为「人还在」而放行，
     * 用户停在一个没有任何数据的页面上，且刷新也回不到登录页。
     *
     * 顺带通知服务端清 Cookie：票据已经失效了，留着它只会让之后每个请求
     * 都换回一个 401，反复弹「登录状态已过期」。
     */
    revoke(reason: SessionRejectReason, message: string) {
      this.token = ''
      this.sessionHint = false
      this.profile = null
      this.roles = []
      this.revoked = reason
      this.revokedMessage = message
      revokeServerSession()
      // 购物车条目存的是「加入时的价格快照」，属于该账号的视图；
      // 不清的话同一浏览器换账号后，后一位用户会看到甚至下单前一位的车。
      useCartStore().clear()
    },
    /** 用户主动退出：与「被踢」区分开，不留提示 */
    logout() {
      this.token = ''
      this.sessionHint = false
      this.profile = null
      this.roles = []
      this.revoked = null
      this.revokedMessage = ''
      // ★ 清票必须走服务端（D9）★ HttpOnly Cookie 前端删不掉，
      // 不发这一个请求就会出现「点了退出、刷新又回来」——不报错，只有真人能发现。
      // 放在这里而不是三个调用点：登出入口有三个
      // （layouts/BasicLayout.vue、api/request.ts 的 401 自动登出、views/settings/Index.vue），
      // 收敛进 store 才不会有第四个入口忘了做。
      revokeServerSession()
      // 见 revoke()：登出同样清空购物车
      useCartStore().clear()
    },
    clearRevoked() {
      this.revoked = null
      this.revokedMessage = ''
    },
    setToken(token: string) { this.token = token }
  },
  persist: {
    key: 'c2c-user',
    storage: localStorage,
    /*
     * ★ 持久化哪些字段（D9 的边界所在）★
     *   token       —— 仅 mock 模式会有值；真实模式恒为 ''，写进去也是空串。
     *                  保留它是为了演示身份（`mock-token-*`）能被还原。
     *   sessionHint —— 真实模式唯一的"我大概登录着"标记，**不含凭据**。
     * ★ 除此之外任何字段都不该落 localStorage ★
     *   profile 里有手机号等个人信息；凭据本身已进 HttpOnly Cookie。
     *   伪造 sessionHint 的成本为零，但它换不到任何权限（服务端是唯一裁判），
     *   最坏效果是「刷新后界面先按已登录渲染一瞬，紧接着被 fetchProfile 的 401 纠正」。
     */
    paths: ['token', 'sessionHint']
  }
})
