/**
 * 强制策略警告条（ui-design.md §3.2）。
 *
 * 硬约束：
 * - 占整行布局，不浮层、不用 toast 替代（U2）；
 * - 多条件叠加显示，不合并成模糊一句；
 * - role="alert" + aria-live="assertive"，进入即播报；
 * - 策略警告默认不可关。
 */

import { createElement, type ReactElement } from 'react'

import styles from './PolicyBanner.module.css'

export type PolicyTone = 'warning' | 'danger' | 'info'

export interface PolicyCondition {
  readonly id: string
  readonly tone: PolicyTone
  readonly text: string
  /** 可选的「去解决」入口（如跳账号安全）。 */
  readonly actionLabel?: string
  readonly onAction?: () => void
  /** 默认不可关；仅组织治理配置过「可关闭」时才给关闭按钮。 */
  readonly dismissable?: boolean
}

export interface PolicyBannerProps {
  readonly conditions: readonly PolicyCondition[]
  readonly onDismiss?: (id: string) => void
}

const TONE_ICON = { warning: '!', danger: '✕', info: 'i' } as const

export function PolicyBanner(props: PolicyBannerProps): ReactElement | null {
  const { conditions, onDismiss } = props
  if (conditions.length === 0) return null
  const banners = conditions.map((condition) => {
    const nodes = [
      createElement(
        'span',
        { key: 'icon', className: styles['icon'], 'aria-hidden': true },
        TONE_ICON[condition.tone],
      ),
      createElement('span', { key: 'text', className: styles['text'] }, condition.text),
    ]
    if (condition.actionLabel !== undefined) {
      nodes.push(
        createElement(
          'button',
          {
            key: 'action',
            type: 'button',
            className: styles['action'],
            onClick: condition.onAction,
          },
          condition.actionLabel,
        ),
      )
    }
    if (condition.dismissable === true && onDismiss !== undefined) {
      nodes.push(
        createElement(
          'button',
          {
            key: 'dismiss',
            type: 'button',
            className: styles['dismiss'],
            onClick: () => onDismiss(condition.id),
            'aria-label': '关闭提醒',
          },
          '×',
        ),
      )
    }
    return createElement(
      'div',
      {
        key: condition.id,
        role: 'alert',
        'aria-live': 'assertive',
        className: [styles['banner'], styles[condition.tone]].filter(Boolean).join(' '),
      },
      ...nodes,
    )
  })
  return createElement('div', { className: styles['stack'] }, ...banners)
}
