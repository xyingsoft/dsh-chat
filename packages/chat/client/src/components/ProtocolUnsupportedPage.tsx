/**
 * 协议协商失败态页（ui-design.md §3.5）。
 *
 * 触发：host 返回 PROTOCOL_VERSION_UNSUPPORTED。
 * 此态下抽屉除升级入口外全部禁用 —— 调用方负责在检测到该状态时
 * 用本页整体替换抽屉内容（不渲染列表/输入框）。
 */

import { createElement, type ReactElement } from 'react'

import styles from './ProtocolUnsupportedPage.module.css'

export interface ProtocolUnsupportedPageProps {
  /** 组织要求的最低版本。 */
  readonly minRequired?: string
  /** 当前安装版本。 */
  readonly current?: string
  readonly onUpgradeGuide?: () => void
  readonly onLater?: () => void
}

export function ProtocolUnsupportedPage(props: ProtocolUnsupportedPageProps): ReactElement {
  const { minRequired, current, onUpgradeGuide, onLater } = props
  return createElement(
    'div',
    { className: styles['page'], role: 'alert' },
    createElement(
      'div',
      { className: styles['card'] },
      createElement('div', { className: styles['badge'], 'aria-hidden': true }, '!'),
      createElement('h2', { className: styles['title'] }, '版本不兼容'),
      createElement(
        'p',
        { className: styles['lead'] },
        '你的客户端版本不被当前组织接受，部分功能将无法使用。',
      ),
      createElement(
        'dl',
        { className: styles['versions'] },
        minRequired !== undefined
          ? [
              createElement('dt', { key: 'dt1' }, '需要的最低版本'),
              createElement('dd', { key: 'dd1' }, minRequired),
            ]
          : null,
        current !== undefined
          ? [
              createElement('dt', { key: 'dt2' }, '当前安装版本'),
              createElement('dd', { key: 'dd2' }, current),
            ]
          : null,
      ),
      createElement(
        'div',
        { className: styles['actions'] },
        onUpgradeGuide !== undefined
          ? createElement(
              'button',
              { type: 'button', className: styles['primary'], onClick: onUpgradeGuide },
              '如何升级',
            )
          : null,
        onLater !== undefined
          ? createElement(
              'button',
              { type: 'button', className: styles['ghost'], onClick: onLater },
              '稍后再说',
            )
          : null,
      ),
    ),
  )
}
