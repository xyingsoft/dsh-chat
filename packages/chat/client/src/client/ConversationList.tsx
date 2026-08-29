/**
 * 会话列表。
 *
 * §5：客户端**不做权威缓存也不在浏览器中重算权限**。因此这个组件是纯呈现 ——
 * 会话数据、未读数、预览文本全部由 host 注入，组件不发请求、不算权限、
 * 不缓存。它唯一的状态是「哪一条被选中」，而那也由父层控制。
 *
 * ## 预览文本为什么由 host 给
 *
 * 直觉上「取最后一条消息的正文前 30 字」应该在这里做。但那要求客户端持有消息
 * 正文，而正文的可见性受权限约束、还可能被撤回。§5 说「消息、工作项、授权与
 * 游标属于持久状态，**只能来自 host 数据库**」—— 预览是正文的派生物，
 * 同样只能来自 host。
 */

import { createElement, type ReactElement } from 'react'

import styles from './ConversationList.module.css'

export interface ConversationSummary {
  readonly conversationId: string
  /** 对方的显示名。由 host 解析 —— 客户端没有账号目录。 */
  readonly title: string
  /**
   * 最后一条消息的摘要。**已撤回的消息在这里是撤回占位**，不是原文 ——
   * host 负责这个替换，客户端拿到什么显示什么。
   */
  readonly preview: string
  /** ISO 8601。格式化在渲染时做，不改变数据。 */
  readonly lastActivityAt: string
  readonly unreadCount: number
}

export interface ConversationListProps {
  readonly conversations: readonly ConversationSummary[]
  readonly selectedId?: string
  readonly onSelect: (conversationId: string) => void
  /**
   * 把 ISO 时间格式化为显示文本。
   *
   * 注入而非内置：§48 要求「跨时区团队的截止时间必须显示时区标识」，而时区
   * 偏好属于账号设置，组件拿不到。默认实现只取 ISO 的日期时间部分 ——
   * 朴素但不会撒谎。
   */
  readonly formatTime?: (iso: string) => string
}

/** 默认时间格式化：`2026-08-30T12:34:56Z` → `08-30 12:34`。 */
function defaultFormatTime(iso: string): string {
  const match = /^\d{4}-(\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso)
  return match === null ? iso : `${match[1]} ${match[2]}`
}

export function ConversationList(props: ConversationListProps): ReactElement {
  const format = props.formatTime ?? defaultFormatTime

  if (props.conversations.length === 0) {
    // 空态给一句明确的话，而不是一片空白。空白无法区分「没有会话」与
    // 「还没加载出来」，而这两者用户该做的事完全不同
    return createElement('p', { className: styles['empty'] }, '还没有会话')
  }

  return createElement(
    'div',
    { className: styles['root'] },
    createElement(
      'ul',
      { className: styles['list'], role: 'listbox', 'aria-label': '会话列表' },
      ...props.conversations.map((conversation) =>
        createElement(
          'li',
          { key: conversation.conversationId, role: 'presentation' },
          createElement(
            'button',
            {
              type: 'button',
              role: 'option',
              'aria-selected': conversation.conversationId === props.selectedId,
              className: [
                styles['item'],
                conversation.conversationId === props.selectedId ? styles['selected'] : '',
              ]
                .filter(Boolean)
                .join(' '),
              onClick: () => props.onSelect(conversation.conversationId),
            },
            createElement('span', { className: styles['name'] }, conversation.title),
            createElement('span', { className: styles['preview'] }, conversation.preview),
            createElement(
              'span',
              { className: styles['meta'] },
              createElement(
                'time',
                { className: styles['time'], dateTime: conversation.lastActivityAt },
                format(conversation.lastActivityAt),
              ),
              conversation.unreadCount > 0
                ? createElement(
                    'span',
                    {
                      className: styles['unread'],
                      // 视觉上是个数字角标，读屏要听到它是什么
                      'aria-label': `${conversation.unreadCount} 条未读`,
                    },
                    // 三位数以上折成 99+：再多的具体数字对决定「要不要点进去」
                    // 没有帮助，却会把角标撑得很宽
                    conversation.unreadCount > 99 ? '99+' : String(conversation.unreadCount),
                  )
                : null,
            ),
          ),
        ),
      ),
    ),
  )
}
