/**
 * validators.ts - 可复用的输入校验工具
 *
 * 核心：validateFixedLength —— 固定长度输入（手机号 / 学号 / 邮编等）的统一校验入口。
 *
 * 设计要点：
 * - 统一返回 { ok, value, message } 结构，value 是「规范化后的输入」（去首尾空格），
 *   调用方校验通过后应使用 value 存库，而不是原始输入；
 * - 边界情况全部有明确文案：空输入 / 纯空格 / 中间夹空格 / 位数不符 / 非法字符 / 附加规则；
 * - 附带 fixedLengthRule 适配器，直接喂给 Element Plus 表单 rules。
 */

export interface FixedLengthOptions {
  /** 规定的固定位数 */
  length: number
  /** 字段名，用于生成错误提示（如「手机号」），缺省为「输入内容」 */
  label?: string
  /** 合法字符白名单（对去空格后的整体做 full match），缺省纯数字 /^\d+$/ */
  pattern?: RegExp
  /** 字符不合法时的提示文案，缺省按「只能由数字组成」生成 */
  charsetMessage?: string
  /** 附加格式校验（位数与字符都合法后再执行），返回错误文案或不返回 null 表示通过 */
  extraCheck?: (value: string) => string | null
  /** 可选字段：为空（含纯空格）时直接通过，不再检查长度 */
  allowEmpty?: boolean
}

export interface ValidationResult {
  /** 是否通过 */
  ok: boolean
  /** 规范化后的值（去首尾空格）；失败时也会返回 trim 后的值便于回填纠正 */
  value: string
  /** 失败原因（通过时为空字符串） */
  message: string
}

/**
 * 固定长度输入校验。
 *
 * 校验顺序（先易后难，保证错误提示指向最具体的问题）：
 *   ① 空输入（含纯空格）→「请输入XX」；可选字段直接放行
 *   ② 中间夹空格 → 明确报「不能包含空格」（首尾空格已静默 trim，不算错）
 *   ③ 长度不符 →「应为 N 位，当前为 M 位」
 *   ④ 非法字符 → 按 pattern 白名单报「只能由…组成」
 *   ⑤ extraCheck 附加规则（如手机号段位）
 */
export function validateFixedLength(input: unknown, opts: FixedLengthOptions): ValidationResult {
  const label = opts.label ?? '输入内容'
  // 数字也会被 String() 转换；null/undefined/对象等一律按空处理
  const raw = typeof input === 'string' || typeof input === 'number' ? String(input) : ''
  const value = raw.trim()

  if (!value) {
    if (opts.allowEmpty) return { ok: true, value, message: '' }
    return { ok: false, value, message: `请输入${label}` }
  }
  // 全角空格（U+3000）/制表符等都在 \s 范围内，中间出现即报错
  if (/\s/.test(value)) {
    return { ok: false, value, message: `${label}中间不能包含空格` }
  }
  if (value.length !== opts.length) {
    return { ok: false, value, message: `${label}应为 ${opts.length} 位，当前为 ${value.length} 位` }
  }
  const pattern = opts.pattern ?? /^\d+$/
  if (!pattern.test(value)) {
    return { ok: false, value, message: opts.charsetMessage ?? `${label}只能由数字组成` }
  }
  if (opts.extraCheck) {
    const extra = opts.extraCheck(value)
    if (extra) return { ok: false, value, message: extra }
  }
  return { ok: true, value, message: '' }
}

/** 中国大陆手机号：11 位数字，1 开头、第 2 位为 3-9 */
export const CN_PHONE_LENGTH = 11

/** 手机号校验（validateFixedLength 的业务封装）。allowEmpty 用于「非必填」场景 */
export function validateCnPhone(input: unknown, opts: { allowEmpty?: boolean } = {}): ValidationResult {
  return validateFixedLength(input, {
    length: CN_PHONE_LENGTH,
    label: '手机号',
    extraCheck: (v) =>
      /^1[3-9]\d{9}$/.test(v) ? null : '手机号格式不正确（应以 1 开头，第 2 位为 3-9）',
    ...opts
  })
}

/**
 * Element Plus 表单 rule 适配器。
 * 用法：rules = { phone: [fixedLengthRule({ length: 11, label: '手机号', ... })] }
 */
export function fixedLengthRule(opts: FixedLengthOptions) {
  return {
    validator: (_rule: unknown, value: string, callback: (err?: Error) => void) => {
      const r = validateFixedLength(value, opts)
      if (r.ok) callback()
      else callback(new Error(r.message))
    },
    trigger: 'blur'
  }
}
