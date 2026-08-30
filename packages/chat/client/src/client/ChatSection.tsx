/**
 * 聊天主体：会话列表 + 消息视图 + 输入框。
 *
 * ## 布局随宽度切换
 *
 * 抽屉宽度可拖，所以布局不能只有一种：
 *
 * - **宽（≥ 640px）**：左列表右消息，切会话一步到位
 * - **窄**：单栏钻取 —— 先看列表，点进去看消息，头部有返回
 *
 * 380px 还硬要两栏的话，两边都挤成一条，谁也看不清。这是把「可调宽度」
 * 真的用起来，而不是只让面板变宽。
 *
 * ## 权限与缓存都不在这里
 *
 * §5：客户端**不做权威缓存也不在浏览器中重算权限**。本地只有加载态、
 * 选中的会话、以及**尚未被服务端确认的待发消息** —— 最后一项是必须的：
 * §4 要求「本地已保存待发送」是一个可见状态，没有它就只能在发送成功后
 * 才显示，慢网络下界面像没反应。
 */

import {
  createElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from 'react'

import { presentError, type LocalDeliveryState, type StreamState } from '../presentation.js'

import styles from './ChatSection.module.css'
import { Composer } from './Composer.js'
import { ConversationList, type ConversationSummary } from './ConversationList.js'
import { EnrollmentPanel } from './EnrollmentPanel.js'
import { MessageView, type DisplayMessage } from './MessageView.js'

/** 宽到这个数才并排。低于它切单栏钻取。 */
const SPLIT_THRESHOLD = 640

interface RemoteConversation {
  readonly peerId: string
  readonly peerDisplayName: string
  readonly preview: string
  readonly lastActivityAt: string
  readonly unreadCount: number
  readonly lastMessageOutgoing: boolean
}

interface RemoteMessage {
  readonly messageId: string
  readonly senderId: string
  readonly outgoing: boolean
  readonly body: string | undefined
  readonly revoked: boolean
  readonly edited: boolean
  readonly sentAt: string
}

/** 本地待发/失败的消息。服务端确认后从这里移除，改由服务端列表提供。 */
interface PendingMessage {
  readonly messageId: string
  readonly peerId: string
  readonly body: string
  readonly sentAt: string
  readonly state: LocalDeliveryState
}

/**
 * 生成 UUIDv7。
 *
 * §14 要求 `MessageId` 是**客户端生成的 UUIDv7**。`crypto.randomUUID()` 给的是
 * v4 —— 纯随机，不带时间序。消息按 ID 排序时 v4 会乱序，而 v7 的前 48 位就是
 * 毫秒时间戳，天然单调。
 *
 * 这里手写而不是引库：48 位时间戳 + 74 位随机 + 版本与变体位，就这么多。
 */
function uuidv7(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)

  const ms = BigInt(Date.now())
  for (let i = 0; i < 6; i += 1) {
    bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn)
  }
  // 版本 7
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70
  // RFC 4122 变体
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80

  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * 调用 host 的同源 API。
 *
 * §4：浏览器只与 host 的同源 API 通信，**不直接与 relay 通信**。所以是相对
 * 路径，没有可配置的 base URL —— 能配就意味着能被配到别处去。
 */
async function callHost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = (await response.json()) as { data?: T; error?: { code?: string } }
  if (!response.ok || payload.data === undefined) {
    // 错误码原样抛出，交给 presentError 决定措辞与是否给重试入口 ——
    // 组件不自己编文案，那会和错误码目录漂移
    throw new Error(payload.error?.code ?? 'INTERNAL')
  }
  return payload.data
}

type LoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready' }
  /**
   * 配了 relay 但本机还没开户。
   *
   * 与「没有会话」是两回事，所以是一个独立状态而不是空列表 —— 空列表长得像
   * 「你还没有会话」，而实际情况是「你还没有账号」，下一步动作完全不同。
   */
  | { readonly kind: 'unenrolled' }
  /** 加载失败。**必须显式呈现**，不能表现为一直空着（§5）。 */
  | { readonly kind: 'failed'; readonly errorCode: string }

export interface ChatSectionProps {
  readonly streamState?: StreamState
  /** 容器宽度，决定并排还是钻取。抽屉把它的当前宽度传进来。 */
  readonly width?: number
  /**
   * 是否显示输入框。
   *
   * 抽屉里为 `false` —— 页面上已经有 DSH 自己的输入框，再放一个就是两个
   * 并存，用户不知道该用哪个。抽屉只负责「瞄一眼」，回消息去「聊天」标签页，
   * 那里原生输入框不显示，全页只有一个。
   */
  readonly composer?: boolean
}

export function ChatSection(props: ChatSectionProps): ReactElement {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [conversations, setConversations] = useState<readonly RemoteConversation[]>([])
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const [messages, setMessages] = useState<readonly RemoteMessage[]>([])
  const [pending, setPending] = useState<readonly PendingMessage[]>([])
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const split = (props.width ?? SPLIT_THRESHOLD) >= SPLIT_THRESHOLD

  const loadConversations = useCallback(async () => {
    try {
      // 先问开户状态。跳过这一步直接拉会话的话，未开户时拿到的是一个
      // 认证错误 —— 界面会显示「出错了，重试」，而重试一百次也不会成功，
      // 真正要做的是开户
      const status = await callHost<{ mode: 'local' | 'enrolled' | 'unenrolled' }>(
        '/api/chat/identity/status',
        {},
      )
      if (status.mode === 'unenrolled') {
        setState({ kind: 'unenrolled' })
        return
      }
      const data = await callHost<{ conversations: RemoteConversation[] }>(
        '/api/chat/conversations',
        {},
      )
      setConversations(data.conversations)
      setState({ kind: 'ready' })
    } catch (error) {
      setState({ kind: 'failed', errorCode: (error as Error).message })
    }
  }, [])

  const loadMessages = useCallback(async (peerId: string) => {
    const data = await callHost<{ messages: RemoteMessage[] }>('/api/chat/messages/history', {
      peerId,
    })
    setMessages(data.messages)
  }, [])

  useEffect(() => {
    void loadConversations()
  }, [loadConversations])

  // 打开会话：拉消息 + 标记已读。
  // 标记已读放在这里而不是点击回调里 —— 组织切换或外部改选中时也要生效
  useEffect(() => {
    if (selectedId === undefined) {
      setMessages([])
      return
    }
    let cancelled = false
    void (async () => {
      try {
        await loadMessages(selectedId)
        await callHost<{ acked: number }>('/api/chat/conversations/read', { peerId: selectedId })
        if (!cancelled) await loadConversations()
      } catch {
        // 消息拉不到不把整个界面切成错误态：会话列表已经拿到了，
        // 切掉会让用户连列表都看不见
        if (!cancelled) setMessages([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [selectedId, loadMessages, loadConversations])

  // 新消息进来时滚到底。用户正在往上翻历史时不要抢滚动条 ——
  // 只有原本就贴近底部才自动跟随
  useEffect(() => {
    const node = scrollRef.current
    if (node === null) return
    const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 120
    if (nearBottom) node.scrollTop = node.scrollHeight
  }, [messages, pending])

  const send = useCallback(
    async (body: string): Promise<string | undefined> => {
      const peerId = selectedId
      if (peerId === undefined) return 'NOT_FOUND_OR_FORBIDDEN'

      const messageId = uuidv7()
      // §4：先本地显示为「待发送」。等服务端确认才显示的话，慢网络下界面
      // 像没反应，用户会重复点
      setPending((prev) => [
        ...prev,
        { messageId, peerId, body, sentAt: new Date().toISOString(), state: 'pending' },
      ])

      try {
        await callHost<{ deliverySeq: number }>('/api/chat/messages', {
          messageId,
          recipientId: peerId,
          body,
          // 幂等键由调用方生成（§26）。用消息 ID 派生，重试时天然一致
          operationId: `send-${messageId}`,
        })
        // 服务端已接收，交给权威列表呈现，本地那条撤掉
        setPending((prev) => prev.filter((m) => m.messageId !== messageId))
        await loadMessages(peerId)
        await loadConversations()
        return undefined
      } catch (error) {
        const code = (error as Error).message
        // 失败的那条留在列表里并标为终态失败 —— §4 要求终态失败可见，
        // 不能让它悄悄消失
        setPending((prev) =>
          prev.map((m) => (m.messageId === messageId ? { ...m, state: 'failed' } : m)),
        )
        return presentError(code as Parameters<typeof presentError>[0]).message
      }
    },
    [selectedId, loadMessages, loadConversations],
  )

  if (state.kind === 'loading') {
    return createElement(
      'div',
      { className: styles['status'] },
      createElement('p', { className: styles['statusText'] }, '正在加载会话…'),
    )
  }

  if (state.kind === 'unenrolled') {
    return createElement(EnrollmentPanel, {
      onEnrolled: () => {
        // 开完户重走一遍加载。不直接切 ready —— 会话列表还没拉过，
        // 切过去会是一个空列表，看起来像开户没生效
        setState({ kind: 'loading' })
        void loadConversations()
      },
    })
  }

  if (state.kind === 'failed') {
    const presented = presentError(state.errorCode as Parameters<typeof presentError>[0])
    return createElement(
      'div',
      { className: styles['status'], role: 'alert' },
      createElement('p', { className: styles['statusText'] }, presented.message),
      presented.offersRetry
        ? createElement(
            'button',
            {
              type: 'button',
              className: styles['retry'],
              onClick: () => {
                setState({ kind: 'loading' })
                void loadConversations()
              },
            },
            '重试',
          )
        : null,
    )
  }

  const selected = conversations.find((c) => c.peerId === selectedId)
  const summaries: ConversationSummary[] = conversations.map((c) => ({
    conversationId: c.peerId,
    title: c.peerDisplayName,
    // 「你：」前缀由这里加而不是 host 拼进 preview —— host 不知道界面用什么
    // 措辞，而 preview 还要用于别处
    preview: c.lastMessageOutgoing ? `你：${c.preview}` : c.preview,
    lastActivityAt: c.lastActivityAt,
    unreadCount: c.unreadCount,
  }))

  const displayed: DisplayMessage[] = [
    ...messages.map((m) => ({
      messageId: m.messageId,
      outgoing: m.outgoing,
      authorName: m.outgoing ? '我' : (selected?.peerDisplayName ?? m.senderId),
      body: m.body,
      revoked: m.revoked,
      edited: m.edited,
      sentAt: m.sentAt,
      ...(m.outgoing ? { deliveryState: 'accepted' as const } : {}),
    })),
    ...pending
      .filter((m) => m.peerId === selectedId)
      .map((m) => ({
        messageId: m.messageId,
        outgoing: true,
        authorName: '我',
        body: m.body,
        revoked: false,
        edited: false,
        sentAt: m.sentAt,
        deliveryState: m.state,
      })),
  ]

  const list = createElement(
    'div',
    { className: styles['sidebar'] },
    createElement(ConversationList, {
      conversations: summaries,
      ...(selectedId === undefined ? {} : { selectedId }),
      onSelect: setSelectedId,
    }),
  )

  // 单栏钻取：选中后只显示消息，否则只显示列表
  if (!split && selectedId === undefined) {
    return createElement('div', { className: styles['root'] }, list)
  }

  const conversationPane = createElement(
    'div',
    { className: styles['main'] },
    // 单栏时给返回条；宽版列表一直在旁边，不需要
    !split && selected !== undefined
      ? createElement(
          'div',
          { className: styles['backBar'] },
          createElement(
            'button',
            {
              type: 'button',
              className: styles['back'],
              onClick: () => setSelectedId(undefined),
              'aria-label': '返回会话列表',
            },
            '‹ 返回',
          ),
          createElement('p', { className: styles['peerName'] }, selected.peerDisplayName),
        )
      : null,
    selectedId === undefined
      ? createElement(
          'div',
          { className: styles['status'] },
          createElement('p', { className: styles['statusText'] }, '选择一个会话开始'),
        )
      : createElement(
          'div',
          { className: styles['messages'], ref: scrollRef },
          createElement(MessageView, {
            messages: displayed,
            streamState: props.streamState ?? 'connected',
          }),
        ),
    selectedId === undefined || props.composer === false
      ? null
      : createElement(Composer, {
          onSend: send,
          placeholder: `发消息给 ${selected?.peerDisplayName ?? ''}…`,
        }),
  )

  return createElement(
    'div',
    { className: [styles['root'], split ? styles['split'] : ''].filter(Boolean).join(' ') },
    split ? list : null,
    conversationPane,
  )
}
