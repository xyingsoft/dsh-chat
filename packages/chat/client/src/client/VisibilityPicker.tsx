/**
 * 在线可见性选择器（§9.1 的三档）。
 *
 * 放在抽屉头部而不是设置面板深处：这是一个**会被临时切换**的开关（要专心
 * 一会儿就隐身），埋进三层设置里的开关等于没有。
 *
 * ## 措辞要说清楚「别人会看到什么」
 *
 * 「隐藏」这个词容易被理解成「别人看到我离线」。实际是**别人看到「状态
 * 未知」** —— 系统不替用户撒谎，只是不说。所以每一档的说明都从对方视角写，
 * 而不是从设置项的名字写。
 *
 * ## 心跳照发
 *
 * §9.1：「隐藏时仍向 relay 发送必要心跳以维持投递和安全。」这一点要让用户
 * 知道，否则「隐身」会被误解成「断开连接」，而它不是 —— 消息照收。
 */

import { createElement, useCallback, useEffect, useState, type ReactElement } from 'react'

import styles from './VisibilityPicker.module.css'

export const VISIBILITY_OPTIONS = [
  {
    value: 'everyone',
    label: '所有人可见',
    hint: '组织内成员都能看到你在不在线',
  },
  {
    value: 'shared_scopes',
    label: '仅共同项目可见',
    hint: '只有和你在同一个工作区或项目里的人能看到',
  },
  {
    value: 'hidden',
    label: '隐藏',
    // 说「显示为离线」是错的，也是在替用户撒谎
    hint: '别人看到的是「状态未知」，不是离线。消息照常收发',
  },
] as const

export type Visibility = (typeof VISIBILITY_OPTIONS)[number]['value']

export interface VisibilityPickerProps {
  /** 读当前档位。默认打 host 的同源 API。 */
  readonly load?: () => Promise<Visibility>
  /** 写新档位。 */
  readonly save?: (visibility: Visibility) => Promise<void>
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

export function VisibilityPicker(props: VisibilityPickerProps): ReactElement {
  const [visibility, setVisibility] = useState<Visibility | undefined>(undefined)
  const [failed, setFailed] = useState(false)

  const load = props.load
  const save = props.save

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const current =
          load === undefined
            ? (await callHost<{ visibility: Visibility }>('/api/chat/presence/visibility', {}))
                .visibility
            : await load()
        if (!cancelled) setVisibility(current)
      } catch {
        // 读不到就不显示这个控件（下面 visibility === undefined 那一支）。
        // 显示一个猜出来的默认值更糟：用户会以为自己现在是「所有人可见」，
        // 而实际档位不明
        if (!cancelled) setFailed(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [load])

  const change = useCallback(
    async (next: Visibility) => {
      const previous = visibility
      // 先切界面：这个开关要立刻有反馈，慢网络下等一圈回来才变会让人以为没点上
      setVisibility(next)
      setFailed(false)
      try {
        if (save === undefined) {
          await callHost('/api/chat/presence/visibility/set', { visibility: next })
        } else {
          await save(next)
        }
      } catch {
        // 失败要**改回去**。留在新档位上是最坏的结果：用户以为自己隐身了，
        // 而服务端那边根本没改
        setVisibility(previous)
        setFailed(true)
      }
    },
    [visibility, save],
  )

  if (visibility === undefined) {
    return failed
      ? createElement('span', { className: styles['unavailable'] }, '在线状态设置不可用')
      : createElement('span', { className: styles['unavailable'] }, '…')
  }

  const current = VISIBILITY_OPTIONS.find((option) => option.value === visibility)

  return createElement(
    'label',
    { className: styles['root'] },
    createElement('span', { className: styles['srOnly'] }, '在线状态可见性'),
    createElement(
      'select',
      {
        className: styles['select'],
        value: visibility,
        // 用原生 select 而不是自绘下拉：键盘操作、屏幕阅读器、移动端弹层
        // 都是白送的（§49 要求所有交互可键盘完成）
        onChange: (event: { target: { value: string } }) =>
          void change(event.target.value as Visibility),
        title: current?.hint ?? '',
      },
      ...VISIBILITY_OPTIONS.map((option) =>
        createElement('option', { key: option.value, value: option.value }, option.label),
      ),
    ),
    failed
      ? createElement(
          'span',
          { className: styles['error'], role: 'alert' },
          '没改成，已恢复原设置',
        )
      : null,
  )
}
