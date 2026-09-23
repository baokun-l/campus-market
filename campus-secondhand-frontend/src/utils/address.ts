import type { Address, Goods } from '@/types'

/**
 * 收货地址工具 —— 把「我的地址」接进下单流程。
 *
 * ★ 为什么需要这个文件 ★
 *
 * 下单接口 `createOrder` 的 `address` 一直是「前端自己编」的：
 *   · 商品详情页写死了一句常量（`BUY_ADDRESS = '北京市海淀区学院路 38 号 计算机学院宿舍'`），
 *     无论买家是谁、在哪个校区，落库的地址都是这一句；
 *   · 购物车结算干脆**不传** address，后端于是回落到 `'校园内面交'`。
 *
 * 结果是用户在「我的地址」里维护的地址**从来没有进过订单** ——
 * 界面上「收货地址」一栏有内容、订单接口也一路 200，看起来一切正常，
 * 直到卖家要发货时才发现地址是假的。这属于「假数据冒充真数据」，比报错更难发现。
 *
 * 这里把「该不该要地址」「用哪条地址」「怎么拼成落库字符串」收敛成三个纯函数，
 * 详情页与购物车共用同一口径 —— 避免两个页面各自拼一次、拼法还不一样。
 */

/**
 * 这笔交易是否需要收货地址。
 *
 * 交易方式只有三种（见 `utils/goods.ts` 的 `DELIVERY_OPTIONS`）：
 *   · `face`    校园面交 —— 校内当面相约，不需要地址；
 *   · `self`    自提     —— 买家到卖家指定地点自取，同样不需要；
 *   · `express` 包邮快递 —— **只有它**需要买家提供收货地址。
 *
 * 与后端 `OrderService.createOrder` 的判断口径保持一致：
 * 那里在「地址为空且 deliveryMethod=express」时会留一条 WARN 日志。
 * 两处必须同时改，否则前端以为不用填、后端以为前端会填，责任就在中间落空。
 */
export function needsShipping(method: Goods['deliveryMethod']): boolean {
  return method === 'express'
}

/**
 * 把地址簿里的结构化地址拼成下单时落库的地址串。
 *
 * 后端 `t_order.address` 是**单列** varchar(500)，而地址簿是
 * `{ region: '北京市海淀区', detail: '学院路 38 号 3 号楼 201' }` 两段式，
 * 所以必须在这里拍平 —— 否则存进去的要么是 `[object Object]`，要么只剩前一半。
 *
 * ★ 参数刻意用「可选字段」而不是 `Pick<Address, 'region' | 'detail'>` ★
 * 后者要求两个字段都存在且都是 string，但地址在实际数据里**可能只填了一半**
 * （用户只写了详细地址、或历史数据缺 region）。签名的容错能力必须跟上实现的容错能力，
 * 否则调用方为了通过类型检查得先编一个空串塞进去，反而把「缺失」写成了「空」。
 *
 * 缺字段时不补占位文案，直接跳过：宁可拼出「学院路 38 号」，
 * 也不拼出「undefined 学院路 38 号」这种一眼假的内容。
 */
export function formatAddress(
  a: { region?: string | null; detail?: string | null } | null | undefined
): string {
  if (!a) return ''
  return [a.region, a.detail]
    .map((s) => (s ?? '').trim())
    .filter(Boolean)
    .join(' ')
}

/**
 * 挑一条默认地址：优先 `isDefault`，没有标记就取第一条。
 *
 * 地址簿没有「默认地址」约束（用户可以一条都不标），而结算页需要一个确定的初值，
 * 所以这里给出稳定口径 —— 而不是让调用方各自写 `list[0]`，
 * 那样一旦有人改成 `list.at(-1)` 就会出现「两个页面默认地址不一样」的灵异现象。
 */
export function pickDefaultAddress(list: Address[] | null | undefined): Address | undefined {
  if (!list || list.length === 0) return undefined
  return list.find((a) => a.isDefault) ?? list[0]
}
