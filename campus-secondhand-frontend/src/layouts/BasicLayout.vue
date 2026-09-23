<template>
  <div class="layout-root">
    <!-- ============================ 顶部导航 ============================ -->
    <header class="layout-header">
      <!-- 品牌 -->
      <div
        class="brand"
        role="link"
        tabindex="0"
        @click="go('/home')"
        @keyup.enter="go('/home')"
      >
        <span
          class="brand-mark"
          aria-hidden="true"
        >
          <svg
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
          >
            <path
              d="M12 3.2 21 8l-9 4.8L3 8l9-4.8Z"
              fill="#fff"
              fill-opacity=".95"
            />
            <path
              d="M6.4 10.6v4.3c0 1.6 2.5 2.9 5.6 2.9s5.6-1.3 5.6-2.9v-4.3"
              stroke="#fff"
              stroke-width="1.6"
              stroke-linecap="round"
              fill="none"
              stroke-opacity=".9"
            />
          </svg>
        </span>
        <span class="brand-text">校园集市</span>
      </div>

      <!-- 移动端抽屉开关 -->
      <el-button
        v-if="appStore.device === 'mobile'"
        class="icon-btn"
        text
        circle
        aria-label="打开菜单"
        @click="drawerVisible = true"
      >
        <el-icon :size="18">
          <Menu />
        </el-icon>
      </el-button>

      <!-- 桌面端收起侧栏 -->
      <el-button
        v-else
        class="icon-btn"
        text
        circle
        :aria-label="appStore.sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'"
        @click="appStore.toggleSidebar"
      >
        <el-icon :size="17">
          <Fold v-if="!appStore.sidebarCollapsed" />
          <Expand v-else />
        </el-icon>
      </el-button>

      <!-- 搜索（参考图：药丸形 + 浅灰底，无边框） -->
      <div class="header-search">
        <el-input
          v-model="searchKw"
          placeholder="搜索二手商品 / 用户 / 标签"
          clearable
          @keyup.enter="onSearch"
        >
          <template #prefix>
            <el-icon class="search-icon">
              <Search />
            </el-icon>
          </template>
        </el-input>
      </div>

      <!-- 右侧动作区 -->
      <div class="header-actions">
        <el-button
          class="pill pill-publish"
          @click="go('/goods/publish')"
        >
          <el-icon :size="14">
            <EditPen />
          </el-icon>
          <span>发布</span>
        </el-button>

        <el-badge
          :value="messageStore.unreadText"
          :hidden="!messageStore.hasUnread"
          :offset="[-2, 2]"
        >
          <el-button
            class="pill pill-ghost"
            @click="go('/message')"
          >
            <el-icon :size="14">
              <ChatDotRound />
            </el-icon>
            <span class="hide-xs">消息</span>
          </el-button>
        </el-badge>

        <!-- 平台公告：铃铛图形（Notification 是后台「举报处理」的图标，别用混），
             未读角标与购物车同款：红底白字数字，位置也一致 -->
        <el-badge
          :value="noticeStore.unreadCount"
          :hidden="!appStore.settings.notifySystem || !noticeStore.hasUnread"
          :offset="[-2, 2]"
        >
          <el-button
            class="icon-btn"
            text
            circle
            :aria-label="noticeStore.hasUnread ? `平台公告，${noticeStore.unreadCount} 条未读` : '平台公告'"
            @click="go('/notice')"
          >
            <el-icon :size="18">
              <Bell />
            </el-icon>
          </el-button>
        </el-badge>

        <el-badge
          :value="cartStore.totalCount"
          :hidden="cartStore.totalCount === 0"
          :offset="[-2, 2]"
        >
          <el-button
            class="icon-btn"
            text
            circle
            aria-label="购物车"
            @click="go('/cart')"
          >
            <el-icon :size="18">
              <ShoppingCart />
            </el-icon>
          </el-button>
        </el-badge>

        <el-dropdown
          v-if="userStore.isLoggedIn"
          trigger="click"
          @command="onCommand"
        >
          <button
            class="user-chip"
            type="button"
            aria-label="账号菜单"
          >
            <el-avatar
              :src="userStore.avatar"
              :size="30"
              class="user-avatar"
            >
              {{ (userStore.nickname || '同').slice(0, 1) }}
            </el-avatar>
            <span class="user-name hide-xs">{{ userStore.nickname }}</span>
          </button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="profile">
                <el-icon><User /></el-icon>个人中心
              </el-dropdown-item>
              <el-dropdown-item command="settings">
                <el-icon><Tools /></el-icon>设置
              </el-dropdown-item>
              <el-dropdown-item
                v-if="userStore.isAdmin"
                command="admin"
              >
                <el-icon><Setting /></el-icon>管理后台
              </el-dropdown-item>
              <el-dropdown-item
                divided
                command="logout"
              >
                <el-icon><SwitchButton /></el-icon>退出登录
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>

        <el-button
          v-else
          type="primary"
          size="small"
          @click="go('/login')"
        >
          登录
        </el-button>
      </div>
    </header>

    <!-- ============================ 主体 ============================ -->
    <div class="layout-body">
      <!-- 桌面/平板常驻侧栏；移动端换成抽屉 -->
      <aside
        v-if="appStore.device !== 'mobile'"
        class="layout-aside"
        :class="{ 'is-collapsed': appStore.sidebarCollapsed }"
      >
        <nav class="side-nav">
          <el-menu
            :default-active="activePath"
            :collapse="appStore.sidebarCollapsed"
            :collapse-transition="false"
            router
            class="layout-menu"
          >
            <el-menu-item
              v-for="m in menus"
              :key="m.path"
              :index="m.path"
            >
              <el-icon><component :is="m.icon" /></el-icon>
              <template #title>
                {{ m.title }}
              </template>
            </el-menu-item>
          </el-menu>
        </nav>

        <div
          v-show="!appStore.sidebarCollapsed"
          class="side-foot"
        >
          <div class="side-tip">
            <span
              class="dot"
              aria-hidden="true"
            />
            平台担保交易 · 校内自提更快
          </div>
        </div>
      </aside>

      <el-drawer
        v-else
        v-model="drawerVisible"
        direction="ltr"
        :with-header="false"
        size="264px"
        class="side-drawer"
      >
        <MobileSidebarContent @close="drawerVisible = false" />
      </el-drawer>

      <main class="layout-main">
        <router-view v-slot="{ Component }">
          <transition
            name="fade-slide"
            mode="out-in"
          >
            <component :is="Component" />
          </transition>
        </router-view>
      </main>
    </div>

    <footer class="layout-footer">
      © 2026 校园二手集市 · Vue3 + Element Plus + ECharts
    </footer>

    <!-- Spring AI 智能客服悬浮入口（登录后可见） -->
    <AiAssistant />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAppStore } from '@/stores/modules/app'
import { useUserStore } from '@/stores/modules/user'
import { useCartStore } from '@/stores/modules/cart'
import { useMessageStore } from '@/stores/modules/message'
import { useNoticeStore } from '@/stores/modules/notice'
import MobileSidebarContent from './MobileSidebarContent.vue'
import AiAssistant from '@/components/common/AiAssistant.vue'
import { filterMenus } from './menuConfig'

const route = useRoute()
const router = useRouter()
const appStore = useAppStore()
const userStore = useUserStore()
const cartStore = useCartStore()
const messageStore = useMessageStore()
const noticeStore = useNoticeStore()

const searchKw = ref('')
const drawerVisible = ref(false)

const activePath = computed(() => route.path)

/*
 * 菜单按角色过滤：非管理员看不到「管理后台」。
 * ★ 第三个参数 isLoggedIn 是本次新增的维度 ★
 *   游客只看得到 `public` 那几项（商品广场 / 平台公告 / 关于）——
 *   否则游客会看到一整列点进去就被弹到登录页的菜单，属"能看不能点"，
 *   比不显示更差。判断依据见 menuConfig.ts 的 public 字段说明。
 */
const menus = computed(() =>
  filterMenus(userStore.isAdmin, userStore.roles[0], userStore.isLoggedIn)
)

function handleResize() {
  const w = window.innerWidth
  if (w < 640) appStore.setDevice('mobile')
  else if (w < 1024) appStore.setDevice('tablet')
  else appStore.setDevice('desktop')
}

function go(path: string) {
  router.push(path)
}

function onSearch() {
  const kw = searchKw.value.trim()
  if (!kw) return
  router.push({ path: '/goods', query: { keyword: kw } })
}

function onCommand(cmd: string) {
  if (cmd === 'logout') {
    userStore.logout()
    messageStore.reset()
    ElMessage.success('已退出登录')
    router.push('/login')
  }
  if (cmd === 'profile') router.push('/user/profile')
  if (cmd === 'settings') router.push('/settings')
  if (cmd === 'admin') router.push('/admin')
}

onMounted(() => {
  handleResize()
  window.addEventListener('resize', handleResize)
  noticeStore.load()
  if (userStore.isLoggedIn) {
    messageStore.loadSessions()
  }
})

// 路由切换时刷新公告未读态：管理员在后台新发一条公告后，红点会重新亮起
watch(
  () => route.path,
  (p, prev) => {
    if (p === prev) return
    noticeStore.load()
  }
)

// 登录态切换时同步消息
watch(
  () => userStore.profile?.id,
  (id, prev) => {
    if (id && id !== prev) messageStore.loadSessions()
    if (!id && prev) messageStore.reset()
  }
)

onUnmounted(() => window.removeEventListener('resize', handleResize))
</script>

<style scoped lang="scss">
@use '@/styles/variables.scss' as *;

/* ============================================================
   布局骨架
   关键：整个布局钉死在视口内（height:100vh + overflow:hidden），
   由 aside / main 各自独立滚动 —— 避免整页滚动把侧栏和头部卷走。
   ============================================================ */
.layout-root {
  height: 100vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background: var(--bg-page);
}

/* ---------------------------- 顶部导航 ---------------------------- */
.layout-header {
  height: $header-h;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: $sp-3;
  padding: 0 $sp-5;
  background: var(--bg-card);
  border-bottom: 1px solid var(--border-color);
  position: relative;
  z-index: $z-header;
}

/* 品牌：橙渐变圆形标记 + 文字 */
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  cursor: pointer;
  padding: 4px 6px 4px 0;
  border-radius: $radius-sm;
  transition: opacity $dur-base $ease-out;

  &:hover .brand-mark {
    transform: rotate(-6deg) scale(1.05);
    box-shadow: 0 6px 14px -4px rgba(255, 106, 0, 0.55);
  }

  .brand-mark {
    width: 34px;
    height: 34px;
    display: grid;
    place-items: center;
    border-radius: $radius-pill;
    background: linear-gradient(135deg, #ff9a3d 0%, $brand-orange 55%, #f25400 100%);
    box-shadow: 0 4px 10px -3px rgba(255, 106, 0, 0.5);
    transition: transform $dur-slow $ease-out, box-shadow $dur-slow $ease-out;
  }

  .brand-text {
    font-size: 17px;
    font-weight: $fw-bold;
    color: var(--color-text-primary);
    letter-spacing: 0.02em;
    white-space: nowrap;
  }
}

/* 圆形图标按钮：统一 34×34，命中区域充足 */
.icon-btn {
  width: 34px;
  height: 34px;
  flex-shrink: 0;
  color: var(--color-text-secondary);
  &:hover { color: var(--color-primary); background: var(--bg-hover); }
}

/* 搜索：药丸 + 浅灰底 + 无描边（对齐参考图） */
.header-search {
  flex: 1 1 auto;
  max-width: 420px;
  margin-left: $sp-1;

  :deep(.el-input__wrapper) {
    height: 36px;
    border-radius: $radius-pill;
    background: var(--bg-soft);
    box-shadow: 0 0 0 1px transparent inset;
    padding: 0 14px;
    transition: background-color $dur-base $ease-out, box-shadow $dur-base $ease-out;

    &:hover { background: var(--bg-hover); }

    &.is-focus {
      background: var(--bg-card);
      box-shadow: 0 0 0 1px var(--color-primary) inset, 0 0 0 3px rgba(37, 99, 235, 0.12);
    }
  }
  :deep(.el-input__inner) { font-size: $fs-13; }
  .search-icon { color: var(--color-text-mute); }
}

.header-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;

  :deep(.el-badge__content) {
    border: 2px solid var(--bg-card);
    font-size: 11px;
    height: 16px;
    line-height: 12px;
    padding: 0 5px;
  }
}

/* 药丸按钮：参考图头部的「发布 / 消息」 */
.pill {
  height: 34px;
  padding: 0 18px;
  border-radius: $radius-pill;
  border: none;
  font-size: $fs-13;
  font-weight: $fw-medium;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  transition: background-color $dur-base $ease-out, color $dur-base $ease-out,
    box-shadow $dur-base $ease-out, transform $dur-base $ease-out;

  &:active { transform: scale(0.97); }

  &.pill-publish {
    background: var(--color-primary);
    color: #fff;
    box-shadow: 0 2px 8px -2px rgba(37, 99, 235, 0.5);
    &:hover,
    &:focus {
      background: var(--color-primary-hover);
      color: #fff;
      box-shadow: $shadow-primary;
    }
  }

  &.pill-ghost {
    background: var(--bg-soft);
    color: var(--color-text-secondary);
    &:hover,
    &:focus {
      background: #e9ebef;
      color: var(--color-text-primary);
    }
  }
}

/* 用户胶囊 */
.user-chip {
  display: flex;
  align-items: center;
  gap: 7px;
  height: 38px;
  padding: 0 10px 0 4px;
  border: 1px solid transparent;
  border-radius: $radius-pill;
  background: transparent;
  transition: background-color $dur-base $ease-out, border-color $dur-base $ease-out;

  &:hover { background: var(--bg-soft); border-color: var(--border-color); }

  .user-avatar {
    background: linear-gradient(135deg, #ffb066, $brand-orange);
    color: #fff;
    font-weight: $fw-semibold;
    font-size: 13px;
    flex-shrink: 0;
  }
  .user-name {
    font-size: $fs-13;
    font-weight: $fw-medium;
    color: var(--color-text-primary);
    max-width: 88px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

/* ---------------------------- 主体 ---------------------------- */
.layout-body {
  flex: 1 1 auto;
  min-height: 0; /* 关键：允许 flex 子项收缩到比内容小，main 才能独立滚动 */
  display: flex;
  overflow: hidden;
}

/* 侧栏：白底浅色（参考图），不再是深色 #001529 */
.layout-aside {
  width: $sidebar-w;
  flex-shrink: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-card);
  border-right: 1px solid var(--border-color);
  overflow-y: auto;
  overflow-x: hidden;
  transition: width $dur-slow $ease-out;

  scrollbar-width: thin;
  scrollbar-color: var(--border-color) transparent;
  &::-webkit-scrollbar { width: 6px; }
  &::-webkit-scrollbar-thumb {
    background: var(--border-color);
    border-radius: 3px;
    &:hover { background: var(--border-color-strong); }
  }
  &::-webkit-scrollbar-track { background: transparent; }

  &.is-collapsed { width: $sidebar-w-collapsed; }
}

.side-nav {
  flex: 1 1 auto;
  padding: $sp-3 0 $sp-2;
}

.layout-menu {
  border-right: none;
  background: transparent;
  --el-menu-bg-color: transparent;
  --el-menu-text-color: var(--color-text-secondary);
  --el-menu-hover-bg-color: var(--bg-hover);
  --el-menu-active-color: var(--color-primary);
  --el-menu-item-height: 42px;
  --el-menu-base-level-padding: 12px;

  :deep(.el-menu-item) {
    position: relative;
    height: 42px;
    line-height: 42px;
    margin: 2px 10px;
    padding-left: 12px !important;
    padding-right: 10px !important;
    border-radius: $radius-sm;
    font-size: $fs-14;
    font-weight: $fw-medium;
    transition: background-color $dur-base $ease-out, color $dur-base $ease-out;

    .el-icon {
      font-size: 17px;
      margin-right: 10px;
      width: 17px;
      color: inherit;
    }

    /* 激活态：浅蓝底 + 蓝字 + 左侧指示条（参考图） */
    &.is-active {
      background: var(--color-primary-soft);
      color: var(--color-primary);
      font-weight: $fw-semibold;

      &::before {
        content: '';
        position: absolute;
        left: -10px;
        top: 50%;
        transform: translateY(-50%);
        width: 3px;
        height: 20px;
        border-radius: 0 3px 3px 0;
        background: var(--color-primary);
      }
    }
  }

  /* 收起态：图标居中，取消左右外边距带来的偏移 */
  &.el-menu--collapse {
    :deep(.el-menu-item) {
      margin: 2px 8px;
      padding-left: 0 !important;
      padding-right: 0 !important;
      justify-content: center;
      .el-icon { margin-right: 0; }
      &.is-active::before { left: -8px; }
    }
  }
}

/* 侧栏底部提示，填充视觉留白 */
.side-foot {
  flex-shrink: 0;
  padding: $sp-3 $sp-4 $sp-4;
}

.side-tip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  border-radius: $radius-sm;
  background: $brand-orange-soft;
  border: 1px solid $brand-orange-line;
  color: #b45309;
  font-size: $fs-12;
  line-height: 1.5;

  /* 深色下浅橙底配深棕字同样刺眼：转暗橙底 + 浅琥珀字 */
  html.dark & {
    background: rgba(255, 106, 0, 0.12);
    border-color: rgba(255, 106, 0, 0.3);
    color: #f2c08a;
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: $brand-orange;
    flex-shrink: 0;
  }
}

/* 主内容区：独立滚动 */
.layout-main {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: $sp-5;
  background: var(--bg-page);
  -webkit-overflow-scrolling: touch;

  scrollbar-width: thin;
  scrollbar-color: #d2d6dc transparent;
  &::-webkit-scrollbar { width: 8px; }
  &::-webkit-scrollbar-thumb {
    background: #d2d6dc;
    border-radius: 4px;
    &:hover { background: #b9bfc7; }
  }
  &::-webkit-scrollbar-track { background: transparent; }
}

.layout-footer {
  flex-shrink: 0;
  padding: 14px $sp-5;
  text-align: center;
  font-size: $fs-12;
  color: var(--color-text-mute);
  background: var(--bg-card);
  border-top: 1px solid var(--border-color);
}

/* ---------------------------- 路由过渡 ---------------------------- */
.fade-slide-enter-active,
.fade-slide-leave-active {
  transition: opacity $dur-base $ease-out, transform $dur-base $ease-out;
}
.fade-slide-enter-from { opacity: 0; transform: translateY(8px); }
.fade-slide-leave-to { opacity: 0; transform: translateY(-6px); }

/* ---------------------------- 响应式 ---------------------------- */
@media (max-width: $breakpoint-sm) {
  .layout-header { padding: 0 $sp-4; gap: $sp-2; }
  .header-search { display: none; }
  .layout-main { padding: $sp-4; }
  .pill { padding: 0 14px; }
}

@media (prefers-reduced-motion: reduce) {
  .brand:hover .brand-mark { transform: none; }
  .layout-aside { transition: none; }
}
</style>
