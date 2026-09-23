<template>
  <PageContainer
    back
    title="关于本项目"
  >
    <div class="about">
      <div class="hero">
        <h2>🎓 校园二手集市</h2>
        <p>基于 Vue 3 + Element Plus + ECharts 构建的企业级二手交易前端</p>
      </div>
      <el-row :gutter="14">
        <el-col
          :xs="24"
          :md="12"
        >
          <el-card shadow="never">
            <h4>技术栈</h4>
            <ul>
              <li><b>Vue 3.4</b> Composition API + TypeScript</li>
              <li><b>Vite 5</b> 极速构建 + 自动按需导入</li>
              <li><b>Element Plus 2</b> 企业级 UI 组件库</li>
              <li><b>ECharts 5</b> 数据可视化</li>
              <li><b>Pinia 2</b> 状态管理 + 持久化</li>
              <li><b>Vue Router 4</b> History 模式 + 守卫</li>
              <li><b>Axios + Mock</b> 请求层 + 离线 mock</li>
            </ul>
          </el-card>
        </el-col>
        <el-col
          :xs="24"
          :md="12"
        >
          <el-card shadow="never">
            <h4>关键能力</h4>
            <ul>
              <li>✅ 完整路由 + 权限守卫</li>
              <li>✅ Pinia 模块化拆分（user / app / goods / cart）</li>
              <li>✅ Axios 统一封装 + Loading + 错误处理</li>
              <li>✅ Element Plus 表单/表格/分页/抽屉/弹窗全场景示例</li>
              <li>✅ ECharts 折线 / 柱状 / 饼图 3 类图表</li>
              <li>✅ 响应式布局：桌面 + 平板 + 移动端</li>
              <li>✅ Mock 数据 + 可平滑切换到真实 API</li>
            </ul>
          </el-card>
        </el-col>
      </el-row>
      <el-card
        shadow="never"
        style="margin-top:14px"
      >
        <h4>目录结构</h4>
        <pre><code>src/
├── api/              # 请求层 + Mock
│   ├── request.ts    # Axios 封装
│   ├── mock.ts       # Mock 数据
│   └── user.ts / goods.ts / order.ts / analytics.ts
├── components/
│   ├── common/       # 通用组件 (SearchBar/GoodsCard/PriceTag/...)
│   └── charts/       # ECharts 图表组件
├── layouts/          # 整体布局
├── router/           # 路由 + 守卫
├── stores/           # Pinia 状态
├── styles/           # 全局 SCSS
├── types/            # 类型定义
├── utils/            # 工具函数
└── views/            # 页面
    ├── auth/         # 登录注册
    ├── goods/        # 商品模块
    ├── order/        # 订单模块
    ├── admin/        # 管理后台
    ├── Home.vue
    ├── Analytics.vue
    └── ...</code></pre>
      </el-card>
    </div>
  </PageContainer>
</template>

<script setup lang="ts">
import PageContainer from '@/components/common/PageContainer.vue'
</script>

<style scoped lang="scss">
.about { max-width: 1100px; margin: 0 auto; }
.hero {
  text-align: center;
  padding: 36px 24px;
  border-radius: 16px;
  background: linear-gradient(135deg, #1e3a8a, #2563eb 50%, #7c3aed);
  color: #fff; margin-bottom: 18px;
  h2 { font-size: 28px; margin-bottom: 8px; }
  p { opacity: .9; }
}
h4 { margin-bottom: 8px; color: var(--color-primary); }
ul li { padding: 4px 0; color: var(--color-text-secondary); font-size: 14px; }
pre { background: var(--code-bg); color: var(--code-text); padding: 16px; border-radius: 8px; overflow-x: auto; font-size: 12.5px; line-height: 1.7; }
</style>
