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

interface Item { name: string; value: number; color?: string }

const props = defineProps<{
  data: Item[]
  title?: string
  height?: number
  loading?: boolean
  /**
   * 标签呈现方式：
   * - outside（默认）：外置引导线 + 名称/百分比，适合宽度充裕的容器
   * - legend：隐藏外置标签，把百分比并进图例，适合窄卡片（否则标签会被卡片裁掉）
   */
  labelMode?: 'outside' | 'legend'
}>()
const emit = defineEmits<{ click: [params: any] }>()

const total = computed(() => props.data.reduce((s, x) => s + (x.value || 0), 0))

const option = computed(() => {
  const byLegend = props.labelMode === 'legend'
  return {
    tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
    legend: {
      bottom: 0,
      icon: 'circle',
      // 图例项带上百分比，弥补隐藏外置标签后丢失的信息
      formatter: byLegend
        ? (name: string) => {
            const item = props.data.find((d) => d.name === name)
            const pct = total.value ? ((item?.value ?? 0) / total.value) * 100 : 0
            return `${name} ${pct.toFixed(1)}%`
          }
        : undefined
    },
    color: ['#2563eb', '#7c3aed', '#f97316', '#10b981', '#f59e0b', '#ef4444', '#06b6d4'],
    series: [{
      name: props.title || '占比',
      type: 'pie',
      radius: byLegend ? ['42%', '72%'] : ['38%', '70%'],
      center: ['50%', '45%'],
      avoidLabelOverlap: true,
      itemStyle: { borderRadius: 6, borderColor: '#fff', borderWidth: 2 },
      label: byLegend ? { show: false } : { show: true, formatter: '{b}\n{d}%', fontSize: 12 },
      labelLine: { show: !byLegend },
      data: props.data
    }]
  }
})

function onClick(p: any) { emit('click', p) }
</script>
