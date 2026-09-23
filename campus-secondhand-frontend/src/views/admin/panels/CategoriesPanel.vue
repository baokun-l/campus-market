<template>
  <div class="adm-pane">
    <div class="adm-card">
      <div class="adm-card-head">
        <span class="adm-card-title">分类管理</span>
        <span class="adm-card-hint">
          共 {{ list.length }} 个分类 · 覆盖 {{ goodsTotal }} 件商品 · 分类名会同步到商品列表
        </span>
      </div>

      <div class="adm-card-body">
        <div class="adm-toolbar">
          <div class="adm-toolbar-left">
            <span class="adm-card-hint">分类是全站共用的字典数据，删除前需先清空该分类下的商品</span>
          </div>
          <div class="adm-toolbar-right">
            <el-button
              type="primary"
              @click="openCreate"
            >
              新建分类
            </el-button>
            <el-button
              text
              type="primary"
              :loading="loading"
              @click="reload"
            >
              刷新
            </el-button>
          </div>
        </div>

        <div
          v-loading="loading"
          class="cat-grid"
        >
          <div
            v-for="c in list"
            :key="c.id"
            class="cat-card"
            tabindex="0"
          >
            <div class="cat-top">
              <span
                class="cat-icon"
                aria-hidden="true"
              >{{ c.icon }}</span>
              <span
                class="cat-count"
                :class="{ 'is-zero': !c.count }"
              >{{ c.count ?? 0 }} 件</span>
            </div>
            <div
              class="cat-name"
              :title="c.name"
            >
              {{ c.name }}
            </div>
            <div class="cat-foot">
              <el-button
                text
                type="primary"
                size="small"
                @click="openEdit(c)"
              >
                编辑
              </el-button>
              <el-button
                text
                type="danger"
                size="small"
                @click="onDelete(c)"
              >
                删除
              </el-button>
            </div>
          </div>

          <!-- 新建入口做成虚线卡片，比只在工具条放按钮更容易被发现 -->
          <button
            type="button"
            class="cat-card cat-add"
            @click="openCreate"
          >
            <span
              class="cat-add-plus"
              aria-hidden="true"
            >＋</span>
            <span class="cat-add-txt">新建分类</span>
          </button>
        </div>

        <div
          v-if="!loading && !list.length"
          class="adm-empty"
        >
          暂无分类
        </div>
      </div>
    </div>

    <!-- 新建 / 编辑分类 -->
    <el-dialog
      v-model="dlgVisible"
      :title="editingId ? '编辑分类' : '新建分类'"
      width="480px"
      append-to-body
      @closed="releaseOverlayFocus"
    >
      <el-form
        :model="form"
        label-width="82px"
      >
        <el-form-item
          label="分类名称"
          required
        >
          <el-input
            v-model="form.name"
            maxlength="8"
            show-word-limit
            placeholder="例如：教材"
          />
        </el-form-item>
        <el-form-item label="图标">
          <el-input
            v-model="form.icon"
            maxlength="2"
            placeholder="📚"
            style="width: 96px"
          />
          <div class="emoji-picks">
            <button
              v-for="e in ICON_PICKS"
              :key="e"
              type="button"
              class="emoji-pick"
              :class="{ 'is-on': form.icon === e }"
              @click="form.icon = e"
            >
              {{ e }}
            </button>
          </div>
        </el-form-item>
        <div class="adm-form-tip">
          <template v-if="editingId">
            改名会同步更新该分类下 {{ editingCount }} 件商品的分类名显示。
          </template>
          <template v-else>
            图标支持任意 emoji，最多 2 个字符。
          </template>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="dlgVisible = false">
          取消
        </el-button>
        <el-button
          type="primary"
          @click="onSubmit"
        >
          保存分类
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onActivated, ref } from 'vue'
import {
  createCategory,
  deleteCategory,
  fetchCategoryStats,
  updateCategory
} from '@/api/category'
import type { CategoryStat } from '@/api/category'
import { releaseOverlayFocus } from '@/utils/focus'

const ICON_PICKS = ['📚', '🎮', '🚲', '👕', '🪑', '🏀', '🍳', '🎨', '🎧', '📱', '🧸', '🛠️']

const list = ref<CategoryStat[]>([])
const loading = ref(false)

const goodsTotal = computed(() => list.value.reduce((s, c) => s + (c.count ?? 0), 0))

const dlgVisible = ref(false)
const editingId = ref<number | null>(null)
const editingCount = ref(0)
const form = ref({ name: '', icon: '📦' })

async function reload() {
  loading.value = true
  try {
    list.value = await fetchCategoryStats()
  } finally {
    loading.value = false
  }
}

function openCreate() {
  editingId.value = null
  editingCount.value = 0
  form.value = { name: '', icon: '📦' }
  dlgVisible.value = true
}

function openEdit(c: CategoryStat) {
  editingId.value = c.id
  editingCount.value = c.count ?? 0
  form.value = { name: c.name, icon: c.icon }
  dlgVisible.value = true
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : '操作失败'
}

async function onSubmit() {
  const name = form.value.name.trim()
  if (!name) {
    ElMessage.warning('请填写分类名称')
    return
  }
  const icon = form.value.icon.trim() || '📦'
  try {
    if (editingId.value !== null) {
      await updateCategory(editingId.value, { name, icon })
      ElMessage.success('已保存修改')
    } else {
      await createCategory({ name, icon })
      ElMessage.success('分类已创建')
    }
  } catch (e) {
    ElMessage.error(errText(e))
    return
  }
  dlgVisible.value = false
  await reload()
}

async function onDelete(c: CategoryStat) {
  try {
    await ElMessageBox.confirm(`确认删除分类「${c.name}」？`, '删除分类', { type: 'warning' })
  } catch {
    return
  }
  const r = await deleteCategory(c.id)
  if (!r.ok) {
    ElMessage.warning(r.reason || '删除失败')
    return
  }
  ElMessage.success('已删除')
  await reload()
}

onActivated(reload)
</script>

<style scoped lang="scss">
.cat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(186px, 1fr));
  gap: 12px;
  min-height: 120px;
}

.cat-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  border-radius: $radius-md;
  border: 1px solid var(--border-color);
  background: var(--bg-card);
  text-align: left;
  font: inherit;
  transition: border-color $dur-slow $ease-out, box-shadow $dur-slow $ease-out, transform $dur-slow $ease-out;

  &:hover {
    transform: translateY(-2px);
    border-color: var(--border-color-strong);
    box-shadow: $shadow-sm;
  }
  &:focus-visible {
    outline: 2px solid $color-primary;
    outline-offset: 2px;
  }
}

.cat-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.cat-icon {
  font-size: 26px;
  line-height: 1;
}

.cat-count {
  font-size: $fs-12;
  font-weight: $fw-semibold;
  color: #9a5b12;
  background: #fff7ec;
  border: 1px solid $brand-orange-line;
  border-radius: $radius-pill;
  padding: 2px 9px;
  font-variant-numeric: tabular-nums;

  &.is-zero {
    color: var(--color-text-mute);
    background: var(--bg-soft);
    border-color: var(--border-color);
  }
}

.cat-name {
  font-size: $fs-15;
  font-weight: $fw-semibold;
  color: var(--color-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cat-foot {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-top: 2px;
  padding-top: 6px;
  border-top: 1px solid var(--border-color);

  :deep(.el-button) {
    margin-left: 0;
    padding-left: 6px;
    padding-right: 6px;
  }
}

/* 虚线「新建」卡：视觉上明确是「占位 / 入口」，不与真实分类混淆 */
.cat-add {
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-style: dashed;
  background: transparent;
  color: var(--color-text-mute);
  cursor: pointer;
  min-height: 138px;

  &:hover {
    border-color: $brand-orange-line;
    color: $brand-orange;
    background: $brand-orange-soft;
  }

  .cat-add-plus {
    font-size: 22px;
    line-height: 1;
  }
  .cat-add-txt {
    font-size: $fs-13;
  }
}

.emoji-picks {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 8px;
}

.emoji-pick {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border: 1px solid var(--border-color);
  border-radius: $radius-sm;
  background: var(--bg-card);
  font-size: 16px;
  cursor: pointer;
  transition: border-color $dur-base $ease-out, background-color $dur-base $ease-out;

  &:hover {
    border-color: var(--border-color-strong);
    background: var(--bg-soft);
  }
  &.is-on {
    border-color: $color-primary;
    background: $color-primary-soft;
  }
}
</style>
