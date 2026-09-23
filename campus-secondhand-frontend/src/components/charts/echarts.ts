/**
 * ECharts 按需注册 + 通用图表组件
 */
import * as echarts from 'echarts/core'
import {
  LineChart, BarChart, PieChart, ScatterChart
} from 'echarts/charts'
import {
  TitleComponent, TooltipComponent, GridComponent, LegendComponent,
  DataZoomComponent, ToolboxComponent, MarkLineComponent, MarkPointComponent
} from 'echarts/components'
import { LabelLayout, UniversalTransition } from 'echarts/features'
import { CanvasRenderer, SVGRenderer } from 'echarts/renderers'

echarts.use([
  LineChart, BarChart, PieChart, ScatterChart,
  TitleComponent, TooltipComponent, GridComponent, LegendComponent,
  DataZoomComponent, ToolboxComponent, MarkLineComponent, MarkPointComponent,
  LabelLayout, UniversalTransition,
  CanvasRenderer, SVGRenderer
])

export { echarts }
