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

import {
  presentError,
  type LocalDeliveryState,
  type PresenceState,
  type StreamState,
} from '../presentation.js'

import styles from './ChatSection.module.css'
import { Dialog } from '../components/Dialog.js'
import { LocalSearch } from '../components/LocalSearch.js'
import { PolicyBanner, type PolicyCondition } from '../components/PolicyBanner.js'
import { ProtocolUnsupportedPage } from '../components/ProtocolUnsupportedPage.js'
import { ConversationRowSkeleton } from '../components/Skeleton.js'
import { notify } from '../components/Toast.js'
import { Composer } from './Composer.js'
import { ConversationList, type ConversationSummary } from './ConversationList.js'
import { DirectoryPanel } from './DirectoryPanel.js'
import { EnrollmentPanel } from './EnrollmentPanel.js'
import { MessageView, type DisplayMessage } from './MessageView.js'
import { useEventStream } from './useEventStream.js'

/** host 返回此错误码时抽屉整体替换为升级提示页（ui-design.md §3.5）。 */
const PROTOCOL_UNSUPPORTED = 'PROTOCOL_VERSION_UNSUPPORTED'

/** 宽到这个数才并排。低于它切单栏钻取。 */
const SPLIT_THRESHOLD = 640

/**
 * 心跳间隔。与 §50.3 关闭的那条决策一致（host 侧的 online 窗口是它的三倍）。
 *
 * 改这个数要同时看 `PRESENCE_BASELINE` —— 两边脱节的话，要么心跳太密白费
 * 请求，要么太疏让人一直闪断。
 */
const HEARTBEAT_INTERVAL_MS = 30_000

/**
 * 算作「用户还在」的交互。
 *
 * 只听这几个，不听 `mousemove` —— 鼠标从窗口上划过不代表人在用它，而
 * mousemove 会以每秒几十次的频率触发，把 idle 判定彻底废掉。
 */
const INTERACTION_EVENTS = ['keydown', 'pointerdown', 'focus'] as const

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
  const [presence, setPresence] = useState<Readonly<Record<string, PresenceState>>>({})
  // identity/status 返回 local | enrolled | unenrolled。local = 本机单机模式：
  // 没有 relay/组织，数据只在这台设备 —— 该事实占布局提示（U2），不隐藏
  const [localMode, setLocalMode] = useState(false)
  // 已关闭的占布局提示（PolicyBanner 默认不可关，这里仅放开非策略类提示）
  const [dismissedBanners, setDismissedBanners] = useState<readonly string[]>([])
  // 「会话」与「通讯录」。在有通讯录之前，界面上没有任何办法开始一段新
  // 对话 —— 会话列表只显示已有的，而已有的要靠别人先发消息产生
  const [tab, setTab] = useState<'chats' | 'directory'>('chats')
  // 本地搜索词（ui-design.md §3.4：与会话列表同源、与通讯录搜索相互独立）
  const [search, setSearch] = useState('')
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // 选中会话放进 ref 供事件回调读。放进依赖数组的话，每切一次会话就会
  // 重建一次 SSE 连接 —— 而重建意味着丢掉订阅并重来
  const selectedRef = useRef<string | undefined>(undefined)
  selectedRef.current = selectedId

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
      setLocalMode(status.mode === 'local')
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

  // SSE 只送「有新东西了」，正文走权威接口拉 —— 那条路径上才有完整的
  // 权限判定。所以这里收到事件只是刷新，不直接把推送内容渲染出来
  const stream = useEventStream({
    enabled: state.kind === 'ready',
    onEvent: (event) => {
      void loadConversations()
      const open = selectedRef.current
      // 只有当前打开的会话才拉消息。不加这个判断的话，一个热闹的组织
      // 会让每条消息都触发一次全量历史拉取
      if (open !== undefined && (event.peerId === undefined || event.peerId === open)) {
        void loadMessages(open)
      }
    },
  })

  useEffect(() => {
    void loadConversations()
  }, [loadConversations])

  // 心跳。§9.1 说的是「host 是否仍在运行」，所以真正的心跳在 host 进程里；
  // 浏览器这一趟只负责报告**用户交互时间** —— 那是它知道而 host 不知道的
  // 信息，也是 online 与 idle 的唯一分界
  useEffect(() => {
    if (state.kind !== 'ready') return
    let lastInteractionAt = new Date().toISOString()
    const touch = (): void => {
      lastInteractionAt = new Date().toISOString()
    }
    for (const type of INTERACTION_EVENTS) {
      window.addEventListener(type, touch, { passive: true })
    }

    const beat = (): void => {
      // 失败静默：心跳打不通不该在界面上报错。连接真的断了会由 SSE 那一路
      // 显式呈现，两处都报就是同一件事说两遍
      void callHost('/api/chat/presence/heartbeat', { lastInteractionAt }).catch(() => {})
    }
    beat()
    const timer = setInterval(beat, HEARTBEAT_INTERVAL_MS)
    return () => {
      clearInterval(timer)
      for (const type of INTERACTION_EVENTS) window.removeEventListener(type, touch)
    }
  }, [state.kind])

  // 会话列表变了就查一次在线状态。跟着列表走而不是自己定时轮询 ——
  // 列表不变时对方的状态最多差一个心跳周期，而那正是这个数据的精度上限
  useEffect(() => {
    if (conversations.length === 0) return
    let cancelled = false
    void (async () => {
      try {
        const data = await callHost<{ presence: Record<string, PresenceState> }>(
          '/api/chat/presence',
          { accountIds: conversations.map((c) => c.peerId) },
        )
        if (!cancelled) setPresence(data.presence)
      } catch {
        // 查不到就维持上一次的结果。清空会让所有人在网络抖一下时集体「消失」
      }
    })()
    return () => {
      cancelled = true
    }
  }, [conversations])

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

  /**
   * 真正把一条消息交给 host。
   *
   * 发送与失败重试共用这条路径：重试复用原 messageId 作为幂等键
   * （`send-${messageId}`），relay 自然去重（ui-design.md §3.6）。
   */
  const attemptSend = useCallback(
    async (record: PendingMessage): Promise<string | undefined> => {
      setPending((prev) =>
        prev.map((m) => (m.messageId === record.messageId ? { ...m, state: 'pending' } : m)),
      )
      try {
        await callHost<{ deliverySeq: number }>('/api/chat/messages', {
          messageId: record.messageId,
          recipientId: record.peerId,
          body: record.body,
          // 幂等键由调用方生成（§26）。用消息 ID 派生，重试时天然一致
          operationId: `send-${record.messageId}`,
        })
        // 服务端已接收，交给权威列表呈现，本地那条撤掉
        setPending((prev) => prev.filter((m) => m.messageId !== record.messageId))
        await loadMessages(record.peerId)
        await loadConversations()
        return undefined
      } catch (error) {
        const code = (error as Error).message
        // 失败的那条留在列表里并标为终态失败 —— §4 要求终态失败可见，
        // 不能让它悄悄消失
        setPending((prev) =>
          prev.map((m) => (m.messageId === record.messageId ? { ...m, state: 'failed' } : m)),
        )
        return presentError(code as Parameters<typeof presentError>[0]).message
      }
    },
    [loadMessages, loadConversations],
  )

  const send = useCallback(
    async (body: string): Promise<string | undefined> => {
      const peerId = selectedId
      if (peerId === undefined) return 'NOT_FOUND_OR_FORBIDDEN'

      const messageId = uuidv7()
      // §4：先本地显示为「待发送」。等服务端确认才显示的话，慢网络下界面
      // 像没反应，用户会重复点
      const record: PendingMessage = {
        messageId,
        peerId,
        body,
        sentAt: new Date().toISOString(),
        state: 'pending',
      }
      setPending((prev) => [...prev, record])
      return attemptSend(record)
    },
    [selectedId, attemptSend],
  )

  // 失败消息的重试：仅对 pending/failed（retryable）生效；accepted 由服务端
  // 权威列表呈现，本地没有那条记录，自然点不到（U1）
  const retryMessage = useCallback(
    (messageId: string): void => {
      const record = pending.find((m) => m.messageId === messageId)
      if (record !== undefined) void attemptSend(record)
    },
    [pending, attemptSend],
  )

  // 撤回：菜单只给出入口，二次确认在这里（Dialog），确认后才调 host
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null)

  // 占布局的策略/状态提示（U2：影响理解的现状必须占据布局而非浮层）。
  // 当前真实条件：identity/status 的 local 单机模式。
  const policyConditions: readonly PolicyCondition[] =
    localMode && !dismissedBanners.includes('local-mode')
      ? [
          {
            id: 'local-mode',
            tone: 'info',
            text: '本地模式：消息只保存在这台设备，尚未连接团队服务（通讯录、多设备与组织功能不可用）。',
            dismissable: true,
          },
        ]
      : []
  const policyBanner =
    policyConditions.length === 0
      ? null
      : createElement(
          'div',
          { className: styles['bannerWrap'] },
          createElement(PolicyBanner, {
            conditions: policyConditions,
            onDismiss: (id: string) => {
              setDismissedBanners((prev) => (prev.includes(id) ? prev : [...prev, id]))
            },
          }),
        )
  const doRevoke = useCallback(
    async (messageId: string): Promise<void> => {
      setConfirmRevokeId(null)
      const peerId = selectedId
      if (peerId === undefined) return
      try {
        // operationId 幂等：同一消息重复撤回请求会被服务端去重
        await callHost<{ ok: boolean }>('/api/chat/messages/revoke', {
          messageId,
          operationId: `revoke-${messageId}`,
        })
        await loadMessages(peerId)
        await loadConversations()
        notify({ id: `revoked-${messageId}`, variant: 'success', message: '已撤回该消息' })
      } catch (error) {
        const code = (error as Error).message
        notify({
          id: 'revoke-failed',
          variant: 'error',
          message: presentError(code as Parameters<typeof presentError>[0]).message,
        })
      }
    },
    [selectedId, loadMessages, loadConversations],
  )

  if (state.kind === 'loading') {
    return createElement(
      'div',
      { className: styles['loadingPane'], role: 'status', 'aria-label': '正在加载会话' },
      createElement(ConversationRowSkeleton, {}),
      createElement(ConversationRowSkeleton, {}),
      createElement(ConversationRowSkeleton, {}),
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
    // 协议不兼容是独立形态：抽屉整体替换为升级提示页（U2，不可静默降级）
    if (state.errorCode === PROTOCOL_UNSUPPORTED) {
      return createElement(ProtocolUnsupportedPage, {})
    }
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
    // 查不到时给 unknown 而不是 offline —— 后者是一个我们没有依据的断言
    presence: presence[c.peerId] ?? 'unknown',
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

  const tabBar = createElement(
    'div',
    { className: styles['tabs'], role: 'tablist', 'aria-label': '聊天与通讯录' },
    ...(
      [
        ['chats', '会话'],
        ['directory', '通讯录'],
      ] as const
    ).map(([value, label]) =>
      createElement(
        'button',
        {
          key: value,
          type: 'button',
          role: 'tab',
          'aria-selected': tab === value,
          className: [styles['tab'], tab === value ? styles['tabActive'] : '']
            .filter(Boolean)
            .join(' '),
          onClick: () => setTab(value),
        },
        label,
      ),
    ),
  )

  const directory = createElement(DirectoryPanel, {
    onOpenConversation: (accountId: string) => {
      // 切回会话并选中他。不切的话，用户点了「发消息」还停在通讯录上，
      // 看不出发生了什么
      setTab('chats')
      setSelectedId(accountId)
      void loadConversations()
    },
  })

  // 本地搜索：只过滤客户端已拿到的会话（标题/预览），结果与列表同源
  const query = search.trim().toLocaleLowerCase()
  const filteredSummaries =
    query.length === 0
      ? summaries
      : summaries.filter(
          (s) =>
            s.title.toLocaleLowerCase().includes(query) ||
            s.preview.toLocaleLowerCase().includes(query),
        )

  const list = createElement(
    'div',
    { className: styles['sidebar'] },
    tabBar,
    tab === 'chats'
      ? createElement(
          'div',
          { className: styles['chatColumn'] },
          createElement(
            'div',
            { className: styles['searchWrap'] },
            createElement(LocalSearch, {
              value: search,
              onValueChange: setSearch,
            }),
          ),
          query.length > 0 && filteredSummaries.length === 0
            ? createElement(
                'div',
                { className: styles['searchEmpty'] },
                createElement('p', null, '没有匹配的会话或消息'),
              )
            : createElement(ConversationList, {
                conversations: filteredSummaries,
                ...(selectedId === undefined ? {} : { selectedId }),
                onSelect: setSelectedId,
                ...(query.length === 0 ? {} : { highlightQuery: search.trim() }),
              }),
        )
      : directory,
  )

  // 单栏钻取：选中后只显示消息，否则只显示列表
  if (!split && selectedId === undefined) {
    return createElement('div', { className: styles['root'] }, policyBanner, list)
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
            // 外部传入的优先（设置面板里那个是静态预览），否则用真实连接状态。
            // §4：事件流断开必须显式呈现，不能表现为静默停止刷新
            streamState: props.streamState ?? stream.state,
            // 发送失败的重试入口（ui-design.md §3.6）—— 只对 pending/failed
            // 生效，accepted 不出现
            onRetry: (messageId: string) => retryMessage(messageId),
            // 撤回入口：先弹确认，确认后才调 host
            onRevoke: (messageId: string) => setConfirmRevokeId(messageId),
          }),
        ),
    selectedId === undefined || props.composer === false
      ? null
      : createElement(Composer, {
          onSend: send,
          placeholder: `发消息给 ${selected?.peerDisplayName ?? ''}…`,
        }),
  )

  // 撤回二次确认（破坏性操作：不 overlay 误关、不 Esc 偷跑）
  const revokeDialog =
    confirmRevokeId === null
      ? null
      : createElement(Dialog, {
          open: true,
          title: '撤回这条消息？',
          role: 'alertdialog',
          size: 'sm',
          onClose: () => setConfirmRevokeId(null),
          closeOnOverlayClick: false,
          children: [
            createElement(
              'p',
              { key: 'body', className: styles['dialogBody'] },
              '撤回后，对方将看到「[已撤回]」占位，原文不可恢复。',
            ),
            createElement(
              'div',
              { key: 'actions', className: styles['dialogActions'] },
              createElement(
                'button',
                {
                  type: 'button',
                  className: styles['dialogCancel'],
                  onClick: () => setConfirmRevokeId(null),
                },
                '取消',
              ),
              createElement(
                'button',
                {
                  type: 'button',
                  className: styles['dialogDanger'],
                  onClick: () => {
                    if (confirmRevokeId !== null) void doRevoke(confirmRevokeId)
                  },
                },
                '撤回',
              ),
            ),
          ],
        })

  return createElement(
    'div',
    { className: styles['root'] },
    policyBanner,
    createElement(
      'div',
      { className: [styles['stage'], split ? styles['split'] : ''].filter(Boolean).join(' ') },
      split ? list : null,
      conversationPane,
    ),
    revokeDialog,
  )
}
