<template>
  <div class="adm-pane">
    <div class="adm-card">
      <div class="adm-card-head">
        <span class="adm-card-title">系统设置</span>
        <div class="adm-inline">
          <el-radio-group
            v-model="view"
            size="small"
            @change="onViewChange"
          >
            <el-radio-button label="params">
              平台参数
            </el-radio-button>
            <el-radio-button label="logs">
              操作日志
            </el-radio-button>
            <el-radio-button label="export">
              数据导出
            </el-radio-button>
          </el-radio-group>
        </div>
      </div>

      <div class="adm-card-body">
        <!-- ============ 平台参数 ============ -->
        <template v-if="view === 'params'">
          <!--
            ★ 为什么要放这条说明 ★
            这 8 项参数都能真实存取，但绝大多数**没有任何业务读取方**：
            改了能存下来、刷新还在，系统行为却一点不变。
            对管理员来说，「存得进」和「生效了」在界面上长得一模一样，
            于是很容易以为改完就好了 —— 这比没有这个开关更误导人。
            与其靠文档说明，不如就在每个控件旁边标出它到底有没有接线。
          -->
          <el-alert
            type="warning"
            :closable="false"
            show-icon
            class="set-note"
          >
            <template #title>
              配置项生效范围（据实标注）
            </template>
            <p class="set-note-line">
              全部 8 项都能真实写入数据库；但按当前后端实现，
              <b>只有「每日发布上限」被业务流程读取</b>。
              标着「未启用」的项改动会保存下来，但不会改变系统行为 ——
              它们缺的是「谁来读」，不是「存不下来」。
            </p>
          </el-alert>

          <el-form
            v-loading="loading"
            :model="form"
            label-width="126px"
            class="set-form"
          >
            <div class="adm-form-row">
              <el-form-item label="站点名称">
                <el-input
                  v-model="form.siteName"
                  maxlength="20"
                  show-word-limit
                />
                <el-tag
                  v-bind="wiredTag('siteName')"
                  class="wired-tag"
                >
                  {{ WIRED_LABEL[WIRED.siteName] }}
                </el-tag>
              </el-form-item>
              <el-form-item label="客服电话">
                <el-input
                  v-model="form.servicePhone"
                  maxlength="20"
                  placeholder="如 400-800-1234"
                />
                <el-tag
                  v-bind="wiredTag('servicePhone')"
                  class="wired-tag"
                >
                  {{ WIRED_LABEL[WIRED.servicePhone] }}
                </el-tag>
              </el-form-item>
            </div>

            <el-form-item label="顶部公告文案">
              <el-input
                v-model="form.announceText"
                maxlength="60"
                show-word-limit
                placeholder="展示在首页顶部的滚动提示，留空则不展示"
              />
              <el-tag
                v-bind="wiredTag('announceText')"
                class="wired-tag"
              >
                {{ WIRED_LABEL[WIRED.announceText] }}
              </el-tag>
              <span class="adm-card-hint inline-tip">
                首页顶部滚动公告实际读的是「公告管理」里的数据，与本项无关
              </span>
            </el-form-item>

            <el-divider content-position="left">
              商品策略
            </el-divider>

            <div class="adm-form-row">
              <el-form-item label="发布需审核">
                <el-switch v-model="form.goodsAuditRequired" />
                <el-tag
                  v-bind="wiredTag('goodsAuditRequired')"
                  class="wired-tag"
                >
                  {{ WIRED_LABEL[WIRED.goodsAuditRequired] }}
                </el-tag>
                <span class="adm-card-hint inline-tip">
                  关掉也不会免审：发布商品当前固定写入「审核中」状态
                </span>
              </el-form-item>
              <el-form-item label="每日发布上限">
                <el-input-number
                  v-model="form.maxPublishPerDay"
                  :min="0"
                  :max="99"
                  controls-position="right"
                />
                <el-tag
                  v-bind="wiredTag('maxPublishPerDay')"
                  class="wired-tag"
                >
                  {{ WIRED_LABEL[WIRED.maxPublishPerDay] }}
                </el-tag>
                <span class="adm-card-hint inline-tip">0 表示不限；发布商品时真实校验</span>
              </el-form-item>
            </div>

            <div class="adm-form-row">
              <el-form-item label="自动下架天数">
                <el-input-number
                  v-model="form.autoOfflineDays"
                  :min="0"
                  :max="365"
                  controls-position="right"
                />
                <el-tag
                  v-bind="wiredTag('autoOfflineDays')"
                  class="wired-tag"
                >
                  {{ WIRED_LABEL[WIRED.autoOfflineDays] }}
                </el-tag>
                <span class="adm-card-hint inline-tip">尚无定时任务执行下架</span>
              </el-form-item>
              <el-form-item label="举报自动隐藏">
                <el-switch v-model="form.reportAutoHide" />
                <el-tag
                  v-bind="wiredTag('reportAutoHide')"
                  class="wired-tag"
                >
                  {{ WIRED_LABEL[WIRED.reportAutoHide] }}
                </el-tag>
                <span class="adm-card-hint inline-tip">举报仍由人工处理</span>
              </el-form-item>
            </div>

            <el-divider content-position="left">
              平台计费
            </el-divider>

            <el-form-item label="服务费率">
              <el-input-number
                v-model="form.commissionRate"
                :min="0"
                :max="20"
                :step="0.5"
                :precision="1"
                controls-position="right"
              />
              <el-tag
                v-bind="wiredTag('commissionRate')"
                class="wired-tag"
              >
                {{ WIRED_LABEL[WIRED.commissionRate] }}
              </el-tag>
              <span class="adm-card-hint inline-tip">
                % · 按当前累计成交额估算平台收入约 ¥{{ estIncome }}（不参与任何实际结算）
              </span>
            </el-form-item>

            <el-form-item>
              <el-button
                type="primary"
                :loading="saving"
                @click="onSave"
              >
                保存设置
              </el-button>
              <el-button @click="onReset">
                恢复默认
              </el-button>
              <span
                v-if="dirtyKeys.length"
                class="adm-card-hint dirty"
              >
                已修改 {{ dirtyKeys.length }} 项：{{ dirtyKeys.join('、') }}
              </span>
            </el-form-item>
          </el-form>
        </template>

        <!-- ============ 操作日志 ============ -->
        <template v-else-if="view === 'logs'">
          <div class="adm-toolbar">
            <div class="adm-toolbar-left">
              <el-input
                v-model="logKw"
                class="adm-input"
                placeholder="搜索动作 / 对象 / 详情 / 操作人"
                clearable
                @input="onLogSearchInput"
                @clear="loadLogs"
                @keyup.enter="loadLogs"
              />
              <el-select
          :teleported="false"
                v-model="logType"
                class="adm-select"
                clearable
                placeholder="全部动作分类"
                @change="onLogFilterChange"
              >
                <el-option
                  v-for="t in AUDIT_ACTION_TYPES"
                  :key="t.key"
                  :label="t.label"
                  :value="t.key"
                />
              </el-select>
            </div>
            <div class="adm-toolbar-right">
              <span class="adm-card-hint">共 {{ logTotal }} 条</span>
              <el-button
                text
                type="primary"
                :disabled="!logTotal"
                @click="onExportLogs"
              >
                <el-icon><Download /></el-icon>&nbsp;导出日志
              </el-button>
              <el-button
                text
                type="primary"
                :loading="loading"
                @click="loadLogs"
              >
                刷新
              </el-button>
              <el-button
                text
                type="danger"
                @click="onClearLogs"
              >
                清空日志
              </el-button>
            </div>
          </div>

          <el-table
            v-loading="loading"
            :data="logs"
            row-key="id"
            style="width: 100%"
            empty-text="暂无操作日志"
          >
            <el-table-column
              label="时间"
              width="132"
            >
              <template #default="{ row }">
                <span class="adm-num adm-muted">
                  {{ formatDate((row as AuditLog).createTime, 'MM-DD HH:mm') }}
                </span>
              </template>
            </el-table-column>
            <!-- 宽度需容纳最长动作标签（批量修改商品状态），过窄会让 .cell 触发
                 text-overflow 并在标签旁多画一个 "…" -->
            <el-table-column
              label="动作"
              width="176"
            >
              <template #default="{ row }">
                <el-tag
                  size="small"
                  effect="plain"
                  :type="actionTag((row as AuditLog).action)"
                >
                  {{ (row as AuditLog).actionLabel }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column
              label="操作对象"
              min-width="200"
            >
              <template #default="{ row }">
                <span class="adm-ellipsis adm-strong">{{ (row as AuditLog).target }}</span>
              </template>
            </el-table-column>
            <el-table-column
              label="详情"
              min-width="240"
            >
              <template #default="{ row }">
                <span class="adm-clamp-2 adm-muted">{{ (row as AuditLog).detail || '—' }}</span>
              </template>
            </el-table-column>
            <el-table-column
              label="操作人"
              width="96"
              align="center"
            >
              <template #default="{ row }">
                <span class="adm-id">{{ (row as AuditLog).operator }}</span>
              </template>
            </el-table-column>
          </el-table>

          <div class="adm-pager">
            <el-pagination
              v-model:current-page="logPage"
              :page-size="logPageSize"
              :total="logTotal"
              layout="total, prev, pager, next"
              @current-change="loadLogs"
            />
          </div>
        </template>

        <!-- ============ 数据导出 ============ -->
        <template v-else>
          <p class="export-intro">
            导出的 CSV 带 UTF-8 BOM，双击即可用 Excel 正确打开中文；以
            <code>= + - @</code>
            开头的单元格会自动加前缀，避免被 Excel 当公式执行。
          </p>

          <div class="export-grid">
            <div
              v-for="e in EXPORTS"
              :key="e.key"
              class="export-card"
            >
              <div class="export-top">
                <span
                  class="export-icon"
                  aria-hidden="true"
                >{{ e.emoji }}</span>
                <div class="adm-media-txt">
                  <b class="adm-strong">{{ e.title }}</b>
                  <span class="adm-sub">{{ e.desc }}</span>
                </div>
              </div>
              <el-button
                class="export-btn"
                :loading="exporting === e.key"
                @click="onExport(e.key)"
              >
                <el-icon><Download /></el-icon>
                导出 CSV
              </el-button>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, onActivated, onUnmounted, ref } from 'vue'
import { Download } from '@element-plus/icons-vue'
import { AUDIT_ACTION_TYPES, fetchAuditLogs, fetchAuditLogsForExport, clearAuditLogs, auditTypeOf } from '@/api/audit'
import type { AuditLog } from '@/api/audit'
import { fetchSettings, resetSettings, saveSettings, SETTINGS_LABEL } from '@/api/settings'
import type { PlatformSettings } from '@/api/settings'
import { fetchGoods, GOODS_STATUS_LABEL } from '@/api/goods'
import { fetchAdminOrders, ORDER_STATUS_LABEL } from '@/api/order'
import { fetchUsers } from '@/api/user'
import { fetchCategoryStats } from '@/api/category'
import { csvFileName, downloadCsv } from '@/utils/csv'
import type { CsvColumn } from '@/utils/csv'
import { formatDate } from '@/utils/format'
import { FUND_SOURCE_LABEL } from '@/utils/promo'
import type { Goods, Order, User } from '@/types'
import { ADMIN_CONTEXT } from '../adminContext'

type View = 'params' | 'logs' | 'export'

const admin = inject(ADMIN_CONTEXT)

const view = ref<View>('params')
const loading = ref(false)

/* ============================================================
 * 平台参数
 * ============================================================ */

const DEFAULTS: PlatformSettings = {
  siteName: '校园二手交易平台',
  servicePhone: '400-800-1234',
  announceText: '',
  goodsAuditRequired: true,
  maxPublishPerDay: 5,
  autoOfflineDays: 90,
  reportAutoHide: true,
  commissionRate: 2
}

const form = ref<PlatformSettings>({ ...DEFAULTS })
/** 服务端当前值：用于算「改了哪几项」 */
const saved = ref<PlatformSettings>({ ...DEFAULTS })
const saving = ref(false)

const dirtyKeys = computed(() =>
  (Object.keys(form.value) as Array<keyof PlatformSettings>)
    .filter((k) => String(form.value[k]) !== String(saved.value[k]))
    .map((k) => SETTINGS_LABEL[k])
)

/*
 * ============================================================
 * 每个配置项「是否有真实的业务读取方」—— 据实标注
 * ============================================================
 * 依据：2026-09-20 对后端全量排查 `t_settings` 各列的消费方（grep `get*()` 全仓调用）。
 *
 *   live     后端业务真的读它，改了就生效
 *   estimate 只被本页面用来做展示性估算，不参与任何结算
 *   idle     后端只有存取接口（AdminController），没有任何读取方
 *
 * ★ 为什么要在代码里显式登记 ★
 * 这类「开关是空的」问题无法靠读这一侧的代码发现 —— 本页每一行都写得没问题，
 * 缺的是**另一侧**的消费方。把它登记成一张表，等于把「谁没接线」这件事
 * 从注释里的口头约定变成可核对的事实：将来补上消费方时，必须同时改这里，
 * 否则标签会与实现不一致，而这个不一致本身就会在下次排查时被看见。
 */
const WIRED: Record<keyof PlatformSettings, 'live' | 'estimate' | 'idle'> = {
  // 首页站点名与客服电话目前都由前端硬编码，后端这两列无人读
  siteName: 'idle',
  servicePhone: 'idle',
  // 首页顶部滚动公告读的是 t_notice（公告管理），不是这里
  announceText: 'idle',
  // 商品发布的审核状态是硬编码 pending，不看这一列
  goodsAuditRequired: 'idle',
  // ★ 唯一真生效项：GoodsService.publishGoods 发布前按它拦人
  maxPublishPerDay: 'live',
  // 没有定时任务，天数是空转的
  autoOfflineDays: 'idle',
  // 举报阈值逻辑未实现，仍由人工处理
  reportAutoHide: 'idle',
  commissionRate: 'estimate'
}

const WIRED_LABEL: Record<'live' | 'estimate' | 'idle', string> = {
  live: '已生效',
  estimate: '仅本页估算',
  idle: '未启用'
}

const WIRED_TAG: Record<'live' | 'estimate' | 'idle', 'success' | 'info' | 'warning'> = {
  live: 'success',
  estimate: 'info',
  idle: 'warning'
}

/** 标签属性打包：避免在模板里对 8 个控件各写一遍同样的三元表达式 */
function wiredTag(key: keyof PlatformSettings) {
  const kind = WIRED[key]
  return { type: WIRED_TAG[kind], size: 'small' as const, effect: 'plain' as const }
}

const estIncome = computed(() => {
  // 费率在本页以「百分比」计（2 = 2%），所以除以 100；
  // 与 api/settings.ts 的边界换算无关 —— 那个管的是线上格式。
  const gmv = admin?.overview.value?.gmv ?? 0
  return ((gmv * form.value.commissionRate) / 100).toFixed(2)
})

async function loadSettings() {
  loading.value = true
  try {
    const s = await fetchSettings()
    form.value = { ...s }
    saved.value = { ...s }
  } finally {
    loading.value = false
  }
}

async function onSave() {
  if (!form.value.siteName.trim()) {
    ElMessage.warning('请填写站点名称')
    return
  }
  saving.value = true
  try {
    const next = await saveSettings({ ...form.value, siteName: form.value.siteName.trim() })
    form.value = { ...next }
    saved.value = { ...next }
    ElMessage.success('设置已保存')
  } finally {
    saving.value = false
  }
}

async function onReset() {
  try {
    await ElMessageBox.confirm('恢复默认将丢弃当前全部平台参数，确定继续？', '恢复默认参数', { type: 'warning' })
  } catch {
    return
  }
  const next = await resetSettings()
  form.value = { ...next }
  saved.value = { ...next }
  ElMessage.success('已恢复默认参数')
}

/* ============================================================
 * 操作日志
 * ============================================================ */

const logs = ref<AuditLog[]>([])
const logTotal = ref(0)
const logPage = ref(1)
const logPageSize = ref(10)
const logKw = ref('')
const logType = ref('')

function actionTag(action: string): 'primary' | 'success' | 'warning' | 'danger' | 'info' {
  const t = auditTypeOf(action)
  if (t === 'goods' || t === 'category') return 'primary'
  if (t === 'order' || t === 'activity') return 'success'
  if (t === 'report' || t === 'content') return 'warning'
  if (t === 'user') return 'danger'
  return 'info'
}

let logSearchTimer: ReturnType<typeof setTimeout> | null = null
function onLogSearchInput() {
  if (logSearchTimer) clearTimeout(logSearchTimer)
  logSearchTimer = setTimeout(() => {
    logPage.value = 1
    loadLogs()
  }, 300)
}
onUnmounted(() => {
  if (logSearchTimer) clearTimeout(logSearchTimer)
})

function onLogFilterChange() {
  logPage.value = 1
  loadLogs()
}

async function loadLogs() {
  loading.value = true
  try {
    const r = await fetchAuditLogs({
      page: logPage.value,
      pageSize: logPageSize.value,
      type: logType.value || undefined,
      keyword: logKw.value
    })
    logs.value = r.list
    logTotal.value = r.total
  } finally {
    loading.value = false
  }
}

/* ---------- 操作日志导出 ---------- */
/** 导出列：与「操作日志」表格同字段，审计流水离线归档用 */
const LOG_EXPORT_COLUMNS: CsvColumn<AuditLog>[] = [
  { key: 'createTime', title: '时间', format: (l) => formatDate(l.createTime, 'YYYY-MM-DD HH:mm') },
  { key: 'action', title: '动作标识' },
  { key: 'actionLabel', title: '动作' },
  { key: 'target', title: '操作对象' },
  { key: 'detail', title: '详情', format: (l) => l.detail ?? '' },
  { key: 'operator', title: '操作人' }
]

/** 导出当前筛选的全部日志（不是当前页）：审计留痕导出缺一行就是断档 */
async function onExportLogs() {
  loading.value = true
  try {
    const rows = await fetchAuditLogsForExport({
      type: logType.value || undefined,
      keyword: logKw.value.trim() || undefined
    })
    if (!rows.length) {
      ElMessage.warning('当前筛选没有可导出的日志')
      return
    }
    downloadCsv(csvFileName(`操作日志-${rows.length}条`), LOG_EXPORT_COLUMNS, rows)
    ElMessage.success(`已导出 ${rows.length} 条操作日志`)
  } finally {
    loading.value = false
  }
}

async function onClearLogs() {
  try {
    // 措辞要说清「会留痕」：后端清空后会补写一条「清空操作日志」，
    // 不给提示的话用户会以为没删干净，反而去反复点。
    await ElMessageBox.confirm(
      '清空后历史记录不可恢复，确定清空全部操作日志？（系统会保留一条「清空操作日志」的留痕）',
      '危险操作',
      { type: 'error' }
    )
  } catch {
    return
  }
  await clearAuditLogs()
  ElMessage.success('已清空历史操作日志（本次清空已留痕）')
  logPage.value = 1
  await loadLogs()
}

/* ============================================================
 * 数据导出
 * ============================================================ */

interface ExportDef {
  key: 'goods' | 'order' | 'user' | 'category'
  title: string
  desc: string
  emoji: string
}

const EXPORTS: ExportDef[] = [
  { key: 'goods', title: '商品数据', desc: '含价格、状态、卖家、热度', emoji: '📦' },
  { key: 'order', title: '订单数据', desc: '含金额、状态、买卖家与时间线', emoji: '🧾' },
  { key: 'user', title: '用户数据', desc: '含信用分、状态与注册时间', emoji: '👥' },
  { key: 'category', title: '分类数据', desc: '含图标与分类下商品数', emoji: '🗂️' }
]

const exporting = ref('')

/*
 * 导出列刻意不带「原价」：
 * 划线价必须等于卖家挂牌价，单独列一个"原价"字段就是在邀请运营去填假数据。
 */
const GOODS_COLUMNS: CsvColumn<Goods>[] = [
  { key: 'id', title: '商品ID' },
  { key: 'title', title: '标题' },
  { key: 'categoryName', title: '分类' },
  { key: 'price', title: '挂牌价', format: (g) => g.price.toFixed(2) },
  { key: 'promoPrice', title: '让利价', format: (g) => (g.promoPrice ? g.promoPrice.toFixed(2) : '') },
  { key: 'status', title: '状态', format: (g) => GOODS_STATUS_LABEL[g.status] ?? g.status },
  { key: 'sellerName', title: '卖家' },
  { key: 'location', title: '校区' },
  { key: 'viewCount', title: '浏览' },
  { key: 'favoriteCount', title: '收藏' },
  { key: 'createTime', title: '发布时间', format: (g) => formatDate(g.createTime, 'YYYY-MM-DD HH:mm') }
]

/*
 * 订单导出必须带完整的价格拆分：
 * 财务对账时要能回答「这单让利是谁出的钱、卖家实收多少」，
 * 只导一个 amount 是没法对账的。
 */
const ORDER_COLUMNS: CsvColumn<Order>[] = [
  { key: 'id', title: '订单号' },
  { key: 'goods', title: '商品', format: (o) => o.goods.title },
  { key: 'amount', title: '实付金额', format: (o) => o.amount.toFixed(2) },
  { key: 'listPrice', title: '挂牌价', format: (o) => (o.listPrice ?? o.amount).toFixed(2) },
  { key: 'sellerCut', title: '卖家让利', format: (o) => (o.sellerCut ?? 0).toFixed(2) },
  { key: 'platformSubsidy', title: '平台补贴', format: (o) => (o.platformSubsidy ?? 0).toFixed(2) },
  { key: 'sellerIncome', title: '卖家实收', format: (o) => (o.sellerIncome ?? o.amount).toFixed(2) },
  { key: 'fundSource', title: '让利归属', format: (o) => (o.fundSource ? FUND_SOURCE_LABEL[o.fundSource] : '') },
  { key: 'status', title: '状态', format: (o) => ORDER_STATUS_LABEL[o.status] ?? o.status },
  { key: 'buyerName', title: '买家', format: (o) => o.buyerName || `#${o.buyerId}` },
  { key: 'sellerName', title: '卖家', format: (o) => o.sellerName || `#${o.sellerId}` },
  { key: 'address', title: '收货地址' },
  { key: 'trackingNo', title: '运单号' },
  { key: 'createTime', title: '下单时间', format: (o) => formatDate(o.createTime, 'YYYY-MM-DD HH:mm') },
  { key: 'payTime', title: '付款时间', format: (o) => (o.payTime ? formatDate(o.payTime, 'YYYY-MM-DD HH:mm') : '') },
  { key: 'shipTime', title: '发货时间', format: (o) => (o.shipTime ? formatDate(o.shipTime, 'YYYY-MM-DD HH:mm') : '') },
  { key: 'receiveTime', title: '收货时间', format: (o) => (o.receiveTime ? formatDate(o.receiveTime, 'YYYY-MM-DD HH:mm') : '') }
]

const USER_STATUS_LABEL: Record<User['status'], string> = {
  active: '正常',
  banned: '已封禁'
}

const USER_COLUMNS: CsvColumn<User>[] = [
  { key: 'id', title: '用户ID' },
  { key: 'username', title: '用户名' },
  { key: 'nickname', title: '昵称' },
  { key: 'role', title: '角色' },
  { key: 'creditScore', title: '信用分' },
  { key: 'status', title: '状态', format: (u) => USER_STATUS_LABEL[u.status] ?? u.status },
  { key: 'createTime', title: '注册时间', format: (u) => formatDate(u.createTime, 'YYYY-MM-DD HH:mm') }
]

async function onExport(key: ExportDef['key']) {
  exporting.value = key
  try {
    if (key === 'goods') {
      const r = await fetchGoods({ page: 1, pageSize: 999 })
      downloadCsv(csvFileName('商品列表'), GOODS_COLUMNS, r.list)
    } else if (key === 'order') {
      const r = await fetchAdminOrders({ page: 1, pageSize: 999 })
      downloadCsv(csvFileName('订单列表'), ORDER_COLUMNS, r.list)
    } else if (key === 'user') {
      const r = await fetchUsers({ page: 1, pageSize: 999 })
      downloadCsv(csvFileName('用户列表'), USER_COLUMNS, r.list)
    } else {
      const list = await fetchCategoryStats()
      downloadCsv<Record<string, unknown>>(
        csvFileName('分类列表'),
        [
          { key: 'id', title: '分类ID' },
          { key: 'name', title: '分类名称' },
          { key: 'icon', title: '图标' },
          { key: 'count', title: '商品数' }
        ],
        list as unknown as Array<Record<string, unknown>>
      )
    }
    ElMessage.success('已开始下载 CSV')
  } finally {
    exporting.value = ''
  }
}

/* ============================================================
 * 视图切换
 * ============================================================ */

function onViewChange() {
  if (view.value === 'params') loadSettings()
  else if (view.value === 'logs') loadLogs()
}

onActivated(loadSettings)
</script>

<style scoped lang="scss">
.set-form {
  max-width: 820px;
}

/* 配置项生效范围说明：别做成大红警告，它描述的是「现状」而不是「出错」 */
.set-note {
  max-width: 820px;
  margin-bottom: 18px;
}

.set-note-line {
  margin: 4px 0 0;
  line-height: 1.7;
}

/* 「已生效 / 未启用 / 仅本页估算」标签：贴着控件，避免只读正文时漏看 */
.wired-tag {
  margin-left: 10px;
  flex-shrink: 0;
}

.inline-tip {
  margin-left: 10px;
}

.dirty {
  margin-left: 12px;
  color: #d97706;
}

/* el-divider 作为分组标题：只在左侧留字，右侧不加粗线 */
:deep(.el-divider--horizontal) {
  margin: 6px 0 18px;
}
:deep(.el-divider__text) {
  font-size: $fs-12;
  color: var(--color-text-mute);
  background: var(--bg-card);
}

/* ============ 导出 ============ */
.export-intro {
  margin: 0 0 16px;
  padding: 10px 14px;
  border-radius: $radius-sm;
  background: var(--bg-soft);
  border: 1px solid var(--border-color);
  font-size: $fs-12;
  line-height: 1.7;
  color: var(--color-text-secondary);

  code {
    padding: 1px 5px;
    border-radius: $radius-xs;
    background: #fff;
    border: 1px solid var(--border-color-strong);
    font-family: $font-mono;
    font-size: 11px;
  }
}

.export-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(248px, 1fr));
  gap: 12px;
}

.export-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  border-radius: $radius-md;
  border: 1px solid var(--border-color);
  background: var(--bg-card);
  transition: border-color $dur-slow $ease-out, box-shadow $dur-slow $ease-out;

  &:hover {
    border-color: var(--border-color-strong);
    box-shadow: $shadow-xs;
  }
}

.export-top {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-width: 0;
}

.export-icon {
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  font-size: 18px;
  border-radius: $radius-sm;
  background: var(--bg-soft);
}

.export-btn {
  width: 100%;
}
</style>
