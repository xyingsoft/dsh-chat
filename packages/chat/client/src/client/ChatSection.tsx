/**
 * 聊天分区：会话列表 + 消息视图，接真实数据。
 *
 * ## 为什么在设置面板里
 *
 * §5 说聊天界面通过 slot 贡献，但当前 vendor 进来的运行时只声明了
 * `settings.section` 这一族 slot —— 没有主区域的 slot 可用。要拿到那个得再
 * vendor 一批包（ui-chat / ui-conversation 之类），那是另一件事。
 *
 * 所以先落在设置分区里。这不理想，但**它是真的能用**：数据来自 host 的
 * `/api/chat/conversations` 与 `/api/chat/messages/history`，不是假数据。
 *
 * ## 权限与缓存都不在这里
 *
 * §5：客户端**不做权威缓存也不在浏览器中重算权限**。所以这个组件只有
 * 「加载中 / 加载失败 / 有数据」三种本地状态，退出重进就重新拉。
 */

import { createElement, useCallback, useEffect, useState, type ReactElement } from 'react'

import { presentError, type StreamState } from '../presentation.js'

import styles from './ChatSection.module.css'
import { ConversationList, type ConversationSummary } from './ConversationList.js'
import { MessageView, type DisplayMessage } from './MessageView.js'

/** host 返回的会话摘要。字段与 `@dsh-chat/messaging` 的 `ConversationSummary` 对应。 */
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

/**
 * 调用 host 的同源 API。
 *
 * §4：浏览器只与 host 的同源 API 通信，**不直接与 relay 通信**。所以这里是
 * 相对路径，没有任何可配置的 base URL —— 能配就意味着能被配到别处去。
 */
async function callHost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = (await response.json()) as { data?: T; error?: { code?: string } }
  if (!response.ok || payload.data === undefined) {
    // 把错误码原样抛出，交给 presentError 决定措辞与是否给重试入口 ——
    // 组件不自己编错误文案，那会和错误码目录漂移
    throw new Error(payload.error?.code ?? 'INTERNAL')
  }
  return payload.data
}

type LoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready' }
  /** 加载失败。**必须显式呈现**，不能表现为一直空着（§5）。 */
  | { readonly kind: 'failed'; readonly errorCode: string }

export interface ChatSectionProps {
  /** 事件流状态，由宿主注入。默认 `connected` 仅用于尚未接通 SSE 的场景。 */
  readonly streamState?: StreamState
}

export function ChatSection(props: ChatSectionProps): ReactElement {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [conversations, setConversations] = useState<readonly RemoteConversation[]>([])
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const [messages, setMessages] = useState<readonly RemoteMessage[]>([])

  const loadConversations = useCallback(async () => {
    setState({ kind: 'loading' })
    try {
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

  useEffect(() => {
    void loadConversations()
  }, [loadConversations])

  // 选中会话后拉它的消息。失败不整体报错 —— 会话列表已经拿到了，
  // 把整个界面切成错误态会让用户连列表都看不见
  useEffect(() => {
    if (selectedId === undefined) {
      setMessages([])
      return
    }
    let cancelled = false
    void callHost<{ messages: RemoteMessage[] }>('/api/chat/messages/history', {
      peerId: selectedId,
    })
      .then((data) => {
        if (!cancelled) setMessages(data.messages)
      })
      .catch(() => {
        if (!cancelled) setMessages([])
      })
    return () => {
      cancelled = true
    }
  }, [selectedId])

  if (state.kind === 'loading') {
    return createElement('p', { className: styles['status'] }, '正在加载会话…')
  }

  if (state.kind === 'failed') {
    // 错误措辞与是否给重试入口都由错误码目录决定，组件不自己判断
    const presented = presentError(state.errorCode as Parameters<typeof presentError>[0])
    return createElement(
      'div',
      { className: styles['status'], role: 'alert' },
      createElement('p', { className: styles['statusText'] }, presented.message),
      presented.offersRetry
        ? createElement(
            'button',
            { type: 'button', className: styles['retry'], onClick: () => void loadConversations() },
            '重试',
          )
        : null,
    )
  }

  const summaries: ConversationSummary[] = conversations.map((c) => ({
    conversationId: c.peerId,
    title: c.peerDisplayName,
    // 「你：」前缀由这里加而不是由 host 拼进 preview —— host 不知道
    // 界面用什么措辞，而 preview 还要用于别处
    preview: c.lastMessageOutgoing ? `你：${c.preview}` : c.preview,
    lastActivityAt: c.lastActivityAt,
    unreadCount: c.unreadCount,
  }))

  const displayed: DisplayMessage[] = messages.map((m) => ({
    messageId: m.messageId,
    outgoing: m.outgoing,
    authorName: m.outgoing ? '我' : (conversations.find((c) => c.peerId === m.senderId)?.peerDisplayName ?? m.senderId),
    body: m.body,
    revoked: m.revoked,
    edited: m.edited,
    sentAt: m.sentAt,
  }))

  return createElement(
    'div',
    { className: styles['root'] },
    createElement(
      'div',
      { className: styles['sidebar'] },
      createElement(ConversationList, {
        conversations: summaries,
        ...(selectedId === undefined ? {} : { selectedId }),
        onSelect: setSelectedId,
      }),
    ),
    createElement(
      'div',
      { className: styles['main'] },
      selectedId === undefined
        ? createElement('p', { className: styles['status'] }, '选择一个会话')
        : createElement(MessageView, {
            messages: displayed,
            streamState: props.streamState ?? 'connected',
          }),
    ),
  )
}
