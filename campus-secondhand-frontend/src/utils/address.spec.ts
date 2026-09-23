/**
 * 收货地址工具单元测试
 *
 * 覆盖：needsShipping / formatAddress / pickDefaultAddress
 *
 * ★ 为什么这几个纯函数值得单独测 ★
 *
 * 它们是「下单时用真实地址」这条链路的唯一分叉点：
 * 判断错一次，要么该填地址的场景放过去了（卖家发货时没地址可用），
 * 要么不该填的场景被拦住（面交的单下不了）。
 * 而这两类错误**都不会报错**，只会表现成「订单里地址不对」，事后极难定位。
 */
import { describe, it, expect } from 'vitest'
import { needsShipping, formatAddress, pickDefaultAddress } from '@/utils/address'
import type { Address } from '@/types'

function addr(over: Partial<Address> = {}): Address {
  return {
    id: 1,
    receiver: '刘宝坤',
    phone: '13800000000',
    region: '北京市海淀区',
    detail: '学院路 38 号 3 号楼 201',
    isDefault: false,
    ...over
  }
}

/* ============ needsShipping() ============ */
describe('needsShipping() · 是否需要收货地址', () => {
  it('只有「包邮快递」需要收货地址', () => {
    expect(needsShipping('express')).toBe(true)
  })

  it('面交与自提都不需要 —— 校内当面相约 / 买家上门自取', () => {
    expect(needsShipping('face')).toBe(false)
    expect(needsShipping('self')).toBe(false)
  })

  it('未填写交易方式时按「不需要」处理，与 deliveryLabel 的默认值（面交）一致', () => {
    expect(needsShipping(undefined)).toBe(false)
  })
})

/* ============ formatAddress() ============ */
describe('formatAddress() · 结构化地址拼成落库字符串', () => {
  it('region 与 detail 用空格连接', () => {
    expect(formatAddress({ region: '北京市海淀区', detail: '学院路 38 号' })).toBe(
      '北京市海淀区 学院路 38 号'
    )
  })

  it('两端空白会被裁掉，不会拼出「北京市海淀区  学院路」这种双空格', () => {
    expect(formatAddress({ region: '  北京市海淀区 ', detail: ' 学院路 38 号  ' })).toBe(
      '北京市海淀区 学院路 38 号'
    )
  })

  it('缺 region 时只输出 detail，而不是拼出一个 undefined', () => {
    expect(formatAddress({ region: '', detail: '学院路 38 号' })).toBe('学院路 38 号')
  })

  it('缺 detail 时只输出 region', () => {
    expect(formatAddress({ region: '北京市海淀区', detail: '' })).toBe('北京市海淀区')
  })

  it('传入 null / undefined / 空对象都返回空串，不抛异常', () => {
    expect(formatAddress(null)).toBe('')
    expect(formatAddress(undefined)).toBe('')
    expect(formatAddress({})).toBe('')
  })

  it('结果里绝不该出现 [object Object] 或 undefined —— 后端 address 是单列 varchar', () => {
    const text = formatAddress(addr())
    expect(text).not.toContain('object')
    expect(text).not.toContain('undefined')
  })
})

/* ============ pickDefaultAddress() ============ */
describe('pickDefaultAddress() · 默认地址', () => {
  it('优先返回标记了 isDefault 的那条，哪怕它不在第一位', () => {
    const list = [addr({ id: 1 }), addr({ id: 2, isDefault: true }), addr({ id: 3 })]
    expect(pickDefaultAddress(list)?.id).toBe(2)
  })

  it('一条都没标默认时退回第一条 —— 结算页需要一个确定的初值', () => {
    const list = [addr({ id: 7 }), addr({ id: 8 })]
    expect(pickDefaultAddress(list)?.id).toBe(7)
  })

  it('多条都标了默认时取最先出现的那条，行为可预期', () => {
    const list = [addr({ id: 4, isDefault: true }), addr({ id: 5, isDefault: true })]
    expect(pickDefaultAddress(list)?.id).toBe(4)
  })

  it('空列表 / null / undefined 返回 undefined，调用方据此显示「请先添加地址」', () => {
    expect(pickDefaultAddress([])).toBeUndefined()
    expect(pickDefaultAddress(null)).toBeUndefined()
    expect(pickDefaultAddress(undefined)).toBeUndefined()
  })
})
