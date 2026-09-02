/**
 * 骨架占位：loading 态按目标布局占形，不显示假数据（ui-design.md §6.4）。
 */

import { createElement, type ReactElement } from 'react'

import styles from './Skeleton.module.css'

export type SkeletonShape = 'line' | 'circle' | 'rect'

export interface SkeletonProps {
  readonly shape?: SkeletonShape
  readonly width?: string | number
  readonly height?: string | number
  readonly className?: string
  readonly 'aria-label'?: string
}

export function Skeleton(props: SkeletonProps): ReactElement {
  const { shape = 'line', width, height, className } = props
  return createElement('span', {
    className: [
      styles['skeleton'],
      styles[shape === 'line' ? 'line' : shape === 'circle' ? 'circle' : 'rect'],
      className,
    ]
      .filter(Boolean)
      .join(' '),
    style: {
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
    },
    'aria-hidden': true,
  })
}

/** 会话列表行骨架：头像圆 + 两行文字。 */
export function ConversationRowSkeleton(): ReactElement {
  return createElement(
    'div',
    { className: styles['row'] },
    createElement(Skeleton, { shape: 'circle', width: 28, height: 28 }),
    createElement(
      'div',
      { className: styles['rowText'] },
      createElement(Skeleton, { width: '45%', height: 12 }),
      createElement(Skeleton, { width: '75%', height: 10 }),
    ),
  )
}
