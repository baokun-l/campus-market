<template>
  <PageContainer
    title="商品广场"
    :loading="loading"
    subtitle="浏览、搜索、筛选你想找的二手好物"
  >
    <template #actions>
      <el-button
        type="primary"
        @click="$router.push('/goods/publish')"
      >
        <el-icon><Plus /></el-icon> 发布闲置
      </el-button>
    </template>

    <!-- 分类快选条：小号胶囊，填页头下的空白；与下方分类下拉、URL query 三方同源 -->
    <div
      class="cat-chips"
      role="tablist"
      aria-label="商品分类快选"
    >
      <button
        type="button"
        role="tab"
        class="cat-chip"
        :class="{ 'is-active': !categoryId }"
        :aria-selected="!categoryId"
        @click="onCategoryChange(null)"
      >
        全部
      </button>
      <button
        v-for="c in categories"
        :key="c.id"
        type="button"
        role="tab"
        class="cat-chip"
        :class="{ 'is-active': categoryId === c.id }"
        :aria-selected="categoryId === c.id"
        @click="onCategoryChange(c.id)"
      >
        {{ c.name }}
      </button>
    </div>

    <!-- 筛选区 -->
    <div class="filter-bar">
      <SearchBar
        v-model="kw"
        :placeholder="`搜索 ${total} 件商品`"
        @search="onSearch"
      />
      <!-- :teleported="false"：body zoom 下弹层坐标会被双重缩放（特大档 dx=136px），
           留在 zoom 上下文内定位才对齐；本页容器无 overflow 裁剪，可安全关闭传送 -->
      <el-select
        v-model="sort"
        class="sort-select"
        :teleported="false"
        @change="reload"
      >
        <el-option
          label="最新发布"
          value="new"
        />
        <el-option
          label="价格升序"
          value="price_asc"
        />
        <el-option
          label="价格降序"
          value="price_desc"
        />
        <el-option
          label="热度最高"
          value="hot"
        />
      </el-select>
      <el-select
        v-model="categoryId"
        placeholder="全部分类"
        clearable
        class="sort-select"
        :teleported="false"
        @change="onCategoryChange"
      >
        <el-option
          v-for="c in categories"
          :key="c.id"
          :label="c.name"
          :value="c.id"
        />
      </el-select>
    </div>

    <template v-if="list.length">
      <!-- CSS Grid 替代 el-row/el-col：行列间距一致（el-row 的 gutter 只给水平间距，
           行与行之间会贴在一起，导致卡片网格纵向节奏断裂） -->
      <div class="goods-grid">
        <GoodsCard
          v-for="g in list"
          :key="g.id"
          :goods="g"
        />
      </div>
    </template>
    <EmptyState
      v-else
      title="暂时没有匹配的商品"
      description="换个关键词或分类试试"
      action-text="重置筛选"
      icon="🛒"
      @action="reset"
    />

    <template #footer>
      <div class="pagination">
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          :page-sizes="[12, 24, 48]"
          :total="total"
          layout="total, sizes, prev, pager, next, jumper"
          background
          @current-change="reload"
          @size-change="reload"
        />
      </div>
    </template>
  </PageContainer>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PageContainer from '@/components/common/PageContainer.vue'
import SearchBar from '@/components/common/SearchBar.vue'
import GoodsCard from '@/components/common/GoodsCard.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { fetchGoods, fetchCategories, BUYER_VISIBLE_STATUS } from '@/api/goods'
import type { Goods, Category } from '@/types'

const route = useRoute()
const router = useRouter()

const list = ref<Goods[]>([])
const total = ref(0)
const loading = ref(false)
const page = ref(1)
const pageSize = ref(12)
const kw = ref((route.query.keyword as string) ?? '')
const sort = ref<'new' | 'price_asc' | 'price_desc' | 'hot'>('new')
const categoryId = ref<number | null>(Number(route.query.categoryId) || null)
const categories = ref<Category[]>([])

/**
 * 请求序号：只有「最后一次发出的请求」允许写状态。
 *
 * `reload()` 会被 onSearch / onCategoryChange / reset / onMounted / watch(route.query)
 * 多处触发，两次请求可能重叠。若先发的慢请求后返回，它会用**过期结果**覆盖
 * 后发的快请求 —— 列表与地址栏/筛选器显示的条件对不上，而且 `loading` 也会被
 * 先到的旧请求提前置 false（转圈停了、数据却是旧的）。
 * 用单调递增的序号做闸门：晚于自己的请求已经发出，就直接丢弃这次结果。
 */
let reqSeq = 0

async function reload() {
  const seq = ++reqSeq
  loading.value = true
  try {
    const r = await fetchGoods({
      page: page.value,
      pageSize: pageSize.value,
      keyword: kw.value,
      categoryId: categoryId.value ?? undefined,
      // 买家入口必须限定可见范围：审核中 / 已下架的商品不能出现在广场里，
      // 否则买家点进去才发现压根买不了（statuses 是白名单，不是「筛选项」）
      statuses: BUYER_VISIBLE_STATUS,
      sort: sort.value
    })
    if (seq !== reqSeq) return // 已有更新的请求发出，这次结果作废
    list.value = r.list
    total.value = r.total
  } catch (e: any) {
    if (seq !== reqSeq) return // 过期请求的失败也不该弹提示（用户已经看到新结果了）
    ElMessage.error(e?.message || '加载失败')
  } finally {
    // loading 同样要守卫：否则旧请求结束会把新请求的转圈提前关掉
    if (seq === reqSeq) loading.value = false
  }
}

async function loadCats() {
  categories.value = await fetchCategories()
}

function onSearch(v: string) {
  kw.value = v
  page.value = 1
  router.replace({ query: { ...route.query, keyword: v } })
  reload()
}

/** 切换分类：同步写入 URL，保证「筛选状态 === 地址栏参数」，可分享/可前进后退 */
function onCategoryChange(v: number | null) {
  page.value = 1
  const q = { ...route.query }
  if (v) q.categoryId = String(v)
  else delete q.categoryId
  router.replace({ query: q })
  // v-model 已先一步改掉了 categoryId，watcher 检测不到差异不会触发，这里负责真正请求
  reload()
}

function reset() {
  kw.value = ''
  categoryId.value = null
  sort.value = 'new'
  page.value = 1
  router.replace({ query: {} })
  reload()
}

onMounted(() => { loadCats(); reload() })

/**
 * 监听 URL query 变化并同步筛选状态。
 * 【修复】原来只 watch 了 keyword，没 watch categoryId：
 *   在首页点「教材」→ /goods?categoryId=1 筛出教材后，若再点侧栏「商品广场」(/goods)，
 *   Vue Router 会复用同一个 List 组件（不重新 mount），categoryId 停留在 1，
 *   导致「全部」点了却还停在分类筛选里。现在统一在 query 变化时同步。
 */
watch(
  () => route.query,
  (q) => {
    const nextKw = (q.keyword as string) ?? ''
    // Number(undefined) === NaN，|| null 兜住「无参数」情况
    const nextCat = Number(q.categoryId) || null
    const changed = nextKw !== kw.value || nextCat !== categoryId.value
    if (!changed) return
    kw.value = nextKw
    categoryId.value = nextCat
    page.value = 1
    reload()
  },
  { deep: true }
)
</script>

<style scoped lang="scss">
@use '@/styles/variables.scss' as *;

/* 分类快选条：小号胶囊（首页是大卡片，这里是轻量快选，不抢筛选区注意力） */
.cat-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: $sp-3;
}

.cat-chip {
  height: 30px;
  padding: 0 14px;
  border: 1px solid var(--border-color);
  border-radius: $radius-pill;
  background: var(--bg-card);
  color: var(--color-text-secondary);
  font-size: $fs-13;
  font-family: inherit;
  cursor: pointer;
  transition: color $dur-base $ease-out, border-color $dur-base $ease-out,
    background-color $dur-base $ease-out;

  &:hover {
    border-color: $color-primary;
    color: $color-primary;
  }

  &.is-active {
    background: $color-primary;
    border-color: $color-primary;
    color: #fff;
    font-weight: $fw-medium;
  }
}

/* 筛选栏：白卡容器，统一圆角与内边距，避免控件"散落"在页面上 */
.filter-bar {
  display: flex;
  gap: $sp-3;
  padding: $sp-3 $sp-4;
  margin-bottom: $sp-4;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: $radius-md;
  box-shadow: $shadow-xs;
  flex-wrap: wrap;
  align-items: center;

  :deep(.search-bar) { flex: 1 1 240px; min-width: 200px; }
  .sort-select { width: 150px; }
}

/* 商品网格：auto-fill 自适应列数 + 统一 16px 间距 */
.goods-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(196px, 1fr));
  gap: $sp-4;
}

.pagination {
  margin-top: $sp-5;
  display: flex;
  justify-content: center;
}

@media (max-width: $breakpoint-sm) {
  .filter-bar {
    padding: $sp-3;
    .sort-select { width: 100%; }
  }
  .goods-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: $sp-3;
  }
}
</style>
