/**
 * 侧边栏菜单配置（按权限过滤 + 按使用频次排序）
 *
 * 排序逻辑（参考图 6.3 的信息密度与分组节奏）：
 *   ① 核心动线   首页 → 商品广场 → 发布商品        （最高频，置顶）
 *   ② 交易闭环   订单中心 → 购物车 → 消息中心       （买卖必经，紧随其后）
 *   ③ 个人资产   个人主页 → 数据分析                （中等频次）
 *   ④ 系统设置   设置 → 关于 → 管理后台             （低频，沉底）
 * 这样高频入口始终在拇指/视线最容易触达的前 3 项，低频项不会抢占注意力。
 */

export interface MenuItem {
  path: string
  title: string
  icon: string
  /** 需要的权限：admin 仅管理员可见 */
  requireAdmin?: boolean
  /**
   * 需要的**职能角色**：双独立后台用 ——
   * 商品审核后台按 goods_admin 显示、举报处理后台按 report_admin 显示。
   * ★ 全能 admin 三层都能用：菜单对其放行全部职能入口（路由守卫与后端
   * 角色分区同样放行 admin），审核员则仍然只见到自己的分区。
   */
  requireRole?: string
  /**
   * **游客（未登录）也可见**。
   *
   * ★ 为什么菜单要单独有这一维，而不能从路由 meta 推导 ★
   * 菜单配置（本文件）与路由守卫（`router/index.ts` 的 meta）是**两处独立维护**的表，
   * 历史上已经漂移过（路由 `public: true` 而菜单漏改，或反过来）。
   * 这里显式声明，是为了让「游客能看哪几项」成为一个**一行就能读懂**的事实；
   * 判断它与路由是否一致，交给 `menuConfig.spec.ts` 的用例去守。
   *
   * ⚠️ 只有**纯浏览**页面才能标 `public`。凡是有「我的 / 写操作」语义的一律不标。
   */
  public?: boolean
}

/**
 * 侧边栏菜单全量配置。
 *
 * ★ 关于 `public` 标注的判据 ★
 *   `/goods`、`/goods/:id`、`/notice`、`/about` 是**只读浏览**页：
 *     后端对应接口（`GET /goods`、商品详情、`/notices`）在
 *     `AuthInterceptor.PUBLIC_GET` 白名单里，匿名可读 —— 前端不放开，
 *     后端那份白名单就是一段**永远走不到的死代码**。
 *   `/home`、`/user/:id` 等**不标**：
 *     · `/home` 依赖经营数据接口（后端仍要求登录，游客进去会满屏报错）；
 *     · `/user/:id` 虽然是公开主页，但它属于「从详情页点进去」的二级页，
 *       不进主导航 —— 见 `router/index.ts` 里的说明。
 *
 * ⚠️ 写本文件的注释时**不要写出"星号紧跟斜杠"的通配路径写法**（例如商品详情的通配形式）：
 *    那个两字符序列会**提前闭合块注释**，导致后面的代码被当成注释内容 ——
 *    表现为编译报一个完全不相关的语法错误。路径统一写成 `:id` 形式或中文描述。
 */
export const BASE_MENUS: MenuItem[] = [
  // ① 核心动线
  { path: '/home', title: '首页', icon: 'House' },
  { path: '/goods', title: '商品广场', icon: 'Box', public: true },
  { path: '/goods/publish', title: '发布商品', icon: 'EditPen' },
  // ② 交易闭环
  { path: '/order', title: '订单中心', icon: 'List' },
  { path: '/cart', title: '购物车', icon: 'ShoppingCart' },
  { path: '/message', title: '消息中心', icon: 'ChatDotRound' },
  // ③ 个人资产
  { path: '/user/profile', title: '个人主页', icon: 'UserFilled' },
  { path: '/favorites', title: '我的收藏', icon: 'Star' },
  { path: '/analytics', title: '数据分析', icon: 'TrendCharts' },
  // ④ 系统设置
  { path: '/settings', title: '设置', icon: 'Setting' },
  { path: '/notice', title: '平台公告', icon: 'BellFilled', public: true },
  { path: '/about', title: '关于', icon: 'InfoFilled', public: true },
  { path: '/admin', title: '管理后台', icon: 'Lock', requireAdmin: true },
  // ⑤ 双独立后台：各自专属、互不可见（requireRole 做职能级过滤）
  { path: '/review/goods', title: '商品审核后台', icon: 'Goods', requireRole: 'goods_admin' },
  { path: '/review/report', title: '举报处理后台', icon: 'Search', requireRole: 'report_admin' }
]

/**
 * 根据用户角色过滤菜单
 * @param isAdmin 是否全能管理员（requireAdmin 项；同时放行全部 requireRole 项）
 * @param role 当前用户角色（requireRole 项；审核员专属入口按它显隐）
 * @param isLoggedIn 是否已登录。★ 未登录时只保留 `public` 项
 */
export function filterMenus(isAdmin: boolean, role?: string, isLoggedIn = true): MenuItem[] {
  return BASE_MENUS.filter((m) => {
    // ★ 游客分支放在最前：未登录时连 requireAdmin/requireRole 都不必判
    if (!isLoggedIn) return m.public === true
    if (m.requireAdmin && !isAdmin) return false
    // 全能 admin 三层都能用：职能入口全部可见；审核员只见自己的分区
    if (m.requireRole && !isAdmin && m.requireRole !== role) return false
    return true
  })
}

