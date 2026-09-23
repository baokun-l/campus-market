<template>
  <div class="page-container">
    <BackButton
      v-if="back"
      class="page-back"
    />
    <div class="page-header">
      <div>
        <h2 class="page-title">
          {{ title }}
        </h2>
        <p
          v-if="subtitle"
          class="page-sub"
        >
          {{ subtitle }}
        </p>
      </div>
      <div class="page-actions">
        <slot name="actions" />
      </div>
    </div>
    <el-card
      v-loading="loading"
      shadow="never"
      class="page-card"
    >
      <slot />
    </el-card>
    <slot name="footer" />
  </div>
</template>

<script setup lang="ts">
import BackButton from '@/components/common/BackButton.vue'

/**
 * `back`：给跳转进入的子页面显示左上角返回键（与商品详情页同款）。
 * 主入口页（首页 / 商品广场 / 管理后台）不要开，它们是导航起点。
 *
 * ★ `loading` 必须给默认值 ★
 * Element Plus 的 `v-loading` 指令签名是 `boolean | LoadingOptions`，**不含 undefined**；
 * 声明成 `loading?: boolean` 时模板里拿到的是 `boolean | undefined`，
 * vue-tsc 会报 TS2322（`Type 'undefined' is not assignable to type 'LoadingBinding'`）。
 * 用 withDefaults 收成确定的 `boolean`，比在模板里写 `loading ?? false` 更干净。
 */
withDefaults(
  defineProps<{ title: string; subtitle?: string; loading?: boolean; back?: boolean }>(),
  { loading: false, back: false }
)
</script>

<style scoped lang="scss">
.page-container { max-width: 1320px; margin: 0 auto; }
.page-back { margin-bottom: 2px; }
.page-header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 14px;
  .page-title { font-size: 20px; font-weight: 700; }
  .page-sub { color: var(--color-text-mute); font-size: 13px; margin-top: 2px; }
}
.page-card { border-radius: var(--radius-md); }

@media (max-width: 640px) {
  .page-header { flex-direction: column; align-items: flex-start; gap: 10px; }
}
</style>
