<template>
  <div class="fav-page">
    <BackButton />
    <!-- 顶部 Banner · 平台背景渐变 蓝→紫 -->
    <section class="fav-hero">
      <div class="hero-text">
        <h1 class="hero-title">
          <el-icon
            :size="22"
            class="hero-icon"
          >
            <Star />
          </el-icon>
          我的收藏
        </h1>
        <p class="hero-sub">
          收藏的好物都在这里，降价、售出时会收到通知提醒
        </p>
      </div>
      <div class="hero-stat">
        <span class="stat-num">{{ totalCount }}</span>
        <span class="stat-label">件收藏</span>
      </div>
    </section>

    <!-- 工具条：全部/在售/已售 + 视图切换 -->
    <section class="toolbar">
      <div class="filter-row">
        <el-radio-group
          v-model="statusFilter"
          @change="reload"
        >
          <el-radio-button label="">
            全部
          </el-radio-button>
          <el-radio-button label="on_sale">
            在售
          </el-radio-button>
          <el-radio-button label="sold">
            已售出
          </el-radio-button>
        </el-radio-group>
        <span class="hint">{{ totalCount }} 件</span>
      </div>
      <div class="action-row">
        <el-button
          v-if="favorites.length > 0"
          text
          type="danger"
          @click="onClearAll"
        >
          <el-icon><Delete /></el-icon> 清空收藏
        </el-button>
      </div>
    </section>

    <!-- 主体：网格 / 空态 -->
    <section
      v-loading="loading"
      class="grid-wrap"
      :class="{ 'is-empty': totalCount === 0 }"
    >
      <div
        v-if="totalCount > 0"
        class="fav-grid"
      >
        <article
          v-for="f in favorites"
          :key="f.id"
          class="fav-card"
          :class="{ 'is-unavailable': f.goods.status !== 'on_sale' }"
        >
          <div
            class="fav-cover"
            @click="goDetail(f.goods.id)"
          >
            <img
              :src="f.goods.cover"
              :alt="f.goods.title"
              loading="lazy"
            >
            <!-- 状态必须如实显示：先前只画「已售出」，审核中/已下架既没角标又点不动详情，
                 用户会以为是页面卡死（见 issue：没显示已售出却看不了详情） -->
            <span
              v-if="statusMeta(f.goods.status)"
              class="cover-flag"
              :class="`is-${f.goods.status}`"
            >
              {{ statusMeta(f.goods.status)!.label }}
            </span>
            <button
              type="button"
              class="cover-unfav"
              :aria-label="`取消收藏 ${f.goods.title}`"
              @click.stop="onUnfav(f)"
            >
              <span
                class="x-mark"
                aria-hidden="true"
              >×</span>
            </button>
          </div>

          <div class="fav-body">
            <h3
              class="fav-title"
              :title="f.goods.title"
              @click="goDetail(f.goods.id)"
            >
              {{ f.goods.title }}
            </h3>
            <div class="fav-price">
              <PriceTag
                :list-price="f.goods.price"
                :promo-price="f.goods.promoPrice"
              />
            </div>
            <div class="fav-meta">
              <span class="meta-loc">
                <el-icon><Location /></el-icon>
                {{ f.goods.location }}
              </span>
              <span class="meta-seller">@{{ f.goods.sellerName }}</span>
            </div>
            <div class="fav-foot">
              <span class="meta-time">收藏于 {{ formatRelative(f.createTime) }}</span>
              <div class="foot-actions">
                <el-button
                  size="small"
                  plain
                  :disabled="f.goods.status !== 'on_sale'"
                  :title="cartDisabledReason(f.goods.status)"
                  @click.stop="onCartFromFav(f)"
                >
                  <el-icon><ShoppingCart /></el-icon>
                  <span>加入购物车</span>
                </el-button>
                <!-- 看详情是只读浏览，任何状态都该能点：下架/售出商品的历史信息本身就有参考价值 -->
                <el-button
                  size="small"
                  type="primary"
                  @click.stop="goDetail(f.goods.id)"
                >
                  查看详情
                </el-button>
              </div>
            </div>
          </div>
        </article>
      </div>

      <EmptyState
        v-else
        icon="⭐"
        :title="statusFilter ? '该状态下没有收藏' : '还没有收藏任何商品'"
        :description="statusFilter ? '切换到「全部」试试' : '在商品详情页点击右上角的星标即可加入收藏'"
        action-text="去逛逛"
        @action="$router.push('/goods')"
      />
    </section>
  </div>
</template>

<script setup lang="ts">
import BackButton from '@/components/common/BackButton.vue'
/**
 * 我的收藏独立页
 * - 复用 Profile.vue 的 fav-card 视觉，但用 CSS Grid 布局（避开 el-row gutter 行间距问题）
 * - 加状态筛选、加入购物车快捷入口、清空收藏
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import PriceTag from '@/components/common/PriceTag.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { fetchFavorites, removeFavorite } from '@/api/user'
import { useUserStore } from '@/stores/modules/user'
import { useCartStore } from '@/stores/modules/cart'
import { formatRelative } from '@/utils/format'
import { settlePrice } from '@/utils/promo'
import { resolveStock } from '@/utils/goods'
import type { Favorite, Goods } from '@/types'

const router = useRouter()
const userStore = useUserStore()
const cartStore = useCartStore()

const favorites = ref<Favorite[]>([])
const loading = ref(false)
const totalCount = ref(0)
const statusFilter = ref<'' | 'on_sale' | 'sold'>('')

const isLoggedIn = computed(() => userStore.isLoggedIn)

onMounted(() => {
  if (isLoggedIn.value) reload()
})

watch(isLoggedIn, (v) => {
  if (v) reload()
})

async function reload() {
  if (!isLoggedIn.value) {
    favorites.value = []
    totalCount.value = 0
    return
  }
  loading.value = true
  try {
    const r = await fetchFavorites({ pageSize: 60 })
    const list = statusFilter.value
      ? r.list.filter((f) => f.goods.status === statusFilter.value)
      : r.list
    favorites.value = list
    totalCount.value = list.length
  } finally {
    loading.value = false
  }
}

function goDetail(id: number) {
  router.push(`/goods/${id}`)
}

/**
 * 商品状态 → 角标文案。
 * 只处理「需要提醒用户」的状态：在售不画角标，避免每张卡都挂个多余的标签。
 */
const STATUS_META: Partial<Record<Goods['status'], { label: string }>> = {
  sold: { label: '已售出' },
  pending: { label: '审核中' },
  off_shelf: { label: '已下架' }
}
function statusMeta(status: Goods['status']) {
  return STATUS_META[status] ?? null
}

/** 加入购物车被禁用时，把原因写出来（禁用按钮不解释原因＝用户只能瞎猜） */
function cartDisabledReason(status: Goods['status']): string | undefined {
  if (status === 'on_sale') return undefined
  return STATUS_META[status]?.label ? `${STATUS_META[status]!.label}，暂不可购买` : '当前不可购买'
}

async function onUnfav(f: Favorite) {
  await removeFavorite(f.goodsId)
  ElMessage.success('已取消收藏')
  await reload()
}

async function onClearAll() {
  try {
    await ElMessageBox.confirm(
      `确认清空全部 ${totalCount.value} 件收藏？此操作不可恢复`,
      '清空收藏',
      { type: 'warning' }
    )
  } catch {
    return
  }
  // 串行删除（mock 后端无批量接口）
  for (const f of favorites.value.slice()) {
    await removeFavorite(f.goodsId)
  }
  ElMessage.success('已清空收藏')
  await reload()
}

function onCartFromFav(f: Favorite) {
  if (f.goods.status !== 'on_sale') {
    ElMessage.warning(cartDisabledReason(f.goods.status) ?? '当前不可购买')
    return
  }
  /*
   * 收藏快照里的 price 是挂牌价，让利价随活动走，加车时按快照重算一次即可。
   * 这里不传 fundSource：加车只需要「挂牌价 + 实付价」，
   * 而实付价与谁掏钱无关（fundSource 只影响卖家让利/平台补贴的拆分，
   * 拆分由订单结算负责）。收藏快照里也没有 categoryId，无从解析。
   */
  const b = settlePrice(f.goods)
  cartStore.add({
    goodsId: f.goods.id,
    title: f.goods.title,
    listPrice: b.listPrice,
    promoPrice: b.onPromo ? b.payAmount : undefined,
    price: b.payAmount,
    cover: f.goods.cover,
    // 带上库存快照：购物车的数量上限要按真实可售数量来，不能一律按 1 件封顶
    stock: resolveStock(f.goods),
    quantity: 1,
    addedAt: Date.now()
  })
  ElMessage.success(b.onPromo ? `已加入购物车，省 ¥${(b.listPrice - b.payAmount).toFixed(2)}` : '已加入购物车')
}
</script>

<style scoped lang="scss">
@use '@/styles/variables.scss' as *;

.fav-page {
  max-width: 1200px;
  margin: 0 auto;
}

/* ============================================================
   顶部 Hero：蓝紫渐变 + 大字号，呼应参考图「我的资产」类视觉
   ============================================================ */
.fav-hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: $sp-6 $sp-8;
  border-radius: $radius-md;
  background:
    radial-gradient(ellipse at top right, rgba(255, 255, 255, 0.18), transparent 55%),
    linear-gradient(135deg, #1e3a8a 0%, $color-primary 55%, #7c3aed 100%);
  color: #fff;
  box-shadow: $shadow-sm;

  .hero-text { display: flex; flex-direction: column; gap: 6px; }
  .hero-title {
    margin: 0;
    font-size: $fs-22;
    font-weight: $fw-bold;
    display: flex; align-items: center; gap: 8px;
  }
  .hero-icon { color: #ffd6a0; }
  .hero-sub { margin: 0; font-size: $fs-13; opacity: 0.85; }

  .hero-stat {
    display: flex; flex-direction: column; align-items: flex-end; gap: 2px;
    .stat-num {
      font-size: 36px;
      font-weight: $fw-bold;
      font-variant-numeric: tabular-nums;
      line-height: 1;
    }
    .stat-label { font-size: $fs-13; opacity: 0.85; }
  }
}

/* ============================================================
   工具条
   ============================================================ */
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: $sp-5;
  flex-wrap: wrap;
  gap: $sp-3;

  .filter-row {
    display: flex; align-items: center; gap: $sp-3;
    .hint { color: var(--color-text-mute); font-size: $fs-13; }
  }
  .action-row { display: flex; gap: $sp-2; }
}

/* ============================================================
   网格 · 4 列 → 2 列 → 1 列 响应式
   ============================================================ */
.grid-wrap {
  margin-top: $sp-4;
  min-height: 360px;
}

.fav-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: $sp-4;

  @media (max-width: $breakpoint-lg) {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  @media (max-width: $breakpoint-md) {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  @media (max-width: $breakpoint-sm) {
    grid-template-columns: minmax(0, 1fr);
  }
}

/* ============================================================
   收藏卡 · 12px 圆角 / 白底 / 描边 / 悬停上浮
   ============================================================ */
.fav-card {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: $radius-md;
  overflow: hidden;
  transition:
    transform $dur-base $ease-out,
    border-color $dur-base $ease-out,
    box-shadow $dur-base $ease-out;

  &:hover {
    transform: translateY(-2px);
    border-color: rgba(255, 106, 0, 0.3);
    box-shadow: $shadow-sm;
  }

  /* 非在售：整体压暗提示不可交易，但不禁用「查看详情」 */
  &.is-unavailable {
    .fav-cover img { filter: saturate(0.75) brightness(0.96); }
  }
}

/* 封面：4:3，悬停放大 */
.fav-cover {
  position: relative;
  aspect-ratio: 4 / 3;
  background: var(--bg-soft);
  overflow: hidden;
  cursor: pointer;

  img {
    width: 100%; height: 100%;
    object-fit: cover; display: block;
    transition: transform $dur-slow $ease-out;
  }
  &:hover img { transform: scale(1.04); }

  .cover-flag {
    position: absolute;
    top: 10px; left: 10px;
    padding: 4px 10px;
    border-radius: $radius-xs;
    background: rgba(31, 35, 41, 0.72);
    color: #fff;
    font-size: $fs-12;
    font-weight: $fw-medium;
    backdrop-filter: blur(4px);

    /* 审核中＝平台还没放行，用品牌橙区别于「已售出 / 已下架」的灰 */
    &.is-pending { background: rgba(255, 106, 0, 0.92); }
  }

  .cover-unfav {
    position: absolute;
    top: 8px; right: 8px;
    width: 26px; height: 26px;
    border-radius: $radius-pill;
    border: none;
    background: rgba(31, 35, 41, 0.6);
    color: #fff;
    display: grid; place-items: center;
    cursor: pointer;
    opacity: 0;
    transition: opacity $dur-base $ease-out, background-color $dur-base $ease-out;

    .x-mark {
      font-size: 18px;
      line-height: 1;
      font-weight: $fw-medium;
    }
  }
  &:hover .cover-unfav { opacity: 1; }
  .cover-unfav:hover { background: $brand-orange; }
}

/* 主体信息 */
.fav-body {
  padding: $sp-3 $sp-4 $sp-4;
}

.fav-title {
  margin: 0 0 $sp-2;
  font-size: $fs-13;
  font-weight: $fw-semibold;
  color: var(--color-text-primary);
  line-height: 1.45;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  cursor: pointer;
  min-height: 38px;
  &:hover { color: $color-primary; }
}

.fav-price {
  margin-bottom: $sp-2;
}

.fav-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: $fs-12;
  color: var(--color-text-mute);
  margin-bottom: $sp-3;
  gap: $sp-2;

  .meta-loc {
    display: inline-flex; align-items: center; gap: 3px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    .el-icon { font-size: 13px; }
  }
  .meta-seller {
    color: $color-primary;
    font-weight: $fw-medium;
    flex-shrink: 0;
  }
}

.fav-foot {
  display: flex;
  flex-direction: column;
  gap: $sp-2;
  padding-top: $sp-2;
  border-top: 1px dashed var(--border-color);

  .meta-time { color: $text-4; font-size: $fs-11; }

  .foot-actions {
    display: flex;
    gap: $sp-2;
    .el-button { flex: 1; }
  }
}
</style>
