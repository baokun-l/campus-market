/**
 * 平台公告全局状态：列表缓存 + 未读红点
 *
 * 未读判定：本地记录「已读公告 id 集合」（localStorage['c2c-notice-read']）。
 * 拉到的公告里只要存在 id 不在集合中的，就视为有未读 → Header 显示红点。
 * 进入公告页即视为全部已读，红点自动消失（同一 store，天然响应式）。
 *
 * 说明：只做前端本地已读态，不新增接口；管理员新发一条公告后 id 变新，
 * 红点会重新亮起，符合「有新的公告信息时显示红点」。
 */
import { defineStore } from 'pinia'
import type { Notice } from '@/types'
import { fetchNotices } from '@/api/notice'

const READ_KEY = 'c2c-notice-read'

/** 读取已读 id 集合；坏数据一律降级为空数组，避免整块功能挂掉 */
function loadReadIds(): number[] {
  try {
    const raw = localStorage.getItem(READ_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'number') : []
  } catch {
    return []
  }
}

function saveReadIds(ids: number[]) {
  try {
    localStorage.setItem(READ_KEY, JSON.stringify(ids))
  } catch {
    /* 隐私模式下写入失败：忽略，红点退化为「本次会话有效」 */
  }
}

interface State {
  notices: Notice[]
  readIds: number[]
  loading: boolean
}

export const useNoticeStore = defineStore('notice', {
  state: (): State => ({
    notices: [],
    readIds: loadReadIds(),
    loading: false
  }),
  getters: {
    /** 未读公告条数 */
    unreadCount: (s) => s.notices.filter((n) => !s.readIds.includes(n.id)).length,
    hasUnread(): boolean {
      return this.unreadCount > 0
    }
  },
  actions: {
    /** 拉取公告列表（Header 挂载时与公告页共用） */
    async load() {
      this.loading = true
      try {
        this.notices = await fetchNotices()
      } finally {
        this.loading = false
      }
    },
    /** 全部标记为已读（进入公告页时调用） */
    markAllRead() {
      const ids = this.notices.map((n) => n.id)
      const merged = Array.from(new Set([...this.readIds, ...ids]))
      this.readIds = merged
      saveReadIds(merged)
    },
    /** 退出登录时清空缓存（已读记录保留在本地，不属于账号敏感数据） */
    reset() {
      this.notices = []
    }
  }
})
