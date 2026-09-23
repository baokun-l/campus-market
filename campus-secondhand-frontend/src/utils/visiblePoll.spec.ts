import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createVisiblePoller } from './visiblePoll'

/**
 * L6 的回归测试：轮询不该叠加、不该在标签页藏起来时继续打请求。
 *
 * 这两条都是**裸 setInterval 的固有问题**，不是「轮询 vs 推送」的取舍问题 ——
 * 所以它们必须被钉住，将来谁把实现简化回 setInterval 都要红。
 */

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

describe('createVisiblePoller', () => {
  let calls = 0

  beforeEach(() => {
    vi.useFakeTimers()
    calls = 0
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function poller(intervalMs = 5000, tick?: () => void | Promise<void>) {
    return createVisiblePoller({
      intervalMs,
      tick: tick ?? (() => { calls += 1 }),
    })
  }

  it('start 不立刻执行：首屏数据由调用方自己加载，重复拉一次是浪费', async () => {
    const p = poller()
    p.start()

    expect(calls).toBe(0)

    await vi.advanceTimersByTimeAsync(5000)
    expect(calls).toBe(1)

    await vi.advanceTimersByTimeAsync(5000)
    expect(calls).toBe(2)

    p.stop()
  })

  it('★ 上一轮没结束就不排下一轮：慢请求不会叠成并发，也就不会旧快照盖新快照', async () => {
    let releaseFirst: (() => void) | null = null
    const p = poller(5000, () =>
      new Promise<void>((resolve) => {
        calls += 1
        if (releaseFirst === null) releaseFirst = resolve
        else resolve()
      })
    )
    p.start()

    // 第一轮发出后一直不返回
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls).toBe(1)

    // 时间过了 10 个周期，仍然只有 1 次调用（旧实现这里会是 11 次并发请求）
    await vi.advanceTimersByTimeAsync(5000 * 10)
    expect(calls).toBe(1)

    // 放行第一轮之后，下一轮才被排上
    releaseFirst!()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls).toBe(2)

    p.stop()
  })

  it('★ 文档隐藏时停表，回到可见时立刻补一次（否则用户看到的是离开那一刻的旧数据）', async () => {
    const p = poller()
    p.start()

    await vi.advanceTimersByTimeAsync(5000)
    expect(calls).toBe(1)

    setVisibility('hidden')
    await vi.advanceTimersByTimeAsync(5000 * 20)
    expect(calls).toBe(1) // 藏起来期间一次都不打

    setVisibility('visible')
    expect(calls).toBe(2) // ★ 同步就补了一次，不用等 5 秒
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls).toBe(3) // 之后恢复原有节奏

    p.stop()
  })

  it('stop 之后不再轮询，且重复 stop 不报错', async () => {
    const p = poller()
    p.start()
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls).toBe(1)

    p.stop()
    p.stop()
    expect(p.isRunning()).toBe(false)

    await vi.advanceTimersByTimeAsync(5000 * 5)
    expect(calls).toBe(1)

    // stop 之后不该还留着 visibilitychange 监听（否则回到前台会补一次）
    setVisibility('hidden')
    setVisibility('visible')
    await vi.advanceTimersByTimeAsync(5000 * 2)
    expect(calls).toBe(1)
  })

  it('start 幂等：重复调用不会开出第二条时间线', async () => {
    const p = poller()
    p.start()
    p.start()
    p.start()

    await vi.advanceTimersByTimeAsync(5000)
    expect(calls).toBe(1)

    await vi.advanceTimersByTimeAsync(5000)
    expect(calls).toBe(2)

    p.stop()
  })

  it('单轮抛错不会让轮询停摆，也不会把异常漏成未处理拒绝', async () => {
    // ★ 这条钉两件事 ★（红绿实测：裸 setInterval 版本会红在这里，但红的原因是第二件）
    //   ① 轮询继续：calls 从 1 涨到 2；
    //   ② 异常被吞掉：裸 setInterval 里 `void tick()` 的 rejection 无人接，
    //      会变成 unhandledRejection 冒到测试进程上 —— 而轮询器的职责就是"失败静默"。
    const p = poller(5000, () => {
      calls += 1
      if (calls === 1) throw new Error('网络抖了一下')
    })
    p.start()

    await vi.advanceTimersByTimeAsync(5000)
    expect(calls).toBe(1)

    await vi.advanceTimersByTimeAsync(5000)
    expect(calls).toBe(2)

    p.stop()
  })
})
