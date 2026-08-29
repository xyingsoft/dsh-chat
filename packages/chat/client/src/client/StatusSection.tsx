/**
 * dsh-chat 的设置面板分区。
 *
 * §5 规定客户端**只负责呈现**：不持组织秘密、不做权威缓存、不在浏览器中重算权限。
 * 因此本组件不发起任何鉴权判断，展示的内容全部来自 host 返回的数据。
 *
 * 当前阶段的实现范围有限，所以这个面板做的是一件诚实的事：**说明哪些能力已就绪、
 * 哪些尚未装载**。§6 要求「可选能力必须显式显示为未安装或 `NOT_IMPLEMENTED`，
 * 不得伪装为可用」—— 一个假装能用的聊天界面比没有界面更糟。
 */

import { createElement, type ReactElement } from 'react'

import styles from './StatusSection.module.css'

/** 一项能力的就绪状态。取值与 TODO.md 中的阶段状态一致。 */
export type CapabilityStatus = 'ready' | 'partial' | 'not_implemented'

export interface CapabilityRow {
  readonly name: string
  readonly status: CapabilityStatus
  readonly note: string
}

export interface StatusSectionProps {
  /** 由 host 注入；客户端不自行推断。 */
  readonly capabilities: readonly CapabilityRow[]
  readonly protocolVersion: string
  readonly schemaVersion: number
}

const STATUS_LABEL: Readonly<Record<CapabilityStatus, string>> = {
  ready: '已就绪',
  partial: '部分实现',
  not_implemented: '未装载',
}

/**
 * 渲染状态面板。
 *
 * 用 `createElement` 而不是 JSX 语法：本包的构建链尚未接入 tsx 转换，
 * 而这个组件足够简单，不值得为它引入额外的构建步骤。
 */
export function StatusSection(props: StatusSectionProps): ReactElement {
  return createElement(
    'div',
    { className: styles['root'] },
    createElement(
      'p',
      { className: styles['summary'] },
      `协议版本 ${props.protocolVersion} · 数据库 schema v${props.schemaVersion}`,
    ),
    createElement(
      'ul',
      { className: styles['list'] },
      ...props.capabilities.map((row) =>
        createElement(
          'li',
          { key: row.name, className: styles['item'] },
          createElement('span', { className: styles['name'] }, row.name),
          createElement(
            'span',
            {
              className: styles['status'],
              // 颜色不作为唯一状态信号（§49 无障碍要求），因此同时给出文字
              'data-status': row.status,
            },
            STATUS_LABEL[row.status],
          ),
          createElement('span', { className: styles['note'] }, row.note),
        ),
      ),
    ),
  )
}
