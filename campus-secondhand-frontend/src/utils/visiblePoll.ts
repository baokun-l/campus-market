/**
 * 可见性感知的轮询器
 *
 * 起因（L6）：消息页用 `setInterval` 每 5 秒拉一次会话列表，
 * 注释里写着「真实项目换成 WebSocket 推送」。轮询本身对课程项目是可接受的取舍，
 * 但那种写法还夹带两个跟「轮询 vs 推送」无关的缺陷：
 *
 * ① **请求会叠加**。`setInterval(5000)` 不管上一次跑完没有 —— 一次请求慢过 5 秒
 *    （弱网、后端 GC、后端重启中）就会有第二个、第三个请求并发打出去，
 *    而它们返回的顺序不保证，**后返回的旧快照会盖掉先返回的新快照**。
 *    症状是消息列表偶尔「跳回上一条」，刷新一下又对了。
 *
 * ② **标签页藏起来了还在打**。切到别的标签页、最小化之后定时器照跑，
 *    一天下来白白发出成千次请求；反过来，切回来时手上还是离开那一刻的旧快照。
 *
 * 所以这里用**串行化 + 可见性感知**替掉裸 setInterval：
 *   - 下一次只在**这一次结束后**才排期（链式 setTimeout，天然不会叠加）；
 *   - 文档隐藏时停表，回到前台**立刻补一次**再恢复节奏。
 *
 * ★ 刻意不做成「推送」★：WebSocket / SSE 需要后端加长连接、心跳、重连、鉴权续期，
 *   属于换一套架构，不在课程项目当前范围内。这里只把轮询写对。
 *
 * ★ 也刻意**不给在线心跳用**★：心跳一旦暂停，「我是否在线」就会在自己切走标签页
 *   几分钟后变成「离线」（在线判据是 `last_active_at` 距现在 300 秒内），
 *   那是功能倒退而不是优化。判据是「暂停后语义会不会变」：轮询拉列表只是延迟看到新数据，
 *   心跳却是别人眼里我的状态本身。同族不代表同处理。
 */

export interface VisiblePollerHandle {
  /**
   * 开始轮询：**不立刻执行**，只在 `intervalMs` 之后跑第一次。
   *
   * 首屏数据由调用方自己加载（页面已经要 await 一次），这里再立刻补一次就是重复请求。
   * 重复调用无副作用。
   */
  start(): void
  /** 停止轮询并摘掉 visibilitychange 监听。可重复调用。 */
  stop(): void
  /** 是否处于轮询状态（供测试与调试断言） */
  isRunning(): boolean
}

export interface VisiblePollerOptions {
  /** 轮询间隔（毫秒）。上一轮结束后再等这么久，所以实际周期 = 间隔 + 单轮耗时。 */
  intervalMs: number
  /** 每一轮要做的事，可以是异步的；**下一轮一定等它结束之后才排期** */
  tick: () => void | Promise<void>
}

/** 文档是否处于隐藏状态。SSR / 非浏览器环境下按「可见」处理，不做暂停。 */
function documentHidden(): boolean {
  if (typeof document === 'undefined') return false
  return document.visibilityState === 'hidden'
}

export function createVisiblePoller(options: VisiblePollerOptions): VisiblePollerHandle {
  const { intervalMs, tick } = options

  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false
  let inFlight = false

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  /** 跑一轮。★ 失败静默 ★：轮询失败只该导致「数据没更新」，不该弹错误打扰用户 */
  async function runOnce() {
    if (!running || inFlight) return
    inFlight = true
    try {
      await tick()
    } catch {
      /* 见上：下一轮照常排期，网络抖动不至于让轮询整体停摆 */
    } finally {
      inFlight = false
    }
  }

  /** 排下一轮。重复排期时先清掉旧的，保证任何时刻只有一个在飞 */
  function schedule(delayMs: number = intervalMs) {
    if (!running) return
    clearTimer()
    timer = setTimeout(async () => {
      timer = null
      await runOnce()
      schedule()
    }, delayMs)
  }

  function onVisibilityChange() {
    if (!running) return
    if (documentHidden()) {
      // 藏起来就停表：既省请求，也让「回到前台」走下面那条立刻补一次的分支
      clearTimer()
      return
    }
    // 回到前台：先立刻补一次（否则用户看到的是离开那一刻的旧快照），再恢复节奏
    void runOnce().then(() => schedule())
  }

  return {
    start() {
      if (running) return
      running = true
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', onVisibilityChange)
      }
      schedule()
    },

    stop() {
      running = false
      clearTimer()
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange)
      }
    },

    isRunning() {
      return running
    },
  }
}
