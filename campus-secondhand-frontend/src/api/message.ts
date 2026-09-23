/**
 * 私信 / 消息中心 API
 *
 * 设计要点
 * ---------
 * 会话 id 规则：s_{goodsId}_{minUserId}_{maxUserId}
 * 因此「我发给卖家」和「卖家收到我的消息」在数据层是**同一条会话记录**，
 * 双方各自登录后都能在自己的消息中心看到 —— 这正是"被联系人在哪能看见"的答案。
 */
import { request } from './request'
import { mockHelpers, mockUsersExport, makeSessionId, mockAutoReply } from './mock'
import type { ChatSession, Message, PageResult, StartChatPayload } from '@/types'

const USE_MOCK = import.meta.env.VITE_USE_MOCK === 'true'

/* ====================================================================
 * 会话列表
 * ==================================================================== */

/** 拉取「我参与的所有会话」，按最后消息时间倒序 */
export async function fetchSessions(myUserId: number): Promise<ChatSession[]> {
  if (USE_MOCK) {
    await mockHelpers.delay(260)
    const list = mockHelpers.getSessions()
      .filter((s) => sessionParticipants(s.id).includes(myUserId))
      .map((s) => ({
        ...s,
        unread: unreadCountOf(s.id, myUserId)
      }))
    return list.sort((a, b) => +new Date(b.lastTime) - +new Date(a.lastTime))
  }
  return request({ url: '/messages/sessions', params: { myUserId } })
}

/** 未读总数 */
export async function fetchUnreadTotal(myUserId: number): Promise<number> {
  if (USE_MOCK) {
    await mockHelpers.delay(120)
    return mockHelpers
      .getMessages()
      .filter((m) => m.toUserId === myUserId && !m.read)
      .length
  }
  return request({ url: '/messages/unread', params: { myUserId } })
}

/* ====================================================================
 * 会话消息
 * ==================================================================== */

/** 拉取某会话的全部消息（拉取即把「发给我的」标记为已读） */
export async function fetchMessages(sessionId: string, myUserId: number): Promise<Message[]> {
  if (USE_MOCK) {
    await mockHelpers.delay(200)
    const list = mockHelpers.getMessages()
    // 标记已读
    let changed = false
    for (const m of list) {
      if (m.sessionId === sessionId && m.toUserId === myUserId && !m.read) {
        m.read = true
        changed = true
      }
    }
    if (changed) mockHelpers.setMessages(list)
    return list
      .filter((m) => m.sessionId === sessionId)
      .sort((a, b) => +new Date(a.createTime) - +new Date(b.createTime))
  }
  return request({ url: `/messages/sessions/${sessionId}`, params: { myUserId } })
}

/* ====================================================================
 * 发送消息
 * ==================================================================== */

/**
 * 发送一条消息；若会话不存在则自动创建
 * @returns 生成的消息实体
 */
export async function sendMessage(payload: {
  sessionId?: string
  fromUserId: number
  toUserId: number
  content: string
  goods?: { id: number; title: string; cover: string }
}): Promise<Message> {
  if (USE_MOCK) {
    await mockHelpers.delay(180)
    const sessionId =
      payload.sessionId || makeSessionId(payload.fromUserId, payload.toUserId, payload.goods?.id ?? 0)

    const msg: Message = {
      id: mockHelpers.nextMessageId(),
      sessionId,
      fromUserId: payload.fromUserId,
      toUserId: payload.toUserId,
      content: payload.content,
      createTime: new Date().toISOString(),
      read: false
    }
    mockHelpers.setMessages([...mockHelpers.getMessages(), msg])

    // 会话不存在则新建（从商品详情页首次联系卖家走这里）
    const sessions = mockHelpers.getSessions()
    if (!sessions.some((s) => s.id === sessionId)) {
      const peer = mockUsersExport.find((u) => u.id === payload.toUserId)
      sessions.unshift({
        id: sessionId,
        peerId: payload.toUserId,
        peerName: peer?.nickname ?? '对方用户',
        peerAvatar: peer?.avatar ?? '',
        goodsId: payload.goods?.id,
        goodsTitle: payload.goods?.title,
        goodsCover: payload.goods?.cover,
        lastMessage: payload.content,
        lastTime: msg.createTime,
        unread: 0
      })
      mockHelpers.setSessions(sessions)
    }

    // 【Mock 专属】模拟对方 1.2s 后自动回复，便于单机演示双向收发
    simulatePeerReply(sessionId, payload.toUserId, payload.fromUserId)

    return msg
  }
  return request({ url: '/messages', method: 'POST', data: payload, showLoading: false })
}

/**
 * 根据「对方用户 + 商品」找到或创建会话，返回会话 id
 * 商品详情页点「联系卖家」时调用
 */
export async function openSession(payload: StartChatPayload & { myUserId: number }): Promise<string> {
  const sessionId = makeSessionId(payload.myUserId, payload.toUserId, payload.goodsId ?? 0)

  if (USE_MOCK) {
    await mockHelpers.delay(120)
    const sessions = mockHelpers.getSessions()
    if (!sessions.some((s) => s.id === sessionId)) {
      sessions.unshift({
        id: sessionId,
        peerId: payload.toUserId,
        peerName: payload.toUserName,
        peerAvatar: payload.toUserAvatar,
        goodsId: payload.goodsId,
        goodsTitle: payload.goodsTitle,
        goodsCover: payload.goodsCover,
        lastMessage: payload.firstMessage || '',
        lastTime: new Date().toISOString(),
        unread: 0
      })
      mockHelpers.setSessions(sessions)
    }
    return sessionId
  }
  return request({ url: '/messages/sessions/open', method: 'POST', data: payload })
}

/** 标记会话已读 */
export async function markSessionRead(sessionId: string, myUserId: number): Promise<void> {
  if (USE_MOCK) {
    await mockHelpers.delay(80)
    const list = mockHelpers.getMessages()
    let changed = false
    for (const m of list) {
      if (m.sessionId === sessionId && m.toUserId === myUserId && !m.read) {
        m.read = true
        changed = true
      }
    }
    if (changed) mockHelpers.setMessages(list)
    return
  }
  return request({ url: `/messages/sessions/${sessionId}/read`, method: 'POST', params: { myUserId } })
}

/** 删除会话（仅本地移除，Mock 模式） */
export async function deleteSession(sessionId: string): Promise<void> {
  if (USE_MOCK) {
    await mockHelpers.delay(180)
    mockHelpers.setSessions(mockHelpers.getSessions().filter((s) => s.id !== sessionId))
    mockHelpers.setMessages(mockHelpers.getMessages().filter((m) => m.sessionId !== sessionId))
    return
  }
  return request({ url: `/messages/sessions/${sessionId}`, method: 'DELETE' })
}

/* ====================================================================
 * 内部工具
 * ==================================================================== */

/** 从会话 id 反解出参与者 userId 列表 */
function sessionParticipants(sessionId: string): number[] {
  const parts = sessionId.split('_')
  if (parts.length < 4) return []
  return [Number(parts[2]), Number(parts[3])].filter((n) => !Number.isNaN(n))
}

/** 统计某会话中「发给我的未读」条数 */
function unreadCountOf(sessionId: string, myUserId: number): number {
  return mockHelpers
    .getMessages()
    .filter((m) => m.sessionId === sessionId && m.toUserId === myUserId && !m.read)
    .length
}

/**
 * 【Mock 专属】模拟对方自动回复
 * 真实项目里由对方客户端发送或 WebSocket 推送，这里仅为单机演示
 */
function simulatePeerReply(sessionId: string, peerId: number, myUserId: number): void {
  setTimeout(() => {
    const msg: Message = {
      id: mockHelpers.nextMessageId(),
      sessionId,
      fromUserId: peerId,
      toUserId: myUserId,
      content: mockAutoReply(),
      createTime: new Date().toISOString(),
      read: false
    }
    mockHelpers.setMessages([...mockHelpers.getMessages(), msg])
    const sessions = mockHelpers.getSessions()
    const s = sessions.find((x) => x.id === sessionId)
    if (s) {
      s.lastMessage = msg.content
      s.lastTime = msg.createTime
    }
    mockHelpers.setSessions(sessions)
  }, 1200)
}

export type { PageResult }
