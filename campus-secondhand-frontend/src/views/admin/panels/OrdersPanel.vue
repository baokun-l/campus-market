<template>
  <div class="adm-pane">
    <!-- ===================================================================
      1. 工作台 KPI：先看「有没有要处理的」，再看流水
         —— 后台打开第一眼该看到的是待办，而不是一串好看的成交额
    =================================================================== -->
    <div class="adm-kpi-grid od-kpi-grid">
      <div class="adm-kpi is-hero">
        <span class="adm-kpi-label"><el-icon><Money /></el-icon>累计成交额</span>
        <b class="adm-kpi-value">¥{{ money(stats?.gmv) }}</b>
        <span class="adm-kpi-foot">
          在途待结算 ¥{{ money(stats?.pendingGmv) }} · 已退款 ¥{{ money(stats?.refundedAmount) }}
        </span>
      </div>

      <div
        class="adm-kpi is-clickable"
        :class="{ 'is-on': q.onlyTodo }"
        @click="toggleQuick('onlyTodo')"
      >
        <span class="adm-kpi-label"><el-icon><Bell /></el-icon>待处理</span>
        <b class="adm-kpi-value">{{ stats?.todo ?? 0 }}</b>
        <span class="adm-kpi-foot">待付款 / 待发货 / 售后中 · 点击只看这些</span>
      </div>

      <div
        class="adm-kpi is-clickable"
        :class="{ 'is-on': q.onlyIssue, 'is-alert': (stats?.issues ?? 0) > 0 }"
        @click="toggleQuick('onlyIssue')"
      >
        <span class="adm-kpi-label"><el-icon><AlarmClock /></el-icon>超时异常</span>
        <b class="adm-kpi-value">{{ stats?.issues ?? 0 }}</b>
        <span class="adm-kpi-foot">已越过服务时限 · 点击只看这些</span>
      </div>

      <div class="adm-kpi">
        <span class="adm-kpi-label"><el-icon><Calendar /></el-icon>今日新增</span>
        <b class="adm-kpi-value">{{ stats?.todayCount ?? 0 }}</b>
        <span class="adm-kpi-foot">共 {{ stats?.total ?? 0 }} 单 · 今日 0 点起算</span>
      </div>
    </div>

    <!-- ===================================================================
      2. 状态总览：6 张可点卡片，点一下等于「按该状态筛选」
         比下拉框更直观 —— 下拉框看不到每个状态有多少单
    =================================================================== -->
    <div class="od-pills">
      <button
        v-for="g in stats?.groups ?? []"
        :key="g.key"
        type="button"
        class="od-pill"
        :class="[`is-${g.tone}`, { 'is-on': isGroupOn(g.key) }]"
        @click="pickGroup(g)"
      >
        <span class="od-pill-label">{{ g.label }}</span>
        <b class="od-pill-count">{{ g.count }}</b>
        <span class="od-pill-amt">¥{{ money(g.amount) }}</span>
      </button>
    </div>

    <div class="adm-card">
      <div class="adm-card-head">
        <span class="adm-card-title">订单管理</span>
        <span class="adm-card-hint">
          当前筛选 <b>{{ total }}</b> 单
          <template v-if="activeFilterCount"> · 已启用 {{ activeFilterCount }} 个条件</template>
        </span>
        <div class="od-head-ops">
          <el-button
            text
            type="primary"
            :disabled="!total"
            @click="onExport"
          >
            <el-icon><Download /></el-icon>&nbsp;导出当前筛选
          </el-button>
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

      <div class="adm-card-body">
        <!-- ============ 工具栏 ============ -->
        <div class="adm-toolbar">
          <div class="adm-toolbar-left">
            <el-input
              v-model="q.keyword"
              class="adm-input"
              placeholder="订单号 / 商品 / 买家 / 卖家 / 运单号"
              clearable
              @input="onSearchInput"
              @clear="onFilterChange"
              @keyup.enter="onFilterChange"
            />
            <el-select
          :teleported="false"
              v-model="q.status"
              class="adm-select"
              clearable
              placeholder="全部状态"
              @change="onStatusChange"
            >
              <el-option
                v-for="(label, val) in ORDER_STATUS_LABEL"
                :key="val"
                :label="label"
                :value="val"
              />
            </el-select>
            <el-select
          :teleported="false"
              v-model="q.sort"
              class="adm-select"
              @change="onFilterChange"
            >
              <el-option
                label="下单时间（新→旧）"
                value="time_desc"
              />
              <el-option
                label="下单时间（旧→新）"
                value="time_asc"
              />
              <el-option
                label="金额（高→低）"
                value="amount_desc"
              />
              <el-option
                label="金额（低→高）"
                value="amount_asc"
              />
            </el-select>
          </div>
          <div class="adm-toolbar-right">
            <el-button
              text
              type="primary"
              @click="advOpen = !advOpen"
            >
              <el-icon><Filter /></el-icon>&nbsp;{{ advOpen ? '收起筛选' : '高级筛选' }}
              <template v-if="activeFilterCount">
                &nbsp;({{ activeFilterCount }})
              </template>
            </el-button>
            <el-button
              text
              :disabled="!activeFilterCount"
              @click="resetFilters"
            >
              重置
            </el-button>
          </div>
        </div>

        <!-- ============ 高级筛选 ============ -->
        <div
          v-show="advOpen"
          class="od-adv"
        >
          <div class="od-adv-row">
            <span class="od-adv-label">下单时间</span>
            <el-date-picker
              :teleported="false"
              v-model="dateRange"
              type="daterange"
              unlink-panels
              range-separator="至"
              start-placeholder="开始日期"
              end-placeholder="结束日期"
              value-format="YYYY-MM-DD"
              @change="onFilterChange"
            />
          </div>
          <div class="od-adv-row">
            <span class="od-adv-label">实付金额</span>
            <el-input-number
              v-model="q.minAmount"
              :min="0"
              :controls="false"
              placeholder="最低"
              class="od-adv-num"
              @change="onFilterChange"
            />
            <span class="od-adv-sep">—</span>
            <el-input-number
              v-model="q.maxAmount"
              :min="0"
              :controls="false"
              placeholder="最高"
              class="od-adv-num"
              @change="onFilterChange"
            />
            <span class="od-adv-label od-adv-label--gap">让利归属</span>
            <el-select
          :teleported="false"
              v-model="q.fundSource"
              clearable
              placeholder="全部"
              class="od-adv-select"
              @change="onFilterChange"
            >
              <el-option
                label="卖家让利"
                value="seller"
              />
              <el-option
                label="平台补贴"
                value="platform"
              />
            </el-select>
          </div>
          <div class="od-adv-row">
            <span class="od-adv-label">只看</span>
            <el-checkbox
              v-model="q.onlyTodo"
              @change="onFilterChange"
            >
              待处理
            </el-checkbox>
            <el-checkbox
              v-model="q.onlyIssue"
              @change="onFilterChange"
            >
              超时异常
            </el-checkbox>
            <el-checkbox
              v-model="q.onlyRemark"
              @change="onFilterChange"
            >
              买家有备注
            </el-checkbox>
            <el-checkbox
              v-model="q.onlyNoted"
              @change="onFilterChange"
            >
              后台有备注
            </el-checkbox>
          </div>
        </div>

        <!-- ============ 批量操作条：没有勾选时不占位 ============ -->
        <div
          v-if="selected.length"
          class="adm-batch"
        >
          已选 <b>{{ selected.length }}</b> 单
          <div class="adm-batch-ops">
            <el-button
              size="small"
              type="primary"
              plain
              @click="onBatch('mark_paid')"
            >
              批量标记付款
            </el-button>
            <el-button
              size="small"
              type="success"
              plain
              @click="onBatchShip"
            >
              批量发货
            </el-button>
            <el-button
              size="small"
              type="danger"
              plain
              @click="onBatch('close')"
            >
              批量关闭
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

        <!-- ============ 列表 ============ -->
        <el-table
          ref="tableRef"
          v-loading="loading"
          :data="orders"
          row-key="id"
          style="width: 100%"
          empty-text="没有符合条件的订单"
          row-class-name="od-row"
          @row-click="onRowClick"
          @selection-change="onSelectionChange"
        >
          <!-- 勾选排除已终结的单：勾了也没法处置，只会让批量操作报「跳过」 -->
          <el-table-column
            type="selection"
            width="46"
            :selectable="canSelect"
          />
          <el-table-column type="expand">
            <template #default="{ row }">
              <div class="order-detail">
                <div class="adm-dl">
                  <div class="adm-dl-item">
                    <span>收货地址</span><b>{{ (row as Order).address || '—' }}</b>
                  </div>
                  <div class="adm-dl-item">
                    <span>运单号</span>
                    <b>
                      {{ (row as Order).trackingNo ? `${(row as Order).logisticsCompany ?? ''} ${(row as Order).trackingNo}`.trim() : '尚未发货' }}
                    </b>
                  </div>
                  <div class="adm-dl-item">
                    <span>买家备注</span><b>{{ (row as Order).remark || '无' }}</b>
                  </div>
                  <div class="adm-dl-item">
                    <span>后台备注</span>
                    <b
                      v-if="(row as Order).adminNote"
                      class="od-note-flag"
                    >{{ (row as Order).adminNote }}</b>
                    <b
                      v-else
                      class="adm-muted"
                    >未填写</b>
                  </div>
                </div>
                <ol class="timeline">
                  <li
                    v-for="n in timelineOf(row as Order)"
                    :key="n.label"
                  >
                    <span
                      class="dot"
                      :class="{ done: n.time }"
                    />
                    <span class="tl-label">{{ n.label }}</span>
                    <span class="tl-time">{{ n.time ? formatDate(n.time, 'YYYY-MM-DD HH:mm') : '—' }}</span>
                  </li>
                </ol>
              </div>
            </template>
          </el-table-column>
          <el-table-column
            label="订单号"
            width="100"
          >
            <template #default="{ row }">
              <div class="adm-media-txt">
                <span class="adm-id">{{ (row as Order).id }}</span>
                <span class="adm-sub adm-num">
                  {{ formatDate((row as Order).createTime, 'MM-DD HH:mm') }}
                </span>
              </div>
            </template>
          </el-table-column>
          <el-table-column
            label="商品"
            min-width="190"
          >
            <template #default="{ row }">
              <div class="adm-media">
                <el-image
                  :src="(row as Order).goods.cover"
                  fit="cover"
                  class="adm-thumb adm-thumb--sm"
                />
                <div class="adm-media-txt">
                  <!-- 与商品审核面板同一套交互：点商品名开详情，不用先去右边找「详情」 -->
                  <span
                    class="adm-ellipsis adm-strong od-open"
                    title="查看订单详情"
                    @click.stop="openDrawer(row as Order)"
                  >
                    {{ (row as Order).goods.title }}
                  </span>
                  <span class="adm-sub">
                    卖家 {{ (row as Order).sellerName || '#' + (row as Order).sellerId }}
                    <template v-if="(row as Order).quantity"> · ×{{ (row as Order).quantity }}</template>
                  </span>
                </div>
              </div>
            </template>
          </el-table-column>
          <el-table-column
            label="实付金额"
            width="128"
            align="right"
          >
            <template #default="{ row }">
              <span class="adm-price">¥{{ (row as Order).amount.toFixed(2) }}</span>
              <!--
                退款/对账时要能一眼看出这单让利是谁出的钱。
                老订单没有快照 → savedOf() 返回 0，这一行自然不渲染。
              -->
              <span
                v-if="savedOf(row as Order) > 0"
                class="order-cut"
              >
                挂牌 ¥{{ ((row as Order).listPrice ?? (row as Order).amount).toFixed(2) }}
                · {{ (row as Order).fundSource ? FUND_SOURCE_LABEL[(row as Order).fundSource!] : '让利' }}
              </span>
            </template>
          </el-table-column>
          <el-table-column
            label="买家"
            width="96"
          >
            <template #default="{ row }">
              <span class="adm-ellipsis">{{ (row as Order).buyerName || '#' + (row as Order).buyerId }}</span>
            </template>
          </el-table-column>
          <el-table-column
            label="状态"
            width="140"
            align="center"
          >
            <template #default="{ row }">
              <div class="od-status-cell">
                <el-tag
                  :type="ORDER_STATUS_TAG[(row as Order).status]"
                  effect="light"
                  size="small"
                >
                  {{ ORDER_STATUS_LABEL[(row as Order).status] }}
                </el-tag>
                <!--
                  超时标记直接进列表：否则要靠人一单单点开才发现，等于没有提醒。
                  列里只放短结论（「超时未发货」），等了多少时间走 tooltip ——
                  带时长那句有 10 个字，塞进这一列会被挤成两行。
                -->
                <el-tooltip
                  v-if="issueOf(row as Order)"
                  :content="`已等待 ${Math.floor(issueOf(row as Order)!.hours)} 小时，请在详情里处置`"
                  placement="top"
                >
                  <el-tag
                    :type="issueOf(row as Order)!.level === 'danger' ? 'danger' : 'warning'"
                    effect="plain"
                    size="small"
                    class="od-issue"
                  >
                    {{ issueOf(row as Order)!.shortText }}
                  </el-tag>
                </el-tooltip>
              </div>
            </template>
          </el-table-column>
          <el-table-column
            label="备注"
            width="46"
            align="center"
          >
            <template #default="{ row }">
              <!-- 「有备注」是个高价值信号（买家提了要求 / 同事留了风险标注），列表中要能看见 -->
              <el-tooltip
                v-if="(row as Order).adminNote || (row as Order).remark"
                :content="[(row as Order).adminNote ? `后台：${(row as Order).adminNote}` : '', (row as Order).remark ? `买家：${(row as Order).remark}` : ''].filter(Boolean).join(' / ')"
                placement="top"
              >
                <el-icon
                  class="od-note-ico"
                  :class="{ 'is-admin': !!(row as Order).adminNote }"
                >
                  <ChatLineSquare />
                </el-icon>
              </el-tooltip>
              <span
                v-else
                class="adm-muted"
              >—</span>
            </template>
          </el-table-column>
          <!--
            列表只保留「详情」入口：状态流转是关键写操作，统一收进详情抽屉里做，
            行内一排「完成 / 退款」既挤又容易误点（已完成还能点退款的事故就是这么来的）
          -->
          <el-table-column
            label="操作"
            width="96"
            fixed="right"
            align="center"
          >
            <template #default="{ row }">
              <el-button
                text
                type="primary"
                size="small"
                @click.stop="openDrawer(row as Order)"
              >
                详情
              </el-button>
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

    <!--
      订单详情抽屉（子页面）：信息 + 状态流转 + 操作日志 + 售后 + 备注，全在这一个地方。
      操作按钮由状态机（ORDER_TRANSITIONS）生成 —— 只出现「合法的下一步」。
    -->
    <OrderDetailDrawer
      v-model="drawerVisible"
      :order="current"
      @changed="onOrderChanged"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, inject, onActivated, onUnmounted, reactive, ref } from 'vue'
import {
  ORDER_STATUS_LABEL,
  ORDER_STATUS_TAG,
  ORDER_OVERVIEW_GROUPS,
  fetchAdminOrderStats,
  fetchAdminOrders,
  fetchAdminOrdersForExport,
  orderIssueOf,
  type AdminOrderQuery,
  type AdminOrderStats,
  batchOrderAction,
  type BatchOrderAction
} from '@/api/order'
import { formatDate } from '@/utils/format'
import { FUND_SOURCE_LABEL } from '@/utils/promo'
import { csvFileName, downloadCsv } from '@/utils/csv'
import type { Order } from '@/types'
import { ADMIN_CONTEXT } from '../adminContext'
import OrderDetailDrawer from './orders/OrderDetailDrawer.vue'

const admin = inject(ADMIN_CONTEXT)

const orders = ref<Order[]>([])
const stats = ref<AdminOrderStats | null>(null)
const total = ref(0)
const page = ref(1)
const pageSize = ref(10)
const loading = ref(false)
const advOpen = ref(false)
const selected = ref<Order[]>([])
const tableRef = ref<{ clearSelection: () => void }>()

/**
 * 筛选条件收在一个对象里，而不是散成 9 个 ref。
 *
 * 散着写有两个必然的坑：
 *   ① 重置时要一个一个清，漏掉一个就会出现「重置了但还是筛不出来」；
 *   ② 传给接口时要手写一遍映射，某个条件忘了传就静默失效（看起来「筛选没反应」）。
 * 现在「重置 = 恢复默认对象」「查询 = 展开这个对象」，两边都不可能漏。
 */
const DEFAULT_QUERY = {
  keyword: '',
  status: '' as '' | Order['status'],
  /** 状态卡用的多状态白名单（如「售后中」= 退款中 + 已取消），与 status 互斥 */
  statusIn: [] as Order['status'][],
  sort: 'time_desc' as NonNullable<AdminOrderQuery['sort']>,
  minAmount: undefined as number | undefined,
  maxAmount: undefined as number | undefined,
  fundSource: '' as '' | 'seller' | 'platform',
  onlyTodo: false,
  onlyIssue: false,
  onlyRemark: false,
  onlyNoted: false
}
const q = reactive({ ...DEFAULT_QUERY })
const dateRange = ref<[string, string] | null>(null)

/** 已启用的筛选条件数（不含排序）：给工具栏一个「你现在筛过的」提示 */
const activeFilterCount = computed(() => {
  let n = 0
  if (q.keyword.trim()) n++
  if (q.status) n++
  if (q.statusIn.length) n++
  if (q.minAmount != null) n++
  if (q.maxAmount != null) n++
  if (q.fundSource) n++
  if (q.onlyTodo) n++
  if (q.onlyIssue) n++
  if (q.onlyRemark) n++
  if (q.onlyNoted) n++
  if (dateRange.value) n++
  return n
})

function buildQuery(extra: Partial<AdminOrderQuery> = {}): AdminOrderQuery {
  return {
    page: page.value,
    pageSize: pageSize.value,
    keyword: q.keyword.trim() || undefined,
    status: (q.status || undefined) as Order['status'] | undefined,
    statusIn: q.statusIn.length ? [...q.statusIn] : undefined,
    sort: q.sort,
    minAmount: q.minAmount,
    maxAmount: q.maxAmount,
    fundSource: (q.fundSource || undefined) as 'seller' | 'platform' | undefined,
    onlyTodo: q.onlyTodo || undefined,
    onlyIssue: q.onlyIssue || undefined,
    onlyRemark: q.onlyRemark || undefined,
    onlyNoted: q.onlyNoted || undefined,
    dateFrom: dateRange.value?.[0],
    dateTo: dateRange.value?.[1],
    ...extra
  }
}

/* ---------- 详情抽屉 ---------- */
const drawerVisible = ref(false)
const current = ref<Order | null>(null)

function openDrawer(row: Order) {
  current.value = row
  drawerVisible.value = true
}

/**
 * 整行可点开详情，与商品审核面板保持一致。
 *
 * 两处必须跳过，否则点了会出意外：
 *   - expand 列：那是「展开行」自己的开关，点它再弹抽屉等于一次点击两个动作；
 *   - 操作列：那格已经有「详情」按钮，让它自己处理，别叠一次。
 */
function onRowClick(row: Order, column: { type?: string; label?: string } | null) {
  if (column?.type === 'expand' || column?.type === 'selection' || column?.label === '操作') return
  openDrawer(row)
}

/** 抽屉里改过订单 → 列表与 KPI 一起刷新，并把抽屉换到最新那条 */
async function onOrderChanged() {
  await Promise.all([reload(), refreshStats(), admin?.refreshOverview()])
  current.value = orders.value.find((o) => o.id === current.value?.id) ?? current.value
}

function money(v?: number): string {
  return (v ?? 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/**
 * 本单让利金额 = 挂牌价 − 实付价（卖家让利 + 平台补贴之和）。
 * 老订单没有价格拆分快照，视为未让利，返回 0。
 */
function savedOf(o: Order): number {
  if (o.listPrice === undefined) return 0
  return Math.max(0, o.listPrice - o.amount)
}

function issueOf(o: Order) {
  return orderIssueOf(o)
}

function timelineOf(o: Order): Array<{ label: string; time?: string }> {
  return [
    { label: '下单', time: o.createTime },
    { label: '付款', time: o.payTime },
    { label: '发货', time: o.shipTime },
    { label: '收货', time: o.receiveTime },
    { label: '完成', time: o.completeTime },
    { label: '退款', time: o.refundTime }
  ]
}

/* ---------- 快捷筛选 ---------- */
/** KPI 卡上的「只看待处理 / 超时异常」开关：点开再点一次即取消 */
function toggleQuick(key: 'onlyTodo' | 'onlyIssue') {
  q[key] = !q[key]
  onFilterChange()
}

/** 当前列表是否正被某张状态卡筛着（用于卡片高亮） */
function isGroupOn(key: string): boolean {
  const want = statusesOfGroup(key)
  if (!want.length || q.statusIn.length !== want.length) return false
  return want.every((s) => q.statusIn.includes(s))
}

/**
 * 点状态卡 = 按该卡的状态白名单筛选。
 *
 * 卡片上的分组可能含多个状态（「售后中」= 退款中 + 已取消），而 `q.status`
 * 只能存一个值。所以走 `q.statusIn` 白名单，**不能用「只筛第一个状态」凑合**——
 * 卡片写着 3 单、点进去只有 2 单，用户只会认为数字是错的。
 *
 * ⚠️ 这里必须从**静态定义**取 `statuses`：早期版本直接把接口返回的 group 对象
 * 传进来取 `g.statuses.length`，而接口那时只下发了 key/label/count，
 * 于是每次点卡片都在控制台抛 `Cannot read properties of undefined (reading 'length')`，
 * 表现成「点了没反应」。现在两头都补：接口下发 `statuses`，这里再做一次兜底查表。
 */
function statusesOfGroup(key: string): Order['status'][] {
  return ORDER_OVERVIEW_GROUPS.find((x) => x.key === key)?.statuses ?? []
}

function pickGroup(g: { key: string; label: string; statuses?: Order['status'][] }) {
  if (isGroupOn(g.key)) {
    q.statusIn = []
  } else {
    q.statusIn = g.statuses?.length ? [...g.statuses] : statusesOfGroup(g.key)
    // 卡片与下拉是同一个维度，必须互斥，否则「筛选 2 个条件」里有一个是隐形的
    q.status = ''
  }
  onFilterChange()
}

/** 下拉选了单状态 → 清掉卡片白名单，保持「状态只有一个来源」 */
function onStatusChange() {
  q.statusIn = []
  onFilterChange()
}

/* ---------- 查询 ---------- */
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

function resetFilters() {
  // statusIn 是数组：必须换成新实例，否则与 DEFAULT_QUERY 共用引用，
  // 之后任何一次原地 push 都会把「默认值」污染掉，重置就不再是重置
  Object.assign(q, { ...DEFAULT_QUERY, statusIn: [] })
  dateRange.value = null
  page.value = 1
  reload()
}

async function reload() {
  loading.value = true
  try {
    const r = await fetchAdminOrders(buildQuery())
    orders.value = r.list
    total.value = r.total
    clearSelection()
  } finally {
    loading.value = false
  }
}

async function refreshStats() {
  stats.value = await fetchAdminOrderStats()
}

/* ---------- 批量操作 ---------- */
/**
 * 已终结的单不允许勾选。
 *
 * `completed` 与 `cancelled` 是状态机里的终态（`ORDER_TRANSITIONS` 为空），
 * 勾了也处置不了，只会让批量结果里多出一堆「跳过」提示。
 * 与其让用户勾完再被拒绝，不如一开始就勾不上。
 */
function canSelect(row: Order): boolean {
  return row.status !== 'completed' && row.status !== 'cancelled'
}

function onSelectionChange(list: unknown[]) {
  selected.value = list as Order[]
}

function clearSelection() {
  tableRef.value?.clearSelection()
  selected.value = []
}

async function onBatch(action: BatchOrderAction) {
  const ids = selected.value.map((o) => o.id)
  if (!ids.length) return
  const verb = action === 'mark_paid' ? '标记为已付款' : '关闭'
  try {
    await ElMessageBox.confirm(
      `确认将选中的 ${ids.length} 笔订单${verb}？状态不允许的会被自动跳过，逐条给出原因。`,
      `批量${verb}`,
      { type: 'warning' }
    )
  } catch {
    return
  }
  await runBatch(ids, action)
}

async function onBatchShip() {
  const ids = selected.value.map((o) => o.id)
  if (!ids.length) return
  let carrier: string
  try {
    const r = await ElMessageBox.prompt(
      `为选中的 ${ids.length} 笔「待发货」订单统一发货。运单号将按承运商 + 订单尾号自动生成，可在详情里逐个修改。`,
      '批量发货',
      {
        inputValue: '顺丰速运',
        inputPattern: /^.{2,10}$/,
        inputErrorMessage: '请填写承运商（2-10 字）',
        confirmButtonText: '确认发货'
      }
    )
    carrier = r.value
  } catch {
    return
  }
  await runBatch(ids, 'ship', { carrier })
}

async function runBatch(ids: string[], action: BatchOrderAction, options: { carrier?: string } = {}) {
  loading.value = true
  try {
    const r = await batchOrderAction(ids, action, options)
    if (r.skipped.length) {
      // 跳过原因必须逐条说清：只报「成功 N 笔」会让管理员以为全都处理了
      ElMessage.warning(`成功 ${r.ok} 笔，跳过 ${r.skipped.length} 笔（${r.skipped.slice(0, 2).map((s) => s.reason).join('；')}${r.skipped.length > 2 ? ' 等' : ''}）`)
    } else {
      ElMessage.success(`已处置 ${r.ok} 笔订单`)
    }
    await Promise.all([reload(), refreshStats(), admin?.refreshOverview()])
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '批量操作失败')
  } finally {
    loading.value = false
  }
}

/* ---------- 导出 ---------- */
/**
 * 导出的是**当前筛选的全部结果**，不是当前页。
 * 之前直接导出 `orders`（当页 10 条），用户筛了「只看售后」再导出，
 * 拿到的却是首页的 10 条无关订单 —— 这种错误只有打开 CSV 才发现。
 */
async function onExport() {
  loading.value = true
  try {
    const rows = await fetchAdminOrdersForExport(buildQuery())
    if (!rows.length) {
      ElMessage.warning('当前筛选没有可导出的订单')
      return
    }
    downloadCsv(
      csvFileName(`订单列表-${rows.length}单`),
      [
        { key: 'id', title: '订单号' },
        { key: 'status', title: '状态', format: (o: Order) => ORDER_STATUS_LABEL[o.status] },
        { key: 'createTime', title: '下单时间', format: (o: Order) => formatDate(o.createTime, 'YYYY-MM-DD HH:mm') },
        { key: 'title', title: '商品', format: (o: Order) => o.goods.title },
        { key: 'quantity', title: '数量', format: (o: Order) => o.quantity ?? 1 },
        { key: 'amount', title: '买家实付', format: (o: Order) => o.amount.toFixed(2) },
        { key: 'listPrice', title: '卖家挂牌价', format: (o: Order) => (o.listPrice ?? '').toString() },
        { key: 'fund', title: '让利归属', format: (o: Order) => (o.fundSource ? FUND_SOURCE_LABEL[o.fundSource] : '') },
        { key: 'buyer', title: '买家', format: (o: Order) => o.buyerName ?? `#${o.buyerId}` },
        { key: 'seller', title: '卖家', format: (o: Order) => o.sellerName ?? `#${o.sellerId}` },
        { key: 'trackingNo', title: '运单号', format: (o: Order) => `${o.logisticsCompany ?? ''} ${o.trackingNo ?? ''}`.trim() },
        { key: 'issue', title: '超时标记', format: (o: Order) => orderIssueOf(o)?.text ?? '' },
        { key: 'adminNote', title: '后台备注', format: (o: Order) => o.adminNote ?? '' },
        { key: 'remark', title: '买家备注', format: (o: Order) => o.remark ?? '' }
      ],
      rows
    )
    ElMessage.success(`已导出 ${rows.length} 单`)
  } finally {
    loading.value = false
  }
}

/**
 * 每次进入面板都拉一次。
 *
 * keep-alive 下 `onActivated` 是唯一的「回到这个页签」钩子；
 * 放在 setup 里只会跑一次，之后从别处切回来看到的是旧数据。
 */
onActivated(async () => {
  await Promise.all([reload(), refreshStats()])
})
</script>

<style scoped lang="scss">
/* ==================== KPI ==================== */
.od-kpi-grid {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

/* 可点的 KPI 卡：手上要有反应，否则「这张卡能点」无从发现 */
.adm-kpi.is-clickable {
  cursor: pointer;
  user-select: none;

  &:hover { border-color: $brand-orange-line; }
  &.is-on {
    border-color: $brand-orange;
    box-shadow: inset 0 0 0 1px rgba(255, 106, 0, 0.28);
    background: linear-gradient(135deg, #fff8f2 0%, #fff 70%);
  }
  /* 有异常时整张卡发红：这是唯一需要「打断」管理员的指标 */
  &.is-alert .adm-kpi-value { color: $color-danger; }
}

/* ==================== 状态总览 ==================== */
.od-pills {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 10px;
}
.od-pill {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 11px 13px;
  border: 1px solid var(--border-color);
  border-radius: $radius-md;
  background: var(--bg-card);
  cursor: pointer;
  text-align: left;
  font: inherit;
  transition: border-color $dur-slow $ease-out, box-shadow $dur-slow $ease-out, transform $dur-slow $ease-out;

  &:hover {
    border-color: var(--border-color-strong);
    box-shadow: $shadow-xs;
    transform: translateY(-2px);
  }
  &.is-on {
    border-color: $brand-orange;
    background: linear-gradient(135deg, #fff8f2 0%, #fff 70%);
  }

  .od-pill-label { font-size: $fs-12; color: var(--color-text-mute); }
  .od-pill-count {
    font-size: $fs-20;
    font-weight: $fw-bold;
    color: var(--color-text-primary);
    line-height: 1.1;
    font-variant-numeric: tabular-nums;
  }
  .od-pill-amt { font-size: $fs-11; color: $text-4; font-variant-numeric: tabular-nums; }

  /* 语气色只点在小圆点上，避免六张彩卡把页面搞花 */
  &.is-warn .od-pill-count { color: $color-warning; }
  &.is-danger .od-pill-count { color: $color-danger; }
  &.is-success .od-pill-count { color: $color-success; }
}

/* ==================== 头部 / 工具栏 ==================== */
.od-head-ops {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}

.od-adv {
  margin: 4px 0 14px;
  padding: 12px 14px;
  border: 1px solid var(--border-color);
  border-radius: $radius-sm;
  background: var(--bg-soft);
}
.od-adv-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;

  & + .od-adv-row { margin-top: 10px; }
}
.od-adv-label {
  font-size: $fs-12;
  color: var(--color-text-mute);
  flex-shrink: 0;
  min-width: 52px;

  &--gap { margin-left: 12px; min-width: 0; }
}
.od-adv-num { width: 120px; }
.od-adv-select { width: 130px; }
.od-adv-sep { color: $text-4; font-size: $fs-12; }

/* ==================== 列表 ==================== */
.od-status-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
}
/* 超时标记必须 display:block，否则 el-tag 的行内盒在窄列里会被截断成「…」 */
.od-issue {
  display: block;
  max-width: 100%;
}

.od-note-ico {
  color: var(--color-text-mute);
  cursor: help;

  &.is-admin { color: $brand-orange; }
}

.od-note-flag {
  color: $brand-orange-deep;
  font-weight: $fw-medium;
}

.order-detail {
  padding: 6px 14px 14px 52px;
  background: var(--bg-soft);
}

/* 订单时间线：只把「已发生的节点」点亮 */
.timeline {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 22px;
  margin: 12px 0 0;
  padding: 0;
  list-style: none;

  li {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: $fs-12;
  }

  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--border-color-strong);
    flex-shrink: 0;

    &.done { background: $color-primary; }
  }
  .tl-label { color: var(--color-text-mute); }
  .tl-time { color: var(--color-text-secondary); font-variant-numeric: tabular-nums; }
}

/* 实付价下方的一行「挂牌价 + 让利归属」，只做对账提示，不抢主数字 */
.order-cut {
  display: block;
  margin-top: 2px;
  font-size: $fs-11;
  color: $text-4;
  font-variant-numeric: tabular-nums;
  line-height: 1.4;
}

/* ==================== 交互 ==================== */
/* 整行可点：给出手型光标，否则「点击行看详情」无从发现 */
:deep(.od-row) {
  cursor: pointer;

  &:hover .od-open { color: $brand-orange; }
}

.od-open {
  transition: color $dur-fast $ease-out;
}

@media (max-width: $breakpoint-lg) {
  .od-kpi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .od-pills { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}

@media (max-width: $breakpoint-sm) {
  .od-kpi-grid { grid-template-columns: minmax(0, 1fr); }
  .od-pills { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .order-detail { padding-left: 14px; }
}
</style>
