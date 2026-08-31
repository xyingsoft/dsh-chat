/**
 * 开户面板。
 *
 * 配了 relay 但本机还没开户时显示这个，而不是一个空会话列表 —— 空列表长得
 * 像「你还没有会话」，而实际情况是「你还没有账号」，两者的下一步动作完全
 * 不同。
 *
 * ## 只收三个字段
 *
 * 邀请码、显示名称、设备名称。密钥对由 host 本地生成，**界面上没有任何
 * 与私钥有关的输入或展示** —— 让用户复制粘贴一段私钥是把它送进剪贴板、
 * 输入历史和截图里。
 *
 * ## 失败不解释原因
 *
 * relay 那边邀请码的三种失败（不存在、已消费、已过期）返回同一个错误码，
 * 就是为了不让人拿它枚举。界面上再补一句「可能是过期了」等于把服务端
 * 抹平的信息又猜回去 —— 而且猜错的时候更误导。
 */

import { createElement, useCallback, useState, type FormEvent, type ReactElement } from 'react'

import styles from './EnrollmentPanel.module.css'

export interface EnrollmentPanelProps {
  /** 开户成功后回调，带上 relay 签发的账号。 */
  readonly onEnrolled: (account: { accountId: string; deviceId: string }) => void
  /**
   * 提交实现。默认打 host 的同源 API；测试注入假的。
   *
   * §4：浏览器不直接与 relay 通信，所以这里是相对路径，没有可配置的
   * base URL —— 能配就意味着能被配到别处去。
   */
  readonly submit?: (input: EnrollmentInput) => Promise<{ accountId: string; deviceId: string }>
}

/** 表单的三个字段。密钥不在其中 —— 由 host 本地生成，界面碰不到。 */
export interface EnrollmentInput {
  readonly inviteCode: string
  readonly displayName: string
  readonly deviceName: string
}

/**
 * 猜一个设备名称当默认值。用户改得动，但多数人不会改，所以要像样。
 *
 * 导出是为了能单独测：这个仓库的客户端测试跑静态渲染，摸不到浏览器
 * 环境，所以能抽成纯函数的判定都抽出来单独验。
 */
export function guessDeviceName(platform?: string): string {
  const value = platform ?? (typeof navigator === 'undefined' ? '' : navigator.platform)
  if (value.startsWith('Win')) return 'Windows 桌面端'
  if (value.startsWith('Mac')) return 'Mac 桌面端'
  if (value.startsWith('Linux')) return 'Linux 桌面端'
  return '这台设备'
}

/** 去掉首尾空格。用户从聊天软件里复制邀请码常常会带上一个。 */
export function normalizeEnrollment(input: EnrollmentInput): EnrollmentInput {
  return {
    inviteCode: input.inviteCode.trim(),
    displayName: input.displayName.trim(),
    deviceName: input.deviceName.trim(),
  }
}

/** 三个字段都非空（去空格后）才允许提交。 */
export function isSubmittable(input: EnrollmentInput): boolean {
  const normalized = normalizeEnrollment(input)
  return (
    normalized.inviteCode !== '' && normalized.displayName !== '' && normalized.deviceName !== ''
  )
}

async function defaultSubmit(
  input: EnrollmentInput,
): Promise<{ accountId: string; deviceId: string }> {
  const response = await fetch('/api/chat/identity/enroll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  const payload = (await response.json()) as {
    data?: { accountId: string; deviceId: string }
    error?: { code?: string }
  }
  if (!response.ok || payload.data === undefined) {
    throw new Error(payload.error?.code ?? 'INTERNAL')
  }
  return payload.data
}

type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'submitting' }
  | { readonly kind: 'rejected' }

export function EnrollmentPanel(props: EnrollmentPanelProps): ReactElement {
  const [inviteCode, setInviteCode] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [deviceName, setDeviceName] = useState(() => guessDeviceName())
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })

  const submit = props.submit ?? defaultSubmit
  const { onEnrolled } = props
  const values: EnrollmentInput = { inviteCode, displayName, deviceName }
  const complete = isSubmittable(values)

  const onSubmit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault()
      // 提交中再点一次会开出两个户，而邀请码只能用一次 —— 第二次必然失败，
      // 用户看到的是一个成功了又报错的界面
      if (!complete || phase.kind === 'submitting') return
      setPhase({ kind: 'submitting' })
      try {
        onEnrolled(await submit(normalizeEnrollment(values)))
      } catch {
        // 不看错误码：服务端把三种失败抹平成一个了，这里也就只有一句话可说
        setPhase({ kind: 'rejected' })
      }
    },
    [complete, phase.kind, submit, onEnrolled, inviteCode, displayName, deviceName],
  )

  const field = (
    label: string,
    value: string,
    onChange: (next: string) => void,
    options: { placeholder?: string; autoFocus?: boolean } = {},
  ): ReactElement =>
    createElement(
      'label',
      { className: styles['field'], key: label },
      createElement('span', { className: styles['label'] }, label),
      createElement('input', {
        className: styles['input'],
        type: 'text',
        value,
        // 输入即清掉上一次的失败提示。留着的话，用户改完码还看着「无法使用」，
        // 分不清是旧提示还是又失败了一次
        onChange: (event: { target: { value: string } }) => {
          onChange(event.target.value)
          if (phase.kind === 'rejected') setPhase({ kind: 'idle' })
        },
        disabled: phase.kind === 'submitting',
        ...(options.placeholder === undefined ? {} : { placeholder: options.placeholder }),
        ...(options.autoFocus === true ? { autoFocus: true } : {}),
      }),
    )

  return createElement(
    'form',
    { className: styles['root'], onSubmit: (e: FormEvent) => void onSubmit(e) },
    createElement('h3', { className: styles['title'] }, '开通账号'),
    createElement(
      'p',
      { className: styles['hint'] },
      '需要一张邀请码。密钥在这台设备上生成，私钥不会离开本机。',
    ),
    field('邀请码', inviteCode, setInviteCode, { autoFocus: true }),
    field('你的名字', displayName, setDisplayName, { placeholder: '同事看到的名字' }),
    field('这台设备的名称', deviceName, setDeviceName),
    phase.kind === 'rejected'
      ? createElement(
          'p',
          { className: styles['error'], role: 'alert' },
          '这张邀请码无法使用。请向管理员确认。',
        )
      : null,
    createElement(
      'button',
      {
        type: 'submit',
        className: styles['submit'],
        disabled: !complete || phase.kind === 'submitting',
      },
      phase.kind === 'submitting' ? '正在开通…' : '开通',
    ),
  )
}
