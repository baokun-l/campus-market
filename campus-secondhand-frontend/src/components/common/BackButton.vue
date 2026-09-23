<template>
  <button
    class="back-btn"
    type="button"
    aria-label="返回上一页"
    @click="onBack"
  >
    <el-icon><ArrowLeft /></el-icon>
    <span>返回</span>
  </button>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router'

/**
 * 子页面通用返回键（样式与商品详情页一致：胶囊、命中区 36px 高）。
 *
 * 直接深链打开（无站内历史）时 `router.back()` 会把用户带出站外，
 * 所以先看 history.state.back —— vue-router 写入的上一条站内路由，
 * 没有就回首页兜底。
 */
const router = useRouter()

function onBack() {
  if (window.history.state?.back) router.back()
  else router.push('/home')
}
</script>

<style scoped lang="scss">
/* 与 views/goods/Detail.vue 的 .back-btn 同一份视觉：改一处记得同步另一处 */
.back-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 36px;
  padding: 0 14px 0 10px;
  border: 1px solid transparent;
  border-radius: $radius-pill;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: $fs-13;
  font-family: inherit;
  cursor: pointer;
  transition: background-color $dur-base $ease-out, color $dur-base $ease-out,
    border-color $dur-base $ease-out;

  &:hover {
    background: var(--bg-card);
    border-color: var(--border-color);
    color: var(--color-text-primary);
  }
}
</style>
