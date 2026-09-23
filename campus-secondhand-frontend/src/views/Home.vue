<template>
  <div class="home">
    <!-- ==================== 限时活动 Banner（管理员可随时取消，到期自动消失） ==================== -->
    <!-- 营销推送开关（设置 → 消息通知）真实生效点：关闭后首页不再展示营销 Banner -->
    <PromoBanner
      v-if="appStore.settings.notifyMarketing"
      :summary="summary"
    />

    <!-- ==================== 分类：整行横排，置于商品列表之上 ==================== -->
    <section
      class="cat-card"
      aria-label="商品分类"
    >
      <div class="cat-head">
        <h3>分类</h3>
        <router-link
          class="cat-more"
          to="/goods"
        >
          全部 →
        </router-link>
      </div>
      <ul class="cat-row">
        <li
          v-for="c in categories"
          :key="c.id"
        >
          <router-link
            class="cat-item"
            :to="{ path: '/goods', query: { categoryId: c.id } }"
          >
            <span
              class="cat-icon"
              :style="{ background: catBg(c.id) }"
              aria-hidden="true"
            >
              {{ c.icon }}
            </span>
            <span class="cat-name">{{ c.name }}</span>
          </router-link>
        </li>
      </ul>
    </section>

    <!-- ==================== 热卖推荐（占满整行宽度） ==================== -->
    <section class="feed">
      <div class="section-title">
        <h3>{{ appStore.settings.personalizedAds ? '热卖推荐' : '最新上架' }}</h3>
        <router-link
          class="more-link"
          to="/goods"
        >
          查看更多 →
        </router-link>
      </div>

      <div
        v-if="recommend.length"
        class="goods-grid"
      >
        <GoodsCard
          v-for="g in recommend"
          :key="g.id"
          :goods="g"
        />
      </div>
      <EmptyState
        v-else
        title="暂无推荐商品"
        description="稍后再来看看吧"
        icon="🛍️"
      />
    </section>

    <!-- ==================== 数据看板 ==================== -->
    <section class="chart-row">
      <div class="chart-card">
        <div class="section-title">
          <h3>近 7 日访问与下单趋势</h3>
          <span class="live-tag">实时</span>
        </div>
        <LineChart
          :x-axis="trend.dates"
          :series="trend.series"
          :height="280"
        />
      </div>
      <div class="chart-card">
        <div class="section-title">
          <h3>分类成交占比</h3>
        </div>
        <PieChart
          :data="pieData"
          :height="280"
        />
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import GoodsCard from '@/components/common/GoodsCard.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import PromoBanner from '@/components/home/PromoBanner.vue'
import LineChart from '@/components/charts/LineChart.vue'
import PieChart from '@/components/charts/PieChart.vue'
import { fetchGoods, fetchCategories, SELLABLE_STATUS } from '@/api/goods'
import { fetchTrend, fetchCategoryDistribution, fetchPlatformSummary } from '@/api/analytics'
import { useAppStore } from '@/stores/modules/app'
import type { Goods, Category } from '@/types'

const appStore = useAppStore()

const categories = ref<Category[]>([])
const recommend = ref<Goods[]>([])
const summary = ref({ goodsTotal: 0, userTotal: 0, orderTotal: 0, recentOrders: 0 })

const trend = ref<{ dates: string[]; series: any[] }>({ dates: [], series: [] })
const pieData = ref<{ name: string; value: number }[]>([])

/** 分类图标底色：与商品封面色板同族，保证整体配色统一 */
const CAT_BG: Record<number, string> = {
  1: '#e8f1ff',
  2: '#f1ecff',
  3: '#e6fbff',
  4: '#ffecf5',
  5: '#fff6e0',
  6: '#e9fbe9',
  7: '#e2fbf4',
  8: '#fff0e2'
}
function catBg(id: number) {
  return CAT_BG[id] ?? '#f2f3f5'
}

async function loadAll() {
  const [cat, rec, tr, pie, sum] = await Promise.all([
    fetchCategories(),
    // 热卖推荐只推「真正能买」的在售商品：推荐位点进去买不了会直接劝退用户
    // 个性化推荐开关（设置 → 隐私设置）真实生效点：
    // 开 → 按热度排序（浏览量加权）；关 → 退回纯时间序，不做任何画像排序
    fetchGoods({ sort: appStore.settings.personalizedAds ? 'hot' : 'new', statuses: SELLABLE_STATUS, pageSize: 8 }),
    fetchTrend(7),
    fetchCategoryDistribution(),
    fetchPlatformSummary()
  ])
  categories.value = cat
  recommend.value = rec.list
  trend.value = {
    dates: tr.map((t) => t.date),
    series: [
      { name: 'PV (浏览)', data: tr.map((t) => t.pv), color: '#2563eb' },
      { name: 'UV (用户)', data: tr.map((t) => t.uv), color: '#7c3aed' },
      { name: '订单数', data: tr.map((t) => t.orders), color: '#ff6a00' }
    ]
  }
  pieData.value = pie
  summary.value = sum
}

onMounted(loadAll)
</script>

<style scoped lang="scss">
@use '@/styles/variables.scss' as *;

.home {
  max-width: $content-max;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: $sp-5;
}

/* ============================================================
   限时活动 Banner 样式已下沉到 PromoBanner.vue
   ============================================================ */

/* ============================================================
   分类：整行横排卡片
   8 个分类在一行内铺满，商品网格因此可以拿到整行宽度
   ============================================================ */
.cat-card {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: $radius-md;
  padding: $sp-4 $sp-5 $sp-5;
  box-shadow: $shadow-xs;
}

.cat-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: $sp-4;

  h3 {
    display: flex;
    align-items: center;
    gap: $sp-2;
    font-size: $fs-16;
    font-weight: $fw-semibold;

    &::before {
      content: '';
      width: 3px;
      height: 15px;
      border-radius: $radius-pill;
      background: linear-gradient(180deg, $brand-orange, #ffa64d);
    }
  }
  .cat-more {
    font-size: $fs-13;
    color: var(--color-text-mute);
    &:hover { color: $color-primary; }
  }
}

/* 分类横排：一级分类共 9 个（含兜底「其他」），桌面端一行放满不折行 */
.cat-row {
  display: grid;
  grid-template-columns: repeat(9, minmax(0, 1fr));
  gap: $sp-3;
}

/* 竖排：图标块在上、文字在下，整行高度一致 */
.cat-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 12px 6px;
  border-radius: $radius-sm;
  color: var(--color-text-secondary);
  font-size: $fs-13;
  transition:
    background-color $dur-base $ease-out,
    color $dur-base $ease-out,
    transform $dur-base $ease-out;

  &:hover,
  &:focus-visible {
    background: var(--bg-hover);
    color: var(--color-text-primary);
    transform: translateY(-2px);
  }
  &:active { transform: translateY(0); }

  .cat-icon {
    width: 44px;
    height: 44px;
    display: grid;
    place-items: center;
    font-size: 22px;
    border-radius: $radius-md;
    transition: transform $dur-base $ease-out;
  }
  &:hover .cat-icon { transform: scale(1.08); }

  .cat-name {
    font-weight: $fw-medium;
    white-space: nowrap;
  }
}

/* ============================================================
   热卖推荐
   ============================================================ */
.feed {
  min-width: 0;
}

.section-title .more-link {
  font-size: $fs-13;
  color: var(--color-text-mute);
  &:hover { color: $color-primary; }
}

.goods-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(196px, 1fr));
  gap: $sp-4;
}

/* ============================================================
   数据看板
   ============================================================ */
.chart-row {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
  gap: $sp-5;
}

.chart-card {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: $radius-md;
  padding: $sp-5;
  box-shadow: $shadow-xs;
}

.live-tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: $fs-12;
  font-weight: $fw-medium;
  color: #047857;
  background: #ecfdf5;
  border: 1px solid #a7f3d0;
  border-radius: $radius-pill;
  padding: 3px 10px;

  &::before {
    content: '';
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: $color-success;
    animation: pulse 1.8s ease-in-out infinite;
  }
}

@keyframes pulse {
  0%,
  100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.45; transform: scale(0.82); }
}

/* ============================================================
   响应式
   ============================================================ */
@media (max-width: $breakpoint-md) {
  /* 9 个分类：平板 5+4、手机 3×3，都不留落单的一格 */
  .cat-row { grid-template-columns: repeat(5, minmax(0, 1fr)); }
  .chart-row { grid-template-columns: minmax(0, 1fr); }
}

@media (max-width: $breakpoint-sm) {
  .cat-card { padding: $sp-3 $sp-4 $sp-4; }
  .cat-row { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: $sp-2; }
  .cat-item .cat-icon { width: 40px; height: 40px; font-size: 20px; }
  .goods-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: $sp-3; }
}

@media (prefers-reduced-motion: reduce) {
  .cat-icon { transition: none !important; }
  .cat-item:hover,
  .cat-item:focus-visible { transform: none; }
  .cat-item:hover .cat-icon { transform: none; }
  .live-tag::before { animation: none; }
}
</style>
