/**
 * 平台参数（系统设置）API
 * 真实场景：后端配置中心；这里持久化到 localStorage，保证「改完刷新还在」。
 */
import { request } from './request'
import { mockHelpers } from './mock'
import type { PlatformSettings } from './mock'
import { ratioToPercent, percentToRatio } from '@/utils/rate'

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
