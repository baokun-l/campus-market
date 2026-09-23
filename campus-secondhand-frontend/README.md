# 校园二手交易系统前端 · Vue3 + Element Plus + ECharts

> 基于 Vue 3.4 + Vite 5 + TypeScript + Element Plus 2 + ECharts 5 + Pinia 2 的现代化校园二手交易平台前端。  
> 软件工程实践课（2023级）· 实践任务2 配套工程。

## ✨ 功能特性

- **完整路由**：`vue-router 4` + `createWebHistory()` + 权限守卫（含 `requireAuth` / `requireAdmin` 元信息）
- **状态管理**：`Pinia 2` 模块化拆分 `user` / `app` / `goods` / `cart`，本地持久化
- **请求层**：Axios 封装 + Loading 计数 + 错误拦截 + 401 过期自动跳登录
- **Mock 数据**：内置完整离线 mock，可平滑切换到真实接口
- **Element Plus 全场景**：表单、表格、分页、抽屉、弹窗、文件上传、Confirm/Prompt、下拉菜单
- **ECharts 图表**：折线图、柱状图、饼图 3 类组件 + 动态数据 + 点击事件 + resize 自适应
- **响应式**：桌面 / 平板 / 移动端 自适应；移动端侧边栏变成抽屉
- **类型体系**：TypeScript 严格模式 + 完整业务类型定义
- **测试**：Vitest + Vue Test Utils + happy-dom 配置就绪

## 📁 目录结构

```
campus-secondhand-frontend/
├── public/
│   └── favicon.svg
├── src/
│   ├── api/                   # 请求层 + Mock
│   │   ├── request.ts         # Axios 封装
│   │   ├── mock.ts            # 离线数据
│   │   ├── user.ts
│   │   ├── goods.ts
│   │   ├── order.ts
│   │   └── analytics.ts
│   ├── components/
│   │   ├── common/            # 通用业务组件
│   │   │   ├── SearchBar.vue
│   │   │   ├── GoodsCard.vue
│   │   │   ├── PriceTag.vue
│   │   │   ├── EmptyState.vue
│   │   │   └── PageContainer.vue
│   │   └── charts/            # ECharts 图表组件
│   │       ├── echarts.ts     # 按需注册
│   │       ├── BaseChart.vue
│   │       ├── LineChart.vue
│   │       ├── BarChart.vue
│   │       └── PieChart.vue
│   ├── layouts/
│   │   ├── BasicLayout.vue    # 主框架（Header + Sidebar + Content）
│   │   └── MobileSidebarContent.vue
│   ├── router/
│   │   └── index.ts           # 路由 + 守卫
│   ├── stores/
│   │   ├── index.ts
│   │   └── modules/
│   │       ├── user.ts
│   │       ├── app.ts
│   │       ├── goods.ts
│   │       └── cart.ts
│   ├── styles/
│   │   ├── index.scss
│   │   └── variables.scss     # Design Tokens
│   ├── types/
│   │   └── index.ts           # 全局类型
│   ├── utils/
│   │   ├── format.ts          # 价格/日期/防抖/节流
│   │   └── permission.ts      # 路由守卫
│   ├── views/
│   │   ├── auth/Login.vue
│   │   ├── goods/
│   │   │   ├── List.vue       # 商品列表 + 搜索 + 分页
│   │   │   ├── Detail.vue     # 商品详情 + 抽屉
│   │   │   ├── Publish.vue    # 发布表单 + 上传
│   │   │   └── Cart.vue       # 购物车
│   │   ├── order/Index.vue    # 订单中心 + 状态机
│   │   ├── admin/Index.vue    # 管理后台：审核/封禁/数据看板
│   │   ├── Home.vue           # 首页 (Banner + 类目 + 推荐 + 图表)
│   │   ├── Analytics.vue      # 数据分析大屏
│   │   ├── About.vue
│   │   └── NotFound.vue       # 404 / 403
│   ├── App.vue
│   ├── main.ts
│   └── env.d.ts
├── index.html
├── vite.config.ts             # Vite + 自动按需导入 + 代理
├── tsconfig.json
├── package.json
├── .env.development
├── .env.production
└── .gitignore
```

## 🚀 快速开始

### 1. 安装依赖

```bash
# 推荐使用 pnpm
npm i -g pnpm
pnpm install

# 或 npm / yarn / cnpm
npm install
```

### 2. 启动开发服务器

```bash
npm run dev
# 默认 http://localhost:5173
```

> 内置 Mock 数据，无需后端即可体验全功能。  
> 演示账号：任意用户名 + 至少 6 位密码；admin 账号：`admin` / `admin123`

### 3. 构建生产产物

```bash
npm run build        # 类型检查 + 构建到 dist/
npm run preview      # 本地预览
```

### 4. 切换到真实后端

修改根目录 `.env.development`：

```env
VITE_API_BASE=http://your-api.example.com
VITE_USE_MOCK=false
```

## 🧪 测试

```bash
npm run test              # 单次运行
npm run test:coverage     # 覆盖率报告
npm run type-check        # vue-tsc 类型检查
npm run lint              # ESLint + Prettier
```

## 📦 主要脚本

| 命令                     | 说明                     |
| ------------------------ | ------------------------ |
| `npm run dev`            | 启动开发服务器           |
| `npm run build`          | 生产构建（带类型检查）   |
| `npm run build:no-check` | 生产构建（跳过类型检查） |
| `npm run preview`        | 预览构建产物             |
| `npm run lint`           | ESLint 自检              |
| `npm run format`         | Prettier 格式化          |
| `npm run test`           | Vitest 跑测试            |
| `npm run type-check`     | vue-tsc 类型检查         |

## 🔑 演示账号

| 用户名  | 密码       | 角色     |
| ------- | ---------- | -------- |
| `admin` | `admin123` | 管理员   |
| 任意    | ≥ 6 位     | 普通用户 |

> 登录后可以体验：商品列表、详情、加购、订单生命周期（待付款→待发货→已发货→已完成）、评价；  
> 以 admin 登录可以体验：管理后台的商品审核、用户封禁、数据看板。

## 🛠 技术栈版本

| 包           | 版本    |
| ------------ | ------- |
| Vue          | 3.4.27  |
| Vite         | 5.2.11  |
| TypeScript   | 5.4.5   |
| Element Plus | 2.7.6   |
| ECharts      | 5.5.0   |
| Pinia        | 2.1.7   |
| Vue Router   | 4.3.2   |
| Axios        | 1.7.2   |
| Day.js       | 1.11.11 |

## 📐 代码规范

- TypeScript 严格模式 (`strict: true`)
- `<script setup lang="ts">` 组合式 API + 类型推导
- 组件就近测试：`*Component.spec.ts`
- 业务组件按 `components/business/*` 单独目录
- 全局唯一请求入口：`api/request.ts`
- Pinia store 按模块拆分 + 字段级持久化

## 📈 性能指标（基线）

| 指标                   | 目标    |
| ---------------------- | ------- |
| 首屏 LCP               | < 2.0s  |
| 交互响应 INP           | < 100ms |
| 首屏 JS (gzip)         | < 200KB |
| Lighthouse Performance | ≥ 90    |
| 单元测试覆盖率         | ≥ 85%   |

## 📄 许可

仅用于软件工程实践课教学，不用于商业用途。
