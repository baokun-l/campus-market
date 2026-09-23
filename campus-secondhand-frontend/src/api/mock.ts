/**
 * 模拟数据层 - 离线 mock
 * 当 .env 中 VITE_USE_MOCK=true 时启用
 */
import type { Goods, User, Category, Order, OrderLog, LogisticsTrace, Notice, Address, Favorite, HistoryItem, ChatSession, Message as ChatMessage, PageResult, GoodsComment, Review, Report, FundSource } from '@/types'
import { settlePrice, promoPriceFor } from '@/utils/promo'

const USE_MOCK = import.meta.env.VITE_USE_MOCK === 'true'

/* ============ 假数据：用户 ============ */
const avatarOf = (seed: string) => `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(seed)}`

/**
 * 演示用户表。
 * ⚠️ 前 4 位是「有完整业务数据」的账号（商品/订单/会话都挂在它们身上），
 *    顺序不要调整；新增一律往后追加，否则会打乱既有测试与演示数据。
 */
const mockUsers: User[] = [
  { id: 1, username: 'cs_xiao_zhang', nickname: '计算机小张', avatar: 'https://api.dicebear.com/7.x/initials/svg?seed=cs', creditScore: 98, status: 'active', role: 'user', createTime: '2026-08-15T10:23:00' },
  { id: 2, username: 'book_li', nickname: '旧书摊李同学', avatar: 'https://api.dicebear.com/7.x/initials/svg?seed=book', creditScore: 100, status: 'active', role: 'user', createTime: '2026-08-10T08:00:00' },
  { id: 3, username: 'digital_wang', nickname: '数码王同学', avatar: 'https://api.dicebear.com/7.x/initials/svg?seed=wang', creditScore: 95, status: 'active', role: 'user', createTime: '2026-07-22T15:30:00' },
  { id: 4, username: 'sport_chen', nickname: '运动陈同学', avatar: 'https://api.dicebear.com/7.x/initials/svg?seed=chen', creditScore: 88, status: 'active', role: 'user', createTime: '2026-06-18T09:12:00' },
  // —— 以下为后台「用户管理」页签的演示数据（含低信誉 / 已封禁各一；用户待审核态已随 D11 拆除） ——
  { id: 5, username: 'art_sun', nickname: '画材孙同学', avatar: avatarOf('sun'), creditScore: 92, status: 'active', role: 'user', createTime: '2026-06-02T14:05:00' },
  { id: 6, username: 'home_zhao', nickname: '宿舍赵同学', avatar: avatarOf('zhao'), creditScore: 76, status: 'active', role: 'user', createTime: '2026-05-21T11:40:00' },
  { id: 7, username: 'bike_zhou', nickname: '代步周同学', avatar: avatarOf('zhou'), creditScore: 54, status: 'active', role: 'user', createTime: '2026-05-09T16:22:00' },
  { id: 8, username: 'cloth_wu', nickname: '服饰吴同学', avatar: avatarOf('wu'), creditScore: 34, status: 'banned', role: 'user', createTime: '2026-04-27T10:08:00' },
  { id: 9, username: 'new_zheng', nickname: '郑同学', avatar: avatarOf('zheng'), creditScore: 100, status: 'active', role: 'user', createTime: '2026-04-15T20:31:00' },
  { id: 10, username: 'lab_qian', nickname: '实验室钱同学', avatar: avatarOf('qian'), creditScore: 97, status: 'active', role: 'user', createTime: '2026-03-30T09:55:00' },
  { id: 11, username: 'music_sun2', nickname: '吉他孙同学', avatar: avatarOf('sun2'), creditScore: 85, status: 'active', role: 'user', createTime: '2026-03-12T13:17:00' },
  { id: 12, username: 'dict_yang', nickname: '工具书杨同学', avatar: avatarOf('yang'), creditScore: 90, status: 'active', role: 'user', createTime: '2026-02-26T08:44:00' },
  /*
   * —— 第二梯队：纯「用户管理」测试数据（id 13 起） ——
   *
   * 这批人不携带商品/订单，专门用来把手里的管理功能测全：
   *   · 正常 / 已封禁各来两位以上 → 「全部 / 正常 / 已封禁」筛选项都有内容
   *     （用户待审核态已随 D11 拆除，原 pending 账号转 active，id 保持不变）；
   *   · 信用分刻意铺开：100（满值上限）、90 档、60 档、30 档、
   *     以及 12 这种「已经贴在封禁线上」的极端值 —— 后台「调整信用分」填目标值时，
   *     往上加会撞 100 上限、往下减会跌破 0，两个边界都能试到；
   *   · 注册时间从 2026-02 铺到 2026-05，按时间排序能看出层次。
   *
   * ⚠️ 只往后追加。它们的 id 被 `probe-ban.cjs` 等探针引用，
   *    改 id 会让「闸门」那几条断言直接失效。
   */
  { id: 13, username: 'photo_lv', nickname: '摄影吕同学', avatar: avatarOf('lv'), creditScore: 99, status: 'active', role: 'user', createTime: '2026-05-16T09:20:00' },
  { id: 14, username: 'game_han', nickname: '电竞韩同学', avatar: avatarOf('han'), creditScore: 63, status: 'active', role: 'user', createTime: '2026-05-12T21:05:00' },
  { id: 15, username: 'tea_wei', nickname: '茶饮魏同学', avatar: avatarOf('wei'), creditScore: 100, status: 'active', role: 'user', createTime: '2026-05-06T12:48:00' },
  { id: 16, username: 'band_ma', nickname: '乐队马同学', avatar: avatarOf('ma'), creditScore: 46, status: 'active', role: 'user', createTime: '2026-04-28T18:32:00' },
  { id: 17, username: 'dorm_tang', nickname: '合租唐同学', avatar: avatarOf('tang'), creditScore: 28, status: 'banned', role: 'user', createTime: '2026-04-22T15:11:00' },
  { id: 18, username: 'fresh_feng', nickname: '冯同学', avatar: avatarOf('feng'), creditScore: 100, status: 'active', role: 'user', createTime: '2026-04-16T10:02:00' },
  { id: 19, username: 'lab_xu', nickname: '实验许同学', avatar: avatarOf('xu'), creditScore: 91, status: 'active', role: 'user', createTime: '2026-04-08T14:26:00' },
  { id: 20, username: 'ball_he', nickname: '篮球何同学', avatar: avatarOf('he'), creditScore: 74, status: 'active', role: 'user', createTime: '2026-03-31T19:40:00' },
  { id: 21, username: 'art_luo', nickname: '素描罗同学', avatar: avatarOf('luo'), creditScore: 87, status: 'active', role: 'user', createTime: '2026-03-25T11:33:00' },
  { id: 22, username: 'book_gao', nickname: '考研高同学', avatar: avatarOf('gao'), creditScore: 96, status: 'active', role: 'user', createTime: '2026-03-18T07:58:00' },
  { id: 23, username: 'elec_song', nickname: '电子宋同学', avatar: avatarOf('song'), creditScore: 59, status: 'active', role: 'user', createTime: '2026-03-04T16:07:00' },
  { id: 24, username: 'tent_duan', nickname: '户外段同学', avatar: avatarOf('duan'), creditScore: 12, status: 'banned', role: 'user', createTime: '2026-02-18T13:44:00' },
  /*
   * 97 / 98：两个职能单一的审核员（商品审核员 / 举报审核员）。
   * 与 admin（全能）不同，他们只能进入各自的后台 —— 双独立后台演示用。
   * 放在 SEED_USER_POOL（前 12 位）之外，不扰动任何已生成的业务数据；
   * id 用 97/98 复用 token 正则 mock-token-(?:user|register)-(\d+)，session 层零改动。
   */
  { id: 97, username: 'goods_admin', nickname: '商品审核员', avatar: avatarOf('ga'), creditScore: 100, status: 'active', role: 'goods_admin', createTime: '2026-01-02T09:00:00' },
  { id: 98, username: 'report_admin', nickname: '举报审核员', avatar: avatarOf('ra'), creditScore: 100, status: 'active', role: 'report_admin', createTime: '2026-01-02T09:05:00' },
  { id: 99, username: 'admin', nickname: '管理员', avatar: 'https://api.dicebear.com/7.x/initials/svg?seed=admin', creditScore: 100, status: 'active', role: 'admin', createTime: '2026-01-01T00:00:00' }
]

/**
 * 生成商品 / 订单时使用的**固定卖家池**：只取前 12 位。
 *
 * 为什么不能让生成逻辑直接用 `mockUsers`：
 * 商品的卖家是 `mockUsers[rand(0, mockUsers.length - 2)]` 算出来的。
 * 一旦往表里追加用户，`length` 变了 → 同一个随机数会落到**另一个人**身上，
 * 60 件商品的卖家、20 笔订单的买卖双方全体位移 ——
 * 既有的截图、演示脚本和断言会莫名其妙地红，而改动其实"只是加了几个测试账号"。
 *
 * 所以把生成用的池子钉死在前 12 位。追加用户只影响「用户管理」列表，
 * 不动任何已生成业务数据。
 */
const SEED_USER_POOL = mockUsers.slice(0, 12)

/**
 * 可登录的演示账号（用户名 → 用于测试「对方视角」）。
 *
 * 后一项是**故意放进去的反例**：已封禁一个，
 * 点一下就能亲手验证「封禁账号登不进来」，不用去用户表里翻账号名。
 * （原「待审核」反例已随 D11 拆除：注册即 active，无需审核。）
 */
export const demoAccounts = [
  { username: 'cs_xiao_zhang', nickname: '计算机小张', role: '普通用户' },
  { username: 'book_li', nickname: '旧书摊李同学', role: '普通用户（可收到小张的消息）' },
  { username: 'digital_wang', nickname: '数码王同学', role: '普通用户' },
  { username: 'new_zheng', nickname: '郑同学', role: '普通用户' },
  { username: 'cloth_wu', nickname: '服饰吴同学', role: '已封禁 · 登录会被拒绝' },
  { username: 'admin', nickname: '管理员', role: '管理员（密码 admin123）' },
  { username: 'goods_admin', nickname: '商品审核员', role: '商品审核后台（密码 goods123456）' },
  { username: 'report_admin', nickname: '举报审核员', role: '举报处理后台（密码 report123456）' }
]

/* ============ 假数据：分类 ============ */
export const mockCategories: Category[] = [
  { id: 1, name: '教材', icon: '📚' },
  { id: 2, name: '数码', icon: '🎮' },
  { id: 3, name: '代步', icon: '🚲' },
  { id: 4, name: '服饰', icon: '👕' },
  { id: 5, name: '生活', icon: '🪑' },
  { id: 6, name: '运动', icon: '🏀' },
  { id: 7, name: '家电', icon: '🍳' },
  { id: 8, name: '艺术', icon: '🎨' },
  /*
   * 「其他」：兜底分类。
   * 没有它，卖家发布时遇到不匹配的品类只能硬塞进某个分类（把吉他塞进「艺术」、
   * 把充电宝塞进「数码」），统计口径随之失真。
   * 另外运营看板的分类占比饼图（mockCategoryPie）本来就有「其他」这一项，
   * 分类列表里却没有它 —— 补上之后两边才对得上。
   */
  { id: 9, name: '其他', icon: '📦' }
]

/** 可变缓存：管理后台新增/改名/删除分类后，各处读到的是同一份数据 */
export const mockCategoriesCache = {
  get: () => mockCategories,
  set: (list: Category[]) => {
    mockCategories.splice(0, mockCategories.length, ...list)
  }
}

/** 分类下的在售商品数（分类管理列表展示用） */
export function countGoodsByCategory(categoryId: number): number {
  return _goodsCache.filter((g) => g.categoryId === categoryId).length
}

const m = ['九成新', '全新', '七成新', '八成新', '五成新']
const LOCATIONS = ['计算机学院', '电子学院', '经管学院', '人文学院', '图书馆', '宿舍区', '主教学楼']

/* ============ 确定性随机 ============
 * 旧实现直接用 Math.random()，导致每次刷新商品价格、卖家、描述都在变，
 * 界面无法复现、也不利于截图与回归测试。
 * 这里换成固定种子的 mulberry32 PRNG —— 数据每次加载完全一致。 */
function mulberry32(seedNum: number): () => number {
  let a = seedNum
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rng = mulberry32(20260910)

function rand(min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min
}

/* ============ 商品照片：卖家实拍图（本地静态资源） ============
 * 图片放在 public/goods/ 下（cat{分类}-{1..3}.jpg），按分类组织的真实商品照片。
 * 约定：
 *  ① 商品有「卖家提供的图片」→ 用实拍图（本地文件，零外链、离线可用）；
 *  ② 兜底：图片缺失时 img 的 @error 回退到 makeCover() 生成的柔和渐变占位图，
 *     保证任何情况下都不会出现裂图/灰块。
 * 来源：Unsplash 免费图库（下载后本地化，非热链）。
 */
const GOODS_PHOTOS: Record<number, string[]> = {
  1: ['/goods/cat1-1.jpg', '/goods/cat1-2.jpg', '/goods/cat1-3.jpg'], // 教材
  2: ['/goods/cat2-1.jpg', '/goods/cat2-2.jpg', '/goods/cat2-3.jpg'], // 数码
  3: ['/goods/cat3-1.jpg', '/goods/cat3-2.jpg', '/goods/cat3-3.jpg'], // 代步
  4: ['/goods/cat4-1.jpg', '/goods/cat4-2.jpg', '/goods/cat4-3.jpg'], // 服饰
  5: ['/goods/cat5-1.jpg', '/goods/cat5-2.jpg', '/goods/cat5-3.jpg'], // 生活
  6: ['/goods/cat6-1.jpg', '/goods/cat6-2.jpg', '/goods/cat6-3.jpg'], // 运动
  7: ['/goods/cat7-1.jpg', '/goods/cat7-2.jpg', '/goods/cat7-3.jpg'], // 家电
  8: ['/goods/cat8-1.jpg', '/goods/cat8-2.jpg', '/goods/cat8-3.jpg'] // 艺术
}

/** 取某分类的第 n 张实拍图（n 从 0 开始；越界时循环取用） */
export function goodsPhoto(categoryId: number, n = 0): string {
  const pool = GOODS_PHOTOS[categoryId] ?? GOODS_PHOTOS[1]
  return pool[n % pool.length]
}

/* ============ 封面：本地生成的柔和色块（对齐参考图 6.3/6.4） ============
 * 旧实现用 https://picsum.photos 外链随机图：
 *   ① 离线/弱网时必然裂图，卡片出现灰块；
 *   ② 每张图风格随机，与页面配色毫无关系，是"视觉割裂"的主要来源。
 * 现改为按分类派生的柔和渐变 + 分类图标（内联 SVG data-URI）：
 *   ① 零网络请求，秒出图、永不裂；
 *   ② 色板与页面统一，同类商品视觉成组。 */
const COVER_PALETTE: Record<number, [string, string, string]> = {
  1: ['#e8f1ff', '#c9dcff', '#a9c6fb'], // 教材 · 蓝
  2: ['#f1ecff', '#ddd2ff', '#c4b2fb', ], // 数码 · 紫
  3: ['#e6fbff', '#c4f2fb', '#9fe6f5'], // 代步 · 青
  4: ['#ffecf5', '#ffd3e6', '#ffb8d6'], // 服饰 · 粉
  5: ['#fff6e0', '#ffe8b8', '#ffd98e'], // 生活 · 琥珀
  6: ['#e9fbe9', '#c8f2ce', '#a4e7b1'], // 运动 · 绿
  7: ['#e2fbf4', '#bdf2e4', '#93e6d3'], // 家电 · 薄荷
  8: ['#fff0e2', '#ffdcbb', '#ffc593'] // 艺术 · 橙
}

export function makeCover(categoryId: number, index: number, big = false): string {
  const palette = COVER_PALETTE[categoryId] ?? COVER_PALETTE[1]
  const icon = mockCategories.find((c) => c.id === categoryId)?.icon ?? '📦'
  const w = big ? 800 : 400
  const h = big ? 600 : 400
  // 每个商品角标位置做微小差异，避免 60 张卡片看起来是同一张图
  const cx = 26 + ((index * 17) % 48)
  const cy = 24 + ((index * 11) % 52)
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<defs>` +
    `<linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${palette[0]}"/>` +
    `<stop offset="0.55" stop-color="${palette[1]}"/>` +
    `<stop offset="1" stop-color="${palette[2]}"/>` +
    `</linearGradient>` +
    `<radialGradient id="s" cx="${cx}%" cy="${cy}%" r="60%">` +
    `<stop offset="0" stop-color="#ffffff" stop-opacity="0.75"/>` +
    `<stop offset="1" stop-color="#ffffff" stop-opacity="0"/>` +
    `</radialGradient>` +
    `</defs>` +
    `<rect width="${w}" height="${h}" fill="url(#g)"/>` +
    `<rect width="${w}" height="${h}" fill="url(#s)"/>` +
    `<text x="50%" y="50%" dy="${big ? 42 : 26}" font-size="${big ? 120 : 78}" ` +
    `text-anchor="middle" dominant-baseline="middle" opacity="0.5">${icon}</text>` +
    `</svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/* ============ 假数据：商品（随机生成 200 个） ============ */
const titlePool: Record<number, string[]> = {
  1: ['高等数学(同济第七版)九成新', '线性代数教材 含课后答案', '现代大学英语 综合 1', '计算机网络 第七版 自用', '马原毛概复习资料'],
  2: ['iPad Air 5 64G 几乎全新', '罗技 MX Master 3 鼠标', '小米手环 8 原装腕带', 'Kindle paperwhite4', 'Switch 游戏机 OLED'],
  3: ['校园代步自行车 九成新', '电动滑板车 一年使用', '宿舍折叠桌'],
  4: ['Nike Air Force 1 黑白 42码', '优衣库摇粒绒外套', '学院风针织衫'],
  5: ['宿舍小冰箱 80L', '电热水壶 学生党', '床头阅读灯', '体重秤'],
  6: ['Wilson 网球拍', '李宁运动水壶', '跳绳 计数款'],
  7: ['电饭煲 三人份', '吹风机 负离子', '空气加湿器'],
  8: ['水彩画笔套装', '油画棒 50色', '二手吉他 入门款']
}

/* ============ 活动让利价（模拟「卖家报名活动」的商品池） ============
 * 二手平台的商品定价权在卖家（`sellerId`），平台无权单方改价，
 * 所以这里的让利价一律理解为「卖家自愿让利」或「平台补贴」的结果：
 *
 *   `Goods.price`      = 卖家挂牌价（真实价格，划线价的唯一来源）
 *   `Goods.promoPrice` = 让利后的活动价；只有报名参加活动的商品才有
 *
 * 实现上有两点刻意为之：
 *   ① 用**确定性规则**（按 id 取模）生成，不额外消耗 `rng()` ——
 *      否则商品标题/价格/分类等既有随机数据会整体位移，导致截图与断言全部失效；
 *   ② 每个参与分类至少保证一件商品落在「最低档」，
 *      这样活动文案声称的「N 折起」一定能在商品数据里找到实例（见 `promo.spec.ts`）。
 */
const PROMO_RATES: Record<number, { source: FundSource; activityId: string; rates: number[] }> = {
  // 教材 → 开学季特卖（卖家让利，最低 5 折）
  1: { source: 'seller', activityId: 'back-to-school-2026-fall', rates: [0.5, 0.55, 0.6, 0.75] },
  // 数码 → 数码焕新周（平台补贴，最低 8 折）
  2: { source: 'platform', activityId: 'digital-refresh-week', rates: [0.8, 0.85, 0.9] },
  // 生活（宿舍电器）→ 开学季特卖（卖家让利，最低 8 折）
  5: { source: 'seller', activityId: 'back-to-school-2026-fall', rates: [0.8, 0.85, 0.9] }
}

/** 某分类商品的让利承担方（该分类不参与任何活动时为 undefined） */
export function promoFundSourceOf(categoryId: number): FundSource | undefined {
  return PROMO_RATES[categoryId]?.source
}

/** 某分类商品参与的活动 id */
export function promoActivityIdOf(categoryId: number): string | undefined {
  return PROMO_RATES[categoryId]?.activityId
}

/** 为商品列表生成让利价（原地修改；在 buildGoodsList 末尾调用）
 *
 * 让利价**必须**走 `promoPriceFor()`（`utils/promo.ts`）—— 卖家报名活动时用的是同一个函数，
 * 否则「seed 生成」与「报名生成」会算出差一分的价。
 */
function applyPromoPricing(list: Goods[]): void {
  for (const g of list) {
    const cfg = PROMO_RATES[g.categoryId]
    // 同一分类里也留一部分商品不参与 —— 卖家自愿报名，不是全场打折
    if (!cfg || g.id % 3 === 0) continue
    g.promoPrice = promoPriceFor(g.price, cfg.rates[g.id % cfg.rates.length])
    /*
     * 让利价必须能**追溯到它报名的那条活动**。
     * 一个分类可能同时挂着多条活动（如生活用品既有卖家让利的开学季、又有平台补贴的
     * 宿舍焕新），所以结算时不能只认分类反查 —— 那只能给出优先级最高的那一条，
     * 未必是这件商品真正报名的那条。带上 activityId 后资金归属才有唯一答案。
     */
    g.activityId = cfg.activityId
  }
  // 兜底：每个参与分类必有一件商品用完「最低档」，让活动文案的折扣声明可被验证
  for (const categoryId of Object.keys(PROMO_RATES).map(Number)) {
    const { rates, activityId } = PROMO_RATES[categoryId]
    const lowest = rates[0]
    for (const g of list) {
      if (g.categoryId !== categoryId) continue
      const candidate = promoPriceFor(g.price, lowest)
      /* `g.price * lowest >= 1` 等价于旧写法 `Math.floor(g.price * lowest) >= 1`
         （对非负数而言 floor(x) ≥ 1 ⟺ x ≥ 1），即「让利后不足 1 元的商品不构成有效让利，
         换下一件」。保留这个判定，保证与重构前的行为完全一致。 */
      if (g.price * lowest >= 1 && candidate < g.price) {
        g.promoPrice = candidate
        g.activityId = activityId
        break
      }
    }
  }
}

function buildGoodsList(): Goods[] {
  const list: Goods[] = []
  for (let i = 1; i <= 60; i++) {
    const categoryId = rand(1, 8)
    const titlePoolOfCat = titlePool[categoryId]
    const title = titlePoolOfCat[rand(0, titlePoolOfCat.length - 1)]
    const price = rand(10, 4000)
    // 卖家取自固定池（见 SEED_USER_POOL），加测试用户不会让 60 件商品集体换人
    const seller = SEED_USER_POOL[rand(0, SEED_USER_POOL.length - 1)]
    list.push({
      id: i,
      title: title + ' ' + m[rand(0, m.length - 1)],
      // 卖家挂牌价：平台记录在案的真实价格，划线价只认它，不再有「虚构原价」
      price,
      // 卖家实拍图：封面取该分类照片池的第 i 张，图集为 3 张轮转
      cover: goodsPhoto(categoryId, i),
      images: [0, 1, 2].map((k) => goodsPhoto(categoryId, i + k)),
      description: '商品描述：' + title + '，自用无损坏，有意者私聊，' + (rng() > 0.5 ? '支持面交' : '支持包邮') + '。',
      status: ['on_sale', 'on_sale', 'on_sale', 'sold', 'pending'][rand(0, 4)] as Goods['status'],
      categoryId,
      categoryName: mockCategories.find((c) => c.id === categoryId)!.name,
      sellerId: seller.id,
      sellerName: seller.nickname,
      sellerAvatar: seller.avatar,
      location: LOCATIONS[rand(0, LOCATIONS.length - 1)],
      // 数量与交易方式按商品 id 稳定派生，**不额外调用 rand()**：
      // 多消耗一个随机数会让后续所有商品的价格/封面/浏览整体漂移，
      // 使既有截图与快照全部变化。多数商品按单件闲置（1 件）处理，少数多件。
      stock: [1, 1, 2, 1, 3, 1, 1, 5][i % 8],
      deliveryMethod: (['face', 'face', 'express', 'self', 'face'] as Goods['deliveryMethod'][])[i % 5],
      viewCount: rand(0, 4000),
      favoriteCount: rand(0, 200),
      createTime: dayjsRandomRecent()
    })
  }
  // 让利价在列表生成后统一打 —— 需要看到全量商品才能保证「最低档」有实例
  applyPromoPricing(list)
  return list
}

function dayjsRandomRecent(): string {
  const ts = Date.now() - rand(0, 30) * 86400_000 - rand(0, 86400) * 1000
  return new Date(ts).toISOString()
}

let _goodsCache: Goods[] = buildGoodsList()

/* ============ 假数据：我的商品（统一用 sellerId=1 作为当前用户发布的商品） ============ */
function buildMyGoodsList(): Goods[] {
  // 复制前 8 件并把 sellerId 改成 1（当前用户），混合各种状态
  return _goodsCache.slice(0, 8).map((g, i) => ({
    ...g,
    id: 9000 + i,
    sellerId: 1,
    sellerName: '我',
    sellerAvatar: 'https://api.dicebear.com/7.x/initials/svg?seed=me',
    status: (['on_sale', 'on_sale', 'pending', 'sold', 'off_shelf', 'on_sale'] as Goods['status'][])[i] || 'on_sale'
  }))
}
let _myGoodsCache: Goods[] = buildMyGoodsList()

/* ============ 假数据：订单 ============
 * 每笔订单都落一份**价格快照**（挂牌价 / 卖家让利 / 平台补贴 / 卖家应收）。
 * 没有快照，卖家对账时平台拿不出「你当时同意让利多少」的证据，纠纷无法自证；
 * 后台的成交额也无法按「买家实付 / 卖家实收 / 平台补贴」拆口径。
 */

/*
 * 订单状态编排（20 单）。
 *
 * 关键约束：**前 8 单必须是「已收货 / 已完成」**，因为种子评价正挂在这 8 单上 ——
 * 一条评价能存在的前提就是货已经到买家手里。早期版本让状态按 i % 5 轮转，
 * 于是评价落到了「已发货 / 待发货」的订单上，用户一点「确认收货」，
 * 订单变 completed，`hasReviewed()` 立刻命中那条本不该存在的评价，
 * 页面就显示出「已评价」。修数据而不是修显示，才能从根上消失。
 * 由 order.spec.ts 的「评价与其订单状态一致性」用例锁死。
 */
const ORDER_STATUS_PLAN: Order['status'][] = [
  'completed',
  'completed',
  'received',
  'completed',
  'received',
  'completed',
  'completed',
  'received',
  // ↓ 以下为「进行中」的订单，供前台推进流程、后台改状态使用
  'shipped',
  'pending_ship',
  'pending_payment',
  'shipped',
  'pending_ship',
  'shipped',
  'pending_payment',
  'pending_ship',
  'shipped',
  'pending_payment',
  'pending_ship',
  'shipped',
  /*
   * ↓ 最后三单是「售后」：两笔退款中 + 一笔超时关闭。
   *
   * 为什么必须补这三个：`refunding` / `cancelled` 是状态机里的一等公民，
   * 但原来种子里一笔都没有 —— 后台的「售后处理」「已取消」筛选永远空白，
   * 退款审批弹窗、退款金额与原因、取消原因这些功能根本没有可测的入口。
   * 追加在末尾不会影响前 8 单（评价数据挂在那 8 单上）。
   */
  'refunding',
  'refunding',
  'cancelled'
]

/**
 * 售后的原因 / 发起方 / 处理备注（与上面后 3 单按顺序一一对应）。
 *
 * 两条退款单刻意一个由买家申请、一个由平台介入，覆盖「谁批的」两种口径；
 * 关闭的那单走「超时未付款」，是主流电商最常见的自动关闭场景。
 */
const AFTER_SALE_PLAN: Array<{ reason: string; by: 'buyer' | 'admin'; remark?: string }> = [
  { reason: '商品与描述不符', by: 'buyer', remark: '买家上传实拍图，成色与详情页描述不一致' },
  { reason: '买家申请七天无理由退货', by: 'admin', remark: '平台审核通过，代买家发起退款' },
  { reason: '超时未付款，系统自动关闭', by: 'admin' }
]

/** 售后单的申请/关闭时间：从最后一个已发生的节点往后推，并夹到「不晚于现在」 */
function afterSaleTime(tl: Pick<Order, 'createTime' | 'payTime' | 'shipTime'>, gapH: number): string {
  const anchor = Date.parse(tl.shipTime ?? tl.payTime ?? tl.createTime)
  return new Date(Math.min(anchor + gapH * 3600_000, Date.now() - 3600_000)).toISOString()
}

/**
 * 生命周期**间隔**（小时）：相邻两站之间隔多久。
 *
 * ⚠️ 是间隔不是绝对偏移 —— 这两个含义差之毫厘谬以千里：
 *   原实现用 `base + ORDER_LIFECYCLE_H[k]` 当作落到时间轴上的绝对偏移，
 *   但算「整条链一共多长」（spanH）时却是把它们**累加**的。
 *   前三个值（1 / 12 / 48）恰好单调递增，掩盖了这个矛盾；
 *   第十九轮加了第四个值 6（收货 → 完成之间的间隔）之后，
 *   `完成` 被算成「下单后 6 小时」，反而早于「下单后 48 小时」的收货 ——
 *   同一笔订单的完成时间比收货时间早 42 小时，日志与进度条直接倒挂。
 *   现在统一成间隔语义，赋值与 spanH 用同一套累加逻辑。
 */
const ORDER_LIFECYCLE_H = [1, 12, 48, 6] as const

/**
 * 按状态生成一条单调的订单时间线：下单 ≤ 支付 ≤ 发货 ≤ 收货 ≤ 完成，且都落在过去。
 *
 * 锚点取随机下单时间；若锚点离现在太近、放不下整条生命周期链，就把整条链前推，
 * 保证不会出现「收货时间在未来」这种穿帮。
 */
function buildOrderTimeline(
  status: Order['status'],
  rawCreate: string
): Pick<Order, 'createTime' | 'payTime' | 'shipTime' | 'receiveTime' | 'completeTime'> {
  const need: [boolean, boolean, boolean, boolean] = [
    // 未付款必然没付款；已取消的那单是「超时未付款关闭」，同样没有付款时间
    status !== 'pending_payment' && status !== 'cancelled',
    // 退款中的两单都是「已发货后申请退款」，所以带发货时间；已取消的没有
    status === 'shipped' || status === 'received' || status === 'completed' || status === 'refunding',
    status === 'received' || status === 'completed',
    status === 'completed'
  ]
  const spanH = need.reduce((acc, n, k) => (n ? acc + ORDER_LIFECYCLE_H[k] : acc), 0)
  const base = Math.min(Date.parse(rawCreate), Date.now() - (spanH + 6) * 3600_000)

  const out: Pick<Order, 'createTime' | 'payTime' | 'shipTime' | 'receiveTime' | 'completeTime'> = {
    createTime: new Date(base).toISOString()
  }
  const keys = ['payTime', 'shipTime', 'receiveTime', 'completeTime'] as const
  // 逐站累加：每一站都建立在前一站之上，顺序天然单调
  let acc = 0
  need.forEach((n, k) => {
    acc += ORDER_LIFECYCLE_H[k]
    if (n) out[keys[k]] = new Date(base + acc * 3600_000).toISOString()
  })
  return out
}

/* ============ 订单历史：承运商 / 物流轨迹 / 操作日志 ============ */

/** 承运商池。与运单号前缀无关，纯展示用 —— 真实系统由发货时选择 */
const CARRIERS = ['顺丰速运', '中通快递', '圆通速递', '韵达快递', '京东物流']

/** 物流轨迹文案模板（按顺序推进；最后一条是签收） */
const TRACE_TEMPLATES = [
  '卖家已发货，快件已被【{city}学院路营业点】揽收',
  '快件已发出，下一站【北京海淀中转站】',
  '快件已到达【北京海淀中转站】',
  '快件已离开【北京海淀中转站】，发往【北京学院路营业点】',
  '快件已到达【北京学院路营业点】，快递员正在派送',
  '快件已签收，签收人：本人。感谢使用，期待再次为您服务'
]

/**
 * 依据订单**已经发生的时间线**推导出物流轨迹。
 *
 * 刻意不另起一套随机数据：轨迹的起点必须等于 `shipTime`、终点不能超过 `receiveTime`
 * （已收货）或「现在」（在途），否则就会出现「签收时间早于发货时间」这类穿帮。
 * 时间不落得下几条就生成几条 —— 宁可轨迹短，也不能时间倒挂。
 */
function buildOrderTraces(o: Order): LogisticsTrace[] {
  if (!o.shipTime) return []
  const start = Date.parse(o.shipTime)
  const end = o.receiveTime ? Date.parse(o.receiveTime) : Date.now() - 30 * 60_000
  const stepH = 7
  const out: LogisticsTrace[] = []
  for (let k = 0; k < TRACE_TEMPLATES.length; k++) {
    const t = start + k * stepH * 3600_000
    if (t > end) break
    // 已签收的订单，最后一条必须是「已签收」而不是「正在派送」
    const isLast = k === TRACE_TEMPLATES.length - 1
    if (isLast && !o.receiveTime) break
    out.push({ time: new Date(t).toISOString(), text: TRACE_TEMPLATES[k].replace('{city}', '北京') })
  }
  return out.reverse() // 最新在前，前端直接顺序渲染
}

/**
 * 由订单时间线反推操作日志（按时间倒序）。
 *
 * 每条日志都必须满足 `from → to` 是状态机里的一条合法边，
 * 这样后台看到的日志与 `ORDER_TRANSITIONS` 永远自洽 ——
 * 不会出现「日志说 待付款→已完成」这种解释不通的记录。
 */
function buildOrderLogs(o: Order): OrderLog[] {
  const logs: OrderLog[] = []
  let seq = 0
  const push = (l: Omit<OrderLog, 'id'>) => logs.push({ id: ++seq, ...l })

  const buyer = o.buyerName ?? `#${o.buyerId}`
  const seller = o.sellerName ?? `#${o.sellerId}`

  push({
    time: o.createTime,
    action: 'create',
    actionLabel: '买家下单',
    to: 'pending_payment',
    operator: buyer,
    operatorRole: 'buyer',
    note: o.remark
  })
  if (o.payTime) {
    push({
      time: o.payTime,
      action: 'pay',
      actionLabel: '买家付款',
      from: 'pending_payment',
      to: 'pending_ship',
      operator: buyer,
      operatorRole: 'buyer'
    })
  }
  if (o.shipTime) {
    push({
      time: o.shipTime,
      action: 'ship',
      actionLabel: '卖家发货',
      from: 'pending_ship',
      to: 'shipped',
      operator: seller,
      operatorRole: 'seller',
      note: o.trackingNo ? `${o.logisticsCompany ?? ''} ${o.trackingNo}`.trim() : undefined
    })
  }
  if (o.receiveTime) {
    push({
      time: o.receiveTime,
      action: 'receive',
      actionLabel: '买家确认收货',
      from: 'shipped',
      to: 'received',
      operator: buyer,
      operatorRole: 'buyer'
    })
  }
  if (o.completeTime) {
    push({
      time: o.completeTime,
      action: 'complete',
      actionLabel: '交易完成',
      from: 'received',
      to: 'completed',
      operator: '系统',
      operatorRole: 'system',
      note: '确认收货后自动完成结算'
    })
  }
  /*
   * 售后两条：申请退款与退款完成是两个独立节点。
   * 只记「退款完成」的话，售后时效（申请→处理隔了多久）就无从计算，
   * 而时效恰恰是后台售后看板最需要的指标。
   */
  if (o.refund) {
    push({
      time: o.refund.time,
      action: 'refund',
      actionLabel: o.refund.by === 'buyer' ? '买家申请退款' : '平台发起退款',
      // 申请退款时货物状态不定，用实际发货与否决定 from，保证是状态机里的合法边
      from: o.shipTime ? 'shipped' : o.payTime ? 'pending_ship' : 'pending_payment',
      to: 'refunding',
      operator: o.refund.by === 'buyer' ? buyer : '管理员',
      operatorRole: o.refund.by === 'buyer' ? 'buyer' : 'admin',
      note: o.refund.reason
    })
  }
  if (o.refundTime) {
    push({
      time: o.refundTime,
      action: 'refund',
      actionLabel: '退款完成，订单关闭',
      from: 'refunding',
      to: 'cancelled',
      operator: '管理员',
      operatorRole: 'admin',
      note: o.refund ? `退款 ¥${o.refund.amount.toFixed(2)}` : undefined
    })
  }
  // 未付款超时关闭（没有退款，钱没收过）
  if (o.cancelReason && !o.refund) {
    push({
      time: o.cancelReason.time,
      action: 'cancel',
      actionLabel: '订单关闭',
      from: 'pending_payment',
      to: 'cancelled',
      operator: '系统',
      operatorRole: 'system',
      note: o.cancelReason.text
    })
  }
  return logs.reverse()
}

/** 给一条订单补齐承运商 / 物流轨迹 / 操作日志（种子数据与新建订单共用）。
 *
 * ⚠️ 三段都是**只补不改**（`if (!o.x)`）：日志一旦被写进去就不能再重算 ——
 * 否则每次 `refreshOrderHistory()` 都会把管理员追加的备注日志覆盖掉，
 * 表现成「写了备注，切个页面就没了」。
 */
function withOrderHistory(o: Order): Order {
  if (o.trackingNo && !o.logisticsCompany) {
    o.logisticsCompany = CARRIERS[Number(o.id.slice(-2)) % CARRIERS.length]
  }
  if (o.trackingNo && !o.traces) o.traces = buildOrderTraces(o)
  if (!o.logs) o.logs = buildOrderLogs(o)
  return o
}

function buildOrderList(): Order[] {
  return Array.from({ length: ORDER_STATUS_PLAN.length }, (_, i) => {
    const status = ORDER_STATUS_PLAN[i]
    const g = _goodsCache[i % _goodsCache.length]
    // 买家在演示用户里轮转（同样钉在固定池，追加用户不会打乱已生成的订单）
    const buyer = SEED_USER_POOL[i % SEED_USER_POOL.length]
    // 数码类商品走「平台补贴」（卖家实收不变），其余分类走「卖家让利」
    const fundSource: FundSource = promoFundSourceOf(g.categoryId) ?? 'seller'
    const b = settlePrice(g, fundSource)
    const tl = buildOrderTimeline(status, dayjsRandomRecent())

    /*
     * 售后信息必须在 withOrderHistory 之前挂上 ——
     * 操作日志是由「状态 + 时间线 + 售后字段」一起反推出来的，
     * 顺序颠倒的话退款那两条日志根本不会被生成。
     */
    const afterSale = i >= 20 ? AFTER_SALE_PLAN[i - 20] : null
    let refund: Order['refund']
    let cancelReason: Order['cancelReason']
    if (status === 'refunding' && afterSale) {
      refund = {
        amount: b.payAmount,
        reason: afterSale.reason,
        by: afterSale.by,
        time: afterSaleTime(tl, 20),
        remark: afterSale.remark
      }
    } else if (status === 'cancelled' && afterSale) {
      cancelReason = { time: afterSaleTime(tl, 24), text: afterSale.reason }
    }

    return withOrderHistory({
      id: `2026${String(i).padStart(5, '0')}`,
      status,
      goods: { id: g.id, title: g.title, cover: g.cover, price: g.price, promoPrice: g.promoPrice },
      buyerId: buyer.id,
      buyerName: buyer.nickname,
      sellerId: g.sellerId,
      sellerName: g.sellerName,
      // 买家实付
      amount: b.payAmount,
      listPrice: b.listPrice,
      sellerCut: b.sellerCut,
      platformSubsidy: b.platformSubsidy,
      sellerIncome: b.sellerIncome,
      fundSource,
      activityId: b.onPromo ? promoActivityIdOf(g.categoryId) : undefined,
      // 买家备注：只在少数几单上出现，便于后台按「有备注」筛选出真实用例
      remark: i % 3 === 0 ? '请尽快发货，谢谢' : undefined,
      address: '北京市海淀区学院路 38 号 计算机学院宿舍',
      trackingNo: tl.shipTime ? `SF${rand(100000000, 999999999)}` : undefined,
      refund,
      cancelReason,
      ...tl
    })
  })
}
let _orderCache: Order[] = buildOrderList()

/* ============ 假数据：公告 ============
 * 公告原文较长（content 字段可写多段），用分隔符展示更清晰。
 * 这里再补一份"完整正文"，并暴露 mutate-able cache，便于管理员在管理后台编辑/置顶。
 * Reference: 参考图中"平台公告"通常含 ① 标题 + 时间 ② 标签（置顶/活动/规则） ③ 折叠/展开。
 */
export const mockNotices: Notice[] = [
  {
    id: 1,
    title: '关于 2026 秋季学期二手集市开放的通知',
    content:
      '亲爱的同学们：\n\n校园二手集市将于 2026 年 9 月 1 日正式上线。\n\n在这里你可以：\n1. 发布闲置物品（教材、数码、生活用品、服饰等）\n2. 浏览校内同学的二手好物\n3. 与卖家实时聊天、约时间面交\n\n请文明交易，诚信交易，共同维护良好的校园循环生态。',
    pinned: true,
    createTime: '2026-09-01T09:00:00'
  },
  {
    id: 2,
    title: '严禁在平台发布违规、违法商品',
    content:
      '违规处理：\n\n① 首次发现违规商品，系统自动下架并通知发布者；\n② 同一账号 7 天内累计 3 次违规，账号将被冻结 7 天；\n③ 涉嫌违法犯罪的，将配合学校保卫处与司法机关进一步调查。\n\n欢迎同学们举报违规商品。我们对举报人信息严格保密。',
    pinned: true,
    createTime: '2026-09-05T14:23:00'
  },
  {
    id: 3,
    title: '如何提升信誉积分？内附详细指南',
    content:
      '信誉积分是你在平台的"信用名片"，直接影响：\n\n· 搜索结果排序（高信誉商品优先展示）\n· 平台活动报名资格\n· 是否被限制发布商品\n\n提升规则：\n· 完成一笔好评 +3（单笔订单最多 +5）\n· 收到差评或被举报属实 -5 / -10\n· 完成平台认证 +10\n· 严重违规则直接封禁账号\n\n坚持诚信交易，信誉分自然水涨船高。',
    pinned: false,
    createTime: '2026-09-08T10:11:00'
  },
  {
    id: 4,
    title: '【活动】卖家让利专区：教材 5 折起',
    // 措辞要点：① 明确折扣来自「卖家自愿让利」，不是平台替卖家定价；
    //           ② 限定「参与活动的商品」，不暗示全场；③ 只声明数据里真实存在的力度。
    content:
      '活动期间（开学季两周），参与活动的教材类商品 5 折起，宿舍电器 8 折起。\n\n关于折扣的说明：平台上的商品由同学自行发布，定价权在卖家手里，平台不会代替卖家定价。本专区的折扣来自卖家自愿让利——平台不加价、不参与分成，商品详情页会明确标注让利金额。\n\n活动订单免邮费，订单详情页可查看活动进度。',
    pinned: false,
    createTime: '2026-09-09T08:00:00'
  }
]
// 可变缓存：让 fetchNotices 在不同调用间真实可变（管理员置顶/取消置顶后能反馈到列表）。
// 注：不在 helpers 里包一层 setter，因为 pinned 切换是逐条修改对象的 pinned 属性。
export const mockNoticesCache = {
  get: () => mockNotices,
  set: (list: Notice[]) => {
    mockNotices.splice(0, mockNotices.length, ...list)
  }
}

/* ============ 假数据：收藏夹 ============ */
function pickGoodsBrief(g: Goods) {
  return {
    id: g.id,
    title: g.title,
    price: g.price,
    cover: g.cover,
    // 收藏快照只保留必要字段；让利价一定要带上，否则收藏列表会显示不出活动价
    promoPrice: g.promoPrice,
    status: g.status,
    location: g.location,
    sellerName: g.sellerName,
    // 数量要带上：收藏页加购时要按真实库存封顶，不能默认 1 件
    stock: g.stock
  }
}
function buildFavorites(): Favorite[] {
  return _goodsCache.slice(0, 12).map((g, i) => ({
    id: i + 1,
    goodsId: g.id,
    goods: pickGoodsBrief(g),
    createTime: new Date(Date.now() - i * 86400_000 - 3_600_000 * i).toISOString()
  }))
}
let _favoritesCache: Favorite[] = buildFavorites()

/* ============ 假数据：浏览历史 ============ */
function buildHistory(): HistoryItem[] {
  return Array.from({ length: 18 }, (_, i) => {
    const g = _goodsCache[(i * 3 + 5) % _goodsCache.length]
    return {
      id: i + 1,
      goodsId: g.id,
      goods: pickGoodsBrief(g),
      viewTime: new Date(Date.now() - i * 3_600_000 - i * 60_000).toISOString()
    }
  })
}
let _historyCache: HistoryItem[] = buildHistory()

/* ============ 假数据：商品留言（留言表） ============
 * 种子给前 6 件商品各铺 2-4 条留言，含一层回复，演示「评论 / 回复」结构。
 */
function buildComments(): GoodsComment[] {
  const out: GoodsComment[] = []
  let id = 1
  const pool = [
    ['还在吗？可以刀一点吗', '在的，诚心要可以少 20'],
    ['是自取还是能包邮呀？', '两种都支持，看你怎么方便'],
    ['有实拍细节图吗？发我看看', '详情页图集里就是实拍图哈'],
    ['同学，这个还能降吗？学生党预算不多', '给你抹个零头，来面交谈吧'],
    ['东西保真吗？有购买凭证不', '发票还在，可以面交时看']
  ]
  const askers = [
    { userId: 2, userName: '旧书摊李同学' },
    { userId: 3, userName: '数码王同学' },
    { userId: 4, userName: '运动陈同学' }
  ]
  for (let g = 1; g <= 6; g++) {
    const goods = _goodsCache[g - 1]
    const take = 2 + (g % 3) // 2-4 条
    for (let k = 0; k < take; k++) {
      const [q, a] = pool[(g + k) % pool.length]
      const asker = askers[(g + k) % askers.length]
      const t = Date.now() - (g * 10 + k * 3) * 3_600_000
      out.push({
        id: id++,
        goodsId: goods.id,
        userId: asker.userId,
        userName: asker.userName,
        userAvatar: `https://api.dicebear.com/7.x/initials/svg?seed=${asker.userId}`,
        content: q,
        createTime: new Date(t).toISOString()
      })
      // 卖家回复（goods.sellerId）
      out.push({
        id: id++,
        goodsId: goods.id,
        userId: goods.sellerId,
        userName: goods.sellerName,
        userAvatar: goods.sellerAvatar,
        content: a,
        parentId: id - 2,
        replyToName: asker.userName,
        createTime: new Date(t + 1_800_000).toISOString()
      })
    }
  }
  return out
}
let _commentsCache: GoodsComment[] = buildComments()

/* ============ 假数据：评价（评价表） ============
 * 与订单关联：买家 → 卖家，1-5 星。给前 8 个订单对应的商品铺评价。
 */
function buildReviews(): Review[] {
  const contents = [
    ['卖家很爽快，东西和描述一致，面交顺利！', 5],
    ['成色不错，价格合理，推荐～', 5],
    ['有点小瑕疵但价格摆在这里，可以接受', 4],
    ['沟通及时，发货快，好评', 5],
    ['总体还行，就是比想象中旧一点', 3],
    ['很划算，同学人很好，还送了配件', 5],
    ['一般般吧，能用', 3],
    ['质量超出预期，捡漏了！', 5]
  ] as const

  /*
   * 追评种子，与 contents 下标对齐；null = 这条只有首评。
   * 故意不铺满 —— 真实站点里追评本来就是少数派，条条都追反而假。
   * appendTime 必须晚于首评、早于「现在」，否则时间线倒流。
   */
  const appends: (string | null)[] = [
    '用了两周来追评：续航比想象中好，接口也没有接触不良。',
    null,
    null,
    '补充一下：卖家后来还主动发了电子发票，省了我不少事。',
    null,
    null,
    null,
    null
  ]

  /*
   * 评价从**订单**派生，而不是按商品下标硬编 orderId。
   * 旧实现写死 `orderId = 2026${i}`，与订单种子里的「已发货」订单撞号，
   * 导致确认收货后立刻被判为「已评价」。这里只取已完成生命周期的订单，
   * 并把商品 / 买家 / 卖家全部取自已订单，保证评价与订单互相对得上。
   */
  const reviewed = _orderCache
    .filter((o) => o.status === 'received' || o.status === 'completed')
    .slice(0, contents.length)

  return reviewed.map<Review>((o, i) => {
    const [content, rating] = contents[i]
    const receiveTs = Date.parse(o.receiveTime ?? o.createTime)
    // 评价发生在收货之后（1~8 小时），且夹在「现在」之前，不产生未来时间
    const createTs = Math.min(receiveTs + (i + 1) * 3600_000, Date.now() - (8 - i) * 1800_000)
    const review: Review = {
      id: i + 1,
      orderId: o.id,
      goodsId: o.goods.id,
      fromUserId: o.buyerId,
      fromUserName: o.buyerName ?? `用户 #${o.buyerId}`,
      fromUserAvatar: mockUsers.find((u) => u.id === o.buyerId)?.avatar ?? '',
      toUserId: o.sellerId,
      rating,
      content,
      createTime: new Date(createTs).toISOString()
    }
    const appendContent = appends[i]
    if (appendContent) {
      review.appendContent = appendContent
      // 追评在首评之后约 2 小时，且不越过「现在」
      review.appendTime = new Date(
        Math.min(createTs + 2 * 3600_000, Date.now() - 600_000)
      ).toISOString()
    }
    return review
  })
}
let _reviewsCache: Review[] = buildReviews()

/* ============ 假数据：举报（举报表） ============ */
function buildReports(): Report[] {
  const g1 = _goodsCache[10]
  const g2 = _goodsCache[20]
  return [
    {
      id: 1,
      type: 'goods',
      targetId: g1.id,
      reason: '涉嫌虚假描述',
      description: '商品页写"全新未拆封"，但图片明显有使用痕迹。',
      status: 'pending',
      createTime: new Date(Date.now() - 2 * 86400_000).toISOString()
    },
    {
      id: 2,
      type: 'goods',
      targetId: g2.id,
      reason: '疑似违规商品',
      description: '该商品疑似校内禁售物品，请平台核实。',
      status: 'handled',
      // 已处理的举报必须留下「做了什么 + 为什么」，否则事后复核只能看到一句「已处理」
      measure: 'off_shelf',
      remark: '经核实属校内禁售品类，商品下架并已警示卖家整改。',
      handleTime: new Date(Date.now() - 4 * 86400_000).toISOString(),
      handledBy: '管理员',
      createTime: new Date(Date.now() - 5 * 86400_000).toISOString()
    }
  ]
}
let _reportsCache: Report[] = buildReports()

/* ============ 假数据：收货地址 ============ */
let _addressesCache: Address[] = [
  { id: 1, receiver: '刘宝坤', phone: '13800138001', region: '北京市/海淀区/学院路街道', detail: 'XX大学南门 13 号宿舍楼 502', isDefault: true, tag: '宿舍' },
  { id: 2, receiver: '刘宝坤', phone: '13800138002', region: '北京市/海淀区/中关村南大街', detail: 'XX大学计算机学院 308 室', isDefault: false, tag: '学院' }
]

/* ============ 假数据：私信会话 & 消息 ============ */
/**
 * 会话 id 规则：s_{goodsId}_{minUserId}_{maxUserId}
 * 这样同一对用户 + 同一商品只有一条会话，双方视角看到的是同一条记录。
 */
export function makeSessionId(userA: number, userB: number, goodsId = 0): string {
  const [a, b] = [userA, userB].sort((x, y) => x - y)
  return `s_${goodsId}_${a}_${b}`
}

function ago(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString()
}

const S1 = makeSessionId(1, 2, 9000) // 计算机小张 ↔ 旧书摊李同学 · 高等数学
const S2 = makeSessionId(1, 3, 9001) // 计算机小张 ↔ 数码王同学 · iPad
const S3 = makeSessionId(1, 4, 9002) // 计算机小张 ↔ 运动陈同学 · 网球拍

let _messagesCache: ChatMessage[] = [
  // 会话 1：小张 vs 李同学
  { id: 1, sessionId: S1, fromUserId: 1, toUserId: 2, content: '同学你好，这本高等数学还在吗？', createTime: ago(120), read: true },
  { id: 2, sessionId: S1, fromUserId: 2, toUserId: 1, content: '在的，九成新，没有笔记，很干净', createTime: ago(118), read: true },
  { id: 3, sessionId: S1, fromUserId: 2, toUserId: 1, content: '参考答案也一起送，需要的话可以约时间面交～', createTime: ago(117), read: false },
  { id: 4, sessionId: S1, fromUserId: 2, toUserId: 1, content: '我这周三下午在图书馆，方便的话可以直接过来', createTime: ago(30), read: false },

  // 会话 2：小张 vs 王同学
  { id: 5, sessionId: S2, fromUserId: 1, toUserId: 3, content: 'iPad Air 5 还在吗？能便宜点吗', createTime: ago(300), read: true },
  { id: 6, sessionId: S2, fromUserId: 3, toUserId: 1, content: '在的，3280 已经是最低价啦，配件齐全', createTime: ago(298), read: true },

  // 会话 3：小张 vs 陈同学
  { id: 7, sessionId: S3, fromUserId: 4, toUserId: 1, content: '你的网球拍还有货吗？我想买', createTime: ago(600), read: false }
]

let _sessionsCache: ChatSession[] = [
  {
    id: S1, peerId: 2, peerName: '旧书摊李同学', peerAvatar: 'https://api.dicebear.com/7.x/initials/svg?seed=book',
    goodsId: 9000, goodsTitle: '高等数学（同济第七版）九成新', goodsCover: goodsPhoto(1, 0),
    lastMessage: '我这周三下午在图书馆，方便的话可以直接过来', lastTime: ago(30), unread: 0
  },
  {
    id: S2, peerId: 3, peerName: '数码王同学', peerAvatar: 'https://api.dicebear.com/7.x/initials/svg?seed=wang',
    goodsId: 9001, goodsTitle: 'iPad Air 5 64G 几乎全新', goodsCover: goodsPhoto(2, 0),
    lastMessage: '在的，3280 已经是最低价啦，配件齐全', lastTime: ago(298), unread: 0
  },
  {
    id: S3, peerId: 4, peerName: '运动陈同学', peerAvatar: 'https://api.dicebear.com/7.x/initials/svg?seed=chen',
    goodsId: 9002, goodsTitle: 'Wilson 网球拍', goodsCover: makeCover(6, 9002),
    lastMessage: '你的网球拍还有货吗？我想买', lastTime: ago(600), unread: 0
  }
]

/**
 * 模拟「对方自动回复」——方便在单机 Mock 环境演示双方收发
 * 真实项目里这一步由对方客户端 / WebSocket 推送完成
 */
const AUTO_REPLIES = [
  '收到，我看下～',
  '好的，没问题',
  '在的在的，你可以直接下单',
  '这个价格已经是最低了哈',
  '方便的话加个微信详聊？',
  '我这边随时可以面交'
]
export function mockAutoReply(): string {
  return AUTO_REPLIES[Math.floor(Math.random() * AUTO_REPLIES.length)]
}

/* ============ 假数据：图表 ============ */
export function buildTrendData(days = 7) {
  return Array.from({ length: days }, (_, i) => ({
    date: new Date(Date.now() - (days - 1 - i) * 86400_000).toISOString().slice(5, 10),
    pv: rand(200, 800),
    uv: rand(50, 300),
    orders: rand(5, 40)
  }))
}

export const mockCategoryPie = [
  { name: '教材', value: 320 },
  { name: '数码', value: 180 },
  { name: '生活', value: 150 },
  { name: '服饰', value: 95 },
  { name: '运动', value: 70 },
  { name: '其他', value: 60 }
]

/* ============ 限时活动（多活动 · 可随时上架） ============
 * 需求演进：最初只支持「一个开学季特卖」，管理员无法同时维护多个活动。
 * 现在升级为「活动列表」模型：
 * ① 可保存任意多个活动，各自独立的生命周期 startAt → startAt + durationDays；
 * ② 每个活动有 enabled（上架/下架）与 priority（优先级，数字越大越靠前）；
 * ③ 前台只展示 active / pending 的活动，并按 priority 降序自动轮播；
 *    若同时只有一个有效活动，退化为单 Banner（不渲染轮播指示器），避免多余 UI；
 * ④ 管理员在「管理后台 → 活动管理」可新建 / 编辑 / 上架 / 下架 / 删除 / 调优先级 / 恢复出厂；
 * ⑤ 活动列表持久化到 localStorage['c2c-activities'] —— 否则刷新即重置，
 *    会出现「管理员下架了但前台刷新又出现」以及倒计时永远停在 14 天的假象。
 * ⑥ 兼容旧存档：若只存在旧版单活动 key 'c2c-activity'，自动迁移进列表后清除。
 */
export type ActivityState = 'pending' | 'active' | 'expired' | 'cancelled'
/** 前台 Banner 配色主题（收敛为四套色系，避免出现「随机彩虹」） */
export type ActivityTheme = 'orange' | 'blue' | 'green' | 'purple'

/**
 * 活动对外的让利声明。
 *
 * C2C 平台的商品定价权在卖家手里，平台只能**公示**卖家或平台自己给出的让利，
 * 不能单方面承诺折扣。所以活动里的折扣力度必须是**结构化**的：
 * 前台价格与活动文案都以它为准，同时它也是 `promo.spec.ts` 的校验对象 ——
 * 「文案声称的力度，必须在商品数据里真实存在」。
 */
export interface ActivityDiscountClaim {
  categoryId: number
  /** 最低折扣率：0.5 表示「5 折起」（即最低价 = 挂牌价 × 0.5） */
  rate: number
}

export interface ActivityConfig {
  id: string
  enabled: boolean              // false = 管理员手动下架（状态判定为 cancelled）
  startAt: number               // 活动开始时间戳（ms）
  durationDays: number          // 活动天数
  title: string                 // 主标题
  subtitle: string              // 副标题 / 导引文案
  ctaText: string               // CTA 按钮文案
  ctaLink: string               // CTA 跳转链接
  highlights: string[]          // 卖点 chip 列表
  icon: string                  // 大表情
  theme: ActivityTheme          // Banner 配色主题
  priority: number              // 优先级，数字越大越先展示
  /** 谁承担让利成本 —— 决定订单快照里这笔钱记到卖家还是平台 */
  fundSource: FundSource
  /** 对外声明的让利清单（分类 + 最低折扣）；不涉及改价的活动留空数组 */
  claims: ActivityDiscountClaim[]
  note?: string                 // 后台备注（仅管理端可见）
  createTime: number
  updateTime: number
  cancelledAt?: number          // 管理员下架时间（用于日志展示）
  cancelledBy?: string          // 管理员操作者
}

/** 活动展示模型（首页 Banner / 后台列表用） */
export interface ActivityDisplay {
  config: ActivityConfig
  state: ActivityState
  expiresAt: number
  remainingMs: number
  shouldShow: boolean
}

export const ACTIVITIES_STORAGE_KEY = 'c2c-activities'
/** 旧版单活动存档 key（仅用于一次性迁移） */
const LEGACY_ACTIVITY_STORAGE_KEY = 'c2c-activity'
export const DEFAULT_ACTIVITY_DAYS = 14
const DAY_MS = 86400_000
export const ACTIVITY_THEMES: ActivityTheme[] = ['orange', 'blue', 'green', 'purple']

/** 出厂活动列表（首次进入 / 恢复出厂时使用）
 *
 * ⚠️ 文案与 `claims` 必须严格对应（「N 折」↔ rate = N/10），并且声称的力度
 *    必须在商品数据里真实存在 —— 由 `src/api/promo.spec.ts` 自动校验。
 *    旧版「教材分类全场 5 折起」既不限定范围、也没声明资金归属，属虚假宣传，已修正。
 */
function makeSeedActivities(now = Date.now()): ActivityConfig[] {
  return [
    {
      id: 'back-to-school-2026-fall',
      enabled: true,
      startAt: now,
      durationDays: DEFAULT_ACTIVITY_DAYS,
      title: '卖家让利专区：教材 5 折起，宿舍电器 8 折起',
      subtitle: '折扣来自卖家自愿让利，平台不加价、不代卖家定价',
      ctaText: '看看让利好物',
      ctaLink: '/goods?categoryId=1',
      highlights: ['卖家让利 · 教材 5 折起', '宿舍电器 8 折起', '参与活动商品', '平台担保交易'],
      icon: '🎓',
      theme: 'orange',
      priority: 100,
      fundSource: 'seller',
      claims: [
        { categoryId: 1, rate: 0.5 },
        { categoryId: 5, rate: 0.8 }
      ],
      note: '首页主推位 · 折扣由卖家自愿让利，平台不代卖家定价',
      createTime: now - 3 * DAY_MS,
      updateTime: now - 3 * DAY_MS
    },
    {
      /*
       * 这条活动必须是 `enabled: true`。
       *
       * 原因：PROMO_RATES 里「数码」分类挂在它名下，也就是数码商品身上带着让利价。
       * 如果活动已下架却仍有人享受折扣，就等于「活动结束了但价还在打折」——
       * 数据自相矛盾，也让 `promo.spec.ts` 里「未被进行中活动声明的分类不得有让利价」
       * 这条断言直接失败。活动下架 ⇒ 该活动的让利声明立即失效，价格回到挂牌价。
       */
      id: 'digital-refresh-week',
      enabled: true,
      startAt: now,
      durationDays: 7,
      title: '平台补贴日：数码好物 8 折起',
      subtitle: '补贴由平台承担，卖家实收不变，验机后再付款',
      ctaText: '逛逛数码',
      ctaLink: '/goods?categoryId=2',
      highlights: ['平台补贴 · 数码 8 折起', '卖家实收不变', '当面验机'],
      icon: '🎧',
      theme: 'blue',
      priority: 80,
      fundSource: 'platform',
      claims: [{ categoryId: 2, rate: 0.8 }],
      note: '与主推活动并行：平台补贴不减少卖家收入',
      createTime: now - 2 * DAY_MS,
      updateTime: now - 1 * DAY_MS
    },
    {
      /*
       * 【与上一条活动**故意重叠**分类】
       *
       * 「生活」（5 号）已经被开学季特卖（卖家让利 8 折）声明过，这里再挂一条
       * 平台补贴的活动。这是现实里最常见的形态：两个活动同时在跑、都覆盖同一批商品，
       * 但**谁掏钱不一样** —— 卖家必须在发布页明确选一个，不能既享受卖家让利
       * 又拿平台补贴（那就是「一件商品两笔折扣」，帐根本对不平）。
       *
       * 数据上它是「多活动共享分类」的唯一实例，`promo.spec.ts` / `e2e-promo.cjs`
       * 都靠它验证「列全部、只能选一个」以及「归属按商品自己的 activityId 判定」。
       *
       * ⚠️ 力度声明 8.5 折（比开学季的 8 折浅）也要成立：商品按**自己报名的活动**
       *    判定力度，seed 里生活类商品的 activityId 是开学季，所以它们打到 8 折
       *    并不违反本活动的「最高 8.5 折」。
       */
      id: 'dorm-upgrade-2026',
      enabled: true,
      startAt: now,
      durationDays: 10,
      title: '宿舍焕新补贴周：生活好物 8.5 折',
      subtitle: '补贴由平台承担，卖家实收不变，宿舍楼下当面验货',
      ctaText: '逛逛生活好物',
      ctaLink: '/goods?categoryId=5',
      highlights: ['平台补贴 · 生活好物 8.5 折', '卖家实收不变', '当面验货'],
      icon: '🛋️',
      theme: 'purple',
      priority: 70,
      fundSource: 'platform',
      claims: [{ categoryId: 5, rate: 0.85 }],
      note: '与开学季特卖并行：同分类两个活动，卖家在发布页二选一',
      createTime: now - 1 * DAY_MS,
      updateTime: now - 1 * DAY_MS
    },
    {
      id: 'grad-clearance-2026',
      enabled: true,
      startAt: now - 40 * DAY_MS,
      durationDays: 14,
      title: '毕业清仓专场：校友离校行李电器特卖',
      subtitle: '毕业生离校甩卖，宿舍神器一律白菜价',
      ctaText: '去捡漏',
      ctaLink: '/goods?categoryId=5',
      highlights: ['离校清仓', '宿舍神器', '当日面交'],
      icon: '🧳',
      theme: 'green',
      priority: 60,
      fundSource: 'seller',
      // 无折扣声明：本活动只做展示与曝光，不改动任何商品价格
      claims: [],
      note: '已自然到期（保留在列表中，可一键重新上架）',
      createTime: now - 45 * DAY_MS,
      updateTime: now - 40 * DAY_MS
    }
  ]
}

let _activitySeq = 0
function nextActivityId(): string {
  return `act_${Date.now().toString(36)}${(++_activitySeq).toString(36)}`
}

/** 结构校验 + 缺失字段补默认值（存档可能来自旧版本或被手工改坏） */
function normalizeActivity(raw: Partial<ActivityConfig>): ActivityConfig {
  const now = Date.now()
  const theme = ACTIVITY_THEMES.includes(raw.theme as ActivityTheme) ? (raw.theme as ActivityTheme) : 'orange'
  const days = Number(raw.durationDays)
  const priority = Number(raw.priority)
  const startAt = Number(raw.startAt)
  const createTime = Number(raw.createTime) || now
  return {
    id: String(raw.id || nextActivityId()),
    enabled: raw.enabled !== false,
    startAt: Number.isFinite(startAt) && startAt > 0 ? startAt : now,
    durationDays: Number.isFinite(days) && days > 0 ? days : DEFAULT_ACTIVITY_DAYS,
    title: String(raw.title ?? ''),
    subtitle: String(raw.subtitle ?? ''),
    ctaText: String(raw.ctaText ?? '立即参与'),
    ctaLink: String(raw.ctaLink ?? '/goods'),
    highlights: Array.isArray(raw.highlights) ? raw.highlights.map(String).filter(Boolean) : [],
    icon: String(raw.icon ?? '🎯'),
    theme,
    priority: Number.isFinite(priority) ? priority : 50,
    // 旧存档没有这两个字段：默认「卖家让利」+ 无折扣声明（宁可少声称，不可乱声称）
    fundSource: raw.fundSource === 'platform' ? 'platform' : 'seller',
    claims: Array.isArray(raw.claims)
      ? raw.claims
          .map((c) => ({ categoryId: Number(c?.categoryId), rate: Number(c?.rate) }))
          .filter((c) => Number.isFinite(c.categoryId) && c.categoryId > 0 && Number.isFinite(c.rate) && c.rate > 0 && c.rate < 1)
      : [],
    note: raw.note ? String(raw.note) : undefined,
    createTime,
    updateTime: Number(raw.updateTime) || createTime,
    cancelledAt: raw.cancelledAt ? Number(raw.cancelledAt) : undefined,
    cancelledBy: raw.cancelledBy ? String(raw.cancelledBy) : undefined
  }
}

function saveActivities(list: ActivityConfig[]): void {
  try {
    localStorage.setItem(ACTIVITIES_STORAGE_KEY, JSON.stringify(list))
  } catch {
    /* 隐私模式 / 配额满：忽略，内存态仍可用 */
  }
}

/**
 * 旧存档自愈：第十轮之前存下的活动**没有** `claims` / `fundSource` 字段。
 *
 * 症状极其隐蔽，值得单独写一个函数：
 *   ① 活动照样在首页 Banner 上展示（Banner 不读 claims），
 *   ② 但**没有任何分类能报名** —— `resolveJoinableClaimByCategory()` 找不到让利声明，
 *      发布页就会说「当前分类暂无进行中的平台活动」；
 *   ③ `fundSource` 还会退化成默认的「卖家让利」，把数码活动（本该是平台补贴）
 *      的资金归属写错，与商品数据里的实际承担方自相矛盾。
 *
 * 判定条件是「原始数据里**根本没有** `claims` 字段」：
 *   - 从未写过 claims 的老存档 → 从出厂活动按 id 补回（这是要修的目标）；
 *   - 明确写成 `claims: []` 的（如「毕业清仓专场」这类展示型活动）→ **不动**，
 *     因为那是**有意为之**的声明，不能被覆盖。
 */
export function healLegacyActivities(rawList: unknown[]): ActivityConfig[] {
  const seeds = makeSeedActivities()
  let healed = 0
  const list = rawList.map((item) => {
    const raw = item as Partial<ActivityConfig>
    const norm = normalizeActivity(raw)
    if (Array.isArray(raw?.claims)) return norm
    const seed = seeds.find((s) => s.id === norm.id)
    if (!seed) return norm
    healed++
    return { ...norm, claims: seed.claims, fundSource: seed.fundSource }
  })
  if (healed > 0) console.info(`[mock] 已为 ${healed} 条旧版活动补回让利声明（claims / fundSource）`)
  return list
}

/** 从 localStorage 还原活动列表；无存档 / 解析失败时用出厂列表并存档 */
function loadActivities(): ActivityConfig[] {
  try {
    const raw = localStorage.getItem(ACTIVITIES_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length) {
        // 先自愈旧存档（缺 claims / fundSource），再交给缓存使用
        const list = healLegacyActivities(parsed)
        saveActivities(list)
        return list
      }
    }
    // 兼容旧版：把单活动存档迁移进列表
    const legacyRaw = localStorage.getItem(LEGACY_ACTIVITY_STORAGE_KEY)
    if (legacyRaw) {
      const rawLegacy = JSON.parse(legacyRaw) as Partial<ActivityConfig>
      const seeds = makeSeedActivities()
      // 若旧活动的 id 与出厂活动一致，则用出厂定义为底、旧数据覆盖，
      // 从而继承出厂活动的 priority / theme —— 否则旧活动会掉到列表末尾、丢掉「主推」地位
      const matchIdx = seeds.findIndex((s) => s.id === rawLegacy?.id)
      const migrated =
        matchIdx >= 0
          ? seeds.map((s, i) => (i === matchIdx ? normalizeActivity({ ...s, ...rawLegacy }) : s))
          : [normalizeActivity(rawLegacy), ...seeds.slice(1)]
      saveActivities(migrated)
      localStorage.removeItem(LEGACY_ACTIVITY_STORAGE_KEY)
      return migrated
    }
  } catch {
    /* 存档损坏 → 回落到出厂活动 */
  }
  const fresh = makeSeedActivities()
  saveActivities(fresh)
  return fresh
}

let _activitiesCache: ActivityConfig[] = loadActivities()

/** 计算单个活动当前状态 */
export function getActivityState(cfg: ActivityConfig, now = Date.now()): ActivityState {
  if (!cfg.enabled) return 'cancelled'
  const expiresAt = cfg.startAt + cfg.durationDays * DAY_MS
  if (now < cfg.startAt) return 'pending'
  if (now >= expiresAt) return 'expired'
  return 'active'
}

/** 优先级降序（同优先级时，开始时间新的排前面） */
function sortActivities(list: ActivityConfig[]): ActivityConfig[] {
  return [...list].sort((a, b) => b.priority - a.priority || b.startAt - a.startAt)
}

/** 单个活动 → 展示模型（状态 / 到期时间 / 剩余毫秒 / 是否该展示） */
export function activityDisplayOf(cfg: ActivityConfig, now = Date.now()): ActivityDisplay {
  const expiresAt = cfg.startAt + cfg.durationDays * DAY_MS
  const state = getActivityState(cfg, now)
  return {
    config: cfg,
    state,
    expiresAt,
    remainingMs: Math.max(0, expiresAt - now),
    shouldShow: state === 'active' || state === 'pending'
  }
}

/** 全部活动（含已下架 / 已到期），按优先级降序 —— 管理后台列表用 */
export function listActivityDisplays(now = Date.now()): ActivityDisplay[] {
  return sortActivities(_activitiesCache).map((c) => activityDisplayOf(c, now))
}

/** 前台可展示的活动：仅 active / pending，且 active 全部排在 pending 之前 */
export function getActiveActivities(now = Date.now()): ActivityDisplay[] {
  const all = listActivityDisplays(now)
  return [...all.filter((d) => d.state === 'active'), ...all.filter((d) => d.state === 'pending')]
}

/** 当前「主推活动」：优先第一个 active，其次 pending，都没有则取列表首位（供后台兜底展示） */
function featuredActivity(now = Date.now()): ActivityConfig {
  return getActiveActivities(now)[0]?.config ?? sortActivities(_activitiesCache)[0]
}

/** 获取主推活动 + 状态 + 剩余毫秒数（首页 Banner / 后台详情面板用） */
export function getActivityDisplay(now = Date.now()): ActivityDisplay {
  return activityDisplayOf(featuredActivity(now), now)
}

/** 新建活动（默认上架；未传 startAt 则从现在开始） */
export function createActivity(payload: Partial<ActivityConfig>): ActivityConfig {
  const now = Date.now()
  const cfg = normalizeActivity({
    ...payload,
    id: payload.id || nextActivityId(),
    createTime: now,
    updateTime: now,
    cancelledAt: undefined,
    cancelledBy: undefined
  })
  _activitiesCache = [cfg, ..._activitiesCache]
  saveActivities(_activitiesCache)
  return cfg
}

/** 编辑活动（局部更新） */
export function updateActivity(id: string, patch: Partial<ActivityConfig>): ActivityConfig {
  const target = _activitiesCache.find((a) => a.id === id)
  if (!target) throw new Error(`活动不存在：${id}`)
  const merged = normalizeActivity({ ...target, ...patch, id, updateTime: Date.now() })
  _activitiesCache = _activitiesCache.map((a) => (a.id === id ? merged : a))
  saveActivities(_activitiesCache)
  return merged
}

/** 上架 / 下架活动（下架即 cancelled，前台立即消失，存档保留） */
export function setActivityEnabled(id: string, enabled: boolean, by = 'admin'): ActivityConfig {
  const target = _activitiesCache.find((a) => a.id === id)
  if (!target) throw new Error(`活动不存在：${id}`)
  const now = Date.now()
  return updateActivity(id, {
    enabled,
    // 重新上架时若开始时间已过，从当下重新计时，避免「上架即到期」
    startAt: enabled && target.startAt <= now ? now : target.startAt,
    cancelledAt: enabled ? undefined : now,
    cancelledBy: enabled ? undefined : by
  })
}

/** 删除活动（不可恢复） */
export function deleteActivity(id: string): boolean {
  const next = _activitiesCache.filter((a) => a.id !== id)
  if (next.length === _activitiesCache.length) return false
  _activitiesCache = next
  saveActivities(_activitiesCache)
  return true
}

/** 兼容旧接口：结束「主推活动」（等价于把它下架） */
export function cancelActivity(by = 'admin'): ActivityConfig {
  return setActivityEnabled(featuredActivity().id, false, by)
}

/** 兼容旧接口：重新开启「主推活动」并把倒计时重置为 durationDays 天 */
export function restartActivity(durationDays = DEFAULT_ACTIVITY_DAYS): ActivityConfig {
  return updateActivity(featuredActivity().id, {
    enabled: true,
    startAt: Date.now(),
    durationDays,
    cancelledAt: undefined,
    cancelledBy: undefined
  })
}

/** 恢复出厂活动列表（清掉本地存档，便于演示 / 回归） */
export function resetActivities(now = Date.now()): ActivityConfig[] {
  _activitiesCache = makeSeedActivities(now)
  saveActivities(_activitiesCache)
  return _activitiesCache
}

/** 暴露给 helpers & 测试 */
export const mockActivity = {
  list: () => _activitiesCache,
  get: (id?: string) => (id ? _activitiesCache.find((a) => a.id === id) : featuredActivity()),
  create: createActivity,
  update: updateActivity,
  remove: deleteActivity,
  setEnabled: setActivityEnabled,
  cancel: cancelActivity,
  restart: restartActivity,
  reset: resetActivities,
  state: getActivityState,
  display: getActivityDisplay,
  displayOf: activityDisplayOf,
  active: getActiveActivities
}

/* ============ 操作日志（管理端审计） ============
 * 管理后台的每个「有副作用」的动作都往这里写一条，形成可回溯的审计流水。
 * 持久化到 localStorage['c2c-audit-logs']，最多保留 200 条（超出丢弃最旧的）。
 */
export interface AuditLog {
  id: number
  /** 动作标识，如 goods.offline / user.ban / activity.create */
  action: string
  /** 动作中文名（列表直接展示） */
  actionLabel: string
  /** 操作对象描述，如「商品 #12 iPad Air 5」 */
  target: string
  detail?: string
  operator: string
  createTime: string
}

const AUDIT_STORAGE_KEY = 'c2c-audit-logs'
const AUDIT_MAX = 200

/** 出厂操作日志：让「操作日志」页签首次打开不是一片空白（真实系统里是历史流水） */
function makeSeedAuditLogs(now = Date.now()): AuditLog[] {
  const items: Array<[string, string, string, string, number]> = [
    ['goods.status', '修改商品状态', '商品 #8', 'iPad Air 5 64G 几乎全新 → 已下架', 1],
    ['report.handle', '处理举报', '举报 #2（商品 #21）', '疑似违规商品', 2],
    ['user.credit', '调整信用分', '用户 #7', '代步周同学：60 → 54', 3],
    ['notice.pin', '置顶公告', '公告 #2', '严禁在平台发布违规、违法商品', 4],
    ['activity.offline', '下架活动', '活动「数码焕新周：平板 / 耳机 / 手环 8 折起」', '提前结束（主推活动）', 5],
    // 下架后重新上架：日志必须能还原完整链路，否则运营看到「已下架」却在前台看到 Banner 会以为出了 bug
    ['activity.online', '上架活动', '活动「平台补贴日：数码好物 8 折起」', '与主推活动并行，平台补贴不减少卖家收入', 1],
    ['user.ban', '封禁用户', '用户 #8', '服饰吴同学（cloth_wu）', 6],
    ['category.update', '编辑分类', '分类「艺术」', '更新图标', 7],
    ['goods.batchStatus', '批量修改商品状态', '4 件商品', 'ID：3、7、11、19 → 已下架', 9]
  ]
  return items.map(([action, actionLabel, target, detail, daysAgo], i) => ({
    id: items.length - i,
    action,
    actionLabel,
    target,
    detail,
    operator: 'admin',
    createTime: new Date(now - daysAgo * 86400_000 - i * 1_800_000).toISOString()
  }))
}

function loadAuditLogs(): AuditLog[] {
  try {
    const raw = localStorage.getItem(AUDIT_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) return parsed as AuditLog[]
    }
  } catch {
    /* 存档损坏 → 视为空 */
  }
  const seeded = makeSeedAuditLogs()
  saveAuditLogs(seeded)
  return seeded
}

function saveAuditLogs(list: AuditLog[]): void {
  try {
    localStorage.setItem(AUDIT_STORAGE_KEY, JSON.stringify(list.slice(0, AUDIT_MAX)))
  } catch {
    /* 隐私模式 / 配额满：忽略 */
  }
}

let _auditLogs: AuditLog[] = loadAuditLogs()

/** 追加一条操作日志（新的在前） */
export function addAuditLog(entry: {
  action: string
  actionLabel: string
  target: string
  detail?: string
  operator?: string
}): AuditLog {
  const log: AuditLog = {
    id: Math.max(0, ..._auditLogs.map((l) => l.id)) + 1,
    operator: entry.operator || 'admin',
    createTime: new Date().toISOString(),
    ...entry
  }
  _auditLogs = [log, ..._auditLogs].slice(0, AUDIT_MAX)
  saveAuditLogs(_auditLogs)
  return log
}

export function getAuditLogs(): AuditLog[] {
  return _auditLogs
}

export function clearAuditLogs(): void {
  _auditLogs = []
  saveAuditLogs(_auditLogs)
}

/** 动作标识 → 归类（后台按类型筛选） */
export const AUDIT_ACTION_TYPES: { key: string; label: string }[] = [
  { key: 'goods', label: '商品' },
  { key: 'user', label: '用户' },
  { key: 'order', label: '订单' },
  { key: 'notice', label: '公告' },
  { key: 'activity', label: '活动' },
  { key: 'category', label: '分类' },
  { key: 'content', label: '内容审核' },
  { key: 'report', label: '举报' },
  { key: 'settings', label: '系统设置' }
]

/* ============ 平台参数（系统设置） ============
 * 真实项目里由后端配置中心下发；这里持久化到 localStorage，
 * 让「改完刷新还在」这件事成立（否则每次刷新都回到默认值，演示会很假）。
 */
export interface PlatformSettings {
  siteName: string
  servicePhone: string
  /** 首页顶部滚动公告文案 */
  announceText: string
  /** 发布商品是否必须先审核 */
  goodsAuditRequired: boolean
  /** 单用户每日最多发布条数 */
  maxPublishPerDay: number
  /** 在售商品超过 N 天未成交自动下架（0 = 不自动下架） */
  autoOfflineDays: number
  /** 举报达到 N 次自动隐藏商品 */
  reportAutoHide: boolean
  /**
   * 平台服务费率（**百分比**，如 2 = 2%），用于估算平台收入。
   *
   * ★ 线上格式与这里不同 ★：后端 `t_settings.commission_rate` 是 `DECIMAL(5,4)` 的
   * **比率**（0 ~ 1），`AnalyticsService.saveSettings` 也按 0 ~ 1 校验（发 2 会被 1001 拒绝）。
   * 出入边界的换算统一由 `api/settings.ts` 借助 `@/utils/rate` 完成，
   * 所以这个字段在**整个前端（含 Mock 数据与单测）里始终是百分比**，不要在这里改口径。
   */
  commissionRate: number
}

const SETTINGS_STORAGE_KEY = 'c2c-settings'

function makeDefaultSettings(): PlatformSettings {
  return {
    siteName: '校园集市',
    servicePhone: '010-8888 6666',
    announceText: '平台担保交易，校内自提更快捷',
    goodsAuditRequired: true,
    maxPublishPerDay: 10,
    autoOfflineDays: 90,
    reportAutoHide: true,
    commissionRate: 2
  }
}

export function getPlatformSettings(): PlatformSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY)
    if (raw) return { ...makeDefaultSettings(), ...(JSON.parse(raw) as Partial<PlatformSettings>) }
  } catch {
    /* 存档损坏 → 回落默认值 */
  }
  return makeDefaultSettings()
}

export function savePlatformSettings(patch: Partial<PlatformSettings>): PlatformSettings {
  const next = { ...getPlatformSettings(), ...patch }
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next))
  } catch {
    /* 忽略 */
  }
  return next
}

export function resetPlatformSettings(): PlatformSettings {
  const fresh = makeDefaultSettings()
  try {
    localStorage.removeItem(SETTINGS_STORAGE_KEY)
  } catch {
    /* 忽略 */
  }
  return fresh
}

/* ============ 通用 helpers ============ */
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export const mockHelpers = {
  isMock: () => USE_MOCK,
  getGoodsCache: () => _goodsCache,
  setGoodsCache: (g: Goods[]) => (_goodsCache = g),
  getMyGoodsCache: () => _myGoodsCache,
  setMyGoodsCache: (g: Goods[]) => (_myGoodsCache = g),
  getOrderCache: () => _orderCache,
  setOrderCache: (o: Order[]) => (_orderCache = o),
  /**
   * 追加一条订单操作日志（**倒序**存储：最新在前）。
   *
   * 日志必须由「真正改状态的那个函数」来写，不能靠前端拼 ——
   * 前端拼的日志在批量操作、接口直调（如后台点了批量发货）时就会漏记，
   * 事后追溯变成一笔糊涂账。所以统一在这里记账。
   */
  pushOrderLog: (o: Order, entry: Omit<OrderLog, 'id'>) => {
    const maxId = (o.logs ?? []).reduce((m, l) => Math.max(m, l.id), 0)
    o.logs = [{ id: maxId + 1, ...entry }, ...(o.logs ?? [])]
  },
  /** 补齐承运商 / 物流轨迹 / 操作日志（新建订单、改状态后共用） */
  refreshOrderHistory: (o: Order) => withOrderHistory(o),
  /** 承运商池（后台发货时可选项） */
  carriers: () => CARRIERS.slice(),
  getFavorites: () => _favoritesCache,
  setFavorites: (f: Favorite[]) => (_favoritesCache = f),
  getHistory: () => _historyCache,
  setHistory: (h: HistoryItem[]) => (_historyCache = h),
  getComments: () => _commentsCache,
  setComments: (c: GoodsComment[]) => (_commentsCache = c),
  getReviews: () => _reviewsCache,
  setReviews: (r: Review[]) => (_reviewsCache = r),
  getReports: () => _reportsCache,
  setReports: (r: Report[]) => (_reportsCache = r),
  getAddresses: () => _addressesCache,
  setAddresses: (a: Address[]) => (_addressesCache = a),
  getSessions: () => _sessionsCache,
  setSessions: (s: ChatSession[]) => (_sessionsCache = s),
  getMessages: () => _messagesCache,
  setMessages: (m: ChatMessage[]) => (_messagesCache = m),
  nextMessageId: () => Math.max(0, ..._messagesCache.map((x) => x.id)) + 1,
  getActivityDisplay,
  getActiveActivities,
  listActivityDisplays,
  activityDisplayOf,
  getActivityById: (id: string) => _activitiesCache.find((a) => a.id === id),
  createActivity,
  updateActivity,
  deleteActivity,
  setActivityEnabled,
  cancelActivity,
  restartActivity,
  resetActivities,
  getCategoriesCache: () => mockCategoriesCache.get(),
  setCategoriesCache: (c: Category[]) => mockCategoriesCache.set(c),
  countGoodsByCategory,
  getUsersCache: () => mockUsers,
  getAuditLogs,
  addAuditLog,
  clearAuditLogs,
  getPlatformSettings,
  savePlatformSettings,
  resetPlatformSettings,
  delay
}

/* ============ 对外导出（业务API层使用） ============ */
export const mockUsersExport = mockUsers
