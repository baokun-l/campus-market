/**
 * API 层单元测试 · 商品模块（Mock 模式）
 *
 * 说明：测试运行于 VITE_USE_MOCK=true（见 .env.test），
 *      因此所有 API 调用的数据源均为 src/api/mock.ts 中的 JSON 静态数据，
 *      不依赖任何后端服务，符合「静态测试」要求。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  fetchGoods,
  fetchGoodsDetail,
  publishGoods,
  updateGoodsStatus,
  deleteGoods,
  fetchCategories,
  BUYER_VISIBLE_STATUS,
  SELLABLE_STATUS
} from '@/api/goods'
import { mockHelpers, mockCategories } from '@/api/mock'

describe('fetchGoods() · 商品分页查询', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('不传参数时应返回第 1 页、默认 12 条', async () => {
    const res = await fetchGoods({})
    expect(res.page).toBe(1)
    expect(res.pageSize).toBe(12)
    expect(res.list.length).toBe(12)
  })

  it('total 应等于静态数据集总数（60）', async () => {
    const res = await fetchGoods({})
    expect(res.total).toBe(60)
  })

  it('翻页应返回不同数据，且条数正确', async () => {
    const p1 = await fetchGoods({ page: 1, pageSize: 12 })
    const p2 = await fetchGoods({ page: 2, pageSize: 12 })
    expect(p1.list[0].id).not.toBe(p2.list[0].id)
    expect(p2.list.length).toBe(12)
  })

  it('最后一页应返回剩余条数（60 = 12 × 5，第 5 页满页）', async () => {
    const res = await fetchGoods({ page: 5, pageSize: 12 })
    expect(res.list.length).toBe(12)
  })

  it('超出页码范围时应返回空列表（而非报错）', async () => {
    const res = await fetchGoods({ page: 99, pageSize: 12 })
    expect(res.list.length).toBe(0)
    expect(res.total).toBe(60)
  })

  it('按分类筛选应只返回该分类商品', async () => {
    const res = await fetchGoods({ categoryId: 1, pageSize: 100 })
    expect(res.list.length).toBeGreaterThan(0)
    res.list.forEach((g) => expect(g.categoryId).toBe(1))
  })

  it('按状态筛选应只返回该状态商品', async () => {
    const res = await fetchGoods({ status: 'sold', pageSize: 100 })
    res.list.forEach((g) => expect(g.status).toBe('sold'))
  })

  it('statuses 白名单应排除「审核中 / 已下架」商品（买家侧可见范围）', async () => {
    const res = await fetchGoods({ statuses: BUYER_VISIBLE_STATUS, pageSize: 200 })
    expect(res.total).toBeGreaterThan(0)
    res.list.forEach((g) => {
      expect(['on_sale', 'sold']).toContain(g.status)
      // 回归：审核中的商品不能出现在买家的浏览入口，否则点进去才发现买不了
      expect(g.status).not.toBe('pending')
      expect(g.status).not.toBe('off_shelf')
    })
    // 白名单必须是「真过滤」：数量要少于不限状态时的全量
    const all = await fetchGoods({ pageSize: 200 })
    expect(res.total).toBeLessThan(all.total)
  })

  it('买家可见白名单只应包含在售与已售出，不能悄悄混入内部状态', () => {
    expect(BUYER_VISIBLE_STATUS).toEqual(['on_sale', 'sold'])
    expect(SELLABLE_STATUS).toEqual(['on_sale'])
  })

  it('关键词搜索应命中标题（大小写不敏感）', async () => {
    const all = await fetchGoods({ pageSize: 100 })
    const sample = all.list[0].title.slice(0, 2)
    const res = await fetchGoods({ keyword: sample, pageSize: 100 })
    expect(res.list.length).toBeGreaterThan(0)
    res.list.forEach((g) => expect(g.title).toContain(sample))
  })

  it('无匹配关键词时应返回空列表', async () => {
    const res = await fetchGoods({ keyword: '__绝对不存在的商品名__' })
    expect(res.list.length).toBe(0)
    expect(res.total).toBe(0)
  })

  it('sort=price_asc 应按价格升序', async () => {
    const res = await fetchGoods({ sort: 'price_asc', pageSize: 20 })
    const prices = res.list.map((g) => g.price)
    expect([...prices].sort((a, b) => a - b)).toEqual(prices)
  })

  it('sort=price_desc 应按价格降序', async () => {
    const res = await fetchGoods({ sort: 'price_desc', pageSize: 20 })
    const prices = res.list.map((g) => g.price)
    expect([...prices].sort((a, b) => b - a)).toEqual(prices)
  })

  it('sort=new 应按发布时间倒序', async () => {
    const res = await fetchGoods({ sort: 'new', pageSize: 20 })
    const times = res.list.map((g) => +new Date(g.createTime))
    for (let i = 1; i < times.length; i++) {
      expect(times[i - 1]).toBeGreaterThanOrEqual(times[i])
    }
  })

  it('sort=hot 应按浏览量倒序', async () => {
    const res = await fetchGoods({ sort: 'hot', pageSize: 20 })
    const views = res.list.map((g) => g.viewCount)
    for (let i = 1; i < views.length; i++) {
      expect(views[i - 1]).toBeGreaterThanOrEqual(views[i])
    }
  })

  it('分页不应改变静态数据集本身（slice 而非原地修改）', async () => {
    await fetchGoods({ page: 1, pageSize: 5 })
    expect(mockHelpers.getGoodsCache().length).toBe(60)
  })
})

describe('fetchGoodsDetail() · 商品详情', () => {
  it('应能按 id 查到对应商品', async () => {
    const target = mockHelpers.getGoodsCache()[0]
    const g = await fetchGoodsDetail(target.id)
    expect(g.id).toBe(target.id)
    expect(g.title).toBe(target.title)
  })

  it('应接受字符串 id（来源于路由参数）', async () => {
    const target = mockHelpers.getGoodsCache()[1]
    const g = await fetchGoodsDetail(String(target.id))
    expect(g.id).toBe(target.id)
  })

  it('id 不存在时应抛出「商品不存在」', async () => {
    await expect(fetchGoodsDetail(999999)).rejects.toThrow('商品不存在')
  })

  it('「我的发布」的商品也应能查到（回归：点查看提示商品不存在）', async () => {
    // 演示集商品（id 9000+）只存在 _myGoodsCache，不在主商品池；
    // 详情接口必须回退查询，否则个人主页「我的发布 → 查看」必然 404
    const mine = mockHelpers.getMyGoodsCache()[0]
    expect(mine).toBeTruthy()
    const g = await fetchGoodsDetail(mine.id)
    expect(g.id).toBe(mine.id)
    expect(g.title).toBe(mine.title)
  })
})

describe('publishGoods() · 发布商品', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('新发布的商品状态应为 pending（待审核）', async () => {
    const g = await publishGoods({ title: '测试商品', price: 88 })
    expect(g.status).toBe('pending')
    expect(g.title).toBe('测试商品')
    expect(g.price).toBe(88)
  })

  it('发布后应插入到静态数据集头部，总数 +1', async () => {
    const before = mockHelpers.getGoodsCache().length
    await publishGoods({ title: '新商品', price: 10 })
    expect(mockHelpers.getGoodsCache().length).toBe(before + 1)
    expect(mockHelpers.getGoodsCache()[0].title).toBe('新商品')
  })

  it('未传标题时应使用默认值「未命名」', async () => {
    const g = await publishGoods({ price: 1 })
    expect(g.title).toBe('未命名')
  })

  it('应根据 categoryId 自动填充分类名称', async () => {
    const g = await publishGoods({ title: '数码商品', price: 1, categoryId: 2 })
    expect(g.categoryName).toBe(mockCategories.find((c) => c.id === 2)?.name)
  })

  it('新商品初始浏览量与收藏量应为 0', async () => {
    const g = await publishGoods({ title: 'x', price: 1 })
    expect(g.viewCount).toBe(0)
    expect(g.favoriteCount).toBe(0)
  })

  it('未传封面时应回退到分类实拍图池（本地静态资源，零外链依赖）', async () => {
    const g = await publishGoods({ title: 'x', price: 1 })
    // 不再使用 picsum.photos 等外部图片；默认封面 = public/goods/ 下的本地实拍图
    expect(g.cover).toMatch(/^\/goods\/cat\d-\d\.jpg$/)
  })
})

describe('updateGoodsStatus() · 状态更新', () => {
  it('应能把商品状态改为 sold', async () => {
    const target = mockHelpers.getGoodsCache().find((g) => g.status === 'on_sale')!
    await updateGoodsStatus({ id: target.id, status: 'sold' })
    expect(mockHelpers.getGoodsCache().find((g) => g.id === target.id)?.status).toBe('sold')
  })

  it('更新不存在的商品不应抛错', async () => {
    await expect(updateGoodsStatus({ id: 999999, status: 'sold' })).resolves.toBeUndefined()
  })
})

describe('deleteGoods() · 删除商品', () => {
  it('删除后总数应 -1，且该 id 不再存在', async () => {
    const target = mockHelpers.getGoodsCache()[0]
    const before = mockHelpers.getGoodsCache().length
    await deleteGoods(target.id)
    expect(mockHelpers.getGoodsCache().length).toBe(before - 1)
    expect(mockHelpers.getGoodsCache().find((g) => g.id === target.id)).toBeUndefined()
  })

  it('删除不存在的 id 不应影响总数', async () => {
    const before = mockHelpers.getGoodsCache().length
    await deleteGoods(999999)
    expect(mockHelpers.getGoodsCache().length).toBe(before)
  })
})

describe('fetchCategories() · 分类列表', () => {
  it('返回的分类数量应与静态数据一致', async () => {
    const list = await fetchCategories()
    expect(list.length).toBe(mockCategories.length)
    expect(list).toEqual(mockCategories)
  })
})
