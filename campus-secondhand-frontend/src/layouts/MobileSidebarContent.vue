<template>
  <div class="mobile-sidebar">
    <div class="ms-brand">
      <span
        class="ms-mark"
        aria-hidden="true"
      >
        <svg
          viewBox="0 0 24 24"
          width="16"
          height="16"
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
      <span class="ms-text">校园集市</span>
    </div>

    <el-menu
      :default-active="route.path"
      router
      class="mobile-menu"
    >
      <el-menu-item
        v-for="m in menus"
        :key="m.path"
        :index="m.path"
        @click="emit('close')"
      >
        <el-icon><component :is="m.icon" /></el-icon>
        <template #title>
          {{ m.title }}
        </template>
      </el-menu-item>
    </el-menu>

    <div class="ms-foot">
      平台担保交易 · 校内自提更快
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useUserStore } from '@/stores/modules/user'
import { filterMenus } from './menuConfig'

const emit = defineEmits<{ close: [] }>()
const route = useRoute()
const userStore = useUserStore()

/** 移动端侧栏菜单同样按角色过滤；★ 第三个参数：游客只看到 public 项 */
const menus = computed(() =>
  filterMenus(userStore.isAdmin, userStore.roles[0], userStore.isLoggedIn)
)
</script>

<style scoped lang="scss">
@use '@/styles/variables.scss' as *;

.mobile-sidebar {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-card);
}

/* 与桌面端品牌保持同一视觉语言 */
.ms-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: $sp-4 $sp-4;
  border-bottom: 1px solid var(--border-color);

  .ms-mark {
    width: 30px;
    height: 30px;
    display: grid;
    place-items: center;
    border-radius: $radius-pill;
    background: linear-gradient(135deg, #ff9a3d 0%, $brand-orange 55%, #f25400 100%);
    box-shadow: 0 4px 10px -3px rgba(255, 106, 0, 0.5);
  }
  .ms-text {
    font-size: $fs-16;
    font-weight: $fw-bold;
    color: var(--color-text-primary);
    letter-spacing: 0.02em;
  }
}

.mobile-menu {
  flex: 1 1 auto;
  border-right: none;
  padding: $sp-2 0;
  --el-menu-bg-color: transparent;
  --el-menu-text-color: var(--color-text-secondary);
  --el-menu-hover-bg-color: var(--bg-hover);
  --el-menu-active-color: var(--color-primary);

  :deep(.el-menu-item) {
    position: relative;
    height: 44px;
    line-height: 44px;
    margin: 2px 10px;
    padding-left: 12px !important;
    border-radius: $radius-sm;
    font-size: $fs-14;
    font-weight: $fw-medium;

    .el-icon { font-size: 17px; margin-right: 10px; }

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
}

.ms-foot {
  flex-shrink: 0;
  margin: $sp-2 $sp-4 $sp-4;
  padding: 10px 12px;
  border-radius: $radius-sm;
  background: $brand-orange-soft;
  border: 1px solid $brand-orange-line;
  color: #b45309;
  font-size: $fs-12;
  line-height: 1.5;
}
</style>
