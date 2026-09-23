/**
 * API 层单元测试 · 平台公告模块（Mock 模式）
 * 覆盖：fetchNotices 排序规则（置顶优先 + 时间倒序）/ fetchNoticeById
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { fetchNotices, fetchNoticeById } from '@/api/notice'
import { mockNotices, mockNoticesCache } from '@/api/mock'

const ORIGINAL = mockNotices.map((n) => ({ ...n }))

describe('fetchNotices() · 公告列表', () => {
  beforeEach(() => {
    // 每条用例前还原原始数据集，避免相互污染
    mockNoticesCache.set(ORIGINAL.map((n) => ({ ...n })))
  })

  it('应返回全部公告，且条数与静态数据一致', async () => {
    const list = await fetchNotices()
    expect(list.length).toBe(ORIGINAL.length)
  })

  it('置顶公告应排在非置顶之前', async () => {
    const list = await fetchNotices()
    const firstUnpinnedIdx = list.findIndex((n) => !n.pinned)
    const lastPinnedIdx = list.map((n) => n.pinned).lastIndexOf(true)
    // 所有 pinned 项的下标都必须小于第一个非 pinned 项
    if (firstUnpinnedIdx !== -1 && lastPinnedIdx !== -1) {
      expect(lastPinnedIdx).toBeLessThan(firstUnpinnedIdx)
    }
  })

  it('同为非置顶时应按 createTime 倒序（新的在前）', async () => {
    const list = await fetchNotices()
    const unpinned = list.filter((n) => !n.pinned)
    for (let i = 1; i < unpinned.length; i++) {
      expect(unpinned[i - 1].createTime >= unpinned[i].createTime).toBe(true)
    }
  })

  it('列表中不含重复 id', async () => {
    const list = await fetchNotices()
    const ids = list.map((n) => n.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('不应修改原始 mockNotices 的条数（只读语义）', async () => {
    await fetchNotices()
    expect(mockNotices.length).toBe(ORIGINAL.length)
  })
})

describe('fetchNoticeById() · 单条公告', () => {
  beforeEach(() => {
    mockNoticesCache.set(ORIGINAL.map((n) => ({ ...n })))
  })

  it('应能按 id 取到公告并含完整正文', async () => {
    const target = ORIGINAL[0]
    const n = await fetchNoticeById(target.id)
    expect(n).not.toBeNull()
    expect(n!.title).toBe(target.title)
    // 正文应包含换行，便于页面按段落渲染
    expect(n!.content).toContain('\n')
  })

  it('id 不存在时应返回 null 而不是抛错', async () => {
    const n = await fetchNoticeById(999999)
    expect(n).toBeNull()
  })
})
