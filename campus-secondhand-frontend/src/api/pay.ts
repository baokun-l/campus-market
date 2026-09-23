/**
 * 支付 API：收银台渠道列表、支付状态轮询。
 *
 * ★★ 为什么「去支付」不再是「点一下就把订单改成已付款」★★
 *
 * 改造前前端只有一个 `确认支付 ¥45.00?` 的确认框，点下去就调用
 * `POST /orders/{id}/pay`，后端把订单状态直接翻成「待发货」。
 * 这意味着「付款成功」这件事**没有任何依据**：
 *   · 没有收银台 —— 用户没选过任何支付方式；
 *   · 没有金额校验 —— 金额只是从列表里取出来显示用的；
 *   · 没有凭证 —— 谁付的、走哪条通道、通道流水号是什么，一概没有。
 *
 * 现在后端把支付拆成「支付单 + 渠道」，前端相应拆成三步：
 *   ① 拉渠道列表（后端只给**此刻真的能用**的：没配密钥的支付宝不会出现）；
 *   ② 用户选渠道 → 发起支付，后端返回 `PayLaunch`，由 `kind` 决定下一步；
 *   ③ `REDIRECT`（去支付宝）时跳走，回来后按 `fetchPayStatus` 问一句成了没。
 *
 * ★ `kind` 必须由后端显式下发，前端不要猜 ★
 * 早期很容易写成「url 非空就跳转」，可一旦某条渠道既给 url 又要轮询
 * （或当场就付完了），这种猜测就会直接错。所以后端用枚举把三种形态写进契约：
 *   REDIRECT —— 跳 `url`；QR —— 渲染 `qrCode` 并轮询；DONE —— 已经付完。
 */
import { request } from './request'
import { mockHelpers } from './mock'

const USE_MOCK = import.meta.env.VITE_USE_MOCK === 'true'

/** 收银台上的一条支付方式 */
export interface PayChannelOption {
  /** wallet / demo / alipay_sandbox —— 原样回传给后端，不要自己翻译 */
  code: string
  label: string
  /** 补充说明（告诉用户选了之后会发生什么） */
  hint: string
  /** 仅钱包渠道有值：当前余额 */
  balance?: number | null
}

/** 发起支付后「下一步该干什么」 */
export type PayLaunchKind = 'REDIRECT' | 'QR' | 'DONE'

/** `POST /orders/{id}/pay` 的返回体 */
export interface PayLaunch {
  paymentId: string
  orderId: string
  channel: string
  channelLabel: string
  amount: number
  kind: PayLaunchKind
  /** REDIRECT：收银台地址 */
  url?: string | null
  /** QR：二维码内容 */
  qrCode?: string | null
  /** 给用户看的一句话（「钱包支付 ¥45.00 已完成，剩余余额 ¥455.00」） */
  message?: string | null
  /** 支付截止时间（前端据此显示倒计时） */
  expireAt?: string | null
  status: string
  /** 钱包支付后的剩余余额 */
  balance?: number | null
}

/** 轮询结果：只回必要字段，轮询是高频接口，不该搬整张订单 */
export interface PayStatus {
  orderId: string
  orderStatus: string
  paid: boolean
  payChannel?: string | null
  payTime?: string | null
  payExpireAt?: string | null
  paymentId?: string
  paymentStatus?: string
  channel?: string
  amount?: number
  failReason?: string | null
}

/**
 * 当前可用的支付方式。
 *
 * ★ 列表由后端过滤，前端不要自己硬编码 ★
 * 演示渠道在生产环境会被后端无条件关掉、没配密钥的支付宝沙箱也不会出现。
 * 前端照着这个列表渲染，用户就不可能点到一条会失败的渠道。
 */
export async function fetchPayChannels(): Promise<PayChannelOption[]> {
  if (USE_MOCK) {
    await mockHelpers.delay(160)
    return [
      { code: 'wallet', label: '校园钱包', hint: '从账户余额直接扣款，即时到账', balance: 500 },
      { code: 'demo', label: '演示渠道', hint: '课堂演示专用，不产生真实资金往来', balance: null }
    ]
  }
  return request({ url: '/pay/channels', method: 'GET' })
}

/**
 * 查某笔订单的支付状态。
 *
 * 轮询是必要的：用户跳到支付宝之后在**外部页面**付款，
 * 我们的前端无从得知他什么时候付完（也可能关掉页面走人了）。
 */
export async function fetchPayStatus(orderId: string): Promise<PayStatus> {
  if (USE_MOCK) {
    await mockHelpers.delay(120)
    const o = mockHelpers.getOrderCache().find((x) => x.id === orderId)
    return {
      orderId,
      orderStatus: o?.status ?? 'pending_payment',
      paid: Boolean(o?.payTime),
      payChannel: o?.payTime ? 'wallet' : null,
      payTime: o?.payTime ?? null
    }
  }
  return request({ url: `/orders/${orderId}/pay/status`, method: 'GET' })
}
