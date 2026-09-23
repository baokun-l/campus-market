<template>
  <div
    class="price-wrap"
    :class="`is-${size}`"
  >
    <!-- 注意：formatPrice() 内部已含货币符号，模板里不要重复写 ¥（历史 bug） -->
    <span class="now">{{ formatted }}</span>
    <del
      v-if="showOriginal"
      class="origin"
    >{{ originalFmt }}</del>
    <span
      v-if="breakdown.discountLabel"
      class="discount"
    >{{ breakdown.discountLabel }}</span>
  </div>
</template>

<script setup lang="ts">
/**
 * 价格标签
 *
 * 语义（与旧版相反，这里是修正后的定义）：
 *   - `listPrice`  = **卖家挂牌价**（平台记录在案的真实价格）
 *   - `promoPrice` = 卖家让利后的**活动价**；未参与活动的商品不传
 *
 * 有让利价时：现价显示让利价、划线价显示挂牌价、并出现折扣标签；
 * 没有让利价时：只显示挂牌价，**不出现任何划线价与折扣** ——
 * 从数据层就杜绝了「虚构原价」。
 *
 * 折扣计算统一委托给 `settlePrice()`，组件内不再重复实现一份。
 */
import { computed } from 'vue'
import { formatPrice } from '@/utils/format'
import { settlePrice } from '@/utils/promo'

interface Props {
  /** 卖家挂牌价（真实价格） */
  listPrice: number | string
  /** 卖家让利后的活动价；未参与活动时不传 */
  promoPrice?: number
  decimal?: number
  /** 货币符号，默认 ¥ */
  symbol?: string
  /** 是否为 0 时显示自定义文案（如「面议」） */
  zeroText?: string
  /** 尺寸档位：列表卡片 sm / 默认 md / 详情页主价格 lg */
  size?: 'sm' | 'md' | 'lg'
}
const props = withDefaults(defineProps<Props>(), {
  decimal: 2,
  symbol: '¥',
  zeroText: '',
  size: 'md'
})

/** 唯一的价格真相来源：让利价 / 划线价 / 折扣标签全由它推导 */
const breakdown = computed(() =>
  settlePrice({ price: Number(props.listPrice), promoPrice: props.promoPrice })
)

const isZero = computed(() => breakdown.value.listPrice === 0)

const formatted = computed(() =>
  isZero.value && props.zeroText
    ? props.zeroText
    : formatPrice(breakdown.value.payAmount, { decimal: props.decimal, symbol: props.symbol })
)

const originalFmt = computed(() =>
  formatPrice(breakdown.value.listPrice, { decimal: 0, symbol: props.symbol })
)

/** 只有真实发生了让利才显示划线价 */
const showOriginal = computed(() => breakdown.value.onPromo && !isZero.value)
</script>

<style scoped lang="scss">
@use '@/styles/variables.scss' as *;

// 价格体系（对齐参考图 6.4）：
//   现价 = 品牌橙 + 粗体 + 等宽数字（不抖动）
//   原价 = 极浅灰 + 删除线，弱化但不能低到看不见（对比度 ≥ 3:1）
//   折扣 = 浅橙底 + 深橙字，圆角小标签
.price-wrap {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
}

.now {
  color: $brand-orange;
  font-weight: $fw-bold;
  line-height: 1.15;
  letter-spacing: -0.01em;
  font-variant-numeric: tabular-nums;
  font-feature-settings: 'tnum';
}

.origin {
  color: $text-4;
  text-decoration: line-through;
  text-decoration-thickness: 1px;
  font-variant-numeric: tabular-nums;
}

.discount {
  display: inline-flex;
  align-items: center;
  background: $brand-orange-soft;
  color: $brand-orange-deep;
  border: 1px solid $brand-orange-line;
  border-radius: $radius-xs;
  font-weight: $fw-semibold;
  line-height: 1;
  white-space: nowrap;
}

/* ---------------- 尺寸档位 ---------------- */
.is-sm {
  gap: 5px;
  .now { font-size: $fs-15; }
  .origin { font-size: $fs-11; }
  .discount { font-size: $fs-11; padding: 3px 5px; }
}

.is-md {
  .now { font-size: 17px; }
  .origin { font-size: $fs-12; }
  .discount { font-size: $fs-11; padding: 4px 6px; }
}

.is-lg {
  gap: 10px;
  .now { font-size: $fs-28; }
  .origin { font-size: $fs-14; }
  .discount {
    font-size: $fs-13;
    padding: 5px 9px;
    transform: translateY(-2px);
  }
}
</style>
