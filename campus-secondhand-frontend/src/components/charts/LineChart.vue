<template>
  <BaseChart
    :option="option"
    :loading="loading"
    :height="height"
    @click="onClick"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import BaseChart from './BaseChart.vue'

interface Series {
  name: string
  data: number[]
  color?: string
  type?: 'line' | 'bar'
}

const props = defineProps<{
  xAxis: string[]
  series: Series[]
  title?: string
  height?: number
  smooth?: boolean
  loading?: boolean
}>()
const emit = defineEmits<{ click: [params: any] }>()

const option = computed(() => ({
  tooltip: { trigger: 'axis' },
  legend: { top: 0, icon: 'roundRect' },
  grid: { left: 36, right: 24, top: 40, bottom: 30 },
  xAxis: { type: 'category', data: props.xAxis, boundaryGap: false, axisLine: { lineStyle: { color: '#cbd5e1' } } },
  yAxis: { type: 'value', splitLine: { lineStyle: { color: '#f1f5f9' } } },
  series: props.series.map((s) => ({
    name: s.name,
    type: s.type ?? 'line',
    smooth: props.smooth ?? true,
    symbol: 'circle',
    symbolSize: 6,
    data: s.data,
    lineStyle: { width: 2, color: s.color },
    itemStyle: { color: s.color },
    areaStyle: {
      opacity: 0.18,
      color: {
        type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
        colorStops: [
          { offset: 0, color: s.color || '#2563eb' },
          { offset: 1, color: 'rgba(255,255,255,0)' }
        ]
      }
    }
  }))
}))

function onClick(p: any) { emit('click', p) }
</script>
