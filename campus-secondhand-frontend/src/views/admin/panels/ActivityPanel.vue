<template>
  <div class="adm-pane">
    <!-- ============ 活动管理（多活动 · 可随时上架） ============ -->
    <div class="act-bar">
      <div class="act-bar-left">
        <el-button
          type="primary"
          @click="openCreateActivity"
        >
          新建活动
        </el-button>
        <el-button @click="onResetActivities">
          恢复出厂
        </el-button>
        <el-button
          text
          @click="loadActivities"
        >
          刷新
        </el-button>
      </div>
      <div class="act-bar-right">
        <span>共 <b>{{ activityList.length }}</b> 个活动</span>
        <i class="sep" />
        <span>进行中 <b class="ok">{{ activeCount }}</b></span>
        <i class="sep" />
        <span>待开始 <b class="warn">{{ pendingCount }}</b></span>
      </div>
    </div>

    <div class="adm-card adm-card-body--flush">
      <el-table
        ref="activityTableRef"
        v-loading="activityLoading"
        :data="activityList"
        highlight-current-row
        row-key="config.id"
        class="act-table"
        style="width: 100%"
        empty-text="暂无活动，点左上角「新建活动」开始"
        @current-change="onSelectActivity"
      >
        <el-table-column
          label="活动"
          min-width="230"
        >
          <template #default="{ row }">
            <div class="act-cell">
              <span
                class="theme-dot"
                :style="{ background: themeColor((row as ActivityDisplay).config.theme) }"
                :title="themeLabel((row as ActivityDisplay).config.theme)"
              />
              <span
                class="act-emoji"
                aria-hidden="true"
              >{{ (row as ActivityDisplay).config.icon }}</span>
              <div class="act-txt">
                <b :title="(row as ActivityDisplay).config.title">{{ (row as ActivityDisplay).config.title }}</b>
                <span
                  v-if="(row as ActivityDisplay).config.note"
                  class="act-note"
                  :title="(row as ActivityDisplay).config.note"
                >
                  {{ (row as ActivityDisplay).config.note }}
                </span>
              </div>
            </div>
          </template>
        </el-table-column>
        <el-table-column
          label="状态"
          width="76"
          align="center"
        >
          <template #default="{ row }">
            <el-tag
              size="small"
              effect="light"
              :type="stateTag((row as ActivityDisplay).state)"
            >
              {{ stateLabel((row as ActivityDisplay).state) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column
          label="优先级"
          width="68"
          align="center"
          prop="config.priority"
          sortable
        />
        <el-table-column
          label="开始时间"
          width="138"
        >
          <template #default="{ row }">
            {{ fmtDate((row as ActivityDisplay).config.startAt) }}
          </template>
        </el-table-column>
        <el-table-column
          label="持续"
          width="62"
          align="center"
        >
          <template #default="{ row }">
            {{ (row as ActivityDisplay).config.durationDays }} 天
          </template>
        </el-table-column>
        <el-table-column
          label="剩余倒计时"
          width="126"
        >
          <template #default="{ row }">
            <b
              v-if="(row as ActivityDisplay).state === 'active' || (row as ActivityDisplay).state === 'pending'"
              class="cd"
            >
              {{ countdownOf(row as ActivityDisplay) }}
            </b>
            <span
              v-else
              class="cd muted"
            >—</span>
          </template>
        </el-table-column>
        <el-table-column
          label="操作"
          width="200"
          fixed="right"
          align="center"
        >
          <!-- el-table 插槽的 row 是 DefaultRow，这里统一断言成真实的业务类型 -->
          <template #default="{ row }">
            <div class="row-ops">
              <el-button
                v-if="(row as ActivityDisplay).config.enabled"
                text
                type="warning"
                size="small"
                @click.stop="onToggleActivity(row as ActivityDisplay, false)"
              >
                下架
              </el-button>
              <el-button
                v-else
                text
                type="success"
                size="small"
                @click.stop="onToggleActivity(row as ActivityDisplay, true)"
              >
                上架
              </el-button>
              <el-button
                text
                type="primary"
                size="small"
                @click.stop="openEditActivity(row as ActivityDisplay)"
              >
                编辑
              </el-button>
              <el-button
                text
                size="small"
                @click.stop="onDuplicateActivity(row as ActivityDisplay)"
              >
                复制
              </el-button>
              <el-button
                text
                type="danger"
                size="small"
                @click.stop="onRemoveActivity(row as ActivityDisplay)"
              >
                删除
              </el-button>
            </div>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 选中活动详情：生命周期 + 一键上下架 -->
    <div class="activity-wrap">
      <div class="activity-head">
        <div class="head-left">
          <span
            class="act-icon"
            aria-hidden="true"
          >{{ activityDisplay.config.icon || '🎯' }}</span>
          <div>
            <h4>{{ activityDisplay.config.title || '（暂无活动）' }}</h4>
            <p class="act-sub">
              {{ activityDisplay.config.subtitle || '点击上方任一活动行，可查看并调整它的生命周期' }}
            </p>
          </div>
        </div>
        <el-tag
          :type="activityTagType"
          effect="light"
          size="large"
          class="state-tag"
        >
          {{ activityStateLabel }}
        </el-tag>
      </div>

      <div class="activity-meta">
        <div class="meta-item">
          <span>活动 ID</span><b>{{ activityDisplay.config.id || '—' }}</b>
        </div>
        <div class="meta-item">
          <span>开始时间</span><b>{{ fmtDate(activityDisplay.config.startAt) }}</b>
        </div>
        <div class="meta-item">
          <span>持续天数</span><b>{{ activityDisplay.config.durationDays }} 天</b>
        </div>
        <div class="meta-item">
          <span>到期时间</span><b>{{ fmtDate(activityDisplay.expiresAt) }}</b>
        </div>
        <div class="meta-item">
          <span>优先级</span><b>{{ activityDisplay.config.priority }}</b>
        </div>
        <div
          v-if="isLive"
          class="meta-item highlight"
        >
          <span>{{ activityDisplay.state === 'pending' ? '距开始' : '限时剩余' }}</span>
          <b class="cd">{{ activityCd }}</b>
        </div>
        <div
          v-else
          class="meta-item"
        >
          <span>生命周期</span>
          <b>{{ activityDisplay.state === 'expired' ? '已自然到期' : '已被下架' }}</b>
        </div>
        <div
          v-if="activityDisplay.config.cancelledAt"
          class="meta-item danger"
        >
          <span>取消于</span>
          <b>{{ fmtDate(activityDisplay.config.cancelledAt) }} · {{ activityDisplay.config.cancelledBy || 'admin' }}</b>
        </div>
      </div>

      <div
        v-if="activityDisplay.config.highlights.length"
        class="activity-highlights"
      >
        <span class="hl-label">前台展示的卖点标签</span>
        <ul>
          <li
            v-for="h in activityDisplay.config.highlights"
            :key="h"
          >
            {{ h }}
          </li>
        </ul>
      </div>

      <!--
        让利声明公示：后台必须能一眼看出「这条活动到底承诺了什么折扣、谁掏钱」，
        否则运营改完文案就无法自查是否夸大。
      -->
      <div class="activity-claims">
        <span class="hl-label">
          让利声明
          <span
            class="fund-badge"
            :class="`is-${activityDisplay.config.fundSource}`"
          >
            {{ FUND_SOURCE_LABEL[activityDisplay.config.fundSource] }}
          </span>
        </span>
        <ul v-if="activityDisplay.config.claims.length">
          <li
            v-for="c in activityDisplay.config.claims"
            :key="c.categoryId"
          >
            {{ categoryName(c.categoryId) }} 最低
            <b>{{ Math.round(c.rate * 100) / 10 }} 折</b>
          </li>
        </ul>
        <p
          v-else
          class="claims-empty"
        >
          未声明任何让利 —— 本活动只做展示与曝光，不会改动任何商品价格
        </p>
      </div>

      <div class="activity-actions">
        <template v-if="activityDisplay.config.enabled">
          <el-button
            type="danger"
            plain
            @click="onCancelActivity"
          >
            提前结束活动
          </el-button>
          <!-- 多活动模型下说「Banner 立即消失」是错的：只要还有别的活动在跑，前台就会切过去 -->
          <span class="act-tip">下架后该活动的让利声明立即失效；若还有其他活动在跑，前台 Banner 会切到下一个</span>
        </template>
        <template v-else>
          <el-input-number
            v-model="restartDays"
            :min="1"
            :max="365"
          />
          <el-button
            type="primary"
            @click="onRestartActivity"
          >
            开启新活动（{{ restartDays }} 天）
          </el-button>
          <span class="act-tip">倒计时将从现在起重新计算</span>
        </template>
      </div>

      <el-alert
        v-if="!activityDisplay.config.enabled"
        type="warning"
        :closable="false"
        show-icon
        title="该活动当前未上架 · 前台不会展示"
        description="点击上方「开启新活动」可立刻上架，前台会重新出现该活动的 Banner 与倒计时。"
        class="act-alert"
      />
    </div>

    <!-- ============ 新建 / 编辑活动 ============ -->
    <el-dialog
      v-model="dlgVisible"
      :title="editingId ? '编辑活动' : '新建活动'"
      width="660px"
      append-to-body
      @closed="releaseOverlayFocus"
    >
      <el-form
        :model="form"
        label-width="104px"
        class="act-form"
      >
        <el-form-item
          label="活动标题"
          required
        >
          <el-input
            v-model="form.title"
            maxlength="40"
            show-word-limit
            placeholder="例如：开学季特卖：教材 5 折起"
          />
        </el-form-item>
        <el-form-item label="活动副标题">
          <el-input
            v-model="form.subtitle"
            maxlength="60"
            show-word-limit
            placeholder="一句话导引，展示在标题下方"
          />
        </el-form-item>

        <div class="form-row">
          <el-form-item
            label="图标"
            class="row-1"
          >
            <el-input
              v-model="form.icon"
              maxlength="2"
              placeholder="🎓"
            />
          </el-form-item>
          <el-form-item
            label="配色主题"
            class="row-2"
          >
            <el-select
          :teleported="false"
              v-model="form.theme"
              style="width: 100%"
            >
              <el-option
                v-for="(meta, key) in ACTIVITY_THEME_META"
                :key="key"
                :label="meta.label"
                :value="key"
              >
                <span
                  class="opt-dot"
                  :style="{ background: meta.color }"
                />{{ meta.label }}
              </el-option>
            </el-select>
          </el-form-item>
          <el-form-item
            label="优先级"
            class="row-2"
          >
            <el-input-number
              v-model="form.priority"
              :min="0"
              :max="999"
              controls-position="right"
              style="width: 100%"
            />
          </el-form-item>
        </div>

        <div class="form-row">
          <el-form-item
            label="开始时间"
            class="row-2"
          >
            <el-date-picker
              :teleported="false"
              v-model="form.startAtText"
              type="datetime"
              value-format="YYYY-MM-DD HH:mm:ss"
              placeholder="选择开始时间"
              style="width: 100%"
            />
          </el-form-item>
          <el-form-item
            label="持续天数"
            class="row-2"
          >
            <el-input-number
              v-model="form.durationDays"
              :min="1"
              :max="365"
              controls-position="right"
              style="width: 100%"
            />
          </el-form-item>
        </div>

        <el-form-item label="卖点标签">
          <el-input
            v-model="form.highlightsText"
            placeholder="用「、」或逗号分隔，最多 6 个，例如：教材 5 折起、免费包邮"
          />
        </el-form-item>

        <!--
          ============ 让利的钱谁出 ============
          C2C 平台的商品属于卖家，平台无权单方改价。
          所以任何折扣都必须先回答「这笔差价由谁承担」，
          否则就是替卖家做主或替平台揽功——两者都不允许上线。
        -->
        <el-form-item
          label="资金来源"
          required
        >
          <el-radio-group v-model="form.fundSource">
            <el-radio-button :label="'seller'">
              卖家让利
            </el-radio-button>
            <el-radio-button :label="'platform'">
              平台补贴
            </el-radio-button>
          </el-radio-group>
          <p class="claim-hint">
            {{ FUND_SOURCE_HINT[form.fundSource] }}
          </p>
        </el-form-item>

        <!--
          ============ 让利声明 ============
          文案里写「5 折起」是不够的：必须结构化声明「哪个分类、最低几折」。
          这段声明就是前台折扣的依据，也是 promo.spec.ts 用来核对商品数据的输入。
          留空 = 本活动只做曝光，不改动任何商品价格。
        -->
        <el-form-item label="让利声明">
          <div class="claim-box">
            <div
              v-if="!form.claims.length"
              class="claim-empty"
            >
              未声明任何让利 —— 本活动只做展示与曝光，不会改动任何商品价格
            </div>
            <div
              v-for="(c, i) in form.claims"
              :key="i"
              class="claim-row"
            >
              <el-select
          :teleported="false"
                v-model="c.categoryId"
                class="claim-cat"
                placeholder="选择分类"
              >
                <el-option
                  v-for="cat in categories"
                  :key="cat.id"
                  :label="`${cat.icon} ${cat.name}`"
                  :value="cat.id"
                />
              </el-select>
              <el-input-number
                v-model="c.zhe"
                :min="0.1"
                :max="9.9"
                :step="0.5"
                :precision="1"
                class="claim-zhe"
              />
              <span class="claim-unit">折起</span>
              <el-button
                text
                type="danger"
                @click="removeClaim(i)"
              >
                删除
              </el-button>
            </div>
            <div class="claim-ops">
              <el-button
                text
                type="primary"
                @click="addClaim"
              >
                + 添加让利分类
              </el-button>
              <span class="claim-note">「N 折起」= 该分类最低价 = 挂牌价 × N/10</span>
            </div>
          </div>
        </el-form-item>

        <!-- 文案喊了折扣却没有对应声明时提前预警，不做事后补救 -->
        <el-alert
          v-if="discountCopyWarning"
          type="warning"
          :closable="false"
          show-icon
          :title="discountCopyWarning"
          class="claim-alert"
        />

        <div class="form-row">
          <el-form-item
            label="按钮文案"
            class="row-2"
          >
            <el-input
              v-model="form.ctaText"
              maxlength="8"
              placeholder="立即参与"
            />
          </el-form-item>
          <el-form-item
            label="跳转链接"
            class="row-3"
            required
          >
            <el-input
              v-model="form.ctaLink"
              placeholder="/goods?categoryId=1"
            />
          </el-form-item>
        </div>

        <el-form-item label="后台备注">
          <el-input
            v-model="form.note"
            maxlength="40"
            placeholder="仅管理端可见，例如：等主推活动结束后再上架"
          />
        </el-form-item>

        <el-form-item label="保存后">
          <el-radio-group v-model="form.enabled">
            <el-radio-button :label="true">
              立即上架
            </el-radio-button>
            <el-radio-button :label="false">
              先存为草稿（不展示）
            </el-radio-button>
          </el-radio-group>
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="dlgVisible = false">
          取消
        </el-button>
        <el-button
          type="primary"
          @click="onSubmitActivity"
        >
          保存
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, nextTick, onActivated, onDeactivated, ref } from 'vue'
import {
  ACTIVITY_THEME_META,
  activityStateLabel as stateLabel,
  activityStateTag as stateTag,
  createActivity,
  deleteActivity,
  EMPTY_ACTIVITY_DISPLAY,
  fetchActivities,
  formatCountdown,
  resetActivities,
  setActivityEnabled,
  updateActivity
} from '@/api/activity'
import type { ActivityDiscountClaim, ActivityDisplay, ActivityInput, ActivityTheme } from '@/api/activity'
import { fetchCategories } from '@/api/goods'
import { DEFAULT_ACTIVITY_DAYS } from '@/api/mock'
import { FUND_SOURCE_HINT, FUND_SOURCE_LABEL } from '@/utils/promo'
import { releaseOverlayFocus } from '@/utils/focus'
import type { Category, FundSource } from '@/types'
import { ADMIN_CONTEXT } from '../adminContext'

const admin = inject(ADMIN_CONTEXT)

const activityLoading = ref(false)
const activityList = ref<ActivityDisplay[]>([])
/** 详情面板当前展示的活动（默认选中列表首位 = 优先级最高的活动） */
const activityDisplay = ref<ActivityDisplay>(EMPTY_ACTIVITY_DISPLAY)
const activityTableRef = ref<{ setCurrentRow: (row: ActivityDisplay) => void }>()
const activeCount = computed(() => activityList.value.filter((d) => d.state === 'active').length)
const pendingCount = computed(() => activityList.value.filter((d) => d.state === 'pending').length)
const isLive = computed(() => activityDisplay.value.state === 'active' || activityDisplay.value.state === 'pending')

const restartDays = ref(DEFAULT_ACTIVITY_DAYS)
const nowTick = ref(Date.now())
/** 让利声明里选分类用 */
const categories = ref<Category[]>([])
let activityTimer: ReturnType<typeof setInterval> | null = null
/** 1 秒一跳的计数，用来凑满 30 秒刷一次列表 —— 见 onActivated 的说明 */
let activityTicks = 0

/** 倒计时基准：待开始看「距开始」，进行中看「限时剩余」 */
function remainingBase(d: ActivityDisplay): number {
  return d.state === 'pending' ? d.config.startAt : d.expiresAt
}
function countdownOf(d: ActivityDisplay): string {
  return formatCountdown(Math.max(0, remainingBase(d) - nowTick.value))
}
const activityCd = computed(() => countdownOf(activityDisplay.value))

const activityTagType = computed(() => stateTag(activityDisplay.value.state))
const activityStateLabel = computed(() => stateLabel(activityDisplay.value.state))

function themeColor(theme: ActivityTheme): string {
  return ACTIVITY_THEME_META[theme]?.color ?? '#ff6a00'
}
function themeLabel(theme: ActivityTheme): string {
  return ACTIVITY_THEME_META[theme]?.label ?? theme
}

function fmtDate(ts?: number) {
  if (!ts) return '—'
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function tsToText(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

async function loadActivities() {
  activityLoading.value = true
  try {
    const list = await fetchActivities()
    activityList.value = list
    // 尽量保持当前选中项；列表为空或选中项已被删除时回落到首位（优先级最高者）
    const keep = list.find((d) => d.config.id === activityDisplay.value.config.id)
    activityDisplay.value = keep ?? list[0] ?? EMPTY_ACTIVITY_DISPLAY
    nowTick.value = Date.now()
    await nextTick()
    if (activityDisplay.value.config.id && activityTableRef.value) {
      activityTableRef.value.setCurrentRow(activityDisplay.value)
    }
  } finally {
    activityLoading.value = false
  }
}

/** 表格行选中（el-table 的 current-change 回调签名只保证是 DefaultRow） */
function onSelectActivity(row: unknown) {
  if (!row) return
  activityDisplay.value = row as ActivityDisplay
  nowTick.value = Date.now()
}

/** 详情面板：提前结束（下架）当前活动 */
async function onCancelActivity() {
  const cfg = activityDisplay.value.config
  if (!cfg.id) return
  try {
    await ElMessageBox.confirm(
      `确认提前结束「${cfg.title}」？该活动的让利声明将立即失效，相关商品价格回到挂牌价。`,
      '提示',
      { type: 'warning' }
    )
  } catch {
    return
  }
  await setActivityEnabled(cfg.id, false, 'admin')
  await loadActivities()
  ElMessage.success('已结束活动')
  admin?.refreshOverview()
}

/** 详情面板：重新开启当前活动（倒计时从现在重新计算） */
async function onRestartActivity() {
  const cfg = activityDisplay.value.config
  if (!cfg.id) return
  const days = restartDays.value || DEFAULT_ACTIVITY_DAYS
  await updateActivity(cfg.id, {
    enabled: true,
    startAt: Date.now(),
    durationDays: days,
    cancelledAt: undefined,
    cancelledBy: undefined
  })
  await loadActivities()
  ElMessage.success(`已重新开启 ${days} 天活动`)
  admin?.refreshOverview()
}

/** 表格行：上架 / 下架 */
async function onToggleActivity(row: ActivityDisplay, enabled: boolean) {
  if (!enabled) {
    try {
      await ElMessageBox.confirm(
        `确认下架「${row.config.title}」？该活动的让利声明将立即失效；若还有其他活动在跑，前台 Banner 会切到下一个。`,
        '提示',
        { type: 'warning' }
      )
    } catch {
      return
    }
  }
  await setActivityEnabled(row.config.id, enabled, 'admin')
  ElMessage.success(enabled ? '已上架' : '已下架')
  await loadActivities()
  admin?.refreshOverview()
}

/** 表格行：复制一个活动（默认存为草稿，优先级略低，避免抢占主推位） */
async function onDuplicateActivity(row: ActivityDisplay) {
  await createActivity({
    title: `${row.config.title}（副本）`,
    subtitle: row.config.subtitle,
    ctaText: row.config.ctaText,
    ctaLink: row.config.ctaLink,
    highlights: [...row.config.highlights],
    icon: row.config.icon,
    theme: row.config.theme,
    priority: Math.max(0, row.config.priority - 10),
    durationDays: row.config.durationDays,
    startAt: Date.now(),
    enabled: false,
    // 让利归属与声明必须一起复制：只复制文案的话，副本就是一条「喊了折扣却没依据」的假活动
    fundSource: row.config.fundSource,
    claims: row.config.claims.map((c) => ({ ...c })),
    note: `由「${row.config.title}」复制而来`
  })
  ElMessage.success('已复制为草稿')
  await loadActivities()
  admin?.refreshOverview()
}

async function onRemoveActivity(row: ActivityDisplay) {
  try {
    await ElMessageBox.confirm(`删除后不可恢复，确认删除「${row.config.title}」？`, '危险操作', { type: 'error' })
  } catch {
    return
  }
  await deleteActivity(row.config.id)
  ElMessage.success('已删除')
  await loadActivities()
  admin?.refreshOverview()
}

async function onResetActivities() {
  try {
    await ElMessageBox.confirm('恢复出厂将清除本地对活动的全部改动（新建 / 编辑 / 上下架记录），确定继续？', '危险操作', {
      type: 'error'
    })
  } catch {
    return
  }
  await resetActivities()
  ElMessage.success('已恢复出厂活动')
  activityDisplay.value = EMPTY_ACTIVITY_DISPLAY
  await loadActivities()
  admin?.refreshOverview()
}

/* ============ 新建 / 编辑活动弹窗 ============ */
/**
 * 让利声明的一行（表单态）。
 * 对外数据结构用 `rate`（0.5 = 5 折），但运营脑子里想的是「几折」，
 * 所以表单里存 `zhe`（5），提交时再换算，避免运营填 0.5 却以为是 5 折。
 */
interface ClaimRow {
  categoryId: number
  zhe: number
}

interface ActivityFormModel {
  title: string
  subtitle: string
  icon: string
  theme: ActivityTheme
  priority: number
  durationDays: number
  startAtText: string
  ctaText: string
  ctaLink: string
  highlightsText: string
  note: string
  enabled: boolean
  /** 让利的钱谁出 —— 必填，不允许含糊 */
  fundSource: FundSource
  /** 对外声明的让利清单；留空表示本活动不改动任何商品价格 */
  claims: ClaimRow[]
}

const dlgVisible = ref(false)
/** 非空表示编辑中，空串表示新建 */
const editingId = ref('')
const form = ref<ActivityFormModel>(blankForm())

function blankForm(): ActivityFormModel {
  return {
    title: '',
    subtitle: '',
    icon: '🎯',
    theme: 'orange',
    priority: 50,
    durationDays: DEFAULT_ACTIVITY_DAYS,
    startAtText: tsToText(Date.now()),
    ctaText: '立即参与',
    ctaLink: '/goods',
    highlightsText: '',
    note: '',
    enabled: true,
    fundSource: 'seller',
    claims: []
  }
}

/* ============ 让利声明的表单操作 ============ */
function addClaim() {
  form.value.claims.push({ categoryId: categories.value[0]?.id ?? 1, zhe: 5 })
}

function removeClaim(i: number) {
  form.value.claims.splice(i, 1)
}

/** 让利声明是否与文案自洽：文案写了「N 折」就必须有对应声明 */
const discountCopyWarning = computed(() => {
  const f = form.value
  const copy = `${f.title} ${f.subtitle} ${f.highlightsText}`
  const mentioned = new Set(
    [...copy.matchAll(/(\d+(?:\.\d+)?)\s*折/g)].map((m) => Number(m[1]))
  )
  if (!mentioned.size) return ''
  const declared = new Set(f.claims.map((c) => c.zhe))
  const missing = [...mentioned].filter((z) => !declared.has(z))
  if (!missing.length) return ''
  return `文案里提到了 ${missing.join(' / ')} 折，但下方「让利声明」里没有对应条目——保存后前台会出现「承诺了却没有依据」的折扣。`
})

function openCreateActivity() {
  editingId.value = ''
  form.value = blankForm()
  dlgVisible.value = true
}

function openEditActivity(row: ActivityDisplay) {
  editingId.value = row.config.id
  form.value = {
    title: row.config.title,
    subtitle: row.config.subtitle,
    icon: row.config.icon,
    theme: row.config.theme,
    priority: row.config.priority,
    durationDays: row.config.durationDays,
    startAtText: tsToText(row.config.startAt),
    ctaText: row.config.ctaText,
    ctaLink: row.config.ctaLink,
    highlightsText: row.config.highlights.join('、'),
    note: row.config.note ?? '',
    enabled: row.config.enabled,
    fundSource: row.config.fundSource,
    // rate → 「几折」：0.5 → 5，0.85 → 8.5，用 round 消掉浮点尾巴
    claims: row.config.claims.map((c) => ({ categoryId: c.categoryId, zhe: Math.round(c.rate * 100) / 10 }))
  }
  dlgVisible.value = true
}

/** 分类名（让利声明列表里展示，比裸 id 友好） */
function categoryName(id: number): string {
  return categories.value.find((c) => c.id === id)?.name ?? `分类 ${id}`
}

async function onSubmitActivity() {
  const f = form.value
  if (!f.title.trim()) {
    ElMessage.warning('请填写活动标题')
    return
  }
  if (!f.ctaLink.trim()) {
    ElMessage.warning('请填写跳转链接')
    return
  }
  const startAt = new Date(f.startAtText.replace(' ', 'T')).getTime()
  if (!Number.isFinite(startAt)) {
    ElMessage.warning('请选择有效的开始时间')
    return
  }

  /*
   * 让利声明是「对外的价格承诺」，脏数据必须挡在保存之前：
   *   - 折扣必须落在 (0,10) 折之间（0 折 = 白送、10 折 = 没打折，都不该出现在声明里）
   *   - 同一分类只能声明一次，否则按哪个力度执行说不清
   * 这两个校验对应 promo.spec.ts 里「活动配置自洽性」那组断言。
   */
  const claims: ActivityDiscountClaim[] = []
  const seen = new Set<number>()
  for (const c of f.claims) {
    if (!(c.zhe > 0 && c.zhe < 10)) {
      ElMessage.warning('让利折扣需在 0～10 折之间（不含 0 折和 10 折）')
      return
    }
    if (seen.has(c.categoryId)) {
      ElMessage.warning(`「${categoryName(c.categoryId)}」重复声明了让利折扣，请合并为一条`)
      return
    }
    seen.add(c.categoryId)
    claims.push({ categoryId: c.categoryId, rate: Math.round((c.zhe / 10) * 1000) / 1000 })
  }

  // 文案喊了折扣却没有声明 → 就是虚假宣传，直接拦下
  if (discountCopyWarning.value) {
    ElMessage.warning(discountCopyWarning.value)
    return
  }

  const payload: ActivityInput = {
    title: f.title.trim(),
    subtitle: f.subtitle.trim(),
    icon: f.icon.trim() || '🎯',
    theme: f.theme,
    priority: f.priority,
    durationDays: f.durationDays,
    startAt,
    ctaText: f.ctaText.trim() || '立即参与',
    ctaLink: f.ctaLink.trim(),
    highlights: f.highlightsText
      .split(/[、,，]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 6),
    note: f.note.trim() || undefined,
    enabled: f.enabled,
    fundSource: f.fundSource,
    claims
  }
  // 从「未上架」改为「上架」时，顺手清掉旧的下架记录，否则详情面板会一直显示「取消于」
  if (f.enabled) {
    payload.cancelledAt = undefined
    payload.cancelledBy = undefined
  }

  if (editingId.value) {
    await updateActivity(editingId.value, payload)
    ElMessage.success('已保存修改')
  } else {
    await createActivity(payload)
    ElMessage.success('活动已创建')
  }
  dlgVisible.value = false
  await loadActivities()
  admin?.refreshOverview()
}

/* 面板被 keep-alive 缓存：只在激活期间跑倒计时与 30s 轮询，
   切走时立刻停表，避免后台空转（也让断言不会读到过期 tick）。 */
onActivated(() => {
  loadActivities()
  // 分类只用于「让利声明」的下拉，加载一次即可
  if (!categories.value.length) {
    fetchCategories().then((list) => (categories.value = list)).catch(() => {})
  }
  activityTicks = 0
  activityTimer = setInterval(() => {
    nowTick.value = Date.now()
    // 每 30 秒刷一次列表。
    //
    // 原实现是 `if (Date.now() % 30_000 < 1100) loadActivities()` —— 借挂钟取模判窗口。
    // 那个写法有两个毛病：标签页被浏览器节流时 tick 间隔会拉长，整轮可能**跳过那个窗口**
    // （表现为「很久不刷新」）；反过来 tick 落在窗口内两次就会连刷两遍。
    // 用计数就没有「窗口」这个概念，既不漏也不重。
    if (++activityTicks >= 30) {
      activityTicks = 0
      loadActivities()
    }
  }, 1000)
})

onDeactivated(() => {
  if (activityTimer) {
    clearInterval(activityTimer)
    activityTimer = null
  }
})
</script>

<style scoped lang="scss">
/* ============================================================
   活动管理
   ============================================================ */
.act-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: $sp-4;
  flex-wrap: wrap;

  &-left {
    display: flex;
    align-items: center;
    gap: $sp-2;
  }
  &-right {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: $fs-13;
    color: var(--color-text-mute);

    b {
      font-size: $fs-15;
      font-weight: $fw-bold;
      color: var(--color-text-primary);
      font-variant-numeric: tabular-nums;
      &.ok {
        color: #059669;
      }
      &.warn {
        color: #d97706;
      }
    }
    .sep {
      width: 1px;
      height: 14px;
      background: var(--border-color-strong);
    }
  }
}

.act-table {
  width: 100%;
}

/* 行内操作按钮：el-button 相邻默认有 12px 外边距，5 个叠起来会换行 ——
   改用 flex + 显式 gap，保证一行放得下且各列对齐 */
.row-ops {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  white-space: nowrap;

  :deep(.el-button) {
    margin-left: 0;
    padding-left: 6px;
    padding-right: 6px;
  }
}

.act-cell {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;

  .theme-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .act-emoji {
    font-size: 18px;
    line-height: 1;
    flex-shrink: 0;
  }
  .act-txt {
    display: flex;
    flex-direction: column;
    min-width: 0;

    b {
      font-size: $fs-13;
      font-weight: $fw-semibold;
      color: var(--color-text-primary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .act-note {
      font-size: $fs-12;
      color: var(--color-text-mute);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }
}

.cd {
  color: $brand-orange;
  font-variant-numeric: tabular-nums;
  &.muted {
    color: var(--color-text-mute);
    font-weight: 400;
  }
}

/* —— 选中活动详情面板 —— */
.activity-wrap {
  padding: 18px 4px 4px;
  max-width: 1080px;
  border-top: 1px dashed var(--border-color);
}

.activity-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: $sp-4;
  flex-wrap: wrap;

  .head-left {
    display: flex;
    align-items: flex-start;
    gap: $sp-3;
    min-width: 0;
  }
  .act-icon {
    width: 44px;
    height: 44px;
    flex-shrink: 0;
    display: grid;
    place-items: center;
    font-size: 22px;
    border-radius: $radius-pill;
    background: var(--bg-soft);
    border: 1px solid var(--border-color);
  }
  h4 {
    font-size: $fs-17;
    font-weight: $fw-bold;
    color: var(--color-text-primary);
    line-height: 1.4;
  }
  .act-sub {
    margin-top: 3px;
    font-size: $fs-13;
    color: var(--color-text-mute);
  }
  .state-tag {
    flex-shrink: 0;
  }
}

.activity-meta {
  margin-top: $sp-4;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 10px;

  .meta-item {
    background: var(--bg-soft);
    border: 1px solid var(--border-color);
    border-radius: $radius-md;
    padding: 10px 14px;
    display: flex;
    flex-direction: column;
    gap: 2px;

    span {
      font-size: $fs-12;
      color: var(--color-text-mute);
    }
    b {
      font-size: $fs-14;
      font-weight: $fw-semibold;
      color: var(--color-text-primary);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }

    &.highlight {
      background: #fff8ef;
      border-color: $brand-orange-line;
      .cd {
        color: $brand-orange;
        font-size: $fs-16;
      }
    }
    &.danger b {
      color: #b91c1c;
    }
  }
}

.activity-highlights {
  margin-top: $sp-4;
  display: flex;
  align-items: center;
  gap: $sp-3;
  flex-wrap: wrap;

  .hl-label {
    font-size: $fs-12;
    color: var(--color-text-mute);
    flex-shrink: 0;
  }
  ul {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    font-size: $fs-12;
    line-height: 1;
    color: #9a5b12;
    background: #fff7ec;
    border: 1px solid $brand-orange-line;
    padding: 5px 10px;
    border-radius: $radius-pill;
  }
}

.activity-actions {
  display: flex;
  align-items: center;
  gap: $sp-3;
  margin-top: $sp-5;
  flex-wrap: wrap;

  .act-tip {
    font-size: $fs-12;
    color: var(--color-text-mute);
  }
}

.act-alert {
  margin-top: $sp-4;
}

/* ============================================================
   让利声明（详情面板公示 + 弹窗编辑器）
   设计意图：让「折扣力度」与「谁掏钱」两件事在后台一眼可见，
   避免运营只改文案、不改数据，最后前台承诺了不存在的折扣。
   ============================================================ */
.activity-claims {
  margin-top: $sp-4;
  display: flex;
  align-items: center;
  gap: $sp-3;
  flex-wrap: wrap;

  .hl-label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: $fs-12;
    color: var(--color-text-mute);
    flex-shrink: 0;
  }
  ul {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    font-size: $fs-12;
    line-height: 1;
    padding: 5px 10px;
    border-radius: $radius-pill;
    background: var(--bg-soft);
    border: 1px solid var(--border-color);
    color: var(--color-text-secondary);

    b {
      color: $brand-orange-deep;
      font-variant-numeric: tabular-nums;
    }
  }
  .claims-empty {
    margin: 0;
    font-size: $fs-12;
    color: $text-4;
  }
}

/* 资金归属徽标：卖家让利=橙、平台补贴=蓝，与前台 Banner 保持一致 */
.fund-badge {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 7px;
  border-radius: $radius-pill;
  font-size: $fs-11;
  font-weight: $fw-semibold;
  line-height: 1;
  color: #fff;
  background: $brand-orange;

  &.is-platform {
    background: $color-primary;
  }
}

/* —— 弹窗内的让利声明编辑器 —— */
.claim-hint {
  margin: 6px 0 0;
  font-size: $fs-12;
  color: var(--color-text-mute);
  line-height: 1.6;
}

.claim-box {
  width: 100%;
  padding: 12px;
  border: 1px solid var(--border-color);
  border-radius: $radius-sm;
  background: var(--bg-soft);
}

.claim-empty {
  font-size: $fs-12;
  color: $text-4;
  line-height: 1.6;
}

.claim-row {
  display: flex;
  align-items: center;
  gap: $sp-2;
  margin-bottom: 8px;

  .claim-cat {
    flex: 1 1 auto;
    min-width: 0;
  }
  .claim-zhe {
    flex: 0 0 120px;
  }
  .claim-unit {
    font-size: $fs-12;
    color: var(--color-text-mute);
    flex-shrink: 0;
  }
}

.claim-ops {
  display: flex;
  align-items: center;
  gap: $sp-3;
  flex-wrap: wrap;

  .claim-note {
    font-size: $fs-11;
    color: $text-4;
  }
}

.claim-alert {
  margin-bottom: $sp-3;
}

/* —— 新建 / 编辑弹窗 —— */
.act-form {
  .form-row {
    display: flex;
    gap: $sp-3;

    .row-1 {
      flex: 0 0 96px;
      :deep(.el-form-item__label) {
        width: 62px !important;
      }
    }
    .row-2 {
      flex: 1 1 0;
      min-width: 0;
    }
    .row-3 {
      flex: 2 1 0;
      min-width: 0;
    }
  }
}

.opt-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 6px;
  vertical-align: middle;
}

@media (max-width: $breakpoint-sm) {
  .activity-meta {
    grid-template-columns: minmax(0, 1fr);
  }
  .activity-actions .act-tip {
    width: 100%;
  }
  .act-form .form-row {
    flex-direction: column;
    gap: 0;
  }
}
</style>
