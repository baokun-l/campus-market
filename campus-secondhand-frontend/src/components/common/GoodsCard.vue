<template>
  <router-link
    :to="`/goods/${goods.id}`"
    class="goods-link"
    :aria-label="`${goods.title}，售价 ${formatPrice(goods.price)}`"
  >
    <article class="goods-card">
      <div class="cover-wrap">
        <img
          v-if="coverSrc"
          :src="coverSrc"
          :alt="goods.title"
          class="cover"
          loading="lazy"
          decoding="async"
          @error="onCoverError"
        >

        <!-- 状态角标 -->
        <span
          v-if="goods.status === 'sold'"
          class="status-badge is-sold"
        >已售出</span>
        <span
          v-else-if="goods.status === 'pending'"
          class="status-badge is-pending"
        >审核中</span>

        <!-- 分类角标：帮助快速识别，且与封面色板同族 -->
        <span
          v-if="goods.categoryName"
          class="cat-badge"
        >{{ goods.categoryName }}</span>
      </div>

      <div class="info">
        <h4
          class="title"
          :title="goods.title"
        >
          {{ goods.title }}
        </h4>

        <PriceTag
          :list-price="goods.price"
          :promo-price="goods.promoPrice"
          :zero-text="'面议'"
        />

        <div class="meta">
          <!--
            卖家在线标识：绿点=在线 / 灰点=离线。
            ★ 这也是「设置 → 显示在线状态」在首页的可见效果 ★
            数据来自服务端在线名单（5 分钟内有心跳、且本人没关隐私开关才算在线），
            所以关掉开关的人在这里会立刻由绿变灰 ——
            此前这个开关在首页切来切去毫无变化，因为它只挂了消息页和商品详情页两处。
          -->
          <span
            class="online"
            :class="sellerOnline ? 'is-online' : 'is-offline'"
            :title="sellerOnline ? '卖家在线' : '卖家离线'"
          >
            <span class="dot" />{{ sellerOnline ? '在线' : '离线' }}
          </span>
          <span class="loc">
            <el-icon><Location /></el-icon>
            <span class="ellipsis">{{ goods.location }}</span>
          </span>
          <span class="view">
            <el-icon><View /></el-icon>{{ goods.viewCount }}
          </span>
        </div>
      </div>
    </article>
  </router-link>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import PriceTag from './PriceTag.vue'
import { formatPrice } from '@/utils/format'
import { makeCover } from '@/api/mock'
import { useOnlineStore } from '@/stores/modules/online'
import type { Goods } from '@/types'

const props = defineProps<{ goods: Goods }>()

const onlineStore = useOnlineStore()

/** 卖家是否在线：读服务端在线名单（口径见 stores/modules/online.ts），不再本地散列编造 */
const sellerOnline = computed(() => onlineStore.isOnline(props.goods.sellerId))

/*
 * 每张卡片只声明「我需要这个卖家 id」的在线状态，合并成一次请求这件事
 * 由 store 在微任务里完成（见 online.ts 的 pendingIds）。
 *
 * ★ 为什么不在列表页查一次再往下传 ★
 * 那样卡片就不再是自包含的组件：换任何列表（首页精选 / 商品广场 / 收藏夹）
 * 都得记得补一次批量查询，漏一个地方在线标识就永远不亮。
 * 把合并做进 store 之后，卡片只管声明需求，请求次数与列表长度无关。
 */
function syncOnline() {
  onlineStore.ensure([props.goods.sellerId])
}

onMounted(syncOnline)
// 复用的卡片（如列表分页复用 DOM）换了商品时要重新查
watch(() => props.goods.sellerId, syncOnline)

/* 封面加载失败兜底：实拍图 404 时回退到分类渐变占位图，绝不裂图 */
const coverSrc = ref(props.goods.cover)
let coverTriedFallback = false
function onCoverError() {
  if (coverTriedFallback) {
    coverSrc.value = ''
    return
  }
  coverTriedFallback = true
  coverSrc.value = makeCover(props.goods.categoryId, props.goods.id)
}
</script>

<style scoped lang="scss">
@use '@/styles/variables.scss' as *;

.goods-link {
  display: block;
  height: 100%;
  border-radius: $radius-md;
  color: inherit;
  text-decoration: none;
}

/* ============================================================
   卡片
   悬停（参考主流电商）：上浮 4px + 品牌色描边 + 阴影升档
   封面：微放大 + 由下而上的暗部渐隐 + 一道斜向高光扫过
   时长 280ms / easeOutExpo；按下 120ms 快速回落
   ============================================================ */
.goods-card {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: $radius-md;
  overflow: hidden;
  box-shadow: $shadow-xs;
  transition:
    transform $dur-slow $ease-out,
    box-shadow $dur-slow $ease-out,
    border-color $dur-slow $ease-out;
  will-change: transform, box-shadow;
}

.goods-link:hover .goods-card,
.goods-link:focus-visible .goods-card {
  transform: translateY(-4px);
  border-color: rgba(255, 106, 0, 0.5);
  /* 升档阴影 + 一层贴边的品牌色晕，保留克制不铺开大面积发光 */
  box-shadow:
    $shadow-lg,
    0 0 0 1px rgba(255, 106, 0, 0.12),
    0 8px 20px -14px rgba(255, 106, 0, 0.55);
}
.goods-link:active .goods-card {
  transform: translateY(-1px);
  transition-duration: $dur-fast;
}

/* ---------------------------- 封面 ---------------------------- */
.cover-wrap {
  position: relative;
  aspect-ratio: 4 / 3;
  overflow: hidden;
  background: var(--bg-soft);
  flex-shrink: 0;
}

/* 由下而上的暗部渐隐：悬停时淡入，压住封面底部提升角标/文字的对比度 */
.cover-wrap::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: none;
  background: linear-gradient(
    to top,
    rgba(31, 35, 41, 0.42) 0%,
    rgba(31, 35, 41, 0.14) 38%,
    rgba(31, 35, 41, 0) 62%
  );
  opacity: 0;
  transition: opacity $dur-slow $ease-out;
}

/* 斜向高光扫过：只做一次单向扫动，离开时瞬间复位（不产生反向扫回的怪动作） */
.cover-wrap::after {
  content: '';
  position: absolute;
  top: -20%;
  bottom: -20%;
  left: 0;
  z-index: 2;
  width: 42%;
  pointer-events: none;
  background: linear-gradient(
    100deg,
    rgba(255, 255, 255, 0) 0%,
    rgba(255, 255, 255, 0.18) 32%,
    rgba(255, 255, 255, 0.62) 50%,
    rgba(255, 255, 255, 0.18) 68%,
    rgba(255, 255, 255, 0) 100%
  );
  transform: translateX(-140%) skewX(-18deg);
  opacity: 0;
  transition: none;
}

.cover {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  transition:
    transform $dur-slow $ease-out,
    filter $dur-slow $ease-out;
}
.goods-link:hover .cover,
.goods-link:focus-visible .cover {
  transform: scale(1.06);
  filter: saturate(1.06) brightness(1.03);
}

/* 悬停：渐隐淡入 + 高光从左扫到右（900ms，缓入缓出） */
.goods-link:hover .cover-wrap::before,
.goods-link:focus-visible .cover-wrap::before {
  opacity: 1;
}
.goods-link:hover .cover-wrap::after,
.goods-link:focus-visible .cover-wrap::after {
  opacity: 1;
  transform: translateX(320%) skewX(-18deg);
  transition: transform 900ms $ease-standard;
}

.status-badge,
.cat-badge {
  position: absolute;
  top: 8px;
  z-index: 3; /* 必须高于封面的渐隐层(1)与扫光层(2)，否则角标被压暗 */
  font-size: $fs-11;
  line-height: 1;
  padding: 5px 8px;
  border-radius: $radius-xs;
  font-weight: $fw-medium;
  backdrop-filter: blur(4px);
}

.status-badge {
  right: 8px;
  &.is-sold {
    background: rgba(31, 35, 41, 0.72);
    color: #fff;
  }
  &.is-pending {
    background: rgba(255, 106, 0, 0.9);
    color: #fff;
  }
}

.cat-badge {
  left: 8px;
  background: rgba(255, 255, 255, 0.85);
  color: var(--color-text-secondary);
}

/* ---------------------------- 信息区 ---------------------------- */
.info {
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  padding: 10px 12px 12px;
  gap: 6px;
}

.title {
  font-size: $fs-13;
  font-weight: $fw-medium;
  color: var(--color-text-primary);
  line-height: 1.45;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: color $dur-base $ease-out;
}
.goods-link:hover .title,
.goods-link:focus-visible .title {
  color: $brand-orange;
}

/* 价格行钉在卡片底部，保证网格中多张卡片对齐 */
.info :deep(.price-wrap) {
  margin-top: auto;
}

.meta {
  display: flex;
  align-items: center;
  /*
   * 一行现在有三个元素：在线标识 / 位置 / 浏览量。
   * 不能再用 space-between —— 那会把「位置」顶到正中间，
   * 与它前面的在线标识之间裂开一大条空白。改成左对齐 + 给浏览量 auto 左外边距。
   */
  gap: $sp-2;
  color: var(--color-text-mute);
  font-size: $fs-12;
  padding-top: 8px;
  border-top: 1px solid var(--border-color);

  /*
   * 在线标识：绿点=在线 / 灰点=离线。
   * 离线也保留（而不是整块隐藏）—— 这样「关掉隐私开关」的效果是一次肉眼可见的变色，
   * 而不是元素凭空消失（后者容易被当成页面没加载完）。
   */
  .online {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex-shrink: 0;
    font-size: $fs-11;

    .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor; /* 点随文字色，一处定义两种状态 */
      flex-shrink: 0;
    }
    &.is-online {
      color: $color-success;
    }
    &.is-offline {
      color: var(--color-text-disabled);
    }
  }

  .loc,
  .view {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    min-width: 0;
  }
  .loc .ellipsis {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .el-icon {
    font-size: 12px;
    flex-shrink: 0;
  }
  .view {
    flex-shrink: 0;
    margin-left: auto; /* 浏览量钉在右端 */
    font-variant-numeric: tabular-nums;
  }
}

/* ---------------------------- 无障碍 ---------------------------- */
@media (prefers-reduced-motion: reduce) {
  .goods-card,
  .cover,
  .title,
  .cover-wrap::before,
  .cover-wrap::after {
    transition: none !important;
  }
  .goods-link:hover .goods-card,
  .goods-link:focus-visible .goods-card,
  .goods-link:hover .cover,
  .goods-link:focus-visible .cover {
    transform: none !important;
  }
  /* 取消扫光，仅保留渐隐提示 */
  .goods-link:hover .cover-wrap::after,
  .goods-link:focus-visible .cover-wrap::after {
    opacity: 0 !important;
  }
}
</style>
