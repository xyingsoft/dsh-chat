/**
 * 本地搜索输入框（ui-design.md §3.4 的 UI 壳）。
 *
 * 注意：与通讯录搜索是两个独立搜索（组件不同实例，不共用输入框）。
 * 过滤逻辑由宿主组件决定（默认按会话标题/预览过滤，撤回消息不出现在结果）。
 * 本组件只负责输入、清空与无障碍标注。
 */

import { createElement, type ReactElement } from 'react'

import styles from './LocalSearch.module.css'

export interface LocalSearchProps {
  readonly value: string
  readonly onValueChange: (next: string) => void
  readonly placeholder?: string
  /** 结果区 role="listbox" 语义时的描述。 */
  readonly describedBy?: string
}

export function LocalSearch(props: LocalSearchProps): ReactElement {
  const { value, onValueChange, placeholder = '搜索消息与联系人', describedBy } = props
  return createElement(
    'div',
    { className: styles['search'] },
    createElement(
      'span',
      { className: styles['magnifier'], 'aria-hidden': true },
      '⌕',
    ),
    createElement('input', {
      type: 'search',
      className: styles['input'],
      value,
      onChange: (event: { currentTarget: { value: string } }) => onValueChange(event.currentTarget.value),
      placeholder,
      'aria-label': '搜索本地消息与联系人',
      'aria-describedby': describedBy,
      enterKeyHint: 'search',
    }),
    value.length > 0
      ? createElement(
          'button',
          {
            type: 'button',
            className: styles['clear'],
            onClick: () => onValueChange(''),
            'aria-label': '清空搜索',
          },
          '×',
        )
      : null,
  )
}
