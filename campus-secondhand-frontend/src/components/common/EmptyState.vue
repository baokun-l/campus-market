<template>
  <div class="empty-state">
    <div class="empty-icon">
      {{ icon }}
    </div>
    <div class="empty-title">
      {{ title }}
    </div>
    <div class="empty-desc">
      {{ description }}
    </div>
    <el-button
      v-if="actionText"
      type="primary"
      @click="emit('action')"
    >
      {{ actionText }}
    </el-button>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  icon?: string
  title?: string
  description?: string
  actionText?: string
}>()
const emit = defineEmits<{ action: [] }>()
</script>

<style scoped lang="scss">
.empty-state {
  text-align: center;
  padding: 48px 16px;
  color: var(--color-text-secondary);
  .empty-icon { font-size: 56px; margin-bottom: 12px; }
  .empty-title { font-size: 16px; font-weight: 600; color: var(--color-text-primary); }
  .empty-desc { margin: 6px 0 16px; font-size: 13px; }
}
</style>
