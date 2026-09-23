<template>
  <div class="ga-page">
    <BackButton />

    <!-- 页头：职能声明 -->
    <section class="ga-hero">
      <div class="hero-text">
        <h1 class="hero-title">
          <el-icon :size="22" class="hero-icon"><Goods /></el-icon>
          商品审核后台
          <span class="hero-badge">商品审核员专属</span>
        </h1>
        <p class="hero-sub">
          只负责一件事：把好商品上架前的关口 —— 查看待审核商品、通过或驳回、复核审核记录。
          与举报处理互不干涉。
        </p>
      </div>
    </section>

    <!-- 工作量 KPI -->
    <section class="ga-kpis">
      <div v-for="k in kpis" :key="k.label" class="kpi-card" :class="`is-${k.tone}`">
        <span class="kpi-num">{{ k.value }}</span>
        <span class="kpi-label">{{ k.label }}</span>
      </div>
    </section>

    <el-card class="ga-card" shadow="never">
      <el-tabs v-model="tab">
        <!-- ① 待审核 -->
        <el-tab-pane name="pending">
          <template #label>
            待审核<span v-if="stats.pending" class="tab-count">{{ stats.pending }}</span>
          </template>
          <div class="toolbar">
            <el-input
              v-model="keyword"
              placeholder="搜商品标题 / 卖家昵称"
              clearable
              class="toolbar-search"
              @keyup.enter="reloadPending"
              @clear="reloadPending"
            >
              <template #prefix><el-icon><Search /></el-icon></template>
            </el-input>
            <el-button :icon="Refresh" @click="reloadPending">刷新</el-button>
          </div>

          <el-table v-loading="pendingLoading" :data="pendingList" row-key="id" class="ga-table">
            <el-table-column label="商品" min-width="300">
              <template #default="{ row }">
                <div class="cell-goods">
                  <el-image :src="row.cover" fit="cover" class="cell-cover" lazy />
                  <div class="cell-info">
                    <span class="cell-title" :title="row.title">{{ row.title }}</span>
                    <span class="cell-sub">
                      {{ row.categoryName }} · 提交于 {{ formatDate(row.createTime, 'MM-DD HH:mm') }}
                    </span>
                  </div>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="价格" width="110">
              <template #default="{ row }">
                <span class="cell-price">¥{{ row.promoPrice ?? row.price }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="sellerName" label="卖家" width="140" show-overflow-tooltip />
            <el-table-column label="操作" width="220" align="right">
              <template #default="{ row }">
                <el-button size="small" text type="primary" @click="openDetail(row as GoodsEntity)">详情</el-button>
                <el-button size="small" type="success" plain :loading="actingId === row.id" @click="approve(row as GoodsEntity)">通过</el-button>
                <el-button size="small" type="danger" plain @click="openReject(row as GoodsEntity)">驳回</el-button>
              </template>
            </el-table-column>
            <template #empty>
              <el-empty description="没有待审核的商品，都处理完啦" :image-size="88" />
            </template>
          </el-table>
          <el-pagination
            v-model:current-page="pendingPage"
            :page-size="pendingPageSize"
            :total="pendingTotal"
            layout="total, prev, pager, next"
            class="ga-pager"
            @current-change="loadPending"
          />
        </el-tab-pane>

        <!-- ② 审核记录 -->
        <el-tab-pane label="审核记录" name="records" lazy>
          <!-- 导出的是「全部记录」而非当前页：Excel 兼容 CSV，复核 / 归档直接可用 -->
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
          <el-table v-loading="recordsLoading" :data="recordsList" row-key="id" class="ga-table">
            <el-table-column prop="goodsTitle" label="商品" min-width="240" show-overflow-tooltip />
            <el-table-column label="结论" width="100">
              <template #default="{ row }">
                <el-tag :type="row.action === 'approve' ? 'success' : 'danger'" size="small" effect="light">
                  {{ row.action === 'approve' ? '通过上架' : '驳回' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="驳回理由" min-width="220">
              <template #default="{ row }">
                <span v-if="row.reason" class="cell-reason">{{ row.reason }}</span>
                <span v-else class="cell-mute">—</span>
              </template>
            </el-table-column>
            <el-table-column prop="operator" label="审核人" width="120" />
            <el-table-column label="审核时间" width="170">
              <template #default="{ row }">{{ formatDate(row.time) }}</template>
            </el-table-column>
            <template #empty>
              <el-empty description="还没有审核记录，处理完待审商品后这里会留痕" :image-size="88" />
            </template>
          </el-table>
          <el-pagination
            v-model:current-page="recordsPage"
            :page-size="recordsPageSize"
            :total="recordsTotal"
            layout="total, prev, pager, next"
            class="ga-pager"
            @current-change="loadRecords"
          />
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <!-- 详情抽屉：核实「该不该过」 -->
    <el-drawer
      v-model="detailVisible"
      title="商品审核详情"
      size="520px"
      append-to-body
      @closed="releaseOverlayFocus"
    >
      <template v-if="detail">
        <!-- 图集：主图可点开预览，多图可切换（审核「图文相符」的直接证据） -->
        <div class="detail-gallery">
          <el-image
            :src="detail.goods.images[detailImg] || detail.goods.cover"
            fit="cover"
            class="detail-cover"
            :preview-src-list="detail.goods.images.length ? detail.goods.images : [detail.goods.cover]"
            hide-on-click-modal
          />
          <div v-if="detail.goods.images.length > 1" class="detail-thumbs">
            <el-image
              v-for="(img, i) in detail.goods.images"
              :key="img"
              :src="img"
              fit="cover"
              class="detail-thumb"
              :class="{ 'is-active': i === detailImg }"
              @click="detailImg = i"
            />
          </div>
        </div>

        <h3 class="detail-title">{{ detail.goods.title }}</h3>
        <p class="detail-desc">{{ detail.goods.description }}</p>

        <div class="detail-prices">
          <span class="dp-now">¥{{ detail.goods.promoPrice ?? detail.goods.price }}</span>
          <span v-if="detail.goods.promoPrice != null" class="dp-strike">¥{{ detail.goods.price }}</span>
          <span v-if="detail.goods.promoPrice != null" class="dp-tag">活动让利</span>
        </div>

        <dl class="detail-grid">
          <div class="dg-item"><dt>分类</dt><dd>{{ detail.goods.categoryName }}</dd></div>
          <div class="dg-item"><dt>交易方式</dt><dd>{{ deliveryText(detail.goods.deliveryMethod) }}</dd></div>
          <div class="dg-item"><dt>交易地点</dt><dd>{{ detail.goods.location || '未填写' }}</dd></div>
          <div class="dg-item"><dt>可售数量</dt><dd>{{ detail.goods.stock ?? 1 }} 件</dd></div>
          <div class="dg-item"><dt>浏览 / 收藏</dt><dd>{{ detail.goods.viewCount }} / {{ detail.goods.favoriteCount }}</dd></div>
          <div class="dg-item"><dt>提交时间</dt><dd>{{ formatDate(detail.goods.createTime) }}</dd></div>
        </dl>

        <div class="seller-card">
          <div class="sc-head">
            <span class="sc-name">卖家：{{ detail.seller.nickname }}</span>
            <el-tag size="small" :type="detail.seller.status === 'active' ? 'success' : 'danger'">
              {{ detail.seller.status === 'active' ? '正常' : '已封禁' }}
            </el-tag>
          </div>
          <div class="sc-row">
            <span>信用分 <b class="sc-score" :class="{ 'is-low': detail.seller.creditScore < 60 }">{{ detail.seller.creditScore }}</b></span>
            <span>在售 {{ detail.seller.onSaleCount }} 件</span>
          </div>
        </div>

        <div class="detail-actions">
          <el-button type="success" :loading="acting" @click="approve(detail.goods)">通过上架</el-button>
          <el-button type="danger" plain @click="openReject(detail.goods)">驳回</el-button>
        </div>
      </template>
    </el-drawer>

    <!-- 驳回理由 -->
    <el-dialog
      v-model="rejectVisible"
      title="驳回商品"
      width="440px"
      append-to-body
      @closed="releaseOverlayFocus"
    >
      <p v-if="rejectTarget" class="reject-goods">
        《{{ rejectTarget.title }}》
      </p>
      <el-input
        v-model="rejectReason"
        type="textarea"
        :rows="3"
        maxlength="120"
        show-word-limit
        placeholder="写清驳回理由（至少 5 个字），让卖家知道差在哪里、怎么改"
      />
      <p v-if="rejectError" class="reject-error">{{ rejectError }}</p>
      <template #footer>
        <el-button @click="rejectVisible = false">取消</el-button>
        <el-button type="danger" :loading="acting" @click="confirmReject">确认驳回</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Download, Goods, Refresh, Search } from '@element-plus/icons-vue'
import BackButton from '@/components/common/BackButton.vue'
import { releaseOverlayFocus } from '@/utils/focus'
import { formatDate } from '@/utils/format'
import { csvFileName, downloadCsv } from '@/utils/csv'
import type { CsvColumn } from '@/utils/csv'
import {
  fetchPendingGoods,
  fetchGoodsAuditDetail,
  fetchGoodsAuditRecords,
  fetchGoodsAuditRecordsForExport,
  fetchGoodsAuditStats,
  reviewGoods,
  type GoodsAuditStats
} from '@/api/goodsAudit'
import type { Goods as GoodsEntity, GoodsAuditRecord } from '@/types'

/* ---------------- 状态 ---------------- */
const tab = ref<'pending' | 'records'>('pending')

const stats = ref<GoodsAuditStats>({ pending: 0, approved: 0, rejected: 0, today: 0 })
const kpis = computed(() => [
  { label: '待审核', value: stats.value.pending, tone: 'warn' },
  { label: '今日已审', value: stats.value.today, tone: 'primary' },
  { label: '累计通过', value: stats.value.approved, tone: 'success' },
  { label: '累计驳回', value: stats.value.rejected, tone: 'danger' }
])

const pendingList = ref<GoodsEntity[]>([])
const pendingLoading = ref(false)
const pendingPage = ref(1)
const pendingPageSize = 10
const pendingTotal = ref(0)
const keyword = ref('')

const recordsList = ref<GoodsAuditRecord[]>([])
const recordsLoading = ref(false)
const recordsPage = ref(1)
const recordsPageSize = 10
const recordsTotal = ref(0)

const actingId = ref<number | null>(null)
const acting = ref(false)

/* ---------------- 加载 ---------------- */
async function loadPending() {
  pendingLoading.value = true
  try {
    const res = await fetchPendingGoods({
      page: pendingPage.value,
      pageSize: pendingPageSize,
      keyword: keyword.value
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
    const res = await fetchGoodsAuditRecords({
      page: recordsPage.value,
      pageSize: recordsPageSize
    })
    recordsList.value = res.list
    recordsTotal.value = res.total
  } finally {
    recordsLoading.value = false
  }
}

/* ---------------- 导出 ---------------- */
/** 导出列：与「审核记录」表格同字段（Excel 兼容 CSV，供复核 / 归档） */
const RECORD_EXPORT_COLUMNS: CsvColumn<GoodsAuditRecord>[] = [
  { key: 'id', title: '记录ID' },
  { key: 'goodsId', title: '商品ID' },
  { key: 'goodsTitle', title: '商品标题' },
  { key: 'action', title: '结论', format: (r) => (r.action === 'approve' ? '通过上架' : '驳回') },
  { key: 'reason', title: '驳回理由', format: (r) => r.reason ?? '' },
  { key: 'operator', title: '审核人' },
  { key: 'time', title: '审核时间', format: (r) => formatDate(r.time, 'YYYY-MM-DD HH:mm') }
]

/**
 * 导出全部审核记录，不是当前页 —— 记录是只增不改的复核凭据，
 * 按页导出会出现「第 3 页以后的争议查不到」这种断档。
 */
async function onExportRecords() {
  recordsLoading.value = true
  try {
    const rows = await fetchGoodsAuditRecordsForExport()
    if (!rows.length) {
      ElMessage.warning('还没有可导出的审核记录')
      return
    }
    downloadCsv(csvFileName(`商品审核记录-${rows.length}条`), RECORD_EXPORT_COLUMNS, rows)
    ElMessage.success(`已导出 ${rows.length} 条审核记录`)
  } finally {
    recordsLoading.value = false
  }
}

async function loadStats() {
  stats.value = await fetchGoodsAuditStats()
}

function reloadPending() {
  pendingPage.value = 1
  loadPending()
  loadStats()
}

async function reloadAll() {
  await Promise.all([loadPending(), loadRecords(), loadStats()])
}

/* ---------------- 详情抽屉 ---------------- */
const detailVisible = ref(false)
const detail = ref<Awaited<ReturnType<typeof fetchGoodsAuditDetail>> | null>(null)
/** 图集当前主图下标（打开新商品时重置） */
const detailImg = ref(0)

async function openDetail(g: GoodsEntity) {
  detail.value = await fetchGoodsAuditDetail(g.id)
  detailImg.value = 0
  detailVisible.value = true
}

function deliveryText(m?: GoodsEntity['deliveryMethod']): string {
  return m === 'express' ? '包邮快递' : m === 'self' ? '买家自提' : '校园面交'
}

/* ---------------- 审核动作 ---------------- */
async function approve(g: GoodsEntity) {
  acting.value = true
  actingId.value = g.id
  try {
    await reviewGoods({ goodsId: g.id, action: 'approve' })
    ElMessage.success(`《${g.title}》已通过审核，上架售卖`)
    detailVisible.value = false
    await reloadAll()
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '审核失败，请重试')
  } finally {
    acting.value = false
    actingId.value = null
  }
}

const rejectVisible = ref(false)
const rejectTarget = ref<GoodsEntity | null>(null)
const rejectReason = ref('')
const rejectError = ref('')

function openReject(g: GoodsEntity) {
  rejectTarget.value = g
  rejectReason.value = ''
  rejectError.value = ''
  rejectVisible.value = true
}

async function confirmReject() {
  if (!rejectTarget.value) return
  const reason = rejectReason.value.trim()
  if (reason.length < 5) {
    rejectError.value = '驳回理由至少 5 个字'
    return
  }
  acting.value = true
  try {
    await reviewGoods({ goodsId: rejectTarget.value.id, action: 'reject', reason })
    ElMessage.success(`《${rejectTarget.value.title}》已驳回，理由会展示给卖家`)
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
.ga-page {
  max-width: 1080px;
  margin: 0 auto;
  padding: 16px 20px 40px;
}

/* 页头 */
.ga-hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 22px 24px;
  margin-bottom: 16px;
  background: linear-gradient(135deg, var(--brand-orange-soft), var(--bg-card) 65%);
  border: 1px solid var(--brand-orange-line);
  border-radius: var(--radius-lg);
}

.hero-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 20px;
  font-weight: $fw-bold;
  color: var(--color-text-primary);

  .hero-icon { color: $brand-orange; }
}

.hero-badge {
  padding: 2px 10px;
  margin-left: 4px;
  font-size: $font-xs;
  font-weight: $fw-medium;
  color: $brand-orange;
  background: var(--brand-orange-soft);
  border: 1px solid var(--brand-orange-line);
  border-radius: var(--radius-pill);
}

.hero-sub {
  margin: 6px 0 0;
  font-size: $font-sm;
  color: var(--color-text-secondary);
}

/* KPI */
.ga-kpis {
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
  &.is-success .kpi-num { color: var(--color-success); }
  &.is-danger .kpi-num { color: var(--color-danger); }
  &.is-primary .kpi-num { color: var(--color-primary); }
}

/* 卡片与表格 */
.ga-card {
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
  background: $brand-orange;
  border-radius: var(--radius-pill);
}

.toolbar {
  display: flex;
  gap: 10px;
  margin-bottom: 12px;
}

.toolbar-search {
  width: 260px;
}

/* 审核记录工具栏：条数提示 + 导出按钮 */
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

.ga-table {
  width: 100%;
}

.cell-goods {
  display: flex;
  gap: 10px;
  align-items: center;
}

.cell-cover {
  flex: none;
  width: 52px;
  height: 52px;
  border-radius: var(--radius-sm);
  background: var(--bg-soft);
}

.cell-info {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.cell-title {
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  font-weight: $fw-medium;
  color: var(--color-text-primary);
}

.cell-sub {
  font-size: $font-xs;
  color: var(--color-text-mute);
}

.cell-price {
  font-weight: $fw-semibold;
  font-variant-numeric: tabular-nums;
  color: $brand-orange;
}

.cell-reason {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-secondary);
}

.cell-mute {
  color: var(--color-text-disabled);
}

.ga-pager {
  display: flex;
  justify-content: flex-end;
  margin-top: 14px;
}

/* 抽屉 */
.detail-cover {
  width: 100%;
  height: 220px;
  border-radius: var(--radius-md);
  background: var(--bg-soft);
}

.detail-title {
  margin: 12px 0 4px;
  font-size: 16px;
  color: var(--color-text-primary);
}

.detail-desc {
  margin: 0 0 14px;
  font-size: $font-sm;
  line-height: 1.6;
  color: var(--color-text-secondary);
}

.detail-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin: 0 0 14px;
}

.dg-item {
  padding: 10px 12px;
  background: var(--bg-soft);
  border-radius: var(--radius-sm);

  dt {
    margin-bottom: 3px;
    font-size: $font-xs;
    color: var(--color-text-mute);
  }

  dd {
    margin: 0;
    font-size: $font-sm;
    color: var(--color-text-primary);
  }
}

.dg-price {
  font-weight: $fw-semibold;
  color: $brand-orange !important;
}

/* ---- 图集 ---- */
.detail-gallery {
  margin-bottom: 4px;
}

.detail-thumbs {
  display: flex;
  gap: 8px;
  margin-top: 8px;
  overflow-x: auto;
}

.detail-thumb {
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
    border-color: $brand-orange;
  }
}

/* ---- 价格区：现价 + 划线价 + 让利标签 ---- */
.detail-prices {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0 0 12px;

  .dp-now {
    font-size: 20px;
    font-weight: $fw-bold;
    font-variant-numeric: tabular-nums;
    color: $brand-orange;
  }

  .dp-strike {
    font-size: $font-sm;
    color: var(--color-text-mute);
    text-decoration: line-through;
  }

  .dp-tag {
    padding: 1px 8px;
    font-size: 11px;
    color: $brand-orange;
    background: var(--brand-orange-soft);
    border: 1px solid var(--brand-orange-line);
    border-radius: var(--radius-pill);
  }
}

.seller-card {
  padding: 12px 14px;
  margin-bottom: 16px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
}

.sc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.sc-name {
  font-weight: $fw-medium;
  color: var(--color-text-primary);
}

.sc-row {
  display: flex;
  justify-content: space-between;
  font-size: $font-sm;
  color: var(--color-text-secondary);

  .sc-score {
    font-variant-numeric: tabular-nums;
    color: var(--color-success);
  }

  .sc-score.is-low { color: var(--color-danger); }
}

.detail-actions {
  display: flex;
  gap: 10px;

  .el-button { flex: 1; }
}

/* 驳回弹窗 */
.reject-goods {
  margin: 0 0 10px;
  font-weight: $fw-medium;
  color: var(--color-text-primary);
}

.reject-error {
  margin: 8px 0 0;
  font-size: $font-xs;
  color: var(--color-danger);
}
</style>
