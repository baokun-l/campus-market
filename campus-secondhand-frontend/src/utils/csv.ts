/**
 * CSV 导出工具（管理后台「导出」按钮用）
 *
 * 三个必须处理的细节，少一个就会被当成 bug：
 * ① **UTF-8 BOM**：不加 BOM，Excel 打开中文必然乱码（本机实测最常见的坑）；
 * ② **转义**：字段里出现 逗号 / 双引号 / 换行 时，必须用双引号包裹并把 `"` 转成 `""`；
 * ③ **公式注入**：以 `= + - @` 开头的单元格会被 Excel 当公式执行，前面加 `'` 掐掉。
 */
export interface CsvColumn<T> {
  /** 取值字段名（与 format 二选一，format 优先） */
  key: string
  /** 表头文字 */
  title: string
  /** 自定义取值 / 格式化；不传则直接取 row[key] */
  format?: (row: T) => string | number | null | undefined
}

/** 单元格转义 */
export function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  let s = String(value)
  if (/^[=+\-@]/.test(s)) s = `'${s}`
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`
  return s
}

/** 行列数据 → CSV 文本（CRLF 换行，兼容 Excel） */
export function toCsv<T>(columns: CsvColumn<T>[], rows: T[]): string {
  const head = columns.map((c) => escapeCsvCell(c.title)).join(',')
  const body = rows.map((row) =>
    columns
      .map((c) => escapeCsvCell(c.format ? c.format(row) : (row as Record<string, unknown>)[c.key]))
      .join(',')
  )
  return [head, ...body].join('\r\n')
}

/** 触发浏览器下载（自动补 .csv 后缀与 BOM） */
export function downloadCsv<T>(filename: string, columns: CsvColumn<T>[], rows: T[]): void {
  const csv = toCsv(columns, rows)
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // 立刻 revoke 会让部分浏览器来不及取数据，延后释放
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** 导出文件名统一格式：前缀-年月日时分.csv */
export function csvFileName(prefix: string, at = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${prefix}-${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}${p(at.getHours())}${p(at.getMinutes())}.csv`
}
