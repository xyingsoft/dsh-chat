/**
 * 相对时间文本。
 *
 * ui-design.md §4.8 契约：
 * `刚刚 / X 分钟前 / 今天 HH:MM / 昨天 / MM-DD / YYYY-MM-DD`。
 * 同一时区下用本地时间；跨时区由调用方另行标注时区标识（§48）。
 * 原始绝对时间放在 `title`，悬停可见。
 */

import { createElement, type ReactElement } from 'react'

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const time = new Date(iso)
  if (Number.isNaN(time.getTime())) return ''
  const diffMs = now.getTime() - time.getTime()
  const minutes = Math.floor(diffMs / 60_000)

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const day = new Date(time.getFullYear(), time.getMonth(), time.getDate())
  const dayDiff = Math.round((today.getTime() - day.getTime()) / 86_400_000)

  if (diffMs < 60_000 && minutes === 0) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  if (dayDiff === 0) return `今天 ${pad2(time.getHours())}:${pad2(time.getMinutes())}`
  if (dayDiff === 1) return '昨天'
  if (time.getFullYear() === now.getFullYear()) {
    return `${pad2(time.getMonth() + 1)}-${pad2(time.getDate())}`
  }
  return `${time.getFullYear()}-${pad2(time.getMonth() + 1)}-${pad2(time.getDate())}`
}

export function RelativeTime({ value }: { readonly value: string }): ReactElement | null {
  const text = formatRelativeTime(value)
  if (text === '') return null
  const absolute = new Date(value).toLocaleString()
  return createElement(
    'time',
    { dateTime: value, title: absolute, className: undefined },
    text,
  )
}
