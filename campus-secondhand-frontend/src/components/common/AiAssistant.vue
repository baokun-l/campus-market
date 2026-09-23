<!--
  智能客服悬浮入口（Spring AI / POST /ai/chat）

  为什么做成独立组件：后端 Spring AI 早就实现了 `/ai/chat`，
  但界面上没有任何入口，等于这个能力在系统里不可达、答辩时也演示不出来。
  做成自包含的悬浮组件后，只需要在 BasicLayout 里挂一次，
  所有页面（含未登录用户看不到按钮）都自动具备智能客服。

  按钮只在登录后出现 —— `/ai/chat` 不在后端公开路由白名单里，未登录调用必然 401。

  ★ 判断用 `isLoggedIn`，不是 `token`（D9）★
  D9 之后真实模式的凭据在 HttpOnly Cookie 里，`token` 恒为空串；
  若沿用 `userStore.token` 做 `v-if`，这个悬浮入口会**永远不显示** ——
  后端的 `/ai/**` 完全可用，但界面上没有任何入口，
  等于整条 AI 能力在真实模式下不可达（答辩时也就演示不出来）。
  讽刺的是这段注释上一句原本就在强调这件事，只是自己被同一个坑绊住了。
-->
<template>
  <div
    v-if="userStore.isLoggedIn"
    class="ai-assistant"
  >
    <el-drawer
      v-model="open"
      :with-header="false"
      :size="panelSize"
      append-to-body
      class="ai-drawer"
    >
      <div class="ai-panel">
        <header class="ai-panel-head">
          <div class="ai-panel-title">
            <span class="ai-badge">AI</span>
            <span>智能客服</span>
          </div>
          <p class="ai-panel-sub">交易流程 / 支付发货 / 退款 / 商品审核 / 举报处理</p>
        </header>

        <div
          ref="listRef"
          class="ai-panel-body"
        >
          <div
            v-for="(m, i) in messages"
            :key="i"
            class="ai-msg"
            :class="m.role === 'me' ? 'ai-msg--me' : 'ai-msg--bot'"
          >
            <div class="ai-bubble">{{ m.content }}</div>
          </div>
          <div
            v-if="pending"
            class="ai-msg ai-msg--bot"
          >
            <div class="ai-bubble ai-bubble--typing">
              <i /><i /><i />
            </div>
          </div>
        </div>

        <div class="ai-panel-foot">
          <div class="ai-quick">
            <button
              v-for="q in QUICK_ASKS"
              :key="q"
              type="button"
              class="ai-chip"
              :disabled="pending"
              @click="ask(q)"
            >
              {{ q }}
            </button>
          </div>
          <div class="ai-input-row">
            <el-input
              v-model="draft"
              placeholder="输入你的问题…"
              :disabled="pending"
              maxlength="200"
              @keyup.enter="ask(draft)"
            />
            <el-button
              type="primary"
              :loading="pending"
              :disabled="!draft.trim()"
              @click="ask(draft)"
            >
              发送
            </el-button>
          </div>
        </div>
      </div>
    </el-drawer>

    <button
      v-show="!open"
      type="button"
      class="ai-fab"
      title="智能客服"
      @click="open = true"
    >
      <span class="ai-fab-emoji">🤖</span>
      <span class="ai-fab-label">智能客服</span>
    </button>
  </div>
</template>

<script setup lang="ts">
import { nextTick, ref, watch, onUnmounted } from 'vue'
import { aiChat } from '@/api/ai'
import { useUserStore } from '@/stores/modules/user'

const userStore = useUserStore()

const QUICK_ASKS = ['怎么退款？', '商品多久审核通过？', '怎么举报违规商品？', '信用分怎么算？']

interface ChatTurn {
  role: 'me' | 'bot'
  content: string
}

const open = ref(false)
const draft = ref('')
const pending = ref(false)
const listRef = ref<HTMLElement | null>(null)
const panelSize = ref('360px')

const messages = ref<ChatTurn[]>([
  {
    role: 'bot',
    content:
      '你好，我是「校园二手集市」的智能客服。关于交易流程、支付发货、退款、商品审核与举报处理的问题都可以问我。'
  }
])

/** 窄屏时抽屉占满宽度，避免遮住整页后连关闭按钮都点不到 */
function syncPanelSize() {
  panelSize.value = `${Math.min(360, window.innerWidth - 24)}px`
}
syncPanelSize()
if (typeof window !== 'undefined') {
  window.addEventListener('resize', syncPanelSize)
}

onUnmounted(() => {
  if (typeof window !== 'undefined') window.removeEventListener('resize', syncPanelSize)
})

async function scrollToEnd() {
  await nextTick()
  const el = listRef.value
  if (el) el.scrollTop = el.scrollHeight
}

watch(open, (v) => {
  if (v) scrollToEnd()
})

async function ask(text: string) {
  const q = text.trim()
  if (!q || pending.value) return
  draft.value = ''
  messages.value.push({ role: 'me', content: q })
  pending.value = true
  await scrollToEnd()
  try {
    const reply = await aiChat(q)
    messages.value.push({ role: 'bot', content: reply || '抱歉，我暂时没有想好怎么回答，请换个说法试试。' })
  } catch {
    // request.ts 已经弹过统一错误提示，这里只补一条可读的兜底气泡
    messages.value.push({ role: 'bot', content: '智能客服暂时不可用，请稍后再试或联系人工客服。' })
  } finally {
    pending.value = false
    await scrollToEnd()
  }
}
</script>

<style scoped>
.ai-assistant {
  /* 组件挂载在布局根节点内，用 fixed 定位脱离文档流 */
  position: relative;
  z-index: 2000;
}

.ai-fab {
  position: fixed;
  right: 22px;
  bottom: 26px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 44px;
  padding: 0 16px 0 12px;
  border: none;
  border-radius: 22px;
  background: linear-gradient(135deg, #4a7cf0, #7a5cf0);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 8px 22px rgba(74, 124, 240, 0.32);
  transition: transform 0.18s ease, box-shadow 0.18s ease;
}

.ai-fab:hover {
  transform: translateY(-2px);
  box-shadow: 0 12px 26px rgba(74, 124, 240, 0.4);
}

.ai-fab-emoji {
  font-size: 17px;
  line-height: 1;
}

@media (max-width: 640px) {
  .ai-fab-label {
    display: none;
  }
  .ai-fab {
    padding: 0 13px;
    border-radius: 50%;
    width: 48px;
    height: 48px;
    justify-content: center;
  }
}

.ai-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  margin: -20px;
}

.ai-panel-head {
  padding: 18px 18px 12px;
  border-bottom: 1px solid var(--color-border, #ebeef5);
  background: linear-gradient(135deg, rgba(74, 124, 240, 0.08), rgba(122, 92, 240, 0.06));
}

.ai-panel-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 600;
  color: var(--color-text, #303133);
}

.ai-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 18px;
  padding: 0 6px;
  border-radius: 5px;
  background: linear-gradient(135deg, #4a7cf0, #7a5cf0);
  color: #fff;
  font-size: 11px;
  letter-spacing: 0.4px;
}

.ai-panel-sub {
  margin: 6px 0 0;
  font-size: 12px;
  color: var(--color-text-mute, #909399);
  line-height: 1.5;
}

.ai-panel-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 16px 4px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ai-msg {
  display: flex;
}

.ai-msg--me {
  justify-content: flex-end;
}

.ai-bubble {
  max-width: 84%;
  padding: 9px 12px;
  border-radius: 12px;
  font-size: 13px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
}

.ai-msg--bot .ai-bubble {
  background: var(--color-fill, #f4f4f5);
  color: var(--color-text, #303133);
  border-top-left-radius: 4px;
}

.ai-msg--me .ai-bubble {
  background: linear-gradient(135deg, #4a7cf0, #7a5cf0);
  color: #fff;
  border-top-right-radius: 4px;
}

.ai-bubble--typing {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 46px;
  justify-content: center;
}

.ai-bubble--typing i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #b6b9c0;
  animation: ai-blink 1.2s infinite ease-in-out;
}

.ai-bubble--typing i:nth-child(2) {
  animation-delay: 0.18s;
}

.ai-bubble--typing i:nth-child(3) {
  animation-delay: 0.36s;
}

@keyframes ai-blink {
  0%, 60%, 100% { opacity: 0.28; transform: translateY(0); }
  30% { opacity: 1; transform: translateY(-2px); }
}

.ai-panel-foot {
  padding: 10px 16px 16px;
  border-top: 1px solid var(--color-border, #ebeef5);
}

.ai-quick {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}

.ai-chip {
  padding: 4px 10px;
  border: 1px solid var(--color-border, #dcdfe6);
  border-radius: 14px;
  background: transparent;
  color: var(--color-text-mute, #606266);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.16s ease;
}

.ai-chip:hover:not(:disabled) {
  border-color: #4a7cf0;
  color: #4a7cf0;
}

.ai-chip:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.ai-input-row {
  display: flex;
  gap: 8px;
}
</style>
