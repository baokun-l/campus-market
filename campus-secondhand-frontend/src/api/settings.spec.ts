/**
 * 平台参数 API · 单测
 *
 * 本文件只锁「商品自动下架」这一项 —— 其余 7 项参数是纯 K/V 存取，
 * 存取本身没有可断言的语义（真正的判断在「谁读它」，那是后端的事）。
 *
 * ★ 为什么单测要盯着 Mock 分支 ★
 * 这两个函数在 `.env.test`（VITE_USE_MOCK=true）下走的是 Mock 分支。
 * Mock 很容易被写成「返回一个看起来合理的数字」—— 那样测试会全绿，
 * 而 Mock 下的行为与真实后端**根本不是一回事**：
 *   · `previewAutoOffline` 报「3 件会被下架」，
 *   · 而 `runAutoOffline` 一件都没改（或改了另外 3 件）。
 * 前端于是在 Mock 下「看起来对、实际对不上」，直到接上真后端才暴露。
 * 本项目反复在抓的正是这一类缺陷，所以下面用**行为断言**而不是返回值断言：
 * 每次都要回到 `getGoodsCache()` 去看那几件商品的状态到底变没变。
 *
 * ★ 为什么用「只差一个维度」的四件商品 ★
 * 一件「该被下架」的商品，与它差一个维度的邻居有三种：
 * ① 时间够久但状态不是 on_sale（pending / sold）；
 * ② 状态是 on_sale 但时间不够久；
 * ③ 两个都不满足。
 * 只断言「命中的那件变了」是**没有判别力**的 —— 一个把所有商品都下架的实现
 * 照样能通过。必须同时断言三个邻居一件都没动。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { previewAutoOffline, runAutoOffline, fetchSettings } from '@/api/settings'
import { mockHelpers } from '@/api/mock'
import type { Goods } from '@/types'

const DAY = 86400_000

/** 构造一件只关心「状态 + 发布时间」的商品 */
function makeGoods(id: number, status: Goods['status'], ageDays: number): Goods {
  return {
    id,
    title: `商品${id}`,
    price: 50,
    cover: '/goods/cat1-1.jpg',
    images: [],
    description: '九成新',
    status,
    categoryId: 1,
    categoryName: '教材（旧书）',
    sellerId: 2,
    sellerName: '旧书摊李同学',
    sellerAvatar: '',
    location: '东区',
    viewCount: 0,
    favoriteCount: 0,
    createTime: new Date(Date.now() - ageDays * DAY).toISOString()
  }
}

const statusOf = (id: number) => mockHelpers.getGoodsCache().find((g) => g.id === id)!.status

/** 审计日志是模块内存态（不受 localStorage.clear() 影响），所以一律用增量断言 */
const auditCount = (action: string) =>
  mockHelpers.getAuditLogs().filter((l) => l.action === action).length

beforeEach(() => {
  localStorage.clear()
  // 四件「只差一个维度」的商品：只有 id=1 该被「30 天」的规则命中
  mockHelpers.setGoodsCache([
    makeGoods(1, 'on_sale', 45), // ← 唯一命中的
    makeGoods(2, 'on_sale', 1), // 太新
    makeGoods(3, 'pending', 45), // 时间够久但不是在售
    makeGoods(4, 'sold', 45), // 时间够久但已售出
    makeGoods(5, 'off_shelf', 45) // 时间够久但已下架（重复下架不该被计入）
  ])
  mockHelpers.savePlatformSettings({ autoOfflineDays: 30 })
})

/* ---------------- ① 预览：只数，不改 ---------------- */
describe('previewAutoOffline · 预览只读', () => {
  it('按已保存的天数算出将下架件数，且一件都不改', async () => {
    const r = await previewAutoOffline()
    expect(r.days).toBe(30)
    expect(r.count).toBe(1)

    // 预览是只读的 —— 这条断言就是「预览按钮不会误伤」的全部依据
    expect(statusOf(1)).toBe('on_sale')
    expect(statusOf(2)).toBe('on_sale')
    expect(statusOf(3)).toBe('pending')
    expect(statusOf(4)).toBe('sold')
    expect(statusOf(5)).toBe('off_shelf')
  })

  it('天数与 fetchSettings 同一口径（不会各读各的）', async () => {
    const r = await previewAutoOffline()
    const s = await fetchSettings()
    expect(r.days).toBe(s.autoOfflineDays)
  })

  it('天数越大命中越少：改成 60 天后那件 45 天的商品不再命中', async () => {
    mockHelpers.savePlatformSettings({ autoOfflineDays: 60 })
    const r = await previewAutoOffline()
    expect(r.days).toBe(60)
    expect(r.count).toBe(0)
  })

  /*
   * ★ 0 的两义性 ★
   * `days=0` 表示「功能被关闭」，返 0；「没有超期商品」也返 0。
   * 两个 0 长得一样、含义完全相反，界面上必须能区分 ——
   * 所以 days 字段必须跟着返回来，而不是只返 count。
   * 若这里把 days 也当成「命中数」返 0，管理员就永远分不清
   * 「我配的 0 生效了」和「配了 30 天但恰好没有超期商品」。
   */
  it('配置为 0：count 为 0 且 days 如实回传 0（与「没有超期商品」可区分）', async () => {
    mockHelpers.savePlatformSettings({ autoOfflineDays: 0 })
    const r = await previewAutoOffline()
    expect(r).toEqual({ days: 0, count: 0 })
    expect(statusOf(1)).toBe('on_sale')
  })
})

/* ---------------- ② 执行：真的改，且只改该改的 ---------------- */
describe('runAutoOffline · 立即执行', () => {
  it('命中一件就只改这一件，三个邻居一动不动', async () => {
    const before = auditCount('goods.auto_offline')
    const r = await runAutoOffline()
    expect(r.days).toBe(30)
    expect(r.count).toBe(1)

    expect(statusOf(1)).toBe('off_shelf') // 该改的改了
    expect(statusOf(2)).toBe('on_sale') // 太新的没动
    expect(statusOf(3)).toBe('pending') // 待审的没动
    expect(statusOf(4)).toBe('sold') // 已售出的没动
    expect(statusOf(5)).toBe('off_shelf') // 本来就下架的没被重复处理

    expect(auditCount('goods.auto_offline')).toBe(before + 1)
  })

  it('幂等：同一批数据再执行一次，下架 0 件且状态不变', async () => {
    await runAutoOffline()
    const before = auditCount('goods.auto_offline')

    const again = await runAutoOffline()
    expect(again.count).toBe(0)
    expect(statusOf(1)).toBe('off_shelf')
    // 0 件时不写审计：否则每天一条「下架 0 件」会把真正有事的那天淹掉
    expect(auditCount('goods.auto_offline')).toBe(before)
  })

  it('配置为 0 时一件都不改（关闭是关闭，不是「全部下架」）', async () => {
    mockHelpers.savePlatformSettings({ autoOfflineDays: 0 })
    const r = await runAutoOffline()
    expect(r).toEqual({ days: 0, count: 0 })
    expect(statusOf(1)).toBe('on_sale')
    expect(statusOf(3)).toBe('pending')
  })

  it('审计内容指向这次动作：动作标识与后端一致、目标写清件数', async () => {
    await runAutoOffline()
    const log = mockHelpers.getAuditLogs().find((l) => l.action === 'goods.auto_offline')!
    expect(log.actionLabel).toBe('自动下架超期商品')
    expect(log.target).toBe('1 件商品')
    expect(log.detail).toContain('30')
  })
})

/* ---------------- ③ 预览与执行必须自洽 ---------------- */
describe('预览与执行的口径一致', () => {
  /*
   * 这条是本文件存在的核心理由：
   * 「预览说会下架 N 件」而「执行实际下架 M 件」时 N ≠ M，
   * 是这类「先预览再确认」的交互最致命的失效方式 ——
   * 管理员看着预览的件数按下了确认，改的却是另一批商品。
   */
  it('预览报几件，执行就下架几件', async () => {
    const p = await previewAutoOffline()
    const r = await runAutoOffline()
    expect(r.count).toBe(p.count)
    expect(r.days).toBe(p.days)
  })

  it('连着做三次预览，件数不因预览次数变化（预览无副作用）', async () => {
    const a = await previewAutoOffline()
    await previewAutoOffline()
    const c = await previewAutoOffline()
    expect(c.count).toBe(a.count)
    expect(statusOf(1)).toBe('on_sale')
  })
})
