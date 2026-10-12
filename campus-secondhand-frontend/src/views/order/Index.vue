<template>
  <PageContainer
    back
    title="订单中心"
    subtitle="查看与管理你的二手交易订单"
  >
    <template #actions>
      <el-radio-group
        v-model="activeStatus"
        @change="reload"
      >
        <el-radio-button label="">
          全部
        </el-radio-button>
        <el-radio-button label="pending_payment">
          待付款
        </el-radio-button>
        <el-radio-button label="pending_ship">
          待发货
        </el-radio-button>
        <el-radio-button label="shipped">
          已发货
        </el-radio-button>
        <el-radio-button label="completed">
          已完成
        </el-radio-button>
      </el-radio-group>
    </template>

    <el-table
      v-loading="loading"
      :data="list"
      style="width:100%"
    >
      <el-table-column
        prop="id"
        label="订单号"
        width="160"
      />
      <el-table-column
        label="商品"
        min-width="300"
      >
        <template #default="{ row }">
          <div class="g-cell">
            <el-image
              :src="row.goods.cover"
              fit="cover"
              class="thumb"
            />
            <span>{{ row.goods.title }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column
        prop="amount"
        label="金额"
        width="100"
        align="center"
      >
        <template #default="{ row }">
          ¥{{ row.amount.toFixed(2) }}
        </template>
      </el-table-column>
      <el-table-column
        label="状态"
        width="100"
        align="center"
      >
        <template #default="{ row }">
          <el-tag :type="statusTag(row.status)">
            {{ statusLabel(row.status) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column
        prop="createTime"
        label="创建时间"
        width="170"
      >
        <template #default="{ row }">
          {{ formatDate(row.createTime, 'YYYY-MM-DD HH:mm') }}
        </template>
      </el-table-column>
      <el-table-column
        label="操作"
        width="200"
        fixed="right"
        align="center"
      >
        <!--
          `row` 在 el-table 的具名插槽里被声明为 DefaultRow（一个宽松记录类型），
          直接喂给收 Order 的方法 vue-tsc 会报 TS2345。
          后台面板一直用 `(row as Order)` 收窄，这里统一成同一套写法，
          免得每加一个入口就多几条类型错误。
        -->
        <template #default="{ row }">
          <el-button
            text
            type="primary"
            size="small"
            @click="openDetail(row as Order)"
          >
            详情
          </el-button>
          <el-button
            v-if="(row as Order).status === 'pending_payment'"
            text
            type="danger"
            size="small"
            @click="onPay(row as Order)"
          >
            去支付
          </el-button>
          <el-button
            v-else-if="(row as Order).status === 'shipped'"
            text
            type="success"
            size="small"
            @click="onConfirm(row as Order)"
          >
            确认收货
          </el-button>
          <!--
            评价入口是三态的，不是「评了就锁死」：
              没评   → 评价
              评过   → 追加评论（追评）
              追过   → 已追评（仍然可点，进去看自己写了什么）
            主流电商就是这么做的：首评不可改，但体验是延续的，得留一个补充的出口。
          -->
          <el-button
            v-else-if="isReviewable(row as Order) && !reviewOf(row as Order)"
            text
            type="primary"
            size="small"
            @click="openReview(row as Order)"
          >
            评价
          </el-button>
          <el-button
            v-else-if="isReviewable(row as Order) && !hasAppend(row as Order)"
            text
            type="primary"
            size="small"
            @click="openAppend(row as Order)"
          >
            追加评论
          </el-button>
          <el-button
            v-else-if="isReviewable(row as Order) && hasAppend(row as Order)"
            text
            type="success"
            size="small"
            @click="openMyReview(row as Order)"
          >
            已追评
          </el-button>
          <!--
            取消订单只对「待付款」开放：付款后进入履约流程，
            要退走「申请退款」，两条线不能混（后端状态机同样会拦）。
          -->
          <el-button
            v-if="(row as Order).status === 'pending_payment'"
            text
            type="info"
            size="small"
            @click="onCancel(row as Order)"
          >
            取消订单
          </el-button>
          <!--
            申请退款是付款之后的唯一退货出口。
            与「取消订单」互斥且不能合并：取消只对未付款开放（还没给钱，直接作废），
            付了款要拿回钱只能走售后（后端状态机同样会拦）。
          -->
          <el-button
            v-if="canApplyRefund(row as Order)"
            text
            type="warning"
            size="small"
            @click="onApplyRefund(row as Order)"
          >
            申请退款
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <div class="pagination">
      <el-pagination
        v-model:current-page="page"
        :page-size="pageSize"
        :total="total"
        layout="total, prev, pager, next"
        @current-change="reload"
      />
    </div>

    <!-- 详情抽屉：一张订单的完整凭据 —— 商品对账、价格拆分、双方信息、物流时间线 -->
    <el-drawer
      v-model="drawerVisible"
      size="460px"
      append-to-body
      :with-header="false"
    >
      <template v-if="current">
        <div class="od">
          <div class="od-head">
            <span class="od-title">订单详情</span>
            <el-tag
              :type="statusTag(current.status)"
              size="small"
            >
              {{ statusLabel(current.status) }}
            </el-tag>
          </div>
          <p class="od-no">
            订单号 {{ current.id }}
          </p>

          <!-- 商品：单价 × 数量 = 小计，金额与列表一致 -->
          <div class="od-goods">
            <el-image
              :src="current.goods.cover"
              fit="cover"
              class="od-img"
            />
            <div class="od-goods-txt">
              <span
                class="od-goods-name"
                title="查看商品详情"
                @click="goGoods(current.goods.id)"
              >
                {{ current.goods.title }}
              </span>
              <span class="od-goods-meta">
                ¥{{ unitPrice(current).toFixed(2) }} × {{ current.quantity ?? 1 }}
              </span>
            </div>
            <span class="od-amount">¥{{ current.amount.toFixed(2) }}</span>
          </div>

          <!-- 价格拆分：新订单带四项快照，恒等式必须对得上；老订单只报实付 -->
          <div class="od-block">
            <p class="od-block-title">
              价格拆分
            </p>
            <template v-if="current.listPrice != null">
              <div class="od-kv">
                <span>卖家挂牌价</span><b>¥{{ current.listPrice.toFixed(2) }}</b>
              </div>
              <div class="od-kv">
                <span>买家实付</span><b class="is-price">¥{{ current.amount.toFixed(2) }}</b>
              </div>
              <div class="od-kv">
                <span>卖家让利{{ current.fundSource === 'seller' ? '（出资方）' : '' }}</span>
                <b>¥{{ (current.sellerCut ?? 0).toFixed(2) }}</b>
              </div>
              <div class="od-kv">
                <span>平台补贴{{ current.fundSource === 'platform' ? '（出资方）' : '' }}</span>
                <b>¥{{ (current.platformSubsidy ?? 0).toFixed(2) }}</b>
              </div>
              <div class="od-kv">
                <span>卖家实收</span><b>¥{{ (current.sellerIncome ?? 0).toFixed(2) }}</b>
              </div>
              <p class="od-note">
                恒等式：实付 + 卖家让利 + 平台补贴 = 挂牌价；卖家实收 = 挂牌价 − 卖家让利
                <template v-if="current.activityId">
                  （让利来自活动 {{ current.activityId }}）
                </template>
              </p>
            </template>
            <p
              v-else
              class="od-note"
            >
              本单为历史订单，未保留价格拆分快照，实付 ¥{{ current.amount.toFixed(2) }}。
            </p>
          </div>

          <!-- 交易信息 -->
          <div class="od-block">
            <p class="od-block-title">
              交易信息
            </p>
            <div class="od-kv">
              <span>卖家</span>
              <router-link
                :to="`/user/${current.sellerId}`"
                class="od-user"
              >
                {{ current.sellerName }}
              </router-link>
            </div>
            <div class="od-kv">
              <span>买家</span>
              <router-link
                :to="`/user/${current.buyerId}`"
                class="od-user"
              >
                {{ current.buyerName }}
              </router-link>
            </div>
            <div class="od-kv">
              <span>收货地址</span><b>{{ current.address }}</b>
            </div>
            <div class="od-kv">
              <span>物流单号</span><b>{{ current.trackingNo || '暂无' }}</b>
            </div>
            <div
              v-if="current.remark"
              class="od-kv"
            >
              <span>订单备注</span><b>{{ current.remark }}</b>
            </div>
          </div>

          <!-- 物流时间线：只放已经发生的时间点，未来的不画 -->
          <div class="od-block">
            <p class="od-block-title">
              订单进度
            </p>
            <ul class="od-timeline">
              <li
                v-for="step in timelineSteps"
                :key="step.label"
                :class="{ 'is-done': !!step.time }"
              >
                <span
                  class="od-dot"
                  aria-hidden="true"
                />
                <span class="od-step-label">{{ step.label }}</span>
                <span class="od-step-time">{{ step.time ? formatDate(step.time, 'MM-DD HH:mm') : '待完成' }}</span>
              </li>
            </ul>
          </div>

          <!--
            售后信息（取消原因 / 退款单）
            ★ 这两个字段后端一直在下发，但这一页从来没渲染过 ★
            于是买家在自己的订单里看不到「为什么被取消」「退了多少钱、原因是什么」，
            只能去问卖家或管理员 —— 而这些信息本来就在他自己的订单数据里。
          -->
          <div
            v-if="current.cancelReason || current.refund"
            class="od-block"
          >
            <p class="od-block-title">
              售后信息
            </p>
            <template v-if="current.refund">
              <div class="od-kv">
                <span>退款金额</span><b class="is-price">¥{{ current.refund.amount.toFixed(2) }}</b>
              </div>
              <div class="od-kv">
                <span>退款原因</span><b>{{ current.refund.reason }}</b>
              </div>
              <div
                v-if="current.refund.remark"
                class="od-kv"
              >
                <span>处理备注</span><b>{{ current.refund.remark }}</b>
              </div>
              <div
                v-if="current.refund.time"
                class="od-kv"
              >
                <span>申请时间</span><b>{{ formatDate(current.refund.time, 'MM-DD HH:mm') }}</b>
              </div>
            </template>
            <div
              v-if="current.cancelReason"
              class="od-kv"
            >
              <span>取消原因</span>
              <b>{{ current.cancelReason.text }}（{{ formatDate(current.cancelReason.time, 'MM-DD HH:mm') }}）</b>
            </div>
          </div>

          <!--
            操作记录（真实数据，来自 t_order_log 的 `order.logs`）
            ★ 原来这一页只按 4 个时间字段画了一条固定的里程碑 ★
            「谁在什么时候把这单推到了哪一步」库里记得清清楚楚，却没人渲染 ——
            最典型的是「管理员驳回退款申请并说明了原因」：这条对买家至关重要，
            之前只能靠客服口头传达。
            ★ 现在可以安全渲染了 ★ 后端 `OrderService.fillLogs` 已按查看者身份
            过滤掉 `action='note'` 的后台内部备注（见 `visibleLogs`），
            所以买家 / 卖家拿到的 logs 里不含管理员写给管理员看的备注原文。
            若将来有人把后端那道过滤去掉，这里就会变成隐私泄露的出口 —— 改之前先看那边。
          -->
          <div
            v-if="current.logs?.length"
            class="od-block"
          >
            <p class="od-block-title">
              操作记录
            </p>
            <ul class="od-logs">
              <li
                v-for="l in current.logs"
                :key="l.id"
              >
                <span class="ol-time">{{ formatDate(l.time, 'MM-DD HH:mm') }}</span>
                <span class="ol-label">{{ l.actionLabel }}</span>
                <span class="ol-op">{{ l.operator }}（{{ ROLE_TEXT[l.operatorRole] ?? l.operatorRole }}）</span>
                <span
                  v-if="l.note"
                  class="ol-note"
                >{{ l.note }}</span>
              </li>
            </ul>
          </div>

          <!-- 跟状态联动的操作：与列表行内按钮同源 -->
          <div class="od-ops">
            <el-button
              v-if="current.status === 'pending_payment'"
              type="warning"
              @click="onPay(current)"
            >
              去支付
            </el-button>
            <el-button
              v-else-if="current.status === 'shipped'"
              type="success"
              @click="onConfirm(current)"
            >
              确认收货
            </el-button>
            <el-button
              v-else-if="isReviewable(current) && !reviewOf(current)"
              type="primary"
              plain
              @click="openReview(current)"
            >
              评价卖家
            </el-button>
            <el-button
              v-else-if="isReviewable(current) && !hasAppend(current)"
              type="primary"
              plain
              @click="openAppend(current)"
            >
              追加评论
            </el-button>
            <el-button
              v-else-if="isReviewable(current) && hasAppend(current)"
              type="success"
              plain
              @click="openMyReview(current)"
            >
              查看我的评价
            </el-button>
            <!-- 与列表行内按钮同口径：仅待付款可取消（独立 v-if，不打断上面的 else-if 链） -->
            <el-button
              v-if="current.status === 'pending_payment'"
              type="info"
              plain
              @click="onCancel(current)"
            >
              取消订单
            </el-button>
          </div>
        </div>
      </template>
    </el-drawer>
    <!--
      评价弹窗（评价表：订单-评价-用户-被评价人）
      同一个弹窗服务两种模式，避免两套几乎一样的表单各自漂移：
        create = 首评（改星级 + 写内容）
        append = 追评（星级锁定为原评，只补一段话）
    -->
    <el-dialog
      v-model="reviewVisible"
      :title="reviewMode === 'append' ? '追加评论' : '评价卖家'"
      width="420px"
    >
      <div class="review-form">
        <div class="rf-goods">
          <el-image
            :src="reviewTarget?.goods.cover"
            fit="cover"
            class="rf-img"
          />
          <span>{{ reviewTarget?.goods.title }}</span>
        </div>

        <!-- 追评模式：把首评摆出来当上下文，但不允许改动（首评不是可编辑的草稿） -->
        <div
          v-if="reviewMode === 'append'"
          class="rf-origin"
        >
          <div class="rf-origin-head">
            <span class="rf-label">我的首评</span>
            <el-rate
              :model-value="reviewOf(reviewTarget)?.rating ?? 5"
              disabled
              size="small"
            />
          </div>
          <p class="rf-origin-txt">
            {{ reviewOf(reviewTarget)?.content }}
          </p>
          <span class="rf-origin-tip">
            首评提交后不可修改，追评会作为补充追加展示在下方
          </span>
        </div>

        <div
          v-else
          class="rf-rate"
        >
          <span class="rf-label">卖家服务</span>
          <el-rate
            v-model="reviewForm.rating"
            :texts="['很差', '较差', '一般', '满意', '超赞']"
            show-text
          />
        </div>

        <el-input
          v-model="reviewForm.content"
          type="textarea"
          :rows="3"
          maxlength="200"
          show-word-limit
          :placeholder="
            reviewMode === 'append'
              ? '用了一段时间，还有什么想补充的？（5-200 字）'
              : '说说这次交易的体验吧～（5-200 字）'
          "
        />
      </div>
      <template #footer>
        <el-button @click="reviewVisible = false">
          取消
        </el-button>
        <el-button
          type="primary"
          :disabled="reviewForm.content.trim().length < 5"
          @click="reviewMode === 'append' ? onSubmitAppend() : onSubmitReview()"
        >
          {{ reviewMode === 'append' ? '提交追评' : '提交评价' }}
        </el-button>
      </template>
    </el-dialog>

    <!-- 查看我的评价（首评 + 追评），让「追过了」也不至于变成死胡同 -->
    <el-dialog
      v-model="myReviewVisible"
      title="我的评价"
      width="440px"
    >
      <div
        v-if="myReview"
        class="mine-review"
      >
        <div class="mr-goods">
          <el-image
            :src="myReviewTarget?.goods.cover"
            fit="cover"
            class="rf-img"
          />
          <span>{{ myReviewTarget?.goods.title }}</span>
        </div>
        <div class="mr-block">
          <div class="mr-head">
            <span class="rf-label">首次评价</span>
            <el-rate
              :model-value="myReview.rating"
              disabled
              size="small"
            />
          </div>
          <p class="mr-txt">
            {{ myReview.content }}
          </p>
          <span class="mr-time">{{ formatDate(myReview.createTime, 'YYYY-MM-DD HH:mm') }}</span>
        </div>
        <div
          v-if="myReview.appendContent"
          class="mr-block mr-block--append"
        >
          <div class="mr-head">
            <span class="rf-label">追加评论</span>
          </div>
          <p class="mr-txt">
            {{ myReview.appendContent }}
          </p>
          <span class="mr-time">
            {{ myReview.appendTime ? formatDate(myReview.appendTime, 'YYYY-MM-DD HH:mm') : '' }}
          </span>
        </div>
      </div>
      <template #footer>
        <el-button
          type="primary"
          @click="myReviewVisible = false"
        >
          知道了
        </el-button>
      </template>
    </el-dialog>

    <!--
      收银台
      ★ 为什么必须让用户选支付方式，而不是沿用「确认支付 ¥45.00？」★
      那个确认框问的是「你确定吗」，而支付真正要回答的是「钱从哪来」。
      同一个订单可以走钱包余额，也可以跳支付宝 —— 后端按渠道走完全不同的流程
      （一个当场扣款、一个要等回调），这个选择只能由用户来做。
      另外渠道列表是**后端下发的**：没配密钥的支付宝根本不会出现，
      用户也就不可能点到一条付不了款的方式。
    -->
    <el-dialog
      v-model="payVisible"
      title="收银台"
      width="440px"
      :close-on-click-modal="false"
    >
      <div
        v-if="payTarget"
        class="cashier"
      >
        <div class="cashier-amount">
          <span class="cashier-goods">{{ payTarget.goods.title }}</span>
          <span class="cashier-money">¥{{ payTarget.amount.toFixed(2) }}</span>
        </div>

        <el-radio-group
          v-model="payChannelCode"
          class="cashier-channels"
        >
          <el-radio
            v-for="c in payChannels"
            :key="c.code"
            :value="c.code"
            class="cashier-channel"
          >
            <div class="cc-line">
              <span class="cc-label">{{ c.label }}</span>
            </div>
            <div class="cc-hint">
              {{ c.hint }}
            </div>
          </el-radio>
        </el-radio-group>

        <!--
          钱包充值入口
          ★ 为什么必须有这一条 ★
          收银台的「校园钱包」文案写着「使用校园币余额直接支付，无需跳转」，
          但改造前全站**没有任何充值入口** —— 后端没有充值接口、前端全树搜
          「充值」零命中，只有 SQL 种子脚本能给余额加钱（还只覆盖三个演示账号）。
          于是任何其它账号打开收银台都是「余额 ¥0.00」，点确认支付必弹
          「钱包余额不足」，而用户翻遍页面也找不到地方加钱：看起来像功能坏了。
          这条入口跟随钱包渠道一起出现，不做条件隐藏 —— 余额显示为 0 时，
          它就是唯一的出路，正好是最不该把它藏起来的时刻。
        -->
        <div
          v-if="walletChannel"
          class="cashier-wallet-bar"
        >
          <span class="cwb-text">
            校园钱包余额
            <b class="cwb-amount">¥{{ walletBalanceText }}</b>
          </span>
          <el-button
            text
            type="primary"
            size="small"
            @click="rechargeVisible = true"
          >
            去充值
          </el-button>
        </div>

        <p
          v-if="!payChannels.length"
          class="cashier-empty"
        >
          正在加载支付方式…
        </p>

        <p
          v-if="launchMessage"
          class="cashier-tip"
        >
          {{ launchMessage }}
        </p>
      </div>

      <template #footer>
        <el-button @click="payVisible = false">
          取消
        </el-button>
        <el-button
          type="primary"
          :loading="paying"
          :disabled="!payChannelCode"
          @click="submitPay"
        >
          确认支付
        </el-button>
      </template>
    </el-dialog>

    <!--
      充值弹窗放在收银台**外面**（同级，不是嵌套）
      ★ 嵌套会让 z-index 打架 ★
      el-dialog 的层级是递增分配的，嵌套时内层弹窗可能被外层遮罩盖住，
      表现为「点了去充值，弹窗出来了但点不动」—— 这类问题只在真机上偶发，
      同级摆放则完全不存在这个风险。
    -->
    <WalletRechargeDialog
      v-model="rechargeVisible"
      @success="onRechargeSuccess"
    />
  </PageContainer>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import PageContainer from '@/components/common/PageContainer.vue'
import WalletRechargeDialog from '@/components/business/WalletRechargeDialog.vue'
import { fetchOrders, payOrder, confirmReceive, cancelOrder, applyRefund, APPLY_REFUNDABLE_STATUS } from '@/api/order'
import { fetchPayChannels, fetchPayStatus } from '@/api/pay'
import type { PayChannelOption } from '@/api/pay'
import { submitReview, fetchReviewByOrder, appendReview } from '@/api/review'
import { formatDate } from '@/utils/format'
import type { Order, Review } from '@/types'

/**
 * 「跳去外部收银台」时记在 sessionStorage 里的键。
 * 见 submitPay：页面会被整个换掉，回来之后靠它知道要问哪一单的结果。
 */
const PAY_PENDING_KEY = 'campus.pay.pendingOrderId'

/* ------------------------- 收银台状态 ------------------------- */
const payVisible = ref(false)
const payTarget = ref<Order | null>(null)
const payChannels = ref<PayChannelOption[]>([])
const payChannelCode = ref('')
const paying = ref(false)
const launchMessage = ref('')

/* ------------------------- 充值 ------------------------- */
const rechargeVisible = ref(false)

/**
 * 钱包渠道（可能不存在：某个 profile 下它被关掉时列表里就没有它）。
 * 用 computed 而不是存一个 ref：渠道列表会随「充值成功后刷新」而整体替换，
 * 存快照会指向旧对象，余额显示就不会更新。
 */
const walletChannel = computed(() => payChannels.value.find((c) => c.code === 'wallet'))

/** 收银台上显示的余额文案。渠道缺失或后端没给值时回 0.00，避免出现 "¥undefined" */
const walletBalanceText = computed(() => {
  const b = walletChannel.value?.balance
  return b == null ? '0.00' : Number(b).toFixed(2)
})

/**
 * 充值成功后刷新渠道列表。
 * <p>
 * ★ 必须重新拉，不能在本地说「余额 += 刚充的钱」★
 * 本地累加用的是本地快照，一旦别处（另一台设备、另一个标签页）也动过余额，
 * 算出来的就是错的；而且收银台这个数字会直接影响用户判断"够不够付这一单"。
 * 多一次请求换取显示一定正确，这笔账划算。
 */
async function onRechargeSuccess() {
  try {
    payChannels.value = await fetchPayChannels()
  } catch {
    // 刷新失败不影响充值本身：钱已经入账，下次打开收银台自然会看到新余额
  }
}
const pollTimer = ref<number | null>(null)

const router = useRouter()
const list = ref<Order[]>([])
const total = ref(0)
const loading = ref(false)
const page = ref(1)
const pageSize = ref(10)
const activeStatus = ref<'' | Order['status']>('')
const drawerVisible = ref(false)
const current = ref<Order | null>(null)

async function reload() {
  loading.value = true
  try {
    const r = await fetchOrders({ page: page.value, pageSize: pageSize.value, status: (activeStatus.value || undefined) as Order['status'] })
    list.value = r.list
    total.value = r.total
    loadReviewedFlags(r.list)
  } finally {
    loading.value = false
  }
}

function statusLabel(s: Order['status']) {
  return ({
    pending_payment: '待付款',
    pending_ship: '待发货',
    shipped: '已发货',
    received: '已收货',
    completed: '已完成',
    refunding: '退款中',
    cancelled: '已取消'
  } as Record<string, string>)[s] ?? s
}
function statusTag(s: Order['status']) {
  return ({
    pending_payment: 'warning',
    pending_ship: 'warning',
    shipped: 'primary',
    received: 'info',
    completed: 'success',
    refunding: 'danger',
    cancelled: 'info'
  } as Record<string, any>)[s] ?? ''
}

function openDetail(row: Order) {
  current.value = row
  drawerVisible.value = true
}

/** 成交单价：让利价优先，无让利即挂牌价 */
function unitPrice(row: Order) {
  return row.goods.promoPrice ?? row.goods.price
}

/** 抽屉里点商品名可跳详情（详情页自身有返回键，不会迷路） */
function goGoods(id: number) {
  drawerVisible.value = false
  router.push(`/goods/${id}`)
}

/** 操作人身份 → 中文。`OrderLog.operatorRole` 只有四个取值，操作记录列表要用 */
const ROLE_TEXT: Record<string, string> = {
  buyer: '买家',
  seller: '卖家',
  admin: '平台',
  system: '系统'
}

/**
 * 订单进度：固定四个里程碑，未发生的显示「待完成」——
 * 时间点在 seed 里保证单调（创建 ≤ 支付 ≤ 发货 ≤ 收货），倒序展示最新的在最上。
 *
 * ★ 它只覆盖**主链路** ★ 取消 / 退款 / 管理员驳回退款这些分支不在这四个里程碑里，
 * 那类事项由下方的「操作记录」（真实 `order.logs`）与「售后信息」两块负责展示。
 * 只留四个时间字段的话，被取消的订单在这个列表里会看起来「停在第二步」而没有任何解释。
 */
const timelineSteps = computed(() => {
  const c = current.value
  if (!c) return []
  return [
    { label: '创建订单', time: c.createTime },
    { label: '完成支付', time: c.payTime },
    { label: '卖家发货', time: c.shipTime },
    { label: '确认收货', time: c.receiveTime }
  ]
})

/**
 * 打开收银台。
 *
 * ★★ 改造前这里只有一个确认框 ★★
 * `确认支付 ¥45.00?` → 点确定 → 订单变已付款。没有支付方式、没有渠道、
 * 没有任何凭证 —— 界面上说「支付成功」，实际上只是发了一次 HTTP 请求。
 *
 * 现在改成真正的收银台：先拉后端给的可用渠道，用户选一种再发起。
 * 后端返回 `PayLaunch`，由 `kind` 决定下一步（当场完成 / 跳外部收银台 / 扫码）。
 */
async function onPay(row: Order) {
  payTarget.value = row
  payChannels.value = []
  payChannelCode.value = ''
  payVisible.value = true
  paying.value = false
  try {
    const list = await fetchPayChannels()
    payChannels.value = list
    // 默认选中第一条：省一次点击，但用户仍然看得见自己选的是哪种
    payChannelCode.value = list[0]?.code ?? ''
  } catch {
    payVisible.value = false
  }
}

async function submitPay() {
  const row = payTarget.value
  if (!row || !payChannelCode.value) return
  paying.value = true
  try {
    const launch = await payOrder(row.id, payChannelCode.value)

    if (launch.kind === 'DONE') {
      ElMessage.success(launch.message || '支付成功')
      payVisible.value = false
      reload()
      return
    }

    if (launch.kind === 'REDIRECT' && launch.url) {
      /*
       * ★ 跳走之前把订单号记下来 ★
       * 用户在**外部页面**付款，页面整个被替换掉了。回来之后才知道要问哪一单，
       * 所以存进 sessionStorage —— 用 localStorage 会跨标签页串味、
       * 而且关掉浏览器还留着，下次进来莫名其妙弹一个「支付结果」。
       */
      sessionStorage.setItem(PAY_PENDING_KEY, row.id)
      window.location.href = launch.url
      return
    }

    // QR：留着收银台不关，展示二维码并开始轮询（将来接扫码支付用）
    launchMessage.value = launch.message || '请用手机扫码完成支付'
    startPolling(row.id)
  } finally {
    paying.value = false
  }
}

/**
 * 轮询支付结果。
 *
 * 只在「跳出去又回来」或「扫码等待」这两种情况下才需要 ——
 * 钱包那种当场出结果的渠道一次都不会走到这里。
 */
function startPolling(orderId: string) {
  stopPolling()
  let tries = 0
  pollTimer.value = window.setInterval(async () => {
    tries += 1
    // 最多问 2 分钟：用户可能已经关掉页面走人了，不能无限轮询下去
    if (tries > 40) {
      stopPolling()
      launchMessage.value = '未检测到支付结果，请刷新页面查看订单状态'
      return
    }
    try {
      const s = await fetchPayStatus(orderId)
      if (s.paid) {
        stopPolling()
        payVisible.value = false
        ElMessage.success('支付成功')
        reload()
      }
    } catch {
      // 单次查询失败不打断轮询：网络抖动一下就放弃，用户会以为钱丢了
    }
  }, 3000)
}

function stopPolling() {
  if (pollTimer.value) {
    window.clearInterval(pollTimer.value)
    pollTimer.value = null
  }
}
async function onConfirm(row: Order) {
  try {
    await ElMessageBox.confirm(`确认已收到「${row.goods.title}」？确认后订单完成，可以评价卖家。`, '确认收货', {
      type: 'warning',
      confirmButtonText: '确认收货',
      cancelButtonText: '再等等'
    })
  } catch {
    return
  }
  await confirmReceive(row.id)
  ElMessage.success('已确认收货，可以评价卖家了')
  reload()
}

/**
 * 买家取消待付款订单。
 *
 * 用 prompt 而不是 confirm：取消原因（选填）会写进订单的时间线与取消原因栏，
 * 卖家在消息里看到「拍错了」和「已拍到更便宜的」，处理心情完全不同。
 * 取消失败（如手慢一步订单已被处置）交由 request 层的统一报错提示。
 */
async function onCancel(row: Order) {
  let reason: string | undefined
  try {
    const { value } = await ElMessageBox.prompt(
      `取消订单 ${row.id} 后不可恢复，已扣库存将回补。可填写取消原因：`,
      '取消订单',
      {
        type: 'warning',
        confirmButtonText: '确认取消',
        cancelButtonText: '再想想',
        inputPlaceholder: '选填，例如：拍错了 / 不想要了'
      }
    )
    reason = (value ?? '').trim() || undefined
  } catch {
    return
  }
  await cancelOrder(row.id, reason)
  ElMessage.success('订单已取消')
  reload()
}

/**
 * 买家申请退款（付款之后的售后入口）。
 *
 * 原因做成**必填**而不是选填：它是售后统计的分组依据，也是纠纷时唯一的书面证据。
 * 提交后订单进入「退款中」，由平台审核 —— 这一点在提示语里说清楚，
 * 否则买家会以为点完钱就到账了，然后来问「为什么还没退」。
 */
async function onApplyRefund(row: Order) {
  let reason: string | undefined
  try {
    const { value } = await ElMessageBox.prompt(
      `申请退款后订单将进入「退款中」，由平台审核。请填写退款原因：`,
      '申请退款',
      {
        type: 'warning',
        confirmButtonText: '提交申请',
        cancelButtonText: '再想想',
        inputPlaceholder: '例如：商品存在质量问题',
        // 与后端 refund_reason(varchar 200) 同口径：前端先拦一道，别等落库报 500
        inputValidator: (v) => {
          const t = (v ?? '').trim()
          if (!t) return '请填写退款原因'
          return t.length > 200 ? '退款原因最多 200 个字' : true
        }
      }
    )
    reason = (value ?? '').trim() || undefined
  } catch {
    return
  }
  await applyRefund(row.id, { reason: reason ?? '' })
  ElMessage.success('退款申请已提交，等待平台审核')
  reload()
}

/* ---------- 评价 / 追评（评价表） ---------- */
const reviewVisible = ref(false)
/** create = 首评；append = 追评。同一个弹窗两种模式，避免两套表单各自漂移 */
const reviewMode = ref<'create' | 'append'>('create')
const reviewTarget = ref<Order | null>(null)
const reviewForm = reactive({ rating: 5, content: '' })
/** 「我的评价」查看弹窗 */
const myReviewVisible = ref(false)
const myReviewTarget = ref<Order | null>(null)
const myReview = ref<Review | null>(null)

/**
 * 本页已加载订单的评价实体，key = orderId。
 *
 * 早先只存一个「已评价」的 Set —— 布尔量推不出「追评过没有」，
 * 于是评过之后入口只能退化成一个不可点的「已评价」标签，用户想补充都没地方说。
 * 换成存整条评价：有没有评、追没追、追了什么，页面都读得出来。
 */
const reviewMap = ref<Map<string, Review>>(new Map())

function reviewOf(row: Order | null) {
  return row ? reviewMap.value.get(row.id) ?? null : null
}
function hasAppend(row: Order | null) {
  return !!reviewOf(row)?.appendContent
}

/**
 * 哪些状态可以评价：货已到买家手里才算数。
 * `received`（已收货）与 `completed`（已完成）都属于这个阶段 ——
 * 早先只放 completed，导致停在「已收货」的订单既没有评价入口也没有任何按钮，成了死胡同。
 */
const REVIEWABLE_STATUS: Order['status'][] = ['received', 'completed']
function isReviewable(row: Order) {
  return REVIEWABLE_STATUS.includes(row.status)
}

/**
 * 哪些状态能「申请退款」：付款之后、终态之前。
 *
 * 与 `REFUNDABLE_STATUS`（管理端「同意退款」用的那份）差在 `refunding` 一项 ——
 * 这里判的是「能不能**发起**售后」，而 `refunding` 表示已经申请过了，
 * 再点一次后端会报「正在等待平台处理」，所以入口直接不显示。
 * 判断口径来自 api/order.ts，不在这里另抄一份，避免两边漂移。
 */
function canApplyRefund(row: Order) {
  return APPLY_REFUNDABLE_STATUS.includes(row.status)
}

async function loadReviewedFlags(rows: Order[]) {
  // 每次重载都整体重算，避免筛选切换后旧的评价标记残留
  const done = rows.filter(isReviewable)
  const results = await Promise.all(
    done.map((r) => fetchReviewByOrder(r.id).catch(() => null))
  )
  const m = new Map<string, Review>()
  done.forEach((r, i) => {
    const rv = results[i]
    if (rv) m.set(r.id, rv)
  })
  reviewMap.value = m
}

/** 首评（一单一次）。已评过就顺势引导去追评，而不是弹一句「不能评了」把人堵回去 */
function openReview(row: Order) {
  const exist = reviewOf(row)
  if (exist) {
    openAppend(row)
    return
  }
  reviewMode.value = 'create'
  reviewTarget.value = row
  reviewForm.rating = 5
  reviewForm.content = ''
  reviewVisible.value = true
}

/** 追评：必须先有首评，且一单只追一次（首评的星级与内容不会被覆盖） */
function openAppend(row: Order) {
  const exist = reviewOf(row)
  if (!exist) {
    // 还没首评 —— 直接走首评流程，别让用户卡在「追不了也评不了」的死角
    openReview(row)
    return
  }
  if (exist.appendContent) {
    ElMessage.info('该订单已追评过了，可点「已追评」查看')
    return
  }
  reviewMode.value = 'append'
  reviewTarget.value = row
  reviewForm.content = ''
  reviewVisible.value = true
}

/** 查看自己写过的评价（首评 + 追评），让「追过了」也不至于变成死胡同 */
function openMyReview(row: Order) {
  myReviewTarget.value = row
  myReview.value = reviewOf(row)
  myReviewVisible.value = true
}

async function onSubmitReview() {
  const row = reviewTarget.value
  if (!row) return
  const res = await submitReview({
    orderId: row.id,
    goodsId: row.goods.id,
    toUserId: row.sellerId,
    rating: reviewForm.rating,
    content: reviewForm.content.trim()
  })
  if (res.duplicate) {
    ElMessage.warning('该订单已评价过了，如需补充请用「追加评论」')
  } else {
    ElMessage.success('评价已提交，感谢你的反馈！')
  }
  reviewVisible.value = false
  await loadReviewedFlags(list.value)
}

async function onSubmitAppend() {
  const row = reviewTarget.value
  if (!row) return
  const res = await appendReview(row.id, reviewForm.content.trim())
  if (res.notFound) {
    ElMessage.warning('该订单还没有首评，请先完成首次评价')
  } else if (res.duplicate) {
    ElMessage.warning('该订单已追评过了')
  } else {
    ElMessage.success('追评已提交，会追加展示在你的评价下方')
  }
  reviewVisible.value = false
  await loadReviewedFlags(list.value)
}

/**
 * ★ 从外部收银台回来时补一次状态确认 ★
 *
 * 用户付完款，支付宝把浏览器跳回我们的站点（return_url）。
 * 此时订单**可能已经是已付款**，也可能用户其实没付、只是关掉了支付宝。
 * 不问一句的话，页面显示的还是缓存里的「待付款」，用户会以为钱白付了。
 *
 * 只问一次（不问到成功为止）：回来这一刻结果基本已经确定了，
 * 再轮询下去只会让「用户其实放弃了」这种情况卡在转圈上。
 */
onMounted(async () => {
  await reload()
  const pendingId = sessionStorage.getItem(PAY_PENDING_KEY)
  if (!pendingId) return
  sessionStorage.removeItem(PAY_PENDING_KEY)
  try {
    const s = await fetchPayStatus(pendingId)
    if (s.paid) {
      ElMessage.success('支付成功')
      await reload()
    } else {
      ElMessage.info('未检测到支付结果，若已完成支付请稍后刷新查看')
    }
  } catch {
    // 查询失败就当没这回事，订单列表已经刷新过了，不打断用户
  }
})
</script>

<style scoped lang="scss">
.g-cell { display: flex; align-items: center; gap: 10px;
  .thumb { width: 56px; height: 56px; border-radius: 6px; }
}
.pagination { margin-top: 16px; display: flex; justify-content: center; }

/* ---------- 收银台 ---------- */
.cashier-amount { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 14px;
  .cashier-goods { font-size: 13px; color: var(--el-text-color-regular); overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; max-width: 62%; }
  .cashier-money { font-size: 22px; font-weight: 700; color: var(--el-color-danger); }
}
.cashier-channels { display: flex; flex-direction: column; gap: 10px; width: 100%; }
.cashier-channel { width: 100%; height: auto; padding: 10px 12px; border: 1px solid var(--el-border-color);
  border-radius: 8px; margin-right: 0;
  .cc-line { display: flex; align-items: center; gap: 8px; }
  .cc-label { font-weight: 600; }
  .cc-hint { font-size: 12px; color: var(--el-text-color-secondary); margin-top: 4px; line-height: 1.5; }
}
/* 钱包余额 + 充值入口。余额从渠道卡片里移到这里 —— 同一屏显示两遍同一个数字
   既冗余又让人怀疑哪个才是准的，而且这里还能顺手给出「去哪加钱」这一个动作 */
.cashier-wallet-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 10px;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--bg-soft);
  border: 1px solid var(--border-color);

  .cwb-text { font-size: 12px; color: var(--color-text-secondary); }
  .cwb-amount { color: var(--color-primary); font-size: 14px; }
}
.cashier-empty, .cashier-tip { font-size: 12px; color: var(--el-text-color-secondary); margin: 10px 0 0; }

/* ---------- 订单详情抽屉 ---------- */
.od {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.od-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.od-title { font-size: 16px; font-weight: 600; color: #1f2329; }
.od-no { margin: 4px 0 0; font-size: 12px; color: #8f959e; font-variant-numeric: tabular-nums; }

/* 商品条：图 + 标题（可点） + 单价×数量 + 小计 */
.od-goods {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  background: #f7f8fa;
  border: 1px solid #eef0f3;
}
.od-img { width: 52px; height: 52px; border-radius: 6px; flex-shrink: 0; }
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
  font-size: 13px;
  font-weight: 500;
  color: #1f2329;
  cursor: pointer;

  &:hover { color: #ff6a00; }
}
.od-goods-meta { font-size: 12px; color: #646a73; font-variant-numeric: tabular-nums; }
.od-amount { font-size: 15px; font-weight: 600; color: #ff6a00; font-variant-numeric: tabular-nums; }

.od-block { margin-top: 16px; }
.od-block-title {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
  color: #1f2329;
}

.od-kv {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 5px 0;
  font-size: 13px;

  span { color: #646a73; flex-shrink: 0; }
  b {
    font-weight: 500;
    color: #1f2329;
    text-align: right;
    word-break: break-word;
    font-variant-numeric: tabular-nums;

    /* 让利/补贴是平台口径里的关键数字，实付用品牌橙强调 */
    &.is-price { color: #ff6a00; font-weight: 600; }
  }
}

/*
 * 操作记录：一行一条 —— 时间 / 动作 / 操作人，补充说明另起一行占满宽度。
 * 用 grid 而不是 flex，是为了让「时间」与「动作」两列在每行之间对齐：
 * 一屏扫下来就能读出先后顺序，而不用逐行对齐眼睛。
 */
.od-logs {
  margin: 0;
  padding: 0;
  list-style: none;

  li {
    display: grid;
    grid-template-columns: 84px 1fr auto;
    gap: 4px 10px;
    padding: 6px 0;
    font-size: 13px;
    border-top: 1px solid #f0f1f2;

    &:first-child { border-top: 0; }
  }

  .ol-time { color: #8f959e; font-variant-numeric: tabular-nums; }
  .ol-label { color: #1f2329; font-weight: 500; }
  .ol-op { color: #646a73; white-space: nowrap; }
  /* 补充说明（运单号 / 退款原因 / 驳回理由）跨满整行，长文本可换行 */
  .ol-note { grid-column: 2 / -1; color: #646a73; word-break: break-word; }
}

.od-note {
  margin: 6px 0 0;
  padding: 8px 10px;
  border-radius: 6px;
  background: #f7f8fa;
  font-size: 11px;
  line-height: 1.6;
  color: #8f959e;
}

/* 交易信息里的买卖双方可点进「他人主页」 */
.od-user {
  color: #2563eb;
  text-decoration: none;
  font-weight: 500;

  &:hover { text-decoration: underline; }
}

/*
 * 追评模式下的「我的首评」只读块。
 * 首评不是可编辑草稿 —— 摆出来是为了给追评当上下文，
 * 所以视觉上要比输入区弱一档（灰底 + 次级文字），别让人误以为能改。
 */
.rf-origin {
  padding: 10px 12px;
  border-radius: 6px;
  background: #f7f8fa;
  border: 1px solid #eef0f3;

  .rf-origin-head {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 6px;
  }
  .rf-origin-txt {
    margin: 0;
    font-size: 13px;
    line-height: 1.6;
    color: #646a73;
    word-break: break-word;
  }
  .rf-origin-tip {
    display: block;
    margin-top: 6px;
    font-size: 11px;
    color: #8f959e;
  }
}

/* 「我的评价」弹窗：首评在上，追评在同一条评价下方追加展示 */
.mine-review {
  display: flex;
  flex-direction: column;
  gap: 12px;

  .mr-goods {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 13px;
    color: #646a73;
  }
  .mr-block {
    padding: 10px 12px;
    border-radius: 6px;
    background: #f7f8fa;
    border: 1px solid #eef0f3;
  }
  /* 追评用左侧橙线标出来，与首评区分 */
  .mr-block--append {
    background: #fff4e6;
    border-color: #ffe0c2;
    border-left: 3px solid #ff6a00;
  }
  .mr-head {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 6px;
  }
  .mr-txt {
    margin: 0;
    font-size: 13px;
    line-height: 1.6;
    color: #1f2329;
    word-break: break-word;
  }
  .mr-time {
    display: block;
    margin-top: 6px;
    font-size: 11px;
    color: #8f959e;
    font-variant-numeric: tabular-nums;
  }
}

/* 进度时间线：已发生的点亮，未发生的灰 */
.od-timeline {
  margin: 0;
  padding: 0;
  list-style: none;

  li {
    position: relative;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 0 18px 20px;

    /* 连接线：最后一段不画 */
    &:not(:last-child)::before {
      content: '';
      position: absolute;
      left: 4px;
      top: 12px;
      bottom: -2px;
      width: 1px;
      background: #e5e7eb;
    }
    &:last-child { padding-bottom: 2px; }
  }

  .od-dot {
    position: absolute;
    left: 0;
    top: 4px;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: #d8dce2;

    .is-done & { background: #ff6a00; }
  }
  .od-step-label { font-size: 13px; color: #646a73; }
  .is-done .od-step-label { color: #1f2329; font-weight: 500; }
  .od-step-time {
    margin-left: auto;
    font-size: 12px;
    color: #8f959e;
    font-variant-numeric: tabular-nums;
  }
}

.od-ops {
  display: flex;
  gap: 10px;
  margin-top: 20px;
  padding-top: 14px;
  border-top: 1px solid #eef0f3;
}

/* 评价弹窗 */
/*
 * 评价弹窗与「我的评价」弹窗共用的碎片 —— 提出来放在顶层，
 * 别嵌在 .review-form 里（嵌套后代选择器管不到另一个弹窗）。
 */
.rf-img {
  width: 44px;
  height: 44px;
  border-radius: 6px;
  flex-shrink: 0;
}
.rf-label {
  font-size: 14px;
  color: #1f2329;
  flex-shrink: 0;
}

.review-form {
  display: flex;
  flex-direction: column;
  gap: 14px;

  .rf-goods {
    display: flex; align-items: center; gap: 10px;
    font-size: 13px; color: #646a73;
  }
  .rf-rate {
    display: flex; align-items: center; gap: 12px;
  }
}
</style>
