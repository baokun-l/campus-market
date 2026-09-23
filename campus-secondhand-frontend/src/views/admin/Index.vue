<template>
  <PageContainer
    title="管理后台"
    subtitle="商品与用户审核 · 交易与活动运营 · 内容治理 · 系统设置"
  >
    <div class="admin-shell">
      <!-- 左侧分组导航：10 个页签横向排不下、也难扫读，竖排分组更符合后台习惯 -->
      <nav
        class="admin-nav"
        role="tablist"
        aria-orientation="vertical"
        aria-label="后台功能导航"
      >
        <div
          v-for="g in NAV_GROUPS"
          :key="g.title"
          class="nav-group"
        >
          <p class="nav-group-title">
            {{ g.title }}
          </p>
          <button
            v-for="item in g.items"
            :key="item.key"
            type="button"
            role="tab"
            class="nav-item"
            :class="{ 'is-active': tab === item.key }"
            :aria-selected="tab === item.key"
            :aria-controls="`adm-panel-${item.key}`"
            :tabindex="tab === item.key ? 0 : -1"
            @click="activate(item.key)"
            @keydown="onNavKeydown($event, item.key)"
          >
            <el-icon class="nav-icon">
              <component :is="item.icon" />
            </el-icon>
            <span class="nav-label">{{ item.label }}</span>
            <span
              v-if="badgeOf(item.key)"
              class="nav-badge"
            >{{ badgeOf(item.key) }}</span>
          </button>
        </div>
      </nav>

      <section
        :id="`adm-panel-${tab}`"
        class="admin-main"
        role="tabpanel"
        :aria-label="currentLabel"
      >
        <keep-alive>
          <component :is="activePanel" />
        </keep-alive>
      </section>
    </div>
  </PageContainer>
</template>

<script setup lang="ts">
import { computed, onMounted, provide, ref, watch, type Component } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  AlarmClock,
  BellFilled,
  ChatLineSquare,
  Goods,
  Histogram,
  List,
  Notification,
  Setting,
  ShoppingCart,
  User
} from '@element-plus/icons-vue'
import PageContainer from '@/components/common/PageContainer.vue'
import { fetchAdminOverview } from '@/api/analytics'
import type { AdminOverview } from '@/api/analytics'
import { ADMIN_CONTEXT } from './adminContext'
import DashPanel from './panels/DashPanel.vue'
import GoodsPanel from './panels/GoodsPanel.vue'
import UsersPanel from './panels/UsersPanel.vue'
import OrdersPanel from './panels/OrdersPanel.vue'
import NoticesPanel from './panels/NoticesPanel.vue'
import ActivityPanel from './panels/ActivityPanel.vue'
import CategoriesPanel from './panels/CategoriesPanel.vue'
import ContentPanel from './panels/ContentPanel.vue'
import ReportsPanel from './panels/ReportsPanel.vue'
import SettingsPanel from './panels/SettingsPanel.vue'

/* ============================================================
 * 面板注册表
 * ============================================================ */

interface NavItem {
  key: string
  label: string
  icon: Component
}

const NAV_GROUPS: Array<{ title: string; items: NavItem[] }> = [
  {
    title: '概览',
    items: [{ key: 'dash', label: '数据看板', icon: Histogram }]
  },
  {
    title: '交易管理',
    items: [
      { key: 'goods', label: '商品审核', icon: Goods },
      { key: 'users', label: '用户管理', icon: User },
      { key: 'orders', label: '订单管理', icon: ShoppingCart }
    ]
  },
  {
    title: '内容运营',
    items: [
      { key: 'notices', label: '公告管理', icon: BellFilled },
      { key: 'activity', label: '活动管理', icon: AlarmClock },
      { key: 'categories', label: '分类管理', icon: List },
      { key: 'content', label: '内容审核', icon: ChatLineSquare },
      { key: 'reports', label: '举报处理', icon: Notification }
    ]
  },
  {
    title: '系统',
    items: [{ key: 'settings', label: '系统设置', icon: Setting }]
  }
]

const PANELS: Record<string, Component> = {
  dash: DashPanel,
  goods: GoodsPanel,
  users: UsersPanel,
  orders: OrdersPanel,
  notices: NoticesPanel,
  activity: ActivityPanel,
  categories: CategoriesPanel,
  content: ContentPanel,
  reports: ReportsPanel,
  settings: SettingsPanel
}

const NAV_ITEMS = NAV_GROUPS.flatMap((g) => g.items)
const PANEL_KEYS = NAV_ITEMS.map((i) => i.key)

/* ============================================================
 * 页签状态：URL query 为唯一事实来源
 * 好处是「举报处理」这类页签可以直接把链接发给同事打开。
 * ============================================================ */

const route = useRoute()
const router = useRouter()

function normalizeTab(v: unknown): string {
  const s = typeof v === 'string' ? v : ''
  return PANEL_KEYS.includes(s) ? s : 'dash'
}

const tab = ref(normalizeTab(route.query.tab))

const activePanel = computed(() => PANELS[tab.value])
const currentLabel = computed(() => NAV_ITEMS.find((i) => i.key === tab.value)?.label ?? '管理后台')

function activate(key: string) {
  if (key === tab.value) return
  tab.value = key
}

// 外部（浏览器前进/后退、直接改地址栏）改 query 时同步回来
watch(
  () => route.query.tab,
  (v) => {
    const next = normalizeTab(v)
    if (next !== tab.value) tab.value = next
  }
)

// 点页签即写回 URL，形成可分享 / 可回退的历史记录
watch(tab, (v) => {
  if (normalizeTab(route.query.tab) !== v) {
    router.replace({ query: { ...route.query, tab: v } })
  }
})

/** 上下方向键在导航项之间移动焦点（WAI-ARIA tabs 模式） */
function onNavKeydown(e: KeyboardEvent, key: string) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  e.preventDefault()
  const idx = PANEL_KEYS.indexOf(key)
  const step = e.key === 'ArrowDown' ? 1 : -1
  const next = PANEL_KEYS[(idx + step + PANEL_KEYS.length) % PANEL_KEYS.length]
  activate(next)
  requestAnimationFrame(() => {
    document.querySelector<HTMLElement>(`.nav-item[aria-controls="adm-panel-${next}"]`)?.focus()
  })
}

/* ============================================================
 * 看板总览：外壳统一拉取，用于导航角标 + 看板待办
 * ============================================================ */

const overview = ref<AdminOverview | null>(null)
const overviewLoading = ref(false)

async function refreshOverview() {
  overviewLoading.value = true
  try {
    overview.value = await fetchAdminOverview()
  } finally {
    overviewLoading.value = false
  }
}

/** 导航角标：只给「有明确待办含义」的页签挂数字，避免到处都是小红点 */
function badgeOf(key: string): number {
  const o = overview.value
  if (!o) return 0
  if (key === 'goods') return o.pendingGoods
  // 「users」角标已随 D11 拆除（2026-09-23）：用户注册即 active，无待审核待办
  if (key === 'reports') return o.pendingReports
  return 0
}

// 切页签顺手刷新一次角标：在「商品审核」里审完商品，切走时数字就会同步
watch(tab, () => refreshOverview())

provide(ADMIN_CONTEXT, { overview, overviewLoading, refreshOverview, goTab: activate })

onMounted(refreshOverview)
</script>

<!-- 全局引入后台设计系统（adm- 前缀，非 scoped）。
     10 个面板共用同一批工具类，集中一份避免在产物里重复内联 10 次。 -->
<style lang="scss">
@use './admin';
</style>

<style scoped lang="scss">
/* 本文件只放「外壳骨架」样式，面板内的通用样式统一在 admin.scss（adm- 前缀） */

/*
 * el-card 自带 `overflow: hidden` —— 那会让卡片自己变成一个「永远不滚动」的
 * 滚动容器，内部的 sticky 导航就再也吸不住（sticky 只认最近的滚动祖先）。
 * 后台这一页需要导航吸附，所以把卡片的裁剪关掉；卡片内没有横向溢出内容，
 * 关掉不影响圆角观感。
 *
 * 【sticky 失效的真正根因】Element Plus 2.14 起主题自带
 * `.el-card__body { overflow: auto }` —— 这层「能滚但内容等高（滚动距离为 0）」的
 * 中间层会成为 sticky 的最近滚动容器，导航就永远钉不住，表现为侧栏跟着内容一起滚走。
 * 已用 CDP 探针（scripts/probe-sticky.cjs）实测确认，两个 overflow 都要关。
 */
:deep(.page-card) {
  overflow: visible;
}

:deep(.page-card .el-card__body) {
  overflow: visible;
}

.admin-shell {
  display: flex;
  align-items: flex-start;
  gap: 20px;
}

/* ============================================================
   左侧导航

   关键：`position: sticky` + 自身滚动。
   页面滚动容器是 layouts/BasicLayout 的 .layout-main，导航若不吸附，
   内容一长就会和面板一起被卷走 —— 想切页签还得先滚回顶部。
   吸附之后：面板负责滚，导航留在原地；导航比视口还高时它自己滚，
   两者互不牵连。
   ============================================================ */
.admin-nav {
  position: sticky;
  top: 0;
  align-self: flex-start;
  flex: 0 0 188px;
  /* 可用高度 = 视口 − 顶栏 − 底栏 − 主区上下内边距 − 页面标题区 */
  max-height: calc(100vh - #{$header-h} - #{$sp-5} * 2 - 56px);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding-right: 2px;
  display: flex;
  flex-direction: column;
  gap: 14px;

  scrollbar-width: thin;
  scrollbar-color: #dcdfe4 transparent;
  &::-webkit-scrollbar { width: 6px; }
  &::-webkit-scrollbar-thumb {
    background: #dcdfe4;
    border-radius: 3px;
    &:hover { background: #c6cad1; }
  }
  &::-webkit-scrollbar-track { background: transparent; }
}

.nav-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav-group-title {
  margin: 0 0 3px;
  padding: 0 10px;
  font-size: 11px;
  font-weight: $fw-semibold;
  letter-spacing: 0.08em;
  color: var(--color-text-mute);
}

.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  height: 38px;
  padding: 0 10px;
  border: none;
  border-radius: $radius-sm;
  background: transparent;
  font-family: inherit;
  font-size: $fs-13;
  color: var(--color-text-secondary);
  text-align: left;
  cursor: pointer;
  transition: background-color $dur-base $ease-out, color $dur-base $ease-out;

  .nav-icon {
    font-size: 15px;
    color: var(--color-text-mute);
    transition: color $dur-base $ease-out;
  }

  &:hover {
    background: var(--bg-soft);
    color: var(--color-text-primary);
  }

  &:focus-visible {
    outline: 2px solid $color-primary;
    outline-offset: 1px;
  }

  &.is-active {
    background: $color-primary-soft;
    color: $color-primary;
    font-weight: $fw-semibold;

    .nav-icon {
      color: $color-primary;
    }

    /* 左侧短竖条：比整块高亮更克制，符合「默认只用描边」的基调 */
    &::before {
      content: '';
      position: absolute;
      left: 0;
      top: 50%;
      width: 3px;
      height: 16px;
      transform: translateY(-50%);
      border-radius: 0 3px 3px 0;
      background: $color-primary;
    }
  }
}

.nav-badge {
  margin-left: auto;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  display: grid;
  place-items: center;
  border-radius: $radius-pill;
  background: $brand-orange;
  color: #fff;
  font-size: 11px;
  font-weight: $fw-bold;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

/* ============================================================
   右侧面板区
   ============================================================ */
.admin-main {
  flex: 1 1 auto;
  min-width: 0;
}

/* ============================================================
   响应式：窄屏改为横向可滑动的胶囊条
   ============================================================ */
@media (max-width: $breakpoint-md) {
  .admin-shell {
    flex-direction: column;
    gap: 12px;
  }

  .admin-nav {
    flex: none;
    width: 100%;
    flex-direction: row;
    gap: 4px;
    overflow-x: auto;
    padding-bottom: 2px;
    scrollbar-width: none;

    &::-webkit-scrollbar {
      display: none;
    }
  }

  .nav-group {
    flex-direction: row;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
  }

  .nav-group-title {
    display: none;
  }

  .nav-item {
    width: auto;
    flex-shrink: 0;
    padding: 0 12px;
    white-space: nowrap;
    background: var(--bg-soft);

    &.is-active::before {
      display: none;
    }
  }
}
</style>
