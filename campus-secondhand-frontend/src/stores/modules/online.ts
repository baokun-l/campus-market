/**
 * 在线名单（服务端权威）
 *
 * ★ 为什么要有这个 store ★
 *
 * 「谁在线」这件事此前是**每个页面各自编的**：`utils/prefs.isUserOnline()` 用
 * 「用户 id + 当天日期」做散列，约六成用户显示在线，当天固定、隔天变。
 * 结果是三个问题：
 *   1. 与「你到底在不在」无关 —— 关掉电脑它照样显示在线；
 *   2. 隐私开关是假的 —— 过滤发生在观看者的浏览器里，关掉开关只遮住了自己的眼睛；
 *   3. 每个渲染点自己算，口径随时可能漂移。
 *
 * 现在只有一个来源：后端 `GET /users/online`（判定口径 = show_online = 1 且 5 分钟内活跃）。
 * 本 store 负责三件事：
 *   - **批量**拉取：把同一时刻所有要显示的 id 合并成一次请求；
 *   - **短期缓存**：同一批 id 在 TTL 内不重复请求（否则滚动列表会把接口打爆）；
 *   - **心跳**：定时告诉服务端「我还在」，登录后才启动。
 *
 * ★ 失败必须静默 ★
 * 在线标识是**装饰性**信息：接口挂了不该让商品列表或消息页整个报错。
 * 所以这里吞掉异常，只让标识退化成「离线」。
 */
import { defineStore } from 'pinia'
import { fetchOnlineIds, heartbeat, HEARTBEAT_INTERVAL_MS } from '@/api/user'

/** 在线结论的缓存时长：比心跳间隔短一点，保证状态变化能较快反映出来 */
const CACHE_TTL_MS = 30 * 1000

/*
 * ★ 批量合并的缓冲（刻意放在模块作用域，不进 Pinia state）★
 *
 * 商品广场一页有二十多张卡片，每张卡片各自 `ensure([sellerId])`。
 * 若每次调用都直接发请求，一页就是二十多个并发请求 —— 而且这些请求
 * 内容高度重复（同一批卖家的在线状态）。
 * 这里把 id 先攒进 pending，在**同一个微任务**末尾统一发一次。
 *
 * 它们是「一次刷新的过程量」而不是状态：不需要响应式、不需要持久化、
 * 进 state 只会让 devtools 变得难读，所以放在模块作用域。
 */
let pendingIds: number[] = []
let flushScheduled = false
let flushPromise: Promise<void> = Promise.resolve()

interface State {
  /** userId → 服务端最近一次回答的在线状态 */
  online: Record<number, boolean>
  /** userId → 该结论的获取时刻（用于 TTL 去重） */
  checkedAt: Record<number, number>
  /** 心跳定时器句柄（不参与持久化，仅用于停止） */
  timer: ReturnType<typeof setInterval> | null
}

export const useOnlineStore = defineStore('online', {
  state: (): State => ({
    online: {},
    checkedAt: {},
    timer: null
  }),

  getters: {
    /** 某人此刻是否在线（未知一律按离线，避免先闪一个「在线」再变灰） */
    isOnline: (s) => (id?: number | null) =>
      id !== undefined && id !== null && s.online[id] === true
  },

  actions: {
    /**
     * 声明「我需要知道这批 id 的在线状态」。
     *
     * 多次调用会在同一个微任务里被合并成一次请求；
     * 已缓存且未过期的 id 直接跳过，因此滚动列表不会反复打接口。
     */
    ensure(ids: Array<number | undefined | null>): Promise<void> {
      const wanted = cleanIds(ids)
      if (wanted.length === 0) return Promise.resolve()

      wanted.forEach((id) => {
        if (!pendingIds.includes(id)) pendingIds.push(id)
      })

      if (!flushScheduled) {
        flushScheduled = true
        flushPromise = Promise.resolve().then(() => this.flush())
      }
      return flushPromise
    },

    /** 强制刷新这批 id（忽略缓存）：隐私开关切换、心跳之后用它把结论拉新 */
    async refresh(ids: Array<number | undefined | null>): Promise<void> {
      const wanted = cleanIds(ids)
      if (wanted.length === 0) return
      await this.load(wanted)
    },

    /** 把攒下来的 id 一次性查掉（由 ensure 在微任务末尾触发） */
    async flush(): Promise<void> {
      const all = pendingIds
      pendingIds = []
      flushScheduled = false

      const now = Date.now()
      const stale = all.filter((id) => now - (this.checkedAt[id] ?? 0) > CACHE_TTL_MS)
      if (stale.length === 0) return
      await this.load(stale)
    },

    /** 真正发请求并就地更新结论。响应对该批 id 是**权威**的：不在名单里就是离线 */
    async load(ids: number[]): Promise<void> {
      try {
        const onlineIds = await fetchOnlineIds(ids)
        const hit = new Set(onlineIds)
        const at = Date.now()
        ids.forEach((id) => {
          this.online[id] = hit.has(id)
          this.checkedAt[id] = at
        })
      } catch {
        /*
         * 静默：标识退化成离线，不打断页面。
         * 这里刻意**不写** checkedAt —— 于是下一次 ensure 会立刻重试，
         * 而不是把一次网络抖动缓存 30 秒。
         */
      }
    },

    /** 登出时清空：否则换账号登录会看到上一个账号留下的在线结论 */
    reset() {
      this.online = {}
      this.checkedAt = {}
      pendingIds = []
    },

    /**
     * 启动心跳：立刻报到一次，之后每 60 秒一次。
     *
     * ★ 只在登录后调用 ★
     * 未登录时调 `POST /user/heartbeat` 会拿到 401，而 request.ts 把 401 解释成
     * 「登录状态已过期」→ 弹窗 + 清 token + 跳登录页。游客一进站就被踢，
     * 所以调用方必须先确认有 token（见 App.vue 的 watch）。
     */
    startHeartbeat() {
      if (this.timer !== null) return
      void this.beat()
      this.timer = setInterval(() => void this.beat(), HEARTBEAT_INTERVAL_MS)
    },

    stopHeartbeat() {
      if (this.timer !== null) {
        clearInterval(this.timer)
        this.timer = null
      }
    },

    /** 单次心跳。失败静默：心跳断了只影响「我是否显示在线」，不该弹错误打扰用户 */
    async beat() {
      try {
        await heartbeat()
      } catch { /* 见上 */ }
    }
  }
})

/** 去重 + 丢掉非正整数（0 / 负数 / undefined 都不是合法用户 id） */
function cleanIds(ids: Array<number | undefined | null>): number[] {
  return [...new Set(ids.filter((id): id is number => typeof id === 'number' && id > 0))]
}
