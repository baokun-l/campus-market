<template>
  <!--
    @closed 上归还焦点：不归还的话，抽屉/弹窗关闭后焦点会留在浮层内的哨兵元素上，
    页面上其它 el-select 会因此「点一下没反应」（详见 utils/focus.ts 的推导）
  -->
  <el-drawer
    v-model="visible"
    size="520px"
    append-to-body
    :with-header="false"
    @closed="releaseOverlayFocus"
  >
    <template v-if="order">
      <div class="od-drawer">
        <!-- ============ 头部：订单号 + 状态 + 异常标记 ============ -->
        <div class="od-head">
          <div class="od-head-main">
            <span class="od-title">订单详情</span>
            <el-tag
              :type="ORDER_STATUS_TAG[order.status]"
              size="small"
            >
              {{ ORDER_STATUS_LABEL[order.status] }}
            </el-tag>
            <!-- 超时标记放在最显眼的位置：后台看列表时这是最该先处理的一类 -->
            <el-tag
              v-if="issue"
              :type="issue.level === 'danger' ? 'danger' : 'warning'"
              effect="dark"
              size="small"
            >
              {{ issue.text }}
            </el-tag>
          </div>
          <span class="od-no adm-num">{{ order.id }}</span>
        </div>
        <p class="od-sub">
          创建于 {{ formatDate(order.createTime, 'YYYY-MM-DD HH:mm') }}
          <template v-if="order.payTime">
            · 付款 {{ formatDate(order.payTime, 'MM-DD HH:mm') }}
          </template>
        </p>

        <!-- ============ 商品 ============ -->
        <div class="od-goods">
          <el-image
            :src="order.goods.cover"
            fit="cover"
            class="od-img"
          />
          <div class="od-goods-txt">
            <span class="od-goods-name">{{ order.goods.title }}</span>
            <span class="od-goods-meta">
              数量 × {{ order.quantity ?? 1 }} · 商品 #{{ order.goods.id }}
            </span>
          </div>
          <span class="od-amount">¥{{ order.amount.toFixed(2) }}</span>
        </div>

        <!-- ============ 金额拆分（对账四件套） ============ -->
        <div class="od-block">
          <p class="od-block-title">
            金额拆分
          </p>
          <template v-if="order.listPrice != null">
            <div class="od-kv">
              <span>卖家挂牌价</span><b>¥{{ order.listPrice.toFixed(2) }}</b>
            </div>
            <div class="od-kv">
              <span>买家实付</span><b class="is-price">¥{{ order.amount.toFixed(2) }}</b>
            </div>
            <div class="od-kv">
              <span>卖家让利{{ order.fundSource === 'seller' ? '（出资方）' : '' }}</span>
              <b>¥{{ (order.sellerCut ?? 0).toFixed(2) }}</b>
            </div>
            <div class="od-kv">
              <span>平台补贴{{ order.fundSource === 'platform' ? '（出资方）' : '' }}</span>
              <b>¥{{ (order.platformSubsidy ?? 0).toFixed(2) }}</b>
            </div>
            <div class="od-kv">
              <span>卖家实收</span><b>¥{{ (order.sellerIncome ?? 0).toFixed(2) }}</b>
            </div>
            <p
              v-if="order.activityId"
              class="od-note"
            >
              本单参加了活动 <b>{{ order.activityId }}</b>，让利成本由{{
                order.fundSource === 'platform' ? '平台承担，卖家实收不变' : '卖家承担，卖家实收已扣减'
              }}。
            </p>
          </template>
          <p
            v-else
            class="od-note"
          >
            历史订单未保留价格拆分快照，实付 ¥{{ order.amount.toFixed(2) }}。
          </p>
        </div>

        <!-- ============ 退款单（有则展示，售后处理的核心凭据） ============ -->
        <div
          v-if="order.refund || order.refundTime || order.cancelReason"
          class="od-block"
        >
          <p class="od-block-title">
            售后 / 关闭记录
          </p>
          <template v-if="order.refund">
            <div class="od-kv">
              <span>退款原因</span><b>{{ order.refund.reason }}</b>
            </div>
            <div class="od-kv">
              <span>发起方</span><b>{{ order.refund.by === 'buyer' ? '买家申请' : '平台发起' }}</b>
            </div>
            <div class="od-kv">
              <span>申请时间</span><b>{{ formatDate(order.refund.time, 'YYYY-MM-DD HH:mm') }}</b>
            </div>
            <div class="od-kv">
              <span>退款金额</span><b class="is-danger">¥{{ order.refund.amount.toFixed(2) }}</b>
            </div>
            <div
              v-if="order.refund.remark"
              class="od-kv"
            >
              <span>处理备注</span><b>{{ order.refund.remark }}</b>
            </div>
          </template>
          <div
            v-if="order.refundTime"
            class="od-kv"
          >
            <span>退款完成</span><b>{{ formatDate(order.refundTime, 'YYYY-MM-DD HH:mm') }}</b>
          </div>
          <p
            v-if="order.status === 'refunding'"
            class="od-note is-warning"
          >
            买家已提交退款申请，尚未处理。审批后订单将关闭并把款项退回买家。
          </p>
          <p
            v-else-if="order.cancelReason"
            class="od-note"
          >
            关闭原因：{{ order.cancelReason.text }}（{{ formatDate(order.cancelReason.time, 'MM-DD HH:mm') }}）
          </p>
        </div>

        <!-- ============ 交易与物流 ============ -->
        <div class="od-block">
          <p class="od-block-title">
            交易与物流
          </p>
          <div class="od-kv">
            <span>收货地址</span><b>{{ order.address || '—' }}</b>
          </div>
          <div class="od-kv">
            <span>承运 / 运单号</span>
            <b class="adm-num">
              <template v-if="order.trackingNo">
                {{ order.logisticsCompany || '未指定承运商' }} · {{ order.trackingNo }}
              </template>
              <template v-else>尚未发货</template>
            </b>
          </div>
          <div
            v-if="order.remark"
            class="od-kv"
          >
            <span>买家备注</span><b>{{ order.remark }}</b>
          </div>

          <!-- 物流轨迹：发货后才有内容，未发货直接给出下一步该做什么 -->
          <div class="od-traces">
            <p class="od-traces-title">
              物流轨迹
              <span
                v-if="!order.traces?.length"
                class="adm-muted"
              >（尚未产生）</span>
            </p>
            <ol
              v-if="order.traces?.length"
              class="od-trace-list"
            >
              <li
                v-for="(t, i) in order.traces"
                :key="t.time + i"
                :class="{ 'is-latest': i === 0 }"
              >
                <span class="od-trace-dot" />
                <span class="od-trace-txt">{{ t.text }}</span>
                <span class="od-trace-time adm-num">{{ formatDate(t.time, 'MM-DD HH:mm') }}</span>
              </li>
            </ol>
            <p
              v-else
              class="od-note"
            >
              发货后承运方会回传轨迹，可据此向买家解释在途情况。
            </p>
          </div>
        </div>

        <!-- ============ 买卖双方（信用分是判断风险的第一依据） ============ -->
        <div class="od-block">
          <p class="od-block-title">
            交易双方
          </p>
          <div class="od-pair">
            <div
              v-for="p in parties"
              :key="p.role"
              class="od-party"
            >
              <el-avatar
                :size="34"
                :src="p.avatar"
              >
                {{ p.nickname.slice(0, 1) }}
              </el-avatar>
              <div class="od-party-txt">
                <span class="od-party-role">{{ p.role === 'buyer' ? '买家' : '卖家' }}</span>
                <span class="od-party-name">{{ p.nickname }}</span>
              </div>
              <div class="od-party-right">
                <el-tag
                  :type="creditTag(p.creditScore)"
                  size="small"
                  effect="plain"
                >
                  信用 {{ p.creditScore ?? '—' }}
                </el-tag>
                <el-button
                  text
                  type="primary"
                  size="small"
                  @click="openUser(p)"
                >
                  查看主页
                </el-button>
              </div>
            </div>
          </div>
        </div>

        <!-- ============ 订单进度 ============ -->
        <div class="od-block">
          <p class="od-block-title">
            订单进度
          </p>
          <ol class="od-timeline">
            <li
              v-for="n in timelineOf(order)"
              :key="n.label"
              :class="{ done: !!n.time }"
            >
              <span class="od-dot" />
              <span class="od-label">{{ n.label }}</span>
              <span class="od-time adm-num">{{ n.time ? formatDate(n.time, 'MM-DD HH:mm') : '—' }}</span>
            </li>
          </ol>
        </div>

        <!-- ============ 操作日志（谁在什么时候做了什么） ============ -->
        <div class="od-block">
          <div class="od-block-head">
            <p class="od-block-title">
              操作日志
            </p>
            <span class="adm-muted">共 {{ order.logs?.length ?? 0 }} 条</span>
          </div>
          <ul
            v-if="order.logs?.length"
            class="od-logs"
          >
            <li
              v-for="l in order.logs"
              :key="l.id"
            >
              <span
                class="od-log-dot"
                :class="`is-${l.operatorRole}`"
              />
              <div class="od-log-main">
                <div class="od-log-line">
                  <b class="od-log-action">{{ l.actionLabel }}</b>
                  <el-tag
                    size="small"
                    effect="plain"
                    :type="roleTag(l.operatorRole)"
                  >
                    {{ ROLE_LABEL[l.operatorRole] }}
                  </el-tag>
                  <span class="od-log-op">{{ l.operator }}</span>
                  <span class="od-log-time adm-num">{{ formatDate(l.time, 'MM-DD HH:mm') }}</span>
                </div>
                <p
                  v-if="l.from || l.note"
                  class="od-log-note"
                >
                  <template v-if="l.from">
                    {{ ORDER_STATUS_LABEL[l.from] }} → {{ ORDER_STATUS_LABEL[l.to!] }}
                  </template>
                  <template v-if="l.note">
                    · {{ l.note }}
                  </template>
                </p>
              </div>
            </li>
          </ul>
          <p
            v-else
            class="od-note"
          >
            该订单暂无操作日志（早期数据未记录）。
          </p>
        </div>

        <!-- ============ 后台内部备注 ============ -->
        <div class="od-block">
          <div class="od-block-head">
            <p class="od-block-title">
              后台内部备注
            </p>
            <span class="adm-muted">仅管理员可见</span>
          </div>
          <el-input
            v-model="noteDraft"
            type="textarea"
            :rows="2"
            maxlength="120"
            show-word-limit
            placeholder="交接班留言、风险标注等，买家与卖家都看不到"
          />
          <div class="od-note-ops">
            <el-button
              size="small"
              type="primary"
              :loading="savingNote"
              :disabled="noteDraft === (order.adminNote ?? '')"
              @click="onSaveNote"
            >
              保存备注
            </el-button>
            <span
              v-if="order.adminNote"
              class="adm-muted"
            >当前：{{ order.adminNote }}</span>
          </div>
        </div>

        <!-- ============ 订单操作（只列状态机允许的下一步） ============ -->
        <div class="od-block">
          <p class="od-block-title">
            订单操作
          </p>
          <p class="od-flow">
            流向：{{ nextFlowText(order.status) }}
          </p>
          <div class="od-ops">
            <template v-if="order.status === 'pending_payment'">
              <el-button
                type="primary"
                @click="onSetStatus('pending_ship', '已标记为待发货')"
              >
                标记付款
              </el-button>
              <el-button
                type="danger"
                plain
                @click="onCloseOrder"
              >
                关闭订单
              </el-button>
            </template>
            <template v-else-if="order.status === 'pending_ship'">
              <el-button
                type="primary"
                @click="shipVisible = true"
              >
                发货
              </el-button>
              <el-button
                type="danger"
                plain
                @click="refundVisible = true"
              >
                退款
              </el-button>
            </template>
            <template v-else-if="order.status === 'shipped'">
              <el-button
                type="success"
                @click="onSetStatus('received', '已确认收货')"
              >
                确认收货
              </el-button>
              <el-button
                type="danger"
                plain
                @click="refundVisible = true"
              >
                退款
              </el-button>
            </template>
            <template v-else-if="order.status === 'received'">
              <el-button
                type="success"
                @click="onSetStatus('completed', '订单已完成')"
              >
                完成订单
              </el-button>
              <el-button
                type="danger"
                plain
                @click="refundVisible = true"
              >
                退款
              </el-button>
            </template>
            <!-- 售后单的出口：同意退款 / 驳回后回到申请售后前的状态 -->
            <template v-else-if="order.status === 'refunding'">
              <el-button
                type="danger"
                @click="refundVisible = true"
              >
                同意退款并关闭
              </el-button>
              <el-button
                plain
                @click="onRejectRefund"
              >
                驳回申请，恢复交易
              </el-button>
            </template>
            <p
              v-else
              class="od-note"
            >
              该订单已终结（{{ ORDER_STATUS_LABEL[order.status] }}），没有可用的流转操作。
            </p>
          </div>
        </div>
      </div>
    </template>
  </el-drawer>

  <!-- 发货弹窗：承运商 + 运单号 -->
  <el-dialog
    v-model="shipVisible"
    title="订单发货"
    width="420px"
    append-to-body
    @closed="releaseOverlayFocus"
  >
    <el-form label-width="76px">
      <el-form-item label="承运商">
        <el-select
          :teleported="false"
          v-model="shipForm.company"
          style="width: 100%"
        >
          <el-option
            v-for="c in carriers"
            :key="c"
            :label="c"
            :value="c"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="运单号">
        <el-input
          v-model="shipForm.trackingNo"
          placeholder="6-24 位字母 / 数字"
        />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="shipVisible = false">
        取消
      </el-button>
      <el-button
        type="primary"
        :loading="acting"
        @click="onShip"
      >
        确认发货
      </el-button>
    </template>
  </el-dialog>

  <!-- 退款弹窗：金额 + 原因 + 备注（对账三要素） -->
  <el-dialog
    v-model="refundVisible"
    title="退款处理"
    width="460px"
    append-to-body
    @closed="releaseOverlayFocus"
  >
    <template v-if="order">
      <el-alert
        v-if="order.status === 'refunding'"
        type="warning"
        show-icon
        :closable="false"
        class="od-refund-applied"
        :title="`买家申请退款：${order.refund?.reason ?? '未填原因'}`"
        :description="`申请时间 ${formatDate(order.refund?.time ?? order.createTime, 'YYYY-MM-DD HH:mm')}，可部分退款。`"
      />
      <el-form
        label-width="86px"
        class="od-refund-form"
      >
        <el-form-item label="退款金额">
          <el-input-number
            v-model="refundForm.amount"
            :min="0.01"
            :max="order.amount"
            :precision="2"
            :step="10"
            style="width: 100%"
          />
          <p class="od-form-tip">
            买家实付 ¥{{ order.amount.toFixed(2) }}，可少于该金额（部分退款）。
          </p>
        </el-form-item>
        <el-form-item label="退款原因">
          <!-- 退款中的单子沿用买家申请的原因：那是证据，不允许管理员改掉 -->
          <el-select
          :teleported="false"
            v-model="refundForm.reason"
            :disabled="order.status === 'refunding'"
            style="width: 100%"
          >
            <el-option
              v-for="r in REFUND_REASONS"
              :key="r"
              :label="r"
              :value="r"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="处理备注">
          <el-input
            v-model="refundForm.remark"
            type="textarea"
            :rows="2"
            maxlength="80"
            show-word-limit
            placeholder="选填，会记入操作日志"
          />
        </el-form-item>
      </el-form>
      <p class="od-note">
        确认后订单将置为「已取消」，退款金额与原因会记入售后记录，该操作不可回退。
      </p>
    </template>
    <template #footer>
      <el-button @click="refundVisible = false">
        取消
      </el-button>
      <el-button
        type="danger"
        :loading="acting"
        @click="onRefund"
      >
        确认退款
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  ORDER_STATUS_LABEL,
  ORDER_STATUS_TAG,
  ORDER_TRANSITIONS,
  REFUND_REASONS,
  orderIssueOf,
  refundOrder,
  rejectRefund,
  saveOrderNote,
  shipOrder,
  updateOrderStatus
} from '@/api/order'
import { fetchPublicProfile } from '@/api/user'
import { mockHelpers } from '@/api/mock'
import { formatDate } from '@/utils/format'
import { releaseOverlayFocus } from '@/utils/focus'
import type { Order, OrderLog } from '@/types'

const props = defineProps<{ modelValue: boolean; order: Order | null }>()
const emit = defineEmits<{
  'update:modelValue': [boolean]
  /** 订单被改动过 —— 由父组件去刷新列表与统计 */
  changed: []
}>()

const router = useRouter()
const visible = computed({
  get: () => props.modelValue,
  set: (v: boolean) => emit('update:modelValue', v)
})

const order = computed(() => props.order)
const issue = computed(() => (props.order ? orderIssueOf(props.order) : null))

const ROLE_LABEL: Record<OrderLog['operatorRole'], string> = {
  buyer: '买家',
  seller: '卖家',
  admin: '管理员',
  system: '系统'
}
function roleTag(r: OrderLog['operatorRole']): 'primary' | 'success' | 'danger' | 'info' {
  if (r === 'admin') return 'danger'
  if (r === 'buyer') return 'primary'
  if (r === 'seller') return 'success'
  return 'info'
}
function creditTag(score?: number): 'success' | 'warning' | 'danger' {
  if ((score ?? 0) >= 90) return 'success'
  if ((score ?? 0) >= 60) return 'warning'
  return 'danger'
}

/* ---------- 交易双方信息（信用分从用户表取，取不到就只显示昵称） ---------- */
const parties = ref<Array<{ role: 'buyer' | 'seller'; id: number; nickname: string; avatar: string; creditScore?: number }>>([])

async function loadParties() {
  const o = props.order
  if (!o) {
    parties.value = []
    return
  }
  const load = async (role: 'buyer' | 'seller', id: number, nickname: string) => {
    const p = await fetchPublicProfile(id)
    return { role, id, nickname: p?.nickname ?? nickname, avatar: p?.avatar ?? '', creditScore: p?.creditScore }
  }
  parties.value = [
    await load('buyer', o.buyerId, o.buyerName ?? `#${o.buyerId}`),
    await load('seller', o.sellerId, o.sellerName ?? `#${o.sellerId}`)
  ]
}

function openUser(p: { id: number }) {
  // 关掉抽屉再跳：抽屉是 append-to-body 的浮层，不关会盖在他人主页上
  visible.value = false
  router.push(`/user/${p.id}`)
}

/* ---------- 备注草稿 ---------- */
const noteDraft = ref('')
const savingNote = ref(false)
watch(
  () => props.order?.id,
  () => {
    noteDraft.value = props.order?.adminNote ?? ''
    loadParties()
  },
  { immediate: true }
)
// 抽屉每次打开都同步一次：上一次没保存的草稿不该跟着跑到下一条订单上
watch(visible, (v) => {
  if (v) {
    noteDraft.value = props.order?.adminNote ?? ''
    loadParties()
  }
})

async function onSaveNote() {
  if (!props.order) return
  savingNote.value = true
  try {
    await saveOrderNote(props.order.id, noteDraft.value)
    ElMessage.success('备注已保存')
    emit('changed')
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '保存失败')
  } finally {
    savingNote.value = false
  }
}

/* ---------- 状态流转 ---------- */
const acting = ref(false)

function timelineOf(o: Order): Array<{ label: string; time?: string }> {
  return [
    { label: '下单', time: o.createTime },
    { label: '付款', time: o.payTime },
    { label: '发货', time: o.shipTime },
    { label: '收货', time: o.receiveTime },
    { label: '完成', time: o.completeTime },
    { label: '退款', time: o.refundTime }
  ]
}

function nextFlowText(s: Order['status']): string {
  const next = ORDER_TRANSITIONS[s] ?? []
  if (!next.length) return '已终结，无后续流转'
  return `${ORDER_STATUS_LABEL[s]} → ${next.map((n) => ORDER_STATUS_LABEL[n]).join(' / ')}`
}

async function onSetStatus(next: Order['status'], okText: string) {
  const o = props.order
  if (!o) return
  try {
    await ElMessageBox.confirm(
      `确认将订单 ${o.id} 从「${ORDER_STATUS_LABEL[o.status]}」改为「${ORDER_STATUS_LABEL[next]}」？该操作不可回退。`,
      '修改订单状态',
      { type: 'warning' }
    )
  } catch {
    return
  }
  acting.value = true
  try {
    await updateOrderStatus({ id: o.id, status: next })
    ElMessage.success(okText)
    emit('changed')
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '操作失败')
  } finally {
    acting.value = false
  }
}

async function onCloseOrder() {
  const o = props.order
  if (!o) return
  let reason: string
  try {
    const r = await ElMessageBox.prompt(
      `关闭订单 ${o.id} 的原因会记入售后记录（买家超时未付款 / 协商一致取消等）`,
      '关闭订单',
      {
        inputValue: '买家超时未付款',
        inputPattern: /^.{2,30}$/,
        inputErrorMessage: '原因 2-30 个字',
        confirmButtonText: '确认关闭'
      }
    )
    reason = r.value
  } catch {
    return
  }
  acting.value = true
  try {
    await updateOrderStatus({ id: o.id, status: 'cancelled', reason })
    ElMessage.success('订单已关闭')
    emit('changed')
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '操作失败')
  } finally {
    acting.value = false
  }
}

/** 驳回退款申请：把订单退回申请售后前的履约状态，让交易继续走 */
async function onRejectRefund() {
  const o = props.order
  if (!o) return
  let note = ''
  try {
    const r = await ElMessageBox.prompt(
      `驳回订单 ${o.id} 的退款申请？订单将退回申请售后前的履约状态，双方继续履约。驳回原因会记入操作日志。`,
      '驳回退款申请',
      {
        inputPlaceholder: '驳回原因（选填）',
        inputValue: '经核实商品与描述一致，驳回退款申请',
        confirmButtonText: '确认驳回'
      }
    )
    note = r.value
  } catch {
    return
  }
  acting.value = true
  try {
    await rejectRefund(o.id, note)
    ElMessage.success('已驳回退款申请')
    emit('changed')
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '操作失败')
  } finally {
    acting.value = false
  }
}

/* ---------- 发货 ---------- */
const shipVisible = ref(false)
const carriers = ref<string[]>(mockHelpers.carriers())
const shipForm = ref({ company: '顺丰速运', trackingNo: '' })
watch(shipVisible, (v) => {
  if (v && props.order) {
    // 默认给一个符合校验规则的运单号，省掉手输；真后端由卖家录入
    shipForm.value = { company: '顺丰速运', trackingNo: `SF${Date.now().toString().slice(-10)}` }
  }
})

async function onShip() {
  const o = props.order
  if (!o) return
  if (!/^[A-Za-z0-9-]{6,24}$/.test(shipForm.value.trackingNo)) {
    ElMessage.warning('运单号为 6-24 位字母 / 数字')
    return
  }
  acting.value = true
  try {
    await shipOrder(o.id, shipForm.value.trackingNo, shipForm.value.company)
    ElMessage.success('已发货')
    shipVisible.value = false
    emit('changed')
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '操作失败')
  } finally {
    acting.value = false
  }
}

/* ---------- 退款 ---------- */
const refundVisible = ref(false)
const refundForm = ref({ amount: 0, reason: REFUND_REASONS[4] as string, remark: '' })
watch(refundVisible, (v) => {
  if (v && props.order) {
    refundForm.value = {
      amount: props.order.amount,
      reason: props.order.refund?.reason ?? REFUND_REASONS[4],
      remark: ''
    }
  }
})

async function onRefund() {
  const o = props.order
  if (!o) return
  acting.value = true
  try {
    await refundOrder(o.id, {
      amount: refundForm.value.amount,
      reason: refundForm.value.reason,
      remark: refundForm.value.remark
    })
    ElMessage.success(`已退款 ¥${refundForm.value.amount.toFixed(2)}`)
    refundVisible.value = false
    emit('changed')
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '操作失败')
  } finally {
    acting.value = false
  }
}
</script>

<style scoped lang="scss">
.od-drawer {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.od-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.od-head-main {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}
.od-title { font-size: 16px; font-weight: 600; color: var(--color-text-primary); }
.od-no {
  font-size: 13px;
  color: var(--color-text-secondary);
  font-weight: $fw-medium;
  flex-shrink: 0;
}
.od-sub { margin: 4px 0 0; font-size: 12px; color: var(--color-text-mute); }

.od-goods {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: $radius-sm;
  background: var(--bg-soft);
  border: 1px solid var(--border-color);
}
.od-img { width: 52px; height: 52px; border-radius: $radius-xs; flex-shrink: 0; }
.od-goods-txt {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1 1 auto;
}
.od-goods-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: $fs-13;
  font-weight: $fw-medium;
  color: var(--color-text-primary);
}
.od-goods-meta { font-size: $fs-12; color: var(--color-text-mute); }
.od-amount { font-size: 15px; font-weight: 600; color: $brand-orange; font-variant-numeric: tabular-nums; }

.od-block { margin-top: 16px; }
.od-block-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}
.od-block-title {
  margin: 0 0 8px;
  font-size: $fs-13;
  font-weight: $fw-semibold;
  color: var(--color-text-primary);
}

.od-kv {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 5px 0;
  font-size: $fs-13;

  span { color: var(--color-text-mute); flex-shrink: 0; }
  b {
    font-weight: $fw-medium;
    color: var(--color-text-primary);
    text-align: right;
    word-break: break-word;
    font-variant-numeric: tabular-nums;

    &.is-price { color: $brand-orange; font-weight: $fw-semibold; }
    &.is-danger { color: $color-danger; font-weight: $fw-semibold; }
  }
}

.od-note {
  margin: 6px 0 0;
  padding: 8px 10px;
  border-radius: $radius-xs;
  background: var(--bg-soft);
  font-size: $fs-11;
  line-height: 1.6;
  color: var(--color-text-mute);

  &.is-warning {
    background: rgba(255, 106, 0, 0.06);
    color: $brand-orange-deep;
  }
}
.od-flow { margin: 0 0 10px; font-size: $fs-12; color: var(--color-text-mute); }
.od-ops {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

/* ---------- 物流轨迹 ---------- */
.od-traces { margin-top: 10px; }
.od-traces-title {
  margin: 0 0 6px;
  font-size: $fs-12;
  font-weight: $fw-semibold;
  color: var(--color-text-secondary);
}
.od-trace-list {
  margin: 0;
  padding: 0;
  list-style: none;

  li {
    position: relative;
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 0 0 12px 16px;

    &:not(:last-child)::before {
      content: '';
      position: absolute;
      left: 3px;
      top: 11px;
      bottom: 0;
      width: 1px;
      background: var(--border-color);
    }
    &:last-child { padding-bottom: 0; }
  }
  .od-trace-dot {
    position: absolute;
    left: 0;
    top: 5px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--border-color-strong);
  }
  /* 最新一条高亮：后台最关心「货现在到哪了」 */
  li.is-latest {
    .od-trace-dot { background: $color-primary; }
    .od-trace-txt { color: var(--color-text-primary); font-weight: $fw-medium; }
  }
  .od-trace-txt { flex: 1 1 auto; font-size: $fs-12; color: var(--color-text-mute); line-height: 1.55; }
  .od-trace-time { font-size: $fs-11; color: $text-4; flex-shrink: 0; }
}

/* ---------- 交易双方 ---------- */
.od-pair {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.od-party {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 10px;
  border: 1px solid var(--border-color);
  border-radius: $radius-sm;
  background: var(--bg-card);
  min-width: 0;
}
.od-party-txt {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1 1 auto;
}
.od-party-role { font-size: $fs-11; color: $text-4; }
.od-party-name {
  font-size: $fs-13;
  font-weight: $fw-medium;
  color: var(--color-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.od-party-right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  flex-shrink: 0;
}

/* ---------- 进度时间线 ---------- */
.od-timeline {
  margin: 0;
  padding: 0;
  list-style: none;

  li {
    position: relative;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 0 14px 20px;

    &:not(:last-child)::before {
      content: '';
      position: absolute;
      left: 4px;
      top: 12px;
      bottom: -2px;
      width: 1px;
      background: var(--border-color);
    }
    &:last-child { padding-bottom: 2px; }
  }

  .od-dot {
    position: absolute;
    left: 0;
    top: 5px;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--border-color-strong);
  }
  &.done .od-dot { background: $color-primary; }
  .od-label { font-size: $fs-13; color: var(--color-text-mute); }
  &.done .od-label { color: var(--color-text-primary); font-weight: $fw-medium; }
  .od-time { margin-left: auto; font-size: $fs-12; color: var(--color-text-mute); }
}

/* ---------- 操作日志 ---------- */
.od-logs {
  margin: 0;
  padding: 0;
  list-style: none;

  li {
    display: flex;
    gap: 9px;
    padding: 0 0 12px;
    &:last-child { padding-bottom: 0; }
  }
}
.od-log-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  margin-top: 6px;
  flex-shrink: 0;
  background: $text-4;

  /* 用颜色区分操作人身份：一眼看出这单是买家、卖家还是平台推进的 */
  &.is-buyer { background: $color-primary; }
  &.is-seller { background: $color-success; }
  &.is-admin { background: $brand-orange; }
  &.is-system { background: var(--border-color-strong); }
}
.od-log-main { min-width: 0; flex: 1 1 auto; }
.od-log-line {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}
.od-log-action { font-size: $fs-13; font-weight: $fw-medium; color: var(--color-text-primary); }
.od-log-op { font-size: $fs-12; color: var(--color-text-secondary); }
.od-log-time { margin-left: auto; font-size: $fs-11; color: $text-4; }
.od-log-note {
  margin: 3px 0 0;
  font-size: $fs-11;
  line-height: 1.55;
  color: var(--color-text-mute);
  word-break: break-word;
}

/* ---------- 备注 ---------- */
.od-note-ops {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
  flex-wrap: wrap;
}

/* ---------- 退款弹窗 ---------- */
.od-refund-applied { margin-bottom: 14px; }
.od-refund-form { margin-top: 4px; }

@media (max-width: $breakpoint-sm) {
  .od-pair { grid-template-columns: minmax(0, 1fr); }
}
</style>
