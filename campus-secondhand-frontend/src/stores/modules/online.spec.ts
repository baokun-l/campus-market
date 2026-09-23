/**
 * Pinia Store 单元测试 · 在线名单（服务端权威）
 *
 * 这一组用例钉死的是**口径与边界**，不是实现细节：
 *   - 「谁在线」只能来自服务端，前端不得再自己编（旧 utils/prefs.isUserOnline 已删）；
 *   - 未知一律按**离线**渲染（宁可晚亮 100ms，也不先闪一个假的「在线」再变灰）；
 *   - 一屏 N 张卡片只发**一次**请求（批量合并），且在 TTL 内不重复打接口；
 *   - 接口失败**静默**且不缓存失败——否则一次网络抖动会让整页离线标识冻结 30 秒；
 *   - 心跳只在登录后跑，且窗口必须比心跳间隔宽，否则永远显示离线。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createApp } from 'vue'
import { setActivePinia, createPinia } from 'pinia'

/*
 * 只桩掉两个会产生网络副作用的函数，**保留真实常量**。
 * 若连 HEARTBEAT_INTERVAL_MS / ONLINE_WINDOW_MS 一起桩掉，
 * 下面那条「窗口必须比心跳间隔宽」的断言就变成了自己跟自己比，毫无意义。
 */
vi.mock('@/api/user', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/user')>()
  return {
    ...actual,
    fetchOnlineIds: vi.fn(async (ids: number[]) => ids),
    heartbeat: vi.fn(async () => undefined)
  }
})

import { fetchOnlineIds, heartbeat, HEARTBEAT_INTERVAL_MS, ONLINE_WINDOW_MS } from '@/api/user'
import { useOnlineStore } from '@/stores/modules/online'

const fetchMock = vi.mocked(fetchOnlineIds)
const beatMock = vi.mocked(heartbeat)

/** 建一个干净的 pinia 容器（不用持久化插件：在线结论本就不该落盘） */
function freshPinia() {
  const pinia = createPinia()
  createApp({}).use(pinia)
  setActivePinia(pinia)
  return pinia
}

describe('useOnlineStore · 在线名单', () => {
  beforeEach(() => {
    freshPinia()
    fetchMock.mockReset()
    fetchMock.mockImplementation(async (ids: number[]) => ids)
    beatMock.mockReset()
    beatMock.mockImplementation(async () => undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /* ==================== 读取语义 ==================== */

  it('isOnline() 对未知 id 返回 false —— 不先闪一个假的「在线」', () => {
    const s = useOnlineStore()
    expect(s.isOnline(1)).toBe(false)
  })

  it('isOnline() 对 undefined / null / 0 返回 false（不是合法用户 id）', () => {
    const s = useOnlineStore()
    expect(s.isOnline(undefined)).toBe(false)
    expect(s.isOnline(null)).toBe(false)
    expect(s.isOnline(0)).toBe(false)
  })

  it('isOnline() 只认服务端说「在线」的那些 id', async () => {
    fetchMock.mockResolvedValueOnce([7])
    const s = useOnlineStore()
    await s.ensure([7, 8])
    expect(s.isOnline(7)).toBe(true)
    expect(s.isOnline(8)).toBe(false)
  })

  /* ==================== 批量合并 ==================== */

  it('同一时刻的多次 ensure() 合并成一次请求（一屏 20 张卡片 ≠ 20 个请求）', async () => {
    const s = useOnlineStore()
    await Promise.all([s.ensure([1]), s.ensure([2]), s.ensure([3])])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toEqual([1, 2, 3])
  })

  it('ensure() 应去重，并丢掉 0 / 负数 / undefined / null 等非法 id', async () => {
    const s = useOnlineStore()
    await s.ensure([4, 4, 0, -1, undefined, null, 5])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toEqual([4, 5])
  })

  it('ensure() 收到全非法 id 时不应发请求（也不抛错）', async () => {
    const s = useOnlineStore()
    await s.ensure([0, -3, undefined])
    await s.ensure([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  /* ==================== 缓存 TTL ==================== */

  it('TTL 内重复 ensure() 同一批 id 不重复打接口（滚动列表不会打爆接口）', async () => {
    const s = useOnlineStore()
    await s.ensure([9])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await s.ensure([9])
    await s.ensure([9])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('超过 TTL 后 ensure() 应重新查（在线状态不能长期缓存）', async () => {
    vi.useFakeTimers()
    const s = useOnlineStore()
    await s.ensure([9])
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // TTL 是 30 秒：推进 31 秒即过期
    vi.advanceTimersByTime(31_000)
    await s.ensure([9])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('refresh() 忽略 TTL 强制拉新（隐私开关切换后要立刻看到自己的新状态）', async () => {
    const s = useOnlineStore()
    await s.ensure([9])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await s.refresh([9])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('refresh() 收到空数组应短路，不发请求', async () => {
    const s = useOnlineStore()
    await s.refresh([])
    await s.refresh([0, -1])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  /* ==================== 响应是权威 ==================== */

  it('服务端回答是权威的：上次在线、这次不在名单里 → 必须由 true 改回 false', async () => {
    const s = useOnlineStore()
    fetchMock.mockResolvedValueOnce([11])
    await s.ensure([11])
    expect(s.isOnline(11)).toBe(true)

    // 对方关掉隐私开关（或超时离线）后，服务端不再返回他
    fetchMock.mockResolvedValueOnce([])
    await s.refresh([11])
    expect(s.isOnline(11)).toBe(false)
  })

  /* ==================== 失败必须静默且不缓存 ==================== */

  it('接口失败应静默（不抛错），标识退化成离线', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'))
    const s = useOnlineStore()
    await expect(s.ensure([12])).resolves.toBeUndefined()
    expect(s.isOnline(12)).toBe(false)
  })

  it('接口失败不应清掉已有结论（页面不该突然全灰）', async () => {
    const s = useOnlineStore()
    fetchMock.mockResolvedValueOnce([13])
    await s.ensure([13])
    expect(s.isOnline(13)).toBe(true)

    fetchMock.mockRejectedValueOnce(new Error('boom'))
    await s.refresh([13])
    expect(s.isOnline(13)).toBe(true)
  })

  it('★ 失败不写缓存 ★：下一次 ensure() 应立即重试，而不是把网络抖动缓存 30 秒', async () => {
    fetchMock.mockRejectedValueOnce(new Error('flaky'))
    const s = useOnlineStore()
    await s.ensure([14])
    expect(fetchMock).toHaveBeenCalledTimes(1)

    fetchMock.mockResolvedValueOnce([14])
    await s.ensure([14]) // 未推进时间：若失败被缓存，这里就不会再发请求
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(s.isOnline(14)).toBe(true)
  })

  /* ==================== reset ==================== */

  it('reset() 应清空结论与缓存时间（换账号登录不能看到上个账号的在线结论）', async () => {
    fetchMock.mockResolvedValueOnce([15])
    const s = useOnlineStore()
    await s.ensure([15])
    expect(s.isOnline(15)).toBe(true)

    s.reset()
    expect(s.isOnline(15)).toBe(false)
    expect(s.checkedAt[15]).toBeUndefined()

    // 缓存也被清掉 → 下次 ensure 必须重新问服务端
    fetchMock.mockResolvedValueOnce([])
    await s.ensure([15])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  /* ==================== 心跳生命周期 ==================== */

  it('startHeartbeat() 应立刻报到一次，之后按间隔续期', () => {
    vi.useFakeTimers()
    const s = useOnlineStore()
    s.startHeartbeat()
    expect(beatMock).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS)
    expect(beatMock).toHaveBeenCalledTimes(2)

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3)
    expect(beatMock).toHaveBeenCalledTimes(5)
    s.stopHeartbeat()
  })

  it('重复 startHeartbeat() 不应叠加定时器（否则心跳频率成倍上涨）', () => {
    vi.useFakeTimers()
    const s = useOnlineStore()
    s.startHeartbeat()
    s.startHeartbeat()
    s.startHeartbeat()
    expect(beatMock).toHaveBeenCalledTimes(1) // 只有第一次的立即报到

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 2)
    expect(beatMock).toHaveBeenCalledTimes(3) // 每个间隔一次，不是三次
    s.stopHeartbeat()
  })

  it('stopHeartbeat() 后不再心跳（退出登录必须停表）', () => {
    vi.useFakeTimers()
    const s = useOnlineStore()
    s.startHeartbeat()
    s.stopHeartbeat()
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 5)
    expect(beatMock).toHaveBeenCalledTimes(1)
  })

  it('stopHeartbeat() 后可以重新 startHeartbeat()（重新登录）', () => {
    vi.useFakeTimers()
    const s = useOnlineStore()
    s.startHeartbeat()
    s.stopHeartbeat()
    s.startHeartbeat()
    expect(beatMock).toHaveBeenCalledTimes(2) // 两次立即报到
    s.stopHeartbeat()
  })

  it('未 startHeartbeat() 时 stopHeartbeat() 应是幂等的空操作', () => {
    const s = useOnlineStore()
    expect(() => s.stopHeartbeat()).not.toThrow()
    expect(beatMock).not.toHaveBeenCalled()
  })

  it('心跳失败应静默（心跳断了只影响「我是否显示在线」，不该弹错误打扰用户）', async () => {
    beatMock.mockRejectedValueOnce(new Error('401'))
    const s = useOnlineStore()
    await expect(s.beat()).resolves.toBeUndefined()
  })

  /* ==================== 口径不变的硬约束 ==================== */

  it('★ 在线窗口必须明显宽于心跳间隔 ★ 否则每次心跳前都有一段「假离线」空窗', () => {
    expect(ONLINE_WINDOW_MS).toBe(5 * 60 * 1000)
    expect(HEARTBEAT_INTERVAL_MS).toBe(60 * 1000)
    // 至少能容忍连续丢 2 次心跳仍然在线
    expect(ONLINE_WINDOW_MS).toBeGreaterThanOrEqual(HEARTBEAT_INTERVAL_MS * 3)
    // 且窗口不能被调成 0 或负数（那样永远不会有人在线）
    expect(ONLINE_WINDOW_MS).toBeGreaterThan(0)
  })
})
