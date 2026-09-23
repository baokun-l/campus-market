<template>
  <PageContainer
    back
    title="购物车"
    subtitle="确认好你的商品后进入下单流程"
  >
    <template #actions>
      <el-button
        :disabled="cartStore.items.length === 0"
        @click="clearAll"
      >
        清空
      </el-button>
    </template>

    <el-table
      :data="cartStore.items"
      empty-text="购物车空空如也，快去逛逛吧～"
      class="cart-table"
    >
      <el-table-column
        label="商品"
        min-width="280"
      >
        <template #default="{ row }">
          <div class="goods-cell">
            <el-image
              :src="row.cover"
              fit="cover"
              class="thumb"
            />
            <span class="title">{{ row.title }}</span>
          </div>
        </template>
      </el-table-column>

      <!--
        单价列展示「实付价 + 划线挂牌价」：
        购物车存的是加入时的价格快照，挂牌价用于让用户核对省了多少，
        绝不是为了制造折扣感而凭空生造的"原价"。
      -->
      <el-table-column
        label="单价"
        width="150"
        align="center"
      >
        <template #default="{ row }">
          <PriceTag
            size="sm"
            :list-price="row.listPrice"
            :promo-price="row.promoPrice"
          />
        </template>
      </el-table-column>

      <!--
        数量上限 = 卖家可售数量（加入购物车时快照）。
        允许选到 99 件再在下单时报「库存不足」，等于把失败推给用户，
        不如在选的一刻就封顶，并在下方写明库存是多少。
      -->
      <el-table-column
        label="数量"
        width="190"
        align="center"
      >
        <template #default="{ row }">
          <el-input-number
            :model-value="row.quantity"
            :min="1"
            :max="cartStore.maxQtyOf(row.goodsId)"
            size="small"
            @change="(v) => onQtyChange(row.goodsId, v)"
          />
          <div class="qty-stock">
            库存 {{ cartStore.maxQtyOf(row.goodsId) }} 件
          </div>
        </template>
      </el-table-column>

      <el-table-column
        label="小计"
        width="130"
        align="center"
      >
        <template #default="{ row }">
          <div class="subtotal">
            <b>¥{{ (row.price * row.quantity).toFixed(2) }}</b>
            <span
              v-if="row.price < row.listPrice"
              class="sub-origin"
            >
              挂牌 ¥{{ (row.listPrice * row.quantity).toFixed(2) }}
            </span>
          </div>
        </template>
      </el-table-column>

      <el-table-column
        label="操作"
        width="100"
        align="center"
        fixed="right"
      >
        <template #default="{ row }">
          <el-button
            text
            type="danger"
            @click="cartStore.remove(row.goodsId)"
          >
            移除
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <div class="summary">
      <div class="sum-left">
        <span>共 {{ cartStore.totalCount }} 件商品</span>
        <!-- 把「本次下单用的是哪条地址」挪到点击前就可见：地址写错了只有发货时才会暴露 -->
        <span
          v-if="userStore.isLoggedIn && defaultAddress"
          class="ship-to"
        >收货地址：{{ formatAddress(defaultAddress) }}</span>
        <span
          v-else-if="userStore.isLoggedIn"
          class="ship-to is-empty"
        >未设置收货地址（面交 / 自提不受影响）</span>
        <!-- 让利金额单独成行说明来源，避免"平台暗中打折"的错觉 -->
        <span
          v-if="cartStore.hasPromo"
          class="saved"
        >
          活动让利已省 <b>¥{{ cartStore.savedTotal.toFixed(2) }}</b>
          <em class="saved-hint">（挂牌合计 ¥{{ cartStore.listTotal.toFixed(2) }}）</em>
        </span>
      </div>
      <span class="amount">合计：<b>¥{{ cartStore.totalPrice.toFixed(2) }}</b></span>
      <el-button
        type="primary"
        size="large"
        :loading="submitting"
        :disabled="cartStore.items.length === 0"
        @click="onCheckout"
      >
        去结算
      </el-button>
    </div>
  </PageContainer>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import PageContainer from '@/components/common/PageContainer.vue'
import PriceTag from '@/components/common/PriceTag.vue'
import { useCartStore } from '@/stores/modules/cart'
import { createOrder } from '@/api/order'
import { fetchAddresses } from '@/api/user'
import { formatAddress, pickDefaultAddress } from '@/utils/address'
import { useUserStore } from '@/stores/modules/user'
import type { Address } from '@/types'
import { useRouter } from 'vue-router'

const cartStore = useCartStore()
const router = useRouter()
const submitting = ref(false)

/* ============================================================
 * 收货地址
 *
 * ★ 购物车结算原先**根本不传 address** ★ 后端 `createOrder` 于是回落到
 * `'校园内面交'` —— 也就是说从购物车下的每一单，收货地址都是后端兜底的默认值，
 * 用户在地址簿里维护的地址从未进过库，而接口一路 200、界面上也看不出异常。
 *
 * 这里取地址簿的默认地址随单提交，并在结算前把「本次用的是哪条地址」明示出来：
 * 地址这东西一旦错了，只有卖家发货时才会暴露，事后无法补救。
 *
 * ★ 为什么购物车不做「按交易方式分流」★
 * 购物车是**混装**的：一车商品里可能既有面交的、也有快递的，而购物车条目
 * 并不保存每件商品的 deliveryMethod。给面交的单多带一条地址无害（后端照存，
 * 交易方式仍是面交），但反过来「因为车里有面交商品就不传地址」会害了快递商品。
 * 所以统一带上默认地址，真正的分流交给商品详情页（那里知道单件商品的交易方式）。
 * ============================================================ */
const userStore = useUserStore()
const addresses = ref<Address[]>([])
const defaultAddress = computed(() => pickDefaultAddress(addresses.value))

onMounted(async () => {
  if (!userStore.isLoggedIn) return
  try {
    addresses.value = await fetchAddresses()
  } catch {
    // 取不到地址不该挡住结算：按「未配置地址」处理，由后端记为「校园内面交」
    addresses.value = []
  }
})

async function clearAll() {
  try {
    await ElMessageBox.confirm('确认清空购物车？', '提示', { type: 'warning' })
    cartStore.clear()
    ElMessage.success('已清空')
  } catch {/* cancel */}
}

/**
 * 数量变更统一走 store 的 setQty —— 由它负责夹取到 [1, 库存]。
 * el-input-number 直接 v-model 到 row.quantity 会绕过夹取，
 * 手工输入一个超出库存的数字就能带进结算。
 */
function onQtyChange(goodsId: number, value: number | undefined) {
  cartStore.setQty(goodsId, Number(value ?? 1))
}

/**
 * 去结算：逐件生成真实订单（不再只是弹一句「正在为你下单…」）。
 *
 * 逐件而不是批量：部分商品可能已下架 / 已售罄，
 * 一键全清会把失败商品也一起从购物车抹掉，用户再也找不到它。
 * 这里只移除下单成功的条目，失败的原样留在车里并说明原因。
 */
async function onCheckout() {
  if (cartStore.items.length === 0) return
  // 结算用的地址在点击时定一次，之后不管列表怎么变都提交同一份
  const shipTo = defaultAddress.value
  try {
    await ElMessageBox.confirm(
      `共 ${cartStore.totalCount} 件商品，合计 ¥${cartStore.totalPrice.toFixed(2)}，` +
        (shipTo
          ? `收货地址：${formatAddress(shipTo)}，确认提交订单？`
          : '尚未设置收货地址（面交 / 自提不受影响，快递商品请先到「个人中心 · 收货地址」补充），确认提交订单？'),
      '提交订单',
      { type: 'info', confirmButtonText: '提交订单', cancelButtonText: '再看看' }
    )
  } catch {
    return
  }

  submitting.value = true
  const created: string[] = []
  const failed: string[] = []
  for (const it of cartStore.items.slice()) {
    try {
      const order = await createOrder({
        goodsId: it.goodsId,
        quantity: it.quantity,
        // 带上真实收货地址；一件都没配时传 undefined，由后端按交易方式记「校园内面交」
        address: shipTo ? formatAddress(shipTo) : undefined
      })
      created.push(order.id)
      cartStore.remove(it.goodsId)
    } catch (e) {
      failed.push(`${it.title}（${e instanceof Error ? e.message : '下单失败'}）`)
    }
  }
  submitting.value = false

  if (created.length) ElMessage.success(`已生成 ${created.length} 笔待付款订单`)
  if (failed.length) ElMessage.warning(`以下商品未能下单：${failed.join('；')}`)
  if (created.length) router.push('/order')
}
</script>

<style scoped lang="scss">
@use '@/styles/variables.scss' as *;

.cart-table { border-radius: var(--radius-md); }

.goods-cell { display: flex; align-items: center; gap: 10px;
  .thumb { width: 60px; height: 60px; border-radius: 6px; flex-shrink: 0; }
  .title { font-size: 13px; line-height: 1.5; }
}

.subtotal {
  display: flex; flex-direction: column; align-items: center; gap: 2px;
  b { color: $brand-orange; font-size: 15px; font-variant-numeric: tabular-nums; }
  .sub-origin {
    color: $text-4; font-size: $fs-11;
    font-variant-numeric: tabular-nums;
  }
}

/* 数量列下方标注库存，让「最多能选几件」有据可依 */
.qty-stock {
  margin-top: 4px;
  font-size: $fs-11;
  color: var(--color-text-mute);
  font-variant-numeric: tabular-nums;
}

.summary {
  display: flex; align-items: center; justify-content: flex-end;
  gap: 20px; padding: 18px; margin-top: 16px;
  background: #fff; border: 1px solid var(--border-color); border-radius: var(--radius-md);

  .sum-left {
    display: flex; flex-direction: column; align-items: flex-start; gap: 4px;
    margin-right: auto;
    span { color: var(--color-text-secondary); font-size: $fs-13; }
    .saved {
      color: var(--color-text-mute);
      b { color: $brand-orange; font-variant-numeric: tabular-nums; }
      .saved-hint { color: $text-4; font-style: normal; font-size: $fs-11; }
    }
    /* 地址可能很长：允许换行，别把底栏撑破 */
    .ship-to { max-width: 520px; line-height: 1.5; }
    /* 「未设置地址」是待办提示，弱化一档，与真实地址区分开 */
    .ship-to.is-empty { color: var(--color-text-mute); }
  }

  .amount b { color: var(--color-accent); font-size: 22px; margin-left: 6px; font-variant-numeric: tabular-nums; }
}

@media (max-width: 640px) {
  .summary { flex-direction: column; align-items: stretch; gap: 12px; }
  .summary .sum-left { margin-right: 0; }
}
</style>
