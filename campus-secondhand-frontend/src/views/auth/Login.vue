<template>
  <div class="login-page">
    <div class="login-card">
      <div class="brand">
        <span class="brand-icon">🎓</span>
        <span>校园二手集市</span>
      </div>
      <h2 class="title">
        欢迎回来
      </h2>
      <p class="sub">
        登录后开始你的二手交易之旅
      </p>

      <!--
        被踢下线的原因提示。
        会话失效（封禁 / token 过期）时守卫会带着 ?revoked=xxx 跳回这里，
        如果不解释一句，用户只会看到自己莫名退出了登录。
      -->
      <el-alert
        v-if="revokedTip"
        class="revoked-tip"
        type="error"
        :closable="true"
        show-icon
        :title="revokedTip"
        @close="onCloseRevoked"
      />

      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-width="0"
        size="large"
      >
        <el-form-item prop="username">
          <el-input
            v-model="form.username"
            placeholder="用户名 / 学号"
            prefix-icon="User"
          />
        </el-form-item>
        <el-form-item prop="password">
          <el-input
            v-model="form.password"
            type="password"
            show-password
            placeholder="密码"
            prefix-icon="Lock"
          />
        </el-form-item>
        <el-form-item>
          <el-button
            type="primary"
            :loading="loading"
            class="submit-btn"
            @click="onSubmit"
          >
            登 录
          </el-button>
        </el-form-item>
      </el-form>

      <div class="tips">
        <span>演示提示：任意用户名 + 密码 ≥ 6 位即可登录</span>
      </div>

      <!-- 快速切换演示账号（用于验证买家 / 卖家双视角） -->
      <el-collapse class="demo-collapse">
        <el-collapse-item name="1">
          <template #title>
            <span class="demo-title">🧪 演示账号（点击快速填充）</span>
          </template>
          <div class="demo-list">
            <div
              v-for="a in demoAccounts"
              :key="a.username"
              class="demo-item"
              @click="fillAccount(a.username)"
            >
              <div>
                <b>{{ a.nickname }}</b>
                <span class="demo-role">{{ a.role }}</span>
              </div>
              <code>{{ a.username }}</code>
            </div>
            <p class="demo-hint">
              用法：先用 <code>cs_xiao_zhang</code> 给某位卖家发消息，再退出登录用该卖家账号
              （如 <code>book_li</code>）登录，即可在「消息中心」看到对方视角下的同一条会话。
            </p>
          </div>
        </el-collapse-item>
      </el-collapse>

      <div class="extra-link">
        还没有账号？<el-link
          type="primary"
          :underline="false"
          @click="$router.push('/register')"
        >
          立即注册
        </el-link>
      </div>

      <div class="footer-info">
        © 2026 校园二手集市 · 基于 Vue 3 + Element Plus + ECharts
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { FormInstance, FormRules } from 'element-plus'
import { useUserStore } from '@/stores/modules/user'
import { demoAccounts } from '@/api/mock'

const router = useRouter()
const userStore = useUserStore()
const route = useRoute()

const form = reactive({ username: '', password: '' })
const formRef = ref<FormInstance>()
const loading = ref(false)

/**
 * 被踢下线的提示文案。
 * 优先用 store 里那句更具体的（含昵称），没有就按 query 给个兜底说明。
 */
const REVOKED_TEXT: Record<string, string> = {
  banned: '你的账号已被封禁，无法继续使用。若有疑问请联系管理员申诉。',
  expired: '登录状态已失效，请重新登录。'
}
const revokedTip = computed(() => {
  if (userStore.revokedMessage) return userStore.revokedMessage
  const key = String(route.query.revoked ?? '')
  return REVOKED_TEXT[key] ?? ''
})
function onCloseRevoked() {
  userStore.clearRevoked()
  // 顺手把 ?revoked= 从地址栏抹掉：刷新一次不该再弹同一条旧提示
  const q = { ...route.query }
  delete q.revoked
  router.replace({ path: '/login', query: q })
}

const rules: FormRules = {
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
    { min: 6, message: '密码至少 6 位', trigger: 'blur' }
  ]
}

async function onSubmit() {
  if (!formRef.value) return
  try {
    await formRef.value.validate()
  } catch {
    return
  }
  loading.value = true
  try {
    await userStore.login({ username: form.username, password: form.password })
    ElMessage.success(`欢迎回来，${userStore.nickname}`)
    const redirect = router.currentRoute.value.query.redirect as string
    router.replace(redirect || '/home')
  } catch (e: any) {
    ElMessage.error(e?.message || '登录失败')
  } finally {
    loading.value = false
  }
}

/** 点击演示账号快速填充 */
function fillAccount(username: string) {
  form.username = username
  form.password = username === 'admin' ? 'admin123' : '123456'
}
</script>

<style scoped lang="scss">
.login-page {
  min-height: 100vh;
  display: flex; align-items: center; justify-content: center;
  background:
    radial-gradient(800px 400px at 20% 30%, rgba(37,99,235,.15), transparent 60%),
    radial-gradient(700px 350px at 80% 80%, rgba(124,58,237,.18), transparent 60%),
    linear-gradient(135deg, #0f172a 0%, #1e3a8a 60%, #2563eb 100%);
  padding: 20px;
}
.login-card {
  width: 100%;
  max-width: 420px;
  background: #fff;
  border-radius: 16px;
  padding: 36px 30px;
  box-shadow: 0 24px 64px rgba(15, 23, 42, 0.25);
}
.brand {
  display: flex; align-items: center; gap: 8px;
  font-size: 18px; font-weight: 700; color: var(--color-primary);
  .brand-icon { font-size: 24px; }
}
.title { margin-top: 24px; font-size: 22px; font-weight: 700; }
.sub { color: var(--color-text-mute); font-size: 13px; margin-top: 4px; margin-bottom: 20px; }
/* 被踢下线的原因提示：压在表单上方，别把「欢迎回来」挤得太远 */
.revoked-tip {
  margin: -8px 0 18px;
  text-align: left;
  :deep(.el-alert__title) { font-size: 12px; line-height: 1.6; }
}
.submit-btn { width: 100%; }
.tips {
  background: var(--bg-soft);
  border-radius: 8px;
  padding: 10px 12px;
  font-size: 12px;
  color: var(--color-text-mute);
  code { background: #fff; padding: 1px 5px; border-radius: 4px; color: var(--color-accent); }
}
.extra-link {
  margin-top: 14px;
  text-align: center;
  font-size: 13px;
  color: var(--color-text-secondary);
}

.demo-collapse {
  margin-top: 10px;
  --el-collapse-header-bg-color: transparent;
  --el-collapse-content-bg-color: transparent;
  :deep(.el-collapse-item__header) {
    border-bottom: none;
    font-size: 12.5px;
    color: var(--color-text-mute);
    height: 32px;
    line-height: 32px;
  }
  :deep(.el-collapse-item__wrap) { border-bottom: none; }
  :deep(.el-collapse-item__content) { padding-bottom: 4px; }

  .demo-title { font-size: 12.5px; }
  .demo-list { display: flex; flex-direction: column; gap: 6px; }
  .demo-item {
    display: flex; justify-content: space-between; align-items: center;
    background: var(--bg-soft);
    border-radius: 6px;
    padding: 7px 10px;
    font-size: 12px;
    cursor: pointer;
    transition: all 0.15s;
    &:hover { background: var(--color-primary-light); }
    b { font-weight: 600; }
    .demo-role { color: var(--color-text-mute); margin-left: 6px; }
    code {
      background: #fff; padding: 1px 6px; border-radius: 4px;
      color: var(--color-accent); font-size: 11.5px;
    }
  }
  .demo-hint {
    margin-top: 6px;
    font-size: 11.5px;
    line-height: 1.6;
    color: var(--color-text-mute);
    code { background: #fff; padding: 1px 5px; border-radius: 3px; color: var(--color-accent); }
  }
}

.footer-info {
  margin-top: 16px;
  text-align: center;
  font-size: 11px;
  color: var(--color-text-mute);
}
</style>
