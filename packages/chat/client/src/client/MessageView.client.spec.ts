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
import { click, findAll, findByClass, hasDangerousHtml, textOf, walk } from './element-tree.js'

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
    // formatTime 注入固定实现：默认实现按「今天/昨天/更早」相对切分，
    // 断言它的输出会让用例随运行日期漂移
    const tree = ConversationList({
      conversations: [conversation()],
      onSelect: () => {},
      formatTime: () => '08-30 12:34',
    })
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

  it('空态提供去通讯录的入口，点它触发引导回调', () => {
    // 没有会话时唯一能开始对话的入口是通讯录 ——
    // 不给入口的话，空列表就是一个死胡同
    let opened = false
    const tree = ConversationList({
      conversations: [],
      onSelect: () => {},
      onOpenDirectory: () => {
        opened = true
      },
    })
    const buttons = findAll(tree, 'button')
    expect(buttons).toHaveLength(1)
    expect(textOf(tree)).toContain('去通讯录发起对话')
    click(buttons[0]!)
    expect(opened).toBe(true)
  })

  it('有草稿时预览行让位给草稿，而非最后一条消息', () => {
    // §5：草稿是设备本地的视图状态。「打了没发」比「最后收到什么」
    // 更需要被记住 —— 用户切走了会话，回来时列表要提醒他
    const tree = ConversationList({
      conversations: [conversation({ draft: '打了一半的话' })],
      onSelect: () => {},
    })
    const text = textOf(tree)
    expect(text).toContain('草稿')
    expect(text).toContain('打了一半的话')
    expect(text).not.toContain('好的，我看一下')
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

describe('消息视图 · 内联编辑（§14.1）', () => {
  /** 可编辑的消息：本人发出、已被服务端接受（有 revision）、未撤回。 */
  function editable(overrides: Partial<DisplayMessage> = {}): DisplayMessage {
    return message({ messageId: 'msg-e', outgoing: true, body: '初始正文', revision: 2, ...overrides })
  }

  it('editing 状态下目标消息被编辑器替换，且带 aria-label', () => {
    const tree = MessageView({
      messages: [editable()],
      streamState: 'connected',
      editing: { messageId: 'msg-e', draft: '初始正文' },
      onChangeDraft: () => {},
      onCancelEdit: () => {},
    })
    expect(findAll(tree, 'textarea')[0]?.props['aria-label']).toBe('编辑消息')
    // 正文位置被编辑器替换，原正文不再以气泡形式出现（草稿在 textarea 的 value 里）
    expect(findByClass(tree, 'body')).toHaveLength(0)
  })

  it('只有编辑中的那条被替换，其他消息照常显示', () => {
    const tree = MessageView({
      messages: [editable(), message({ messageId: 'msg-o', body: '别人的' })],
      streamState: 'connected',
      editing: { messageId: 'msg-e', draft: '初始正文' },
      onChangeDraft: () => {},
      onCancelEdit: () => {},
    })
    expect(findByClass(tree, 'body')).toHaveLength(1)
    expect(textOf(tree)).toContain('别人的')
  })

  it('保存回调带出 (messageId, revision + 1, 草稿)', () => {
    // targetRevision 必须严格大于当前 revision（§14.1）—— 客户端唯一可靠的
    // 构造方式就是 history 给的 revision + 1
    const edits: Array<[string, number, string]> = []
    const tree = MessageView({
      messages: [editable()],
      streamState: 'connected',
      editing: { messageId: 'msg-e', draft: '改过的正文' },
      onChangeDraft: () => {},
      onCancelEdit: () => {},
      onEdit: (id, rev, body) => edits.push([id, rev, body]),
    })
    click(findByClass(tree, 'editSave')[0]!)
    expect(edits).toEqual([['msg-e', 3, '改过的正文']])
  })

  it('提交后收起编辑器（乐观关闭）', () => {
    const cancelled: boolean[] = []
    const tree = MessageView({
      messages: [editable()],
      streamState: 'connected',
      editing: { messageId: 'msg-e', draft: '改过的正文' },
      onChangeDraft: () => {},
      onCancelEdit: () => cancelled.push(true),
      onEdit: () => {},
    })
    click(findByClass(tree, 'editSave')[0]!)
    expect(cancelled).toEqual([true])
  })

  it('空草稿或超长时保存禁用', () => {
    const renderWith = (draft: string) =>
      MessageView({
        messages: [editable()],
        streamState: 'connected',
        editing: { messageId: 'msg-e', draft },
        onChangeDraft: () => {},
        onCancelEdit: () => {},
        onEdit: () => {},
      })
    const saveDisabled = (tree: ReturnType<typeof MessageView>): unknown =>
      findByClass(tree, 'editSave')[0]?.props['disabled']
    expect(saveDisabled(renderWith('   '))).toBe(true)
    expect(saveDisabled(renderWith('a'.repeat(8001)))).toBe(true)
    expect(saveDisabled(renderWith('正常的草稿'))).toBe(false)
  })

  it('超限时提示超出字数', () => {
    const tree = MessageView({
      messages: [editable()],
      streamState: 'connected',
      editing: { messageId: 'msg-e', draft: 'a'.repeat(8005) },
      onChangeDraft: () => {},
      onCancelEdit: () => {},
      onEdit: () => {},
    })
    expect(textOf(tree)).toContain('超出 5 字')
  })

  it('Esc 触发取消', () => {
    const cancelled: boolean[] = []
    const tree = MessageView({
      messages: [editable()],
      streamState: 'connected',
      editing: { messageId: 'msg-e', draft: 'x' },
      onChangeDraft: () => {},
      onCancelEdit: () => cancelled.push(true),
    })
    const textarea = findAll(tree, 'textarea')[0]!
    const handler = textarea.props['onKeyDown'] as (event: unknown) => void
    handler({ key: 'Escape', preventDefault: () => {}, nativeEvent: {} })
    expect(cancelled).toEqual([true])
  })

  it('Enter 提交；Shift+Enter 与输入法组字不提交', () => {
    const edits: string[] = []
    const tree = MessageView({
      messages: [editable()],
      streamState: 'connected',
      editing: { messageId: 'msg-e', draft: 'x' },
      onChangeDraft: () => {},
      onCancelEdit: () => {},
      onEdit: () => edits.push('called'),
    })
    const handler = findAll(tree, 'textarea')[0]!.props['onKeyDown'] as (event: unknown) => void
    const enter = (extra: Record<string, unknown> = {}): unknown =>
      handler({ key: 'Enter', shiftKey: false, preventDefault: () => {}, nativeEvent: { isComposing: false }, ...extra })
    enter({ shiftKey: true })
    expect(edits).toEqual([])
    enter({ nativeEvent: { isComposing: true } })
    expect(edits).toEqual([])
    enter()
    expect(edits).toEqual(['called'])
  })

  it('菜单项里「编辑」只对有 revision 的本人消息出现', () => {
    // 菜单项藏在 DropdownMenu 的 props.items 里（walk 不调用组件函数，
    // 但 props 是可见的）。没有 revision = 还没被服务端接受，编辑无从附着
    const labelsOf = (msg: DisplayMessage): string[] => {
      const tree = MessageView({
        messages: [msg],
        streamState: 'connected',
        onStartEdit: () => {},
      })
      const menu = walk(tree).find((n) => n.props['items'] !== undefined)
      return (menu?.props['items'] as Array<{ label: string }>).map((i) => i.label)
    }
    expect(labelsOf(editable())).toContain('编辑')
    expect(labelsOf(editable({ revision: undefined }))).not.toContain('编辑')
    expect(labelsOf(message({ outgoing: false }))).not.toContain('编辑')
    expect(labelsOf(editable({ revoked: true }))).not.toContain('编辑')
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
