<!--
  设置分组内的一行（iOS / 闲鱼风格的列表行）
  Props:
    icon:   Element Plus Icon 组件名
    label:  左侧主标题
    value:  右侧文字（如「未认证」），可省略
    hint:   第二行说明（可选）
    danger: 主标题高亮红色
    clickable / showChevron: 控制点击行为与箭头
  Slots:
    action: 自定义右侧操作（开关 / 按钮等）
  Emits:
    click: 点击整行（非 action 区）
-->
<template>
  <div
    class="settings-item"
    :class="{ danger, clickable }"
    @click="emit('click', $event)"
  >
    <el-icon
      v-if="icon"
      class="item-icon"
      :size="18"
    >
      <component :is="icon" />
    </el-icon>
    <div class="item-body">
      <div
        class="item-label"
        :class="{ danger }"
      >
        {{ label }}
      </div>
      <div
        v-if="hint"
        class="item-hint"
      >
        {{ hint }}
      </div>
    </div>
    <div
      class="item-right"
      @click.stop
    >
      <slot name="action">
        <span
          v-if="value"
          class="item-value"
        >{{ value }}</span>
        <el-icon
          v-if="showChevron && clickable"
          class="item-chevron"
        >
          <ArrowRight />
        </el-icon>
      </slot>
    </div>
  </div>
</template>

<script setup lang="ts">
interface Props {
  icon?: string
  label: string
  value?: string
  hint?: string
  danger?: boolean
  clickable?: boolean
  showChevron?: boolean
}
withDefaults(defineProps<Props>(), {
  clickable: true,
  showChevron: true,
  danger: false
})
const emit = defineEmits<{ click: [e: MouseEvent] }>()
</script>

<style scoped lang="scss">
.settings-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  background: var(--bg-card);
  transition: background 0.15s;
  cursor: default;
  &.clickable { cursor: pointer; }
  &.clickable:hover { background: var(--bg-soft); }

  .item-icon {
    color: var(--color-text-mute);
    flex-shrink: 0;
  }

  .item-body { flex: 1; min-width: 0; }
  .item-label {
    font-size: 14px;
    font-weight: 500;
    color: var(--color-text-primary);
    line-height: 1.5;
    &.danger { color: var(--color-danger); }
  }
  .item-hint {
    font-size: 12px;
    color: var(--color-text-mute);
    margin-top: 2px;
    line-height: 1.4;
  }

  .item-right {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--color-text-mute);
    font-size: 13px;
    flex-shrink: 0;
  }
  .item-value { font-size: 13px; }
  .item-chevron { font-size: 14px; color: var(--color-text-mute); }
}
</style>
