<template>
  <div class="not-found">
    <div class="big">
      {{ code }}
    </div>
    <div class="title">
      {{ title }}
    </div>
    <div class="desc">
      {{ description }}
    </div>
    <el-button
      type="primary"
      size="large"
      @click="$router.push('/home')"
    >
      回到首页
    </el-button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()
const code = computed(() => (route.path === '/403' ? '403' : '404'))
const title = computed(() => (code.value === '403' ? '无访问权限' : '页面不存在'))
const description = computed(() =>
  code.value === '403' ? '你没有访问该页面的权限，请联系管理员' : '你找的页面可能已被下架或不存在'
)
</script>

<style scoped lang="scss">
.not-found {
  min-height: 100vh;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  background:
    radial-gradient(700px 350px at 50% 30%, rgba(37,99,235,.1), transparent 70%),
    var(--bg-page);
  padding: 24px;
  text-align: center;
}
.big { font-size: 96px; font-weight: 800; color: var(--color-primary); line-height: 1; letter-spacing: -3px; }
.title { font-size: 24px; font-weight: 700; margin: 12px 0 6px; }
.desc { color: var(--color-text-mute); margin-bottom: 22px; }
</style>
