<template>
  <div class="adm-pane">
    <div class="adm-card">
      <div class="adm-card-head">
        <span class="adm-card-title">用户管理</span>
        <span class="adm-card-hint">
          共 {{ overview?.userTotal ?? 0 }} 位 · 封禁
          <b class="is-danger">{{ overview?.bannedUsers ?? 0 }}</b>
        </span>
      </div>

      <div class="adm-card-body">
        <div class="adm-toolbar">
          <div class="adm-toolbar-left">
            <el-input
              v-model="kw"
              class="adm-input"
              placeholder="搜索昵称 / 用户名"
              clearable
              @input="onSearchInput"
              @clear="reload"
              @keyup.enter="reload"
            />
            <el-select
          :teleported="false"
              v-model="status"
              class="adm-select"
              clearable
              placeholder="全部状态"
              @change="onFilterChange"
            >
              <el-option
                label="正常"
                value="active"
              />
              <el-option
                label="已封禁"
                value="banned"
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
          已选 <b>{{ selected.length }}</b> 位用户
          <div class="adm-batch-ops">
            <el-button
              size="small"
              type="success"
              plain
              @click="onBatchBan(false)"
            >
              批量解封
            </el-button>
            <el-button
              size="small"
              type="danger"
              plain
              @click="onBatchBan(true)"
            >
              批量封禁
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
          :data="users"
          row-key="id"
          style="width: 100%"
          empty-text="没有符合条件的用户"
          :row-class-name="rowClassName"
          @selection-change="onSelectionChange"
        >
          <el-table-column
            type="selection"
            width="46"
            :selectable="isSelectable"
          />
          <el-table-column
            prop="id"
            label="ID"
            width="56"
            align="center"
          />
          <el-table-column
            label="用户"
            min-width="240"
          >
            <template #default="{ row }">
              <div class="adm-media">
                <el-avatar
                  :src="(row as User).avatar"
                  :size="34"
                />
                <div class="adm-media-txt">
                  <span class="adm-ellipsis adm-strong">
                    <router-link
                      :to="`/user/${(row as User).id}`"
                      class="up-link"
                      :title="`查看 ${(row as User).nickname} 的主页`"
                    >
                      {{ (row as User).nickname }}
                    </router-link>
                    <el-tag
                      v-if="(row as User).role === 'admin'"
                      type="danger"
                      size="small"
                      effect="plain"
                    >
                      管理员
                    </el-tag>
                  </span>
                  <span class="adm-sub">{{ (row as User).username }}</span>
                </div>
              </div>
            </template>
          </el-table-column>
          <el-table-column
            label="信用分"
            width="104"
            align="center"
          >
            <template #default="{ row }">
              <el-tag
                :type="creditTag((row as User).creditScore)"
                effect="light"
                size="small"
              >
                {{ (row as User).creditScore }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column
            label="状态"
            width="96"
            align="center"
          >
            <template #default="{ row }">
              <el-tag
                :type="statusTag((row as User).status)"
                effect="light"
                size="small"
              >
                {{ STATUS_LABEL[(row as User).status] }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column
            label="注册时间"
            width="146"
          >
            <template #default="{ row }">
              <span class="adm-num adm-muted">
                {{ formatDate((row as User).createTime, 'YYYY-MM-DD HH:mm') }}
              </span>
            </template>
          </el-table-column>
          <el-table-column
            label="操作"
            width="212"
            fixed="right"
            align="center"
          >
            <template #default="{ row }">
              <div class="adm-row-ops">
                <el-button
                  text
                  type="primary"
                  size="small"
                  @click="onAdjustCredit(row as User)"
                >
                  调信用分
                </el-button>
                <el-button
                  v-if="(row as User).role !== 'admin'"
                  :type="(row as User).status === 'active' ? 'danger' : 'success'"
                  text
                  size="small"
                  @click="onToggleBan(row as User, (row as User).status !== 'banned')"
                >
                  {{ (row as User).status === 'banned' ? '解封' : '封禁' }}
                </el-button>
                <el-dropdown
                  trigger="click"
                  :teleported="false"
                  @command="(cmd: string) => onMoreCommand(cmd, row as User)"
                >
                  <el-button
                    text
                    type="primary"
                    size="small"
                    class="adm-more-btn"
                  >
                    更多<el-icon class="el-icon--right">
                      <ArrowDown />
                    </el-icon>
                  </el-button>
                  <template #dropdown>
                    <el-dropdown-menu>
                      <el-dropdown-item command="profile">
                        查看主页
                      </el-dropdown-item>
                      <el-dropdown-item
                        v-if="(row as User).role !== 'admin'"
                        command="warn"
                      >
                        发送警告
                      </el-dropdown-item>
                      <el-dropdown-item
                        v-if="(row as User).role !== 'admin'"
                        command="resetPwd"
                        divided
                      >
                        重置密码
                      </el-dropdown-item>
                    </el-dropdown-menu>
                  </template>
                </el-dropdown>
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
  </div>
</template>

<script setup lang="ts">
import { computed, inject, onActivated, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  batchToggleUserStatus,
  fetchUsers,
  resetUserPassword,
  setUserCredit,
  toggleUserStatus,
  warnUser
} from '@/api/user'
import { formatDate } from '@/utils/format'
import type { User } from '@/types'
import { ADMIN_CONTEXT } from '../adminContext'

const admin = inject(ADMIN_CONTEXT)
const overview = computed(() => admin?.overview.value ?? null)
const router = useRouter()

const STATUS_LABEL: Record<User['status'], string> = {
  active: '正常',
  banned: '已封禁'
}

const users = ref<User[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(10)
const kw = ref('')
// 默认筛「正常」：用户待审核态已随 D11 拆除（2026-09-23），不再有待办队列，默认展示在册用户
const status = ref('active')
const loading = ref(false)
const selected = ref<User[]>([])
const tableRef = ref<{ clearSelection: () => void }>()

/** 超管不允许被勾选，避免「批量封禁把自己封了」 */
function isSelectable(row: unknown): boolean {
  return (row as User).role !== 'admin'
}

function creditTag(score: number): 'success' | 'warning' | 'danger' {
  if (score >= 90) return 'success'
  if (score >= 60) return 'warning'
  return 'danger'
}

function statusTag(s: User['status']): 'success' | 'warning' | 'danger' {
  return ({ active: 'success', banned: 'danger' } as const)[s]
}

let searchTimer: ReturnType<typeof setTimeout> | null = null
function onSearchInput() {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    page.value = 1
    reload()
  }, 300)
}
onUnmounted(() => {
  if (searchTimer) clearTimeout(searchTimer)
})

function onFilterChange() {
  page.value = 1
  reload()
}

function onSelectionChange(list: unknown[]) {
  selected.value = list as User[]
}

function clearSelection() {
  tableRef.value?.clearSelection()
  selected.value = []
}

async function reload() {
  loading.value = true
  try {
    const r = await fetchUsers({
      page: page.value,
      pageSize: pageSize.value,
      keyword: kw.value,
      status: status.value || undefined
    })
    users.value = r.list
    total.value = r.total
    clearSelection()
  } finally {
    loading.value = false
  }
}

async function onToggleBan(row: User, banned: boolean) {
  const verb = banned ? '封禁' : '解封'
  try {
    await ElMessageBox.confirm(`确认${verb}「${row.nickname}」？${banned ? '封禁后该用户无法登录与交易。' : ''}`, verb, {
      type: banned ? 'warning' : 'info'
    })
  } catch {
    return
  }
  await toggleUserStatus({ id: row.id, banned })
  ElMessage.success(`${verb}成功`)
  await Promise.all([reload(), admin?.refreshOverview()])
}

async function onBatchBan(banned: boolean) {
  const ids = selected.value.map((u) => u.id)
  if (!ids.length) return
  const verb = banned ? '封禁' : '解封'
  try {
    await ElMessageBox.confirm(`确认批量${verb}选中的 ${ids.length} 位用户？`, `批量${verb}`, {
      type: banned ? 'warning' : 'info'
    })
  } catch {
    return
  }
  const n = await batchToggleUserStatus(ids, banned)
  ElMessage.success(`已${verb} ${n} 位用户`)
  await Promise.all([reload(), admin?.refreshOverview()])
}

async function onAdjustCredit(row: User) {
  const before = row.creditScore
  let input: string
  try {
    /*
     * 让管理员填「目标分值」而不是「增量」。
     *
     * 增量语义是「调整后看不见变化」的元凶：默认 +5，
     * 而 13 位种子用户里有 3 位已经是 100 分上限 —— 100 + 5 被夹回 100，
     * 提示语说「已更新为 100」，表格也还是 100，看起来就像「改了没反应」。
     * 直接填目标值，结果与输入一一对应，不存在这种解释空间。
     */
    const r = await ElMessageBox.prompt(
      `设置「${row.nickname}」的信用分（当前 ${before}，可填 0-100 的整数）`,
      '调整信用分',
      {
        inputValue: String(before),
        inputPattern: /^\d{1,3}$/,
        inputErrorMessage: '请输入 0 ~ 100 之间的整数',
        confirmButtonText: '保存'
      }
    )
    input = r.value
  } catch {
    return
  }

  const target = Math.min(100, Math.max(0, Math.round(Number(input))))
  if (target === before) {
    ElMessage.info(`信用分保持 ${before}，未发生变化`)
    return
  }

  const updated = await setUserCredit({ id: row.id, value: target })
  /*
   * 先就地改当前行，再拉列表：
   * 列表是异步的，用户点完「保存」立刻扫表格，这一眼必须已经是对的。
   */
  const i = users.value.findIndex((u) => u.id === row.id)
  if (i > -1) users.value[i] = { ...users.value[i], creditScore: updated.creditScore }
  flashRow(row.id)

  if (updated.creditScore !== target) {
    ElMessage.warning(`信用分有效范围 0-100，已夹取为 ${updated.creditScore}`)
  } else {
    // 把「从多少到多少」说清楚，比单说一个新值更容易核对
    ElMessage.success(`信用分已更新：${before} → ${updated.creditScore}`)
  }
  await reload()
}

/** 刚被改过的行闪一下，让「哪一行变了」无需用旧值去比对 */
const flashId = ref<number | null>(null)
let flashTimer: ReturnType<typeof setTimeout> | null = null
function flashRow(id: number) {
  flashId.value = id
  if (flashTimer) clearTimeout(flashTimer)
  flashTimer = setTimeout(() => (flashId.value = null), 1400)
}
function rowClassName({ row }: { row: User }) {
  return flashId.value === row.id ? 'row-flash' : ''
}

/** 「更多」下拉：查看主页 / 通过审核 / 发送警告 / 重置密码 */
async function onMoreCommand(cmd: string, row: User) {
  if (cmd === 'profile') {
    router.push(`/user/${row.id}`)
    return
  }
  if (cmd === 'warn') {
    let reason: string
    try {
      const r = await ElMessageBox.prompt(
        `向「${row.nickname}」发送平台警告（将出现在 TA 的消息中心）`,
        '发送警告',
        {
          inputPlaceholder: '例如：经核实您发布的商品描述与实物不符，请 24 小时内整改',
          inputValidator: (v: string) => (v || '').trim().length >= 5 || '警告说明至少 5 个字',
          confirmButtonText: '发送警告'
        }
      )
      reason = r.value.trim()
    } catch {
      return
    }
    await warnUser(row.id, reason)
    ElMessage.success('警告已发送到对方的消息中心')
    return
  }
  if (cmd === 'resetPwd') {
    try {
      await ElMessageBox.confirm(`确认重置「${row.nickname}」的登录密码？`, '重置密码', {
        type: 'warning',
        confirmButtonText: '确认重置'
      })
    } catch {
      return
    }
    const pwd = await resetUserPassword(row.id)
    ElMessage.success(`密码已重置为 ${pwd}，请通知用户尽快修改`)
  }
}

onActivated(reload)
</script>

<style scoped lang="scss">
.adm-strong .el-tag {
  margin-left: 6px;
  vertical-align: 1px;
}

/* 用户名可点进「他人主页」 */
.up-link {
  color: inherit;
  text-decoration: none;

  &:hover { color: var(--el-color-primary); text-decoration: underline; }
}

.adm-more-btn {
  margin-left: 4px;
}

/*
 * 刚改过的行闪一下橙色底。
 * 信用分是「一个数字变另一个数字」，在满屏数字里最不显眼；
 * 光靠提示语很容易让人怀疑「到底改没改」，给行一个明确的落点。
 */
:deep(.row-flash) td {
  animation: rowFlash 1.4s $ease-out;
}
@keyframes rowFlash {
  0% { background-color: rgba(255, 106, 0, 0.18); }
  100% { background-color: transparent; }
}
</style>
