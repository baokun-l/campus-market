import { describe, expect, it } from 'vitest'
import { fixedLengthRule, validateCnPhone, validateFixedLength } from './validators'

/** fixedLengthRule 适配器的便捷调用：直接拿结果 */
function runRule(rule: ReturnType<typeof fixedLengthRule>, value: string) {
  let err: Error | undefined
  rule.validator({}, value, (e) => { err = e })
  return err?.message ?? ''
}

describe('validateFixedLength · 固定长度校验', () => {
  it('合法输入通过，value 为 trim 后的值', () => {
    const r = validateFixedLength(' 13800138000 ', { length: 11, label: '手机号' })
    expect(r.ok).toBe(true)
    expect(r.value).toBe('13800138000')
    expect(r.message).toBe('')
  })

  it('空字符串 → 请输入', () => {
    const r = validateFixedLength('', { length: 11, label: '手机号' })
    expect(r.ok).toBe(false)
    expect(r.message).toBe('请输入手机号')
  })

  it('纯空格视为空输入', () => {
    expect(validateFixedLength('   ', { length: 11 }).ok).toBe(false)
    expect(validateFixedLength('　', { length: 11 }).ok).toBe(false) // 全角空格
  })

  it('null / undefined / 非字符串按空输入处理（不抛异常）', () => {
    expect(validateFixedLength(null, { length: 6 }).ok).toBe(false)
    expect(validateFixedLength(undefined, { length: 6 }).ok).toBe(false)
  })

  it('allowEmpty 时空输入直接放行', () => {
    const r = validateFixedLength('  ', { length: 11, allowEmpty: true })
    expect(r.ok).toBe(true)
  })

  it('首尾空格被静默 trim（多余空格边界）', () => {
    expect(validateFixedLength('   123456   ', { length: 6 }).ok).toBe(true)
  })

  it('中间夹空格 → 明确报错（即使去掉空格后位数正确）', () => {
    const r = validateFixedLength('138 0013 8000', { length: 11 })
    expect(r.ok).toBe(false)
    expect(r.message).toContain('不能包含空格')
  })

  it('位数不足 → 报应为 N 位、当前为 M 位', () => {
    const r = validateFixedLength('1380013800', { length: 11, label: '手机号' })
    expect(r.ok).toBe(false)
    expect(r.message).toBe('手机号应为 11 位，当前为 10 位')
  })

  it('位数超长 → 同样报位数不符', () => {
    const r = validateFixedLength('138001380001', { length: 11 })
    expect(r.message).toContain('当前为 12 位')
  })

  it('含字母等非法字符 → 报只能由数字组成', () => {
    const r = validateFixedLength('1380013800a', { length: 11 })
    expect(r.ok).toBe(false)
    expect(r.message).toBe('输入内容只能由数字组成')
  })

  it('自定义白名单与提示（如 6 位大写学号）', () => {
    const opts = { length: 6, label: '学号', pattern: /^[A-Z]\d{5}$/, charsetMessage: '学号应为 1 位大写字母 + 5 位数字' }
    expect(validateFixedLength('A12345', opts).ok).toBe(true)
    expect(validateFixedLength('a12345', opts).message).toContain('大写字母')
  })

  it('extraCheck 附加规则在字符与位数都合法后执行', () => {
    const opts = {
      length: 11,
      label: '手机号',
      extraCheck: (v: string) => (v.startsWith('1') ? null : '需以 1 开头')
    }
    expect(validateFixedLength('9'.repeat(11), opts).message).toBe('需以 1 开头')
    expect(validateFixedLength('1'.repeat(11), opts).ok).toBe(true)
  })

  it('数字类型输入也能校验（String 转换）', () => {
    expect(validateFixedLength(13800138000, { length: 11 }).ok).toBe(true)
  })
})

describe('validateCnPhone · 中国大陆手机号', () => {
  it('合法号段通过', () => {
    expect(validateCnPhone('13800138000').ok).toBe(true)
    expect(validateCnPhone('19912345678').ok).toBe(true)
  })

  it('11 位数字但不合法段位（12/10 开头）→ 报格式不正确', () => {
    expect(validateCnPhone('12800138000').ok).toBe(false)
    expect(validateCnPhone('10800138000').message).toContain('1 开头')
  })

  it('位数错误优先报位数，不会误报段位', () => {
    expect(validateCnPhone('1380013800').message).toContain('11 位')
  })

  it('allowEmpty：选填场景空值放行、有值仍校验', () => {
    expect(validateCnPhone('', { allowEmpty: true }).ok).toBe(true)
    expect(validateCnPhone('123', { allowEmpty: true }).ok).toBe(false)
  })
})

describe('fixedLengthRule · EP 表单适配器', () => {
  it('通过时回调无错误', () => {
    expect(runRule(fixedLengthRule({ length: 11, label: '手机号' }), '13800138000')).toBe('')
  })

  it('失败时回调错误消息', () => {
    expect(runRule(fixedLengthRule({ length: 11, label: '手机号' }), '138')).toContain('11 位')
  })
})
