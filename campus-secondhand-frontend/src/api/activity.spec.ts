/**
 * API 层单元测试 · 限时活动模块（多活动模型）
 * 覆盖：列表排序 / 状态判定 / 前台可展示集合 / 新建 / 编辑 / 上下架 / 删除 / 恢复出厂 / 旧存档迁移
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  fetchActivities,
  fetchActiveActivities,
  fetchActivity,
  createActivity,
  updateActivity,
  setActivityEnabled,
  deleteActivity,
  resetActivities,
  formatCountdown,
  activityStateLabel,
  activityStateTag,
  EMPTY_ACTIVITY_DISPLAY
} from '@/api/activity'
import { resetActivities as resetInMock, ACTIVITIES_STORAGE_KEY, getActivityDisplay } from '@/api/mock'

const DAY = 86400_000

/** 每条用例前恢复出厂活动列表，避免相互污染 */
beforeEach(() => {
  resetInMock()
})

describe('fetchActivities() · 活动列表', () => {
  it('应返回出厂的全部活动（4 条）', async () => {
    const list = await fetchActivities()
    expect(list.length).toBe(4)
  })

  it('应按优先级降序排列', async () => {
    const list = await fetchActivities()
    const priorities = list.map((d) => d.config.priority)
    expect(priorities).toEqual([...priorities].sort((a, b) => b - a))
    expect(list[0].config.id).toBe('back-to-school-2026-fall')
  })

  it('应给出每个活动的状态：进行中 / 已到期', async () => {
    const list = await fetchActivities()
    const byId = Object.fromEntries(list.map((d) => [d.config.id, d.state]))
    expect(byId['back-to-school-2026-fall']).toBe('active')
    expect(byId['grad-clearance-2026']).toBe('expired') // 40 天前开始、持续 14 天
    /*
     * 数码焕新周必须处于 active —— 它是 PROMO_RATES 里「数码」分类让利价的来源。
     * 若把它改回 cancelled，就会出现「活动已下架但商品还在打折」的数据自相矛盾
     * （promo.spec.ts 会直接报错）。见 mock.ts 中该活动的注释。
     */
    expect(byId['digital-refresh-week']).toBe('active')
  })

  it('下架的活动状态应为 cancelled', async () => {
    await setActivityEnabled('digital-refresh-week', false, 'admin')
    const list = await fetchActivities()
    const target = list.find((d) => d.config.id === 'digital-refresh-week')!
    expect(target.state).toBe('cancelled')
  })

  it('未到开始时间的活动状态应为 pending', async () => {
    const created = await createActivity({ title: '预告活动', startAt: Date.now() + 2 * DAY, durationDays: 7 })
    const list = await fetchActivities()
    const target = list.find((d) => d.config.id === created.id)!
    expect(target.state).toBe('pending')
    expect(target.shouldShow).toBe(true)
  })
})

describe('fetchActiveActivities() · 前台可展示集合', () => {
  it('只应包含 active / pending，且 active 全部排在 pending 之前', async () => {
    await createActivity({ title: '预告活动', startAt: Date.now() + DAY, durationDays: 3, priority: 999 })
    const active = await fetchActiveActivities()
    // 开学季(active) + 数码焕新周(active) + 宿舍焕新补贴周(active) + 预告活动(pending)
    expect(active.length).toBe(4)
    expect(active.every((d) => d.state === 'active' || d.state === 'pending')).toBe(true)
    const firstPending = active.findIndex((d) => d.state === 'pending')
    const lastActive = active.map((d) => d.state).lastIndexOf('active')
    expect(lastActive).toBeLessThan(firstPending)
  })

  it('下架其中一个活动时，前台集合只剩其他进行中的活动（Banner 切到下一个）', async () => {
    await setActivityEnabled('back-to-school-2026-fall', false, 'admin')
    const active = await fetchActiveActivities()
    // 还剩数码焕新周(80) + 宿舍焕新补贴周(70)，按优先级降序 → 数码排在前面
    expect(active.length).toBe(2)
    expect(active[0].config.id).toBe('digital-refresh-week')
  })

  it('全部活动下架 / 到期后，前台集合应为空（Banner 消失）', async () => {
    await setActivityEnabled('back-to-school-2026-fall', false, 'admin')
    await setActivityEnabled('digital-refresh-week', false, 'admin')
    await setActivityEnabled('dorm-upgrade-2026', false, 'admin')
    const active = await fetchActiveActivities()
    // 毕业清仓已到期 → 无任何可展示活动
    expect(active.length).toBe(0)
  })

  it('主推活动应取优先级最高的 active', async () => {
    const d = await fetchActivity()
    expect(d.config.id).toBe('back-to-school-2026-fall')
    expect(d.shouldShow).toBe(true)
  })
})

describe('createActivity() · 新建活动', () => {
  it('应自动生成 id、写入列表并默认上架', async () => {
    const created = await createActivity({ title: '双十一数码专场', durationDays: 5 })
    expect(created.id).toBeTruthy()
    expect(created.enabled).toBe(true)
    expect(created.durationDays).toBe(5)
    expect(created.createTime).toBeGreaterThan(0)

    const list = await fetchActivities()
    expect(list.length).toBe(5)
    expect(list.some((d) => d.config.id === created.id)).toBe(true)
  })

  it('优先级更高的新活动应排到列表首位并成为主推', async () => {
    await createActivity({ title: '限时秒杀', durationDays: 2, priority: 500 })
    const list = await fetchActivities()
    expect(list[0].config.title).toBe('限时秒杀')
    expect(getActivityDisplay().config.title).toBe('限时秒杀')
  })

  it('应补全缺省字段，避免出现 undefined 渲染', async () => {
    const created = await createActivity({ title: '极简活动' })
    expect(created.subtitle).toBe('')
    expect(created.ctaText).toBe('立即参与')
    expect(created.ctaLink).toBe('/goods')
    expect(created.icon).toBe('🎯')
    expect(created.theme).toBe('orange')
    expect(Array.isArray(created.highlights)).toBe(true)
  })

  it('非法的 theme / durationDays 应被纠正为合法值', async () => {
    const created = await createActivity({
      title: '脏数据活动',
      theme: 'rainbow' as never,
      durationDays: 0
    })
    expect(created.theme).toBe('orange')
    expect(created.durationDays).toBe(14)
  })
})

describe('updateActivity() · 编辑活动', () => {
  it('应局部更新且不影响其他字段', async () => {
    const before = await fetchActivity()
    const updated = await updateActivity(before.config.id, { title: '开学季特卖（改）' })
    expect(updated.title).toBe('开学季特卖（改）')
    expect(updated.subtitle).toBe(before.config.subtitle)
    expect(updated.priority).toBe(before.config.priority)
    expect(updated.updateTime).toBeGreaterThanOrEqual(before.config.updateTime)
  })

  it('对不存在的 id 应抛错', async () => {
    await expect(updateActivity('not-exist', { title: 'x' })).rejects.toThrow()
  })
})

describe('setActivityEnabled() · 上架 / 下架', () => {
  it('下架应记录取消时间与操作人，状态变为 cancelled', async () => {
    await setActivityEnabled('back-to-school-2026-fall', false, 'tester')
    const list = await fetchActivities()
    const target = list.find((d) => d.config.id === 'back-to-school-2026-fall')!
    expect(target.state).toBe('cancelled')
    expect(target.config.cancelledBy).toBe('tester')
    expect(target.config.cancelledAt).toBeGreaterThan(0)
    expect(target.shouldShow).toBe(false)
  })

  it('重新上架应清空下架记录，并把开始时间重置到现在（倒计时重新计算）', async () => {
    const past = await createActivity({ title: '过期活动', startAt: Date.now() - 30 * DAY, durationDays: 1 })
    await setActivityEnabled(past.id, true)
    const list = await fetchActivities()
    const target = list.find((d) => d.config.id === past.id)!
    expect(target.state).toBe('active')
    expect(target.config.cancelledAt).toBeUndefined()
    expect(target.config.cancelledBy).toBeUndefined()
    // 剩余时间应接近完整的 1 天，而不是 0
    expect(target.remainingMs).toBeGreaterThan(23 * 3600_000)
  })
})

describe('deleteActivity() · 删除活动', () => {
  it('应删除指定活动并返回 true', async () => {
    const ok = await deleteActivity('digital-refresh-week')
    expect(ok).toBe(true)
    const list = await fetchActivities()
    expect(list.length).toBe(3)
    expect(list.some((d) => d.config.id === 'digital-refresh-week')).toBe(false)
  })

  it('删除不存在的活动应返回 false 且不影响列表', async () => {
    const ok = await deleteActivity('not-exist')
    expect(ok).toBe(false)
    expect((await fetchActivities()).length).toBe(4)
  })
})

describe('resetActivities() · 恢复出厂', () => {
  it('应把列表恢复为出厂 4 条', async () => {
    await createActivity({ title: '临时活动' })
    await deleteActivity('digital-refresh-week')
    expect((await fetchActivities()).length).toBe(4)

    await resetActivities()
    const list = await fetchActivities()
    expect(list.length).toBe(4)
    expect(list.some((d) => d.config.id === 'digital-refresh-week')).toBe(true)
  })
})

describe('持久化', () => {
  it('新建活动后应把列表写入 localStorage（否则刷新即丢失）', async () => {
    const created = await createActivity({ title: '持久化测试', durationDays: 3 })
    const raw = localStorage.getItem(ACTIVITIES_STORAGE_KEY)
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw!) as { id: string }[]
    expect(parsed.some((a) => a.id === created.id)).toBe(true)
  })

  it('旧版单活动存档应被迁移为活动列表', async () => {
    // 造一份旧存档：只有单活动 key，没有新 key
    localStorage.setItem(
      'c2c-activity',
      JSON.stringify({ id: 'legacy-2025', title: '旧版活动', durationDays: 3, startAt: Date.now(), enabled: true })
    )
    localStorage.removeItem(ACTIVITIES_STORAGE_KEY)

    // 重新加载模块，触发 loadActivities() 的迁移分支
    vi.resetModules()
    const fresh = await import('@/api/mock')

    expect(fresh.listActivityDisplays().some((d: { config: { id: string } }) => d.config.id === 'legacy-2025')).toBe(true)
    expect(localStorage.getItem(ACTIVITIES_STORAGE_KEY)).toBeTruthy()
    expect(localStorage.getItem('c2c-activity')).toBeNull() // 迁移完成后清除旧 key
  })

  it('旧活动 id 与出厂活动一致时应继承出厂优先级，不掉到列表末尾', async () => {
    localStorage.setItem(
      'c2c-activity',
      JSON.stringify({
        id: 'back-to-school-2026-fall',
        title: '旧的开学季活动',
        durationDays: 14,
        startAt: Date.now(),
        enabled: true
      })
    )
    localStorage.removeItem(ACTIVITIES_STORAGE_KEY)

    vi.resetModules()
    const fresh = await import('@/api/mock')
    const list = fresh.listActivityDisplays() as unknown as {
      config: { id: string; title: string; priority: number }
    }[]

    const migrated = list.find((d) => d.config.id === 'back-to-school-2026-fall')!
    expect(migrated.config.title).toBe('旧的开学季活动') // 旧数据被保留
    expect(migrated.config.priority).toBe(100) // 出厂优先级被继承（否则会掉成默认 50）
    expect(list[0].config.id).toBe('back-to-school-2026-fall') // 仍排在首位
  })
})

describe('展示工具函数', () => {
  it('formatCountdown 应输出 DD天 HH:MM:SS，且边界值安全', () => {
    expect(formatCountdown(0)).toBe('00天 00:00:00')
    expect(formatCountdown(-1000)).toBe('00天 00:00:00')
    expect(formatCountdown(2 * DAY + 3 * 3600_000 + 4 * 60_000 + 5000)).toBe('02天 03:04:05')
  })

  it('状态标签与 tag 类型应覆盖全部状态', () => {
    expect(activityStateLabel('active')).toBe('进行中')
    expect(activityStateLabel('pending')).toBe('待开始')
    expect(activityStateLabel('expired')).toBe('已到期')
    expect(activityStateLabel('cancelled')).toBe('已取消')

    expect(activityStateTag('active')).toBe('success')
    expect(activityStateTag('pending')).toBe('warning')
    expect(activityStateTag('expired')).toBe('info')
    expect(activityStateTag('cancelled')).toBe('danger')
  })

  it('空态占位对象结构完整，模板可安全取值', () => {
    expect(EMPTY_ACTIVITY_DISPLAY.shouldShow).toBe(false)
    expect(EMPTY_ACTIVITY_DISPLAY.config.highlights).toEqual([])
    expect(EMPTY_ACTIVITY_DISPLAY.config.theme).toBe('orange')
  })
})
