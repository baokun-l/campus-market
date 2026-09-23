<template>
  <div class="adm-pane">
    <div class="adm-card">
      <div class="adm-card-head">
        <span class="adm-card-title">商品审核</span>
        <span class="adm-card-hint">
          待审核 <b class="is-warn">{{ overview?.pendingGoods ?? 0 }}</b> 件 · 在售
          {{ overview?.onSaleTotal ?? 0 }} / 共 {{ overview?.goodsTotal ?? 0 }} 件
        </span>
      </div>

      <div class="adm-card-body">
        <div class="adm-toolbar">
          <div class="adm-toolbar-left">
            <el-input
              v-model="kw"
              class="adm-input"
              placeholder="搜索商品名 / 卖家"
              clearable
              @input="onSearchInput"
              @clear="reload"
              @keyup.enter="reload"
            />
            <el-select
          :teleported="false"
              v-model="status"
              class="adm-select"
              clearable
              placeholder="全部状态"
              @change="onFilterChange"
            >
              <el-option
                v-for="(label, val) in GOODS_STATUS_LABEL"
                :key="val"
                :label="label"
                :value="val"
              />
            </el-select>
          </div>
          <div class="adm-toolbar-right">
            <el-button
              text
              type="primary"
              :loading="loading"
              @click="reload"
            >
              刷新
            </el-button>
          </div>
        </div>

        <!-- 选中后才出现的批量操作条 -->
        <div
          v-if="selected.length"
          class="adm-batch"
        >
          已选 <b>{{ selected.length }}</b> 件商品
          <div class="adm-batch-ops">
            <el-button
              size="small"
              type="success"
              plain
              @click="onBatchStatus('on_sale')"
            >
              批量上架
            </el-button>
            <el-button
              size="small"
              type="warning"
              plain
              @click="onBatchStatus('off_shelf')"
            >
              批量下架
            </el-button>
            <el-button
              size="small"
              type="danger"
              plain
              @click="onBatchDelete"
            >
              批量删除
            </el-button>
            <el-button
              size="small"
              text
              @click="clearSelection"
            >
              取消选择
            </el-button>
          </div>
        </div>

        <!-- 审核要看得见商品本身：只在表格里看一行标题，无法判断该不该放行 -->
        <p class="gp-tip">
          点击任意一行可打开商品详情（含封面、描述与价格拆分）
        </p>

        <el-table
          ref="tableRef"
          v-loading="loading"
          :data="rows"
          row-key="id"
          style="width: 100%"
          empty-text="没有符合条件的商品"
          row-class-name="gp-row"
          @selection-change="onSelectionChange"
          @row-click="onRowClick"
        >
          <el-table-column
            type="selection"
            width="46"
          />
          <el-table-column
            label="商品"
            min-width="244"
          >
            <template #default="{ row }">
              <div class="adm-media">
                <el-image
                  :src="(row as Goods).cover"
                  fit="cover"
                  class="adm-thumb"
                />
                <div class="adm-media-txt">
                  <span
                    class="adm-ellipsis adm-strong gp-open"
                    @click.stop="openDetail(row as Goods)"
                  >
                    {{ (row as Goods).title }}
                  </span>
                  <span class="adm-sub">
                    {{ (row as Goods).categoryName }} · {{ (row as Goods).location }} ·
                    {{ formatDate((row as Goods).createTime, 'MM-DD HH:mm') }}
                  </span>
                </div>
              </div>
            </template>
          </el-table-column>
          <el-table-column
            label="价格"
            width="112"
            align="right"
          >
            <template #default="{ row }">
              <span class="adm-price">¥{{ priceInfo(row as Goods).pay.toFixed(2) }}</span>
              <!-- 划线价 = 卖家挂牌价（真实价格），有让利才出现 -->
              <s
                v-if="priceInfo(row as Goods).onPromo"
                class="origin"
              >
                挂牌 ¥{{ priceInfo(row as Goods).list.toFixed(2) }}
              </s>
            </template>
          </el-table-column>
          <el-table-column
            label="状态"
            width="86"
            align="center"
          >
            <template #default="{ row }">
              <el-tag
                :type="statusTag((row as Goods).status)"
                effect="light"
                size="small"
              >
                {{ GOODS_STATUS_LABEL[(row as Goods).status] }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column
            label="卖家"
            width="120"
          >
            <template #default="{ row }">
              <div class="adm-inline">
                <el-avatar
                  :src="(row as Goods).sellerAvatar"
                  :size="24"
                />
                <span class="adm-ellipsis">{{ (row as Goods).sellerName }}</span>
              </div>
            </template>
          </el-table-column>
          <!-- 浏览 / 收藏 拆成两行：一行放「3139 浏览 / 151 收藏」会撑出 130px 宽，
               挤掉商品列的宽度（后台正文区只有 ~890px） -->
          <el-table-column
            label="热度"
            width="88"
            align="center"
          >
            <template #default="{ row }">
              <div class="heat">
                <span>{{ (row as Goods).viewCount }} 浏览</span>
                <span>{{ (row as Goods).favoriteCount }} 收藏</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column
            label="操作"
            width="176"
            fixed="right"
            align="center"
          >
            <!-- el-table 插槽的 row 是 DefaultRow，统一断言成业务类型。
                 每个按钮都要 .stop：行点击会打开详情抽屉，删除/下架不该顺带把它弹出来 -->
            <template #default="{ row }">
              <div class="adm-row-ops">
                <el-button
                  v-if="(row as Goods).status === 'pending'"
                  text
                  type="success"
                  size="small"
                  @click.stop="onApprove(row as Goods)"
                >
                  通过
                </el-button>
                <el-button
                  v-if="(row as Goods).status === 'pending'"
                  text
                  type="danger"
                  size="small"
                  @click.stop="onReject(row as Goods)"
                >
                  拒绝
                </el-button>
                <el-button
                  v-if="(row as Goods).status === 'on_sale'"
                  text
                  type="warning"
                  size="small"
                  @click.stop="onChange(row as Goods, 'off_shelf', '已下架')"
                >
                  下架
                </el-button>
                <el-button
                  v-if="(row as Goods).status === 'off_shelf'"
                  text
                  type="primary"
                  size="small"
                  @click.stop="onChange(row as Goods, 'on_sale', '已重新上架')"
                >
                  上架
                </el-button>
                <el-button
                  text
                  type="danger"
                  size="small"
                  @click.stop="onDelete(row as Goods)"
                >
                  删除
                </el-button>
              </div>
            </template>
          </el-table-column>
        </el-table>

        <div class="adm-pager">
          <el-pagination
            v-model:current-page="page"
            :page-size="pageSize"
            :total="total"
            layout="total, prev, pager, next"
            @current-change="reload"
          />
        </div>
      </div>
    </div>

    <!-- 商品详情抽屉：审核与处置的共用视图，处置按钮直接落在抽屉底部 -->
    <el-drawer
      v-model="detailVisible"
      size="540px"
      append-to-body
      :with-header="false"
      @closed="releaseOverlayFocus"
    >
      <div
        v-if="detail"
        class="gp-detail"
      >
        <div class="gp-detail-head">
          <span class="gp-detail-title">商品详情</span>
          <el-button
            text
            size="small"
            @click="detailVisible = false"
          >
            关闭
          </el-button>
        </div>

        <div class="gp-cover">
          <el-image
            :src="detail.cover"
            fit="cover"
            class="gp-cover-img"
          />
          <el-tag
            :type="statusTag(detail.status)"
            effect="dark"
            size="small"
            class="gp-cover-tag"
          >
            {{ GOODS_STATUS_LABEL[detail.status] }}
          </el-tag>
        </div>

        <h3 class="gp-name">
          {{ detail.title }}
        </h3>
        <p class="gp-meta">
          {{ detail.categoryName }} · {{ detail.location }} · 发布于
          {{ formatDate(detail.createTime, 'YYYY-MM-DD HH:mm') }}
        </p>

        <div
          v-if="detail.images.length > 1"
          class="gp-thumbs"
        >
          <el-image
            v-for="(img, i) in detail.images"
            :key="i"
            :src="img"
            fit="cover"
            class="gp-thumb"
          />
        </div>

        <div class="gp-block">
          <div class="gp-block-title">
            价格拆分
          </div>
          <div class="adm-dl">
            <div class="adm-dl-item">
              <span>卖家挂牌价</span>
              <b>¥{{ breakdown.listPrice.toFixed(2) }}</b>
            </div>
            <div class="adm-dl-item">
              <span>买家实付</span>
              <b class="is-price">¥{{ breakdown.payAmount.toFixed(2) }}</b>
            </div>
            <div class="adm-dl-item">
              <span>{{ sellerCutLabel }}</span>
              <b>¥{{ breakdown.sellerCut.toFixed(2) }}</b>
            </div>
            <div class="adm-dl-item">
              <span>{{ subsidyLabel }}</span>
              <b>¥{{ breakdown.platformSubsidy.toFixed(2) }}</b>
            </div>
            <div class="adm-dl-item">
              <span>卖家实收</span>
              <b>¥{{ breakdown.sellerIncome.toFixed(2) }}</b>
            </div>
            <div class="adm-dl-item">
              <span>让利力度</span>
              <b>{{ breakdown.onPromo ? breakdown.discountLabel : '未参与活动' }}</b>
            </div>
          </div>
          <p class="gp-note">
            恒等式：买家实付 + 卖家让利 + 平台补贴 = 挂牌价（¥{{ breakdown.listPrice.toFixed(2) }}）；
            卖家实收 = 挂牌价 − 卖家让利。
          </p>
        </div>

        <div class="gp-block">
          <div class="gp-block-title">
            商品描述
          </div>
          <p class="gp-desc">
            {{ detail.description }}
          </p>
        </div>

        <div class="gp-block">
          <div class="gp-block-title">
            交易信息
          </div>
          <div class="adm-dl">
            <div class="adm-dl-item">
              <span>可售数量</span>
              <b>{{ stockText(detail) }}</b>
            </div>
            <div class="adm-dl-item">
              <span>交易方式</span>
              <b>{{ deliveryLabel(detail.deliveryMethod) }}</b>
            </div>
            <div class="adm-dl-item">
              <span>浏览 / 收藏</span>
              <b>{{ detail.viewCount }} / {{ detail.favoriteCount }}</b>
            </div>
            <div class="adm-dl-item">
              <span>商品编号</span>
              <b>#{{ detail.id }}</b>
            </div>
          </div>
        </div>

        <div class="gp-block">
          <div class="gp-block-title">
            卖家
          </div>
          <div class="gp-seller">
            <el-avatar
              :src="detail.sellerAvatar"
              :size="40"
            />
            <div class="gp-seller-txt">
              <span class="adm-strong">{{ detail.sellerName }}</span>
              <span class="adm-sub">发布 {{ detail.favoriteCount }} 次收藏 · 商品编号 #{{ detail.id }}</span>
            </div>
          </div>
        </div>

        <div class="gp-ops">
          <el-button
            v-if="detail.status === 'pending'"
            type="success"
            @click="onApprove(detail)"
          >
            通过审核
          </el-button>
          <el-button
            v-if="detail.status === 'pending'"
            type="danger"
            plain
            @click="onReject(detail)"
          >
            拒绝
          </el-button>
          <el-button
            v-if="detail.status === 'on_sale'"
            type="warning"
            plain
            @click="onChange(detail, 'off_shelf', '已下架')"
          >
            下架
          </el-button>
          <el-button
            v-if="detail.status === 'off_shelf'"
            type="primary"
            plain
            @click="onChange(detail, 'on_sale', '已重新上架')"
          >
            重新上架
          </el-button>
          <el-button
            type="danger"
            text
            @click="onDelete(detail, true)"
          >
            删除商品
          </el-button>
        </div>
      </div>
      <el-empty
        v-else
        description="商品不存在或已删除"
      />
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, onActivated, onUnmounted, ref } from 'vue'
import {
  batchDeleteGoods,
  batchUpdateGoodsStatus,
  deleteGoods,
  fetchGoods,
  GOODS_STATUS_LABEL,
  updateGoodsStatus
} from '@/api/goods'
import { reviewGoods } from '@/api/goodsAudit'
import { formatDate } from '@/utils/format'
import { settlePrice } from '@/utils/promo'
import { deliveryLabel, stockText } from '@/utils/goods'
import { releaseOverlayFocus } from '@/utils/focus'
import type { Goods } from '@/types'
import { ADMIN_CONTEXT } from '../adminContext'

const admin = inject(ADMIN_CONTEXT)
const overview = computed(() => admin?.overview.value ?? null)

const rows = ref<Goods[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(10)
const kw = ref('')
// 默认筛「待审核」：这个页签的职责就是审货，打开就该看到待办队列，
// 且与侧栏「商品审核 N」角标同口径（此前默认全部状态，待办的散落在后面几页，
// 角标写 10、第一页只看到 2 件，被误以为数字对不上）
const status = ref('pending')
const loading = ref(false)
const selected = ref<Goods[]>([])
const tableRef = ref<{ clearSelection: () => void }>()

/** 详情抽屉 */
const detailVisible = ref(false)
const detail = ref<Goods | null>(null)
const breakdown = computed(() =>
  detail.value
    ? settlePrice(detail.value)
    : {
        listPrice: 0,
        payAmount: 0,
        sellerCut: 0,
        platformSubsidy: 0,
        sellerIncome: 0,
        discountLabel: '',
        onPromo: false,
        fundSource: 'seller' as const
      }
)

/*
 * 让利 / 补贴两项的说明文字必须跟着实际情况走：
 * 商品没参加活动时不存在「出资方」，硬写「本次活动出资方」会让人以为有让利 ——
 * 出资方只在让利真实发生（onPromo）时才有意义。
 */
const sellerCutLabel = computed(() => {
  if (!breakdown.value.onPromo) return '卖家让利（未参与活动）'
  return breakdown.value.fundSource === 'seller' ? '卖家让利（本次活动出资方）' : '卖家让利（非出资方）'
})
const subsidyLabel = computed(() => {
  if (!breakdown.value.onPromo) return '平台补贴（未参与活动）'
  return breakdown.value.fundSource === 'platform' ? '平台补贴（本次活动出资方）' : '平台补贴（非出资方）'
})

function statusTag(s: Goods['status']): 'success' | 'warning' | 'info' | 'danger' {
  return ({ on_sale: 'success', pending: 'warning', sold: 'info', off_shelf: 'danger' } as const)[s]
}

/*
 * 后台价格列只做「对账」用途，所以两个价格都要露出来：
 *   主数字 = 实付价（有让利才是让利价，否则等于挂牌价）
 *   划线小字 = 卖家挂牌价
 * 审核时能一眼看出该商品的让利金额是否与活动规则吻合。
 */
function priceInfo(g: Goods) {
  const b = settlePrice(g)
  return { pay: b.payAmount, list: b.listPrice, onPromo: b.onPromo }
}

function openDetail(g: Goods) {
  detail.value = g
  detailVisible.value = true
}

/**
 * 行点击打开详情；但点勾选框或操作列时不应打开 ——
 * 那两个位置的点击有自己的语义（批量选择 / 处置）。
 *
 * column 只读两个字段：用最小结构声明，不引入 element-plus 的
 * TableColumnCtx 内部类型（它的泛型在各版本间不稳定）。
 */
function onRowClick(row: Goods, column: { type?: string; label?: string } | null) {
  if (column?.type === 'selection' || column?.label === '操作') return
  openDetail(row)
}

/* 输入即搜：加 300ms 防抖，避免每敲一个字都打一次接口 */
let searchTimer: ReturnType<typeof setTimeout> | null = null
function onSearchInput() {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    page.value = 1
    reload()
  }, 300)
}
onUnmounted(() => {
  if (searchTimer) clearTimeout(searchTimer)
})

function onFilterChange() {
  page.value = 1
  reload()
}

/** el-table 的 selection-change 只保证 DefaultRow[]，收到后收窄成 Goods[] */
function onSelectionChange(list: unknown[]) {
  selected.value = list as Goods[]
}

function clearSelection() {
  tableRef.value?.clearSelection()
  selected.value = []
}

async function reload() {
  loading.value = true
  try {
    const r = await fetchGoods({
      page: page.value,
      pageSize: pageSize.value,
      keyword: kw.value,
      status: status.value || undefined
    })
    rows.value = r.list
    total.value = r.total
    clearSelection()
  } finally {
    loading.value = false
  }
}

async function onChange(row: Goods, next: Goods['status'], okText: string) {
  await updateGoodsStatus({ id: row.id, status: next })
  // 抽屉里直接改状态时，抽屉内的展示要立刻跟上，否则标题还是旧状态
  if (detail.value?.id === row.id) detail.value.status = next
  ElMessage.success(okText)
  await Promise.all([reload(), admin?.refreshOverview()])
}

/**
 * 通过审核：走 reviewGoods 这一**唯一审核入口**（POST /api/review/goods/{id}/review）。
 * 不能直接用 onChange→updateGoodsStatus，因为 GoodsService 对「pending→on_sale」有
 * 一条面向所有角色的挡板，会把管理员在后台的通过操作也拦下来。reviewGoods 只要求
 * 「必须 pending」并写入审核记录，正是后台商品管理页该用的通道。
 */
async function onApprove(row: Goods) {
  await reviewGoods({ goodsId: row.id, action: 'approve' })
  // 抽屉内展示要立刻跟上（与 onChange 同口径）
  if (detail.value?.id === row.id) detail.value.status = 'on_sale'
  ElMessage.success('已通过审核')
  await Promise.all([reload(), admin?.refreshOverview()])
}

/**
 * 拒绝审核：理由必填（≥5 字、≤500 字，与后端 GoodsAuditService 的
 * REASON_MIN / REASON_MAX 对齐）。同样收敛回 reviewGoods 唯一入口，
 * 不走 onChange→updateGoodsStatus（会被挡板拦）。
 *   - 用户取消 / 关闭 prompt：catch 后直接 return，不报错、不发请求。
 *   - 理由为空或不足 5 字：inputValidator 不让提交；即便绕过，下方也再拦一次。
 */
async function onReject(row: Goods) {
  let reason = ''
  try {
    const { value } = await ElMessageBox.prompt(
      `拒绝「${row.title}」的审核？请填写驳回理由（至少 5 字，将记入审核日志）。`,
      '拒绝审核',
      {
        type: 'warning',
        inputType: 'textarea',
        inputPlaceholder: '例如：实物与描述不符 / 图片含违规信息 / 价格异常…',
        inputValidator: (val) => {
          const v = (val ?? '').trim()
          if (!v) return '驳回理由不能为空'
          if (v.length < 5) return '驳回理由至少 5 个字'
          if (v.length > 500) return '驳回理由不能超过 500 字'
          return true
        }
      }
    )
    reason = (value ?? '').trim()
  } catch {
    // 用户取消或关闭弹窗，不报错、不发请求
    return
  }
  if (!reason || reason.length < 5) {
    ElMessage.warning('驳回理由至少 5 个字')
    return
  }
  await reviewGoods({ goodsId: row.id, action: 'reject', reason })
  // 抽屉内展示要立刻跟上（reject → off_shelf）
  if (detail.value?.id === row.id) detail.value.status = 'off_shelf'
  ElMessage.success('已拒绝')
  await Promise.all([reload(), admin?.refreshOverview()])
}

async function onDelete(row: Goods, fromDetail = false) {
  try {
    await ElMessageBox.confirm(`确认删除「${row.title}」？删除后不可恢复。`, '危险操作', { type: 'error' })
  } catch {
    return
  }
  await deleteGoods(row.id)
  if (fromDetail) {
    detailVisible.value = false
    detail.value = null
  }
  ElMessage.success('已删除')
  await Promise.all([reload(), admin?.refreshOverview()])
}

async function onBatchStatus(next: Goods['status']) {
  const ids = selected.value.map((g) => g.id)
  if (!ids.length) return
  const label = GOODS_STATUS_LABEL[next] ?? next
  try {
    await ElMessageBox.confirm(`确认将选中的 ${ids.length} 件商品批量置为「${label}」？`, '批量操作')
  } catch {
    return
  }
  const n = await batchUpdateGoodsStatus(ids, next)
  ElMessage.success(`已更新 ${n} 件商品`)
  await Promise.all([reload(), admin?.refreshOverview()])
}

async function onBatchDelete() {
  const ids = selected.value.map((g) => g.id)
  if (!ids.length) return
  try {
    await ElMessageBox.confirm(`确认删除选中的 ${ids.length} 件商品？该操作不可恢复。`, '危险操作', { type: 'error' })
  } catch {
    return
  }
  const n = await batchDeleteGoods(ids)
  ElMessage.success(`已删除 ${n} 件商品`)
  await Promise.all([reload(), admin?.refreshOverview()])
}

onActivated(reload)
</script>

<style scoped lang="scss">
/* 划线挂牌价：弱化到「参考信息」层级，不与实付价抢注意力 */
.origin {
  display: block;
  font-size: 11px;
  color: $text-4;
  font-variant-numeric: tabular-nums;
}

/* 热度两行小字：省掉约 40px 列宽，窄屏也不至于把商品列挤没 */
.heat {
  display: flex;
  flex-direction: column;
  gap: 1px;
  font-size: 12px;
  color: var(--color-text-mute);
  font-variant-numeric: tabular-nums;
  line-height: 1.35;
}

.gp-tip {
  margin: 0 0 10px;
  font-size: $fs-12;
  color: var(--color-text-mute);
}

/* 整行可点：给出手型光标，否则「点击行看详情」无从发现 */
:deep(.gp-row) {
  cursor: pointer;

  &:hover .gp-open {
    color: $brand-orange;
  }
}

.gp-open {
  transition: color $dur-fast $ease-out;
}

/* ---------- 详情抽屉 ---------- */
.gp-detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: $sp-3;
}

.gp-detail-title {
  font-size: $fs-16;
  font-weight: $fw-semibold;
  color: var(--color-text-primary);
}

.gp-cover {
  position: relative;
  border-radius: $radius-md;
  overflow: hidden;
  background: var(--bg-soft);
}

.gp-cover-img {
  display: block;
  width: 100%;
  aspect-ratio: 4 / 3;
}

.gp-cover-tag {
  position: absolute;
  top: 10px;
  left: 10px;
}

.gp-name {
  margin: $sp-3 0 4px;
  font-size: $fs-16;
  font-weight: $fw-semibold;
  line-height: 1.45;
  color: var(--color-text-primary);
}

.gp-meta {
  margin: 0;
  font-size: $fs-12;
  color: var(--color-text-mute);
}

.gp-thumbs {
  display: flex;
  gap: $sp-2;
  margin-top: $sp-3;
  overflow-x: auto;
}

.gp-thumb {
  width: 64px;
  height: 64px;
  flex-shrink: 0;
  border-radius: $radius-sm;
  background: var(--bg-soft);
}

.gp-block {
  margin-top: $sp-4;
}

.gp-block-title {
  margin-bottom: $sp-2;
  font-size: $fs-13;
  font-weight: $fw-semibold;
  color: var(--color-text-secondary);
}

.gp-note {
  margin: $sp-2 0 0;
  font-size: $fs-11;
  line-height: 1.6;
  color: $text-4;
}

.gp-desc {
  margin: 0;
  padding: 10px 14px;
  border-radius: $radius-sm;
  background: var(--bg-soft);
  border: 1px solid var(--border-color);
  font-size: $fs-13;
  line-height: 1.7;
  color: var(--color-text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
}

.gp-seller {
  display: flex;
  align-items: center;
  gap: $sp-3;
}

.gp-seller-txt {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.gp-ops {
  display: flex;
  flex-wrap: wrap;
  gap: $sp-2;
  margin: $sp-5 0 $sp-2;
  padding-top: $sp-4;
  border-top: 1px solid var(--border-color);
}

/* 抽屉内的价格强调色：涨价红、让利橙（与前台价格口径一致） */
:deep(.adm-dl-item b.is-price) {
  color: $brand-orange;
}
</style>
