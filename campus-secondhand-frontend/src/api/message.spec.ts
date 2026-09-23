/**
 * API 层单元测试 · 私信 / 消息中心（Mock 模式 / JSON 静态数据源）
 *
 * 重点验证「会话 id 双向一致性」——这是「被联系人也能看到消息」的核心机制：
 *   会话 id = s_{goodsId}_{minUserId}_{maxUserId}
 *   因此我从 A 发给 B，和 B 收到 A 的消息，在数据层是同一条会话记录。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  fetchSessions,
  fetchUnreadTotal,
  fetchMessages,
  sendMessage,
  openSession,
  markSessionRead,
  deleteSession
} from '@/api/message'
import { mockHelpers, makeSessionId } from '@/api/mock'

/** 从会话 id 反解参与者 userId（与实现层规则一致） */
const participantsOf = (sid: string) => sid.split('_').slice(2).map(Number)

describe('fetchSessions() · 会话列表', () => {
  it('应只返回「我参与」的会话（按会话 id 解析参与者）', async () => {
    const list = await fetchSessions(1)
    list.forEach((s) => {
      expect(participantsOf(s.id)).toContain(1)
    })
  })

  it('应返回 ChatSession 必需的展示字段', async () => {
    const list = await fetchSessions(1)
    list.forEach((s) => {
      expect(s).toHaveProperty('id')
      expect(s).toHaveProperty('peerId')
      expect(s).toHaveProperty('peerName')
      expect(s).toHaveProperty('lastMessage')
      expect(s).toHaveProperty('lastTime')
      expect(s).toHaveProperty('unread')
    })
  })

  it('应按最后消息时间倒序排列', async () => {
    const list = await fetchSessions(1)
    const times = list.map((s) => +new Date(s.lastTime))
    for (let i = 1; i < times.length; i++) {
      expect(times[i - 1]).toBeGreaterThanOrEqual(times[i])
    }
  })

  it('unread 计数应为非负整数', async () => {
    const list = await fetchSessions(1)
    list.forEach((s) => {
      expect(Number.isInteger(s.unread)).toBe(true)
      expect(s.unread).toBeGreaterThanOrEqual(0)
    })
  })
})

describe('fetchUnreadTotal() · 未读总数', () => {
  it('应只统计「发给我的」且未读的消息', async () => {
    const total = await fetchUnreadTotal(1)
    const expected = mockHelpers
      .getMessages()
      .filter((m) => m.toUserId === 1 && !m.read).length
    expect(total).toBe(expected)
  })

  it('无未读消息的用户应返回 0', async () => {
    const total = await fetchUnreadTotal(99999)
    expect(total).toBe(0)
  })
})

describe('fetchMessages() · 会话消息', () => {
  it('应只返回指定会话的消息', async () => {
    const sessions = mockHelpers.getSessions()
    if (sessions.length === 0) return
    const sid = sessions[0].id
    const list = await fetchMessages(sid, 1)
    list.forEach((m) => expect(m.sessionId).toBe(sid))
  })

  it('应按时间正序排列（最早的在前，符合聊天窗口展示顺序）', async () => {
    const sessions = mockHelpers.getSessions()
    if (sessions.length === 0) return
    const list = await fetchMessages(sessions[0].id, 1)
    const times = list.map((m) => +new Date(m.createTime))
    for (let i = 1; i < times.length; i++) {
      expect(times[i - 1]).toBeLessThanOrEqual(times[i])
    }
  })

  it('拉取后应把「发给我的未读消息」标记为已读', async () => {
    // 先造一条未读消息给我
    const msg = await sendMessage({ fromUserId: 2, toUserId: 1, content: '未读探测' })
    expect(mockHelpers.getMessages().find((m) => m.id === msg.id)?.read).toBe(false)

    await fetchMessages(msg.sessionId, 1)

    expect(mockHelpers.getMessages().find((m) => m.id === msg.id)?.read).toBe(true)
  })

  it('不应把「我发出的消息」标记为已读（read 是收件方视角）', async () => {
    const msg = await sendMessage({ fromUserId: 1, toUserId: 2, content: '我发的' })
    await fetchMessages(msg.sessionId, 1)
    expect(mockHelpers.getMessages().find((m) => m.id === msg.id)?.read).toBe(false)
  })
})

describe('sendMessage() · 发送消息', () => {
  /*
   * 必须写成块体、不要把返回值交给钩子：
   * `vi.useFakeTimers()` 返回 `VitestUtils`，箭头函数**隐式返回**它之后，
   * 钩子回调的返回类型就变成 `VitestUtils`，而 vitest 期望的是
   * `Awaitable<void | HookCleanupCallback>` → TS2322。
   * 加一对花括号丢弃返回值即可。
   */
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('应返回生成的消息实体，字段完整', async () => {
    const p = sendMessage({ fromUserId: 1, toUserId: 2, content: '你好' })
    await vi.advanceTimersByTimeAsync(200)
    const msg = await p

    expect(msg.id).toBeGreaterThan(0)
    expect(msg.fromUserId).toBe(1)
    expect(msg.toUserId).toBe(2)
    expect(msg.content).toBe('你好')
    expect(msg.read).toBe(false)
    expect(msg.createTime).toBeTruthy()
  })

  it('未传 sessionId 时应按规则自动生成', async () => {
    const p = sendMessage({ fromUserId: 1, toUserId: 2, content: 'x' })
    await vi.advanceTimersByTimeAsync(200)
    const msg = await p
    expect(msg.sessionId).toBe(makeSessionId(1, 2, 0))
  })

  it('带商品发送时应把商品 id 编入会话 id', async () => {
    const p = sendMessage({
      fromUserId: 1,
      toUserId: 2,
      content: 'x',
      goods: { id: 77, title: '教材', cover: 'c.png' }
    })
    await vi.advanceTimersByTimeAsync(200)
    const msg = await p
    expect(msg.sessionId).toBe(makeSessionId(1, 2, 77))
  })

  it('会话不存在时应自动新建会话（详情页首次联系卖家）', async () => {
    const sid = makeSessionId(1, 2, 555)
    expect(mockHelpers.getSessions().some((s) => s.id === sid)).toBe(false)

    const p = sendMessage({
      fromUserId: 1,
      toUserId: 2,
      content: '第一次联系',
      goods: { id: 555, title: '台灯', cover: 'l.png' }
    })
    await vi.advanceTimersByTimeAsync(200)
    await p

    const created = mockHelpers.getSessions().find((s) => s.id === sid)
    expect(created).toBeTruthy()
    expect(created?.peerId).toBe(2)
    expect(created?.goodsTitle).toBe('台灯')
    expect(created?.lastMessage).toBe('第一次联系')
  })

  it('会话已存在时不应重复新建', async () => {
    const sid = makeSessionId(1, 2, 666)
    const goods = { id: 666, title: '耳机', cover: 'e.png' }

    const p1 = sendMessage({ fromUserId: 1, toUserId: 2, content: 'a', goods })
    await vi.advanceTimersByTimeAsync(200)
    await p1
    const countAfterFirst = mockHelpers.getSessions().filter((s) => s.id === sid).length
    expect(countAfterFirst).toBe(1)

    const p2 = sendMessage({ fromUserId: 1, toUserId: 2, content: 'b', goods })
    await vi.advanceTimersByTimeAsync(200)
    await p2
    expect(mockHelpers.getSessions().filter((s) => s.id === sid).length).toBe(1)
  })

  it('消息应写入静态数据集（总数 +1）', async () => {
    const before = mockHelpers.getMessages().length
    const p = sendMessage({ fromUserId: 1, toUserId: 2, content: '计数' })
    await vi.advanceTimersByTimeAsync(200)
    await p
    expect(mockHelpers.getMessages().length).toBe(before + 1)
  })

  it('【Mock 演示】发送 1.2s 后对方应自动回复一条消息', async () => {
    const p = sendMessage({ fromUserId: 1, toUserId: 2, content: '在吗' })
    await vi.advanceTimersByTimeAsync(200)
    const mine = await p

    await vi.advanceTimersByTimeAsync(1300)

    const reply = mockHelpers
      .getMessages()
      .find((m) => m.sessionId === mine.sessionId && m.fromUserId === 2 && m.id !== mine.id)

    expect(reply).toBeTruthy()
    expect(reply?.toUserId).toBe(1)
    expect(reply?.content.length).toBeGreaterThan(0)
  })

  it('自动回复后会话的 lastMessage 应更新为回复内容', async () => {
    const p = sendMessage({ fromUserId: 1, toUserId: 2, content: '更新会话' })
    await vi.advanceTimersByTimeAsync(200)
    const mine = await p
    await vi.advanceTimersByTimeAsync(1300)

    const session = mockHelpers.getSessions().find((s) => s.id === mine.sessionId)
    expect(session?.lastMessage).not.toBe('更新会话')
    expect(session?.lastMessage.length).toBeGreaterThan(0)
  })
})

describe('openSession() · 打开 / 创建会话', () => {
  it('应返回符合规则的会话 id', async () => {
    const sid = await openSession({
      myUserId: 1,
      toUserId: 3,
      toUserName: '李同学',
      toUserAvatar: 'l.png',
      goodsId: 42,
      goodsTitle: '自行车',
      goodsCover: 'b.png'
    })
    expect(sid).toBe(makeSessionId(1, 3, 42))
  })

  it('同一对用户 + 同一商品应命中同一条会话（幂等）', async () => {
    const payload = {
      myUserId: 1,
      toUserId: 4,
      toUserName: '王同学',
      toUserAvatar: 'w.png',
      goodsId: 88,
      goodsTitle: '吉他',
      goodsCover: 'g.png'
    }
    const sid1 = await openSession(payload)
    const sid2 = await openSession(payload)
    expect(sid1).toBe(sid2)
    expect(mockHelpers.getSessions().filter((s) => s.id === sid1).length).toBe(1)
  })

  it('新建会话应带上商品信息与对方昵称', async () => {
    const sid = await openSession({
      myUserId: 1,
      toUserId: 5,
      toUserName: '赵同学',
      toUserAvatar: 'z.png',
      goodsId: 99,
      goodsTitle: '显示器',
      goodsCover: 'm.png'
    })
    const s = mockHelpers.getSessions().find((x) => x.id === sid)
    expect(s?.peerName).toBe('赵同学')
    expect(s?.goodsId).toBe(99)
    expect(s?.goodsTitle).toBe('显示器')
  })

  it('不应重复创建已存在的会话', async () => {
    const before = mockHelpers.getSessions().length
    const payload = {
      myUserId: 1,
      toUserId: 6,
      toUserName: '同一条',
      toUserAvatar: '',
      goodsId: 111,
      goodsTitle: 't',
      goodsCover: ''
    }
    await openSession(payload)
    await openSession(payload)
    expect(mockHelpers.getSessions().length).toBe(before + 1)
  })
})

describe('markSessionRead() · 标记已读', () => {
  it('应把该会话中发给我的未读消息全部标记为已读', async () => {
    const sid = makeSessionId(1, 2, 321)
    mockHelpers.setMessages([
      ...mockHelpers.getMessages(),
      { id: 90001, sessionId: sid, fromUserId: 2, toUserId: 1, content: 'a', createTime: new Date().toISOString(), read: false },
      { id: 90002, sessionId: sid, fromUserId: 2, toUserId: 1, content: 'b', createTime: new Date().toISOString(), read: false }
    ])

    await markSessionRead(sid, 1)

    const unread = mockHelpers
      .getMessages()
      .filter((m) => m.sessionId === sid && m.toUserId === 1 && !m.read)
    expect(unread.length).toBe(0)
  })

  it('不应影响其他用户的未读状态', async () => {
    const sid = makeSessionId(1, 2, 321)
    mockHelpers.setMessages([
      ...mockHelpers.getMessages(),
      { id: 90003, sessionId: sid, fromUserId: 1, toUserId: 2, content: 'c', createTime: new Date().toISOString(), read: false }
    ])

    await markSessionRead(sid, 1)

    expect(mockHelpers.getMessages().find((m) => m.id === 90003)?.read).toBe(false)
  })
})

describe('deleteSession() · 删除会话', () => {
  /*
   * 必须写成块体、不要把返回值交给钩子：
   * `vi.useFakeTimers()` 返回 `VitestUtils`，箭头函数**隐式返回**它之后，
   * 钩子回调的返回类型就变成 `VitestUtils`，而 vitest 期望的是
   * `Awaitable<void | HookCleanupCallback>` → TS2322。
   * 加一对花括号丢弃返回值即可。
   */
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('应同时移除会话记录与其全部消息', async () => {
    const p = sendMessage({ fromUserId: 1, toUserId: 2, content: '待删除', goods: { id: 777, title: 'x', cover: '' } })
    await vi.advanceTimersByTimeAsync(200)
    const msg = await p

    expect(mockHelpers.getSessions().some((s) => s.id === msg.sessionId)).toBe(true)

    const del = deleteSession(msg.sessionId)
    await vi.advanceTimersByTimeAsync(200)
    await del

    expect(mockHelpers.getSessions().some((s) => s.id === msg.sessionId)).toBe(false)
    expect(mockHelpers.getMessages().some((m) => m.sessionId === msg.sessionId)).toBe(false)
  })

  it('删除不存在的会话不应抛错', async () => {
    const del = deleteSession('s_0_0_0')
    await vi.advanceTimersByTimeAsync(200)
    await expect(del).resolves.toBeUndefined()
  })
})
