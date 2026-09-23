<template>
  <div class="adm-pane">
    <div class="adm-card">
      <div class="adm-card-head">
        <span class="adm-card-title">内容审核</span>
        <div class="adm-inline">
          <el-radio-group
            v-model="mode"
            size="small"
            @change="onModeChange"
          >
            <el-radio-button label="comment">
              商品留言
            </el-radio-button>
            <el-radio-button label="review">
              用户评价
            </el-radio-button>
          </el-radio-group>
        </div>
      </div>

      <div class="adm-card-body">
        <!-- ============ 商品留言 ============ -->
        <template v-if="mode === 'comment'">
          <div class="adm-toolbar">
            <div class="adm-toolbar-left">
              <el-input
                v-model="kw"
                class="adm-input"
                placeholder="搜索留言内容 / 用户"
                clearable
                @input="onSearchInput"
                @clear="loadComments"
                @keyup.enter="loadComments"
              />
            </div>
            <div class="adm-toolbar-right">
              <el-button
                text
                type="primary"
                :loading="loading"
                @click="loadComments"
              >
                刷新
              </el-button>
            </div>
          </div>

          <el-table
            v-loading="loading"
            :data="comments"
            style="width: 100%"
            empty-text="暂无留言"
          >
            <el-table-column
              label="用户"
              width="150"
            >
              <template #default="{ row }">
                <div class="adm-inline">
                  <el-avatar
                    :src="(row as AdminCommentRow).userAvatar"
                    :size="26"
                  />
                  <span class="adm-ellipsis">{{ (row as AdminCommentRow).userName }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column
              label="所属商品"
              width="160"
            >
              <template #default="{ row }">
                <span class="adm-ellipsis adm-muted">{{ (row as AdminCommentRow).goodsTitle }}</span>
              </template>
            </el-table-column>
            <el-table-column
              label="内容"
              min-width="230"
            >
              <template #default="{ row }">
                <div class="adm-media-txt">
                  <span class="adm-clamp-2">{{ (row as AdminCommentRow).content }}</span>
                  <span
                    v-if="(row as AdminCommentRow).replyToName"
                    class="adm-sub"
                  >
                    回复 @{{ (row as AdminCommentRow).replyToName }}
                  </span>
                </div>
              </template>
            </el-table-column>
            <el-table-column
              label="类型"
              width="76"
              align="center"
            >
              <template #default="{ row }">
                <el-tag
                  size="small"
                  effect="plain"
                  :type="(row as AdminCommentRow).isReply ? 'info' : 'primary'"
                >
                  {{ (row as AdminCommentRow).isReply ? '回复' : '留言' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column
              label="时间"
              width="132"
            >
              <template #default="{ row }">
                <span class="adm-num adm-muted">
                  {{ formatDate((row as AdminCommentRow).createTime, 'MM-DD HH:mm') }}
                </span>
              </template>
            </el-table-column>
            <el-table-column
              label="操作"
              width="92"
              fixed="right"
              align="center"
            >
              <template #default="{ row }">
                <el-button
                  text
                  type="danger"
                  size="small"
                  @click="onDeleteComment(row as AdminCommentRow)"
                >
                  删除
                </el-button>
              </template>
            </el-table-column>
          </el-table>

          <div class="adm-pager">
            <el-pagination
              v-model:current-page="commentPage"
              :page-size="pageSize"
              :total="commentTotal"
              layout="total, prev, pager, next"
              @current-change="loadComments"
            />
          </div>
        </template>

        <!-- ============ 用户评价 ============ -->
        <template v-else>
          <div class="adm-toolbar">
            <div class="adm-toolbar-left">
              <el-input
                v-model="kw"
                class="adm-input"
                placeholder="搜索评价内容 / 评价人"
                clearable
                @input="onSearchInput"
                @clear="loadReviews"
                @keyup.enter="loadReviews"
              />
              <el-select
          :teleported="false"
                v-model="ratingFilter"
                class="adm-select"
                placeholder="全部星级"
                @change="onRatingChange"
              >
                <el-option
                  label="全部星级"
                  value=""
                />
                <el-option
                  label="仅看差评（1-3 星）"
                  value="low"
                />
                <el-option
                  label="5 星"
                  value="5"
                />
                <el-option
                  label="4 星"
                  value="4"
                />
                <el-option
                  label="3 星"
                  value="3"
                />
                <el-option
                  label="2 星"
                  value="2"
                />
                <el-option
                  label="1 星"
                  value="1"
                />
              </el-select>
            </div>
            <div class="adm-toolbar-right">
              <span class="adm-card-hint">当前筛选下 {{ reviewTotal }} 条</span>
              <el-button
                text
                type="primary"
                :loading="loading"
                @click="loadReviews"
              >
                刷新
              </el-button>
            </div>
          </div>

          <el-table
            v-loading="loading"
            :data="reviews"
            style="width: 100%"
            empty-text="暂无评价"
          >
            <el-table-column
              label="评价人"
              width="150"
            >
              <template #default="{ row }">
                <div class="adm-inline">
                  <el-avatar
                    :src="(row as AdminReviewRow).fromUserAvatar"
                    :size="26"
                  />
                  <span class="adm-ellipsis">{{ (row as AdminReviewRow).fromUserName }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column
              label="所属商品"
              width="160"
            >
              <template #default="{ row }">
                <span class="adm-ellipsis adm-muted">{{ (row as AdminReviewRow).goodsTitle }}</span>
              </template>
            </el-table-column>
            <el-table-column
              label="星级"
              width="124"
            >
              <template #default="{ row }">
                <div class="adm-inline">
                  <el-rate
                    :model-value="(row as AdminReviewRow).rating"
                    disabled
                    size="small"
                  />
                  <span class="adm-num adm-muted">{{ (row as AdminReviewRow).rating }} 星</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column
              label="评价内容"
              min-width="220"
            >
              <template #default="{ row }">
                <span class="adm-clamp-2">{{ (row as AdminReviewRow).content }}</span>
                <!--
                  追评也要能被审核 —— 首评合规不代表追评合规。
                  与首评同样折两行，靠橙色前缀区分，不新增列（列一多必出横向滚动）。
                -->
                <span
                  v-if="(row as AdminReviewRow).appendContent"
                  class="adm-clamp-2 crv-append"
                >
                  追评：{{ (row as AdminReviewRow).appendContent }}
                </span>
              </template>
            </el-table-column>
            <el-table-column
              label="时间"
              width="132"
            >
              <template #default="{ row }">
                <span class="adm-num adm-muted">
                  {{ formatDate((row as AdminReviewRow).createTime, 'MM-DD HH:mm') }}
                </span>
              </template>
            </el-table-column>
            <el-table-column
              label="操作"
              width="92"
              fixed="right"
              align="center"
            >
              <template #default="{ row }">
                <el-button
                  text
                  type="danger"
                  size="small"
                  @click="onDeleteReview(row as AdminReviewRow)"
                >
                  删除
                </el-button>
              </template>
            </el-table-column>
          </el-table>

          <div class="adm-pager">
            <el-pagination
              v-model:current-page="reviewPage"
              :page-size="pageSize"
              :total="reviewTotal"
              layout="total, prev, pager, next"
              @current-change="loadReviews"
            />
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onActivated, onUnmounted, ref } from 'vue'
import { deleteComment, fetchAdminComments } from '@/api/comment'
import type { AdminCommentRow } from '@/api/comment'
import { deleteReview, fetchAdminReviews } from '@/api/review'
import type { AdminReviewRow } from '@/api/review'
import { formatDate } from '@/utils/format'

type Mode = 'comment' | 'review'

const mode = ref<Mode>('comment')
const loading = ref(false)
const pageSize = ref(10)
const kw = ref('')

/* 留言 */
const comments = ref<AdminCommentRow[]>([])
const commentPage = ref(1)
const commentTotal = ref(0)

/* 评价 */
const reviews = ref<AdminReviewRow[]>([])
const reviewPage = ref(1)
const reviewTotal = ref(0)
const ratingFilter = ref('')

/* 留言 / 评价共用一个搜索词：切模式时清空，避免「在评价里搜留言关键词」的困惑 */
function onModeChange() {
  kw.value = ''
  if (mode.value === 'comment') loadComments()
  else loadReviews()
}

let searchTimer: ReturnType<typeof setTimeout> | null = null
function onSearchInput() {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    if (mode.value === 'comment') {
      commentPage.value = 1
      loadComments()
    } else {
      reviewPage.value = 1
      loadReviews()
    }
  }, 300)
}
onUnmounted(() => {
  if (searchTimer) clearTimeout(searchTimer)
})

function onRatingChange() {
  reviewPage.value = 1
  loadReviews()
}

async function loadComments() {
  loading.value = true
  try {
    const r = await fetchAdminComments({
      page: commentPage.value,
      pageSize: pageSize.value,
      keyword: kw.value
    })
    comments.value = r.list
    commentTotal.value = r.total
  } finally {
    loading.value = false
  }
}

async function loadReviews() {
  loading.value = true
  try {
    const rf = ratingFilter.value
    const r = await fetchAdminReviews({
      page: reviewPage.value,
      pageSize: pageSize.value,
      keyword: kw.value,
      rating: rf === 'low' ? 'low' : rf ? Number(rf) : undefined
    })
    reviews.value = r.list
    reviewTotal.value = r.total
  } finally {
    loading.value = false
  }
}

async function onDeleteComment(row: AdminCommentRow) {
  const tip = row.isReply
    ? '确认删除这条回复？'
    : '确认删除这条留言？该留言下的回复会一并删除。'
  try {
    await ElMessageBox.confirm(tip, '删除内容', { type: 'warning' })
  } catch {
    return
  }
  const r = await deleteComment(row.id)
  ElMessage.success(r.removed > 1 ? `已删除 1 条留言及其 ${r.removed - 1} 条回复` : '已删除')
  await loadComments()
}

async function onDeleteReview(row: AdminReviewRow) {
  try {
    await ElMessageBox.confirm('确认删除这条评价？被删除后对应订单会重新变回「可评价」。', '删除评价', {
      type: 'warning'
    })
  } catch {
    return
  }
  await deleteReview(row.id)
  ElMessage.success('已删除')
  await loadReviews()
}

onActivated(() => {
  if (mode.value === 'comment') loadComments()
  else loadReviews()
})
</script>

<style scoped lang="scss">
/* el-rate 只读态默认偏灰，稍微提一点对比度，让星级在表格里可读 */
:deep(.el-rate) {
  height: 18px;
  line-height: 18px;
}
:deep(.el-rate__icon) {
  margin-right: 1px;
  font-size: 14px;
}

/*
 * 追评行：只加颜色与间距，不碰 display ——
 * adm-clamp-2 靠 display:-webkit-box 做两行截断，改掉它截断就失效了。
 */
.crv-append {
  margin-top: 2px;
  color: #e85d00;
}
</style>
