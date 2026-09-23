/**
 * 通用聊天窗口组件
 * 被「商品详情页 · 联系卖家抽屉」和「消息中心页面」复用
 */
<template>
  <div class="chat-window">
    <!-- 顶部：对方信息 / 关联商品 -->
    <div
      v-if="showHeader"
      class="chat-head"
    >
      <el-avatar
        :src="peerAvatar"
        :size="36"
      />
      <div class="head-info">
        <div class="peer-name">
          {{ peerName }}
        </div>
        <div
          v-if="goodsTitle"
          class="goods-line"
        >
          <el-image
            v-if="goodsCover"
            :src="goodsCover"
            fit="cover"
            class="mini-cover"
          />
          <span class="goods-title">{{ goodsTitle }}</span>
        </div>
      </div>
    </div>

    <!-- 消息列表 -->
    <div
      ref="scrollRef"
      v-loading="loading"
      class="chat-body"
    >
      <template v-if="messages.length">
        <div
          v-for="m in messages"
          :key="m.id"
          class="msg-row"
          :class="{ mine: m.fromUserId === myUserId }"
        >
          <el-avatar
            :src="m.fromUserId === myUserId ? myAvatar : peerAvatar"
            :size="32"
          />
          <div class="bubble-wrap">
            <div class="bubble">
              {{ m.content }}
            </div>
            <div class="time">
              {{ formatRelative(m.createTime) }}
            </div>
          </div>
        </div>
      </template>
      <EmptyState
        v-else-if="!loading"
        icon="💬"
        title="还没有聊天记录"
        :description="emptyText"
      />
    </div>

    <!-- 快捷话术 -->
    <div class="quick-row">
      <el-tag
        v-for="q in quickReplies"
        :key="q"
        class="quick-tag"
        size="small"
        effect="plain"
        @click="draft = q"
      >
        {{ q }}
      </el-tag>
    </div>

    <!-- 输入区 -->
    <div class="chat-foot">
      <el-input
        v-model="draft"
        type="textarea"
        :rows="2"
        resize="none"
        maxlength="200"
        show-word-limit
        placeholder="输入消息，Enter 发送 / Shift + Enter 换行"
        @keydown.enter.exact.prevent="onSend"
      />
      <el-button
        type="primary"
        :disabled="!draft.trim()"
        :loading="sending"
        @click="onSend"
      >
        发送
      </el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
/*
 * ============================ 调用方契约（放开游客浏览后补的说明） ============================
 *
 * guest-guard: caller-contract
 *
 * ↑ 上面那行是**机器可读标记**，别删。
 *   `.workbuddy/audit-guest-requests.mjs` 靠它认领这个组件：
 *   见到标记，就把「这个调用点有没有被守卫」转成对**调用方**的求证
 *   （调用方是不是 requireAuth 路由？或者开启本组件的那个变量，
 *    每次置真是不是都在有守卫的函数里？）。
 *   没有这个标记，审计只能把它当成「无守卫的高风险点」—— 那是**假命中**，
 *   而一个总是喊狼来了的审计等于没有审计（历史上就因为守卫被抽成函数，
 *   全量误报了 6 处，详见审计脚本头部）。
 *
 * ★ 本组件**不自带登录判断**，它假定调用方已经保证「用户已登录」★
 *
 * 依据：它调的 `fetchMessages` / `sendMessage` 都是需要登录的接口，
 * 而 `api/request.ts` 对 401 的处理是「提示『登录状态已过期』+ 清 token + 跳登录页」——
 * 若被未登录的用户触达，会弹出一句自相矛盾的提示并把人踢走。
 *
 * 当前的调用点**都满足这个契约**（改动前逐处核过，不是想当然）：
 *   ① `views/goods/Detail.vue` —— 聊天抽屉，只能由 `onContactSeller()` 打开，
 *      而那个函数现在走 `requireLogin('联系卖家')`，游客打不开抽屉，组件不会被挂载；
 *   ② `views/message/Index.vue` —— 消息中心，路由 `meta.requireAuth: true`，
 *      游客进不了这一页。
 *
 * ⚠️ **以后要把本组件复用到任何公开页面（如商品详情页直接内嵌聊天区）之前**，
 *    必须先在这里（或调用处）补一道登录守卫，否则就是上面那个「游客被弹登录已过期」的坑。
 *    这也是为什么把契约写在组件顶部而不是留给调用处自己记得。
 * ==========================================================================================
 */
import { nextTick, ref, watch } from 'vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { fetchMessages, sendMessage } from '@/api/message'
import { formatRelative } from '@/utils/format'
import type { Message } from '@/types'

interface Props {
  sessionId: string
  myUserId: number
  myAvatar?: string
  peerId: number
  peerName: string
  peerAvatar?: string
  goodsId?: number
  goodsTitle?: string
  goodsCover?: string
  showHeader?: boolean
  emptyText?: string
}
const props = withDefaults(defineProps<Props>(), {
  myAvatar: '',
  peerAvatar: '',
  showHeader: true,
  emptyText: '发条消息打个招呼吧～'
})

const emit = defineEmits<{ sent: [Message] }>()

const messages = ref<Message[]>([])
const draft = ref('')
const loading = ref(false)
const sending = ref(false)
const scrollRef = ref<HTMLElement>()

const quickReplies = ['还在吗？', '能便宜点吗', '可以面交吗', '什么时候方便']

async function load(showLoading = true) {
  if (!props.sessionId) return
  if (showLoading) loading.value = true
  try {
    messages.value = await fetchMessages(props.sessionId, props.myUserId)
    await scrollToBottom()
  } finally {
    loading.value = false
  }
}

async function onSend() {
  const content = draft.value.trim()
  if (!content) return
  sending.value = true
  try {
    const msg = await sendMessage({
      sessionId: props.sessionId,
      fromUserId: props.myUserId,
      toUserId: props.peerId,
      content,
      goods: props.goodsId
        ? { id: props.goodsId, title: props.goodsTitle ?? '', cover: props.goodsCover ?? '' }
        : undefined
    })
    messages.value.push(msg)
    draft.value = ''
    emit('sent', msg)
    await scrollToBottom()
  } catch (e: any) {
    ElMessage.error(e?.message || '发送失败')
  } finally {
    sending.value = false
  }
}

async function scrollToBottom() {
  await nextTick()
  const el = scrollRef.value
  if (el) el.scrollTop = el.scrollHeight
}

watch(() => props.sessionId, () => load())

/** 供父组件外部刷新（如收到轮询到的新消息） */
defineExpose({ reload: () => load(false) })

load()
</script>

<style scoped lang="scss">
.chat-window {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 420px;
}

.chat-head {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-soft);
  border-radius: 8px 8px 0 0;
  .head-info { flex: 1; min-width: 0; }
  .peer-name { font-weight: 600; font-size: 14px; }
  .goods-line {
    display: flex; align-items: center; gap: 6px;
    margin-top: 4px;
    .mini-cover { width: 26px; height: 26px; border-radius: 4px; flex-shrink: 0; }
    .goods-title {
      font-size: 12px; color: var(--color-text-mute);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
  }
}

.chat-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 14px;
  background: #fbfcfe;
  min-height: 260px;
  max-height: 460px;
}

.msg-row {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
  align-items: flex-start;

  .bubble-wrap { max-width: 72%; }
  .bubble {
    background: #fff;
    border: 1px solid var(--border-color);
    border-radius: 0 10px 10px 10px;
    padding: 9px 13px;
    font-size: 14px;
    line-height: 1.6;
    color: var(--color-text-primary);
    word-break: break-word;
    white-space: pre-wrap;
  }
  .time {
    font-size: 11px;
    color: var(--color-text-mute);
    margin-top: 4px;
  }

  &.mine {
    flex-direction: row-reverse;
    .bubble {
      background: var(--color-primary);
      border-color: var(--color-primary);
      color: #fff;
      border-radius: 10px 0 10px 10px;
    }
    .time { text-align: right; }
  }
}

.quick-row {
  display: flex; gap: 6px; flex-wrap: wrap;
  padding: 8px 14px;
  border-top: 1px dashed var(--border-color);
  .quick-tag { cursor: pointer; &:hover { color: var(--color-primary); border-color: var(--color-primary); } }
}

.chat-foot {
  display: flex; gap: 10px; align-items: flex-end;
  padding: 10px 14px 14px;
  border-top: 1px solid var(--border-color);
  background: #fff;
  border-radius: 0 0 8px 8px;
  :deep(.el-textarea) { flex: 1; }
  .el-button { height: 54px; }
}
</style>
