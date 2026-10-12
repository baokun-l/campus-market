/**
 * 平台参数（系统设置）API
 * 真实场景：后端配置中心；这里持久化到 localStorage，保证「改完刷新还在」。
 */
import { request } from './request'
import { mockHelpers } from './mock'
import type { PlatformSettings } from './mock'
import { ratioToPercent, percentToRatio } from '@/utils/rate'
import type { Goods } from '@/types'

export type { PlatformSettings } from './mock'

const USE_MOCK = import.meta.env.VITE_USE_MOCK === 'true'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/* ====================================================================
 * ★ 服务费率的边界换算（百分比 ↔ 比率）★
 * ====================================================================
 * 线上说「比率」，界面说「百分比」，两边都不肯改，所以必须有人在中间换算。
 * 换算函数本体在 `@/utils/rate`（纯函数，单独有单测）；
 * **调用点刻意只放这一处** —— 本文件是唯一同时知道「界面格式」与「线上格式」的地方，
 * 也是 Mock 与真实两条分支的分叉点。
 *
 * 具体病灶见 `utils/rate.ts` 的模块注释：管理员把服务费率填成 2（=2%）后保存，
 * 前端把 2 原样当比率发出，后端按 0 ~ 1 校验 → 1001 报错，而表单里那个值完全合法。
 *
 * ★ 两条分支的口径必须一致 ★
 * Mock 分支**不做换算**（`mockHelpers` 里存的就是百分比），换算只发生在真实分支出入两侧。
 * 这不是双标：对外的 `fetchSettings/saveSettings` 一律以百分比为契约，
 * Mock 直接满足，真实分支靠 `toWire/fromWire` 换算后满足 —— 调用方看到的永远是同一套语义。
 */
/** 出站：把整个参数对象的费率换成线上格式（其余字段原样透传） */
function toWire(patch: Partial<PlatformSettings>): Partial<PlatformSettings> {
  if (patch.commissionRate === undefined) return patch
  return { ...patch, commissionRate: percentToRatio(patch.commissionRate) }
}

/** 入站：把服务端下发的费率换回界面格式（缺失/异常一律回落 0，不让 NaN 流进表单） */
function fromWire(s: PlatformSettings): PlatformSettings {
  return { ...s, commissionRate: ratioToPercent(s.commissionRate) }
}

/** 读取平台参数（返回值中的 commissionRate 一律是**百分比**，与界面同一口径） */
export async function fetchSettings(): Promise<PlatformSettings> {
  if (USE_MOCK) {
    await sleep(180)
    return mockHelpers.getPlatformSettings()
  }
  const s: PlatformSettings = await request({ url: '/admin/settings', method: 'GET' })
  return fromWire(s)
}

/** 保存平台参数（局部更新），并写入操作日志 */
export async function saveSettings(patch: Partial<PlatformSettings>): Promise<PlatformSettings> {
  if (USE_MOCK) {
    await sleep(320)
    const before = mockHelpers.getPlatformSettings()
    const next = mockHelpers.savePlatformSettings(patch)

    // 只把「真的变了」的字段写进日志，避免日志噪音
    const changed = (Object.keys(patch) as (keyof PlatformSettings)[]).filter(
      (k) => String(before[k]) !== String(next[k])
    )
    if (changed.length) {
      mockHelpers.addAuditLog({
        action: 'settings.save',
        actionLabel: '修改平台参数',
        target: `${changed.length} 项设置`,
        detail: changed.map((k) => `${SETTINGS_LABEL[k]}：${before[k]} → ${next[k]}`).join('；')
      })
    }
    return next
  }
  // 出站换算：patch 里若是百分比（如 2 = 2%），线上要发比率 0.02
  const s: PlatformSettings = await request({
    url: '/admin/settings',
    method: 'PATCH',
    data: toWire(patch)
  })
  return fromWire(s)
}

/** 恢复默认参数 */
export async function resetSettings(): Promise<PlatformSettings> {
  if (USE_MOCK) {
    await sleep(240)
    const fresh = mockHelpers.resetPlatformSettings()
    mockHelpers.addAuditLog({
      action: 'settings.reset',
      actionLabel: '恢复默认参数',
      target: '系统设置',
      detail: '全部平台参数回到出厂值'
    })
    return fresh
  }
  const s: PlatformSettings = await request({ url: '/admin/settings/reset', method: 'POST' })
  return fromWire(s)
}

/* ====================================================================
 * ★ 商品自动下架的「预览 / 立即执行」★
 * ====================================================================
 * 后端这两个入口早就有了（`AdminController`：
 * `GET|POST /admin/goods/auto-offline`），但前端一直没有任何调用方 ——
 * 换句话说，管理员在界面上**永远无法验证**他刚填的 `auto_offline_days` 到底会不会生效。
 *
 * 这不是「少个按钮」的小事：
 *   · 定时任务每天凌晨 03:30 才跑一次。没有预览通道时，「改配置」的唯一验证方式
 *     就是「等一晚上看结果」—— 而配置页上的「已生效」标签会让管理员以为已经确认过了；
 *   · 批量改商品状态**没有撤销键**。一次误配（90 写成 9）的代价是真实下架几十件商品，
 *     卖家在下架前收不到任何提示，事后只能自己重新上架。
 * 「改配置 → 预览会不会误伤 → 再执行」这三步必须能在一次会话里走完，
 * 那条「可验证的配置」才算真的可验证。
 *
 * ★ 两个入口的响应体刻意保持一致 ★
 * 都是 `{ days, count }`，但 `count` 的含义随动作变化（见 `AutoOfflineResult` 字段注释）。
 * `days = 0` 表示该功能当前被配置关闭，此时两个接口都返回 0 ——
 * 管理员据此能区分「配置没生效」与「没有超期商品」这两件完全不同的事。
 */
export interface AutoOfflineResult {
  /** 服务端**当前已保存**的配置天数；0 表示不自动下架 */
  days: number
  /** 预览时 = 将下架数；执行时 = 已下架数 */
  count: number
}

/**
 * 预览：按已保存的配置算出现在有多少件在售商品会超期。**只读，不改任何数据。**
 *
 * ★ 它读的是数据库里的值，不是表单里未保存的值 ★
 * 管理员把 90 改成 30 后若不保存直接点预览，返回的仍是按 90 算的结果。
 * 调用方（`SettingsPanel`）必须把这一点显式告诉用户 —— 否则这个「安全按钮」本身
 * 就会误导人，而它存在的全部意义恰恰是防止误伤。
 */
export async function previewAutoOffline(): Promise<AutoOfflineResult> {
  if (USE_MOCK) {
    await sleep(160)
    const days = mockHelpers.getPlatformSettings().autoOfflineDays
    return { days, count: pickStaleGoods(days).length }
  }
  return request<AutoOfflineResult>({ url: '/admin/goods/auto-offline', method: 'GET' })
}

/**
 * 立即执行一次自动下架（等价于定时任务那一次运行）。
 *
 * ★ 这是整个设置页唯一会批量改**业务数据**的动作 ★
 * 其它控件都只写 `t_settings` 一行；这个动作会把成批商品的 `status` 改成 `off_shelf`，
 * 且没有撤销键。所以界面侧必须挂二次确认（`SettingsPanel.onRunAutoOffline`），
 * 并在执行前引导管理员先看预览。
 */
export async function runAutoOffline(): Promise<AutoOfflineResult> {
  if (USE_MOCK) {
    await sleep(360)
    const days = mockHelpers.getPlatformSettings().autoOfflineDays
    const stale = pickStaleGoods(days)
    if (stale.length) {
      const hit = new Set(stale.map((g) => g.id))
      mockHelpers.setGoodsCache(
        mockHelpers
          .getGoodsCache()
          .map((g) => (hit.has(g.id) ? { ...g, status: 'off_shelf' as const } : g))
      )
      // 动作标识与后端 GoodsMaintenanceService 保持一致（goods.auto_offline）
      mockHelpers.addAuditLog({
        action: 'goods.auto_offline',
        actionLabel: '自动下架超期商品',
        target: `${stale.length} 件商品`,
        detail: `发布超过 ${days} 天的在售商品已自动下架`
      })
    }
    return { days, count: stale.length }
  }
  return request<AutoOfflineResult>({ url: '/admin/goods/auto-offline', method: 'POST' })
}

/**
 * Mock 分支专用：按与后端**完全相同**的规则挑出会被下架的商品。
 *
 * 口径抄自 `GoodsMaintenanceService.offlineStaleGoods()`：
 * `status = 'on_sale'` 且 `create_time < now - days 天`；`days <= 0` 时一件都不挑。
 *
 * ★ 为什么不图省事直接返回一个拍出来的数字 ★
 * Mock 存在的意义是让流程在无后端时可被走通、并**可被测试断言**。
 * 若这里返回一个凭空的数，而 `runAutoOffline` 改的是另一批商品（或干脆谁的 status 都没动），
 * 前端就会在 Mock 下「看起来对、实际对不上」—— 这正是本项目反复在抓的那类缺陷。
 */
function pickStaleGoods(days: number): Goods[] {
  if (days <= 0) return []
  const deadline = Date.now() - days * 86400_000
  return mockHelpers
    .getGoodsCache()
    .filter((g) => g.status === 'on_sale' && new Date(g.createTime).getTime() < deadline)
}

/** 参数中文名（表单 label 与日志共用，避免两处不一致） */
export const SETTINGS_LABEL: Record<keyof PlatformSettings, string> = {
  siteName: '站点名称',
  servicePhone: '客服电话',
  announceText: '顶部公告文案',
  goodsAuditRequired: '发布需审核',
  maxPublishPerDay: '每日发布上限',
  autoOfflineDays: '自动下架天数',
  reportAutoHide: '举报自动隐藏',
  commissionRate: '服务费率'
}
