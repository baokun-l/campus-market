/**
 * 活动价格结算 —— 全项目唯一入口
 *
 * 为什么需要它：
 * 二手交易平台是**居间撮合方**，商品定价权在卖家（`Goods.sellerId`）手里，
 * 平台无权单方给他人商品改价。所以「折扣」只有两种合法来源：
 *
 *   - `seller`   **卖家让利**：卖家自愿降价，收益减少（`sellerIncome = 挂牌价 - 让利`）
 *   - `platform` **平台补贴**：平台自掏腰包补差价，**卖家实收不变**
 *
 * 因此价格必须能拆成三个口径，且任何展示/下单都走本文件，禁止各组件各算各的。
 *
 * 字段语义（与旧版相反，这里是修正后的定义）：
 *   - `Goods.price`      = **卖家挂牌价**（平台记录在案的真实价格，划线价的唯一来源）
 *   - `Goods.promoPrice` = 卖家让利后的**活动价**；未参与活动的商品为 undefined
 *
 * 划线价恒等于 `price`，天然真实 —— 不再存在「虚构原价」的可能。
 */
import type { FundSource, Goods } from '@/types'
import { discountText } from './format'

/** 让利成本的承担方（领域类型定义在 `@/types`，此处转出便于 `utils` 内部使用） */
export type { FundSource }

export const FUND_SOURCE_LABEL: Record<FundSource, string> = {
  seller: '卖家让利',
  platform: '平台补贴'
}

/** 让利成本的承担方说明（下单确认、订单详情、活动公告统一使用，避免口径不一致） */
export const FUND_SOURCE_HINT: Record<FundSource, string> = {
  seller: '折扣来自卖家自愿让利，平台不加价、不代卖家定价',
  platform: '折扣由平台补贴，卖家实收不变'
}

/**
 * 让利成本的**一句话影响**（供卖家做选择时并排比较，如发布页的活动单选）。
 *
 * 与 `FUND_SOURCE_HINT` 的区别：HINT 讲「这笔钱从哪来」，SHORT 讲
 * 「**对卖家自己意味着什么**」—— 卖家选活动时真正关心的是后者，两个选项并排时
 * 也必须一眼看出差别（少收钱 vs 不少收钱），所以单列一份而不是拼字符串。
 */
export const FUND_SOURCE_SHORT: Record<FundSource, string> = {
  seller: '卖家让利 · 你会少收',
  platform: '平台补贴 · 你的实收不变'
}

/** 参与结算所需的最小商品字段 */
export type SettleInput = Pick<Goods, 'price' | 'promoPrice'>

export interface PriceBreakdown {
  /** 卖家挂牌价（真实价格，也是划线价的来源） */
  listPrice: number
  /** 买家实付 */
  payAmount: number
  /** 卖家让利金额（fundSource = seller 时非 0） */
  sellerCut: number
  /** 平台补贴金额（fundSource = platform 时非 0） */
  platformSubsidy: number
  /** 卖家应收 —— 平台结算给卖家的金额 */
  sellerIncome: number
  /** 打折力度文案（如 "5折" / "8.5折"）；无让利时为空串 */
  discountLabel: string
  /** 是否处于让利状态 */
  onPromo: boolean
  fundSource: FundSource
}

/** 保留两位小数，避免浮点误差累积到结算金额上 */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/**
 * 由活动声明的折扣率算出**让利价**。
 *
 * ⚠️ 这是全项目**唯一**的让利价算法，两处调用方必须共用它：
 *    - `api/mock.ts` 生成 seed 商品的让利价；
 *    - `api/goods.ts` 的「卖家报名活动」为卖家自己发布的商品算让利价。
 * 若各写一份，同一件商品「报名生成」与「seed 生成」的价格会不一致。
 *
 * 结果恒 ≥ 1（不出现 0 元或负价）。`rate < 1` 由调用方保证 ——
 * 本函数不做业务判断，算出的价是否算「参与活动」由 `settlePrice()` 判定。
 */
export function promoPriceFor(listPrice: number, rate: number): number {
  return Math.max(1, Math.floor(listPrice * rate))
}

/**
 * 活动声明的折扣率 → 同分类内的**让利档位阶梯**。
 *
 * 活动声明的是「最高 N 折」（即最深力度，0.5 = 5 折起），但同一分类里不同商品
 * 力度可以不同 —— 现实中每件商品都是卖家各自决定让多少。因此从声明值起按
 * 0.05 递进取三档（0.5 → [0.5, 0.55, 0.6]）。
 *
 * 阶梯**全部 ≥ 声明值**，确保「实际折扣不比活动声明的更深」（`promo.spec.ts` 有断言）。
 */
export function promoRateLadder(rate: number): number[] {
  const base = round2(rate)
  const ladder = [base, round2(base + 0.05), round2(base + 0.1)].filter((r) => r > 0 && r < 1)
  // 声明值本身就越界（≥1）时退化为单档，避免返回空数组让调用方踩空
  return ladder.length ? ladder : [base]
}

/**
 * 某件商品报名某活动时，实际落在阶梯的哪一档。
 *
 * 用**挂牌价取模**选档，而不是随机数：项目禁用 `Math.random()`（见 `api/mock.ts`），
 * 而且发布页要在提交前就把最终价格显示给卖家 —— 选档规则必须是可预览、可复现的。
 * 这样「预览看到的价」与「提交后成交的价」必然一致。
 */
export function promoRateFor(listPrice: number, rate: number): number {
  const ladder = promoRateLadder(rate)
  return ladder[Math.floor(Number(listPrice) || 0) % ladder.length]
}

/**
 * 报名后的完整结算结果 —— 发布页预览与真实生成让利价**共用这一个入口**。
 *
 * 存在的意义就是防错：预览与成交若各算一遍，很容易出现
 * 「预览显示省 240，详情页却省 250」这种自相矛盾。
 * 与 `settlePrice()` 一样，本项目要求所有价格都从**唯一入口**出来。
 */
export function settleJoin(listPrice: number, rate: number, fundSource: FundSource = 'seller'): PriceBreakdown {
  const promoPrice = promoPriceFor(listPrice, promoRateFor(listPrice, rate))
  return settlePrice({ price: listPrice, promoPrice }, fundSource)
}

/**
 * 结算一件商品。
 *
 * `promoPrice` 只有「大于 0 且低于挂牌价」时才成立 —— 否则视为卖家未参与活动，
 * 按挂牌价成交。这个判断很关键：数据脏了也绝不能算出负让利。
 */
export function settlePrice(input: SettleInput, fundSource: FundSource = 'seller'): PriceBreakdown {
  const listPrice = round2(Number(input.price) || 0)
  const rawPromo = input.promoPrice === undefined || input.promoPrice === null ? null : round2(Number(input.promoPrice))
  const onPromo = rawPromo !== null && rawPromo > 0 && rawPromo < listPrice
  const payAmount = onPromo ? (rawPromo as number) : listPrice
  const delta = round2(listPrice - payAmount)

  const sellerCut = onPromo && fundSource === 'seller' ? delta : 0
  const platformSubsidy = onPromo && fundSource === 'platform' ? delta : 0

  return {
    listPrice,
    payAmount,
    sellerCut,
    platformSubsidy,
    sellerIncome: round2(listPrice - sellerCut),
    discountLabel: onPromo ? discountText(payAmount, listPrice) : '',
    onPromo,
    fundSource
  }
}

/** 多件合计（购物车 / 订单 / 看板） */
export interface PriceTotals {
  /** 挂牌价合计 */
  listTotal: number
  /** 买家实付合计 */
  payTotal: number
  /** 卖家让利合计 */
  sellerCutTotal: number
  /** 平台补贴合计 */
  platformSubsidyTotal: number
  /** 卖家实收合计 */
  sellerIncomeTotal: number
  /** 买家省下的钱（= 让利 + 补贴） */
  savedTotal: number
}

export function sumBreakdowns(list: PriceBreakdown[]): PriceTotals {
  const acc: PriceTotals = {
    listTotal: 0,
    payTotal: 0,
    sellerCutTotal: 0,
    platformSubsidyTotal: 0,
    sellerIncomeTotal: 0,
    savedTotal: 0
  }
  for (const b of list) {
    acc.listTotal = round2(acc.listTotal + b.listPrice)
    acc.payTotal = round2(acc.payTotal + b.payAmount)
    acc.sellerCutTotal = round2(acc.sellerCutTotal + b.sellerCut)
    acc.platformSubsidyTotal = round2(acc.platformSubsidyTotal + b.platformSubsidy)
    acc.sellerIncomeTotal = round2(acc.sellerIncomeTotal + b.sellerIncome)
  }
  acc.savedTotal = round2(acc.sellerCutTotal + acc.platformSubsidyTotal)
  return acc
}

/** 把让利金额格式化成「已省 ¥12.00（卖家让利 ¥12.00）」这类说明 */
export function discountNote(b: PriceBreakdown): string {
  if (!b.onPromo) return ''
  const saved = round2(b.sellerCut + b.platformSubsidy)
  return `${FUND_SOURCE_LABEL[b.fundSource]} ¥${saved.toFixed(2)}`
}

/**
 * 按数量放大一份价格拆分（购物车小计 / 确认订单 / 下单快照共用）。
 *
 * 四个金额必须**同步乘同一个数**，否则恒等式
 * `payAmount + sellerCut + platformSubsidy === listPrice` 会被破坏，
 * 后台对账时就会出现「拆项加起来不等于总额」的离谱账。
 * 各处自己乘一遍正是最容易漏掉某一项的地方，所以统一收敛到这里。
 */
export function scaleBreakdown(b: PriceBreakdown, quantity: number): PriceBreakdown {
  const q = Math.max(1, Math.floor(quantity || 1))
  if (q === 1) return { ...b }
  const listPrice = round2(b.listPrice * q)
  const payAmount = round2(b.payAmount * q)
  return {
    ...b,
    listPrice,
    payAmount,
    sellerCut: round2(b.sellerCut * q),
    platformSubsidy: round2(b.platformSubsidy * q),
    sellerIncome: round2(b.sellerIncome * q),
    discountLabel: b.onPromo ? discountText(payAmount, listPrice) : ''
  }
}
