<template>
  <div class="adm-pane">
    <div class="adm-card">
      <div class="adm-card-head">
        <span class="adm-card-title">公告管理</span>
        <span class="adm-card-hint">共 {{ list.length }} 条 · 置顶 {{ pinnedCount }} 条</span>
      </div>

      <div class="adm-card-body">
        <div class="adm-toolbar">
          <div class="adm-toolbar-left">
            <el-input
              v-model="kw"
              class="adm-input"
              placeholder="搜索标题 / 内容"
              clearable
            />
          </div>
          <div class="adm-toolbar-right">
            <el-button
              type="primary"
              @click="openCreate"
            >
              新建公告
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

        <el-table
          v-loading="loading"
          :data="filtered"
          row-key="id"
          style="width: 100%"
          empty-text="暂无公告"
        >
          <el-table-column type="expand">
            <template #default="{ row }">
              <div class="notice-preview">
                <p
                  v-for="(line, i) in (row as Notice).content.split(/\r?\n/)"
                  :key="i"
                >
                  {{ line || '\u00a0' }}
                </p>
              </div>
            </template>
          </el-table-column>
          <el-table-column
            label="标题"
            min-width="240"
          >
            <template #default="{ row }">
              <div class="adm-media-txt">
                <span class="adm-ellipsis">
                  <el-tag
                    v-if="(row as Notice).pinned"
                    type="danger"
                    size="small"
                    effect="plain"
                    class="pin"
                  >置顶</el-tag>
                  <b class="adm-strong">{{ (row as Notice).title }}</b>
                </span>
                <span class="adm-sub adm-ellipsis">{{ firstLine((row as Notice).content) }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column
            label="发布时间"
            width="156"
          >
            <template #default="{ row }">
              <span class="adm-num adm-muted">
                {{ formatDate((row as Notice).createTime, 'YYYY-MM-DD HH:mm') }}
              </span>
            </template>
          </el-table-column>
          <el-table-column
            label="字数"
            width="78"
            align="center"
          >
            <template #default="{ row }">
              <span class="adm-num adm-muted">{{ (row as Notice).content.length }}</span>
            </template>
          </el-table-column>
          <el-table-column
            label="操作"
            width="190"
            fixed="right"
            align="center"
          >
            <template #default="{ row }">
              <div class="adm-row-ops">
                <el-button
                  text
                  type="warning"
                  size="small"
                  @click="onTogglePin(row as Notice)"
                >
                  {{ (row as Notice).pinned ? '取消置顶' : '置顶' }}
                </el-button>
                <el-button
                  text
                  type="primary"
                  size="small"
                  @click="openEdit(row as Notice)"
                >
                  编辑
                </el-button>
                <el-button
                  text
                  type="danger"
                  size="small"
                  @click="onDelete(row as Notice)"
                >
                  删除
                </el-button>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </div>

    <!-- 新建 / 编辑公告 -->
    <el-dialog
      v-model="dlgVisible"
      :title="editingId ? '编辑公告' : '新建公告'"
      width="600px"
      append-to-body
      @closed="releaseOverlayFocus"
    >
      <el-form
        :model="form"
        label-width="82px"
        class="notice-form"
      >
        <el-form-item
          label="公告标题"
          required
        >
          <el-input
            v-model="form.title"
            maxlength="40"
            show-word-limit
            placeholder="例如：国庆假期平台服务时间调整"
          />
        </el-form-item>
        <el-form-item
          label="正文"
          required
        >
          <el-input
            v-model="form.content"
            type="textarea"
            :rows="8"
            maxlength="800"
            show-word-limit
            placeholder="支持换行，前台公告页会按行渲染"
          />
        </el-form-item>
        <el-form-item label="置顶">
          <el-switch v-model="form.pinned" />
          <span
            class="adm-card-hint"
            style="margin-left: 10px"
          >置顶后展示在公告列表最前</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dlgVisible = false">
          取消
        </el-button>
        <el-button
          type="primary"
          @click="onSubmit"
        >
          保存公告
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onActivated, ref } from 'vue'
import {
  createNotice,
  deleteNotice,
  fetchNotices,
  toggleNoticePin,
  updateNotice
} from '@/api/notice'
import { formatDate } from '@/utils/format'
import { releaseOverlayFocus } from '@/utils/focus'
import type { Notice } from '@/types'

const list = ref<Notice[]>([])
const loading = ref(false)
const kw = ref('')

const pinnedCount = computed(() => list.value.filter((n) => n.pinned).length)

/** 搜索放在本地做：公告总量小，没必要为每次输入打接口 */
const filtered = computed(() => {
  const q = kw.value.trim().toLowerCase()
  if (!q) return list.value
  return list.value.filter(
    (n) => n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q)
  )
})

function firstLine(content: string): string {
  return content.split(/\r?\n/)[0] ?? ''
}

async function reload() {
  loading.value = true
  try {
    list.value = await fetchNotices()
  } finally {
    loading.value = false
  }
}

/* ============ 新建 / 编辑 ============ */
const dlgVisible = ref(false)
/** 空串表示新建 */
const editingId = ref<number | null>(null)
const form = ref({ title: '', content: '', pinned: false })

function openCreate() {
  editingId.value = null
  form.value = { title: '', content: '', pinned: false }
  dlgVisible.value = true
}

function openEdit(row: Notice) {
  editingId.value = row.id
  form.value = { title: row.title, content: row.content, pinned: row.pinned }
  dlgVisible.value = true
}

async function onSubmit() {
  const title = form.value.title.trim()
  const content = form.value.content.trim()
  if (!title) {
    ElMessage.warning('请填写公告标题')
    return
  }
  if (!content) {
    ElMessage.warning('请填写公告正文')
    return
  }

  if (editingId.value !== null) {
    await updateNotice(editingId.value, { title, content, pinned: form.value.pinned })
    ElMessage.success('已保存修改')
  } else {
    await createNotice({ title, content, pinned: form.value.pinned })
    ElMessage.success('公告已发布')
  }
  dlgVisible.value = false
  await reload()
}

async function onTogglePin(row: Notice) {
  const updated = await toggleNoticePin(row.id)
  ElMessage.success(updated.pinned ? '已置顶' : '已取消置顶')
  await reload()
}

async function onDelete(row: Notice) {
  try {
    await ElMessageBox.confirm(`确认删除公告「${row.title}」？删除后前台立即不可见。`, '危险操作', { type: 'error' })
  } catch {
    return
  }
  await deleteNotice(row.id)
  ElMessage.success('已删除')
  await reload()
}

onActivated(reload)
</script>

<style scoped lang="scss">
.notice-preview {
  padding: 12px 14px 12px 52px;
  background: var(--bg-soft);

  p {
    margin: 0 0 4px;
    font-size: $fs-13;
    line-height: 1.75;
    color: var(--color-text-secondary);
    white-space: pre-wrap;
  }
}

.pin {
  margin-right: 6px;
  vertical-align: 1px;
}

@media (max-width: $breakpoint-sm) {
  .notice-preview {
    padding-left: 14px;
  }
}
</style>
