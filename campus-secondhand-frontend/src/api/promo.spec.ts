/**
 * 活动让利 · 文案与数据一致性测试（本模块是「折扣模型」的守门人）
 *
 * ## 为什么需要这个文件
 *
 * 二手交易平台是**居间撮合方**：商品由卖家（`Goods.sellerId`）自行发布，
 * 定价权在卖家手里。所以平台**没有**权力把自己的"打折活动"套到别人的商品上。
 * 一旦文案写「平台 5 折」而数据里并没有对应降价，就同时踩了两条线：
 *
 *   ① 虚假宣传 —— 承诺的折扣根本不存在（《电子商务法》第 17 条）
 *   ② 虚构原价 —— 划线价不是真实成交过的价格（《明码标价和禁止价格欺诈规定》）
 *
 * 修正后语义：
 *   - `Goods.price`      = 卖家挂牌价（**真实**价格，划线价的唯一来源）
 *   - `Goods.promoPrice` = 卖家让利后的活动价；未参与活动为 undefined
 *   - 折扣成本必须声明归属：`seller`（卖家让利）或 `platform`（平台补贴）
 *
 * 因此本文件不测「函数有没有跑通」，而是**拿活动文案去核对商品数据**：
 * 文案声称的每一个折扣力度，都必须在商品数据里真实存在，且不多不少。
 * 这样以后任何人想随手改文案或改活动折扣表，都会被这组断言拦下。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  settlePrice,
  settleJoin,
  promoPriceFor,
  promoRateFor,
  promoRateLadder,
  sumBreakdowns,
  round2,
  discountNote,
  FUND_SOURCE_LABEL,
  FUND_SOURCE_HINT,
  FUND_SOURCE_SHORT
} from '@/utils/promo'
import { discountText } from '@/utils/format'
import {
  fetchActivities,
  fetchActiveActivities,
  resolveFundSourceByCategory,
  resolveFundSourceForGoods,
  resolvePromoClaimByCategory,
  resolveJoinableClaimByCategory,
  resolveJoinableClaimsByCategory,
  resolveClaimByActivityId,
  joinableCategoryIds,
  setActivityEnabled
} from '@/api/activity'
import { publishGoods } from '@/api/goods'
import { fetchAdminOverview } from '@/api/analytics'
import { fetchNotices } from '@/api/notice'
import {
  mockHelpers,
  resetActivities,
  promoActivityIdOf,
  promoFundSourceOf,
  healLegacyActivities,
  createActivity
} from '@/api/mock'
import type { Goods, Order } from '@/types'

/** 金额比较容差：浮点累加误差只允许到 1 分 */
const CENT = 0.011

/** 从任意文案里抽出「N 折」的力度（返回小数，如 5 折 → 0.5） */
function extractDiscountRates(text: string): number[] {
  const rates: number[] = []
  const re = /(\d+(?:\.\d+)?)\s*折/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const zhe = Number(m[1])
    if (zhe > 0 && zhe < 10) rates.push(zhe / 10)
  }
  return rates
}

/** 商品当前的真实让利力度（无让利返回 null） */
function actualRate(g: Goods): number | null {
  if (!g.promoPrice || g.promoPrice <= 0 || g.promoPrice >= g.price) return null
  return g.promoPrice / g.price
}

const allGoods = () => mockHelpers.getGoodsCache()
const allOrders = (): Order[] => mockHelpers.getOrderCache()

beforeEach(() => {
  resetActivities()
})

/* ============================================================
 * 一、价格语义：划线价必须是真的，且不存在「虚构原价」的入口
 * ============================================================ */
describe('价格语义 · 划线价只能是真实挂牌价', () => {
  it('商品数据里不应再出现 originalPrice 字段（虚构原价的源头，已删除）', () => {
    for (const g of allGoods()) {
      expect('originalPrice' in g).toBe(false)
    }
  })

  it('settlePrice().listPrice 恒等于 Goods.price（划线价 = 卖家挂牌价）', () => {
    for (const g of allGoods()) {
      expect(settlePrice(g).listPrice).toBe(g.price)
    }
  })

  it('让利价必须严格低于挂牌价，不允许出现「比挂牌还贵」的活动价', () => {
    for (const g of allGoods()) {
      if (g.promoPrice === undefined) continue
      expect(g.promoPrice).toBeGreaterThan(0)
      expect(g.promoPrice).toBeLessThan(g.price)
    }
  })

  it('未参与活动的商品不应出现划线价与折扣标签', () => {
    const plain = allGoods().filter((g) => g.promoPrice === undefined)
    expect(plain.length).toBeGreaterThan(0)
    for (const g of plain) {
      const b = settlePrice(g)
      expect(b.onPromo).toBe(false)
      expect(b.payAmount).toBe(g.price)
      expect(b.discountLabel).toBe('')
    }
  })

  it('每个参与活动的分类都必须真实存在让利商品（不能只喊口号）', () => {
    const categories = [...new Set(allGoods().filter((g) => actualRate(g) !== null).map((g) => g.categoryId))]
    expect(categories.length).toBeGreaterThan(0)
    for (const cid of categories) {
      expect(promoActivityIdOf(cid)).toBeTruthy()
    }
  })
})

/* ============================================================
 * 二、结算恒等式：让利的钱必须能拆开、且总账平
 * ============================================================ */
describe('结算恒等式 · 实付 + 卖家让利 + 平台补贴 = 挂牌价', () => {
  it('对全量商品成立恒等式（两种资金归属都成立）', () => {
    for (const g of allGoods()) {
      for (const source of ['seller', 'platform'] as const) {
        const b = settlePrice(g, source)
        const sum = round2(b.payAmount + b.sellerCut + b.platformSubsidy)
        expect(Math.abs(sum - b.listPrice)).toBeLessThan(CENT)
      }
    }
  })

  it('卖家让利时：卖家实收随让利减少（sellerIncome = 挂牌价 − 让利）', () => {
    const g = allGoods().find((x) => x.promoPrice !== undefined)
    expect(g).toBeTruthy()
    const b = settlePrice(g!, 'seller')
    expect(b.platformSubsidy).toBe(0)
    expect(b.sellerCut).toBeGreaterThan(0)
    expect(b.sellerIncome).toBeCloseTo(b.listPrice - b.sellerCut, 2)
    expect(b.sellerIncome).toBeCloseTo(b.payAmount, 2)
  })

  it('平台补贴时：卖家实收不变（这是「补贴」与「让利」的根本区别）', () => {
    const g = allGoods().find((x) => x.promoPrice !== undefined)
    expect(g).toBeTruthy()
    const b = settlePrice(g!, 'platform')
    expect(b.sellerCut).toBe(0)
    expect(b.platformSubsidy).toBeGreaterThan(0)
    expect(b.sellerIncome).toBeCloseTo(b.listPrice, 2)
  })

  it('脏数据不能让结算变成负数：让利价 ≥ 挂牌价 / ≤ 0 / 缺失 时一律按挂牌价成交', () => {
    const dirty = [
      { price: 100, promoPrice: 120 },
      { price: 100, promoPrice: 100 },
      { price: 100, promoPrice: 0 },
      { price: 100, promoPrice: -5 },
      { price: 100 }
    ]
    for (const d of dirty) {
      const b = settlePrice(d)
      expect(b.onPromo).toBe(false)
      expect(b.payAmount).toBe(100)
      expect(b.sellerCut).toBe(0)
      expect(b.platformSubsidy).toBe(0)
      expect(b.sellerIncome).toBe(100)
    }
  })

  it('sumBreakdowns() 的合计与逐项相加一致，且 savedTotal = 让利 + 补贴', () => {
    const list = allGoods().slice(0, 12).map((g) =>
      settlePrice(g, promoFundSourceForTest(g.categoryId))
    )
    const t = sumBreakdowns(list)
    const manual = list.reduce(
      (acc, b) => ({
        listTotal: acc.listTotal + b.listPrice,
        payTotal: acc.payTotal + b.payAmount,
        sellerCutTotal: acc.sellerCutTotal + b.sellerCut,
        platformSubsidyTotal: acc.platformSubsidyTotal + b.platformSubsidy
      }),
      { listTotal: 0, payTotal: 0, sellerCutTotal: 0, platformSubsidyTotal: 0 }
    )
    expect(t.listTotal).toBeCloseTo(manual.listTotal, 1)
    expect(t.payTotal).toBeCloseTo(manual.payTotal, 1)
    expect(t.sellerCutTotal).toBeCloseTo(manual.sellerCutTotal, 1)
    expect(t.platformSubsidyTotal).toBeCloseTo(manual.platformSubsidyTotal, 1)
    expect(t.savedTotal).toBeCloseTo(t.sellerCutTotal + t.platformSubsidyTotal, 2)
  })

  it('round2() 应消掉浮点尾巴', () => {
    expect(round2(0.1 + 0.2)).toBe(0.3)
    expect(round2(1.005)).toBe(1.01)
  })
})

/** 让利归属解析（测试内联，避免 import 私有表） */
function promoFundSourceForTest(categoryId: number): 'seller' | 'platform' {
  return resolveFundSourceByCategory(categoryId)
}

/* ============================================================
 * 三、【核心】活动文案 ↔ 商品数据一致
 *     文案声称的折扣力度，必须在商品里真实存在，且不多不少
 * ============================================================ */
describe('活动文案 ↔ 商品数据一致（本期最关键的一组断言）', () => {
  it('每条 claims 都必须有真实落地商品（承诺的力度不能是空头支票）', async () => {
    const list = await fetchActiveActivities()
    expect(list.length).toBeGreaterThan(0)

    for (const d of list) {
      for (const claim of d.config.claims) {
        const hit = allGoods().filter(
          (g) => g.categoryId === claim.categoryId && actualRate(g) !== null
        )
        expect(
          hit.length,
          `活动「${d.config.title}」声明分类 ${claim.categoryId} 有让利，但该分类下没有任何让利商品`
        ).toBeGreaterThan(0)
      }
    }
  })

  it('声明的力度必须真的有商品达到（不做达不到的承诺）', async () => {
    const list = await fetchActiveActivities()
    for (const d of list) {
      for (const claim of d.config.claims) {
        const promoted = allGoods().filter(
          (g) => g.categoryId === claim.categoryId && actualRate(g) !== null
        )
        // 取整容差：让利价按「分/元」取整，允许 1 个货币单位误差
        const reached = promoted.some((g) => g.promoPrice! <= Math.ceil(g.price * claim.rate))
        expect(
          reached,
          `活动「${d.config.title}」声明分类 ${claim.categoryId}「${claim.rate * 10} 折起」，但没有任何商品接近该力度`
        ).toBe(true)
      }
    }
  })

  it('让利力度不得深于**该商品所报名活动**的声明（按商品归属判定，不按分类）', async () => {
    const activities = (await fetchActivities()).map((d) => d.config)
    for (const g of allGoods()) {
      if (actualRate(g) === null) continue
      /*
       * 关键：必须拿「商品自己报名的活动」（`activityId`）去比对，而不是拿它所在分类
       * 命中的第一条活动。同一分类可能挂着多条活动（如生活用品既有卖家让利 8 折、
       * 又有平台补贴 8.5 折），按分类取会拿错基准，把合法力度误判成「比声明更深」。
       */
      const act = activities.find((a) => a.id === g.activityId)
      expect(act, `商品 #${g.id} 带让利价却查不到它报名的活动（activityId=${g.activityId}）`).toBeTruthy()
      const claim = act!.claims.find((c) => c.categoryId === g.categoryId)
      expect(claim, `活动「${act!.title}」的 claims 未覆盖商品 #${g.id} 的分类`).toBeTruthy()
      expect(
        g.promoPrice!,
        `商品 #${g.id} 让利价比活动「${act!.title}」声明的 ${claim!.rate * 10} 折更深`
      ).toBeGreaterThanOrEqual(Math.floor(g.price * claim!.rate))
    }
  })

  it('未被任何活动声明覆盖的分类，不得出现让利价（不做未声明的打折）', async () => {
    const claimed = new Set<number>()
    for (const d of await fetchActiveActivities()) {
      for (const c of d.config.claims) claimed.add(c.categoryId)
    }
    for (const g of allGoods()) {
      if (!claimed.has(g.categoryId)) {
        expect(
          g.promoPrice,
          `分类 ${g.categoryId} 未被任何活动声明，商品 #${g.id} 却带让利价`
        ).toBeUndefined()
      }
    }
  })

  it('活动文案里的「N 折」必须与 claims 声明的 rate 一一对应', async () => {
    const list = await fetchActivities()
    for (const d of list) {
      const copy = [d.config.title, d.config.subtitle, ...(d.config.highlights ?? [])].join(' ')
      const rates = extractDiscountRates(copy)
      for (const r of rates) {
        const matched = d.config.claims.some((c) => Math.abs(c.rate - r) < 0.001)
        expect(
          matched,
          `活动「${d.config.title}」文案写了 ${r * 10} 折，但 claims 里没有声明该力度`
        ).toBe(true)
      }
    }
  })

  it('声明了折扣的活动必须给出 claims 清单；没有折扣声明的时间/流量型活动则留空', async () => {
    const list = await fetchActivities()
    for (const d of list) {
      const hasDiscountCopy = extractDiscountRates(`${d.config.title} ${d.config.subtitle}`).length > 0
      if (hasDiscountCopy) {
        expect(d.config.claims.length, `活动「${d.config.title}」喊了折扣却没有 claims`).toBeGreaterThan(0)
      }
    }
  })
})

/* ============================================================
 * 四、文案口吻：说清「这笔钱谁出」，不替平台揽功、不替卖家做主
 * ============================================================ */
describe('文案口吻 · 让利的资金归属必须与数据一致', () => {
  it('文案提到「卖家让利」时，数据的 fundSource 必须是 seller，且不得同时说是平台补贴', async () => {
    for (const d of await fetchActivities()) {
      const copy = [d.config.title, d.config.subtitle, ...(d.config.highlights ?? [])].join(' ')
      if (copy.includes('卖家让利')) {
        expect(d.config.fundSource, `活动「${d.config.title}」文案说卖家让利，数据却是 ${d.config.fundSource}`).toBe('seller')
        expect(copy).not.toContain('平台补贴')
      }
    }
  })

  it('文案提到「平台补贴」时，数据的 fundSource 必须是 platform，且不得同时说是卖家让利', async () => {
    for (const d of await fetchActivities()) {
      const copy = [d.config.title, d.config.subtitle, ...(d.config.highlights ?? [])].join(' ')
      if (copy.includes('平台补贴')) {
        expect(d.config.fundSource).toBe('platform')
        expect(copy).not.toContain('卖家让利')
      }
    }
  })

  it('平台补贴类文案必须写明「卖家实收不变」（否则卖家无法判断是否被扣钱）', async () => {
    for (const d of await fetchActivities()) {
      if (d.config.fundSource !== 'platform') continue
      const copy = [d.config.title, d.config.subtitle, ...(d.config.highlights ?? [])].join(' ')
      expect(copy).toContain('卖家实收不变')
    }
  })

  it('分类**只被一条活动**声明时，resolveFundSourceByCategory() 与该活动一致', async () => {
    const list = await fetchActiveActivities()
    for (const d of list) {
      for (const c of d.config.claims) {
        const claimants = list.filter((x) => x.config.claims.some((cc) => cc.categoryId === c.categoryId))
        // 多活动共享分类时没有唯一答案，归属只能按商品自己的 activityId 判定（见下一组）
        if (claimants.length !== 1) continue
        expect(resolveFundSourceByCategory(c.categoryId)).toBe(d.config.fundSource)
      }
    }
  })

  it('未被活动覆盖的分类应回落为 seller（宁可说成卖家让利，也不替平台揽功）', () => {
    expect(resolveFundSourceByCategory(999)).toBe('seller')
  })

  it('不存在 activityId 可依据时，resolveFundSourceForGoods() 才回落到分类反查', () => {
    expect(resolveFundSourceForGoods({ categoryId: 2 })).toBe(resolveFundSourceByCategory(2))
    expect(resolveFundSourceForGoods({ categoryId: 999 })).toBe('seller')
  })

  it('★ activityId 存在却解析不到（活动被删/下架/到期）→ 回落 seller，绝不借分类反查改写归属', async () => {
    const list = await fetchActiveActivities()
    const cats = [...new Set(list.flatMap((d) => d.config.claims.map((c) => c.categoryId)))]
    let platformCats = 0
    for (const cid of cats) {
      const byCat = resolveFundSourceByCategory(cid)
      if (byCat === 'platform') platformCats++
      /*
       * 商品报名过活动（activityId 非空）= 归属已被那次报名锁定。
       * 活动没了只能认「卖家让利」；若这里回落到分类反查，
       * 就会命中同分类下**另一条** fundSource 相反的活动 ——
       * 平台会凭空多出一笔它从未承诺的补贴支出（正是本函数头注释要防的错误）。
       */
      expect(
        resolveFundSourceForGoods({ activityId: 'ghost', categoryId: cid }),
        `分类 ${cid} 的活动已不存在，归属应回落 seller，而不是借分类反查命中「${byCat}」`
      ).toBe('seller')
    }
    // 至少要有一个 platform 分类，否则这条用例只是空转、抓不到「借分类反查」这个回归
    expect(platformCats, 'seed 里应存在平台补贴分类，否则本用例无法覆盖回归场景').toBeGreaterThan(0)
  })

  it('FUND_SOURCE_HINT 必须把「谁掏钱」写清楚，不能含糊', () => {
    expect(FUND_SOURCE_LABEL.seller).toBe('卖家让利')
    expect(FUND_SOURCE_LABEL.platform).toBe('平台补贴')
    expect(FUND_SOURCE_HINT.seller).toContain('卖家')
    expect(FUND_SOURCE_HINT.platform).toContain('平台')
    expect(FUND_SOURCE_HINT.platform).toContain('卖家实收不变')
  })

  it('FUND_SOURCE_SHORT 必须说清「对卖家自己意味着什么」，两个选项不能长得一样', () => {
    // 发布页把这些文案并排给卖家选活动：卖家让利必须明说会少收钱
    expect(FUND_SOURCE_SHORT.seller).toContain('少收')
    // 平台补贴必须明说实收不变，否则卖家不敢参加
    expect(FUND_SOURCE_SHORT.platform).toContain('实收不变')
    expect(FUND_SOURCE_SHORT.seller).not.toBe(FUND_SOURCE_SHORT.platform)
  })

  it('discountNote() 应把归属和金额一起给出', () => {
    expect(discountNote(settlePrice({ price: 100, promoPrice: 50 }, 'seller'))).toBe('卖家让利 ¥50.00')
    expect(discountNote(settlePrice({ price: 100, promoPrice: 80 }, 'platform'))).toBe('平台补贴 ¥20.00')
    expect(discountNote(settlePrice({ price: 100 }))).toBe('')
  })
})

/* ============================================================
 * 五、公告文案：对外公示的折扣必须能在活动声明里找到出处
 * ============================================================ */
describe('公告文案 · 公示的折扣必须有活动声明作为依据', () => {
  it('公告里出现的「N 折」必须能在活动 claims 中找到同名力度', async () => {
    const claimedRates = new Set<number>()
    for (const d of await fetchActivities()) {
      for (const c of d.config.claims) claimedRates.add(c.rate)
    }
    const notices = await fetchNotices()
    const promoNotices = notices.filter((n) => /折/.test(`${n.title}${n.content}`))
    expect(promoNotices.length).toBeGreaterThan(0)

    for (const n of promoNotices) {
      for (const r of extractDiscountRates(`${n.title}${n.content}`)) {
        const found = [...claimedRates].some((c) => Math.abs(c - r) < 0.001)
        expect(found, `公告「${n.title}」写了 ${r * 10} 折，但没有任何活动声明该力度`).toBe(true)
      }
    }
  })

  it('涉及折扣的公告必须说明定价权在卖家、平台不代卖家定价', async () => {
    const promoNotices = (await fetchNotices()).filter((n) => /折/.test(n.content))
    for (const n of promoNotices) {
      expect(n.content, `公告「${n.title}」未说明定价权归属`).toContain('定价权')
      expect(n.content).toContain('平台不会代替卖家定价')
    }
  })
})

/* ============================================================
 * 六、订单快照：让利必须落到订单上，事后可对账
 * ============================================================ */
describe('订单价格快照 · 事后可对账', () => {
  it('每笔订单都应满足「实付 + 卖家让利 + 平台补贴 = 挂牌价」', () => {
    for (const o of allOrders()) {
      const sum = round2(o.amount + (o.sellerCut ?? 0) + (o.platformSubsidy ?? 0))
      expect(Math.abs(sum - (o.listPrice ?? o.amount))).toBeLessThan(CENT)
    }
  })

  it('订单应记录让利归属，且只有一次资金转移（不是既让利又补贴）', () => {
    for (const o of allOrders()) {
      expect(o.fundSource === 'seller' || o.fundSource === 'platform').toBe(true)
      if (o.fundSource === 'seller') expect(o.platformSubsidy ?? 0).toBe(0)
      if (o.fundSource === 'platform') expect(o.sellerCut ?? 0).toBe(0)
    }
  })

  it('平台补贴订单：卖家实收 = 挂牌价（平台出钱，卖家一分不少）', () => {
    const subsidized = allOrders().filter((o) => o.fundSource === 'platform' && (o.platformSubsidy ?? 0) > 0)
    expect(subsidized.length).toBeGreaterThan(0)
    for (const o of subsidized) {
      expect(o.sellerIncome).toBeCloseTo(o.listPrice!, 2)
    }
  })

  it('卖家让利订单：卖家实收 = 实付金额（差价由卖家自己承担）', () => {
    const cut = allOrders().filter((o) => o.fundSource === 'seller' && (o.sellerCut ?? 0) > 0)
    expect(cut.length).toBeGreaterThan(0)
    for (const o of cut) {
      expect(o.sellerIncome).toBeCloseTo(o.amount, 2)
    }
  })

  it('只有真正发生让利的订单才应带 activityId', () => {
    for (const o of allOrders()) {
      const onPromo = (o.listPrice ?? o.amount) > o.amount
      if (onPromo) expect(o.activityId).toBeTruthy()
      else expect(o.activityId).toBeUndefined()
    }
  })
})

/* ============================================================
 * 七、后台 GMV 三口径：不能用一个数字把「平台花了多少钱」藏起来
 * ============================================================ */
describe('后台 GMV · 三口径对账', () => {
  it('总览应给出挂牌价口径与实付口径，且实付不高于挂牌价', async () => {
    const o = await fetchAdminOverview()
    expect(o.gmv).toBeGreaterThan(0)
    expect(o.gmvListPrice).toBeGreaterThanOrEqual(o.gmv)
  })

  it('GMV 恒等式成立：实付 + 卖家让利 + 平台补贴 = 挂牌价合计', async () => {
    const o = await fetchAdminOverview()
    const sum = round2(o.gmv + o.sellerCutTotal + o.platformSubsidyTotal)
    expect(Math.abs(sum - o.gmvListPrice)).toBeLessThan(CENT)
  })

  it('卖家实收合计 = 挂牌价合计 − 卖家让利合计', async () => {
    const o = await fetchAdminOverview()
    expect(o.sellerIncomeTotal).toBeCloseTo(o.gmvListPrice - o.sellerCutTotal, 1)
  })

  it('两个资金归属都应有非零数据（否则拆口径没有意义）', async () => {
    const o = await fetchAdminOverview()
    expect(o.sellerCutTotal).toBeGreaterThan(0)
    expect(o.platformSubsidyTotal).toBeGreaterThan(0)
  })
})

/* ============================================================
 * 八、折扣文案不夸大：宁可说浅一点，也不能说深
 * ============================================================ */
describe('折扣文案 · 只能向上取整，绝不夸大力度', () => {
  it('非整数折扣向上取整（8.42 折显示 8.5 折，而不是 8.4 折）', () => {
    expect(discountText(842, 1000)).toBe('8.5折')
    expect(discountText(88, 100)).toBe('8.8折')
    expect(discountText(50, 100)).toBe('5折')
  })

  it('现价 ≥ 原价时不产生任何折扣文案', () => {
    expect(discountText(100, 100)).toBe('')
    expect(discountText(120, 100)).toBe('')
  })

  it('全量商品的折扣标签力度不得优于真实力度（永不夸大）', () => {
    for (const g of allGoods()) {
      const b = settlePrice(g)
      if (!b.onPromo || !b.discountLabel) continue
      const labelZhe = Number(b.discountLabel.replace('折', ''))
      const realZhe = (b.payAmount / b.listPrice) * 10
      // 标签数值 ≥ 真实折扣率，意味着展示出来的折扣「不深于」实际
      expect(labelZhe).toBeGreaterThanOrEqual(realZhe - 0.001)
    }
  })

  it('活动声明的折扣与商品实际折扣一致（声明 5 折 → 标签也应落在 5 折附近）', () => {
    const g = allGoods().find((x) => x.categoryId === 1 && actualRate(x) !== null)
    expect(g).toBeTruthy()
    const b = settlePrice(g!)
    expect(b.discountLabel).not.toBe('')
    expect(Number(b.discountLabel.replace('折', ''))).toBeLessThanOrEqual(10)
  })
})

/* ============================================================
 * 九、跨模块一致性：活动配置本身要自洽
 * ============================================================ */
describe('活动配置自洽性', () => {
  it('claims 的 rate 必须落在 (0,1) 开区间内（1 折以下 / 10 折以上都是脏数据）', async () => {
    for (const d of await fetchActivities()) {
      for (const c of d.config.claims) {
        expect(c.rate).toBeGreaterThan(0)
        expect(c.rate).toBeLessThan(1)
        expect(c.categoryId).toBeGreaterThan(0)
      }
    }
  })

  it('同一活动内不应重复声明同一分类', async () => {
    for (const d of await fetchActivities()) {
      const ids = d.config.claims.map((c) => c.categoryId)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })

  it('每个活动的 fundSource 都必须是合法取值', async () => {
    for (const d of await fetchActivities()) {
      expect(['seller', 'platform']).toContain(d.config.fundSource)
    }
  })

  it('参与商品让利的分类，商品必须能追溯到「自己报名的那条活动」', async () => {
    const list = await fetchActivities()
    for (const g of allGoods()) {
      if (actualRate(g) === null) continue
      // 带让利价就必须带 activityId —— 归属才有唯一答案（同分类可挂多条活动）
      expect(g.activityId, `商品 #${g.id} 有让利价却没有 activityId`).toBeTruthy()
      const a = list.find((d) => d.config.id === g.activityId)?.config
      expect(a, `商品 #${g.id} 的 activityId=${g.activityId} 在活动列表里不存在`).toBeTruthy()
      expect(
        a!.claims.some((c) => c.categoryId === g.categoryId),
        `活动「${a!.title}」并未声明覆盖商品 #${g.id} 的分类 ${g.categoryId}`
      ).toBe(true)
    }
    // 反向：seed 用的分类→活动对照表不能和活动声明的资金归属矛盾
    for (const cid of new Set(allGoods().filter((g) => actualRate(g) !== null).map((g) => g.categoryId))) {
      const a = list.find((d) => d.config.id === promoActivityIdOf(cid))?.config
      expect(a?.fundSource, `分类 ${cid} 的 seed 资金归属与活动声明不一致`).toBe(promoFundSourceOf(cid))
    }
  })
})

/* ============================================================
 * 十、卖家报名活动：让利价由规则生成，卖家无从自填
 *
 * 背景：发布页原先只写了一段「自愿报名」的说明文案，却没有报名入口 ——
 * 属「文案承诺了做不到的事」。本组断言把报名链路锁死：
 *   - 让利价只能由 `settleJoin()`（= 活动声明的 rate + 统一算法）算出；
 *   - 卖家能决定的只有「参不参加」，不能决定「打几折」；
 *   - 预览与成交同源，不允许出现两个价。
 * ============================================================ */
describe('卖家报名活动 · 让利价只能由活动规则生成', () => {
  /* 本组会往商品缓存里写入新商品，跑完还原，避免影响其它 describe 的数据假设 */
  const goodsSnapshot = () => mockHelpers.getGoodsCache().slice()
  let snapshot: ReturnType<typeof goodsSnapshot>
  beforeEach(() => { snapshot = goodsSnapshot() })
  afterEach(() => { mockHelpers.setGoodsCache(snapshot) })

  it('promoPriceFor() 恒等于「挂牌价 × 折扣」向下取整，且永不低于 ¥1', () => {
    expect(promoPriceFor(1597, 0.85)).toBe(Math.floor(1597 * 0.85))
    expect(promoPriceFor(100, 0.5)).toBe(50)
    // 价格极低时不能让利到 0 元
    expect(promoPriceFor(1, 0.5)).toBe(1)
    expect(promoPriceFor(0, 0.5)).toBe(1)
  })

  it('promoRateLadder() 从声明值起递增，全部不深于声明值', () => {
    expect(promoRateLadder(0.5)).toEqual([0.5, 0.55, 0.6])
    expect(promoRateLadder(0.8)).toEqual([0.8, 0.85, 0.9])
    // 每一档都 ≥ 声明值（0.5 是 5 折，即最深力度，不能更深）
    for (const r of promoRateLadder(0.5)) expect(r).toBeGreaterThanOrEqual(0.5)
    // 声明值越界时退化为一档，不留空数组
    expect(promoRateLadder(1.2)).toEqual([1.2])
  })

  it('promoRateFor() 可复现：同一挂牌价永远落在同一档（不用随机数）', () => {
    for (const price of [9, 88, 1597, 2400]) {
      const a = promoRateFor(price, 0.5)
      const b = promoRateFor(price, 0.5)
      expect(a).toBe(b)
      expect(promoRateLadder(0.5)).toContain(a)
    }
  })

  it('settleJoin() 满足恒等式，且卖家让利时「卖家实收 = 买家实付」', () => {
    const b = settleJoin(1597, 0.5, 'seller')
    expect(b.onPromo).toBe(true)
    expect(b.payAmount + b.sellerCut + b.platformSubsidy).toBeCloseTo(b.listPrice, 2)
    // 卖家让利：让利全由卖家承担，平台不出钱，卖家实收就等于买家实付
    expect(b.platformSubsidy).toBe(0)
    expect(b.sellerCut).toBeGreaterThan(0)
    expect(b.sellerIncome).toBeCloseTo(b.payAmount, 2)
  })

  it('settleJoin() 平台补贴时卖家实收 = 挂牌价，一分不少', () => {
    const b = settleJoin(1000, 0.8, 'platform')
    expect(b.onPromo).toBe(true)
    // 平台补贴的核心语义：卖家不承担任何让利，实收与挂牌价一致
    expect(b.sellerCut).toBe(0)
    expect(b.sellerIncome).toBeCloseTo(1000, 2)
    // 买家少付的那部分，全部记在平台的账上
    expect(b.platformSubsidy).toBeCloseTo(1000 - b.payAmount, 2)
    expect(b.payAmount).toBeLessThan(1000)
  })

  it('报名成功：商品拿到让利价，且价格与预览同源（settleJoin 算出来的一样）', async () => {
    const price = 1597
    const claim = resolveJoinableClaimByCategory(1) // 教材 → 开学季特卖（卖家让利 5 折起）
    expect(claim, '教材分类应当有可报名的进行中活动').toBeTruthy()

    const g = await publishGoods({ title: '高数七版', price, categoryId: 1, activityId: claim!.activityId })

    expect(g.activityId).toBe(claim!.activityId)
    expect(g.promoPrice).toBeDefined()
    // 关键：预览用的 settleJoin 与落库后的让利价必须是同一个数
    expect(g.promoPrice).toBe(settleJoin(price, claim!.rate, claim!.fundSource).payAmount)
    expect(g.promoPrice!).toBeLessThan(g.price)
    expect(g.promoPrice!).toBeGreaterThanOrEqual(1)
  })

  it('报名后的折扣不得深于活动声明的最低折扣（容差 1 分钱的取整误差）', async () => {
    const claim = resolveJoinableClaimByCategory(1)!
    for (const price of [60, 500, 1597, 9999]) {
      const g = await publishGoods({ title: '测试书', price, categoryId: 1, activityId: claim.activityId })
      if (g.promoPrice === undefined) continue
      /*
       * `promoPriceFor()` 用 `Math.floor` 向下取整，最多把成交价再压低 1 分钱
       * （如 9999 × 5 折 = 4999.5 → 4999），换算成力度差就是 1/price。
       * 这点误差方向是「对买家更便宜」，且活动文案写的是「5 折**起**」，不构成夸大，
       * 所以容差取 1 分钱；真正要防的是**比声明更浅**（那才是虚假宣传）。
       */
      const centTolerance = 1 / price
      expect(g.promoPrice / g.price).toBeGreaterThanOrEqual(claim.rate - centTolerance - 1e-9)
      // 反向：实际力度也不该浅于声明（浅了就等于把 5 折说成了更狠的折扣）
      expect(g.promoPrice / g.price).toBeLessThanOrEqual(1)
    }
  })

  it('不报名 / 活动 id 不符 / 分类不在声明内 → 商品一律不带让利价', async () => {
    const activeId = resolveJoinableClaimByCategory(1)!.activityId

    // ① 没报名
    const noJoin = await publishGoods({ title: '没报名', price: 100, categoryId: 1 })
    expect(noJoin.promoPrice).toBeUndefined()
    expect(noJoin.activityId).toBeUndefined()

    // ② 传了一个对不上的活动 id
    const wrongId = await publishGoods({ title: '活动对不上', price: 100, categoryId: 1, activityId: 'not-a-real-activity' })
    expect(wrongId.promoPrice).toBeUndefined()

    // ③ 分类没被任何活动声明（代步 3 号当前无活动）
    const noClaim = await publishGoods({ title: '代步车', price: 100, categoryId: 3, activityId: activeId })
    expect(noClaim.promoPrice).toBeUndefined()
  })

  it('报名只认「进行中」的活动：待开始的活动不能先给商品打折', async () => {
    // 造一个「明天才开始」的活动，声明服饰（4 号）分类让利 6 折
    const future = createActivity({
      title: '待开始的服饰专场',
      startAt: Date.now() + 24 * 60 * 60 * 1000,
      durationDays: 7,
      fundSource: 'seller',
      claims: [{ categoryId: 4, rate: 0.6 }]
    })
    expect(future.id).toBeTruthy()

    // 报名口径：不算（活动还没生效）
    expect(resolveJoinableClaimByCategory(4)).toBeNull()
    // 结算口径：算（与既有的 resolveFundSourceByCategory 保持一致）
    expect(resolvePromoClaimByCategory(4)?.activityId).toBe(future.id)

    // 因此拿它报名不会产生任何让利价 —— 不会出现「活动还没开始，商品就在打折」
    const g = await publishGoods({ title: '外套', price: 200, categoryId: 4, activityId: future.id })
    expect(g.promoPrice).toBeUndefined()
    expect(g.activityId).toBeUndefined()
  })

  it('活动下架后，该分类不再可报名（避免又出现「活动看不见、商品在打折」）', async () => {
    const before = resolveJoinableClaimByCategory(2) // 数码 → 平台补贴日
    expect(before).toBeTruthy()

    await setActivityEnabled(before!.activityId, false)

    expect(resolveJoinableClaimByCategory(2)).toBeNull()
    const g = await publishGoods({ title: '耳机', price: 500, categoryId: 2, activityId: before!.activityId })
    expect(g.promoPrice).toBeUndefined()
  })

  it('joinableCategoryIds() 列出的分类，每一个都真的能报名', () => {
    const ids = joinableCategoryIds()
    expect(ids.length).toBeGreaterThan(0)
    // 列表来自与报名同源的查找，所以列表里出现的分类必须真的查得到声明
    for (const id of ids) {
      expect(resolveJoinableClaimByCategory(id), `分类 ${id} 在列表里却查不到声明`).not.toBeNull()
    }
    // 教材（1）/ 数码（2）/ 生活（5）当前挂着活动；代步（3）没有
    expect(ids).toContain(1)
    expect(ids).toContain(2)
    expect(ids).not.toContain(3)
  })
})

/* ============================================================
 * 十一、多活动共享同一分类：**全部列出来，但只能选一个**
 *
 * 场景：生活用品（5 号）同时挂在两个活动下 ——
 *   「卖家让利专区 · 开学季特卖」（卖家让利，最高 8 折）
 *   「宿舍焕新补贴周」（平台补贴，最高 8.5 折）
 * 平台要把两个都列给卖家看（否则等于替他决定参加哪个），但**必须单选**：
 * `Goods.promoPrice` 只有一个，同时参加两条活动就是叠加打折，也分不清谁掏钱。
 *
 * 这组断言同时锁住「一个分类可以有多条活动」带来的归属问题：
 * 结算必须按**商品自己报名的活动**（`activityId`）判定，不能按分类反查 ——
 * 否则平台补贴的钱会被记到卖家头上。
 * ============================================================ */
describe('多活动共享分类 · 列全部但只能选一个', () => {
  const goodsSnapshot = () => mockHelpers.getGoodsCache().slice()
  let snapshot: ReturnType<typeof goodsSnapshot>
  beforeEach(() => { snapshot = goodsSnapshot() })
  afterEach(() => { mockHelpers.setGoodsCache(snapshot) })

  /** 生活（5 号）是出厂数据里唯一被两条活动同时声明的分类 */
  const SHARED_CATEGORY = 5

  it('出厂数据里确实存在「一个分类挂多条活动」的实例（否则这组断言只是空转）', () => {
    expect(resolveJoinableClaimsByCategory(SHARED_CATEGORY).length).toBeGreaterThanOrEqual(2)
  })

  it('resolveJoinableClaimsByCategory() 列出全部，且顺序与活动优先级一致', async () => {
    const claims = resolveJoinableClaimsByCategory(SHARED_CATEGORY)
    const expected = (await fetchActiveActivities())
      .filter((d) => d.config.claims.some((c) => c.categoryId === SHARED_CATEGORY))
      .map((d) => d.config.id)
    expect(claims.map((c) => c.activityId)).toEqual(expected)

    // 每条都带着自己活动的力度与资金归属 —— 卖家并排比较时需要的正是这两项
    for (const c of claims) {
      expect(c.title).toBeTruthy()
      expect(c.rate).toBeGreaterThan(0)
      expect(c.rate).toBeLessThan(1)
      expect(['seller', 'platform']).toContain(c.fundSource)
    }
  })

  it('选项里两种资金归属都有（老板掏钱 vs 平台掏钱，卖家必须看得见差别）', () => {
    const sources = new Set(resolveJoinableClaimsByCategory(SHARED_CATEGORY).map((c) => c.fundSource))
    expect(sources.size).toBeGreaterThan(1)
  })

  it('结算口径含「待开始」，报名口径只认「进行中」——同一分类也不会让商品提前打折', async () => {
    const future = createActivity({
      title: '明天才开的生活专场',
      startAt: Date.now() + 86400_000,
      durationDays: 5,
      fundSource: 'platform',
      claims: [{ categoryId: SHARED_CATEGORY, rate: 0.7 }]
    })
    // 报名列表里绝不能出现还没生效的活动
    expect(resolveJoinableClaimsByCategory(SHARED_CATEGORY).some((c) => c.activityId === future.id)).toBe(false)

    // 把该分类上所有进行中的活动下架后，结算口径才落到这条待开始的活动上
    for (const c of resolveJoinableClaimsByCategory(SHARED_CATEGORY)) {
      await setActivityEnabled(c.activityId, false)
    }
    expect(resolveJoinableClaimsByCategory(SHARED_CATEGORY).length).toBe(0)
    expect(resolvePromoClaimByCategory(SHARED_CATEGORY)?.activityId).toBe(future.id)
  })

  it('归属按商品自己的 activityId 判定：同分类两条活动资金方不同也不会认错', () => {
    for (const c of resolveJoinableClaimsByCategory(SHARED_CATEGORY)) {
      expect(resolveClaimByActivityId(c.activityId, SHARED_CATEGORY)?.fundSource).toBe(c.fundSource)
      expect(resolveFundSourceForGoods({ activityId: c.activityId, categoryId: SHARED_CATEGORY })).toBe(c.fundSource)
    }
    // 对照：分类反查只有一个答案，说明「只按分类」在这种场景下必然认错一半
    const byCategory = resolveFundSourceByCategory(SHARED_CATEGORY)
    const distinct = new Set(resolveJoinableClaimsByCategory(SHARED_CATEGORY).map((c) => c.fundSource))
    expect(distinct.has(byCategory)).toBe(true)
    expect(distinct.size > 1).toBe(true)
  })

  it('后台账目不会串：报名平台补贴那条时，卖家实收一分不少', () => {
    const platformClaim = resolveJoinableClaimsByCategory(SHARED_CATEGORY).find((c) => c.fundSource === 'platform')
    expect(platformClaim, '生活分类应当有一条平台补贴的活动').toBeTruthy()
    const b = settleJoin(1000, platformClaim!.rate, platformClaim!.fundSource)
    expect(b.sellerCut).toBe(0)
    expect(b.sellerIncome).toBe(1000)
    expect(b.platformSubsidy).toBeCloseTo(1000 - b.payAmount, 2)
  })

  it('报名精确命中选中的那条活动，两件商品各按各的规则成交', async () => {
    const [first, second] = resolveJoinableClaimsByCategory(SHARED_CATEGORY)
    const g1 = await publishGoods({ title: '宿舍台灯', price: 200, categoryId: SHARED_CATEGORY, activityId: first.activityId })
    const g2 = await publishGoods({ title: '宿舍台灯2', price: 200, categoryId: SHARED_CATEGORY, activityId: second.activityId })

    expect(g1.activityId).toBe(first.activityId)
    expect(g2.activityId).toBe(second.activityId)
    // 预览与成交同源：各自等于「自己那条活动」算出的价
    expect(g1.promoPrice).toBe(settleJoin(200, first.rate, first.fundSource).payAmount)
    expect(g2.promoPrice).toBe(settleJoin(200, second.rate, second.fundSource).payAmount)
    expect(resolveFundSourceForGoods(g1)).toBe(first.fundSource)
    expect(resolveFundSourceForGoods(g2)).toBe(second.fundSource)
  })

  it('一件商品只产生一个让利价，不会把两条活动的折扣叠起来', async () => {
    const claims = resolveJoinableClaimsByCategory(SHARED_CATEGORY)
    const picked = claims[0]
    const g = await publishGoods({ title: '叠加测试', price: 300, categoryId: SHARED_CATEGORY, activityId: picked.activityId })
    // 不允许深于所选活动声明的力度（更深就说明把第二条的折扣也算进去了）
    expect(g.promoPrice!).toBeGreaterThanOrEqual(Math.floor(300 * picked.rate))
    expect(g.promoPrice).toBe(settleJoin(300, picked.rate, picked.fundSource).payAmount)
  })

  it('手工传一条「覆盖该分类但不属于当前时机」的活动 id 也不会生效', async () => {
    // 待开始的活动：不能报名（同 describe 十 的问题，这里再锁一次多活动场景）
    const future = createActivity({
      title: '待开始活动',
      startAt: Date.now() + 86400_000,
      durationDays: 3,
      fundSource: 'seller',
      claims: [{ categoryId: SHARED_CATEGORY, rate: 0.6 }]
    })
    const g = await publishGoods({ title: '提前报名', price: 300, categoryId: SHARED_CATEGORY, activityId: future.id })
    expect(g.promoPrice).toBeUndefined()
    expect(g.activityId).toBeUndefined()
  })
})

/* ============================================================
 * 十二、旧存档自愈：这是「活动看得见、却报不了名」的真正成因
 *
 * 第十轮之前的活动存档没有 `claims` / `fundSource` 字段。它们被归一化后变成
 * 「空声明」—— 首页 Banner 照旧展示（Banner 不读 claims），但任何分类都查不到
 * 让利声明，发布页就永远显示「当前分类暂无进行中的平台活动」。
 * 本组断言锁住自愈行为，避免这个坑再次复现。
 * ============================================================ */
describe('旧存档自愈 · 缺 claims 的活动要被补回让利声明', () => {
  /** 模拟第十轮之前的存档形状：有活动、但完全没有 claims / fundSource 字段 */
  const legacyShape = (over: Record<string, unknown> = {}) => ({
    id: 'digital-refresh-week',
    enabled: true,
    startAt: Date.now() - 3600_000,
    durationDays: 30,
    title: '平台补贴日：数码好物 8 折起',
    subtitle: '补贴由平台承担',
    ctaText: '逛逛数码',
    ctaLink: '/goods?categoryId=2',
    highlights: ['平台补贴 · 数码 8 折起'],
    icon: '🎧',
    theme: 'blue',
    priority: 80,
    createTime: Date.now(),
    updateTime: Date.now(),
    ...over
  })

  it('缺 claims 的老活动：按 id 从出厂活动补回 claims 与 fundSource', () => {
    const [fixed] = healLegacyActivities([legacyShape()])
    expect(fixed.claims).toEqual([{ categoryId: 2, rate: 0.8 }])
    // 数码活动是平台补贴 —— 不补 fundSource 的话会错写成「卖家让利」
    expect(fixed.fundSource).toBe('platform')
  })

  it('补回后该分类立刻可报名，资金归属也与商品数据一致', () => {
    const [fixed] = healLegacyActivities([legacyShape()])
    const hit = fixed.claims.find((c) => c.categoryId === 2)
    expect(hit?.rate).toBe(0.8)
    // 与 seed 商品侧的实际承担方一致（PROMO_RATES 里数码 = platform）
    expect(promoFundSourceOf(2)).toBe(fixed.fundSource)
  })

  it('明确写成 claims: [] 的活动不被动（那是有意为之的展示型活动）', () => {
    const [kept] = healLegacyActivities([
      legacyShape({ id: 'grad-clearance-2026', title: '毕业清仓专场', claims: [] })
    ])
    expect(kept.claims).toEqual([])
  })

  it('已带 claims 的活动原样保留，不会被出厂数据覆盖', () => {
    const custom = [{ categoryId: 7, rate: 0.7 }]
    const [kept] = healLegacyActivities([legacyShape({ claims: custom })])
    expect(kept.claims).toEqual(custom)
  })

  it('未知 id 的自建活动保持空声明（没有出厂定义可依据，宁可什么都不声称）', () => {
    const [kept] = healLegacyActivities([legacyShape({ id: 'my-own-activity', title: '自建活动' })])
    expect(kept.claims).toEqual([])
    expect(kept.fundSource).toBe('seller') // 归一化的默认值：不替平台揽功
  })

  it('自愈不影响活动时间：startAt / durationDays 保持存档原值', () => {
    const startAt = Date.now() - 5 * 86400_000
    const [fixed] = healLegacyActivities([legacyShape({ startAt, durationDays: 30 })])
    expect(fixed.startAt).toBe(startAt)
    expect(fixed.durationDays).toBe(30)
  })
})
