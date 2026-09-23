<template>
  <div class="promo-wrap">
    <!-- 只渲染 active / pending 的活动；全部下架或到期时整个 Banner 消失 -->
    <section
      v-if="displays.length"
      class="promo"
      :class="[`theme-${current.config.theme}`, { 'is-pending': current.state === 'pending' }]"
      @mouseenter="paused = true"
      @mouseleave="paused = false"
      @focusin="paused = true"
      @focusout="paused = false"
    >
      <div class="promo-main">
        <span
          class="promo-mark"
          aria-hidden="true"
        >{{ current.config.icon }}</span>
        <div class="promo-text">
          <h2 class="promo-title">
            {{ current.config.title }}
          </h2>
          <p class="promo-sub">
            {{ current.config.subtitle }}
          </p>
          <div class="promo-meta">
            <!--
              让利归属徽标由活动数据算出，而不是手写在文案里：
              文案说「卖家让利」时，数据必须也确实是 seller，两者不一致就会被 promo.spec.ts 拦下。
            -->
            <span
              class="promo-fund"
              :class="`is-${fundSource}`"
              :title="FUND_SOURCE_HINT[fundSource]"
            >
              {{ FUND_SOURCE_LABEL[fundSource] }}
            </span>
            <ul
              class="promo-chips"
              aria-label="活动亮点"
            >
              <li
                v-for="h in current.config.highlights"
                :key="h"
              >
                {{ h }}
              </li>
            </ul>
            <!-- 轮播指示器：只有 ≥2 个有效活动时才出现，单活动时保持原来的干净 Banner -->
            <div
              v-if="displays.length > 1"
              class="promo-dots"
              role="tablist"
              aria-label="切换活动"
            >
              <button
                v-for="(d, i) in displays"
                :key="d.config.id"
                type="button"
                class="dot"
                :class="{ 'is-active': i === idx }"
                role="tab"
                :aria-selected="i === idx"
                :aria-label="d.config.title"
                @click="go(i)"
              />
            </div>
          </div>
        </div>
      </div>

      <div class="promo-actions">
        <div class="promo-countdown">
          <span class="cd-label">{{ current.state === 'pending' ? '距开始' : '限时剩余' }}</span>
          <b class="cd-time">{{ cdText }}</b>
        </div>
        <router-link
          :to="current.config.ctaLink"
          class="promo-cta"
        >
          {{ current.config.ctaText }}
          <span
            class="arrow"
            aria-hidden="true"
          >→</span>
        </router-link>
      </div>
    </section>

    <!-- 活动全部结束后：低存在感占位，避免顶部塌陷造成布局跳动 -->
    <section
      v-else
      class="promo-empty"
      aria-label="当前无活动"
    >
      <span
        class="dot"
        aria-hidden="true"
      />
      <span>当前无活动 · 管理员可在「管理后台 → 活动管理」中上架限时活动</span>
    </section>

    <!-- 平台数据：拆出 Banner 独立一行，三个等宽格子，窄屏也不会被压叠 -->
    <ul
      class="stat-bar"
      aria-label="平台数据"
    >
      <li>
        <b>{{ summary.goodsTotal }}</b>
        <span>在售商品</span>
      </li>
      <li>
        <b>{{ summary.userTotal }}</b>
        <span>活跃用户</span>
      </li>
      <li>
        <b>{{ summary.orderTotal }}</b>
        <span>累计订单</span>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { fetchActiveActivities, formatCountdown, EMPTY_ACTIVITY_DISPLAY } from '@/api/activity'
import type { ActivityDisplay } from '@/api/activity'
import { FUND_SOURCE_LABEL, FUND_SOURCE_HINT } from '@/utils/promo'

defineProps<{
  summary: { goodsTotal: number; userTotal: number; orderTotal: number; recentOrders: number }
}>()

/** 轮播间隔：6s 足够读完一条卖点，又不会让人等得发慌 */
const ROTATE_MS = 6000

const displays = ref<ActivityDisplay[]>([])
const idx = ref(0)
const cdText = ref('00天 00:00:00')
/** 鼠标悬停 / 键盘聚焦时暂停自动轮播（WCAG 2.2.2：自动变化的内容必须可暂停） */
const paused = ref(false)
let timer: ReturnType<typeof setInterval> | null = null
let lastRotate = Date.now()

const current = computed<ActivityDisplay>(() => displays.value[idx.value] ?? EMPTY_ACTIVITY_DISPLAY)

/** 让利归属：老活动数据没有该字段时按「卖家让利」呈现，不替平台揽功 */
const fundSource = computed(() => current.value.config.fundSource ?? 'seller')

async function load() {
  const list = await fetchActiveActivities()
  displays.value = list
  if (idx.value >= list.length) idx.value = 0
  tick()
}

function tick() {
  const cur = displays.value[idx.value]
  cdText.value = formatCountdown(cur ? Math.max(0, cur.expiresAt - Date.now()) : 0)
  // 多活动时才轮播；单活动保持静态
  if (displays.value.length > 1 && !paused.value && Date.now() - lastRotate >= ROTATE_MS) {
    lastRotate = Date.now()
    idx.value = (idx.value + 1) % displays.value.length
  }
}

function go(i: number) {
  idx.value = i
  lastRotate = Date.now()
}

onMounted(() => {
  load()
  // 每秒刷新倒计时；每 30s 再做一次远端轮询以应对管理员后台下架 / 上架
  timer = setInterval(() => {
    tick()
    if (Date.now() % 30_000 < 1100) load()
  }, 1000)
})

onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})
</script>

<style scoped lang="scss">
@use '@/styles/variables.scss' as *;

.promo-wrap {
  display: flex;
  flex-direction: column;
  gap: $sp-3;
}

/* ============================================================
   限时活动 Banner
   ① 两列：左=活动信息（可伸缩），右=倒计时 + CTA（固定宽度，不参与压缩）
   ② 浅色渐变底 + 深色文字：保留促销热度，正文对比度 >7:1
   ③ 配色走主题变量（--promo-*），同一套结构支持四套色系，
      避免"每个活动换一套样式"导致维护失控
   ============================================================ */
.promo {
  --promo-c1: #fff7ec;
  --promo-c2: #ffe9cf;
  --promo-c3: #ffdcb8;
  --promo-line: #{$brand-orange-line};
  --promo-accent: #{$brand-orange};
  --promo-accent-2: #ff8c1a;
  --promo-ink: #9a5b12;
  --promo-glow: #{rgba(255, 106, 0, 0.45)};

  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: $sp-6;
  padding: 20px $sp-6;
  border-radius: $radius-lg;
  background:
    radial-gradient(120% 180% at 0% 50%, rgba(255, 255, 255, 0.85) 0%, rgba(255, 255, 255, 0) 55%),
    linear-gradient(100deg, var(--promo-c1) 0%, var(--promo-c2) 52%, var(--promo-c3) 100%);
  border: 1px solid var(--promo-line);
  box-shadow: $shadow-sm;
  transition: background $dur-base $ease-out, border-color $dur-base $ease-out;

  /* 深色模式：整条转暗琥珀底。标题色跟 --color-text-primary（此时为浅色），
     若不翻转底色就会出现「浅底浅字」不可读（第廿轮实测）。 */
  html.dark & {
    --promo-c1: #241c10;
    --promo-c2: #2b2114;
    --promo-c3: #332718;
    --promo-line: #4a3a20;
    --promo-ink: #f2c08a;
    background:
      radial-gradient(120% 180% at 0% 50%, rgba(255, 255, 255, 0.06) 0%, rgba(255, 255, 255, 0) 55%),
      linear-gradient(100deg, var(--promo-c1) 0%, var(--promo-c2) 52%, var(--promo-c3) 100%);
    box-shadow: none;
  }
}

/* —— 四套主题：只换色，不动结构 —— */
.promo.theme-blue {
  --promo-c1: #eef4ff;
  --promo-c2: #dce7ff;
  --promo-c3: #c9d9fb;
  --promo-line: #c9d9fb;
  --promo-accent: #{$color-primary};
  --promo-accent-2: #3b82f6;
  --promo-ink: #1e40af;
  --promo-glow: #{rgba(37, 99, 235, 0.4)};

  html.dark & {
    --promo-c1: #141b2b;
    --promo-c2: #172033;
    --promo-c3: #1c2742;
    --promo-line: #2c3a5e;
    --promo-ink: #a9c3f5;
  }
}
.promo.theme-green {
  --promo-c1: #eefdf5;
  --promo-c2: #d6f8e7;
  --promo-c3: #b3edd3;
  --promo-line: #b3edd3;
  --promo-accent: #10b981;
  --promo-accent-2: #34d399;
  --promo-ink: #065f46;
  --promo-glow: #{rgba(16, 185, 129, 0.4)};

  html.dark & {
    --promo-c1: #0f211a;
    --promo-c2: #12291f;
    --promo-c3: #163126;
    --promo-line: #245040;
    --promo-ink: #93e3c0;
  }
}
.promo.theme-purple {
  --promo-c1: #f6f4ff;
  --promo-c2: #ece7ff;
  --promo-c3: #ddd5fb;
  --promo-line: #ddd5fb;
  --promo-accent: #7c3aed;
  --promo-accent-2: #a78bfa;
  --promo-ink: #5b21b6;
  --promo-glow: #{rgba(124, 58, 237, 0.4)};

  html.dark & {
    --promo-c1: #1b1730;
    --promo-c2: #201a38;
    --promo-c3: #261f42;
    --promo-line: #3d3364;
    --promo-ink: #c9b8f7;
  }
}

.promo-main {
  display: flex;
  align-items: flex-start;
  gap: $sp-4;
  min-width: 0;
  flex: 1 1 auto;
}

.promo-mark {
  width: 48px;
  height: 48px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  font-size: 24px;
  border-radius: $radius-pill;
  background: var(--bg-card);
  box-shadow: 0 2px 10px -2px var(--promo-glow);
}

.promo-text {
  min-width: 0;
}

.promo-title {
  font-size: $fs-17;
  font-weight: $fw-bold;
  color: var(--color-text-primary);
  letter-spacing: -0.01em;
  line-height: 1.4;
}

.promo-sub {
  margin-top: 5px;
  font-size: $fs-13;
  color: var(--promo-ink);
  line-height: 1.5;
}

/* 卖点 chips 与轮播指示器同排，窄屏一起折行 */
.promo-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 14px;
  margin-top: 10px;
}

/* 让利归属徽标：实心小标签，比 chips 更强调「这行字是数据算出来的」 */
.promo-fund {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  border-radius: $radius-pill;
  font-size: $fs-11;
  font-weight: $fw-semibold;
  line-height: 1;
  white-space: nowrap;
  color: #fff;
  background: var(--promo-accent);

  /* 平台补贴用蓝色区分：这笔钱不是卖家出的，视觉上也别混为一谈 */
  &.is-platform {
    background: var(--color-primary);
  }
}

.promo-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0;
  list-style: none;

  li {
    font-size: $fs-12;
    line-height: 1;
    color: var(--promo-ink);
    background: rgba(255, 255, 255, 0.72);
    border: 1px solid var(--promo-line);
    padding: 4px 10px;
    border-radius: $radius-pill;
    white-space: nowrap;

    /* 深色下半透白底会压过浅琥珀字：换低透明白 + 保持暗底可读 */
    html.dark & {
      background: rgba(255, 255, 255, 0.08);
    }
  }
}

/* —— 轮播指示器 —— */
.promo-dots {
  display: inline-flex;
  align-items: center;
  gap: 6px;

  .dot {
    width: 8px;
    height: 8px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: rgba(31, 35, 41, 0.18);
    cursor: pointer;
    transition:
      width $dur-base $ease-out,
      background $dur-base $ease-out;

    &:hover { background: rgba(31, 35, 41, 0.34); }
    &:focus-visible {
      outline: 2px solid var(--promo-accent);
      outline-offset: 2px;
    }
    /* 激活态拉长成胶囊，比单纯变色更容易一眼分辨 */
    &.is-active {
      width: 20px;
      border-radius: $radius-pill;
      background: var(--promo-accent);
    }
  }
}

/* 右侧操作区：定宽不压缩，倒计时数字不换行 */
.promo-actions {
  display: flex;
  align-items: center;
  gap: $sp-5;
  flex: 0 0 auto;
}

.promo-countdown {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  white-space: nowrap;

  .cd-label {
    font-size: $fs-11;
    color: var(--promo-ink);
    letter-spacing: 0.05em;
  }
  .cd-time {
    font-size: $fs-17;
    font-weight: $fw-bold;
    color: var(--color-text-primary);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.01em;
    line-height: 1.2;
  }
}

.promo-cta {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 44px;
  padding: 0 22px;
  border-radius: $radius-pill;
  background: linear-gradient(135deg, var(--promo-accent) 0%, var(--promo-accent-2) 100%);
  color: #fff;
  font-size: $fs-14;
  font-weight: $fw-semibold;
  text-decoration: none;
  white-space: nowrap;
  box-shadow: 0 6px 20px -4px var(--promo-glow);
  transition:
    transform $dur-base $ease-out,
    box-shadow $dur-base $ease-out;

  .arrow {
    display: inline-block;
    transition: transform $dur-base $ease-out;
  }

  &:hover,
  &:focus-visible {
    transform: translateY(-1px);
    box-shadow: 0 10px 24px -4px var(--promo-glow);
    color: #fff;

    .arrow { transform: translateX(3px); }
  }
  &:active {
    transform: translateY(0);
    box-shadow: 0 2px 10px -2px var(--promo-glow);
  }
}

/* 无活动占位条 */
.promo-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 14px $sp-5;
  background: var(--bg-soft);
  border: 1px dashed var(--border-color-strong);
  border-radius: $radius-md;
  color: var(--color-text-mute);
  font-size: $fs-13;
  text-align: center;

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--border-color-strong);
    flex-shrink: 0;
  }
}

/* 平台数据条：三格等宽，数字与标签同行 baseline 对齐 */
.stat-bar {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1px;
  margin: 0;
  padding: 0;
  list-style: none;
  background: var(--border-color);
  border: 1px solid var(--border-color);
  border-radius: $radius-md;
  overflow: hidden;

  li {
    background: var(--bg-card);
    padding: 12px $sp-4;
    display: flex;
    align-items: baseline;
    justify-content: center;
    gap: 8px;
  }
  b {
    font-size: $fs-18;
    font-weight: $fw-bold;
    color: var(--color-text-primary);
    line-height: 1.2;
    font-variant-numeric: tabular-nums;
  }
  span {
    font-size: $fs-12;
    color: var(--color-text-mute);
    white-space: nowrap;
  }
}

/* 待开始状态：倒计时用中性灰 */
.is-pending .cd-time { color: var(--color-text-secondary); }

/* ============================================================
   响应式
   ============================================================ */
@media (max-width: $breakpoint-lg) {
  .promo {
    flex-direction: column;
    align-items: stretch;
    gap: $sp-4;
  }
  .promo-actions {
    justify-content: space-between;
  }
  .promo-countdown {
    align-items: flex-start;
  }
}

@media (max-width: $breakpoint-sm) {
  .promo { padding: $sp-4; }
  .promo-title { font-size: $fs-16; }
  .promo-mark { width: 40px; height: 40px; font-size: 20px; }
  .promo-actions {
    flex-direction: column;
    align-items: stretch;
    gap: $sp-3;
  }
  .promo-countdown {
    align-items: center;
    .cd-time { font-size: $fs-16; }
  }
  .promo-cta { width: 100%; }
  .stat-bar {
    grid-template-columns: minmax(0, 1fr);
    li { justify-content: space-between; padding: 10px $sp-4; }
  }
}

@media (prefers-reduced-motion: reduce) {
  .promo-cta,
  .promo-cta .arrow,
  .promo-dots .dot { transition: none !important; }
  .promo-cta:hover,
  .promo-cta:focus-visible { transform: none; }
  .promo-cta:hover .arrow { transform: none; }
}
</style>
