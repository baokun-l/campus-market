<!--
  设置分组容器（iOS / 闲鱼风格的分组列表）
  - 顶部：分组标题
  - 内容：白底圆角卡片，包含若干 SettingsItem，子项之间用 1px 分割线连接
-->
<template>
  <section class="settings-group">
    <h3
      v-if="title"
      class="group-title"
    >
      {{ title }}
    </h3>
    <div class="group-card">
      <slot />
    </div>
  </section>
</template>

<script setup lang="ts">
defineProps<{ title?: string }>()
</script>

<style scoped lang="scss">
.settings-group { margin-bottom: 16px; }
.group-title {
  font-size: 13px;
  color: var(--color-text-mute);
  margin: 4px 8px 8px;
  font-weight: 600;
  text-transform: none;
  letter-spacing: 0.2px;
}
.group-card {
  background: #fff;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--border-color);
  :deep(.settings-item:not(:last-child)) {
    border-bottom: 1px solid var(--bg-soft);
  }
}
</style>
