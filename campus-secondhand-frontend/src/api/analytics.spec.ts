/**
 * API 层单元测试 · 数据可视化统计（Mock 模式 / JSON 静态数据源）
 * 验证图表数据源的结构正确性 —— 结构错误会直接导致 ECharts 渲染空白
 */
import { describe, it, expect } from 'vitest'
import {
  fetchTrend,
  fetchCategoryDistribution,
  fetchTopGoods,
  fetchDashboardSummary
} from '@/api/analytics'
import { mockHelpers, mockCategoryPie } from '@/api/mock'

describe('fetchTrend() · 趋势图数据', () => {
  it('默认返回 7 天数据', async () => {
    const list = await fetchTrend()
    expect(list.length).toBe(7)
  })

  it('应支持自定义天数', async () => {
    expect((await fetchTrend(30)).length).toBe(30)
  })

  it('每条数据应包含 date / pv / uv / orders 四个字段', async () => {
    const list = await fetchTrend(7)
    list.forEach((d) => {
      expect(d).toHaveProperty('date')
      expect(d).toHaveProperty('pv')
      expect(d).toHaveProperty('uv')
      expect(d).toHaveProperty('orders')
    })
  })

  it('所有数值应为非负数（ECharts 折线图不接受负值区间）', async () => {
    const list = await fetchTrend(15)
    list.forEach((d) => {
      expect(d.pv).toBeGreaterThanOrEqual(0)
      expect(d.uv).toBeGreaterThanOrEqual(0)
      expect(d.orders).toBeGreaterThanOrEqual(0)
    })
  })
})

describe('fetchCategoryDistribution() · 分类占比（饼图）', () => {
  it('应与静态数据 mockCategoryPie 完全一致', async () => {
    const list = await fetchCategoryDistribution()
    expect(list).toEqual(mockCategoryPie)
  })

  it('结构应满足 ECharts 饼图要求（name + value）', async () => {
    const list = await fetchCategoryDistribution()
    list.forEach((d) => {
      expect(typeof d.name).toBe('string')
      expect(typeof d.value).toBe('number')
    })
  })
})

describe('fetchTopGoods() · 热门商品榜', () => {
  it('默认返回 5 条', async () => {
    const list = await fetchTopGoods()
    expect(list.length).toBe(5)
  })

  it('应支持自定义条数', async () => {
    expect((await fetchTopGoods(10)).length).toBe(10)
  })

  it('应按浏览量倒序排列', async () => {
    const list = await fetchTopGoods(10)
    const views = list.map((g) => g.viewCount)
    for (let i = 1; i < views.length; i++) {
      expect(views[i - 1]).toBeGreaterThanOrEqual(views[i])
    }
  })

  it('排序不应破坏原始静态数据集顺序（使用 slice 副本）', async () => {
    const before = mockHelpers.getGoodsCache().map((g) => g.id)
    await fetchTopGoods(10)
    const after = mockHelpers.getGoodsCache().map((g) => g.id)
    expect(after).toEqual(before)
  })
})

describe('fetchDashboardSummary() · 看板汇总', () => {
  it('应返回四项汇总指标', async () => {
    const s = await fetchDashboardSummary()
    expect(s).toHaveProperty('goodsTotal')
    expect(s).toHaveProperty('userTotal')
    expect(s).toHaveProperty('orderTotal')
    expect(s).toHaveProperty('recentOrders')
  })

  it('商品总数应等于静态数据集长度', async () => {
    const s = await fetchDashboardSummary()
    expect(s.goodsTotal).toBe(mockHelpers.getGoodsCache().length)
  })

  it('订单总数应等于静态订单集长度', async () => {
    const s = await fetchDashboardSummary()
    expect(s.orderTotal).toBe(mockHelpers.getOrderCache().length)
  })

  it('各项指标应均为正整数', async () => {
    const s = await fetchDashboardSummary()
    expect(s.goodsTotal).toBeGreaterThan(0)
    expect(s.userTotal).toBeGreaterThan(0)
    expect(s.orderTotal).toBeGreaterThan(0)
    expect(s.recentOrders).toBeGreaterThan(0)
  })
})
