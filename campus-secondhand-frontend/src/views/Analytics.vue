<template>
  <PageContainer
    back
    title="数据分析"
    subtitle="访问趋势、订单分布、Top 商品实时看板"
  >
    <template #actions>
      <el-radio-group
        v-model="days"
        @change="loadTrend"
      >
        <el-radio-button :label="7">
          7 天
        </el-radio-button>
        <el-radio-button :label="14">
          14 天
        </el-radio-button>
        <el-radio-button :label="30">
          30 天
        </el-radio-button>
      </el-radio-group>
      <el-button @click="refresh">
        刷新
      </el-button>
    </template>

    <el-row :gutter="14">
      <el-col
        :xs="12"
        :sm="6"
      >
        <div class="kpi">
          <span class="label">浏览 PV</span><b class="value">{{ totalPV }}</b>
        </div>
      </el-col>
      <el-col
        :xs="12"
        :sm="6"
      >
        <div class="kpi">
          <span class="label">独立用户</span><b class="value">{{ totalUV }}</b>
        </div>
      </el-col>
      <el-col
        :xs="12"
        :sm="6"
      >
        <div class="kpi">
          <span class="label">订单数</span><b class="value">{{ totalOrders }}</b>
        </div>
      </el-col>
      <el-col
        :xs="12"
        :sm="6"
      >
        <div class="kpi">
          <span class="label">日均订单</span><b class="value">{{ avgOrders }}</b>
        </div>
      </el-col>
    </el-row>

    <el-row
      :gutter="14"
      style="margin-top: 14px"
    >
      <el-col
        :xs="24"
        :md="16"
      >
        <el-card shadow="never">
          <div class="card-head">
            <h4>访问与订单趋势</h4>
          </div>
          <LineChart
            :x-axis="trendData.dates"
            :series="trendData.series"
            :height="320"
          />
        </el-card>
      </el-col>
      <el-col
        :xs="24"
        :md="8"
      >
        <el-card shadow="never">
          <div class="card-head">
            <h4>分类成交占比</h4>
          </div>
          <PieChart
            :data="pieData"
            :height="320"
          />
        </el-card>
      </el-col>
    </el-row>

    <el-row
      :gutter="14"
      style="margin-top: 14px"
    >
      <el-col
        :xs="24"
        :md="12"
      >
        <el-card shadow="never">
          <div class="card-head">
            <h4>每日订单量</h4>
          </div>
          <BarChart
            :x-axis="trendData.dates"
            :data="orderBars"
            :height="300"
          />
        </el-card>
      </el-col>
      <el-col
        :xs="24"
        :md="12"
      >
        <el-card shadow="never">
          <div class="card-head">
            <h4>热销 Top 5</h4>
          </div>
          <el-table
            :data="topGoods"
            size="small"
          >
            <el-table-column
              type="index"
              label="排名"
              width="60"
            />
            <el-table-column label="商品">
              <template #default="{ row }">
                <div class="t-cell">
                  <el-image
                    :src="row.cover"
                    fit="cover"
                    class="t-img"
                  />
                  <span>{{ row.title }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column
              label="浏览"
              prop="viewCount"
              width="90"
              align="right"
            />
            <el-table-column
              label="收藏"
              prop="favoriteCount"
              width="90"
              align="right"
            />
          </el-table>
        </el-card>
      </el-col>
    </el-row>
  </PageContainer>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import PageContainer from '@/components/common/PageContainer.vue'
import LineChart from '@/components/charts/LineChart.vue'
import PieChart from '@/components/charts/PieChart.vue'
import BarChart from '@/components/charts/BarChart.vue'
import { fetchTrend, fetchCategoryDistribution, fetchTopGoods } from '@/api/analytics'
import type { Goods } from '@/types'

const days = ref(7)
const trendData = ref<{ dates: string[]; series: any[] }>({ dates: [], series: [] })
const pieData = ref<{ name: string; value: number }[]>([])
const topGoods = ref<Goods[]>([])

const totalPV = computed(() => trendData.value.series.find((s: any) => s.name.includes('PV'))?.data.reduce((a: number, b: number) => a + b, 0) ?? 0)
const totalUV = computed(() => trendData.value.series.find((s: any) => s.name.includes('UV'))?.data.reduce((a: number, b: number) => a + b, 0) ?? 0)
const totalOrders = computed(() => trendData.value.series.find((s: any) => s.name.includes('订单'))?.data.reduce((a: number, b: number) => a + b, 0) ?? 0)
const avgOrders = computed(() => Math.round((totalOrders.value as number) / days.value))

const orderBars = computed(() => {
  const s = trendData.value.series.find((x: any) => x.name.includes('订单'))
  if (!s) return []
  return trendData.value.dates.map((d, i) => ({ name: d, value: s.data[i] }))
})

async function loadTrend() {
  const tr = await fetchTrend(days.value)
  trendData.value = {
    dates: tr.map((t) => t.date),
    series: [
      { name: 'PV (浏览)', data: tr.map((t) => t.pv), color: '#2563eb' },
      { name: 'UV (用户)', data: tr.map((t) => t.uv), color: '#7c3aed' },
      { name: '订单数', data: tr.map((t) => t.orders), color: '#f97316' }
    ]
  }
}
async function refresh() {
  await Promise.all([loadTrend(), (async () => {
    pieData.value = await fetchCategoryDistribution()
    topGoods.value = await fetchTopGoods(5)
  })()])
  ElMessage.success('数据已刷新')
}

onMounted(refresh)
</script>

<style scoped lang="scss">
.kpi {
  background: #fff; border: 1px solid var(--border-color); border-radius: 10px;
  padding: 18px 22px;
  .label { color: var(--color-text-mute); font-size: 13px; }
  .value { display: block; font-size: 26px; font-weight: 800; color: var(--color-primary); margin-top: 4px; }
}
.card-head { margin-bottom: 8px; h4 { font-size: 16px; } }
.t-cell { display: flex; align-items: center; gap: 10px;
  .t-img { width: 40px; height: 40px; border-radius: 4px; }
  span { font-size: 13px; }
}
</style>
