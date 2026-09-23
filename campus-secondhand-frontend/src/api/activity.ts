/**
 * 限时活动 API（多活动 · 首页 Banner / 管理后台 / 卖家报名）
 *
 * ★ 本文件已从「纯前端 mock」改为真实后端调用 ★
 *
 * 改动前的状态是：活动**完全活在前端 localStorage 里**（`mockHelpers`），
 * 后端既没有活动表也没有活动接口。于是有四个后果：
 *   ① 换浏览器 / 换设备 / 清缓存，活动就没了，管理员改的活动别人看不到；
 *   ② `/admin/overview` 的 `activeActivities` 只能是硬编码 0；
 *   ③ 卖家报名活动时的让利力度由客户端自己算 —— 服务端无从校验，也没法否认；
 *   ④ 「结束主推活动」这类操作只在这台机器上生效。
 *
 * 现在活动是**服务端数据**：`/activities` 系列接口（后端 `ActivityController`）+
 * 状态与倒计时由服务端时钟判定（见 `ActivityDisplay.state`）。
 *
 * ── 两种数据源怎么共存 ───────────────────────────────────────────
 * `VITE_USE_MOCK=true`（默认关）时仍走 `mockHelpers`，让离线演示与单测可用；
 * 否则走 HTTP。**同步**的让利解析函数（`resolve*`）无法 await，所以真实模式
 * 下它们读的是本模块的 `frontDisplays` 缓存，由 `ensureActivitiesLoaded()` 填充 ——
 * 发布页 / 商品详情页在 `onMounted` 里 await 一次即可，缓存是响应式的，
 * 与它相关的 computed 会在数据到达后自动重算。
 */
import { ref } from 'vue'
import { request } from './request'
import { mockHelpers, DEFAULT_ACTIVITY_DAYS } from './mock'
import type { ActivityConfig, ActivityDisplay, ActivityTheme, ActivityDiscountClaim } from './mock'
import type { FundSource } from '@/types'

export type { ActivityConfig, ActivityDisplay, ActivityState, ActivityTheme, ActivityDiscountClaim } from './mock'

const USE_MOCK = import.meta.env.VITE_USE_MOCK === 'true'

/** 新建 / 编辑活动的入参（id 与 createTime 由数据层生成） */
export interface ActivityInput {
  title: string
  subtitle?: string
  ctaText?: string
  ctaLink?: string
  highlights?: string[]
  icon?: string
  theme?: ActivityTheme
  priority?: number
  durationDays?: number
  startAt?: number
  enabled?: boolean
  /** 谁承担让利成本（卖家让利 / 平台补贴） */
  fundSource?: FundSource
  /** 对外声明的让利清单（分类 + 最低折扣）；不涉及改价的活动传空数组 */
  claims?: ActivityDiscountClaim[]
  note?: string
  /** 传 undefined 表示「清空下架记录」（重新上架时用） */
  cancelledAt?: number
  cancelledBy?: string
}

/** 空态占位：无任何活动时用，避免模板里到处写可选链 */
export const EMPTY_ACTIVITY_DISPLAY: ActivityDisplay = {
  config: {
    id: '',
    enabled: false,
    startAt: 0,
    durationDays: 0,
    title: '',
    subtitle: '',
    ctaText: '',
    ctaLink: '/goods',
    highlights: [],
    icon: '',
    theme: 'orange',
    priority: 0,
    fundSource: 'seller',
    claims: [],
    createTime: 0,
    updateTime: 0
  },
  state: 'cancelled',
  expiresAt: 0,
  remainingMs: 0,
  shouldShow: false
}

/* ====================================================================
 * 前台活动缓存（真实模式下同步解析让利归属的数据源）
 * ==================================================================== */

/** 前台可展示活动（active + pending，服务端已按优先级降序排好） */
const frontDisplays = ref<ActivityDisplay[]>([])

/** 是否已从服务端加载过（真实模式用；mock 模式始终直读 mockHelpers） */
let frontLoaded = false
/** 并发去重：首页 Banner 与 Aside 可能同时触发加载 */
let inflight: Promise<ActivityDisplay[]> | null = null

/**
 * 同步读取「前台可展示活动」。
 *
 * mock 模式直接读 `mockHelpers`（单测会在改动后立刻同步断言，读缓存会拿到旧值）；
 * 真实模式读接口填充的响应式缓存。
 */
function frontList(): ActivityDisplay[] {
  return USE_MOCK ? mockHelpers.getActiveActivities() : frontDisplays.value
}

/**
 * 确保前台活动已加载（真实模式下每个页面只需 await 一次）。
 *
 * @param force 强制重新拉取；写操作后用它刷新缓存
 */
export async function ensureActivitiesLoaded(force = false): Promise<ActivityDisplay[]> {
  if (USE_MOCK) {
    const list = mockHelpers.getActiveActivities()
    frontDisplays.value = list
    frontLoaded = true
    return list
  }
  if (!force && frontLoaded) return frontDisplays.value
  if (inflight && !force) return inflight
  inflight = request<ActivityDisplay[]>({ url: '/activities/active', showLoading: false })
    .then((list) => {
      frontDisplays.value = list ?? []
      frontLoaded = true
      return frontDisplays.value
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

/**
 * 写操作后刷新缓存：**失败不抛出**。
 *
 * 缓存刷新只是为了让「首页 Banner / 发布页的让利选项」及时跟上，
 * 写操作本身已经成功；如果这里把异常抛出去，调用方会把
 * 「已保存成功」显示成失败，反而误导管理员再操作一遍。
 */
async function refreshFrontCache(): Promise<void> {
  try {
    await ensureActivitiesLoaded(true)
  } catch {
    /* 忽略：下一次进入页面时 ensureActivitiesLoaded() 仍会重新拉取 */
  }
}

/* ====================================================================
 * 读接口
 * ==================================================================== */

/** 拉取主推活动（首页 Banner 用；无进行中活动时回落列表首位） */
export async function fetchActivity(): Promise<ActivityDisplay> {
  if (USE_MOCK) {
    await mockHelpers.delay(80)
    return mockHelpers.getActivityDisplay()
  }
  const d = await request<ActivityDisplay>({ url: '/activities/current', showLoading: false })
  return d ?? EMPTY_ACTIVITY_DISPLAY
}

/** 拉取前台可展示的活动（active / pending，按优先级降序）—— 多活动轮播用 */
export async function fetchActiveActivities(): Promise<ActivityDisplay[]> {
  if (USE_MOCK) {
    await mockHelpers.delay(80)
    return mockHelpers.getActiveActivities()
  }
  // 不用 ensureActivitiesLoaded()：Banner 每次进来都该拿到最新状态
  // （活动可能刚到期，而缓存里还是 10 分钟前的 active）
  return ensureActivitiesLoaded(true)
}

/** 拉取全部活动（管理后台列表用，含已下架 / 已到期） */
export async function fetchActivities(): Promise<ActivityDisplay[]> {
  if (USE_MOCK) {
    await mockHelpers.delay(120)
    return mockHelpers.listActivityDisplays()
  }
  const list = await request<ActivityDisplay[]>({ url: '/activities', showLoading: false })
  // 顺手喂一次前台缓存：管理员刚改完活动，回到首页 Banner 不该还是旧数据
  frontDisplays.value = (list ?? []).filter((d) => d.shouldShow)
  frontLoaded = true
  return list ?? []
}

/* ====================================================================
 * 写接口（后端仅 admin 可调，见 AuthInterceptor 的角色分区）
 * ==================================================================== */

/** 新建活动（默认上架；未传 startAt 则从现在开始计时） */
export async function createActivity(payload: ActivityInput): Promise<ActivityConfig> {
  if (USE_MOCK) {
    await mockHelpers.delay(160)
    const created = mockHelpers.createActivity(payload)
    mockHelpers.addAuditLog({
      action: 'activity.create',
      actionLabel: '新建活动',
      target: `活动「${created.title}」`,
      detail: `${created.durationDays} 天 · 优先级 ${created.priority} · ${created.enabled ? '立即上架' : '存为草稿'}`
    })
    return created
  }
  const created = await request<ActivityConfig>({ url: '/admin/activities', method: 'POST', data: payload })
  await refreshFrontCache()
  return created
}

/** 编辑活动（局部更新） */
export async function updateActivity(id: string, patch: Partial<ActivityInput>): Promise<ActivityConfig> {
  if (USE_MOCK) {
    await mockHelpers.delay(160)
    const updated = mockHelpers.updateActivity(id, patch)
    mockHelpers.addAuditLog({
      action: 'activity.update',
      actionLabel: '编辑活动',
      target: `活动「${updated.title}」`,
      detail: Object.keys(patch).join('、')
    })
    return updated
  }
  const updated = await request<ActivityConfig>({ url: `/admin/activities/${id}`, method: 'PATCH', data: patch })
  await refreshFrontCache()
  return updated
}

/**
 * 上架 / 下架活动。
 *
 * `by` 只用于 mock 模式的日志；真实模式下操作人由后端从 JWT 里取
 * （客户端传谁就是谁，等于让操作日志失去意义，所以服务端不采信请求体里的名字）。
 */
export async function setActivityEnabled(id: string, enabled: boolean, by = 'admin'): Promise<ActivityConfig> {
  if (USE_MOCK) {
    await mockHelpers.delay(140)
    const updated = mockHelpers.setActivityEnabled(id, enabled, by)
    mockHelpers.addAuditLog({
      action: enabled ? 'activity.online' : 'activity.offline',
      actionLabel: enabled ? '上架活动' : '下架活动',
      target: `活动「${updated.title}」`,
      detail: `ID ${id}`,
      operator: by
    })
    return updated
  }
  const updated = await request<ActivityConfig>({
    url: `/admin/activities/${id}/enabled`,
    method: 'POST',
    data: { enabled }
  })
  await refreshFrontCache()
  return updated
}

/** 删除活动 */
export async function deleteActivity(id: string): Promise<boolean> {
  if (USE_MOCK) {
    await mockHelpers.delay(140)
    const before = mockHelpers.getActivityById(id)
    const ok = mockHelpers.deleteActivity(id)
    if (ok) {
      mockHelpers.addAuditLog({
        action: 'activity.delete',
        actionLabel: '删除活动',
        target: `活动「${before?.title ?? id}」`,
        detail: `ID ${id}`
      })
    }
    return ok
  }
  const ok = await request<boolean>({ url: `/admin/activities/${id}`, method: 'DELETE' })
  await refreshFrontCache()
  return ok
}

/**
 * 兼容旧接口：结束「主推活动」。
 * 后端自己解析「当前主推是哪条」，不接受客户端传 id ——
 * 否则「结束主推活动」会变成「结束任意活动」。
 */
export async function cancelActivity(by?: string): Promise<ActivityConfig> {
  if (USE_MOCK) {
    await mockHelpers.delay(120)
    const updated = mockHelpers.cancelActivity(by)
    mockHelpers.addAuditLog({
      action: 'activity.offline',
      actionLabel: '下架活动',
      target: `活动「${updated.title}」`,
      detail: '提前结束（主推活动）',
      operator: by || 'admin'
    })
    return updated
  }
  const updated = await request<ActivityConfig>({ url: '/admin/activities/close', method: 'POST' })
  await refreshFrontCache()
  return updated
}

/** 兼容旧接口：重新开启「主推活动」（默认 14 天，倒计时重置） */
export async function restartActivity(durationDays = DEFAULT_ACTIVITY_DAYS): Promise<ActivityConfig> {
  if (USE_MOCK) {
    await mockHelpers.delay(120)
    const updated = mockHelpers.restartActivity(durationDays)
    mockHelpers.addAuditLog({
      action: 'activity.online',
      actionLabel: '上架活动',
      target: `活动「${updated.title}」`,
      detail: `重新开启 ${durationDays} 天，倒计时已重置`
    })
    return updated
  }
  const updated = await request<ActivityConfig>({
    url: '/admin/activities/restart',
    method: 'POST',
    data: { durationDays }
  })
  await refreshFrontCache()
  return updated
}

/** 恢复出厂活动列表（清掉服务端对活动的全部改动） */
export async function resetActivities(): Promise<ActivityConfig[]> {
  if (USE_MOCK) {
    await mockHelpers.delay(120)
    const list = mockHelpers.resetActivities()
    mockHelpers.addAuditLog({
      action: 'activity.reset',
      actionLabel: '恢复出厂活动',
      target: `${list.length} 个活动`,
      detail: '清除本地对活动的全部改动'
    })
    return list
  }
  const list = await request<ActivityConfig[]>({ url: '/admin/activities/reset', method: 'POST' })
  await refreshFrontCache()
  return list
}

/* ====================================================================
 * 展示与解析（纯函数 / 同步）
 * ==================================================================== */

/** 把毫秒格式化成 "DD天 HH:MM:SS"（倒计时显示） */
export function formatCountdown(remainingMs: number): string {
  if (remainingMs <= 0) return '00天 00:00:00'
  const secTotal = Math.floor(remainingMs / 1000)
  const days = Math.floor(secTotal / 86400)
  const hours = Math.floor((secTotal % 86400) / 3600)
  const minutes = Math.floor((secTotal % 3600) / 60)
  const seconds = secTotal % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(days)}天 ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
}

/**
 * 查某个分类商品的让利成本承担方。
 *
 * 逻辑：在「进行中 / 待开始」的活动里，找声明覆盖了该分类的那一条，取其 `fundSource`。
 * 找不到则回落 `seller`（宁可说成卖家让利，也不能替平台揽功或替卖家做主）。
 *
 * ⚠️ **一个分类可能同时被多条活动声明让利**（如「开学季特卖（卖家让利）」与
 *    「宿舍焕新补贴周（平台补贴）」都覆盖生活用品）。此时按分类反查只能给出
 *    **优先级最高的那一条**，未必是这件商品真正报名的那条 —— 所以
 *    **结算具体商品时必须用 `resolveFundSourceForGoods()`**，它优先认商品自己的
 *    `activityId`。本函数只用于「没有 activityId 可依据」的场合（分类级统计、兜底）。
 *
 * 注：这是**同步**解析，读的是活动缓存 —— 真实模式下请先
 * `await ensureActivitiesLoaded()`，否则缓存还是空数组（会一律回落到 seller）。
 * 更稳妥的做法是消费后端在商品/订单里下发的 `fundSource` 字段（服务端已按同一规则写入）。
 */
export function resolveFundSourceByCategory(categoryId: number): FundSource {
  return resolvePromoClaimByCategory(categoryId)?.fundSource ?? 'seller'
}

/**
 * 一件商品的让利归属 —— **结算场景的唯一入口**。
 *
 * 判定顺序（顺序本身就是约束）：
 *   ① 商品带 `activityId`（= 卖家发布时选定的那条活动）→ 认它，且只认它；
 *   ② 解析不到（活动已被删除 / 下架 / 到期）→ **保守回落 `seller`**；
 *   ③ 只有商品**完全没有** `activityId`（老数据）才按分类反查。
 *
 * 为什么必须优先认 `activityId`：同一分类可挂多条活动，而它们的 `fundSource`
 * 可能不同（一个卖家让利、一个平台补贴）。若一律按分类反查，商品报名的是
 * 「平台补贴」，结算却可能记成「卖家让利」→ 后台 GMV 会把平台掏的钱算到卖家头上，
 * 卖家看到的「实收」也会凭空变少。这是报价类系统里最不能接受的一类错误。
 *
 * ⚠️ 为什么「查不到时回落到 seller」而不是「回落到分类反查」：
 *    `activityId` 一旦存在，就说明这单让利的**归属已被那次报名锁定**了。
 *    此时回落到分类反查，恰好会命中同分类下**另一条** fundSource 可能相反的活动 ——
 *    这正是上面那段要防的错误，只是换了个入口重新犯一遍：
 *    商品报名「开学季（卖家让利）」，管理员把开学季删掉后，
 *    分类反查命中仍然有效的「宿舍焕新（平台补贴）」→ 平台凭空多出一笔它从未承诺的支出。
 *    所以锁定过就要认账，宁可少声称平台补贴，也不替平台揽账。
 *
 * ⚠️ 后端 `OrderService.createOrder()` 用的是**同一条规则**（`ActivityService.fundSourceFor()`），
 *    订单落库的 `fundSource` 才是权威口径；本函数服务于发布页预览与前端展示。
 */
export function resolveFundSourceForGoods(g: { activityId?: string; categoryId: number }): FundSource {
  if (g.activityId) {
    const hit = resolveClaimByActivityId(g.activityId, g.categoryId)
    // 锁定过的活动解析不到 → 只可能是卖家让利，绝不借分类反查改写归属
    return hit ? hit.fundSource : 'seller'
  }
  return resolveFundSourceByCategory(g.categoryId)
}

/** 某个分类命中的让利声明（连同它所属活动的上下文） */
export interface PromoClaimHit {
  activityId: string
  /** 活动主标题（报名控件要显示「参加《XXX》」） */
  title: string
  /** 该分类的折扣率（0.5 = 最高 5 折，即该分类最深力度） */
  rate: number
  fundSource: FundSource
}

/**
 * 按分类在**可展示的活动**里找让利声明 —— 报名控件与结算口径的唯一查找入口。
 *
 * 为什么要有它：卖家报名时要知道「能参加哪个活动、最高几折、谁掏钱」，
 * 而结算时要知道「这笔折扣记谁头上」。两者若各查一遍，就会出现
 * 「报名控件说有活动、结算却说没有」的错位。
 *
 * 返回 null 表示该分类当前**没有**任何活动声明让利 ——
 * 也就是「这件商品无法参与活动，只能按挂牌价成交」。
 *
 * ⚠️ 一个分类可能有**多条**声明，本函数只返回优先级最高的那条。
 *    发布页要列全部可选项时请用 `resolveJoinableClaimsByCategory()`。
 */
export function resolvePromoClaimByCategory(categoryId: number): PromoClaimHit | null {
  return findPromoClaims(categoryId, false)[0] ?? null
}

/**
 * 报名专用查找：只认**进行中（active）**的活动。
 *
 * 与结算口径的区别（这是刻意的，不要合并）：
 *   - 结算允许「进行中 + 待开始」，因为 `resolveFundSourceByCategory()` 一直是这个口径；
 *   - 而**报名**不能允许待开始的活动：它还没生效，一旦让卖家报名成功就会立刻在
 *     商品上写出让利价 → 变成「活动还没开始，商品就在打折」，正是我们在
 *     `digital-refresh-week` 那次修掉的同类问题（见设计文档 8.2 缺陷①）。
 *
 * 后端 `GoodsService.applyPromoPricing()` 用的是同一条口径（只认 active）：
 * 前端过滤得再干净也只是体验，真正的闸门在服务端。
 */
export function resolveJoinableClaimByCategory(categoryId: number): PromoClaimHit | null {
  return findPromoClaims(categoryId, true)[0] ?? null
}

/**
 * 按分类列出**全部**可报名的活动声明（只认进行中），按活动优先级降序。
 *
 * 用途：发布页「活动让利」要把能参加的活动**全列出来**，但只允许选一个。
 * 为什么是「全列 + 单选」而不是「只给一个」：
 *   - 只给一个时，卖家并不知道还有别的活动可选，「参加活动」这件事被平台替他决定了；
 *   - 而让利价只有一个字段（`Goods.promoPrice`），一件商品本来就**不可能同时**
 *     享受两条活动的折扣（那就成了叠加打折，也分不清是谁掏的钱）→ 必须单选。
 */
export function resolveJoinableClaimsByCategory(categoryId: number): PromoClaimHit[] {
  return findPromoClaims(categoryId, true)
}

/**
 * 结算口径：按**活动 id + 分类**反查商品的让利声明。
 *
 * 与 `resolveJoinableClaimsByCategory()` 的区别是口径更宽（含待开始的活动）：
 * 商品一旦报名成功就带着 `activityId`，这条线索比分类更精确，不该因为
 * 「活动从 active 变成 pending」就查不到（那会把卖家实收算错）。
 */
export function resolveClaimByActivityId(activityId: string, categoryId: number): PromoClaimHit | null {
  if (!activityId) return null
  const hit = frontList().find((d) => d.config.id === activityId)
  if (!hit) return null
  const claim = hit.config.claims.find((c) => c.categoryId === categoryId)
  if (!claim) return null
  return {
    activityId: hit.config.id,
    title: hit.config.title,
    rate: claim.rate,
    fundSource: hit.config.fundSource
  }
}

/** 两个口径共用的查找实现（复数版：同一分类可命中多条活动） */
function findPromoClaims(categoryId: number, onlyActive: boolean): PromoClaimHit[] {
  const out: PromoClaimHit[] = []
  // 活动列表已按「优先级降序」排好（服务端排序，前端不再重排），所以结果顺序即展示顺序
  for (const d of frontList()) {
    if (onlyActive && d.state !== 'active') continue
    const claim = d.config.claims.find((c) => c.categoryId === categoryId)
    if (!claim) continue
    out.push({
      activityId: d.config.id,
      title: d.config.title,
      rate: claim.rate,
      fundSource: d.config.fundSource
    })
  }
  return out
}

/**
 * 当前**可报名**的分类 id 列表（去重）。
 *
 * 用途：发布页在「当前分类暂无活动」时，把有活动的分类直接列给卖家
 * （「目前有活动的分类：📚 教材 / 🎮 数码，切换分类即可报名」）。
 * 没有它，卖家只能靠猜为什么这个框是空的。
 *
 * 与报名口径同源（同样只认 active），所以列表里出现的分类一定真的能报名。
 */
export function joinableCategoryIds(): number[] {
  const ids = new Set<number>()
  for (const d of frontList()) {
    if (d.state !== 'active') continue
    for (const c of d.config.claims) ids.add(c.categoryId)
  }
  return [...ids].sort((a, b) => a - b)
}

/** 活动状态 → 中文标签 */
export function activityStateLabel(state: ActivityDisplay['state']): string {
  return { active: '进行中', pending: '待开始', expired: '已到期', cancelled: '已取消' }[state]
}

/** 活动状态 → el-tag 类型 */
export function activityStateTag(state: ActivityDisplay['state']): 'success' | 'warning' | 'info' | 'danger' {
  const map = { active: 'success', pending: 'warning', expired: 'info', cancelled: 'danger' } as const
  return map[state]
}

/** 活动主题 → 色板（后台列表用色点区分，与前台 Banner 保持一致） */
export const ACTIVITY_THEME_META: Record<ActivityTheme, { label: string; color: string }> = {
  orange: { label: '暖橙', color: '#ff6a00' },
  blue: { label: '科技蓝', color: '#2563eb' },
  green: { label: '清新绿', color: '#10b981' },
  purple: { label: '典雅紫', color: '#7c3aed' }
}
