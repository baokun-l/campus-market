<template>
  <PageContainer
    back
    :title="profile ? profile.nickname : '用户主页'"
    subtitle="看看 TA 的信用与在售好物"
  >
    <div
      v-loading="loading"
      class="upp"
    >
      <template v-if="profile">
        <!-- ==================== 头部资料卡 ==================== -->
        <section class="up-head">
          <el-avatar
            :src="profile.avatar"
            :size="64"
            class="up-avatar"
          >
            {{ profile.nickname.slice(0, 1) }}
          </el-avatar>
          <div class="up-head-txt">
            <div class="up-name-row">
              <h2 class="up-name">
                {{ profile.nickname }}
              </h2>
              <el-tag
                v-if="profile.role === 'admin'"
                type="danger"
                size="small"
                effect="plain"
              >
                管理员
              </el-tag>
            </div>
            <p class="up-meta">
              <span>信用分 <b class="up-credit">{{ profile.creditScore }}</b></span>
              <span class="up-sep">·</span>
              <span>{{ formatDate(profile.createTime, 'YYYY-MM-DD') }} 加入</span>
            </p>
          </div>
          <!-- 信用分档位说明：一眼看懂这个分数是什么水平 -->
          <div class="up-credit-box">
            <span class="up-credit-label">信用等级</span>
            <el-tag
              :type="creditTag(profile.creditScore)"
              effect="light"
            >
              {{ creditText(profile.creditScore) }}
            </el-tag>
          </div>
        </section>

        <!-- ==================== TA 的在售 / 已售商品 ==================== -->
        <section class="up-block">
          <header class="up-block-head">
            <h3>
              TA 的商品
              <span class="up-count">{{ goodsTotal }}</span>
            </h3>
          </header>
          <div
            v-if="goodsList.length"
            class="up-grid"
          >
            <GoodsCard
              v-for="g in goodsList"
              :key="g.id"
              :goods="g"
            />
          </div>
          <div
            v-else
            class="up-empty"
          >
            TA 还没有发布过商品
          </div>
        </section>

        <!-- ==================== TA 收到的评价 ==================== -->
        <section class="up-block">
          <header class="up-block-head">
            <h3>
              TA 收到的评价
              <span class="up-count">{{ reviews.length }}</span>
            </h3>
            <div
              v-if="reviews.length"
              class="up-avg"
            >
              <el-rate
                :model-value="avgRating"
                disabled
                allow-half
                size="small"
              />
              <span class="up-avg-num">{{ avgRating.toFixed(1) }} 分</span>
            </div>
          </header>

          <ul
            v-if="reviews.length"
            class="up-reviews"
          >
            <li
              v-for="r in reviews"
              :key="r.id"
              class="up-review"
            >
              <el-avatar
                :src="r.fromUserAvatar"
                :size="34"
                class="up-rv-avatar"
              >
                {{ (r.fromUserName || '同').slice(0, 1) }}
              </el-avatar>
              <div class="up-rv-body">
                <div class="up-rv-head">
                  <!-- 评价人也可以点进主页（从主页链到主页，形成互相跳转的闭环） -->
                  <router-link
                    :to="`/user/${r.fromUserId}`"
                    class="up-rv-name"
                  >
                    {{ r.fromUserName }}
                  </router-link>
                  <el-rate
                    :model-value="r.rating"
                    disabled
                    size="small"
                    class="up-rv-rate"
                  />
                </div>
                <p class="up-rv-content">
                  {{ r.content }}
                </p>
                <!-- 追评挂在首评下方：同一次交易的补充说明，不拆成独立评价 -->
                <div
                  v-if="r.appendContent"
                  class="up-rv-append"
                >
                  <span class="up-rv-append-tag">追评</span>
                  <p class="up-rv-append-txt">
                    {{ r.appendContent }}
                  </p>
                </div>
                <div class="up-rv-foot">
                  <span class="up-rv-time">{{ formatDate(r.createTime, 'YYYY-MM-DD HH:mm') }}</span>
                  <router-link
                    :to="`/goods/${r.goodsId}`"
                    class="up-rv-goods"
                  >
                    来自商品「{{ goodsTitleOf(r.goodsId) }}」→
                  </router-link>
                </div>
              </div>
            </li>
          </ul>
          <div
            v-else
            class="up-empty"
          >
            TA 还没有收到评价，完成交易并互相评价后才会有
          </div>
        </section>
      </template>

      <EmptyState
        v-else-if="!loading"
        title="用户不存在"
        description="该用户可能已注销或被封禁"
        icon="👤"
      />
    </div>
  </PageContainer>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import PageContainer from '@/components/common/PageContainer.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import GoodsCard from '@/components/common/GoodsCard.vue'
import { fetchPublicProfile, type PublicProfile } from '@/api/user'
import { fetchGoods } from '@/api/goods'
import { fetchReviewsByUser } from '@/api/review'
import { formatDate } from '@/utils/format'
import type { Goods, Review } from '@/types'

const route = useRoute()
const loading = ref(false)
const profile = ref<PublicProfile | null>(null)
const goodsList = ref<Goods[]>([])
const goodsTotal = ref(0)
const reviews = ref<Review[]>([])
/** 商品 id → 标题，评价行里「来自商品」的文案用 */
const goodsTitles = ref<Map<number, string>>(new Map())

const avgRating = computed(() => {
  if (!reviews.value.length) return 0
  return reviews.value.reduce((s, r) => s + r.rating, 0) / reviews.value.length
})

function goodsTitleOf(id: number): string {
  return goodsTitles.value.get(id) ?? `#${id}`
}

function creditTag(score: number): 'success' | 'warning' | 'danger' {
  if (score >= 90) return 'success'
  if (score >= 60) return 'warning'
  return 'danger'
}
function creditText(score: number): string {
  if (score >= 90) return '信用极佳'
  if (score >= 60) return '信用良好'
  return '信用偏低'
}

async function load() {
  const id = Number(route.params.id)
  if (!Number.isFinite(id)) return
  loading.value = true
  try {
    profile.value = await fetchPublicProfile(id)
    if (!profile.value) return
    // 在售 + 已售都对买家有价值：在售可买，已售看成交行情（与商品广场口径一致）
    fetchGoods({ sellerId: id, statuses: ['on_sale', 'sold'], pageSize: 12, sort: 'new' })
      .then((r) => {
        goodsList.value = r.list
        goodsTotal.value = r.total
        goodsTitles.value = new Map(r.list.map((g) => [g.id, g.title]))
      })
      .catch(() => {})
    fetchReviewsByUser(id)
      .then((list) => (reviews.value = list))
      .catch(() => {})
  } catch {
    /*
     * 用户不存在（后端回 1002）或已注销：request 层已弹出提示，
     * 这里把 profile 留在 null，页面落到「用户不存在」空态即可。
     * 不接住的话 rejection 会悬空，页面行为与「查无此人」不一致。
     */
    profile.value = null
  } finally {
    loading.value = false
  }
}

/* 同一组件在不同用户 id 之间复用（主页 → 评价人主页），id 变了必须重载 */
watch(() => route.params.id, load)
onMounted(load)
</script>

<style scoped lang="scss">
@use '@/styles/variables.scss' as *;

.upp {
  min-height: 320px;
}

/* ---------- 头部资料卡 ---------- */
.up-head {
  display: flex;
  align-items: center;
  gap: $sp-4;
  padding: $sp-5;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: $radius-md;
  box-shadow: $shadow-xs;
}

.up-avatar {
  flex-shrink: 0;
  background: linear-gradient(135deg, #ffb066, $brand-orange);
  color: #fff;
  font-size: 24px;
  font-weight: $fw-semibold;
}

.up-head-txt {
  flex: 1;
  min-width: 0;
}

.up-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.up-name {
  margin: 0;
  font-size: $fs-20;
  font-weight: $fw-bold;
  color: var(--color-text-primary);
}

.up-meta {
  margin: 6px 0 0;
  font-size: $fs-13;
  color: var(--color-text-mute);
  display: flex;
  align-items: center;
  gap: 8px;
}

.up-credit {
  color: #047857;
  font-weight: $fw-bold;
  font-variant-numeric: tabular-nums;
}

.up-sep { color: var(--border-color-strong); }

.up-credit-box {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  flex-shrink: 0;

  .up-credit-label {
    font-size: $fs-12;
    color: var(--color-text-mute);
  }
}

/* ---------- 区块 ---------- */
.up-block {
  margin-top: $sp-4;
  padding: $sp-5;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: $radius-md;
  box-shadow: $shadow-xs;
}

.up-block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: $sp-4;

  h3 {
    margin: 0;
    font-size: $fs-16;
    font-weight: $fw-semibold;
    color: var(--color-text-primary);
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .up-count {
    font-size: $fs-13;
    color: var(--color-text-mute);
    font-weight: $fw-normal;
    &::before { content: '('; }
    &::after { content: ')'; }
  }

  .up-avg {
    display: flex;
    align-items: center;
    gap: 8px;
    .up-avg-num { font-size: $fs-13; color: $brand-orange; font-weight: $fw-semibold; }
  }
}

.up-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: $sp-3;
}

.up-empty {
  padding: $sp-6 0;
  text-align: center;
  color: var(--color-text-mute);
  font-size: $fs-13;
  background: var(--bg-soft);
  border-radius: $radius-sm;
}

/* ---------- 评价列表 ---------- */
.up-reviews {
  list-style: none;
  margin: 0;
  padding: 0;

  .up-review {
    display: flex;
    gap: $sp-3;
    padding: $sp-3 0;

    & + .up-review { border-top: 1px dashed var(--border-color); }
  }
}

.up-rv-avatar {
  flex-shrink: 0;
  background: linear-gradient(135deg, #93c5fd, $color-primary);
  color: #fff;
  font-size: 12px;
  font-weight: $fw-semibold;
}

.up-rv-body { flex: 1; min-width: 0; }

.up-rv-head {
  display: flex;
  align-items: center;
  gap: $sp-2;

  .up-rv-name {
    font-size: $fs-13;
    font-weight: $fw-medium;
    color: var(--color-text-primary);
    text-decoration: none;

    &:hover { color: $color-primary; text-decoration: underline; }
  }
}

.up-rv-content {
  margin: 4px 0;
  font-size: $fs-14;
  color: var(--color-text-secondary);
  line-height: 1.7;
  word-break: break-word;
}

/* 追评：橙底 + 左橙线，与首评拉开层次，但仍属于同一条评价 */
.up-rv-append {
  margin: 6px 0 4px;
  padding: 8px 10px;
  border-radius: $radius-sm;
  background: $brand-orange-soft;
  border-left: 3px solid $brand-orange;

  .up-rv-append-tag {
    display: inline-block;
    margin-bottom: 3px;
    font-size: $fs-11;
    font-weight: $fw-semibold;
    color: $brand-orange-deep;
  }
  .up-rv-append-txt {
    margin: 0;
    font-size: $fs-13;
    color: var(--color-text-secondary);
    line-height: 1.7;
    word-break: break-word;
  }
}

.up-rv-foot {
  display: flex;
  align-items: center;
  gap: $sp-3;
  flex-wrap: wrap;

  .up-rv-time { font-size: $fs-12; color: $text-4; }
  .up-rv-goods {
    font-size: $fs-12;
    color: $color-primary;
    text-decoration: none;
    &:hover { text-decoration: underline; }
  }
}

@media (max-width: $breakpoint-sm) {
  .up-head {
    flex-wrap: wrap;
  }
  .up-credit-box {
    align-items: flex-start;
  }
}
</style>
