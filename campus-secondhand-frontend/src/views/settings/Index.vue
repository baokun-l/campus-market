<template>
  <div class="settings-page">
    <h2 class="page-title">
      设置
    </h2>

    <!-- 顶部个人 Banner（点击进个人主页） -->
    <section
      class="profile-banner"
      @click="$router.push('/user/profile')"
    >
      <el-avatar
        :src="user.avatar"
        :size="64"
      />
      <div class="banner-info">
        <div class="name-row">
          <b>{{ user.nickname }}</b>
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
        <div class="meta">
          <span>ID: {{ user.username }}</span>
          <span>信用 {{ user.creditScore }}</span>
        </div>
        <span class="view-profile">查看完整个人主页 →</span>
      </div>
      <el-icon class="enter-arrow">
        <ArrowRight />
      </el-icon>
    </section>

    <!-- 账号与安全 -->
    <SettingsGroup title="账号与安全">
      <SettingsItem
        icon="Phone"
        label="手机号"
        :value="phoneLabel"
      >
        <template #action>
          <el-button
            text
            type="primary"
            size="small"
            @click.stop="onBindPhone"
          >
            {{ phoneLabel === '未绑定' ? '绑定' : '更换' }}
          </el-button>
        </template>
      </SettingsItem>

      <SettingsItem
        icon="Lock"
        label="修改登录密码"
        hint="定期更换密码可保障账号安全"
        @click="onChangePassword"
      />

      <SettingsItem
        icon="UserFilled"
        label="实名认证"
        :value="realNameVerified ? '已认证' : '未认证'"
        :hint="realNameVerified ? '' : '完成认证后可提升买卖信任度'"
        @click="realNameDialogVisible = true"
      >
        <template #action>
          <el-tag
            :type="realNameVerified ? 'success' : 'warning'"
            size="small"
          >
            {{ realNameVerified ? '✓ ' + realNameLast4 : '未认证' }}
          </el-tag>
        </template>
      </SettingsItem>

      <SettingsItem
        icon="Key"
        label="第三方账号绑定"
        :value="oauthBound ? `${oauthProvider}已绑定` : '未绑定'"
      >
        <template #action>
          <el-button
            text
            :type="oauthBound ? 'danger' : 'primary'"
            size="small"
            @click.stop="oauthBound ? onUnbindOauth() : onBindOauth()"
          >
            {{ oauthBound ? '解绑' : '绑定' }}
          </el-button>
        </template>
      </SettingsItem>

      <SettingsItem
        icon="Delete"
        label="注销账号"
        hint="注销后账号将无法恢复，请谨慎操作"
        danger
        :show-chevron="false"
      >
        <template #action>
          <el-button
            text
            type="danger"
            size="small"
            @click.stop="onDeleteAccount"
          >
            申请注销
          </el-button>
        </template>
      </SettingsItem>
    </SettingsGroup>

    <!-- 隐私设置 -->
    <SettingsGroup title="隐私设置">
      <!--
        ★ 这个开关目前不影响任何功能 ★
        它只把偏好写进 appStore（设备级持久化）：后端**没有**任何「按用户名搜索」的接口，
        搜索框也不读它。也就是说关掉它，别人照样能通过别的途径找到你。
        开关保留（偏好先存着，等接口落地即生效），但必须把作用范围讲清楚 ——
        否则用户会以为关掉它就「隐身」了，这是安全预期上的误导，比功能缺失更危险。
      -->
      <SettingsItem
        icon="View"
        label="允许通过用户名找到我"
        hint="当前版本未提供按用户名搜索，该偏好暂不影响他人能否找到你"
      >
        <template #action>
          <el-switch
            :model-value="appStore.settings.allowSearch"
            @update:model-value="(v: string | number | boolean) => onToggle('allowSearch', v)"
          />
        </template>
      </SettingsItem>
      <!--
        在线状态开关：语义是「让不让人看到**我**在线」，因此是**账号级**设置、落库，
        而不是像字号/主题色那样的设备级偏好。
        ★ 这里以前是个假开关 ★：它只存在浏览器本地，前端拿它去 gate 消息页和商品详情页的
        在线标识 —— 等于「关掉它，只是我自己看不见别人」，别人照样看得到我在线；
        而首页根本不渲染卖家信息，所以在首页切来切去毫无变化。
        现在它由 `PATCH /user/privacy` 落库，关掉后服务端的在线名单查询直接排除本人。
      -->
      <SettingsItem
        icon="Connection"
        label="对外展示在线状态"
        hint="关闭后，其他同学在消息列表与商品页都看不到你在线"
      >
        <template #action>
          <el-switch
            :model-value="showOnlineSelf"
            :loading="onlineSaving"
            @update:model-value="onToggleOnline"
          />
        </template>
      </SettingsItem>
      <SettingsItem
        icon="Aim"
        label="个性化推荐"
      >
        <template #action>
          <el-switch
            :model-value="appStore.settings.personalizedAds"
            @update:model-value="(v: string | number | boolean) => onToggle('personalizedAds', v)"
          />
        </template>
      </SettingsItem>
      <SettingsItem
        icon="Document"
        label="个人信息收集与使用"
      >
        <template #action>
          <el-button
            text
            type="primary"
            size="small"
            @click="onViewDocument('priv')"
          >
            查看
          </el-button>
        </template>
      </SettingsItem>
    </SettingsGroup>

    <!-- 消息通知 -->
    <SettingsGroup title="消息通知">
      <SettingsItem
        icon="BellFilled"
        label="交易消息"
      >
        <template #action>
          <el-switch
            :model-value="appStore.settings.notifyTrade"
            @update:model-value="(v: string | number | boolean) => onToggle('notifyTrade', v)"
          />
        </template>
      </SettingsItem>
      <SettingsItem
        icon="Notification"
        label="系统公告"
      >
        <template #action>
          <el-switch
            :model-value="appStore.settings.notifySystem"
            @update:model-value="(v: string | number | boolean) => onToggle('notifySystem', v)"
          />
        </template>
      </SettingsItem>
      <SettingsItem
        icon="ChatLineRound"
        label="营销推送"
      >
        <template #action>
          <el-switch
            :model-value="appStore.settings.notifyMarketing"
            @update:model-value="(v: string | number | boolean) => onToggle('notifyMarketing', v)"
          />
        </template>
      </SettingsItem>
      <SettingsItem
        icon="AlarmClock"
        label="勿扰时段"
        :value="dndLabel"
        hint="时段内不弹新消息提醒"
      >
        <template #action>
          <el-button
            text
            size="small"
            @click="dndDialogVisible = true"
          >
            设置
          </el-button>
        </template>
      </SettingsItem>
    </SettingsGroup>

    <!-- 通用 -->
    <SettingsGroup title="通用">
      <SettingsItem
        icon="Size"
        label="字号大小"
        :value="fontSizeLabel"
      >
        <template #action>
          <!-- 不用 el-dropdown：body zoom 下 Popper 弹层会双重缩放错位（特大档 dx=179px），
               分段选择器零弹层依赖，三档平铺可见也更直观 -->
          <el-segmented
            :model-value="appStore.settings.fontSize"
            :options="FONT_OPTIONS"
            size="small"
            @change="(v: any) => onFontSizeChange(v as FontSize)"
          />
        </template>
      </SettingsItem>

      <SettingsItem
        icon="Moon"
        label="深色模式"
      >
        <template #action>
          <el-switch
            :model-value="appStore.settings.dark"
            @update:model-value="onDarkChange"
          />
        </template>
      </SettingsItem>

      <SettingsItem
        icon="Brush"
        label="界面主题色"
        :value="accentLabel"
        hint="点击色点即时生效，全站联动"
      >
        <template #action>
          <div class="color-dots">
            <span
              v-for="(c, key) in ACCENTS"
              :key="key"
              class="dot"
              :class="{ active: appStore.settings.accent === key }"
              :style="{ background: c.primary }"
              :title="c.label"
              @click.stop="appStore.setAccent(key as Accent)"
            />
          </div>
        </template>
      </SettingsItem>

      <SettingsItem
        icon="DeleteFilled"
        label="清除缓存"
        :value="appStore.cacheSizeText"
        :show-chevron="false"
      >
        <template #action>
          <el-button
            text
            type="primary"
            size="small"
            @click.stop="onClearCache"
          >
            清除
          </el-button>
        </template>
      </SettingsItem>

      <SettingsItem
        icon="Histogram"
        label="版本信息"
        :value="`v${APP_VERSION}`"
        hint="点击查看版本详情"
        @click="versionVisible = true"
      />
    </SettingsGroup>

    <!-- 关于 -->
    <SettingsGroup title="关于">
      <SettingsItem
        icon="Document"
        label="服务协议"
        @click="onViewDocument('service')"
      />
      <SettingsItem
        icon="Lock"
        label="隐私政策"
        @click="onViewDocument('privacy')"
      />
      <SettingsItem
        icon="Star"
        label="给我们评分"
      />
      <SettingsItem
        icon="ChatLineSquare"
        label="用户反馈"
        @click="onFeedback"
      />
      <SettingsItem
        icon="Refresh"
        label="检查更新"
        value="已是最新版"
        :show-chevron="false"
      />
      <SettingsItem
        icon="OfficeBuilding"
        label="关于我们"
        value="校园二手集市 v1.0.0"
      />
    </SettingsGroup>

    <!-- 退出登录 -->
    <div class="logout-zone">
      <el-button
        type="danger"
        plain
        size="large"
        class="logout-btn"
        @click="onLogout"
      >
        退 出 登 录
      </el-button>
      <div class="footer-tip">
        © 2026 校园二手集市 · 软件工程实践课 · 20232210162
      </div>
    </div>

    <!-- 修改密码 / 绑定手机 抽屉 -->
    <el-drawer
      v-model="pwdDrawerVisible"
      title="修改登录密码"
      size="360px"
    >
      <el-form
        :model="pwdForm"
        label-width="84px"
        size="large"
      >
        <el-form-item label="原密码">
          <el-input
            v-model="pwdForm.oldPwd"
            type="password"
            show-password
          />
        </el-form-item>
        <el-form-item label="新密码">
          <el-input
            v-model="pwdForm.newPwd"
            type="password"
            show-password
          />
        </el-form-item>
        <el-form-item label="确认新密码">
          <el-input
            v-model="pwdForm.confirm"
            type="password"
            show-password
          />
        </el-form-item>
        <div>
          <el-button
            type="primary"
            :loading="pwdSubmitting"
            @click="onSavePassword"
          >
            确认修改
          </el-button>
          <el-button @click="pwdDrawerVisible = false">
            取消
          </el-button>
        </div>
      </el-form>
    </el-drawer>

    <el-drawer
      v-model="phoneDrawerVisible"
      title="绑定 / 更换手机号"
      size="360px"
    >
      <el-form
        :model="phoneForm"
        label-width="84px"
        size="large"
      >
        <el-form-item label="手机号">
          <el-input
            v-model="phoneForm.phone"
            placeholder="11 位手机号"
          />
        </el-form-item>
        <el-form-item label="验证码">
          <div class="otp-row">
            <el-input
              v-model="phoneForm.code"
              placeholder="6 位"
            />
            <el-button
              :disabled="phoneCooldown > 0"
              type="primary"
              plain
              @click="onSendCode"
            >
              {{ phoneCooldown > 0 ? `${phoneCooldown}s 后重试` : '发送验证码' }}
            </el-button>
          </div>
        </el-form-item>
        <div>
          <el-button
            type="primary"
            @click="onSavePhone"
          >
            确认绑定
          </el-button>
          <el-button @click="phoneDrawerVisible = false">
            取消
          </el-button>
        </div>
      </el-form>
    </el-drawer>

    <!-- 协议弹窗 -->
    <el-dialog
      v-model="docVisible"
      :title="docTitle"
      width="640px"
    >
      <div
        class="doc-body"
        v-html="docContent"
      />
    </el-dialog>

    <!-- 反馈弹窗 -->
    <el-dialog
      v-model="feedbackVisible"
      title="用户反馈"
      width="480px"
    >
      <!--
        ★ 把真相说在输入之前 ★
        这里的反馈工单接口尚未接入服务端。原实现会在提交后弹
        「反馈已提交，感谢支持！」—— 而**什么都没发生**：没有请求、没有落库、内容随即被清掉。
        与其让用户以为平台已经收到并在处理，不如在输入前就说清渠道未开通、并指出可用的替代路径。
      -->
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="反馈渠道暂未接入服务端"
        description="本条内容不会上传到平台。如果要对某个商品或某位用户反映问题，请用对应页面上的「举报」——那条链路是通的、会真的进入后台处理队列。"
      />
      <el-input
        v-model="feedbackText"
        class="fb-input"
        type="textarea"
        :rows="5"
        maxlength="500"
        show-word-limit
        placeholder="可以先在这里整理意见，再复制到客服渠道"
      />
      <template #footer>
        <el-button @click="feedbackVisible = false">
          关闭
        </el-button>
        <el-button
          type="primary"
          :disabled="!feedbackText.trim()"
          @click="onCopyFeedback"
        >
          复制内容
        </el-button>
      </template>
    </el-dialog>

    <!-- 勿扰时段 -->
    <el-dialog
      v-model="dndDialogVisible"
      title="勿扰时段"
      width="420px"
      @closed="releaseOverlayFocus"
    >
      <el-form label-width="88px">
        <el-form-item label="启用">
          <el-switch v-model="dnd.enabled" />
        </el-form-item>
        <el-form-item label="开始时间">
          <el-time-picker
            v-model="dndStart"
            format="HH:mm"
            :disabled="!dnd.enabled"
            placeholder="开始"
          />
        </el-form-item>
        <el-form-item label="结束时间">
          <el-time-picker
            v-model="dndEnd"
            format="HH:mm"
            :disabled="!dnd.enabled"
            placeholder="结束"
          />
        </el-form-item>
      </el-form>
      <p class="hint" style="margin-left: 8px">
        时段内收到新消息不弹提醒（支持跨零点，如 23:00 - 07:00）；红点角标仍会保留。
      </p>
      <template #footer>
        <el-button @click="dndDialogVisible = false">取消</el-button>
        <el-button
          type="primary"
          @click="onSaveDnd"
        >
          保存
        </el-button>
      </template>
    </el-dialog>

    <!-- 实名认证 -->
    <el-dialog
      v-model="realNameDialogVisible"
      title="实名认证"
      width="420px"
      @closed="releaseOverlayFocus"
    >
      <el-form label-width="88px">
        <el-form-item label="真实姓名">
          <el-input
            v-model="realNameForm.name"
            maxlength="20"
            placeholder="与身份证一致"
          />
        </el-form-item>
        <el-form-item label="身份证号">
          <el-input
            v-model="realNameForm.idNumber"
            maxlength="18"
            placeholder="仅用于本地校验，只保留后 4 位"
          />
        </el-form-item>
      </el-form>
      <p class="hint" style="margin-left: 8px">
        演示环境仅在本地留存姓名与证件后 4 位，不采集、不上传完整证件号。
      </p>
      <template #footer>
        <el-button @click="realNameDialogVisible = false">取消</el-button>
        <el-button
          type="primary"
          :disabled="!realNameForm.name.trim() || realNameForm.idNumber.length < 15"
          @click="onSaveRealName"
        >
          提交认证
        </el-button>
      </template>
    </el-dialog>

    <!-- 版本信息弹窗 -->
    <el-dialog
      v-model="versionVisible"
      title="版本信息"
      width="420px"
      @closed="releaseOverlayFocus"
    >
      <div class="version-body">
        <div class="ver-row">
          <span class="ver-k">应用名称</span>
          <span class="ver-v">校园二手集市</span>
        </div>
        <div class="ver-row">
          <span class="ver-k">当前版本</span>
          <span class="ver-v tnum">v{{ APP_VERSION }}</span>
        </div>
        <div class="ver-row">
          <span class="ver-k">构建日期</span>
          <span class="ver-v">2026-09-17</span>
        </div>
        <div class="ver-row">
          <span class="ver-k">运行环境</span>
          <span class="ver-v">Web（Vue 3 + Element Plus）</span>
        </div>
        <div class="ver-row">
          <span class="ver-k">服务端</span>
          <span class="ver-v">Spring Boot 3 + MySQL 8</span>
        </div>
        <p class="ver-note">
          本平台为软件工程实践课作品：Vue 3 前端 + Spring Boot 3 后端 + MySQL 8 持久化存储，
          用户、商品、订单、消息等数据均真实落库；仅支付环节为模拟，不涉及真实资金交易。
        </p>
      </div>
      <template #footer>
        <el-button
          type="primary"
          @click="versionVisible = false"
        >
          知道了
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import SettingsGroup from '@/components/common/SettingsGroup.vue'
import SettingsItem from '@/components/common/SettingsItem.vue'
import { useAppStore, ACCENTS, type FontSize, type Accent } from '@/stores/modules/app'
import { useUserStore } from '@/stores/modules/user'
import { useMessageStore } from '@/stores/modules/message'
import { useOnlineStore } from '@/stores/modules/online'
import { releaseOverlayFocus } from '@/utils/focus'
import { formatPrice } from '@/utils/format'
import { changePassword, updatePrivacy } from '@/api/user'

const router = useRouter()
const appStore = useAppStore()
const userStore = useUserStore()
const messageStore = useMessageStore()
const onlineStore = useOnlineStore()

const user = computed(() => userStore.profile || ({} as any))

const APP_VERSION = '1.1.0'

/** 字号三档（el-segmented 选项） */
const FONT_OPTIONS = [
  { label: '标准', value: 'standard' },
  { label: '大', value: 'large' },
  { label: '特大', value: 'xlarge' }
]

// 实名认证状态改为 utils/prefs 的按账号持久化（声明见下方 realNamePref 区块）

// 字号 / 主题联动
const fontSizeLabel = computed(() =>
  appStore.settings.fontSize === 'xlarge' ? '特大' :
  appStore.settings.fontSize === 'large' ? '大' : '标准'
)
/** 当前主题色的展示名（右侧 value 随选中色点联动） */
const accentLabel = computed(() => ACCENTS[appStore.settings.accent]?.label ?? '商务蓝')

function onFontSizeChange(size: FontSize) {
  // setFontSize 内部已同步根字号 + html[data-font]（驱动 body zoom 整体缩放）
  appStore.setFontSize(size)
  ElMessage.success(`字号已切换到${fontSizeLabel.value}`)
}

/**
 * el-switch 的 `update:model-value` 事件签名是 `(val: string | number | boolean) => any`
 * —— 因为开关允许用 `active-value` / `inactive-value` 携带字符串或数字。
 * 本页这些开关都只用布尔语义，模板里写 `(v: boolean) => ...` 会因**参数逆变**
 * 被 vue-tsc 判为不兼容（TS2322：`string` 不能赋给 `boolean`），7 处开关全中招。
 * 统一收口到 onToggle，由它负责把宽类型收敛成布尔。
 */
type ToggleKey =
  | 'allowSearch'
  | 'personalizedAds'
  | 'notifyTrade'
  | 'notifySystem'
  | 'notifyMarketing'

function onToggle(key: ToggleKey, val: string | number | boolean) {
  appStore.updateSetting(key, Boolean(val))
}

/* ========== 在线状态（账号级设置，落库） ========== */

/** 开关的显示值：以服务端返回的 profile.showOnline 为准（缺省视为开启） */
const showOnlineSelf = computed(() => userStore.profile?.showOnline !== false)
const onlineSaving = ref(false)

/**
 * 切换「对外展示在线状态」。
 *
 * ★ 为什么绑定 computed 而不是本地 ref ★
 * 开关直接读 `profile.showOnline`，所以**保存失败时天然回滚** —— 没有改到 profile，
 * 开关自己就弹回原位，不需要额外的出错回滚代码。
 * 反过来若先本地翻转、失败再翻回去，中间会闪一下「已关闭」的假状态。
 *
 * ★ 为什么要 refresh 在线名单 ★
 * 关掉开关后，服务端从名单里排除我；但我自己的浏览器里可能还缓存着
 * 「我在线」这个结论（自己看自己的公开主页、消息页里自己那条会话）。
 * 不刷新的话，界面会与刚存下去的设置自相矛盾。
 */
async function onToggleOnline(v: string | number | boolean) {
  const next = Boolean(v)
  if (onlineSaving.value || next === showOnlineSelf.value) return
  onlineSaving.value = true
  try {
    const saved = await updatePrivacy({ showOnline: next })
    if (userStore.profile) userStore.profile.showOnline = saved
    const myId = userStore.profile?.id
    if (myId) await onlineStore.refresh([myId])
    ElMessage.success(saved ? '其他同学可以看到你在线了' : '已隐藏：其他同学看不到你在线')
  } catch {
    ElMessage.error('设置未保存，请稍后重试')
  } finally {
    onlineSaving.value = false
  }
}

function onDarkChange(v: string | number | boolean) {
  appStore.setDark(Boolean(v))
}

function onClearCache() {
  ElMessageBox.confirm(
    `确认清除本地缓存（约 ${appStore.cacheSizeText}）？这会清掉一些浏览偏好，但不会退出登录。`,
    '清除缓存',
    { type: 'warning' }
  )
    .then(() => {
      appStore.clearCache()
      ElMessage.success('已清除缓存')
    })
    .catch(() => {/* cancel */})
}

function onLogout() {
  ElMessageBox.confirm('确认退出当前账号？', '退出登录', { type: 'warning' })
    .then(() => {
      userStore.logout()
      messageStore.reset()
      ElMessage.success('已退出登录')
      router.push('/login')
    })
    .catch(() => {/* cancel */})
}

/* ========== 修改密码 ========== */
const pwdDrawerVisible = ref(false)
const pwdSubmitting = ref(false)
const pwdForm = reactive({ oldPwd: '', newPwd: '', confirm: '' })
function onChangePassword() { pwdDrawerVisible.value = true }
async function onSavePassword() {
  if (pwdForm.newPwd.length < 6) { ElMessage.warning('新密码至少 6 位'); return }
  if (pwdForm.newPwd !== pwdForm.confirm) { ElMessage.warning('两次输入不一致'); return }
  if (!pwdForm.oldPwd) { ElMessage.warning('请输入原密码'); return }
  pwdSubmitting.value = true
  try {
    // 真实接口：原密码错误 / 新密码与原密码相同等都会被后端拒绝并 toast 出原因
    await changePassword({ oldPassword: pwdForm.oldPwd, newPassword: pwdForm.newPwd })
    pwdDrawerVisible.value = false
    ElMessage.success('密码已修改，下次登录请使用新密码')
    pwdForm.oldPwd = pwdForm.newPwd = pwdForm.confirm = ''
  } catch {
    /* 错误原因已由 request.ts 统一 toast（如「原密码不正确」），这里保持抽屉打开让用户改 */
  } finally {
    pwdSubmitting.value = false
  }
}

/* ========== 勿扰时段 / 实名认证 / 第三方绑定（按账号持久化） ========== */
import { loadDnd, saveDnd, loadRealName, saveRealName, loadOauth, saveOauth, loadPhone, savePhone } from '@/utils/prefs'

/** 手机号展示：优先后端字段，其次本地按账号留存 */
const boundPhone = ref(loadPhone(userStore.profile?.id) || (user.value as any).phone || '')
const phoneLabel = computed(() => boundPhone.value || '未绑定')

const dndDialogVisible = ref(false)
const dnd = reactive(loadDnd(userStore.profile?.id))
// el-time-picker 需要 Date 对象；用当天任意基准日包一层
const dndStart = computed({
  get: () => dndTimeToDate(dnd.start),
  set: (v: Date | null) => { if (v) dnd.start = hmOf(v) }
})
const dndEnd = computed({
  get: () => dndTimeToDate(dnd.end),
  set: (v: Date | null) => { if (v) dnd.end = hmOf(v) }
})

function hmOf(d: Date) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
/** "HH:mm" → 当天该时刻的 Date（供 time-picker 回显） */
function dndTimeToDate(hm: string) {
  const [h, m] = hm.split(':').map(Number)
  const d = new Date()
  d.setHours(h || 0, m || 0, 0, 0)
  return d
}

const dndLabel = computed(() =>
  dnd.enabled ? `${dnd.start} - ${dnd.end}` : '关闭'
)

function onSaveDnd() {
  if (dnd.enabled && dnd.start === dnd.end) {
    ElMessage.warning('起止时间相同视为未配置，请调整')
    return
  }
  saveDnd(userStore.profile?.id, { ...dnd })
  dndDialogVisible.value = false
  ElMessage.success(dnd.enabled ? `勿扰时段已生效：${dnd.start} - ${dnd.end}` : '勿扰时段已关闭')
}

/* ---- 实名认证 ---- */
const realNameDialogVisible = ref(false)
const realNameForm = reactive({ name: '', idNumber: '' })
const realNamePref = ref(loadRealName(userStore.profile?.id))
const realNameVerified = computed(() => !!realNamePref.value)
const realNameLast4 = computed(() => realNamePref.value ? ` ${realNamePref.value.last4}` : '')

function onSaveRealName() {
  const id = realNameForm.idNumber.trim()
  if (!/^[\u4e00-\u9fa5·]{1,20}$/.test(realNameForm.name.trim())) {
    ElMessage.warning('请输入中文姓名')
    return
  }
  if (!/^\d{15}(\d{2}[0-9Xx])?$/.test(id)) {
    ElMessage.warning('身份证号格式不正确')
    return
  }
  const pref = { name: realNameForm.name.trim(), last4: id.slice(-4) }
  saveRealName(userStore.profile?.id, pref)
  realNamePref.value = pref
  realNameDialogVisible.value = false
  realNameForm.name = ''
  realNameForm.idNumber = ''
  ElMessage.success('实名认证完成')
}

/* ---- 第三方账号绑定（演示环境为本地模拟） ---- */
const oauthProvider = ref(loadOauth(userStore.profile?.id))
const oauthBound = computed(() => !!oauthProvider.value)

function onBindOauth() {
  ElMessageBox.confirm(
    '演示环境不会真的跳转第三方，仅在本机记录绑定状态。模拟绑定哪个平台？',
    '第三方账号绑定',
    {
      distinguishCancelAndClose: true,
      confirmButtonText: '绑定微信',
      cancelButtonText: '绑定 QQ'
    }
  )
    .then(() => applyOauth('微信'))
    .catch((action) => {
      // confirm 与 cancel 都算选择了平台，只有右上角关闭才算放弃
      if (action === 'cancel') applyOauth('QQ')
    })
}

function applyOauth(p: '微信' | 'QQ') {
  saveOauth(userStore.profile?.id, p)
  oauthProvider.value = p
  ElMessage.success(`已绑定${p}账号`)
}

function onUnbindOauth() {
  ElMessageBox.confirm(`确认解除${oauthProvider.value}账号的绑定？`, '解绑确认', { type: 'warning' })
    .then(() => {
      saveOauth(userStore.profile?.id, '')
      oauthProvider.value = ''
      ElMessage.success('已解绑')
    })
    .catch(() => {/* cancel */})
}

/* ========== 绑定手机 ========== */
const phoneDrawerVisible = ref(false)
const phoneForm = reactive({ phone: '', code: '' })
const phoneCooldown = ref(0)
let phoneTimer: ReturnType<typeof setInterval> | null = null

function onBindPhone() { phoneDrawerVisible.value = true }

function onSendCode() {
  if (!/^1[3-9]\d{9}$/.test(phoneForm.phone)) {
    ElMessage.warning('请输入合法手机号')
    return
  }
  phoneCooldown.value = 60
  ElMessage.success('验证码已发送（演示环境固定为 123456）')
  phoneTimer = setInterval(() => {
    phoneCooldown.value--
    if (phoneCooldown.value <= 0 && phoneTimer) {
      clearInterval(phoneTimer)
      phoneTimer = null
    }
  }, 1000)
}

function onSavePhone() {
  if (!/^1[3-9]\d{9}$/.test(phoneForm.phone)) { ElMessage.warning('手机号格式不正确'); return }
  if (phoneForm.code !== '123456') { ElMessage.warning('验证码错误（演示环境固定为 123456）'); return }
  /*
   * ★ 这里原来的注释写着「后端 t_user 无 phone 列」—— 那是错的 ★
   * `t_user.phone` 真实存在（`db/schema.sql` 里是 `phone VARCHAR(20) COMMENT '手机号'`，
   * 实体 `User#phone` 也映射了它）。所以「只能存本地」不是事实，
   * 真正缺的是后端一个「绑定 / 更换手机号」的端点（需要短信验证码，属于独立功能模块）。
   *
   * 目前仍落本地（`prefs`，按账号分键，刷新与重登不丢），但必须说清这是**临时方案**。
   * 写错原因的注释比没有注释更危险：后来人会照它以为「数据库缺列」，
   * 于是绕过已有字段另建一套存储 —— 那才真把坑挖深了。
   */
  savePhone(userStore.profile?.id, phoneForm.phone)
  boundPhone.value = phoneForm.phone
  phoneDrawerVisible.value = false
  ElMessage.success('手机号已绑定')
  phoneForm.phone = phoneForm.code = ''
  if (phoneTimer) { clearInterval(phoneTimer); phoneTimer = null; phoneCooldown.value = 0 }
}

/* ========== 协议 / 反馈 ========== */
const docVisible = ref(false)
const docTitle = ref('')
const docContent = ref('')

const DOCS: Record<string, { title: string; body: string }> = {
  service: {
    title: '服务协议',
    body: '<p>欢迎使用「校园二手集市」（以下简称「本平台」）。本协议是您与本平台之间关于使用本平台服务所订立的协议。</p><p>1. 您应保证注册资料的真实性；不得发布违反国家法律法规、违反公序良俗的商品信息。</p><p>2. 校园二手集市仅作为信息展示与交易沟通的中间平台，强烈建议面交并验收。</p><p>3. 凡因交易产生的纠纷，可通过本平台「举报」渠道提交，平台将协助调解但不承担最终责任。</p>'
  },
  privacy: {
    title: '隐私政策',
    body: '<p>我们非常重视您的隐私。本平台仅在为您提供交易撮合所必需的范围内收集信息。</p><p>收集的信息：账号信息（昵称、用户名、头像）、交易行为、信用评价。</p><p>您随时可在「设置 → 隐私设置」中关闭个性化推荐与在线状态展示。</p>'
  },
  priv: {
    title: '个人信息收集与使用',
    body: '<p>查看完整版《个人信息收集与使用清单》。</p><p>注册时收集：用户名（脱敏显示）、密码（哈希存储、不可读）。</p><p>交易时收集：收货地址（自动编码为不可逆标识存储）。</p>'
  }
}

function onViewDocument(key: keyof typeof DOCS) {
  const d = DOCS[key]
  docTitle.value = d.title
  docContent.value = d.body
  docVisible.value = true
}

/*
 * 用户反馈
 *
 * ★ 这里原来是一个「纯假成功」的实现 ★
 *
 * `onSubmitFeedback()` 只做了三件事：清空输入框 → 关弹窗 → 弹「反馈已提交，感谢支持！」。
 * 没有发请求、没有落库、没有留档 —— 用户写的字当场就被抹掉了，
 * 而界面给出的是「平台已经收到」的暗示。这比直接报错更糟：
 * 用户会据此认为问题已被受理，于是不再走别的渠道；平台侧则连「有人提过这件事」都不知道。
 *
 * 现在改成：渠道没开通就直说（提示写在弹窗顶部），并把「提交」换成**真的有用**的动作 —— 复制内容。
 * 等后端有了工单接口，把 `onCopyFeedback` 换成实际请求即可（别忘了同时改掉弹窗里的那段提示）。
 */
const feedbackVisible = ref(false)
const feedbackText = ref('')
function onFeedback() { feedbackVisible.value = true }

async function onCopyFeedback() {
  const text = feedbackText.value.trim()
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // 剪贴板在非 HTTPS / 浏览器策略下会不可用：如实告知，不让用户以为已经复制好了
    ElMessage.warning('当前环境不允许自动复制，请手动选中文本后复制')
    return
  }
  feedbackVisible.value = false
  ElMessage.success('内容已复制，可粘贴到客服渠道发送')
}

/* ========== 版本信息 ========== */
const versionVisible = ref(false)

/*
 * 注销账号
 *
 * ★ 原实现止于一句「注销申请已提交，30 天冷静期内可登录撤销。」★
 * 但后台既没有注销接口、也没有冷静期状态位 —— 用户把两次确认真的走完，
 * 账号照旧能登录、订单照旧在，只是被告知「已提交」。
 *
 * 这是最难被发现的一类假功能：不报错、没有视觉异常，
 * 只有等用户 30 天后回来发现账号还在，才会暴露 —— 而那时已经没法补救信任了。
 *
 * 现在保留两步确认（交互本身是对的，能防误触），但结尾如实说明：
 * 注销尚未接入，并给出真正能走通的路径（联系管理员）。
 */
function onDeleteAccount() {
  ElMessageBox.confirm(
    '注销账号后，您将无法登录、无法查看历史订单与信誉记录，且 30 天冷静期内可撤销。确定继续吗？',
    '申请注销账号',
    { type: 'error', confirmButtonText: '确认注销' }
  )
    .then(() => ElMessageBox.confirm('为了安全，请输入「确认注销」以继续', '二次确认', {
      inputValue: '',
      inputPlaceholder: '请输入「确认注销」',
      inputValidator: (v) => v === '确认注销' || '输入有误'
    }))
    // 二次确认之后不再假装受理：注销流程尚未接入服务端
    .then(() => ElMessageBox.alert(
      '本系统尚未接入账号注销流程，刚才的操作没有提交到服务端，你的账号与数据都还在。'
        + '如需真正注销，请联系管理员人工处理。',
      '暂未接入注销',
      { type: 'info', confirmButtonText: '知道了' }
    ))
    .catch(() => {/* cancel */})
}

onMounted(() => {
  // 启动时同步字号到根节点
  document.documentElement.style.fontSize = appStore.fontSizePx + 'px'
})
onUnmounted(() => {
  if (phoneTimer) { clearInterval(phoneTimer); phoneTimer = null }
})
</script>

<style scoped lang="scss">
.settings-page { max-width: 720px; margin: 0 auto; padding-bottom: 32px; }

/* 反馈弹窗：提示条与输入框之间留出间距，否则两块贴在一起像同一段文字 */
.fb-input { margin-top: 12px; }

.page-title {
  font-size: 22px;
  font-weight: 700;
  margin: 0 0 16px;
  padding-left: 4px;
}

.profile-banner {
  display: flex;
  align-items: center;
  gap: 14px;
  background: linear-gradient(135deg, #fef3c7 0%, #fff5e0 100%);
  border-radius: 16px;
  padding: 18px 20px;
  margin-bottom: 18px;
  cursor: pointer;
  border: 1px solid #fde68a;
  transition: transform 0.2s;
  &:hover { transform: translateY(-1px); box-shadow: 0 6px 16px rgba(146, 64, 14, 0.08); }

  /* 深色模式：转暗琥珀底，避免浅黄底 × 浅色昵称不可读（第廿轮实测） */
  html.dark & {
    background: linear-gradient(135deg, #2b2413 0%, #241f10 100%);
    border-color: #4a3d1a;
    &:hover { box-shadow: 0 6px 16px rgba(0, 0, 0, 0.4); }
  }

  .banner-info { flex: 1; min-width: 0; }
  .name-row { display: flex; align-items: center; gap: 6px; b { font-size: 18px; } }
  .meta { font-size: 12px; color: var(--color-text-mute); margin-top: 4px; span { margin-right: 12px; } }
  .view-profile { display: block; font-size: 12px; color: var(--color-primary); margin-top: 6px; }
  .enter-arrow { font-size: 22px; color: var(--color-text-mute); }
}

.logout-zone {
  margin-top: 20px;
  text-align: center;
  .logout-btn { width: 100%; max-width: 360px; }
  .footer-tip { font-size: 11.5px; color: var(--color-text-mute); margin-top: 18px; }
}

.color-dots { display: flex; gap: 6px; }
.color-dots .dot {
  width: 18px; height: 18px; border-radius: 50%;
  cursor: pointer;
  border: 2px solid transparent;
  &.active { border-color: var(--color-primary); transform: scale(1.1); }
}

.otp-row { display: flex; gap: 8px; width: 100%; }
.otp-row .el-input { flex: 1; }

.doc-body {
  font-size: 14px;
  color: var(--color-text-secondary);
  line-height: 1.8;
  p { margin: 8px 0; }
}

.version-body {
  .ver-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 0;
    border-bottom: 1px solid var(--border-color);
    &:last-of-type { border-bottom: none; }
  }
  .ver-k { color: var(--color-text-mute); font-size: 13px; }
  .ver-v { color: var(--color-text-primary); font-size: 14px; font-weight: 500; }
  .ver-note {
    margin-top: 12px;
    font-size: 12px;
    color: var(--color-text-mute);
    line-height: 1.6;
  }
}

.version-body {
  .ver-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 0;
    border-bottom: 1px solid var(--border-color);
    &:last-of-type { border-bottom: none; }
  }
  .ver-k { color: var(--color-text-mute); font-size: 13px; }
  .ver-v { color: var(--color-text-primary); font-size: 14px; font-weight: 500; }
  .ver-note {
    margin-top: 12px;
    font-size: 12px;
    color: var(--color-text-mute);
    line-height: 1.6;
  }
}
</style>
