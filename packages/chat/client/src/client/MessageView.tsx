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

import { createElement, type KeyboardEvent, type ReactElement } from 'react'

import {
  presentDeliveryState,
  presentStreamState,
  type LocalDeliveryState,
  type StreamState,
} from '../presentation.js'
import { Avatar } from '../components/Avatar.js'
import { DropdownMenu, type DropdownMenuItem } from '../components/DropdownMenu.js'
import { notify } from '../components/Toast.js'
import { countGraphemes, COMPOSER_LIMITS } from './Composer.js'
import { dayLabel, formatMessageTime, isSameCalendarDay } from './time.js'

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
  /**
   * 当前修订号，来自 host 的 history（§14.1）。编辑提交时 targetRevision
   * 必须严格大于它。**本地待发消息没有** —— 尚未被服务端接受，无从编辑。
   */
  readonly revision?: number
  /** 仅本人发出的消息有。他人消息的投递状态本端无从得知。 */
  readonly deliveryState?: LocalDeliveryState
}

export interface MessageViewProps {
  readonly messages: readonly DisplayMessage[]
  readonly streamState: StreamState
  readonly onRetry?: (messageId: string) => void
  /** 请求撤回。由父层负责二次确认与调用 host（本组件保持纯呈现）。 */
  readonly onRevoke?: (messageId: string) => void
  /**
   * 提交编辑。参数是 host 要求的完整三元组：消息 ID、目标修订号（当前 + 1）、
   * 新正文。窗口与权限判定都在 host 侧（U7），客户端不预判。
   */
  readonly onEdit?: (messageId: string, targetRevision: number, body: string) => void
  /**
   * 内联编辑状态（受控）。`null` = 没有正在编辑的消息。
   *
   * 状态放在父层而非本组件内部，原因与撤回一致：**本组件保持纯呈现** ——
   * 直接调用组件函数拿元素树的测试方式（见 element-tree.ts）不允许
   * 组件自带 hooks。
   */
  readonly editing?: EditingState | null
  /** 菜单「编辑」：请求进入编辑态。初始草稿 = 当前正文。 */
  readonly onStartEdit?: (messageId: string, initialDraft: string) => void
  /** 编辑草稿变化（受控输入）。 */
  readonly onChangeDraft?: (text: string) => void
  /** 退出编辑（取消，或提交后收起）。 */
  readonly onCancelEdit?: () => void
  readonly formatTime?: (iso: string) => string
}

/** 撤回占位。与 messaging 包的 `REVOKED_PLACEHOLDER` 同值，各自独立定义 —— 客户端不依赖 host 包。 */
export const REVOKED_PLACEHOLDER = '[已撤回]'

/**
 * 默认时间格式：今天 `HH:MM`，昨天 `昨天 HH:MM`，更早 `MM-DD HH:MM`。
 * 相对语义按本地日历日切，见 `time.ts` 的说明。
 */
function defaultFormatTime(iso: string): string {
  return formatMessageTime(iso, new Date())
}

/**
 * 日历日分组头。连续消息落在同一天时不重复出现 —— 每条消息都顶一个
 * 「今天」等于没有分组。
 */
function renderDayHeader(iso: string): ReactElement {
  return createElement(
    'li',
    { key: `day-${iso}`, className: styles['dayHeader'], role: 'presentation' },
    createElement('time', { dateTime: iso }, dayLabel(iso, new Date())),
  )
}

/** 内联编辑的受控状态。不进权威数据 —— 编辑提交前的一切都只是草稿。 */
export interface EditingState {
  readonly messageId: string
  readonly draft: string
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
          ...props.messages.flatMap((message, index) => {
            const previous = index > 0 ? props.messages[index - 1] : undefined
            // 跨日才插分组头：同一天的连续消息共享一个头。首条必有一个 ——
            // 时间线脱离上下文（长截图、引用转发）时仍可指认是哪天说的
            const needsHeader =
              previous === undefined ||
              !isSameCalendarDay(new Date(previous.sentAt), new Date(message.sentAt))
            return [
              ...(needsHeader ? [renderDayHeader(message.sentAt)] : []),
              renderMessage(message, format, props.onRetry, props.onRevoke, {
                editing: props.editing ?? null,
                onStartEdit: props.onStartEdit,
                onChangeDraft: props.onChangeDraft,
                onCancelEdit: props.onCancelEdit,
                onEdit: props.onEdit,
              }),
            ]
          }),
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

/**
 * 传给 renderMessage 的编辑上下文。全部来自 props（受控），
 * renderMessage 与本组件都保持无 state、无 hooks。
 */
interface EditContext {
  readonly editing: EditingState | null
  /** 进入编辑态（菜单「编辑」触发）。 */
  readonly onStartEdit: ((messageId: string, body: string) => void) | undefined
  readonly onChangeDraft: ((text: string) => void) | undefined
  readonly onCancelEdit: (() => void) | undefined
  readonly onEdit: ((messageId: string, targetRevision: number, body: string) => void) | undefined
}

/**
 * 内联编辑器：替换气泡正文的位置，就地修改（ui-design.md §4.3「编辑」）。
 *
 * - Enter 提交、Shift+Enter 换行、Esc 取消；输入法组字期间的 Enter 不当提交
 *   （与 Composer 同一条规则，理由同：中文用户按 Enter 是在确认候选词）
 * - 长度与 Composer 同一把尺子（字素簇 8000），超限禁用保存
 * - 提交的 targetRevision = 当前 revision + 1。§14.1 只接受严格更高，
 *   host 侧还有编辑窗口（默认 15 分钟）与「仅原发送者」判定，客户端不预判（U7）
 */
function renderInlineEditor(message: DisplayMessage, edit: EditContext): ReactElement {
  const draft = edit.editing?.draft ?? ''
  const overLimit = countGraphemes(draft) > COMPOSER_LIMITS.maxGraphemes
  const empty = draft.trim().length === 0
  const canSave = !empty && !overLimit

  const submit = (): void => {
    if (!canSave || message.revision === undefined || edit.onEdit === undefined) return
    edit.onEdit(message.messageId, message.revision + 1, draft)
    // 乐观收起编辑器。失败时父层弹 toast 并重拉消息（doEdit），用户对着
    // 刷新后的正文重新发起编辑 —— P0 不保留失败草稿，那是 P1 的「草稿」
    // 工单要解决的
    edit.onCancelEdit?.()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      edit.onCancelEdit?.()
      return
    }
    if (event.key !== 'Enter') return
    if (event.shiftKey) return
    if (event.nativeEvent.isComposing) return
    event.preventDefault()
    submit()
  }

  return createElement(
    'div',
    { className: styles['editWrap'] },
    createElement('textarea', {
      className: styles['editInput'],
      value: draft,
      // autoFocus 只在挂载瞬间生效；SSE 重渲染不会反复抢焦点（React 语义）
      autoFocus: true,
      'aria-label': '编辑消息',
      onChange: (event: { target: { value: string } }) => edit.onChangeDraft?.(event.target.value),
      onKeyDown,
    }),
    createElement(
      'div',
      { className: styles['editActions'] },
      createElement(
        'button',
        { type: 'button', className: styles['editCancel'], onClick: () => edit.onCancelEdit?.() },
        '取消',
      ),
      createElement(
        'button',
        {
          type: 'button',
          className: styles['editSave'],
          disabled: !canSave,
          onClick: submit,
        },
        '保存',
      ),
      createElement(
        'span',
        {
          className: [styles['editHint'], overLimit ? styles['overLimit'] : '']
            .filter(Boolean)
            .join(' '),
        },
        overLimit ? `超出 ${countGraphemes(draft) - COMPOSER_LIMITS.maxGraphemes} 字` : 'Enter 保存 · Esc 取消',
      ),
    ),
  )
}

function renderMessage(
  message: DisplayMessage,
  format: (iso: string) => string,
  onRetry: ((messageId: string) => void) | undefined,
  onRevoke: ((messageId: string) => void) | undefined,
  edit: EditContext,
): ReactElement {
  const delivery =
    message.outgoing && message.deliveryState !== undefined
      ? presentDeliveryState(message.deliveryState)
      : undefined

  // 右键菜单。「复制」始终可用；「编辑」只对本人、未撤回、**已被服务端接受**
  // （有 revision）的消息出现 —— 本地待发的那条还没被接受，编辑无从附着。
  // 「撤回」同条件。窗口/权限判定在 host 侧（U7），超窗会由服务端拒绝。
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
    ...(message.outgoing &&
      !message.revoked &&
      message.revision !== undefined &&
      message.body !== undefined &&
      edit.onStartEdit !== undefined
      ? [
          {
            id: 'edit',
            label: '编辑',
            onSelect: () => edit.onStartEdit?.(message.messageId, message.body ?? ''),
          },
        ]
      : []),
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

  const body =
    edit.editing !== null && edit.editing.messageId === message.messageId
      ? renderInlineEditor(message, edit)
      : createElement(
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
