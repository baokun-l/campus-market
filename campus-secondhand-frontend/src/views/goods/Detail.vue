<template>
  <div class="detail-page">
    <!-- 返回：命中区域 ≥44px，键盘可达 -->
    <button
      class="back-btn"
      type="button"
      @click="$router.back()"
    >
      <el-icon><ArrowLeft /></el-icon>
      <span>返回</span>
    </button>

    <div
      v-loading="loading"
      class="detail-wrap"
    >
      <template v-if="goods">
        <div class="detail-grid">
          <!-- ==================== 左：图集 ==================== -->
          <section
            class="gallery"
            aria-label="商品图片"
          >
            <div class="main-img">
              <img
                v-if="active"
                :src="active"
                :alt="goods.title"
                @error="onMainImgError"
              >
              <span
                v-if="goods.status === 'sold'"
                class="img-flag"
              >已售出</span>
            </div>
            <div
              class="thumbs"
              role="tablist"
              aria-label="图片切换"
            >
              <button
                v-for="img in goods.images"
                :key="img"
                type="button"
                role="tab"
                class="thumb"
                :class="{ active: img === active }"
                :aria-selected="img === active"
                @click="active = img"
              >
                <img
                  :src="img"
                  alt=""
                  @error="onThumbError($event, img)"
                >
              </button>
            </div>
          </section>

          <!-- ==================== 右：信息面板 ==================== -->
          <section class="info">
            <!-- 卖家行（参考图置于标题之上，先建立信任再讲商品）；卖家可点进「他人主页」 -->
            <div class="seller-row">
              <button
                class="seller-link"
                type="button"
                :aria-label="`查看卖家 ${goods.sellerName} 的主页`"
                @click="goSeller"
              >
                <el-avatar
                  :src="goods.sellerAvatar"
                  :size="28"
                  class="seller-avatar"
                >
                  {{ (goods.sellerName || '同').slice(0, 1) }}
                </el-avatar>
                <span class="seller-label">卖家：</span>
                <span class="seller-name">@{{ goods.sellerName }}</span>
                <!--
                  卖家在线标识：数据来自服务端在线名单（GET /users/online），
                  5 分钟内有心跳且本人未关闭隐私开关才算在线。
                  ★ 这里刻意不再挂「设置 → 显示在线状态」的本地开关 ★
                  那个开关管的是「别人能不能看到我在线」，用它 gate 这里的渲染，
                  会变成「我关掉自己的可见性，连别人的在线状态都看不见了」。
                -->
                <span
                  class="online-badge"
                  :class="sellerOnline ? 'is-online' : 'is-offline'"
                >
                  {{ sellerOnline ? '在线' : '离线' }}
                </span>
              </button>
              <span
                class="sep"
                aria-hidden="true"
              >·</span>
              <span class="credit-label">信用</span>
              <span class="credit-score">{{ sellerCredit ?? '—' }}</span>

              <button
                class="fav-btn"
                :class="{ 'is-on': favorited }"
                type="button"
                :aria-pressed="favorited"
                :aria-label="favorited ? '取消收藏' : '收藏商品'"
                @click="onFavorite"
              >
                <el-icon :size="16">
                  <Star />
                </el-icon>
                <span class="fav-btn-text">{{ favorited ? '已收藏' : '收藏' }}</span>
                <span class="fav-btn-count">{{ favorited ? goods.favoriteCount + 1 : goods.favoriteCount }}</span>
              </button>
            </div>

            <!-- 标题 -->
            <h1 class="title">
              {{ goods.title }}
            </h1>

            <!-- 价格区：大号橙价 + 划线挂牌价 + 折扣标签 + 让利归属说明 -->
            <div class="price-block">
              <PriceTag
                :list-price="goods.price"
                :promo-price="goods.promoPrice"
                :zero-text="'面议'"
                size="lg"
              />
              <!--
                让利必须说清「这笔钱谁出」：
                卖家自愿让利（卖家实收减少）还是平台补贴（卖家实收不变）。
                含混其辞地写「平台 5 折」既不真实，也让卖家无法对账。
              -->
              <p
                v-if="promoNote"
                class="promo-note"
              >
                <span class="promo-badge">{{ promoNote.label }}</span>
                <span>{{ promoNote.text }}</span>
              </p>
            </div>

            <!-- 位置 / 交易方式 / 剩余数量：交易方式与数量都来自卖家发布时填的真实数据 -->
            <ul class="facts">
              <li>
                <el-icon><Location /></el-icon>
                <span>{{ goods.location }}</span>
                <span
                  class="sep"
                  aria-hidden="true"
                >·</span>
                <span>{{ deliveryLabel(goods.deliveryMethod) }}</span>
                <span
                  class="sep"
                  aria-hidden="true"
                >·</span>
                <!-- 已售出 / 审核中 / 已下架时直接说状态，避免「已售出 · 剩余 2 件」自相矛盾 -->
                <span :class="{ 'is-lack': !purchasable }">{{ availabilityText(goods) }}</span>
              </li>
              <li>
                <el-icon><View /></el-icon>
                <span>{{ goods.viewCount }} 浏览</span>
                <span
                  class="sep"
                  aria-hidden="true"
                >·</span>
                <span>{{ goods.favoriteCount }} 收藏</span>
                <span
                  class="sep"
                  aria-hidden="true"
                >·</span>
                <span>{{ goods.categoryName }}</span>
              </li>
            </ul>

            <!-- 主行动区：等宽 3 按钮（参考图 6.4：联系卖家 / 加入购物车 / 立即购买） -->
            <div class="actions">
              <el-button
                class="btn-outline act"
                size="large"
                @click="onContactSeller"
              >
                <el-icon><ChatDotRound /></el-icon>
                <span>联系卖家</span>
              </el-button>
              <el-button
                class="btn-cart act"
                size="large"
                :disabled="!purchasable"
                @click="onCart"
              >
                <el-icon><ShoppingCart /></el-icon>
                <span>加入购物车</span>
              </el-button>
              <el-button
                class="btn-brand act"
                size="large"
                :disabled="!purchasable"
                @click="onBuyNow"
              >
                立即购买
              </el-button>
            </div>

            <!--
              不可购买时必须把原因写在页面上。
              只把按钮置灰、不解释，用户只会认为「页面坏了」——
              审核中 / 已下架 / 已售出三种情况的处理方式完全不同。
            -->
            <p
              v-if="!purchasable && goods"
              class="buy-block"
            >
              <el-icon><InfoFilled /></el-icon>
              <span>{{ purchasableBlockReason }}</span>
            </p>

            <!-- 次要操作：政策链接，不与主按钮争抢注意力 -->
            <div class="sub-actions">
              <el-button
                class="sub-act"
                text
                @click="policyVisible = true"
              >
                <el-icon><Document /></el-icon>
                <span>交易与退换政策</span>
              </el-button>
              <span
                class="sub-divider"
                aria-hidden="true"
              />
              <button
                class="sub-link"
                type="button"
                @click="goCart"
              >
                已加入购物车？前往查看 →
              </button>
              <span
                class="sub-divider"
                aria-hidden="true"
              />
              <button
                class="sub-link is-danger"
                type="button"
                @click="reportVisible = true"
              >
                举报
              </button>
            </div>
          </section>
        </div>

        <!-- ==================== 商品描述（参考图浅灰底 + 💡） ==================== -->
        <section class="desc-card">
          <p class="desc-text">
            <span
              class="desc-icon"
              aria-hidden="true"
            >💡</span>
            <span class="desc-label">商品描述：</span>{{ goods.description }}
          </p>
        </section>

        <!-- ==================== 用户评价（评价表：订单-评价-用户-被评价人） ==================== -->
        <section class="block-card">
          <header class="block-head">
            <h3>
              用户评价
              <span class="count">{{ reviews.length }}</span>
            </h3>
            <div
              v-if="reviews.length"
              class="review-summary"
            >
              <el-rate
                :model-value="avgRating"
                disabled
                allow-half
                size="small"
              />
              <span class="avg-num">{{ avgRating.toFixed(1) }} 分</span>
            </div>
          </header>

          <ul
            v-if="reviews.length"
            class="review-list"
          >
            <li
              v-for="r in reviews"
              :key="r.id"
              class="review-item"
            >
              <el-avatar
                :src="r.fromUserAvatar"
                :size="34"
                class="rv-avatar"
              >
                {{ (r.fromUserName || '同').slice(0, 1) }}
              </el-avatar>
              <div class="rv-body">
                <div class="rv-head">
                  <router-link
                    :to="`/user/${r.fromUserId}`"
                    class="rv-name"
                  >
                    {{ r.fromUserName }}
                  </router-link>
                  <el-rate
                    :model-value="r.rating"
                    disabled
                    size="small"
                    class="rv-rate"
                  />
                </div>
                <p class="rv-content">
                  {{ r.content }}
                </p>
                <span class="rv-time">{{ formatDate(r.createTime, 'YYYY-MM-DD HH:mm') }}</span>
                <!--
                  追评：挂在首评下方而非另起一条。
                  同一次交易的两次发言应当连着读 —— 拆成两条会让人以为是两个买家在评价。
                -->
                <div
                  v-if="r.appendContent"
                  class="rv-append"
                >
                  <span class="rv-append-tag">追评</span>
                  <p class="rv-append-txt">
                    {{ r.appendContent }}
                  </p>
                  <span
                    v-if="r.appendTime"
                    class="rv-time"
                  >
                    {{ formatDate(r.appendTime, 'YYYY-MM-DD HH:mm') }}
                  </span>
                </div>
              </div>
            </li>
          </ul>

          <div
            v-else
            class="block-empty"
          >
            暂无评价，完成订单后来评价吧
          </div>
        </section>

        <!-- ==================== 商品留言（留言表：评论 / 回复） ==================== -->
        <section class="block-card">
          <header class="block-head">
            <h3>
              商品留言
              <span class="count">{{ comments.length }}</span>
            </h3>
          </header>

          <!-- 输入行：回复时显示「回复 @xxx」 -->
          <div class="comment-input-row">
            <el-avatar
              :src="userStore.profile?.avatar"
              :size="34"
              class="ci-avatar"
            >
              {{ (userStore.profile?.nickname || '我').slice(0, 1) }}
            </el-avatar>
            <div class="ci-box">
              <div
                v-if="replyTo"
                class="ci-reply-hint"
              >
                回复 @{{ replyTo.userName }}
                <button
                  class="ci-cancel"
                  type="button"
                  @click="replyTo = null"
                >
                  取消
                </button>
              </div>
              <div class="ci-main">
                <el-input
                  v-model="commentText"
                  :placeholder="replyTo ? `回复 @${replyTo.userName}…` : '有什么想问的？留言问问卖家或同学～'"
                  maxlength="200"
                  show-word-limit
                  @keydown.enter="onSendComment"
                />
                <el-button
                  type="primary"
                  :disabled="!commentText.trim()"
                  @click="onSendComment"
                >
                  发布
                </el-button>
              </div>
            </div>
          </div>

          <ul
            v-if="commentTree.length"
            class="comment-list"
          >
            <li
              v-for="c in commentTree"
              :key="c.id"
              class="comment-item"
            >
              <el-avatar
                :src="c.userAvatar"
                :size="34"
                class="cm-avatar"
              >
                {{ (c.userName || '同').slice(0, 1) }}
              </el-avatar>
              <div class="cm-body">
                <div class="cm-head">
                  <router-link
                    :to="`/user/${c.userId}`"
                    class="cm-name"
                  >
                    {{ c.userName }}
                  </router-link>
                  <span class="cm-time">{{ formatRelative(c.createTime) }}</span>
                </div>
                <p class="cm-content">
                  {{ c.content }}
                </p>
                <button
                  class="cm-reply-btn"
                  type="button"
                  @click="replyTo = c"
                >
                  回复
                </button>

                <!-- 一层回复 -->
                <ul
                  v-if="c.replies.length"
                  class="reply-list"
                >
                  <li
                    v-for="r in c.replies"
                    :key="r.id"
                    class="reply-item"
                  >
                    <el-avatar
                      :src="r.userAvatar"
                      :size="26"
                      class="cm-avatar sm"
                    >
                      {{ (r.userName || '同').slice(0, 1) }}
                    </el-avatar>
                    <div class="cm-body">
                      <div class="cm-head">
                        <router-link
                          :to="`/user/${r.userId}`"
                          class="cm-name"
                        >
                          {{ r.userName }}
                        </router-link>
                        <span
                          v-if="r.replyToName"
                          class="cm-replyto"
                        >回复 @{{ r.replyToName }}</span>
                        <span class="cm-time">{{ formatRelative(r.createTime) }}</span>
                      </div>
                      <p class="cm-content">
                        {{ r.content }}
                      </p>
                      <button
                        class="cm-reply-btn"
                        type="button"
                        @click="replyTo = r"
                      >
                        回复
                      </button>
                    </div>
                  </li>
                </ul>
              </div>
            </li>
          </ul>

          <div
            v-else
            class="block-empty"
          >
            还没有留言，来抢沙发～
          </div>
        </section>
      </template>

      <EmptyState
        v-else
        title="未找到商品"
        description="商品可能已下架或被删除"
        icon="🛒"
      />
    </div>

    <!-- 政策抽屉 -->
    <el-drawer
      v-model="policyVisible"
      title="交易与退换政策"
      size="40%"
    >
      <div class="policy-content">
        <h4>① 关于收货</h4>
        <p>买家收到商品时请当面验收，确认无误后确认收货；存在破损严重、描述不符等情况可在 24 小时内发起退款/退货申请。</p>
        <h4>② 退换政策</h4>
        <p>支持 7 天无理由退货（特殊商品除外）。</p>
        <h4>③ 信用积分</h4>
        <p>完成评价后买卖双方根据评价刷新信誉分。</p>
      </div>
    </el-drawer>

    <!--
      立即购买 · 确认订单。
      这里刻意**不经过购物车**：立即购买表达的是「就买这一件，现在下单」，
      绕进购物车再结算会让人以为商品被悄悄加进了购物车。
    -->
    <el-dialog
      v-model="buyVisible"
      title="确认订单"
      width="460px"
    >
      <div
        v-if="goods"
        class="buy-form"
      >
        <div class="bf-goods">
          <el-image
            :src="goods.cover"
            fit="cover"
            class="bf-img"
          />
          <div class="bf-info">
            <span class="bf-title">{{ goods.title }}</span>
            <span class="bf-sub">{{ availabilityText(goods) }} · {{ deliveryLabel(goods.deliveryMethod) }}</span>
          </div>
        </div>

        <div class="bf-row">
          <span class="bf-label">购买数量</span>
          <el-input-number
            v-model="buyQty"
            :min="1"
            :max="maxBuyQty"
            :disabled="buying"
          />
          <span class="bf-hint">上限为卖家可售数量</span>
        </div>

        <!-- 快递：必须真的选一条地址簿里的地址；面交 / 自提：说清不需要地址 -->
        <div
          v-if="needsShip"
          class="bf-row"
        >
          <span class="bf-label">收货地址</span>
          <el-select
            v-if="addresses.length"
            :teleported="false"
            v-model="chosenAddressId"
            placeholder="请选择收货地址"
            class="bf-addr-select"
            :disabled="buying"
          >
            <el-option
              v-for="a in addresses"
              :key="a.id"
              :label="addressLabel(a)"
              :value="a.id"
            />
          </el-select>
          <span
            v-else
            class="bf-addr is-empty"
          >
            还没有收货地址，请先到「个人中心 · 收货地址」添加
          </span>
        </div>

        <div
          v-else
          class="bf-row"
        >
          <span class="bf-label">收货地址</span>
          <span class="bf-addr">{{ noShipAddressText }}</span>
        </div>

        <div class="bf-amount">
          <div
            v-if="buyBreakdown.onPromo"
            class="bf-line"
          >
            <span>挂牌价合计</span>
            <s>¥{{ buyBreakdown.listPrice.toFixed(2) }}</s>
          </div>
          <div class="bf-line is-pay">
            <span>实付金额</span>
            <b>¥{{ buyBreakdown.payAmount.toFixed(2) }}</b>
          </div>
          <!-- 让利金额必须说清谁出：平台掏的钱写成「卖家让利」会让卖家以为被扣了钱 -->
          <p
            v-if="buyBreakdown.onPromo"
            class="bf-note"
          >
            {{ discountNote(buyBreakdown) }}
            <span class="bf-equation">
              （实付 ¥{{ buyBreakdown.payAmount.toFixed(2) }} + 让利
              ¥{{ buyBreakdown.sellerCut.toFixed(2) }} + 补贴
              ¥{{ buyBreakdown.platformSubsidy.toFixed(2) }} = 挂牌
              ¥{{ buyBreakdown.listPrice.toFixed(2) }}）
            </span>
          </p>
        </div>
      </div>
      <template #footer>
        <el-button
          :disabled="buying"
          @click="buyVisible = false"
        >
          取消
        </el-button>
        <el-button
          type="primary"
          :loading="buying"
          :disabled="buying || (needsShip && !chosenAddress)"
          @click="onSubmitBuy"
        >
          提交订单
        </el-button>
      </template>
    </el-dialog>

    <!-- 举报弹窗（举报表：用户-商品「举报」） -->
    <el-dialog
      v-model="reportVisible"
      title="举报"
      width="440px"
    >
      <el-form
        label-width="72px"
        label-position="left"
      >
        <el-form-item label="举报对象">
          <el-input
            :model-value="`商品 · ${goods?.title ?? ''}`"
            disabled
          />
        </el-form-item>
        <el-form-item label="举报理由">
          <el-select
          :teleported="false"
            v-model="reportForm.reason"
            placeholder="请选择理由"
          >
            <el-option
              v-for="rs in REPORT_REASONS"
              :key="rs"
              :label="rs"
              :value="rs"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="详细说明">
          <el-input
            v-model="reportForm.description"
            type="textarea"
            :rows="3"
            maxlength="200"
            show-word-limit
            placeholder="补充说明情况，方便平台核实"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="reportVisible = false">
          取消
        </el-button>
        <el-button
          type="danger"
          :disabled="!reportForm.reason"
          @click="onSubmitReport"
        >
          提交举报
        </el-button>
      </template>
    </el-dialog>

    <!-- 联系卖家 · 聊天抽屉 -->
    <el-drawer
      v-model="chatVisible"
      :title="`与 ${goods?.sellerName ?? '卖家'} 沟通`"
      size="460px"
      class="chat-drawer"
    >
      <ChatWindow
        v-if="chatSessionId && myUserId"
        :session-id="chatSessionId"
        :my-user-id="myUserId"
        :my-avatar="userStore.avatar"
        :peer-id="goods!.sellerId"
        :peer-name="goods!.sellerName"
        :peer-avatar="goods!.sellerAvatar"
        :goods-id="goods!.id"
        :goods-title="goods!.title"
        :goods-cover="goods!.cover"
        empty-text="发条消息问问卖家吧，比如「还在吗」"
        @sent="onMessageSent"
      />
      <div class="chat-tip">
        <el-icon><InfoFilled /></el-icon>
        <span>消息会同步到双方的「消息中心」，卖家登录后即可在收件箱看到你的留言。</span>
      </div>
      <div class="chat-actions">
        <el-button
          text
          type="primary"
          @click="goMessageCenter"
        >
          前往消息中心查看全部会话 →
        </el-button>
      </div>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PriceTag from '@/components/common/PriceTag.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import ChatWindow from '@/components/business/ChatWindow.vue'
import { fetchGoodsDetail } from '@/api/goods'
import { toggleFavorite, fetchFavorites, recordHistory, fetchAddresses, fetchPublicProfile } from '@/api/user'
import { createOrder } from '@/api/order'
import { makeCover } from '@/api/mock'
import { fetchComments, postComment } from '@/api/comment'
import { fetchReviewsByGoods } from '@/api/review'
import { submitReport } from '@/api/report'
import { openSession } from '@/api/message'
import { ensureActivitiesLoaded, resolveFundSourceForGoods } from '@/api/activity'
import { formatDate, formatRelative } from '@/utils/format'
import { settlePrice, scaleBreakdown, discountNote, FUND_SOURCE_LABEL, FUND_SOURCE_HINT } from '@/utils/promo'
import type { PriceBreakdown } from '@/utils/promo'
import { availabilityText, deliveryLabel, resolveStock, MAX_ORDER_QUANTITY } from '@/utils/goods'
import { needsShipping, formatAddress, pickDefaultAddress } from '@/utils/address'
import { useCartStore } from '@/stores/modules/cart'
import { useUserStore } from '@/stores/modules/user'
import { useMessageStore } from '@/stores/modules/message'
import { useOnlineStore } from '@/stores/modules/online'
import type { Goods, GoodsComment, Review, Address } from '@/types'

const route = useRoute()
const router = useRouter()
const cartStore = useCartStore()
const userStore = useUserStore()
const messageStore = useMessageStore()
const onlineStore = useOnlineStore()
const goods = ref<Goods | null>(null)
/** 卖家是否在线：读服务端在线名单（口径见 stores/modules/online.ts），不再本地散列编造 */
const sellerOnline = computed(() => onlineStore.isOnline(goods.value?.sellerId))
const loading = ref(false)
const active = ref<string>('')
const policyVisible = ref(false)
const favorited = ref(false)

/** 聊天抽屉状态 */
const chatVisible = ref(false)
const chatSessionId = ref('')
const myUserId = computed(() => userStore.profile?.id ?? 0)

/* ============================================================
 * 卖家信用分
 *
 * 原实现：`100 - ((sellerId * 3) % 30)` —— 由卖家 ID「稳定派生」的伪随机数。
 * 它每次进来都一样，看起来比乱跳的数字可信，但那恰恰是问题：
 * 它与数据库里的 `t_user.credit_score` **没有任何关系**。
 * 管理员在后台把某人扣到 34 分（后台界面会标红警示），
 * 买家在商品详情页看到的仍是这个散列算出来的数。
 * 「稳定」掩盖了「假」—— 这已不是占位实现，而是一个会被当真数据读的假数据。
 *
 * 现在读卖家公开主页的真实值（`fetchPublicProfile` → `GET /users/{id}/profile`），
 * 与「他人主页」用的是同一个字段，两处不会互相打架。
 * 取不到时保持 null，界面显示「—」：宁可不显示，也不编一个数字。
 * ============================================================ */
const sellerCredit = ref<number | null>(null)

async function loadSellerCredit(sellerId: number) {
  try {
    sellerCredit.value = (await fetchPublicProfile(sellerId))?.creditScore ?? null
  } catch {
    // 信用分缺失不该影响浏览与下单：留 null，模板显示「—」
    sellerCredit.value = null
  }
}

/**
 * 让利说明：显示「谁出的这笔钱」+ 省了多少。
 * 未参与活动（没有让利价）时返回 null，页面不渲染任何折扣相关的块。
 *
 * 归属必须按**商品自己报名的活动**判定（`activityId`）而不是分类反查：
 * 同一分类可能挂着卖家让利与平台补贴两条活动，按分类查只会拿到优先级最高的那条，
 * 会把平台掏的钱写成卖家让利 → 卖家看到「你少收了 80 元」而实际上他一分没少。
 */
const promoNote = computed(() => {
  const g = goods.value
  if (!g) return null
  const fundSource = resolveFundSourceForGoods(g)
  const b = settlePrice(g, fundSource)
  if (!b.onPromo) return null
  const saved = b.sellerCut + b.platformSubsidy
  return {
    label: FUND_SOURCE_LABEL[b.fundSource],
    text: `${FUND_SOURCE_HINT[b.fundSource]}，本单可省 ¥${saved.toFixed(2)}`
  }
})

async function load() {
  const id = route.params.id as string
  loading.value = true
  try {
    /*
     * 商品详情与**活动列表**一起等（并行）。
     * `promoNote` 用的是同步解析的 `resolveFundSourceForGoods()`，它读活动缓存 ——
     * 活动还没拉回来时缓存是空的，会让「平台补贴」的标签退化成「卖家让利」，
     * 卖家看到「你少收了 80 元」而实际上一分没少。
     * 但活动拉取失败不该让整页白屏，所以单独 catch。
     */
    const [g] = await Promise.all([fetchGoodsDetail(id), ensureActivitiesLoaded().catch(() => [])])
    goods.value = g
    active.value = g.cover
    // 查卖家的在线状态（失败静默，标识退化成「离线」，不影响页面其余部分）
    onlineStore.ensure([g.sellerId])
    // 卖家信用分：读公开主页的真实值（失败静默，界面显示「—」）
    loadSellerCredit(g.sellerId)
    // 留言 + 评价并行加载（失败不阻塞主内容）
    fetchComments(g.id).then((list) => (comments.value = list)).catch(() => {})
    fetchReviewsByGoods(g.id).then((list) => (reviews.value = list)).catch(() => {})
    // 记录浏览足迹：个人主页的「浏览足迹」靠它才有数据（失败不打扰用户）
    /*
     * ★★ 游客不发这个请求（放开游客浏览后最要紧的一处）★★
     * `POST /user/history` 需要登录，游客发出去必然拿到 401，
     * 而 `request.ts` 对 401 的处理是「提示『登录状态已过期』+ 清 token + 跳登录页」——
     * 也就是说：**游客只要打开一次商品详情页，就会立刻被弹一句自相矛盾的提示**
     *（他从没登录过，哪来的"过期"）。而这段代码是页面加载流程里的，
     * 不是用户主动触发的，所以它比下面那些按钮问题更严重 —— 它是**必然发生**的。
     *
     * ★ 这里刻意**不用** requireLogin ★
     * 浏览足迹是「我的」数据，游客没有可归属的对象，静默跳过即可。
     * 若也用 requireLogin，就变成"一进商品页就被弹提示并被送去登录"，
     * 那是把浏览行为当成了写操作来对待 —— 与放开游客浏览的初衷正好相反。
     */
    if (userStore.isLoggedIn) {
      recordHistory({ goods: g }).catch(() => {})
    }
    // 【修复】同步收藏态：否则本就在收藏夹里的商品点一下反而变成"取消收藏"
    if (userStore.isLoggedIn) {
      try {
        const r = await fetchFavorites({ pageSize: 999 })
        favorited.value = r.list.some((f) => f.goodsId === g.id)
      } catch {
        favorited.value = false
      }
    }
  } finally {
    loading.value = false
  }
}

/* 图片加载失败兜底：实拍图缺失时回退到分类渐变占位图 */
const failedImgs = new Set<string>()
function fallbackCover(): string {
  return makeCover(goods.value?.categoryId ?? 1, goods.value?.id ?? 0)
}
function onMainImgError() {
  if (!goods.value) return
  if (!failedImgs.has(active.value)) {
    failedImgs.add(active.value)
    active.value = fallbackCover()
  }
}
function onThumbError(e: Event, img: string) {
  if (!goods.value || failedImgs.has(img)) return
  failedImgs.add(img)
  ;(e.target as HTMLImageElement).src = fallbackCover()
}

/* ============================================================
 * 游客态守卫（放开游客浏览后必须补上的一层）
 *
 * ★ 背景 ★
 * 详情页现在是 `meta.public: true` —— 未登录也能看。
 * 但页面上的动作（收藏 / 加购 / 购买 / 留言 / 举报 / 联系卖家）都需要登录，
 * 而它们原先**一个都没做登录判断**，因为「能进这一页的人必然是登录用户」。
 *
 * ★ 不加守卫会发生什么 ★
 * 后端对这些写操作一律回 401，而 `api/request.ts` 对 401 的处理是
 * 「弹『登录状态已过期，请重新登录』+ 清 token + 跳登录页」——
 * 于是一个**从未登录过**的游客点一下收藏，会看到「登录状态已过期」这种
 * 前后矛盾（他压根没登录过），还被莫名其妙踢走。
 *
 * ★ 为什么抽成一个函数而不是每处写 if ★
 *   · 文案与跳转行为统一（都带 `redirect`，登录后回到原商品）；
 *   · 以后新增动作不容易漏 —— 一眼就能看出「这处没走 requireLogin」；
 *   · 与 `onContactSeller` 原本内联的那段逻辑合并成同一条路径，
 *     避免出现两套写法。
 *
 * @param action 中文动作名，拼进提示语（如「收藏商品」→「请先登录后再收藏商品」）
 * @returns true = 已登录可以继续；false = 游客，已提示并已跳转
 * ============================================================ */
function requireLogin(action: string): boolean {
  if (userStore.isLoggedIn) return true
  ElMessage.warning(`请先登录后再${action}`)
  router.push({ path: '/login', query: { redirect: route.fullPath } })
  return false
}

async function onFavorite() {
  if (!goods.value) return
  // ★ 游客点收藏：提示 + 去登录（详情页本身仍可继续浏览，这里只是不发那个必然 401 的请求）
  if (!requireLogin('收藏商品')) return
  const { favorited: on } = await toggleFavorite({ goods: goods.value })
  favorited.value = on
  ElMessage.success(on ? '已加入收藏' : '已取消收藏')
}

function onCart() {
  const g = goods.value
  if (!g) return
  if (!purchasable.value) {
    ElMessage.warning(purchasableBlockReason.value)
    return
  }
  /*
   * ★ 游客加购：要求登录 ★
   * 购物车虽然是**纯前端本地 store**（不调后端），但它的语义是「我的」——
   * 而且 `/cart` 路由本身要求登录。若允许游客加购，就会出现
   *「加购成功 → 点购物车被守卫拦去登录」，行为割裂；也会让
   *「登出后购物车里还留着上一个人的东西」这类遗留更明显。
   * 所以这里与收藏、购买保持同一口径：**凡「我的」数据，一律先登录**。
   */
  if (!requireLogin('加入购物车')) return
  /*
   * 加车必须落「挂牌价 + 实付价」双快照：
   * 让利价是活动期价格，卖家随时可能改价或活动结束，
   * 只存一个 price 会让购物车总价在用户不知情时跳变。
   * 归属按商品自己报名的活动判定（同分类可能挂着资金方不同的两条活动）。
   */
  const b = settlePrice(g, resolveFundSourceForGoods(g))
  cartStore.add({
    goodsId: g.id,
    title: g.title,
    listPrice: b.listPrice,
    promoPrice: b.onPromo ? b.payAmount : undefined,
    price: b.payAmount,
    cover: g.cover,
    // 数量上限来自商品本身，购物车加减不会超过卖家可售数量
    stock: resolveStock(g),
    quantity: 1,
    addedAt: Date.now()
  })
  ElMessage({
    message: b.onPromo ? `已加入购物车，本单省 ¥${(b.listPrice - b.payAmount).toFixed(2)}` : '已加入购物车',
    type: 'success',
    duration: 1500
  })
}

/* ============================================================
 * 立即购买：确认订单 → 直接下单（不经过购物车）
 * ============================================================ */
const buyVisible = ref(false)
const buying = ref(false)
const buyQty = ref(1)

/* ============================================================
 * 收货地址：接真实的「我的地址」
 *
 * 这里原先是 `const BUY_ADDRESS = '北京市海淀区学院路 38 号 计算机学院宿舍'` ——
 * 一句写死的常量，无论买家是谁、在哪个校区，落库的都是它。
 * 界面上「收货地址」一栏有内容、下单也一路成功，所以从表现上完全看不出问题；
 * 直到卖家准备发货才发现地址是假的，而买家在「我的地址」里维护的那条**从未被用过**。
 *
 * 这属于「假数据冒充真数据」：比直接报错更难发现，因为每一步看起来都正常。
 *
 * 现在按交易方式分流（口径集中在 utils/address.ts，与购物车结算共用同一份逻辑）：
 *   · express（包邮快递）→ 必须从地址簿选一条，提交前做非空校验；
 *   · face / self（面交 / 自提）→ 本就不需要地址，不进地址簿，也不往订单里塞假地址。
 * ============================================================ */
const addresses = ref<Address[]>([])
const chosenAddressId = ref<number | null>(null)

/** 这笔交易需不需要收货地址（只有快递需要） */
const needsShip = computed(() => needsShipping(goods.value?.deliveryMethod))

/** 面交 / 自提时的说明文案（说清「为什么这里没有地址可选」，而不是留一片空白） */
const noShipAddressText = computed(() =>
  goods.value?.deliveryMethod === 'self'
    ? '自提：到卖家指定地点自取，无需收货地址'
    : '校园面交：双方当面相约，无需收货地址'
)

/** 下拉里那一行地址的展示文案（收件人 + 电话 + 完整地址） */
function addressLabel(a: Address): string {
  return `${a.receiver} ${a.phone} · ${formatAddress(a)}`
}

/** 当前选中的地址（未选、或地址刚被删除时为 undefined） */
const chosenAddress = computed(() => addresses.value.find((a) => a.id === chosenAddressId.value))

/**
 * 拉取买家的收货地址簿。
 *
 * ★ 只在已登录时拉 ★ 未登录调 `/user/addresses` 会返回 401，
 * 而 `request.ts` 对 401 的处理是「清 token + 跳登录页」——
 * 商品详情页是**允许游客浏览**的，不该因为点开一件商品就被弹去登录。
 */
async function loadAddresses() {
  if (!userStore.isLoggedIn) return
  try {
    addresses.value = await fetchAddresses()
    chosenAddressId.value = pickDefaultAddress(addresses.value)?.id ?? null
  } catch {
    // 地址拉取失败不该挡住浏览商品：留空即可，提交时会被下面的校验拦住并给出明确提示
    addresses.value = []
  }
}

/** 只有在售且有货才可下单 —— 审核中 / 已下架 / 已售出都必须挡在门外 */
const purchasable = computed(() => {
  const g = goods.value
  return !!g && g.status === 'on_sale' && resolveStock(g) > 0
})

const purchasableBlockReason = computed(() => {
  const g = goods.value
  if (!g) return ''
  if (g.status === 'pending') return '该商品正在平台审核中，通过审核后才可购买。'
  if (g.status === 'sold') return '该商品已售出，可以看看同类商品或联系卖家。'
  if (g.status === 'off_shelf') return '该商品已被卖家下架，暂时无法购买。'
  return '该商品当前不可购买。'
})

/** 这一单最多能买几件 */
const maxBuyQty = computed(() => Math.min(resolveStock(goods.value), MAX_ORDER_QUANTITY))

/** 确认订单里的金额拆分（随数量实时变化，与下单落库走同一个 scaleBreakdown） */
const buyBreakdown = computed<PriceBreakdown>(() => {
  const g = goods.value
  if (!g) {
    return {
      listPrice: 0,
      payAmount: 0,
      sellerCut: 0,
      platformSubsidy: 0,
      sellerIncome: 0,
      discountLabel: '',
      onPromo: false,
      fundSource: 'seller'
    }
  }
  return scaleBreakdown(settlePrice(g, resolveFundSourceForGoods(g)), buyQty.value)
})

function onBuyNow() {
  const g = goods.value
  if (!g) return
  if (!purchasable.value) {
    ElMessage.warning(purchasableBlockReason.value)
    return
  }
  // ★ 游客点「立即购买」：弹确认订单前就拦住，别让他先填一遍再发现要登录
  if (!requireLogin('购买商品')) return
  buyQty.value = 1
  buyVisible.value = true
}

async function onSubmitBuy() {
  const g = goods.value
  if (!g) return
  /*
   * ★ 提交前再守一次（不只是用户在弹窗打开期间被登出）★
   * `onBuyNow` 已经有守卫，但下面这些路径能绕开它：
   *   · 弹窗已经打开时用户在另一个标签页登出；
   *   · 直接触发提交（回车提交）；
   *   · 未来有人把 onBuyNow 的守卫去掉。
   * 提交函数是**真正花钱的那一步**，闸门必须放在这里而不是只放在入口。
   */
  if (!requireLogin('购买商品')) return
  /*
   * 快递单必须带收货地址。
   * 这一步不能只靠按钮的 :disabled —— 回车提交、以及在弹窗打开期间地址被删除等边界情况
   * 都能绕开 disabled。真正的闸门要放在提交函数里。
   */
  const shipTo = chosenAddress.value
  if (needsShip.value && !shipTo) {
    ElMessage.warning('该商品需要用快递寄出，请先选择收货地址')
    return
  }
  buying.value = true
  try {
    const order = await createOrder({
      goodsId: g.id,
      quantity: buyQty.value,
      // 面交 / 自提不传地址：后端按交易方式记为「校园内面交」，而不是塞一个凭空的假地址
      address: shipTo ? formatAddress(shipTo) : undefined
    })
    buyVisible.value = false
    ElMessage.success(`下单成功（订单号 ${order.id}），请到订单中心完成支付`)
    // 库存可能已扣减，回到列表前先刷新本地快照
    await load()
    router.push('/order')
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '下单失败，请稍后再试')
  } finally {
    buying.value = false
  }
}

/** 跳到购物车 */
function goCart() {
  router.push('/cart')
}

/** 查看卖家主页（他人主页：信用 / 在售 / 收到的评价） */
function goSeller() {
  if (goods.value) router.push(`/user/${goods.value.sellerId}`)
}

/* ============================================================
 * 举报（举报表）
 * ============================================================ */
const reportVisible = ref(false)
const REPORT_REASONS = ['涉嫌虚假描述', '疑似违规商品', '价格欺诈', '假冒伪劣', '其他']
const reportForm = ref({ reason: '', description: '' })

async function onSubmitReport() {
  if (!goods.value) return
  // ★ 游客举报：举报是写操作，且举报人身份是处理依据 —— 必须登录
  if (!requireLogin('举报商品')) return
  try {
    await submitReport({
      type: 'goods',
      targetId: goods.value.id,
      reason: reportForm.value.reason,
      description: reportForm.value.description || reportForm.value.reason
    })
    ElMessage.success('举报已提交，平台会尽快核实处理')
    reportVisible.value = false
    reportForm.value = { reason: '', description: '' }
  } catch (e: any) {
    ElMessage.error(e?.message || '提交失败，请重试')
  }
}

/* ============================================================
 * 用户评价（评价表）
 * ============================================================ */
const reviews = ref<Review[]>([])
const avgRating = computed(() => {
  if (!reviews.value.length) return 0
  return reviews.value.reduce((s, r) => s + r.rating, 0) / reviews.value.length
})

/* ============================================================
 * 商品留言（留言表：评论 / 回复）
 * ============================================================ */
const comments = ref<GoodsComment[]>([])
const commentText = ref('')
/** 当前回复的目标；null = 发顶层留言 */
const replyTo = ref<GoodsComment | null>(null)

/** 组树：顶层留言 + 一层回复（按时间正序） */
const commentTree = computed(() => {
  const tops = comments.value.filter((c) => !c.parentId)
  return tops.map((c) => ({
    ...c,
    replies: comments.value.filter((r) => r.parentId === c.id)
  }))
})

async function onSendComment() {
  const text = commentText.value.trim()
  if (!text || !goods.value) return
  // ★ 游客发留言：留言框对游客是可见的（留言列表本身就是公开内容），
  //   所以必须在提交这一步拦住，否则点了发送会收到那句「登录状态已过期」
  if (!requireLogin('发表留言')) return
  try {
    const c = await postComment({
      goodsId: goods.value.id,
      content: text,
      parentId: replyTo.value?.id
    })
    comments.value = [...comments.value, c]
    commentText.value = ''
    replyTo.value = null
  } catch (e: any) {
    ElMessage.error(e?.message || '留言失败，请重试')
  }
}

/** 联系卖家：打开聊天抽屉（未登录会被路由守卫拦到登录页） */
async function onContactSeller() {
  if (!goods.value) return
  /*
   * 这段原先内联着「提示 + 带 redirect 跳登录」的写法 ——
   * 它其实就是 requireLogin 的雏形，现在统一走那个函数，
   * 保证全页所有需要登录的动作只有**一套**文案与跳转行为。
   */
  if (!requireLogin('联系卖家')) return
  try {
    chatSessionId.value = await openSession({
      myUserId: myUserId.value,
      toUserId: goods.value.sellerId,
      toUserName: goods.value.sellerName,
      toUserAvatar: goods.value.sellerAvatar,
      goodsId: goods.value.id,
      goodsTitle: goods.value.title,
      goodsCover: goods.value.cover
    })
    chatVisible.value = true
    await messageStore.refreshUnread()
  } catch (e: any) {
    ElMessage.error(e?.message || '打开会话失败')
  }
}

function onMessageSent() {
  messageStore.refreshUnread()
}

function goMessageCenter() {
  chatVisible.value = false
  if (chatSessionId.value) messageStore.setPendingSession(chatSessionId.value)
  router.push('/message')
}

onMounted(() => {
  load()
  // 地址簿与商品详情并行拉取；未登录时 loadAddresses 内部会直接返回（游客可浏览详情页）
  loadAddresses()
})
</script>

<style scoped lang="scss">
@use '@/styles/variables.scss' as *;

.detail-page {
  max-width: 1200px;
  margin: 0 auto;
}

/* 返回按钮：44px 命中区域，避免"点不中" */
.back-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 36px;
  padding: 0 14px 0 10px;
  margin-bottom: $sp-2;
  border: 1px solid transparent;
  border-radius: $radius-pill;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: $fs-13;
  transition: background-color $dur-base $ease-out, color $dur-base $ease-out,
    border-color $dur-base $ease-out;

  &:hover {
    background: var(--bg-card);
    border-color: var(--border-color);
    color: var(--color-text-primary);
  }
}

.detail-wrap {
  margin-top: $sp-2;
  min-height: 320px;
}

/* ============================================================
   栅格：7 : 5（图集略宽）
   ============================================================ */
.detail-grid {
  display: grid;
  grid-template-columns: minmax(0, 7fr) minmax(0, 5fr);
  gap: $sp-5;
  align-items: start;
}

/* ---------------------------- 图集 ---------------------------- */
.gallery {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: $radius-md;
  padding: $sp-3;
  box-shadow: $shadow-xs;
}

.main-img {
  position: relative;
  width: 100%;
  aspect-ratio: 4 / 3;
  border-radius: $radius-sm;
  overflow: hidden;
  background: var(--bg-soft);

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .img-flag {
    position: absolute;
    top: 12px;
    left: 12px;
    padding: 6px 12px;
    border-radius: $radius-xs;
    background: rgba(31, 35, 41, 0.72);
    color: #fff;
    font-size: $fs-12;
    font-weight: $fw-medium;
    backdrop-filter: blur(4px);
  }
}

.thumbs {
  display: flex;
  gap: $sp-2;
  margin-top: $sp-3;
  flex-wrap: wrap;
}

.thumb {
  width: 68px;
  height: 68px;
  padding: 0;
  border: 2px solid transparent;
  border-radius: $radius-sm;
  overflow: hidden;
  background: var(--bg-soft);
  cursor: pointer;
  transition: border-color $dur-base $ease-out, transform $dur-base $ease-out;

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  &:hover { transform: translateY(-2px); }

  &.active {
    border-color: $brand-orange;
    box-shadow: 0 0 0 3px rgba(255, 106, 0, 0.14);
  }
}

/* ---------------------------- 信息面板 ---------------------------- */
.info {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: $radius-md;
  padding: $sp-5;
  box-shadow: $shadow-xs;
}

/* 卖家行 */
.seller-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: $fs-13;
  color: var(--color-text-mute);
  flex-wrap: wrap;

  .seller-link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 0;
    border: none;
    background: none;
    cursor: pointer;
    font-size: $fs-13;
  }

  .seller-avatar {
    background: linear-gradient(135deg, #ffb066, $brand-orange);
    color: #fff;
    font-size: 12px;
    font-weight: $fw-semibold;
    flex-shrink: 0;
  }
  .seller-name {
    color: $color-primary;
    font-weight: $fw-medium;
    text-decoration: none;
    &:hover { color: $color-primary-hover; text-decoration: underline; }
  }
  /* 卖家在线标识：隐私开关（showOnline）关闭时整个元素不渲染 */
  .online-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-left: 8px;
    padding: 1px 8px;
    border-radius: 999px;
    font-size: 11px;
    line-height: 18px;
    &::before {
      content: '';
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
    }
    &.is-online {
      color: #059669;
      background: rgba(5, 150, 105, 0.1);
    }
    &.is-offline {
      color: var(--color-text-mute);
      background: var(--bg-soft);
    }
  }
  .credit-label { color: var(--color-text-mute); }
  .credit-score {
    color: #047857;
    font-weight: $fw-bold;
    font-variant-numeric: tabular-nums;
  }
  .sep { color: var(--border-color-strong); }

  /* 收藏：升级为「图标 + 文字 + 计数」醒目样式（参考图 6.4） */
  .fav-btn {
    margin-left: auto;
    height: 32px;
    padding: 0 12px;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: 1px solid var(--border-color);
    border-radius: $radius-pill;
    background: #fff;
    color: var(--color-text-secondary);
    font-size: $fs-13;
    font-weight: $fw-medium;
    cursor: pointer;
    transition:
      color $dur-base $ease-out,
      border-color $dur-base $ease-out,
      background-color $dur-base $ease-out,
      transform $dur-fast $ease-out;

    .fav-btn-count {
      color: var(--color-text-mute);
      font-size: $fs-12;
      font-variant-numeric: tabular-nums;
      font-weight: $fw-normal;
    }

    &:hover {
      color: $brand-orange;
      border-color: rgba(255, 106, 0, 0.4);
      background: $brand-orange-soft;
    }
    &:active { transform: scale(0.96); }

    &.is-on {
      color: #fff;
      border-color: transparent;
      background: linear-gradient(135deg, #ffb066, $brand-orange);
      box-shadow: 0 4px 10px -3px rgba(255, 106, 0, 0.5);

      .fav-btn-count { color: rgba(255, 255, 255, 0.85); }
    }
  }
}

/* 标题：与卖家行留出呼吸感 */
.title {
  margin-top: $sp-3;
  font-size: $fs-20;
  font-weight: $fw-bold;
  color: var(--color-text-primary);
  line-height: 1.4;
  letter-spacing: -0.01em;
}

/* 价格区：浅暖底 + 圆角，形成明确的视觉重心 */
.price-block {
  margin-top: $sp-4;
  padding: $sp-4 $sp-5;
  border-radius: $radius-sm;
  background: linear-gradient(100deg, #fff8f0 0%, #fff1e0 100%);
  border: 1px solid $brand-orange-line;
}

/* 让利归属说明：折扣的钱是谁出的，必须讲清楚（合规也需要） */
.promo-note {
  margin: $sp-3 0 0;
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: $fs-12;
  line-height: 1.5;
  color: var(--color-text-mute);
}

.promo-badge {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  border-radius: $radius-xs;
  background: $brand-orange;
  color: #fff;
  font-size: $fs-11;
  font-weight: $fw-semibold;
  letter-spacing: 0.02em;
}

/* 事实行 */
.facts {
  margin-top: $sp-4;
  display: flex;
  flex-direction: column;
  gap: 8px;

  li {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: $fs-13;
    color: var(--color-text-secondary);
    flex-wrap: wrap;

    .el-icon { color: var(--color-text-mute); font-size: 14px; margin-right: 2px; }
    .sep { color: var(--border-color-strong); margin: 0 2px; }

    /* 不可购买时数量用警示色，让「为什么买不了」在事实行就能被看到 */
    .is-lack { color: $brand-orange-deep; font-weight: $fw-medium; }
  }
}

/* 不可购买的原因说明条 */
.buy-block {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: $sp-3 0 0;
  padding: 9px 12px;
  border-radius: $radius-sm;
  background: $brand-orange-soft;
  border: 1px solid $brand-orange-line;
  color: #b45309;
  font-size: $fs-13;
  line-height: 1.5;

  .el-icon { flex-shrink: 0; }
}

/* 主行动区：等宽 3 按钮，高 48px（参考图 6.4：联系 / 加购 / 立即购买） */
.actions {
  display: flex;
  gap: $sp-3;
  margin-top: $sp-5;

  .act {
    flex: 1 1 0;
    height: 48px;
    margin: 0;
    font-size: $fs-15;
    font-weight: $fw-semibold;
    border-radius: $radius-sm;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    transition: transform $dur-fast $ease-out, box-shadow $dur-base $ease-out;
    &:active { transform: scale(0.98); }
  }

  /* 加入购物车：橙色描边白底，与"立即购买"形成强 vs 弱主次 */
  .btn-cart {
    background: #fff;
    color: $brand-orange;
    border: 1.5px solid $brand-orange;
    box-shadow: none;

    &:hover {
      background: $brand-orange-soft;
      color: $brand-orange-deep;
      border-color: $brand-orange-deep;
      box-shadow: 0 4px 10px -4px rgba(255, 106, 0, 0.4);
    }
  }

  /*
   * 不可购买（已售出 / 审核中 / 已下架）的禁用态。
   *
   * 口径 = 「橙色被一层灰压住」，**不是**「橙色里掺灰」。
   * 掺灰是把橙和灰调成第三个中间色 —— 那会把橙的彩度冲掉，得到一堆脏棕调，明确否掉。
   *
   * 做法是两层叠加，灰是「罩在上面的一层」，不是「拌进去的一勺」：
   *   ① 底层 = 品牌橙本身（色相、饱和度都不动）
   *   ② 上层 = 一层**中性灰纱**（background-image 叠在 background-color 之上）
   *
   * 两个已经踩过的坑，别再往回走：
   *   ✗ 深灰重纱（明度≈18%、52%）—— 看着像「压住」，其实是把橙压暗，
   *     而**暗橙在人眼里就是棕**，橙反而认不出来（候选 A 实测）；
   *   ✗ 中灰薄纱 → 会把橙整个冲淡成脏粉（第一次的版本）。
   *
   * 落点选在**中性中灰、约 24%**（二次调淡：0.38 → 0.24，要的是「蒙着一层灰色薄纱」的朦胧感）：
   *   合成色 #db6a19 —— 色相 24.9° 与品牌橙 #ff6a00 完全相同（灰纱 R=G=B，零色偏，且
   *   **与纱的浓淡无关**：中性纱叠多少，色相都钉在 60×106/255 上），
   *   饱和度 0.89、亮度 0.86，都低于品牌橙的 1.00 —— 橙还在，只是被一层薄纱蒙住、掉了能量。
   *   既没被调成棕，也没被冲成粉。
   * 实心款用白字（与可用态同一套字色，一眼认出是同一个 CTA）；
   * 禁用控件按 WCAG 1.4.3 属豁免项，此处白字对比度 ≈3.4:1，够看。
   *
   * 描边款的文字与描边用「压暗的橙」（同色相只降亮度，不掺灰）——
   * 全按钮不存在灰橙混色的中间调，灰只以「底色/纱」的形态出现。
   */
  $dis-orange: #b1510f; // 压暗的橙（24.4°，S≈0.92）：文字，近白底上 4.6:1 过 AA
  $dis-orange-line: #c26f38; // 压暗的橙（亮一档）：描边，非文本对比 ≈3.3:1，负责扛「橙」的识别度
  $dis-veil-thin: rgba(104, 104, 104, 0.06); // 白底上的薄灰纱：只求「蒙了一层」的朦胧感
  $dis-veil-deep: rgba(104, 104, 104, 0.24); // 品牌橙上的灰纱：中性（R=G=B）→ 色相零偏移

  /* 加入购物车（描边款）：白底蒙薄灰纱，橙保留原色相、只压暗 */
  .btn-cart.is-disabled,
  .btn-cart.is-disabled:hover,
  .btn-cart.is-disabled:focus,
  .btn-cart.is-disabled:active {
    background-color: #fff;
    background-image: linear-gradient($dis-veil-thin, $dis-veil-thin);
    color: $dis-orange;
    border: 1.5px solid $dis-orange-line;
    box-shadow: none;
    opacity: 1;
    cursor: not-allowed;
    transform: none;
    text-decoration: none;
  }

  /* 立即购买（实心款）：品牌橙打底，上面罩中性灰纱 —— 橙被罩住、发闷，但不发棕 */
  .btn-brand.is-disabled,
  .btn-brand.is-disabled:hover,
  .btn-brand.is-disabled:focus,
  .btn-brand.is-disabled:active {
    background-color: $brand-orange;
    background-image: linear-gradient($dis-veil-deep, $dis-veil-deep);
    color: #fff;
    border: none;
    /* 内圈留一道细橙边：让「灰纱下面罩着的确实是橙」看得出来（薄纱下不必太实） */
    box-shadow: inset 0 0 0 1.5px rgba(255, 106, 0, 0.3);
    opacity: 1;
    cursor: not-allowed;
    transform: none;
    text-decoration: none;
  }

  /* 图标跟随文字色，别在灰纱上留一抹原始的亮橙 */
  .act.is-disabled .el-icon {
    color: inherit;
  }
}

/* 次要操作行 */
.sub-actions {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: $sp-2;
  margin-top: $sp-3;

  .sub-act {
    color: var(--color-text-mute);
    font-size: $fs-13;
    font-weight: $fw-normal;
    height: 32px;
    gap: 5px;

    &:hover { color: $color-primary; background: transparent; }
  }
  .sub-divider {
    width: 1px;
    height: 12px;
    background: var(--border-color-strong);
  }
  .sub-link {
    color: $color-primary;
    font-size: $fs-13;
    cursor: pointer;
    background: transparent;
    border: none;
    padding: 0;
    transition: color $dur-base $ease-out;
    &:hover { color: $color-primary-hover; text-decoration: underline; }
    &.is-danger { color: $color-danger; &:hover { color: #dc2626; } }
  }
}

/* ---------------------------- 描述卡 ---------------------------- */
.desc-card {
  margin-top: $sp-5;
  padding: $sp-5;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: $radius-md;
  box-shadow: $shadow-xs;
}

.desc-text {
  font-size: $fs-14;
  line-height: 1.85;
  color: var(--color-text-secondary);
  white-space: pre-wrap;
  word-break: break-word;

  .desc-icon { margin-right: 6px; }
  .desc-label {
    color: var(--color-text-primary);
    font-weight: $fw-semibold;
  }
}

/* ============================================================
   通用区块卡（评价 / 留言）
   ============================================================ */
.block-card {
  margin-top: $sp-4;
  padding: $sp-5;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: $radius-md;
  box-shadow: $shadow-xs;
}

.block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: $sp-4;

  h3 {
    margin: 0;
    font-size: $fs-16;
    font-weight: $fw-semibold;
    color: var(--color-text-primary);
    display: flex; align-items: center; gap: 6px;

    .count {
      font-size: $fs-13;
      color: var(--color-text-mute);
      font-weight: $fw-normal;
      &::before { content: '('; }
      &::after { content: ')'; }
    }
  }

  .review-summary {
    display: flex; align-items: center; gap: 8px;
    .avg-num { font-size: $fs-13; color: $brand-orange; font-weight: $fw-semibold; }
  }
}

.block-empty {
  padding: $sp-6 0;
  text-align: center;
  color: var(--color-text-mute);
  font-size: $fs-13;
  background: var(--bg-soft);
  border-radius: $radius-sm;
}

/* ---------------------------- 评价列表 ---------------------------- */
.review-list {
  list-style: none;
  margin: 0; padding: 0;
  display: flex;
  flex-direction: column;

  .review-item {
    display: flex;
    gap: $sp-3;
    padding: $sp-3 0;

    & + .review-item { border-top: 1px dashed var(--border-color); }

    .rv-avatar {
      flex-shrink: 0;
      background: linear-gradient(135deg, #93c5fd, $color-primary);
      color: #fff; font-size: 12px; font-weight: $fw-semibold;
    }

    .rv-body { flex: 1; min-width: 0; }
    .rv-head {
      display: flex; align-items: center; gap: $sp-2;
      .rv-name { font-size: $fs-13; font-weight: $fw-medium; color: var(--color-text-primary); }
    }
    .rv-content {
      margin: 4px 0;
      font-size: $fs-14;
      color: var(--color-text-secondary);
      line-height: 1.7;
    }
    .rv-time { font-size: $fs-12; color: $text-4; }

    /* 追评：橙底 + 左橙线，与首评拉开层次，但仍在同一条评价里 */
    .rv-append {
      margin-top: $sp-2;
      padding: 8px 10px;
      border-radius: $radius-sm;
      background: $brand-orange-soft;
      border-left: 3px solid $brand-orange;
    }
    .rv-append-tag {
      display: inline-block;
      margin-bottom: 3px;
      font-size: $fs-11;
      font-weight: $fw-semibold;
      color: $brand-orange-deep;
    }
    .rv-append-txt {
      margin: 0 0 2px;
      font-size: $fs-13;
      color: var(--color-text-secondary);
      line-height: 1.7;
      word-break: break-word;
    }
  }
}

/* ---------------------------- 留言区 ---------------------------- */
.comment-input-row {
  display: flex;
  gap: $sp-3;
  margin-bottom: $sp-4;

  .ci-avatar {
    flex-shrink: 0;
    background: linear-gradient(135deg, #ffb066, $brand-orange);
    color: #fff; font-size: 12px; font-weight: $fw-semibold;
  }

  .ci-box { flex: 1; min-width: 0; }

  .ci-reply-hint {
    display: flex; align-items: center; gap: 8px;
    margin-bottom: 6px;
    font-size: $fs-12;
    color: $color-primary;

    .ci-cancel {
      border: none; background: none; padding: 0;
      color: var(--color-text-mute); font-size: $fs-12; cursor: pointer;
      &:hover { color: var(--color-text-primary); }
    }
  }

  .ci-main { display: flex; gap: $sp-2; }
}

.comment-list {
  list-style: none;
  margin: 0; padding: 0;

  .comment-item {
    display: flex;
    gap: $sp-3;
    padding: $sp-3 0;

    & + .comment-item { border-top: 1px dashed var(--border-color); }

    .cm-avatar {
      flex-shrink: 0;
      background: linear-gradient(135deg, #a7c7ff, $color-primary);
      color: #fff; font-size: 12px; font-weight: $fw-semibold;

      &.sm { width: 26px; height: 26px; font-size: 11px; }
    }

    .cm-body { flex: 1; min-width: 0; }
    .cm-head {
      display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
      .cm-name {
        font-size: $fs-13; font-weight: $fw-medium; color: var(--color-text-primary);
        text-decoration: none;
        &:hover { color: $color-primary; text-decoration: underline; }
      }
      .cm-replyto { font-size: $fs-12; color: $color-primary; }
      .cm-time { font-size: $fs-12; color: $text-4; }
    }
    .cm-content {
      margin: 4px 0;
      font-size: $fs-14;
      color: var(--color-text-secondary);
      line-height: 1.7;
      word-break: break-word;
    }
    .cm-reply-btn {
      border: none; background: none; padding: 0;
      color: var(--color-text-mute); font-size: $fs-12; cursor: pointer;
      transition: color $dur-base $ease-out;
      &:hover { color: $color-primary; }
    }
  }
}

.reply-list {
  list-style: none;
  margin: $sp-2 0 0;
  padding: $sp-2 0 0 $sp-3;
  border-left: 2px solid var(--border-color);

  .reply-item {
    display: flex;
    gap: $sp-2;
    padding: 6px 0;

    .cm-body { flex: 1; min-width: 0; }
  }
}

/* ---------------------------- 抽屉内容 ---------------------------- */
.policy-content {
  padding: 0 18px;

  h4 {
    color: $color-primary;
    font-size: $fs-15;
    margin: $sp-4 0 6px;
  }
  p {
    color: var(--color-text-secondary);
    font-size: $fs-14;
    line-height: 1.8;
    margin-bottom: 8px;
  }
}

.chat-tip {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 8px 18px 4px;
  padding: 10px 12px;
  background: var(--bg-soft);
  border-radius: $radius-sm;
  font-size: $fs-12;
  color: var(--color-text-mute);
}

.chat-actions {
  margin: 0 18px 18px;
  text-align: right;
}

/* ---------------------------- 确认订单弹窗 ---------------------------- */
.buy-form {
  display: flex;
  flex-direction: column;
  gap: 14px;

  .bf-goods {
    display: flex;
    align-items: center;
    gap: 10px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border-color);

    .bf-img { width: 52px; height: 52px; border-radius: $radius-sm; flex-shrink: 0; }
    .bf-info { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .bf-title {
      font-size: $fs-13;
      color: var(--color-text-primary);
      font-weight: $fw-medium;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .bf-sub { font-size: $fs-12; color: var(--color-text-mute); }
  }

  .bf-row {
    display: flex;
    align-items: center;
    gap: 10px;

    .bf-label { width: 68px; flex-shrink: 0; font-size: $fs-13; color: var(--color-text-mute); }
    .bf-hint { font-size: $fs-12; color: $text-4; }
    .bf-addr { font-size: $fs-13; color: var(--color-text-secondary); line-height: 1.5; }
    /* 地址下拉吃掉剩余宽度；min-width:0 是 flex 子项默认不肯收缩的关键 */
    .bf-addr-select { flex: 1; min-width: 0; }
    /* 「还没添加地址」是待办提示而非正常内容，弱化一档，别和真实地址一个观感 */
    .bf-addr.is-empty { color: var(--color-text-mute); }
  }

  .bf-amount {
    padding: 12px;
    background: var(--bg-soft);
    border: 1px solid var(--border-color);
    border-radius: $radius-sm;

    .bf-line {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      font-size: $fs-13;
      color: var(--color-text-secondary);
      line-height: 1.9;

      s { color: $text-4; font-variant-numeric: tabular-nums; }
      b { color: $brand-orange; font-size: $fs-18; font-variant-numeric: tabular-nums; }
    }

    .bf-note {
      margin: 6px 0 0;
      font-size: $fs-12;
      color: $brand-orange-deep;
      line-height: 1.7;

      /* 恒等式写成小字，供卖家/运营核对，不抢主视觉 */
      .bf-equation { display: block; color: var(--color-text-mute); }
    }
  }
}

/* ---------------------------- 响应式 ---------------------------- */
@media (max-width: $breakpoint-md) {
  .detail-grid { grid-template-columns: minmax(0, 1fr); }
  .info { padding: $sp-4; }
  .title { font-size: $fs-18; }
  .price-block { padding: $sp-3 $sp-4; }
}

@media (max-width: $breakpoint-sm) {
  .thumb { width: 56px; height: 56px; }
  .actions { flex-wrap: wrap; }
  .actions .act {
    flex: 1 1 calc(50% - #{$sp-2});
    height: 44px;
    font-size: $fs-14;
  }
  .sub-actions { flex-wrap: wrap; }
}

@media (prefers-reduced-motion: reduce) {
  .back-btn,
  .thumb,
  .fav-btn { transition: none !important; }
  .thumb:hover { transform: none; }
}
</style>
