<template>
  <PageContainer
    back
    title="消息中心"
    subtitle="与买家 / 卖家的沟通都在这里"
  >
    <template #actions>
      <el-tag
        v-if="messageStore.unread > 0"
        type="danger"
        effect="light"
      >
        {{ messageStore.unread }} 条未读
      </el-tag>
      <el-button @click="messageStore.loadSessions()">
        <el-icon><Refresh /></el-icon> 刷新
      </el-button>
    </template>

    <div class="msg-layout">
      <!-- 左：会话列表 -->
      <aside
        class="session-list"
        :class="{ hidden: isMobile && activeSession }"
      >
        <el-input
          v-model="kw"
          placeholder="搜索联系人 / 商品"
          clearable
          class="session-search"
        >
          <template #prefix>
            <el-icon><Search /></el-icon>
          </template>
        </el-input>

        <el-scrollbar height="520px">
          <div
            v-if="!filteredSessions.length"
            class="no-session"
          >
            <EmptyState
              icon="💬"
              title="还没有消息"
              description="在商品详情页点「联系卖家」开始沟通"
            />
          </div>
          <div
            v-for="s in filteredSessions"
            :key="s.id"
            class="session-item"
            :class="{ active: s.id === activeSession?.id }"
            @click="onSelect(s)"
          >
            <el-badge
              :value="s.unread"
              :hidden="s.unread === 0"
              class="badge-wrap"
            >
              <el-avatar
                :src="s.peerAvatar"
                :size="42"
              />
              <!--
                在线小绿点：数据来自服务端在线名单（GET /users/online）。
                不再受「设置 → 显示在线状态」的本地开关控制 —— 那个开关的语义是
                「让不让人看到我在线」，不是「我要不要看别人」；用它来 gate 这里的渲染
                会让用户关掉自己的可见性时，连别人在不在线都看不见了。
              -->
              <span
                v-if="onlineStore.isOnline(s.peerId)"
                class="online-dot"
                title="在线"
              />
            </el-badge>
            <div class="session-info">
              <div class="row1">
                <span class="peer">{{ s.peerName }}</span>
                <span class="time">{{ formatRelative(s.lastTime) }}</span>
              </div>
              <div class="row2">
                {{ s.lastMessage || '（暂无消息）' }}
              </div>
            </div>
            <el-button
              class="del-btn"
              text
              size="small"
              type="danger"
              @click.stop="onDelete(s)"
            >
              <el-icon><Delete /></el-icon>
            </el-button>
          </div>
        </el-scrollbar>
      </aside>

      <!-- 右：聊天窗口 -->
      <div
        class="chat-panel"
        :class="{ hidden: isMobile && !activeSession }"
      >
        <template v-if="activeSession && myUserId">
          <el-button
            v-if="isMobile"
            text
            size="small"
            class="back-btn"
            @click="activeSession = null"
          >
            <el-icon><ArrowLeft /></el-icon> 返回会话列表
          </el-button>
          <ChatWindow
            ref="chatRef"
            :session-id="activeSession.id"
            :my-user-id="myUserId"
            :my-avatar="userStore.avatar"
            :peer-id="activeSession.peerId"
            :peer-name="activeSession.peerName"
            :peer-avatar="activeSession.peerAvatar"
            :goods-id="activeSession.goodsId"
            :goods-title="activeSession.goodsTitle"
            :goods-cover="activeSession.goodsCover"
            @sent="onSent"
          />
        </template>
        <EmptyState
          v-else
          icon="📨"
          title="选择一个会话开始聊天"
          description="左侧列出了你与买家 / 卖家的所有沟通记录"
        />
      </div>
    </div>
  </PageContainer>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import PageContainer from '@/components/common/PageContainer.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import ChatWindow from '@/components/business/ChatWindow.vue'
import { useUserStore } from '@/stores/modules/user'
import { useMessageStore } from '@/stores/modules/message'
import { deleteSession, markSessionRead } from '@/api/message'
import { formatRelative } from '@/utils/format'
import { createVisiblePoller } from '@/utils/visiblePoll'
import { useOnlineStore } from '@/stores/modules/online'
import type { ChatSession, Message } from '@/types'

const route = useRoute()
const userStore = useUserStore()
const messageStore = useMessageStore()
/** 在线名单：真实在线状态来自服务端，见 stores/modules/online.ts */
const onlineStore = useOnlineStore()

const kw = ref('')
const activeSession = ref<ChatSession | null>(null)
const chatRef = ref<InstanceType<typeof ChatWindow>>()
const isMobile = ref(false)
/**
 * 消息轮询器（L6）。
 *
 * ★ 用 createVisiblePoller 而不是裸 setInterval ★，因为它多守两件事：
 *   ① 串行化：上一轮（三个请求）没跑完就不再排下一轮。原先 5 秒一发的 setInterval
 *      遇到慢请求会让几轮并发打出去，而响应回来的顺序不保证 ——
 *      后回来的旧快照会盖掉先回来的新快照，表现为消息列表偶尔「跳回上一条」。
 *   ② 可见性：标签页藏起来就停表，切回来立刻补一次。原先切走之后仍在空转，
 *      切回来手上还是离开那一刻的旧数据。
 *
 * 仍然是轮询而不是推送 ——「换 WebSocket」要后端加长连接、心跳、重连、鉴权续期，
 * 属换架构而非修缺陷，不在本轮范围。
 */
const poller = createVisiblePoller({
  intervalMs: 5000,
  async tick() {
    await messageStore.loadSessions()
    syncOnline()
    await chatRef.value?.reload()
  },
})

const myUserId = computed(() => userStore.profile?.id ?? 0)

const filteredSessions = computed(() => {
  const k = kw.value.trim().toLowerCase()
  if (!k) return messageStore.sessions
  return messageStore.sessions.filter(
    (s) =>
      s.peerName.toLowerCase().includes(k) ||
      (s.goodsTitle ?? '').toLowerCase().includes(k)
  )
})

function handleResize() {
  isMobile.value = window.innerWidth < 768
}

async function onSelect(s: ChatSession) {
  activeSession.value = s
  await markSessionRead(s.id, myUserId.value)
  await messageStore.loadSessions()
  // 与列表状态同步
  const latest = messageStore.sessions.find((x) => x.id === s.id)
  if (latest) activeSession.value = latest
}

function onSent() {
  messageStore.loadSessions()
}

async function onDelete(s: ChatSession) {
  try {
    await ElMessageBox.confirm(`确认删除与「${s.peerName}」的会话？`, '提示', { type: 'warning' })
  } catch {
    return
  }
  await deleteSession(s.id)
  if (activeSession.value?.id === s.id) activeSession.value = null
  await messageStore.loadSessions()
  ElMessage.success('会话已删除')
}

/**
 * 拉取当前会话列表里各位对端的在线状态。
 *
 * 整列 id 合成**一次**请求（store 内部还会按 TTL 去重），
 * 不是每个会话各发一次 —— 否则打开消息页就是几十个并发请求。
 */
function syncOnline() {
  onlineStore.ensure(messageStore.sessions.map((s) => s.peerId))
}

onMounted(async () => {
  handleResize()
  window.addEventListener('resize', handleResize)
  await messageStore.loadSessions()
  syncOnline()

  // 若从商品详情页跳来，自动选中目标会话
  const target = messageStore.pendingSessionId || (route.query.session as string)
  if (target) {
    const s = messageStore.sessions.find((x) => x.id === target)
    if (s) await onSelect(s)
    messageStore.setPendingSession(null)
  } else if (!isMobile.value && messageStore.sessions.length) {
    await onSelect(messageStore.sessions[0])
  }

  // 轮询未读 / 新消息（真实项目换成 WebSocket 推送；这里至少不叠加、不空转）
  poller.start()
})

onUnmounted(() => {
  window.removeEventListener('resize', handleResize)
  poller.stop()
})
</script>

<style scoped lang="scss">
.msg-layout {
  display: grid;
  grid-template-columns: 300px 1fr;
  gap: 16px;
  min-height: 560px;

  @media (max-width: 768px) {
    grid-template-columns: 1fr;
  }
}

.session-list {
  border-right: 1px solid var(--border-color);
  padding-right: 12px;
  &.hidden { display: none; }

  .session-search { margin-bottom: 10px; }
  .no-session { padding-top: 20px; }
}

.session-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 10px;
  border-radius: 8px;
  cursor: pointer;
  position: relative;
  transition: background 0.15s;

  &:hover { background: var(--bg-soft); }
  &.active { background: var(--color-primary-light); }

  .badge-wrap {
    flex-shrink: 0;
    position: relative;
  }

  /* 会话头像右下角的在线小绿点（隐私开关 showOnline 关闭时不渲染） */
  .online-dot {
    position: absolute;
    right: 0;
    bottom: 2px;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #10b981;
    border: 2px solid #fff;
  }
  :global(.dark) .online-dot { border-color: #1a1d22; }

  .session-info {
    flex: 1;
    min-width: 0;
    .row1 {
      display: flex; justify-content: space-between; align-items: baseline;
      gap: 6px;
      .peer { font-size: 14px; font-weight: 600; }
      .time { font-size: 11px; color: var(--color-text-mute); flex-shrink: 0; }
    }
    .row2 {
      margin-top: 2px;
      font-size: 12.5px;
      color: var(--color-text-mute);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
  }

  .del-btn { opacity: 0; transition: opacity 0.15s; flex-shrink: 0; }
  &:hover .del-btn { opacity: 1; }
}

.chat-panel {
  min-width: 0;
  &.hidden { display: none; }
  .back-btn { margin-bottom: 8px; }
}
</style>
