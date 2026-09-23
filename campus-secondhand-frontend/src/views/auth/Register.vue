<template>
  <div class="auth-page">
    <div class="auth-card">
      <div class="brand">
        <span class="brand-icon">🎓</span>
        <span>校园二手集市</span>
      </div>
      <h2 class="title">
        注册账号
      </h2>
      <p class="sub">
        几秒钟创建账号，开启你的二手交易
      </p>

      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-width="0"
        size="large"
      >
        <el-form-item prop="nickname">
          <el-input
            v-model="form.nickname"
            placeholder="昵称（将显示在个人主页）"
            prefix-icon="UserFilled"
          />
        </el-form-item>
        <el-form-item prop="username">
          <el-input
            v-model="form.username"
            placeholder="用户名（4-20 位字母/数字）"
            prefix-icon="User"
          />
        </el-form-item>
        <el-form-item prop="password">
          <el-input
            v-model="form.password"
            type="password"
            show-password
            placeholder="密码（≥ 6 位）"
            prefix-icon="Lock"
          />
        </el-form-item>
        <el-form-item prop="confirm">
          <el-input
            v-model="form.confirm"
            type="password"
            show-password
            placeholder="确认密码"
            prefix-icon="Lock"
          />
        </el-form-item>
        <el-form-item prop="agree">
          <el-checkbox v-model="form.agree">
            我已阅读并同意 <el-link
              type="primary"
              :underline="false"
            >
              《服务协议》
            </el-link>
            与 <el-link
              type="primary"
              :underline="false"
            >
              《隐私政策》
            </el-link>
          </el-checkbox>
        </el-form-item>
        <el-form-item>
          <el-button
            type="primary"
            :loading="loading"
            class="submit-btn"
            @click="onSubmit"
          >
            立即注册
          </el-button>
        </el-form-item>
      </el-form>

      <div class="extra-link">
        已有账号？<el-link
          type="primary"
          :underline="false"
          @click="$router.push('/login')"
        >
          直接登录
        </el-link>
      </div>

      <div class="footer-info">
        © 2026 校园二手集市 · 基于 Vue 3 + Element Plus + ECharts
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { FormInstance, FormRules } from 'element-plus'
import { useUserStore } from '@/stores/modules/user'

const router = useRouter()
const userStore = useUserStore()

const form = reactive({
  nickname: '',
  username: '',
  password: '',
  confirm: '',
  agree: false
})

const formRef = ref<FormInstance>()
const loading = ref(false)

const validateConfirm = (_rule: any, value: string, cb: (e?: Error) => void) => {
  if (value !== form.password) cb(new Error('两次密码不一致'))
  else cb()
}

const rules: FormRules = {
  nickname: [
    { required: true, message: '请输入昵称', trigger: 'blur' },
    { min: 2, max: 16, message: '昵称长度 2-16', trigger: 'blur' }
  ],
  username: [
    { required: true, message: '请输入用户名', trigger: 'blur' },
    { min: 4, max: 20, message: '4-20 位', trigger: 'blur' },
    { pattern: /^[a-zA-Z0-9_]+$/, message: '仅字母 / 数字 / 下划线', trigger: 'blur' }
  ],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
    { min: 6, message: '至少 6 位', trigger: 'blur' }
  ],
  confirm: [
    { required: true, message: '请再次输入密码', trigger: 'blur' },
    { validator: validateConfirm, trigger: 'blur' }
  ],
  agree: [
    {
      validator: (_r, value, cb) => (value ? cb() : cb(new Error('请先阅读并同意协议'))),
      trigger: 'change'
    }
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
    await userStore.register({
      nickname: form.nickname,
      username: form.username,
      password: form.password
    })
    ElMessage.success('注册成功，已为你自动登录')
    router.replace('/home')
  } catch (e: any) {
    ElMessage.error(e?.message || '注册失败')
  } finally {
    loading.value = false
  }
}
</script>

<style scoped lang="scss">
.auth-page {
  min-height: 100vh;
  display: flex; align-items: center; justify-content: center;
  background:
    radial-gradient(800px 400px at 20% 30%, rgba(124,58,237,.18), transparent 60%),
    radial-gradient(700px 350px at 80% 80%, rgba(37,99,235,.18), transparent 60%),
    linear-gradient(135deg, #1e3a8a 0%, #2563eb 55%, #7c3aed 100%);
  padding: 20px;
}
.auth-card {
  width: 100%;
  max-width: 440px;
  background: #fff;
  border-radius: 18px;
  padding: 36px 32px 28px;
  box-shadow: 0 24px 64px rgba(15, 23, 42, 0.28);
}
.brand {
  display: flex; align-items: center; gap: 8px;
  font-size: 18px; font-weight: 700; color: var(--color-primary);
  .brand-icon { font-size: 24px; }
}
.title { margin-top: 22px; font-size: 22px; font-weight: 700; }
.sub { color: var(--color-text-mute); font-size: 13px; margin: 4px 0 18px; }
.submit-btn { width: 100%; }
.extra-link {
  margin-top: 14px;
  text-align: center;
  font-size: 13px;
  color: var(--color-text-secondary);
}
.footer-info {
  margin-top: 18px;
  text-align: center;
  font-size: 11px;
  color: var(--color-text-mute);
}
</style>
