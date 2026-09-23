/**
 * 工具函数集
 */
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import 'dayjs/locale/zh-cn'

dayjs.extend(relativeTime)
dayjs.locale('zh-cn')

/* ============ 格式化 ============ */

/** 价格格式化（默认 ¥ + 千分位） */
export function formatPrice(
  price: number | string,
  opts: { symbol?: string; decimal?: number; thousandSep?: boolean } = {}
): string {
  const n = Number(price)
  if (Number.isNaN(n)) return '--'
  if (n < 0) throw new RangeError('价格不能为负')
  const { symbol = '¥', decimal = 2, thousandSep = true } = opts
  const fixed = n.toFixed(decimal)
  const [int, dec] = fixed.split('.')
  const intPart = thousandSep ? int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : int
  return dec ? `${symbol}${intPart}.${dec}` : `${symbol}${intPart}`
}

/**
 * 折扣比例文字（如 "5折" / "8.5折"）
 *
 * 取一位小数并**向上取整**：宁可把折扣说得弱一点，也不能把 8.4 折说成 8 折 ——
 * 夸大折扣力度属于虚假宣传。入参非法（无原价 / 现价 ≥ 原价）时返回空串，
 * 由调用方决定不渲染折扣标签。
 */
export function discountText(price: number, original: number): string {
  if (!original || original <= 0 || price >= original) return ''
  const zhe = Math.ceil((price / original) * 100) / 10
  if (zhe >= 10) return ''
  return Number.isInteger(zhe) ? `${zhe}折` : `${zhe.toFixed(1)}折`
}

/** 日期格式化 */
export function formatDate(date: string | Date | number, fmt = 'YYYY-MM-DD HH:mm:ss'): string {
  return dayjs(date).format(fmt)
}

/** 相对时间 */
export function formatRelative(date: string | Date | number): string {
  return dayjs(date).fromNow()
}

/* ============ 校验 ============ */

export function isMobile(v: string): boolean {
  return /^1[3-9]\d{9}$/.test(v)
}

export function isEmail(v: string): boolean {
  return /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(v)
}

export function isStudentId(v: string): boolean {
  return /^\d{10,12}$/.test(v)
}

/* ============ 存储 ============ */

export const storage = {
  get<T>(key: string, fallback: T | null = null): T | null {
    try {
      const v = localStorage.getItem(key)
      return v ? (JSON.parse(v) as T) : fallback
    } catch {
      return fallback
    }
  },
  set(key: string, value: unknown): void {
    localStorage.setItem(key, JSON.stringify(value))
  },
  remove(key: string): void {
    localStorage.removeItem(key)
  }
}

/* ============ 防抖 / 节流 ============ */

export function debounce<T extends (...args: any[]) => void>(fn: T, wait = 300) {
  let timer: ReturnType<typeof setTimeout> | null = null
  return function (this: unknown, ...args: Parameters<T>) {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => fn.apply(this, args), wait)
  }
}

export function throttle<T extends (...args: any[]) => void>(fn: T, wait = 200) {
  let last = 0
  return function (this: unknown, ...args: Parameters<T>) {
    const now = Date.now()
    if (now - last >= wait) {
      last = now
      fn.apply(this, args)
    }
  }
}
