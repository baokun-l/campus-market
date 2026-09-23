/**
 * 单元测试 · CSV 导出工具
 * 覆盖：单元格转义（逗号/引号/换行）、公式注入防护、表头生成、文件名格式
 */
import { describe, it, expect } from 'vitest'
import { escapeCsvCell, toCsv, csvFileName } from '@/utils/csv'

describe('escapeCsvCell() · 单元格转义', () => {
  it('普通值原样输出', () => {
    expect(escapeCsvCell('教材')).toBe('教材')
    expect(escapeCsvCell(123)).toBe('123')
  })

  it('空值应输出空串（不输出 "null" / "undefined"）', () => {
    expect(escapeCsvCell(null)).toBe('')
    expect(escapeCsvCell(undefined)).toBe('')
  })

  it('含逗号的值必须用双引号包裹，否则会多切出一列', () => {
    expect(escapeCsvCell('教材,数码')).toBe('"教材,数码"')
  })

  it('含双引号的值要转义成两个双引号', () => {
    expect(escapeCsvCell('他说"九成新"')).toBe('"他说""九成新"""')
  })

  it('含换行的值必须包裹，否则会多切出一行', () => {
    expect(escapeCsvCell('第一行\n第二行')).toBe('"第一行\n第二行"')
  })

  it('以 = + - @ 开头的值要加前缀，防止 Excel 当公式执行', () => {
    expect(escapeCsvCell('=1+1')).toBe("'=1+1")
    expect(escapeCsvCell('+8613800138000')).toBe("'+8613800138000")
    expect(escapeCsvCell('@here')).toBe("'@here")
  })
})

describe('toCsv() · 行列 → CSV 文本', () => {
  const columns = [
    { key: 'title', title: '商品名' },
    { key: 'price', title: '价格' }
  ]

  it('应输出表头 + 数据行，并用 CRLF 换行（Excel 兼容）', () => {
    const csv = toCsv(columns, [{ title: '高等数学', price: 30 }])
    expect(csv).toBe('商品名,价格\r\n高等数学,30')
  })

  it('空数据只输出表头', () => {
    expect(toCsv(columns, [])).toBe('商品名,价格')
  })

  it('format 优先于 key', () => {
    const csv = toCsv(
      [
        { key: 'price', title: '价格', format: (r: { price: number }) => `¥${r.price.toFixed(2)}` },
        { key: 'price', title: '原价', format: () => undefined }
      ],
      [{ price: 12.5 }]
    )
    expect(csv).toBe('价格,原价\r\n¥12.50,')
  })

  it('列顺序应与 columns 声明顺序一致', () => {
    const csv = toCsv(
      [
        { key: 'b', title: 'B' },
        { key: 'a', title: 'A' }
      ],
      [{ a: 1, b: 2 } as { a: number; b: number }]
    )
    expect(csv).toBe('B,A\r\n2,1')
  })
})

describe('csvFileName() · 导出文件名', () => {
  it('应生成「前缀-年月日时分.csv」', () => {
    const name = csvFileName('商品列表', new Date(2026, 8, 11, 9, 5))
    expect(name).toBe('商品列表-202609110905.csv')
  })

  it('月/日/时/分个位数应补零', () => {
    expect(csvFileName('x', new Date(2026, 0, 2, 3, 4))).toBe('x-202601020304.csv')
  })
})
