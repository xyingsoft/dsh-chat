/**
 * 消息视图。
 *
 * 这是整个客户端里最容易撒谎的地方，所以它的约束也最密集：
 *
 * - §5：离线三态「本地已保存待发送」「服务器已接收」「终态失败」**绝不可混淆**，
 *   **绝不把未确认内容显示为已送达**。
 * - §5：事件流断开、组织切换、权限修订变化、`sync_diverged` **必须显式呈现**，
 *   不得表现为静默停止刷新。
 * - §14.1：撤回后「本地把正文替换为撤回占位」；引用要标记原消息已编辑或已撤回，
 *   **避免静默篡改历史上下文**。
 * - §18：正文作为**不可信内容**处理。
 *
 * 三条呈现规则的实现都不在这个文件里 —— `presentDeliveryState` 与
 * `presentStreamState` 在 `presentation.ts`，已单独测过。这里只负责把它们的
 * 结论如实画出来，不做第二次判断。
 *
 * ## 不做 Markdown / HTML 渲染
 *
 * §18：「评论正文与消息正文遵循同一输入策略与安全渲染规则，并同样作为
 * **不可信内容**处理。」正文经 React 的文本节点输出，换行靠 CSS 的
 * `white-space: pre-wrap` 保留。任何「顺手支持一下加粗」都会重新打开
 * 注入面，而 P0 没有任何需求要求富文本。
 */

import { createElement, type ReactElement } from 'react'

import {
  presentDeliveryState,
  presentStreamState,
  type LocalDeliveryState,
  type StreamState,
} from '../presentation.js'
import { Avatar } from '../components/Avatar.js'
import { DropdownMenu, type DropdownMenuItem } from '../components/DropdownMenu.js'
import { notify } from '../components/Toast.js'

import styles from './MessageView.module.css'

export interface DisplayMessage {
  readonly messageId: string
  /** 是否由本人发出。决定气泡方向与是否显示投递状态。 */
  readonly outgoing: boolean
  readonly authorName: string
  /**
   * 正文。**已撤回时为 `undefined`** —— 不是空字符串。
   *
   * 空字符串与「撤回了一条空消息」无法区分，而后者本就不该存在
   * （发送端拒绝空正文）。用 `undefined` 让「已撤回」在类型上就是另一回事。
   */
  readonly body: string | undefined
  readonly revoked: boolean
  /** §14.1：引用要标记原消息当前已编辑，避免静默篡改历史上下文。 */
  readonly edited: boolean
  readonly sentAt: string
  /** 仅本人发出的消息有。他人消息的投递状态本端无从得知。 */
  readonly deliveryState?: LocalDeliveryState
}

export interface MessageViewProps {
  readonly messages: readonly DisplayMessage[]
  readonly streamState: StreamState
  readonly onRetry?: (messageId: string) => void
  /** 请求撤回。由父层负责二次确认与调用 host（本组件保持纯呈现）。 */
  readonly onRevoke?: (messageId: string) => void
  readonly formatTime?: (iso: string) => string
}

/** 撤回占位。与 messaging 包的 `REVOKED_PLACEHOLDER` 同值，各自独立定义 —— 客户端不依赖 host 包。 */
export const REVOKED_PLACEHOLDER = '[已撤回]'

function defaultFormatTime(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2})/.exec(iso)?.[1] ?? iso
}

export function MessageView(props: MessageViewProps): ReactElement {
  const format = props.formatTime ?? defaultFormatTime
  const stream = presentStreamState(props.streamState)

  return createElement(
    'div',
    { className: styles['root'] },
    // §5：这些状态必须显式呈现。用占据布局的条而不是浮层 ——
    // 浮层会被忽略，也会被其他元素盖住
    stream.mustBeVisible
      ? createElement(
          'p',
          {
            className: [
              styles['streamBanner'],
              stream.haltsAutoResend ? styles['streamBannerHalted'] : '',
            ]
              .filter(Boolean)
              .join(' '),
            role: 'status',
          },
          stream.haltsAutoResend
            ? `${stream.label} · 已停止自动重发`
            : stream.label,
        )
      : null,
    props.messages.length === 0
      ? createElement('p', { className: styles['empty'] }, '还没有消息')
      : createElement(
          'ul',
          { className: styles['list'] },
          ...props.messages.map((message) =>
            renderMessage(message, format, props.onRetry, props.onRevoke),
          ),
        ),
  )
}

/**
 * 复制纯文本到剪贴板（正文不可信内容按纯文本复制，不做 HTML）。
 * 复制成功后给 toast；失败静默 —— 复制是便利功能，不该因此打断操作。
 */
function copyPlainText(text: string): void {
  const done = (): void => {
    notify({ id: 'copy-message', variant: 'success', message: '已复制到剪贴板' })
  }
  if (globalThis.navigator?.clipboard?.writeText !== undefined) {
    globalThis.navigator.clipboard.writeText(text).then(done).catch(() => {
      fallbackCopy(text, done)
    })
  } else {
    fallbackCopy(text, done)
  }
}

function fallbackCopy(text: string, done: () => void): void {
  if (typeof document === 'undefined') return
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    document.execCommand('copy')
    document.body.removeChild(area)
    done()
  } catch {
    // 隐私策略下剪贴板不可写：什么都不做
  }
}

function renderMessage(
  message: DisplayMessage,
  format: (iso: string) => string,
  onRetry: ((messageId: string) => void) | undefined,
  onRevoke: ((messageId: string) => void) | undefined,
): ReactElement {
  const delivery =
    message.outgoing && message.deliveryState !== undefined
      ? presentDeliveryState(message.deliveryState)
      : undefined

  // 右键菜单。「复制」始终可用；「撤回」只对本人已发送且未撤回的消息出现，
  // 窗口/权限判定在 host 侧（U7：客户端不自行重算能力），超窗会由服务端拒绝。
  // 撤回是破坏性操作，父层（ChatSection）负责弹 Dialog 二次确认后再调 host。
  const menuItems: readonly DropdownMenuItem[] = [
    {
      id: 'copy',
      label: '复制',
      disabled: message.revoked || message.body === undefined,
      onSelect: () => {
        if (message.body !== undefined) copyPlainText(message.body)
      },
    },
    ...(message.outgoing && !message.revoked && onRevoke !== undefined
      ? [
          {
            id: 'revoke',
            label: '撤回',
            danger: true as const,
            onSelect: () => onRevoke(message.messageId),
          },
        ]
      : []),
  ]

  const body = createElement(
    'p',
    {
      className: [styles['body'], message.revoked ? styles['revoked'] : '']
        .filter(Boolean)
        .join(' '),
    },
    // 撤回后展示占位而非正文（§14.1）。正文经文本节点输出，
    // 不做任何标记解释（§18：不可信内容）
    message.revoked ? REVOKED_PLACEHOLDER : (message.body ?? REVOKED_PLACEHOLDER),
  )
  const meta = createElement(
    'span',
    { className: styles['meta'] },
    // 对方消息在信息行带头像（生成式），本端不重复画自己
    !message.outgoing
      ? createElement(Avatar, { name: message.authorName, size: 'sm', title: message.authorName })
      : null,
    createElement('span', null, message.authorName),
    createElement(
      'time',
      { className: styles['time'], dateTime: message.sentAt },
      format(message.sentAt),
    ),
    // 已撤回的消息不标「已编辑」—— 那会暗示当前有一份被编辑过的正文可看，
    // 而实际上正文已经不可得
    message.edited && !message.revoked
      ? createElement('span', { className: styles['edited'] }, '已编辑')
      : null,
    delivery === undefined
      ? null
      : createElement(
          'span',
          {
            className:
              message.deliveryState === 'failed' ? styles['deliveryFailed'] : undefined,
          },
          delivery.label,
        ),
    // 只有终态失败才给重试入口（§5）—— offersRetry 已判定，这里不再自行判断
    delivery?.offersRetry === true && onRetry !== undefined
      ? createElement(
          'button',
          {
            type: 'button',
            className: styles['retry'],
            onClick: () => onRetry(message.messageId),
          },
          '重试',
        )
      : null,
  )

  // children 渲染函数执行时把 openAt 交给外层右键处理器
  let openMenu: ((anchor: HTMLElement | { readonly x: number; readonly y: number }) => void) | undefined
  const menu = createElement(
    DropdownMenu,
    {
      trigger: 'manual',
      items: menuItems,
      ariaLabel: '消息操作',
      children: (openAt) => {
        openMenu = openAt
        return createElement('span', { className: styles['menuAnchor'], 'aria-hidden': true })
      },
    },
  )

  return createElement(
    'li',
    {
      key: message.messageId,
      className: [styles['message'], message.outgoing ? styles['outgoing'] : '']
        .filter(Boolean)
        .join(' '),
      onContextMenu: (event: { preventDefault: () => void; clientX: number; clientY: number }) => {
        if (openMenu === undefined) return
        event.preventDefault()
        openMenu({ x: event.clientX, y: event.clientY })
      },
    },
    body,
    meta,
    menu,
  )
}
