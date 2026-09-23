/**
 * 平台公告 API
 * 阅读侧：列表 / 详情；管理侧：新增 / 编辑 / 置顶 / 删除（全部写入操作日志）。
 */
import { request } from './request'
import { mockNoticesCache, mockHelpers } from './mock'
import type { Notice } from '@/types'

const USE_MOCK = import.meta.env.VITE_USE_MOCK === 'true'

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 拉取公告列表（置顶优先 + 时间倒序） */
export async function fetchNotices(): Promise<Notice[]> {
  if (USE_MOCK) {
    await delay(220)
    const list = mockNoticesCache.get().slice()
    return list.sort((a, b) => {
      // pinned 倒序（true 排前），同状态按 createTime 倒序
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      return a.createTime < b.createTime ? 1 : -1
    })
  }
  return request({ url: '/notices', method: 'GET', showLoading: false })
}

/** 根据 id 读取单条公告（详情页用到） */
export async function fetchNoticeById(id: number): Promise<Notice | null> {
  if (USE_MOCK) {
    await delay(150)
    return mockNoticesCache.get().find((n) => n.id === id) ?? null
  }
  try {
    return await request<Notice>({
      url: `/notices/${id}`,
      method: 'GET',
      showLoading: false
    })
  } catch {
    return null
  }
}

/* ====================================================================
 * 管理端：公告 CRUD
 * ==================================================================== */

/** 本地打补丁（不记日志），交给各公开方法决定怎么记 */
function patchNotice(id: number, patch: Partial<Notice>): Notice {
  const list = mockNoticesCache.get()
  const target = list.find((n) => n.id === id)
  if (!target) throw new Error('公告不存在')
  const next = list.map((n) => (n.id === id ? { ...n, ...patch, id: n.id } : n))
  mockNoticesCache.set(next)
  return next.find((n) => n.id === id)!
}

/** 新建公告 */
export async function createNotice(payload: { title: string; content: string; pinned?: boolean }): Promise<Notice> {
  if (USE_MOCK) {
    await delay(260)
    const list = mockNoticesCache.get()
    const notice: Notice = {
      id: Math.max(0, ...list.map((n) => n.id)) + 1,
      title: payload.title.trim(),
      content: payload.content,
      pinned: !!payload.pinned,
      createTime: new Date().toISOString()
    }
    mockNoticesCache.set([notice, ...list])
    mockHelpers.addAuditLog({
      action: 'notice.create',
      actionLabel: '发布公告',
      target: `公告 #${notice.id}`,
      detail: `${notice.title}${notice.pinned ? '（置顶）' : ''}`
    })
    return notice
  }
  return request({ url: '/admin/notices', method: 'POST', data: payload })
}

/** 编辑公告 */
export async function updateNotice(
  id: number,
  patch: { title?: string; content?: string; pinned?: boolean }
): Promise<Notice> {
  if (USE_MOCK) {
    await delay(260)
    const updated = patchNotice(id, patch)
    mockHelpers.addAuditLog({
      action: 'notice.update',
      actionLabel: '编辑公告',
      target: `公告 #${id}`,
      detail: updated.title
    })
    return updated
  }
  return request({ url: `/admin/notices/${id}`, method: 'PATCH', data: patch })
}

/** 置顶 / 取消置顶 */
export async function toggleNoticePin(id: number): Promise<Notice> {
  if (USE_MOCK) {
    await delay(200)
    const before = mockNoticesCache.get().find((n) => n.id === id)
    if (!before) throw new Error('公告不存在')
    const updated = patchNotice(id, { pinned: !before.pinned })
    mockHelpers.addAuditLog({
      action: 'notice.pin',
      actionLabel: updated.pinned ? '置顶公告' : '取消置顶',
      target: `公告 #${id}`,
      detail: updated.title
    })
    return updated
  }
  return request({ url: `/admin/notices/${id}/pin`, method: 'POST' })
}

/** 删除公告 */
export async function deleteNotice(id: number): Promise<void> {
  if (USE_MOCK) {
    await delay(220)
    const target = mockNoticesCache.get().find((n) => n.id === id)
    mockNoticesCache.set(mockNoticesCache.get().filter((n) => n.id !== id))
    if (target) {
      mockHelpers.addAuditLog({
        action: 'notice.delete',
        actionLabel: '删除公告',
        target: `公告 #${id}`,
        detail: target.title
      })
    }
    return
  }
  return request({ url: `/admin/notices/${id}`, method: 'DELETE' })
}
