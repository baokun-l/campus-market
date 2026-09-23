/**
 * 私信全局状态：未读数、会话列表缓存
 */
import { defineStore } from 'pinia'
/*
 * ★ 这一行显式 import 是必须的，不要删 ★
 *
 * 项目里 `ElMessage` / `ElNotification` 都靠 `unplugin-auto-import` 自动注入，
 * 但**类型**来自生成的 `src/types/auto-imports.d.ts`，而那个文件是**按需扫描产物**：
 * 只有当它在一次 vite 运行中被重新生成时，才会把新用到的 `ElNotification` 补进去。
 * 结果就是「运行时正常、`vue-tsc` 报 TS2552 Cannot find name 'ElNotification'」——
 * 而 `npm run build`（= `vue-tsc -b && vite build`）会因此在类型检查阶段直接失败。
 * 显式导入让类型与运行时的来源都确定下来，不再依赖生成物的时效性。
 */
import { ElNotification } from 'element-plus'
import type { ChatSession } from '@/types'
import { fetchSessions, fetchUnreadTotal } from '@/api/message'
import { useUserStore } from './user'
import { useAppStore } from './app'
import { loadDnd, isInDndNow } from '@/utils/prefs'

interface State {
  sessions: ChatSession[]
  unread: number
  loading: boolean
  /** 供详情页 → 消息页跳转时携带的目标会话 */
  pendingSessionId: string | null
}

export const useMessageStore = defineStore('message', {
  state: (): State => ({
    sessions: [],
    unread: 0,
    loading: false,
    pendingSessionId: null
  }),
  getters: {
    hasUnread: (s) => s.unread > 0,
    unreadText: (s) => (s.unread > 99 ? '99+' : String(s.unread))
  },
  actions: {
    async loadSessions() {
      const userStore = useUserStore()
      if (!userStore.profile) return
      this.loading = true
      try {
        this.sessions = await fetchSessions(userStore.profile.id)
        this.unread = this.sessions.reduce((acc, s) => acc + s.unread, 0)
      } finally {
        this.loading = false
      }
    },
    async refreshUnread() {
      const userStore = useUserStore()
      if (!userStore.profile) return
      const prev = this.unread
      this.unread = await fetchUnreadTotal(userStore.profile.id)

      /*
       * ★ 设置页「消息通知 / 勿扰时段」的真正生效点 ★
       * 未读数上涨 = 有新消息进来，此时弹提醒，受三道闸门约束：
       *   ① 「交易消息」开关关闭 → 一律不弹
       *   ② 处于勿扰时段 → 静音（红点角标仍保留，打开消息页照样能看）
       *   ③ 未读数没有新增 → 不打扰
       */
      if (this.unread > prev && prev >= 0 && this.unread > 0) {
        const app = useAppStore()
        if (!app.settings.notifyTrade) return
        if (isInDndNow(loadDnd(userStore.profile.id))) return
        const delta = this.unread - prev
        ElNotification({
          title: '新消息提醒',
          message: `您有 ${delta} 条新的未读消息`,
          type: 'info',
          duration: 4000
        })
      }
    },
    setPendingSession(id: string | null) { this.pendingSessionId = id },
    reset() {
      this.sessions = []
      this.unread = 0
      this.pendingSessionId = null
    }
  }
})
