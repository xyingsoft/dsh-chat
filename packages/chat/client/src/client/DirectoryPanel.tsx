/**
 * 通讯录：找人、加联系人、发起聊天。
 *
 * 在这个面板存在之前，界面上**没有任何办法开始一段新对话** —— 会话列表
 * 只显示已有的会话，而已有会话只能由别人先发消息产生，而别人发消息同样
 * 需要联系人关系。整个产品是锁死的。
 *
 * ## 一个人只有三种状态，对应三个不同的按钮
 *
 * - 已是联系人 → 「发消息」
 * - 对方请求我 → 「接受」
 * - 其余 → 「加联系人」（已发出的显示为禁用的「等待通过」）
 *
 * 状态由服务端一次算好（`relation` 字段）。让界面自己拼两份列表的话，
 * 拼错的表现是「已经是联系人的人还显示加好友按钮」，点下去报一个
 * `NOT_FOUND_OR_FORBIDDEN` —— 用户完全看不出发生了什么。
 */

import { createElement, useCallback, useEffect, useState, type ReactElement } from 'react'

import styles from './DirectoryPanel.module.css'

export interface DirectoryEntry {
  readonly accountId: string
  readonly displayName: string
  readonly relation: 'self' | 'contact' | 'pending_outgoing' | 'pending_incoming' | 'none'
}

export interface IncomingRequest {
  readonly requestId: string
  readonly accountId: string
  readonly displayName: string
}

export interface DirectoryPanelProps {
  /** 选中一个已是联系人的人，去和他聊天。 */
  readonly onOpenConversation: (accountId: string) => void
  /** 注入数据源，测试用。默认打 host 的同源 API。 */
  readonly load?: () => Promise<{ members: DirectoryEntry[]; incoming: IncomingRequest[] }>
  readonly act?: (action: 'request' | 'accept', payload: Record<string, string>) => Promise<void>
}

async function callHost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = (await response.json()) as { data?: T; error?: { code?: string } }
  if (!response.ok || payload.data === undefined) {
    throw new Error(payload.error?.code ?? 'INTERNAL')
  }
  return payload.data
}

async function defaultLoad(): Promise<{ members: DirectoryEntry[]; incoming: IncomingRequest[] }> {
  // 两个请求并发。串行的话，一个慢一点的组织通讯录会把待处理请求也拖住，
  // 而后者恰恰是最需要马上看到的
  const [directory, contacts] = await Promise.all([
    callHost<{ members: DirectoryEntry[] }>('/api/organization/directory', {}),
    callHost<{ incoming: IncomingRequest[] }>('/api/chat/contacts', {}),
  ])
  return { members: directory.members, incoming: contacts.incoming }
}

type State =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly members: DirectoryEntry[]; readonly incoming: IncomingRequest[] }
  | { readonly kind: 'failed' }

export function DirectoryPanel(props: DirectoryPanelProps): ReactElement {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | undefined>(undefined)

  const load = props.load ?? defaultLoad
  const act = props.act

  const refresh = useCallback(async () => {
    try {
      const data = await load()
      setState({ kind: 'ready', members: data.members, incoming: data.incoming })
    } catch {
      setState({ kind: 'failed' })
    }
  }, [load])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const run = useCallback(
    async (key: string, action: 'request' | 'accept', payload: Record<string, string>) => {
      // 同一个人连点两下会发两条请求。第二条要么被去重、要么报错，
      // 两种都是用户不该看到的噪音
      if (busy !== undefined) return
      setBusy(key)
      try {
        if (act === undefined) {
          await callHost(
            action === 'request' ? '/api/chat/contacts/request' : '/api/chat/contacts/accept',
            payload,
          )
        } else {
          await act(action, payload)
        }
        // 重新拉一次而不是本地改状态：服务端可能把「我请求」变成了「直接
        // 互相接受」（对方先发过请求），本地猜不出来
        await refresh()
      } catch {
        setState({ kind: 'failed' })
      } finally {
        setBusy(undefined)
      }
    },
    [busy, act, refresh],
  )

  if (state.kind === 'loading') {
    return createElement(
      'p',
      { className: styles['status'] },
      '正在加载通讯录…',
    )
  }
  if (state.kind === 'failed') {
    return createElement(
      'div',
      { className: styles['status'], role: 'alert' },
      createElement('p', { className: styles['statusText'] }, '通讯录暂时打不开'),
      createElement(
        'button',
        { type: 'button', className: styles['retry'], onClick: () => void refresh() },
        '重试',
      ),
    )
  }

  const keyword = query.trim().toLowerCase()
  const visible = state.members.filter(
    (member) =>
      member.relation !== 'self' &&
      (keyword === '' || member.displayName.toLowerCase().includes(keyword)),
  )

  return createElement(
    'div',
    { className: styles['root'] },

    // 待处理请求排在最前。埋在通讯录里的话，一条加好友请求可能几天都没人看见
    state.incoming.length > 0
      ? createElement(
          'section',
          { className: styles['section'] },
          createElement(
            'h4',
            { className: styles['sectionTitle'] },
            `待处理请求（${state.incoming.length}）`,
          ),
          ...state.incoming.map((request) =>
            createElement(
              'div',
              { key: request.requestId, className: styles['row'] },
              createElement('span', { className: styles['name'] }, request.displayName),
              createElement(
                'button',
                {
                  type: 'button',
                  className: styles['primary'],
                  disabled: busy !== undefined,
                  onClick: () =>
                    void run(request.requestId, 'accept', { requestId: request.requestId }),
                },
                '接受',
              ),
            ),
          ),
        )
      : null,

    createElement('input', {
      className: styles['search'],
      type: 'search',
      value: query,
      placeholder: '搜同事的名字',
      'aria-label': '搜索同事',
      onChange: (event: { target: { value: string } }) => setQuery(event.target.value),
    }),

    visible.length === 0
      ? createElement(
          'p',
          { className: styles['empty'] },
          // 区分「搜不到」与「组织里就你一个」—— 两者用户该做的事完全不同
          keyword === '' ? '这个组织里还没有别人。先去邀请同事。' : '没有匹配的同事',
        )
      : createElement(
          'div',
          { className: styles['list'] },
          ...visible.map((member) =>
            createElement(
              'div',
              { key: member.accountId, className: styles['row'] },
              createElement('span', { className: styles['name'] }, member.displayName),
              actionFor(member, busy, props.onOpenConversation, run),
            ),
          ),
        ),
  )
}

function actionFor(
  member: DirectoryEntry,
  busy: string | undefined,
  openConversation: (accountId: string) => void,
  run: (key: string, action: 'request' | 'accept', payload: Record<string, string>) => Promise<void>,
): ReactElement {
  if (member.relation === 'contact') {
    return createElement(
      'button',
      {
        type: 'button',
        className: styles['primary'],
        onClick: () => openConversation(member.accountId),
      },
      '发消息',
    )
  }
  if (member.relation === 'pending_outgoing') {
    // 禁用而不是隐藏：隐藏的话用户不知道自己已经发过了，会去别处找入口
    return createElement(
      'button',
      { type: 'button', className: styles['muted'], disabled: true },
      '等待通过',
    )
  }
  if (member.relation === 'pending_incoming') {
    return createElement(
      'span',
      { className: styles['hint'] },
      '在上方待处理',
    )
  }
  return createElement(
    'button',
    {
      type: 'button',
      className: styles['secondary'],
      disabled: busy !== undefined,
      onClick: () => void run(member.accountId, 'request', { targetId: member.accountId }),
    },
    '加联系人',
  )
}
