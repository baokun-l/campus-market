/**
 * 费率单位换算单测。
 *
 * 这组用例守的是一个「必然报错」的线上缺陷：
 * 界面以百分比呈现服务费率（0 ~ 20），后端却按比率（0 ~ 1）校验。
 * 前端把 `2` 原样发出去 = 后端 1001 拒绝 —— 而输入框里那个数看起来毫无问题。
 * 所以这里最关键的断言不是「换算对不对」，而是
 * **「界面允许输入的任何值，换算后都必须落在后端 0 ~ 1 的校验区间内」**。
 */
import { describe, it, expect } from 'vitest'
import { ratioToPercent, percentToRatio } from '@/utils/rate'

describe('费率换算 · 方向正确', () => {
  it('比率转百分比', () => {
    expect(ratioToPercent(0.02)).toBe(2)
    expect(ratioToPercent(0.2)).toBe(20)
    expect(ratioToPercent(0.005)).toBe(0.5)
    expect(ratioToPercent(0)).toBe(0)
    expect(ratioToPercent(1)).toBe(100)
  })

  it('百分比转比率', () => {
    expect(percentToRatio(2)).toBe(0.02)
    expect(percentToRatio(20)).toBe(0.2)
    expect(percentToRatio(0.5)).toBe(0.005)
    expect(percentToRatio(0)).toBe(0)
    expect(percentToRatio(100)).toBe(1)
  })
})

describe('费率换算 · 非法输入不产生 NaN', () => {
  it.each([undefined, null, NaN, Infinity, -Infinity, '2', {}, [], true])(
    'percentToRatio(%s) 回落为 0',
    (bad) => {
      expect(percentToRatio(bad)).toBe(0)
    }
  )

  it.each([undefined, null, NaN, Infinity, '0.02', {}])('ratioToPercent(%s) 回落为 0', (bad) => {
    expect(ratioToPercent(bad)).toBe(0)
  })
})

describe('费率换算 · 往返稳定（保证 dirty 提示能消掉）', () => {
  // 覆盖表单允许的取值：整数、0.5 步进、以及边界
  const percents = [0, 0.5, 1, 1.5, 2, 2.5, 7.5, 19.5, 20]

  it.each(percents)('%s%% 往返后不变', (p) => {
    expect(ratioToPercent(percentToRatio(p))).toBe(p)
  })

  it('换算结果不超过 4 位小数（DECIMAL(5,4) 的容量）', () => {
    for (const p of percents) {
      const text = String(percentToRatio(p))
      const decimals = text.includes('.') ? text.split('.')[1].length : 0
      expect(decimals).toBeLessThanOrEqual(4)
    }
  })
})

describe('费率换算 · 换算后必须能过后端 0~1 校验', () => {
  // ★ 这就是那条线上缺陷的回归断言 ★
  // 表单 :max="20"，也就是说 0 ~ 20 之间任何值都是「界面合法」的。
  // 修复前它们被原样发送，2 就已经 > 1，被后端判定为非法佣金比例。
  it('表单允许的 0 ~ 20 全部落在 0 ~ 1 内', () => {
    for (let p = 0; p <= 20; p += 0.5) {
      const ratio = percentToRatio(p)
      expect(ratio).toBeGreaterThanOrEqual(0)
      expect(ratio).toBeLessThanOrEqual(1)
    }
  })

  it('旧的直传写法（不换算）会被后端区间拦下 —— 说明这次换算不是多余的', () => {
    // 记录「为什么需要这段代码」：2 是界面上的合法输入（2%），
    // 但作为比率它 > 1，Backend 的 Validators 会抛 1001。
    expect(2).toBeGreaterThan(1)
    expect(percentToRatio(2)).toBeLessThanOrEqual(1)
  })
})
