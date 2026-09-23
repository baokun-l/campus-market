<template>
  <div class="adm-pane">
    <div class="adm-card">
      <div class="adm-card-head">
        <span class="adm-card-title">举报记录</span>
        <span class="adm-card-hint">
          待处理 <b class="is-warn">{{ stats.pending }}</b> · 已处理
          <b class="is-ok">{{ stats.handled }}</b> · 已驳回 {{ stats.rejected }}
        </span>
      </div>

      <div class="adm-card-body">
        <div class="adm-toolbar">
          <div class="adm-toolbar-left">
            <el-radio-group
              v-model="status"
              @change="onFilterChange"
            >
              <el-radio-button label="">
                全部
              </el-radio-button>
              <el-radio-button label="pending">
                待处理
              </el-radio-button>
              <el-radio-button label="handled">
                已处理
              </el-radio-button>
              <el-radio-button label="rejected">
                已驳回
              </el-radio-button>
            </el-radio-group>
            <el-select
          :teleported="false"
              v-model="type"
              class="adm-select"
              clearable
              placeholder="全部类型"
              @change="onFilterChange"
            >
              <el-option
                v-for="(label, val) in REPORT_TYPE_LABEL"
                :key="val"
                :label="label"
                :value="val"
              />
            </el-select>
          </div>
          <div class="adm-toolbar-right">
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
          v-if="selected.length"
          class="adm-batch"
        >
          已选 <b>{{ selected.length }}</b> 条举报（仅「待处理」会被改动）
          <div class="adm-batch-ops">
            <el-button
              size="small"
              type="success"
              plain
              @click="openDialog(selected, 'handle')"
            >
              批量处理
            </el-button>
            <el-button
              size="small"
              type="info"
              plain
              @click="openDialog(selected, 'reject')"
            >
              批量驳回
            </el-button>
            <el-button
              size="small"
              text
              @click="clearSelection"
            >
              取消选择
            </el-button>
          </div>
        </div>

        <el-table
          ref="tableRef"
          v-loading="loading"
          :data="reports"
          row-key="id"
          style="width: 100%"
          empty-text="暂无举报记录"
          @selection-change="onSelectionChange"
        >
          <el-table-column
            type="selection"
            width="46"
            :selectable="isSelectable"
          />
          <el-table-column
            label="类型"
            width="80"
            align="center"
          >
            <template #default="{ row }">
              <el-tag
                size="small"
                :type="(row as Report).type === 'goods' ? 'warning' : (row as Report).type === 'user' ? 'danger' : 'info'"
              >
                {{ REPORT_TYPE_LABEL[(row as Report).type] }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column
            label="目标"
            width="80"
          >
            <template #default="{ row }">
              <span class="adm-id">#{{ (row as Report).targetId }}</span>
            </template>
          </el-table-column>
          <el-table-column
            prop="reason"
            label="理由"
            width="112"
            show-overflow-tooltip
          />
          <!-- 详细说明下方追加「处置结论」：让已处理的举报看得出平台到底做了什么，
               而不是只有一个「已处理」标签（这正是之前被反馈的问题） -->
          <el-table-column
            label="详细说明"
            min-width="210"
          >
            <template #default="{ row }">
              <div class="rp-desc">
                <span class="adm-clamp-2">{{ (row as Report).description }}</span>
                <span
                  v-if="(row as Report).measure"
                  class="rp-resolve"
                >
                  <b>{{ REPORT_MEASURE_LABEL[(row as Report).measure as ReportMeasure] }}</b>
                  <span class="rp-effect">{{ (row as Report).outcome }}</span>
                  <em v-if="(row as Report).remark">备注：{{ (row as Report).remark }}</em>
                </span>
              </div>
            </template>
          </el-table-column>
          <el-table-column
            label="状态"
            width="84"
            align="center"
          >
            <template #default="{ row }">
              <el-tag
                size="small"
                effect="plain"
                :type="reportTag((row as Report).status)"
              >
                {{ REPORT_STATUS_LABEL[(row as Report).status] }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column
            label="举报时间"
            width="124"
          >
            <template #default="{ row }">
              <span class="adm-num adm-muted">
                {{ formatDate((row as Report).createTime, 'MM-DD HH:mm') }}
              </span>
            </template>
          </el-table-column>
          <el-table-column
            label="操作"
            width="140"
            fixed="right"
            align="center"
          >
            <template #default="{ row }">
              <div class="adm-row-ops">
                <template v-if="(row as Report).status === 'pending'">
                  <el-button
                    text
                    type="success"
                    size="small"
                    @click="openDialog([row as Report], 'handle')"
                  >
                    处理
                  </el-button>
                  <el-button
                    text
                    type="info"
                    size="small"
                    @click="openDialog([row as Report], 'reject')"
                  >
                    驳回
                  </el-button>
                </template>
                <el-button
                  v-if="(row as Report).type === 'goods'"
                  text
                  type="primary"
                  size="small"
                  @click="goGoods((row as Report).targetId)"
                >
                  查看商品
                </el-button>
                <span
                  v-else
                  class="adm-muted adm-sub"
                >已归档</span>
              </div>
            </template>
          </el-table-column>
        </el-table>

        <div class="adm-pager">
          <el-pagination
            v-model:current-page="page"
            :page-size="pageSize"
            :total="total"
            layout="total, prev, pager, next"
            @current-change="reload"
          />
        </div>
      </div>
    </div>

    <!-- 处理 / 驳回举报：必须落一个「具体做了什么」的结论，而不是只翻状态 -->
    <el-dialog
      v-model="dlgVisible"
      :title="dlgTitle"
      width="600px"
      append-to-body
      @closed="onDialogClosed"
    >
      <div class="rp-target">
        <template v-if="dlgMode === 'handle' && targetGoods">
          <el-image
            :src="targetGoods.cover"
            fit="cover"
            class="adm-thumb"
          />
          <div class="rp-target-txt">
            <span class="adm-strong adm-ellipsis">{{ targetGoods.title }}</span>
            <span class="adm-sub">
              卖家 {{ targetGoods.sellerName }} · 挂牌 ¥{{ targetGoods.price.toFixed(2) }} · 当前
              {{ GOODS_STATUS_LABEL[targetGoods.status] }}
            </span>
          </div>
        </template>
        <template v-else>
          <span class="adm-sub">
            共 {{ dlgRows.length }} 条举报：{{
              dlgRows
                .slice(0, 4)
                .map((r) => `#${r.id}（${REPORT_TYPE_LABEL[r.type]} #${r.targetId}）`)
                .join('、')
            }}{{ dlgRows.length > 4 ? ` 等 ${dlgRows.length} 条` : '' }}
          </span>
        </template>
      </div>

      <el-form
        v-if="dlgMode === 'handle'"
        label-width="86px"
        class="rp-form"
      >
        <el-form-item
          label="处理措施"
          required
        >
          <el-radio-group
            v-model="measure"
            class="rp-measures"
          >
            <el-radio
              v-for="m in measureOptions"
              :key="m.value"
              :value="m.value"
              :disabled="!!measureBlocked(m.value)"
              class="rp-measure"
            >
              <span class="rp-measure-label">{{ m.label }}</span>
              <span class="rp-measure-effect">{{ measureBlocked(m.value) || m.effect }}</span>
            </el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item
          label="处理备注"
          :required="remarkRequired"
        >
          <el-input
            v-model="remark"
            type="textarea"
            :rows="3"
            maxlength="120"
            show-word-limit
            :placeholder="remarkPlaceholder"
          />
        </el-form-item>
        <div class="adm-form-tip rp-tip">
          {{ remarkRequired ? '该措施需要说明依据，备注不少于 5 个字。' : '建议填写处理依据，会一并写入操作日志。' }}
        </div>
      </el-form>

      <el-form
        v-else
        label-width="86px"
        class="rp-form"
      >
        <el-form-item
          label="驳回备注"
          required
        >
          <el-input
            v-model="remark"
            type="textarea"
            :rows="3"
            maxlength="120"
            show-word-limit
            placeholder="例如：举报证据不足，商品描述与实物一致，举报不成立"
          />
        </el-form-item>
        <div class="adm-form-tip rp-tip">
          驳回后举报记为「已驳回」，不会对被举报对象做任何处置。
        </div>
      </el-form>

      <template #footer>
        <el-button @click="dlgVisible = false">
          取消
        </el-button>
        <el-button
          type="primary"
          :loading="submitting"
          @click="onSubmit"
        >
          {{ dlgMode === 'handle' ? '确认处理' : '确认驳回' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, onActivated, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  batchResolveReports,
  fetchReports,
  fetchReportStats,
  measuresForType,
  REPORT_MEASURE_LABEL,
  REPORT_TYPE_LABEL,
  resolveReport
} from '@/api/report'
import { fetchGoodsDetail, GOODS_STATUS_LABEL } from '@/api/goods'
import { formatDate } from '@/utils/format'
import type { Goods, Report, ReportMeasure } from '@/types'
import { releaseOverlayFocus } from '@/utils/focus'
import type { ReportMeasureMeta } from '@/api/report'
import { ADMIN_CONTEXT } from '../adminContext'

const admin = inject(ADMIN_CONTEXT)
const router = useRouter()

const REPORT_STATUS_LABEL: Record<Report['status'], string> = {
  pending: '待处理',
  handled: '已处理',
  rejected: '已驳回'
}

const reports = ref<Report[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(10)
const status = ref<'' | Report['status']>('')
const type = ref<'' | Report['type']>('')
const loading = ref(false)
const selected = ref<Report[]>([])
const tableRef = ref<{ clearSelection: () => void }>()
const stats = ref({ pending: 0, handled: 0, rejected: 0 })

/** 已处理的记录不再参与批量操作，避免「重复处理」把结论改来改去 */
function isSelectable(row: unknown): boolean {
  return (row as Report).status === 'pending'
}

function reportTag(s: Report['status']): 'warning' | 'success' | 'info' {
  return ({ pending: 'warning', handled: 'success', rejected: 'info' } as const)[s]
}

function onSelectionChange(list: unknown[]) {
  selected.value = list as Report[]
}

function clearSelection() {
  tableRef.value?.clearSelection()
  selected.value = []
}

function onFilterChange() {
  page.value = 1
  reload()
}

function goGoods(id: number) {
  router.push(`/goods/${id}`)
}

/* ------------------------------------------------------------------
 * 处理弹窗
 * ------------------------------------------------------------------ */

const dlgVisible = ref(false)
const dlgMode = ref<'handle' | 'reject'>('handle')
/** 本次操作覆盖的举报（单条或批量） */
const dlgRows = ref<Report[]>([])
const measure = ref<ReportMeasure | ''>('')
const remark = ref('')
const submitting = ref(false)
/** 商品类举报在弹窗里顺带把商品现状查出来，管理员才知道「下架」还该不该做 */
const targetGoods = ref<Goods | null>(null)

const isBatch = computed(() => dlgRows.value.length > 1)

const dlgTitle = computed(() => {
  if (dlgMode.value === 'reject') return isBatch.value ? `批量驳回 ${dlgRows.value.length} 条举报` : '驳回举报'
  return isBatch.value ? `批量处理 ${dlgRows.value.length} 条举报` : '处理举报'
})

/**
 * 可选的措施：单条按举报对象类型过滤；批量取所有类型的交集 ——
 * 给商品类举报提供「封禁用户」、给用户类举报提供「下架商品」都是无效选项。
 */
const measureOptions = computed<ReportMeasureMeta[]>(() => {
  const rows = dlgRows.value
  if (!rows.length) return []
  if (rows.length === 1) return measuresForType(rows[0].type)
  const [first, ...rest] = rows
  return measuresForType(first.type).filter((m) => rest.every((r) => m.types.includes(r.type)))
})

/** 措施当前不可用的原因（商品已被删除 / 已被下架时不该再让管理员选一次） */
function measureBlocked(value: ReportMeasure): string {
  if (dlgRows.value.length === 1 && dlgRows.value[0].type === 'goods') {
    if (!targetGoods.value && (value === 'off_shelf' || value === 'remove')) {
      return '该商品已不存在，无法执行'
    }
    if (targetGoods.value?.status === 'off_shelf' && value === 'off_shelf') {
      return '该商品当前已是下架状态'
    }
  }
  return ''
}

/** 警示整改 / 仅记录结论这类判断性措施必须写清依据，具体处置可留空 */
const remarkRequired = computed(
  () => dlgMode.value === 'reject' || measure.value === 'warn' || measure.value === 'none'
)

const remarkPlaceholder = computed(() => {
  if (dlgMode.value === 'reject') return '请说明驳回理由'
  if (measure.value === 'warn') return '例如：商品描述与实物明显不符，限期 3 天整改'
  if (measure.value === 'none') return '例如：买卖双方各执一词，证据不足，本次仅记录结论'
  return '可填写处理依据或对卖家的补充说明（选填）'
})

async function openDialog(rows: Report[], mode: 'handle' | 'reject') {
  if (!rows.length) return
  dlgMode.value = mode
  dlgRows.value = rows.slice()
  measure.value = ''
  remark.value = ''
  targetGoods.value = null
  dlgVisible.value = true
  if (rows.length === 1 && rows[0].type === 'goods') {
    try {
      targetGoods.value = await fetchGoodsDetail(rows[0].targetId)
    } catch {
      // 商品可能已被删除：留空，措施列表里会提示不可用
      targetGoods.value = null
    }
  }
}

function onDialogClosed() {
  dlgRows.value = []
  measure.value = ''
  remark.value = ''
  targetGoods.value = null
  // 关闭后归还焦点：否则焦点留在浮层内的哨兵上，页面上其它 el-select 会点不开
  releaseOverlayFocus()
}

async function onSubmit() {
  if (dlgMode.value === 'handle' && !measure.value) {
    ElMessage.warning('请先选择处理措施')
    return
  }
  if (remarkRequired.value && remark.value.trim().length < 5) {
    ElMessage.warning('请填写不少于 5 个字的处理备注，说明处理依据')
    return
  }
  const payloadMeasure = dlgMode.value === 'handle' ? (measure.value as ReportMeasure) : undefined
  submitting.value = true
  try {
    if (isBatch.value) {
      const ids = dlgRows.value.map((r) => r.id)
      const n = await batchResolveReports(ids, dlgMode.value, { measure: payloadMeasure, remark: remark.value })
      ElMessage.success(dlgMode.value === 'handle' ? `已按「${labelOf(payloadMeasure)}」处理 ${n} 条举报` : `已驳回 ${n} 条举报`)
    } else {
      await resolveReport({ id: dlgRows.value[0].id, action: dlgMode.value, measure: payloadMeasure, remark: remark.value })
      ElMessage.success(dlgMode.value === 'handle' ? '已处理，处置结论已记录' : '已驳回')
    }
    dlgVisible.value = false
    clearSelection()
    await Promise.all([reload(), admin?.refreshOverview()])
  } catch (e) {
    ElMessage.error((e as Error).message || '操作失败')
  } finally {
    submitting.value = false
  }
}

function labelOf(value?: ReportMeasure): string {
  return value ? REPORT_MEASURE_LABEL[value] : ''
}

async function reload() {
  loading.value = true
  try {
    const [r, s] = await Promise.all([
      fetchReports({
        page: page.value,
        pageSize: pageSize.value,
        status: status.value || undefined,
        type: type.value || undefined
      }),
      fetchReportStats()
    ])
    reports.value = r.list
    total.value = r.total
    stats.value = s
    clearSelection()
  } finally {
    loading.value = false
  }
}

onActivated(reload)
</script>

<style scoped lang="scss">
/* 说明 + 处置结论：两段文字纵向排列，行高由内容决定（不设 nowrap，
   否则 .cell 会出现 scrollWidth > clientWidth，触发 e2e 的单元格溢出断言） */
.rp-desc {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.rp-resolve {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: $fs-11;
  line-height: 1.5;
  color: var(--color-text-mute);
  word-break: break-word;

  b {
    margin-right: 4px;
    font-weight: $fw-semibold;
    color: $brand-orange;
  }
  .rp-effect {
    color: var(--color-text-secondary);
  }
  em {
    display: block;
    font-style: normal;
    color: $text-4;
  }
}

/* 弹窗顶部：被举报对象摘要 */
.rp-target {
  display: flex;
  align-items: center;
  gap: $sp-3;
  padding: 10px 14px;
  margin-bottom: $sp-4;
  border-radius: $radius-sm;
  background: var(--bg-soft);
  border: 1px solid var(--border-color);
  min-width: 0;
}

.rp-target-txt {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  line-height: 1.5;
}

.rp-form {
  .rp-tip {
    margin-left: 86px;
  }
}

/* 措施单选项：一行一个，标题 + 后果说明，避免管理员凭字面猜后果 */
.rp-measures {
  display: flex;
  flex-direction: column;
  gap: $sp-2;
  width: 100%;
}

.rp-measure {
  height: auto;
  margin-right: 0;
  padding: 8px 12px;
  border: 1px solid var(--border-color);
  border-radius: $radius-sm;
  background: var(--bg-card);
  transition: border-color $dur-base $ease-out, background $dur-base $ease-out;

  &:hover {
    border-color: $brand-orange-line;
  }

  &.is-checked {
    border-color: $brand-orange;
    background: $brand-orange-soft;
  }
  /* 禁用项保留在列表里并说明原因，比直接隐藏更容易理解 */
  &.is-disabled {
    background: var(--bg-soft);
    opacity: 0.72;
  }

  :deep(.el-radio__label) {
    display: flex;
    flex-direction: column;
    gap: 2px;
    line-height: 1.5;
    white-space: normal;
  }
  :deep(.el-radio__input) {
    align-self: flex-start;
    margin-top: 2px;
  }
}

.rp-measure-label {
  font-size: $fs-13;
  font-weight: $fw-semibold;
  color: var(--color-text-primary);
}

.rp-measure-effect {
  font-size: $fs-12;
  color: var(--color-text-mute);
}
</style>
