<template>
  <div class="adm-pane">
    <!-- ============ 待办：点一下直达对应页签 ============ -->
    <div class="adm-todo">
      <button
        v-for="t in todos"
        :key="t.key"
        type="button"
        class="adm-todo-item"
        :class="{ 'is-active': t.value > 0 }"
        @click="goTab(t.key)"
      >
        <span
          class="adm-todo-ico"
          aria-hidden="true"
        >{{ t.emoji }}</span>
        <span class="adm-todo-txt">
          <span class="adm-todo-label">{{ t.label }}</span>
          <span class="adm-todo-value">{{ t.value }}</span>
        </span>
        <span class="adm-todo-go">{{ t.value > 0 ? '去处理 →' : '暂无' }}</span>
      </button>
    </div>

    <!-- ============ KPI ============ -->
    <div
      v-loading="loading || overviewLoading"
      class="adm-kpi-grid"
    >
      <div class="adm-kpi is-hero">
        <span class="adm-kpi-label">累计成交额（买家实付）</span>
        <b class="adm-kpi-value">¥{{ money(overview?.gmv) }}</b>
        <span class="adm-kpi-foot">今日 ¥{{ money(overview?.todayGmv) }}</span>
      </div>
      <div class="adm-kpi">
        <span class="adm-kpi-label">在售商品</span>
        <b class="adm-kpi-value">{{ overview?.onSaleTotal ?? 0 }}</b>
        <span class="adm-kpi-foot">
          共 {{ overview?.goodsTotal ?? 0 }} 件 · 待审核 {{ overview?.pendingGoods ?? 0 }} 件
        </span>
      </div>
      <div class="adm-kpi">
        <span class="adm-kpi-label">注册用户</span>
        <b class="adm-kpi-value">{{ overview?.userTotal ?? 0 }}</b>
        <span class="adm-kpi-foot">封禁 {{ overview?.bannedUsers ?? 0 }} 个</span>
      </div>
      <div class="adm-kpi">
        <span class="adm-kpi-label">累计订单</span>
        <b class="adm-kpi-value">{{ overview?.orderTotal ?? 0 }}</b>
        <span class="adm-kpi-foot">今日新增 {{ overview?.recentOrders ?? 0 }} 单</span>
      </div>
      <div class="adm-kpi">
        <span class="adm-kpi-label">进行中活动</span>
        <b class="adm-kpi-value">{{ overview?.activeActivities ?? 0 }}</b>
        <span class="adm-kpi-foot">前台 Banner 正在轮播</span>
      </div>
      <div class="adm-kpi">
        <span class="adm-kpi-label">待办合计</span>
        <b class="adm-kpi-value">{{ overview?.todoTotal ?? 0 }}</b>
        <span class="adm-kpi-foot">商品 + 用户 + 举报</span>
      </div>
    </div>

    <!--
      ============ 成交额对账 ============
      单看一个 GMV 数字，运营无法回答「活动期间平台到底掏了多少钱」。
      这里把 GMV 按资金来源拆开，并显式写出恒等式，财务可直接对账。
    -->
    <div class="adm-card">
      <div class="adm-card-head">
        <span class="adm-card-title">成交额构成（对账口径）</span>
        <span class="adm-card-hint">仅统计已付款订单</span>
      </div>
      <div class="adm-card-body">
        <div class="gmv-split">
          <div class="gmv-cell">
            <span class="gmv-label">挂牌价合计</span>
            <b class="gmv-value">¥{{ money(overview?.gmvListPrice) }}</b>
            <span class="gmv-note">卖家原本标价的总和</span>
          </div>
          <div class="gmv-cell">
            <span class="gmv-label">卖家让利</span>
            <b class="gmv-value is-cut">−¥{{ money(overview?.sellerCutTotal) }}</b>
            <span class="gmv-note">卖家自己承担，实收随之减少</span>
          </div>
          <div class="gmv-cell">
            <span class="gmv-label">平台补贴</span>
            <b class="gmv-value is-cut">−¥{{ money(overview?.platformSubsidyTotal) }}</b>
            <span class="gmv-note">平台出钱，卖家实收不变</span>
          </div>
          <div class="gmv-cell">
            <span class="gmv-label">卖家实收合计</span>
            <b class="gmv-value is-income">¥{{ money(overview?.sellerIncomeTotal) }}</b>
            <span class="gmv-note">挂牌价 − 卖家让利</span>
          </div>
        </div>

        <!-- 恒等式：让审核与财务一眼看出数字是否自洽 -->
        <p class="gmv-formula">
          对账恒等式：买家实付 <b>¥{{ money(overview?.gmv) }}</b>
          ＋ 卖家让利 <b>¥{{ money(overview?.sellerCutTotal) }}</b>
          ＋ 平台补贴 <b>¥{{ money(overview?.platformSubsidyTotal) }}</b>
          ＝ 挂牌价合计 <b>¥{{ money(overview?.gmvListPrice) }}</b>
          <span
            class="gmv-ok"
            :class="{ 'is-bad': !splitBalanced }"
          >
            {{ splitBalanced ? '✓ 已对平' : '✗ 存在偏差' }}
          </span>
        </p>
      </div>
    </div>

    <!-- ============ 趋势 + 分类 ============ -->
    <el-row :gutter="14">
      <el-col
        :xs="24"
        :lg="15"
      >
        <div class="adm-card">
          <div class="adm-card-head">
            <span class="adm-card-title">近 14 日访问与订单</span>
            <span class="adm-card-hint">PV / UV / 订单量</span>
          </div>
          <div class="adm-card-body">
            <LineChart
              :x-axis="trend.dates"
              :series="trend.series"
              :height="318"
            />
          </div>
        </div>
      </el-col>
      <el-col
        :xs="24"
        :lg="9"
      >
        <div class="adm-card">
          <div class="adm-card-head">
            <span class="adm-card-title">分类成交占比</span>
          </div>
          <div class="adm-card-body">
            <PieChart
              :data="pieData"
              :height="318"
              label-mode="legend"
            />
          </div>
        </div>
      </el-col>
    </el-row>

    <!-- ============ 热销榜 ============ -->
    <div class="adm-card">
      <div class="adm-card-head">
        <span class="adm-card-title">热销榜 TOP 8</span>
        <div class="adm-inline">
          <span class="adm-card-hint">按成交单数排序（仅统计已付款订单）</span>
          <el-button
            text
            type="primary"
            :loading="loading"
            @click="loadAll"
          >
            刷新数据
          </el-button>
        </div>
      </div>
      <div class="adm-card-body adm-card-body--flush">
        <el-table
          v-loading="loading"
          :data="hotRank"
          style="width: 100%"
          empty-text="暂无成交订单"
        >
          <el-table-column
            label="排名"
            width="72"
            align="center"
          >
            <template #default="{ $index }">
              <span
                class="rank"
                :class="`rank-${$index < 3 ? $index + 1 : 0}`"
              >{{ $index + 1 }}</span>
            </template>
          </el-table-column>
          <el-table-column
            label="商品"
            min-width="260"
          >
            <template #default="{ row }">
              <div class="adm-media">
                <el-image
                  :src="(row as HotGoodsRow).goods.cover"
                  fit="cover"
                  class="adm-thumb adm-thumb--sm"
                />
                <div class="adm-media-txt">
                  <span class="adm-ellipsis adm-strong">{{ (row as HotGoodsRow).goods.title }}</span>
                  <span class="adm-sub">浏览 {{ (row as HotGoodsRow).goods.viewCount }}</span>
                </div>
              </div>
            </template>
          </el-table-column>
          <el-table-column
            label="成交单数"
            width="120"
            align="center"
            sortable
            prop="soldCount"
          >
            <template #default="{ row }">
              <b class="adm-num">{{ (row as HotGoodsRow).soldCount }}</b> 单
            </template>
          </el-table-column>
          <el-table-column
            label="成交金额"
            width="140"
            align="right"
          >
            <template #default="{ row }">
              <span class="adm-price">¥{{ money((row as HotGoodsRow).amount) }}</span>
            </template>
          </el-table-column>
          <el-table-column
            label="挂牌价"
            width="110"
            align="right"
          >
            <template #default="{ row }">
              <span class="adm-num adm-muted">¥{{ (row as HotGoodsRow).goods.price.toFixed(2) }}</span>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, onActivated, ref } from 'vue'
import LineChart from '@/components/charts/LineChart.vue'
import PieChart from '@/components/charts/PieChart.vue'
import { fetchCategoryDistribution, fetchHotGoodsRank, fetchTrend } from '@/api/analytics'
import type { HotGoodsRow } from '@/api/analytics'
import { ADMIN_CONTEXT } from '../adminContext'

const admin = inject(ADMIN_CONTEXT)
const overview = computed(() => admin?.overview.value ?? null)
const overviewLoading = computed(() => admin?.overviewLoading.value ?? false)

const trend = ref<{ dates: string[]; series: Array<{ name: string; data: number[]; color: string }> }>({
  dates: [],
  series: []
})
const pieData = ref<Array<{ name: string; value: number }>>([])
const hotRank = ref<HotGoodsRow[]>([])
const loading = ref(false)

function money(v?: number): string {
  return (v ?? 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/**
 * 三口径是否对平：实付 + 卖家让利 + 平台补贴 === 挂牌价合计
 * 用 0.01 容差消除浮点累加误差，偏差一定是真问题（快照写错或漏算）。
 */
const splitBalanced = computed(() => {
  const o = overview.value
  if (!o) return true
  const sum = o.gmv + o.sellerCutTotal + o.platformSubsidyTotal
  return Math.abs(sum - o.gmvListPrice) < 0.01
})

const todos = computed(() => {
  const o = overview.value
  return [
    { key: 'goods', label: '待审核商品', value: o?.pendingGoods ?? 0, emoji: '📦' },
    // 待审核用户已随 D11 拆除（2026-09-23）：用户注册即 active，不再有待办
    { key: 'reports', label: '待处理举报', value: o?.pendingReports ?? 0, emoji: '🚩' }
  ]
})

function goTab(key: string) {
  admin?.goTab(key)
}

async function loadAll() {
  loading.value = true
  try {
    const [t, p, hot] = await Promise.all([
      fetchTrend(14),
      fetchCategoryDistribution(),
      fetchHotGoodsRank(8)
    ])
    trend.value = {
      dates: t.map((x) => x.date),
      series: [
        { name: 'PV', data: t.map((x) => x.pv), color: '#2563eb' },
        { name: 'UV', data: t.map((x) => x.uv), color: '#7c3aed' },
        { name: '订单', data: t.map((x) => x.orders), color: '#ff6a00' }
      ]
    }
    pieData.value = p
    hotRank.value = hot
  } finally {
    loading.value = false
  }
}

// 面板被 keep-alive 缓存，onActivated 在首次挂载与每次切回来时都会触发，
// 所以只用它加载即可（不会像 onMounted + onActivated 那样重复请求两次）。
onActivated(async () => {
  await Promise.all([loadAll(), admin?.refreshOverview()])
})
</script>

<style scoped lang="scss">
/* 榜单名次：前三名给金银铜，其余保持安静 */
.rank {
  display: inline-grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: $radius-sm;
  background: var(--bg-soft);
  color: var(--color-text-mute);
  font-size: $fs-12;
  font-weight: $fw-bold;
  font-variant-numeric: tabular-nums;

  &.rank-1 {
    background: linear-gradient(135deg, #fde68a, #f59e0b);
    color: #7c2d12;
  }
  &.rank-2 {
    background: linear-gradient(135deg, #e5e7eb, #9ca3af);
    color: #374151;
  }
  &.rank-3 {
    background: linear-gradient(135deg, #fed7aa, #ea580c);
    color: #7c2d12;
  }
}

/* ============================================================
   成交额构成：4 格对账 + 底部恒等式
   数字用 tabular-nums，四列对齐后能一眼看出量级关系
   ============================================================ */
.gmv-split {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}

.gmv-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 16px;
  border: 1px solid var(--border-color);
  border-radius: $radius-md;
  background: var(--bg-soft);

  .gmv-label {
    font-size: $fs-12;
    color: var(--color-text-mute);
  }
  .gmv-value {
    font-size: $fs-20;
    font-weight: $fw-bold;
    color: var(--color-text-primary);
    line-height: 1.15;
    font-variant-numeric: tabular-nums;

    /* 让利/补贴是「减项」，用绿色表达"支出"更符合中文财务直觉 */
    &.is-cut {
      color: $color-success;
    }
    &.is-income {
      color: $brand-orange-deep;
    }
  }
  .gmv-note {
    font-size: $fs-11;
    color: $text-4;
  }
}

.gmv-formula {
  margin: 14px 0 0;
  padding-top: 12px;
  border-top: 1px dashed var(--border-color);
  font-size: $fs-12;
  color: var(--color-text-secondary);
  line-height: 1.9;

  b {
    color: var(--color-text-primary);
    font-variant-numeric: tabular-nums;
  }
  .gmv-ok {
    margin-left: 8px;
    padding: 1px 7px;
    border-radius: $radius-xs;
    background: rgba($color-success, 0.12);
    color: $color-success;
    font-weight: $fw-semibold;

    &.is-bad {
      background: rgba($color-danger, 0.12);
      color: $color-danger;
    }
  }
}

@media (max-width: $breakpoint-md) {
  .gmv-split {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: $breakpoint-sm) {
  .gmv-split {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
