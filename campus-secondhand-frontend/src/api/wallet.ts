/**
 * 校园钱包 API：余额 / 流水查询，以及充值入金。
 *
 * ★★ 为什么单独开一个文件，而不是塞进 pay.ts ★★
 *
 * pay.ts 管的是「某笔订单怎么付钱」（收银台渠道、支付单、支付状态轮询）；
 * 钱包管的是「账户上有多少钱、钱是怎么来的」。两者只在收银台那一屏相遇，
 * 混在一起会让「查余额」这件事被绑定到支付流程上 ——
 * 设置页想显示余额，就得去调一个叫「获取支付方式」的接口，读代码的人一定会绕。
 *
 * ★★ 改造前后最大的区别 ★★
 *
 * 改造前全站**没有任何充值入口**：后端没有充值接口，前端全树搜「充值」零命中，
 * 唯一让余额非零的办法是跑 SQL 种子脚本（只有 zhangsan / lisi / wangwu 三个账号有 500）。
 * 而收银台的文案却写着「使用校园币余额直接支付，无需跳转」——
 * 用户照着操作，点下去弹「钱包余额不足：当前余额 ¥0.00」，且找不到任何地方可以加钱。
 * 现在这条路径补齐了：`POST /wallet/recharge` 入金，`GET /wallet` 查余额与流水。
 *
 * ★ 幂等键必须由前端生成并**在重试时复用** ★
 *
 * 后端用 `requestId` 作为充值的幂等键（落库为流水的 biz_id，并有唯一索引兜底）。
 * 同一次充值的重试必须复用同一个值，否则后端会认为是两次独立充值，给用户加两次钱。
 * 所以规则是：**打开充值弹窗时生成一次，本次提交的所有重试都用它**；
 * 只有「用户改金额后重新提交」或「关掉弹窗再打开」才换新的键。
 * 见 `WalletRechargeDialog.vue` 里 requestId 的生命周期。
 */
import { request } from './request'
import { mockHelpers } from './mock'

const USE_MOCK = import.meta.env.VITE_USE_MOCK === 'true'

/** 一条钱包流水 */
export interface WalletLogItem {
  id: number
  /** 变动金额：正 = 入账，负 = 出账 */
  amount: number
  /** 变动后余额（与 amount 一起构成可逐行核对的对账链） */
  balanceAfter: number
  /** 机器可读类型：recharge / pay / refund */
  type: string
  /** 中文名（由服务端下发，前端不维护枚举映射） */
  typeLabel: string
  /** 关联业务号（支付单号 / 充值流水号） */
  bizId?: string | null
  remark?: string | null
  createTime?: string | null
}

/** 钱包概览：余额 + 最近流水 */
export interface WalletSummary {
  balance: number
  logs: WalletLogItem[]
}

/** 充值结果 */
export interface WalletRechargeResult {
  /** 本次充值的流水号（也是幂等键） */
  rechargeId: string
  amount: number
  /** 入账后余额（服务端重新查库得到，前端直接显示即可，不必自己算） */
  balance: number
  message: string
}

/**
 * 单笔充值上下限。
 *
 * ★ 必须与后端 `WalletService` 的口径严格一致 ★
 * 这两个值只用来做**输入框的体验约束**（min/max、超限即时提示），
 * 真正的边界判定在服务端 —— 前端约束是体验，不是安全边界，
 * 绕过页面直接调接口时它就不存在了。所以两边口径要一致，但不能只靠前端。
 */
export const MIN_RECHARGE = 0.01
export const MAX_RECHARGE = 50000

/** 常用充值档位（快捷按钮） */
export const RECHARGE_PRESETS = [50, 100, 200, 500]

/**
 * 生成一个充值幂等键。
 *
 * ★ 只用 `crypto.randomUUID()`，不用「时间戳 + Math.random()」当主路径 ★
 * 后者在「同一毫秒内开两个标签页」时可能撞车，而撞车的后果是
 * **第二次充值被当成重复提交、钱不加**（用户以为充了，余额没动）。
 * randomUUID 的碰撞概率可忽略。兜底分支只在没有 crypto 的老环境走到，
 * 形态不同但同样满足后端的 `^[A-Za-z0-9_-]{8,40}$`。
 */
export function newRechargeRequestId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `rcg-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`
}

/**
 * 查钱包概览（余额 + 最近流水）。
 *
 * 收银台和设置页都用它，而不是复用 `fetchPayChannels()`：
 * 后者只在**钱包渠道可用时**才带余额，某个 profile 下渠道被关掉，余额就查不到了。
 */
export async function fetchWallet(): Promise<WalletSummary> {
  if (USE_MOCK) {
    await mockHelpers.delay(120)
    const balance = mockHelpers.getWalletBalance()
    return {
      balance,
      logs: [
        {
          id: 1,
          amount: balance,
          balanceAfter: balance,
          type: 'recharge',
          typeLabel: '充值',
          bizId: null,
          remark: '演示初始余额（校园币）',
          createTime: null
        }
      ]
    }
  }
  return request({ url: '/wallet', method: 'GET', showLoading: false })
}

/**
 * 充值。
 *
 * 成功后**不要**在前端自己算新余额 —— 直接用返回的 `balance`。
 * 后端那个值是在事务内重新查库得到的真实值；前端拿旧余额加上金额去算，
 * 在并发场景下会算错（旧余额可能已经过期）。
 *
 * @param amount    充值金额（元）
 * @param requestId 幂等键，见文件头注释。同一次充值的重试必须复用
 */
export async function rechargeWallet(amount: number, requestId: string): Promise<WalletRechargeResult> {
  if (USE_MOCK) {
    await mockHelpers.delay(220)
    const balance = mockHelpers.addWalletBalance(amount)
    return {
      rechargeId: requestId,
      amount,
      balance,
      message: `充值成功 ¥${amount.toFixed(2)}，当前余额 ¥${balance.toFixed(2)}`
    }
  }
  /*
   * silent: true —— 充值失败的文案由弹窗自己呈现（要区分「金额不对」「余额超上限」
   * 「重复提交」三种情况，并贴在输入框旁边），交给全局拦截器弹一次 ElMessage
   * 会与弹窗内的提示重复，用户看到两处说同一件事。
   */
  return request({
    url: '/wallet/recharge',
    method: 'POST',
    data: { amount, requestId },
    showLoading: false,
    silent: true
  })
}
