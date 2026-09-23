<template>
  <PageContainer
    back
    title="发布二手商品"
    subtitle="填写商品信息，提交后将进入审核"
  >
    <template #actions>
      <el-button @click="$router.back()">
        取消
      </el-button>
    </template>

    <el-row :gutter="20">
      <el-col
        :xs="24"
        :md="16"
      >
        <el-card
          shadow="never"
          class="form-card"
        >
          <el-form
            ref="formRef"
            :model="form"
            :rules="rules"
            label-width="100px"
            size="large"
          >
            <el-form-item
              label="商品标题"
              prop="title"
            >
              <el-input
                v-model="form.title"
                placeholder="例如：高等数学（同济第七版）九成新"
                maxlength="40"
                show-word-limit
              />
            </el-form-item>
            <el-form-item
              label="售价"
              prop="price"
            >
              <el-input-number
                v-model="form.price"
                :min="0.01"
                :precision="2"
                :step="1"
                placeholder="¥"
              />
              <span class="hint">你的挂牌成交价（单件）</span>
            </el-form-item>
            <!--
              数量必须有：不填就会出现「买家能选 3 件、你手上只有 1 件」的订单。
              默认 1 件（校园二手多为单件闲置），买家端购物车与立即购买都以它为上限。
            -->
            <el-form-item
              label="数量"
              prop="stock"
            >
              <el-input-number
                v-model="form.stock"
                :min="1"
                :max="MAX_ORDER_QUANTITY"
                :step="1"
              />
              <span class="hint">可售件数，买家最多能买这么多</span>
            </el-form-item>
            <!-- 分类放在「活动让利」之前：能报名哪些活动取决于分类，先选分类才不会误导卖家 -->
            <el-form-item
              label="商品分类"
              prop="categoryId"
            >
              <el-select
          :teleported="false"
                v-model="form.categoryId"
                placeholder="请选择"
                style="width: 240px"
                @change="onCategoryChange"
              >
                <el-option
                  v-for="c in categories"
                  :key="c.id"
                  :label="`${c.icon} ${c.name}`"
                  :value="c.id"
                />
              </el-select>
            </el-form-item>
            <!--
              活动让利：这里刻意不提供「原价」输入框。
              卖家无法自行填写划线价，划线价只能等于自己填的挂牌价，
              从入口上杜绝「虚构原价」这种价格欺诈。

              三种形态（与当前所选分类相关）：
                ① 该分类没有进行中的活动 → 只说明「按挂牌价成交」，不承诺做不到的事
                ② 有活动可报名 → **把该分类下全部在招活动列出来，但只能选一个**
                   （卖家只能选「参加哪个 / 不参加」，不能选「打几折」）
                ③ 选中某个活动 → 立刻显示让利后的成交价，并讲清这笔差价从谁的钱里出
            -->
            <el-form-item label="活动让利">
              <div class="promo-field">
                <!-- ① 无进行中活动 -->
                <span
                  v-if="!joinableClaims.length"
                  class="policy-hint"
                >
                  当前分类<strong>暂无进行中的平台活动</strong>，商品将始终按你的挂牌价成交。
                  平台不代你定价，也不允许填写虚构原价。
                  <template v-if="joinableNames.length">
                    目前有活动的分类：<b>{{ joinableNames.join(' / ') }}</b>，切换分类即可参加。
                  </template>
                  <template v-else>
                    当前平台没有任何分类在让利，可在「管理后台 → 活动管理」查看或恢复出厂活动。
                  </template>
                </span>

                <!-- ② 有活动可报名：全部列出，只能选一个 -->
                <template v-else>
                  <el-radio-group
                    v-model="joinedActivityId"
                    class="join-box"
                  >
                    <el-radio
                      value=""
                      class="join-item is-none"
                    >
                      <span class="ji-title">不参加活动，按挂牌价成交</span>
                      <span class="ji-meta">平台不代你定价，买家按你填的价付款</span>
                    </el-radio>
                    <el-radio
                      v-for="c in joinableClaims"
                      :key="c.activityId"
                      :value="c.activityId"
                      class="join-item"
                    >
                      <span class="ji-title">参加《{{ c.title }}》</span>
                      <span class="ji-meta">最高 {{ rateLabel(c.rate) }} · {{ FUND_SOURCE_SHORT[c.fundSource] }}</span>
                    </el-radio>
                  </el-radio-group>
                  <span class="hint join-tip">{{ joinTip }}</span>

                  <!-- ③ 让利预览：金额来自 settleJoin()，与提交后生成的让利价同源 -->
                  <div
                    v-if="joinedClaim && preview"
                    class="promo-preview"
                  >
                    <div class="pp-row">
                      <span class="pp-label">你的挂牌价</span>
                      <b>¥{{ preview.listPrice.toFixed(2) }}</b>
                    </div>
                    <div class="pp-row">
                      <span class="pp-label">报名后买家实付</span>
                      <b class="pp-pay">¥{{ preview.payAmount.toFixed(2) }}</b>
                      <el-tag
                        size="small"
                        type="warning"
                        effect="plain"
                      >
                        {{ preview.discountLabel }}
                      </el-tag>
                    </div>
                    <p
                      class="pp-note"
                      :class="isSellerFund ? 'is-seller' : 'is-platform'"
                    >
                      {{ previewNote }}
                    </p>
                  </div>
                </template>
              </div>
            </el-form-item>
            <el-form-item
              label="交易地点"
              prop="location"
            >
              <el-input
                v-model="form.location"
                placeholder="例如：计算机学院宿舍楼下"
              />
            </el-form-item>
            <el-form-item
              label="上传图片"
              prop="images"
            >
              <el-upload
                v-model:file-list="fileList"
                list-type="picture-card"
                :auto-upload="false"
                :limit="9"
                accept="image/*"
              >
                <el-icon><Plus /></el-icon>
              </el-upload>
              <div class="hint">
                最多 9 张，第一张为封面
              </div>
            </el-form-item>
            <el-form-item
              label="商品描述"
              prop="description"
            >
              <div class="desc-field">
                <!--
                  Spring AI 接入点：卖家往往写不出描述，或只堆几个关键词。
                  先把标题填好，这里一键生成一版可用的文案，卖家再自己改。
                -->
                <div class="desc-toolbar">
                  <span class="hint">先填标题，AI 可据标题与分类生成一版描述，生成后仍可自由修改</span>
                  <el-button
                    size="small"
                    type="primary"
                    plain
                    :loading="aiGenerating"
                    :disabled="!form.title.trim()"
                    @click="handleAiDescription"
                  >
                    ✨ AI 生成描述
                  </el-button>
                </div>
                <el-input
                  v-model="form.description"
                  type="textarea"
                  :rows="6"
                  placeholder="商品成色、使用情况、有无瑕疵等"
                  maxlength="500"
                  show-word-limit
                />
              </div>
            </el-form-item>
            <!--
              交易方式必须是**单选**：一件商品只有一种履约方式。
              做成多选时卖家会把三个都勾上，买家下单后到底按哪种履约没有约定，
              出了纠纷谁也说不清。选项与说明来自 utils/goods 的统一口径。
            -->
            <el-form-item
              label="交易方式"
              prop="deliveryMethod"
            >
              <el-radio-group
                v-model="form.deliveryMethod"
                class="delivery-group"
              >
                <el-radio
                  v-for="d in DELIVERY_OPTIONS"
                  :key="d.value"
                  :value="d.value"
                  class="delivery-item"
                >
                  <span class="di-title">{{ d.label }}</span>
                  <span class="di-hint">{{ d.hint }}</span>
                </el-radio>
              </el-radio-group>
            </el-form-item>
            <el-form-item>
              <el-button
                type="primary"
                :loading="submitting"
                @click="onSubmit"
              >
                提交审核
              </el-button>
              <el-button
                @click="onSaveDraft"
              >
                保存草稿
              </el-button>
            </el-form-item>
          </el-form>
        </el-card>
      </el-col>
      <el-col
        :xs="24"
        :md="8"
      >
        <el-card
          shadow="never"
          class="tips-card"
        >
          <h4>📌 发布指南</h4>
          <ul>
            <li>标题简洁清晰，避免堆砌关键词</li>
            <li>上传真实商品照片，提升成交率</li>
            <li>如实定价，成交价即为你的挂牌价</li>
            <li>详细描述成色、瑕疵，提升买家信任</li>
            <li>选择合适交易方式，避免纠纷</li>
            <li>平台不代你定价，也不允许填写虚构原价</li>
          </ul>
        </el-card>
      </el-col>
    </el-row>
  </PageContainer>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { FormInstance, FormRules, UploadUserFile } from 'element-plus'
import PageContainer from '@/components/common/PageContainer.vue'
import { fetchCategories, publishGoods } from '@/api/goods'
import { generateGoodsDescription } from '@/api/ai'
import { uploadImage } from '@/api/upload'
import { ensureActivitiesLoaded, resolveJoinableClaimsByCategory, joinableCategoryIds } from '@/api/activity'
import { useUserStore } from '@/stores/modules/user'
import { FUND_SOURCE_SHORT, settleJoin } from '@/utils/promo'
import { discountText } from '@/utils/format'
import { DELIVERY_OPTIONS, DEFAULT_STOCK, MAX_ORDER_QUANTITY } from '@/utils/goods'
import { compressImageToFile } from '@/utils/image'
import type { DeliveryMethod } from '@/utils/goods'
import type { Category } from '@/types'

const router = useRouter()
const userStore = useUserStore()

const formRef = ref<FormInstance>()
const submitting = ref(false)
const fileList = ref<UploadUserFile[]>([])
const categories = ref<Category[]>([])
const aiGenerating = ref(false)

const form = reactive({
  title: '',
  price: 0,
  stock: DEFAULT_STOCK,
  categoryId: 1,
  location: '',
  description: '',
  /** 交易方式（单选）；早期是多选数组，已收敛为单个值 */
  deliveryMethod: 'face' as DeliveryMethod
})

const rules: FormRules = {
  title: [{ required: true, message: '请输入商品标题', trigger: 'blur' }],
  price: [{ required: true, message: '请输入价格', trigger: 'blur' }],
  stock: [{ required: true, message: '请输入数量', trigger: 'blur' }],
  categoryId: [{ required: true, message: '请选择分类', trigger: 'change' }],
  location: [{ required: true, message: '请填写交易地点', trigger: 'blur' }],
  description: [{ required: true, message: '请填写商品描述', trigger: 'blur' }]
}

/**
 * AI 生成商品描述（Spring AI / POST /ai/generate-description）
 *
 * 关键词取自当前分类与交易地点 —— 它们是卖家已经填过的、且对文案真正有信息量的字段。
 * 描述已有内容时先确认再覆盖：卖家可能已经手写了一半，
 * 一键抹掉是最招人烦的交互。
 */
async function handleAiDescription() {
  const title = form.title.trim()
  if (!title) {
    ElMessage.warning('请先填写商品标题，AI 需要据此生成描述')
    return
  }
  if (form.description.trim()) {
    try {
      await ElMessageBox.confirm('当前描述已有内容，AI 生成会覆盖它，确定继续？', 'AI 生成描述', {
        confirmButtonText: '覆盖生成',
        cancelButtonText: '取消',
        type: 'warning'
      })
    } catch {
      return
    }
  }
  const keywords = [
    categories.value.find((c) => c.id === form.categoryId)?.name,
    form.location.trim()
  ]
    .filter(Boolean)
    .join('，')

  aiGenerating.value = true
  try {
    const desc = await generateGoodsDescription({ title, keywords })
    if (!desc) {
      ElMessage.warning('AI 没有返回内容，请稍后再试')
      return
    }
    form.description = desc.slice(0, 500)
    formRef.value?.clearValidate('description')
    ElMessage.success('描述已生成，记得按实际情况调整')
  } catch {
    // request.ts 已弹出统一错误提示（未配置 API Key、超时、未登录等）
  } finally {
    aiGenerating.value = false
  }
}

/* ============ 活动报名 ============
 * 卖家**只能决定「参加哪个 / 不参加」**，不能决定「打几折」——
 * 力度由活动声明（claims）决定，这是 C2C 平台「不代卖家定价」的底线。
 *
 * 一个分类可能同时挂着**多条**在招活动（现实中很常见：卖家让利的开学季
 * 与平台补贴的宿舍焕新并行）。所以这里把可选项全列出来给卖家比，但**必须单选**：
 * 一件商品只有 `promoPrice` 一个让利价字段，同时参加两条活动等于叠加打折，
 * 也分不清这笔差价由谁承担。
 */

/** 当前分类**全部**可报名的活动（只认进行中的活动，见 activity.ts 的注释） */
const joinableClaims = computed(() => resolveJoinableClaimsByCategory(form.categoryId))

/**
 * 当前**有活动**的分类名（带图标）。
 *
 * 用途：当前分类没有活动时，把「能报名的分类」直接列出来 ——
 * 否则卖家只看到一个空框，只能靠猜。分类列表还没加载完时留空，
 * 此时模板会退化成兜底文案。
 */
const joinableNames = computed(() => {
  if (!categories.value.length) return []
  return joinableCategoryIds()
    .map((id) => categories.value.find((c) => c.id === id))
    .filter((c): c is Category => !!c)
    .map((c) => `${c.icon} ${c.name}`)
})

/** 卖家选中的活动（'' = 不参加）—— 用 id 而不是对象，避免对象引用换了就失配 */
const joinedActivityId = ref('')

/** 选中的那条声明（未选 / 选了不参加时为 null） */
const joinedClaim = computed(
  () => joinableClaims.value.find((c) => c.activityId === joinedActivityId.value) ?? null
)

/** 单选规则的说明文案：把「为什么只能选一个」讲出来，而不是让卖家自己猜 */
const joinTip = computed(() => {
  const n = joinableClaims.value.length
  const head = n === 1 ? '当前分类有 1 个在招活动' : `当前分类有 ${n} 个在招活动，可任选其一`
  return `${head}；一件商品只能参加其中一个 —— 让利价只有一个，不叠加打折。`
})

/** 资金方：决定这笔差价从谁的钱里出，必须显式告诉卖家 */
const isSellerFund = computed(() => joinedClaim.value?.fundSource === 'seller')

/**
 * 让利预览。金额来自 `settleJoin()` —— 与提交后真正生成的让利价**同一个函数**，
 * 所以「预览看到多少、成交就是多少」，不会出现两套算法算出两个价。
 */
const preview = computed(() => {
  const c = joinedClaim.value
  // 没选活动、或还没填售价时不预览，免得显示一排 ¥0.00
  if (!c || !(form.price > 0)) return null
  return settleJoin(form.price, c.rate, c.fundSource)
})

/** 预览结论：这笔差价谁承担、卖家实收变不变 */
const previewNote = computed(() => {
  const c = joinedClaim.value
  const b = preview.value
  if (!c || !b) return ''
  if (!b.onPromo) return '此价格过低，让利后不足 ¥1，将按挂牌价成交。'

  if (c.fundSource === 'seller') {
    const cut = b.sellerCut.toFixed(2)
    return `卖家让利 ¥${cut} —— 你将少收 ¥${cut}（买家实付多少，你就实收多少）。`
  }
  const sub = b.platformSubsidy.toFixed(2)
  return `平台补贴 ¥${sub} —— 你的实收仍是 ¥${b.listPrice.toFixed(2)}，一分不少。`
})

/** 0.5 → 「5折」；活动声明的 rate 即该分类的最深力度 */
function rateLabel(rate: number) {
  return discountText(100 * rate, 100) || `${rate * 10}折`
}

/** 分类一变，可报名的活动整体换了一批 —— 必须重置选择 */
function onCategoryChange() {
  joinedActivityId.value = ''
}

async function onSubmit() {
  if (!formRef.value) return
  try { await formRef.value.validate() } catch { return }
  submitting.value = true
  try {
    /*
     * ★ 图片先压缩、再上传，拿回短路径落库 ★
     *
     * 旧做法是把每张图压成 data URL 直接塞进商品字段，但 cover 只有 varchar(255)、
     * images 是 text（64KB 上限），压缩后的 base64 仍有 100~400KB ——
     * 只要卖家选了图，后端插入时必然抛 Data too long，
     * 前端只能看到「服务器内部错误，请稍后再试」。
     * （el-upload 在 auto-upload=false 下给的 blob: 地址同样不能直接落库：
     *   它只在当前浏览器会话有效，换会话打开就是裂图。）
     *
     * 现在：压缩（控住体积）→ 上传（换成 /uploads/... 短路径）→ 提交商品。
     * 单张失败只跳过那一张并点名告知，不让整张表单白填。
     */
    const uploadedUrls: string[] = []
    for (const f of fileList.value) {
      if (!f.raw) continue
      try {
        const compressed = await compressImageToFile(f.raw as File)
        uploadedUrls.push(await uploadImage(compressed))
      } catch (e) {
        ElMessage.warning(
          `图片「${f.name}」上传失败，已跳过：${(e as Error)?.message || '请稍后重试'}`
        )
      }
    }
    const cover = uploadedUrls[0] || ''
    // 记下报名意图：提交时活动可能已被后台下架，要能对比出「说好的让利没生效」
    const appliedTitle = joinedClaim.value?.title
    const newG = await publishGoods({
      title: form.title,
      price: form.price,
      stock: form.stock,
      deliveryMethod: form.deliveryMethod,
      categoryId: form.categoryId,
      location: form.location,
      description: form.description,
      cover,
      images: uploadedUrls.filter(Boolean),
      // 选中活动才传 activityId；让利价由数据层按活动规则生成，卖家无从自填
      activityId: joinedClaim.value?.activityId
    })

    /*
     * 三种结果都要说清楚，尤其是第三种：
     * 卖家选活动时看到的是「¥160 成交」，若提交瞬间活动已失效，
     * 数据层会按挂牌价落库 —— 这时**必须**告知，否则卖家以为已让利、买家按原价付款。
     */
    if (newG.promoPrice !== undefined) {
      ElMessage.success(
        `提交成功，等待审核（已参加《${appliedTitle}》，审核通过后按 ¥${newG.promoPrice.toFixed(2)} 成交）`
      )
    } else if (appliedTitle) {
      ElMessage.warning(
        `《${appliedTitle}》已结束或已下架，本次按挂牌价 ¥${Number(form.price).toFixed(2)} 提交，等待审核`
      )
    } else {
      ElMessage.success('提交成功，等待审核')
    }
    router.push(`/goods/${newG.id}`)
  } finally {
    submitting.value = false
  }
}

/**
 * 保存草稿
 *
 * ★ 原实现只有一句 `ElMessage.info('草稿已保存（Mock）')` ★
 * 表单内容既没落 localStorage 也没落库，连按钮右侧的表单状态都没变 ——
 * 刷新页面什么都不剩。末尾标了「（Mock）」算是留了线索，
 * 但对用户而言「已保存」这三个字已经足够让他放心关掉页面，回来就发现草稿没了。
 *
 * ★ 为什么这一次不顺手把草稿做成真的 ★
 * 真正的草稿要有：草稿存储（草稿表 or 本地暂存）、进入发布页时的恢复与冲突确认、
 * 提交成功后清除草稿、以及对应的用例。它是一个**独立功能**，
 * 不属于「把假实现改诚实」的范畴 —— 塞进这次修复只会做出一半的草稿。
 * 所以这里先如实说明未保存，并把真正可用的替代路径讲清楚。
 */
function onSaveDraft() {
  ElMessage.warning('草稿功能尚未实现，内容没有被保存；请直接点「发布」提交审核，或先手动备份文本')
}

/*
 * 分类与**活动**都要先加载完再渲染报名控件：
 * 活动列表现在是服务端数据（`/activities/active`），而让利选项、可报名分类
 * 都是**同步**从缓存里解析的（`resolveJoinableClaimsByCategory`）。
 * 不先 await 一次的话，首帧会显示「当前分类暂无活动」，
 * 卖家据此选了「不参加」，而这个判断其实是错的。
 */
onMounted(async () => {
  const [cats] = await Promise.all([fetchCategories(), ensureActivitiesLoaded()])
  categories.value = cats
})
</script>

<style scoped lang="scss">
@use '@/styles/variables.scss' as *;

.form-card { padding: 8px; }
.tips-card { background: linear-gradient(135deg, #fff7ed, #fff);
  h4 { margin-bottom: 10px; color: var(--color-accent); }
  ul li { padding: 4px 0; color: var(--color-text-secondary); font-size: 13px; padding-left: 16px; position: relative;
    &::before { content: "•"; position: absolute; left: 4px; color: var(--color-accent); }
  }
}
.hint { color: var(--color-text-mute); font-size: 12px; margin-left: 12px; }

/*
 * 描述字段：工具条与 textarea 必须上下排列。
 * el-form-item__content 是 flex 容器，两个子元素直接放进去会变成左右并排，
 * textarea 被挤成一条窄缝。
 */
.desc-field { width: 100%; }

.desc-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}

.desc-toolbar .hint { margin-left: 0; line-height: 1.5; }

/* 活动规则说明：只做信息传达，不与表单控件抢焦点 */
.policy-hint {
  display: block;
  max-width: 460px;
  padding: 10px 12px;
  background: $brand-orange-soft;
  border: 1px solid $brand-orange-line;
  border-radius: $radius-sm;
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.7;

  strong, b { color: $brand-orange-deep; font-weight: $fw-semibold; }
}

/* ============ 活动报名 ============ */
.promo-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
  max-width: 460px;
}

/* 活动单选组：每个活动一行，整行可点（命中区 ≥44px，WCAG 2.5.5） */
.join-box {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
  width: 100%;

  :deep(.el-radio) {
    display: flex;
    align-items: flex-start;
    height: auto;
    margin-right: 0;
    padding: 8px 10px;
    border: 1px solid var(--border-color);
    border-radius: $radius-sm;
    background: var(--bg-soft);
    transition: border-color $dur-fast $ease-out, background $dur-fast $ease-out;

    &:hover { border-color: $brand-orange-line; background: #fff; }
    /* 选中态必须一眼可辨：边框显品牌色 + 白底（与「悬停」区分开） */
    &.is-checked { border-color: $brand-orange; background: #fff; }
  }

  /* 单选圆点与两行文字对齐（默认 vertical-align 会偏） */
  :deep(.el-radio__input) { margin-top: 2px; }
  :deep(.el-radio__label) { display: block; padding-left: 8px; line-height: 1.5; }
}

.join-item {
  .ji-title {
    display: block;
    font-size: $font-sm;
    color: var(--color-text-primary);
    font-weight: $fw-medium;
  }

  /* 卖家选活动时真正要比的是这一行：几折 + 这钱谁出（自己少收 / 实收不变） */
  .ji-meta {
    display: block;
    margin-top: 2px;
    font-size: $font-xs;
    color: var(--color-text-mute);
  }
}

/* ============ 交易方式（单选） ============
   与「活动报名」用同一套视觉语言：整行可点、选中显品牌色边框。
   选项带一句说明——「面交 / 快递 / 自提」三个词对新手卖家并不自解释。 */
.delivery-group {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
  width: 100%;
  max-width: 460px;

  :deep(.el-radio) {
    display: flex;
    align-items: flex-start;
    height: auto;
    margin-right: 0;
    padding: 8px 10px;
    border: 1px solid var(--border-color);
    border-radius: $radius-sm;
    background: var(--bg-soft);
    transition: border-color $dur-fast $ease-out, background $dur-fast $ease-out;

    &:hover { border-color: $brand-orange-line; background: #fff; }
    &.is-checked { border-color: $brand-orange; background: #fff; }
  }

  :deep(.el-radio__input) { margin-top: 2px; }
  :deep(.el-radio__label) { display: block; padding-left: 8px; line-height: 1.5; }

  .di-title {
    display: block;
    font-size: $font-sm;
    color: var(--color-text-primary);
    font-weight: $fw-medium;
  }
  .di-hint {
    display: block;
    margin-top: 2px;
    font-size: $font-xs;
    color: var(--color-text-mute);
  }
}

/* 让利预览：卖家决策的关键信息，做成可一眼看完的小卡 */
.promo-preview {
  padding: 10px 12px;
  background: var(--bg-soft);
  border: 1px solid var(--border-color);
  border-radius: $radius-sm;

  .pp-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: $font-sm;
    line-height: 2;
    color: var(--color-text-secondary);

    b { color: var(--color-text-primary); font-variant-numeric: tabular-nums; }
    .pp-pay { color: $brand-orange-deep; font-size: $fs-15; }
  }

  .pp-label { min-width: 108px; color: var(--color-text-mute); }

  .pp-note {
    margin: 6px 0 0;
    font-size: $font-xs;
    line-height: 1.7;

    &.is-seller { color: $brand-orange-deep; }
    &.is-platform { color: $color-primary; }
  }
}
</style>
