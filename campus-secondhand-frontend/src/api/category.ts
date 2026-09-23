/**
 * 商品分类 API（管理后台「分类管理」）
 * 分类是全站共用的字典数据，删除前必须确认分类下没有商品，否则会留下孤儿数据。
 */
import { request } from './request'
import { mockHelpers, mockCategoriesCache } from './mock'
import type { Category } from '@/types'

const USE_MOCK = import.meta.env.VITE_USE_MOCK === 'true'

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 全部分类（前台筛选、发布页、后台共用） */
export async function fetchCategories(): Promise<Category[]> {
  if (USE_MOCK) {
    await delay(100)
    return mockCategoriesCache.get()
  }
  return request({ url: '/categories' })
}

export interface CategoryStat extends Category {
  /** 该分类下的商品数 */
  count: number
}

/** 分类 + 商品数（后台分类管理列表） */
export async function fetchCategoryStats(): Promise<CategoryStat[]> {
  if (USE_MOCK) {
    await delay(160)
    return mockCategoriesCache
      .get()
      .map((c) => ({ ...c, count: mockHelpers.countGoodsByCategory(c.id) }))
  }
  return request({ url: '/admin/categories/stats' })
}

/** 新增分类（重名会被拒绝） */
export async function createCategory(payload: { name: string; icon: string }): Promise<Category> {
  if (USE_MOCK) {
    await delay(200)
    const name = payload.name.trim()
    const list = mockCategoriesCache.get()
    if (list.some((c) => c.name === name)) throw new Error('该分类名称已存在')
    const category: Category = {
      id: Math.max(0, ...list.map((c) => c.id)) + 1,
      name,
      icon: payload.icon.trim() || '📦'
    }
    mockCategoriesCache.set([...list, category])
    mockHelpers.addAuditLog({
      action: 'category.create',
      actionLabel: '新增分类',
      target: `分类「${category.name}」`,
      detail: `ID ${category.id}`
    })
    return category
  }
  return request({ url: '/admin/categories', method: 'POST', data: payload })
}

/** 编辑分类（改名 / 换图标） */
export async function updateCategory(id: number, patch: { name?: string; icon?: string }): Promise<Category> {
  if (USE_MOCK) {
    await delay(200)
    const list = mockCategoriesCache.get()
    const target = list.find((c) => c.id === id)
    if (!target) throw new Error('分类不存在')
    const name = patch.name?.trim()
    if (name && list.some((c) => c.id !== id && c.name === name)) throw new Error('该分类名称已存在')

    const next = list.map((c) =>
      c.id === id ? { ...c, name: name || c.name, icon: patch.icon?.trim() || c.icon } : c
    )
    mockCategoriesCache.set(next)
    // 分类名是冗余在商品上的（categoryName），改名后要同步，否则列表里会显示旧名
    if (name && name !== target.name) {
      const goods = mockHelpers.getGoodsCache()
      goods.forEach((g) => {
        if (g.categoryId === id) g.categoryName = name
      })
      mockHelpers.setGoodsCache(goods)
    }
    const updated = next.find((c) => c.id === id)!
    mockHelpers.addAuditLog({
      action: 'category.update',
      actionLabel: '编辑分类',
      target: `分类「${updated.name}」`,
      detail: name && name !== target.name ? `名称：${target.name} → ${name}` : '更新图标'
    })
    return updated
  }
  return request({ url: `/admin/categories/${id}`, method: 'PATCH', data: patch })
}

/**
 * 删除分类。
 * 分类下仍有商品时**拒绝删除**（返回 ok:false + 原因），而不是留下 categoryId 悬空的商品。
 */
export async function deleteCategory(id: number): Promise<{ ok: boolean; reason?: string }> {
  if (USE_MOCK) {
    await delay(200)
    const list = mockCategoriesCache.get()
    const target = list.find((c) => c.id === id)
    if (!target) return { ok: false, reason: '分类不存在' }

    const count = mockHelpers.countGoodsByCategory(id)
    if (count > 0) {
      return { ok: false, reason: `该分类下还有 ${count} 件商品，请先转移或删除商品后再删除分类` }
    }
    mockCategoriesCache.set(list.filter((c) => c.id !== id))
    mockHelpers.addAuditLog({
      action: 'category.delete',
      actionLabel: '删除分类',
      target: `分类「${target.name}」`,
      detail: `ID ${id}`
    })
    return { ok: true }
  }
  return request({ url: `/admin/categories/${id}`, method: 'DELETE' })
}
