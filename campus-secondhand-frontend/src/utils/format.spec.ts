/**
 * 工具函数单元测试
 * 覆盖：价格格式化 / 折扣计算 / 表单校验 / 本地存储 / 防抖节流
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  formatPrice,
  discountText,
  formatDate,
  isMobile,
  isEmail,
  isStudentId,
  storage,
  debounce,
  throttle
} from '@/utils/format'

/* ============ 价格格式化 ============ */
describe('formatPrice() · 价格格式化', () => {
  it('默认加 ¥ 符号并保留 2 位小数', () => {
    expect(formatPrice(100)).toBe('¥100.00')
  })

  it('应自动添加千分位分隔符', () => {
    expect(formatPrice(1234567.5)).toBe('¥1,234,567.50')
    expect(formatPrice(1000)).toBe('¥1,000.00')
  })

  it('可关闭千分位分隔', () => {
    expect(formatPrice(1234567.5, { thousandSep: false })).toBe('¥1234567.50')
  })

  it('可自定义货币符号', () => {
    expect(formatPrice(99.9, { symbol: '$' })).toBe('$99.90')
    expect(formatPrice(99.9, { symbol: '' })).toBe('99.90')
  })

  it('可自定义小数位数', () => {
    expect(formatPrice(99.9, { decimal: 0 })).toBe('¥100')
    expect(formatPrice(99.9, { decimal: 3 })).toBe('¥99.900')
  })

  it('应接受字符串形式的数字', () => {
    expect(formatPrice('88.8')).toBe('¥88.80')
  })

  it('非数字输入应返回占位符 --（避免页面显示 NaN）', () => {
    expect(formatPrice('abc')).toBe('--')
    expect(formatPrice(NaN)).toBe('--')
  })

  it('0 元应正常格式化为 ¥0.00', () => {
    expect(formatPrice(0)).toBe('¥0.00')
  })

  it('负数价格应抛出 RangeError（业务上价格不能为负）', () => {
    expect(() => formatPrice(-1)).toThrow(RangeError)
    expect(() => formatPrice(-0.01)).toThrow('价格不能为负')
  })
})

/* ============ 折扣计算 ============ */
describe('discountText() · 折扣文字', () => {
  it('应按 挂牌价/实付 比例计算折数（整折不带小数）', () => {
    expect(discountText(50, 100)).toBe('5折')
    expect(discountText(80, 100)).toBe('8折')
    expect(discountText(30, 100)).toBe('3折')
  })

  it('非整折应保留一位小数，而不是四舍五入成整折', () => {
    // 8.8 折若四舍五入成「9折」会低估折扣，成「8折」则会夸大折扣 —— 两者都不该出现
    expect(discountText(88, 100)).toBe('8.8折')
    expect(discountText(84, 100)).toBe('8.4折')
  })

  it('折扣力度只能「说小」不能「说大」：小数一律向上取整', () => {
    // 真实 8.42 折 → 显示 8.5 折（而不是 8.4 折，后者会夸大让利）
    expect(discountText(842, 1000)).toBe('8.5折')
    // 11.11% off 即 8.889 折 → 显示 8.9 折
    expect(discountText(889, 1000)).toBe('8.9折')
  })

  it('原价为 0 或缺失时应返回空字符串（不显示折扣标签）', () => {
    expect(discountText(50, 0)).toBe('')
  })

  it('原价为负数时应返回空字符串', () => {
    expect(discountText(50, -100)).toBe('')
  })

  it('实付不低于挂牌价时不应出现折扣标签', () => {
    expect(discountText(100, 100)).toBe('')
    expect(discountText(120, 100)).toBe('')
  })
})

/* ============ 日期格式化 ============ */
describe('formatDate() · 日期格式化', () => {
  it('默认输出 YYYY-MM-DD HH:mm:ss 格式', () => {
    expect(formatDate('2026-09-10T08:30:00')).toBe('2026-09-10 08:30:00')
  })

  it('应支持自定义格式串', () => {
    expect(formatDate('2026-09-10T08:30:00', 'YYYY/MM/DD')).toBe('2026/09/10')
    expect(formatDate('2026-09-10T08:30:00', 'MM-DD')).toBe('09-10')
  })

  it('应接受 Date 对象与时间戳', () => {
    const d = new Date('2026-01-02T03:04:05')
    expect(formatDate(d, 'YYYY-MM-DD')).toBe('2026-01-02')
    expect(formatDate(d.getTime(), 'YYYY-MM-DD')).toBe('2026-01-02')
  })
})

/* ============ 表单校验 ============ */
describe('表单校验函数', () => {
  describe('isMobile() · 手机号', () => {
    it('应识别合法的大陆手机号', () => {
      expect(isMobile('13800138000')).toBe(true)
      expect(isMobile('19912345678')).toBe(true)
      expect(isMobile('15512345678')).toBe(true)
    })

    it('应拒绝位数不足 / 首位非法 / 含非数字的输入', () => {
      expect(isMobile('1380013800')).toBe(false)
      expect(isMobile('138001380000')).toBe(false)
      expect(isMobile('12800138000')).toBe(false)
      expect(isMobile('138-0013-8000')).toBe(false)
      expect(isMobile('')).toBe(false)
    })
  })

  describe('isEmail() · 邮箱', () => {
    it('应识别合法的邮箱地址', () => {
      expect(isEmail('student@example.com')).toBe(true)
      expect(isEmail('a.b+c@mail.co.uk')).toBe(true)
    })

    it('应拒绝缺少 @ 或域名的输入', () => {
      expect(isEmail('student.example.com')).toBe(false)
      expect(isEmail('student@')).toBe(false)
      expect(isEmail('@example.com')).toBe(false)
    })
  })

  describe('isStudentId() · 学号', () => {
    it('应识别 10~12 位纯数字学号', () => {
      expect(isStudentId('20232210162')).toBe(true)
      expect(isStudentId('1234567890')).toBe(true)
      expect(isStudentId('123456789012')).toBe(true)
    })

    it('应拒绝位数不符或含字母的输入', () => {
      expect(isStudentId('2023221')).toBe(false)
      expect(isStudentId('2023221016213')).toBe(false)
      expect(isStudentId('2023221016a')).toBe(false)
    })
  })
})

/* ============ 本地存储 ============ */
describe('storage · 本地存储封装', () => {
  beforeEach(() => localStorage.clear())

  it('set 后 get 应能取回相同对象（自动 JSON 序列化）', () => {
    const obj = { id: 1, name: '测试', nested: { deep: true } }
    storage.set('k', obj)
    expect(storage.get('k')).toEqual(obj)
  })

  it('存储数组应保持类型', () => {
    storage.set('arr', [1, 2, 3])
    expect(storage.get<number[]>('arr')).toEqual([1, 2, 3])
  })

  it('读取不存在的 key 应返回 fallback', () => {
    expect(storage.get('not-exist')).toBeNull()
    expect(storage.get('not-exist', 'default')).toBe('default')
  })

  it('JSON 损坏时应返回 fallback 而非抛错（防止白屏）', () => {
    localStorage.setItem('broken', '{invalid json')
    expect(storage.get('broken', 'safe')).toBe('safe')
  })

  it('remove 应能删除指定 key', () => {
    storage.set('k', 1)
    storage.remove('k')
    expect(storage.get('k')).toBeNull()
  })
})

/* ============ 防抖 / 节流 ============ */
describe('debounce() · 防抖', () => {
  it('高频触发时只执行最后一次', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const d = debounce(fn, 300)
    d(); d(); d()
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(300)
    expect(fn).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('应透传参数到原函数', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const d = debounce(fn, 100)
    d('a', 1)
    vi.advanceTimersByTime(100)
    expect(fn).toHaveBeenCalledWith('a', 1)
    vi.useRealTimers()
  })

  it('间隔超过等待时间时应再次执行', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const d = debounce(fn, 100)
    d()
    vi.advanceTimersByTime(150)
    d()
    vi.advanceTimersByTime(150)
    expect(fn).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })
})

describe('throttle() · 节流', () => {
  it('等待期内的重复调用应被丢弃', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const t = throttle(fn, 200)
    t(); t(); t()
    expect(fn).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('超过等待期后应允许再次执行', () => {
    vi.useFakeTimers()
    const fn = vi.fn()
    const t = throttle(fn, 200)
    t()
    vi.advanceTimersByTime(250)
    t()
    expect(fn).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })
})
