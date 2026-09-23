<template>
  <div
    ref="chartRef"
    class="chart-box"
    :style="{ height: height + 'px' }"
  />
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, shallowRef } from 'vue'
import { echarts } from './echarts'
import type { EChartsType } from 'echarts/core'

interface Props {
  option: any
  height?: number
  loading?: boolean
}
const props = withDefaults(defineProps<Props>(), { height: 320 })
const emit = defineEmits<{ click: [params: any] }>()
const chartRef = ref<HTMLDivElement>()
const chart = shallowRef<EChartsType>()

function init() {
  if (!chartRef.value) return
  chart.value = echarts.init(chartRef.value, undefined, { renderer: 'canvas' })
  chart.value.setOption(props.option)
  chart.value.on('click', (p) => emit('click', p))
}

function resize() {
  chart.value?.resize()
}

watch(() => props.option, (v) => chart.value?.setOption(v, true), { deep: true })
watch(() => props.loading, (v) => {
  if (!chart.value) return
  v ? chart.value.showLoading() : chart.value.hideLoading()
})

onMounted(() => {
  init()
  window.addEventListener('resize', resize)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', resize)
  chart.value?.dispose()
})
</script>

<style scoped>
.chart-box { width: 100%; }
</style>
