<template>
  <div class="notice-page">
    <BackButton />
    <!-- 顶部 Hero -->
    <section class="notice-hero">
      <div class="hero-text">
        <h1 class="hero-title">
          <el-icon
            :size="22"
            class="hero-icon"
          >
            <BellFilled />
          </el-icon>
          平台公告
        </h1>
        <p class="hero-sub">
          了解平台最新动态、活动规则与重要通知
        </p>
      </div>
      <div class="hero-stat">
        <span class="stat-num">{{ notices.length }}</span>
        <span class="stat-label">条公告</span>
      </div>
    </section>

    <!-- 公告列表 -->
    <section
      v-loading="loading"
      class="notice-list"
    >
      <article
        v-for="(n, idx) in notices"
        :key="n.id"
        class="notice-item"
        :class="{ 'is-pinned': n.pinned, 'is-open': expandedId === n.id }"
      >
        <header
          class="notice-head"
          @click="toggle(n.id)"
        >
          <div class="notice-rank">
            {{ idx + 1 }}
          </div>
          <div class="notice-meta">
            <div class="title-row">
              <el-tag
                v-if="n.pinned"
                type="danger"
                size="small"
                effect="dark"
                class="pin-tag"
              >
                <el-icon :size="11">
                  <BellFilled />
                </el-icon>
                <span>置顶</span>
              </el-tag>
              <h3 class="notice-title">
                {{ n.title }}
              </h3>
            </div>
            <div class="notice-sub">
              <span class="time">
                <el-icon><Clock /></el-icon>
                {{ formatDate(n.createTime, 'YYYY-MM-DD HH:mm') }}
              </span>
            </div>
          </div>
          <el-icon class="notice-toggle">
            <component :is="expandedId === n.id ? Fold : Expand" />
          </el-icon>
        </header>

        <transition name="reveal">
          <div
            v-if="expandedId === n.id"
            class="notice-body"
          >
            <div
              v-for="(line, i) in splitContent(n.content)"
              :key="i"
              class="content-line"
            >
              {{ line }}
            </div>
            <div class="notice-actions">
              <el-button
                text
                type="primary"
                size="small"
                @click="onCopy(n)"
              >
                <el-icon><Document /></el-icon> 复制全文
              </el-button>
            </div>
          </div>
        </transition>
      </article>

      <EmptyState
        v-if="!loading && notices.length === 0"
        icon="📣"
        title="暂无公告"
        description="管理员发布后会在这里显示"
      />
    </section>
  </div>
</template>

<script setup lang="ts">
/**
 * 平台公告页
 * - 默认折叠，单条点击展开（避免长公告占据首屏）
 * - 置顶项靠前 + 红标提醒
 * - 时间格式化复用 utils/format
 * - 数据源走 noticeStore：进入本页即标记全部已读，Header 红点同步熄灭
 */
import { computed, onMounted, ref } from 'vue'
import { Fold, Expand } from '@element-plus/icons-vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { useNoticeStore } from '@/stores/modules/notice'
import BackButton from '@/components/common/BackButton.vue'
import { formatDate } from '@/utils/format'
import type { Notice } from '@/types'

const noticeStore = useNoticeStore()
const notices = computed(() => noticeStore.notices)
const loading = computed(() => noticeStore.loading)
// 默认展开第一条（最近置顶公告）
const expandedId = ref<number | null>(null)

onMounted(async () => {
  // 已缓存过就直接渲染，避免二次进入时闪一下 loading
  if (noticeStore.notices.length === 0) await noticeStore.load()
  if (notices.value.length > 0) {
    expandedId.value = notices.value[0].id
  }
  noticeStore.markAllRead()
})

function toggle(id: number) {
  expandedId.value = expandedId.value === id ? null : id
}

/**
 * 把公告 content 按 \n 切成数组；空行也保留，作为段落分隔。
 * 这样页面里能用真正的 <br> / 段落，不会出现"挤在一坨"的情况。
 */
function splitContent(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

async function onCopy(n: Notice) {
  try {
    await navigator.clipboard.writeText(`${n.title}\n\n${n.content}`)
    ElMessage.success('已复制到剪贴板')
  } catch {
    // 降级方案：选中文本让用户手动复制
    ElMessage.warning('浏览器不支持自动复制，请手动选中')
  }
}
</script>

<style scoped lang="scss">
@use '@/styles/variables.scss' as *;

.notice-page {
  max-width: 880px;
  margin: 0 auto;
}

/* ============================================================
   Hero · 蓝色系（避开品牌橙，避免与价格/Promo 撞色）
   ============================================================ */
.notice-hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: $sp-6 $sp-8;
  border-radius: $radius-md;
  background:
    radial-gradient(ellipse at top right, rgba(255, 255, 255, 0.18), transparent 55%),
    linear-gradient(135deg, #0c4a6e 0%, $color-primary 55%, #6366f1 100%);
  color: #fff;
  box-shadow: $shadow-sm;

  .hero-text { display: flex; flex-direction: column; gap: 6px; }
  .hero-title {
    margin: 0; font-size: $fs-22; font-weight: $fw-bold;
    display: flex; align-items: center; gap: 8px;
  }
  .hero-icon { color: #ffd6a0; }
  .hero-sub { margin: 0; font-size: $fs-13; opacity: 0.85; }

  .hero-stat {
    display: flex; flex-direction: column; align-items: flex-end; gap: 2px;
    .stat-num {
      font-size: 36px; font-weight: $fw-bold;
      font-variant-numeric: tabular-nums; line-height: 1;
    }
    .stat-label { font-size: $fs-13; opacity: 0.85; }
  }
}

/* ============================================================
   列表
   ============================================================ */
.notice-list {
  margin-top: $sp-5;
  display: flex;
  flex-direction: column;
  gap: $sp-3;
}

.notice-item {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: $radius-md;
  overflow: hidden;
  transition:
    border-color $dur-base $ease-out,
    box-shadow $dur-base $ease-out,
    transform $dur-base $ease-out;

  &:hover { box-shadow: $shadow-sm; }

  &.is-pinned {
    border-color: rgba(239, 68, 68, 0.22);
    background: linear-gradient(180deg, #fff7f7 0%, var(--bg-card) 60%);
  }

  &.is-open {
    border-color: rgba(37, 99, 235, 0.3);
    box-shadow: $shadow-sm;
  }
}

.notice-head {
  display: flex;
  align-items: center;
  gap: $sp-3;
  padding: $sp-4 $sp-5;
  cursor: pointer;
  user-select: none;
}

.notice-rank {
  flex-shrink: 0;
  width: 28px; height: 28px;
  border-radius: $radius-sm;
  background: var(--bg-soft);
  color: var(--color-text-mute);
  display: grid; place-items: center;
  font-size: $fs-12;
  font-weight: $fw-semibold;
  font-variant-numeric: tabular-nums;

  .is-pinned & {
    background: linear-gradient(135deg, #ffb066, $brand-orange);
    color: #fff;
  }
}

.notice-meta {
  flex: 1; min-width: 0;
  display: flex; flex-direction: column; gap: 4px;
}

.title-row {
  display: flex; align-items: center; gap: $sp-2;

  .pin-tag {
    flex-shrink: 0;
    display: inline-flex; align-items: center; gap: 3px;
  }
}

.notice-title {
  margin: 0;
  font-size: $fs-15;
  font-weight: $fw-semibold;
  color: var(--color-text-primary);
  line-height: 1.5;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.notice-sub {
  display: flex; align-items: center; gap: $sp-3;
  color: var(--color-text-mute);
  font-size: $fs-12;

  .time {
    display: inline-flex; align-items: center; gap: 3px;
    .el-icon { font-size: 12px; }
  }
}

.notice-toggle {
  flex-shrink: 0;
  color: var(--color-text-mute);
  font-size: 16px;
  transition: color $dur-base $ease-out;
}
.notice-item:hover .notice-toggle { color: $color-primary; }

/* 展开正文 */
.notice-body {
  padding: 0 $sp-5 $sp-5 $sp-5;
  border-top: 1px dashed var(--border-color);
  margin: 0 $sp-3;
  padding-top: $sp-4;

  .content-line {
    font-size: $fs-14;
    color: var(--color-text-secondary);
    line-height: 1.85;
    margin-bottom: 6px;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .notice-actions {
    margin-top: $sp-3;
    text-align: right;
  }
}

/* 折叠过渡 */
.reveal-enter-active,
.reveal-leave-active {
  transition:
    max-height $dur-slow $ease-out,
    opacity $dur-base $ease-out,
    transform $dur-base $ease-out;
  overflow: hidden;
}
.reveal-enter-from,
.reveal-leave-to {
  max-height: 0;
  opacity: 0;
  transform: translateY(-4px);
}
.reveal-enter-to,
.reveal-leave-from {
  max-height: 800px;
  opacity: 1;
  transform: translateY(0);
}

/* 移动端 */
@media (max-width: $breakpoint-sm) {
  .notice-hero {
    padding: $sp-4 $sp-5;
    flex-direction: column; align-items: flex-start; gap: $sp-3;
    .hero-stat { align-items: flex-start; flex-direction: row; gap: 6px; align-items: baseline; }
  }
  .notice-head { padding: $sp-3 $sp-4; }
  .notice-body { padding: 0 $sp-4 $sp-4 $sp-4; margin: 0 $sp-2; }
  .notice-title { font-size: $fs-14; }
}
</style>
