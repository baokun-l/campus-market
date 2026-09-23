/**
 * 侧边栏菜单配置测试 —— 重点守「游客可见面」这一维
 *
 * ★ 为什么这个测试值得单独写 ★
 *
 * 1) **菜单与路由是两张独立维护的表**（`layouts/menuConfig.ts` 与 `router/index.ts`），
 *    它们历史上漂移过。漂移的两个方向都有害：
 *      · 菜单标了 public 而路由没标 → 游客看得见、点进去被弹登录页（能看不能点）；
 *      · 路由标了 public 而菜单没标 → 游客根本找不到入口，放开等于没放。
 *    这类"两边各写一份"的配置，靠人记是必然出错的，只能靠用例钉住。
 *
 * 2) **游客菜单必须是"能用的菜单"**。
 *    如果游客看到一整列点进去就跳登录的项，比什么都不显示更糟 ——
 *    用户会认为这个站坏了。所以未登录时只保留真正可访问的那几项。
 *
 * 3) **反向断言同样重要**：凡带"我的 / 写操作"语义的入口（发布、订单、购物车、
 *    收藏、消息、设置、后台），**绝不能**出现在游客菜单里。
 *    只断言"游客看得见商品广场"是不够的 —— 那只证明了一半。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { BASE_MENUS, filterMenus } from './menuConfig'

/** 从不含注释的源码里抽取 `public: true` 标注，避免把注释里提到的路径当成真配置 */
const ROUTER_SRC = readFileSync(resolve(__dirname, '../router/index.ts'), 'utf8')

describe('filterMenus —— 游客（未登录）可见面', () => {
  it('★ 未登录时只返回标了 public 的项', () => {
    const guestMenus = filterMenus(false, undefined, false)
    const allPublic = BASE_MENUS.filter((m) => m.public)

    expect(guestMenus.map((m) => m.path).sort()).toEqual(allPublic.map((m) => m.path).sort())
  })

  it('游客菜单非空 —— 否则"放开游客浏览"等于什么都没放', () => {
    const guestMenus = filterMenus(false, undefined, false)
    expect(guestMenus.length).toBeGreaterThan(0)
  })

  it('★ 商品广场必须在游客菜单里（这是游客最主要的入口）', () => {
    const guestMenus = filterMenus(false, undefined, false)
    expect(guestMenus.map((m) => m.path)).toContain('/goods')
  })

  it('★★ 反向断言：所有"我的 / 写操作"入口都不许给游客', () => {
    const guestPaths = filterMenus(false, undefined, false).map((m) => m.path)
    // 这份清单是「不该给游客」的最小充分集：每个都代表一类语义
    const mustNotAppear = [
      '/home',            // 依赖 /analytics/**，后端仍要求登录
      '/goods/publish',   // 写操作
      '/order',           // 我的订单
      '/cart',            // 我的购物车
      '/message',         // 我的消息
      '/user/profile',    // 我的个人中心
      '/favorites',       // 我的收藏
      '/analytics',       // 经营数据
      '/settings',        // 我的设置
      '/admin',           // 后台
      '/review/goods',    // 后台
      '/review/report'    // 后台
    ]
    for (const p of mustNotAppear) {
      expect(guestPaths, `${p} 不该出现在游客菜单里`).not.toContain(p)
    }
  })

  it('后台入口对游客不可见（连管理员入口也一样）', () => {
    const guestPaths = filterMenus(false, undefined, false).map((m) => m.path)
    expect(guestPaths.some((p) => p.startsWith('/admin') || p.startsWith('/review'))).toBe(false)
  })
})

describe('filterMenus —— 已登录时行为不变（本次改动的回归护栏）', () => {
  it('普通已登录用户能看到业务菜单，但看不到后台', () => {
    const paths = filterMenus(false, 'user', true).map((m) => m.path)
    expect(paths).toContain('/order')
    expect(paths).toContain('/cart')
    expect(paths).toContain('/favorites')
    expect(paths).not.toContain('/admin')
    expect(paths).not.toContain('/review/goods')
    expect(paths).not.toContain('/review/report')
  })

  it('admin 能看到全部菜单（含两个审核后台）', () => {
    const paths = filterMenus(true, 'admin', true).map((m) => m.path)
    expect(paths).toContain('/admin')
    expect(paths).toContain('/review/goods')
    expect(paths).toContain('/review/report')
    expect(paths.length).toBe(BASE_MENUS.length)
  })

  it('goods_admin 只看到自己的审核后台，看不到举报后台', () => {
    const paths = filterMenus(false, 'goods_admin', true).map((m) => m.path)
    expect(paths).toContain('/review/goods')
    expect(paths).not.toContain('/review/report')
  })

  it('★ isLoggedIn 默认值为 true —— 不传第三参时行为与改动前完全一致', () => {
    // 这条防的是「调用方漏传第三参导致已登录用户菜单突然少一半」
    expect(filterMenus(false, 'user').map((m) => m.path).sort())
      .toEqual(filterMenus(false, 'user', true).map((m) => m.path).sort())
  })
})

describe('★★ 菜单 public 与路由 public 必须一致（防两张表各自漂移）', () => {
  /**
   * 从 router/index.ts 源码里抽出标了 `public: true` 的路由路径。
   *
   * ★ 为什么用「逐行状态机」而不是跨行正则 ★
   * 第一版写的是 `path: 'xxx'[\s\S]{0,400}?meta: {[\s\S]{0,300}?public: true`。
   * 它在真机上**报了两个假告警**：把 `/home`（明明是 `requireAuth: true`）
   * 判成了 public —— 因为 `[\s\S]{0,400}` 会一路穿透到**后面某个路由**的
   * `public: true` 上去。这正是"模糊正则做跨行匹配"的经典翻车方式：
   * 它不报错，只是悄悄给出错误结论。
   *
   * 逐行状态机没有这个问题：`public` 只会归给**它上面最近的那个 `path`**，
   * 而本文件里每个路由都是 `path` 在前、`meta` 紧随其后，这个假设是稳的。
   */
  function publicRoutePaths(): string[] {
    const out: string[] = []
    let currentPath: string | null = null
    for (const raw of ROUTER_SRC.split(/\r?\n/)) {
      const line = raw.trim()
      // 注释行整体跳过 —— 否则注释里举的例子会被当成真配置
      if (line.startsWith('*') || line.startsWith('/*') || line.startsWith('//')) continue

      const p = line.match(/^path:\s*'([^']+)'/)
      if (p) {
        currentPath = p[1]
        // 一行里同时写了 path 和 public 的情况（如 /login）
        if (/public:\s*true/.test(line) && currentPath) out.push(norm(currentPath))
        continue
      }
      if (/public:\s*true/.test(line) && currentPath) out.push(norm(currentPath))
    }
    // 子路由是相对路径，统一补上前导斜杠；顶层已是绝对路径则原样
    function norm(p: string) {
      return p.startsWith('/') ? p : '/' + p
    }
    return out
  }

  it('解析器本身要能拿到东西（否则下面的断言会"空跑通过"）', () => {
    const paths = publicRoutePaths()
    // 至少要解析出登录/注册这类确定公开的页 —— 若这条挂了说明正则失效了，
    // 那么下面的一致性断言就成了永远为真的假断言
    expect(paths).toContain('/login')
    expect(paths).toContain('/register')
    expect(paths.length).toBeGreaterThanOrEqual(5)
  })

  it('每个标了 public 的菜单项，其路由也必须是 public', () => {
    const routePublic = publicRoutePaths()
    for (const m of BASE_MENUS.filter((x) => x.public)) {
      expect(routePublic, `菜单 ${m.path} 标了 public，但路由 meta 不是 public —— 游客看得见却进不去`)
        .toContain(m.path)
    }
  })

  it('★ 反向：路由放开的 5 个业务页都要有对应说法（要么进菜单，要么有明确理由不进）', () => {
    const menuPublic = BASE_MENUS.filter((m) => m.public).map((m) => m.path)
    /*
     * 路由 public 但**不进菜单**的页，必须在这份白名单里有登记 + 理由。
     * 这条断言的意义：每放开一个页面，都必须回答「游客怎么找到它 / 或为什么不需要入口」。
     * 不登记就报错 —— 逼着人给出说法，避免"放开了但没人知道"。
     */
    const allowedNotInMenu: Record<string, string> = {
      '/user/:id':
        '他人主页：详情页点卖家头像进入的二级页，没有 id 就不成立，放进主导航无意义',
      '/goods/:id':
        '商品详情：同上，必须有具体商品 id；入口就是商品广场里点任意一张卡片'
    }
    const routePublic = publicRoutePaths().filter((p) => !p.startsWith('/v3') && !p.startsWith('/swagger'))
    for (const p of routePublic) {
      // 只关心业务页（排除认证页与错误页）
      if (['/login', '/register', '/403'].includes(p)) continue
      if (p.startsWith('/:pathMatch')) continue // 404 通配
      const inMenu = menuPublic.includes(p)
      const excused = Object.prototype.hasOwnProperty.call(allowedNotInMenu, p)
      expect(inMenu || excused,
        `路由 ${p} 已放开给游客，但既不在菜单里也没有登记理由 —— 请补进菜单或加进 allowedNotInMenu`)
        .toBe(true)
    }
  })
})
