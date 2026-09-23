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
  xAxis: string[]
  data: Item[]
  title?: string
  height?: number
  loading?: boolean
}>()
const emit = defineEmits<{ click: [params: any] }>()

/*
 * ★ 这里删掉了一个 `horizontal?: boolean` 属性 ★
 *
 * 它曾被写成三个「两边一模一样」的三元表达式：
 *     const yAxis = props.horizontal ? A : A
 *     const xAxis = props.horizontal ? B : B
 *     [props.horizontal ? 'xAxis' : 'xAxis']: xAxis   // 恒等于 'xAxis'
 * 也就是说传与不传，产出的 option **逐字节相同** —— 一个纯粹的假开关。
 * 而且全项目没有任何调用方传过它（`horizontal` 只在 props 定义处命中一次），
 * 所以它既没被用上、也没人发现它坏了。
 *
 * ★ 顺带说明这个图的真实方向 ★
 * 它的类目轴在 **y 轴**（`yAxis` 是 category、`xAxis` 是 value），
 * 所以它本来就是横向条形图。将来若真要支持切换方向，
 * 正确做法是把 category 轴换到 x、value 轴换到 y（两个键一起换位），
 * 而不是再加一个「什么都不改」的布尔值 —— 那只会再骗下一个人一次。
 */
const option = computed(() => {
  return {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 36, right: 24, top: 30, bottom: 24 },
    xAxis: { type: 'value', splitLine: { lineStyle: { color: '#f1f5f9' } } },
    yAxis: { type: 'category', data: props.xAxis, axisLine: { lineStyle: { color: '#cbd5e1' } } },
    series: [{
      name: props.title || '数值',
      type: 'bar',
      barWidth: '40%',
      itemStyle: {
        borderRadius: [6, 6, 0, 0],
        color: {
          type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: '#3b82f6' },
            { offset: 1, color: '#93c5fd' }
          ]
        }
      },
      data: props.data.map((d) => d.value)
    }]
  }
})

function onClick(p: any) { emit('click', p) }
</script>
