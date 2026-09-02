/**
 * 生成式头像：取名字首字 + 名字 hash 派生色相。
 *
 * §P1 契约（ui-design.md §4.8）：头像为生成式；未提供真实头像前不画空圆。
 * 颜色由 `--dsh-chat-avatar-hue` 注入，组件本身不写死具体色值。
 */

import { createElement, type CSSProperties, type ReactElement } from 'react'

import styles from './Avatar.module.css'

export interface AvatarProps {
  /** 用于取首字与派生颜色。空串时渲染占位而不报错。 */
  readonly name: string
  readonly size?: 'sm' | 'md' | 'lg'
  /** 头像底色是否为当前会话的强调色（用于本端/群头像等）。 */
  readonly tone?: 'auto' | 'accent'
  readonly title?: string
}

const SIZE_CLASS = { sm: 'sizeSm', md: 'sizeMd', lg: 'sizeLg' } as const

function hashHue(name: string): number {
  let hash = 0
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0
  }
  return hash % 360
}

export function Avatar(props: AvatarProps): ReactElement {
  const { name, size = 'md', tone = 'auto', title } = props
  const trimmed = name.trim()
  const initial = trimmed.length > 0 ? [...trimmed][0]!.toLocaleUpperCase() : '?'
  const style = {
    '--dsh-chat-avatar-hue': String(hashHue(trimmed)),
  } as CSSProperties

  return createElement('span', {
    className: [
      styles['avatar'],
      styles[SIZE_CLASS[size] ?? 'sizeMd'],
      tone === 'accent' ? styles['avatarAccent'] : '',
    ]
      .filter(Boolean)
      .join(' '),
    style,
    role: 'img',
    'aria-label': title ?? (trimmed.length > 0 ? `${trimmed} 的头像` : undefined),
    'aria-hidden': title === undefined && trimmed.length === 0 ? true : undefined,
  }, initial)
}
