/**
 * 设置 → dsh-chat 的「基础信息与账户」块。
 *
 * 只呈现 host 真实返回的数据（U7 / §5：客户端不做权威缓存、不重算状态）：
 * - 身份模式：本地单机（local）/ 已接入团队（enrolled）/ 未开户（unenrolled）
 * - 已开户时显示 accountId 与 deviceId（短形式 + 可复制）
 * - 协议与 schema 版本（来自 host 注入 props）
 * - enrolled 时提供「退出登录」（二次确认后调 host，成功后刷新页面）
 *
 * 不伪装能力：显示名/第二因素等无端点能力的区域一律不出现。
 */

import {
  createElement,
  useCallback,
  useEffect,
  useState,
  type ReactElement,
} from 'react'

import { Dialog } from '../components/Dialog.js'
import { notify } from '../components/Toast.js'

import styles from './BasicSettings.module.css'

export interface BasicSettingsProps {
  readonly protocolVersion: number
  readonly schemaVersion: number
}

type IdentityStatus =
  | { readonly mode: 'local' }
  | { readonly mode: 'enrolled'; readonly accountId: string; readonly deviceId: string }
  | { readonly mode: 'unenrolled' }

async function fetchStatus(): Promise<IdentityStatus> {
  const response = await fetch('/api/chat/identity/status', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
  const payload = (await response.json()) as { data?: IdentityStatus }
  if (!response.ok || payload.data === undefined) throw new Error('身份状态不可用')
  return payload.data
}

const MODE_LABEL: Readonly<Record<IdentityStatus['mode'], string>> = {
  local: '本地单机',
  enrolled: '已接入团队',
  unenrolled: '尚未开户',
}

function shortId(id: string | undefined, width = 12): string | undefined {
  if (id === undefined) return undefined
  if (id.length <= width + 2) return id
  return `${id.slice(0, Math.ceil(width / 2))}…${id.slice(-Math.floor(width / 2))}`
}

async function copyText(text: string): Promise<void> {
  if (globalThis.navigator?.clipboard?.writeText !== undefined) {
    try {
      await globalThis.navigator.clipboard.writeText(text)
      notify({ id: 'copy-id', variant: 'success', message: '已复制到剪贴板' })
      return
    } catch {
      // 落回 execCommand
    }
  }
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
    notify({ id: 'copy-id', variant: 'success', message: '已复制到剪贴板' })
  } catch {
    // 剪贴板不可写时静默
  }
}

export function BasicSettings(props: BasicSettingsProps): ReactElement {
  const [status, setStatus] = useState<IdentityStatus | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const [confirmSignOut, setConfirmSignOut] = useState(false)
  const [signingOut, setSigningOut] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const next = await fetchStatus()
      setStatus(next)
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const doSignOut = useCallback(async () => {
    setSigningOut(true)
    try {
      const response = await fetch('/api/chat/identity/sign-out', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      if (!response.ok) throw new Error('sign-out failed')
      setConfirmSignOut(false)
      notify({ id: 'signed-out', variant: 'success', message: '已退出登录' })
      // 重新载入渲染器，让会话区回到开户引导
      globalThis.location?.reload()
    } catch {
      setConfirmSignOut(false)
      notify({ id: 'signout-failed', variant: 'error', message: '退出登录失败，请稍后重试' })
    } finally {
      setSigningOut(false)
    }
  }, [])

  const statusRow =
    failed || status === undefined ? (
      failed ? (
        createElement(
          'span',
          { className: styles['hintText'] },
          '身份状态暂时不可用（可能是服务未就绪）',
        )
      ) : (
        createElement('span', { className: styles['hintText'] }, '正在读取身份状态…')
      )
    ) : (
      createElement(
        'div',
        { className: styles['identityRows'] },
        createElement(
          'div',
          { className: styles['row'] },
          createElement('span', { className: styles['rowLabel'] }, '身份模式'),
          createElement(
            'span',
            { className: styles['modeBadge'] },
            MODE_LABEL[status.mode],
          ),
        ),
        status.mode === 'enrolled' && status.accountId !== undefined
          ? createElement(
              'div',
              { className: styles['row'] },
              createElement('span', { className: styles['rowLabel'] }, '账号 ID'),
              createElement(
                'span',
                { className: styles['monoValue'] },
                shortId(status.accountId),
              ),
              createElement(
                'button',
                {
                  type: 'button',
                  className: styles['copyBtn'],
                  onClick: () => void copyText(status.accountId),
                },
                '复制',
              ),
            )
          : null,
        status.mode === 'enrolled' && status.deviceId !== undefined
          ? createElement(
              'div',
              { className: styles['row'] },
              createElement('span', { className: styles['rowLabel'] }, '当前设备'),
              createElement(
                'span',
                { className: styles['monoValue'] },
                shortId(status.deviceId),
              ),
            )
          : null,
        status.mode === 'local'
          ? createElement(
              'p',
              { className: styles['hintText'] },
              '本地单机模式：聊天数据只保存在这台设备。接入团队后才会获得账号 ID 与设备身份。',
            )
          : null,
        status.mode === 'unenrolled'
          ? createElement(
              'p',
              { className: styles['hintText'] },
              '尚未开户：在下方聊天区输入邀请码完成开户后，这里会显示你的账号与设备。',
            )
          : null,
      )
    )

  const signOutDialog =
    status?.mode !== 'enrolled' || !confirmSignOut
      ? null
      : createElement(Dialog, {
          open: true,
          title: '退出登录？',
          role: 'alertdialog',
          size: 'sm',
          onClose: () => setConfirmSignOut(false),
          closeOnOverlayClick: false,
          children: [
            createElement(
              'p',
              { key: 'body', className: styles['dialogBody'] },
              '退出后本设备将回到开户状态；本地已收发的消息仍保留在设备上。',
            ),
            createElement(
              'div',
              { key: 'actions', className: styles['dialogActions'] },
              createElement(
                'button',
                {
                  type: 'button',
                  className: styles['dialogCancel'],
                  onClick: () => setConfirmSignOut(false),
                },
                '取消',
              ),
              createElement(
                'button',
                {
                  type: 'button',
                  className: styles['dialogDanger'],
                  disabled: signingOut,
                  onClick: () => void doSignOut(),
                },
                signingOut ? '退出中…' : '退出登录',
              ),
            ),
          ],
        })

  return createElement(
    'section',
    { className: styles['root'] },
    createElement(
      'div',
      { className: styles['header'] },
      createElement('h3', { className: styles['title'] }, '基础信息与账户'),
      createElement(
        'div',
        { className: styles['chips'] },
        createElement('span', { className: styles['chip'] }, `协议 v${props.protocolVersion}`),
        createElement('span', { className: styles['chip'] }, `数据库 schema v${props.schemaVersion}`),
      ),
    ),
    statusRow,
    status?.mode === 'enrolled'
      ? createElement(
          'button',
          {
            type: 'button',
            className: styles['signOut'],
            onClick: () => setConfirmSignOut(true),
          },
          '退出登录',
        )
      : null,
    signOutDialog,
  )
}
