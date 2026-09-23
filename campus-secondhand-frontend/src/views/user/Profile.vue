<template>
  <div class="profile-page">
    <BackButton />
    <!-- 顶部 Banner 区 -->
    <section class="profile-banner">
      <div class="avatar-wrap">
        <el-avatar
          :src="user.avatar"
          :size="92"
        />
        <el-button
          type="primary"
          size="small"
          class="edit-btn"
          @click="onEditProfile"
        >
          <el-icon><Edit /></el-icon> 编辑资料
        </el-button>
      </div>
      <div class="info">
        <div class="name-row">
          <h2>{{ user.nickname }}</h2>
          <el-tag
            v-if="userStore.isAdmin"
            type="danger"
            size="small"
          >
            管理员
          </el-tag>
          <el-tag
            :type="user.status === 'active' ? 'success' : 'danger'"
            effect="light"
            size="small"
          >
            {{ user.status === 'active' ? '正常' : '已封禁' }}
          </el-tag>
        </div>
        <div class="meta-row">
          <span><el-icon><User /></el-icon> {{ user.username }}</span>
          <span><el-icon><Phone /></el-icon> {{ user.phone || '未设置手机号' }}</span>
          <span><el-icon><Clock /></el-icon> {{ formatRelative(user.createTime) }} 加入</span>
        </div>
        <div class="credit">
          <span>信誉分</span>
          <b class="credit-score">{{ user.creditScore }}</b>
          <el-progress
            :percentage="user.creditScore"
            :show-text="false"
            :stroke-width="6"
            :color="creditGradient"
            style="width: 220px"
          />
          <el-link
            :underline="false"
            type="primary"
            @click="showCreditRule = true"
          >
            查看规则 →
          </el-link>
        </div>
      </div>
    </section>

    <!-- 4 个 KPI 快捷入口 -->
    <section class="kpi-row">
      <div
        class="kpi-item"
        @click="onJumpTab('goods')"
      >
        <span class="label">我发布的</span>
        <b class="value">{{ counts.goods }}</b>
        <el-icon class="arrow">
          <ArrowRight />
        </el-icon>
      </div>
      <div
        class="kpi-item"
        @click="onJumpTab('favorites')"
      >
        <span class="label">我的收藏</span>
        <b class="value">{{ counts.favorites }}</b>
        <el-icon class="arrow">
          <ArrowRight />
        </el-icon>
      </div>
      <div
        class="kpi-item"
        @click="onJumpTab('orders')"
      >
        <span class="label">我的订单</span>
        <b class="value">{{ counts.orders }}</b>
        <el-icon class="arrow">
          <ArrowRight />
        </el-icon>
      </div>
      <div
        class="kpi-item"
        @click="onJumpTab('history')"
      >
        <span class="label">浏览足迹</span>
        <b class="value">{{ counts.history }}</b>
        <el-icon class="arrow">
          <ArrowRight />
        </el-icon>
      </div>
    </section>

    <!-- 主 Tab -->
    <section class="profile-card">
      <el-tabs
        v-model="activeTab"
        class="profile-tabs"
      >
        <!-- Tab 1：我发布的商品 -->
        <el-tab-pane name="goods">
          <template #label>
            <span class="tab-label"><el-icon><Box /></el-icon> 我发布的</span>
          </template>
          <div class="tab-head">
            <el-radio-group
              v-model="goodsStatus"
              @change="loadGoods"
            >
              <el-radio-button label="">
                全部
              </el-radio-button>
              <el-radio-button label="on_sale">
                在售
              </el-radio-button>
              <el-radio-button label="pending">
                审核中
              </el-radio-button>
              <el-radio-button label="sold">
                已售出
              </el-radio-button>
              <el-radio-button label="off_shelf">
                已下架
              </el-radio-button>
            </el-radio-group>
            <el-button
              type="primary"
              plain
              @click="$router.push('/goods/publish')"
            >
              <el-icon><Plus /></el-icon> 发布新商品
            </el-button>
          </div>
          <el-table
            v-loading="loading.goods"
            :data="myGoods"
            empty-text="还没有发布过商品"
          >
            <el-table-column
              label="商品"
              min-width="280"
            >
              <template #default="{ row }">
                <div class="g-cell">
                  <el-image
                    :src="row.cover"
                    fit="cover"
                    class="t-img"
                  />
                  <span>{{ row.title }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column
              label="价格"
              width="120"
              align="center"
            >
              <template #default="{ row }">
                ¥{{ row.price.toFixed(2) }}
              </template>
            </el-table-column>
            <!-- 数量要与发布时填写的一致，卖家才能核对「还剩几件没卖掉」 -->
            <el-table-column
              label="数量"
              width="80"
              align="center"
            >
              <template #default="{ row }">
                <span
                  class="stock-cell"
                  :class="{ 'is-out': resolveStock(row) <= 0 }"
                >
                  {{ resolveStock(row) }}
                </span>
              </template>
            </el-table-column>
            <el-table-column
              label="状态"
              width="100"
              align="center"
            >
              <template #default="{ row }">
                <el-tag
                  :type="goodsStatusTag(row.status)"
                  size="small"
                >
                  {{ goodsStatusLabel(row.status) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column
              label="浏览"
              prop="viewCount"
              width="80"
              align="center"
            />
            <el-table-column
              label="收藏"
              prop="favoriteCount"
              width="80"
              align="center"
            />
            <el-table-column
              label="操作"
              width="220"
              fixed="right"
              align="center"
            >
              <template #default="{ row }">
                <el-button
                  text
                  type="primary"
                  size="small"
                  @click="$router.push(`/goods/${row.id}`)"
                >
                  查看
                </el-button>
                <el-button
                  v-if="row.status === 'on_sale'"
                  text
                  type="warning"
                  size="small"
                  @click="onMyOffline(row)"
                >
                  下架
                </el-button>
                <el-button
                  v-else-if="row.status === 'off_shelf'"
                  text
                  type="success"
                  size="small"
                  @click="onMyOnline(row)"
                >
                  上架
                </el-button>
                <el-button
                  text
                  type="danger"
                  size="small"
                  @click="onMyDelete(row)"
                >
                  删除
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <!-- Tab 2：我的收藏 -->
        <el-tab-pane name="favorites">
          <template #label>
            <span class="tab-label"><el-icon><Star /></el-icon> 我的收藏</span>
          </template>
          <div class="tab-head">
            <span class="hint">共 {{ counts.favorites }} 件收藏</span>
          </div>
          <el-row
            v-loading="loading.favorites"
            :gutter="14"
          >
            <el-col
              v-for="f in favorites"
              :key="f.id"
              :xs="12"
              :sm="8"
              :md="6"
            >
              <div class="fav-card">
                <div
                  class="fav-cover"
                  @click="$router.push(`/goods/${f.goods.id}`)"
                >
                  <el-image
                    :src="f.goods.cover"
                    fit="cover"
                    class="cover-img"
                  />
                  <el-tag
                    v-if="f.goods.status === 'sold'"
                    type="danger"
                    size="small"
                    class="cover-tag"
                  >
                    已售出
                  </el-tag>
                </div>
                <div class="fav-info">
                  <div
                    class="fav-title"
                    :title="f.goods.title"
                  >
                    {{ f.goods.title }}
                  </div>
                  <PriceTag
                    :list-price="f.goods.price"
                    :promo-price="f.goods.promoPrice"
                  />
                  <div class="fav-foot">
                    <span class="muted">{{ f.goods.location }}</span>
                    <el-button
                      text
                      size="small"
                      type="danger"
                      @click="onUnfav(f.goodsId)"
                    >
                      取消
                    </el-button>
                  </div>
                </div>
              </div>
            </el-col>
          </el-row>
          <EmptyState
            v-if="!loading.favorites && favorites.length === 0"
            icon="⭐"
            title="还没有收藏任何商品"
            description="在商品详情页点击收藏即可加入这里"
            action-text="去逛逛"
            @action="$router.push('/goods')"
          />
        </el-tab-pane>

        <!-- Tab 3：我的订单 -->
        <el-tab-pane name="orders">
          <template #label>
            <span class="tab-label"><el-icon><List /></el-icon> 我的订单</span>
          </template>
          <div class="tab-head">
            <el-radio-group
              v-model="orderStatus"
              @change="loadOrders"
            >
              <el-radio-button label="">
                全部
              </el-radio-button>
              <el-radio-button label="pending_payment">
                待付款
              </el-radio-button>
              <el-radio-button label="pending_ship">
                待发货
              </el-radio-button>
              <el-radio-button label="shipped">
                已发货
              </el-radio-button>
              <el-radio-button label="completed">
                已完成
              </el-radio-button>
            </el-radio-group>
          </div>
          <el-table
            v-loading="loading.orders"
            :data="orders"
            empty-text="还没有相关订单"
          >
            <el-table-column
              label="商品"
              min-width="280"
            >
              <template #default="{ row }">
                <div class="g-cell">
                  <el-image
                    :src="row.goods.cover"
                    fit="cover"
                    class="t-img"
                  />
                  <span>{{ row.goods.title }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column
              prop="id"
              label="订单号"
              width="160"
            />
            <el-table-column
              label="金额"
              width="100"
              align="center"
            >
              <template #default="{ row }">
                ¥{{ row.amount.toFixed(2) }}
              </template>
            </el-table-column>
            <el-table-column
              label="状态"
              width="100"
              align="center"
            >
              <template #default="{ row }">
                <el-tag
                  :type="orderTag(row.status)"
                  size="small"
                >
                  {{ orderLabel(row.status) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column
              label="下单时间"
              width="170"
            >
              <template #default="{ row }">
                {{ formatDate(row.createTime, 'YYYY-MM-DD HH:mm') }}
              </template>
            </el-table-column>
            <el-table-column
              label="操作"
              width="120"
              align="center"
              fixed="right"
            >
              <template #default="{ row }">
                <el-button
                  text
                  type="primary"
                  size="small"
                  @click="$router.push('/order')"
                >
                  查看
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <!-- Tab 4：浏览历史 -->
        <el-tab-pane name="history">
          <template #label>
            <span class="tab-label"><el-icon><View /></el-icon> 浏览足迹</span>
          </template>
          <div class="tab-head">
            <span class="hint">共 {{ counts.history }} 条记录，按时间倒序</span>
            <el-button
              text
              type="danger"
              :disabled="counts.history === 0"
              @click="onClearHistory"
            >
              <el-icon><Delete /></el-icon> 清空全部
            </el-button>
          </div>
          <el-table
            v-loading="loading.history"
            :data="history"
            empty-text="还没有浏览过任何商品"
          >
            <el-table-column
              label="商品"
              min-width="320"
            >
              <template #default="{ row }">
                <div
                  class="g-cell"
                  style="cursor:pointer"
                  @click="$router.push(`/goods/${row.goods.id}`)"
                >
                  <el-image
                    :src="row.goods.cover"
                    fit="cover"
                    class="t-img"
                  />
                  <span>{{ row.goods.title }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column
              label="价格"
              width="100"
              align="center"
            >
              <template #default="{ row }">
                ¥{{ row.goods.price.toFixed(2) }}
              </template>
            </el-table-column>
            <el-table-column
              label="卖家"
              prop="goods.sellerName"
              width="120"
            />
            <el-table-column
              label="浏览时间"
              width="170"
            >
              <template #default="{ row }">
                {{ formatRelative(row.viewTime) }}
              </template>
            </el-table-column>
            <el-table-column
              label="操作"
              width="200"
              align="center"
              fixed="right"
            >
              <template #default="{ row }">
                <el-button
                  text
                  type="primary"
                  size="small"
                  @click="$router.push(`/goods/${row.goods.id}`)"
                >
                  再看看
                </el-button>
                <el-button
                  text
                  size="small"
                  @click="onToggleFavFromHistory(row)"
                >
                  <el-icon><Star /></el-icon>
                  {{ isFavorited(row.goodsId) ? '已收藏' : '收藏' }}
                </el-button>
                <el-button
                  text
                  type="danger"
                  size="small"
                  @click="onRemoveHistory(row.id)"
                >
                  删除
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <!-- Tab 5：收货地址 -->
        <el-tab-pane name="address">
          <template #label>
            <span class="tab-label"><el-icon><Location /></el-icon> 收货地址</span>
          </template>
          <div class="tab-head">
            <span class="hint">共 {{ addresses.length }} 个地址，最多保留 5 个</span>
            <el-button
              type="primary"
              plain
              :disabled="addresses.length >= 5"
              @click="onAddressAdd"
            >
              <el-icon><Plus /></el-icon> 新增地址
            </el-button>
          </div>
          <el-row :gutter="14">
            <el-col
              v-for="a in addresses"
              :key="a.id"
              :xs="24"
              :sm="12"
              :md="8"
            >
              <div
                class="addr-card"
                :class="{ 'is-default': a.isDefault }"
              >
                <div class="addr-head">
                  <b>{{ a.receiver }}</b>
                  <span>{{ a.phone }}</span>
                  <el-tag
                    v-if="a.isDefault"
                    type="warning"
                    size="small"
                  >
                    默认
                  </el-tag>
                  <el-tag
                    v-else-if="a.tag"
                    type="info"
                    size="small"
                    effect="plain"
                  >
                    {{ a.tag }}
                  </el-tag>
                </div>
                <p class="addr-addr">
                  {{ a.region }} {{ a.detail }}
                </p>
                <div class="addr-foot">
                  <el-button
                    text
                    size="small"
                    @click="onAddressEdit(a)"
                  >
                    编辑
                  </el-button>
                  <el-button
                    v-if="!a.isDefault"
                    text
                    size="small"
                    type="success"
                    @click="onSetDefault(a)"
                  >
                    设为默认
                  </el-button>
                  <el-button
                    text
                    size="small"
                    type="danger"
                    @click="onAddressDelete(a)"
                  >
                    删除
                  </el-button>
                </div>
              </div>
            </el-col>
          </el-row>
        </el-tab-pane>
      </el-tabs>
    </section>

    <!-- 编辑资料抽屉 -->
    <el-drawer
      v-model="editProfileVisible"
      title="编辑个人资料"
      size="40%"
    >
      <el-form
        :model="profileForm"
        label-width="84px"
        size="large"
      >
        <el-form-item label="昵称">
          <el-input
            v-model="profileForm.nickname"
            maxlength="16"
            show-word-limit
          />
        </el-form-item>
        <el-form-item label="手机号">
          <el-input
            v-model="profileForm.phone"
            placeholder="如：13800138000"
          />
        </el-form-item>
        <el-form-item label="头像 URL">
          <el-input
            v-model="profileForm.avatar"
            placeholder="留空将自动生成"
          />
        </el-form-item>
        <el-button
          type="primary"
          :loading="profileSaving"
          @click="onSaveProfile"
        >
          保存
        </el-button>
        <el-button
          :disabled="profileSaving"
          @click="editProfileVisible = false"
        >
          取消
        </el-button>
      </el-form>
    </el-drawer>

    <!-- 地址编辑抽屉 -->
    <el-drawer
      v-model="addrDrawerVisible"
      :title="addrForm.id ? '编辑地址' : '新增地址'"
      size="40%"
    >
      <el-form
        ref="addrFormRef"
        :model="addrForm"
        :rules="addrRules"
        label-width="84px"
        size="large"
      >
        <el-form-item
          label="收货人"
          prop="receiver"
        >
          <el-input
            v-model="addrForm.receiver"
            maxlength="20"
          />
        </el-form-item>
        <el-form-item
          label="手机号"
          prop="phone"
        >
          <el-input
            v-model="addrForm.phone"
            placeholder="如：13800138000"
            maxlength="13"
          />
        </el-form-item>
        <el-form-item
          label="所在地区"
          required
        >
          <el-cascader
            :teleported="false"
            v-model="cascaderValue"
            :options="regionOptions"
            placeholder="请选择省/市/区"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item
          label="详细地址"
          required
        >
          <el-input
            v-model="addrForm.detail"
            type="textarea"
            :rows="2"
          />
        </el-form-item>
        <el-form-item label="标签">
          <el-select
          :teleported="false"
            v-model="addrForm.tag"
            placeholder="选填"
            clearable
            style="width: 200px"
          >
            <el-option
              label="宿舍"
              value="宿舍"
            />
            <el-option
              label="学院"
              value="学院"
            />
            <el-option
              label="家"
              value="家"
            />
            <el-option
              label="公司"
              value="公司"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="设为默认">
          <el-switch v-model="addrForm.isDefault" />
        </el-form-item>
        <div>
          <el-button
            type="primary"
            @click="onSaveAddress"
          >
            保存
          </el-button>
          <el-button @click="addrDrawerVisible = false">
            取消
          </el-button>
        </div>
      </el-form>
    </el-drawer>

    <!-- 信誉分规则 -->
    <el-dialog
      v-model="showCreditRule"
      title="信誉积分规则"
      width="420px"
    >
      <ul class="credit-rules">
        <li>初始信誉分：100</li>
        <li>完成一笔好评 +3，单笔订单最多 +5</li>
        <li>收到差评或被举报属实 -5/-10</li>
        <li>信誉分低于 60 将被限制发布商品；低于 40 封禁账号</li>
        <li>平台活动期间完成指定行为可获得额外加分</li>
      </ul>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import BackButton from '@/components/common/BackButton.vue'
import { computed, onMounted, reactive, ref, watch } from 'vue'
import PriceTag from '@/components/common/PriceTag.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { useUserStore } from '@/stores/modules/user'
import {
  fetchMyGoods, toggleMyGoods, deleteMyGoods,
  fetchFavorites, removeFavorite, toggleFavorite,
  fetchHistory, clearHistory, removeHistory,
  fetchAddresses, saveAddress, deleteAddress,
  updateProfile
} from '@/api/user'
import { fetchOrders } from '@/api/order'
import { formatDate, formatRelative } from '@/utils/format'
import { validateCnPhone } from '@/utils/validators'
import { resolveStock } from '@/utils/goods'
import type { Goods, Order, Favorite, HistoryItem, Address } from '@/types'

const userStore = useUserStore()

const user = computed(() => userStore.profile || ({} as any))
const activeTab = ref('goods')
const creditGradient = [
  { color: '#ef4444', percentage: 33 },
  { color: '#f59e0b', percentage: 60 },
  { color: '#10b981', percentage: 100 }
]

/** 4 个 KPI 数据 */
const counts = reactive({ goods: 0, favorites: 0, orders: 0, history: 0 })
const myGoods = ref<Goods[]>([])
const goodsStatus = ref<'' | Goods['status']>('')
const favorites = ref<Favorite[]>([])
const orders = ref<Order[]>([])
const orderStatus = ref<'' | Order['status']>('')
const history = ref<HistoryItem[]>([])
const addresses = ref<Address[]>([])
const loading = reactive({ goods: false, favorites: false, orders: false, history: false })

onMounted(loadAll)

async function loadAll() {
  await Promise.all([loadCounts(), loadGoods(), loadFavorites(), loadOrders(), loadHistory(), loadAddresses()])
}

async function loadCounts() {
  const [g, f, o, h] = await Promise.all([
    fetchMyGoods({ pageSize: 1 }),
    fetchFavorites({ pageSize: 1 }),
    fetchOrders({ page: 1, pageSize: 1 }),
    fetchHistory({ pageSize: 1 })
  ])
  counts.goods = g.total
  counts.favorites = f.total
  counts.orders = o.total
  counts.history = h.total
}

async function loadGoods() {
  loading.goods = true
  try {
    const r = await fetchMyGoods({ status: (goodsStatus.value || undefined) as Goods['status'], pageSize: 20 })
    myGoods.value = r.list
  } finally { loading.goods = false }
}

async function loadFavorites() {
  loading.favorites = true
  try {
    const r = await fetchFavorites({ pageSize: 12 })
    favorites.value = r.list
  } finally { loading.favorites = false }
}

async function loadOrders() {
  loading.orders = true
  try {
    const r = await fetchOrders({ status: (orderStatus.value || undefined) as Order['status'], pageSize: 10 })
    orders.value = r.list
  } finally { loading.orders = false }
}

async function loadHistory() {
  loading.history = true
  try {
    const r = await fetchHistory({ pageSize: 15 })
    history.value = r.list
  } finally { loading.history = false }
}

async function loadAddresses() {
  addresses.value = await fetchAddresses()
}

/* ========== 我发布的商品操作 ========== */
function goodsStatusLabel(s: string) {
  return ({ on_sale: '在售', pending: '审核中', sold: '已售出', off_shelf: '已下架' } as any)[s] ?? s
}
function goodsStatusTag(s: string) {
  return ({ on_sale: 'success', pending: 'warning', sold: 'info', off_shelf: 'danger' } as any)[s] ?? ''
}
/*
 * el-table 的作用域插槽把 `row` 暴露成 Element Plus 内部的 `DefaultRow`
 * （一个带索引签名的宽松对象），它**不能**直接赋给 `Goods` / `HistoryItem`，
 * 所以模板里 `@click="onMyOffline(row)"` 会报 TS2345。
 * 这里统一把入参收敛成 `unknown` 再在函数内断言 —— 断言集中在一处，
 * 模板不必写 `row as any`，也就保住了「哪个地方在做类型妥协」的可见性。
 */
async function onMyOffline(raw: unknown) {
  const row = raw as Goods
  try { await ElMessageBox.confirm(`确认下架「${row.title}」？`, '提示') } catch { return }
  try {
    await toggleMyGoods({ id: row.id, status: 'off_shelf' })
    ElMessage.success('已下架')
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '下架失败')
  }
  await Promise.all([loadGoods(), loadCounts()])
}
async function onMyOnline(raw: unknown) {
  const row = raw as Goods
  try {
    await toggleMyGoods({ id: row.id, status: 'on_sale' })
    ElMessage.success('已重新上架')
  } catch (e) {
    // 审核中的商品不能自行上架，后台会拦下来 —— 这里必须把原因如实转达
    ElMessage.error(e instanceof Error ? e.message : '上架失败')
  }
  await loadGoods()
}
async function onMyDelete(raw: unknown) {
  const row = raw as Goods
  try { await ElMessageBox.confirm(`确认删除「${row.title}」？此操作不可恢复`, '危险操作', { type: 'error' }) } catch { return }
  try {
    await deleteMyGoods(row.id)
    ElMessage.success('已删除')
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '删除失败')
  }
  await Promise.all([loadGoods(), loadCounts()])
}

/* ========== 收藏操作 ========== */
async function onUnfav(goodsId: number) {
  await removeFavorite(goodsId)
  await Promise.all([loadFavorites(), loadCounts()])
  ElMessage.success('已取消收藏')
}
function isFavorited(goodsId: number): boolean {
  return favorites.value.some((f) => f.goodsId === goodsId)
}
async function onToggleFavFromHistory(raw: unknown) {
  const row = raw as HistoryItem
  await toggleFavorite({
    goods: {
      ...row.goods,
      categoryId: 0, categoryName: '',
      description: '', images: [], sellerAvatar: '',
      sellerId: 0, viewCount: 0, favoriteCount: 0, createTime: ''
    } as Goods
  })
  await Promise.all([loadFavorites(), loadCounts()])
}
async function onClearHistory() {
  try { await ElMessageBox.confirm('确认清空全部浏览历史？', '提示', { type: 'warning' }) } catch { return }
  await clearHistory()
  await loadHistory()
  await loadCounts()
  ElMessage.success('已清空')
}
async function onRemoveHistory(id: number) {
  await removeHistory(id)
  await Promise.all([loadHistory(), loadCounts()])
}

/* ========== 订单标签 ========== */
function orderLabel(s: Order['status']) {
  return ({
    pending_payment: '待付款', pending_ship: '待发货',
    shipped: '已发货', received: '已收货',
    completed: '已完成', refunding: '退款中', cancelled: '已取消'
  } as Record<string, string>)[s] ?? s
}
function orderTag(s: Order['status']) {
  return ({
    pending_payment: 'warning', pending_ship: 'warning',
    shipped: 'primary', received: 'info',
    completed: 'success', refunding: 'danger', cancelled: 'info'
  } as Record<string, any>)[s] ?? ''
}

/* ========== 地址操作 ========== */
const addrDrawerVisible = ref(false)
const cascaderValue = ref<string[]>([])
const addrForm = reactive<Address>({
  id: 0, receiver: '', phone: '', region: '', detail: '',
  isDefault: false, tag: '' as any
})

/** 地址表单行内校验规则（手机号 = 固定 11 位 + 号段规则，失焦即提示） */
const addrRules = {
  receiver: [{ required: true, whitespace: true, message: '请输入收货人', trigger: 'blur' }],
  phone: [{
    required: true,
    validator: (_rule: unknown, value: string, callback: (err?: Error) => void) => {
      const r = validateCnPhone(value)
      if (r.ok) callback()
      else callback(new Error(r.message))
    },
    trigger: 'blur'
  }]
}
const addrFormRef = ref()
// 省市区级联（Mock）
const regionOptions = [
  {
    value: '北京市', label: '北京市',
    children: [
      {
        value: '海淀区', label: '海淀区',
        children: [
          { value: '学院路街道', label: '学院路街道' },
          { value: '中关村南大街', label: '中关村南大街' },
          { value: '清华园街道', label: '清华园街道' }
        ]
      },
      {
        value: '朝阳区', label: '朝阳区',
        children: [
          { value: '三里屯街道', label: '三里屯街道' },
          { value: '建国门外大街', label: '建国门外大街' }
        ]
      }
    ]
  },
  {
    value: '上海市', label: '上海市',
    children: [
      {
        value: '杨浦区', label: '杨浦区',
        children: [
          { value: '五角场街道', label: '五角场街道' },
          { value: '复旦新村', label: '复旦新村' }
        ]
      }
    ]
  }
]

function onAddressAdd() {
  Object.assign(addrForm, { id: 0, receiver: '', phone: '', region: '', detail: '', isDefault: false, tag: '' as any })
  cascaderValue.value = []
  addrDrawerVisible.value = true
}
function onAddressEdit(a: Address) {
  Object.assign(addrForm, a)
  cascaderValue.value = a.region ? a.region.split('/') : []
  addrDrawerVisible.value = true
}
async function onSaveAddress() {
  // 手机号：固定位数校验（11 位数字 + 号段规则），错误提示来自 validators 的明确文案
  const phoneRes = validateCnPhone(addrForm.phone)
  if (!phoneRes.ok) {
    ElMessage.warning(phoneRes.message)
    return
  }
  const receiver = addrForm.receiver.trim()
  const detail = addrForm.detail.trim()
  const region = cascaderValue.value.join('/')
  if (!receiver || !region || !detail) {
    ElMessage.warning('请完整填写收件人、所在地区与详细地址')
    return
  }
  const payload: Address = {
    ...addrForm,
    id: addrForm.id || 0,
    receiver,
    detail,
    region,
    phone: phoneRes.value
  }
  await saveAddress(payload)
  ElMessage.success('地址已保存')
  addrDrawerVisible.value = false
  await loadAddresses()
}
async function onAddressDelete(a: Address) {
  try { await ElMessageBox.confirm(`确认删除「${a.region} ${a.detail}」？`, '提示') } catch { return }
  await deleteAddress(a.id)
  await loadAddresses()
  ElMessage.success('已删除')
}
async function onSetDefault(a: Address) {
  await saveAddress({ ...a, isDefault: true })
  await loadAddresses()
  ElMessage.success('已设为默认地址')
}

/* ========== 顶部 Banner / Tab 切换 ========== */
function onJumpTab(name: string) {
  activeTab.value = name
}

/* ========== 编辑资料 ========== */
const editProfileVisible = ref(false)
const profileSaving = ref(false)
const profileForm = reactive({ nickname: '', phone: '', avatar: '' })
function onEditProfile() {
  Object.assign(profileForm, {
    nickname: user.value?.nickname || '',
    phone: user.value?.phone || '',
    avatar: user.value?.avatar || ''
  })
  editProfileVisible.value = true
}
/**
 * 保存资料。
 *
 * ★ 这里曾经只改 Pinia，不发请求 ★
 * 旧实现把 `user.value.nickname = xxx` 写进内存，弹窗当场关掉、toast 提示「已保存」，
 * 页面顶部也真的显示新昵称 —— 但刷新就变回去，因为**后端当年没有这个接口**，
 * 整条写链路是断的。现在走后端 `PATCH /user/profile` 真正落库。
 *
 * ★ 为什么必须用返回值回填，而不是本地乐观更新 ★
 * `updateProfile` 返回的是服务端落库后的**完整**资料（含 creditScore / status / role）。
 * 若沿用本地拼的值，一旦请求失败界面已经改了、用户以为成功；而且弹窗里的
 * 昵称是 trim 过的、手机号是规范化过的，本地那份和后端那份可能不一致。
 * 统一以服务端返回为准（`applyProfile`），是唯一不会自相矛盾的写法。
 */
async function onSaveProfile() {
  // 手机号选填：空放行，填了就按 11 位规则校验（后端 Validators.phone 同一口径，双重保险）
  const phoneRes = validateCnPhone(profileForm.phone, { allowEmpty: true })
  if (!phoneRes.ok) {
    ElMessage.warning(phoneRes.message)
    return
  }
  profileSaving.value = true
  try {
    const updated = await updateProfile({
      nickname: profileForm.nickname.trim(),
      phone: phoneRes.value,
      avatar: profileForm.avatar
    })
    userStore.applyProfile(updated)
    ElMessage.success('资料已保存')
    editProfileVisible.value = false
  } catch {
    // request.ts 已统一 toast 出后端 message（如「昵称不能为空」）；
    // 这里刻意不关闭弹窗、不改本地值，让用户能直接在原输入上修正后重试。
  } finally {
    profileSaving.value = false
  }
}

/* ========== 信誉分规则弹窗 ========== */
const showCreditRule = ref(false)

/* ========== 接收 Tab 外的导航 ========== */
watch(() => userStore.profile?.id, async (id) => {
  if (id) await loadAll()
})
</script>

<style scoped lang="scss">
.profile-page { max-width: 1200px; margin: 0 auto; }

.profile-banner {
  background: linear-gradient(135deg, #1e3a8a 0%, #2563eb 55%, #7c3aed 100%);
  color: #fff;
  border-radius: var(--radius-lg);
  padding: 28px 36px;
  display: flex; align-items: center; gap: 24px;
  box-shadow: var(--shadow-md);

  .avatar-wrap { position: relative; }
  .edit-btn { position: absolute; bottom: -8px; left: 50%; transform: translateX(-50%); }

  .info { flex: 1; }
  .name-row { display: flex; align-items: center; gap: 8px;
    h2 { font-size: 24px; margin: 0; }
  }
  .meta-row {
    margin-top: 8px; font-size: 13px; opacity: .85;
    span { display: inline-flex; align-items: center; gap: 4px; margin-right: 18px; }
  }
  .credit {
    display: flex; align-items: center; gap: 10px;
    margin-top: 14px;
    span { font-size: 13px; opacity: .85; }
    .credit-score { font-size: 22px; font-weight: 800; color: #fff; }
  }
}

.kpi-row {
  display: grid; grid-template-columns: repeat(4, 1fr);
  gap: 12px; margin-top: 16px;

  @media (max-width: 768px) { grid-template-columns: repeat(2, 1fr); }

  .kpi-item {
    background: #fff;
    border: 1px solid var(--border-color);
    border-radius: 10px;
    padding: 16px 18px;
    display: flex; flex-direction: column; gap: 4px;
    cursor: pointer;
    transition: all 0.2s;
    position: relative;
    &:hover {
      border-color: var(--color-primary);
      transform: translateY(-2px);
      box-shadow: var(--shadow-sm);
    }
    .label { font-size: 13px; color: var(--color-text-mute); }
    .value { font-size: 24px; font-weight: 800; color: var(--color-primary); }
    .arrow { position: absolute; top: 14px; right: 14px; color: var(--color-text-mute); font-size: 16px; }
  }
}

.profile-card {
  background: #fff;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  padding: 4px 22px 18px;
  margin-top: 16px;
}
.profile-tabs { --el-tabs-header-height: 48px; }
.tab-label {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 14px;
}
.tab-head {
  display: flex; justify-content: space-between; align-items: center;
  margin: 10px 0 14px;
  flex-wrap: wrap;
  gap: 10px;
  .hint { color: var(--color-text-mute); font-size: 13px; }
}

.g-cell { display: flex; align-items: center; gap: 10px;
  .t-img { width: 56px; height: 56px; border-radius: 6px; }
}

/* 数量列：售罄（0 件）用警示色，卖家一眼能看到哪些商品需要补货 */
.stock-cell {
  font-variant-numeric: tabular-nums;
  font-weight: 500;
  color: var(--color-text-primary);

  &.is-out { color: var(--color-danger, #f56c6c); }
}

/* 收藏卡片 */
.fav-card {
  background: #fff;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  overflow: hidden;
  margin-bottom: 12px;
  transition: all 0.2s;
  &:hover { box-shadow: var(--shadow-sm); transform: translateY(-2px); }

  .fav-cover {
    position: relative;
    aspect-ratio: 4/3;
    cursor: pointer;
    overflow: hidden;
    background: linear-gradient(135deg, #e2e8f0, #cbd5e1);
  }
  .cover-img { width: 100%; height: 100%; display: block; }
  .cover-tag { position: absolute; top: 6px; right: 6px; }

  .fav-info { padding: 10px 12px; }
  .fav-title {
    font-size: 13px; font-weight: 600;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    margin-bottom: 6px;
  }
  .fav-foot {
    display: flex; justify-content: space-between; align-items: center;
    margin-top: 6px;
    .muted { color: var(--color-text-mute); font-size: 12px; }
  }
}

/* 地址卡片 */
.addr-card {
  background: #fff;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  padding: 14px 16px;
  margin-bottom: 12px;
  transition: all 0.2s;
  position: relative;

  &.is-default {
    border-color: var(--color-accent);
    box-shadow: 0 0 0 2px rgba(249, 115, 22, 0.08);
  }

  .addr-head {
    display: flex; align-items: center; gap: 8px;
    b { font-size: 16px; }
    span { color: var(--color-text-mute); font-size: 13px; }
  }
  .addr-addr {
    margin: 10px 0;
    color: var(--color-text-secondary);
    font-size: 13px;
    line-height: 1.6;
  }
  .addr-foot { display: flex; gap: 4px; justify-content: flex-end; }
}

/* 信誉分规则 */
.credit-rules {
  margin: 0; padding-left: 18px;
  li { padding: 6px 0; color: var(--color-text-secondary); font-size: 14px; line-height: 1.7; }
}
</style>
