/**
 * 组件单元测试 · PriceTag 价格标签
 * 验证：价格渲染 / 划线价来自真实挂牌价 / 折扣标签 / 零价文案 / 货币符号
 *
 * 语义变更（重要）：`listPrice` 是**卖家挂牌价**（真实价格），
 * `promoPrice` 是让利后的活动价。划线价只可能是挂牌价本身 ——
 * 旧版 `original` 可以被随手传入一个虚构数字，已废弃。
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import PriceTag from './PriceTag.vue'

describe('PriceTag.vue · 价格标签组件', () => {
  it('应渲染出格式化后的价格（含 ¥ 符号，且不重复）', () => {
    const wrapper = mount(PriceTag, { props: { listPrice: 128 } })
    const now = wrapper.find('.now')
    expect(now.exists()).toBe(true)
    expect(now.text()).toBe('¥128.00')
    // 回归测试：曾出现「¥¥128.00」的重复符号 bug
    expect(now.text().match(/¥/g)?.length).toBe(1)
  })

  it('大额价格应带千分位', () => {
    const wrapper = mount(PriceTag, { props: { listPrice: 12345 } })
    expect(wrapper.find('.now').text()).toBe('¥12,345.00')
  })

  it('有让利价时应显示挂牌价删除线，现价显示让利价', () => {
    const wrapper = mount(PriceTag, { props: { listPrice: 100, promoPrice: 80 } })
    const origin = wrapper.find('.origin')
    expect(origin.exists()).toBe(true)
    expect(origin.element.tagName).toBe('DEL')
    // 划线价 = 真实挂牌价
    expect(origin.text()).toBe('¥100')
    // 现价 = 让利价
    expect(wrapper.find('.now').text()).toBe('¥80.00')
  })

  it('没有让利价时不应显示划线价（旧版可随手传虚构原价，已禁止）', () => {
    const wrapper = mount(PriceTag, { props: { listPrice: 100 } })
    expect(wrapper.find('.origin').exists()).toBe(false)
    expect(wrapper.find('.discount').exists()).toBe(false)
  })

  it('让利价不低于挂牌价时视为未参与活动（防止「反向涨价」误导）', () => {
    const wrapper = mount(PriceTag, { props: { listPrice: 100, promoPrice: 120 } })
    expect(wrapper.find('.origin').exists()).toBe(false)
    expect(wrapper.find('.discount').exists()).toBe(false)
    expect(wrapper.find('.now').text()).toBe('¥100.00')
  })

  it('让利价为 0 或负数时视为脏数据，按挂牌价成交', () => {
    for (const bad of [0, -20]) {
      const wrapper = mount(PriceTag, { props: { listPrice: 100, promoPrice: bad } })
      expect(wrapper.find('.now').text()).toBe('¥100.00')
      expect(wrapper.find('.discount').exists()).toBe(false)
    }
  })

  it('有让利时应显示折扣标签', () => {
    const wrapper = mount(PriceTag, { props: { listPrice: 100, promoPrice: 80 } })
    expect(wrapper.find('.discount').exists()).toBe(true)
    expect(wrapper.text()).toContain('8折')
  })

  it('非整折的折扣标签保留一位小数（不夸大折扣）', () => {
    const wrapper = mount(PriceTag, { props: { listPrice: 100, promoPrice: 88 } })
    expect(wrapper.text()).toContain('8.8折')
  })

  it('应支持自定义货币符号', () => {
    const wrapper = mount(PriceTag, { props: { listPrice: 10, symbol: '$' } })
    expect(wrapper.find('.now').text()).toBe('$10.00')
  })

  it('应支持自定义小数位数', () => {
    const wrapper = mount(PriceTag, { props: { listPrice: 10.5, decimal: 0 } })
    expect(wrapper.find('.now').text()).toBe('¥11')
  })

  it('价格为 0 且传入 zeroText 时应显示自定义文案（如「面议」）', () => {
    const wrapper = mount(PriceTag, { props: { listPrice: 0, zeroText: '面议' } })
    expect(wrapper.find('.now').text()).toBe('面议')
  })

  it('价格为 0 但未传 zeroText 时应正常显示 ¥0.00', () => {
    const wrapper = mount(PriceTag, { props: { listPrice: 0 } })
    expect(wrapper.find('.now').text()).toBe('¥0.00')
  })

  it('挂牌价为 0 时不应显示折扣标签（避免除零）', () => {
    const wrapper = mount(PriceTag, { props: { listPrice: 0, promoPrice: 50, zeroText: '面议' } })
    expect(wrapper.find('.discount').exists()).toBe(false)
  })

  it('应接受字符串形式的价格', () => {
    const wrapper = mount(PriceTag, { props: { listPrice: '66.6' } })
    expect(wrapper.find('.now').text()).toBe('¥66.60')
  })
})
