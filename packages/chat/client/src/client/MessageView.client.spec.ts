/**
 * 会话列表与消息视图测试。
 *
 * 这两个组件是整个客户端里最容易撒谎的地方，所以测试盯的是**它有没有说
 * 不该说的话**，而不是「渲染出来了没有」：
 *
 * - 没有任何投递状态可以显示为「已送达」（§5）
 * - 撤回后不显示原文，且与正常正文视觉可区分（§14.1）
 * - 事件流断开必须可见，不得静默（§5）
 * - 正文不经任何标记解释（§18：不可信内容）
 */

import { describe, expect, it } from 'vitest'

import { LOCAL_DELIVERY_STATES, STREAM_STATES } from '../presentation.js'

import { ConversationList, type ConversationSummary } from './ConversationList.js'
import { MessageView, REVOKED_PLACEHOLDER, type DisplayMessage } from './MessageView.js'
import { click, findAll, findByClass, hasDangerousHtml, textOf } from './element-tree.js'

function conversation(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    conversationId: 'conv-1',
    title: '乙',
    preview: '好的，我看一下',
    lastActivityAt: '2026-08-30T12:34:56Z',
    unreadCount: 0,
    ...overrides,
  }
}

function message(overrides: Partial<DisplayMessage> = {}): DisplayMessage {
  return {
    messageId: 'msg-1',
    outgoing: false,
    authorName: '乙',
    body: '你好',
    revoked: false,
    edited: false,
    sentAt: '2026-08-30T12:34:56Z',
    ...overrides,
  }
}

describe('会话列表', () => {
  it('渲染标题、预览与时间', () => {
    const tree = ConversationList({ conversations: [conversation()], onSelect: () => {} })
    const text = textOf(tree)
    expect(text).toContain('乙')
    expect(text).toContain('好的，我看一下')
    expect(text).toContain('08-30 12:34')
  })

  it('空态给一句明确的话而不是一片空白', () => {
    // 空白无法区分「没有会话」与「还没加载出来」，
    // 而这两者用户该做的事完全不同
    expect(textOf(ConversationList({ conversations: [], onSelect: () => {} }))).toBe('还没有会话')
  })

  it('点击回调带出会话 ID', () => {
    const selected: string[] = []
    const tree = ConversationList({
      conversations: [conversation({ conversationId: 'conv-7' })],
      onSelect: (id) => selected.push(id),
    })
    click(findAll(tree, 'button')[0]!)
    expect(selected).toEqual(['conv-7'])
  })

  it('未读数显示为计数而非纯圆点', () => {
    // 「有未读」与「有 12 条未读」是不同的信息
    const tree = ConversationList({
      conversations: [conversation({ unreadCount: 12 })],
      onSelect: () => {},
    })
    expect(textOf(tree)).toContain('12')
    expect(findByClass(tree, 'unread')[0]?.props['aria-label']).toBe('12 条未读')
  })

  it('未读为 0 时不显示角标', () => {
    const tree = ConversationList({
      conversations: [conversation({ unreadCount: 0 })],
      onSelect: () => {},
    })
    expect(findByClass(tree, 'unread')).toHaveLength(0)
  })

  it('超过 99 折成 99+', () => {
    // 再多的具体数字对决定「要不要点进去」没有帮助，却会把角标撑得很宽
    const tree = ConversationList({
      conversations: [conversation({ unreadCount: 1234 })],
      onSelect: () => {},
    })
    expect(textOf(tree)).toContain('99+')
    // 但读屏仍报真实数字
    expect(findByClass(tree, 'unread')[0]?.props['aria-label']).toBe('1234 条未读')
  })

  it('选中态不只靠颜色区分', () => {
    // 只用颜色的话，色觉障碍用户看不出选了哪一条。
    // aria-selected 让读屏也能知道
    const tree = ConversationList({
      conversations: [conversation({ conversationId: 'a' }), conversation({ conversationId: 'b' })],
      selectedId: 'b',
      onSelect: () => {},
    })
    const options = findAll(tree, 'button')
    expect(options.map((o) => o.props['aria-selected'])).toEqual([false, true])
    expect(findByClass(tree, 'selected')).toHaveLength(1)
  })

  it('预览文本原样显示，不做二次截断或解释', () => {
    // 预览是正文的派生物，由 host 给出。已撤回的消息在这里是撤回占位 ——
    // 客户端拿到什么显示什么
    const tree = ConversationList({
      conversations: [conversation({ preview: REVOKED_PLACEHOLDER })],
      onSelect: () => {},
    })
    expect(textOf(tree)).toContain(REVOKED_PLACEHOLDER)
  })
})

describe('消息视图 · 投递状态不撒谎（§5）', () => {
  it('没有任何一态显示为「已送达」', () => {
    // 三态是「本地已保存待发送」「服务器已接收」「终态失败」，
    // 没有一个可以声称对方收到了
    for (const state of LOCAL_DELIVERY_STATES) {
      const tree = MessageView({
        messages: [message({ outgoing: true, deliveryState: state })],
        streamState: 'connected',
      })
      const text = textOf(tree)
      expect(text, `${state} 声称了已送达`).not.toContain('已送达')
      expect(text, `${state} 声称了已读`).not.toContain('已读')
    }
  })

  it('accepted 显示为「服务器已接收」而不是「已发送」', () => {
    const tree = MessageView({
      messages: [message({ outgoing: true, deliveryState: 'accepted' })],
      streamState: 'connected',
    })
    expect(textOf(tree)).toContain('服务器已接收')
  })

  it('只有终态失败提供重试入口', () => {
    for (const state of LOCAL_DELIVERY_STATES) {
      const tree = MessageView({
        messages: [message({ outgoing: true, deliveryState: state })],
        streamState: 'connected',
        onRetry: () => {},
      })
      const buttons = findAll(tree, 'button')
      expect(buttons.length, `${state} 的重试入口数量不对`).toBe(state === 'failed' ? 1 : 0)
    }
  })

  it('重试回调带出消息 ID', () => {
    const retried: string[] = []
    const tree = MessageView({
      messages: [message({ messageId: 'msg-9', outgoing: true, deliveryState: 'failed' })],
      streamState: 'connected',
      onRetry: (id) => retried.push(id),
    })
    click(findAll(tree, 'button')[0]!)
    expect(retried).toEqual(['msg-9'])
  })

  it('他人的消息不显示投递状态', () => {
    // 他人消息的投递状态本端无从得知，显示任何东西都是编造
    const tree = MessageView({
      messages: [message({ outgoing: false })],
      streamState: 'connected',
    })
    for (const label of ['待发送', '服务器已接收', '发送失败']) {
      expect(textOf(tree)).not.toContain(label)
    }
  })
})

describe('消息视图 · 撤回与编辑（§14.1）', () => {
  it('撤回后显示占位而不是原文', () => {
    const tree = MessageView({
      messages: [message({ body: '这句话被撤回了', revoked: true })],
      streamState: 'connected',
    })
    expect(textOf(tree)).not.toContain('这句话被撤回了')
    expect(textOf(tree)).toContain(REVOKED_PLACEHOLDER)
  })

  it('body 为 undefined 时也显示占位而不是空白', () => {
    const tree = MessageView({
      messages: [message({ body: undefined, revoked: true })],
      streamState: 'connected',
    })
    expect(textOf(tree)).toContain(REVOKED_PLACEHOLDER)
  })

  it('撤回占位与正文视觉可区分', () => {
    // 不区分的话，「[已撤回]」看起来像是有人真的这么说了
    const revoked = MessageView({
      messages: [message({ revoked: true })],
      streamState: 'connected',
    })
    const normal = MessageView({ messages: [message()], streamState: 'connected' })
    expect(findByClass(revoked, 'revoked')).toHaveLength(1)
    expect(findByClass(normal, 'revoked')).toHaveLength(0)
  })

  it('编辑过的消息标注「已编辑」', () => {
    // §14.1：避免静默篡改历史上下文
    const tree = MessageView({ messages: [message({ edited: true })], streamState: 'connected' })
    expect(textOf(tree)).toContain('已编辑')
  })

  it('已撤回的消息不标「已编辑」', () => {
    // 那会暗示当前有一份被编辑过的正文可看，而实际上正文已经不可得
    const tree = MessageView({
      messages: [message({ edited: true, revoked: true })],
      streamState: 'connected',
    })
    expect(textOf(tree)).not.toContain('已编辑')
  })
})

describe('消息视图 · 事件流状态必须可见（§5）', () => {
  it('非 connected 的状态都显示出来', () => {
    // §5：不得把事件流断开等状态表现为静默停止刷新
    for (const state of STREAM_STATES) {
      const tree = MessageView({ messages: [message()], streamState: state })
      const banners = findByClass(tree, 'streamBanner')
      expect(banners.length, `${state} 的可见性不对`).toBe(state === 'connected' ? 0 : 1)
    }
  })

  it('sync_diverged 额外说明已停止自动重发', () => {
    // §28.1：进入 sync_diverged 后停止 ACK、自动重发与新的组织写入。
    // 不说的话，用户以为消息还在后台努力发送
    const tree = MessageView({ messages: [message()], streamState: 'sync_diverged' })
    expect(textOf(tree)).toContain('已停止自动重发')
  })

  it('状态条用 role=status，读屏能播报', () => {
    const tree = MessageView({ messages: [message()], streamState: 'disconnected' })
    expect(findByClass(tree, 'streamBanner')[0]?.props['role']).toBe('status')
  })

  it('断开时仍然渲染已有消息', () => {
    // 断开是「拿不到新消息」，不是「已有消息作废」
    const tree = MessageView({
      messages: [message({ body: '断开前收到的' })],
      streamState: 'disconnected',
    })
    expect(textOf(tree)).toContain('断开前收到的')
  })
})

describe('消息视图 · 正文是不可信内容（§18）', () => {
  it('不使用 dangerouslySetInnerHTML', () => {
    // §18：消息正文作为不可信内容处理。P0 没有任何需求要求富文本，
    // 「顺手支持一下加粗」会重新打开注入面
    const tree = MessageView({
      messages: [message({ body: '<img src=x onerror=alert(1)>' })],
      streamState: 'connected',
    })
    expect(hasDangerousHtml(tree)).toBe(false)
  })

  it('标记原样作为文本出现，不被解释', () => {
    const payload = '<b>粗体</b> & <script>alert(1)</script>'
    const tree = MessageView({ messages: [message({ body: payload })], streamState: 'connected' })
    // 作为字符串子节点出现 —— React 会转义它
    expect(textOf(tree)).toContain(payload)
    expect(findAll(tree, 'script')).toHaveLength(0)
    expect(findAll(tree, 'b')).toHaveLength(0)
  })

  it('会话列表的预览同样不做 HTML 解释', () => {
    const tree = ConversationList({
      conversations: [conversation({ preview: '<script>x</script>' })],
      onSelect: () => {},
    })
    expect(hasDangerousHtml(tree)).toBe(false)
    expect(findAll(tree, 'script')).toHaveLength(0)
  })

  it('作者名同样是不可信内容', () => {
    // 显示名由用户自己设置，和正文一样不可信
    const tree = MessageView({
      messages: [message({ authorName: '<script>x</script>' })],
      streamState: 'connected',
    })
    expect(hasDangerousHtml(tree)).toBe(false)
  })
})

describe('消息视图 · 空态', () => {
  it('没有消息时给一句明确的话', () => {
    expect(textOf(MessageView({ messages: [], streamState: 'connected' }))).toContain('还没有消息')
  })

  it('空态下事件流状态仍然可见', () => {
    // 「一条消息都没有」与「断开了所以看不到消息」必须能区分开
    const tree = MessageView({ messages: [], streamState: 'disconnected' })
    expect(findByClass(tree, 'streamBanner')).toHaveLength(1)
  })
})
