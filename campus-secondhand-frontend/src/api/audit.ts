/**
 * 操作日志 API（管理端审计流水）
 * 每个有副作用的管理动作都会在 mock 层写一条，这里负责查询与清空。
 */
import { request } from './request'
import { mockHelpers, AUDIT_ACTION_TYPES } from './mock'
import type { AuditLog } from './mock'
import type { PageResult } from '@/types'

export type { AuditLog } from './mock'
export { AUDIT_ACTION_TYPES } from './mock'

const USE_MOCK = import.meta.env.VITE_USE_MOCK === 'true'

/** 从 action（如 goods.batchStatus）取出分类前缀（goods） */
export function auditTypeOf(action: string): string {
  return action.split('.')[0]
}

/** 操作日志分页查询（新的在前） */
export async function fetchAuditLogs(query: {
  page?: number
  pageSize?: number
  /** 动作分类：goods / user / order / ... 不传表示全部 */
  type?: string
  keyword?: string
} = {}): Promise<PageResult<AuditLog>> {
  if (USE_MOCK) {
    await new Promise((r) => setTimeout(r, 220))
    const page = query.page ?? 1
    const pageSize = query.pageSize ?? 10
    const kw = query.keyword?.trim().toLowerCase() ?? ''

    let list = mockHelpers.getAuditLogs().slice()
    if (query.type) list = list.filter((l) => auditTypeOf(l.action) === query.type)
    if (kw) {
      list = list.filter(
        (l) =>
          l.actionLabel.toLowerCase().includes(kw) ||
          l.target.toLowerCase().includes(kw) ||
          (l.detail ?? '').toLowerCase().includes(kw) ||
          l.operator.toLowerCase().includes(kw)
      )
    }
    // getAuditLogs 本身已按「新的在前」维护，这里仅按时间兜底排序
    list.sort((a, b) => (a.createTime < b.createTime ? 1 : -1))

    const total = list.length
    return { list: list.slice((page - 1) * pageSize, page * pageSize), total, page, pageSize }
  }
  return request({ url: '/admin/audit-logs', method: 'GET', params: query })
}

/** 列表与导出共用的筛选：两边条件必须同源，不会「列表筛的是 A、导出的是 B」 */
function filterAuditLogs(list: AuditLog[], type?: string, keyword?: string): AuditLog[] {
  const kw = keyword?.trim().toLowerCase() ?? ''
  let out = list
  if (type) out = out.filter((l) => auditTypeOf(l.action) === type)
  if (kw) {
    out = out.filter(
      (l) =>
        l.actionLabel.toLowerCase().includes(kw) ||
        l.target.toLowerCase().includes(kw) ||
        (l.detail ?? '').toLowerCase().includes(kw) ||
        l.operator.toLowerCase().includes(kw)
    )
  }
  return out.sort((a, b) => (a.createTime < b.createTime ? 1 : -1))
}

/**
 * 操作日志导出（全量，带分类 / 关键字过滤，不翻页）。
 * 审计流水是「谁在什么时候做了什么」的唯一凭据，导出缺一行就是留痕断档。
 */
export async function fetchAuditLogsForExport(
  query: { type?: string; keyword?: string } = {}
): Promise<AuditLog[]> {
  if (USE_MOCK) {
    await new Promise((r) => setTimeout(r, 200))
    return filterAuditLogs(mockHelpers.getAuditLogs().slice(), query.type, query.keyword)
  }
  return request({ url: '/admin/audit-logs/export', method: 'GET', params: query })
}

/** 各类动作的条数统计（页签上的小计数） */
export async function fetchAuditStats(): Promise<Record<string, number>> {
  if (USE_MOCK) {
    const out: Record<string, number> = {}
    for (const l of mockHelpers.getAuditLogs()) {
      const t = auditTypeOf(l.action)
      out[t] = (out[t] ?? 0) + 1
    }
    return out
  }
  return request({ url: '/admin/audit-logs/stats' })
}

/**
 * 清空全部操作日志
 * <p>
 * ★ 必须显式带上 `confirm=CLEAR` ★ —— 后端把这个参数当作「调用方确实说了要清空」的凭证，
 * 缺了会直接拒绝且一条都不删。页面上的 ElMessageBox 只是体验层，
 * 挡不住脚本/调试里误发的 DELETE；真正兜底的是服务端这道确认。
 * 另：清空后后端会补写一条「清空操作日志」留痕，所以刷新列表会剩 1 条，属预期。
 */
export async function clearAuditLogs(): Promise<void> {
  if (USE_MOCK) {
    await new Promise((r) => setTimeout(r, 200))
    mockHelpers.clearAuditLogs()
    return
  }
  return request({ url: '/admin/audit-logs', method: 'DELETE', params: { confirm: 'CLEAR' } })
}
