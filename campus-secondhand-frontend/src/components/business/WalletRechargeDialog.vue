<!--
  校园币充值弹窗

  ★ 这个组件补的是「余额从哪来」这个缺了的口子 ★
  改造前全站没有任何充值入口：非种子账号余额恒为 0.00，收银台却写着
  「使用校园币余额直接支付」，点下去必然提示余额不足，且无处可以加钱。
  这个弹窗就是那个入口，收银台与设置页共用同一个。

  ★ requestId（幂等键）的生命周期，改之前先读完 ★
    · 打开弹窗      → 生成一个新的键
     · 提交失败重试  → **复用**同一个键（后端据此判定是重复提交，不会加两次钱）
     · 用户改了金额  → 换一个新的键（这是一笔**新的**充值，不是上一次的重试）
  若「改金额」不换键，第二次充值会被后端当成上一次的重放而拒绝入账 ——
  用户会看到"已处理"但余额没变。若「重试」换了键，断网重试就会重复加钱。
-->
<template>
  <el-dialog
    :model-value="modelValue"
    title="校园币充值"
    width="420px"
    :close-on-click-modal="false"
    @update:model-value="onVisibleChange"
    @open="onOpen"
  >
    <div class="wr">
      <!-- 当前余额 -->
      <div class="wr-balance">
        <span class="wr-balance-label">当前余额</span>
        <span class="wr-balance-value">
          <template v-if="balanceLoading">—</template>
          <template v-else>¥{{ balance.toFixed(2) }}</template>
        </span>
      </div>

      <!-- 快捷档位 -->
      <div class="wr-presets">
        <el-button
          v-for="p in RECHARGE_PRESETS"
          :key="p"
          size="small"
          :type="amount === p ? 'primary' : 'default'"
          :plain="amount !== p"
          @click="amount = p"
        >
          ¥{{ p }}
        </el-button>
      </div>

      <!-- 自定义金额 -->
      <div class="wr-field">
        <span class="wr-field-label">充值金额</span>
        <el-input-number
          v-model="amount"
          :min="MIN_RECHARGE"
          :max="MAX_RECHARGE"
          :precision="2"
          :step="10"
          :disabled="submitting"
          controls-position="right"
          class="wr-input"
        />
      </div>
      <p class="wr-hint">
        单笔 ¥{{ MIN_RECHARGE.toFixed(2) }} ~ ¥{{ MAX_RECHARGE.toFixed(2) }}；
        充值后余额与流水同时入账，可立即用于钱包支付
      </p>

      <!-- 错误提示：贴在输入框下方，而不是弹一个全局 toast -->
      <p
        v-if="errorText"
        class="wr-error"
      >
        {{ errorText }}
      </p>
    </div>

    <template #footer>
      <el-button
        :disabled="submitting"
        @click="close"
      >
        取消
      </el-button>
      <el-button
        type="primary"
        :loading="submitting"
        @click="submit"
      >
        确认充值
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import {
  fetchWallet,
  rechargeWallet,
  newRechargeRequestId,
  MIN_RECHARGE,
  MAX_RECHARGE,
  RECHARGE_PRESETS
} from '@/api/wallet'

const props = defineProps<{
  modelValue: boolean
  /** 父级若已知余额可传入，省一次查询；不传则打开时自己查 */
  balance?: number
}>()

const emit = defineEmits<{
  'update:modelValue': [v: boolean]
  /** 充值成功。携带**服务端返回**的入账后余额，父级直接用它刷新显示 */
  success: [balance: number]
}>()

const amount = ref(100)
const balance = ref(0)
const balanceLoading = ref(false)
const submitting = ref(false)
const errorText = ref('')

/** 幂等键。生命周期见文件头注释 */
let requestId = newRechargeRequestId()

/**
 * 打开弹窗时重置状态。
 *
 * ★ 每次都换一个新的幂等键 ★
 * 上一轮的键在后端已经用掉了（成功或已被拒），留着它的唯一后果是
 * 「关掉再打开、充同样金额」被后端判定成重复提交而拒绝入账。
 */
async function onOpen() {
  requestId = newRechargeRequestId()
  errorText.value = ''
  submitting.value = false
  balance.value = props.balance ?? 0
  if (props.balance != null) return
  balanceLoading.value = true
  try {
    const w = await fetchWallet()
    balance.value = Number(w.balance) || 0
  } catch {
    // 查余额失败不阻塞充值：充值本身会回一个权威余额
    balance.value = 0
  } finally {
    balanceLoading.value = false
  }
}

/**
 * 金额变更 → 换幂等键。
 * 理由见文件头：改了金额就是一笔新充值，沿用旧键会被后端当成重放而拒绝。
 */
function onAmountChange() {
  requestId = newRechargeRequestId()
  errorText.value = ''
}

/*
 * 用 watch 而不是在 template 上绑 @change：预设按钮与输入框两条路径都要覆盖，
 * watch 一处即可 —— 否则以后加了新的输入路径却忘了绑事件，
 * 「改了金额但没换键」会让第二次充值被后端当成重放而拒绝入账。
 */
watch(amount, onAmountChange)

function onVisibleChange(v: boolean) {
  if (!v) close()
}

function close() {
  emit('update:modelValue', false)
}

async function submit() {
  errorText.value = ''
  submitting.value = true
  try {
    const r = await rechargeWallet(amount.value, requestId)
    ElMessage.success(r.message || '充值成功')
    // 用服务端返回的余额，不要本地累加（见 api/wallet.ts 的说明）
    emit('success', Number(r.balance) || 0)
    close()
  } catch (e) {
    /*
     * 把服务端的原话显示出来，而不是统一替换成「充值失败」。
     * 后端对「金额越界」「余额超上限」「重复提交」给的是三句不同的话，
     * 合并成一句会让用户不知道该改什么 —— 比如余额超上限时
     * 用户需要知道"改小一点"，看到"充值失败"只会一直重试同一个数。
     */
    errorText.value = e instanceof Error && e.message ? e.message : '充值失败，请稍后重试'
  } finally {
    submitting.value = false
  }
}
</script>

<style scoped lang="scss">
.wr {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.wr-balance {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 12px 14px;
  border-radius: var(--radius-md);
  background: var(--bg-soft);
  border: 1px solid var(--border-color);

  .wr-balance-label {
    font-size: 13px;
    color: var(--color-text-mute);
  }
  .wr-balance-value {
    font-size: 20px;
    font-weight: 600;
    color: var(--color-primary);
  }
}

.wr-presets {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.wr-field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;

  .wr-field-label {
    font-size: 13px;
    color: var(--color-text-secondary);
    flex-shrink: 0;
  }
  .wr-input {
    width: 190px;
  }
}

.wr-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-text-mute);
}

.wr-error {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-danger);
}
</style>
