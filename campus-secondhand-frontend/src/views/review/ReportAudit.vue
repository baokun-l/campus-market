<template>
  <div class="ra-page">
    <BackButton />

    <!-- 页头：职能声明 -->
    <section class="ra-hero">
      <div class="hero-text">
        <h1 class="hero-title">
          <el-icon :size="22" class="hero-icon"><Search /></el-icon>
          举报处理后台
          <span class="hero-badge">举报审核员专属</span>
        </h1>
        <p class="hero-sub">
          只负责一件事：处理全平台的举报 —— 核实举报内容、对被举报对象施加处置、记录处理结论。
          与商品审核互不干涉。
        </p>
      </div>
    </section>

    <!-- 工作量 KPI -->
    <section class="ra-kpis">
      <div v-for="k in kpis" :key="k.label" class="kpi-card" :class="`is-${k.tone}`">
        <span class="kpi-num">{{ k.value }}</span>
        <span class="kpi-label">{{ k.label }}</span>
      </div>
    </section>

    <el-card class="ra-card" shadow="never">
      <el-tabs v-model="tab">
        <el-tab-pane name="pending">
          <template #label>
            待处理<span v-if="stats.pending" class="tab-count">{{ stats.pending }}</span>
          </template>
          <div class="toolbar">
            <el-select v-model="typeFilter" placeholder="全部类型" clearable class="toolbar-type" :teleported="false" @change="reloadPending">
              <el-option label="商品举报" value="goods" />
              <el-option label="用户举报" value="user" />
              <el-option label="订单举报" value="order" />
            </el-select>
            <el-button :icon="Refresh" @click="reloadPending">刷新</el-button>
          </div>

          <el-table
            v-loading="pendingLoading"
            :data="pendingList"
            row-key="id"
            class="ra-table"
            :row-class-name="() => 'ra-row'"
            @row-click="openDetail($event as Report)"
          >
            <el-table-column label="类型" width="90">
              <template #default="{ row }">
                <el-tag size="small" :type="typeTag((row as Report).type)" effect="plain">{{ REPORT_TYPE_LABEL[(row as Report).type] }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="被举报对象" width="110">
              <template #default="{ row }">#{{ (row as Report).targetId }}</template>
            </el-table-column>
            <el-table-column prop="reason" label="举报理由" min-width="150" show-overflow-tooltip />
            <el-table-column prop="description" label="详情描述" min-width="240" show-overflow-tooltip />
            <el-table-column label="举报时间" width="160">
              <template #default="{ row }">{{ formatDate((row as Report).createTime, 'MM-DD HH:mm') }}</template>
            </el-table-column>
            <el-table-column label="操作" width="150" align="right">
              <template #default="{ row }">
                <el-button size="small" text type="primary" @click.stop="openDetail(row as Report)">核实</el-button>
                <el-button size="small" type="danger" plain @click.stop="openHandle(row as Report)">处置</el-button>
              </template>
            </el-table-column>
            <template #empty>
              <el-empty description="没有待处理的举报，处理得很及时" :image-size="88" />
            </template>
          </el-table>
          <el-pagination
            v-model:current-page="pendingPage"
            :page-size="pendingPageSize"
            :total="pendingTotal"
            layout="total, prev, pager, next"
            class="ra-pager"
            @current-change="loadPending"
          />
        </el-tab-pane>

        <el-tab-pane label="处理记录" name="records" lazy>
          <!-- 导出的是「全部处理记录」而非当前页：Excel 兼容 CSV，对账 / 归档直接可用 -->
          <div class="records-toolbar">
            <span class="records-hint">共 {{ recordsTotal }} 条记录</span>
            <el-button
              text
              type="primary"
              :disabled="!recordsTotal"
              @click="onExportRecords"
            >
              <el-icon><Download /></el-icon>&nbsp;导出记录
            </el-button>
          </div>
          <el-table v-loading="recordsLoading" :data="handledList" row-key="id" class="ra-table">
            <el-table-column label="类型" width="90">
              <template #default="{ row }">
                <el-tag size="small" :type="typeTag((row as Report).type)" effect="plain">{{ REPORT_TYPE_LABEL[(row as Report).type] }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="对象" width="90">
              <template #default="{ row }">#{{ (row as Report).targetId }}</template>
            </el-table-column>
            <el-table-column label="结论" width="100">
              <template #default="{ row }">
                <el-tag :type="(row as Report).status === 'handled' ? 'warning' : 'info'" size="small" effect="light">
                  {{ (row as Report).status === 'handled' ? '处置成立' : '驳回举报' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="措施" width="110">
              <template #default="{ row }">{{ (row as Report).measure ? REPORT_MEASURE_LABEL[(row as Report).measure!] : '—' }}</template>
            </el-table-column>
            <el-table-column label="处置说明" min-width="220" show-overflow-tooltip>
              <template #default="{ row }">{{ (row as Report).outcome ?? '—' }}</template>
            </el-table-column>
            <el-table-column label="处理备注" min-width="160" show-overflow-tooltip>
              <template #default="{ row }">{{ (row as Report).remark ?? '—' }}</template>
            </el-table-column>
            <el-table-column prop="handledBy" label="处理人" width="110" />
            <el-table-column label="处理时间" width="160">
              <template #default="{ row }">{{ formatDate((row as Report).handleTime ?? '', 'MM-DD HH:mm') }}</template>
            </el-table-column>
            <template #empty>
              <el-empty description="还没有处理记录" :image-size="88" />
            </template>
          </el-table>
          <el-pagination
            v-model:current-page="recordsPage"
            :page-size="recordsPageSize"
            :total="recordsTotal"
            layout="total, prev, pager, next"
            class="ra-pager"
            @current-change="loadRecords"
          />
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <!-- 核实抽屉：举报内容 + 对象现状 -->
    <el-drawer
      v-model="detailVisible"
      title="举报核实"
      size="520px"
      append-to-body
      @closed="releaseOverlayFocus"
    >
      <template v-if="detail">
        <div class="report-block">
          <h4 class="rb-title">举报内容</h4>
          <p class="rb-reason">「{{ detail.reason }}」</p>
          <p class="rb-desc">{{ detail.description }}</p>
          <p class="rb-time">举报于 {{ formatDate(detail.createTime) }}</p>
        </div>

        <div class="report-block">
          <h4 class="rb-title">被举报对象现状</h4>
          <div v-loading="briefLoading" class="target-card">
            <template v-if="brief">
              <!-- 商品类：完整商品档案（图集 / 描述 / 价格 / 交易信息），判「虚假描述」要有全部证据 -->
              <template v-if="detail.type === 'goods' && brief.exists">
                <div class="tc-head">
                  <span class="tc-name">{{ brief.title }}</span>
                  <el-tag size="small" :type="brief.statusType">{{ brief.statusLabel }}</el-tag>
                </div>
                <div class="tc-gallery">
                  <el-image :src="brief.images?.[activeImg] || brief.cover" fit="cover" class="tc-main" :preview-src-list="brief.images" hide-on-click-modal />
                  <div v-if="(brief.images?.length ?? 0) > 1" class="tc-thumbs">
                    <el-image
                      v-for="(img, i) in brief.images"
                      :key="img"
                      :src="img"
                      fit="cover"
                      class="tc-thumb"
                      :class="{ 'is-active': i === activeImg }"
                      @click="activeImg = i"
                    />
                  </div>
                </div>
                <p class="tc-desc">{{ brief.description }}</p>
                <div class="tc-prices">
                  <span class="tc-price">¥{{ brief.promoPrice ?? brief.listPrice }}</span>
                  <span v-if="brief.promoPrice != null" class="tc-strike">¥{{ brief.listPrice }}</span>
                  <span v-if="brief.promoPrice != null" class="tc-promo-tag">活动让利</span>
                </div>
                <div class="tc-grid">
                  <div class="tcg-item"><dt>分类</dt><dd>{{ brief.categoryName }}</dd></div>
                  <div class="tcg-item"><dt>交易方式</dt><dd>{{ deliveryText(brief.deliveryMethod) }}</dd></div>
                  <div class="tcg-item"><dt>交易地点</dt><dd>{{ brief.location || '未填写' }}</dd></div>
                  <div class="tcg-item"><dt>可售数量</dt><dd>{{ brief.stock ?? 1 }} 件</dd></div>
                  <div class="tcg-item"><dt>浏览 / 收藏</dt><dd>{{ brief.viewCount ?? 0 }} / {{ brief.favoriteCount ?? 0 }}</dd></div>
                  <div class="tcg-item"><dt>发布时间</dt><dd>{{ formatDate(brief.createTime ?? '') }}</dd></div>
                </div>
                <div class="tc-row">
                  <span v-if="brief.sellerName">卖家：{{ brief.sellerName }}</span>
                </div>
              </template>

              <!-- 用户类 -->
              <template v-else-if="detail.type === 'user' && brief.exists">
                <div class="tc-head">
                  <div class="tc-user">
                    <el-avatar :size="40" :src="brief.avatar">{{ brief.title.slice(0, 1) }}</el-avatar>
                    <span class="tc-name">{{ brief.title }}</span>
                  </div>
                  <el-tag size="small" :type="brief.statusType">{{ brief.statusLabel }}</el-tag>
                </div>
                <div class="tc-row">
                  <span v-if="brief.creditScore != null">
                    信用分 <b class="tc-score" :class="{ 'is-low': brief.creditScore < 60 }">{{ brief.creditScore }}</b>
                  </span>
                </div>
              </template>

              <!-- 订单类 / 兜底 -->
              <template v-else>
                <div class="tc-head">
                  <span class="tc-name">{{ brief.title }}</span>
                  <el-tag size="small" :type="brief.statusType">{{ brief.statusLabel }}</el-tag>
                </div>
                <div v-if="brief.cover" class="tc-media">
                  <el-image :src="brief.cover" fit="cover" class="tc-cover" />
                  <span v-if="brief.price != null" class="tc-price">¥{{ brief.price }}</span>
                </div>
                <div class="tc-row">
                  <span v-if="brief.sellerName">卖家：{{ brief.sellerName }}</span>
                  <span v-if="brief.buyerName">买家：{{ brief.buyerName }}</span>
                  <span v-if="brief.creditScore != null">
                    信用分 <b class="tc-score" :class="{ 'is-low': brief.creditScore < 60 }">{{ brief.creditScore }}</b>
                  </span>
                </div>
              </template>
            </template>
            <span v-else-if="!briefLoading" class="tc-miss">未能读取对象信息</span>
          </div>
        </div>

        <div class="detail-actions">
          <el-button type="danger" @click="openHandle(detail)">处置举报</el-button>
          <el-button @click="openRejectReport(detail)">驳回举报（不成立）</el-button>
        </div>
      </template>
    </el-drawer>

    <!-- 处置弹窗 -->
    <el-dialog
      v-model="handleVisible"
      title="处置举报"
      width="480px"
      append-to-body
      @closed="releaseOverlayFocus"
    >
      <template v-if="handleTarget">
        <p class="handle-intro">
          {{ REPORT_TYPE_LABEL[handleTarget.type] }}举报 #{{ handleTarget.id }} · 「{{ handleTarget.reason }}」
        </p>
        <div class="measure-list">
          <label
            v-for="m in measures"
            :key="m.value"
            class="measure-item"
            :class="{ 'is-active': measure === m.value }"
          >
            <input v-model="measure" type="radio" :value="m.value" class="measure-radio" />
            <span class="measure-body">
              <span class="measure-label">{{ m.label }}</span>
              <span class="measure-effect">{{ m.effect }}</span>
            </span>
          </label>
        </div>
        <el-input
          v-model="remark"
          type="textarea"
          :rows="2"
          maxlength="120"
          show-word-limit
          class="handle-remark"
          placeholder="处理备注：说明判断依据（给后续复核的人看）"
        />
        <p v-if="handleError" class="handle-error">{{ handleError }}</p>
      </template>
      <template #footer>
        <el-button @click="handleVisible = false">取消</el-button>
        <el-button type="danger" :loading="acting" @click="confirmHandle">执行处置</el-button>
      </template>
    </el-dialog>

    <!-- 驳回举报弹窗 -->
    <el-dialog
      v-model="rejectVisible"
      title="驳回举报"
      width="440px"
      append-to-body
      @closed="releaseOverlayFocus"
    >
      <p class="reject-tip">驳回表示「举报不成立」，不会对被举报对象做任何处置，但会留痕。</p>
      <el-input
        v-model="remark"
        type="textarea"
        :rows="2"
        maxlength="120"
        show-word-limit
        placeholder="驳回说明（至少 5 个字）：为什么判定举报不成立"
      />
      <p v-if="rejectError" class="handle-error">{{ rejectError }}</p>
      <template #footer>
        <el-button @click="rejectVisible = false">取消</el-button>
        <el-button type="warning" :loading="acting" @click="confirmReject">确认驳回</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Download, Refresh, Search } from '@element-plus/icons-vue'
import BackButton from '@/components/common/BackButton.vue'
import { releaseOverlayFocus } from '@/utils/focus'
import { formatDate } from '@/utils/format'
import { csvFileName, downloadCsv } from '@/utils/csv'
import type { CsvColumn } from '@/utils/csv'
import {
  fetchReports,
  fetchReportsForExport,
  fetchReportStats,
  fetchReportTargetBrief,
  measuresForType,
  REPORT_MEASURE_LABEL,
  REPORT_TYPE_LABEL,
  resolveReport,
  type ReportTargetBrief
} from '@/api/report'
import type { Report, ReportMeasure } from '@/types'

/* ---------------- 状态 ---------------- */
const tab = ref<'pending' | 'records'>('pending')
const stats = ref({ pending: 0, handled: 0, rejected: 0 })
const kpis = computed(() => [
  { label: '待处理', value: stats.value.pending, tone: 'warn' },
  { label: '今日待办', value: stats.value.pending, tone: 'danger' },
  { label: '累计处置', value: stats.value.handled, tone: 'primary' },
  { label: '累计驳回', value: stats.value.rejected, tone: 'info' }
])

const pendingList = ref<Report[]>([])
const pendingLoading = ref(false)
const pendingPage = ref(1)
const pendingPageSize = 10
const pendingTotal = ref(0)
const typeFilter = ref<Report['type'] | ''>('')

const handledList = ref<Report[]>([])
const recordsLoading = ref(false)
const recordsPage = ref(1)
const recordsPageSize = 10
const recordsTotal = ref(0)

const acting = ref(false)

/* ---------------- 加载 ---------------- */
async function loadPending() {
  pendingLoading.value = true
  try {
    const res = await fetchReports({
      page: pendingPage.value,
      pageSize: pendingPageSize,
      status: 'pending',
      type: typeFilter.value || undefined
    })
    pendingList.value = res.list
    pendingTotal.value = res.total
  } finally {
    pendingLoading.value = false
  }
}

async function loadRecords() {
  recordsLoading.value = true
  try {
    // 处理记录 = 已处置 + 已驳回，两段状态分别取再合并（接口按单状态过滤）
    const [handled, rejected] = await Promise.all([
      fetchReports({ page: 1, pageSize: 50, status: 'handled' }),
      fetchReports({ page: 1, pageSize: 50, status: 'rejected' })
    ])
    const all = [...handled.list, ...rejected.list]
      .sort((a, b) => (b.handleTime ?? '').localeCompare(a.handleTime ?? ''))
    recordsTotal.value = all.length
    const start = (recordsPage.value - 1) * recordsPageSize
    handledList.value = all.slice(start, start + recordsPageSize)
  } finally {
    recordsLoading.value = false
  }
}

/* ---------------- 导出 ---------------- */
/** 导出列：与「处理记录」表格同字段，另带举报理由 / 描述 / 举报时间，离线核对时不用回系统查 */
const RECORD_EXPORT_COLUMNS: CsvColumn<Report>[] = [
  { key: 'id', title: '举报ID' },
  { key: 'type', title: '类型', format: (r) => REPORT_TYPE_LABEL[r.type] },
  { key: 'targetId', title: '对象ID' },
  { key: 'reason', title: '举报理由' },
  { key: 'description', title: '详细描述' },
  {
    key: 'status',
    title: '结论',
    format: (r) => (r.status === 'handled' ? '处置成立' : r.status === 'rejected' ? '驳回举报' : '待处理')
  },
  { key: 'measure', title: '处置措施', format: (r) => (r.measure ? REPORT_MEASURE_LABEL[r.measure] : '') },
  { key: 'outcome', title: '处置说明', format: (r) => r.outcome ?? '' },
  { key: 'remark', title: '处理备注', format: (r) => r.remark ?? '' },
  { key: 'handledBy', title: '处理人', format: (r) => r.handledBy ?? '' },
  {
    key: 'handleTime',
    title: '处理时间',
    format: (r) => (r.handleTime ? formatDate(r.handleTime, 'YYYY-MM-DD HH:mm') : '')
  },
  { key: 'createTime', title: '举报时间', format: (r) => formatDate(r.createTime, 'YYYY-MM-DD HH:mm') }
]

/**
 * 导出全部处理记录，不是当前页 —— 且只导「审核之后」的（已处置 / 已驳回），
 * 待处理的不算结论，混进去会让对账的人误以为已经处理完。
 */
async function onExportRecords() {
  recordsLoading.value = true
  try {
    const all = await fetchReportsForExport({ type: typeFilter.value || undefined })
    const rows = all.filter((r) => r.status !== 'pending')
    if (!rows.length) {
      ElMessage.warning('还没有可导出的处理记录')
      return
    }
    downloadCsv(csvFileName(`举报处理记录-${rows.length}条`), RECORD_EXPORT_COLUMNS, rows)
    ElMessage.success(`已导出 ${rows.length} 条处理记录`)
  } finally {
    recordsLoading.value = false
  }
}

async function loadStats() {
  stats.value = await fetchReportStats()
}

function reloadPending() {
  pendingPage.value = 1
  loadPending()
  loadStats()
}

async function reloadAll() {
  await Promise.all([loadPending(), loadRecords(), loadStats()])
}

function typeTag(t: Report['type']) {
  return t === 'goods' ? 'primary' : t === 'user' ? 'warning' : 'info'
}

/* ---------------- 核实抽屉 ---------------- */
const detailVisible = ref(false)
const detail = ref<Report | null>(null)
const brief = ref<ReportTargetBrief | null>(null)
const briefLoading = ref(false)
/** 图集当前主图下标（打开新举报时重置） */
const activeImg = ref(0)

function deliveryText(m?: ReportTargetBrief['deliveryMethod']): string {
  return m === 'express' ? '包邮快递' : m === 'self' ? '买家自提' : m === 'face' ? '校园面交' : '未填写'
}

async function openDetail(r: Report) {
  detail.value = r
  detailVisible.value = true
  activeImg.value = 0
  briefLoading.value = true
  brief.value = null
  try {
    brief.value = await fetchReportTargetBrief(r.type, r.targetId)
  } finally {
    briefLoading.value = false
  }
}

/* ---------------- 处置 ---------------- */
const handleVisible = ref(false)
const handleTarget = ref<Report | null>(null)
const measure = ref<ReportMeasure>('warn')
const remark = ref('')
const handleError = ref('')
const measures = computed(() => (handleTarget.value ? measuresForType(handleTarget.value.type) : []))

function openHandle(r: Report) {
  handleTarget.value = r
  measure.value = 'warn'
  remark.value = ''
  handleError.value = ''
  handleVisible.value = true
}

async function confirmHandle() {
  if (!handleTarget.value) return
  const m = measure.value
  if (!m) {
    handleError.value = '请先选择一项处理措施'
    return
  }
  if ((remark.value ?? '').trim().length < 5) {
    handleError.value = '处理备注至少 5 个字，说明判断依据'
    return
  }
  acting.value = true
  try {
    await resolveReport({ id: handleTarget.value.id, action: 'handle', measure: m, remark: remark.value })
    ElMessage.success(`举报 #${handleTarget.value.id} 已处置（${REPORT_MEASURE_LABEL[m]}）`)
    handleVisible.value = false
    detailVisible.value = false
    await reloadAll()
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '处置失败，请重试')
  } finally {
    acting.value = false
  }
}

/* ---------------- 驳回 ---------------- */
const rejectVisible = ref(false)
const rejectError = ref('')
const rejectTarget = ref<Report | null>(null)

function openRejectReport(r: Report) {
  rejectTarget.value = r
  remark.value = ''
  rejectError.value = ''
  rejectVisible.value = true
}

async function confirmReject() {
  if (!rejectTarget.value) return
  if ((remark.value ?? '').trim().length < 5) {
    rejectError.value = '驳回说明至少 5 个字'
    return
  }
  acting.value = true
  try {
    await resolveReport({ id: rejectTarget.value.id, action: 'reject', remark: remark.value })
    ElMessage.success(`举报 #${rejectTarget.value.id} 已驳回（不成立）`)
    rejectVisible.value = false
    detailVisible.value = false
    await reloadAll()
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '驳回失败，请重试')
  } finally {
    acting.value = false
  }
}

onMounted(reloadAll)
</script>

<style scoped lang="scss">
.ra-page {
  max-width: 1180px;
  margin: 0 auto;
  padding: 16px 20px 40px;
}

/* 页头 */
.ra-hero {
  padding: 22px 24px;
  margin-bottom: 16px;
  background: linear-gradient(135deg, var(--color-primary-soft), var(--bg-card) 65%);
  border: 1px solid var(--color-primary-light);
  border-radius: var(--radius-lg);
}

.hero-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 20px;
  font-weight: $fw-bold;
  color: var(--color-text-primary);

  .hero-icon { color: var(--color-primary); }
}

.hero-badge {
  padding: 2px 10px;
  margin-left: 4px;
  font-size: $font-xs;
  font-weight: $fw-medium;
  color: var(--color-primary);
  background: var(--color-primary-soft);
  border: 1px solid var(--color-primary-light);
  border-radius: var(--radius-pill);
}

.hero-sub {
  margin: 6px 0 0;
  font-size: $font-sm;
  color: var(--color-text-secondary);
}

/* KPI */
.ra-kpis {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin-bottom: 16px;
}

.kpi-card {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 14px 18px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-xs);

  .kpi-num {
    font-size: 24px;
    font-weight: $fw-bold;
    font-variant-numeric: tabular-nums;
    color: var(--color-text-primary);
  }

  .kpi-label {
    font-size: $font-xs;
    color: var(--color-text-mute);
  }

  &.is-warn .kpi-num { color: var(--color-warning); }
  &.is-danger .kpi-num { color: var(--color-danger); }
  &.is-primary .kpi-num { color: var(--color-primary); }
  &.is-info .kpi-num { color: var(--color-info); }
}

/* 卡片与表格 */
.ra-card {
  border-radius: var(--radius-md);
  border-color: var(--border-color);
}

.tab-count {
  display: inline-block;
  min-width: 18px;
  margin-left: 4px;
  padding: 0 5px;
  font-size: 11px;
  line-height: 17px;
  text-align: center;
  color: #fff;
  background: var(--color-danger);
  border-radius: var(--radius-pill);
}

.toolbar {
  display: flex;
  gap: 10px;
  margin-bottom: 12px;
}

.toolbar-type {
  width: 150px;
}

/* 处理记录工具栏：条数提示 + 导出按钮 */
.records-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.records-hint {
  font-size: 13px;
  color: var(--color-text-mute);
}

.ra-table {
  width: 100%;

  :deep(.ra-row) { cursor: pointer; }
}

.ra-pager {
  display: flex;
  justify-content: flex-end;
  margin-top: 14px;
}

/* 抽屉 */
.report-block {
  margin-bottom: 18px;
}

.rb-title {
  margin: 0 0 8px;
  font-size: $font-sm;
  font-weight: $fw-semibold;
  color: var(--color-text-mute);
}

.rb-reason {
  margin: 0 0 6px;
  font-weight: $fw-medium;
  color: var(--color-text-primary);
}

.rb-desc {
  margin: 0 0 6px;
  font-size: $font-sm;
  line-height: 1.6;
  color: var(--color-text-secondary);
}

.rb-time {
  margin: 0;
  font-size: $font-xs;
  color: var(--color-text-mute);
}

.target-card {
  min-height: 84px;
  padding: 12px 14px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
}

.tc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.tc-name {
  font-weight: $fw-medium;
  color: var(--color-text-primary);
}

.tc-media {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-top: 10px;
}

.tc-cover {
  width: 64px;
  height: 64px;
  border-radius: var(--radius-xs);
  background: var(--bg-soft);
}

.tc-price {
  font-weight: $fw-semibold;
  font-variant-numeric: tabular-nums;
  color: var(--brand-orange);
}

.tc-row {
  display: flex;
  gap: 16px;
  margin-top: 10px;
  font-size: $font-sm;
  color: var(--color-text-secondary);

  .tc-score {
    font-variant-numeric: tabular-nums;
    color: var(--color-success);
  }

  .tc-score.is-low { color: var(--color-danger); }
}

.tc-miss {
  font-size: $font-sm;
  color: var(--color-text-mute);
}

/* ---- 商品类：图集 + 完整档案 ---- */
.tc-gallery {
  margin-top: 10px;
}

.tc-main {
  width: 100%;
  height: 220px;
  border-radius: var(--radius-sm);
  background: var(--bg-soft);
}

.tc-thumbs {
  display: flex;
  gap: 8px;
  margin-top: 8px;
  overflow-x: auto;
}

.tc-thumb {
  flex: none;
  width: 56px;
  height: 56px;
  border-radius: var(--radius-xs);
  cursor: pointer;
  opacity: 0.65;
  border: 2px solid transparent;
  transition: opacity $dur-fast $ease-out, border-color $dur-fast $ease-out;

  &.is-active {
    opacity: 1;
    border-color: var(--brand-orange);
  }
}

.tc-desc {
  margin: 10px 0 0;
  font-size: $font-sm;
  line-height: 1.6;
  color: var(--color-text-secondary);
}

.tc-prices {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-top: 10px;

  .tc-strike {
    font-size: $font-xs;
    color: var(--color-text-mute);
    text-decoration: line-through;
  }

  .tc-promo-tag {
    padding: 1px 8px;
    font-size: 11px;
    color: $brand-orange;
    background: var(--brand-orange-soft);
    border: 1px solid var(--brand-orange-line);
    border-radius: var(--radius-pill);
  }
}

.tc-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-top: 10px;
}

.tcg-item {
  padding: 8px 10px;
  background: var(--bg-soft);
  border-radius: var(--radius-xs);

  dt {
    margin-bottom: 2px;
    font-size: 11px;
    color: var(--color-text-mute);
  }

  dd {
    margin: 0;
    font-size: $font-sm;
    color: var(--color-text-primary);
  }
}

.tc-user {
  display: flex;
  align-items: center;
  gap: 10px;
}

.detail-actions {
  display: flex;
  gap: 10px;

  .el-button { flex: 1; }
}

/* 处置弹窗 */
.handle-intro {
  margin: 0 0 12px;
  font-size: $font-sm;
  color: var(--color-text-secondary);
}

.measure-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
}

.measure-item {
  display: flex;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: border-color $dur-base $ease-out, background $dur-base $ease-out;

  &:hover { border-color: var(--border-color-strong); }

  &.is-active {
    border-color: var(--color-danger);
    background: rgba(239, 68, 68, 0.04);
  }
}

.measure-radio {
  margin-top: 3px;
  accent-color: var(--color-danger);
}

.measure-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.measure-label {
  font-weight: $fw-medium;
  color: var(--color-text-primary);
}

.measure-effect {
  font-size: $font-xs;
  color: var(--color-text-secondary);
}

.handle-remark {
  margin-bottom: 4px;
}

.handle-error,
.reject-error {
  margin: 8px 0 0;
  font-size: $font-xs;
  color: var(--color-danger);
}

.reject-tip {
  margin: 0 0 10px;
  font-size: $font-sm;
  color: var(--color-text-secondary);
}
</style>
