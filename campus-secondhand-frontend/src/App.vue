<template>
  <el-config-provider :locale="zhCn">
    <router-view />
  </el-config-provider>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from 'vue'
import zhCn from 'element-plus/dist/locale/zh-cn.mjs'
import { useAppStore } from '@/stores/modules/app'
import { useUserStore } from '@/stores/modules/user'
import { useOnlineStore } from '@/stores/modules/online'

// 启动时恢复本地偏好：深色模式 / 主题色 / 字号大小
const appStore = useAppStore()
onMounted(() => {
  appStore.applyPreferences()
})

/*
 * 在线心跳：跟随登录态启停。
 *
 * ★ 不能无条件启动 ★
 * 未登录时 `POST /user/heartbeat` 会拿到 401，而 request.ts 把 401 解释成
 * 「登录状态已过期」→ 弹窗 + 清 token + 跳登录页 —— 游客一进站就被踢。
 * 因此这里 watch 登录态：登录后开表，退出登录立刻停表，
 * 否则定时器会带着一个空 token 一直去打接口。
 *
 * ★ watch 的目标是 `isLoggedIn`，不是 `token`（D9）★
 * 真实模式下凭据在 HttpOnly Cookie 里，`token` 恒为空串 ——
 * 若继续 watch `token`，回调只会收到一个永远为空的值，
 * 结果是**心跳一次都不会发**：整站在线状态在真实模式下彻底失灵，
 * 而且不报错、不抛异常，只有真机演示「怎么全是离线」时才会发现。
 * `isLoggedIn` 两种模式都对：mock 看 token，真实看 sessionHint。
 */
const userStore = useUserStore()
const onlineStore = useOnlineStore()

watch(
  () => userStore.isLoggedIn,
  (loggedIn) => {
    if (loggedIn) onlineStore.startHeartbeat()
    else onlineStore.stopHeartbeat()
  },
  { immediate: true }
)

onBeforeUnmount(() => onlineStore.stopHeartbeat())
</script>

<style>
#app { min-height: 100vh; }
</style>
