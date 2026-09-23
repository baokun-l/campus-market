/**
 * 路由配置
 */
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import NProgress from 'nprogress'
import 'nprogress/nprogress.css'
import { createAuthGuard } from '@/utils/permission'
import { useUserStore } from '@/stores/modules/user'

NProgress.configure({ showSpinner: false, trickleSpeed: 200 })

const routes: RouteRecordRaw[] = [
  // 公共认证页
  {
    path: '/login',
    component: () => import('@/views/auth/Login.vue'),
    meta: { public: true, title: '登录' }
  },
  {
    path: '/register',
    component: () => import('@/views/auth/Register.vue'),
    meta: { public: true, title: '注册' }
  },
  {
    path: '/403',
    component: () => import('@/views/NotFound.vue'),
    meta: { public: true, title: '无权限' }
  },

  // 主框架
  /*
   * ============================ 游客能力（对外部署必备） ============================
   *
   * ★ 本次改动的起因 ★
   * 后端 `AuthInterceptor.PUBLIC_GET` 早就放行了一批**只读浏览**接口
   *（商品列表与详情、分类、公告、商品的评论与评价、他人主页与评价、
   *  在线名单、上传的图片 —— 完整清单以 `AuthInterceptor` 为准），
   * 连注释都写了理由（商品图必须匿名可读否则整站裂图、在线名单不给游客看就是没意义）。
   * 但前端这里**17 条业务路由全部 `requireAuth: true`** ——
   * 结果是后端那份白名单成了**只能靠 curl 走通的死代码**，游客连商品都看不到。
   *
   * ⚠️ 本文件注释里**不要写出通配路径**（星号紧跟斜杠那种）：
   *    那个两字符序列会提前闭合块注释，后面的代码会被当成注释内容，
   *    编译时报一个完全不相关的语法错误。路径一律写成 `:id` 形式或中文描述。
   *
   * ★ 为什么"要部署到服务器"就必须放开 ★
   * 对外站点让访客一进门先注册，等于把最大的流量来源挡在门外；
   * 真实的二手平台（闲鱼/转转）都是游客可以直接逛的。
   *
   * ★ 放开范围（5 条）与判据 ★
   *   放开：`goods`（商品广场）、`goods/:id`（商品详情）、`notice`（平台公告）、
   *         `about`（关于项目）、`user/:id`（他人主页）
   *   不放开：
   *     · `home` —— 它依赖 `/analytics/**`，后端那条**仍要求登录**（实测 401）。
   *       一并放开会让游客进首页看到一堆报错，比不放还糟。
   *     · `user/profile` —— 是**自己的**个人中心，与 `user/:id`（他人主页）不是一回事。
   *     · 发布 / 购物车 / 收藏 / 订单 / 消息 / 设置 / 后台 —— 全是「我的」或写操作。
   *
   * ★ 为什么 `user/:id` 也放开（它不在主导航里） ★
   * 商品详情页上点了卖家头像要能进得去。若它仍需登录，游客在详情页点一下就被
   * 弹到登录页 —— 浏览动线**在这里断掉**，前面放开的 4 条也白放。
   * 后端 `GET /users/{id}/profile` 是白名单接口，且只返回
   * `id / nickname / avatar / creditScore / role / createTime`（白名单式取值，
   * 不含手机号、邮箱、用户名），放开不泄露任何东西。
   *
   * ★ 安全边界没有被这一步放松 ★
   * 白名单在 `AuthInterceptor` 里是**按「方法 + 路径」判定**的：
   * 放开的全部是 GET，写操作（发商品、下单、收藏、改资料…）依旧一律要登录。
   * 前端这里只是「把后端已经允许的事用出来」，不新增任何后端权限。
   */
  {
    path: '/',
    component: () => import('@/layouts/BasicLayout.vue'),
    /*
     * ★ 落地页从 /login 改成 /goods ★
     * 原来访问根路径直接跳登录页 —— 对游客来说"打开网站 = 登录页"，
     * 这与放开的初衷矛盾。改成商品广场：游客一进来就有东西可看。
     * 已登录用户访问根路径同样落在商品广场，这也符合二手平台的常规形态
     *（首页 `/home` 仍在菜单里，随时可点）。
     */
    redirect: '/goods',
    children: [
      { path: 'home', component: () => import('@/views/Home.vue'), meta: { title: '校园二手集市', icon: 'House', requireAuth: true } },
      {
        path: 'user/profile',
        component: () => import('@/views/user/Profile.vue'),
        meta: { title: '个人中心', icon: 'UserFilled', requireAuth: true }
      },
      {
        // 他人主页：详情页卖家 / 留言区 / 评价区点用户即可进入。
        // ★ public —— 游客也要能从商品详情点进卖家主页（理由见上方长注释）
        path: 'user/:id',
        component: () => import('@/views/user/PublicProfile.vue'),
        meta: { title: '用户主页', public: true }
      },
      {
        path: 'goods',
        component: () => import('@/views/goods/List.vue'),
        meta: { title: '商品广场', icon: 'Box', public: true }
      },
      {
        path: 'goods/publish',
        component: () => import('@/views/goods/Publish.vue'),
        meta: { title: '发布商品', requireAuth: true, icon: 'EditPen' }
      },
      {
        path: 'goods/:id',
        component: () => import('@/views/goods/Detail.vue'),
        meta: { title: '商品详情', icon: 'Box', public: true }
      },
      {
        path: 'message',
        component: () => import('@/views/message/Index.vue'),
        meta: { title: '消息中心', icon: 'ChatDotRound', requireAuth: true }
      },
      {
        path: 'settings',
        component: () => import('@/views/settings/Index.vue'),
        meta: { title: '设置', icon: 'Setting', requireAuth: true }
      },
      {
        path: 'cart',
        component: () => import('@/views/goods/Cart.vue'),
        meta: { title: '购物车', requireAuth: true, icon: 'ShoppingCart' }
      },
      {
        path: 'favorites',
        component: () => import('@/views/goods/Favorites.vue'),
        meta: { title: '我的收藏', requireAuth: true, icon: 'Star' }
      },
      {
        // ★ public —— 平台公告本来就是给所有人看的，也在后端白名单里
        path: 'notice',
        component: () => import('@/views/Notice.vue'),
        meta: { title: '平台公告', icon: 'BellFilled', public: true }
      },
      {
        path: 'order',
        component: () => import('@/views/order/Index.vue'),
        meta: { title: '订单中心', requireAuth: true, icon: 'List' }
      },
      {
        path: 'analytics',
        component: () => import('@/views/Analytics.vue'),
        meta: { title: '数据分析', requireAuth: true, icon: 'TrendCharts' }
      },
      {
        path: 'admin',
        component: () => import('@/views/admin/Index.vue'),
        meta: { title: '管理后台', requireAuth: true, requireAdmin: true, icon: 'Setting' }
      },
      /*
       * 双独立后台：职能互斥、权限互斥。
       * `meta.roles` 在 createAuthGuard 里做细粒度校验 ——
       * 普通用户 / 审核员互串对方后台统一 403，直接输 URL 也拦得住。
       * 商品审核后台对全能 admin 放行（roles 含 admin），便于演示排查；
       * 举报后台同理。两个页面**互不引用**，各自独立成页。
       */
      {
        path: 'review/goods',
        component: () => import('@/views/review/GoodsAudit.vue'),
        meta: {
          title: '商品审核后台',
          requireAuth: true,
          icon: 'Goods',
          roles: ['goods_admin', 'admin']
        }
      },
      {
        path: 'review/report',
        component: () => import('@/views/review/ReportAudit.vue'),
        meta: {
          title: '举报处理后台',
          requireAuth: true,
          icon: 'Search',
          roles: ['report_admin', 'admin']
        }
      },
      {
        // ★ public —— 纯静态介绍页，游客了解这个站是什么，是转化的一环
        path: 'about',
        component: () => import('@/views/About.vue'),
        meta: { title: '关于项目', icon: 'InfoFilled', public: true }
      }
    ]
  },
  {
    path: '/:pathMatch(.*)*',
    component: () => import('@/views/NotFound.vue'),
    meta: { public: true, title: '404' }
  }
]

export const router = createRouter({
  /*
   * ★ 历史模式的 base 必须跟着打包时的 base 走（部署适配清单 P2-3）★
   *
   * 原先写的是 createWebHistory()（等价于 base='/'）。它只在「站点挂在根域名」
   * 这一种情况下正确：一旦把产物挂到 https://host/market/，
   * Vite 产出的 index.html 会去请求 /market/assets/*.js（因为 base 变了），
   * 但路由仍然按根路径解析 URL —— 地址栏是 /market/goods，路由表里找不到 /market/goods，
   * 直接落进 404 兜底。**表现是「首页打得开、一点导航就 404」**，
   * 看起来像路由配错，实际是 base 与 history base 不一致。
   *
   * import.meta.env.BASE_URL 就是 Vite 注入的打包 base（默认 '/'），
   * 用它两边自动对齐：改 VITE_BASE 一处，产物路径与路由同时生效。
   */
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
  scrollBehavior: () => ({ top: 0 })
})

router.beforeEach(async (to, _from, next) => {
  NProgress.start()
  const guard = createAuthGuard()
  return guard(to, _from, next)
})

router.afterEach((to) => {
  if (to.meta?.title) document.title = `${to.meta.title} · 校园二手集市`
  NProgress.done()
})

// 已登录用户访问 /login 或 /register 时，直接送进首页（仅对登录态生效）
router.beforeEach((to, _from, next) => {
  const userStore = useUserStore()
  if (userStore.isLoggedIn && (to.path === '/login' || to.path === '/register')) {
    return next('/home')
  }
  next()
})
